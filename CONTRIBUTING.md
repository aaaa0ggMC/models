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

## 前端改动要过的检查：界面文案纪律

管理面（`webui/admin/`）的界面**只允许四种文字**：字段标签、placeholder、必要的短
Tooltip、错误 / 成功反馈（含空状态的「一句话 + 主操作按钮」）。整段讲解不张贴在界面上：
有长期价值的移入帮助页 `webui/admin/src/pages/Help.tsx` 的对应小节（用
`helpHref('<section>')` 深链指过去），纯冗余的删掉。内部术语（canonical / AG-IR / S0 /
pipeline / 透传 / dialect / codec / KEK / DEK / env_ref / access_path …）不许出现在
用户可见串里。

```bash
npm run check:ui-copy   # = node scripts/check-ui-copy.mjs，已包进 npm test
```

脚本扫 `webui/admin/src` 下所有用户可见中文串（排除注释、测试与 `Help.tsx`），命中
「单串 > 12 字 / 解释性模式 / 内部术语」即计疑似；**未豁免的疑似直接红灯**。

必要的例外走豁免，且必须带理由（两种写法等价）：

```tsx
// 行尾（或上一行）注释
<Banner description="网关无法读取上游 API Key，所有请求都会失败。请按部署文档提供启动口令或密钥文件后重启。" /> {/* ui-copy: allow 安全横幅：必须说清后果与恢复动作 */}
```

```json
// 或清单文件 webui/admin/src/.ui-copy-allow.json
[
  {
    "file": "webui/admin/src/api/client.ts",
    "line": 174,
    "reason": "secret tripwire 的安全报错：属错误反馈 + 安全提示，不得弱化"
  }
]
```

反例（会被红灯拦下）与正例：

```tsx
// ❌ 解释性长句贴在界面上
<EmptyState title="还没有客户端密钥" hint="给每个应用或使用者单独发一把密钥，便于统计用量和随时撤销。" … />
// ✅ 空状态只留一句话 + 主操作；"为什么要分密钥"在帮助页「客户端密钥」小节
<EmptyState title="还没有客户端密钥" action={<Button>创建密钥</Button>} … />
```

```tsx
// ❌ 内部术语漏给用户
const ERR = '请填写 access_path';
// ✅ 用户语言
const ERR = '请填写接入路径';
```

**没写理由的豁免按错误计**——豁免的意思是「审过并决定留」，不是「别吵」。

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
| `scripts/check-ui-copy.mjs` | 管理面 UI 文案扫描（界面文案纪律，包在 `npm test` 里） |
| `.github/workflows/docs.yml` | 文档 CI |
| `.markdownlint-cli2.jsonc` / `.lychee.toml` | 两个 linter 的配置 |

设计文档的编号与阅读顺序见 [docs/design/00-overview.md](docs/design/00-overview.md) §6 文档索引。
