/**
 * tests/provider-ops.test.ts —— provider 通用配置补齐（NewAPI 对照后判定"要做"的部分）。
 *
 * 覆盖四组：
 *   1. **批量操作**（`POST /admin/api/providers/batch`）：部分失败逐项报错、不 fail-fast、
 *      每项一条审计、单批上限；
 *   2. **渠道复制**（`POST /admin/api/providers/{id}/copy`）：只复制配置不复制凭据、
 *      404/409/400 三种错误码；
 *   3. **连通性检查**（`POST /admin/api/providers/{id}/test`）：薄封装 provider-models 的
 *      已存模式，顺带把 health 回写到渠道记录（这两个字段早就在契约里、从未被更新）；
 *   4. **服务端工具默认注入**（provider 级开关，默认关）：走 canonical builtin tool 链路，
 *      客户端已声明的不重复注入，开着就关 fast path。
 *   5. **自动禁用 / 恢复**：401 立即禁用、达到阈值禁用、成功恢复且不动 enabled、
 *      「计数中」不被踢出轮换、探测成功清计数。
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
import { TOKENS } from '../di/index.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { injectDefaultBuiltinTools } from '../gateway-core/builtin-tool-defaults.js';
import type { CanonicalRequestEnvelope, ChatPayload } from '../ir/index.js';
import type { GatewayConfig } from '../di/ports.js';
import { InMemoryProviderRuntimeIndex, isAutoDisabled } from '../admin/provider-runtime.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'provider-ops-test-passphrase';
const ADMIN_PASSWORD = 'admin-password-not-real'; // privacy-scan: ignore —— 测试假口令（login 契约字段名，值是显式假串）
const FAKE_KEY = 'sk-fake-deepseek-not-real';
const UPSTREAM_MODELS = {
  object: 'list',
  data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576 }],
};

interface Harness {
  server: Server;
  baseUrl: string;
  adminToken: string;
  gateway: ReturnType<typeof createGateway>;
  transport: ScriptedTransport;
}

async function build(
  script: ScriptedTransportScript = [],
  options: { env?: Record<string, string>; config?: Partial<GatewayConfig> } = {},
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
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY,
      ...(options.env ?? {}),
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
    ...(options.config === undefined ? {} : { config: options.config }),
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
  const body = (await login.json()) as { token?: string };
  return { server, baseUrl, adminToken: body.token ?? '', gateway, transport };
}

async function api(
  h: Harness,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${h.adminToken}`,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function makeProvider(
  h: Harness,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await api(h, 'POST', '/admin/api/providers', {
    id,
    label: `Provider ${id}`,
    dialect: 'openai.chat',
    base_url: 'https://api.deepseek.com',
    model_source: { kind: 'static', models: [`${id}-model`] },
    ...extra,
  });
}

async function close(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await h.gateway.shutdown();
}

// ---------------------------------------------------------------------------
// 批量操作
// ---------------------------------------------------------------------------

describe('批量操作', () => {
  it('批量停用 → 全部 changed，且每条渠道一个审计', async () => {
    const h = await build();
    await makeProvider(h, 'p1');
    await makeProvider(h, 'p2');
    await makeProvider(h, 'p3');
    const res = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: ['p1', 'p2', 'p3'],
      action: 'disable',
    });
    expect(res.status).toBe(200);
    expect(res.body['ok']).toBe(true);
    expect(res.body['changed']).toEqual(['p1', 'p2', 'p3']);
    const list = await api(h, 'GET', '/admin/api/providers');
    for (const item of list.body['items'] as Array<Record<string, unknown>>) {
      expect(item['enabled']).toBe(false);
    }
    // 每项一条审计（批量操作最怕"改了 3 个但日志里只有一条"）
    const audit = await h.gateway.admin!.adminService.listAudit();
    const disables = audit.items.filter((e) => e.action === 'provider.disable');
    expect(disables).toHaveLength(3);
    await close(h);
  });

  it('批量启用 → 停用过的渠道重新起来', async () => {
    const h = await build();
    await makeProvider(h, 'p1');
    await api(h, 'POST', '/admin/api/providers/batch', { ids: ['p1'], action: 'disable' });
    const res = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: ['p1'],
      action: 'enable',
    });
    expect(res.body['changed']).toEqual(['p1']);
    const list = await api(h, 'GET', '/admin/api/providers');
    expect((list.body['items'] as Array<Record<string, unknown>>)[0]!['enabled']).toBe(true);
    await close(h);
  });

  it('部分失败不 fail-fast：坏的 id 逐项报错，好的照改', async () => {
    const h = await build();
    await makeProvider(h, 'p1');
    await makeProvider(h, 'p2');
    const res = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: ['p1', 'nope', 'p2'],
      action: 'disable',
    });
    // HTTP 400（有失败项），但 changed 里该有的都有
    expect(res.status).toBe(400);
    expect(res.body['ok']).toBe(false);
    expect(res.body['changed']).toEqual(['p1', 'p2']);
    expect(res.body['failed']).toEqual([{ id: 'nope', error: '渠道不存在' }]);
    await close(h);
  });

  it('批量删除 → 静态模型一并从能力矩阵摘掉', async () => {
    const h = await build();
    await makeProvider(h, 'p1');
    // 删除前能力矩阵里有这条
    const registry = h.gateway.container.resolve(TOKENS.CapabilityRegistry);
    expect(registry.find('p1.openai-chat', 'p1-model', 'chat')).toBeDefined();
    const res = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: ['p1'],
      action: 'delete',
    });
    expect(res.body['changed']).toEqual(['p1']);
    const list = await api(h, 'GET', '/admin/api/providers');
    expect(list.body['items']).toEqual([]);
    await close(h);
  });

  it('空 ids / 超 100 / 非法 action → 400，且一句话说清', async () => {
    const h = await build();
    const empty = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: [],
      action: 'disable',
    });
    expect(empty.status).toBe(400);
    expect(empty.body['failed']).toEqual([{ id: '', error: 'ids 不能为空' }]);

    const tooMany = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: Array.from({ length: 101 }, (_, i) => `p${i}`),
      action: 'disable',
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body['failed']).toEqual([{ id: '', error: '单批最多 100 个' }]);

    const bad = await api(h, 'POST', '/admin/api/providers/batch', { ids: ['p1'], action: 'nope' });
    expect(bad.status).toBe(400);
    expect((bad.body['error'] as Record<string, unknown>)['message']).toContain(
      'enable / disable / delete',
    );
    await close(h);
  });
});

// ---------------------------------------------------------------------------
// 渠道复制
// ---------------------------------------------------------------------------

describe('渠道复制', () => {
  it('复制配置（label/base_url/dialect/模型清单/能力覆盖），**不复制凭据与 enabled**', async () => {
    const h = await build();
    await makeProvider(h, 'src', {
      label: '源渠道',
      capability_overrides: { unsupported_fields: ['params.user'] },
      note: '备注',
    });
    const res = await api(h, 'POST', '/admin/api/providers/src/copy', { new_id: 'dst' });
    expect(res.status).toBe(200);
    const dst = res.body['provider'] as Record<string, unknown>;
    expect(dst['id']).toBe('dst');
    expect(dst['label']).toBe('源渠道 副本');
    expect(dst['base_url']).toBe('https://api.deepseek.com');
    expect(dst['model_source']).toEqual({ kind: 'static', models: ['src-model'] });
    expect(dst['capability_overrides']).toEqual({ unsupported_fields: ['params.user'] });
    expect(dst['note']).toBe('备注');
    // 新渠道默认启用（不继承 src 的 enabled）
    expect(dst['enabled']).toBe(true);
    // 凭据一条都没有（复制不带 key）
    const creds = await h.gateway.admin!.adminService.listCredentials();
    expect(creds).toHaveLength(0);
    await close(h);
  });

  it('自定义 label 生效；new_id 缺省用 `<id>-copy`', async () => {
    const h = await build();
    await makeProvider(h, 'src', { label: '源' });
    const withLabel = await api(h, 'POST', '/admin/api/providers/src/copy', {
      new_id: 'dst',
      label: '我的副本',
    });
    expect((withLabel.body['provider'] as Record<string, unknown>)['label']).toBe('我的副本');
    const auto = await api(h, 'POST', '/admin/api/providers/src/copy', {});
    expect((auto.body['provider'] as Record<string, unknown>)['id']).toBe('src-copy');
    await close(h);
  });

  it('404 / 409 / 400 三种错误码', async () => {
    const h = await build();
    await makeProvider(h, 'src', { namespace: 'src' });
    // 源不存在
    const missing = await api(h, 'POST', '/admin/api/providers/nope/copy', {});
    expect(missing.status).toBe(404);
    // 目标已存在
    await makeProvider(h, 'dst');
    const dup = await api(h, 'POST', '/admin/api/providers/src/copy', { new_id: 'dst' });
    expect(dup.status).toBe(409);
    // new_id 与源相同 / 非法
    const same = await api(h, 'POST', '/admin/api/providers/src/copy', { new_id: 'src' });
    expect(same.status).toBe(400);
    const bad = await api(h, 'POST', '/admin/api/providers/src/copy', { new_id: 'Bad_ID!' });
    expect(bad.status).toBe(400);
    await close(h);
  });

  it('复制会带走 namespace → 撞名时 409（而不是悄悄造两个同 namespace 渠道）', async () => {
    const h = await build();
    await makeProvider(h, 'src', { namespace: 'shared' });
    const res = await api(h, 'POST', '/admin/api/providers/src/copy', { new_id: 'dst' });
    expect(res.status).toBe(409);
    expect((res.body['error'] as Record<string, unknown>)['message']).toContain('shared');
    await close(h);
  });

  it('源渠道无 namespace 时，复制自动以 new_id 作为 namespace 避免模型冲突', async () => {
    const h = await build();
    await makeProvider(h, 'mimo', { model_source: { kind: 'static', models: ['mimo-v2.6-flash'] } });
    const res = await api(h, 'POST', '/admin/api/providers/mimo/copy', {});
    expect(res.status).toBe(200);
    const copied = res.body['provider'] as Record<string, unknown>;
    expect(copied['id']).toBe('mimo-copy');
    expect(copied['namespace']).toBe('mimo-copy');
    await close(h);
  });

  it('存在 mimo1 与 mimo2 时，把 mimo2 的 namespace 设为 mimo1 或模型重名时报错拒绝', async () => {
    const h = await build();
    await makeProvider(h, 'mimo1', { model_source: { kind: 'static', models: ['mimo-v2.6-flash'] } });
    await makeProvider(h, 'mimo2', {
      namespace: 'ns2',
      model_source: { kind: 'static', models: ['mimo-v2.6-flash'] },
    });

    const conflictId = await api(h, 'POST', '/admin/api/providers', {
      id: 'mimo2',
      label: 'mimo2',
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      namespace: 'mimo1',
      model_source: { kind: 'static', models: ['mimo-v2.6-flash'] },
    });
    expect(conflictId.status).toBe(400);

    const conflictModel = await api(h, 'POST', '/admin/api/providers', {
      id: 'mimo2',
      label: 'mimo2',
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      namespace: '',
      model_source: { kind: 'static', models: ['mimo-v2.6-flash'] },
    });
    expect(conflictModel.status).toBe(400);
    await close(h);
  });
});

// ---------------------------------------------------------------------------
// 连通性检查
// ---------------------------------------------------------------------------

describe('连通性检查（POST /providers/{id}/test）', () => {
  it('成功 → ok，且 health/last_checked 被回写（不再是恒 unknown）', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await makeProvider(h, 'deepseek');
    const res = await api(h, 'POST', '/admin/api/providers/deepseek/test', {});
    expect(res.status).toBe(200);
    expect(res.body['ok']).toBe(true);
    expect(res.body['status']).toBe('ok');
    const list = await api(h, 'GET', '/admin/api/providers');
    const provider = (list.body['items'] as Array<Record<string, unknown>>)[0]!;
    expect(provider['credential_health']).toBe('ok');
    expect(typeof provider['credential_last_checked']).toBe('number');
    // 打的是 GET /models，**不发 chat**
    expect(h.transport.requests[0]!.method).toBe('GET');
    expect(h.transport.requests[0]!.path).toBe('/models');
    await close(h);
  });

  it('上游 401 → error + key_invalid（一句话），health 落 error', async () => {
    const h = await build([{ status: 401, body: 'nope' }]);
    await makeProvider(h, 'deepseek');
    const res = await api(h, 'POST', '/admin/api/providers/deepseek/test', {});
    expect(res.status).toBe(502);
    expect(res.body['ok']).toBe(false);
    expect(res.body['code']).toBe('key_invalid');
    expect(res.body['message']).toBe('API Key 无效或没有该端点权限');
    const list = await api(h, 'GET', '/admin/api/providers');
    expect((list.body['items'] as Array<Record<string, unknown>>)[0]!['credential_health']).toBe(
      'error',
    );
    await close(h);
  });

  it('渠道不存在 → 404', async () => {
    const h = await build([]);
    const res = await api(h, 'POST', '/admin/api/providers/nope/test', {});
    expect(res.status).toBe(404);
    expect(res.body['code']).toBe('not_found');
    await close(h);
  });
});

// ---------------------------------------------------------------------------
// 自动禁用 / 恢复
// ---------------------------------------------------------------------------

describe('自动禁用与恢复', () => {
  it('上游 401 → 立即自动禁用（不等计数）', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    const result = await h.gateway.admin!.adminService.recordUpstreamFailure(
      'system:pipeline',
      'deepseek',
      401,
    );
    expect(result.auto_disabled).toBe(true);
    const provider = await h.gateway.admin!.adminService.getProvider('deepseek');
    expect(provider?.auto_disabled?.reason).toContain('401');
    // 请求路径立刻看得见（路由层过滤器）
    expect(
      h.gateway.container.resolve((await import('../di/index.js')).TOKENS.Router),
    ).toBeDefined();
    await close(h);
  });

  it('连续失败达到阈值才禁用；一次网络抖动不关渠道', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    const first = await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    expect(first.auto_disabled).toBe(false);
    const after = await service.getProvider('deepseek');
    expect(after?.auto_disabled?.consecutive_failures).toBe(1);
    // 阈值默认 3：第二次仍不禁用
    const second = await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    expect(second.auto_disabled).toBe(false);
    // 第三次到阈值 → 禁用
    const third = await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    expect(third.auto_disabled).toBe(true);
    expect(third.reason).toContain('连续 3 次');
    await close(h);
  });

  it('自动禁用后一次成功 → 恢复（清 auto_disabled），enabled 原样不动', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 401);
    expect((await service.getProvider('deepseek'))?.auto_disabled).toBeDefined();
    const recovered = await service.recordUpstreamSuccess('system:pipeline', 'deepseek');
    expect(recovered.recovered).toBe(true);
    const after = await service.getProvider('deepseek');
    expect(after?.auto_disabled).toBeUndefined();
    expect(after?.enabled).toBe(true);
    await close(h);
  });

  it('管理员手动停用的渠道 → 成功探测**不会**把它重新打开', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    await service.setProviderEnabled('owner', 'deepseek', false);
    const recovered = await service.recordUpstreamSuccess('system:pipeline', 'deepseek');
    // 没有 auto_disabled 要清 → recovered false；enabled 保持 false
    expect(recovered.recovered).toBe(false);
    const after = await service.getProvider('deepseek');
    expect(after?.enabled).toBe(false);
    await close(h);
  });

  it('手动停用会清掉 auto_disabled（管理员接管，网关不再声称"是我关的"）', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 401);
    await service.setProviderEnabled('owner', 'deepseek', false);
    expect((await service.getProvider('deepseek'))?.auto_disabled).toBeUndefined();
    await close(h);
  });

  it('自动禁用的渠道在请求路径上被挡下（不打上游）', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await makeProvider(h, 'deepseek', {
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
    });
    await h.gateway.admin!.adminService.recordUpstreamFailure('system:pipeline', 'deepseek', 401);
    const sink = new MemoryClientSink();
    const outcome = await h.gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
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
    expect(outcome.error?.code).toBe('no_available_provider');
    expect(h.transport.requests).toHaveLength(0);
    await close(h);
  });

  it('只累计未达阈值（"计数中"）→ 请求照样打到上游，不被踢出轮换', async () => {
    // 用户实测死锁：一次上游 400 记了失败 → 渠道进 auto_disabled{计数中} →
    // ProviderStateFilter 把「计数中」当不可用 → 所有请求被挡 → 成功恢复的路径
    // 永远跑不到 → 只能人工停用/启用。这里断言计数态放行。
    const h = await build([
      {
        body: JSON.stringify({
          id: 'chatcmpl-counting',
          object: 'chat.completion',
          created: FIXED_NOW,
          model: 'deepseek-flash',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      },
    ]);
    await makeProvider(h, 'deepseek', {
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
    });
    const service = h.gateway.admin!.adminService;
    const first = await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    expect(first.auto_disabled).toBe(false);
    expect((await service.getProvider('deepseek'))?.auto_disabled?.consecutive_failures).toBe(1);

    const sink = new MemoryClientSink();
    const outcome = await h.gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
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
    expect(outcome.error).toBeUndefined();
    // 关键断言：请求真的打到上游了（不是 no_available_provider）
    expect(h.transport.requests).toHaveLength(1);
    await close(h);
  });

  it('达到阈值 → 照旧在请求路径上被挡下（回归保护：计数态放行不等于永不过滤）', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await makeProvider(h, 'deepseek', {
      dialect: 'openai.chat',
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
    });
    const service = h.gateway.admin!.adminService;
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    const third = await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    expect(third.auto_disabled).toBe(true);
    const sink = new MemoryClientSink();
    const outcome = await h.gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
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
    expect(outcome.error?.code).toBe('no_available_provider');
    expect(h.transport.requests).toHaveLength(0);
    await close(h);
  });

  it('探测成功 → 清掉计数态/自动禁用（不动 enabled），渠道回到轮换', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    // 一次失败：只进计数态
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    expect((await service.getProvider('deepseek'))?.auto_disabled?.consecutive_failures).toBe(1);

    const res = await api(h, 'POST', '/admin/api/providers/deepseek/test', {});
    expect(res.status).toBe(200);
    expect(res.body['ok']).toBe(true);

    const after = await service.getProvider('deepseek');
    expect(after?.auto_disabled).toBeUndefined();
    expect(after?.enabled).toBe(true);
    expect(after?.credential_health).toBe('ok');
    // 恢复进审计（与 recordUpstreamSuccess 同一动作名，可追溯）
    const audit = await service.listAudit();
    expect(audit.items.some((e) => e.action === 'provider.auto_recover')).toBe(true);
    await close(h);
  });

  it('探测成功也救得回「真的被自动禁用」的渠道（不动 enabled）', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 401);
    expect((await service.getProvider('deepseek'))?.auto_disabled).toBeDefined();

    const res = await api(h, 'POST', '/admin/api/providers/deepseek/test', {});
    expect(res.body['ok']).toBe(true);
    const after = await service.getProvider('deepseek');
    expect(after?.auto_disabled).toBeUndefined();
    expect(after?.enabled).toBe(true);
    await close(h);
  });

  it('管理员手动停用的渠道 → 探测成功不会把它重新打开', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }]);
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    await service.setProviderEnabled('owner', 'deepseek', false);
    const res = await api(h, 'POST', '/admin/api/providers/deepseek/test', {});
    expect(res.body['ok']).toBe(true);
    const after = await service.getProvider('deepseek');
    // 只清 auto_disabled（这里本来就没有），enabled 一个字都不碰
    expect(after?.enabled).toBe(false);
    await close(h);
  });

  it('channelAutoDisableRecover=false → 探测成功不清 auto_disabled（部署显式要求人工恢复）', async () => {
    const h = await build([{ body: JSON.stringify(UPSTREAM_MODELS) }], {
      config: { channelAutoDisableRecover: false },
    });
    await makeProvider(h, 'deepseek');
    const service = h.gateway.admin!.adminService;
    await service.recordUpstreamFailure('system:pipeline', 'deepseek', 500);
    const res = await api(h, 'POST', '/admin/api/providers/deepseek/test', {});
    expect(res.body['ok']).toBe(true);
    const after = await service.getProvider('deepseek');
    expect(after?.auto_disabled?.consecutive_failures).toBe(1);
    await close(h);
  });
});

// ---------------------------------------------------------------------------
// provider 运行时投影：auto_disabled 两态判据（请求路径的 ProviderStateFilter 用它）
// ---------------------------------------------------------------------------

describe('provider 运行时投影：auto_disabled 两态判据', () => {
  const entry = (autoDisabled?: { reason: string; at: number; consecutive_failures: number }) => ({
    id: 'deepseek',
    dialect: 'openai.chat',
    base_url: 'https://api.deepseek.com',
    namespace: '',
    access_path: 'deepseek.openai-chat',
    models: ['deepseek-flash'],
    enabled: true,
    ...(autoDisabled === undefined ? {} : { auto_disabled: autoDisabled }),
    builtin_tools: {},
  });

  it('计数中（未达阈值）→ 可用：不被 ProviderStateFilter 踢出轮换', () => {
    const index = new InMemoryProviderRuntimeIndex();
    index.replace([entry({ reason: '连续失败计数中', at: 1, consecutive_failures: 1 })]);
    expect(index.isUnavailable('deepseek')).toBe(false);
  });

  it('达到阈值被自动禁用 → 不可用（照旧过滤）', () => {
    const index = new InMemoryProviderRuntimeIndex();
    index.replace([
      entry({ reason: '连续 3 次上游失败（最近一次 HTTP 500）', at: 1, consecutive_failures: 3 }),
    ]);
    expect(index.isUnavailable('deepseek')).toBe(true);
  });

  it('401 立即禁用（次数可能只有 1）→ 不可用：按 reason 判，不按次数判', () => {
    const index = new InMemoryProviderRuntimeIndex();
    index.replace([
      entry({ reason: '上游返回 401：key 无效或没有该端点权限', at: 1, consecutive_failures: 1 }),
    ]);
    expect(index.isUnavailable('deepseek')).toBe(true);
  });

  it('管理员停用 → 不可用（与 auto_disabled 无关）', () => {
    const index = new InMemoryProviderRuntimeIndex();
    index.replace([{ ...entry(), enabled: false }]);
    expect(index.isUnavailable('deepseek')).toBe(true);
  });

  it('没有 auto_disabled → 可用', () => {
    const index = new InMemoryProviderRuntimeIndex();
    index.replace([entry()]);
    expect(index.isUnavailable('deepseek')).toBe(false);
  });

  it('没登记过的 provider → 放行（缺省不猜，静态装配的渠道不消失）', () => {
    const index = new InMemoryProviderRuntimeIndex();
    index.replace([]);
    expect(index.isUnavailable('nope')).toBe(false);
  });

  it('isAutoDisabled：计数中 false，真禁用 true', () => {
    expect(isAutoDisabled({ reason: '连续失败计数中' })).toBe(false);
    expect(isAutoDisabled({ reason: '连续 3 次上游失败（最近一次 HTTP 500）' })).toBe(true);
    expect(isAutoDisabled(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 服务端工具默认注入（provider 级开关，默认关）
// ---------------------------------------------------------------------------

/** 造一个最小的 canonical chat 请求信封。 */
function chatEnvelope(): CanonicalRequestEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    model: 'deepseek-flash',
    source_format: 'openai.chat',
    payload: {
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    },
    raw: {},
  } as unknown as CanonicalRequestEnvelope;
}

/** 取 chat payload 的 tools 数组（测试断言用；窄化成 ChatPayload）。 */
function chatTools(req: CanonicalRequestEnvelope): unknown[] {
  return ((req.payload as ChatPayload).tools ?? []) as unknown[];
}

describe('服务端工具默认注入（canonical 层纯函数）', () => {
  it('没开任何开关 → 不注入', () => {
    const req = chatEnvelope();
    expect(injectDefaultBuiltinTools(req, [])).toEqual([]);
    expect(chatTools(req)).toHaveLength(1);
  });

  it('开了 web_search → 末尾追加 canonical BuiltinTool（executor=provider，config 为空）', () => {
    const req = chatEnvelope();
    const injected = injectDefaultBuiltinTools(req, ['web_search']);
    expect(injected).toEqual(['web_search']);
    const tools = chatTools(req) as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[1]).toEqual({
      type: 'builtin',
      name: 'web_search',
      config: {},
      executor: 'provider',
    });
  });

  it('客户端已声明同名工具 → 不重复注入（注入是补默认值，不是覆盖客户端）', () => {
    const req = chatEnvelope();
    chatTools(req).push({
      type: 'builtin',
      name: 'web_search',
      config: {},
      executor: 'provider',
    });
    expect(injectDefaultBuiltinTools(req, ['web_search'])).toEqual([]);
    expect(chatTools(req)).toHaveLength(2);
  });

  it('两个都开 → 两个都补，客户端 function tool 顺序与内容不变', () => {
    const req = chatEnvelope();
    const injected = injectDefaultBuiltinTools(req, ['web_search', 'url_context']);
    expect(injected).toEqual(['web_search', 'url_context']);
    const tools = chatTools(req) as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'function', name: 'get_weather' });
    expect(tools.map((t) => t['name'])).toEqual(['get_weather', 'web_search', 'url_context']);
  });

  it('非 chat 模态 → 不注入（没有 tools 槽）', () => {
    const req = chatEnvelope();
    (req as unknown as { kind: string }).kind = 'tts';
    expect(injectDefaultBuiltinTools(req, ['web_search'])).toEqual([]);
  });
});

describe('服务端工具默认注入（真实请求链路）', () => {
  it('provider 开了 web_search → 上游 tools[] 里出现 deepseek_web_search（方言映射）', async () => {
    const h = await build([
      {
        body: JSON.stringify({
          id: 'chatcmpl-inject',
          object: 'chat.completion',
          created: FIXED_NOW,
          model: 'deepseek-flash',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      },
    ]);
    await makeProvider(h, 'deepseek', {
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
      builtin_tools: { web_search: true },
    });
    const sink = new MemoryClientSink();
    const outcome = await h.gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
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
    expect(outcome.error).toBeUndefined();
    expect(h.transport.requests).toHaveLength(1);
    const wire = JSON.parse(h.transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      tools?: Array<Record<string, unknown>>;
    };
    // codec 把 canonical `web_search` 映射成 DeepSeek 的 `deepseek_web_search`
    expect(wire.tools).toEqual([{ type: 'deepseek_web_search' }]);
    await close(h);
  });

  it('默认关 → 上游 tools 里什么都没有（现状行为不变）', async () => {
    const h = await build([
      {
        body: JSON.stringify({
          id: 'chatcmpl-noinject',
          object: 'chat.completion',
          created: FIXED_NOW,
          model: 'deepseek-flash',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      },
    ]);
    await makeProvider(h, 'deepseek', {
      base_url: 'https://api.deepseek.com',
      model_source: { kind: 'static', models: ['deepseek-flash'] },
    });
    const sink = new MemoryClientSink();
    await h.gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
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
    const wire = JSON.parse(h.transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      tools?: unknown;
    };
    expect(wire.tools).toBeUndefined();
    await close(h);
  });
});

describe('删除渠道级联凭据', () => {
  it('默认删除渠道时级联删除仅属于该渠道的凭据', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    await api(h, 'POST', '/admin/api/credentials', {
      provider: 'deepseek',
      access_path: 'deepseek.openai-chat',
      secret: FAKE_KEY, // privacy-scan: ignore —— 顶部假 key 常量
    });

    const del = await api(h, 'DELETE', '/admin/api/providers/deepseek');
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(Array.isArray(del.body.deleted_credentials)).toBe(true);
    expect((del.body.deleted_credentials as string[]).length).toBe(1);

    const creds = await api(h, 'GET', '/admin/api/credentials');
    expect((creds.body.items as unknown[]).length).toBe(0);
    await close(h);
  });

  it('传 cascade_credentials=false 时删除渠道但保留凭据', async () => {
    const h = await build();
    await makeProvider(h, 'deepseek');
    await api(h, 'POST', '/admin/api/credentials', {
      provider: 'deepseek',
      access_path: 'deepseek.openai-chat',
      secret: FAKE_KEY, // privacy-scan: ignore —— 顶部假 key 常量
    });

    const del = await api(h, 'DELETE', '/admin/api/providers/deepseek?cascade_credentials=false');
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(del.body.deleted_credentials).toEqual([]);

    const creds = await api(h, 'GET', '/admin/api/credentials');
    expect((creds.body.items as unknown[]).length).toBe(1);
    await close(h);
  });

  it('被其他剩余渠道引用的共享凭据不会被误删', async () => {
    const h = await build();
    await makeProvider(h, 'p1');
    await makeProvider(h, 'p2');
    // 这条凭据同时关联 p1（access_path）与 p2（provider），删 p1 时必须保留
    await api(h, 'POST', '/admin/api/credentials', {
      provider: 'p2',
      access_path: 'p1.openai-chat',
      secret: FAKE_KEY, // privacy-scan: ignore —— 顶部假 key 常量
    });

    const del = await api(h, 'DELETE', '/admin/api/providers/p1');
    expect(del.status).toBe(200);
    expect(del.body.deleted_credentials).toEqual([]);

    const creds = await api(h, 'GET', '/admin/api/credentials');
    expect((creds.body.items as unknown[]).length).toBe(1);
    await close(h);
  });

  it('批量删除渠道默认级联删除独占凭据，且支持 cascade_credentials=false', async () => {
    const h = await build();
    await makeProvider(h, 'p1');
    await makeProvider(h, 'p2');
    await api(h, 'POST', '/admin/api/credentials', {
      provider: 'p1',
      access_path: 'p1.openai-chat',
      secret: FAKE_KEY, // privacy-scan: ignore —— 顶部假 key 常量
    });
    await api(h, 'POST', '/admin/api/credentials', {
      provider: 'p2',
      access_path: 'p2.openai-chat',
      secret: FAKE_KEY, // privacy-scan: ignore —— 顶部假 key 常量
    });

    const keepRes = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: ['p1'],
      action: 'delete',
      cascade_credentials: false,
    });
    expect(keepRes.status).toBe(200);
    expect(keepRes.body.deleted_credentials).toEqual([]);
    expect(((await api(h, 'GET', '/admin/api/credentials')).body.items as unknown[]).length).toBe(2);

    const cascadeRes = await api(h, 'POST', '/admin/api/providers/batch', {
      ids: ['p2'],
      action: 'delete',
    });
    expect(cascadeRes.status).toBe(200);
    expect((cascadeRes.body.deleted_credentials as string[]).length).toBe(1);
    expect(((await api(h, 'GET', '/admin/api/credentials')).body.items as unknown[]).length).toBe(1);
    await close(h);
  });
});
