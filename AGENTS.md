# AGENTS.md

本文件面向在本仓库（`models`）里工作的 Agent 与协作者。

## 项目是什么

简单的模型聚合 & 分析平台：从多个公开数据源聚合 AI/LLM 模型信息，
归一化成统一 schema，再做价格 / 上下文长度 / 能力对比与成本估算。

**当前状态：WIP，只有骨架。** 技术栈尚未确定，落地前先看 `README.md` 的
「目录结构规划」和 `docs/` 下的设计文档。

## 协作约定

### 提交与隐私

- commit 前：`privacy-scan --staged --fail-on any`
- push 前：`privacy-scan --push --fail-on any`
- 输出有 HIGH / MEDIUM 时逐条确认，**不要**用 `--no-verify` /
  `PRIVACY_SCAN_SKIP=1` 绕过，也不要改动 `~/.config/git/hooks` 下的 hook。
- 仓库内不得出现：真实姓名、学号、手机号、邮箱、身份证号；内网/公网 IP、MAC、
  绝对 home 路径；token、password、secret、API key、私钥、带账号密码的 URL。
- 需要鉴权的数据源，凭据一律走环境变量；仓库里只留 `.env.example` 之类的占位说明。
- 明显的占位符可以保留，但要在提交信息里写清判定理由。

### Git

- 主分支 `main`；仓库级 identity 已配置为 GitHub 用户名 + GitHub noreply 邮箱，
  不要提交真实邮箱。
- 提交信息写清楚「做了什么、为什么」，数据抓取类改动注明数据源与抓取时间。

### 代码组织（技术栈确定后细化）

- `ingest/` 只负责"取数 + 存原始快照"，不做业务判断。
- `analysis/` 负责归一化与分析，纯函数优先，便于测试。
- `web/` 只消费 `data/normalized/` 的产物，不直接抓源。
- 新增数据源前，先在 `docs/sources.md` 记录来源、字段映射、许可与使用条款。

## 环境

本机没有 NetBird 客户端是常态，不要尝试安装或修复。
