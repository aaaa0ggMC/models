/**
 * src/api/types.ts —— 管理面 HTTP 契约的**前端镜像**。
 *
 * 权威来源是 admin/api-types.ts（后端唯一契约）。前端是独立构建的 SPA，不跨构建
 * 边界 import 后端 .ts，因此在这里镜像要用到的形状。契约变了要**两边一起改**——
 * 这正是 api-types.ts 把契约单独成文件的初衷（前端/后端并行开发、编译期各自约束）。
 *
 * 只镜像本 UI 实际消费的字段；服务端多返回的字段前端不读（也绝不渲染完整密钥，
 * 见 client.ts 的 secretTripwire）。
 */

export type Dialect =
  'openai.chat' | 'anthropic.messages' | 'openai.responses' | 'gemini.generateContent';

export interface ApiError {
  error: { code: string; message: string };
}

// ---- 引导 / 登录 ----

export interface BootstrapResponse {
  authenticated: boolean;
  storage_unlocked: boolean;
  user?: { id: string; name: string; role: 'owner' | 'viewer' };
  keystore: {
    mode: 'passphrase' | 'key_file';
    tradeoff_note: string;
    argon2_rehash_recommended: boolean;
  };
  api_version: string;
}

export interface LoginResponse {
  ok: boolean;
  token?: string;
  expires_at?: number;
  user?: { id: string; name: string; role: 'owner' | 'viewer' };
  error?: string;
}

// ---- Provider ----

export type ModelSource =
  | { kind: 'static'; models: string[] }
  | { kind: 'discovery'; path: string }
  | { kind: 'offline_catalog'; ref: string };

export interface ProviderConfig {
  id: string;
  label: string;
  dialect: Dialect;
  base_url: string;
  model_source: ModelSource;
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

export interface ProviderUpsertRequest {
  id?: string;
  label: string;
  dialect: Dialect;
  base_url: string;
  model_source: ModelSource;
  capability_overrides?: ProviderConfig['capability_overrides'];
  enabled?: boolean;
  note?: string;
}

// ---- 凭据（只回掩码）----

export interface MaskedCredential {
  id: string;
  provider: string;
  access_path: string;
  masked: string;
  length: number;
  head: string;
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

export interface CredentialCreateRequest {
  provider: string;
  access_path: string;
  secret?: string;
  env_ref?: string;
  note?: string;
}

export interface CredentialProbeResponse {
  ok: boolean;
  credential_id: string;
  status: 'ok' | 'error' | 'unknown';
  upstream_status?: number;
  message?: string;
  checked_at: number;
}

// ---- 别名 ----

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

export interface AliasUpsertRequest {
  id?: string;
  kind: 'exact' | 'prefix';
  pattern: string;
  target: { provider: string; access_path: string; model: string; max_context_tokens?: number };
  priority?: number;
  enabled?: boolean;
  note?: string;
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

// ---- 能力矩阵 / 模型目录 ----

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

export interface AccessPathDto {
  id: string;
  label: string;
  requires_credential: boolean;
}

// ---- 用量看板 ----

export interface UsageDashboardResponse {
  summary: {
    from_ts: number;
    to_ts: number;
    request_count: number;
    input_tokens: number;
    output_tokens: number;
    cash_total: number;
    as_api_total: number;
    unpriced_count: number;
    by_model: Array<{ model: string; request_count: number; cash_total: number }>;
    by_provider: Array<{ provider: string; request_count: number; cash_total: number }>;
  };
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
  balance?: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
}

export interface BalanceProbeResponse {
  ok: boolean;
  balances: Array<{
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
  }>;
  is_available: boolean;
  checked_at: number;
  error?: string;
}

// ---- 密钥状态 ----

export interface KeystoreStatusResponse {
  mode: 'passphrase' | 'key_file';
  tradeoff_note: string;
  unlocked: boolean;
  active_dek_id: string;
  encryption_count: number;
  should_rotate_dek: boolean;
  argon2_rehash_recommended: boolean;
  kek_fingerprint: string;
}

// ---- 同步 ----

export interface SyncTriggerResponse {
  ok: boolean;
  result?: { discovered: string[]; updated: string[]; added: string[] };
  error?: string;
  started_at: number;
  finished_at: number;
}

// ---- Provider 预设（镜像 providers/presets.ts；经 /admin/api/provider-presets 获取）----

export interface ProviderAccessPathPreset {
  id: string;
  label: string;
  dialect: Dialect;
  base_url: string;
  default_models: string[];
}

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

export interface ProviderPresetListResponse {
  items: ProviderPreset[];
  total: number;
}

// ---- 数据面 virtual key（66 §2）----

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
  /** 明文前 8 位（非敏感）。 */
  head: string;
}

export interface VirtualKeyCreateRequest {
  name: string;
  note?: string;
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
 * 创建响应。`plaintext` 是**整个管理面唯一返回完整密钥的地方**，且只返回一次。
 * 前端只在新建设置的模态框里展示它，绝不进表格、不进 localStorage。
 */
export interface VirtualKeyCreateResponse {
  ok: boolean;
  key: VirtualKeyDto;
  plaintext: string;
}

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

export type SettingSource = 'encrypted_storage' | 'env' | 'config_file' | 'default';

/**
 * 一个运行时设置项（权威形状在 admin/api-types.ts 的 SettingDto）。
 *
 * `id` 是设置项标识符（`global_timeout_ms` … 共 8 项），也是 `PUT /settings/{id}`
 * 路径里的那段。**原字段名叫 `key`，已改名 `id`**：与虚拟 key 域的 `key` 撞名，
 * 前端脱敏守卫只认字段名时把整个设置页误拦了；守卫现已改为按值的形状判断，
 * 字段名也一并改名（breaking change，见 admin/api-types.ts 的注释）。
 */
export interface SettingDto {
  id: string;
  label: string;
  description: string;
  unit: string;
  type: 'int' | 'enum';
  value: number | string;
  source: SettingSource;
  editable: boolean;
  reason?: string;
  env_var?: string;
  range?: { min: number; max: number };
  options?: string[];
  stored_value?: number | string;
  updated_at?: number;
  updated_by?: string;
}

export interface SecretRefDto {
  name: string;
  ref: string;
  note?: string;
  created_at: number;
  updated_at: number;
}

/** 当前数据面认证模式（与 AG_ACCESS_TOKEN 的互斥语义，见后端 auth/data-plane.ts）。 */
export interface AuthModeResponse {
  mode: 'virtual_key' | 'access_token' | 'permissive';
  virtual_key_count: number;
  virtual_keys_enabled: boolean;
  access_token_configured: boolean;
  ignored: string[];
}
