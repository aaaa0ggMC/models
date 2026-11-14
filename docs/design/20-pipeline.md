# 20 · 请求生命周期与管道

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[00-overview.md](./00-overview.md)、[10-canonical-schema.md](./10-canonical-schema.md)、[30-plugin-api.md](./30-plugin-api.md)
> §6 是 control-plane 判断（decision 模型消费点）；文中标注 **待验证** 的点需要在编码前用真实 provider 响应验证。

## 1. 设计原则

1. **单一事实来源是 canonical（AG-IR）**。所有插件、计费、日志只面对 canonical，不面对任何厂商格式。
2. **fast path 优先**。能不过 canonical 结构转换就不转；必须转时才付保真度代价。
3. **流式是第一公民**。所有阶段都必须能在"边收边发"模式下工作，不允许出现"等整个响应体结束才开始下一步"的隐藏缓冲（除非显式声明需要聚合的插件）。
4. **失败可观测**。每个阶段都有明确的错误类型、可重试性标记和 fallback 语义。
5. **计费旁路**。统计与计费绝不阻塞主链路，失败不影响用户请求。

## 2. 阶段总览（Pipeline Stages）

一次请求在网关内部经过 **11 个显式阶段（S0–S10）**。每个阶段是一个实现了
`Stage<I, O>` 接口的纯-ish 对象（内部可有 IO），由 `PipelineRunner` 串联。

```text
                    ┌──────────────────────────────────────────────────────────┐
                    │                    AgentGateway                          │
 client (任意格式)   │                                                          │
 ───────────────────▶│ S0 Ingress → S1 Decode → S2 Route → S3 onRequest        │
                    │                              │                           │
                    │                              ▼                           │
                    │                        S4 Encode ──┐                     │
                    │                              │     │ fast path          │
                    │                              ▼     ▼                     │
                    │               ┌──────► S5 Upstream ◄──────┐              │
                    │               │            │              │              │
                    │          (tool loop)       ▼              │              │
                    │               │      S6 ProviderDecode    │              │
                    │               │            │              │              │
                    │               │      S7 onStreamChunk     │              │
                    │               │            │              │              │
                    │               │      S8 ClientEncode      │              │
                    │               │            ▼              │              │
                    │               └──── S9 onResponse ◄───────┘              │
                    │                        │                                 │
                    │                        ▼                                 │
                    │                  S10 UsageEmitter ──▶ 计费管道（异步入队）│
                    └──────────────────────────────────────────────────────────┘
```

### 阶段职责表

| 阶段 | 输入 → 输出 | 可否流式 | 可否失败重试 | 插件 hook | 说明 |
|---|---|---|---|---|---|
| S0 Ingress | HTTP → `RequestContext` | 是 | 是（鉴权/限流拒绝直接返回，不进 S1） | `onError` | 识别客户端格式、鉴权、限流、分配 `request_id`、超时预算 |
| S1 Decode | 原始 body → `CanonicalRequest`（fast path 下只到**信封档**，见 §3 S1） | 否（请求体必须完整） | 否（格式错误 = 400，不可重试） | `onError` | 客户端格式 codec 解码；产物带 `source_format`；信封档只解析路由必需字段，完整档推迟到 S3/S4/S6 |
| S2 Route | `CanonicalRequest` → `ResolvedRoute` | 否 | 是（路由失败 = 无可用 provider） | `onError` | 别名解析、provider 候选列表、健康/熔断过滤、fast path 判定 |
| S3 onRequest | `CanonicalRequest` → `CanonicalRequest` | 否 | 否（插件短路算成功） | **`onRequest`**、`onError` | 插件链：压缩、注入、改写、短路返回 |
| S4 Encode | `CanonicalRequest` → 上游 body | 否 | 否 | `onError` | provider codec 编码；fast path 时输出原始字节 |
| S5 Upstream | 上游 body → 上游响应 | **是** | 是 | `onError` | HTTP 调用、重试、fallback、超时、熔断 |
| S6 ProviderDecode | 上游响应 → `CanonicalResponse` / 事件流 | **是** | 否 | `onError` | provider codec 解码；fast path 时只抽取 usage 信封 |
| S7 onStreamChunk | chunk → chunk | **是** | 否 | **`onStreamChunk`**、`onError` | 插件可改写/丢弃/缓冲聚合 |
| S8 ClientEncode | canonical → 客户端格式字节 | **是** | 否 | `onError` | 客户端格式 codec 编码；fast path 时直通 |
| S9 onResponse | `CanonicalResponse` → `CanonicalResponse` | 否（流式时在流结束后） | 否 | **`onResponse`**、`onError` | 后置插件：审计、脱敏、指标 |
| S10 UsageEmitter | `UsageRecord` → 队列 | 是 | 是（失败只丢统计，不丢响应） | —（旁路，插件不参与） | 异步、批量、可重放 |

**另外两个 hook 不在阶段表里，因为它们不是"一个阶段"而是横切点**：

- **`onToolCall`**：在 [§5.2](#52-网关循环状态机) 的网关 agentic loop 里，**每次工具执行前后**触发（`(call, ctx) => ToolResultPart`）。客户端循环模式下不触发。
- **`onError`**：上表标了"每个阶段出错时都会调用"；它与阶段并行而非串在某一格，所以画不成单独一行。完整时序见 [30-plugin-api.md](./30-plugin-api.md) §3。

### 2.1 `RequestContext`

贯穿全链路、只增不改的上下文对象，所有阶段和插件都能读到：

```typescript
interface RequestContext {
  request_id: string;            // "req_" + ulid
  trace_id?: string;             // 若上游带 W3C traceparent
  started_at: number;            // epoch ms
  deadline: number;              // S0 计算的绝对超时时刻（剩余预算贯穿 S5/S8）

  client_format: FormatId;       // "openai.chat" | "openai.responses" | ...
  client_raw_headers: Record<string, string>;  // 已脱敏

  auth: AuthContext;             // virtual key / team / user 标识（不含明文 key）
  route: ResolvedRoute;          // S2 后填充
  provider_format: FormatId;     // 目标 provider 的格式 id
  fast_path: boolean;            // 见 §4

  state: Record<string, unknown>; // 阶段间共享的暂存区（tool loop、插件 scratch）
  metrics: StageMetric[];        // 每阶段耗时/大小
}
```

`state` 是工具调用循环与插件跨阶段协作的唯一通道（见 §5）。

## 3. 各阶段细节

### S0 Ingress

- **格式识别**优先级：
  1. 显式 header `x-agentgateway-format`（`openai.chat` / `openai.responses` / `anthropic.messages` / `gemini.generateContent`）；
  2. 路径签名（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1beta/models/{model}:generateContent`、`:streamGenerateContent`）；
  3. body 结构嗅探（存在 `input` 且无 `messages` → Responses；存在 `contents` → Gemini；存在 `system` 顶层字段或 `messages[].content` 为 block 数组 → Anthropic）；
  4. 都不命中 → `400 unsupported_format`。
- 鉴权失败、限流超限、模型不在允许列表 → 直接返回，**不进 S1**（避免无谓解码开销）。
- 计算 `deadline`：取 client 超时、provider 超时、全局上限三者的最小值。

### S1 Decode（client → canonical）

由 `client_format` 对应的 codec 执行，**分两档（review #8.3，作者已拍板定稿：D-fastpath-1）**：

- **信封档（envelope-only）**：fast path 下只做这一档。只解析「信封 + 路由必需字段」——客户端格式识别
  （`source_format`）、`model` / access_path、usage 信封位置、是否流式（`stream`）、请求体字节长度；
  **不物化完整 canonical**，只保留原始字节引用；
- **完整档（full-canonical）**：物化完整 `CanonicalRequest`。慢路径（或有 `full-canonical` 请求侧插件）
  时才付这个代价。

**完整 canonical 的物化推迟到真正需要它的阶段**：

| 需要完整 canonical 的阶段 | 触发条件 |
|---|---|
| S3 onRequest 插件链 | 存在已启用的**请求侧**插件声明 `scope: "full-canonical"` |
| S4 Encode | 不走 fast path（格式不同 / 插件改写 / 显式禁用） |
| S6 ProviderDecode | 不走 fast path（需要 canonical 响应才能转回客户端格式） |

硬性要求（两档都适用，完整档的全部语义）：

- **不允许丢字段**。未建模的顶层键必须进入 `raw.unmapped`（见 [10-canonical-schema.md](./10-canonical-schema.md) §raw passthrough）；
- 遇到**未知的 part 类型**时，降级为 `UnknownPart{ type: "unknown", raw }`，而不是报错——保证前向兼容（provider 新增 block 类型时网关不炸）；
- 解码失败返回 `canonical_decode_error`，附带 `field_path` 指向出错字段，便于客户端排错。

### S2 Route

1. `model` 字符串 → 查别名表（`alias → [provider:model, ...]`），得到候选列表（含权重、优先级、最大上下文、单价）。
2. 过滤：provider 健康检查、熔断器（连续失败率超阈值则摘除）、key 额度不足、`model` 不在 key 允许列表。
3. 排序得到 `attempt_plan: Attempt[]`，每个 `Attempt` 带 `provider`、`provider_format`、`fast_path_eligible`、`weight`。
4. **fast path 判定**见 §4。
5. 缓存查询（Phase 2+）：exact-match key = hash(规范化 canonical)；语义缓存后续做，命中则直接跳到 S9。
6. **参数兼容性预检**（`require_parameters` 语义）：若客户端传了目标 provider 不支持的参数，且 `on_unsupported === "error"`，直接返回 `capability_unsupported`，**不进入 fallback**。理由：静默丢参数比失败更危险（OpenRouter 的 `require_parameters` 是同一立场，见 [00-overview.md](./00-overview.md) §7.0.2）。
7. **预算预检**：`is_priceable(provider, model)` + 单价存在性检查 + key 额度上限。缺单价时取该模型的最高已发布价（高估不低估），避免 spend cap 静默失效。
8. **sticky 会话键**：若同一 `session_key` 近期命中过某 provider，优先复用（保 prompt cache），60 分钟不活动过期；provider 报错则不更新粘性。

排序键（可配置）：`priority` / `weight` / `price` / `throughput_p50` / `latency_p50` / `error_rate`。分位数据来自 `RequestTrace` 聚合（[00-overview.md](./00-overview.md) §7.0.2 的六个生产信号）。

### S3 onRequest 插件链

按注册顺序执行，插件见 [30-plugin-api.md](./30-plugin-api.md)。要点：

- 插件只能看到 canonical + `RequestContext`，**看不到**任何厂商原始 body；
- 插件可返回 `ShortCircuit{ response }` 直接给出应答（如缓存命中、mock、guard 拦截），此时跳过 S4–S8 直达 S9；
- 插件可设置 `ctx.state.<key>` 供后续阶段读取；
- 插件抛异常默认**不阻断**请求（记 metric + warning），可在注册时声明 `fatal: true` 改变；
- 单个插件超时（默认 5s，可配）视为失败并按上述策略处理。

### S4 Encode（canonical → provider）

由 `provider_format` 对应的 codec 执行。**非 fast path** 时：

- 按 [10-canonical-schema.md](./10-canonical-schema.md) 的字段映射表逐字段转换；
- 目标格式不支持的 canonical 能力 → 按 `loss_policy` 三档处置（默认 `allow`，可全局/按 key/按请求覆盖）：
  - `allow`：丢弃 + 记一条 `ConversionDiagnostic{level:"warning"}`（进 `degraded[]` 与 `warnings`）；
  - `safe`：丢弃 warning 级，但遇 `level:"error"` 的诊断立即返回 `capability_unsupported`（该特性完全未生效，不能让客户端以为生效了）；
  - `strict`：任何诊断都返回 `capability_unsupported`；
  - `emulate`（特殊档，仅内置搜索等少数能力）：由网关自身补齐，见 [50-builtin-search.md](./50-builtin-search.md)；
- **转换诊断是一等公民**：`code` / `field_path` / `from` / `to` / `level` / `message` 六元组，最终进响应信封的 `degraded[]` 与 `RequestTrace`。**不允许只打日志不上报**——静默丢参数比失败更危险（OpenRouter 的 `require_parameters`、NewAPI relaykit 的 `ConversionDiagnostic` 是同一立场，见 [00-overview.md](./00-overview.md) §7.0.2 与 §1.3）；
- **`conversion_chain`**：记录本次请求实际走过的格式链（如 `["openai.chat","anthropic.messages"]`），进 `RequestTrace`，直接回答"这个请求到底被转成了什么"；
- 反向 passthrough：canonical 的 `raw.unmapped` 若带 `source_format == provider_format`，则原样写回请求体（同一格式互转时的无损保证）。

### S5 Upstream

- 连接池 + HTTP/2（ Gemini / OpenAI 均支持）；`keep-alive` 默认开。
- **重试策略**：仅对可重试错误重试（网络错误、5xx、429、`overloaded`），同 attempt 内最多 `max_retries`（默认 2）次，指数退避 + jitter。
- **fallback**：当前 attempt 的可重试错误用尽后，切到 `attempt_plan` 的下一个 attempt，重跑 S4→S8（canonical 不变，只换 provider）。
- **流式**：上游 SSE 一旦开始出字节，就不再 fallback（无法回退已发出的字节）；因此 fallback 决策点前移到"收到响应头"这一刻。
- 超时：首字节超时（TTFB，默认 30s）+ 整体 deadline；流式下整体 deadline 指"最后一个字节"。
- **流式空闲超时（`responseIdleTimeout`）**：默认 120s。专门杀"发了首块后静默"的流——这种流用 TTFB 超时和整体 deadline 都杀不掉，而客户端已经收到 200 + 首块，看到的是**截断的流而不是错误码**。杀流时必须：① 关闭上游连接；② 向客户端发一个 `error` 帧（`upstream_timeout`，`fatal: true`）而不是静默断开；③ 在 `RequestTrace` 记 `stream_truncated`。
- **不跟随 redirect**：3xx 作为 provider error 返回，避免把 prompt 和 provider 凭据头转发到别的端点（借鉴 llmshim）。

### S6 ProviderDecode（provider → canonical）

- 非流式：整体解析为 `CanonicalResponse`。
- 流式：转换为 `CanonicalStreamEvent` 序列：

```typescript
type CanonicalStreamEvent =
  | { type: "start"; message: MessageMeta }              // id, model, role
  | { type: "part.begin"; index: number; part: Part }
  | { type: "part.delta"; index: number; delta: PartDelta } // text / thinking / tool_input_json / ...
  | { type: "part.end"; index: number; part: Part }        // 完整 part（tool_use 在此成型）
  | { type: "usage"; usage: CanonicalUsage }               // 可能多次，取最后一次
  | { type: "finish"; finish_reason: NormalizedFinishReason; usage: CanonicalUsage }
  | { type: "error"; error: CanonicalError };
```

各 provider 的原生流事件如何折叠进这 7 种事件，是 codec 的核心工作：

| 原生事件 | canonical 事件 |
|---|---|
| OpenAI Chat `chunk.choices[0].delta.content` | `part.delta{type:"text"}` |
| OpenAI Chat `chunk.choices[0].delta.tool_calls[]` | `part.begin` + 多次 `part.delta{type:"tool_input_json"}` + `part.end` |
| OpenAI Responses `response.output_text.delta` | `part.delta{type:"text"}` |
| OpenAI Responses `response.function_call_arguments.delta` | `part.delta{type:"tool_input_json"}` |
| OpenAI Responses `response.reasoning_summary_text.delta` | `part.delta{type:"thinking"}` |
| Anthropic `content_block_start{type:"tool_use"}` | `part.begin{type:"tool_use"}` |
| Anthropic `content_block_delta{input_json_delta}` | `part.delta{type:"tool_input_json"}` |
| Anthropic `message_delta{stop_reason,usage}` | `finish` |
| Gemini `candidates[].content.parts[].text` | `part.delta{type:"text"}` |
| Gemini `candidates[].content.parts[].functionCall` | `part.end{type:"tool_use"}`（整块到达） |
| Gemini `usageMetadata` | `usage`（末次为准） |

**待验证**：Gemini `streamGenerateContent?alt=sse` 是否每个 chunk 都带完整 `usageMetadata`（影响去重策略）；OpenAI Responses 的 `response.output_item.added` 对 `function_call` 是否已带 `name`（影响 `part.begin` 能否提前发出）。

### S7 onStreamChunk

- 插件签名 `(event, ctx) => event | event[] | null`，`null` = 丢弃该事件；
- 需要**全量聚合**的插件（如计费前的 usage 规整、内容审核）声明 `needs: "aggregate"`，Runner 会给它一个"聚合视图"（内部维护完整 `CanonicalResponse`），但仍以流式向下游转发——即"旁路聚合，不阻塞"；
- 插件可注入合成事件（如搜索工具执行完后插入一个 `part.end{type:"tool_result"}`，见 [50-builtin-search.md](./50-builtin-search.md)）。

### S8 ClientEncode（canonical → client format）

- 非流式：`CanonicalResponse` → 客户端格式响应体。
- 流式：`CanonicalStreamEvent` → 客户端格式的 SSE 事件序列，按 [10-canonical-schema.md](./10-canonical-schema.md) 的映射表反向执行。
- **关键约束**：一旦向客户端写出第一个字节，就不能再改变 HTTP 状态码；因此所有错误都必须在首字节前转成 200 + SSE `error` 事件或直接非 2xx。

### S9 onResponse

- 拿到最终 `CanonicalResponse`（流式下由 S7 的聚合视图提供）；
- 典型用途：敏感信息脱敏、审计落库、自定义响应头、webhook；
- 流式下本阶段在流关闭后执行，**不再影响已发出的内容**，只能做记录与副作用。

### S10 UsageEmitter

- 产出 `UsageRecord`（见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)）写入内存队列 → 批量刷到存储；
- 永不抛异常影响主链路；队列满时按 `drop_policy`（默认丢弃最旧 + 计数告警）。

## 4. Fast Path

### 4.1 判定条件

```typescript
/** 准入条件由配置/组合根在启动时计算并缓存（D-fastpath-2），
 *  运行中增删插件要失效重算——它不是每请求现场判断的。 */
const FAST_PATH_PLUGIN_ADMISSION: boolean = computePluginAdmission(); // 见 §4.2

function isFastPathEligible(ctx: RequestContext): boolean {
  return (
    ctx.client_format === ctx.provider_format &&          // 格式同一
    ctx.route.provider === referenceImplementationOf(ctx.client_format) && // 或显式声明兼容
    !ctx.state.requires_structural_change &&              // 无插件要求改写结构
    ctx.client_raw_body_available &&                      // 保留了原始字节
    FAST_PATH_PLUGIN_ADMISSION                            // 插件 manifest scope 准入（D-fastpath-2）
  );
}
```

第三条是核心：**插件有权关闭 fast path**。插件在 `onRequest` 里若改写了 canonical 中"没有 `_raw` 对应关系的部分"，或显式调用 `ctx.disableFastPath("reason")`，Runner 立即切到慢路径并记录原因（用于后续统计"多少请求因为插件/能力不支持而走了转换"）。

第五条是**静态准入**（D-fastpath-2）：manifest `scope` 在启动时算一次并缓存，不是每请求现场判断——详见 §4.2。

### 4.2 fast path 下做什么 / 不做什么

**不做**：任何结构转换、字段重命名、类型强转。请求体以上游原始字节透传（仅在必要场景做极小改写，见下）。

**请求侧惰性解码（review #8.3，作者已拍板定稿：D-fastpath-1）**：S1 只解析「信封 + 路由必需字段」（字段集合见 §3 S1），**完整 canonical 物化推迟到真正需要它的阶段**——S3 插件链 / S4 Encode / S6 ProviderDecode 的**非 fast path 分支**。长上下文的大请求体在 fast path 下不再付"完整解码成 canonical"的代价，这是"附加延迟 < 3ms p99"（[00-overview.md](./00-overview.md) §3、[70-roadmap.md](./70-roadmap.md) Phase 1 验收）能成立的前提。

**响应侧**：只抽取 usage 信封（喂 S10）并**直通原始字节**，不物化完整 canonical 响应。

**插件准入（review #8.3，作者已拍板定稿：D-fastpath-2）**：插件 manifest 声明 `scope: "envelope-only" | "full-canonical"`：

- `envelope-only`——插件只读信封 + 路由相关字段，不做内容改写；
- `full-canonical`——插件需要完整 canonical（**未声明时按此处理**，即默认最保守）。

**仅当全部已启用的请求侧插件都是 `envelope-only`（或无请求侧插件）时，本请求才允许走 fast path。**
该条件由**配置/组合根在启动时计算并缓存**（即 §4.1 的 `FAST_PATH_PLUGIN_ADMISSION`），**运行中增删插件必须失效重算**——它不是每请求现场判断的，否则每个请求都要遍历一遍插件表。

**做**（这些都是"统计口径错位修正"，也是 canonical 的主要价值之一）：

| 修正项 | 场景 | 做法 |
|---|---|---|
| `finish_reason` / `stop_reason` 别名统一 | 客户端期待 `length`，provider 给 `max_tokens` | 响应侧只改这一个字符串字段，或仅在 usage record 里记录规范化值 |
| `tool_call` / `tool_use` id 补全 | provider 不返回 id（Gemini）或客户端格式要求不同 id 形态 | 生成 `call_<ulid>`，维护 `tool_use_id → call_id` 映射供后续轮次使用 |
| usage 口径修正 | provider 的 usage 字段与客户端格式语义不一致 | 见 §4.3 |

**流式 fast path**：上游 SSE 字节**不落 canonical、不改写**，直接转发给客户端；同时旁路一个"usage 嗅探器"只解析 SSE 中的 usage 相关字段喂给 S10。这样"零延迟透传"和"计费准确"同时成立。嗅探器实现要求：

- 有字节数上限（默认 256KB/请求）与时间上限；**超限时不得把未知 token 记成 0**——对应键**省略**，并置
  `warnings += "usage_sniffer_truncated"`（与 [10-canonical-schema.md](./10-canonical-schema.md) §6.1 规则 2 的
  `usage_missing` 同一立场：**"未知"绝不用 0 表示**，否则看板会静默少报）；
- **必须解析流尾的 usage 事件**：OpenAI Chat 的 usage 只在最后一个 chunk（且需 `stream_options.include_usage: true`，
  网关在 S4 自动补上）、OpenAI Responses 在 `response.completed` 事件、Anthropic 分 `message_start` + `message_delta`
  两次到达（必须合并）、Gemini 每 chunk 都可能带（取最后一次非空）。**按字节数从流头截断会恰好漏掉 usage**——
  因此嗅探器要么保证覆盖到流尾，要么明确标 `usage_sniffer_truncated` 并让双路计量（[25-streaming.md](./25-streaming.md) §8.2）
  的自估算兜底；不得用 0 冒充"已计量"；
- 解析失败不影响转发。

### 4.3 usage 口径修正表（fast path 也要做）

同一份计费语义在不同格式里字段名不同。fast path 下**不修改响应体**（保持厂商原样），但在 `UsageRecord` 中写入规范化值。

**字段级映射表只保留一份，在 [40-provider-adaptors.md](./40-provider-adaptors.md) §2.1**（含"哪些字段无对应、如何避免双算"的四条硬不变量 §2.2c）。

> **去重说明（review #5）**：本节原来抄了一份简表，已经和 40 §2.1 漂移——例如简表写 OpenAI Chat 的 `cache_write_tokens` "无对应"，
> 而 40 §2.1 与 [docs/sources.md](../sources.md) §1.1 都确认 OpenAI Chat 有 `usage.prompt_tokens_details.cache_write_tokens`
> 及 `cache_write_tokens_details.{ttl_12h_tokens,ttl_30m_tokens}`。两处分别维护必然分叉，故删除副本，只留指针。
> fast path 的特殊之处只是"**在哪里写**"（只写 `UsageRecord`，不动响应体），不是"**写什么**"——口径以 40 §2.1 为准。

## 5. 工具调用循环（agentic loop）

### 5.1 两种循环归属

| 模式 | 触发条件 | 循环执行者 | 用途 |
|---|---|---|---|
| **客户端循环** | 默认 | 客户端 | 兼容 OpenAI/Anthropic 原生语义，网关只做格式转换 |
| **网关循环** | `ag_agentic_loop: true`（扩展字段）或客户端格式为 Responses 且带了 `tools` 且 provider 无原生工具执行 | 网关 | 内置工具（web_search、插件提供的 tool）需要在网关侧执行 |

### 5.2 网关循环状态机

```text
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
  [IDLE] ──发送请求──▶ [WAIT_MODEL] ──收到响应──▶ [COLLECT_TOOL_USE]
        │                                        │
        │                                  有 tool_use? ──否──▶ [DONE] ──▶ S9/S10
        │                                        │是
        │                                        ▼
        │                              [EXECUTE_TOOLS]（并行/串行按 tool 声明）
        │                                        │ 每个 tool_use 产出 tool_result part
        │                                        ▼
        │                              [APPEND_TURN] 把 assistant 的 tool_use parts
        │                                        │ 与 tool_result parts 追加进 canonical.messages
        │                                        ▼
        └────────────────────────────── [WAIT_MODEL]（下一轮，直至 max_turns 或无 tool_use）
```

要点：

- **暂存与回填**：模型回合的 `tool_use` part 必须先完整暂存（流式下靠 `part.end` 保证 JSON 完整），**不能**边收边执行——Anthropic 的 `input_json_delta` 是分片到达的，Gemini 的 `functionCall` 整块到达但 `args` 可能不完整。
- **id 映射**：canonical 的 `ToolUsePart.id` 是权威 id。 provider 侧若用别的 id 字段（OpenAI Responses 的 `call_id`、OpenAI Chat 的 `id`、Gemini 无 id），由 codec 在建/用时维护映射表，存于 `ctx.state.tool_id_map`。
- **`max_turns`**：默认 10，超出返回 `agentic_loop_exceeded` 并带上已有中间 canonical（写入 `ctx.state.trace`）。
- **中间数据落盘**：每一轮的 canonical request/response 摘要（不含原始大 body）写入 trace，用于计费归属与调试，见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)。
- **`parallel_tool_calls`**：OpenAI 语义是"允许一次响应里多个 tool_call"，Anthropic 对应 `tool_choice: any` + 多个 `tool_use` block。转换时需注意 Anthropic 的 `tool_choice: any` 语义强于 OpenAI 的 `parallel_tool_calls: true`（前者强制至少一个 tool_use），标 **待验证** 的边界：OpenAI `parallel_tool_calls:false` → Anthropic 无直接对应，只能靠 prompt 约束或 `tool_choice: auto` + 事后拆轮。

## 6. 控制面判断：decision 模型的消费点

> decision 模态（判断模型）的首要消费者是**网关自己**，不是终端用户。它的设计用途就是低延迟控制面。完整模态定义见 [15-modalities.md](./15-modalities.md) §6，canonical payload 见 [10-canonical-schema.md](./10-canonical-schema.md) §4.6。

### 6.1 为什么网关需要"会判断的模型"

S2 路由、S3 插件链、工具循环的 compact/escalate/stop，本质都是**判断题**："这个请求该走哪条路""该不该继续循环""这段历史还有信息量吗"。用 chat 模型做这些判断有三个问题：延迟高（要生成长文本）、成本高（输出 token 计费）、**校准差**（LLM 自评置信度与真实正确率相关性弱）。decision 模型一次前向计算返回校准概率，150–250 ms（报道值，`[待验证]`），输入计费输出免费。

### 6.2 消费点与判据

| 阶段 | 判断问题 | question type | 判据（阈值可配） |
|---|---|---|---|
| S2 路由 | 这个请求需要强推理还是轻量模型？ | `binary` × N 或 `choice` | 概率 ≥ `route.escalate_threshold`（默认 0.7）则选高能力 access path |
| S2 路由 | 该请求是否可能超上下文？ | `binary` | 概率 ≥ 0.5 则预选更大窗口的 provider |
| S3 插件链 | 这段历史该压缩了吗？ | `scale` | 低于 `compaction.quality_floor`（默认 3/5）则触发压缩插件 |
| S0 策略检查 | 该请求是否触碰某条策略？ | `binary` + `rubric` | **不降级**（见 §6.4）；概率 ≥ 阈值则拒绝 |
| 工具循环 | 下一步该调哪个工具？ | `choice` | 取概率最高的工具 |
| 工具循环 | 该继续循环、升级模型、还是停止？ | `choice` | 映射到 `continue` / `escalate` / `stop` |
| 工具循环 | 已累积的结果足够回答了吗？ | `binary` | 概率 ≥ `loop.satisfied_threshold`（默认 0.8）则退出循环 |
| S4 编码前 | 这次转换可能丢关键字段吗？ | `binary` | 概率 ≥ 0.5 则提高 `loss_policy` 到 `safe` |

### 6.3 攒批：一次请求问完所有问题

**decision 的批量几乎是免费的**：Gemini 官方数据 1→100 题延迟近乎持平（150–250 ms e2e / 50–100 ms compute，测量条件为 16K tokens 内的多模态输入）；TypeSafe 实测 13 问合并 1 次调用 = 13 次单独调用的 **1/12.2 成本、1/11.8 时间，且答案不变**。根因是**共享 input 只计一次 token**，每问只追加自身 instructions/criteria。

**因此控制面判断必须攒批**：S2/S3/工具循环里把所有待判断问题（路由、压缩触发、工具选择、是否继续循环…）合并成**一次** `kind:"decision"` 子请求，而不是一个判断发一次。

约束：

- 单次问题数受上游上限约束（Gemini 1–1000、OpenAI 1–400、Jev 无独立上限但受 context 约束）——超限时按优先级截断，低优先级问题退回启发式；
- 攒批会引入少量延迟（等问题就绪），用"就绪即发 + 短窗口合并"（默认 5 ms）平衡；
- 批内某题失败不影响其他题（OpenAI 的逐题 `refusal` 语义），canonical 已按"部分答案"建模（见 [10-canonical-schema.md](./10-canonical-schema.md) §4.6）。

**上游选型对攒批的影响（重要）**：

- **只有 OpenAI Decisions 支持 prompt caching**（隐式 breakpoint + ≥1024 token 可复用前缀；cache read 打折、cache write 计费）。Gemini 明确 "doesn't support context caching… Repeated input across requests counts in full"，Jev 无。
- 因此"同一 state 反复问不同问题"的热点路径上，**OpenAI Decisions 的 TCO 显著优于 Gemini/Jev**——这是选上游时容易被忽略的一维。
- 反向说：如果判断的 `content` 每次都不同（大多数场景），缓存无收益，Gemini 的免费层与更低的 ECE 更划算。

### 6.4 与 fast path 的关系

**decision 判断本身也走 fast path 判定**：如果客户端请求 `kind:"decision"` 且上游就是 decision 格式，透传；否则过 canonical。判断类请求通常很小（一个问题 + 少量内容），fast path 的收益不如 chat 明显，但机制一致。

**decision 不参与"客户端请求的 fast path"**——它是网关内部发起的子请求，用独立的 `request_id`（`req_` 前缀 + `_dec` 后缀）与独立的预算桶，避免污染用户的 usage 记录。子请求的计量进 `UsageRecord.control_plane_cost`（与 `compaction` 同级，都不算进用户 `input_tokens`）。

### 6.5 降级与"不降级"的边界

**决策**：路由/工具选择/循环控制**可以**降级到 chat 模拟；**策略检查与 stop 决策不可以**。

**理由**：前者降级的代价是"选错了路"（可恢复，下一次就修正）；后者降级的代价是"该拦的没拦"或"该停的没停"（不可恢复或代价高）。校准性差在后者的影响是单向的——只会更危险，不会更安全。

**实现**：`DecisionDegradationPolicy.allow_degrade_high_stakes` 默认 `false`（见 [40-provider-adaptors.md](./40-provider-adaptors.md) §6.3）。降级时必须满足：① 响应带 `calibration: "degraded"`；② `warnings` 说明原因与替代模型；③ 高风险判断拿不到真 decision 时**明确失败**，不静默用 chat 顶替。

### 6.6 待验证

1. decision 子请求的延迟（150–250 ms 是报道值）是否可接受——它加在 S2/S3 的关键路径上，需要实测；不可接受则改为"仅对低置信度请求触发判断"（两段式：先用廉价启发式，不确定再问 decision）。
2. decision 上游不可用时的降级是否要按"请求类型"区分（见 §6.4）。
3. `control_plane_cost` 是否要进 dog-fooding 的默认查询维度（建议进，否则看不到"网关自己想花了多少钱"）。
4. 攒批窗口（默认 5 ms）与"就绪即发"的取舍——窗口越长批量越省，但 S2 关键路径延迟越高。
5. 校准性数据目前来自 Google 自评 launch eval、Artificial Analysis 转载与 TypeSafe 自家 cookbook，**均非独立第三方**；且 AIHubMix 明确警告"更低的聚合 ECE 不等于你的工具路由器有了可用阈值"。上线前应在我们自己的判断任务上抽样校准（特别是 compact/escalate/stop 三类）。
6. 配额不可静态推导：Gemini 有公开分层表，Jev 只在 console 可见（tokens/s + requests/s），OpenAI 无 Decisions 专属表。限流器需"静态表 + 运行时 429 探测"混合策略。

## 7. 错误模型

### 7.1 Canonical 错误

```typescript
interface CanonicalError {
  code: CanonicalErrorCode;
  message: string;                 // 面向客户端，可安全展示
  provider_code?: string;          // 上游原始错误码
  http_status: number;             // 建议返回给客户端的状态码
  retryable: boolean;
  field_path?: string;             // 解码/校验错误定位
  request_id: string;
  raw?: unknown;                   // 上游错误体（内部日志用，默认不回给客户端）
}

type CanonicalErrorCode =
  | "unsupported_format" | "canonical_decode_error" | "canonical_encode_error"
  | "auth_failed" | "rate_limited" | "quota_exceeded"
  | "no_available_provider" | "provider_unavailable" | "upstream_timeout"
  | "upstream_error" | "content_filtered"
  | "capability_unsupported" | "context_length_exceeded"
  | "agentic_loop_exceeded" | "plugin_error" | "internal_error";
```

### 7.2 映射到客户端格式

| canonical | OpenAI Chat/Responses | Anthropic | Gemini |
|---|---|---|---|
| `http_status` + `error.message` | `{ "error": { message, type, code } }` | `{ "type":"error", "error":{ type, message } }` | `{ "error": { code, message, status } }` |
| `retryable` | 体现在 `type`（`rate_limit_error`/`server_error`）与状态码 | 体现在 `type`（`overloaded_error`/`api_error`） | 体现在 `code`（`RESOURCE_EXHAUSTED`/`UNAVAILABLE`） |

错误体由客户端格式 codec 生成，**不**直接透传上游错误体（避免泄漏内部 provider 名/内部 IP；需要透传时走 `raw` 并受 `debug_mode` 开关控制）。

### 7.3 重试 / fallback 决策矩阵

| 上游表现 | 同 attempt 重试 | fallback 到下个 provider | 备注 |
|---|---|---|---|
| 连接失败 / DNS | ✅（≤2） | ✅ | |
| 429 | ✅（遵守 `retry-after`） | ✅ | |
| 500 / 502 / 503 | ✅ | ✅ | |
| `overloaded_error`（Anthropic） | ✅ | ✅ | |
| 超时（TTFB） | ✅ | ✅ | |
| 流式中途断开 | ❌ | ❌ | 已出字节，不可回退 |
| 400 参数错误 | ❌ | ❌ | 重试无意义，直接映射为客户端 400 |
| 401 / 403 | ❌ | ✅ | 换 key/provider 可能恢复 |
| `context_length_exceeded` | ❌ | ✅ | 换更大上下文的 provider |
| `content_filtered` | ❌ | ✅ | 可配置 |

**`capability_rejected` 错误标记约定**：上游因"请求超出上下文窗口"而 400 时，网关在返回给客户端的错误体里加一个机器可读标记 `capability_rejected: "prompt_too_long"`，让客户端（如 Claude Code 一类 agent）能识别并触发压缩重试，而不是当成普通参数错误。**这是 agentgateway 已被验证的约定**（[Messages 文档](https://agentgateway.dev/docs/standalone/latest/documentation/llm/api-types/messages)），直接沿用。只对 HTTP 400 + 明确的上下文超限语义加，**不**对所有 400 加。

## 8. 可观测性

每个请求产出 `RequestTrace`：

```typescript
interface RequestTrace {
  request_id: string;
  client_format: FormatId;
  provider_format: FormatId;
  fast_path: boolean;
  attempts: Array<{ provider: string; model: string; status: number; ttfb_ms: number; total_ms: number; error?: string }>;
  stages: StageMetric[];          // 每阶段耗时与 payload 大小
  usage: CanonicalUsage;
  finish_reason: NormalizedFinishReason;
  plugin_log: Array<{ name: string; duration_ms: number; action: string; error?: string }>;
  dropped_capabilities: string[];
  warnings: string[];
  // 中间 canonical 摘要（用于计费归属/调试，默认只存 hash 与长度，verbose 模式存全文）
  turn_count: number;
  tool_calls: Array<{ name: string; duration_ms: number; ok: boolean }>;
}
```

`RequestTrace` 是 dog-fooding agent 的主要数据面之一，查询接口见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)。

## 9. 待验证清单

1. Gemini `streamGenerateContent?alt=sse` 的 `usageMetadata` 是否逐 chunk 重复、末 chunk 是否完整。
2. OpenAI Responses 流式中 `function_call` item 的 `name` 是否在 `output_item.added` 时即存在。
3. Anthropic 1h/5m 两种 ephemeral cache 在 `usage` 里是分字段返回还是合并到 `cache_creation_input_tokens`（影响计费拆分）。
4. 各 provider 在 fast path 下返回的 `finish_reason` 与客户端格式期望值的完整差异集合（用真实响应抽样统计）。
5. 透传原始字节时，OpenAI/Anthropic 是否允许客户端传入未知顶层字段（决定 `raw.unmapped` 回写是否安全）。
