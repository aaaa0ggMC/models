/**
 * metering/pricing.test.ts —— 通用价格引擎的测试。
 *
 * 覆盖 metering/pricing.ts 的四个风险面：
 *   1. **钱算错**：cache hit/miss 拆分、reasoning 不双算、非 token 单位的量纲换算
 *      （per_10000_characters 是"每 1 万字符"，差 1 万倍是最容易错的一处）；
 *   2. **档位判错**：峰谷窗口、跨零点、星期几、时区换算（Intl，禁手算 UTC+8）、
 *      规则集生效边界（峰谷体系上线日 / 周末低谷规则上线日）；
 *   3. **节假日判错**：法定节假日 = 低谷、调休上班日 = 按工作日匹配、无数据时保守；
 *   4. **历史被改**：backfill 必须用请求时点的价格，已定过价的记录不可重算。
 *
 * 时段相关的时间戳全部用**真实 UTC 时刻**写死（不是本地时间构造），并附上对应的
 * 北京时间，避免测试机器时区不同导致结果漂移。
 *
 * DeepSeek 表加载的断言也在本文件（而不是 providers/deepseek/pricing.test.ts）：
 * 本线程的写权限只到 metering/**，跨模块集成断言放这里是唯一落点。
 */

import { describe, expect, it } from 'vitest';

import type { CanonicalUsage } from '../ir/index.js';
import { deepseekPriceTableFor, loadDeepSeekPriceTables } from '../providers/deepseek/pricing.js';
import {
  CHAR_HEURISTIC_METHOD,
  TOKEN_PRICE_UNIT,
  applyPricingRefresh,
  backfillCost,
  computeCost,
  estimateCanonicalUsage,
  estimateUsage,
  mergeHolidayCalendars,
  priceSnapshotFrom,
  resolvePrice,
  type HolidayCalendar,
  type PriceEntry,
  type PriceTable,
  type PriceWindow,
  type ResolvePriceOptions,
  type ResolvedPrice,
} from './pricing.js';
import { createUsageRecord, zeroCost, type UsageRecord } from './usage-record.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** DeepSeek 低谷价（每 1M tokens）。 */
const OFF_PEAK_RATES = { input_cache_hit: 0.003, input_cache_miss: 0.15, output: 0.6 };
/** DeepSeek 高峰价 = 低谷的 2 倍。 */
const PEAK_RATES = { input_cache_hit: 0.006, input_cache_miss: 0.3, output: 1.2 };

/** 北京时间 2026-11-16 10:30 周一（峰窗内）。 */
const TS_MONDAY_PEAK = Date.parse('2026-11-16T02:30:00Z');
/** 北京时间 2026-11-14 12:30 周六（周末全天低谷）。 */
const TS_SATURDAY_NOON = Date.parse('2026-11-14T04:30:00Z');
/** 北京时间 2026-08-22 10:30 周六（周末低谷规则上线前 → 仍分峰谷）。 */
const TS_SATURDAY_BEFORE_WEEKEND_RULE = Date.parse('2026-08-22T02:30:00Z');
/** 北京时间 2026-08-29 10:30 周六（周末低谷规则上线后）。 */
const TS_SATURDAY_AFTER_WEEKEND_RULE = Date.parse('2026-08-29T02:30:00Z');
/** 北京时间 2026-08-17 10:30 周一（峰谷体系上线当天）。 */
const TS_MONDAY_REGIME_START = Date.parse('2026-08-17T02:30:00Z');
/** 北京时间 2026-08-16 10:30 周日（峰谷体系上线前）。 */
const TS_SUNDAY_BEFORE_REGIME = Date.parse('2026-08-16T02:30:00Z');

/** resolvePrice 必然命中时用它（省掉满屏的 `if (x === undefined) throw`）。 */
function mustResolve(table: PriceTable, ts: number, opts?: ResolvePriceOptions): ResolvedPrice {
  const price = resolvePrice(table, ts, opts);
  if (price === undefined) throw new Error('expected resolvePrice to hit an entry');
  return price;
}

/** 取 entry / rule_set / window 的类型安全访问器（索引访问在 TS 里不带 undefined）。 */
function entryOf(table: PriceTable, effective_from: string): PriceEntry {
  const entry = table.entries.find((e) => e.effective_from === effective_from);
  if (entry === undefined) throw new Error(`no entry ${effective_from}`);
  return entry;
}

function peakWindow(start: string, end: string, days_of_week?: number[]): PriceWindow {
  return {
    start,
    end,
    tz: 'Asia/Shanghai',
    tier: 'peak',
    rates: { ...PEAK_RATES },
    ...(days_of_week === undefined ? {} : { days_of_week }),
    exclude_dates: [],
  };
}

/** 一份带 DeepSeek 形态峰谷规则的表（两条 rule_set）。 */
function deepseekLikeTable(overrides?: Partial<PriceTable>): PriceTable {
  return {
    table_version: 'test-2026-11-14',
    source_url: 'https://example.com/pricing',
    fetched_at: '2026-11-14',
    currency: 'USD',
    unit: 'USD per 1M tokens',
    entries: [
      {
        effective_from: '2026-08-17',
        tier: 'off_peak',
        rates: { ...OFF_PEAK_RATES },
        rule_sets: [
          {
            effective_from: '2026-08-17',
            effective_to: '2026-08-23',
            windows: [peakWindow('09:00', '12:00'), peakWindow('14:00', '18:00')],
          },
          {
            effective_from: '2026-08-23',
            windows: [
              peakWindow('09:00', '12:00', [1, 2, 3, 4, 5]),
              peakWindow('14:00', '18:00', [1, 2, 3, 4, 5]),
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** 100 万 input（其中 40 万 cache read）+ 20 万 output（含 5 万 reasoning）。 */
const TOKENS: NonNullable<CanonicalUsage['units']['tokens']> = {
  input_tokens: 1_000_000,
  output_tokens: 200_000,
  total_tokens: 1_200_000,
  cache_read_tokens: 400_000,
  cache_write_tokens: 0,
  reasoning_tokens: 50_000,
};

function usageOf(units: CanonicalUsage['units']): CanonicalUsage {
  return { units, source: 'provider' };
}

const TOKEN_USAGE = usageOf({ tokens: TOKENS });

function makeRecord(ts: number, model = 'deepseek-flash'): UsageRecord {
  return createUsageRecord({
    request_id: 'req_test',
    ts,
    auth: { key_id: 'key_test' },
    client_format: 'openai.chat',
    provider: 'deepseek',
    provider_format: 'openai.chat',
    model,
    fast_path: true,
    attempts: 1,
    stream: false,
    ttfb_ms: 1,
    total_ms: 2,
    status: 'success',
    usage: TOKEN_USAGE,
  });
}

// ---------------------------------------------------------------------------
// 1. 费用计算
// ---------------------------------------------------------------------------

describe('computeCost：有价格时 cash 与 as_api 都算对', () => {
  it('cache hit/miss 拆分 + reasoning 不双算', () => {
    const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    expect(price.tier).toBe('peak');
    const cost = computeCost(TOKEN_USAGE, price);
    // input 60 万（未命中缓存）× 0.3 / 1M = 0.18
    expect(cost.as_api.input).toBeCloseTo(0.18, 12);
    // cache read 40 万 × 0.006 / 1M = 0.0024
    expect(cost.as_api.cache_read).toBeCloseTo(0.0024, 12);
    // output 20 万 × 1.2 / 1M = 0.24（reasoning 的 5 万已含在里面，不另计）
    expect(cost.as_api.output).toBeCloseTo(0.24, 12);
    expect(cost.as_api.reasoning).toBe(0);
    expect(cost.as_api.total).toBeCloseTo(0.18 + 0.0024 + 0.24, 12);
    expect(cost.status).toBe('priced');
    // 双口径同档同值
    expect(cost.cash).toEqual(cost.as_api);
  });

  it('reasoning 若被双算，total 会多出 5 万 × 1.2 / 1M = 0.06', () => {
    const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    const cost = computeCost(TOKEN_USAGE, price);
    expect(cost.as_api.total).not.toBeCloseTo(0.18 + 0.0024 + 0.24 + 0.06, 12);
  });

  it('cache_write 只在表里有该 slot 时才计', () => {
    const usage = usageOf({
      tokens: {
        ...TOKENS,
        input_tokens: 1_000_000,
        cache_read_tokens: 0,
        cache_write_tokens: 100_000,
      },
    });
    const without = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    expect(computeCost(usage, without).as_api.cache_write).toBe(0);

    const table = deepseekLikeTable();
    const entry = entryOf(table, '2026-08-17');
    entry.rates.input_cache_write = 0.5;
    const window = entry.rule_sets?.[1]?.windows[0];
    if (window === undefined) throw new Error('unreachable');
    window.rates.input_cache_write = 1.0;
    const withSlot = mustResolve(table, TS_MONDAY_PEAK);
    expect(computeCost(usage, withSlot).as_api.cache_write).toBeCloseTo(0.1, 12);
  });

  it('slot 缺失 → 该槽计 0，不抛错', () => {
    const table: PriceTable = {
      ...deepseekLikeTable(),
      entries: [{ effective_from: '2026-01-01', tier: 'default', rates: { output: 2 } }],
    };
    const cost = computeCost(TOKEN_USAGE, mustResolve(table, TS_MONDAY_PEAK));
    expect(cost.as_api.input).toBe(0);
    expect(cost.as_api.cache_read).toBe(0);
    expect(cost.as_api.output).toBeCloseTo(0.4, 12);
    expect(cost.status).toBe('priced');
  });

  it('cache_read 大于 input_tokens 时 miss 夹到 0，不出现负费用', () => {
    const usage = usageOf({
      tokens: { ...TOKENS, input_tokens: 10, cache_read_tokens: 50, total_tokens: 60 },
    });
    const cost = computeCost(usage, mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK));
    expect(cost.as_api.input).toBe(0);
    expect(cost.as_api.cache_read).toBeCloseTo((50 / TOKEN_PRICE_UNIT) * 0.006, 12);
  });
});

describe('computeCost：非 token 单位的量纲换算', () => {
  const table: PriceTable = {
    ...deepseekLikeTable(),
    entries: [
      {
        effective_from: '2026-01-01',
        tier: 'default',
        rates: {
          per_request: 0.002,
          per_10000_characters: 0.45,
          per_hour: 0.116,
          per_image: 0.014,
        },
      },
    ],
  };
  const price = mustResolve(table, TS_MONDAY_PEAK);

  it('requests × per_request', () => {
    const cost = computeCost(usageOf({ requests: 3 }), price);
    expect(cost.as_api.builtin_tools).toBeCloseTo(0.006, 12);
  });

  it('characters.billed / 10000 × per_10000_characters（1 万字符 0.45 美元）', () => {
    const cost = computeCost(usageOf({ characters: { input: 12_345, billed: 10_000 } }), price);
    expect(cost.as_api.builtin_tools).toBeCloseTo(0.45, 12);
    // 1 字符不是 0.45 美元——差 1 万倍，这是本函数最容易错的一处
    expect(cost.as_api.builtin_tools).not.toBeCloseTo(4500, 6);
  });

  it('audio_seconds.billed / 3600 × per_hour', () => {
    const cost = computeCost(usageOf({ audio_seconds: { input: 4000, billed: 3600 } }), price);
    expect(cost.as_api.builtin_tools).toBeCloseTo(0.116, 12);
  });

  it('images.generated × per_image（edited 不造钱）', () => {
    const cost = computeCost(usageOf({ images: { generated: 2, edited: 5 } }), price);
    expect(cost.as_api.builtin_tools).toBeCloseTo(0.028, 12);
  });

  it('external 恒 0：价格引擎不写 external_cost[]', () => {
    const cost = computeCost(usageOf({ requests: 3 }), price);
    expect(cost.as_api.external).toBe(0);
  });
});

describe('computeCost：没有价格', () => {
  it('usage 有内容 → pending_price，usage 原样保留', () => {
    const cost = computeCost(TOKEN_USAGE, undefined);
    expect(cost.status).toBe('pending_price');
    expect(cost.cash).toEqual(zeroCost());
    expect(cost.as_api).toEqual(zeroCost());
    // usage 不被改动（未知≠0，R2）
    expect(TOKEN_USAGE.units.tokens?.input_tokens).toBe(1_000_000);
  });

  it('usage 也没内容 → unpriced', () => {
    const cost = computeCost(usageOf({}), undefined);
    expect(cost.status).toBe('unpriced');
  });
});

describe('computeCost：有价格但上游没给 usage', () => {
  const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);

  it('usage 为空 → unpriced，绝不记成 $0 的 priced', () => {
    // 上游漏报 usage 时真实费用是"未知"不是 0；记成 priced + total 0 会让整条请求
    // 在成本报表里静默变成免费请求（少收钱单向不可逆，且无告警）。
    const cost = computeCost(usageOf({}), price);
    expect(cost.status).toBe('unpriced');
    expect(cost.cash).toEqual(zeroCost());
    expect(cost.as_api).toEqual(zeroCost());
  });

  it('上游明确给了 0 token（不是未知）→ priced，费用 0', () => {
    const zero = usageOf({
      tokens: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      },
    });
    const cost = computeCost(zero, price);
    expect(cost.status).toBe('priced');
    expect(cost.as_api.total).toBe(0);
  });

  it('估算兜底后就有内容了 → priced', () => {
    const { usage } = estimateCanonicalUsage('你好世界');
    const cost = computeCost(usage, price);
    expect(cost.status).toBe('priced');
    expect(cost.as_api.total).toBeGreaterThan(0);
  });
});

describe('computeCost：订阅路径', () => {
  it('cash 恒 0 但 as_api 照算，status 仍是 priced', () => {
    const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    const cost = computeCost(TOKEN_USAGE, price, { subscription: true });
    expect(cost.status).toBe('priced');
    expect(cost.cash).toEqual(zeroCost());
    expect(cost.as_api.input).toBeCloseTo(0.18, 12);
    expect(cost.as_api.total).toBeCloseTo(0.4224, 12);
  });

  it('cash 与 as_api 是同一档费率算出来的（不是两个对象各算一档）', () => {
    const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    const normal = computeCost(TOKEN_USAGE, price);
    const sub = computeCost(TOKEN_USAGE, price, { subscription: true });
    expect(sub.as_api).toEqual(normal.as_api);
  });
});

// ---------------------------------------------------------------------------
// 2. 用量估算
// ---------------------------------------------------------------------------

describe('estimateUsage：字符启发式', () => {
  it('CJK 每字 1 token', () => {
    expect(estimateUsage('你好世界').tokens).toBe(4);
  });

  it('其余每 4 字符 1 token（向上取整）', () => {
    expect(estimateUsage('hello world!').tokens).toBe(3); // 12 字符
    expect(estimateUsage('abc').tokens).toBe(1);
    expect(estimateUsage('').tokens).toBe(0);
  });

  it('中英混算', () => {
    expect(estimateUsage('你好ab').tokens).toBe(3);
  });

  it('假名/全角也按宽字符', () => {
    expect(estimateUsage('カタカナ').tokens).toBe(4);
    expect(estimateUsage('ＡＢＣ').tokens).toBe(3);
  });

  it('按码点迭代，emoji 不会被劈成半个代理对', () => {
    expect(estimateUsage('😀').tokens).toBe(1);
    expect(estimateUsage('😀😀😀😀😀').tokens).toBe(2); // 5 个码点 → ceil(5/4)
  });

  it('method 标注为 char_heuristic_v1', () => {
    expect(estimateUsage('x').method).toBe(CHAR_HEURISTIC_METHOD);
    expect(CHAR_HEURISTIC_METHOD).toBe('char_heuristic_v1');
  });

  it('estimateCanonicalUsage 产出 estimated 来源 + 方法标注', () => {
    const { usage, estimate_method } = estimateCanonicalUsage('你好世界');
    expect(usage.source).toBe('estimated');
    expect(usage.precision).toBe('approx');
    expect(usage.units.tokens?.input_tokens).toBe(4);
    expect(usage.units.tokens?.output_tokens).toBe(0);
    expect(estimate_method).toBe('char_heuristic_v1');
  });

  it('上游没给 usage 时 as_api 走估算（S10 的兜底路径）', () => {
    const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    const { usage, estimate_method } = estimateCanonicalUsage('你好世界，帮忙写个网关。');
    const cost = computeCost(usage, price);
    expect(cost.status).toBe('priced');
    expect(cost.as_api.input).toBeGreaterThan(0);
    const record = createUsageRecord({
      request_id: 'req_est',
      ts: TS_MONDAY_PEAK,
      auth: { key_id: 'k' },
      client_format: 'openai.chat',
      provider: 'deepseek',
      provider_format: 'openai.chat',
      model: 'deepseek-flash',
      fast_path: true,
      attempts: 1,
      stream: false,
      ttfb_ms: 0,
      total_ms: 1,
      status: 'success',
      usage,
      estimate_method,
      cost,
      price_snapshot: priceSnapshotFrom(price),
    });
    expect(record.estimate_method).toBe('char_heuristic_v1');
    expect(record.cost.status).toBe('priced');
  });
});

// ---------------------------------------------------------------------------
// 3. 时段 / 时区 / 规则集
// ---------------------------------------------------------------------------

describe('resolvePrice：时段窗口', () => {
  it('峰窗内命中 peak 档', () => {
    const price = mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK);
    expect(price.tier).toBe('peak');
    expect(price.rates).toEqual(PEAK_RATES);
    expect(price.window).toMatchObject({ start: '09:00', end: '12:00', tz: 'Asia/Shanghai' });
    expect(price.rule_effective_from).toBe('2026-08-23');
  });

  it('峰窗外（周六中午 12:30）命中默认 off_peak 档', () => {
    const price = mustResolve(deepseekLikeTable(), TS_SATURDAY_NOON);
    expect(price.tier).toBe('off_peak');
    expect(price.rates).toEqual(OFF_PEAK_RATES);
    expect(price.window).toBeUndefined();
  });

  it('周末全天低谷（2026-08-23 后的周六，即使在峰窗时刻）', () => {
    const price = mustResolve(deepseekLikeTable(), TS_SATURDAY_AFTER_WEEKEND_RULE);
    expect(price.tier).toBe('off_peak');
    expect(price.rates).toEqual(OFF_PEAK_RATES);
  });

  it('周末低谷规则上线前，周六也分峰谷', () => {
    const price = mustResolve(deepseekLikeTable(), TS_SATURDAY_BEFORE_WEEKEND_RULE);
    expect(price.tier).toBe('peak');
    expect(price.rule_effective_from).toBe('2026-08-17');
  });

  it('时区换算：02:30Z = 北京 10:30 周一 → peak', () => {
    // 2026-11-16T02:30:00Z → Asia/Shanghai 2026-11-16 10:30（周一）
    const price = mustResolve(deepseekLikeTable(), Date.parse('2026-11-16T02:30:00Z'));
    expect(price.tier).toBe('peak');
  });

  it('时区换算：04:30Z = 北京 12:30 周六 → off_peak（周末规则）', () => {
    const price = mustResolve(deepseekLikeTable(), Date.parse('2026-11-14T04:30:00Z'));
    expect(price.tier).toBe('off_peak');
  });

  it('同一时刻只解析一次：北京 00:30 不会被误判成 24:30', () => {
    // 2026-11-15T16:30:00Z → 北京 2026-11-16 00:30，不在任何峰窗 → 低谷
    const price = mustResolve(deepseekLikeTable(), Date.parse('2026-11-15T16:30:00Z'));
    expect(price.tier).toBe('off_peak');
  });

  it('跨零点窗口：[22:00, 02:00) 在 23:00 与 01:00 命中、03:00 不命中', () => {
    const table: PriceTable = {
      ...deepseekLikeTable(),
      entries: [
        {
          effective_from: '2026-01-01',
          tier: 'default',
          rates: { output: 1 },
          time_windows: [
            { start: '22:00', end: '02:00', tz: 'UTC', tier: 'night', rates: { output: 2 } },
          ],
        },
      ],
    };
    expect(mustResolve(table, Date.parse('2026-11-16T23:00:00Z')).tier).toBe('night');
    expect(mustResolve(table, Date.parse('2026-11-16T01:00:00Z')).tier).toBe('night');
    expect(mustResolve(table, Date.parse('2026-11-16T03:00:00Z')).tier).toBe('default');
  });

  it('days_of_week 用 ISO 周几（1=周一）', () => {
    const table: PriceTable = {
      ...deepseekLikeTable(),
      entries: [
        {
          effective_from: '2026-01-01',
          tier: 'default',
          rates: { output: 1 },
          time_windows: [
            {
              start: '00:00',
              end: '23:59',
              tz: 'UTC',
              tier: 'monday_only',
              days_of_week: [1],
              rates: { output: 2 },
            },
          ],
        },
      ],
    };
    expect(mustResolve(table, Date.parse('2026-11-16T12:00:00Z')).tier).toBe('monday_only');
    expect(mustResolve(table, Date.parse('2026-11-17T12:00:00Z')).tier).toBe('default');
  });

  it('exclude_dates 命中当日 → 该窗口不生效', () => {
    const table = deepseekLikeTable();
    const window = entryOf(table, '2026-08-17').rule_sets?.[1]?.windows[0];
    if (window === undefined) throw new Error('unreachable');
    window.exclude_dates = ['2026-11-16'];
    expect(mustResolve(table, TS_MONDAY_PEAK).tier).toBe('off_peak');
  });

  it('窗口写法非法 → 该窗口不命中（不抛错），落到默认档', () => {
    const table: PriceTable = {
      ...deepseekLikeTable(),
      entries: [
        {
          effective_from: '2026-01-01',
          tier: 'default',
          rates: { output: 1 },
          time_windows: [
            { start: '9am', end: '12:00', tz: 'UTC', tier: 'broken', rates: { output: 2 } },
          ],
        },
      ],
    };
    expect(mustResolve(table, TS_MONDAY_PEAK).tier).toBe('default');
  });

  it('没有覆盖 ts 的条目 → undefined（调用方记 pending_price）', () => {
    expect(resolvePrice(deepseekLikeTable(), TS_SUNDAY_BEFORE_REGIME)).toBeUndefined();
    expect(computeCost(TOKEN_USAGE, undefined).status).toBe('pending_price');
  });
});

describe('resolvePrice：规则集生效边界（峰谷体系 / 周末低谷规则）', () => {
  /** 峰谷体系上线前还有一份"只有默认费率"的旧条目。 */
  function regimeChangeTable(): PriceTable {
    const base = deepseekLikeTable();
    return {
      ...base,
      entries: [
        { effective_from: '2026-01-01', tier: 'default', rates: { input_cache_miss: 0.1 } },
        ...base.entries,
      ],
    };
  }

  it('2026-08-17 00:00 前：只有默认费率，没有峰谷', () => {
    const price = mustResolve(regimeChangeTable(), TS_SUNDAY_BEFORE_REGIME);
    expect(price.tier).toBe('default');
    expect(price.rates).toEqual({ input_cache_miss: 0.1 });
    expect(price.window).toBeUndefined();
    expect(price.rule_effective_from).toBe('2026-01-01');
  });

  it('2026-08-17 00:00 后：峰谷体系生效', () => {
    const price = mustResolve(regimeChangeTable(), TS_MONDAY_REGIME_START);
    expect(price.tier).toBe('peak');
    expect(price.rates).toEqual(PEAK_RATES);
    expect(price.rule_effective_from).toBe('2026-08-17');
  });

  it('多条 entry 命中时取 effective_from 最大者（append-only）', () => {
    const table = regimeChangeTable();
    table.entries.push({
      effective_from: '2026-11-14',
      tier: 'off_peak',
      rates: { input_cache_miss: 0.05 },
    });
    const price = mustResolve(table, TS_MONDAY_PEAK);
    // 新条目没有 rule_sets/time_windows → 只剩默认档，但费率是最新条目的
    expect(price.rates).toEqual({ input_cache_miss: 0.05 });
    expect(price.effective_from).toBe('2026-11-14');
  });

  it('effective_to 不含当日', () => {
    const table = regimeChangeTable();
    entryOf(table, '2026-01-01').effective_to = '2026-08-17';
    // 08-17 起旧条目失效，只剩峰谷条目
    expect(mustResolve(table, TS_MONDAY_REGIME_START).tier).toBe('peak');
    // 08-16 仍走旧条目
    expect(mustResolve(table, TS_SUNDAY_BEFORE_REGIME).rates).toEqual({
      input_cache_miss: 0.1,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. 法定节假日 / 调休
// ---------------------------------------------------------------------------

/** 2026 年国庆：10-01..10-08 放假，09-26（周六）调休上班。 */
const CALENDAR_2026: HolidayCalendar = {
  year: 2026,
  source: 'https://example.com/holidays-2026',
  holidays: [
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
    '2026-10-04',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
  ],
  workdays: ['2026-09-26'],
};

describe('resolvePrice：法定节假日与调休', () => {
  const table = deepseekLikeTable();

  it('节假日 → 强制 off_peak，跳过窗口匹配', () => {
    // 北京 2026-10-01 10:30 周四，本应是峰时
    const price = mustResolve(table, Date.parse('2026-10-01T02:30:00Z'), {
      holidays: [CALENDAR_2026],
    });
    expect(price.tier).toBe('off_peak');
    expect(price.rates).toEqual(OFF_PEAK_RATES);
    expect(price.window).toBeUndefined();
    expect(price.holiday).toBe(true);
    expect(price.holiday_unknown).toBeUndefined();
  });

  it('节假日的 snapshot 记 holiday: true（可对账）', () => {
    const snap = priceSnapshotFrom(
      mustResolve(table, Date.parse('2026-10-01T02:30:00Z'), { holidays: [CALENDAR_2026] }),
    );
    expect(snap.holiday).toBe(true);
    expect(snap.tier).toBe('off_peak');
    expect(snap.rule_effective_from).toBe('2026-08-23');
  });

  it('调休上班的周六 → 按正常工作日匹配窗口（峰时）', () => {
    // 北京 2026-09-26 10:30 周六，被调成上班日
    const price = mustResolve(table, Date.parse('2026-09-26T02:30:00Z'), {
      holidays: [CALENDAR_2026],
    });
    expect(price.tier).toBe('peak');
    expect(price.holiday).toBeUndefined();
  });

  it('同一日期既在 holidays 又在 workdays → 按 workday（保守，可能多计）', () => {
    const conflicting: HolidayCalendar = {
      ...CALENDAR_2026,
      holidays: ['2026-10-01'],
      workdays: ['2026-10-01'],
    };
    const price = mustResolve(table, Date.parse('2026-10-01T02:30:00Z'), {
      holidays: [conflicting],
    });
    expect(price.tier).toBe('peak');
  });

  it('没传 calendar → holiday_unknown: true，按工作日保守处理', () => {
    const price = mustResolve(table, TS_MONDAY_PEAK);
    expect(price.holiday_unknown).toBe(true);
    expect(price.holiday).toBeUndefined();
    // 保守 = 仍然按窗口匹配（该峰还是峰）
    expect(price.tier).toBe('peak');
  });

  it('传了 calendar 但当日不在表中 → holiday_unknown: true', () => {
    const price = mustResolve(table, TS_MONDAY_PEAK, { holidays: [CALENDAR_2026] });
    expect(price.holiday_unknown).toBe(true);
    expect(price.holiday).toBeUndefined();
  });

  it('snapshot 只在 true 时落 holiday / holiday_unknown', () => {
    const unknown = priceSnapshotFrom(mustResolve(table, TS_MONDAY_PEAK));
    const known = priceSnapshotFrom(
      mustResolve(table, Date.parse('2026-10-01T02:30:00Z'), { holidays: [CALENDAR_2026] }),
    );
    expect(unknown.holiday_unknown).toBe(true);
    expect('holiday' in unknown).toBe(false);
    expect(known.holiday).toBe(true);
    expect('holiday_unknown' in known).toBe(false);
  });

  it('mergeHolidayCalendars 按年合并、并集去重排序', () => {
    const a: HolidayCalendar = {
      year: 2026,
      source: 'https://example.com/a',
      holidays: ['2026-10-03', '2026-10-01'],
      workdays: ['2026-09-26'],
    };
    const b: HolidayCalendar = {
      year: 2026,
      source: 'https://example.com/b',
      holidays: ['2026-10-01', '2026-10-02'],
      workdays: ['2026-10-10'],
    };
    const c: HolidayCalendar = {
      year: 2027,
      source: '',
      holidays: ['2027-01-01'],
      workdays: [],
    };
    const merged = mergeHolidayCalendars([a, b, c]);
    expect(merged).toHaveLength(2);
    const m26 = merged.find((m) => m.year === 2026);
    expect(m26?.source).toBe('https://example.com/a');
    expect(m26?.holidays).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(m26?.workdays).toEqual(['2026-09-26', '2026-10-10']);
    const m27 = merged.find((m) => m.year === 2027);
    expect(m27?.holidays).toEqual(['2027-01-01']);
  });

  it('合并后的日历可直接用于 resolvePrice', () => {
    const merged = mergeHolidayCalendars([
      { ...CALENDAR_2026, holidays: ['2026-10-01'] },
      { year: 2026, source: '', holidays: ['2026-10-02'], workdays: [] },
    ]);
    const price = mustResolve(table, Date.parse('2026-10-02T02:30:00Z'), {
      holidays: merged,
    });
    expect(price.holiday).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. 快照 / 补算
// ---------------------------------------------------------------------------

describe('priceSnapshotFrom', () => {
  it('记下 tier / window / 规则生效日 / 费率', () => {
    const snap = priceSnapshotFrom(mustResolve(deepseekLikeTable(), TS_MONDAY_PEAK));
    expect(snap).toEqual({
      price_table_version: 'test-2026-11-14',
      effective_date: '2026-08-17',
      tier: 'peak',
      window: { start: '09:00', end: '12:00', tz: 'Asia/Shanghai' },
      rule_effective_from: '2026-08-23',
      holiday_unknown: true,
      rates: { ...PEAK_RATES },
    });
  });

  it('rates 是克隆，改快照不会改到表', () => {
    const table = deepseekLikeTable();
    const snap = priceSnapshotFrom(mustResolve(table, TS_MONDAY_PEAK));
    snap.rates.output = 999;
    const window = entryOf(table, '2026-08-17').rule_sets?.[1]?.windows[0];
    expect(window?.rates.output).toBe(1.2);
  });
});

describe('backfillCost：用历史价格补算', () => {
  /** 旧价 0.1 / 新价 1.0 的两段表。 */
  function versionedTable(oldRate = 0.1): PriceTable {
    return {
      ...deepseekLikeTable(),
      entries: [
        { effective_from: '2026-01-01', tier: 'default', rates: { input_cache_miss: oldRate } },
        { effective_from: '2026-11-14', tier: 'default', rates: { input_cache_miss: 1.0 } },
      ],
    };
  }

  it('请求落在旧区间 → 用旧价，不用当前价', () => {
    const record = makeRecord(Date.parse('2026-11-01T02:30:00Z'));
    const filled = backfillCost(record, () => versionedTable(), Date.parse('2026-11-20T00:00:00Z'));
    // 60 万 input 未命中缓存 × 0.1 / 1M = 0.06（不是 0.1：40 万走了 cache hit）
    expect(filled.cost.as_api.input).toBeCloseTo(0.06, 12);
    expect(filled.cost.status).toBe('priced');
    expect(filled.price_snapshot?.effective_date).toBe('2026-01-01');
    expect(filled.backfilled_at).toBe(Date.parse('2026-11-20T00:00:00Z'));
    expect(filled.backfill_price_table_version).toBe('test-2026-11-14');
  });

  it('请求落在新区间 → 用新价', () => {
    const record = makeRecord(Date.parse('2026-11-20T02:30:00Z'));
    const filled = backfillCost(record, () => versionedTable(), 1);
    expect(filled.cost.as_api.input).toBeCloseTo(0.6, 12);
    expect(filled.price_snapshot?.effective_date).toBe('2026-11-14');
  });

  it('已有 price_snapshot 且已定价 → 原样返回，不重算', () => {
    const record = makeRecord(Date.parse('2026-11-01T02:30:00Z'));
    const price = mustResolve(versionedTable(0.1), record.ts);
    const withSnapshot: UsageRecord = {
      ...record,
      cost: computeCost(record.usage, price),
      price_snapshot: priceSnapshotFrom(price),
    };
    // 表被改成 0.5（模拟"有人偷偷改了旧条目"）
    const refilled = backfillCost(withSnapshot, () => versionedTable(0.5), 999);
    expect(refilled).toBe(withSnapshot);
    expect(refilled.cost.as_api.input).toBeCloseTo(0.06, 12);
    expect(refilled.price_snapshot?.rates.input_cache_miss).toBe(0.1);
  });

  it('price_snapshot = null（请求时拿不到价格）→ 允许补算', () => {
    const record: UsageRecord = {
      ...makeRecord(Date.parse('2026-11-01T02:30:00Z')),
      price_snapshot: null,
    };
    expect(record.cost.status).toBe('unpriced');
    const filled = backfillCost(record, () => versionedTable(), 1);
    expect(filled.price_snapshot?.effective_date).toBe('2026-01-01');
    expect(filled.cost.status).toBe('priced');
  });

  it('没有覆盖 ts 的条目 → 不写 backfilled_at，只归一 status', () => {
    // 2025-12-31 早于表里最早的条目（2026-01-01）→ 解析不到价格
    const record = makeRecord(Date.parse('2025-12-31T02:30:00Z'));
    const filled = backfillCost(record, () => versionedTable(), 777);
    expect('backfilled_at' in filled).toBe(false);
    expect(filled.cost.status).toBe('pending_price');
  });

  it('模型没有价格表 → pending_price，不抛错', () => {
    const record = makeRecord(TS_MONDAY_PEAK, 'deepseek-unknown');
    const filled = backfillCost(record, () => undefined, 1);
    expect(filled.cost.status).toBe('pending_price');
    expect(filled.price_snapshot).toBeUndefined();
  });

  it('usage 为空的记录补不出费用：只归一 status，不落快照/backfilled_at', () => {
    const record = createUsageRecord({
      request_id: 'req_nousage',
      ts: TS_MONDAY_PEAK,
      auth: { key_id: 'k' },
      client_format: 'openai.chat',
      provider: 'deepseek',
      provider_format: 'openai.chat',
      model: 'deepseek-flash',
      fast_path: true,
      attempts: 1,
      stream: false,
      ttfb_ms: 0,
      total_ms: 1,
      status: 'success',
    });
    expect(record.usage.units).toEqual({});
    const filled = backfillCost(record, () => deepseekLikeTable(), 555);
    expect(filled.cost.status).toBe('unpriced');
    expect('price_snapshot' in filled).toBe(false);
    expect('backfilled_at' in filled).toBe(false);
  });

  it('节假日日历可注入（补算历史时必须覆盖 record.ts 那一年）', () => {
    const record = makeRecord(Date.parse('2026-10-01T02:30:00Z'));
    const filled = backfillCost(record, () => deepseekLikeTable(), 1, {
      holidays: [CALENDAR_2026],
    });
    expect(filled.price_snapshot?.holiday).toBe(true);
    expect(filled.price_snapshot?.tier).toBe('off_peak');
  });
});

describe('价格表更新后旧记录快照不变', () => {
  it('新旧表对同一 ts 给出不同费率，但已有快照不被覆盖', () => {
    const oldTable = deepseekLikeTable();
    // 新表：把 08-17 条目的低谷价改掉（模拟"非 append-only 的改价"）
    const newTable = deepseekLikeTable();
    entryOf(newTable, '2026-08-17').rates = { ...OFF_PEAK_RATES, input_cache_miss: 0.5 };

    const ts = TS_SATURDAY_NOON;
    const oldPrice = mustResolve(oldTable, ts);
    const newPrice = mustResolve(newTable, ts);
    expect(oldPrice.rates.input_cache_miss).toBe(0.15);
    expect(newPrice.rates.input_cache_miss).toBe(0.5);

    const record = makeRecord(ts);
    const priced: UsageRecord = {
      ...record,
      cost: computeCost(record.usage, oldPrice),
      price_snapshot: priceSnapshotFrom(oldPrice),
    };
    const refilled = backfillCost(priced, () => newTable, 42);
    expect(refilled).toBe(priced);
    expect(refilled.price_snapshot?.rates.input_cache_miss).toBe(0.15);
    expect(refilled.cost.as_api.input).toBeCloseTo(0.09, 12);
  });

  it('applyPricingRefresh 抛错：只新增版本，不改旧版本', () => {
    expect(() =>
      applyPricingRefresh({
        table_version: 'deepseek-2026-12-01',
        source_url: 'https://example.com/pricing',
        fetched_at: '2026-12-01',
        changes: ['deepseek-flash off-peak input 0.15 → 0.12'],
      }),
    ).toThrow(/not implemented/);
  });
});

// ---------------------------------------------------------------------------
// 6. DeepSeek 表加载
// ---------------------------------------------------------------------------

describe('DeepSeek 价格表加载', () => {
  const { tables, tools } = loadDeepSeekPriceTables();

  it('flash / v4-pro 各一张表，字段齐全', () => {
    expect(Object.keys(tables).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    for (const table of Object.values(tables)) {
      expect(table.table_version).toBe('deepseek-2026-11-14');
      expect(table.source_url).toBe('https://api-docs.deepseek.com/quick_start/pricing');
      expect(table.fetched_at).toBe('2026-11-14');
      expect(table.currency).toBe('USD');
      expect(table.unit).toBe('USD per 1M tokens');
      expect(table.entries).toHaveLength(1);
    }
  });

  it('flash 费率数值正确（off-peak 默认档）', () => {
    const entry = tables['deepseek-flash']?.entries[0];
    expect(entry?.tier).toBe('off_peak');
    expect(entry?.rates).toEqual({ input_cache_hit: 0.003, input_cache_miss: 0.15, output: 0.6 });
  });

  it('v4-pro 费率数值正确', () => {
    const entry = tables['deepseek-v4-pro']?.entries[0];
    expect(entry?.rates).toEqual({ input_cache_hit: 0.022, input_cache_miss: 0.66, output: 1.98 });
  });

  it('peak = off_peak 的 2 倍（两条 rule_set 的四个窗口都一样）', () => {
    for (const table of Object.values(tables)) {
      const entry = table.entries[0];
      if (entry === undefined) throw new Error('unreachable');
      for (const rs of entry.rule_sets ?? []) {
        expect(rs.windows).toHaveLength(2);
        for (const w of rs.windows) {
          expect(w.tier).toBe('peak');
          for (const slot of ['input_cache_hit', 'input_cache_miss', 'output'] as const) {
            const base = entry.rates[slot];
            if (base === undefined) throw new Error(`missing slot ${slot}`);
            expect(w.rates[slot]).toBeCloseTo(base * 2, 12);
          }
        }
      }
    }
  });

  it('规则集边界：08-17 上线峰谷，08-23 起周末全天低谷', () => {
    const entry = tables['deepseek-flash']?.entries[0];
    const ruleSets = entry?.rule_sets ?? [];
    expect(ruleSets).toHaveLength(2);
    expect(ruleSets[0]?.effective_from).toBe('2026-08-17');
    expect(ruleSets[0]?.effective_to).toBe('2026-08-23');
    expect(ruleSets[0]?.windows.every((w) => w.days_of_week === undefined)).toBe(true);
    expect(ruleSets[1]?.effective_from).toBe('2026-08-23');
    expect(ruleSets[1]?.effective_to).toBeUndefined();
    expect(ruleSets[1]?.windows.every((w) => w.days_of_week?.join() === '1,2,3,4,5')).toBe(true);
  });

  it('tools 单价原样交出', () => {
    expect(tools).toEqual({
      search_per_1000_requests: 0.75,
      fetch_per_1000_requests: 0.75,
      ocr_per_1000_pages: 0.225,
      tts_per_10000_characters: 0.45,
      tts_per_10000_characters_discounted: 0.225,
      asr_per_hour: 0.116,
      asr_per_hour_discounted: 0.058,
    });
  });

  it('deepseekPriceTableFor：有表的 model 返回表，没有的返回 undefined', () => {
    expect(deepseekPriceTableFor('deepseek-flash', tables)?.table_version).toBe(
      'deepseek-2026-11-14',
    );
    expect(deepseekPriceTableFor('deepseek-v4-pro', tables)).toBeDefined();
    expect(deepseekPriceTableFor('gpt-test-1', tables)).toBeUndefined();
    // 不传 tables 时当场 load（便利路径）
    expect(deepseekPriceTableFor('deepseek-flash')?.entries).toHaveLength(1);
  });

  it('deepseekPriceTableFor 第二参两种形态都收（bundle 与已拆好的 Record）', () => {
    const bundle = loadDeepSeekPriceTables();
    expect(deepseekPriceTableFor('deepseek-flash', bundle)?.entries).toHaveLength(1);
    expect(deepseekPriceTableFor('deepseek-flash', bundle.tables)?.entries).toHaveLength(1);
    expect(deepseekPriceTableFor('nope', bundle)).toBeUndefined();
    expect(deepseekPriceTableFor('nope', bundle.tables)).toBeUndefined();
    // 两种形态取到的是同一份费率
    expect(deepseekPriceTableFor('deepseek-v4-pro', bundle)?.entries[0]?.rates).toEqual(
      deepseekPriceTableFor('deepseek-v4-pro', bundle.tables)?.entries[0]?.rates,
    );
  });

  it('端到端：周一峰时 → peak 价，周六 → off_peak 价', () => {
    const flash = tables['deepseek-flash'];
    if (flash === undefined) throw new Error('unreachable');
    expect(mustResolve(flash, TS_MONDAY_PEAK).tier).toBe('peak');
    expect(mustResolve(flash, TS_SATURDAY_NOON).tier).toBe('off_peak');
    const cost = computeCost(TOKEN_USAGE, mustResolve(flash, TS_MONDAY_PEAK));
    expect(cost.as_api.total).toBeCloseTo(0.4224, 12);
    const offPeak = computeCost(TOKEN_USAGE, mustResolve(flash, TS_SATURDAY_NOON));
    expect(offPeak.as_api.total).toBeCloseTo(0.2112, 12);
  });
});
