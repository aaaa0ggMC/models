/**
 * admin/usage-timeseries.test.ts —— 用量时间序列的切桶回归测试。
 *
 * 被测对象是 `buildUsageTimeseries`（admin/service.ts 导出的纯函数）。
 * 为什么值得单测：**桶边界错一格，趋势图整体平移，而这种 bug 在 UI 上看不出来**——
 * 图上照样是一条线，只是所有点对错了时间。所以这里把边界、空桶、上限、越界
 * 四条性质钉死。
 *
 * 夹具全是键盘乱敲的假数据（不对应任何真实请求 / 密钥）。
 */

import { describe, expect, it } from 'vitest';
import { buildUsageTimeseries } from './service.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const FROM = 1_760_000_000_000;

/** 造一条记录（只用得到 ts / token / cost / status）。 */
function rec(
  ts: number,
  over: Partial<{ input: number; output: number; cash: number; as_api: number; status: string }> = {},
): {
  ts: number;
  usage: { units: { tokens?: { input_tokens?: number; output_tokens?: number } } };
  cost: { cash: { total: number }; as_api: { total: number }; status: string };
} {
  return {
    ts,
    usage: { units: { tokens: { input_tokens: over.input ?? 0, output_tokens: over.output ?? 0 } } },
    cost: {
      cash: { total: over.cash ?? 0 },
      as_api: { total: over.as_api ?? 0 },
      status: over.status ?? 'priced',
    },
  };
}

describe('buildUsageTimeseries：桶严丝合缝铺满区间', () => {
  it('24h 区间 + 1h 期望桶宽 → 24 个桶，相邻桶首尾相接', () => {
    const r = buildUsageTimeseries([], FROM, FROM + DAY, HOUR);
    expect(r.buckets).toHaveLength(24);
    expect(r.bucket_ms).toBe(HOUR);
    for (let i = 0; i < r.buckets.length; i += 1) {
      const b = r.buckets[i]!;
      expect(b.from_ts).toBe(FROM + i * HOUR);
      expect(b.to_ts).toBe(FROM + (i + 1) * HOUR);
      // 与下一个桶相接：没有缝，也没有重叠
      const next = r.buckets[i + 1];
      if (next !== undefined) expect(next.from_ts).toBe(b.to_ts);
    }
    expect(r.buckets.at(-1)!.to_ts).toBe(FROM + DAY);
  });

  it('期望桶宽除不尽区间时，用「区间/桶数」反算，绝不留下短尾巴桶', () => {
    // 25 小时 / 1 小时期望 → 25 个桶、每桶正好 1 小时
    const r = buildUsageTimeseries([], FROM, FROM + 25 * HOUR, HOUR);
    expect(r.buckets).toHaveLength(25);
    expect(r.bucket_ms).toBe(HOUR);
    // 23.5 小时 / 1 小时期望 → 24 个桶、每桶 58.75 分钟（而不是 23 个整小时 + 1 个半小时）
    const odd = buildUsageTimeseries([], FROM, FROM + 23.5 * HOUR, HOUR);
    expect(odd.buckets).toHaveLength(24);
    expect(odd.bucket_ms).toBeCloseTo((23.5 * HOUR) / 24, 6);
    expect(odd.buckets.every((b) => b.to_ts - b.from_ts === odd.bucket_ms)).toBe(true);
  });

  it('没给期望桶宽时按区间选默认档（24h → 30 分钟，48 桶）', () => {
    const r = buildUsageTimeseries([], FROM, FROM + DAY);
    expect(r.buckets).toHaveLength(48);
    expect(r.bucket_ms).toBe(30 * 60_000);
  });
});

describe('buildUsageTimeseries：空桶照样返回（趋势图的 x 轴必须等距）', () => {
  it('一条记录落在第 3 个小时，其余 23 个桶是全零而不是被省略', () => {
    // 2.5h：明确落在第 3 个桶里（不与任何边界重合，避免和左闭右开的用例混起来）
    const r = buildUsageTimeseries(
      [rec(FROM + 2.5 * HOUR, { input: 10, output: 5, cash: 0.5 })],
      FROM,
      FROM + DAY,
      HOUR,
    );
    expect(r.buckets).toHaveLength(24);
    expect(r.buckets[2]!.request_count).toBe(1);
    expect(r.buckets[2]!.input_tokens).toBe(10);
    expect(r.buckets[2]!.output_tokens).toBe(5);
    expect(r.buckets[2]!.cash_total).toBe(0.5);
    for (const [i, b] of r.buckets.entries()) {
      if (i === 2) continue;
      expect(b.request_count).toBe(0);
    }
    // 合计与汇总口径一致：趋势图各桶相加必须等于 summary
    const total = r.buckets.reduce((n, b) => n + b.request_count, 0);
    expect(total).toBe(1);
  });

  it('零请求的区间返回全零桶（available 仍为 true：有数据源，只是没流量）', () => {
    const r = buildUsageTimeseries([], FROM, FROM + 7 * DAY);
    expect(r.available).toBe(true);
    expect(r.buckets.every((b) => b.request_count === 0 && b.cash_total === 0)).toBe(true);
  });
});

describe('buildUsageTimeseries：桶数上限', () => {
  it('区间再长也不超过 120 个桶', () => {
    const r = buildUsageTimeseries([], FROM, FROM + 365 * DAY, HOUR);
    expect(r.buckets.length).toBeLessThanOrEqual(120);
    expect(r.buckets).toHaveLength(120);
    // 收紧之后仍然铺满区间
    expect(r.buckets.at(-1)!.to_ts).toBe(FROM + 365 * DAY);
    expect(r.bucket_ms).toBeCloseTo((365 * DAY) / 120, 6);
  });
});

describe('buildUsageTimeseries：记录归桶', () => {
  it('ts 恰好落在桶的右边界 → 进下一个桶（左闭右开）', () => {
    const r = buildUsageTimeseries([rec(FROM + 2 * HOUR)], FROM, FROM + DAY, HOUR);
    expect(r.buckets[1]!.request_count).toBe(0);
    expect(r.buckets[2]!.request_count).toBe(1);
  });

  it('ts 越界（未来 / 过去）→ 落进边界桶，不静默丢弃', () => {
    const r = buildUsageTimeseries([rec(FROM - 5 * HOUR), rec(FROM + DAY + 5 * HOUR)], FROM, FROM + DAY, HOUR);
    expect(r.buckets[0]!.request_count).toBe(1);
    expect(r.buckets.at(-1)!.request_count).toBe(1);
    expect(r.buckets.reduce((n, b) => n + b.request_count, 0)).toBe(2);
  });

  it('unpriced / pending_price 只进 unpriced_count，不影响别的字段', () => {
    const r = buildUsageTimeseries(
      [
        rec(FROM + HOUR, { status: 'unpriced', input: 7 }),
        rec(FROM + HOUR, { status: 'pending_price' }),
        rec(FROM + HOUR, { status: 'priced', cash: 1.25 }),
      ],
      FROM,
      FROM + DAY,
      HOUR,
    );
    expect(r.buckets[1]!.request_count).toBe(3);
    expect(r.buckets[1]!.unpriced_count).toBe(2);
    expect(r.buckets[1]!.cash_total).toBe(1.25);
  });

  it('缺 token / cost 字段时按 0 计（契约里它们是可选字段）', () => {
    const r = buildUsageTimeseries(
      [{ ts: FROM + HOUR, usage: { units: {} }, cost: { cash: { total: 0 }, as_api: { total: 0 }, status: 'priced' } }],
      FROM,
      FROM + DAY,
      HOUR,
    );
    expect(r.buckets[1]!.request_count).toBe(1);
    expect(r.buckets[1]!.input_tokens).toBe(0);
  });
});
