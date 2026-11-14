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
                     ├─▶ zstd + 全局字典（含按客户端类型变体，见 65 §5.2）
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
  canonical_roundtrip: boolean;   // 恒 true：v1 一律完整走 canonical（见 20-pipeline.md §4）
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
  /** 计费快照：请求完成时一次性解析并固化，之后**不可变**（见 §4.2）。
   *  当时拿不到价格 → null，cost.status = "pending_price"。 */
  price_snapshot?: {
    table_version: string;              // 价格表版本号（整表一个）
    /** 命中的规则集版本（峰谷体系 08-17 生效、周末规则 08-23 生效，会叠加变更） */
    rule_set_version: string;
    /** 命中的时段档；上游不返回，由网关按请求时间戳解析 */
    tier: "peak" | "off_peak";
    /** 命中的时段窗口；无则走该日期区间的默认 rates */
    window?: { start: string; end: string; tz: string };
    /** 节假日判定（调休上班日 / 节假日 / 未知） */
    holiday_status: "normal" | "holiday" | "adjusted_workday" | "holiday_unknown";
    /** 实际费率（微美元/单位），与 cost 明细一一对应 */
    rates: Record<string, number>;
    /** 所用费率条目的生效日期（对账时 answering"当时是哪一版"） */
    rate_effective_from: string;
    source_url?: string;                // 价格来源 URL
    fetched_at?: string;                // 抓取日期
  } | null;
  cost: {                               // 网关侧计算的费用（微美元，见 §4.2）
    input: number; output: number; cache_read: number; cache_write: number;
    reasoning: number; builtin_tools: number; external: number;
    /** 等值 API 计费合计——**永远尝试计算**，订阅/无 usage 路径下唯一稳定的参考值 */
    as_api_micros: number;
    /** 实际现金支出——订阅路径为 0；与 as_api **分开存储，不合并** */
    cash_micros: number;
    status: "priced" | "pending_price" | "unpriced";
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
- 定价变更**不追溯改写**历史记录：费用在请求完成时一次性算出并**快照固化**（`price_snapshot` + `cost`），查询不再重放价格历史。完整原则见 §4.2。
- 金额一律用整数微美元存储，避免浮点误差；`UsageRecord` 里所有 `*_micros` 字段同此口径。
- **预估算准入 vs 事后计费的分工**（重要，agentgateway 的教训）：budget 是**事后刹车不是硬顶**——跨限的那次请求仍然完成并计费，只有下一次被拒。若要"硬限额"，必须在准入层（S0/S2）做预估算（tokenizer 估 prompt token + 已知的 max_output_tokens 上限）。我们两者都做：准入层预估算拦大部分，事后精确记账修正。
- **未定价模型**：usd budget 对它永不扣也永不拦。必须 `is_priceable()` 预检，未定价的模型要么拒绝路由，要么显式标记 `unpriced` 并只记 token 不拦额度。

### 4.2 计费原则：价格会更新，历史记录绝不被重算

**决策**：每条记录的计费信息在**请求完成时**基于当时可得信息一次性算出并快照固化；当时没有价格就标记待补，
补的时候用**请求时点的有效价格**而不是当前价格。价格表是**三层结构**（规则集 × 费率 × 节假日日历），
点时间解析出命中费率与 tier；上游余额则作为**事实**做区间级对账。

**理由**：

1. 价格会变，而且不只是按日期变——DeepSeek 有**阶梯时间计费（错峰时段折扣）**，同一天内不同时段费率不同。
   若允许重算，"上周花了多少钱"会随改价而漂移，看板数字不可复现、无法对账。
2. 快照让每笔成本**可解释**：表版本 + 规则集版本 + 命中 tier + 所用窗口 + 节假日判定都落在记录里，
   审计时能逐笔复现。
3. 不可变换来查询零成本——聚合/看板不需要在每次查询时重放整段价格历史。

**代价**：单价表更新后历史记录不自动反映新价（这是特性不是缺陷）；要"按新价看历史"只能另开**派生视图**，
不改原记录。存储上每条多一份 price snapshot（几十字节，可忽略）。

#### 价格表模型：三层（规则集 × 费率 × 节假日日历）

价格不是"一个数"，而是三个独立维度各自带生效区间，点时间解析时**先选当时有效的规则集，再在集合内定档，
最后取当时有效的费率**：

```typescript
/** 第一层：规则集——"什么时候是什么档" */
interface PricingRuleSet {
  rule_set_version: string;
  effective_from: string;              // "2026-08-17"（Asia/Shanghai 当地日期）
  effective_to?: string;               // null = 至今
  tz: string;                          // 规则按 provider 当地时间解释，如 "Asia/Shanghai"
  /** 高峰窗口（仅工作日参与） */
  peak_windows: Array<{ start: string; end: string }>;  // [["09:00","12:00"],["14:00","18:00"]]
  /** 周末是否全天低谷 */
  weekend_all_off_peak: boolean;       // 2026-08-23 起 true
  /** 法定节假日是否全天低谷 */
  holiday_all_off_peak: boolean;       // true
}

/** 第二层：费率——"什么模型、什么单位、多少钱" */
interface RateEntry {
  model: string;
  effective_from: string;
  effective_to?: string;
  /** 计价单位 → 微美元/单位 */
  rates: {
    input_cache_hit: number; input_cache_miss: number; output: number;
    cache_write_ttl_5m?: number; cache_write_ttl_1h?: number;
    cache_write_ttl_30m?: number; cache_write_ttl_12h?: number;
    builtin_tool_per_call?: number;
  };
  source_url?: string;                 // 来源 URL
  fetched_at?: string;                 // 抓取日期
}

/** 第三层：节假日日历（按年维护，**含调休上班日**） */
interface HolidayCalendar {
  year: number;
  source_url: string;
  /** 放假日期（YYYY-MM-DD） */
  holidays: string[];
  /** 调休上班日：周末但按工作日计价的日期 */
  adjusted_workdays: string[];
}

/** 点时间解析：规则集 ∩ 节假日日历 ∩ 费率 → tier + rates */
function resolvePrice(table: PriceTable, ts: number, model: string): {
  tier: "peak" | "off_peak";            // 上游不返回档位，由网关按 ts 解析
  rule_set_version: string;
  holiday_status: "normal" | "holiday" | "adjusted_workday" | "holiday_unknown";
  rates: RateEntry["rates"];
  rate_effective_from: string;
}
```

**已核实的峰谷规则（DeepSeek，2026-11 核查）**——作为规则集的初始内容写入表内：

| 项 | 值 |
|---|---|
| 峰谷体系生效 | **2026-08-17 00:00（Asia/Shanghai）**，高峰价为低谷 **2 倍** |
| 高峰窗口 | **工作日 09:00–12:00、14:00–18:00**（北京时间）；其余时段低谷 |
| 周末规则 | **2026-08-23 00:00 起**周六/周日**全天统一低谷**（此前周末按工作日规则）；空闲时段另含**法定节假日** |
| 来源 | [新浪财经](https://finance.sina.com.cn/tech/digi/2026-08-17/doc-ininqpev7133165.shtml)、[TradingView/PANews](https://es.tradingview.com/news/panews:5758a6926acdf:0)、[知乎专栏](https://zhuanlan.zhihu.com/p/2075260274609803574) |

**官方明确"新规则生效前产生的费用仍按原标准结算"**——这正好实证本节的原则：供应商自己都不重算历史，
我们更没有理由重算。快照固化不是我们的发明，是与上游计费口径对齐。

三条实现约束：

- **时区按规则集里的 `tz` 显式换算**（`Intl` / Luxon，**不手算 UTC 偏移**）——错峰是 provider 当地时间的
  商业规则，与网关跑在哪个时区无关；手算偏移会在夏令时与 provider 改时区时静默错档。
- **节假日不算法推算**：只认日历表里的显式条目。表中缺失的日期**按工作日保守处理**（估高不估低，
  预算才安全）并标 `holiday_status: "holiday_unknown"`；留出将来由公共节假日 API 生成日历的入口。
  **调休上班日必须显式列出**——中国日历存在"周末变工作日"，算法推算必然错。
- **点时间查询是唯一入口**：任何计费/backfill/看板都走 `resolvePrice(ts)`，不允许在别处现算费率。
- **仓库内只放静态表 + 版本号**（DeepSeek 价格不在本仓库，走配置/环境注入）。AI 辅助刷新**只新增版本、
  不改旧版本**——旧版本必须能永久读，否则历史快照无法复现。

#### 上游不给档位：tier 必须网关自己解析

**上游响应不返回命中档位**（响应里只有用量，没有"这次按高峰还是低谷计价"）。因此 `price_snapshot.tier`
必须由网关按**请求时间戳**自行解析后记入——这是它可解释、可对账的唯一来源。

#### 真值对账：余额即事实

**已核实：DeepSeek 用同一个 API key 即可查询余额。** 于是形成三级闭环：

> **估算**（快照 + 峰谷定档）→ **事实**（余额对账）→ **偏差告警**

- **我们的 computed cost 是估算，上游余额差是事实。** 两者**分开存储、分开展示，绝不互相覆盖**——
  估算带快照不可变（规则 a），事实按时点采样；用事实覆盖估算就等于重算历史。
- **只做区间级对账，不做逐笔归因。** 周期性快照余额，把「区间内余额差」与「区间内估算 cash 总和」对比，
  产出对账记录 `{ interval_start, interval_end, estimated_cash_micros, actual_balance_delta_micros,
  deviation_ratio, snapshot_ok }`。**理由：并发请求下无法把余额差归因到单笔请求**（多个请求的扣费
  在时间上重叠，且上游侧还有我们看不到的重试/计费时序）。偏差持续过大时告警——那意味着价格表、
  峰谷定档或 usage 归一有错，是需要人看一眼的信号，不是自动改写历史的许可。

**两个必须写明的坑**：

| 坑 | 处理 |
|---|---|
| DeepSeek **赠送余额优先扣** | 余额差 ≠ 现金支出。对账记录必须能区分"扣的是赠送额还是现金额"（查询结果里若给不出这个区分，就把 `actual_balance_delta` 标为"含赠送"并降低告警灵敏度），否则会把赠送额度消耗误报成现金超支 |
| 余额是**时点值**，快照失败/丢失会让区间对账出现缺口 | 记录缺口（`snapshot_ok: false` + 缺口区间）而**不是假装连续**；缺口区间不参与偏差率计算，只计入"不可对账时长"指标 |

**附带用途**：低余额作为**路由信号**（配合 Plan 感知路由转向订阅路径，见 [45-credentials.md](./45-credentials.md) §4），
以及**请求前预检**——余额不足时直接失败，避免必然失败的调用占用超时预算与上游配额。

#### 四条硬规则

| # | 规则 |
|---|---|
| a | **不可变 + 快照**：`UsageRecord` 写入后 `cost` 与 `price_snapshot` 只读；价格表更新**不得**重算已有记录 |
| b | **请求时尝试计费**：拿不到价格 → `cost.status = "pending_price"`，**保留完整 usage**（不丢弃、不记 0）；确认无价的模型 → `unpriced`（只记 token，不拦额度，见 §4.1） |
| c | **backfill 用请求时点**：按请求时间戳解析当时的「规则集 ∩ 节假日日历 ∩ 费率条目」，并记录 `backfilled_at` 与所用表版本——**绝不是用当前价格补历史** |
| d | **`as_api` 永远尝试计算**：订阅/无 usage 路径下它是唯一稳定的参考值；`cash` 与 `as_api` **分开存储、不合并、不相加** |

#### cash 与 as_api 的关系

- `cost.cash_micros`：**实际现金支出**。订阅路径（`oauth_device_code` / `session_cookie`）为 **0**——那笔钱是月费，
  不随单次请求发生。
- `cost.as_api_micros`：**等值 API 计费**（同样的 tokens 若走 API key 会花多少）。订阅路径上游不给 usage 时，
  用 tokenizer 自估算 tokens × **当时** API 价格算出。
- **两者必须用同一次 `resolvePrice(ts)` 的结果**——同一次解析、同一组 rates，只是乘的单价不同；
  分开解析会出现"cash 按高峰价、as_api 按错峰价"这种无法解释的记录。

#### 订阅路径

上游不给 usage → tokenizer 自估算并标注 `usage.source = "estimated"` + `precision` + `estimate_method`
（见 [45-credentials.md](./45-credentials.md) §7.1）；`cash = 0`；`as_api` 为参考值。
**订阅摊销（月费 / 周期 as_api）是可选派生指标，不写进单条记录**——摊销依赖预估额度，而额度会变，
写进记录就等于把易变量塞进不可变快照。

#### 跨时段边界

流式请求跨错峰/高峰边界时，**按请求开始时间定档**（确定性优先）：同一请求只有一个 tier，重放/对账不会出现
"一半 off_peak 一半 peak"的分裂记录。另一种选择是**按 chunk 时间戳拆分计费**——更"公平"，但同一请求的 cost
变成多条，幂等重放与对账都要处理分段，且多数上游自己也按请求开始计费。v1 选前者；若将来要拆分，作为
**派生视图**做，不改原记录。

---

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

**always-canonical 的附带收益（落盘即 canonical）**：因为 v1 一律完整走 canonical
（[20-pipeline.md](./20-pipeline.md) §4），落盘的所有聊天记录天然就是 canonical 格式——计费管道与
dog-fooding 消费的是**同一份**多单位归一化 usage，不需要为每家厂商各写一套解析/统计；Tier-2 的前缀压缩
按 canonical 的消息/parts 差分而非字节差分；任何一条存下来的会话都能重新编码成任意 dialect。
完整推论见 [65-storage-and-retention.md](./65-storage-and-retention.md) §5.6。

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
2. zstd 全局字典在"短 delta + 长公共前缀"上的实测压缩率，以及离线训练耗时（训练不得进请求路径）。
3. Argon2id 在目标硬件上的实测耗时（决定 B 档启动延迟）与推荐参数组合。
4. 加密 Tier-2 后的备份/迁移流程（换机：密文 + KDF 参数 + 口令即可恢复，需实测验证）。
5. `usage_missing` 兜底估算的误差率。
6. DeepSeek 法定节假日的**逐日清单与调休上班日**（节假日日历按年维护，缺失日期按工作日保守处理并标
   `holiday_unknown`，见 §4.2）。
7. `resolvePrice(ts)` 在跨时区/夏令时切换时点的行为（用固定 fixture 固化，避免手算偏移回归）。
