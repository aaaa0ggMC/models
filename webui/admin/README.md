# webui/admin —— AgentGateway 管理面前端（Vite + React 18 + Semi Design）

网关自带的管理界面：**静态产物由网关自己托管，无独立服务、无 CDN**。本目录是一个
真正的 Vite 工程（React 18 + TypeScript + [Semi Design](https://semi.design/)），
信息架构对标 [NewAPI / one-api 一系](https://github.com/Calcium-Ion/new-api)（同栈
React + Semi）：左侧一列导航 + 右侧功能页，页面以表格为主、信息密度优先，不放说明段落。

> 这取代了早先「单个手写 `app.js`、无框架、无构建」的版本（已删除）。安全约定全部保留，
> 见下文「安全约定」。

## 栈选型

- **Vite 6 + React 18 + TypeScript + `@douyinfe/semi-ui`**。
- 选 Semi 的理由：NewAPI/one-api 的前端正是 React + Semi，组件覆盖
  （Table/Form/Select/Modal/Toast/Banner/Layout/Nav/SideSheet）与信息密度都对标得上，
  「学它就连栈一起学」。默认 Semi，不自建组件库（AGENTS.md：`webui/` 不从零画）。

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.html` | Vite 入口（SPA 外壳，`#root` 挂载点） |
| `vite.config.ts` | `base: '/admin/'`、root 指向本目录、产物落 `dist/` |
| `tsconfig.json` | 前端专用 tsconfig（DOM lib、`react-jsx`；与后端 tsconfig 独立） |
| `src/main.tsx` | React 根 + 引入 Semi 全量样式 |
| `src/App.tsx` | 外壳：Semi `Nav` 侧栏 + 内容区 + 未登录门 |
| `src/auth.tsx` | 会话状态（**令牌只在内存**）+ 绑定好的 API 调用器 |
| `src/api/client.ts` | fetch 封装：401 处理 + 密钥防泄漏兜底（tripwire） |
| `src/api/types.ts` | 管理面 HTTP 契约的**前端镜像**（权威在 `admin/api-types.ts`） |
| `src/router.ts` | 最小 hash 路由（不引 react-router） |
| `src/format.ts` | 时间 / 数字 / 金额格式化 |
| `src/pages/*` | Login / Channels / Credentials / Aliases / ModelCatalog / Usage / System |
| `src/components/ChannelFormModal.tsx` | 新建 / 编辑渠道弹窗（ComboBox 选 Provider + API Key） |

## 信息架构（NewAPI → 我们）

| NewAPI | 我们 | 路由 |
| --- | --- | --- |
| 渠道 | 渠道（Provider） | `#/channels` |
| —（渠道内 key） | 凭据（掩码） | `#/credentials` |
| — | 别名映射 | `#/aliases` |
| 模型 / 渠道测试 | 模型目录（能力矩阵只读） | `#/catalog` |
| 数据看板 | 用量看板 | `#/usage` |
| 设置 / 关于 | 系统（密钥状态 / 代价说明 / 关于） | `#/system` |

- **渠道页**：顶栏「新建渠道」+ 搜索，主体表格（名称 / Provider / 状态 / 模型数 / 操作
  [编辑·删除·测试]），状态用 `Tag`。
- **新建渠道弹窗**：ComboBox（可搜索、分组）选已知 Provider → 自动带出 base_url /
  dialect / 默认模型 / 官方文档外链 / key 格式提示；使用者只需填 API Key（+ 可选备注）。
  「自定义 Provider」才展开 base_url / dialect / access_path 手填。保存前可「测试连通性」
  （落库后打一次上游探测，回报成败与耗时）。Provider 预设来自只读端点
  `GET /admin/api/provider-presets`（数据在 `providers/presets.ts`）。
- **凭据页**：只显示掩码 + 创建时间 + 所属 provider；支持录入 / 删除 / 探测；**绝不明文回显**。
- **别名页**：表格 + 弹窗；一句话说明三级优先级（显式别名 > 前缀规则 > 原样 id），细节进 Tooltip。
- **模型目录页**：表格（模型 / provider / 上下文 / 模态 / 约束 / 合约测试 / 状态），按模态 /
  关键词过滤，点行看 `SideSheet` 详情；顶栏可触发一次上游同步。
- **用量看板页**：顶部汇总卡（请求数 / 输入 token / 输出 token / 现金 / 等价 API / 未定价），
  下面最近记录表格 + 对账 + 余额探测。
- **系统页**：密钥状态表（模式 / 解锁 / DEK / 加密条数 / 是否建议轮换 / KEK 指纹）；
  **代价说明压成一行 + 「查看详情」弹窗**（原文案一字不改）；KEK/DEK 轮换（破坏性，二次确认）。

## 安全约定（三条，写进代码，不得弱化）

1. **会话令牌只在内存**（`src/auth.tsx` 的 React state/ref）。不写
   `localStorage` / `sessionStorage`——那会让令牌在关闭标签页后仍可被同源任意脚本读到，
   而管理面威胁模型里同源 XSS 是要防的。代价是刷新页面要重新登录，登录页与系统页都明示。
2. **完整密钥永不渲染**。凭据表只渲染服务端给的 `masked`；`src/api/client.ts` 的
   `secretTripwire` 在把响应交回页面前扫一遍，出现疑似完整密钥字段就抛错并阻止渲染
   （只在 `console.warn` 记字段路径，绝不记值）。完整 key 只在录入 / 新建表单里出现一次。
3. **代价文案原样展示**。`keystore.tradeoff_note`
   （[`docs/design/65-storage-and-retention.md`](../docs/design/65-storage-and-retention.md)
   §3.2b「自动解锁换不来运行时防护」）系统页用单行 + 弹窗呈现，**不截断文本内容、不改写、
   不"优化"**（单行只是 CSS 视觉截断，完整原文在弹窗里）。未登录 401 行为不变：带令牌仍
   401 = 会话过期 → 清令牌回登录页；登录接口的 401 原样带给用户。

## 构建与部署

```bash
npm run build:admin        # tsc 类型检查 + vite build → webui/admin/dist/
npm run build              # 后端 tsc + build:admin + copy-static-assets：
                           #   前端产物拷进 dist/webui/admin/，JSON 资产进 dist/
```

- 产物 `webui/admin/dist/`（`index.html` + `assets/`，资源 URL 带 `/admin/` 前缀）。
- `npm run build` 会把它拷到 `dist/webui/admin/`；网关 `createGateway()` 未显式传
  `adminStaticRoot` 时**默认从这里托管**（见 `composition-root.ts` 的
  `defaultAdminStaticRoot`），跑过 build 后 `/admin` 直接可用。用 `dist/webui/admin`
  而非 `dist/admin` 是为了避开后端 `admin/` 模块被 tsc 编译到的 `dist/admin/*.js`。
- 保持「网关自己托管静态资源、无独立服务」的形态：`admin/static.ts` 的白名单扩展名、
  路径穿越防护、SPA fallback 一律不变。

## 验证

```bash
npm run typecheck:admin     # tsc --noEmit -p webui/admin/tsconfig.json
npm run typecheck           # 后端（不受前端影响）
npm test                    # vitest（含 /admin/api/provider-presets 新端点测试）
npm run lint                # 后端 eslint（webui/** 已排除，走独立工具链）
npm run format              # prettier --check（生成物 dist/ 与 webui/admin/dist/ 已忽略）
```

## Provider 预设与来源

预设注册表在 [`providers/presets.ts`](../providers/presets.ts)，经只读端点
`GET /admin/api/provider-presets` 透出（**选端点而非前端 bundle import**：单一事实来源、
可热修、前端不复制数据）。每条含 `source`（官方文档 URL）与 `confidence`；不确定的标
`needs_verification`（UI 显示 [待验证]）。DeepSeek 的两条 access path 与 base 已在仓库实测
（见 `credentials/resolver.ts`、`DEEPSEEK-INTEGRATION-REPORT.md`）。
