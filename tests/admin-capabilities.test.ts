/**
 * tests/admin-capabilities.test.ts —— 管理面能力矩阵端点与 `/v1/models` 的**同源**回归。
 *
 * 背景（本轮修的 bug）：管理面「模型目录」页走 `GET /admin/api/capabilities`，而该路由
 * 早先直通 `capabilityRegistry.list()`——上一轮加在 catalog 层的可用性过滤与 internal
 * 标记一条都没过。结果是同一个部署里，`/v1/models` 干净（4 个模型），管理面列着 10 条
 * （mock 脚手架 + 没配 key 的 provider），状态还全是绿色「可用」。
 *
 * 本文件守两条不容退化的约定：
 *
 * 1. **过滤行为同源**：两个端点挂在**同一个网关上**、同一个 `providerAvailability`
 *    端口实例上，默认清单的模型集合必须相同；`?all=1` 与 `/v1/models` 的
 *    `include_unconfigured + include_internal`  likewise。任一边偷偷改判据，这里红。
 * 2. **状态诚实**：全量模式下被隐藏的两类条目必须带标注回来（`internal` /
 *    `availability: 'unconfigured'`），不许让调不通的条目看起来可用。
 *
 * 全部离线：上游不联网，凭据由注入的 env 字面量提供（假 key，只用于让 DeepSeek 处于
 * 「已配置」状态）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};
import { createModelsEndpoints } from '../http/models-endpoint.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { DefaultEncryptedRecordStore, InMemoryRawRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';

const KEYSTORE_PASSPHRASE = 'capabilities-test-passphrase-not-real';
const ADMIN_PASSWORD = 'capabilities-admin-password-not-real';
/** 假 key：只用于让 EnvCredentialResolver 把 deepseek 登记成「已配置」（值不进任何断言）。 */
const FAKE_DEEPSEEK_KEY = 'sk-test-not-a-real-key';
const FIXED_NOW = 1_800_000_000_000;

let server: Server;
let baseUrl: string;
let adminToken: string;
let gateway: ReturnType<typeof createGateway>;

/** 打管理面 API（带会话令牌）。 */
async function adminApi(path: string): Promise<{
  status: number;
  body: { items?: Array<Record<string, unknown>>; error?: { code?: string } };
}> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const body = (await res.json()) as {
    items?: Array<Record<string, unknown>>;
    error?: { code?: string };
  };
  return { status: res.status, body };
}

/** 响应里的模型集合（去重、排序——集合比较，不管条目顺序）。 */
function modelSet(items: Array<Record<string, unknown>> | undefined): string[] {
  return [...new Set((items ?? []).map((e) => String(e['model'])))].sort();
}

beforeAll(async () => {
  const keystore = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await keystore.unlock(KEYSTORE_PASSPHRASE);
  const recordStore = new DefaultEncryptedRecordStore(
    keystore.unlocked(),
    new InMemoryRawRecordStore(),
    { now: () => FIXED_NOW },
  );

  gateway = createGateway({
    mode: 'test',
    clock: { now: () => FIXED_NOW },
    recordStore,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
    }),
  });

  await gateway.admin!.adminAuth.setAccount(
    { id: 'owner', name: 'owner', role: 'owner' },
    ADMIN_PASSWORD,
  );

  server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    adminHandler: gateway.admin!.routeHandler,
    models: createModelsEndpoints({ catalog: gateway.models, sync: gateway.modelSync }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const login = await fetch(`${baseUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }), // privacy-scan: ignore —— password 是 login 契约字段名，ADMIN_PASSWORD 是测试假口令
  });
  adminToken = ((await login.json()) as { token?: string }).token ?? '';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.shutdown();
});

describe('管理面能力矩阵：默认按部署态过滤', () => {
  it('未配置 provider 与 mock 脚手架默认不出现', async () => {
    const res = await adminApi('/admin/api/capabilities');
    expect(res.status).toBe(200);
    const models = modelSet(res.body.items);
    // 这个网关只配了 DeepSeek 一把 key
    expect(models).toEqual(['deepseek-asr', 'deepseek-flash', 'deepseek-tts', 'deepseek-v4-pro']);
    for (const item of res.body.items ?? []) {
      expect(String(item['access_path']).startsWith('deepseek')).toBe(true);
      expect(item['internal']).toBeUndefined();
      expect(item['availability']).toBeUndefined();
    }
  });

  it('与 /v1/models 的默认清单是同一个模型集合（同源，不是两套判据）', async () => {
    const caps = await adminApi('/admin/api/capabilities');
    const models = await fetch(`${baseUrl}/v1/models`);
    const body = (await models.json()) as { data: Array<{ id: string }> };
    expect(modelSet(caps.body.items)).toEqual([...new Set(body.data.map((m) => m.id))].sort());
  });

  it('全量模式的模型集合 = /v1/models 两个开关全开时的集合', async () => {
    const caps = await adminApi('/admin/api/capabilities?all=1');
    const models = await fetch(
      `${baseUrl}/v1/models?include_unconfigured=true&include_internal=true`,
    );
    const body = (await models.json()) as { data: Array<{ id: string }> };
    expect(modelSet(caps.body.items)).toEqual([...new Set(body.data.map((m) => m.id))].sort());
    // 14 个模型：deepseek 4 + openai/anthropic/mock 各 1（mock 两条路径两个模型）
    // + mimo 6（2 chat + 3 tts 变体 + 1 asr；2026-11 接 MiMo 后从 8 涨到 14）
    expect(modelSet(caps.body.items)).toHaveLength(14);
  });

  it('全量模式下被隐藏的两类带标注（状态诚实）', async () => {
    const res = await adminApi('/admin/api/capabilities?all=1');
    const items = res.body.items ?? [];
    const byModel = (m: string): Record<string, unknown> | undefined =>
      items.find((e) => e['model'] === m);
    expect(byModel('gpt-test-1')?.['internal']).toBe(true);
    expect(byModel('claude-test-1')?.['internal']).toBe(true);
    expect(byModel('gpt-4o')?.['availability']).toBe('unconfigured');
    expect(byModel('claude-sonnet-4-5')?.['availability']).toBe('unconfigured');
    // mock 同时踩两条判据，两个标注都在
    expect(byModel('gpt-test-1')?.['availability']).toBe('unconfigured');
    // 已配置的条目不带标注（省略 = 常态）
    expect(byModel('deepseek-flash')?.['availability']).toBeUndefined();
    expect(byModel('deepseek-flash')?.['internal']).toBeUndefined();
  });

  it('一个模型可以有多条接入路径（聚合是前端的事，端点仍按矩阵条目给）', async () => {
    const res = await adminApi('/admin/api/capabilities');
    const flash = (res.body.items ?? []).filter((e) => e['model'] === 'deepseek-flash');
    expect(flash.map((e) => String(e['access_path'])).sort()).toEqual([
      'deepseek.anthropic-messages',
      'deepseek.openai-chat',
    ]);
  });

  it('端点要鉴权；非法开关值 400', async () => {
    const anon = await fetch(`${baseUrl}/admin/api/capabilities`);
    expect(anon.status).toBe(401);
    const bad = await adminApi('/admin/api/capabilities?all=perhaps');
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('invalid_param');
  });

  it('POST /admin/api/capabilities/visibility 可切换模型标识符是否暴露给 /v1/models', async () => {
    const hideRes = await fetch(`${baseUrl}/admin/api/capabilities/visibility`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'deepseek-flash', exposed: false }),
    });
    expect(hideRes.status).toBe(200);

    const capsAfterHide = await adminApi('/admin/api/capabilities');
    const flashEntry = (capsAfterHide.body.items ?? []).find(
      (e) => e['model'] === 'deepseek-flash',
    );
    expect(flashEntry?.['exposed']).toBe(false);

    const v1AfterHide = await fetch(`${baseUrl}/v1/models`);
    const v1HideBody = (await v1AfterHide.json()) as { data: Array<{ id: string }> };
    expect(v1HideBody.data.map((m) => m.id)).not.toContain('deepseek-flash');

    const showRes = await fetch(`${baseUrl}/admin/api/capabilities/visibility`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'deepseek-flash', exposed: true }),
    });
    expect(showRes.status).toBe(200);

    const v1AfterShow = await fetch(`${baseUrl}/v1/models`);
    const v1ShowBody = (await v1AfterShow.json()) as { data: Array<{ id: string }> };
    expect(v1ShowBody.data.map((m) => m.id)).toContain('deepseek-flash');
  });
});
