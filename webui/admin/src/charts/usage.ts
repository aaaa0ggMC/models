/**
 * src/charts/usage.ts —— 把用量契约的数据变成图表系列（**纯函数**，可单测）。
 *
 * 与 `series.ts` 的分工：`series.ts` 是"任意折线/条形图的几何"，
 * 本文件是"我们这套用量契约长什么样"。两者都不碰 React，
 * 于是"图画得对不对"是可断言的（见 `src/charts/usage.test.ts`）。
 */

import type { UsageTimeseriesBucket, UsageTimeseriesResponse } from '../api/types';
import type { Bucket, Point, Series } from './series';
import { topN } from './series';

/** 时间范围档位（与后端 `defaultBucketMs` 的档位对齐）。 */
export interface RangePreset {
  key: string;
  label: string;
  hours: number;
  /** 期望桶宽（epoch ms）；不给则由后端按区间选默认档。 */
  bucketMs?: number;
}

export const RANGE_PRESETS: RangePreset[] = [
  { key: '24h', label: '24 小时', hours: 24, bucketMs: 3600_000 },
  { key: '7d', label: '7 天', hours: 24 * 7, bucketMs: 6 * 3600_000 },
  { key: '30d', label: '30 天', hours: 24 * 30, bucketMs: 24 * 3600_000 },
];

export function presetByKey(key: string): RangePreset {
  return RANGE_PRESETS.find((p) => p.key === key) ?? RANGE_PRESETS[0]!;
}

/** 由档位算出 `[from_ts, to_ts)`。 */
export function rangeOf(preset: RangePreset, now: number): { from_ts: number; to_ts: number } {
  return { from_ts: now - preset.hours * 3600_000, to_ts: now };
}

// ---------------------------------------------------------------------------
// 桶 → 点
// ---------------------------------------------------------------------------

/** 桶里取哪个指标。 */
export type BucketMetric = keyof Pick<
  UsageTimeseriesBucket,
  'request_count' | 'input_tokens' | 'output_tokens' | 'cash_total' | 'as_api_total' | 'unpriced_count'
>;

/**
 * 桶 → 折线点。
 *
 * 每个桶取它的**起点**当 x：桶代表的是"这一段时间"，落在起点上相邻两点
 * 的距离正好是一个桶宽，视觉上和"这段时间的中点"等价，但省一次加法。
 */
export function bucketPoints(buckets: UsageTimeseriesBucket[], metric: BucketMetric): Point[] {
  return buckets.map((b) => ({ x: b.from_ts, y: num(b[metric]) }));
}

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 卡片里的 sparkline 用（只要 y 序列）。 */
export function bucketValues(buckets: UsageTimeseriesBucket[], metric: BucketMetric): number[] {
  return buckets.map((b) => num(b[metric]));
}

/** 一个指标在整个区间上的合计（与 `/usage` 的 summary 同源，用于对账）。 */
export function bucketSum(buckets: UsageTimeseriesBucket[], metric: BucketMetric): number {
  return buckets.reduce((s, b) => s + num(b[metric]), 0);
}

/** 由 summary 的 by_* 数组造排行桶（取前 N，其余并入"其他"）。 */
export function rankedBuckets(
  items: Array<{ model?: string; provider?: string; request_count: number; cash_total: number }>,
  dim: 'model' | 'provider',
  metric: 'request_count' | 'cash_total',
  n: number,
): Bucket[] {
  return topN(
    items,
    (it) => (dim === 'model' ? (it.model ?? '未知模型') : (it.provider ?? '未知 provider')),
    (it) => num(it[metric]),
    n,
    dim === 'model' ? '其他模型' : '其他 provider',
  );
}

// ---------------------------------------------------------------------------
// 系列构造
// ---------------------------------------------------------------------------

export interface TrendSpec {
  key: string;
  label: string;
  metric: BucketMetric;
}

/** 图表分类色（与 theme.css 的 `--ag-chart-N` 一一对应）。 */
export const CHART_COLORS = [
  'var(--ag-chart-1)',
  'var(--ag-chart-2)',
  'var(--ag-chart-3)',
  'var(--ag-chart-4)',
  'var(--ag-chart-5)',
  'var(--ag-chart-6)',
] as const;

export function chartColor(index: number): string {
  const i = ((index % CHART_COLORS.length) + CHART_COLORS.length) % CHART_COLORS.length;
  return CHART_COLORS[i]!;
}

/**
 * 造一条或多条系列。
 *
 * 多系列（如按 provider 的成本趋势）需要后端按维度分桶——当前契约没有，
 * 所以现阶段只用单指标系列；多维度趋势等 §4.4 的 `group_by` 参数落地后再开。
 */
export function buildSeries(
  ts: UsageTimeseriesResponse | null,
  specs: TrendSpec[],
): Series[] {
  if (ts === null || ts.buckets.length === 0) return [];
  return specs.map((s, i) => ({
    key: s.key,
    label: s.label,
    color: chartColor(i),
    points: bucketPoints(ts.buckets, s.metric),
  }));
}

// ---------------------------------------------------------------------------
// 标签与 tooltip
// ---------------------------------------------------------------------------

/**
 * x 轴标签：按桶宽选粒度。
 *
 * 桶宽 ≤ 1 小时 → 只显示时刻（`14:00`）；≤ 1 天 → 日期+时刻；
 * 更长 → 只显示日期（`11-07`）。标签太长在 1200px 的卡片里必然互相压。
 */
export function bucketAxisLabel(ts: number, bucketMs: number): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (bucketMs <= 3600_000) return `${hh}:${mm}`;
  // 桶宽不足一天时带上时刻（一天之内的桶要靠钟点区分）；
  // 满一天及以上只显示日期——桶起点那个 08:53 是噪音，不是信息。
  if (bucketMs < 24 * 3600_000) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hh}:${mm}`;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** tooltip 标题：完整到分钟，管理员要对时间。 */
export function bucketTooltipTitle(ts: number): string {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 环比
// ---------------------------------------------------------------------------

export interface Delta {
  text: string;
  tone: 'good' | 'bad' | 'flat';
}

/**
 * 环比文案与语义。
 *
 * 颜色**不按涨跌方向**定，按"这个指标涨了是好是坏"定：请求量涨是好事，
 * 成本涨是坏事。Plotly 的 KPI 指引专门点出这个坑
 * （"Increasing and decreasing colors, and when red isn't bad"）。
 * 同时文案里必须写出跟谁比（"vs 前 7 天"）——裸一个 `-12%` 读者不知道
 * 基准是什么。
 */
export function deltaOf(current: number, previous: number, periodLabel: string, goodWhenUp: boolean): Delta {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
    return { text: `无上期可比（vs ${periodLabel}）`, tone: 'flat' };
  }
  const pct = ((current - previous) / previous) * 100;
  if (!Number.isFinite(pct)) {
    return { text: `无上期可比（vs ${periodLabel}）`, tone: 'flat' };
  }
  const abs = Math.abs(pct);
  const text = `${pct >= 0 ? '▲' : '▼'} ${abs.toFixed(abs < 10 ? 1 : 0)}% vs ${periodLabel}`;
  if (abs < 1) return { text: `基本持平 vs ${periodLabel}`, tone: 'flat' };
  const up = pct > 0;
  return { text, tone: up === goodWhenUp ? 'good' : 'bad' };
}

/**
 * 上一周期同长度区间的起止（用于取环比基准）。
 *
 * 只对"有上一个完整周期"的情况成立：当前区间往前推同样的长度。
 */
export function previousRange(
  fromTs: number,
  toTs: number,
): { from_ts: number; to_ts: number } {
  const span = Math.max(0, toTs - fromTs);
  return { from_ts: fromTs - span, to_ts: fromTs };
}
