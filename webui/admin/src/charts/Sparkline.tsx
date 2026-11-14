/**
 * src/charts/Sparkline.tsx —— 统计卡里的迷你走势线。
 *
 * 规则照 Tufte 对 sparkline 的定义：**没有坐标轴、没有刻度、没有边框、没有图例**，
 * "data-ink or data-pixel ratio = 1.0"；量化尺度由卡片上那个大字承担
 * （"sparklines often get their quantitative scaling context from nearby
 * words, numbers and graphics"）。
 *
 * 所以这里只渲染一条线 + 末点一个圆点，别的什么都没有。
 * 颜色用 currentColor 系列，由卡片按"这个指标好不好"决定（成本涨了是坏事，
 * 请求涨了是好事）——同一个箭头在两张卡上颜色不同，这是故意的。
 */

import { sparklineEnd, sparklinePath } from './series';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** 线条颜色（默认继承文字的当前色）。 */
  color?: string;
  /** 末点是否画强调圆点。 */
  dot?: boolean;
  ariaLabel?: string;
}

export function Sparkline({
  values,
  width = 96,
  height = 28,
  color = 'currentColor',
  dot = true,
  ariaLabel = '近期走势',
}: SparklineProps): JSX.Element {
  const d = sparklinePath(values, width, height, 3);
  if (d === '') return <span style={{ display: 'inline-block', width, height }} aria-hidden />;
  const end = dot ? sparklineEnd(values, width, height, 3) : null;

  return (
    <svg
      className="ag-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      {end !== null ? (
        <circle cx={end.x} cy={end.y} r={2.4} fill={color} stroke="var(--ag-surface)" strokeWidth={1.2} />
      ) : null}
    </svg>
  );
}
