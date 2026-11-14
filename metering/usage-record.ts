/**
 * metering/usage-record.ts —— UsageRecord 数据模型。
 *
 * 唯一事实来源：docs/design/60-billing-and-dogfooding.md §3（数据模型）、
 * §4（规范化规则）、§4.1（定价）。
 *
 * 三条硬约束：
 *   1. **统计管道与主链路物理分离**：主链路只负责往队列里扔一条 UsageRecord；
 *      管道挂了不影响任何用户请求（60 §1）；
 *   2. **绝不进入 UsageRecord 的字段**（60 §3 原文）：`Authorization` / `x-api-key` /
 *      `x-goog-api-key` 等任何 header 原值、provider base_url 中的凭据、客户端 IP
 *      （默认不记，可配 `log_client_ip`）；
 *   3. 规范化与原始值都留：`usage`（归一，用于横向对比/计费）+ `usage_raw`（对账）。
 */

import type {
  CanonicalErrorCode,
  CanonicalUsage,
  FinishReason,
  FormatId,
  NormalizedFinishReason,
} from "../ir/index.js";

export type UsageRecordStatus = "success" | "error" | "short_circuit";

export interface ToolCallUsage {
  name: string;
  ok: boolean;
  duration_ms: number;
}

export interface BuiltinToolUsage {
  name: string;
  count: number;
  backend?: string;
}

export interface UsageCostBreakdown {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  builtin_tools: number;
  external: number;
  total: number;
}

/** 控制面判断成本（decision 子请求）。与 compaction 同级，**不计入用户 input_tokens**。 */
export interface ControlPlaneCost {
  requests: number;
  questions: number;
  input_tokens: number;
  output_tokens: number;
  /** 输出是否免费（decision 的典型定价形态）。 */
  output_free: boolean;
  cash_micros: number;
  calibration: "native" | "degraded" | "skipped";
}

export interface DegradationEvent {
  from: string;
  to: string;
  reason: string;
  ts: number;
}

export interface CostCaliber {
  /** 实际现金成本（订阅路径记 0）。 */
  cash_micros: number;
  /** 订阅摊销。 */
  subscription_amortized_micros?: number;
  /** 是否走了降级路径。 */
  degraded: boolean;
  /** 原 access path。 */
  degraded_from?: string;
}

export interface UsageRecord {
  // ---- 标识 ----
  request_id: string;
  trace_id?: string;
  /** epoch ms（UTC）。 */
  ts: number;
  // ---- 主体 ----
  /** 不含明文 key。 */
  auth: { key_id: string; team_id?: string; user_id?: string };
  client_format: FormatId;
  provider: string;
  provider_format: FormatId;
  /** provider 侧真实 model id。 */
  model: string;
  model_alias?: string;
  fast_path: boolean;
  attempts: number;
  // ---- 规范 usage ----
  usage: CanonicalUsage;
  /** provider 原始 usage，逐字段保留（40 §1.4 token 双轨）。 */
  usage_raw?: Record<string, unknown>;
  // ---- 衍生 ----
  finish_reason: FinishReason;
  stream: boolean;
  ttfb_ms: number;
  total_ms: number;
  tool_calls: ToolCallUsage[];
  agentic_turns: number;
  builtin_tool_usage: BuiltinToolUsage[];
  compaction?: { removed_tokens: number; kept_tokens: number; cost_tokens?: number };
  control_plane_cost?: ControlPlaneCost;
  external_cost: Array<{ kind: string; units: number; unit_cost: number }>;
  /** 网关侧计算的费用（USD）。Phase 1 恒 0——定价表在 Phase 2（60 §4.1）。 */
  cost: UsageCostBreakdown;
  cost_caliber?: CostCaliber;
  degradation?: DegradationEvent[];
  // ---- 质量/异常 ----
  status: UsageRecordStatus;
  error_code?: CanonicalErrorCode;
  warnings: string[];
  dropped_capabilities: string[];
  // ---- 外链 ----
  /** 指向 Tier-2 加密内容的 id（仅 persistence.messages=on；Phase 1 恒 undefined）。 */
  body_ref?: string;
  // ---- 脱敏标记 ----
  redaction_profile: string;
}

/** 全零的费用拆分（Phase 1 未接定价表）。 */
export function zeroCost(): UsageCostBreakdown {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    builtin_tools: 0,
    external: 0,
    total: 0,
  };
}

export interface UsageRecordInit {
  request_id: string;
  ts: number;
  auth: { key_id: string; team_id?: string; user_id?: string };
  client_format: FormatId;
  provider: string;
  provider_format: FormatId;
  model: string;
  model_alias?: string;
  fast_path: boolean;
  attempts: number;
  stream: boolean;
  ttfb_ms: number;
  total_ms: number;
  status: UsageRecordStatus;
  finish_reason?: FinishReason;
  usage?: CanonicalUsage;
  usage_raw?: Record<string, unknown>;
  warnings?: string[];
  dropped_capabilities?: string[];
  error_code?: CanonicalErrorCode;
  tool_calls?: ToolCallUsage[];
  agentic_turns?: number;
  trace_id?: string;
}

/** 构造一条 UsageRecord；可选字段缺省省略而不是填 0（同 usage 规则 2 的立场）。 */
export function createUsageRecord(init: UsageRecordInit): UsageRecord {
  return {
    request_id: init.request_id,
    ...(init.trace_id === undefined ? {} : { trace_id: init.trace_id }),
    ts: init.ts,
    auth: init.auth,
    client_format: init.client_format,
    provider: init.provider,
    provider_format: init.provider_format,
    model: init.model,
    ...(init.model_alias === undefined ? {} : { model_alias: init.model_alias }),
    fast_path: init.fast_path,
    attempts: init.attempts,
    usage: init.usage ?? { units: {}, source: "provider" },
    ...(init.usage_raw === undefined ? {} : { usage_raw: init.usage_raw }),
    finish_reason: init.finish_reason ?? (init.status === "error" ? "error" : "stop"),
    stream: init.stream,
    ttfb_ms: init.ttfb_ms,
    total_ms: init.total_ms,
    tool_calls: init.tool_calls ?? [],
    agentic_turns: init.agentic_turns ?? 0,
    builtin_tool_usage: [],
    external_cost: [],
    cost: zeroCost(),
    status: init.status,
    ...(init.error_code === undefined ? {} : { error_code: init.error_code }),
    warnings: init.warnings ?? [],
    dropped_capabilities: init.dropped_capabilities ?? [],
    // Phase 1：persistence.messages 默认 off（70 §2），因此 body_ref 恒不出现
    redaction_profile: "phase1-none",
  };
}

/** 归一化 finish_reason 的窄化辅助（UsageRecord 用的是 FinishReason 超集）。 */
export function asNormalizedFinishReason(r: FinishReason): NormalizedFinishReason {
  return r === "final" ? "stop" : r;
}
