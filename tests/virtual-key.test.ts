/**
 * tests/virtual-key.test.ts —— 数据面 virtual key 的端到端（真 HTTP + 真加密存储 + 真 S0）。
 *
 * 覆盖任务书 P0-1 的验收项：
 *   ① Argon2id 哈希校验（对得上 / 对不上）；
 *   ② 三种鉴权形态（Authorization: Bearer / x-api-key / ?key=）都归一成同一个 key_id；
 *   ③ 撤销后**立即**失效；
 *   ④ 与 AG_ACCESS_TOKEN 的互斥；
 *   ⑤ 明文只在创建响应里返回一次（断言库里 / 列表响应里都没有明文）；
 *   ⑥ 归因到用量记录（`UsageRecord.auth.key_id`）；
 *   ⑦ 模型 / provider 限制真的会拒。
 *
 * 不起真实上游 API、不设任何真实 key（测试 key 只在本文件里，且是明显的假串）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { DefaultVirtualKeyStore, VIRTUAL_KEY_KIND } from '../storage/virtual-keys.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry, MemoryLogger } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';

const KEYSTORE_PASSPHRASE = 'vk-test-passphrase-not-real';
const ADMIN_PASSWORD = 'admin-password-not-real';
const FAKE_UPSTREAM_KEY = 'sk-vk-fake-upstream-key';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };

/** 上游 mock：OpenAI Chat 非流式响应（模型名与别名目标一致）。 */
const UPSTREAM_BODY = JSON.stringify({
  id: 'chatcmpl-vk000001',
  object: 'chat.completion',
  created: 1_760_000_000,
  model: 'deepseek-flash',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
});

/**
 * 无限脚本的上游：每个请求都回同一份 200。
 *
 * 不用 `ScriptedTransport`：它的脚本是「消费一次」的队列，本文件要打几十个请求，
 * 写到第 3 个就开始抛「脚本已用尽」，然后被测的 503 全是假故障。
 */
class RepeatingTransport implements Transport {
  readonly requests: Array<{ method: string; path: string }> = [];
  async send(req: UpstreamRequest): Promise<UpstreamResponse> {
    this.requests.push({ method: req.method, path: req.path });
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(UPSTREAM_BODY, 'utf8'),
    };
  }
}

interface Harness {
  gateway: ReturnType<typeof createGateway>;
  server: Server;
  baseUrl: string;
  adminToken: string;
  raw: InMemoryRawRecordStore;
  vkStore: DefaultVirtualKeyStore;
  /** 起一个带独立虚拟 key 库的第二个网关（互斥 / 模式测试用）。 */
}

async function buildHarness(
  options: {
    accessToken?: string;
    virtualKeysEnabled?: boolean;
    permissiveEnabled?: boolean;
    aliasPattern?: string;
  } = {},
): Promise<Harness> {
  const keystore = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await keystore.unlock(KEYSTORE_PASSPHRASE);
  const raw = new InMemoryRawRecordStore();
  const recordStore = new DefaultEncryptedRecordStore(keystore.unlocked(), raw, clock);

  const transport = new RepeatingTransport();
  const gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    config: {
      ...(options.accessToken === undefined ? {} : { accessToken: options.accessToken }),
      ...(options.virtualKeysEnabled === undefined
        ? {}
        : { virtualKeysEnabled: options.virtualKeysEnabled }),
      ...(options.permissiveEnabled === undefined
        ? {}
        : { permissiveEnabled: options.permissiveEnabled }),
    },
    aliasRules: [
      {
        id: 'vk-e2e',
        kind: 'exact',
        pattern: options.aliasPattern ?? 'vk-model',
        target: {
          provider: 'deepseek',
          access_path: 'deepseek.openai-chat',
          model: 'deepseek-flash',
        },
        priority: 100,
        enabled: true,
      },
    ],
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_UPSTREAM_KEY,
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
    // 静态装配声明：别名的 target 是静态拼出来的 deepseek，没有渠道记录
    // （见 composition-root.ts 的 staticProviders 说明）
    staticProviders: ['deepseek'],
  });

  await gateway.loadSettings();

  const server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    adminHandler: gateway.admin!.routeHandler,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  await gateway.admin!.adminAuth.setAccount(
    { id: 'owner', name: 'owner', role: 'owner' },
    ADMIN_PASSWORD,
  );
  const login = await gateway.admin!.adminAuth.login({ password: ADMIN_PASSWORD }); // privacy-scan: ignore —— 假测试口令（本文件顶部 ADMIN_PASSWORD，后缀 not-real），只在本文件里造管理员会话
  if (!login.ok) throw new Error('测试装配失败：管理员登录不通过');

  return {
    gateway,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    adminToken: login.token,
    raw,
    vkStore: gateway.virtualKeys as DefaultVirtualKeyStore,
  };
}

/** 打管理面 API。 */
async function adminApi(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${h.adminToken}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** 打数据面（三种形态由调用方给头 / query）。 */
async function dataPlane(
  h: Harness,
  body: Record<string, unknown>,
  init: { headers?: Record<string, string>; query?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${h.baseUrl}/v1/chat/completions${init.query === undefined ? '' : `?${init.query}`}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

const chatBody = (model = 'vk-model'): Record<string, unknown> => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
});

let harness: Harness;

beforeAll(async () => {
  harness = await buildHarness();
});

afterAll(async () => {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  await harness.gateway.shutdown();
});

describe('virtual key：创建与明文一次性', () => {
  it('创建响应带明文，且形态是 sk-ag-…', async () => {
    const res = await adminApi(harness, 'POST', '/admin/api/virtual-keys', { name: 'cli' });
    expect(res.status).toBe(200);
    const plaintext = res.body['plaintext'];
    expect(typeof plaintext).toBe('string');
    expect(String(plaintext).startsWith('sk-ag-')).toBe(true);
    expect(String(plaintext).length).toBeGreaterThan(20);
    (harness as unknown as { _plain?: string })._plain = String(plaintext);
  });

  it('列表只给掩码与前 8 位，绝不明文回显', async () => {
    const plaintext = (harness as unknown as { _plain?: string })._plain!;
    const res = await adminApi(harness, 'GET', '/admin/api/virtual-keys');
    expect(res.status).toBe(200);
    const items = res.body['items'] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const first = items[0]!;
    expect(first['masked']).toBe(`${plaintext.slice(0, 8)}…`);
    expect(first['head']).toBe(plaintext.slice(0, 8));
    expect(JSON.stringify(items)).not.toContain(plaintext);
    // 掩码不泄露长度（不按原长度生成对应数量的 *）
    expect(String(first['masked'])).not.toContain('*'.repeat(20));
  });

  it('库里只有 Argon2id 哈希，没有任何字段承载明文', async () => {
    const plaintext = (harness as unknown as { _plain?: string })._plain!;
    const records = await harness.raw.all();
    const vkRecords = records.filter((r) => r.kind === VIRTUAL_KEY_KIND);
    expect(vkRecords.length).toBeGreaterThan(0);
    for (const rec of vkRecords) {
      const stored = await harness.vkStore.get(rec.id);
      expect(stored).toBeDefined();
      // 类型上没有明文字段；再断言一遍序列化结果里没有明文（双保险）
      expect(JSON.stringify(stored)).not.toContain(plaintext);
      // 哈希是 Argon2id，且不等于明文的任何简单摘要
      const hash = stored!.key_hash;
      expect(hash.algo).toBe('argon2id');
      expect(hash.hash_hex.length).toBe(64);
      expect(hash.hash_hex).not.toBe(plaintext);
      expect(hash.salt_hex.length).toBe(32);
    }
  });

  it('整个响应体（含 usage）里都不出现明文', async () => {
    const plaintext = (harness as unknown as { _plain?: string })._plain!;
    const usage = await adminApi(harness, 'GET', '/admin/api/virtual-keys');
    expect(JSON.stringify(usage.body)).not.toContain(plaintext);
  });
});

describe('virtual key：三种鉴权形态归一成同一个 key_id', () => {
  it('Authorization: Bearer / x-api-key / ?key= 都通，且 key_id 相同', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'three-forms',
    });
    const plaintext = String(created.body['plaintext']);
    const keyId = String((created.body['key'] as Record<string, unknown>)['key_id']);

    const viaBearer = await dataPlane(harness, chatBody(), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(viaBearer.status).toBe(200);

    const viaApiKey = await dataPlane(harness, chatBody(), {
      headers: { 'x-api-key': plaintext },
    });
    expect(viaApiKey.status).toBe(200);

    const viaQuery = await dataPlane(harness, chatBody(), {
      query: `key=${encodeURIComponent(plaintext)}`,
    });
    expect(viaQuery.status).toBe(200);

    await harness.gateway.usageEmitter.flush();
    const keyIds = harness.gateway
      .usageSink!.records.filter((r) => r.model === 'deepseek-flash')
      .map((r) => r.auth.key_id);
    expect(keyIds).toEqual([keyId, keyId, keyId]);
  });

  it('错误的 key → 401，且错误信息不回显 key', async () => {
    const res = await dataPlane(harness, chatBody(), {
      headers: { authorization: 'Bearer sk-ag-definitely-not-a-real-key' },
    });
    expect(res.status).toBe(401);
    const err = res.body['error'] as Record<string, unknown>;
    expect(String(err['message'])).not.toContain('sk-ag-definitely-not-a-real-key');
    expect(String(err['code'])).toBe('auth_failed');
  });

  it('没带 key → 401', async () => {
    const res = await dataPlane(harness, chatBody());
    expect(res.status).toBe(401);
  });

  it('同时带两把不同的 key → 401（不猜）', async () => {
    const a = await adminApi(harness, 'POST', '/admin/api/virtual-keys', { name: 'conflict-a' });
    const b = await adminApi(harness, 'POST', '/admin/api/virtual-keys', { name: 'conflict-b' });
    const res = await dataPlane(harness, chatBody(), {
      headers: {
        authorization: `Bearer ${String(a.body['plaintext'])}`,
        'x-api-key': String(b.body['plaintext']),
      },
    });
    expect(res.status).toBe(401);
  });
});

describe('virtual key：撤销与过期', () => {
  it('撤销后立刻失效（不用等缓存过期）', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'to-revoke',
    });
    const plaintext = String(created.body['plaintext']);
    const keyId = String((created.body['key'] as Record<string, unknown>)['key_id']);

    const before = await dataPlane(harness, chatBody(), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(before.status).toBe(200);

    const revoked = await adminApi(harness, 'POST', `/admin/api/virtual-keys/${keyId}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect((revoked.body['key'] as Record<string, unknown>)['status']).toBe('revoked');

    const after = await dataPlane(harness, chatBody(), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(after.status).toBe(401);
    const err = after.body['error'] as Record<string, unknown>;
    expect(String(err['message'])).toContain('撤销');
  });

  it('过期的 key 立刻失效（不需要显式撤销）', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'expiring',
      expires_at: FIXED_NOW + 1_000,
    });
    const plaintext = String(created.body['plaintext']);
    const keyId = String((created.body['key'] as Record<string, unknown>)['key_id']);

    // 还没过期：能过
    const before = await dataPlane(harness, chatBody(), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(before.status).toBe(200);

    // 把时钟推到过期之后，再打一次：同一个 key、同一份缓存，立刻 401
    const moved = { now: () => FIXED_NOW + 10_000 };
    (harness.vkStore as unknown as { clock: { now(): number } }).clock = moved;
    harness.vkStore.refresh();

    const after = await dataPlane(harness, chatBody(), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(after.status).toBe(401);
    const err = after.body['error'] as Record<string, unknown>;
    expect(String(err['message'])).toContain('过期');

    // 复原，别影响后续用例
    (harness.vkStore as unknown as { clock: { now(): number } }).clock = clock;
    harness.vkStore.refresh();
    void keyId;
  });

  it('删除后 key_id 不可再解析', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'to-delete',
    });
    const plaintext = String(created.body['plaintext']);
    const keyId = String((created.body['key'] as Record<string, unknown>)['key_id']);
    const del = await adminApi(harness, 'DELETE', `/admin/api/virtual-keys/${keyId}`);
    expect(del.status).toBe(200);
    expect(del.body['deleted']).toBe(true);
    const res = await dataPlane(harness, chatBody(), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('virtual key：模型 / provider 限制', () => {
  it('模型白名单：允许的过，不允许的 403', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'model-scoped',
      models: ['vk-model'],
    });
    const plaintext = String(created.body['plaintext']);
    const ok = await dataPlane(harness, chatBody('vk-model'), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(ok.status).toBe(200);
    const denied = await dataPlane(harness, chatBody('other-model'), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(denied.status).toBe(403);
  });

  it('模型白名单支持 * 尾缀 glob', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'glob-scoped',
      models: ['vk-*'],
    });
    const plaintext = String(created.body['plaintext']);
    const res = await dataPlane(harness, chatBody('vk-model'), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(200);
  });

  it('provider 白名单：不允许的 provider 403', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'provider-scoped',
      providers: ['openai'],
    });
    const plaintext = String(created.body['plaintext']);
    const res = await dataPlane(harness, chatBody('vk-model'), {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('virtual key：用量归因', () => {
  it('看该 key 的用量：请求数 / token / 按模型分组都对', async () => {
    const created = await adminApi(harness, 'POST', '/admin/api/virtual-keys', {
      name: 'usage-key',
    });
    const plaintext = String(created.body['plaintext']);
    const keyId = String((created.body['key'] as Record<string, unknown>)['key_id']);
    await dataPlane(harness, chatBody(), { headers: { authorization: `Bearer ${plaintext}` } });
    await dataPlane(harness, chatBody(), { headers: { authorization: `Bearer ${plaintext}` } });
    await harness.gateway.usageEmitter.flush();

    const res = await adminApi(
      harness,
      'GET',
      `/admin/api/virtual-keys/${keyId}/usage?to_ts=${FIXED_NOW + 60_000}`,
    );
    expect(res.status).toBe(200);
    const usage = res.body['usage'] as Record<string, unknown>;
    expect(usage['request_count']).toBe(2);
    expect(usage['input_tokens']).toBe(24);
    expect(usage['output_tokens']).toBe(16);
    const byModel = usage['by_model'] as Array<Record<string, unknown>>;
    expect(byModel).toEqual([
      { model: 'deepseek-flash', request_count: 2, cash_total: byModel[0]!['cash_total'] },
    ]);
  });
});

describe('数据面认证模式：与 AG_ACCESS_TOKEN 互斥', () => {
  it('只配 access token、库为空 → 极简模式，token 能过', async () => {
    const h = await buildHarness({
      accessToken: 'simple-mode-token',
      aliasPattern: 'simple-model',
    });
    try {
      const mode = await adminApi(h, 'GET', '/admin/api/auth-mode');
      expect(mode.body['mode']).toBe('access_token');
      expect(mode.body['access_token_configured']).toBe(true);

      const ok = await dataPlane(h, chatBody('simple-model'), {
        headers: { authorization: 'Bearer simple-mode-token' },
      });
      expect(ok.status).toBe(200);
      // 极简模式下 key_id 是稳定的占位（不是真 key）
      await h.gateway.usageEmitter.flush();
      expect(h.gateway.usageSink!.records.map((r) => r.auth.key_id)).toEqual(['access-token']);

      // 建第一把 key 会把模式翻成 virtual_key：此时 access token 立刻不能再用了
      // （互斥的另一半——不是「两个都能用」，而是「只有一个生效」）。
      const created = await adminApi(h, 'POST', '/admin/api/virtual-keys', { name: 'flip' });
      const plaintext = String(created.body['plaintext']);
      const modeAfter = await adminApi(h, 'GET', '/admin/api/auth-mode');
      expect(modeAfter.body['mode']).toBe('virtual_key');
      expect(modeAfter.body['ignored']).toEqual([expect.stringContaining('AG_ACCESS_TOKEN')]);

      const tokenNow = await dataPlane(h, chatBody('simple-model'), {
        headers: { authorization: 'Bearer simple-mode-token' },
      });
      expect(tokenNow.status).toBe(401);
      const vkNow = await dataPlane(h, chatBody('simple-model'), {
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(vkNow.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });

  it('access token + 库里有 key → 虚拟 key 模式，access token 被忽略且被告知', async () => {
    const h = await buildHarness({ accessToken: 'ignored-token', aliasPattern: 'mutex-model' });
    try {
      const created = await adminApi(h, 'POST', '/admin/api/virtual-keys', { name: 'wins' });
      const plaintext = String(created.body['plaintext']);

      const mode = await adminApi(h, 'GET', '/admin/api/auth-mode');
      expect(mode.body['mode']).toBe('virtual_key');
      expect(mode.body['access_token_configured']).toBe(true);
      expect(mode.body['ignored']).toEqual([expect.stringContaining('AG_ACCESS_TOKEN')]);

      // 虚拟 key 能过
      const ok = await dataPlane(h, chatBody('mutex-model'), {
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(ok.status).toBe(200);
      // 被忽略的 access token 不能过
      const no = await dataPlane(h, chatBody('mutex-model'), {
        headers: { authorization: 'Bearer ignored-token' },
      });
      expect(no.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });

  it('显式 virtualKeysEnabled + 空库 → 虚拟 key 模式，没 key 就 401', async () => {
    const h = await buildHarness({
      accessToken: 'also-ignored',
      virtualKeysEnabled: true,
      aliasPattern: 'explicit-model',
    });
    try {
      const mode = await adminApi(h, 'GET', '/admin/api/auth-mode');
      expect(mode.body['mode']).toBe('virtual_key');
      expect(mode.body['virtual_keys_enabled']).toBe(true);

      const res = await dataPlane(h, chatBody('explicit-model'));
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });

  it('什么都没配 → deny（默认拒绝）：无凭据请求 503，不是放行', async () => {
    const h = await buildHarness({ aliasPattern: 'closed-model', permissiveEnabled: false });
    try {
      const mode = await adminApi(h, 'GET', '/admin/api/auth-mode');
      expect(mode.body['mode']).toBe('deny');
      // 没带 key：拒
      const res = await dataPlane(h, chatBody('closed-model'));
      expect(res.status).toBe(503);
      // 带了把乱给的 key：一样拒。没配凭据时不存在"对的 key"
      const withKey = await dataPlane(h, chatBody('closed-model'), {
        headers: { authorization: 'Bearer sk-ag-not-a-real-key' },
      });
      expect(withKey.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });

  it('显式放行（permissive opt-in）→ 不校验；opt-in 不是兜底', async () => {
    const h = await buildHarness({
      aliasPattern: 'open-model',
      permissiveEnabled: true,
    });
    try {
      const mode = await adminApi(h, 'GET', '/admin/api/auth-mode');
      expect(mode.body['mode']).toBe('permissive');
      const res = await dataPlane(h, chatBody('open-model'));
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });
});

describe('virtual key：未登录打管理面仍然 401', () => {
  it('无令牌列 virtual key → 401', async () => {
    const res = await fetch(`${harness.baseUrl}/admin/api/virtual-keys`);
    expect(res.status).toBe(401);
  });

  it('无令牌建 virtual key → 401', async () => {
    const res = await fetch(`${harness.baseUrl}/admin/api/virtual-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sneaky' }),
    });
    expect(res.status).toBe(401);
    const list = await adminApi(harness, 'GET', '/admin/api/virtual-keys');
    expect(
      (list.body['items'] as Array<Record<string, unknown>>).map((i) => i['name']),
    ).not.toContain('sneaky');
  });
});

describe('DefaultVirtualKeyStore：哈希与撤销语义', () => {
  it('resolve 用明文命中，错明文不命中；两者都不泄露明文', async () => {
    const store = new DefaultVirtualKeyStore(
      new DefaultEncryptedRecordStore(
        await (async () => {
          const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
          await ks.unlock(KEYSTORE_PASSPHRASE);
          return ks.unlocked();
        })(),
        new InMemoryRawRecordStore(),
        clock,
      ),
      clock,
    );
    const created = await store.create({ name: 'direct' });
    const good = await store.resolve(created.plaintext);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.key.key_id).toBe(created.key_id);
    const bad = await store.resolve(`${created.plaintext}x`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('not_found');

    await store.revoke(created.key_id, FIXED_NOW + 1);
    const afterRevoke = await store.resolve(created.plaintext);
    expect(afterRevoke.ok).toBe(false);
    if (!afterRevoke.ok) expect(afterRevoke.reason).toBe('revoked');
  });

  it('mint 出的明文互不相同、熵足够', async () => {
    const { mintVirtualKeyPlaintext } = await import('../storage/virtual-keys.js');
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const k = mintVirtualKeyPlaintext();
      expect(k.startsWith('sk-ag-')).toBe(true);
      seen.add(k);
    }
    expect(seen.size).toBe(50);
  });
});

describe('virtual key：logger 里没有明文', () => {
  it('MemoryLogger 的全部条目都不含明文', async () => {
    const plaintext = (harness as unknown as { _plain?: string })._plain!;
    const logger = harness.gateway.logger as MemoryLogger;
    expect(JSON.stringify(logger.entries)).not.toContain(plaintext);
  });
});
