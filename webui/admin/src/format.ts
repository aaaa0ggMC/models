/** src/format.ts —— 展示用格式化（时间 / 数字 / 金额）。 */

export function fmtTs(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function fmtInt(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

/**
 * 紧凑数字（轴标签 / 统计卡大字用）。
 *
 * 为什么不用千分位：y 轴只有 ~40px 宽，`1,204,883` 会挤成一团；Stephen Few 在
 * 《Information Dashboard Design》里也明确说"过度精确只会拖慢读者"——
 * 轴上看的是量级，精确值在 tooltip 里给。
 */
export function fmtCompact(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n * 100) / 100);
  if (abs < 10_000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  if (abs < 1_000_000) return `${trim(n / 1000)}K`;
  if (abs < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

/** 紧凑金额（美元）。 */
export function fmtUsdCompact(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${fmtCompact(n)}`;
}

function trim(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** 现金/价值合计：契约注明是 USD。 */
export function fmtUsd(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/** 偏差比例：null 表示「没有可比对基准」，不是 0。 */
export function fmtRatio(r: number | null | undefined): string {
  if (r === null || r === undefined) return '—（无基准）';
  if (typeof r !== 'number' || !Number.isFinite(r)) return '—';
  return `${(r * 100).toFixed(2)}%`;
}

export function fmtDuration(fromTs: number, toTs: number): string {
  if (typeof fromTs !== 'number' || typeof toTs !== 'number') return '—';
  const ms = Math.max(0, toTs - fromTs);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtBool(v: boolean | undefined): string {
  return v ? '是' : '否';
}

/** 模型数：静态清单取长度，其余来源显示类型。 */
export function modelSourceSummary(
  ms: { kind: string; models?: string[]; path?: string; ref?: string } | undefined,
): string {
  if (!ms || typeof ms !== 'object') return '—';
  if (ms.kind === 'static') return `静态清单（${Array.isArray(ms.models) ? ms.models.length : 0}）`;
  if (ms.kind === 'discovery') return `上游发现 ${ms.path ?? ''}`;
  if (ms.kind === 'offline_catalog') return `离线目录 ${ms.ref ?? ''}`;
  return String(ms.kind ?? '—');
}
