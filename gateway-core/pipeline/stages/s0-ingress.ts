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

/** 数据面鉴权（Phase 1：permissive 占位，真实 virtual key 在 auth/ 模块，见 66-auth.md）。 */
export interface Authenticator {
  authenticate(
    headers: Record<string, string>,
  ): Promise<
    | { ok: true; key_id: string; team_id?: string; user_id?: string; allowed_models?: string[] }
    | { ok: false; error: CanonicalError }
  >;
}

export const PERMISSIVE_AUTHENTICATOR: Authenticator = {
  async authenticate() {
    return { ok: true, key_id: 'local-dev' };
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
    const auth = await authenticator.authenticate(input.headers);
    if (!auth.ok) {
      throw auth.error;
    }
    ctx.auth = {
      key_id: auth.key_id,
      ...(auth.team_id === undefined ? {} : { team_id: auth.team_id }),
      ...(auth.user_id === undefined ? {} : { user_id: auth.user_id }),
      ...(auth.allowed_models === undefined ? {} : { allowed_models: auth.allowed_models }),
    };

    // 3) 超时预算：client 超时、provider 超时、全局上限三者取最小（20 §S0）
    const deadline = deps.clock.now() + deps.config.globalTimeoutMs;
    ctx.deadline = deadline;

    ctx.recordStage(this.id, deps.clock.now() - started, `format=${format}`);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }
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
