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

import type { CanonicalError, CanonicalResponseEnvelope, RequestTrace } from '../../ir/index.js';
import { createCanonicalError, createRequestTrace, emptyUsage } from '../../ir/index.js';
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
import { S7OnStreamChunk } from './stages/s7-on-stream-chunk.js';
import { S8ClientEncode } from './stages/s8-client-encode.js';
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
        await this.writeShortCircuit(state, deps);
        await run('S9');
        await run('S10');
        return;
      }
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
      // 中间轮次的应答**不写给客户端**——否则第二次 sink.start 会触发 20 §S8 的硬约束。
      const maxTurns = state.canonical.gateway?.max_turns ?? deps.config.maxTurns;
      const loopResult = await runToolLoop(
        state.canonical,
        ctx,
        {
          pluginHost: deps.pluginHost,
          runTurn: async (req) => {
            const turnState: PipelineState = { ...state, canonical: req, canonical_override: req };
            for (const id of ['S4', 'S5', 'S6', 'S7']) {
              const stage = stageById.get(id);
              if (stage === undefined) throw new Error(`未知阶段: ${id}`);
              await stage.execute(turnState, deps);
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
      // 循环结束：把**最终**应答编码一次写给客户端
      await run('S8');
      await run('S9');
      await run('S10');
      return;
    }

    // ---- 普通路径：S4→S8→S9→S10 ----
    for (const id of ['S4', 'S5', 'S6', 'S7', 'S8']) {
      await run(id);
    }

    // ---- S9 / S10（整个请求只跑一次）----
    await run('S9');
    await run('S10');
  }

  /**
   * 插件短路时把应答写给客户端。
   *
   * S4–S8 被整体跳过（20 §S3），因此这里单独做一次「canonical → 客户端格式」编码。
   * 流式下不适用（流已开始就无法回头，25 §7.1 禁止流式 ShortCircuit）。
   */
  private async writeShortCircuit(state: PipelineState, deps: PipelineDeps): Promise<void> {
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
      deps.sink.start(state.short_circuit_error.http_status, {
        'content-type': 'application/json',
        'x-request-id': ctx.request_id,
      });
      deps.sink.write(JSON.stringify(body));
      state.bytes_written = true;
      return;
    }
    const res = state.short_circuit_response;
    const clientAdaptor = state.clientAdaptor;
    if (res === undefined || clientAdaptor === undefined) return;
    const body = clientAdaptor.encodeResponse(res, ctx);
    deps.sink.start(200, {
      'content-type': 'application/json',
      'x-request-id': ctx.request_id,
    });
    deps.sink.write(JSON.stringify(body));
    state.bytes_written = true;
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
