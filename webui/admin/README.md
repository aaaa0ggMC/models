# webui/admin —— AgentGateway 管理面前端（Vite + React 18 + Semi Design）

网关自带的管理界面：**静态产物由网关自己托管，无独立服务、无 CDN**。本目录是一个
真正的 Vite 工程（React 18 + TypeScript + [Semi Design](https://semi.design/)），
信息架构对标 [NewAPI / one-api 一系](https://github.com/Calcium-Ion/new-api)（同栈
React + Semi）：左侧一列导航 + 右侧功能页，页面以表格为主、信息密度优先，不放说明段落。
解释性内容（设计结论、优先级规则、代价说明）集中在**「帮助 / 文档」页**（`#/help`，
支持 `?section=<id>` 小节深链），各功能页只留一句话摘要 + 「了解更多」入口。

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
| `src/api/client.test.ts` | secret tripwire 的回归测试（纯函数，不引 jsdom；判据是「值的形状」而不是字段名） |
| `src/api/types.ts` | 管理面 HTTP 契约的**前端镜像**（权威在 `admin/api-types.ts`） |
| `src/router.ts` | 最小 hash 路由（不引 react-router）；`helpHref()` 拼帮助页小节深链 |
| `src/format.ts` | 时间 / 数字 / 金额格式化 |
| `src/pages/*` | Login / Channels / Credentials / VirtualKeys / Aliases / ModelCatalog / Usage / Settings / System / Help |
| `src/components/ChannelFormModal.tsx` | 新建 / 编辑渠道弹窗（ComboBox 选 Provider + API Key） |

## 信息架构（NewAPI → 我们）

| NewAPI | 我们 | 路由 |
| --- | --- | --- |
| 渠道 | 渠道（Provider） | `#/channels` |
| —（渠道内 key） | 凭据（掩码） | `#/credentials` |
| API 密钥 / 令牌 | 客户端密钥（virtual key，掩码） | `#/virtual-keys` |
| — | 别名映射 | `#/aliases` |
| 模型 / 渠道测试 | 模型目录（能力矩阵只读） | `#/catalog` |
| 数据看板 | 用量看板 | `#/usage` |
| 设置 | 系统设置（第一屏 8 项 + 来源标注） | `#/settings` |
| 设置 / 关于 | 安全与密钥（密钥状态 / 代价说明 / 关于） | `#/system` |
| — | 帮助 / 文档 | `#/help`（支持 `?section=<id>` 小节深链） |

- **帮助 / 文档页**：全站解释性文字集中在这里（设计结论、优先级规则、代价说明），每节标注
  来源——设计文档摘录标 `docs/design/<文件> §N`，实现摘录标 `config/settings.ts` /
  `admin/aliases.ts` 这类**实现文件名**。小节锚点用 DOM `id` + `scrollIntoView` 定位，
  不用 `<a href="#id">`（那会把 hash 路由判到未知路由上去）；各功能页用
  `helpHref('<section>')` 拼深链指过来。小节清单：`settings` / `keystore` /
  `client-key` / `aliases` / `catalog` / `usage`。
- **渠道页**：顶栏「新建渠道」+ 搜索，主体表格（名称 / Provider / 状态 / 模型数 / 操作
  [编辑·删除·测试]），状态用 `Tag`。
- **新建渠道弹窗**：ComboBox（可搜索、分组）选已知 Provider → 自动带出 base_url /
  dialect / 默认模型 / 官方文档外链 / key 格式提示；使用者只需填 API Key（+ 可选备注）。
  「自定义 Provider」才展开 base_url / dialect / access_path 手填。保存前可「测试连通性」
  （落库后打一次上游探测，回报成败与耗时）。Provider 预设来自只读端点
  `GET /admin/api/provider-presets`（数据在 `providers/presets.ts`）。
- **凭据页**：只显示掩码 + 创建时间 + 所属 provider；支持录入 / 删除 / 探测；**绝不明文回显**。
- **客户端密钥页**：virtual key 列表（掩码 + key_id + 模型/provider 限制 + 过期 + 状态）/
  新建 / 撤销 / 删除 / 看该 key 用量。**完整密钥只在新建响应的「仅此一次」模态框里出现**，
  关掉即从 state 消失；列表与用量接口一律只回掩码与前 8 位（66-auth.md §2.2）。
  页面顶部按 `GET /admin/api/auth-mode` 展示当前数据面认证模式，配置冲突时直接说清
  （虚拟 key 与 `AG_ACCESS_TOKEN` 互斥，见后端 `auth/data-plane.ts`）。
- **别名页**：表格 + 弹窗；一句话说明三级优先级（显式别名 > 前缀规则 > 原样 id），细节进 Tooltip。
- **模型目录页**：表格（模型 / provider / 上下文 / 模态 / 约束 / 合约测试 / 状态），按模态 /
  关键词过滤，点行看 `SideSheet` 详情；顶栏可触发一次上游同步。
- **用量看板页**：顶部汇总卡（请求数 / 输入 token / 输出 token / 现金 / 等价 API / 未定价），
  下面最近记录表格 + 对账 + 余额探测。
- **系统设置页**：第一屏 8 个最常改项（全局超时 / TTFB / 流式空闲超时 / 最大重试 /
  退避基数 / loss policy / 模型同步间隔 / 插件超时），每项标注**当前来源**
  （加密存储 / 环境变量 / 配置文件 / 默认值）；被环境变量覆盖的项显示当前值但输入框禁用，
  并给出原因（服务端同样回 409 `env_locked`，不是只在前端禁用）。改完即时生效、不用重启，
  重启后仍在（值落在加密存储里）。
- **安全与密钥页**：密钥状态表（模式 / 解锁 / DEK / 加密条数 / 是否建议轮换 / KEK 指纹）；
  **代价说明压成一行 + 「查看详情」弹窗**（原文案一字不改）；KEK/DEK 轮换（破坏性，二次确认）。

## 安全约定（三条，写进代码，不得弱化）

1. **会话令牌只在内存**（`src/auth.tsx` 的 React state/ref）。不写
   `localStorage` / `sessionStorage`——那会让令牌在关闭标签页后仍可被同源任意脚本读到，
   而管理面威胁模型里同源 XSS 是要防的。代价是刷新页面要重新登录，登录页与系统页都明示。
2. **完整密钥永不渲染**（唯一例外见下）。凭据表只渲染服务端给的 `masked`；
   `src/api/client.ts` 的 `secretTripwire` 在把响应交回页面前扫一遍，出现疑似完整密钥的
   **值**就抛错并阻止渲染（只在 `console.warn` 记字段路径，绝不记值）。完整 key 只在录入 /
   新建表单里出现一次。
   **判据以值的形状为主**：已知密钥前缀（`sk-ag-` / `AIza` / `ghp_` …，后面必须跟
   ≥8 位 base62 随机位）+ 长度 + 字符集（一长串无分隔符 base62 且大小写数字俱全）。
   **字段名只是辅助信号**——只对 `secret` / `api_key` / `access_token` / `password`
   等命名生效，且**不含裸 `key`**。
   **历史教训（别回退）**：旧版只认字段名，而 `GET /settings` 的每一项用 `key` 字段
   承载设置项标识符（`global_timeout_ms`…），与虚拟 key 域撞名，整个设置页被误拦成
   「读不到设置项」。设置项标识符已改名 `id`（`admin/api-types.ts` 的 `SettingDto`，
   breaking change），守卫也改成了按值判断。
   **两个开口子都只认字面字段名、各只有一个调用方**：`allowPlaintext` → `plaintext`
   （`POST /virtual-keys`，唯一返回完整密钥的端点）；`allowSessionToken` → `token`
   （`POST /login`：会话令牌是 43 位 base64url 随机串，与无前缀的 provider key 在值上
   无法区分，只能显式放行；登录响应里其他字段照样过守卫）。
   回归测试在 `src/api/client.test.ts`（前端工程内，vitest 覆盖得到；后端 tsconfig 是
   NodeNext，解析不了前端省略扩展名的相对导入，所以不放 `tests/`）；`tests/ui-contract.test.ts`
   断言全前端只有一处使用 `allowPlaintext`。
3. **代价文案原样展示**。`keystore.tradeoff_note`
   （[`docs/design/65-storage-and-retention.md`](../docs/design/65-storage-and-retention.md)
   §3.2b「自动解锁换不来运行时防护」）系统页用单行 + 弹窗呈现，**不截断文本内容、不改写、
   不"优化"**（单行只是 CSS 视觉截断，完整原文在弹窗里）；「帮助 / 文档」页的 keystore
   小节直接渲染 `useAuth()` 拿到的 `bootstrap.keystore.tradeoff_note`，同样整段呈现、
   不做任何改写。未登录 401 行为不变：带令牌仍 401 = 会话过期 → 清令牌回登录页；登录接口的
   401 原样带给用户。

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
npm test                    # vitest（含 /admin/api/provider-presets 新端点测试、
                            #   webui/admin/src/api/client.test.ts 的 tripwire 纯函数测试）
npm run lint                # 后端 eslint（webui/** 已排除，走独立工具链）
npm run format              # prettier --check（生成物 dist/ 与 webui/admin/dist/ 已忽略）
```

`webui/admin/src/api/client.test.ts` 是前端工程内唯一的测试文件：纯函数、不引 jsdom，
由仓库根的 vitest 一并跑到（`webui/**` 只被后端 eslint 排除，没有被 vitest 排除）。

## Provider 预设与来源

预设注册表在 [`providers/presets.ts`](../providers/presets.ts)，经只读端点
`GET /admin/api/provider-presets` 透出（**选端点而非前端 bundle import**：单一事实来源、
可热修、前端不复制数据）。每条含 `source`（官方文档 URL）与 `confidence`；不确定的标
`needs_verification`（UI 显示 [待验证]）。DeepSeek 的两条 access path 与 base 已在仓库实测
（见 `credentials/resolver.ts`、`DEEPSEEK-INTEGRATION-REPORT.md`）。
