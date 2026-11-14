/**
 * ir/decision.ts —— decision 模态 payload（判断模型）。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §4.6；三家字段映射与三个映射陷阱见
 * docs/design/40-provider-adaptors.md §6.2；降级路径见同文 §6.3。
 *
 * ⚠️ decision **不是 chat 的特例**，也不能做 chat（三家官方文档均明确，单向）。
 * ⚠️ decision **不设计流式`——StreamOptions.mode 恒为 "none"，客户端请求流式返回
 *    streaming_mode_unsupported（25-streaming.md §1 的 reject 档）。
 */

import type { MediaRef } from './media.js';
import type { RawEnvelope } from './envelope.js';

export interface DecisionPayload {
  /** 被判断的内容。复用媒体引用三态（inline / uri / asset）。 */
  content: DecisionContent[];

  /** 问题列表。问题之间相互独立，可批量（上游上限见能力矩阵）。 */
  questions: DecisionQuestion[];

  /** 是否要求逐选项概率（默认 true）。 */
  include_option_probabilities?: boolean;
  /** 是否要求解释/理由（三家均不支持，字段仅作前向兼容）。 */
  include_rationale?: boolean;

  /** 温度类参数：decision 模型的"随机性"通常不可调或调了对校准有害。 */
  params?: {
    /** 上游专有旋钮（如 Gemini 的 decision 特定配置）。 */
    native?: Record<string, unknown>;
  };

  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface DecisionContent {
  /** 文本片段。 */
  text?: string;
  /** 多模态片段（图片/音频/视频/PDF），复用 MediaRef。 */
  media?: MediaRef;
  /** 该片段在判断中的角色（如 "context" / "candidate" / "rubric_reference"）。 */
  role?: string;
}

/**
 * 问题类型。canonical 用五种稳定类型，上游专有名字在 adaptor 层做别名映射
 * （Gemini/Jev: noul|choice|score|box；OpenAI: predicate|choice|score）。
 */
export type DecisionQuestionType =
  | 'binary' // 是非判断（yes/no）↔ Gemini/Jev noul、OpenAI predicate
  | 'choice' // 定集选择（从 options 里选）
  | 'scale' // 固定量表评分（离散档）↔ 三家 score
  | 'rubric' // rubric 评估。⚠️ 三家均无对应原语，映射为 choice 或 scale + criteria
  | 'box'; // 边界框（Jev 专有）。⚠️ 仅 Jev 实现，其余 adaptor 会 drop + warn

export interface DecisionQuestion {
  /** 问题稳定 id，响应按它回填。 */
  id: string;
  type: DecisionQuestionType;
  /** 问题文本 / 判断指令。 */
  prompt: string;

  /** 候选选项集。binary 可省略（默认 ["yes","no"]）；scale 用 labels 表达档位。 */
  options?: DecisionOption[];

  /** scale 类型：量表定义。 */
  scale?: {
    min: number;
    max: number;
    step?: number;
    /** 档位标签（如 ["很差","差","中","好","很好"]）。 */
    labels?: string[];
  };

  /** rubric 类型：评分标准。 */
  rubric?: {
    /** 评分维度。 */
    criteria: string;
    /** 达标阈值（达到即算通过）。 */
    pass_threshold?: number;
    /** 参考样例（可选）。 */
    reference?: MediaRef[];
  };

  /** 该问题是否允许多选（choice 类型；默认 false）。 */
  multiple?: boolean;
  /** 该问题关联的内容片段索引（默认全部）。 */
  content_refs?: number[];

  native?: Record<string, unknown>;
}

export interface DecisionOption {
  /** 选项值（回传给客户端）。**必须是语义化稳定值，不能用位置性 key**（40 §6.2.5 陷阱 1）。 */
  value: string;
  /** 选项展示名。 */
  label?: string;
  /** 选项描述（帮助模型判断）。 */
  description?: string;
}

export interface DecisionResponsePayload {
  /** 按 questions[].id 回填。 */
  answers: DecisionAnswer[];
}

/**
 * 单题答案。三个数值字段**都是可选的**，缺省省略而非填 0
 * （10 §4.6 D8c 陷阱 3 + §6.1 规则 2「未知绝不用 0 表示」）。
 */
export interface DecisionAnswer {
  question_id: string;
  /** 选中的选项值（binary/choice）；scale 为档位值；rubric 为分数；box 为坐标对象。 */
  label: string;
  /** 校准概率（0-1）。decision 模型的核心产出。 */
  probability?: number;
  /** 置信度分数（0-1）。与 probability 语义不同，二者都保留（设计说明 D8）。 */
  confidence?: number;
  /** 逐选项概率。 */
  option_probabilities?: Array<{ value: string; probability: number }>;
  /** 该题被拒答（OpenAI 的 refusal）。逐题拒答，同请求其他题仍作答。 */
  refusal?: { reason: string };
  /** 理由/解释。三家均不支持，字段仅作前向兼容。 */
  rationale?: string;
  /** 上游原始 answer 对象。 */
  raw?: unknown;
}

/** 40 §6.3：decision 降级策略。 */
export interface DecisionDegradationPolicy {
  /** 何时启用降级。默认 "on_missing_upstream"。 */
  mode: 'never' | 'on_missing_upstream' | 'always';
  /** 降级用的 chat 模型（access path + model）。 */
  fallback_model?: string;
  /** 是否允许把"高风险判断"降级（策略检查、stop 决策默认不允许）。 */
  allow_degrade_high_stakes?: boolean;
}

export const DEFAULT_DECISION_DEGRADATION_POLICY: DecisionDegradationPolicy = {
  mode: 'on_missing_upstream',
  allow_degrade_high_stakes: false,
};
