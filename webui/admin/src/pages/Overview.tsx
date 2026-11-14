/**
 * src/pages/Overview.tsx —— 概览页（改版后的主场）。
 *
 * ## 回答什么问题
 *
 * NN/g 把 dashboard 分成 operational（"现在正常吗、花超了吗"，一屏看完、
 * 几乎不用交互）和 analytical（下钻、查因）。本页只做前者：管理员开门第一眼
 * 要能回答"网关跑着吗、钱在涨吗、有没有该看的异常"。查因在
 * `#/usage`、`#/channels`、`#/credentials`。
 *
 * ## 卡片清单与数据来源
 *
 * | 区块 | 指标 | 来源 API |
 * | --- | --- | --- |
 * | 统计卡 ×4 | 现金费用 / 请求数 / tokens / 未定价 | `/usage` + `/usage/timeseries`（sparkline） |
 * | 成本趋势 | 区间内每个桶的现金费用 | `/usage/timeseries` |
 * | 请求量趋势 | 区间内每个桶的请求数 | `/usage/timeseries` |
 * | 按 provider 花费 | 排行前 8 + 其他 | `/usage` 的 `summary.by_provider` |
 * | 按模型花费 | 排行前 8 + 其他 | `/usage` 的 `summary.by_model` |
 * | 余额与对账 | 余额快照 + 区间对账偏差 | `/usage` 的 `balance` / `reconciliation` |
 * | 系统状态 | 渠道启用数 / 凭据健康 / 密钥状态 / 规则数 | `/providers` `/credentials` `/keystore/status` `/aliases` `/virtual-keys` |
 *
 * ## 刻意**不做**的图
 *
 * 延迟分位（p50/p95/p99）与错误率时序：后端当前不记录每次请求的延迟与
 * 状态码聚合（`UsageRecord` 里没有 duration / http_status 字段，
 * `/usage` 也没有这类维度）。**不造假数据**——页面上放一张"需要请求日志"
 * 的说明卡，指明依赖（P0-4 请求日志），等后端有了再接。
 * 这也是本次调研里 NewAPI 的两个明确空档，接上就是差异化。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tag } from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useAuth, type AuthState } from '../auth';
import { errorText } from '../api/client';
import {
  fmtCompact,
  fmtInt,
  fmtTs,
  fmtUsd,
  fmtUsdCompact,
  fmtRatio,
} from '../format';
import { helpHref, useHashRoute } from '../router';
import type {
  MaskedCredential,
  ProviderConfig,
  UsageDashboardResponse,
  UsageTimeseriesResponse,
} from '../api/types';
import {
  RANGE_PRESETS,
  bucketAxisLabel,
  bucketTooltipTitle,
  bucketValues,
  deltaOf,
  presetByKey,
  rangeOf,
  rankedBuckets,
} from '../charts/usage';
import { TimeSeriesChart } from '../charts/TimeSeriesChart';
import { RankedBarChart } from '../charts/RankedBarChart';
import {
  CardSkeleton,
  ChartCard,
  EmptyState,
  PageHeader,
  RangeSwitch,
  StatCard,
  StatSkeleton,
  StatusTag,
} from '../components/ui';

interface SystemStatus {
  providers: ProviderConfig[];
  credentials: MaskedCredential[];
  aliasCount: number;
  vkCount: number;
  keystore: {
    unlocked: boolean;
    should_rotate_dek: boolean;
    argon2_rehash_recommended: boolean;
    mode: string;
  } | null;
}

const EMPTY_STATUS: SystemStatus = {
  providers: [],
  credentials: [],
  aliasCount: 0,
  vkCount: 0,
  keystore: null,
};

export function Overview(): JSX.Element {
  const { call } = useAuth();
  const [, navigate] = useHashRoute();

  const [rangeKey, setRangeKey] = useState<string>(() => readRangeKey());
  const [usage, setUsage] = useState<UsageDashboardResponse | null>(null);
  const [ts, setTs] = useState<UsageTimeseriesResponse | null>(null);
  const [prev, setPrev] = useState<UsageDashboardResponse | null>(null);
  const [status, setStatus] = useState<SystemStatus>(EMPTY_STATUS);
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

      // 分区独立失败：一块拉不到不该把整页刷白（partial failure 时渲染成功的部分）。
      const [usageRes, tsRes, prevRes, sysRes] = await Promise.allSettled([
        call<UsageDashboardResponse>(`/usage${qs}`),
        call<UsageTimeseriesResponse>(`/usage/timeseries${tsQs}`),
        call<UsageDashboardResponse>(
          `/usage?from_ts=${prevRange.from_ts}&to_ts=${prevRange.to_ts}`,
        ),
        loadSystemStatus(call),
      ]);

      if (usageRes.status === 'fulfilled') setUsage(usageRes.value);
      else setError(errorText(usageRes.reason));
      if (tsRes.status === 'fulfilled') setTs(tsRes.value);
      if (prevRes.status === 'fulfilled') setPrev(prevRes.value);
      if (sysRes.status === 'fulfilled') setStatus(sysRes.value);
      setLoading(false);
    },
    [call],
  );

  useEffect(() => {
    void load(rangeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRange = (key: string): void => {
    setRangeKey(key);
    navigate('/overview', { range: key });
    void load(key);
  };

  const s = usage?.summary;
  const buckets = ts?.buckets ?? [];

  const cards = useMemo(() => {
    if (s === undefined) return [];
    return [
      {
        label: '现金费用',
        value: fmtUsd(s.cash_total),
        spark: bucketValues(buckets, 'cash_total'),
        delta: deltaOf(s.cash_total, prev?.summary.cash_total ?? 0, `前 ${preset.label}`, false),
        tone: 'danger' as const,
        tip: '实际现金支出：订阅路径为 0（那笔钱是月费，不随单次请求发生）。',
      },
      {
        label: '请求数',
        value: fmtInt(s.request_count),
        spark: bucketValues(buckets, 'request_count'),
        delta: deltaOf(s.request_count, prev?.summary.request_count ?? 0, `前 ${preset.label}`, true),
        tone: 'accent' as const,
        tip: '区间内的请求总数（含失败与未定价的）。',
      },
      {
        label: 'Tokens',
        value: fmtCompact(s.input_tokens + s.output_tokens),
        unit: 'tok',
        spark: bucketValues(buckets, 'input_tokens').map((v, i) => v + (bucketValues(buckets, 'output_tokens')[i] ?? 0)),
        delta: deltaOf(
          s.input_tokens + s.output_tokens,
          (prev?.summary.input_tokens ?? 0) + (prev?.summary.output_tokens ?? 0),
          `前 ${preset.label}`,
          true,
        ),
        tone: 'success' as const,
        tip: '输入 + 输出 token 合计。成本的主要驱动项。',
      },
      {
        label: '未定价请求',
        value: fmtInt(s.unpriced_count),
        spark: bucketValues(buckets, 'unpriced_count'),
        delta: deltaOf(s.unpriced_count, prev?.summary.unpriced_count ?? 0, `前 ${preset.label}`, false),
        tone: 'warning' as const,
        tip: '拿不到价格的请求——只记 token，不扣也不拦额度。',
      },
    ];
  }, [s, buckets, prev, preset.label]);

  const byProvider = useMemo(
    () =>
      s === undefined
        ? []
        : rankedBuckets(s.by_provider, 'provider', 'cash_total', 8),
    [s],
  );
  const byModel = useMemo(
    () => (s === undefined ? [] : rankedBuckets(s.by_model, 'model', 'cash_total', 8)),
    [s],
  );

  return (
    <div className="ag-stack">
      <PageHeader
        title="概览"
        desc="网关此刻跑得怎么样、钱花在哪里。趋势图用等距时间桶；延迟与错误率要等请求日志（P0-4）落地后才能画，见页面底部说明。"
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

      {/* 统计卡：一行四张，各带 sparkline。 */}
      <div className="ag-grid">
        {loading && s === undefined
          ? [0, 1, 2, 3].map((i) => <StatSkeleton key={i} />)
          : cards.map((c) => (
              <StatCard
                key={c.label}
                label={c.label}
                value={c.value}
                unit={c.unit}
                spark={c.spark}
                delta={c.delta.text}
                deltaTone={c.delta.tone}
                tone={c.tone}
                tip={c.tip}
              />
            ))}
      </div>

      {/* 第二行：成本趋势（主图）+ 余额与对账。 */}
      <div className="ag-grid ag-grid-mixed">
        {loading && buckets.length === 0 ? (
          <CardSkeleton height={220} />
        ) : (
          <ChartCard
            title="成本趋势"
            sub={`每个桶的现金费用（USD）· ${preset.label}`}
            legend={
              <>
                <span className="ag-chart-legend-item">
                  <i className="ag-chart-legend-swatch" style={{ background: 'var(--ag-chart-1)' }} />
                  现金费用
                </span>
              </>
            }
            foot={
              <>
                合计 {fmtUsd(s?.cash_total)}。订阅路径这里会是 0——钱在月费里，
                请看「等价 API 价值」（<a href={`#${'/usage'}`}>用量看板</a>）。
              </>
            }
          >
            <TimeSeriesChart
              series={[
                {
                  key: 'cash',
                  label: '现金费用',
                  color: 'var(--ag-chart-1)',
                  points: buckets.map((b) => ({ x: b.from_ts, y: b.cash_total })),
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
          </ChartCard>
        )}

        <BalanceCard usage={usage} loading={loading} />
      </div>

      {/* 第三行：请求量趋势 + 按 provider 花费。 */}
      <div className="ag-grid ag-grid-mixed">
        {loading && buckets.length === 0 ? (
          <CardSkeleton height={220} />
        ) : (
          <ChartCard
            title="请求量趋势"
            sub={`每个桶的请求数 · ${preset.label}`}
            foot={
              ts?.available === false
                ? '后端没有注入用量记录源，趋势不可用。'
                : `合计 ${fmtInt(s?.request_count)} 次；空桶表示那段时间真的没有请求，不是缺数据。`
            }
          >
            <TimeSeriesChart
              series={[
                {
                  key: 'req',
                  label: '请求数',
                  color: 'var(--ag-chart-2)',
                  points: buckets.map((b) => ({ x: b.from_ts, y: b.request_count })),
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
          </ChartCard>
        )}

        <ChartCard
          title="按 provider 花费"
          sub="前 8 名，其余并入「其他」"
          foot={
            <>
              共 {s?.by_provider.length ?? 0} 个 provider 有记录。
              <a href={`#${'/usage'}`}> 看全部</a>
            </>
          }
        >
          {loading && byProvider.length === 0 ? (
            <CardSkeleton height={180} />
          ) : (
            <RankedBarChart
              buckets={byProvider}
              valueFormat={fmtUsdCompact}
              emptyHint="这个区间里没有任何 provider 的花费记录。"
              onSelect={() => navigate('/usage', { range: rangeKey })}
            />
          )}
        </ChartCard>
      </div>

      {/* 第四行：按模型花费 + 系统状态。 */}
      <div className="ag-grid ag-grid-2">
        <ChartCard
          title="按模型花费"
          sub="前 8 名，其余并入「其他」"
          foot="模型名按上游返回的原始 id，不带别名；带别名的写法是 `别名 → 原始 id`。"
        >
          {loading && byModel.length === 0 ? (
            <CardSkeleton height={180} />
          ) : (
            <RankedBarChart
              buckets={byModel}
              valueFormat={fmtUsdCompact}
              emptyHint="这个区间里没有任何模型的花费记录。"
            />
          )}
        </ChartCard>

        <ChartCard
          title="系统状态"
          sub="接入面与密钥的即时体检"
          foot={
            <>
              细节在 <a href={`#${'/channels'}`}>渠道</a>、
              <a href={`#${'/credentials'}`}>凭据</a>、
              <a href={`#${'/system'}`}>安全与密钥</a>。
            </>
          }
        >
          <SystemStatusPanel status={status} loading={loading} />
        </ChartCard>
      </div>

      {/* 明确留白：不造假数据。 */}
      <PendingChartsCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function BalanceCard({
  usage,
  loading,
}: {
  usage: UsageDashboardResponse | null;
  loading: boolean;
}): JSX.Element {
  const bal = usage?.balance ?? [];
  const rec = usage?.reconciliation;
  return (
    <ChartCard
      title="余额与对账"
      sub="探测后的余额快照 + 区间级对账"
      foot={
        rec === undefined
          ? '对账只在注入了对账源的部署里出现。'
          : '区间级对账，不做逐笔归因；偏差超阈值只告警，不改写历史。'
      }
    >
      {loading && usage === null ? (
        <CardSkeleton height={180} />
      ) : (
        <div className="ag-stack" style={{ gap: 14 }}>
          {bal.length === 0 ? (
            <EmptyState
              title="还没有余额快照"
              hint="去「用量看板」点一次「探测余额」，这里就会出现各币种的总额 / 赠送 / 充值。"
            />
          ) : (
            <div className="ag-grid ag-grid-3" style={{ gap: 10 }}>
              {bal.map((b) => (
                <div key={b.currency} className="ag-kv">
                  <span className="ag-kv-k">{b.currency}</span>
                  <span className="ag-kv-v">{b.total_balance}</span>
                  <span className="ag-kv-sub">
                    赠 {b.granted_balance} · 充 {b.topped_up_balance}
                  </span>
                </div>
              ))}
            </div>
          )}

          {rec === undefined ? null : (
            <div className="ag-stack" style={{ gap: 8 }}>
              <div className="ag-row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: 'var(--ag-text-2)' }}>估算现金</span>
                <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtUsd(rec.estimated_cash)}</b>
              </div>
              <div className="ag-row" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: 'var(--ag-text-2)' }}>偏差</span>
                <span className="ag-row" style={{ gap: 6 }}>
                  <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtRatio(rec.deviation_ratio)}</b>
                  <StatusTag tone={rec.alert ? 'danger' : 'success'}>
                    {rec.alert ? '超阈值' : '正常'}
                  </StatusTag>
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ag-text-3)' }}>
                阈值 {fmtRatio(rec.alert_threshold)} · 区间 {fmtTs(rec.from_ts)} → {fmtTs(rec.to_ts)}
              </div>
            </div>
          )}
        </div>
      )}
    </ChartCard>
  );
}

function SystemStatusPanel({
  status,
  loading,
}: {
  status: SystemStatus;
  loading: boolean;
}): JSX.Element {
  if (loading && status.providers.length === 0) return <CardSkeleton height={180} />;

  const enabled = status.providers.filter((p) => p.enabled).length;
  const okCreds = status.credentials.filter((c) => c.health === 'ok').length;
  const errCreds = status.credentials.filter((c) => c.health === 'error').length;
  const ks = status.keystore;

  return (
    <div className="ag-stack" style={{ gap: 10 }}>
      <div className="ag-row" style={{ justifyContent: 'space-between' }}>
        <span className="ag-kv-k">渠道</span>
        <span className="ag-row" style={{ gap: 6 }}>
          <b>{enabled}</b>
          <span style={{ fontSize: 12, color: 'var(--ag-text-3)' }}>
            启用 / 共 {status.providers.length}
          </span>
        </span>
      </div>
      <div className="ag-row" style={{ justifyContent: 'space-between' }}>
        <span className="ag-kv-k">凭据健康</span>
        <span className="ag-row" style={{ gap: 6 }}>
          <StatusTag tone={errCreds > 0 ? 'danger' : okCreds > 0 ? 'success' : 'neutral'}>
            {errCreds > 0 ? `${errCreds} 个异常` : okCreds > 0 ? `${okCreds} 个可用` : '未探测'}
          </StatusTag>
        </span>
      </div>
      <div className="ag-row" style={{ justifyContent: 'space-between' }}>
        <span className="ag-kv-k">别名规则 / 客户端密钥</span>
        <b>
          {status.aliasCount} / {status.vkCount}
        </b>
      </div>
      <div className="ag-row" style={{ justifyContent: 'space-between' }}>
        <span className="ag-kv-k">密钥存储</span>
        {ks === null ? (
          <span style={{ fontSize: 12, color: 'var(--ag-text-3)' }}>读不到</span>
        ) : (
          <span className="ag-row" style={{ gap: 6 }}>
            <StatusTag tone={ks.unlocked ? 'success' : 'danger'}>
              {ks.unlocked ? '已解锁' : '未解锁'}
            </StatusTag>
            {ks.should_rotate_dek ? <StatusTag tone="warning">建议轮换 DEK</StatusTag> : null}
            {ks.argon2_rehash_recommended ? (
              <StatusTag tone="warning">建议重算 Argon2</StatusTag>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 明确留白的卡片：**不造假数据**。
 *
 * 延迟分位与错误率是 LLM 网关最该有的两张图（本次调研里 NewAPI 也只有
 * 平均延迟、没有分位与错误率时序），但后端现在不记每次请求的延迟与
 * 状态码（`UsageRecord` 无 duration / http_status，`/usage` 也没有这类维度）。
 * 与其画一条平的零线骗人，不如把依赖写清楚。
 */
function PendingChartsCard(): JSX.Element {
  return (
    <section className="ag-card">
      <header className="ag-card-head">
        <div style={{ flex: 1 }}>
          <h2 className="ag-card-title">还差两张图（依赖：P0-4 请求日志）</h2>
          <p className="ag-card-sub">
            下面两项后端当前不提供数据，这里只说明缺什么，不放假数据。
          </p>
        </div>
        <Tag color="orange" size="small">
          待后端
        </Tag>
      </header>
      <div className="ag-card-body">
        <div className="ag-grid ag-grid-2" style={{ gap: 14 }}>
          <div>
            <div className="ag-pending-title">延迟分位（p50 / p95 / p99）</div>
            <p className="ag-pending-body">
              需要每次请求的 <code>duration_ms</code> 与{' '}
              <code>ttfb_ms</code>。平均值会掩盖长尾——"the mean's entire job is
              to average the tail away"，所以这张图必须成分位，不能退化成平均延迟。
            </p>
          </div>
          <div>
            <div className="ag-pending-title">错误率时序</div>
            <p className="ag-pending-body">
              需要每次请求的 <code>http_status</code> / <code>finish_reason</code> 聚合。
              错误率是 rate，空桶必须显示"无样本"而不是 0%——0% 的错误率会把一次
              故障藏起来。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async function loadSystemStatus(call: AuthState['call']): Promise<SystemStatus> {
  const [prov, cred, alias, vk, ks] = await Promise.allSettled([
    call<{ items: ProviderConfig[] }>('/providers'),
    call<{ items: MaskedCredential[] }>('/credentials'),
    call<{ items: unknown[] }>('/aliases'),
    call<{ items: unknown[] }>('/virtual-keys'),
    call<{
      unlocked: boolean;
      should_rotate_dek: boolean;
      argon2_rehash_recommended: boolean;
      mode: string;
    }>('/keystore/status'),
  ]);
  return {
    providers: prov.status === 'fulfilled' ? (prov.value.items ?? []) : [],
    credentials: cred.status === 'fulfilled' ? (cred.value.items ?? []) : [],
    aliasCount: alias.status === 'fulfilled' ? (alias.value.items ?? []).length : 0,
    vkCount: vk.status === 'fulfilled' ? (vk.value.items ?? []).length : 0,
    keystore:
      ks.status === 'fulfilled'
        ? {
            unlocked: ks.value.unlocked,
            should_rotate_dek: ks.value.should_rotate_dek,
            argon2_rehash_recommended: ks.value.argon2_rehash_recommended,
            mode: ks.value.mode,
          }
        : null,
  };
}

function readRangeKey(): string {
  const raw = new URLSearchParams(window.location.hash.replace(/^#/, '').split('?')[1] ?? '').get(
    'range',
  );
  return raw !== null && RANGE_PRESETS.some((p) => p.key === raw) ? raw : '24h';
}

