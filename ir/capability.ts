/**
 * ir/capability.ts —— 能力矩阵条目。
 *
 * 唯一事实来源：docs/design/45-credentials.md §6.2（新矩阵，键 = (access_path, model, modality)），
 * 合并了 docs/design/15-modalities.md §7 里的 `usage_units` / `framing` 字段。
 *
 * ⚠️ 合并说明（原文档问题）：15 §7 与 45 §6.2 各有一份形状不同的 `CapabilityEntry`
 * （前者键是 (provider, modality, models[])，后者键是 (access_path, model, modality)）。
 * 00-overview.md §5 术语表已明确「键是 access_path 不是 model」，故以 45 §6.2 为主干，
 * 把 15 §7 独有的 `usage_units` / `streaming.framing` 并进来，**本仓库只有这一份定义**。
 *
 * 矩阵三态（40 §5）：已实现 / 计划 / 按需。规则：`planned` 只允许存在于当前 Phase 的交付物清单里。
 */

import type { ModalityKind } from './modality.js';
import type { FormatId } from './format.js';
import type { UsageUnits } from './usage.js';

export type CapabilityStatus = 'implemented' | 'planned' | 'on-demand';

export type StreamingMode = 'none' | 'sse' | 'chunked-binary' | 'ws-duplex';

export type StreamingFraming = 'json-sse' | 'raw-bytes' | 'ws-messages';

export type UsageSourceKind = 'provider' | 'estimated';

export interface CapabilityEntry {
  /** 主键从 model 改为 (access_path, model)。 */
  access_path: string;
  model: string;
  modality: ModalityKind;
  /** 该条目实际使用的 wire 格式（用于 fast path 判定：client_format === provider_format）。 */
  format?: FormatId;
  /** 流式形态（25-streaming.md §9）。 */
  streaming?: {
    mode: StreamingMode;
    partial_results?: boolean;
    usage_in_stream?: boolean;
    cancellable?: boolean;
    framing?: StreamingFraming;
  };
  /** 计量来源。 */
  usage_source: UsageSourceKind;
  /** 该模态的 usage 单位（15 §7）。 */
  usage_units?: Array<keyof UsageUnits>;
  /** 该路径不支持的 canonical 字段。 */
  unsupported_fields?: string[];
  /** 人类可读的已知怪癖，进能力矩阵。 */
  quirks?: string[];
  contract_tested: boolean;
  status: CapabilityStatus;
}

/** 能力矩阵的主键。 */
export function capabilityKey(accessPath: string, model: string, modality: ModalityKind): string {
  return `${accessPath}/${model}/${modality}`;
}
