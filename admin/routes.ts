/**
 * admin/routes.ts —— 管理面 HTTP 路由（**独立路由模块**，对 http/server.ts 只加一个挂载点）。
 *
 * 设计约束（任务书的并发冲突规避条款）：
 *   - 新代码全部放新目录，HTTP 挂载用**独立路由模块**；
 *   - 对 `http/server.ts` 只做**最小增量改动**（注册一个 mount 点），不重构它；
 *   - `composition-root.ts` 只做增量装配。
 *
 * 因此本文件导出 `createAdminRouter()`，返回一个
 * `(req, res) => Promise<boolean>` 的 handler：返回 true = 已处理（server.ts
 * 直接返回），false = 不归我管（server.ts 继续走数据面路由）。这样 server.ts
 * 的增量只有三行。
 *
 * ## 鉴权
 *
 * 除 `AUTH_EXEMPT_ROUTES` 这张**显式豁免清单**（`GET /admin/api/bootstrap`、
 * `POST /admin/api/login`、`POST /admin/api/logout`）外全部要鉴权（66 §3：控制面
 * 认证，管理员路由全部要过鉴权）。令牌走 `Authorization: Bearer <token>`。
 * 清单是唯一一处定义，加条目必须带理由——"想不起来拒"不是放行的理由。
 *
 * ## 日志脱敏
 *
 * 本文件**绝不**把请求体写进日志——请求体里可能有完整 key。错误日志只记
 * 路由与方法。admin/service.ts 的 `redactDetail` 是审计侧的同款防线。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAuth } from './auth.js';
import { syncModelsWithOnlineModelsDev } from './provider-models.js';
import type { AdminService } from './service.js';
import {
  exchangeOpenRouterPkce,
  pollDeviceCodeOAuth,
  serializeOAuthSecret,
  startDeviceCodeOAuth,
  startOpenRouterPkce,
  type OAuthDeviceProvider,
} from '../credentials/oauth.js';
import type {
  AgentChatRequest,
  AliasUpsertRequest,
  BalanceProbeResponse,
  BootstrapResponse,
  PluginUpdateRequest,
  VirtualKeyUpdateRequest,
  KeystoreRotateDekResponse,
  KeystoreRotateKekRequest,
  KeystoreRotateKekResponse,
  KeystoreStatusResponse,
  LoginRequest,
  LoginResponse,
  PageQuery,
  ProviderModelsFailure,
  ProviderModelsRequest,
  UpstreamModelDto,
  ProviderPresetListResponse,
  ProviderUpsertRequest,
  RouteGraphSimulateRequest,
  RouteGraphUpsertRequest,
  SecretRefCreateRequest,
  SecretRefCreateResponse,
  SecretRefListResponse,
  SettingResetResponse,
  SettingUpdateRequest,
  SettingUpdateResponse,
  SyncTriggerRequest,
  VirtualKeyCreateRequest,
  VirtualKeyCreateResponse,
  VirtualKeyRevokeResponse,
  VirtualKeyUsageResponse,
} from './api-types.js';
import { ADMIN_API_VERSION } from './auth.js';
import { handleAgentChat, type AgentChatDeps } from './agent-chat.js';
import { builtinRedactionRules } from '../config/agent.js';

/** 路由 handler：true = 已处理。 */
export type AdminRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;

export interface AdminRouterDeps {
  auth: AdminAuth;
  service: AdminService;
  /** 密钥状态（由 composition-root 从 keystore 组装后注入）。 */
  keystoreStatus(): KeystoreStatusResponse;
  /**
   * KEK 轮换端口（可选）。不注入 = 明确回 501，不假装成功。
   *
   * 轮换是破坏性操作：旧密钥表作废，未备份的数据永久解不开。
   */
  rotateKek?(input: { new_passphrase?: string }): Promise<KeystoreRotateKekResponse>;
  /** DEK 轮换端口（可选）。 */
  rotateDek?(): Promise<KeystoreRotateDekResponse>;
  /** 静态资源服务（webui/admin/）。 */
  serveStatic?(pathname: string, res: ServerResponse): Promise<boolean>;
  /**
   * Provider 预设注册表（只读，「新建渠道」ComboBox 数据源）。
   *
   * 由 composition-root 从 providers/presets.ts 组装后注入。不注入 = 该端点 501，
   * 前端退化成自由手填（与旧版一致），不假装有预设。
   */
  providerPresets?(): ProviderPresetListResponse['items'];
  /**
   * 内置对话端点（docs/design/95-agent-chat.md）。
   *
   * 可选端口：不注入 = `POST /admin/api/chat` 明确回 501，不假装有对话能力。
   * 它需要 `PipelineRunner`，而 runner 在 `assembleAdmin` 之后才构造，因此这里
   * 收一个**已装配好的 deps 对象**而不是 runner 本身（见 composition-root.ts）。
   */
  agentChat?: AgentChatDeps;
  /** 日志（可选；不传则静默）。 */
  log?: (message: string) => void;
}

const API_PREFIX = '/admin/api/';
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 管理面免鉴权端点的**显式豁免清单**（唯一一处定义；默认只含最小集合）。
 *
 * deny-first：控制面上"不放行"是默认，"放行"必须是清单里的一条，且每条带理由。
 * 这三条的共同点是「还没有会话可校验」——登录本身、登录前要知道的引导状态、
 * 以及登出（没有令牌时登出只是清客户端状态，不动服务端任何数据）。
 *
 * **往里加东西前先回答**：没有会话的调用方能通过它拿到配置 / 数据 / 花钱 / 改状态吗？
 * 有一个"是"就不该加。要加也要连 `why` 一起写，别留无理由的豁免。
 */
const AUTH_EXEMPT_ROUTES: ReadonlyArray<{
  route: string;
  method: string;
  why: string;
}> = [
  {
    route: 'bootstrap',
    method: 'GET',
    why: '登录前要知道「有没有账号 / 存储解锁没有」，否则登录页不知道该显示什么',
  },
  { route: 'login', method: 'POST', why: '登录本身：口令或 access token 在这里换会话令牌' },
  { route: 'logout', method: 'POST', why: '登出：无令牌时只回 ok，不撤销任何会话、不改任何数据' },
];

/** 这个 (route, method) 在免鉴权清单里吗。 */
function isAuthExemptRoute(route: string, method: string): boolean {
  return AUTH_EXEMPT_ROUTES.some((e) => e.route === route && e.method === method);
}

/** 管理面免鉴权清单（导出给测试断言"最小集合没被悄悄扩大"）。 */
export { AUTH_EXEMPT_ROUTES };

export function createAdminRouter(deps: AdminRouterDeps): AdminRouteHandler {
  const { auth, service } = deps;

  return async (req, res, url) => {
    const path = url.pathname;

    // ---- 静态资源（/admin/* 但不在 /admin/api/ 下）----
    if (!path.startsWith(API_PREFIX) && path.startsWith('/admin')) {
      if (deps.serveStatic !== undefined) {
        return deps.serveStatic(path, res);
      }
      sendJson(res, 404, { error: { code: 'not_found', message: '管理界面静态资源未挂载' } });
      return true;
    }

    if (!path.startsWith(API_PREFIX)) return false;

    const route = path.slice(API_PREFIX.length);
    const method = req.method ?? 'GET';

    try {
      // ---- 免鉴权（显式豁免清单，见 AUTH_EXEMPT_ROUTES）----
      if (isAuthExemptRoute(route, method)) {
        if (route === 'bootstrap' && method === 'GET') {
          return await handleBootstrap(req, res, deps);
        }
        if (route === 'login' && method === 'POST') {
          return await handleLogin(req, res, deps);
        }
        return await handleLogout(req, res, deps);
      }

      // ---- 以下全部要鉴权 ----
      const token = bearerToken(req);
      const user = token === undefined ? undefined : await auth.authenticate(token);
      if (user === undefined) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: '未登录或会话已过期' },
        });
        return true;
      }
      const actor = `${user.name}#${user.id}`;

      // ---- provider ----
      if (route === 'providers' && method === 'GET') {
        const items = await service.listProviders();
        sendJson(res, 200, { items, total: items.length, limit: items.length, offset: 0 });
        return true;
      }
      if (route === 'providers' && method === 'POST') {
        const body = await readJson<ProviderUpsertRequest>(req, res);
        if (body === undefined) return true;
        const id = body.id ?? slugify(body.label);
        const result = await service.upsertProvider(actor, { ...body, id });
        if (!result.ok) {
          sendJson(res, 400, { error: { code: 'invalid_provider', message: result.error } });
          return true;
        }
        sendJson(res, 200, { ok: true, provider: result.provider });
        return true;
      }
      const providerMatch = /^providers\/([^/]+)$/.exec(route);
      if (providerMatch !== null && method === 'DELETE') {
        const cascadeParam = url.searchParams.get('cascade_credentials');
        const cascadeCredentials = cascadeParam !== 'false' && cascadeParam !== '0';
        const resDelete = await service.deleteProviderWithCascade(
          actor,
          decodeURIComponent(providerMatch[1]!),
          { cascadeCredentials },
        );
        sendJson(res, 200, {
          ok: true,
          deleted: resDelete.deleted,
          deleted_credentials: resDelete.deletedCredentials,
        });
        return true;
      }

      // ---- 批量操作（NewAPI 的批量启停/删除；部分失败逐项报错，不 fail-fast）----
      if (route === 'providers/batch' && method === 'POST') {
        const body = await readJson<{
          ids?: string[];
          action?: 'enable' | 'disable' | 'delete';
          cascade_credentials?: boolean;
        }>(req, res);
        if (body === undefined) return true;
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
          sendJson(res, 400, {
            error: { code: 'invalid_provider_batch', message: 'ids 必须是字符串数组' },
          });
          return true;
        }
        const action = body.action;
        if (action !== 'enable' && action !== 'disable' && action !== 'delete') {
          sendJson(res, 400, {
            error: {
              code: 'invalid_provider_batch',
              message: 'action 应为 enable / disable / delete',
            },
          });
          return true;
        }
        const result = await service.batchProviders(actor, {
          ids: body.ids,
          action,
          ...(body.cascade_credentials === undefined
            ? {}
            : { cascade_credentials: body.cascade_credentials }),
        });
        sendJson(res, result.ok ? 200 : 400, {
          ok: result.ok,
          changed: result.changed,
          failed: result.failed,
          ...(result.deleted_credentials === undefined
            ? {}
            : { deleted_credentials: result.deleted_credentials }),
        });
        return true;
      }

      // ---- 渠道复制（只复制配置，**不复制凭据**）----
      const copyMatch = /^providers\/([^/]+)\/copy$/.exec(route);
      if (copyMatch !== null && method === 'POST') {
        const body = await readJson<{ new_id?: string; label?: string }>(req, res);
        if (body === undefined) return true;
        const result = await service.copyProvider(actor, decodeURIComponent(copyMatch[1]!), body);
        if (!result.ok) {
          sendJson(res, result.status, {
            error: { code: 'provider_copy_failed', message: result.error },
          });
          return true;
        }
        sendJson(res, 200, { ok: true, provider: result.provider });
        return true;
      }

      // ---- 连通性检查（打一次上游 GET /models，**不发 chat**）----
      const testMatch = /^providers\/([^/]+)\/test$/.exec(route);
      if (testMatch !== null && method === 'POST') {
        const result = await service.testProvider(actor, decodeURIComponent(testMatch[1]!));
        sendJson(res, result.ok ? 200 : result.code === 'not_found' ? 404 : 502, result);
        return true;
      }

      // ---- OAuth 订阅登录（Device Code: openai-codex / xai；PKCE: openrouter）----
      if (route === 'oauth/device/start' && method === 'POST') {
        const body = await readJson<{ provider?: string }>(req, res);
        if (body === undefined) return true;
        if (body.provider !== 'openai-codex' && body.provider !== 'xai') {
          sendJson(res, 400, {
            error: { code: 'invalid_request', message: 'provider 仅支持 openai-codex 或 xai' },
          });
          return true;
        }
        try {
          const started = await startDeviceCodeOAuth(body.provider as OAuthDeviceProvider);
          sendJson(res, 200, { ok: true, ...started });
        } catch (err) {
          sendJson(res, 502, {
            error: {
              code: 'oauth_start_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return true;
      }

      if (route === 'oauth/device/poll' && method === 'POST') {
        const body = await readJson<{
          session_id?: string;
          provider?: string;
          access_path?: string;
          note?: string;
          save?: boolean;
        }>(req, res);
        if (body === undefined) return true;
        if (typeof body.session_id !== 'string' || body.session_id === '') {
          sendJson(res, 400, {
            error: { code: 'invalid_request', message: 'session_id 不能为空' },
          });
          return true;
        }
        const poll = await pollDeviceCodeOAuth(body.session_id);
        if (poll.status !== 'complete') {
          sendJson(res, 200, poll);
          return true;
        }
        const serialized = serializeOAuthSecret(poll.credential); // privacy-scan: ignore —— OAuth 令牌序列化
        if (body.save === false) {
          sendJson(res, 200, { status: 'complete', secret: serialized }); // privacy-scan: ignore —— 运行时变量序列化回传，非硬编码密钥
          return true;
        }
        const channelProvider =
          typeof body.provider === 'string' && body.provider !== ''
            ? body.provider
            : poll.credential.provider;
        const accessPath =
          typeof body.access_path === 'string' && body.access_path !== ''
            ? body.access_path
            : poll.credential.provider === 'openai-codex'
              ? 'openai-codex.openai-responses'
              : 'xai.openai-responses';
        const saved = await service.createCredential(actor, {
          provider: channelProvider,
          access_path: accessPath,
          secret: serialized, // privacy-scan: ignore —— OAuth 令牌进加密库
          note: body.note ?? 'OAuth 订阅凭据',
        });
        if (!saved.ok) {
          sendJson(res, 400, { error: { code: 'invalid_credential', message: saved.error } });
          return true;
        }
        sendJson(res, 200, { status: 'complete', credential: saved.credential });
        return true;
      }

      if (route === 'oauth/pkce/start' && method === 'POST') {
        const body = await readJson<{ callback_url?: string }>(req, res);
        if (body === undefined) return true;
        const cb =
          typeof body.callback_url === 'string' && body.callback_url !== ''
            ? body.callback_url
            : 'http://localhost:8790/admin/channels';
        const started = startOpenRouterPkce(cb);
        sendJson(res, 200, { ok: true, ...started });
        return true;
      }

      if (route === 'oauth/pkce/exchange' && method === 'POST') {
        const body = await readJson<{
          session_id?: string;
          code_or_url?: string;
          provider?: string;
          access_path?: string;
          note?: string;
          save?: boolean;
        }>(req, res);
        if (body === undefined) return true;
        if (
          typeof body.session_id !== 'string' ||
          body.session_id === '' ||
          typeof body.code_or_url !== 'string' ||
          body.code_or_url === ''
        ) {
          sendJson(res, 400, {
            error: { code: 'invalid_request', message: 'session_id 与授权码不能为空' },
          });
          return true;
        }
        try {
          const apiKey = await exchangeOpenRouterPkce(body.session_id, body.code_or_url);
          if (body.save === false) {
            sendJson(res, 200, { ok: true, secret: apiKey }); // privacy-scan: ignore —— 运行时 PKCE 换取变量，非硬编码密钥
            return true;
          }
          const saved = await service.createCredential(actor, {
            provider:
              typeof body.provider === 'string' && body.provider !== ''
                ? body.provider
                : 'openrouter',
            access_path:
              typeof body.access_path === 'string' && body.access_path !== ''
                ? body.access_path
                : 'openrouter.openai-chat',
            secret: apiKey, // privacy-scan: ignore —— OpenRouter OAuth 换取的 key 进加密库
            note: body.note ?? 'OpenRouter OAuth',
          });
          if (!saved.ok) {
            sendJson(res, 400, { error: { code: 'invalid_credential', message: saved.error } });
            return true;
          }
          sendJson(res, 200, { ok: true, credential: saved.credential });
        } catch (err) {
          sendJson(res, 400, {
            error: {
              code: 'oauth_exchange_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return true;
      }

      // ---- 别名 / namespace ----
      if (route === 'aliases' && method === 'GET') {
        const items = await service.listAliases();
        sendJson(res, 200, { items, total: items.length });
        return true;
      }
      if (route === 'aliases' && method === 'POST') {
        const body = await readJson<AliasUpsertRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.upsertAlias(actor, body);
        if (!result.ok) {
          sendJson(res, 400, {
            error: { code: 'invalid_alias', message: result.errors.join('；') },
          });
          return true;
        }
        sendJson(res, 200, { ok: true, rule: result.rule });
        return true;
      }
      if (route === 'aliases/resolve' && method === 'POST') {
        const body = await readJson<{ model: string }>(req, res);
        if (body === undefined) return true;
        const resolution = service.resolveAlias(body.model);
        if (resolution === undefined) {
          sendJson(res, 200, {
            ok: false,
            error: `模型名 ${body.model} 解析不了：没有命中显式别名 / 前缀规则，能力矩阵里也没有这个 model`,
          });
          return true;
        }
        sendJson(res, 200, { ok: true, resolution });
        return true;
      }
      const aliasMatch = /^aliases\/([^/]+)$/.exec(route);
      if (aliasMatch !== null && method === 'DELETE') {
        const deleted = await service.deleteAlias(actor, decodeURIComponent(aliasMatch[1]!));
        sendJson(res, 200, { ok: true, deleted });
        return true;
      }

      // ---- 路由图引擎（DAG + VM-JS + 服务商注入条件）----
      if (route === 'route-graphs' && method === 'GET') {
        const items = await service.listRouteGraphs();
        sendJson(res, 200, { items, total: items.length });
        return true;
      }
      if (route === 'route-graphs' && method === 'POST') {
        const body = await readJson<RouteGraphUpsertRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.upsertRouteGraph(actor, body);
        if (!result.ok) {
          sendJson(res, 400, {
            error: {
              code: 'invalid_route_graph',
              message: (result.errors ?? ['路由图配置无效']).join('；'),
            },
          });
          return true;
        }
        sendJson(res, 200, { ok: true, graph: result.graph });
        return true;
      }
      if (route === 'route-graphs/simulate' && method === 'POST') {
        const body = await readJson<RouteGraphSimulateRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.simulateRouteGraph(body);
        sendJson(res, 200, result);
        return true;
      }
      const routeGraphMatch = /^route-graphs\/([^/]+)$/.exec(route);
      if (routeGraphMatch !== null && method === 'DELETE') {
        const deleted = await service.deleteRouteGraph(
          actor,
          decodeURIComponent(routeGraphMatch[1]!),
        );
        sendJson(res, 200, { ok: true, deleted });
        return true;
      }

      if (route === 'routing-telemetry' && method === 'GET') {
        const resTelemetry = await service.getRoutingTelemetry();
        sendJson(res, 200, resTelemetry);
        return true;
      }
      if (route === 'routing-telemetry/refresh' && method === 'POST') {
        const body =
          (await readJson<{ provider?: string }>(req, res).catch(
            () => ({}) as { provider?: string },
          )) ?? {};
        const target =
          typeof body.provider === 'string' && body.provider.trim() !== ''
            ? body.provider.trim()
            : undefined;
        const resTelemetry = await service.refreshRoutingTelemetry(target);
        sendJson(res, 200, resTelemetry);
        return true;
      }

      // ---- 能力矩阵（只读；默认按部署态过滤，判据与 /v1/models 同源）----
      if (route === 'capabilities' && method === 'GET') {
        const query = capabilityMatrixQuery(url, res);
        if (query === undefined) return true; // 已回 4xx
        const items = service.listCapabilityMatrix(query);
        sendJson(res, 200, { items, total: items.length });
        return true;
      }

      if (route === 'capabilities/visibility' && method === 'POST') {
        const body = await readJson<{ model?: string; exposed?: boolean }>(req, res);
        if (body === undefined) return true;
        if (typeof body.model !== 'string' || body.model.trim() === '' || typeof body.exposed !== 'boolean') {
          sendJson(res, 400, {
            error: {
              code: 'invalid_visibility',
              message: '必须提供非空 model 字符串与 exposed 布尔值',
            },
          });
          return true;
        }
        const resVis = await service.setModelExposed(actor, body.model.trim(), body.exposed);
        sendJson(res, 200, resVis);
        return true;
      }

      // ---- access path 列表（UI 下拉）----
      if (route === 'access-paths' && method === 'GET') {
        sendJson(res, 200, { items: service.listAccessPaths() });
        return true;
      }

      // ---- Provider 预设注册表（只读，「新建渠道」ComboBox 数据源）----
      if (route === 'provider-presets' && method === 'GET') {
        if (deps.providerPresets === undefined) {
          sendJson(res, 501, {
            error: { code: 'not_implemented', message: '未注入 Provider 预设注册表' },
          });
          return true;
        }
        const items = deps.providerPresets();
        sendJson(res, 200, { items, total: items.length });
        return true;
      }

      // ---- 上游模型清单拉取（预览模式不落库；key 只在这次调用的内存里）----
      // 与 POST /credentials 同级的信任边界：请求体里可能有完整 key，因此
      //   - 响应与日志都不过 readJson 之外的任何路径吐原文字符串；
      //   - 失败分类由 service 归一成一句话 + 可选 detail（detail 已剥离 key）。
      if (route === 'provider-models' && method === 'POST') {
        const body = await readJson<ProviderModelsRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.fetchProviderModels(actor, body);
        // 预览模式的 key **绝不回显**：失败响应只带分类与一句话（detail 已剥离 key）
        // HTTP 状态只分两档：4xx = 调用方的请求不合法；502 = 上游那一侧的问题
        // （key 无效 / 限流 / 不通 / 形状异常）。真正的判据是 error.code。
        sendJson(res, result.ok ? 200 : providerModelsHttpStatus(result), result);
        return true;
      }

      if (route === 'models-dev/sync' && method === 'POST') {
        const body = await readJson<{ models?: UpstreamModelDto[] }>(req, res);
        if (body === undefined) return true;
        const list = Array.isArray(body.models) ? body.models : [];
        const result = await syncModelsWithOnlineModelsDev(list);
        sendJson(res, result.ok ? 200 : 502, result);
        return true;
      }

      // ---- 同步触发 ----
      if (route === 'sync' && method === 'POST') {
        const body = await readJson<SyncTriggerRequest>(req, res);
        if (body === undefined) return true;
        const started = Date.now();
        const result = await service.triggerSync(actor, body.kind ?? 'upstream_discovery');
        sendJson(res, result.ok ? 200 : 400, {
          ok: result.ok,
          ...(result.ok ? { result: result.result } : { error: result.error }),
          started_at: started,
          finished_at: Date.now(),
        });
        return true;
      }

      // ---- 用量 / 对账看板 ----
      if (route === 'usage' && method === 'GET') {
        const q = url.searchParams;
        const from = parseIntOrUndefined(q.get('from_ts'));
        const to = parseIntOrUndefined(q.get('to_ts'));
        sendJson(res, 200, await service.usageDashboard(from, to));
        return true;
      }

      // ---- 用量时间序列（趋势图；只读，不新增写入面）----
      if (route === 'usage/timeseries' && method === 'GET') {
        const q = url.searchParams;
        const from = parseIntOrUndefined(q.get('from_ts'));
        const to = parseIntOrUndefined(q.get('to_ts'));
        const bucketMs = parseIntOrUndefined(q.get('bucket_ms'));
        sendJson(res, 200, await service.usageTimeseries(from, to, bucketMs));
        return true;
      }

      // ---- 余额探测 ----
      if (route === 'balance/probe' && method === 'POST') {
        const result = await service.probeBalance();
        const body: BalanceProbeResponse = {
          ok: result.ok,
          balances: result.balances ?? [],
          is_available: result.is_available,
          checked_at: result.checked_at,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
        sendJson(res, result.ok ? 200 : 502, body);
        return true;
      }

      // ---- OAuth 订阅登录（Device Code: openai-codex / xai；PKCE: openrouter）----
      if (route === 'oauth/device/start' && method === 'POST') {
        const body = await readJson<{ provider?: string }>(req, res);
        if (body === undefined) return true;
        if (body.provider !== 'openai-codex' && body.provider !== 'xai') {
          sendJson(res, 400, {
            error: { code: 'invalid_request', message: 'provider 仅支持 openai-codex 或 xai' },
          });
          return true;
        }
        try {
          const started = await startDeviceCodeOAuth(body.provider as OAuthDeviceProvider);
          sendJson(res, 200, { ok: true, ...started });
        } catch (err) {
          sendJson(res, 502, {
            error: {
              code: 'oauth_start_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return true;
      }

      if (route === 'oauth/device/poll' && method === 'POST') {
        const body = await readJson<{
          session_id?: string;
          provider?: string;
          access_path?: string;
          note?: string;
          save?: boolean;
        }>(req, res);
        if (body === undefined) return true;
        if (typeof body.session_id !== 'string' || body.session_id === '') {
          sendJson(res, 400, {
            error: { code: 'invalid_request', message: 'session_id 不能为空' },
          });
          return true;
        }
        const poll = await pollDeviceCodeOAuth(body.session_id);
        if (poll.status !== 'complete') {
          sendJson(res, 200, poll);
          return true;
        }
        const serialized = serializeOAuthSecret(poll.credential); // privacy-scan: ignore —— OAuth 令牌序列化
        if (body.save === false) {
          sendJson(res, 200, { status: 'complete', secret: serialized }); // privacy-scan: ignore —— 运行时变量序列化回传，非硬编码密钥
          return true;
        }
        const channelProvider =
          typeof body.provider === 'string' && body.provider !== ''
            ? body.provider
            : poll.credential.provider;
        const accessPath =
          typeof body.access_path === 'string' && body.access_path !== ''
            ? body.access_path
            : poll.credential.provider === 'openai-codex'
              ? 'openai-codex.openai-responses'
              : 'xai.openai-responses';
        const saved = await service.createCredential(actor, {
          provider: channelProvider,
          access_path: accessPath,
          secret: serialized, // privacy-scan: ignore —— OAuth 令牌进加密库
          note: body.note ?? 'OAuth 订阅凭据',
        });
        if (!saved.ok) {
          sendJson(res, 400, { error: { code: 'invalid_credential', message: saved.error } });
          return true;
        }
        sendJson(res, 200, { status: 'complete', credential: saved.credential });
        return true;
      }

      if (route === 'oauth/pkce/start' && method === 'POST') {
        const body = await readJson<{ callback_url?: string }>(req, res);
        if (body === undefined) return true;
        const cb =
          typeof body.callback_url === 'string' && body.callback_url !== ''
            ? body.callback_url
            : 'http://localhost:8790/admin/channels';
        const started = startOpenRouterPkce(cb);
        sendJson(res, 200, { ok: true, ...started });
        return true;
      }

      if (route === 'oauth/pkce/exchange' && method === 'POST') {
        const body = await readJson<{
          session_id?: string;
          code_or_url?: string;
          provider?: string;
          access_path?: string;
          note?: string;
          save?: boolean;
        }>(req, res);
        if (body === undefined) return true;
        if (
          typeof body.session_id !== 'string' ||
          body.session_id === '' ||
          typeof body.code_or_url !== 'string' ||
          body.code_or_url === ''
        ) {
          sendJson(res, 400, {
            error: { code: 'invalid_request', message: 'session_id 与授权码不能为空' },
          });
          return true;
        }
        try {
          const apiKey = await exchangeOpenRouterPkce(body.session_id, body.code_or_url);
          if (body.save === false) {
            sendJson(res, 200, { ok: true, secret: apiKey }); // privacy-scan: ignore —— 运行时 PKCE 换取变量，非硬编码密钥
            return true;
          }
          const saved = await service.createCredential(actor, {
            provider:
              typeof body.provider === 'string' && body.provider !== ''
                ? body.provider
                : 'openrouter',
            access_path:
              typeof body.access_path === 'string' && body.access_path !== ''
                ? body.access_path
                : 'openrouter.openai-chat',
            secret: apiKey, // privacy-scan: ignore —— OpenRouter OAuth 换取的 key 进加密库
            note: body.note ?? 'OpenRouter OAuth',
          });
          if (!saved.ok) {
            sendJson(res, 400, { error: { code: 'invalid_credential', message: saved.error } });
            return true;
          }
          sendJson(res, 200, { ok: true, credential: saved.credential });
        } catch (err) {
          sendJson(res, 400, {
            error: {
              code: 'oauth_exchange_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return true;
      }

      // ---- 密钥状态 ----
      if (route === 'keystore/status' && method === 'GET') {
        sendJson(res, 200, deps.keystoreStatus());
        return true;
      }

      // ---- 密钥轮换 ----
      // 两个端点在 api-types.ts 里都有契约；实现走注入的端口，routes 只做翻译。
      // KEK 轮换是**破坏性**操作（旧密钥表作废），因此要求显式 confirm，
      // 且未注入端口时明确回 501 而不是假装成功。
      if (route === 'keystore/rotate-kek' && method === 'POST') {
        const body = await readJson<KeystoreRotateKekRequest>(req, res);
        if (body === undefined) return true;
        if (body.confirm !== true) {
          sendJson(res, 400, {
            error: {
              code: 'confirmation_required',
              message: '轮换 KEK 会让旧密钥表作废，请显式传 confirm: true',
            },
          });
          return true;
        }
        if (deps.rotateKek === undefined) {
          sendJson(res, 501, {
            error: { code: 'not_implemented', message: '未注入 KEK 轮换端口' },
          });
          return true;
        }
        const result = await deps.rotateKek({
          ...(body.new_passphrase === undefined ? {} : { new_passphrase: body.new_passphrase }),
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return true;
      }

      if (route === 'keystore/rotate-dek' && method === 'POST') {
        if (deps.rotateDek === undefined) {
          sendJson(res, 501, {
            error: { code: 'not_implemented', message: '未注入 DEK 轮换端口' },
          });
          return true;
        }
        const result = await deps.rotateDek();
        sendJson(res, result.ok ? 200 : 400, result);
        return true;
      }

      // ---- 插件中心（Dogfooding）----
      if (route === 'plugins' && method === 'GET') {
        const data = await service.listPlugins();
        sendJson(res, 200, data);
        return true;
      }
      if (route === 'plugins/logs' && method === 'DELETE') {
        const plugin = url.searchParams.get('plugin') ?? undefined;
        await service.clearPluginLogs(actor, plugin);
        sendJson(res, 200, { ok: true });
        return true;
      }
      const pluginMatch = /^plugins\/([^/]+)$/.exec(route);
      if (pluginMatch !== null && method === 'POST') {
        const body = await readJson<PluginUpdateRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.updatePlugin(
          actor,
          decodeURIComponent(pluginMatch[1]!),
          body,
        );
        if (!result.ok) {
          sendJson(res, 400, { error: { code: 'invalid_plugin', message: result.error } });
          return true;
        }
        sendJson(res, 200, { ok: true, plugin: result.plugin });
        return true;
      }

      // ---- 数据面 virtual key（66 §2）----
      if (route === 'virtual-keys' && method === 'GET') {
        const items = await service.listVirtualKeys();
        const page = pageOf(items, url);
        sendJson(res, 200, { ...page, items: page.items });
        return true;
      }
      if (route === 'virtual-keys' && method === 'POST') {
        const body = await readJson<VirtualKeyCreateRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.createVirtualKey(actor, body);
        if (!result.ok) {
          sendJson(res, 400, { error: { code: 'invalid_virtual_key', message: result.error } });
          return true;
        }
        // **全管理面唯一返回明文的地方**，且只返回这一次。响应带 no-store
        // （sendJson 统一加），不进日志、不进审计。
        const out: VirtualKeyCreateResponse = {
          ok: true,
          key: result.key,
          plaintext: result.plaintext,
        };
        sendJson(res, 200, out);
        return true;
      }
      const vkMatch = /^virtual-keys\/([^/]+)$/.exec(route);
      if (vkMatch !== null && method === 'PATCH') {
        const body = await readJson<VirtualKeyUpdateRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.updateVirtualKey(
          actor,
          decodeURIComponent(vkMatch[1]!),
          body,
        );
        if (!result.ok) {
          sendJson(res, 400, { error: { code: 'invalid_virtual_key', message: result.error } });
          return true;
        }
        sendJson(res, 200, { ok: true, key: result.key });
        return true;
      }
      if (vkMatch !== null && method === 'DELETE') {
        const deleted = await service.deleteVirtualKey(actor, decodeURIComponent(vkMatch[1]!));
        sendJson(res, 200, { ok: true, deleted });
        return true;
      }
      const vkRevokeMatch = /^virtual-keys\/([^/]+)\/revoke$/.exec(route);
      if (vkRevokeMatch !== null && method === 'POST') {
        const result = await service.revokeVirtualKey(actor, decodeURIComponent(vkRevokeMatch[1]!));
        if (!result.ok) {
          sendJson(res, 404, { error: { code: 'not_found', message: result.error } });
          return true;
        }
        const out: VirtualKeyRevokeResponse = { ok: true, key: result.key };
        sendJson(res, 200, out);
        return true;
      }
      const vkUsageMatch = /^virtual-keys\/([^/]+)\/usage$/.exec(route);
      if (vkUsageMatch !== null && method === 'GET') {
        const q = url.searchParams;
        const usage = await service.virtualKeyUsage(
          decodeURIComponent(vkUsageMatch[1]!),
          parseIntOrUndefined(q.get('from_ts')),
          parseIntOrUndefined(q.get('to_ts')),
        );
        const out: VirtualKeyUsageResponse = { ok: true, usage };
        sendJson(res, 200, out);
        return true;
      }

      // ---- 数据面认证模式（互斥语义的可见性）----
      if (route === 'auth-mode' && method === 'GET') {
        sendJson(res, 200, await service.describeDataPlaneAuth());
        return true;
      }

      // ---- 运行时设置（P0-2）----
      if (route === 'settings' && method === 'GET') {
        sendJson(res, 200, await service.listSettings());
        return true;
      }
      const settingMatch = /^settings\/([^/]+)$/.exec(route);
      if (settingMatch !== null && method === 'PUT') {
        const body = await readJson<SettingUpdateRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.updateSetting(
          actor,
          decodeURIComponent(settingMatch[1]!),
          body.value,
        );
        if (!result.ok) {
          sendJson(res, result.status, {
            error: {
              code: result.status === 409 ? 'env_locked' : 'invalid_setting',
              message: result.error,
            },
          });
          return true;
        }
        const out: SettingUpdateResponse = { ok: true, item: result.item };
        sendJson(res, 200, out);
        return true;
      }

      const settingMatchForDelete = /^settings\/([^/]+)$/.exec(route);
      if (settingMatchForDelete !== null && method === 'DELETE') {
        const result = await service.resetSetting(
          actor,
          decodeURIComponent(settingMatchForDelete[1]!),
        );
        if (!result.ok) {
          sendJson(res, result.status, {
            error: {
              code: result.status === 409 ? 'env_locked' : 'invalid_setting',
              message: result.error,
            },
          });
          return true;
        }
        const out: SettingResetResponse = { ok: true, item: result.item };
        sendJson(res, 200, out);
        return true;
      }

      // ---- 内置对话（95 §6.1；dogfooding：走网关自己的推理链路）----
      // 自己 catch：SSE 路由抛出时首字节可能已发出，走外层 catch 会在
      // 已写头之后再 writeHead（ERR_HTTP_HEADERS_SENT）。
      if (route === 'chat' && method === 'POST') {
        if (deps.agentChat === undefined) {
          sendJson(res, 501, {
            error: { code: 'not_implemented', message: '未装配对话端点（缺少推理链路）' },
          });
          return true;
        }
        const body = await readJson<AgentChatRequest>(req, res);
        if (body === undefined) return true;
        await handleAgentChat(res, deps.agentChat, body);
        return true;
      }

      // ---- 脱敏规则（只读视图：内置 + 用户，给前端执行同一份）----
      if (route === 'redaction-rules' && method === 'GET') {
        const hub = deps.agentChat?.configHub;
        if (hub === undefined) {
          sendJson(res, 501, {
            error: { code: 'not_implemented', message: '未装配 Agent 配置' },
          });
          return true;
        }
        const config = hub.snapshot();
        sendJson(res, 200, {
          placeholder: config.redaction_placeholder,
          builtin: builtinRedactionRules(),
          user: config.redaction_rules.map((r) => ({
            id: r.id,
            pattern: r.pattern,
            flags: r.flags,
            ...(r.replacement === undefined ? {} : { replacement: r.replacement }),
            enabled: r.enabled,
            ...(r.note === undefined ? {} : { note: r.note }),
          })),
        });
        return true;
      }

      // ---- 敏感值引用登记（只存 env:<VAR>，绝不存值）----
      if (route === 'secret-refs' && method === 'GET') {
        const items = await service.listSecretRefs();
        const out: SecretRefListResponse = { items, total: items.length };
        sendJson(res, 200, out);
        return true;
      }
      if (route === 'secret-refs' && method === 'POST') {
        const body = await readJson<SecretRefCreateRequest & { value?: unknown }>(req, res);
        if (body === undefined) return true;
        const result = await service.registerSecretRef(actor, body);
        if (!result.ok) {
          sendJson(res, result.status, {
            error: { code: 'invalid_secret_ref', message: result.error },
          });
          return true;
        }
        const out: SecretRefCreateResponse = { ok: true, ref: result.ref };
        sendJson(res, 200, out);
        return true;
      }
      const secretRefMatch = /^secret-refs\/([^/]+)$/.exec(route);
      if (secretRefMatch !== null && method === 'DELETE') {
        const deleted = await service.deleteSecretRef(
          actor,
          decodeURIComponent(secretRefMatch[1]!),
        );
        sendJson(res, 200, { ok: true, deleted });
        return true;
      }

      // ---- 审计日志 ----
      if (route === 'audit' && method === 'GET') {
        const limit = parseIntOrUndefined(url.searchParams.get('limit')) ?? 100;
        const offset = parseIntOrUndefined(url.searchParams.get('offset')) ?? 0;
        const { items, total } = await service.listAudit(limit, offset);
        sendJson(res, 200, { items, total, limit, offset });
        return true;
      }

      sendJson(res, 404, { error: { code: 'not_found', message: `未知管理端点: ${route}` } });
      return true;
    } catch {
      // **不把 err.message 写进响应**：它可能夹带内部路径或（极端情况下）
      // 配置内容。只给一个通用文案 + 路由信息，细节进服务端日志。
      deps.log?.(`admin route error: ${method} ${route}`);
      sendJson(res, 500, {
        error: { code: 'internal_error', message: '管理面内部错误（细节已记服务端日志）' },
      });
      return true;
    }
  };
}

// ---------------------------------------------------------------------------
// 各端点的实现
// ---------------------------------------------------------------------------

async function handleBootstrap(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouterDeps,
): Promise<boolean> {
  const token = bearerToken(req);
  const user = token === undefined ? undefined : await deps.auth.authenticate(token);
  const status = deps.keystoreStatus();
  const body: BootstrapResponse = {
    authenticated: user !== undefined,
    storage_unlocked: status.unlocked,
    ...(user === undefined ? {} : { user: { id: user.id, name: user.name, role: user.role } }),
    keystore: {
      mode: status.mode,
      // **原样透出**代价说明，不得改写（65 §3.2b 的硬要求）
      tradeoff_note: status.tradeoff_note,
      argon2_rehash_recommended: status.argon2_rehash_recommended,
    },
    api_version: ADMIN_API_VERSION,
  };
  sendJson(res, 200, body);
  return true;
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouterDeps,
): Promise<boolean> {
  const body = await readJson<LoginRequest>(req, res);
  if (body === undefined) return true;
  const result = await deps.auth.login({
    ...(body.password === undefined ? {} : { password: body.password }), // privacy-scan: ignore —— LoginRequest 契约字段，右侧是请求体里的内存值
    ...(body.access_token === undefined ? {} : { access_token: body.access_token }), // privacy-scan: ignore —— 同上：登录契约字段，值来自请求体
  });
  if (!result.ok) {
    const out: LoginResponse = { ok: false, error: result.error };
    sendJson(res, 401, out);
    return true;
  }
  const out: LoginResponse = {
    ok: true,
    token: result.token, // privacy-scan: ignore —— LoginResponse 契约字段，右侧是本次登录签发的会话令牌
    expires_at: result.expires_at,
    user: { id: result.user.id, name: result.user.name, role: result.user.role },
  };
  sendJson(res, 200, out);
  return true;
}

async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRouterDeps,
): Promise<boolean> {
  const token = bearerToken(req);
  if (token !== undefined) await deps.auth.logout(token);
  sendJson(res, 200, { ok: true });
  return true;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * 读 JSON 请求体。
 *
 * 失败时**自己回响应**（400 / 413）并返回 undefined，调用方据此 `return true`。
 * 之所以把 `res` 传进来而不是抛出去：坏 JSON 是**客户端错误**，该回 400；
 * 若抛到外层 catch 会变成 500，把客户端的锅记成服务端的锅。
 *
 * 大小上限 256KB：管理面的请求体都是小配置，超了大概率是客户端 bug 或攻击。
 */
async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      sendJson(res, 413, {
        error: { code: 'payload_too_large', message: '请求体超过 256KB 上限' },
      });
      return undefined;
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 只回前缀片段，不回整个 body——body 里可能有 secret
    sendJson(res, 400, {
      error: {
        code: 'invalid_json',
        message: `请求体不是合法 JSON（前 80 字符: ${text.slice(0, 80)}）`,
      },
    });
    return undefined;
  }
}

function pageOf<T>(
  items: T[],
  url: URL,
): { items: T[]; total: number; limit: number; offset: number } {
  const q: PageQuery = {
    limit: parseIntOrUndefined(url.searchParams.get('limit')),
    offset: parseIntOrUndefined(url.searchParams.get('offset')),
  };
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}

function parseIntOrUndefined(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** 布尔查询参数的解析结果：undefined = 没传；INVALID = 值不合法（已回 400）。 */
const INVALID = Symbol('invalid-boolean-param');

/**
 * `GET /admin/api/capabilities` 的可见性查询参数。
 *
 * 三个开关与 `GET /v1/models` 的 `include_unconfigured` / `include_internal`
 * **同名同义**（两个端点共用 catalog/visibility.ts 的判据，参数名也保持一致，
 * 免得管理员要在两个页面记两套开关）；`all` 是「两个都要」的快捷键——调试时想看的
 * 就是全量。返回值 undefined = 已回 4xx（调用方直接 return）。
 *
 * 为什么严格校验而不是静默忽略：`?all=yes` 被当成"没传"会让调用方以为拿到的是
 * 过滤后的干净清单，而它其实是全量——那比报错更糟（与 catalog/query.ts 的取舍 2 同立场）。
 */
function capabilityMatrixQuery(
  url: URL,
  res: ServerResponse,
): { modality?: string; includeUnconfigured?: boolean; includeInternal?: boolean } | undefined {
  const params = url.searchParams;
  const all = booleanParam(params, 'all', res);
  if (all === INVALID) return undefined;
  const includeUnconfigured = booleanParam(params, 'include_unconfigured', res);
  if (includeUnconfigured === INVALID) return undefined;
  const includeInternal = booleanParam(params, 'include_internal', res);
  if (includeInternal === INVALID) return undefined;
  const rawModality = params.get('modality')?.trim();
  return {
    ...(rawModality ? { modality: rawModality } : {}),
    ...(all === true ? { includeUnconfigured: true, includeInternal: true } : {}),
    ...(includeUnconfigured === undefined ? {} : { includeUnconfigured }),
    ...(includeInternal === undefined ? {} : { includeInternal }),
  };
}

function booleanParam(
  params: URLSearchParams,
  name: string,
  res: ServerResponse,
): boolean | undefined | typeof INVALID {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  sendJson(res, 400, {
    error: {
      code: 'invalid_param',
      message: `查询参数 ${name} 必须是 1/0 或 true/false（收到 "${raw}"）`,
    },
  });
  return INVALID;
}

/**
 * `provider-models` 失败的 HTTP 状态码。
 *
 * 只分两档的理由：这一档的状态码是给"调用方请求不合法"与"上游那一侧不行"用的，
 * 而具体是 key 无效、限流还是形状异常，**由 `error.code` 说**（前端按 code 给
 * 一句话 + 一个动作，见 api-types.ts 的分类表）。用 401 表示"key 无效"是个陷阱：
 * 它和管理面会话过期的 401 是同一个码，前端会跳登录页。
 */
function providerModelsHttpStatus(result: ProviderModelsFailure): 400 | 502 {
  return result.error.code === 'invalid_request' || result.error.code === 'credential_missing'
    ? 400
    : 502;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'provider'
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
