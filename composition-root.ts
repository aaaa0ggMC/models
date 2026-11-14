/**
 * composition-root.ts —— 组合根：全仓库唯一的装配处。
 *
 * 架构强制要求（任务书）：整体采用 Dependency Injection，每个能力定义接口、具体实现经
 * **构造函数注入**；设组合根统一装配，测试里可替换任一依赖；禁止模块级单例、禁止跨模块
 * 直接 import 具体实现、禁止隐式全局状态。
 *
 * 本文件就是那条禁令的**唯一例外**：它是全仓库唯一"知道所有具体实现"的地方。
 * 其他模块只 import 接口（ir/ 里的类型 + 各模块的 * types.ts / host.ts / emitter.ts）。
 *
 * D-fastpath-2 的准入条件在这里计算并缓存：`createFastPathAdmission(pluginHost)` 启动时
 * 创建一次，插件增减时由 PluginHost 广播 onChange 自动失效重算。
 */

import { Container, TOKENS } from './di/index.js';
import {
  ConsoleLogger,
  MemoryLogger,
  MemoryMetrics,
  NoopMetrics,
  SequentialIdGenerator,
  UlidIdGenerator,
  loadConfigFromEnv,
  systemClock,
  type Clock,
  type GatewayConfig,
  type IdGenerator,
  type Logger,
  type Metrics,
} from './di/index.js';
import { createAdaptorRegistry } from './adaptors/index.js';
import { EnvCredentialResolver, DEFAULT_ACCESS_PATHS } from './credentials/resolver.js';
import type { CredentialResolver } from './credentials/resolver.js';
import { InMemoryCapabilityRegistry } from './credentials/capability-registry.js';
import {
  createDeepSeekProfile,
  deepseekCapabilities,
  deepseekRouteAliases,
  DEEPSEEK_ACCESS_PATH_IDS,
  DeepSeekModelDiscovery,
  createDeepSeekPricingService,
  DeepSeekBalanceClient,
} from './providers/deepseek/index.js';
import type {
  DeepSeekModelsResponse,
  DiscoveryRefreshResult,
  PricingService,
} from './providers/deepseek/index.js';
import type { ProviderProfileRegistry } from './di/index.js';
import { InMemoryProviderProfileRegistry } from './di/index.js';
import { DefaultPluginHost } from './plugins/host.js';
import type { PluginHost } from './plugins/host.js';
import type { GatewayServices, KVNamespace, Plugin, RequestContext } from './ir/index.js';
import { MemoryUsageEmitter, MemoryUsageSink } from './metering/index.js';
import type { UsageEmitter, UsageSink } from './metering/index.js';
import { ScriptedTransport } from './gateway-core/transport.js';
import type { Transport } from './gateway-core/transport.js';
import { StaticRouter, NOOP_ROUTE_HOOKS } from './gateway-core/router.js';
import type { RouteTable } from './gateway-core/router.js';
import { PipelineRunner } from './gateway-core/pipeline/runner.js';
import { createFastPathAdmission } from './gateway-core/pipeline/fast-path.js';
import type { FastPathAdmission } from './gateway-core/pipeline/fast-path.js';
import type { CapabilityEntry } from './ir/index.js';
import { DefaultAliasResolver, defaultAliasRules } from './admin/aliases.js';
import { AdminService } from './admin/service.js';
import { DefaultAdminAuth } from './admin/auth.js';
import { createAdminRouter } from './admin/routes.js';
import { createStaticAssetsHandler } from './admin/static.js';

export interface GatewayOptions {
  /** 覆盖配置（测试用）。缺省从环境变量读。 */
  config?: Partial<GatewayConfig>;
  /** 覆盖时钟。 */
  clock?: Clock;
  logger?: Logger;
  metrics?: Metrics;
  ids?: IdGenerator;
  /** 覆盖 transport。传 ScriptedTransport 即可不起真实 API 跑端到端。 */
  transport?: Transport;
  /** 覆盖 usage sink。 */
  usageSink?: UsageSink;
  /** 要注册的插件。 */
  plugins?: Array<{ plugin: Plugin; config?: unknown }>;
  /** 路由表（别名 → attempt）。 */
  routeTable?: RouteTable;
  /** 能力矩阵条目。 */
  capabilities?: CapabilityEntry[];
  /** 凭据解析器。 */
  credentialResolver?: CredentialResolver;
  /** provider profile 注册表（默认装配 DeepSeek；测试可替换）。 */
  providerProfiles?: ProviderProfileRegistry;
  /**
   * 别名解析器（可选）：注入后 S2 按「显式别名 > 前缀规则 > 原样 model id」
   * 三级优先级解析客户端模型名（见 admin/aliases.ts）。不注入 = 纯静态
   * RouteTable 查表，行为与注入前完全一致。
   */
  aliasResolver?: import('./admin/aliases.js').AliasResolver;
  /**
   * 加密记录存储（可选）：注入后管理面（admin/）才有地方存凭据/别名/审计。
   * 不注入 = 管理面仍可起来，但所有存储操作报"未装配"。
   */
  recordStore?: import('./storage/record-store.js').EncryptedRecordStore;
  /** 已解锁的密钥库（可选；管理面密钥状态展示用）。 */
  keystore?: { status(): import('./admin/api-types.js').KeystoreStatusResponse };
  /** 元数据同步端口（可选；管理面的"同步触发"按钮用）。 */
  metadataSync?: import('./admin/service.js').MetadataSyncPort;
  /** 余额探测端口（可选；管理面的"余额探测"按钮用）。 */
  balanceProbe?: import('./admin/service.js').BalanceProbePort;
  /** usage 记录源（可选；管理面看板用）。 */
  usageSource?: import('./admin/service.js').UsageRecordSource;
  /** 对账记录源（可选；管理面看板用）。 */
  reconciliationSource?: import('./admin/service.js').ReconciliationSource;
  /** 管理面静态资源根目录（webui/admin/）。 */
  adminStaticRoot?: string;
  /** 管理面单 access token（66 §2.2 同款；不传则只接受口令登录）。 */
  adminAccessToken?: string;
  /** 初始别名规则（缺省用 admin/aliases.ts 的内置兜底）。 */
  aliasRules?: import('./admin/aliases.js').AliasRule[];
  /**
   * 模型发现（可选）：注入后 `gateway.refreshModelCapabilities()` 会用 `/models`
   * 的实时元数据刷新能力矩阵（窗口/模态/effort/上游约束）。不注入 = 只用静态表。
   */
  modelDiscovery?: DeepSeekModelDiscovery;
  /**
   * 定价服务（可缺省）：S10 在请求完成时按当时可得价格算 cost 并快照固化。
   * 缺省注入 DeepSeek 实现（读仓库内 pricing.json；查不到价格的模型记
   * pending_price / unpriced，不影响主链路）。测试可整体替换。
   */
  pricingService?: PricingService;
  /** 用内存实现还是生产实现（logger/metrics/ids/transport 的默认值）。 */
  mode?: 'production' | 'test';
}

export interface Gateway {
  container: Container;
  config: GatewayConfig;
  runner: PipelineRunner;
  pluginHost: PluginHost;
  fastPathAdmission: FastPathAdmission;
  usageEmitter: UsageEmitter;
  transport: Transport;
  /** 测试替身：内存 sink（mode === "test" 时非 undefined）。 */
  usageSink?: MemoryUsageSink;
  logger: Logger;
  metrics: Metrics;
  /**
   * 用 `/models` 的实时元数据刷新能力矩阵（需注入 modelDiscovery）。
   *
   * 典型用法：HTTP 服务启动后调一次（失败只记日志不影响服务——静态表已经可用），
   * 或按周期调。返回本次发现的结果（新增/刷新了哪些条目）。
   */
  refreshModelCapabilities(): Promise<DiscoveryRefreshResult | undefined>;
  /** 最近一次成功发现的 /models 原始响应（未发现过 = undefined）。 */
  lastModelDiscovery?: DeepSeekModelsResponse;
  /**
   * DeepSeek 余额客户端（对账真值源：`GET /user/balance`）。
   *
   * 用途：a) 区间对账（余额差 vs 我们估算的 cash，见 metering/reconciliation.ts）；
   * b) 低余额信号（配合 Plan 感知路由优先走订阅路径）；c) 请求前预检。
   * 注意 DeepSeek **赠送余额优先扣**，余额差不等于现金支出。
   */
  balanceClient: DeepSeekBalanceClient;
  /**
   * 管理面（控制平面）装配。没传 `recordStore` 等 admin option 时为 undefined——
   * 此时网关没有管理面，`createHttpServer` 也不需要挂 `adminHandler`。
   */
  admin?: AdminAssembly;
  /** 优雅退出：冲刷 usage 队列 + dispose 插件。 */
  shutdown(): Promise<void>;
}

/**
 * 默认路由表。
 *
 * `mock-*` 两个别名指向 **mock access path**（`requires_credential: false`），
 * 因此 `npm run demo` 不起真实 API、不设任何 key 也能端到端跑通。
 * `gpt-4o` / `claude-sonnet-4-5` 指向真实 access path，配好 AG_OPENAI_API_KEY /
 * AG_ANTHROPIC_API_KEY 后即可用（EnvCredentialResolver 会自动登记）。
 * `deepseek-flash` / `deepseek-v4-pro`（OpenAI 方言）与 `*-messages`（Anthropic 方言）
 * 指向 DeepSeek 的两条 access path，配好 DEEPSEEK_API_KEY 后可用——两条路径正好演示
 * 任务要求的两种装配：客户端同格式（canonical → 同格式 codec 映射）与跨格式
 * （canonical 转换）。模型清单以官方文档为准（deepseek-chat / deepseek-reasoner
 * 已于 2026-07-24 退役，不再登记）。
 */
export function defaultRouteTable(): RouteTable {
  return {
    aliases: {
      'mock-gpt': {
        targets: [{ access_path: 'mock', provider: 'mock', model: 'gpt-test-1' }],
        max_context_tokens: 128_000,
      },
      'mock-claude': {
        targets: [{ access_path: 'mock-anthropic', provider: 'mock', model: 'claude-test-1' }],
        max_context_tokens: 200_000,
      },
      'gpt-4o': {
        targets: [{ access_path: 'openai', provider: 'openai', model: 'gpt-4o' }],
        max_context_tokens: 128_000,
      },
      'claude-sonnet-4-5': {
        targets: [{ access_path: 'anthropic', provider: 'anthropic', model: 'claude-sonnet-4-5' }],
        max_context_tokens: 200_000,
      },
      ...deepseekRouteAliases(),
    },
  };
}

/** 默认能力矩阵（Phase 1：两个已实现的 chat adaptor × mock/真实路径 + DeepSeek 两 dialect）。 */
export function defaultCapabilities(): CapabilityEntry[] {
  const chatSse = {
    mode: 'sse' as const,
    usage_in_stream: true,
    cancellable: true,
    framing: 'json-sse' as const,
  };
  return [
    {
      access_path: 'mock',
      model: 'gpt-test-1',
      modality: 'chat',
      format: 'openai.chat',
      streaming: chatSse,
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
    },
    {
      access_path: 'mock-anthropic',
      model: 'claude-test-1',
      modality: 'chat',
      format: 'anthropic.messages',
      streaming: chatSse,
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
    },
    {
      access_path: 'openai',
      model: 'gpt-4o',
      modality: 'chat',
      format: 'openai.chat',
      streaming: chatSse,
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
    },
    {
      access_path: 'anthropic',
      model: 'claude-sonnet-4-5',
      modality: 'chat',
      format: 'anthropic.messages',
      streaming: chatSse,
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
    },
    // DeepSeek：2 模型 × 2 dialect = 4 条（providers/deepseek/profile.ts 单一来源）
    ...deepseekCapabilities(),
  ];
}

/**
 * 装配默认的 provider profile 注册表（Phase 1：只有 DeepSeek）。
 *
 * 这是全仓库唯一「知道有哪些 provider profile」的地方——与 adaptors/index.ts 的
 * 显式注册同一立场（40 §1.3：不做魔法自动发现）。测试可整体替换。
 */
export function createDefaultProviderProfiles(): ProviderProfileRegistry {
  const registry = new InMemoryProviderProfileRegistry();
  registry.register(createDeepSeekProfile());
  return registry;
}

/** 内存 KV：插件的 KV 命名空间（Phase 1 用内存实现）。 */
class MemoryKVNamespace implements KVNamespace {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * 系统级探针（余额查询等）用的最小 RequestContext。
 *
 * 为什么需要它：CredentialResolver.headersFor 的签名要 ctx（trace 用），而系统探针
 * 不在任何请求生命周期里。造一个最小 ctx 比改 resolver 签名便宜——它只读
 * `route.access_path` 与 `request_id`。
 */
function systemProbeCtx(clock: Clock): RequestContext {
  const now = clock.now();
  return {
    request_id: 'req_balance_probe',
    started_at: now,
    deadline: now + 30_000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'system' },
    route: {
      access_path: 'deepseek.openai-chat',
      provider: 'deepseek',
      provider_format: 'openai.chat',
      model: 'deepseek-flash',
      full_model_id: 'deepseek.openai-chat/deepseek-flash',
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'openai.chat',
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    warn: () => {},
  };
}

/**
 * 装配一个完整可用的网关。
 *
 * 这是 `pnpm demo` / 测试 / 生产三种场景的共同入口；差异全部由 `GatewayOptions` 注入。
 */
export function createGateway(options: GatewayOptions = {}): Gateway {
  const mode = options.mode ?? 'production';
  const container = new Container();

  // ---- 跨切面基础设施 ----
  const config: GatewayConfig = { ...loadConfigFromEnv(), ...options.config };
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? (mode === 'test' ? new MemoryLogger() : new ConsoleLogger());
  const metrics = options.metrics ?? (mode === 'test' ? new MemoryMetrics() : new NoopMetrics());
  const ids =
    options.ids ?? (mode === 'test' ? new SequentialIdGenerator() : new UlidIdGenerator());

  container.registerValue(TOKENS.Config, config);
  container.registerValue(TOKENS.Clock, clock);
  container.registerValue(TOKENS.Logger, logger);
  container.registerValue(TOKENS.Metrics, metrics);
  container.registerValue(TOKENS.IdGenerator, ids);

  // ---- transport ----
  // 默认用 ScriptedTransport（mock 上游）而不是 FetchTransport：这样 `pnpm demo`
  // 不起真实 API 也能端到端跑通；生产部署时在 options 里传 FetchTransport。
  const transport =
    options.transport ??
    new ScriptedTransport([
      { body: JSON.stringify(defaultOpenAiChatResponse()) },
      { body: JSON.stringify(defaultAnthropicResponse()) },
    ]);
  container.registerValue(TOKENS.Transport, transport);

  // ---- adaptors ----
  // provider profile 注册表先建：两个 chat codec 需要它做 provider 专有映射
  // （端点路径 / builtin tool / thinking 形态），见 di/ports.ts 的 ProviderProfile。
  const providerProfiles = options.providerProfiles ?? createDefaultProviderProfiles();
  container.registerValue(TOKENS.ProviderProfiles, providerProfiles);

  // ---- 凭据与能力矩阵 ----
  // DeepSeek 两个 dialect 共用同一个 base URL；DEEPSEEK_BASE_URL 可整体覆盖
  // （代理 / 内网镜像场景），dialect 差异由 profile.endpointPath 表达。
  const credentialResolver =
    options.credentialResolver ??
    new EnvCredentialResolver(
      DEFAULT_ACCESS_PATHS,
      undefined,
      process.env,
      config.deepseekBaseUrl === undefined
        ? {}
        : Object.fromEntries(DEEPSEEK_ACCESS_PATH_IDS.map((id) => [id, config.deepseekBaseUrl!])),
    );
  container.registerValue(TOKENS.CredentialResolver, credentialResolver);

  const capabilityRegistry = new InMemoryCapabilityRegistry();
  for (const entry of options.capabilities ?? defaultCapabilities()) {
    capabilityRegistry.register(entry);
  }
  container.registerValue(TOKENS.CapabilityRegistry, capabilityRegistry);

  // codec 需要能力矩阵读上游声明的行为约束（DeepSeek api_capabilities），
  // 因此在矩阵装配好之后再建 adaptor 注册表。
  const { registry: adaptorRegistry } = createAdaptorRegistry({
    clock,
    logger,
    providerProfiles,
    capabilityRegistry,
  });
  container.registerValue(TOKENS.AdaptorRegistry, adaptorRegistry);

  // ---- 模型发现（可选）：启动后刷新一次，或按周期手动触发 ----
  let lastDiscovery: DeepSeekModelsResponse | undefined;
  const refreshModelCapabilities = async (): Promise<DiscoveryRefreshResult | undefined> => {
    if (options.modelDiscovery === undefined) return undefined;
    try {
      const result = await options.modelDiscovery.refresh(capabilityRegistry);
      lastDiscovery = await options.modelDiscovery.discover();
      logger.info('deepseek: 模型发现完成，能力矩阵已刷新', {
        discovered: result.discovered.length,
        updated: result.updated.length,
        added: result.added.length,
      });
      return result;
    } catch (err) {
      // 发现失败不致命：静态能力表已经可用。只记日志，不抛（20 §S10 同立场：
      // 旁路能力不得影响主链路）。
      logger.warn('deepseek: 模型发现失败，沿用静态能力矩阵', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };

  // ---- 插件 ----
  const services: GatewayServices = {
    log: logger,
    metrics,
    clock,
    currentUsage: () => ({ units: {}, source: 'provider' }),
    kv: new MemoryKVNamespace(),
  };
  const pluginHost = new DefaultPluginHost(services, config.pluginTimeoutMs);
  for (const { plugin, config: pluginConfig } of options.plugins ?? []) {
    pluginHost.register(plugin, pluginConfig ?? {});
  }
  container.registerValue(TOKENS.PluginHost, pluginHost);

  // ---- 计量 ----
  let usageSink: MemoryUsageSink | undefined;
  const emitter = new MemoryUsageEmitter({
    capacity: 10_000,
    drop_policy: 'drop_oldest',
    batchSize: 500,
    flushIntervalMs: 2_000,
    autoFlush: mode !== 'test',
  });
  if (options.usageSink !== undefined) {
    emitter.setSink(options.usageSink);
  } else if (mode === 'test') {
    usageSink = new MemoryUsageSink();
    emitter.setSink(usageSink);
  }
  container.registerValue(TOKENS.UsageEmitter, emitter);

  // ---- 管理面（控制平面）装配 ----
  // **必须在路由之前**：router 要收管理面的 aliasResolver，而 aliasResolver
  // 由管理面创建（能力矩阵查找直接读 capabilityRegistry，不另写一份）。
  // 早先的版本把这段放在 createGateway 末尾，结果 router 拿到的是
  // options.aliasResolver（测试里传的那个），而管理面 API 写规则时改的是
  // 自己内部新建的另一个解析器——「别名建好了但请求链路看不见」。
  // 这个 bug 由 tests/admin-api.test.ts 的端到端用例抓住。
  //
  // 全都不传 admin 相关 option 时，admin === undefined，行为与本轮改动之前
  // 完全一致（没有管理面，createHttpServer 也不挂 adminHandler）。
  const admin = assembleAdmin({
    options,
    capabilityRegistry,
    credentialResolver,
    clock,
    usageSink,
    balanceClientFactory: () =>
      new DeepSeekBalanceClient({
        transport,
        headersProvider: async () => {
          const { headers } = await credentialResolver.headersFor(
            'deepseek.openai-chat',
            systemProbeCtx(clock),
          );
          return headers;
        },
      }),
  });

  // ---- 路由 ----
  // aliasResolver 可选：注入了管理面就用管理面那个（API 改规则时路由立刻看见）；
  // 没注入管理面但显式传了 options.aliasResolver 也用传的那个（测试/定制装配）；
  // 两者都没有 → 纯静态 RouteTable 查表（历史行为，完全不变）。
  const router = new StaticRouter(
    options.routeTable ?? defaultRouteTable(),
    capabilityRegistry,
    credentialResolver,
    NOOP_ROUTE_HOOKS,
    admin?.aliasResolver ?? options.aliasResolver,
  );
  container.registerValue(TOKENS.Router, router);

  // ---- fast path 准入（D-fastpath-2）：启动时计算并缓存 ----
  const fastPathAdmission = createFastPathAdmission(pluginHost);

  // ---- PipelineRunner ----
  const runner = new PipelineRunner({
    config,
    clock,
    logger,
    metrics,
    ids,
    transport,
    adaptors: adaptorRegistry,
    pluginHost,
    usageEmitter: emitter,
    credentialResolver,
    capabilityRegistry,
    router,
    fastPathAdmission,
    providerProfiles,
    pricingService: options.pricingService ?? createDeepSeekPricingService(),
  });
  container.registerValue(TOKENS.PipelineRunner, runner);

  const shutdown = async (): Promise<void> => {
    await emitter.flush();
    emitter.close();
    await pluginHost.dispose();
  };

  return {
    container,
    config,
    runner,
    pluginHost,
    fastPathAdmission,
    usageEmitter: emitter,
    transport,
    logger,
    metrics,
    ...(usageSink === undefined ? {} : { usageSink }),
    refreshModelCapabilities,
    ...(lastDiscovery === undefined ? {} : { lastModelDiscovery: lastDiscovery }),
    balanceClient: new DeepSeekBalanceClient({
      transport,
      headersProvider: async () => {
        const { headers } = await credentialResolver.headersFor(
          'deepseek.openai-chat',
          systemProbeCtx(clock),
        );
        return headers;
      },
    }),
    ...(admin === undefined ? {} : { admin }),
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// 管理面装配（可选；全都不传则整块不存在）
// ---------------------------------------------------------------------------

export interface AdminAssembly {
  aliasResolver: import('./admin/aliases.js').AliasResolver;
  adminService: import('./admin/service.js').AdminService;
  adminAuth: import('./admin/auth.js').AdminAuth;
  /** http/server.ts 的挂载点（`createHttpServer({ adminHandler })`）。 */
  routeHandler: import('./admin/routes.js').AdminRouteHandler;
  /** 把库里持久化的别名规则灌进解析器（启动时 await 一次）。 */
  loadAliases(): Promise<number>;
}

/**
 * 装配管理面。
 *
 * 返回 undefined = 没配管理面（没传 recordStore / adminStaticRoot 任一）。
 * 这样 `createGateway()` 的既有调用方（测试、demo）完全不受影响。
 */
function assembleAdmin(input: {
  options: GatewayOptions;
  capabilityRegistry: import('./credentials/capability-registry.js').CapabilityRegistry;
  credentialResolver: import('./credentials/resolver.js').CredentialResolver;
  clock: import('./ir/clock.js').Clock;
  usageSink?: import('./metering/memory-emitter.js').MemoryUsageSink;
  balanceClientFactory: () => import('./providers/deepseek/balance.js').DeepSeekBalanceClient;
}): AdminAssembly | undefined {
  const { options, capabilityRegistry, credentialResolver, clock } = input;
  if (options.recordStore === undefined) return undefined;

  // ---- 别名解析器 ----
  // **调用方显式传了就用传的那个**（显式优于隐式）：测试与定制装配经常要
  // 从外面拿同一个解析器来断言「API 改的规则路由看见了」。只有没传时才新建，
  // 新建时用内置兜底规则（没建任何规则也能跑，npm run demo 不至于 404）。
  //
  // 能力查找直接用 capabilityRegistry（不另写一份矩阵）。
  const aliasResolver =
    options.aliasResolver ??
    new DefaultAliasResolver(options.aliasRules ?? defaultAliasRules(), {
      list: (modality) =>
        capabilityRegistry
          .list(modality)
          .map((e) => ({ access_path: e.access_path, model: e.model })),
    });

  // ---- 业务逻辑 ----
  const adminService = new AdminService({
    store: options.recordStore,
    clock,
    capabilityRegistry,
    credentialResolver,
    aliasResolver,
    ...(options.metadataSync === undefined ? {} : { metadataSync: options.metadataSync }),
    ...(options.balanceProbe === undefined
      ? {}
      : { balanceProbe: options.balanceProbe }),
    ...(input.usageSink === undefined
      ? {}
      : {
          usageSource: {
            // UsageRecord.units 是 UsageUnits（有名字段）；AdminService 要的是
            // Record<string, number>（宽类型）。这里显式放宽，让 metering 的
            // MemoryUsageSink 能直接注入而不必包一层转换类。
            list: (fromTs, toTs) =>
              input.usageSink!.records
                .filter((r) => r.ts >= fromTs && r.ts < toTs)
                .map((r) => ({
                  request_id: r.request_id,
                  ts: r.ts,
                  provider: r.provider,
                  model: r.model,
                  ...(r.model_alias === undefined ? {} : { model_alias: r.model_alias }),
                  status: r.status,
                  usage: { units: r.usage.units as unknown as Record<string, number> },
                  cost: {
                    cash: { total: r.cost.cash.total },
                    as_api: { total: r.cost.as_api.total },
                    status: r.cost.status,
                  },
                  finish_reason: r.finish_reason,
                  fast_path: r.fast_path,
                })),
          },
        }),
    ...(options.reconciliationSource === undefined
      ? {}
      : { reconciliationSource: options.reconciliationSource }),
  });

  // ---- 认证 ----
  // accessToken 走 options（不读 process.env——全仓库只有 di/config.ts 读 env）
  const adminAuth = new DefaultAdminAuth(options.recordStore, clock, {
    ...(options.adminAccessToken === undefined ? {} : { accessToken: options.adminAccessToken }),
  });

  // ---- 静态资源 ----
  const serveStatic =
    options.adminStaticRoot === undefined
      ? undefined
      : createStaticAssetsHandler({ rootDir: options.adminStaticRoot });

  // ---- HTTP 路由 ----
  const routeHandler = createAdminRouter({
    auth: adminAuth,
    service: adminService,
    keystoreStatus:
      options.keystore?.status ??
      (() => ({
        mode: 'key_file' as const,
        tradeoff_note: '未装配密钥库：管理面可看界面，但读不到任何加密存储内容。',
        unlocked: false,
        active_dek_id: '',
        encryption_count: 0,
        should_rotate_dek: false,
        argon2_rehash_recommended: false,
        kek_fingerprint: '',
      })),
    ...(serveStatic === undefined ? {} : { serveStatic }),
  });

  return {
    aliasResolver,
    adminService,
    adminAuth,
    routeHandler,
    loadAliases: () => adminService.loadAliasesIntoResolver(),
  };
}

/** mock 上游的 OpenAI Chat 非流式响应（本地演示用，全部假数据）。 */
export function defaultOpenAiChatResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-test0001',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-test-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '你好，这是来自 mock 上游的回复。' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** mock 上游的 Anthropic 非流式响应（本地演示用，全部假数据）。 */
export function defaultAnthropicResponse(): Record<string, unknown> {
  return {
    id: 'msg_test0001',
    type: 'message',
    role: 'assistant',
    model: 'claude-test-1',
    content: [{ type: 'text', text: '你好，这是来自 mock 上游的回复。' }],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

export type { AdaptorMeta } from './adaptors/types.js';
