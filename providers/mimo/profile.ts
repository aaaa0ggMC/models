/**
 * providers/mimo/profile.ts —— 小米 MiMo provider profile（provider 专有知识的唯一集中处）。
 *
 * 一手来源（2026-11-16 逐页核实 + 逐条实测，官方文档与仓库内探测记录各一份）：
 *   - https://mimo.mi.com/docs/zh-CN/api/chat/openai-api-post （OpenAI Chat Completion API）
 *   - https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition-post （ASR，OpenAI API 兼容）
 *   - https://mimo.mi.com/docs/zh-CN/api/audio/tts-post （TTS，OpenAI API 兼容）
 *   - https://mimo.mi.com/docs/zh-CN/api/model/list-models-get （列出模型）
 *   - MIMO-INTEGRATION-REPORT.md §3（本仓库对上述形状的逐条 curl 实测）
 *
 * ## 与 OpenAI 本家的差异（映射表）
 *
 * | 维度 | OpenAI 本家 | MiMo |
 * |---|---|---|
 * | 端点 | POST /v1/chat/completions | POST /v1/chat/completions（**同**） |
 * | base URL | api.openai.com（路径 /v1 在端点里） | token-plan-cn.xiaomimimo.com（同左；文档另写 api.xiaomimimo.com） |
 * | 鉴权 | Bearer | Bearer **或** `api-key` 头（两者都实测可用；本仓库发 Bearer） |
 * | 推理开关 | reasoning_effort 档位 | reasoning_effort 档位（**同**；实测 none/low 都认） |
 * | 思考内容 | （无） | message/delta.`reasoning_content`（**与 DeepSeek 同名同义**） |
 * | usage | prompt_tokens_details.cached_tokens | 同；另加 `prompt_tokens_details.audio_tokens`（音频输入 token）与顶层 `seconds`（音频时长） |
 * | 音频端点 | POST /v1/audio/speech、/v1/audio/transcriptions | **没有**（全 404）；TTS/ASR 都走 /v1/chat/completions 按模型分发，见 audio.ts |
 * | 模型元数据 | /models 给 context_window 等 | /models **只给** id/object/owned_by（见下） |
 *
 * 模型（2026-11 现行，`GET /v1/models` 实测 6 个）：
 *   - `mimo-v2.6-flash` / `mimo-v2.6-pro`：LLM（chat 模态，默认开推理，回 reasoning_content）；
 *   - `mimo-v2.5-asr`：语音识别（经 chat completions 的 input_audio content part）；
 *   - `mimo-v2.5-tts` / `-voiceclone` / `-voicedesign`：语音合成（经 chat completions 的
 *     `audio` 请求参数，响应在 `message.audio.data`）。
 *   MiMo-V2.5-Pro / MiMo-V2.5 已于 2026-10-21 下线（官方公告），不再登记。
 *
 * ## 为什么这个 profile 只有 endpointPath 一项
 *
 * MiMo 的 Chat Completions 面**就是 OpenAI 形状**：usage 字段（prompt_tokens /
 * completion_tokens / total_tokens / prompt_tokens_details.cached_tokens /
 * completion_tokens_details.reasoning_tokens）与 openai.chat codec 的默认映射逐字段一致，
 * `reasoning_effort` 的语义也一致（none = 关推理，实测确认），`reasoning_content` 更是
 * codec 早已建模的消息级键。因此**不覆盖** usageFromRaw / thinkingWire / builtinToolWire——
 * 覆盖它们只会得到一份与 codec 默认行为相同的代码，而"看起来接了"比"没接"更危险
 * （di/ports.ts 的 ProviderProfile 立场：返回 undefined = 不干预）。
 *
 * 真正需要 provider 级知识的只有端点路径：base_url 已含 `/v1`（与 DeepSeek「无 /v1」
 * 正好相反），所以 profile 必须给出 `/chat/completions`，否则 codec 的默认
 * `/v1/chat/completions` 会拼出 `/v1/v1/chat/completions`。
 *
 * 依赖注入：本模块只导出**数据与纯函数**，不读 process.env、不起 HTTP、不建单例；
 * 由组合根注册进 ProviderProfileRegistry。
 */

import type { CapabilityEntry } from '../../ir/index.js';
import type {
  ProviderExtensionPointSpec,
  ProviderProfile,
  ProviderRoutingOptionSpec,
} from '../../di/ports.js';
import type { RouteAlias } from '../../gateway-core/router.js';

// ---------------------------------------------------------------------------
// 常量：access path / 模型 / 端点 / key 环境变量
// ---------------------------------------------------------------------------

/** MiMo 的 access path id（credentials/resolver.ts 的 DEFAULT_ACCESS_PATHS 同值）。 */
export const MIMO_ACCESS_PATHS = {
  /** OpenAI 方言（openai.chat codec）——v1 只有这一条。 */
  openaiChat: 'mimo.openai-chat',
} as const;

export const MIMO_ACCESS_PATH_IDS: readonly string[] = Object.values(MIMO_ACCESS_PATHS);

/**
 * MiMo 上游默认 base URL（Token Plan 专用 host，**只到 host，不含路径**）。
 *
 * 官方文档两页写的请求地址是 `https://api.xiaomimimo.com/v1/chat/completions`；本仓库的
 * key 是 Token Plan key，实测 `token-plan-cn.xiaomimimo.com` 同路径可用（2026-11-16）。
 * 另一个 host 未实测，故不写进 base（presets.ts 的 note 已说明差异）。
 *
 * **为什么 base 不含 /v1**：transport 用 `new URL(path, base_url)` 拼地址，base 带路径时
 * 绝对路径会把那一段**整段替换掉**（`new URL('/chat/completions',
 * 'https://h/v1')` → `https://h/chat/completions`，/v1 消失 → 上游 404）。所以 base 只到
 * host、版本路径进 `MIMO_CHAT_PATH`，与「base 不含路径，路径由 codec / provider profile 给」
 * 的仓库不变量一致（presets.ts 文件头同款表述）。
 */
export const MIMO_BASE_URL = 'https://token-plan-cn.xiaomimimo.com';

/** Chat Completions 端点路径（**含 /v1**：与 DeepSeek「无 /v1」正好相反）。 */
export const MIMO_CHAT_PATH = '/v1/chat/completions';

/** 上游 key 的环境变量名（值只在进程环境里，仓库只出现变量名）。 */
export const MIMO_KEY_ENV = 'MIMO_API_KEY';

/** 现行 LLM 模型清单（v1 仅 chat 模态；音频模型见 audio.ts）。 */
export const MIMO_MODELS = {
  flash: 'mimo-v2.6-flash',
  pro: 'mimo-v2.6-pro',
} as const;

export const MIMO_MODEL_IDS: readonly string[] = Object.values(MIMO_MODELS);

/**
 * 模型机读元数据（**只登记实测得到的字段**）。
 *
 * `GET /v1/models` 对 MiMo **只返回** `id` / `object` / `owned_by`——没有
 * context_window / max_output_tokens / input_modalities / output_modalities / effort。
 * 因此这些字段一律留空：给一个"看起来合理"的数字等于让能力矩阵说谎（路由预检、
 * `/v1/models` 的上下文展示都读它）。上游哪天补了元数据，由 discovery 刷新覆盖
 * （providers/mimo/discovery.ts），不需要改这里。
 */
export interface MiMoModelMeta {
  id: string;
  display_name: string;
}

export const MIMO_MODEL_META: Readonly<Record<string, MiMoModelMeta>> = {
  'mimo-v2.6-flash': { id: 'mimo-v2.6-flash', display_name: 'MiMo-V2.6-Flash' },
  'mimo-v2.6-pro': { id: 'mimo-v2.6-pro', display_name: 'MiMo-V2.6-Pro' },
};

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
 * MiMo 能力矩阵条目：2 模型 × 1 dialect = 2 条，模态仅 chat。
 *
 * `quirks` 是人类可读的已知怪癖（进能力矩阵）；`unsupported_fields` 是路由预检用的
 * canonical 字段路径（20 §S2 第 6 步，on_unsupported=strict 时直接拒绝）。
 * 只登记**已实现且契约测试覆盖**的条目（40 §5：planned 不进矩阵）。
 */
export function mimoCapabilities(): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];
  for (const model of MIMO_MODEL_IDS) {
    entries.push({
      access_path: MIMO_ACCESS_PATHS.openaiChat,
      model,
      modality: 'chat',
      format: 'openai.chat',
      streaming: CHAT_STREAMING,
      usage_source: 'provider',
      usage_units: ['tokens'],
      // OpenAI 兼容面**没有** json_schema 档（官方 enum 只有 text / json_object），
      // 与 DeepSeek 同款立场：不静默丢字段，路由预检先拒。
      unsupported_fields: ['params.response_format.json_schema'],
      quirks: [
        `上游模型名 ${MIMO_MODEL_META[model]?.display_name ?? model}`,
        '端点是 POST /v1/chat/completions——**带 /v1**（与 DeepSeek「无 /v1」相反）；base_url 只到 host，版本路径在端点里',
        '鉴权 Bearer 或 api-key 头都认；仓库发 Bearer',
        '默认开推理，响应/流式 delta 带 reasoning_content（与 DeepSeek 同名同义）；reasoning_effort=none 可关',
        'usage 顶层另给 seconds（音频时长秒）与 prompt_tokens_details.audio_tokens（音频输入 token），仅音频模型出现',
        'TTS / ASR 没有独立 REST 端点（/v1/audio/* 全 404）：经同一 chat completions 按模型分发，见 providers/mimo/audio.ts',
        'GET /v1/models 只返回 id/object/owned_by，没有 context_window 等元数据——矩阵里这些字段留空，不编造',
      ],
      contract_tested: true,
      status: 'implemented',
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 路由别名（组合根的 defaultRouteTable 追加）
// ---------------------------------------------------------------------------

/**
 * MiMo 模型别名 → access path。
 *
 * 只登记**裸 id**（`mimo-v2.6-flash` / `mimo-v2.6-pro`）：客户端写模型名即可路由到
 * MiMo。不额外造 `-messages` 之类的第二名字——MiMo 没有 Anthropic 兼容面
 * （`/v1/messages` 未实测，官方文档也没有该页），编一个只会制造"看起来支持"的假象。
 *
 * 上下文窗口不填（`max_context_tokens` 缺省）：上游没给这个数，路由里的窗口字段是
 * 给回退/截断决策用的，填错比不填更糟。
 */
export function mimoRouteAliases(): Record<string, RouteAlias> {
  const out: Record<string, RouteAlias> = {};
  for (const model of MIMO_MODEL_IDS) {
    out[model] = {
      targets: [{ access_path: MIMO_ACCESS_PATHS.openaiChat, provider: 'mimo', model }],
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// profile 对象
// ---------------------------------------------------------------------------

export const MIMO_ROUTING_OPTIONS: readonly ProviderRoutingOptionSpec[] = [
  {
    key: 'min_remaining_credits',
    label: '最低剩余积分',
    unit: '积分',
    type: 'number',
    default_value: 100,
    telemetry_field: 'remaining_credits',
    operator: 'gte',
  },
  {
    key: 'max_credit_usage_pct',
    label: '套餐已用比例上限',
    unit: '%',
    type: 'number',
    default_value: 95,
    telemetry_field: 'credit_usage_pct',
    operator: 'lte',
  },
  {
    key: 'min_balance',
    label: '最低可用余额',
    unit: 'CNY',
    type: 'number',
    telemetry_field: 'balance',
    operator: 'gte',
  },
];

/**
 * MiMo 的 ProviderProfile 实现。
 *
 * 只有 `endpointPath` 一项（理由见文件头）：其余钩子都返回 undefined = 不干预，
 * 让 openai.chat codec 的默认映射生效——那正是 MiMo 的语义。
 */
export function createMiMoProfile(): ProviderProfile {
  return {
    id: 'mimo',
    accessPaths: MIMO_ACCESS_PATH_IDS,
    endpointPath(accessPath: string): string | undefined {
      if (accessPath === MIMO_ACCESS_PATHS.openaiChat) return MIMO_CHAT_PATH;
      return undefined;
    },
    routingNodeOptions(): readonly ProviderRoutingOptionSpec[] {
      return MIMO_ROUTING_OPTIONS;
    },
    routingExtensionPoints(): readonly ProviderExtensionPointSpec[] {
      return [
        {
          port: 'low_credits',
          label: '积分不足分流',
          kind: 'branch',
          telemetry_field: 'remaining_credits',
          operator: 'lte',
          default_threshold: 1000,
          tone: 'rose',
        },
      ];
    },
  };
}
