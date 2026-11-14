/**
 * src/charts/TimeSeriesChart.tsx —— 时间序列折线 / 面积图（自绘 SVG）。
 *
 * ## 为什么自绘而不引图表库
 *
 * 见 `docs/design/90-admin-ui-redesign.md` §5 的选型结论。一句话版本：
 * Semi 没有任何图表组件；引 Recharts 要多 ~40KB gzip 与一套 d3 依赖，
 * 而它的暗色配色走 JS props、和我们的 CSS 变量令牌两张皮；
 * 这个页面要的交互（十字准星 + 键盘移动 + 空桶语义）自绘 ~300 行就能拿全。
 *
 * ## 交互约定
 *
 * - **十字准星**（x 轴）：鼠标在画区内移动时画一条竖线 + 各系列在该 x 的值。
 *   Highcharts Stock 默认开启它，是时序图的行业惯例；没有它读者得拿眼睛
 *   从光标往 x 轴" triangulate"。
 * - **键盘可达**：svg 可聚焦，←/→ 移动准星，Esc 收起。工具条信息不允许
 *   "只有鼠标能看到"（NN/g 的 tooltip 指引第 3 条）。
 * - **tooltip 显示全部系列 + 合计**（Grafana 的 All 模式）：堆叠/多系列的
 *   问题通常是"这一刻总共多少"，只显示悬停那一条答不上来。
 * - **空桶**：后端保证等距返回空桶（见 admin/service.ts 的 buildUsageTimeseries），
 *   所以 x 轴永远等距，不需要在这里猜缺口。
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  areaPath,
  clamp01,
  downsample,
  linePath,
  linearScale,
  niceScale,
  xTickIndices,
  type Series,
} from './series';
import { useElementWidth } from './useElementWidth';

export interface TimeSeriesChartProps {
  series: Series[];
  height?: number;
  /** y 轴标签格式（紧凑）。 */
  yFormat: (n: number) => string;
  /** tooltip 里的数值格式（精确）。 */
  valueFormat: (n: number) => string;
  /** tooltip 标题（通常是时间）。 */
  titleFormat: (ts: number) => string;
  /** x 轴标签。 */
  xFormat: (ts: number) => string;
  /** 单系列时是否填面积（多系列填面积会互相抬，禁止）。 */
  area?: boolean;
  /** 空数据时的占位文案（不传则渲染一个"暂无数据"的轻量占位）。 */
  emptyHint?: string;
  /** 无障碍名。 */
  ariaLabel?: string;
}

const M = { top: 10, right: 14, bottom: 24, left: 48 } as const;

export function TimeSeriesChart({
  series,
  height = 200,
  yFormat,
  valueFormat,
  titleFormat,
  xFormat,
  area = false,
  emptyHint,
  ariaLabel = '时间序列图',
}: TimeSeriesChartProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const [hover, setHover] = useState<number | null>(null);

  // 所有系列共享同一个 x 网格（后端保证等距桶）。
  const count = useMemo(() => {
    let n = 0;
    for (const s of series) n = Math.max(n, s.points.length);
    return n;
  }, [series]);

  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = Math.max(0, height - M.top - M.bottom);

  const domain = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const s of series) {
      for (const p of s.points) {
        if (p.y < lo) lo = p.y;
        if (p.y > hi) hi = p.y;
      }
    }
    return niceScale(lo, hi, 4);
  }, [series]);

  /** 把系列点映射到像素坐标（含抽样）。 */
  const laid = useMemo(() => {
    if (count < 2 || plotW <= 0) return [];
    const step = plotW / (count - 1);
    return series.map((s) => {
      const pts = downsample(s.points, 160);
      return {
        ...s,
        px: pts.map((p, i) => ({
          x: M.left + i * step,
          y: M.top + plotH - linearScale(p.y, domain, plotH),
          raw: p,
        })),
      };
    });
  }, [series, count, plotW, plotH, domain]);

  const step = count > 1 ? plotW / (count - 1) : 0;

  const onMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (count < 2 || step <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left - M.left;
      const idx = Math.round(clamp01(x / plotW) * (count - 1));
      setHover(idx);
    },
    [count, plotW, step],
  );

  const onKey = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (count < 2) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setHover((h) => {
          const base = h ?? 0;
          const next = e.key === 'ArrowLeft' ? base - 1 : base + 1;
          return Math.min(Math.max(next, 0), count - 1);
        });
      } else if (e.key === 'Escape') {
        setHover(null);
      }
    },
    [count],
  );

  if (width === 0) {
    return <div ref={wrapRef} className="ag-chart-frame" style={{ height }} />;
  }

  if (count < 2) {
    return (
      <div ref={wrapRef} className="ag-chart-frame" style={{ height }}>
        <div className="ag-empty" style={{ padding: '24px 12px' }}>
          <div className="ag-empty-title">数据点不足，画不出趋势</div>
          <div className="ag-empty-hint">
            {emptyHint ?? '趋势图至少需要两个时间桶。把时间范围放宽一点试试。'}
          </div>
        </div>
      </div>
    );
  }

  const hoverX = hover === null ? 0 : M.left + hover * step;
  const hoverTs = hover === null ? null : (series[0]?.points[hover]?.x ?? null);

  return (
    <div ref={wrapRef} className="ag-chart-frame" style={{ height }}>
      <svg
        className="ag-chart"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        {/* 横向网格 + y 轴标签。网格线压到最淡，数据线才是主角。 */}
        {domain.ticks.map((t) => {
          const y = M.top + plotH - linearScale(t, domain, plotH);
          return (
            <g key={`t${t}`}>
              <line
                x1={M.left}
                x2={M.left + plotW}
                y1={y}
                y2={y}
                stroke="var(--ag-chart-grid)"
                strokeWidth={1}
              />
              <text
                x={M.left - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize={11}
                fill="var(--ag-chart-axis)"
              >
                {yFormat(t)}
              </text>
            </g>
          );
        })}

        {/* x 轴标签：最多 6 个，避免互相重叠。 */}
        {xTickIndices(count).map((i) => {
          const p = series[0]?.points[i];
          if (p === undefined) return null;
          return (
            <text
              key={`x${i}`}
              x={M.left + i * step}
              y={height - 6}
              textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
              fontSize={11}
              fill="var(--ag-chart-axis)"
            >
              {xFormat(p.x)}
            </text>
          );
        })}

        {/* 面积（仅单系列） */}
        {area && laid.length === 1
          ? laid.map((s) => (
              <path
                key={`a${s.key}`}
                d={areaPath(s.px, M.top + plotH)}
                fill={s.color}
                fillOpacity={0.12}
                stroke="none"
              />
            ))
          : null}

        {/* 折线 */}
        {laid.map((s) => (
          <path
            key={`l${s.key}`}
            d={linePath(s.px)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* 十字准星：先画线，再画点，点才压得住线。 */}
        {hover !== null ? (
          <g>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={M.top}
              y2={M.top + plotH}
              stroke="var(--ag-chart-axis)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {laid.map((s) => {
              const p = s.px[hover];
              if (p === undefined) return null;
              return (
                <circle
                  key={`d${s.key}`}
                  cx={p.x}
                  cy={p.y}
                  r={3.5}
                  fill={s.color}
                  stroke="var(--ag-surface)"
                  strokeWidth={1.5}
                />
              );
            })}
          </g>
        ) : null}

        {/* 零基线：计数类指标的轴必须从 0 开始，且 0 线比网格线重。 */}
        <line
          x1={M.left}
          x2={M.left + plotW}
          y1={M.top + plotH}
          y2={M.top + plotH}
          stroke="var(--ag-chart-axis)"
          strokeWidth={1}
        />
      </svg>

      {hover !== null && hoverTs !== null ? (
        <ChartTooltip
          x={hoverX}
          y={M.top + 8}
          width={width}
          title={titleFormat(hoverTs)}
          rows={laid.map((s) => ({
            label: s.label,
            color: s.color,
            value: valueFormat(s.points[hover]?.y ?? 0),
          }))}
          total={laid.length > 1 ? valueFormat(laid.reduce((n, s) => n + (s.points[hover]?.y ?? 0), 0)) : undefined}
        />
      ) : null}
    </div>
  );
}

/** 图表 tooltip：fixed 定位，跟着准星走但不挡住它。 */
function ChartTooltip({
  x,
  y,
  width,
  title,
  rows,
  total,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  rows: Array<{ label: string; color: string; value: string }>;
  total?: string;
}): JSX.Element {
  const flip = x > width * 0.6;
  return (
    <div
      className="ag-tooltip"
      style={{
        left: x,
        top: y,
        transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, 0)`,
      }}
      role="status"
    >
      <div className="ag-tooltip-title">{title}</div>
      {rows.map((r) => (
        <div className="ag-tooltip-row" key={r.label}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <i className="ag-chart-legend-swatch" style={{ background: r.color }} />
            {r.label}
          </span>
          <b>{r.value}</b>
        </div>
      ))}
      {total !== undefined ? (
        <div className="ag-tooltip-row" style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--ag-border)' }}>
          <span style={{ color: 'var(--ag-text-2)' }}>合计</span>
          <b>{total}</b>
        </div>
      ) : null}
    </div>
  );
}
