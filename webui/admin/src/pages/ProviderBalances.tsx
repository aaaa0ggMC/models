import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import type {
  ProviderConfig,
  ProviderTelemetrySnapshotDto,
  SubscriptionWindowQuotaDto,
} from '../api/types.js';
import { ProviderIcon } from '../components/ProviderIcon.js';
import {
  EmptyState,
  ErrorBanner,
  PageHeader,
  StatusBadge,
  useSimulatedProgress,
} from '../components/ui.js';
import { formatUsd } from '../format.js';

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatReset(win?: SubscriptionWindowQuotaDto): string {
  if (!win) return '';
  if (win.reset_after_seconds !== undefined && win.reset_after_seconds > 0) {
    const mins = Math.ceil(win.reset_after_seconds / 60);
    if (mins < 60) return `${mins}m后重置`;
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return remM > 0 ? `${hrs}h${remM}m后重置` : `${hrs}h后重置`;
  }
  if (win.reset_at !== undefined && win.reset_at > 0) {
    return new Date(win.reset_at * 1000).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return '';
}

function WindowRow({
  label,
  win,
}: {
  label: string;
  win?: SubscriptionWindowQuotaDto;
}): React.JSX.Element | null {
  if (!win) return null;
  const hasPct = win.used_percent !== undefined;
  const hasLocal = (win.requests ?? 0) > 0 || (win.tokens ?? 0) > 0 || (win.cash_usd ?? 0) > 0;
  if (!hasPct && !hasLocal) return null;

  const pct = hasPct ? Math.min(100, Math.max(0, Math.round((win.used_percent ?? 0) * 10) / 10)) : undefined;
  const remPct = pct !== undefined ? Math.max(0, Math.round((100 - pct) * 10) / 10) : undefined;
  const resetText = formatReset(win);
  const usdQuota =
    win.used_usd !== undefined && win.limit_usd !== undefined
      ? ` · ${formatUsd(win.used_usd)} / ${formatUsd(win.limit_usd)}`
      : '';

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 8 }}>
        <span className="ag-secondary">{label}</span>
        <span className="ag-mono ag-tabular" style={{ fontWeight: 500 }}>
          {pct !== undefined
            ? `已用 ${pct}% / 剩余 ${remPct}%${usdQuota}`
            : `${win.requests ?? 0} 次 · ${formatTokens(win.tokens ?? 0)}`}
          {resetText ? ` (${resetText})` : ''}
        </span>
      </div>
      {pct !== undefined && (
        <div
          style={{
            height: 8,
            borderRadius: 999,
            background: 'var(--ag-border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${pct}%`,
              borderRadius: 999,
              background:
                pct >= 90
                  ? 'var(--ag-danger)'
                  : pct >= 70
                    ? 'var(--ag-warning)'
                    : 'var(--ag-accent)',
            }}
          />
        </div>
      )}
      {pct !== undefined && hasLocal && (
        <div className="ag-secondary ag-mono ag-tabular" style={{ fontSize: 11 }}>
          网关统计：{win.requests ?? 0} 次 · {formatTokens(win.tokens ?? 0)}
          {(win.cash_usd ?? 0) > 0 ? ` · ${formatUsd(win.cash_usd ?? 0)}` : ''}
        </div>
      )}
    </div>
  );
}

export function ProviderBalancesPage(): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Record<string, ProviderTelemetrySnapshotDto>>({});
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const refreshProgress = useSimulatedProgress(refreshing);
  const [error, setError] = useState<ActionableError | null>(null);

  const loadData = useCallback(async (doRefresh = false) => {
    if (doRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const [telRes, pRes] = await Promise.all([
        doRefresh ? adminApi.refreshRoutingTelemetry() : adminApi.getRoutingTelemetry(),
        adminApi.listProviders().catch(() => ({ items: [] as ProviderConfig[] })),
      ]);
      setSnapshots(telRes.snapshots ?? {});
      setProviders(pRes.items);
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
  }, []);

  useEffect(() => {
    // 先立即展示本地缓存/统计卡片，再异步后台拉取最新上游余额，避免单个上游慢或出错阻塞整页
    let cancelled = false;
    void (async () => {
      await loadData(false);
      if (!cancelled) {
        await loadData(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadData]);

  const providerNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providers) map.set(p.id, p.label || p.id);
    return map;
  }, [providers]);

  // 忽略不支持余额/配额且没有任何实测用量的服务商或密钥
  const visibleCards = useMemo(() => {
    return Object.values(snapshots)
      .filter((s) => {
        if (s.quota_status === 'unauthorized') {
          return true;
        }
        if (s.balance_supported === false) {
          // 若明确不支持，仅在网关本地有 30 天用量记录时展示本地统计
          return (s.windows?.monthly?.requests ?? 0) > 0 || s.window_5h.requests > 0;
        }
        return (
          s.balance_supported === true ||
          s.balance !== undefined ||
          s.remaining_credits !== undefined ||
          s.windows?.h5?.used_percent !== undefined ||
          s.windows?.weekly?.used_percent !== undefined ||
          s.windows?.monthly?.used_percent !== undefined ||
          s.window_5h.upstream_remaining_requests !== undefined ||
          (s.windows?.monthly?.requests ?? 0) > 0 ||
          s.window_5h.requests > 0
        );
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [snapshots]);

  return (
    <div className="ag-page">
      <PageHeader
        title="余额与配额"
        helpSection="usage"
        actions={
          <button
            type="button"
            className="ag-btn ag-btn-primary ag-tabular"
            disabled={refreshing}
            onClick={() => void loadData(true)}
          >
            {refreshing ? `刷新中 ${refreshProgress}%` : '刷新余量'}
          </button>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {loading ? (
        <div className="ag-card ag-secondary">加载中…</div>
      ) : visibleCards.length === 0 ? (
        <EmptyState
          message="暂无可展示的余额数据"
          actionLabel="重新探测"
          onAction={() => void loadData(true)}
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
            gap: 14,
          }}
        >
          {visibleCards.map((s) => {
            const title = providerNameMap.get(s.provider) ?? s.provider;
            const hasCash = s.balance !== undefined;
            const hasCredits = s.remaining_credits !== undefined || s.total_credits !== undefined;
            return (
              <div key={s.provider} className="ag-card" style={{ display: 'grid', gap: 12 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ProviderIcon providerId={s.provider} size={20} />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
                      <div className="ag-secondary ag-mono" style={{ fontSize: 11 }}>
                        {s.provider}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {s.plan_type && <StatusBadge tone="info">{s.plan_type}</StatusBadge>}
                    {s.quota_status === 'unauthorized' && (
                      <StatusBadge tone="warning">无查询权限</StatusBadge>
                    )}
                    {s.is_off_peak !== undefined && (
                      <StatusBadge tone={s.is_off_peak ? 'success' : 'neutral'}>
                        {s.is_off_peak ? '闲时优惠' : '标准时段'}
                      </StatusBadge>
                    )}
                    <StatusBadge tone={s.available ? 'success' : 'danger'}>
                      {s.available ? '可用' : '不可用'}
                    </StatusBadge>
                  </div>
                </div>

                {s.quota_status === 'unauthorized' && (
                  <div
                    className="ag-secondary"
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'var(--ag-surface-raised)',
                      fontSize: 12,
                    }}
                  >
                    {s.quota_message ?? '凭据无权限'}
                  </div>
                )}

                {hasCash && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'var(--ag-surface-raised)',
                      display: 'grid',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span className="ag-secondary" style={{ fontSize: 12 }}>
                        账户余额
                      </span>
                      <span className="ag-mono ag-tabular" style={{ fontSize: 18, fontWeight: 700 }}>
                        {s.balance?.toFixed(2)} {s.currency ?? ''}
                      </span>
                    </div>
                    {(s.granted_balance !== undefined || s.topped_up_balance !== undefined) && (
                      <div
                        className="ag-secondary ag-mono ag-tabular"
                        style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}
                      >
                        <span>赠金 {s.granted_balance?.toFixed(2) ?? '-'}</span>
                        <span>充值 {s.topped_up_balance?.toFixed(2) ?? '-'}</span>
                      </div>
                    )}
                  </div>
                )}

                {hasCredits && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: 'var(--ag-surface-raised)',
                      display: 'grid',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <span className="ag-secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                        订阅积分
                      </span>
                      <span className="ag-mono ag-tabular" style={{ fontSize: 13, fontWeight: 600 }}>
                        {`剩 ${s.remaining_credits ?? '-'} / ${s.total_credits ?? '-'}`}
                        {s.credit_usage_pct !== undefined
                          ? ` (已用 ${Math.round(s.credit_usage_pct * 10) / 10}%)`
                          : ''}
                      </span>
                    </div>
                    {s.credit_usage_pct !== undefined && (
                      <div
                        style={{
                          height: 8,
                          borderRadius: 999,
                          background: 'var(--ag-border)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.min(100, Math.max(0, s.credit_usage_pct))}%`,
                            borderRadius: 999,
                            background:
                              s.credit_usage_pct >= 90
                                ? 'var(--ag-danger)'
                                : s.credit_usage_pct >= 70
                                  ? 'var(--ag-warning)'
                                  : 'var(--ag-accent)',
                          }}
                        />
                      </div>
                    )}
                    {(s.period_start || s.period_end) && (
                      <div className="ag-secondary ag-mono" style={{ fontSize: 11 }}>
                        周期：{s.period_start ?? '?'} ~ {s.period_end ?? '?'}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ display: 'grid', gap: 8 }}>
                  <WindowRow
                    label="5小时窗口"
                    win={
                      s.windows?.h5 ?? {
                        requests: s.window_5h.requests,
                        tokens: s.window_5h.tokens,
                        cash_usd: s.window_5h.cash_usd,
                      }
                    }
                  />
                  <WindowRow label="7天窗口" win={s.windows?.weekly} />
                  <WindowRow label="30天窗口" win={s.windows?.monthly} />
                  {s.window_5h.upstream_remaining_requests !== undefined && (
                    <div
                      className="ag-secondary ag-mono ag-tabular"
                      style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}
                    >
                      <span>上游剩余请求</span>
                      <span>{s.window_5h.upstream_remaining_requests}</span>
                    </div>
                  )}
                </div>

                {s.fetched_at !== undefined && (
                  <div className="ag-secondary ag-mono" style={{ fontSize: 11, textAlign: 'right' }}>
                    更新：{new Date(s.fetched_at).toLocaleTimeString('zh-CN')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
