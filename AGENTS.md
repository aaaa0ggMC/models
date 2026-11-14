# AGENTS.md

本文件面向在本仓库（项目名 **AgentGateway**，仓库名 `models`）里工作的 Agent 与协作者。

## 项目是什么

**AgentGateway** 是一个 LLM API 网关：客户端可以用任意主流格式（OpenAI Chat
Completions / OpenAI Responses / Anthropic Messages / Gemini generateContent 等）
发请求，网关负责转成上游 provider 格式、再把响应转回客户端格式，并在链路上提供
插件、内置工具、用量统计与计费等能力。

**当前状态：WIP，只有定位说明与骨架，尚无可用代码。**

架构与详细设计见 [`docs/design/`](docs/design/)（00–70 共 15 篇 + `docs/sources.md`，全套 v1.0-draft、**待 review**）。

**可执行规则（取代原先"由另一线程撰写""负责线程"这类内部协作用语）**：

- 设计**定稿前不要写实现代码**；`docs/design/` 的结论优先于本文件与 `README.md`。
- `docs/` 下的改动**一律走 PR**，由仓库主人 review 后合入；不要直接 push 到 `main`。
- 任何对 `docs/design/` 的修改都要在 PR 描述里写清对应哪个 issue / 哪条 review 意见。
- 只提交自己负责范围的文件；`git add` 用显式路径，不要 `git add -A`。

## 关键设计约束（实现时不可违背）

- **自研 canonical 中间格式**：超集 schema，保留 raw passthrough 保证无损可逆；
  不直接拿某个厂商格式当超集。
- **插件只操作 canonical**：generic hook（`onRequest` / `onResponse` /
  `onStreamChunk` / `onError` / `onToolCall`，共 5 个）不接触具体厂商格式；
  外部能力走 adaptor 接入。
- **一律走 canonical（always-canonical）**：v1 每个请求都完整 decode → canonical →
  encode，再完整转回来；**不做字节级 fast path**。字节级 fast path 为未来可选优化，
  须有实测数据支撑才加回（触发条件见 `docs/design/20-pipeline.md` §4.4）。
- **内置搜索建模为 built-in tool**（`web_search`）：上游原生支持则**语义透传 + 方言映射**
  （`web_search` ↔ `deepseek_web_search` 等），否则网关自实现并注入；两条路径都过
  codec/mapping 与 round-trip 测试，对客户端行为一致。
- **「透传」= 语义不变地完成一次格式转换**，不是零 mapping、不是原样转发字节；
  系统内不存在"原样转发字节"的路径（术语表见 `docs/design/00-overview.md` §5）。
- **统计计费独立异步管道**，不阻塞主链路。
- **请求生命周期用显式 Pipeline 阶段**（S0–S10 共 **11 个**），正确处理流式 SSE 与
  工具调用多轮循环。
- 每种格式互转都要有**往返（round-trip）测试**兜底。
- **文档改动也要过 CI**：`.github/workflows/docs.yml` 会跑 markdownlint、外链检查、
  围栏奇偶、`§N` 引用目标存在性、同文件节号不重复不跳号、术语禁用同义词 grep。

## 协作约定

### 提交与隐私

- commit 前：`privacy-scan --staged --fail-on any`
- push 前：`privacy-scan --push --fail-on any`
- 输出有 HIGH / MEDIUM 时逐条确认，**不要**用 `--no-verify` /
  `PRIVACY_SCAN_SKIP=1` 绕过，也不要改动 `~/.config/git/hooks` 下的 hook。
- 仓库内不得出现：真实姓名、学号、手机号、邮箱、身份证号；内网/公网 IP、MAC、
  绝对 home 路径；token、password、secret、API key、私钥、带账号密码的 URL。
- 上游 provider 的 key 一律走环境变量；仓库里只留 `.example` 样例。
- 明显的占位符可以保留，但要在提交信息里写清判定理由。

### Git

- 主分支 `main`；仓库级 identity 已配置为 GitHub 用户名 + GitHub noreply 邮箱，
  不要提交真实邮箱。
- 提交信息写清楚「做了什么、为什么」；涉及协议/格式的改动注明影响的格式与方向
  （客户端格式 → 上游格式，或反向）。

### 代码组织

> 目录命名以 [`docs/design/00-overview.md`](docs/design/00-overview.md) §4.2 的模块表为唯一事实来源。

- `ir/`（AG-IR canonical）是唯一的事实来源，其他模块通过它交换数据，不跨模块私传厂商结构。
- `adaptors/` 只做格式映射，不放业务逻辑。
- `gateway-core/`（含 `pipeline/`）只做阶段编排，不实现具体能力。
- `plugins/` 与 `builtin/` 通过 hook/tool 接口挂载，不反向依赖 pipeline 内部。
- `metering/`（用量/计费）旁路消费，不允许反向影响请求结果。
- `storage/` 只被 `metering/` 与 dog-fooding 接口读写，不被请求主链路同步依赖。
- `webui/` fork LibreChat 改造，不从零画；不自建前端组件库。
- 只提交自己负责范围的文件；`git add` 用显式路径，不要 `git add -A`
  以免带上其他线程正在写的文件。

## 环境

本机没有 NetBird 客户端是常态，不要尝试安装或修复。
