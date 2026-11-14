/**
 * src/charts/usage.test.ts —— 用量契约 → 图表系列 的回归测试。
 *
 * 守三条性质：
 *   ① **各桶相加 == summary**：趋势图和统计卡必须是同一个数，否则读者
 *      不知道信哪个（这类"图上和卡上对不上"的 bug 在 UI 上极难发现）；
 *   ② 空区间 / 空数组不抛异常（管理面最常见的状态就是"还没流量"）；
 *   ③ 环比的语义方向按指标定，不按涨跌方向定。
 */

import { describe, expect, it } from 'vitest';
import {
  RANGE_PRESETS,
  bucketAxisLabel,
  bucketPoints,
  bucketSum,
  bucketTooltipTitle,
  bucketValues,
  chartColor,
  deltaOf,
  presetByKey,
  previousRange,
  rangeOf,
  rankedBuckets,
} from './usage';
import type { UsageTimeseriesBucket } from '../api/types';

const FROM = 1_760_000_000_000;
const HOUR = 3600_000;

function bucket(i: number, over: Partial<UsageTimeseriesBucket> = {}): UsageTimeseriesBucket {
  return {
    from_ts: FROM + i * HOUR,
    to_ts: FROM + (i + 1) * HOUR,
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cash_total: 0,
    as_api_total: 0,
    unpriced_count: 0,
    ...over,
  };
}

const BUCKETS = [
  bucket(0, { request_count: 3, input_tokens: 100, output_tokens: 20, cash_total: 0.5 }),
  bucket(1, { request_count: 0, input_tokens: 0, output_tokens: 0, cash_total: 0 }),
  bucket(2, { request_count: 7, input_tokens: 300, output_tokens: 60, cash_total: 1.25, unpriced_count: 2 }),
];

describe('时间范围档位', () => {
  it('三档预设的桶宽递增', () => {
    expect(RANGE_PRESETS.map((p) => p.key)).toEqual(['24h', '7d', '30d']);
    const widths = RANGE_PRESETS.map((p) => p.bucketMs ?? 0);
    expect(widths[0]!).toBeLessThan(widths[1]!);
    expect(widths[1]!).toBeLessThan(widths[2]!);
  });

  it('未知 key 回落到第一档（不抛异常）', () => {
    expect(presetByKey('nope').key).toBe('24h');
    expect(presetByKey('').key).toBe('24h');
  });

  it('rangeOf：区间是 [now - hours, now]', () => {
    const r = rangeOf(presetByKey('24h'), FROM);
    expect(r.to_ts).toBe(FROM);
    expect(r.from_ts).toBe(FROM - 24 * HOUR);
  });
});

describe('桶 → 点 / 值 / 合计', () => {
  it('bucketPoints 用桶起点当 x', () => {
    const pts = bucketPoints(BUCKETS, 'request_count');
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ x: FROM, y: 3 });
    expect(pts[1]).toEqual({ x: FROM + HOUR, y: 0 });
  });

  it('**各桶相加 == 区间合计**（趋势图与统计卡必须同数）', () => {
    expect(bucketSum(BUCKETS, 'request_count')).toBe(10);
    expect(bucketSum(BUCKETS, 'input_tokens')).toBe(400);
    expect(bucketSum(BUCKETS, 'output_tokens')).toBe(80);
    expect(bucketSum(BUCKETS, 'cash_total')).toBeCloseTo(1.75, 10);
    expect(bucketSum(BUCKETS, 'unpriced_count')).toBe(2);
    // 单独相加也对得上
    expect(bucketValues(BUCKETS, 'request_count').reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('空数组 → 空（不抛异常）', () => {
    expect(bucketPoints([], 'request_count')).toEqual([]);
    expect(bucketValues([], 'request_count')).toEqual([]);
    expect(bucketSum([], 'cash_total')).toBe(0);
  });
});

describe('rankedBuckets', () => {
  const summary = {
    by_model: [
      { model: 'deepseek-chat', request_count: 10, cash_total: 5 },
      { model: 'gpt-4o-mini', request_count: 4, cash_total: 2 },
      { model: 'claude-sonnet-4-5', request_count: 1, cash_total: 1 },
      { model: 'x', request_count: 1, cash_total: 0.5 },
      { model: 'y', request_count: 1, cash_total: 0.25 },
    ],
    by_provider: [{ provider: 'deepseek', request_count: 10, cash_total: 5 }],
  };

  it('按花费降序，取前 N 后并入「其他」', () => {
    const b = rankedBuckets(summary.by_model, 'model', 'cash_total', 3);
    expect(b).toHaveLength(4);
    expect(b[0]!.label).toBe('deepseek-chat');
    expect(b[3]!.key).toBe('__other__');
    expect(b[3]!.value).toBeCloseTo(0.75, 10);
  });

  it('按请求数排会是另一个顺序（两个维度不能混）', () => {
    const byReq = rankedBuckets(summary.by_model, 'model', 'request_count', 3);
    expect(byReq[0]!.label).toBe('deepseek-chat');
    expect(byReq[1]!.value).toBe(4);
  });

  it('share 合计为 1', () => {
    const b = rankedBuckets(summary.by_model, 'model', 'cash_total', 3);
    expect(b.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 10);
  });

  it('provider 维度的「其他」标签不同', () => {
    const b = rankedBuckets(
      [
        { provider: 'a', request_count: 1, cash_total: 1 },
        { provider: 'b', request_count: 1, cash_total: 1 },
      ],
      'provider',
      'cash_total',
      1,
    );
    expect(b[1]!.label).toBe('其他 provider');
  });

  it('空输入 → 空数组', () => {
    expect(rankedBuckets([], 'model', 'cash_total', 8)).toEqual([]);
  });
});

describe('chartColor', () => {
  it('在 6 个色之间循环（第 7 个回到第 1 个）', () => {
    expect(chartColor(0)).toBe('var(--ag-chart-1)');
    expect(chartColor(5)).toBe('var(--ag-chart-6)');
    expect(chartColor(6)).toBe('var(--ag-chart-1)');
    expect(chartColor(12)).toBe('var(--ag-chart-1)');
  });
});

describe('轴标签与 tooltip 标题', () => {
  it('桶宽 ≤ 1h → 只显示时刻', () => {
    expect(bucketAxisLabel(FROM, HOUR)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('桶宽 6h → 日期 + 时刻（一天有 4 个桶，只给日期会重名）', () => {
    expect(bucketAxisLabel(FROM, 6 * HOUR)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('桶宽 ≥ 1 天 → 只显示日期（桶起点那个 08:53 是噪音）', () => {
    expect(bucketAxisLabel(FROM, 24 * HOUR)).toMatch(/^\d{2}-\d{2}$/);
    expect(bucketAxisLabel(FROM, 7 * 24 * HOUR)).toMatch(/^\d{2}-\d{2}$/);
  });

  it('tooltip 标题完整到分钟（管理员要对时间）', () => {
    expect(bucketTooltipTitle(FROM)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法时间戳给占位符，不产出 "NaN:NaN"', () => {
    expect(bucketAxisLabel(Number.NaN, HOUR)).toBe('—');
    expect(bucketTooltipTitle(Number.NaN)).toBe('—');
  });
});

describe('deltaOf：环比语义', () => {
  it('上期为 0 时明说"无上期可比"，不显示 ∞', () => {
    const d = deltaOf(10, 0, '前 7 天', true);
    expect(d.tone).toBe('flat');
    expect(d.text).toContain('无上期可比');
  });

  it('**颜色按指标定，不按方向定**：成本涨 = 坏事，请求涨 = 好事', () => {
    const costUp = deltaOf(120, 100, '前 7 天', false);
    const reqUp = deltaOf(120, 100, '前 7 天', true);
    expect(costUp.tone).toBe('bad');
    expect(reqUp.tone).toBe('good');
    // 两者的箭头方向一致（都是涨），只有语义不同
    expect(costUp.text.startsWith('▲')).toBe(true);
    expect(reqUp.text.startsWith('▲')).toBe(true);
  });

  it('下跌时箭头朝下，且语义同样按指标定', () => {
    expect(deltaOf(80, 100, '前 7 天', false).tone).toBe('good');
    expect(deltaOf(80, 100, '前 7 天', true).tone).toBe('bad');
    expect(deltaOf(80, 100, '前 7 天', true).text.startsWith('▼')).toBe(true);
  });

  it('变动 < 1% 算持平（避免 0.3% 也画个箭头）', () => {
    expect(deltaOf(100.5, 100, '前 7 天', true).tone).toBe('flat');
  });

  it('文案里写出跟谁比（裸一个百分比读者不知道基准）', () => {
    expect(deltaOf(120, 100, '前 7 天', true).text).toContain('前 7 天');
  });

  it('非有限值按"无上期可比"处理（不产出 ▲ NaN%）', () => {
    expect(deltaOf(Number.NaN, 100, '前 7 天', true).tone).toBe('flat');
    expect(deltaOf(100, Number.NaN, '前 7 天', true).tone).toBe('flat');
    expect(deltaOf(Number.NaN, 100, '前 7 天', true).text).not.toContain('NaN');
  });
});

describe('previousRange', () => {
  it('往前推同样的长度', () => {
    const p = previousRange(FROM - 24 * HOUR, FROM);
    expect(p.to_ts).toBe(FROM - 24 * HOUR);
    expect(p.from_ts).toBe(FROM - 48 * HOUR);
  });

  it('区间长度为 0 时不回到负时间', () => {
    const p = previousRange(FROM, FROM);
    expect(p.from_ts).toBe(FROM);
  });
});
