# 66 · 认证设计（Auth）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[00-overview.md](./00-overview.md)（UI 选型结论：fork LibreChat）、[65-storage-and-retention.md](./65-storage-and-retention.md)（密钥处理）

---

## 1. 两个认证平面，不要混

| 平面 | 使用者 | 凭证形态 | 默认方案 |
|---|---|---|---|
| **数据面（Gateway API）** | curl / SDK / agent CLI / 其他服务 | virtual key（`sk-ag-…`）或单 access token | **v1 就做，这是网关的本职** |
| **控制面（WebUI）** | 人（你自己） | 本地账号（密码）+ passkey/WebAuthn | **v1 默认**；社交 OAuth 可选，后续 |

数据面认证是**计费的主键**（`UsageRecord.auth.key_id`），不是可选项。控制面认证管"谁能看用量看板、谁能改插件配置"。

---

## 2. 数据面认证（v1 必做）

### 2.1 virtual key

```typescript
interface VirtualKey {
  key_id: string;              // 入库的稳定 id，不含明文
  key_hash: string;            // Argon2id(明文 key)；明文只在创建时返回一次
  name: string;
  created_at: number;
  expires_at?: number;
  /** 允许的模型/别名（空 = 全部） */
  models?: string[];
  /** 允许的 provider（空 = 全部） */
  providers?: string[];
  /** 是否允许写 Tier-2（默认 false，即不能开消息持久化） */
  allow_message_persistence?: boolean;
  /** 速率限制 */
  rate_limit?: { rpm?: number; tpm?: number };
  /** 预算上限（微美元）；超出即拒绝 */
  budget_micros?: number;
  /** 归属（用于统计分组） */
  team_id?: string;
  user_id?: string;
  status: "active" | "revoked";
}
```

### 2.2 规则

- 明文 key **只在创建响应里返回一次**，之后只能看 `key_id` 与前 8 位。
- 永不明文入库（只存 Argon2id hash）；**不进日志、不进 trace、不进错误信息**。
- 客户端带 key 的方式：`Authorization: Bearer sk-ag-…`（OpenAI 风格）、`x-api-key`（Anthropic 风格）、`?key=`（Gemini 风格）——三种都接受，归一成同一个 `key_id`。
- **单用户极简模式**：环境变量 `AG_ACCESS_TOKEN` 设一个值即可跑起来，不建 key 表。适合"只有我自己用"的部署。
- 限流与预算在 S0 检查（见 [20-pipeline.md](./20-pipeline.md) §S0）。

---

## 3. 控制面认证（WebUI）

### 3.1 推荐结论

**v1 默认：本地账号（密码 + Argon2id）+ passkey/WebAuthn，二选一或并用。不带任何 OAuth。**

**理由**：

1. 私人自用、单用户/少用户——本地账号零外部依赖、零注册手续、断网可用；
2. passkey 抗钓鱼且无需记密码，是这个场景下体验最好的方案；
3. **OAuth 的固定成本被严重低估**（见 §3.2），为一个"只有我登录"的面板引入三家 OAuth App 注册与维护不划算；
4. WebUI 基座（LibreChat）本身已内置 OAuth/OIDC/SAML/LDAP/2FA/passkey + RBAC（[docs/sources.md](../sources.md) §UI）——**v1 用它的本地账号 + passkey 就行，不需要我们自己实现**。

**社交 OAuth 作为后续可选能力**，且必须是**插件式**的：加一个 provider = 加一个配置块，不改核心。

### 3.2 OAuth 的现实约束（实现前必须知道）

**每个提供商都需要用户自行注册 OAuth App**（拿到自己的 `client_id` / `client_secret`），因为**回调地址必须指向你自己的实例**，无法复用别人的 App。这不是"填个 key"的事：

| 提供商 | 注册成本 | 关键坑 |
|---|---|---|
| **GitHub** | **最低**：OAuth App 注册，无审核，secret 不过期 | 回调 URL 需**精确匹配**（路径、端口、协议全算） |
| **Google** | 中：Cloud Console 建项目 + 配 OAuth 同意屏幕 | **测试模式免审核**但有测试用户上限（默认 100）；**测试模式下的 refresh token 有效期短**（约 7 天）需频繁重登；生产模式要走审核 |
| **Microsoft** | 较高：Azure AD 注册 + 配重定向 URI + 按需申请 scope 审批 | 多租户/单租户选择影响谁能登录 |
| **Apple** | 最重：需付费开发者账号 + 配 Service ID + 处理 form_post 回调 | 回调与 token 交换流程与别家不同 |

**结论**：如果将来真要加，**只加 GitHub 一个**（注册最简、无审核、secret 不过期）。Google 的 refresh token 短寿命问题会让"无人值守登录态"不成立，除非接受定期重登。

### 3.3 自建 IdP 中间路线（多用户时再考虑）

**Keycloak / Authentik / Zitadel** 一类自托管 IdP：

- **好处**：上游各提供商的 OAuth App 仍要自己注册一次，但**应用侧只对接 IdP 一个 OIDC client**；后续增删登录方式（加 Google、去掉 Apple、加 LDAP）不用改应用。
- **代价**：多一个要运维的服务（含数据库、升级、备份）；对"单用户自用"是纯负担。
- **结论**：标注为**多用户时再考虑**，v1 不做。届时由 LibreChat 侧对接（它已支持 OIDC），网关数据面仍用自己的 virtual key，两边不耦合。

### 3.4 密钥处理

- 所有 `client_secret` / OIDC client secret **走环境变量或本地配置文件**，仓库只留 `.env.example` 占位（符合 AGENTS.md 隐私约束）。
- secret 不明文落库：入库时加密（同 [65-storage-and-retention.md](./65-storage-and-retention.md) 的应用层信封加密），WebUI 只回显掩码预览。
- **绝不进 git**；`privacy-scan --staged --fail-on any` 会把它们拦下。

---

## 4. 权限模型（控制面）

LibreChat 已有 RBAC + capabilities（`read:configs` / `manage:configs:<section>` / `read:audit_log`）。我们只需映射三个角色：

| 角色 | 能做什么 |
|---|---|
| `owner` | 全部：provider/key 管理、插件配置、用量看板、消息持久化开关 |
| `viewer` | 只看用量看板与 trace（受 `persistence.messages` 约束，见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §6.1） |
| `agent` | 只有 dog-fooding agent 的服务账号（数据面 virtual key，不是人） |

**隐私开关优先于角色**：`persistence.messages = off` 时，`owner` 也看不到消息正文——开关是硬边界，角色只在开关之内分配可见性。

---

## 5. 决策摘要

| 决策 | 结论 |
|---|---|
| 数据面 v1 | virtual key（Argon2id hash 存储）+ `AG_ACCESS_TOKEN` 极简单用户模式 |
| 控制面 v1 | 本地账号 + passkey/WebAuthn（复用 LibreChat 内置能力） |
| OAuth | **v1 不做**；后续作为可选插件式能力，若要加只加 GitHub |
| 自建 IdP | 多用户时再考虑（Keycloak/Authentik/Zitadel） |
| secret 处理 | 环境变量/本地配置；仓库只留 `.example`；入库则信封加密 |

---

## 6. Open Questions

1. passkey 在 LibreChat 侧的启用方式与是否需 HTTPS（WebAuthn 要求 secure context，本机 http 下不可用——需确认反代与证书方案）。
2. `AG_ACCESS_TOKEN` 极简模式与 virtual key 表模式能否共存（建议：设了 env 就用极简模式，两者互斥以避免歧义）。
3. 数据面是否需要"按 IP 限制"（`ip_limits`）——私人自用默认不需要，留给按需。
