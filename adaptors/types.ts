/**
 * adaptors/types.ts —— adaptor 契约。
 *
 * 唯一事实来源：docs/design/40-provider-adaptors.md §1.1（Adaptor 接口）、§1.2（最小实现面）、
 * §1.3（注册机制与 AdaptorMeta）。
 *
 * 决策 P1（40 §1.1）：**语义转换（adaptor）与传输/鉴权（transport）二分**。
 * Bedrock 的 SigV4、Vertex 的 OAuth、ChatGPT 订阅的 device-code OAuth 只改"怎么签名、
 * 怎么建流"，不改"字段怎么映射"——所以 adaptor 里看不到 HTTP 客户端。
 *
 * 最小实现面 = 上面 8 个方法，**一个都不能少，也不允许多**（40 §1.2 原文）。
 * 唯一的例外是 `decodeEnvelope`（可选），它是 D-fastpath-1 惰性解码所必需的能力，
 * 见下方注释与报告的「文档问题」清单。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  FormatId,
  ModalityKind,
  NormalizedFinishReason,
  CanonicalUsage,
  RequestContext,
  StreamFrame,
} from '../ir/index.js';

/** 请求：canonical → wire 的产物。 */
export interface EncodedRequest {
  body: unknown;
  /** fast path 时的原始字节（不经过 encode）。给了它就是透传。 */
  raw_bytes?: Buffer;
  fast_path: boolean;
  /** 本次编码丢弃/降级了哪些能力。 */
  dropped?: string[];
  warnings?: string[];
  /** 本次编码产生的转换诊断（进响应信封 degraded[] 与 RequestTrace）。 */
  diagnostics?: import('../ir/index.js').ConversionDiagnostic[];
  /** 上游 URL 路径（transport 用）。不同 provider 端点不同。 */
  path?: string;
  /** 额外的上游请求头（不含鉴权头——鉴权归 transport/credential resolver）。 */
  headers?: Record<string, string>;
}

/**
 * S1 惰性解码的产物：**信封 + 路由必需字段**（D-fastpath-1）。
 *
 * 为什么不进完整 canonical：长上下文大请求体在 fast path 下也要付"完整解码成 canonical"
 * 的代价，与「附加延迟 < 3ms p99」（00 §3、70 Phase 1 验收）冲突。完整物化推迟到
 * 真正需要它的阶段（S3 有请求侧插件 / S4 非 fast path / S6 非 fast path）。
 */
export interface RequestEnvelopeShallow {
  source_format: FormatId;
  kind: ModalityKind;
  /** 客户端请求的模型名（可能是网关别名）。 */
  model: string;
  /** 是否流式。 */
  stream: boolean;
  /** 请求体字节长度。 */
  bytes: number;
  /** 响应侧 usage 的位置提示（fast path 嗅探器用），如 ["usage"] / ["message_start.usage"]。 */
  usage_locations?: string[];
  /** 顶层未建模字段（供 raw.unmapped 回写，10 §7.2 第 3 条）。 */
  unmapped?: Record<string, unknown>;
  /** 该格式的默认端点路径模板（如 "/v1/messages"）。 */
  default_path?: string;
  /**
   * 客户端是否显式要求**网关 agentic loop**（wire 侧的 `ag_agentic_loop: true`，
   * 20 §5.1）。放进路由必需集是为了让 Runner 在**不物化完整 canonical** 的前提下
   * 就能判断要不要进工具循环——否则每次请求都得先解码才能决定，fast path 的
   * 惰性就白做了（D-fastpath-1）。
   */
  gateway_agentic_loop?: boolean;
}

export interface Adaptor {
  readonly format: FormatId;
  readonly modalities: ModalityKind[];

  /** 请求：wire → canonical。硬性要求：不允许丢字段，未建模顶层键必须进 raw.unmapped（20 §S1）。 */
  decode(raw: unknown, ctx: RequestContext): CanonicalRequestEnvelope;
  /** 请求：canonical → wire（含 fast path 短路）。 */
  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest;
  /** 响应：wire → canonical。 */
  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope;
  /** 响应：canonical → wire。 */
  encodeResponse(res: CanonicalResponseEnvelope, ctx: RequestContext): unknown;

  /** 流式：wire 事件流 → canonical 帧。 */
  decodeStream(stream: AsyncIterable<unknown>, ctx: RequestContext): AsyncIterable<StreamFrame>;
  /** 流式：canonical 帧 → wire 事件流。 */
  encodeStream(frames: AsyncIterable<StreamFrame>, ctx: RequestContext): AsyncIterable<unknown>;

  /** 该格式的 usage 字段抽取（多单位，40 §2）。 */
  extractUsage(raw: unknown): CanonicalUsage;
  /** finish_reason 归一。**双留：归一值 + 原文**（10 §9.3 注意 3）。 */
  normalizeFinishReason(raw: unknown): NormalizedFinishReason;

  /**
   * **可选**：S1 惰性解码（D-fastpath-1）。
   *
   * 这是对 40 §1.2「8 个方法一个不能少也不允许多」的唯一放宽：仓库主人在 issue #8
   * 第 3 条拍板引入惰性解码后，"只解析信封 + 路由必需字段"必须有格式相关的实现处，
   * 而格式知识只存在于 codec 里。做成 `optional` 是为了让未实现它的 adaptor 仍满足
   * 原契约（此时 S1 只能走完整解码，fast path 相应关闭）。
   */
  decodeEnvelope?(raw: unknown, ctx: RequestContext): RequestEnvelopeShallow;
  /** 可选：fast path 透传时按路由目标生成动态上游路径（如 Gemini model-in-path）。 */
  resolveFastPath?(ctx: RequestContext, shallow: RequestEnvelopeShallow | undefined): string | undefined;
}

/** adaptor 元数据（40 §1.3）。 */
export interface AdaptorMeta {
  format: FormatId;
  modality: ModalityKind;
  /** 版本。协议变动时 bump，旧版本保留以便回滚。 */
  version: string;
  /** 契约测试夹具目录。 */
  fixtures: string;
  /** 已知不支持/有损的 canonical 字段。 */
  unsupported_fields: string[];
  /** 已知 quirks（人类可读，进能力矩阵）。 */
  quirks: string[];
  /** 状态：已实现 / 计划 / 按需。 */
  status: 'implemented' | 'planned' | 'on-demand';
  /** 是否支持 S1 惰性解码（D-fastpath-1）。 */
  supports_lazy_decode?: boolean;
}

/**
 * adaptor 注册表。一个 (FormatId, ModalityKind) 二元组最多一个实现（40 §1.3）。
 *
 * 注册是**显式的、集中在一个文件里**（adaptors/index.ts），不做魔法自动发现——
 * 自动发现会让"哪些 adaptor 真的被测过"变得不可审查。
 */
export interface AdaptorRegistry {
  register(adaptor: Adaptor, meta: AdaptorMeta): void;
  get(format: FormatId, modality: ModalityKind): Adaptor;
  /** 取不到时返回 undefined（不抛）——路由阶段要能据此拒绝而不是炸。 */
  find(format: FormatId, modality: ModalityKind): Adaptor | undefined;
  meta(format: FormatId, modality: ModalityKind): AdaptorMeta | undefined;
  list(modality?: ModalityKind): AdaptorMeta[];
}
