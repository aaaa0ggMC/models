# AGENTS.md

本文件面向在本仓库（项目名 **AgentGateway**，仓库名 `models`）里工作的 Agent 与协作者。

## 项目是什么

**AgentGateway** 是一个 LLM API 网关：客户端可以用任意主流格式（OpenAI Chat
Completions / OpenAI Responses / Anthropic Messages / Gemini generateContent 等）
发请求，网关负责转成上游 provider 格式、再把响应转回客户端格式，并在链路上提供
插件、内置工具、用量统计与计费等能力。

**当前状态：WIP，只有定位说明与骨架，尚无可用代码。**

架构与详细设计见 [`docs/design/`](docs/design/) —— 由另一线程撰写。
- 设计**定稿前不要写实现代码**；`docs/design/` 的结论优先于本文件与 `README.md`。
- 不要修改 `docs/` 目录下的内容（除该目录的负责线程外）。

## 关键设计约束（实现时不可违背）

- **自研 canonical 中间格式**：超集 schema，保留 raw passthrough 保证无损可逆；
  不直接拿某个厂商格式当超集。
- **插件只操作 canonical**：generic hook（`onRequest` / `onResponse` /
  `onStreamChunk`）不接触具体厂商格式；外部能力走 adaptor 接入。
- **fast path**：客户端格式 == 上游 provider 格式时跳过完整互转，
  只做 usage / finish_reason / tool_call id 标准化。
- **内置搜索建模为 built-in tool**（`web_search`）：上游原生支持则透传，
  否则网关自实现并注入，两种路径对客户端行为一致。
- **统计计费独立异步管道**，不阻塞主链路。
- **请求生命周期用显式 Pipeline 阶段**，正确处理流式 SSE 与工具调用多轮循环。
- 每种格式互转都要有**往返（round-trip）测试**兜底。

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

- `canonical/` 是唯一的事实来源，其他模块通过它交换数据，不跨模块私传厂商结构。
- `adaptors/` 只做格式映射，不放业务逻辑。
- `pipeline/` 只做阶段编排，不实现具体能力。
- `plugins/` 与 `builtin/` 通过 hook/tool 接口挂载，不反向依赖 pipeline 内部。
- `usage/` 旁路消费，不允许反向影响请求结果。
- `webui/` 复用现成 Agent 前端，不从零画；不自建前端组件库。
- 只提交自己负责范围的文件；`git add` 用显式路径，不要 `git add -A`
  以免带上其他线程正在写的文件。

## 环境

本机没有 NetBird 客户端是常态，不要尝试安装或修复。
