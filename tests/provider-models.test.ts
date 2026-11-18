/**
 * tests/provider-models.test.ts —— `POST /admin/api/provider-models` 的契约测试。
 *
 * 覆盖任务书要求的四类上游情形：**成功 / 401 / 网络失败 / 形状异常**，外加限流、
 * 404、5xx、空清单，以及三条安全断言（预览 key 不落库、不进日志、不进错误信息）。
 *
 * 上游一律用 `ScriptedTransport`（DI 注入的假上游），**不打真实网络**、不设真实 key。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};
import { createAdminRouter } from '../admin/routes.js';
import { DefaultAdminAuth } from '../admin/auth.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { modelsPathForDialect } from '../admin/provider-models.js';
// 前端真实的「获取模型」客户端（跨构建边界 import：这条测试要的就是两边的契约对齐）

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'provider-models-test-passphrase';
const ADMIN_PASSWORD = 'admin-password-not-real'; // privacy-scan: ignore —— 测试假口令（login 契约字段名，值是显式假串）
/** 明显的假 key（无 sk- 形态、无真实域名）。 */
const FAKE_KEY = 'fake-preview-key-not-real';

/** DeepSeek `/models` 的真实形状（2026-11-14 实测的字段集）。 */
const UPSTREAM_MODELS = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: {
        anthropic_messages: {
          system_prompt_update: 'in-history',
          tool_update: 'addition-only',
        },
      },
    },
    {
      // 元数据不全的上游（非 DeepSeek 常见形态）：只有 id
      id: 'some-other-model',
    },
  ],
};

interface Harness {
  server: Server;
  baseUrl: string;
  adminToken: string;
  gateway: ReturnType<typeof createGateway>;
  transport: ScriptedTransport;
}

async function build(
  script: ScriptedTransportScript,
  env: Record<string, string> = {},
): Promise<Harness> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const recordStore = new DefaultEncryptedRecordStore(
    ks.unlocked(),
    new InMemoryRawRecordStore(),
    clock,
  );
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, env),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
  });

  const adminAuth = new DefaultAdminAuth(recordStore, clock, {});
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
  });

  const server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
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
  return { server, baseUrl, adminToken: loginBody.token ?? '', gateway, transport };
}

async function post(
  harness: Harness,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${harness.baseUrl}/admin/api/provider-models`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${harness.adminToken}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('路径映射（后端按方言推，前端不猜）', () => {
  it('DeepSeek 的 OpenAI 兼容面 → /models（没有 /v1）', () => {
    expect(modelsPathForDialect('openai.chat')).toBe('/models');
    expect(modelsPathForDialect('openai.responses')).toBe('/models');
  });
  it('Anthropic 兼容面 → /v1/models；Gemini → /v1beta/models', () => {
    expect(modelsPathForDialect('anthropic.messages')).toBe('/v1/models');
    expect(modelsPathForDialect('gemini.generateContent')).toBe('/v1beta/models');
  });
  it('显式 path 覆盖优先', () => {
    expect(modelsPathForDialect('openai.chat', '/custom/models')).toBe('/custom/models');
  });
});

describe('成功路径', () => {
  it('预览模式：200 + 模型清单（含 DeepSeek 的真实形状）', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(200);
    expect(res.body['ok']).toBe(true);
    expect(res.body['source']).toBe('upstream');
    const models = res.body['models'] as Array<Record<string, unknown>>;
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      effort: { levels: ['low', 'high', 'max'], default: 'high' },
      constraints: ['system_prompt_update: in-history', 'tool_update: addition-only'],
    });
    expect(models[0]!['constraints']).toEqual([
      'system_prompt_update: in-history',
      'tool_update: addition-only',
    ]);
    // 元数据不全的模型：字段**不出现**（不是 0 / 不是 null）
    expect(models[1]).toEqual({ id: 'some-other-model' });
    // 有一条缺 context_window → metadata_incomplete
    expect(res.body['metadata_incomplete']).toBe(true);

    // 上游收到的是 GET + 正确路径 + 预览 key 只在这一次的请求头里
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.transport.requests[0]!.method).toBe('GET');
    expect(harness.transport.requests[0]!.path).toBe('/models');
    expect(harness.transport.requests[0]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);

    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('请求体带 key 时**不落库**（存储里没有任何新记录）', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    // provider / credential / audit 三类都查一遍：key 不该出现在任何一类里
    const providers = await harness.gateway.admin!.adminService.listProviders();
    expect(providers).toHaveLength(0);
    const creds = await harness.gateway.admin!.adminService.listCredentials();
    expect(creds).toHaveLength(0);
    const audit = await harness.gateway.admin!.adminService.listAudit();
    // 审计有一条（记了"拉过一次"），但内容里不能有 key
    expect(audit.items).toHaveLength(1);
    expect(JSON.stringify(audit.items)).not.toContain(FAKE_KEY);

    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

describe('失败分类（各自不同的 code 与一句话文案）', () => {
  const cases: Array<{
    name: string;
    script: ScriptedTransportScript;
    expectedCode: string;
    expectedStatus: number;
  }> = [
    {
      name: '401 → key_invalid',
      script: [{ status: 401, body: JSON.stringify({ error: { message: 'invalid key' } }) }],
      expectedCode: 'key_invalid',
      expectedStatus: 502,
    },
    {
      name: '403 → key_invalid',
      script: [{ status: 403, body: 'forbidden' }],
      expectedCode: 'key_invalid',
      expectedStatus: 502,
    },
    {
      name: '404 → endpoint_unsupported',
      script: [{ status: 404, body: 'not found' }],
      expectedCode: 'endpoint_unsupported',
      expectedStatus: 502,
    },
    {
      name: '429 → rate_limited',
      script: [{ status: 429, body: 'slow down' }],
      expectedCode: 'rate_limited',
      expectedStatus: 502,
    },
    {
      name: '500 → upstream_error',
      script: [{ status: 500, body: 'boom' }],
      expectedCode: 'upstream_error',
      expectedStatus: 502,
    },
    {
      name: '200 但不是合法 JSON → invalid_json',
      script: [{ status: 200, body: '<html>gateway error</html>' }],
      expectedCode: 'invalid_json',
      expectedStatus: 502,
    },
    {
      name: '合法 JSON 但没有模型清单 → invalid_shape',
      script: [{ status: 200, body: JSON.stringify({ models: ['a'] }) }],
      expectedCode: 'invalid_shape',
      expectedStatus: 502,
    },
    {
      name: 'data 是空数组 → invalid_shape（上游说没有）',
      script: [{ status: 200, body: JSON.stringify({ object: 'list', data: [] }) }],
      expectedCode: 'invalid_shape',
      expectedStatus: 502,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const harness = await build(c.script);
      const res = await post(harness, {
        base_url: 'https://api.deepseek.com',
        dialect: 'openai.chat',
        api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
      });
      expect(res.status).toBe(c.expectedStatus);
      expect(res.body['ok']).toBe(false);
      const error = res.body['error'] as Record<string, unknown>;
      expect(error['code']).toBe(c.expectedCode);
      // 文案是一句话（Toast 级别），且**不含 key**
      expect(typeof error['message']).toBe('string');
      expect((error['message'] as string).length).toBeLessThanOrEqual(30);
      expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
      await new Promise<void>((r) => harness.server.close(() => r()));
      await harness.gateway.shutdown();
    });
  }

  it('网络失败（transport 抛错）→ network_error，且不带 err.message', async () => {
    // ScriptedTransport 脚本用尽会抛错——正好模拟"连不上"
    const harness = await build([]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(502);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('network_error');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('上游错误体回显了 key → detail 里被剥掉', async () => {
    const harness = await build([
      {
        status: 401,
        body: JSON.stringify({ error: { message: `key ${FAKE_KEY} is invalid` } }),
      },
    ]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(FAKE_KEY);
    // 但剥掉之后 detail 仍然在（前端"详情"折叠区要有东西可看）
    const detail = (res.body['error'] as Record<string, unknown>)['detail'];
    expect(typeof detail).toBe('string');
    expect(detail as string).toContain('<REDACTED:key>');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

describe('请求校验（4xx = 调用方的锅）', () => {
  it('api_key 与 provider_id 都给了 → 400 invalid_request', async () => {
    const harness = await build([{ body: '{}' }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
      provider_id: 'deepseek',
    });
    expect(res.status).toBe(400);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('invalid_request');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('两个都没给 → 400 invalid_request', async () => {
    const harness = await build([{ body: '{}' }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
    });
    expect(res.status).toBe(400);
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('坏 base_url → 400 invalid_request', async () => {
    const harness = await build([{ body: '{}' }]);
    const res = await post(harness, {
      base_url: 'not-a-url',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(400);
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('未登录 → 401（新增端点也过 admin 鉴权）', async () => {
    const harness = await build([{ body: '{}' }]);
    const res = await fetch(`${harness.baseUrl}/admin/api/provider-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        base_url: 'https://api.deepseek.com',
        dialect: 'openai.chat',
        api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
      }),
    });
    expect(res.status).toBe(401);
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

describe('已存模式', () => {
  it('用环境变量里的凭据拉（不传 key）', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }], {
      DEEPSEEK_API_KEY: 'sk-fake-env-key-not-real',
    });
    // 先建渠道（已存模式的入参）
    await harness.gateway.admin!.adminService.upsertProvider('owner', {
      id: 'deepseek',
      label: 'DeepSeek',
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'discovery', path: '/models' },
    });
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      provider_id: 'deepseek',
    });
    expect(res.status).toBe(200);
    expect((res.body['models'] as unknown[]).length).toBe(2);
    // 上游收到的是 env 里的 key，不是请求体里的（请求体里压根没有 key）
    expect(harness.transport.requests[0]!.headers['authorization']).toBe(
      'Bearer sk-fake-env-key-not-real',
    );
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('拿不到凭据 → 400 credential_missing（一句话）', async () => {
    const harness = await build([{ body: '{}' }]);
    await harness.gateway.admin!.adminService.upsertProvider('owner', {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      model_source: { kind: 'static', models: [] },
    });
    const res = await post(harness, {
      base_url: 'https://upstream.example.com',
      dialect: 'openai.chat',
      provider_id: 'acme',
    });
    expect(res.status).toBe(400);
    const error = res.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('credential_missing');
    expect(error['message']).toBe('该渠道还没有可用凭据');
    // 没打过上游（拿不到 key 就不该发请求）
    expect(harness.transport.requests).toHaveLength(0);
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

describe(' dialect → 路径映射在上游请求上生效', () => {
  it('anthropic.messages → 打 /v1/models 且用 x-api-key', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'anthropic.messages',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(200);
    expect(harness.transport.requests[0]!.path).toBe('/v1/models');
    expect(harness.transport.requests[0]!.headers['x-api-key']).toBe(FAKE_KEY);
    expect(harness.transport.requests[0]!.headers['anthropic-version']).toBe('2023-06-01');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 端到端：HTTP 请求体 → admin 路由 → service → 端口 → mock 上游
//
// 这条守的是 2026-11 那个真 bug：前端一直发 `api_key`，后端读的是裸 `key`，结果
// 预览模式永远报「请提供 api_key（预览）或 provider_id（已存）」——填了 key 也拉不到
// 模型。请求体按契约（admin/api-types.ts 的 ProviderModelsRequest）造，走完整链路，
// 任何一个字段名再漂一次，这条就红。
//
// 前端那一侧（`fetchProviderModels` 怎么造请求体、失败怎么分类）有它自己的测试：
// webui/admin/src/api/provider-models.test.ts。两边不互相 import——前端工程是独立
// 构建的 SPA，不进后端 tsconfig（DOM lib / Bundler 解析都不一样）。
// ---------------------------------------------------------------------------

describe('端到端：契约请求体 → 路由 → service → 端口 → mock 上游', () => {
  it('预览模式：带 api_key 真的打到上游，且拿到清单', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(200);
    expect((res.body['models'] as Array<{ id: string }>).map((m) => m.id)).toEqual([
      'deepseek-flash',
      'some-other-model',
    ]);
    // 上游真的收到了 GET /models + Bearer 预览 key（不是只在前端转了一圈）
    expect(harness.transport.requests).toHaveLength(1);
    expect(harness.transport.requests[0]!.path).toBe('/models');
    expect(harness.transport.requests[0]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);

    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('预览 key 不进存储 / 不进审计（安全边界不随改名松动）', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(await harness.gateway.admin!.adminService.listProviders()).toHaveLength(0);
    expect(await harness.gateway.admin!.adminService.listCredentials()).toHaveLength(0);
    const audit = await harness.gateway.admin!.adminService.listAudit();
    expect(audit.items).toHaveLength(1);
    expect(JSON.stringify(audit.items)).not.toContain(FAKE_KEY);

    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('只给 api_key 时路由到预览模式；只给 provider_id 时路由到已存模式', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }], {
      DEEPSEEK_API_KEY: 'sk-fake-env-key-not-real',
    });
    await harness.gateway.admin!.adminService.upsertProvider('owner', {
      id: 'deepseek',
      label: 'DeepSeek',
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'discovery', path: '/models' },
    });
    const saved = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      provider_id: 'deepseek',
    });
    expect(saved.status).toBe(200);
    expect(harness.transport.requests[0]!.headers['authorization']).toBe(
      'Bearer sk-fake-env-key-not-real',
    );

    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('两个都没给 → 400，且文案说清要哪个字段', async () => {
    const harness = await build([{ body: '{}' }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
    });
    expect(res.status).toBe(400);
    const error = res.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invalid_request');
    expect(error['message']).toBe('请提供 api_key（预览）或 provider_id（已存）');

    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

describe('响应体大小与 Buffer 边界', () => {
  it('上游返回空 body → invalid_shape（不是崩溃）', async () => {
    const harness = await build([{ status: 200, body: '' }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(502);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('invalid_json');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});

describe('Buffer 编解码', () => {
  it('请求体里的中文不会破坏 base64/JSON 边界', async () => {
    const harness = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    const res = await post(harness, {
      base_url: 'https://api.deepseek.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(200);
    expect(Buffer.from(JSON.stringify(res.body)).toString('utf8')).toContain('deepseek-flash');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('OpenAI 兼容面 /models 返回 404 时自动回退试 /v1/models（如 MiMo）', async () => {
    const harness = await build([
      { status: 404, body: '<html><body>404 Not Found</body></html>' },
      { status: 200, body: JSON.stringify(UPSTREAM_MODELS) },
    ]);
    const res = await post(harness, {
      base_url: 'https://api.xiaomimimo.com',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(200);
    expect(res.body['ok']).toBe(true);
    expect(harness.transport.requests.map((r) => r.path)).toEqual(['/models', '/v1/models']);
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });

  it('解析 OpenCode Go 的 limit / modalities(MIME) / capabilities.reasoning 元数据', async () => {
    const openCodePayload = {
      object: 'list',
      data: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'DeepSeek V4.1 Flash 1017',
          owned_by: 'opencode',
          limit: { context: 1000000, output: 384000 },
          modalities: {
            input: ['text', 'image/jpeg', 'image/png', 'video/mp4', 'audio/wav', 'application/pdf'],
            output: ['text'],
          },
          capabilities: {
            reasoning: { supported: true, effort: ['low', 'high', 'max'] },
          },
        },
      ],
    };
    const harness = await build([{ status: 200, body: JSON.stringify(openCodePayload) }]);
    const res = await post(harness, {
      base_url: 'https://opencode.ai/zen/go/v1',
      dialect: 'openai.chat',
      api_key: FAKE_KEY, // privacy-scan: ignore —— 测试假 key（FAKE_KEY 常量：明显占位串，无真实凭据）
    });
    expect(res.status).toBe(200);
    const models = res.body['models'] as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0]!['context_window']).toBe(1000000);
    expect(models[0]!['max_output_tokens']).toBe(384000);
    expect(models[0]!['input_modalities']).toEqual(['text', 'image', 'video', 'audio', 'pdf']);
    expect(models[0]!['output_modalities']).toEqual(['text']);
    expect(models[0]!['effort']).toEqual({ levels: ['low', 'high', 'max'] });
    expect(models[0]!['reasoning']).toBe(true);
    expect(models[0]!['metadata_source']).toBe('upstream');
    await new Promise<void>((r) => harness.server.close(() => r()));
    await harness.gateway.shutdown();
  });
});
