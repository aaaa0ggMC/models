# 45 · 凭据模型（Credentials）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)（canonical 只管请求语义，凭据是正交的第二根支柱）、[65-storage-and-retention.md](./65-storage-and-retention.md)（加密存储）、[66-auth.md](./66-auth.md)（数据面 virtual key 是"客户端侧"凭据，本文是"上游侧"凭据，两者不要混）
> 下游被引用于：[40-provider-adaptors.md](./40-provider-adaptors.md)（能力矩阵的键）、[20-pipeline.md](./20-pipeline.md)（S2 路由）、[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)（双口径成本）

---

## 1. 为什么凭据是第二根设计支柱

**前提：使用方的主力是各种订阅/Plan（OpenAI、xAI SuperGrok 等），不是单纯的 API key。**

这个事实推翻了"一个 model 字符串就足够寻址上游"的假设：

- `gpt-5.4` 走 `openai/gpt-5.4`（API key，按 token 计费）和走 `openai-codex/gpt-5.4`（Codex OAuth，消耗订阅额度）是**两条完全不同的路径**——能力、限额、计费、可用性都不同。
- 订阅路径**没有 usage API**，计量必须自估算；成本核算需要"订阅摊销"口径而非"现金"口径。
- 订阅路径会因配额耗尽、allowlist 拒绝（403）而失效，需要自动降级到付费路径。

**决策 C1：凭据是一等公民、可插拔。** canonical 描述"请求什么"，凭据描述"用哪条路送达"，两者正交。

**决策 C2：能力矩阵的键从 `model` 改为 `(access_path, model)`。** 理由见 §6。

---

## 2. 凭据类型（统一抽象）

```typescript
type Credential =
  | ApiKeyCredential
  | OAuthDeviceCodeCredential
  | OAuthBrowserCredential
  | SessionCookieCredential        // experimental，见 §2.2
  | CloudIamCredential
  | LocalCredential
  | UpstreamProxyCredential;

interface CredentialBase {
  id: string;
  name: string;
  /** 凭据类型 */
  type: Credential["type"];
  /** 它解锁的 access path（见 §3） */
  access_path: string;
  /** 该凭据能用的模型命名空间（见 §3.1） */
  model_namespace: string;
  /** 速率限制（订阅通常有 5h/周窗口） */
  rate_limit?: RateLimitSpec;
  /** 过期/刷新策略 */
  refresh?: RefreshPolicy;
  /** 存储位置（受 persistence 开关约束，见 §5） */
  storage: CredentialStorage;
  /** 健康状态 */
  health: CredentialHealth;
  /** 优先级：越小越优先（Plan 感知路由的输入，见 §4） */
  priority: number;
  enabled: boolean;
  /** 人类可读备注（不得含 secret） */
  note?: string;
}

interface RateLimitSpec {
  /** 请求/分钟 */
  rpm?: number;
  /** token/分钟 */
  tpm?: number;
  /** 订阅式窗口限额 */
  window?: { duration: string; requests?: number; tokens?: number };
}

interface RefreshPolicy {
  /** 静态 key：永不过期 */
  kind: "static" | "auto" | "manual";
  /** 过期前多久预警（秒） */
  warn_before_seconds?: number;
  /** 刷新失败后的行为 */
  on_refresh_failure: "deactivate" | "degrade" | "alert_only";
}

interface CredentialStorage {
  /** 明文 env 变量名 / 加密库记录 id / OS keyring 条目 */
  location: "env" | "vault" | "keyring" | "file";
  ref: string;                    // 例如 "AG_OPENAI_API_KEY" 或 "cred:abc123"
  /** 是否已加密入库（persistence 开关约束） */
  encrypted: boolean;
}

interface CredentialHealth {
  status: "ok" | "expiring" | "expired" | "forbidden" | "quota_exhausted" | "unknown";
  last_checked: number;
  last_error?: string;
  /** 403/allowlist 拒绝的时间，用于熔断 */
  forbidden_since?: number;
  /** 配额重置时间（已知时） */
  quota_reset_at?: number;
}
```

### 2.1 各类型的差异点

| 类型 | 说明 | 刷新 | 计量来源 |
|---|---|---|---|
| `api_key` | 静态 key | 无（`static`） | 上游 usage API |
| `oauth_device_code` | 设备码登录 + 自动刷新（xAI SuperGrok / X Premium+、OpenAI Codex OAuth） | `auto`（refresh_token） | **多数无 usage API → 自估算** |
| `oauth_browser` | 浏览器重定向 + PKCE（为将来 OpenAI 若开放 consumer-delegated access 预留） | `auto` | 待定 |
| `session_cookie` | 复用 Web 端会话（逆向路线） | `manual`（易失效） | **无 → 自估算** |
| `cloud_iam` | AWS Bedrock SigV4 / GCP Vertex service account / Azure Entra token | `auto` | 上游 usage API |
| `local` / `none` | 自托管端点无需鉴权 | 无 | 上游 usage API |
| `upstream_proxy` | 转给另一个网关 | 取决于下游 | 下游网关的 usage |

### 2.2 `session_cookie` 的风险提示（必须显著标注）

**标记 `experimental: true`，且 UI 与文档都要有显著风险提示：**

- **ToS 风险**：逆向 Web 端会话通常违反服务条款，可能导致账号封禁。
- **时效性**：cookie / token 易失效，需要频繁重新登录。
- **不稳定性**：Web 端协议随时可变，无版本保证。
- **无计量**：完全没有 usage API，成本只能自估算。

**结论：v1 不实现 `session_cookie`，只在 schema 与能力矩阵里留位。** 若将来要做，必须是显式 opt-in + 独立的"我已知悉风险"确认步骤。

---

## 3. Access Path 与模型命名空间

### 3.1 为什么需要两级寻址

同一个模型名在不同路径下是不同东西：

```
access_path: "openai"                model_namespace: "openai"
  → openai/gpt-5.4                   API key，按 token 计费，有 usage API

access_path: "openai-codex"          model_namespace: "openai-codex"
  → openai-codex/gpt-5.4             Codex OAuth，消耗订阅额度，可能无 usage API

access_path: "xai-supergrok"         model_namespace: "xai-supergrok"
  → xai-supergrok/grok-4.7           SuperGrok 订阅，窗口限额

access_path: "bedrock"               model_namespace: "bedrock/anthropic"
  → bedrock/anthropic.claude-...     SigV4，按 token 计费
```

**规范：凭据解析出的完整模型 id = `<access_path>/<model_namespace>/<model>`，与 LiteLLM / llmshim 的 `provider/model` 约定兼容**（便于客户端迁移与相互对接）。

### 3.2 access path 的元数据

```typescript
interface AccessPath {
  id: string;                        // "openai-codex"
  provider: string;                  // "openai"
  /** 入站 wire 格式（见 10-canonical-schema.md §2.1） */
  format: FormatId;
  /** base URL */
  endpoint: string;                  // 凭据类地址走配置，不进仓库
  /** 该路径支持的凭据类型 */
  credential_types: Credential["type"][];
  /** 是否有 usage API（决定计量走真实值还是估算） */
  has_usage_api: boolean;
  /** 默认是订阅路径（Plan 感知路由用） */
  subscription: boolean;
  /** 已知的 quirks */
  quirks?: string[];
}
```

---

## 4. 路由：(model, access path) 二级键 + Plan 感知

### 4.1 策略配置结构草案

```typescript
interface RoutingPolicy {
  /** 默认策略 */
  default: AccessPreference;
  /** 按模型覆盖 */
  overrides?: Array<{
    match: string;                   // 模型名或 glob，如 "gpt-5.*"
    policy: AccessPreference;
  }>;
}

interface AccessPreference {
  /** 排序模式 */
  mode: "subscription_first" | "api_key_first" | "cost_first" | "explicit_order";
  /** mode === "explicit_order" 时的 access path 顺序 */
  order?: string[];
  /** 是否允许在订阅路径失败时降级到付费路径 */
  allow_degrade: boolean;
  /** 降级前要求在订阅路径上连续失败多少次 */
  degrade_after_failures: number;    // 默认 1
  /** 降级冷却期（秒），避免抖动 */
  degrade_cooldown_seconds: number;  // 默认 300
  /** 成本上限（微美元/请求）；超出则不路由到付费路径 */
  max_cost_micros_per_request?: number;
  /** 订阅路径的软配额（自估算达到该比例时提前降级） */
  subscription_soft_quota_ratio?: number;  // 默认 0.9
}
```

### 4.2 决策时序（S2 内）

```
1. 解析 model 字符串 → (access_path 候选列表, model)
   （客户端可显式指定 access path：`openai-codex/gpt-5.4`；
     未指定则按 RoutingPolicy 展开候选）
2. 按 policy.mode 排序候选：
   - subscription_first：subscription=true 的路径优先，同级按 priority
   - cost_first：按估算单价升序
   - explicit_order：按 order[]
3. 逐个候选过滤：
   a. 凭据 health.status != "ok" → 跳过（记录原因）
   b. 凭据在降级冷却期内 → 跳过
   c. 能力矩阵不支持该 (path, model) 组合 → 跳过
   d. 预算/成本上限检查 → 跳过
4. 取第一个通过过滤的候选作为 attempt_plan[0]，其余作为 fallback 链
5. 执行中若订阅路径返回：
   - 配额耗尽 / 429(window) → 标记该凭据 quota_exhausted + quota_reset_at
     → 立即切 fallback（付费路径），记 warnings += "degraded_to_paid"
   - 403 / allowlist 拒绝 → 标记 forbidden + forbidden_since
     → 立即切 fallback，记 warnings += "credential_forbidden"
   - 可重试错误（5xx/超时）→ 走 20-pipeline.md §6.3 的重试矩阵
6. 降级事件写入 UsageRecord.degradation[]，供 dog-fooding 查询
   （"这个月有多少请求从订阅降级到了付费"是有用的运营信号）
```

### 4.3 为什么这比"按 model 记"更正确

见 §6。

---

## 5. 凭据生命周期

### 5.1 设备码登录流程（`oauth_device_code`）

```
[IDLE] ──发起──▶ [PENDING_USER] ──用户完成登录──▶ [AUTHORIZED]
   │                    │                              │
   │               轮询超时/拒绝                        ▼
   │                    │                        [ACTIVE] ◀─┐
   │                    ▼                              │      │ 刷新成功
   │              [FAILED]                             ▼      │
   │                                    [EXPIRING] ──预警──▶ [REFRESHING]
   │                                                   │      │
   │                                        刷新失败 ──┴──────┘
   │                                            │
   └──撤销──▶ [REVOKED] ◀───────────────────────┘
```

要点：
- 发起：网关向上游请求 device code，返回 `verification_uri` + `user_code`，通过 WebUI / CLI / 通知展示给用户。
- 轮询：按上游要求的间隔轮询授权端点（**不得快于上游规定**，否则可能被限流）。
- 落盘：拿到 access_token + refresh_token 后**立即加密入库**（或写 OS keyring），永不明文落盘。
- 刷新：access_token 过期前 `warn_before_seconds` 秒自动刷新；刷新用的 refresh_token 轮换时同步更新。
- 撤销：用户主动撤销或上游返回 `invalid_grant` → 标记 `REVOKED`，路由立即摘除。

### 5.2 过期预警与自动降级

- `health.status` 由后台健康检查任务维护（默认每 5 分钟一次，可配）。
- `expiring` / `expired` / `forbidden` / `quota_exhausted` 都会触发：
  1. 路由摘除该凭据；
  2. WebUI 看板标红；
  3. 通知（可选，走 [66-auth.md](./66-auth.md) 的通知通道，**内容不含 secret**）。
- `on_refresh_failure`：`deactivate`（默认，摘除）/ `degrade`（切 fallback 并继续尝试刷新）/ `alert_only`。

### 5.3 密钥处理硬规则

- 所有 secret 走**环境变量 / OS keyring / 加密库**三选一；**仓库只留 `.env.example`**。
- 加密入库受 `persistence.credentials` 开关约束（默认 `on`——没有凭据网关无法工作；但**绝不**把凭据和消息内容放同一层，见 [65-storage-and-retention.md](./65-storage-and-retention.md) §4）。
- 脱敏规则：`Authorization` / `x-api-key` / `x-goog-api-key` 等 header 永不进 trace 与日志（[65-storage-and-retention.md](./65-storage-and-retention.md) §6.1）。
- **`privacy-scan --staged --fail-on any` 会把泄密的 secret 拦下**，不要绕过。

---

## 6. 能力矩阵的键改为 (access_path, model)

### 6.1 现状与问题

[40-provider-adaptors.md](./40-provider-adaptors.md) §5 的矩阵键是 `(provider, modality)`，隐含假设"一个 provider 一种访问方式"。订阅路径打破了这个假设：

| 维度 | `openai/gpt-5.4`（API key） | `openai-codex/gpt-5.4`（Codex OAuth） |
|---|---|---|
| 计费 | 按 token 现金 | 消耗订阅额度 |
| usage API | ✅ 有 | ❌ 多数无 |
| 限额 | RPM/TPM | 5h/周窗口 |
| 工具调用 | 全支持 | 可能受限（如仅 `reasoning_effort:"none"` 支持工具调用的模型代次差异） |
| 流式 | ✅ | ✅ |
| 失效模式 | 401/403/429 | 配额耗尽 / allowlist 403 / token 过期 |

**同一个 `gpt-5.4`，能力和限额完全不同。按 model 记矩阵会得出错误结论。**

### 6.2 新矩阵

```typescript
interface CapabilityEntry {
  /** 主键从 model 改为 (access_path, model) */
  access_path: string;
  model: string;
  modality: ModalityKind;
  /** 流式形态，见 25-streaming.md §9 */
  streaming?: { mode: "none" | "sse" | "chunked-binary" | "ws-duplex"; partial_results?: boolean; usage_in_stream?: boolean; cancellable?: boolean };
  /** 计量来源 */
  usage_source: "provider" | "estimated";
  /** 该路径不支持的 canonical 字段 */
  unsupported_fields?: string[];
  quirks?: string[];
  contract_tested: boolean;
  /** 状态：已实现 / 计划 / 按需 */
  status: "implemented" | "planned" | "on-demand";
}
```

**迁移规则**：现有 `(provider, modality)` 条目自动展开为 `(provider 的默认 access path, model, modality)`；新增订阅路径时**新增条目**，不改旧条目。

---

## 7. 计量与成本：双口径

### 7.1 无 usage API 的路径必须自估算

订阅路径（`oauth_device_code`）与逆向路径（`session_cookie`）多数没有 usage API。回退估算：

| 模态 | 估算方式 | 精度 |
|---|---|---|
| chat | tokenizer 精确计数（tiktoken 兼容实现） | `approx`（与上游 tokenizer 可能有 1–5% 差异） |
| tts | 输入字符数 | `approx` |
| asr | 上行音频字节 / 码率 → 时长 | `approx` |
| image | `n` | `exact` |

置 `usage.source = "estimated"`、`precision = "approx"`，与上游值并存（[25-streaming.md](./25-streaming.md) §8.3 的双路对齐）。

### 7.2 双口径成本

```typescript
interface CostBreakdown {
  /** 口径一：实际现金成本（微美元）。订阅路径记 0 */
  cash_micros: number;
  /** 口径二：订阅摊销（微美元）。按订阅月费 / 预估可用额度折算 */
  subscription_amortized_micros?: number;
  /** 摊销依据（可解释） */
  amortization_basis?: { plan_cost_micros: number; period_days: number; estimated_quota_tokens?: number };
  /** 本次是否走了降级路径 */
  degraded: boolean;
  degraded_from?: string;           // 原 access path
}
```

**理由**：只看现金成本会把"用订阅额度跑掉 10 亿 token"显示成 $0，掩盖真实资源消耗；只看摊销会让"本来可以免费用订阅却付了 API 费"看不出来。两个口径都记，看板可切换。

---

## 8. Open Questions

1. **Q-C1**：OpenAI Codex OAuth 的设备码流程的确切端点与 scope（以及是否允许第三方网关代登录）——**待验证**，且可能随时变。
2. **Q-C2**：xAI SuperGrok 的订阅额度是否有可查询的剩余量 API；若无，软配额只能靠自估算累计。
3. **Q-C3**：订阅路径的 5h/周窗口限额是账号级还是 key 级（影响多凭据并行时的配额分配）。
4. **Q-C4**：`oauth_browser`（PKCE 重定向）在无人值守网关上如何完成首次授权——需要一次性人工交互，之后靠 refresh_token。流程设计待定。
5. **Q-C5**：Bedrock / Vertex 的 IAM 凭据在本机的可用性（无 AWS/GCP 凭据时无法验证）。
6. **Q-C6**：降级事件的累计统计口径（"本月降级率"）是否要进 dog-fooding 默认工具集。
7. **Q-C7**：`upstream_proxy`（转给另一个网关）场景下，下游网关返回的 usage 是否可信（可能被二次估算污染）——建议标记 `usage.source = "provider"` 但 `precision = "low"`。
