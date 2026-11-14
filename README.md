# AgentGateway

> **私有仓库 · WIP（work in progress）** —— 当前只有设计文档与协作约定，尚无可用代码。
>
> 架构与详细设计见 [`docs/design/`](docs/design/)（全套 v1.0-draft，**待 review**）。
> 在定稿前，本文件描述的是设计意图，不是已实现的行为。

## 项目定位

**AgentGateway** 是一个 **LLM API 网关**：客户端可以用任意主流格式发请求，
由网关负责在不同格式与不同上游 provider 之间互转，并在链路上提供插件、
内置工具、用量统计与计费等横切能力。

> 仓库名沿用 `models`（历史原因），项目名是 **AgentGateway**。

要解决的核心问题：

- 客户端与上游 provider 的格式互相绑定，换模型就要改代码；
- 各家 usage / finish_reason / tool_call 表示不一致，难以统一计量；
- 长会话、搜索、压缩等能力每个应用各写一遍；
- 用量数据散落各处，无法统一查询与分析。

## 核心设计

### 1. 格式互转

客户端请求可以是任意主流格式，例如：

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages
- Gemini `generateContent`

网关把请求转成上游 provider 的格式，再把上游响应转回客户端请求的格式。
**新增一种客户端格式或一家上游 provider，不应影响其他格式与其他链路环节。**

### 2. 自研 canonical 中间格式

网关内部使用**自研的 canonical 中间格式**——它是一个**超集 schema**，
不直接拿某个厂商的格式当超集（厂商格式各有私有字段与语义，做超集会漏水）。

- 保留 raw passthrough 字段，保证**无损可逆**：转过去再转回来，语义不丢。
- **一律走 canonical（always-canonical）**：v1 每个请求都完整 decode → canonical →
  encode，再完整转回来，**不做字节级 fast path**；usage / finish_reason / tool_call id
  的归一是每次请求的必经步骤。字节级 fast path 为未来可选优化，须实测数据支撑才加回。
- canonical 是插件、内置工具、统计计费唯一看到的数据形态。

### 3. 插件系统

- **generic hook（5 个）**：`onRequest` / `onResponse` / `onStreamChunk` / `onError` / `onToolCall`，
  只操作 canonical，不接触具体厂商格式——插件作者不需要懂所有 provider。
- **adaptor 模式**：外部能力通过 adaptor 接入，而不是把逻辑硬编码进网关。
- 首个计划接入：[billion-context](https://github.com/ranxianglei/billion-context)
  （长会话上下文压缩插件），作为**请求侧压缩**的验证场景。

### 4. 内置搜索

在 canonical 里，搜索被建模为一个 **built-in tool**（`web_search`）：

- 上游 provider **原生支持** → **语义透传 + 方言映射**（如 `web_search` ↔
  `deepseek_web_search`），由 provider 执行；
- 上游**不支持** → 网关自己实现搜索结果，并以 tool 结果的形式注入对话。

对客户端而言，两种路径的可见行为一致。

### 5. 统计与计费

- **独立异步管道**：不阻塞请求主链路；请求完成后旁路归一化 usage 并落库。
- 规范化 usage：统一 token 口径、缓存命中、计费档位，兼容各 provider 的差异。
- **dog-fooding**：提供 **agent 接口**，让 AI 自己查询/分析用量数据
  （例如"上个月哪个模型花了最多钱""哪些请求触发了压缩"）。
- **WebUI**：fork [LibreChat](https://github.com/LibreChat-AI/LibreChat)（纯 MIT）改造，
  自建 gateway 管理模块补上它没有的 virtual key / provider / routing 管理；**不从零画**。

### 6. 显式 Pipeline 请求生命周期

请求生命周期由显式的 Pipeline 阶段驱动，而不是散落在路由里的隐式逻辑。
阶段之间传递 canonical 数据，插件与观测点可以查看任意阶段的中间数据。
需要正确处理的两类复杂情况：

- **流式 SSE**：chunk 级的互转、hook 与背压；
- **工具调用多轮循环**：模型发起 tool_call → 执行 → 回填 → 再次请求。

## 目录结构规划（草案）

> 草案，随设计文档演进；实现动工前以 `docs/design/` 为准。

```text
models/
├── README.md              # 本文件
├── AGENTS.md              # 项目级协作约定
├── CONTRIBUTING.md        # 面向人类协作者的提交/隐私约定
├── CHANGELOG.md           # 变更记录
├── LICENSE                # MIT
├── .gitignore
├── docs/
│   ├── design/            # 详细设计文档（00–70，v1.0-draft 待 review）
│   └── sources.md         # 全部调研来源与结论
├── .github/
│   └── workflows/
│       └── docs.yml       # 文档 CI：markdownlint / 外链 / 围栏与引用 / 术语
├── scripts/
│   └── check-docs.mjs     #  docs.yml 里跑的围栏奇偶 + §N 引用 + 节号校验脚本
├── ir/                    # AG-IR canonical：类型定义 + JSON Schema + round-trip 校验
│                            （= 00 §4.2 的 `ir` 模块；原 README 写的 src/canonical/、70 写的 schema/ 已统一）
├── gateway-core/          # PipelineRunner、11 个阶段（S0–S10）、RequestContext、错误模型
├── adaptors/              # 客户端格式 ↔ 上游 provider 格式互转（一律过 canonical）
├── pipeline/              # 阶段编排（并入 gateway-core；保留目录仅为可读性）
├── plugins/               # 插件系统：5 个 generic hook + adaptor 接入外部能力
├── streaming/             # 统一流式帧信封、三种上游形态桥接、WS 双路径
├── modalities/            # TTS/ASR/Image/Embedding 的 payload 与 mapper
├── decision/              # control-plane 判断：decision 模态 adaptor + 降级路径 + 攒批
├── search/                # built-in tool 建模、两种执行模式、后端抽象
├── builtin/               # 内置能力：web_search 等 built-in tool 的执行面
├── credentials/           # 上游侧凭据、access path、Plan 感知路由
├── auth/                  # 数据面 virtual key + 控制面本地认证/passkey + 权限模型
├── metering/              # usage 归一、多单位、定价、dog-fooding 工具
├── storage/               # 分层、加密、前缀压缩、保留策略、脱敏
├── upstream/              # 上游 provider 客户端、连接管理、重试
├── agentapi/              # dog-fooding：供 AI 查询/分析用量的接口
├── server/                # HTTP/SSE 入口、路由、限流
├── webui/                 # 前端：fork LibreChat，不从零画
├── config/                # 配置样例（仅 .example；凭据走环境变量）
└── tests/
    ├── unit/
    ├── contract/          # 各格式互转的往返（round-trip）测试
    └── e2e/
```

> **目录命名以 [`docs/design/00-overview.md`](docs/design/00-overview.md) §4.2 的模块表为唯一事实来源。**
> 此前仓库里有三套命名（本文件的 `src/canonical/…`、00 的 `gateway-core`/`ir`/`metering`、70 验收标准里的 `schema/`），已统一。

## 状态与路线

- [x] 仓库与协作约定就绪
- [x] `docs/design/` 详细设计成稿（v1.0-draft，**待 review**）
- [ ] review 意见逐条处置（GitHub Issues #1–#8）
- [ ] canonical schema 与往返互转（一律过 canonical，无字节级 fast path）
- [ ] Pipeline 骨架与 SSE / 工具调用循环
- [ ] 插件系统 + billion-context 请求侧压缩
- [ ] 内置 `web_search`（语义透传 + 方言映射 / 网关自实现两条路径）
- [ ] 异步用量统计/计费管道 + agent 查询接口
- [ ] WebUI 接入

## 开发与运行

> 🚧 待设计定稿后补充：依赖安装、本地启动、配置说明、测试与部署。
>
> 需要 provider 凭据的部分一律走环境变量，仓库内只保留 `.example` 样例。

## 许可

MIT，见 [LICENSE](LICENSE)。

---

## 实现运行说明

仓库已进入实现阶段（Phase 1 骨架与最小闭环）。运行方式、目录职责、DI 装配方式、
测试覆盖见 **[`IMPLEMENTATION.md`](IMPLEMENTATION.md)**。

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit --strict
npm run demo        # 起 HTTP ingress + mock 上游，端到端往返演示
```

**当前状态**：`ir/` canonical 类型、DI 容器 + 组合根、`gateway-core/pipeline/`（S0–S10）、
`openai.chat` 与 `anthropic.messages` 两个双向 codec、`metering/` 异步计量管道、
最小 HTTP ingress 已落地。尚未实现：`storage/` 加密存储（Phase 4）、`webui/`、
decision/image/tts/asr 的 **adaptor**（canonical 类型已建）、真实 credential OAuth 流程、
内置搜索实现、商业化功能。
