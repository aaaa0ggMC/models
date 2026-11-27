/**
 * http/decisions-endpoint.ts —— decision 模态的**入站脸**：`POST /v1/decisions`。
 *
 * 请求体/响应体**就是 canonical 信封的 JSON 序列化**（15 §6.3：这个端点没有
 * 「客户端方言」，canonical 即协议）。本文件因此只做三件事：
 *   1. 校验信封（kind / payload 形状；不合法 → 400 + 一句话）；
 *   2. 选 adaptor：有 native（mock/真实）走 native；没有且降级策略允许时走
 *      chat 模拟（40 §6.3）；**策略检查与 stop 决策不允许降级**——那两类拿不到
 *      真 decision 就明确失败（15 §6.5）；
 *   3. 把响应信封写回客户端（含 `calibration` 标记）。
 *
 * 流式：decision 无流式语义（三家官方均无；25 §1 的 reject 档）——客户端发
 * `stream.enabled: true` → 400。
 *
 * 计量：`units.tokens` + `units.questions`；降级路径的输出**计费**（chat 不像
 * decision 输出免费），native 路径按上游/估算口径。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  DecisionPayload,
  FormatId,
} from '../ir/index.js';
import {
  ModalityRequestError,
  type ModalityEndpointHandler,
  type ModalityEndpointInput,
} from './modality-endpoints.js';

/** adaptor 调用的可选出参。 */
export interface DecisionAdaptorOptions {
  requestId?: string;
  /** 动态路由覆盖：目标渠道的上游 base_url 与鉴权头提供器。 */
  baseUrl?: string;
  headersProvider?: () => Promise<Record<string, string>>;
  /** 目标接入路径与方言（多协议决策分发用）。 */
  accessPath?: string;
  dialect?: string;
}

/** decision 模态上游 adaptor 的产物。 */
export interface DecisionAdaptorOutcome {
  response: CanonicalResponseEnvelope;
  httpStatus: number;
}

/** decision 模态的 provider adaptor 接口（v1 最小面：一个端点，无流式）。 */
export interface DecisionProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;
  /** 该 adaptor 的校准性：mock/真上游 = native；chat 模拟 = degraded。 */
  readonly calibration: 'native' | 'degraded';
  decide(
    req: CanonicalRequestEnvelope,
    opts?: DecisionAdaptorOptions,
  ): Promise<DecisionAdaptorOutcome>;
}

/** 降级策略（15 §6.5 的默认值）。 */
export interface DecisionDegradationPolicy {
  mode: 'never' | 'on_missing_upstream' | 'always';
  /** 是否允许把「高风险判断」降级（策略检查、stop 决策默认不允许）。 */
  allow_degrade_high_stakes?: boolean;
  /** 降级用的 chat 模型（access path + model 由调用方给）。 */
  fallback_model?: string;
}

export const DEFAULT_DECISION_DEGRADATION_POLICY: DecisionDegradationPolicy = {
  mode: 'on_missing_upstream',
  allow_degrade_high_stakes: false,
};

/** decisions 端点的装配依赖。 */
export interface DecisionsEndpointDeps {
  /** native adaptor（mock 或真实上游）。不传 = 没有 native 上游。 */
  native?: DecisionProviderAdaptor;
  /** 动态目标解析（当请求命中命名空间/别名渠道时，覆盖上游 baseUrl 与鉴权头）。 */
  resolveTarget?: (accessPath: string) => DecisionAdaptorOptions | undefined;
  /** 降级 adaptor（chat 模拟）。不传 = 不能降级。 */
  degraded?: DecisionProviderAdaptor;
  policy?: DecisionDegradationPolicy;
}

/**
 * 高风险问题识别（降级禁区）。
 *
 * 判据：问题 id / prompt 里出现策略检查与 stop 决策的关键词。这是**保守**的
 * 文本启发式——漏判（放过一个高风险问题）比误判（把一个普通问题当高风险）危险，
 * 所以关键词表从宽。接入 dog-fooding 消费点（20 §6）后应改成显式标记。
 */
const HIGH_STAKES_PATTERN = /(policy|策略|safety|安全检查|stop|停止|escalate|升级|compact|压缩)/i;

function isHighStakes(payload: DecisionPayload): boolean {
  return payload.questions.some(
    (q) => HIGH_STAKES_PATTERN.test(q.id) || HIGH_STAKES_PATTERN.test(q.prompt),
  );
}

// ---------------------------------------------------------------------------
// 信封校验（请求体即 canonical 信封）
// ---------------------------------------------------------------------------

function decodeDecisions(input: ModalityEndpointInput): CanonicalRequestEnvelope {
  if (input.kind !== 'json') {
    throw new ModalityRequestError('decisions 只接受 application/json');
  }
  const body = input.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ModalityRequestError('请求体必须是 JSON 对象');
  }
  const env = body as Record<string, unknown>;
  if (env['ir_version'] !== undefined && env['ir_version'] !== 'ag-ir/1') {
    throw new ModalityRequestError('字段 ir_version 应为 "ag-ir/1"');
  }
  if (env['kind'] !== undefined && env['kind'] !== 'decision') {
    throw new ModalityRequestError('字段 kind 应为 "decision"');
  }
  if (typeof env['model'] !== 'string' || env['model'] === '') {
    throw new ModalityRequestError('缺少字段 model（decision 模型 id）');
  }
  if (env['source_format'] !== undefined && typeof env['source_format'] !== 'string') {
    throw new ModalityRequestError('字段 source_format 应为字符串');
  }
  if (env['stream'] !== undefined) {
    if (
      env['stream'] === true ||
      (typeof env['stream'] === 'object' &&
        env['stream'] !== null &&
        (env['stream'] as { enabled?: unknown }).enabled === true)
    ) {
      throw new ModalityRequestError('decision 不支持流式');
    }
  }

  // 支持两种形态：
  //   1. 标准信封：{ model, payload: { content, questions, ... } }（ir_version/kind/source_format 可省略）
  //   2. 简洁扁平：{ model, content, questions }（自动包装为标准 DecisionPayload）
  let rawPayload = env['payload'];
  if (rawPayload === undefined && Array.isArray(env['questions'])) {
    const rawContent = env['content'];
    const normalizedContent =
      typeof rawContent === 'string'
        ? [{ text: rawContent }]
        : Array.isArray(rawContent)
          ? rawContent
          : [];
    rawPayload = {
      content: normalizedContent,
      questions: env['questions'],
      ...(env['include_option_probabilities'] === undefined
        ? {}
        : { include_option_probabilities: env['include_option_probabilities'] }),
      ...(env['include_rationale'] === undefined
        ? {}
        : { include_rationale: env['include_rationale'] }),
      ...(env['params'] === undefined ? {} : { params: env['params'] }),
      raw: {},
    };
  }
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    throw new ModalityRequestError('缺少字段 payload（或顶层 questions 数组）');
  }
  const p = rawPayload as Record<string, unknown>;
  if (!Array.isArray(p['questions']) || (p['questions'] as unknown[]).length === 0) {
    throw new ModalityRequestError('payload.questions 应为非空数组');
  }
  if ((p['questions'] as unknown[]).length > 1000) {
    throw new ModalityRequestError('payload.questions 超过 1000（Gemini 上限）');
  }
  for (const q of p['questions'] as Array<Record<string, unknown>>) {
    if (typeof q['id'] !== 'string' || q['id'] === '') {
      throw new ModalityRequestError('每个问题都要有非空 id');
    }
    const type = q['type'];
    if (
      type !== 'binary' &&
      type !== 'choice' &&
      type !== 'scale' &&
      type !== 'rubric' &&
      type !== 'box'
    ) {
      throw new ModalityRequestError(
        `问题类型应为 binary / choice / scale / rubric / box（收到 ${String(type)}）`,
      );
    }
    if (typeof q['prompt'] !== 'string' || q['prompt'] === '') {
      throw new ModalityRequestError('每个问题都要有非空 prompt');
    }
  }

  const normalizedPayload: Record<string, unknown> = {
    ...p,
    content: Array.isArray(p['content'])
      ? p['content']
      : typeof p['content'] === 'string'
        ? [{ text: p['content'] }]
        : [],
    raw: typeof p['raw'] === 'object' && p['raw'] !== null ? p['raw'] : {},
  };

  return {
    ...env,
    ir_version: 'ag-ir/1',
    kind: 'decision',
    model: env['model'],
    source_format: (env['source_format'] as string | undefined) ?? 'mock.decisions',
    stream:
      typeof env['stream'] === 'object' && env['stream'] !== null
        ? env['stream']
        : { mode: 'none', enabled: false },
    payload: normalizedPayload,
    raw: typeof env['raw'] === 'object' && env['raw'] !== null ? env['raw'] : {},
  } as unknown as CanonicalRequestEnvelope;
}

function encodeDecisionsResponse(res: CanonicalResponseEnvelope): unknown {
  // 请求体即响应体（canonical 信封）——唯一加工：把 raw.nodes 里的内部字段摘掉，
  // 不回客户端（raw 默认不回给客户端，20 §7.2）。
  const { raw, ...rest } = res;
  void raw;
  return rest;
}

// ---------------------------------------------------------------------------
// Handler 工厂
// ---------------------------------------------------------------------------

/** 建 decisions 端点的 handler。 */
export function createDecisionsEndpointHandler(
  deps: DecisionsEndpointDeps,
): ModalityEndpointHandler {
  const policy = deps.policy ?? DEFAULT_DECISION_DEGRADATION_POLICY;
  const native = deps.native;
  const degraded = deps.degraded;

  return {
    id: 'decisions',
    path: '/v1/decisions',
    kind: 'decision',
    provider: native?.provider ?? degraded?.provider ?? 'none',
    access_path: native?.access_path ?? degraded?.access_path ?? 'none',
    client_format: 'mock.decisions' as FormatId,
    provider_format: (native?.access_path ?? degraded?.access_path ?? 'mock.decisions') as FormatId,
    input: 'json',
    decodeRequest: decodeDecisions,

    async run(req: CanonicalRequestEnvelope, target): Promise<CanonicalResponseEnvelope> {
      const payload = req.payload as DecisionPayload;
      const resolvedOpts =
        target !== undefined && deps.resolveTarget !== undefined
          ? deps.resolveTarget(target.access_path)
          : undefined;
      const opts: DecisionAdaptorOptions = resolvedOpts ?? {};
      // 降级三态（ir/decision.ts 的 DecisionDegradationPolicy）：
      //   never              → 只用 native；没有 native 明确失败；
      //   on_missing_upstream → 有 native 用 native，没有才降级（默认）；
      //   always             → 有 degraded 就用 degraded（调试/对照用）。
      // 降级还要过高风险关：策略检查与 stop 决策不允许降级（15 §6.5）。
      const preferDegraded = policy.mode === 'always' && degraded !== undefined;
      const canUseNative =
        native !== undefined &&
        (deps.resolveTarget === undefined || resolvedOpts !== undefined);
      const degradeAllowed =
        degraded !== undefined &&
        policy.mode !== 'never' &&
        (isHighStakes(payload) ? policy.allow_degrade_high_stakes === true : true);

      let outcome: DecisionAdaptorOutcome;
      if (preferDegraded && degraded !== undefined) {
        outcome = await degraded.decide(req, opts);
      } else if (canUseNative && native !== undefined) {
        outcome = await native.decide(req, opts);
      } else if (degradeAllowed && degraded !== undefined) {
        outcome = await degraded.decide(req, opts);
      } else {
        // 没有 native 也不允许降级：明确失败，不用 chat 顶替（15 §6.5）
        throw new ModalityRequestError(
          '路由不到 decision 上游，且该类判断不允许降级（策略检查/stop 决策需真 decision 模型）',
        );
      }
      return outcome.response;
    },

    encodeResponse: encodeDecisionsResponse,
  };
}
