# 50 · 内置搜索（built-in search）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)、[20-pipeline.md](./20-pipeline.md)、[30-plugin-api.md](./30-plugin-api.md)

## 1. 核心决策

**内置搜索在 canonical 里建模为一种 built-in tool，而不是请求体的一个布尔开关。**

理由：

1. 四种格式里"搜索"的出现形态并不统一——OpenAI Responses 和 Anthropic 把它放在 `tools[]` 里作为 server tool，Gemini 放在 `tools[]` 的 `googleSearch`，OpenAI Chat Completions **根本没有原生搜索**（只有 `web_search_options` 之类的实验面，且不同版本行为不一，**待验证**）。如果建模成顶层开关，canonical 就必然丢失"它是工具、可被 `tool_choice` 约束、可并发调用"这些语义。
2. 建模成 tool 之后，"上游支持就走**语义透传 + 方言映射**、不支持就网关自己执行"这条分支可以用同一套代码路径表达，只是执行者不同。
3. 网关自执行时，搜索结果天然走 `tool_result` part 回流，能进入 canonical → 计费 → trace → dog-fooding 数据面，不需要额外管道。

## 2. Canonical 建模

### 2.1 Tool 定义

```typescript
/** 内置工具：由网关或上游执行，客户端只需声明"我要用" */
interface BuiltinTool {
  type: "builtin";
  /** 稳定标识，跨格式映射的键。canonical 只用稳定名（见 §2.2 的归一化规则）；
   *  完整 canonical 枚举见 10-canonical-schema.md §4.3 的 BuiltinTool（唯一事实来源）。 */
  name: "web_search";
  /** 上游专有工具名/版本串（web_search_20250305、googleSearch…）存这里，映射时还原 */
  provider_tool_type?: string;
  /** 展示名（映射到上游时按需改写） */
  display_name?: string;
  description?: string;
  config: WebSearchConfig;
  /** 上游原生支持时的执行者；缺省 = 网关自己执行 */
  executor?: "provider" | "gateway";
}

interface WebSearchConfig {
  /** 结果条数上限 */
  max_results?: number;              // 默认 5
  /** 是否要求返回引用/来源标注 */
  include_citations?: boolean;       // 默认 true
  /** 搜索地域/语言偏好 */
  country?: string;
  language?: string;
  /** 域名过滤 */
  allowed_domains?: string[];
  blocked_domains?: string[];
  /** 时间范围：day / week / month / year / any */
  recency?: string;
  /** 网关自执行时使用的搜索后端 */
  backend?: SearchBackendId;         // 见 §4.2，默认取全局配置
  /** 单次搜索超时 ms */
  timeout_ms?: number;               // 默认 8000
}
```

### 2.2 客户端如何声明

| 客户端格式 | 原生写法 | 网关收到的 canonical |
|---|---|---|
| OpenAI Responses | `tools: [{ type: "web_search", ... }]` | `BuiltinTool{ name:"web_search", executor:"provider" }` |
| OpenAI Chat | 无原生；客户端可声明普通 function tool `web_search(query)` | `FunctionTool{ name:"web_search", ... , builtin: true }`（见 §3.2） |
| Anthropic Messages | `tools: [{ type:"web_search_20250305", name:"web_search", max_uses:... }]` | `BuiltinTool{ name:"web_search_20250305" → 归一为 "web_search" }` |
| Gemini | `tools: [{ googleSearch: {} }]` 或 `googleSearchRetrieval: { dynamicRetrievalConfig }` | `BuiltinTool{ name:"google_search" → 归一为 "web_search" }` |

**归一化规则**：`BuiltinTool.name` 只用 canonical 的 `"web_search"` 一个值；上游专有名字（`web_search_20250305`、`googleSearch`）记录在 `raw.provider_tool_type`，映射时还原。这避免了"同一能力在不同格式里有 5 个名字"导致配置和统计分裂。

### 2.3 搜索结果回流

```typescript
/** 搜索结果在 canonical 里的载体 */
interface SearchResultPart {
  type: "search_result";
  /** 来源标识，如 "serpapi:abc123" */
  source: string;
  title: string;
  url: string;
  /** 摘录正文 */
  snippet: string;
  /** 页面正文（可选，抓取后） */
  content?: string;
  published_at?: string;
  /** 引用序号，模型输出里用 [1] 引用 */
  citation_index?: number;
  score?: number;
}
```

两种摆放方式，按上游格式自动选：

- **作为 `tool_result` part 的 content**：OpenAI Chat / OpenAI Responses（`function_call_output`）/ Anthropic（`tool_result` block）/ Gemini（`functionResponse`）。通用，适用于一切"网关自执行"场景。
- **作为响应的 annotations / grounding metadata**：OpenAI Responses 的 `annotations[]`（`url_citation`）、Gemini 的 `groundingMetadata.groundingChunks`。仅在上游原生执行时存在，codec 解码时**同时**落到 `SearchResultPart`（保证 canonical 是超集）并保留原始 `raw.grounding`。

## 3. 两种实现模式

### 3.1 模式 A：上游原生执行（语义透传 + 方言映射）

判定：`route.provider_format` 的能力表里声明 `native_web_search: true`。

**"透传"在这里的含义是「语义不变地完成一次格式转换」，不是零 mapping、不是原样转发字节**：
目标格式既可以是标准 OpenAI 形态（如 `{"type": "web_search"}`），也可以是上游方言（如 DeepSeek 的
`deepseek_web_search` 参数）；无论哪种都过 codec/mapping、都有 round-trip 测试。
v1 一律完整走 canonical，**系统内不存在"原样转发字节"的路径**（术语表见 [00-overview.md](./00-overview.md) §5）。

| 客户端格式 → 上游格式 | 动作 |
|---|---|
| 同格式 | **语义透传 + 方言映射**：canonical 的 `BuiltinTool` 映射回该格式的 tool 定义（同格式时多数字段一对一）。响应侧网关把 citations / grounding 抽到 canonical 的 `SearchResultPart`（与响应体一起编码回客户端格式） |
| Responses → Responses（不同 provider 但同格式） | 语义透传 tool 定义，仅归一 `name`/版本字段（方言映射） |
| Anthropic → Responses | `{type:"web_search_20250305", name, max_uses, ...}` → `{type:"web_search", ...}`；`max_uses` 无对应 → 记录到 `dropped_capabilities` |
| Responses → Anthropic | 反向；`user_location`、`search_context_size` 等字段若无对应 → drop + warning |
| Chat / Gemini → Responses/Anthropic | 需要把客户端声明的普通 function tool 升级成 server tool（见 §3.2） |

**两条路径对客户端行为一致**：模式 A（上游原生执行）与模式 B（网关自执行）都完整过 canonical 与
codec/mapping，也都有 round-trip 测试；差别只在**执行者**（上游 vs 网关），不在"是否转换"。
内置搜索不会让网关退化成"什么请求都要特殊处理"，也不会退化成"原样转发字节"。

### 3.2 模式 B：网关自执行（无原生支持时）

触发条件：上游不支持原生搜索，**且**客户端声明了搜索意图。

#### 3.2.1 客户端声明的是 server tool（Responses/Anthropic/Gemini）

网关在 S3（`onRequest` 之前的内置步骤）把 `BuiltinTool{ executor: "gateway" }` 展开为：

1. 一个给模型看的 function tool：
   `web_search(query: string, recency?: string, domains?: string[]) -> { results: SearchResult[] }`；
2. 进入**网关 agentic loop**（见 [20-pipeline.md](./20-pipeline.md) §5）：
   - 模型产出 `tool_use{name:"web_search", input:{query}}`；
   - 网关执行搜索（模式 B 后端），把结果写成 `tool_result` part，content 为 `SearchResultPart[]` 的紧凑文本渲染（含 `[1] url` 引用标记）；
   - 再发一轮，模型基于结果作答；
   - 结束后，把整轮 `tool_use`/`tool_result` 与 `SearchResultPart` 一并交给 S8 编码回客户端格式（客户端会看到一次真实的工具调用往返，语义诚实）。

**成本提示**：模式 B 至少多一次完整模型往返（latency + tokens）。需在响应里显式告知（`UsageRecord.warnings += "gateway_web_search"`，并可在 body 加 `ag_search: { backend, queries, duration_ms }` 扩展字段，仅 `debug_mode` 开启时返回）。

#### 3.2.2 客户端声明的是普通 function tool（OpenAI Chat 风格）

客户端自己写了 `web_search(query)` 的 function 定义并期待网关代执行。此时：

- 默认行为：**不代执行**，按普通 function tool 转给上游（保持 OpenAI 语义——tool 由客户端执行）；
- 若客户端显式传 `x-agentgateway-builtin: web_search`（或虚拟 key 级配置 `builtin_tools: ["web_search"]`），则升级为 §3.2.1 流程。

这个区分很重要：否则网关会"擅自"执行客户端本想自己执行的工具。

## 4. 搜索后端

### 4.1 后端抽象

```typescript
interface SearchBackend {
  id: SearchBackendId;
  search(q: SearchQuery): Promise<SearchResult[]>;
}

type SearchBackendId =
  | "tavily" | "serpapi" | "brave" | "exa" | "perplexity"
  | "bing" | "google_cse" | "searxng" | "duckduckgo"
  | "custom_http";                  // 自定义：POST 一个 URL，按模板渲染
```

### 4.2 推荐与理由

**首选：可自托管的 `searxng`，其次 `tavily`。**

| 维度 | searxng | tavily / exa 等托管 API |
|---|---|---|
| 隐私 | 元数据不出本机（可配禁用日志） | 查询词与内容出本机 |
| 成本 | 仅算力 | 按次计费 |
| 稳定性 | 依赖各上游引擎，可能被限流 | SLA 较好，结果质量稳定 |
| 接入成本 | Docker 一发 | API key + SDK |
| 结果结构 | 需自行抓正文 | 常带 `content` 摘录/正文 |

结论：私人自用、隐私优先 → **searxng 为默认后端**，同时保留 `custom_http` 让用户接任何内部搜索服务（含内网部署的检索 API，地址走配置不进仓库）。托管 API 作为可选增强，key 走环境变量。

**待验证**：searxng 的实例化部署方式（compose）与并发限制；是否需要在网关侧做结果缓存（同 query 短时复用，降低上游压力）。

### 4.3 结果后处理

1. **去重**：按 URL 规范化后去重；
2. **截断**：`snippet` 默认 ≤ 2000 字符，避免把搜索结果变成二次上下文爆炸；
3. **引用编号**：在一次请求内按出现顺序编 `[1] [2] ...`，供模型引用；
4. **注入护栏**：搜索结果按"不可信外部数据"处理——在渲染进 `tool_result` 时包裹明确边界标记，并在 canonical 打 `trust: "untrusted"`，提示类插件可据此做 prompt injection 防护；
5. **缓存**：`(query, recency, domains)` → 结果的短 TTL 缓存（默认 10 分钟），减少重复搜索。

## 5. 计费与统计口径

- 上游原生搜索：各 provider 对搜索调用的计费方式不同（OpenAI Responses 的 `web_search_call` 按次计费、Anthropic 的 server tool 按次计费、Gemini 的 grounding 计入 `toolUsePromptTokenCount` 或按次，**待验证**）。网关统一在 `UsageRecord.builtin_tool_usage[]` 里记 `{ name, count, backend, cost_estimate }`，**不混入** `input_tokens`/`output_tokens`。
- 网关自执行：搜索 API 调用成本记 `UsageRecord.external_cost[]`（与 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) 的 dog-fooding 口径一致），搜索引起的额外模型轮次正常计入 token。

## 6. 待验证清单

1. OpenAI Chat Completions 是否有官方的 web search 面（若有，2025-2026 的确切字段名与可用性）。
2. OpenAI Responses `web_search` 的完整配置字段（`user_location`、`search_context_size`、`domains` 过滤器）与计费方式。
3. Anthropic web_search server tool 的版本演进（`web_search_20250305` 之后是否有新版本）与 `max_uses` 语义。
4. Gemini `googleSearch` vs `googleSearchRetrieval` 的现状（后者是否已废弃）与 `dynamicRetrievalConfig` 的 dynamicThreshold 语义。
5. Gemini grounding 计费到底走 token 还是按次。
