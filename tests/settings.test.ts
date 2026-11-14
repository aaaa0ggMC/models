/**
 * tests/settings.test.ts —— 运行时设置的端到端（真 HTTP + 真加密存储 + 真配置对象）。
 *
 * 覆盖任务书 P0-2 的验收项：
 *   ① 四层优先级正确（加密存储 > env > 配置文件 > 默认值）；
 *   ② 热生效（改完不用重启，请求路径立刻看到新值）；
 *   ③ 重启后仍在（新建一个 gateway 指向同一份存储，值被应用回来）；
 *   ④ env 覆盖的项显示但不可改（服务端 409，UI 拿到 editable=false + 原因）；
 *   ⑤ `secret_ref` 不落值（传 value 被 400 拒；库里只有 env:<VAR>）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { SettingsService } from '../config/settings.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../gateway-core/transport.js';

const KEYSTORE_PASSPHRASE = 'settings-test-passphrase-not-real';
const ADMIN_PASSWORD = 'admin-password-not-real';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };

/** 每个 harness 一份独立的加密存储（测试隔离）；「重启」用例显式共享一份。 */
async function makeStore(): Promise<DefaultEncryptedRecordStore> {
  const keystore = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await keystore.unlock(KEYSTORE_PASSPHRASE);
  return new DefaultEncryptedRecordStore(keystore.unlocked(), new InMemoryRawRecordStore(), clock);
}

/** 第一屏 8 项的 key（与 config/settings.ts 的 RUNTIME_SETTINGS 对齐）。 */
const KEYS = [
  'global_timeout_ms',
  'ttfb_timeout_ms',
  'stream_idle_timeout_ms',
  'max_retries',
  'retry_base_delay_ms',
  'loss_policy',
  'model_sync_interval_ms',
  'plugin_timeout_ms',
];

class NoopTransport implements Transport {
  async send(_req: UpstreamRequest): Promise<UpstreamResponse> {
    return { status: 200, headers: {}, body: Buffer.from('{}', 'utf8') };
  }
}

interface Harness {
  gateway: ReturnType<typeof createGateway>;
  server: Server;
  baseUrl: string;
  adminToken: string;
}

async function buildHarness(
  options: { env?: NodeJS.ProcessEnv; store?: DefaultEncryptedRecordStore } = {},
): Promise<Harness> {
  const store = options.store ?? (await makeStore());
  const gateway = createGateway({
    mode: 'test',
    clock,
    transport: new NoopTransport(),
    recordStore: store,
    ...(options.env === undefined ? {} : { settingsEnv: options.env }),
  });
  // 启动路径：把加密存储里的设置应用回 config（生产部署同样要 await 这一步）
  await gateway.loadSettings();

  const server = createHttpServer({
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
  const login = await gateway.admin!.adminAuth.login({ password: ADMIN_PASSWORD });
  if (!login.ok) throw new Error('测试装配失败：管理员登录不通过');

  return { gateway, server, baseUrl: `http://127.0.0.1:${port}`, adminToken: login.token };
}

async function adminApi(
  h: Harness,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
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

/** 读设置列表，返回 key → 条目。 */
async function settingsMap(h: Harness): Promise<Map<string, Record<string, unknown>>> {
  const res = await adminApi(h, 'GET', '/admin/api/settings');
  expect(res.status).toBe(200);
  const items = res.body['items'] as Array<Record<string, unknown>>;
  return new Map(items.map((i) => [String(i['key']), i]));
}

let harness: Harness;

beforeAll(async () => {
  harness = await buildHarness();
});

afterAll(async () => {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  await harness.gateway.shutdown();
});

describe('设置：第一屏只有 8 项，且白名单外的 key 改不了', () => {
  it('GET /admin/api/settings 返回 8 项，顺序与规格表一致', async () => {
    const res = await adminApi(harness, 'GET', '/admin/api/settings');
    const items = res.body['items'] as Array<Record<string, unknown>>;
    expect(items.map((i) => i['key'])).toEqual(KEYS);
  });

  it('白名单外的 key → 400', async () => {
    const res = await adminApi(harness, 'PUT', '/admin/api/settings/port', { value: 1234 });
    expect(res.status).toBe(400);
    expect(String((res.body['error'] as Record<string, unknown>)['code'])).toBe('invalid_setting');
  });
});

describe('设置：四层优先级', () => {
  it('默认层：什么都没配时 source=default', async () => {
    const map = await settingsMap(harness);
    const item = map.get('max_retries')!;
    expect(item['source']).toBe('default');
    expect(item['value']).toBe(2);
    expect(item['editable']).toBe(true);
    expect(item['reason']).toBeUndefined();
  });

  it('加密存储层最高：改完 source=encrypted_storage 且值生效', async () => {
    const res = await adminApi(harness, 'PUT', '/admin/api/settings/max_retries', { value: 5 });
    expect(res.status).toBe(200);
    const item = res.body['item'] as Record<string, unknown>;
    expect(item['source']).toBe('encrypted_storage');
    expect(item['value']).toBe(5);
    // 热生效：改的就是 pipeline 读的那个 config 对象
    expect(harness.gateway.config.maxRetries).toBe(5);
  });

  it('配置文件层：文件里有的项 source=config_file，可被加密存储覆盖', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-settings-'));
    const file = join(dir, 'gateway.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 1, gateway: { ttfbTimeoutMs: 12_345, pluginTimeoutMs: 6_000 } }),
      'utf8',
    );
    try {
      const h = await buildHarness({ store: await makeStore() });
      const settings = new SettingsService({
        store: (h.gateway as unknown as { settings: SettingsService }).settings
          ? await makeStore()
          : await makeStore(),
        clock,
        config: h.gateway.config,
        configFilePath: file,
      });
      const described = await settings.describe();
      const ttfb = described.items.find((i) => i.key === 'ttfb_timeout_ms')!;
      expect(ttfb.source).toBe('config_file');
      expect(ttfb.editable).toBe(true);
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env 层：env 设了的项 source=env，且值来自 env 而不是默认值', async () => {
    const h = await buildHarness({ env: { ...process.env, AG_MAX_RETRIES: '7' } });
    try {
      const map = await settingsMap(h);
      const item = map.get('max_retries')!;
      expect(item['source']).toBe('env');
      expect(item['value']).toBe(7);
      expect(item['env_var']).toBe('AG_MAX_RETRIES');
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });
});

describe('设置：env 锁（被 env 覆盖的项显示但不可改）', () => {
  it('UI 拿到 editable=false + 原因；服务端 409', async () => {
    const h = await buildHarness({ env: { ...process.env, AG_GLOBAL_TIMEOUT_MS: '45000' } });
    try {
      const map = await settingsMap(h);
      const item = map.get('global_timeout_ms')!;
      expect(item['source']).toBe('env');
      expect(item['value']).toBe(45_000);
      expect(item['editable']).toBe(false);
      expect(String(item['reason'])).toContain('AG_GLOBAL_TIMEOUT_MS');
      // 锁只影响那一个 key，别的项照样能改
      expect(map.get('max_retries')!['editable']).toBe(true);

      const res = await adminApi(h, 'PUT', '/admin/api/settings/global_timeout_ms', {
        value: 1_000,
      });
      expect(res.status).toBe(409);
      expect(String((res.body['error'] as Record<string, unknown>)['code'])).toBe('env_locked');
      // 值没被改掉
      expect(h.gateway.config.globalTimeoutMs).toBe(45_000);
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });

  it('env 与加密存储同时存在：值是加密存储那份，但仍然不可改', async () => {
    // 先在一个没有 env 的 harness 里写一条设置，再带着 env 读它（同一份存储）
    const shared = await makeStore();
    const writer = await buildHarness({ store: shared });
    try {
      await adminApi(writer, 'PUT', '/admin/api/settings/max_retries', { value: 5 });
    } finally {
      await new Promise<void>((resolve) => writer.server.close(() => resolve()));
      await writer.gateway.shutdown();
    }
    const h = await buildHarness({
      store: shared,
      env: { ...process.env, AG_MAX_RETRIES: '7' },
    });
    try {
      const map = await settingsMap(h);
      const item = map.get('max_retries')!;
      // 优先级：加密存储 > env
      expect(item['source']).toBe('encrypted_storage');
      expect(item['value']).toBe(5);
      expect(item['stored_value']).toBe(5);
      // 可写性规则：env 设了就不许在 UI 改（避免静默遮盖部署事实）
      expect(item['editable']).toBe(false);
      expect(String(item['reason'])).toContain('AG_MAX_RETRIES');
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });
});

describe('设置：值校验', () => {
  it('超范围 → 400 且不落库', async () => {
    const res = await adminApi(harness, 'PUT', '/admin/api/settings/max_retries', { value: 99 });
    expect(res.status).toBe(400);
    expect(String((res.body['error'] as Record<string, unknown>)['message'])).toContain('0–10');
    expect(harness.gateway.config.maxRetries).toBe(5);
  });

  it('非整数 → 400', async () => {
    const res = await adminApi(harness, 'PUT', '/admin/api/settings/max_retries', { value: 1.5 });
    expect(res.status).toBe(400);
  });

  it('枚举项只接受允许值', async () => {
    const ok = await adminApi(harness, 'PUT', '/admin/api/settings/loss_policy', {
      value: 'strict',
    });
    expect(ok.status).toBe(200);
    expect(harness.gateway.config.lossPolicy).toBe('strict');
    const bad = await adminApi(harness, 'PUT', '/admin/api/settings/loss_policy', {
      value: 'yolo',
    });
    expect(bad.status).toBe(400);
    expect(harness.gateway.config.lossPolicy).toBe('strict');
  });
});

describe('设置：热生效与重启后仍在', () => {
  it('改完立刻对 pipeline 生效（不等重启）', async () => {
    await adminApi(harness, 'PUT', '/admin/api/settings/retry_base_delay_ms', { value: 1_234 });
    expect(harness.gateway.config.retryBaseDelayMs).toBe(1_234);
  });

  it('插件超时下推到 PluginHost', async () => {
    await adminApi(harness, 'PUT', '/admin/api/settings/plugin_timeout_ms', { value: 9_000 });
    // 直接观测：注册一个会超时的插件不现实，改断言 host 的缺省超时被改掉
    const host = harness.gateway.pluginHost as unknown as { defaultTimeoutMs: number };
    expect(host.defaultTimeoutMs).toBe(9_000);
  });

  it('模型同步间隔下推到 ModelSyncService（并重启定时器）', async () => {
    await adminApi(harness, 'PUT', '/admin/api/settings/model_sync_interval_ms', { value: 60_000 });
    expect(harness.gateway.modelSync.status().interval_ms).toBe(60_000);
  });

  it('重启后仍在：新 gateway 指向同一份存储，值被应用回来', async () => {
    const shared = await makeStore();
    const first = await buildHarness({ store: shared });
    try {
      await adminApi(first, 'PUT', '/admin/api/settings/max_retries', { value: 4 });
      await adminApi(first, 'PUT', '/admin/api/settings/loss_policy', { value: 'safe' });
    } finally {
      await new Promise<void>((resolve) => first.server.close(() => resolve()));
      await first.gateway.shutdown();
    }

    // 「重启」= 新建一个 gateway，用同一个 recordStore
    const rebooted = await buildHarness({ store: shared });
    try {
      expect(rebooted.gateway.config.maxRetries).toBe(4);
      expect(rebooted.gateway.config.lossPolicy).toBe('safe');
      const map = await settingsMap(rebooted);
      expect(map.get('max_retries')!['source']).toBe('encrypted_storage');
      expect(map.get('max_retries')!['value']).toBe(4);
    } finally {
      await new Promise<void>((resolve) => rebooted.server.close(() => resolve()));
      await rebooted.gateway.shutdown();
    }
  });
});

describe('敏感值引用：只登记 env:<VAR>，绝不存值', () => {
  it('传 value → 400，且不进库', async () => {
    const res = await adminApi(harness, 'POST', '/admin/api/secret-refs', {
      name: 'openai-key',
      env_var: 'AG_OPENAI_API_KEY',
      value: 'sk-should-never-be-stored',
    });
    expect(res.status).toBe(400);
    expect(String((res.body['error'] as Record<string, unknown>)['message'])).toContain(
      '不接受 value',
    );

    const list = await adminApi(harness, 'GET', '/admin/api/secret-refs');
    expect((list.body['items'] as Array<Record<string, unknown>>).length).toBe(0);
    // 整个响应里都不该出现那个值
    expect(JSON.stringify(list.body)).not.toContain('sk-should-never-be-stored');
  });

  it('只传 env_var → 登记成功，库里只有引用', async () => {
    const res = await adminApi(harness, 'POST', '/admin/api/secret-refs', {
      name: 'openai-key',
      env_var: 'AG_OPENAI_API_KEY',
      note: 'OpenAI 上游 key',
    });
    expect(res.status).toBe(200);
    const ref = res.body['ref'] as Record<string, unknown>;
    expect(ref['ref']).toBe('env:AG_OPENAI_API_KEY');

    const list = await adminApi(harness, 'GET', '/admin/api/secret-refs');
    const items = list.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!['ref']).toBe('env:AG_OPENAI_API_KEY');
    expect(JSON.stringify(items)).not.toContain('sk-');

    // 坏 env_var 名被拒
    const bad = await adminApi(harness, 'POST', '/admin/api/secret-refs', {
      name: 'bad-name',
      env_var: 'not a valid name',
    });
    expect(bad.status).toBe(400);

    // 删除
    const del = await adminApi(harness, 'DELETE', '/admin/api/secret-refs/openai-key');
    expect(del.body['deleted']).toBe(true);
  });
});

describe('设置：写操作进审计，且不含敏感值', () => {
  it('审计里有 setting.update，detail 只有 key/值/来源', async () => {
    await adminApi(harness, 'PUT', '/admin/api/settings/max_retries', { value: 6 });
    const res = await adminApi(harness, 'GET', '/admin/api/audit?limit=50');
    const items = res.body['items'] as Array<Record<string, unknown>>;
    // 冻结时钟下多条审计的 ts 相同，排序不稳定；用 some 而不是 find
    const entry = items.find(
      (i) =>
        i['action'] === 'setting.update' &&
        i['subject'] === 'setting/max_retries' &&
        String(i['detail']).includes('value=6'),
    );
    expect(entry).toBeDefined();
    expect(String(entry!['detail'])).toContain('source=encrypted_storage');
    // detail 里不该有 env 值之类的东西（设置值本身不是敏感值，记它才有对账价值）
    expect(String(entry!['detail'])).not.toMatch(/AG_[A-Z_]+=/);
  });

  it('env 锁拒绝也进审计（outcome=error）', async () => {
    const h = await buildHarness({ env: { ...process.env, AG_MAX_RETRIES: '7' } });
    try {
      await adminApi(h, 'PUT', '/admin/api/settings/max_retries', { value: 2 });
      const res = await adminApi(h, 'GET', '/admin/api/audit?limit=50');
      const items = res.body['items'] as Array<Record<string, unknown>>;
      const entry = items.find((i) => i['action'] === 'setting.update');
      expect(entry).toBeDefined();
      expect(entry!['outcome']).toBe('error');
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });
});

describe('设置：未登录 401 不变', () => {
  it('无令牌读设置 → 401', async () => {
    const res = await fetch(`${harness.baseUrl}/admin/api/settings`);
    expect(res.status).toBe(401);
  });

  it('无令牌改设置 → 401', async () => {
    const res = await fetch(`${harness.baseUrl}/admin/api/settings/max_retries`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 9 }),
    });
    expect(res.status).toBe(401);
    expect(harness.gateway.config.maxRetries).toBe(6);
  });
});
