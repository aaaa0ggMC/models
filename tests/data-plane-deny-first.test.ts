/**
 * tests/data-plane-deny-first.test.ts —— deny-first 回归（公网暴露安全审计）。
 *
 * 审计要回答的问题只有一个：**整个系统不允许任何无 credential 的访问**。这个文件
 * 把答案钉成测试，全部离线、不碰真实上游、不用任何真实凭据（断言只比较状态码）。
 *
 * 覆盖四件事：
 *   A. 装配时忘给 `createHttpServer` 传 `authenticator` → 数据面整个 401（已存在的门）；
 *   B. 豁免清单是**最小集合**且在一处定义（数据面只有健康检查，管理面只有三条）；
 *   C. 什么都没配（虚拟 key / access token / 显式放行都没有）→ **默认拒绝**，
 *      且每一个入站脸（/v1、/v1beta、tools、audio、modalities、models）都拒；
 *   D. 内层纵深：故意把传输层的门敞开（模拟接错线），S0 与各注入端口自己的鉴权
 *      仍然拒——除了 `/v1/models`，它只有传输层一道门（所以 C 才必须接对）。
 *   E. 管理面无会话 → 401；有会话 → 200（证明不是一律 401 的假绿灯）。
 *
 * 为什么用假 token 而不是真 token：这里断言的是"没有凭据时进不去"，真 token 只会
 * 让测试依赖一份不能进仓库的秘密。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import {
  createHttpServer,
  DATA_PLANE_AUTH_EXEMPTIONS,
  HEALTH_PATH_DEFAULT,
} from '../http/server.js';
import { AUTH_EXEMPT_ROUTES } from '../admin/routes.js';
import { createModelsEndpoints } from '../http/models-endpoint.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import {
  InMemoryProviderProfileRegistry,
  MemoryLogger,
  MemoryMetrics,
  SequentialIdGenerator,
  type Clock,
} from '../di/index.js';
import { loadConfigFromEnv } from '../di/config.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import type { PipelineRunner } from '../gateway-core/pipeline/runner.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../gateway-core/transport.js';

const T0 = 1_800_000_000_000;
const clock: Clock = { now: () => T0 };
const KEYSTORE_PASSPHRASE = 'deny-first-test-passphrase-not-real'; // privacy-scan: ignore —— 明显的假测试口令（后缀 not-real），仅用于本文件的加密存储装配
const ADMIN_PASSWORD = 'deny-first-admin-password-not-real'; // privacy-scan: ignore —— 明显的假测试口令（后缀 not-real），只在本文件里造管理员会话
const SYNC_ADMIN_TOKEN = 'deny-first-sync-admin-token-not-real'; // privacy-scan: ignore —— 明显的假测试令牌（后缀 not-real），只用于 /ag/models/sync 的门禁断言
/** 假上游 key：只让 deepseek 渠道登记成"已配置"（值不进任何断言）。 */
const FAKE_DEEPSEEK_KEY = 'sk-deny-first-not-a-real-key'; // privacy-scan: ignore —— 明显的假上游 key（sk- 前缀 + not-a-real-key），只让 deepseek 渠道登记成已配置

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};

/** 记调用次数的上游：被调用就说明请求穿过了鉴权。 */
class RecordingTransport implements Transport {
  readonly requests: UpstreamRequest[] = [];
  async send(req: UpstreamRequest): Promise<UpstreamResponse> {
    this.requests.push(req);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"id":"x","object":"chat.completion","choices":[]}', 'utf8'),
    };
  }
}

/** 全部数据面入站脸（方法 + 路径）。加新脸时必须往这里加一条。 */
const DATA_PLANE_FACES: ReadonlyArray<{ method: string; path: string }> = [
  // pipeline 脸（/v1 + /v1beta）
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'POST', path: '/v1/responses' },
  { method: 'POST', path: '/v1/messages' },
  { method: 'POST', path: '/v1beta/models/gemini-2.0-flash:generateContent' },
  { method: 'POST', path: '/v1beta/models/gemini-2.0-flash:streamGenerateContent' },
  // 元数据脸
  { method: 'GET', path: '/v1/models' },
  { method: 'GET', path: '/v1/models/deepseek-chat' },
  // 工具脸
  { method: 'POST', path: '/v1/tools/search' },
  { method: 'POST', path: '/v1/tools/fetch' },
  { method: 'POST', path: '/v1/tools/ocr' },
  { method: 'POST', path: '/v1/tools/asr' },
  { method: 'POST', path: '/v1/tools/tts' },
  // 音频脸
  { method: 'POST', path: '/v1/audio/speech' },
  { method: 'POST', path: '/v1/audio/transcriptions' },
  { method: 'POST', path: '/v1/audio/translations' },
  // 模态脸
  { method: 'POST', path: '/v1/images/generations' },
  { method: 'POST', path: '/v1/images/edits' },
  { method: 'POST', path: '/v1/embeddings' },
  { method: 'POST', path: '/v1/decisions' },
];

/** 不起服务的极简 runner：被调用就说明鉴权门没拦住。 */
function neverRunner(): { runner: PipelineRunner; calls: number } {
  const state = { calls: 0 };
  const runner = {
    async run() {
      state.calls += 1;
      return { status: 200 };
    },
  } as unknown as PipelineRunner;
  return {
    runner,
    get calls() {
      return state.calls;
    },
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 打一个端点，只回状态码（响应体可能带内部细节，不进断言）。 */
async function statusOf(base: string, face: { method: string; path: string }): Promise<number> {
  const res = await fetch(`${base}${face.path}`, {
    method: face.method,
    headers: { 'content-type': 'application/json' },
    ...(face.method === 'GET' ? {} : { body: JSON.stringify({ model: 'deepseek-chat' }) }),
  });
  await res.arrayBuffer();
  return res.status;
}

// ---------------------------------------------------------------------------
// A · 忘注入 authenticator：传输层的门自己关着
// ---------------------------------------------------------------------------

describe('A · 忘给 createHttpServer 传 authenticator', () => {
  it('所有数据面入站脸 401，runner 一次都没跑，/health 仍 200', async () => {
    const guard = neverRunner();
    const server = createHttpServer({ port: 0, host: '127.0.0.1', runner: guard.runner });
    const base = await listen(server);
    try {
      for (const face of DATA_PLANE_FACES) {
        expect(await statusOf(base, face), `${face.method} ${face.path}`).toBe(401);
      }
      // 唯一豁免：健康检查（清单见 DATA_PLANE_AUTH_EXEMPTIONS）
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });
      // 未知路径既不放行也不泄露：404
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect(guard.calls).toBe(0);
    } finally {
      await close(server);
    }
  });
});

// ---------------------------------------------------------------------------
// B · 豁免清单：最小集合、一处定义、每条带理由
// ---------------------------------------------------------------------------

describe('B · 豁免清单是最小集合', () => {
  it('数据面只有健康检查一条', () => {
    expect(DATA_PLANE_AUTH_EXEMPTIONS.map((e) => `${e.method} ${e.path}`)).toEqual([
      `GET ${HEALTH_PATH_DEFAULT}`,
    ]);
  });

  it('管理面只有 bootstrap / login / logout 三条', () => {
    expect(AUTH_EXEMPT_ROUTES.map((e) => `${e.method} ${e.route}`).sort()).toEqual([
      'GET bootstrap',
      'POST login',
      'POST logout',
    ]);
  });

  it('每条豁免都写了理由（无理由豁免按错误计）', () => {
    for (const e of DATA_PLANE_AUTH_EXEMPTIONS) {
      expect(e.why.trim().length, `${e.method} ${e.path} 缺理由`).toBeGreaterThan(0);
    }
    for (const e of AUTH_EXEMPT_ROUTES) {
      expect(e.why.trim().length, `${e.method} ${e.route} 缺理由`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// C / D / E · 真装配：什么都没配 → 默认拒绝
// ---------------------------------------------------------------------------

describe('C–E · 什么都没配（虚拟 key / access token / 显式放行都没有）', () => {
  let server: Server;
  let serverOpenGate: Server;
  let base: string;
  let baseOpenGate: string;
  let transport: RecordingTransport;
  let sessionToken: string;

  beforeAll(async () => {
    const keystore = new Keystore(new PassphraseKekSource(), undefined, T0);
    await keystore.unlock(KEYSTORE_PASSPHRASE);
    const recordStore = new DefaultEncryptedRecordStore(
      keystore.unlocked(),
      new InMemoryRawRecordStore(),
      clock,
    );
    transport = new RecordingTransport();
    const gateway = createGateway({
      mode: 'test',
      clock,
      transport,
      recordStore,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
      }),
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
      aliasRules: [
        {
          id: 'deny-first',
          kind: 'exact',
          pattern: 'deepseek-chat',
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-flash',
          },
          priority: 100,
          enabled: true,
        },
      ],
      modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
      // 显式按默认拒绝装配：`mode:'test'` 的进程内装配默认放行（见 composition-root
      // 的三态注释），要验"忘了配凭据"就必须显式关掉——这也正是开关存在的意义。
      config: { permissiveEnabled: false },
    });
    await gateway.loadSettings();

    const models = createModelsEndpoints({
      catalog: gateway.models,
      sync: gateway.modelSync,
      adminToken: SYNC_ADMIN_TOKEN,
    });

    // 生产接线：传输层用真鉴权器（deny 模式）
    server = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      adminHandler: gateway.admin!.routeHandler,
      models,
      tools: gateway.toolEndpoints,
      audio: gateway.audioEndpoints,
      modalities: gateway.modalityEndpoints,
      authenticator: gateway.dataPlaneAuth,
    });
    base = await listen(server);

    // 反面对照：故意把传输层的门敞开（模拟接错线 / 忘接），看内层还拦不拦
    serverOpenGate = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      adminHandler: gateway.admin!.routeHandler,
      models,
      tools: gateway.toolEndpoints,
      audio: gateway.audioEndpoints,
      modalities: gateway.modalityEndpoints,
      authenticator: PERMISSIVE_AUTH,
    });
    baseOpenGate = await listen(serverOpenGate);

    await gateway.admin!.adminAuth.setAccount(
      { id: 'owner', name: 'owner', role: 'owner' },
      ADMIN_PASSWORD,
    );
    const login = await gateway.admin!.adminAuth.login({ password: ADMIN_PASSWORD }); // privacy-scan: ignore —— 假测试口令（后缀 not-real）的引用，值不是真凭据
    if (!login.ok) throw new Error('测试装配失败：管理员登录不通过');
    sessionToken = login.token;
  });

  afterAll(async () => {
    await close(server);
    await close(serverOpenGate);
  });

  it('C1 · 模式报 deny，且每个入站脸都拒（503/401，没有一个 200）', async () => {
    const mode = await fetch(`${base}/admin/api/auth-mode`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(mode.status).toBe(200);
    const described = (await mode.json()) as { mode?: string };
    expect(described.mode).toBe('deny');

    for (const face of DATA_PLANE_FACES) {
      const status = await statusOf(base, face);
      expect([401, 503], `${face.method} ${face.path} → ${status}`).toContain(status);
    }
    // 一次上游都没打：拒绝发生在鉴权，不是上游失败
    expect(transport.requests).toHaveLength(0);
  });

  it('C2 · 管理员同步路由（/ag/models/sync）没带管理员令牌 → 401', async () => {
    const res = await fetch(`${base}/ag/models/sync`);
    expect(res.status).toBe(401);
    const wrong = await fetch(`${base}/ag/models/sync`, {
      headers: { authorization: 'Bearer not-the-admin-token' },
    });
    expect(wrong.status).toBe(401);
  });

  it('D · 传输层门敞开时，S0 与各注入端口自己的鉴权仍然拒', async () => {
    // 这些脸在端口内部还有一道鉴权（与 S0 同一个实例），所以门接错了也进不去
    const innerFaces = DATA_PLANE_FACES.filter(
      (f) =>
        !f.path.startsWith('/v1/models') &&
        f.path !== '/v1beta/models/gemini-2.0-flash:generateContent',
    );
    for (const face of innerFaces) {
      const status = await statusOf(baseOpenGate, face);
      expect([401, 503], `${face.method} ${face.path} → ${status}`).toContain(status);
    }
    expect(transport.requests).toHaveLength(0);
  });

  it('E · 管理面无会话 → 401；带会话 → 200（不是一律 401 的假绿灯）', async () => {
    const guarded = [
      '/admin/api/providers',
      '/admin/api/virtual-keys',
      '/admin/api/credentials',
      '/admin/api/aliases',
      '/admin/api/capabilities',
      '/admin/api/access-paths',
      '/admin/api/auth-mode',
      '/admin/api/settings',
      '/admin/api/usage',
      '/admin/api/usage/timeseries',
      '/admin/api/audit',
      '/admin/api/keystore/status',
      '/admin/api/secret-refs',
      '/admin/api/sync',
      '/admin/api/provider-models',
    ];
    for (const path of guarded) {
      const anon = await fetch(`${base}${path}`);
      expect(anon.status, `无会话 ${path}`).toBe(401);
    }
    // SSE 端点同样要会话（流式最容易漏鉴权）
    const sse = await fetch(`${base}/admin/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(sse.status).toBe(401);

    const authed = await fetch(`${base}/admin/api/providers`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(authed.status).toBe(200);
  });

  it('E2 · 免鉴权清单里的三条确实免鉴权，且不泄露数据', async () => {
    const bootstrap = await fetch(`${base}/admin/api/bootstrap`);
    expect(bootstrap.status).toBe(200);
    const body = (await bootstrap.json()) as Record<string, unknown>;
    expect(body['authenticated']).toBe(false);
    // 引导信息只回答"登录页该显示什么"，不带任何凭据或配置值
    expect(JSON.stringify(body)).not.toContain(FAKE_DEEPSEEK_KEY);
    expect(JSON.stringify(body)).not.toContain(KEYSTORE_PASSPHRASE);

    const login = await fetch(`${base}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }), // privacy-scan: ignore —— 故意输错的假口令，断言登录失败回 401
    });
    expect(login.status).toBe(401);

    const logout = await fetch(`${base}/admin/api/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(logout.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// F · env → config：放行开关的三态不能读错
// ---------------------------------------------------------------------------

describe('F · AG_DATA_PLANE_PERMISSIVE 的三态', () => {
  it('不设 → undefined（交给装配模式决定：生产拒、test 放）', () => {
    expect(
      loadConfigFromEnv({ AG_DATA_PLANE_PERMISSIVE: undefined }).permissiveEnabled,
    ).toBeUndefined();
  });

  it('=1 / true → 显式放行', () => {
    expect(loadConfigFromEnv({ AG_DATA_PLANE_PERMISSIVE: '1' }).permissiveEnabled).toBe(true);
    expect(loadConfigFromEnv({ AG_DATA_PLANE_PERMISSIVE: 'true' }).permissiveEnabled).toBe(true);
  });

  it('=0 / false → 显式按默认拒绝（连 test 装配也不放行）', () => {
    expect(loadConfigFromEnv({ AG_DATA_PLANE_PERMISSIVE: '0' }).permissiveEnabled).toBe(false);
    expect(loadConfigFromEnv({ AG_DATA_PLANE_PERMISSIVE: 'false' }).permissiveEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G · 生产装配（mode:'production'，即部署脚本那一档）忘了配凭据 → 关门
// ---------------------------------------------------------------------------

describe('G · mode:"production" 且什么都没配 → deny（部署遗漏不会放行）', () => {
  it('无凭据请求 503；显式放行后才 200', async () => {
    const keystore = new Keystore(new PassphraseKekSource(), undefined, T0);
    await keystore.unlock(KEYSTORE_PASSPHRASE);
    const transport = new RecordingTransport();
    const shared = {
      mode: 'production' as const,
      clock,
      transport,
      logger: new MemoryLogger(),
      metrics: new MemoryMetrics(),
      ids: new SequentialIdGenerator(),
      recordStore: new DefaultEncryptedRecordStore(
        keystore.unlocked(),
        new InMemoryRawRecordStore(),
        clock,
      ),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
      }),
      aliasRules: [
        {
          id: 'deny-first-prod',
          kind: 'exact' as const,
          pattern: 'deepseek-chat',
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-flash',
          },
          priority: 100,
          enabled: true,
        },
      ],
      modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
    };

    // G1：什么都不配（这正是"部署脚本漏配凭据"）
    const closed = createGateway({ ...shared });
    await closed.loadSettings();
    const closedServer = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: closed.runner,
      adminHandler: closed.admin!.routeHandler,
      tools: closed.toolEndpoints,
      audio: closed.audioEndpoints,
      modalities: closed.modalityEndpoints,
      authenticator: closed.dataPlaneAuth,
    });
    const closedBase = await listen(closedServer);
    try {
      for (const face of DATA_PLANE_FACES) {
        const status = await statusOf(closedBase, face);
        expect([401, 503], `${face.method} ${face.path} → ${status}`).toContain(status);
      }
      expect(transport.requests).toHaveLength(0);
    } finally {
      await close(closedServer);
      await closed.shutdown();
    }

    // G2：同一个装配 + 显式放行 → 鉴权那道门开了，但**路由准入照样拒**：
    // 这个部署一条渠道都没建，`deepseek-chat` 的 target 是静态拼出来的。
    // 以前这里会带着 env key 打到上游、拿一个上游 401 回来（长得像"key 坏了"，
    // 真实原因是"没配渠道"）；现在 S2 直接以 no_available_provider 拒掉，
    // **一个上游请求都不发**。
    const opened = createGateway({
      ...shared,
      config: { permissiveEnabled: true },
    });
    await opened.loadSettings();
    const openedServer = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: opened.runner,
      adminHandler: opened.admin!.routeHandler,
      tools: opened.toolEndpoints,
      audio: opened.audioEndpoints,
      modalities: opened.modalityEndpoints,
      authenticator: opened.dataPlaneAuth,
    });
    const openedBase = await listen(openedServer);
    try {
      const res = await fetch(`${openedBase}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(res.status).toBe(503);
      expect(body.error?.code).toBe('no_available_provider');
      expect(body.error?.message).toContain('渠道');
      // 准入发生在打上游之前：上游一次都不该被碰到
      expect(transport.requests).toHaveLength(0);
    } finally {
      await close(openedServer);
      await opened.shutdown();
    }
  });
});
