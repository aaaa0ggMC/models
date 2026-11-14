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
  /**
   * **上游按 (model, dialect) 声明的行为约束**——机读字段，adaptor 必须执行。
   *
   * 来源：DeepSeek `GET /models` 的 `api_capabilities`（2026-11-13 全家桶发布后新增），
   * 例：`{"anthropic_messages":{"system_prompt_update":"in-history","tool_update":"addition-only"}}`。
   * 官方语义（https://api-docs.deepseek.com/api/list-models ）：
   *   - `system_prompt_update: "leading-only"`：只有对话**开头**的 system prompt 生效；
   *     要改系统提示只能改开头那条，历史中后出现的 system 消息**不被当作系统提示更新**。
   *   - `system_prompt_update: "in-history"`：system 消息可以追加进历史；历史中**最后一条**
   *     system 消息提供完整生效的系统提示，替换更早的所有 system 消息。
   *   - `tool_update: "addition-only"`：后续轮次只能**新增**工具，不能移除/修改已声明的。
   *   - `tool_update: "leading-only"`：只有对话首次请求的工具声明生效，后续变更被忽略。
   * 约束的执行方是 adaptor（编码前检查 + 合规转换或明确报错），不是路由——路由只做
   * 拒绝/降级/放行三态（25 §9）。
   */
  constraints?: ModelConstraints;
  /** 输入模态（/models 的 input_modalities：text / image）。路由做模态过滤用。 */
  input_modalities?: Array<'text' | 'image'>;
  /** 输出模态（/models 的 output_modalities，当前只有 text）。 */
  output_modalities?: Array<'text'>;
  /** 上下文窗口 token 总数（/models 的 context_window，含输入与输出）。 */
  context_window?: number;
  /** 单次响应最大输出 token（/models 的 max_output_tokens，即 max_tokens 上限）。 */
  max_output_tokens?: number;
  /** thinking effort 档位与默认值（/models 的 effort）。 */
  effort?: {
    /** 该模型支持的 effort 档位（reasoning_effort 的合法值，不含关推理的 none）。 */
    supported_levels: string[];
    /** 请求未指定 effort 且 thinking 开启时服务端用的档位。 */
    default_level?: string;
  };
  contract_tested: boolean;
  status: CapabilityStatus;
}

/** 上游声明的 (model, dialect) 行为约束（见 CapabilityEntry.constraints）。 */
export interface ModelConstraints {
  system_prompt_update?: 'leading-only' | 'in-history';
  tool_update?: 'leading-only' | 'addition-only';
}

/** 能力矩阵的主键。 */
export function capabilityKey(accessPath: string, model: string, modality: ModalityKind): string {
  return `${accessPath}/${model}/${modality}`;
}
