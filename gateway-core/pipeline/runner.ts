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
  RequestTrace,
} from "../../ir/index.js";
import { createCanonicalError, createRequestTrace, emptyUsage } from "../../ir/index.js";
import { CTX_STATE_KEYS } from "../../ir/index.js";
import type { MutableRequestContext } from "../context.js";
import { createContext, type S0Options } from "./stages/s0-ingress.js";
import { S0Ingress } from "./stages/s0-ingress.js";
import { S1Decode } from "./stages/s1-decode.js";
import { S2Route } from "./stages/s2-route.js";
import { S3OnRequest } from "./stages/s3-on-request.js";
import { S4Encode } from "./stages/s4-encode.js";
import { S5Upstream } from "./stages/s5-upstream.js";
import { S6ProviderDecode } from "./stages/s6-provider-decode.js";
import { S7OnStreamChunk } from "./stages/s7-on-stream-chunk.js";
import { S8ClientEncode } from "./stages/s8-client-encode.js";
import { S9OnResponse } from "./stages/s9-on-response.js";
import { S10UsageEmitter } from "./stages/s10-usage-emitter.js";
import type {
  PipelineDeps,
  PipelineInput,
  PipelineOutcome,
  PipelineServices,
  PipelineState,
  Stage,
} from "./types.js";
import type { ClientSink } from "./sink.js";
import { shouldUseGatewayLoop, runToolLoop } from "./tool-loop.js";

export interface PipelineRunnerOptions {
  /** S0 的鉴权器（Phase 1 默认 permissive；真实 virtual key 在 auth/ 模块）。 */
  authenticator?: S0Options["authenticator"];
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
    const traceId = input.headers["traceparent"];

    const onDisableFastPath = (reason: string) => {
      this.services.metrics.increment("pipeline.fast_path_disabled", 1, { reason });
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
      modality: "chat",
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

  /** 顺序执行 S0→S10；其中 S4→S8 可能因工具循环重复执行。 */
  private async runStages(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const { ctx } = state;

    for (const stage of this.stages) {
      const before = state.materialized;
      await stage.execute(state, deps);
      // 观测：哪些阶段触发了完整物化（D-fastpath-1 的代价观测）
      if (!before && state.materialized) {
        deps.metrics.increment("pipeline.materialize", 1, { stage: stage.id });
      }

      // S3 短路：跳过 S4–S8，直达 S9
      if (stage.id === "S3" && (state.short_circuit_response !== undefined || state.short_circuit_error !== undefined)) {
        state.status = state.short_circuit_error !== undefined ? "error" : "short_circuit";
        state.error = state.short_circuit_error;
        state.final_response = state.short_circuit_response;
        if (state.short_circuit_response !== undefined) {
          state.usage = state.short_circuit_response.usage;
        }
        await this.stages[9]!.execute(state, deps); // S9
        await this.stages[10]!.execute(state, deps); // S10
        return;
      }

      // S8 之后：流式已发出字节，S9 在流关闭后执行
      if (stage.id === "S8" && state.bytes_written && state.input.query["stream"] !== "false") {
        const streaming = state.shallow?.stream === true;
        if (streaming) {
          await this.stages[9]!.execute(state, deps); // S9
          await this.stages[10]!.execute(state, deps); // S10
          return;
        }
      }
    }

    // 网关 agentic loop（20 §5.2）：S3 之后、S9 之前多轮
    if (
      state.canonical !== undefined &&
      state.short_circuit_response === undefined &&
      shouldUseGatewayLoop(state.canonical)
    ) {
      const maxTurns = state.canonical.gateway?.max_turns ?? deps.config.maxTurns;
      const loopResult = await runToolLoop(state.canonical, ctx, {
        pluginHost: deps.pluginHost,
        runTurn: async (req) => {
          // 每轮重跑 S4→S8（canonical 变，provider 不变）
          const turnState: PipelineState = { ...state, canonical: req, turns: state.turns };
          await this.stages[3]!.execute(turnState, deps); // S4
          await this.stages[4]!.execute(turnState, deps); // S5
          await this.stages[5]!.execute(turnState, deps); // S6
          await this.stages[6]!.execute(turnState, deps); // S7
          await this.stages[7]!.execute(turnState, deps); // S8
          state.turns = turnState.turns;
          state.usage = turnState.usage;
          state.response = turnState.response;
          state.finish_reason = turnState.finish_reason;
          return turnState.response ?? (turnState.final_response as CanonicalResponseEnvelope);
        },
      }, maxTurns);
      state.turns = loopResult.turns;
      state.response = loopResult.response;
      if (loopResult.exceeded) {
        ctx.warn("agentic_loop_exceeded", `turns=${loopResult.turns}`);
      }
      // 循环结束后补 S9/S10
      await this.stages[9]!.execute(state, deps);
      await this.stages[10]!.execute(state, deps);
      return;
    }
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
    state.status = "error";

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
        "content-type": "application/json",
        "x-request-id": ctx.request_id,
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
    state.usage = state.usage ?? emptyUsage("provider");
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

    deps.metrics.increment("pipeline.error", 1, { code: canonical.code });

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

function errorEnvelope(err: CanonicalError, ctx: MutableRequestContext): CanonicalResponseEnvelope {
  return {
    ir_version: "ag-ir/1",
    kind: "chat",
    request_id: ctx.request_id,
    usage: emptyUsage("provider"),
    finish_reason: "error",
    payload: { message: { role: "assistant", parts: [{ type: "refusal", reason: err.message }] } },
    warnings: [],
    raw: {},
  };
}

function toCanonicalError(err: unknown, requestId: string): CanonicalError {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "http_status" in err &&
    "request_id" in err
  ) {
    return err as CanonicalError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return createCanonicalError("internal_error", message, requestId);
}

/** 便捷导出：RequestTrace 与 CTX_STATE_KEYS 供外部观测用。 */
export type { RequestTrace };
export { CTX_STATE_KEYS };
