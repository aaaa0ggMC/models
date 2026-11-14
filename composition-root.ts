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
import { DefaultPluginHost } from './plugins/host.js';
import type { PluginHost } from './plugins/host.js';
import type { GatewayServices, KVNamespace, Plugin } from './ir/index.js';
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
  /** 优雅退出：冲刷 usage 队列 + dispose 插件。 */
  shutdown(): Promise<void>;
}

/** 默认路由表：两条 mock access path，便于本地不起真实 API 跑通端到端。 */
export function defaultRouteTable(): RouteTable {
  return {
    aliases: {
      'mock-gpt': {
        targets: [{ access_path: 'openai', provider: 'openai', model: 'gpt-test-1' }],
        max_context_tokens: 128_000,
      },
      'mock-claude': {
        targets: [{ access_path: 'anthropic', provider: 'anthropic', model: 'claude-test-1' }],
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
    },
  };
}

/** 默认能力矩阵（Phase 1：两个已实现的 chat adaptor）。 */
export function defaultCapabilities(): CapabilityEntry[] {
  return [
    {
      access_path: 'openai',
      model: 'gpt-test-1',
      modality: 'chat',
      format: 'openai.chat',
      streaming: { mode: 'sse', usage_in_stream: true, cancellable: true, framing: 'json-sse' },
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
    },
    {
      access_path: 'anthropic',
      model: 'claude-test-1',
      modality: 'chat',
      format: 'anthropic.messages',
      streaming: { mode: 'sse', usage_in_stream: true, cancellable: true, framing: 'json-sse' },
      usage_source: 'provider',
      usage_units: ['tokens'],
      contract_tested: true,
      status: 'implemented',
    },
  ];
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
  const { registry: adaptorRegistry } = createAdaptorRegistry({ clock, logger });
  container.registerValue(TOKENS.AdaptorRegistry, adaptorRegistry);

  // ---- 凭据与能力矩阵 ----
  const credentialResolver =
    options.credentialResolver ??
    new EnvCredentialResolver(DEFAULT_ACCESS_PATHS, undefined, process.env);
  container.registerValue(TOKENS.CredentialResolver, credentialResolver);

  const capabilityRegistry = new InMemoryCapabilityRegistry();
  for (const entry of options.capabilities ?? defaultCapabilities()) {
    capabilityRegistry.register(entry);
  }
  container.registerValue(TOKENS.CapabilityRegistry, capabilityRegistry);

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
  const router = new StaticRouter(
    options.routeTable ?? defaultRouteTable(),
    capabilityRegistry,
    credentialResolver,
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
