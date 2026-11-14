/**
 * ir/chat.ts —— chat 模态 payload（v1 最丰富）。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §4.1–§4.5；
 * 字段级映射表见同文 §9 与 docs/design/40-provider-adaptors.md。
 *
 * 三条从真实缺陷里长出来的硬约束（10 §4.2 设计说明）：
 *   D7  ToolUsePart.input 是**对象**；字符串形态存 raw_arguments（含解析失败时的原串）。
 *   D7b ToolUsePart.id 必须是干净 id，不得把元数据编码进 id 字符串；id 缺失时入口统一生成。
 *   D7c tool_use block 在 Anthropic 里必须移到段尾（由 anthropic codec 负责）。
 */

import type { JSONSchema } from "./json-schema.js";
import type { MediaRef } from "./media.js";

export interface ChatPayload {
  /** 系统提示提升为一级字段（Anthropic / Responses 风格）；Gemini systemInstruction 也映射到这里。 */
  system?: SystemBlock[];
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  tool_choice?: ToolChoice;
  params?: ChatParams;
}

/** chat 响应 payload：assistant 的一条消息 + 归一化 meta。 */
export interface ChatResponsePayload {
  /** 助手回合。parts 里的 tool_use 由模型发起。 */
  message: CanonicalMessage;
  /** 模型自报的 model id（可能与请求的别名不同）。 */
  model?: string;
  /** 该回合被选中的候选序号（n > 1 时）。 */
  index?: number;
}

export interface SystemBlock {
  text: string;
  cache_control?: CacheControl;
  _raw?: unknown;
}

export interface CanonicalMessage {
  /**
   * 权威角色。Gemini 的 user/model 映射到 user/assistant；
   * OpenAI 的 developer/tool role 在 v1 折叠进 system/user，raw 保留原值。
   */
  role: "user" | "assistant" | "system" | "tool";
  /** 内容块序列。chat 的全部内容都在 parts 里，不再有 "content: string | array" 的二义。 */
  parts: Part[];
  /** 该消息的稳定 id（用于 trace、delta 链、tool id 映射）。 */
  id?: string;
  _raw?: unknown;
}

export type Part =
  | TextPart
  | ImagePart
  | AudioPart
  | DocumentPart
  | VideoPart
  | ToolUsePart
  | ToolResultPart
  | ThinkingPart
  | RedactedThinkingPart
  | SearchResultPart
  | RefusalPart
  | UnknownPart;

export interface PartBase {
  _raw?: unknown;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ImagePart extends PartBase {
  type: "image";
  source: MediaRef;
  /** 该图片在消息里的用途（input / mask / reference）。 */
  role?: "input" | "mask" | "reference";
}

export interface AudioPart extends PartBase {
  type: "audio";
  source: MediaRef;
  /** 采样率/位深等，用于 ASR 与音频输入。 */
  format?: AudioFormat;
}

export interface AudioFormat {
  mime?: string;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
}

export interface DocumentPart extends PartBase {
  type: "document";
  source: MediaRef;
  /** 文档类型提示（pdf / txt / md / html …）。 */
  media_type?: string;
  title?: string;
}

export interface VideoPart extends PartBase {
  type: "video";
  source: MediaRef;
}

/** 模型发起的工具调用。id 是 canonical 权威 id（D7b）。 */
export interface ToolUsePart extends PartBase {
  type: "tool_use";
  id: string;
  name: string;
  /** 已解析的参数对象（不是 JSON 字符串）。 */
  input: Record<string, unknown>;
  /** 上游原始参数串（解析失败时保留，见 10 §7.3）。 */
  raw_arguments?: string;
}

/** 工具执行结果。 */
export interface ToolResultPart extends PartBase {
  type: "tool_result";
  /** 对应 ToolUsePart.id。 */
  tool_use_id: string;
  /** 内容可以是结构化 parts（多模态结果）或纯文本。 */
  content: Part[] | string;
  is_error?: boolean;
  /** 内置搜索的结果块。 */
  search_results?: SearchResultPart[];
}

/** 扩展思考。signature 是多轮回传所必需的（Anthropic 语义）。 */
export interface ThinkingPart extends PartBase {
  type: "thinking";
  thinking: string;
  signature?: string;
  /** Gemini thought parts / Responses reasoning summary 的标记。 */
  summary?: boolean;
}

export interface RedactedThinkingPart extends PartBase {
  type: "redacted_thinking";
  /** 上游加密块，网关不解释。 */
  data: string;
}

export interface SearchResultPart extends PartBase {
  type: "search_result";
  source: string;
  title: string;
  url: string;
  snippet: string;
  content?: string;
  published_at?: string;
  citation_index?: number;
  score?: number;
}

export interface RefusalPart extends PartBase {
  type: "refusal";
  reason: string;
}

/** 前向兼容兜底：provider 新增 block 类型时不报错，原文进 raw。 */
export interface UnknownPart extends PartBase {
  type: "unknown";
  /** 上游原始 block 类型名，便于诊断。 */
  raw_type?: string;
  raw: unknown;
}

export type CanonicalTool = FunctionTool | BuiltinTool;

export interface FunctionTool {
  type: "function";
  name: string;
  description?: string;
  /** JSON Schema。归一化规则见 40-provider-adaptors.md §4。 */
  parameters: JSONSchema;
  /** 严格模式（OpenAI strict / Anthropic 无对应）。 */
  strict?: boolean;
  cache_control?: CacheControl;
  _raw?: unknown;
}

/**
 * 内置工具：由上游或网关执行（50-builtin-search.md）。
 *
 * `name` 只用 canonical 稳定名，**厂商专有工具名/版本串收进 `native.provider_tool_type`**
 * （web_search_20250305、googleSearch…），映射时还原。
 * 注意：50 §2.2 原文写的是 `raw.provider_tool_type`；本仓库按 00 §5 术语表的
 * core/native/raw 三分法（决策 D2）统一收进 `native`，见报告的「文档问题」清单。
 */
export interface BuiltinTool {
  type: "builtin";
  /** canonical 统一名，跨格式映射的键。 */
  name: "web_search" | "url_context" | "code_interpreter" | "file_search";
  config: Record<string, unknown>;
  /** 上游原生支持时的执行者；缺省 = 网关自己执行。 */
  executor?: "provider" | "gateway";
  /** 厂商专有字段命名空间（provider_tool_type / display_name / description …）。 */
  native?: Record<string, unknown>;
  _raw?: unknown;
}

export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; name: string }
  | { type: "builtin"; name: string };

export interface ChatParams {
  /** 统一名；OpenAI 旧名 max_tokens、Gemini maxOutputTokens。 */
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  /** OpenAI stop、Anthropic stop_sequences、Gemini stopSequences。 */
  stop?: string[];
  seed?: number;
  /** 仅 OpenAI 系。 */
  frequency_penalty?: number;
  presence_penalty?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  /** 候选数；Anthropic 不支持（恒 1）。 */
  n?: number;
  /** 终端用户标识（脱敏后可入库）。 */
  user?: string;
  /** OpenAI metadata；Anthropic metadata 同名但限 16 kv。 */
  metadata?: Record<string, string>;
  service_tier?: "auto" | "default" | "flex" | "priority";
  /** Gemini safetySettings。 */
  safety?: SafetySetting[];
  /** 并行工具调用（OpenAI 语义；Anthropic/Gemini 无直接对应，40 §7.1）。 */
  parallel_tool_calls?: boolean;
  /** 结构化输出。 */
  response_format?: ResponseFormat;
  /** 思考/推理配置。 */
  thinking?: ThinkingConfig;
}

/** 思考 / 推理配置。三种 provider 词汇不同，canonical 统一。 */
export interface ThinkingConfig {
  enabled: boolean;
  /** 连续 token 预算（Anthropic budget_tokens、Gemini thinkingBudget）。 */
  budget_tokens?: number;
  /** 离散档位（OpenAI reasoning_effort）。与 budget_tokens 二选一或都留。 */
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 是否回传思考摘要（Responses summary / Gemini includeThoughts）。 */
  include_summary?: boolean;
  /** 保留历史思考块（多轮必需）。 */
  preserve_history?: boolean;
}

/** 结构化输出。 */
export interface ResponseFormat {
  type: "text" | "json_object" | "json_schema";
  json_schema?: {
    name: string;
    description?: string;
    schema: JSONSchema;
    strict?: boolean;
  };
}

export interface CacheControl {
  /** 缓存类型。Anthropic 的 ephemeral 5m/1h；OpenAI prompt caching 自动；Gemini cachedContent 显式。 */
  type: "ephemeral";
  ttl?: "5m" | "1h";
  /** Gemini cachedContent 的资源名。 */
  cache_name?: string;
}

export interface SafetySetting {
  category: string;
  threshold: string;
}

/**
 * 快速构造一个纯文本 user 消息——测试与内部辅助（如 decision 降级渲染）大量需要。
 */
export function textMessage(role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return { role, parts: [{ type: "text", text }] };
}

/** 取出消息里的纯文本（忽略其他 part）。工具循环与插件常用。 */
export function messageText(message: CanonicalMessage): string {
  return message.parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** 该 part 是否为"不透明思考块"——压缩插件一律不得触碰（30-plugin-api.md §4.4 风险表）。 */
export function isOpaqueThinkingPart(part: Part): part is ThinkingPart | RedactedThinkingPart {
  return part.type === "thinking" || part.type === "redacted_thinking";
}
