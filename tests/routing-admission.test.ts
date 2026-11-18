/**
 * tests/routing-admission.test.ts —— **路由准入**：没建过渠道的 provider 不路由。
 *
 * ## 修的是什么割裂
 *
 * 用户报障（零配置部署：0 渠道 / 0 凭据，只有环境变量里一把 key）：
 *   1. 管理面模型选择器是空的（#45 的列表过滤生效了）；
 *   2. 但聊天**真的打出去了**，拿回上游 401「Authentication Fails, Your api key: ****90b6
 *      is invalid」——一个长得像"key 坏了"的错误，而真实原因是"这个部署根本没建渠道"。
 *
 * 根因在 S2：`ProviderStateFilter` 对"视图里没有这个 provider"的候选**缺省放行**
 * （"不知道状态时不猜"），于是静态路由表（providers/deepseek/profile.ts 的
 * `deepseekRouteAliases()`）+ env 凭据（`EnvCredentialResolver` 自动登记
 * `DEEPSEEK_API_KEY`）叠加出一件事：**只有 DeepSeek 能在零配置下路由**。MiMo 或
 * 其他 provider 不建渠道就完全不可用——那是"为 DeepSeek 而设计"的气味。
 *
 * 本文件把新口径钉死：**「能用」的唯一判据是「配了」**。目标 provider 没有已登记
 * 的渠道配置时，S2 返回 `no_available_provider`（说清"没配渠道"），请求不出门。
 * 静态路由表本身不动——它仍然负责 model → access path 的映射，那是静态事实。
 *
 * ## 三条不能一起坏
 *
 * 1. **mock / 脚手架路径照旧放行**：`requires_credential: false` 的路径（mock）与
 *    矩阵里的 internal 条目没有上游账号可配，"配过吗"对它们无意义。少了这条豁免，
 *    `npm run demo` 和一批 mock 上游测试会被"没配渠道"打死。
 * 2. **建了渠道 + 有凭据 → 正常路由**（准入不是"一律拒绝"）。
 * 3. **重启不误伤**：`providerRuntime` 是管理面 CRUD 时刷新的内存投影，
 *    `loadSettings()`（启动钩子）现在顺带刷新它——否则重启后投影是空的，已建好的
 *    渠道全部变成"没配过"（见 composition-root.ts 的 adminRef 注释）。
 *
 * 全部离线：上游是 ScriptedTransport，key 是显式假串。
 */

import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { createAdminRouter } from '../admin/routes.js';
import { DefaultAdminAuth } from '../admin/auth.js';
import {
  InMemoryRawRecordStore,
  DefaultEncryptedRecordStore,
  type EncryptedRecordStore,
} from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { ScriptedTransport, type ScriptedTransportScript } from '../gateway-core/transport.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { InMemoryProviderRuntimeIndex } from '../admin/provider-runtime.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'routing-admission-passphrase-not-real';
const ADMIN_PASSWORD = 'admin-password-not-real'; // privacy-scan: ignore —— 测试假口令（login 契约字段名，值是显式假串）
/** 假 env key：让 EnvCredentialResolver 自动登记一条凭据（值本身是编的）。 */
const FAKE_ENV_KEY = 'sk-admission-fake-key-not-real'; // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）

/** 一条 OpenAI Chat 非流式响应（脚本化上游）。 */
function chatReply(content: string): ScriptedTransportScript {
  return [
    {
      body: JSON.stringify({
        id: 'chatcmpl-admission',
        object: 'chat.completion',
        created: FIXED_NOW,
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    },
  ];
}

interface Harness {
  server?: Server;
  baseUrl?: string;
  gateway: ReturnType<typeof createGateway>;
  store: EncryptedRecordStore;
  transport: ScriptedTransport;
  /** 管理员会话令牌（打 `/admin/api/*` 用）。 */
  adminToken: string;
  /** 数据面虚拟 key 明文（打 `/v1/chat/completions` 用；只在这一把的内存里）。 */
  vkPlaintext?: string;
}

/** 建一套带管理面的装配（recordStore 必给——没有它就没有渠道表可问）。 */
async function build(
  script: ScriptedTransportScript,
  over: {
    /** env 里配的 DeepSeek key（不传 = 零配置，一把 key 都没有）。 */
    envKey?: string;
    /** 静态装配声明（测试 / 演示装配用；生产不传）。 */
    staticProviders?: readonly string[];
    /** 建一条渠道（id 固定 deepseek）。 */
    channel?: { enabled?: boolean; dialect?: 'openai.chat' | 'anthropic.messages' };
    /** 建一把数据面虚拟 key（S0 用真 DataPlaneAuthenticator 验它）。 */
    virtualKey?: boolean;
  } = {},
): Promise<Harness> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const store = new DefaultEncryptedRecordStore(ks.unlocked(), new InMemoryRawRecordStore(), clock);
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore: store,
    config: { virtualKeysEnabled: over.virtualKey === true },
    credentialResolver: new EnvCredentialResolver(
      undefined,
      undefined,
      over.envKey === undefined ? {} : { DEEPSEEK_API_KEY: over.envKey },
    ),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
    // 启动同步关掉：它会打一次上游 `/models` 消费掉脚本化 transport 的第一条响应
    modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
    ...(over.staticProviders === undefined ? {} : { staticProviders: over.staticProviders }),
  });
  // 启动钩子：把渠道表灌进请求路径的运行时投影（与生产启动同一条路）
  await gateway.loadSettings();

  if (over.channel !== undefined) {
    const r = await gateway.admin!.adminService.upsertProvider('owner', {
      id: 'deepseek',
      label: 'DeepSeek',
      dialect: over.channel.dialect ?? 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
      ...(over.channel.enabled === undefined ? {} : { enabled: over.channel.enabled }),
    });
    if (!r.ok) throw new Error(`建档失败：${r.error}`);
  }

  let vkPlaintext: string | undefined;
  if (over.virtualKey === true) {
    const created = await gateway.virtualKeys!.create({ name: 'admission-test', created_by: 'owner' });
    vkPlaintext = created.plaintext;
  }

  const adminAuth = new DefaultAdminAuth(store, clock, {});
  await adminAuth.setAccount({ id: 'owner', name: 'owner', role: 'owner' }, ADMIN_PASSWORD);
  const routeHandler = createAdminRouter({
    auth: adminAuth,
    service: gateway.admin!.adminService,
    keystoreStatus: () => ({
      mode: 'passphrase',
      tradeoff_note: 'test',
      unlocked: true,
      active_dek_id: 'dek_test',
      encryption_count: 0,
      should_rotate_dek: false,
      argon2_rehash_recommended: false,
      kek_fingerprint: '0123456789abcdef',
    }),
    providerPresets: () => [],
    agentChat: {
      configHub: gateway.agentConfig,
      recorder: gateway.toolRecorder,
      runTurn: (input, sink) => gateway.runner.run(input, sink),
      adminService: gateway.admin!.adminService,
      aliasResolver: gateway.admin!.aliasResolver,
    },
  });
  const server = createHttpServer({
    // 真数据面鉴权器：S0 那道门与线上同一边（不是占位放行）
    authenticator: gateway.dataPlaneAuth,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    adminHandler: routeHandler,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }), // privacy-scan: ignore —— 测试假口令
  });
  const loginBody = (await login.json()) as { token?: string };
  return {
    server,
    baseUrl,
    gateway,
    store,
    transport,
    adminToken: loginBody.token ?? '',
    ...(vkPlaintext === undefined ? {} : { vkPlaintext }),
  };
}

async function close(h: Harness): Promise<void> {
  if (h.server !== undefined) {
    await new Promise<void>((r) => h.server!.close(() => r()));
  }
  await h.gateway.shutdown();
}

/** 带一把有效虚拟 key 打 `/v1/chat/completions`（数据面真实入口）。 */
async function sendChat(
  h: Harness,
  model = 'deepseek-flash',
): Promise<{ status: number; code?: string; message?: string }> {
  if (h.vkPlaintext === undefined) throw new Error('这个装配没有建虚拟 key');
  const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${h.vkPlaintext}`,
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return {
    status: res.status,
    ...(body.error?.code === undefined ? {} : { code: body.error.code }),
    ...(body.error?.message === undefined ? {} : { message: body.error.message }),
  };
}

// ---------------------------------------------------------------------------
// A. 零配置：请求不出门
// ---------------------------------------------------------------------------

describe('准入 · 零配置（0 渠道）：请求不出门', () => {
  it('带有效虚拟 key 打 /v1/chat/completions → no_available_provider，上游一次都没碰', async () => {
    // 环境变量里配了 key（= 用户报障的那个部署），但一条渠道都没建
    const h = await build(chatReply('不该被用到'), { envKey: FAKE_ENV_KEY, virtualKey: true });
    try {
      const res = await sendChat(h);
      expect(res.status).toBe(503);
      expect(res.code).toBe('no_available_provider');
      expect(res.message).toContain('渠道');
      // 关键：以前这里会带着 env key 打到上游拿一个 401；现在准入在出门前就拦下
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await close(h);
    }
  });

  it('零配置 + 一把 key 都没有 → 同样拒（不因为"连 env 都没配"就换一副口径）', async () => {
    const h = await build(chatReply('不该被用到'), { virtualKey: true });
    try {
      const res = await sendChat(h);
      expect(res.code).toBe('no_available_provider');
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await close(h);
    }
  });

  it('内置对话端点同样被准入拦下（狗粮与数据面同一边）', async () => {
    const h = await build(chatReply('不该被用到'), { envKey: FAKE_ENV_KEY });
    try {
      const res = await fetch(`${h.baseUrl}/admin/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });
      expect(res.status).toBe(502); // 信封照旧，错误在 body 里（agent-chat 的既有形态）
      const body = (await res.json()) as { ok?: boolean; error?: string };
      expect(body.ok).toBe(false);
      // 错误是**人类可读串**（契约里就是 string）：要说清"没配渠道"
      expect(String(body.error)).toContain('渠道');
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await close(h);
    }
  });
});

// ---------------------------------------------------------------------------
// B. 配了：照旧路由
// ---------------------------------------------------------------------------

describe('准入 · 配了渠道：照旧路由', () => {
  it('1 渠道 + env key → 200 且上游真的收到请求', async () => {
    const h = await build(chatReply('通了'), { envKey: FAKE_ENV_KEY, channel: {}, virtualKey: true });
    try {
      const res = await sendChat(h);
      expect(res.status).toBe(200);
      expect(h.transport.requests).toHaveLength(1);
    } finally {
      await close(h);
    }
  });

  it('1 渠道 + 没有凭据 → 准入放过，凭据层明确报「没有可用凭据」（不是上游 401）', async () => {
    const h = await build(chatReply('不该被用到'), { channel: {}, virtualKey: true });
    try {
      const res = await sendChat(h);
      // 渠道建了 → 准入不问凭据；缺凭据由 headersFor 报，且请求不出门
      expect(res.status).toBe(503);
      expect(res.message).toContain('凭据');
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await close(h);
    }
  });

  it('渠道被停用 → 拒，且错误说的是「停用」而不是「没配」', async () => {
    const h = await build(chatReply('不该被用到'), {
      envKey: FAKE_ENV_KEY,
      channel: { enabled: false },
      virtualKey: true,
    });
    try {
      const res = await sendChat(h);
      expect(res.code).toBe('no_available_provider');
      expect(res.message).toContain('停用');
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await close(h);
    }
  });
});

// ---------------------------------------------------------------------------
// C. 脚手架与静态装配：不能被一起打死
// ---------------------------------------------------------------------------

describe('准入 · mock 脚手架与静态装配声明', () => {
  it('mock 路径（requires_credential: false）照旧路由——演示与替身不被误伤', async () => {
    const h = await build(
      [
        {
          body: JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: FIXED_NOW,
            model: 'gpt-test-1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'mock ok' } }],
          }),
        },
      ],
      { envKey: FAKE_ENV_KEY },
    );
    try {
      const sink = new MemoryClientSink();
      const outcome = await h.gateway.runner.run(
        {
          client_format: 'openai.chat',
          raw_body: Buffer.from(
            JSON.stringify({
              model: 'mock-gpt',
              messages: [{ role: 'user', content: 'hi' }],
              stream: false,
            }),
            'utf8',
          ),
          headers: { 'content-type': 'application/json' },
          path: '/v1/chat/completions',
          query: {},
        },
        sink,
      );
      expect(outcome.error).toBeUndefined();
      expect(outcome.status).toBe(200);
      expect(h.transport.requests).toHaveLength(1);
    } finally {
      await close(h);
    }
  });

  it('staticProviders 声明过的 provider 照旧路由（测试 / 演示装配的合法用途）', async () => {
    const h = await build(chatReply('静态装配也能跑'), {
      envKey: FAKE_ENV_KEY,
      staticProviders: ['deepseek'],
      virtualKey: true,
    });
    try {
      const res = await sendChat(h);
      expect(res.status).toBe(200);
      expect(h.transport.requests).toHaveLength(1);
    } finally {
      await close(h);
    }
  });
});

// ---------------------------------------------------------------------------
// D. 重启不误伤（启动钩子把渠道表灌进运行时投影）
// ---------------------------------------------------------------------------

describe('准入 · 重启后已建的渠道还在', () => {
  it('建渠道 → 用同一个存储重新装配 → loadSettings → 照旧路由', async () => {
    const first = await build(chatReply('第一次'), {
      envKey: FAKE_ENV_KEY,
      channel: {},
      virtualKey: true,
    });
    try {
      expect((await sendChat(first)).status).toBe(200);
    } finally {
      await close(first);
    }

    // 模拟重启：同一个加密存储、全新的网关实例。渠道表在存储里，运行时投影是空的
    // ——重建它的两条路（装配即刷一次 + 启动钩子 loadSettings）都在这里验。
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const transport = new ScriptedTransport(chatReply('重启后'));
    const restarted = createGateway({
      mode: 'test',
      transport,
      clock,
      recordStore: first.store,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_ENV_KEY,
      }),
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
      modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
    });
    try {
      // 走 auth_exemption（内置对话同款）绕开 S0——这里要验的是 S2 准入，
      // 不想被数据面鉴权（库里那把虚拟 key）抢先。
      const chatInput = {
        client_format: 'openai.chat' as const,
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
        auth_exemption: { caller: 'agent-builtin' as const },
      };

      // 启动钩子（startHttpServer 在 listen 前 await 它）把渠道表灌进投影
      await restarted.loadSettings();

      const after = new MemoryClientSink();
      const afterOutcome = await restarted.runner.run(chatInput, after);
      expect(afterOutcome.error).toBeUndefined();
      expect(afterOutcome.status).toBe(200);
      expect(transport.requests).toHaveLength(1);
    } finally {
      await restarted.shutdown();
    }
  });

  it('装配即刷一次渠道投影（启动钩子漏调也不会把已建渠道判成没配）', async () => {
    // 同一个存储、两条路都验：注入 providerRuntime 从外面断言投影被填上
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const raw = new InMemoryRawRecordStore();
    const store = new DefaultEncryptedRecordStore(ks.unlocked(), raw, clock);
    const seed = createGateway({
      mode: 'test',
      transport: new ScriptedTransport([]),
      clock,
      recordStore: store,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_ENV_KEY,
      }),
      modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
    });
    const created = await seed.admin!.adminService.upsertProvider('owner', {
      id: 'deepseek',
      label: 'DeepSeek',
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
    });
    expect(created.ok).toBe(true);
    await seed.shutdown();

    // 重启：注入一个空投影，装配即刷一次（不 await）——等它落地
    const runtime = new InMemoryProviderRuntimeIndex();
    const restarted = createGateway({
      mode: 'test',
      transport: new ScriptedTransport(chatReply('重启后')),
      clock,
      recordStore: store,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_ENV_KEY,
      }),
      providerRuntime: runtime,
      modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtime.entries().map((e) => e.id)).toContain('deepseek');
    } finally {
      await restarted.shutdown();
    }
  });
});
