/**
 * gateway-core/pipeline/stages/s7-on-stream-chunk.ts —— S7 onStreamChunk。
 *
 * 职责（20 §S7）：插件可改写/丢弃/缓冲聚合。
 *
 * 插件签名 `(event, ctx) => event | event[] | null`：
 *   - 返回帧 → 替换；
 *   - 返回数组 → 一帧变多帧；
 *   - 返回 null → 丢弃（**chat 允许，tts 音频分片禁止**——Runner 对 kind:"tts" 的 delta
 *     强制拒绝 null 返回，违例记 plugin_error，25 §7.1）；
 *   - ShortCircuit → 不允许（流已开始，无法回头）。
 *
 * `needs: "aggregate"` 的插件会拿到一个"聚合视图"（内部维护完整 CanonicalResponse），
 * 但仍以流式向下游转发——即"旁路聚合，不阻塞"。
 *
 * fast path 下本阶段**不触发插件**：上游 SSE 字节不落 canonical、不改写、直接转发
 * （20 §4.2「流式 fast path」）。full-canonical（默认档）的流式插件因此在准入阶段就被
 * 禁用 fast path（D-fastpath-2 两侧对称，见 fast-path.ts）；只有显式声明
 * `scope: "envelope-only"` 的插件才可能出现在 fast path 请求里，而它们同样拿不到
 * canonical 事件——本阶段为它们记 `onStreamChunk_skipped_fast_path` warning，不静默。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type {
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  FinishReason,
  Part,
} from '../../../ir/index.js';
import { emptyUsage } from '../../../ir/index.js';

export class S7OnStreamChunk implements Stage {
  readonly id = 'S7';
  readonly name = 'onStreamChunk';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;

    if (ctx.fast_path) {
      // fast path：字节直通，插件不介入（20 §4.2）。
      // full-canonical 的流式插件在准入阶段就禁用 fast path（D-fastpath-2），能走到这里
      // 的只有显式 envelope-only 的插件——它们拿不到 canonical 事件，但**不静默**：
      // 记一条 warning 进 trace / UsageRecord.warnings，并打一个 metric。
      const streamPlugins = deps.pluginHost.streamSide();
      if (streamPlugins.length > 0) {
        const names = streamPlugins.map((p) => p.manifest.name).join(', ');
        ctx.warn('onStreamChunk_skipped_fast_path', names);
        deps.metrics.increment('pipeline.plugin_skipped', 1, {
          hook: 'onStreamChunk',
          reason: 'fast_path',
        });
      }
      ctx.recordStage(this.id, deps.clock.now() - started, 'fast_path:bypass');
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'fast_path' });
      return;
    }

    const streaming = state.shallow?.stream === true;
    const needsAggregate =
      deps.pluginHost.streamSide().length > 0 || deps.pluginHost.responseSide().length > 0;

    if (state.canonical_stream !== undefined) {
      const source = state.canonical_stream;
      const out: CanonicalStreamEvent[] = [];
      state.stream_events = out;

      async function* transformLive(): AsyncGenerator<CanonicalStreamEvent> {
        for await (const ev of source) {
          const result = await deps.pluginHost.runOnStreamChunk(ev, ctx);
          if (result === null) {
            if (ev.type === 'part.delta' && ev.delta.type === 'text') continue;
            ctx.warn('plugin_dropped_non_text_frame');
            continue;
          }
          const emitted = Array.isArray(result) ? result : [result];
          for (const item of emitted) {
            out.push(item);
            yield item;
          }
        }
        const lastUsage = [...out].reverse().find((e) => e.type === 'usage');
        const finish = [...out].reverse().find((e) => e.type === 'finish');
        if (lastUsage !== undefined && lastUsage.type === 'usage') {
          state.usage = lastUsage.usage;
        } else if (
          finish !== undefined &&
          finish.type === 'finish' &&
          finish.usage !== undefined &&
          Object.keys(finish.usage.units).length > 0
        ) {
          state.usage = finish.usage;
        }
        if (finish !== undefined && finish.type === 'finish') {
          state.finish_reason = finish.finish_reason;
        }
        if (streaming && needsAggregate) {
          state.aggregated = aggregateEvents(out, ctx.request_id);
        }
      }

      state.canonical_stream = transformLive();
      ctx.recordStage(this.id, deps.clock.now() - started, 'stream-armed');
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
      return;
    }

    const events = state.stream_events ?? [];
    const out: CanonicalStreamEvent[] = [];
    for (const ev of events) {
      const result = await deps.pluginHost.runOnStreamChunk(ev, ctx);
      if (result === null) {
        // tts 音频分片禁止丢弃（25 §7.1）
        if (ev.type === 'part.delta' && ev.delta.type === 'text') continue;
        ctx.warn('plugin_dropped_non_text_frame');
        continue;
      }
      if (Array.isArray(result)) out.push(...result);
      else out.push(result);
    }
    state.stream_events = out;

    // 聚合视图：给 needs:"aggregate" 的插件用（旁路聚合，不阻塞下游）。
    //
    // 触发条件原先只看 `streamSide().length`，于是**只声明 onResponse 的插件**
    // （审计/脱敏，最常见的形态）在流式下拿到的是 `synthesizeFromEvents` 拼出来的
    // 空信封（`parts: []`）——审计记录里一个字都没有。20 §S9 原文：「拿到最终
    // CanonicalResponse（流式下由 S7 的聚合视图提供）」，所以聚合视图本来就该
    // 服务 onResponse，不只是 onStreamChunk。这里按文档补齐：有任一侧插件就聚。
    //
    // ⚠️ 只在**流式**请求时聚合。非流式下 `state.stream_events` 恒为 []，
    // 聚合出来是一个空 parts、空 usage 的假信封；而 S9 的取值顺序是
    // `state.aggregated ?? state.response ?? synthesizeFromEvents(state)`，
    // 于是一个只声明了 onStreamChunk 的插件（哪怕它对流式之外什么都不做）
    // 会让 onResponse 看到空响应、并把 S10 记账的 usage 冲成估算值。
    // 客户端拿到的 body 不受影响（S8 非流式读 state.response），所以这个 bug
    // 在界面上完全看不出来——只有审计插件与计量会静默失真。
    if (streaming && needsAggregate) {
      state.aggregated = aggregateEvents(out, ctx.request_id);
    }

    ctx.recordStage(this.id, deps.clock.now() - started, `events=${out.length}`);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }
}

/** 把事件序列折叠成一个完整 CanonicalResponse（聚合视图）。 */
export function aggregateEvents(
  events: CanonicalStreamEvent[],
  requestId = '',
): CanonicalResponseEnvelope {
  let usage = emptyUsage('provider');
  let finish: FinishReason = 'stop';
  const textDeltas: string[] = [];
  let endText = '';
  const thinkingDeltas: string[] = [];
  let endThinking = '';
  const toolPartsByIndex = new Map<
    number,
    {
      id: string;
      name: string;
      args: string;
      input?: Record<string, unknown>;
      raw_arguments?: string;
    }
  >();
  let model = '';

  for (const ev of events) {
    switch (ev.type) {
      case 'start':
        if (ev.message.model !== '') model = ev.message.model;
        break;
      case 'part.begin':
        if (ev.part.type === 'tool_use') {
          toolPartsByIndex.set(ev.index, {
            id: ev.part.id,
            name: ev.part.name,
            args: '',
            ...(ev.part.input && Object.keys(ev.part.input).length > 0
              ? { input: ev.part.input }
              : {}),
            ...(ev.part.raw_arguments !== undefined
              ? { raw_arguments: ev.part.raw_arguments }
              : {}),
          });
        }
        break;
      case 'part.delta':
        if (ev.delta.type === 'text') textDeltas.push(ev.delta.text);
        else if (ev.delta.type === 'thinking') thinkingDeltas.push(ev.delta.thinking);
        else if (ev.delta.type === 'tool_input_json') {
          const existing = toolPartsByIndex.get(ev.index);
          if (existing !== undefined) {
            existing.args += ev.delta.partial_json;
          } else {
            toolPartsByIndex.set(ev.index, { id: '', name: '', args: ev.delta.partial_json });
          }
        }
        break;
      case 'part.end': {
        if (ev.part.type === 'tool_use') {
          const existing = toolPartsByIndex.get(ev.index);
          toolPartsByIndex.set(ev.index, {
            id: ev.part.id || existing?.id || '',
            name: ev.part.name || existing?.name || '',
            args: existing?.args ?? '',
            ...(ev.part.input !== undefined ? { input: ev.part.input } : {}),
            ...(ev.part.raw_arguments !== undefined
              ? { raw_arguments: ev.part.raw_arguments }
              : {}),
          });
        } else if (ev.part.type === 'text') {
          endText += ev.part.text;
        } else if (ev.part.type === 'thinking') {
          endThinking += ev.part.thinking;
        }
        break;
      }
      case 'usage':
        usage = ev.usage;
        break;
      case 'finish':
        if (ev.usage !== undefined && Object.keys(ev.usage.units).length > 0) {
          usage = ev.usage;
        }
        finish = ev.finish_reason;
        break;
      default:
        break;
    }
  }

  const parts: Part[] = [];
  const fullThinking = thinkingDeltas.length > 0 ? thinkingDeltas.join('') : endThinking;
  if (fullThinking !== '') {
    parts.push({ type: 'thinking', thinking: fullThinking });
  }
  const fullText = textDeltas.length > 0 ? textDeltas.join('') : endText;
  if (fullText !== '') {
    parts.push({ type: 'text', text: fullText });
  }
  for (const [, t] of [...toolPartsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const input =
      t.input !== undefined && Object.keys(t.input).length > 0 ? t.input : safeParse(t.args);
    parts.push({
      type: 'tool_use',
      id: t.id,
      name: t.name,
      input,
      ...(t.raw_arguments !== undefined
        ? { raw_arguments: t.raw_arguments }
        : t.args !== ''
          ? { raw_arguments: t.args }
          : {}),
    });
  }

  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    request_id: requestId,
    usage,
    finish_reason: finish,
    payload: { message: { role: 'assistant', parts }, ...(model === '' ? {} : { model }) },
    warnings: [],
    raw: {},
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
