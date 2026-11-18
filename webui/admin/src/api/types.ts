export type PresetDialect =
  | 'openai.chat'
  | 'anthropic.messages'
  | 'openai.responses'
  | 'gemini.generateContent';

export interface ProviderAccessPathPreset {
  id: string;
  label: string;
  dialect: PresetDialect;
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

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

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

export interface LoginRequest {
  password?: string;
  access_token?: string;
}

export interface LoginResponse {
  ok: boolean;
  token?: string;
  expires_at?: number;
  user?: { id: string; name: string; role: 'owner' | 'viewer' };
  error?: string;
}

export interface ProviderBuiltinToolDefaults {
  web_search?: boolean;
  url_context?: boolean;
}

export interface ChannelModelRateOverride {
  input?: number;
  input_cache_hit?: number;
  output?: number;
  cache_write?: number;
  per_request?: number;
  per_image?: number;
  per_hour?: number;
  per_10000_characters?: number;
}

export interface ChannelPricingConfig {
  multiplier?: number;
  currency?: string;
  models?: Record<string, ChannelModelRateOverride>;
}

export interface ProviderConfig {
  id: string;
  label: string;
  dialect: PresetDialect;
  base_url: string;
  namespace?: string;
  model_source:
    | { kind: 'static'; models: string[] }
    | { kind: 'discovery'; path: string }
    | { kind: 'offline_catalog'; ref: string };
  model_metadata?: Record<string, UpstreamModelDto>;
  builtin_tools?: ProviderBuiltinToolDefaults;
  pricing?: ChannelPricingConfig;
  capability_overrides?: {
    unsupported_fields?: string[];
    constraints?: {
      system_prompt_update?: 'leading-only' | 'in-history';
      tool_update?: 'leading-only' | 'addition-only';
    };
    streaming_mode?: 'none' | 'sse' | 'chunked-binary' | 'ws-duplex';
  };
  enabled: boolean;
  auto_disabled?: {
    reason: string;
    at: number;
    consecutive_failures: number;
  };
  credential_health?: 'unknown' | 'ok' | 'error';
  credential_last_checked?: number;
  created_at: number;
  updated_at: number;
  note?: string;
}

export interface ProviderUpsertRequest {
  id?: string;
  label: string;
  dialect: PresetDialect;
  base_url: string;
  namespace?: string;
  model_source: ProviderConfig['model_source'];
  builtin_tools?: ProviderBuiltinToolDefaults;
  pricing?: ChannelPricingConfig;
  capability_overrides?: ProviderConfig['capability_overrides'];
  enabled?: boolean;
  note?: string;
}

export type ProviderModelsErrorCode =
  | 'key_invalid'
  | 'endpoint_unsupported'
  | 'rate_limited'
  | 'upstream_error'
  | 'network_error'
  | 'invalid_json'
  | 'invalid_shape'
  | 'credential_missing'
  | 'invalid_request';

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
  specs?: {
    billing_unit?: string;
    capability?: string;
  };
  metadata_source?: 'upstream' | 'models.dev' | 'inferred';
  effort?: { levels: string[]; default?: string };
  constraints?: string[];
}

export interface ProviderModelsRequest {
  base_url: string;
  dialect: PresetDialect;
  path?: string;
  api_key?: string;
  provider_id?: string;
}

export interface ProviderModelsResponse {
  ok: true;
  source: 'upstream';
  fetched_at: number;
  models: UpstreamModelDto[];
  metadata_incomplete: boolean;
}

export interface ProviderModelsFailure {
  ok: false;
  error: {
    code: ProviderModelsErrorCode;
    message: string;
    upstream_status?: number;
    detail?: string;
  };
}

export type ModelsDevSyncResponse =
  | {
      ok: true;
      source: 'models.dev';
      synced_at: number;
      matched_count: number;
      models: UpstreamModelDto[];
      metadata_incomplete: boolean;
    }
  | {
      ok: false;
      error: {
        code: 'network_error' | 'invalid_json';
        message: string;
      };
    };

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
  secret?: string; // privacy-scan: ignore —— 契约字段类型声明，无实际值
  note?: string;
  env_ref?: string;
}

export interface CredentialProbeResponse {
  ok: boolean;
  credential_id: string;
  status: 'ok' | 'error' | 'unknown';
  upstream_status?: number;
  message?: string;
  checked_at: number;
}

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
  internal?: boolean;
  availability?: 'unconfigured';
  exposed?: boolean;
}

export interface AccessPathDto {
  id: string;
  label: string;
  requires_credential: boolean;
}

export interface EnvCredentialPathDto {
  access_path: string;
  count: number;
}

export interface SyncTriggerResponse {
  ok: boolean;
  result?: {
    discovered: string[];
    updated: string[];
    added: string[];
  };
  error?: string;
  started_at: number;
  finished_at: number;
}

export interface UsageSummary {
  from_ts: number;
  to_ts: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cash_total: number;
  as_api_total: number;
  by_currency?: Record<string, { cash_total: number; as_api_total: number; requests: number }>;
  unpriced_count: number;
  by_model: Array<{ model: string; request_count: number; cash_total: number }>;
  by_provider: Array<{ provider: string; request_count: number; cash_total: number }>;
  by_credential: Array<{ credential: string; request_count: number; cash_total: number }>;
}

export interface UsageDashboardResponse {
  summary: UsageSummary;
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

export interface UsageTimeseriesBucket {
  from_ts: number;
  to_ts: number;
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  cash_total: number;
  as_api_total: number;
  by_currency?: Record<string, { cash_total: number; as_api_total: number; requests: number }>;
  unpriced_count: number;
}

export interface UsageTimeseriesResponse {
  from_ts: number;
  to_ts: number;
  bucket_ms: number;
  buckets: UsageTimeseriesBucket[];
  available: boolean;
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

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  outcome: 'ok' | 'error';
  detail?: string;
}

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
  masked: string;
  head: string;
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

export interface VirtualKeyCreateRequest {
  name: string;
  note?: string;
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
}

export interface AuthModeResponse {
  mode: 'virtual_key' | 'access_token' | 'permissive' | 'deny';
  virtual_key_count: number;
  virtual_keys_enabled: boolean;
  access_token_configured: boolean;
  ignored: string[];
}

export type SettingSource = 'encrypted_storage' | 'env' | 'config_file' | 'default';

export type SettingValue =
  | number
  | string
  | boolean
  | string[]
  | unknown[]
  | Record<string, unknown>;

export interface SettingDto {
  id: string;
  label: string;
  description: string;
  unit: string;
  type: 'int' | 'number' | 'enum' | 'string' | 'bool' | 'string[]' | 'json';
  group: 'gateway' | 'agent';
  value: SettingValue;
  source: SettingSource;
  editable: boolean;
  reason?: string;
  env_var?: string;
  range?: { min: number; max: number };
  options?: string[];
  default_value?: SettingValue;
  stored_value?: SettingValue;
  updated_at?: number;
  updated_by?: string;
}

export interface SettingsListResponse {
  items: SettingDto[];
  config_file_path?: string;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentToolResultView {
  text: string;
  status?: string;
}

export interface AgentToolCallView {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: AgentToolResultView;
  is_error: boolean;
}

export interface AgentSecretDisclosure {
  key_id: string;
  name: string;
  masked: string;
  plaintext: string;
}

export interface AgentChatUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export interface AgentChatResponse {
  ok: boolean;
  reply: string;
  model: string;
  tool_calls: AgentToolCallView[];
  secrets: AgentSecretDisclosure[];
  reasoning?: string;
  error?: string;
  duration_ms?: number;
  usage?: AgentChatUsage;
}

export interface RedactionRuleItem {
  id: string;
  pattern: string;
  flags: string;
  replacement?: string;
  enabled: boolean;
  note?: string;
}

export interface RedactionRulesResponse {
  placeholder: string;
  builtin: RedactionRuleItem[];
  user: RedactionRuleItem[];
}

export interface SecretRefDto {
  name: string;
  ref: string;
  note?: string;
  created_at: number;
  updated_at: number;
}

export interface RouteParamOverrides {
  thinking_enabled?: boolean;
  thinking_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinking_budget_tokens?: number;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  system_prompt_append?: string;
}

export type RoutingTelemetryField =
  | 'balance'
  | 'granted_balance'
  | 'remaining_credits'
  | 'credit_usage_pct'
  | 'window_5h_requests'
  | 'window_5h_tokens'
  | 'window_5h_cost_usd'
  | 'upstream_remaining_requests'
  | 'is_off_peak';

export interface ProviderRoutingOptionSpecDto {
  key: string;
  label: string;
  unit?: string;
  type: 'number' | 'boolean' | 'enum';
  default_value?: number | boolean | string;
  options?: Array<{ value: string; label: string }>;
  telemetry_field: RoutingTelemetryField;
  operator: 'gte' | 'lte' | 'eq';
}

export interface SubscriptionWindowQuotaDto {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
  used_usd?: number;
  limit_usd?: number;
  requests?: number;
  tokens?: number;
  cash_usd?: number;
}

export interface ProviderTelemetrySnapshotDto {
  provider: string;
  available: boolean;
  consecutive_failures: number;
  balance_supported?: boolean;
  quota_status?: 'ok' | 'unauthorized' | 'unsupported';
  quota_message?: string;
  plan_type?: string;
  period_start?: string;
  period_end?: string;
  balance?: number;
  granted_balance?: number;
  topped_up_balance?: number;
  currency?: string;
  remaining_credits?: number;
  used_credits?: number;
  total_credits?: number;
  credit_usage_pct?: number;
  is_off_peak?: boolean;
  window_5h: {
    requests: number;
    tokens: number;
    cash_usd: number;
    upstream_remaining_requests?: number;
    upstream_remaining_tokens?: number;
    updated_at?: number;
  };
  windows?: {
    h5?: SubscriptionWindowQuotaDto;
    weekly?: SubscriptionWindowQuotaDto;
    monthly?: SubscriptionWindowQuotaDto;
  };
  fetched_at?: number;
}

export interface RouteConditionConfig {
  has_images?: boolean;
  has_tools?: boolean;
  thinking_enabled?: boolean;
  min_estimated_tokens?: number;
  max_estimated_tokens?: number;
  client_formats?: PresetDialect[];
  message_contains?: string;
}

export interface RouteScriptConfig {
  code: string;
  timeout_ms?: number;
  ports?: string[];
}

export interface RouteTargetConfig {
  provider: string;
  access_path: string;
  model: string;
  max_context_tokens?: number;
  require_vision?: boolean;
  provider_options?: Record<string, number | boolean | string>;
  overrides?: RouteParamOverrides;
}

export type RouteGraphNodeDto =
  | {
      id: string;
      kind: 'entry';
      label: string;
      position: { x: number; y: number };
    }
  | {
      id: string;
      kind: 'condition';
      label: string;
      position: { x: number; y: number };
      condition: RouteConditionConfig;
      hook_script?: RouteScriptConfig;
    }
  | {
      id: string;
      kind: 'js_script';
      label: string;
      position: { x: number; y: number };
      script: RouteScriptConfig;
      hook_script?: RouteScriptConfig;
    }
  | {
      id: string;
      kind: 'provider_target';
      label: string;
      position: { x: number; y: number };
      target: RouteTargetConfig;
      hook_script?: RouteScriptConfig;
      extension_ports?: string[];
    };

export interface RouteGraphEdgeDto {
  id: string;
  from: string;
  from_port: string;
  to: string;
  priority: number;
  label?: string;
}

export type RouteGraphAbilityMode = 'min' | 'max' | 'custom';

export interface RouteGraphAbilities {
  tool_call?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  attachment?: boolean;
  input_modalities?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>;
  output_modalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  context_window?: number;
  max_output_tokens?: number;
}

export interface RouteGraphDto {
  id: string;
  label: string;
  enabled: boolean;
  entry_node_id: string;
  nodes: RouteGraphNodeDto[];
  edges: RouteGraphEdgeDto[];
  ability_mode?: RouteGraphAbilityMode;
  abilities?: RouteGraphAbilities;
  note?: string;
  created_at: number;
  updated_at: number;
}

export interface RouteGraphUpsertRequest {
  id: string;
  label: string;
  enabled?: boolean;
  entry_node_id: string;
  nodes: RouteGraphNodeDto[];
  edges: RouteGraphEdgeDto[];
  ability_mode?: RouteGraphAbilityMode;
  abilities?: RouteGraphAbilities;
  note?: string;
}

export interface RouteEvalStepDto {
  node_id: string;
  node_label: string;
  kind: RouteGraphNodeDto['kind'];
  outcome: 'entered' | 'matched' | 'unmatched' | 'branch' | 'selected' | 'skipped' | 'error';
  port?: string;
  detail: string;
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
    overrides?: RouteParamOverrides;
  }>;
  trace: RouteEvalStepDto[];
  error?: string;
}

export interface ProviderExtensionPointSpecDto {
  port: string;
  label: string;
  kind: 'branch' | 'fallback';
  telemetry_field?: string;
  operator?: 'gte' | 'lte' | 'eq';
  default_threshold?: number | boolean;
  tone?: 'teal' | 'amber' | 'violet' | 'rose';
}

export interface RoutingTelemetryResponse {
  snapshots: Record<string, ProviderTelemetrySnapshotDto>;
  provider_options: Record<string, ProviderRoutingOptionSpecDto[]>;
  provider_extensions?: Record<string, ProviderExtensionPointSpecDto[]>;
}

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
  config_schema?: Record<string, unknown>;
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
