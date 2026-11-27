import React, { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { isProviderAutoDisabled } from '../api/model-availability.js';
import type {
  AliasRuleDto,
  BootstrapResponse,
  MaskedCredential,
  ProviderConfig,
  UsageDashboardResponse,
  UsageTimeseriesResponse,
  VirtualKeyDto,
} from '../api/types.js';
import { RankedBarChart, Sparkline, TimeSeriesChart } from '../components/charts.js';
import {
  DeltaBadge,
  ErrorBanner,
  PageHeader,
  SegmentedControl,
  StatusBadge,
} from '../components/ui.js';
import { formatCompactNumber, formatInt, formatUsd } from '../format.js';
import { helpHref, navigate, updateQueryParams } from '../router.js';

export type OverviewRangeKey = '24h' | '7d' | '30d';

const RANGE_SPECS: Record<
  OverviewRangeKey,
  { label: string; durationMs: number; bucketMs: number }
> = {
  '24h': { label: '近 24 小时', durationMs: 24 * 3600_000, bucketMs: 3600_000 },
  '7d': { label: '近 7 天', durationMs: 7 * 24 * 3600_000, bucketMs: 6 * 3600_000 },
  '30d': { label: '近 30 天', durationMs: 30 * 24 * 3600_000, bucketMs: 24 * 3600_000 },
};

function computeDelta(curr: number, prev: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return (curr - prev) / prev;
}

export function OverviewPage({
  query,
  bootstrap,
}: {
  query: URLSearchParams;
  bootstrap: BootstrapResponse | null;
}): React.JSX.Element {
  const rawRange = query.get('range');
  const range: OverviewRangeKey =
    rawRange === '7d' || rawRange === '30d' ? rawRange : '24h';

  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<ActionableError | null>(null);

  const [usage, setUsage] = useState<UsageDashboardResponse | null>(null);
  const [prevUsage, setPrevUsage] = useState<UsageDashboardResponse | null>(null);
  const [timeseries, setTimeseries] = useState<UsageTimeseriesResponse | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [aliases, setAliases] = useState<AliasRuleDto[]>([]);
  const [virtualKeys, setVirtualKeys] = useState<VirtualKeyDto[]>([]);

  const loadData = useCallback(
    async (isBackground = false) => {
      if (isBackground) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const spec = RANGE_SPECS[range];
      const now = Date.now();
      const fromTs = now - spec.durationMs;
      const prevFromTs = fromTs - spec.durationMs;

      try {
        const [u, pu, ts, provs, als, vks] = await Promise.all([
          adminApi.getUsageDashboard(fromTs, now),
          adminApi.getUsageDashboard(prevFromTs, fromTs),
          adminApi.getUsageTimeseries(fromTs, now, spec.bucketMs),
          adminApi.listProviders(),
          adminApi.listAliases(),
          adminApi.listVirtualKeys().catch(() => ({ items: [] as VirtualKeyDto[], total: 0, limit: 0, offset: 0 })),
        ]);

        setUsage(u);
        setPrevUsage(pu);
        setTimeseries(ts);
        setProviders(provs.items);
        setAliases(als.items);
        setVirtualKeys(vks.items);
      } catch (err) {
        setError(
          err instanceof ApiRequestError
            ? err.actionable
            : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [range],
  );

  useEffect(() => {
    void loadData(false);
  }, [loadData]);

  function handleRangeChange(next: OverviewRangeKey) {
    updateQueryParams('overview', { range: next });
  }

  const buckets = timeseries?.buckets ?? [];
  const costSpark = buckets.map((b) => Math.max(b.cash_total, b.as_api_total));
  const reqSpark = buckets.map((b) => b.request_count);
  const tokSpark = buckets.map((b) => b.input_tokens + b.output_tokens);
  const unpricedSpark = buckets.map((b) => b.unpriced_count);

  const currSummary = usage?.summary;
  const prevSummary = prevUsage?.summary;

  const totalTokens = (currSummary?.input_tokens ?? 0) + (currSummary?.output_tokens ?? 0);
  const prevTotalTokens = (prevSummary?.input_tokens ?? 0) + (prevSummary?.output_tokens ?? 0);

  const enabledChannels = providers.filter(
    (p) => p.enabled && !isProviderAutoDisabled(p.auto_disabled),
  ).length;
  const autoDisabledChannels = providers.filter((p) =>
    isProviderAutoDisabled(p.auto_disabled),
  ).length;
  const healthyCreds = providers.filter(
    (p) => p.has_key === true && p.credential_health !== 'error',
  ).length;
  const errorCreds = providers.filter((p) => p.credential_health === 'error').length;
  const activeVks = virtualKeys.filter((k) => k.status === 'active').length;

  return (
    <div className="ag-page">
      <PageHeader
        title="概览"
        helpSection="overview"
        actions={
          <>
            {refreshing && <StatusBadge tone="neutral">刷新中</StatusBadge>}
            <SegmentedControl
              value={range}
              options={[
                { value: '24h', label: '24 小时' },
                { value: '7d', label: '7 天' },
                { value: '30d', label: '30 天' },
              ]}
              onChange={handleRangeChange}
            />
            <button
              type="button"
              className="ag-btn"
              onClick={() => void loadData(true)}
              disabled={loading || refreshing}
            >
              刷新
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={() => void loadData(false)} />

      {/* 1. 四张 KPI 统计卡（区间费用 / 请求数 / Token / 未定价请求，97 §2.1 #1） */}
      {loading && !usage ? (
        <div className="ag-grid-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="ag-stat-card">
              <div className="ag-skeleton" style={{ width: '45%', height: 14 }} />
              <div className="ag-skeleton" style={{ width: '70%', height: 32 }} />
              <div className="ag-skeleton" style={{ width: '100%', height: 22 }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="ag-grid-4">
          <div className="ag-stat-card">
            <div className="ag-stat-top">
              <span className="ag-stat-label">区间费用</span>
              <DeltaBadge
                deltaRatio={computeDelta(
                  Math.max(currSummary?.cash_total ?? 0, currSummary?.as_api_total ?? 0),
                  Math.max(prevSummary?.cash_total ?? 0, prevSummary?.as_api_total ?? 0),
                )}
                metricKind="cost"
              />
            </div>
            <div className="ag-stat-value">
              {formatUsd(
                Math.max(currSummary?.cash_total ?? 0, currSummary?.as_api_total ?? 0),
              )}
            </div>
            <div className="ag-stat-bottom">
              <span className="ag-secondary ag-tabular">等价额度</span>
              <Sparkline values={costSpark} />
            </div>
          </div>

          <div className="ag-stat-card">
            <div className="ag-stat-top">
              <span className="ag-stat-label">请求总数</span>
              <DeltaBadge
                deltaRatio={computeDelta(
                  currSummary?.request_count ?? 0,
                  prevSummary?.request_count ?? 0,
                )}
                metricKind="activity"
              />
            </div>
            <div className="ag-stat-value">{formatInt(currSummary?.request_count)}</div>
            <div className="ag-stat-bottom">
              <span className="ag-secondary">{RANGE_SPECS[range].label}</span>
              <Sparkline values={reqSpark} />
            </div>
          </div>

          <div className="ag-stat-card">
            <div className="ag-stat-top">
              <span className="ag-stat-label">Token 总量</span>
              <DeltaBadge
                deltaRatio={computeDelta(totalTokens, prevTotalTokens)}
                metricKind="activity"
              />
            </div>
            <div className="ag-stat-value">{formatCompactNumber(totalTokens)}</div>
            <div className="ag-stat-bottom">
              <span className="ag-secondary ag-tabular">
                入 {formatCompactNumber(currSummary?.input_tokens)} · 出{' '}
                {formatCompactNumber(currSummary?.output_tokens)}
              </span>
              <Sparkline values={tokSpark} />
            </div>
          </div>

          <div className="ag-stat-card">
            <div className="ag-stat-top">
              <span className="ag-stat-label">未定价请求</span>
              {(currSummary?.unpriced_count ?? 0) > 0 ? (
                <StatusBadge tone="warning">待核对</StatusBadge>
              ) : (
                <StatusBadge tone="success">全量定价</StatusBadge>
              )}
            </div>
            <div className="ag-stat-value">{formatInt(currSummary?.unpriced_count)}</div>
            <div className="ag-stat-bottom">
              <a className="ag-help-link" href={helpHref('usage')}>
                计费口径 →
              </a>
              <Sparkline values={unpricedSpark} color="var(--ag-warning)" />
            </div>
          </div>
        </div>
      )}

      {/* 2. 成本与请求量两条时序趋势（点击下钻到带同一时间筛选的用量页，97 §3.3） */}
      <div className="ag-grid-2">
        <TimeSeriesChart
          title="费用趋势"
          buckets={buckets}
          available={timeseries?.available ?? true}
          valueOf={(b) => Math.max(b.cash_total, b.as_api_total)}
          formatValue={(v) => formatUsd(v)}
          unitLabel="USD"
          onDrillDown={() => navigate('usage', { range })}
        />
        <TimeSeriesChart
          title="请求量趋势"
          buckets={buckets}
          available={timeseries?.available ?? true}
          valueOf={(b) => b.request_count}
          formatValue={(v) => formatInt(v)}
          unitLabel="次"
          onDrillDown={() => navigate('usage', { range })}
        />
      </div>

      {/* 3. 按渠道与按模型的花费分布（水平条形图，不画饼环图，97 §2.1 #1 & §5 #14） */}
      <div className="ag-grid-2">
        <RankedBarChart
          title="按渠道花费"
          items={[...(currSummary?.by_provider ?? [])]
            .sort(
              (a, b) =>
                Math.max(b.cash_total, b.as_api_total ?? 0) -
                  Math.max(a.cash_total, a.as_api_total ?? 0) ||
                b.request_count - a.request_count,
            )
            .map((p) => {
              const val = Math.max(p.cash_total, p.as_api_total ?? 0);
              return {
                key: p.provider,
                label: p.provider,
                value: val,
                formattedValue: formatUsd(val),
                subLabel: `${formatInt(p.request_count)} 次`,
                mono: true,
              };
            })}
        />
        <RankedBarChart
          title="按模型花费"
          items={[...(currSummary?.by_model ?? [])]
            .sort(
              (a, b) =>
                Math.max(b.cash_total, b.as_api_total ?? 0) -
                  Math.max(a.cash_total, a.as_api_total ?? 0) ||
                b.request_count - a.request_count,
            )
            .map((m) => {
              const val = Math.max(m.cash_total, m.as_api_total ?? 0);
              return {
                key: m.model,
                label: m.model,
                value: val,
                formattedValue: formatUsd(val),
                subLabel: `${formatInt(m.request_count)} 次`,
                mono: true,
              };
            })}
        />
      </div>

      {/* 4. 系统状态与已知缺口说明卡（97 §2.1 #1 & §3.4） */}
      <div className="ag-grid-2">
        <div className="ag-card">
          <div className="ag-card-header">
            <h3 className="ag-card-title">系统运行状态</h3>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => navigate('channels')}
            >
              管理渠道 →
            </button>
          </div>
          <div className="ag-grid-2" style={{ gap: 12 }}>
            <div
              style={{
                padding: 14,
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-surface-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>启用渠道</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong className="ag-tabular">
                  {enabledChannels} / {providers.length}
                </strong>
                {autoDisabledChannels > 0 && (
                  <StatusBadge tone="danger">{autoDisabledChannels} 暂停</StatusBadge>
                )}
              </div>
            </div>

            <div
              style={{
                padding: 14,
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-surface-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>渠道密钥</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong className="ag-tabular">
                  {healthyCreds} / {providers.length}
                </strong>
                {errorCreds > 0 ? (
                  <StatusBadge tone="danger">{errorCreds} 异常</StatusBadge>
                ) : (
                  <StatusBadge tone="success">正常</StatusBadge>
                )}
              </div>
            </div>

            <div
              style={{
                padding: 14,
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-surface-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>路由与客户端密钥</span>
              <span className="ag-tabular">
                <strong>{aliases.length}</strong> 条别名 · <strong>{activeVks}</strong> 把密钥
              </span>
            </div>

            <div
              style={{
                padding: 14,
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-surface-raised)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>密钥存储</span>
              {bootstrap?.storage_unlocked !== false ? (
                <StatusBadge tone="success">已解锁</StatusBadge>
              ) : (
                <StatusBadge tone="warning">未解锁</StatusBadge>
              )}
            </div>
          </div>
        </div>

        {/* 97 §3.4：后端尚未记录的维度放说明卡，绝不造假 0% */}
        <div className="ag-card">
          <div className="ag-card-header">
            <h3 className="ag-card-title">观测维度说明</h3>
            <a className="ag-help-link" href={helpHref('limitations')}>
              完整缺口清单 →
            </a>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                borderRadius: 'var(--ag-radius-sm)',
                border: '1px solid var(--ag-border)',
              }}
            >
              <span>延迟分位与错误率时序</span>
              <StatusBadge tone="neutral">未采集单次耗时与状态码</StatusBadge>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 12px',
                borderRadius: 'var(--ag-radius-sm)',
                border: '1px solid var(--ag-border)',
              }}
            >
              <span>缓存命中率与分流轨迹</span>
              <StatusBadge tone="neutral">待计量层拆分缓存读写桶</StatusBadge>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
