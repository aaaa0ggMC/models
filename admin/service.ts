/**
 * admin/service.ts —— 管理面业务逻辑（**不碰 HTTP**）。
 *
 * 分层理由：`admin/routes.ts` 只做「HTTP ↔ 对象」的翻译与鉴权，本文件做全部
 * 业务。这样：
 *   - 业务逻辑可以不起服务器直接单测（测试里不建 socket、不发请求）；
 *   - 换传输层（换 fastify / 换成 CLI）时业务一行不改；
 *   - 「哪些操作会写审计」在本文件里一眼看全，不会漏。
 *
 * 依赖全部经构造函数注入（仓库硬约束：禁止模块级单例、禁止隐式全局状态）。
 *
 * ## 审计
 *
 * 每个**写操作**都写一条审计日志。审计日志进加密存储的 `audit` kind，
 * **绝不含 secret / 完整 key / 口令**——只记「谁在什么时候对什么做了什么、
 * 结果如何」。`detail` 字段由各方法显式构造，禁止把请求体整体塞进去
 * （请求体里可能有 secret）。
 */

import type { EncryptedRecordStore, MaskedSecret } from '../storage/record-store.js';
import type { PricingService } from '../metering/pricing.js';
import { describeSecret } from '../storage/record-store.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { CapabilityEntry, CanonicalRequestEnvelope, ChatPayload } from '../ir/index.js';
import type { CredentialResolver, ResolvedHeaders } from '../credentials/resolver.js';
import type { UpstreamCredential } from '../ir/index.js';
import type { Clock } from '../ir/clock.js';
import {
  evaluateRouteGraph,
  validateRouteGraph,
  type RouteGraph,
  type RouteGraphRegistry,
} from '../gateway-core/routing-engine.js';
import type { RoutingTelemetryHub } from '../gateway-core/routing-telemetry.js';
import {
  enrichModelsWithCachedOrOfflineMetadata,
  syncModelsWithOnlineModelsDev,
} from './provider-models.js';
import {
  accessPathIdForDialect,
  isAccessPathSafeProviderId,
  providerFromAccessPath,
  validateAliasRule,
  validateAliasRuleSet,
  validateNamespace,
  type AliasResolver,
  type AliasRule,
  type NamespaceRule,
} from './aliases.js';
import type { ProviderRuntimeIndex } from './provider-runtime.js';
import { AUTO_DISABLE_COUNTING_REASON } from './provider-runtime.js';
import type {
  AliasRuleDto,
  AuditLogEntry,
  AuthModeResponse,
  MaskedCredential,
  MaskedProviderKey,
  PluginInfoDto,
  PluginsListResponse,
  PluginUpdateRequest,
  ProviderBuiltinToolDefaults,
  ProviderConfig,
  ProviderModelsFailure,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderPreset,
  ProviderRoutingOptionSpecDto,
  ProviderTelemetrySnapshotDto,
  RouteGraphDto,
  RouteGraphSimulateRequest,
  RouteGraphSimulateResponse,
  RouteGraphUpsertRequest,
  RouteGraphUpsertResponse,
  RoutingTelemetryResponse,
  SecretRefCreateRequest,
  SecretRefDto,
  SettingDto,
  SettingsListResponse,
  UpstreamModelDto,
  UsageDashboardResponse,
  UsageTimeseriesBucket,
  UsageTimeseriesResponse,
  VirtualKeyCreateRequest,
  VirtualKeyDto,
  VirtualKeyUpdateRequest,
  VirtualKeyUsage,
} from './api-types.js';
import type { PluginHost } from '../plugins/host.js';
import type { VirtualKeyStore } from '../storage/virtual-keys.js';
import { maskVirtualKey, type VirtualKeyRecord } from '../storage/virtual-keys.js';
import type { SettingsService } from '../config/settings.js';
import type { SettingDescription } from '../config/settings.js';
import type { ProviderAvailabilityResolver } from '../catalog/types.js';
import {
  capabilityEntryVisible,
  isConfiguredEntry,
  type CapabilityVisibilityDeps,
} from '../catalog/visibility.js';
import { toUsdAmount } from '../metering/pricing.js';

// ---------------------------------------------------------------------------
// 端口（全部注入）
// ---------------------------------------------------------------------------

/** 元数据同步端口（上游发现 / 离线目录刷新）。 */
export interface MetadataSyncPort {
  /** 拉一次上游模型清单并刷新能力矩阵。 */
  refresh(): Promise<{ discovered: string[]; updated: string[]; added: string[] }>;
}

/**
 * 管理面能力矩阵条目：矩阵条目**原样** + 全量模式下的未配置标注。
 *
 * `availability` 只在「显式要求看全量」时出现在未配置条目上（默认它们被过滤掉），
 * 取值与 `/v1/models` 记录的 `availability` 同一个词——两个端点说同一件事。
 * 不加 `configured: true`：已配置是常态，给每条都加一个是纯噪声。
 */
export type CapabilityMatrixItem = Omit<
  CapabilityEntry,
  'input_modalities' | 'output_modalities'
> & {
  input_modalities?: string[];
  output_modalities?: string[];
  reasoning?: boolean;
  availability?: 'unconfigured';
  exposed?: boolean;
  namespace?: string;
  namespaced_id?: string;
  pricing?: {
    currency: string;
    tier?: string;
    rates: Record<string, number>;
  };
};

/** 余额探测端口。 */
export interface BalanceProbePort {
  probe(): Promise<{
    balances: Array<{
      currency: string;
      total_balance: string;
      granted_balance: string;
      topped_up_balance: string;
    }>;
    is_available: boolean;
  }>;
}

/**
 * usage 单位的窄视图。
 *
 * 只要 token 两类：聚合看板与按 key 归因都只关心 input / output。写成窄形状
 * 而不是 `Record<string, number>` 是因为 `UsageUnits` 的真实形状是
 * `{ tokens?: TokenUsage }`（**嵌套**），用扁平 Record 会让
 * `units['input_tokens']` 恒为 undefined——那正是本文件早先的 bug
 * （看板的 token 列永远是 0）。
 */
export interface UsageUnitsView {
  tokens?: { input_tokens?: number; output_tokens?: number };
}

/** usage 记录源（metering 的内存 sink；只读）。 */
export interface UsageRecordSource {
  /**
   * 读一段区间内的记录。
   *
   * 结构上兼容 `metering/usage-record.ts` 的 `UsageRecord`（窄依赖：
   * 「记录里加字段」永远不影响这里）。`usage.units` 用 `UsageUnitsView`
   * 而不是 `UsageUnits`——后者是有名字段的接口，没有索引签名，宽类型在这里
   * 反而让注入方（MemoryUsageSink）塞不进来。
   *
   * `auth` 是**按 key 归因**的唯一入口（P0-1 的直接受益项）：它只带 `key_id`
   * 与归属 id，**绝不含明文 key**（metering 侧的同款保证见
   * usage-record.ts 的「绝不进入 UsageRecord 的字段」第 2 条）。
   *
   * `credential_id` 是**上游凭据**归因的入口（与 `auth.key_id` 的客户端 key 是两回事，
   * 66 §2.1）：同一渠道配了多把上游 key 时，"这笔用量烧在哪把 key 上"只有它答得上来。
   */
  list(
    fromTs: number,
    toTs: number,
  ): Array<{
    request_id: string;
    ts: number;
    provider: string;
    model: string;
    model_alias?: string;
    status: string;
    auth?: { key_id?: string; team_id?: string; user_id?: string };
    usage: { units: UsageUnitsView };
    cost: { cash: { total: number }; as_api: { total: number }; status: string; currency?: string };
    price_snapshot?: { currency?: string } | null;
    finish_reason: string;
    fast_path: boolean;
    credential_id?: string;
  }>;
}

/** 对账记录源。 */
export interface ReconciliationSource {
  latest():
    | {
        from_ts: number;
        to_ts: number;
        currency: string;
        estimated_cash: number;
        actual_topped_up_delta: number;
        actual_granted_delta: number;
        deviation_ratio: number | null;
        request_count: number;
        alert: boolean;
        alert_threshold: number;
      }
    | undefined;
}

/**
 * 上游模型清单拉取端口（`POST /admin/api/provider-models` 的实现）。
 *
 * 为什么是端口而不是 AdminService 自己发 HTTP：这个调用要 transport、要按 dialect
 * 推路径、要 DeepSeek 的 `/models` 解码器——全是 provider 专有知识，放在 admin/ 里
 * 会让控制面反向依赖 provider。端口化之后测试可以整体替换（mock 上游），生产装配在
 * composition-root 里接 DeepSeek 实现。
 */
export interface ProviderModelsPort {
  fetch(input: ProviderModelsRequest): Promise<ProviderModelsResponse | ProviderModelsFailure>;
}

export interface AdminServiceDeps {
  store: EncryptedRecordStore;
  clock: Clock;
  /**
   * 运行时配置（自动禁用的阈值/开关从这里读）。
   *
   * 可缺省：缺省时按"关闭自动禁用"处理（`channelAutoDisable` 取不到就不是 true）——
   * 宁可少一个自动化行为，也不要因为读不到配置就把渠道莫名其妙关掉。
   */
  config?: {
    channelAutoDisable?: boolean;
    channelAutoDisableFailures?: number;
    channelAutoDisableRecover?: boolean;
  };
  capabilityRegistry: CapabilityRegistry;
  credentialResolver: CredentialResolver;
  /**
   * provider → 是否已配置（**与 `ModelCatalog` 同一个端口实例**，组合根建一次注入两处）。
   *
   * 用途只有一个：`GET /admin/api/capabilities`（管理面「模型目录」页的数据源）按
   * `/v1/models` 的同款判据过滤——没配渠道也没配 key 的 provider 的条目默认不列。
   * 判据实现在 catalog/visibility.ts，两边共用，不写第二套。
   *
   * 不注入 = 不过滤（管理面看到矩阵全量）。只测合并/CRUD 逻辑的装配不该被部署状态
   * 干扰，与 `ModelCatalogOptions.providerAvailability` 同立场。
   */
  providerAvailability?: ProviderAvailabilityResolver;
  /**
   * access path → provider（**与 `ModelCatalog` 同一个解析器**，组合根注入）。
   *
   * 缺省 = 「点号前前缀」约定（`deepseek.openai-chat` → `deepseek`）。但那对
   * `mock-anthropic` 这类不遵守约定的 id 是错的（真实 provider 是 `mock`），所以
   * 生产装配把路由表推出的解析器一并注入，两个端口的 provider 归属永远一致。
   */
  providerOfAccessPath?: (accessPath: string) => string;
  /** 依赖**接口**而不是 DefaultAliasResolver 具体类（DI 常规立场）。 */
  aliasResolver: AliasResolver;
  /**
   * provider 配置的运行时投影（namespace / 服务端工具开关的请求路径视图）。
   *
   * 不注入 = namespace 与服务端工具开关都不生效（解析器收不到 namespace 规则、
   * `/v1/models` 不暴露生效名），但别名与 CRUD 一切照旧——老装配不受影响。
   */
  providerRuntime?: ProviderRuntimeIndex;
  metadataSync?: MetadataSyncPort;
  balanceProbe?: BalanceProbePort;
  /** 上游模型清单拉取（`/admin/api/provider-models`）。不注入 = 该端点 501。 */
  providerModels?: ProviderModelsPort;
  /** 渠道启用回调（组合根可据此按需挂载 provider 的内置工具/音频能力，避免核心写死）。 */
  onChannelActivated?: (provider: ProviderConfig, accessPath: string) => void;
  /** 渠道停用/删除回调。 */
  onChannelDeactivated?: (providerId: string, accessPath: string) => void;
  /** 为渠道静态模型补全离线目录元数据的可选钩子。 */
  enrichStaticCapability?: (
    provider: ProviderConfig,
    model: string,
  ) => Partial<CapabilityEntry> | undefined;
  usageSource?: UsageRecordSource;
  reconciliationSource?: ReconciliationSource;
  /** 数据面 virtual key 存储（66 §2）。不注入 = 虚拟 key 端点 501。 */
  virtualKeys?: VirtualKeyStore;
  /** 数据面认证模式描述者（auth/data-plane.ts）。不注入 = 模式端点给缺省值。 */
  dataPlaneAuth?: { describe(): Promise<AuthModeResponse> };
  /** 运行时设置（P0-2）。不注入 = 设置端点 501。 */
  settings?: SettingsService;
  /** Provider 预设列表（注入以避免 admin 反向依赖 providers/*）。 */
  providerPresets?: readonly ProviderPreset[];
  /** 路由图引擎注册表。 */
  routeGraphs?: RouteGraphRegistry;
  /** 路由遥测聚合中心（5h 限额 / 余额 / 积分 / 闲时状态）。 */
  routingTelemetry?: RoutingTelemetryHub;
  /** 触发一次各上游余额/积分的实时拉取并刷新遥测缓存。 */
  telemetryRefresher?: (provider?: string) => Promise<void>;
  /** 插件宿主（供控制面插件中心 Dogfooding：查看状态、启停、配置、日志）。 */
  pluginHost?: PluginHost;
  /** 定价服务（供模型目录展示参考单价）。 */
  pricingService?: PricingService;
}

// ---------------------------------------------------------------------------
// 记录 kind
// ---------------------------------------------------------------------------

const PROVIDER_KIND = 'provider' as const;
const ALIAS_KIND = 'alias' as const;
const ROUTE_GRAPH_KIND = 'route_graph' as const;
const AUDIT_KIND = 'audit' as const;
const CRED_META_KIND = 'credential' as const;
const PLUGIN_STATE_KIND = 'plugin_state' as const;

/**
 * `by_credential` 里"这笔用量归不到任何一把 key"时的分组名。
 *
 * 三种来路：路径不需要凭据（mock / local）、上游调用没走到签发鉴权头就失败了、
 * 历史记录（这个字段加上之前落的）。**不能并进某一把 key 里冒充**——"看不出是哪把
 * key 烧的"本身就是要被看见的事实，混进去会让按 key 的配额核算悄悄偏大。
 */
export const UNATTRIBUTED_CREDENTIAL = '未记录';

/**
 * 用量时间序列的桶数上限。
 *
 * 趋势图画在概览卡里通常只有 600–1200px 宽，超过 ~120 个点就糊成一片色块，
 * 而且没有任何信息增益（管理面看的是"这几天在涨还是在跌"，不是逐分钟抖动）。
 */
const MAX_TIMESERIES_BUCKETS = 120;

/**
 * 调用方没给桶宽时的默认档位（按区间长度选）。
 *
 * 目标密度是 **30–40 个桶**：少于 20 个点趋势看不出来，多于 50 个在卡片宽度下
 * 每个点不到 20px、tooltip 会互相打架。
 */
function defaultBucketMs(fromTs: number, toTs: number): number {
  const span = Math.max(1, toTs - fromTs);
  const hour = 3600_000;
  const day = 24 * hour;
  if (span <= 6 * hour) return 10 * 60_000; // ≤6h → 10 分钟
  if (span <= 24 * hour) return 30 * 60_000; // ≤24h → 30 分钟
  if (span <= 3 * day) return 2 * hour; // ≤3d → 2 小时
  if (span <= 7 * day) return 6 * hour; // ≤7d → 6 小时
  if (span <= 31 * day) return 12 * hour; // ≤31d → 12 小时
  return 7 * day; // 更长 → 周
}

/**
 * 把一段 usage 记录切成等距桶（**纯函数**，导出给 `admin/usage-timeseries.test.ts`
 * 做回归：桶边界错一格，趋势图就会整体平移，而这种 bug 在 UI 上看不出来）。
 *
 * 输入 `records` 只用到 `ts` / token / cost / status 四个字段，因此测试可以用
 * 裸对象构造，不必造一整条 UsageRecord。
 */
export function buildUsageTimeseries(
  records: ReadonlyArray<{
    ts: number;
    usage: { units: UsageUnitsView };
    cost: { cash: { total: number }; as_api: { total: number }; status: string; currency?: string };
    price_snapshot?: { currency?: string } | null;
  }>,
  from: number,
  to: number,
  bucketMs?: number,
): UsageTimeseriesResponse {
  const span = Math.max(1, to - from);
  // 桶数上限：区间再长也最多 120 个桶（多了在 1200px 宽的卡片里就糊成一片）。
  const wanted = bucketMs ?? defaultBucketMs(from, to);
  const bucketCount = Math.min(Math.max(1, Math.ceil(span / wanted)), MAX_TIMESERIES_BUCKETS);
  // 用「区间 / 桶数」反算实际桶宽，保证桶严丝合缝铺满 [from, to)：
  // 既不留下短一截的尾巴桶，也不出现越过 to 的桶。
  const effectiveMs = span / bucketCount;

  const buckets: UsageTimeseriesBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    buckets.push({
      from_ts: from + i * effectiveMs,
      to_ts: from + (i + 1) * effectiveMs,
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cash_total: 0,
      as_api_total: 0,
      unpriced_count: 0,
    });
  }

  for (const r of records) {
    // 越界（理论上不该有）与 NaN 都落进最后一个桶：绝不静默丢弃一条记录——
    // 趋势图少一个点的后果是"看起来没请求"，比多一个点严重得多。
    const offset = Math.floor((r.ts - from) / effectiveMs);
    const idx = Number.isFinite(offset)
      ? Math.min(Math.max(offset, 0), bucketCount - 1)
      : bucketCount - 1;
    const b = buckets[idx];
    if (b === undefined) continue;
    const cur = r.cost.currency ?? r.price_snapshot?.currency;
    b.request_count += 1;
    b.input_tokens += r.usage.units.tokens?.input_tokens ?? 0;
    b.output_tokens += r.usage.units.tokens?.output_tokens ?? 0;
    b.cash_total += toUsdAmount(r.cost.cash.total, cur);
    b.as_api_total += toUsdAmount(r.cost.as_api.total, cur);
    if (r.cost.status === 'unpriced' || r.cost.status === 'pending_price') b.unpriced_count += 1;
  }

  return { from_ts: from, to_ts: to, bucket_ms: effectiveMs, buckets, available: true };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AdminService {
  /** 由管理面渠道动态注册进 CapabilityRegistry 的条目，重建 runtime 前先清理。 */
  private readonly managedChannelCapabilities: Array<{
    access_path: string;
    model: string;
    modality: CapabilityEntry['modality'];
  }> = [];
  private readonly hiddenModels = new Set<string>();

  constructor(private readonly deps: AdminServiceDeps) {
    const resolverWithHook = this.deps.credentialResolver as unknown as {
      setOnSecretRefreshed?: (cb: (credentialId: string, newSecret: string) => Promise<void>) => void;
    };
    if (typeof resolverWithHook.setOnSecretRefreshed === 'function') {
      resolverWithHook.setOnSecretRefreshed(async (credentialId, newSecret) => {
        const key = `cred:${credentialId}`;
        const existing = await this.deps.store.get<Record<string, unknown>>(CRED_META_KIND, key);
        if (existing === undefined) return;
        await this.deps.store.put(
          CRED_META_KIND,
          key,
          { ...existing, secret: newSecret }, // privacy-scan: ignore —— 刷新后的 OAuth JSON 进加密库
          this.deps.clock.now(),
        );
      });
    }
  }

  // ---- 审计 ----

  /**
   * 写一条审计日志。
   *
   * `detail` **由调用方显式构造**，禁止把请求体整体传进来（请求体里可能有
   * secret）。这里再兜一道底：把看起来像 key 的串替换掉。
   */
  private async audit(
    actor: string,
    action: string,
    subject: string,
    outcome: 'ok' | 'error',
    detail?: string,
  ): Promise<void> {
    const entry: AuditLogEntry = {
      id: `audit_${this.deps.clock.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: this.deps.clock.now(),
      actor,
      action,
      subject,
      outcome,
      ...(detail === undefined ? {} : { detail: redactDetail(detail) }),
    };
    await this.deps.store.put(AUDIT_KIND, entry.id, entry);
  }

  async listAudit(limit = 100, offset = 0): Promise<{ items: AuditLogEntry[]; total: number }> {
    const all = (await this.deps.store.listDecrypted<AuditLogEntry>(AUDIT_KIND))
      .map((r) => r.value)
      .sort((a, b) => b.ts - a.ts);
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  // ---- Provider CRUD ----

  async listProviders(): Promise<ProviderConfig[]> {
    const all = await this.deps.store.listDecrypted<ProviderConfig>(PROVIDER_KIND);
    const allCreds = await this.listCredentials();
    const envPaths = this.listEnvCredentialPaths();
    return all
      .map((r) => this.attachProviderKeys(hydrateProviderModelMetadata(r.value), allCreds, envPaths))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProvider(id: string): Promise<ProviderConfig | undefined> {
    const p = await this.deps.store.get<ProviderConfig>(PROVIDER_KIND, id);
    if (p === undefined) return undefined;
    const allCreds = await this.listCredentials();
    const envPaths = this.listEnvCredentialPaths();
    return this.attachProviderKeys(hydrateProviderModelMetadata(p), allCreds, envPaths);
  }

  private attachProviderKeys(
    provider: ProviderConfig,
    allCreds: readonly MaskedCredential[],
    envPaths: readonly { access_path: string; count: number }[],
  ): ProviderConfig {
    const derived = accessPathIdForDialect(provider.id, provider.dialect);
    const keys: MaskedProviderKey[] = [];
    for (const c of allCreds) {
      if (c.provider !== provider.id && c.access_path !== derived) continue;
      const isOauth = c.note?.toLowerCase().includes('oauth') === true || c.id.includes('oauth');
      if (c.storage.location === 'env') {
        const envVar = c.storage.ref.replace(/^env:/, '');
        keys.push({
          id: c.id,
          masked: `$${envVar}`,
          source: 'env',
          env_var: envVar,
          enabled: c.enabled,
        });
      } else {
        keys.push({
          id: c.id,
          masked: isOauth ? 'OAuth' : c.masked,
          source: isOauth ? 'oauth' : 'stored',
          enabled: c.enabled,
        });
      }
    }
    const envHit = envPaths.find(
      (e) =>
        e.count > 0 &&
        (e.access_path === derived ||
          e.access_path === provider.id ||
          e.access_path.startsWith(`${provider.id}.`)),
    );
    if (envHit !== undefined && !keys.some((k) => k.source === 'env')) {
      keys.push({
        id: `env:${envHit.access_path}`,
        masked: `环境变量 (${envHit.count})`,
        source: 'env',
        enabled: true,
      });
    }
    return {
      ...provider,
      keys,
      has_key: keys.some((k) => k.enabled),
    };
  }

  /**
   * 建/改一个 provider。
   *
   * namespace 的三条硬规则都在**保存时**拒绝，而不是等请求路径出错（那是最难查的
   * 一类 bug——客户端拿到 400，网关 trace 显示一切正常）：
   *   1. 格式不合法（含 `/`、首字符不是字母数字、超长…）；
   *   2. 与**另一个 provider** 的 namespace 撞名（两个渠道都叫 `ds`，`ds/x` 归谁
   *      取决于内部排序，而排序对使用者不可见）；
   *   3. 与一条**已存在的显式别名**撞名（别名优先级更高，会造成"我配了 namespace
   *      却被一条老别名劫持"的静默行为）。
   *
   * 保存成功还会做两件"让配置真的能路由"的事：把派生 access path 登记进凭据解析器
   * （否则 `baseUrlFor` 只能给一个必然连不上的缺省地址），把静态模型清单登记进能力
   * 矩阵（否则 namespace 解析与 passthrough 都认为"这个模型不存在"）。
   */
  async upsertProvider(
    actor: string,
    input: Omit<ProviderConfig, 'created_at' | 'updated_at' | 'enabled' | 'keys' | 'has_key'> & {
      id: string;
      enabled?: boolean;
      api_keys?: string[];
    },
  ): Promise<{ ok: true; provider: ProviderConfig } | { ok: false; error: string }> {
    if (input.id.length === 0) return { ok: false, error: 'provider id 不能为空' };
    if (input.label.length === 0) return { ok: false, error: 'provider label 不能为空' };
    if (!/^https?:\/\//.test(input.base_url)) {
      return { ok: false, error: 'base_url 必须是 http(s):// 开头' };
    }
    const namespace = input.namespace ?? '';
    const nsCheck = validateNamespace(namespace);
    if (!nsCheck.ok) return { ok: false, error: nsCheck.errors[0]! };
    if (namespace !== '' && !isAccessPathSafeProviderId(input.id)) {
      return {
        ok: false,
        error: `启用 namespace 要求 provider id 只含小写字母/数字/中划线（当前 "${input.id}"）`,
      };
    }
    if (namespace !== '') {
      const conflict = await this.namespaceConflict(input.id, namespace);
      if (conflict !== undefined) return { ok: false, error: conflict };
    }

    const prev = await this.getProvider(input.id);
    const effectiveEnabled = input.enabled ?? prev?.enabled ?? true;
    if (effectiveEnabled && input.model_source.kind === 'static') {
      const myModels = new Set(
        input.model_source.models.map((m) => (namespace !== '' ? `${namespace}/${m}` : m)),
      );
      const others = (await this.listProviders()).filter((p) => p.id !== input.id && p.enabled);
      for (const other of others) {
        if (other.model_source.kind !== 'static') continue;
        const otherNs = other.namespace ?? '';
        for (const m of other.model_source.models) {
          const eff = otherNs !== '' ? `${otherNs}/${m}` : m;
          if (myModels.has(eff)) {
            return {
              ok: false,
              error: `模型标识 "${eff}" 与渠道 ${other.id} 冲突，请设置不同的 namespace`,
            };
          }
        }
      }
    }

    const now = this.deps.clock.now();
    const { api_keys: apiKeys, ...restInput } = input;
    const provider: ProviderConfig = {
      ...restInput,
      namespace,
      builtin_tools: normalizeBuiltinToolDefaults(input.builtin_tools),
      // 未显式给 enabled 时：新建默认开，改建沿用旧值（不能被一次 PATCH 静默关掉）
      enabled: input.enabled ?? prev?.enabled ?? true,
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    await this.deps.store.put(PROVIDER_KIND, input.id, provider);

    // 若调用方传入了 api_keys，则替换该渠道名下的 API Key / 环境变量凭据（保留 OAuth 订阅凭据）
    if (apiKeys !== undefined) {
      const accessPath = accessPathIdForDialect(input.id, input.dialect);
      const parsedEntries: Array<
        { kind: 'env'; env_ref: string } | { kind: 'raw'; value: string }
      > = [];
      for (const rawEntry of apiKeys) {
        const trimmed = rawEntry.trim();
        if (trimmed === '') continue;
        if (trimmed.startsWith('$') && trimmed.length > 1) {
          parsedEntries.push({ kind: 'env', env_ref: `env:${trimmed.slice(1)}` });
        } else if (trimmed.startsWith('env:') && trimmed.length > 4) {
          parsedEntries.push({ kind: 'env', env_ref: trimmed });
        } else {
          parsedEntries.push({
            kind: 'raw',
            value: trimmed,
          });
        }
      }

      const existing = await this.listCredentials(input.id);
      const nonOauthExisting = existing.filter(
        (c) => !(c.note?.toLowerCase().includes('oauth') === true || c.id.includes('oauth')),
      );
      for (const old of nonOauthExisting) {
        await this.deleteCredential(actor, old.id);
      }
      for (const entry of parsedEntries) {
        const created = await this.createCredential(
          actor,
          entry.kind === 'env'
            ? { provider: input.id, access_path: accessPath, env_ref: entry.env_ref }
            : {
                provider: input.id,
                access_path: accessPath,
                secret: entry.value, // privacy-scan: ignore —— 内存变量传递给加密库，非硬编码密钥
              },
        );
        if (!created.ok) {
          return { ok: false, error: created.error };
        }
      }
    }

    await this.refreshProviderRuntime();
    await this.audit(
      actor,
      prev === undefined ? 'provider.create' : 'provider.update',
      `provider/${input.id}`,
      'ok',
      `namespace=${namespace === '' ? '(未启用)' : namespace}`,
    );
    const hydrated = (await this.getProvider(input.id)) ?? provider;
    return { ok: true, provider: hydrated };
  }

  /**
   * namespace 撞名检查（保存时拒）。
   *
   * 两类撞名都返回**能说出撞的是谁**的一句话（用户反馈的硬要求：错误信息要能定位）：
   *   - 同 namespace 的另一个 provider → 说 provider id；
   *   - 同名的显式别名 → 说别名 id 与种类。
   */
  private async namespaceConflict(
    providerId: string,
    namespace: string,
  ): Promise<string | undefined> {
    const others = (await this.listProviders()).filter((p) => p.id !== providerId);
    const twin = others.find((p) => (p.namespace ?? '') === namespace);
    if (twin !== undefined) {
      return `namespace "${namespace}" 已被渠道 ${twin.id} 占用，请换一个`;
    }
    const idTwin = others.find((p) => p.id === namespace);
    if (idTwin !== undefined) {
      return `namespace "${namespace}" 与已有渠道 ${idTwin.id} 的 ID 冲突，请换一个`;
    }
    // 别名优先级高于 namespace，所以"同名别名存在"必须拒：否则客户端发这个名字
    // 永远走别名，namespace 配了却不生效，而这种不一致在请求路径上看不出来。
    const alias = this.deps.aliasResolver
      .listRules()
      .find((r) => r.enabled && (r.pattern === namespace || r.pattern === `${namespace}/`));
    if (alias !== undefined) {
      return `namespace "${namespace}" 与显式别名 ${alias.id}（${alias.kind}:${alias.pattern}）撞名，请先改别名`;
    }
    return undefined;
  }

  /** 把持久化凭据同步到 CredentialResolver（支持加密库 key 与动态 env 引用）。 */
  async syncCredentialsToResolver(): Promise<void> {
    this.deps.credentialResolver.clearStoredCredentials?.();
    const metas = await this.deps.store.listMeta(CRED_META_KIND);
    for (const meta of metas) {
      if (!meta.id.startsWith('cred:')) continue;
      const rec = await this.deps.store.get<{
        provider: string;
        access_path: string;
        secret?: string;
        env_ref?: string;
        health: MaskedCredential['health'];
        last_checked?: number;
      }>(CRED_META_KIND, meta.id);
      if (rec === undefined) continue;
      const id = meta.id.slice('cred:'.length);
      const storage: UpstreamCredential['storage'] =
        rec.env_ref !== undefined
          ? { location: 'env', ref: rec.env_ref, encrypted: false }
          : { location: 'vault', ref: id, encrypted: true };
      const healthStatus: UpstreamCredential['health']['status'] =
        rec.health === 'ok' ? 'ok' : rec.health === 'error' ? 'forbidden' : 'unknown';
      this.deps.credentialResolver.registerCredential?.(
        {
          id,
          name: `${rec.provider} (${id})`,
          type: 'api_key',
          access_path: rec.access_path,
          model_namespace: rec.access_path,
          storage,
          health: { status: healthStatus, last_checked: rec.last_checked ?? 0 },
          priority: 50,
          enabled: true,
          refresh: { kind: 'static', on_refresh_failure: 'alert_only' },
        },
        rec.secret,
      );
    }
  }

  /** 重算 provider 运行时投影（存储 → access path / 静态能力 / 凭据 / namespace 规则）。 */
  async refreshProviderRuntime(): Promise<void> {
    for (const ref of this.managedChannelCapabilities.splice(0)) {
      this.deps.capabilityRegistry.unregister(ref.access_path, ref.model, ref.modality);
    }

    const providers = await this.listProviders();
    if (this.deps.routeGraphs !== undefined) {
      const storedGraphs = await this.listRouteGraphs();
      for (const g of storedGraphs) {
        this.deps.routeGraphs.upsert(g);
      }
    }
    const runtime = this.deps.providerRuntime;
    if (runtime !== undefined) {
      runtime.replace(
        providers.map((p) => ({
          id: p.id,
          dialect: p.dialect,
          base_url: p.base_url,
          namespace: p.namespace ?? '',
          access_path: accessPathIdForDialect(p.id, p.dialect),
          models: p.model_source.kind === 'static' ? [...p.model_source.models] : [],
          enabled: p.enabled,
          ...(p.auto_disabled === undefined ? {} : { auto_disabled: { ...p.auto_disabled } }),
          builtin_tools: p.builtin_tools ?? {},
          ...(p.pricing === undefined ? {} : { pricing: p.pricing }),
        })),
      );
    }

    for (const provider of providers) {
      const accessPath = accessPathIdForDialect(provider.id, provider.dialect);
      if (!provider.enabled) {
        this.deps.onChannelDeactivated?.(provider.id, accessPath);
        continue;
      }
      const existing = this.deps.credentialResolver.accessPath(accessPath);
      const presetHints = findPresetTransportHints(
        this.deps.providerPresets ?? [],
        provider.id,
        provider.dialect,
        provider.base_url,
      );
      const transportHints = existing?.transport_hints ?? presetHints;
      this.deps.credentialResolver.registerAccessPath?.({
        id: accessPath,
        label: existing?.label ?? `${provider.label} (${provider.dialect})`,
        format: provider.dialect,
        usage_source: 'provider',
        model_namespaces:
          provider.namespace === undefined || provider.namespace === ''
            ? []
            : [provider.namespace],
        requires_credential: existing?.requires_credential ?? true,
        base_url: provider.base_url,
        ...(existing?.key_env === undefined ? {} : { key_env: existing.key_env }),
        ...(transportHints === undefined ? {} : { transport_hints: transportHints }),
      });
      this.deps.onChannelActivated?.(provider, accessPath);
      if (provider.model_source.kind === 'static') {
        for (const model of provider.model_source.models) {
          if (isImageOnlyModel(model, provider.model_metadata?.[model])) {
            const imgAccessPath = provider.id === 'openai' ? 'openai.images' : accessPath;
            if (this.deps.capabilityRegistry.find(imgAccessPath, model, 'image') === undefined) {
              this.deps.capabilityRegistry.register({
                access_path: imgAccessPath,
                model,
                modality: 'image',
                format:
                  provider.dialect === 'gemini.generateContent'
                    ? 'gemini.generateContent'
                    : 'openai.images.generations',
                usage_source: 'provider',
                usage_units: ['images', 'tokens'],
                quirks: [
                  `由管理面渠道 ${provider.id} 的静态模型清单登记`,
                  ...(provider.namespace === undefined || provider.namespace === ''
                    ? []
                    : [`可用 <${provider.namespace}>/<模型名> 访问`]),
                ],
                contract_tested: false,
                status: 'implemented',
              });
              this.managedChannelCapabilities.push({
                access_path: imgAccessPath,
                model,
                modality: 'image',
              });
            }
            continue;
          }
          if (isEmbeddingOnlyModel(model, provider.model_metadata?.[model])) {
            const embAccessPath = provider.id === 'openai' ? 'openai.embeddings' : accessPath;
            if (this.deps.capabilityRegistry.find(embAccessPath, model, 'embedding') === undefined) {
              this.deps.capabilityRegistry.register({
                access_path: embAccessPath,
                model,
                modality: 'embedding',
                format:
                  provider.dialect === 'gemini.generateContent'
                    ? 'gemini.generateContent'
                    : 'openai.embeddings',
                usage_source: 'provider',
                usage_units: ['tokens'],
                quirks: [
                  `由管理面渠道 ${provider.id} 的静态模型清单登记`,
                  ...(provider.namespace === undefined || provider.namespace === ''
                    ? []
                    : [`可用 <${provider.namespace}>/<模型名> 访问`]),
                ],
                contract_tested: false,
                status: 'implemented',
              });
              this.managedChannelCapabilities.push({
                access_path: embAccessPath,
                model,
                modality: 'embedding',
              });
            }
            continue;
          }
          if (this.deps.capabilityRegistry.find(accessPath, model, 'chat') !== undefined) {
            continue;
          }
          // 若已在专用非对话端点（如 *.tools.tts / *.tools.asr）登记该模型，
          // 则不再重复以 chat 模态挂到对话端点上（含复制出来的副本渠道）
          const hasSpecializedModality = this.deps.capabilityRegistry
            .list()
            .some((e) => e.model === model && e.modality !== 'chat');
          if (hasSpecializedModality) {
            continue;
          }
          const meta = provider.model_metadata?.[model];
          const inferredModality: CapabilityEntry['modality'] = isVideoOnlyModel(model, meta)
            ? 'video'
            : isImageOnlyModel(model, meta)
              ? 'image'
              : 'chat';
          const enriched = this.deps.enrichStaticCapability?.(provider, model);
          this.deps.capabilityRegistry.register({
            ...enriched,
            access_path: accessPath,
            model,
            modality: inferredModality,
            format: provider.dialect,
            usage_source: 'provider',
            usage_units: enriched?.usage_units ?? ['tokens'],
            quirks: enriched?.quirks ?? [
              `由管理面渠道 ${provider.id} 的静态模型清单登记`,
              ...(provider.namespace === undefined || provider.namespace === ''
                ? []
                : [`可用 <${provider.namespace}>/<模型名> 访问`]),
            ],
            contract_tested: enriched?.contract_tested ?? false,
            status: enriched?.status ?? 'implemented',
          });
          this.managedChannelCapabilities.push({
            access_path: accessPath,
            model,
            modality: inferredModality,
          });
        }
      }
    }

    await this.syncCredentialsToResolver();

    const byProvider = new Map<string, Set<string>>();
    for (const entry of this.deps.capabilityRegistry.list()) {
      const provider = providerFromAccessPath(entry.access_path);
      const set = byProvider.get(provider) ?? new Set<string>();
      set.add(entry.access_path);
      byProvider.set(provider, set);
    }
    this.deps.aliasResolver.setNamespaces(
      providers
        .filter((p) => (p.namespace ?? '') !== '' && p.enabled)
        .map((p): NamespaceRule => ({
          namespace: p.namespace!,
          provider: p.id,
          access_paths: [...(byProvider.get(p.id) ?? [])],
          enabled: true,
          note: `渠道 ${p.id} 的命名空间`,
        })),
    );
  }

  async deleteProvider(actor: string, id: string): Promise<boolean> {
    const provider = await this.getProvider(id);
    const deleted = await this.deps.store.delete(PROVIDER_KIND, id);
    if (deleted) {
      if (provider !== undefined) {
        const accessPath = accessPathIdForDialect(id, provider.dialect);
        this.deps.credentialResolver.unregisterAccessPath?.(accessPath);
        this.deps.onChannelDeactivated?.(id, accessPath);
        if (provider.model_source.kind === 'static') {
          for (const model of provider.model_source.models) {
            this.deps.capabilityRegistry.unregister(accessPath, model, 'chat');
          }
        }
      }
      await this.refreshProviderRuntime();
      await this.audit(actor, 'provider.delete', `provider/${id}`, 'ok');
    }
    return deleted;
  }

  async deleteProviderWithCascade(
    actor: string,
    id: string,
    options: { cascadeCredentials?: boolean } = {},
  ): Promise<{ deleted: boolean; deletedCredentials: string[] }> {
    const target = await this.getProvider(id);
    const deleted = await this.deleteProvider(actor, id);
    const deletedCredentials: string[] = [];
    if (deleted && options.cascadeCredentials !== false) {
      const remaining = await this.listProviders();
      const remainingIds = new Set(remaining.map((p) => p.id));
      const remainingAccessPaths = new Set(
        remaining.map((p) => accessPathIdForDialect(p.id, p.dialect)),
      );
      const targetAccessPath =
        target === undefined ? undefined : accessPathIdForDialect(id, target.dialect);
      const allCreds = await this.listCredentials();
      for (const c of allCreds) {
        const belongsToTarget =
          c.provider === id || (targetAccessPath !== undefined && c.access_path === targetAccessPath);
        if (!belongsToTarget) continue;
        const sharedWithRemaining =
          remainingIds.has(c.provider) || remainingAccessPaths.has(c.access_path);
        if (sharedWithRemaining) continue;
        if (await this.deleteCredential(actor, c.id)) {
          deletedCredentials.push(c.id);
        }
      }
    }
    return { deleted, deletedCredentials };
  }

  // ---- 批量操作 / 复制 / 连通性测试 ----

  /**
   * 批量启用 / 停用 / 删除。
   *
   * 三条设计（对齐 NewAPI 的批量语义，但避开它的两个坑）：
   *   1. **不 fail-fast**：一个坏的 id 不影响其余，逐项报错（`failed[]`）；
   *   2. **每项一条审计**：批量操作最怕"改了 20 个渠道但日志里只有一条"，那等于
   *      没有审计；
   *   3. **单批上限 100**：控制面请求体都是小配置，超了大概率是客户端 bug。
   */
  async batchProviders(
    actor: string,
    input: { ids: string[]; action: 'enable' | 'disable' | 'delete'; cascade_credentials?: boolean },
  ): Promise<{
    ok: boolean;
    changed: string[];
    failed: Array<{ id: string; error: string }>;
    deleted_credentials?: string[];
  }> {
    if (input.ids.length === 0)
      return { ok: false, changed: [], failed: [{ id: '', error: 'ids 不能为空' }] };
    if (input.ids.length > 100) {
      return { ok: false, changed: [], failed: [{ id: '', error: '单批最多 100 个' }] };
    }
    const changed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    const deletedCredentials: string[] = [];
    for (const id of input.ids) {
      try {
        if (input.action === 'delete') {
          const resDelete = await this.deleteProviderWithCascade(actor, id, {
            ...(input.cascade_credentials === undefined
              ? {}
              : { cascadeCredentials: input.cascade_credentials }),
          });
          if (resDelete.deleted) {
            changed.push(id);
            deletedCredentials.push(...resDelete.deletedCredentials);
          } else {
            failed.push({ id, error: '渠道不存在' });
          }
          continue;
        }
        const provider = await this.getProvider(id);
        if (provider === undefined) {
          failed.push({ id, error: '渠道不存在' });
          continue;
        }
        await this.setProviderEnabled(actor, id, input.action === 'enable');
        changed.push(id);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : '内部错误' });
      }
    }
    return {
      ok: failed.length === 0,
      changed,
      failed,
      ...(input.action === 'delete' ? { deleted_credentials: deletedCredentials } : {}),
    };
  }

  /**
   * 启用 / 停用一个渠道（**只改 enabled，不动别的字段**）。
   *
   * 不复用 `upsertProvider`：那个方法的入参是整条配置，用它改一个开关会让
   * "只想关一下"变成"顺便把 base_url/dialect 覆盖一遍"，而调用方（批量端点）
   * 手里只有 id。
   *
   * 停用时**清掉 auto_disabled**：手动停用是一个明确的管理员意图，留着自动禁用的
   * 记录会让人以为"是网关关的"。
   */
  async setProviderEnabled(actor: string, id: string, enabled: boolean): Promise<boolean> {
    const provider = await this.getProvider(id);
    if (provider === undefined) return false;
    const next: ProviderConfig = {
      ...provider,
      enabled,
      updated_at: this.deps.clock.now(),
      ...(enabled ? {} : { auto_disabled: undefined }),
    };
    await this.deps.store.put(PROVIDER_KIND, id, next);
    await this.refreshProviderRuntime();
    await this.audit(
      actor,
      enabled ? 'provider.enable' : 'provider.disable',
      `provider/${id}`,
      'ok',
    );
    return true;
  }

  /**
   * 复制一个渠道（**只复制配置，不复制凭据**）。
   *
   * 为什么不复制凭据：同一个 key 在加密存储里存两份密文，与"key 只在创建时出现
   * 一次"的边界相悖（轮换时忘掉其中一份就成了永久的死密钥）。新渠道用同一个 key
   * 的正确做法是再录一次凭据，或者（更常见）复用同一条 access path 上的 env 凭据。
   *
   * 不复制 `enabled` / 时间戳：新渠道按新建语义走（默认启用、新时间戳）。
   */
  async copyProvider(
    actor: string,
    id: string,
    input: { new_id?: string; label?: string },
  ): Promise<
    { ok: true; provider: ProviderConfig } | { ok: false; status: 400 | 404 | 409; error: string }
  > {
    const src = await this.getProvider(id);
    if (src === undefined) return { ok: false, status: 404, error: '渠道不存在' };
    const newId = input.new_id ?? `${src.id}-copy`;
    if (newId === src.id) {
      return { ok: false, status: 400, error: 'new_id 不能与源渠道相同' };
    }
    if (!isAccessPathSafeProviderId(newId)) {
      return {
        ok: false,
        status: 400,
        error: 'new_id 只能含小写字母/数字/中划线，且以字母或数字开头',
      };
    }
    if ((await this.getProvider(newId)) !== undefined) {
      return { ok: false, status: 409, error: `渠道 ${newId} 已存在` };
    }
    let namespace = src.namespace ?? '';
    if (namespace !== '') {
      const conflict = await this.namespaceConflict(newId, namespace);
      if (conflict !== undefined) return { ok: false, status: 409, error: conflict };
    } else if (
      validateNamespace(newId).ok &&
      (await this.namespaceConflict(newId, newId)) === undefined
    ) {
      // 源渠道未设 namespace 时，副本默认以 newId 作为 namespace，避免模型标识冲突
      namespace = newId;
    }
    const label = input.label ?? `${src.label} 副本`;
    const result = await this.upsertProvider(actor, {
      id: newId,
      label,
      dialect: src.dialect,
      base_url: src.base_url,
      namespace,
      model_source:
        src.model_source.kind === 'static'
          ? { kind: 'static', models: [...src.model_source.models] }
          : src.model_source,
      builtin_tools: { ...(src.builtin_tools ?? {}) },
      ...(src.capability_overrides === undefined
        ? {}
        : { capability_overrides: structuredCloneish(src.capability_overrides) }),
      ...(src.note === undefined ? {} : { note: src.note }),
    });
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    await this.audit(actor, 'provider.copy', `provider/${newId}`, 'ok', `from=${id}`);
    return { ok: true, provider: result.provider };
  }

  /**
   * 检查一个已存渠道的凭据还能不能用（**打一次上游 `GET /models`，不发 chat**）。
   *
   * 与 `probeCredential`（只做本地解析、从不上游）的分工：那个回答"凭据能不能解析"，
   * 这个回答"这个 key 在上游还认不认"。前端据此把按钮从「测试」改成「检查凭据」并
   * 三态照实（成功 / 失败 + 原因 / 未探测）。
   *
   * 顺带把结果回写到渠道记录（`credential_health` / `credential_last_checked`）——
   * 这两个字段早就在契约里，从来没有被更新过，于是 UI 上永远是 `unknown`。
   *
   * **探测成功时清掉 `auto_disabled`**（不动 `enabled`）：与 `GatewayConfig`
   * 的 `channelAutoDisableRecover` 注释（di/ports.ts：「探测成功是否自动恢复，true =
   * 恢复时只清 auto_disabled，不动 enabled」）对齐。不清的后果是一个死锁——渠道因为
   * 一次上游失败进了计数态，`ProviderStateFilter` 又拿「auto_disabled 存在」当不可用，
   * 于是请求根本发不出去、成功恢复的路径永远跑不到，只能人工停用再启用。
   * 手动停用的渠道不受影响：这里只清 auto_disabled，`enabled` 一个字都不碰。
   */
  async testProvider(
    actor: string,
    id: string,
  ): Promise<
    | { ok: true; status: 'ok'; checked_at: number }
    | { ok: false; status: 'error'; code: string; message: string; checked_at: number }
  > {
    const checked_at = this.deps.clock.now();
    const provider = await this.getProvider(id);
    if (provider === undefined) {
      return { ok: false, status: 'error', code: 'not_found', message: '渠道不存在', checked_at };
    }
    const result = await this.fetchProviderModels(actor, {
      base_url: provider.base_url,
      dialect: provider.dialect,
      provider_id: id,
    });
    const health: 'ok' | 'error' = result.ok ? 'ok' : 'error';
    // 恢复开关关着时只累计不恢复（与 recordUpstreamSuccess 同一口径）
    const clearAutoDisabled =
      result.ok &&
      provider.auto_disabled !== undefined &&
      this.deps.config?.channelAutoDisableRecover !== false;
    await this.deps.store.put(PROVIDER_KIND, id, {
      ...provider,
      ...(clearAutoDisabled ? { auto_disabled: undefined } : {}),
      credential_health: health,
      credential_last_checked: checked_at,
      updated_at: checked_at,
    });
    await this.refreshProviderRuntime();
    if (clearAutoDisabled) {
      await this.audit(actor, 'provider.auto_recover', `provider/${id}`, 'ok', '探测成功');
    }
    await this.audit(
      actor,
      'provider.test',
      `provider/${id}`,
      result.ok ? 'ok' : 'error',
      result.ok ? `models=${result.models.length}` : `code=${result.error.code}`,
    );
    if (result.ok) return { ok: true, status: 'ok', checked_at };
    return {
      ok: false,
      status: 'error',
      code: result.error.code,
      message: result.error.message,
      checked_at,
    };
  }

  // ---- 自动禁用 / 健康（NewAPI AutoBan 的对应物；80 §P1-2）----

  /**
   * 记一次上游失败；达到阈值就**自动禁用**该渠道。
   *
   * 与 NewAPI AutoBan 的差异（两条都是刻意的）：
   *   1. **401/403 立即禁用，不等计数**——key 失效不是抖动，继续打只是把配额烧在
   *      必然失败的请求上（45 §4.2 步骤 6 的同款立场）；
   *   2. **不用三态 int**：自动禁用与手动禁用分成两个字段，恢复时只清前者
   *      （见 api-types.ts 的 `auto_disabled` 注释）。
   *
   * 阈值来自 `GatewayConfig`（`AG_CHANNEL_AUTO_DISABLE_FAILURES`，默认 3），
   * **不在这里硬编码**——部署可能想更保守（5）或更激进（1）。
   */
  async recordUpstreamFailure(
    actor: string,
    providerId: string,
    httpStatus: number,
  ): Promise<{ auto_disabled: boolean; reason?: string }> {
    const provider = await this.getProvider(providerId);
    if (provider === undefined) return { auto_disabled: false };
    if (this.deps.config?.channelAutoDisable !== true) return { auto_disabled: false };

    // key 失效：立即禁用（不等计数）
    if (httpStatus === 401 || httpStatus === 403) {
      const reason = `上游返回 ${httpStatus}：key 无效或没有该端点权限`;
      await this.applyAutoDisable(
        actor,
        provider,
        reason,
        provider.auto_disabled?.consecutive_failures ?? 0,
      );
      return { auto_disabled: true, reason };
    }

    const threshold = Math.max(1, this.deps.config?.channelAutoDisableFailures ?? 3);
    const failures = (provider.auto_disabled?.consecutive_failures ?? 0) + 1;
    const now = this.deps.clock.now();
    if (failures < threshold) {
      // 还没到阈值：只累计，不改 enabled（避免一次网络抖动就关掉渠道）。
      // 注意这一态的 reason 是 AUTO_DISABLE_COUNTING_REASON——请求路径的
      // `ProviderStateFilter` 认它（见 provider-runtime.ts 的 isAutoDisabled）：
      // 计数中的渠道照样参与轮换，否则一次上游失败就要人工停用/启用才能恢复。
      await this.deps.store.put(PROVIDER_KIND, providerId, {
        ...provider,
        auto_disabled: {
          reason: AUTO_DISABLE_COUNTING_REASON,
          at: now,
          consecutive_failures: failures,
        },
        updated_at: now,
      });
      await this.refreshProviderRuntime();
      return { auto_disabled: false };
    }
    const reason = `连续 ${failures} 次上游失败（最近一次 HTTP ${httpStatus}）`;
    await this.applyAutoDisable(actor, provider, reason, failures);
    return { auto_disabled: true, reason };
  }

  /** 一次成功：清掉失败计数与自动禁用（**不动 enabled**）。 */
  async recordUpstreamSuccess(actor: string, providerId: string): Promise<{ recovered: boolean }> {
    const provider = await this.getProvider(providerId);
    if (provider === undefined) return { recovered: false };
    const wasAutoDisabled = provider.auto_disabled !== undefined;
    if (wasAutoDisabled && this.deps.config?.channelAutoDisableRecover !== true) {
      return { recovered: false };
    }
    if (!wasAutoDisabled && provider.credential_health === 'ok') return { recovered: false };
    const now = this.deps.clock.now();
    await this.deps.store.put(PROVIDER_KIND, providerId, {
      ...provider,
      auto_disabled: undefined,
      credential_health: 'ok',
      credential_last_checked: now,
      updated_at: now,
    });
    await this.refreshProviderRuntime();
    await this.audit(
      actor,
      wasAutoDisabled ? 'provider.auto_recover' : 'provider.health_ok',
      `provider/${providerId}`,
      'ok',
    );
    return { recovered: wasAutoDisabled };
  }

  private async applyAutoDisable(
    actor: string,
    provider: ProviderConfig,
    reason: string,
    consecutiveFailures: number,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.store.put(PROVIDER_KIND, provider.id, {
      ...provider,
      auto_disabled: { reason, at: now, consecutive_failures: consecutiveFailures + 1 },
      credential_health: 'error',
      credential_last_checked: now,
      updated_at: now,
    });
    await this.refreshProviderRuntime();
    await this.audit(actor, 'provider.auto_disable', `provider/${provider.id}`, 'error', reason);
  }

  // ---- 凭据（掩码）----

  /**
   * 列出一个 provider 的凭据（**只回掩码**）。
   *
   * 存储侧保证见 storage/record-store.ts：`listMeta` 不解密，因此 secret
   * 本体压根不出现在这一层。这里只负责把元数据拼成 UI 形状 + 算掩码。
   */
  async listCredentials(provider?: string): Promise<MaskedCredential[]> {
    const metas = await this.deps.store.listMeta(CRED_META_KIND);
    const out: MaskedCredential[] = [];
    for (const meta of metas) {
      if (!meta.id.startsWith('cred:')) continue;
      const rec = await this.deps.store.get<{
        provider: string;
        access_path: string;
        secret?: string;
        env_ref?: string;
        note?: string;
        health: MaskedCredential['health'];
        last_checked?: number;
      }>(CRED_META_KIND, meta.id);
      if (rec === undefined) continue;
      if (provider !== undefined && rec.provider !== provider) continue;

      const storage: MaskedCredential['storage'] =
        rec.env_ref !== undefined
          ? { location: 'env', ref: rec.env_ref }
          : { location: 'encrypted' };
      // 掩码只对「我们看得见明文」的那种算；env 引用没有明文可掩
      const maskedInfo: MaskedSecret =
        rec.secret === undefined
          ? { masked: '(env 引用，未入库)', length: 0, head: '' }
          : describeSecret(rec.secret);

      out.push({
        id: meta.id.slice('cred:'.length),
        provider: rec.provider,
        access_path: rec.access_path,
        masked: maskedInfo.masked,
        length: maskedInfo.length,
        head: maskedInfo.head,
        storage,
        enabled: true,
        health: rec.health ?? 'unknown',
        ...(rec.last_checked === undefined ? {} : { last_checked: rec.last_checked }),
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        ...(rec.note === undefined ? {} : { note: rec.note }),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 创建凭据。
   *
   * `secret` 与 `env_ref` **互斥**：都传等于同时声明「key 在库里」和
   * 「key 在环境变量里」，Resolver 该读哪个是不确定的——不确定比不存在更糟。
   */
  async createCredential(
    actor: string,
    input: {
      provider: string;
      access_path: string;
      secret?: string;
      env_ref?: string;
      note?: string;
    },
  ): Promise<{ ok: true; credential: MaskedCredential } | { ok: false; error: string }> {
    const hasSecret = input.secret !== undefined && input.secret.length > 0;
    const hasEnv = input.env_ref !== undefined && input.env_ref.length > 0;
    if (hasSecret && hasEnv) {
      return { ok: false, error: 'secret 与 env_ref 互斥：请只给一个' };
    }
    if (!hasSecret && !hasEnv) {
      return { ok: false, error: '必须提供 secret 或 env_ref 之一' };
    }
    if (input.provider.length === 0 || input.access_path.length === 0) {
      return { ok: false, error: 'provider 与 access_path 不能为空' };
    }

    const id = `cred_${this.deps.clock.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = this.deps.clock.now();
    await this.deps.store.put(
      CRED_META_KIND,
      `cred:${id}`,
      {
        provider: input.provider,
        access_path: input.access_path,
        // secret 只在有值时进库；进了库就是密文（存储侧保证）
        ...(hasSecret ? { secret: input.secret } : {}), // privacy-scan: ignore —— 契约字段名，右侧是请求体入参
        ...(hasEnv ? { env_ref: input.env_ref } : {}),
        ...(input.note === undefined ? {} : { note: input.note }),
        health: 'unknown' as const,
      },
      now,
    );

    // 审计**只记 id 与掩码**，绝不记 secret
    const maskedInfo = hasSecret ? describeSecret(input.secret!) : undefined;
    await this.audit(
      actor,
      'credential.create',
      `credential/${id}`,
      'ok',
      `provider=${input.provider} access_path=${input.access_path}` +
        (maskedInfo === undefined
          ? ' source=env'
          : ` masked=${maskedInfo.masked} length=${maskedInfo.length}`),
    );

    await this.syncCredentialsToResolver();

    const list = await this.listCredentials(input.provider);
    const created = list.find((c) => c.id === id);
    if (created === undefined) {
      return { ok: false, error: '凭据已写入但读不回来（内部错误）' };
    }
    return { ok: true, credential: created };
  }

  async deleteCredential(actor: string, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(CRED_META_KIND, `cred:${id}`);
    if (deleted) {
      this.deps.credentialResolver.unregisterCredential?.(id);
      await this.syncCredentialsToResolver();
      await this.audit(actor, 'credential.delete', `credential/${id}`, 'ok');
    }
    return deleted;
  }

  // ---- 别名 / namespace 映射 ----

  async listAliases(): Promise<AliasRuleDto[]> {
    const all = await this.deps.store.listDecrypted<AliasRule>(ALIAS_KIND);
    return all
      .map((r) => ({ rule: r.value, created_at: r.created_at, updated_at: r.updated_at }))
      .sort(
        (a, b) => a.rule.priority - b.rule.priority || a.rule.pattern.localeCompare(b.rule.pattern),
      )
      .map((r) => ({
        ...r.rule,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
  }

  /**
   * 建/改一条别名规则。
   *
   * 坏规则**拒掉**而不是「先存着再说」：一条非法的 prefix 规则进了路由，
   * 错误发生在请求路径上（客户端拿到一个莫名的 400 或者更糟——被路由到
   * 错误的 provider），而配置时的报错只要一行字。
   */
  async upsertAlias(
    actor: string,
    input: {
      id?: string;
      kind: 'exact' | 'prefix';
      pattern: string;
      target: { provider: string; access_path: string; model: string; max_context_tokens?: number };
      priority?: number;
      enabled?: boolean;
      note?: string;
    },
  ): Promise<{ ok: true; rule: AliasRuleDto } | { ok: false; errors: string[] }> {
    const now = this.deps.clock.now();
    const id = input.id ?? `alias_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const rule: AliasRule = {
      id,
      kind: input.kind,
      pattern: input.pattern,
      target: { ...input.target },
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      ...(input.note === undefined ? {} : { note: input.note }),
    };

    // 单条校验
    const single = validateAliasRule(rule);
    if (!single.ok) return { ok: false, errors: single.errors };

    // 与现有规则合在一起做整表校验（目标不冲突）
    const existing = (await this.listAliases()).filter((r) => r.id !== id);
    const merged: AliasRule[] = [
      ...existing.map((r) => ({
        id: r.id,
        kind: r.kind,
        pattern: r.pattern,
        target: r.target,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.note === undefined ? {} : { note: r.note }),
      })),
      rule,
    ];
    // AliasRuleDto 比 AliasRule 多 created_at/updated_at；灌给解析器只要前者
    const setValidation = validateAliasRuleSet(merged);
    if (!setValidation.ok) return { ok: false, errors: setValidation.errors };

    await this.deps.store.put(ALIAS_KIND, id, rule, now);

    // 热更新路由：让新规则立刻对请求路径生效（不等重启）
    this.deps.aliasResolver.setRules(merged);

    await this.audit(
      actor,
      existing.some((r) => r.id === id) ? 'alias.update' : 'alias.create',
      `alias/${id}`,
      'ok',
      `${rule.kind}:${rule.pattern} -> ${rule.target.access_path}/${rule.target.model}`,
    );
    return { ok: true, rule: { ...rule, created_at: now, updated_at: now } };
  }

  async deleteAlias(actor: string, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(ALIAS_KIND, id);
    if (deleted) {
      // 同步刷新路由
      const remaining = (await this.listAliases()).map((r) => ({
        id: r.id,
        kind: r.kind,
        pattern: r.pattern,
        target: r.target,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.note === undefined ? {} : { note: r.note }),
      }));
      this.deps.aliasResolver.setRules(remaining);
      await this.audit(actor, 'alias.delete', `alias/${id}`, 'ok');
    }
    return deleted;
  }

  /** 试解析（UI 预览用，不落库）。 */
  resolveAlias(model: string):
    | {
        source: 'exact' | 'namespace' | 'prefix' | 'passthrough';
        rule_id?: string;
        namespace?: string;
        target: { provider: string; access_path: string; model: string };
      }
    | undefined {
    const res = this.deps.aliasResolver.resolve(model, 'chat');
    if (res === undefined) return undefined;
    return {
      source: res.source,
      ...(res.rule === undefined ? {} : { rule_id: res.rule.id }),
      ...(res.namespace === undefined ? {} : { namespace: res.namespace.namespace }),
      target: {
        provider: res.target.provider,
        access_path: res.target.access_path,
        model: res.target.model,
      },
    };
  }

  /**
   * 把库里持久化的别名规则灌进解析器（启动时调），**并重算 namespace 规则**。
   *
   * 两件事必须一起做：namespace 规则同样来自存储（provider 配置），只灌别名会让
   * "重启后 `<ns>/<model>` 全部失效"——而这种失效在重启前是好的，极难归因。
   */
  async loadAliasesIntoResolver(): Promise<number> {
    const all = await this.listAliases();
    this.deps.aliasResolver.setRules(
      all.map((r) => ({
        id: r.id,
        kind: r.kind,
        pattern: r.pattern,
        target: r.target,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.note === undefined ? {} : { note: r.note }),
      })),
    );
    await this.refreshProviderRuntime();
    await this.loadRouteGraphsIntoRegistry();
    return all.length;
  }

  // ---- 路由图引擎（DAG + VM-JS + 服务商注入条件）----

  async loadRouteGraphsIntoRegistry(): Promise<number> {
    const all = await this.listRouteGraphs();
    this.deps.routeGraphs?.setGraphs(all);
    return all.length;
  }

  async listRouteGraphs(): Promise<RouteGraphDto[]> {
    const all = await this.deps.store.listDecrypted<RouteGraph>(ROUTE_GRAPH_KIND);
    return all
      .map((r) => ({
        ...r.value,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async getRouteGraph(id: string): Promise<RouteGraphDto | undefined> {
    const rec = await this.deps.store.get<RouteGraph>(ROUTE_GRAPH_KIND, id);
    if (rec === undefined) return undefined;
    return {
      ...rec,
      created_at: rec.created_at ?? this.deps.clock.now(),
      updated_at: rec.updated_at ?? this.deps.clock.now(),
    };
  }

  async upsertRouteGraph(
    actor: string,
    input: RouteGraphUpsertRequest,
  ): Promise<RouteGraphUpsertResponse> {
    const now = this.deps.clock.now();
    const existing = await this.getRouteGraph(input.id);
    const graph: RouteGraph = {
      id: input.id.trim(),
      label: input.label.trim(),
      enabled: input.enabled ?? true,
      entry_node_id: input.entry_node_id,
      nodes: input.nodes,
      edges: input.edges,
      ...(input.ability_mode === undefined ? {} : { ability_mode: input.ability_mode }),
      ...(input.abilities === undefined ? {} : { abilities: input.abilities }),
      ...(input.note === undefined ? {} : { note: input.note }),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    const validation = validateRouteGraph(graph);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }

    await this.deps.store.put(ROUTE_GRAPH_KIND, graph.id, graph, now);
    this.deps.routeGraphs?.upsert(graph);
    await this.audit(
      actor,
      existing === undefined ? 'route_graph.create' : 'route_graph.update',
      `route_graph/${graph.id}`,
      'ok',
      `nodes=${graph.nodes.length} edges=${graph.edges.length} enabled=${String(graph.enabled)}`,
    );
    return {
      ok: true,
      graph: {
        ...graph,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      },
    };
  }

  async deleteRouteGraph(actor: string, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(ROUTE_GRAPH_KIND, id);
    if (deleted) {
      this.deps.routeGraphs?.remove(id);
      await this.audit(actor, 'route_graph.delete', `route_graph/${id}`, 'ok');
    }
    return deleted;
  }

  async simulateRouteGraph(input: RouteGraphSimulateRequest): Promise<RouteGraphSimulateResponse> {
    let graph: RouteGraph | undefined;
    if (input.graph !== undefined) {
      graph = {
        id: input.graph.id,
        label: input.graph.label,
        enabled: input.graph.enabled ?? true,
        entry_node_id: input.graph.entry_node_id,
        nodes: input.graph.nodes,
        edges: input.graph.edges,
        ...(input.graph.note === undefined ? {} : { note: input.graph.note }),
      };
      const validation = validateRouteGraph(graph);
      if (!validation.ok) {
        return {
          ok: false,
          trace: [],
          error: validation.errors.join('；'),
        };
      }
    } else if (input.graph_id !== undefined) {
      graph = await this.getRouteGraph(input.graph_id);
      if (graph === undefined) {
        return { ok: false, trace: [], error: `路由图不存在: ${input.graph_id}` };
      }
    } else {
      return { ok: false, trace: [], error: '请提供 graph_id 或 graph 草稿' };
    }

    const parts: ChatPayload['messages'][number]['parts'] = [
      { type: 'text', text: input.request.prompt ?? 'Hello' },
    ];
    if (input.request.has_images === true) {
      parts.push({
        type: 'image',
        source: { kind: 'uri', uri: 'https://example.com/sample.png', mime: 'image/png' },
      });
    }
    const samplePayload: ChatPayload = {
      messages: [{ role: 'user', parts }],
      ...(input.request.system ? { system: [{ text: input.request.system }] } : {}),
      ...(input.request.has_tools === true
        ? {
            tools: [
              {
                type: 'function',
                name: 'sample_tool',
                parameters: { type: 'object', properties: {} },
              },
            ],
          }
        : {}),
      ...(input.request.thinking_enabled === true
        ? { params: { thinking: { enabled: true, effort: 'high' } } }
        : {}),
    };
    const canonical: CanonicalRequestEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      source_format: input.request.client_format ?? 'openai.chat',
      model: input.request.model ?? graph.id,
      payload: samplePayload,
      raw: {},
    };

    const result = evaluateRouteGraph(graph, {
      model: input.request.model ?? graph.id,
      modality: 'chat',
      stream: input.request.stream ?? false,
      client_format: input.request.client_format ?? 'openai.chat',
      canonical,
      ...(this.deps.routingTelemetry === undefined
        ? {}
        : { telemetryHub: this.deps.routingTelemetry }),
      capabilityRegistry: this.deps.capabilityRegistry,
      credentialResolver: this.deps.credentialResolver,
      simulation: {
        ...(input.request.has_images === undefined ? {} : { has_images: input.request.has_images }),
        ...(input.request.has_tools === undefined ? {} : { has_tools: input.request.has_tools }),
        ...(input.request.thinking_enabled === undefined
          ? {}
          : { thinking_enabled: input.request.thinking_enabled }),
        ...(input.request.estimated_tokens === undefined
          ? {}
          : { estimated_tokens: input.request.estimated_tokens }),
        ...(input.telemetry_overrides === undefined
          ? {}
          : { telemetry_overrides: input.telemetry_overrides }),
      },
    });

    if (!result.ok) {
      return {
        ok: false,
        trace: result.trace,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }

    return {
      ok: true,
      attempt_plan: result.candidates.map((a) => ({
        provider: a.provider,
        access_path: a.access_path,
        provider_format: a.provider_format,
        model: a.model,
        ...(a.route_node_id === undefined ? {} : { route_node_id: a.route_node_id }),
        ...(a.overrides === undefined ? {} : { overrides: a.overrides }),
      })),
      trace: result.trace,
    };
  }

  async getRoutingTelemetry(): Promise<RoutingTelemetryResponse> {
    const providers = await this.listProviders();
    const providerIds = Array.from(
      new Set([
        ...providers.map((p) => p.id),
        ...(this.deps.providerPresets?.map((p) => p.id) ?? []),
        ...(this.deps.routingTelemetry?.knownProviders?.() ?? []),
      ]),
    );
    const snapshots: Record<string, ProviderTelemetrySnapshotDto> =
      this.deps.routingTelemetry?.allSnapshots(providerIds) ?? {};
    const provider_options: Record<string, ProviderRoutingOptionSpecDto[]> = {};
    const provider_extensions: Record<
      string,
      import('../di/ports.js').ProviderExtensionPointSpec[]
    > = {};
    for (const p of providerIds) {
      const configured = providers.find((item) => item.id === p);
      const ap = configured ? accessPathIdForDialect(configured.id, configured.dialect) : undefined;
      provider_options[p] = this.deps.routingTelemetry?.optionsForProvider(p, ap) ?? [];
      provider_extensions[p] = this.deps.routingTelemetry?.extensionsForProvider?.(p, ap) ?? [];
    }
    return { snapshots, provider_options, provider_extensions };
  }

  async refreshRoutingTelemetry(provider?: string): Promise<RoutingTelemetryResponse> {
    if (this.deps.telemetryRefresher !== undefined) {
      await this.deps.telemetryRefresher(provider);
    }
    if (provider !== undefined && this.deps.routingTelemetry !== undefined) {
      const snap = this.deps.routingTelemetry.snapshotFor(provider);
      const providers = await this.listProviders();
      const configured = providers.find((item) => item.id === provider);
      const ap = configured
        ? accessPathIdForDialect(configured.id, configured.dialect)
        : undefined;
      return {
        snapshots: { [provider]: snap },
        provider_options: {
          [provider]: this.deps.routingTelemetry.optionsForProvider(provider, ap) ?? [],
        },
        provider_extensions: {
          [provider]: this.deps.routingTelemetry.extensionsForProvider?.(provider, ap) ?? [],
        },
      };
    }
    return this.getRoutingTelemetry();
  }

  // ---- 能力矩阵（只读，与 ir/capability.ts 同源）----

  /**
   * 能力矩阵（管理面「模型目录」页的数据源）。
   *
   * **不另写一份**：直接透出 `CapabilityRegistry` 里的 `CapabilityEntry`
   * （ir/capability.ts 的唯一定义）。另写一份就会出现「矩阵说支持、
   * 路由说不支持」的分裂，而那种 bug 只在线上才暴露。
   *
   * ## 部署态过滤（与 `/v1/models` 同源）
   *
   * 默认只列这个部署真调得通的条目，两条判据都在 catalog/visibility.ts，与
   * `ModelCatalog.list()` **共用同一个 `providerAvailability` 端口实例**：
   *
   * 1. provider 已配置（渠道表 / 凭据库任一命中）；
   * 2. 非内部脚手架（矩阵条目标了 `internal` 的 mock 路径）。
   *
   * 早先这里直通 `capabilityRegistry.list()`，两条判据一条都没过——数据面
   * （`/v1/models`）干净了，管理面仍列着 mock 与没配 key 的 provider，状态还全是
   * 绿色「可用」。管理员看到的口径必须和客户端一致，否则「按管理面的清单排查线上
   * 问题」这件事本身变成误导。
   *
   * `includeUnconfigured` / `includeInternal` 看全量（管理面调试时确实需要），
   * 与 `/v1/models` 的 `include_unconfigured` / `include_internal` 同名同义。
   * 全量模式下的未配置条目带 `availability: 'unconfigured'` 标记——**不许让一个
   * 调不通的条目看起来可用**。
   */
  listCapabilityMatrix(
    options: {
      modality?: string;
      includeUnconfigured?: boolean;
      includeInternal?: boolean;
    } = {},
  ): CapabilityMatrixItem[] {
    const visibility: CapabilityVisibilityDeps = {
      providerOf: this.deps.providerOfAccessPath ?? providerFromAccessPath,
      ...(this.deps.providerAvailability === undefined
        ? {}
        : { providerAvailability: this.deps.providerAvailability }),
    };
    const out: CapabilityMatrixItem[] = [];
    for (const entry of this.deps.capabilityRegistry.list()) {
      if (options.modality && entry.modality !== options.modality) {
        continue;
      }
      if (
        !capabilityEntryVisible(entry, visibility, {
          ...(options.includeUnconfigured === undefined
            ? {}
            : { includeUnconfigured: options.includeUnconfigured }),
          ...(options.includeInternal === undefined
            ? {}
            : { includeInternal: options.includeInternal }),
        })
      ) {
        continue;
      }
      const exposed = !this.hiddenModels.has(entry.model);
      const ns = this.deps.providerRuntime?.namespaceFor(visibility.providerOf(entry.access_path));
      const nsFields =
        ns !== undefined && ns !== ''
          ? { namespace: ns, namespaced_id: `${ns}/${entry.model}` }
          : {};
      const offline = enrichModelsWithCachedOrOfflineMetadata([{ id: entry.model }])[0];
      const metaFields: Partial<CapabilityMatrixItem> = {
        ...(entry.context_window === undefined && offline?.context_window !== undefined
          ? { context_window: offline.context_window }
          : {}),
        ...(entry.max_output_tokens === undefined && offline?.max_output_tokens !== undefined
          ? { max_output_tokens: offline.max_output_tokens }
          : {}),
        ...(entry.input_modalities === undefined &&
        offline?.input_modalities !== undefined &&
        offline.input_modalities.length > 0
          ? { input_modalities: offline.input_modalities }
          : {}),
        ...(entry.output_modalities === undefined &&
        offline?.output_modalities !== undefined &&
        offline.output_modalities.length > 0
          ? { output_modalities: offline.output_modalities }
          : {}),
        ...(offline?.reasoning !== undefined ? { reasoning: offline.reasoning } : {}),
      };
      const pricingFields: Partial<CapabilityMatrixItem> = {};
      if (this.deps.pricingService !== undefined) {
        const priced = this.deps.pricingService.price({
          ts: this.deps.clock.now(),
          model: entry.model,
          provider: visibility.providerOf(entry.access_path),
          access_path: entry.access_path,
          usage: { units: {}, source: 'provider' },
        });
        if (priced.price_snapshot !== null) {
          pricingFields.pricing = {
            currency: priced.price_snapshot.currency ?? 'USD',
            ...(priced.price_snapshot.tier ? { tier: priced.price_snapshot.tier } : {}),
            rates: priced.price_snapshot.rates,
          };
        }
      }
      // 全量模式下的未配置条目：显式标注，状态诚实（未配置 ≠ 可用）
      out.push(
        isConfiguredEntry(entry, visibility)
          ? { ...entry, ...metaFields, ...pricingFields, exposed, ...nsFields }
          : ({
              ...entry,
              ...metaFields,
              ...pricingFields,
              availability: 'unconfigured',
              exposed,
              ...nsFields,
            } satisfies CapabilityMatrixItem),
      );
    }

    // 补充路由图模型（与 /v1/models 同源，按 ability_mode 聚合候选目标能力）
    if (!options.modality || options.modality === 'chat') {
      const seenModels = new Set(out.map((item) => item.model));
      for (const graph of this.deps.routeGraphs?.list() ?? []) {
        if (!graph.enabled && !options.includeUnconfigured) continue;
        if (seenModels.has(graph.id)) continue;
        seenModels.add(graph.id);

        const targets = graph.nodes.filter(
          (n): n is Extract<RouteGraph['nodes'][number], { kind: 'provider_target' }> =>
            n.kind === 'provider_target',
        );
        const resolvedItems: CapabilityMatrixItem[] = [];
        for (const t of targets) {
          const found = out.find(
            (item) =>
              item.access_path === t.target.access_path &&
              (item.model === t.target.model || item.namespaced_id === t.target.model),
          );
          if (found !== undefined) resolvedItems.push(found);
        }

        const useMax = graph.ability_mode === 'max';
        const aggNum = (pick: (x: CapabilityMatrixItem) => number | undefined): number | undefined => {
          const vals = resolvedItems
            .map(pick)
            .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
          if (vals.length === 0) return undefined;
          return useMax ? Math.max(...vals) : Math.min(...vals);
        };
        const aggBool = (pick: (x: CapabilityMatrixItem) => boolean | undefined): boolean | undefined => {
          const vals = resolvedItems.map(pick).filter((v): v is boolean => v !== undefined);
          if (vals.length === 0) return undefined;
          return useMax ? vals.some(Boolean) : vals.length === resolvedItems.length && vals.every(Boolean);
        };
        const aggModals = (
          pick: (x: CapabilityMatrixItem) => readonly string[] | undefined,
        ): string[] | undefined => {
          const lists = resolvedItems
            .map(pick)
            .filter((v): v is readonly string[] => v !== undefined && v.length > 0);
          if (lists.length === 0) return undefined;
          if (useMax) return Array.from(new Set(lists.flat()));
          if (lists.length < resolvedItems.length) return ['text'];
          const common = lists[0]!.filter((m) => lists.every((l) => l.includes(m)));
          return common.length > 0 ? Array.from(new Set(common)) : ['text'];
        };

        let context_window = aggNum((x) => x.context_window);
        let max_output_tokens = aggNum((x) => x.max_output_tokens);
        let input_modalities = aggModals((x) => x.input_modalities) ?? ['text'];
        let output_modalities = aggModals((x) => x.output_modalities) ?? ['text'];
        let reasoning = aggBool((x) => x.reasoning);

        if (graph.ability_mode === 'custom' && graph.abilities !== undefined) {
          const c = graph.abilities;
          if (c.context_window !== undefined) context_window = c.context_window;
          if (c.max_output_tokens !== undefined) max_output_tokens = c.max_output_tokens;
          if (c.input_modalities !== undefined) input_modalities = [...c.input_modalities];
          if (c.output_modalities !== undefined) output_modalities = [...c.output_modalities];
          if (c.reasoning !== undefined) reasoning = c.reasoning;
        }

        const item: CapabilityMatrixItem = {
          access_path: 'router.graph',
          model: graph.id,
          modality: 'chat',
          streaming: { mode: 'sse' },
          usage_source: 'provider',
          contract_tested: true,
          status: 'implemented',
          ...(context_window === undefined ? {} : { context_window }),
          ...(max_output_tokens === undefined ? {} : { max_output_tokens }),
          input_modalities,
          output_modalities,
          ...(reasoning === undefined ? {} : { reasoning }),
          exposed: !this.hiddenModels.has(graph.id),
          ...(graph.enabled ? {} : { availability: 'unconfigured' as const }),
        };
        out.push(item);
      }
    }
    return out;
  }

  isModelHidden(modelId: string): boolean {
    return this.hiddenModels.has(modelId);
  }

  async setModelExposed(
    actor: string,
    model: string,
    exposed: boolean,
  ): Promise<{ ok: true; model: string; exposed: boolean }> {
    if (exposed) this.hiddenModels.delete(model);
    else this.hiddenModels.add(model);
    await this.deps.store.put('settings', `model_visibility:${model}`, { exposed });
    await this.audit(actor, 'model.visibility', `model/${model}`, 'ok', `exposed=${String(exposed)}`);
    return { ok: true, model, exposed };
  }

  // ---- 同步触发 ----

  async triggerSync(
    actor: string,
    kind: 'upstream_discovery' | 'offline_catalog_refresh',
  ): Promise<
    | { ok: true; result: { discovered: string[]; updated: string[]; added: string[] } }
    | { ok: false; error: string }
  > {
    if (kind === 'offline_catalog_refresh') {
      // 离线目录刷新 = 重新读仓库内静态定价/模型表，不联网。
      // Phase 1 的静态表是编译期内置的，没有"重新加载"动作；这里明确告知
      // 而不是假装做了一次同步。
      await this.audit(
        actor,
        'sync.offline_catalog',
        'catalog',
        'ok',
        '静态表编译期内置，无需刷新',
      );
      return {
        ok: false,
        error:
          '离线目录在 Phase 1 是编译期内置的（providers/deepseek/pricing.json 等），没有运行时刷新动作；请改用上游发现。',
      };
    }
    if (this.deps.metadataSync === undefined) {
      return { ok: false, error: '未注入元数据同步端口（modelDiscovery）' };
    }
    try {
      const result = await this.deps.metadataSync.refresh();
      const discovered = new Set(result.discovered);
      const updated = new Set(result.updated);
      const added = new Set(result.added);

      // 同步刷新在线 models.dev 缓存，并并行拉取各已启用渠道的 /models 元数据回填能力矩阵
      const onlinePromise = syncModelsWithOnlineModelsDev([]).catch(() => undefined);
      const providerModelsPort = this.deps.providerModels;
      const providerOf = this.deps.providerOfAccessPath ?? providerFromAccessPath;
      const enabledProviders =
        providerModelsPort !== undefined
          ? (await this.listProviders()).filter((p) => p.enabled && p.base_url !== '')
          : [];

      const [, channelResults] = await Promise.all([
        onlinePromise,
        Promise.allSettled(
          enabledProviders.map(async (p) => {
            const res = await providerModelsPort!.fetch({
              provider_id: p.id,
              dialect: p.dialect,
              base_url: p.base_url,
            });
            return { provider: p, res };
          }),
        ),
      ]);

      for (const settled of channelResults) {
        if (settled.status !== 'fulfilled') continue;
        const { provider, res } = settled.value;
        if (!res.ok) continue;

        const byId = new Map(res.models.map((m) => [m.id, m]));
        for (const m of res.models) discovered.add(m.id);

        for (const entry of this.deps.capabilityRegistry.list()) {
          if (providerOf(entry.access_path) !== provider.id) continue;
          const meta = byId.get(entry.model);
          if (meta === undefined) continue;

          const nextInputModalities = meta.input_modalities?.filter(
            (v): v is 'text' | 'image' => v === 'text' || v === 'image',
          );
          const nextOutputModalities = meta.output_modalities?.filter(
            (v): v is 'text' => v === 'text',
          );
          const nextEntry: CapabilityEntry = {
            ...entry,
            ...(meta.context_window !== undefined ? { context_window: meta.context_window } : {}),
            ...(meta.max_output_tokens !== undefined
              ? { max_output_tokens: meta.max_output_tokens }
              : {}),
            ...(nextInputModalities !== undefined && nextInputModalities.length > 0
              ? { input_modalities: nextInputModalities }
              : {}),
            ...(nextOutputModalities !== undefined && nextOutputModalities.length > 0
              ? { output_modalities: nextOutputModalities }
              : {}),
          };
          const changed =
            nextEntry.context_window !== entry.context_window ||
            nextEntry.max_output_tokens !== entry.max_output_tokens ||
            nextEntry.input_modalities?.join(',') !== entry.input_modalities?.join(',') ||
            nextEntry.output_modalities?.join(',') !== entry.output_modalities?.join(',');
          if (changed) {
            this.deps.capabilityRegistry.register(nextEntry);
            updated.add(entry.model);
          }
        }
      }

      const mergedResult = {
        discovered: [...discovered],
        updated: [...updated],
        added: [...added],
      };
      await this.audit(
        actor,
        'sync.upstream_discovery',
        'capability-matrix',
        'ok',
        `discovered=${mergedResult.discovered.length} updated=${mergedResult.updated.length} added=${mergedResult.added.length}`,
      );
      return { ok: true, result: mergedResult };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audit(actor, 'sync.upstream_discovery', 'capability-matrix', 'error', message);
      return { ok: false, error: message };
    }
  }

  // ---- 拉取上游模型清单（`POST /admin/api/provider-models`）----

  /**
   * 拉一次上游模型清单（**预览模式不落库**）。
   *
   * 为什么这条路必须存在：没有它，"新建渠道"就只能手打 model id——而上游的模型
   * 在迭代、窗口在调整，手写清单必然过期。带上 key 立刻能看到有哪些模型，是
   * 「连通性即拉取」：一次调用同时证明 key 有效、上游可达、清单到手。
   *
   * 安全边界与 `POST /credentials` 同级：
   *   - 预览模式的 key **只在这一次调用的内存里**，不进存储、不进日志、不进错误信息；
   *   - 审计只记 provider_id 与结果，**绝不记 key**；
   *   - 上游错误响应体先剥离 key 再进 `detail`（见 `redactDetail`）。
   */
  async fetchProviderModels(
    actor: string,
    input: ProviderModelsRequest,
  ): Promise<ProviderModelsResponse | ProviderModelsFailure> {
    const port = this.deps.providerModels;
    if (port === undefined) {
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: '未注入上游模型清单端口（modelDiscovery）',
        },
      };
    }
    const hasKey = typeof input.api_key === 'string' && input.api_key !== '';
    const hasProvider = typeof input.provider_id === 'string' && input.provider_id !== '';
    if (hasKey && hasProvider) {
      return {
        ok: false,
        error: { code: 'invalid_request', message: 'api_key 与 provider_id 二选一，不要同时给' },
      };
    }
    if (!hasKey && !hasProvider) {
      return {
        ok: false,
        error: { code: 'invalid_request', message: '请提供 api_key（预览）或 provider_id（已存）' },
      };
    }
    if (input.base_url === '' || !/^https?:\/\//.test(input.base_url)) {
      return {
        ok: false,
        error: { code: 'invalid_request', message: 'base_url 必须是 http(s):// 开头' },
      };
    }

    const result = await port.fetch(input);

    // 审计只记"谁对哪个渠道拉了一次、结果如何"，**绝不记 key**（请求体可能有 key）
    await this.audit(
      actor,
      'provider.models.fetch',
      hasProvider ? `provider/${input.provider_id}` : 'provider/(预览)',
      result.ok ? 'ok' : 'error',
      result.ok
        ? `models=${result.models.length} base_url_host=${safeHost(input.base_url)}`
        : `code=${result.error.code}${result.error.upstream_status === undefined ? '' : ` upstream=${result.error.upstream_status}`}`,
    );
    return result;
  }

  // ---- 用量 / 对账看板 ----

  async usageDashboard(fromTs?: number, toTs?: number): Promise<UsageDashboardResponse> {
    const now = this.deps.clock.now();
    const from = fromTs ?? now - 24 * 60 * 60 * 1000;
    const to = toTs ?? now;
    const records = this.deps.usageSource?.list(from, to) ?? [];

    const byModel = new Map<string, { request_count: number; cash_total: number }>();
    const byProvider = new Map<string, { request_count: number; cash_total: number }>();
    const byCredential = new Map<string, { request_count: number; cash_total: number }>();
    const byCurrency = new Map<
      string,
      { cash_total: number; as_api_total: number; requests: number }
    >();
    let input_tokens = 0;
    let output_tokens = 0;
    let cash_total = 0;
    let as_api_total = 0;
    let unpriced_count = 0;

    for (const r of records) {
      const currency = (r.cost.currency ?? r.price_snapshot?.currency ?? 'USD').toUpperCase();
      const cashUsd = toUsdAmount(r.cost.cash.total, currency);
      const asApiUsd = toUsdAmount(r.cost.as_api.total, currency);

      input_tokens += r.usage.units.tokens?.input_tokens ?? 0;
      output_tokens += r.usage.units.tokens?.output_tokens ?? 0;
      cash_total += cashUsd;
      as_api_total += asApiUsd;
      if (r.cost.status === 'unpriced' || r.cost.status === 'pending_price') unpriced_count += 1;

      const curBucket = byCurrency.get(currency) ?? {
        cash_total: 0,
        as_api_total: 0,
        requests: 0,
      };
      curBucket.cash_total += r.cost.cash.total;
      curBucket.as_api_total += r.cost.as_api.total;
      curBucket.requests += 1;
      byCurrency.set(currency, curBucket);

      const m = byModel.get(r.model) ?? { request_count: 0, cash_total: 0 };
      m.request_count += 1;
      m.cash_total += cashUsd;
      byModel.set(r.model, m);
      const p = byProvider.get(r.provider) ?? { request_count: 0, cash_total: 0 };
      p.request_count += 1;
      p.cash_total += cashUsd;
      byProvider.set(r.provider, p);
      const credKey = r.credential_id ?? UNATTRIBUTED_CREDENTIAL;
      const c = byCredential.get(credKey) ?? { request_count: 0, cash_total: 0 };
      c.request_count += 1;
      c.cash_total += cashUsd;
      byCredential.set(credKey, c);
    }

    const recent = records
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50)
      .map((r) => ({
        request_id: r.request_id,
        ts: r.ts,
        provider: r.provider,
        model: r.model,
        ...(r.model_alias === undefined ? {} : { model_alias: r.model_alias }),
        status: r.status,
        input_tokens: r.usage.units.tokens?.input_tokens ?? 0,
        output_tokens: r.usage.units.tokens?.output_tokens ?? 0,
        cash_total: toUsdAmount(
          r.cost.cash.total,
          r.cost.currency ?? r.price_snapshot?.currency,
        ),
        finish_reason: r.finish_reason,
        fast_path: r.fast_path,
      }));

    return {
      summary: {
        from_ts: from,
        to_ts: to,
        request_count: records.length,
        input_tokens,
        output_tokens,
        cash_total,
        as_api_total,
        by_currency: Object.fromEntries(byCurrency.entries()),
        unpriced_count,
        by_model: [...byModel].map(([model, v]) => ({ model, ...v })),
        by_provider: [...byProvider].map(([provider, v]) => ({ provider, ...v })),
        by_credential: [...byCredential].map(([credential, v]) => ({ credential, ...v })),
      },
      recent,
      ...(this.deps.reconciliationSource === undefined
        ? {}
        : { reconciliation: this.deps.reconciliationSource.latest() }),
    };
  }

  /**
   * 用量时间序列（趋势图的唯一数据来源）。
   *
   * **为什么不能只让前端自己切**：`usageDashboard` 的 `recent` 只回最近 50 条，
   * 拿它拼趋势等于用 5% 的样本画全貌；而 `summary` 是全区间合计，没有时间维度。
   * 于是「成本 / 请求量随时间怎么变」这个问题在契约里**没有答案**——这正是
   * 管理面用量页一直只能放汇总卡 + 最近记录的原因。这个端点补上这个维度。
   *
   * 切桶规则（与前端约定，避免两边各算一套边界）：
   *   - 桶宽由**调用方**给一档期望值（前端按 24h / 7d / 30d 选，见 `bucketMs`）；
   *     服务端再按 `ceil(span / bucketMs)` 推出桶数，最后用 `span / 桶数` 反算
   *     **实际**桶宽。这样桶永远严丝合缝地铺满 `[from, to)`——不会出现短一截的
   *     尾巴桶，也不会出现越过 `to` 的桶。
   *   - 桶数超过 `MAX_TIMESERIES_BUCKETS`（120）时按上限收紧：`effectiveMs` 变大，
   *     点变少，但铺满区间的性质不变。请求再长也不返回超过 120 个点。
   *   - 空桶照样返回（`request_count: 0`），前端画等距 x 轴不需要猜哪里缺数据。
   *
   * 安全性：只读聚合，不新增任何写入面；返回的字段与 `usageDashboard` 同一套
   * （无 header、无 key、无正文）。
   */
  async usageTimeseries(
    fromTs?: number,
    toTs?: number,
    bucketMs?: number,
  ): Promise<UsageTimeseriesResponse> {
    const now = this.deps.clock.now();
    const from = fromTs ?? now - 24 * 60 * 60 * 1000;
    const to = toTs ?? now;
    const source = this.deps.usageSource;

    // 未注入 usage 源（例如纯静态部署）：空序列 + available:false，
    // 前端据此显示"需请求日志"而不是画一条假的零线。
    if (source === undefined) {
      return { from_ts: from, to_ts: to, bucket_ms: 0, buckets: [], available: false };
    }

    return buildUsageTimeseries(source.list(from, to), from, to, bucketMs);
  }

  // ---- 余额探测 ----

  async probeBalance(): Promise<{
    ok: boolean;
    balances: UsageDashboardResponse['balance'];
    is_available: boolean;
    checked_at: number;
    error?: string;
  }> {
    const checked_at = this.deps.clock.now();
    if (this.deps.balanceProbe === undefined) {
      return {
        ok: false,
        balances: [],
        is_available: false,
        checked_at,
        error: '未注入余额探测端口（DeepSeekBalanceClient）',
      };
    }
    try {
      const snap = await this.deps.balanceProbe.probe();
      return {
        ok: true,
        balances: snap.balances,
        is_available: snap.is_available,
        checked_at,
      };
    } catch (err) {
      return {
        ok: false,
        balances: [],
        is_available: false,
        checked_at,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- 凭据健康探测 ----

  /**
   * 对某个 access path 打一次上游，看 key 还能不能用。
   *
   * 用 `/models`（GET）而不是发一条 chat：探测不该花 token，也不该在
   * 用量统计里留一条噪声记录。拿不到 `/models` 的 provider 退回「unknown」
   * 而不是「error」——分不清「key 坏了」和「这个上游没有 /models」。
   */
  async probeCredential(idOrAccessPath: string): Promise<{
    ok: boolean;
    status: 'ok' | 'error' | 'unknown';
    upstream_status?: number;
    message?: string;
    checked_at: number;
  }> {
    const checked_at = this.deps.clock.now();
    const credKey = `cred:${idOrAccessPath}`;
    const storedRec = await this.deps.store.get<{
      provider: string;
      access_path: string;
      secret?: string;
      env_ref?: string;
      note?: string;
      health: MaskedCredential['health'];
      last_checked?: number;
    }>(CRED_META_KIND, credKey);

    if (storedRec !== undefined) {
      const providerCfg = await this.getProvider(storedRec.provider);
      const baseUrl =
        providerCfg?.base_url ?? this.deps.credentialResolver.baseUrlFor(storedRec.access_path);
      const rawFormat =
        providerCfg?.dialect ?? this.deps.credentialResolver.formatFor(storedRec.access_path);
      const dialect: ProviderModelsRequest['dialect'] =
        rawFormat === 'anthropic.messages' ||
        rawFormat === 'openai.responses' ||
        rawFormat === 'gemini.generateContent'
          ? rawFormat
          : 'openai.chat';

      if (this.deps.providerModels !== undefined && !baseUrl.startsWith('http://127.0.0.1:1')) {
        let resolvedApiKey = storedRec.secret;
        if (resolvedApiKey === undefined && storedRec.env_ref !== undefined) {
          try {
            const ctx = systemProbeContext(this.deps.clock, storedRec.access_path);
            const creds = this.deps.credentialResolver.credentialsFor(storedRec.access_path);
            const targetCred = creds.find((c) => c.id === idOrAccessPath);
            const resolved = await this.deps.credentialResolver.headersFor(
              storedRec.access_path,
              ctx,
              targetCred,
            );
            const authVal =
              resolved.headers['authorization'] ??
              resolved.headers['x-api-key'] ??
              resolved.headers['x-goog-api-key'];
            if (authVal !== undefined) {
              resolvedApiKey = authVal.startsWith('Bearer ') ? authVal.slice(7) : authVal;
            }
          } catch {
            // Fall through to fetch() or credential_missing
          }
        }
        const result = await this.deps.providerModels.fetch({
          provider_id: storedRec.provider,
          base_url: baseUrl,
          dialect,
          ...(resolvedApiKey === undefined ? {} : { api_key: resolvedApiKey }), // privacy-scan: ignore —— 运行时变量，非硬编码密钥
        });
        const nextStatus: 'ok' | 'error' = result.ok ? 'ok' : 'error';
        await this.deps.store.put(CRED_META_KIND, credKey, {
          ...storedRec,
          health: nextStatus,
          last_checked: checked_at,
        });
        await this.syncCredentialsToResolver();
        return {
          ok: result.ok,
          status: nextStatus,
          ...(result.ok
            ? { message: `探测成功，上游返回 ${result.models.length} 个模型` }
            : {
                ...(result.error.upstream_status === undefined
                  ? {}
                  : { upstream_status: result.error.upstream_status }),
                message: result.error.message,
              }),
          checked_at,
        };
      }

      const ctx = systemProbeContext(this.deps.clock, storedRec.access_path);
      try {
        await this.deps.credentialResolver.headersFor(storedRec.access_path, ctx);
        await this.deps.store.put(CRED_META_KIND, credKey, {
          ...storedRec,
          health: 'unknown',
          last_checked: checked_at,
        });
        return {
          ok: true,
          status: 'unknown',
          checked_at,
          message: '凭据可解析；未配有效上游地址或探测端口',
        };
      } catch (err) {
        await this.deps.store.put(CRED_META_KIND, credKey, {
          ...storedRec,
          health: 'error',
          last_checked: checked_at,
        });
        return {
          ok: false,
          status: 'error',
          checked_at,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const ctx = systemProbeContext(this.deps.clock, idOrAccessPath);
    try {
      const headers: ResolvedHeaders = await this.deps.credentialResolver.headersFor(
        idOrAccessPath,
        ctx,
      );
      if (Object.keys(headers.headers).length === 0) {
        // 该 access path 不需要凭据（mock / local）
        return { ok: true, status: 'ok', checked_at, message: '该 access path 无需凭据' };
      }
      return {
        ok: true,
        status: 'unknown',
        checked_at,
        message: '凭据可解析；未发起真实上游探测（避免在用量统计里留噪声）',
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        checked_at,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 已登记的 access path 列表（UI 下拉用）。 */
  listAccessPaths(): Array<{ id: string; label: string; requires_credential: boolean }> {
    const seen = new Set<string>();
    const out: Array<{ id: string; label: string; requires_credential: boolean }> = [];
    const visDeps: CapabilityVisibilityDeps = {
      providerOf: this.deps.providerOfAccessPath ?? providerFromAccessPath,
      ...(this.deps.providerAvailability === undefined
        ? {}
        : { providerAvailability: this.deps.providerAvailability }),
    };
    for (const entry of this.deps.capabilityRegistry.list()) {
      if (seen.has(entry.access_path)) continue;
      const path = this.deps.credentialResolver.accessPath(entry.access_path);
      if (path?.requires_credential !== false && !isConfiguredEntry(entry, visDeps)) {
        continue;
      }
      seen.add(entry.access_path);
      out.push({
        id: entry.access_path,
        label: path?.label ?? entry.access_path,
        requires_credential: path?.requires_credential ?? true,
      });
    }
    for (const p of this.deps.providerRuntime?.entries() ?? []) {
      if (!p.enabled || seen.has(p.access_path)) continue;
      seen.add(p.access_path);
      const path = this.deps.credentialResolver.accessPath(p.access_path);
      out.push({
        id: p.access_path,
        label: path?.label ?? p.access_path,
        requires_credential: path?.requires_credential ?? true,
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 该 access path 上已登记的凭据（Resolver 视角，含 env 档）。 */
  credentialsForAccessPath(accessPath: string): UpstreamCredential[] {
    return this.deps.credentialResolver.credentialsFor(accessPath);
  }

  listEnvCredentialPaths(): Array<{ access_path: string; count: number }> {
    const seen = new Set<string>();
    const out: Array<{ access_path: string; count: number }> = [];
    const visDeps: CapabilityVisibilityDeps = {
      providerOf: this.deps.providerOfAccessPath ?? providerFromAccessPath,
      ...(this.deps.providerAvailability === undefined
        ? {}
        : { providerAvailability: this.deps.providerAvailability }),
    };
    for (const entry of this.deps.capabilityRegistry.list()) {
      if (seen.has(entry.access_path)) continue;
      if (!isConfiguredEntry(entry, visDeps)) {
        continue;
      }
      seen.add(entry.access_path);
      const count = this.deps.credentialResolver
        .credentialsFor(entry.access_path)
        .filter((c) => c.storage.location === 'env').length;
      if (count > 0) out.push({ access_path: entry.access_path, count });
    }
    return out.sort((a, b) => a.access_path.localeCompare(b.access_path));
  }

  // ---- 数据面 virtual key（66 §2）----

  /**
   * 列出一把 key 的 DTO。
   *
   * **绝不明文回显**：`maskVirtualKey` 只拿记录里的 `prefix`（明文前 8 位），
   * 而记录本身没有承载明文的字段（见 storage/virtual-keys.ts 的类型说明）。
   */
  private toDto(rec: VirtualKeyRecord): VirtualKeyDto {
    return {
      key_id: rec.key_id,
      name: rec.name,
      status: rec.status,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      masked: maskVirtualKey(rec.prefix),
      head: rec.prefix.slice(0, 8),
      ...(rec.note === undefined ? {} : { note: rec.note }),
      ...(rec.revoked_at === undefined ? {} : { revoked_at: rec.revoked_at }),
      ...(rec.expires_at === undefined ? {} : { expires_at: rec.expires_at }),
      ...(rec.models === undefined ? {} : { models: rec.models }),
      ...(rec.providers === undefined ? {} : { providers: rec.providers }),
      ...(rec.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: rec.allow_message_persistence }),
      ...(rec.allow_streaming === undefined ? {} : { allow_streaming: rec.allow_streaming }),
      ...(rec.allowed_plugins === undefined ? {} : { allowed_plugins: rec.allowed_plugins }),
      ...(rec.disabled_plugins === undefined ? {} : { disabled_plugins: rec.disabled_plugins }),
      ...(rec.allowed_modalities === undefined
        ? {}
        : { allowed_modalities: rec.allowed_modalities }),
      ...(rec.rate_limit === undefined ? {} : { rate_limit: rec.rate_limit }),
      ...(rec.budget_micros === undefined ? {} : { budget_micros: rec.budget_micros }),
      ...(rec.team_id === undefined ? {} : { team_id: rec.team_id }),
      ...(rec.user_id === undefined ? {} : { user_id: rec.user_id }),
    };
  }

  /**
   * 列出全部 virtual key（掩码 + 元数据）。
   *
   * 审计**不写**：读操作不留痕（与 `listCredentials` 同立场），否则审计日志
   * 会被每次刷新页面刷满。
   */
  async listVirtualKeys(): Promise<VirtualKeyDto[]> {
    if (this.deps.virtualKeys === undefined) return [];
    return (await this.deps.virtualKeys.list()).map((r) => this.toDto(r));
  }

  /**
   * 建一把新 key。**明文只在返回值里出现一次**。
   *
   * 审计只记 `key_id` 与名字，绝不记明文；`detail` 里连掩码都不给——
   * 掩码对审计没用（认不出是哪一把），而 `key_id` 已经唯一。
   */
  async createVirtualKey(
    actor: string,
    input: VirtualKeyCreateRequest,
  ): Promise<{ ok: true; key: VirtualKeyDto; plaintext: string } | { ok: false; error: string }> {
    if (this.deps.virtualKeys === undefined) {
      return { ok: false, error: '未装配虚拟 key 存储（recordStore）' };
    }
    const name = input.name.trim();
    if (name.length === 0) return { ok: false, error: 'name 不能为空' };
    if (input.models !== undefined && input.models.some((m) => m.trim().length === 0)) {
      return { ok: false, error: 'models 里不能有空串' };
    }
    if (input.providers !== undefined && input.providers.some((p) => p.trim().length === 0)) {
      return { ok: false, error: 'providers 里不能有空串' };
    }
    if (input.expires_at !== undefined && input.expires_at <= this.deps.clock.now()) {
      return { ok: false, error: 'expires_at 必须是未来的时间' };
    }

    const created = await this.deps.virtualKeys.create({
      name,
      created_by: actor,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
      ...(input.models === undefined ? {} : { models: input.models }),
      ...(input.providers === undefined ? {} : { providers: input.providers }),
      ...(input.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: input.allow_message_persistence }),
      ...(input.allow_streaming === undefined ? {} : { allow_streaming: input.allow_streaming }),
      ...(input.allowed_plugins === undefined ? {} : { allowed_plugins: input.allowed_plugins }),
      ...(input.disabled_plugins === undefined ? {} : { disabled_plugins: input.disabled_plugins }),
      ...(input.allowed_modalities === undefined
        ? {}
        : { allowed_modalities: input.allowed_modalities }),
      ...(input.rate_limit === undefined ? {} : { rate_limit: input.rate_limit }),
      ...(input.budget_micros === undefined ? {} : { budget_micros: input.budget_micros }),
      ...(input.team_id === undefined ? {} : { team_id: input.team_id }),
      ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
    });
    await this.audit(
      actor,
      'virtual_key.create',
      `virtual_key/${created.key_id}`,
      'ok',
      `name=${name}`,
    );
    return { ok: true, key: this.toDto(created.record), plaintext: created.plaintext };
  }

  /**
   * 撤销一把 key（记录保留，立刻不可用）。
   *
   * 「立刻」的保证来自 `DefaultVirtualKeyStore.invalidate()`：撤销会清掉校验
   * 缓存，下一个请求重新走 Argon2id 并发现记录已撤销。
   */
  async revokeVirtualKey(
    actor: string,
    keyId: string,
  ): Promise<{ ok: true; key: VirtualKeyDto } | { ok: false; error: string }> {
    if (this.deps.virtualKeys === undefined) {
      return { ok: false, error: '未装配虚拟 key 存储（recordStore）' };
    }
    const revoked = await this.deps.virtualKeys.revoke(keyId, this.deps.clock.now());
    if (revoked === undefined) {
      return { ok: false, error: 'key 不存在或已撤销' };
    }
    await this.audit(actor, 'virtual_key.revoke', `virtual_key/${keyId}`, 'ok');
    return { ok: true, key: this.toDto(revoked) };
  }

  async deleteVirtualKey(actor: string, keyId: string): Promise<boolean> {
    if (this.deps.virtualKeys === undefined) return false;
    const deleted = await this.deps.virtualKeys.delete(keyId);
    if (deleted) await this.audit(actor, 'virtual_key.delete', `virtual_key/${keyId}`, 'ok');
    return deleted;
  }

  async updateVirtualKey(
    actor: string,
    keyId: string,
    patch: VirtualKeyUpdateRequest,
  ): Promise<{ ok: true; key: VirtualKeyDto } | { ok: false; error: string }> {
    if (this.deps.virtualKeys === undefined) {
      return { ok: false, error: '未装配虚拟 key 存储（recordStore）' };
    }
    if (this.deps.virtualKeys.update === undefined) {
      return { ok: false, error: '当前虚拟 key 存储不支持编辑权限' };
    }
    if (patch.name !== undefined && patch.name.trim() === '') {
      return { ok: false, error: 'name 不能为空' };
    }
    const updated = await this.deps.virtualKeys.update(
      keyId,
      {
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.note === undefined ? {} : { note: patch.note }),
        ...(patch.expires_at === undefined ? {} : { expires_at: patch.expires_at }),
        ...(patch.models === undefined ? {} : { models: patch.models }),
        ...(patch.providers === undefined ? {} : { providers: patch.providers }),
        ...(patch.allow_message_persistence === undefined
          ? {}
          : { allow_message_persistence: patch.allow_message_persistence }),
        ...(patch.allow_streaming === undefined ? {} : { allow_streaming: patch.allow_streaming }),
        ...(patch.allowed_plugins === undefined ? {} : { allowed_plugins: patch.allowed_plugins }),
        ...(patch.disabled_plugins === undefined
          ? {}
          : { disabled_plugins: patch.disabled_plugins }),
        ...(patch.allowed_modalities === undefined
          ? {}
          : { allowed_modalities: patch.allowed_modalities }),
        ...(patch.rate_limit === undefined ? {} : { rate_limit: patch.rate_limit }),
        ...(patch.budget_micros === undefined ? {} : { budget_micros: patch.budget_micros }),
        ...(patch.team_id === undefined ? {} : { team_id: patch.team_id }),
        ...(patch.user_id === undefined ? {} : { user_id: patch.user_id }),
      },
      this.deps.clock.now(),
    );
    if (updated === undefined) {
      return { ok: false, error: 'key 不存在' };
    }
    await this.audit(actor, 'virtual_key.update', `virtual_key/${keyId}`, 'ok');
    return { ok: true, key: this.toDto(updated) };
  }

  // ---- 插件中心（Dogfooding）----

  async loadPluginStates(): Promise<void> {
    if (this.deps.pluginHost === undefined) return;
    const saved = await this.deps.store.listDecrypted<{
      enabled?: boolean;
      mount_targets?: Array<'agent' | 'data_plane'>;
      config?: Record<string, unknown>;
    }>(PLUGIN_STATE_KIND);
    for (const rec of saved) {
      if (rec.value.enabled !== undefined) {
        this.deps.pluginHost.setEnabled(rec.id, rec.value.enabled);
      }
      if (rec.value.mount_targets !== undefined) {
        this.deps.pluginHost.setMountTargets?.(rec.id, rec.value.mount_targets);
      }
      if (rec.value.config !== undefined) {
        await this.deps.pluginHost.setConfig?.(rec.id, rec.value.config);
      }
    }
  }

  async listPlugins(): Promise<PluginsListResponse> {
    const snapshots = this.deps.pluginHost?.listPluginSnapshots?.() ?? [];
    const logs = this.deps.pluginHost?.listLogs?.({ limit: 150 }) ?? [];
    let enabledAgentTools: Set<string> | undefined;
    if (this.deps.settings !== undefined) {
      const settingsRes = await this.listSettings();
      const s = settingsRes.items.find((item) => item.id === 'agent_tools');
      if (s && Array.isArray(s.value)) {
        enabledAgentTools = new Set(
          (s.value as unknown[]).filter((x): x is string => typeof x === 'string'),
        );
      }
    }
    const items: PluginInfoDto[] = snapshots.map(({ tools: snapTools, ...restSnap }) => ({
      ...restSnap,
      ...(snapTools === undefined
        ? {}
        : {
            tools: snapTools.map((t) => ({
              name: t.name,
              label: t.label,
              category: t.category,
              description: t.description,
              ...(t.requires_confirmation ? { requires_confirmation: true } : {}),
              enabled:
                restSnap.name === 'agent-admin' && enabledAgentTools !== undefined
                  ? enabledAgentTools.has(t.name)
                  : true,
            })),
          }),
    }));
    return { items, logs };
  }

  async updatePlugin(
    actor: string,
    name: string,
    patch: PluginUpdateRequest,
  ): Promise<{ ok: true; plugin: PluginInfoDto } | { ok: false; error: string }> {
    const host = this.deps.pluginHost;
    if (host === undefined) {
      return { ok: false, error: '未装配插件宿主' };
    }
    const existing = host.listPluginSnapshots?.().find((p) => p.name === name);
    if (existing === undefined) {
      return { ok: false, error: `插件 ${name} 不存在` };
    }
    if (patch.enabled !== undefined) {
      host.setEnabled(name, patch.enabled);
    }
    if (patch.mount_targets !== undefined) {
      host.setMountTargets?.(name, patch.mount_targets);
    }
    if (patch.config !== undefined) {
      await host.setConfig?.(name, patch.config);
    }
    if (patch.enabled_tools !== undefined && name === 'agent-admin' && this.deps.settings !== undefined) {
      const res = await this.updateSetting(actor, 'agent_tools', patch.enabled_tools);
      if (!res.ok) return { ok: false, error: res.error };
    }

    const updatedSnap = host.listPluginSnapshots?.().find((p) => p.name === name) ?? existing;
    await this.deps.store.put(
      PLUGIN_STATE_KIND,
      name,
      {
        enabled: updatedSnap.enabled,
        mount_targets: updatedSnap.mount_targets,
        config: updatedSnap.config,
      },
      this.deps.clock.now(),
    );
    await this.audit(
      actor,
      'plugin.update',
      `plugin/${name}`,
      'ok',
      `enabled=${String(updatedSnap.enabled)} targets=${updatedSnap.mount_targets.join(',')}`,
    );
    const list = await this.listPlugins();
    const item = list.items.find((p) => p.name === name);
    return { ok: true, plugin: item ?? { ...updatedSnap, tools: undefined } };
  }

  async clearPluginLogs(actor: string, plugin?: string): Promise<void> {
    this.deps.pluginHost?.clearLogs?.(plugin);
    await this.audit(actor, 'plugin.clear_logs', `plugin/${plugin ?? 'all'}`, 'ok');
  }

  /** 该 key 的用量（按 `key_id` 归因；P0-6 的按 key 分组先落在这里）。 */
  async virtualKeyUsage(keyId: string, fromTs?: number, toTs?: number): Promise<VirtualKeyUsage> {
    const now = this.deps.clock.now();
    const from = fromTs ?? now - 24 * 60 * 60 * 1000;
    const to = toTs ?? now;
    const records = (this.deps.usageSource?.list(from, to) ?? []).filter(
      (r) => r.auth?.key_id === keyId,
    );
    const byModel = new Map<string, { request_count: number; cash_total: number }>();
    const byProvider = new Map<string, { request_count: number; cash_total: number }>();
    let input_tokens = 0;
    let output_tokens = 0;
    let cash_total = 0;
    let error_count = 0;
    for (const r of records) {
      const currency = r.cost.currency ?? r.price_snapshot?.currency;
      const cashUsd = toUsdAmount(r.cost.cash.total, currency);
      input_tokens += r.usage.units.tokens?.input_tokens ?? 0;
      output_tokens += r.usage.units.tokens?.output_tokens ?? 0;
      cash_total += cashUsd;
      if (r.status !== 'success') error_count += 1;
      const m = byModel.get(r.model) ?? { request_count: 0, cash_total: 0 };
      m.request_count += 1;
      m.cash_total += cashUsd;
      byModel.set(r.model, m);
      const p = byProvider.get(r.provider) ?? { request_count: 0, cash_total: 0 };
      p.request_count += 1;
      p.cash_total += cashUsd;
      byProvider.set(r.provider, p);
    }
    return {
      key_id: keyId,
      from_ts: from,
      to_ts: to,
      request_count: records.length,
      error_count,
      input_tokens,
      output_tokens,
      cash_total,
      by_model: [...byModel].map(([model, v]) => ({ model, ...v })),
      by_provider: [...byProvider].map(([provider, v]) => ({ provider, ...v })),
    };
  }

  /**
   * 当前数据面认证模式（虚拟 key / access token / permissive / deny；
   * 互斥与 deny-first 语义见 auth/data-plane.ts）。
   */
  async describeDataPlaneAuth(): Promise<AuthModeResponse> {
    if (this.deps.dataPlaneAuth === undefined) {
      // 没注入鉴权器 = 什么都没配。**报 deny 而不是 permissive**：那样界面会告诉
      // 运维「谁都能进」，而实际语义已经改成「整个关掉」——状态不能撒谎。
      return {
        mode: 'deny',
        virtual_key_count: (await this.deps.virtualKeys?.count()) ?? 0,
        virtual_keys_enabled: false,
        access_token_configured: false,
        ignored: [],
      };
    }
    return this.deps.dataPlaneAuth.describe();
  }

  // ---- 运行时设置（P0-2）----

  async listSettings(): Promise<SettingsListResponse> {
    if (this.deps.settings === undefined) {
      return { items: [] };
    }
    const described = await this.deps.settings.describe();
    return {
      items: described.items.map(toSettingDto),
      ...(described.config_file_path === undefined
        ? {}
        : { config_file_path: described.config_file_path }),
    };
  }

  /**
   * 改一个设置。审计只记设置项 id 与新值（**设置值不是敏感值**，记下来才有对账价值）；
   * env 锁命中时记 `error` 并原样带回原因。
   */
  async updateSetting(
    actor: string,
    key: string,
    value: unknown,
  ): Promise<{ ok: true; item: SettingDto } | { ok: false; status: 400 | 409; error: string }> {
    if (this.deps.settings === undefined) {
      return { ok: false, status: 400, error: '未装配设置服务（recordStore）' };
    }
    const result = await this.deps.settings.update(actor, key, value);
    if (!result.ok) {
      await this.audit(actor, 'setting.update', `setting/${key}`, 'error', result.error);
      return { ok: false, status: result.status, error: result.error };
    }
    await this.audit(
      actor,
      'setting.update',
      `setting/${key}`,
      'ok',
      `value=${String(result.item.value)} source=${result.item.source}`,
    );
    return { ok: true, item: toSettingDto(result.item) };
  }

  /**
   * 恢复默认：删掉加密存储里的那条记录，让值沿四层回落。
   *
   * 与「把默认值写进去」的区别：后者会让来源永远显示「已修改」，部署者从此分不清
   * 哪项是自己改的。删记录后来源回到 env / 配置文件 / 默认，界面据此如实展示。
   */
  async resetSetting(
    actor: string,
    key: string,
  ): Promise<{ ok: true; item: SettingDto } | { ok: false; status: 400 | 409; error: string }> {
    if (this.deps.settings === undefined) {
      return { ok: false, status: 400, error: '未装配设置服务（recordStore）' };
    }
    const result = await this.deps.settings.reset(actor, key);
    if (!result.ok) {
      await this.audit(actor, 'setting.reset', `setting/${key}`, 'error', result.error);
      return { ok: false, status: result.status, error: result.error };
    }
    await this.audit(
      actor,
      'setting.reset',
      `setting/${key}`,
      'ok',
      `value=${String(result.item.value)} source=${result.item.source}`,
    );
    return { ok: true, item: toSettingDto(result.item) };
  }

  async listSecretRefs(): Promise<SecretRefDto[]> {
    if (this.deps.settings === undefined) return [];
    return this.deps.settings.listSecretRefs();
  }

  /**
   * 登记一个敏感值引用（只存 `env:<VAR>`）。
   *
   * 传入 `value` 会被设置服务 400 拒绝；这里再兜一道：绝不把 value 塞进审计。
   */
  async registerSecretRef(
    actor: string,
    input: SecretRefCreateRequest & { value?: unknown },
  ): Promise<{ ok: true; ref: SecretRefDto } | { ok: false; status: 400; error: string }> {
    if (this.deps.settings === undefined) {
      return { ok: false, status: 400, error: '未装配设置服务（recordStore）' };
    }
    const result = await this.deps.settings.registerSecretRef({
      name: input.name,
      env_var: input.env_var,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.value === undefined ? {} : { value: input.value }),
    });
    if (!result.ok) {
      await this.audit(
        actor,
        'secret_ref.create',
        `secret_ref/${input.name}`,
        'error',
        result.error,
      );
      return { ok: false, status: result.status, error: result.error };
    }
    await this.audit(
      actor,
      'secret_ref.create',
      `secret_ref/${input.name}`,
      'ok',
      `ref=${result.ref.ref}`,
    );
    return { ok: true, ref: result.ref };
  }

  async deleteSecretRef(actor: string, name: string): Promise<boolean> {
    if (this.deps.settings === undefined) return false;
    const deleted = await this.deps.settings.deleteSecretRef(name);
    if (deleted) await this.audit(actor, 'secret_ref.delete', `secret_ref/${name}`, 'ok');
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * `SettingDescription`（config/settings.ts 的内部形状，字段叫 `key`）→ `SettingDto`
 * （HTTP 契约，字段叫 `id`）。
 *
 * **显式逐字段映射，不用 `{...s}`**：契约字段与内部字段不同名，展开会把内部的
 * `key` 一起带进响应——那正是前端脱敏守卫误拦设置页的字段。逐字段列出来，
 * 将来契约加字段时漏映射会直接编译报错，不会静默少一个字段。
 */
function toSettingDto(s: SettingDescription): SettingDto {
  return {
    id: s.key,
    label: s.label,
    description: s.description,
    unit: s.unit,
    type: s.type,
    group: s.group,
    value: s.value,
    source: s.source,
    editable: s.editable,
    ...(s.reason === undefined ? {} : { reason: s.reason }),
    ...(s.env_var === undefined ? {} : { env_var: s.env_var }),
    ...(s.range === undefined ? {} : { range: s.range }),
    ...(s.options === undefined ? {} : { options: s.options }),
    ...(s.default_value === undefined ? {} : { default_value: s.default_value }),
    ...(s.stored_value === undefined ? {} : { stored_value: s.stored_value }),
    ...(s.updated_at === undefined ? {} : { updated_at: s.updated_at }),
    ...(s.updated_by === undefined ? {} : { updated_by: s.updated_by }),
  };
}

/** 系统探针用的最小 RequestContext（同 composition-root.ts 的 systemProbeCtx）。 */
function systemProbeContext(
  clock: Clock,
  accessPath: string,
): Parameters<CredentialResolver['headersFor']>[1] {
  const now = clock.now();
  return {
    request_id: 'req_admin_probe',
    started_at: now,
    deadline: now + 30_000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'admin' },
    route: {
      access_path: accessPath,
      provider: providerFromAccessPath(accessPath),
      provider_format: 'openai.chat',
      model: 'probe',
      full_model_id: `${accessPath}/probe`,
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'openai.chat',
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    warn: () => {},
  } as unknown as Parameters<CredentialResolver['headersFor']>[1];
}

/**
 * 审计 detail 的兜底脱敏。
 *
 * 各调用点已经只传构造好的字符串；这里是**最后一道防线**——万一有人把
 * 请求体整体传进来，也不至于把 key 写进审计日志。规则与 65 §6.1 的硬编码
 * 黑名单同立场：疑似 key 的串（`sk-` / `sk-ant-` / `AIza` 前缀 + 长度）整段替换。
 */
export function redactDetail(detail: string): string {
  return detail
    .replace(/\b(sk|sk-ant|AIza|ghp_|xoxb)-[A-Za-z0-9_-]{8,}\b/g, '<REDACTED:key>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<REDACTED:jwt>')
    .replace(/(password|passphrase|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=<REDACTED>');
}

// ---------------------------------------------------------------------------
// provider 配置的归一化小工具
// ---------------------------------------------------------------------------

/**
 * 服务端工具默认开关归一化：只认两个 canonical 稳定名，且**显式写成 false**。
 *
 * 为什么显式写 false 而不是省略：省略在 JSON 里等于"这个键不存在"，前端与
 * `builtinToolsFor()` 都要多判一次；写成 false 之后「关」是一个明确的状态，
 * 和「没配过」在存储里可区分（对账时看得见是谁关的）。
 */
export function normalizeBuiltinToolDefaults(
  input: ProviderBuiltinToolDefaults | undefined,
): ProviderBuiltinToolDefaults {
  return {
    web_search: input?.web_search === true,
    url_context: input?.url_context === true,
  };
}

/**
 * base_url → host（**只取 host，不带 path / query / 用户信息**）。
 *
 * 用途：审计日志里要能看出"这次拉取打的是哪个上游"，而完整 URL 可能带 token
 * 形式的查询串。host 不足以泄露任何凭据。
 */
export function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '(invalid)';
  }
}

/** 浅拷贝（capability_overrides 是纯 JSON；不用 structuredClone 以保持 Node 18 兼容）。 */
function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hydrateProviderModelMetadata(provider: ProviderConfig): ProviderConfig {
  if (provider.model_source.kind !== 'static' || provider.model_source.models.length === 0) {
    return provider;
  }
  const saved = provider.model_metadata ?? {};
  const inputs: UpstreamModelDto[] = provider.model_source.models.map((id) => saved[id] ?? { id });
  const enriched = enrichModelsWithCachedOrOfflineMetadata(inputs);
  const nextMeta: Record<string, UpstreamModelDto> = {};
  for (const m of enriched) {
    nextMeta[m.id] = m;
  }
  return {
    ...provider,
    model_metadata: nextMeta,
  };
}

function isImageOnlyModel(id: string, meta?: UpstreamModelDto): boolean {
  if (meta?.category === 'image') return true;
  if (meta?.output_modalities?.includes('image') && !meta.output_modalities.includes('text')) {
    return true;
  }
  return /(dall-e|gpt-image|chatgpt-image|imagen|wanx|imagine-image|image-generation|image-preview|\bflux\b|\bsdxl\b|-image\b)/i.test(
    id,
  );
}

function isEmbeddingOnlyModel(id: string, meta?: UpstreamModelDto): boolean {
  if (meta?.category === 'embedding') return true;
  return /(^|[-_/.])(embed|embedding|embeddings|bge)([-_/.]|$)/i.test(id);
}

function isVideoOnlyModel(id: string, meta?: UpstreamModelDto): boolean {
  if (meta?.category === 'video') return true;
  return /(^sora\b|^veo\b|^kling\b|imagine-video|-video\b)/i.test(id);
}

function findPresetTransportHints(
  presets: readonly ProviderPreset[],
  providerId: string,
  dialect: string,
  baseUrl: string,
): import('../ir/credential.js').AccessPathTransportHints | undefined {
  const normBase = baseUrl.replace(/\/+$/, '');
  for (const preset of presets) {
    for (const ap of preset.access_paths) {
      if (ap.transport_hints === undefined) continue;
      if (
        (preset.id === providerId || providerId.startsWith(`${preset.id}-`)) &&
        ap.dialect === dialect
      ) {
        return ap.transport_hints;
      }
      if (ap.base_url.replace(/\/+$/, '') === normBase && ap.dialect === dialect) {
        return ap.transport_hints;
      }
    }
  }
  return undefined;
}
