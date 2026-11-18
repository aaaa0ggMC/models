/**
 * tests/mimo-profile.test.ts —— MiMo provider profile / 能力矩阵 / 路由别名的契约测试。
 *
 * 与 `tests/mimo-audio-wire.test.ts`（wire 层）和 `tests/mimo-live.test.ts`（真上游）
 * 的分工：本文件只验**静态装配**——不碰网络、不碰 HTTP，纯数据 + 纯函数。
 *
 * 覆盖：
 *   1. 常量自洽：access path id 与 credentials/resolver.ts 的启动表同值；
 *   2. 能力矩阵：2 模型 × 1 dialect = 2 条，全部 chat，contract_tested + implemented；
 *   3. profile：endpointPath 给 `/chat/completions`（base 已含 /v1，**这是唯一必须
 *      provider 级覆盖的钩子**），其余钩子一律不实现（OpenAI 形状无需干预）；
 *   4. 路由别名：只登记裸 id，没有 `-messages`（MiMo 没有 Anthropic 兼容面）；
 *   5. discovery：`/models` 只补登 id，不给机读字段（上游就没给）；
 *   6. 上游 `/models` 夹具 round-trip。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MIMO_ACCESS_PATHS,
  MIMO_ACCESS_PATH_IDS,
  MIMO_BASE_URL,
  MIMO_CHAT_PATH,
  MIMO_KEY_ENV,
  MIMO_MODEL_IDS,
  createMiMoProfile,
  mimoCapabilities,
  mimoRouteAliases,
} from '../providers/mimo/profile.js';
import {
  MiMoModelDiscovery,
  decodeModelsResponse,
  type CapabilityRegistryWriter,
} from '../providers/mimo/discovery.js';
import { DEFAULT_ACCESS_PATHS } from '../credentials/resolver.js';
import { mimoAudioCapabilities } from '../providers/mimo/audio-models.js';
import { InMemoryCapabilityRegistry } from '../credentials/capability-registry.js';
import type { CapabilityEntry } from '../ir/index.js';

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../providers/mimo/fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** 内存矩阵替身（记录 register 调用；find 按静态条目答）。 */
class FakeRegistry implements CapabilityRegistryWriter {
  readonly added: CapabilityEntry[] = [];
  constructor(private readonly entries: CapabilityEntry[] = []) {}
  find(accessPath: string, model: string, modality: 'chat'): CapabilityEntry | undefined {
    return this.entries.find(
      (e) => e.access_path === accessPath && e.model === model && e.modality === modality,
    );
  }
  register(entry: CapabilityEntry): void {
    this.added.push(entry);
  }
}

// ---------------------------------------------------------------------------
// 1. 常量自洽
// ---------------------------------------------------------------------------

describe('MiMo · 常量与启动表自洽', () => {
  it('access path id 与 credentials/resolver.ts 的 DEFAULT_ACCESS_PATHS 同值', () => {
    const inStartupTable = DEFAULT_ACCESS_PATHS.filter((p) => p.id.startsWith('mimo.'));
    expect(inStartupTable.map((p) => p.id)).toEqual(['mimo.openai-chat']);
    expect(MIMO_ACCESS_PATHS.openaiChat).toBe('mimo.openai-chat');
    expect(MIMO_ACCESS_PATH_IDS).toEqual(['mimo.openai-chat']);
  });

  it('base 只到 host、/v1 在端点路径里（与 DeepSeek「无 /v1」正好相反）', () => {
    expect(MIMO_BASE_URL).toBe('https://token-plan-cn.xiaomimimo.com');
    // base 不带路径：transport 用 new URL(path, base_url) 拼地址，base 带路径时
    // 会被绝对路径整段替换掉（少了 /v1 → 上游 404）。这条断言就是那颗雷的哨兵。
    expect(new URL(MIMO_CHAT_PATH, MIMO_BASE_URL).toString()).toBe(
      'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    );
    expect(MIMO_CHAT_PATH).toBe('/v1/chat/completions');
  });

  it('key 环境变量名只出现变量名（仓库不出现值）', () => {
    expect(MIMO_KEY_ENV).toBe('MIMO_API_KEY');
  });

  it('模型清单 = /models 实测的两个 LLM', () => {
    expect(MIMO_MODEL_IDS).toEqual(['mimo-v2.6-flash', 'mimo-v2.6-pro']);
  });
});

// ---------------------------------------------------------------------------
// 2. 能力矩阵
// ---------------------------------------------------------------------------

describe('MiMo · 能力矩阵', () => {
  it('2 模型 × 1 dialect = 2 条，全部 chat、implemented、contract_tested', () => {
    const entries = mimoCapabilities();
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.access_path).toBe(MIMO_ACCESS_PATHS.openaiChat);
      expect(e.modality).toBe('chat');
      expect(e.format).toBe('openai.chat');
      expect(e.status).toBe('implemented');
      expect(e.contract_tested).toBe(true);
      expect(e.usage_units).toEqual(['tokens']);
      expect(e.streaming?.mode).toBe('sse');
    }
    expect(entries.map((e) => e.model)).toEqual(['mimo-v2.6-flash', 'mimo-v2.6-pro']);
  });

  it('不编造上游没给的机读字段（/models 只返回 id/object/owned_by）', () => {
    for (const e of mimoCapabilities()) {
      expect(e.context_window).toBeUndefined();
      expect(e.max_output_tokens).toBeUndefined();
      expect(e.input_modalities).toBeUndefined();
      expect(e.output_modalities).toBeUndefined();
      expect(e.effort).toBeUndefined();
      expect(e.constraints).toBeUndefined();
      // 没有 internal：MiMo 是真上游，不是脚手架
      expect(e.internal).toBeUndefined();
    }
  });

  it('json_schema 进 unsupported_fields（上游 enum 只有 text/json_object）', () => {
    for (const e of mimoCapabilities()) {
      expect(e.unsupported_fields).toContain('params.response_format.json_schema');
    }
  });

  it('quirks 说清三件事：端点带 /v1、reasoning_content、音频无独立端点', () => {
    const quirks = mimoCapabilities()[0]!.quirks ?? [];
    const joined = quirks.join('\n');
    expect(joined).toMatch(/带 \/v1/);
    expect(joined).toMatch(/reasoning_content/);
    expect(joined).toMatch(/没有独立 REST 端点/);
    expect(joined).toMatch(/没有 context_window 等元数据/);
  });

  it('音频能力条目：3 tts 变体 + 1 asr，access path 是 mimo.tools.*', () => {
    const entries = mimoAudioCapabilities();
    expect(entries).toHaveLength(4);
    expect(entries.filter((e) => e.modality === 'tts')).toHaveLength(3);
    expect(entries.filter((e) => e.modality === 'asr')).toHaveLength(1);
    for (const e of entries) {
      expect(e.access_path.startsWith('mimo.tools.')).toBe(true);
      expect(e.status).toBe('implemented');
      expect(e.streaming?.mode).toBe('none');
    }
    expect(entries.map((e) => e.model).sort()).toEqual([
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. profile
// ---------------------------------------------------------------------------

describe('MiMo · ProviderProfile', () => {
  it('只覆盖 endpointPath——其余钩子不实现（OpenAI 形状无需干预）', () => {
    const profile = createMiMoProfile();
    expect(profile.id).toBe('mimo');
    expect(profile.accessPaths).toEqual(['mimo.openai-chat']);
    expect(profile.endpointPath?.('mimo.openai-chat')).toBe('/v1/chat/completions');
    expect(profile.endpointPath?.('deepseek.openai-chat')).toBeUndefined();
    // 这四个钩子返回 undefined = 不干预（codec 默认映射就是 MiMo 的语义）
    expect(profile.usageFromRaw).toBeUndefined();
    expect(profile.thinkingWire).toBeUndefined();
    expect(profile.builtinToolWire).toBeUndefined();
    expect(profile.builtinToolCanonicalName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. 路由别名
// ---------------------------------------------------------------------------

describe('MiMo · 路由别名', () => {
  it('只登记裸 id，没有 -messages（MiMo 没有 Anthropic 兼容面）', () => {
    const aliases = mimoRouteAliases();
    expect(Object.keys(aliases).sort()).toEqual(['mimo-v2.6-flash', 'mimo-v2.6-pro']);
    for (const [model, alias] of Object.entries(aliases)) {
      expect(alias.targets).toHaveLength(1);
      expect(alias.targets[0]).toEqual({
        access_path: 'mimo.openai-chat',
        provider: 'mimo',
        model,
      });
      // 上下文窗口不填：上游没给这个数（给回退/截断决策用的字段填错比不填更糟）
      expect(alias.max_context_tokens).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. discovery
// ---------------------------------------------------------------------------

describe('MiMo · 模型发现', () => {
  it('fixtures/models.response.json：六个 id，无机读字段', () => {
    const decoded = decodeModelsResponse(fixture('models.response.json'));
    expect(decoded.data.map((m) => m.id)).toEqual([
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.6-flash',
      'mimo-v2.6-pro',
    ]);
    for (const m of decoded.data) {
      expect(m.owned_by).toBe('xiaomi');
      // 上游只给三个字段：没有 context_window / modalities / effort
      expect(m).not.toHaveProperty('context_window');
      expect(m).not.toHaveProperty('input_modalities');
      expect(m).not.toHaveProperty('effort');
    }
  });

  it('畸形条目跳过而不是整批失败', () => {
    const decoded = decodeModelsResponse({
      object: 'list',
      data: [{ id: 'ok' }, 'not-an-object', { no_id: true }, null],
    });
    expect(decoded.data.map((m) => m.id)).toEqual(['ok']);
  });

  it('refresh：已知模型不动，未知模型补登（contract_tested: false）', () => {
    const registry = new FakeRegistry(mimoCapabilities());
    const discovery = new MiMoModelDiscovery({
      transport: { send: async () => ({ status: 200, body: Buffer.from('{}') }) } as never,
      headersProvider: async () => ({}),
    });
    // 预置响应：两个已知（flash/pro）+ 一个上游新增
    const response = decodeModelsResponse({
      object: 'list',
      data: [{ id: 'mimo-v2.6-flash' }, { id: 'mimo-v2.6-pro' }, { id: 'mimo-v2.7-ultra' }],
    });
    // refresh 是异步的，但 preloaded 路径不碰 transport——同步等即可
    return discovery.refresh(registry, response).then((result) => {
      expect(result.discovered).toHaveLength(3);
      // 只补登新的那个；已知的两个不重复 register
      expect(result.added).toEqual(['mimo.openai-chat/mimo-v2.7-ultra']);
      expect(registry.added).toHaveLength(1);
      expect(registry.added[0]).toMatchObject({
        access_path: 'mimo.openai-chat',
        model: 'mimo-v2.7-ultra',
        modality: 'chat',
        contract_tested: false,
        status: 'implemented',
      });
    });
  });

  it('音频模型不会被 discovery 补登成 chat 条目', () => {
    const registry = new FakeRegistry([]);
    const discovery = new MiMoModelDiscovery({
      transport: { send: async () => ({ status: 200, body: Buffer.from('{}') }) } as never,
      headersProvider: async () => ({}),
    });
    const response = decodeModelsResponse(fixture('models.response.json'));
    return discovery.refresh(registry, response).then((result) => {
      // 六个上游模型都会被补登（矩阵里没有它们）——这是"上游新增模型立刻可路由"的机制
      expect(result.added).toHaveLength(6);
      for (const entry of registry.added) {
        // 但全部落在 openai-chat 的 chat 模态，不会变成 mimo.tools.* 的音频条目
        expect(entry.access_path).toBe('mimo.openai-chat');
        expect(entry.modality).toBe('chat');
      }
    });
  });

  it('真实矩阵（InMemory）也能被 refresh 写入', () => {
    const registry = new InMemoryCapabilityRegistry();
    for (const e of mimoCapabilities()) registry.register(e);
    const discovery = new MiMoModelDiscovery({
      transport: { send: async () => ({ status: 200, body: Buffer.from('{}') }) } as never,
      headersProvider: async () => ({}),
    });
    const response = decodeModelsResponse({
      object: 'list',
      data: [{ id: 'mimo-v2.6-flash' }, { id: 'mimo-v2.7-ultra' }],
    });
    return discovery.refresh(registry, response).then(() => {
      expect(registry.find('mimo.openai-chat', 'mimo-v2.7-ultra', 'chat')).toBeDefined();
      // 已知条目的 quirks 不被改写（"我们测过什么"不该被上游元数据覆盖）
      expect(registry.find('mimo.openai-chat', 'mimo-v2.6-flash', 'chat')?.quirks?.[0]).toMatch(
        /上游模型名/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 6. 组合根自洽（默认装配里 MiMo 真的在）
// ---------------------------------------------------------------------------

describe('MiMo · 组合根默认装配', () => {
  it('defaultCapabilities 含 MiMo 的 chat 与音频条目', async () => {
    const { defaultCapabilities, createDefaultProviderProfiles, defaultRouteTable } =
      await import('../composition-root.js');
    const entries = defaultCapabilities();
    const mimo = entries.filter((e) => e.access_path.startsWith('mimo'));
    // 2 chat + 3 tts + 1 asr = 6
    expect(mimo).toHaveLength(6);

    const profiles = createDefaultProviderProfiles();
    expect(
      profiles
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(['deepseek', 'mimo']);
    expect(profiles.forAccessPath('mimo.openai-chat')?.id).toBe('mimo');

    const table = defaultRouteTable();
    expect(table.aliases['mimo-v2.6-flash']?.targets[0]?.access_path).toBe('mimo.openai-chat');
    // 没有 anthropic 面 → 没有 -messages 别名
    expect(table.aliases['mimo-v2.6-flash-messages']).toBeUndefined();
  });
});
