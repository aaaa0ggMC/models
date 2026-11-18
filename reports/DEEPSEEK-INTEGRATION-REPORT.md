# DeepSeek Provider 接入报告（thread #6）

> 分支：`dsh-threads/6-44a407` ｜  commit：`27e7d9f`（+ 本报告一个 commit）
> 测试：`npm test` **529 passed / 22 skipped**（live 冒烟无 key 自动跳过）；
> 真实 API 冒烟 **21/21 通过**（key 只在 `.env`，已被 gitignore 覆盖，未入库）。

---

## 1. 调查结论（一手来源：官方文档逐页核实 + 真实 API 实测）

### 1.1 端点与鉴权

| 面 | base URL | 端点 | 鉴权 |
|---|---|---|---|
| OpenAI 兼容 | `https://api.deepseek.com` | `POST /chat/completions`（**没有 `/v1`**） | `Authorization: Bearer` |
| Anthropic 兼容 | `https://api.deepseek.com` | `POST /anthropic/v1/messages`（SDK base 为 `.../anthropic`） | `x-api-key` 或 `Bearer`（都传则 Bearer 优先）；`anthropic-version` **被服务端忽略** |
| 独立工具端点 | 同上 | `POST /v1/tools/{search,fetch,ocr,asr,tts}` | Bearer |
| 元数据 / 余额 | 同上 | `GET /models`、`GET /user/balance` | Bearer（同一个 key） |

来源：<https://api-docs.deepseek.com/>（base_url 表 + curl）、
<https://api-docs.deepseek.com/api/create-chat-completion>（`POST /chat/completions`）、
<https://api-docs.deepseek.com/api/create-message>（`POST /anthropic/v1/messages`）、
<https://api-docs.deepseek.com/guides/anthropic_api>（鉴权与兼容差异表）。

**踩坑点**：大量第三方资料仍写 `/v1/chat/completions`，官方文档与 Codex 一键配置脚本
都是 `https://api.deepseek.com/` + `/chat/completions`。网关按官方口径发路径。

### 1.2 模型（2026-11 现行；`deepseek-chat`/`deepseek-reasoner` 已退役）

| 模型 | 版本 | 上下文 | max output | 视觉 | 并发 |
|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 1M | 393216 | ✓ | 2500 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 393216 | ✗（图片被替换为 `[Unsupported Image]`） | 500 |

- `deepseek-chat` / `deepseek-reasoner` 已于 **2026-07-24 15:59 UTC 全部退役**
  （<https://api-docs.deepseek.com/news/news260424>）。**实测：`deepseek-chat` 仍返回
  200 并被静默路由到 `deepseek-flash`**（响应 `model` 字段证实）——退役公告与线上行为
  不一致，故本实现不登记这两个别名（路由层直接拒绝），冒烟测试如实记录该行为。
- thinking **默认开启**（不传 `thinking` 也不传 `reasoning_effort` 时）；effort 枚举
  `none/low/high/max`，`minimal→low`、`medium/xhigh→high`（
  <https://api-docs.deepseek.com/guides/thinking_mode>）。
- Anthropic 兼容面额外接受 Claude 别名（`claude-opus*`→v4-pro，其它 `claude*`→flash）。

### 1.3 `/models` 的 `api_capabilities`（本轮最重要发现）

`GET /models` 按 **(model, dialect)** 主动声明行为约束。实测返回（与仓库主人提供的
样本完全一致）：

```json
{"id":"deepseek-flash", ..., "api_capabilities":{"anthropic_messages":{
  "system_prompt_update":"in-history","tool_update":"addition-only"}}}
{"id":"deepseek-v4-pro", ..., "api_capabilities":{"anthropic_messages":{
  "system_prompt_update":"leading-only","tool_update":"leading-only"}}}
```

官方语义（<https://api-docs.deepseek.com/api/list-models>）：

- `system_prompt_update: leading-only`——只有对话**开头**的 system prompt 生效；历史中
  后出现的 system 消息**不被当作系统提示更新**。要改系统提示只能改开头那条。
- `system_prompt_update: in-history`——system 消息可追加进历史；历史中**最后一条**
  system 提供完整生效的系统提示，替换更早的所有 system 消息。
- `tool_update: addition-only`——后续轮次只能**新增**工具，不能移除/修改。
- `tool_update: leading-only`——只有首次请求的工具声明生效，后续变更被上游忽略。

**adaptor 必须执行**（`adaptors/anthropic-messages/codec.ts`）：

| 约束 | 客户端行为 | 网关动作 |
|---|---|---|
| `leading-only` | 历史中出现 system 消息 | **合规转换**：按序合并进开头 `system` 字段 + `system_prompt_merged_leading_only` 诊断 |
| `in-history` | 历史中出现 system 消息 | 原样透传 `role:"system"` 消息（DeepSeek flash 认这个形态） |
| `addition-only` | 移除历史回合调用过的工具 | **明确报错**（`capability_unsupported`，不发上游——无法凭空补回 schema） |
| `leading-only` | 增删历史回合调用过的工具 | `tool_update_leading_only` warning 诊断（上游会忽略变更） |

约束同时登记进能力矩阵（`ir/capability.ts` 新增 `constraints` 等机读字段），
model discovery 会用 `/models` 实时值刷新。

### 1.4 usage 字段口径（实测 verbatim）

OpenAI 兼容面（`/chat/completions`）：

```json
{"prompt_tokens":45,"completion_tokens":28,"total_tokens":73,
 "prompt_tokens_details":{"cached_tokens":0},
 "completion_tokens_details":{"reasoning_tokens":22},
 "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":45}
```

- `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`（**全量输入**，
  含命中部分）；`prompt_cache_hit_tokens` 与 `prompt_tokens_details.cached_tokens` 同值
  （两个都发）；`completion_tokens_details.reasoning_tokens` 含在 completion 里；
  `safety_tokens`（safety_check=high 时）同样含在 completion 里。
- 流式：usage **搭在最后一个内容 chunk** 上，没有独立 usage-only chunk；以
  `data: [DONE]` 结束；可能有 `: keep-alive` 注释行。

Anthropic 兼容面（`/anthropic/v1/messages`）：

```json
{"input_tokens":41,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,
 "output_tokens":21,"service_tier":"standard",
 "output_tokens_details":{"thinking_tokens":15}}
```

- `cache_creation_input_tokens` **恒 0**（无 Anthropic 式缓存写入，缓存全自动）；
  `input_tokens` **不含**缓存命中，命中在 `cache_read_input_tokens`；
  总输入 = input + cache_read + cache_creation。
- `max_tokens` 在 HTTP 层**非必填**（实测省略返回 200；Anthropic SDK 才强制）。
- 流式**不发** `data: [DONE]`；usage 用最后的 `message_delta.usage`（不累加
  `message_start` 的）。

### 1.5 计费（峰谷 + 节假日；价格只在官方价格页公布，**无 API 可查**）

- 每 1M tokens（USD）：flash 缓存命中 0.003 谷 / 0.006 峰，未命中 0.15 / 0.30，
  输出 0.6 / 1.2；v4-pro 为 0.022/0.044、0.66/1.32、1.98/3.96。
  （<https://api-docs.deepseek.com/quick_start/pricing>）
- **高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00**（= UTC 01:00–04:00、
  06:00–10:00），**不含中国法定节假日**；其余（含周末与节假日全天）为低谷（半价）。
- 规则生效日期：峰谷体系 **2026-08-17 00:00（北京）**生效、高峰价为低谷 2 倍；
  **2026-08-23 起周末全天不再分峰谷**（统一低谷）；官方明确新规则生效前的费用仍按
  原标准结算（祖父规则）。来源：官方价格页 + 国务院 2026 放假安排
  （<http://politics.people.com.cn/n1/2025/1104/c1001-40596715.html>）。
- 按次计费：Search/Fetch **$0.75 / 1000 次成功请求**（200 且有结果才计费）；
  OCR $0.225 / 1000 页；TTS $0.45 / 1 万字符（中文 1 字记 2）；ASR $0.116 / 小时
  （限时半价）。余额查询 `GET /user/balance`（赠送余额优先扣——余额差≠现金支出）。

---

## 2. 两个 dialect 的差异与映射表

### 2.1 请求/响应映射（canonical 为中枢）

| 维度 | OpenAI 本家 | DeepSeek OpenAI 兼容面 | Anthropic 本家 | DeepSeek Anthropic 兼容面 |
|---|---|---|---|---|
| 端点 | `/v1/chat/completions` | **`/chat/completions`** | `/v1/messages` | **`/anthropic/v1/messages`** |
| 鉴权 | Bearer | Bearer | x-api-key + version | x-api-key 或 Bearer；version 忽略 |
| 推理开关 | `reasoning_effort` 档位 | `thinking:{type:enabled/disabled}` 对象，**省略即默认开** | `thinking:{type,budget_tokens}` | `thinking:{type}`（budget 忽略）+ `output_config.effort` |
| 思考内容 | — | `message.reasoning_content` / `delta.reasoning_content` | thinking block | thinking block（含 `signature`） |
| 缓存 usage | `prompt_tokens_details.cached_tokens` | **usage 顶层** `prompt_cache_hit/miss_tokens` | `cache_read/creation_input_tokens` | 同 Anthropic；creation 恒 0 |
| JSON 输出 | text/json_object/json_schema | **仅 text/json_object** | 无（靠 prompt） | 无 |
| user 标识 | `user` | **`user_id`** | `metadata.user_id` | `metadata.user_id` |
| 流式 usage | 独立 usage chunk | **搭末内容 chunk** | message_start+delta 合并 | 同 Anthropic；无 `[DONE]` |
| 内置搜索 | 无原生 | `tools:[{type:"deepseek_web_search"}]` | `web_search_20250305` server tool | `tools:[{type:"deepseek_web_search",**name 必填**}]` |
| system | `messages[{role:"system"}]` | 同左 | 顶层 `system` 字段 | 顶层 + 历史中 system 消息（in-history） |
| `frequency/presence_penalty` | 支持 | **deprecated no-op** | — | — |

canonical ↔ wire 的落点（都在既有 codec 里，未新写一套转换）：

- **usage 归一**（S10 计量边界，`providers/deepseek/profile.ts` 的
  `deepseekOpenAiUsageFromRaw`）：`prompt_cache_hit_tokens → cache_read_tokens`；
  `prompt_cache_miss_tokens → details.prompt_cache_miss_tokens`（canonical 无"缓存
  未命中"槽位，它不是 cache_write——DeepSeek 缓存全自动无写入计费）；
  `reasoning_tokens`/`safety_tokens` 各自归位（后者进 details，不双算）。
  Anthropic 面**不需要**归一（字段形态与 Anthropic 一致，codec 既有映射已正确）。
- **thinking**（`deepseekThinkingWire`）：`enabled:false → {type:"disabled"}` 必须显式
  发出（省略会被上游默认开启吞掉）；effort 按官方表归一（minimal→low、medium/xhigh→high）。
- **builtin tool**（50-builtin-search.md §3.1 模式 A，上游原生执行）：
  `deepseek_web_search ↔ web_search`、`deepseek_read_url ↔ url_context`；
  厂商串进 `native.provider_tool_type`，canonical 名保持稳定名；Messages 面输出
  `{type,name}` 双字段、Chat Completions 面只给 `type`；两工具的 config 一律丢弃 +
  告警（官方明确带配置字段返回 400）。

### 2.2 「透传」的术语澄清（按仓库主人拍板落地）

**透传 ≠ 零 mapping**：本项目中透传指「**语义不变地完成一次格式转换**」——目标格式既
可以是标准 OpenAI 格式（`{"type":"web_search"}`、标准 chat.completions 结构），也可以
是上游方言（DeepSeek 的 `deepseek_web_search` 参数）；**无论哪种都要过 codec/mapping、
都要有 round-trip 测试兜底**。唯一跳过结构转换的是字节级 fast path（客户端格式 ==
上游 provider 格式时），且 fast path 仍做 usage / finish_reason / tool_call id 标准化。
（另：仓库主人已拍板 v1 全走 canonical、字节级 fast path 降级为未来可选优化，由另一
线程清理；本实现未新增对它的依赖，新测试不断言其行为。）

---

## 3. 实测 usage 观测（真实 API，key 见 `.env`）

单次运行 22 次调用的原始记录（`tests/deepseek-live.test.ts` 的 `[obs]` 输出）：

| 场景 | 实测 usage / 结构 |
|---|---|
| 非流式（flash，未传 thinking） | `prompt_tokens:45, completion_tokens:28, total:73, reasoning_tokens:22`（**默认就在思考**） |
| 流式 | 66 个 data 行，`data: [DONE]` 收尾；usage 搭末 chunk（35/64/99，reasoning 55） |
| 工具调用 | `finish_reason:"tool_calls"`；`tool_calls[0].function.arguments` 是 JSON 字符串；usage 出现 **128 tokens 缓存命中**（工具 schema 前缀被缓存） |
| thinking（effort=low） | `message.reasoning_content` 为字符串；`completion_tokens_details.reasoning_tokens:37` |
| 缓存探测（同前缀连发两次） | 两次都 `prompt_cache_hit_tokens:0`——**小前缀未命中**（缓存为 best-effort，需"持久化的前缀单元"完全匹配；工具 schema 那次反而命中了） |
| `max_tokens=8` | `finish_reason:"length"` ✓ |
| Anthropic 面 | `input:41, cache_creation:0, cache_read:0, output:21, thinking_tokens:15`；content 含 `thinking` block（带 `signature`）+ `text` |
| Anthropic 省略 max_tokens | **200**（HTTP 层非必填） |
| 跨 dialect（网关管道） | 上游收到 `{"model":"deepseek-flash","messages":[{system},{user}],"max_completion_tokens":64}` @ `/chat/completions`；客户端拿回 Anthropic 格式（含 thinking block） |
| web 工具·Chat 面 | `message.server_tool_calls`（steps→calls[]，含 `kind`/`action.queries`/`sources[]`）；`message.annotations` = `url_citation`（start/end_index）；`usage.server_tool_use:{tool_search:2}`（**无** `web_search_requests`） |
| web 工具·Messages 面 | content blocks：`server_tool_use`→`web_search_tool_result`→text×4；`usage.server_tool_use:{web_search_requests:1, tool_search:2, ...}` |
| web 工具·Responses 面 | output 类型含 `web_search_call`；usage 用 OpenAI 式 `input_tokens_details.cached_tokens`（**无** prompt_cache_hit/miss）；`tool_search:3` |
| Search | 3 条结果；`rerank_score` 浮点、`authority` 整数、`summary`/`snippet`/`site_name`/`published_at` 齐全；usage `{units:{requests:1}}` |
| Fetch | `{title, content}`，content 为 Markdown |
| OCR | `page_count:1`，`pages[0].text`（位图字体渲染的 "DEEPSEEK 2026" 被识别为 "OEEPSEEK 2026"——D 字形不完美，管道本身通）；raw usage 有 token 数 |
| TTS | 170924 字节 `audio/wav`；`units:{characters:{input:36,billed:36}}`；上游 raw `{characters:23, billed_characters:36}`（**与客户端 billedCharCount 估算一致**，验证了"中文 1 字记 2"） |
| ASR | `text:"你好，这是DeepSeek语音合成的测试。"`（TTS→ASR 闭环正确）；`duration_ms:3560`；`units:{audio_seconds:{input:3.56,billed:3.56}}` |
| 错误·空 messages | 400 `{"error":{"message":"Empty input messages (request_id: ...)","type":"invalid_request_error",...}}` |
| 错误·无效 key | 401（OpenAI 面 `{"error":{...}}`；Anthropic 面 `{"type":"error","error":{...}}`，两种信封形态都实测到） |
| 错误·deepseek-chat | **200**，响应 `model:"deepseek-flash"`（退役名被静默路由） |
| `/models` | 与静态种子完全一致（flash=in-history+addition-only，pro=leading-only+leading-only） |
| `/user/balance` | `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"9.83","granted_balance":"0.00","topped_up_balance":"9.83"}]}`（金额是**字符串**） |

**成本核算**：多轮运行后余额 9.99 → 9.83 CNY，即全部实测累计 **≈ ¥0.16**
（含 3 次 web 工具调用、Responses 面 14755 输入 token 的大调用、TTS/ASR/OCR/Search/
Fetch 全部端点）。远低于 ¥0.5 预算。对账因余额只保留 2 位小数而显示 0.000000 差——
这正是"只做区间级对账"的现实注脚（单笔/小额差被精度吃掉，见 metering/reconciliation.ts）。

**fixtures 已按实测校准**：`adaptors/fixtures/openai-chat` 之外的 DeepSeek 夹具在
`providers/deepseek/fixtures/`；usage 归一映射按上表 verbatim 字段实现并单测锁定。

---

## 4. 架构决策记录

1. **`providers/<name>/` 新模块**（00-overview §4.2 模块表还没有它，列入待文档更新）：
   codec 按 (FormatId, ModalityKind) 注册、一个实例服务所有同 dialect 的 access path，
   因此 provider 级知识不能塞进 codec。新增 `di/ports.ts` 的 `ProviderProfile` 端口
   （endpointPath / usageFromRaw / builtinToolWire / builtinToolCanonicalName /
   builtinToolAcceptsConfig / thinkingWire），S10 与两个 codec 经注册表按 access path
   查；缺 profile 时行为与历史版本完全一致。
2. **usage 归一只在 S10 一个 choke point**：四类路径（快/慢 × 流式/非流式）的原始
   usage 都逐字段保留在 `CanonicalUsage.raw`（40 §2.2c I4），按 raw 重算 units 即可
   全覆盖，不必改四个调用点。
3. **行为约束的执行方是 adaptor 而不是路由**：路由只做拒绝/降级/放行三态；约束是
   "这条 wire 请求上游会不会误解"，属于编码期知识。约束源是能力矩阵（discovery 可刷新），
   codec 通过新增的可选 `capabilityRegistry` 依赖读取。
4. **修了两个既有缺陷**（都是被 DeepSeek 接入暴露的）：`resolved_model` 从未被管道
   设置（客户端别名会泄漏成上游 model，直接 400）；anthropic codec 的 `decodeThinking`
   不认 `type:"disabled"`（"关推理"被静默吞成"开"）。另：`reasoning_content` 在
   openai-chat codec 的**流式**路径早就支持、**非流式**不支持（同一 dialect 两条路径
   不一致），本次补齐双向映射。
5. **计费模型**（按仓库主人四原则 + 峰谷扩展）：`UsageRecord.cost` 双口径
   `{cash, as_api, status}`；`price_snapshot` 记录命中的 `tier`/窗口/生效日/表版本
   （上游不返回档位，档位必须按请求时间戳自己算）；流式跨峰谷边界**按请求开始时间
   定档**（确定性优先，未采用按 chunk 拆分）；backfill 用请求时点价格、写
   `backfilled_at`，**绝不重算**已有记录；`as_api` 与 `cash` 用同一次解析结果。
   `computeCost` 在"有价格但无用量"时判 `unpriced` 而不是 `priced+0`（后者会把漏报
   usage 的请求静默变成免费请求）。
6. **价格表/节假日表都是仓库内静态数据**（价格不在 `/models` 里，已核实无任何官方
   API 提供峰谷规则或实时价格）：`pricing.json` 带表版本 + 来源 URL + 抓取日期；
   节假日表按年维护（2026 国务院通知，含调休上班日），缺失日期按工作日保守处理并打
   `holiday_unknown`，不用算法推算；两者都留了 AI/API 刷新的接口占位（只新增版本）。
7. **余额对账只做区间级**：并发交错扣费 + 上游无 per-request 流水，逐笔归因不可能；
   `metering/reconciliation.ts` 比较区间余额差与区间估算现金，分 granted/topped_up
   （赠送优先扣会让现金差偏小）。

---

## 5. 待文档更新清单（**均未改**，docs 改动走 PR）

1. `00-overview.md` §4.2：模块表新增 `providers`（provider 专有知识的归属）；
   fast path 从"默认模式"改为"未来可选优化"，§3 的 3ms p99 验收标准同步改。
2. `20-pipeline.md`：fast path 章节改为"未来可选优化（须实测数据支撑才加回，
   写明触发条件）"；S1 惰性解码（D-fastpath-1）/ D-fastpath-2 作废的表述。
3. `40-provider-adaptors.md`：§1.2「8 个方法一个不能少也不允许多」需补充
   `providerProfiles`/`capabilityRegistry` 两个**可选构造依赖**的立场；§2 usage
   口径表补 DeepSeek 列（顶层 prompt_cache_hit/miss_tokens、Anthropic 面
   cache_creation 恒 0）；能力矩阵章节补"上游按 (model, dialect) 声明的行为约束"
   与 adaptor 必须执行的硬约束。
4. `10-canonical-schema.md`：`CapabilityEntry` 是否需要正式收录
   `constraints`/`input_modalities`/`output_modalities`/`context_window`/
   `max_output_tokens`/`effort`（本轮已增量加到 ir/capability.ts，文档未同步）；
   `CanonicalUsage` 是否需要 `estimate_method`。
5. `50-builtin-search.md`：§1/§3.1 的"透传"表述按仓库主人澄清改写——**透传 =
   语义不变地完成一次格式转换，不是零 mapping**（目标可以是标准格式也可以是上游
   方言；都过 codec、都有 round-trip 测试；fast path 也仍做标准化）；§2.2 的
   `BuiltinTool` 字段（`raw.provider_tool_type` vs `native.provider_tool_type` 的
   既有不一致）；补 DeepSeek `deepseek_web_search`/`deepseek_read_url` 的映射
   （含"无任何配置项"这一负面结论）与 §5 计费口径（按次 vs 按 token）。
6. `45-credentials.md`：access path 示例补 DeepSeek 两条；key 环境变量表补
   `DEEPSEEK_API_KEY`；`/user/balance` 作为对账真值源的记录。
7. `60-billing-and-dogfooding.md`：补本轮落地的计费模型（双口径 cost、price_snapshot
   不可变、backfill 用历史价格、峰谷×节假日点时间解析、区间级对账）与
   `UsageUnits.requests/characters/audio_seconds` 在按次计费端点上的用法；
   Search/Fetch 按次计费对多单位模型的冲击（建议：`requests` 槽已够用，或为
   web_search/web_fetch 开专属槽）。
8. `15-modalities.md`：ASR/TTS 第一个真实 adaptor（DeepSeek 独立端点）的 schema 与
   usage 口径（按音频秒/按字符，中文 1 字记 2）；OCR 按页计费无对应模态的问题。
9. `70-roadmap.md` / `AGENTS.md`：Phase 1 验收标准与"关键设计约束"里的 fast path 一条。
10. `docs/sources.md`：补本轮引用的官方文档 URL 清单（见 §1 各链接）。

---

## 6. 交付物与验证

- **分支** `dsh-threads/6-44a407`，commit `27e7d9f`（63 files, +11139/−68），未 push、
  未合并 main。`.env`（含测试 key）经 `.gitignore:23` 覆盖，`git check-ignore -v .env`
  与 `git status --short` 双重确认未入库；全仓 grep 确认无完整 key 落盘；
  commit 前 `privacy-scan --staged --fail-on any`（3 个残留告警均为**改动前就存在**
  的行上的误报：`secret` 形参名 / `name` JSON 字段标签；夹具 IP 为 RFC 5737 文档段
  假数据，已加 ignore 标记并在提交信息说明）。
- **离线测试**：新增 241 个（profile 31 / integration 20 / constraints 9 / billing 15 /
  endpoints 49 / balance 21 / reconciliation 25 / pricing 87 中新增部分），
  `npm test` 529 passed + 22 skipped；`tsc --noEmit` 0 错误；eslint / prettier 全绿。
- **真实 API 冒烟**：21/21 通过（观测见 §3）；无 key 时 `npm test` 自动跳过。
- **可运行配置**（组合根默认装配）：`deepseek-flash`/`deepseek-v4-pro`（OpenAI 方言，
  客户端 OpenAI 格式进 → canonical → 同格式 codec 映射）与
  `deepseek-flash-messages`/`deepseek-v4-pro-messages`（Anthropic 方言）；
  客户端 Anthropic 格式 → `deepseek-flash` 即 canonical 转换路径。`DEEPSEEK_API_KEY`
  配好即可用；`DEEPSEEK_BASE_URL` 可覆盖 base。
