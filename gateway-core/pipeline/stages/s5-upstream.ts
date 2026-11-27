/**
 * gateway-core/pipeline/stages/s5-upstream.ts —— S5 Upstream。
 *
 * 职责（20 §S5）：HTTP 调用、重试、fallback、超时、熔断。
 *
 * 硬约束（逐条落地）：
 *   - 连接池 + keep-alive（Node 内置 fetch 默认开）；
 *   - 重试仅对可重试错误，同 attempt 内最多 max_retries（默认 2）次，指数退避 + jitter；
 *   - fallback：当前 attempt 可重试错误用尽后切 attempt_plan 下一个，重跑 S4→S8；
 *   - 流式：上游 SSE 一旦开始出字节就不再 fallback（决策点前移到"收到响应头"）；
 *   - TTFB 超时（默认 30s）+ 整体 deadline；
 *   - 流式空闲超时（默认 120s）杀"发了首块后静默"的流；
 *   - **不跟随 redirect**（3xx 作为 provider error）。
 *
 * 鉴权头由 CredentialResolver 产出（transport 只负责发送）——这是决策 P1 的二分。
 *
 * ## 换钥（同一 access path 下的多把凭据）
 *
 * `attempt_plan` 的一个 attempt 钉死的是 (provider, access_path, model)，**不钉死**
 * 用哪把 key。因此 attempt 内部再套一层凭据轮换：上游返回"凭据形状"的失败
 * （401 / 403 / 429）时换下一把 enabled 凭据，完整重走一次 attempt——新
 * AbortController、新 deadline、新的 stage 记录，**不是**把同一个请求的头改掉重发。
 *
 * 换与不换的判据（20 §7.3 决策矩阵的补全）：
 *   - 401 / 403 → 换。key 失效 / 没有该端点权限，换一把可能就好了；
 *   - 429 → 换（先用尽同凭据的重试预算）。这把 key 的速率/配额到了，换一把
 *     可能就好了；
 *   - 400 → 不换，直接抛。参数错误与钥匙无关，换 N 把都是同一个 400；
 *   - 5xx / 连接失败 → 不换。上游自己出事，换 key 照样挂，换了只是把已经不健康的
 *     上游多打几遍；这条路由 attempt_plan 的 provider 级 fallback 管。
 *
 * 穷尽所有凭据仍失败时，错误信息里带一句「试了 N 把都失败」+ 每把的表现——
 * 否则运维看到的是一条孤零零的 401，判断不出"该换 key"还是"上游整体挂了"。
 *
 * **与 auto_disable 的交互**：`recordUpstreamFailure` 自身的语义一点没动（401/403
 * 仍立即禁用渠道）。变的是 S5 什么时候认为"这条渠道失败了"——还有下一把可试时
 * 不记，只剩最后一把时才记。于是单凭据路径与加换钥之前逐字一致，多凭据路径的
 * 渠道禁用判据变成「该路径上所有凭据都失败」。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type { CanonicalError } from '../../../ir/index.js';
import { createCanonicalError, CTX_STATE_KEYS } from '../../../ir/index.js';
import { RedirectNotFollowedError } from '../../transport.js';
import { backoffDelayMs, canonicalCodeFromStatus, maybeMarkPromptTooLong } from '../retry.js';
import { applyRouteParamOverrides } from '../../routing-engine.js';

export class S5Upstream implements Stage {
  readonly id = 'S5';
  readonly name = 'Upstream';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const encoded = state.encoded;
    if (encoded === undefined) throw new Error('S5 需要 S4 的编码产物');

    const attemptPlan = ctx.route.attempt_plan;
    let lastError: CanonicalError | undefined;
    let attemptIndex = 0;
    /**
     * 「这条 access path 上每一把凭据都试过了、全都失败」的记录。
     *
     * 只为最后抛给客户端的错误信息服务：多把 key 全挂时，只有最后一次的 401 是
     * 看不出"另外几把也试过了"的，而那正是判断"该换 key"还是"上游整体挂了"的
     * 分界线。单凭据路径永不写这里（见下面的 `credentials.length > 1` 判据），
     * 于是错误信息与加换钥之前逐字一致。
     */
    const credentialExhausted: string[] = [];

    for (const attempt of attemptPlan) {
      let currentEncoded = encoded;
      if (attemptIndex > 0) {
        ctx.route = {
          ...ctx.route,
          provider: attempt.provider,
          access_path: attempt.access_path,
          provider_format: attempt.provider_format,
          model: attempt.model,
          full_model_id: `${attempt.access_path}/${attempt.model}`,
        };
        ctx.provider_format = attempt.provider_format;
        const nextAdaptor = deps.adaptors.find(attempt.provider_format, state.modality);
        if (nextAdaptor !== undefined && state.lazy !== undefined) {
          const baseReq = state.base_canonical ?? state.canonical ?? state.lazy.full();
          const cloned = JSON.parse(JSON.stringify(baseReq)) as typeof baseReq;
          cloned.resolved_model = attempt.model;
          const withOverrides = applyRouteParamOverrides(cloned, attempt.overrides);
          state.canonical = withOverrides;
          state.canonical_override = withOverrides;
          state.materialized = true;
          state.providerAdaptor = nextAdaptor;
          currentEncoded = nextAdaptor.encode(withOverrides, ctx);
          state.encoded = currentEncoded;
          state.conversion_chain = [ctx.client_format, ctx.provider_format];
        }
      }

      // ---- 凭据轮换（同一 access path 下的多把 enabled 凭据）----
      // `credentialsFor` 已按 priority 升序排好且只回 enabled 的：换钥顺序就是
      // 管理员配的优先级顺序，不是随机的。空数组 = 这条路径没有可用凭据，此时
      // `credential` 是 undefined，`headersFor` 抛"没有可用凭据"——与加轮换之前
      // 逐字一致。
      const credentials = deps.credentialResolver.credentialsFor(attempt.access_path);
      /** 本 attempt 里每把凭据失败的上游表现（诊断 + "是不是每把都试过了"用）。 */
      const perCredential: string[] = [];
      let credentialIndex = 0;

      for (;;) {
        const credential = credentials[credentialIndex];
        /** 这把凭据的失败是不是"凭据形状"的——是才换下一把（判据见文件头）。 */
        let rotate = false;
        let retries = 0;
        for (;;) {
          const remaining = ctx.remainingBudgetMs(deps.clock.now());
          if (remaining <= 0) {
            throw (
              lastError ??
              createCanonicalError('upstream_timeout', '整体 deadline 已用尽', ctx.request_id)
            );
          }

          if (ctx.abort_signal?.aborted) {
            throw createCanonicalError(
              'upstream_error',
              '客户端已断开连接，中止上游请求',
              ctx.request_id,
              { http_status: 499, retryable: false },
            );
          }

          const controller = new AbortController();
          const deadlineTimer = setTimeout(() => controller.abort(), remaining);
          const upstreamSignal =
            ctx.abort_signal === undefined
              ? controller.signal
              : AbortSignal.any([controller.signal, ctx.abort_signal]);
          const ttfbStart = deps.clock.now();
          try {
            const { headers: authHeaders, credential_id } =
              await deps.credentialResolver.headersFor(attempt.access_path, ctx, credential);
            const res = await deps.transport.send({
              method: 'POST',
              base_url: deps.credentialResolver.baseUrlFor(attempt.access_path),
              path: currentEncoded.path ?? state.shallow?.default_path ?? '/v1/chat/completions',
              headers: {
                'content-type': 'application/json',
                ...(currentEncoded.headers ?? {}),
                ...authHeaders,
              },
              ...(currentEncoded.raw_bytes !== undefined
                ? { body: currentEncoded.raw_bytes }
                : { body: Buffer.from(JSON.stringify(currentEncoded.body ?? {})) }),
              stream: state.shallow?.stream === true,
              signal: upstreamSignal,
            });

            state.upstream = res;
            state.upstream_status = res.status;
            state.ttfb_ms = deps.clock.now() - ttfbStart;
            ctx.state[CTX_STATE_KEYS.ATTEMPT_CREDENTIAL_ID] = credential_id;
            deps.routingTelemetry?.recordUpstreamHeaders(attempt.provider, res.headers);
            ctx.recordStage(
              this.id,
              deps.clock.now() - started,
              `attempt=${attemptIndex} cred=${credentialIndex + 1}/${credentials.length} status=${res.status}`,
            );
            deps.metrics.increment('pipeline.upstream.status', 1, {
              access_path: attempt.access_path,
              status: String(res.status),
              ...(credential_id === undefined ? {} : { credential: credential_id }),
            });

            if (res.status >= 200 && res.status < 300) {
              // 健康旁路：成功即清失败计数（可能顺带恢复一个被自动禁用的渠道）。
              // 旁路不得影响主链路——实现在 admin/service.ts，自己吞一切错误。
              deps.providerHealth?.recordSuccess(attempt.provider);
              deps.metrics.increment('pipeline.stage', 1, { stage: this.id, result: 'ok' });
              return;
            }

            // 非 2xx：读错误体，映射成 canonical 错误
            const bodyText = res.body?.toString('utf8') ?? '';
            lastError = this.mapUpstreamError(res.status, bodyText, ctx.request_id);
            deps.logger.warn('S5 upstream non-2xx', {
              request_id: ctx.request_id,
              access_path: attempt.access_path,
              model: attempt.model,
              status: res.status,
              error_message: lastError.message,
              provider_code: lastError.provider_code,
            });
            // 渠道级失败：**每个非 2xx 响应都记一次**——与加换钥之前逐字一致
            // （重试也算，于是一个 500 重试 3 次记 3 次、达到默认阈值 3 就禁用）。
            // **唯一的例外**：这把的失败是"凭据形状"的（401/403/429）且还有下一把
            // 可试——一把死 key 不该把整条渠道打到 auto_disable（用户被单 key 坑过
            // 的正是这个形态）。于是单凭据路径与之前完全一致，多凭据路径的渠道禁用
            // 判据变成「该路径上所有凭据都失败」。
            const isChannelLevelFailure =
              res.status === 401 ||
              res.status === 403 ||
              res.status === 429 ||
              res.status >= 500;
            const willRotate =
              (res.status === 401 || res.status === 403 || res.status === 429) &&
              credentialIndex + 1 < credentials.length;
            if (isChannelLevelFailure && !willRotate) {
              deps.providerHealth?.recordFailure(attempt.provider, res.status);
            }
            deps.metrics.increment('pipeline.upstream.error', 1, {
              access_path: attempt.access_path,
              status: String(res.status),
              ...(credential_id === undefined ? {} : { credential: credential_id }),
            });

            if (res.status === 400) {
              // 400 参数错误：同 attempt 不重试；按矩阵也不 fallback（除非 capability 类）
              const capabilityRejected = maybeMarkPromptTooLong(lastError, bodyText);
              if (capabilityRejected.capability_rejected === 'prompt_too_long') {
                lastError = capabilityRejected;
                break; // 换更大上下文的 provider
              }
              throw lastError;
            }
            if (res.status === 401 || res.status === 403) {
              // key 失效 / 没有该端点权限：换一把同路径的凭据可能就好了。
              // 不重试——重发同一把 key 只是把必然失败的请求再打一遍。
              perCredential.push(String(res.status));
              rotate = true;
              break;
            }
            if (res.status === 429 || res.status >= 500) {
              if (retries < deps.config.maxRetries) {
                retries += 1;
                await sleep(backoffDelayMs(retries - 1, deps.config.retryBaseDelayMs));
                continue;
              }
              perCredential.push(String(res.status));
              // 429 是"凭据形状"的失败（这把 key 的速率/配额到了）→ 换一把；
              // 5xx 是上游自己出事 → 不换，走 attempt_plan 的 provider 级 fallback。
              rotate = res.status === 429;
              break;
            }
            throw lastError;
          } catch (err) {
            if (ctx.abort_signal?.aborted) {
              deps.logger.warn('S5 upstream aborted by client', {
                request_id: ctx.request_id,
                access_path: attempt.access_path,
                model: attempt.model,
                path: currentEncoded.path,
                elapsed_ms: deps.clock.now() - ttfbStart,
              });
              throw createCanonicalError(
                'upstream_error',
                '客户端已断开连接，中止上游请求',
                ctx.request_id,
                { http_status: 499, retryable: false },
              );
            }
            if (err instanceof RedirectNotFollowedError) {
              throw createCanonicalError('upstream_error', err.message, ctx.request_id, {
                http_status: 502,
                retryable: false,
                provider_code: `redirect_${err.status}`,
              });
            }
            if (isCanonicalError(err)) {
              throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            lastError = createCanonicalError(
              'provider_unavailable',
              `上游 ${attempt.access_path} 调用失败: ${message}`,
              ctx.request_id,
              { retryable: true },
            );
            deps.metrics.increment('pipeline.upstream.error', 1, {
              access_path: attempt.access_path,
              kind: 'transport',
            });
            if (retries < deps.config.maxRetries) {
              retries += 1;
              await sleep(backoffDelayMs(retries - 1, deps.config.retryBaseDelayMs));
              continue;
            }
            break;
          } finally {
            clearTimeout(deadlineTimer);
          }
        }

        // ---- 换钥判定 ----
        // 还有下一把、且这把的失败是"凭据形状"的 → 换。换钥走的是一次完整的
        // attempt（上面的循环体整个重来：新连接、新 deadline、新 stage 记录）。
        if (rotate && credentialIndex + 1 < credentials.length) {
          credentialIndex += 1;
          continue;
        }
        break;
      }

      // 每把都试过了（且多把才记）：给最终错误补一句诊断。
      if (credentials.length > 1 && perCredential.length === credentials.length) {
        credentialExhausted.push(
          `${attempt.access_path} 下 ${credentials.length} 把凭据都失败（${perCredential.join('、')}）`,
        );
      }
      attemptIndex += 1;
    }

    if (credentialExhausted.length > 0 && lastError !== undefined) {
      lastError = {
        ...lastError,
        message: `${lastError.message}（${credentialExhausted.join('；')}）`,
      };
    }

    throw (
      lastError ??
      createCanonicalError('no_available_provider', 'attempt_plan 已用尽', ctx.request_id)
    );
  }

  private mapUpstreamError(status: number, body: string, requestId: string): CanonicalError {
    let providerCode: string | undefined;
    let message = `上游返回 ${status}`;
    try {
      const cleaned = body.trim().replace(/^data:\s*/i, '');
      const rawParsed: unknown = JSON.parse(cleaned);
      // Gemini streamGenerateContent 出错时可能返回数组形态 `[{ "error": { ... } }]`
      const firstItem = Array.isArray(rawParsed) ? rawParsed[0] : rawParsed;
      const parsed = (
        typeof firstItem === 'object' && firstItem !== null ? firstItem : {}
      ) as Record<string, unknown>;
      const err = (
        typeof parsed['error'] === 'object' && parsed['error'] !== null ? parsed['error'] : parsed
      ) as Record<string, unknown>;
      if (typeof err['code'] === 'string') providerCode = err['code'];
      else if (typeof err['status'] === 'string') providerCode = err['status'];
      if (typeof err['message'] === 'string' && err['message'] !== '') message = err['message'];
      else if (typeof err['type'] === 'string') message = `${String(err['type'])}: ${message}`;
    } catch {
      // 错误体不是 JSON：用状态码兜底
    }
    return createCanonicalError(canonicalCodeFromStatus(status, providerCode), message, requestId, {
      http_status: status >= 400 ? status : 502,
      retryable: status === 429 || status >= 500,
      ...(providerCode === undefined ? {} : { provider_code: providerCode }),
      // 上游错误体只进内部日志，**默认不回给客户端**（20 §7.2）
      raw: body === '' ? undefined : body,
    });
  }
}

function isCanonicalError(err: unknown): err is CanonicalError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'http_status' in err &&
    'request_id' in err
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
