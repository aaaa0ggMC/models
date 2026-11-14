/**
 * src/components/ui.tsx —— 管理面自封装的**业务组件**（不自建组件库）。
 *
 * 边界：这里只有"把 Semi 的零件拼成我们这个产品的固定形状"的那几个
 * （PageHeader / StatCard / ChartCard / StatusTag / ProviderBadge / EmptyState /
 * Skeleton / RangeSwitch）。Semi 继续提供按钮、输入框、表格、弹窗、Toast
 * 这些通用件——`docs/design/90-admin-ui-redesign.md` §6 的组件清单与边界。
 *
 * 全部用 `--ag-*` 令牌上色，不读 Semi 的内部色板：将来换组件库时，
 * 这一文件连同 theme.css 可以整体搬走。
 */

import type { ReactNode } from 'react';
import { Skeleton as SemiSkeleton } from '@douyinfe/semi-ui';
import { Sparkline } from '../charts/Sparkline';

// ---------------------------------------------------------------------------
// 页面标题区
// ---------------------------------------------------------------------------

export interface PageHeaderProps {
  title: string;
  /** 一句话说明这个页是干什么的（解释性内容去帮助页，这里只留导航级的）。 */
  desc?: ReactNode;
  /** 右侧操作区（主按钮 / 搜索 / 时间范围切换）。 */
  actions?: ReactNode;
  /** 标题下方的辅助行（面包屑、状态摘要）。 */
  meta?: ReactNode;
}

export function PageHeader({ title, desc, actions, meta }: PageHeaderProps): JSX.Element {
  return (
    <div className="ag-page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="ag-page-title">{title}</h1>
        {desc === undefined ? null : <p className="ag-page-desc">{desc}</p>}
        {meta === undefined ? null : <div style={{ marginTop: 10 }}>{meta}</div>}
      </div>
      {actions === undefined ? null : <div className="ag-actions">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 统计卡
// ---------------------------------------------------------------------------

/** 环比的语义：同一个"涨"在不同指标上好坏不同，所以颜色按指标定。 */
export type DeltaTone = 'good' | 'bad' | 'flat';

export interface StatCardProps {
  label: string;
  /** 主数值（已格式化）。 */
  value: string;
  unit?: string;
  /** 迷你走势（Tufte sparkline：无轴无刻度，尺度由大字承担）。 */
  spark?: number[];
  /** 环比文案，例如 `▲ 12.4% vs 前 7 天`。 */
  delta?: string;
  deltaTone?: DeltaTone;
  /** 卡片底部补充行（口径说明 / 跳转链接）。 */
  foot?: ReactNode;
  /** 数字含义的 tooltip（口径不放版面，放悬浮与帮助页）。 */
  tip?: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'neutral' | 'info';
  onClick?: () => void;
}

const TONE_COLOR: Record<NonNullable<StatCardProps['tone']>, string> = {
  accent: 'var(--ag-accent)',
  success: 'var(--ag-success)',
  warning: 'var(--ag-warning)',
  danger: 'var(--ag-danger)',
  neutral: 'var(--ag-text-2)',
  info: 'var(--ag-info)',
};

export function StatCard({
  label,
  value,
  unit,
  spark,
  delta,
  deltaTone = 'flat',
  foot,
  tip,
  tone = 'accent',
  onClick,
}: StatCardProps): JSX.Element {
  const interactive = onClick !== undefined;
  return (
    <div
      className="ag-card ag-stat"
      style={interactive ? { cursor: 'pointer' } : undefined}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      <div className="ag-stat-label" title={tip}>
        <span>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div className="ag-stat-value">
          {value}
          {unit === undefined ? null : <span className="ag-stat-unit">{unit}</span>}
        </div>
        {spark !== undefined && spark.length > 1 ? (
          <span style={{ color: TONE_COLOR[tone] }}>
            <Sparkline values={spark} ariaLabel={`${label} 近期走势`} />
          </span>
        ) : null}
      </div>
      <div className="ag-stat-foot">
        {delta === undefined ? null : (
          <span className={`ag-delta ag-delta-${deltaTone}`}>{delta}</span>
        )}
        {foot === undefined ? null : <span>{foot}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 图表卡
// ---------------------------------------------------------------------------

export interface ChartCardProps {
  title: ReactNode;
  /** 标题旁边的小字（口径 / 数据来源）。 */
  sub?: ReactNode;
  /** 右上角操作（图例切换 / 下载 / 下钻入口）。 */
  extra?: ReactNode;
  /** 图例（自己渲染，颜色由调用方给）。 */
  legend?: ReactNode;
  children: ReactNode;
  /** 底部一行（口径说明 / "查看更多"）。 */
  foot?: ReactNode;
}

export function ChartCard({
  title,
  sub,
  extra,
  legend,
  children,
  foot,
}: ChartCardProps): JSX.Element {
  return (
    <section className="ag-card ag-chart-card">
      <header className="ag-card-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="ag-card-title">{title}</h2>
          {sub === undefined ? null : <p className="ag-card-sub">{sub}</p>}
        </div>
        {extra === undefined ? null : <div className="ag-actions">{extra}</div>}
      </header>
      {legend === undefined ? null : (
        <div style={{ padding: '10px var(--ag-pad-card) 0' }}>
          <div className="ag-chart-legend">{legend}</div>
        </div>
      )}
      <div className="ag-card-body">{children}</div>
      {foot === undefined ? null : <footer className="ag-card-foot">{foot}</footer>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 状态标签
// ---------------------------------------------------------------------------

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * 状态标签。**颜色 + 文字双编码**：除了色板还有一个圆点形状线索，
 * 不靠颜色单独承载信息（色盲用户约占男性 1/8，见 data.europa.eu 的
 * 无障碍色板指南；IBM Carbon 的要求是 colorblind safe palettes +
 * secondary cues such as bold-face, patterns, icons, and text descriptions）。
 */
export function StatusTag({
  tone,
  children,
  title,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
}): JSX.Element {
  return (
    <span className={`ag-tag ag-tag-${tone}`} title={title}>
      <i className="ag-tag-dot" aria-hidden />
      {children}
    </span>
  );
}

/**
 * Provider 徽标：两字母缩写 + 全名（title 悬浮）。
 *
 * 为什么不引图标库： provider 有几十家，图标要么引一整个 ~1MB 的包，
 * 要么自己切 20 个 SVG。两字母缩写在 dense 表格里辨识度足够，
 * 且天然支持任意新 provider（不必等图标更新）。
 */
export function ProviderBadge({ name }: { name: string }): JSX.Element {
  const short = providerAbbr(name);
  return (
    <span className="ag-tag ag-tag-neutral" title={name}>
      <b style={{ fontWeight: 700, letterSpacing: '0.02em' }}>{short}</b>
      <span style={{ fontWeight: 400 }}>{name}</span>
    </span>
  );
}

/** 取 provider 名的可读缩写（`deepseek-chat` → `DS`，`openai` → `OA`）。 */
export function providerAbbr(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (cleaned === '') return '··';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  const word = parts[0]!;
  return word.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// 空状态 / 加载态
// ---------------------------------------------------------------------------

/**
 * 空状态。NN/g《Designing Empty States in Complex Applications》的三条：
 * ① 不要真的空着——给系统状态说明；② 用它做学习线索；③ 给它一条
 * 直奔关键任务的路。以及最重要的一条警告：**请求还在飞的时候绝不显示
 * "没有数据"**（"Inaccurate system-status messages for empty states are
 * particularly harmful"）——所以加载态由 Skeleton 负责，两者不共用。
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="ag-empty">
      <div className="ag-empty-title">{title}</div>
      {hint === undefined ? null : <div className="ag-empty-hint">{hint}</div>}
      {action === undefined ? null : <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}

/** 骨架屏：整页加载用（NN/g：全屏加载用 skeleton，单卡刷新用 spinner）。 */
export function CardSkeleton({ height = 200 }: { height?: number }): JSX.Element {
  return (
    <div className="ag-card" style={{ padding: 'var(--ag-pad-card)' }}>
      <SemiSkeleton loading placeholder={<SkeletonBlock height={height} />} active>
        <div />
      </SemiSkeleton>
    </div>
  );
}

export function SkeletonBlock({
  height,
  width = '100%',
  radius = 6,
}: {
  height: number | string;
  width?: number | string;
  radius?: number;
}): JSX.Element {
  return <div className="ag-skeleton" style={{ height, width, borderRadius: radius }} />;
}

/** 统计卡骨架：与 StatCard 同高，避免加载完成时整页跳一下。 */
export function StatSkeleton(): JSX.Element {
  return (
    <div className="ag-card ag-stat" aria-hidden>
      <SkeletonBlock height={12} width="40%" />
      <SkeletonBlock height={26} width="65%" />
      <SkeletonBlock height={10} width="80%" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 时间范围切换
// ---------------------------------------------------------------------------

export interface RangeOption {
  key: string;
  label: string;
  /** 小时数；`custom` 由调用方自己处理。 */
  hours?: number;
}

/**
 * 时间范围切换（分段控件）。
 *
 * 位置固定在**页面右上角**而不是图表内部：Plausible / AgencyAnalytics 的
 * dashboard 文档都把主日期选择器放在 dashboard 右上角；放图表里会导致
 * 每张图各切各的、口径不一致。
 */
export function RangeSwitch({
  options,
  value,
  onChange,
}: {
  options: RangeOption[];
  value: string;
  onChange: (key: string) => void;
}): JSX.Element {
  return (
    <div className="ag-range" role="tablist" aria-label="时间范围">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={o.key === value}
          className={`ag-range-item${o.key === value ? ' is-active' : ''}`}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
