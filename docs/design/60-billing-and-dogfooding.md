# 60 · 统计计费管道与 Dog-fooding

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[20-pipeline.md](./20-pipeline.md)、[40-provider-adaptors.md](./40-provider-adaptors.md)、[65-storage-and-retention.md](./65-storage-and-retention.md)

## 1. 设计原则

1. **统计管道与主链路物理分离**。主链路只负责往队列里扔一条 `UsageRecord`；聚合、定价、存储、查询全部在独立进程/线程里完成。管道挂了不影响任何用户请求。
2. **分层存储是隐私默认值**：usage/计费元数据（小、非敏感）**默认开启**；消息内容（大、敏感）**默认关闭**，由用户显式打开后才落盘。agent 接口同样受这个开关约束。
3. **落盘前脱敏是强制步骤**，不是可选项：provider API key、Authorization 头、cookie 永不入库。
4. **规范化与原始值都留**：所有 token 口径既存规范化值（用于横向对比/计费），也存 provider 原始 usage（用于对账/审计）。

## 2. 管道结构

```
S10 UsageEmitter
   │  内存环形队列（有界，默认 10k 条）
   ▼
┌──────────────────┐
│  Aggregator      │  微批聚合（默认 2s / 500 条）
│  - usage 规整    │
│  - 定价计算      │
│  - 去重/合并     │
└────────┬─────────┘
         │
         ├──▶ Tier-1 存储：usage_events / usage_rollup（小、非敏感，默认常开）
         │
         └──▶ [仅当 persist_messages = on]
              Tier-2 存储：request_bodies（大、敏感、加密）
                     │
                     ├─▶ 前缀压缩 / delta 链（§5）
                     ├─▶ zstd + 共享字典
                     └─▶ 应用层信封加密（§6，详见 65 号文档）
```

聚合器与主链路之间只有一条单向通道，**没有回压路径**：队列满时按 `drop_policy`（默认丢最旧 + 计数 + 告警）处理，绝不阻塞请求。

## 3. `UsageRecord` 数据模型

```typescript
interface UsageRecord {
  // ---- 标识 ----
  request_id: string;
  trace_id?: string;
  ts: number;                        // epoch ms（UTC）
  // ---- 主体 ----
  auth: { key_id: string; team_id?: string; user_id?: string };  // 不含明文 key
  client_format: FormatId;
  provider: string;
  provider_format: FormatId;
  model: string;                     // provider 侧真实 model id
  model_alias?: string;
  fast_path: boolean;
  attempts: number;
  // ---- 规范 usage ----
  usage: CanonicalUsage;             // 见 40-provider-adaptors.md §口径表
  usage_raw?: Record<string, unknown>;   // provider 原始 usage，逐字段保留
  // ---- 衍生 ----
  finish_reason: NormalizedFinishReason;
  stream: boolean;
  ttfb_ms: number;
  total_ms: number;
  tool_calls: Array<{ name: string; ok: boolean; duration_ms: number }>;
  agentic_turns: number;             // 网关工具循环轮数
  builtin_tool_usage: Array<{ name: string; count: number; backend?: string }>;
  compaction?: { removed_tokens: number; kept_tokens: number; cost_tokens?: number };
  /** 控制面判断成本（decision 子请求：路由/策略/工具选择/循环控制）。
   *  与 compaction 同级，**不计入用户 input_tokens**，但要可查询——否则看不到
   *  「网关自己想花了多少钱」。见 20-pipeline.md §6.3。 */
  control_plane_cost?: {
    requests: number;                  // decision 子请求次数
    questions: number;                 // 问的题目总数
    input_tokens: number;
    output_tokens: number;
    /** 输出是否免费（decision 的典型定价形态） */
    output_free: boolean;
    cash_micros: number;
    calibration: "native" | "degraded" | "skipped";
  };
  external_cost: Array<{ kind: string; units: number; unit_cost: number }>; // 搜索 API 等
  cost: {                            // 网关侧计算的费用（USD）
    input: number; output: number; cache_read: number; cache_write: number;
    reasoning: number; builtin_tools: number; external: number; total: number;
  };
  /** 双口径成本，见 45-credentials.md §7.2 */
  cost_caliber?: {
    cash_micros: number;                     // 实际现金成本（订阅路径记 0）
    subscription_amortized_micros?: number;  // 订阅摊销
    degraded: boolean;                       // 是否走了降级路径
    degraded_from?: string;                  // 原 access path
  };
  /** 降级事件（Plan 感知路由，见 45-credentials.md §4） */
  degradation?: Array<{ from: string; to: string; reason: string; ts: number }>;
  // ---- 质量/异常 ----
  status: "success" | "error" | "short_circuit";
  error_code?: CanonicalErrorCode;
  warnings: string[];
  dropped_capabilities: string[];
  // ---- 外链 ----
  body_ref?: string;                 // 指向 Tier-2 加密内容的 id（仅 persist_messages=on）
  // ---- 脱敏标记 ----
  redaction_profile: string;         // 使用的脱敏规则集 id
}
```

**绝不进入 `UsageRecord` 的字段**：`Authorization` / `x-api-key` / `x-goog-api-key` 等任何 header 原值、provider base_url 中的凭据、客户端 IP（默认不记，可配 `log_client_ip`）。

## 4. Usage 规范化规则

规范化在 S6/S10 由客户端格式 codec 无关的 `normalizeUsage(providerFormat, raw)` 完成，规则单一来源在 [40-provider-adaptors.md](./40-provider-adaptors.md) 的口径表中。补充几条**计算规则**：

1. `total_tokens = input + output`（若 provider 已给且不一致，以 provider 为准并把差异记入 `warnings`——Gemini 的 `totalTokenCount` 常包含 thoughts，需注意）。
2. `cache_read_tokens` 与 `input_tokens` **不重复计算**：各 provider 的 `input_tokens` 是否已包含 cache read 部分口径不一，**待验证**逐家确认后固定规则，并写入 `usage_raw` 以便回溯。
3. `cache_write_tokens` 只 Anthropic 有（`cache_creation_input_tokens`）；OpenAI/Gemini 记 0 并 `warnings += "no_cache_write_metric"`。
4. `reasoning_tokens`：Anthropic 无独立字段（思考 token 计入 `output_tokens`），记 0 且 `warnings += "reasoning_in_output"`；Gemini 用 `thoughtsTokenCount`。
5. 流式缺失 usage（客户端没开 `include_usage`、或 Gemini 末 chunk 未带）→ `usage` 全 0 + `status` 仍为 success + `warnings += "usage_missing"`，计费侧单独走"按字符估算"兜底并可配置告警。

### 4.1 定价

- 单价表独立存储（`pricing.json`，可按 provider/model/日期版本化），支持三档：`input` / `cache_read` / `cache_write` / `output` / `reasoning` / `builtin_tool_per_call`。
- **cache write 按 TTL 分别计价**：Anthropic 5m / 1h、OpenAI 30m / 12h 的写价不同（agentgateway 的 release notes 明确做过 "price 1h cache writes separately from 5m"、"Support openai 12h cache prompt"、"add prices for anthropic 1h cache"，见 [v1.7.0 release](https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0)）。单价表必须有 `cache_write_ttl_5m` / `cache_write_ttl_1h` / `cache_write_ttl_30m` / `cache_write_ttl_12h` 四档。
- **catalog 的 base + overlay 语义**（借鉴 agentgateway）：带 `metadata.generatedAt` 的是 base（只取最新），不带的是 overlay（按序叠加，后者覆盖）；比内置目录旧的导入目录会被静默忽略。导入源可用 `models.dev` / OpenRouter `/api/v1/models` 等公开数据（见 [00-overview.md](./00-overview.md) §7.0.4）。
- 定价变更**不追溯改写**历史记录：`UsageRecord` 只记 token，费用在查询时按"事件时间对应的单价版本"计算。这样改价不会污染历史，也能重算。
- 金额一律用整数微美元（`cost_micros`）存储，避免浮点误差。
- **预估算准入 vs 事后计费的分工**（重要，agentgateway 的教训）：budget 是**事后刹车不是硬顶**——跨限的那次请求仍然完成并计费，只有下一次被拒。若要"硬限额"，必须在准入层（S0/S2）做预估算（tokenizer 估 prompt token + 已知的 max_output_tokens 上限）。我们两者都做：准入层预估算拦大部分，事后精确记账修正。
- **未定价模型**：usd budget 对它永不扣也永不拦。必须 `is_priceable()` 预检，未定价的模型要么拒绝路由，要么显式标记 `unpriced` 并只记 token 不拦额度。

## 5. 分层存储与消息内容持久化（默认关闭）

### 5.1 两层

| 层 | 内容 | 体积 | 敏感度 | 默认 |
|---|---|---|---|---|
| **Tier-1** | `UsageRecord`、`RequestTrace` 摘要（request_id、耗时、模型、token、finish_reason、错误码、**不含消息正文**） | 小（~1KB/请求） | 低（可能含 model 名与用户 id） | **常开** |
| **Tier-2** | 完整 canonical request/response（消息正文、工具调用参数与结果、搜索结果正文） | 大（数 KB ~ 数 MB） | 高 | **关闭** |

### 5.2 开关语义

```
设置项：persistence.messages  ∈ { off, on }
        persistence.usage     ∈ { on }        # 暂不支持关闭（计费必需）
```

- `off`：Tier-2 完全不落盘；Tier-1 的 `body_ref` 为空；trace 只保留摘要与 hash。
- `on`：Tier-2 落盘到加密库，按 §6 加密、按 §7 压缩、按 §8 保留。
- 切换开关**不追溯**：开启前的请求没有内容，开启后关闭的请求内容按保留策略清理。
- 开关粒度：全局默认 + 虚拟 key 级覆盖（某些 key 可强制 `off`，用于高敏感场景）。

### 5.3 Tier-2 里存什么

```typescript
interface StoredConversation {
  id: string;                        // = request_id
  session_key: string;               // 长会话分组键（用于前缀压缩）
  turn_index: number;
  ts: number;
  client_format: FormatId;
  provider_format: FormatId;
  model: string;
  /** 完整 canonical 请求（压缩前） */
  request: CanonicalRequest;
  /** 完整 canonical 响应（聚合后） */
  response: CanonicalResponse;
  /** 网关 agentic loop 的每一轮中间 canonical */
  turns?: Array<{ request: CanonicalRequest; response: CanonicalResponse }>;
  usage: CanonicalUsage;
  trace: RequestTrace;               // 见 20-pipeline.md §7
  redaction_profile: string;
}
```

## 6. 加密与密钥管理（结论详见 [65-storage-and-retention.md](./65-storage-and-retention.md)）

**结论先行**：**SQLite 单文件 + 应用层信封加密（Argon2id 派生 KEK，AES-256-GCM 加密每条记录，AAD 绑定 `request_id`）**，加密文件放在数据目录；**不选** SQLCipher / libsql 加密，理由（DB 级加密会把密钥生命周期和"库打开即全解密"耦合，且 libsql 的加密仍是 experimental；应用层加密能做到"按记录粒度 + 备份可移植 + 可换算法"）。

密钥来源三档，按部署形态自选：

| 档位 | 解锁方式 | 适用 | 取舍 |
|---|---|---|---|
| A | 启动时交互输入口令（Argon2id → KEK） | 有人值守 | 最安全；网关无法自动重启 |
| B | OS keyring / systemd credential 里的 KEK 或密文口令 | 无人值守常用 | 依赖 OS 账户权限；root 可读 |
| C | 明文 key 文件 + 严格权限（0600，属主隔离） | 完全无人值守 | 等同"密钥与数据同机"，只防备份/拷贝泄露，不防本机 root |

**硬规则**：密钥/口令/密文**不进 git**、不打印、不写日志；`.env` 只在部署机本地，仓库里只有 `.env.example`。

无人值守场景下的诚实结论：**单机私有时，B 档是本项目推荐默认值**——它能防"备份文件被拷走 / 数据库文件外泄"，不能防"攻陷运行账号"。要防后者需要 TPM/KMS/HSM，超出本项目范围（在 65 号文档标 **待验证**）。

## 7. 消息内容的前缀压缩 / 增量存储

### 7.1 问题

同一会话的连续请求共享极长公共前缀：system prompt + 工具定义 + 全部历史消息，只有最后 1~2 轮是新的。 naive 存整份 canonical，第 N 轮的存储量 ≈ O(N²)（累计）。一个 50 轮的会话，光历史就可能存 50 份近乎相同的副本。

### 7.2 方案：会话 delta 链 + zstd 共享字典

```
session_key = S
  turn 0:  BASE    ── 完整 canonical（压缩后）
  turn 1:  DELTA   ── diff(BASE, canonical_1) = { append: [...], mutate: [{path, value}] }
  turn 2:  DELTA   ── diff(canonical_1, canonical_2)
  ...
  turn k:  SNAPSHOT ── 每 snapshot_every_turns（默认 20）轮打一个完整快照，限制回放成本
```

- **diff 表示**：因为请求历史基本是"追加 + 极少数原地改"（system 微调、cache_control 断点移动），用 JSON Patch（RFC 6902）子集足够：`add`（追加数组元素）、`replace`（按 path）、`remove`。整段替换的字段（如 `response`）直接存整值，不做细粒度 diff——细粒度 diff 对大 JSON 收益低、复杂度高。
- **编码**：每条 delta 单独 zstd 压缩（level 3）；同一 `session_key` 的所有 delta 共用一个**共享字典**。
- **共享字典**：用 zstd 训练（`zstd --train`，`--maxdict` 默认 112KB，样本取该会话前若干轮的 canonical 序列化文本）。字典本身也入库（`zstd_dict` 表，按 `session_key` + 训练时间版本化），字典未命中时退化为无字典压缩。
- **读取**：`BASE → 回放 delta 链 → 目标轮`。回放成本 O(轮数)，所以有 snapshot；快照本身也可压缩。

### 7.3 压缩率估算（量级判断，需实测）

| 场景 | 预计压缩率 | 依据 |
|---|---|---|
| 单条 canonical 单独 zstd（无字典） | 3–5× | 文本类 JSON 的常规水平 |
| 同会话 delta 链 + 共享字典 | 相对"每轮存全量"再降 **10–50×** | 前缀重复度极高；zstd 字典对重复子串的收益主要来自"短匹配变长匹配" |
| 端到端（含"只有最后几 KB 是新内容"的 diff） | 50 轮会话从 ~O(N²) 全量降到 ~O(N) 全量 × 1/20 | 结构性的，不依赖压缩算法 |

**这些是量级估计，不是承诺**。Phase 1 要用真实 trace 抽样实测并写进 [docs/sources.md](../sources.md) 的基准小节（样本：10/30/50 轮会话，各 provider 格式）。

### 7.4 跨会话去重（可选，Phase 2+）

system prompt 和工具定义在多个会话间也高度重复。用**内容定义分块（CDC，FastCDC）**对 canonical 序列化文本切块，按块 hash 去重，块级存储。收益取决于 system prompt 的复用程度；复杂度明显高于 §7.2，默认关闭。

### 7.5 实现要点

1. **加密顺序**：先压缩、后加密（加密后密文不可压缩，顺序反了会让压缩率归零）。delta 链在明文态计算 diff，落盘前压 + 加密。
2. **字典安全**：字典从该会话自身的明文训练而来，因此**必须与数据同级加密保管**（它本身会泄漏前缀特征）。不要把字典当成非敏感资产。
3. **回放性能**：单请求最多触发一次回放（dog-fooding agent 读历史时），不做随机访问优化；需要随机访问时以 snapshot 为入口。
4. **AAD 绑定**：每条密文的 AAD 绑 `id + session_key + turn_index`，防止密文块被换位/重放（见 §6）。

## 8. 保留策略

| 配置 | 默认 | 说明 |
|---|---|---|
| `retention.messages_days` | `30` | Tier-2 消息内容保留天数；`0` = 不自动清理 |
| `retention.messages_max_count` | `20000` | Tier-2 条数上限，超出按时间淘汰最旧 |
| `retention.usage_days` | `365` | Tier-1 usage 保留天数 |
| `retention.rollup_after_days` | `90` | 超过该天数的 usage 聚合为日/月 rollup 行，明细可归档删除 |
| `cleanup.schedule` | 每日 04:00 本地时间 | 清理任务 cron |
| `export.format` | 加密 JSONL + zstd | 手动导出用 |

- 清理是**物理删除**（不是软删），并在 `retention_log` 表记一条"删了哪个时间区间的多少条"（只记统计，不记内容）。
- 加密导出：用 age 或 AES-256-GCM + Argon2id 派生密钥（与 §6 同一套 KDF 参数），导出文件含版本头与 KDF 参数，便于跨机恢复。

## 9. 脱敏规则

在写入 Tier-2 **之前**执行，`redaction_profile` 记录用了哪套规则。

### 9.1 硬编码黑名单（永不可配置关闭）

| 目标 | 处置 |
|---|---|
| `Authorization` / `x-api-key` / `x-goog-api-key` / `api-key` 等 header | 整个 header 丢弃 |
| provider base_url 的 userinfo 段（URL 里 `scheme://用户名:口令@主机` 那种内联凭据写法） | 剥离 userinfo |
| 疑似 API key 的字符串（`sk-`、`sk-ant-`、`AIza`、`ghp_`、`xoxb-` 等前缀 + 长度特征） | 替换为 `<REDACTED:key>` |
| JWT（`eyJ` 开头三段 base64） | 替换为 `<REDACTED:jwt>` |
| `.env` 内容 / 私钥块（`-----BEGIN … PRIVATE KEY-----`） | 整块替换 |

### 9.2 可配置规则

- JSON path 黑名单：如 `messages[*].parts[*].raw.headers`；
- 正则规则集（用户自定义，如内部域名、项目代号）；
- 采样/截断：超过 `max_stored_content_bytes`（默认 256KB/请求）的内容截断并标记 `truncated: true`；
- **模式**：`redaction.mode ∈ { store_redacted, drop_message }`，默认前者。

### 9.3 与 trace 的关系

`RequestTrace` 默认不含正文，因此 Tier-1 几乎不触发脱敏；但 `plugin_log`、`warnings` 里可能夹带用户内容，统一走 §9.2 的路径规则。

## 10. Dog-fooding Agent 接口

### 10.1 分层访问约束（与 §5.2 强一致）

| `persistence.messages` | agent 能读 |
|---|---|
| `off`（默认） | 仅 Tier-1：用量、成本、模型分布、错误率、延迟分位、`finish_reason` 分布、工具调用计数。**看不到任何消息正文** |
| `on` | Tier-1 + Tier-2：可检索历史会话、复现某次请求的完整 canonical、分析某段对话的 token 构成 |

agent 拿不到密钥材料，也拿不到脱敏前的数据——脱敏在入库前完成，agent 读的是已脱敏结果。

### 10.2 接口形态

agent 通过**网关自身的 OpenAI 兼容端点**访问（dog-fooding：网关把内部能力暴露成 tools，自己当自己的 client）。

```
POST /v1/chat/completions            # 标准入口，模型可选"内置分析模型"
  tools: [
    { type: "function", name: "usage_query",   ... },
    { type: "function", name: "cost_report",   ... },
    { type: "function", name: "trace_get",     ... },   # 受 persist_messages 约束
    { type: "function", name: "conversation_search", ... }, # 受 persist_messages 约束
    { type: "function", name: "plugin_config_get", ... },
    { type: "function", name: "provider_health", ... }
  ]
```

工具集是**白名单制**：只有显式开启的 tool 才会出现在列表里，且每个 tool 声明自己的 tier 依赖（`requires_persistence: "messages"`）。`off` 时 `trace_get` / `conversation_search` 直接不出现在 tools 列表——不是"返回错误"，而是"不可见"，这样 agent 不会反复试探。

### 10.3 工具草案

```typescript
/**  Tier-1，默认可用 */
usage_query(params: {
  from: string; to: string;
  group_by?: ("hour"|"day"|"model"|"provider"|"key_id"|"client_format")[];
  filters?: { model?: string; provider?: string; key_id?: string; status?: string };
  metrics?: ("tokens"|"cost"|"requests"|"latency_p50"|"latency_p95"|"error_rate"|"cache_hit_rate")[];
}): { rows: Array<Record<string, number>>; totals: Record<string, number> };

cost_report(params: { from: string; to: string; group_by?: "model"|"provider"|"day" }): CostReport;

/**  Tier-2，仅 persist_messages=on */
trace_get(params: { request_id: string; include_body?: boolean }): RequestTrace & { body?: StoredConversation };
conversation_search(params: {
  query?: string; session_key?: string; from?: string; to?: string;
  limit?: number; include_body?: boolean;
}): { hits: Array<{ request_id: string; session_key: string; turn_index: number; snippet?: string }> };
```

### 10.4 与 WebUI 的关系

WebUI 的"agent 对话"页就是普通聊天界面，指向上述端点；数据面与 Tier-1/Tier-2 完全一致，不存在"后台另一套权限"。UI 选型见 [00-overview.md](./00-overview.md)。

## 11. 待验证清单

1. 各 provider `input_tokens` 是否已含 cache read（决定 §4 规则 2 的最终写法）。
2. zstd 共享字典在"短 delta + 长公共前缀"上的实测压缩率，以及字典训练耗时（应控制在百 ms 级，否则要离线预训练）。
3. Argon2id 在目标硬件上的实测耗时（决定 B 档启动延迟）与推荐参数组合。
4. 加密 Tier-2 后的备份/迁移流程（换机：密文 + KDF 参数 + 口令即可恢复，需实测验证）。
5. `usage_missing` 兜底估算的误差率。
