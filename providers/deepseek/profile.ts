/**
 * providers/deepseek/profile.ts —— DeepSeek provider profile（provider 专有知识的唯一集中处）。
 *
 * 一手来源（2026-11-14 逐页核实，全部为官方文档）：
 *   - https://api-docs.deepseek.com/ （Your First API Call：base_url 表 + curl 示例）
 *   - https://api-docs.deepseek.com/api/create-chat-completion （Chat Completions 参考）
 *   - https://api-docs.deepseek.com/api/create-message （Messages 参考）
 *   - https://api-docs.deepseek.com/guides/anthropic_api （Anthropic 兼容指南 + 差异表）
 *   - https://api-docs.deepseek.com/guides/kv_cache （上下文缓存与 usage 字段语义）
 *   - https://api-docs.deepseek.com/guides/thinking_mode （thinking 开关与 effort 映射）
 *   - https://api-docs.deepseek.com/guides/web_tools （全家桶：deepseek_web_search / deepseek_read_url）
 *   - https://api-docs.deepseek.com/quick_start/pricing （模型清单 / 上下文 / 计费）
 *   - https://api-docs.deepseek.com/updates + /news/news260424 （模型退役公告）
 *
 * ## 两个 dialect 与 OpenAI / Anthropic 本家的差异（映射表）
 *
 * | 维度 | OpenAI 本家 | DeepSeek OpenAI 兼容面 | Anthropic 本家 | DeepSeek Anthropic 兼容面 |
 * |---|---|---|---|---|
 * | 端点 | POST /v1/chat/completions | **POST /chat/completions**（无 /v1） | POST /v1/messages | POST /anthropic/v1/messages |
 * | base URL | api.openai.com | api.deepseek.com | api.anthropic.com | api.deepseek.com（+/anthropic 前缀由路径表达） |
 * | 鉴权 | Bearer | Bearer | x-api-key + anthropic-version | x-api-key 或 Bearer；**anthropic-version 被忽略** |
 * | 推理开关 | reasoning_effort 档位 | `thinking:{type:enabled/disabled}` 对象，**省略即默认开** | thinking:{type,budget_tokens} | thinking:{type}（budget_tokens 忽略）+ output_config.effort |
 * | 思考内容 | （无） | message/delta.`reasoning_content` | thinking block | thinking block |
 * | 缓存 usage | prompt_tokens_details.cached_tokens | **usage 顶层** prompt_cache_hit_tokens / prompt_cache_miss_tokens | cache_read_input_tokens / cache_creation_input_tokens | cache_read_input_tokens；**cache_creation 恒 0** |
 * | JSON 输出 | text/json_object/json_schema | **仅 text/json_object**（无 json_schema） | 无（靠 prompt） | 无 |
 * | user 标识 | user | **user_id** | metadata.user_id | metadata.user_id |
 * | 流式 usage | 独立 usage-only chunk | **搭末个内容 chunk**，无独立 chunk | message_start + message_delta 合并 | 同 Anthropic；**无 data:[DONE]** |
 * | 内置搜索 | 无原生 | tools:[{type:"deepseek_web_search"}] | web_search_20250305 server tool | tools:[{type:"deepseek_web_search",**name 必填**}] |
 *
 * 模型（2026-11 现行；`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 15:59 UTC
 * **全部退役**，见 /news/news260424）：
 *   - `deepseek-flash`（DeepSeek-V4.1-Flash-1017）：1M 上下文，max output 384K，
 *     thinking 默认开，**支持图像输入**，并发 2500；
 *   - `deepseek-v4-pro`（DeepSeek-V4-Pro-0813）：1M 上下文，max output 384K，
 *     thinking 默认开，**不支持图像**，并发 500。
 *   Anthropic 兼容面额外接受 Claude 别名：claude-opus* → v4-pro，其它 claude* → flash。
 *
 * 依赖注入：本模块只导出**数据与纯函数**（profile 对象 + 常量），不读 process.env、
 * 不起 HTTP、不建单例；由组合根注册进 ProviderProfileRegistry。
 */

import type { BuiltinTool, CapabilityEntry, ThinkingConfig, TokenUsage } from '../../ir/index.js';
import type { ProviderProfile } from '../../di/ports.js';
import type { RouteAlias } from '../../gateway-core/router.js';

// ---------------------------------------------------------------------------
// 常量：access path / 模型 / 端点 / key 环境变量
// ---------------------------------------------------------------------------

/** DeepSeek 的两个 access path id（credentials/resolver.ts 的 DEFAULT_ACCESS_PATHS 同值）。 */
export const DEEPSEEK_ACCESS_PATHS = {
  /** OpenAI 方言（openai.chat codec）。 */
  openaiChat: 'deepseek.openai-chat',
  /** Anthropic 方言（anthropic.messages codec）。 */
  anthropicMessages: 'deepseek.anthropic-messages',
} as const;

export const DEEPSEEK_ACCESS_PATH_IDS: readonly string[] = Object.values(DEEPSEEK_ACCESS_PATHS);

/** DeepSeek 上游默认 base URL（两 dialect 共用；可用 DEEPSEEK_BASE_URL 覆盖）。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * 各 dialect 的端点路径（官方文档口径）。
 *
 * 注意 OpenAI 兼容面的路径**没有 /v1**：官方 curl 示例是
 * `curl https://api.deepseek.com/chat/completions`，Codex 一键配置脚本写的
 * base_url 也是 `https://api.deepseek.com/`。/v1 前缀是旧资料与第三方教程的说法。
 */
export const DEEPSEEK_OPENAI_CHAT_PATH = '/chat/completions';
export const DEEPSEEK_ANTHROPIC_MESSAGES_PATH = '/anthropic/v1/messages';

/** 上游 key 的环境变量名（值只在进程环境里，仓库只出现变量名）。 */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';

/** 现行模型清单（v1 仅 chat 模态）。 */
export const DEEPSEEK_MODELS = {
  /** DeepSeek-V4.1-Flash-1017：1M ctx / 384K max output / 视觉 ✓ / 并发 2500。 */
  flash: 'deepseek-flash',
  /** DeepSeek-V4-Pro-0813：1M ctx / 384K max output / 无视觉 / 并发 500。 */
  v4Pro: 'deepseek-v4-pro',
} as const;

export const DEEPSEEK_MODEL_IDS: readonly string[] = Object.values(DEEPSEEK_MODELS);

/** 两模型共用 1M 上下文（官方 pricing 页 + Codex models.json: context_window 1048576）。 */
export const DEEPSEEK_CONTEXT_TOKENS = 1_048_576;

/** 两模型共用的 max output（/models 实测 max_output_tokens = 393216）。 */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;

/**
 * 模型机读元数据（单一来源：`GET /models` 实测 + 官方 pricing 页）。
 *
 * `constraints` 是上游**按 (model, dialect) 主动声明**的行为约束
 * （`api_capabilities.anthropic_messages`），adaptor 必须执行，详见
 * ir/capability.ts 的 ModelConstraints 与 discovery.ts 的刷新逻辑。
 * 这些值是**种子值**：启动时/手动触发 model discovery 会用 /models 的实时返回值
 * 覆盖能力矩阵里的同名字段（避免手写表过期），见 providers/deepseek/discovery.ts。
 */
export interface DeepSeekModelMeta {
  id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  input_modalities: Array<'text' | 'image'>;
  output_modalities: Array<'text'>;
  effort: { supported_levels: string[]; default_level: string };
  constraints: {
    system_prompt_update: 'leading-only' | 'in-history';
    tool_update: 'leading-only' | 'addition-only';
  };
}

export const DEEPSEEK_MODEL_META: Readonly<Record<string, DeepSeekModelMeta>> = {
  // 实测（2026-11-14，GET /models）：DeepSeek-V4.1-Flash，支持 image 输入，
  // anthropic_messages 面 system_prompt_update=in-history、tool_update=addition-only
  'deepseek-flash': {
    id: 'deepseek-flash',
    display_name: 'DeepSeek-V4.1-Flash',
    context_window: 1_048_576,
    max_output_tokens: 393_216,
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    constraints: { system_prompt_update: 'in-history', tool_update: 'addition-only' },
  },
  // 实测（2026-11-14，GET /models）：DeepSeek-V4-Pro，纯文本，
  // anthropic_messages 面 system_prompt_update=leading-only、tool_update=leading-only
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    display_name: 'DeepSeek-V4-Pro',
    context_window: 1_048_576,
    max_output_tokens: 393_216,
    input_modalities: ['text'],
    output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    constraints: { system_prompt_update: 'leading-only', tool_update: 'leading-only' },
  },
};

// ---------------------------------------------------------------------------
// builtin tool 映射（50-builtin-search.md §3.1 模式 A：上游原生执行 → 透传）
// ---------------------------------------------------------------------------

/**
 * DeepSeek 全家桶应用 API（2026-11-13 发布）的两个服务端工具：
 * `deepseek_web_search` 与 `deepseek_read_url`，声明在标准 `tools[]` 里。
 *
 * canonical 归一（50 §2.2）：`BuiltinTool.name` 只用稳定名，厂商专有类型串进
 * `native.provider_tool_type`：
 *   - `deepseek_web_search` → `web_search`（联网搜索，含图片搜索）
 *   - `deepseek_read_url`  → `url_context`（读取 URL 正文）
 *
 * ⚠️ 这两个工具**没有任何配置项**：官方文档明确 `allowed_domains` /
 * `blocked_domains` / `user_location` 一律 400，也没有 max-results 旋钮；
 * `tool_choice` 点名这两个工具同样 400（由模型自行决定是否搜索）。
 * 因此 canonical `BuiltinTool.config` 在 DeepSeek dialect 下只能是 `{}`，
 * WebSearchConfig 的域名/条数过滤等字段必须**丢弃 + 告警**（调用方负责）。
 */
const CANONICAL_NAME_BY_VENDOR_TOOL_TYPE: Readonly<Record<string, BuiltinTool['name']>> = {
  deepseek_web_search: 'web_search',
  deepseek_read_url: 'url_context',
};

/** canonical 稳定名 → 厂商专有工具类型串（`builtinToolWire` 的逆）。 */
const VENDOR_TOOL_TYPE_BY_CANONICAL_NAME: Readonly<Record<BuiltinTool['name'], string>> = {
  web_search: 'deepseek_web_search',
  url_context: 'deepseek_read_url',
  // code_interpreter / file_search：DeepSeek 无原生对应 → encode 时丢弃 + 告警
  code_interpreter: '',
  file_search: '',
};

// ---------------------------------------------------------------------------
// usage 归一（40 §2.1 的 DeepSeek 列）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * DeepSeek Chat Completions 的 usage → canonical TokenUsage。
 *
 * 字段口径（官方文档 /api/create-chat-completion 的 usage schema + /guides/kv_cache）：
 *   - `prompt_tokens` = `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`（**全量输入**，
 *     含命中部分——对应 40 §2.2c I1「input 记全量，不另加，避免双算」）；
 *   - `prompt_cache_hit_tokens`：命中磁盘缓存的部分 → canonical `cache_read_tokens`
 *     （与 `prompt_tokens_details.cached_tokens` 同值，后者是 OpenAI 系写法，两者取其一）；
 *   - `prompt_cache_miss_tokens`：未命中部分。**canonical 没有「缓存未命中」槽位**
 *     （它不是 cache_write——DeepSeek 的缓存是全自动的，没有显式写入计费），
 *     按 ir/usage.ts 的 `details`「其他细分，透传保留」收进 `details.prompt_cache_miss_tokens`；
 *   - `completion_tokens_details.reasoning_tokens` → canonical `reasoning_tokens`；
 *   - `completion_tokens_details.safety_tokens`：DeepSeek 扩展（safety_check=high 时出现），
 *     已含在 completion_tokens 里 → 同样进 `details`，不重复计。
 *
 * Anthropic 兼容面（deepseek.anthropic-messages）**不需要**本函数：它直接用
 * Anthropic 形态的 usage（input_tokens 不含缓存命中 / cache_read_input_tokens =
 * 命中 / cache_creation_input_tokens 恒 0），anthropic-messages codec 的既有映射
 * 已经正确。见 profile.usageFromRaw 的分流注释。
 */
export function deepseekOpenAiUsageFromRaw(raw: Record<string, unknown>): TokenUsage | undefined {
  const promptTokens = num(raw['prompt_tokens']) ?? num(raw['input_tokens']);
  const completionTokens = num(raw['completion_tokens']) ?? num(raw['output_tokens']);
  if (promptTokens === undefined && completionTokens === undefined) {
    // 一个 usage 字段都不认识：交回 dialect codec 的默认结果（不猜、不造 0）
    return undefined;
  }

  const promptDetails = asRecord(raw['prompt_tokens_details']);
  const completionDetails = asRecord(raw['completion_tokens_details']);

  // 缓存命中：优先顶层专有字段，回落到 OpenAI 系嵌套字段（DeepSeek 两个都发）
  const cacheRead = num(raw['prompt_cache_hit_tokens']) ?? num(promptDetails?.['cached_tokens']);
  const reasoning = num(completionDetails?.['reasoning_tokens']);

  const details: Record<string, number> = {};
  const cacheMiss = num(raw['prompt_cache_miss_tokens']);
  if (cacheMiss !== undefined) details['prompt_cache_miss_tokens'] = cacheMiss;
  const safetyTokens = num(completionDetails?.['safety_tokens']);
  if (safetyTokens !== undefined) details['safety_tokens'] = safetyTokens;

  const input = promptTokens ?? 0;
  const output = completionTokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: num(raw['total_tokens']) ?? input + output,
    // DeepSeek 无显式缓存写入计费（全自动磁盘缓存），恒 0
    cache_read_tokens: cacheRead ?? 0,
    cache_write_tokens: 0,
    reasoning_tokens: reasoning ?? 0,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

// ---------------------------------------------------------------------------
// thinking 参数映射
// ---------------------------------------------------------------------------

/**
 * canonical `ThinkingConfig` → DeepSeek Chat Completions 的请求字段。
 *
 * 官方语义（/api/create-chat-completion）：`thinking: {"type":"enabled"|"disabled"}`，
 * 「When `thinking` is omitted or `null`, the mode follows `reasoning_effort`;
 * if `reasoning_effort` is also omitted, **thinking is enabled**」——即省略 = 开。
 * 因此 canonical 的 `enabled` 必须**显式**映射成 type，否则「客户端要求关推理」
 * （`enabled:false`，不传任何字段）会被上游的默认开启吞掉，是一次静默的语义反转。
 *
 * effort（/guides/thinking_mode 的归一表）：minimal→low、low→low、medium→high、
 * high→high、xhigh→high、max→max；`none` 表示关推理。DeepSeek 的 `reasoning_effort`
 * 枚举是 none/low/high/max，medium/xhigh/minimal 都要先归一。
 */
export function deepseekThinkingWire(thinking: ThinkingConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // `effort: "none"` 的语义是「关推理」（DeepSeek 官方：none disables thinking mode），
  // 与 canonical 的 `enabled` 开关是同一件事的两种说法——两者取「更想关」的那个，
  // 否则调用方把 enabled 写成 true 又会拿到一个开着的推理（与 anthropic codec 的
  // normalizeThinkingEnabled 同一立场）。effort 省略（undefined）时不参与判断：
  // 此时 only `enabled` 说话，而 DeepSeek 的默认（省略即开）与 canonical 的
  // `enabled:true` 一致，无需额外动作。
  const effortOff = thinking.effort === 'none';
  if (!thinking.enabled || effortOff) {
    out['thinking'] = { type: 'disabled' };
    return out;
  }
  out['thinking'] = { type: 'enabled' };
  const effort = normalizeDeepSeekEffort(thinking.effort);
  if (effort !== undefined) out['reasoning_effort'] = effort;
  return out;
}

/** canonical effort → DeepSeek reasoning_effort 枚举（none/low/high/max）。 */
export function normalizeDeepSeekEffort(
  effort: ThinkingConfig['effort'],
): 'low' | 'high' | 'max' | undefined {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
    case 'xhigh':
      return 'high';
    case 'max':
      return 'max';
    case 'none':
    case undefined:
      return undefined; // none = 关推理（由 thinking.type=disabled 表达）
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 能力矩阵（键 = (access_path, model, modality)，45 §6.2）
// ---------------------------------------------------------------------------

const CHAT_STREAMING = {
  mode: 'sse' as const,
  usage_in_stream: true,
  cancellable: true,
  framing: 'json-sse' as const,
};

/**
 * DeepSeek 能力矩阵条目：2 模型 × 2 dialect = 4 条，模态仅 chat（v1 范围）。
 *
 * `quirks` 是人类可读的已知怪癖（进能力矩阵）；`unsupported_fields` 是路由预检用的
 * canonical 字段路径（20 §S2 第 6 步，on_unsupported=strict 时直接拒绝）。
 * 只登记**已实现且契约测试覆盖**的条目（40 §5：planned 不进矩阵）。
 */
export function deepseekCapabilities(): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];
  for (const model of DEEPSEEK_MODEL_IDS) {
    entries.push({
      access_path: DEEPSEEK_ACCESS_PATHS.openaiChat,
      model,
      modality: 'chat',
      format: 'openai.chat',
      streaming: CHAT_STREAMING,
      usage_source: 'provider',
      usage_units: ['tokens'],
      unsupported_fields: [
        // DeepSeek Chat Completions 的 response_format 只有 text/json_object（官方 enum），
        // 没有 json_schema（json_schema 只在 Responses 面有）
        'params.response_format.json_schema',
        // 官方明确标记 deprecated no-op：「This parameter is no longer supported」
        'params.frequency_penalty',
        'params.presence_penalty',
        // DeepSeek 的终端用户标识叫 user_id，不认 canonical 的 params.user
        'params.user',
      ],
      quirks: [
        '端点是 POST /chat/completions——没有 /v1 前缀（与 OpenAI 本家不同）',
        'thinking 是 {type:enabled/disabled} 对象且省略即默认开启推理；effort 枚举 none/low/high/max',
        '上下文缓存全自动无参数；usage 顶层报 prompt_cache_hit_tokens / prompt_cache_miss_tokens',
        'usage 搭在流式最后一个内容 chunk 上，没有独立 usage-only chunk',
        '带 tools 时 reasoning_content 必须在后续每一轮完整回传，否则 400',
        '内置搜索/读链接：tools:[{type:"deepseek_web_search"}] / [{type:"deepseek_read_url"}]，无任何配置项',
        ...(model === DEEPSEEK_MODELS.flash
          ? ['支持图像输入（vision）']
          : ['不支持图像输入：图片被替换为文本 [Unsupported Image]']),
        ...modelMetaQuirks(model),
      ],
      ...modelMetaFields(model),
      contract_tested: true,
      status: 'implemented',
    });
    entries.push({
      access_path: DEEPSEEK_ACCESS_PATHS.anthropicMessages,
      model,
      modality: 'chat',
      format: 'anthropic.messages',
      streaming: CHAT_STREAMING,
      usage_source: 'provider',
      usage_units: ['tokens'],
      unsupported_fields: [
        // 官方兼容表：cache_control 一律 Ignored（内容块、工具、system 上都无缓存断点）
        'cache_control',
        // 官方兼容表：search_result / redacted_thinking / citations / is_error 均 Not Supported / Ignored
        'parts.search_result',
        'parts.redacted_thinking',
      ],
      quirks: [
        '端点是 POST /anthropic/v1/messages；anthropic-version 头被服务端忽略',
        'thinking 默认开启（不传 thinking 也不传 output_config.effort 时）；budget_tokens 被忽略',
        'usage.cache_creation_input_tokens 恒 0（无 Anthropic 式缓存写入，缓存全自动）',
        'input_tokens 不含缓存命中；命中数在 cache_read_input_tokens',
        '流式不发 data:[DONE]；message_start + message_delta 两次 usage 按覆盖合并',
        '客户端工具必须省略 type（传 type:"custom" 返回 422）；cache_control 被忽略',
        'tool_choice any/tool 在 thinking 模式下报 400',
        '内置搜索/读链接：tools:[{type:"deepseek_web_search",name:"deepseek_web_search"}]——Messages 面 name 必填',
        ...(model === DEEPSEEK_MODELS.flash
          ? ['支持图像输入（仅 user 消息与 tool_result；assistant 消息带图返回 400）']
          : ['不支持图像输入：图片被替换为文本 [Unsupported Image]']),
        ...modelMetaQuirks(model),
      ],
      ...modelMetaFields(model),
      ...modelConstraintFields(model),
      contract_tested: true,
      status: 'implemented',
    });
  }
  return entries;
}

/**
 * 把 /models 的机读元数据摊平成 CapabilityEntry 字段（模态 / 窗口 / effort）。
 * 单一来源是 DEEPSEEK_MODEL_META——能力矩阵与 adaptor 执行都读它，discovery 刷新时
 * 覆盖的也是这些字段（见 discovery.ts 的 refresh 合并策略）。
 *
 * 注意**约束不在这里摊**：`api_capabilities.anthropic_messages` 的 key 名就限定了
 * 作用域是 Anthropic 方言，OpenAI 兼容面没有对应声明。约束只贴 anthropic-messages
 * 条目（见下面的 anthropic 分支），给 openai.chat 条目编一个约束等于猜测。
 */
function modelMetaFields(model: string): Partial<CapabilityEntry> {
  const meta = DEEPSEEK_MODEL_META[model];
  if (meta === undefined) return {};
  return {
    input_modalities: [...meta.input_modalities],
    output_modalities: [...meta.output_modalities],
    context_window: meta.context_window,
    max_output_tokens: meta.max_output_tokens,
    effort: { ...meta.effort, supported_levels: [...meta.effort.supported_levels] },
  };
}

/** Anthropic 方言专属：上游按 (model, dialect) 声明的行为约束。 */
function modelConstraintFields(model: string): Partial<CapabilityEntry> {
  const meta = DEEPSEEK_MODEL_META[model];
  if (meta === undefined) return {};
  return { constraints: { ...meta.constraints } };
}

/** 约束的人类可读说明（进 quirks，便于能力矩阵直接看）。 */
function modelMetaQuirks(model: string): string[] {
  const meta = DEEPSEEK_MODEL_META[model];
  if (meta === undefined) return [];
  return [
    `上游声明约束（/models api_capabilities）：system_prompt_update=${meta.constraints.system_prompt_update}、tool_update=${meta.constraints.tool_update}`,
    `上下文窗口 ${meta.context_window} tokens，单次最大输出 ${meta.max_output_tokens} tokens`,
    `thinking effort 档位 ${meta.effort.supported_levels.join('/')}（默认 ${meta.effort.default_level}）`,
  ];
}

// ---------------------------------------------------------------------------
// 路由别名（组合根的 defaultRouteTable 追加）
// ---------------------------------------------------------------------------

/**
 * DeepSeek 模型别名 → access path。
 *
 * 两类别名分别演示任务要求的两种可运行配置：
 *   - `deepseek-flash` / `deepseek-v4-pro`：客户端 **OpenAI 格式 → DeepSeek**
 *     （同 dialect，fast path 透传）；客户端 Anthropic 格式进来则走 canonical 转换；
 *   - `deepseek-flash-messages` / `deepseek-v4-pro-messages`：指向 Anthropic 兼容面，
 *     客户端 Anthropic 格式 → fast path；OpenAI 格式进来则 canonical 转换。
 */
export function deepseekRouteAliases(): Record<string, RouteAlias> {
  const out: Record<string, RouteAlias> = {};
  for (const model of DEEPSEEK_MODEL_IDS) {
    const base = model === DEEPSEEK_MODELS.flash ? 'deepseek-flash' : 'deepseek-v4-pro';
    out[base] = {
      targets: [{ access_path: DEEPSEEK_ACCESS_PATHS.openaiChat, provider: 'deepseek', model }],
      max_context_tokens: DEEPSEEK_CONTEXT_TOKENS,
    };
    out[`${base}-messages`] = {
      targets: [
        {
          access_path: DEEPSEEK_ACCESS_PATHS.anthropicMessages,
          provider: 'deepseek',
          model,
        },
      ],
      max_context_tokens: DEEPSEEK_CONTEXT_TOKENS,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// profile 对象
// ---------------------------------------------------------------------------

/**
 * DeepSeek 的 ProviderProfile 实现。
 *
 * 分流说明：
 *   - `endpointPath`：两个 dialect 各自给官方路径（无 /v1 的那条最容易踩坑）；
 *   - `usageFromRaw`：只对 OpenAI 方言生效（Anthropic 方言的 usage 形态与
 *     Anthropic 本家一致，anthropic-messages codec 既有映射已正确）；
 *   - `builtinToolWire` / `builtinToolCanonicalName`：全家桶两个服务端工具的双向映射；
 *   - `thinkingWire`：只对 OpenAI 方言生效（Anthropic 方言的 thinking:{type}
 *     与 codec 默认输出一致，无需覆盖）。
 */
export function createDeepSeekProfile(): ProviderProfile {
  return {
    id: 'deepseek',
    accessPaths: DEEPSEEK_ACCESS_PATH_IDS,
    endpointPath(accessPath: string): string | undefined {
      if (accessPath === DEEPSEEK_ACCESS_PATHS.openaiChat) return DEEPSEEK_OPENAI_CHAT_PATH;
      if (accessPath === DEEPSEEK_ACCESS_PATHS.anthropicMessages) {
        return DEEPSEEK_ANTHROPIC_MESSAGES_PATH;
      }
      return undefined;
    },
    usageFromRaw(raw: Record<string, unknown>): TokenUsage | undefined {
      // 只有 OpenAI 方言有专有字段需要归一（顶层 prompt_cache_hit/miss_tokens）；
      // Anthropic  dialect 的 usage 交给 anthropic-messages codec（返回 undefined = 不干预）。
      // 判据：Anthropic 形态必有 input_tokens/output_tokens 且没有 prompt_tokens。
      if (raw['prompt_tokens'] === undefined && raw['input_tokens'] !== undefined) {
        return undefined;
      }
      const tokens = deepseekOpenAiUsageFromRaw(raw);
      // 一个字段都不认识时返回 undefined（不干预）
      return tokens;
    },
    builtinToolWire(canonicalName, format) {
      const vendorType = VENDOR_TOOL_TYPE_BY_CANONICAL_NAME[canonicalName];
      if (vendorType === undefined || vendorType === '') return undefined;
      // Messages 面要求 name 必填且等于 type 串；Chat Completions 面只认 type
      if (format === 'anthropic.messages') return { type: vendorType, name: vendorType };
      return { type: vendorType };
    },
    builtinToolCanonicalName(vendorType: string): BuiltinTool['name'] | undefined {
      return CANONICAL_NAME_BY_VENDOR_TOOL_TYPE[vendorType];
    },
    // DeepSeek 的两个 web 工具是裸能力开关：官方文档明确 allowed_domains /
    // blocked_domains / user_location 等配置字段一律 400。因此 config 必须丢弃
    // + 告警，不能原样发过去（见 di/ports.ts 的 builtinToolAcceptsConfig）。
    builtinToolAcceptsConfig(): boolean {
      return false;
    },
    thinkingWire(thinking: ThinkingConfig): Record<string, unknown> {
      return deepseekThinkingWire(thinking);
    },
  };
}
