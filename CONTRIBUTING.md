# 贡献指南

本仓库是**私有**的 AgentGateway 设计仓库。当前阶段只有设计文档（`docs/design/` 00–70 共 15 篇 +
`docs/sources.md`），**没有实现代码**；设计定稿前不要写实现代码。

## 最重要的两条

1. **`docs/design/` 的结论优先于 `README.md` 与 `AGENTS.md`。** 后两者是概述，冲突时以设计文档为准。
2. **`docs/` 的改动一律走 PR**，由仓库主人 review 后合入；不要直接 push 到 `main`。
   PR 描述里写清对应哪个 issue / 哪条 review 意见。

## 提交前的隐私检查（强制）

```bash
privacy-scan --staged --fail-on any    # commit 前
privacy-scan --push --fail-on any      # push 前
```

输出有 HIGH / MEDIUM 时**逐条**确认文件:行号，重点看：

- 真实姓名、学号、手机号、邮箱、身份证号、QQ/微信；
- 内网/公网 IP、MAC、绝对 home 路径；
- token、password、secret、API key、私钥、`.env`、带账号密码的 URL。

处理方式：删除、脱敏、改成环境变量/本地配置，或替换成明确的假数据。
**不要**用 `--no-verify` / `PRIVACY_SCAN_SKIP=1` 绕过，也不要改动 `~/.config/git/hooks` 下的 hook。

> 明显的占位符（`<YOUR_HOME>`、`YOUR_*`、`example.com`、`process.env.*`、测试 fixture）可以保留，
> 但要在提交信息里写清判定理由。不确定是否敏感时，按敏感处理。

仓库内不得出现的内容同上；上游 provider 的 key 一律走环境变量，仓库里只留 `.example` 样例。

## Git 约定

- 主分支 `main`；仓库级 identity 已配置为 GitHub 用户名 + GitHub noreply 邮箱，**不要提交真实邮箱**。
- 提交信息写清楚「做了什么、为什么」；涉及协议/格式的改动注明影响的格式与方向
  （客户端格式 → 上游格式，或反向）。
- 修复某个 issue 时在提交信息里写 `fix(#N)`，方便回溯。
- 只提交自己负责范围的文件；`git add` 用显式路径，**不要 `git add -A`**。

## 文档改动要过的检查

```bash
node scripts/check-docs.mjs                       # 围栏奇偶 + §N 引用 + 节号 + 术语
npx markdownlint-cli2@0.18.1 "docs/**/*.md" "*.md"   # 风格（MD013/MD060 已关）
```

这些在 CI（`.github/workflows/docs.yml`）里也会跑。常见的踩坑：

- **代码块围栏必须成对**。` ```typescript ` 带语言标识，**不能**当结束标记用——多一个裸 ` ``` ` 会把后面
  大段内容吞进 `<pre>`（issue #1 就是这么坏的）。
- **引用其他文档的节要写文件名**：`[40-provider-adaptors.md](./40-provider-adaptors.md) §2.1`，
  不要只写 `§2.1`（读者不知道指向哪篇）。
- **同一文件内节号不能重复、不能跳号**；带字母后缀的编号（`2.2b` / `4.4b`）是插页，不参与编号序列。
- **术语表禁用的同义词**（见 [docs/design/00-overview.md](docs/design/00-overview.md) §5）：
  `intermediate format` / `universal format` / `provider driver` / `bridge`。
  转述第三方项目命名时可以用，但请确认读者不会误以为在说我们自己的组件。

## 事实性改动的来源要求

- 任何"某家 API 是怎么样的"结论都要给一手来源（官方文档 URL + 访问日期），并写进
  [docs/sources.md](docs/sources.md)。二手来源要显式标注。
- 不确定的标 `[待验证]`，并写清验证方式。
- 已确认与官方文档不符的说法，**改正并在原处留一句校正说明**（哪个来源、什么日期），
  不要静默改掉——否则下游引用旧说法的人无法知道它变了。

## 目录

| 路径 | 内容 |
|---|---|
| `docs/design/00-overview.md` | 总览：定位、范围、约束、架构、术语表、文档索引。**从这里开始读** |
| `docs/design/10…70` | 各专题设计文档 |
| `docs/sources.md` | 全部调研来源、结论摘要、license 备注 |
| `scripts/check-docs.mjs` | 文档自校验脚本 |
| `.github/workflows/docs.yml` | 文档 CI |
| `.markdownlint-cli2.jsonc` / `.lychee.toml` | 两个 linter 的配置 |

设计文档的编号与阅读顺序见 [docs/design/00-overview.md](docs/design/00-overview.md) §6 文档索引。
