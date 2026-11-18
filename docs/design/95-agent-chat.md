# 95 · 内置 Chat 与 Agent 管理

> 状态：v1.0-draft，待 review。本文是「内置 Chat 界面 + Agent 管理系统」的唯一设计依据。
> 代码落点与本文不一致时，以本文为准并提 issue。

## 1. 定位与范围

### 1.1 这个功能是什么

管理面里多一个「对话」页：管理员用自然语言让网关自己管理自己。网关既是工具提供方，
也是模型调用方——它通过**自己的**推理链路发请求（dogfooding，60-billing-and-dogfooding.md §6.2），
把系统管理能力包装成 canonical 工具（`FunctionTool`，10-canonical-schema.md §4.3）交给模型。

不引 LibreChat，不引任何前端框架：聊天界面就是 `webui/admin` 里的一个 hash 路由页
（90-admin-ui-redesign.md §3.2 的既有形态）。

### 1.2 范围

- 覆盖：对话页、agent 管理工具、服务端脱敏、凭据弹窗流、Agent 配置项、会话持久化。
- 不覆盖：多用户会话共享、agent 之间的委派、`web_search` 之外的 built-in tool
  （50-builtin-search.md 的既有边界不动）、数据面客户端对 `/admin/api/chat` 的访问
  （66-auth.md §1：两个认证平面不混）。

### 1.3 三条硬约束（不可协商）

1. **模型永远看不到密钥材料**。任何工具结果在进模型前不得含完整密钥；掩码、长度、
   前导位不算密钥材料，可以给。
2. **密钥只经由界面弹窗进加密库**。用户说「帮我连接 XXX」时，模型只能拿到
   「需要凭据」这个状态，拿不到 key；key 由用户填进弹窗，直接 POST 既有的凭据创建端点。
3. **脱敏是服务端权威动作**。客户端可以做实时预览，但消息终究要过服务端才到模型，
   因此服务端必须自己对所有出网文本再脱敏一遍。

## 2. 界面位置与路由

### 2.1 路由与导航分组

- 路由：`#/chat`（`webui/admin/src/router.ts` 的 `ROUTES.chat`）。
- 导航：新增分组「智能助手」，只放一个条目「对话」。四个既有分组
  （总览 / 上游接入 / 模型与用量 / 系统）一字不改，`tests/ui-contract.test.ts` 守着的
  老路由与分组名全部保留。
- 帮助小节：`HELP_SECTIONS.agent` → `#/help?section=agent`。按 90-admin-ui-redesign.md §7.2
  与仓库的界面文案纪律，解释性文字只住在帮助页，功能页上放 `helpHref('agent')` 深链。

### 2.2 页面构成

- 消息列表：用户 / 助手 / 工具调用三种可视化。工具调用折叠展示「工具名 + 入参 + 结果摘要」，
  展开看完整入参；`is_error` 的结果用危险色标出。
- 输入框：实时脱敏预览。命中即高亮，并提示「将以 `<placeholder>` 发送」，
  占位符文本来自配置（§5.4）。
- 流式：`POST /admin/api/chat` 按 `stream` 标志返回 SSE 或 JSON（§6.2）。
- 凭据弹窗：识别 `needs_credential` 状态后弹出（§4）。

## 3. Agent 工具：插件形态与工具清单

### 3.1 为什么是插件

工具走 `onToolCall` hook（30-plugin-api.md §2、§3）：`PluginManifest` 没有 `tools` 字段，
`GatewayServices.registerTool` 目前没有任何装配方提供（组合根只给 `log` / `metrics` /
`clock` / `currentUsage` / `kv`），因此唯一可用路径是插件实现 `onToolCall`。
工具执行发生在网关 agentic loop 内（20-pipeline.md §5.2），由 `runToolLoop` 触发；
没有 `onToolCall` 插件时该调用会变成一个 `is_error` 的 tool_result，不会 500。

落点：`plugins/agent-admin.ts`。它复用 `AdminService`（`admin/service.ts`）的既有方法，
不新写一套管理逻辑——列渠道就是 `listProviders`，列凭据就是 `listCredentials`，
建虚拟 key 就是 `createVirtualKey`，解析别名就是 `resolveAlias`。

### 3.2 工具清单

工具名用小写下划线形式（模型侧的稳定标识）。入参是 JSON Schema（`FunctionTool.parameters`），
出参是 `ToolResultPart`（10-canonical-schema.md §4.3）。

| 工具 | 入参 | 出参（结构上不可能含密钥） |
| --- | --- | --- |
| `list_channels` | 无 | 渠道数组：`id` / `label` / `dialect` / `enabled` / `credential_health` / `namespace` |
| `list_credentials` | `provider?` | 掩码数组：`id` / `provider` / `access_path` / `masked` / `storage` / `health` / `created_at`。**只走掩码通道**，与 `GET /admin/api/credentials` 同一份数据 |
| `list_models` | `modality?` | 能力矩阵条目：`access_path` / `model` / `modality` / `status` / `context_window` |
| `add_provider` | `id` / `label` / `dialect` / `base_url` / `namespace?` / `models?` | 见 §4.2：要么 `{status:'created'}`，要么 `{status:'needs_credential'}` |
| `create_virtual_key` | `name` / `note?` / `expires_at?` / `models?` / `providers?` | `{status:'created', key_id, masked, head, name}`。**不含明文** |
| `usage_summary` | `from_ts?` / `to_ts?` | `usageDashboard` 的汇总段（请求数 / token / 双口径成本） |
| `resolve_alias` | `model` | `resolveAlias` 的结果：`source` / `target{provider, access_path, model}` |
| `test_provider` | `id` | `{status, message}`，`status` 为 `ok` 或 `error`；`message` 过脱敏 |

#### 3.2.1 出参为什么结构上不可能含密钥

- 凭据类工具只调 `listCredentials`，它本身只返回 `masked` / `length` / `head`
  （存储侧保证：`listMeta` 不解密）。
- `create_virtual_key` 是唯一会产生明文的工具（`createVirtualKey` 返回一次明文）。
  它的处理见 §3.3：明文不进 tool_result，走单独的披露通道给界面。
- 没有任何工具以 `secret` 为入参——key 只能从弹窗进 `POST /admin/api/credentials`。

### 3.3 `create_virtual_key` 的明文披露通道

明文只在创建响应里出现一次（66-auth.md §2.2）。如果把它塞进 tool_result，模型就看见了
密钥——直接违反硬约束 1。因此：

1. 工具只把 `{key_id, masked, head, name, status:'created'}` 写进 tool_result；
2. 明文暂存进 `ctx.state`（`AGENT_PENDING_SECRET`），由 `RedactingPluginHost` 搬进
   `plugins/tool-recorder.ts` 的记录里；
3. 聊天端点按 `request_id` 取走记录，在同一次 HTTP 响应里用**独立的事件/字段**
   交给浏览器（SSE 的 `secret` 帧，或 JSON 响应的 `secrets` 字段）；
4. 浏览器把它渲染成「仅此一次」的展示卡，并引导去「客户端密钥」页管理。

这条通道与 tool_result 是**物理分离**的两条路：披露内容从不进入 canonical 的 messages，
因此不可能被模型看到。记录按 `request_id` 分桶、取走即删（上限 256 桶，超出淘汰最旧），
不落盘、不进日志。按请求分桶而不是共享单例，是为了并发两次对话时不会串。

同一个记录器还承担「工具调用可视化」：工具结果由 agentic loop 自己消费，**不出现在
上游响应里**，界面要的「结果摘要」只能从 `runOnToolCall` 这个唯一同时看得见调用与
（脱敏后的）结果的拦截点取。

## 4. 「需要凭据」交互协议

### 4.1 状态机

```text
用户: "帮我连接 DeepSeek"
  → 模型调 add_provider（不带 key）
  → 工具返回 { status: 'needs_credential', provider, access_path, hint }
  → 界面识别 status，弹窗要 key（弹窗里说明是哪个渠道）
  → 用户填 key → POST /admin/api/credentials（既有端点，既有 secret tripwire）
  → 界面发一条续聊消息（"凭据已录入，请继续"）
  → 模型下一轮看到凭据已就绪（list_credentials 里有掩码条目），继续把渠道配完
```

### 4.2 `add_provider` 的两种返回

- 渠道建成且该 access path 上已有凭据 → `{status:'created', provider}`。
- 渠道建成但没有凭据 → `{status:'needs_credential', provider, access_path, hint}`。
  `hint` 是人类可读的一句话（「请提供该渠道的上游密钥」），**不含任何密钥材料**。
  此时 `upsertProvider` 已经落库，渠道记录是存在的；缺的只是 key。

### 4.3 为什么不让模型碰 key

`add_provider` 的入参里没有 `secret` 字段，工具也读不到凭据明文。用户即使把 key 直接
贴在对话里，它也会在进模型前被替换成占位符（§5）——模型看到的是 `<redacted_key>`，
于是「帮我用这把 key 连接」这类请求模型也无法执行，只能引导用户走弹窗。

## 5. 脱敏：规则即数据 + 前端判定 + 服务端权威

### 5.1 三层判定

| 层 | 谁执行 | 内容 | 能否被关掉 |
| --- | --- | --- | --- |
| 内置权威规则 | **服务端 + 前端** | `sk-` 等已知前缀 + 长度 + 字符集那套值形状判据 | 不能 |
| 数据规则 | **服务端 + 前端** | 设置里的 `RedactionRule[]`：正则 + 标志 + 替换文本 | 能（逐条开关 / 删除） |
| 用户 JS 判定函数 | **仅前端** | 设置里的一段 JS 源码，`(text) => 命中区间[]` | 能（可改可恢复默认） |

三层是**并列**关系：任一命中即脱敏。数据规则与用户 JS 是「不想写代码」与「想写代码」
两条并存的快捷路径，都在设置页里编辑、即时生效、可恢复默认。

### 5.2 规则数据结构

```typescript
interface RedactionRule {
  id: string;            // 稳定 id（新增时生成）
  pattern: string;       // 正则源码
  flags: string;         // 如 'gi'
  replacement?: string;  // 缺省用占位符配置
  enabled: boolean;
  note?: string;
}
```

存在设置项 `agent_redaction_rules` 里（§6.2），因此天然落在四层体系内：
加密存储 > env > 配置文件 > 内置默认。内置权威规则**不**存在这个设置项里——
它们在代码里（`storage/redaction.ts` 的 `BUILTIN_REDACTION_RULES`），结构上就移除不掉。

### 5.3 用户 JS 判定函数

- 契约：一段函数体源码，包成 `new Function('text', body)`；返回命中区间数组
  `Array<[number, number]>`，返回空数组或抛错都按「没有命中」处理（预览不能因为一段
  坏代码而白屏）。
- 默认源码放在 `AGENT_DEFAULTS.redaction_detect_js`（单一出处），设置页编辑器初始
  内容就是它；「恢复默认」把该项写回默认值。
- **服务端不执行用户 JS**。这不是安全警告，是架构事实：服务端执行用户提交的代码等于
  远程代码执行，而这段代码在浏览器里跑只影响用户自己的标签页。服务端的权威脱敏因此
  由内置规则 + 数据规则承担，用户 JS 的命中在客户端就把文本替换掉之后再发出。
- 保存时做语法校验：`new Function` 构造失败 → 明确报错并保留上一份可用的源码。

### 5.4 前后端如何共用同一份规则

- 规则数据只有一份：服务端的设置存储。前端通过 `GET /admin/api/settings` 拿到
  `agent_redaction_rules` / `agent_redaction_placeholder`，通过 `GET /admin/api/redaction-rules`
  拿到内置权威规则的**数据形态**（内置规则也表达成 `RedactionRule[]`，只是 `builtin: true`）。
- 判定引擎是同一个算法的两份实现：`storage/redaction.ts`（服务端）与
  `webui/admin/src/api/redaction.ts`（前端）。`tests/redaction-parity.test.ts` 用同一批
  向量同时驱动两边，输出不一致即红灯——这是防漂移的机制，不是约定。
- 客户端替换发生在发送前：输入框预览用同一套判定，发送时把命中区间替换成占位符。
  服务端收到后再跑一遍内置 + 数据规则（幂等：占位符本身不是密钥形态，不会二次替换）。

### 5.5 判据与误报控制

沿用 `webui/admin/src/api/client.ts` 的 `looksLikeSecretValue` 同款**值形状**判据
（前缀 + 长度 + 字符集），不看字段名：

- 已知前缀 + ≥8 位随机位：`sk-` / `sk-ant-` / `sk-proj-` / `rk-` / `ghp_` / `github_pat_` /
  `glpat-` / `xox[bpsa]-` / `npm_` / `shpat_` / `hf_` / `AIza` / `AKIA` / `ASIA` / `dapi` /
  `sk_live_` / `pk_live_` / `sk-ag-`；
- 无前缀时：≥20 位无分隔符 base62，且大小写与数字俱全。

刻意**不**命中（管理面响应里真实存在的值，误报会让界面充满假红）：

- 带 `_` / `-` / `.` / `:` 的结构化标识：`req_01J…`、`cred_…`、`dek_ab12…`、
  `env:AG_OPENAI_API_KEY`、`deepseek.openai-chat`；
- 十六进制指纹（`kek_fingerprint` 16 位、无大写）；
- 版本号（`0.1.0`、`2026.11.15`）与 UUID（带 `-`，或 32 位纯小写十六进制）；
- 掩码值（含 `*` 或 `…`）与前导位（`head`，比前缀阈值短）。

正文里挑候选串的方式：按空白与一组标点切词，再剥掉首尾的句读标点；含 `*` / `…` 的候选串
整体跳过（掩码保护）。因此 `我的 key 是 sk-xxxx。` 这种句末带句号的也能命中。

## 6. 模型与配置

### 6.1 跑 agent 的模型

走网关自己的推理链路：聊天端点构造一份 OpenAI Chat 形态的请求体
（`client_format: 'openai.chat'`），交给 `PipelineRunner.run`。这条路上 S0–S10 全过——
插件、路由、重试与回退、agentic loop、计量与定价都在内，与数据面客户端完全同一条链路
（60-billing-and-dogfooding.md §6.1：不存在「后台另一套权限」）。

模型由两个设置项决定：`agent_access_path` + `agent_model`。端点用别名解析验证
「这个 model 确实落到配置的 access path 上」，不一致就明确报错并指出两边，
不静默改路由。默认 `deepseek.openai-chat` + `deepseek-flash`（内置别名
`builtin:deepseek-flash` 的既有目标）。

请求体固定带 `ag_agentic_loop: true`（20-pipeline.md §5.1 的网关循环触发条件），
工具清单由设置里的开关决定（§6.2），`ag_max_turns` 透传成 `gateway.max_turns`。

**上游固定跑非流式**。原因：网关 agentic loop 的 `runTurn` 在流式回合下不产出
canonical 响应（S6 只填 `stream_events`），`collectToolUses` 因此拿到 undefined 而抛错——
这是 20-pipeline.md §5.2 的既有边界，数据面客户端打 `stream:true` +
`ag_agentic_loop:true` 今天就会 500。修它要动循环编排（多轮次下 S8 的帧归属），
超出本功能范围，因此这里明确绕开。用户可见行为没有损失：网关的 SSE 本来就是收齐后
一次性写出的（S8 慢路径遍历 `stream_events`），所以「分帧写给浏览器」只是呈现上的渐进，
不假装 token 级流式。

SSE 是**给管理界面的私有协议**（`text` / `tool` / `secret` / `agent` / `end` 五类帧），
不是数据面的 OpenAI 方言；`agent` 汇总帧是权威的那一份，前端以它为准渲染最终状态。

#### 6.1.1 数据面鉴权豁免（代码级，不可从线上伪造）

这条路上唯一的差别在 S0 的鉴权阶段：内置对话**不向数据面鉴权器要客户端凭据**。
理由是两条结构性事实，不是偏好：

1. 这个端点的门在它前面——`POST /admin/api/chat` 归管理面路由，未带合法管理员会话时
   `admin/routes.ts` 直接 401（66 §3：控制面认证）；
2. pipeline 输入是服务端构造的：客户端头经 `ALLOWED_HEADERS` 白名单过滤后只剩
   `content-type`，鉴权头按 `buildAuthMaterial` 单独走、到不了 S0。

因此「让客户端带一把数据面 key 打内置对话」没有意义：它既多出一道用户不掌握的凭据，
也把一个控制面操作挂到数据面 key 的限额 / 撤销语义上。

**豁免必须是代码级的区分，不能是「S0 认一个魔法请求头」**：数据面请求的
`input.headers` 就是客户端原始头，任何客户端自己带一个
`x-ag-internal-caller: agent-builtin` 就绕过鉴权了。落地的形态是
`PipelineInput` / `AuthRequest` 上一个只有服务端第一方调用方会设置的**类型化字段**
（`auth_exemption: { caller: 'agent-builtin' }`，字面量联合 `FirstPartyCaller`），
由 `admin/agent-chat.ts` 在进程内设置；`http/server.ts` 的数据面路径**永远不设置它**，
客户端也没有任何途径写它（它不是头、不是查询参数、不是 body 字段）。

豁免表单点定义在 S0（`gateway-core/pipeline/stages/s0-ingress.ts` 的
`DATA_PLANE_AUTH_EXEMPTIONS`），纪律与 `http/server.ts` 的数据面网关一致：**默认拒绝、
逐条列出、每条带 `why`**；不在表里的 caller 一律不豁免（查表而不是「字段在场即放行」）。

计量归属不丢：豁免请求的 `key_id` 固定为 `agent-builtin`（非人类）。66 §1 的 `key_id`
是计费主键，第一方调用没有客户端 key 可归因，但也不能因此变成匿名调用——否则内置对话的
用量在账面上消失，对账时查无此单。

回归测试：`tests/agent-chat-data-plane-auth.test.ts`——用**真正的**
`DataPlaneAuthenticator`（不是 permissive 占位器）打 `/admin/api/chat` 断言过鉴权；
再把同名标记写在数据面请求的头 / body / query 里，断言一律 401（守住「不可伪造」）。

### 6.2 配置项清单

全部走既有 settings 端口与 `SettingDto` 机制，默认值集中在 `admin/agent-config.ts` 的
`AGENT_DEFAULTS` 一个常量里。设置项分两组：既有的「网关」组（8 项，不动）与新的
「Agent」组。

| key | 类型 | 默认值 | env |
| --- | --- | --- | --- |
| `agent_access_path` | string | `deepseek.openai-chat` | `AG_AGENT_ACCESS_PATH` |
| `agent_model` | string | `deepseek-flash` | `AG_AGENT_MODEL` |
| `agent_system_prompt` | string | `AGENT_DEFAULTS.system_prompt` | `AG_AGENT_SYSTEM_PROMPT` |
| `agent_tools` | string[] | 全部工具名 | `AG_AGENT_TOOLS` |
| `agent_redaction_rules` | json | `[]` | `AG_AGENT_REDACTION_RULES` |
| `agent_redaction_detect_js` | string | `AGENT_DEFAULTS.redaction_detect_js` | `AG_AGENT_REDACTION_DETECT_JS` |
| `agent_redaction_placeholder` | string | `<redacted_key>` | `AG_AGENT_REDACTION_PLACEHOLDER` |
| `agent_redact_tool_results` | bool | `true` | `AG_AGENT_REDACT_TOOL_RESULTS` |
| `agent_temperature` | number | `0.2` | `AG_AGENT_TEMPERATURE` |
| `agent_max_tokens` | int | `2048` | `AG_AGENT_MAX_TOKENS` |
| `agent_max_turns` | int | `8` | `AG_AGENT_MAX_TURNS` |
| `agent_stream` | bool | `true` | `AG_AGENT_STREAM` |
| `agent_persist_messages` | bool | `false` | `AG_AGENT_PERSIST_MESSAGES` |

- 每项在设置页标注来源（加密存储 / env / 配置文件 / 默认）与是否可改；env 锁命中即只读，
  理由与既有 8 项同一套文案。
- 「恢复默认」= `DELETE /admin/api/settings/{id}`：删掉加密存储里的记录，让值沿四层
  回落。比「把默认值写进去」诚实——后者会让来源永远显示「已修改」。
- `SettingDto` 增加 `group` 与 `default_value` 两个字段，设置页据此分区与展示默认值。

### 6.3 系统提示词

可查看、可编辑、可恢复默认。默认值见 `AGENT_DEFAULTS.system_prompt`，内容讲清三件事：
你只能看到掩码看不到密钥；用户贴进来的密钥形态串已被替换；需要密钥时引导用户走弹窗。
提示词本身也过脱敏（§7.1）——管理员不小心把 key 贴进提示词框也不会流给模型。

## 7. 会话与持久化

### 7.1 一次请求里过脱敏的文本

| 文本 | 客户端 | 服务端 |
| --- | --- | --- |
| 用户消息 | 内置 + 数据规则 + 用户 JS，发送前替换 | 内置 + 数据规则，进 canonical 前再跑一遍 |
| 系统提示词 | — | 内置 + 数据规则 |
| 工具结果 | — | 内置 + 数据规则（`agent_redact_tool_results` 可关，默认开） |
| 工具结果（界面） | — | 与模型看到的是同一份（记录器拿的是脱敏之后的那一份） |
| 工具入参 / 工具名 | — | 不过（模型自己生成的，本来就可见） |

工具结果的脱敏点选在 `PluginHost.runOnToolCall` 的装饰器上
（`plugins/redaction-host.ts`）：它包住真正的插件主机，对每个 `ToolResultPart` 的内容
递归脱敏后再返回。选这里的理由是工具循环的 APPEND_TURN 只重跑 S4→S8，
`onRequest` 看不到追加进来的 tool_result——装饰器是唯一能覆盖「某个工具实现疏忽」
又不用改循环编排的位置（20-pipeline.md §5.2）。

### 7.2 会话持久化

`agent_persist_messages` 默认 `false`，与 65-storage-and-retention.md §4.2 的
`persistence.messages` 默认关闭同立场。开启时每轮把「用户消息（已脱敏）+ 助手回复 +
工具调用摘要」写进加密存储的新记录种类 `agent_chat`——复用既有的加密库与 AAD 写法
（65-storage-and-retention.md §3.1），不新造一套存储。落盘前再脱敏一遍，
因此库里即使开了持久化也不会有密钥明文。

会话历史在请求里由客户端带上（无状态，与 OpenAI Chat 一致）；持久化只用于
「刷新后还能翻历史」，不参与请求构造。

## 8. 验收与测试

1. **端到端**（`tests/agent-chat-e2e.test.ts`）：脚本化上游 + 真实 HTTP。
   断言 (a) 用户消息里的密钥形态串在上游请求体里变成 `<redacted_key>`；
   (b) 上游请求体任何位置都不出现该密钥；(c) 一个故意泄漏密钥的测试工具，
   其结果在第二轮上游请求体里也被替换。
2. **工具单测**：`list_credentials` 出参不含 `secret` 字样与任何密钥形态值；
   `add_provider` 的 `needs_credential` 出参不含 key；`create_virtual_key` 的
   tool_result 不含明文，而披露队列里有。
3. **脱敏单测**（`storage/redaction.test.ts`）：各密钥前缀、掩码值不误伤、
   `req_01J…` / UUID / 版本号不误报、句末标点、占位符可配置、额外数据规则生效。
4. **前后端一致性**（`tests/redaction-parity.test.ts`）：同一批向量驱动两边，输出一致。
5. **设置单测**：新 key 的四层解析、env 锁、reset、json 值的校验。
6. **前端单测**：`webui/admin/src/api/chat-stream.test.ts`（SSE 累积与
   `needs_credential` 解析）、`webui/admin/src/api/redaction.test.ts`（预览引擎、
   用户 JS 编译与容错）。
7. **前端契约**（`tests/agent-ui-contract.test.ts`）：路由 / 导航 / 帮助小节接上；
   弹窗密钥走 `/credentials`；对话请求体里没有 `secret` / `plaintext` 字段；
   流式调用不碰 localStorage。
8. **设置单测**：新 key 的四层解析、env 锁、reset、json 值的校验
   （`tests/settings.test.ts` 与 `tests/agent-chat-e2e.test.ts` 的「脱敏可配置」组）。
9. **数据面鉴权回归**（`tests/agent-chat-data-plane-auth.test.ts`）：真
   `DataPlaneAuthenticator`（virtual_key 模式）打 `/admin/api/chat`，断言请求过 S0
   这一层、`UsageRecord.auth.key_id` 是 `agent-builtin`；再把同名豁免标记写在数据面
   请求的头 / body / query 里，断言一律 401。

## 9. 偏离与待办

- `00-overview.md` §4.2 的模块表里没有「agent」这一行。本文不新增顶层模块：
  脱敏引擎落 `storage/`（该模块的既有职责含脱敏），主机装饰器与工具记录器落
  `plugins/`，插件落 `plugins/agent-admin.ts`，配置枢纽（默认值单一出处）落
  `config/agent.ts`，聊天端点与持久化落 `admin/`（控制平面）。
  若 review 认为该单开一行，改文档即可。
- `ag_max_turns` → `gateway.max_turns` 的映射加在 OpenAI Chat codec 的解码侧
  （`ag_agentic_loop` 的邻居），回写仍走 unmapped 透传，不改变既有 round-trip 行为。
- 数据面既有的「流式 + agentic loop」缺陷（`runTurn` 流式下不产出 canonical 响应）
  本文不修，只在 §6.1 说明绕开方式。要修得先定多轮次下 S8 的帧归属，属独立议题。
- §6.1.1（数据面鉴权豁免）是 2026-11 补的实测缺口：`admin/agent-chat.ts` 早先注释里
  写着「鉴权头按白名单挡在外面，S0 用不到」，而 S0 的鉴权阶段无条件跑——virtual_key
  模式下内置对话整条链路失败在 S0，界面拿到的是「缺少 API key」而不是上游结果；
  既有 e2e 测试注入的是 permissive 占位鉴权器，所以这一层从来没人真打过。该小节
  即修正后的设计口径（豁免代码级、单点定义、`key_id` 固定归因），实现与测试以它为准。
- 前端代码编辑器是自绘的两层叠加（`<pre>` 高亮 + `<textarea>` 收输入），
  不引 CodeMirror / Monaco：管理面为此多几百 KB 不值得，而这个场景只需要
  「能看、能改、不白屏」。
- 待办：agent 侧 built-in tool（`web_search`）接入；多会话管理；agent 用量的单独对账口径。
