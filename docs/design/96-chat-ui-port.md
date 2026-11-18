# 96 · 内置对话 UI 移植设计（DSH chat UI → AgentGateway）

> 状态：v1.0-draft，待 review。本文是「把 DeepSeek Harness（下称 DSH）聊天界面的呈现
> 搬到 AgentGateway 内置对话页」的唯一设计依据。
>
> **边界（硬）**：本文只做调研结论与设计，不含实现代码，不改 `webui/`、不改后端。
> 实现线程从含外援提交 `be9155a` 的 HEAD 起（§7.1），本文的落点全部是「待建文件」
> 而不是改动。

## 0. 阅读指引

### 0.1 六个结论（先说答案）

1. **值得搬的是七件「纯呈现」**：thinking 折叠行、工具调用卡、回合过程条、回合用量面板、
   流光文字、两个格式化 helper、视觉令牌。**ChatView 本体与它的 rAF 折叠动画引擎不搬**——
   前者依赖 14 个注入包与一张私有快照，后者依赖 DSH 的滚动锚点与视口驱动。
2. **thinking 行是最大收益，而服务端只差一步**：AG-IR 早已建模 `thinking` part，
   OpenAI Chat 编解码器也已把 `reasoning_content` 双向映射（`adaptors/openai-chat/codec.ts`
   的 `MODELLED_MESSAGE_KEYS` 与回写分支）。缺的只是 `admin/agent-chat.ts` 的 `foldChat`
   现在**只取 `content`，把 `reasoning_content` 丢掉了**。取出来即可，不需要新管道。
3. **工具卡从「一张卡」升级为「四态 + 入参/结果分区」**，是第二收益；改造量集中在
   把 DSH 的纯函数模型层搬过来、行组件用 Semi 重写。
4. **会话管理缺的是读侧**：写侧（`admin/agent-history.ts`）已经实现并在
   `agent_persist_messages` 开启时落加密存储，但**没有任何路由暴露 `list()`**，
   前端刷新即失。补 3 个端点 + 记录里一个可选 `session_id` 字段即可，不需要新存储种类。
5. **最大风险不是技术，是外援那 1600 行前端改动**（已提交为 `be9155a`，
   本 worktree 落后它一个提交）。合并策略是把移植代码全部放进**新文件**、
   `Chat.tsx` 只留 import 与几行 JSX 接线，把冲突面压到「import 块」（§7.1）。
   已实测的好消息：外援**没有动** `ToolCallCard` / `firstLine` / `RedactedText`，
   工具卡那一件冲突面很小；真正要错开的是 §3.5（它与外援改过的 `agent` 帧
   `error` 字段是相邻行）。
6. **MIT 声明落在一个 NOTICE 文件 + 每个移植文件的一行出处注释**；DSH 的品牌素材
   （鲸鱼动画、品牌图标）不在代码授权范围内，明确不搬（§6.3）。

### 0.2 本文不改什么

- 不改 `docs/design/95-agent-chat.md` 的任何结论。本文是它的下游：95 §6.1 的 SSE 五类帧
  仍是权威，本文只提出**在既有帧上增加三个可选字段**（§3.5），不改帧类型、不改帧序。
- 不改 `00-overview.md` §6 的文档索引。85 / 90 / 95 三篇都未进该索引，本文保持一致，
  不单独开先例。
- 不动 `webui/`、不动 `admin/`、不动 `ir/`、不动 `adaptors/`。所有落点都是「实现线程
  待建」，本文给出文件名与行数量级，不给代码。

### 0.3 出处与引用约定

- DSH 侧行号取自本机的 DSH 实现 checkout（`~/Projs/dsh-latest`，仓库根带 MIT `LICENSE`；
  `@deepseek-ai/dsh-client-ui-chat` 版本 `0.2.2-rc.3`），读取时间 2026-11。
  行号会漂移，判据以「文件 + 组件名」为准。
- AgentGateway 侧行号取自 `9e46faa`（外援提交 `be9155a` 的父提交）。本文撰写时所在的
  worktree 停在该提交，因此下文提到的 `Chat.tsx` / `chat.css` 等形态是 `9e46faa` 版的；
  与 `be9155a` 的差异集中列在 §7.1。
- 跨文档引用一律写 `xx.md §N` 全称（`scripts/check-docs.mjs` 的 §N 目标存在性检查）。

## 1. 调研对象与判断标准

### 1.1 DSH 侧范围与版本事实

| 包 | 行数量级 | 在本文里的角色 |
| --- | --- | --- |
| `packages/client/ui-chat` | 约 16800（ts/tsx；含 CSS 约 19100） | 主调研对象：回合 / 消息 / 思考 / 过程 / 用量 |
| `packages/client/ui-tool` | 约 6300 | 工具调用树与富结果卡 |
| `packages/client/ui-workspace` | 约 8200 | 会话列表与行（**不在** `ui-session`，见 §5.1） |
| `packages/client/ui-theme` | 约 3000 | 设计令牌定义处 |
| `packages/client/ui-primitives` | 约 18400 | `DisclosureRow` / `TextShimmer` / `MarkdownText` / `FenceCodeBlock` 等原子件 |

DSH 的 `LICENSE` 是 MIT，版权行 `Copyright (c) 2026 DeepSeek`，**可以借鉴与改写**，
前提是最终产物保留声明与版权行（§6）。

### 1.2 判断标准：一件东西搬过来要改多少

四问，按顺序答：

1. **数据从哪来？** 是 plain props，还是私有 store / hook / slot 注入？
2. **依赖哪些 DSH 私有件？** `@deepseek-ai/dsh-client-ui-primitives` 的哪些原子件、
   `contract/slots.ts` 的哪些类型、cordis 的哪些 `ctx.*`？
3. **交互是否依赖 DSH 运行时？** 滚动锚点、视口驱动、`hidden="until-found"`、locale 注入？
4. **AgentGateway 有没有对应的数据？** 没有的话，是「可从现有帧推」还是「需要服务端先支持」？

一票否决项：**数据来自 DSH 私有 store 且无法用 props 表达的一律不搬**。纯呈现优先。

### 1.3 DSH 的架构事实（为什么不能整包搬）

`ChatView.tsx` 是一个**纯组件**，但它的 props 是 `ChatViewSlotProps`：`useSession` /
`useChat` / `useConversation` / `useSessions` / `renderSlot` / `usePresentation` /
`useProjection` / `useInteractionIds` / `dispatchInteraction`……全部由 cordis 插件运行时
注入。`packages/client/ui-chat/package.json` 的 `dsh.client.inject` 列了 **14 个包**
（session-controller、workspace-controller、ui-conversation、ui-renderer、ui-session、
ui-layout、ui-context-menu……）。

数据形状是 `ChatSnapshot`（`contract/snapshot.ts`）：`order` / `nodes`（带 `source(key)`
按 key 订阅）/ `locations` / `navigation` / `timeline` / `legacy`，由
`conversation-nodes/chat-snapshot-builder.ts` 从会话存储投影出来。节点种类十几种
（user / assistant / tool-call / turn-process / turn-tail / turn-error / context /
compaction / model-retry / turn-max-tokens / inherited-history / unknown）。

AgentGateway 这边是**一个 hash 路由页 + 一个 SSE 端点 + 一个内存 `turns` 数组**
（`webui/admin/src/pages/Chat.tsx`）。没有快照、没有按 key 订阅、没有节点种类注册表。
所以：**搬「行」，不搬「视图与快照」**。这与 95 §1.1「不引 LibreChat，不引任何前端框架」
的既有立场一致。

## 2. 移植清单

### 2.1 搬：七件（含改造量与优先级）

行数量级是「实现线程要新写的 TS/TSX + CSS + 测试」合计，不是 DSH 原文行数。

| # | 件 | DSH 出处 | 渲染什么 | 改造量 | 优先级 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | thinking 折叠行 | `chat/ReasoningRow.tsx` + `.module.css` | 折叠时一行摘要（流式取最新完成段落首行），展开后是次级排版的思考正文；无内容整行不渲染 | 约 230 行 | **P0** | §3.2 的 `reasoning` 字段 |
| 2 | 工具调用卡 | `ui-tool/tool/ToolCallTree.tsx`、`components/ToolRow.tsx`、`models/tool-call-model.ts` | 树形工具调用：五态、递归缩进、入参 / 结果分区、JSON 懒格式化 | 约 420 行 | **P0** | 无（现有 `tool` 帧够） |
| 3 | 回合过程条 | `chat/TurnProcessNodeView.tsx` + `.module.css` | 回合顶部「思考了 12.3 秒」，可折叠；停止 / 失败换文案 | 约 160 行 | P1 | §3.3 的 `duration_ms` |
| 4 | 回合用量面板 | `chat/TurnUsagePanel.tsx`、`token-format.ts`、`stat-dialog.ts` | 用量 pill + 点击展开的分桶详情弹窗 | 约 200 行 | P2 | §3.3 的 `usage` |
| 5 | 流光文字 | `ui-primitives/TextShimmer.tsx` + `.module.css` | 进行中文字的扫光；思考摘要右缘的渐隐遮罩 | 约 90 行 | P1 | 无 |
| 6 | 格式化 helper | `chat/token-format.ts`、`chat/message-chrome.ts` 的 `formatRunDuration` | `517 / 12.2K / 1.2M`；`45.2s / 2m42s`；缓存命中率永不被 rounding 成 100% | 约 130 行（含单测） | P1 | 无 |
| 7 | 视觉令牌借用 | 六个 `*.module.css` | 折叠行高度、摘要省略、代码块尺寸与动画时长 | 约 200 行 CSS | **P0** | 无（只借结构，见 §4.6） |

**合计约 1430 行**（其中 CSS 约 400）。P0 三件（1、2、7）约 850 行，是「界面立刻不
一样」的那一批。

### 2.2 放弃：九件（含理由）

| 件 | DSH 出处 | 放弃理由 |
| --- | --- | --- |
| ChatView 本体 | `chat/ChatView.tsx`（351 行） | props 是 14 个注入包组成的 `ChatViewSlotProps`；AgentGateway 没有快照与 slot 注册表。一票否决 |
| rAF 折叠动画引擎 | `chat/flow-motion.ts`（556 行） | 依赖 `InputFoldDriver`、滚动锚点控制、`queueMicrotask` / rAF 批处理与 `searchable-hidden.ts`；同源的 `use-chat-viewport.ts` 有 1130 行。搬它等于搬半个滚动框架 |
| Turn 导航栏 | `chat/TurnNavigator.tsx`（295 行） | 依赖 `@tanstack/react-virtual`（新依赖）与「未加载轮次分页进历史」的会话模型。AgentGateway 的会话是「若干轮」，不是「长会话分页」；为它引一个虚拟滚动依赖不划算 |
| 上下文注入行 | `chat/ContextBody.tsx`（592 行）、`ContextInjectionRow.tsx` | DSH 的「模型可见注入」节点（system reminder / skill 装载）。AgentGateway 没有对应帧，也没有对应概念 |
| 重试 / 回合错误 / 超token 行 | `chat/MessageItem.tsx` 的 `ModelRetryItem` / `TurnErrorItem` / `TurnMaxTokensItem` | 依赖 `ModelRetryNode` / `TurnErrorNode` 事件流与 `failureMessage` 的错误码表。AgentGateway 只有一个 `error` 字段，现有 `ag-chat-error` 一行足够 |
| 会话列表与行 | `ui-workspace/rows/Rows.tsx`（`SessionNodeItem`）、`WorkspaceBrowser.tsx` | 依赖 `SnapshotStore<SessionListState>`、`remote.session.list` RPC、workspace 分组、pin / archive 集合。**设计借鉴、代码不搬**（§5） |
| 富结果卡 | `ui-tool/toolviews/*`、`ui-primitives` 的 `DiffBlock` / `ReadBlock` / `SearchBlock` / `WebBlock` / `TerminalBlock` | 依赖 shiki 高亮与 DSH 的文件系统语义（路径、diff patch、退出码）。AgentGateway 的工具结果只有一段 text |
| 鲸鱼奔跑动画 | `chat/RunningWhaleTail.tsx` + APNG 资产 | 品牌素材，不在代码授权精神范围内（§6.3）；管理面也不需要 |
| 会话标题 LLM provider | `packages/session/session-title-first-prompt-llm` | 要多打一次模型。用首条用户消息截断即可（§5.2） |

### 2.3 改造量估计的口径与汇总

- **口径**：只算「实现线程新写的行」，不含 DSH 原文行数；含配套单测；不含服务端（单列在 §3.5）。
- **前端合计约 1430 行**（§2.1）。
- **服务端合计约 180 行**（§3.5 的三个字段 + 契约 + 测试）。
- **会话管理合计约 610 行**（§5.3 的端点 + 前端模块 + 测试）。
- **不搬的部分约 6800 行 DSH 原文**——这是「不搬」决定省下来的最大一块：
  `WorkspaceBrowser.tsx` + `Rows.tsx`（会话列表）2233 行、
  `use-chat-viewport.ts` + `flow-motion.ts`（折叠动画与视口）1686 行、
  `toolviews/*`（富结果卡）1332 行、`ContextBody.tsx` + `ContextInjectionRow.tsx` 686 行、
  `ChatView.tsx` 351 行、`TurnNavigator.tsx` 295 行，
  其余是 `MessageItem.tsx` 的重试 / 回合错误 / 超token 行与鲸鱼资产。

## 3. 数据映射

### 3.1 现有五类帧已经能给什么

95 §6.1 的五类帧（`text` / `tool` / `secret` / `agent` / `end`）与前端纯解析
（`webui/admin/src/api/chat-stream.ts`）的对应关系：

| DSH 呈现 | DSH 数据形状 | AgentGateway 来源 | 结论 |
| --- | --- | --- | --- |
| 助手正文 | `AssistantBlock { kind: 'text', text }` | `agent` 帧 `reply`；`text` 帧的过程文本 | **已有**（`chat-markdown.tsx` 渲染） |
| 工具调用 | `ToolCallBlock`（preparing / started / result 联合 + `subCalls`） | `AgentToolCallView[]`（`id` / `name` / `arguments` / `result` / `is_error`） | **部分**：没有 preparing / started 两态，没有 `subCalls` |
| 密钥披露 | `turnTail` slot 的贡献 | `secret` 帧 → `secrets[]` | **已有** |
| 需要凭据 | 工具结果 `status` | `needsCredentialOf(call)` | **已有** |
| 思考内容 | `AssistantBlock { kind: 'reasoning', text }` | **无** | **需要服务端**（§3.2） |
| 回合耗时 | `turn.start.time` / `turn.end.time` / `end.reason.kind` | **无** | **需要服务端**（§3.3） |
| token 用量 | `TurnTokenUsage`（五个分桶 + routes） | **无** | **需要服务端**（§3.3） |
| 复制 / 分支操作 | `messageId` + `forkAt` | 无 `messageId`，无分支 | 复制可做，分支不做 |

### 3.2 thinking 内容：服务端已有能力，缺的是取出

**结论：不需要新管道，不需要新帧类型，只差 `foldChat` 多读一个字段。**

事实链：

1. AG-IR 已建模 `ThinkingPart`（`ir/chat.ts` 的 `type: 'thinking'`，含 `signature` 与
   `summary` 标记）。
2. OpenAI Chat 编解码器把 `reasoning_content` 列为**已建模的消息级键**
   （`adaptors/openai-chat/codec.ts` 的 `MODELLED_MESSAGE_KEYS`），解码进 thinking part、
   回写时重新生成 `reasoning_content`。注释写明了理由：DeepSeek 要求带 tools 的多轮请求
   每轮完整回传它，否则 400。
3. 因此上游响应经过「解码 → canonical → 编码」往返后，`reasoning_content` **仍在**
   `admin/agent-chat.ts` 的 `CollectingSink.raw()` 里。
4. 但 `parseChatResponse` 只读 `choices[0].message.content`，`reasoning_content` 被丢掉。

要做的事（§3.5）：`parseChatResponse` 多取一个字段，`foldChat` 多返回一个字段，
`AgentChatResponse` 与 `agent` 帧各加一个可选 `reasoning`，前端 `chat-stream.ts` 多解析一个。

**降级**：上游不返回 `reasoning_content` 时（非推理模型、或 provider 不给），
thinking 行整行不渲染——与 DSH 的 `hidden` 分支同一语义（`ReasoningRow.tsx` 在
`reasoningText(raw)` 归一后为空白时 `return null`）。

### 3.3 耗时与用量：需要服务端新增三个字段

| 字段 | 类型 | 服务端取值处 | 为什么必须服务端给 |
| --- | --- | --- | --- |
| `reasoning` | `string` | `parseChatResponse` 读 `message.reasoning_content` | 上游非流式，模型侧只有一份完整思考 |
| `duration_ms` | `number` | `handleAgentChat` 用注入的 `Clock` 量 `runTurn` 前后 | 前端 `performance.now()` 量得到的是「含网络与排队」的本端耗时，语义不同且刷新会错 |
| `usage` | `{ input, output, total, reasoning? }` | `parseChatResponse` 读响应的 `usage` 段 | 计量管道是异步旁路（60 §6.1），不阻塞主链路，因此不能等它；直接从响应取最诚实 |

三个字段全部**可选**，缺省时对应 UI 件不渲染（与 DSH 的 `undefined` 分支一致）。
`AgentChatDeps` 需要加一个可选 `clock?: Clock`——`composition-root.ts` 早已构造 `clock`
实例（`EncryptedAgentHistoryStore` 的邻居），只是没传进聊天端点。

### 3.4 非流式的降级（95 §6.1 的既有绕开怎么落到 UI）

95 §6.1 已定：上游固定非流式，SSE 是「收齐后一次性写出」的分帧呈现，**不假装 token 级流式**。
落到 UI：

| DSH 效果 | 依赖什么 | AgentGateway 降级 |
| --- | --- | --- |
| 思考摘要随生成逐段前移（`latestCompletedParagraphFirstLine`） | token 级 reasoning 流 | **降级**：`reasoning` 整段到达；折叠行的摘要取首段首行（DSH 的 `running === false` 分支同款），不做逐段前移 |
| 助手正文逐字出现 | token 级 content 流 | **已有降级**：`splitForStream` 按句切，前端 `text` 帧逐块淡入（`ag-stream-in`） |
| 流光扫过进行中的文字 | 流式 tail 标记 | **保留**：`streaming.streaming !== ''` 即 tail，与有无 token 流无关 |
| 过程节点实时展开「正在调 X」 | `RunningToolCall` 事件 | **降级**：工具调用在 `tool` 帧一次性给到，四态里没有「进行中」的真实语义；保留「无 result 即进行中」的兼容分支但不依赖它 |

**结论：DSH 里依赖 token 流的效果全部降级为「整段到达 + 扫光 + 按句淡入」**，
不新增服务端流式能力。这与 95 §6.1「修它要动循环编排，超出本功能范围」的既有判断一致。

### 3.5 需要新增的服务端字段（最小集与契约）

只加**可选字段**，不改帧类型、不改帧序、不改既有必填字段。旧前端忽略新字段，
新前端容忍旧服务端（全部 `undefined`）。

```typescript
// admin/api-types.ts（新增）
export interface AgentChatUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

// AgentChatResponse 与 agent 帧各加三个可选字段
reasoning?: string;
duration_ms?: number;
usage?: AgentChatUsage;
```

`POST /admin/api/chat` 的请求体另加一个可选 `session_id?: string`（§5.3）。
改动落点：`admin/agent-chat.ts`（`parseChatResponse` / `foldChat` / `writeAgentSse` /
`AgentChatDeps.clock`）、`admin/api-types.ts`、`webui/admin/src/api/chat-stream.ts`
（`ChatFrame` 的 `agent` 分支与 `ChatStreamState` 各加三字段）。**合计约 180 行含测试。**

## 4. 逐件设计

### 4.1 thinking 折叠行

**DSH 原样**（`chat/ReasoningRow.tsx`，112 行）：`DisclosureRow` 包一个
`data-variant="think"` 的行；折叠态高 24px（`contain: size layout`），标题「思考」+
分隔点 + 单行摘要（`white-space: nowrap` + `text-overflow: ellipsis`）；流式时摘要切成
右缘渐隐遮罩（`mask-image: linear-gradient(to right, black calc(100% - 48px), transparent)`）
并套 `TextShimmer`；展开态正文左缩进 22px、次级字号，展开头 `position: sticky`。

**移植设计**：新文件 `webui/admin/src/pages/chat-thinking.tsx`（约 140 行）+
`webui/admin/src/styles/chat-port.css` 的 `.ag-think-*`（约 90 行）。

- 骨架用 Semi 的 `Button`（`theme="borderless"`）或裸 `button`，**不引 DSH 的
  `DisclosureRow`**——它绑了 DSH 的 locale 与 slot 类型。
- 扫光用自绘 `TextShimmer`（§4.5），不引 `@deepseek-ai/dsh-client-ui-primitives`。
- 展开态正文直接复用现有 `chat-markdown.tsx` 的 `Markdown`——思考内容也是 Markdown，
  且不碰 `dangerouslySetInnerHTML` 的安全底线不变。
- 摘要规则照抄 DSH 的两个纯函数（`firstLine` / `latestCompletedParagraphFirstLine`），
  并按 §3.4 降级：非流式只用 `firstLine`。
- 状态属性照抄 DSH 的 `data-*` 约定（`data-variant` / `data-state` / `data-expanded` /
  `data-preview`），验收测试直接断言它们。

**两种形态（验收要点）**：有 `reasoning` → 渲染「思考」+ 摘要，可展开；
无 `reasoning`（含上游不给、字段缺失、空白串）→ 整行不渲染。

### 4.2 工具调用卡片

**DSH 原样**（`ui-tool`）：根 `ToolCallTree` 读 `node.data.root`（`ToolCallBlock`），
递归 `ToolCallBranch` → `ToolCall`；子调用只在 `phase !== 'preparing' && subCalls.length > 0`
时渲染，缩进是静态 22px + 0.5px 左边线；`ToolRowState` 五态
（`preparing` / `running` / `ok` / `error` / `stopped`）通过根元素 `data-state` /
`data-variant` / `data-tool` 表达；入参保持原始 JSON 串、**仅在展开时**才
`JSON.stringify(parsed, null, 2)`；结果拍平成 IN / OUT 卡，每段 150px 内部滚动、
gutter 标签 sticky。

**移植设计**：新文件 `webui/admin/src/pages/chat-tool-card.tsx`（约 300 行）+
CSS（约 120 行）。现有 `Chat.tsx` 里的内联 `ToolCallCard`（约 50 行）删掉，改为 import。

- **模型层直接搬**：`models/tool-call-model.ts`（431 行）里的状态派生
  （`ToolRowState` 五态）、摘要与入参懒格式化是纯函数（对不可变 block 对象求值），
  `raw-tool-call.ts` / `detail-model-shared.ts` 同类。**我们需要的子集约 150–200 行**，
  可以近乎照抄，只把 `ToolCallBlock` 联合换成 `AgentToolCallView`。
- **行组件重写**：`ToolRow.tsx` 依赖 `useDisclosure` / `useContextMenu` / `renderSlot` /
  `inspect`，全部换成 Semi 与本地 state。约 180 行。
- **slot 分派换成普通 map**：DSH 用 `renderSlot('tool.call.toolview', …)` 按工具名
  键分派；AgentGateway 只有 8 个内置工具且结果是一段 text，用一个
  `toolName → 呈现组件` 的普通 map + 一个通用兜底即可。
- **富卡不做**：diff / read / search / web / terminal 五类富卡全部放弃（§2.2），
  通用兜底就是「入参 / 结果 JSON 美化 + 首行摘要」。
- **递归保留但空转**：AgentGateway 的 `tool_calls` 是平铺的（没有 `subCalls`），
  递归结构保留是为将来；今天渲染结果与平铺一致。

**四态（验收要点，与任务书一致）**：

| 态 | 判据 | DOM 标记 | 文案 |
| --- | --- | --- | --- |
| 进行中 | `result === undefined` | `data-state="running"` | 进行中 |
| 完成 | 有 `result` 且 `!is_error` | `data-state="ok"` | 完成 |
| 失败 | `is_error === true` | `data-state="error"` | 失败 |
| 等待密钥 | `result.status === 'needs_credential'` 且 `!is_error` | `data-state="waiting"` | 等待密钥 |

DSH 的第五态 `stopped` 在 AgentGateway 没有对应事实（没有中断帧），不设。
**判据顺序不能反**：`is_error` 必须排在 `waiting` 之前——现状 `Chat.tsx` 的
`const state = call.is_error ? '失败' : waiting ? '等待密钥' : call.result === undefined ? '进行中' : '完成'`
已经是对的，移植时保持这个顺序，否则一个出错的 `needs_credential` 会被渲染成「等待密钥」。

### 4.3 回合过程条

**DSH 原样**（`chat/TurnProcessNodeView.tsx`，62 行）：回合内容之上的一个按钮，
`data-open` / `data-turn-process-*`（消息数 / 工具数 / 子代理数）；文案四分支
（停止 / 失败 / 「工作了」/ 「耗时 X」），时长用 `formatRunDuration` 的
`{text, numeric}` 分段渲染（数字部分套 `css.durationNumber`）；`turn.status !== 'closed'`
不渲染；可折叠性由 `foldable && hasContent && !turnProcessAlwaysOpen(node)` 决定。

**移植设计**：新文件 `webui/admin/src/pages/chat-turn-process.tsx`（约 100 行）+
CSS（约 60 行）。

- 数据从 §3.5 的 `duration_ms` 来；`turn.end?.data.reason.kind` 在 AgentGateway 映射为
  `agent` 帧的 `error` 有无。
- `messageCount` / `toolCallCount` 可以从现有帧推：前者是该回合的 user + assistant 条数，
  后者是 `tool_calls.length`。`subagentCount` 没有对应物，不显示。
- 折叠的是「工具调用区」，因此与 §4.2 共享一个开合状态（由 `Chat.tsx` 持有一个
  `processOpen` 状态传下去）。
- `aria-live="polite"` 的 visually-hidden 播报照抄（`accessibility.module.css` 只有 8 行，
  直接内联到新 CSS）。

### 4.4 回合用量面板

**DSH 原样**（`chat/TurnUsagePanel.tsx`，110 行）：一个 pill 按钮
（`aria-haspopup="dialog"`）+ `createPortal` 到 `document.body` 的详情弹窗，
用 CSS anchor positioning（`anchorName` / `positionAnchor`）锚在触发点上；
分桶行按「有才渲染」输出（input / cacheRead / cacheWrite / output / reasoning / 缓存命中 / 路由）。

**移植设计**：新文件 `webui/admin/src/pages/chat-usage.tsx`（约 130 行）+
CSS（约 70 行）。**优先级 P2**——它依赖 §3.5 的 `usage`，且管理面已有独立的「用量」页
（`webui/admin/src/pages/Usage.tsx`），这一件的边际价值低于前四件。

- **不用 CSS anchor positioning**：Semi 有 `Tooltip` / `Popover`，且 anchor positioning
  的浏览器支持面窄。改用 Semi `Popover` 或现有 `Modal`，视觉保持「小面板 + dl 分桶行」。
- 分桶行与 DSH 一致地「有才渲染」；`routes`（provider/model）AgentGateway 有
  （`agent` 帧的 `model`），可以显示一行。
- 格式化全部走 §4.5 的 `formatTokens` / `formatExactTokens` / `formatCacheHitPercent`。
  **`formatCacheHitPercent` 的「永不把部分命中 rounding 成 100%」必须照抄**——那是
  DSH 踩过的坑（输出 `99.9…` 而不是 `100%`）。

### 4.5 流光与格式化 helper

**流光**（新文件 `webui/admin/src/components/chat-shimmer.tsx`，约 50 行 + 40 行 CSS）：
DSH 的 `TextShimmer` 把同一串文字渲染成一个 `inert` 覆盖层，用
`linear-gradient(105deg, transparent 0%, black 40% 60%, transparent 100%)` +
`steps(48, end)`、1.5s / 0.3s delay 无限扫。AgentGateway 只需要「只读、不交互、
纯 CSS」这一半，因此约 90 行能拿下，且不引 DSH 运行时。

**格式化**（新文件 `webui/admin/src/api/chat-format.ts`，约 70 行 + 60 行单测）：

| 函数 | 规则（照抄 DSH） |
| --- | --- |
| `formatTokens` | `<1000` 原样；`<1e6` → `{v}K`；否则 `{v}M`；100 以下保留一位小数，100 及以上取整 |
| `formatExactTokens` | 三位分组（用 `Intl.NumberFormat` 的 `group`） |
| `formatRunDuration` | 分段 `{text, numeric}`；秒总是给，≥60s 才给分，有小时才给小时；不补前导零；负数夹到 0；调用方夹到 1000ms 下限 |
| `formatCacheHitPercent` | 部分命中永不显示 100% |

放 `api/` 而不是 `pages/`：与 `chat-stream.ts` / `redaction.ts` 同一层，纯函数、无 React，
可以在 node 里直接单测（与 `chat-composer.ts` 的既有做法一致）。

### 4.6 视觉令牌：借用结构，不借用令牌名

**明确规则：不把 DSH 的 `--dsw-*` / `--dsh-*` 令牌名搬进 AgentGateway。**

理由：`webui/admin/src/styles/theme.css` 已有一套 `--ag-*` 令牌（画布 / 表面 / 边框 /
四级文字 / 强调 / 成功 / 警告 / 危险 / 信息 / 阴影 / 圆角 / 时长 / 缓动），且外援刚重写过。
两套令牌并存会互相覆盖，是典型的「抄了皮肤丢了底色」。

要借的是**结构与数值关系**，落到 `--ag-*` 上：

| DSH | 数值 | AgentGateway 落点 |
| --- | --- | --- |
| 折叠思考行高度 | `calc(24px + var(--dsh-content-font-delta, 0px))` | `calc(24px + var(--ag-font-delta, 0px))`，delta 缺省 0 |
| 次级字号 | `min(size−1, max(13, size−2))` | `--ag-text-2` 的字号档（不引入全局字号轴，管理面不需要） |
| 展开正文缩进 | `calc(22px + delta)` | `22px` |
| 子调用缩进 | `margin-left: 22px; border-left: 0.5px` | `22px` + `var(--ag-border)` |
| 过渡时长 | 100–160ms | `var(--ag-duration-fast)` / `var(--ag-duration-base)`（已存在） |
| 关键帧 | `running-enters-slot 140ms cubic-bezier(0.2,0.8,0.2,1)` | 复用现有 `--ag-ease-enter`，140ms |
| 圆角 | `xs 4 / sm 8 / md 12 / lg 16` | `--ag-radius-control`（8）/ `--ag-radius-card`（14） |
| 状态色 | `--dsw-alias-state-error-primary` 等 | `--ag-danger` / `--ag-warning` / `--ag-success`（已存在） |

**动画纪律**：只用 CSS transition 与 keyframes，**不引 rAF 折叠引擎**（§2.2）。
所有动画过 `prefers-reduced-motion: reduce` 关闭（DSH 在
`TurnProcessNodeView.module.css` 与 `flow-motion.ts` 两处都这么做，照抄这个纪律）。

### 4.7 界面文案（过 check-ui-copy 的清单）

`scripts/check-ui-copy.mjs` 的规则：单串 > 12 个 CJK 字、解释性模式
（因为 / 因此 / 默认 / 不会 / 不能 / 建议 / 用于 / 注意 / 详见……）、内部术语
（canonical / AG-IR / S0 / pipeline / 透传 / dialect / codec / KEK / DEK / env_ref /
access_path / stale / PanelState / round-trip / `AG_[A-Z_]+`）三类命中即疑似。
下面是本文提议的全部新文案，已按该规则自查：

| 位置 | 文案 | CJK 字数 | 备注 |
| --- | --- | --- | --- |
| 思考行标题 | 思考 | 2 | 与 DSH `message.think` 同义 |
| 思考进行中 | 思考中 | 3 | 仅 aria / 状态，不作正文 |
| 过程条·耗时 | 思考了 {n} 秒 | 4 | 数字不进 CJK 计数 |
| 过程条·失败 | 这一轮出错了 | 6 | 错误反馈，允许 |
| 过程条·停止 | 已停止 | 3 | — |
| 工具卡·四态 | 进行中 / 完成 / 失败 / 等待密钥 | 3 / 2 / 2 / 4 | 现有四态文案不变 |
| 工具卡·分区 | 入参 / 结果 | 2 / 2 | 现有 |
| 用量 pill | 用量 {n} | 2 | — |
| 会话空态 | 没有历史会话 | 6 | 空状态一句话 |
| 留存未开 | 未开启会话留存 | 7 | 空状态 + 主操作「去设置」 |
| 删除确认 | 删除这个会话？ | 7 | 确认弹窗 |

**不许出现的词**：任何含「自动 / 默认 / 不会 / 不能 / 因为 / 建议 / 用于 / 注意 / 详见」
的长句，以及全部内部术语。解释性内容一律进 `webui/admin/src/pages/Help.tsx` 的
`agent` 小节并用 `helpHref('agent')` 深链（AGENTS.md 的界面文案纪律）。

## 5. 会话管理方案

### 5.1 现状：写侧已实现，读侧是缺口

已实现（**不要重写**）：

- `admin/agent-history.ts`：`AgentTurnRecord`（`id` / `ts` / `actor` / `model` /
  `user` / `reply` / `tool_calls` / `created_key_ids`）+ `AgentHistoryStore`
  （`append` / `list`）两个实现（加密 / 内存）。
- `admin/agent-chat.ts`：`agent_persist_messages` 开启时 `appendAgentTurn`，
  内容**已过脱敏**（用户消息在进 canonical 前就替换掉了）。
- 加密存储复用既有的 `EncryptedRecordStore`，记录种类 `agent_chat`，
  AAD 仍是 `record_kind + record_id`（65 §3.1）。

缺口（**只有一个**）：

- **没有任何路由暴露 `list()`**。`grep` 全仓，`AgentHistoryStore` 只被
  `composition-root.ts` 构造、被 `admin/agent-chat.ts` 写入，**没有读方**。
  前端 `Chat.tsx` 的 `turns` 全在 `useState`，刷新即失。
- 记录粒度是**一轮**，没有 `session_id`、没有标题、没有删除能力。

DSH 侧对照（§1.1 的调研结论）：会话列表 UI 在 `ui-workspace/rows/Rows.tsx`，
数据来自私有 `SnapshotStore<SessionListState>` + `remote.session.list` RPC
（全量刷新、无分页），行字段是状态点 / 跑马灯标题 / 相对时间 / 尾部图标 / pin / 菜单，
标题由 `'title'` 投影给出（首条人类消息兜底 / LLM / 显式改名，后者优先）。
**DSH 没有「删除会话」这个操作**（只有 archive）——这一点不要照抄，管理面要能删。

### 5.2 会话模型与前端状态

```text
AgentSession（前端持有，不进存储）
  id: string            // 前端生成的稳定 id，随请求带上
  title: string         // 首条 user 消息截断（前 20 字），不调模型
  updated_at: number
  turn_count: number
  last_reply: string    // 列表第二行预览（截断）
```

- **标题**：取该会话第一条 `user` 消息前 20 字。不引 DSH 的 LLM 标题 provider（§2.2）。
- **归属**：`session_id` 由**前端**生成并在「新对话」按钮点击时轮换；请求体带上它，
  服务端据此把这一轮写进对应会话。`agent_persist_messages` 关闭时该字段被忽略
  （不落盘，与服务端既有行为一致）。
- **本地当前会话**：刷新后默认落在「最近一次会话」，由 `GET /admin/api/chat/sessions`
  的第一条决定。不做 `localStorage` 持久化——`tests/agent-ui-contract.test.ts` 守着
  「流式调用不碰 localStorage」，且会话令牌只在内存里是既有硬要求。

### 5.3 前后端契约（新增 API）

三个新端点，全部挂在管理面既有路由表（`admin/routes.ts` 的 `API_PREFIX` 之下），
走同一套管理员会话鉴权，不加新的免鉴权豁免。

| 方法 | 路径 | 出参 | 说明 |
| --- | --- | --- | --- |
| GET | `/admin/api/chat/sessions?limit=&before_ts=` | `{ items: AgentSessionSummary[] }` | 按 `updated_at` 倒序；`before_ts` 做游标分页（DSH 是全量刷新，这里用游标，因为记录可能很多） |
| GET | `/admin/api/chat/sessions/{id}` | `{ session: AgentSessionSummary, turns: AgentTurnRecord[] }` | 翻历史：该会话全部轮次，按 `ts` 升序 |
| DELETE | `/admin/api/chat/sessions/{id}` | `{ ok: true, deleted: number }` | 删该会话全部轮次记录 |

请求体变更（唯一一处）：`AgentChatRequest` 加可选 `session_id?: string`。

存储侧变更（`admin/agent-history.ts`，约 60 行）：

- `AgentTurnRecord` 加可选 `session_id?: string`。**AAD 不变**（AAD 是
  `record_kind + record_id`，与值形状无关），因此不影响任何已存在记录的解密。
- `AgentHistoryStore` 加 `listSessions(limit, beforeTs)` 与 `deleteSession(id)`。
  两者都基于既有的 `listDecrypted(AGENT_CHAT_KIND)` 在内存里分组 / 过滤——
  **没有二级索引，成本 O(n)**。`agent_persist_messages` 默认关闭（95 §7.2 与
  65 §4.2 同立场），n 在默认配置下是 0；开启后按「保留策略」另行收敛。
  这一点要在实现时写进注释，别让后人以为是疏忽。
- `deleteSession` 走既有的 `EncryptedRecordStore.delete(kind, id)`（接口已存在），
  不新造删除路径。
- **旧记录兼容**：没有 `session_id` 的历史轮次归入一个合成会话
  （`id = 'legacy'`，标题取最早一轮的首条消息），只在列表尾部出现一次，
  不参与删除（或删除时按「逐轮删」处理）。这条必须写进实现，否则升级后老历史
  看起来「丢了」。

### 5.4 续聊、删除与留存关闭时的形态

- **续聊**：`Chat.tsx` 的 `history()` 现在把 `turns` 的 `content` 发给上游
  （`normalizeMessages` 只认 user / assistant 且 content 必须是 string）。
  接上历史后，从服务端取回的轮次同样只把 `user` / `reply` 填进 `history()`——
  **`tool_calls` 摘要不进请求**（95 §7.2：工具结果由 agentic loop 自己消费）。
  这条契约不变，也不该变。
- **删除**：列表行「…」菜单 → 删除 → 确认弹窗（文案见 §4.7）→ `DELETE` →
  前端把该会话从列表与当前 `turns` 里摘掉。删除是**破坏性**的，因此要确认弹窗；
  这与 KEK / DEK 轮换那条「破坏性操作要确认」的既有纪律同源。
- **留存关闭时**：列表空态显示「未开启会话留存」+ 主操作「去设置」
  （深链到设置页的 Agent 分区）。**不假装有历史**——与 `rotateKek` 不注入就 501
  的既有姿态一致。
- **切会话**：点行 → `GET /sessions/{id}` → 灌进 `turns` → 滚动到底。
  切换时若正在发送中要禁止（`busy` 时行禁用），否则两次 SSE 会交叉写同一份 state。

### 5.5 与 95 §7.2 无状态契约的关系

95 §7.2 定：「会话历史在请求里由客户端带上（无状态，与 OpenAI Chat 一致）；
持久化只用于刷新后还能翻历史，不参与请求构造。」

本设计**不改变**这条：服务端仍然不从存储里取历史来构造请求，历史仍然由客户端带。
`session_id` 只是**写入时的归属标签**，不是读取时的请求构造输入。
这一点要在实现注释里写清楚，否则后人会顺手让服务端「自动补历史」，
那就把无状态契约改掉了。

## 6. MIT 声明怎么落

### 6.1 声明位置与形式

三处，缺一不可：

1. **一个 NOTICE 文件**：`webui/admin/THIRD-PARTY-NOTICES.md`（实现线程创建）。
   内容是完整的 MIT 许可文本 + 版权行 `Copyright (c) 2026 DeepSeek` +
   一张「移植件 → DSH 源文件」的出处表。命名对齐 DSH 自己仓库根目录的
   `THIRD_PARTY_NOTICES.md`，可 grep、可审计。
2. **每个移植文件的一行出处注释**：放在文件头 JSDoc 的第一行，例如
   `// 呈现改写自 DeepSeek Harness（MIT，Copyright (c) 2026 DeepSeek）`
   `// packages/client/ui-chat/src/client/chat/ReasoningRow.tsx`。
   CSS 文件用 `/* 同上 */`。
3. **README / 帮助页不重复粘贴许可全文**——那是 NOTICE 文件的家。

### 6.2 每个移植文件的出处标注

实现线程按 §2.1 的七件逐条建表，至少覆盖：

| 新文件 | DSH 源 |
| --- | --- |
| `webui/admin/src/pages/chat-thinking.tsx` | `packages/client/ui-chat/src/client/chat/ReasoningRow.tsx` |
| `webui/admin/src/pages/chat-tool-card.tsx` | `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`、`components/ToolRow.tsx` |
| `webui/admin/src/pages/chat-turn-process.tsx` | `packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx` |
| `webui/admin/src/pages/chat-usage.tsx` | `packages/client/ui-chat/src/client/chat/TurnUsagePanel.tsx` |
| `webui/admin/src/components/chat-shimmer.tsx` | `packages/client/ui-primitives/src/TextShimmer.tsx`（58 行）+ `TextShimmer.module.css`（88 行） |
| `webui/admin/src/api/chat-format.ts` | `packages/client/ui-chat/src/client/chat/token-format.ts`、`message-chrome.ts` |
| `webui/admin/src/styles/chat-port.css` | 上述各组件的 `*.module.css` |

### 6.3 不属于 MIT 授权范围的东西

MIT 覆盖**代码与 CSS**，不覆盖品牌资产与视觉识别。以下明确不搬，也不进 NOTICE：

- `RunningWhaleTail.tsx` 的 APNG 奔跑鲸鱼与品牌图标；
- DSH 的品牌色阶（`--dsw-*` 里的 deepseek 50–900 静态色板）——只借数值关系，
  落进 AgentGateway 自己的 `--ag-*`（§4.6）；
- 任何 DSH 的文案字符串（locale 文件）——文案按 §4.7 重新写，过 `check-ui-copy`。

## 7. 落地顺序与风险

### 7.1 与外援改动的冲突（合并策略）

**事实**（实测）：外援的改动已经**提交**为 `be9155a`
（`feat(admin-ui): 对话 UI 优化收尾 + 一键进入与错误呈现修复`），共 18 个文件、
+1602 / −237 行。本文撰写时所在的 worktree 停在它的父提交 `9e46faa`，
**因此下文所有 AgentGateway 侧行号以 `9e46faa` 为准**；实现线程必须从含
`be9155a` 的提交起，否则会把这 1602 行整个丢掉。

与移植区直接相撞的部分：

| 文件 | 规模 | 撞在哪里 |
| --- | --- | --- |
| `webui/admin/src/pages/Chat.tsx` | +233 / −66 | import 块、头部按钮区、输入栏区、`TurnView` 的空渲染分支（补了 `error` 一项） |
| `webui/admin/src/styles/chat.css` | +421 / −24 | 全部新类名的主战场 |
| `webui/admin/src/styles/theme.css` | +110 / −57 | 令牌基调 |
| `webui/admin/src/pages/AgentRunPanel.tsx` | +196 / −40 | 右侧面板（移植不碰） |
| `webui/admin/src/api/chat-stream.ts` | +10 / −3 | **`agent` 帧的 `error` 从 `string` 放宽成 `AgentChatError`** |
| `webui/admin/src/api/types.ts` | +23 / −1 | 新增 `AgentChatError` / `agentErrorMessage` |

**没有撞上的部分（好消息）**：外援**没有动** `ToolCallCard` / `firstLine` /
`RedactedText` 三个函数（`be9155a` 里 `ToolCallCard` 仍在原位置、类名未变），
因此 §4.2 的工具卡移植冲突面很小。真正需要错开的是 §3.5——
它要给 `agent` 帧加三个可选字段，而外援刚改过同一个联合分支的 `error` 字段。

**合并策略（按优先级）**：

1. **实现线程从含 `be9155a` 的提交开分支**（首选，且现在是前提而非选项）。
2. **移植代码全部放进新文件**：§2.1 的七个新文件 + 一个新 CSS `chat-port.css`。
   `Chat.tsx` 只做两类小改——import 新组件、把内联 `ToolCallCard` 换成
   `chat-tool-card` 的调用。这样即使外援后续再改 `Chat.tsx`，冲突也只剩
   「import 块 + 一处 JSX」。
3. **CSS 一律进新文件，不改 `chat.css`**。外援在 `chat.css` 加了 421 行，
   那是他们的战场；移植件的样式进 `chat-port.css`，由 `Chat.tsx` 多 import 一个
   （`import '../styles/chat-port.css'`，与既有 `import '../styles/chat.css'` 并列）。
4. **§3.5 与外援的 `chat-stream.ts` 改动是同一处的相邻行**：实现时先读
   `be9155a` 版的 `ChatFrame` 联合，把 `reasoning` / `duration_ms` / `usage`
   加在 `error` 旁边，**不要**把外援的 `AgentChatError` 放宽改回 `string`。
   前端渲染错误时用外援新增的 `agentErrorMessage`（§8.1 第 6 条据此断言）。
5. **服务端三字段（§3.5 的 `admin/` 部分）与外援改动零重叠**，可独立先落。
6. **纯函数与单测零冲突，可最先合**：`chat-format.ts` + `chat-format.test.ts`
   不依赖任何外援改动过的文件。
7. **冲突裁定顺序**：视觉基调以外援的 `theme.css` / `chat.css` 为准；移植件只借
   DSH 的**信息结构与密度**，不复刻 DSH 的字号 / 色彩 / 圆角（§4.6 的令牌规则）。
   若某件移植与外援的同类件重复，以外援版为基底、把 DSH 的结构优点并进去，
   不要两份并存。

### 7.2 分期落地顺序

| 期 | 内容 | 行数 | 前置 |
| --- | --- | --- | --- |
| 一 | 服务端三字段（§3.5）+ 前后端单测 | 约 180 | 无（独立 PR） |
| 二 | `chat-format.ts` + `chat-shimmer.tsx` + `chat-port.css` 令牌段 | 约 420 | 无 |
| 三 | thinking 折叠行（P0） | 约 230 | 一期（`reasoning`） |
| 四 | 工具调用卡四态（P0） | 约 420 | 无 |
| 五 | 回合过程条 | 约 160 | 一期（`duration_ms`） |
| 六 | 会话管理（3 端点 + 前端模块） | 约 610 | 无 |
| 七 | 回合用量面板（P2） | 约 200 | 一期（`usage`） |

一、二可并行；三、四是对界面影响最大的两件，应紧接着做；六（会话管理）与前五件
无依赖，可插到任意位置——**是否现在就连会话管理一起做，是要拍板的选项**（§9）。

### 7.3 风险清单

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 外援后续再改 `Chat.tsx` / `chat.css` | 冲突回到「整个文件」 | §7.1 策略 2、3：新文件 + 只改 import 与一处 JSX |
| 外援改动未提交，移植对着旧 HEAD 写 | 1600 行整个丢或大面积冲突 | §7.1 策略 1：从含 `be9155a` 的提交起 |
| 上游不返回 `reasoning_content` | thinking 行不渲染，界面「没变化」 | 降级路径即「整行不渲染」；在帮助页说明只有推理模型有思考内容 |
| 误把品牌资产当代码搬 | 许可范围外的使用 | §6.3 的负面清单；NOTICE 只列代码与 CSS |
| 两套设计令牌并存 | 样式互相覆盖 | §4.6 的「只借结构不借令牌名」硬规则 |
| 会话记录无二级索引，`listSessions` 是 O(n) | 留存开启且记录很多时列表慢 | 默认关闭留存；实现注释写清成本；必要时按游标提前终止 |
| 旧记录没有 `session_id` | 升级后老历史「看起来丢了」 | §5.3 的合成 `legacy` 会话 |
| 删除会话是破坏性操作 | 误删 | 确认弹窗；与 KEK 轮换的确认纪律同源 |
| `duration_ms` 用前端 `performance.now()` 冒充 | 数字含网络与排队，语义漂移 | §3.5 明确服务端口径；实现时不提供前端计时分支 |
| 会话切换时正在发送 | 两次 SSE 交叉写同一 state | §5.4：`busy` 时行禁用 |

## 8. 验收标准

### 8.1 可断言的形态

以下每条都应是**能在无头浏览器或单测里断言**的，不是「看起来对了」。

1. **thinking 折叠行两种形态**：
   - 有 reasoning 内容 → 存在 `[data-variant="think"]`，含标题「思考」与一行摘要；
     点击后 `data-expanded` 置位且正文可见（Markdown 渲染，非纯文本）。
   - 无 reasoning 内容（字段缺失 / 空串 / 上游不给）→ 该行**不存在于 DOM**。
2. **工具调用卡片四态**：同一会话里分别造出四种 `AgentToolCallView`
   （无 `result` / 有 `result` 且 `!is_error` / `is_error` /
   `result.status === 'needs_credential'`），断言各自的 `data-state` 取值
   与文案（进行中 / 完成 / 失败 / 等待密钥），并断言 `waiting` 行出现「录入密钥」按钮。
3. **过程条**：`duration_ms` 存在 → 显示「思考了 {n} 秒」且数字部分可单独选中
   （DSH 的 `{text, numeric}` 分段）；`error` 存在 → 文案切到「这一轮出错了」。
4. **会话切换后历史正确**：切到会话 A → 断言发出的请求体 `messages` 等于 A 的
   user/assistant 序列（顺序、条数、内容逐条相等），且**不含任何 `tool_calls`**；
   删除 A → 列表不含 A，刷新后仍不含。
5. **脱敏不回退**：thinking 正文与工具结果里的占位符渲染成 `.ag-redacted` 样式
   （与现有用户消息同一路径），不因新组件换渲染器而失效。
6. **契约不回退**：`tests/agent-ui-contract.test.ts` 现有四条全部仍绿
   （路由 / 帮助小节 / 密钥走 `/credentials` / 预览用 `/redaction-rules`）；
   新增字段有前后端各一组单测（服务端「有 reasoning 时取出、无时不编」；
   前端「三种载荷形状都取到人能读的那一句」）。

### 8.2 测试落点

| 测什么 | 落点 | 形态 |
| --- | --- | --- |
| 格式化四函数 | `webui/admin/src/api/chat-format.test.ts`（新） | node 纯函数，无 jsdom |
| SSE 新字段解析 | `webui/admin/src/api/chat-stream.test.ts`（既存，加组） | 纯函数 |
| thinking / 工具卡 DOM 形态 | `tests/agent-ui-contract.test.ts`（加组）或新的无头用例 | 源码文本断言优先；确有必要再上 jsdom |
| 服务端三字段 | `tests/agent-chat-e2e.test.ts`（加组） | 脚本化上游 + 真实 HTTP |
| 会话三端点 | `tests/agent-chat-e2e.test.ts` 或新的 `tests/agent-sessions.test.ts` | 真实 HTTP |
| 删除 | 同上 | 真实 HTTP + 存储断言 |
| 文档自校验 | `scripts/check-docs.mjs`（`npm test` 已包） | §N 引用 / 围栏 / 节号 / 术语 |
| 界面文案 | `npm run check:ui-copy` | §4.7 的清单零未豁免疑似 |

## 9. 需要用户拍板的选项

1. **范围大小**（互斥，选一个；行数含配套单测）：
   - **A · 只搬呈现三件**：thinking 行 + 工具卡 + 视觉令牌（§2.1 的 P0），约 850 行。
     不碰服务端——**因此 thinking 行只能出骨架**（拿不到 `reasoning`，整行不渲染）。
     单独选 A 的性价比最低。
   - **B · A + 服务端三字段 + 依赖它们的 P1 三件**：§3.5 的 `reasoning` /
     `duration_ms` / `usage`（180 行）+ 过程条 / 流光 / 格式化（380 行）。
     **合计约 1410 行**，thinking 行与过程条真正有数据。（推荐）
   - **C · B + 会话管理**：再加 §5 的 3 个端点与前端列表 / 切换 / 续聊 / 删除
     （约 610 行），**合计约 2020 行**。若这次就想把「刷新丢历史」一起解决，选这个。
   - D · C 再加上用量面板（200 行）与 Turn 导航 / 虚拟滚动等重件——本文不建议
     （§2.2 已否掉导航与富卡）。
2. **工具卡要不要递归树**：AgentGateway 今天没有 `subCalls`。保留递归骨架
   （约 40 行空转）还是先做平铺、将来再加？（建议：保留骨架，成本极低）
3. **用量面板的优先级**：P2 合理，还是因为「管理面已有独立用量页」而直接砍到
   「只做过程条的耗时、不做 token 分桶」？（建议：先砍，P2 件留到有人反馈再捡）
4. **MIT 声明的落点**：`webui/admin/THIRD-PARTY-NOTICES.md` + 每文件一行注释
   （本文方案），还是希望在仓库根目录放一个统一的 `THIRD-PARTY-NOTICES.md`？
   后者更显眼，但会碰到「只提交自己负责范围的文件」的纪律。
5. **实现线程的起点与并行度**：`be9155a` 已提交，起点没有争议——从含它的提交起。
   要定的是：**现在就开实现线程**，还是**等外援可能还有的后续改动也落定再开**？
   （建议：现在开，但用 §7.1 策略 2、3 的「新文件 + 只改 import」纪律，
   把外援后续改动的冲突面预先压到最小。）
