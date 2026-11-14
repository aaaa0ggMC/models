/**
 * src/charts/series.ts —— 图表数据层的**纯函数**（不碰 DOM、不碰 React）。
 *
 * ## 为什么单独一个文件
 *
 * 本仓库前端工程刻意零测试依赖（不引 jsdom / @testing-library，见
 * `webui/admin/README.md` 的选型结论与 `tests/ui-contract.test.ts` 的说明），
 * 所以**能测的全放这里**：vitest 的 include 只覆盖 `.test.ts` 后缀的文件。
 * 图形渲染（SVG 字符串 / path）恰好也是纯函数——把它和 React 分开，
 * 就等于把"图画得对不对"变成了可断言的。
 *
 * ## 约定
 *
 * - 所有函数对空输入、单点、全零都不得抛异常（趋势图最常画的就是"还没流量"）；
 * - 坐标一律用**像素**（SVG user units），不做百分比——百分比在 viewBox 缩放
 *   下会让 stroke-width 一起被缩放，线宽会随容器大小变形；
 * - `niceTicks` 产出"人话刻度"（1/2/5×10ⁿ），轴标签才落得在整数位上。
 */

/** 一个数据点：x 用时间戳，y 是指标值。 */
export interface Point {
  x: number;
  y: number;
}

/** 一条系列（折线 / 面积 / 柱子共用）。 */
export interface Series {
  key: string;
  label: string;
  color: string;
  points: Point[];
}

// ---------------------------------------------------------------------------
// 刻度与坐标
// ---------------------------------------------------------------------------

/**
 * 取"好看"的轴上限与刻度。
 *
 * 为什么要 nice：y 轴上限是 137 的时候，刻度会落在 34.25 / 68.5 / 102.75 上，
 * 标签全是小数，读者还得自己心算。nice 化之后上限变 150、刻度 0/50/100/150。
 *
 * @param min 数据最小值（允许 < 0；成本/请求数这类计数恒 ≥ 0，但留着以防万一）
 * @param max 数据最大值
 * @param count 期望刻度条数（实际可能少一两条）
 */
export function niceScale(
  min: number,
  max: number,
  count = 4,
): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    // 全零 / 常量：给一个 0..1 的轴，别除以 0。
    const top = max === 0 ? 1 : max * 1.2;
    return { min: Math.min(0, min), max: top, ticks: ticksBetween(Math.min(0, min), top, count) };
  }
  const lo = Math.min(0, min);
  const span = max - lo;
  const step = niceStep(span / Math.max(1, count));
  const niceMax = Math.ceil(max / step) * step;
  const niceMin = Math.floor(lo / step) * step;
  return { min: niceMin, max: niceMax, ticks: ticksBetween(niceMin, niceMax, count) };
}

/** 1/2/5×10ⁿ 系列的"好看步长"。 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const frac = raw / base;
  const mult = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return mult * base;
}

function ticksBetween(lo: number, hi: number, count: number): number[] {
  const step = niceStep((hi - lo) / Math.max(1, count));
  const out: number[] = [];
  // 从 lo 开始整数步进，避免 0.30000000000000004 这种尾巴。
  const first = Math.ceil(lo / step) * step;
  for (let v = first; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  if (out.length === 0) out.push(lo, hi);
  return out;
}

/** 把一组数映射到 [0, size] 像素（0 在底部）。 */
export function linearScale(
  value: number,
  domain: { min: number; max: number },
  size: number,
): number {
  const span = domain.max - domain.min;
  if (!Number.isFinite(span) || span <= 0) return 0;
  const t = (value - domain.min) / span;
  return clamp01(t) * size;
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// SVG path
// ---------------------------------------------------------------------------

/** 折线 path（`M … L … L …`）。点数 < 2 时返回空串——单点画不出线。 */
export function linePath(points: Point[]): string {
  if (points.length < 2) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)},${round(p.y)}`).join(' ');
}

/**
 * 面积 path（闭合到基线）。
 *
 * 面积图只在**单系列**时用：多系列叠面积会让下面的形状被上面的"抬"着走，
 * 读者读不出下面那条的真实值（data.europa.eu 的 stacked charts 指南把这点叫
 * "moving baseline problem"）。单系列时面积填充不增加信息量，但让"总量"更醒目。
 */
export function areaPath(points: Point[], baselineY: number): string {
  if (points.length < 2) return '';
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const head = `M${round(first.x)},${round(baselineY)}`;
  const body = points.map((p, i) => `${i === 0 ? 'L' : 'L'}${round(p.x)},${round(p.y)}`).join(' ');
  return `${head} ${body} L${round(last.x)},${round(baselineY)} Z`;
}

/** 柱状 path（圆角矩形）。单点也画得出来。 */
export function barPath(x: number, y: number, w: number, h: number, r = 3): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (h <= 0 || w <= 0) return '';
  return [
    `M${round(x + rr)},${round(y)}`,
    `H${round(x + w - rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x + w)},${round(y + rr)}`,
    `V${round(y + h - rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x + w - rr)},${round(y + h)}`,
    `H${round(x + rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x)},${round(y + h - rr)}`,
    `V${round(y + rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x + rr)},${round(y)}`,
    'Z',
  ].join(' ');
}

/** 横向条 path（从左往右长）。 */
export function hBarPath(x: number, y: number, w: number, h: number, r = 3): string {
  const rr = Math.max(0, Math.min(r, h / 2, w));
  if (w <= 0 || h <= 0) return '';
  return [
    `M${round(x + rr)},${round(y)}`,
    `H${round(x + w - rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x + w)},${round(y + rr)}`,
    `V${round(y + h - rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x + w - rr)},${round(y + h)}`,
    `H${round(x + rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x)},${round(y + h - rr)}`,
    `V${round(y + rr)}`,
    `A${round(rr)},${round(rr)} 0 0 1 ${round(x + rr)},${round(y)}`,
    'Z',
  ].join(' ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// 抽样（点太多时）
// ---------------------------------------------------------------------------

/**
 * LTTB（Largest Triangle Three Buckets）抽样。
 *
 * 趋势图最多画 ~120 个点（再密就糊成一片）。这里不随机抽——随机抽样会把尖峰
 * 抽没了，而尖峰恰恰是管理员最想看的东西。LTTB 按"保留三角形面积最大的点"
 * 抽样，形状保真度高，是时序下采样的事实标准。
 *
 * @param maxPoints 目标点数（< 2 时原样返回）
 */
export function downsample<T extends { x: number; y: number }>(points: T[], maxPoints: number): T[] {
  if (!Number.isFinite(maxPoints) || maxPoints < 3 || points.length <= maxPoints) return points;
  const out: T[] = [];
  const bucketSize = (points.length - 2) / (maxPoints - 2);
  out.push(points[0]!);
  let prev = points[0]!;
  for (let i = 1; i < maxPoints - 1; i += 1) {
    const start = Math.floor((i - 1) * bucketSize) + 1;
    const end = Math.floor(i * bucketSize) + 1;
    // 下一个桶的平均点：用它当三角形的第三顶点。
    let avgX = 0;
    let avgY = 0;
    const nextStart = Math.floor(i * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, points.length);
    const nextCount = Math.max(1, nextEnd - nextStart);
    for (let j = nextStart; j < nextEnd; j += 1) {
      avgX += points[j]!.x;
      avgY += points[j]!.y;
    }
    avgX /= nextCount;
    avgY /= nextCount;
    let best = points[start]!;
    let bestArea = -1;
    for (let j = start; j < end && j < points.length; j += 1) {
      const p = points[j]!;
      const area =
        Math.abs(
          (prev.x - avgX) * (p.y - prev.y) - (prev.x - p.x) * (avgY - prev.y),
        ) * 0.5;
      if (area > bestArea) {
        bestArea = area;
        best = p;
      }
    }
    out.push(best);
    prev = best;
  }
  out.push(points[points.length - 1]!);
  return out;
}

// ---------------------------------------------------------------------------
// 聚合（分布图）
// ---------------------------------------------------------------------------

export interface Bucket {
  key: string;
  label: string;
  value: number;
  /** 占总量的比例（0..1；总量为 0 时全为 0）。 */
  share: number;
}

/**
 * 按 key 聚合，取前 N，剩下的合并成"其他"。
 *
 * 为什么必须合并：模型名动辄 30+ 字符（`claude-sonnet-4-5-20250929`），
 * 一个网关下可能有二十几个模型。全画出来横向条形图会撑爆卡片，
 * 而尾部那些占比 0.0x% 的条对判断没有任何贡献。
 */
export function topN<T>(
  items: T[],
  keyOf: (item: T) => string,
  valueOf: (item: T) => number,
  n: number,
  otherLabel = '其他',
): Bucket[] {
  const map = new Map<string, number>();
  for (const it of items) {
    const k = keyOf(it);
    map.set(k, (map.get(k) ?? 0) + valueOf(it));
  }
  const all = [...map.entries()]
    .map(([key, value]) => ({ key, label: key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const total = all.reduce((s, b) => s + b.value, 0);
  const head = all.slice(0, Math.max(0, n));
  const tail = all.slice(Math.max(0, n));
  const buckets: Bucket[] = head.map((b) => ({
    key: b.key,
    label: b.label,
    value: b.value,
    share: total > 0 ? b.value / total : 0,
  }));
  if (tail.length > 0) {
    const tailSum = tail.reduce((s, b) => s + b.value, 0);
    buckets.push({
      key: '__other__',
      label: otherLabel,
      value: tailSum,
      share: total > 0 ? tailSum / total : 0,
    });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// sparkline
// ---------------------------------------------------------------------------

/**
 * 卡片里的迷你走势线（Tufte 的 sparkline）。
 *
 * 规则照 Tufte 原文：**没有坐标轴、没有刻度、没有边框**，量化尺度由卡片上的
 * 大字承担（"sparklines have a data-ink or data-pixel ratio = 1.0"）。
 * 所以这里只返回 path，不返回任何装饰元素的坐标。
 *
 * @param values y 值序列（允许有 0；长度 < 2 时返回空串）
 * @param w 宽（px）
 * @param h 高（px）
 * @param pad 上下留白（px），避免线贴在边缘上
 */
export function sparklinePath(values: number[], w: number, h: number, pad = 2): string {
  if (values.length < 2 || w <= 0 || h <= 0) return '';
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  const span = hi - lo;
  const inner = Math.max(1, h - pad * 2);
  const step = w / (values.length - 1);
  return values
    .map((v, i) => {
      const t = span === 0 ? 0.5 : (v - lo) / span;
      const y = pad + (1 - clamp01(t)) * inner;
      return `${i === 0 ? 'M' : 'L'}${round(i * step)},${round(y)}`;
    })
    .join(' ');
}

/** sparkline 末点的坐标（给那个强调用小圆点用）。 */
export function sparklineEnd(
  values: number[],
  w: number,
  h: number,
  pad = 2,
): { x: number; y: number } | null {
  if (values.length < 2 || w <= 0 || h <= 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const span = hi - lo;
  const inner = Math.max(1, h - pad * 2);
  const last = values[values.length - 1]!;
  const t = span === 0 ? 0.5 : (last - lo) / span;
  return { x: w, y: pad + (1 - clamp01(t)) * inner };
}

// ---------------------------------------------------------------------------
// x 轴刻度
// ---------------------------------------------------------------------------

/**
 * x 轴要显示哪些下标（含首尾，最多 `max` 个，去重且升序）。
 *
 * 为什么要挑：24h / 30d 的桶数是 24 / 30，全画标签在 600px 宽的卡片里必然
 * 互相压。挑等距的 6 个（含首尾）既保住"起点与现在"这两个锚点，
 * 又不会挤成一团。
 */
export function xTickIndices(count: number, max = 6): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(Math.round((i * (count - 1)) / (max - 1)));
  }
  return [...new Set(out)];
}
