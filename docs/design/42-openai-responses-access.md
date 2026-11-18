# 42 · OpenAI Responses 接入设计（客户端脸 + provider 脸）

> 版本：v1.0-draft ｜ 日期：2026-11-16 ｜ 状态：**draft（待 review）**
> 上游依赖：[00-overview.md](./00-overview.md) §5（术语表）、[10-canonical-schema.md](./10-canonical-schema.md) §4（chat payload）与 §9（四格式映射表）、[40-provider-adaptors.md](./40-provider-adaptors.md) §1（adaptor 契约）、[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2（四件套判据）
> **本文是设计文档，不含实现**：不动 `adaptors/`、不动 `ir/`、不动 `providers/`。所有要改代码的结论都以「实施条目」的形式列在 §4 / §5 / §6，实现线程照着打勾。
> **范围（2026-11-16 主人拍板 D1 = ②）**：客户端脸（A）与 provider 脸（B）**都要做**；网关自消费（C）不做。§1.3 因此不再是「要不要做 B」的论证，而是「B 的代价是什么、每项怎么消」。
> 本文要回答的问题来自 2026-11-16 的一次 live 实测：`POST /v1/responses` 带有效数据面 key 返回 **400 `capability_unsupported`**（原文：「客户端格式 openai.responses 没有适配 chat 模态的 adaptor。adaptor 按需写（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.0），缺失说明该组合尚未实现。」）。

---

## 0. 阅读指引

§1 把「Responses」拆成几个问题并给结论；§2 DeepSeek Responses 的核实结果（**B 的阻塞项**在这里）；§3 代码侧现状与三处文档不一致；§4 canonical 映射设计（含流式折叠表、**§4.8 B 的丢弃表**、§4.9 B 的无状态暴露）；§5 代价、三期与**六处同步清单表**；§6 连带面（85 矩阵 / 计费审计 / 管理面）；§7 可断言的验收标准；§8 拍板记录；§9 Open Questions（全局编号 Q43–Q48）。

---

## 1. 拆解：「Responses」是三个问题，不是一个

### 1.1 三个问题必须分开

| # | 问题 | 它是什么 | 动到哪里 | 用户能观察到什么 |
|---|---|---|---|---|
| A | **客户端脸**（入站 dialect） | 外部客户端用 OpenAI Responses 格式打我们的 `/v1/responses`，要 canonical 双向映射 | 新 codec `adaptors/openai-responses/` + `adaptors/index.ts` 注册 + [85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §3.1 的「入站脸」列 | 客户端不再收到 400，能拿到 Responses 形状的响应 |
| B | **provider 脸**（出站 dialect） | 上游自己有 Responses 端点，我们要把 canonical 编成那个格式打过去 | `providers/deepseek/profile.ts` + 新 access path + 能力矩阵 + 计费登记 | 上游收到的请求体是 Responses 形状而非 Chat 形状 |
| C | **网关自消费** | 内置对话 / dog-fooding 要不要用 Responses 脸对客户端说话 | [95-agent-chat.md](./95-agent-chat.md) §6.1 的模型选择 + 96 的呈现层 | 管理台内置对话的请求/响应形状 |

把 A 和 B 混成一锅是这件事最容易犯的错：它们共享同一个 `FormatId`（`openai.responses`），但**消费者、代价、验收方式全不同**。A 的消费者是外部客户端，B 的消费者是路由；A 只需要一个 codec，B 需要一整套 provider 登记。

### 1.2 四种组合与结论

| 组合 | A 客户端脸 | B provider 脸 | 代价 | 收益 | 结论 |
|---|---|---|---|---|---|
| 1 | ✅ | ❌ | 一个 codec + 夹具 + 测试 | 外部客户端能接进来；上游仍走已有的 `deepseek.openai-chat` | 不做（范围不足） |
| 2 | ✅ | ✅ | 组合 1 + 一个 DeepSeek profile 条目 + 六处登记（§5.4）+ 一张丢弃表（§4.8） | 上游请求体变成 Responses；A、B 共用同一个 codec（§1.3 第 0 条） | **✅ 主人 2026-11-16 拍板选此（D1 = ②）** |
| 3 | ❌ | ✅ | 只有 provider 侧 | 没有任何客户端能用到——纯浪费 | 不做 |
| 4 | ❌ | ❌ | 0 | 维持现状（400） | 不做（用户已经报障） |

### 1.3 B 要做：六项代价与逐项 mitigation

**先记一条能显著降低 B 代价的结构事实（第 0 条）。** adaptor 的键是 `(FormatId, ModalityKind)`（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.3），而 `openai.responses` 对 A 和 B 是**同一个 `FormatId`**——A 要的是「Responses wire ↔ canonical」，B 要的也是「Responses wire ↔ canonical」，方向相同、形状相同。provider 之间的差异（端点路径、base URL、不支持字段、模型怪癖）不进 codec，进 **`ProviderProfile`**：`di/ports.ts` 的 `ProviderProfile.endpointPath(accessPath)` / `usageFromRaw` / `builtinToolWire` 就是干这个的，而 `OpenAIChatCodec` 已经按 `ctx.route.access_path` 查 profile（见 `adaptors/openai-chat/codec.ts` 的 `profileFor`）。

**因此 B 不是「第二个 codec」，而是「同一个 codec 的第二个 profile 条目 + 六处登记」。** DeepSeek 今天已经有 `deepseek.openai-chat` 与 `deepseek.anthropic-messages` 两条 access path 共用两个 codec 的先例（`providers/deepseek/profile.ts` 的 `DEEPSEEK_ACCESS_PATHS`），B 是第三条。下面六条是 B 的真实代价，逐条给 mitigation：

| # | 代价 | mitigation（实现时必须落地，不是建议） |
|---|---|---|
| 1 | **「静默忽略」是最坏的合作方式**：DeepSeek 官方原话——不支持的参数被静默忽略、不报错。接 B 就等于让网关的丢弃也变静默 | B 自带一张**逐参数丢弃表**（§4.8），每个条目同时落到两处既有机制：① `CapabilityEntry.unsupported_fields`——`gateway-core/router.ts` 的 S2 参数预检在 `on_unsupported === "error"` 时直接 `capability_unsupported`（原话「静默丢参数比失败更危险」）；② `ConversionDiagnostic` + loss policy（`ir/diagnostic.ts` 的 `evaluate()`：`allow` 放行带诊断、`safe`/`strict` 升级为 `capability_unsupported`）。**两条路都不允许静默** |
| 2 | **每加一张 provider 脸要同步六处** | 落成一张可打勾的清单表：**§5.4**（access path 注册 / 能力矩阵条目 / `endpointPath` / 路由 alias / `BILLING_COVERAGE` / 模型级价表 resolver + 85 卡片）。实现线程照着逐条打勾，漏一项由 §7.3 的 CI 断言兜底 |
| 3 | **同一张价表**：pricing 页只有一张 token 表，Responses 是两模型的 feature 行 | B 的 access path 在 `BILLING_COVERAGE` 里登记 `as_api_table` 指向**已有的** `providers/deepseek/pricing.ts`、`official_balance` 指向已有的 `providers/deepseek/balance.ts`——**不建第二份价格数据**。计量口径默认与 chat 面一致；**若 live 验证发现两边 token 口径不同（Q47），必须在文档里写清对账方法**，那时才考虑分开记账（§5.3 边界第 2 条） |
| 4 | ~~「为了 `previous_response_id` 才做 B」这个理由不成立~~ **该理由作废**：DeepSeek 的 Responses 本来就不支持 `previous_response_id` / `conversation` / `store`，它是无状态 API | 「无状态」这个事实必须**暴露给路由层**，不许藏在 DeepSeek 的静默忽略里：客户端带 `previous_response_id` 时的明确行为见 **§4.9**（A 在入口拒 + B 的 profile 也声明不支持，双层防御） |
| 5 | **DeepSeek 的 Responses 是 OpenAI Responses 的子集**：14 个顶层参数「Not supported」+ 2 个「Ignored」+ 2 个「accepted but no effect」，其余靠静默忽略兜底 | §2.2 的表直接转成 **§4.8 的实现用丢弃清单**，逐参数列「DeepSeek 行为 / B 的行为 / 落点」。**注意订正一处计数**：本文初稿写的「17 个」不准确，精确是 **14 + 2 + 2 = 18 个不产生任何效果的参数**（§4.8 表后有明细） |
| 6 | **B 的 live 验证被 key 卡住**：现在的 DeepSeek key 已失效（`/v1/models` 401），B 是网关**主动打上游**，路径/参数错了直接 404 或 400 | B 按仓库既有的「未接真实上游」可交付状态推进（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2.1）：adaptor 接口已定 + wire codec 按官方文档实现 + scripted 传输打通链路 + 卡片状态写明「未接真实上游」。**哪些结论已是 live 验证、哪些还是按文档推断，§2.3 / §5.2 逐条标了**——不要把推断当事实写进代码注释 |

**A 与 B 的关系（实现线程容易搞错的一点）**：A 是「客户端说 Responses」，B 是「上游说 Responses」。两者可以独立成立——A 配 `deepseek.openai-chat` 上游（期一的最小闭环）也完全可用；B 则要求 A 先存在（否则没有 `openai.responses` 这个 FormatId 的 codec 可复用）。所以**期序上 A 必须在 B 之前**（§5.2）。

---

## 2. DeepSeek Responses 核实（2026-11-16，一手官方文档）

> 用户原话是「deepseek **似乎**支持 OpenAI Responses 格式」。本节把它变成可引用的事实，并明确列出**不能**算事实的部分。仓库自己的普查（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §6.2，2026-11-14）早已把 Responses 列进 DeepSeek 端点清单——本次核实与那条一致，**不是新发现**，但把「端点清单里有」细化成了「兼容性是子集」。

### 2.1 已核实（全部来自官方文档，非实测）

| 事实 | 来源 |
|---|---|
| DeepSeek 有 Responses API：路径为 `POST /responses`，`base_url` 是 DeepSeek API 根本身（**无 `/v1` 前缀**） | <https://api-docs.deepseek.com/api/create-response> |
| 两个现行模型都支持：pricing 页 FEATURES 行 `Responses API` 对 `deepseek-flash` 与 `deepseek-v4-pro` 都是 ✓ | <https://api-docs.deepseek.com/quick_start/pricing> |
| 上线时间：2026-07-31（V4-Flash「natively supports the Responses API format and is specifically adapted for Codex」）、2026-08-13（V4-Pro GA「Native support for the Responses API」） | <https://api-docs.deepseek.com/updates> |
| **无状态**：不存 response / conversation；多轮要客户端每次发全量 `input`；`store` 恒 `false` | /api/create-response 正文 |
| 流式是语义 SSE 事件，每个事件带 `event` 与单调递增 `sequence_number`；终事件是 `response.completed` / `.incomplete` / `.failed`，**没有 `data: [DONE]`**；初始事件 `usage` 为 `null`，终事件带全量 `response.usage` | <https://api-docs.deepseek.com/guides/responses_api> |
| usage 形状：`input_tokens` / `input_tokens_details.cached_tokens`（上下文缓存命中）/ `output_tokens` / `output_tokens_details.reasoning_tokens` / `total_tokens` / `output_tokens_details.safety_tokens`（DeepSeek 扩展，**已含在 `output_tokens` 内**）/ `server_tool_use{tool_search,tool_fetch,tool_image_search}` | 同上 + /api/create-response |
| `server_tool_use` 按次计数，官方原话「can be used as a basis for billing」；全为 0 时整个字段省略 | /guides/responses_api |
| 输入 item 类型：`message` / `function_call` / `function_call_output` / `custom_tool_call` / `custom_tool_call_output` / `reasoning` / `web_search_call`；**其他类型被忽略** | /api/create-response |
| `reasoning` item 只支持纯文本 `content`；`summary` 与 `encrypted_content` **不支持** | /guides/responses_api 的 Input Items 表 |
| `developer` 角色：`deepseek-flash` 当 `system`，`deepseek-v4-pro` 当 `user` | 同上 |
| 图像：`input_image`（`image_url` 或 `file_id` + `detail` ∈ low/high/original/auto）；assistant 消息里放图返回 400 | /guides/responses_api 的 Image Input |
| 工具：`function` 全支持；`custom` 只有 `{"type":"custom","name":"apply_patch"}`；`web_search` 仅 `deepseek-v4-pro`；`deepseek_web_search` / `deepseek_read_url` 不能与 `web_search` 同声明；`file_search` / `code_interpreter` / `computer_use` / `mcp` 被忽略 | 同上 + /api/create-response |
| DeepSeek 扩展参数：`safety_check{level}`、`title{enabled}` | /api/create-response |
| `reasoning.effort` 取值 `none`/`low`/`high`/`max`；`minimal` 映射到 `low`，`medium` / `xhigh` 映射到 `high`（官方明说的兼容映射） | 同上 |
| `text.format` 支持 `text` / `json_object` / `json_schema`；`verbosity` 接受但无效 | 同上 |
| `temperature` ∈ [0,2] 且思考模式无效；`top_p` 按模型与模式有硬规则；`top_logprobs` ∈ [0,20]；`tool_choice` ∈ none/auto/required/指定工具 | 同上 |

### 2.2 与 OpenAI Responses 的差异 → 对两张脸的含义

| 维度 | DeepSeek 口径 | 对客户端脸（A）的含义 | 对 provider 脸（B）的含义 |
|---|---|---|---|
| `previous_response_id` / `conversation` / `store` / `background` / `metadata` / `include` / `prompt` / `truncation` / `service_tier` / `safety_identifier` / `prompt_cache_key` / `prompt_cache_retention` / `context_management` / `stream_options` | 不支持 | 客户端脸**收下**（进 `native.openai.responses.*`）并按 §4.4 决定拒或降级 | 全部 drop + warning |
| `parallel_tool_calls` / `max_tool_calls` | 被忽略 | 收下；encode 时 drop + warning | 恒 drop |
| 不支持的参数 | **静默忽略，不报错** | 与客户端脸无关（客户端脸的两端都是我们） | 必须自建丢弃表，否则丢弃不可见 |
| `reasoning.effort` | none/low/high/max + 三个兼容映射 | canonical `ThinkingConfig.effort` 已是超集（[10-canonical-schema.md](./10-canonical-schema.md) §4.4），阈值表见 [40-provider-adaptors.md](./40-provider-adaptors.md) §3.2 | 同 |
| `text.format` | text/json_object/json_schema | 直接落 `ResponseFormat`（[10-canonical-schema.md](./10-canonical-schema.md) §4.4） | 同 |
| `reasoning` item | 纯文本 `content`，无 summary / encrypted_content | 落 `ThinkingPart`；上游没有的字段进 `_raw` | summary / encrypted_content drop + warning |
| `custom_tool_call` | 只有 `apply_patch`，`input` 是自由文本 | 落 `UnknownPart` + `_raw`（§4.4） | 只有 `apply_patch` 能过 |
| `web_search_call` | `action{type,queries,sources}` + DeepSeek 扩展 `kind`/`page`/`signature`/`error` | 引用落 `SearchResultPart`，item 本体落 `UnknownPart` + `_raw` | 仅 v4-pro |
| `server_tool_use` | 按次，可作计费依据 | 落 `usage.units` 的按次槽 + `usage_raw`（§4.6） | 同 |
| 模型差异 | `developer` 角色两模型语义不同；`web_search` 仅 v4-pro；图像仅 flash | 客户端脸不关心 | 进 `quirks[]` 与能力矩阵 |

### 2.3 未能核实的点 = **B 的阻塞项**（live 销账前，本节所有结论只是按文档的推断）

DeepSeek 的 key 已失效（`GET /v1/models` 401），以下七条**没有**变成事实。**对 A 来说它们是「待办」；对 B 来说是「阻塞项」**——A 的两端都是我们，推断错了 round-trip 测试会抓住；B 是网关**主动打上游**，路径或参数错了上游直接 404 / 400，而 round-trip 测试用的是夹具，抓不到。

> **显式标注（实现线程必读）**：§2.1 全表、§4.1 / §4.2 的映射、§4.8 的丢弃表，在下面七条销账前**全部是「按官方文档推断」**，不是「已实测」。代码注释与 `quirks[]` 里必须写清哪条是推断；`fixtures/` 里的文档样本也必须与 live 样本分开存放（§5.2 夹具段）。

阻塞等级：**P0** = 不销账就不能开 B 的实现；**P1** = 可以先实现、上线前必须销账。

1. **【P0】端点路径到底带不带 `/v1`。** 官方 API reference 写 `POST /responses`，pricing 页的 `base_url` 就是 API 根（**无 `/v1`**）；而 [providers/deepseek/profile.ts](../providers/deepseek/profile.ts) 已记录 OpenAI 兼容面的 chat 路径**没有** `/v1`。但**不能用无 key 探测定论**——我实测 `/v1/responses`、`/responses`、`/v1/chat/completions`、以及一个**故意不存在**的 `/v1/nonexistent-xyz`，**全部返回 401**：DeepSeek 的鉴权网关跑在路由之前，401 不能证明路由存在，也不能证明它不存在。**对 B 这是最致命的一条**：`endpointPath()` 写错就是每次请求 404，且错误信息指向的是我们自己的配置而不是上游。→ 只能用有效 key 打真实请求（§7.2 冒烟第 1 条），**销账前 B 的 `DEEPSEEK_RESPONSES_PATH` 只能按官方文档写 `/responses` 并在注释里标 `[待验证]`**。
2. **【P0】事件序列的完整形状。** `sequence_number` 是否严格单调、`response.output_item.added` 是否对每个 item 都发、`item.id` 与 `call_id` 的实际命名——文档只给字段语义，没给样本。B 的 `decodeStream` 要靠它折叠，猜错就会把两个 item 的增量混在一起。→ 抓 3–5 份真实样本进夹具（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.4 第 1 步「没有样本不动手」）。
3. **【P1】`web_search` 服务端工具的产出形状**：`web_search_call` item 的 `action` / `sources` / 扩展字段在流式里怎么分批到达。
4. **【P1】`server_tool_use` 的计费口径**：官方说「可作为计费依据」，但没说是按次加价还是含在 token 价里；与 [50-builtin-search.md](./50-builtin-search.md) §5 的按次口径（$0.75 / 1000 次）是否同价，要对账。
5. **【P1】`input_file` + Files API 在 Responses 面的支持范围**（文档说 user 消息里 `input_file` 带 `file_id` 可以、`file_url` 不行）；chat 面是否同样。
6. **【P1】`strict` 字段的位置**：[10-canonical-schema.md](./10-canonical-schema.md) §9.1 写 canonical `tools[].strict` → Responses `parameters.strict`；DeepSeek 的 Responses 工具参考**完全没列 `strict`**。需按 OpenAI 官方 reference 复核（§9 的 Q45）。
7. **【P1】限流配额**：Responses 面是否与 chat 面共享同一个池（pricing 页只给了模型级并发 2500 / 500）。影响 B 的限流预检要不要单独配。

### 2.4 一条反面证据及其处理

GitHub `deepseek-ai/awesome-deepseek-agent` 的 issue #245（创建于 2026-06-23，state: open，2 条评论）标题为「Feature Request: Add OpenAI Responses API Compatibility for Codex Desktop」，正文称 DeepSeek「does not yet support the `/v1/responses` endpoint」。

**处理方式：以官方 changelog 与 API reference 为准，把 #245 当作过期信息，但不在任何映射表里写「#245 已过时」。** 理由：它创建于 2026-06-23，早于 2026-07-31 的 V4-Flash「natively supports the Responses API」公告；且它诉求的可能是**带 `/v1` 前缀的路径**（§2.3 第 1 条正好没核实）。「官方文档说有」与「一条更早的社区请求说没有」并存时，正确处置是**不采信后者**，不是**反驳后者**——若将来 live 验证发现端点真的不存在，以 live 为准，§2.1 整表作废，本文的 §5.2 期三也因此有了存在意义。

---

## 3. 现状与卡点（代码侧事实，2026-11-16）

### 3.1 入站识别已经齐了，缺的只有 codec

- [gateway-core/pipeline/stages/s0-ingress.ts](../gateway-core/pipeline/stages/s0-ingress.ts) 的 `PATH_SIGNATURES` **已认** `/v1/responses` → `openai.responses`；`sniffFormat` 也已能靠「有 `input` 且无 `messages`」识别；S0 把 modality 固定为 `chat`。→ **格式识别这一层不需要改**。
- [adaptors/index.ts](../adaptors/index.ts) **故意不注册** `openai.responses`（文件头原话：「没实现的 adaptor 注册进来只会制造『看起来支持』的假象」）。S1 因此抛 `capability_unsupported`——与 live 实测的 400 一致，**这是正确行为，不是 bug**。
- `ir/format.ts` 的 `FormatId` 已有 `openai.responses`，`CHAT_FORMAT_IDS` 也含它。→ **类型层不需要改**。
- 结论：客户端脸（A）是一个**纯增量**工作，不触碰任何现有代码路径。

### 3.2 文档三处对 `openai.responses` 的状态说法互相打架（存量问题）

| 位置 | 说法 | 与代码的关系 |
|---|---|---|
| [40-provider-adaptors.md](./40-provider-adaptors.md) §5.1 表格 | `openai.responses` = **已实现（v1 目标）** | **与代码矛盾**（没注册、没 codec） |
| [85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §3.1 chat 卡片 | provider adaptor 列 = **planned** | 与代码一致 |
| [adaptors/index.ts](../adaptors/index.ts) 文件头 | 矩阵里标 planned / on-demand，不注册 | 与代码一致，但**对 [40-provider-adaptors.md](./40-provider-adaptors.md) §5.1 的描述不准确** |

按 [40-provider-adaptors.md](./40-provider-adaptors.md) §5 的三态纪律，`status:"planned"` 只允许存在于当前 Phase 的交付物清单里，「已实现」必须与代码一致。三份文档打架时读者无法判断该不该开工——**建议随本文合入把 [40-provider-adaptors.md](./40-provider-adaptors.md) §5.1 那一行改成与代码一致的状态**（D5 已授权，本次提交已改）。

### 3.3 计费强制层已经就位，且客户端脸不会碰到它

- [metering/billing-coverage.ts](../metering/billing-coverage.ts)（[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4.3）：判据是 **access path**，来源是三处**启动期**登记处的并集（`DEFAULT_ACCESS_PATHS`、能力矩阵、路由表 alias）；新缺口 → `newGaps` 红灯并点名。
- **客户端脸不新增 access path**——access path 描述的是上游（[45-credentials.md](./45-credentials.md) §3），客户端格式不进 access path。所以加 A **不会**让这层变红。这是 A 与 B 在连带面上最干脆的一条差别。
- provider 脸（B）会新增 access path：`accessPathIdForDialect` 的推导规则是 `<provider>.<dialect 点换横线>`，即 **`deepseek.openai-responses`**。若不进 `BILLING_COVERAGE` 且落进三处登记处之一 → 红灯（§6.2）。
- 已知缺口（`KNOWN_UNCOVERED`：`openai` / `openai.embeddings` / `anthropic`）与本文无关，但它们提醒一件事：**今天的红灯已经有三条**，再加一条不会有人看。

---

## 4. canonical 映射设计

### 4.1 Responses 与 Chat 的结构差异总表

| 维度 | OpenAI Chat | OpenAI Responses | canonical 落点 |
|---|---|---|---|
| 顶层入口 | `messages[]` | `input`（string 或 item 数组） | `ChatPayload.messages`（[10-canonical-schema.md](./10-canonical-schema.md) §4.1） |
| 系统提示 | `messages[{role:"system"}]` | `instructions`（string）+ system/developer 角色 message item | `ChatPayload.system[]` |
| 内容块 | `content` string 或 parts | item 内 `input_text` / `output_text` / `input_image` / `input_file` | `TextPart` / `ImagePart` / `DocumentPart` |
| 工具调用 | `assistant.tool_calls[{id, function:{name, arguments}}]` | `function_call` item `{id, call_id, name, arguments}` | `ToolUsePart` |
| 工具结果 | `{role:"tool", tool_call_id, content}` | `function_call_output` item `{call_id, output}` | `ToolResultPart` |
| 思考 | 无 | `reasoning` item（纯文本 content） | `ThinkingPart` |
| 自定义工具 | 无 | `custom_tool_call`（自由文本 input） | `UnknownPart` + `_raw`（§4.4） |
| 服务端工具记录 | 无 | `web_search_call` item | `UnknownPart` + `_raw`；引用落 `SearchResultPart` |
| 工具定义 | `tools[{type:"function", function:{name, description, parameters}}]` | `tools[{type:"function", name, description, parameters}]`——**字段不嵌套** | `CanonicalTool`（[10-canonical-schema.md](./10-canonical-schema.md) §4.3） |
| 输出上限 | `max_tokens` / `max_completion_tokens` | `max_output_tokens` | `ChatParams.max_output_tokens` |
| 输出 | `choices[0].message` | `output[]`（item 数组） | `CanonicalMessage.parts` |
| 结束 | `finish_reason` | `status` + `incomplete_details.reason` | `NormalizedFinishReason`（[10-canonical-schema.md](./10-canonical-schema.md) §9.3） |
| usage | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` + details | `CanonicalUsage`（[40-provider-adaptors.md](./40-provider-adaptors.md) §2.1） |
| 流式 | `data:` 帧 + `data: [DONE]` | 语义事件，无 `[DONE]` | `StreamFrame`（[25-streaming.md](./25-streaming.md) §2.1） |
| 状态 | 无 | `previous_response_id` / `store` / `conversation` | 不建模（§4.7） |

### 4.2 已有 canonical 概念直接承载的（不需要扩 schema）

| Responses 概念 | canonical 落点 | 依据 |
|---|---|---|
| `instructions` | `ChatPayload.system[]`（一条 `SystemBlock`） | [10-canonical-schema.md](./10-canonical-schema.md) §4.1 |
| message item 的 `role` | `CanonicalMessage.role`；`developer` 折叠进 system/user，原值进 `_raw` | [10-canonical-schema.md](./10-canonical-schema.md) §4.1 |
| `input_text` / `output_text` | `TextPart` | [10-canonical-schema.md](./10-canonical-schema.md) §4.2 |
| `input_image`（`image_url`） | `ImagePart` + `MediaRef` 的 uri 态 | [10-canonical-schema.md](./10-canonical-schema.md) §5 |
| `input_image`（`file_id`） | `ImagePart` + `file_id` 进 part 的 `_raw` | [10-canonical-schema.md](./10-canonical-schema.md) §5、§7 |
| `input_file`（`file_id`） | `DocumentPart`（`media_type` / `title`）+ `_raw` | [10-canonical-schema.md](./10-canonical-schema.md) §4.2 |
| `function_call` | `ToolUsePart`（`id` 为权威 id；`call_id` 进 `_raw`，codec 维护 id ↔ call_id 映射） | [10-canonical-schema.md](./10-canonical-schema.md) §9.4 |
| `function_call_output` | `ToolResultPart`（`tool_use_id` = `call_id`） | [10-canonical-schema.md](./10-canonical-schema.md) §9.1 |
| `reasoning` | `ThinkingPart`（`thinking` = 纯文本 content） | [10-canonical-schema.md](./10-canonical-schema.md) §4.2 |
| `tools[]`（function） | `CanonicalTool` | [10-canonical-schema.md](./10-canonical-schema.md) §4.3 |
| `tool_choice` | `ToolChoice` | [10-canonical-schema.md](./10-canonical-schema.md) §9.1 |
| `reasoning.effort` | `ThinkingConfig.effort` | [10-canonical-schema.md](./10-canonical-schema.md) §4.4、[40-provider-adaptors.md](./40-provider-adaptors.md) §3.2 |
| `text.format` | `ResponseFormat` | [10-canonical-schema.md](./10-canonical-schema.md) §4.4 |
| `temperature` / `top_p` / `max_output_tokens` / `top_logprobs` / `user` | `ChatParams` | [10-canonical-schema.md](./10-canonical-schema.md) §4.4 |
| `stream` | `StreamOptions.enabled` | [10-canonical-schema.md](./10-canonical-schema.md) §4.5 |
| usage 五槽 | `CanonicalUsage` | [40-provider-adaptors.md](./40-provider-adaptors.md) §2.1 的 OpenAI Responses 列 |
| `status` / `incomplete_details` | `NormalizedFinishReason` | [10-canonical-schema.md](./10-canonical-schema.md) §9.3 |
| 顶层未建模键 | `raw.unmapped` | [10-canonical-schema.md](./10-canonical-schema.md) §7、[12-coverage-survey.md](./12-coverage-survey.md) §3 规则 F3 |

**注意**：Responses **没有** `stop` / `frequency_penalty` / `presence_penalty` / `n` / `seed`（[10-canonical-schema.md](./10-canonical-schema.md) §9.1 已把这几行在 Responses 列写「无」）。客户端脸收到这些字段时应进 `raw.unmapped` 并记 warning，**不**造一个 canonical 字段再丢弃——那会让「客户端发了但上游没有」和「canonical 没有这个概念」混为一谈。

### 4.3 需要新增的：只有一个候选，且是加法

**唯一候选：给 `DeltaData` 的 chat 变体加一个可选字段 `tool_call_id?: string`。**

理由：Responses 的 `response.function_call_arguments.delta` 必须带 `item_id` 才能归位；并行工具调用时，只有参数增量而没有 item 标识就无法重建哪个调用属于哪个 `function_call`。[ir/stream.ts](../ir/stream.ts) 的 chat delta 现在只有 `index`（part 序号），而 part 序号不是 item 标识。

这是 [12-coverage-survey.md](./12-coverage-survey.md) §3 规则 F5 第 3 步的「新增一个可选字段」：**加法**，不改现有字段，不改联合成员，`additionalProperties: false` 不受影响，不需要 bump `ir_version`。

**不扩 schema 的替代方案**（若不想动 `ir/`）：`function_call` 的参数增量不逐帧发，等 `response.output_item.done` 一次性进 `part.end` 帧（`PartEndData` 的设计目的之一就是「流式 tool_use 靠它保证 JSON 完整」）。代价是客户端看不到工具参数的流式增量，**正确性不受损**。

→ 这是 §8 的 **D2（已确认）**。

其余全部走 `native.openai.responses.*` 与 `raw.unmapped`，**不改 schema**（F5 第 2 步「能就不扩 schema」）：`previous_response_id` / `store` / `conversation` / `include` / `background` / `metadata` / `service_tier` / `safety_identifier` / `prompt_cache_key` / `prompt_cache_retention` / `context_management` / `truncation` / `stream_options` / `max_tool_calls` / `parallel_tool_calls` / DeepSeek 的 `safety_check` / `title`。回写由 [10-canonical-schema.md](./10-canonical-schema.md) §7.2 的 reconstruct 规则保证。

### 4.4 明确暂不支持并明确报错的（不静默）

| 能力 | 客户端脸（A）的行为 | 理由 |
|---|---|---|
| `previous_response_id` / `conversation` | **拒**：`capability_unsupported`，错误文案要求客户端发全量 `input` | 网关不存上游 response 对象（[40-provider-adaptors.md](./40-provider-adaptors.md) §7.1 同款立场）。静默忽略会让请求变成「没有历史的孤轮」，**答案是错的**——这正是 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.7「默认按名拒绝」要防的事 |
| `store: true` | 收下，记诊断，不执行存储 | [40-provider-adaptors.md](./40-provider-adaptors.md) §7.1 |
| `background: true` | **拒**：`capability_unsupported` | v1 同步返回；没有异步任务模型 |
| `include` | **拒**：`capability_unsupported` | 我们不知道要 include 什么；上游也不支持 |
| `custom_tool_call` / `custom_tool_call_output` | **无损收进** canonical（`UnknownPart` + `_raw`）；encode 到不支持的格式时 drop + warning | 它的 `input` 是自由文本不是 JSON，**不明默认为是 function tool**——那会毁掉参数 |
| `web_search_call` item 回传 | **无损收进** canonical（`UnknownPart` + `_raw`）；`annotations` 的引用按 [10-canonical-schema.md](./10-canonical-schema.md) §9.2 落 `SearchResultPart` | item 本体带 DeepSeek 扩展字段，canonical 没有对应概念；引用有 |
| `file_search` / `code_interpreter` / `computer_use` / `mcp` 工具声明 | 收进 `BuiltinTool`（`raw.provider_tool_type` 记版本串，[40-provider-adaptors.md](./40-provider-adaptors.md) §2.2b）；encode 到没有该能力的上游时 drop + warning | [50-builtin-search.md](./50-builtin-search.md) §2.1 的 built-in tool 建模 |
| `item_reference` | `UnknownPart` + warning | 它是有状态引用，网关无状态 |
| 未知 item 类型 | `UnknownPart` + warning | **不允许静默忽略**——DeepSeek 上游静默忽略，我们不能（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.7） |
| `top_logprobs` 超界 | 客户端脸收下；参数校验拒（上游界 [0,20]） | [40-provider-adaptors.md](./40-provider-adaptors.md) §1.7 |

### 4.5 流式：事件模型怎么落到帧（本节的硬结论）

**结论 1：不新增帧类型、不新增 SSE 事件名。** [25-streaming.md](./25-streaming.md) §2.2 已定「事件名统一 `ag.frame`，新增模态不需要新事件名」；Responses 是 chat 模态的**新入站脸**，不是新模态——`ir/modality.ts` 的 `MODALITY_KINDS` 不动，[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2.3 的模态卡片硬校验因此不受影响。要新增的只是 [20-pipeline.md](./20-pipeline.md) §S6 的流式折叠表新加一列。

> **顺带修正两处引用**：任务描述里的「[95-agent-chat.md](./95-agent-chat.md) §6.1 五类帧」应为 **[25-streaming.md](./25-streaming.md) §2.1**（[95-agent-chat.md](./95-agent-chat.md) §6.1 是「跑 agent 的模型」）；[96-chat-ui-port.md](./96-chat-ui-port.md) §3.1 的「现有五类帧」也与 `ir/stream.ts` 的六个字面量（start / delta / end / error / usage / meta）不一致——**以代码为准**，本文一律写「帧类型」。

流式折叠表（wire 事件 → 帧）：

| Responses 事件 | 帧 | 说明 |
|---|---|---|
| `response.created` | `start` | 带 model + client_format / provider_format；此时 `usage` 为 `null`，不带 |
| `response.in_progress` | 丢弃（记 `dropped`）或 `meta` | 无新增信息 |
| `response.output_item.added`（message） | `part.begin`（`TextPart` 占位） | item_id 进 `part._raw` |
| `response.content_part.added` | `part.begin`（同 index） | |
| `response.output_text.delta` | `delta{kind:"chat", text}` | |
| `response.output_text.done` | `part.end`（完整 text） | |
| `response.output_item.added`（reasoning） | `part.begin`（`ThinkingPart`） | |
| `response.reasoning_text.delta` | `delta{kind:"chat", thinking}` | DeepSeek 只给纯文本 CoT |
| `response.reasoning_text.done` | `part.end` | |
| `response.output_item.added`（function_call） | `part.begin`（`ToolUsePart` 带 id + name，input 空） | 与 `ir/stream.ts` 处理 Anthropic `content_block_start` 同款 |
| `response.function_call_arguments.delta` | `delta{kind:"chat", tool_input_json}` + `tool_call_id`（**D2 已确认**） | 没有 item 标识时并行调用无法归位 |
| `response.function_call_arguments.done` | `part.end`（完整 arguments） | |
| `response.output_item.added`/`.done`（custom_tool_call） | `part.begin` / `part.end`（`UnknownPart` + `_raw`） | 不当 function |
| `response.web_search_call.in_progress` / `.searching` / `.completed` | 期二**不做**；`meta` 帧带 note 是可接受的最小实现 | 服务端工具进度；结果回流另立（[50-builtin-search.md](./50-builtin-search.md) §2.3） |
| `response.completed` | `usage`（`response.usage`）→ 然后 `end{finish_reason:"stop"}` | **无 `data: [DONE]`**；usage 在前、end 在末 |
| `response.incomplete` | `end{finish_reason:"length"｜"content_filter"}` | 由 `incomplete_details.reason` 定 |
| `response.failed` | `error{fatal:true}` | 带 `response.error{code,message}`；**这是 HTTP 200**，不能按状态码当成功 |

**结论 2：`native_event_names` 必须按客户端格式取表。** [10-canonical-schema.md](./10-canonical-schema.md) §4.5 的 `StreamOptions.native_event_names` 现在只有一个布尔；Responses 客户端要的原生事件名是 `response.output_text.delta` 这一套，与 Chat 的 `message` / `content.delta` 完全不同。实现上把它从布尔改成「按 `client_format` 查事件名表」（表放在 codec 里，`AdaptorMeta` 不加字段）——**这是实施条目，不是 schema 变更**。

**结论 3：SSE 私有协议不扩展，但边界要写清。** 我们对客户端暴露的是 `ag.frame` + JSON 帧体（[25-streaming.md](./25-streaming.md) §2.2）；严格按 OpenAI 事件名解析的客户端走 `native_event_names`。**不存在「把 Responses 事件原样转给客户端」的第三条路**——那等于绕过 canonical，违反 always-canonical（[20-pipeline.md](./20-pipeline.md) §4）。

### 4.6 usage 与 finish_reason

- [40-provider-adaptors.md](./40-provider-adaptors.md) §2.1 的 OpenAI Responses 列已齐（`input_tokens` / `input_tokens_details.cached_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens` / `total_tokens`）。**要补三行**：
  1. `output_tokens_details.safety_tokens`（DeepSeek 扩展）→ **不加**进 `reasoning_tokens`、也不加进 `output_tokens`（官方明说已含在 `output_tokens` 内）→ 只进 `usage_raw` 与 `details`，并按 [40-provider-adaptors.md](./40-provider-adaptors.md) §2.2 的双算风险表记一行。
  2. `input_tokens_details.cached_tokens` 在 DeepSeek 的语义 = kv cache 命中（/guides/kv_cache），与 chat 面顶层 `prompt_cache_hit_tokens` **同义不同位** → 同一张归一表的两个来源，映射表各写一行。
  3. `server_tool_use{tool_search, tool_fetch, tool_image_search}` → **按次单位，不是 token** → 落 `usage.units` 的按次槽 + `usage_raw`（[40-provider-adaptors.md](./40-provider-adaptors.md) §2.1 的「server tool 用量」行；[50-builtin-search.md](./50-builtin-search.md) §5 的按次计费口径要能表达它）。
- 双算风险按 [40-provider-adaptors.md](./40-provider-adaptors.md) §2.2c 的 I3 办：流式一律重算 `total`，与上游原值不一致时记 warning。
- `finish_reason` 用 [10-canonical-schema.md](./10-canonical-schema.md) §9.3 的 Responses 列（`status:"completed"` → stop；`incomplete_details.reason` → length / content_filter；`status:"failed"` → error），并照「注意 2」办：未命中落 `other` + `warnings += "unmapped_finish_reason:<原文>"`，**不默认 stop**。

### 4.7 有状态参数与「网关无状态」立场

[40-provider-adaptors.md](./40-provider-adaptors.md) §7.1 已定：网关默认不依赖上游状态，始终发全量历史、把 `store` 关掉（除非客户端显式要）。客户端脸沿用同一条：`previous_response_id` / `conversation` 显式拒（§4.4），`store` 收下不执行。B 的无状态暴露见 §4.9。

### 4.8 B 的丢弃表（实现用，逐参数）

**这是 §2.2 的原料转成的实现清单。** 字段名沿用 `providers/deepseek/profile.ts` 既有约定（canonical 点分路径，如 `params.response_format.json_schema` / `cache_control` / `parts.search_result`）。每个条目的「落点」是两处既有机制，不是新发明：① `CapabilityEntry.unsupported_fields`（S2 参数预检的输入，`on_unsupported === "error"` 时直接 `capability_unsupported`）；② codec 的 `EncodedRequest.dropped[]` / `warnings[]` / `diagnostics`（`ir/diagnostic.ts` 的 `ConversionDiagnostic`，loss policy 决定放行还是升级为错误）。

**订正一处计数**：本文初稿写的「17 个不支持的顶层参数」不准确。按官方兼容性表精确数是 **14 个 `Not supported` + 2 个 `Ignored` + 2 个 `accepted but no effect` = 18 个顶层参数不产生任何效果**，明细如下。

#### 4.8.1 顶层请求参数（18 个）

| 参数 | DeepSeek 行为 | B 的行为 | 落点 |
|---|---|---|---|
| `previous_response_id` | Not supported | drop + warning（A 已在入口拒，双层防御见 §4.9） | `unsupported_fields` + `dropped[]` |
| `conversation` | Not supported | 同上 | 同上 |
| `store` | Not supported（响应恒带 `store:false`） | drop + warning | 同上 |
| `background` | Not supported | drop + warning（A 已拒） | 同上 |
| `metadata` | Not supported | drop + warning | 同上 |
| `include` | Not supported | drop + warning（A 已拒） | 同上 |
| `prompt` | Not supported | drop + warning | 同上 |
| `truncation` | Not supported；**超窗返回 400 而不是截断** | drop + warning，**且 warning 必须点明「上游超窗会 400，不会自动截断」**——客户端以为有截断保护，实际没有，这是会静默改变行为的丢弃 | 同上 + 该 warning 文案写进 `quirks[]` |
| `service_tier` | Not supported | drop + warning | 同上 |
| `safety_identifier` | Not supported | drop + warning | 同上 |
| `prompt_cache_key` | Not supported（缓存全自动） | drop + warning | 同上 |
| `prompt_cache_retention` | Not supported | drop + warning | 同上 |
| `context_management` | Not supported | drop + warning（压缩是插件职责，见 [30-plugin-api.md](./30-plugin-api.md) §4） | 同上 |
| `stream_options` | Not supported | drop + warning——但注意 **usage 恒带**（终事件 `response.completed` 的 `response.usage`），所以 `include_usage` 类诉求自动满足，warning 文案要说明这一点 | 同上 |
| `parallel_tool_calls` | Ignored（**并行工具调用恒开启**） | drop + warning，**且 warning 必须点明「客户端要求不并行时上游仍可能并行返回多个 function_call」**——这是语义风险不是功能缺失 | 同上 |
| `max_tool_calls` | Ignored | drop + warning | 同上 |
| `text.verbosity` | accepted but no effect | drop + warning | 同上 |
| `reasoning.summary` | accepted but **no summary is generated** | drop + warning，**且 warning 必须点明「客户端要思考摘要，上游不生成」** | 同上 |

#### 4.8.2 值映射（不是丢弃，但必须声明用了哪一档）

| 项 | DeepSeek 行为 | B 的行为 |
|---|---|---|
| `reasoning.effort` = `minimal` | 映射到 `low` | 按官方映射表转 + warning `reasoning_effort_mapped:minimal→low` |
| `reasoning.effort` = `medium` / `xhigh` | 映射到 `high` | 同上 |
| `developer` 角色 | `deepseek-flash` 当 `system`，`deepseek-v4-pro` 当 `user` | 按目标模型选一个 + warning（**两个模型语义相反，是 B 特有的坑**） |

#### 4.8.3 工具声明（按类型 / 按模型）

| 项 | DeepSeek 行为 | B 的行为 |
|---|---|---|
| `tools[].type = "function"` | 支持 | 正常映射 |
| `tools[].type = "custom"` 且 `name !== "apply_patch"` | **返回 400** | **拒**（不是 drop）：drop 会让模型少一个工具而不报错，400 是我们自己造成的 |
| `tools[].type = "custom"` 且 `name === "apply_patch"` | 支持 | 正常映射；`input` 是自由文本，按 §4.4 落 `UnknownPart` + `_raw` |
| `tools[].type = "web_search"` 且模型是 `deepseek-v4-pro` | 支持（服务端执行） | 正常映射，落 `BuiltinTool` |
| `tools[].type = "web_search"` 且模型是 `deepseek-flash` | **Ignored** | drop + warning（按模型判，进该模型的能力矩阵条目） |
| `deepseek_web_search` / `deepseek_read_url` 与 `web_search` **同时声明** | 不支持（官方明说不能同声明） | **拒**：同声明会让上游行为不定，不能替客户端选一个 |
| `file_search` / `code_interpreter` / `computer_use` / `mcp` | Ignored | drop + warning |

#### 4.8.4 请求内容级（会造成上游 400 的，必须拒而不是 drop）

| 项 | DeepSeek 行为 | B 的行为 |
|---|---|---|
| `assistant` 消息里出现 `input_image` | **返回 400** | **拒**：在 encode 前检查，报 `capability_unsupported` 并说明「图片只能出现在 user / system / developer 消息与工具输出里」 |
| `input_image` 同时给 `image_url` 与 `file_id`，或两者都不给 | **返回 400** | **拒**（同上，参数校验前移） |

**丢弃表的落地位置（实现线程照此放，不要另起一处）**：

- 逐参数清单 → 该 access path + model 的 `CapabilityEntry.unsupported_fields`（与 `deepseek.openai-chat` 的同名字段同格式）；
- 「drop 会静默改变行为」的三个特例（`truncation` / `parallel_tool_calls` / `reasoning.summary`）→ 同时写进 `quirks[]`，因为它们不是「不支持」而是「支持但不生效」，`unsupported_fields` 表达不了这层语义；
- 编码期的实际丢弃 → codec 的 `dropped[]` / `warnings[]` / `diagnostics`，由 loss policy 决定是否升级为 `capability_unsupported`；
- `AdaptorMeta.unsupported_fields` 与 `quirks[]` 同步填（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.6 检查清单）。

### 4.9 B 的无状态暴露：`previous_response_id` 们走 B 时的明确行为

**事实**：DeepSeek 的 Responses 是**无状态** API——不存 response / conversation，响应恒带 `store:false`，`previous_response_id` / `conversation` / `store` 一律不支持（§2.1 / §2.2）。网关自己也**不存上游 response 对象**（[40-provider-adaptors.md](./40-provider-adaptors.md) §7.1）。

**因此规则：无状态这个事实必须暴露给路由层，不许藏在 DeepSeek 的静默忽略里。** 分两层，两层都要有：

| 客户端带的参数 | A（入口，S0/S1） | B（profile + 能力矩阵） | 客户端看到什么 |
|---|---|---|---|
| `previous_response_id` | **拒** `capability_unsupported` | 登记进 `unsupported_fields` | 400 + 「网关不保存上游 response 对象，请发送完整 `input`」 |
| `conversation` | **拒** | 登记进 `unsupported_fields` | 同上 |
| `store: true` | 收下 + 记诊断，不执行存储 | 登记进 `unsupported_fields`（上游恒 `false`） | 200 + `warnings` 含 `store_unsupported` |
| `background: true` | **拒** | 登记进 `unsupported_fields` | 400 |
| `include` | **拒** | 登记进 `unsupported_fields` | 400 |

**为什么 B 侧还要再登记一遍（A 已经拒了）**：

1. **双层防御**：A 的拒绝是将来的策略，可能被放宽（例如网关自己实现 response 存储来兑现 `previous_response_id`——那是另一个 feature，不在本文范围）。放宽的那一刻，路由层必须已经有明确答案，而不是退回 DeepSeek 的静默忽略。
2. **`unsupported_fields` 是 S2 参数预检的输入**：登记了才能在 `on_unsupported: "error"` 时拒；不登记，`on_unsupported: "allow"` 的部署就会静默丢。
3. **`CapabilityEntry` 是路由的依据**（[45-credentials.md](./45-credentials.md) §6）：不登记，「这条路支持什么」就查不到。

**明确不允许的行为**：把 `previous_response_id` 静默丢掉、然后把请求当成普通首轮发出去。那会给出一个**没有历史的答案**，而客户端以为历史在——错误且不可察觉。这正是 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.7「默认按名拒绝」要防的事。

---

## 5. 代价与分期

### 5.1 三态判定：A 与 B 都是 planned

[40-provider-adaptors.md](./40-provider-adaptors.md) §5 的纪律是：`status:"planned"` 只允许存在于**当前 Phase 的交付物清单**里。判据不是「重不重要」，而是「这个 Phase 交付不交付」。

主人 2026-11-16 拍板 D1 = ②，A 与 B **都进当前 Phase**，因此两者都标 **planned**：

- **A 客户端脸 → planned**（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §5.2 的 P1 表）。消费者已经存在（live 实测有客户端在打 `/v1/responses`；管理面 dialect 下拉已经有这一项，§6.3）。
- **B provider 脸 → planned**（同表新增一行）。主人原话「我要求的其实是 B，但是 A 也要支持」——B 是主要诉求，A 是让 B 可被客户端使用的必要前置（§1.3 末段：没有 A 就没有 `openai.responses` 这个 FormatId 的 codec 可复用）。

**「未接真实上游」是一种合法交付状态**（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2.1），B 按期推进时按该状态标注：adaptor 接口已定 + wire codec 按官方文档实现 + scripted 传输打通链路 + 卡片写明「未接真实上游」。仓库对 image / embedding / decision 三个模态都是这么做的，B 不是特例。

### 5.2 分期（A / B 两条线，附「live 已验证 vs 按文档推断」标注）

> **D4（已确认）**：期一现在进，夹具先用官方文档样本；B 的 live 冒烟等有效 DeepSeek key。
> **每一行都标了验证状态**：`[live]` = 已有实测支撑；`[doc]` = 按官方文档推断，等 key 销账；`[fixture]` = 本地夹具可验，不依赖上游。

| 期 | A 客户端脸 | B provider 脸 | 怎么验 |
|---|---|---|---|
| **期一 · 非流式往返** | `adaptors/openai-responses/` codec（`decode` / `encode` / `decodeResponse` / `encodeResponse` / `extractUsage` / `normalizeFinishReason` + 可选 `decodeEnvelope`，**D2 已确认：`DeltaData` chat 变体加可选 `tool_call_id`**）；`adaptors/index.ts` 注册；`AdaptorMeta{status:"implemented", fixtures:"adaptors/fixtures/openai-responses/"}` | 不适用（B 复用 A 的 codec，期一不动 provider 侧） | `[fixture]` [40-provider-adaptors.md](./40-provider-adaptors.md) §1.5 的 6 条 adaptor 测试 + schema 层用例（[12-coverage-survey.md](./12-coverage-survey.md) §3 规则 F6）全绿；`[fixture]` `tests/models-openai-sdk.test.ts` 同姿势加「用官方 OpenAI SDK 打我们的 `/v1/responses`」的 drop-in 用例（85 §2.1 的入站脸验收方式）——**这一条不碰上游，现在就能验** |
| **期二 · 流式 + B 的 provider 侧** | `decodeStream` / `encodeStream` + 20 §S6 折叠表新列 + D2 落地；工具循环（20 §5）跑通（`function_call` → `function_call_output` 回传） | `providers/deepseek/profile.ts` 加 `DEEPSEEK_ACCESS_PATHS.openaiResponses` + `endpointPath` + 能力矩阵条目（含 §4.8 丢弃表）+ 路由 alias；**六处同步清单见 §5.4** | A：`[fixture]` `response.stream.sse.txt` 夹具的「流式事件序列等价」断言（40 §1.5 第 6 条）+ 多轮工具循环 round-trip + `native_event_names` 双向表用例。B：`[fixture]` scripted 传输打通链路 + 丢弃表的单测（每个 `unsupported_fields` 条目一个用例：给定请求 → 断言 `dropped[]`/`warnings[]`/`diagnostics` 有点名）+ `on_unsupported:"error"` 时拒的用例；**`[doc]`  wire 形状按官方文档，未经 live** |
| **期三 · live 冒烟** | A 的端到端（客户端 → 网关 → 真实上游） | B 的真实上游：`endpointPath`、事件序列、丢弃表逐条对真上游 | `[live]` §7.2 的十条冒烟条目；**全部依赖有效 DeepSeek key**（现在的 key 已失效，`/v1/models` 401）。**key 不到，期三不做，B 保持「未接真实上游」状态** |

**夹具的位置与来源**：`adaptors/fixtures/openai-responses/`（与 `openai-chat` / `anthropic-messages` 同构），**内部分两个子目录**：

- `from-docs/`——期一/期二用：DeepSeek Responses 官方文档的请求/响应样例 + OpenAI SDK 类型构造 3–5 份（含流式、含工具、含多 system、含未知顶层键）。文件头注释必须写 `来源：官方文档，未经 live 验证`。
- `from-live/`——期三用：key 到手后抓的真样本，**换进来后重跑全部断言**；两份都过同一套断言，差异就是 §2.3 的销账结果。

这是 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.4 第 1 步「没有样本不动手」的合规读法——期一的样本是**文档样本**，期三替换成**真样本**；仓库对 image / embedding 模态已是这个做法（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §3.3 / §3.6 的「未接真实上游，测试用 scripted 传输打通链路」）。

### 5.3 B 的范围边界（明确不做的事）

B 进来了，但**不因此**把这些拉进来——写下来是为了防止范围蔓延：

1. **不做上游状态**：不实现 `previous_response_id` / `conversation` 的服务端存储（§4.9）。网关继续「始终发全量历史」。
2. **不建第二份价格数据**：B 与 chat 面共用 `providers/deepseek/pricing.ts`（§6.2）。**例外**：若 live 验证发现两边 token 口径不同（Q47），那时按 §6.2 的路线分开记账——那是被实测推着走，不是预设。
3. **不为 B 写第二个 codec**：B 复用 A 的 `openai.responses` codec，差异全进 profile（§1.3 第 0 条）。若将来发现某个 DeepSeek Responses 专有行为无法用 profile 表达（候选：`custom_tool_call` 的自由文本 input、`web_search_call` 的扩展字段），**先尝试 `_raw` / `native.*`，仍不行再评估拆 codec**，并在 10 §10 记一条 Open Question。
4. **B 不改变 A 的客户端契约**：A 对客户端的行为（§4.4 的拒/降级）不因上游换成 B 而变。客户端不该看出上游是哪张脸——除非丢弃表不同（那时响应里的 `warnings` 会不同，这是有意的可见性）。
5. **`text.format.json_schema` 是 B 唯一确定的能力增量**：`deepseek.openai-chat` 的能力矩阵已登记 `params.response_format.json_schema` 为不支持（注释原话「json_schema 只在 Responses 面有」）。这是 B 相对 chat 面**真实存在**的能力差，值得在能力矩阵与文档里点明——但它不构成「为了它单独做 B」的理由，只是 B 落地后的附带收益。

### 5.4 六处同步清单表（实现线程照着打勾）

> 漏任何一项的后果写在「漏了会怎样」列。§7.3 的 CI 断言能抓住其中两项，其余靠打勾。

| # | 要改什么 | 具体位置 | 漏了会怎样 |
|---|---|---|---|
| 1 | **access path 注册** | `providers/deepseek/profile.ts` 的 `DEEPSEEK_ACCESS_PATHS` 加 `openaiResponses: 'deepseek.openai-responses'`；`credentials/resolver.ts` 的 `DEFAULT_ACCESS_PATHS` 加一条（`format: 'openai.responses'`、`model_namespaces`、`requires_credential: true`） | 渠道建了但路由不到——「建了渠道」到「能路由」之间缺一环，且**没有任何报错**（`credentials/resolver.ts` 文件头原话） |
| 2 | **能力矩阵条目** | `providers/deepseek/profile.ts` 的 `deepseekCapabilities()` 加 `access_path: DEEPSEEK_ACCESS_PATHS.openaiResponses` + `format: 'openai.responses'` + `unsupported_fields`（§4.8.1 全表）+ `quirks[]`（§4.8 的三个特例 + `developer` 角色两模型相反）+ `contract_tested` / `status` | 路由没有依据；§4.8 的丢弃表没有落点；S2 参数预检不工作 |
| 3 | **`endpointPath`** | `providers/deepseek/profile.ts` 的 `endpointPath(accessPath)` 为新路径返回 `DEEPSEEK_RESPONSES_PATH`（**值按官方文档先写 `/responses`，注释标 `[待验证]`，Q43 销账后定稿**） | 请求打到错路径 → 404，且错误指向我们自己的配置 |
| 4 | **路由 alias** | `providers/deepseek/profile.ts` 的路由表：给目标模型加一条指向 `DEEPSEEK_ACCESS_PATHS.openaiResponses` 的 target（或按部署策略只对部分模型开 B） | 模型永远路由不到 B，B 等于没接 |
| 5 | **`BILLING_COVERAGE`** | `metering/billing-coverage.ts` 加一条：`access_path: 'deepseek.openai-responses'`、`official_balance: 'providers/deepseek/balance.ts'`、`as_api_table: 'providers/deepseek/pricing.ts'`（**都指向已有模块，不建新价表**） | `tests/billing-coverage.test.ts` 红灯并点名 `deepseek`（§6.2） |
| 6 | **模型级价表 resolver** | `tests/billing-coverage.test.ts` 的 `PRICE_RESOLVERS` 加 `'deepseek.openai-responses'` → 与 `deepseek.openai-chat` **同一个 resolver**（同模型同价） | 模型级审计报 `no-pricing-loader` 红灯 |
| 7 | **85 矩阵卡片** | [85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §3.1 chat 卡片的「provider adaptor」列 + §5.2 的 P1 表（§6.1 给了改法） | 矩阵与代码漂移；「B 到底接没接」查不到 |
| 8 | **本文的状态同步** | 本文 §2.1 / §4.8 里标 `[待验证]` 的项，销账后改结论并升级为 `[live]` | 推断被当成事实留下来，下一个人照着错的前提实现 |

**清单之外还有一条横切要求**：B 的每条 `unsupported_fields` 与 `quirks[]` 都必须带**来源注释**（官方兼容性表的哪一行、访问日期）。没有来源的丢弃项将来无法判断是「上游真的不支持」还是「我们当初猜的」——这正是 `providers/deepseek/profile.ts` 文件头「一手来源（2026-11-14 逐页核实，全部为官方文档）」的做法。

---

## 6. 连带面

### 6.1 85 矩阵怎么改

- **[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §3.1 chat 卡片的「入站脸」列**：`POST /v1/responses`（openai.responses）**已经列着**——不用加行。要改的是把「列了但没实现」说清：建议在该单元格后加 `（期一落地）`，并在「缺口 / 优先级」列把 openai.responses 从 adaptor 缺口里挪到「已交付」。
- **同卡片的「provider adaptor」列**：现在是「**planned**：openai.responses、gemini.generateContent」。一张脸在两个方向上状态不同，矩阵要能表达——建议该单元格拆成「入站 planned（期一）／出站 planned（期二，`deepseek.openai-responses`，未接真实上游）」两短语，**不新增列**（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §1.2 定死了四列）。
- **[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §5.2 P1 表**：`openai.responses / gemini.generateContent adaptor` 那一行要拆开。gemini 缺的是 **provider 脸**，openai.responses 现在**两张脸都缺**——三者的交付物与验收方式完全不同，混在一行会让人以为是一件事。D5 已授权同步改这一行。
- **[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §6.2 调研结论表**：补一条 DeepSeek Responses 的事实行（含来源 URL 与访问日期 2026-11-16），并把现有那句「官方 API reference 的全部端点为：…Responses…」从「端点清单」升级为指向本文 §2.2 的「兼容性是子集」指针。D5 已授权。
- **[40-provider-adaptors.md](./40-provider-adaptors.md) §5.1**：`openai.responses` 行从「已实现（v1 目标）」改为「planned（当前 Phase：客户端脸 + DeepSeek provider 脸）」（§3.2 的三处不一致，D5 已授权）。
- **[15-modalities.md](./15-modalities.md) §7.1 的矩阵**：`deepseek` 行的 chat 列现在是 `[实]`；B 落地后在该行加 `+responses`。本文不改。
- **[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §3.1 的「缺口 / 优先级」行**（超出 D5 列举的第 6 处，同性质，请 review 时一并过目）：该行同样把 openai.responses 与 gemini.generateContent 混成一项，按同一条理由拆开。

### 6.2 计费覆盖审计会不会变红

- **加客户端脸：不会。** access path 描述上游（[45-credentials.md](./45-credentials.md) §3），客户端格式不进 access path；`deepseek.openai-chat` 的价表与模型清单不变；`KNOWN_UNCOVERED` 三条不受影响。建议在 `tests/billing-coverage.test.ts` 的 `realSources()` 上加一条断言把这件事钉住（§7.3）。
- **加 provider 脸：会，除非同批登记——现在 B 已定，登记是必做项而不是可选项。** 新 access path `deepseek.openai-responses`（`accessPathIdForDialect('deepseek','openai.responses')`，见 [admin/aliases.ts](../admin/aliases.ts)）必须同批做三件事，否则 `newGaps` 点名：
  1. 进 `DEFAULT_ACCESS_PATHS`（`providers/deepseek/profile.ts` 的 `DEEPSEEK_ACCESS_PATHS` 加一项）；
  2. 进 `BILLING_COVERAGE`，`official_balance` 与 `as_api_table` 都指向**已有的** `providers/deepseek/balance.ts` / `providers/deepseek/pricing.ts`——pricing 页只有一张 token 价表，Responses 是两模型的 feature 行，**不另定价、不建第二份价格数据**（§1.3 第 3 条）；
  3. `tests/billing-coverage.test.ts` 的 `PRICE_RESOLVERS` 加一条 resolver，与 `deepseek.openai-chat` **共用同一个**（同模型同价）——模型级审计按 access path 取 resolver，没有 loader 就是 `no-pricing-loader` 红灯。
- **计量口径**：默认与 chat 面一致（同一张价表、同一批模型、同一套 token 五槽）。**若 live 验证发现两边 token 口径不同（Q47），按 §5.3 边界第 2 条处理**：在文档里写清对账方法，再决定是否分开记账——不允许「先混着记，等对不上再说」。
- **一个已存在的洞（不是本文引入，但 B 会放大它）**：`auditBillingCoverage` 的 `sources` 只取三处**启动期**登记表；管理面运行时新建的渠道（`registerAccessPath`）不在其中。所以运行时新建一条 dialect 为 `openai.responses` 的 DeepSeek 渠道**今天不会红灯**——它会安静地变成一条 unpriced 路径。`metering/billing-coverage.ts` 文件头自己记了这条 TODO（「管理面建渠道时的运行时红灯…接线留待后续」）。**B 落地后这条洞从「可能被踩」变成「必然被踩」**（用户终于能在面板里选出能用的 Responses 渠道了）——建议把它从 TODO 提成 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4.3 的一条待办，优先级高于本文其他项。

### 6.3 管理面前端要不要暴露这个格式

**现状：已经暴露了。** [webui/admin/src/panels/spec.ts](../webui/admin/src/panels/spec.ts) 的 `DIALECT_OPTIONS` 已有 `{value:'openai.responses', label:'OpenAI Responses'}`，[webui/admin/src/api/types.ts](../webui/admin/src/api/types.ts) 的 `Dialect` 联合也已有它。用户今天就能在渠道面板里选 OpenAI Responses——选完得到的是 §3.1 的 `capability_unsupported`。**「看起来支持」的假象在 UI 侧已经存在，而且比 adaptor 侧的注释更早。**

三个选项（§8 的 D3，已确认选 ③）：

| 选项 | 做法 | 代价 |
|---|---|---|
| (a) 保留选项 + 错误反馈 | 面板不动；渠道建成后路由失败由后端给出「该格式的适配尚未接入」的错误反馈 | 最小；用户仍能建成一个用不了的渠道 |
| (b) 暂时移除 | 从 `DIALECT_OPTIONS` 与 `Dialect` 移除，期一落地后加回 | 两处 + 测试同步改；将来要加回来 |
| (c) 保留并标「未接入」+ 帮助深链 | 复用 presets 的「能力状态静态快照」机制，照实标「未接入」并给「查看帮助」 | 面板加一个状态位 |

**推荐 (c)**：它复用仓库已经踩过一次坑后建立的模式（`presets.ts` 文件头记的教训：写「待立项」结果按钮被 disable、用户既看不到真相也试不了），且不删类型、不制造「加回来」的二次改动。

**这个「未接入」标注是过渡态，不是终态**：A 落地（期一）后该渠道就能用于客户端脸，标注要改成反映真实能力的状态；B 落地（期二）后 `deepseek.openai-responses` 这条 access path 才真正可用，而「未接真实上游」的标注要保留到期三销账（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2.1 的合法交付状态）。**标注必须跟着代码走**——`presets.ts` 的「能力状态静态快照」不会自己变，改代码不同步改标注，就是又一次「面板说不能用、其实能用」或反过来。

**文案纪律（无论选哪个都适用）**：界面上只允许字段标签、placeholder、必要的短 tooltip、错误/成功反馈四种文字（AGENTS.md 的界面文案纪律 + `scripts/check-ui-copy.mjs`）。「OpenAI Responses」是字段标签，可以出现；**不许**出现 canonical / AG-IR / adaptor / dialect / codec / access_path 这些内部术语，也不许在界面上贴讲解段——讲解进 `webui/admin/src/pages/Help.tsx` 的对应小节并用 `helpHref('<section>')` 深链指过去。

---

## 7. 验收标准（可断言）

### 7.1 round-trip 测试（名字可断言）

期一落地时以下名字必须存在且全绿（放在 `adaptors/openai-responses/codec.test.ts`，与 openai-chat / anthropic-messages 同构）：

1. `decode → encode 幂等`
2. `same-format 字节级保真`（归一化白名单：finish_reason、tool id、usage 口径）
3. `未知字段不丢`（顶层未知键 → `raw.unmapped` → 回写）
4. `畸形 tool 参数不被销毁`（`arguments` 是非 JSON 字符串时原样回写）
5. `多 system 消息不丢`（`instructions` + system 角色 message item 共存 → `payload.system` 两条）
6. `流式事件序列等价`

外加三类：

- **schema 层**：为 [12-coverage-survey.md](./12-coverage-survey.md) §1.1 登记的 OpenAI Responses 特性各建「只含该特性」的 canonical fixture，过 ajv + JSON 序列化无损（[12-coverage-survey.md](./12-coverage-survey.md) §3 规则 F6）。
- **入站脸 drop-in**：`tests/models-openai-sdk.test.ts` 同姿势，用官方 OpenAI SDK（`client.responses.create`）打 `POST /v1/responses`，非流式 + 流式各一条（[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2.1 的入站脸验收方式）。
- **工具循环**：`function_call` → `function_call_output` 回传的 round-trip，含 `id` ↔ `call_id` 映射不断裂。

### 7.1b B 专属的验收（provider 脸）

| 断言 | 内容 | 依赖 |
|---|---|---|
| 丢弃表单测 | §4.8.1 的 18 个参数**逐个**一个用例：给定含该参数的请求 → 断言 `dropped[]` / `warnings[]` / `diagnostics` 里**点名了该参数**（不许只断言「有 warning」） | `[fixture]` 现在就能写 |
| 三个特例的 warning 文案 | `truncation` / `parallel_tool_calls` / `reasoning.summary` 的 warning 必须点明「不生效的具体后果」，断言文案含关键子串 | `[fixture]` |
| 「会造成上游 400 的必须拒」 | §4.8.4 的两项（assistant 消息里的 `input_image`、`input_image` 的 `image_url` + `file_id` 同给/都不给）→ 断言 `capability_unsupported` 而不是 drop | `[fixture]` |
| 工具类型按模型分流 | `web_search` 在 `deepseek-flash` 上 drop + warning、在 `deepseek-v4-pro` 上正常映射；`custom` 非 `apply_patch` → 拒；`deepseek_web_search` 与 `web_search` 同声明 → 拒 | `[fixture]` |
| `on_unsupported:"error"` 拒 | §4.8.1 任一条出现在请求里 → S2 预检返回 `capability_unsupported`，且消息里列出参数名（`gateway-core/router.ts` 的既有行为，B 只是把 `unsupported_fields` 填满） | `[fixture]` |
| `endpointPath` 指向 | `endpointPath('deepseek.openai-responses')` 返回 `DEEPSEEK_RESPONSES_PATH`，且与 `deepseek.openai-chat` 的 `/chat/completions` **不同**（防复制粘贴错） | `[fixture]` |
| 无状态暴露 | §4.9 表里五个参数的「B 侧行为」各一个用例：A 拒的在入口拒；`store` 的记诊断不执行 | `[fixture]` |
| 计费覆盖 | `tests/billing-coverage.test.ts` 的 `realSources()` 加上 B 的 access path 后**全绿**（§5.4 第 5/6 项的兜底） | `[fixture]` |
| live 销账 | §7.2 的十条冒烟条目，逐条把 §2.3 的 `[doc]` 升级成 `[live]` | **`[live]` 等 key** |

### 7.2 live 冒烟条目（依赖有效 key；逐条销账 §2.3 的七条阻塞项）

> **B 的 live 冒烟在有效 DeepSeek key 到手前做不了**（现在的 key 已失效，`/v1/models` 401）。**A 侧第 1 条只打我们自己的端点，不依赖上游**；「A + B 共用」与「B 侧」两组都需要真上游。
> **每条都标了它销掉哪条阻塞项**（对应 §2.3 的编号）。

**A 侧（不依赖上游，现在就能跑）**：

1. 用官方 OpenAI SDK（`client.responses.create`）打我们自己的 `POST /v1/responses`，非流式 + 流式各一次，断言 SDK 不报未知格式错误、响应可解析。

**A + B 共用（需要有效 key）**：

1. 对 DeepSeek API 根下的 `/responses` 与 `/v1/responses` 两条路径各打一次最小请求，确认哪条通，**同时定稿 `DEEPSEEK_RESPONSES_PATH`**。→ 销 **阻塞项 1（P0）**
2. 非流式三种输入形态各一次：`instructions` + `input` string；`input` item 列表（含 `function_call` / `function_call_output` / `reasoning`）；混合。比对 `output[]`、usage 五槽、`status`。
3. 流式：抓完整事件序列存 `adaptors/fixtures/openai-responses/from-live/response.stream.sse.txt`，断言事件名集合与 §4.5 折叠表一致、无 `data: [DONE]`、终事件带 usage。→ 销 **阻塞项 2（P0）**
4. 工具循环：`tools:[{type:"function",…}]` + `tool_choice:"required"`，回传 `function_call_output`，确认 `call_id` 配对与 `id` 命名。
5. `reasoning`：思考模式开/关各一次，确认 `reasoning` item 的 `content` 是纯文本、无 `summary` / `encrypted_content`。
6. `text.format:{type:"json_schema"}` 一次，确认结构化输出（B 唯一确定的能力增量，§5.3 边界第 5 条）。

**B 侧（需要有效 key；逐条对上 §4.8 的丢弃表）**：

1. `web_search`（v4-pro）一次，确认 `web_search_call` item 形状与 `usage.server_tool_use` 计数；`deepseek-flash` 上一次确认被忽略。→ 销 **阻塞项 3（P1）**，并核对 [50-builtin-search.md](./50-builtin-search.md) §5 的按次计费口径
2. `custom` / `apply_patch` 一次，确认 `custom_tool_call` 的 `input` 是自由文本；换一个非 `apply_patch` 的 `custom` 名字确认上游 400（验证我们「必须拒而不是 drop」的判断）。
3. 故意各传一次 §4.8.1 的 18 个不支持参数，**逐个确认上游真的不报错**（官方说静默忽略）——这一步同时验证我们的丢弃表没有多登记（把上游其实支持的参数写进 `unsupported_fields` 会让 `on_unsupported:"error"` 的部署误拒）。
4. 同一 prompt 同时打 chat 面与 Responses 面，比对 `input_tokens` / `output_tokens`。→ 销 **阻塞项 4（P1，Q47）**；不一致就按 §6.2 的路线写对账方法
5. `input_file` + Files API 在 Responses 面各试一次（`file_id` 可以、`file_url` 不行）。→ 销 **阻塞项 5（P1）**
6. 按 OpenAI 官方 reference 复核 `strict` 的位置。→ 销 **阻塞项 6（P1，Q45）**
7. 限流：确认 Responses 面与 chat 面是否共享配额池。→ 销 **阻塞项 7（P1，Q48）**

**销账后的动作**：§2.1 / §4.8 里对应的 `[doc]` 标注升级为 `[live]`，`fixtures/from-live/` 换真样本重跑全部断言；结论与本文冲突时**改文档，不改代码假设**。

### 7.3 文档 CI 检查项

- `node scripts/check-docs.mjs` 全绿（围栏奇偶 / §N 引用目标存在 / 节号不重复不跳号 / 术语禁用同义词）。
- `npm test` 里的 `tests/docs-check.test.ts` 正向用例全绿。
- `npm test` 里的 `tests/billing-coverage.test.ts` 全绿——**这是 §5.4 第 5/6 项的兜底**：B 的 access path 进了 `DEFAULT_ACCESS_PATHS` 却没进 `BILLING_COVERAGE`，这里直接红灯并点名 `deepseek`。
- `npm test` 里的 `tests/ir-schema.test.ts`（若 D2 落地）：`DeltaData` 的 chat 变体加字段后，TS↔schema 字段级 parity 与既有夹具仍全绿。
- `npm run check:ui-copy` 全绿（D3 改面板后）。
- markdownlint（MD032 / MD040 / MD036）全绿。
- [85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §2.3 的模态卡片硬校验**不受影响**——这本身是一条断言：**本文不改 `ir/modality.ts`**，因此不新增也不需要新卡片。

---

## 8. 拍板记录（D1–D5 全部已确认）

| # | 决定 | 结论 | 拍板 |
|---|---|---|---|
| **D1** | 拆分数 | **② A + B 都做**（客户端脸 + provider 脸）；**C 网关自消费不做** | ✅ 2026-11-16 主人拍板，原话「我要求的其实是 B，但是 A 也要支持」 |
| **D2** | 流式工具参数的 item 标识 | **① 给 `DeltaData` 的 chat 变体加可选 `tool_call_id`**（[12-coverage-survey.md](./12-coverage-survey.md) §3 F5 第 3 步的加法）；备选「不加、等 `part.end` 一次性给」不采用 | ✅ 2026-11-16 确认（「剩下的先按照你的想法来全部做完」） |
| **D3** | 管理面 dialect 下拉 | **③ 保留并标「未接入」+ 帮助深链**；过渡态规则见 §6.3 末段 | ✅ 同上 |
| **D4** | 期序 | **① 期一现在进**，夹具先用官方文档样本（`from-docs/`）；**B 的 live 冒烟等有效 key**，之前 B 保持「未接真实上游」状态 | ✅ 同上 |
| **D5** | 文档一致性修订 | **授权合入时同步改 5 处**：[40-provider-adaptors.md](./40-provider-adaptors.md) §5.1 状态行、[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §5.2 拆行、[85-modality-surface-matrix.md](./85-modality-surface-matrix.md) §6.2 补一行、[00-overview.md](./00-overview.md) §6 索引加一行、[00-overview.md](./00-overview.md) §8 的 Q 编号规则句补指针 | ✅ 同上 |

**已随本次改动落地的部分**：00 §6 索引行、00 §8 的 Q 编号指针（上一提交）；40 §5.1、85 §5.2、85 §6.2、85 §3.1 缺口行（本次提交）。**未落地、留给实现线程的**：85 §3.1 卡片单元格的「期一落地 / 出站 planned」标注——它要跟着代码状态走，现在改会在代码之前变成新的不实陈述。

**与 A+B 新范围的冲突检查**：D2 / D3 / D4 / D5 均不与 A+B 冲突。唯一需要跟着范围调整的是 D3 的**过渡态**（§6.3 末段）：A 落地后「未接入」标注要改，B 落地后要区分「已接但未接真实上游」——这是标注的生命周期，不是选项变化。

---

## 9. Open Questions

> 编号为**全局 Q 编号**（规则见 [00-overview.md](./00-overview.md) §8）。Q1–Q10 在 [00-overview.md](./00-overview.md) §8，Q11–Q20 见 [10-canonical-schema.md](./10-canonical-schema.md) §10，Q31–Q42 见 [12-coverage-survey.md](./12-coverage-survey.md) §5。**Q43–Q48 由本文新增**，全部依赖有效 DeepSeek key 才能销账。
> **「阻塞 B」列**：标 ✅ 的是 B 的实现/上线前**必须**销账的（对应 §2.3 的阻塞等级）；标 — 的只影响文档精度。

| # | 问题 | 阻塞 B |
|---|---|---|
| **Q43** | DeepSeek Responses 的端点路径带不带 `/v1`。无法用无 key 探测定论（鉴权网关先于路由，见 §2.3 第 1 条） | ✅ **P0** |
| **Q44** | DeepSeek Responses 事件序列的完整形状——`sequence_number` 是否严格单调、`response.output_item.added` 的覆盖面、`item.id` 与 `call_id` 的实际命名 | ✅ **P0** |
| **Q45** | `strict` 在 Responses function tool 上的位置——工具级字段还是 `parameters.strict`。[10-canonical-schema.md](./10-canonical-schema.md) §9.1 写的是后者，DeepSeek 的 Responses 工具参考未列该字段 | ✅ P1 |
| **Q46** | `server_tool_use` 的计费口径——按次加价还是含在 token 价内；与 [50-builtin-search.md](./50-builtin-search.md) §5 的按次口径是否同价 | ✅ P1 |
| **Q47** | DeepSeek Responses 面与 chat 面的 token 口径是否一致（同一 prompt 两边 `input_tokens` / `output_tokens` 是否相同）。这是 §6.2 计量口径是否要分开记账的判据 | ✅ P1 |
| **Q48** | DeepSeek Responses 面是否与 chat 面共享限流配额池 | ✅ P1 |
