/**
 * tests/models-endpoint.test.ts —— `GET /v1/models` / `GET /v1/models/{id}` /
 * `/ag/models/sync` 的 HTTP 行为（含真实 HTTP 往返 + 官方 OpenAI SDK 之外的兼容性断言）。
 *
 * 全部离线：上游由注入的假来源提供，凭据由注入的 env 字面量提供。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import {
  ManualScheduler,
  ModelSyncService,
  createModelsDevSource,
  type ModelMetadataSource,
  type ModelMetadataSnapshot,
} from '../catalog/index.js';
import { createModelsEndpoints, type ModelsEndpoints } from '../http/models-endpoint.js';
import { createHttpServer, startHttpServer } from '../http/server.js';
import { createGateway } from '../composition-root.js';
import { InMemoryCapabilityRegistry } from '../credentials/capability-registry.js';
import { defaultCapabilities } from '../composition-root.js';
import { fixedClock, type Clock } from '../di/ports.js';
import { createDeepSeekCatalogSource } from '../providers/deepseek/index.js';

const T0 = 1_800_000_000_000;
const ADMIN_TOKEN = 'test-admin-token-not-a-real-secret';

/** 可前进的时钟：同步成功 → 时钟前进 → 再同步失败，才能稳定复现 stale。 */
function mutableClock(start = T0): { now(): number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 一个可编程的假上游来源。 */
function fakeUpstream(script: Array<ModelMetadataSnapshot | Error>): ModelMetadataSource & {
  calls: number;
} {
  const source = {
    id: 'upstream:deepseek',
    layer: 'upstream' as const,
    calls: 0,
    async load(): Promise<ModelMetadataSnapshot> {
      const step = script[Math.min(source.calls, script.length - 1)];
      source.calls += 1;
      if (step === undefined) throw new Error('script exhausted');
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return source;
}

function goodSnapshot(): ModelMetadataSnapshot {
  return {
    sourceId: 'upstream:deepseek',
    fetchedAt: T0,
    models: [
      {
        id: 'deepseek-flash',
        provider: 'deepseek',
        name: '上游实时名',
        raw: { id: 'deepseek-flash', upstream_only_field: true },
      },
    ],
  };
}

/**
 * 走**真实装配路径**造网关（组合根注入假上游来源 + 手动定时器），再包一层 HTTP 处理器。
 * 不自己拼 ModelCatalog——那样测的是替身而不是生产接线。
 */
function build(opts: { upstream?: ModelMetadataSource; adminToken?: string; clock?: Clock } = {}): {
  endpoints: ModelsEndpoints;
  sync: ModelSyncService;
  scheduler: ManualScheduler;
} {
  const scheduler = new ManualScheduler();
  const gateway = createGateway({
    mode: 'test',
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
    ...(opts.upstream === undefined
      ? { upstreamMetadataSources: [] }
      : { upstreamMetadataSources: [opts.upstream] }),
    modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000, scheduler },
  });
  const endpoints = createModelsEndpoints({
    catalog: gateway.models,
    sync: gateway.modelSync,
    ...(opts.adminToken === undefined ? {} : { adminToken: opts.adminToken }),
  });
  return { endpoints, sync: gateway.modelSync, scheduler };
}

// ---------------------------------------------------------------------------
// 直接调处理器（不需要起服务）
// ---------------------------------------------------------------------------

describe('ModelsEndpoints · 列表与详情', () => {
  it('GET /v1/models 返回 OpenAI 兼容形状', async () => {
    const { endpoints } = build();
    const result = await endpoints.listModels(new URLSearchParams());
    expect(result.status).toBe(200);
    const body = result.body as {
      object: string;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe('list');
    expect(Array.isArray(body.data)).toBe(true);
    for (const item of body.data) {
      // OpenAI 兼容键：id / object / owned_by 必须齐（created 有发布日期时也有）
      expect(typeof item['id']).toBe('string');
      expect(item['object']).toBe('model');
      expect(typeof item['owned_by']).toBe('string');
      if (item['created'] !== undefined) expect(typeof item['created']).toBe('number');
      // 扩展键（多余键）也在：证明是 superset 而不是另一个形状
      expect(item['provenance']).toBeDefined();
      expect(item['access_paths']).toBeDefined();
    }
    expect(body.data.map((m) => m['id'])).toContain('deepseek-flash');
  });

  it('GET /v1/models/{id} 返回模型对象（不包 list 信封）', async () => {
    const { endpoints } = build();
    const result = await endpoints.getModel('deepseek-v4-pro');
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['id']).toBe('deepseek-v4-pro');
    expect(body['object']).toBe('model');
    expect(body['owned_by']).toBe('deepseek');
    expect(body['context_window']).toBe(1_048_576);
    // 独有字段三项
    expect(Array.isArray(body['constraints'])).toBe(true);
    expect(body['pricing']).toBeDefined();
    expect(Array.isArray(body['access_paths'])).toBe(true);
  });

  it('id 需要 URL 解码（带点号的 id 不会被截断）', async () => {
    const { endpoints } = build();
    const result = await endpoints.getModel(encodeURIComponent('deepseek-v4-pro'));
    expect(result.status).toBe(200);
    expect((result.body as { id: string }).id).toBe('deepseek-v4-pro');
  });

  it('未知模型 → 404 + OpenAI 形状错误体', async () => {
    const { endpoints } = build();
    const result = await endpoints.getModel('no-such-model');
    expect(result.status).toBe(404);
    const body = result.body as { error: { message: string; type: string; code?: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('no-such-model');
  });

  it('退役别名 → 404 且解释"为什么 + 改用谁"', async () => {
    const { endpoints } = build();
    const result = await endpoints.getModel('deepseek-chat');
    expect(result.status).toBe(404);
    const body = result.body as { error: { message: string } };
    expect(body.error.message).toContain('2026-07-24');
    expect(body.error.message).toContain('deepseek-flash');
  });

  it('过滤参数：provider / modality / capability / min_context', async () => {
    const { endpoints } = build();
    const deepseek = await endpoints.listModels(new URLSearchParams('owned_by=deepseek'));
    expect((deepseek.body as { data: Array<{ id: string }> }).data.map((m) => m.id).sort()).toEqual(
      ['deepseek-flash', 'deepseek-v4-pro'],
    );

    const vision = await endpoints.listModels(new URLSearchParams('capability=vision'));
    const visionIds = (vision.body as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(visionIds).toContain('deepseek-flash');
    expect(visionIds).not.toContain('deepseek-v4-pro');

    const big = await endpoints.listModels(new URLSearchParams('min_context=1000000'));
    expect((big.body as { data: Array<{ id: string }> }).data.map((m) => m.id).sort()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
  });

  it('非法参数值 → 400（不静默当成没过滤）', async () => {
    const { endpoints } = build();
    const bad = await endpoints.listModels(new URLSearchParams('min_context=abc'));
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { message: string } }).error.message).toContain('min_context');

    const badSort = await endpoints.listModels(new URLSearchParams('sort=nope'));
    expect(badSort.status).toBe(400);

    const badCapability = await endpoints.listModels(new URLSearchParams('capability=telepathy'));
    expect(badCapability.status).toBe(400);

    const badBool = await endpoints.listModels(new URLSearchParams('open_weights=maybe'));
    expect(badBool.status).toBe(400);
  });

  it('未知查询参数被忽略（drop-in 兼容：SDK 自带参数不破）', async () => {
    const { endpoints } = build();
    const result = await endpoints.listModels(
      new URLSearchParams('custom_llm_provider=deepseek&some_future_flag=1'),
    );
    expect(result.status).toBe(200);
    expect((result.body as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it('排序 + 分页', async () => {
    const { endpoints } = build();
    const desc = await endpoints.listModels(new URLSearchParams('sort=-context_window'));
    const data = (desc.body as { data: Array<{ context_window?: number }> }).data;
    const windows = data.map((m) => m.context_window ?? -1);
    expect(windows).toEqual([...windows].sort((a, b) => b - a));

    const page = await endpoints.listModels(new URLSearchParams('limit=2&sort=id'));
    expect((page.body as { data: unknown[]; has_more: boolean }).data).toHaveLength(2);
    expect((page.body as { has_more: boolean }).has_more).toBe(true);
  });
});

describe('ModelsEndpoints · 管理员同步门禁', () => {
  it('未配置管理员令牌 → 503（拒绝一切，而不是放行）', async () => {
    const { endpoints } = build();
    const result = await endpoints.adminModelsSync({ method: 'POST' });
    expect(result.status).toBe(503);
    expect((result.body as { error: { type: string } }).error.type).toBe(
      'admin_token_not_configured',
    );
  });

  it('令牌缺失 / 不正确 → 401', async () => {
    const { endpoints } = build({ adminToken: ADMIN_TOKEN });
    expect((await endpoints.adminModelsSync({ method: 'POST' })).status).toBe(401);
    expect(
      (await endpoints.adminModelsSync({ method: 'POST', authorization: 'Bearer wrong' })).status,
    ).toBe(401);
    // 不是 Bearer 形态也拒
    expect(
      (await endpoints.adminModelsSync({ method: 'POST', authorization: `Basic ${ADMIN_TOKEN}` }))
        .status,
    ).toBe(401);
  });

  it('Bearer 与 x-admin-token 两种形态都认', async () => {
    const { endpoints, sync } = build({
      adminToken: ADMIN_TOKEN,
      upstream: fakeUpstream([goodSnapshot()]),
    });
    const viaBearer = await endpoints.adminModelsSync({
      method: 'POST',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(viaBearer.status).toBe(200);
    expect((viaBearer.body as { ok: boolean }).ok).toBe(true);
    expect(sync.snapshotFor('upstream:deepseek')?.models).toHaveLength(1);

    const viaHeader = await endpoints.adminModelsSync({
      method: 'POST',
      adminTokenHeader: ADMIN_TOKEN,
    });
    expect(viaHeader.status).toBe(200);
  });

  it('GET 返回状态视图，POST 返回同步报告', async () => {
    const { endpoints } = build({
      adminToken: ADMIN_TOKEN,
      upstream: fakeUpstream([goodSnapshot()]),
    });
    const status = await endpoints.adminModelsSync({
      method: 'GET',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(status.status).toBe(200);
    expect((status.body as { object: string }).object).toBe('models.sync.status');
    expect((status.body as { sources: unknown[] }).sources).toHaveLength(1);

    const report = await endpoints.adminModelsSync({
      method: 'POST',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect((report.body as { object: string; reason: string }).object).toBe('models.sync.report');
    expect((report.body as { reason: string }).reason).toBe('admin');
  });

  it('管理员同步把上游数据带进 /v1/models', async () => {
    const { endpoints } = build({
      adminToken: ADMIN_TOKEN,
      upstream: fakeUpstream([goodSnapshot()]),
    });
    const before = await endpoints.getModel('deepseek-flash');
    expect((before.body as { name?: string }).name).not.toBe('上游实时名');

    await endpoints.adminModelsSync({ method: 'POST', authorization: `Bearer ${ADMIN_TOKEN}` });

    const after = await endpoints.getModel('deepseek-flash');
    expect((after.body as { name?: string }).name).toBe('上游实时名');
    // 上游原字段透传
    expect((after.body as { raw?: Record<string, unknown> }).raw?.['upstream_only_field']).toBe(
      true,
    );
  });
});

describe('ModelsEndpoints · 上游挂了端点照样答', () => {
  it('上游从未成功：/v1/models 仍 200 且字段来自矩阵种子', async () => {
    const { endpoints, sync } = build({
      upstream: fakeUpstream([new Error('connection refused')]),
    });
    await sync.syncNow('startup'); // 拉一次，失败
    const result = await endpoints.listModels(new URLSearchParams());
    expect(result.status).toBe(200);
    const flash = (result.body as { data: Array<Record<string, unknown>> }).data.find(
      (m) => m['id'] === 'deepseek-flash',
    );
    expect(flash?.['context_window']).toBe(1_048_576);
    const provenance = flash?.['provenance'] as {
      stale: boolean;
      layers: Array<{ error?: string }>;
    };
    expect(provenance.stale).toBe(false);
    expect(provenance.layers.some((l) => l.error?.includes('connection refused'))).toBe(true);
  });

  it('有过成功快照后又挂：返回 last-known-good 并标 stale', async () => {
    const upstream = fakeUpstream([goodSnapshot(), new Error('upstream 503')]);
    const clock = mutableClock();
    const { endpoints, sync } = build({ upstream, clock });
    await sync.syncNow('admin'); // T0：成功，拿到快照
    clock.advance(61_000); // 超过 TTL(60s)
    await sync.syncNow('periodic'); // 失败：保留 last-known-good

    const result = await endpoints.listModels(new URLSearchParams());
    expect(result.status).toBe(200);
    const flash = (result.body as { data: Array<Record<string, unknown>> }).data.find(
      (m) => m['id'] === 'deepseek-flash',
    );
    const provenance = flash?.['provenance'] as {
      stale: boolean;
      last_successful_fetch?: number;
      last_error?: string;
    };
    expect(provenance.stale).toBe(true);
    expect(provenance.last_successful_fetch).toBe(T0);
    expect(provenance.last_error).toContain('503');
    // last-known-good 的字段仍在
    expect(flash?.['name']).toBe('上游实时名');
  });
});

// ---------------------------------------------------------------------------
// 真实 HTTP 往返
// ---------------------------------------------------------------------------

describe('ModelsEndpoints · 真实 HTTP 往返', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const gateway = createGateway({ mode: 'test' });
    const models = createModelsEndpoints({
      catalog: gateway.models,
      sync: new ModelSyncService({
        clock: fixedClock(T0),
        sources: [],
        intervalMs: 0,
        syncOnStart: false,
      }),
    });
    server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      models,
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /v1/models → 200 + JSON', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toContain('deepseek-flash');
  });

  it('GET /v1/models/{id} → 200', async () => {
    const res = await fetch(`${base}/v1/models/deepseek-flash`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; object: string };
    expect(body.id).toBe('deepseek-flash');
    expect(body.object).toBe('model');
  });

  it('GET /v1/models/unknown → 404', async () => {
    const res = await fetch(`${base}/v1/models/unknown-model`);
    expect(res.status).toBe(404);
  });

  it('POST /v1/models → 405（列表只接受 GET）', async () => {
    const res = await fetch(`${base}/v1/models`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('GET /ag/models/sync 未配令牌 → 503', async () => {
    const res = await fetch(`${base}/ag/models/sync`);
    expect(res.status).toBe(503);
  });

  it('推理端点不受影响：POST /v1/chat/completions 仍走 pipeline', async () => {
    const gateway = createGateway({ mode: 'test' });
    const models = createModelsEndpoints({
      catalog: gateway.models,
      sync: new ModelSyncService({
        clock: fixedClock(T0),
        sources: [],
        intervalMs: 0,
        syncOnStart: false,
      }),
    });
    const srv = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      models,
    });
    const address = srv.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-gpt',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toContain('mock');
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('createHttpServer 不注入 models 时 /v1/models 走 404（保持向后兼容）', async () => {
    const gateway = createGateway({ mode: 'test' });
    const srv = createHttpServer({ port: 0, host: '127.0.0.1', runner: gateway.runner });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const address = srv.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

describe('ModelsEndpoints · 离线层装配', () => {
  it('默认两层离线来源都装上了（models.dev + deepseek 静态表）', async () => {
    const gateway = createGateway({ mode: 'test' });
    // 触发一次加载（离线层是懒加载的，loadedSources 之前要有一次 ready()）
    await gateway.models.list();
    const loaded = gateway.models.loadedSources();
    expect(loaded.map((s) => s.sourceId)).toEqual([
      'offline:models.dev',
      'offline:deepseek-static',
    ]);
    // models.dev 快照里有 73 个模型（3 个 provider 的快照）
    expect(loaded[0]?.models).toBeGreaterThan(50);
    expect(loaded[1]?.models).toBeGreaterThanOrEqual(4); // 2 现行 + 2 退役别名
  });

  it('可整体替换离线来源（测试替身）', async () => {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of defaultCapabilities()) registry.register(entry);
    const gateway = createGateway({
      mode: 'test',
      capabilities: [...defaultCapabilities()],
      modelMetadataSources: [
        {
          id: 'offline:test-only',
          layer: 'offline',
          async load() {
            return {
              sourceId: 'offline:test-only',
              fetchedAt: T0,
              models: [{ id: 'deepseek-flash', provider: 'deepseek', family: 'test-family' }],
            };
          },
        },
      ],
    });
    const flash = await gateway.models.get('deepseek-flash');
    expect(flash?.family).toBe('test-family');
    expect(flash?.provenance.fields['family']).toBe('offline:test-only');
    expect(gateway.models.loadedSources().map((s) => s.sourceId)).toEqual(['offline:test-only']);
    // 被替换掉的层不出现
    expect(flash?.provenance.layers.map((l) => l.sourceId)).not.toContain('offline:models.dev');
  });

  it('models.dev / deepseek 静态两个来源都可独立构造', async () => {
    const md = createModelsDevSource({ clock: fixedClock(T0) });
    const ds = createDeepSeekCatalogSource({ clock: fixedClock(T0) });
    const [a, b] = await Promise.all([md.load(), ds.load()]);
    expect(a.models.length).toBeGreaterThan(50);
    expect(b.models.map((m) => m.id).sort()).toEqual([
      'deepseek-chat',
      'deepseek-flash',
      'deepseek-reasoner',
      'deepseek-v4-pro',
    ]);
  });
});
