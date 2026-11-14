/**
 * admin/index.ts —— 管理面（控制面）模块出口。
 *
 * 目录：
 *   api-types.ts   —— HTTP API 的唯一契约（前端与后端并行开发的依据）
 *   auth.ts        —— 本地认证（口令 + 单 access token；**不带 OAuth**）
 *   service.ts     —— 业务逻辑（不碰 HTTP，可不起服务器单测）
 *   routes.ts      —— HTTP 路由（对 http/server.ts 只加一个挂载点）
 *   static.ts      —— 托管 webui/admin/ 静态资源
 *   aliases.ts     —— 别名/namespace 规则与解析（S2 路由的输入）
 *
 * 装配在 composition-root.ts（增量，不重构）。
 */

export * from './api-types.js';
export * from './auth.js';
export * from './service.js';
export * from './routes.js';
export * from './static.js';
export * from './aliases.js';
