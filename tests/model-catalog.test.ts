/**
 * tests/model-catalog.test.ts —— canonical 模型目录：分层合并、优先级、provenance、
 * 与能力矩阵同源、离线兜底、过滤排序、退役别名。
 *
 * 全部离线运行：上游（如果用到）由注入的 ScriptedTransport 提供，凭据由注入的 env
 * 字面量提供，不碰真实 process.env、不读 .env、不起真实 API。
 */

import { describe, expect, it } from 'vitest';
import {
  ModelCatalog,
  ModelQueryError,
  createModelsDevSource,
  providerResolverFromRouteTable,
  type ModelMetadataSource,
  type ModelMetadataSnapshot,
} from '../catalog/index.js';
import { InMemoryCapabilityRegistry } from '../credentials/capability-registry.js';
import { defaultCapabilities, defaultRouteTable } from '../composition-root.js';
import { fixedClock } from '../di/ports.js';
import {
  createDeepSeekCatalogSource,
  DEEPSEEK_UPSTREAM_SOURCE_ID,
} from '../providers/deepseek/index.js';
import { DeepSeekModelDiscovery } from '../providers/deepseek/index.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { CapabilityEntry } from '../ir/index.js';

const T0 = 1_800_000_000_000;

/** 一个假的元数据来源（测试替身；layer 由调用方给）。 */
function fakeSource(
  id: string,
  layer: 'offline' | 'upstream' | 'config',
  models: ModelMetadataSnapshot['models'],
): ModelMetadataSource {
  return {
    id,
    layer,
    async load() {
      return { sourceId: id, fetchedAt: T0, models };
    },
  };
}

/** 把一份快照包装成上游层状态（同步服务的产物形状）。 */
function upstreamStateOf(snapshot: ModelMetadataSnapshot): {
  sourceId: string;
  layer: 'upstream';
  snapshot: ModelMetadataSnapshot;
  stale: boolean;
  lastSuccessAt: number;
} {
  return {
    sourceId: snapshot.sourceId,
    layer: 'upstream',
    snapshot,
    stale: false,
    lastSuccessAt: snapshot.fetchedAt,
  };
}

/** 只装 DeepSeek 两条路径的矩阵（缩小断言面）。 */
function deepseekOnlyRegistry(): InMemoryCapabilityRegistry {
  const registry = new InMemoryCapabilityRegistry();
  for (const entry of defaultCapabilities()) {
    if (entry.access_path.startsWith('deepseek')) registry.register(entry);
  }
  return registry;
}

function catalogWith(
  registry: InMemoryCapabilityRegistry,
  sources: ModelMetadataSource[],
  opts: { clock?: number; upstream?: unknown } = {},
): ModelCatalog {
  return new ModelCatalog({
    capabilityRegistry: registry,
    sources,
    clock: fixedClock(opts.clock ?? T0),
    providerResolver: providerResolverFromRouteTable(defaultRouteTable()),
    ...(opts.upstream === undefined ? {} : { upstream: opts.upstream as never }),
  });
}

describe('ModelCatalog · 分层合并与优先级', () => {
  it('运行时字段以能力矩阵为准：models.dev 的静态值不能覆盖矩阵', async () => {
    const registry = deepseekOnlyRegistry();
    const catalog = catalogWith(registry, [
      createModelsDevSource({ clock: fixedClock(T0) }),
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
    const flash = await catalog.get('deepseek-flash');
    expect(flash).toBeDefined();
    // 矩阵（= /models 实测种子）与 models.dev 快照都是 1M，但**来源必须记成矩阵**——
    // 这证明矩阵优先，而不是"两边数字恰好一样所以看不出来"
    expect(flash?.context_window).toBe(1_048_576);
    expect(flash?.provenance.fields['context_window']).toBe('capability-matrix');
    expect(flash?.provenance.fields['input_modalities']).toBe('capability-matrix');
    expect(flash?.provenance.fields['output_modalities']).toBe('capability-matrix');
    expect(flash?.provenance.fields['effort']).toBe('capability-matrix');
    // 静态字段矩阵里没有 → 由离线层补
    expect(flash?.provenance.fields['family']).toBe('offline:models.dev');
    expect(flash?.provenance.fields['pricing']).toBe('offline:deepseek-static');
  });

  it('矩阵没有的运行时字段由离线层填空（openai/anthropic 的窗口来自 models.dev）', async () => {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of defaultCapabilities()) registry.register(entry);
    const catalog = catalogWith(registry, [
      createModelsDevSource({ clock: fixedClock(T0) }),
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
    const gpt = await catalog.get('gpt-4o');
    expect(gpt?.context_window).toBe(128_000);
    expect(gpt?.provenance.fields['context_window']).toBe('offline:models.dev');
    expect(gpt?.owned_by).toBe('openai');
    // mock 路径不在 models.dev 里 → 只有矩阵字段，没有静态扩充
    const mock = await catalog.get('gpt-test-1');
    expect(mock?.owned_by).toBe('mock');
    expect(mock?.context_window).toBeUndefined();
    expect(mock?.provenance.fields['context_window']).toBeUndefined();
  });

  it('同一层内后者覆盖前者：deepseek-static 的峰谷 pricing 覆盖 models.dev 的扁平费率', async () => {
    const registry = deepseekOnlyRegistry();
    const catalog = catalogWith(registry, [
      createModelsDevSource({ clock: fixedClock(T0) }),
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
    const flash = await catalog.get('deepseek-flash');
    // models.dev 只有一条扁平费率（tiers 为空）；DeepSeek 静态表带峰谷 tiers
    expect(flash?.pricing?.tiers.length).toBeGreaterThan(0);
    expect(flash?.pricing?.table_version).toBe('deepseek-2026-11-14');
    expect(flash?.pricing?.rule_sets.map((r) => r.effective_from)).toEqual([
      '2026-08-17',
      '2026-08-23',
    ]);
    expect(flash?.pricing?.holidays?.year).toBe(2026);
    expect(flash?.pricing?.as_api_reference?.rates['input_cache_hit']).toBe(0.003);
  });

  it('上游层只补矩阵没有的字段，不改运行时字段', async () => {
    const registry = deepseekOnlyRegistry();
    const catalog = catalogWith(registry, [
      fakeSource('upstream:fake', 'upstream', [
        {
          id: 'deepseek-flash',
          provider: 'deepseek',
          name: '上游报的名字',
          // 故意给一个不同的窗口：上游层**不允许**覆盖矩阵（否则响应与路由漂移）
          context_window: 999,
          raw: { id: 'deepseek-flash', extra_upstream_field: 1 },
        },
      ]),
    ]);
    const flash = await catalog.get('deepseek-flash');
    expect(flash?.name).toBe('上游报的名字');
    expect(flash?.provenance.fields['name']).toBe('upstream:fake');
    expect(flash?.context_window).toBe(1_048_576);
    expect(flash?.provenance.fields['context_window']).toBe('capability-matrix');
    // 上游原字段透传进 raw
    expect(flash?.raw?.['extra_upstream_field']).toBe(1);
  });

  it('配置层优先级最高，且把矩阵字段写回能力矩阵（响应与路由同源）', async () => {
    const registry = deepseekOnlyRegistry();
    const before = registry.find('deepseek.openai-chat', 'deepseek-flash', 'chat');
    expect(before?.context_window).toBe(1_048_576);

    const catalog = catalogWith(registry, [
      fakeSource('config:local', 'config', [
        {
          id: 'deepseek-flash',
          provider: 'deepseek',
          // 管理员修正：官方页把窗口写错了，我们按实测改
          context_window: 1_310_720,
          description: '管理员补的描述',
        },
      ]),
    ]);
    // 加载（配置层写回发生在 ready() 里；再显式调一次证明幂等）
    await catalog.ready();
    catalog.applyConfigOverrides();

    // 写回矩阵 → 路由看到的也是新值
    const after = registry.find('deepseek.openai-chat', 'deepseek-flash', 'chat');
    expect(after?.context_window).toBe(1_310_720);
    // 响应里同样是新值，且 provenance 标明是管理员改的
    const flash = await catalog.get('deepseek-flash');
    expect(flash?.context_window).toBe(1_310_720);
    expect(flash?.provenance.fields['context_window']).toBe('config:local');
    expect(flash?.description).toBe('管理员补的描述');
    expect(flash?.provenance.fields['description']).toBe('config:local');
  });

  it('provenance.layers 记录每层是否贡献 + fetched_at', async () => {
    const registry = deepseekOnlyRegistry();
    const catalog = catalogWith(registry, [
      createModelsDevSource({ clock: fixedClock(T0) }),
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
    const flash = await catalog.get('deepseek-flash');
    const layers = flash?.provenance.layers ?? [];
    expect(layers.map((l) => l.sourceId)).toEqual([
      'offline:models.dev',
      'offline:deepseek-static',
    ]);
    expect(layers.every((l) => l.contributed)).toBe(true);
    expect(layers.every((l) => l.layer === 'offline')).toBe(true);
    expect(flash?.provenance.stale).toBe(false);
  });
});

describe('ModelCatalog · 与能力矩阵单一事实来源', () => {
  it('上游 /models 刷新矩阵后，/v1/models 的窗口跟着变（同一份数据，两个消费者）', async () => {
    // 真实上游源（DeepSeekModelDiscovery + ScriptedTransport），返回一个改过窗口的 /models
    const registry = deepseekOnlyRegistry();
    const discovery = new DeepSeekModelDiscovery({
      transport: new ScriptedTransport([
        {
          body: JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'deepseek-flash',
                object: 'model',
                owned_by: 'deepseek',
                name: 'DeepSeek-V4.1-Flash',
                context_window: 2_097_152,
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
                brand_new_upstream_field: 'x',
              },
            ],
          }),
        },
      ]),
      headersProvider: async () => ({ authorization: 'Bearer test-not-a-real-key' }),
    });
    const { createDeepSeekUpstreamSource } = await import('../providers/deepseek/index.js');
    const upstreamSource = createDeepSeekUpstreamSource({
      discovery,
      capabilityRegistry: registry,
      clock: fixedClock(T0),
    });

    // 目录通过 UpstreamSnapshotProvider 读上游层状态（同步服务生产它，这里手工喂）
    const upstreamState: Array<ReturnType<typeof upstreamStateOf>> = [];
    const catalog = catalogWith(
      registry,
      [
        createModelsDevSource({ clock: fixedClock(T0) }),
        createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
      ],
      { upstream: { states: () => upstreamState } },
    );
    // 同步前：矩阵种子值
    expect((await catalog.get('deepseek-flash'))?.context_window).toBe(1_048_576);

    const snapshot = await upstreamSource.load();
    expect(snapshot.models[0]?.name).toBe('DeepSeek-V4.1-Flash');
    expect(snapshot.models[0]?.raw?.['brand_new_upstream_field']).toBe('x');
    upstreamState.push(upstreamStateOf(snapshot));

    // 同步后：矩阵被刷新 → 目录跟着变（不需要改目录任何代码）
    const after = await catalog.get('deepseek-flash');
    expect(after?.context_window).toBe(2_097_152);
    expect(after?.provenance.fields['context_window']).toBe('capability-matrix');
    // 上游的名字压过 models.dev 静态名
    expect(after?.name).toBe('DeepSeek-V4.1-Flash');
    expect(after?.provenance.fields['name']).toBe(DEEPSEEK_UPSTREAM_SOURCE_ID);
    // 约束仍按 (model, dialect) 只贴 Anthropic 面
    expect(after?.constraints?.map((c) => c.dialect)).toEqual(['anthropic.messages']);
    expect(
      after?.access_paths?.every(
        (p) => p.constraints === undefined || p.format === 'anthropic.messages',
      ),
    ).toBe(true);
  });

  it('access_paths[] 的能力/限额差异：API key 路径 vs 订阅 OAuth 路径', async () => {
    const registry = deepseekOnlyRegistry();
    const catalog = new ModelCatalog({
      capabilityRegistry: registry,
      sources: [],
      clock: fixedClock(T0),
      providerResolver: providerResolverFromRouteTable(defaultRouteTable()),
      credentialLister: (accessPath) => {
        if (accessPath === 'deepseek.anthropic-messages') {
          // 假装这条路径上登记了一条订阅凭据（OAuth device code）
          return { requires_credential: true, credentials: [{ type: 'oauth_device_code' }] };
        }
        return { requires_credential: true, credentials: [{ type: 'api_key' }] };
      },
    });
    const flash = await catalog.get('deepseek-flash');
    const paths = flash?.access_paths ?? [];
    const apiKeyPath = paths.find((p) => p.access_path === 'deepseek.openai-chat');
    const oauthPath = paths.find((p) => p.access_path === 'deepseek.anthropic-messages');
    expect(apiKeyPath?.credential?.kind).toBe('api-key');
    expect(apiKeyPath?.cash_pricing).toBe('api');
    expect(oauthPath?.credential?.kind).toBe('subscription-oauth');
    // 订阅路径：现金恒 0，as_api 照算（60 §4.1 双口径）
    expect(oauthPath?.cash_pricing).toBe('subscription');
    // 两条路径的 unsupported_parameters 不同（矩阵各自登记）
    expect(apiKeyPath?.unsupported_parameters).toContain('params.user');
    expect(oauthPath?.unsupported_parameters).toContain('cache_control');
  });

  it('supported_parameters 由矩阵的 unsupported_fields 反推（不手抄第二份）', async () => {
    const registry = deepseekOnlyRegistry();
    const catalog = catalogWith(registry, []);
    const flash = await catalog.get('deepseek-flash');
    const supported = flash?.supported_parameters ?? [];
    // openai-chat 面声明不支持这三个（matrix.unsupported_fields）
    expect(supported).not.toContain('params.response_format.json_schema');
    expect(supported).not.toContain('params.frequency_penalty');
    expect(supported).not.toContain('params.user');
    // anthropic 面声明不支持 cache_control → 并集也不含
    expect(supported).not.toContain('cache_control');
    expect(supported).toContain('params.temperature');
    expect(supported).toContain('thinking.effort');
  });
});

describe('ModelCatalog · 离线兜底与容错', () => {
  it('离线层整体缺失（vendored JSON 损坏）时端点仍返回矩阵种子值', async () => {
    const registry = deepseekOnlyRegistry();
    const broken: ModelMetadataSource = {
      id: 'offline:models.dev',
      layer: 'offline',
      async load(): Promise<ModelMetadataSnapshot> {
        throw new Error('models.dev 快照不是合法 JSON');
      },
    };
    const catalog = catalogWith(registry, [
      broken,
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
    const list = await catalog.list();
    expect(list.data.map((r) => r.id).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    const flash = list.data.find((r) => r.id === 'deepseek-flash');
    // 运行时字段一个不少（全来自矩阵）
    expect(flash?.context_window).toBe(1_048_576);
    expect(flash?.effort?.default).toBe('high');
    expect(flash?.constraints?.[0]?.system_prompt_update).toBe('in-history');
    // 离线静态字段缺席，provenance 里该层标 error
    expect(flash?.family).toBeUndefined();
    const layer = flash?.provenance.layers.find((l) => l.sourceId === 'offline:models.dev');
    expect(layer?.error).toContain('models.dev 快照不是合法 JSON');
  });

  it('两层全挂也照样能答（只剩矩阵）', async () => {
    const registry = deepseekOnlyRegistry();
    const boom: ModelMetadataSource = {
      id: 'offline:x',
      layer: 'offline',
      async load(): Promise<ModelMetadataSnapshot> {
        throw new Error('boom');
      },
    };
    const catalog = catalogWith(registry, [boom]);
    const list = await catalog.list();
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(2);
  });

  it('上游层失败 → 记录标 stale + last_successful_fetch，但值仍是 last-known-good', async () => {
    const registry = deepseekOnlyRegistry();
    const upstream = {
      states: () => [
        {
          sourceId: DEEPSEEK_UPSTREAM_SOURCE_ID,
          layer: 'upstream' as const,
          snapshot: {
            sourceId: DEEPSEEK_UPSTREAM_SOURCE_ID,
            fetchedAt: T0 - 7_200_000,
            models: [{ id: 'deepseek-flash', provider: 'deepseek', name: '旧但可用' }],
          },
          stale: true,
          lastSuccessAt: T0 - 7_200_000,
          lastError: 'DeepSeek /models 返回 503',
        },
      ],
    };
    const catalog = catalogWith(registry, [], { clock: T0, upstream });
    const flash = await catalog.get('deepseek-flash');
    expect(flash?.provenance.stale).toBe(true);
    expect(flash?.provenance.last_successful_fetch).toBe(T0 - 7_200_000);
    expect(flash?.provenance.last_error).toContain('503');
    // last-known-good 的字段仍在
    expect(flash?.name).toBe('旧但可用');
    // 上游层在 layers 里可见（含 stale 与 error）
    const layer = flash?.provenance.layers.find((l) => l.sourceId === DEEPSEEK_UPSTREAM_SOURCE_ID);
    expect(layer?.stale).toBe(true);
    expect(layer?.contributed).toBe(true);
  });
});

describe('ModelCatalog · 过滤与排序', () => {
  async function fullCatalog(): Promise<ModelCatalog> {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of defaultCapabilities()) registry.register(entry);
    return catalogWith(registry, [
      createModelsDevSource({ clock: fixedClock(T0) }),
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
  }

  it('默认只列可路由模型，退役别名不在列表里', async () => {
    const catalog = await fullCatalog();
    const list = await catalog.list();
    const ids = list.data.map((r) => r.id).sort();
    expect(ids).toEqual([
      'claude-sonnet-4-5',
      'claude-test-1',
      'deepseek-flash',
      'deepseek-v4-pro',
      'gpt-4o',
      'gpt-test-1',
    ]);
    expect(ids).not.toContain('deepseek-chat');
    expect(ids).not.toContain('deepseek-reasoner');
  });

  it('include_retired=true 才列出退役别名', async () => {
    const catalog = await fullCatalog();
    const list = await catalog.list({ include_retired: true });
    expect(list.data.map((r) => r.id)).toContain('deepseek-chat');
    const retired = list.data.find((r) => r.id === 'deepseek-chat');
    expect(retired?.retired?.succeeded_by).toBe('deepseek-flash');
    expect(retired?.retired?.note).toContain('2026-07-24');
  });

  it('按 provider / 模态 / 能力 / 上下文长度过滤', async () => {
    const catalog = await fullCatalog();

    const deepseek = await catalog.list({ provider: 'deepseek' });
    expect(deepseek.data.map((r) => r.id).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);

    const vision = await catalog.list({ capability: ['vision'] });
    // flash 支持图像；models.dev 的 gpt-4o / claude-sonnet-4-5 也 attachment
    expect(vision.data.map((r) => r.id).sort()).toEqual([
      'claude-sonnet-4-5',
      'deepseek-flash',
      'gpt-4o',
    ]);

    const bigContext = await catalog.list({ min_context_window: 1_000_000 });
    expect(bigContext.data.map((r) => r.id).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);

    const anthropicFormat = await catalog.list({ format: 'anthropic.messages' });
    expect(anthropicFormat.data.map((r) => r.id).sort()).toEqual([
      'claude-sonnet-4-5',
      'claude-test-1',
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);

    const byAccessPath = await catalog.list({ access_path: 'deepseek.anthropic-messages' });
    expect(byAccessPath.data.map((r) => r.id).sort()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
  });

  it('按支持的参数过滤', async () => {
    const catalog = await fullCatalog();
    // DeepSeek 不支持 params.user（矩阵 unsupported_fields）
    const withUser = await catalog.list({ parameter: ['params.user'] });
    expect(withUser.data.map((r) => r.id)).not.toContain('deepseek-flash');
    const withJsonSchema = await catalog.list({
      parameter: ['params.response_format.json_schema'],
    });
    expect(withJsonSchema.data.map((r) => r.id)).not.toContain('deepseek-flash');
    expect(withJsonSchema.data.map((r) => r.id)).toContain('gpt-4o');
  });

  it('排序：context_window 降序 + 默认按 id', async () => {
    const catalog = await fullCatalog();
    const desc = await catalog.list({ sort: '-context_window' });
    const windows = desc.data.map((r) => r.context_window ?? -1);
    expect(windows).toEqual([...windows].sort((a, b) => b - a));
    expect(desc.data[0]?.id).toBe('deepseek-flash');

    const asc = await catalog.list();
    expect(asc.data.map((r) => r.id)).toEqual([...asc.data.map((r) => r.id)].sort());
  });

  it('limit / offset 分页 + has_more', async () => {
    const catalog = await fullCatalog();
    const page1 = await catalog.list({ limit: 2, sort: 'id' });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(6);
    expect(page1.has_more).toBe(true);
    const page2 = await catalog.list({ limit: 2, offset: 2, sort: 'id' });
    expect(page2.data.map((r) => r.id)).not.toEqual(page1.data.map((r) => r.id));
  });

  it('q 子串搜索命中 id / name / description', async () => {
    const catalog = await fullCatalog();
    const hits = await catalog.list({ q: 'flash' });
    expect(hits.data.map((r) => r.id)).toContain('deepseek-flash');
    const misses = await catalog.list({ q: 'zzz-不存在的模型' });
    expect(misses.data).toHaveLength(0);
  });

  it('非法排序键抛 ModelQueryError（不静默忽略）', async () => {
    const catalog = await fullCatalog();
    await expect(catalog.list({ sort: 'bogus' })).rejects.toBeInstanceOf(ModelQueryError);
  });

  it('created 由 release_date 推导（OpenAI 的 epoch 秒口径）', async () => {
    const catalog = await fullCatalog();
    const flash = await catalog.get('deepseek-flash');
    expect(flash?.release_date).toBe('2026-10-17');
    expect(flash?.created).toBe(Math.floor(Date.parse('2026-10-17T00:00:00Z') / 1000));
    // 没有 release_date 的模型（mock）不造 created
    const mock = await catalog.get('gpt-test-1');
    expect(mock?.created).toBeUndefined();
  });
});

describe('ModelCatalog · access path provider 解析', () => {
  it('mock-anthropic 这种不遵守点号约定的 id 从路由表推 provider', async () => {
    const registry = new InMemoryCapabilityRegistry();
    const entry: CapabilityEntry = {
      access_path: 'mock-anthropic',
      model: 'claude-test-1',
      modality: 'chat',
      format: 'anthropic.messages',
      usage_source: 'provider',
      contract_tested: true,
      status: 'implemented',
    };
    registry.register(entry);
    const catalog = catalogWith(registry, []);
    const record = await catalog.get('claude-test-1');
    expect(record?.provider).toBe('mock');
    expect(record?.owned_by).toBe('mock');
  });

  it('路由表里没有的 access path 回落到点号前缀约定', async () => {
    const registry = new InMemoryCapabilityRegistry();
    registry.register({
      access_path: 'somevendor.chat',
      model: 'm1',
      modality: 'chat',
      format: 'openai.chat',
      usage_source: 'provider',
      contract_tested: true,
      status: 'implemented',
    });
    const catalog = catalogWith(registry, []);
    expect((await catalog.get('m1'))?.provider).toBe('somevendor');
  });
});
