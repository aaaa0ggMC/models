/**
 * gateway-core/pipeline/stages/s8-client-encode.ts —— S8 ClientEncode。
 *
 * 职责（20 §S8）：canonical → 客户端格式字节；fast path 时直通。
 *
 * 关键约束（20 §S8）：**一旦向客户端写出第一个字节，就不能再改变 HTTP 状态码**；
 * 因此所有错误都必须在首字节前转成 200 + SSE `error` 事件或直接非 2xx。
 *
 * fast path（D-fastpath-1）：上游原始字节直接转发给客户端，网关不改写。
 */

import type { PipelineDeps, PipelineState, Stage } from "../types.js";
import type { CanonicalStreamEvent, StreamFrame } from "../../../ir/index.js";
import { AG_FRAME_EVENT_NAME, emptyUsage } from "../../../ir/index.js";

export class S8ClientEncode implements Stage {
  readonly id = "S8";
  readonly name = "ClientEncode";

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const streaming = state.shallow?.stream === true;
    const clientAdaptor = state.clientAdaptor;
    if (clientAdaptor === undefined) throw new Error("S8 需要 S1 的客户端 adaptor");

    if (streaming) {
      deps.sink.start(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-request-id": ctx.request_id,
      });
      state.bytes_written = true;

      if (ctx.fast_path) {
        // fast path：**边收边发**。上游 SSE 字节不落 canonical、不改写，直接转发给客户端；
        // 同时旁路喂给 S6 布防的嗅探器（D-fastpath-1 + 20 §4.2 流式 fast path）。
        const sniffer = state.sniffer;
        const upstreamChunks = state.upstream?.chunks;
        if (upstreamChunks !== undefined) {
          for await (const chunk of upstreamChunks) {
            if (deps.sink.closed) {
              // 客户端断开：立刻停止读上游（25 §6 第 3 条止损）
              break;
            }
            const text = chunk.toString("utf8");
            deps.sink.write(text);
            sniffer?.push(text);
          }
        }
        if (sniffer !== undefined) {
          const sniffed = sniffer.finish();
          state.usage = sniffed.usage;
          if (sniffed.truncated) ctx.warn("usage_sniffer_truncated");
          if (sniffed.empty) ctx.warn("usage_missing");
        }
        ctx.recordStage(this.id, deps.clock.now() - started, "fast_path:passthrough");
        deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "fast_path" });
        return;
      }

      // 慢路径：把 CanonicalStreamEvent 编码成客户端格式的 SSE 事件序列
      const events = state.stream_events ?? [];
      for (const ev of events) {
        const frames = clientAdaptor.encodeStream(singleFrameStream(ev, ctx.request_id), ctx);
        for await (const wire of frames) {
          deps.sink.write(serializeWireEvent(wire));
        }
      }
      ctx.recordStage(this.id, deps.clock.now() - started, `slow:events=${events.length}`);
      deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "slow" });
      return;
    }

    // 非流式
    if (ctx.fast_path) {
      const raw = state.upstream?.body?.toString("utf8") ?? "{}";
      deps.sink.start(state.upstream_status ?? 200, {
        "content-type": "application/json",
        "x-request-id": ctx.request_id,
      });
      deps.sink.write(raw);
      state.bytes_written = true;
      ctx.recordStage(this.id, deps.clock.now() - started, "fast_path:passthrough");
      deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "fast_path" });
      return;
    }

    const response = state.final_response ?? state.response;
    if (response === undefined) throw new Error("S8 需要 S6/S9 的响应信封");
    const body = clientAdaptor.encodeResponse(response, ctx);
    const status = response.finish_reason === "error" ? 200 : 200;
    deps.sink.start(status, {
      "content-type": "application/json",
      "x-request-id": ctx.request_id,
    });
    deps.sink.write(JSON.stringify(body));
    state.bytes_written = true;
    ctx.recordStage(this.id, deps.clock.now() - started, "slow:encodeResponse");
    deps.metrics.increment("pipeline.stage", 1, { stage: this.id, mode: "slow" });
  }
}

async function* singleFrameStream(
  ev: CanonicalStreamEvent,
  requestId: string,
): AsyncIterable<StreamFrame> {
  yield {
    event:
      ev.type === "part.begin" || ev.type === "part.delta" || ev.type === "part.end"
        ? "delta"
        : ev.type === "finish"
          ? "end"
          : ev.type === "error"
            ? "error"
            : ev.type === "usage"
              ? "usage"
              : "start",
    seq: 0,
    request_id: requestId,
    kind: "chat",
    data: eventToFrameData(ev),
    ts: Date.now(),
  };
}

function eventToFrameData(
  ev: import("../../../ir/index.js").CanonicalStreamEvent,
): import("../../../ir/index.js").FrameData {
  switch (ev.type) {
    case "start":
      return { model: ev.message.model, client_format: "openai.chat", provider_format: "openai.chat" };
    case "part.delta":
      if (ev.delta.type === "text") return { kind: "chat", text: ev.delta.text };
      if (ev.delta.type === "thinking") return { kind: "chat", thinking: ev.delta.thinking };
      if (ev.delta.type === "tool_input_json") {
        return { kind: "chat", tool_input_json: ev.delta.partial_json };
      }
      return { kind: "chat", refusal: ev.delta.refusal };
    case "part.begin":
    case "part.end":
      return { kind: "chat", text: "" };
    case "usage":
      return { usage: ev.usage };
    case "finish":
      return { finish_reason: ev.finish_reason, usage: ev.usage ?? emptyUsage("provider") };
    case "error":
      return { error: ev.error, fatal: true };
  }
}

/** codec 的 encodeStream 产出的是 wire 侧事件；这里统一包成 SSE 文本。 */
function serializeWireEvent(wire: unknown): string {
  if (typeof wire === "string") return wire;
  const frame = wire as { event?: string; data?: unknown };
  if (frame.event !== undefined) {
    return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
  }
  return `event: ${AG_FRAME_EVENT_NAME}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
