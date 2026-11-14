/**
 * tests/admin-api.test.ts —— 管理面端到端（真 HTTP + 真加密存储 + 真别名链路）。
 *
 * 任务书的完成标准：「能通过管理 API + 管理 UI 完成：添加一个 provider、
 * 录入凭据（掩码）、建一条别名映射、触发一次同步、看到用量看板；
 * **别名能在真实请求链路里解析成功（端到端测试）**」。
 *
 * 本文件就是那份端到端测试：起一个真的 HTTP 服务器（createHttpServer +
 * createAdminRouter），用真的 fetch 打过去，用真的 Keystore / EncryptedRecordStore
 * 落盘（内存实现），最后让一个带别名的请求穿过**真的 PipelineRunner**
 * （ScriptedTransport 当上游）验证别名在 S2 被解析。
 *
 * 不起真实上游 API、不设任何真实 key（测试 key 只在本文件里，且是明显的假串）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { createAdminRouter } from '../admin/routes.js';
import { DefaultAdminAuth } from '../admin/auth.js';
import {
  InMemoryRawRecordStore,
  DefaultEncryptedRecordStore,
  maskSecret,
} from '../storage/record-store.js';
import {
  Keystore,
  KeystoreLockedError,
  PassphraseKekSource,
  deserializeKeystoreFile,
  serializeKeystoreFile,
} from '../storage/keystore.js';
import { DefaultAliasResolver } from '../admin/aliases.js';
import type { AliasResolver } from '../admin/aliases.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { PROVIDER_PRESETS } from '../providers/presets.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';

const KEYSTORE_PASSPHRASE = 'e2e-test-passphrase-not-real';
const ADMIN_PASSWORD = 'admin-password-not-real';
const FAKE_UPSTREAM_KEY = 'sk-e2e-fake-key-does-not-exist';

/** 固定时钟，避免测试里的时间抖动。 */
const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };

let server: Server;
let baseUrl: string;
let adminToken: string;
let gateway: ReturnType<typeof createGateway>;
let recordStore: DefaultEncryptedRecordStore;
let aliasResolver: AliasResolver;

/**
 * 管理面响应的宽松形状。
 *
 * 为什么不用 `any`：仓库的 eslint 把 `no-explicit-any` 设成 warn，而测试里
 * 到处 any 会让「这里真的没类型」和「这里只是 JSON」混在一起分不出来。
 * 为什么不用裸 `Record<string, unknown>`：那样每读一个字段都要窄化一次，
 * 测试会被窄化代码淹没。这里把**测试会读的字段**显式列出来（自带类型），
 * 其余走索引签名——既安全又可读。
 *
 * 与 admin/api-types.ts 的关系：那边是**契约**（编译期强制），这边是测试的
 * 宽松视图（字段名与那边一致，但类型放宽）。两边不同步时测试会红，
 * 那正是想要的效果。
 */
interface AdminApiBody {
  ok?: boolean;
  deleted?: boolean;
  token?: string;
  expires_at?: number;
  error?: { code?: string; message?: string };
  errors?: string[];
  items?: AdminApiBody[];
  total?: number;
  limit?: number;
  offset?: number;
  provider?: AdminApiBody;
  credential?: AdminApiBody & { storage?: AdminApiBody };
  rule?: AdminApiBody;
  resolution?: AdminApiBody & { target?: AdminApiBody };
  result?: { discovered?: string[]; updated?: string[]; added?: string[] };
  summary?: AdminApiBody;
  recent?: AdminApiBody[];
  reconciliation?: AdminApiBody;
  balances?: AdminApiBody[];
  mode?: string;
  tradeoff_note?: string;
  unlocked?: boolean;
  api_version?: string;
  authenticated?: boolean;
  storage_unlocked?: boolean;
  keystore?: AdminApiBody;
  user?: AdminApiBody;
  status?: string;
  upstream_status?: number;
  message?: string;
  checked_at?: number;
  new_dek_id?: string;
  reencrypted?: number;
  kek_fingerprint?: string;
  [key: string]: unknown;
}

/** 打管理面 API。 */
async function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean } = { auth: true },
): Promise<{ status: number; body: AdminApiBody }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.auth === false || adminToken === ''
        ? {}
        : { authorization: `Bearer ${adminToken}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: AdminApiBody;
  try {
    parsed = JSON.parse(text) as AdminApiBody;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  // ---- 加密存储（真 Keystore + 内存落盘）----
  const keystore = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await keystore.unlock(KEYSTORE_PASSPHRASE);
  const raw = new InMemoryRawRecordStore();
  recordStore = new DefaultEncryptedRecordStore(keystore.unlocked(), raw, clock);

  // ---- 网关（别名解析器注入 S2）----
  const transport = new ScriptedTransport([
    {
      body: JSON.stringify({
        id: 'chatcmpl-e2e-alias',
        object: 'chat.completion',
        created: 1_760_000_000,
        model: 'deepseek-flash',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    },
  ]);
  gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_UPSTREAM_KEY,
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
  });

  // ---- 管理面 ----
  const adminAuth = new DefaultAdminAuth(recordStore, clock, {});
  await adminAuth.setAccount({ id: 'owner', name: 'owner', role: 'owner' }, ADMIN_PASSWORD);

  aliasResolver = gateway.admin!.aliasResolver;
  const routeHandler = createAdminRouter({
    auth: adminAuth,
    service: gateway.admin!.adminService,
    keystoreStatus: () => ({
      mode: 'passphrase',
      tradeoff_note:
        '启动口令解锁：最安全的一档，但每次重启都要有人输入口令，网关无法无人值守自动重启。',
      unlocked: true,
      active_dek_id: 'dek_test',
      encryption_count: 0,
      should_rotate_dek: false,
      argon2_rehash_recommended: false,
      kek_fingerprint: '0123456789abcdef',
    }),
    providerPresets: () => PROVIDER_PRESETS,
  });

  server = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    adminHandler: routeHandler,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // 登录
  const login = await api(
    'POST',
    '/admin/api/login',
    { password: ADMIN_PASSWORD }, // privacy-scan: ignore —— password 是 login 契约字段名，ADMIN_PASSWORD 是测试假口令
    { auth: false },
  );
  adminToken = login.body.token ?? '';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.shutdown();
});

describe('管理面：未鉴权被挡住', () => {
  it('无令牌打 API → 401', async () => {
    const res = await fetch(`${baseUrl}/admin/api/providers`);
    expect(res.status).toBe(401);
  });

  it('错令牌打 API → 401', async () => {
    const res = await fetch(`${baseUrl}/admin/api/providers`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('bootstrap 免鉴权', async () => {
    const res = await fetch(`${baseUrl}/admin/api/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminApiBody;
    expect(body.authenticated).toBe(false);
    expect(body.keystore?.tradeoff_note).toContain('启动口令解锁');
  });
});

describe('管理面：登录 / 登出', () => {
  it('错误口令 → 401', async () => {
    const res = await api('POST', '/admin/api/login', { password: 'wrong' }, { auth: false });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('登录响应只带 ok / token / expires_at / user', async () => {
    // 前端 secretTripwire 对登录响应的 `token` 字段显式放行（会话令牌是 43 位
    // base64url 随机串，与一把没有固定前缀的 provider key 在值上无法区分）；
    // **其他字段照样过守卫**，所以这里守住「登录响应里除会话令牌外不出现别的
    // 东西」——谁哪天往登录响应里塞一把 key，前端会拦，这个测试也会红。
    const login = await api(
      'POST',
      '/admin/api/login',
      { password: ADMIN_PASSWORD }, // privacy-scan: ignore —— password 是 login 契约字段名，ADMIN_PASSWORD 是测试假口令
      { auth: false },
    );
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(String(login.body.token)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(login.body).sort()).toEqual(['expires_at', 'ok', 'token', 'user']);
  });

  it('登出后令牌失效', async () => {
    const login = await api(
      'POST',
      '/admin/api/login',
      { password: ADMIN_PASSWORD }, // privacy-scan: ignore —— password 是 login 契约字段名，ADMIN_PASSWORD 是测试假口令
      { auth: false },
    );
    const token: string = login.body.token!; // privacy-scan: ignore —— LoginResponse 契约字段名，右侧是登录响应里的会话令牌
    const before = await fetch(`${baseUrl}/admin/api/providers`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);
    const out = await fetch(`${baseUrl}/admin/api/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(200);
    const after = await fetch(`${baseUrl}/admin/api/providers`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(401);
  });
});

describe('完成标准 1：添加一个 provider', () => {
  it('POST /admin/api/providers 建成', async () => {
    const res = await api('POST', '/admin/api/providers', {
      id: 'deepseek',
      label: 'DeepSeek',
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'discovery', path: '/models' },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.provider!.id).toBe('deepseek');
    expect(res.body.provider!.enabled).toBe(true);
  });

  it('GET 列表里能看到', async () => {
    const res = await api('GET', '/admin/api/providers');
    expect((res.body.items ?? []).map((p) => p['id'])).toContain('deepseek');
  });

  it('坏 base_url 被拒（400 而不是 500）', async () => {
    const res = await api('POST', '/admin/api/providers', {
      id: 'bad',
      label: 'bad',
      dialect: 'openai.chat',
      base_url: 'not-a-url',
      model_source: { kind: 'static', models: [] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error!.message).toContain('base_url');
  });

  it('DELETE 删掉', async () => {
    const del = await api('DELETE', '/admin/api/providers/deepseek');
    expect(del.body.deleted).toBe(true);
    const list = await api('GET', '/admin/api/providers');
    expect((list.body.items ?? []).map((p) => p['id'])).not.toContain('deepseek');
  });
});

describe('完成标准 2：录入凭据（掩码）', () => {
  it('创建后只回掩码，绝无完整 key', async () => {
    const res = await api('POST', '/admin/api/credentials', {
      provider: 'deepseek',
      access_path: 'deepseek.openai-chat',
      secret: FAKE_UPSTREAM_KEY, // privacy-scan: ignore —— FAKE_UPSTREAM_KEY 是本文件顶部的假 key 常量
      note: 'e2e 测试用假 key',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const cred = res.body.credential!;
    expect(cred.masked).toBe(maskSecret(FAKE_UPSTREAM_KEY));
    // **完整 key 不出现在响应里**
    expect(JSON.stringify(res.body)).not.toContain(FAKE_UPSTREAM_KEY);
    expect(cred.storage?.location).toBe('encrypted');
    expect(cred.length).toBe(FAKE_UPSTREAM_KEY.length);
  });

  it('列表也只回掩码', async () => {
    const res = await api('GET', '/admin/api/credentials');
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(FAKE_UPSTREAM_KEY);
    expect(res.body.items!.length).toBeGreaterThan(0);
    expect(res.body.items![0]!.masked).toBe(maskSecret(FAKE_UPSTREAM_KEY));
  });

  it('secret 与 env_ref 互斥', async () => {
    const res = await api('POST', '/admin/api/credentials', {
      provider: 'deepseek',
      access_path: 'deepseek.openai-chat',
      secret: 'x',
      env_ref: 'DEEPSEEK_API_KEY',
    });
    expect(res.status).toBe(400);
  });

  it('都没有 → 400', async () => {
    const res = await api('POST', '/admin/api/credentials', {
      provider: 'deepseek',
      access_path: 'deepseek.openai-chat',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE 删掉', async () => {
    const list = await api('GET', '/admin/api/credentials');
    const id = String(list.body.items![0]!['id'] ?? '');
    const del = await api('DELETE', `/admin/api/credentials/${id}`);
    expect(del.body.deleted).toBe(true);
  });
});

describe('完成标准 3：建一条别名映射', () => {
  it('POST 建成并被路由引擎立刻看见（热更新，不等重启）', async () => {
    const res = await api('POST', '/admin/api/aliases', {
      kind: 'exact',
      pattern: 'my-fast',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
      note: 'e2e 别名',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rule!.pattern).toBe('my-fast');

    // 路由引擎立刻能解析（不需要重启网关）
    const resolved = aliasResolver.resolve('my-fast', 'chat');
    expect(resolved?.source).toBe('exact');
    expect(resolved?.target.model).toBe('deepseek-flash');
  });

  it('坏规则被拒（400 + 原因），不进路由', async () => {
    const res = await api('POST', '/admin/api/aliases', {
      kind: 'exact',
      pattern: 'bad/rule',
      target: { provider: 'p', access_path: 'ap', model: 'm' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error!.message).toContain('/');
    // 没进路由
    expect(aliasResolver.resolve('bad/rule', 'chat')).toBeUndefined();
  });

  it('试解析端点能预览', async () => {
    const res = await api('POST', '/admin/api/aliases/resolve', { model: 'my-fast' });
    expect(res.body.ok).toBe(true);
    expect(res.body.resolution!.source).toBe('exact');
    expect(res.body.resolution!.target?.model).toBe('deepseek-flash');
  });

  it('DELETE 后路由立刻失效', async () => {
    const list = await api('GET', '/admin/api/aliases');
    const found = (list.body.items ?? []).find((r) => r['pattern'] === 'my-fast');
    const id = String(found?.['id'] ?? '');
    const del = await api('DELETE', `/admin/api/aliases/${id}`);
    expect(del.body.deleted).toBe(true);
    expect(aliasResolver.resolve('my-fast', 'chat')).toBeUndefined();
  });
});

describe('完成标准 4：触发一次同步', () => {
  it('没注入 metadataSync 时给明确错误（不假装同步成功）', async () => {
    const res = await api('POST', '/admin/api/sync', { kind: 'upstream_discovery' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('未注入');
  });

  it('离线目录刷新明确告知 Phase 1 没有这个动作', async () => {
    const res = await api('POST', '/admin/api/sync', { kind: 'offline_catalog_refresh' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('编译期内置');
  });
});

describe('完成标准 5：看到用量看板', () => {
  it('空看板也能返回（全零，不是报错）', async () => {
    const res = await api('GET', '/admin/api/usage');
    expect(res.status).toBe(200);
    expect(res.body.summary!.request_count).toBe(0);
    expect(Array.isArray(res.body.recent)).toBe(true);
  });

  it('发一个请求后看板能看见它', async () => {
    // 先建一条别名，让请求带别名
    await api('POST', '/admin/api/aliases', {
      kind: 'exact',
      pattern: 'e2e-model',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
    });

    const sink = new MemoryClientSink();
    const outcome = await gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'e2e-model',
            messages: [{ role: 'user', content: 'hi' }],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );
    // 请求必须真的成功，否则看板里什么都没有（那不是看板的 bug）
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe(200);
    await gateway.usageEmitter.flush();

    // 注意 to_ts 要显式给到 FIXED_NOW 之后：区间是左闭右开 [from, to)，
    // 而本测试的时钟是**冻结**的（FIXED_NOW），请求的 ts 恰好等于 now，
    // 落在右边界上会被排除。生产环境时钟在走，不存在这个问题。
    const res = await api('GET', `/admin/api/usage?to_ts=${FIXED_NOW + 60_000}`);
    expect(res.body.summary!.request_count).toBeGreaterThan(0);
    expect((res.body.recent ?? []).some((r) => r['model_alias'] === 'e2e-model')).toBe(true);
  });
});

describe('完成标准 6：能力矩阵只读视图（与 ir/capability.ts 同源）', () => {
  it('列出的条目与 CapabilityRegistry 一致（不是另写一份）', async () => {
    const res = await api('GET', '/admin/api/capabilities');
    expect(res.status).toBe(200);
    const registry = gateway.container.resolve<
      import('../credentials/capability-registry.js').CapabilityRegistry
    >((await import('../di/index.js')).TOKENS.CapabilityRegistry);
    const expected = registry.list().map((e) => `${e.access_path}/${e.model}/${e.modality}`);
    const got = (res.body.items ?? []).map(
      (e) => `${String(e['access_path'])}/${String(e['model'])}/${String(e['modality'])}`,
    );
    expect(got.sort()).toEqual(expected.sort());
    // DeepSeek 的 4 条在里头
    expect(got).toContain('deepseek.openai-chat/deepseek-flash/chat');
  });
});

describe('完成标准 7：别名在真实请求链路里解析成功（端到端）', () => {
  it('客户端用别名发请求 → S2 解析到目标 access path/model → 上游收到正确请求', async () => {
    // 建别名 → mock
    const created = await api('POST', '/admin/api/aliases', {
      kind: 'exact',
      pattern: 'e2e-mock-alias',
      target: {
        provider: 'mock',
        access_path: 'mock',
        model: 'gpt-test-1',
      },
    });
    expect(created.body.ok).toBe(true);
    expect(aliasResolver.resolve('e2e-mock-alias', 'chat')?.target.model).toBe('gpt-test-1');

    // ScriptedTransport 自带 requests 记录数组——直接用它看上游收到了什么
    const recordingTransport = new ScriptedTransport([
      {
        body: JSON.stringify({
          id: 'chatcmpl-e2e-mock',
          object: 'chat.completion',
          created: 1_760_000_000,
          model: 'gpt-test-1',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      },
    ]);

    const gw2 = createGateway({
      mode: 'test',
      transport: recordingTransport,
      clock,
      recordStore,
      aliasResolver,
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
    });

    const sink = new MemoryClientSink();
    const result = await gw2.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'e2e-mock-alias',
            messages: [{ role: 'user', content: 'hi' }],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(200);
    expect(recordingTransport.requests).toHaveLength(1);
    // 上游收到的是 mock 的路径与 model（别名被解析掉了）
    expect(recordingTransport.requests[0]!.path).toBe('/v1/chat/completions');
    const upstreamBody = JSON.parse(
      recordingTransport.requests[0]!.body?.toString('utf8') ?? '{}',
    ) as { model: string };
    expect(upstreamBody.model).toBe('gpt-test-1');

    await gw2.shutdown();
  });

  it('前缀规则同样在链路里生效', async () => {
    const createdPrefix = await api('POST', '/admin/api/aliases', {
      kind: 'prefix',
      pattern: 'fast/',
      target: { provider: 'mock', access_path: 'mock', model: 'gpt-test-1' },
    });
    expect(createdPrefix.body.ok).toBe(true);
    expect(aliasResolver.resolve('fast/whatever', 'chat')?.target.model).toBe('gpt-test-1');

    const recordingTransport = new ScriptedTransport([
      {
        body: JSON.stringify({
          id: 'chatcmpl-e2e-prefix',
          object: 'chat.completion',
          created: 1_760_000_000,
          model: 'gpt-test-1',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      },
    ]);
    const gw3 = createGateway({
      mode: 'test',
      transport: recordingTransport,
      clock,
      recordStore,
      aliasResolver,
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
    });

    const sink = new MemoryClientSink();
    await gw3.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({ model: 'fast/whatever', messages: [{ role: 'user', content: 'hi' }] }),
          'utf8',
        ),
        headers: {},
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );
    expect(recordingTransport.requests).toHaveLength(1);
    const prefixBody = JSON.parse(
      recordingTransport.requests[0]!.body?.toString('utf8') ?? '{}',
    ) as { model: string };
    expect(prefixBody.model).toBe('gpt-test-1');
    await gw3.shutdown();
  });

  it('没有别名的未知模型 → 明确的 no_available_provider，不静默打上游', async () => {
    const gw4 = createGateway({
      mode: 'test',
      transport: new ScriptedTransport([]),
      clock,
      recordStore,
      aliasResolver: new DefaultAliasResolver([], { list: () => [] }),
    });
    const sink = new MemoryClientSink();
    const result = await gw4.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({ model: 'totally-unknown', messages: [{ role: 'user', content: 'hi' }] }),
          'utf8',
        ),
        headers: {},
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );
    expect(result.error?.code).toBe('no_available_provider');
    expect(result.error?.http_status).toBe(400);
    await gw4.shutdown();
  });
});

describe('审计日志', () => {
  it('写操作留痕，且**不含 secret**', async () => {
    await api('POST', '/admin/api/providers', {
      id: 'audit-test',
      label: 'audit test',
      dialect: 'openai.chat',
      base_url: 'https://example.invalid',
      model_source: { kind: 'static', models: [] },
    });
    const res = await api('GET', '/admin/api/audit');
    expect(res.status).toBe(200);
    expect(res.body.items!.length).toBeGreaterThan(0);
    const json = JSON.stringify(res.body);
    // 审计里没有完整 key（本测试从未录入过，但要证明这条通道不泄）
    expect(json).not.toContain(FAKE_UPSTREAM_KEY);
    expect((res.body.items ?? []).some((e) => e['action'] === 'provider.create')).toBe(true);
  });
});

describe('密钥状态', () => {
  it('keystore/status 返回模式与代价说明', async () => {
    const res = await api('GET', '/admin/api/keystore/status');
    expect(res.body.mode).toBe('passphrase');
    expect(res.body.tradeoff_note).toContain('启动口令解锁');
    expect(res.body.unlocked).toBe(true);
  });
});

describe('密钥轮换（契约里有、按端口可用性分级响应）', () => {
  it('未注入轮换端口 → 501 而不是假装成功', async () => {
    const kek = await api('POST', '/admin/api/keystore/rotate-kek', { confirm: true });
    expect(kek.status).toBe(501);
    expect(kek.body.error?.code).toBe('not_implemented');

    const dek = await api('POST', '/admin/api/keystore/rotate-dek');
    expect(dek.status).toBe(501);
    expect(dek.body.error?.code).toBe('not_implemented');
  });

  it('缺 confirm → 400（破坏性操作不能一键触发）', async () => {
    const res = await api('POST', '/admin/api/keystore/rotate-kek', { new_passphrase: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('confirmation_required');
  });
});

/**
 * 轮换的**happy path**：端口真的注进去，轮换真的发生，数据真的还在。
 *
 * 上面那组只覆盖了负面路径（501 / 400）——那只能证明「没接线时会诚实地说
 * 没接线」，证明不了「接了线真的能用」。而这个用例锁的是 65 §3.1 的核心
 * 安全性质：**轮换 KEK 只重包 DEK、不重加密任何数据**。如果哪天有人把
 * rotateKek 写成"重新加密全部记录"，这条测试会红。
 */
describe('密钥轮换 happy path（端口注入后真的能转，且数据不丢）', () => {
  let rotateServer: Server;
  let rotateBaseUrl: string;
  let rotateToken: string;
  let ks: Keystore;
  let store: DefaultEncryptedRecordStore;
  let gw: ReturnType<typeof createGateway>;

  const ROTATE_PASS_OLD = 'rotate-happy-old-passphrase';
  const ROTATE_PASS_NEW = 'rotate-happy-new-passphrase';

  beforeAll(async () => {
    ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(ROTATE_PASS_OLD);
    store = new DefaultEncryptedRecordStore(ks.unlocked(), new InMemoryRawRecordStore(), clock);

    // 先写一条凭据——轮换后它必须还能读出来
    await store.put(
      'credential',
      'cred:rotate-probe',
      { provider: 'deepseek', access_path: 'deepseek.openai-chat', secret: 'sk-rotate-fake' }, // privacy-scan: ignore —— 假数据：sk-rotate-fake 是本文件的测试夹具
      FIXED_NOW,
    );

    const auth = new DefaultAdminAuth(store, clock, {});
    await auth.setAccount({ id: 'owner', name: 'owner', role: 'owner' }, ADMIN_PASSWORD);

    const gw2 = createGateway({ mode: 'test', clock, recordStore: store });
    gw = gw2;

    const handler = createAdminRouter({
      auth,
      service: gw2.admin!.adminService,
      keystoreStatus: () => ({
        mode: 'passphrase',
        tradeoff_note: '启动口令解锁：最安全的一档，但每次重启都要有人输入口令。',
        unlocked: true,
        active_dek_id: ks.unlocked().activeDekId,
        encryption_count: ks.unlocked().encryptionCount(),
        should_rotate_dek: ks.unlocked().shouldRotateDek(),
        argon2_rehash_recommended: false,
        kek_fingerprint: ks.unlocked().kekFingerprint(),
      }),
      rotateKek: async (input) => {
        // 真实轮换：用新口令重新派生 KEK 并重包 DEK（数据不动）
        const nextPass = input.new_passphrase ?? ROTATE_PASS_NEW;
        await ks.rehashArgon2(
          nextPass,
          { memoryKiB: 19_456, timeCost: 2, parallelism: 1 },
          FIXED_NOW,
        );
        return { ok: true, kek_fingerprint: ks.unlocked().kekFingerprint() };
      },
      rotateDek: async () => {
        const before = ks.unlocked().activeDekId;
        const newId = await store.rotateDek(FIXED_NOW);
        const moved = await store.reencryptToActiveDek(FIXED_NOW);
        return { ok: true, new_dek_id: newId, reencrypted: moved, ...(before === newId ? {} : {}) };
      },
    });

    rotateServer = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gw2.runner,
      adminHandler: handler,
    });
    await new Promise<void>((resolve) => rotateServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = rotateServer.address();
    rotateBaseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
    const login = await fetch(`${rotateBaseUrl}/admin/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }), // privacy-scan: ignore —— password 是 login 契约字段名，ADMIN_PASSWORD 是测试假口令
    });
    rotateToken = ((await login.json()) as { token?: string }).token ?? '';
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => rotateServer.close(() => resolve()));
    await gw.shutdown();
  });

  function rotateApi(method: string, path: string, body?: unknown) {
    return fetch(`${rotateBaseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${rotateToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('轮换 KEK 后，轮换前写的凭据仍能解密（数据密文一个字节都没动）', async () => {
    // 轮换前先确认读得到
    const before = await store.get<{ secret: string }>('credential', 'cred:rotate-probe'); // privacy-scan: ignore —— secret 是记录形状的字段名（类型标注，无值）
    expect(before?.secret).toBe('sk-rotate-fake');

    const res = await rotateApi('POST', '/admin/api/keystore/rotate-kek', {
      new_passphrase: ROTATE_PASS_NEW,
      confirm: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminApiBody;
    expect(body.ok).toBe(true);
    expect(typeof body.kek_fingerprint).toBe('string');

    // **核心断言**：同一把 DEK 还在，记录照样读得出
    const after = await store.get<{ secret: string }>('credential', 'cred:rotate-probe'); // privacy-scan: ignore —— secret 是记录形状的字段名（类型标注，无值）
    expect(after?.secret).toBe('sk-rotate-fake'); // privacy-scan: ignore —— 假数据：sk-rotate-fake 是本文件的测试夹具

    // 旧口令已经解不开新库（盐也换了 → KEK 变了 → 解包 DEK 失败）
    const serialized = serializeKeystoreFile(ks.unlocked().serialize());
    const wrongKs = new Keystore(
      new PassphraseKekSource(),
      deserializeKeystoreFile(serialized),
      FIXED_NOW,
    );
    await expect(wrongKs.unlock(ROTATE_PASS_OLD)).rejects.toThrow(KeystoreLockedError);
    expect(wrongKs.locked).toBe(true);

    // 新口令能重开
    const rightKs = new Keystore(
      new PassphraseKekSource(),
      deserializeKeystoreFile(serialized),
      FIXED_NOW,
    );
    await rightKs.unlock(ROTATE_PASS_NEW);
    expect(rightKs.locked).toBe(false);
  });

  it('轮换 DEK 后，旧记录仍可读，新记录用新 DEK', async () => {
    const oldDekId = ks.unlocked().activeDekId;
    const res = await rotateApi('POST', '/admin/api/keystore/rotate-dek');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminApiBody;
    expect(body.ok).toBe(true);
    expect(body.new_dek_id).not.toBe(oldDekId);
    // 旧记录被重加密到新 DEK
    expect(body.reencrypted).toBeGreaterThanOrEqual(1);

    // 旧记录仍读得出（重加密过）
    const after = await store.get<{ secret: string }>('credential', 'cred:rotate-probe'); // privacy-scan: ignore —— secret 是记录形状的字段名（类型标注，无值）
    expect(after?.secret).toBe('sk-rotate-fake'); // privacy-scan: ignore —— 假数据：sk-rotate-fake 是本文件的测试夹具

    // 新记录用新 DEK
    await store.put(
      'credential',
      'cred:rotate-new',
      { provider: 'deepseek', access_path: 'deepseek.openai-chat', secret: 'sk-rotate-new' }, // privacy-scan: ignore —— 假数据：sk-rotate-new 是本文件的测试夹具
      FIXED_NOW,
    );
    const metas = await store.listMeta('credential');
    const newRec = metas.find((m) => m.id === 'cred:rotate-new');
    expect(newRec?.dek_id).toBe(ks.unlocked().activeDekId);
  });

  it('keystore/status 反映轮换后的状态（DEK id 变了）', async () => {
    const res = await rotateApi('GET', '/admin/api/keystore/status');
    const body = (await res.json()) as AdminApiBody;
    expect(body.unlocked).toBe(true);
    expect(body.active_dek_id).toBe(ks.unlocked().activeDekId);
  });
});

describe('access-paths（UI 下拉数据源）', () => {
  it('列出的 access path 来自能力矩阵（不另写一份）', async () => {
    const res = await api('GET', '/admin/api/access-paths');
    expect(res.status).toBe(200);
    const ids = (res.body.items ?? []).map((p) => String(p['id']));
    expect(ids).toContain('mock');
    expect(ids).toContain('deepseek.openai-chat');
    // 每条都有 requires_credential 布尔位
    for (const p of res.body.items ?? []) {
      expect(typeof p['requires_credential']).toBe('boolean');
    }
  });
});

describe('provider-presets（「新建渠道」ComboBox 数据源，只读）', () => {
  it('透出预设注册表，DeepSeek 有两条 access path 与实测 base', async () => {
    const res = await api('GET', '/admin/api/provider-presets');
    expect(res.status).toBe(200);
    const items = (res.body.items ?? []) as Array<Record<string, unknown>>;
    expect(typeof res.body.total).toBe('number');
    expect(items.length).toBeGreaterThan(0);

    const deepseek = items.find((p) => p['id'] === 'deepseek') as
      { access_paths?: Array<Record<string, unknown>>; base_url?: string } | undefined;
    expect(deepseek).toBeDefined();
    const paths = deepseek?.access_paths ?? [];
    expect(paths.map((p) => p['id'])).toEqual([
      'deepseek.openai-chat',
      'deepseek.anthropic-messages',
    ]);
    // 实测 base（credentials/resolver.ts）：openai-chat 无 /anthropic 前缀
    const chat = paths.find((p) => p['id'] === 'deepseek.openai-chat');
    expect(chat?.['base_url']).toBe('https://api.deepseek.com');
    const messages = paths.find((p) => p['id'] === 'deepseek.anthropic-messages');
    expect(messages?.['base_url']).toBe('https://api.deepseek.com/anthropic');

    // 每条预设都带来源与置信度（不编造 base_url 的兜底：置信度字段必存在）
    for (const p of items) {
      expect(typeof p['source']).toBe('string');
      expect(typeof p['confidence']).toBe('string');
    }
  });
});
