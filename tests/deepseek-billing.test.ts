/**
 * tests/deepseek-billing.test.ts —— 计费模型在管道里的落地测试（离线，ScriptedTransport）。
 *
 * 覆盖仓库主人定的四条硬规则在 S10 的落地：
 *   1. 不可变 + 快照：record.price_snapshot 带 table_version / effective_date / tier / rates；
 *   2. 请求时尝试计费：完成时用当时可得价格算，拿不到 → pending_price / unpriced；
 *   3. as_api 永远尝试计算：订阅路径 cash 恒 0 但 as_api 照算；
 *   4. as_api 与 cash 同一次解析（同档费率）。
 * 另覆盖：档位由请求开始时间定（price_snapshot.tier 可解释）、非 DeepSeek 模型不炸。
 */

import { describe, expect, it } from 'vitest';
import { createGateway } from '../composition-root.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { createDeepSeekPricingService } from '../providers/deepseek/pricing-service.js';
import { resolvePrice } from '../metering/pricing.js';
import { loadDeepSeekHolidayCalendars } from '../providers/deepseek/holidays.js';
import { deepseekPriceTableFor, loadDeepSeekPriceTables } from '../providers/deepseek/pricing.js';
import { computeCost } from '../metering/pricing.js';
import type { PricingService } from '../providers/deepseek/pricing-service.js';

const FAKE_KEY = 'sk-test-not-a-real-key';

/** DeepSeek 形态响应（usage 抄官方 verbatim 示例 + 缓存命中）。 */
function deepseekResponse(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-billing-test',
    object: 'chat.completion',
    created: 1_763_000_500,
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage,
  };
}

async function runWithUsage(
  usage: Record<string, unknown>,
  opts: { pricingService?: PricingService; model?: string } = {},
) {
  const model = opts.model ?? 'deepseek-flash';
  const transport = new ScriptedTransport([{ body: JSON.stringify(deepseekResponse(usage)) }]);
  const gateway = createGateway({
    mode: 'test',
    transport,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY,
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
    ...(opts.pricingService === undefined ? {} : { pricingService: opts.pricingService }),
  });
  const sink = new MemoryClientSink();
  const out = await gateway.runner.run(
    {
      client_format: 'openai.chat',
      raw_body: Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })),
      headers: { 'content-type': 'application/json' },
      path: '/v1/chat/completions',
      query: {},
    },
    sink,
  );
  await gateway.usageEmitter.flush();
  return { gateway, out };
}

describe('S10 计费：有价格时算出 cash / as_api + 快照', () => {
  it('DeepSeek 模型：priced + 快照含 tier/rates/表版本', async () => {
    const { gateway } = await runWithUsage({
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      total_tokens: 1_100_000,
      prompt_cache_hit_tokens: 400_000,
      prompt_cache_miss_tokens: 600_000,
      completion_tokens_details: { reasoning_tokens: 50_000 },
    });
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.cost.status).toBe('priced');
    expect(rec.price_snapshot).not.toBeNull();
    const snapshot = rec.price_snapshot!;
    expect(snapshot.price_table_version).toMatch(/^deepseek-/);
    expect(snapshot.effective_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['peak', 'off_peak', 'default']).toContain(snapshot.tier);
    expect(snapshot.rates['input_cache_hit']).toBeGreaterThan(0);
    expect(snapshot.rates['output']).toBeGreaterThan(0);
    expect(rec.access_path).toBe('deepseek.openai-chat');

    // 非订阅路径：cash 与 as_api 相等（同一次解析）
    expect(rec.cost.cash.total).toBeCloseTo(rec.cost.as_api.total, 10);
    expect(rec.cost.cash.total).toBeGreaterThan(0);
    // 峰谷二选一：命中档的费率算出来的数应与快照 rates 自洽
    const rates = snapshot.rates;
    const expectedMiss = (600_000 / 1_000_000) * rates['input_cache_miss']!;
    const expectedHit = (400_000 / 1_000_000) * rates['input_cache_hit']!;
    const expectedOut = (100_000 / 1_000_000) * rates['output']!;
    expect(rec.cost.cash.input).toBeCloseTo(expectedMiss, 10);
    expect(rec.cost.cash.cache_read).toBeCloseTo(expectedHit, 10);
    expect(rec.cost.cash.output).toBeCloseTo(expectedOut, 10);
    // reasoning 不双算（DeepSeek 口径含在 completion 里）
    expect(rec.cost.cash.reasoning).toBe(0);
    // 总价自洽
    expect(rec.cost.cash.total).toBeCloseTo(expectedMiss + expectedHit + expectedOut, 10);
  });

  it('峰谷二选一：默认（off-peak）费率恰为 peak 的一半（价格表口径）', () => {
    const { tables } = loadDeepSeekPriceTables();
    const flash = deepseekPriceTableFor('deepseek-flash', tables)!;
    const entry = flash.entries[0]!;
    // 规则集（2026-08-17 起生效）里的 peak 窗口
    const peakWindow = entry.rule_sets?.flatMap((rs) => rs.windows).find((w) => w.tier === 'peak');
    expect(peakWindow).toBeDefined();
    // 官方口径：off-peak = peak 的一半（entry 默认 rates 即 off-peak 档）
    expect(entry.rates['output']!).toBeCloseTo(peakWindow!.rates['output']! / 2, 10);
    expect(entry.rates['input_cache_miss']!).toBeCloseTo(
      peakWindow!.rates['input_cache_miss']! / 2,
      10,
    );
    // 规则集自身的生效日期（峰谷体系 2026-08-17、周末规则 2026-08-23）
    const froms = entry.rule_sets!.map((rs) => rs.effective_from);
    expect(froms).toContain('2026-08-17');
    expect(froms).toContain('2026-08-23');
  });
});

describe('S10 计费：拿不到价格', () => {
  it('有 usage 但无价格（mock 路径）→ pending_price，usage 不丢', async () => {
    const { gateway, out } = await runWithUsage(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      { model: 'mock-gpt' },
    );
    expect(out.error).toBeUndefined();
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.cost.status).toBe('pending_price');
    expect(rec.price_snapshot).toBeNull();
    // usage 本身不丢（pending 只是"没定价"，不是"没用量"）
    expect(rec.usage.units.tokens?.input_tokens).toBe(10);
  });

  it('上游没给 usage 但响应有文本 → as_api 走自估算（estimate_method 标注）', async () => {
    // 慢路径（anthropic 客户端 → deepseek.openai-chat）才会物化响应，S10 才拿得到
    // 响应文本做估算——fast path 不解码响应，没有文本可估（接口已留 estimateText）。
    const transport = new ScriptedTransport([
      {
        body: JSON.stringify({
          id: 'chatcmpl-no-usage',
          object: 'chat.completion',
          created: 1_763_000_500,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '这是一段用来触发自估算的回复文本，长度足够被估算出几十个 token。',
              },
              finish_reason: 'stop',
            },
          ],
        }),
      },
    ]);
    const gateway = createGateway({
      mode: 'test',
      transport,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_KEY,
      }),
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
    });
    const sink = new MemoryClientSink();
    const out = await gateway.runner.run(
      {
        client_format: 'anthropic.messages',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
            max_tokens: 64,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          }),
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/messages',
        query: {},
      },
      sink,
    );
    await gateway.usageEmitter.flush();
    expect(out.error).toBeUndefined();
    const rec = gateway.usageSink!.records[0]!;
    // 有价格 + 有文本 → 估算后 priced，且标注了估算方法（R2：估算可与真实值区分）
    expect(rec.cost.status).toBe('priced');
    expect(rec.estimate_method).toBe('char_heuristic_v1');
    expect(rec.cost.as_api.total).toBeGreaterThan(0);
    expect(rec.usage.units.tokens?.input_tokens).toBeGreaterThan(0);
  });

  it('上游没给 usage 且响应无文本 → unpriced（估算无输入）', async () => {
    const transport = new ScriptedTransport([
      {
        body: JSON.stringify({
          id: 'chatcmpl-empty',
          object: 'chat.completion',
          created: 1_763_000_500,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'noop', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      },
    ]);
    const gateway = createGateway({
      mode: 'test',
      transport,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_KEY,
      }),
    });
    const sink = new MemoryClientSink();
    const out = await gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );
    await gateway.usageEmitter.flush();
    expect(out.error).toBeUndefined();
    const rec = gateway.usageSink!.records[0]!;
    // 没东西可计 → unpriced（不是 priced-with-zeros，那会被读成"免费"）；
    // 价格本身解析成功了，快照仍在（记录"适用费率"，供对账解释）。
    expect(rec.cost.status).toBe('unpriced');
    expect(rec.price_snapshot?.price_table_version).toMatch(/^deepseek-/);
    expect(rec.usage.units.tokens).toBeUndefined();
  });

  it('注入空定价服务 → pending_price（有 usage 但无价格）', async () => {
    const { gateway } = await runWithUsage(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      {
        pricingService: {
          price: (req) => ({
            cost: { cash: zeroCostLike(), as_api: zeroCostLike(), status: 'pending_price' },
            price_snapshot: null,
            ...(req.estimateText === undefined ? {} : { estimate_method: 'char_heuristic_v1' }),
          }),
        },
      },
    );
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.cost.status).toBe('pending_price');
    expect(rec.price_snapshot).toBeNull();
    expect(rec.usage.units.tokens?.input_tokens).toBe(10);
  });
});

describe('峰谷 × 节假日维度（点时间解析）', () => {
  function tierAt(isoTs: string): { tier: string; holiday?: boolean; holiday_unknown?: boolean } {
    const { tables } = loadDeepSeekPriceTables();
    const flash = deepseekPriceTableFor('deepseek-flash', tables)!;
    const price = resolvePrice(flash, Date.parse(isoTs), {
      holidays: loadDeepSeekHolidayCalendars(),
    });
    expect(price).toBeDefined();
    return {
      tier: price!.tier,
      ...(price!.holiday === undefined ? {} : { holiday: price!.holiday }),
      ...(price!.holiday_unknown === undefined ? {} : { holiday_unknown: price!.holiday_unknown }),
    };
  }

  it('工作日高峰时段 → peak（北京时间周一 10:30）', () => {
    // 2026-11-16 是周一；02:30Z = 北京 10:30，落在 09:00-12:00 峰窗
    expect(tierAt('2026-11-16T02:30:00Z')).toMatchObject({ tier: 'peak' });
  });

  it('工作日晚间 → off_peak', () => {
    // 北京周一 20:00，峰窗之外
    expect(tierAt('2026-11-16T12:00:00Z').tier).toBe('off_peak');
  });

  it('周末全天低谷（2026-08-23 后的周六）', () => {
    // 2026-11-14 是周六；北京 10:30 即使在峰窗时段也算低谷
    expect(tierAt('2026-11-14T02:30:00Z').tier).toBe('off_peak');
  });

  it('法定节假日 → 低谷且 snapshot.holiday = true', () => {
    // 2026-10-01 国庆节（周四，本应在峰窗内）
    const r = tierAt('2026-10-01T02:30:00Z');
    expect(r.tier).toBe('off_peak');
    expect(r.holiday).toBe(true);
  });

  it('调休上班日（周末变工作日）→ 按高峰匹配', () => {
    // 2026-09-20 是周日但为国庆调休上班日（官方通知）→ 峰窗内算 peak。
    // （不能用 2026-02-14：峰谷体系 2026-08-17 才生效，更早的日期没有价格条目。）
    const r = tierAt('2026-09-20T02:30:00Z');
    expect(r.tier).toBe('peak');
    expect(r.holiday).toBeUndefined();
  });

  it('规则生效日边界：08-17 前没有峰谷体系（只有默认档）', () => {
    // 2026-08-14（周五）北京 15:00 —— 峰谷体系 08-17 才生效，落到默认 off-peak 档
    const { tables } = loadDeepSeekPriceTables();
    const flash = deepseekPriceTableFor('deepseek-flash', tables)!;
    const price = resolvePrice(flash, Date.parse('2026-08-14T07:00:00Z'), {
      holidays: loadDeepSeekHolidayCalendars(),
    });
    // 早于 effective_from 的请求没有条目可命中 → undefined（调用方记 pending_price）
    expect(price).toBeUndefined();
  });

  it('08-23 前的周六仍分峰谷（旧规则集）', () => {
    // 2026-08-22 是周六，但周末低谷规则 08-23 才生效 → 峰窗内算 peak
    expect(tierAt('2026-08-22T02:30:00Z').tier).toBe('peak');
  });

  it('时区换算：同一 UTC 时刻在北京的不同本地时间', () => {
    // 2026-11-17T18:30:00Z = 北京 11-18 02:30（不在峰窗）→ off_peak
    expect(tierAt('2026-11-17T18:30:00Z').tier).toBe('off_peak');
  });
});

describe('S10 计费：订阅路径', () => {
  it('cash 恒 0 但 as_api 照算（同一次解析）', async () => {
    const base = createDeepSeekPricingService();
    const service: PricingService = {
      price: (req) => ({ ...base.price(req), cost: { ...base.price(req).cost } }),
    };
    // 直接验约定：subscription=true 时 cash 全 0、as_api > 0
    const loaded = loadDeepSeekPriceTables();
    const flash = deepseekPriceTableFor('deepseek-flash', loaded.tables)!;
    const price = resolvePrice(flash, Date.now())!;
    const usage = {
      units: {
        tokens: {
          input_tokens: 1000,
          output_tokens: 100,
          total_tokens: 1100,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
      },
      source: 'provider' as const,
    };
    const normal = computeCost(usage, price);
    const subscription = computeCost(usage, price, { subscription: true });
    expect(normal.cash.total).toBeGreaterThan(0);
    expect(subscription.cash.total).toBe(0);
    // 同一次解析：as_api 与 cash（非订阅）相等
    expect(subscription.as_api.total).toBeCloseTo(normal.as_api.total, 10);
    expect(subscription.as_api.total).toBeCloseTo(normal.cash.total, 10);
    void service;
  });
});

/** 测试替身：全零拆分（避免 import 内部 helper）。 */
function zeroCostLike() {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    builtin_tools: 0,
    external: 0,
    total: 0,
  };
}
