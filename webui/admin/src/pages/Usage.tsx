import React, { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import type {
  BalanceProbeResponse,
  UsageDashboardResponse,
  UsageTimeseriesResponse,
} from '../api/types.js';
import { RankedBarChart, TimeSeriesChart } from '../components/charts.js';
import {
  ErrorBanner,
  PageHeader,
  SegmentedControl,
  StatusBadge,
} from '../components/ui.js';
import {
  formatCompactNumber,
  formatCurrencyAmount,
  formatDateTime,
  formatInt,
  formatPercent,
  formatUsd,
} from '../format.js';
import { updateQueryParams } from '../router.js';

export type UsageRangeKey = '1h' | '24h' | '7d' | '30d';

const USAGE_RANGES: Record<
  UsageRangeKey,
  { label: string; durationMs: number; bucketMs: number }
> = {
  '1h': { label: '近 1 小时', durationMs: 3600_000, bucketMs: 300_000 },
  '24h': { label: '近 24 小时', durationMs: 24 * 3600_000, bucketMs: 3600_000 },
  '7d': { label: '近 7 天', durationMs: 7 * 24 * 3600_000, bucketMs: 6 * 3600_000 },
  '30d': { label: '近 30 天', durationMs: 30 * 24 * 3600_000, bucketMs: 24 * 3600_000 },
};

export function UsagePage({
  query,
}: {
  query: URLSearchParams;
}): React.JSX.Element {
  const rawRange = query.get('range');
  const range: UsageRangeKey =
    rawRange === '1h' || rawRange === '24h' || rawRange === '7d' || rawRange === '30d'
      ? rawRange
      : '24h';

  const [usage, setUsage] = useState<UsageDashboardResponse | null>(null);
  const [timeseries, setTimeseries] = useState<UsageTimeseriesResponse | null>(null);
  const [probedBalance, setProbedBalance] = useState<BalanceProbeResponse | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [probingBalance, setProbingBalance] = useState<boolean>(false);
  const [error, setError] = useState<ActionableError | null>(null);

  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    const spec = USAGE_RANGES[range];
    const now = Date.now();
    const fromTs = now - spec.durationMs;

    try {
      const [uRes, tsRes] = await Promise.all([
        adminApi.getUsageDashboard(fromTs, now),
        adminApi.getUsageTimeseries(fromTs, now, spec.bucketMs),
      ]);
      setUsage(uRes);
      setTimeseries(tsRes);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  async function handleProbeBalance() {
    setProbingBalance(true);
    setError(null);
    try {
      const res = await adminApi.probeBalance();
      setProbedBalance(res);
      if (!res.ok) {
        setError({
          category: '余额查询未完成',
          message: res.error ?? '上游未返回余额数据',
        });
      }
      await loadUsage();
    } catch (err) {
      setError({
        category: '余额查询异常',
        message: err instanceof Error ? err.message : '请求失败',
      });
    } finally {
      setProbingBalance(false);
    }
  }

  const summary = usage?.summary;
  const buckets = timeseries?.buckets ?? [];
  const balances = probedBalance?.balances ?? usage?.balance ?? [];
  const recon = usage?.reconciliation;

  return (
    <div className="ag-page">
      <PageHeader
        title="用量看板"
        helpSection="usage"
        actions={
          <>
            <SegmentedControl
              value={range}
              options={[
                { value: '1h', label: '1 小时' },
                { value: '24h', label: '24 小时' },
                { value: '7d', label: '7 天' },
                { value: '30d', label: '30 天' },
              ]}
              onChange={(next) => updateQueryParams('usage', { range: next })}
            />
            <button
              type="button"
              className="ag-btn"
              onClick={() => void handleProbeBalance()}
              disabled={probingBalance}
            >
              {probingBalance ? '查询中…' : '查询上游余额'}
            </button>
            <button
              type="button"
              className="ag-btn"
              onClick={() => void loadUsage()}
              disabled={loading}
            >
              刷新
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* 对账偏差醒目告警横幅（97 §2.1 #3：偏差超过阈值要显眼，不要藏在表格里） */}
      {recon && recon.alert && (
        <div className="ag-alert" role="alert">
          <div className="ag-alert-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <StatusBadge tone="danger">对账偏差超阈值</StatusBadge>
              <strong className="ag-tabular">
                当前偏差 {formatPercent(recon.deviation_ratio)}（阈值{' '}
                {formatPercent(recon.alert_threshold)}）
              </strong>
            </div>
            <span className="ag-tabular">
              估算花费 {recon.currency} {recon.estimated_cash.toFixed(4)} · 实扣差额{' '}
              {(recon.actual_topped_up_delta + recon.actual_granted_delta).toFixed(4)}
            </span>
          </div>
        </div>
      )}

      {/* 1. 核心指标统计卡 */}
      <div className="ag-grid-4">
        <div className="ag-stat-card">
          <span className="ag-stat-label">区间现金费用</span>
          <div className="ag-stat-value">{formatUsd(summary?.cash_total)}</div>
          <span className="ag-secondary ag-tabular">
            等价 API 价值 {formatUsd(summary?.as_api_total)}
          </span>
          {summary?.by_currency && Object.keys(summary.by_currency).length > 0 && (
            <span className="ag-secondary ag-tabular" style={{ fontSize: 12 }}>
              {Object.entries(summary.by_currency)
                .map(([cur, v]) => `${cur} ${formatCurrencyAmount(v.cash_total, cur)}`)
                .join(' · ')}
            </span>
          )}
        </div>

        <div className="ag-stat-card">
          <span className="ag-stat-label">请求总数</span>
          <div className="ag-stat-value">{formatInt(summary?.request_count)}</div>
          <span className="ag-secondary">{USAGE_RANGES[range].label}</span>
        </div>

        <div className="ag-stat-card">
          <span className="ag-stat-label">输入 / 输出 Token</span>
          <div className="ag-stat-value">
            {formatCompactNumber(
              (summary?.input_tokens ?? 0) + (summary?.output_tokens ?? 0),
            )}
          </div>
          <span className="ag-secondary ag-tabular">
            输入 {formatInt(summary?.input_tokens)} · 输出 {formatInt(summary?.output_tokens)}
          </span>
        </div>

        <div className="ag-stat-card">
          <span className="ag-stat-label">未定价请求数</span>
          <div className="ag-stat-value">{formatInt(summary?.unpriced_count)}</div>
          <div>
            {(summary?.unpriced_count ?? 0) > 0 ? (
              <StatusBadge tone="warning">含缺失定价表记录</StatusBadge>
            ) : (
              <StatusBadge tone="success">全部已计价</StatusBadge>
            )}
          </div>
        </div>
      </div>

      {/* 2. 时序趋势图（费用 + Token） */}
      <div className="ag-grid-2">
        <TimeSeriesChart
          title="费用趋势"
          buckets={buckets}
          available={timeseries?.available ?? true}
          valueOf={(b) => b.cash_total}
          formatValue={(v) => formatUsd(v)}
          unitLabel="USD"
        />
        <TimeSeriesChart
          title="Token 消耗趋势"
          buckets={buckets}
          available={timeseries?.available ?? true}
          valueOf={(b) => b.input_tokens + b.output_tokens}
          formatValue={(v) => formatCompactNumber(v)}
          unitLabel="Token"
        />
      </div>

      {/* 3. 三维分布（按模型 / 按渠道 / 按上游凭据，97 §2.1 #2 & §2.3 #2） */}
      <div className="ag-grid-3">
        <RankedBarChart
          title="按模型花费与请求"
          items={(summary?.by_model ?? []).map((m) => ({
            key: m.model,
            label: m.model,
            value: m.cash_total,
            formattedValue: formatUsd(m.cash_total),
            subLabel: `${formatInt(m.request_count)} 次`,
            mono: true,
          }))}
        />

        <RankedBarChart
          title="按渠道花费与请求"
          items={(summary?.by_provider ?? []).map((p) => ({
            key: p.provider,
            label: p.provider,
            value: p.cash_total,
            formattedValue: formatUsd(p.cash_total),
            subLabel: `${formatInt(p.request_count)} 次`,
            mono: true,
          }))}
        />

        <RankedBarChart
          title="按凭据归因花费"
          items={(summary?.by_credential ?? []).map((c) => ({
            key: c.credential,
            label: c.credential,
            value: c.cash_total,
            formattedValue: formatUsd(c.cash_total),
            subLabel: `${formatInt(c.request_count)} 次`,
            mono: true,
          }))}
        />
      </div>

      {/* 4. 上游余额快照与对账卡 */}
      <div className="ag-grid-2">
        <div className="ag-card">
          <div className="ag-card-header">
            <h3 className="ag-card-title">上游余额快照</h3>
            {probedBalance?.checked_at && (
              <span className="ag-secondary ag-tabular">
                更新于 {formatDateTime(probedBalance.checked_at)}
              </span>
            )}
          </div>
          {balances.length === 0 ? (
            <div className="ag-secondary">暂无余额快照</div>
          ) : (
            <table className="ag-table">
              <thead>
                <tr>
                  <th>币种</th>
                  <th>总余额</th>
                  <th>充值余额</th>
                  <th>赠送余额</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={b.currency}>
                    <td className="ag-mono">{b.currency}</td>
                    <td className="ag-tabular" style={{ fontWeight: 600 }}>
                      {b.total_balance}
                    </td>
                    <td className="ag-tabular">{b.topped_up_balance}</td>
                    <td className="ag-tabular">{b.granted_balance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="ag-card">
          <div className="ag-card-header">
            <h3 className="ag-card-title">最近一次账单对账</h3>
            {recon && (
              <StatusBadge tone={recon.alert ? 'danger' : 'success'}>
                {recon.alert ? '偏差告警' : '对账正常'}
              </StatusBadge>
            )}
          </div>
          {!recon ? (
            <div className="ag-secondary">尚无对账快照记录。</div>
          ) : (
            <div className="ag-grid-2" style={{ gap: 12 }}>
              <div>
                <div className="ag-secondary">本地估算费用</div>
                <div className="ag-tabular" style={{ fontSize: 18, fontWeight: 600 }}>
                  {recon.currency} {recon.estimated_cash.toFixed(4)}
                </div>
              </div>
              <div>
                <div className="ag-secondary">上游扣减合计</div>
                <div className="ag-tabular" style={{ fontSize: 18, fontWeight: 600 }}>
                  {recon.currency}{' '}
                  {(recon.actual_topped_up_delta + recon.actual_granted_delta).toFixed(4)}
                </div>
              </div>
              <div>
                <div className="ag-secondary">偏差比例</div>
                <div className="ag-tabular" style={{ fontWeight: 600 }}>
                  {formatPercent(recon.deviation_ratio)}
                </div>
              </div>
              <div>
                <div className="ag-secondary">覆盖请求数</div>
                <div className="ag-tabular" style={{ fontWeight: 600 }}>
                  {formatInt(recon.request_count)} 次
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 5. 最近请求明细表（已脱敏，不含请求体与密钥） */}
      <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px 0' }}>
          <h3 className="ag-card-title">最近请求明细</h3>
        </div>
        <div className="ag-table-wrap">
          <table className="ag-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>请求标识</th>
                <th>渠道</th>
                <th>模型</th>
                <th>输入 / 输出 Token</th>
                <th>费用</th>
                <th>结束原因 / 状态</th>
              </tr>
            </thead>
            <tbody>
              {(usage?.recent ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center' }}>
                    <span className="ag-secondary">区间内暂无请求记录</span>
                  </td>
                </tr>
              ) : (
                (usage?.recent ?? []).map((r) => (
                  <tr key={r.request_id}>
                    <td className="ag-tabular ag-secondary">{formatDateTime(r.ts)}</td>
                    <td className="ag-mono">{r.request_id}</td>
                    <td className="ag-mono">{r.provider}</td>
                    <td className="ag-mono">
                      {r.model}
                      {r.model_alias && r.model_alias !== r.model && (
                        <span className="ag-secondary"> ({r.model_alias})</span>
                      )}
                    </td>
                    <td className="ag-tabular">
                      {formatInt(r.input_tokens)} / {formatInt(r.output_tokens)}
                    </td>
                    <td className="ag-tabular">{formatUsd(r.cash_total)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <StatusBadge tone={r.status === 'ok' ? 'success' : 'warning'}>
                          {r.status}
                        </StatusBadge>
                        {r.finish_reason && (
                          <span className="ag-mono ag-secondary">{r.finish_reason}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
