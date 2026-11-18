/**
 * gateway-core/pipeline/runner.ts —— PipelineRunner。
 *
 * 串联 S0–S10 共 11 个阶段（20 §2），并持有三个跨阶段的循环：
 *   1. **重试 / fallback**（20 §7.3）：attempt 的可重试错误用尽后切下一个 attempt，
 *      重跑 S4→S8（canonical 不变，只换 provider）；
 *   2. **网关 agentic loop**（20 §5.2）：工具调用多轮循环；
 *   3. **错误处理**：任一阶段失败 → onError 广播 → 按客户端格式映射错误体 →
 *      首字节前直接非 2xx，首字节后转 200 + SSE error 帧。
 *
 * 阶段职责表见 20 §2；`onToolCall` 与 `onError` 不是"一个阶段"而是横切点，
 * 分别由工具循环与本 Runner 的错误路径调用。
 */

import type {
  CanonicalError,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  RequestTrace,
} from '../../ir/index.js';
import { IR_VERSION, createCanonicalError, createRequestTrace, emptyUsage } from '../../ir/index.js';
import { CTX_STATE_KEYS } from '../../ir/index.js';
import type { MutableRequestContext } from '../context.js';
import { createContext, type S0Options } from './stages/s0-ingress.js';
import { S0Ingress } from './stages/s0-ingress.js';
import { S1Decode } from './stages/s1-decode.js';
import { S2Route } from './stages/s2-route.js';
import { S3OnRequest } from './stages/s3-on-request.js';
import { S4Encode } from './stages/s4-encode.js';
import { S5Upstream } from './stages/s5-upstream.js';
import { S6ProviderDecode } from './stages/s6-provider-decode.js';
import { S7OnStreamChunk, aggregateEvents } from './stages/s7-on-stream-chunk.js';
import { S8ClientEncode, serializeWireEvent, singleFrameStream } from './stages/s8-client-encode.js';
import { S9OnResponse } from './stages/s9-on-response.js';
import { S10UsageEmitter } from './stages/s10-usage-emitter.js';
import type {
  PipelineDeps,
  PipelineInput,
  PipelineOutcome,
  PipelineServices,
  PipelineState,
  Stage,
} from './types.js';
import type { ClientSink } from './sink.js';
import { shouldUseGatewayLoop, runToolLoop } from './tool-loop.js';

export interface PipelineRunnerOptions {
  /** S0 的鉴权器（Phase 1 默认 permissive；真实 virtual key 在 auth/ 模块）。 */
  authenticator?: S0Options['authenticator'];
}

export class PipelineRunner {
  private readonly stages: Stage[];

  constructor(
    private readonly services: PipelineServices,
    options: PipelineRunnerOptions = {},
  ) {
    this.stages = [
      new S0Ingress({ authenticator: options.authenticator }),
      new S1Decode(),
      new S2Route(),
      new S3OnRequest(),
      new S4Encode(),
      new S5Upstream(),
      new S6ProviderDecode(),
      new S7OnStreamChunk(),
      new S8ClientEncode(),
      new S9OnResponse(),
      new S10UsageEmitter(),
    ];
  }

  /**
   * 跑一次完整请求。**不抛**——所有失败都转成 outcome.error + 客户端错误体。
   *
   * `sink` 每次请求注入（http/server.ts 的 NodeResponseSink 或测试的 MemoryClientSink），
   * 因此组合根不需要知道"这一次请求写给谁"。
   */
  async run(input: PipelineInput, sink: ClientSink): Promise<PipelineOutcome> {
    const deps: PipelineDeps = { ...this.services, sink };
    const now = this.services.clock.now();
    const requestId = this.services.ids.requestId();
    const traceId = input.headers['traceparent'];

    const onDisableFastPath = (reason: string) => {
      this.services.metrics.increment('pipeline.fast_path_disabled', 1, { reason });
    };

    const ctx: MutableRequestContext = createContext(
      requestId,
      now,
      input.headers,
      traceId,
      onDisableFastPath,
    );

    const state: PipelineState = {
      ctx,
      input,
      modality: 'chat',
      route_ready: false,
      bytes_written: false,
      trace: createRequestTrace(requestId, input.client_format, input.client_format),
      diagnostics: [],
      dropped_capabilities: [],
      conversion_chain: [],
      materialized: false,
      turns: 0,
    };

    try {
      await this.runStages(state, deps);
      return this.successOutcome(state);
    } catch (err) {
      return await this.failureOutcome(state, err, deps);
    }
  }

  /**
   * 执行顺序（20 §2 阶段表）：
   *   S0 → S1 → S2 → S3 ──(ShortCircuit)──▶ S9 → S10
   *                        └──▶ S4 → S5 → S6 → S7 → S8
   *                                   └──(网关 agentic loop：每轮重跑 S4→S8)
   *                                                └──▶ S9 → S10
   *
   * 流式时 S9 在流关闭后执行（20 §S9：不再影响已发出的内容，只能做记录与副作用）。
   * 因此 **S9/S10 在整个 run() 里只执行一次**——工具循环的每一轮只重跑 S4→S8。
   */
  private async runStages(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const { ctx } = state;
    const stageById = new Map(this.stages.map((s) => [s.id, s]));
    const run = async (id: string): Promise<void> => {
      const stage = stageById.get(id);
      if (stage === undefined) throw new Error(`未知阶段: ${id}`);
      const before = state.materialized;
      await stage.execute(state, deps);
      // 观测：哪些阶段触发了完整物化（D-fastpath-1 的代价观测）
      if (!before && state.materialized) {
        deps.metrics.increment('pipeline.materialize', 1, { stage: stage.id });
      }
    };

    // ---- S0–S3 ----
    for (const id of ['S0', 'S1', 'S2', 'S3']) {
      await run(id);
      if (
        id === 'S3' &&
        (state.short_circuit_response !== undefined || state.short_circuit_error !== undefined)
      ) {
        state.status = state.short_circuit_error !== undefined ? 'error' : 'short_circuit';
        state.error = state.short_circuit_error;
        state.final_response = state.short_circuit_response;
        if (state.short_circuit_response !== undefined) {
          state.usage = state.short_circuit_response.usage;
        }
        this.writeShortCircuit(state);
        await run('S9');
        await this.flushClientBytes(state, deps);
        await run('S10');
        return;
      }
    }

    // ---- 跨模态桥接：对话端点（chat / responses / messages）收到生图模型 ----
    if (ctx.route?.target_modality === 'image' && deps.imageBridge !== undefined) {
      await this.runImageBridge(state, deps);
      await run('S8');
      await run('S9');
      await this.flushClientBytes(state, deps);
      await run('S10');
      return;
    }

    // ---- 网关 agentic loop 判定（20 §5.2）----
    // 判定依据（gateway.agentic_loop / raw.unmapped.ag_agentic_loop）在完整 canonical 上，
    // 但**不能为了判断就物化**——那会让每个请求都付全量解码代价，fast path 的惰性白做。
    // 因此先用两个廉价信号决定"要不要物化"：
    //   a) 浅解析已给出 gateway_agentic_loop（generic 路径会填）；
    //   b) 原始字节里出现过该标记（codec 的 decodeEnvelope 未填该字段时的兜底，
    //      一次 substring 搜索，不做 JSON 解析）。
    // 只有真要进循环时才物化（D-fastpath-1 的第三种触发点）。
    const wantsLoop =
      state.short_circuit_response === undefined &&
      (state.shallow?.gateway_agentic_loop === true ||
        (state.lazy !== undefined &&
          state.lazy.raw.toString('utf8').includes('"ag_agentic_loop"')));
    if (wantsLoop && state.canonical === undefined && state.lazy !== undefined) {
      state.canonical = state.lazy.full();
      state.materialized = true;
      deps.metrics.increment('pipeline.materialize', 1, { stage: 'tool-loop' });
    }
    const useGatewayLoop =
      state.canonical !== undefined &&
      state.short_circuit_response === undefined &&
      shouldUseGatewayLoop(state.canonical);

    if (useGatewayLoop) {
      // 网关循环需要往 canonical.messages 里追加 tool_use / tool_result 回合（APPEND_TURN），
      // 因此**必须关闭 fast path**——否则上游应答不会被解码成 canonical，循环拿不到 tool_use。
      // 这也是 fast path 关闭率的一个可观测来源（20 §4.1 / 70 Phase 3 验收）。
      if (ctx.fast_path) {
        ctx.disableFastPath('gateway agentic loop requires canonical');
      }
    }

    if (useGatewayLoop && state.canonical !== undefined) {
      // ---- 网关 agentic loop：每一轮重跑 S4→S7，循环结束后才 S8/S9/S10 ----
      // 非流式下中间轮次的应答不写给客户端；流式下则实时转发思考与正文增量，
      // 工具调用由网关在后台循环执行，最后一轮结束后补发 usage 与 finish 帧。
      const maxTurns = state.canonical.gateway?.max_turns ?? deps.config.maxTurns;
      const streamingLoop = state.shallow?.stream === true;
      const clientAdaptor = state.clientAdaptor;
      let loopStreamStarted = false;
      const ensureLoopStreamSink = (): void => {
        if (!deps.sink.started) {
          deps.sink.start(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-request-id': ctx.request_id,
          });
          state.bytes_written = true;
        }
      };

      const loopResult = await runToolLoop(
        state.canonical,
        ctx,
        {
          pluginHost: deps.pluginHost,
          runTurn: async (req) => {
            const turnState: PipelineState = {
              ...state,
              canonical: req,
              canonical_override: req,
              response: undefined,
              stream_events: undefined,
              canonical_stream: undefined,
              aggregated: undefined,
            };
            for (const id of ['S4', 'S5', 'S6', 'S7']) {
              const stage = stageById.get(id);
              if (stage === undefined) throw new Error(`未知阶段: ${id}`);
              await stage.execute(turnState, deps);
            }
            if (turnState.canonical_stream !== undefined) {
              const turnEvents: CanonicalStreamEvent[] = [];
              for await (const ev of turnState.canonical_stream) {
                if (deps.sink.closed) break;
                turnEvents.push(ev);
                if (streamingLoop && clientAdaptor !== undefined) {
                  if (ev.type === 'start' && !loopStreamStarted) {
                    loopStreamStarted = true;
                    ensureLoopStreamSink();
                    for await (const wire of clientAdaptor.encodeStream(
                      singleFrameStream(ev, ctx.request_id),
                      ctx,
                    )) {
                      deps.sink.write(serializeWireEvent(wire));
                    }
                  } else if (
                    ev.type === 'part.delta' &&
                    (ev.delta.type === 'text' ||
                      ev.delta.type === 'thinking' ||
                      ev.delta.type === 'refusal')
                  ) {
                    ensureLoopStreamSink();
                    for await (const wire of clientAdaptor.encodeStream(
                      singleFrameStream(ev, ctx.request_id),
                      ctx,
                    )) {
                      deps.sink.write(serializeWireEvent(wire));
                    }
                  }
                }
              }
              turnState.stream_events = turnEvents;
              if (turnState.response === undefined) {
                turnState.response =
                  turnState.aggregated ?? aggregateEvents(turnEvents, ctx.request_id);
              }
              if (
                turnState.usage === undefined ||
                Object.keys(turnState.usage.units).length === 0
              ) {
                turnState.usage = turnState.response.usage;
              }
              turnState.finish_reason =
                turnState.finish_reason ??
                (turnState.response.finish_reason as PipelineState['finish_reason']);
            }
            // 把这一轮的产物合并回主 state（S8/S9/S10 只跑一次）
            state.turns = turnState.turns;
            state.usage = turnState.usage;
            state.response = turnState.response;
            state.finish_reason = turnState.finish_reason;
            state.stream_events = turnState.stream_events;
            state.aggregated = turnState.aggregated;
            state.final_response = turnState.final_response;
            state.upstream_chunks = turnState.upstream_chunks;
            state.upstream = turnState.upstream;
            state.upstream_status = turnState.upstream_status;
            state.ttfb_ms = turnState.ttfb_ms;
            state.sniffer = turnState.sniffer;
            state.diagnostics.push(...turnState.diagnostics);
            state.dropped_capabilities.push(...turnState.dropped_capabilities);
            return turnState.response ?? (turnState.final_response as CanonicalResponseEnvelope);
          },
        },
        maxTurns,
      );
      state.turns = loopResult.turns;
      state.response = loopResult.response;
      state.final_response = loopResult.response;
      if (loopResult.exceeded) {
        ctx.warn('agentic_loop_exceeded', `turns=${loopResult.turns}`);
      }
      if (streamingLoop && clientAdaptor !== undefined) {
        ensureLoopStreamSink();
        const finalUsage = state.usage ?? loopResult.response.usage;
        const tailEvents: CanonicalStreamEvent[] = [
          ...(Object.keys(finalUsage.units).length > 0
            ? [{ type: 'usage' as const, usage: finalUsage }]
            : []),
          {
            type: 'finish' as const,
            finish_reason: (state.finish_reason ?? 'stop') as CanonicalStreamEvent & {
              type: 'finish';
            } extends { finish_reason: infer R }
              ? R
              : never,
            usage: finalUsage,
          },
        ];
        for (const ev of tailEvents) {
          if (deps.sink.closed) break;
          for await (const wire of clientAdaptor.encodeStream(
            singleFrameStream(ev, ctx.request_id),
            ctx,
          )) {
            deps.sink.write(serializeWireEvent(wire));
          }
        }
        await run('S9');
        await run('S10');
        return;
      }
      // 非流式循环结束：把**最终**应答编码一次（暂存，S9 之后才写给客户端）
      await run('S8');
      await run('S9');
      await this.flushClientBytes(state, deps);
      await run('S10');
      return;
    }

    // ---- 普通路径：S4→S8→S9→S10 ----
    for (const id of ['S4', 'S5', 'S6', 'S7', 'S8']) {
      await run(id);
    }

    // ---- S9 / S10（整个请求只跑一次）----
    await run('S9');
    // 非流式的客户端字节在 S9 之后才真正写出：插件链（onResponse）改写了响应，
    // flush 出去的就必须是改写后的那一份（§4.3）。
    await this.flushClientBytes(state, deps);
    await run('S10');
  }

  /**
   * 把 S8 暂存的客户端字节写给 sink（非流式）。
   *
   * 为什么不在 S8 里直接写：S8 排在 S9 之前，先写就让 `onResponse` 的响应改写
   * 没了落点（详见 types.ts 的 `client_bytes`）。阶段编号与顺序因此完全不变，
   * 变的只是「什么时候把字节交给 sink」。
   *
   * 三个前提，缺一不写：
   *   - `state.client_bytes` 存在（流式下恒不存在——流式在 S8 已逐帧写出）；
   *   - 还没写出过首字节（`bytes_written`）；
   *   - sink 还开着（客户端断开时不再写，写了也是 ERR_STREAM_WRITE_AFTER_END）。
   */
  private async flushClientBytes(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const buffered = state.client_bytes;
    if (buffered === undefined || state.bytes_written) return;
    if (deps.sink.closed) {
      // 客户端已经断开：放弃写出，但保留记账（S10 照样跑）
      state.ctx.warn('client_disconnected_before_flush');
      return;
    }
    deps.sink.start(buffered.status, buffered.headers);
    deps.sink.write(buffered.body);
    state.bytes_written = true;
  }

  private async runImageBridge(state: PipelineState, deps: PipelineDeps): Promise<void> {
    if (state.ctx.fast_path) {
      state.ctx.disableFastPath('modality bridge chat->image');
    }
    if (state.canonical === undefined && state.lazy !== undefined) {
      state.canonical = state.lazy.full();
      state.materialized = true;
    }
    const payload = (state.canonical?.payload ?? {}) as {
      system?: unknown[];
      messages?: Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>;
    };
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const hasSystem =
      (Array.isArray(payload.system) && payload.system.length > 0) ||
      messages.some((m) => m.role === 'system' || m.role === 'developer');
    const nonSystem = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
    const hasMultiTurn = nonSystem.length > 1;

    const lastUser = [...nonSystem].reverse().find((m) => m.role === 'user') ?? nonSystem.at(-1);
    const prompt = (lastUser?.parts ?? [])
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('\n')
      .trim();

    const route = state.ctx.route!;
    const generated = await deps.imageBridge!.generate({
      access_path: route.access_path,
      model: route.model,
      prompt: prompt || 'image',
      ctx: state.ctx,
    });

    const parts: string[] = [];
    if (hasSystem || hasMultiTurn) {
      parts.push(
        '> ℹ️ Note: Current image model does not support system prompt or multi-turn context; only the latest prompt was used.\n',
      );
    }
    for (const url of generated.urls) {
      parts.push(`![generated](${url})`);
    }
    for (const b64 of generated.b64_jsons) {
      parts.push(`![generated](data:image/png;base64,${b64})`);
    }
    if (generated.revised_prompt) {
      parts.push(`\n*Revised prompt:* ${generated.revised_prompt}`);
    }
    const text = parts.join('\n');
    const usage = generated.usage ?? { units: {}, source: 'provider' as const };
    const resp: CanonicalResponseEnvelope = {
      ir_version: IR_VERSION,
      kind: 'chat',
      request_id: state.ctx.request_id,
      usage,
      finish_reason: 'stop',
      warnings: [],
      raw: {},
      payload: {
        kind: 'chat',
        model: state.canonical?.model ?? route.model,
        message: { role: 'assistant', parts: [{ type: 'text', text }] },
        finish_reason: 'stop',
      } as unknown as CanonicalResponseEnvelope['payload'],
    };

    state.usage = usage;
    state.finish_reason = 'stop';
    state.upstream_status = 200;
    state.response = resp;
    state.final_response = resp;

    if (state.shallow?.stream === true || state.canonical?.stream?.enabled === true) {
      const events: CanonicalStreamEvent[] = [
        { type: 'start', message: { id: state.ctx.request_id, model: route.model, role: 'assistant' } },
        { type: 'part.begin', index: 0, part: { type: 'text', text: '' } },
        { type: 'part.delta', index: 0, delta: { type: 'text', text } },
        { type: 'part.end', index: 0, part: { type: 'text', text } },
        { type: 'finish', finish_reason: 'stop', usage },
      ];
      state.stream_events = events;
    }
  }

  /**
   * 插件短路时把应答**编码**成客户端字节（暂存，S9 之后才写出）。
   *
   * S4–S8 被整体跳过（20 §S3），因此这里单独做一次「canonical → 客户端格式」编码。
   * 流式下不适用（流已开始就无法回头，25 §7.1 禁止流式 ShortCircuit）。
   *
   * 与 S8 同理：只暂存不写出。短路路径同样要跑 S9 的 `onResponse`（30 §3：
   * 「让审计类插件看到」），而审计插件也有权改写这份合成响应——先写就同样丢了。
   */
  private writeShortCircuit(state: PipelineState): void {
    const { ctx } = state;
    if (state.short_circuit_error !== undefined) {
      // guard 拦截：首字节前 → 直接非 2xx
      const clientAdaptor = state.clientAdaptor;
      const body =
        clientAdaptor === undefined
          ? {
              error: {
                message: state.short_circuit_error.message,
                type: state.short_circuit_error.code,
              },
            }
          : clientAdaptor.encodeResponse(errorEnvelope(state.short_circuit_error, ctx), ctx);
      state.client_bytes = {
        status: state.short_circuit_error.http_status,
        headers: {
          'content-type': 'application/json',
          'x-request-id': ctx.request_id,
        },
        body: JSON.stringify(body),
      };
      return;
    }
    const res = state.short_circuit_response;
    const clientAdaptor = state.clientAdaptor;
    if (res === undefined || clientAdaptor === undefined) return;
    state.client_bytes = {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': ctx.request_id,
      },
      body: JSON.stringify(clientAdaptor.encodeResponse(res, ctx)),
    };
  }

  private successOutcome(state: PipelineState): PipelineOutcome {
    const { ctx } = state;
    state.trace.fast_path = ctx.fast_path;
    state.trace.warnings = ctx.warnings;
    state.trace.stages = ctx.metrics;
    return {
      status: state.upstream_status ?? 200,
      fast_path: ctx.fast_path,
      materialized: state.materialized,
      trace: state.trace,
      usage: state.usage,
      short_circuit: state.short_circuit_response !== undefined,
      turns: state.turns,
      ...(state.error === undefined ? {} : { error: state.error }),
    };
  }

  /** 阶段失败：广播 onError → 映射错误体 → 决定能否还改状态码。 */
  private async failureOutcome(
    state: PipelineState,
    err: unknown,
    deps: PipelineDeps,
  ): Promise<PipelineOutcome> {
    const { ctx } = state;
    const canonical = toCanonicalError(err, ctx.request_id);
    state.error = canonical;
    state.status = 'error';

    // onError 是横切点：任意阶段出错都会调用，且**不改变控制流**（30 §3）
    await deps.pluginHost.notifyError(canonical, ctx);

    // S8 可能已经暂存了客户端字节但还没写（延迟写出）。既然这条路要发错误体，
    // 暂存的那份必须作废——否则「客户端拿到错误、缓冲里还躺着一份成功响应」。
    state.client_bytes = undefined;

    if (!state.bytes_written) {
      // 首字节前：可以直接返回非 2xx
      const clientAdaptor = state.clientAdaptor;
      const body =
        clientAdaptor === undefined
          ? { error: { message: canonical.message, type: canonical.code, code: canonical.code } }
          : clientAdaptor.encodeResponse(errorEnvelope(canonical, ctx), ctx);
      deps.sink.start(canonical.http_status, {
        'content-type': 'application/json',
        'x-request-id': ctx.request_id,
      });
      deps.sink.write(JSON.stringify(body));
      state.bytes_written = true;
    } else {
      // 已出字节：只能发一个 SSE error 帧（20 §S8 / §S5 流式空闲超时的杀流姿势）
      deps.sink.write(
        `event: error\ndata: ${JSON.stringify({
          error: { message: canonical.message, type: canonical.code, code: canonical.code },
          fatal: true,
        })}\n\n`,
      );
    }

    // S10 仍然要跑：失败也要记账（status = "error"）
    state.usage = state.usage ?? emptyUsage('provider');
    try {
      await this.stages[10]!.execute(state, deps);
    } catch {
      // S10 永不抛；这里的 try 只是双保险
    }

    state.trace.fast_path = ctx.fast_path;
    state.trace.warnings = ctx.warnings;
    state.trace.stages = ctx.metrics;
    state.trace.dropped_capabilities = state.dropped_capabilities;
    state.trace.conversion_chain = state.conversion_chain;

    deps.metrics.increment('pipeline.error', 1, { code: canonical.code });

    return {
      status: state.bytes_written && state.upstream_status === 200 ? 200 : canonical.http_status,
      fast_path: ctx.fast_path,
      materialized: state.materialized,
      trace: state.trace,
      usage: state.usage,
      error: canonical,
      short_circuit: false,
      turns: state.turns,
    };
  }
}

/**
 * 把 CanonicalError 包成一个响应信封，供客户端格式 codec 按 20 §7.2 生成错误体。
 *
 * `raw.nodes.error` 带**完整**的 CanonicalError（code / http_status / retryable /
 * provider_code / capability_rejected）——客户端 codec 需要这些才能填出
 * `{error:{type, code}}`；只给 message 会逼它猜码（OpenAI 的 rate_limit_error /
 * Anthropic 的 overloaded_error 全靠它们区分）。`raw` 默认不回给客户端（20 §7.2），
 * 由 codec 决定挑哪些字段透出。
 */
function errorEnvelope(err: CanonicalError, ctx: MutableRequestContext): CanonicalResponseEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    request_id: ctx.request_id,
    usage: emptyUsage('provider'),
    finish_reason: 'error',
    payload: { message: { role: 'assistant', parts: [{ type: 'refusal', reason: err.message }] } },
    warnings: [],
    raw: { nodes: { error: err } },
  };
}

function toCanonicalError(err: unknown, requestId: string): CanonicalError {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'http_status' in err &&
    'request_id' in err
  ) {
    return err as CanonicalError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return createCanonicalError('internal_error', message, requestId);
}

/** 便捷导出：RequestTrace 与 CTX_STATE_KEYS 供外部观测用。 */
export type { RequestTrace };
export { CTX_STATE_KEYS };
