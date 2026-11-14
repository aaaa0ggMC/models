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

import type { PipelineDeps, PipelineState, Stage } from "../types.js";
import type {
  CanonicalError,
  CanonicalStreamEvent,
  CanonicalUsage,
  FinishReason,
} from "../../../ir/index.js";
import { createCanonicalError, emptyUsage } from "../../../ir/index.js";
import { IncrementalUsageSniffer, type UsageSnifferOptions } from "../usage-sniffer.js";

export class S6ProviderDecode implements Stage {
  readonly id = "S6";
  readonly name = "ProviderDecode";

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const upstream = state.upstream;
    const providerAdaptor = state.providerAdaptor;
    if (upstream === undefined || providerAdaptor === undefined) {
      throw new Error("S6 需要 S5 的上游响应与 S4 的 provider adaptor");
    }

    const streaming = state.shallow?.stream === true;

    if (streaming) {
      if (ctx.fast_path) {
        // fast path：**不读流**。只创建嗅探器交给 S8——S8 一边把字节写给客户端，
        // 一边喂给嗅探器，两者互不等待，保持"零延迟透传"（20 §4.2、设计原则 3）。
        state.sniffer = new IncrementalUsageSniffer(snifferOptionsFor(ctx.provider_format, deps));
        ctx.recordStage(this.id, deps.clock.now() - started, "fast_path:sniffer-armed");
        deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "fast_path" });
        return;
      }

      // 慢路径：折叠成 CanonicalStreamEvent 序列（20 §S6 折叠表由 codec 实现）
      const chunks: string[] = [];
      if (upstream.chunks !== undefined) {
        for await (const chunk of upstream.chunks) {
          if (deps.sink.closed) break;
          chunks.push(chunk.toString("utf8"));
        }
      }
      state.upstream_chunks = chunks;
      const sseText = chunks.join("");
      const events = await collectEvents(providerAdaptor, sseText, ctx);
      state.stream_events = events;
      const lastUsage = [...events].reverse().find((e) => e.type === "usage");
      const finish = [...events].reverse().find((e) => e.type === "finish");
      if (lastUsage !== undefined && lastUsage.type === "usage") state.usage = lastUsage.usage;
      if (finish !== undefined && finish.type === "finish") state.finish_reason = finish.finish_reason;
      ctx.recordStage(this.id, deps.clock.now() - started, `slow:events=${events.length}`);
      deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "slow" });
      return;
    }

    // 非流式
    const bodyText = upstream.body?.toString("utf8") ?? "";
    if (ctx.fast_path) {
      // fast path 非流式：只抽 usage（finish_reason 归一见 §4.3）
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = undefined;
      }
      state.usage = providerAdaptor.extractUsage(parsed);
      if (state.usage.units.tokens === undefined) ctx.warn("usage_missing");
      ctx.recordStage(this.id, deps.clock.now() - started, "fast_path:usage-only");
      deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "fast_path" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw createCanonicalError(
        "canonical_decode_error",
        `上游响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
        ctx.request_id,
      );
    }
    const response = providerAdaptor.decodeResponse(parsed, ctx);
    state.response = response;
    state.usage = response.usage;
    state.finish_reason = response.finish_reason as State["finish_reason"];
    for (const w of response.warnings) ctx.warn(w);
    ctx.recordStage(this.id, deps.clock.now() - started, "slow:decodeResponse");
    deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "slow" });
  }
}

type State = PipelineState;

function snifferOptionsFor(
  providerFormat: string,
  deps: PipelineDeps,
): UsageSnifferOptions {
  const flavor: UsageSnifferOptions["flavor"] =
    providerFormat === "openai.chat"
      ? "openai_chat"
      : providerFormat === "openai.responses"
        ? "openai_responses"
        : providerFormat === "anthropic.messages"
          ? "anthropic"
          : providerFormat === "gemini.generateContent"
            ? "gemini"
            : "generic";
  return { max_bytes: deps.config.usageSnifferMaxBytes, flavor };
}

/** 用 codec 的 decodeStream 把 SSE 文本折叠成 CanonicalStreamEvent。 */
async function collectEvents(
  adaptor: NonNullable<State["providerAdaptor"]>,
  sseText: string,
  ctx: State["ctx"],
): Promise<CanonicalStreamEvent[]> {
  const frames: unknown[] = [];
  async function* upstream() {
    // 按 SSE 事件边界切，让 codec 看到"一个事件一个元素"
    for (const block of sseText.split(/\n\n/)) {
      if (block.trim() === "") continue;
      yield block;
    }
  }
  for await (const frame of adaptor.decodeStream(upstream(), ctx)) {
    frames.push(frame);
  }
  // decodeStream 产的是 StreamFrame；这里转成 CanonicalStreamEvent 供 S7 消费
  return frames.map(frameToEvent);
}

function frameToEvent(frame: unknown): CanonicalStreamEvent {
  const f = frame as { event: string; data: Record<string, unknown> };
  switch (f.event) {
    case "start":
      return {
        type: "start",
        message: { model: String(f.data["model"] ?? ""), role: "assistant" },
      };
    case "delta": {
      const d = f.data as { kind?: string; text?: string; thinking?: string; tool_input_json?: string; refusal?: string };
      if (d.tool_input_json !== undefined) {
        return { type: "part.delta", index: 0, delta: { type: "tool_input_json", partial_json: d.tool_input_json } };
      }
      if (d.thinking !== undefined) {
        return { type: "part.delta", index: 0, delta: { type: "thinking", thinking: d.thinking } };
      }
      if (d.refusal !== undefined) {
        return { type: "part.delta", index: 0, delta: { type: "refusal", refusal: d.refusal } };
      }
      return { type: "part.delta", index: 0, delta: { type: "text", text: d.text ?? "" } };
    }
    case "end":
      return {
        type: "finish",
        finish_reason: (f.data["finish_reason"] as FinishReason) ?? "stop",
        usage: (f.data["usage"] as CanonicalUsage) ?? emptyUsage("provider"),
      };
    case "usage":
      return {
        type: "usage",
        usage: (f.data["usage"] as CanonicalUsage) ?? emptyUsage("provider"),
      };
    case "error":
      return {
        type: "error",
        error: (f.data["error"] as CanonicalError) ?? createCanonicalError("internal_error", "unknown stream error", ""),
      };
    default:
      return { type: "part.delta", index: 0, delta: { type: "text", text: "" } };
  }
}
