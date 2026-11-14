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

// Provider 预设的权威形状在 providers/presets.ts（与定价表等同属 provider 参考数据），
// 这里只做契约引用，避免在两处各写一份结构体后漂移。presets.ts 不依赖 node，纯数据。
import type { ProviderPreset } from '../providers/presets.js';

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
  /** 模型清单来源。 */
  model_source:
    | { kind: 'static'; models: string[] }
    | { kind: 'discovery'; path: string }
    | { kind: 'offline_catalog'; ref: string };
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
  created_at: number;
  updated_at: number;
  note?: string;
}

export type ProviderListResponse = Page<ProviderConfig>;

export interface ProviderUpsertRequest {
  id?: string;
  label: string;
  dialect: ProviderConfig['dialect'];
  base_url: string;
  model_source: ProviderConfig['model_source'];
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
  secret: string;
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

/** 能力矩阵条目（ir/capability.ts 的 CapabilityEntry 原样透出，不另写一份）。 */
export interface CapabilityMatrixEntry {
  access_path: string;
  model: string;
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
  effort?: { supported_levels: string[]; default_level?: string };
  contract_tested: boolean;
  status: 'implemented' | 'planned' | 'on-demand';
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
  /** 未定价的请求数（拿不到价格，不是"免费"）。 */
  unpriced_count: number;
  by_model: Array<{ model: string; request_count: number; cash_total: number }>;
  by_provider: Array<{ provider: string; request_count: number; cash_total: number }>;
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
  rate_limit?: { rpm?: number; tpm?: number };
  budget_micros?: number;
  team_id?: string;
  user_id?: string;
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

/** 当前数据面认证模式（互斥语义见 auth/data-plane.ts）。 */
export interface AuthModeResponse {
  mode: 'virtual_key' | 'access_token' | 'permissive';
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

export interface SettingDto {
  key: string;
  label: string;
  description: string;
  unit: string;
  type: 'int' | 'enum';
  value: number | string;
  source: SettingSource;
  /** 能不能在界面里改（env 锁命中为 false）。 */
  editable: boolean;
  /** 不能改时的人类可读原因。 */
  reason?: string;
  env_var?: string;
  range?: { min: number; max: number };
  options?: string[];
  stored_value?: number | string;
  updated_at?: number;
  updated_by?: string;
}

export interface SettingsListResponse {
  items: SettingDto[];
  config_file_path?: string;
}

export interface SettingUpdateRequest {
  value: number | string;
}

export interface SettingUpdateResponse {
  ok: boolean;
  item: SettingDto;
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
