/**
 * auth/index.ts —— 数据面鉴权模块出口。
 *
 * 目录命名依据 docs/design/00-overview.md §4.2 的模块表：`auth` = 「数据面
 * virtual key + 控制面本地认证/passkey + 权限模型」。控制面那一半目前还在
 * `admin/auth.ts`（历史原因，见其文件头）；本目录先落数据面这一半。
 *
 * 模块边界（AGENTS.md「代码组织」）：`gateway-core/` 只依赖本模块的
 * **接口**（`Authenticator`，定义在 s0-ingress.ts），不 import 任何具体实现；
 * 具体实现由 composition-root.ts 装配后经 `S0Options` 注入。
 */

export * from './presentations.js';
export * from './data-plane.js';
