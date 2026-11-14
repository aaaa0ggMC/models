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
 * （20 §4.2「流式 fast path」）。
 */

import type { PipelineDeps, PipelineState, Stage } from "../types.js";
import type {
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  FinishReason,
  Part,
} from "../../../ir/index.js";
import { emptyUsage } from "../../../ir/index.js";

export class S7OnStreamChunk implements Stage {
  readonly id = "S7";
  readonly name = "onStreamChunk";

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;

    if (ctx.fast_path) {
      // fast path：字节直通，插件不介入（20 §4.2）
      ctx.recordStage(this.id, deps.clock.now() - started, "fast_path:bypass");
      deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "fast_path" });
      return;
    }

    const events = state.stream_events ?? [];
    const out: CanonicalStreamEvent[] = [];
    for (const ev of events) {
      const result = await deps.pluginHost.runOnStreamChunk(ev, ctx);
      if (result === null) {
        // tts 音频分片禁止丢弃（25 §7.1）
        if (ev.type === "part.delta" && ev.delta.type === "text") continue;
        ctx.warn("plugin_dropped_non_text_frame");
        continue;
      }
      if (Array.isArray(result)) out.push(...result);
      else out.push(result);
    }
    state.stream_events = out;

    // 聚合视图：给 needs:"aggregate" 的插件用（旁路聚合，不阻塞下游）
    if (deps.pluginHost.streamSide().length > 0) {
      state.aggregated = aggregateEvents(out, ctx.request_id);
    }

    ctx.recordStage(this.id, deps.clock.now() - started, `events=${out.length}`);
    deps.metrics.increment("pipeline.stage", 1, { stage: this.id });
  }
}

/** 把事件序列折叠成一个完整 CanonicalResponse（聚合视图）。 */
export function aggregateEvents(
  events: CanonicalStreamEvent[],
  requestId = "",
): CanonicalResponseEnvelope {
  let usage = emptyUsage("provider");
  let finish: FinishReason = "stop";
  const textParts: string[] = [];
  const toolParts: Array<{ id: string; name: string; args: string }> = [];
  let model = "";

  for (const ev of events) {
    switch (ev.type) {
      case "start":
        model = ev.message.model;
        break;
      case "part.delta":
        if (ev.delta.type === "text") textParts.push(ev.delta.text);
        else if (ev.delta.type === "tool_input_json") {
          const last = toolParts[toolParts.length - 1];
          if (last !== undefined) last.args += ev.delta.partial_json;
        }
        break;
      case "part.end": {
        if (ev.part.type === "tool_use") {
          toolParts.push({ id: ev.part.id, name: ev.part.name, args: "" });
        } else if (ev.part.type === "text") {
          textParts.push(ev.part.text);
        }
        break;
      }
      case "usage":
        usage = ev.usage;
        break;
      case "finish":
        usage = ev.usage;
        finish = ev.finish_reason;
        break;
      default:
        break;
    }
  }

  const parts: Part[] = [];
  if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("") });
  for (const t of toolParts) {
    parts.push({ type: "tool_use", id: t.id, name: t.name, input: safeParse(t.args) });
  }

  return {
    ir_version: "ag-ir/1",
    kind: "chat",
    request_id: requestId,
    usage,
    finish_reason: finish,
    payload: { message: { role: "assistant", parts }, ...(model === "" ? {} : { model }) },
    warnings: [],
    raw: {},
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
