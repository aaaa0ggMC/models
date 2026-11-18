import React, { useState } from 'react';
import type { UsageTimeseriesBucket } from '../api/types.js';
import { formatShortTime } from '../format.js';
import { StatusBadge } from './ui.js';

/**
 * KPI 卡片内的迷你趋势图（计数/金额轴从 0 起，97 §5 #14）。
 */
export function Sparkline({
  values,
  color = 'var(--ag-accent)',
}: {
  values: readonly number[];
  color?: string;
}): React.JSX.Element {
  const width = 96;
  const height = 28;
  if (values.length === 0) {
    return <div style={{ width, height }} />;
  }
  const max = Math.max(0, ...values);
  const pts = values.map((v, idx) => {
    const x = values.length === 1 ? width / 2 : (idx / (values.length - 1)) * (width - 4) + 2;
    const y = max <= 0 ? height - 3 : height - 3 - (Math.max(0, v) / max) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={pts.join(' ')}
      />
    </svg>
  );
}

/**
 * 单轴时序图（97 §5 #14 图表纪律）：
 * - 不用双轴、不用饼环图；
 * - 计数与费用类 y 轴严格从 0 开始；
 * - 空桶（request_count === 0）照样在等距 x 轴上画 0，绝不跳过；
 * - 缺少数据源（available === false）时展示说明卡，绝不造假数据；
 * - 峰值与合计同时显示在图头，保证关键数值不依赖鼠标悬停。
 */
export function TimeSeriesChart({
  title,
  buckets,
  available,
  valueOf,
  formatValue,
  unitLabel,
  onDrillDown,
}: {
  title: string;
  buckets: readonly UsageTimeseriesBucket[];
  available: boolean;
  valueOf: (b: UsageTimeseriesBucket) => number;
  formatValue: (v: number) => string;
  unitLabel?: string;
  onDrillDown?: () => void;
}): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!available) {
    return (
      <div className="ag-card">
        <div className="ag-card-header">
          <h3 className="ag-card-title">{title}</h3>
          <StatusBadge tone="neutral">无数据源</StatusBadge>
        </div>
        <div className="ag-empty">
          {/* ui-copy: allow 缺数据源说明（97 §3.4 & §5 #14 要求缺数据源放说明卡） */}
          <p className="ag-empty-text">当前未挂载计量记录源，暂不展示趋势曲线。</p>
        </div>
      </div>
    );
  }

  const values = buckets.map((b) => Math.max(0, valueOf(b)));
  const total = values.reduce((acc, v) => acc + v, 0);
  const peak = values.reduce((acc, v) => Math.max(acc, v), 0);
  const spanMs =
    buckets.length > 0
      ? buckets[buckets.length - 1]!.to_ts - buckets[0]!.from_ts
      : 86_400_000;

  const svgWidth = 600;
  const svgHeight = 180;
  const padLeft = 8;
  const padRight = 8;
  const padTop = 12;
  const padBottom = 26;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = svgHeight - padTop - padBottom;

  const barCount = Math.max(1, buckets.length);
  const slotW = plotW / barCount;
  const barW = Math.max(3, Math.min(22, slotW * 0.66));

  const activeIdx = hoverIdx !== null && hoverIdx < buckets.length ? hoverIdx : null;
  const activeBucket = activeIdx !== null ? buckets[activeIdx] : undefined;

  return (
    <div className="ag-card">
      <div className="ag-card-header">
        <div>
          <h3 className="ag-card-title">{title}</h3>
          <div className="ag-secondary ag-tabular" style={{ marginTop: 2 }}>
            合计 {formatValue(total)} · 峰值 {formatValue(peak)}
            {unitLabel ? ` (${unitLabel})` : ''}
          </div>
        </div>
        {onDrillDown && (
          <button type="button" className="ag-btn ag-btn-sm" onClick={onDrillDown}>
            用量明细 →
          </button>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          style={{ width: '100%', height: 180, display: 'block' }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* 0 基线与中位参考线 */}
          <line
            x1={padLeft}
            y1={padTop}
            x2={svgWidth - padRight}
            y2={padTop}
            stroke="var(--ag-border)"
            strokeDasharray="3 3"
          />
          <line
            x1={padLeft}
            y1={padTop + plotH / 2}
            x2={svgWidth - padRight}
            y2={padTop + plotH / 2}
            stroke="var(--ag-border)"
            strokeDasharray="3 3"
          />
          <line
            x1={padLeft}
            y1={padTop + plotH}
            x2={svgWidth - padRight}
            y2={padTop + plotH}
            stroke="var(--ag-border-strong)"
          />

          {buckets.map((b, i) => {
            const v = values[i] ?? 0;
            const h = peak <= 0 ? 0 : (v / peak) * plotH;
            const x = padLeft + i * slotW + (slotW - barW) / 2;
            const y = padTop + plotH - h;
            const isHover = activeIdx === i;
            return (
              <g key={b.from_ts} onMouseEnter={() => setHoverIdx(i)} style={{ cursor: 'pointer' }}>
                <rect
                  x={padLeft + i * slotW}
                  y={padTop}
                  width={slotW}
                  height={plotH}
                  fill="transparent"
                />
                {isHover && (
                  <line
                    x1={x + barW / 2}
                    y1={padTop}
                    x2={x + barW / 2}
                    y2={padTop + plotH}
                    stroke="var(--ag-accent-border)"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                )}
                <rect
                  className="ag-chart-bar"
                  x={x}
                  y={v > 0 ? Math.min(y, padTop + plotH - 2) : padTop + plotH - 1}
                  width={barW}
                  height={v > 0 ? Math.max(2, h) : 1}
                  rx="2"
                  fill={isHover ? 'var(--ag-accent-hover)' : 'var(--ag-accent)'}
                  opacity={v > 0 ? (isHover ? 1 : 0.82) : isHover ? 0.55 : 0.22}
                />
              </g>
            );
          })}

          {/* 首尾时间刻度 */}
          {buckets.length > 0 && (
            <>
              <text
                x={padLeft}
                y={svgHeight - 6}
                fill="var(--ag-text-muted)"
                fontSize="11"
                fontFamily="var(--ag-font-mono)"
              >
                {formatShortTime(buckets[0]!.from_ts, spanMs)}
              </text>
              <text
                x={svgWidth - padRight}
                y={svgHeight - 6}
                textAnchor="end"
                fill="var(--ag-text-muted)"
                fontSize="11"
                fontFamily="var(--ag-font-mono)"
              >
                {formatShortTime(buckets[buckets.length - 1]!.to_ts, spanMs)}
              </text>
            </>
          )}
        </svg>

        {/* 固定高度信息槽，避免悬停时卡片高度变化引起页面闪动 */}
        <div
          className="ag-secondary ag-tabular ag-chart-readout"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 28,
            paddingTop: 6,
            borderTop: '1px solid var(--ag-border)',
            opacity: activeBucket && activeIdx !== null ? 1 : 0.6,
          }}
        >
          {activeBucket && activeIdx !== null ? (
            <>
              <span className="ag-mono">
                {formatShortTime(activeBucket.from_ts, spanMs)} –{' '}
                {formatShortTime(activeBucket.to_ts, spanMs)}
              </span>
              <span style={{ fontWeight: 600, color: 'var(--ag-text)' }}>
                {formatValue(values[activeIdx] ?? 0)}（{activeBucket.request_count} 次请求）
              </span>
            </>
          ) : (
            <>
              <span className="ag-mono">
                {buckets.length > 0
                  ? `${formatShortTime(buckets[0]!.from_ts, spanMs)} – ${formatShortTime(buckets[buckets.length - 1]!.to_ts, spanMs)}`
                  : '—'}
              </span>
              <span>悬停查看分桶</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 水平排行条形图（替代饼图 / 环图，数值直接标在行尾，97 §5 #14）。
 */
export function RankedBarChart({
  title,
  items,
  emptyText = '暂无记录',
}: {
  title: string;
  items: ReadonlyArray<{
    key: string;
    label: string;
    value: number;
    formattedValue: string;
    subLabel?: string;
    mono?: boolean;
  }>;
  emptyText?: string;
}): React.JSX.Element {
  const max = Math.max(0, ...items.map((i) => i.value));

  return (
    <div className="ag-card">
      <div className="ag-card-header">
        <h3 className="ag-card-title">{title}</h3>
      </div>
      {items.length === 0 ? (
        <div className="ag-secondary" style={{ padding: '12px 0' }}>
          {emptyText}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((it) => {
            const pct = max <= 0 ? 0 : Math.min(100, Math.max(2, (it.value / max) * 100));
            return (
              <div key={it.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <span className={it.mono ? 'ag-mono' : undefined} style={{ fontWeight: 500 }}>
                    {it.label}
                  </span>
                  <span className="ag-tabular" style={{ fontSize: 13, fontWeight: 600 }}>
                    {it.formattedValue}
                    {it.subLabel && (
                      <span
                        className="ag-secondary"
                        style={{ fontWeight: 400, marginLeft: 6 }}
                      >
                        {it.subLabel}
                      </span>
                    )}
                  </span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: 'var(--ag-surface-raised)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    className="ag-rank-bar"
                    style={{
                      width: `${pct.toFixed(1)}%`,
                      height: '100%',
                      background: 'var(--ag-accent)',
                      borderRadius: 3,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
