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
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createCompositePricingService } from './metering/composite-pricing.js';
import { createModelsDevPricingService } from './metering/models-dev-pricing.js';
import type { ChannelPricingResolver, PricingService } from './metering/pricing.js';
import { EnvCredentialResolver, DEFAULT_ACCESS_PATHS } from './credentials/resolver.js';
import type { CredentialResolver } from './credentials/resolver.js';
import { InMemoryCapabilityRegistry } from './credentials/capability-registry.js';
import type { CapabilityRegistry } from './credentials/capability-registry.js';
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
  parseDecimalOrZero,
} from './providers/deepseek/index.js';
import {
  createMiMoProfile,
  mimoCapabilities,
  mimoRouteAliases,
  MiMoModelDiscovery,
  createMiMoPricingService,
  MiMoBalanceClient,
} from './providers/mimo/index.js';
import { createOpenAICodexProfile } from './providers/openai-codex/profile.js';
import type { DeepSeekModelsResponse, DiscoveryRefreshResult } from './providers/deepseek/index.js';
import type { MiMoModelsResponse } from './providers/mimo/index.js';
import type { ProviderProfileRegistry } from './di/index.js';
import { InMemoryProviderProfileRegistry } from './di/index.js';
import { PROVIDER_PRESETS } from './providers/presets.js';
import { DefaultPluginHost } from './plugins/host.js';
import type { PluginHost } from './plugins/host.js';
import { RedactingPluginHost } from './plugins/redaction-host.js';
import { ToolCallRecorder } from './plugins/tool-recorder.js';
import { createAgentAdminPlugin } from './plugins/agent-admin.js';
import { AgentConfigHub, agentRedactionConfig } from './config/agent.js';
import { EncryptedAgentHistoryStore } from './admin/agent-history.js';
import type { AgentChatDeps } from './admin/agent-chat.js';
import type { GatewayServices, KVNamespace, Plugin, RequestContext } from './ir/index.js';
import { MemoryUsageEmitter, MemoryUsageSink } from './metering/index.js';
import type { UsageEmitter, UsageSink } from './metering/index.js';
import { FetchTransport, ScriptedTransport } from './gateway-core/transport.js';
import type { Transport } from './gateway-core/transport.js';
import {
  StaticRouter,
  NOOP_ROUTE_HOOKS,
  ProviderStateFilter,
  type RouteHooks,
  type RouteRequest,
} from './gateway-core/router.js';
import {
  InMemoryRouteGraphRegistry,
  type RouteGraphRegistry,
} from './gateway-core/routing-engine.js';
import {
  DefaultRoutingTelemetryHub,
  type RoutingTelemetryHub,
} from './gateway-core/routing-telemetry.js';
import type { RouteTable } from './gateway-core/router.js';
import type { Attempt } from './ir/index.js';
import { PipelineRunner } from './gateway-core/pipeline/runner.js';
import { createFastPathAdmission } from './gateway-core/pipeline/fast-path.js';
import type { FastPathAdmission } from './gateway-core/pipeline/fast-path.js';
import type { CapabilityEntry } from './ir/index.js';
import {
  DefaultAliasResolver,
  defaultAliasRules,
  providerFromAccessPath,
} from './admin/aliases.js';
import { DefaultVirtualKeyStore } from './storage/virtual-keys.js';
import type { VirtualKeyStore } from './storage/virtual-keys.js';
import { DataPlaneAuthenticator } from './auth/data-plane.js';
import type { DataPlaneAuthDescription } from './auth/data-plane.js';
import { SettingsService } from './config/settings.js';
import { AdminService } from './admin/service.js';
import { DefaultAdminAuth } from './admin/auth.js';
import { createAdminRouter } from './admin/routes.js';
import { createStaticAssetsHandler } from './admin/static.js';
import { InMemoryProviderRuntimeIndex } from './admin/provider-runtime.js';
import type { ProviderRuntimeIndex } from './admin/provider-runtime.js';
import {
  createProviderModelsPort,
  enrichModelsWithOfflineMetadata,
} from './admin/provider-models.js';
import { createToolEndpoints, type ToolEndpointHandler } from './http/tools-endpoint.js';
import type { ToolEndpoints } from './http/tools-endpoint.js';
import { createModalityEndpoints } from './http/modality-endpoints.js';
import type { ModalityEndpoints } from './http/modality-endpoints.js';
import { createImagesEndpointHandlers } from './http/images-endpoint.js';
import { createEmbeddingsEndpointHandler } from './http/embeddings-endpoint.js';
import {
  createDecisionsEndpointHandler,
  DEFAULT_DECISION_DEGRADATION_POLICY,
  type DecisionDegradationPolicy,
} from './http/decisions-endpoint.js';
import {
  OpenAIImagesAdaptor,
  OpenAIImagesClient,
  createOpenAIImagesPricingService,
} from './providers/openai-images/index.js';
import { OpenAIEmbeddingsAdaptor } from './providers/openai-embeddings/index.js';
import {
  MockDecisionAdaptor,
  TransportChatPort,
  ChatSimulatedDecisionAdaptor,
} from './providers/decision/index.js';
import { createAudioEndpoints } from './http/audio-endpoint.js';
import type { AudioEndpoints } from './http/audio-endpoint.js';
import type { AudioEndpointProvider } from './http/audio-faces.js';
import { createDeepSeekToolHandlers } from './providers/deepseek/tool-handlers.js';
import { deepseekAudioCapabilities } from './providers/deepseek/audio-models.js';
import { DEEPSEEK_AUDIO_FACE } from './providers/deepseek/audio-openai-face.js';
import { DeepSeekSearchClient } from './providers/deepseek/search.js';
import { DeepSeekFetchClient } from './providers/deepseek/fetch.js';
import { DeepSeekOcrClient } from './providers/deepseek/ocr.js';
import { DeepSeekAsrClient } from './providers/deepseek/asr.js';
import { DeepSeekTtsClient } from './providers/deepseek/tts.js';
import { createMiMoToolHandlers } from './providers/mimo/tool-handlers.js';
import { mimoAudioCapabilities } from './providers/mimo/audio-models.js';
import { MIMO_AUDIO_FACE } from './providers/mimo/audio-openai-face.js';
import { MiMoAsrClient, MiMoTtsClient } from './providers/mimo/audio.js';
import {
  ModelCatalog,
  ModelSyncService,
  createModelsDevSource,
  providerResolverFromRouteTable,
  type AccessPathCredentialLister,
  type ModelMetadataSource,
  type ProviderAvailabilityResolver,
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
  /**
   * 模态端点整体替换（可选）：不注入 = 组合根按默认装配（images/embeddings 走
   * OpenAI 兼容上游 + decision mock/降级）。测试注入假的，避免依赖真实上游形状。
   */
  modalityEndpoints?: ModalityEndpoints;
  /** decision 降级策略（可选；缺省 = 15 §6.5 的默认值）。 */
  decisionDegradation?: DecisionDegradationPolicy;
  /** decision 降级路径用的 chat 模型（可选；缺省 'gpt-5.4'）。 */
  degradedChatModel?: string;
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
  /** 可选：注入路由图注册表与遥测聚合中心。 */
  routeGraphs?: RouteGraphRegistry;
  routingTelemetry?: RoutingTelemetryHub;
  /**
   * provider 运行时投影（可选）：namespace / 服务端工具开关的请求路径视图。
   *
   * 注入后管理面写 provider 配置时，`/v1/models` 的生效名、S2 的 namespace 解析、
   * S3 的默认工具注入会**同时**看到新值（三者共享同一个实例）。不注入 = 管理面内部
   * 自建一个，行为不变；测试注一个是为了从外面断言。
   */
  providerRuntime?: ProviderRuntimeIndex;
  /**
   * **静态装配声明**的 provider id 列表（不建渠道记录也算"配过了"）。
   *
   * 唯一的合法使用者是**测试与演示装配**：它们用假上游 / 脚本化 transport 静态
   * 拼出一个 provider（注册 profile + 假凭据解析器），没有加密存储里的渠道记录。
   * 路由准入（ProviderStateFilter 的 `isConfigured`）问的正是"这个 provider
   * 配过吗"——不声明的话，这些装配的请求会被一句"没配渠道"挡在门外，而它们本
   * 来就是拿来跑链路的替身。
   *
   * **生产部署不要用**：那等于用一行配置把"零配置不路由"这条规则绕开，正是本次
   * 修的那个割裂（选择器说没模型、请求照旧打到上游）。生产要能用就建渠道。
   */
  staticProviders?: readonly string[];
  /**
   * 上游模型清单端口（可选；`POST /admin/api/provider-models` 用）。
   * 不注入 = 组合根按 transport + 凭据解析器自动装配 DeepSeek 实现；测试注入假的。
   */
  providerModels?: import('./admin/service.js').ProviderModelsPort;
  /**
   * 加密记录存储（可选）：注入后管理面（admin/）才有地方存凭据/别名/审计。
   * 不注入 = 管理面仍可起来，但所有存储操作报"未装配"。
   */
  recordStore?: import('./storage/record-store.js').EncryptedRecordStore;
  /**
   * 密钥库控制端口（可选；管理面密钥状态展示与轮换用）。
   *
   * `status` 必须提供；`rotateKek` / `rotateDek` 可选——不给就说明该部署
   * 不支持轮换（例如 key_file 模式下没有新口令可换），路由会明确回 501。
   */
  keystore?: {
    status(): import('./admin/api-types.js').KeystoreStatusResponse;
    rotateKek?(input: {
      new_passphrase?: string;
    }): Promise<import('./admin/api-types.js').KeystoreRotateKekResponse>;
    rotateDek?(): Promise<import('./admin/api-types.js').KeystoreRotateDekResponse>;
  };
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
   * MiMo 的模型发现（可选）：注入后 `gateway.refreshMiMoModelCapabilities()` 会拉一次
   * MiMo `/models` 并**补登**矩阵里没有的模型 id。与 DeepSeek 那个分开而不是合并：
   * 刷新策略不同（MiMo 的 /models 不给机读字段，只补 id），见
   * providers/mimo/discovery.ts 文件头。不注入 = MiMo 只用静态表。
   */
  mimoModelDiscovery?: MiMoModelDiscovery;
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
  /**
   * 配置文件路径（`config/layering.ts` 的第三层，非敏感默认值）。
   *
   * 给了但文件不存在 = 没有这一层（退到编译期默认值）。不传则设置界面
   * 不显示「配置文件」这一来源。
   */
  configFilePath?: string;
  /**
   * 设置服务的 env 快照（**测试 seam**）。
   *
   * 让「哪一项被 env 覆盖了」的判定读这份快照，而不是真 `process.env`——
   * 于是测试可以在不动全局环境的情况下验 env 锁。读 env 本身仍然只发生在
   * di/config.ts（本选项只是把那份读取结果换一个来源）。
   */
  settingsEnv?: NodeJS.ProcessEnv;
}

/** 配置文件（`config/layering.ts` 第三层）的缺省路径；不存在即没有这一层。 */
export const DEFAULT_CONFIG_FILE_PATH = 'config/gateway.json';

export interface Gateway {
  container: Container;
  config: GatewayConfig;
  runner: PipelineRunner;
  pluginHost: PluginHost;
  /**
   * Agent 配置枢纽（docs/design/95-agent-chat.md §6）。
   *
   * 设置服务的 Agent 组经 `setAgentSettingSink` 写它，聊天端点与 `agent-admin`
   * 插件读它。暴露出来是为了让装配方（测试、定制启动脚本）能把内置对话端点
   * 接上——那需要同时拿到枢纽、记录器与 runner。
   */
  agentConfig: AgentConfigHub;
  /** 工具调用旁路记录（95 §2.2 / §3.3；与 runner 用的插件主机共享同一个实例）。 */
  toolRecorder: ToolCallRecorder;
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
  /**
   * MiMo 的模型发现（补登矩阵里没有的模型 id；需注入 mimoModelDiscovery）。
   *
   * 与上面那个分开：两家上游的 `/models` 能力不同（DeepSeek 给机读字段，MiMo 只给
   * id），合并成一个方法会让"为什么这个字段没刷新"说不清。失败只记日志不影响服务。
   */
  refreshMiMoModelCapabilities(): Promise<void>;
  /** 最近一次成功发现的 /models 原始响应（未发现过 = undefined）。 */
  lastModelDiscovery?: DeepSeekModelsResponse;
  /** MiMo 最近一次成功发现的 /models 原始响应（未发现过 = undefined）。 */
  lastMiMoModelDiscovery?: MiMoModelsResponse;
  /**
   * DeepSeek 余额客户端（对账真值源：`GET /user/balance`）。
   *
   * 用途：a) 区间对账（余额差 vs 我们估算的 cash，见 metering/reconciliation.ts）；
   * b) 低余额信号（配合 Plan 感知路由优先走订阅路径）；c) 请求前预检。
   * 注意 DeepSeek **赠送余额优先扣**，余额差不等于现金支出。
   */
  balanceClient: DeepSeekBalanceClient;
  /**
   * MiMo 的官方计费/余量客户端（对账真值源）。
   *
   * 与上面那个**并列而不是合并**：MiMo 的钱分两个不互通的渠道（Token Plan 积分 /
   * 按量余额），各自要不同的 key 前缀（`tp-` / `sk-`）且挂在不同 host 上。
   * 合并成一个"余额"概念会说不清查的是哪条路。默认部署（`tp-` key）用
   * `snapshot(undefined)` → 查 token_plan；按量部署先问 `billingModeFor` 再选。
   */
  mimoBalanceClient: MiMoBalanceClient;
  /**
   * 管理面（控制平面）装配。没传 `recordStore` 等 admin option 时为 undefined——
   * 此时网关没有管理面，`createHttpServer` 也不需要挂 `adminHandler`。
   */
  admin?: AdminAssembly;
  /**
   * 独立工具端点（DeepSeek 全家桶 + MiMo 音频两个）。
   *
   * http/server.ts 经 `tools` 选项挂载；不起服务时（纯测试）也能用它的 `list()`
   * 自省"端点一条不少、路径不撞车"。
   */
  toolEndpoints: ToolEndpoints;
  /** OpenAI 兼容音频端点（`/v1/audio/*`；与 toolEndpoints 共用同一批上游客户端）。 */
  audioEndpoints: AudioEndpoints;
  /**
   * 模态端点（image / embedding / decision；不跑 pipeline）。
   *
   * http/server.ts 经 `modalities` 选项挂载。默认装配：images/embeddings 走
   * OpenAI 兼容上游（key 走 `AG_OPENAI_API_KEY`，缺 key 时调用失败），decision
   * 的 native 位是 mock、降级位是 chat 模拟。测试可经 `options.modalityEndpoints`
   * 整体替换（如换 ScriptedTransport 装配）。
   */
  modalityEndpoints: ModalityEndpoints;
  /**
   * 数据面 virtual key 存储（66 §2）。需要 `recordStore`；没配就是 undefined，
   * 此时数据面退到极简模式，或**什么都没配时整个关掉**（deny-first，见
   * auth/data-plane.ts 文件头——permissive 要显式 opt-in，不是兜底）。
   */
  virtualKeys?: VirtualKeyStore;
  /** 数据面鉴权器（S0 注入的就是它）。总是装配的，与有没有存储无关。 */
  dataPlaneAuth: DataPlaneAuthenticator;
  /** 运行时设置服务（P0-2）。需要 `recordStore`。 */
  settings?: SettingsService;
  /**
   * 把加密存储里的运行时设置应用回 config（**启动时必须 await 一次**）。
   *
   * 幂等：重复调用拿到同一个 Promise。典型用法：
   *   `await startHttpServer({ ..., startup: () => gateway.loadSettings() })`
   * 或在起服务前 `await gateway.loadSettings()`。
   *
   * **不 await 的后果**：启动后的短暂窗口内，请求路径用的是 env / 配置文件 /
   * 默认值合并出的 config，而不是加密存储里那份。设置界面本身仍然显示正确的
   * 当前值（它直接读存储），所以这个错误是「能看到但没生效」，不是静默的。
   */
  loadSettings(): Promise<number>;
  /**
   * 打一条数据面认证模式的告警（互斥被触发时）。
   *
   * 与 `loadSettings()` 同一个时机调：那时候才数得清库里有几把 key。
   */
  reportDataPlaneAuthMode(): Promise<DataPlaneAuthDescription>;
  /**
   * canonical 模型目录（`GET /v1/models` 的单一事实来源）。
   *
   * 分层合并能力矩阵（运行时真值）+ 离线目录 + 上游实时 + 配置覆盖，逐字段记录来源。
   * 与能力矩阵同源：窗口/模态/effort/constraints 全部读矩阵，不另写一份。
   */
  models: ModelCatalog;
  /** 元数据同步服务（启动 / 周期 / 管理员触发三种方式）。 */
  modelSync: ModelSyncService;
  /** 路由图注册表（图 + VM-JS 自定义模型路由）。 */
  routeGraphs: RouteGraphRegistry;
  /** 路由遥测聚合中心（5h 滑窗 / 余额 / 积分 / 闲时）。 */
  routingTelemetry: RoutingTelemetryHub;
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
 *
 * `mimo-v2.6-flash` / `mimo-v2.6-pro` 指向 MiMo 的唯一 access path（OpenAI 兼容），
 * 配好 MIMO_API_KEY 后可用。MiMo 没有 Anthropic 兼容面，所以**没有** `-messages` 别名。
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
      ...mimoRouteAliases(),
    },
  };
}

/** 默认能力矩阵（两个已实现的 chat adaptor × mock/真实路径 + DeepSeek 两 dialect + MiMo）。 */
export function defaultCapabilities(): CapabilityEntry[] {
  const chatSse = {
    mode: 'sse' as const,
    usage_in_stream: true,
    cancellable: true,
    framing: 'json-sse' as const,
  };
  return [
    {
      // mock 两条：Phase 1 的演示/测试替身（不起真实 API、不设任何 key 也能端到端跑通）。
      // 标 `internal` = 永不出现在 `/v1/models` 默认清单里（见 ir/capability.ts 的字段说明）：
      // 它们是脚手架，不是可调用的上游。条目**不从矩阵删**——路由的能力预检与 fast path
      // 资格都读矩阵，删掉会顺带改变请求路径行为。
      access_path: 'mock',
      model: 'gpt-test-1',
      modality: 'chat',
      format: 'openai.chat',
      streaming: chatSse,
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
      internal: true,
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
      internal: true,
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
    // MiMo：2 模型 × 1 dialect = 2 条（providers/mimo/profile.ts 单一来源）。
    // 上游 /models 不给 context_window 等机读字段，所以矩阵里这些字段留空——不编造。
    ...mimoCapabilities(),
    // 音频端点（DeepSeek 2 条 + MiMo 4 条）：不进推理路由，但进能力矩阵——
    // `/v1/audio/*` 的 model 解析与 `/v1/models` 的清单都以矩阵为唯一事实来源
    ...deepseekAudioCapabilities(),
    ...mimoAudioCapabilities(),
  ];
}

/**
 * 装配默认的定价服务（DeepSeek + MiMo 组合）。
 *
 * 顺序即认领顺序：两家模型名不重叠（`deepseek-*` vs `mimo-*`），顺序只影响
 * 「谁都不要这个模型」时的遍历成本。**不要**给 MiMo 也建一个 DeepSeek 那样的
 * 节假日/峰谷体系——官方页没有任何时段表述（providers/mimo/pricing.ts 的论证）。
 *
 * 测试可经 `options.pricingService` 整体替换（单服务或另一个组合都行）。
 */
export function createDefaultPricingService(
  channelPricing?: ChannelPricingResolver,
): PricingService {
  return createCompositePricingService(
    [
      createDeepSeekPricingService(),
      createMiMoPricingService(),
      createOpenAIImagesPricingService(),
    ],
    {
      ...(channelPricing === undefined ? {} : { channelPricing }),
      fallback: createModelsDevPricingService(),
    },
  );
}

/**
 * 装配默认的 provider profile 注册表（DeepSeek + MiMo）。
 *
 * 这是全仓库唯一「知道有哪些 provider profile」的地方——与 adaptors/index.ts 的
 * 显式注册同一立场（40 §1.3：不做魔法自动发现）。测试可整体替换。
 *
 * MiMo 的 profile 只有 `endpointPath` 一项（理由见 providers/mimo/profile.ts 文件头：
 * 它的 Chat Completions 面就是 OpenAI 形状，其余钩子返回 undefined = 不干预）。
 */
export function createDefaultProviderProfiles(): ProviderProfileRegistry {
  const registry = new InMemoryProviderProfileRegistry();
  registry.register(createDeepSeekProfile());
  registry.register(createMiMoProfile());
  registry.register(createOpenAICodexProfile());
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
 * access path → 凭据形态查询（组合根用 CredentialResolver 实现；不含明文）。
 *
 * 为什么目录需要它：`access_paths[]` 要能表达"同一模型经不同凭据路径（API key /
 * 订阅 OAuth）可用的能力与限额差异"——而"这条路径上是 API key 还是订阅"只有凭据解析器
 * 知道。这里只取 `type` 与条数， secret 一个字节都不进目录。
 *
 * 返回 undefined = 该 access path 未登记（`CredentialResolver.accessPath` 查不到），
 * 与"登记了但没有凭据"是两回事——后者要报 `available: 0`，让 `/v1/models` 能说出
 * "这条路径存在但没配 key"。
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
 * provider → 是否已配置（`/v1/models` 的部署态过滤判据）。
 *
 * **判据读真实存储，不猜**（任务书硬约束），两个来源任一命中即算已配置：
 *
 * 1. **渠道表**：`ProviderRuntimeIndex` 是加密存储里 provider 配置的运行时投影
 *    （管理面每次 CRUD 后整表重算）。有条目 = 管理员建过这个渠道。
 * 2. **凭据库**：该 provider 任一 access path 上有 ≥1 条可用凭据。覆盖"只设了环境变量
 *    、没建渠道"的部署（`EnvCredentialResolver` 会把 `DEEPSEEK_API_KEY` 之类的变量
 *    自动登记成凭据），以及管理面录在加密存储里的 key。
 *
 * access path 的枚举走**能力矩阵**（矩阵是模型集合的唯一来源，目录只对矩阵里出现的
 * provider 提问）。每次提问都重建这张表而不是装配时建一次：矩阵条目会随 discovery
 * 刷新与管理面登记而增多，而 `registerAccessPath` 在环境变量已有值时会**顺手登记一条
 * 凭据**——用旧表就会漏掉"新路径 + 新凭据"这个组合。表的规模是个位数到几十，
 * 而 `ModelCatalog.buildAll` 已经按 provider 记过一次结果，实际开销可忽略。
 *
 * 为什么不是 `providerRuntime.isUnavailable`：那个回答"这个渠道被禁用了吗"（临时态），
 * 这里回答"这个 provider 配过吗"（结构性）。混在一起会让"禁用一个渠道"表现得像
 * "这个 provider 不存在"，而两者该给的提示完全不同。
 *
 * ## 与路由准入的口径差异（有意为之，文档说清）
 *
 * S2 的准入（`ProviderStateFilter.isConfigured`）问的是**渠道表**——没建过渠道就
 * 不路由，请求不出门。本判据多认一个来源（凭据库 / env 档），于是会出现
 * 「目录说有、路由说没有」的部署态（0 渠道 + env key）。这是**故意的**：
 *
 * - 两个消费者问的不是同一个问题。`/v1/models` 的消费者是**客户端探测**：
 *   "这个网关认识哪些模型、这些模型有没有 key"。env 里配了 key 是事实，目录照实说。
 *   路由问的是"管理员在管理面配好了吗"——那是运维动作，env 变量替不了。
 * - 准入只在**有管理面的装配**上生效（`admin === undefined` 时 hooks 是 NOOP，
 *   历史行为完全不变）。纯数据面装配（没有渠道表可问）的配置就是 env key 本身，
 *   那时目录列得出、路由也打得通——两边是一致的。若把目录也收窄成"只列已建渠道"，
 *   那种装配会反过来割裂（目录空、路由通）。
 * - 想要全量已知集合的调用方有显式开关：`include_unconfigured=1`（与
 *   `include_internal` 同一套"默认隐藏 + 一个开关"的立场，见 catalog/visibility.ts）。
 *
 * 代价说清：0 渠道 + env key 的部署上，客户端按目录挑一个模型发出去，会拿到
 * `no_available_provider`（说清"没配渠道"）而不是上游 401。那正是要的效果——
 * 错误从"key 好像坏了"变成"这个部署没配渠道"。
 */
function providerAvailabilityResolver(deps: {
  credentialResolver: CredentialResolver;
  capabilityRegistry: CapabilityRegistry;
  providerRuntime?: ProviderRuntimeIndex;
  staticDeclared?: ReadonlySet<string>;
  strictChannelMode?: boolean;
}): ProviderAvailabilityResolver {
  const accessPathsByProvider = (): Map<string, string[]> => {
    const byProvider = new Map<string, string[]>();
    for (const entry of deps.capabilityRegistry.list()) {
      // access path 命名约定 `<provider>.<dialect>`（全仓库通用，见 admin/aliases.ts）
      const provider = providerFromAccessPath(entry.access_path);
      const list = byProvider.get(provider) ?? [];
      if (!list.includes(entry.access_path)) list.push(entry.access_path);
      byProvider.set(provider, list);
    }
    return byProvider;
  };
  return (provider) => {
    const runtimeEntry = deps.providerRuntime?.get(provider);
    if (runtimeEntry !== undefined) {
      if (!runtimeEntry.enabled) return false;
      if (deps.credentialResolver.credentialsFor(runtimeEntry.access_path).length > 0) {
        return true;
      }
      const paths = accessPathsByProvider().get(provider) ?? [];
      return paths.some(
        (accessPath) => deps.credentialResolver.credentialsFor(accessPath).length > 0,
      );
    }
    if (deps.staticDeclared?.has(provider) === true) return true;
    if (deps.strictChannelMode) return false;
    const paths = accessPathsByProvider().get(provider) ?? [];
    return paths.some(
      (accessPath) => deps.credentialResolver.credentialsFor(accessPath).length > 0,
    );
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
 * DeepSeek 上游的鉴权头提供者（五个全家桶端点 + 两条 chat access path 共用）。
 *
 * 每次调用现取而不是缓存：轮换 key（改环境变量后重启之外的场景）不需要动这里，
 * 而缓存一份鉴权头等于把 key 多留在一个地方。
 */
function deepseekHeadersProviderFor(
  credentialResolver: CredentialResolver,
  clock: Clock,
): () => Promise<Record<string, string>> {
  return async () => {
    const { headers } = await credentialResolver.headersFor(
      'deepseek.openai-chat',
      systemProbeCtx(clock),
    );
    return headers;
  };
}

/**
 * MiMo 上游的鉴权头提供者（chat 一条 access path + 音频两个工具端点共用）。
 *
 * 每次调用现取而不是缓存：轮换 key（改环境变量后重启之外的场景）不需要动这里，
 * 而缓存一份鉴权头等于把 key 多留在一个地方（同 deepseekHeadersProviderFor）。
 */
function mimoHeadersProviderFor(
  credentialResolver: CredentialResolver,
  clock: Clock,
): () => Promise<Record<string, string>> {
  return async () => {
    const { headers } = await credentialResolver.headersFor(
      'mimo.openai-chat',
      systemProbeCtx(clock),
    );
    return headers;
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

  // ---- provider 运行时投影（namespace / 服务端工具开关的请求路径视图）----
  // 建在这里而不是 admin 里：模型目录（下面几百行）与 pipeline 都要读它，而 admin
  // 装配在更后面。整表替换语义，见 admin/provider-runtime.ts 的文件头。
  const providerRuntime = options.providerRuntime ?? new InMemoryProviderRuntimeIndex();
  const staticDeclared = new Set(options.staticProviders ?? []);
  const hasActiveProvider = (id: string): boolean => {
    const entry = providerRuntime.get(id);
    return entry !== undefined ? entry.enabled : staticDeclared.has(id);
  };

  // ---- transport ----
  // 生产模式默认真实 FetchTransport；test 模式默认 ScriptedTransport 供单测/演示使用。
  const transport =
    options.transport ??
    (mode === 'production'
      ? new FetchTransport()
      : new ScriptedTransport([
          { body: JSON.stringify(defaultOpenAiChatResponse()) },
          { body: JSON.stringify(defaultAnthropicResponse()) },
        ]));
  container.registerValue(TOKENS.Transport, transport);

  // ---- adaptors ----
  // provider profile 注册表先建：两个 chat codec 需要它做 provider 专有映射
  // （端点路径 / builtin tool / thinking 形态），见 di/ports.ts 的 ProviderProfile。
  const providerProfiles = options.providerProfiles ?? createDefaultProviderProfiles();
  container.registerValue(TOKENS.ProviderProfiles, providerProfiles);

  // ---- 凭据与能力矩阵 ----
  // 生产模式下凭据解析器空起步（不因进程 env 里刚好有 key 就激活未建渠道）；
  // 管理面建渠道/录入凭据后由 refreshProviderRuntime 动态登记。
  const deepseekBaseOverrides =
    config.deepseekBaseUrl === undefined
      ? {}
      : Object.fromEntries(DEEPSEEK_ACCESS_PATH_IDS.map((id) => [id, config.deepseekBaseUrl!]));
  const credentialResolver =
    options.credentialResolver ??
    (mode === 'production'
      ? new EnvCredentialResolver([], undefined, process.env, deepseekBaseOverrides, {
          autoRegisterEnv: false,
        })
      : new EnvCredentialResolver(
          DEFAULT_ACCESS_PATHS,
          undefined,
          process.env,
          deepseekBaseOverrides,
        ));
  container.registerValue(TOKENS.CredentialResolver, credentialResolver);

  const capabilityRegistry = new InMemoryCapabilityRegistry();
  for (const entry of options.capabilities ?? (mode === 'production' ? [] : defaultCapabilities())) {
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

  // ---- 模型发现（可选）：按渠道是否启用按需触发 ----
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
  let lastMiMoDiscovery: MiMoModelsResponse | undefined;
  const mimoDiscovery =
    options.mimoModelDiscovery ??
    new MiMoModelDiscovery({
      transport,
      headersProvider: async () => {
        const { headers } = await credentialResolver.headersFor(
          'mimo.openai-chat',
          systemProbeCtx(clock),
        );
        return headers;
      },
    });
  const refreshModelCapabilities = async (): Promise<DiscoveryRefreshResult | undefined> => {
    if (mode === 'production' && !hasActiveProvider('deepseek') && options.modelDiscovery === undefined) {
      return undefined;
    }
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
  /** MiMo 的模型发现：只补登矩阵里没有的模型 id（上游 /models 无机读字段可刷）。 */
  const refreshMiMoModelCapabilities = async (): Promise<void> => {
    if (mode === 'production' && !hasActiveProvider('mimo') && options.mimoModelDiscovery === undefined) {
      return;
    }
    try {
      const response = await mimoDiscovery.discover();
      lastMiMoDiscovery = response;
      const result = await mimoDiscovery.refresh(capabilityRegistry, response);
      logger.info('mimo: 模型发现完成，能力矩阵已补登', {
        discovered: result.discovered.length,
        added: result.added.length,
      });
    } catch (err) {
      logger.warn('mimo: 模型发现失败，沿用静态能力矩阵', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 路由表提前建：模型目录要按它反推 access path → provider。
  // 生产模式不预装未配置的写死模型路由，完全由能力矩阵与渠道配置驱动。
  const routeTable =
    options.routeTable ?? (mode === 'production' ? { aliases: {} } : defaultRouteTable());
  const providerOfAccessPath = providerResolverFromRouteTable(routeTable);

  // ---- 模型目录（/v1/models）：分层元数据 + 同步服务 ----
  const metadataSources =
    options.modelMetadataSources ??
    ([
      createModelsDevSource({ ...(options.clock === undefined ? {} : { clock: options.clock }) }),
      createDeepSeekCatalogSource({
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
    ] satisfies ModelMetadataSource[]);
  const deepseekUpstreamSource = createDeepSeekUpstreamSource({
    discovery,
    capabilityRegistry,
    clock,
  });
  const upstreamSources: ModelMetadataSource[] =
    options.upstreamMetadataSources ?? [
      mode === 'production'
        ? {
            id: deepseekUpstreamSource.id,
            layer: deepseekUpstreamSource.layer,
            ...(deepseekUpstreamSource.providers === undefined
              ? {}
              : { providers: deepseekUpstreamSource.providers }),
            async load() {
              if (!hasActiveProvider('deepseek') && options.modelDiscovery === undefined) {
                return {
                  sourceId: deepseekUpstreamSource.id,
                  fetchedAt: clock.now(),
                  models: [],
                };
              }
              return deepseekUpstreamSource.load();
            },
          }
        : deepseekUpstreamSource,
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

  // 部署态可见性判据（`/v1/models` 与管理面能力矩阵端点共用**同一个实例**）
  const providerAvailability = providerAvailabilityResolver({
    credentialResolver,
    capabilityRegistry,
    providerRuntime,
    staticDeclared,
    strictChannelMode: mode === 'production',
  });

  const routeGraphs = options.routeGraphs ?? new InMemoryRouteGraphRegistry();
  let isModelHiddenFn = (_modelId: string): boolean => false;
  const modelCatalog = new ModelCatalog({
    capabilityRegistry,
    sources: metadataSources,
    upstream: modelSync,
    clock,
    logger,
    providerResolver: providerOfAccessPath,
    credentialLister: accessPathCredentialLister(credentialResolver),
    // `/v1/models` 同时暴露裸 id 与 namespace 生效名（客户端可发现第二个名字）
    namespaceResolver: (provider) => providerRuntime.namespaceFor(provider),
    // 只列这个部署真调得通的模型：判据读渠道表 + 凭据库（见 providerAvailabilityResolver）
    providerAvailability,
    isModelHidden: (modelId) => isModelHiddenFn(modelId),
    routeGraphSource: () =>
      routeGraphs
        .list()
        .filter((g) => g.enabled)
        .map((g) => ({
          id: g.id,
          label: g.label,
          nodes: g.nodes,
          ...(g.ability_mode === undefined ? {} : { ability_mode: g.ability_mode }),
          ...(g.abilities === undefined ? {} : { abilities: g.abilities }),
          ...(g.created_at === undefined ? {} : { created_at: g.created_at }),
        })),
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

  // ---- Agent 配置枢纽（docs/design/95-agent-chat.md §6）----
  // 默认值集中在 config/agent.ts 的 AGENT_DEFAULTS；设置服务的 Agent 组经
  // setAgentSettingSink 把生效值推到这里，聊天端点与插件读的都是这一份。
  const agentConfigHub = new AgentConfigHub();
  const toolRecorder = new ToolCallRecorder();
  container.registerValue(TOKENS.PluginHost, pluginHost);

  // ---- 数据面鉴权（66 §2）----
  // 虚拟 key 存储与鉴权器都在这里建：S0 经 PipelineRunner 的 `authenticator`
  // 选项拿到鉴权器，管理面经 AdminService 拿到存储——两边共享**同一个实例**，
  // 于是「撤销后立即失效」不需要任何跨组件通知（存储内部的写操作会清缓存）。
  const virtualKeyStore =
    options.recordStore === undefined
      ? undefined
      : new DefaultVirtualKeyStore(options.recordStore, clock);
  // deny-first 的放行开关（三态语义见下面注入处的注释）
  const permissiveDataPlane = config.permissiveEnabled ?? mode === 'test';
  const dataPlaneAuth = new DataPlaneAuthenticator({
    ...(virtualKeyStore === undefined ? {} : { store: virtualKeyStore }),
    clock,
    ...(config.accessToken === undefined ? {} : { accessToken: config.accessToken }),
    ...(config.virtualKeysEnabled === true ? { virtualKeys: true } : {}),
    // deny-first：放行必须是显式选择，不能是"忘了配"的副产品。三态语义：
    //   true  = 显式放行（AG_DATA_PLANE_PERMISSIVE=1）；
    //   false = 显式按默认拒绝跑（测试验"忘了配凭据"时用）；
    //   未设  = 看装配模式——`mode:'test'` 是进程内装配（不起公网，transport 还是
    //           mock），保持历史行为；其余模式（生产 / 演示）忘了配凭据就是整个
    //           关掉（503），不是谁都能进。理由见 auth/data-plane.ts 文件头。
    ...(permissiveDataPlane === true ? { permissive: true } : {}),
  });

  // ---- 运行时设置（P0-2）----
  // 加密存储最高层的可写入口。`config` 传的是**同一个引用**，改设置就是改
  // pipeline 各阶段经 `deps.config` 读到的那个对象（热生效）。
  const settingsService =
    options.recordStore === undefined
      ? undefined
      : new SettingsService({
          store: options.recordStore,
          clock,
          config,
          // 第三层（配置文件）的缺省路径。文件不存在 = 没有这一层
          // （loadLayeredConfigFile 的既有立场），所以给个默认值不会改变
          // 「没配文件」的部署的行为。
          configFilePath: options.configFilePath ?? DEFAULT_CONFIG_FILE_PATH,
          ...(options.settingsEnv === undefined ? {} : { env: options.settingsEnv }),
          runtime: {
            modelSync,
            pluginHost,
            // Agent 组设置项推到本 gateway 自己的枢纽（按实例，不按进程）
            agent: { set: (field, value) => agentConfigHub.set(field, value) },
          },
        });
  let settingsLoaded: Promise<number> | undefined;
  /**
   * 管理面装配（在下面才建；这里先放一个可变盒子，让 loadSettings 能延迟取到）。
   *
   * 为什么 loadSettings 要顺带刷新 provider 运行时投影：S2 的路由准入
   * （ProviderStateFilter 的 `isConfigured`）读的是 `providerRuntime` 这份内存投影，
   * 而它**只在管理面 CRUD 时刷新**。不补这一步，重启之后投影是空的——已建好的
   * 渠道全部变成"没配过"，请求会被一句"没配渠道"挡在门外，直到有人在界面上碰一次
   * 渠道才恢复。那种"重启后才坏"的故障最难归因，所以在启动钩子里补齐。
   */
  const adminRef: { current?: AdminAssembly } = {};
  const loadSettings = (): Promise<number> => {
    if (settingsService === undefined) return Promise.resolve(0);
    settingsLoaded ??= (async () => {
      const loaded = await settingsService.load();
      await adminRef.current?.adminService.refreshProviderRuntime();
      return loaded;
    })();
    return settingsLoaded;
  };

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

  const deepseekBalanceClient = new DeepSeekBalanceClient({
    transport,
    headersProvider: async () => {
      const { headers } = await credentialResolver.headersFor(
        'deepseek.openai-chat',
        systemProbeCtx(clock),
      );
      return headers;
    },
  });
  const mimoBalanceClient = new MiMoBalanceClient({
    transport,
    headersProvider: async () => {
      const { headers } = await credentialResolver.headersFor(
        'mimo.openai-chat',
        systemProbeCtx(clock),
      );
      return headers;
    },
  });

  const routingTelemetry =
    options.routingTelemetry ??
    new DefaultRoutingTelemetryHub({
      clock,
      providerProfiles,
      usageReader: {
        list: (fromTs, toTs) => {
          if (options.usageSource !== undefined) {
            return options.usageSource.list(fromTs, toTs).map((r) => ({
              request_id: r.request_id,
              ts: r.ts,
              provider: r.provider,
              usage: r.usage,
              cost: {
                cash: r.cost.cash,
                ...(r.cost.currency === undefined ? {} : { currency: r.cost.currency }),
              },
            }));
          }
          if (usageSink !== undefined) {
            return usageSink.records
              .filter((r) => r.ts >= fromTs && r.ts < toTs)
              .map((r) => ({
                request_id: r.request_id,
                ts: r.ts,
                provider: r.provider,
                usage: r.usage,
                cost: {
                  cash: r.cost.cash,
                  ...(r.cost.currency === undefined ? {} : { currency: r.cost.currency }),
                },
              }));
          }
          return [];
        },
      },
      providerState: {
        isUnavailable: (provider) => providerRuntime.isUnavailable(provider),
        isConfigured: (provider) =>
          providerRuntime.get(provider) !== undefined || staticDeclared.has(provider),
        consecutiveFailures: (provider) =>
          providerRuntime.get(provider)?.auto_disabled?.consecutive_failures ?? 0,
      },
    });

  const telemetryRefresher = async (): Promise<void> => {
    const asRecord = (v: unknown): Record<string, unknown> | undefined =>
      typeof v === 'object' && v !== null && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
    const fetchJsonWithAuth = async (
      accessPath: string,
      baseUrl: string,
      path: string,
      extraHeaders: Record<string, string> = {},
    ): Promise<{ status: number; data?: Record<string, unknown> }> => {
      const { headers } = await credentialResolver.headersFor(accessPath, systemProbeCtx(clock));
      const res = await transport.send({
        method: 'GET',
        base_url: baseUrl,
        path,
        headers: { accept: 'application/json', ...headers, ...extraHeaders },
        stream: false,
      });
      if (res.status < 200 || res.status >= 300 || res.body === undefined) {
        return { status: res.status };
      }
      const parsed = JSON.parse(res.body.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: res.status };
      }
      return { status: res.status, data: parsed as Record<string, unknown> };
    };

    // DeepSeek 余额快照（支持多个 deepseek* 渠道实例）
    const deepseekTargets = new Map<string, { accessPath: string; baseUrl: string }>();
    const defaultDeepseekPath = ['deepseek.openai-chat', 'deepseek.anthropic-messages'].find(
      (ap) => credentialResolver.credentialsFor(ap).length > 0,
    );
    if (defaultDeepseekPath !== undefined) {
      deepseekTargets.set('deepseek', {
        accessPath: defaultDeepseekPath,
        baseUrl: 'https://api.deepseek.com',
      });
    }
    for (const entry of providerRuntime.entries()) {
      if (
        entry.enabled &&
        (entry.id === 'deepseek' ||
          entry.id.startsWith('deepseek-') ||
          entry.base_url.includes('api.deepseek.com')) &&
        credentialResolver.credentialsFor(entry.access_path).length > 0
      ) {
        deepseekTargets.set(entry.id, {
          accessPath: entry.access_path,
          baseUrl: 'https://api.deepseek.com',
        });
      }
    }
    for (const [providerId, target] of deepseekTargets.entries()) {
      try {
        if (providerId === 'deepseek' && target.accessPath === 'deepseek.openai-chat') {
          const snap = await deepseekBalanceClient.snapshot();
          const primary = snap.balance.balance_infos[0];
          if (primary !== undefined) {
            routingTelemetry.updateBalance(providerId, {
              balance: parseDecimalOrZero(primary.total_balance),
              granted_balance: parseDecimalOrZero(primary.granted_balance),
              topped_up_balance: parseDecimalOrZero(primary.topped_up_balance),
              currency: primary.currency || 'CNY',
              available: snap.balance.is_available,
              fetched_at: snap.fetched_at,
            });
            routingTelemetry.updateSubscriptionQuota(providerId, {
              balance_supported: true,
              fetched_at: snap.fetched_at,
            });
          }
        } else {
          const res = await fetchJsonWithAuth(target.accessPath, target.baseUrl, '/user/balance');
          const infos = Array.isArray(res.data?.['balance_infos'])
            ? (res.data['balance_infos'] as Array<Record<string, unknown>>)
            : [];
          const primary = infos[0];
          if (primary !== undefined) {
            routingTelemetry.updateBalance(providerId, {
              balance: parseDecimalOrZero(String(primary['total_balance'] ?? '0')),
              granted_balance: parseDecimalOrZero(String(primary['granted_balance'] ?? '0')),
              topped_up_balance: parseDecimalOrZero(String(primary['topped_up_balance'] ?? '0')),
              currency: typeof primary['currency'] === 'string' ? primary['currency'] : 'CNY',
              available: res.data?.['is_available'] !== false,
              fetched_at: clock.now(),
            });
            routingTelemetry.updateSubscriptionQuota(providerId, {
              balance_supported: true,
              fetched_at: clock.now(),
            });
          }
        }
      } catch {
        // 遥测刷新失败或 key 不支持时不阻塞主链路
      }
    }

    // MiMo Token Plan 积分 / 按量余额快照（支持多个 mimo* 渠道实例）
    const mimoTargets = new Map<string, { accessPath: string; baseUrl: string }>();
    if (credentialResolver.credentialsFor('mimo.openai-chat').length > 0) {
      mimoTargets.set('mimo', {
        accessPath: 'mimo.openai-chat',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com',
      });
    }
    for (const entry of providerRuntime.entries()) {
      if (
        entry.enabled &&
        (entry.id === 'mimo' ||
          entry.id.startsWith('mimo-') ||
          entry.base_url.includes('xiaomimimo.com')) &&
        credentialResolver.credentialsFor(entry.access_path).length > 0
      ) {
        mimoTargets.set(entry.id, {
          accessPath: entry.access_path,
          baseUrl: entry.base_url.replace(/\/+$/, ''),
        });
      }
    }
    for (const [providerId, target] of mimoTargets.entries()) {
      try {
        if (providerId === 'mimo' && target.accessPath === 'mimo.openai-chat') {
          const mimoCreds = credentialResolver.credentialsFor('mimo.openai-chat');
          const modeForMimo = credentialResolver.billingModeFor?.('mimo.openai-chat', mimoCreds[0]);
          const snap = await mimoBalanceClient.snapshot(modeForMimo);
          if (snap.kind === 'token_plan') {
            routingTelemetry.updateCredits(providerId, {
              remaining_credits: snap.info.quota.remaining_credits,
              used_credits: snap.info.quota.used_credits,
              total_credits: snap.info.quota.total_credits,
              fetched_at: clock.now(),
            });
            routingTelemetry.updateSubscriptionQuota(providerId, {
              balance_supported: true,
              plan_type: snap.info.plan_code || 'token_plan',
              period_start: snap.info.period.start_at,
              period_end: snap.info.period.end_at,
              fetched_at: clock.now(),
            });
          } else {
            const primary = snap.info.balance_infos[0];
            if (primary !== undefined) {
              routingTelemetry.updateBalance(providerId, {
                balance: parseDecimalOrZero(primary.total_available),
                currency: primary.currency || 'CNY',
                available: snap.info.is_available,
                fetched_at: clock.now(),
              });
              routingTelemetry.updateSubscriptionQuota(providerId, {
                balance_supported: true,
                plan_type: 'payg',
                fetched_at: clock.now(),
              });
            }
          }
        } else {
          const isPlan = target.baseUrl.includes('token-plan');
          const res = await fetchJsonWithAuth(
            target.accessPath,
            target.baseUrl,
            isPlan ? '/v1/platform/token_plan' : '/v1/platform/balance',
          );
          if (isPlan && res.data !== undefined) {
            const quota = asRecord(res.data['quota']);
            const period = asRecord(res.data['period']);
            if (quota !== undefined && typeof quota['remaining_credits'] === 'number') {
              routingTelemetry.updateCredits(providerId, {
                remaining_credits: quota['remaining_credits'],
                used_credits: typeof quota['used_credits'] === 'number' ? quota['used_credits'] : 0,
                total_credits: typeof quota['total_credits'] === 'number' ? quota['total_credits'] : 0,
                fetched_at: clock.now(),
              });
              routingTelemetry.updateSubscriptionQuota(providerId, {
                balance_supported: true,
                plan_type: typeof res.data['plan_code'] === 'string' ? res.data['plan_code'] : 'token_plan',
                ...(typeof period?.['start_at'] === 'string' ? { period_start: period['start_at'] } : {}),
                ...(typeof period?.['end_at'] === 'string' ? { period_end: period['end_at'] } : {}),
                fetched_at: clock.now(),
              });
            }
          } else if (!isPlan && res.data !== undefined) {
            const infos = Array.isArray(res.data['balance_infos'])
              ? (res.data['balance_infos'] as Array<Record<string, unknown>>)
              : [];
            const primary = infos[0];
            if (primary !== undefined) {
              routingTelemetry.updateBalance(providerId, {
                balance: parseDecimalOrZero(String(primary['total_available'] ?? '0')),
                currency: typeof primary['currency'] === 'string' ? primary['currency'] : 'CNY',
                available: res.data['is_available'] !== false,
                fetched_at: clock.now(),
              });
              routingTelemetry.updateSubscriptionQuota(providerId, {
                balance_supported: true,
                plan_type: 'payg',
                fetched_at: clock.now(),
              });
            }
          }
        }
      } catch {
        // 遥测刷新失败或 key 不支持时不阻塞主链路
      }
    }

    // OpenAI Codex (ChatGPT 订阅 5h / 周 / 额度)
    const codexTargets = new Map<string, string>();
    if (credentialResolver.credentialsFor('openai-codex.openai-responses').length > 0) {
      codexTargets.set('openai-codex', 'openai-codex.openai-responses');
    }
    for (const entry of providerRuntime.entries()) {
      if (
        entry.enabled &&
        (entry.id === 'openai-codex' ||
          entry.id.startsWith('openai-codex-') ||
          entry.base_url.includes('chatgpt.com')) &&
        credentialResolver.credentialsFor(entry.access_path).length > 0
      ) {
        codexTargets.set(entry.id, entry.access_path);
      }
    }
    for (const [providerId, accessPath] of codexTargets.entries()) {
      try {
        const res = await fetchJsonWithAuth(
          accessPath,
          'https://chatgpt.com',
          '/backend-api/wham/usage',
          { originator: 'codex_cli_rs' },
        );
        if (res.data !== undefined && (res.data['rate_limit'] !== undefined || res.data['credits'] !== undefined || res.data['plan_type'] !== undefined)) {
          const rl = asRecord(res.data['rate_limit']);
          const primary = asRecord(rl?.['primary_window']);
          const secondary = asRecord(rl?.['secondary_window']);
          const creditsObj = asRecord(res.data['credits']);
          const parseWin = (w: Record<string, unknown> | undefined) => {
            if (w === undefined) return undefined;
            const usedPct = typeof w['used_percent'] === 'number' ? w['used_percent'] : undefined;
            const limitSec =
              typeof w['limit_window_seconds'] === 'number' ? w['limit_window_seconds'] : undefined;
            const resetAfter =
              typeof w['reset_after_seconds'] === 'number' ? w['reset_after_seconds'] : undefined;
            const resetAt = typeof w['reset_at'] === 'number' ? w['reset_at'] : undefined;
            return {
              ...(usedPct === undefined ? {} : { used_percent: usedPct }),
              ...(limitSec === undefined ? {} : { limit_window_seconds: limitSec }),
              ...(resetAfter === undefined ? {} : { reset_after_seconds: resetAfter }),
              ...(resetAt === undefined ? {} : { reset_at: resetAt }),
            };
          };
          const h5 = parseWin(primary);
          const weekly = parseWin(secondary);
          const planType =
            typeof res.data['plan_type'] === 'string' ? res.data['plan_type'] : undefined;
          const balRaw = creditsObj?.['balance'];
          if (typeof balRaw === 'number' || typeof balRaw === 'string') {
            const balNum = typeof balRaw === 'number' ? balRaw : parseDecimalOrZero(balRaw);
            routingTelemetry.updateBalance(providerId, {
              balance: balNum,
              currency: 'USD',
              available: true,
              fetched_at: clock.now(),
            });
          }
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: true,
            quota_status: 'ok',
            ...(planType === undefined ? {} : { plan_type: planType }),
            ...(h5 === undefined ? {} : { h5 }),
            ...(weekly === undefined ? {} : { weekly }),
            fetched_at: clock.now(),
          });
        } else if (res.status === 401 || res.status === 403) {
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: false,
            quota_status: 'unauthorized',
            quota_message: '凭据无权限',
            fetched_at: clock.now(),
          });
        } else if (res.status === 404) {
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: false,
            quota_status: 'unsupported',
            fetched_at: clock.now(),
          });
        }
      } catch {
        // 不支持或网络异常时忽略
      }
    }

    // OpenCode Go (5h / 周 / 月订阅限额)
    const opencodeTargets = new Map<string, string>();
    const defaultOpencodePath = [
      'opencode-go.openai-chat',
      'opencode-go.openai-responses',
      'opencode-go.anthropic-messages',
    ].find((ap) => credentialResolver.credentialsFor(ap).length > 0);
    if (defaultOpencodePath !== undefined) {
      opencodeTargets.set('opencode-go', defaultOpencodePath);
    }
    for (const entry of providerRuntime.entries()) {
      if (
        entry.enabled &&
        (entry.id === 'opencode-go' ||
          entry.id.startsWith('opencode-go-') ||
          entry.base_url.includes('opencode.ai/zen/go')) &&
        credentialResolver.credentialsFor(entry.access_path).length > 0
      ) {
        opencodeTargets.set(entry.id, entry.access_path);
      }
    }
    for (const [providerId, accessPath] of opencodeTargets.entries()) {
      try {
        const res = await fetchJsonWithAuth(
          accessPath,
          'https://opencode.ai',
          '/zen/go/v1/usage',
        );
        if (res.data !== undefined) {
          const d = asRecord(res.data['usage']) ?? res.data;
          const parseOpenCodeWin = (obj: unknown) => {
            const rec = asRecord(obj);
            if (!rec) return undefined;
            const pct =
              typeof rec['usagePercent'] === 'number'
                ? rec['usagePercent']
                : typeof rec['used_percent'] === 'number'
                  ? rec['used_percent']
                  : typeof rec['percent'] === 'number'
                    ? rec['percent']
                    : undefined;
            const usedUsd =
              typeof rec['usageDollars'] === 'number' ? rec['usageDollars'] : undefined;
            const limitUsd =
              typeof rec['limitDollars'] === 'number' ? rec['limitDollars'] : undefined;
            const resetAfterRaw =
              typeof rec['resetInSec'] === 'number'
                ? rec['resetInSec']
                : typeof rec['reset_after_seconds'] === 'number'
                  ? rec['reset_after_seconds']
                  : undefined;
            const resetsAtRaw =
              typeof rec['resetsAt'] === 'string'
                ? rec['resetsAt']
                : typeof rec['resetAt'] === 'string'
                  ? rec['resetAt']
                  : undefined;
            let resetAt: number | undefined;
            let resetAfter = resetAfterRaw;
            if (resetsAtRaw !== undefined) {
              const ms = Date.parse(resetsAtRaw);
              if (Number.isFinite(ms)) {
                resetAt = Math.floor(ms / 1000);
                if (resetAfter === undefined) {
                  resetAfter = Math.max(0, Math.floor((ms - clock.now()) / 1000));
                }
              }
            }
            const derivedPct =
              pct ??
              (usedUsd !== undefined && limitUsd !== undefined && limitUsd > 0
                ? Math.round((usedUsd / limitUsd) * 10000) / 100
                : undefined);
            if (derivedPct === undefined && usedUsd === undefined && limitUsd === undefined) {
              return undefined;
            }
            return {
              ...(derivedPct === undefined ? {} : { used_percent: derivedPct }),
              ...(usedUsd === undefined ? {} : { used_usd: usedUsd }),
              ...(limitUsd === undefined ? {} : { limit_usd: limitUsd }),
              ...(resetAt === undefined ? {} : { reset_at: resetAt }),
              ...(resetAfter === undefined ? {} : { reset_after_seconds: resetAfter }),
            };
          };
          const h5 = parseOpenCodeWin(
            d['rolling'] ??
              d['rolling5h'] ??
              d['five_hour'] ??
              d['fiveHour'] ??
              d['h5'] ??
              asRecord(d['windows'])?.['five_hour'],
          );
          const weekly = parseOpenCodeWin(
            d['weekly'] ?? d['week'] ?? asRecord(d['windows'])?.['weekly'],
          );
          const monthly = parseOpenCodeWin(
            d['monthly'] ?? d['month'] ?? asRecord(d['windows'])?.['monthly'],
          );
          const hasAnyMetric = h5 !== undefined || weekly !== undefined || monthly !== undefined;
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: hasAnyMetric,
            quota_status: hasAnyMetric ? 'ok' : 'unsupported',
            ...(hasAnyMetric
              ? {
                  plan_type:
                    typeof d['plan'] === 'string'
                      ? d['plan']
                      : typeof res.data['plan'] === 'string'
                        ? res.data['plan']
                        : 'go',
                  ...(h5 === undefined ? {} : { h5 }),
                  ...(weekly === undefined ? {} : { weekly }),
                  ...(monthly === undefined ? {} : { monthly }),
                }
              : {
                  plan_type: 'go',
                  quota_message: '响应格式暂未识别',
                }),
            fetched_at: clock.now(),
          });
        } else if (res.status === 401 || res.status === 403) {
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: false,
            quota_status: 'unauthorized',
            plan_type: 'go',
            quota_message: '凭据无权限',
            fetched_at: clock.now(),
          });
        } else if (res.status === 404) {
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: false,
            quota_status: 'unsupported',
            fetched_at: clock.now(),
          });
        }
      } catch {
        // 不支持或网络异常时忽略
      }
    }

    // xAI / Grok 订阅配额（cli-chat-proxy.grok.com/v1/billing?format=credits）
    const xaiTargets = new Map<string, string>();
    const defaultXaiPath = ['xai.openai-responses', 'xai.openai-chat'].find(
      (ap) => credentialResolver.credentialsFor(ap).length > 0,
    );
    if (defaultXaiPath !== undefined) {
      xaiTargets.set('xai', defaultXaiPath);
    }
    for (const entry of providerRuntime.entries()) {
      if (
        entry.enabled &&
        (entry.id === 'xai' ||
          entry.id.startsWith('xai-') ||
          entry.id.includes('grok') ||
          entry.base_url.includes('api.x.ai') ||
          entry.base_url.includes('grok.com')) &&
        credentialResolver.credentialsFor(entry.access_path).length > 0
      ) {
        xaiTargets.set(entry.id, entry.access_path);
      }
    }
    for (const [providerId, accessPath] of xaiTargets.entries()) {
      try {
        const res = await fetchJsonWithAuth(
          accessPath,
          'https://cli-chat-proxy.grok.com',
          '/v1/billing?format=credits',
          { 'x-xai-token-auth': 'xai-grok-cli' },
        );
        if (res.data !== undefined) {
          const cfg = asRecord(res.data['config']) ?? res.data;
          const period = asRecord(cfg?.['currentPeriod'] ?? res.data['currentPeriod']);
          const rawPct =
            period?.['creditUsagePercent'] ??
            cfg?.['creditUsagePercent'] ??
            res.data['creditUsagePercent'];
          // Grok proto3 序列化在 0% 时会省略 creditUsagePercent 字段；只要存在 currentPeriod 即按 0% 处理
          const usedPct =
            typeof rawPct === 'number'
              ? rawPct
              : period !== undefined
                ? 0
                : undefined;
          const resetRaw =
            period?.['endTime'] ??
            period?.['nextResetTime'] ??
            period?.['resetAt'] ??
            cfg?.['nextResetTime'];
          let resetAt: number | undefined;
          if (typeof resetRaw === 'number' && Number.isFinite(resetRaw)) {
            resetAt = resetRaw > 10_000_000_000 ? Math.floor(resetRaw / 1000) : resetRaw;
          } else if (typeof resetRaw === 'string' && resetRaw.trim() !== '') {
            const ms = Date.parse(resetRaw);
            if (Number.isFinite(ms)) resetAt = Math.floor(ms / 1000);
          }
          const periodType =
            typeof period?.['periodType'] === 'string'
              ? period['periodType']
              : typeof period?.['type'] === 'string'
                ? period['type']
                : 'WEEKLY';
          const winObj =
            usedPct === undefined
              ? undefined
              : {
                  used_percent: usedPct,
                  ...(resetAt === undefined ? {} : { reset_at: resetAt }),
                };
          const planType =
            typeof res.data['tier'] === 'string'
              ? res.data['tier']
              : typeof cfg?.['tier'] === 'string'
                ? cfg['tier']
                : 'grok-sub';
          const prepaid =
            typeof cfg?.['prepaidBalance'] === 'number'
              ? cfg['prepaidBalance']
              : typeof res.data['balance'] === 'number'
                ? res.data['balance']
                : undefined;
          if (prepaid !== undefined) {
            routingTelemetry.updateBalance(providerId, {
              balance: prepaid,
              currency: 'USD',
              available: true,
              fetched_at: clock.now(),
            });
          }
          if (winObj !== undefined || prepaid !== undefined) {
            const isMonthly = periodType.toUpperCase().includes('MONTH');
            const is5h =
              periodType.toUpperCase().includes('HOUR') || periodType.toUpperCase().includes('5H');
            routingTelemetry.updateSubscriptionQuota(providerId, {
              balance_supported: true,
              quota_status: 'ok',
              plan_type: planType,
              ...(winObj === undefined
                ? {}
                : isMonthly
                  ? { monthly: winObj }
                  : is5h
                    ? { h5: winObj }
                    : { weekly: winObj }),
              fetched_at: clock.now(),
            });
          }
        } else if (res.status === 401 || res.status === 403) {
          // 仅 OAuth 订阅凭据期望支持此端点；普通 xai- API key 不报错直接忽略
          const cred0 = credentialResolver.credentialsFor(accessPath)[0];
          const isStaticApiKey =
            cred0?.storage.location === 'env' ||
            (cred0?.id.startsWith('env:') ?? false);
          if (!isStaticApiKey) {
            routingTelemetry.updateSubscriptionQuota(providerId, {
              balance_supported: false,
              quota_status: 'unauthorized',
              plan_type: 'grok-sub',
              quota_message: '凭据无权限',
              fetched_at: clock.now(),
            });
          }
        }
      } catch {
        // 不支持或网络异常时忽略
      }
    }

    // OpenRouter (/api/v1/credits) —— 支持多个 openrouter* 渠道实例
    const openrouterTargets = new Map<string, string>();
    const defaultOpenrouterPath = [
      'openrouter.openai-chat',
      'openrouter.openai-responses',
      'openrouter.anthropic-messages',
    ].find((ap) => credentialResolver.credentialsFor(ap).length > 0);
    if (defaultOpenrouterPath !== undefined) {
      openrouterTargets.set('openrouter', defaultOpenrouterPath);
    }
    for (const entry of providerRuntime.entries()) {
      if (
        entry.enabled &&
        (entry.id === 'openrouter' ||
          entry.id.startsWith('openrouter-') ||
          entry.base_url.includes('openrouter.ai')) &&
        credentialResolver.credentialsFor(entry.access_path).length > 0
      ) {
        openrouterTargets.set(entry.id, entry.access_path);
      }
    }
    for (const [providerId, accessPath] of openrouterTargets.entries()) {
      try {
        const res = await fetchJsonWithAuth(
          accessPath,
          'https://openrouter.ai',
          '/api/v1/credits',
        );
        const dataObj = asRecord(res.data?.['data']) ?? res.data;
        if (dataObj !== undefined) {
          const total = typeof dataObj['total_credits'] === 'number' ? dataObj['total_credits'] : undefined;
          const used = typeof dataObj['total_usage'] === 'number' ? dataObj['total_usage'] : undefined;
          if (total !== undefined && used !== undefined) {
            const remaining = Math.max(0, Math.round((total - used) * 1_000_000) / 1_000_000);
            routingTelemetry.updateCredits(providerId, {
              total_credits: total,
              used_credits: used,
              remaining_credits: remaining,
              fetched_at: clock.now(),
            });
            routingTelemetry.updateBalance(providerId, {
              balance: remaining,
              currency: 'USD',
              available: true,
              fetched_at: clock.now(),
            });
            routingTelemetry.updateSubscriptionQuota(providerId, {
              balance_supported: true,
              fetched_at: clock.now(),
            });
          }
        } else if (res.status === 401 || res.status === 403 || res.status === 404) {
          routingTelemetry.updateSubscriptionQuota(providerId, {
            balance_supported: false,
            fetched_at: clock.now(),
          });
        }
      } catch {
        // 不支持或网络异常时忽略
      }
    }
  };

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
  const enrichEntryWithModelsDev = <T extends Partial<CapabilityEntry> & { model?: string }>(
    base: T,
    modelId: string,
  ): T => {
    const offline = enrichModelsWithOfflineMetadata([{ id: modelId }])[0];
    if (offline === undefined) return base;
    const irIn = offline.input_modalities?.filter(
      (m): m is 'text' | 'image' => m === 'text' || m === 'image',
    );
    const irOut = offline.output_modalities?.filter((m): m is 'text' => m === 'text');
    return {
      ...base,
      ...(base.context_window === undefined && offline.context_window !== undefined
        ? { context_window: offline.context_window }
        : {}),
      ...(base.max_output_tokens === undefined && offline.max_output_tokens !== undefined
        ? { max_output_tokens: offline.max_output_tokens }
        : {}),
      ...(base.input_modalities === undefined && irIn !== undefined && irIn.length > 0
        ? { input_modalities: irIn }
        : {}),
      ...(base.output_modalities === undefined && irOut !== undefined && irOut.length > 0
        ? { output_modalities: irOut }
        : {}),
    };
  };

  const knownCatalogCaps: CapabilityEntry[] = [
    ...deepseekCapabilities(),
    ...mimoCapabilities(),
  ].map((entry) => enrichEntryWithModelsDev(entry, entry.model));
  const dynamicProviderCaps = new Map<string, CapabilityEntry[]>();
  const mountProviderExtras = (providerId: string, extras: readonly CapabilityEntry[]): void => {
    const registered: CapabilityEntry[] = [...(dynamicProviderCaps.get(providerId) ?? [])];
    for (const rawEntry of extras) {
      const entry = enrichEntryWithModelsDev(rawEntry, rawEntry.model);
      if (capabilityRegistry.find(entry.access_path, entry.model, entry.modality) !== undefined) {
        continue;
      }
      capabilityRegistry.register(entry);
      registered.push(entry);
    }
    dynamicProviderCaps.set(providerId, registered);
  };

  const admin = assembleAdmin({
    mode,
    options,
    capabilityRegistry,
    credentialResolver,
    clock,
    usageSink,
    providerRuntime,
    transport,
    config,
    routeGraphs,
    routingTelemetry,
    telemetryRefresher,
    pluginHost,
    onChannelActivated: (provider, accessPath) => {
      if (provider.id === 'deepseek') {
        const extras: CapabilityEntry[] = [...deepseekAudioCapabilities()];
        if (provider.model_source.kind !== 'static') {
          extras.push(...deepseekCapabilities().filter((c) => c.access_path === accessPath));
        }
        mountProviderExtras(provider.id, extras);
      } else if (provider.id === 'mimo') {
        const extras: CapabilityEntry[] = [...mimoAudioCapabilities()];
        if (provider.model_source.kind !== 'static') {
          extras.push(...mimoCapabilities().filter((c) => c.access_path === accessPath));
        }
        mountProviderExtras(provider.id, extras);
      }
    },
    onChannelDeactivated: (providerId) => {
      const existing = dynamicProviderCaps.get(providerId);
      if (existing === undefined) return;
      for (const e of existing) {
        capabilityRegistry.unregister(e.access_path, e.model, e.modality);
      }
      dynamicProviderCaps.delete(providerId);
    },
    enrichStaticCapability: (provider, model) => {
      const ap = `${provider.id}.${provider.dialect.replace('.', '-')}`;
      const matched =
        knownCatalogCaps.find((c) => c.access_path === ap && c.model === model) ??
        knownCatalogCaps.find((c) => c.model === model);
      return enrichEntryWithModelsDev(matched ?? {}, model);
    },
    // 内置对话端点（95 §6.1）。除推理链路外的依赖都在这里齐；runner 用 thunk
    // 延迟取——它在这一段之后才构造，而狗粮调用必须走网关自己的 pipeline。
    agentChat: {
      configHub: agentConfigHub,
      recorder: toolRecorder,
      history:
        options.recordStore === undefined
          ? undefined
          : new EncryptedAgentHistoryStore(options.recordStore, clock),
      runTurn: (input, sink) => runner.run(input, sink),
      // 回合计时（96 §3.5 的 duration_ms）：与管理面同一个 Clock 实例。
      // 不传就没有这个字段——不拿前端 performance.now() 冒充服务端口径。
      clock,
    },
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
    ...(virtualKeyStore === undefined ? {} : { virtualKeys: virtualKeyStore }),
    dataPlaneAuth,
    // 管理面的能力矩阵端点与 `/v1/models` 共用同一个可用性端口与 provider 解析器
    // （建一次、注入两处；不写第二套判据）
    providerAvailability,
    providerOfAccessPath,
    ...(settingsService === undefined ? {} : { settings: settingsService }),
  });
  isModelHiddenFn = (modelId) => admin?.adminService.isModelHidden(modelId) ?? false;

  // ---- 内置 Agent 管理插件（95 §3）----
  // 必须在 assembleAdmin 之后：它要复用 adminService（列渠道 / 列凭据 / 建 key），
  // 而 adminService 在那之前还不存在。注册点只有这一处（options.plugins 那个循环
  // 在更前面，看不见 adminService）。
  if (admin !== undefined) {
    pluginHost.register(
      createAgentAdminPlugin({
        adminService: admin.adminService,
        aliasResolver: admin.aliasResolver,
        configHub: agentConfigHub,
        recorder: toolRecorder,
      }),
      {},
    );
  }

  // 启动钩子（loadSettings）要能刷新渠道投影，这里把装配结果交给他（见 adminRef 注释）
  adminRef.current = admin;
  // 装配即刷一次（不 await）：管理面 CRUD 与 loadSettings 之外的第三条刷新路径。
  void adminRef.current?.adminService.refreshProviderRuntime();

  // ---- 路由 ----
  const isScaffoldingTarget = (attempt: Attempt, req: RouteRequest): boolean =>
    credentialResolver.accessPath(attempt.access_path)?.requires_credential === false ||
    capabilityRegistry.find(attempt.access_path, attempt.model, req.modality)?.internal === true;
  const routeHooks: RouteHooks =
    admin === undefined
      ? NOOP_ROUTE_HOOKS
      : new ProviderStateFilter(
          {
            isUnavailable: (provider) => providerRuntime.isUnavailable(provider),
            isConfigured: (provider) =>
              providerRuntime.get(provider) !== undefined || staticDeclared.has(provider),
          },
          isScaffoldingTarget,
        );
  const router = new StaticRouter(
    routeTable,
    capabilityRegistry,
    credentialResolver,
    routeHooks,
    admin?.aliasResolver ?? options.aliasResolver,
    routeGraphs,
    routingTelemetry,
  );
  container.registerValue(TOKENS.Router, router);
  // ---- 定价服务（S10 + 工具/音频/模态端点共用同一个分层聚合定价实例）----
  const channelPricingResolver: ChannelPricingResolver = {
    pricingFor(accessPathOrProvider: string) {
      const byId = providerRuntime.get(accessPathOrProvider);
      if (byId?.pricing !== undefined) return byId.pricing;
      for (const entry of providerRuntime.entries()) {
        if (entry.access_path === accessPathOrProvider && entry.pricing !== undefined) {
          return entry.pricing;
        }
      }
      return undefined;
    },
  };
  const pricingService =
    options.pricingService ?? createDefaultPricingService(channelPricingResolver);

  // ---- 独立工具端点（DeepSeek 全家桶 + MiMo 音频两个）----
  // 五个 DeepSeek 端点共用 DeepSeek 的 key 与 base URL（与两条 chat access path
  // 同一账号），鉴权头每次调用现取（轮换 key 不用重启）。
  // MiMo 的两个音频端点路径带 `/mimo/` 前缀（`/v1/tools/mimo/{tts,asr}`）：与
  // DeepSeek 的 `/v1/tools/{tts,asr}` 不撞车——`createToolEndpoints` 按 path 建 Map，
  // 同路径后注册的会被静默 shadow，那种"配了但不生效"正是要避免的失败模式。
  const deepseekHeadersProvider = deepseekHeadersProviderFor(credentialResolver, clock);
  const mimoHeadersProvider = mimoHeadersProviderFor(credentialResolver, clock);
  const deepseekToolClients = {
    search: new DeepSeekSearchClient({
      transport,
      headersProvider: deepseekHeadersProvider,
    }),
    fetch: new DeepSeekFetchClient({
      transport,
      headersProvider: deepseekHeadersProvider,
    }),
    ocr: new DeepSeekOcrClient({
      transport,
      headersProvider: deepseekHeadersProvider,
    }),
    asr: new DeepSeekAsrClient({
      transport,
      headersProvider: deepseekHeadersProvider,
    }),
    tts: new DeepSeekTtsClient({
      transport,
      headersProvider: deepseekHeadersProvider,
    }),
  };
  const deepseekHandlers = createDeepSeekToolHandlers(deepseekToolClients);
  const mimoHandlers = createMiMoToolHandlers({
    asr: new MiMoAsrClient({ transport, headersProvider: mimoHeadersProvider }),
    tts: new MiMoTtsClient({ transport, headersProvider: mimoHeadersProvider }),
  });
  const toolHandlers: ToolEndpointHandler[] = [...deepseekHandlers, ...mimoHandlers];
  // 计费路径判据（订阅/按量）从凭据层按 access path 问：判据是 key 前缀
  // （`tp-` = MiMo Token Plan 订阅，`sk-` = 按量，官方文档明文）。
  const billingModeFor = credentialResolver.billingModeFor?.bind(credentialResolver);
  const toolEndpoints = createToolEndpoints({
    handlers: toolHandlers,
    authenticator: dataPlaneAuth,
    usageEmitter: emitter,
    clock,
    ids,
    // 定价：这两个端点不走 S0–S10，自己算 cost（不接 = unpriced，不假装免费）
    pricingService,
    ...(billingModeFor === undefined ? {} : { billingModeFor }),
    ...(mode === 'test' ? {} : { log: (m) => logger.warn(m) }),
  });
  // ---- OpenAI 兼容音频端点（/v1/audio/speech、/v1/audio/transcriptions）----
  // 每个上游一张脸（dialect 编解码）+ 自己那两个 canonical handler。差别只在客户端
  // dialect 的编解码（providers/<provider>/audio-openai-face.ts）；上游调用走
  // `/v1/tools/*` 的同一条路（ToolEndpointHandler.run）。
  // 模型解析按 providers 顺序问，第一家认领的赢；DeepSeek 在前（它的模型名含
  // `tts-1` / `whisper-1` 这类 OpenAI 客户端名，MiMo 刻意不映射，见
  // providers/mimo/audio-models.ts 文件头）。
  const audioProviders: AudioEndpointProvider[] = [
    {
      face: DEEPSEEK_AUDIO_FACE,
      handlers: {
        tts: deepseekHandlers.find((h) => h.id === 'tts')!,
        asr: deepseekHandlers.find((h) => h.id === 'asr')!,
      },
      // 计费判据查 chat 那条 path（音频 access path 不在凭据启动表里，见
      // ToolUsageMeta.billing_access_path 的论证）
      billingAccessPath: 'deepseek.openai-chat',
    },
    {
      face: MIMO_AUDIO_FACE,
      handlers: {
        tts: mimoHandlers.find((h) => h.id === 'tts')!,
        asr: mimoHandlers.find((h) => h.id === 'asr')!,
      },
      billingAccessPath: 'mimo.openai-chat',
    },
  ];
  const audioEndpoints = createAudioEndpoints({
    providers: audioProviders,
    ...(admin?.aliasResolver === undefined ? {} : { aliasResolver: admin.aliasResolver }),
    capabilities: capabilityRegistry,
    authenticator: dataPlaneAuth,
    usageEmitter: emitter,
    clock,
    ids,
    // 定价：TTS（按字符）/ ASR（按音频秒）与 chat 同口径算 cost
    pricingService,
    ...(billingModeFor === undefined ? {} : { billingModeFor }),
    ...(mode === 'test' ? {} : { log: (m) => logger.warn(m) }),
  });
  // ---- fast path 准入（D-fastpath-2）：启动时计算并缓存 ----
  const fastPathAdmission = createFastPathAdmission(pluginHost);

  // ---- 模态端点（image / embedding / decision；不跑 pipeline，见 modality-endpoints.ts）----
  // 三个 adaptor 的上游共用同一个 transport 与凭据解析（key 走各自的环境变量：
  // AG_OPENAI_API_KEY）。缺 key 时调用以 key_invalid 失败——与 /v1/tools/* 同立场，
  // 不做「没有 key 就静默返回空」的假实现。
  const openaiHeadersProvider = async (): Promise<Record<string, string>> => {
    const candidates = ['openai.images', 'openai', 'openai.openai-responses', 'openai.responses'];
    for (const ap of candidates) {
      if (credentialResolver.credentialsFor(ap).length > 0) {
        const { headers } = await credentialResolver.headersFor(ap, systemProbeCtx(clock));
        return headers;
      }
    }
    const { headers } = await credentialResolver.headersFor('openai.images', systemProbeCtx(clock));
    return headers;
  };
  const imagesAdaptor = new OpenAIImagesAdaptor({
    client: new OpenAIImagesClient({ transport, headersProvider: openaiHeadersProvider }),
  });
  const embeddingsAdaptor = new OpenAIEmbeddingsAdaptor({
    transport,
    headersProvider: openaiHeadersProvider,
  });
  // decision：native 位是 mock（没有真上游 key），降级位是 chat 模拟（复用
  // openai.chat codec）。默认策略 on_missing_upstream + 高风险不降级（15 §6.5）。
  const decisionDegradation: DecisionDegradationPolicy =
    options.decisionDegradation ?? DEFAULT_DECISION_DEGRADATION_POLICY;
  const lastModalityCredId = new Map<string, string>();
  const resolveModalityTarget = (accessPath: string) => {
    const providerPrefix = accessPath.split('.')[0] ?? accessPath;
    const candidates = [
      accessPath,
      `${providerPrefix}.openai-responses`,
      `${providerPrefix}.openai-chat`,
      providerPrefix,
    ];
    const effectivePath =
      candidates.find((ap) => credentialResolver.credentialsFor(ap).length > 0) ?? accessPath;
    return {
      baseUrl: credentialResolver.baseUrlFor(effectivePath),
      headersProvider: async () => {
        const { headers, credential_id } = await credentialResolver.headersFor(
          effectivePath,
          systemProbeCtx(clock),
        );
        if (credential_id !== undefined) lastModalityCredId.set(accessPath, credential_id);
        return headers;
      },
    };
  };
  const modalityEndpoints =
    options.modalityEndpoints ??
    createModalityEndpoints({
      handlers: [
        ...createImagesEndpointHandlers(imagesAdaptor, resolveModalityTarget),
        createEmbeddingsEndpointHandler(embeddingsAdaptor, resolveModalityTarget),
        createDecisionsEndpointHandler({
          ...(mode === 'test' ? { native: new MockDecisionAdaptor() } : {}),
          degraded: new ChatSimulatedDecisionAdaptor(
            new TransportChatPort({
              transport,
              headersProvider: openaiHeadersProvider,
              clock,
            }),
            { chatModel: options.degradedChatModel ?? 'gpt-5.4' },
          ),
          policy: decisionDegradation,
        }),
      ],
      authenticator: dataPlaneAuth,
      ...(admin?.aliasResolver === undefined ? {} : { aliasResolver: admin.aliasResolver }),
      usageEmitter: emitter,
      clock,
      ids,
      pricing: pricingService,
      resolveCredentialId: (accessPath) =>
        lastModalityCredId.get(accessPath) ?? credentialResolver.credentialsFor(accessPath)[0]?.id,
      ...(mode === 'test' ? {} : { log: (m) => logger.warn(m) }),
    });

  // ---- PipelineRunner ----
  // 工具结果脱敏 + 工具调用记录：包在插件主机外面给 runner 用。
  // fast path 准入仍看**未包装**的那个主机（createFastPathAdmission 在上面，
  // 认的是 manifest 声明）——包装类只加事，不改准入判据。
  const toolObservingHost = new RedactingPluginHost(
    pluginHost,
    () => agentRedactionConfig(agentConfigHub.snapshot()),
    toolRecorder,
  );

  const runner = new PipelineRunner(
    {
      config,
      clock,
      logger,
      metrics,
      ids,
      transport,
      adaptors: adaptorRegistry,
      pluginHost: toolObservingHost,
      usageEmitter: emitter,
      credentialResolver,
      capabilityRegistry,
      router,
      fastPathAdmission,
      providerProfiles,
      // 与工具/音频端点同一个实例（一个请求只该被一套价格逻辑看到）
      pricingService,
      imageBridge: {
        generate: async ({ access_path, model, prompt }) => {
          const target = resolveModalityTarget(access_path);
          const req: import('./ir/index.js').CanonicalRequestEnvelope = {
            ir_version: 'ag-ir/1',
            kind: 'image',
            source_format: 'openai.images.generations',
            model,
            resolved_model: model,
            raw: {},
            payload: {
              kind: 'image',
              prompt,
              output: { n: 1 },
            } as unknown as import('./ir/index.js').CanonicalRequestEnvelope['payload'],
          };
          const outcome = await imagesAdaptor.generate(req, target);
          const payload = outcome.response.payload as {
            images?: Array<{
              image?: { kind?: string; uri?: string; data?: string };
              url?: string;
              b64_json?: string;
              revised_prompt?: string;
            }>;
          };
          const imgs = Array.isArray(payload.images) ? payload.images : [];
          const urls = imgs
            .map((i) => (i.image?.kind === 'uri' ? i.image.uri : i.url))
            .filter((u): u is string => typeof u === 'string' && u !== '');
          const b64_jsons = imgs
            .map((i) => (i.image?.kind === 'inline' ? i.image.data : i.b64_json))
            .filter((b): b is string => typeof b === 'string' && b !== '');
          return {
            urls,
            b64_jsons,
            ...(imgs[0]?.revised_prompt === undefined
              ? {}
              : { revised_prompt: imgs[0].revised_prompt }),
            usage: outcome.response.usage,
          };
        },
      },
      routingTelemetry,
      // provider 级默认 builtin tool 开关（S3 读；没注 admin 就没有任何默认开关）
      providerDefaults: providerRuntime,
      // 健康旁路（S5 读；实现自己吞错误，绝不影响请求结果）
      ...(admin === undefined
        ? {}
        : {
            providerHealth: {
              recordFailure: (provider: string, httpStatus: number) => {
                void admin.adminService
                  .recordUpstreamFailure('system:pipeline', provider, httpStatus)
                  .catch(() => {});
              },
              recordSuccess: (provider: string) => {
                void admin.adminService
                  .recordUpstreamSuccess('system:pipeline', provider)
                  .catch(() => {});
              },
            },
          }),
    },
    {
      // 数据面鉴权（66 §2）。不传 = S0 用 PERMISSIVE_AUTHENTICATOR，行为与本轮之前一致。
      authenticator: dataPlaneAuth,
    },
  );
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
    agentConfig: agentConfigHub,
    toolRecorder,
    fastPathAdmission,
    usageEmitter: emitter,
    transport,
    logger,
    metrics,
    ...(usageSink === undefined ? {} : { usageSink }),
    refreshModelCapabilities,
    refreshMiMoModelCapabilities,
    mimoBalanceClient,
    ...(lastDiscovery === undefined ? {} : { lastModelDiscovery: lastDiscovery }),
    ...(lastMiMoDiscovery === undefined ? {} : { lastMiMoModelDiscovery: lastMiMoDiscovery }),
    balanceClient: deepseekBalanceClient,
    ...(admin === undefined ? {} : { admin }),
    toolEndpoints,
    modalityEndpoints,
    /**
     * OpenAI 兼容音频端点（`/v1/audio/speech`、`/v1/audio/transcriptions`）。
     *
     * http/server.ts 经 `audio` 选项挂载；与 `toolEndpoints` 打同一批上游，
     * 客户端 dialect 不同。`list()` 里 translations 的 `supported:false` 是**明确
     * 不支持**的标记（DeepSeek ASR 没有翻译目标参数）。
     */
    audioEndpoints,
    ...(virtualKeyStore === undefined ? {} : { virtualKeys: virtualKeyStore }),
    dataPlaneAuth,
    ...(settingsService === undefined ? {} : { settings: settingsService }),
    loadSettings,
    reportDataPlaneAuthMode: async () => {
      const described = await dataPlaneAuth.describe();
      // 互斥被触发时打 error：access token 被静默忽略是这个设计里唯一的陷阱，
      // 补偿手段之一就是启动时吼一声（另两个见 auth/data-plane.ts 文件头）。
      if (described.ignored.length > 0) {
        logger.error('数据面认证：配置冲突', { ignored: described.ignored });
      } else {
        logger.info('数据面认证模式', {
          mode: described.mode,
          virtual_key_count: described.virtual_key_count,
        });
      }
      return described;
    },
    models: modelCatalog,
    modelSync,
    routeGraphs,
    routingTelemetry,
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
 * 管理面静态资源的默认目录：`dist/webui/admin`（相对本编译产物所在目录解析）。
 *
 * `scripts/copy-static-assets.mjs` 会把 `webui/admin/dist`（Vite 产物）拷到
 * `dist/webui/admin`，因此跑过 `npm run build` 后这里就存在，`/admin` 直接可用；
 * 没跑构建（开发 / 测试）时该目录不存在，静态托管保持未挂载（routes 回 404），
 * 与引入本默认值之前的行为一致。用 `webui/admin` 而非 `admin` 是为了避开后端
 * `admin/` 模块被 tsc 编译到的 `dist/admin/`（否则静态托管会serve到后端源码）。
 */
function defaultAdminStaticRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'webui', 'admin');
}

/**
 * 装配管理面。
 *
 * 返回 undefined = 没配管理面（没传 recordStore / adminStaticRoot 任一）。
 * 这样 `createGateway()` 的既有调用方（测试、demo）完全不受影响。
 */
function assembleAdmin(input: {
  mode: 'production' | 'test';
  options: GatewayOptions;
  capabilityRegistry: import('./credentials/capability-registry.js').CapabilityRegistry;
  credentialResolver: import('./credentials/resolver.js').CredentialResolver;
  clock: import('./ir/clock.js').Clock;
  usageSink?: import('./metering/memory-emitter.js').MemoryUsageSink;
  /** provider 运行时投影（namespace / 服务端工具开关；与 pipeline、目录共享同一实例）。 */
  providerRuntime: ProviderRuntimeIndex;
  /** transport（`/admin/api/provider-models` 要打真实上游）。 */
  transport: Transport;
  /** 运行时配置（自动禁用阈值/开关）。 */
  config: GatewayConfig;
  onChannelActivated?: (
    provider: import('./admin/api-types.js').ProviderConfig,
    accessPath: string,
  ) => void;
  onChannelDeactivated?: (providerId: string, accessPath: string) => void;
  enrichStaticCapability?: (
    provider: import('./admin/api-types.js').ProviderConfig,
    model: string,
  ) => Partial<CapabilityEntry> | undefined;
  balanceClientFactory: () => import('./providers/deepseek/balance.js').DeepSeekBalanceClient;
  /** 数据面 virtual key 存储（66 §2；与 S0 的鉴权器共享同一个实例）。 */
  virtualKeys?: import('./storage/virtual-keys.js').VirtualKeyStore;
  /** 数据面认证模式描述者（互斥语义的可见性）。 */
  dataPlaneAuth: import('./auth/data-plane.js').DataPlaneAuthenticator;
  /**
   * provider → 是否已配置（与 `ModelCatalog` 同一个端口实例）。
   */
  providerAvailability?: import('./catalog/types.js').ProviderAvailabilityResolver;
  /** access path → provider（与 `ModelCatalog` 同一个解析器）。 */
  providerOfAccessPath?: (accessPath: string) => string;
  /** 运行时设置（P0-2）。 */
  settings?: import('./config/settings.js').SettingsService;
  agentChat?: Omit<AgentChatDeps, 'adminService' | 'aliasResolver'>;
  routeGraphs?: RouteGraphRegistry;
  routingTelemetry?: RoutingTelemetryHub;
  telemetryRefresher?: () => Promise<void>;
  pluginHost?: PluginHost;
}): AdminAssembly | undefined {
  const { options, capabilityRegistry, credentialResolver, clock, providerRuntime } = input;
  if (options.recordStore === undefined) return undefined;

  const aliasResolver =
    options.aliasResolver ??
    new DefaultAliasResolver(
      options.aliasRules ?? (input.mode === 'production' ? [] : defaultAliasRules()),
      {
        list: (modality) =>
          capabilityRegistry
            .list(modality)
            .map((e) => ({ access_path: e.access_path, model: e.model })),
      },
    );

  // ---- 业务逻辑 ----
  const adminService = new AdminService({
    store: options.recordStore,
    clock,
    // 自动禁用阈值/开关（部署级配置；不是每请求可变的那类设置）
    config: input.config,
    capabilityRegistry,
    credentialResolver,
    aliasResolver,
    providerRuntime,
    ...(input.onChannelActivated === undefined
      ? {}
      : { onChannelActivated: input.onChannelActivated }),
    ...(input.onChannelDeactivated === undefined
      ? {}
      : { onChannelDeactivated: input.onChannelDeactivated }),
    ...(input.enrichStaticCapability === undefined
      ? {}
      : { enrichStaticCapability: input.enrichStaticCapability }),
    // 上游模型清单拉取（`POST /admin/api/provider-models`）。
    providerModels:
      options.providerModels ??
      createProviderModelsPort({
        transport: input.transport,
        credentialResolver,
        clock,
        systemContext: () => systemProbeCtx(clock),
      }),
    ...(options.metadataSync === undefined ? {} : { metadataSync: options.metadataSync }),
    ...(options.balanceProbe === undefined ? {} : { balanceProbe: options.balanceProbe }),
    ...(options.usageSource !== undefined
      ? { usageSource: options.usageSource }
      : input.usageSink === undefined
        ? {}
        : {
            usageSource: {
              list: (fromTs, toTs) =>
                input
                  .usageSink!.records.filter((r) => r.ts >= fromTs && r.ts < toTs)
                  .map((r) => ({
                    request_id: r.request_id,
                    ts: r.ts,
                    provider: r.provider,
                    model: r.model,
                    ...(r.model_alias === undefined ? {} : { model_alias: r.model_alias }),
                    status: r.status,
                    auth: {
                      key_id: r.auth.key_id,
                      ...(r.auth.team_id === undefined ? {} : { team_id: r.auth.team_id }),
                      ...(r.auth.user_id === undefined ? {} : { user_id: r.auth.user_id }),
                    },
                    usage: {
                      units: r.usage
                        .units as unknown as import('./admin/service.js').UsageUnitsView,
                    },
                    cost: {
                      cash: { total: r.cost.cash.total },
                      as_api: { total: r.cost.as_api.total },
                      status: r.cost.status,
                      ...(r.cost.currency === undefined ? {} : { currency: r.cost.currency }),
                    },
                    ...(r.price_snapshot === undefined
                      ? {}
                      : { price_snapshot: r.price_snapshot }),
                    finish_reason: r.finish_reason,
                    fast_path: r.fast_path,
                    ...(r.credential_id === undefined ? {} : { credential_id: r.credential_id }),
                  })),
            },
          }),
    ...(options.reconciliationSource === undefined
      ? {}
      : { reconciliationSource: options.reconciliationSource }),
    // 能力矩阵端点的部署态过滤判据：与 ModelCatalog 同一个端口实例、同一个
    // provider 解析器（见 catalog/visibility.ts 的文件头）
    ...(input.providerAvailability === undefined
      ? {}
      : { providerAvailability: input.providerAvailability }),
    ...(input.providerOfAccessPath === undefined
      ? {}
      : { providerOfAccessPath: input.providerOfAccessPath }),
    ...(input.virtualKeys === undefined ? {} : { virtualKeys: input.virtualKeys }),
    dataPlaneAuth: input.dataPlaneAuth,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    providerPresets: PROVIDER_PRESETS,
    ...(input.routeGraphs === undefined ? {} : { routeGraphs: input.routeGraphs }),
    ...(input.routingTelemetry === undefined ? {} : { routingTelemetry: input.routingTelemetry }),
    ...(input.telemetryRefresher === undefined ? {} : { telemetryRefresher: input.telemetryRefresher }),
    ...(input.pluginHost === undefined ? {} : { pluginHost: input.pluginHost }),
  });

  // ---- 认证 ----
  // accessToken 走 options（不读 process.env——全仓库只有 di/config.ts 读 env）
  const adminAuth = new DefaultAdminAuth(options.recordStore, clock, {
    ...(options.adminAccessToken === undefined ? {} : { accessToken: options.adminAccessToken }),
  });

  // ---- 静态资源 ----
  // adminStaticRoot 未显式指定时，默认指向构建产物 dist/admin（由
  // scripts/copy-static-assets.mjs 从 webui/admin/dist 拷入）。仅当该目录真实
  // 存在才启用静态托管——否则保持既有行为（未挂载 → routes 回 404），
  // 让「没跑 build:admin 的开发/测试环境」与之前完全一致。
  const serveStatic =
    options.adminStaticRoot !== undefined
      ? createStaticAssetsHandler({ rootDir: options.adminStaticRoot })
      : existsSync(defaultAdminStaticRoot())
        ? createStaticAssetsHandler({ rootDir: defaultAdminStaticRoot() })
        : undefined;

  // ---- HTTP 路由 ----
  const routeHandler = createAdminRouter({
    auth: adminAuth,
    service: adminService,
    // 对话端点：把 adminService 与 aliasResolver 补进调用方给的那一份
    ...(input.agentChat === undefined
      ? {}
      : {
          agentChat: {
            ...input.agentChat,
            adminService,
            aliasResolver,
          },
        }),
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
    // ---- 密钥轮换端口 ----
    // 不注入 = 路由明确回 501「未实现」，不假装成功。注入走 options.keystore
    // （它同时提供 status 与轮换能力，见下面的 KeystoreControlPort）。
    ...(options.keystore === undefined
      ? {}
      : {
          ...(options.keystore.rotateKek === undefined
            ? {}
            : { rotateKek: options.keystore.rotateKek }),
          ...(options.keystore.rotateDek === undefined
            ? {}
            : { rotateDek: options.keystore.rotateDek }),
        }),
    // Provider 预设注册表（providers/presets.ts 的纯数据，只读透出）。
    providerPresets: () => PROVIDER_PRESETS,
    ...(serveStatic === undefined ? {} : { serveStatic }),
  });

  return {
    aliasResolver,
    adminService,
    adminAuth,
    routeHandler,
    loadAliases: async () => {
      await adminService.loadPluginStates();
      return adminService.loadAliasesIntoResolver();
    },
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
