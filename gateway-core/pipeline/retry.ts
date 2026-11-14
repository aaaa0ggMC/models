/**
 * gateway-core/pipeline/retry.ts —— 重试 / fallback 决策矩阵。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §7.3。
 *
 * 关键约束（20 §S5）：
 *   - 流式下上游 SSE 一旦开始出字节，就不再 fallback（无法回退已发出的字节）；
 *     因此 fallback 决策点前移到"收到响应头"这一刻；
 *   - 同 attempt 内最多 max_retries（默认 2）次，指数退避 + jitter；
 *   - 不跟随 redirect（3xx 作为 provider error）。
 */

import type { CanonicalError, CanonicalErrorCode } from '../../ir/index.js';

/** 20 §7.3 的决策矩阵，逐行落地。 */
const MATRIX: Record<string, { same_attempt: boolean; fallback: boolean; note: string }> = {
  // 连接失败 / DNS
  connection_failed: { same_attempt: true, fallback: true, note: '网络错误' },
  // 429
  '429': { same_attempt: true, fallback: true, note: '遵守 retry-after' },
  // 500 / 502 / 503
  '500': { same_attempt: true, fallback: true, note: '' },
  '502': { same_attempt: true, fallback: true, note: '' },
  '503': { same_attempt: true, fallback: true, note: '' },
  // Anthropic overloaded_error
  overloaded_error: { same_attempt: true, fallback: true, note: '' },
  // 超时（TTFB）
  ttfb_timeout: { same_attempt: true, fallback: true, note: '' },
  // 流式中途断开
  stream_broken: { same_attempt: false, fallback: false, note: '已出字节，不可回退' },
  // 400 参数错误
  '400': { same_attempt: false, fallback: false, note: '重试无意义，直接映射为客户端 400' },
  // 401 / 403
  '401': { same_attempt: false, fallback: true, note: '换 key/provider 可能恢复' },
  '403': { same_attempt: false, fallback: true, note: '换 key/provider 可能恢复' },
  // context_length_exceeded
  context_length_exceeded: { same_attempt: false, fallback: true, note: '换更大上下文的 provider' },
  // content_filtered
  content_filtered: { same_attempt: false, fallback: true, note: '可配置' },
};

export interface RetryDecision {
  /** 同 attempt 内是否重试。 */
  same_attempt: boolean;
  /** 是否 fallback 到下个 attempt。 */
  fallback: boolean;
  note?: string;
}

/**
 * 判定一次上游失败该重试还是该 fallback。
 *
 * @param signal 上游表现信号：HTTP 状态码字符串、provider 错误码、或语义标签
 *               （connection_failed / ttfb_timeout / stream_broken）。
 * @param alreadyRetried 同 attempt 内已重试次数。
 * @param maxRetries 同 attempt 内最大重试次数（默认 2）。
 */
export function decideRetry(
  signal: string,
  alreadyRetried: number,
  maxRetries: number,
): RetryDecision {
  const row = MATRIX[signal];
  if (row === undefined) {
    // 未登记的信号：保守处理——不重试（避免对未知错误放大流量），允许 fallback。
    return { same_attempt: false, fallback: true, note: `未登记的上游信号: ${signal}` };
  }
  return {
    same_attempt: row.same_attempt && alreadyRetried < maxRetries,
    fallback: row.fallback,
    ...(row.note === '' ? {} : { note: row.note }),
  };
}

/** 从 CanonicalError 反推上游信号（fallback 到 attempt 计划下一个时用）。 */
export function signalFromError(err: CanonicalError): string {
  if (err.provider_code !== undefined && MATRIX[err.provider_code] !== undefined) {
    return err.provider_code;
  }
  if (MATRIX[err.code] !== undefined) return err.code;
  if (err.http_status >= 500) return String(err.http_status);
  if (err.http_status === 429) return '429';
  if (err.http_status === 400) return '400';
  if (err.http_status === 401 || err.http_status === 403) return String(err.http_status);
  return `unknown:${err.code}`;
}

/** 指数退避 + jitter（20 §S5）。 */
export function backoffDelayMs(attempt: number, baseMs: number, jitter = 0.2): number {
  const exponential = baseMs * 2 ** attempt;
  const jitterRange = exponential * jitter;
  const jittered = exponential + (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(jittered));
}

/** 重试计划：把 attempt_plan 展开成"带重试次数"的执行序列。 */
export interface RetryPlan {
  attempts: Array<{ index: number; retries_left: number }>;
}

export function buildRetryPlan(attemptCount: number, maxRetries: number): RetryPlan {
  return {
    attempts: Array.from({ length: attemptCount }, (_, i) => ({
      index: i,
      retries_left: maxRetries,
    })),
  };
}

/** `capability_rejected` 约定（20 §7.3 末尾）：只对 HTTP 400 + 明确的上下文超限语义加。 */
export function maybeMarkPromptTooLong(err: CanonicalError, upstreamBody: string): CanonicalError {
  if (err.http_status !== 400) return err;
  const looksLikeContextWindow =
    /context.{0,20}(window|length|exceed)|prompt is too long|maximum context|too many tokens/i.test(
      upstreamBody,
    );
  if (!looksLikeContextWindow) return err;
  return { ...err, capability_rejected: 'prompt_too_long' };
}

/** 常见错误码 → canonical 错误码（S5 用）。 */
export function canonicalCodeFromStatus(status: number, providerCode?: string): CanonicalErrorCode {
  if (providerCode === 'overloaded_error') return 'provider_unavailable';
  switch (status) {
    case 400:
      return 'capability_unsupported';
    case 401:
    case 403:
      return 'auth_failed';
    // 402 = 余额不足（DeepSeek 官方错误码表「402 - Insufficient Balance」，
    // https://api-docs.deepseek.com/quick_start/error_codes ）。单独映射而不是落进
    // upstream_error：计费类失败要让 UsageRecord.error_code 可统计，并让客户端面的
    // OpenAI 错误体落到 insufficient_quota（40 §2.1 反向表）。
    case 402:
      return 'quota_exceeded';
    case 429:
      return 'rate_limited';
    case 408:
    case 504:
      return 'upstream_timeout';
    default:
      return status >= 500 ? 'provider_unavailable' : 'upstream_error';
  }
}
