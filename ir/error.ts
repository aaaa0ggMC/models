/**
 * ir/error.ts —— canonical 错误模型与归一化 finish_reason。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §7.1 / §7.2（错误模型与到客户端格式的映射），
 * finish_reason 归一表见 docs/design/10-canonical-schema.md §9.3。
 *
 * 两条硬约束（10 §9.3 注意 2、注意 3）：
 *   1. 映射表未命中时**不得默认 `stop`**，必须落到 `other` 并保留原文；
 *   2. finish_reason 必须**双向可逆**——归一值用于 canonical，原文进 `raw`。
 */

/** 归一化完成原因。是四家枚举的**超集**，不是交集（10 §9.3 注意 1）。 */
export type NormalizedFinishReason =
  | 'stop'
  | 'length'
  | 'tool_use'
  | 'content_filter'
  | 'stop_sequence'
  | 'error'
  | 'pause_turn'
  | 'recitation'
  | 'context_exceeded'
  | 'missing_thought_signature'
  | 'other';

/** 流式结束帧用的哨兵值：ASR 等"自然结束"语义（25-streaming.md §2.1 EndData）。 */
export type FinalFinishReason = 'final';

export type FinishReason = NormalizedFinishReason | FinalFinishReason;

export type CanonicalErrorCode =
  | 'unsupported_format'
  | 'canonical_decode_error'
  | 'canonical_encode_error'
  | 'auth_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'no_available_provider'
  | 'provider_unavailable'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'content_filtered'
  | 'capability_unsupported'
  | 'context_length_exceeded'
  | 'agentic_loop_exceeded'
  | 'plugin_error'
  | 'streaming_mode_unsupported'
  | 'internal_error';

/** 机器可读的能力拒绝标记（20 §7.3 末尾约定，agentgateway 已验证的约定）。 */
export type CapabilityRejection = 'prompt_too_long';

export interface CanonicalError {
  code: CanonicalErrorCode;
  /** 面向客户端、可安全展示的信息（不得含上游内部细节）。 */
  message: string;
  /** 上游原始错误码（对账用）。 */
  provider_code?: string;
  /** 建议返回给客户端的状态码。 */
  http_status: number;
  retryable: boolean;
  /** 解码/校验错误的字段定位。 */
  field_path?: string;
  request_id: string;
  /**
   * 上游错误体原文。仅内部日志/调试用，**默认不回给客户端**
   * （20 §7.2：避免泄漏内部 provider 名/内网地址；透传受 debug_mode 开关控制）。
   */
  raw?: unknown;
  /** 仅当上游因上下文超限而 400 时打上，让客户端能触发压缩重试。 */
  capability_rejected?: CapabilityRejection;
}

/** 构造一个带默认值的 CanonicalError，避免各处重复写字面量。 */
export function createCanonicalError(
  code: CanonicalErrorCode,
  message: string,
  requestId: string,
  overrides: Partial<Omit<CanonicalError, 'code' | 'message' | 'request_id'>> = {},
): CanonicalError {
  const defaults: Record<CanonicalErrorCode, { http_status: number; retryable: boolean }> = {
    unsupported_format: { http_status: 400, retryable: false },
    canonical_decode_error: { http_status: 400, retryable: false },
    canonical_encode_error: { http_status: 500, retryable: false },
    auth_failed: { http_status: 401, retryable: false },
    rate_limited: { http_status: 429, retryable: true },
    quota_exceeded: { http_status: 429, retryable: false },
    no_available_provider: { http_status: 503, retryable: true },
    provider_unavailable: { http_status: 503, retryable: true },
    upstream_timeout: { http_status: 504, retryable: true },
    upstream_error: { http_status: 502, retryable: true },
    content_filtered: { http_status: 400, retryable: false },
    capability_unsupported: { http_status: 400, retryable: false },
    context_length_exceeded: { http_status: 400, retryable: false },
    agentic_loop_exceeded: { http_status: 500, retryable: false },
    plugin_error: { http_status: 500, retryable: false },
    streaming_mode_unsupported: { http_status: 400, retryable: false },
    internal_error: { http_status: 500, retryable: false },
  };
  const base = defaults[code];
  return {
    code,
    message,
    request_id: requestId,
    http_status: overrides.http_status ?? base.http_status,
    retryable: overrides.retryable ?? base.retryable,
    ...overrides,
  };
}
