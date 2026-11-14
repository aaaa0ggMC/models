/**
 * tests/usage-sniffer.test.ts —— fast path 旁路 usage 嗅探器。
 *
 * 锁定 20-pipeline.md §4.2 的三条硬约束：
 *   1. 有字节数上限；**超限时不得把未知 token 记成 0**——标 usage_sniffer_truncated；
 *   2. **必须解析流尾的 usage 事件**（按字节数从流头截断会恰好漏掉 usage）；
 *   3. 解析失败不影响转发。
 * 以及 40 §2.3 的各家 usage 到达方式（OpenAI Chat 末 chunk / Responses response.completed /
 * Anthropic message_start + message_delta 分两次 / Gemini 每 chunk 取最后非空）。
 */

import { describe, expect, it } from "vitest";
import {
  IncrementalUsageSniffer,
  extractUsage,
  parseSseEvents,
  sniffUsageFromSseChunks,
  type UsageSnifferOptions,
} from "../gateway-core/pipeline/usage-sniffer.js";

const opts = (flavor: UsageSnifferOptions["flavor"], max_bytes = 262_144): UsageSnifferOptions => ({
  flavor,
  max_bytes,
});

const openAiChunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    model: "gpt-test-1",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;

const openAiUsageChunk = (): string =>
  `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    model: "gpt-test-1",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 9,
      completion_tokens: 4,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  })}\n\n`;

describe("parseSseEvents", () => {
  it("按 SSE 规范拼接多行 data，忽略 [DONE]", () => {
    const events = parseSseEvents(
      "event: x\ndata: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\":\ndata: 2}\n\n",
    );
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!.data)).toEqual({ a: 1 });
    expect(JSON.parse(events[1]!.data)).toEqual({ b: 2 });
  });

  it("解析失败不影响其他事件", () => {
    const events = parseSseEvents("data: not json\n\ndata: {\"ok\":1}\n\n");
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]!.data)).toEqual({ ok: 1 });
  });
});

describe("OpenAI Chat usage 抽取", () => {
  it("取最后一个非空 usage（末 chunk）", () => {
    const chunks = [openAiChunk({ role: "assistant" }), openAiChunk({ content: "hi" }), openAiUsageChunk()];
    const r = sniffUsageFromSseChunks(chunks, opts("openai_chat"));
    expect(r.empty).toBe(false);
    expect(r.usage.units.tokens).toEqual({
      input_tokens: 9,
      output_tokens: 4,
      total_tokens: 13,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      reasoning_tokens: 1,
    });
    // I4：原始 usage 逐字段保留
    expect(r.usage.raw).toMatchObject({ prompt_tokens: 9 });
  });

  it("增量喂入与批处理结果一致（边收边发不改变语义）", () => {
    const chunks = [openAiChunk({ content: "a" }), openAiChunk({ content: "b" }), openAiUsageChunk()];
    const batch = sniffUsageFromSseChunks(chunks, opts("openai_chat"));
    const sniffer = new IncrementalUsageSniffer(opts("openai_chat"));
    for (const c of chunks) sniffer.push(c);
    const incremental = sniffer.finish();
    expect(incremental.usage).toEqual(batch.usage);
  });

  it("没有 usage 时 units.tokens 键省略（未知≠0），empty=true", () => {
    const r = sniffUsageFromSseChunks([openAiChunk({ content: "hi" })], opts("openai_chat"));
    expect(r.empty).toBe(true);
    expect(r.usage.units.tokens).toBeUndefined();
  });
});

describe("OpenAI Responses usage 抽取", () => {
  it("从 response.completed 事件的 response.usage 取", () => {
    const chunk = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 },
      },
    })}\n\n`;
    const r = sniffUsageFromSseChunks([chunk], opts("openai_responses"));
    expect(r.usage.units.tokens).toMatchObject({ input_tokens: 30, output_tokens: 12, total_tokens: 42 });
  });
});

describe("Anthropic usage 抽取（分两次到达，必须合并）", () => {
  it("message_start 的 input_tokens + message_delta 的 output_tokens 合并", () => {
    const messageStart = `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_1",
        usage: { input_tokens: 25, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
      },
    })}\n\n`;
    const messageDelta = `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 14, cache_creation_input_tokens: 3 },
    })}\n\n`;
    const r = sniffUsageFromSseChunks([messageStart, messageDelta], opts("anthropic"));
    expect(r.usage.units.tokens).toEqual({
      input_tokens: 25,
      output_tokens: 14,
      // 40 §2.2：Anthropic 总输入 = input + cache_creation + cache_read
      total_tokens: 25 + 3 + 5 + 14,
      cache_read_tokens: 5,
      cache_write_tokens: 3,
      reasoning_tokens: 0,
    });
  });

  it("拆成多个 chunk 到达也能合并（真实 SSE 分片）", () => {
    const sniffer = new IncrementalUsageSniffer(opts("anthropic"));
    sniffer.push("event: message_start\ndata: ");
    sniffer.push(`${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10 } } })}\n\n`);
    sniffer.push("event: message_delta\ndata: ");
    sniffer.push(`${JSON.stringify({ type: "message_delta", usage: { output_tokens: 4 } })}\n\n`);
    const r = sniffer.finish();
    expect(r.usage.units.tokens).toMatchObject({ input_tokens: 10, output_tokens: 4 });
  });
});

describe("Gemini usage 抽取", () => {
  it("每 chunk 都可能带 usageMetadata，取最后一次非空", () => {
    const mk = (prompt: number): string =>
      `data: ${JSON.stringify({ candidates: [], usageMetadata: { promptTokenCount: prompt } })}\n\n`;
    const r = sniffUsageFromSseChunks([mk(10), mk(20), mk(30)], opts("gemini"));
    expect(r.usage.units.tokens?.input_tokens).toBe(30);
  });
});

describe("硬约束：超限标 truncated 而不记 0", () => {
  it("超过 max_bytes 时 truncated=true，且不把未知 token 记成 0", () => {
    const big = openAiChunk({ content: "x".repeat(500) });
    const r = sniffUsageFromSseChunks([big, openAiUsageChunk()], opts("openai_chat", 100));
    expect(r.truncated).toBe(true);
    // 关键：没有 usage 时 units.tokens 必须**省略**，不能是 0
    expect(r.usage.units.tokens).toBeUndefined();
    expect(r.empty).toBe(true);
  });

  it("未超限时 truncated=false", () => {
    const r = sniffUsageFromSseChunks([openAiUsageChunk()], opts("openai_chat", 1000));
    expect(r.truncated).toBe(false);
  });

  it("增量喂入超限后停止解析", () => {
    const sniffer = new IncrementalUsageSniffer(opts("openai_chat", 50));
    expect(sniffer.push("x".repeat(100))).toBe(false);
    expect(sniffer.finish().truncated).toBe(true);
  });
});

describe("extractUsage 单次调用", () => {
  it("generic flavor 返回空 units（不猜）", () => {
    const u = extractUsage("data: {}\n\n", "generic");
    expect(u.units).toEqual({});
  });

  it("解析失败返回空 units 而不抛（不影响转发）", () => {
    const u = extractUsage("data: not json at all\n\n", "openai_chat");
    expect(u.units).toEqual({});
  });
});
