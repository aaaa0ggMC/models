/**
 * ir/credential.ts —— 上游侧凭据模型。
 *
 * 唯一事实来源：docs/design/45-credentials.md §2（凭据类型统一抽象）、§3（access path）。
 *
 * ⚠️ 命名注意（45 §2 原文已标注）：`Credential` 与 Web 平台的全局 `Credential` 接口同名，
 * 在带 DOM lib 的 tsc --strict 下会报 TS2300 Duplicate identifier。本仓库统一改名
 * **`UpstreamCredential`**，与数据面的 virtual key（66-auth.md）彻底区分开。
 *
 * ⚠️ Phase 1 范围：只做 `api_key` / `local` / `cloud_iam` 三种类型 + env/keyring 两种存储位置；
 * `session_cookie` 是明确非目标（00 §2.2 第 2 条），只在 schema 留位。
 */

import type { ModalityKind } from './modality.js';

export type CredentialType =
  | 'api_key'
  | 'oauth_device_code'
  | 'oauth_browser'
  | 'session_cookie' // experimental，v1 不实现，仅 schema 留位
  | 'cloud_iam'
  | 'local'
  | 'upstream_proxy';

export interface RateLimitSpec {
  /** 请求/分钟。 */
  rpm?: number;
  /** token/分钟。 */
  tpm?: number;
  /** 订阅式窗口限额。 */
  window?: { duration: string; requests?: number; tokens?: number };
}

export interface RefreshPolicy {
  /** 静态 key：永不过期。 */
  kind: 'static' | 'auto' | 'manual';
  /** 过期前多久预警（秒）。 */
  warn_before_seconds?: number;
  /** 刷新失败后的行为。 */
  on_refresh_failure: 'deactivate' | 'degrade' | 'alert_only';
}

export interface CredentialStorage {
  /**
   * 明文 env 变量名 / 加密库记录 id / OS keyring 条目。
   * Phase 1 只允许 "env" 与 "keyring"（70-roadmap §2 末尾：禁止 "vault"）。
   */
  location: 'env' | 'vault' | 'keyring' | 'file';
  /** 例如 "AG_OPENAI_API_KEY" 或 "cred:abc123"。**绝不存明文值**。 */
  ref: string;
  /** 是否已加密入库（persistence 开关约束）。 */
  encrypted: boolean;
}

export type CredentialHealthStatus =
  'ok' | 'expiring' | 'expired' | 'forbidden' | 'quota_exhausted' | 'unknown';

export interface CredentialHealth {
  status: CredentialHealthStatus;
  last_checked: number;
  last_error?: string;
  /** 403/allowlist 拒绝的时间，用于熔断。 */
  forbidden_since?: number;
  /** 配额重置时间（已知时）。 */
  quota_reset_at?: number;
}

export interface UpstreamCredential {
  id: string;
  name: string;
  type: CredentialType;
  /** 它解锁的 access path（45 §3）。 */
  access_path: string;
  /** 该凭据能用的模型命名空间。 */
  model_namespace: string;
  rate_limit?: RateLimitSpec;
  refresh?: RefreshPolicy;
  storage: CredentialStorage;
  health: CredentialHealth;
  /** 优先级：越小越优先（Plan 感知路由的输入）。 */
  priority: number;
  enabled: boolean;
  /** 人类可读备注（**不得含 secret**）。 */
  note?: string;
  /** 该凭据覆盖的模态（缺省 = 全部）。 */
  modalities?: ModalityKind[];
}

export interface AccessPathTransportHints {
  /** 覆盖上游请求路径（如 `/codex/responses`）。 */
  endpoint_path?: string;
  /** 每次请求附加的固定头（如 `OpenAI-Beta`、`originator`）。 */
  extra_headers?: Record<string, string>;
  /** 需自动注入会话 ID 的请求头名（如 `x-opencode-session`）。 */
  session_header?: string;
}

/** access path 元数据（45 §3.2）。 */
export interface AccessPath {
  id: string;
  /** 人类可读名。 */
  label: string;
  /** 默认 wire 格式（S2 判 fast path 时用）。 */
  format: string;
  /** 该路径的计量口径：订阅路径多数无 usage API → estimated。 */
  usage_source: 'provider' | 'estimated';
  /** 该路径上的模型命名空间。 */
  model_namespaces: string[];
  /** 是否需要凭据（local 路径不需要）。 */
  requires_credential: boolean;
  /**
   * 上游 base URL（**运行时可选项**：管理面新建 provider 时由渠道配置填入）。
   *
   * 启动表（credentials/resolver.ts 的 DEFAULT_ACCESS_PATHS）不填这一项——那里的
   * 地址集中在 DEFAULT_BASE_URL_BY_ACCESS_PATH。两者不合并成一张表，是为了让
   * "部署时写死的" 与 "管理员在界面上配的" 保持可区分。
   */
  base_url?: string;
  /** key 的环境变量名（运行时可选项；缺省 `AG_<ID 大写>_API_KEY`）。 */
  key_env?: string;
  /** 声明式传输提示（替代针对单个厂商的硬编码补丁）。 */
  transport_hints?: AccessPathTransportHints;
}
