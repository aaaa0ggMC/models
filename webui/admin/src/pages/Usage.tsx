/**
 * src/pages/Usage.tsx —— 用量 / 对账看板页（analytical，可下钻）。
 *
 * 与「概览」的分工：概览是 operational dashboard（一屏看完、几乎不交互），
 * 本页是 analytical report——同一批数据，但允许切更细的时间范围、看全部维度、
 * 逐条翻记录。NN/g 把这两类分得很开，混在一页里两边都用不好。
 *
 * 图表清单（数据全部来自 `/usage` 与 `/usage/timeseries`，**不造假**）：
 *   ① 成本趋势（面积图，单系列）
 *   ② 请求量趋势（面积图，单系列）
 *   ③ token 构成（堆叠柱：输入 / 输出）
 *   ④ 按模型花费（横向条形，前 8 + 其他）
 *   ⑤ 按 provider 花费（横向条形，前 8 + 其他）
 * 延迟分位与错误率**没有**数据源，页面上明确标注依赖（P0-4 请求日志）。
 *
 * 双口径（cash / as_api）与对账规则见「帮助 / 文档」的 usage 小节。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Table, Tag, Toast } from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtCompact, fmtInt, fmtRatio, fmtTs, fmtUsd, fmtUsdCompact } from '../format';
import { currentQuery, helpHref, useHashRoute } from '../router';
import type { UsageDashboardResponse, UsageTimeseriesResponse } from '../api/types';
import {
  RANGE_PRESETS,
  bucketAxisLabel,
  bucketPoints,
  bucketTooltipTitle,
  deltaOf,
  presetByKey,
  rangeOf,
  rankedBuckets,
} from '../charts/usage';
import { barPath, niceScale, linearScale } from '../charts/series';
import { TimeSeriesChart } from '../charts/TimeSeriesChart';
import { useElementWidth } from '../charts/useElementWidth';
import { RankedBarChart } from '../charts/RankedBarChart';
import {
  ChartCard,
  EmptyState,
  PageHeader,
  RangeSwitch,
  StatCard,
  StatusTag,
} from '../components/ui';

export function Usage(): JSX.Element {
  const { call } = useAuth();
  const [, navigate] = useHashRoute();

  const [rangeKey, setRangeKey] = useState<string>(() => readRangeKey());
  const [data, setData] = useState<UsageDashboardResponse | null>(null);
  const [ts, setTs] = useState<UsageTimeseriesResponse | null>(null);
  const [prev, setPrev] = useState<UsageDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const preset = presetByKey(rangeKey);

  const load = useCallback(
    async (key: string) => {
      const p = presetByKey(key);
      const now = Date.now();
      const cur = rangeOf(p, now);
      const prevRange = { from_ts: cur.from_ts - (cur.to_ts - cur.from_ts), to_ts: cur.from_ts };
      setLoading(true);
      setError(null);
      const qs = `?from_ts=${cur.from_ts}&to_ts=${cur.to_ts}`;
      const tsQs = `${qs}${p.bucketMs === undefined ? '' : `&bucket_ms=${p.bucketMs}`}`;
      try {
        const [res, series, pv] = await Promise.all([
          call<UsageDashboardResponse>(`/usage${qs}`),
          call<UsageTimeseriesResponse>(`/usage/timeseries${tsQs}`),
          call<UsageDashboardResponse>(`/usage?from_ts=${prevRange.from_ts}&to_ts=${prevRange.to_ts}`),
        ]);
        setData(res);
        setTs(series);
        setPrev(pv);
      } catch (e) {
        setError(errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [call],
  );

  useEffect(() => {
    void load(rangeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRange = (key: string): void => {
    setRangeKey(key);
    navigate('/usage', { range: key });
    void load(key);
  };

  const probeBalance = async (): Promise<void> => {
    const toastId = Toast.info('正在探测余额…');
    try {
      await call('/balance/probe', { method: 'POST', body: {} });
      Toast.close(toastId);
      Toast.success('余额已刷新');
      await load(rangeKey);
    } catch (e) {
      Toast.close(toastId);
      Toast.error(errorText(e));
    }
  };

  const s = data?.summary;
  const buckets = ts?.buckets ?? [];
  const periodLabel = `前 ${preset.label}`;

  const statCards = useMemo(() => {
    if (s === undefined) return [];
    return [
      {
        label: '请求数',
        value: fmtInt(s.request_count),
        delta: deltaOf(s.request_count, prev?.summary.request_count ?? 0, periodLabel, true),
        tone: 'accent' as const,
        tip: '区间内的请求总数（含失败与未定价的）。',
      },
      {
        label: '输入 tokens',
        value: fmtCompact(s.input_tokens),
        delta: deltaOf(s.input_tokens, prev?.summary.input_tokens ?? 0, periodLabel, true),
        tone: 'accent' as const,
        tip: '输入 token 合计（含 cache read 部分，口径以 provider 上报为准）。',
      },
      {
        label: '输出 tokens',
        value: fmtCompact(s.output_tokens),
        delta: deltaOf(s.output_tokens, prev?.summary.output_tokens ?? 0, periodLabel, true),
        tone: 'success' as const,
        tip: '输出 token 合计（部分 provider 把思考 token 计入这里）。',
      },
      {
        label: '现金费用',
        value: fmtUsd(s.cash_total),
        delta: deltaOf(s.cash_total, prev?.summary.cash_total ?? 0, periodLabel, false),
        tone: 'danger' as const,
        tip: '实际现金支出：订阅路径为 0（那笔钱是月费，不随单次请求发生）。',
      },
      {
        label: '等价 API 价值',
        value: fmtUsd(s.as_api_total),
        delta: deltaOf(s.as_api_total, prev?.summary.as_api_total ?? 0, periodLabel, true),
        tone: 'accent' as const,
        tip: '同样的 tokens 若走 API key 会花多少；订阅路径下它是唯一稳定的参考值。',
      },
      {
        label: '未定价请求',
        value: fmtInt(s.unpriced_count),
        delta: deltaOf(s.unpriced_count, prev?.summary.unpriced_count ?? 0, periodLabel, false),
        tone: 'warning' as const,
        tip: '拿不到价格的请求——只记 token，不扣也不拦额度。',
      },
    ];
  }, [s, prev, periodLabel]);

  const byModel = useMemo(
    () => (s === undefined ? [] : rankedBuckets(s.by_model, 'model', 'cash_total', 8)),
    [s],
  );
  const byProvider = useMemo(
    () => (s === undefined ? [] : rankedBuckets(s.by_provider, 'provider', 'cash_total', 8)),
    [s],
  );
  const byModelReq = useMemo(
    () => (s === undefined ? [] : rankedBuckets(s.by_model, 'model', 'request_count', 8)),
    [s],
  );

  const recentColumns = [
    {
      title: '时间',
      dataIndex: 'ts',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtTs(r.ts)}</span>
      ),
    },
    { title: 'provider', dataIndex: 'provider' },
    {
      title: 'model',
      dataIndex: 'model',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <span className="ag-mono" style={{ fontSize: 12 }}>
          {r.model_alias ? `${r.model_alias} → ${r.model}` : r.model}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <StatusTag tone={r.status === 'ok' || r.status === 'success' ? 'success' : 'warning'}>
          {r.status}
        </StatusTag>
      ),
    },
    {
      title: '输入',
      dataIndex: 'input_tokens',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) =>
        fmtInt(r.input_tokens),
    },
    {
      title: '输出',
      dataIndex: 'output_tokens',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) =>
        fmtInt(r.output_tokens),
    },
    {
      title: '费用',
      dataIndex: 'cash_total',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) =>
        fmtUsd(r.cash_total),
    },
    {
      title: 'finish',
      dataIndex: 'finish_reason',
      render: (_: unknown, r: NonNullable<UsageDashboardResponse['recent']>[number]) => (
        <span style={{ fontSize: 12 }}>{r.finish_reason}</span>
      ),
    },
  ];

  return (
    <div className="ag-stack">
      <PageHeader
        title="用量看板"
        desc="成本、请求量与 token 的时间序列与分布。现金与等价 API 是两个口径，分开存储、不相加；区间级对账不做逐笔归因。"
        actions={
          <>
            <RangeSwitch
              options={RANGE_PRESETS.map((p) => ({ key: p.key, label: p.label }))}
              value={rangeKey}
              onChange={changeRange}
            />
            <Button icon={<IconRefresh />} onClick={() => void load(rangeKey)} loading={loading}>
              刷新
            </Button>
            <Button theme="solid" type="primary" onClick={() => void probeBalance()}>
              探测余额
            </Button>
          </>
        }
        meta={
          <div className="ag-row" style={{ fontSize: 12, color: 'var(--ag-text-3)' }}>
            <span>
              区间 {fmtTs(s?.from_ts)} → {fmtTs(s?.to_ts)}
            </span>
            {ts !== null && ts.buckets.length > 0 ? <span>· {ts.buckets.length} 个等距桶</span> : null}
            <a href={helpHref('usage')}>口径说明</a>
          </div>
        }
      />

      {error !== null ? (
        <div className="ag-banner ag-banner-danger" role="alert">
          {error}
        </div>
      ) : null}

      {/* 统计卡：六张，两行三列。 */}
      <div className="ag-grid ag-grid-3">
        {statCards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={c.value}
            delta={c.delta.text}
            deltaTone={c.delta.tone}
            tone={c.tone}
            tip={c.tip}
          />
        ))}
      </div>

      {/* 趋势图：成本 + 请求量。 */}
      <div className="ag-grid ag-grid-2">
        <ChartCard
          title="成本趋势"
          sub={`每个桶的现金费用（USD）· ${preset.label}`}
          foot={`合计 ${fmtUsd(s?.cash_total)}；等价 API 价值合计 ${fmtUsd(s?.as_api_total)}。`}
        >
          {buckets.length === 0 ? (
            <EmptyState title="没有时间序列数据" hint={ts?.available === false ? '后端没有注入用量记录源。' : '换一个更宽的时间范围试试。'} />
          ) : (
            <TimeSeriesChart
              series={[
                {
                  key: 'cash',
                  label: '现金费用',
                  color: 'var(--ag-chart-1)',
                  points: bucketPoints(buckets, 'cash_total'),
                },
              ]}
              height={220}
              area
              yFormat={fmtUsdCompact}
              valueFormat={fmtUsd}
              titleFormat={bucketTooltipTitle}
              xFormat={(t) => bucketAxisLabel(t, ts?.bucket_ms ?? 0)}
              ariaLabel="现金费用随时间变化"
            />
          )}
        </ChartCard>

        <ChartCard
          title="请求量趋势"
          sub={`每个桶的请求数 · ${preset.label}`}
          foot="空桶表示那段时间真的没有请求，不是缺数据——后端等距返回空桶。"
        >
          {buckets.length === 0 ? (
            <EmptyState title="没有时间序列数据" hint={ts?.available === false ? '后端没有注入用量记录源。' : '换一个更宽的时间范围试试。'} />
          ) : (
            <TimeSeriesChart
              series={[
                {
                  key: 'req',
                  label: '请求数',
                  color: 'var(--ag-chart-2)',
                  points: bucketPoints(buckets, 'request_count'),
                },
              ]}
              height={220}
              area
              yFormat={fmtCompact}
              valueFormat={fmtInt}
              titleFormat={bucketTooltipTitle}
              xFormat={(t) => bucketAxisLabel(t, ts?.bucket_ms ?? 0)}
              ariaLabel="请求量随时间变化"
            />
          )}
        </ChartCard>
      </div>

      {/* token 构成：堆叠柱（输入 / 输出）。 */}
      <ChartCard
        title="token 构成"
        sub="每个桶的输入 / 输出 token（堆叠柱）"
        legend={
          <>
            <span className="ag-chart-legend-item">
              <i className="ag-chart-legend-swatch" style={{ background: 'var(--ag-chart-1)' }} />
              输入
            </span>
            <span className="ag-chart-legend-item">
              <i className="ag-chart-legend-swatch" style={{ background: 'var(--ag-chart-2)' }} />
              输出
            </span>
          </>
        }
        foot={`合计 输入 ${fmtCompact(s?.input_tokens)} / 输出 ${fmtCompact(s?.output_tokens)}。token 是成本的主要驱动项，所以单独看它的构成变化。`}
      >
        {buckets.length === 0 ? (
          <EmptyState title="没有时间序列数据" hint={ts?.available === false ? '后端没有注入用量记录源。' : '换一个更宽的时间范围试试。'} />
        ) : (
          <StackedTokenChart buckets={buckets} />
        )}
      </ChartCard>

      {/* 分布：按模型 / 按 provider。 */}
      <div className="ag-grid ag-grid-2">
        <ChartCard title="按模型花费" sub="前 8 名，其余并入「其他」" foot={`共 ${s?.by_model.length ?? 0} 个模型有记录。`}>
          <RankedBarChart buckets={byModel} valueFormat={fmtUsdCompact} emptyHint="这个区间里没有任何模型的花费记录。" />
        </ChartCard>
        <ChartCard title="按 provider 花费" sub="前 8 名，其余并入「其他」" foot={`共 ${s?.by_provider.length ?? 0} 个 provider 有记录。`}>
          <RankedBarChart buckets={byProvider} valueFormat={fmtUsdCompact} emptyHint="这个区间里没有任何 provider 的花费记录。" />
        </ChartCard>
      </div>

      <ChartCard
        title="按模型请求数"
        sub="前 8 名（按请求数而不是花费排——贵的模型不一定调得多）"
        foot="和「按模型花费」并排看：能看出是少量贵请求，还是大量便宜请求。"
      >
        <RankedBarChart buckets={byModelReq} valueFormat={fmtInt} emptyHint="这个区间里没有任何请求记录。" />
      </ChartCard>

      {/* 明细表 */}
      <ChartCard title="最近记录" sub={`最多 50 条（契约上限）· ${preset.label}`}>
        {loading && data === null ? (
          <EmptyState title="正在加载…" hint="首次加载要等网关返回用量聚合。" />
        ) : (
          <Table
            className="ag-table"
            columns={recentColumns}
            dataSource={data?.recent ?? []}
            rowKey="request_id"
            loading={loading}
            pagination={false}
            empty="区间内没有请求记录。"
          />
        )}
      </ChartCard>

      {/* 对账 + 余额 */}
      {data?.reconciliation !== undefined ? (
        <ChartCard
          title="区间对账"
          sub="把区间内余额差与区间内估算现金总和对比"
          legend={
            <StatusTag tone={data.reconciliation.alert ? 'danger' : 'success'}>
              {data.reconciliation.alert ? '偏差超阈值' : '偏差正常'}
            </StatusTag>
          }
          foot="偏差超阈值只告警，不改写历史；阈值由部署配置给出。"
        >
          <div className="ag-grid ag-grid-3">
            <div className="ag-kv">
              <span className="ag-kv-k">估算现金</span>
              <span className="ag-kv-v">{fmtUsd(data.reconciliation.estimated_cash)}</span>
            </div>
            <div className="ag-kv">
              <span className="ag-kv-k">实际充值增量</span>
              <span className="ag-kv-v">{fmtUsd(data.reconciliation.actual_topped_up_delta)}</span>
            </div>
            <div className="ag-kv">
              <span className="ag-kv-k">实际赠送增量</span>
              <span className="ag-kv-v">{fmtUsd(data.reconciliation.actual_granted_delta)}</span>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ag-text-2)' }}>
            偏差 <b>{fmtRatio(data.reconciliation.deviation_ratio)}</b>（阈值{' '}
            {fmtRatio(data.reconciliation.alert_threshold)}）· 区间 {fmtTs(data.reconciliation.from_ts)} →{' '}
            {fmtTs(data.reconciliation.to_ts)} · {data.reconciliation.currency}
          </div>
        </ChartCard>
      ) : null}

      {data?.balance !== undefined && data.balance.length > 0 ? (
        <ChartCard title="余额快照" sub="探测触发后刷新；没有探测过就是空的">
          <Table
            className="ag-table"
            columns={[
              { title: '币种', dataIndex: 'currency' },
              { title: '总额', dataIndex: 'total_balance' },
              { title: '赠送', dataIndex: 'granted_balance' },
              { title: '充值', dataIndex: 'topped_up_balance' },
            ]}
            dataSource={data.balance}
            rowKey="currency"
            pagination={false}
          />
        </ChartCard>
      ) : null}

      {/* 明确留白 */}
      <section className="ag-card">
        <header className="ag-card-head">
          <div style={{ flex: 1 }}>
            <h2 className="ag-card-title">延迟与错误率：缺数据源，先不做</h2>
            <p className="ag-card-sub">
              后端当前不记录每次请求的延迟与状态码，这里不画假曲线。
            </p>
          </div>
          <Tag color="orange" size="small">
            待 P0-4
          </Tag>
        </header>
        <div className="ag-card-body">
          <div className="ag-grid ag-grid-2" style={{ gap: 14 }}>
            <div>
              <div className="ag-pending-title">延迟分位（p50 / p95 / p99）</div>
              <p className="ag-pending-body">
                需要 <code>duration_ms</code> 与 <code>ttfb_ms</code>。流式请求的
                TTFT 与总时长必须分开记录，不能混成一个"平均延迟"。
              </p>
            </div>
            <div>
              <div className="ag-pending-title">错误率时序</div>
              <p className="ag-pending-body">
                需要 <code>http_status</code> / <code>finish_reason</code> 的按桶聚合。
                错误率是 rate：空桶要显示"无样本"，不能显示 0%。
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// token 堆叠柱（自绘 SVG）
// ---------------------------------------------------------------------------

/**
 * 堆叠柱状图：每桶两根（输入在下、输出在上）。
 *
 * 用柱子而不是折线：这里要同时看**构成**与**总量**，堆叠柱两样都能表达；
 * 而且只有两个系列，堆叠不会出现"下面那条被抬着走"的读数问题
 * （data.europa.eu 的 moving baseline problem，超过 3 条堆叠才明显）。
 */
function StackedTokenChart({
  buckets,
}: {
  buckets: UsageTimeseriesResponse['buckets'];
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const height = 200;
  const M = { top: 10, right: 14, bottom: 24, left: 48 };
  const plotW = Math.max(0, width - M.left - M.right);
  const plotH = Math.max(0, height - M.top - M.bottom);

  const totals = buckets.map((b) => b.input_tokens + b.output_tokens);
  const domain = niceScale(0, Math.max(0, ...totals), 4);
  const step = buckets.length > 1 ? plotW / buckets.length : 0;
  const barW = Math.max(2, Math.min(18, step * 0.62));

  if (width === 0) return <div className="ag-chart-frame" ref={wrapRef} style={{ height }} />;

  return (
    <div className="ag-chart-frame" ref={wrapRef} style={{ height }}>
      <svg className="ag-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="输入与输出 token 构成">
        {domain.ticks.map((t) => {
          const y = M.top + plotH - linearScale(t, domain, plotH);
          return (
            <g key={`t${t}`}>
              <line x1={M.left} x2={M.left + plotW} y1={y} y2={y} stroke="var(--ag-chart-grid)" />
              <text x={M.left - 8} y={y + 3.5} textAnchor="end" fontSize={11} fill="var(--ag-chart-axis)">
                {fmtCompact(t)}
              </text>
            </g>
          );
        })}
        {buckets.map((b, i) => {
          const x = M.left + i * step + (step - barW) / 2;
          const inH = (b.input_tokens / Math.max(1, domain.max)) * plotH;
          const outH = (b.output_tokens / Math.max(1, domain.max)) * plotH;
          const base = M.top + plotH;
          return (
            <g key={b.from_ts}>
              <path d={barPath(x, base - outH, barW, outH)} fill="var(--ag-chart-2)" />
              <path d={barPath(x, base - outH - inH, barW, inH)} fill="var(--ag-chart-1)" />
            </g>
          );
        })}
        <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} stroke="var(--ag-chart-axis)" />
        {buckets
          .filter((_, i) => i % Math.max(1, Math.ceil(buckets.length / 6)) === 0)
          .map((b, n) => {
            const i = n * Math.max(1, Math.ceil(buckets.length / 6));
            return (
              <text
                key={`x${b.from_ts}`}
                x={M.left + i * step + barW / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize={11}
                fill="var(--ag-chart-axis)"
              >
                {bucketAxisLabel(b.from_ts, 0)}
              </text>
            );
          })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------

function readRangeKey(): string {
  const raw = currentQuery().get('range');
  return raw !== null && RANGE_PRESETS.some((p) => p.key === raw) ? raw : '24h';
}
