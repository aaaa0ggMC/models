/**
 * ir/usage.ts —— 多单位 usage。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §6（含 §6.1 的 6 条规则），
 * 归一规则与口径表见 docs/design/40-provider-adaptors.md §2。
 *
 * 两条不可违背的规则：
 *   R2 「未知」绝不用 0 表示——上游没给 usage 时对应键**省略**，并置 warnings += "usage_missing"；
 *   R5 「免费」与「未知」必须可区分——"输出免费"记真实值 + pricing_state.output = "free"，
 *      不是把 output_tokens 置 0。
 */

/** 各细分的计价状态。缺省视为 "billed"。 */
export type PricingState = "billed" | "free" | "included" | "unpriced";

export type PricingSlot = "input" | "output" | "cache_read" | "cache_write" | "reasoning";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /** 其他细分，透传保留（如 cache_write_ttl_5m / cache_write_ttl_1h）。 */
  details?: Record<string, number>;
  /**
   * 各细分的计价状态，用于表达"输入计费、输出免费"这类厂商差异。
   * 注意：**缺省视为 "billed"**，因此"未定价"必须显式写 "unpriced"。
   */
  pricing_state?: Record<PricingSlot, PricingState>;
}

export interface UsageUnits {
  /** 按 token 计的模态（chat / embedding / rerank / image(gpt-image-1) / decision）。 */
  tokens?: TokenUsage;
  /** decision：按问题数（部分上游按次计费或输出免费时的计量兜底）。 */
  questions?: { asked: number; answered: number };
  /** TTS：按字符。 */
  characters?: { input: number; billed: number };
  /** ASR / TTS：按音频时长。 */
  audio_seconds?: { input: number; billed: number };
  /** ASR：按音频字节。 */
  audio_bytes?: number;
  /** Image：按张。 */
  images?: { generated: number; edited: number };
  /** 通用：请求次数（按次计费的内置工具）。 */
  requests?: number;
  /** 压缩成本（不计入用户请求，见 30-plugin-api.md §4.4）。 */
  compaction_tokens?: TokenUsage;
}

/** usage 的来源。 */
export type UsageSource = "provider" | "provider_floor" | "estimated";

export type UsagePrecision = "exact" | "approx" | "low";

export interface CanonicalUsage {
  /** 各计量单位，未用到的单位**省略**（不是 0）。 */
  units: UsageUnits;

  /** 上游自报的费用提示（如 OpenRouter usage.cost）。网关自己不算钱（决策 D5）。 */
  cost_hint?: { amount: number; currency: string; source: string };

  /** provider 原始 usage，逐字段保留，用于对账（40 §1.4 token 双轨）。 */
  raw?: Record<string, unknown>;

  source: UsageSource;
  /** 估算精度（source === "estimated" 时）。 */
  precision?: UsagePrecision;
}

/** 构造一个"完全未知"的 usage：units 为空对象 + source estimated。 */
export function emptyUsage(source: UsageSource = "provider"): CanonicalUsage {
  return { units: {}, source };
}

/** 全零的 token 计量。仅在上游**明确**给了 0 时使用，不得用于表示未知。 */
export function zeroTokenUsage(): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
  };
}

/** usage 合并（流式分片累加 / message_start + message_delta 合并）。 */
export function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const details: Record<string, number> = { ...(a.details ?? {}) };
  for (const [k, v] of Object.entries(b.details ?? {})) {
    details[k] = (details[k] ?? 0) + v;
  }
  const merged: TokenUsage = {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
  if (a.pricing_state !== undefined || b.pricing_state !== undefined) {
    // pricing_state 是"属性"不是"数量"，后到者覆盖（b 优先）。
    merged.pricing_state = { ...(a.pricing_state ?? {}), ...(b.pricing_state ?? {}) } as TokenUsage["pricing_state"];
  }
  return merged;
}
