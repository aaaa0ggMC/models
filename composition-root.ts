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
  createDeepSeekCatalogSource,
  createDeepSeekUpstreamSource,
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
import { StaticRouter } from './gateway-core/router.js';
import type { RouteTable } from './gateway-core/router.js';
import { PipelineRunner } from './gateway-core/pipeline/runner.js';
import { createFastPathAdmission } from './gateway-core/pipeline/fast-path.js';
import type { FastPathAdmission } from './gateway-core/pipeline/fast-path.js';
import type { CapabilityEntry } from './ir/index.js';
import {
  ModelCatalog,
  ModelSyncService,
  createModelsDevSource,
  providerResolverFromRouteTable,
  type AccessPathCredentialLister,
  type ModelMetadataSource,
} from './catalog/index.js';

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
   * 模型发现（可选）：注入后 `gateway.refreshModelCapabilities()` 会用 `/models`
   * 的实时元数据刷新能力矩阵（窗口/模态/effort/上游约束）。不注入 = 只用静态表。
   */
  modelDiscovery?: DeepSeekModelDiscovery;
  /**
   * 模型目录（`/v1/models`）的**离线层 + 配置层**元数据来源。
   *
   * 缺省装配两份离线来源（顺序即优先级，后者覆盖前者）：
   *   1. `offline:models.dev`——vendored models.dev 快照（family / 发布日期 / 知识截止 /
   *      温度与结构化输出支持 / 开放权重 / 模态 / 限额）；
   *   2. `offline:deepseek-static`——DeepSeek provider 静态表（并发限额 / 带峰谷 tiers 的
   *      价格 / 路由别名 / 退役别名 / 约束语义）。
   * 测试可整体替换（例如只留一份假来源，专门验证分层优先级）。
   */
  modelMetadataSources?: ModelMetadataSource[];
  /**
   * 模型目录的**上游层**来源（可选）。缺省装配 DeepSeek `/models`；注入假来源即可在
   * 不起真实 API 的情况下测"上游刷新 → 响应变化"。
   */
  upstreamMetadataSources?: ModelMetadataSource[];
  /** 同步参数覆盖（测试用；缺省走 config 的 modelSync* 字段）。 */
  modelSync?: {
    intervalMs?: number;
    ttlMs?: number;
    syncOnStart?: boolean;
    scheduler?: import('./catalog/index.js').TimerScheduler;
  };
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
   * canonical 模型目录（`GET /v1/models` 的单一事实来源）。
   *
   * 分层合并能力矩阵（运行时真值）+ 离线目录 + 上游实时 + 配置覆盖，逐字段记录来源。
   * 与能力矩阵同源：窗口/模态/effort/constraints 全部读矩阵，不另写一份。
   */
  models: ModelCatalog;
  /** 元数据同步服务（启动 / 周期 / 管理员触发三种方式）。 */
  modelSync: ModelSyncService;
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
 * access path → 凭据形态（只报类型与条数，**绝不碰明文**）。
 *
 * 为什么目录需要它：`access_paths[]` 要能表达"同一模型经不同凭据路径（API key /
 * 订阅 OAuth）可用的能力与限额差异"——而"这条路径上是 API key 还是订阅"只有凭据解析器
 * 知道。这里只取 `type` 与数量， secret 一个字节都不进目录。
 */
function accessPathCredentialLister(resolver: CredentialResolver): AccessPathCredentialLister {
  return (accessPath) => {
    const path = resolver.accessPath(accessPath);
    if (path === undefined) return undefined;
    return {
      requires_credential: path.requires_credential,
      credentials: resolver.credentialsFor(accessPath).map((c) => ({ type: c.type })),
    };
  };
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
  const discovery =
    options.modelDiscovery ??
    new DeepSeekModelDiscovery({
      transport,
      headersProvider: async () => {
        const { headers } = await credentialResolver.headersFor(
          'deepseek.openai-chat',
          systemProbeCtx(clock),
        );
        return headers;
      },
      ...(config.deepseekBaseUrl === undefined ? {} : { baseUrl: config.deepseekBaseUrl }),
    });
  const refreshModelCapabilities = async (): Promise<DiscoveryRefreshResult | undefined> => {
    try {
      const result = await discovery.refresh(capabilityRegistry);
      lastDiscovery = await discovery.discover();
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

  // 路由表提前建：模型目录要按它反推 access path → provider（`mock-anthropic` 这类
  // 不遵守「点号前前缀」约定的 id 只有路由表知道对应哪个 provider）
  const routeTable = options.routeTable ?? defaultRouteTable();

  // ---- 模型目录（/v1/models）：分层元数据 + 同步服务 ----
  // 离线层顺序即优先级：models.dev 快照在前（广而浅），provider 静态表在后（窄而深，
  // 覆盖前者的扁平费率——它带峰谷 tiers）。配置层（如果有）排最后，优先级最高。
  const metadataSources =
    options.modelMetadataSources ??
    ([
      createModelsDevSource({ ...(options.clock === undefined ? {} : { clock: options.clock }) }),
      createDeepSeekCatalogSource({
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
    ] satisfies ModelMetadataSource[]);
  const upstreamSources = options.upstreamMetadataSources ?? [
    createDeepSeekUpstreamSource({ discovery, capabilityRegistry, clock }),
  ];
  container.registerValue(TOKENS.ModelMetadataSources, metadataSources);

  const modelSync = new ModelSyncService({
    clock,
    sources: upstreamSources,
    logger,
    metrics,
    intervalMs: options.modelSync?.intervalMs ?? config.modelSyncIntervalMs,
    ttlMs: options.modelSync?.ttlMs ?? config.modelUpstreamTtlMs,
    syncOnStart: options.modelSync?.syncOnStart ?? config.modelSyncOnStart,
    ...(options.modelSync?.scheduler === undefined
      ? {}
      : { scheduler: options.modelSync.scheduler }),
  });
  container.registerValue(TOKENS.ModelSyncService, modelSync);

  const modelCatalog = new ModelCatalog({
    capabilityRegistry,
    sources: metadataSources,
    upstream: modelSync,
    clock,
    logger,
    providerResolver: providerResolverFromRouteTable(routeTable),
    credentialLister: accessPathCredentialLister(credentialResolver),
  });
  // 配置层对矩阵字段的修正在此写回矩阵（响应与路由同源，见 ModelCatalog 文件头）
  modelCatalog.applyConfigOverrides();
  container.registerValue(TOKENS.ModelCatalog, modelCatalog);

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

  // ---- 路由 ----
  const router = new StaticRouter(routeTable, capabilityRegistry, credentialResolver);
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
    models: modelCatalog,
    modelSync,
    shutdown,
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
