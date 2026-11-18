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
  opts: { clock?: number; upstream?: unknown; providerAvailability?: (p: string) => boolean } = {},
): ModelCatalog {
  return new ModelCatalog({
    capabilityRegistry: registry,
    sources,
    clock: fixedClock(opts.clock ?? T0),
    providerResolver: providerResolverFromRouteTable(defaultRouteTable()),
    ...(opts.upstream === undefined ? {} : { upstream: opts.upstream as never }),
    ...(opts.providerAvailability === undefined
      ? {}
      : { providerAvailability: opts.providerAvailability }),
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
    const list = await catalog.list({ expand: ['provenance', 'constraints'] });
    // 四个 deepseek 条目 = 2 chat 模型 × 2 dialect + 2 个音频端点
    // （deepseek-tts / deepseek-asr，见 providers/deepseek/audio-models.ts）
    expect(list.data.map((r) => r.id).sort()).toEqual([
      'deepseek-asr',
      'deepseek-flash',
      'deepseek-tts',
      'deepseek-v4-pro',
    ]);
    const flash = list.data.find((r) => r.id === 'deepseek-flash');
    // 运行时字段一个不少（全来自矩阵）
    expect(flash?.context_window).toBe(1_048_576);
    expect(flash?.effort?.default).toBe('high');
    expect(flash?.constraints?.[0]?.system_prompt_update).toBe('in-history');
    // 离线静态字段缺席，provenance 里该层标 error
    expect(flash?.family).toBeUndefined();
    const layer = flash?.provenance?.layers.find((l) => l.sourceId === 'offline:models.dev');
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
    // 只剩矩阵：2 chat × 2 dialect + 2 音频端点（见 deepseekAudioCapabilities）
    expect(list.data).toHaveLength(4);
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
    // mock 两条（gpt-test-1 / claude-test-1）是内部脚手架，永不出现在默认清单里
    // （ir/capability.ts 的 `internal` 字段）——它们是演示替身，不是可调用的上游
    // （MiMo 的 6 条 2026-11 接入：2 chat + 3 tts 变体 + 1 asr。）
    expect(ids).toEqual([
      'claude-sonnet-4-5',
      // 音频端点两个条目（deepseek-tts / deepseek-asr）：它们是可路由的真能力
      'deepseek-asr',
      'deepseek-flash',
      'deepseek-tts',
      'deepseek-v4-pro',
      'gpt-4o',
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.6-flash',
      'mimo-v2.6-pro',
    ]);
    expect(ids).not.toContain('gpt-test-1');
    expect(ids).not.toContain('claude-test-1');
    expect(ids).not.toContain('deepseek-chat');
    expect(ids).not.toContain('deepseek-reasoner');
  });

  it('include_internal=true 才列出 mock 脚手架（默认隐藏）', async () => {
    const catalog = await fullCatalog();
    const hidden = await catalog.list();
    expect(hidden.data.map((r) => r.id)).not.toContain('gpt-test-1');
    const shown = await catalog.list({ include_internal: true });
    expect(shown.data.map((r) => r.id).sort()).toContain('gpt-test-1');
    expect(shown.data.map((r) => r.id).sort()).toContain('claude-test-1');
    // 详情端点不过滤：内部条目仍可查到（调试用），只是默认不进列表
    expect((await catalog.get('gpt-test-1'))?.access_paths?.[0]?.internal).toBe(true);
  });

  it('include_retired=true 才列出退役别名', async () => {
    const catalog = await fullCatalog();
    const list = await catalog.list({ include_retired: true, expand: ['retired'] });
    expect(list.data.map((r) => r.id)).toContain('deepseek-chat');
    const retired = list.data.find((r) => r.id === 'deepseek-chat');
    expect(retired?.retired?.succeeded_by).toBe('deepseek-flash');
    expect(retired?.retired?.note).toContain('2026-07-24');
  });

  it('按 provider / 模态 / 能力 / 上下文长度过滤', async () => {
    const catalog = await fullCatalog();

    const deepseek = await catalog.list({ provider: 'deepseek' });
    expect(deepseek.data.map((r) => r.id).sort()).toEqual([
      'deepseek-asr',
      'deepseek-flash',
      'deepseek-tts',
      'deepseek-v4-pro',
    ]);

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
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);

    const byAccessPath = await catalog.list({ access_path: 'deepseek.anthropic-messages' });
    expect(byAccessPath.data.map((r) => r.id).sort()).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
  });

  it('工具端点可按模态种类过滤（asr / tts 与 chat 模型分开）', async () => {
    const catalog = await fullCatalog();
    // 工具端点没有 input/output 模态可言，判据是 access path 的 modality——
    // 它在紧凑字段集里（modalities），且可过滤
    const asr = await catalog.list({ modality: ['asr'] });
    expect(asr.data.map((r) => r.id).sort()).toEqual(['deepseek-asr', 'mimo-v2.5-asr']);
    expect(asr.data[0]?.modalities).toEqual(['asr']);
    const tts = await catalog.list({ modality: ['tts'] });
    expect(tts.data.map((r) => r.id).sort()).toEqual([
      'deepseek-tts',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
    ]);
    const chat = await catalog.list({ modality: ['chat'] });
    expect(chat.data.map((r) => r.id).sort()).not.toContain('deepseek-asr');
    expect(chat.data.map((r) => r.id).sort()).toContain('deepseek-flash');
    // 输入模态词表照旧（text / image）
    const text = await catalog.list({ modality: ['text'] });
    expect(text.data.map((r) => r.id).sort()).toContain('deepseek-v4-pro');
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
    // 12 = 2 chat × 2 dialect + openai / anthropic 各 1 + 音频端点两个条目（DeepSeek）
    // + MiMo 6 条（2 chat + 3 tts 变体 + 1 asr）。
    // mock 两条是内部脚手架，默认不列（见 `include_internal` 那条用例）
    expect(page1.total).toBe(12);
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

// ---------------------------------------------------------------------------
// 部署态过滤：未配置 provider 的模型默认不列（判据由装配方注入，见
// composition-root.ts 的 providerAvailabilityResolver——那里读真实渠道表 + 凭据库）
// ---------------------------------------------------------------------------

describe('ModelCatalog · 按"已配置 provider"过滤', () => {
  /** 只配了 deepseek 的部署：openai / anthropic / mock 都没配。 */
  const onlyDeepseek = (provider: string): boolean => provider === 'deepseek';

  async function deployedCatalog(availability = onlyDeepseek): Promise<ModelCatalog> {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of defaultCapabilities()) registry.register(entry);
    return catalogWith(
      registry,
      [
        createModelsDevSource({ clock: fixedClock(T0) }),
        createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
      ],
      { providerAvailability: availability },
    );
  }

  it('默认只列已配置 provider 的模型', async () => {
    const catalog = await deployedCatalog();
    const ids = (await catalog.list()).data.map((r) => r.id).sort();
    // 只配了 DeepSeek → 只剩 deepseek 四条；openai / anthropic 来自 models.dev 离线层，
    // 那两个 provider 根本没配渠道（mock 另有 internal 判据，也不列）
    expect(ids).toEqual(['deepseek-asr', 'deepseek-flash', 'deepseek-tts', 'deepseek-v4-pro']);
    expect(ids).not.toContain('gpt-4o');
    expect(ids).not.toContain('claude-sonnet-4-5');
  });

  it('未配置的记录带 availability 标记（省略 = 已配置，不制造噪声）', async () => {
    const catalog = await deployedCatalog();
    const configured = (await catalog.list()).data.find((r) => r.id === 'deepseek-flash');
    // 已配置是常态：这个键**不出现**（不是 configured:true）
    expect(configured?.availability).toBeUndefined();
    const unconfigured = (await catalog.list({ include_unconfigured: true })).data.find(
      (r) => r.id === 'gpt-4o',
    );
    expect(unconfigured?.availability).toBe('unconfigured');
  });

  it('include_unconfigured=true 才列出未配置 provider 的模型', async () => {
    const catalog = await deployedCatalog();
    const all = (await catalog.list({ include_unconfigured: true })).data.map((r) => r.id).sort();
    expect(all).toContain('gpt-4o');
    expect(all).toContain('claude-sonnet-4-5');
    expect(all).toContain('deepseek-flash');
    // mock 两条仍不列：它们是 internal，与"配没配"是两条独立的判据
    expect(all).not.toContain('gpt-test-1');
  });

  it('详情端点不过滤：未配置的模型查得到，且带标记（不是干 404）', async () => {
    const catalog = await deployedCatalog();
    const record = await catalog.get('gpt-4o');
    expect(record).toBeDefined();
    expect(record?.availability).toBe('unconfigured');
    expect(record?.context_window).toBe(128_000);
  });

  it('全都没配时列表为空（不猜"也许能调通"）', async () => {
    const catalog = await deployedCatalog(() => false);
    expect((await catalog.list()).data).toHaveLength(0);
    expect((await catalog.list()).total).toBe(0);
  });

  it('不注入 providerAvailability = 不过滤（目录对部署状态没有先验）', async () => {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of defaultCapabilities()) registry.register(entry);
    const catalog = catalogWith(registry, [createModelsDevSource({ clock: fixedClock(T0) })]);
    const ids = (await catalog.list()).data.map((r) => r.id).sort();
    expect(ids).toContain('gpt-4o');
    expect(ids).toContain('claude-sonnet-4-5');
  });

  it('provider 可用性只问一次（同一 provider 多条记录不重复提问）', async () => {
    const asked: string[] = [];
    const catalog = await deployedCatalog((provider) => {
      asked.push(provider);
      return provider === 'deepseek';
    });
    await catalog.list();
    // 每个 provider 恰好一次（没配的那几个也要问，问完才标记）。
    // mimo 2026-11 接入：它有 6 条矩阵记录（2 chat + 3 tts + 1 asr），但只问一次。
    expect([...asked].sort()).toEqual(['anthropic', 'deepseek', 'mimo', 'mock', 'openai']);
  });
});

// ---------------------------------------------------------------------------
// 紧凑字段集：列表默认不返回 provenance / access_paths / 剪过的 pricing 规则
// ---------------------------------------------------------------------------

describe('ModelCatalog · 列表紧凑字段集', () => {
  async function fullCatalog(): Promise<ModelCatalog> {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of defaultCapabilities()) registry.register(entry);
    return catalogWith(registry, [
      createModelsDevSource({ clock: fixedClock(T0) }),
      createDeepSeekCatalogSource({ clock: fixedClock(T0) }),
    ]);
  }

  it('默认不带 provenance / access_paths / quirks / raw', async () => {
    const catalog = await fullCatalog();
    const flash = (await catalog.list()).data.find((r) => r.id === 'deepseek-flash');
    expect(flash).toBeDefined();
    // 重字段一个都不在（它们是排障用的，详情端点与 ?expand= 才有）
    expect(flash).not.toHaveProperty('provenance');
    expect(flash).not.toHaveProperty('access_paths');
    expect(flash).not.toHaveProperty('raw');
    expect(flash).not.toHaveProperty('supported_parameters');
    expect(flash).not.toHaveProperty('constraints');
    expect(flash).not.toHaveProperty('benchmarks');
    expect(flash).not.toHaveProperty('description');
    // 挑模型用得上的字段都在
    expect(flash?.id).toBe('deepseek-flash');
    expect(flash?.object).toBe('model');
    expect(flash?.owned_by).toBe('deepseek');
    expect(flash?.provider).toBe('deepseek');
    expect(flash?.name).toBeDefined();
    expect(flash?.context_window).toBe(1_048_576);
    expect(flash?.modalities).toEqual(['chat']);
    expect(flash?.tool_call).toBe(true);
    expect(flash?.effort?.default).toBe('high');
    expect(flash?.pricing?.rates).toBeDefined();
  });

  it('OpenAI 兼容四键永远在（老客户端只读 data[].id 不受影响）', async () => {
    const catalog = await fullCatalog();
    for (const item of (await catalog.list()).data) {
      expect(typeof item.id).toBe('string');
      expect(item.object).toBe('model');
      expect(typeof item.owned_by).toBe('string');
      expect(typeof item.provider).toBe('string');
    }
  });

  it('紧凑 pricing 剪掉峰谷规则与节假日，只留费率与出处', async () => {
    const catalog = await fullCatalog();
    const flash = (await catalog.list()).data.find((r) => r.id === 'deepseek-flash');
    expect(flash?.pricing?.rates).toBeDefined();
    expect(flash?.pricing?.tiers).toEqual([]);
    expect(flash?.pricing?.rule_sets).toEqual([]);
    expect(flash?.pricing?.holidays).toBeUndefined();
    expect(flash?.pricing?.as_api_reference).toBeUndefined();
    expect(flash?.pricing?.tools).toBeUndefined();
  });

  it('expand=pricing / expand=all 拿回全量（一行没丢）', async () => {
    const catalog = await fullCatalog();
    const pruned = (await catalog.list()).data.find((r) => r.id === 'deepseek-flash');
    const full = (await catalog.list({ expand: ['pricing'] })).data.find(
      (r) => r.id === 'deepseek-flash',
    );
    expect(full?.pricing?.tiers.length).toBeGreaterThan(0);
    expect(full?.pricing?.rule_sets.length).toBeGreaterThan(0);
    expect(full?.pricing?.holidays?.holidays.length).toBeGreaterThan(0);
    expect(full?.pricing?.rates).toEqual(pruned?.pricing?.rates);

    const everything = (await catalog.list({ expand: ['all'] })).data.find(
      (r) => r.id === 'deepseek-flash',
    );
    expect(everything?.provenance?.fields['context_window']).toBe('capability-matrix');
    expect(everything?.access_paths?.[0]?.quirks?.length).toBeGreaterThan(0);
  });

  it('expand 分组各自独立（要 provenance 不会顺带把 quirks 带回来）', async () => {
    const catalog = await fullCatalog();
    const only = (await catalog.list({ expand: ['provenance'] })).data.find(
      (r) => r.id === 'deepseek-flash',
    );
    expect(only?.provenance?.layers.length).toBeGreaterThan(0);
    expect(only).not.toHaveProperty('access_paths');
    expect(only).not.toHaveProperty('raw');
  });

  it('fields= 显式白名单：点菜给菜，不多给', async () => {
    const catalog = await fullCatalog();
    const picked = (await catalog.list({ fields: ['id', 'context_window'] })).data.find(
      (r) => r.id === 'deepseek-flash',
    );
    expect(Object.keys(picked ?? {}).sort()).toEqual([
      'context_window',
      'created',
      'id',
      'object',
      'owned_by',
      'provider',
    ]);
    // 显式点 pricing 就给全量（不是剪过的摘要）
    const withPricing = (await catalog.list({ fields: ['id', 'pricing'] })).data.find(
      (r) => r.id === 'deepseek-flash',
    );
    expect(withPricing?.pricing?.tiers.length).toBeGreaterThan(0);
  });

  it('紧凑集显著小于全量（这是这次改动的目的）', async () => {
    const catalog = await fullCatalog();
    const compact = JSON.stringify((await catalog.list()).data);
    const full = JSON.stringify((await catalog.list({ expand: ['all'] })).data);
    expect(compact.length).toBeLessThan(full.length / 3);
  });
});
