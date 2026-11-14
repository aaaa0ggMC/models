# 60 · 统计计费管道与 Dog-fooding

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[20-pipeline.md](./20-pipeline.md)、[40-provider-adaptors.md](./40-provider-adaptors.md)、[65-storage-and-retention.md](./65-storage-and-retention.md)

## 1. 设计原则

1. **统计管道与主链路物理分离**。主链路只负责往队列里扔一条 `UsageRecord`；聚合、定价、存储、查询全部在独立进程/线程里完成。管道挂了不影响任何用户请求。
2. **分层存储是隐私默认值**：usage/计费元数据（小、非敏感）**默认开启**；消息内容（大、敏感）**默认关闭**，由用户显式打开后才落盘。agent 接口同样受这个开关约束。
3. **落盘前脱敏是强制步骤**，不是可选项：provider API key、Authorization 头、cookie 永不入库。
4. **规范化与原始值都留**：所有 token 口径既存规范化值（用于横向对比/计费），也存 provider 原始 usage（用于对账/审计）。

## 2. 管道结构

```text
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
         └──▶ [仅当 persistence.messages = on]
              Tier-2 存储：request_bodies（大、敏感、加密）
                     │
                     ├─▶ 前缀压缩 / delta 链（§5）
                     ├─▶ zstd + 共享字典
                     └──▶ 应用层信封加密（详见 [65-storage-and-retention.md](./65-storage-and-retention.md) 决策 S1）
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
  body_ref?: string;                 // 指向 Tier-2 加密内容的 id（仅 persistence.messages=on）
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

> **本节已按 review #5 去重**：分层存储、开关语义、Tier-2 表结构、前缀压缩、保留策略、脱敏规则的**唯一事实来源**是
> [65-storage-and-retention.md](./65-storage-and-retention.md) §4–§7。此前本文 §5/§7–§9 抄了一份，已经和 65 漂移：
> 字典表名一边写 `zstd_dict` 一边写 `zstd_dicts`；单条无字典压缩率一边写 3–5× 一边写 1.25–5×；加密范围一边写"只做应用层"
> 一边写"整库 + 列级双层"。两处分别维护必然分叉，故删除副本，只留指针。
> **本文只保留"计费管道需要存储提供什么"这一个视角**：

| 计费管道用到的存储能力 | 归属 | 本文的用法 |
|---|---|---|
| Tier-1 `usage_events` / `usage_rollup_*` | 65 §4.3 | `UsageRecord` 的结构见本文 §3；rollup 规则见 §4.1 |
| Tier-2 完整 canonical（`StoredConversation`） | 65 §4.3 / §5 | 只在 `persistence.messages = on` 时存在；dog-fooding 的 `trace_get` / `conversation_search` 依赖它，见 §6 |
| `RequestTrace` | 65 §4.1 | Tier-1 摘要，不含正文 |
| 脱敏（`redaction_profile`） | 65 §6 | 写入 Tier-2 **之前**执行；`UsageRecord.redaction_profile` 记用了哪套规则 |
| 保留与导出 | 65 §7 | `retention.*` 配置项在 65 §7，不在这里重复 |

**开关**：`persistence.messages`（默认 `off`）、`persistence.usage`（恒 `on`）、`persistence.media`（默认 `off`）。
**`off` 时 Tier-2 完全不落盘**：`UsageRecord.body_ref` 为空，trace 只保留摘要与 hash；§6 的 `trace_get` / `conversation_search`
直接不出现在工具列表里（不是"返回错误"，而是"不可见"，这样 agent 不会反复试探）。

---

## 6. Dog-fooding Agent 接口

> **编号修正（review #5 去重的连带后果）**：本文原有的分层存储/前缀压缩/保留/脱敏四节已改为指向 [65-storage-and-retention.md](./65-storage-and-retention.md) 的指针，
> 原 §10/§11 顺次前移为 §6/§7，避免出现 5 → 10 的跳号。外部引用已同步（66 §4、15 §6.4）。

### 6.1 分层访问约束（与 [65-storage-and-retention.md](./65-storage-and-retention.md) §4.2 强一致）

| `persistence.messages` | agent 能读 |
|---|---|
| `off`（默认） | 仅 Tier-1：用量、成本、模型分布、错误率、延迟分位、`finish_reason` 分布、工具调用计数。**看不到任何消息正文** |
| `on` | Tier-1 + Tier-2：可检索历史会话、复现某次请求的完整 canonical、分析某段对话的 token 构成 |

agent 拿不到密钥材料，也拿不到脱敏前的数据——脱敏在入库前完成，agent 读的是已脱敏结果。

### 6.2 接口形态

agent 通过**网关自身的 OpenAI 兼容端点**访问（dog-fooding：网关把内部能力暴露成 tools，自己当自己的 client）。

```text
POST /v1/chat/completions            # 标准入口，模型可选"内置分析模型"
  tools: [
    { type: "function", name: "usage_query",   ... },
    { type: "function", name: "cost_report",   ... },
    { type: "function", name: "trace_get",     ... },   # 受 persistence.messages 约束
    { type: "function", name: "conversation_search", ... }, # 受 persistence.messages 约束
    { type: "function", name: "plugin_config_get", ... },
    { type: "function", name: "provider_health", ... }
  ]
```

工具集是**白名单制**：只有显式开启的 tool 才会出现在列表里，且每个 tool 声明自己的 tier 依赖（`requires_persistence: "messages"`）。`off` 时 `trace_get` / `conversation_search` 直接不出现在 tools 列表——不是"返回错误"，而是"不可见"，这样 agent 不会反复试探。

### 6.3 工具草案

```typescript
/** dog-fooding 工具集的方法签名（不是可执行代码，是契约草案）。
 *  包在 interface 里是为了让 tsc 能解析——此前是裸的函数签名行，TS1005 报 21 处。 */
interface DogfoodingTools {
  /** Tier-1，默认可用 */
  usage_query(params: {
    from: string; to: string;
    group_by?: ("hour"|"day"|"model"|"provider"|"key_id"|"client_format")[];
    filters?: { model?: string; provider?: string; key_id?: string; status?: string };
    metrics?: ("tokens"|"cost"|"requests"|"latency_p50"|"latency_p95"|"error_rate"|"cache_hit_rate")[];
  }): { rows: Array<Record<string, number>>; totals: Record<string, number> };

  cost_report(params: { from: string; to: string; group_by?: "model"|"provider"|"day" }): CostReport;

  /** Tier-2，仅 persistence.messages=on */
  trace_get(params: { request_id: string; include_body?: boolean }): RequestTrace & { body?: StoredConversation };
  conversation_search(params: {
    query?: string; session_key?: string; from?: string; to?: string;
    limit?: number; include_body?: boolean;
  }): { hits: Array<{ request_id: string; session_key: string; turn_index: number; snippet?: string }> };
}
```

### 6.4 与 WebUI 的关系

WebUI 的"agent 对话"页就是普通聊天界面，指向上述端点；数据面与 Tier-1/Tier-2 完全一致，不存在"后台另一套权限"。UI 选型见 [00-overview.md](./00-overview.md)。

## 7. 待验证清单

1. 各 provider `input_tokens` 是否已含 cache read（决定 §4 规则 2 的最终写法）。
2. zstd 共享字典在"短 delta + 长公共前缀"上的实测压缩率，以及字典训练耗时（应控制在百 ms 级，否则要离线预训练）。
3. Argon2id 在目标硬件上的实测耗时（决定 B 档启动延迟）与推荐参数组合。
4. 加密 Tier-2 后的备份/迁移流程（换机：密文 + KDF 参数 + 口令即可恢复，需实测验证）。
5. `usage_missing` 兜底估算的误差率。
