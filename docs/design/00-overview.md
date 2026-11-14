# 00 · AgentGateway 总体设计（总入口）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 本文是整套设计的入口。**从这里开始读。**
> 仓库：私有。本文档可独立阅读，不依赖任何对话上下文。

---

## 1. 项目是什么

AgentGateway 是一个**自托管的多模态 LLM API 网关**。它的核心能力不是"转发请求"，而是**协议/格式互转**：

1. 客户端可以用任意主流格式发请求（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini generateContent，以及 TTS/ASR/Image 等模态端点）。
2. 网关把它转成**自研的 canonical 中间格式**（代号 **AG-IR**）。
3. 再转成上游 provider 的格式。
4. 返回时反向转回客户端请求的格式。

在此之上提供：插件系统（首个插件是长上下文压缩）、内置搜索、统计与计费管道、dog-fooding agent 接口、WebUI。

### 1.1 为什么不是"再用一个 OpenAI 兼容代理"

市面上的方案（LiteLLM、one-api / NewAPI、agentgateway、llm-bridge、Api-Conversion 等）都把 **OpenAI Chat Completions 当枢轴**：其他格式先转成 OpenAI 格式再发给上游。这条路的问题是：

- **OpenAI 格式不是真超集**。它没有 Anthropic 的 `cache_control` 块级断点、没有 `thinking.signature`（多轮思考回传必需）、没有 Gemini 的 `thoughtsTokenCount`/grounding metadata。以它为枢轴，这些字段在"客户端格式 ≠ 上游格式"时必然丢失或需要特例补丁。
- **枢轴格式由单一厂商掌控**，它每次改版（`max_tokens` → `max_completion_tokens`、新增 `reasoning` item）都会迫使网关跟着改。
- **插件生态被锁死**：如果内部表示就是 OpenAI 格式，插件就只能看到 OpenAI 格式的截面，看不到"这次请求原本是 Anthropic 格式、带 1h ephemeral cache 断点"这类信息。

AgentGateway 的选择：**自建显式的 canonical 超集**，把"哪些字段被保留了、哪些被降级了"变成类型系统里的一等公民。

**外部实证（口径已按官方文档校正）**：Cloudflare AI Gateway 的文档导航里，标 **Deprecated** 的是 **Universal Endpoint**（单端点 + payload 自带 provider/endpoint/query 的旧形态），其替代建议是 "Use the OpenAI-compatible endpoint for new integrations"；而 "Unified API (OpenAI compat)"（`/compat/chat/completions`）页写的是 **"Deprecated for single-model calls"**，替代方案 REST API 给出的仍然是 OpenAI 兼容的 `/ai/v1/chat/completions`。也就是说 Cloudflare **没有**放弃 OpenAI 兼容端点，放弃的是"一个 Universal 端点 + payload 内联路由"这一种形态。AgentGateway 押注的是**多入站格式共存 + 真超集 canonical + 横切治理**；把 Cloudflare 这条当作"统一成一种 OpenAI 方言被否定"的论据是不成立的，已删除。（来源：[Unified API (OpenAI compat)](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)、[Universal Endpoint (Deprecated)](https://developers.cloudflare.com/ai-gateway/usage/universal/)、[AI Gateway llms.txt](https://developers.cloudflare.com/ai-gateway/llms.txt)，2026-11-14 访问）

### 1.1b 最强的反对意见：agentgateway 为什么不做 canonical IR

**这是整套设计最大的可攻击点，必须正面回应。**

[agentgateway](https://github.com/agentgateway/agentgateway)（Apache-2.0，LF/AAIF 托管，Rust 从零实现）的做法与我们**方向相反**（[crates/agentgateway/src/llm/mod.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/llm/mod.rs)、[crates/llm/src/types/mod.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/llm/src/types/mod.rs)）：

1. **每种 wire format 一套强类型 struct，末尾必有 `#[serde(flatten, default)] rest: serde_json::Value`** 存所有未知字段——前向兼容 + 已知字段类型安全；
2. **两两配对转换**（`CHAT_TRANSLATIONS` 有序表，"取第一个 provider 支持的"，注释原文 "Put cheaper or more native translations before broader fallbacks"），**不是 hub-and-spoke**；
3. 另有一个 `NormalizedMessage{role, parts:[Text|ToolCall|ToolResult|Reasoning]}`，但源码注释明确写：**"This is an observability representation, not a lossless wire format."** ——归一化表示只用于可观测/护栏，**绝不用于 wire 序列化**；
4. 它文档化的静默丢弃清单很长：Messages→Responses 丢 extended-thinking 历史、citations、document/search_result/server_tool_use 块、server tools（含 web search），且 `stop_sequences` / `top_k` **被接受后静默丢弃，无 error 无 warning**。

**它的理由是**：强行用唯一 IR 承载 wire，会立刻遇到那一长串静默丢弃；而"每格式 typed struct + rest 透传 + 直接配对"能保真。

**我们仍然选 canonical，理由是需求不同：**

| 维度 | agentgateway | AgentGateway |
|---|---|---|
| 保真度放在哪 | 每格式的 `rest` 透传 + 直接配对 | 超集 canonical + raw passthrough |
| 插件/护栏看到什么 | 没有统一表示，只能靠 `visit_text_mut` visitor 逐格式遍历 | **统一 canonical**（这是硬需求） |
| usage/finish_reason 归一 | 每对转换各做一遍 | **一处**（计费可信的前提） |
| 加一种新格式 | 要写 N 个新配对函数 | 写 1 个 adaptor |
| 错误映射 | 每对各做 | 一处 |
| 无损保证 | 依赖每个配对函数都记得带 `rest` | 依赖 schema 是超集 + round-trip 测试 |

**关键点**：我们的核心需求（插件只面对 canonical、计费口径一处归一、dog-fooding 数据面统一）**只有 canonical 能满足**。agentgateway 的 visitor 方案能让护栏改文本，但护栏看不到"这次请求原本是 Anthropic 格式、带 1h ephemeral cache 断点"，也拿不到统一的 usage。

**因此我们明确借用它的四条，弥补 canonical 路线的风险：**

1. **typed struct + rest 透传**——我们的 `raw.unmapped` / `_raw` / `UnknownPart` 就是同一思想（[10-canonical-schema.md](./10-canonical-schema.md) §7）；
2. **有序偏好表**——转换目标按"更便宜/更原生优先"排序，且把"Missing: X → Y"写成显式注释（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.4）；
3. **token 双轨**——归一化值（`input_tokens`/`total_tokens`，跨 provider 同义）+ provider 原样值（`usage_raw`，用于对账），并显式警告不要相加（[40-provider-adaptors.md](./40-provider-adaptors.md) §2）；
4. **wire 层与归一化层的分离意识**——我们的 canonical 同时服务 wire 与策略，这点比 agentgateway 更激进；因此 [12-coverage-survey.md](./12-coverage-survey.md) 的"全覆盖普查"和 schema 层 round-trip 测试是**必需的**，不是可选的。

**诚实的代价**：canonical 必须真的是超集，否则就会重演 agentgateway 列出的那串静默丢失。这就是为什么 §2.1 把"canonical 一次做全"列为范围第一条，以及为什么 [70-roadmap.md](./70-roadmap.md) Phase 1 的验收标准里有 round-trip 测试框架。

### 1.2 与现有方案的对比结论

> 完整调研与来源见 [docs/sources.md](../sources.md)。下表是结论压缩。

| 方案 | 形态 | License | 中间表示 | 插件系统 | 多模态 | 加密/保留策略 | 结论 |
|---|---|---|---|---|---|---|---|
| **LiteLLM** | Python 代理 + UI | MIT core（`litellm/enterprise/` 另许可） | **OpenAI Chat 为枢轴** | ⚠️ 有 hook（`async_pre_call_hook` / `async_post_call_success_hook` / `async_post_call_streaming_hook`），但挂在**具体协议的请求/响应字节**上，不是格式无关的 canonical 级 hook | ⚠️ 转发为主 | ❌ | 转换层是复杂度黑洞（5k+ open issues）；借鉴其 transform 分层与计费，不用其枢轴路线 |
| **NewAPI / one-api** | Go 单二进制 + 内嵌前端 | NewAPI AGPL-3.0；one-api MIT | **OpenAI 兼容外壳 + 每渠道各自适配**，无 canonical | ❌ | ⚠️ 多为转发 | ❌ | **根本分野**：它是"渠道适配"，我们是"canonical 内核"。详见 §1.3 |
| **agentgateway**（Solo.io/LF） | Rust 数据面 + React UI | Apache-2.0 | 无 LLM 级 canonical；协议转换有限 | ⚠️ CEL/ExtProc/webhook | ⚠️ | ⚠️ SQLite/PG 存储 | 借鉴其 Analytics 与 virtual key 模型；不当基座 |
| **llm-bridge** | TS 库 | MIT | 有 universal format + `_original` | ❌ 仅函数回调 | ⚠️ schema 超前于实现 | ❌ | 借鉴 per-element `_raw` 形状；其"零损耗"边界比宣传窄（仅 same-provider + 未改动） |
| **llmshim** | Rust 库 | Apache-2.0 OR MIT | **明确放弃 canonical IR** | ❌ 仅 Rust trait + feature | ⚠️ 按名拒绝 | ❌ | 借鉴 schema 归一化、计费不变式、Provider/Transport 二分 |
| **Vercel AI SDK** | TS client SDK | Apache-2.0 | `LanguageModelV4`（中立核 + 命名空间透传） | ⚠️ `wrapLanguageModel` middleware | ⚠️ | ❌ | **类型设计的极佳参考**；但方向是出站、且既非 Anthropic 超集也非 Responses 超集 |
| **OpenRouter** | 闭源商业系统 | 服务闭源；仅 SDK/examples 开源 | 未公开 | 未公开 | ⚠️ | 未公开 | **可参考其对外契约与路由语义**，见 §7.0 |
| **Api-Conversion** | Python 产品 | README 称 MIT（GitHub API `null`，**待验证**） | 无 canonical | ❌ | ⚠️ | ⚠️ Fernet 存 key | 借鉴其 reasoning 阈值表；久未维护、license 不明 |

**共同空白**（= AgentGateway 的差异化）：① 真超集 canonical + raw 无损硬约束；② 运行时插件系统；③ 统一多模态 schema；④ 加密存储与保留策略；⑤ 计费 provenance（"未知"不等于 0）。

### 1.3 与 NewAPI / one-api 的根本分野

**一句话：NewAPI 是"OpenAI 兼容外壳 + 渠道适配"，AgentGateway 是"canonical 内核 + 双向映射 + 插件"。**

已读源码确认（NewAPI main @ `b388140a`，2026-11-13；one-api main @ `8df4a267`）：

**NewAPI 的实际架构**：

- **inbound 支持 4 种协议**（OpenAI Chat / OpenAI Responses / Anthropic Messages `/v1/messages` / Gemini `/v1beta/models/*:action`）——比"只有 OpenAI 外壳"的认知要新，Anthropic/Gemini 的 inbound 入口是 NewAPI 相对 one-api 新增的（one-api 的 `router/relay.go` 只有 OpenAI 形态）。
- **但没有 canonical IR**：只有一张 N×M 成对转换器图，**hub 是 OpenAI Chat**。转换层被抽成独立 Go module `relaykit`：成对转换器注册表 + **质量分级**（good / fair / **discouraged**）+ 诊断 + 多跳路由。Claude↔Gemini 明确标 `discouraged`（经 OpenAI Chat 两跳，丢字段机会更多）。
- **38 个 outbound adaptor**（`relay/channel/` 下 41 个 vendor 目录），每个 adaptor 各自实现 `ConvertClaudeRequest` / `ConvertGeminiRequest` / `ConvertOpenAIResponsesRequest`——同一份转换逻辑在多个 adaptor 里各写一遍。
- **计费**：预扣 reserve + 后结算 settle(delta) + 失败退款；倍率体系 `model_ratio` / `completion_ratio` / `cache_ratio` / `cache_creation`(5m/1h/12h) / `group_ratio` / `image_ratio` / `audio_ratio`；**无 reasoning token 独立计价**（计入 completion）；有 `tiered_expr` 表达式计费。
- **原始 provider usage 不全留**：`BillingUsage` 在内存里同时存 `OpenAIUsage` / `ClaudeUsage` / `GeminiUsageMetadata`，但 **`logs` 表只落归一化后的 `prompt_tokens`/`completion_tokens`/`quota`**，原始 usage 结构不持久化。
- **默认 0 次重试**（`common.RetryTimes = 0`）；无熔断器（只有 401/关键词自动禁用 + 自动恢复 + 定期 channel test）；无 Prometheus 指标出口；**无请求/响应 payload 落库**。
- **License：AGPL-3.0 + Section 7 附加条款**——修改版必须保留 `Frontend design and development by New API contributors.` 署名 + 原项目可见链接，网络使用需开源。one-api 是 MIT 但自 2025-02 起基本停更。

**这个分野决定了 NewAPI 给不了、我们必须自建的能力**：

| 能力 | NewAPI 能否给 | 为什么 |
|---|---|---|
| 真 canonical 中间格式 | ❌ | 成对转换图，hub 是 OpenAI Chat；"客户端 Anthropic、上游 Gemini"要两跳且被标 `discouraged` |
| 跨渠道的 usage 口径统一 | ❌ | 没有统一归一点；原始 usage 只在内存里，不落库 → 无法对账 |
| 插件 hook（请求/响应/流式） | ❌ | hook 点（`requestplugin.Ingress/Outbound/Egress/Reply/Report`）都挂在"具体某协议的 JSON 字节"上；做不到"不管上游是 Claude 还是 Gemini 都改同一个字段" |
| 多模态统一 schema | ❌ | TTS/ASR/Image 基本是透传 + 本地估算（OpenAI TTS 的 `usage.PromptTokens = info.GetEstimatePromptTokens()`，即按输入文本长度估算，不是上游返回） |
| 加密存储 + 保留策略 + 脱敏 | ❌ | 默认不落 payload（这点反而是好的），但也没有 opt-in 加密落库 + 保留策略 |
| 面向自用的 dog-fooding agent 接口 | ❌ | 定位是中转售卖 |
| 熔断 / Prometheus / 可靠重试 | ❌ | 默认 0 重试、无熔断、无指标出口 |

**可从 NewAPI 借鉴的**（这些都是"运营面"的成熟实践，与协议面设计无关）：

1. **`relaykit` 的转换结果对象**（`From/To/Converter/Quality/Steps/Diagnostics`）与**损耗策略三档**（`allow` / `safe` / `strict`）——把"丢了什么"变成一等公民。**这直接改进了我们的 `degraded` 设计**：除了布尔标记，还应带结构化诊断（code / field path / level）。
2. **`RequestConversionChain` / `FinalRequestRelayFormat` 记进 log**——直接回答"这个请求到底被转成了什么"，进我们的 `RequestTrace`。
3. **`BillingSession` 的 reserve/settle/refund/ReserveBeforeSubmit 生命周期** + `RequestId` 幂等——比裸的"请求后扣费"干净，且已处理"重试换渠道补扣""异步任务强制预扣""订阅/钱包双资金来源"。
4. **原子预留**（`TryReserveTokenQuota`）——对照其 open issue #6609 暴露的钱包 TOCTOU 竞态，我们的额度预留必须做原子 CAS。
5. **渠道级差异配置**（`ParamOverride` / `HeaderOverride` / `StatusCodeMapping`）。
6. **golden test** 固化协议输出快照（我们已有 round-trip 模板，见 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.5）。
7. **已知 issue 清单直接当测试用例来源**：#7454（file/document 块丢失 + data URL 格式化 bug）、#6260（tool_result 里的 image_url 不转换）、#7564（developer 消息被静默合并进 Gemini systemInstruction）、#8128（Responses→Claude 数字 tool 参数被改）、#7472（流式 usage 丢失）、#7657（重启丢失途结算）。

**为什么不"在 NewAPI 上改"**：

1. **AGPL-3.0 + Section 7 附加条款**：修改版必须保留前端署名 + 原项目可见链接，网络使用需开源。对要深度定制的私有仓库是硬约束（官方 NOTICE 暗示需按其公布的商务联系方式谈商业授权，见 [NEW:NOTICE](https://raw.githubusercontent.com/QuantumNous/new-api/b388140acfd80369ec6243b16869daff1b4051f4/NOTICE)）。
2. **协议层哲学不同**：它的 `ConvertClaudeRequest` 在每个 adaptor 里各写一遍，新增第 5 种协议要改 N 个 adaptor；我们只需加 1 个 inbound mapper + 1 个 outbound mapper。
3. **转换质量自认不佳**：Claude↔Gemini 是 `discouraged`，大量 open issue 集中在 tool_calls / file blocks / image_url / 流式 usage 丢失。以"格式保真"为核心卖点的话，继承这张图等于继承这些 bug。
4. **代码耦合度**：计费/订阅/支付/MJ/任务插件/OAuth/2FA 全耦在 `RelayInfo`（单 struct 200+ 字段）；我们需要的 canonical + 插件体系会被迫塞进这个巨型 context struct。
5. **无 canonical IR 意味着无法做协议无关的 hook**——这是我们的核心需求。
6. **运维特性缺口**：无 Prometheus、无熔断、默认 0 重试、重启丢失途结算。

**relaykit：明确不采用（review #8.4，作者已拍板定稿）**：`relaykit` 是仓库内的独立 Go module，其 README 明确说"HTTP 收发、SSE 读写、渠道选择、鉴权和计费由宿主程序完成，所以可以嵌进其他 Go 网关或代理"，表面看是一条"站在 NewAPI 肩膀上"获得 4 协议互转能力的捷径。**但结论是明确不采用**：

1. **它与被拒的 NewAPI 同为 AGPL-3.0 + Section 7 附加条款**——而 §1.3 拒绝 NewAPI 的**首要**理由（上文「为什么不"在 NewAPI 上改"」第 1 条）正是 AGPL。直接依赖 `relaykit` 与"因为 AGPL 而不在 NewAPI 上改"面对的是同一个许可证约束，只是换了入口：依赖它的 module 同样触发"网络使用需开源 + 保留前端署名/可见链接"的义务，私有深度定制仓库并不因为"只用了一个 Go module"就豁免。**不采用的理由是许可证结论必须自相一致，不是技术**（它的成对转换器 + 质量分级设计确实值得借鉴）。
2. **借鉴方式限定为"读设计、不引代码"**：转换结果对象（`From/To/Converter/Quality/Steps/Diagnostics`）、损耗策略三档、`RequestConversionChain` 记日志——这些已按设计借鉴落入本文（本节上文"可从 NewAPI 借鉴的"、[10-canonical-schema.md](./10-canonical-schema.md) 的 `ConversionDiagnostic`、[20-pipeline.md](./20-pipeline.md) §4.2 的 `conversion_chain`）。
3. **若将来确需其代码**：必须以**独立进程/服务边界**隔离（本地 HTTP/stdio，不 link 进同一进程），**并且先做许可证评估**——AGPL 的传染性只覆盖"基于该程序的衍生作品"，跨进程边界通信是否构成衍生作品在业界有争议、无定论，需单独的法务判断，本文不预设结论。

### 1.4 核心价值主张（按优先级）

1. **格式互转 + 无损可逆**：`raw passthrough` 机制保证未建模字段不丢（[10-canonical-schema.md](./10-canonical-schema.md) §7）。
2. **统计口径错位修正**：同样一次调用，四种格式的 usage 字段名与语义不同（`prompt_tokens` vs `input_tokens` vs `promptTokenCount`；`cache_creation_input_tokens` vs 无对应）。canonical 把它们归一，这是**计费可信的前提**，也是 fast path 下唯一必须做的事。
3. **fast path**：客户端格式 == 上游格式时跳过结构转换，透传原始字节，旁路只做计量；S1 只做信封级惰性解析。**不为功能牺牲性能**。
4. **插件系统**：generic hook，操作对象只有 canonical。
5. **dog-fooding**：网关把自己的用量/计费/配置数据暴露成工具，让 AI agent 自己查询分析。

---

## 2. 范围（Scope）

### 2.1 范围内

> **关键区分：canonical schema 是全面的（超集），adaptor 是按需写的。** canonical 覆盖 **9 种模态**（chat / decision / embedding / tts / asr / image / rerank / moderation / video 占位），其中 decision 是 2026-11 新增的**第 9 个模态**（不是"第五模态"——它只是在 `ModalityKind` 联合类型里排第 2，见 [10-canonical-schema.md](./10-canonical-schema.md) §3.1），其首要消费者是网关自己（控制面），不是终端用户。
> canonical 在设计期一次性穷尽式普查（[12-coverage-survey.md](./12-coverage-survey.md)），目标是"新增 adaptor 永远不需要改 schema"；adaptor 用到再写（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.0）。两者矩阵分开维护。

| 能力 | 状态 |
|---|---|
| canonical schema（AG-IR v1）：共享信封 + 9 模态 payload + 媒体引用 + 多单位 usage + raw passthrough | [v1] **穷尽普查，一次做全** |
| 3 个 chat adaptor 写透：`openai.chat`、`openai.responses`、`anthropic.messages` | [v1] |
| fast path 透传 + usage 旁路嗅探（S1 信封级惰性解析） | [v1] |
| 异步 usage/计费管道（多单位）+ Tier-1 存储 | [v1] |
| 数据面认证（virtual key）+ 控制面本地认证 + passkey | [v1]（Phase 1 就绪；其唯一使用方 WebUI 是 [v1.5]/Phase 4，中间由 CLI 消费——"能力先于消费者就绪"，不是依赖倒置） |
| round-trip 测试框架（adaptor 层 6 条 + schema 层全覆盖用例） | [v1] |
| `openai.embeddings` adaptor | [v1.5]（Phase 4；原标 [v1] 与 70 的 Phase 4 排期冲突，见 70 §1.1.1 冲突 1） |
| `gemini.generateContent` adaptor | [v1.5]，**排在 Phase 2**（原标 [v1.5] 但读者会以为只在 Phase 4；版本标签是能力档次、Phase 是排期，映射表见 [70-roadmap.md](./70-roadmap.md) §1.1.1） |
| 多模态示例 adaptor：TTS（OpenAI + ElevenLabs）、ASR（OpenAI）、Image（OpenAI） | [v1.5] |
| 插件系统（5 hook）+ 长上下文压缩 adaptor（acp-kernel） | [v1.5] |
| **decision 模态**（判断模型：路由/策略/compact-escalate-stop 控制面判断）+ chat 模拟降级路径 | [v1.5] |
| 内置搜索（web_search as built-in tool） | [v1.5] |
| Tier-2 加密存储 + 前缀压缩 + 脱敏 + 保留策略 | [v1.5] |
| WebUI（fork LibreChat 改造） | [v1.5] |
| Dog-fooding agent 接口（Tier-2 部分） | [v1.5] |
| 其余 adaptor（Azure/Bedrock/Vertex/Stability/BFL/MiniMax/Deepgram/AssemblyAI/Mistral/Cohere…） | **按需** |
| Rerank / Moderation / Video 模态 | [later]（schema 已留位） |
| OAuth 登录 | [later]（可选，插件式） |

### 2.2 明确的非目标（Non-goals）

> 本节是**非目标的唯一事实来源**；[70-roadmap.md](./70-roadmap.md) §7 不再重复列举，只回指这里。

1. **不做多租户计费/收费**。单租户自用，只有成本核算，没有支付。
2. **不接非官方 API**。只走各家官方 REST/WS 端点。两条例外必须显式声明：
   - **订阅 OAuth 不算"非官方 API"**：OpenAI Codex 的 device-code OAuth、xAI SuperGrok 的订阅 OAuth 都是**厂商官方公开的登录流程**，走官方端点、消耗订阅额度，属于官方用法。本文采纳（[45-credentials.md](./45-credentials.md) §1、§5.1）。**未决的是 ToS 层面而非技术层面**：用订阅额度驱动网关自用是否符合各家的服务条款，文档无法替用户判断——部署者需自行确认，网关侧只做到"显式配置 access path + 可审计"（标 **`[待验证]`**，见 [66-auth.md](./66-auth.md) §3.2 的 OAuth 现实约束）。
   - **`session_cookie`（复用 Web 端会话）明确是非目标**：它是协议逆向，正是本条第 2 项要排除的东西。schema 与能力矩阵里保留位置只为"将来若要做，有地方放"，v1 不实现，需显式 opt-in + 独立风险确认（见 [45-credentials.md](./45-credentials.md) §2.2）。
3. **不追求 100% 无损转换**。目标是"声明式可降级 + raw 可回写"，转不了的明确拒绝。
4. **不内置模型推理**。网关不跑模型。
5. **不做响应侧内容压缩/摘要**（压缩只作用请求侧，理由见 [25-streaming.md](./25-streaming.md) §7.3）。
6. **不做视频模态实现**（v1.5 前）。
7. **decision 不做流式**（三家官方均不支持，见 [15-modalities.md](./15-modalities.md) §6.2）；也不做"用 decision 替代 chat"的尝试——它是控制面能力，单向。
8. **Phase 5 前不接入开源自托管 decision 模型**（261 个 open-weights 系统，Jeff / clef / mammoth-1 等）——先打通商业 API，自托管作为 `local` access path 的后续可选项。

---

## 3. 核心约束

| 约束 | 内容 | 影响的设计 |
|---|---|---|
| **隐私优先** | 聊天数据持久化**默认关闭**；usage 元数据默认开启；落盘即加密；provider key/Authorization 头永不入库 | 分层存储 + 开关 + 脱敏（[65-storage-and-retention.md](./65-storage-and-retention.md)） |
| **自托管、无人值守** | 单机或小集群，无 KMS/HSM；重启要能自动起来 | 密钥三档来源，默认 OS keyring 档（[65-storage-and-retention.md](./65-storage-and-retention.md) §3） |
| **性能** | fast path 附加延迟 < 3ms p99（S1 只做信封级惰性解析，完整 canonical 物化推迟到非 fast path）；不为功能强制走转换 | fast path + 旁路计量（[20-pipeline.md](./20-pipeline.md) §4） |
| **插件只面对 canonical** | 插件拿不到任何 provider 原始 body | adaptor 模式接外部能力（[30-plugin-api.md](./30-plugin-api.md)） |
| **流式是第一公民** | 不允许隐藏的"等全量再下一步" | 统一流式帧信封（[25-streaming.md](./25-streaming.md)） |
| **不计费不确定性** | "未知"绝不用 0 表示 | 多单位 usage + source provenance（[10-canonical-schema.md](./10-canonical-schema.md) §6） |

---

## 4. 总体架构

### 4.1 数据流

```text
                    ┌─────────────────────────────────────────────────────────────┐
                    │                      AgentGateway                          │
                    │                                                             │
  client (任意格式)  │  ┌────────┐   ┌────────┐   ┌─────────┐   ┌──────────────┐  │
 ───────────────────▶│  │ S0     │──▶│ S1     │──▶│ S2      │──▶│ S3 onRequest │  │
   openai.chat      │  │Ingress │   │Decode  │   │Route    │   │  插件链      │  │
   openai.responses │  │鉴权/限流│   │→信封   │   │fast path│   │  (压缩/注入) │  │
   anthropic        │  └────────┘   └────────┘   │ 判定    │   └──────┬───────┘  │
   gemini           │                            └─────────┘          │          │
   tts/asr/image    │                                                 ▼          │
                    │  ┌──────────────────────────────────────────────────────┐  │
                    │  │ S4 Encode (canonical → provider)                     │  │
                    │  │   fast path: 透传原始字节                             │  │
                    │  └───────────────────────┬──────────────────────────────┘  │
                    │                          ▼                                 │
                    │  ┌──────────────────────────────────────────────────────┐  │
                    │  │ S5 Upstream (HTTP / SSE / chunked-binary / WS)        │  │
                    │  │   重试 · fallback · 熔断 · 超时预算                   │  │
                    │  └───────────────────────┬──────────────────────────────┘  │
                    │                          ▼                                 │
                    │  ┌──────────────────────────────────────────────────────┐  │
                    │  │ S6 ProviderDecode → S7 onStreamChunk → S8 ClientEncode│  │
                    │  │   统一流式帧 StreamFrame（25-streaming.md）            │  │
                    │  └───────────────────────┬──────────────────────────────┘  │
                    │                          ▼                                 │
                    │  ┌──────────┐   ┌──────────────────────────────────────┐   │
                    │  │ S9       │──▶│ S10 UsageEmitter ──▶ 计费管道(异步)  │   │
                    │  │onResponse│   │   Tier-1 usage (常开)                │   │
                    │  └──────────┘   │   Tier-2 消息内容 (opt-in, 加密)     │   │
                    │                 └──────────────────────────────────────┘   │
                    └─────────────────────────────────────────────────────────────┘
                                          │
                    ┌─────────────────────┼──────────────────────┐
                    ▼                     ▼                      ▼
             ┌────────────┐      ┌────────────────┐     ┌─────────────────┐
             │ Provider   │      │ 搜索后端        │     │ WebUI (fork     │
             │ APIs       │      │ searxng 等     │     │ LibreChat)      │
             └────────────┘      └────────────────┘     └─────────────────┘
```

> **S1 是信封级惰性解析（review #8.3，作者已拍板定稿）**：fast path 下 S1 只解析「信封 + 路由必需字段」
> （客户端格式识别、model / access_path、usage 信封位置、是否流式、请求体字节长度），**完整 canonical 物化
> 推迟到真正需要它的阶段**；某个请求能否走这条路，由已启用插件的 manifest `scope` 在启动时算出并缓存。
> 详见 [20-pipeline.md](./20-pipeline.md) §3（S1）与 §4.2。

### 4.2 模块划分

| 模块 | 职责 | 文档 |
|---|---|---|
| `gateway-core` | PipelineRunner、**11 个阶段（S0–S10）**、RequestContext、错误模型 | [20-pipeline.md](./20-pipeline.md) |
| `ir`（AG-IR） | canonical 类型 + JSON Schema + round-trip 校验 | [10-canonical-schema.md](./10-canonical-schema.md) |
| `adaptors` | 每 (格式, 模态) 一对 mapper：请求编码 / 响应解码 / 流式折叠 | [40-provider-adaptors.md](./40-provider-adaptors.md) |
| `plugins` | hook 运行时、manifest、故障隔离、billion-context adaptor | [30-plugin-api.md](./30-plugin-api.md) |
| `streaming` | 统一帧信封、三种上游形态桥接、WS 双路径 | [25-streaming.md](./25-streaming.md) |
| `modalities` | TTS/ASR/Image/Embedding 的 payload 与 mapper | [15-modalities.md](./15-modalities.md) |
| `decision` | control-plane 判断：decision 模态 adaptor + 降级路径 + 攒批 | [15-modalities.md](./15-modalities.md) §6、[40-provider-adaptors.md](./40-provider-adaptors.md) §6、[20-pipeline.md](./20-pipeline.md) §6 |
| `search` | built-in tool 建模、两种执行模式、后端抽象 | [50-builtin-search.md](./50-builtin-search.md) |
| `metering` | usage 归一、多单位、定价、dog-fooding 工具 | [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) |
| `credentials` | 上游侧凭据、access path、Plan 感知路由、双口径成本 | [45-credentials.md](./45-credentials.md) |
| `auth` | 数据面 virtual key + 控制面本地认证/passkey + 权限模型 | [66-auth.md](./66-auth.md) |
| `storage` | 分层、加密、前缀压缩、保留策略、脱敏 | [65-storage-and-retention.md](./65-storage-and-retention.md) |

> **目录命名以本节为准**（此前 README 用 `src/canonical/…`、70-roadmap 的验收标准用 `schema/`，三套命名已统一到这里的模块名；README 的目录树与 AGENTS.md 的"代码组织"同步改为这套）。

### 4.3 端点形态

```text
/v1/chat/completions                      # OpenAI Chat
/v1/responses                             # OpenAI Responses
/v1/messages                              # Anthropic Messages
/v1beta/models/{model}:generateContent    # Gemini
/v1beta/models/{model}:streamGenerateContent

/v1/audio/speech                          # TTS
/v1/audio/transcriptions                  # ASR (一次性)
/v1/realtime                              # ASR (实时, WebSocket)
/v1/images/generations                    # Image
/v1/images/edits
/v1/embeddings
/v1/rerank                                # [later]
/v1/moderations                           # [later]

/ag/usage/query                           # dog-fooding Tier-1 工具（也可经 tools 暴露）
/ag/plugins                               # 插件配置（WebUI 用）
/ag/providers                             # provider / key 管理
```

所有端点共用同一套 pipeline 阶段；差异只在 S1/S6/S8 的 codec 与 S2 的能力矩阵查询。

---

## 5. 术语表（全文一致）

| 术语 | 含义 |
|---|---|
| **canonical / AG-IR** | 自研中间表示。唯一中间格式。**不**用"intermediate format""IR""universal format"等同义词 |
| **envelope** | 共享信封（`CanonicalRequestEnvelope` / `CanonicalResponseEnvelope` / `StreamFrame`）。跨模态共用的外壳 |
| **payload** | 信封内按模态分的负载（`ChatPayload` / `TtsPayload` …） |
| **adaptor** | 网关内部把某 (格式, 模态) 映射到 canonical 的组件。**不**用 "provider driver""bridge" |
| **mapper** | adaptor 里的字段映射表/函数。二者关系：adaptor 是组件，mapper 是它的数据/逻辑 |
| **access path** | 送达上游的路径标识（`openai` / `openai-codex` / `xai-supergrok` / `bedrock` …）。与 provider 的区别：同一 provider 可有多条 access path（API key vs 订阅 OAuth）。完整模型 id = `<access_path>/<model_namespace>/<model>` |
| **credential** | 上游侧凭据（api_key / oauth_device_code / oauth_browser / session_cookie / cloud_iam / local / upstream_proxy）。与数据面的 virtual key 是两回事 |
| **virtual key** | 数据面（客户端侧）凭据，`sk-ag-…`，计费主键 |
| **fast path** | 客户端格式 == 上游格式时跳过结构转换、透传原始字节的路径 |
| **capability matrix** | `(access_path, model, modality, streaming)` → 支持情况 的登记表，路由据此拒绝/降级。**注意键是 access_path 不是 model**（见 [45-credentials.md](./45-credentials.md) §6） |
| **codec** | 具体某个格式的编解码实现（`OpenAIChatCodec`） |
| **tier-1 / tier-2** | 存储分层：tier-1 = usage 元数据（常开）；tier-2 = 消息内容（opt-in、加密） |
| **plugin / hook** | 插件与它的生命周期挂点。hook 名固定为 `onRequest` / `onResponse` / `onStreamChunk` / `onError` / `onToolCall` |
| **built-in tool** | canonical 里建模为工具、由上游或网关执行的能力（如 `web_search`） |
| **short circuit** | 插件直接给出应答、跳过上游调用的机制 |
| **degraded** | 因能力不支持而发生的显式降级（响应里带 `degraded: ConversionDiagnostic[]`），**不**静默 |
| **conversion diagnostic** | 结构化转换诊断（`code` / `field_path` / `from` / `to` / `level` / `message`）。`warnings` 是它的字符串摘要 |
| **loss policy** | 遇不支持字段时的策略三档：`allow`（转换完成 + 诊断）/ `safe`（遇 error 级诊断即失败）/ `strict`（任何诊断都失败）。默认 `allow` |
| **decision 模态** | 第 9 个模态（`kind:"decision"`，2026-11 新增；在 `ModalityKind` 联合类型里排第 2，勿称"第五模态"）。判断模型：多模态内容 + 批量问题 → 校准概率 + 置信度。控制面能力，**不是 chat 的特例**，也不能做 chat（单向） |
| **control-plane 判断** | 网关自己发起的 decision 子请求（路由/策略/工具选择/循环控制）。独立 `request_id` 与预算桶，计量进 `UsageRecord.control_plane_cost` |
| **calibration** | decision 响应的校准性标记：`native`（真 decision 模型）/ `degraded`（chat 模拟）。高风险判断不允许 degraded |
| **conversion chain** | 记录本次请求实际走过的转换链（如 `["openai.chat","anthropic.messages"]`），进 `RequestTrace`，直接回答"这个请求到底被转成了什么" |

---

## 6. 文档索引

| 文档 | 一句话内容 |
|---|---|
| [00-overview.md](./00-overview.md) | 本文。项目定位、范围、约束、架构、术语表、索引 |
| [10-canonical-schema.md](./10-canonical-schema.md) | AG-IR v1：共享信封 + 按模态 payload + 媒体引用 + 多单位 usage + raw passthrough + 四格式字段映射表 |
| [12-coverage-survey.md](./12-coverage-survey.md) | **canonical 覆盖普查**：主流厂商各模态特性并集（设计期目标=全覆盖）+ 前向兼容规则 + canonical 边界结论 |
| [15-modalities.md](./15-modalities.md) | 多模态（TTS / ASR / Image / Embedding / decision）方法论 + 每模态一个完整示例 + 按需补充简表；§6 是 decision 与 chat 的对照表与网关自身消费点 |
| [20-pipeline.md](./20-pipeline.md) | 请求生命周期 **11 个阶段（S0–S10）**、fast path 判定、流式处理、工具调用循环、错误映射与重试/fallback、**§6 control-plane 判断（decision 消费点）** |
| [25-streaming.md](./25-streaming.md) | 跨模态统一流式帧信封、三种上游流式形态桥接、ASR 中间态、TTS 细节、流式计量 |
| [30-plugin-api.md](./30-plugin-api.md) | 插件 hook TS 接口、生命周期、billion-context adaptor 设计 |
| [40-provider-adaptors.md](./40-provider-adaptors.md) | **adaptor 契约/注册/映射方法论/round-trip 测试模板/新增检查清单** + usage 口径差异对照表 + adaptor 覆盖矩阵 + **§6 decision adaptor 与降级路径** |
| [45-credentials.md](./45-credentials.md) | **凭据模型**（api_key / oauth_device_code / oauth_browser / session_cookie / cloud_iam / local / upstream_proxy）、access path、Plan 感知路由、双口径成本 |
| [50-builtin-search.md](./50-builtin-search.md) | 内置搜索 canonical 建模与两种实现模式、后端选型 |
| [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) | 计费管道、usage 归一规则、分层存储开关、dog-fooding agent 接口 |
| [65-storage-and-retention.md](./65-storage-and-retention.md) | 存储选型、加密与密钥管理、前缀压缩、脱敏、保留策略 |
| [66-auth.md](./66-auth.md) | 数据面 virtual key 与控制面本地认证 + passkey；OAuth 的现实约束与"后续可选"结论 |
| [70-roadmap.md](./70-roadmap.md) | Phase 0–5 路线图，每阶段交付物与验收标准 |
| [../sources.md](../sources.md) | 全部调研来源、结论摘要、license 备注 |

> **版本标签与 Phase 的映射**：00 用 `[v1]`/`[v1.5]`/`[later]` 标注能力，70 用 Phase 0–5 排期，二者对应关系见 [70-roadmap.md](./70-roadmap.md) §1.1 的映射表。

---

## 7. 关键技术选型结论

> 每一项只给结论与理由；被否方案的细节在对应文档的"决策"节。

### 7.0 OpenRouter 的对外契约（canonical 设计的现实参照）

**重要前提**：OpenRouter 的**核心系统（路由/网关/归一化）不开源**。其 GitHub 组织（[OpenRouterTeam](https://github.com/OpenRouterTeam)）只开放了外围：TypeScript/Python SDK、ai-sdk-provider、openrouter-examples、benchmark harness（[org 仓库列表](https://api.github.com/orgs/OpenRouterTeam/repos)）。服务本身是托管系统："OpenRouter is a managed LLM gateway ... OpenRouter hosts it, so there is nothing to deploy or self-host"（[openrouter.ai/llms.txt](https://openrouter.ai/llms.txt)）。

**因此下文所有实现细节均标注为「公开文档 / API 行为推断」，不得视为读过源码。**

它的价值在于：**它是闭源托管的商用网关里，少数同时提供 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三种入站格式的**（`/api/v1/chat/completions`、`/api/v1/responses`、`/api/v1/messages`），其对外契约是 canonical 设计最现实的参照系。

> **口径校正（原写"唯一"，已删）**：LiteLLM Proxy 同样支持这三种入站格式，并且还多一种 `/v1beta/models/{model}:generateContent`（共 4 种）；NewAPI 也支持 4 种入站（见 §1.3）。"唯一"不成立，改为"少数"。（来源：<https://docs.litellm.ai/docs/supported_endpoints>，2026-11-14 访问）

#### 7.0.1 统一响应结构：cost 进 usage、provider 字段暴露实际上游

据 [Usage Accounting 文档](https://openrouter.ai/docs/cookbook/administration/usage-accounting)（公开文档推断）：

- usage 除 token 外还带 `cost`（credits）、`is_byok`、`cost_details{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost, server_tool_cost}`、`server_tool_use_details{tool_calls_requested, tool_calls_executed, web_search_requests}`；
- token 细分 `prompt_tokens_details{cached_tokens, cache_write_tokens, audio_tokens, video_tokens}` / `completion_tokens_details{reasoning_tokens, audio_tokens, image_tokens}`；
- `cache_discount` 直接告诉你缓存省了多少（Anthropic cache write 是负 discount，cache read 是正）；
- **`usage: {include: true}` 与 `stream_options: {include_usage: true}` 已被废弃且无效**——"Full usage details are always included automatically"；
- 响应里的 `provider` 字段暴露**实际被路由到**的上游；
- `finish_reason` 归一为 `tool_calls | stop | length | content_filter | error`，**原文保留在 `native_finish_reason`**。

**对我们的直接启发（已落入设计）**：

1. **usage 永远全量自动返回**，不做 `include` 开关（[40-provider-adaptors.md](./40-provider-adaptors.md) §2、[25-streaming.md](./25-streaming.md) §8）；
2. **`finish_reason` 双留**：归一值 + 原文（[10-canonical-schema.md](./10-canonical-schema.md) §9.3 的 canonical 列即归一值，`raw` 存原文）；
3. **cost 归因细分**：我们的 `UsageRecord.cost` 拆成 input / output / cache_read / cache_write / reasoning / builtin_tools / external 七项，与此对应（[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §3）；
4. **per-generation 异步对账端点** `GET /generation?id=...` → 我们的 `/ag/usage/request/:id`，用于"流式结束时 usage 缺失"的事后补账。

#### 7.0.2 Provider routing 偏好参数与我们的路由阶段对应

据 [Provider Selection 文档](https://openrouter.ai/docs/guides/routing/provider-selection.md)（公开文档推断）：

| OpenRouter | 语义 | AgentGateway 对应 |
|---|---|---|
| `order` | provider 有序列表 | `attempt_plan`（[20-pipeline.md](./20-pipeline.md) §S2） |
| `allow_fallbacks` | 是否允许 fallback | 重试/fallback 矩阵（[20-pipeline.md](./20-pipeline.md) §7.3） |
| `require_parameters` | **只路由到支持你全部参数的 provider；不满足则请求失败** | **直接采纳**：`on_unsupported: "error"`（[20-pipeline.md](./20-pipeline.md) §S4）。这是"要么硬失败、要么明确知道会丢，绝不静默降级" |
| `max_price{prompt, completion, request, image, audio}` | 超了就不跑 | Tier-1 预检：`is_priceable` + 预算上限（[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4） |
| `sort: price / throughput / latency`，`{by, partition}` | 排序策略 | `attempt_plan` 排序键；p50/p75/p90/p99 分位阈值来自我们的 `RequestTrace` 聚合 |
| `preferred_min_throughput` / `preferred_max_latency` | 5 分钟滚动窗口分位 | 同上 |
| `only` / `ignore`、`quantizations`、`zdr`、`data_collection` | 白/黑名单、数据保留策略 | 虚拟 key 级 provider 白名单；`zdr` 类需求映射到我们的"不落 Tier-2" |
| sticky routing（account × model × conversation，60 分钟不活动过期） | 保 prompt cache | **采纳**：`session_key`（[30-plugin-api.md](./30-plugin-api.md) §4.3）同时服务压缩状态与缓存粘性 |

**其默认路由的 6 个生产信号**——effective price（反映真实 cache hit 率与 token mix）、throughput、TTFT、429 率、reliability、quality（"provider 的 tool calls 是否形态良好"）——正是我们 `RequestTrace` 要采集的字段集（[20-pipeline.md](./20-pipeline.md) §7）。

#### 7.0.3 对各家 quirks 的吸收方式 = raw passthrough 的现实参照

据公开文档（[Compatibility](https://openrouter.ai/docs/guides/features/compatibility.md)、[Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens.md)、[Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching.md)）：

- **透传**：实现了 OpenAI 接口的 provider，tools 原样下发；
- **归一**：自定义接口的 provider，transform + map properties；再不行把 tools 转成 **YAML template**；
- **丢弃 + 明示**：模型不支持的参数（如非 OpenAI 模型的 `logit_bias`、OpenAI 的 `top_k`）**静默忽略**——这是我们不采纳的一点，改用 `dropped_capabilities` + `warnings` 显式记录；
- **TTL 不翻译**：`cache_control.ttl` → OpenAI 被 drop；`prompt_cache_breakpoint.ttl` → Anthropic/Google 被 drop。这是"cache 语义不可跨格式无损翻译"的实证，我们的 `CacheControl` 因此把 `ttl` 与 `cache_name` 都建模并在映射表里标注为"可能被丢弃"（[10-canonical-schema.md](./10-canonical-schema.md) §4.4）；
- **统一 reasoning 参数** `{effort | max_tokens | enabled | exclude | summary | context | mode}`，配 per-model 能力声明（`GET /api/v1/models` 返回 `reasoning{supported_efforts, default_effort, default_enabled, supports_max_tokens, mandatory}`）——**这正是我们 `ThinkingConfig` 的设计蓝本**（[10-canonical-schema.md](./10-canonical-schema.md) §4.4），且 per-model 能力声明应进我们的能力矩阵；
- **mid-conversation effort update**："三种 API 各有原生形态，归一成一种内部表示再按目标 provider 重新发射"——Responses 用 `configuration_update` item、Chat 用 content-less system message 上的扩展字段、Anthropic 用 system message 上的 `output_config.effort`。**这是"一种 canonical、N 种 wire 形态"的最佳实证**，我们的 canonical 应把 `thinking.effort` 建模为可出现在任意位置的消息级指令。

#### 7.0.4 `/api/v1/models` 作为早期公开数据源

OpenRouter 的 `GET /api/v1/models` 返回模型元数据 + 定价 + per-model reasoning 能力声明。**结论：可以作为 Phase 0/1 的早期公开数据源**，用于：

1. **单价表种子**：避免从零手抄 100+ 模型的定价；但必须标注来源与抓取时间，并允许本地覆盖（我们的定价表独立版本化，见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4.1）；
2. **能力矩阵种子**：`reasoning` 能力声明、上下文长度、支持的特性可直接灌进能力矩阵初版；
3. **计费校准基准**：我们的 `cost` 计算可与 OpenRouter 的 `cost` 字段对比，验证归一规则是否正确（尤其是 cache 双算问题，[40-provider-adaptors.md](./40-provider-adaptors.md) §2.2）。

**约束**：这是第三方商业数据，许可与使用条款需在 [docs/sources.md](../sources.md) 记录；不得把它当唯一真源（它会变），必须可被本地覆盖。

### 7.1 中间表示：自建 AG-IR，不以任何厂商格式为枢轴

**结论**：自建显式超集 + raw passthrough。
**理由**：见 §1.1。llm-bridge 的 `_original` 只在"来源==目标且未改动"时整体回填，跨 provider 是启发式打分，且不回读顶层未知字段（[docs/sources.md](../sources.md) §llm-bridge）；llmshim 明确放弃 canonical IR，"each provider maps only what it understands"。
**借鉴**：llm-bridge 的 per-element `_raw` 形状；llmshim 的 schema 归一化与计费不变式。

### 7.2 插件系统：generic hook + adaptor 模式

**结论**：5 个 hook，操作对象只有 canonical。外部能力经 adaptor 接入。
**理由**：**没有现成开源项目提供"格式无关（只面向 canonical）的插件 hook"**——llm-bridge 只有单函数回调；llmshim 只有 Rust trait + cargo feature；Api-Conversion 是 Web 产品；agentgateway 有 CEL/ExtProc/webhook 但都挂在**具体协议的字节**上（见 §1.2 表）；LiteLLM 有 `async_pre_call_hook` 等，同样只看到"这一次调用的 OpenAI 形态请求/响应"，看不到"这次请求原本是 Anthropic 格式、带 1h ephemeral cache 断点"。这才是真实空白。
**首个插件**：billion-context adaptor。集成对象是它内部的 `acp-kernel` 纯函数内核（`processTurn` / `applyCompression`），**不是**它的 HTTP 代理形态——代理形态自带端口/会话路由/凭据，与网关重叠会双压缩。详见 [30-plugin-api.md](./30-plugin-api.md) §4 与 [docs/sources.md](../sources.md) §billion-context。

### 7.3 WebUI：fork LibreChat（MIT）

**结论（review #8.5 次要项，作者已拍板定稿）**：**维持 fork LibreChat** 改造，自建 gateway 管理模块补上它没有的 virtual key / provider / routing 管理。

**MongoDB 作为独立服务/容器部署，网关核心不依赖它**：LibreChat 的 MongoDB 是它自己的硬依赖，与网关核心的"SQLite 单文件"是两套存储。部署时 MongoDB 跑独立容器/服务，**网关核心（SQLite 单文件）不依赖它**——WebUI 未部署或挂掉时，网关的数据面、计费管道、dog-fooding 接口全部照常工作。两边只在 WebUI 需要展示时经网关 REST 交互，不共享数据库文件、不共享连接。

**理由**：

1. **许可证**：纯 MIT，fork/rebrand/深度改造零摩擦。Open WebUI 自 v0.6.6 起是 "BSD-3 + 品牌条款"，官方明确"不是 OSI 认证的 open source"且"co-branding 任何形式均被禁止"，>50 用户/30 天必须保留其品牌或买企业授权——与"重度定制的私有产品"直接冲突。LiteLLM UI 是 MIT 但 SSO>5 人付费、不能改主题色。agentgateway UI 是 Apache-2.0 但只有 Playground、无通用 agent 前端。
2. **唯一原生建模 cache 计费**：`tokenConfig` 显式提供 `cacheRead` / `cacheWrite` / `cacheWrite1h` 单价 + `balance` 额度体系，直接对上我们的多单位计费需求。
3. **dogfooding 闭环最短**：Agents + MCP + OpenAPI Actions + command hooks，包一个 MCP server 指向我们的 usage API 即可。

**代价**：Node/React + MongoDB 必选（独立容器）；版本迭代极快（0.8.x）；Admin Panel 是独立服务。**Meilisearch 列为可选**（LibreChat 的 RAG 检索后端，本项目 strip RAG 后默认不需要）。裁剪清单见 [docs/sources.md](../sources.md) §UI。

**SSPL 合规立场（review #8.5，作者已拍板定稿）**：MongoDB 的 SSPL 只约束"把 MongoDB 本身作为服务对外提供"；本项目是**私人自托管、自用**，不对外提供 MongoDB 服务，**可接受**。
**Revisit 触发条件**（满足任一条即重新评估，评估结论可能是换 WebUI 方案或换它的存储）：

1. 仓库将来**公开/开源**（含把 LibreChat fork 推公开）；
2. 把 WebUI 或网关作为**托管服务**对多人开放（而非单用户私用）；
3. LibreChat 上游变更，要求引入 MongoDB 之外的 SSPL 组件，或其 license 从 MIT 变更。

### 7.4 存储：SQLite + 整库加密 + payload 列应用层信封加密（双层）

**结论**：单文件 SQLite，**两层加密**——① 整库加密 `better-sqlite3-multiple-ciphers`（`PRAGMA cipher='chacha20'`，sqleet/AEAD）；② payload 列（消息内容、媒体二进制）额外用应用层 **XChaCha20-Poly1305**（192-bit 随机 nonce，不做计数器持久化）信封加密，**AAD 绑定 `request_id + ir_version`**。DEK 随机生成、用 KEK 包裹（信封加密）后存入密钥表；KEK 由 Argon2id 从用户口令派生，密钥三档来源，无人值守默认 OS keyring 档。完整对比、密钥层次与轮换见 [65-storage-and-retention.md](./65-storage-and-retention.md)（**决策 S1**、§3.1）。
**理由**：

1. 整库加密覆盖"数据库文件被拷走"的全部场景（含 WAL、临时表、索引泄漏的元数据）；
2. 列级信封加密覆盖"整库密钥不得不常驻内存"的残余风险——即使库被打开，敏感列仍解不开；同时让**备份/迁移可以只导密文**，以及支持将来换算法而不重写整库；
3. SQLite 单文件对"单机私有用例"是运维成本最低解：无额外服务、无连接池、备份就是拷文件。
**诚实的边界：任何方案都防不住「读运行中进程内存」，无人值守自动解锁的本质是用「无人值守」换「离线泄露防护」**（场景对比表见 [65-storage-and-retention.md](./65-storage-and-retention.md) §3.2b）。

> **口径校正（review #2(a)）**：本节原写"只做应用层逐记录加密，**不选** SQLCipher / libsql 这类整库加密"，与决策 S1 的"双层"相反，且与 [docs/sources.md](../sources.md) §4、[70-roadmap.md](./70-roadmap.md) Phase 4 都矛盾。已按 **S1（双层）** 统一；SQLCipher 降级为"整库加密的备选"（同包内一行 PRAGMA 可切），libsql 仍否掉（加密 experimental + 不支持 key rotation）。AAD 也统一为 `request_id + ir_version` 一种写法（原 00 写"记录 id"、65 写"request_id + schema 版本"、65 §3.1 写"request_id + ir_version"、60 写"request_id"、65 §5.5 写"id + session_key + turn_index"）。

### 7.5 消息内容持久化：默认关闭 + 前缀压缩

**结论**：`persistence.messages` 默认 `off`；开启后按会话存 delta 链 + zstd **全局字典**（可选按客户端类型变体，离线训练、带版本号、入库加密；per-session 字典已取消，见 [65-storage-and-retention.md](./65-storage-and-retention.md) §5.2）。
**理由**：同一会话连续请求共享极长公共前缀（system + 历史），naive 存全量是 O(N²)。delta 链 + 字典预计在"每轮存全量"基础上再降 10–50×（量级估计，需实测）。

### 7.6 搜索后端：searxng 优先

**结论**：默认自托管 searxng，保留 `custom_http` 接内部检索服务；托管 API（Tavily/Exa）作可选增强，key 走环境变量。
**理由**：隐私优先（查询词不出本机）+ 零边际成本。详见 [50-builtin-search.md](./50-builtin-search.md)。

---

## 8. Open Questions（跨文档汇总）

各文档内部还有更细的 Open Questions，这里是跨文档的、影响面最大的：

> **编号规则（review #5 后统一）**：Q 编号是**全局唯一**的。00 §8 只收录影响面最大的一部分；其余分布在各篇：
> Q11–Q20 见 [10-canonical-schema.md](./10-canonical-schema.md) §10，Q31–Q42 见 [12-coverage-survey.md](./12-coverage-survey.md) §5。
> 各篇正文里的 Open Questions 一律引用全局 Q 编号，**不要另起一套本地编号**；发现编号冲突以本节为准。

| # | 问题 | 影响 | 归属文档 |
|---|---|---|---|
| Q1 | 各 provider `input_tokens` 是否已含 cache read 部分 | 计费双算/少算 | 40-provider-adaptors.md |
| Q2 | OpenAI Responses 的 `reasoning` item 多轮回传规则（`store:false`/ZDR 下是否仍必须回传） | chat 多轮保真 | 10-canonical-schema.md |
| Q3 | Gemini `functionCall` 旧版是否仍无 id；`functionResponse` 匹配机制 | 工具循环 | 40-provider-adaptors.md |
| Q4 | TTS/ASR/Image 各家 usage 原始字段（按字符/秒/张/token 的口径） | 多单位归一 | 15-modalities.md §10 |
| Q5 | zstd 全局字典在真实 trace 上的压缩率与离线训练耗时 | 存储设计 | 65-storage-and-retention.md §5.2 |
| Q6 | Argon2id 在目标硬件的实测耗时（决定启动解锁延迟） | 密钥档位选择 | 65-storage-and-retention.md §3.2 |
| Q7 | billion-context 的 `acp-kernel` npm 版（0.0.101）与 vendored 版（0.0.197）API 差异 | 插件实现 | 30-plugin-api.md §6 |
| Q8 | `additionalProperties: false` 是否会因 provider 加字段而频繁报错 | schema 严格度 | 10-canonical-schema.md |
| Q9 | LibreChat transaction schema 是否含 reasoning / cache 实际计量值 | WebUI 改造量 | docs/sources.md §3 |
| Q10 | Anthropic 1h / 5m ephemeral cache 在 usage 里是否分字段返回（§2.2 已记录"已确认"，本条降级为复核项） | cache 计费 | 40-provider-adaptors.md |
| Q25–Q30 | decision：部分失败语义 / OpenAI 专属限额与错误码 / Jev 图片 opt-in 头经网关的行为 / Gemini 区域清单 / 聚合校准度是否等于可用阈值 | decision adaptor 细节 | 40-provider-adaptors.md §6、12-coverage-survey.md §5.1 |
| — | ~~Q21–Q24~~ **已由本次调研解答**（三家字段名、免费额度、单向能力、降级代价均有官方/实测依据；40 §8 与 sources.md §7 里仍列为开放的副本已同步改为"已解答"） | — | 12-coverage-survey.md §5.1 |

> 每条的验证方式写在对应文档的"待验证清单"里。

---

## 9. Review 指引（给 reviewer）

如果要攻击这套设计，优先级最高的三个点：

1. **§7.1 自建 canonical 而非枢轴格式**——这是最大的工作量来源。如果认为"OpenAI 格式 + 补丁"够用，整套 IR 的存在意义就要重估。
2. **§7.4 双层加密中"整库 + 列级"的分工**——影响备份/迁移/查询能力；已按决策 S1 统一，若要改回"只做应用层"必须同时改 65 S1、sources.md §4 与 70 Phase 4。
3. **[25-streaming.md](./25-streaming.md) §1 的兼容性矩阵**——"桥接不了就拒绝"的取舍是否过严。

次优先：fast path 与插件需求的冲突消解（[20-pipeline.md](./20-pipeline.md) §4.1/§4.2——S1 信封级惰性解析 + 插件 manifest `scope` 准入）、多单位 usage 的计费复杂度（[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4）。
