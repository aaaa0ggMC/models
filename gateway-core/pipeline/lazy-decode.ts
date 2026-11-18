/**
 * gateway-core/pipeline/lazy-decode.ts —— D-fastpath-1 惰性解码的物化调度。
 *
 * 拍板内容（仓库主人，issue #8 第 3 条）：
 *   S1 只解析「信封 + 路由必需字段」；**完整 canonical 物化推迟到真正需要它的阶段**——
 *   S3 插件链（有请求侧插件时）、S4 Encode（非 fast path 时）、S6 ProviderDecode（非 fast path 时）。
 *   fast path 下响应侧只抽取 usage 信封并直通原始字节，不做结构转换。
 *
 * 动机：长上下文大请求体在 fast path 下也付"完整解码成 canonical"的代价，
 * 与「附加延迟 < 3ms p99」（00 §3、70 Phase 1 验收）冲突。
 *
 * 三级档位（20 §4.2 设计风险小节的方案，D-fastpath-1 收敛为两档实现）：
 *   A. 无请求侧插件 + 同格式 → **完全不解码**（只做信封级浅解析）；
 *   B. 有请求侧插件但全部 envelope-only → 仍可浅解析；
 *   C. 插件要改内容 → 必须完整解码（现有 disableFastPath 语义）。
 */

import type {
  CanonicalRequestEnvelope,
  FormatId,
  ModalityKind,
  RequestContext,
} from '../../ir/index.js';
import type { Adaptor, RequestEnvelopeShallow } from '../../adaptors/types.js';
import { CTX_STATE_KEYS } from '../../ir/index.js';

/** 路由必需集：S1 浅解析**必须**产出的字段（D-fastpath-1 明确列出）。 */
export const ROUTING_REQUIRED_FIELDS = [
  'source_format', // 客户端格式识别
  'model', // 别名解析
  'access_path_hint', // 由别名表推，不是从 body 读
  'stream', // 是否流式（决定 S5/S6/S8 的形态）
  'request_bytes', // 请求体字节长度（限额与观测）
  'usage_locations', // 响应侧 usage 信封位置（fast path 嗅探器用）
] as const;

export type RoutingRequiredField = (typeof ROUTING_REQUIRED_FIELDS)[number];

/** 物化档位。 */
export type MaterializationLevel =
  /** 只做信封级浅解析；完整 canonical 永不物化（除非后续阶段要求）。 */
  | 'envelope'
  /** 完整 canonical 已物化（或即将物化）。 */
  | 'full';

export class LazyRequest {
  private materialized: CanonicalRequestEnvelope | undefined;

  constructor(
    private readonly shallow: RequestEnvelopeShallow,
    private readonly rawBody: Buffer,
    private readonly adaptor: Adaptor,
    private readonly ctx: RequestContext,
  ) {}

  /** 浅解析产物（S1/S2 只看这个）。 */
  get envelope(): RequestEnvelopeShallow {
    return this.shallow;
  }

  /** 原始请求体字节（fast path 透传用，条件 4）。 */
  get raw(): Buffer {
    return this.rawBody;
  }

  get level(): MaterializationLevel {
    return this.materialized === undefined ? 'envelope' : 'full';
  }

  /**
   * 物化完整 canonical。幂等：重复调用返回同一对象。
   *
   * 调用点（D-fastpath-1 规定的三个）：
   *   - S3 插件链：有请求侧插件时；
   *   - S4 Encode：非 fast path 时；
   *   - S6 ProviderDecode：非 fast path 时（响应侧对应物化）。
   * 另外：任何显式读取 `full()` 的代码路径都会触发物化——这是有意的，
   * 因为"确实需要某个字段时按访问器 lazy parse"正是拍板内容的原话。
   */
  full(): CanonicalRequestEnvelope {
    if (this.materialized === undefined) {
      const parsed: unknown = JSON.parse(this.rawBody.toString('utf8'));
      this.materialized = this.adaptor.decode(parsed, this.ctx);
      this.ctx.state[CTX_STATE_KEYS.LAZY_ENVELOPE] = this.materialized;
    }
    return this.materialized;
  }

  /** 已经物化了就不用再付代价（fast path 关闭率观测用）。 */
  get isMaterialized(): boolean {
    return this.materialized !== undefined;
  }
}

/**
 * S1 的浅解析：优先用 adaptor 的 `decodeEnvelope`（D-fastpath-1 要求的格式相关实现）；
 * adaptor 没实现时退化为"从 body 里直接抠通用字段"，此时 fast path 仍需关闭
 * （因为 usage_locations 拿不到，嗅探器无从下手）。
 */
export function shallowDecode(
  adaptor: Adaptor,
  rawBody: Buffer,
  ctx: RequestContext,
  kind: ModalityKind,
): RequestEnvelopeShallow {
  if (adaptor.decodeEnvelope !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new Error('请求体不是合法 JSON（S1 浅解析阶段即失败，避免无谓解码）');
    }
    return adaptor.decodeEnvelope(parsed, ctx);
  }
  // 退化路径：通用字段抽取（openai.chat / anthropic.messages / openai.responses 同形）
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    source_format: adaptor.format as FormatId,
    kind,
    model: typeof obj['model'] === 'string' ? (obj['model'] as string) : '',
    stream: obj['stream'] === true,
    bytes: rawBody.byteLength,
    unmapped: {},
    default_path: '/v1/chat/completions',
  };
}
