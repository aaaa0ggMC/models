# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号暂用 `0.1.0-draft`
（设计尚未定稿，不设语义化版本；`docs/design/*.md` 页眉里的 `v1.0-draft` 指设计文档自身的版本）。

## [Unreleased] — 2026-11-16 · 模型选择器只列「已启用渠道 + 有可用凭据」的模型

主人截图报障：「我一个 provider 都没有，你哪里来的模型？」——对话页右侧「运行设置」的
模型下拉摆着 `deepseek-asr` / `deepseek-flash` / `deepseek-tts` / `deepseek-v4-pro`，
而 `GET /admin/api/providers` 返回 0 条（刚删掉重建过）。

两个来源被混成了一个：**能力矩阵**（静态代码，路由与参数预检的依据）与**已配置渠道 +
可用凭据**（管理面配置，「用户现在能用什么」）。矩阵条目写在 `providers/deepseek/profile.ts`
里，与配没配渠道无关；而选择器直接把它当成了「能选的模型」。矩阵本身不动（删了它路由
就没有判据了），要改的是消费它的那个选择器。

顺带修掉同一张截图里的第二件事：`deepseek-asr` / `deepseek-tts` 是工具端点模型
（access path `deepseek.tools.*`），而聊天端点按 **chat 模态**解析 `agent_model`
（`admin/agent-chat.ts` 的 `checkAgentRoute`）——把它们摆进「选一个模型来对话」的下拉，
选完每一条消息都是 400。

### 改动

- **`webui/admin/src/api/model-availability.ts`（新）**：「现在能选哪个」的判据。两条同时
  满足才算能选——① 有已启用渠道（`enabled` 且没被网关自动禁用；「连续失败计数中」不算
  禁用，与请求路径的 `ProviderStateFilter` 同源）；② 该模型的某条接入路径上有一条可用
  凭据（`enabled` 且健康状态不是 `error`），且凭据挂在那个渠道下（只认凭据自己的
  `provider` 字段，不从 access path 前缀猜）。判据全是纯函数；IO 只有
  `fetchSelectableModels` 一个，渠道与凭据读不到时**照实报错 + 重试**，不返回半份清单
  冒充成功。
- **`webui/admin/src/api/models.ts`**：清单客户端只答「有哪些**对话**模型」——
  `chatOnlyOptions` 在两条来源上都跑（数据面有 `modalities`，管理面镜像按逐条 `modality`
  聚合同一个集合；`/admin/api/capabilities` 没有 modality 查询参数，客户端收窄比改端点
  便宜）。文件头写清「有哪些模型」与「现在能选哪个」的分界。
- **`webui/admin/src/pages/AgentRunPanel.tsx`**：模型卡改走 `fetchSelectableModels`；
  一个都不能选时给空状态（一句话 + 一个主操作），主操作按「缺什么」指路——没渠道 →
  去建渠道，有渠道没凭据 → 去录凭据，两者都有但清单还空 → 从上游同步
  （`modelEmptyAction`，纯函数定、UI 只渲染）。
- **`webui/admin/src/api/types.ts`**：`ProviderConfig` 补 `auto_disabled` 镜像字段
  （后端早就返回，前端类型漏了）。
- **测试**：`webui/admin/src/api/model-availability.test.ts`（新，26 条）钉三种部署态——
  0 渠道 / 1 渠道无凭据 / 1 渠道有凭据，选择器分别是空 / 空 / 列出模型；
  `tests/model-selector-availability.test.ts`（新）用真实装配证明判据读的字段真的是
  管理面响应里的形状（形状一错选择器会**永远为空**，而那种故障和「没配渠道」长得一样）；
  `models.test.ts` 与 `chat-contract.test.ts` 补模态收窄与接线断言。
- **`/v1/models`（数据面）口径不变**，理由见下。

### 为什么 `/v1/models` 不改

数据面回答的是另一个问题：客户端带着 key 来问「你能路由什么」。环境变量里配了
`DEEPSEEK_API_KEY` 的部署（没建渠道）确实能路由，所以它照旧列——实测三种部署态：

| 部署态 | `/v1/models` | 管理面「模型目录」页 | 对话页模型下拉 |
| --- | --- | --- | --- |
| 0 渠道 / 0 凭据 / 无环境变量 | 空 | 空 | 空（「没有可选的模型」+ 去建渠道） |
| 0 渠道 / 0 凭据 / 有 `DEEPSEEK_API_KEY` | 4 个 | 4 个 | 空（同上） |
| 1 渠道 / 0 凭据 | 4 个 | 4 个 | 空（「没有可选的模型」+ 去录凭据） |
| 1 渠道 + 1 可用凭据 | 4 个 | 4 个 | `deepseek-flash` / `deepseek-v4-pro` |
| 1 渠道（停用）+ 1 可用凭据 | 4 个 | 4 个 | 空 |

两个口径不同是有意的：合并成一个只会同时骗两边——客户端要的是「路由得了吗」，管理员
要的是「我在管理面配好了吗」。数据面那张脸要收紧的话，建议另起一轮单独评估（它是对外
契约，且 `catalog/registry.ts` 已经在 `expand=access_paths` 里暴露了逐路径的
`credential.available`，收紧的判据是现成的）。

## [Unreleased] — 2026-11-15 · 修内置对话的数据面鉴权缺口（`POST /admin/api/chat` 发消息无反应）

内置 Chat 页发消息没有任何反应——不是网络问题，是服务端在第一层就拒绝了。根因：
`admin/agent-chat.ts` 构造 `PipelineInput` 时只带 `content-type`（注释写着「鉴权头按
`ALLOWED_HEADERS` 白名单挡在外面，S0 用不到」），而 S0 的鉴权阶段**无条件跑**——
`auth/data-plane.ts` 的 `DataPlaneAuthenticator` 在 virtual_key 模式下看不到任何凭据，
整条链路在进路由之前就失败，界面收到的是「缺少 API key」而不是上游的结果。

为什么一直没被发现：`tests/agent-chat-e2e.test.ts` 注入的是 permissive 占位鉴权器
（永远放行），**没有任何测试用真正的 `DataPlaneAuthenticator` 打过这个端点**。

### 改动（S0 显式豁免 + 真鉴权器回归测试）

- **`gateway-core/pipeline/stages/s0-ingress.ts`**：新增**显式豁免表**
  `DATA_PLANE_AUTH_EXEMPTIONS`（单点定义、每条带 `why`；纪律与 `http/server.ts` 的
  数据面网关一致：默认拒绝）。S0 在调用鉴权器之前查表：登记在表里的第一方调用方不向
  鉴权器要凭据，`key_id` 取表里的固定值；不在表里（或没带标记）的一律照常走数据面
  鉴权。豁免的判据**只有** `PipelineInput.auth_exemption` 这个类型化字段——不是请求头：
  数据面请求的 `input.headers` 就是客户端原始头，「S0 认一个魔法头」等于任何客户端
  自带一个标记就能绕过鉴权。`AuthSuccess.via` 增加 `first_party`（审计用，不含凭据）。
- **`gateway-core/pipeline/types.ts`**：`PipelineInput` 新增 `auth_exemption?`
  （`FirstPartyCaller` 字面量联合 + `AuthExemption`）。字面量联合的意义是「随手传一个
  字符串」在类型层面就过不去；`http/server.ts` 的数据面路径永远不设置它（那里补了注释
  说明为什么，免得下一个人顺手加放行口子）。
- **`admin/agent-chat.ts`**：内置对话的 pipeline 输入带上
  `auth_exemption: { caller: 'agent-builtin' }`；文件头补一节说明这条路上唯一的差别
  在 S0、以及为什么豁免不可伪造。
- **`tests/agent-chat-data-plane-auth.test.ts`（新）**：用**真正的**
  `DataPlaneAuthenticator`（`virtualKeysEnabled: true`，一把 key 都没有的虚拟 key 模式）
  打 `/admin/api/chat`——断言过 S0 这一层、真的打到上游、`UsageRecord.auth.key_id` 是
  固定的非人类 `agent-builtin`（计量归属不丢，不变匿名）；反向两条守住 deny-first：
  数据面客户端不带凭据 → 401，把同名豁免标记写在头 / body / query 里也 → 401，
  再加一条控制项（带真 virtual key → 200）证明那道门仍然在 discriminate。
  传输层那道门这里注的是 permissive 占位器（与 `tests/virtual-key.test.ts` 同款理由）：
  要让 S0 做决定，否则「标记伪造」那条断言证明的是传输层而不是我们改的这一层。
- **`docs/design/95-agent-chat.md`**：新增 §6.1.1「数据面鉴权豁免（代码级，不可从线上
  伪造）」，§8 加第 9 条验收（新测试），§9 记录这轮补的实测缺口。
  **`docs/design/66-auth.md` §2.2**：数据面规则里补一条第一方豁免（含 `key_id`
  固定归因的理由）。
- 不在本线程范围（仍然如此）：上游 key 是坏的（加密库里的 deepseek 凭据实测
  `key_invalid`）。修完之后对话从「缺少 API key」变成上游 401——这就是验收标准，
  不是「能聊出回复」。前端把 `event: agent` 帧里的 `error` 吞掉不渲染，归另一条线程。

## [Unreleased] — 2026-11-15 · 右面板改数据驱动（选模型是下拉，不是手填）

主人试用后的原话是「图四明明系统都有模型列表了，结果还要我自己手填也是绝了」：对话页右侧
「运行设置」展开「更改模型」是两个裸文本框（一个填 `deepseek-flash`、一个填
`deepseek.openai-chat`），而系统里早就有模型清单。本轮按 AI Studio 的 Run settings 重做
这块，全部数据驱动。

### 改动

- **`webui/admin/src/api/models.ts`（新）**：选模型用的清单客户端。首选数据面
  `GET /v1/models?expand=access_paths,constraints`（canonical 清单，默认按已配置 provider
  过滤）；数据面过不去时（配了 virtual key 的部署不接受管理面会话令牌）回退管理面镜像
  `GET /admin/api/capabilities`——两边共用 `catalog/visibility.ts` 的同一份可见性判据，
  模型集合由 `tests/admin-capabilities.test.ts` 断言相同，回退不是第二份数据。解析 / 归一是
  纯函数（可单测），IO 只有一个函数；两边都读不到才返回失败，由界面照实显示 + 重试。
- **`webui/admin/src/pages/AgentRunPanel.tsx`**：模型卡从「两个输入框 + 保存/取消/恢复默认」
  改为 Semi Select（选项 `名称 (id)`，副显示 `provider · 接入路径`），选中后渲染该模型的
  元数据（上下文 / 最大输出 / 模态 / 推理强度档位 / 约束标签），全部来自清单响应。选模型时
  渠道跟着走，但以别名解析器为准（`POST /aliases/resolve`，聊天端点的 checkAgentRoute
  校验的就是它），不猜一个接入路径写进去。清单外的值走「自定义模型」（下拉里明确标注
  **高级**，点了才出现输入框），默认态没有任何手填 model id 的输入框。
- **推理强度只展示不切换**：模型带的 effort 档位（`/v1/models` 的 `effort.levels`）渲染成
  档位 + 默认徽标，不是下拉框——Agent 组设置项是白名单（`config/settings.ts` 的
  `RUNTIME_SETTING_KEYS`），里面没有 effort 一项，聊天端点的上游请求体也不带它；画一个
  写了没处存的控件就是假功能。要真能切，得先在配置层加设置项（后端改动，超出本轮范围）。
- **`webui/admin/src/styles/chat.css`**：模型卡改成「选择器即卡首 + 元数据栅格 + 渠道行」的
  轻量结构（一道发丝线分隔，不堆重边框卡片）；渠道下拉吃满剩余宽度，长接入路径不再被截断。
- **契约测试**：`webui/admin/src/pages/chat-contract.test.ts` 新增「模型卡：选模型是下拉」
  一组（默认态无手填输入框、选项来自清单客户端、渠道问解析器、元数据随模型渲染、推理强度
  无假控件、读不到清单照实说）；`webui/admin/src/api/models.test.ts` 22 个单测覆盖两个端点
  的解析、端点次序与诚实失败。

## [Unreleased] — 2026-11-15 · 管理面模型目录与数据面同源（修目录噪声 + 模型重复行 + 状态不诚实）

上一轮给 `GET /v1/models` 加了部署态过滤（未配置 provider 默认不列、mock 脚手架标 internal），
数据面干净了；但管理面「模型目录」页走的是 `GET /admin/api/capabilities`，该路由直通
`capabilityRegistry.list()`，**两条判据一条都没过**——同一个部署里客户端看到 4 个模型，
管理员看到 10 条（含 mock 与没配 key 的 provider），状态还全是绿色「可用」。本轮把两边的
判据收成一处，并修掉「同一模型占两行」。

### 改动

- **`catalog/visibility.ts`（新）**：「这条矩阵条目该不该出现在用户眼前」的唯一判据
  （`internal` 标记 + `providerAvailability` 端口）。`/v1/models` 的记录级过滤与管理面的
  条目级过滤共用它，不再各写一套。
- **`admin/routes.ts`**：`GET /admin/api/capabilities` 默认按部署态过滤；`?all=1` 看全量
  （两个开关的快捷键），也可单独给 `include_internal` / `include_unconfigured`——与
  `/v1/models` 的查询参数同名同义。非法开关值 400（不静默当成没传）。
- **`admin/service.ts`**：`listCapabilityMatrix()` 走上述过滤；全量模式下被隐藏的两类条目
  带标注回来（`internal: true` / `availability: 'unconfigured'`），未配置 ≠ 可用。
- **`composition-root.ts`**：`providerAvailability` 端口与 access path → provider 解析器
  **建一次、注入两处**（ModelCatalog 与 AdminService），两个端口的 provider 归属不会分叉。
- **`admin/api-types.ts` + 前端镜像**：`CapabilityMatrixEntry` 增补两个可选标注字段。
- **`webui/admin/src/pages/ModelCatalog.tsx`**：按模型聚合成行（一个模型一行），接入路径
  合并成行内标签，逐条差异进行内详情；新增「显示全部」开关；状态诚实（未配置 / 内部不再
  显示成绿色「可用」）。行模型抽成纯函数 `pages/catalog-rows.ts`（可单测）。
- **`webui/admin/src/pages/Help.tsx`**：catalog 小节补一段「页面口径」（默认列什么、状态
  怎么写、为什么一个模型一行）。

### 测试

- `tests/admin-capabilities.test.ts`（新，6 例）：管理面端点的默认/全量行为、与
  `/v1/models` 的**模型集合一致性**（同源）、全量标注、鉴权与非法参数。
- `webui/admin/src/pages/catalog-rows.test.ts`（新，10 例）：聚合后同一模型绝不出现两行、
  行级状态诚实（internal / unconfigured / 混合）。
- `tests/admin-api.test.ts`：原「能力矩阵 = 注册表全量」用例改为新契约（默认过滤 +
  `?all=1` 全量 + 两个开关可单独给 + 非法值 400）。
- `tests/models-endpoint.test.ts` 等既有断言不变——`/v1/models` 行为零回归。

## [Unreleased] — 2026-11-14 · 音频端点补 OpenAI 兼容入站脸（`/v1/audio/*`）

在 DeepSeek 全家桶五个 canonical 工具端点（`/v1/tools/*`）之外，新增两个 **OpenAI 形状**的
入口，让 OpenAI SDK 能零修改打进来。两个入口与 canonical 端点**共用同一批上游客户端与
同一套计量口径**（access_path 仍是 `deepseek.tools.tts` / `deepseek.tools.asr`），
差别只在客户端 dialect 的编解码。

### 新增（两个 OpenAI 形状入口 + multipart 解析器）

- **`POST /v1/audio/speech`**（OpenAI TTS 形状）：入参 `{model, input, voice,
  response_format?, speed?}`，返回**音频二进制**（Content-Type 与 Content-Length 按请求的
  format 定）。`response_format` 只支持 `wav` / `pcm`，`mp3` / `opus` / `aac` / `flac`
  **明确 400 拒绝**（不静默转码）；省略时回落 `wav`（OpenAI 本家默认 mp3，上游产不出）。
  `voice` 走 OpenAI 嗓音名 → DeepSeek `voice_id` 的映射表（`OPENAI_TTS_VOICE_MAP`，
  可查可扩展），未映射给 400 并列全可用名。`speed ≠ 1` / 非空 `instructions` 拒绝
  （上游无这两个参数，不静默丢弃）。
- **`POST /v1/audio/transcriptions`**（OpenAI ASR 形状）：**multipart/form-data**
  （`file` + `model` / `language?` / `prompt?` / `response_format?` / `temperature?`），
  `response_format` 支持 `json` / `text` / `verbose_json`（`srt` / `vtt` 明确拒绝）。
  上游不返回分段，故 `verbose_json` 的 `segments` 恒为空数组、`language` 省略（不谎称
  检测到了语种）。
- **`POST /v1/audio/translations`**：**明确不支持** → 501 + `translations_not_supported`。
  DeepSeek ASR 只做同语言转写，没有翻译目标参数。
- **自研 multipart/form-data 解析器**（`http/multipart.ts`，零新增运行时依赖）：分片数 /
  字段大小 / 文件大小 / 头部大小四条限额，boundary 白名单字符，只认 CRLF 分隔符。
  引库的论证见该文件头（busboy 会拖进 streamsearch，而我们不需要流式）。
- **音频能力条目**（`deepseek-tts` / `deepseek-asr`，modality = tts / asr）进能力矩阵：
  `/v1/models` 因此多列两条，`/v1/audio/*` 的 `model` 解析以矩阵为唯一事实来源。
- **模型解析**：`model` 走既有四级优先级（OpenAI 客户端名别名 → 显式别名 → namespace
  生效名 → passthrough），解析不到 400 并列全可用名。`tts-1` / `whisper-1` 等 OpenAI
  客户端模型名开箱可用。

### 改动

- `http/tools-endpoint.ts`：把鉴权头脱敏、上游错误分类、用量记录三个 helper 导出，
  供音频端点共用（同一上游、同一套错误码与计量口径，不各写一份）。
- `admin/aliases.ts`：`AliasResolver.resolve` / `AliasCapabilityLookup.list` 的 modality
  形参从 `'chat'` 放宽到 `ModalityKind`——音频端点复用同一个解析器，不需要第二套优先级逻辑。
- `admin/service.ts`：namespace 规则的 access_paths 改为取能力矩阵里该 provider 的
  **全部**路径（原先只取 chat），否则 `ds/deepseek-tts` 这种 namespace 生效名解析不到。
- `http/server.ts`：挂载 `/v1/audio/*`（自带更紧的体上限 8 MiB + 64 KiB，对齐上游 ASR
  限额）；请求体超限时**先把剩余字节读干净再回 413**，否则客户端可能堵在写请求体上。

### 测试

- `tests/multipart.test.ts`（29 例）：解析器单测——二进制内容不被切坏、边界严格性、
  文件名（引号/转义/路径穿越/RFC 5987/CRLF 注入）、四条限额。
- `tests/audio-openai-endpoints.test.ts`（44 例）：两个端点的 round-trip、三种
  response_format、voice 命中/未命中、multipart 缺 file、超大文件（400）与超体（413）、
  模型解析失败、计费单位、401/405/415/501、未知路由 404。
- `tests/models-openai-sdk-audio.test.ts`（12 例）：**官方 OpenAI SDK** 打真 HTTP 服务
  （`audio.speech.create` 拿音频二进制、`audio.transcriptions.create` 三种格式、
  错误走 SDK 自己的错误类）。
- 既有 `model-catalog` / `models-endpoint` / `models-openai-sdk` 的期望值随两条新能力
  条目更新（它们是真的可路由能力，该被列出来）。

### 已知未处理（音频端点，留给作者）

- 流式 TTS（OpenAI 支持 chunked 音频）：DeepSeek 的流式是 WebSocket 模式，本轮不做。
- Anthropic / Gemini 的音频入站脸：Anthropic 没有音频 API；Gemini 的 TTS 走 chat 通道，
  形状与 OpenAI 音频端点不同，不该塞进同一个文件。
- 转写的 `language` / `prompt` 到不了上游（DeepSeek ASR 的 wire 只有 `file`）：canonical
  形状建模了这两个字段故照收，但上游忽略。属 canonical 脸既有事实，本轮不改 canonical 形状。
- `docs/design/` 未改（走 PR）：10-canonical-schema.md §2.1 的端点清单、15-modalities.md
  §8.1 的多模态端点表都要补这两个 OpenAI 音频端点。

## [Unreleased] — 2026-11-14 · review #1–#8 逐条处置 + #8 六条设计决定定稿

本轮把对外分发的 8 个 GitHub issue 逐条核实后落地。**每个 issue 的核实结论与证据见 issue 内的回复**；
本文只记"改了什么"。

### 修复（内容错误 / 渲染错误）

- **#1 `docs/design/40-provider-adaptors.md`**：删掉 L252 多余的 ` ``` `（它**打开**了一个新代码块，
  而 L394 的 ` ```typescript ` 带语言标识不能当结束标记，导致 §1.2–§4 共 13 个标题被吞进 `<pre>`）。
  修后全文件围栏数 16（偶数），42 个标题全部正常渲染。
  - 顺带修同一文件的编号问题：第二个 `### 1.2`（原 L254，排在 §1.6 之后）改为 `### 1.7`；
    `### 2.2c` 与 `### 2.2b` 对调，使编号顺序与出现顺序一致。
- **#2(a) 存储加密口径**：`00-overview.md` §7.4 原写"只做应用层逐记录加密、不选整库加密"，
  与 `65-storage-and-retention.md` 决策 S1（整库 + 列级双层）相反。已按 S1 统一；
  `60-billing-and-dogfooding.md` §6 的副本同步；AAD 写法从四种（"记录 id" / "request_id" /
  "request_id + schema 版本" / "request_id + ir_version"）统一为 `request_id + ir_version`。
  §9 Review 指引第 2 条的攻击点也随之更新。
- **#2(b) fast path usage 嗅探**：`20-pipeline.md` §4.2 原写超限"仅记录已知 token 数 = 0 + warning"，
  违反"未知绝不用 0 表示"的硬约束。改为**省略对应键 + `usage_sniffer_truncated`**，并写明
  **必须解析流尾的 usage 事件**（OpenAI Chat 只在末 chunk、Responses 在 `response.completed`、
  Anthropic 分两次、Gemini 每 chunk）——按字节数从流头截断会恰好漏掉 usage。
- **#2(c) decision 降级默认值**：`40-provider-adaptors.md` 决策 D9 原写"默认不自动启用"，
  同节与 `15-modalities.md` §6.5 却写"推荐默认 `on_missing_upstream`"。统一为
  **`on_missing_upstream`**（安全性由 `allow_degrade_high_stakes` 默认 `false` 保证），
  并在原处标注**待作者拍板**。
- **#2(e) 数量说法**：模态 8→**9**（`00 §2.1` 括号里本来就列了 9 个）、"7 模态 payload"→9、
  "第五模态"→"第 9 个模态（2026-11 新增，在 `ModalityKind` 里排第 2）"；阶段 10→**11（S0–S10）**
  （`00 §4.2` 模块表、`00 §6` 索引、`20-pipeline.md` §2、`70-roadmap.md` Phase 1、`AGENTS.md`）。
- **#2(g) 配置键**：`persist_messages` → `persistence.messages`（`60` 5 处、`70-roadmap` 3 处）。
- **#3 TypeScript 草案**：`10-canonical-schema.md` L187 `| "gemini.generateContent";` 的多余分号
  （提前结束 `FormatId` 联合，导致后面所有多模态格式报 TS1109）已删；
  §4.6 D8b"五种 canonical 稳定类型"→**四种**（只列了 4 种）。
  跨文档冲突里**已修**的两处：`25-streaming.md` 重复定义且漏 `decision` 的 `ModalityKind`
  改为引用 10 §3.1；`50-builtin-search.md` 的 `BuiltinTool.name` 改成只用 canonical 稳定名
  （与它自己 §2.2 的归一化规则一致），厂商专有名移到 `provider_tool_type`。
  **未执行**"把类型抽成真实代码文件"（提案已写进 10 的页眉，待作者拍板）。
- **#4 外部说法与数字**：
  - Cloudflare：标 Deprecated 的是 **Universal Endpoint**，替代建议是"用 OpenAI 兼容端点"；
    "Unified API (OpenAI compat)" 页写的是 "Deprecated for single-model calls"，
    替代方案 REST API **仍是** OpenAI 兼容的 `/ai/v1/chat/completions`。
    "这是对强行统一成 OpenAI 方言的实证否定"这一论据**不成立，已删除**。
  - LiteLLM：`00 §1.2` 表里"❌ 无 hook 系统"改为"⚠️ 有 hook（`async_pre_call_hook` /
    `async_post_call_success_hook` / `async_post_call_streaming_hook`），但挂在具体协议的字节上，
    非 canonical 级"；`00 §7.2`"现有开源**全部没有**插件系统"改为"没有现成开源项目提供
    **格式无关（只面向 canonical）** 的插件 hook"。
  - OpenRouter"唯一同时提供三种入站格式的商用网关"→"少数"（LiteLLM 支持 4 种，含
    `/v1beta/models/{model}:generateContent`）。
  - `15-modalities.md` §6.5 成本倍数 844.6x → **1189.0x**（844.6x 属于 GPT-6 Astra 那一行）。
  - `sources.md` 失效链接：OpenAI Chat Completions reference 404 → 现行地址
    `.../resources/chat/subresources/completions/methods/create`；`Filen.io/age` 404 →
    `FiloSottile/age`；`nick33810/napi-rs-keyring` 404 → `Brooooooklyn/keyring-node`
    （npm registry `repository` 字段）；`sqlcipher.org` 连不上 → `zetetic.net/sqlcipher`。
- **#5 结构编号**：`00` 两个 `### 1.2`（后一个改 `### 1.4`）；`70-roadmap.md` 补上缺失的
  `## 1. Phase 0`（原 Phase 0 内容挂在 `## 0.1` 下，编号从 0.1 跳到 2）；`sources.md`
  `2.10`→`2.9`、`2.11`→`2.10`（原 2.8 直接跳 2.10）；`sources.md` 待验证清单第 13 条
  "本节 §5"→"本节 §6"；`70-roadmap.md` 裸 `§1.6` 引用补上 `40-provider-adaptors.md`；
  `15-modalities.md` 标题补 `decision`。
- **#6 版本标签与 Phase 冲突**：新增 `[v1]/[v1.5]/[later]` ↔ Phase 映射表（`70-roadmap.md` §1.1.1），
  并修掉 4 处冲突：`openai.embeddings` 改 [v1.5]/Phase 4；`gemini.generateContent` 明确
  "版本标签是能力档次、Phase 是排期，二者不是一对一"；控制面认证 [v1] 注明"能力先于其消费者
  WebUI（[v1.5]）就绪，不是依赖倒置"；**Phase 1 凭据加密的密钥档位**明确为"只走 env / keyring，
  `vault`（加密库）到 Phase 4 密钥体系落地后才开放"。
- **#6 README / AGENTS 同步**：hook 3→5；WebUI"选型中"→"fork LibreChat"；文档状态"撰写中"→
  "v1.0-draft 待 review"；目录命名三套统一为 `00 §4.2` 的模块名（`src/canonical/`、`schema/` 废止）；
  `AGENTS.md` 的"另一线程/负责线程"改成可执行规则（`docs/` 改动走 PR、由仓库主人 review）；
  `.gitignore` 删掉旧定位残留（`snapshots/*.raw.json` 及 `data/raw/` 注释）。

### 改动（去重与口径统一）

- **#5 大段重复**：`60-billing-and-dogfooding.md` §5/§7–§9（分层存储、前缀压缩、保留、脱敏）
  改为指向 `65-storage-and-retention.md` §4–§7 的指针，只保留"计费管道需要存储提供什么"这一个视角
  （此前两份已漂移：字典表名 `zstd_dict` vs `zstd_dicts`、无字典压缩率 3–5× vs 1.25–5×、
  加密范围"只应用层" vs "双层"）。`StoredConversation` 类型移到 65 §4.3 作为唯一定义处。
  `60` 原 §10/§11 顺次前移为 §6/§7 避免跳号。
  `20-pipeline.md` §4.3 重复的 usage 口径表删除，只留指向 `40 §2.1` 的指针
  （该副本已和 40 漂移：把 OpenAI Chat 的 `cache_write_tokens` 写成"无对应"）。
  非目标只保留在 `00 §2.2`（`70 §7` 改为回指 + 保留两条时间性表述；70 独有的第 7、8 条并入 00）。
  `70-roadmap.md` Phase 4 验收里"压缩率达到 60 §7.3"改为"65 §5.3"。
- **#5 Open Questions**：`10 §10` 原称"编号 Q1–Q12 与 00 §8、12 §5 对齐"（实际对不上），
  改为全局编号说明；冲突的 Q6/Q7 改名 **Q11/Q12**（00 §8 的 Q6/Q7 另有所指，分别被 65/30 使用）；
  `12 §5` 的 1–12 补全局编号 **Q31–Q42**，17–22 重排为 13–18（仍对应 Q25–Q30）；
  **Q21–Q24 状态统一为"已解答"**（`40 §8`、`sources.md §7` 里仍列为开放的副本已同步）；
  Q1 状态矛盾（`40 §2.2c I1` 写"定论" vs `40 §8` 写"最高优先级"）统一为"仍开放 + OpenAI 侧 `[待验证]`"；
  `10 §10` 的 Q18"待 40 §6 回填"改为已关闭（40 §6.2 已回填）。
- **#5 页眉依赖**：删掉全部手写的"下游被引用于"（12 声明 1 篇实际 5 篇、15 声明 1 篇实际 8 篇、
  40 声明 1 篇实际 9 篇、65 声明 1 篇实际 7 篇——手工维护必然失真），只保留"上游依赖"。
- **#2(f) hook 生命周期**：`30-plugin-api.md` §3 时序图补上 `onToolCall`（网关 agentic loop 内
  每次工具执行点触发）与 `onError`（横切点）及其触发条件；`20-pipeline.md` 阶段职责表加
  "插件 hook"列；`00 §4.2` 模块表补 `credentials`(45) / `auth`(66) / `decision` 三行。
- **#3 命名**：`CanonicalRequest` / `CanonicalResponse` 与 `CanonicalRequestEnvelope` /
  `CanonicalResponseEnvelope` 的关系统一说明为"以后者为准"，写在 65 §4.3（`StoredConversation`
  定义处）与 10 页眉。

### 新增

- **#7 `.github/workflows/docs.yml`**：四个 job —— markdownlint-cli2（关 MD013/MD060）、
  lychee 外链检查（带排除与限流，schedule 每周跑）、`scripts/check-docs.mjs`
  （围栏奇偶 + `§N` 引用目标存在 + 同文件节号不重复不跳号 + 术语禁用同义词 grep）、
  tsc/ajv（**待类型抽取后启用**，只打印说明）。
  工作流里记录了 GitHub Pages 私有仓库需付费档且默认公开的限制，以及以后若建文档站的备选对比。
- **#7 `scripts/check-docs.mjs`**：零依赖 Node 脚本，实现上一行说的四项校验。
- **#7 `.markdownlint-cli2.jsonc` / `.lychee.toml`**：两个 linter 的配置与排除理由。
- **#7 `CONTRIBUTING.md`**：从 `AGENTS.md` 提取 privacy-scan 与 git 约定，加上文档改动的检查清单。
- **#7 存量 markdownlint 违规清零**：MD032 84 处、MD040 23 处、MD036 12 处、MD028 3 处、
  MD034 2 处、MD033 2 处、MD012 1 处、MD029 6 处全部修掉（否则 CI 一上线就是红的）。
  改动都是空白行 / 代码块语言标注 / 加粗冒充标题改冒号引导这类机械修正，不涉及内容。

### 设计风险（#8）—— 作者已逐条拍板，全部定稿

> 上一轮只写了"问题 + 建议解法 + 待拍板点"。**本轮（2026-11-14 续）仓库主人对六条逐条拍板，
> 已把结论原意落入文档**，定稿内容见下一节；此节保留问题本身的记录。

- **KEK 轮换与派生方式矛盾**（`65-storage-and-retention.md` §3.1）：DEK 由 HKDF 派生却说"轮换 KEK
  只需重包 DEK"——二者互斥。
- **nonce 计数器可能重复**（同节）：重启 / 多 worker / 多进程写同一 session 时会重用 AES-GCM nonce。
- **fast path 仍先完整解码**（`20-pipeline.md` §4.2）：与"附加延迟 < 3ms p99"有张力。
- **relaykit 与拒绝 NewAPI 的理由自相矛盾**（`00-overview.md` §1.3）：relaykit 同样 AGPL-3.0。
- **per-session zstd 字典**（`65-storage-and-retention.md` §5.2）：`zstd --train` 需 >100 样本，
  多数会话攒不到。
- **LibreChat 必须依赖 MongoDB**（`00-overview.md` §7.3、`docs/sources.md` §3/§6）：与"SQLite 单文件"
  意味着两套存储；MongoDB SSPL 合规此前未定。

### 定稿（review #8 六条设计决定，2026-11-14）

仓库主人逐条拍板，以下六条已从"待拍板"改为**定稿**写入文档；未改动技术结论，只把结论落到原文位置
并清掉与之冲突的旧表述。

| # | 决定 | 落点 |
|---|---|---|
| 1 | **DEK 随机生成 + KEK 包裹（信封加密）**，不再用 `DEK = HKDF(KEK, salt=session_id, …)` 派生；轮换 KEK 只需重包 DEK。HKDF 的边界写死（KEK 只由 Argon2id 派生，HKDF 不用于从 KEK 派生 DEK）。同步改 AAD、轮换流程、恢复流程 | `65-storage-and-retention.md` §3.1（+ §1 决策 S1/S4、§3.2b、§3.3、§4.3、§5.5、§7） |
| 2 | **XChaCha20-Poly1305 + 192-bit 随机 nonce**，不做计数器持久化；注明替代方案 **AES-GCM-SIV**（FIPS/审计合规时）及取舍 | `65-storage-and-retention.md` §3.1（密钥层次图 + 正文） |
| 3 | **fast path 惰性解码**：S1 只解析「信封 + 路由必需字段」，完整 canonical 推迟到 S3 插件链 / S4 Encode / S6 ProviderDecode 的非 fast path 分支；响应侧只抽 usage 信封并直通原始字节。**准入条件**：插件 manifest `scope: "envelope-only" \| "full-canonical"`，仅当全部已启用请求侧插件都是 `envelope-only`（或无请求侧插件）才允许 fast path；该条件由配置/组合根启动时计算并缓存，运行中增删插件需失效重算 | `20-pipeline.md` §3（S1）、§4.1、§4.2；`00-overview.md` §4.1 数据流、§3 性能约束、§1.4、§2.1、§9；`70-roadmap.md` Phase 1 交付物/验收、§8 风险表；`30-plugin-api.md` §2 `PluginManifest.scope`；`40-provider-adaptors.md` §1.1 `decode` 两档 |
| 4 | **relaykit 明确「不采用」**：与 NewAPI 同为 AGPL-3.0，与"因 AGPL 拒绝 NewAPI"的首要理由自相矛盾；借鉴限"读设计、不引代码"；确需其代码须独立进程/服务边界隔离并先做许可证评估 | `00-overview.md` §1.3；`docs/sources.md` §6 License 汇总 |
| 5 | **取消 per-session zstd 字典**，改为**全局字典 + 可选按客户端类型的字典变体**，离线训练、带版本号（`dict_id`）、入库加密；小会话退化为无字典压缩并记录实际压缩率 | `65-storage-and-retention.md` §5.2（+ §4.3 `zstd_dicts` 表、§5.3、§8 Q5）；`00-overview.md` §7.5、§8 Q5；`60-billing-and-dogfooding.md` §2/§7；`docs/sources.md` §4 结论、§7 |
| 6 | **维持 fork LibreChat**；**MongoDB 作为独立服务/容器部署，网关核心（SQLite 单文件）不依赖它**；**SSPL 立场**：私人自托管自用可接受，仓库公开/开源需重新评估（revisit 触发条件已写明）；**Meilisearch 列为可选** | `00-overview.md` §7.3；`docs/sources.md` §3、§6 License 汇总、§7 第 14 条 |

**连带修掉的冲突**（落地时发现，均与上述六条直接相关）：

- `docs/sources.md` §4 结论行的 AAD 仍写 `request_id` + schema 版本（全文已统一为 `request_id + ir_version`）——
  随本轮改写一并统一，并把算法/字典口径同步为定稿值。
- `65-storage-and-retention.md` §3.2b、§3.3 里"DEK 派生""GCM 解密"等旧措辞改为"解包"
  "XChaCha20-Poly1305 解密"，避免与定稿的信封加密口径冲突。
- `70-roadmap.md` Phase 1 的"p99 附加延迟 < 3ms"此前没有说明它靠什么成立——补上"S1 信封级惰性解析 +
  插件 `scope` 准入"这个前提，并新增"fast path 准入可观测"一条验收。
- `00-overview.md` §4.1 数据流图里 S1 框写的 `→canon` 改为 `→信封`，并加一段惰性解析说明。
- `60-billing-and-dogfooding.md` §2 管道图与 §7 待验证里的"共享字典"改为"全局字典"，与 65 §5.2 一致。
- `30-plugin-api.md` §4.2 的 billion-context adaptor 示例 manifest 补 `scope: "full-canonical"`（它要改写
  messages，fast path 因此对它关闭）。

## [Unreleased] — 2026-11-14 · always-canonical 与「透传」术语定稿

仓库主人追加两个架构决定，本轮落入文档。

### 决定 A：v1 全部走 canonical，去掉字节级 fast path

**理由**：canonical 往返在 Node 里就是 JSON parse + 对象映射 + stringify，典型对话请求亚毫秒到
几毫秒，相对 LLM 推理可忽略；私人低流量网关不值得维护两条代码路径。
**换来**：单一代码路径、插件永远可见 canonical、usage 标准化永远执行、round-trip 测试永远被走到。

| 原决定 | 处置 |
|---|---|
| D-fastpath-1（S1 信封档惰性解码，完整 canonical 推迟到 S3/S4/S6） | **作废**，降级为"未来可选优化" |
| D-fastpath-2（插件 manifest `scope: "envelope-only" \| "full-canonical"` 静态准入） | **作废**；`scope` 字段无其他用途，标注废弃 |

**落点**：

- `20-pipeline.md`：§1 设计原则第 2 条、§2 阶段职责表（S1/S2/S4/S6/S8 的"跳过完整互转"表述全部改为
  "一律完整走 canonical"）与数据流图、§3 S1 的两档说明、§4 整节改为"已废弃 + 存档 + 加回条件"、
  §6.4、§8 `RequestTrace`、§9 待验证；`RequestContext.fast_path` → `canonical_roundtrip`（恒 true）。
- `00-overview.md`：§1.4 核心价值主张、§2.1 范围表、§3 性能约束（**删除"< 3ms p99"硬门限**，改为
  "canonical 往返附加延迟为实测记录值，不作为硬性验收门限"）、§4.1 数据流图与说明、§5 术语表
  （fast path 标为已废弃）、§6 索引、§9 Review 指引。
- `70-roadmap.md`：§0 组织原则、§1.1 阶段总览与版本映射表、Phase 1 交付物/验收（压测与可观测性条目
  重写）、Phase 3/4/5 相关条目、§8 风险表。
- `AGENTS.md`：关键设计约束的 fast path 一条改写。
- `40-provider-adaptors.md`：§1.1 `Adaptor` 接口（`decode` 两档说明、`EncodedRequest.raw_bytes` /
  `fast_path` 标废弃）、§1.2 最小实现面、§1.4 有序偏好表、§1.5 round-trip 模板（断言 B 与测试名）、
  §1.6 检查清单。
- `30-plugin-api.md`：§2 `PluginManifest.scope` 标废弃（`scope?: never`）、§2.1 删 `disableFastPath`、
  §3 时序图、§4.2 示例 manifest 删 `scope`。
- `10-canonical-schema.md`：§7.4、§9.3 脚注；`12-coverage-survey.md` §4.2 判据；
  `15-modalities.md` §6.4 决策消费表；`README.md` 核心设计/目录/状态。
- **加回条件（写实，不拍脑袋）**：`20-pipeline.md` §4.4 列了五条，核心是「实测 canonical 往返开销
  占端到端延迟比例已不可忽略」「私人网关流量高到有回报」「双路径行为一致性有测试保障」「插件可见性
  不倒退」「计费口径不倒退」。任一条不满足就维持 always-canonical。

### 决定 B：「透传」= 语义不变地完成一次格式转换，不是零 mapping

目标格式既可以是标准 OpenAI 形态（`{"type": "web_search"}`、标准 chat.completions 结构），也可以是
上游方言（如 DeepSeek 的 `deepseek_web_search` 参数）；无论哪种都过 codec/mapping、都有 round-trip
测试。**系统内不存在"原样转发字节"的路径。**

**落点**：

- `00-overview.md` §5 术语表新增「**透传 / passthrough**」条目；§7.0.3 OpenRouter quirks 三档里的
  "透传"一条补上定义。
- `50-builtin-search.md`：§3.1 标题改为"模式 A：上游原生执行（**语义透传 + 方言映射**）"，开头写明
  透传的定义，同格式行从"**完全透传**，`tools[]` 原样"改为"语义透传 + 方言映射"；原"fast path 保证"
  一段改为"两条路径对客户端行为一致"；§1 理由第 2 条同步。
- `AGENTS.md` 关键设计约束补「透传」定义条目。
- `README.md` 内置搜索一节同步。
- **全文 grep "透传" 后统一**：`10-canonical-schema.md`（`source_format` 注释、§7.4、§9.3 脚注、Q19）、
  `15-modalities.md` §8.2/§8.3（ASR 实时的 WS 中继改称"**字节级中继**"并注明它是音频传输层中继、
  不是格式转换路径）、`25-streaming.md`（§1 兼容性矩阵、§2.1、§3.1 删"透传模式：原样转发字节"一条、
  §3.3 路径 1 改名"字节级中继代理"、§4、§8.3、§10）、`30-plugin-api.md` §3/§4.4b、
  `40-provider-adaptors.md` §1.4/§2.2c、`70-roadmap.md` Phase 4/5。
  `docs/sources.md` 里转述第三方（Vercel AI SDK / NewAPI / LiteLLM / llm-bridge）命名的"透传"保留原样。

### 附带：always-canonical 的存储侧收益（落盘即 canonical）

因为 v1 一律走 canonical，网关上落盘的所有聊天记录天然就是 canonical 格式。推论写入
`65-storage-and-retention.md` 新增 §5.6 与 `60-billing-and-dogfooding.md` §5：落盘即 canonical
（不需为每家厂商各写一套解析/统计）、前缀压缩按消息/parts 差分而非字节差分、usage 多单位已归一化
可直接消费、任何一条会话都能重放成任意 dialect、存储层只依赖 `ir_version`。

### 计费原则：价格会更新，历史记录绝不被重算（含 DeepSeek 峰谷计费）

新增 `60-billing-and-dogfooding.md` §4.2，并改造 §3 `UsageRecord` 的计费字段。

**决策**：每条记录的计费信息在请求完成时基于当时可得信息一次性算出并**快照固化**；当时没有价格就标记
`pending_price` 并保留 usage；补录时用**请求时点的有效价格**而不是当前价格。

**`UsageRecord` 计费字段**（原 `cost` + `cost_caliber` 合并重构）：

- `usage`：多单位 + `source: "provider" | "estimated"` + `precision` / `estimate_method`；
- `price_snapshot`：表版本 + 规则集版本 + 命中 `tier` + 时段窗口 + `holiday_status` + 实际费率 +
  费率条目生效日期 + 来源 URL 与抓取日期；
- `cost.as_api_micros`：等值 API 计费，**永远尝试计算**（订阅/无 usage 路径下唯一稳定的参考值）；
- `cost.cash_micros`：实际现金支出，订阅路径为 0；
- `cost.status`：`priced` / `pending_price` / `unpriced`。

**四条硬规则**：a) 不可变 + 快照，价格表更新不得重算已有记录；b) 请求时尝试计费，拿不到价格记
`pending_price` 且保留 usage；c) backfill 通过价格表生效区间查**请求时点**的有效价格，记录 `backfilled_at`
与所用表版本；d) `as_api` 永远尝试计算，`cash` 与 `as_api` 分开存储不合并。

**价格表三层结构**（DeepSeek 无官方价格 API，只能是仓库内静态、带版本与来源日期的表）：

1. **规则集**：一整套"时段窗口 + 工作日/周末/节假日规则"，整体带 `effective_from`/`effective_to`
   （峰谷体系 2026-08-17 生效、周末全天低谷 2026-08-23 生效，规则集会叠加变更）；点时间解析先选当时
   有效的规则集，再在集合内定档。
2. **费率**：按模型 + 计价单位（缓存命中输入/未命中输入/输出等），同样带生效日期。
3. **节假日日历**：按年维护，**含调休上班日**，带来源与年份；缺失日期按工作日保守处理并标
   `holiday_unknown`；留出公共节假日 API 生成入口，**不用算法推算节假日**。

**已核实的峰谷规则**（来源见 `docs/sources.md` §1.4）：2026-08-17 00:00（Asia/Shanghai）生效，高峰价为
低谷 2 倍；高峰 = 工作日 09:00–12:00、14:00–18:00（北京时间）；2026-08-23 起周末全天低谷，空闲时段含
法定节假日。**官方明确"新规则生效前产生的费用仍按原标准结算"**——供应商自己都不重算历史，是本节原则的
外部佐证。

**其余要点**：

- 时区按规则集的 `tz` 显式换算（`Intl`/Luxon，不手算 UTC 偏移）。
- **上游响应不返回命中档位**，`price_snapshot.tier` 必须由网关按请求时间戳自行解析；若 DeepSeek 暴露
  余额/用量查询端点，可作为实际扣费真值对账，估算与事实分开记。
- **cash 与 as_api 必须用同一次 `resolvePrice(ts)` 的结果**（同一次解析、同一组 rates，只是乘的单价不同）。
- **跨时段边界**：流式请求跨错峰/高峰边界时按**请求开始时间定档**（确定性优先），并按 chunk 时间戳拆分的
  取舍已写明（v1 选前者，拆分只作为派生视图）。
- **订阅摊销**从单条记录里移出，改为查询时的可选派生指标（依赖预估额度，与快照不可变冲突）；
  `45-credentials.md` §7.2 已加指针收敛。
- `65-storage-and-retention.md` §7 保留策略补一句：`price_snapshot` 随 usage 明细长期保留以供对账，
  不参与 rollup 聚合删除。

**真值对账（余额即事实）**：已核实 DeepSeek 用同一个 API key 即可查询余额，于是形成
「**估算**（快照 + 峰谷定档）→ **事实**（余额对账）→ **偏差告警**」三级闭环，写入 60 §4.2。

- computed cost 是**估算**，上游余额差是**事实**；两者分开存储、分开展示，绝不互相覆盖。
- **只做区间级对账，不做逐笔归因**：周期快照余额，对比「区间内余额差」与「区间内估算 cash 总和」，
  产出 `{ estimated_cash_micros, actual_balance_delta_micros, deviation_ratio, snapshot_ok }`。
  理由：并发请求下无法把余额差归因到单笔请求。偏差持续过大时告警——意味着价格表、峰谷定档或
  usage 归一有错。
- **两个坑**：① DeepSeek **赠送余额优先扣**，余额差 ≠ 现金支出，对账记录必须能区分（给不出区分就标
  "含赠送"并降低告警灵敏度）；② 余额是时点值，快照失败/丢失会造成区间缺口——记录缺口而不是假装连续，
  缺口区间不参与偏差率计算。
- **附带用途**：低余额作为路由信号（配合 Plan 感知路由转向订阅路径，`45-credentials.md` §5.2 已补），
  以及请求前预检避免必然失败的调用。

### 已知未处理（留给作者）

- **类型抽取成 `ir/*.ts`**（#3 建议 2）：只写了提案，未执行；`tsc`/`ajv` CI 因此标注为"待启用"。
- **decision 抽成独立主文档**（#5 建议 1）：decision 主题散在 10 §4.6、12 §1.5/§5.1、15 §6、
  20 §6、40 §6、70、sources §5 共七处，尚未合并。
- **约 25 条决策迁到 `docs/decisions/NNNN-*.md`（MADR 4.0）**（#5 建议 2）、
  **Open Questions 集中到 `docs/design/open-questions.md`**（#5 建议 3）：均未执行。
- **`CapabilityEntry` 两份定义合并**（#3 建议 3）：15 与 45 的两份形状不同（键是 `provider` 还是
  `(access_path, model)`、有没有 `framing`），涉及路由与能力矩阵的核心结构，需作者拍板后统一。
- **"canonical 对 9 模态一次做全"的范围风险**（#8.5 次要项）：与 70 §8 风险表里的
  "多模态 schema 过度设计"相关，建议给穷尽普查设截止标准。
