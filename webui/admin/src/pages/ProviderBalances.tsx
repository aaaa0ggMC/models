import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Modal,
  PageHeader,
  StatusBadge,
  useSimulatedProgress,
} from '../components/ui.js';
import { formatUsd } from '../format.js';

const CNY_PER_USD = 7.2;

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatCompactCredits(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '-';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '<1m';
  const mins = Math.ceil(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM > 0 ? `${hrs}h${remM}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `${days}天${remH}h` : `${days}天`;
}

function formatReset(win?: SubscriptionWindowQuotaDto): string {
  if (!win) return '';
  if (win.reset_after_seconds !== undefined && win.reset_after_seconds > 0) {
    return `${formatDuration(win.reset_after_seconds)}后重置`;
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

function estimateWindowProjection(
  win: SubscriptionWindowQuotaDto,
  pct: number | undefined,
  defaultWindowSeconds: number,
  nowSec: number,
): { text: string; warn: boolean } | null {
  if (pct === undefined || pct <= 0 || pct >= 100) return null;
  const winSec = win.limit_window_seconds ?? defaultWindowSeconds;
  const remSec =
    win.reset_after_seconds !== undefined
      ? win.reset_after_seconds
      : win.reset_at !== undefined && win.reset_at > 0
        ? Math.max(0, win.reset_at - nowSec)
        : undefined;
  if (remSec === undefined || remSec <= 0 || remSec >= winSec) return null;
  const elapsedSec = winSec - remSec;
  if (elapsedSec < 60) return null;
  const ratePerSec = pct / elapsedSec;
  const projectedPct = Math.round(pct * (winSec / elapsedSec) * 10) / 10;
  if (projectedPct > 100) {
    const exhaustSec = (100 - pct) / ratePerSec;
    return { text: `预计 ${formatDuration(exhaustSec)}后耗尽`, warn: true };
  }
  if (win.used_usd !== undefined && win.limit_usd !== undefined && win.limit_usd > 0) {
    const projectedUsd = win.used_usd * (winSec / elapsedSec);
    return { text: `预计重置前 ${projectedPct}% (${formatUsd(projectedUsd)})`, warn: false };
  }
  return { text: `预计重置前 ${projectedPct}%`, warn: false };
}

function estimateCreditsProjection(
  s: ProviderTelemetrySnapshotDto,
  nowMs: number,
): { text: string; warn: boolean } | null {
  if (
    !s.period_start ||
    !s.period_end ||
    s.used_credits === undefined ||
    s.used_credits <= 0 ||
    s.total_credits === undefined ||
    s.total_credits <= 0
  ) {
    return null;
  }
  const startMs = Date.parse(s.period_start);
  const endMs = Date.parse(s.period_end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (nowMs <= startMs || nowMs >= endMs) return null;
  const elapsedMs = nowMs - startMs;
  if (elapsedMs < 60_000) return null;
  const totalMs = endMs - startMs;
  const projectedPct =
    Math.round(((s.used_credits * (totalMs / elapsedMs)) / s.total_credits) * 1000) / 10;
  if (s.remaining_credits !== undefined && s.remaining_credits > 0 && projectedPct > 100) {
    const exhaustSec = s.remaining_credits / (s.used_credits / elapsedMs) / 1000;
    return { text: `预计 ${formatDuration(exhaustSec)}后耗尽`, warn: true };
  }
  if (projectedPct <= 100) {
    return { text: `周期末预计 ${projectedPct}%`, warn: false };
  }
  return null;
}

function estimateCashProjection(
  s: ProviderTelemetrySnapshotDto,
): { daysText: string; dailyText: string; warn: boolean } | null {
  if (s.balance === undefined || s.balance <= 0) return null;
  let dailyUsd = 0;
  if ((s.windows?.weekly?.cash_usd ?? 0) > 0) {
    dailyUsd = (s.windows?.weekly?.cash_usd ?? 0) / 7;
  } else if ((s.windows?.monthly?.cash_usd ?? 0) > 0) {
    dailyUsd = (s.windows?.monthly?.cash_usd ?? 0) / 30;
  } else if (s.window_5h.cash_usd > 0) {
    dailyUsd = (s.window_5h.cash_usd / 5) * 24;
  }
  if (dailyUsd <= 0) return null;
  const cur = (s.currency ?? 'USD').toUpperCase();
  const balanceUsd = cur === 'CNY' ? s.balance / CNY_PER_USD : s.balance;
  const daysLeft = balanceUsd / dailyUsd;
  const daysText =
    daysLeft < 1
      ? `~${Math.max(1, Math.round(daysLeft * 24))}小时`
      : daysLeft < 365
        ? `~${Math.round(daysLeft)}天`
        : '>1年';
  const dailyInCur = cur === 'CNY' ? dailyUsd * CNY_PER_USD : dailyUsd;
  const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : `${cur} `;
  return {
    daysText,
    dailyText: `${sym}${dailyInCur.toFixed(2)}`,
    warn: daysLeft < 3,
  };
}

function hasUpstreamQuotaData(s: ProviderTelemetrySnapshotDto): boolean {
  return (
    s.quota_status === 'unauthorized' ||
    s.balance !== undefined ||
    s.remaining_credits !== undefined ||
    s.total_credits !== undefined ||
    s.windows?.h5?.used_percent !== undefined ||
    s.windows?.weekly?.used_percent !== undefined ||
    s.windows?.monthly?.used_percent !== undefined ||
    s.window_5h.upstream_remaining_requests !== undefined
  );
}

function ProgressBar({ pct }: { pct: number }): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div
      style={{
        height: 7,
        borderRadius: 999,
        background: 'var(--ag-border)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${clamped}%`,
          borderRadius: 999,
          background:
            clamped >= 90
              ? 'var(--ag-danger)'
              : clamped >= 70
                ? 'var(--ag-warning)'
                : 'var(--ag-accent)',
        }}
      />
    </div>
  );
}

function WindowRow({
  label,
  win,
  defaultWindowSeconds,
}: {
  label: string;
  win?: SubscriptionWindowQuotaDto;
  defaultWindowSeconds: number;
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
  const projection = estimateWindowProjection(
    win,
    pct,
    defaultWindowSeconds,
    Math.floor(Date.now() / 1000),
  );

  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: 12,
          gap: '2px 8px',
        }}
      >
        <span className="ag-secondary">{label}</span>
        <span className="ag-mono ag-tabular" style={{ fontWeight: 500 }}>
          {pct !== undefined
            ? `已用 ${pct}% / 剩余 ${remPct}%${usdQuota}`
            : `${win.requests ?? 0} 次 · ${formatTokens(win.tokens ?? 0)}`}
          {resetText ? ` (${resetText})` : ''}
        </span>
      </div>
      {pct !== undefined && <ProgressBar pct={pct} />}
      {projection && (
        <div
          className="ag-mono ag-tabular"
          style={{
            fontSize: 11,
            color: projection.warn ? 'var(--ag-warning)' : 'var(--ag-text-secondary)',
          }}
        >
          {projection.text}
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

/** 选出最值得在 Brief 卡片展示的主配额窗口（优先展示百分比最高的窗口）。 */
function pickPrimaryWindow(
  s: ProviderTelemetrySnapshotDto,
): { label: string; win: SubscriptionWindowQuotaDto; defaultSec: number } | null {
  const candidates: Array<{
    label: string;
    win: SubscriptionWindowQuotaDto | undefined;
    defaultSec: number;
  }> = [
    { label: '5小时', win: s.windows?.h5, defaultSec: 5 * 3600 },
    { label: '7天', win: s.windows?.weekly, defaultSec: 7 * 86400 },
    { label: '30天', win: s.windows?.monthly, defaultSec: 30 * 86400 },
  ];
  const withPct = candidates.filter((c): c is { label: string; win: SubscriptionWindowQuotaDto; defaultSec: number } =>
    c.win?.used_percent !== undefined,
  );
  if (withPct.length === 0) return null;
  withPct.sort((a, b) => (b.win.used_percent ?? 0) - (a.win.used_percent ?? 0));
  return withPct[0] ?? null;
}

function BalanceBriefCard({
  s,
  title,
  onSelect,
}: {
  s: ProviderTelemetrySnapshotDto;
  title: string;
  onSelect: () => void;
}): React.JSX.Element {
  const hasCash = s.balance !== undefined;
  const hasCredits = s.remaining_credits !== undefined || s.total_credits !== undefined;
  const primaryWin = pickPrimaryWindow(s);
  const cashProjection = estimateCashProjection(s);
  const creditsProjection = estimateCreditsProjection(s, Date.now());
  const nowSec = Math.floor(Date.now() / 1000);

  let briefBody: React.ReactNode = null;
  if (s.quota_status === 'unauthorized') {
    briefBody = (
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
    );
  } else if (hasCash) {
    briefBody = (
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--ag-surface-raised)',
          display: 'grid',
          gap: 4,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 8,
          }}
        >
          <span className="ag-secondary" style={{ fontSize: 12 }}>
            账户余额
          </span>
          <span className="ag-mono ag-tabular" style={{ fontSize: 18, fontWeight: 700 }}>
            {s.balance?.toFixed(2)} {s.currency ?? ''}
          </span>
        </div>
        {cashProjection ? (
          <div
            className="ag-mono ag-tabular"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: cashProjection.warn ? 'var(--ag-warning)' : 'var(--ag-text-secondary)',
            }}
          >
            <span>预计可用 {cashProjection.daysText}</span>
            <span>日均 {cashProjection.dailyText}</span>
          </div>
        ) : hasCredits && s.credit_usage_pct !== undefined ? (
          <div className="ag-secondary ag-mono ag-tabular" style={{ fontSize: 11 }}>
            已用 {Math.round(s.credit_usage_pct * 10) / 10}%
          </div>
        ) : null}
      </div>
    );
  } else if (hasCredits) {
    const pct =
      s.credit_usage_pct !== undefined
        ? Math.round(s.credit_usage_pct * 10) / 10
        : undefined;
    briefBody = (
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--ag-surface-raised)',
          display: 'grid',
          gap: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 8,
            fontSize: 12,
          }}
        >
          <span className="ag-secondary">订阅积分</span>
          <span className="ag-mono ag-tabular" style={{ fontWeight: 600 }}>
            {`剩 ${formatCompactCredits(s.remaining_credits)} / ${formatCompactCredits(s.total_credits)}`}
            {pct !== undefined ? ` (${pct}%)` : ''}
          </span>
        </div>
        {pct !== undefined && <ProgressBar pct={pct} />}
        {creditsProjection && (
          <div
            className="ag-mono ag-tabular"
            style={{
              fontSize: 11,
              color: creditsProjection.warn ? 'var(--ag-warning)' : 'var(--ag-text-secondary)',
            }}
          >
            {creditsProjection.text}
          </div>
        )}
      </div>
    );
  } else if (primaryWin) {
    const pct = Math.min(
      100,
      Math.max(0, Math.round((primaryWin.win.used_percent ?? 0) * 10) / 10),
    );
    const resetText = formatReset(primaryWin.win);
    const proj = estimateWindowProjection(
      primaryWin.win,
      pct,
      primaryWin.defaultSec,
      nowSec,
    );
    briefBody = (
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--ag-surface-raised)',
          display: 'grid',
          gap: 6,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: 8,
            fontSize: 12,
          }}
        >
          <span className="ag-secondary">{primaryWin.label}配额</span>
          <span className="ag-mono ag-tabular" style={{ fontWeight: 600 }}>
            已用 {pct}%{resetText ? ` (${resetText})` : ''}
          </span>
        </div>
        <ProgressBar pct={pct} />
        {proj && (
          <div
            className="ag-mono ag-tabular"
            style={{
              fontSize: 11,
              color: proj.warn ? 'var(--ag-warning)' : 'var(--ag-text-secondary)',
            }}
          >
            {proj.text}
          </div>
        )}
      </div>
    );
  } else {
    const monthly = s.windows?.monthly;
    const reqs = monthly?.requests ?? s.window_5h.requests;
    const toks = monthly?.tokens ?? s.window_5h.tokens;
    briefBody = (
      <div
        style={{
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--ag-surface-raised)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
        }}
      >
        <span className="ag-secondary">30天用量</span>
        <span className="ag-mono ag-tabular" style={{ fontWeight: 500 }}>
          {reqs} 次 · {formatTokens(toks)}
        </span>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="ag-card ag-card-float-in ag-balance-card"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10 }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <ProviderIcon providerId={s.provider} size={20} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontWeight: 600,
                fontSize: 14,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </div>
            <div
              className="ag-secondary ag-mono"
              style={{
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {s.provider}
            </div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            flexShrink: 0,
          }}
        >
          {s.plan_type && <StatusBadge tone="info">{s.plan_type}</StatusBadge>}
          {s.quota_status === 'unauthorized' && (
            <StatusBadge tone="warning">无权限</StatusBadge>
          )}
          {s.is_off_peak && <StatusBadge tone="success">闲时</StatusBadge>}
          <StatusBadge tone={s.available ? 'success' : 'danger'}>
            {s.available ? '可用' : '不可用'}
          </StatusBadge>
        </div>
      </div>

      {briefBody}

      <div
        className="ag-secondary ag-mono"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 11,
        }}
      >
        <span>
          {s.fetched_at !== undefined
            ? `更新 ${new Date(s.fetched_at).toLocaleTimeString('zh-CN')}`
            : ''}
        </span>
        <span style={{ color: 'var(--ag-accent)' }}>详情 ›</span>
      </div>
    </div>
  );
}

export function ProviderBalancesPage(): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<Record<string, ProviderTelemetrySnapshotDto>>({});
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [refreshingOne, setRefreshingOne] = useState<string | null>(null);
  const [probingIds, setProbingIds] = useState<Set<string>>(() => new Set());
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const simulatedProgress = useSimulatedProgress(refreshing && refreshProgress === null);
  const [error, setError] = useState<ActionableError | null>(null);
  const runIdRef = useRef<number>(0);

  const loadData = useCallback(async (doRefresh = false) => {
    const runId = ++runIdRef.current;
    if (doRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const [telRes, pRes] = await Promise.all([
        adminApi.getRoutingTelemetry(),
        adminApi.listProviders().catch(() => ({ items: [] as ProviderConfig[] })),
      ]);
      if (runIdRef.current !== runId) return;

      const baseSnapshots = telRes.snapshots ?? {};
      setSnapshots(baseSnapshots);
      setProviders(pRes.items);
      setLoading(false);

      if (!doRefresh) return;

      const targetIds = Array.from(
        new Set([
          ...pRes.items.filter((p) => p.enabled).map((p) => p.id),
          ...Object.keys(baseSnapshots),
        ]),
      );

      if (targetIds.length === 0) {
        const res = await adminApi.refreshRoutingTelemetry();
        if (runIdRef.current !== runId) return;
        setSnapshots(res.snapshots ?? {});
        return;
      }

      let done = 0;
      setProbingIds(new Set(targetIds));
      setRefreshProgress({ done: 0, total: targetIds.length });

      await Promise.allSettled(
        targetIds.map(async (pid) => {
          try {
            const res = await adminApi.refreshRoutingTelemetry(pid);
            if (runIdRef.current !== runId) return;
            if (res.snapshots) {
              setSnapshots((prev) => ({ ...prev, ...res.snapshots }));
            }
          } finally {
            if (runIdRef.current !== runId) return;
            done += 1;
            setProbingIds((prev) => {
              if (!prev.has(pid)) return prev;
              const next = new Set(prev);
              next.delete(pid);
              return next;
            });
            setRefreshProgress({ done, total: targetIds.length });
          }
        }),
      );
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      if (runIdRef.current === runId) {
        setLoading(false);
        setRefreshing(false);
        setProbingIds(new Set());
        setRefreshProgress(null);
      }
    }
  }, []);

  const refreshSingle = useCallback(async (pid: string) => {
    setRefreshingOne(pid);
    try {
      const res = await adminApi.refreshRoutingTelemetry(pid);
      if (res.snapshots) {
        setSnapshots((prev) => ({ ...prev, ...res.snapshots }));
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '刷新失败', message: err instanceof Error ? err.message : '刷新失败' },
      );
    } finally {
      setRefreshingOne((cur) => (cur === pid ? null : cur));
    }
  }, []);

  useEffect(() => {
    void loadData(true);
  }, [loadData]);

  const providerNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providers) map.set(p.id, p.label || p.id);
    return map;
  }, [providers]);

  // 忽略不支持余额/配额且没有任何实测用量的服务商或密钥；正在探测且暂无上游数据的渠道待就绪后再浮出
  const visibleCards = useMemo(() => {
    return Object.values(snapshots)
      .filter((s) => {
        if (probingIds.has(s.provider) && !hasUpstreamQuotaData(s)) {
          return false;
        }
        if (s.quota_status === 'unauthorized') {
          return true;
        }
        if (s.balance_supported === false) {
          // 若明确不支持，仅在网关本地有 30 天用量记录时展示本地统计
          return (s.windows?.monthly?.requests ?? 0) > 0 || s.window_5h.requests > 0;
        }
        return (
          hasUpstreamQuotaData(s) ||
          (s.windows?.monthly?.requests ?? 0) > 0 ||
          s.window_5h.requests > 0
        );
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }, [snapshots, probingIds]);

  const selectedSnapshot = selectedId ? snapshots[selectedId] : undefined;
  const selectedTitle = selectedSnapshot
    ? (providerNameMap.get(selectedSnapshot.provider) ?? selectedSnapshot.provider)
    : '';
  const selectedHasCash = selectedSnapshot?.balance !== undefined;
  const selectedHasCredits =
    selectedSnapshot !== undefined &&
    (selectedSnapshot.remaining_credits !== undefined ||
      selectedSnapshot.total_credits !== undefined);
  const selectedCashProj = selectedSnapshot ? estimateCashProjection(selectedSnapshot) : null;
  const selectedCreditsProj = selectedSnapshot
    ? estimateCreditsProjection(selectedSnapshot, Date.now())
    : null;

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
            {refreshing
              ? refreshProgress !== null && refreshProgress.total > 0
                ? `刷新中 ${refreshProgress.done}/${refreshProgress.total} (${Math.round((refreshProgress.done / refreshProgress.total) * 100)}%)`
                : `刷新中 ${simulatedProgress}%`
              : '刷新余量'}
          </button>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {loading || (refreshing && visibleCards.length === 0) ? (
        <div className="ag-card ag-secondary ag-tabular">
          {refreshProgress !== null && refreshProgress.total > 0
            ? `探测余量中 (${refreshProgress.done}/${refreshProgress.total})…`
            : '加载中…'}
        </div>
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
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
            gap: 12,
          }}
        >
          {visibleCards.map((s) => (
            <BalanceBriefCard
              key={s.provider}
              s={s}
              title={providerNameMap.get(s.provider) ?? s.provider}
              onSelect={() => setSelectedId(s.provider)}
            />
          ))}
        </div>
      )}

      <Modal
        open={selectedSnapshot !== undefined}
        title={selectedTitle || '配额详情'}
        onClose={() => setSelectedId(null)}
        footer={
          selectedSnapshot && (
            <>
              <span
                className="ag-secondary ag-mono"
                style={{ fontSize: 11, marginRight: 'auto' }}
              >
                {selectedSnapshot.fetched_at !== undefined
                  ? `更新：${new Date(selectedSnapshot.fetched_at).toLocaleTimeString('zh-CN')}`
                  : ''}
              </span>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                disabled={refreshingOne === selectedSnapshot.provider}
                onClick={() => void refreshSingle(selectedSnapshot.provider)}
              >
                {refreshingOne === selectedSnapshot.provider ? '刷新中…' : '刷新此渠道'}
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-primary ag-btn-sm"
                onClick={() => setSelectedId(null)}
              >
                关闭
              </button>
            </>
          )
        }
      >
        {selectedSnapshot && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <ProviderIcon providerId={selectedSnapshot.provider} size={22} />
                <span className="ag-secondary ag-mono" style={{ fontSize: 12 }}>
                  {selectedSnapshot.provider}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedSnapshot.plan_type && (
                  <StatusBadge tone="info">{selectedSnapshot.plan_type}</StatusBadge>
                )}
                {selectedSnapshot.quota_status === 'unauthorized' && (
                  <StatusBadge tone="warning">无查询权限</StatusBadge>
                )}
                {selectedSnapshot.is_off_peak !== undefined && (
                  <StatusBadge tone={selectedSnapshot.is_off_peak ? 'success' : 'neutral'}>
                    {selectedSnapshot.is_off_peak ? '闲时优惠' : '标准时段'}
                  </StatusBadge>
                )}
                <StatusBadge tone={selectedSnapshot.available ? 'success' : 'danger'}>
                  {selectedSnapshot.available ? '可用' : '不可用'}
                </StatusBadge>
              </div>
            </div>

            {selectedSnapshot.quota_status === 'unauthorized' && (
              <div
                className="ag-secondary"
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'var(--ag-surface-raised)',
                  fontSize: 12,
                }}
              >
                {selectedSnapshot.quota_message ?? '凭据无权限'}
              </div>
            )}

            {selectedHasCash && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'var(--ag-surface-raised)',
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 8,
                  }}
                >
                  <span className="ag-secondary" style={{ fontSize: 12 }}>
                    账户余额
                  </span>
                  <span className="ag-mono ag-tabular" style={{ fontSize: 20, fontWeight: 700 }}>
                    {selectedSnapshot.balance?.toFixed(2)} {selectedSnapshot.currency ?? ''}
                  </span>
                </div>
                {(selectedSnapshot.granted_balance !== undefined ||
                  selectedSnapshot.topped_up_balance !== undefined) && (
                  <div
                    className="ag-secondary ag-mono ag-tabular"
                    style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}
                  >
                    <span>赠金 {selectedSnapshot.granted_balance?.toFixed(2) ?? '-'}</span>
                    <span>充值 {selectedSnapshot.topped_up_balance?.toFixed(2) ?? '-'}</span>
                  </div>
                )}
                {selectedCashProj && (
                  <div
                    className="ag-mono ag-tabular"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 11,
                      color: selectedCashProj.warn
                        ? 'var(--ag-warning)'
                        : 'var(--ag-text-secondary)',
                    }}
                  >
                    <span>预计可用 {selectedCashProj.daysText}</span>
                    <span>日均 {selectedCashProj.dailyText}</span>
                  </div>
                )}
              </div>
            )}

            {selectedHasCredits && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: 'var(--ag-surface-raised)',
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: '2px 8px',
                  }}
                >
                  <span className="ag-secondary" style={{ fontSize: 12 }}>
                    订阅积分
                  </span>
                  <span
                    className="ag-mono ag-tabular"
                    style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all' }}
                  >
                    {`剩 ${selectedSnapshot.remaining_credits?.toLocaleString() ?? '-'} / ${selectedSnapshot.total_credits?.toLocaleString() ?? '-'}`}
                    {selectedSnapshot.credit_usage_pct !== undefined
                      ? ` (已用 ${Math.round(selectedSnapshot.credit_usage_pct * 10) / 10}%)`
                      : ''}
                  </span>
                </div>
                {selectedSnapshot.credit_usage_pct !== undefined && (
                  <ProgressBar pct={selectedSnapshot.credit_usage_pct} />
                )}
                {(selectedSnapshot.period_start || selectedSnapshot.period_end) && (
                  <div className="ag-secondary ag-mono" style={{ fontSize: 11 }}>
                    周期：{selectedSnapshot.period_start ?? '?'} ~ {selectedSnapshot.period_end ?? '?'}
                  </div>
                )}
                {selectedCreditsProj && (
                  <div
                    className="ag-mono ag-tabular"
                    style={{
                      fontSize: 11,
                      color: selectedCreditsProj.warn
                        ? 'var(--ag-warning)'
                        : 'var(--ag-text-secondary)',
                    }}
                  >
                    {selectedCreditsProj.text}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'grid', gap: 10 }}>
              <WindowRow
                label="5小时窗口"
                defaultWindowSeconds={5 * 3600}
                win={
                  selectedSnapshot.windows?.h5 ?? {
                    requests: selectedSnapshot.window_5h.requests,
                    tokens: selectedSnapshot.window_5h.tokens,
                    cash_usd: selectedSnapshot.window_5h.cash_usd,
                  }
                }
              />
              <WindowRow
                label="7天窗口"
                defaultWindowSeconds={7 * 86400}
                win={selectedSnapshot.windows?.weekly}
              />
              <WindowRow
                label="30天窗口"
                defaultWindowSeconds={30 * 86400}
                win={selectedSnapshot.windows?.monthly}
              />
              {selectedSnapshot.window_5h.upstream_remaining_requests !== undefined && (
                <div
                  className="ag-secondary ag-mono ag-tabular"
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}
                >
                  <span>上游剩余请求</span>
                  <span>{selectedSnapshot.window_5h.upstream_remaining_requests}</span>
                </div>
              )}
              {selectedSnapshot.window_5h.upstream_remaining_tokens !== undefined && (
                <div
                  className="ag-secondary ag-mono ag-tabular"
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}
                >
                  <span>上游剩余 Token</span>
                  <span>{formatTokens(selectedSnapshot.window_5h.upstream_remaining_tokens)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
