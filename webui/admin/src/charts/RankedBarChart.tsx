/**
 * src/charts/RankedBarChart.tsx —— 排行条形图（按模型 / provider 的分布）。
 *
 * ## 为什么用 HTML+CSS 而不是 SVG
 *
 * 横向条形图的标签比条本身更难画：模型名动辄 30+ 字符
 * （`claude-sonnet-4-5-20250929`），SVG `<text>` 不会自动省略、也不会换行，
 * 超长就只能裁掉。用真实的 DOM 文本，`text-overflow: ellipsis` 与
 * `title=` 都是免费的，屏幕阅读器也能读到条目的名字与数值。
 *
 * ## 为什么不是环形图
 *
 * Datawrapper《What to consider when creating pie charts》：「circle sections
 * aren't exactly easy to compare… A 3% difference between two categories can be
 * easy to spot in a bar chart, but practically invisible in a pie or donut.」
 * 而且"模型占比"这种超过 5 项的分类，饼图本身就不可读。
 * 条形图的长度是**前注意属性**里能量化比较的那个（NN/g：length 与 2D position）。
 */

import type { Bucket } from './series';

export interface RankedBarChartProps {
  buckets: Bucket[];
  /** 数值格式（条右侧直接标数，读者不用去对轴）。 */
  valueFormat: (n: number) => string;
  /** 空数据占位。 */
  emptyHint?: string;
  /** 点击某一条（下钻）。 */
  onSelect?: (key: string) => void;
  /** 是否显示占比。 */
  showShare?: boolean;
}

const MAX_LABEL = 22;

export function RankedBarChart({
  buckets,
  valueFormat,
  emptyHint = '这个区间里没有任何记录。',
  onSelect,
  showShare = true,
}: RankedBarChartProps): JSX.Element {
  if (buckets.length === 0) {
    return (
      <div className="ag-empty" style={{ padding: '24px 12px' }}>
        <div className="ag-empty-title">暂无分布数据</div>
        <div className="ag-empty-hint">{emptyHint}</div>
      </div>
    );
  }

  const max = buckets.reduce((m, b) => Math.max(m, b.value), 0);

  return (
    <div className="ag-ranked" role="list">
      {buckets.map((b, i) => {
        const pct = max > 0 ? (b.value / max) * 100 : 0;
        const label = b.label.length > MAX_LABEL ? `${b.label.slice(0, MAX_LABEL)}…` : b.label;
        const color = `var(--ag-chart-${(i % 6) + 1})`;
        return (
          <div
            className="ag-ranked-row"
            key={b.key}
            role="listitem"
            onClick={onSelect === undefined ? undefined : () => onSelect(b.key)}
            style={{ cursor: onSelect === undefined ? 'default' : 'pointer' }}
            title={b.label}
          >
            <span className="ag-ranked-label" title={b.label}>
              {label}
            </span>
            <span className="ag-ranked-track">
              <span
                className="ag-ranked-fill"
                style={{ width: `${Math.max(pct, b.value > 0 ? 1.5 : 0)}%`, background: color }}
              />
            </span>
            <span className="ag-ranked-value">
              {valueFormat(b.value)}
              {showShare ? <em>{(b.share * 100).toFixed(1)}%</em> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
