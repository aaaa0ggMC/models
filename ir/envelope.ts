/**
 * ir/envelope.ts —— 共享信封 + raw passthrough。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §2（信封）、§7（raw passthrough 两级结构）。
 *
 * 三条硬约束：
 *   D3  raw passthrough 分两级——节点级 `_raw` + 顶层级 `raw.unmapped`，二者共同保证可逆；
 *   D6  `ir_version` 必填，v1 = "ag-ir/1"；新增模态走注册表，不新增顶层字段；
 *   §7.2 回写按优先级：整体还原 → 逐节点还原 → 顶层 unmapped 回写 → 结构化转换。
 */

import type { ModalityKind, ModalityPayload, ModalityResponsePayload } from './modality.js';
import type { CanonicalUsage } from './usage.js';
import type { ConversionDiagnostic } from './diagnostic.js';
import type { FinishReason } from './error.js';
import type { FormatId } from './format.js';

export const IR_VERSION = 'ag-ir/1' as const;

/** 请求/响应根上未建模字段 + 节点级 raw 的容器（10 §7.1）。 */
export interface RawEnvelope {
  /** 顶层级：请求/响应根上未建模的字段。 */
  unmapped?: Record<string, unknown>;
  /** 节点级：每个 canonical 节点可带 _raw（原文对象或原始 block）。 */
  nodes?: Record<string, unknown>;
  /** 来源 provider（回写时判断能否整体还原）。 */
  source_provider?: string;
}

export interface CanonicalRequestEnvelope {
  /** IR 版本，v1 = "ag-ir/1"（决策 D6）。 */
  ir_version: typeof IR_VERSION;

  /** 模态判别，决定 payload 结构。 */
  kind: ModalityKind;

  /** 客户端请求的模型名（可能是网关别名）。 */
  model: string;
  /** 解析后的 provider 侧真实 model id；S2 路由后填充。 */
  resolved_model?: string;

  /** 请求级通用参数（chat 用；其他模态多数不用，但保留统一位置）。 */
  stream?: StreamOptions;

  /** 模态特定 payload。 */
  payload: ModalityPayload;

  /** 客户端原始格式（用于 fast path 与回写）。 */
  source_format: FormatId;

  /** 节点级 / 顶层级 raw 保留。 */
  raw: RawEnvelope;

  /** 网关扩展字段（不影响上游，仅在网关内流转）。 */
  gateway?: {
    agentic_loop?: boolean;
    max_turns?: number;
    builtin_tools?: string[];
    debug?: boolean;
    [k: string]: unknown;
  };
}

export interface CanonicalResponseEnvelope {
  ir_version: typeof IR_VERSION;
  kind: ModalityKind;
  request_id: string;

  /** 归一化 usage（多单位）。 */
  usage: CanonicalUsage;

  /** 归一化完成原因。 */
  finish_reason: FinishReason;

  /** 模态特定 payload。 */
  payload: ModalityResponsePayload;

  /** 该响应是否被降级（能力不支持时的桥接结果）。 */
  degraded?: ConversionDiagnostic[];

  warnings: string[];
  raw: RawEnvelope;
}

/** decision 模态专用：校准性标记（40 §6.3）。 */
export interface DecisionCalibration {
  /** "native" = 真 decision 模型；"degraded" = chat 模拟。 */
  calibration: 'native' | 'degraded';
  /** degraded 时的降级原因与替代模型。 */
  degraded_by?: { reason: string; model: string; chat_adaptor: string };
}

/** 流式选项（10 §4.5）。 */
export interface StreamOptions {
  enabled: boolean;
  /** 客户端要的形态。 */
  mode: 'sse' | 'chunked-binary' | 'ws-duplex' | 'none';
  /** 是否要求上游在流里带 usage。 */
  include_usage?: boolean;
  /** 客户端是否会用 OpenAI 原生事件名（否则用 ag.frame）。 */
  native_event_names?: boolean;
  /** 上游能力不匹配时的策略。chat 默认 bridge；ws-duplex 与 decision 默认 reject。 */
  on_mismatch: 'reject' | 'bridge' | 'buffer';
}
