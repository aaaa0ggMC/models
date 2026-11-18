/**
 * gateway-core/pipeline/stages/s6-provider-decode.ts —— S6 ProviderDecode。
 *
 * 职责（20 §S6）：provider codec 解码；fast path 时只抽取 usage 信封。
 *
 * ⚠️ D-fastpath-1（仓库主人拍板）：
 *   - fast path 下响应侧**只抽取 usage 信封并直通原始字节**，不做结构转换；
 *   - 非 fast path 时本阶段触发完整 canonical 物化（响应侧对应点）。
 *
 * 各 provider 原生流事件如何折叠进 7 种 CanonicalStreamEvent，是 codec 的核心工作
 * （20 §S6 的折叠表）。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type {
  CanonicalError,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  CanonicalUsage,
  FinishReason,
  StreamPart,
} from '../../../ir/index.js';
import { asChatResponsePayload, createCanonicalError, emptyUsage } from '../../../ir/index.js';
import { IncrementalUsageSniffer, type UsageSnifferOptions } from '../usage-sniffer.js';

export class S6ProviderDecode implements Stage {
  readonly id = 'S6';
  readonly name = 'ProviderDecode';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const upstream = state.upstream;
    const providerAdaptor = state.providerAdaptor;
    if (upstream === undefined || providerAdaptor === undefined) {
      throw new Error('S6 需要 S5 的上游响应与 S4 的 provider adaptor');
    }

    const streaming = state.shallow?.stream === true;

    if (streaming) {
      if (ctx.fast_path) {
        // fast path：**不读流**。只创建嗅探器交给 S8——S8 一边把字节写给客户端，
        // 一边喂给嗅探器，两者互不等待，保持"零延迟透传"（20 §4.2、设计原则 3）。
        state.sniffer = new IncrementalUsageSniffer(snifferOptionsFor(ctx.provider_format, deps));
        ctx.recordStage(this.id, deps.clock.now() - started, 'fast_path:sniffer-armed');
        deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'fast_path' });
        return;
      }

      // 若上游（或测试桩 ScriptedTransport）在 stream:true 下返回了完整 body 而非 chunks
      if (upstream.chunks === undefined && upstream.body !== undefined) {
        const bodyText = upstream.body.toString('utf8');
        const trimmed = bodyText.trim();
        if (trimmed.startsWith('{')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch (err) {
            throw createCanonicalError(
              'canonical_decode_error',
              `上游响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
              ctx.request_id,
            );
          }
          const response = providerAdaptor.decodeResponse(parsed, ctx);
          state.response = response;
          state.usage = response.usage;
          state.finish_reason = response.finish_reason as State['finish_reason'];
          for (const w of response.warnings) ctx.warn(w);
          const events = synthesizeStreamEventsFromResponse(response);
          state.stream_events = events;
          state.canonical_stream = iterateEvents(events);
          ctx.recordStage(
            this.id,
            deps.clock.now() - started,
            `slow:json-fallback(events=${events.length})`,
          );
          deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'slow' });
          return;
        }
        const events = await collectEvents(providerAdaptor, bodyText, ctx);
        state.stream_events = events;
        state.canonical_stream = iterateEvents(events);
        const lastUsage = [...events].reverse().find((e) => e.type === 'usage');
        const finish = [...events].reverse().find((e) => e.type === 'finish');
        if (lastUsage !== undefined && lastUsage.type === 'usage') state.usage = lastUsage.usage;
        if (finish !== undefined && finish.type === 'finish') {
          state.finish_reason = finish.finish_reason;
        }
        ctx.recordStage(this.id, deps.clock.now() - started, `slow:events=${events.length}`);
        deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'slow' });
        return;
      }

      // 慢路径实时流式：不在此阶段阻塞等待整条流结束，而是挂载增量 SSE 解码生成器，
      // 由 S7 逐帧跑插件、S8 逐帧编码并立即 flush 到客户端，彻底消除缓冲导致的首字延迟与假高 TPS。
      const rawChunks: string[] = [];
      state.upstream_chunks = rawChunks;
      const recordedEvents: CanonicalStreamEvent[] = [];
      state.stream_events = recordedEvents;

      const sseBlocks = readSseBlocksIncremental(
        upstream.chunks,
        () => deps.sink.closed,
        rawChunks,
      );

      async function* decodeLive(): AsyncGenerator<CanonicalStreamEvent> {
        for await (const frame of providerAdaptor!.decodeStream(sseBlocks, ctx)) {
          const ev = frameToEvent(frame);
          recordedEvents.push(ev);
          if (ev.type === 'usage') {
            state.usage = ev.usage;
          } else if (ev.type === 'finish') {
            state.finish_reason = ev.finish_reason;
            if (ev.usage !== undefined && Object.keys(ev.usage.units).length > 0) {
              state.usage = ev.usage;
            }
          }
          yield ev;
        }
      }

      state.canonical_stream = decodeLive();
      ctx.recordStage(this.id, deps.clock.now() - started, 'slow:stream-armed');
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'slow' });
      return;
    }

    // 非流式
    const bodyText = upstream.body?.toString('utf8') ?? '';
    if (ctx.fast_path) {
      // fast path 非流式：只抽 usage（finish_reason 归一见 §4.3）
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = undefined;
      }
      state.usage = providerAdaptor.extractUsage(parsed);
      if (state.usage.units.tokens === undefined) ctx.warn('usage_missing');
      ctx.recordStage(this.id, deps.clock.now() - started, 'fast_path:usage-only');
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'fast_path' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw createCanonicalError(
        'canonical_decode_error',
        `上游响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
        ctx.request_id,
      );
    }
    const response = providerAdaptor.decodeResponse(parsed, ctx);
    state.response = response;
    state.usage = response.usage;
    state.finish_reason = response.finish_reason as State['finish_reason'];
    for (const w of response.warnings) ctx.warn(w);
    ctx.recordStage(this.id, deps.clock.now() - started, 'slow:decodeResponse');
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'slow' });
  }
}

type State = PipelineState;

function snifferOptionsFor(providerFormat: string, deps: PipelineDeps): UsageSnifferOptions {
  const flavor: UsageSnifferOptions['flavor'] =
    providerFormat === 'openai.chat'
      ? 'openai_chat'
      : providerFormat === 'openai.responses'
        ? 'openai_responses'
        : providerFormat === 'anthropic.messages'
          ? 'anthropic'
          : providerFormat === 'gemini.generateContent'
            ? 'gemini'
            : 'generic';
  return { max_bytes: deps.config.usageSnifferMaxBytes, flavor };
}

/** 增量从上游字节流切出 SSE 事件块（兼容 LF 与 CRLF，收到完整事件立即 yield）。 */
async function* readSseBlocksIncremental(
  chunks: AsyncIterable<Buffer> | undefined,
  isClosed: () => boolean,
  rawChunks: string[],
): AsyncGenerator<string> {
  if (chunks === undefined) return;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of chunks) {
    if (isClosed()) break;
    const decoded = decoder.decode(chunk, { stream: true });
    rawChunks.push(decoded);
    buffer += decoded.replace(/\r\n/g, '\n');
    for (;;) {
      const boundaryIdx = buffer.indexOf('\n\n');
      if (boundaryIdx === -1) break;
      const block = buffer.slice(0, boundaryIdx);
      buffer = buffer.slice(boundaryIdx + 2);
      if (block.trim() !== '') {
        yield block;
      }
    }
  }
  const tail = decoder.decode();
  if (tail !== '') {
    rawChunks.push(tail);
    buffer += tail.replace(/\r\n/g, '\n');
  }
  for (const block of buffer.split(/\n\n/)) {
    if (block.trim() !== '') {
      yield block;
    }
  }
}

async function* iterateEvents(
  events: readonly CanonicalStreamEvent[],
): AsyncGenerator<CanonicalStreamEvent> {
  for (const ev of events) {
    yield ev;
  }
}

/** 将非流式 CanonicalResponseEnvelope 合成为 CanonicalStreamEvent 序列（供流式下 JSON 响应降级与测试桩复用）。 */
export function synthesizeStreamEventsFromResponse(
  response: CanonicalResponseEnvelope,
): CanonicalStreamEvent[] {
  const payload = asChatResponsePayload(response);
  const model = payload?.model ?? '';
  const events: CanonicalStreamEvent[] = [
    { type: 'start', message: { id: response.request_id, model, role: 'assistant' } },
  ];
  const parts = payload?.message.parts ?? [];
  parts.forEach((part, index) => {
    if (part.type === 'thinking') {
      if (part.thinking !== '') {
        events.push({ type: 'part.delta', index, delta: { type: 'thinking', thinking: part.thinking } });
      }
    } else if (part.type === 'text') {
      if (part.text !== '') {
        events.push({ type: 'part.delta', index, delta: { type: 'text', text: part.text } });
      }
    } else if (part.type === 'refusal') {
      if (part.reason !== '') {
        events.push({ type: 'part.delta', index, delta: { type: 'refusal', refusal: part.reason } });
      }
    } else if (part.type === 'tool_use') {
      const rawArgs = part.raw_arguments ?? JSON.stringify(part.input ?? {});
      events.push({
        type: 'part.begin',
        index,
        part: { type: 'tool_use', id: part.id, name: part.name, input: {} },
      });
      if (rawArgs !== '') {
        events.push({
          type: 'part.delta',
          index,
          delta: { type: 'tool_input_json', partial_json: rawArgs },
        });
      }
      events.push({
        type: 'part.end',
        index,
        part: {
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: part.input,
          raw_arguments: rawArgs,
        },
      });
    }
  });
  if (Object.keys(response.usage.units).length > 0) {
    events.push({ type: 'usage', usage: response.usage });
  }
  events.push({
    type: 'finish',
    finish_reason: (response.finish_reason as FinishReason) ?? 'stop',
    usage: response.usage,
  });
  return events;
}

/** 用 codec 的 decodeStream 把 SSE 文本折叠成 CanonicalStreamEvent。 */
async function collectEvents(
  adaptor: NonNullable<State['providerAdaptor']>,
  sseText: string,
  ctx: State['ctx'],
): Promise<CanonicalStreamEvent[]> {
  const frames: unknown[] = [];
  async function* upstream() {
    // 按 SSE 事件边界切（兼容 \r\n\r\n 与 \n\n），让 codec 看到"一个事件一个元素"
    for (const block of sseText.replace(/\r\n/g, '\n').split(/\n\n/)) {
      if (block.trim() === '') continue;
      yield block;
    }
  }
  for await (const frame of adaptor.decodeStream(upstream(), ctx)) {
    frames.push(frame);
  }
  // decodeStream 产的是 StreamFrame；这里转成 CanonicalStreamEvent 供 S7 消费
  return frames.map(frameToEvent);
}

/**
 * 把 codec 产出的 `StreamFrame` 折叠成 `CanonicalStreamEvent`（20 §S6 的折叠表）。
 *
 * `event: "delta"` 一律映射到 `part.delta`；part 边界（`meta` 帧带 phase/part/index）
 * 还原成 `part.begin` / `part.end`——part 边界是 tool_use 的"开户/销户"，
 * 丢掉它客户端侧就只剩悬空的参数增量（Anthropic 的 content_block_start 带 id/name）。
 * 帧与事件不总是 1:1（一个 `end` 帧可能同时携带 finish 与 usage），因此返回单个事件。
 */
function frameToEvent(frame: unknown): CanonicalStreamEvent {
  const f = frame as { event: string; data: Record<string, unknown> };
  switch (f.event) {
    case 'start':
      return {
        type: 'start',
        message: { model: String(f.data['model'] ?? ''), role: 'assistant' },
      };
    case 'delta': {
      const d = f.data as {
        kind?: string;
        index?: number;
        text?: string;
        thinking?: string;
        tool_input_json?: string;
        refusal?: string;
      };
      const index = typeof d.index === 'number' ? d.index : 0;
      if (d.tool_input_json !== undefined) {
        return {
          type: 'part.delta',
          index,
          delta: { type: 'tool_input_json', partial_json: d.tool_input_json },
        };
      }
      if (d.thinking !== undefined) {
        return { type: 'part.delta', index, delta: { type: 'thinking', thinking: d.thinking } };
      }
      if (d.refusal !== undefined) {
        return { type: 'part.delta', index, delta: { type: 'refusal', refusal: d.refusal } };
      }
      return { type: 'part.delta', index, delta: { type: 'text', text: d.text ?? '' } };
    }
    case 'meta': {
      const note = partNoteFrom(f.data);
      if (note !== undefined) {
        return note.phase === 'begin'
          ? { type: 'part.begin', index: note.index, part: note.part }
          : { type: 'part.end', index: note.index, part: note.part };
      }
      return { type: 'part.delta', index: 0, delta: { type: 'text', text: '' } };
    }
    case 'end':
      return {
        type: 'finish',
        finish_reason: (f.data['finish_reason'] as FinishReason) ?? 'stop',
        usage: (f.data['usage'] as CanonicalUsage) ?? emptyUsage('provider'),
      };
    case 'usage':
      return {
        type: 'usage',
        usage: (f.data['usage'] as CanonicalUsage) ?? emptyUsage('provider'),
      };
    case 'error':
      return {
        type: 'error',
        error:
          (f.data['error'] as CanonicalError) ??
          createCanonicalError('internal_error', 'unknown stream error', ''),
      };
    default:
      return { type: 'part.delta', index: 0, delta: { type: 'text', text: '' } };
  }
}

/**
 * 从 meta 帧里取 part 边界信息。
 *
 * 兼容两种载体，直到 codec 全部切到 `ir/stream.ts` 新加的 `PartBeginData` /
 * `PartEndData`（`event: "delta"` + `data: {kind:"chat", index, part}`）：
 *   A. 顶层 `{phase, index, part}`（类型化载体）；
 *   B. `notes` 里任意键挂的 `{phase, index, part}`（codec 此前的逃生舱，
 *      键名各 codec 不同：openai.chat.part / anthropic.part）。
 * 之所以不按 key 名匹配：键名是 codec 私有约定，管道不该知道。
 */
function partNoteFrom(
  data: Record<string, unknown>,
): { phase: 'begin' | 'end'; index: number; part: StreamPart } | undefined {
  const candidates: unknown[] = [data];
  const notes = data['notes'];
  if (typeof notes === 'object' && notes !== null) {
    candidates.push(...Object.values(notes as Record<string, unknown>));
  }
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) continue;
    const rec = c as Record<string, unknown>;
    const phase = rec['phase'];
    if (phase !== 'begin' && phase !== 'end') continue;
    const part = rec['part'];
    if (!isStreamPart(part)) continue;
    const idx = rec['index'];
    return { phase, index: typeof idx === 'number' ? idx : 0, part };
  }
  return undefined;
}

/** part 边界帧的结构守卫。 */
function isStreamPart(v: unknown): v is StreamPart {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}
