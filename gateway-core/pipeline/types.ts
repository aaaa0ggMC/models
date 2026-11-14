/**
 * gateway-core/pipeline/types.ts —— PipelineRunner 的依赖、输入与阶段间状态。
 *
 * 阶段职责表见 docs/design/20-pipeline.md §2（S0–S10 共 11 个阶段）。
 * 每个阶段是一个实现了 `Stage` 接口的对象（内部可有 IO），由 PipelineRunner 串联；
 * 重试/fallback 与工具循环由 Runner 持有，因为它们要跨阶段重跑 S4→S8。
 */

import type {
  CanonicalError,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  CanonicalUsage,
  ConversionDiagnostic,
  FinishReason,
  FormatId,
  ModalityKind,
  RequestTrace,
} from '../../ir/index.js';
import type { RequestEnvelopeShallow } from '../../adaptors/types.js';
import type { ClientSink } from './sink.js';
import type { IncrementalUsageSniffer } from './usage-sniffer.js';
import type { Adaptor, EncodedRequest } from '../../adaptors/types.js';
import type { AdaptorRegistry } from '../../adaptors/types.js';
import type { MutableRequestContext } from '../context.js';
import type { FastPathAdmission } from './fast-path.js';
import type { LazyRequest } from './lazy-decode.js';
import type { Router } from '../router.js';
import type { Transport, UpstreamResponse } from '../transport.js';
import type { PluginHost } from '../../plugins/host.js';
import type { UsageEmitter } from '../../metering/emitter.js';
import type { CredentialResolver } from '../../credentials/resolver.js';
import type { CapabilityRegistry } from '../../credentials/capability-registry.js';
import type { Clock, GatewayConfig, IdGenerator, Logger, Metrics } from '../../di/ports.js';
import type { ProviderProfileRegistry } from '../../di/ports.js';
import type { PricingService } from '../../providers/deepseek/pricing-service.js';

/** 一次请求的全部注入依赖。测试里可整体替换任一依赖。 */
export interface PipelineDeps {
  config: GatewayConfig;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  ids: IdGenerator;
  transport: Transport;
  adaptors: AdaptorRegistry;
  pluginHost: PluginHost;
  usageEmitter: UsageEmitter;
  credentialResolver: CredentialResolver;
  capabilityRegistry: CapabilityRegistry;
  router: Router;
  fastPathAdmission: FastPathAdmission;
  /**
   * provider profile 注册表（可缺省）。
   *
   * S10 在计量边界按 access path 查 profile，把厂商专有 usage 字段名归一成
   * canonical（DeepSeek 的 prompt_cache_hit_tokens 等）；codec 侧按同一个注册表
   * 查端点路径 / builtin tool 方言映射。缺省 = 没有任何 provider 专有归一。
   */
  providerProfiles?: ProviderProfileRegistry;
  /**
   * 定价服务（可缺省）：S10 在请求完成时按**当时可得的价格**一次性算出 cost 并快照
   * 固化（price_snapshot 含档位/生效日/表版本）。缺省 = 不接定价，cost 记 unpriced
   * （Phase 1 历史行为）。价格表更新后**不重算**已有记录——补录走历史价格
   * （metering/pricing.ts 的 backfillCost）。
   */
  pricingService?: PricingService;
  /**
   * 客户端写出通道。**每次请求不同**（http/server.ts 的 NodeResponseSink 或测试的
   * MemoryClientSink），因此 Runner 的构造函数收 `Omit<PipelineDeps, "sink">`，
   * 在 run() 里按请求合并进来。
   */
  sink: ClientSink;
}

/** Runner 构造时注入的服务（不含 per-request 的 sink）。 */
export type PipelineServices = Omit<PipelineDeps, 'sink'>;

export interface PipelineInput {
  /** S0 识别出的客户端格式。 */
  client_format: FormatId;
  /** 原始请求体字节。 */
  raw_body: Buffer;
  /** 已脱敏的请求头。 */
  headers: Record<string, string>;
  /** 端点路径（Gemini 的 model-in-path 场景用）。 */
  path: string;
  query: Record<string, string>;
}

/** 阶段间共享的可变状态。字段按阶段顺序填充。 */
export interface PipelineState {
  ctx: MutableRequestContext;
  input: PipelineInput;

  /** S0 */
  modality: ModalityKind;

  /** S1（D-fastpath-1：浅解析产物 + 惰性请求句柄） */
  shallow?: RequestEnvelopeShallow;
  lazy?: LazyRequest;

  /** S2 */
  route_ready: boolean;

  /** S3 之后：完整 canonical（可能仍未物化） */
  canonical?: CanonicalRequestEnvelope;
  /**
   * 显式提供的 canonical（工具循环的每一轮由 Runner 设置）。
   *
   * 为什么需要它：`LazyRequest.full()` 返回的是**首次物化时 memoize 的原始请求**，
   * 而工具循环的 APPEND_TURN 会往 messages 里追加 assistant/tool 回合——
   * 若不显式覆盖，每一轮都会把原始请求重新发给上游，循环永远不前进（20 §5.2）。
   */
  canonical_override?: CanonicalRequestEnvelope;
  /** 插件短路（S3） */
  short_circuit_response?: CanonicalResponseEnvelope;
  short_circuit_error?: import('../../ir/index.js').CanonicalError;

  /** S4 */
  encoded?: EncodedRequest;
  clientAdaptor?: Adaptor;
  providerAdaptor?: Adaptor;

  /** S5 */
  upstream?: UpstreamResponse;
  upstream_status?: number;
  upstream_chunks?: string[];

  /** S6 */
  response?: CanonicalResponseEnvelope;
  finish_reason?: FinishReason;
  /** S6 慢路径：折叠后的规范流事件序列。 */
  stream_events?: CanonicalStreamEvent[];
  /**
   * fast path 流式：S6 创建、S8 消费的增量 usage 嗅探器。
   * S6 **不读流**——读流会破坏"零延迟透传"（20 §4.2 / 设计原则 3）。
   */
  sniffer?: IncrementalUsageSniffer;
  /** S5 记录的首字节耗时（UsageRecord.ttfb_ms）。 */
  ttfb_ms?: number;

  /** S7/S8：是否已向客户端写出首字节（20 §S8：之后不能改状态码） */
  bytes_written: boolean;

  /** S9 */
  final_response?: CanonicalResponseEnvelope;

  /** S10 */
  usage?: CanonicalUsage;
  trace: RequestTrace;

  /** 全链路累积的诊断 */
  diagnostics: ConversionDiagnostic[];
  dropped_capabilities: string[];
  /** 实际走过的转换链（20 §S4） */
  conversion_chain: string[];

  /** 是否已物化完整 canonical（D-fastpath-1 的代价观测）。 */
  materialized: boolean;
  /** 最终状态（S10 用）。 */
  status?: 'success' | 'error' | 'short_circuit';
  /** 阶段失败时携带的错误。 */
  error?: CanonicalError;

  /** 工具循环轮数 */
  turns: number;
  /** 流式：聚合视图（S7 的 needs:"aggregate" 插件用） */
  aggregated?: CanonicalResponseEnvelope;
}

export interface Stage {
  /** "S0" … "S10" */
  readonly id: string;
  readonly name: string;
  execute(state: PipelineState, deps: PipelineDeps): Promise<void>;
}

/** PipelineRunner 的返回：HTTP 层据此收尾。 */
export interface PipelineOutcome {
  status: number;
  /** 是否走了 fast path（观测"多少请求因为插件/能力不支持走了转换"）。 */
  fast_path: boolean;
  /** 是否完整物化了 canonical（D-fastpath-1 的代价观测）。 */
  materialized: boolean;
  trace: RequestTrace;
  usage?: CanonicalUsage;
  error?: import('../../ir/index.js').CanonicalError;
  short_circuit: boolean;
  turns: number;
}
