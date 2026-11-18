/**
 * tests/architecture-decoupling.test.ts —— 架构解耦、零配置契约与聚合站分层计费保障测试。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createGateway } from '../composition-root.js';
import { decodeUpstreamModelsResponse } from '../admin/provider-models.js';
import { InMemoryProviderRuntimeIndex } from '../admin/provider-runtime.js';
import { resolveUpstreamUrl, type Transport, type UpstreamRequest } from '../gateway-core/transport.js';
import {
  createCompositePricingService,
  createModelsDevPricingService,
  createUsageRecord,
  MemoryUsageSink,
  toUsdAmount,
  zeroCost,
} from '../metering/index.js';
import { createDeepSeekPricingService } from '../providers/deepseek/pricing-service.js';
import { createMiMoPricingService } from '../providers/mimo/pricing-service.js';
import { createOpenAIImagesPricingService } from '../providers/openai-images/pricing.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { DefaultEncryptedRecordStore, InMemoryRawRecordStore } from '../storage/record-store.js';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FIXED_NOW = Date.parse('2026-11-15T12:00:00Z');
const FIXED_PEAK_TS = Date.parse('2026-11-16T02:30:00Z'); // 周一 10:30 北京时间（DeepSeek 峰时）

async function makeStore(): Promise<DefaultEncryptedRecordStore> {
  const keystore = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await keystore.unlock('test-passphrase-not-real');
  return new DefaultEncryptedRecordStore(keystore.unlocked(), new InMemoryRawRecordStore(), {
    now: () => FIXED_NOW,
  });
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('架构解耦约束', () => {
  it('核心模块（ir / gateway-core / metering / http / admin / credentials / config）不得直接依赖 providers/*', () => {
    const coreDirs = [
      'ir',
      'gateway-core',
      'metering',
      'http',
      'admin',
      'credentials',
      'config',
    ];
    const violations: string[] = [];
    const importRe = /(?:^|\n)\s*import\b[\s\S]*?from\s+['"]([^'"]*providers\/[^'"]+)['"]/g;

    for (const dir of coreDirs) {
      for (const file of collectTsFiles(join(REPO_ROOT, dir))) {
        const text = readFileSync(file, 'utf8');
        let match: RegExpExecArray | null;
        importRe.lastIndex = 0;
        while ((match = importRe.exec(text)) !== null) {
          violations.push(`${relative(REPO_ROOT, file)} -> ${match[1]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('零配置启动契约（production 模式 + 0 渠道）', () => {
  it('即使进程 env 里存在 DeepSeek/MiMo key，0 渠道时所有目录/能力/路径/默认设置仍保持空态，创建渠道后动态生效', async () => {
    const prevDs = process.env['DEEPSEEK_API_KEY'];
    const prevMimo = process.env['MIMO_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'sk-env-leak-test-not-real';
    process.env['MIMO_API_KEY'] = 'tp-env-leak-test-not-real';

    try {
      const store = await makeStore();
      const sent: UpstreamRequest[] = [];
      const mockTransport: Transport = {
        async send(req) {
          sent.push(req);
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(
              JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o', owned_by: 'openai' }] }),
            ),
          };
        },
      };

      const gateway = createGateway({
        mode: 'production',
        recordStore: store,
        transport: mockTransport,
        clock: { now: () => FIXED_NOW },
        modelSync: { syncOnStart: false },
      });

      await gateway.loadSettings();
      const admin = gateway.admin!.adminService;

      expect(await admin.listProviders()).toEqual([]);
      expect(await admin.listCapabilityMatrix()).toEqual([]);
      expect(
        await admin.listCapabilityMatrix({ includeUnconfigured: true, includeInternal: true }),
      ).toEqual([]);
      expect(admin.listAccessPaths()).toEqual([]);
      expect(admin.listEnvCredentialPaths()).toEqual([]);
      expect(await admin.listAliases()).toEqual([]);
      expect((await gateway.models.list()).data).toEqual([]);
      expect(gateway.agentConfig.snapshot().access_path).toBe('');
      expect(gateway.agentConfig.snapshot().model).toBe('');

      // 新建一个自定义渠道并录入 vault 加密凭据
      const upsert = await admin.upsertProvider('tester', {
        id: 'openrouter',
        label: 'OpenRouter',
        dialect: 'openai.chat',
        base_url: 'https://openrouter.ai/api/v1',
        model_source: { kind: 'static', models: ['gpt-4o'] },
      });
      expect(upsert.ok).toBe(true);

      const credRes = await admin.createCredential('tester', {
        provider: 'openrouter',
        access_path: 'openrouter.openai-chat',
        secret: 'sk-vault-test-key-not-real', // privacy-scan: ignore —— 测试假密钥占位符
      });
      expect(credRes.ok).toBe(true);
      if (!credRes.ok) throw new Error('expected ok');

      // 加密凭据可在运行时被 Resolver 正确取用并探测真实上游 /models
      const probe = await admin.probeCredential(credRes.credential.id);
      expect(probe.ok).toBe(true);
      expect(probe.status).toBe('ok');
      expect(sent).toHaveLength(1);
      expect(sent[0]!.base_url).toBe('https://openrouter.ai/api/v1');

      expect(admin.listAccessPaths().map((p) => p.id)).toContain('openrouter.openai-chat');
      expect((await gateway.models.list()).data.map((m) => m.id)).toContain('gpt-4o');

      // 删除渠道后恢复空态
      expect(await admin.deleteProvider('tester', 'openrouter')).toBe(true);
      expect(
        await admin.listCapabilityMatrix({ includeUnconfigured: true, includeInternal: true }),
      ).toEqual([]);
      expect(admin.listAccessPaths()).toEqual([]);
      expect((await gateway.models.list()).data).toEqual([]);

      await gateway.shutdown();
    } finally {
      if (prevDs === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = prevDs;
      if (prevMimo === undefined) delete process.env['MIMO_API_KEY'];
      else process.env['MIMO_API_KEY'] = prevMimo;
    }
  });
});

describe('聚合站多维分层定价、工具定价与多币种折算', () => {
  const tokenUsage = {
    units: {
      tokens: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        total_tokens: 2_000_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
    },
    source: 'provider' as const,
  };

  it('三层优先级：渠道自定义单价 / 倍率 > (provider, model) 专属表 > models.dev 兜底', () => {
    const runtime = new InMemoryProviderRuntimeIndex();
    runtime.replace([
      {
        id: 'vip-proxy',
        dialect: 'openai.chat',
        base_url: 'https://proxy.example.com/v1',
        namespace: '',
        access_path: 'vip-proxy.openai-chat',
        models: ['gpt-4o', 'custom-x'],
        enabled: true,
        builtin_tools: {},
        pricing: {
          multiplier: 1.5,
          currency: 'USD',
          models: {
            'custom-x': { input: 2, output: 8 },
          },
        },
      },
    ]);

    const channelPricing = {
      pricingFor: (key: string) => runtime.pricingFor(key),
    };
    const service = createCompositePricingService(
      [
        createDeepSeekPricingService(),
        createMiMoPricingService(),
        createOpenAIImagesPricingService(),
      ],
      {
        channelPricing,
        fallback: createModelsDevPricingService(),
      },
    );

    // Tier 1: custom-x 用渠道自定义单价 (input=2, output=8) × multiplier 1.5 = 3 + 12 = 15
    const tier1 = service.price({
      ts: FIXED_NOW,
      model: 'custom-x',
      provider: 'vip-proxy',
      access_path: 'vip-proxy.openai-chat',
      usage: tokenUsage,
    });
    expect(tier1.cost.status).toBe('priced');
    expect(tier1.cost.cash.total).toBeCloseTo(15, 6);
    expect(tier1.price_snapshot?.price_table_version).toBe('channel-override');

    // Tier 3 + 倍率: gpt-4o 经 vip-proxy 走 models.dev 兜底再乘 1.5
    const baseline = service.price({
      ts: FIXED_NOW,
      model: 'gpt-4o',
      provider: 'openai',
      usage: tokenUsage,
    });
    expect(baseline.cost.status).toBe('priced');
    expect(baseline.price_snapshot?.price_table_version).toBe('models.dev');

    const multiplied = service.price({
      ts: FIXED_NOW,
      model: 'gpt-4o',
      provider: 'vip-proxy',
      access_path: 'vip-proxy.openai-chat',
      usage: tokenUsage,
    });
    expect(multiplied.cost.cash.total).toBeCloseTo(baseline.cost.cash.total * 1.5, 6);

    // Tier 2 二维隔离：deepseek 走官方峰谷价（USD），mimo 走 CNY 价
    const ds = service.price({
      ts: FIXED_PEAK_TS,
      model: 'deepseek-flash',
      provider: 'deepseek',
      access_path: 'deepseek.openai-chat',
      usage: tokenUsage,
    });
    expect(ds.cost.status).toBe('priced');
    expect(ds.cost.currency).toBe('USD');

    const mimo = service.price({
      ts: FIXED_NOW,
      model: 'mimo-v2.6-flash',
      provider: 'mimo',
      access_path: 'mimo.openai-chat',
      usage: tokenUsage,
    });
    expect(mimo.cost.status).toBe('priced');
    expect(mimo.cost.currency).toBe('CNY');
  });

  it('DeepSeek 全家桶工具与音频端点全部正确计价而非 pending_price', () => {
    const service = createCompositePricingService([createDeepSeekPricingService()]);

    const search = service.price({
      ts: FIXED_NOW,
      model: 'search',
      provider: 'deepseek',
      access_path: 'deepseek.tools.search',
      usage: { units: { requests: 1000 }, source: 'provider' },
    });
    expect(search.cost.status).toBe('priced');
    expect(search.cost.cash.total).toBeCloseTo(0.75, 6);

    const ocr = service.price({
      ts: FIXED_NOW,
      model: 'ocr',
      provider: 'deepseek',
      access_path: 'deepseek.tools.ocr',
      usage: { units: { requests: 1000 }, source: 'provider' },
    });
    expect(ocr.cost.status).toBe('priced');
    expect(ocr.cost.cash.total).toBeCloseTo(0.225, 6);

    const ttsPeak = service.price({
      ts: FIXED_PEAK_TS,
      model: 'deepseek-tts',
      provider: 'deepseek',
      access_path: 'deepseek.tools.tts',
      usage: { units: { characters: { input: 10_000, billed: 10_000 } }, source: 'estimated' },
    });
    expect(ttsPeak.cost.status).toBe('priced');
    expect(ttsPeak.cost.cash.total).toBeCloseTo(0.45, 6);

    const asrAlias = service.price({
      ts: FIXED_PEAK_TS,
      model: 'whisper-1',
      provider: 'deepseek',
      access_path: 'deepseek.tools.asr',
      usage: { units: { audio_seconds: { input: 3600, billed: 3600 } }, source: 'provider' },
    });
    expect(asrAlias.cost.status).toBe('priced');
    expect(asrAlias.cost.cash.total).toBeCloseTo(0.116, 6);
  });

  it('usageDashboard / usageTimeseries / virtualKeyUsage 将 CNY 与 USD 折算为 USD 汇总并保留 by_currency 原币明细', async () => {
    const store = await makeStore();
    const gateway = createGateway({
      mode: 'test',
      recordStore: store,
      clock: { now: () => FIXED_NOW },
    });

    (gateway.usageSink as MemoryUsageSink).write([
      createUsageRecord({
        request_id: 'req_usd',
        ts: FIXED_NOW - 1000,
        auth: { key_id: 'vk_mix' },
        client_format: 'openai.chat',
        provider: 'deepseek',
        provider_format: 'openai.chat',
        model: 'deepseek-flash',
        fast_path: false,
        attempts: 1,
        stream: false,
        ttfb_ms: 10,
        total_ms: 50,
        status: 'success',
        usage: { units: { tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 } }, source: 'provider' },
        cost: {
          cash: { ...zeroCost(), total: 1.5 },
          as_api: { ...zeroCost(), total: 1.5 },
          status: 'priced',
          currency: 'USD',
        },
      }),
      createUsageRecord({
        request_id: 'req_cny',
        ts: FIXED_NOW - 500,
        auth: { key_id: 'vk_mix' },
        client_format: 'openai.chat',
        provider: 'mimo',
        provider_format: 'openai.chat',
        model: 'mimo-v2.6-flash',
        fast_path: false,
        attempts: 1,
        stream: false,
        ttfb_ms: 10,
        total_ms: 50,
        status: 'success',
        usage: { units: { tokens: { input_tokens: 200, output_tokens: 100, total_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0 } }, source: 'provider' },
        cost: {
          cash: { ...zeroCost(), total: 7.2 },
          as_api: { ...zeroCost(), total: 7.2 },
          status: 'priced',
          currency: 'CNY',
        },
      }),
    ]);

    const admin = gateway.admin!.adminService;
    const dash = await admin.usageDashboard(FIXED_NOW - 10_000, FIXED_NOW + 10_000);
    expect(dash.summary.cash_total).toBeCloseTo(1.5 + toUsdAmount(7.2, 'CNY'), 6);
    expect(dash.summary.by_currency?.['USD']?.cash_total).toBeCloseTo(1.5, 6);
    expect(dash.summary.by_currency?.['CNY']?.cash_total).toBeCloseTo(7.2, 6);

    const ts = await admin.usageTimeseries(FIXED_NOW - 10_000, FIXED_NOW + 10_000);
    const totalSeriesCash = ts.buckets.reduce((s, b) => s + b.cash_total, 0);
    expect(totalSeriesCash).toBeCloseTo(2.5, 6);

    const vkUsage = await admin.virtualKeyUsage('vk_mix', FIXED_NOW - 10_000, FIXED_NOW + 10_000);
    expect(vkUsage.cash_total).toBeCloseTo(2.5, 6);

    await gateway.shutdown();
  });
});

describe('多协议模型发现与带前缀 URL 拼接', () => {
  it('resolveUpstreamUrl 保留非重复路径前缀并消除版本段重叠', () => {
    expect(resolveUpstreamUrl('https://api.deepseek.com', '/chat/completions').toString()).toBe(
      'https://api.deepseek.com/chat/completions',
    );
    expect(
      resolveUpstreamUrl('https://api.deepseek.com/anthropic', '/v1/messages').toString(),
    ).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(
      resolveUpstreamUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', '/v1/chat/completions')
        .toString(),
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(
      resolveUpstreamUrl('https://open.bigmodel.cn/api/paas/v4', '/v1/chat/completions').toString(),
    ).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
  });

  it('decodeUpstreamModelsResponse 支持 OpenAI / Anthropic / Gemini 三种模型发现响应格式', () => {
    const gemini = decodeUpstreamModelsResponse({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
        },
      ],
    });
    expect(gemini.looksLikeList).toBe(true);
    expect(gemini.data).toEqual([
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        context_window: 1_048_576,
        max_output_tokens: 65_536,
      },
    ]);

    const anthropic = decodeUpstreamModelsResponse({
      data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', max_tokens: 200_000 }],
    });
    expect(anthropic.data).toEqual([
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context_window: 200_000 },
    ]);
  });
});
