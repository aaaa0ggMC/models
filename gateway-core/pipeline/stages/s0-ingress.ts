/**
 * gateway-core/pipeline/stages/s0-ingress.ts —— S0 Ingress。
 *
 * 职责（20 §S0）：识别客户端格式、鉴权、限流、分配 request_id、超时预算。
 * 鉴权失败、限流超限、模型不在允许列表 → 直接返回，**不进 S1**（避免无谓解码开销）。
 *
 * 格式识别优先级（20 §S0 第 1 条，逐条落地）：
 *   1. 显式 header `x-agentgateway-format`；
 *   2. 路径签名；
 *   3. body 结构嗅探；
 *   4. 都不命中 → 400 unsupported_format。
 */

import type { CanonicalError, FormatId } from '../../../ir/index.js';
import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import { createCanonicalError } from '../../../ir/index.js';
import { MutableRequestContext } from '../../context.js';

/** 显式格式头。 */
export const FORMAT_HEADER = 'x-agentgateway-format';

const PATH_SIGNATURES: Array<{ pattern: RegExp; format: FormatId }> = [
  { pattern: /^\/v1\/chat\/completions$/, format: 'openai.chat' },
  { pattern: /^\/v1\/responses$/, format: 'openai.responses' },
  { pattern: /^\/v1\/messages$/, format: 'anthropic.messages' },
  { pattern: /^\/v1beta\/models\/[^:]+:generateContent$/, format: 'gemini.generateContent' },
  { pattern: /^\/v1beta\/models\/[^:]+:streamGenerateContent$/, format: 'gemini.generateContent' },
];

/**
 * body 结构嗅探（20 §S0 第 3 条）：
 *   存在 `input` 且无 `messages` → Responses；
 *   存在 `contents` → Gemini；
 *   存在顶层 `system` 字段或 `messages[].content` 为 block 数组 → Anthropic。
 */
export function sniffFormat(body: unknown): FormatId | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  if ('contents' in obj) return 'gemini.generateContent';
  if ('input' in obj && !('messages' in obj)) return 'openai.responses';
  if ('system' in obj && 'messages' in obj) return 'anthropic.messages';
  const messages = obj['messages'];
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0] as Record<string, unknown>;
    if (first !== undefined && Array.isArray(first['content'])) return 'anthropic.messages';
  }
  return undefined;
}

/**
 * 数据面鉴权的输入。
 *
 * `headers` 是**已脱敏**的头（http/server.ts 的 `sanitizeHeaders` 剥掉了
 * authorization / x-api-key / cookie，它们只以 `auth_material` 的形态进来，
 * 且**绝不进 `client_raw_headers` → trace / 日志**）。
 *
 * 为什么要把 query / path / raw_body 也给鉴权器：66 §2.2 的第三种形态是
 * `?key=`，而 20 §S0 第 2 条要求「模型不在允许列表 → 直接返回，不进 S1」——
 * 模型在 body 里（Gemini 在 path 里），没有这两个字段就没法在 S0 判。
 */
export interface AuthRequest {
  /** 已脱敏的请求头。 */
  headers: Record<string, string>;
  /** 查询参数（`?key=` 在这里）。 */
  query: Record<string, string>;
  /** 端点路径（Gemini 的 model-in-path 场景用）。 */
  path: string;
  /** 原始请求体（只在 key 带模型限制时才解析）。 */
  raw_body: Buffer;
  /**
   * 未经脱敏的鉴权原语（authorization / x-api-key / query key）。
   *
   * **绝不进 trace / 日志 / UsageRecord**：它和 `headers` 分开传递，就是为了
   * 让「把它抄进 ctx」这件事在任何地方都看不出来是被允许的。
   */
  auth_material?: {
    authorization?: string;
    api_key?: string;
    query_key?: string;
  };
}

/** 鉴权通过。 */
export interface AuthSuccess {
  key_id: string;
  team_id?: string;
  user_id?: string;
  /** 该 key 允许的模型（66 §2.1；空 = 全部）。 */
  allowed_models?: string[];
  /** 该 key 允许的 provider（S2 按解析出的 provider 校验）。 */
  allowed_providers?: string[];
  /** 是否允许开 Tier-2 消息持久化（66 §2.1；v1 只透传）。 */
  allow_message_persistence?: boolean;
  /** 认证方式（日志/审计用；**不含任何凭据**）。 */
  via: 'virtual_key' | 'access_token' | 'permissive';
}

export interface AuthFailure {
  ok: false;
  error: CanonicalError;
}

export interface AuthPass {
  ok: true;
}

export type AuthOutcome = (AuthSuccess & AuthPass) | AuthFailure;

/** 数据面鉴权（66 §2）。实现见 auth/data-plane.ts；Phase 1 的占位见下面。 */
export interface Authenticator {
  authenticate(request: AuthRequest): Promise<AuthOutcome>;
}

/** 当前生效的数据面认证模式（互斥语义见 auth/data-plane.ts 的文件头）。 */
export type DataPlaneAuthMode = 'virtual_key' | 'access_token' | 'permissive';

/**
 * Phase 1 的占位鉴权器：不校验任何东西，`key_id` 恒为 `local-dev`。
 *
 * **保留是有意的**：`createGateway()` 不注入任何鉴权配置时（测试、demo、
 * 本地裸跑）行为与本轮改动之前完全一致。真正的鉴权在
 * `auth/data-plane.ts` 的 `DataPlaneAuthenticator`，由组合根按配置装配。
 */
export const PERMISSIVE_AUTHENTICATOR: Authenticator = {
  async authenticate() {
    return { ok: true, key_id: 'local-dev', via: 'permissive' };
  },
};

export interface S0Options {
  authenticator?: Authenticator;
}

export class S0Ingress implements Stage {
  readonly id = 'S0';
  readonly name = 'Ingress';

  constructor(private readonly options: S0Options = {}) {}

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx, input } = state;

    // 1) 格式识别
    const headerFormat = input.headers[FORMAT_HEADER];
    let format: FormatId | undefined =
      headerFormat !== undefined ? (headerFormat as FormatId) : undefined;
    if (format === undefined) {
      for (const sig of PATH_SIGNATURES) {
        if (sig.pattern.test(input.path)) {
          format = sig.format;
          break;
        }
      }
    }
    if (format === undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.raw_body.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      format = sniffFormat(parsed);
    }
    if (format === undefined) {
      throw createCanonicalError(
        'unsupported_format',
        `无法识别客户端格式（path=${input.path}，无 ${FORMAT_HEADER} 头，body 嗅探也未命中）`,
        ctx.request_id,
      );
    }

    ctx.client_format = format;
    ctx.provider_format = format;
    ctx.request_bytes = input.raw_body.byteLength;
    state.modality = 'chat'; // Phase 1 只做 chat；多模态端点识别随 adaptor 增加

    // 2) 鉴权（失败直接返回，不进 S1）
    const authenticator = this.options.authenticator ?? PERMISSIVE_AUTHENTICATOR;
    const auth = await authenticator.authenticate({
      headers: input.headers,
      query: input.query,
      path: input.path,
      raw_body: input.raw_body,
      ...(input.auth_material === undefined ? {} : { auth_material: input.auth_material }),
    });
    if (!auth.ok) {
      throw auth.error;
    }
    ctx.auth = {
      key_id: auth.key_id,
      ...(auth.team_id === undefined ? {} : { team_id: auth.team_id }),
      ...(auth.user_id === undefined ? {} : { user_id: auth.user_id }),
      ...(auth.allowed_models === undefined ? {} : { allowed_models: auth.allowed_models }),
      ...(auth.allowed_providers === undefined
        ? {}
        : { allowed_providers: auth.allowed_providers }),
      ...(auth.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: auth.allow_message_persistence }),
    };

    // 2b) 模型白名单（20 §S0 第 2 条：「模型不在允许列表 → 直接返回，不进 S1」）
    //
    // **只在 key 真的带限制时才解析 body**：`extractRequestModel` 要 JSON.parse
    // 整个请求体，而 S1 反正还要再解析一次。 unrestricted 的 key（绝大多数请求）
    // 一次都不该付这个代价——S0 是每个请求的必经之路。
    if (auth.allowed_models !== undefined && auth.allowed_models.length > 0) {
      const requestedModel = extractRequestModel(format, input.path, input.raw_body);
      if (requestedModel !== undefined && !modelAllowed(requestedModel, auth.allowed_models)) {
        throw createCanonicalError(
          'auth_failed',
          `该 key 不允许使用模型 ${requestedModel}`,
          ctx.request_id,
          { http_status: 403 },
        );
      }
    }

    // 3) 超时预算：client 超时、provider 超时、全局上限三者取最小（20 §S0）
    const deadline = deps.clock.now() + deps.config.globalTimeoutMs;
    ctx.deadline = deadline;

    ctx.recordStage(this.id, deps.clock.now() - started, `format=${format}`);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }
}

/**
 * 从请求里取出客户端要用的模型名。
 *
 * OpenAI / Anthropic 在 body 的 `model` 字段；Gemini 把模型放在 path 里
 * （`/v1beta/models/{model}:generateContent`）。取不到返回 undefined——
 * 「不知道模型」不等于「模型不被允许」，那种请求放过去由 S2 报
 * `no_available_provider`，比在 S0 猜一个模型然后误拒要好。
 */
export function extractRequestModel(
  format: FormatId,
  path: string,
  rawBody: Buffer,
): string | undefined {
  if (format === 'gemini.generateContent') {
    const match = /^\/v1beta\/models\/([^:]+):/.exec(path);
    return match?.[1];
  }
  if (rawBody.byteLength === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const model = (parsed as Record<string, unknown>)['model'];
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/**
 * 模型是否在该 key 的白名单里。
 *
 * 规则（与 admin/aliases.ts 的前缀规则同立场，从简）：
 *   - 白名单为空 / 未给 = 全部允许；
 *   - 条目以 `*` 结尾 = 前缀 glob（`deepseek-*` 命中 `deepseek-chat`）；
 *   - 其余 = 精确匹配。
 */
export function modelAllowed(model: string, allowed: string[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.some((entry) => {
    if (entry === model) return true;
    if (entry.endsWith('*')) return model.startsWith(entry.slice(0, -1));
    return false;
  });
}

/** 构造 S0 用的 MutableRequestContext（Runner 调用）。 */
export function createContext(
  requestId: string,
  now: number,
  headers: Record<string, string>,
  traceId: string | undefined,
  onDisableFastPath: (reason: string) => void,
): MutableRequestContext {
  return new MutableRequestContext({
    request_id: requestId,
    started_at: now,
    deadline: now + 300_000,
    client_format: 'openai.chat',
    client_raw_headers: headers,
    auth: { key_id: 'pending' },
    ...(traceId === undefined ? {} : { trace_id: traceId }),
    onDisableFastPath,
  });
}
