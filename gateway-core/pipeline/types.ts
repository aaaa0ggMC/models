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
import type { PricingService } from '../../metering/pricing.js';
import type { RoutingTelemetryHub } from '../routing-telemetry.js';

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
   * 跨模态桥接（可缺省）：当对话端点（openai.chat / openai.responses 等）收到生图模型
   * （target_modality === 'image'）时，转调生图 adaptor 并把图片嵌入 canonical 对话回复。
   */
  imageBridge?: {
    generate(input: {
      access_path: string;
      model: string;
      prompt: string;
      ctx: import('../../ir/index.js').RequestContext;
    }): Promise<{
      urls: string[];
      b64_jsons: string[];
      revised_prompt?: string;
      usage?: import('../../ir/index.js').CanonicalUsage;
    }>;
  };
  /**
   * provider 级默认配置的**窄视图**（可缺省；admin/provider-runtime.ts 的实现注入）。
   *
   * 这里只声明"要什么形状"而不 import admin/：gateway-core 不反向依赖控制面，
   * 靠结构类型匹配（`builtinToolsFor` 的返回形状一致就能塞进来）。
   *
   * 当前唯一消费者是 S3 的服务端工具默认注入开关（provider 级，默认关）。
   */
  providerDefaults?: {
    builtinToolsFor(provider: string): { web_search?: boolean; url_context?: boolean } | undefined;
  };
  /**
   * provider 健康旁路（可缺省；admin/service.ts 的自动禁用实现注入到这里）。
   *
   * **绝不影响请求结果**：两个方法都返回 void，实现自己吞掉一切错误。S5 只在
   * "已经拿到上游状态码"之后调它——记录健康是旁路，不是链路的一部分
   * （20 §S10 的同立场：旁路能力不得影响主链路）。
   */
  providerHealth?: {
    recordFailure(provider: string, httpStatus: number): void;
    recordSuccess(provider: string): void;
  };
  /**
   * 路由遥测中心（可缺省）：S5 捕获上游限流响应头、S10 写入 5h 滑窗用量。
   */
  routingTelemetry?: RoutingTelemetryHub;
  /**
   * 客户端写出通道。**每次请求不同**（http/server.ts 的 NodeResponseSink 或测试的
   * MemoryClientSink），因此 Runner 的构造函数收 `Omit<PipelineDeps, "sink">`，
   * 在 run() 里按请求合并进来。
   */
  sink: ClientSink;
}

/** Runner 构造时注入的服务（不含 per-request 的 sink）。 */
export type PipelineServices = Omit<PipelineDeps, 'sink'>;

/**
 * 第一方（服务端自己）调用方的稳定标识。
 *
 * **白名单字面量**：新增第一方调用方必须在这里加一个值，并在 S0 的
 * `DATA_PLANE_AUTH_EXEMPTIONS` 里登记对应条目（带 `why`）。字面量联合的意义是
 * 「随手传一个字符串进来」在类型层面就过不去——豁免是审过的决定，不是调用方的自称。
 */
export type FirstPartyCaller = 'agent-builtin';

/**
 * 一条数据面鉴权豁免请求：声明「这个 pipeline 输入由服务端第一方构造」。
 *
 * 为什么必须是 `PipelineInput` / `AuthRequest` 上的**类型化字段**，而不能是
 * 「S0 认一个魔法请求头」：数据面请求的 `input.headers` 就是客户端原始头，
 * 任何客户端自己带一个 `x-ag-internal-caller: agent-builtin` 就能绕过鉴权。
 * 这个字段只存在于进程内的调用链上——`http/server.ts` 的数据面路径**永远不
 * 设置它**，客户端也没有任何途径写它（它不是头、不是查询参数、不是 body 字段）。
 */
export interface AuthExemption {
  caller: FirstPartyCaller;
}

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
  /**
   * 未经脱敏的鉴权原语（66 §2.2 的三种呈现形态）。
   *
   * 与 `headers` **分开**是有意的：`headers` 会被抄进
   * `ctx.client_raw_headers`（插件可见、进 trace），而这个字段只被 S0 的
   * 鉴权器读一次，**绝不进 ctx / trace / 日志 / UsageRecord**。
   * 由 http/server.ts 的 `buildAuthMaterial` 从原始请求构造。
   */
  auth_material?: {
    authorization?: string;
    api_key?: string;
    query_key?: string;
  };
  /**
   * 数据面鉴权豁免（**代码级区分**，见 `AuthExemption`）。
   *
   * 只有服务端第一方调用方会设置（当前唯一一处：管理面内置对话
   * `admin/agent-chat.ts`）。S0 按 `DATA_PLANE_AUTH_EXEMPTIONS` 解析它；
   * 不在表里的调用方一律**不豁免**，继续走数据面鉴权器。
   */
  auth_exemption?: AuthExemption;
  /** 客户端断联中止信号（由 HTTP ingress 按断联策略触发）。 */
  abort_signal?: AbortSignal;
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
  /** S2 路由图覆盖参数施加前的基线 canonical（供 S5 fallback 尝试不同目标覆盖）。 */
  base_canonical?: CanonicalRequestEnvelope;
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
  /** S6 → S7 → S8 流式慢路径的实时异步事件流（边收边转边发，避免缓冲整条流）。 */
  canonical_stream?: AsyncIterable<CanonicalStreamEvent>;
  /**
   * fast path 流式：S6 创建、S8 消费的增量 usage 嗅探器。
   * S6 **不读流**——读流会破坏"零延迟透传"（20 §4.2 / 设计原则 3）。
   */
  sniffer?: IncrementalUsageSniffer;
  /** S5 记录的首字节耗时（UsageRecord.ttfb_ms）。 */
  ttfb_ms?: number;

  /** S7/S8：是否已向客户端写出首字节（20 §S8：之后不能改状态码） */
  bytes_written: boolean;

  /**
   * S8 非流式：已编码好但**尚未写出**的客户端字节 + 状态码 + 响应头。
   *
   * 为什么暂存而不直接写（2026-11-16 修 §4.3）：S8 排在 S9 **之前**，而非流式下
   * 客户端只有这一份响应体。原先 S8 直接 `sink.start() + sink.write()`，于是
   * `onResponse` 插件对 canonical 响应的改写（`PluginResult<CanonicalResponse>`
   * 承诺的"改写后的值"）在字节已经上线之后才发生——**静默丢失**。
   *
   * 改成暂存后：S8 只负责「canonical → 客户端格式」这一次编码，S9 跑完插件链若
   * 响应被改写就重新编码覆盖这份缓冲，Runner 在 S9 之后才真正写给 sink。
   * 阶段表与编号（S0–S10 共 11 个）原样不变，改的只是「什么时候把字节交给 sink」。
   *
   * 流式不适用：流式在 S8 里逐帧写出（首字节之后不能再改状态码，25 §7.1），
   * 因此流式下这个字段恒为 undefined，S9 只能观测——这与 20 §S9 的既有约定一致。
   */
  client_bytes?: { status: number; headers: Record<string, string>; body: string };

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
