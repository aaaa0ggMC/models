/**
 * adaptors/anthropic-messages/codec.ts —— Anthropic Messages ↔ AG-IR canonical 双向 codec。
 *
 * 唯一事实来源（设计文档是规范，本文件只做落地）：
 *   - docs/design/10-canonical-schema.md §4（chat payload）、§4.2 D7/D7b/D7c、
 *     §7（raw passthrough 两级结构）、§9.1/§9.2（字段映射表）、§9.3（finish_reason 归一表）
 *   - docs/design/40-provider-adaptors.md §1.1（Adaptor 接口）、§1.5（round-trip 测试模板）、
 *     §2.1（usage 口径表）、§2.2（双算风险）、§2.2b（2026 协议变更）、§2.2c（硬不变量 I1–I4）、
 *     §2.3（流式 usage 到达方式）、§3.2（effort → budget_tokens 阈值表）、§7.2（Anthropic 注意事项）
 *   - docs/design/20-pipeline.md §S1 / §S4 / §S6 / §S8
 *
 * **方向约定**（本文件所有注释都显式标注，避免读者搞反）：
 *   - `decode` / `decodeResponse` / `decodeStream` / `decodeEnvelope`
 *     = 客户端格式（Anthropic wire）→ canonical
 *   - `encode` / `encodeResponse` / `encodeStream`
 *     = canonical → 上游格式（Anthropic wire）
 *   本 adaptor 同时是"客户端格式侧"与"上游格式侧"的实现——同格式互转正是 fast path 的查表依据
 *   （40 §1.4 第 3 步补充：直连一定排第一）。
 *
 * 三条贯穿全文件的硬约束：
 *   1. **不丢字段**：未建模的顶层键进 `raw.unmapped`，未建模的 block 键进节点级 `_raw`
 *      （10 §7.1 决策 D3 的两级 raw passthrough）；
 *   2. **未知不抛错**：未知 block 类型降级为 `UnknownPart`（20 §S1 原文）；
 *   3. **未知不用 0 表示**：上游没给 usage 时 `units.tokens` 键省略 + `usage_missing`
 *      （10 §6.1 规则 2、40 §2.2c）。
 */

import type {
  BuiltinTool,
  CacheControl,
  CanonicalMessage,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalTool,
  CanonicalUsage,
  ChatParams,
  ChatPayload,
  ChatResponsePayload,
  Clock,
  ConversionDiagnostic,
  DeltaData,
  DocumentPart,
  EndData,
  ErrorData,
  FinishReason,
  FormatId,
  FunctionTool,
  ImagePart,
  InlineMedia,
  JSONSchema,
  MediaRef,
  MetaData,
  ModalityKind,
  NormalizedFinishReason,
  Part,
  RequestContext,
  StartData,
  StreamFrame,
  SystemBlock,
  TextPart,
  ThinkingConfig,
  ToolChoice,
  ToolResultPart,
  ToolUsePart,
  UnknownPart,
  UsageData,
  UriMedia,
} from '../../ir/index.js';
import { CTX_STATE_KEYS, IR_VERSION } from '../../ir/index.js';
import { asChatPayload, asChatResponsePayload } from '../../ir/index.js';
import { createCanonicalError } from '../../ir/index.js';
import type { Adaptor, AdaptorMeta, EncodedRequest, RequestEnvelopeShallow } from '../types.js';
// `Logger` 不是 IR 类型，而是 di/ports.ts 定义的跨切面"能力"接口（该文件头部自述：
// 统一放 di/ 下并经构造函数注入）。`Clock` 按任务要求从 ir/index.js 取——两者结构兼容，
// adaptors/index.ts 传进来的 di/ports.Clock 可以直接赋给 ir/clock.ts 的 Clock。
import type { Logger } from '../../di/ports.js';
import type { ProviderProfile, ProviderProfileRegistry } from '../../di/ports.js';
import type { CapabilityEntry, ModelConstraints } from '../../ir/index.js';
import {
  applyClientProviderOptions,
  applyNativeVendorOptions,
  filterUnmappedForPassthrough,
} from '../provider-options.js';

// ---------------------------------------------------------------------------
// 常量：协议版本、端点、映射表
// ---------------------------------------------------------------------------

/**
 * Anthropic API version。
 *
 * 40 §2.2b / 10 §9.4：`2026-10-21` 起 `temperature` / `top_p` / `top_k` **发送即 400**，
 * 因此本 codec 编码时必须丢弃这三个字段（见 `encodeParams`）。
 */
export const ANTHROPIC_API_VERSION = '2026-10-21';

/**
 * 本 codec 只需要能力矩阵的**读**接口（按 (access_path, model, modality) 找约束）。
 * 用局部结构类型而不是 import credentials/capability-registry.ts 的具体类：
 * adaptors 层不反向依赖具体实现（AGENTS.md 代码组织），组合根注入时结构相容即可。
 */
interface CapabilityRegistryLike {
  find(
    accessPath: string,
    model: string,
    modality: 'chat',
  ): Pick<CapabilityEntry, 'constraints'> | undefined;
}

/**
 * Anthropic Messages 的端点路径（RequestEnvelopeShallow.default_path 同值）。
 */
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';

/**
 * canonical `ThinkingConfig.effort` → Anthropic `thinking.budget_tokens` 的阈值表。
 *
 * 唯一事实来源：docs/design/40-provider-adaptors.md §3.2（"阈值表（默认值，可配置）"）。
 * 离散 ↔ 连续是**本质有损**映射（10 §4.4 映射注意），所以每次换算都必须记一条 warning
 * 说明用了哪一档——这是 40 §3.1 "在响应里声明用了哪一档"的落地。
 */
export const EFFORT_TO_BUDGET_TOKENS: Readonly<
  Record<Exclude<NonNullable<ThinkingConfig['effort']>, 'none'>, number>
> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 64000,
};

/**
 * `stop_reason` 归一表（wire → canonical）。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §9.3 的 Anthropic 列。
 * **注意 2（反 LiteLLM 教训）**：映射表未命中时**不得默认 `stop`**，必须落到 `other`
 * 并 `warnings += "unmapped_finish_reason:<原文>"`。
 */
const FINISH_REASON_TO_CANONICAL: Readonly<Record<string, NormalizedFinishReason>> = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_use',
  stop_sequence: 'stop_sequence',
  refusal: 'content_filter',
  pause_turn: 'pause_turn',
  model_context_window_exceeded: 'context_exceeded',
};

/**
 * `stop_reason` 反归一表（canonical → wire）。
 *
 * canonical 枚举是四家的**超集**（10 §9.3 注意 1），反回去时按目标格式能力"就近映射"。
 * Anthropic 没有 `recitation` / `missing_thought_signature` / `error` 对应值，落到
 * `end_turn` 并记 warning——不静默。
 */
const CANONICAL_TO_FINISH_REASON: Readonly<Record<NormalizedFinishReason, string>> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_use: 'tool_use',
  content_filter: 'refusal',
  stop_sequence: 'stop_sequence',
  pause_turn: 'pause_turn',
  context_exceeded: 'model_context_window_exceeded',
  error: 'end_turn',
  recitation: 'end_turn',
  missing_thought_signature: 'end_turn',
  other: 'end_turn',
};

/**
 * Anthropic `stop_reason` 的**合法取值集**（= decode 侧 `FINISH_REASON_TO_CANONICAL` 的键）。
 *
 * 用途只有一个：回写 `stop_reason` 时判断 `raw.finish_reason_provider` 里的原文能不能
 * **原样**用。跨格式转过来的原文是别家枚举（OpenAI 的 `"stop"` / `"length"`、Gemini 的
 * `"MAX_TOKENS"`），照抄进 Anthropic 响应体会让客户端解析失败——这是 e2e 里真实抓到过的 bug。
 */
export const ANTHROPIC_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'tool_use',
  'stop_sequence',
  'refusal',
  'pause_turn',
  'model_context_window_exceeded',
]);

/**
 * `raw.finish_reason_provider` 的原文能否原样回写成 Anthropic `stop_reason`。
 *
 * 见 `encodeFinishReason` 的注释：两条并联充分条件——"取值本身合法"或"来源就是 anthropic"
 * （后者覆盖"Anthropic 未来新增 stop_reason"的前向兼容场景）。
 */
function isReusableAnthropicStopReason(
  provider: string,
  sourceProvider: string | undefined,
): boolean {
  return ANTHROPIC_STOP_REASONS.has(provider) || sourceProvider === 'anthropic';
}

/**
 * Anthropic 内置 server tool 的 `type` 前缀 → canonical `BuiltinTool.name`。
 *
 * 归一化规则见 50-builtin-search.md §2.2：`BuiltinTool.name` 只用 canonical 稳定名，
 * 厂商专有版本串（`web_search_20250305`、`code_execution_20260521`…）收进
 * `native.provider_tool_type`。版本演进清单见 10 §9.4 / 40 §2.2b。
 */
const BUILTIN_TOOL_NAME_BY_PREFIX: ReadonlyArray<readonly [string, BuiltinTool['name']]> = [
  ['web_search', 'web_search'],
  ['code_execution', 'code_interpreter'],
  ['code_interpreter', 'code_interpreter'],
  ['url_context', 'url_context'],
  ['file_search', 'file_search'],
];

/**
 * canonical `BuiltinTool.name` → Anthropic server tool `type`（**缺省值**）。
 *
 * 只有当 canonical 侧没有 `native.provider_tool_type` 时才用它，并且会记一条
 * `builtin_tool_type_inferred` warning——版本串是会演进的（`web_search_20250305`
 * → `20260209` → `20260318`，见 10 §9.4），猜版本必须显式声明而不是静默。
 */
const DEFAULT_PROVIDER_TOOL_TYPE: Readonly<Record<BuiltinTool['name'], string>> = {
  web_search: 'web_search_20260318',
  url_context: 'url_context',
  code_interpreter: 'code_execution_20260521',
  file_search: 'file_search',
};

/**
 * `decode` 建模了的顶层键。**不在这张表里的顶层键必须进 `raw.unmapped`**（10 §7 / 20 §S1）。
 */
const MODELLED_TOP_LEVEL_KEYS: readonly string[] = [
  'model',
  'max_tokens',
  'system',
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stream',
  'thinking',
  'metadata',
];

/**
 * 每种 part 在 Anthropic wire 上建模了的键。多出来的键进节点级 `_raw`
 * （10 §7.1 的两级 raw passthrough：顶层级 `unmapped` + 节点级 `_raw`）。
 */
const PART_MODELLED_KEYS: Readonly<Record<string, readonly string[]>> = {
  text: ['type', 'text', 'cache_control'],
  image: ['type', 'source'],
  document: ['type', 'source', 'title'],
  tool_use: ['type', 'id', 'name', 'input'],
  tool_result: ['type', 'tool_use_id', 'content', 'is_error'],
  thinking: ['type', 'thinking', 'signature'],
  redacted_thinking: ['type', 'data'],
  search_result: [
    'type',
    'source',
    'title',
    'url',
    'content',
    'snippet',
    'citation_index',
    'score',
    'published_at',
  ],
};

/** system block 在 wire 上建模了的键。 */
const SYSTEM_MODELLED_KEYS: readonly string[] = ['type', 'text', 'cache_control'];

/** message 对象在 wire 上建模了的键。 */
const MESSAGE_MODELLED_KEYS: readonly string[] = ['role', 'content'];

/** function tool 在 wire 上建模了的键。 */
const FUNCTION_TOOL_MODELLED_KEYS: readonly string[] = [
  'name',
  'description',
  'input_schema',
  'cache_control',
];

/**
 * canonical 错误码 → Anthropic 错误体 `error.type`（canonical → 客户端格式，20 §7.2）。
 *
 * 依据 20 §7.2「映射到客户端格式」表的 Anthropic 列 + §7.3 重试矩阵里点名的
 * `overloaded_error`。Anthropic 的 `type` 是它自己的机器可读枚举（`invalid_request_error` /
 * `authentication_error` / `permission_error` / `not_found_error` / `request_too_large` /
 * `rate_limit_error` / `api_error` / `overloaded_error`）。
 *
 * canonical `CanonicalErrorCode` 是超集，落不进下表的一律 `api_error`——**不**猜更具体的值
 * （40 §1.7「默认按名拒绝」的同一立场）。
 */
const CANONICAL_ERROR_CODE_TO_ANTHROPIC_TYPE: Readonly<Record<string, string>> = {
  auth_failed: 'authentication_error',
  rate_limited: 'rate_limit_error',
  quota_exceeded: 'rate_limit_error',
  provider_unavailable: 'overloaded_error',
  upstream_timeout: 'api_error',
  upstream_error: 'api_error',
  no_available_provider: 'api_error',
  plugin_error: 'api_error',
  internal_error: 'api_error',
  unsupported_format: 'invalid_request_error',
  canonical_decode_error: 'invalid_request_error',
  canonical_encode_error: 'invalid_request_error',
  capability_unsupported: 'invalid_request_error',
  context_length_exceeded: 'request_too_large',
  content_filtered: 'invalid_request_error',
  streaming_mode_unsupported: 'invalid_request_error',
  agentic_loop_exceeded: 'api_error',
};

/**
 * `finish_reason_provider` 已升级为 `RawEnvelope` 的一等字段（ir/envelope.ts，10 §9.3 注意 3）。
 * 此常量仅作为**兼容导出**保留（外部代码若按字符串键名引用可继续 import）；
 * 新代码请直接写 `raw.finish_reason_provider`。
 */
export const FINISH_REASON_PROVIDER_KEY = 'finish_reason_provider';

/**
 * part 边界帧（`part.begin` / `part.end`）在 `StreamFrame` 里的载体键。
 *
 * ⚠️ 类型缺口（同样列入报告的「文档问题」清单）：20 §S6 的 `CanonicalStreamEvent` 有
 * `part.begin` / `part.delta` / `part.end` 三种 part 级事件，但 `ir/stream.ts` 的
 * `StreamFrame.data`（`FrameData` 联合）里**没有** part 级负载类型；同时
 * `gateway-core/pipeline/stages/s8-client-encode.ts` 的 `eventToFrameData()` 把
 * `part.begin`/`part.end` 折叠成 `{kind:"chat", text:""}`，`s6-provider-decode.ts` 的
 * `frameToEvent()` 又只认 `delta` / `end` / `usage` / `error` / `start`。
 * 在两处都不在写权限内的前提下，part 边界只能搭车 `MetaData.notes`
 * （`Record<string, unknown>`，且 part 边界确实是"非内容性元信息"）。
 */
export const PART_FRAME_NOTE_KEY = 'anthropic.part';

/**
 * `ping` / 未知 SSE 事件在 canonical 帧里的透传载体键。
 *
 * Anthropic 用 `ping` 做 SSE keep-alive。**不能丢**——丢了客户端侧的空闲超时会被误触发，
 * 且 40 §1.5 的"流式事件序列等价"要求事件名序列能原样还原。因此未知/无内容事件搭车
 * `MetaData.notes` 透传，`encodeStream` 再按原事件名还原。
 */
export const PASSTHROUGH_FRAME_NOTE_KEY = 'anthropic.passthrough';

/** Anthropic SSE `error` 事件的 `error.type` → canonical 错误码。 */
const STREAM_ERROR_CODE_BY_TYPE: Readonly<
  Record<string, { code: CanonicalErrorLike['code']; retryable: boolean }>
> = {
  overloaded_error: { code: 'provider_unavailable', retryable: true },
  rate_limit_error: { code: 'rate_limited', retryable: true },
  api_error: { code: 'upstream_error', retryable: true },
  authentication_error: { code: 'auth_failed', retryable: false },
  permission_error: { code: 'auth_failed', retryable: false },
  invalid_request_error: { code: 'upstream_error', retryable: false },
  not_found_error: { code: 'upstream_error', retryable: false },
};

/** 只为上面那张表占位的错误码子集（避免在 codec 里重复定义 CanonicalErrorCode）。 */
type CanonicalErrorLike = { code: import('../../ir/index.js').CanonicalErrorCode };

// ---------------------------------------------------------------------------
// 小型类型守卫 / 取值助手（wire 全是 unknown，逐个收窄）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * 取出对象里"未建模"的键；没有多余键时返回 undefined（避免无谓的体积膨胀——
 * 每个 part 都挂一份全量 `_raw` 会让长上下文请求的 canonical 体积翻倍）。
 */
function extraKeys(
  obj: Record<string, unknown>,
  modelled: readonly string[],
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  let found = false;
  for (const k of Object.keys(obj)) {
    if (modelled.includes(k)) continue;
    extra[k] = obj[k];
    found = true;
  }
  return found ? extra : undefined;
}

/** 把节点级 `_raw` 合并回 wire block（`_raw` 在前、建模字段在后，建模字段永远赢）。 */
function applyRaw(
  wire: Record<string, unknown>,
  raw: unknown,
  sameFormat = true,
): Record<string, unknown> {
  if (!sameFormat) return wire;
  const r = asRecord(raw);
  return r === undefined ? wire : { ...r, ...wire };
}

/**
 * canonical 错误信封 → Anthropic 错误体 `{type:"error", error:{type, code, message}}`。
 *
 * 方向：canonical → 客户端格式（20 §7.2 的 Anthropic 列）。
 *
 * Runner 的 `errorEnvelope()` 把完整 `CanonicalError` 放进 `raw.nodes.error`，因此这里能填
 * 真实的 `type` / `code`，而不是"猜一个 api_error"的保守值。
 * `message` 同时保留：20 §7.2 的 Anthropic 列本来就要求 `{type, message}`，`code` 是附带的
 * 机器可读 canonical 码（Runner 的 SSE error 帧也带同一个字段，两侧一致）。
 */
function anthropicErrorBody(res: CanonicalResponseEnvelope): Record<string, unknown> {
  const err = asRecord(res.raw.nodes?.['error']);
  const code = asString(err?.['code']);
  const message = asString(err?.['message']);
  if (code === undefined) {
    // 没有完整 CanonicalError（插件手搓的信封）：退回落体上的 refusal 文本。
    const parts = asChatResponsePayload(res)?.message.parts ?? [];
    const refusal = parts.find((p) => p.type === 'refusal');
    const fallback =
      refusal !== undefined && refusal.type === 'refusal' ? refusal.reason : 'upstream error';
    return { type: 'api_error', message: fallback };
  }
  return {
    type: CANONICAL_ERROR_CODE_TO_ANTHROPIC_TYPE[code] ?? 'api_error',
    code,
    ...(message === undefined ? {} : { message }),
  };
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export class AnthropicMessagesCodec implements Adaptor {
  readonly format: FormatId = 'anthropic.messages';
  readonly modalities: ModalityKind[] = ['chat'];

  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  /**
   * provider profile 注册表（可选注入）。
   *
   * 同一 codec 实例服务所有 anthropic.messages dialect 的 access path
   * （anthropic 本家 / deepseek.anthropic-messages / mock-anthropic）。DeepSeek 的
   * Anthropic 兼容面与本家的差异（端点路径 `/anthropic/v1/messages`、服务端工具
   * 类型串 `deepseek_web_search`）按 access path 查 profile 后启用，查不到时行为
   * 与本文件历史版本完全一致。详见 di/ports.ts 的 ProviderProfile。
   */
  private readonly providerProfiles: ProviderProfileRegistry | undefined;
  /**
   * 能力矩阵（可选注入）：编码时按 (access_path, model) 读**上游声明的行为约束**
   * （DeepSeek /models 的 api_capabilities：system_prompt_update / tool_update）并执行。
   * 缺省 = 不做约束检查（行为与本文件历史版本一致）。
   */
  private readonly capabilityRegistry: CapabilityRegistryLike | undefined;

  /**
   * 依赖经构造函数注入（di/ports.ts 的两条硬约束：禁止模块级单例、禁止隐式全局状态）。
   * 不自己造时钟——否则流式帧的 `ts` 在测试里不可控。
   */
  constructor(deps: {
    clock: Clock;
    logger?: Logger;
    providerProfiles?: ProviderProfileRegistry;
    capabilityRegistry?: CapabilityRegistryLike;
  }) {
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.providerProfiles = deps.providerProfiles;
    this.capabilityRegistry = deps.capabilityRegistry;
  }

  /**
   * 取本次请求目标模型的**上游声明约束**（没有则 undefined = 无约束）。
   *
   * 为什么按 access_path + model 查而不是写死在 codec 里：约束是上游按 (model, dialect)
   * 主动声明的（DeepSeek `GET /models` 的 `api_capabilities.anthropic_messages`），
   * 会随模型演进而变；能力矩阵是它的登记处，model discovery 会实时刷新矩阵
   * （providers/deepseek/discovery.ts），codec 读矩阵就等于永远读最新值。
   */
  private constraintsFor(ctx: RequestContext, model: string): ModelConstraints | undefined {
    const accessPath = ctx.route?.access_path;
    if (accessPath === undefined || this.capabilityRegistry === undefined) return undefined;
    return this.capabilityRegistry.find(accessPath, model, 'chat')?.constraints;
  }

  /** 按本次请求的 access path 取 provider profile（没有则 undefined）。 */
  private profileFor(ctx: RequestContext): ProviderProfile | undefined {
    const accessPath = ctx.route?.access_path;
    if (accessPath === undefined || this.providerProfiles === undefined) return undefined;
    return this.providerProfiles.forAccessPath(accessPath);
  }

  /** 上游端点路径：profile 覆盖优先（DeepSeek: /anthropic/v1/messages），否则 /v1/messages。 */
  private endpointPathFor(ctx: RequestContext): string {
    const profile = this.profileFor(ctx);
    if (profile === undefined) return ANTHROPIC_MESSAGES_PATH;
    return profile.endpointPath?.(ctx.route?.access_path ?? '') ?? ANTHROPIC_MESSAGES_PATH;
  }

  // =========================================================================
  // 请求：客户端格式（Anthropic wire）→ canonical
  // =========================================================================

  decode(raw: unknown, ctx: RequestContext): CanonicalRequestEnvelope {
    const obj = asRecord(raw);
    if (obj === undefined) {
      // 20 §S1：解码失败要能定位；但"整体不是对象"这种输入不值得抛，降级成空请求体 +
      // 记日志，让上游去 400（canonical_decode_error 由 Runner 统一包）。
      this.logger?.warn('anthropic.messages decode: 请求体不是对象', {
        request_id: ctx.request_id,
      });
    }
    const body = obj ?? {};

    const model = asString(body['model']) ?? '';
    const payload: ChatPayload = { messages: this.decodeMessages(body['messages']) };

    const system = this.decodeSystem(body['system']);
    if (system !== undefined) payload.system = system;

    const tools = this.decodeTools(body['tools'], this.profileFor(ctx));
    if (tools !== undefined) payload.tools = tools;

    const toolChoiceResult = this.decodeToolChoice(body['tool_choice']);
    if (toolChoiceResult.choice !== undefined) payload.tool_choice = toolChoiceResult.choice;

    const params = this.decodeParams(body);
    if (params !== undefined) payload.params = params;

    let unmapped = extraKeys(body, MODELLED_TOP_LEVEL_KEYS);
    if (toolChoiceResult.unmappable !== undefined) {
      unmapped = { ...(unmapped ?? {}), tool_choice: toolChoiceResult.unmappable };
    }

    const envelope: CanonicalRequestEnvelope = {
      ir_version: IR_VERSION,
      kind: 'chat',
      model,
      payload,
      source_format: this.format,
      raw: {
        source_provider: 'anthropic',
        ...(unmapped === undefined ? {} : { unmapped }),
      },
    };

    // 流式选项：Anthropic 的 usage 恒带（10 §9.1 `stream.include_usage` 列写"恒带（message_delta）"），
    // 所以不需要显式置 include_usage；on_mismatch 按 10 §4.5 的 chat 默认值取 bridge。
    if (body['stream'] === true) {
      envelope.stream = { enabled: true, mode: 'sse', on_mismatch: 'bridge' };
    }

    return envelope;
  }

  /** `system`：string 或 block 数组 → `SystemBlock[]`（40 §7.2：多条 system 必须全部保留）。 */
  private decodeSystem(system: unknown): SystemBlock[] | undefined {
    if (typeof system === 'string') {
      return [{ text: system }];
    }
    const arr = asArray(system);
    if (arr === undefined) return undefined;
    return arr.map((block) => {
      const b = asRecord(block);
      if (b === undefined) return { text: '', _raw: block };
      const out: SystemBlock = { text: asString(b['text']) ?? '' };
      const cc = this.decodeCacheControl(b['cache_control']);
      if (cc !== undefined) out.cache_control = cc;
      const extra = extraKeys(b, SYSTEM_MODELLED_KEYS);
      if (extra !== undefined) out._raw = extra;
      return out;
    });
  }

  private decodeMessages(messages: unknown): CanonicalMessage[] {
    const arr = asArray(messages);
    if (arr === undefined) return [];
    const out: CanonicalMessage[] = [];
    for (const m of arr) {
      const rec = asRecord(m);
      if (rec === undefined) continue;
      const role = asString(rec['role']);
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
        // 20 §S1：未知 role 不抛；原样进 _raw，role 落到最接近的 user。
        this.logger?.warn('anthropic.messages decode: 未知 message role', { role: String(role) });
      }
      const content = rec['content'];
      const parts =
        typeof content === 'string'
          ? [{ type: 'text', text: content } as Part]
          : (asArray(content) ?? []).map((block) => this.decodePart(block));
      const msg: CanonicalMessage = {
        role: role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user',
        parts,
      };
      const id = asString(rec['id']);
      if (id !== undefined) msg.id = id;
      const extra = extraKeys(rec, MESSAGE_MODELLED_KEYS);
      if (extra !== undefined) msg._raw = extra;
      out.push(msg);
    }
    return out;
  }

  /** block → Part。未知类型 → `UnknownPart`，**绝不抛错**（20 §S1 前向兼容）。 */
  private decodePart(block: unknown): Part {
    const b = asRecord(block);
    if (b === undefined) return { type: 'unknown', raw: block };

    const type = asString(b['type']);
    const modelled = type === undefined ? undefined : PART_MODELLED_KEYS[type];
    const extra = modelled === undefined ? undefined : extraKeys(b, modelled);
    const withRaw = <T extends { _raw?: unknown }>(part: T): T => {
      if (extra !== undefined) part._raw = extra;
      return part;
    };

    switch (type) {
      case 'text': {
        const part: TextPart = { type: 'text', text: asString(b['text']) ?? '' };
        const cc = this.decodeCacheControl(b['cache_control']);
        if (cc !== undefined) part.cache_control = cc;
        return withRaw(part);
      }
      case 'image': {
        const source = this.decodeMedia(b['source']);
        if (source === undefined) return { type: 'unknown', raw_type: type, raw: block };
        const part: ImagePart = { type: 'image', source };
        return withRaw(part);
      }
      case 'document': {
        const source = this.decodeMedia(b['source']);
        if (source === undefined) return { type: 'unknown', raw_type: type, raw: block };
        const part: DocumentPart = { type: 'document', source };
        const mediaType = asString(b['media_type']);
        if (mediaType !== undefined) part.media_type = mediaType;
        const title = asString(b['title']);
        if (title !== undefined) part.title = title;
        return withRaw(part);
      }
      case 'tool_use': {
        const part: ToolUsePart = {
          type: 'tool_use',
          id: asString(b['id']) ?? '',
          name: asString(b['name']) ?? '',
          input: asRecord(b['input']) ?? {},
        };
        const rawArgs = asString(b['raw_arguments']);
        if (rawArgs !== undefined) part.raw_arguments = rawArgs;
        return withRaw(part);
      }
      case 'tool_result': {
        const content = b['content'];
        const part: ToolResultPart = {
          type: 'tool_result',
          tool_use_id: asString(b['tool_use_id']) ?? '',
          content:
            typeof content === 'string'
              ? content
              : (asArray(content) ?? []).map((inner) => this.decodePart(inner)),
        };
        const isError = asBoolean(b['is_error']);
        if (isError !== undefined) part.is_error = isError;
        return withRaw(part);
      }
      case 'thinking': {
        const part: Part = { type: 'thinking', thinking: asString(b['thinking']) ?? '' };
        const signature = asString(b['signature']);
        if (signature !== undefined) part.signature = signature;
        return withRaw(part);
      }
      case 'redacted_thinking': {
        const part: Part = { type: 'redacted_thinking', data: asString(b['data']) ?? '' };
        return withRaw(part);
      }
      case 'search_result': {
        // Anthropic 的 search_result block：标题/URL/正文直接对应；`source` 是 canonical 的
        // 来源标识，wire 上没有对应值，缺省记 "anthropic"（回写时再决定要不要 emit）。
        const part: Part = {
          type: 'search_result',
          source: asString(b['source']) ?? 'anthropic',
          title: asString(b['title']) ?? '',
          url: asString(b['url']) ?? '',
          snippet: asString(b['content']) ?? asString(b['snippet']) ?? '',
        };
        const citationIndex = asNumber(b['citation_index']);
        if (citationIndex !== undefined) part.citation_index = citationIndex;
        const score = asNumber(b['score']);
        if (score !== undefined) part.score = score;
        const publishedAt = asString(b['published_at']);
        if (publishedAt !== undefined) part.published_at = publishedAt;
        const content = asString(b['content']);
        if (content !== undefined) part.content = content;
        return withRaw(part);
      }
      default:
        // 前向兼容兜底（10 §4.2 UnknownPart）：provider 新增 block 类型时网关不炸。
        return { type: 'unknown', ...(type === undefined ? {} : { raw_type: type }), raw: block };
    }
  }

  /** `source:{type:"base64"|"url", …}` → `MediaRef` 三态（10 §5）。 */
  private decodeMedia(source: unknown): InlineMedia | UriMedia | undefined {
    const s = asRecord(source);
    if (s === undefined) return undefined;
    const kind = asString(s['type']);
    if (kind === 'base64') {
      const media: InlineMedia = {
        kind: 'inline',
        mime: asString(s['media_type']) ?? 'application/octet-stream',
        data: asString(s['data']) ?? '',
      };
      return media;
    }
    if (kind === 'url') {
      const media: UriMedia = {
        kind: 'uri',
        mime: 'application/octet-stream',
        uri: asString(s['url']) ?? '',
      };
      const fetchByGateway = asBoolean(s['fetch_by_gateway']);
      if (fetchByGateway !== undefined) media.fetch_by_gateway = fetchByGateway;
      return media;
    }
    return undefined;
  }

  private decodeCacheControl(cc: unknown): CacheControl | undefined {
    const c = asRecord(cc);
    if (c === undefined) return undefined;
    const out: CacheControl = { type: 'ephemeral' };
    const ttl = asString(c['ttl']);
    if (ttl === '5m' || ttl === '1h') out.ttl = ttl;
    return out;
  }

  /**
   * `tools[]` → `CanonicalTool[]`。
   *
   * 两种形态：
   *   - 普通 function tool：`{name, description, input_schema}` → `FunctionTool`；
   *   - 内置 server tool：`{type:"web_search_20250305", name:"web_search", max_uses:…}` →
   *     `BuiltinTool`，**厂商版本串进 `native.provider_tool_type`，`name` 保持 canonical 稳定名**
   *     （50 §2.2 归一化规则）。
   *
   * ⚠️ 文档不一致（列入报告，未改文档）：50 §2.2 与 10 §9.4 原文写 `BuiltinTool.raw.provider_tool_type`，
   * 但 `ir/chat.ts` 的 `BuiltinTool` 没有 `raw` 字段，只有 `native?: Record<string, unknown>`
   * （00 §5 术语表的 core/native/raw 三分法，决策 D2）。本仓库按 `ir/` 的类型定义收进 `native`。
   */
  private decodeTools(
    tools: unknown,
    profile: ProviderProfile | undefined,
  ): CanonicalTool[] | undefined {
    const arr = asArray(tools);
    if (arr === undefined) return undefined;
    const out: CanonicalTool[] = [];
    for (const t of arr) {
      const rec = asRecord(t);
      if (rec === undefined) continue;
      const type = asString(rec['type']);
      if (type !== undefined && type !== 'function') {
        const builtin = this.decodeBuiltinTool(type, rec, profile);
        if (builtin !== undefined) {
          out.push(builtin);
          continue;
        }
        // 认不出的 server tool 类型：不能塞进 BuiltinTool（name 是封闭联合），也不能假装
        // 它是普通 function tool 让模型去调。按 40 §1.7「默认按名拒绝」的立场，降级成
        // FunctionTool 壳 + 全量 `_raw`，让下游能看见原文并自行处置。
        this.logger?.warn('anthropic.messages decode: 未识别的 server tool 类型', { type });
        const fallback: FunctionTool = {
          type: 'function',
          name: asString(rec['name']) ?? type,
          parameters: {},
          _raw: t,
        };
        out.push(fallback);
        continue;
      }
      const tool: FunctionTool = {
        type: 'function',
        name: asString(rec['name']) ?? '',
        parameters: (asRecord(rec['input_schema']) as JSONSchema | undefined) ?? {},
      };
      const description = asString(rec['description']);
      if (description !== undefined) tool.description = description;
      const cc = this.decodeCacheControl(rec['cache_control']);
      if (cc !== undefined) tool.cache_control = cc;
      const extra = extraKeys(rec, FUNCTION_TOOL_MODELLED_KEYS);
      if (extra !== undefined) tool._raw = extra;
      out.push(tool);
    }
    return out;
  }

  /**
   * server tool `type` 串 → `BuiltinTool`（认不出返回 undefined）。
   *
   * 两级识别：
   *   1. **dialect 级**：Anthropic 本家的 server tool 前缀表（`web_search_20250305` …），
   *      见 BUILTIN_TOOL_NAME_BY_PREFIX；
   *   2. **provider 级**：当前 access path 的 profile（如 DeepSeek 的
   *      `deepseek_web_search` / `deepseek_read_url`，前缀表认不出来，因为它们
   *      不以 canonical 名前缀开头）。
   * 两级都认不出才降级成 FunctionTool 壳 + `_raw`（40 §1.7「默认按名拒绝」）。
   */
  private decodeBuiltinTool(
    providerToolType: string,
    rec: Record<string, unknown>,
    profile: ProviderProfile | undefined,
  ): BuiltinTool | undefined {
    let name: BuiltinTool['name'] | undefined;
    for (const [prefix, canonicalName] of BUILTIN_TOOL_NAME_BY_PREFIX) {
      if (providerToolType === prefix || providerToolType.startsWith(`${prefix}_`)) {
        name = canonicalName;
        break;
      }
    }
    // provider 专有类型串（DeepSeek 全家桶工具）：厂商名进 native，canonical 名保持稳定名
    if (name === undefined && profile?.builtinToolCanonicalName !== undefined) {
      name = profile.builtinToolCanonicalName(providerToolType);
    }
    if (name === undefined) return undefined;

    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'type' || k === 'name') continue;
      config[k] = v;
    }
    const builtin: BuiltinTool = {
      type: 'builtin',
      name,
      config,
      native: { provider_tool_type: providerToolType },
    };
    // 上游原生支持 → 执行者是 provider；这一点从 wire 上看不出来，留给能力矩阵/路由补。
    builtin.executor = 'provider';
    return builtin;
  }

  /**
   * `tool_choice` → canonical `ToolChoice`。
   *
   * 认不出的 `type` 时不静默丢弃：整个键退回 `raw.unmapped`（10 §7 顶层未建模字段）。
   * **不修改入参对象**——`decode` 的 raw 是调用方解析出来的 JSON，改它会污染上游数据。
   */
  private decodeToolChoice(toolChoice: unknown): {
    choice: ToolChoice | undefined;
    unmappable: unknown;
  } {
    const tc = asRecord(toolChoice);
    if (tc === undefined) return { choice: undefined, unmappable: undefined };
    switch (asString(tc['type'])) {
      case 'auto':
        return { choice: 'auto', unmappable: undefined };
      case 'any':
        // OpenAI 的 "required" 在 Anthropic 是 `any`（10 §4.3 映射注意）。
        return { choice: 'required', unmappable: undefined };
      case 'none':
        return { choice: 'none', unmappable: undefined };
      case 'tool':
        return {
          choice: { type: 'tool', name: asString(tc['name']) ?? '' },
          unmappable: undefined,
        };
      case 'builtin':
        return {
          choice: { type: 'builtin', name: asString(tc['name']) ?? '' },
          unmappable: undefined,
        };
      default: {
        this.logger?.warn('anthropic.messages decode: 未识别的 tool_choice.type', {
          type: String(tc['type']),
        });
        return { choice: undefined, unmappable: toolChoice };
      }
    }
  }

  private decodeParams(body: Record<string, unknown>): ChatParams | undefined {
    const params: ChatParams = {};
    const maxTokens = asNumber(body['max_tokens']);
    if (maxTokens !== undefined) params.max_output_tokens = maxTokens;
    const temperature = asNumber(body['temperature']);
    if (temperature !== undefined) params.temperature = temperature;
    const topP = asNumber(body['top_p']);
    if (topP !== undefined) params.top_p = topP;
    const topK = asNumber(body['top_k']);
    if (topK !== undefined) params.top_k = topK;
    const stop = asArray(body['stop_sequences']);
    if (stop !== undefined && stop.length > 0) {
      params.stop = stop.filter((s): s is string => typeof s === 'string');
    }
    const metadata = asRecord(body['metadata']);
    if (metadata !== undefined) params.metadata = { ...(metadata as Record<string, string>) };

    const thinking = this.decodeThinking(body['thinking']);
    if (thinking !== undefined) params.thinking = thinking;

    applyClientProviderOptions(body, params);

    return Object.keys(params).length > 0 ? params : undefined;
  }

  /**
   * `thinking:{type:"enabled"|"adaptive", budget_tokens?}` → `ThinkingConfig`。
   *
   * 可逆性靠一个约定：`enabled` 表达开/关，`budget_tokens` 有值 → `enabled`，无值 → `adaptive`
   * （40 §2.2b：`enabled` 是 legacy 形态且**必须**配 budget_tokens，`adaptive` 没有该字段）。
   * 边界：wire 上畸形的 `{type:"enabled"}`（缺 budget_tokens）会被归一成 `adaptive`。
   */
  private decodeThinking(thinking: unknown): ThinkingConfig | undefined {
    const t = asRecord(thinking);
    if (t === undefined) return undefined;
    // `type: "disabled"` 是显式关推理（Anthropic 本家的合法值，DeepSeek 的兼容面同样
    // 认它）。之前只读 budget_tokens、恒定 enabled:true，会把「关」静默吞成「开」——
    // 跨方言转到 DeepSeek OpenAI 面时尤其致命：那边省略 thinking 就是默认开。
    if (asString(t['type']) === 'disabled') return { enabled: false };
    const budgetTokens = asNumber(t['budget_tokens']);
    const out: ThinkingConfig = { enabled: true };
    if (budgetTokens !== undefined) out.budget_tokens = budgetTokens;
    return out;
  }

  // =========================================================================
  // 请求：canonical → 上游格式（Anthropic wire）
  // =========================================================================

  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest {
    // ---- fast path 短路（20 §4.2：不做任何结构转换，原始字节透传）----
    if (ctx.fast_path === true) {
      const rawBytes = this.rawBodyBytes(ctx);
      if (rawBytes !== undefined) {
        return {
          body: undefined,
          raw_bytes: rawBytes,
          fast_path: true,
          path: this.endpointPathFor(ctx),
          headers: { 'anthropic-version': ANTHROPIC_API_VERSION },
        };
      }
      // 拿不到原始字节时不能假装透传（会把空 body 发给上游）——退化为完整编码并说明原因。
      this.logger?.warn(
        'anthropic.messages encode: fast_path 但 ctx.state 里没有原始字节，退回完整编码',
        {
          request_id: ctx.request_id,
        },
      );
    }

    // `payload` 在类型上是 `ModalityPayload`——信封的 `kind` 与 `payload` 是两个独立属性、
    // 不是判别式联合（10 §3.2 第 7 条硬约束：新增模态不改信封），ir/guards.ts 的
    // `asChatPayload` 就是为这个形状准备的。本 adaptor 的 decode 保证 kind === "chat"。
    const payload = asChatPayload(req) ?? { messages: [] };

    const body: Record<string, unknown> = {
      // S2 路由后 resolved_model 是 provider 侧真实 id；缺省回落到客户端请求的 model。
      model: req.resolved_model ?? req.model,
    };

    const sameFormat = req.source_format === undefined || req.source_format === this.format;

    const params = payload.params;
    if (params?.max_output_tokens !== undefined) {
      body['max_tokens'] = params.max_output_tokens;
    }

    const system = this.encodeSystem(payload.system, sameFormat);
    if (system !== undefined) body['system'] = system;

    const diagnostics: ConversionDiagnostic[] = [];
    const dropped: string[] = [];
    const warnings: string[] = [];

    // ---- 上游声明的行为约束（DeepSeek /models 的 api_capabilities.anthropic_messages）----
    // system_prompt_update 决定"历史中的 system 消息"怎么办；tool_update 决定"中途增删
    // 工具"怎么办。没有约束声明（Anthropic 本家等）时走本文件的历史默认行为。
    const constraints = this.constraintsFor(ctx, req.resolved_model ?? req.model);
    const systemHandling = this.enforceSystemPromptConstraint(
      payload,
      constraints?.system_prompt_update,
      body,
      ctx,
      diagnostics,
      warnings,
      dropped,
    );

    body['messages'] = payload.messages
      .filter((m) => !(systemHandling.merged && m.role === 'system'))
      .map((m) => this.encodeMessage(m, systemHandling.allowSystemRole, sameFormat));

    const tools = this.encodeTools(payload.tools, this.profileFor(ctx), sameFormat);
    if (tools !== undefined) body['tools'] = tools;

    this.enforceToolUpdateConstraint(
      payload,
      constraints?.tool_update,
      ctx,
      warnings,
      diagnostics,
      dropped,
    );

    const toolChoice = this.encodeToolChoice(payload.tool_choice);
    if (toolChoice !== undefined) body['tool_choice'] = toolChoice;

    if (params !== undefined) {
      const encodedParams = this.encodeParams(params, ctx);
      Object.assign(body, encodedParams.body);
      diagnostics.push(...encodedParams.diagnostics);
      dropped.push(...encodedParams.dropped);
      warnings.push(...encodedParams.warnings);
    } else {
      // Anthropic 的 max_tokens 是**必填**（10 §9.1 标注"必填"），缺了上游必然 400。
      warnings.push('max_output_tokens_missing');
      diagnostics.push(
        this.diag(
          ctx,
          'max_output_tokens_missing',
          'params.max_output_tokens',
          'warning',
          'Anthropic 要求 max_tokens 必填，canonical 未提供 params.max_output_tokens，本次请求可能被上游 400 拒绝',
        ),
      );
    }

    // 跨格式（如 OpenAI Chat/Responses → Anthropic Messages）未传 max_output_tokens 时，
    // 为 Anthropic 必填的 max_tokens 补齐安全默认值，避免上游 422 Field required。
    if (!sameFormat && body['max_tokens'] === undefined) {
      body['max_tokens'] = 8192;
    }

    if (req.stream?.enabled === true) body['stream'] = true;

    applyNativeVendorOptions({
      native: params?.native,
      acceptedVendors: ['anthropic'],
      body,
      protectedKeys: new Set(['model', 'messages', 'system']),
      mergeObjectKeys: new Set(['thinking', 'metadata', 'output_config']),
      sourceFormat: req.source_format,
      targetFormat: this.format,
      dropped,
      warnings,
      diagnostics,
    });

    // 反向 passthrough（10 §7.2 回写规则第 3 条）：raw.unmapped 里来自 anthropic 的键原样写回。
    const unmapped = this.encodeUnmapped(req.raw);
    for (const [k, v] of Object.entries(unmapped)) {
      if (k in body) continue; // 建模字段永远赢
      body[k] = v;
    }

    return {
      body,
      fast_path: false,
      path: this.endpointPathFor(ctx),
      headers: { 'anthropic-version': ANTHROPIC_API_VERSION },
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
      ...(dropped.length > 0 ? { dropped } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private rawBodyBytes(ctx: RequestContext): Buffer | undefined {
    const raw = ctx.state[CTX_STATE_KEYS.RAW_BODY];
    if (raw instanceof Buffer) return raw;
    if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
    if (raw instanceof Uint8Array) return Buffer.from(raw);
    return undefined;
  }

  private encodeSystem(
    system: SystemBlock[] | undefined,
    sameFormat = true,
  ): Array<Record<string, unknown>> | undefined {
    if (system === undefined || system.length === 0) return undefined;
    return system.map((block) => {
      const wire: Record<string, unknown> = { type: 'text', text: block.text };
      const cc = this.encodeCacheControl(block.cache_control);
      if (cc !== undefined) wire['cache_control'] = cc;
      return applyRaw(wire, block._raw, sameFormat);
    });
  }

  /**
   * **上游约束执行①：`system_prompt_update`**（DeepSeek /models 的 api_capabilities）。
   *
   * 官方语义（https://api-docs.deepseek.com/api/list-models ）：
   *   - `leading-only`：只有对话**开头**的 system prompt 生效；历史中后出现的 system
   *     消息不被当作系统提示更新。→ 合规转换：把历史里的 system 消息**按顺序合并进
   *     开头的 system 字段**（官方给的改法就是"改开头那条"），并记诊断。绝不禁默
   *     发一条上游会忽略的 system 消息。
   *   - `in-history`：system 消息可以追加进历史，**最后一条**提供完整生效的系统提示。
   *     → 合规转换：原样透传 system-role 消息（DeepSeek 的 Messages 面认这个形态），
   *     不折叠进 user。
   *   - 无声明（Anthropic 本家等）：历史默认行为——折叠进 user + 告警。
   *
   * 返回 `merged: true` 表示历史里的 system 消息已被合并掉，调用方要把它们从
   * messages 里过滤（否则同一份内容会出现两次）。
   */
  private enforceSystemPromptConstraint(
    payload: ChatPayload,
    mode: 'leading-only' | 'in-history' | undefined,
    body: Record<string, unknown>,
    ctx: RequestContext,
    diagnostics: ConversionDiagnostic[],
    warnings: string[],
    dropped: string[],
  ): { merged: boolean; allowSystemRole: boolean } {
    const historySystem = payload.messages.filter((m) => m.role === 'system');
    if (historySystem.length === 0) return { merged: false, allowSystemRole: false };

    if (mode === 'in-history') {
      // 上游认历史中的 system 消息：原样透传（role 保持 system）
      return { merged: false, allowSystemRole: true };
    }

    if (mode === 'leading-only') {
      // 合规转换：合并进开头的 system 字段（按历史顺序拼在既有 system 之后）
      const leading = Array.isArray(body['system'])
        ? (body['system'] as Array<Record<string, unknown>>)
        : [];
      const merged: Array<Record<string, unknown>> = [...leading];
      for (const m of historySystem) {
        const text = m.parts
          .filter((p): p is TextPart => p.type === 'text')
          .map((p) => p.text)
          .join('');
        if (text !== '') merged.push({ type: 'text', text });
      }
      body['system'] = merged;
      const code = 'system_prompt_merged_leading_only';
      warnings.push(code);
      dropped.push('messages[].role=system');
      diagnostics.push(
        this.diag(
          ctx,
          code,
          'messages[].role=system',
          'warning',
          `上游约束 system_prompt_update=leading-only：历史中 ${historySystem.length} 条 system 消息已按顺序合并进开头的 system 字段` +
            '（官方口径：只有开头的系统提示生效，要改系统提示只能改开头那条）',
        ),
      );
      return { merged: true, allowSystemRole: false };
    }

    // 无约束声明：历史默认行为（折叠进 user + 告警）——由 encodeRole 负责
    return { merged: false, allowSystemRole: false };
  }

  /**
   * **上游约束执行②：`tool_update`**（DeepSeek /models 的 api_capabilities）。
   *
   * 判据：历史回合里被调用过的工具（tool_use.name）是否仍在本次请求的 tools 声明里。
   *   - `addition-only`（flash）：后续轮次只能新增工具。**移除**历史调用过的工具 →
   *     明确报错（抛 canonical 错误）：网关无法凭空补回它的 schema，静默发过去上游
   *     会面对一个"引用了未声明工具"的历史，行为不可预期。
   *   - `leading-only`（v4-pro）：只有首次请求的工具声明生效，后续变更被上游忽略 →
   *     记 warning 诊断（客户端会以为新工具可用，实际不会），不抛错。
   *   - 无声明：不检查。
   */
  private enforceToolUpdateConstraint(
    payload: ChatPayload,
    mode: 'leading-only' | 'addition-only' | undefined,
    ctx: RequestContext,
    warnings: string[],
    diagnostics: ConversionDiagnostic[],
    dropped: string[],
  ): void {
    if (mode === undefined) return;
    const historyTools = new Set<string>();
    for (const m of payload.messages) {
      for (const part of m.parts) {
        if (part.type === 'tool_use' && part.name !== '') historyTools.add(part.name);
      }
    }
    if (historyTools.size === 0) return;
    const declared = new Set(
      (payload.tools ?? [])
        .filter((t): t is FunctionTool => t.type === 'function')
        .map((t) => t.name),
    );
    const removed = [...historyTools].filter((name) => !declared.has(name));
    if (removed.length === 0) return;

    if (mode === 'addition-only') {
      throw createCanonicalError(
        'capability_unsupported',
        `上游约束 tool_update=addition-only 不允许移除历史回合已调用过的工具: ${removed.join(', ')}。` +
          '网关无法补回这些工具的 schema，静默发出会让上游面对"引用未声明工具"的历史',
        ctx.request_id,
        { http_status: 400, retryable: false, field_path: 'tools' },
      );
    }

    const code = 'tool_update_leading_only';
    warnings.push(code);
    dropped.push('tools');
    diagnostics.push(
      this.diag(
        ctx,
        code,
        'tools',
        'warning',
        `上游约束 tool_update=leading-only：只有对话首次请求的工具声明生效，本次变更（移除 ${removed.join(', ')}）会被上游忽略`,
      ),
    );
  }

  /**
   * canonical message → Anthropic message。
   *
   * **D7c 硬约束**：`tool_use` block 必须移到段尾。Anthropic 要求 assistant 消息里
   * tool_use 排在所有文本块之后（AI SDK 有 `moveToolUseBlocksToEnd()` 专门处理这个约束，
   * 见 10 §4.2 D7c 与 40 §7.2）。canonical 的 parts 顺序是客户端原样，不保证满足该约束，
   * 因此这里统一重排。
   *
   * `allowSystemRole`：上游声明 `system_prompt_update=in-history` 时，历史里的
   * system-role 消息**原样透传**（DeepSeek 的 Messages 面认这个形态）；否则按历史
   * 行为折叠进 user + 告警。
   */
  private encodeMessage(
    message: CanonicalMessage,
    allowSystemRole = false,
    sameFormat = true,
  ): Record<string, unknown> {
    const parts: Array<Record<string, unknown>> = [];
    for (const part of moveToolUseBlocksToEnd(message.parts)) {
      const wire = this.encodePart(part, sameFormat);
      if (wire === undefined) {
        // 10 §9.1：audio / video / asset 媒体在 Anthropic 无对应 → drop + 告警，不静默。
        this.logger?.warn('anthropic.messages encode: part 无法映射到 Anthropic block，已丢弃', {
          type: part.type,
        });
        continue;
      }
      parts.push(wire);
    }
    const wire: Record<string, unknown> = {
      role: this.encodeRole(message.role, allowSystemRole),
      content: parts,
    };
    const id = message.id;
    if (id !== undefined) wire['id'] = id;
    return applyRaw(wire, message._raw, sameFormat);
  }

  /**
   * canonical role → Anthropic role。
   *
   * Anthropic 只有 `user` / `assistant` 两个值（`system` 是顶层字段、工具结果是 user 消息里的
   * `tool_result` block）。OpenAI 风格的 `system` / `tool` role 只能折叠进 user，且必须显式告警。
   */
  private encodeRole(
    role: CanonicalMessage['role'],
    allowSystemRole = false,
  ): 'user' | 'assistant' | 'system' {
    if (role === 'assistant') return 'assistant';
    if (role === 'user') return 'user';
    // 上游声明 system_prompt_update=in-history 时，历史里的 system-role 消息原样透传
    if (role === 'system' && allowSystemRole) return 'system';
    this.logger?.warn('anthropic.messages encode: role 折叠为 user', { role });
    return 'user';
  }

  /**
   * canonical `Part` → Anthropic content block。
   *
   * 返回 `undefined` 表示"这个 part 在 Anthropic 上没有对应形态"——由调用方丢弃并告警，
   * **不**偷偷换成一个空 text block（那会让上游以为模型说了空话）。
   */
  private encodePart(part: Part, sameFormat = true): Record<string, unknown> | undefined {
    switch (part.type) {
      case 'text': {
        const wire: Record<string, unknown> = { type: 'text', text: part.text };
        const cc = this.encodeCacheControl(part.cache_control);
        if (cc !== undefined) wire['cache_control'] = cc;
        return applyRaw(wire, part._raw, sameFormat);
      }
      case 'image': {
        const source = this.encodeMedia(part.source);
        if (source === undefined) return undefined;
        return applyRaw({ type: 'image', source }, part._raw, sameFormat);
      }
      case 'document': {
        const source = this.encodeMedia(part.source);
        if (source === undefined) return undefined;
        const wire: Record<string, unknown> = { type: 'document', source };
        if (part.title !== undefined) wire['title'] = part.title;
        return applyRaw(wire, part._raw, sameFormat);
      }
      case 'tool_use': {
        // 10 §7.3：回写时**优先用 raw_arguments**，不要 JSON.stringify(input)——
        // 畸形 tool 参数被静默替换成 "{}" 是已开源实现的真实缺陷。
        const input =
          part.raw_arguments !== undefined
            ? (tryParseJson(part.raw_arguments) ?? part.raw_arguments)
            : part.input;
        return applyRaw({ type: 'tool_use', id: part.id, name: part.name, input }, part._raw, sameFormat);
      }
      case 'tool_result': {
        const wire: Record<string, unknown> = {
          type: 'tool_result',
          tool_use_id: part.tool_use_id,
          content:
            typeof part.content === 'string'
              ? part.content
              : part.content
                  .map((inner) => this.encodePart(inner, sameFormat))
                  .filter((block): block is Record<string, unknown> => block !== undefined),
        };
        if (part.is_error !== undefined) wire['is_error'] = part.is_error;
        return applyRaw(wire, part._raw, sameFormat);
      }
      case 'thinking': {
        const wire: Record<string, unknown> = { type: 'thinking', thinking: part.thinking };
        if (part.signature !== undefined) wire['signature'] = part.signature;
        return applyRaw(wire, part._raw, sameFormat);
      }
      case 'redacted_thinking':
        return applyRaw({ type: 'redacted_thinking', data: part.data }, part._raw, sameFormat);
      case 'search_result': {
        const wire: Record<string, unknown> = {
          type: 'search_result',
          title: part.title,
          url: part.url,
        };
        // snippet 在 wire 上叫 content；source 缺省值 "anthropic" 不回写（往返不引入噪声）。
        wire['content'] = part.snippet;
        if (part.source !== 'anthropic') wire['source'] = part.source;
        if (part.citation_index !== undefined) wire['citation_index'] = part.citation_index;
        if (part.score !== undefined) wire['score'] = part.score;
        if (part.published_at !== undefined) wire['published_at'] = part.published_at;
        return applyRaw(wire, part._raw, sameFormat);
      }
      case 'refusal':
        // Anthropic 没有 refusal block；拒答在响应侧是 stop_reason:"refusal"。
        // 请求侧出现 canonical RefusalPart 时降级成 text，保住可读内容。
        return { type: 'text', text: part.reason };
      case 'audio':
      case 'video':
        // 10 §9.1：Anthropic 无对应 → drop（调用方记 warning）。
        return undefined;
      case 'unknown':
        return this.encodeUnknownPart(part);
    }
  }

  private encodeUnknownPart(part: UnknownPart): Record<string, unknown> {
    const raw = asRecord(part.raw) ?? {};
    const wire: Record<string, unknown> = { ...raw };
    if (part.raw_type !== undefined) wire['type'] = part.raw_type;
    return wire;
  }

  private encodeMedia(source: MediaRef): Record<string, unknown> | undefined {
    if (source.kind === 'inline') {
      return { type: 'base64', media_type: source.mime, data: source.data };
    }
    if (source.kind === 'uri') {
      const wire: Record<string, unknown> = { type: 'url', url: source.uri };
      if (source.fetch_by_gateway !== undefined) wire['fetch_by_gateway'] = source.fetch_by_gateway;
      return wire;
    }
    // AssetMedia：Anthropic 没有 asset 引用形态，调用方记 warning 后丢弃。
    return undefined;
  }

  private encodeCacheControl(cc: CacheControl | undefined): Record<string, unknown> | undefined {
    if (cc === undefined) return undefined;
    const wire: Record<string, unknown> = { type: 'ephemeral' };
    if (cc.ttl !== undefined) wire['ttl'] = cc.ttl;
    // CacheControl.cache_name 是 Gemini 专有（10 §4.4），Anthropic 无对应，丢弃。
    return wire;
  }

  private encodeTools(
    tools: CanonicalTool[] | undefined,
    profile: ProviderProfile | undefined,
    sameFormat = true,
  ): Array<Record<string, unknown>> | undefined {
    if (tools === undefined || tools.length === 0) return undefined;
    const out: Array<Record<string, unknown>> = [];
    for (const tool of tools) {
      if (tool.type === 'builtin') {
        out.push(this.encodeBuiltinTool(tool, profile, sameFormat));
        continue;
      }
      const wire: Record<string, unknown> = {
        name: tool.name,
        // Anthropic 的 function tool **没有** `type` 字段（10 §9.1 的 Anthropic 列只写 input_schema）。
        input_schema: tool.parameters,
      };
      if (tool.description !== undefined) wire['description'] = tool.description;
      const cc = this.encodeCacheControl(tool.cache_control);
      if (cc !== undefined) wire['cache_control'] = cc;
      // FunctionTool.strict 是 OpenAI 专有（10 §9.1 "无对应"），丢弃。
      out.push(applyRaw(wire, tool._raw, sameFormat));
    }
    return out;
  }

  /**
   * `BuiltinTool` → Anthropic server tool。
   *
   * `type` 的来源优先级（从高到低）：
   *   1. **provider profile 的 `builtinToolWire`**：目标 access path 的方言映射——
   *      DeepSeek 的 Messages 面要 `{type:"deepseek_web_search",name:"deepseek_web_search"}`，
   *      而 Anthropic 本家的 `web_search_20260318` 在 DeepSeek 上并不存在。目标方言
   *      的表达优先于来源方言的原文（10 §7.2 回写规则第 1 条：原样回写只在同
   *      provider 时成立，跨 provider 时原文是别家的枚举值）；
   *   2. `native.provider_tool_type`：decode 时留住的来源原文（同 provider 回写时保真；
   *      没有 profile 的 access path——anthropic 本家——走这条）；
   *   3. `DEFAULT_PROVIDER_TOOL_TYPE`：按 canonical 名猜一个当前版本串并告警
   *      （版本串会演进，见 10 §9.4）。
   * `name` 字段同理：profile 要求 name 等于 type 串时按 profile（DeepSeek Messages
   * 面的硬性要求），否则用 canonical 稳定名。
   */
  private encodeBuiltinTool(
    tool: BuiltinTool,
    profile: ProviderProfile | undefined,
    sameFormat = true,
  ): Record<string, unknown> {
    const wire = profile?.builtinToolWire?.(tool.name, this.format);
    const providerToolType =
      wire?.type ??
      asString(tool.native?.['provider_tool_type']) ??
      DEFAULT_PROVIDER_TOOL_TYPE[tool.name];
    const acceptsConfig = profile?.builtinToolAcceptsConfig?.(tool.name) ?? true;
    if (!acceptsConfig && Object.keys(tool.config).length > 0) {
      // provider 明确不吃配置（DeepSeek 的 web 工具是裸开关，带配置字段上游 400）：
      // 丢弃 + 日志，不静默发过去。
      this.logger?.warn('anthropic.messages encode: builtin tool 配置字段不被上游支持，已丢弃', {
        tool: tool.name,
        access_path_hint: profile?.id,
        dropped: Object.keys(tool.config),
      });
    }
    const out: Record<string, unknown> = {
      type: providerToolType,
      name: wire?.name ?? tool.name,
      ...(acceptsConfig ? tool.config : {}),
    };
    return applyRaw(out, tool._raw, sameFormat);
  }

  private encodeToolChoice(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
    if (choice === undefined) return undefined;
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    if (choice.type === 'tool') return { type: 'tool', name: choice.name };
    // {type:"builtin", name}：Anthropic 没有"强制某个内置工具"的档位，就近映射成强制该名字的
    // 普通 tool（50 §3.1 表格同立场），并显式告警。
    this.logger?.warn('anthropic.messages encode: tool_choice.builtin 降级为 tool', {
      name: choice.name,
    });
    return { type: 'tool', name: choice.name };
  }

  /**
   * canonical `ChatParams` → Anthropic 顶层参数字段。
   *
   * 方向：canonical → 上游格式。
   *
   * 40 §2.2b：API version `2026-10-21` 起 `temperature` / `top_p` / `top_k` **发送即 400**，
   * 必须丢弃 + `warnings += "temperature_unsupported"`（原话）。这是"canonical 是超集、
   * adaptor 按需丢弃"的典型例证（10 §9.4 同表）。
   */
  private encodeParams(
    params: ChatParams,
    ctx: RequestContext,
  ): {
    body: Record<string, unknown>;
    diagnostics: ConversionDiagnostic[];
    dropped: string[];
    warnings: string[];
  } {
    const body: Record<string, unknown> = {};
    const diagnostics: ConversionDiagnostic[] = [];
    const dropped: string[] = [];
    const warnings: string[] = [];

    if (params.max_output_tokens !== undefined) {
      body['max_tokens'] = params.max_output_tokens;
    } else {
      warnings.push('max_output_tokens_missing');
      diagnostics.push(
        this.diag(
          ctx,
          'max_output_tokens_missing',
          'params.max_output_tokens',
          'warning',
          'Anthropic 要求 max_tokens 必填，canonical 未提供 params.max_output_tokens',
        ),
      );
    }

    // ---- 40 §2.2b：三个采样参数在 2026-10-21 上发送即 400 ----
    const sampling: ReadonlyArray<readonly [keyof ChatParams, string]> = [
      ['temperature', 'params.temperature'],
      ['top_p', 'params.top_p'],
      ['top_k', 'params.top_k'],
    ];
    for (const [field, fieldPath] of sampling) {
      if (params[field] === undefined) continue;
      warnings.push('temperature_unsupported');
      dropped.push(fieldPath);
      diagnostics.push(
        this.diag(
          ctx,
          'temperature_unsupported',
          fieldPath,
          'warning',
          `Anthropic API version ${ANTHROPIC_API_VERSION} 已移除 ${String(field)}，发送即 400，本次编码丢弃该字段（40 §2.2b）`,
        ),
      );
    }

    if (params.stop !== undefined && params.stop.length > 0) {
      body['stop_sequences'] = [...params.stop];
    }

    if (params.metadata !== undefined) {
      body['metadata'] = { ...params.metadata };
    }

    const thinking = this.encodeThinking(params.thinking);
    if (thinking.body !== undefined) body['thinking'] = thinking.body;
    diagnostics.push(...thinking.diagnostics);
    dropped.push(...thinking.dropped);
    warnings.push(...thinking.warnings);

    // ---- 10 §9.1：Anthropic 无对应的 canonical 能力，逐个 drop + warning ----
    const unsupported: ReadonlyArray<readonly [keyof ChatParams, string, string]> = [
      ['seed', 'params.seed', 'Anthropic Messages 没有 seed 参数（10 §9.1）'],
      [
        'frequency_penalty',
        'params.frequency_penalty',
        'Anthropic Messages 没有 frequency_penalty（10 §9.1）',
      ],
      [
        'presence_penalty',
        'params.presence_penalty',
        'Anthropic Messages 没有 presence_penalty（10 §9.1）',
      ],
      ['logprobs', 'params.logprobs', 'Anthropic Messages 没有 logprobs（10 §9.1）'],
      ['top_logprobs', 'params.top_logprobs', 'Anthropic Messages 没有 top_logprobs（10 §9.1）'],
      ['n', 'params.n', 'Anthropic 候选数恒为 1，不支持 n（10 §9.1）'],
      [
        'user',
        'params.user',
        'Anthropic 用 metadata.user_id，canonical params.user 无对应字段（10 §9.1 未列）',
      ],
      ['service_tier', 'params.service_tier', 'Anthropic 没有 service_tier 参数（10 §9.1）'],
      ['safety', 'params.safety', 'safetySettings 是 Gemini 专有（10 §9.1）'],
      [
        'parallel_tool_calls',
        'params.parallel_tool_calls',
        'Anthropic 无对应，只能靠 prompt 约束（40 §7.1）',
      ],
    ];
    for (const [field, fieldPath, message] of unsupported) {
      if (params[field] === undefined) continue;
      warnings.push(`${String(field)}_unsupported`);
      dropped.push(fieldPath);
      diagnostics.push(
        this.diag(ctx, `${String(field)}_unsupported`, fieldPath, 'warning', message),
      );
    }

    // response_format：10 §9.1 原文"无对应（靠 prompt）"。
    if (params.response_format !== undefined) {
      warnings.push('response_format_unsupported');
      dropped.push('params.response_format');
      diagnostics.push(
        this.diag(
          ctx,
          'response_format_unsupported',
          'params.response_format',
          'warning',
          'Anthropic Messages 没有结构化输出参数，10 §9.1 标注「无对应（靠 prompt）」，本次编码丢弃该字段',
        ),
      );
    }

    return { body, diagnostics, dropped, warnings };
  }

  /**
   * canonical `ThinkingConfig` → Anthropic `thinking`。
   *
   * 方向：canonical → 上游格式。
   *
   * 两条规则：
   *   1. **`effort: "none"` 表示"关推理"**——OpenAI 的 `reasoning_effort:"none"` 就是这个语义
   *      （GPT-5.4 起仅 none 支持工具调用）。canonical 的开关是 `ThinkingConfig.enabled`，
   *      所以 `enabled = effort !== "none"`：effort 为 none 时即使调用方把 `enabled` 写成
   *      true，也按"关"处理（否则 Anthropic 侧会收到一个 budget_tokens 的 thinking，
   *      与客户端"不要推理"的意图相反）。这条归一化放在 `normalizeThinkingEnabled()` 里，
   *      encodeThinking 与后续任何读取方共用。
   *   2. `effort`（离散）在 budget_tokens 世界里**没有**等价物，按 40 §3.2 的阈值表换算，
   *      并记一条 warning 说明用了哪一档（10 §4.4 映射注意的原话）。
   */
  private encodeThinking(thinking: ThinkingConfig | undefined): {
    body?: Record<string, unknown>;
    diagnostics: ConversionDiagnostic[];
    dropped: string[];
    warnings: string[];
  } {
    const empty = { diagnostics: [], dropped: [], warnings: [] };
    if (thinking === undefined) return empty;
    if (!normalizeThinkingEnabled(thinking)) {
      // Anthropic 的"关闭思考"就是**不传** thinking 字段。
      return { ...empty, warnings: ['thinking_disabled'] };
    }
    if (thinking.budget_tokens !== undefined) {
      return { body: { type: 'enabled', budget_tokens: thinking.budget_tokens }, ...empty };
    }
    if (thinking.effort === undefined) {
      // 既无预算也无档位：交给上游自适应（40 §2.2b：adaptive 是 enabled 的演进形态）。
      return { body: { type: 'adaptive' }, ...empty };
    }
    // effort === 'none' 已在 normalizeThinkingEnabled 里被归一成"关"，到不了这里。
    // 再收窄一次键类型，让 TS 知道索引 EFFORT_TO_BUDGET_TOKENS 的键一定存在
    // （该表故意不含 'none'——"关推理"没有对应的 budget）。
    const effort: Exclude<
      NonNullable<ThinkingConfig['effort']>,
      'none'
    > = thinking.effort as Exclude<NonNullable<ThinkingConfig['effort']>, 'none'>;
    const budgetTokens = EFFORT_TO_BUDGET_TOKENS[effort];
    return {
      body: { type: 'enabled', budget_tokens: budgetTokens },
      diagnostics: [],
      dropped: [],
      warnings: [`thinking_effort_to_budget_tokens:${effort}->${budgetTokens}`],
    };
  }

  /**
   * 反向 passthrough：`raw.unmapped` 里来自 anthropic 的键原样写回（10 §7.2 回写规则第 3 条）。
   *
   * 只回写"来源就是 anthropic"的键——跨 provider 转过来时，把 OpenAI 的未知顶层字段塞进
   * Anthropic 请求体有 400 风险（20 §9 待验证 5：透传未知顶层字段是否安全尚未实测）。
   */
  private encodeUnmapped(raw: CanonicalRequestEnvelope['raw']): Record<string, unknown> {
    const sourceProvider = raw.source_provider;
    if (sourceProvider !== undefined && sourceProvider !== 'anthropic') return {};
    const unmapped = filterUnmappedForPassthrough(asRecord(raw.unmapped));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(unmapped)) {
      out[k] = v;
    }
    return out;
  }

  private diag(
    ctx: RequestContext,
    code: string,
    fieldPath: string,
    level: ConversionDiagnostic['level'],
    message: string,
  ): ConversionDiagnostic {
    // from = 客户端格式、to = 上游格式；与 S4 记的 conversion_chain 同一坐标系。
    return {
      code,
      field_path: fieldPath,
      from: ctx.client_format,
      to: this.format,
      level,
      message,
    };
  }

  // =========================================================================
  // 响应：客户端格式（Anthropic wire）→ canonical
  // =========================================================================

  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope {
    const obj = asRecord(raw) ?? {};
    const warnings: string[] = [];

    const parts = (asArray(obj['content']) ?? []).map((block) => this.decodePart(block));
    const message: CanonicalMessage = { role: 'assistant', parts };
    const messageId = asString(obj['id']);
    if (messageId !== undefined) message.id = messageId;
    const model = asString(obj['model']);

    const payload: ChatResponsePayload = { message };
    if (model !== undefined) payload.model = model;

    const usage = this.extractUsage(obj);
    if (usage.units.tokens === undefined) {
      // 10 §6.1 规则 2 / 40 §2.2c："未知"绝不用 0 表示——键省略 + usage_missing。
      warnings.push('usage_missing');
    } else if (
      asNumber(asRecord(asRecord(obj['usage'])?.['output_tokens_details'])?.['thinking_tokens']) !==
      undefined
    ) {
      // 40 §2.2 I2：thinking_tokens **已计入** output_tokens，另记一条告警防止下游双算。
      warnings.push('reasoning_in_output');
    }

    const providerFinishReason = asString(obj['stop_reason']);
    const finishReason = this.normalizeFinishReason(obj);
    if (finishReason === 'other' && providerFinishReason !== undefined) {
      // 10 §9.3 注意 2：未命中不得默认 stop，必须 other + 保留原文 + 告警。
      warnings.push(`unmapped_finish_reason:${providerFinishReason}`);
    }

    const unmapped = extraKeys(obj, [
      'id',
      'type',
      'role',
      'model',
      'content',
      'stop_reason',
      'stop_sequence',
      'usage',
    ]);

    return {
      ir_version: IR_VERSION,
      kind: 'chat',
      request_id: ctx.request_id,
      usage,
      finish_reason: finishReason,
      payload,
      warnings,
      raw: {
        source_provider: 'anthropic',
        // 10 §9.3 注意 3：finish_reason 双向可逆，原文进 `raw.finish_reason_provider`
        // （ir/envelope.ts 的一等字段，不再占用 unmapped）。
        ...(providerFinishReason === undefined
          ? {}
          : { finish_reason_provider: providerFinishReason }),
        ...(unmapped === undefined ? {} : { unmapped }),
      },
    };
  }

  /**
   * Anthropic `usage` → `CanonicalUsage`。
   *
   * 口径表：40 §2.1 的 Anthropic 列 + §2.2 的两条定论：
   *   - `input_tokens` **不含** cache 部分，总输入 = input + cache_creation + cache_read（I1）；
   *   - `reasoning_tokens = output_tokens_details.thinking_tokens`，且它**已计入** output_tokens，
   *     因此必须 `warnings += "reasoning_in_output"`（I2，避免双算）。
   *
   * I4：原始 usage 全量存档进 `usage.raw`，且这里是**独立对象**，不依赖任何 extra 透传机制。
   */
  extractUsage(raw: unknown): CanonicalUsage {
    const obj = asRecord(raw);
    const usage = obj === undefined ? undefined : asRecord(obj['usage']);
    if (usage === undefined) return { units: {}, source: 'provider' };

    const inputTokens = asNumber(usage['input_tokens']);
    const outputTokens = asNumber(usage['output_tokens']);
    const cacheRead = asNumber(usage['cache_read_input_tokens']);
    const cacheWrite = asNumber(usage['cache_creation_input_tokens']);
    const outputDetails = asRecord(usage['output_tokens_details']);
    const reasoning =
      outputDetails === undefined ? undefined : asNumber(outputDetails['thinking_tokens']);

    // 只要一个字段都没有，就整体省略 tokens（10 §6.1 规则 2），不拿 0 冒充已知。
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cacheRead === undefined &&
      cacheWrite === undefined &&
      reasoning === undefined
    ) {
      return { units: {}, raw: { ...usage }, source: 'provider' };
    }

    const input = inputTokens ?? 0;
    const output = outputTokens ?? 0;
    const cacheReadTokens = cacheRead ?? 0;
    const cacheWriteTokens = cacheWrite ?? 0;
    const details: Record<string, number> = {};
    const cacheCreation = asRecord(usage['cache_creation']);
    const ttl5m =
      cacheCreation === undefined
        ? undefined
        : asNumber(cacheCreation['ephemeral_5m_input_tokens']);
    const ttl1h =
      cacheCreation === undefined
        ? undefined
        : asNumber(cacheCreation['ephemeral_1h_input_tokens']);
    if (ttl5m !== undefined) details['cache_write_ttl_5m'] = ttl5m;
    if (ttl1h !== undefined) details['cache_write_ttl_1h'] = ttl1h;

    return {
      units: {
        tokens: {
          input_tokens: input,
          output_tokens: output,
          // Anthropic **不返回** total_tokens，按官方口径自算（40 §2.1 "需自算"）。
          total_tokens: input + cacheWriteTokens + cacheReadTokens + output,
          cache_read_tokens: cacheReadTokens,
          cache_write_tokens: cacheWriteTokens,
          // thinking_tokens 已计入 output_tokens，这里只做记录不另加（40 §2.2 I2）。
          reasoning_tokens: reasoning ?? 0,
          ...(Object.keys(details).length > 0 ? { details } : {}),
        },
      },
      // I4：逐字段保留上游原始 usage。
      raw: { ...usage },
      source: 'provider',
    };
  }

  /**
   * `stop_reason` 归一（wire → canonical）。
   *
   * 双留（10 §9.3 注意 3）：归一值在这里返回，原文由 `decodeResponse` 写进
   * `raw.unmapped[FINISH_REASON_PROVIDER_KEY]` 供回写与对账。
   *
   * 未命中 → `"other"`，**绝不默认 `stop`**（注意 2，反 LiteLLM 的教训）；
   * 对应的 `unmapped_finish_reason:<原文>` warning 由 `decodeResponse` 补（本方法没有 warning 通道）。
   */
  normalizeFinishReason(raw: unknown): NormalizedFinishReason {
    const provider = asString(asRecord(raw)?.['stop_reason']) ?? asString(raw);
    if (provider === undefined) return 'other';
    return FINISH_REASON_TO_CANONICAL[provider] ?? 'other';
  }

  // =========================================================================
  // 响应：canonical → 上游格式（Anthropic wire）
  // =========================================================================

  encodeResponse(res: CanonicalResponseEnvelope, _ctx: RequestContext): unknown {
    // 信封的 payload 不是判别式联合，按 kind === "chat" 收窄（见 asChatResponsePayload）。
    const payload = asChatResponsePayload(res) ?? {
      message: { role: 'assistant' as const, parts: [] },
    };

    // 错误信封（Runner 的 failureOutcome / 短路错误都会走到这儿）：按 20 §7.2 的 Anthropic 列
    // 产出 `{type:"error", error:{type, message}}`。Runner 的 errorEnvelope() 会把完整
    // CanonicalError 放进 `raw.nodes.error`，因此这里能填真实的 type/code 而不是保守兜底值。
    if (res.finish_reason === 'error') {
      return { type: 'error', error: anthropicErrorBody(res) };
    }

    // 同 encode：信封的 payload 不是判别式联合，按 kind === "chat" 收窄（见 asChatResponsePayload）。
    const body: Record<string, unknown> = {
      id: payload.message.id ?? res.request_id,
      type: 'message',
      role: 'assistant',
      model: payload.model ?? '',
      content: payload.message.parts
        .map((part) => this.encodePart(part))
        .filter((block): block is Record<string, unknown> => block !== undefined),
      stop_reason: this.encodeFinishReason(res),
    };

    const usage = res.usage.units.tokens;
    if (usage !== undefined) {
      body['usage'] = encodeWireUsage(res.usage);
    }

    // 反向 passthrough（10 §7.2 第 3 条）：未知顶层响应字段原样写回。
    // 注意：finish_reason 原文现在是 `raw.finish_reason_provider` 一等字段（ir/envelope.ts），
    // 不再占用 unmapped，因此这里不需要"显式排除合成键"那层防护。
    const unmapped = asRecord(res.raw.unmapped);
    if (unmapped !== undefined) {
      for (const [k, v] of Object.entries(unmapped)) {
        if (k in body) continue;
        body[k] = v;
      }
    }

    return body;
  }

  /**
   * canonical `finish_reason` → Anthropic `stop_reason`（canonical → 客户端格式）。
   *
   * **可逆性优先，但带同格式前提**（10 §9.3 注意 3 + §7.2 回写规则第 1 条）：
   * `raw.finish_reason_provider` 存的是**来源 provider** 的原文。只有能确认"这个原文就是
   * Anthropic 自己的取值"时才原样回写；跨格式来的原文（客户端 Anthropic、上游 OpenAI 时
   * 拿到的是 OpenAI 的 `"stop"`）**必须**按 §9.3 表反查成 `end_turn`——照抄会让客户端
   * 收到一个非法的 `stop_reason` 而解析失败。
   *
   * 判定用两条**并联**的充分条件（任一条成立即可信）：
   *   1. 原文在 `ANTHROPIC_STOP_REASONS` 里——它本身就是合法 Anthropic 取值；
   *   2. `raw.source_provider === 'anthropic'`——decode 侧记下来源就是 Anthropic，
   *      因此即使是我们还没认得的**未来新增值**（前向兼容场景），照抄也不会给出别家的枚举。
   *
   * 两条都不成立 → 走 §9.3 反查表；表里也没有 → `end_turn`（canonical 是超集，
   * Anthropic 没有对应值时只能就近落，调用方已通过 `unmapped_finish_reason` 被告知）。
   */
  private encodeFinishReason(res: CanonicalResponseEnvelope): string {
    const provider = asString(res.raw.finish_reason_provider);
    if (
      provider !== undefined &&
      isReusableAnthropicStopReason(provider, res.raw.source_provider)
    ) {
      return provider;
    }
    const normalized = res.finish_reason as NormalizedFinishReason;
    return CANONICAL_TO_FINISH_REASON[normalized] ?? 'end_turn';
  }

  // =========================================================================
  // 流式：客户端格式（Anthropic SSE）→ canonical 帧
  // =========================================================================

  decodeStream(stream: AsyncIterable<unknown>, ctx: RequestContext): AsyncIterable<StreamFrame> {
    return this.decodeAnthropicStream(stream, ctx);
  }

  private async *decodeAnthropicStream(
    stream: AsyncIterable<unknown>,
    ctx: RequestContext,
  ): AsyncGenerator<StreamFrame> {
    let seq = 0;
    let messageId: string | undefined;
    let model: string | undefined;
    let mergedUsage: TokenUsageAcc | undefined;
    let rawUsage: Record<string, unknown> | undefined;
    let finishReason: FinishReason = 'stop';
    let ended = false;
    /** index → 正在累积的 part（tool_use 的 input_json_delta 是分片到达的）。 */
    const openParts = new Map<number, OpenPart>();

    const nextSeq = (): number => {
      const v = seq;
      seq += 1;
      return v;
    };

    for await (const item of stream) {
      const ev = parseWireEvent(item);
      if (ev === undefined) continue;
      const type = ev.name ?? asString(ev.payload['type']);
      if (type === undefined) continue;

      switch (type) {
        case 'message_start': {
          const message = asRecord(ev.payload['message']);
          if (message !== undefined) {
            messageId = asString(message['id']);
            model = asString(message['model']);
            const usage = asRecord(message['usage']);
            if (usage !== undefined) {
              // 40 §2.3：Anthropic 的 usage 分 message_start（input + cache）与
              // message_delta（output + cache）**两次到达，必须合并**。
              rawUsage = { ...(rawUsage ?? {}), ...usage };
              mergedUsage = mergeUsage(mergedUsage, tokenUsageFromWire(usage));
            }
          }
          const startData: StartData = {
            model: model ?? '',
            client_format: ctx.client_format,
            provider_format: ctx.provider_format,
          };
          if (messageId !== undefined) startData.session_id = messageId;
          yield {
            event: 'start',
            seq: nextSeq(),
            request_id: ctx.request_id,
            kind: 'chat',
            data: startData,
            ts: this.clock.now(),
          };
          break;
        }

        case 'content_block_start': {
          const index = asNumber(ev.payload['index']) ?? 0;
          const block = asRecord(ev.payload['content_block']);
          const blockType = block === undefined ? undefined : asString(block['type']);
          const open: OpenPart = {
            kind: 'text',
            text: '',
            signature: '',
            partialJson: '',
            raw: block ?? {},
          };
          if (blockType === 'tool_use') {
            open.kind = 'tool_use';
            open.id = asString(block?.['id']) ?? '';
            open.name = asString(block?.['name']) ?? '';
          } else if (blockType === 'thinking') {
            open.kind = 'thinking';
          } else if (blockType === 'redacted_thinking') {
            open.kind = 'redacted_thinking';
            open.data = asString(block?.['data']) ?? '';
          } else if (blockType !== 'text') {
            open.kind = 'unknown';
          }
          openParts.set(index, open);
          yield partFrame(
            nextSeq(),
            ctx.request_id,
            this.clock.now(),
            'begin',
            index,
            openPartToStream(open),
          );
          break;
        }

        case 'content_block_delta': {
          const index = asNumber(ev.payload['index']) ?? 0;
          const delta = asRecord(ev.payload['delta']);
          const deltaType = delta === undefined ? undefined : asString(delta['type']);
          const open = openParts.get(index);
          if (deltaType === 'text_delta') {
            const text = asString(delta?.['text']) ?? '';
            if (open !== undefined) open.text += text;
            yield {
              event: 'delta',
              seq: nextSeq(),
              request_id: ctx.request_id,
              kind: 'chat',
              data: { kind: 'chat', text },
              ts: this.clock.now(),
            };
          } else if (deltaType === 'input_json_delta') {
            const partial = asString(delta?.['partial_json']) ?? '';
            if (open !== undefined) open.partialJson += partial;
            yield {
              event: 'delta',
              seq: nextSeq(),
              request_id: ctx.request_id,
              kind: 'chat',
              data: { kind: 'chat', tool_input_json: partial },
              ts: this.clock.now(),
            };
          } else if (deltaType === 'thinking_delta') {
            const thinking = asString(delta?.['thinking']) ?? '';
            if (open !== undefined) open.text += thinking;
            yield {
              event: 'delta',
              seq: nextSeq(),
              request_id: ctx.request_id,
              kind: 'chat',
              data: { kind: 'chat', thinking },
              ts: this.clock.now(),
            };
          } else if (deltaType === 'signature_delta') {
            // signature 是多轮回传必需字段（40 §7.2），但它不是内容增量——累积到 part 上，
            // 由 content_block_stop 的 part.end 一次性带出，不单独产帧。
            if (open !== undefined) open.signature += asString(delta?.['signature']) ?? '';
          }
          break;
        }

        case 'content_block_stop': {
          const index = asNumber(ev.payload['index']) ?? 0;
          const open = openParts.get(index);
          openParts.delete(index);
          yield partFrame(
            nextSeq(),
            ctx.request_id,
            this.clock.now(),
            'end',
            index,
            open === undefined ? { type: 'unknown', raw: {} } : openPartToStream(open),
          );
          break;
        }

        case 'message_delta': {
          const usage = asRecord(ev.payload['usage']);
          if (usage !== undefined) {
            rawUsage = { ...(rawUsage ?? {}), ...usage };
            mergedUsage = mergeUsage(mergedUsage, tokenUsageFromWire(usage));
          }
          const delta = asRecord(ev.payload['delta']);
          const stopReason = delta === undefined ? undefined : asString(delta['stop_reason']);
          if (stopReason !== undefined) {
            finishReason = this.normalizeFinishReason({ stop_reason: stopReason });
          }
          if (!ended) {
            ended = true;
            const endData: StreamEndData = { finish_reason: finishReason };
            if (mergedUsage !== undefined) endData.usage = usageFromAcc(mergedUsage, rawUsage);
            yield {
              event: 'end',
              seq: nextSeq(),
              request_id: ctx.request_id,
              kind: 'chat',
              data: endData,
              ts: this.clock.now(),
            };
          }
          break;
        }

        case 'message_stop': {
          // 正常流里 message_delta 已经发过 end 帧；只有残缺流（没有 message_delta）
          // 才需要在这里补一个终止帧，避免客户端永远等不到结束。
          if (!ended) {
            ended = true;
            const endData: StreamEndData = { finish_reason: finishReason };
            if (mergedUsage !== undefined) endData.usage = usageFromAcc(mergedUsage, rawUsage);
            yield {
              event: 'end',
              seq: nextSeq(),
              request_id: ctx.request_id,
              kind: 'chat',
              data: endData,
              ts: this.clock.now(),
            };
          }
          break;
        }

        case 'error': {
          const error = asRecord(ev.payload['error']);
          const errorType = error === undefined ? undefined : asString(error['type']);
          const mapped = errorType === undefined ? undefined : STREAM_ERROR_CODE_BY_TYPE[errorType];
          const message =
            (error === undefined ? undefined : asString(error['message'])) ??
            'upstream stream error';
          yield {
            event: 'error',
            seq: nextSeq(),
            request_id: ctx.request_id,
            kind: 'chat',
            data: {
              error: {
                code: mapped?.code ?? 'upstream_error',
                message,
                ...(errorType === undefined ? {} : { provider_code: errorType }),
                http_status: 502,
                retryable: mapped?.retryable ?? false,
                request_id: ctx.request_id,
                raw: ev.payload,
              },
              fatal: true,
            },
            ts: this.clock.now(),
          };
          break;
        }

        default:
          // ping（keep-alive）/ 未知事件类型：不影响转发，也不能丢——搭车 meta 帧透传，
          // 由 encodeStream 按原事件名还原（见 PASSTHROUGH_FRAME_NOTE_KEY）。
          yield {
            event: 'meta',
            seq: nextSeq(),
            request_id: ctx.request_id,
            kind: 'chat',
            data: { notes: { [PASSTHROUGH_FRAME_NOTE_KEY]: { event: type, data: ev.payload } } },
            ts: this.clock.now(),
          };
          break;
      }
    }
  }

  // =========================================================================
  // 流式：canonical 帧 → 上游格式（Anthropic SSE）
  // =========================================================================

  encodeStream(frames: AsyncIterable<StreamFrame>, ctx: RequestContext): AsyncIterable<unknown> {
    return this.encodeAnthropicStream(frames, ctx);
  }

  private async *encodeAnthropicStream(
    frames: AsyncIterable<StreamFrame>,
    ctx: RequestContext,
  ): AsyncGenerator<unknown> {
    // canonical 帧没有"第几个 content block"的字段，只能靠 part 边界帧推断当前 index。
    let currentIndex = 0;

    for await (const frame of frames) {
      switch (frame.event) {
        case 'start': {
          const data = frame.data as StartData;
          yield sseEvent('message_start', {
            type: 'message_start',
            message: {
              ...(data.session_id === undefined ? {} : { id: data.session_id }),
              type: 'message',
              role: 'assistant',
              model: data.model,
              content: [],
            },
          });
          break;
        }

        case 'delta': {
          // ir/stream.ts 的 FrameData 是"帧类型与负载未做判别式绑定"的联合，这里按 event 收窄后
          // 显式断言负载类型（同文件 nativeEventNameFor 的做法）。
          const data = frame.data as DeltaData;
          if (data.kind !== 'chat') break;
          if (data.tool_input_json !== undefined) {
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentIndex,
              delta: { type: 'input_json_delta', partial_json: data.tool_input_json },
            });
          } else if (data.thinking !== undefined) {
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentIndex,
              delta: { type: 'thinking_delta', thinking: data.thinking },
            });
          } else if (data.refusal !== undefined) {
            // Anthropic 没有 refusal delta；降级成 text_delta 至少不丢内容。
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentIndex,
              delta: { type: 'text_delta', text: data.refusal },
            });
          } else {
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: currentIndex,
              delta: { type: 'text_delta', text: data.text ?? '' },
            });
          }
          break;
        }

        case 'meta': {
          const data = frame.data as MetaData;
          const note = partFrameNote(data);
          if (note !== undefined) {
            currentIndex = note.index;
            if (note.phase === 'begin') {
              yield sseEvent('content_block_start', {
                type: 'content_block_start',
                index: note.index,
                content_block: note.part,
              });
            } else {
              yield sseEvent('content_block_stop', {
                type: 'content_block_stop',
                index: note.index,
              });
            }
            break;
          }
          // ping / 未知事件透传还原（原事件名 + 原 data）。
          const passthrough = asRecord(data.notes?.[PASSTHROUGH_FRAME_NOTE_KEY]);
          if (passthrough !== undefined) {
            const name = asString(passthrough['event']);
            if (name !== undefined) yield sseEvent(name, passthrough['data'] ?? {});
          }
          break;
        }

        case 'usage': {
          const data = frame.data as UsageData;
          if (data.usage === undefined) break;
          yield sseEvent('message_delta', {
            type: 'message_delta',
            delta: {},
            usage: encodeWireUsage(data.usage),
          });
          break;
        }

        case 'end': {
          const data = frame.data as StreamEndData;
          const stopReason = this.encodeFinishReasonFromNormalized(data.finish_reason, ctx);
          const delta: Record<string, unknown> = { stop_reason: stopReason };
          yield sseEvent('message_delta', {
            type: 'message_delta',
            delta,
            ...(data.usage === undefined ? {} : { usage: encodeWireUsage(data.usage) }),
          });
          // 一个 canonical end 帧需要落成两个 wire 事件：message_delta 带 stop_reason/usage，
          // message_stop 才是真正的流终止哨兵（Anthropic 协议两者都有）。
          yield sseEvent('message_stop', { type: 'message_stop' });
          break;
        }

        case 'error': {
          const data = frame.data as ErrorData;
          yield sseEvent('error', {
            type: 'error',
            error: { type: 'api_error', message: data.error.message },
          });
          break;
        }
      }
    }
  }

  /** canonical `finish_reason` → Anthropic `stop_reason`（流式路径，无 raw 可依）。 */
  private encodeFinishReasonFromNormalized(
    finishReason: FinishReason,
    ctx: RequestContext,
  ): string {
    const normalized = finishReason as NormalizedFinishReason;
    const mapped = CANONICAL_TO_FINISH_REASON[normalized];
    if (mapped === undefined) {
      ctx.warn(`unmapped_finish_reason:${String(finishReason)}`);
      return 'end_turn';
    }
    return mapped;
  }

  // =========================================================================
  // S1 惰性解码（D-fastpath-1）：只解析路由必需集，**不物化** messages/system/tools
  // =========================================================================

  decodeEnvelope(raw: unknown, ctx: RequestContext): RequestEnvelopeShallow {
    const obj = asRecord(raw) ?? {};
    const rawBody = ctx.state[CTX_STATE_KEYS.RAW_BODY];
    const bytes =
      rawBody instanceof Buffer
        ? rawBody.byteLength
        : typeof rawBody === 'string'
          ? Buffer.byteLength(rawBody, 'utf8')
          : (ctx.request_bytes ?? Buffer.byteLength(JSON.stringify(obj), 'utf8'));

    // `ag_agentic_loop` 是**建模**的路由字段（RequestEnvelopeShallow.gateway_agentic_loop），
    // 因此必须从 unmapped 的候选集里排除——否则同一个键会同时出现在 gateway_agentic_loop
    // 与 unmapped 两处，回写时就重复了。
    const unmapped = extraKeys(obj, [...MODELLED_TOP_LEVEL_KEYS, 'ag_agentic_loop']);

    return {
      source_format: this.format,
      kind: 'chat',
      model: asString(obj['model']) ?? '',
      stream: obj['stream'] === true,
      bytes,
      // 40 §2.3：Anthropic 的 usage 分 message_start（input + cache）与
      // message_delta（output + cache）两次到达——嗅探器必须两个位置都看。
      usage_locations: ['message_start.usage', 'message_delta.usage'],
      // 20 §5.1：`ag_agentic_loop: true` 是客户端显式要求网关工具循环的开关。
      // 放进路由必需集，Runner 才能在不物化完整 canonical 的前提下决定要不要进工具循环
      // （D-fastpath-1 的意义所在）。
      ...(obj['ag_agentic_loop'] === true ? { gateway_agentic_loop: true } : {}),
      ...(unmapped === undefined ? {} : { unmapped }),
      default_path: ANTHROPIC_MESSAGES_PATH,
    };
  }
}

// ---------------------------------------------------------------------------
// AdaptorMeta 工厂（40 §1.3）：能力矩阵三态登记用
// ---------------------------------------------------------------------------

/** 本 adaptor 的元数据。注册处（adaptors/index.ts）显式调用，不做魔法自动发现。 */
export function createAnthropicMessagesAdaptorMeta(): AdaptorMeta {
  return {
    format: 'anthropic.messages',
    modality: 'chat',
    version: '1.0.0',
    fixtures: 'adaptors/fixtures/anthropic-messages',
    unsupported_fields: [
      // 2026-10-21 API version 起发送即 400 的字段（40 §2.2b）
      'params.temperature',
      'params.top_p',
      'params.top_k',
      // Anthropic 无对应（10 §9.1）
      'params.frequency_penalty',
      'params.presence_penalty',
      'params.logprobs',
      'params.top_logprobs',
      'params.n',
      'params.user',
      'params.service_tier',
      'params.safety',
      'params.parallel_tool_calls',
      'response_format',
    ],
    quirks: [
      'system 是顶层字段，可以是 string 或 block 数组；多条 system 必须全部保留（40 §7.2）',
      'tool_use block 必须移到段尾（10 §4.2 D7c）',
      'thinking block 的 signature 多轮必需（40 §7.2 / §3.3）',
      'cache_control 是块级且最多 4 个 breakpoint；ttl 支持 5m/1h（40 §7.2）',
      'usage 分 message_start + message_delta 两次到达，必须合并（40 §2.3）',
      'input_tokens 不含 cache 部分；total_tokens 需自算 = input + cache_creation + cache_read + output（40 §2.1/§2.2）',
      'thinking_tokens 已计入 output_tokens，另记 reasoning_in_output 告警（40 §2.2 I2）',
      'API version 2026-10-21 起 temperature/top_p/top_k 发送即 400，编码时必须丢弃（40 §2.2b）',
    ],
    status: 'implemented',
    supports_lazy_decode: true,
  };
}

// ---------------------------------------------------------------------------
// 模块级私有助手（不依赖实例状态，便于单测）
// ---------------------------------------------------------------------------

/**
 * `tool_use` block 移到段尾（10 §4.2 D7c / 40 §7.2）。
 *
 * Anthropic 的硬约束：assistant 消息里 tool_use 必须排在所有其他 block 之后。
 * AI SDK 有 `moveToolUseBlocksToEnd()` 专门处理这件事，这里等价实现——顺序**稳定**
 * （同类 part 保持原有相对次序），不会把客户端的块序打乱。
 */
export function moveToolUseBlocksToEnd(parts: Part[]): Part[] {
  const head: Part[] = [];
  const tail: Part[] = [];
  for (const part of parts) {
    if (part.type === 'tool_use') tail.push(part);
    else head.push(part);
  }
  return tail.length === 0 ? parts : [...head, ...tail];
}

/** SSE 文本块 → `{event, data}`。解析失败返回 undefined（不影响转发）。 */
function parseWireEvent(
  item: unknown,
): { name?: string; payload: Record<string, unknown> } | undefined {
  if (typeof item === 'string') {
    let name: string | undefined;
    const dataLines: string[] = [];
    for (const line of item.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return undefined;
    }
    const rec = asRecord(payload);
    if (rec === undefined) return undefined;
    return { ...(name === undefined ? {} : { name }), payload: rec };
  }
  const rec = asRecord(item);
  if (rec === undefined) return undefined;
  const name = asString(rec['type']) ?? asString(rec['event']);
  return { ...(name === undefined ? {} : { name }), payload: rec };
}

/** 序列化成 Anthropic SSE 事件（`event: <name>\ndata: <json>\n\n`）。 */
function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 流式里正在累积的 part（tool_use 的 input_json_delta 是分片到达的，20 §5.2）。 */
interface OpenPart {
  kind: 'text' | 'tool_use' | 'thinking' | 'redacted_thinking' | 'unknown';
  text: string;
  signature: string;
  partialJson: string;
  id?: string;
  name?: string;
  data?: string;
  raw: Record<string, unknown>;
}

/** 累积中的 part → `StreamPart` 形状（与 ir/stream.ts 的 StreamPart 对齐）。 */
function openPartToStream(open: OpenPart): Record<string, unknown> {
  switch (open.kind) {
    case 'tool_use': {
      const part: Record<string, unknown> = {
        type: 'tool_use',
        id: open.id,
        name: open.name,
        input: {},
      };
      if (open.partialJson.length > 0) {
        const parsed = tryParseJson(open.partialJson);
        if (parsed !== undefined) part['input'] = parsed;
        else part['raw_arguments'] = open.partialJson;
      }
      return part;
    }
    case 'thinking': {
      const part: Record<string, unknown> = { type: 'thinking', thinking: open.text };
      if (open.signature.length > 0) part['signature'] = open.signature;
      return part;
    }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: open.data };
    case 'unknown':
      return {
        type: 'unknown',
        ...(open.raw['type'] === undefined ? {} : { raw_type: open.raw['type'] }),
        raw: open.raw,
      };
    default:
      return { type: 'text', text: open.text };
  }
}

/** 产出 part 边界帧（载体见 `PART_FRAME_NOTE_KEY` 的注释）。 */
function partFrame(
  seq: number,
  requestId: string,
  ts: number,
  phase: 'begin' | 'end',
  index: number,
  part: Record<string, unknown>,
): StreamFrame {
  const data: MetaData = { notes: { [PART_FRAME_NOTE_KEY]: { phase, index, part } } };
  return { event: 'meta', seq, request_id: requestId, kind: 'chat', data, ts };
}

/** 从 meta 帧里取回 part 边界信息。 */
function partFrameNote(
  data: MetaData,
): { phase: 'begin' | 'end'; index: number; part: Record<string, unknown> } | undefined {
  const note = asRecord(data.notes?.[PART_FRAME_NOTE_KEY]);
  if (note === undefined) return undefined;
  const phase = asString(note['phase']);
  if (phase !== 'begin' && phase !== 'end') return undefined;
  return {
    phase,
    index: asNumber(note['index']) ?? 0,
    part: asRecord(note['part']) ?? {},
  };
}

/**
 * 流式结束帧的负载。
 *
 * ⚠️ 类型缺口（列入交付报告的「文档问题」清单，**未改 ir/**）：
 * `ir/stream.ts` 的 `EndData` 只有 `finish_reason` 与 `output`，**没有 `usage`**；但
 * 20 §S6 的 `CanonicalStreamEvent{type:"finish"}` 明确带 usage，且
 * `gateway-core/pipeline/stages/s6-provider-decode.ts` 的 `frameToEvent()` 正是读
 * `f.data["usage"]`。Anthropic 的 usage 分两次到达（40 §2.3），合并结果只能搭车放在
 * 结束帧上，因此用交叉类型补一个可选 `usage`（可赋值给 FrameData 联合的 EndData 成员）。
 */
interface StreamEndData extends EndData {
  usage?: CanonicalUsage;
}

/** usage 累加器（与 ir/usage.ts 的 TokenUsage 同形状，但字段全可选）。 */
interface TokenUsageAcc {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  cache_write_ttl_5m?: number;
  cache_write_ttl_1h?: number;
}

/** Anthropic usage 片段 → 累加器（40 §2.1 口径）。 */
function tokenUsageFromWire(usage: Record<string, unknown>): TokenUsageAcc {
  const acc: TokenUsageAcc = {};
  const input = asNumber(usage['input_tokens']);
  if (input !== undefined) acc.input_tokens = input;
  const output = asNumber(usage['output_tokens']);
  if (output !== undefined) acc.output_tokens = output;
  const cacheRead = asNumber(usage['cache_read_input_tokens']);
  if (cacheRead !== undefined) acc.cache_read_tokens = cacheRead;
  const cacheWrite = asNumber(usage['cache_creation_input_tokens']);
  if (cacheWrite !== undefined) acc.cache_write_tokens = cacheWrite;
  const outputDetails = asRecord(usage['output_tokens_details']);
  const reasoning =
    outputDetails === undefined ? undefined : asNumber(outputDetails['thinking_tokens']);
  if (reasoning !== undefined) acc.reasoning_tokens = reasoning;
  const cacheCreation = asRecord(usage['cache_creation']);
  const ttl5m =
    cacheCreation === undefined ? undefined : asNumber(cacheCreation['ephemeral_5m_input_tokens']);
  const ttl1h =
    cacheCreation === undefined ? undefined : asNumber(cacheCreation['ephemeral_1h_input_tokens']);
  if (ttl5m !== undefined) acc.cache_write_ttl_5m = ttl5m;
  if (ttl1h !== undefined) acc.cache_write_ttl_1h = ttl1h;
  return acc;
}

/**
 * 合并两片 usage（40 §2.3：message_start + message_delta 必须合并）。
 *
 * **这里是"覆盖"而不是"相加"**：Anthropic 在 `message_start.message.usage` 里给的
 * `output_tokens` 是**占位值**（真实协议里通常是 1），真正的累计值随 `message_delta.usage`
 * 到达。若按 usage-sniffer 那样逐字段相加，output_tokens 会被双算——正是 40 §2.2c I2
 * 要防的事。因此规则定为"后到者按键覆盖，未指定的键保留"。
 *
 * 依据是 40 §2.3 原文对两处的分工描述：「message_start（input_tokens）+
 * message_delta（output_tokens + cache）」。
 */
function mergeUsage(a: TokenUsageAcc | undefined, b: TokenUsageAcc): TokenUsageAcc {
  const out: TokenUsageAcc = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k as keyof TokenUsageAcc] = v;
  }
  return out;
}

/** 累加器 → `CanonicalUsage`（含 I4 的原始 usage 存档）。 */
function usageFromAcc(
  acc: TokenUsageAcc,
  raw: Record<string, unknown> | undefined,
): CanonicalUsage {
  const details: Record<string, number> = {};
  if (acc.cache_write_ttl_5m !== undefined) details['cache_write_ttl_5m'] = acc.cache_write_ttl_5m;
  if (acc.cache_write_ttl_1h !== undefined) details['cache_write_ttl_1h'] = acc.cache_write_ttl_1h;
  const input = acc.input_tokens ?? 0;
  const output = acc.output_tokens ?? 0;
  const cacheRead = acc.cache_read_tokens ?? 0;
  const cacheWrite = acc.cache_write_tokens ?? 0;
  return {
    units: {
      tokens: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + cacheWrite + cacheRead + output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        reasoning_tokens: acc.reasoning_tokens ?? 0,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    },
    ...(raw === undefined ? {} : { raw: { ...raw } }),
    source: 'provider',
  };
}

/** `CanonicalUsage` → Anthropic usage 对象（canonical → 上游格式）。 */
function encodeWireUsage(usage: CanonicalUsage): Record<string, unknown> {
  const tokens = usage.units.tokens;
  if (tokens === undefined) return {};
  const wire: Record<string, unknown> = {
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
  };
  if (tokens.cache_read_tokens !== 0) wire['cache_read_input_tokens'] = tokens.cache_read_tokens;
  if (tokens.cache_write_tokens !== 0)
    wire['cache_creation_input_tokens'] = tokens.cache_write_tokens;
  const cacheCreation: Record<string, unknown> = {};
  const ttl5m = tokens.details?.['cache_write_ttl_5m'];
  const ttl1h = tokens.details?.['cache_write_ttl_1h'];
  if (ttl5m !== undefined) cacheCreation['ephemeral_5m_input_tokens'] = ttl5m;
  if (ttl1h !== undefined) cacheCreation['ephemeral_1h_input_tokens'] = ttl1h;
  if (Object.keys(cacheCreation).length > 0) wire['cache_creation'] = cacheCreation;
  if (tokens.reasoning_tokens !== 0) {
    wire['output_tokens_details'] = { thinking_tokens: tokens.reasoning_tokens };
  }
  // 40 §2.2c I4 + 10 §7.2 回写规则第 3 条：`usage.raw` 里未建模的键（如 service_tier /
  // inference_geo / server_tool_use）必须原样回写，否则 canonical → wire 会静默丢对账字段。
  const raw = asRecord(usage.raw);
  if (raw !== undefined) {
    for (const [k, v] of Object.entries(raw)) {
      if (WIRE_USAGE_MODELLED_KEYS.includes(k)) continue;
      if (k in wire) continue;
      wire[k] = v;
    }
  }
  return wire;
}

/** Anthropic usage 对象里被 canonical 建模了的键（其余进 `usage.raw` 原样回写）。 */
const WIRE_USAGE_MODELLED_KEYS: readonly string[] = [
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cache_creation',
  'output_tokens_details',
];

/**
 * `ThinkingConfig.enabled` 的归一化：**`effort: "none"` 一律视为"关推理"**。
 *
 * 为什么需要它：OpenAI 的 `reasoning_effort: "none"` 语义是"不要推理"，而 canonical 的
 * 开关字段是 `ThinkingConfig.enabled`。若调用方（或某个 adaptor）写出
 * `{enabled: true, effort: "none"}` 这种自相矛盾的组合，按 `enabled` 办会让 Anthropic
 * 收到一个 `thinking.budget_tokens`——与客户端"不要推理"的意图正好相反。
 * 这里以 `effort !== "none"` 为准（"更保守的那个信号赢"），并把规则收成单处，
 * 避免 encode 侧与后续任何读取方各写一遍判断。
 *
 * 其他 effort 值（minimal/low/medium/high/xhigh/max）都表示"要推理"，恒 `true`。
 */
export function normalizeThinkingEnabled(thinking: ThinkingConfig): boolean {
  return thinking.enabled !== false && thinking.effort !== 'none';
}

/** JSON.parse 的宽容版：失败返回 undefined（10 §7.3 畸形 tool 参数保护）。 */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
