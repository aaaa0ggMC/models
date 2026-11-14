/**
 * ir/trace.ts —— 可观测性：RequestTrace 与阶段指标。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §8。
 * RequestTrace 是 dog-fooding agent 的主要数据面之一（60-billing-and-dogfooding.md §6）。
 */

import type { FormatId } from "./format.js";
import type { NormalizedFinishReason } from "./error.js";
import type { CanonicalUsage } from "./usage.js";

export interface StageMetric {
  stage: string;
  /** 耗时（ms）。 */
  duration_ms: number;
  /** 该阶段的 payload 大小（字节）。 */
  bytes?: number;
  /** 该阶段附注（如 "fast_path" / "lazy_materialize"）。 */
  note?: string;
}

export interface AttemptRecord {
  provider: string;
  model: string;
  status: number;
  ttfb_ms: number;
  total_ms: number;
  error?: string;
}

export interface PluginLogEntry {
  name: string;
  duration_ms: number;
  action: string;
  error?: string;
}

export interface ToolCallRecord {
  name: string;
  duration_ms: number;
  ok: boolean;
}

export interface RequestTrace {
  request_id: string;
  client_format: FormatId;
  provider_format: FormatId;
  fast_path: boolean;
  attempts: AttemptRecord[];
  stages: StageMetric[];
  usage: CanonicalUsage;
  finish_reason: NormalizedFinishReason;
  plugin_log: PluginLogEntry[];
  dropped_capabilities: string[];
  warnings: string[];
  /** 实际走过的转换链（如 ["openai.chat","anthropic.messages"]），20 §S4。 */
  conversion_chain: string[];
  turn_count: number;
  tool_calls: ToolCallRecord[];
}

export function createRequestTrace(
  requestId: string,
  clientFormat: FormatId,
  providerFormat: FormatId,
): RequestTrace {
  return {
    request_id: requestId,
    client_format: clientFormat,
    provider_format: providerFormat,
    fast_path: false,
    attempts: [],
    stages: [],
    usage: { units: {}, source: "provider" },
    finish_reason: "stop",
    plugin_log: [],
    dropped_capabilities: [],
    warnings: [],
    conversion_chain: [],
    turn_count: 0,
    tool_calls: [],
  };
}
