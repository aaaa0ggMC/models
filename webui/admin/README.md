# webui/admin —— AgentGateway 管理面（最小可用版）

网关自带的管理界面：**纯静态文件，由网关自己托管，无构建步骤、无框架、无 CDN**。
这是 `webui/` 下为将来 fork LibreChat 预留结构之外的**唯一新增子树**——
`webui/` 的其他位置一概没动。

## 怎么被服务

- 网关把 `/admin/*`（但不含 `/admin/api/*`）映射到本目录，见
  [`admin/static.ts`](../admin/static.ts)：白名单扩展名、路径穿越防护、
  未知路径回 `index.html`（SPA 深链可用）。
- 因此页面里**一律用绝对路径** `/admin/styles.css`、`/admin/app.js`：
  文档可能被 serve 成 `/admin`（无尾斜杠）或 `/admin/index.html`，
  相对路径在第一种情况下会解析到 `/styles.css` 而 404。
- API 全部走同源 `/admin/api/*`（契约见 [`admin/api-types.ts`](../admin/api-types.ts)，
  路由实现见 [`admin/routes.ts`](../admin/routes.ts)）。没有 CDN、没有外链，
  网关离线也能用。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | SPA 外壳：导航、代价横幅、主区、页脚 |
| `app.js` | 原生 ES module：路由 + fetch + 渲染（单文件，无 import） |
| `styles.css` | 手写 CSS：主题变量 + 少量布局/组件类，亮/暗双主题 |

`app.js` 不做模块切分是刻意的：静态服务只保证能serve本目录下的文件，
少一个文件就少一个出错面；三段式外壳（html/css/js）也是最容易review的形状。

## 覆盖的视图

| 路由 | 内容 |
| --- | --- |
| `#/login` | 口令 / 单 access token 登录（`POST /admin/api/login`） |
| `#/` | 概览：引导信息 + 密钥存储状态 + 代价原文 + KEK/DEK 轮换入口 |
| `#/providers` | Provider 增删改查（配置不含凭据） |
| `#/credentials` | 凭据列表（**只有掩码**）+ 新建/删除/探测 + 常驻安全警示 |
| `#/aliases` | 别名规则 CRUD + 解析优先级说明 + 试解析 |
| `#/capabilities` | 能力矩阵（只读，过滤只在前端做） |
| `#/sync` | 上游发现 / 离线目录刷新触发 |
| `#/usage` | 用量汇总 + 最近记录 + 对账偏差 + 余额探测 |
| `#/audit` | 审计日志（分页） |

## 三条写进代码的安全约定

1. **会话令牌只在内存里**（`app.js` 的 `state.token`）。不写
   `localStorage` / `sessionStorage`：那会让令牌在关闭标签页后仍可被同源
   任意脚本读到，而管理面的威胁模型里同源 XSS 是要防的。代价是刷新页面要
   重新登录——页脚向用户明示。**唯一**落盘的 UI 状态是主题偏好。
2. **完整密钥永不渲染**。凭据表按字段白名单逐列渲染，服务端多返回任何字段都
   不会进 DOM；另有 `secretTripwire` 兜底：响应里出现疑似完整密钥的字段就
   告警并阻止渲染该对象（只在 `console.warn` 记字段路径，绝不记值）。
   掩码形式（`sk-****abcd`）之外的任何值都不被当作可信展示内容。
3. **代价文案原样展示**。`keystore.tradeoff_note`
   （[`65-storage-and-retention.md`](../docs/design/65-storage-and-retention.md)
   §3.2b「自动解锁换不来运行时防护」）用 `textContent` 写入，**不截断、不改写、
   不"优化"**；页面顶部横幅与「密钥存储」卡片两处都是原文，并各自标注来源。

## 已知缺口（契约有、路由未实现的端点）

`admin/api-types.ts` 定义了 `KeystoreRotateKekRequest` /
`KeystoreRotateDekResponse`，但 `admin/routes.ts` 尚未实现
`keystore/rotate-kek` / `keystore/rotate-dek`。界面上这两个按钮保留，
点击后明确显示「接口不可用：POST /admin/api/keystore/rotate-dek
（服务端返回 404）」——按任务书要求，缺端点就显示清晰的不可用状态，
不 invent 路由。

## 验证

```bash
npx prettier --check webui/admin      # 通过（*.md 被 .prettierignore 排除）
npx eslint webui/admin                # 仓库 eslint.config.js 全局 ignores **/*.js，
                                      # 因此这条命令以 "all files ignored" 退出 2。
                                      # 用同一套规则单独验过：见提交信息里的临时配置跑法
npm run typecheck                     # 通过（本目录是 .js/.css/.html，不在 tsconfig include）
npm test                              # 通过
privacy-scan --staged --fail-on any   # 通过
```

## 冒烟测试

仓库里没有 jsdom，也不允许为此装依赖。开发期用最小 DOM stub 真正跑了一遍
`app.js`（登录 → 八个视图渲染 → Provider/凭据表单提交 → 探测/同步/余额/
试解析 → 密钥泄漏拦截 → 401 回登录 → 退出），全部通过。脚本在
`~/ai-workspace/webui-smoke.mjs`（仓库外，一次性工具，不随仓库提交）。
