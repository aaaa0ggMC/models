# 调研来源与结论（sources）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 本文件是 AgentGateway 设计文档（[docs/design/](./design/)）的全部调研依据。
> 每条结论标注「已确认」（读过官方文档/源码/API 原文）或「待验证」（推断或文档未明说）。
> 数据抓取时间均为 2026-11-14（UTC）。

---

## 0. 文档入口技巧（后续调研复用）

- **OpenAI**：platform.openai.com 已迁移至 developers.openai.com；任意页面 URL 后加 `.md` 可得 Markdown 全文（curl 可直接抓）。入口 <https://developers.openai.com/llms.txt>
- **Anthropic**：docs.anthropic.com / docs.claude.com 均 301 到 platform.claude.com；`.md` 后缀可用。API 版本头 `anthropic-version: 2026-10-21`。入口 <https://platform.claude.com/docs/en/api/messages/create>
- **Gemini**：ai.google.dev 已迁移至 aistudio.google.com；`.md` 与 `?generate-content=true` 可用。入口 <https://aistudio.google.com/llms.txt>

---

## 1. 格式细节（四家 chat 格式 + 多模态）

**状态：已确认（官方文档）。** 这是 [10-canonical-schema.md](./design/10-canonical-schema.md) §9 与 [40-provider-adaptors.md](./design/40-provider-adaptors.md) §2 的直接依据。

### 1.1 关键结论

| 主题 | 结论 |
|---|---|
| OpenAI Chat Completions | `reasoning_effort` 默认 `medium`（取值 `none\|minimal\|low\|medium\|high\|xhigh\|max`）；`tool_choice` 新增 `{type:"allowed_tools",mode,tools}` 与 `{type:"custom",...}`；`tools[]` 新增 `custom` 类型（`format: text\|grammar`）；`web_search_options{search_context_size,user_location}` 存在；usage 含 `prompt_tokens_details.cache_write_tokens` 与 `cache_write_tokens_details.{ttl_12h_tokens,ttl_30m_tokens}` |
| OpenAI Responses | 30+ input item 类型、16 种 tools；`function_call` item 同时有 `id`（item 标识）与 `call_id`（回传用）；`reasoning` item 必须随 tool 输出一起回传（含 `encrypted_content`）；`reasoning{context:"auto"\|"current_turn"\|"all_turns", effort, summary:"auto"\|"concise"\|"detailed"}`；`context_management[{type:"compaction",compact_threshold}]`；`conversation` 参数；`store` 默认 **true** |
| Anthropic Messages | **API version `2026-10-21` 移除 `temperature`/`top_p`/`top_k`（发送即 400）**；`thinking.type` 演进到 `"adaptive"`；新增 `output_config{effort,format:{json_schema}}`、顶层 `cache_control`、`container`、`diagnostics`、`speed`、`service_tier`；`stop_reason` 全枚举含 `model_context_window_exceeded` / `refusal` / `pause_turn`；usage 含 `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`（**已确认分字段**）、`output_tokens_details.thinking_tokens`、`server_tool_use.web_search_requests`；**总输入 = input + cache_creation + cache_read** |
| Gemini generateContent | **`functionCall` 新版有 `id`**；函数回环要求"每个 step 的第一个 functionCall Part 必须带回 `thoughtSignature`，否则 400"（finishReason 出现 `MISSING_THOUGHT_SIGNATURE`）；`thinkingConfig{includeThoughts,thinkingBudget,thinkingLevel}`（`thinkingBudget` 与 `thinkingLevel` 同传 400）；`temperature`/`topP`/`topK` 在 Gemini 3.6 Flash+ **静默忽略**；显式缓存（`cachedContents`）不支持 Gemini 4 / Interactions API；`finishReason` 20+ 枚举；`usageMetadata.promptTokenCount` **含缓存部分**；新增 `promptTokensDetails[]`/`candidatesTokensDetails[]` 按 modality 拆分；新增 Interactions API（有状态，`previous_interaction_id`） |
| 近期弃用 | OpenAI：`max_tokens`→`max_completion_tokens`、`system`→`developer`(o1+)、`functions`/`function_call`→`tools`/`tool_choice`、`user`→`safety_identifier`+`prompt_cache_key`、`prompt_cache_retention`→`prompt_cache_options.ttl`、`reasoning.generate_summary`→`reasoning.summary`、`mcp.connector_id`（2026-09-01 后模型弃用）。Anthropic：`web_search_20250305`→`20260209`→`20260318`、`code_execution` 多版本、`computer`→`computer_toolset_20260801`。Gemini：`googleSearchRetrieval`→`googleSearch`（前者仍在 API reference，未见显式弃用声明）、`thinkingBudget`→`thinkingLevel` |

### 1.2 来源

- OpenAI Chat Completions API reference：<https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>
  （**链接已修**：原地址 `.../resources/chat/completions/methods/create` 2026-11-14 实测返回 **404**；OpenAI 把 chat 改成了 `chat` 资源下的 `completions` 子资源。当前入口索引 <https://developers.openai.com/api/reference/llms.txt>）
- OpenAI Responses API reference：<https://developers.openai.com/api/reference/resources/responses/methods/create>
- Anthropic Messages API reference（`anthropic-version: 2026-10-21`）：<https://platform.claude.com/docs/en/api/messages/create>
- Gemini generateContent API reference：<https://aistudio.google.com/api/reference/rest/v1beta/models/generateContent>（入口 <https://aistudio.google.com/llms.txt>）
- Gemini function calling 指南（交叉验证 `functionResponse` 用 `role:"user"`）：<https://aistudio.google.com/llms/function_calling>
- 文档索引：<https://developers.openai.com/llms.txt>、<https://platform.claude.com/docs/en/api/messages/create>、<https://aistudio.google.com/llms.txt>

### 1.3 待验证

1. OpenAI `prompt_tokens` 是否已含 `cached_tokens`（Gemini 已确认含、Anthropic 已确认不含；OpenAI 文档未明说）。
2. Gemini 旧版 API 的 `functionCall` 是否仍无 `id`。
3. Anthropic `output_config.effort` 与 `thinking` 的 per-model 组合限制（来自指南文字，未在 API reference 逐条列出）。
4. `googleSearchRetrieval` 是否已正式废弃。
5. 模型 ID 清单随时间变动，网关应动态拉取而非硬编码。

---

## 2. 竞品与参考实现

### 2.1 llm-bridge（supermemoryai）— 借鉴类型形状

**状态：已确认（读了源码）。**

- Repo <https://github.com/supermemoryai/llm-bridge> ｜ npm `llm-bridge` ｜ **MIT** ｜ TS ｜ 零运行时依赖 ｜ v2.0.1 ｜ 325 stars ｜ 单维护者 ｜ 最后 push 2026-10-02。
- universal format 类型（`src/types/universal.ts`）：<https://raw.githubusercontent.com/supermemoryai/llm-bridge/main/src/types/universal.ts>
- `_original` 机制（`src/models/openai-format/index.ts`）：<https://raw.githubusercontent.com/supermemoryai/llm-bridge/main/src/models/openai-format/index.ts>

**关键结论**：

1. `_original` 是 **fast path 短路**，不是无损档案——只有「目标 provider == 来源 provider 且消息数组未被改动」时才整体返回原始 body（引用相等）。跨 provider 时 `getReconstructionQuality()` 返回 80–99 的启发式分。
2. **已定位三处真实跨 provider 有损**（源码推理，建议复现测试）：
   - `openaiToUniversal` 用 `messages.find(m => m.role === "system")` 只取**第一条** system message，其余全部丢弃；
   - `parseOpenAIToolCalls` 把畸形 JSON 存进 `metadata.raw_arguments`，但 `universalToOpenAI` 重建时只 `JSON.stringify(tc.arguments)`（此时是 `{}`），**从不回读** → 畸形 tool 参数被静默销毁；
   - `universalToOpenAI` 直接 filter 掉 `thinking` / `redacted_thinking`，而类型注释明写 Anthropic 的 `signature` 是 multi-turn 必需。
3. 作为服务端网关的弱点：无插件系统（只有 `editFunction` / `transform` 两个函数回调）、非流式与流式是两条独立入口、多轮 tool loop 未内置、无鉴权/限流/重试/熔断/持久化/计费。
4. 其 `ObservabilityData`（`tokensSaved` / `costSavedUSD`）是**为上下文注入省钱设计的遥测，不是计费账本**；token 数是估算值。

**→ 对我们的启示**：借鉴 per-element `_raw` 形状与 `reconstructionQuality` 指标，但把「raw 无损保留」做成**硬约束**（含顶层未知字段），而不是一条 `provider === provider` 的相等判断。40-provider-adaptors.md §1.5 的 6 条 round-trip 测试里有 3 条直接针对上面三个缺陷。

### 2.2 llmshim（Rust）— 借鉴三块高质量工程

**状态：已确认（读了源码）。**

- Repo <https://github.com/sanjay920/llmshim> ｜ crate `llmshim` ｜ **Apache-2.0 OR MIT** ｜ Rust ｜ v0.31.0（pre-1.0）｜ **3 stars / 0 forks** ｜ 创建 2026-03-08 ｜ 日更。
- Trait 设计（`src/provider.rs`）：<https://raw.githubusercontent.com/sanjay920/llmshim/main/src/provider.rs>
- Schema 归一化（`src/schema/mod.rs`）：<https://raw.githubusercontent.com/sanjay920/llmshim/main/src/schema/mod.rs>
- 计费（`src/cost.rs`）：<https://raw.githubusercontent.com/sanjay920/llmshim/main/src/cost.rs>
- 错误处理（`src/error.rs`）：<https://raw.githubusercontent.com/sanjay920/llmshim/main/src/error.rs>

**关键结论**：

1. **明确放弃 canonical IR**。README 原话："No canonical struct. Requests flow as `serde_json::Value` — each provider maps only what it understands." 只做"以 OpenAI Chat 为枢轴的服务端协议翻译"。
2. `Provider`（语义）/ `RequestTransport`（鉴权 + 流帧）二分；`prepare_authorization` 返回一次性 signer、在 admission 之后才签名——"slow credential traffic cannot leave unsent liabilities"。
3. **默认「按名拒绝」**：`transform_embedding_request` 默认 `Err(embeddings::absent(...))`，源码注释："a vector from a model the caller did not name is the wrong answer, silently."
4. **Schema 归一化是最值得抄的一块**：per-target `Options`（nullable/oneOf/lookaround/strict/max_depth 96/max_nodes 32768）、**per-tool fallback 而非 per-request**、`RequestBudget`（超限 400）、memo cache（50 tools 559µs → 210µs，2.66×）、可逆 output wrapping（`{"type":"object","properties":{"response":<schema>}}`）、MCP 入口归一、env kill-switch。
5. **计费不变式**："**An absent price is never zero**"（`Option<f64>`，绝不用 0.0 表示未知）；`cost_source` 三级 provenance（`provider` / `provider_floor` / `catalog`）；input 按 `uncached_input_tokens` 计费避免缓存双算；缺 cache 价时取该模型最高已发布价（高估不低估，否则 spend cap 静默失效）；`is_priceable()` 请求前预判。
6. `retry_after` 进 error 类型、收到即解析；`reqwest::Error::without_url()` 防 URL（可能带 key）泄漏；`AllFailed(Vec<String>)` 收拢 fallback 链全部错误。
7. **无插件系统**（全树检索无 hook/plugin/middleware 模块），扩展只能 Rust trait + cargo feature。
8. 公共 proxy API 不是 OpenAI-shaped（`POST /v1/chat` 等）。

**→ 对我们的启示**：抄 schema 归一化（[40-provider-adaptors.md](./design/40-provider-adaptors.md) §4）、计费不变式（[60-billing-and-dogfooding.md](./design/60-billing-and-dogfooding.md) §4）、Provider/Transport 二分与"按名拒绝"（[40-provider-adaptors.md](./design/40-provider-adaptors.md) §1.7）。**不整体依赖**（3 stars、pre-1.0、bus factor 1）。

### 2.3 billion-context / acp-kernel — 首个插件的集成对象

**状态：已确认（读了源码、LICENSE、npm、GitHub API）。**

- Repo <https://github.com/ranxianglei/billion-context> ｜ npm `billion-context` v0.1.213 ｜ CLI `bili` ｜ TS ｜ Node ≥ 20。
- 内核独立仓库 <https://github.com/ranxianglei/acp-kernel>（npm `acp-kernel` latest **0.0.101**；主仓库 vendored `kernel/` 是 **0.0.197**）。
- **License：MIT + 一条强制署名附加条款**（GitHub 识别为 `Other`/NOASSERTION）。附加条款要求：任何终端用户可见或可交互的产品/服务（商业或开源）**必须在首页/文档/About-Credits 之一显著标注使用了 acp-kernel（涉及时包括 billion-context）并附仓库链接**；纯服务端/内嵌用途"随附文档中包含上述声明即可"。→ **商业使用允许，署名是强制义务。**
- 热度：7,274 stars / 602 forks / **1,093 open issues** / npm 周下载 786,234 ｜ 单人维护 ｜ 日更 ｜ README 自评 "**Status: Early** ... Expect rough edges" 且 "`master` is the development branch and can be broken at any moment"。

**关键结论**：

1. **形态是「HTTP 代理 + 客户端插件」系统，不是纯函数库**；但内部 vendored 的 `acp-kernel` 是**框架无关、零运行时依赖、自身绝不调用 LLM** 的纯函数内核——这才是该集成的东西。
2. 算法：**模型驱动的分层增量折叠（fold）+ 3-tier LSM**。9 段每轮纯函数管线（assign-refs → sync-blocks → merge-blocks → prune → filter → hide-compress-calls → nudge-inject → emergency-truncate → render-refs）。`processTurn({messages, state, config, tokenCount}) → {messages, state, nudge}` 无 I/O、无存储 port、无 LLM port，只向 host 要一个 `countTokens`。
3. **首条 user 消息硬钉住**（即使被覆盖也原文保留），因 Anthropic 等严格 provider 拒绝无 user 消息会话——任何"压缩后消息数应减少 N"的断言都会错。
4. CCR（content-cached retrieval）：≥4000 token 的 tool result 外载到 content store，可见副本换成确定性占位符，replace-once-at-arrival、字节稳定、**前缀缓存友好**。
5. **摘要文本由模型写**（通过注入 `compress`/`decompress`/`search_context`/`acp_status` 四个工具），或 preflight 兜底。内核免费，**摘要不免费**。
6. **`npm install billion-context` 不暴露内核 API**（tsup noExternal 内联）——要内核必须单独装 `acp-kernel` 或 vendor `kernel/src`。
7. 已定位多条正确性缺陷（open issues）：#6352 compress 可能折叠**正在生效的历史内 system prompt**；#6105 `[bili-compress-directive]` 的 Target span 起点比推荐范围早一条，照指令执行必被 guard 拒绝；#6075 图片折叠锚点只比较 `[image]` 占位文本；#6328 行形式 compress 的 `splitLineEntries` 会把摘要正文里以 ref 对开头的行当成下一块头行；#6628 compress loop 丢弃的 upstream response body 不取消（连接泄漏）。
8. 作者自报生产遥测：4.5 个月 / 3 宿主 / 174,327 次模型调用 / 18.76B 累计输入 token / 204,800 窗口零违规 / 马拉松会话 8,584–12,049 次调用 / 活跃节奏下 cache-read 占比 94.2% / 单次压缩输出中位数 185 token。**单一作者自报，非第三方复核。**
9. 第三方基准（仓库内 benchmarks/third-party-1500，v0.1.202，500 题×3）：ContextBench Utilized F1 0.3097 第一、成本比 full 低 58.3%；LongMemEval-S 79.20% vs full 83.20%、比最强 RAG 高 16.6%；MemoryAgentBench 1.48M token TTL 100% 存活但 verbatim needle QA 从 69.0% 掉到 27.0%。
10. **tagline 的 "5× fewer tokens" 与论文受控实验的 31–54% billed 削减不一致**——设计文档不引用 5×。
11. `defaultCountTokens` 论文自报**低估约 15%**——计费必须用上游 usage，估算只能用于触发决策。

**→ 对我们的启示**：集成 `acp-kernel` 内核而非 bili 代理；插件接口按 `processTurn`/`applyCompression`/`decompress`/`search`/`status`/`retrieve` 形状设计；「摘要产生器」做成可插拔 port；必须自建三件事：稳定 conversation id 注入与粘性路由、上游 usage 回填的 token 会计、宿主自动压缩的抑制开关。详见 [30-plugin-api.md](./design/30-plugin-api.md) §4。

**替代/对照方案**：

- Anthropic context editing + memory tool（宿主/SDK 责任，tool-result 级清除，无可逆分层 block）：<https://platform.claude.com/docs/en/build-with-claude/context-editing>、<https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool>
- OpenAI Responses `previous_response_id` + `store`（服务端状态，非压缩；省请求体大小与客户端重序列化，不省 token 计费）：<https://developers.openai.com/api/docs/guides/conversation-state>
- LLMLingua（token 级提示压缩，表示层，与 agent 多轮会话正交）：<https://github.com/microsoft/LLMLingua>、<https://arxiv.org/abs/2310.05736>
- 其他可引：MemGPT <https://arxiv.org/abs/2310.08560>；Mem0 <https://arxiv.org/abs/2504.19413>；Zep/Graphiti <https://arxiv.org/abs/2501.13956>；"The Compaction Cliff" <https://arxiv.org/abs/2608.22752>

### 2.4 Vercel AI SDK — 类型设计的极佳参考

**状态：已确认（读了源码与文档）。**

- Repo <https://github.com/vercel/ai> ｜ **Apache-2.0** ｜ 27,926 stars ｜ v7 文档 / `LanguageModelV4` spec ｜ 日更。
- spec 源码目录：<https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v4>

**关键结论**：

1. **三层消息类型分离**：`UIMessage`（应用态）→ `ModelMessage`（用户侧）→ `LanguageModelV4Prompt`（**内部规范**）。源码注释："This is **not** the user-facing prompt ... That approach allows us to evolve the user facing prompts without breaking the language model interface."
2. **`providerOptions` / `providerMetadata` 命名空间透传**（`Record<string, JSONObject>`），message 级与 part 级都能挂。官方理由："This enables us to quickly ship provider-specific functionality **without affecting the core AI SDK**."——**这是 canonical 应照搬的核心机制**。
3. **双留原则**：`finishReason{unified, raw}`、`usage{结构化, raw}`。
4. **warnings 机制**：`unsupported` / `compatibility` / `deprecated` / `other` 四类，通过 `stream-start` 事件与 `GenerateResult.warnings` 上报——"降级必须可见"。
5. **`LanguageModelV4Usage` 所有字段都是 `number | undefined`**（明确允许上游没给）+ `raw` 保留 provider 原始 usage。
6. `request.body` / `response.body` 直接把上游原始报文暴露出来（审计/replay 的现成钩子）。
7. **它既不是 Anthropic Messages 的超集，也不是 OpenAI Responses 的超集**：Anthropic 的 `system` block 数组、`cache_control` 位置语义、thinking `signature`、`caller`、`context_management`、`output_config.effort` 在 `LanguageModelV4Prompt` 里没有一等公民位置，只能塞进 `anthropic` 命名空间 providerOptions；Responses 的 item 模型（`reasoning` / `configuration_update`）也没有一一对应。
8. **是 client SDK，方向是 canonical→provider（出站）**；网关需要反方向（入站）。推荐姿势：只依赖 `@ai-sdk/provider` 的类型，自己写 inbound parser + outbound serializer。
9. **主要风险：spec 演进速度**（v3→v4、SDK 5→6→7 都是 breaking）——不能把 canonical 绑死在 AI SDK spec 上。

**→ 对我们的启示**：抄三层分离、命名空间透传、双留、warnings 四类；但 canonical 必须比 AI SDK 更激进（把 Responses item 模型与 Anthropic block 模型都收进来，或明确标 passthrough-only）。详见 [10-canonical-schema.md](./design/10-canonical-schema.md) 决策 D1–D3。

**参考的一个真实复杂度样本**：`packages/anthropic/src/convert-to-anthropic-prompt.ts`（72KB）——`groupIntoBlocks()` 把 user+tool 合并成一条 user message、`moveToolUseBlocksToEnd()` 处理 Anthropic 硬约束、`CacheControlValidator`（源码注释点名 "Prompt caching requires stable key ordering"）、`toAnthropicToolInput()` 把非法 JSON 包成 `{rawInvalidInput}`（**改变语义**）。<https://github.com/vercel/ai/blob/main/packages/anthropic/src/convert-to-anthropic-prompt.ts>

### 2.5 OpenRouter — 闭源商业系统，可参考其对外契约与路由语义

**状态：实现细节均为「公开文档 / API 行为推断」。核心系统（路由/网关/归一化）不开源。**

- 服务闭源："OpenRouter is a managed LLM gateway ... OpenRouter hosts it, so there is nothing to deploy or self-host." <https://openrouter.ai/llms.txt>
- 开源部分仅外围：`ai-sdk-provider`(Apache-2.0)、`typescript-sdk`、`python-sdk`、`openrouter-examples`、`tool-bench`、`skills` 等。<https://api.github.com/orgs/OpenRouterTeam/repos>
- **未在 org 仓库列表看到 `openrouter-runner`**（列表被截断，不能断言不存在）→ 待验证。
- OpenAPI spec 头部声明 `license: MIT`——这是 API 描述文件的许可，不等于服务实现开源 → 待验证其约束范围。

**关键结论（对外契约）**：

1. **同时提供 OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 三种入站格式**（`/api/v1/chat/completions`、`/api/v1/responses`、`/api/v1/messages`）；原写"唯一……商用网关"已删（review #4）：LiteLLM Proxy 同样支持这三种，还多一种 `/v1beta/models/{model}:generateContent`（共 4 种，见 §2.10）。<https://openrouter.ai/docs/api_reference/overview>
2. **usage 里除 token 还带 `cost`（credits）、`is_byok`、`cost_details{upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost, server_tool_cost}`、`server_tool_use_details{tool_calls_requested, tool_calls_executed, web_search_requests}`、`cache_discount`**。`usage:{include:true}` 与 `stream_options:{include_usage:true}` **已废弃且无效**——"Full usage details are always included automatically"。token 用模型**原生 tokenizer** 计。<https://openrouter.ai/docs/cookbook/administration/usage-accounting>
3. **响应 `provider` 字段暴露实际被路由到的上游**；`finish_reason` 归一为 `tool_calls|stop|length|content_filter|error`，**原文保留在 `native_finish_reason`**。
4. **provider routing 偏好参数**：`order`、`allow_fallbacks`、**`require_parameters`**（只路由到支持你全部参数的 provider；不满足则请求失败）、`max_price{prompt,completion,request,image,audio}`、`sort: price|throughput|latency` 或 `{by,partition}`、`preferred_min_throughput`/`preferred_max_latency`（数字或 `{p50,p75,p90,p99}`，5 分钟滚动窗口）、`only`/`ignore`、`quantizations`、`zdr`、`data_collection`。默认路由用 6 个生产信号：effective price（反映真实 cache hit 率与 token mix）、throughput、TTFT、429 率、reliability、quality。<https://openrouter.ai/docs/guides/routing/provider-selection>
5. **sticky routing**（account × model × conversation，60 分钟不活动过期；默认用"第一条 system/developer 消息 + 第一条非 system 消息"哈希做会话键；可用 `session_id` 或 `prompt_cache_key` 显式指定）。<https://openrouter.ai/docs/guides/best-practices/prompt-caching>
6. **quirks 吸收三档**：透传（实现 OpenAI 接口的 provider，tools 原样下发）/ 归一（自定义接口 transform + map）/ 再不行转成 **YAML template**。不支持的参数**静默忽略**（这是我们不采纳的一点）。
7. **统一 reasoning 参数** `{effort|max_tokens|enabled|exclude|summary|context|mode}`，配 per-model 能力声明（`GET /api/v1/models` 返回 `reasoning{supported_efforts, default_effort, default_enabled, supports_max_tokens, mandatory}`）。Anthropic `effort` → `budget_tokens = clamp(max_output_tokens * ratio, 1024, 128000)`，ratio = max/xhigh 0.95、high 0.8、medium 0.5、low 0.2、minimal 0.1；且 `max_output_tokens` 必须严格大于 reasoning budget。Gemini 3：`effort` → `thinkingLevel`（`xhigh` 映射成 `high`）。<https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
8. **mid-conversation effort update**："The three forms are interchangeable: OpenRouter normalizes each into one internal representation and re-emits it in the form the selected provider accepts." Responses 用 `configuration_update` item、Chat 用 content-less system message 上的扩展字段、Anthropic 用 system message 上的 `output_config.effort`。
9. **cache TTL 不翻译**："a `cache_control` `ttl` is dropped toward OpenAI, a `prompt_cache_breakpoint` `ttl` is dropped toward Anthropic or Google, and the request-level `prompt_cache_options` stays OpenAI-only"。
10. **server tool 预算**：`max_tool_calls`（默认 30 上限）+ `stop_server_tools_when`（含 `{type:"max_cost", max_cost_in_dollars:0.5}` 这种"成本即停止条件"）。web search 作为 server tool 的多引擎抽象（`auto/native/exa/firecrawl/parallel/perplexity`）+ 域过滤 + `search_context_size`/`max_characters` + `max_uses`/`max_total_results`。
11. **`GET /api/v1/generation?id=...`** per-generation 异步对账（注意 `upstream_inference_cost` 仅 BYOK 请求可用）。
12. 已知坑：reasoning tokens 计入 `max_output_tokens`，吃光预算返回 `incomplete` 且**照常计费**；`reasoning_details` 必须原样回传不能重排。

**→ 对我们的启示**：见 [00-overview.md](./design/00-overview.md) §7.0 的完整分析（统一响应结构 / 路由参数对应 / quirks 吸收 = raw passthrough 的现实参照 / `/api/v1/models` 作为早期公开数据源）。

**`/api/v1/models` 作为早期数据源**：返回模型元数据 + 定价 + per-model reasoning 能力声明。**结论：可作为 Phase 0/1 的早期公开数据源**，用于单价表种子、能力矩阵种子、计费校准基准。约束：第三方商业数据，许可与条款需记录；不得当唯一真源，必须可被本地覆盖。

### 2.6 NewAPI / one-api — 根本分野的对照

**状态：已确认（下载两仓库 main 分支完整源码本地阅读 + `gh api` 元数据）。**

- NewAPI main HEAD `b388140acfd80369ec6243b16869daff1b4051f4`（2026-11-13）；one-api main HEAD `8df4a2670b98266bd287c698243fff327d9748cf`（2026-02-21）。
- 下文 `[NEW:path]` / `[ONE:path]` 分别表示下面两个 raw 源码根（把 `<path>` 换成仓库内的文件路径即可）：
  - NewAPI：`https://raw.githubusercontent.com/QuantumNous/new-api/b388140acfd80369ec6243b16869daff1b4051f4/`
  - one-api：`https://raw.githubusercontent.com/songquanpeng/one-api/8df4a2670b98266bd287c698243fff327d9748cf/`

  （原写法把完整 URL 内联进一句话，其中的 `<path>` 占位符既触发 markdownlint 的 MD033，URL 又是裸链触发 MD034；拆成子列表 + 行内代码后两条都干净，lychee 也能逐个校验。）

**成熟度**（`gh api` 2026-11-14）：

| | NewAPI | one-api |
|---|---|---|
| Stars / Forks / Open issues | 51,894 / 12,660 / 1,458 | 37,430 / 6,893 / 1,045 |
| License | **AGPL-3.0 + Section 7 附加条款** | MIT |
| Latest release | `v1.0.0-rc.51`（2026-11-13） | `v0.6.10`（2025-02-02） |
| 最后 push | 2026-11-14 | 2026-01-09 |

**架构（已确认，源码）**：

- **inbound 支持 4 种协议**：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`（Anthropic）、`/v1beta/models/*:action`（Gemini）。Anthropic/Gemini 的 inbound 入口是 NewAPI 相对 one-api **新增**的（one-api 的 `router/relay.go` 只有 OpenAI 形态 + `/engines/:model/embeddings`）。
- **没有 canonical IR**，是一张 N×M 成对转换器图，**hub 是 OpenAI Chat**。转换层抽成独立 Go module `relaykit`（[NEW:relaykit/README.md](https://raw.githubusercontent.com/QuantumNous/new-api/b388140acfd80369ec6243b16869daff1b4051f4/relaykit/README.md)）：成对转换器注册表 + **质量分级** + 诊断 + 多跳路由。矩阵：Chat→Responses good、Chat→Claude fair、Chat→Gemini fair、**Claude→Gemini discouraged**（经 OpenAI Chat 两跳）。
- `Adaptor` 接口 16 方法（[NEW:relay/channel/adapter.go](https://raw.githubusercontent.com/QuantumNous/new-api/b388140acfd80369ec6243b16869daff1b4051f4/relay/channel/adapter.go)），含 `ConvertClaudeRequest` / `ConvertGeminiRequest` / `ConvertOpenAIResponsesRequest` / `ConvertAudioRequest` / `ConvertImageRequest` 等；one-api 的接口只有 9 方法且只有 `ConvertRequest(GeneralOpenAIRequest)`。
- **38 个 outbound adaptor**（`relay/channel/` 41 个 vendor 目录，`GetAdaptor()` switch 38 case，`constant/channel.go` ~55 个 ChannelType）。
- **Anthropic inbound 三条路**：渠道是 Anthropic → `claude.Adaptor.ConvertClaudeRequest` 几乎原样透传；渠道是 OpenAI 系 → 转成 OpenAI Chat 再发；渠道是 Gemini → `claude_messages_to_gemini_generate_content`。
- **透传逃生阀**：`PassThroughRequestEnabled`（全局）或渠道级 `PassThroughBodyEnabled` 为 true 时完全跳过 `ConvertXxxRequest`，直接用原始字节发上游。issue 模板明说"开启透传请勿反馈问题"——**转换路径与透传路径行为不一致是已知的设计割裂**。

**`relaykit` 最值得借鉴的三件事**：

1. **转换结果对象**：`RequestResult{From, To, Converter, Quality, Steps, Diagnostics}`，`[]types.ConversionDiagnostic`（code / field path / 说明 / 级别 / 源目标格式）。常见 code：`hosted_web_search_omitted`、`trailing_assistant_omitted`、`unsupported_media_type`、`claude_max_tokens_raised`、`claude_budget_adjusted`。
2. **损耗策略三档** `Options.ToolLossPolicy`：`allow`（默认，转换完成 + 诊断）/ `safe`（遇 error 级诊断返回 `*types.ConversionLossError`）/ `strict`（任何诊断都报错）。
3. **`RequestConversionChain []types.RelayFormat` + `FinalRequestRelayFormat`** 记进 consume log 的 `other`——直接回答"这个请求到底被转成了什么"。
4. golden test：`GOWORK=off go test ./relayconvert -run TestGolden -update`。
5. README 明确说"HTTP 收发、SSE 读写、渠道选择、鉴权和计费由宿主程序完成，所以可以嵌进其他 Go 网关或代理"——**若我们选 Go，这是唯一值得认真考虑的"站在 NewAPI 肩膀上"的路径**（但同受 AGPL-3.0 约束，且 `v0.x` API 可能小版本变化）。

**计费（已确认，源码）**：

- `types.PriceData`：`ModelRatio, CompletionRatio, CacheRatio, CacheCreationRatio, CacheCreation5mRatio, CacheCreation1hRatio, CacheCreation12hRatio, ImageRatio, AudioRatio, otherRatios`；常量 `ClaudeCacheCreation1hMultiplier = 6/3.75`、`OpenAICacheCreation12hMultiplier = 2`；`QuotaPerUnit = 500 * 1000.0`（$0.002/1K tokens）。
- 公式（[NEW:service/text_quota.go](https://raw.githubusercontent.com/QuantumNous/new-api/b388140acfd80369ec6243b16869daff1b4051f4/service/text_quota.go) `calculateTextQuotaSummary`）：`baseTokens = prompt - cached - cacheWrite(不含12h) - image - audio`（负则 clamp 0）；`cachedWithRatio = cached * CacheRatio`；`cacheWriteWithRatio = (cacheWriteTotal - cacheWrite12h) * CacheCreationRatio + cacheWrite12h * CacheCreation12hRatio`（Claude 语义改为 `remaining*CacheCreationRatio + 5m*CacheCreation5mRatio + 1h*CacheCreation1hRatio`）；`quota = (promptQuota + completionQuota) * ModelRatio * GroupRatio + audioInputQuota`。
- **无 reasoning token 独立计价**（全仓无 `ReasoningRatio`，reasoning 计入 completion）。
- **预扣 + 后结算 + 退款**：`PrepareRequestBilling` → `EstimateRequestToken` → `PreConsumeBilling`（`BillingSession`）→ `SettleBilling(delta)` → 失败 `RefundFailedRequestBilling`。Token 层用 `TryReserveTokenQuota` 原子预留（注释明写"检查与扣减在同一操作中完成"）。
- **原始 provider usage 不全留**：`BillingUsage` 在内存里同时存 `OpenAIUsage` / `ClaudeUsage` / `GeminiUsageMetadata`，但 **`logs` 表只落归一化后的 `prompt_tokens`/`completion_tokens`/`quota`**，原始 usage 结构不持久化（open issue #7790 正是要求补这个能力）。
- 无请求/响应 payload 落库（只有 `common.DebugEnabled` 时打 stdout）；IP 记录 opt-in（`GetUserSetting(userId).RecordIpLog`）。

**重试 / failover（已确认）**：

- 渠道选择：priority 去重后**降序**排序，第 N 次重试降到第 N 高的 priority 档；同 priority 内按 `Weight` 加权随机（weight 全 0 时 effective weight = 100，平均 weight < 10 时 smoothingFactor = 100 防饿死）。
- **`common.RetryTimes = 0`（默认 0 次重试！）**；`DecideRelayRetry` 决策顺序含 strict session/pinned → IsChannelError → IsSkipRetryError → retryTimes<=0 → 2xx → code<100/>599 → `IsAlwaysSkipRetryCode`（**504、524 永不重试**）→ `ShouldRetryByStatusCode`。默认 `AutomaticRetryStatusCodeRanges` = `100-199, 300-399, 401-407, 409-499, 500-503, 505-523, 525-599`（**429 在内**；400/408/504/524 不在）。
- 同渠道多 key：`MultiKeyModeRandom` / `MultiKeyModePolling`（per-channel mutex）；key 级禁用状态 + 原因；**所有 key 都禁用 → channel 自动禁用**。
- **无熔断器**（无失败率窗口、无 half-open）；只有 401/关键词自动禁用（默认 `AutomaticDisableChannelEnabled = false`）+ 自动恢复 + 定期 channel test。
- channel affinity：首次选渠道后记录，重试时 `retry=0` 优先复用；`SessionMode == "strict"` 时不可用直接 503。

**流式（已确认）**：没有统一的跨渠道 stream 抽象——每渠道 adaptor 各写 `XxxStreamHandler`，共用 `helper.StreamScannerHandler`（`bufio.Scanner`，初始 64KB，上限 128MB，`streamWriteTimeout = 30s` + `streamMinClientRate = 8KB/s` 的 `StreamWriteBudget` 防慢客户端挂死 `wg.Wait()`，`DefaultPingInterval = 10s`）。**跨协议流式转换**才走统一抽象：RelayKit `NewResponseStreamState` → `ConvertStreamResponseChunk` → `FinalizeStreamResponse`。

**可观测（已确认）**：**无 Prometheus `/metrics` 端点**（`pkg/perf_metrics` 是进程内 `sync.Map` hotBuckets + flushLoop，经 dashboard API 展示；`controller/channel_inference.go` 里的 `/metrics` 是探测上游渠道用的路径列表，不是自身指标出口）。`LOG_SQL_DSN` 可配独立 log 库，支持 ClickHouse。独立审计日志表（Category Operation/Security/Login）。

**License**：**NewAPI = AGPL-3.0 + Section 7 附加条款**（[NEW:NOTICE](https://raw.githubusercontent.com/QuantumNous/new-api/b388140acfd80369ec6243b16869daff1b4051f4/NOTICE)）：修改版必须在 Appropriate Legal Notices 及 UI 中任何显著的 about/legal/footer/attribution 位置保留 `Frontend design and development by New API contributors.`，若呈现 UI 还必须保留指向原项目的可见链接；不得冒名来源；商业例外需按 NOTICE 文件里公布的商务联系方式接洽。**没有"禁止商用"条款**，AGPL 的约束是网络使用也要开源 + 上述署名义务。上游致谢 One API（MIT）与 Midjourney-Proxy。one-api = MIT（`Copyright (c) 2023 JustSong`）。

**已知 issue（可直接当我们的测试用例来源）**：

- 格式转换：[#7454](https://github.com/QuantumNous/new-api/issues/7454) file/document 块丢失 + data URL 格式化 bug；[#6260](https://github.com/QuantumNous/new-api/issues/6260) tool_result 里的 image_url 不转换；[#7564](https://github.com/QuantumNous/new-api/issues/7564) developer 消息被静默合并进 Gemini systemInstruction 无通知；[#8128](https://github.com/QuantumNous/new-api/issues/8128) Responses→Claude 数字 tool 参数被改；[#5938](https://github.com/QuantumNous/new-api/issues/5938) Responses→Chat 丢 mcp tools；[#7472](https://github.com/QuantumNous/new-api/issues/7472) `/v1/messages` 流式转译丢失 message_delta 的 `cache_read_input_tokens`（**直接影响计费**）；[#6075](https://github.com/QuantumNous/new-api/issues/6075) Codex chat→responses 转换因上游 SSE 无 Content-Type 失败。
- 计费：[#6609](https://github.com/QuantumNous/new-api/issues/6609) 钱包路径 TOCTOU 竞态导致超额；[#4168](https://github.com/QuantumNous/new-api/issues/4168) stream 失败且 completion_tokens=0 仍按 prompt 扣费；[#8084](https://github.com/QuantumNous/new-api/issues/8084) Gemini `promptTokenCount=0` 时 input 计为 0；[#7657](https://github.com/QuantumNous/new-api/issues/7657) 容器重启未排空在途结算；[#7904](https://github.com/QuantumNous/new-api/issues/7904) realtime 逐段实扣后结束再结算一次。
- 稳定性：[#7059](https://github.com/QuantumNous/new-api/issues/7059) 上游 TCP reset 导致 Responses SSE 无终止事件；[#3142](https://github.com/QuantumNous/new-api/issues/3142) 流式失败前不要提交 HTTP 200；[#2989](https://github.com/QuantumNous/new-api/issues/2989) 流式空回记录为成功未触发重试；[#5698](https://github.com/QuantumNous/new-api/issues/5698) 非流式 `/v1/responses` 的 ReadAll 缓冲 OOM。

**→ 根本分野与"为什么不建在 NewAPI 上"**：见 [00-overview.md](./design/00-overview.md) §1.3（含 AGPL-3.0 + Section 7 的约束论证、协议层哲学差异、转换质量自认不佳、`RelayInfo` 200+ 字段的耦合度）。

**待验证**：`RetryTimes` 在官方 Docker 镜像 `.env.example` / 文档里的推荐默认值（代码默认 0 已确认）；`AutomaticDisableChannelEnabled` 在 WebUI 的默认开关态；ClickHouse 作为 log 库的生产可用性；issue #6609 的钱包 TOCTOU 在当前 main 是否已修复。

### 2.7 其他转换库与生态位速览

**状态：已确认（GitHub API 元数据 + README），部分未读源码。**

| 项目 | Stars | Lang | License | 一句话 / 可借鉴点 |
|---|---|---|---|---|
| <https://github.com/chinrain/Api-Conversion> | 470 | Python | README 称 MIT，GitHub API `null`（**待验证**） | OpenAI↔Anthropic↔Gemini 任意互转的可部署产品；**最值得抄的是 thinking-budget 显式阈值表**（`OPENAI_LOW_TO_ANTHROPIC_TOKENS=2048` 等 env 可配）。久未维护（last push 2025-10-14） |
| <https://github.com/1rgs/claude-code-proxy> | 3,762 | Python | **无 license 声明（API `null`）** | 全部翻译委派 LiteLLM；**借鉴 haiku/sonnet → BIG_MODEL/SMALL_MODEL 别名间接层**，以及 `PREFERRED_PROVIDER=anthropic` 的 "just an Anthropic proxy" passthrough 模式 |
| <https://github.com/raine/claude-code-proxy> | 708 | Rust | **MIT** | 工程细节最好：**模型名带能力后缀**（`gpt-6-sol[1m]` 请求 1M 上下文变体）、明确记录"必须引导客户端"的环境变量、默认绑 127.0.0.1 且本地不鉴权并显式 WARNING、抓包排除敏感 payload 的意识 |
| <https://github.com/9j/claude-code-mux> | 519 | Rust | MIT | **已 archived**——"用 Rust 重写 LLM 路由代理"的项目在此赛道夭折率很高，是选型信号 |
| <https://github.com/lidge-jun/opencodex> | 18,502 | TS | MIT | Universal provider proxy for OpenAI Codex & Claude Code；若要被 agent CLI 接入值得单独调研 |
| <https://github.com/dwgx/WindsurfAPI> | 3,134 | JS | MIT | 把 Windsurf/Devin 的 100+ 模型变成 OpenAI/Anthropic/Gemini 三套兼容 API，zero-dependency 自托管反代 |
| <https://github.com/lich0821/ccNexus> | 971 | Go | MIT | Claude Code + Codex CLI 智能网关：端点轮换、用量监控 |
| <https://github.com/jianshuo/ccglass> | 946 | JS | MIT | 看 coding agent 到底发给模型什么：local proxy + web dashboard |
| <https://github.com/Portkey-AI/gateway> | 13,377 | TS | MIT | config-driven virtual key / routing / guardrails；偏"治理平面"，协议转换深度不如专用 adaptor；last push 2026-05-25 |
| <https://developers.cloudflare.com/ai-gateway/> | — | 托管 | 闭源 | **Universal Endpoint 已标注 Deprecated**（替代建议是"用 OpenAI 兼容端点"）；"Unified API (OpenAI compat)" 页写的是 "Deprecated for single-model calls"，替代方案 REST API **仍是 OpenAI 兼容的** `/ai/v1/chat/completions`。→ Cloudflare **没有**放弃 OpenAI 兼容端点，放弃的是"单 Universal 端点 + payload 内联路由"这一种形态；**不能**用它论证"统一成 OpenAI 方言被否定"（review #4 校正，2026-11-14 访问原文） |
| <https://github.com/inference-gateway/inference-gateway> | 213 | Go | Apache-2.0 | K8s/Gateway API 原生路线 |

### 2.8 agentgateway（Solo.io / Linux Foundation / AAIF）— 最重要的参照与反例

**状态：已确认（官方文档 `.md` 版 + GitHub main 分支源码 + Releases API + 第三方评测）。**

- Repo <https://github.com/agentgateway/agentgateway> ｜ **Apache-2.0** ｜ Rust 从零实现（**非 Envoy data plane**，技术血统来自 Istio ambient 的 ztunnel）｜ 2025-08-25 捐给 Linux Foundation，2026-06-04 成为 **Agentic AI Foundation (AAIF)** 托管项目 ｜ Solo.io 主导 ｜ 最新 **v1.7.0（2026-10-27）**，约月更且每个 minor 都有 breaking change ｜ 6,178 stars。
- 两种模式：standalone（单二进制 + 可选 SQLite/PG，无 k8s 依赖）/ kubernetes（自带 controller + Gateway API + CRD）。**不是 k8s-only**。
- 商业版 `Solo Enterprise for agentgateway`；开源 standalone 二进制实测已支持 per-key budget / virtual key（比 Solo feature matrix 更慷慨）。

**协议转换（最核心，与我们方向相反）**（[crates/agentgateway/src/llm/mod.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/llm/mod.rs)、[crates/llm/src/types/mod.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/llm/src/types/mod.rs)、[crates/llm/src/conversion/](https://github.com/agentgateway/agentgateway/tree/main/crates/llm/src/conversion)）：

1. **客户端 13 种 `RouteType`**（Completions / Messages / Models / Passthrough / Detect / Responses / Embeddings / Realtime(WS) / AnthropicTokenCount / GenerateContent / GeminiCountTokens / Rerank / Decisions）；**provider 侧 5 种 `ChatFormat`**（OpenAICompletions / OpenAIResponses / AnthropicMessages / BedrockConverse / VertexGemini）。
2. **不是单一 canonical IR**，而是 `CHAT_TRANSLATIONS` **有序配对表**（"取第一个 provider 支持的"，注释原文 "Put cheaper or more native translations before broader fallbacks"）。
3. **缺口写成显式注释**：`Missing: Responses -> Messages`、`Missing: Bedrock --> Bedrock`；**Gemini 原生格式只去 Gemini 系 backend**，路由到其他 provider 直接 unsupported-conversion 拒绝。
4. 每种格式是「强类型 struct + `#[serde(flatten, default)] rest: serde_json::Value`」的 passthrough 解析——前向兼容 + 已知字段类型安全。
5. **归一化表示只用于可观测**：`NormalizedMessage{role, parts:[Text|ToolCall|ToolResult|Reasoning]}`，源码注释原文：**"This is an observability representation, not a lossless wire format."**
6. **已文档化的静默丢弃清单**：Messages→Responses 丢 extended-thinking/redacted-thinking 历史、citations、document/search_result/server_tool_use 块、server tools（含 web search）；**`stop_sequences` 和 `top_k` 被接受后静默丢弃，无 error 无 warning**；Messages→Completions 一个 turn 多个签名 thinking 块时只合并文本不发签名、`redacted_thinking` 被丢。

**插件模型**（[architecture/cel.md](https://github.com/agentgateway/agentgateway/blob/main/architecture/cel.md)、[crates/policy-core/src/policy.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/policy-core/src/policy.rs)）：

- **无 WASM、无 Lua、无 Go 插件**（架构文档原话承认 CEL "not as powerful as alternatives like Lua or WASM"）。
- 扩展手段 5 种：① 进程内三相位 Rust trait（`RequestPolicy` 每请求一次**重试不重复** / `ResponsePolicy` **所有重试结束后一次** / `BackendPolicy` **每次 backend 尝试都跑**）；② CEL（配置期静态分析 + 运行期**按需物化**贵字段如 `body`）；③ ExtProc（Envoy External Processing API 兼容的 gRPC）；④ Webhooks；⑤ ExtMCP。
- 挂载相位：gateway（route 选择前）→ route（route 选择后、backend 选择前）→ backend（backend 选择后）。
- `RequestType` / `ResponseType` trait + `visit_text_mut(FnMut(Text, &mut String))` + `ContentScope{SystemPrompt, Messages, ToolOutput, ToolInput}`——护栏不需要 IR 就能遍历/改写任意格式文本，且签名块（`signature`/`thoughtSignature`/`reasoning_signature`）被识别为 signed，mask 会被拒。
- **流式护栏窗口式评估**：`DEFAULT_EVAL_THRESHOLD = 1024` 字节、`OVERLAP_BYTES = 256` 字节重叠；源码自承 "This is not 100% accurate: a guard that needs full-response context, or a pattern spanning more than the overlap window, can be missed"；**`mask` 对流式响应无效**（只能 reject）。

**其他关键结论**：

- **流式 SSE 自研编解码**（`tokio_sse_codec` + `DoneTolerantSseDecoder`，容忍缺终止空行的 `data: [DONE]`）；Bedrock 用 AWS event-stream 单独解析。流式 Chat Completions **总是**补一个 usage chunk（即使客户端设 `include_usage=false`），且该 chunk `choices` 为空数组。
- **`responseIdleTimeout`**（1.6 新增）：杀"发了首块后静默"的流——v1.5 无此能力，`requestTimeout` 都杀不掉。
- **Realtime（WS）代理**：从 `response.done` 抽 token usage；**必须让客户端去掉 `sec-websocket-extensions: permessage-deflate`**，否则帧被压缩无法解析。
- **重试**：`retry.attempts` 源码语义 = "retries after the original request"，默认 1；重试需要缓冲 body，超大则禁用重试。
- **Virtual models 四种路由**：`weighted` / `failover`（priority group，组内按 health+latency 复合分 LB，**只有整组被 evict 才降级到下一组**）/ `conditional`（CEL）/ `callout`（调用用户自己的路由服务）。上游 LB 用"随机取 2 个再取优"避免饥饿。
- **token 双轨**：归一化 `llm.inputTokens`/`llm.totalTokens`（含 cache，跨 provider 同义）+ provider 原样 `llm.providerInputTokens`/`llm.providerTotalTokens`（用于对账）。官方 WARNING：不要把 cache 字段加到 inputTokens，会双算。
- **cost catalog base + overlay**：带 `metadata.generatedAt` 的是 base（只取最新），不带的是 overlay（按序叠加）；速率含 `cacheRead`/`cacheWrite`/`cacheWriteDetails(1h,12h)`/service tier/音频按分钟。release notes 明确 "price 1h cache writes separately from 5m"、"Support openai 12h cache prompt"、"add prices for anthropic 1h cache"。
- **budget 是事后刹车不是硬顶**：官方文档原文 "agentgateway charged the request that crossed the limit after the request completed"，跨限请求照常完成并计费，只拦后续；未定价模型永不触发 usd budget。
- **无响应缓存/语义缓存**（1.6 MB config schema 全文 grep 无命中）；**无内置 web search**（文档索引无 search 页，且 Anthropic/OpenAI 的 server-side web search tool 在转换时被**丢弃**）。
- **golden test 工程**：一个输入 JSON × N 个 provider 输出 snapshot；AGENTS.md 要求"完整转换与 wire 序列化变更必须 golden test"。
- **WebUI**：React 19 + Vite 8 + TS 7 + TanStack + Monaco(+yaml) + Recharts，内嵌在 Rust crate；五大区（Gateway / LLM / MCP / Traffic / Tools）；**表单 + Raw YAML 双模**（schema 实时校验、保存前 View diff）；admin 15000 恒有；OIDC 登录保护。
- **指标**：`agentgateway_gen_ai_client_token_usage`、`..._cost_usd_total`、`..._server_time_to_first_token`、`..._server_inter_chunk_latency`、`..._cost_catalog_lookups_total`（status=Exact/Unpriced/Missing/NoCatalog）。**指标不带 user/team/key 标签**（基数考虑），所以"按团队的成本看板"必须走第二条数据通路（请求日志 DB）。

**已知坑**（含第三方评测 <https://www.truefoundry.com/blog/agentgateway-formerly-gloo-ai-gateway-an-honest-review-of-solo-ios-ai-gateway>）：

1. 升级负担重：1.6.0 五项 breaking change、1.7.0 五项 breaking + 一批行为变更。
2. **文档-行为漂移真实发生过**：v1.5/v1.6 schema 说 `attempts` 是"总尝试次数"，实测 `attempts:1/2/3` 产生 `2/3/4` 次上游调用；main 源码注释已改。照抄其设计要配契约测试。
3. **CEL 多值头比较可被绕过授权**（官方文档自己承认的安全陷阱），1.7 才把行为固定成"总是 list"。
4. 错误响应 1.7 起不再含内部细节（调试变难，只能看服务端日志）。
5. **供应商集中度**：Solo.io 一家占 ~60% commit，单一工程师 ~39%（2026-08 快照）。
6. **所有性能数字均为 Solo 或其关联方、mock backend、未公布硬件**，第三方未独立复现。
7. 音频/图片端点能力版本间差异大（TrueFoundry 说 v1.5/v1.6 无 token/成本跟踪；1.7 文档新增 `audio` API 类型页）——须以目标版本 schema 为准。
8. 已知 open issue：[#4220](https://github.com/agentgateway/agentgateway/issues/4220) 翻译后无 `finish_reason` 被当作空 turn 完成、token 照记；[#4227](https://github.com/agentgateway/agentgateway/issues/4227) Gemini structured output 在单字段上循环；[#1544](https://github.com/agentgateway/agentgateway/issues/1544) 缺少 provider 条件化 transformation。

**→ 对我们的启示与借用清单**：见 [00-overview.md](./design/00-overview.md) §1.1b（正面回应"为什么仍选 canonical"）。直接借用的：有序偏好表 + "Missing: X→Y" 显式化、token 双轨命名、cost catalog base/overlay、`capability_rejected: prompt_too_long` 约定、流式空闲超时、golden test 工程、流式护栏窗口+重叠设计（见 [25-streaming.md](./design/25-streaming.md) §7.2）。

### 2.9 LiteLLM 转换层 — 可逐行参考的开源字段级实现

> **编号修正（review #5）**：原文这里是 `### 2.10`，而上一节是 `### 2.8`，中间没有 2.9；下一节又是 `### 2.11`。已重排为 2.9（LiteLLM）/ 2.10（Cloudflare），消除两处跳号。

**状态：已确认（读 `v1.109.1` / commit `6c4ead4f` 源码，链接形如 `https://raw.githubusercontent.com/BerriAI/litellm/v1.109.1/<path>`）。**

- Repo <https://github.com/BerriAI/litellm> ｜ MIT core（`litellm/enterprise/` 另许可）｜ Python（有 Rust router core）｜ 63,227 stars / 5,195 open issues。
- **LiteLLM Proxy 有 hook（review #4 校正）**：文档明确列出 `async_pre_call_hook`、`async_post_call_success_hook`、`async_post_call_streaming_hook`、`async_post_call_failure_hook`（2026-11-14 读 <https://docs.litellm.ai/docs/proxy/call_hooks> 原文确认）。此前 00 §1.2 的表把 LiteLLM 的"插件系统"一格标成"❌ 无 hook 系统"、00 §7.2 写"现有开源全部没有插件系统"，两条都不准确，已改。**真正的差异不是"有没有 hook"，而是"hook 挂在什么上"**：LiteLLM 的 hook 签名拿到的是**已经归一成 OpenAI Chat 形态**的请求/响应，拿不到"这次请求原本是 Anthropic 格式、带 1h ephemeral cache 断点"这类信息；我们的 hook 只面对 canonical。
- `litellm/llms/` 下 1143 个 `.py`（openai/ 60、anthropic/ 63、gemini/ 29、bedrock/ 84、vertex_ai/ 81、base_llm/ 69）。

**核心结论：LiteLLM 的 "canonical" 不是独立 superset，而是「OpenAI Chat Completions + 一批 LiteLLM 私有扩展字段」。**

- 请求侧：`litellm/types/llms/openai.py` 的 `AllMessageValues`(L1069)、`OpenAIMessageContentListBlock`(L874)、`ChatCompletionToolCallChunk`(L671)。
- 响应侧：`litellm/types/utils.py` 的 `ModelResponse`(L2366)、`Usage`(L1999)、`PromptTokensDetailsWrapper`(L1865)、`CacheCreationTokenDetails`(L1856)、`CompletionTokensDetailsWrapper`(L1847)。
- 私有扩展（严格 OpenAI 客户端会拒绝）：`ChatCompletionUserMessage.cache_control`(L899)、`Message.thinking_blocks` / `reasoning_items`、`provider_specific_fields`、`Delta.reasoning_content`、`Usage.server_tool_use` / `iterations` / `inference_geo` / `speed`。
- provider 接入：继承 `BaseConfig`（`litellm/llms/base_llm/chat/transformation.py` L91），实现 `transform_request`(L371) / `transform_response`(L403) / `map_openai_params`(L294)。**`CustomLLM` 完全绕过归一化**——自定义 provider 拿不到字段归一化。
- Anthropic Messages 与 OpenAI Responses 是"在 Chat Completions 之上再包一层 adapter"（`BaseAnthropicMessagesConfig` L22、`BaseResponsesAPIConfig` L46、`CompletionTransformationBridge` L18）。

**Usage 归一化（已逐行读）**：

- `Usage.__init__`(L2012-2177) 有**硬编码 provider 映射**：Anthropic `cache_read_input_tokens → prompt_tokens_details.cached_tokens`、`cache_creation_input_tokens → prompt_tokens_details.cache_write_tokens`；DeepSeek `prompt_cache_hit_tokens → cached_tokens`；末尾 `for k,v in params.items(): setattr(self,k,v)` 把未知字段挂成 extra。
- **Anthropic**（`anthropic/chat/transformation.py` L2858 `calculate_usage`）：`prompt_tokens = input + cache_creation + cache_read`（把 cache 加回去，与 OpenAI 语义对齐）；`_resolve_cache_creation_token_details`(L2844) 处理 5m/1h；`_build_completion_token_details`(L2771) 处理 `output_tokens_details.thinking_tokens`。
- **Gemini**（`vertex_and_google_ai_studio_gemini.py` L2285 `_calculate_usage`）：`prompt_tokens = promptTokenCount + billable_tool_use_prompt_tokens + cache_creation`；**`is_candidate_token_count_inclusive`(L2240) 用 `prompt+candidates+toolUse == total` 反推 candidates 是否已含 thinking**；`_response_has_search_grounding`(L2262) 决定检索到的 token 是否计 input；`_set_grounding_usage_counters`(L2565) 写 `web_search_requests` / `google_maps_grounding_requests`。
- **Bedrock Converse**（`converse_transformation.py` L2439）：`input_tokens = inputTokens + cacheRead + cacheWrite`；`_parse_cache_details`(L2364) 按 `cacheDetails[].ttl` 的 `"5m"`/`"1h"` 分桶；**reasoning tokens 默认不返回，需显式请求 `/usage/output_tokens_details`，否则本地 `token_counter` 估算**。
- **⚠️ 原始 usage 保留不完整**：`Usage.__init__` 的 extra 挂载会被流式聚合 `calculate_total_usage`（`streaming_handler.py` L2843）丢弃——源码注释自承 "The builder's usage only keeps declared fields"。**这是我们必须避免的**：`usage_raw` 要是独立对象，不依赖 extra 透传。

**finish_reason 归一化**：唯一映射表 `_FINISH_REASON_MAP`（`litellm_core_utils/core_helpers.py` L306-366）+ `map_finish_reason()`(L367)。**未命中时默认 `stop` 并 warning**——这是多个 issue 的根因（Gemini `MALFORMED_FUNCTION_CALL`→`stop` 被误判完成；`OTHER`→`content_filter` 误报）。LiteLLM 的补偿是把原始 `stop_reason` 写进 `provider_specific_fields`。有损映射：`pause_turn`→`length`（丢失"服务端工具未跑完、应续轮"语义）、`model_context_window_exceeded`→`length`。

**Tool call**：

- Anthropic `convert_tool_use_to_openai_format`(L604-632)：`arguments = json.dumps(input)`，`index` 用 content block 下标。
- Gemini `_transform_parts`(L2088-2150)：id **三态**——原生 id（Gemini 3.5+）/ 伪造 `call_<uuid4().hex[:28]>` / **把 thoughtSignature 编码进 id 字符串**（`encode_tool_call_id_with_signature`）。第三种是反模式，已导致 [issue #17949](https://github.com/BerriAI/litellm/issues/17949)。
- **流式重组缺 id 的 tool_call 被静默丢弃**：`ChunkProcessor.get_combined_tool_content`（`streaming_chunk_builder_utils.py` L585-735）条件 `elif tool_call_data.id and tool_call_data.name:`——根因是 [issue #11262](https://github.com/BerriAI/litellm/issues/11262)（ollama 不返回 id）与 [issue #20711](https://github.com/BerriAI/litellm/issues/20711)（Responses 流式丢参数增量）。
- `tool_choice` 映射：Anthropic `_map_tool_choice`(L1008-1050)（`required`→`any`，`parallel_tool_calls` 取反写 `disable_parallel_tool_use`）；Gemini `map_tool_choice_values`(L781-798)（`required`→`ANY`，命名工具→`ANY + allowed_function_names`）。
- **工具名清洗**：Anthropic 要求 `^[a-zA-Z0-9_-]{1,128}$`，LiteLLM 做 forward/reverse map，且反向映射要跨进程/重试传递（`litellm_params[ANTHROPIC_TOOL_NAME_REVERSE_MAP_KEY]`）——一层有状态转换。
- **`response_format` → tool 的 trick**：`BaseConfig._add_response_format_to_tools`(L247-293) 把 JSON schema 包成工具并强制 `tool_choice`，响应侧再拆回 `content`。这是"没有原生 structured output 的 provider"的兜底，也是保真度高危区。

**Streaming**：统一出口 `CustomStreamWrapper`（`streaming_handler.py` L331）把一切归一成 OpenAI chunk 形状。`check_send_stream_usage`(L588)：**只有调用方按 OpenAI 语义显式要 `include_usage` 才发 usage-only chunk**，对 Anthropic/Gemini 一律不发。`_finalize_completed_stream`(L2446) 流结束时补 chunk。`calculate_total_usage`(L2843) **重算** `total_tokens`。假流式 `should_fake_stream`(L169) + `FakeStreamResponseIterator`。

**Router**：`router_python_core.py`（"holds all routing logic (registry, selection, retries, fallbacks, cooldowns, usage)"，另有 Rust 版 `litellm-rust/crates/router-core` 同语义）。冷却策略 `_is_cooldown_required`(L257-303)：**4xx 中只有 429/401/402/408/404 冷却**，其他 4xx 不冷却；≥500 一律冷却。计费 `cost_per_token`(L416) 注释原文："OpenAI-compatible: usage.prompt_tokens_details.cached_tokens (prompt_tokens already INCLUDES cached_tokens); Anthropic: usage.cache_read_input_tokens / cache_creation_input_tokens (prompt_tokens does NOT include these — adjust before calling helper)"。`StandardLoggingPayload`(L3871) 的 per-request 记账字段集直接可抄。

**已知 issue（可当测试用例来源）**：[#27611](https://github.com/BerriAI/litellm/issues/27611) Chat→Responses 桥不转 `tool_choice` 命名函数格式；[#11262](https://github.com/BerriAI/litellm/issues/11262) 流式 tool_call 无 id 被丢弃；[#20711](https://github.com/BerriAI/litellm/issues/20711) Responses 流式丢参数增量；[#19789](https://github.com/BerriAI/litellm/issues/19789) Gemini `MALFORMED_FUNCTION_CALL`→`stop` 静默失败；[#17949](https://github.com/BerriAI/litellm/issues/17949) id 内嵌元数据；[#16893](https://github.com/BerriAI/litellm/issues/16893) Gemini 3 `thought_signature` 流式不保留；[#25848](https://github.com/BerriAI/litellm/issues/25848) "OpenAI 兼容"端点并不真兼容；[#6516](https://github.com/BerriAI/litellm/issues/6516) `drop_params` 对 `dimensions` 无效；[#26241](https://github.com/BerriAI/litellm/issues/26241) Anthropic→Responses adapter 忽略 `drop_params`。

**→ 对我们的启示**（已落入设计）：

1. **canonical 分层**：请求/响应各一个 canonical，但**额外定义显式的 `ProviderExtension` 命名空间**（我们的 `native.<vendor>.*`），避免 extra 字段在流式聚合时被静默丢弃（[10-canonical-schema.md](./design/10-canonical-schema.md) §7）。
2. **Usage 四条硬不变量**（I1–I4，见 [40-provider-adaptors.md](./design/40-provider-adaptors.md) §2.2c）。
3. **finish_reason 双向可逆 + 未命中不得默认 `stop`**（默认 `other` + warn，见 [10-canonical-schema.md](./design/10-canonical-schema.md) §9.3 注意 2）。
4. **tool_call id 干净、缺失时入口统一生成、index 跨 chunk 稳定**（见 [10-canonical-schema.md](./design/10-canonical-schema.md) §4.2 D7b）。
5. **流式 usage 遵循"调用方显式要才发"**（[25-streaming.md](./design/25-streaming.md) §8.3）。
6. **计费的缓存分支按 provider 语义分开**（[40-provider-adaptors.md](./design/40-provider-adaptors.md) §2.2c I1）。

### 2.10 Cloudflare AI Gateway 的教训

**状态：已确认（读官方文档 `.md` 原文，2026-11-14）。**

**校正后的口径（review #4）**：文档导航里标 **Deprecated** 的是 **Universal Endpoint**（页面标题即 "Universal Endpoint (Deprecated)"，正文 "The Universal Endpoint is deprecated. Use the OpenAI-compatible endpoint for new integrations, and dynamic routes for fallbacks, retries, and conditional routing."）。而 "Unified API (OpenAI compat)" 页写的是 **"Deprecated for single-model calls"**，"For standard single-model chat completions, this endpoint is deprecated. Use the REST API instead, which provides OpenAI-compatible endpoints at `api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions`"——**替代方案仍然是 OpenAI 兼容端点**。

**正确的启示**：Cloudflare 放弃的是"一个 Universal 端点 + 在 payload 里内联 `provider`/`endpoint`/`query`"这一种形态，转向"per-provider 文档页 + OpenAI 兼容 REST + dynamic routes"。它同时提供 provider-native 页面（Anthropic/Bedrock/…各一页）与统一 OpenAI 兼容端点——这恰恰说明**"多入站格式共存 + 统一兼容端点"是并存的，不是二选一**。
**→ 对 AgentGateway 的直接启示：差异化押在"多入站格式共存 + 真超集 canonical + 横切治理"；但**不要**把 Cloudflare 这条当作"强行统一成 OpenAI 方言被否定"的论据——它否定的只是 Universal 那一种入口形态。<https://developers.cloudflare.com/ai-gateway/usage/chat-completion/>、<https://developers.cloudflare.com/ai-gateway/usage/universal/>

---

## 3. WebUI 选型

**状态：已确认（官方文档 + LICENSE 原文 + GitHub API）。**

| 候选 | License | Stars | 结论 |
|---|---|---|---|
| **LibreChat** <https://github.com/LibreChat-AI/LibreChat> | **纯 MIT**（Copyright (c) 2026 LibreChat） | 47,113 | ✅ **推荐** |
| Open WebUI <https://github.com/open-webui/open-webui> | "Open WebUI License"（BSD-3 + 品牌条款） | 158,601 | ❌ 一票否决 |
| LiteLLM UI <https://github.com/BerriAI/litellm> | MIT core（`litellm/enterprise/` 另许可） | 63,227 | ⚠️ 次选 |
| agentgateway UI <https://github.com/agentgateway/agentgateway> | Apache-2.0 | 6,178 | ❌ 只有 Playground |

**关键结论**：

1. **Open WebUI 的 LICENSE 第 4 条是硬门槛**：禁止 "altering, removing, obscuring, or replacing any 'Open WebUI' branding ... in any deployment or distribution"，例外只有 (i) ≤50 用户/30 天、(ii) 书面许可、(iii) 企业授权。官方 FAQ 明确 "**Open WebUI v0.6.6+ is not an OSI-approved 'open source' license**" 且 "**Rebranding and co-branding in any form are prohibited**"（包括 "Managed by Company X" 这种纯文字标注）。→ 与"重度定制的私有产品"直接冲突。<https://docs.openwebui.com/license>、<https://raw.githubusercontent.com/open-webui/open-webui/main/LICENSE>
2. **LibreChat 是唯一原生建模 cache 计费的候选**：`tokenConfig` 每模型可配 `prompt`/`completion`/`context`/**`cacheRead`**/**`cacheWrite`**/**`cacheWrite1h`** 单价，另有 `balance`（token 额度、自动 refill、reservation）+ transactions。<https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint>
3. LibreChat 的 `endpoints.custom[]` 支持任意 OpenAI 兼容网关，且 `headers` 支持 `{{LIBRECHAT_USER_ID}}` / `{{LIBRECHAT_USER_EMAIL}}` / `{{LIBRECHAT_BODY_CONVERSATIONID}}` 占位符——**可让网关按 LibreChat 用户维度记账**。Admin Panel 提供 `/api/admin/*` 配置 API（secret 字段加密存储并只回掩码预览）。
4. LibreChat 2025-11 被 ClickHouse 收购，仍保持 MIT 开源。<https://www.librechat.ai/about>
5. **代价**：Node/React + **MongoDB 必选**、Meilisearch 可选；版本迭代极快（0.8.x）；Admin Panel 是独立服务。
   **MongoDB 的部署定位（00 §7.3 定稿）**：跑独立服务/容器，**网关核心（SQLite 单文件）不依赖它**——WebUI 未部署或挂掉时，网关数据面、计费管道、dog-fooding 接口照常工作；两边不共享数据库文件与连接，只经网关 REST 交互。**Meilisearch 列为可选**（LibreChat 的 RAG 检索后端，strip RAG 后默认不需要）。
6. **MongoDB SSPL 合规立场（00 §7.3 定稿）**：SSPL 只约束"把 MongoDB 本身作为服务对外提供"；本项目是**私人自托管、自用**，不对外提供 MongoDB 服务，**可接受**。**Revisit 触发条件**（满足任一条即重新评估）：① 仓库将来公开/开源；② 把 WebUI 或网关作为托管服务对多人开放；③ LibreChat 上游要求引入 MongoDB 之外的 SSPL 组件，或其 license 从 MIT 变更。
7. ⚠️ **待验证**：LibreChat transaction schema 是否含 reasoning tokens 与 cache token 的**实际计量值**（读 `packages/api/src/models/`）。
8. agentgateway UI 的 **Analytics 是最值得抄的部分**：按 model/provider/user/group/user-agent 分组，measure 切 tokens/cost/requests，cache hit%，且 release notes 显示 "price 1h cache writes separately from 5m"、"Support openai 12h cache prompt"、"add prices for anthropic 1h cache"——**确实把 5m/1h cache write 分开计价**。<https://agentgateway.dev/docs/standalone/latest/documentation/llm/cost-controls/dashboard>
9. agentgateway 存储：SQLite（默认）或 PostgreSQL，表 `request_logs` / `request_log_payloads` / `budget_usage` / `agw_config_resources`；API `POST /api/logs/search`、`/api/config/effective`。<https://agentgateway.dev/docs/standalone/latest/documentation/setup/database>

**→ 结论与裁剪清单**：见 [00-overview.md](./design/00-overview.md) §7.3 与本节。fork LibreChat，strip ChatGPT 克隆相关部分（Artifacts/Code Interpreter/DALL-E/语音/i18n/RAG），新增 `/gateway`、`/usage`、`/plugins` 三个路由打我们自己的 REST。

---

## 4. 存储与加密

**状态：已确认（官方文档 + 本机实测）。**

**结论**：**SQLite + `better-sqlite3-multiple-ciphers`（整库加密，`PRAGMA cipher='chacha20'` sqleet/AEAD 为默认）+ payload 列应用层 XChaCha20-Poly1305（192-bit 随机 nonce，不做计数器持久化；DEK 随机生成后用 KEK 包裹，**不用 HKDF 派生**；AAD 绑定 `request_id + ir_version`）+ Argon2id 派生 KEK + systemd `LoadCredentialEncrypted=` 无人值守解锁 + Node 内置 zstd + 全局训练字典（可选按客户端类型变体，带版本号、入库加密；per-session 字典已取消）。**

| 方案 | 结论 |
|---|---|
| SQLCipher | 备选。v5.0.0-beta 默认从 AES-256-CBC+PBKDF2-256K 改成 AES-256-GCM + 8192 page + kdf 512K（beta.1 又改回 256K），**与 v4 默认不兼容**需 `PRAGMA cipher_migrate`；Node 无官方绑定 |
| libsql / Turso | ❌。加密是 `--experimental-encryption`（未经第三方审计）；**不支持 key rotation**；Turso 正被 Supabase 收购（战略风险）；"incremental storage" 未找到官方文档 |
| Postgres + pgcrypto / TDE | ❌。社区版无 TDE；pgcrypto 只是列级 `pgp_sym_encrypt`；pg_tde 必须用 Percona Server fork 且不加密 temp files |
| SQLite3MultipleCiphers | ✅ MIT。cipher 列表 = aes128cbc / aes256cbc / **chacha20(sqleet AEAD，官方推荐默认)** / sqlcipher / rc4 / ascon128 / aegis；AEGIS 用 Argon2id 做 KDF；支持 `PRAGMA rekey`（WAL 模式自 2.4.0 起支持） |
| age / JSONL | 仅归档层。age 官方明确不建议自动化系统用 passphrase-only；无可查询性 |

**本机实测数据**：

- Argon2id（`crypto.argon2Sync`，OWASP 最低档 m=19456 KiB, t=2, p=1）≈ **102 ms**；m=47104 KiB/t=1/p=1 ≈ 163 ms；m=64 MiB/t=3/p=4 ≈ 198 ms。⚠️ `argon2Sync` 阻塞 event loop，只能在启动路径用。
- Node ≥24.7.0 内置 `crypto.argon2()`（本机 Node v26.13.0 已确认可用），零原生依赖。
- zstd：同分布训练字典 **6.43×** vs 无字典 1.25×（400 条 × 125 KB）；**跨分布字典反而变差（1.25× → 1.08×）**——字典必须按真实数据分布训练并版本化。
- `zstd --train` 要求 > 100 样本；`--long` windowLog 默认 27、64-bit 最大 31，解压端 windowLog > 27 也需传 `--long`。
- Node 内置 zlib zstd 自 v23.8.0/v22.15.0，支持 `dictionary` option。
- `keytar` **已归档 deprecated**；替代 `@napi-rs/keyring`（MIT，Secret Service → keyutils 回退，keyutils 仅内存）。
- systemd `systemd-creds` / `LoadCredentialEncrypted=` 本机**已确认可用**。
- **本机无 TPM**（无 `/dev/tpm0`、`/sys/class/tpm`）、**无 Secret Service/libsecret** → TPM-sealed 方案在生产机上待验证。
- CDC 用 FastCDC（Gear hash，USENIX ATC'16）。

**来源**：

- SQLCipher <https://www.zetetic.net/sqlcipher/>（**链接已换**：原 `sqlcipher.org` 在本次与 review 环境均无法连接——DNS/连接失败，既不能证实也不能证伪；Zetetic 是 SQLCipher 的官方商业实体，该地址实测 200）；libsql 加密 <https://github.com/tursodatabase/libsql>；SQLite3MultipleCiphers <https://github.com/utelle/SQLite3MultipleCiphers>；Node crypto Argon2 <https://nodejs.org/api/crypto.html>；age <https://github.com/FiloSottile/age>（**链接已修**：原 `Filen.io/age` 返回 **404**；age 的官方仓库是 `FiloSottile/age`，200）；`@napi-rs/keyring` <https://github.com/Brooooooklyn/keyring-node>（**链接已修**：原 `nick33810/napi-rs-keyring` 返回 **404**；npm registry 的 `repository` 字段指向 `Brooooooklyn/keyring-node`，200）

**→ 结论与密钥三档、前缀压缩、脱敏、保留策略**：见 [65-storage-and-retention.md](./design/65-storage-and-retention.md)。

---

## 5. decision 模型（判断模型）调研 `[v1.5]`

**状态：已确认（三家官方 API reference / model card / pricing / rate-limits 全部读到）。** 调研日期 2026-11-14。

### 5.1 官方来源（一手）

| 厂商 | 指南 | API Reference | Model card | 定价 | 限额 |
|---|---|---|---|---|---|
| Gemini | <https://aistudio.google.com/docs/decisions-api> | <https://aistudio.google.com/api-reference/decisions/create-decision> | <https://aistudio.google.com/docs/models/gemini-decision-1> | <https://aistudio.google.com/docs/pricing> | <https://aistudio.google.com/docs/rate-limits> |
| Jev | <https://docs.typesafe.ai/concepts/system-one> | <https://docs.typesafe.ai/api/system-one>（OpenAPI：<https://api.typesafe.ai/openapi.json>） | <https://docs.typesafe.ai/models> | <https://typesafe.ai> | <https://console.typesafe.ai/rate-limits> |
| OpenAI | <https://developers.openai.com/api/docs/guides/decisions> | <https://developers.openai.com/api/reference/resources/decisions/methods/create> | <https://developers.openai.com/api/docs/models/gpt-6-luna> | <https://developers.openai.com/api/docs/pricing> | <https://developers.openai.com/api/docs/guides/rate-limits> |

补充官方：Gemini 官方博客 <https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api>；TypeSafe primitives <https://docs.typesafe.ai/primitives>、confidence <https://docs.typesafe.ai/confidence>、errors <https://docs.typesafe.ai/api/errors>、cookbooks <https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook> 与 <https://docs.typesafe.ai/cookbooks/parallel_questions>；OpenAI decisions-voice <https://developers.openai.com/api/docs/guides/decisions-voice>、Azure 版 <https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/decisions>。
OpenRouter 侧（上游归一化样板）：<https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request>、<https://openrouter.ai/docs/guides/community/multimodal-decisions>、<https://openrouter.ai/docs/guides/community/typesafe-sdk>；JevBench 榜单 <https://benchmarkheaven.com/jev-models>。

**二手（已标注）**：Braintrust <https://www.braintrust.dev/articles/what-is-jev>；Firecrawl <https://www.firecrawl.dev/blog/openai-decisions-api-vs-jev>；eesel <https://www.eesel.ai/blog/openai-decisions-api-pricing>；AIHubMix <https://aihubmix.com/blog/gemini-decision-1-vs-jev-1-14-which-should-you-choose>；Lindy <https://www.lindy.ai/blog/gemini-decision-1-vs-gpt-6-luna>；AI/TLDR Jeff <https://ai-tldr.dev/releases/firelex-jeff>；NobodyWho <https://www.nobodywho.ai/posts/jev-in-25-lines>（HN <https://news.ycombinator.com/item?id=49812769>）；独立 benchmark <https://github.com/nibzard/decision-model-benchmark>。

### 5.2 端点 / 模型 / 认证

| | Gemini Decisions | Jev | OpenAI Decisions |
|---|---|---|---|
| 端点 | `POST https://generativelanguage.googleapis.com/v1beta/decisions` | `POST https://api.typesafe.ai/v1/systemone` | `POST https://api.openai.com/v1/decisions` |
| Azure 变体 | — | — | `POST https://<res>.openai.azure.com/openai/v1/decisions` |
| model id | `gemini-decision-1`（唯一） | `jev-1.14.0` / `jev-1.13.0`；alias `jev-latest` / `jev-preview` | `gpt-6-luna`（唯一） |
| 认证 | `x-goog-api-key` | `Authorization: Bearer` | `Authorization: Bearer`（Azure 另支持 Entra ID） |
| SDK | `client.decisions.create()`（google-genai ≥3.2，`api_version: v1beta`） | `client.system_one()` | `client.decisions.create()`（openai ≥3.26.0 py / ≥7.30.0 js / .NET ≥2.15.0） |

### 5.3 关键结论

1. **三家全部不能 chat（已由官方文档直接确认）**：Gemini Decision 1 model card 的能力矩阵里 Text generation / Structured outputs / Function calling / Thinking / Caching / Batch / Live API **全部 not-supported**，output token limit = **0**；Jev："System One models do not write replies, produce code, or generate explanations"；OpenAI `/v1/decisions` 只收 `questions` 只回 typed answer（底层 `gpt-6-luna` 支持 Chat/Responses，但该端点不暴露）。
2. **原语命名三家不一致**：Gemini/Jev 用 `noul`|`choice`|`score`，OpenAI 用 `predicate`|`choice`|`score`；Jev 额外有 `box`。canonical 统一为 `binary`|`choice`|`scale`（+ `box` 仅 Jev、`rubric` 三家均无）。
3. **三个映射陷阱**：① `answers` 容器 Gemini/Jev 是 **map**（按 question key/name），OpenAI 是 **array**（按 questions 顺序）；② `probabilities` Gemini/Jev 是 **map**，OpenAI 是 **array of {value, probability}**；③ `confidence` 可用性不一（Gemini 三种类型都有；Jev 的 `noul` 没有；OpenAI 的 `predicate` 连 probabilities 都没有）。
4. **usage 不能假设 `output_tokens == 0`**：Gemini 恒 0；Jev **非 0 但免费**（OpenAPI 示例 12）；OpenAI 上报但不计费。必须按"是否计费"与"是否为 0"两个独立维度处理 → `pricing_state.output = "free"`。
5. **`refusal` 是 OpenAI 独有**：逐题拒答，同请求其他题仍作答。Gemini 用 `prompt_feedback.block_reason` 表达整请求被拦截（此时 `answers` 为空）。
6. **批量是核心降本手段**：Gemini 1–1000 题/请求且 1→100 题延迟近乎持平；OpenAI 1–400；Jev 无独立上限。共享 input 只计一次 token。TypeSafe 实测 13 问合并 1 次调用 = 13 次单独调用的 **1/12.2 成本、1/11.8 时间，答案不变**。
7. **只有 OpenAI Decisions 支持 prompt caching**（隐式 breakpoint + ≥1024 token 前缀；cache read 打折、cache write 计费）。Gemini 明确 "doesn't support context caching… Repeated input across requests counts in full"；Jev 无。
8. **Gemini 按 UTF-8 字节序对 option key 字典序排序后再求值**，平分时取字典序最前的 key → 绝不能用位置性 key。
9. **Jev 的 confidence 是 probabilities 的线性变换**（Choice：`(p_max − 1/n)/(1 − 1/n)`），官方明说"checking both adds no independent evidence"；`noul` 不返回 confidence 但可自算 `|2p − 1|`。
10. **OpenAI 的 `cached_tokens`/`cache_write_tokens` 已包含在 `input_tokens` 内**，不要重复相加。
11. **三家均不支持流式**（OpenAPI/reference 中无 streaming 参数）。
12. **媒体能力差异大**：Gemini 最强（text/image/audio/video/PDF + Files API URI + 远程 URL）；OpenAI 次之（text/image/JSON，无 `file_id`，无 audio/video）；Jev 只有 text + 实验性 PNG/JPEG（默认关，需 opt-in header）。
13. **开源/可自托管已成规模**：JevBench 榜单 **261 个 ranked open-weights 系统**。代表：Jeff（Firelex，weights Apache-2.0，RTX PRO 6000 ~22 ms，5 benchmark 79.1%/83.1%/81.6% vs Jev 83.0%）、AutoJev-27B（MIT 训练配方）、Cloudflare clef 家族、BaseTen joey/elephant/mammoth、Together Tev1-4B、jaredpalmer/kev-4b（`/v1/systemone` 兼容）。OpenRouter 已服务 **41 个 decisions 模型**。

### 5.4 chat 模拟 decision 的实测代价（有已发表数据）

**TypeSafe 官方 cookbook**（Jev 数据 2026-11-02，LLM 数据 2026-11-07～11-10；每条件 15 次调用，一次 8 个 Choice 问题）：

| Condition | time/call | cost/call | vs Jev 速度 | vs Jev 成本 |
|---|---|---|---|---|
| **Jev 1.14** | **103 ms** | **$0.000066** | 1x | 1x |
| GPT-6 Luna (temp 0) | 2,753 ms | $0.000269 | 26.8x | 4.1x |
| GPT-6 Luna (reasoning) | 14,467 ms | $0.000685 | 140.8x | 10.4x |
| Claude Haiku 5.5 (reasoning) | 6,110 ms | $0.001019 | 59.5x | 15.5x |
| GPT-6.1 Terra (temp 0) | 4,274 ms | $0.002694 | 41.6x | 41.1x |
| GPT-6 Astra (reasoning) | 18,171 ms | $0.055399 | 176.9x | 844.6x |
| Claude Fable 5.1 (reasoning) | 12,793 ms | $0.077985 | 124.5x | 1189.0x |

**稳定性（比均值更重要）**：40 个边界帖子 × 15 次重复，Jev 的"最不稳定选项"平均只变号 **4.0%**（从不 >6.7%）；而**每一个 LLM 条件**都有帖子变号 >10%（视条件 2–36/40 个）。temperature 0 能缩小差距但关不掉。统计显著性：Jev 领先幅度靠运气出现的概率 < 1/1000 runs。

**Google 官方博客**：Decisions API 比 Gemini 3.5 Flash-Lite + Interactions API **便宜近 5x**（共享 benchmark suite）。

**eesel 实测**（2026-10，20 工单 × 3 问）：Luna reasoning=none $0.047/千单、29/40 三问全对、median 1.48 s；Luna medium $0.089、2.34 s；GPT-6.1 Sol low $1.03、2.17 s。要点：**队列路由 40/40 已是"解决问题"**，花 22x 钱上 frontier model 买不到东西；thinking 全额按 output 计费，medium effort 下 82 个隐藏 thinking token 让成本近乎翻倍。

**校准度**：

- Google launch eval（自评）：Top-1 ECE Gemini Decision 1 **0.0250** < Jev 1.14 0.0494 < GPT-6 Luna 0.0721；JevBench 92.2% vs 90.0%；When2Call 79.9% vs **82.0%**（此项 Gemini 反而略低）；评测花费 $0.88 vs $0.68。
- Artificial Analysis：Decision Index 66/60/66，Brier 0.18/0.19/0.19，每任务 211/206/**92** ms，每 1M 任务 $345/$339/**$156**。
- ⚠️ **AIHubMix 明确警告**："A lower aggregate ECE does not establish a calibrated threshold for your tool router"——聚合校准度好不代表你的具体判断任务有可用阈值。

### 5.5 待验证（16 项，官方未给出依据）

1. **Gemini Decisions API 未列入 `llms.txt` 索引**（grep "decision" 零命中），但 api-reference 页可抓且内容完整 → 文档索引滞后于上线，抓取不能只靠 llms.txt。
2. Gemini Decisions 的**可用区域清单**：官方只说 "Gemini Developer API (v1beta)"；Vertex AI "coming soon"；OpenRouter 标注无 EU in-region routing。**无官方区域表**。
3. Gemini Decisions 是否/何时进 Vertex AI：官方博客仅 "support coming soon to Gemini in Google Cloud"，无时间表。
4. OpenAI Decisions 的**专属 rate limit 数值**：无 Decisions 限额表；只能借用 `gpt-6-luna` 的 Build/Launch/Grow（5,000/2M、10,000/10M、30,000/180M），且不确定是否共享配额池。
5. OpenAI Decisions 的**专属 4xx error code**（questions >400、choices >255、images >128 等）：API reference 只列 200，只能按通用 envelope 推断。
6. Jev 的**免费额度**：TypeSafe 文档均未提及免费额度或试用 credit。
7. Jev 的**具体 rate limit 数值**：官方只给计量维度（tokens/s、requests/s）与 console 入口，无公开数字。
8. Jev 的**延迟官方口径**："70–500 ms" 来自 Braintrust 转述，非 TypeSafe 官方文档原文；OpenRouter P50 从 0.21 s（10/1）波动到 0.09 s（11/14）。
9. Jev 的 **license / openness**：闭权；未公布权重许可、训练数据许可、是否可自托管（仅第三方重实现可自托管）。
10. **Gemini 官方 calibration benchmark 的原始图表**：只有官方博客一句 + 二手转录表格，Google 未公开完整 benchmark 报告页。
11. OpenAI Decisions 的 **DevDay 150 ms 宣称的测量条件**：只有 slide 转载与 X post，无官方文档化条件。
12. **OpenAI Decisions caching 计费口径的前后变化**：public beta 期社区回复 "currently no caching"，GA 文档改为 cache read 打折 / cache write 计费。以 GA 为准但缺 changelog。
13. **Jev 图片能力的网关行为**：AIHubMix 明确说 "Native images and Box are off by default and require a vendor opt-in header; that header's gateway behavior is unverified here."
14. thenewstack.io 原文被 Cloudflare 403，未取得原文（相关事实已由 OpenAI 官方文档与 Firecrawl/eesel 覆盖）。
15. Microsoft Learn Azure Decisions 页需授权，区域/配额细节部分依赖搜索摘要。
16. DataCamp 文章 403，ECE 数值经 AIHubMix 与搜索摘要交叉确认。

### 5.6 → 对设计的落地（已写入各文档）

- canonical `kind:"decision"` 与五类问题原语 + 别名映射（[10-canonical-schema.md](./design/10-canonical-schema.md) §4.6，含 D8c 三个映射陷阱）；
- `pricing_state` 与 `units.questions`（同文件 §6 规则 5–6）；
- 第五模态章节 + decision vs chat 对照表 + 实测代价（[15-modalities.md](./design/15-modalities.md) §6）；
- 三家特性普查行（[12-coverage-survey.md](./design/12-coverage-survey.md) §1.5）；
- decision adaptor 契约 + 三家字段映射表 + 7 条实现陷阱 + 降级路径（[40-provider-adaptors.md](./design/40-provider-adaptors.md) §6）；
- control-plane 消费点 + 攒批 + 上游选型对缓存的影响（[20-pipeline.md](./design/20-pipeline.md) §6）；
- 路由决策时序加 decision 辅助（[45-credentials.md](./design/45-credentials.md) §4.2）；
- `control_plane_cost` 计量（[60-billing-and-dogfooding.md](./design/60-billing-and-dogfooding.md) §3）。

## 6. License 汇总（合规注意）

| 项目 | License | 商用 | 注意 |
|---|---|---|---|
| LibreChat | MIT | ✅ | 保留版权声明即可；可 rebrand |
| MongoDB | SSPL | ✅（私人自托管自用） | 只约束"把 MongoDB 本身作为服务对外提供"；本项目自用可接受。**Revisit 触发条件**：仓库公开/开源、把 WebUI 或网关作为托管服务对多人开放、上游要求引入其他 SSPL 组件或其 license 变更（见 00 §7.3） |
| llm-bridge | MIT | ✅ | 零依赖，可放心 fork/vendor |
| llmshim | Apache-2.0 OR MIT | ✅ | 双授权，任选 |
| Vercel AI SDK | Apache-2.0 | ✅ | 保留 NOTICE |
| one-api | MIT | ✅ | 上游停更 |
| NewAPI | **AGPL-3.0** | ⚠️ | 强 copyleft，深度定制+SaaS 化前必须想清楚 |
| relaykit（NewAPI 仓库内的独立 Go module） | **AGPL-3.0 + Section 7** | ❌ | **明确不采用**（review #8.4 定稿）：与"因 AGPL 拒绝 NewAPI"的首要理由自相矛盾。借鉴方式限"读设计、不引代码"；确需其代码须以独立进程/服务边界隔离并先做许可证评估 |
| agentgateway | Apache-2.0 | ✅ | |
| **billion-context / acp-kernel** | **MIT + 强制署名条款** | ✅ | **必须在首页/文档/About-Credits 之一标注使用了 acp-kernel 并附仓库链接** |
| Open WebUI | BSD-3 + 品牌条款 | ⚠️ | 不可去品牌/co-branding；>50 用户/30 天需企业授权；**非 OSI 认证** |
| LiteLLM | MIT core | ✅ | `litellm/enterprise/` 另许可；SSO>5 人需付费 |
| chinrain/Api-Conversion | README 称 MIT，API `null` | ⚠️ | **商用前必须核实仓库是否真有 LICENSE 文件** |
| 1rgs/claude-code-proxy | **无 license 声明** | ❌ | 引用设计前需确认 |
| raine/claude-code-proxy | MIT | ✅ | 面向订阅账号，ToS 风险由其自身警告 |
| Portkey Gateway | MIT | ✅ | |

---

## 7. 待验证清单（汇总，按优先级）

| # | 问题 | 影响 | 归属文档 |
|---|---|---|---|
| 1 | OpenAI `prompt_tokens` 是否已含 `cached_tokens`（Gemini 已确认含、Anthropic 已确认不含） | 计费双算/少算 | 40-provider-adaptors.md §2.2 |
| 2 | LibreChat transaction schema 是否含 reasoning / cache 实际计量值 | WebUI 改造量 | 00-overview.md §7.3 |
| 3 | NewAPI 两个 org（`QuantumNous` vs `Calcium-Ion`）哪个是主仓库、star 是否重复计数 | 对比表准确性 | 00-overview.md §1.3 |
| 4 | zstd 全局字典在真实 trace 上的压缩率与离线训练耗时（per-session 字典已取消） | 存储设计 | 65-storage-and-retention.md §5.2 |
| 5 | Argon2id 在目标硬件实测耗时（决定启动解锁延迟） | 密钥档位 | 65-storage-and-retention.md §3.2 |
| 6 | `acp-kernel` npm 版（0.0.101）与 vendored 版（0.0.197）API 差异 | 插件实现 | 30-plugin-api.md §6 |
| 7 | Gemini 旧版 API 的 `functionCall` 是否仍无 `id` | 工具循环 | 10-canonical-schema.md §10 |
| 8 | OpenAI Responses `reasoning` item 在 `store:false`（ZDR）下是否仍必须回传 | chat 多轮保真 | 10-canonical-schema.md §10 |
| 9 | `additionalProperties: false` 是否需"严格/宽松"开关及默认值 | schema 严格度 | 10-canonical-schema.md §10 |
| 10 | Anthropic `output_config.effort` 与 `thinking` 的 per-model 组合限制 | reasoning 映射 | 40-provider-adaptors.md §3 |
| 11 | `googleSearchRetrieval` 是否已正式废弃 | built-in search | 50-builtin-search.md §6 |
| 12 | TTS/ASR/Image 各家 usage 原始字段与流式形态 | 多单位归一 | 15-modalities.md §9 |
| 13 | chinrain/Api-Conversion 与 1rgs/claude-code-proxy 的 license | 合规 | 本节 **§6**（License 汇总；原写 §5 是 decision 调研节，已改） |
| 14 | MongoDB SSPL 合规结论（LibreChat 依赖）——**已定稿**：私人自托管自用可接受，revisit 触发条件见 00 §7.3 | 合规 | 本节 §3 |
| 15 | 本机无 TPM；若部署机有 TPM，`tpm2-pkcs11` 封存 KEK 的可行性 | 密钥档位 | 65-storage-and-retention.md §8 |
| 16 | 备份→换机→恢复流程实测（密文 + KDF 参数 + 口令） | 运维 | 65-storage-and-retention.md §8 |
| 17 | `better-sqlite3-multiple-ciphers` 在 WAL 模式下 `PRAGMA rekey` 的稳定性 | 密钥轮换 | 65-storage-and-retention.md §8 |
| 18 | ~~**Q21** 三家 decision API 确切字段名/usage 形状/错误码~~ **已解答**（已全部读到官方 API reference） | — | 40-provider-adaptors.md §6.2 |
| 19 | ~~**Q22** Gemini Decisions 免费额度/区域；Jev 模型 id 与计价~~ **已确认** | — | 15-modalities.md §7 |
| 20 | ~~**Q23** decision 是否真的不能做 chat~~ **已解答**（三家官方文档均明确不能） | — | 40-provider-adaptors.md §6.3 |
| 21 | ~~**Q24** chat 模拟 decision 的校准性损失有无公开基准~~ **已解答**（TypeSafe cookbook 有已发表实测：26.8x–176.9x 慢、4.1x–1189x 贵） | — | 40-provider-adaptors.md §6.3 |
| 22 | **Q25** 部分问题失败的上游语义（整请求失败 vs 部分答案） | 批量错误处理 | 40-provider-adaptors.md §6.1 |
