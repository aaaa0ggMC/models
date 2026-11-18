/**
 * gateway-core/routing-telemetry.ts —— 路由遥测聚合中心（5小时滑窗 / 余额 / 积分 / 闲时状态）。
 *
 * 为路由图引擎提供**同步、零 IO 阻塞**的节点条件数据源：
 *   - 5小时滚动窗口统计：结合本地 live 记账与 `usageReader`（按 request_id 去重），
 *     加上 S5 捕获的上游限流响应头（`x-ratelimit-remaining-*` / `x-codex-*`）；
 *   - 余额 / 订阅积分：由后台或手动刷新写入内存快照；
 *   - 服务商注入条件：从 `ProviderProfile.routingNodeOptions()` 读取各厂商专属字段，
 *     与通用 5 小时窗口条件合并供前端与引擎共用。
 *
 * 严格遵守架构解耦约束：本文件不 import `providers/*`。
 */

import type { Clock } from '../ir/clock.js';
import type {
  ProviderExtensionPointSpec,
  ProviderProfileRegistry,
  ProviderRoutingOptionSpec,
} from '../di/ports.js';
import { toUsdAmount } from '../metering/pricing.js';

export const FIVE_HOURS_MS = 5 * 3600_000;
export const SEVEN_DAYS_MS = 7 * 24 * 3600_000;
export const THIRTY_DAYS_MS = 30 * 24 * 3600_000;

export interface SubscriptionWindowQuota {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
  used_usd?: number;
  limit_usd?: number;
  requests?: number;
  tokens?: number;
  cash_usd?: number;
}

export interface ProviderTelemetrySnapshot {
  provider: string;
  available: boolean;
  consecutive_failures: number;
  balance_supported?: boolean;
  quota_status?: 'ok' | 'unauthorized' | 'unsupported';
  quota_message?: string;
  plan_type?: string;
  period_start?: string;
  period_end?: string;
  balance?: number;
  granted_balance?: number;
  topped_up_balance?: number;
  currency?: string;
  remaining_credits?: number;
  used_credits?: number;
  total_credits?: number;
  credit_usage_pct?: number;
  is_off_peak?: boolean;
  window_5h: {
    requests: number;
    tokens: number;
    cash_usd: number;
    upstream_remaining_requests?: number;
    upstream_remaining_tokens?: number;
    updated_at?: number;
  };
  windows?: {
    h5?: SubscriptionWindowQuota;
    weekly?: SubscriptionWindowQuota;
    monthly?: SubscriptionWindowQuota;
  };
  fetched_at?: number;
}

export interface RoutingUsageSample {
  request_id?: string;
  ts: number;
  provider: string;
  usage: { units: { tokens?: { input_tokens?: number; output_tokens?: number } } };
  cost: { cash: { total: number }; currency?: string };
}

export interface RoutingTelemetryHubDeps {
  clock: Clock;
  providerProfiles?: ProviderProfileRegistry;
  usageReader?: {
    list(fromTs: number, toTs: number): ReadonlyArray<RoutingUsageSample>;
  };
  providerState?: {
    isUnavailable(provider: string): boolean;
    isConfigured?(provider: string): boolean;
    consecutiveFailures?(provider: string): number;
  };
}

export interface RoutingTelemetryHub {
  snapshotFor(
    provider: string,
    overrides?: Partial<ProviderTelemetrySnapshot>,
  ): ProviderTelemetrySnapshot;
  allSnapshots(
    providers: readonly string[],
    overrides?: Record<string, Partial<ProviderTelemetrySnapshot>>,
  ): Record<string, ProviderTelemetrySnapshot>;
  optionsForProvider(provider: string, accessPath?: string): ProviderRoutingOptionSpec[];
  extensionsForProvider?(provider: string, accessPath?: string): ProviderExtensionPointSpec[];
  knownProviders?(): string[];
  updateBalance(
    provider: string,
    data: {
      balance: number;
      granted_balance?: number;
      topped_up_balance?: number;
      currency?: string;
      available?: boolean;
      fetched_at?: number;
    },
  ): void;
  updateCredits(
    provider: string,
    data: {
      remaining_credits: number;
      used_credits: number;
      total_credits: number;
      fetched_at?: number;
    },
  ): void;
  updateSubscriptionQuota(
    provider: string,
    data: {
      balance_supported?: boolean;
      quota_status?: 'ok' | 'unauthorized' | 'unsupported';
      quota_message?: string;
      plan_type?: string;
      period_start?: string;
      period_end?: string;
      h5?: SubscriptionWindowQuota;
      weekly?: SubscriptionWindowQuota;
      monthly?: SubscriptionWindowQuota;
      fetched_at?: number;
    },
  ): void;
  recordUpstreamHeaders(provider: string, headers: Record<string, string>): void;
  recordUsageEvent(event: {
    request_id: string;
    ts: number;
    provider: string;
    tokens: number;
    cash_usd: number;
  }): void;
}

export const UNIVERSAL_ROUTING_OPTIONS: readonly ProviderRoutingOptionSpec[] = [
  {
    key: 'max_5h_requests',
    label: '5小时请求上限',
    unit: '次/5h',
    type: 'number',
    telemetry_field: 'window_5h_requests',
    operator: 'lte',
  },
  {
    key: 'max_5h_tokens',
    label: '5小时Token上限',
    unit: 'Tokens/5h',
    type: 'number',
    telemetry_field: 'window_5h_tokens',
    operator: 'lte',
  },
  {
    key: 'max_5h_cost_usd',
    label: '5小时费用上限',
    unit: 'USD/5h',
    type: 'number',
    telemetry_field: 'window_5h_cost_usd',
    operator: 'lte',
  },
];

export const UNIVERSAL_EXTENSION_POINTS: readonly ProviderExtensionPointSpec[] = [
  {
    port: 'quota_exceeded',
    label: '限额耗尽分流',
    kind: 'branch',
    telemetry_field: 'upstream_remaining_requests',
    operator: 'lte',
    default_threshold: 0,
    tone: 'amber',
  },
];

interface CachedBalance {
  balance: number;
  granted_balance?: number;
  topped_up_balance?: number;
  currency?: string;
  available?: boolean;
  fetched_at: number;
}

interface CachedCredits {
  remaining_credits: number;
  used_credits: number;
  total_credits: number;
  credit_usage_pct: number;
  fetched_at: number;
}

interface CachedRateHeaders {
  upstream_remaining_requests?: number;
  upstream_remaining_tokens?: number;
  updated_at: number;
}

interface CachedSubscriptionQuota {
  balance_supported?: boolean;
  quota_status?: 'ok' | 'unauthorized' | 'unsupported';
  quota_message?: string;
  plan_type?: string;
  period_start?: string;
  period_end?: string;
  h5?: SubscriptionWindowQuota;
  weekly?: SubscriptionWindowQuota;
  monthly?: SubscriptionWindowQuota;
  fetched_at: number;
}

interface LiveUsageEvent {
  request_id: string;
  ts: number;
  provider: string;
  tokens: number;
  cash_usd: number;
}

export class DefaultRoutingTelemetryHub implements RoutingTelemetryHub {
  private readonly balances = new Map<string, CachedBalance>();
  private readonly credits = new Map<string, CachedCredits>();
  private readonly rateHeaders = new Map<string, CachedRateHeaders>();
  private readonly quotas = new Map<string, CachedSubscriptionQuota>();
  private readonly liveEvents: LiveUsageEvent[] = [];

  constructor(private readonly deps: RoutingTelemetryHubDeps) {}

  updateBalance(
    provider: string,
    data: {
      balance: number;
      granted_balance?: number;
      topped_up_balance?: number;
      currency?: string;
      available?: boolean;
      fetched_at?: number;
    },
  ): void {
    this.balances.set(provider, {
      balance: data.balance,
      ...(data.granted_balance === undefined ? {} : { granted_balance: data.granted_balance }),
      ...(data.topped_up_balance === undefined
        ? {}
        : { topped_up_balance: data.topped_up_balance }),
      ...(data.currency === undefined ? {} : { currency: data.currency }),
      ...(data.available === undefined ? {} : { available: data.available }),
      fetched_at: data.fetched_at ?? this.deps.clock.now(),
    });
  }

  updateCredits(
    provider: string,
    data: {
      remaining_credits: number;
      used_credits: number;
      total_credits: number;
      fetched_at?: number;
    },
  ): void {
    const pct =
      data.total_credits > 0
        ? Math.min(100, Math.max(0, (data.used_credits / data.total_credits) * 100))
        : 0;
    this.credits.set(provider, {
      remaining_credits: data.remaining_credits,
      used_credits: data.used_credits,
      total_credits: data.total_credits,
      credit_usage_pct: Math.round(pct * 100) / 100,
      fetched_at: data.fetched_at ?? this.deps.clock.now(),
    });
  }

  updateSubscriptionQuota(
    provider: string,
    data: {
      balance_supported?: boolean;
      quota_status?: 'ok' | 'unauthorized' | 'unsupported';
      quota_message?: string;
      plan_type?: string;
      period_start?: string;
      period_end?: string;
      h5?: SubscriptionWindowQuota;
      weekly?: SubscriptionWindowQuota;
      monthly?: SubscriptionWindowQuota;
      fetched_at?: number;
    },
  ): void {
    const prev = this.quotas.get(provider);
    this.quotas.set(provider, {
      ...(data.balance_supported === undefined
        ? prev?.balance_supported !== undefined
          ? { balance_supported: prev.balance_supported }
          : {}
        : { balance_supported: data.balance_supported }),
      ...(data.quota_status === undefined
        ? prev?.quota_status !== undefined
          ? { quota_status: prev.quota_status }
          : {}
        : { quota_status: data.quota_status }),
      ...(data.quota_message === undefined
        ? prev?.quota_message !== undefined
          ? { quota_message: prev.quota_message }
          : {}
        : { quota_message: data.quota_message }),
      ...(data.plan_type === undefined
        ? prev?.plan_type !== undefined
          ? { plan_type: prev.plan_type }
          : {}
        : { plan_type: data.plan_type }),
      ...(data.period_start === undefined
        ? prev?.period_start !== undefined
          ? { period_start: prev.period_start }
          : {}
        : { period_start: data.period_start }),
      ...(data.period_end === undefined
        ? prev?.period_end !== undefined
          ? { period_end: prev.period_end }
          : {}
        : { period_end: data.period_end }),
      ...(data.h5 === undefined
        ? prev?.h5 !== undefined
          ? { h5: prev.h5 }
          : {}
        : { h5: data.h5 }),
      ...(data.weekly === undefined
        ? prev?.weekly !== undefined
          ? { weekly: prev.weekly }
          : {}
        : { weekly: data.weekly }),
      ...(data.monthly === undefined
        ? prev?.monthly !== undefined
          ? { monthly: prev.monthly }
          : {}
        : { monthly: data.monthly }),
      fetched_at: data.fetched_at ?? this.deps.clock.now(),
    });
  }

  recordUpstreamHeaders(provider: string, headers: Record<string, string>): void {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      lower[k.toLowerCase()] = v;
    }
    const remReq =
      parseHeaderNum(lower['x-codex-5h-remaining-requests']) ??
      parseHeaderNum(lower['x-ratelimit-remaining-requests']) ??
      parseHeaderNum(lower['anthropic-ratelimit-requests-remaining']);
    const remTok =
      parseHeaderNum(lower['x-codex-5h-remaining-tokens']) ??
      parseHeaderNum(lower['x-ratelimit-remaining-tokens']) ??
      parseHeaderNum(lower['anthropic-ratelimit-tokens-remaining']);
    if (remReq === undefined && remTok === undefined) return;
    const prev = this.rateHeaders.get(provider);
    this.rateHeaders.set(provider, {
      ...(remReq !== undefined
        ? { upstream_remaining_requests: remReq }
        : prev?.upstream_remaining_requests !== undefined
          ? { upstream_remaining_requests: prev.upstream_remaining_requests }
          : {}),
      ...(remTok !== undefined
        ? { upstream_remaining_tokens: remTok }
        : prev?.upstream_remaining_tokens !== undefined
          ? { upstream_remaining_tokens: prev.upstream_remaining_tokens }
          : {}),
      updated_at: this.deps.clock.now(),
    });
  }

  recordUsageEvent(event: LiveUsageEvent): void {
    const cutoff = this.deps.clock.now() - FIVE_HOURS_MS;
    while (this.liveEvents.length > 0 && this.liveEvents[0]!.ts < cutoff) {
      this.liveEvents.shift();
    }
    this.liveEvents.push(event);
    if (this.liveEvents.length > 10_000) {
      this.liveEvents.splice(0, this.liveEvents.length - 10_000);
    }
  }

  optionsForProvider(provider: string, accessPath?: string): ProviderRoutingOptionSpec[] {
    const profile =
      this.deps.providerProfiles?.forProvider?.(provider) ??
      (accessPath ? this.deps.providerProfiles?.forAccessPath(accessPath) : undefined) ??
      this.deps.providerProfiles?.forAccessPath(`${provider}.openai-chat`) ??
      this.deps.providerProfiles?.forAccessPath(`${provider}.openai-responses`);
    const providerSpecs = profile?.routingNodeOptions?.() ?? [];
    const seen = new Set<string>();
    const out: ProviderRoutingOptionSpec[] = [];
    for (const spec of providerSpecs) {
      if (seen.has(spec.key)) continue;
      seen.add(spec.key);
      out.push(spec);
    }
    for (const spec of UNIVERSAL_ROUTING_OPTIONS) {
      if (seen.has(spec.key)) continue;
      seen.add(spec.key);
      out.push(spec);
    }
    return out;
  }

  extensionsForProvider(provider: string, accessPath?: string): ProviderExtensionPointSpec[] {
    const profile =
      this.deps.providerProfiles?.forProvider?.(provider) ??
      (accessPath ? this.deps.providerProfiles?.forAccessPath(accessPath) : undefined) ??
      this.deps.providerProfiles?.forAccessPath(`${provider}.openai-chat`) ??
      this.deps.providerProfiles?.forAccessPath(`${provider}.openai-responses`);
    const providerExts = profile?.routingExtensionPoints?.() ?? [];
    const seen = new Set<string>();
    const out: ProviderExtensionPointSpec[] = [];
    for (const ext of providerExts) {
      if (seen.has(ext.port)) continue;
      seen.add(ext.port);
      out.push(ext);
    }
    for (const ext of UNIVERSAL_EXTENSION_POINTS) {
      if (seen.has(ext.port)) continue;
      seen.add(ext.port);
      out.push(ext);
    }
    return out;
  }

  knownProviders(): string[] {
    return Array.from(
      new Set([
        ...(this.deps.providerProfiles?.list() ?? []).map((p) => p.id),
        ...this.balances.keys(),
        ...this.credits.keys(),
        ...this.quotas.keys(),
      ]),
    );
  }

  snapshotFor(
    provider: string,
    overrides?: Partial<ProviderTelemetrySnapshot>,
  ): ProviderTelemetrySnapshot {
    const now = this.deps.clock.now();
    const windowAgg = this.computeWindow(provider, now, FIVE_HOURS_MS);
    const weeklyAgg = this.computeWindow(provider, now, SEVEN_DAYS_MS);
    const monthlyAgg = this.computeWindow(provider, now, THIRTY_DAYS_MS);
    const bal = this.balances.get(provider);
    const cred = this.credits.get(provider);
    const quota = this.quotas.get(provider);
    const headers = this.rateHeaders.get(provider);
    const profile =
      this.deps.providerProfiles?.forProvider?.(provider) ??
      this.deps.providerProfiles?.forAccessPath(`${provider}.openai-chat`) ??
      this.deps.providerProfiles?.forAccessPath(`${provider}.openai-responses`);
    const isOffPeak = profile?.isOffPeakNow?.(now);
    const unavailable = this.deps.providerState?.isUnavailable(provider) === true;
    const failures = this.deps.providerState?.consecutiveFailures?.(provider) ?? 0;

    const balanceSupported =
      quota?.balance_supported ??
      (bal !== undefined || cred !== undefined ? true : undefined);

    const h5Window: SubscriptionWindowQuota = {
      requests: windowAgg.requests,
      tokens: windowAgg.tokens,
      cash_usd: windowAgg.cash_usd,
      ...(quota?.h5 ?? {}),
    };
    const weeklyWindow: SubscriptionWindowQuota = {
      requests: weeklyAgg.requests,
      tokens: weeklyAgg.tokens,
      cash_usd: weeklyAgg.cash_usd,
      ...(quota?.weekly ?? {}),
    };
    const monthlyWindow: SubscriptionWindowQuota = {
      requests: monthlyAgg.requests,
      tokens: monthlyAgg.tokens,
      cash_usd: monthlyAgg.cash_usd,
      ...(quota?.monthly ?? {}),
    };

    const fetchedCandidates = [bal?.fetched_at, cred?.fetched_at, quota?.fetched_at].filter(
      (n): n is number => n !== undefined && n > 0,
    );

    const base: ProviderTelemetrySnapshot = {
      provider,
      available: !unavailable && bal?.available !== false,
      consecutive_failures: failures,
      ...(balanceSupported === undefined ? {} : { balance_supported: balanceSupported }),
      ...(quota?.quota_status === undefined ? {} : { quota_status: quota.quota_status }),
      ...(quota?.quota_message === undefined ? {} : { quota_message: quota.quota_message }),
      ...(quota?.plan_type === undefined ? {} : { plan_type: quota.plan_type }),
      ...(quota?.period_start === undefined ? {} : { period_start: quota.period_start }),
      ...(quota?.period_end === undefined ? {} : { period_end: quota.period_end }),
      ...(bal === undefined
        ? {}
        : {
            balance: bal.balance,
            ...(bal.granted_balance === undefined ? {} : { granted_balance: bal.granted_balance }),
            ...(bal.topped_up_balance === undefined
              ? {}
              : { topped_up_balance: bal.topped_up_balance }),
            ...(bal.currency === undefined ? {} : { currency: bal.currency }),
          }),
      ...(cred === undefined
        ? {}
        : {
            remaining_credits: cred.remaining_credits,
            used_credits: cred.used_credits,
            total_credits: cred.total_credits,
            credit_usage_pct: cred.credit_usage_pct,
          }),
      ...(isOffPeak === undefined ? {} : { is_off_peak: isOffPeak }),
      window_5h: {
        requests: windowAgg.requests,
        tokens: windowAgg.tokens,
        cash_usd: windowAgg.cash_usd,
        ...(headers?.upstream_remaining_requests === undefined
          ? {}
          : { upstream_remaining_requests: headers.upstream_remaining_requests }),
        ...(headers?.upstream_remaining_tokens === undefined
          ? {}
          : { upstream_remaining_tokens: headers.upstream_remaining_tokens }),
        ...(headers?.updated_at === undefined ? {} : { updated_at: headers.updated_at }),
      },
      windows: {
        h5: h5Window,
        weekly: weeklyWindow,
        monthly: monthlyWindow,
      },
      ...(fetchedCandidates.length > 0 ? { fetched_at: Math.max(...fetchedCandidates) } : {}),
    };

    if (!overrides) return base;
    return {
      ...base,
      ...overrides,
      provider,
      window_5h: {
        ...base.window_5h,
        ...(overrides.window_5h ?? {}),
      },
    };
  }

  allSnapshots(
    providers: readonly string[],
    overrides?: Record<string, Partial<ProviderTelemetrySnapshot>>,
  ): Record<string, ProviderTelemetrySnapshot> {
    const out: Record<string, ProviderTelemetrySnapshot> = {};
    for (const p of providers) {
      out[p] = this.snapshotFor(p, overrides?.[p]);
    }
    return out;
  }

  private computeWindow(
    provider: string,
    now: number,
    windowMs: number,
  ): { requests: number; tokens: number; cash_usd: number } {
    const from = now - windowMs;
    const seenIds = new Set<string>();
    let requests = 0;
    let tokens = 0;
    let cash_usd = 0;

    if (this.deps.usageReader !== undefined) {
      const records = this.deps.usageReader.list(from, now + 1);
      for (const r of records) {
        if (r.provider !== provider) continue;
        if (r.request_id) seenIds.add(r.request_id);
        requests += 1;
        tokens +=
          (r.usage.units.tokens?.input_tokens ?? 0) +
          (r.usage.units.tokens?.output_tokens ?? 0);
        cash_usd += toUsdAmount(r.cost.cash.total, r.cost.currency ?? 'USD');
      }
    }

    for (const ev of this.liveEvents) {
      if (ev.ts < from || ev.ts > now) continue;
      if (ev.provider !== provider) continue;
      if (seenIds.has(ev.request_id)) continue;
      seenIds.add(ev.request_id);
      requests += 1;
      tokens += ev.tokens;
      cash_usd += ev.cash_usd;
    }

    return {
      requests,
      tokens,
      cash_usd: Math.round(cash_usd * 1_000_000) / 1_000_000,
    };
  }
}

function parseHeaderNum(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
