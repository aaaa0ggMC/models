/**
 * gateway-core/pipeline/usage-sniffer.ts —— fast path 旁路 usage 嗅探器。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §4.2「流式 fast path」小节。
 *
 * 流式 fast path 下上游 SSE 字节**不落 canonical、不改写**，直接转发给客户端；
 * 同时旁路一个嗅探器只解析 SSE 中的 usage 相关字段喂给 S10。
 *
 * 三条硬约束（20 §4.2 原文）：
 *   1. 有字节数上限（默认 256KB/请求）与时间上限；**超限时不得把未知 token 记成 0**——
 *      对应键省略，并置 warnings += "usage_sniffer_truncated"；
 *   2. **必须解析流尾的 usage 事件**——按字节数从流头截断会恰好漏掉 usage。因此嗅探器
 *      要么保证覆盖到流尾，要么明确标 usage_sniffer_truncated 并让双路计量兜底；
 *   3. 解析失败不影响转发。
 *
 * 各家 usage 在流里的位置（40 §2.3）：
 *   OpenAI Chat   末 chunk 的 usage（需 stream_options.include_usage，网关在 S4 自动补上）
 *   OpenAI Resp.  response.completed 事件的 response.usage（恒带）
 *   Anthropic     message_start（input_tokens）+ message_delta（output_tokens + cache）分两次，必须合并
 *   Gemini        usageMetadata 每 chunk 都可能带，取最后一次非空
 */

import type { CanonicalUsage, TokenUsage } from "../../ir/index.js";
import { mergeTokenUsage } from "../../ir/index.js";

export interface UsageSnifferResult {
  usage: CanonicalUsage;
  /** 是否因为超限而截断（对应 warnings += "usage_sniffer_truncated"）。 */
  truncated: boolean;
  /** 是否一个 usage 字段都没解析到。 */
  empty: boolean;
}

export interface UsageSnifferOptions {
  max_bytes: number;
  /** 按 provider 形态选择抽取规则。 */
  flavor: "openai_chat" | "openai_responses" | "anthropic" | "gemini" | "generic";
}

/**
 * 增量式 usage 嗅探器。
 *
 * 为什么是增量而不是"收完整流再解析"：fast path 的承诺是**零延迟透传**（20 §4.2）。
 * 若 S6 先把整个流读完再交给 S8，就变成了"等全量再下一步"——正是设计原则 3 明令禁止的。
 * 因此嗅探器做成 `push(chunk) → 立刻可下发` 的形状：S8 每收到一个 chunk，
 * 一边写给客户端，一边喂给嗅探器；两者互不等待。
 *
 * 内存是有界的：只保留每个 chunk 里与 usage 相关的抽取结果，不缓存全文。
 */
export class IncrementalUsageSniffer {
  private bytes = 0;
  private truncated = false;
  private found = 0;

  /** openai_chat / openai_responses：最后一个非空 usage 对象。 */
  private lastOpenAiUsage: Record<string, unknown> | undefined;
  /** anthropic：message_start + message_delta 分两次到达，必须合并。 */
  private anthropicMerged: TokenUsage | undefined;
  private anthropicRaw: Record<string, unknown> | undefined;
  /** gemini：每 chunk 都可能带 usageMetadata，取最后一次非空。 */
  private lastGeminiUsage: Record<string, unknown> | undefined;

  constructor(private readonly opts: UsageSnifferOptions) {}

  /** 喂一个上游 chunk（SSE 文本片段）。返回是否已超限。 */
  push(chunk: string): boolean {
    this.bytes += Buffer.byteLength(chunk, "utf8");
    if (this.bytes > this.opts.max_bytes) {
      // 超限：**不得把未知 token 记成 0**——标 truncated 让双路计量兜底（20 §4.2）
      this.truncated = true;
      return false;
    }
    switch (this.opts.flavor) {
      case "openai_chat":
        this.lastOpenAiUsage = lastUsageFromSse(
          chunk,
          this.lastOpenAiUsage,
          (o) => asRecord(o["usage"]),
        );
        break;
      case "openai_responses":
        this.lastOpenAiUsage = lastUsageFromSse(chunk, this.lastOpenAiUsage, (o) => {
          const r = asRecord(o["response"]);
          return r === undefined ? undefined : asRecord(r["usage"]);
        });
        break;
      case "anthropic":
        for (const u of allUsagesFromSse(chunk)) {
          this.anthropicRaw = u;
          const t = tokenFromAnthropic(u);
          this.anthropicMerged =
            this.anthropicMerged === undefined ? t : mergeTokenUsage(this.anthropicMerged, t);
        }
        break;
      case "gemini":
        this.lastGeminiUsage = lastUsageFromSse(chunk, this.lastGeminiUsage, (o) => asRecord(o["usageMetadata"]));
        break;
      case "generic":
        break;
    }
    return true;
  }

  /** 流结束；产出归一 usage。 */
  finish(): UsageSnifferResult {
    switch (this.opts.flavor) {
      case "openai_chat":
      case "openai_responses": {
        if (this.lastOpenAiUsage === undefined) {
          return { usage: { units: {}, source: "provider" }, truncated: this.truncated, empty: true };
        }
        this.found = 1;
        return {
          usage: {
            units: { tokens: tokenFromOpenAi(this.lastOpenAiUsage) },
            raw: this.lastOpenAiUsage,
            source: "provider",
          },
          truncated: this.truncated,
          empty: false,
        };
      }
      case "anthropic": {
        if (this.anthropicMerged === undefined) {
          return { usage: { units: {}, source: "provider" }, truncated: this.truncated, empty: true };
        }
        this.found = 1;
        return {
          usage: {
            units: { tokens: this.anthropicMerged },
            ...(this.anthropicRaw === undefined ? {} : { raw: this.anthropicRaw }),
            source: "provider",
          },
          truncated: this.truncated,
          empty: false,
        };
      }
      case "gemini": {
        if (this.lastGeminiUsage === undefined) {
          return { usage: { units: {}, source: "provider" }, truncated: this.truncated, empty: true };
        }
        this.found = 1;
        return {
          usage: {
            units: { tokens: tokenFromGemini(this.lastGeminiUsage) },
            raw: this.lastGeminiUsage,
            source: "provider",
          },
          truncated: this.truncated,
          empty: false,
        };
      }
      case "generic":
        return { usage: { units: {}, source: "provider" }, truncated: this.truncated, empty: true };
    }
  }

  /** 是否解析到过任何 usage 字段。 */
  get hasUsage(): boolean {
    return this.found > 0;
  }
}

/** 从一段 SSE 文本里找"最后一个非空"的 usage（按 selector 抽取）。 */
function lastUsageFromSse(
  sseText: string,
  previous: Record<string, unknown> | undefined,
  select: (obj: Record<string, unknown>) => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  let found = previous;
  for (const ev of parseSseEvents(sseText)) {
    const obj = asRecord(jsonOf(ev));
    if (obj === undefined) continue;
    const usage = select(obj);
    if (usage !== undefined) found = usage;
  }
  return found;
}

/** 从一段 SSE 文本里抽出全部 usage 对象（Anthropic 分多次到达时要逐个合并）。 */
function allUsagesFromSse(sseText: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const ev of parseSseEvents(sseText)) {
    const obj = asRecord(jsonOf(ev));
    if (obj === undefined) continue;
    const usage = asRecord(obj["usage"]);
    if (usage !== undefined) out.push(usage);
  }
  return out;
}

/**
 * 从一串 SSE chunk 里抽 usage（批处理接口，非流式场景用）。
 *
 * 注意这里的"覆盖到流尾"实现方式：调用方传入了**完整**的 chunk 序列（流已结束），
 * 因此不存在"从头截断漏掉流尾"的问题；`max_bytes` 只用于防御恶意超长流——
 * 一旦超限就标 truncated 并停止解析，让双路计量兜底。
 */
export function sniffUsageFromSseChunks(
  chunks: string[],
  opts: UsageSnifferOptions,
): UsageSnifferResult {
  const sniffer = new IncrementalUsageSniffer(opts);
  for (const chunk of chunks) {
    if (!sniffer.push(chunk)) break;
  }
  return sniffer.finish();
}

/** 按 flavor 从 SSE 文本里抽 usage。解析失败一律返回空 usage，不影响转发。 */
export function extractUsage(sseText: string, flavor: UsageSnifferOptions["flavor"]): CanonicalUsage {
  try {
    switch (flavor) {
      case "openai_chat":
        return extractOpenAiChat(sseText);
      case "openai_responses":
        return extractOpenAiResponses(sseText);
      case "anthropic":
        return extractAnthropic(sseText);
      case "gemini":
        return extractGemini(sseText);
      case "generic":
        return { units: {}, source: "provider" };
    }
  } catch {
    return { units: {}, source: "provider" };
  }
}

interface SseEvent {
  event?: string;
  data: string;
}

/** 解析 SSE 文本为事件列表（`data:` 多行拼接；`[DONE]` 忽略）。 */
export function parseSseEvents(sseText: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of sseText.split(/\n\n/)) {
    if (block.trim() === "") continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") continue;
    out.push({ ...(event === undefined ? {} : { event }), data });
  }
  return out;
}

function jsonOf(ev: SseEvent): unknown {
  try {
    return JSON.parse(ev.data);
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** OpenAI Chat：末 chunk 的 usage。 */
function extractOpenAiChat(sseText: string): CanonicalUsage {
  let found: Record<string, unknown> | undefined;
  for (const ev of parseSseEvents(sseText)) {
    const obj = asRecord(jsonOf(ev));
    const usage = obj === undefined ? undefined : asRecord(obj["usage"]);
    if (usage !== undefined) found = usage; // 取最后一个非空
  }
  if (found === undefined) return { units: {}, source: "provider" };
  return {
    units: { tokens: tokenFromOpenAi(found) },
    raw: found,
    source: "provider",
  };
}

/** OpenAI Responses：`response.completed` 事件的 response.usage（恒带）。 */
function extractOpenAiResponses(sseText: string): CanonicalUsage {
  let found: Record<string, unknown> | undefined;
  for (const ev of parseSseEvents(sseText)) {
    if (ev.event !== undefined && ev.event !== "response.completed") continue;
    const obj = asRecord(jsonOf(ev));
    const response = obj === undefined ? undefined : asRecord(obj["response"]);
    const usage = response === undefined ? undefined : asRecord(response["usage"]);
    if (usage !== undefined) found = usage;
  }
  if (found === undefined) return { units: {}, source: "provider" };
  return {
    units: { tokens: tokenFromOpenAi(found) },
    raw: found,
    source: "provider",
  };
}

/** Anthropic：message_start（input_tokens）+ message_delta（output_tokens + cache）分两次到达，必须合并。 */
function extractAnthropic(sseText: string): CanonicalUsage {
  let merged: TokenUsage | undefined;
  let raw: Record<string, unknown> | undefined;
  for (const ev of parseSseEvents(sseText)) {
    const obj = asRecord(jsonOf(ev));
    if (obj === undefined) continue;
    const usage = asRecord(obj["usage"]);
    if (usage === undefined) continue;
    raw = usage;
    const t = tokenFromAnthropic(usage);
    merged = merged === undefined ? t : mergeTokenUsage(merged, t);
  }
  if (merged === undefined) return { units: {}, source: "provider" };
  return {
    units: { tokens: merged },
    ...(raw === undefined ? {} : { raw }),
    source: "provider",
  };
}

/** Gemini：usageMetadata 每 chunk 都可能带，取最后一次非空。 */
function extractGemini(sseText: string): CanonicalUsage {
  let found: Record<string, unknown> | undefined;
  for (const ev of parseSseEvents(sseText)) {
    const obj = asRecord(jsonOf(ev));
    if (obj === undefined) continue;
    const usage = asRecord(obj["usageMetadata"]);
    if (usage !== undefined) found = usage;
  }
  if (found === undefined) return { units: {}, source: "provider" };
  return {
    units: { tokens: tokenFromGemini(found) },
    raw: found,
    source: "provider",
  };
}

function tokenFromOpenAi(u: Record<string, unknown>): TokenUsage {
  const prompt = num(u["prompt_tokens"]) ?? num(u["input_tokens"]) ?? 0;
  const completion = num(u["completion_tokens"]) ?? num(u["output_tokens"]) ?? 0;
  const promptDetails = asRecord(u["prompt_tokens_details"]) ?? asRecord(u["input_tokens_details"]);
  const completionDetails =
    asRecord(u["completion_tokens_details"]) ?? asRecord(u["output_tokens_details"]);
  const cacheRead = num(promptDetails?.["cached_tokens"]) ?? 0;
  const cacheWrite = num(promptDetails?.["cache_write_tokens"]) ?? 0;
  const reasoning = num(completionDetails?.["reasoning_tokens"]) ?? 0;
  const total = num(u["total_tokens"]) ?? prompt + completion;
  return {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: total,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
  };
}

function tokenFromAnthropic(u: Record<string, unknown>): TokenUsage {
  const input = num(u["input_tokens"]) ?? 0;
  const output = num(u["output_tokens"]) ?? 0;
  const cacheRead = num(u["cache_read_input_tokens"]) ?? 0;
  const cacheWrite = num(u["cache_creation_input_tokens"]) ?? 0;
  const outputDetails = asRecord(u["output_tokens_details"]);
  const reasoning = num(outputDetails?.["thinking_tokens"]) ?? 0;
  // 40 §2.2：Anthropic 的总输入 = input + cache_creation + cache_read（官方口径）
  const total = num(u["total_tokens"]) ?? input + cacheWrite + cacheRead + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
  };
}

function tokenFromGemini(u: Record<string, unknown>): TokenUsage {
  const prompt = num(u["promptTokenCount"]) ?? 0;
  const candidates = num(u["candidatesTokenCount"]) ?? 0;
  const cacheRead = num(u["cachedContentTokenCount"]) ?? 0;
  const thoughts = num(u["thoughtsTokenCount"]) ?? 0;
  const total = num(u["totalTokenCount"]) ?? prompt + candidates;
  return {
    input_tokens: prompt,
    output_tokens: candidates,
    total_tokens: total,
    cache_read_tokens: cacheRead,
    cache_write_tokens: 0,
    reasoning_tokens: thoughts,
  };
}
