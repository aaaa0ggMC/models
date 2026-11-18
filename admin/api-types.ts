/**
 * admin/api-types.ts —— 管理面 HTTP API 的**唯一契约**。
 *
 * 这个文件同时是：
 *   - admin/routes.ts 的实现依据（请求/响应形状）；
 *   - webui/admin/ 前端的数据契约（前端只认这里的类型，不认 routes.ts 的内部结构）。
 *
 * 把契约单独放一个文件（而不是散在 routes.ts 里）的理由：前端与后端要能**并行**
 * 开发与并行 review。契约变了是两个文件都要改，有编译期约束；契约埋在实现里
 * 就只有运行时能发现。
 *
 * ## 统一约定
 *
 * - 所有路由挂在 `/admin/api/` 下（前端静态资源在 `/admin/`），与数据面
 *   `/v1/*` 完全不撞；
 * - 除 `POST /admin/api/login` 与 `GET /admin/api/bootstrap` 外，**全部要鉴权**；
 * - 响应一律 JSON；错误用统一信封 `{ error: { code, message } }`；
 * - **任何响应里都不出现完整 secret**——凭据只回掩码（见 MaskedCredential）。
 */

import type { ChannelPricingConfig } from '../metering/pricing.js';

export type PresetDialect =
  | 'openai.chat'
  | 'anthropic.messages'
  | 'openai.responses'
  | 'gemini.generateContent';

/** 一条 access path 预设（一家 provider 可能有多个 dialect 端点）。 */
export interface ProviderAccessPathPreset {
  /** 建议的 access_path id（如 `deepseek.openai-chat`）；凭据据此寻址。 */
  id: string;
  /** 人类可读标签（如「DeepSeek（OpenAI 兼容）」）。 */
  label: string;
  /** 该端点的 wire 方言。 */
  dialect: PresetDialect;
  /** 上游 base URL。 */
  base_url: string;
  /** 该端点的默认/常用模型 id（仅作便利预填，权威清单来自同步）。 */
  default_models: string[];
  /** 声明式传输提示（端点路径覆盖、固定附加头、会话头）。 */
  transport_hints?: import('../ir/credential.js').AccessPathTransportHints;
}

/** 一个已知 Provider 的预设契约。 */
export interface ProviderPreset {
  id: string;
  name: string;
  group: string;
  homepage: string;
  docs: string;
  key_hint: string;
  key_prefix?: string;
  access_paths: ProviderAccessPathPreset[];
  default_access_path?: string;
  source: string;
  confidence: 'official' | 'community' | 'unverified';
  needs_verification?: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/** 统一错误信封。 */
export interface ApiError {
  error: { code: string; message: string };
}

/** 分页（简单 limit/offset；控制面量小，不做游标）。 */
export type PageQuery = {
  limit?: number;
  offset?: number;
};

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// 引导 / 解锁状态
// ---------------------------------------------------------------------------

/**
 * `GET /admin/api/bootstrap` —— 前端首屏要知道的一切。
 *
 *  deliberately 不含任何秘密：只有「要不要登录」「存储解锁了没」「密钥管理
 * 是什么模式及其代价」。代价文案由 keystore 的 `tradeoffNote` 提供，
 * UI **原样展示，不得改写**（65 §3.2b 的硬要求）。
 */
export interface BootstrapResponse {
  /** 是否需要登录（未登录时为 false → 前端跳登录页）。 */
  authenticated: boolean;
  /** 加密存储是否已解锁。false = 管理面能看界面但读不到任何 secret。 */
  storage_unlocked: boolean;
  /** 当前用户（未登录为 undefined）。 */
  user?: { id: string; name: string; role: 'owner' | 'viewer' };
  keystore: {
    /** 两种解锁模式之一。 */
    mode: 'passphrase' | 'key_file';
    /** **原样展示**的代价说明（65 §3.2b）。 */
    tradeoff_note: string;
    /** 是否建议升级 Argon2 参数（passphrase 模式）。 */
    argon2_rehash_recommended: boolean;
  };
  /** 控制面 API 版本（前端可用来提示升级）。 */
  api_version: string;
}

export interface LoginRequest {
  password?: string;
  /** 单 access token 模式（66 §2.2 的 `AG_ACCESS_TOKEN` 同款思路）。 */
  access_token?: string;
}

export interface LoginResponse {
  ok: boolean;
  /** 会话令牌（前端放 Authorization: Bearer）。 */
  token?: string;
  /** 令牌有效期（epoch ms）。 */
  expires_at?: number;
  user?: { id: string; name: string; role: 'owner' | 'viewer' };
  error?: string;
}

export interface LogoutResponse {
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Provider CRUD
// ---------------------------------------------------------------------------

/** 一个上游 provider 的配置（**不含任何凭据**）。 */
export interface ProviderConfig {
  id: string;
  /** 人类可读名。 */
  label: string;
  /** wire 方言（决定用哪个 adaptor codec）。 */
  dialect: 'openai.chat' | 'anthropic.messages' | 'openai.responses' | 'gemini.generateContent';
  /** 上游 base URL（不含路径）。 */
  base_url: string;
  /**
   * 模型命名空间（**默认留空** = 现状行为，模型名不带前缀）。
   *
   * 留空时客户端直接用上游 model id（`deepseek-flash`）；填了之后该渠道的模型
   * 同时可用 `<namespace>/<model>` 访问（生效名 = `ds/deepseek-flash`）。
   * 解析优先级（高 → 低）：显式别名 → namespace → 通用前缀规则 → 原样 model id。
   */
  namespace?: string;
  /** 模型清单来源。 */
  model_source:
    | { kind: 'static'; models: string[] }
    | { kind: 'discovery'; path: string }
    | { kind: 'offline_catalog'; ref: string };
  /** 已保存的模型元数据快照（来自上游 /models 或 models.dev 同步，避免重开编辑弹窗丢失）。 */
  model_metadata?: Record<string, UpstreamModelDto>;
  /**
   * 服务端工具默认注入开关（**默认全关**）。
   *
   * 关 = 客户端自己在 `tools[]` 里声明（请求级，现状行为）；开 = 这个渠道的每个
   * 请求都默认带上该 canonical builtin tool，由 codec 做方言映射。客户端已声明
   * 的同名工具不会被重复注入。
   */
  builtin_tools?: ProviderBuiltinToolDefaults;
  /** 渠道级自定义单价表与倍率覆盖。 */
  pricing?: ChannelPricingConfig;
  /** 能力约束覆盖（与 ir/capability.ts 同源的字段子集）。 */
  capability_overrides?: {
    unsupported_fields?: string[];
    constraints?: {
      system_prompt_update?: 'leading-only' | 'in-history';
      tool_update?: 'leading-only' | 'addition-only';
    };
    streaming_mode?: 'none' | 'sse' | 'chunked-binary' | 'ws-duplex';
  };
  enabled: boolean;
  /**
   * 自动禁用状态（**由网关写，不由管理员手填**）。
   *
   * 为什么不用 NewAPI 的三态 int（启用/手动禁/自动禁）：自动禁用恢复时会把
   * `enabled` 置回 true，而那会顺手覆盖掉管理员的手动禁用——"我关掉的渠道被一次
   * 成功探测重新打开"比"渠道一直关着"更危险。分成两个字段之后，恢复只清
   * `auto_disabled`，绝不碰 `enabled`。
   *
   * 同一字段承载两态，靠 `reason` 区分：
   *   - `"连续失败计数中"`：还没到阈值，**只是累计**，渠道仍参与轮换；
   *   - 其他（达到阈值 / 401 立即禁用）：真的关掉了，请求路径会过滤掉它。
   * 判据见 admin/provider-runtime.ts 的 `isAutoDisabled`。
   */
  auto_disabled?: {
    /** 禁用原因（**一句话**，进审计与渠道列表）。 */
    reason: string;
    /** 禁用时刻（epoch ms）。 */
    at: number;
    /** 触发禁用时的连续失败次数。 */
    consecutive_failures: number;
  };
  /** 凭据健康（探测结果回写；`unknown` = 从未探测成功过）。 */
  credential_health?: 'unknown' | 'ok' | 'error';
  /** 最近一次凭据探测时刻（epoch ms）。 */
  credential_last_checked?: number;
  created_at: number;
  updated_at: number;
  note?: string;
}

/**
 * 服务端工具默认注入开关（provider 级，默认关）。
 *
 * 只列 DeepSeek 全家桶已建模的两个 canonical builtin tool（50 §2.2 的稳定名）；
 * 新增工具要先在 canonical 里有稳定名，再在这里开开关——不允许出现"界面上有开关
 * 但 canonical 不认识这个工具"的状态。
 */
export interface ProviderBuiltinToolDefaults {
  /** canonical `web_search`（DeepSeek 方言：`deepseek_web_search`）。 */
  web_search?: boolean;
  /** canonical `url_context`（DeepSeek 方言：`deepseek_read_url`）。 */
  url_context?: boolean;
}

export type ProviderListResponse = Page<ProviderConfig>;

export interface ProviderUpsertRequest {
  id?: string;
  label: string;
  dialect: ProviderConfig['dialect'];
  base_url: string;
  /** 命名空间；省略或空串 = 不启用（同不留这个字段）。 */
  namespace?: string;
  model_source: ProviderConfig['model_source'];
  /** 服务端工具默认注入开关；省略 = 全关。 */
  builtin_tools?: ProviderBuiltinToolDefaults;
  pricing?: ChannelPricingConfig;
  capability_overrides?: ProviderConfig['capability_overrides'];
  enabled?: boolean;
  note?: string;
}

export interface ProviderUpsertResponse {
  ok: boolean;
  provider?: ProviderConfig;
  error?: string;
}

export interface ProviderDeleteResponse {
  ok: boolean;
  /** 是否真的删了（false = 本来就没有）。 */
  deleted: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// 拉取上游模型清单（`POST /admin/api/provider-models`）
// ---------------------------------------------------------------------------

/**
 * `POST /admin/api/provider-models` 的请求。
 *
 * 两种模式（**互斥**，都不落库）：
 *   - **预览模式**（创建中的渠道）：给 `api_key`，只用这一次、不进存储、不进日志；
 *   - **已存模式**（编辑已有渠道）：给 `provider_id`，用库里/环境里的凭据。
 *
 * `base_url` 与 `dialect` 两种模式都要：路径映射（`/models` vs `/v1beta/models`）
 * 在后端按 dialect 做，前端不猜。
 *
 * ## 字段名为什么叫 `api_key` 而不是 `key`
 *
 * 2026-11 修过一次真 bug：前端一直发 `api_key`（与 `credentials/resolver.ts` 的
 * `type: 'api_key'`、`gateway-core/pipeline/types.ts` 的 `api_key`、数据面
 * `auth/data-plane.ts` 的 `material.api_key` 同名），而这里叫 `key`，结果预览模式
 * 永远报「请提供 key（预览）或 provider_id（已存）」——填了 key 也拉不到模型。
 * 统一到 `api_key`，理由有三：
 *   1. **本仓库里 `api_key` 已经是「上游 provider key」的专有名名词**（ir/credential.ts
 *      的 CredentialType、credentials 的存储类型、pipeline 的入站字段都叫这个）；
 *   2. **裸 `key` 与虚拟 key 域撞名**——`SettingDto` 的标识符当年就叫 `key`，把前端
 *      的 secret tripwire 整页误拦过，后来改名 `id`（见 api/types.ts 的注释）。
 *      管理面契约里不该再留下第二个含义完全不同的 `key`；
 *   3. 前端 `secretTripwire` 的字段名辅助判据（`SECRETISH_NAME_RE`）认 `api_key`
 *      不认裸 `key`，同名也让守卫的覆盖保持一致。
 */
export interface ProviderModelsRequest {
  base_url: string;
  dialect: ProviderConfig['dialect'];
  /** 端点路径覆盖；缺省按 dialect 推（DeepSeek → `/models`）。 */
  path?: string;
  /** 预览模式的上游 key（**只用这一次，不落库、不进日志、不进错误信息**）。 */
  api_key?: string;
  /** 已存模式的 provider id。 */
  provider_id?: string;
}

/** 失败分类（前端按 code 给一句话 + 一个动作，不解析 message）。 */
export type ProviderModelsErrorCode =
  /** key 无效或没有该端点权限（上游 401/403）。 */
  | 'key_invalid'
  /** 这个 base_url 不支持模型发现端点（上游 404）。 */
  | 'endpoint_unsupported'
  /** 上游限流（429）。 */
  | 'rate_limited'
  /** 上游故障（5xx）。 */
  | 'upstream_error'
  /** 网关到上游不通（DNS / 连接 / 超时）。 */
  | 'network_error'
  /** 上游返回的不是合法 JSON。 */
  | 'invalid_json'
  /** 是合法 JSON 但没有模型清单字段。 */
  | 'invalid_shape'
  /** 已存模式但拿不到凭据。 */
  | 'credential_missing'
  /** 请求本身不合法（缺字段 / 两种模式都没给 / 都给了）。 */
  | 'invalid_request';

/** 上游返回的一个模型（**全部字段可选**——非 DeepSeek 上游通常只回 id）。 */
export type UpstreamModelCategory = 'chat' | 'tts' | 'asr' | 'image' | 'video' | 'embedding';

export interface UpstreamModelDto {
  id: string;
  name?: string;
  owned_by?: string;
  category?: UpstreamModelCategory;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>;
  output_modalities?: Array<'text' | 'audio' | 'image' | 'video'>;
  reasoning?: boolean;
  /** 非对话模态（TTS / ASR / 图像 / 向量）的补充规格指标。 */
  specs?: {
    billing_unit?: string;
    capability?: string;
  };
  metadata_source?: 'upstream' | 'models.dev' | 'inferred';
  /**
   * effort 档位（**归一化形状**，不是 `/models` 的 wire 形状）。
   *
   * 2026-11 修过一次真 bug：`toDto` 曾把上游的 `{supported_levels, default_level}`
   * 原样透传给前端，而前端类型要的是 `{levels, default}`，于是 `effort.levels.length`
   * 读 undefined 直接把管理面整棵 React 树打崩（白屏）。**wire 形状只许存在于
   * provider 解码边界**，越过它就归一化；上游没给 `supported_levels` 就整个 `effort`
   * 不出现，别发半截对象。
   */
  effort?: { levels: string[]; default?: string };
  /**
   * 上游按 dialect 声明的行为约束，**已归一化成扁平字符串**（如
   * `system_prompt_update: leading-only`）。wire 形状只存在于 provider 解码边界。
   */
  constraints?: string[];
}

export interface ProviderModelsResponse {
  ok: true;
  /** 数据来源（v1 恒 `upstream`：这个端点永远打真实上游，不用缓存）。 */
  source: 'upstream';
  fetched_at: number;
  models: UpstreamModelDto[];
  /** 上游未返回元数据时为 true（前端退化成 id 列表 + 一句说明）。 */
  metadata_incomplete: boolean;
}

/** 失败响应（统一信封 `{ ok: false, error: {...} }`）。 */
export interface ProviderModelsFailure {
  ok: false;
  error: {
    code: ProviderModelsErrorCode;
    /** **一句话**（Toast / Tooltip 级别），不含 key、不含完整响应体。 */
    message: string;
    /** 上游状态码（拿不到为 undefined）。 */
    upstream_status?: number;
    /** 可展开的细节（已剥离 key；前端放"详情"折叠区）。 */
    detail?: string;
  };
}

// ---------------------------------------------------------------------------
// 凭据管理（**只回掩码**）
// ---------------------------------------------------------------------------

/**
 * 凭据列表条目。
 *
 * **没有任何字段能还原出完整 key**——`masked` 是给人看的，`length` / `head`
 * 是元数据。完整 key 只进加密存储（storage/record-store.ts 的密文列），
 * 创建时那一次响应（CredentialCreateResponse）也不回显，只在日志外的
 * 调用方内存里存在。
 */
export interface MaskedCredential {
  id: string;
  provider: string;
  access_path: string;
  /** 掩码形式，如 `sk-****abcd`。 */
  masked: string;
  /** 明文长度（元数据，不含内容）。 */
  length: number;
  /** 前 4 位（不含后半）；太短则空串。 */
  head: string;
  /** 存储位置：env 引用或加密存储。 */
  storage:
    | { location: 'env'; ref: string }
    | { location: 'encrypted' }
    | { location: 'keyring'; ref: string };
  enabled: boolean;
  health: 'unknown' | 'ok' | 'error';
  last_checked?: number;
  created_at: number;
  updated_at: number;
  note?: string;
}

export type CredentialListResponse = Page<MaskedCredential>;

export interface CredentialCreateRequest {
  provider: string;
  access_path: string;
  /**
   * 完整 key。**只在这一次请求体里出现**，服务端立刻加密入库，
   * 响应不回显、不写日志（见 admin/routes.ts 的 redactLogger）。
   */
  secret: string; // privacy-scan: ignore —— CredentialCreateRequest 契约字段名（类型声明，无值）
  note?: string;
  /**
   * 环境变量引用（替代直接传 secret）：`env:DEEPSEEK_API_KEY`。
   * 传了它就不该传 `secret`（两者互斥，服务端会拒）。
   */
  env_ref?: string;
}

export interface CredentialCreateResponse {
  ok: boolean;
  credential?: MaskedCredential;
  error?: string;
}

export interface CredentialDeleteResponse {
  ok: boolean;
  deleted: boolean;
  error?: string;
}

/** 凭据健康探测（打一次上游，看 key 还能不能用）。 */
export interface CredentialProbeResponse {
  ok: boolean;
  credential_id: string;
  /** 探测结果。 */
  status: 'ok' | 'error' | 'unknown';
  /** 上游返回的 HTTP 状态（拿不到为 undefined）。 */
  upstream_status?: number;
  /** 失败原因（不含 key）。 */
  message?: string;
  checked_at: number;
}

// ---------------------------------------------------------------------------
// 别名 / namespace 映射
// ---------------------------------------------------------------------------

export interface AliasRuleDto {
  id: string;
  kind: 'exact' | 'prefix';
  pattern: string;
  target: { provider: string; access_path: string; model: string; max_context_tokens?: number };
  priority: number;
  enabled: boolean;
  note?: string;
  created_at: number;
  updated_at: number;
}

export interface AliasListResponse {
  items: AliasRuleDto[];
  total: number;
}

export interface AliasUpsertRequest {
  id?: string;
  kind: 'exact' | 'prefix';
  pattern: string;
  target: { provider: string; access_path: string; model: string; max_context_tokens?: number };
  priority?: number;
  enabled?: boolean;
  note?: string;
}

export interface AliasUpsertResponse {
  ok: boolean;
  rule?: AliasRuleDto;
  /** 校验失败的原因（坏规则宁可拒掉也不要进路由）。 */
  errors?: string[];
}

export interface AliasDeleteResponse {
  ok: boolean;
  deleted: boolean;
  error?: string;
}

/** 试解析一个模型名（不落库，给 UI 做"这条规则会命中什么"的预览）。 */
export interface AliasResolveRequest {
  model: string;
}

export interface AliasResolveResponse {
  ok: boolean;
  resolution?: {
    source: 'exact' | 'prefix' | 'passthrough';
    rule_id?: string;
    target: { provider: string; access_path: string; model: string };
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// 能力矩阵（只读视图，与 ir/capability.ts 同源）
// ---------------------------------------------------------------------------

/**
 * 能力矩阵条目（ir/capability.ts 的 CapabilityEntry 原样透出，不另写一份）。
 *
 * 默认响应**已按部署态过滤**（未配置 provider 的条目与 `internal` 脚手架默认不列，
 * 判据与 `GET /v1/models` 同源，见 catalog/visibility.ts）；`?all=1` 看全量，
 * 此时被隐藏的两类条目带下面的标注回来——状态必须诚实，未配置 ≠ 可用。
 */
export interface CapabilityMatrixEntry {
  access_path: string;
  model: string;
  namespace?: string;
  namespaced_id?: string;
  modality: string;
  format?: string;
  streaming?: {
    mode: string;
    partial_results?: boolean;
    usage_in_stream?: boolean;
    cancellable?: boolean;
    framing?: string;
  };
  usage_source: string;
  usage_units?: string[];
  unsupported_fields?: string[];
  quirks?: string[];
  constraints?: {
    system_prompt_update?: 'leading-only' | 'in-history';
    tool_update?: 'leading-only' | 'addition-only';
  };
  input_modalities?: string[];
  output_modalities?: string[];
  context_window?: number;
  max_output_tokens?: number;
  reasoning?: boolean;
  effort?: { supported_levels: string[]; default_level?: string };
  contract_tested: boolean;
  status: 'implemented' | 'planned' | 'on-demand';
  /** 内部脚手架（mock 路径）：做给机器看的，不是可调用的上游；默认不列，`?all=1` 才出现。 */
  internal?: boolean;
  /** provider 未配置（渠道表与凭据库都没有它）：默认不列，`?all=1` 才出现并带此标注。 */
  availability?: 'unconfigured';
}

export interface CapabilityMatrixResponse {
  items: CapabilityMatrixEntry[];
  total: number;
}

/**
 * access path 条目（`GET /admin/api/access-paths`）。
 *
 * UI 用它填 access_path 下拉；拉不到时前端退化成自由文本（见 webui/admin）。
 */
export interface AccessPathDto {
  id: string;
  label: string;
  /** 该 access path 是否需要凭据（mock / local 不需要）。 */
  requires_credential: boolean;
}

export interface AccessPathListResponse {
  items: AccessPathDto[];
}

/**
 * `GET /admin/api/env-credentials` —— 哪些 access path 上有 **env 档**凭据。
 *
 * Phase 1 的硬约束（AGENTS.md）：上游 key 一律走环境变量。这个端点只把布尔事实
 * 透出去（`count > 0` = 这条路径上有 key），**不暴露变量名，更不暴露值**——
 * 那是部署环境的事实与密钥材料，都不该进 HTTP 响应。
 *
 * 消费者是管理面「选一个模型来用」的可用性判据（webui/admin/src/api/
 * model-availability.ts）：判据的另一半是「已启用渠道 + 可用凭据」，而 env 档
 * 凭据不住在 `/credentials`（那只是加密存储的视图）。缺了这一问，
 * 「建好渠道 + 设好 env key」的部署会在选择器里显示成没有模型——请求却能打通，
 * 正是要消灭的那类割裂。
 */
export interface EnvCredentialPathDto {
  access_path: string;
  /** 该路径上已登记的 env 档凭据条数（编号变量 `_2` / `_3` … 各算一条）。 */
  count: number;
}

export interface EnvCredentialPathListResponse {
  items: EnvCredentialPathDto[];
}

// ---------------------------------------------------------------------------
// Provider 预设注册表（只读；「新建渠道」ComboBox 的数据源）
// ---------------------------------------------------------------------------

/**
 * `GET /admin/api/provider-presets` —— 已知 Provider 预设（只读）。
 *
 * 前端「新建渠道」用它把 ComboBox 填出来：选中预设即带出 base_url / dialect /
 * 默认模型 / 文档链接 / key 格式提示。纯便利端点，**不改变任何既有语义**：
 * 没有它前端退化成自由手填（与旧版一致）。
 */
export interface ProviderPresetListResponse {
  items: readonly ProviderPreset[];
  total: number;
}

// ---------------------------------------------------------------------------
// 同步触发
// ---------------------------------------------------------------------------

export interface SyncTriggerRequest {
  /** 触发哪种同步。 */
  kind: 'upstream_discovery' | 'offline_catalog_refresh';
  /** 目标 provider（缺省 = 全部已配的）。 */
  provider?: string;
}

export interface SyncTriggerResponse {
  ok: boolean;
  /** 本次同步结果（上游发现的 discovered / updated / added）。 */
  result?: {
    discovered: string[];
    updated: string[];
    added: string[];
  };
  /** 失败原因（不含 key）。 */
  error?: string;
  started_at: number;
  finished_at: number;
}

// ---------------------------------------------------------------------------
// 用量 / 对账看板
// ---------------------------------------------------------------------------

export interface UsageSummary {
  /** 区间起（epoch ms）。 */
  from_ts: number;
  /** 区间止（epoch ms）。 */
  to_ts: number;
  request_count: number;
  /** 输入 token 合计。 */
  input_tokens: number;
  output_tokens: number;
  /** 现金费用合计（USD，微美元精度由上游定价表决定）。 */
  cash_total: number;
  /** 等价 API 价值合计（订阅路径也照算）。 */
  as_api_total: number;
  /** 按原生币种拆分的金额明细（"USD" / "CNY" 等；cash_total / as_api_total 为原生币种合计）。 */
  by_currency?: Record<string, { cash_total: number; as_api_total: number; requests: number }>;
  /** 未定价的请求数（拿不到价格，不是"免费"）。 */
  unpriced_count: number;
  by_model: Array<{ model: string; request_count: number; cash_total: number }>;
  by_provider: Array<{ provider: string; request_count: number; cash_total: number }>;
  /**
   * 按上游凭据（key）拆分（60 §3：UsageRecord.credential_id）。
   *
   * 同一渠道下配了多把 key 时，`by_provider` 会把它们全并成一个数——"哪把 key 在烧
   * 配额"就没有答案。这里补上那一维。
   *
   * 没有 credential_id 的记录（路径不需要凭据，或上游调用没走到签发鉴权头）归到
   * `未记录`——那是一个真实的第三种情况，不是 0，也不是某一把 key。
   */
  by_credential: Array<{ credential: string; request_count: number; cash_total: number }>;
}

export interface UsageDashboardResponse {
  summary: UsageSummary;
  /** 最近 N 条 usage 记录（脱敏：无 header、无 key、无正文）。 */
  recent: Array<{
    request_id: string;
    ts: number;
    provider: string;
    model: string;
    model_alias?: string;
    status: string;
    input_tokens: number;
    output_tokens: number;
    cash_total: number;
    finish_reason: string;
    fast_path: boolean;
  }>;
  /** 最近一次对账结果（没有则为 undefined）。 */
  reconciliation?: {
    from_ts: number;
    to_ts: number;
    currency: string;
    estimated_cash: number;
    actual_topped_up_delta: number;
    actual_granted_delta: number;
    deviation_ratio: number | null;
    request_count: number;
    alert: boolean;
    alert_threshold: number;
  };
  /** 余额快照（探测触发后刷新）。 */
  balance?: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
}

export interface UsageQuery {
  from_ts?: number;
  to_ts?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// 用量时间序列（趋势图的唯一数据来源）
// ---------------------------------------------------------------------------

/**
 * 时间序列的一个桶（bucket）。
 *
 * 桶是**左闭右开**区间 `[from_ts, to_ts)`，与 `GET /usage` 的区间语义一致。
 * `request_count === 0` 的桶**照样返回**（空桶不是缺口）：趋势图要的是等距的
 * x 轴，缺一个桶就会被渲染成"这里没有数据"而不是"这里确实没有请求"。
 */
export interface UsageTimeseriesBucket {
  from_ts: number;
  to_ts: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cash_total: number;
  as_api_total: number;
  unpriced_count: number;
}

export interface UsageTimeseriesResponse {
  from_ts: number;
  to_ts: number;
  /** 桶宽（epoch ms）。 */
  bucket_ms: number;
  /**
   * 服务端实际切出的桶数（由区间长度与桶宽决定，前端不得假设）。
   *
   * 前端只需要 `bucket_ms` 与 `buckets.length` 就能画等距 x 轴，不需要自己算
   * 边界——两边算同一套边界迟早会漂。
   */
  buckets: UsageTimeseriesBucket[];
  /** 后端是否注入了 usage 源（未注入时 buckets 为空数组，不是报错）。 */
  available: boolean;
}

// ---------------------------------------------------------------------------
// 余额探测触发
// ---------------------------------------------------------------------------

export interface BalanceProbeResponse {
  ok: boolean;
  /** 探测到的余额（拿不到则为空数组）。 */
  balances: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
  is_available: boolean;
  /** 探测时间。 */
  checked_at: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// 密钥管理（解锁 / 轮换）
// ---------------------------------------------------------------------------

/**
 * 密钥库状态。
 *
 * `tradeoff_note` 是 65 §3.2b 要求**原样展示**的代价说明，前端不得改写。
 */
export interface KeystoreStatusResponse {
  mode: 'passphrase' | 'key_file';
  tradeoff_note: string;
  unlocked: boolean;
  active_dek_id: string;
  /** 该 DEK 已加密条数。 */
  encryption_count: number;
  should_rotate_dek: boolean;
  argon2_rehash_recommended: boolean;
  /** KEK 指纹（不含 KEK 本体）。 */
  kek_fingerprint: string;
}

export interface KeystoreRotateKekRequest {
  /** 新 KEK 来源。passphrase 模式 = 新口令；key_file 模式忽略。 */
  new_passphrase?: string;
  /**
   * 破坏性操作确认。**必须显式传 true**——轮换 KEK 会让旧密钥表作废，
   * 没备份的数据永久解不开。UI 要弹二次确认，不能让用户一键触发。
   */
  confirm?: boolean;
}

export interface KeystoreRotateKekResponse {
  ok: boolean;
  /**
   * 失败原因（**不含 KEK / 口令 / 任何密文**）。ok 为 false 时必有。
   *
   * ⚠️ 这里曾经挂着一句「轮换后仍可解密的数据条数（0 = 全部改用新 KEK 成功）」——
   * 从别的字段复制串了，而 `error?: string` 装不下条数。若将来真的需要
   * 「轮换后校验了多少条记录仍可读」，请另加 `verified_count?: number`，
   * 不要往 error 里塞。
   */
  error?: string;
  /** 轮换后的 KEK 指纹（SHA-256 前 8 字节；不含 KEK 本体）。 */
  kek_fingerprint?: string;
}

export interface KeystoreRotateDekResponse {
  ok: boolean;
  new_dek_id?: string;
  /** 顺带把旧 DEK 的记录重加密到新 DEK 的条数。 */
  reencrypted?: number;
  error?: string;
}

/** 审计日志条目（写操作留痕；**绝不含 secret**）。 */
export interface AuditLogEntry {
  id: string;
  ts: number;
  /** 操作者（会话 id 或 'system'）。 */
  actor: string;
  action: string;
  /** 操作对象（如 `provider/deepseek`、`alias/builtin:fast`）。 */
  subject: string;
  /** 结果。 */
  outcome: 'ok' | 'error';
  /** 附加信息（**不得含 secret / 完整 key**）。 */
  detail?: string;
}

export type AuditLogResponse = Page<AuditLogEntry>;

// ---------------------------------------------------------------------------
// 数据面 virtual key（66 §2）
// ---------------------------------------------------------------------------

/**
 * virtual key 的列表条目。
 *
 * **绝不明文回显**：这里只有 `key_id`、掩码与前 8 位（66 §2.2：「之后只能看
 * key_id 与前 8 位」）。完整明文只在创建响应里出现一次，见
 * `VirtualKeyCreateResponse.plaintext`。
 */
export interface VirtualKeyDto {
  key_id: string;
  name: string;
  note?: string;
  status: 'active' | 'revoked';
  created_at: number;
  updated_at: number;
  revoked_at?: number;
  expires_at?: number;
  models?: string[];
  providers?: string[];
  allow_message_persistence?: boolean;
  allow_streaming?: boolean;
  allowed_plugins?: string[];
  disabled_plugins?: string[];
  allowed_modalities?: string[];
  rate_limit?: { rpm?: number; tpm?: number };
  budget_micros?: number;
  team_id?: string;
  user_id?: string;
  /** 掩码（前 8 位 + 省略号；不露长度）。 */
  masked: string;
  /** 明文前 8 位（非敏感；便于人认出是哪把 key）。 */
  head: string;
}

/** 该 key 的用量汇总（P0-6 的按 key 分组先在这里落地）。 */
export interface VirtualKeyUsage {
  key_id: string;
  from_ts: number;
  to_ts: number;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cash_total: number;
  by_model: Array<{ model: string; request_count: number; cash_total: number }>;
  by_provider: Array<{ provider: string; request_count: number; cash_total: number }>;
}

export interface VirtualKeyCreateRequest {
  name: string;
  note?: string;
  /** 过期时间（ms epoch）。 */
  expires_at?: number;
  models?: string[];
  providers?: string[];
  allow_message_persistence?: boolean;
  allow_streaming?: boolean;
  allowed_plugins?: string[];
  disabled_plugins?: string[];
  allowed_modalities?: string[];
  rate_limit?: { rpm?: number; tpm?: number };
  budget_micros?: number;
  team_id?: string;
  user_id?: string;
}

export interface VirtualKeyUpdateRequest {
  name?: string;
  note?: string;
  expires_at?: number | null;
  models?: string[];
  providers?: string[];
  allow_message_persistence?: boolean;
  allow_streaming?: boolean;
  allowed_plugins?: string[];
  disabled_plugins?: string[];
  allowed_modalities?: string[];
  rate_limit?: { rpm?: number; tpm?: number } | null;
  budget_micros?: number | null;
  team_id?: string | null;
  user_id?: string | null;
}

/**
 * 创建响应。
 *
 * `plaintext` 是**整个管理面唯一返回完整密钥的地方**，而且只返回这一次：
 * 服务端不存它、列表不回显它、日志与 trace 里没有它。前端负责「展示一次即丢弃」
 * （见 webui/admin/src/pages/VirtualKeys.tsx）。
 */
export interface VirtualKeyCreateResponse {
  ok: boolean;
  key: VirtualKeyDto;
  plaintext: string;
}

export type VirtualKeyListResponse = Page<VirtualKeyDto>;

export interface VirtualKeyRevokeResponse {
  ok: boolean;
  key: VirtualKeyDto;
}

export interface VirtualKeyDeleteResponse {
  ok: boolean;
  deleted: boolean;
}

export interface VirtualKeyUsageResponse {
  ok: boolean;
  usage: VirtualKeyUsage;
}

/**
 * 当前数据面认证模式（互斥与 deny-first 语义见 auth/data-plane.ts）。
 *
 * `deny` = 虚拟 key 与 `AG_ACCESS_TOKEN` 都没配、也没显式放行：数据面整个关掉
 * （503）。界面必须把这一档说成「未配置访问控制」，不能与「放行中」混为一谈。
 */
export interface AuthModeResponse {
  mode: 'virtual_key' | 'access_token' | 'permissive' | 'deny';
  virtual_key_count: number;
  virtual_keys_enabled: boolean;
  /** 是否配了 `AG_ACCESS_TOKEN`。**不暴露值**。 */
  access_token_configured: boolean;
  /** 因互斥而被忽略的配置（人类可读）。 */
  ignored: string[];
}

// ---------------------------------------------------------------------------
// 运行时设置（P0-2）
// ---------------------------------------------------------------------------

export type SettingSource = 'encrypted_storage' | 'env' | 'config_file' | 'default';

/**
 * 一个运行时设置项。
 *
 * `id` 是设置项标识符（网关组 8 项 + Agent 组 13 项，白名单见 config/settings.ts
 * 的 `ALL_SETTING_SPECS`），也是 `PUT /settings/{id}` 与 `DELETE /settings/{id}`
 * （恢复默认）路径里的那段。
 *
 * **这里原字段名叫 `key`，已改名 `id`（breaking change）**：管理面另有一个
 * 「虚拟 key」域（`VirtualKeyDto.key_id` / `masked` / `plaintext`），两边的
 * `key` 撞名后，前端的脱敏守卫（webui/admin/src/api/client.ts 的 secretTripwire）
 * 只认字段名，见到 `items[].key` 就判定「疑似完整密钥」，把整个设置页拦成
 * 「读不到设置项」。守卫已改为按**值的形状**判断（见该文件的注释），字段名在这里
 * 也一并改名，让「设置项标识符」不再借用 key 域的词汇。
 *
 * 后端内部（`RuntimeSettingSpec.key` / `SettingRecord.key` / 存储记录 id
 * `set:<key>`）**不改名**：那是后端自己的域，且已落盘的加密存储记录按 `key` 读写，
 * 改名要连带数据迁移，换不来任何安全收益——守卫只看得到 HTTP 响应。
 */
export interface SettingDto {
  id: string;
  label: string;
  description: string;
  unit: string;
  type: 'int' | 'number' | 'enum' | 'string' | 'bool' | 'string[]' | 'json';
  /** 分组（界面据此分区：`gateway` 网关组 / `agent` Agent 组）。 */
  group: 'gateway' | 'agent';
  value: SettingValue;
  source: SettingSource;
  /** 能不能在界面里改（env 锁命中为 false）。 */
  editable: boolean;
  /** 不能改时的人类可读原因。 */
  reason?: string;
  env_var?: string;
  range?: { min: number; max: number };
  options?: string[];
  /** 内置默认值（「恢复默认」按钮直接用它）。 */
  default_value?: SettingValue;
  stored_value?: SettingValue;
  updated_at?: number;
  updated_by?: string;
}

/** 设置项的取值（`json` 项存任意 JSON 值）。 */
export type SettingValue =
  number | string | boolean | string[] | unknown[] | Record<string, unknown>;

export interface SettingsListResponse {
  items: SettingDto[];
  config_file_path?: string;
}

export interface SettingUpdateRequest {
  value: SettingValue;
}

export interface SettingUpdateResponse {
  ok: boolean;
  item: SettingDto;
}

export interface SettingResetResponse {
  ok: boolean;
  item: SettingDto;
}

// ---------------------------------------------------------------------------
// 内置对话（docs/design/95-agent-chat.md）
// ---------------------------------------------------------------------------

/** 对话里的一条消息（无状态：历史由客户端随请求带上）。 */
export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentChatRequest {
  messages: AgentChatMessage[];
  /** 是否流式；缺省读设置项 `agent_stream`。 */
  stream?: boolean;
  /** 覆盖设置里的模型（仍须落到设置的渠道上，否则 400）。 */
  model?: string;
  /** 覆盖设置里的渠道。 */
  access_path?: string;
}

/** 一次工具调用的可视化视图。 */
export interface AgentToolCallView {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 结果摘要（工具输出的原文，已过脱敏）。 */
  result?: AgentToolResultView;
  is_error: boolean;
}

/** 工具结果的摘要视图。 */
export interface AgentToolResultView {
  /** 结果文本（JSON 串或纯文本；已脱敏）。 */
  text: string;
  /** 从 JSON 结果里挑出的状态字段（`status` / `key_id` / `count` …）。 */
  status?: string;
}

/** 一次明文披露（只走这条路，不进对话上下文）。 */
export interface AgentSecretDisclosure {
  key_id: string;
  name: string;
  masked: string;
  plaintext: string;
}

/**
 * 一轮对话的 token 用量（96 §3.5：界面过程条与将来面板的数据源）。
 *
 * 口径 = 上游响应里的 `usage` 段原样取（计量管道是异步旁路，60 §6.1，
 * 不阻塞主链路，因此不能等它——直接从响应取最诚实）。
 */
export interface AgentChatUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** 推理模型才有；上游不给时整个字段省略。 */
  reasoning_tokens?: number;
}

export interface AgentChatResponse {
  ok: boolean;
  reply: string;
  model: string;
  tool_calls: AgentToolCallView[];
  secrets: AgentSecretDisclosure[];
  /**
   * 上游的思考正文（`reasoning_content`；96-chat-ui-port.md §3.5）。
   *
   * **可选**：上游不给（非推理模型 / provider 不返回该字段）时整个键省略，
   * 前端据此整行不渲染。永远不是空串——那会让界面多一个空的思考行。
   */
  reasoning?: string;
  error?: string;
  /** 回合计时（服务端用注入的 Clock 量，含上游与 agentic loop 全程）。 */
  duration_ms?: number;
  /** token 用量（上游不给时省略）。 */
  usage?: AgentChatUsage;
}

/** 脱敏规则的只读视图（内置 + 用户；给前端取，两边执行同一份）。 */
export interface RedactionRulesResponse {
  placeholder: string;
  builtin: Array<{
    id: string;
    pattern: string;
    flags: string;
    enabled: boolean;
    note?: string;
  }>;
  user: Array<{
    id: string;
    pattern: string;
    flags: string;
    replacement?: string;
    enabled: boolean;
    note?: string;
  }>;
}

// ---------------------------------------------------------------------------
// 敏感值引用登记（65 §3.1：只存 env:<VAR>，绝不存值）
// ---------------------------------------------------------------------------

export interface SecretRefDto {
  name: string;
  /** `env:<VAR>` 形态的引用。 */
  ref: string;
  note?: string;
  created_at: number;
  updated_at: number;
}

export interface SecretRefListResponse {
  items: SecretRefDto[];
  total: number;
}

export interface SecretRefCreateRequest {
  name: string;
  env_var: string;
  note?: string;
  /**
   * **不接受**。写这个字段会被 400 拒绝——敏感值只以引用形态登记，
   * 值必须留在进程环境里。字段留在契约里是为了让「传了会被拒」有据可查。
   */
  value?: never;
}

export interface SecretRefCreateResponse {
  ok: boolean;
  ref: SecretRefDto;
}

export interface SecretRefDeleteResponse {
  ok: boolean;
  deleted: boolean;
}

// ---------------------------------------------------------------------------
// 路由图引擎与遥测（图 + VM-JS + 服务商注入条件）
// ---------------------------------------------------------------------------

export type ProviderRoutingOptionSpecDto = import('../di/ports.js').ProviderRoutingOptionSpec;
export type ProviderTelemetrySnapshotDto =
  import('../gateway-core/routing-telemetry.js').ProviderTelemetrySnapshot;
export type RouteGraphNodeDto = import('../gateway-core/routing-engine.js').RouteGraphNode;
export type RouteGraphEdgeDto = import('../gateway-core/routing-engine.js').RouteGraphEdge;
export type RouteGraphDto = import('../gateway-core/routing-engine.js').RouteGraph & {
  created_at: number;
  updated_at: number;
};
export type RouteEvalStepDto = import('../gateway-core/routing-engine.js').RouteEvalStep;

export type RouteGraphAbilityModeDto =
  import('../gateway-core/routing-engine.js').RouteGraphAbilityMode;
export type RouteGraphAbilitiesDto =
  import('../gateway-core/routing-engine.js').RouteGraphAbilities;

export interface RouteGraphListResponse {
  items: RouteGraphDto[];
  total: number;
}

export interface RouteGraphUpsertRequest {
  id: string;
  label: string;
  enabled?: boolean;
  entry_node_id: string;
  nodes: RouteGraphNodeDto[];
  edges: RouteGraphEdgeDto[];
  ability_mode?: RouteGraphAbilityModeDto;
  abilities?: RouteGraphAbilitiesDto;
  note?: string;
}

export interface RouteGraphUpsertResponse {
  ok: boolean;
  graph?: RouteGraphDto;
  errors?: string[];
}

export interface RouteGraphDeleteResponse {
  ok: boolean;
  deleted: boolean;
  error?: string;
}

export interface RouteGraphSimulateRequest {
  graph_id?: string;
  graph?: RouteGraphUpsertRequest;
  request: {
    model?: string;
    client_format?: PresetDialect;
    stream?: boolean;
    prompt?: string;
    system?: string;
    has_images?: boolean;
    has_tools?: boolean;
    thinking_enabled?: boolean;
    estimated_tokens?: number;
  };
  telemetry_overrides?: Record<string, Partial<ProviderTelemetrySnapshotDto>>;
}

export interface RouteGraphSimulateResponse {
  ok: boolean;
  attempt_plan?: Array<{
    provider: string;
    access_path: string;
    provider_format: string;
    model: string;
    route_node_id?: string;
    overrides?: import('../ir/context.js').RouteParamOverrides;
  }>;
  trace: RouteEvalStepDto[];
  error?: string;
}

export type ProviderExtensionPointSpecDto =
  import('../di/ports.js').ProviderExtensionPointSpec;

export interface RoutingTelemetryResponse {
  snapshots: Record<string, ProviderTelemetrySnapshotDto>;
  provider_options: Record<string, ProviderRoutingOptionSpecDto[]>;
  provider_extensions?: Record<string, ProviderExtensionPointSpecDto[]>;
}

// ---------------------------------------------------------------------------
// 插件中心与 ServerTools Dogfooding API
// ---------------------------------------------------------------------------

export interface PluginToolDto {
  name: string;
  label: string;
  category: string;
  description: string;
  requires_confirmation?: boolean;
  enabled: boolean;
}

export interface PluginStatsDto {
  call_count: number;
  error_count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  last_called_at?: number;
  last_error?: string;
  hook_counts: Record<string, number>;
}

export interface PluginLogEntryDto {
  id: string;
  ts: number;
  plugin: string;
  hook: string;
  tool_name?: string;
  request_id?: string;
  status: 'ok' | 'error';
  duration_ms: number;
  summary: string;
}

export interface PluginInfoDto {
  name: string;
  title?: string;
  description?: string;
  version: string;
  hooks: string[];
  capabilities: string[];
  scope: 'envelope-only' | 'full-canonical';
  order: number;
  timeout_ms: number;
  fatal: boolean;
  enabled: boolean;
  mount_targets: Array<'agent' | 'data_plane'>;
  homepage?: string;
  license?: string;
  attribution?: string;
  tools?: PluginToolDto[];
  config_schema?: import('../ir/json-schema.js').JSONSchema;
  config: Record<string, unknown>;
  stats: PluginStatsDto;
  custom_status?: Record<string, string | number | boolean>;
}

export interface PluginsListResponse {
  items: PluginInfoDto[];
  logs: PluginLogEntryDto[];
}

export interface PluginUpdateRequest {
  enabled?: boolean;
  mount_targets?: Array<'agent' | 'data_plane'>;
  config?: Record<string, unknown>;
  enabled_tools?: string[];
}
