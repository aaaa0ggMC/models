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
 * 除 `POST /admin/api/login` 与 `GET /admin/api/bootstrap` 外全部要鉴权
 * （66 §3：控制面认证，管理员路由全部要过鉴权）。令牌走
 * `Authorization: Bearer <token>`。
 *
 * ## 日志脱敏
 *
 * 本文件**绝不**把请求体写进日志——请求体里可能有完整 key。错误日志只记
 * 路由与方法。admin/service.ts 的 `redactDetail` 是审计侧的同款防线。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminAuth } from './auth.js';
import type { AdminService } from './service.js';
import type {
  AliasUpsertRequest,
  BalanceProbeResponse,
  BootstrapResponse,
  CredentialCreateRequest,
  CredentialProbeResponse,
  KeystoreRotateDekResponse,
  KeystoreRotateKekRequest,
  KeystoreRotateKekResponse,
  KeystoreStatusResponse,
  LoginRequest,
  LoginResponse,
  PageQuery,
  ProviderPresetListResponse,
  ProviderUpsertRequest,
  SecretRefCreateRequest,
  SecretRefCreateResponse,
  SecretRefListResponse,
  SettingUpdateRequest,
  SettingUpdateResponse,
  SyncTriggerRequest,
  VirtualKeyCreateRequest,
  VirtualKeyCreateResponse,
  VirtualKeyRevokeResponse,
  VirtualKeyUsageResponse,
} from './api-types.js';
import { ADMIN_API_VERSION } from './auth.js';

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
  /** 日志（可选；不传则静默）。 */
  log?: (message: string) => void;
}

const API_PREFIX = '/admin/api/';
const MAX_BODY_BYTES = 256 * 1024;

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
      // ---- 免鉴权 ----
      if (route === 'bootstrap' && method === 'GET') {
        return await handleBootstrap(req, res, deps);
      }
      if (route === 'login' && method === 'POST') {
        return await handleLogin(req, res, deps);
      }
      if (route === 'logout' && method === 'POST') {
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
        const deleted = await service.deleteProvider(actor, decodeURIComponent(providerMatch[1]!));
        sendJson(res, 200, { ok: true, deleted });
        return true;
      }

      // ---- 凭据 ----
      if (route === 'credentials' && method === 'GET') {
        const provider = url.searchParams.get('provider') ?? undefined;
        const items = await service.listCredentials(provider);
        const page = pageOf(items, url);
        sendJson(res, 200, { ...page, items: page.items });
        return true;
      }
      if (route === 'credentials' && method === 'POST') {
        const body = await readJson<CredentialCreateRequest>(req, res);
        if (body === undefined) return true;
        const result = await service.createCredential(actor, body);
        if (!result.ok) {
          sendJson(res, 400, { error: { code: 'invalid_credential', message: result.error } });
          return true;
        }
        sendJson(res, 200, { ok: true, credential: result.credential });
        return true;
      }
      const credMatch = /^credentials\/([^/]+)$/.exec(route);
      if (credMatch !== null && method === 'DELETE') {
        const deleted = await service.deleteCredential(actor, decodeURIComponent(credMatch[1]!));
        sendJson(res, 200, { ok: true, deleted });
        return true;
      }
      const credProbeMatch = /^credentials\/([^/]+)\/probe$/.exec(route);
      if (credProbeMatch !== null && method === 'POST') {
        const result = await service.probeCredential(decodeURIComponent(credProbeMatch[1]!));
        const body: CredentialProbeResponse = {
          ok: result.ok,
          credential_id: decodeURIComponent(credProbeMatch[1]!),
          status: result.status,
          ...(result.upstream_status === undefined
            ? {}
            : { upstream_status: result.upstream_status }),
          ...(result.message === undefined ? {} : { message: result.message }),
          checked_at: result.checked_at,
        };
        sendJson(res, result.ok ? 200 : 502, body);
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

      // ---- 能力矩阵（只读）----
      if (route === 'capabilities' && method === 'GET') {
        const items = service.listCapabilityMatrix();
        sendJson(res, 200, { items, total: items.length });
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
    ...(body.password === undefined ? {} : { password: body.password }),
    ...(body.access_token === undefined ? {} : { access_token: body.access_token }),
  });
  if (!result.ok) {
    const out: LoginResponse = { ok: false, error: result.error };
    sendJson(res, 401, out);
    return true;
  }
  const out: LoginResponse = {
    ok: true,
    token: result.token,
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
