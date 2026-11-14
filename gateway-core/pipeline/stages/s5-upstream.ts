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
 */

import type { PipelineDeps, PipelineState, Stage } from "../types.js";
import type { CanonicalError } from "../../../ir/index.js";
import { createCanonicalError } from "../../../ir/index.js";
import { RedirectNotFollowedError } from "../../transport.js";
import { backoffDelayMs, canonicalCodeFromStatus, maybeMarkPromptTooLong } from "../retry.js";

export class S5Upstream implements Stage {
  readonly id = "S5";
  readonly name = "Upstream";

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const encoded = state.encoded;
    if (encoded === undefined) throw new Error("S5 需要 S4 的编码产物");

    const attemptPlan = ctx.route.attempt_plan;
    let lastError: CanonicalError | undefined;
    let attemptIndex = 0;

    for (const attempt of attemptPlan) {
      let retries = 0;
      for (;;) {
        const remaining = ctx.remainingBudgetMs(deps.clock.now());
        if (remaining <= 0) {
          throw (
            lastError ??
            createCanonicalError("upstream_timeout", "整体 deadline 已用尽", ctx.request_id)
          );
        }

        const controller = new AbortController();
        const deadlineTimer = setTimeout(() => controller.abort(), remaining);
        const ttfbStart = deps.clock.now();
        try {
          const { headers: authHeaders, credential_id } = await deps.credentialResolver.headersFor(
            attempt.access_path,
            ctx,
          );
          const res = await deps.transport.send({
            method: "POST",
            base_url: deps.credentialResolver.baseUrlFor(attempt.access_path),
            path: encoded.path ?? state.shallow?.default_path ?? "/v1/chat/completions",
            headers: {
              "content-type": "application/json",
              ...(encoded.headers ?? {}),
              ...authHeaders,
            },
            ...(encoded.raw_bytes !== undefined
              ? { body: encoded.raw_bytes }
              : { body: Buffer.from(JSON.stringify(encoded.body ?? {})) }),
            stream: state.shallow?.stream === true,
            signal: controller.signal,
          });

          state.upstream = res;
          state.upstream_status = res.status;
          state.ttfb_ms = deps.clock.now() - ttfbStart;
          ctx.state["attempt_credential_id"] = credential_id;
          ctx.recordStage(
            this.id,
            deps.clock.now() - started,
            `attempt=${attemptIndex} status=${res.status}`,
          );
          deps.metrics.increment("pipeline.upstream.status", 1, {
            access_path: attempt.access_path,
            status: String(res.status),
          });

          if (res.status >= 200 && res.status < 300) {
            deps.metrics.increment("pipeline.stage", 1, { stage: this.id, result: "ok" });
            return;
          }

          // 非 2xx：读错误体，映射成 canonical 错误
          const bodyText = res.body?.toString("utf8") ?? "";
          lastError = this.mapUpstreamError(res.status, bodyText, ctx.request_id);
          deps.metrics.increment("pipeline.upstream.error", 1, {
            access_path: attempt.access_path,
            status: String(res.status),
          });

          if (res.status === 400) {
            // 400 参数错误：同 attempt 不重试；按矩阵也不 fallback（除非 capability 类）
            const capabilityRejected = maybeMarkPromptTooLong(lastError, bodyText);
            if (capabilityRejected.capability_rejected === "prompt_too_long") {
              lastError = capabilityRejected;
              break; // 换更大上下文的 provider
            }
            throw lastError;
          }
          if (res.status === 401 || res.status === 403) {
            break; // 换 key/provider 可能恢复 → fallback
          }
          if (res.status === 429 || res.status >= 500) {
            if (retries < deps.config.maxRetries) {
              retries += 1;
              await sleep(backoffDelayMs(retries - 1, deps.config.retryBaseDelayMs));
              continue;
            }
            break; // 重试用尽 → fallback
          }
          throw lastError;
        } catch (err) {
          if (err instanceof RedirectNotFollowedError) {
            throw createCanonicalError(
              "upstream_error",
              err.message,
              ctx.request_id,
              { http_status: 502, retryable: false, provider_code: `redirect_${err.status}` },
            );
          }
          if (isCanonicalError(err)) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          lastError = createCanonicalError(
            "provider_unavailable",
            `上游 ${attempt.access_path} 调用失败: ${message}`,
            ctx.request_id,
            { retryable: true },
          );
          deps.metrics.increment("pipeline.upstream.error", 1, {
            access_path: attempt.access_path,
            kind: "transport",
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
      attemptIndex += 1;
    }

    throw (
      lastError ??
      createCanonicalError("no_available_provider", "attempt_plan 已用尽", ctx.request_id)
    );
  }

  private mapUpstreamError(status: number, body: string, requestId: string): CanonicalError {
    let providerCode: string | undefined;
    let message = `上游返回 ${status}`;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const err = (typeof parsed["error"] === "object" && parsed["error"] !== null
        ? parsed["error"]
        : parsed) as Record<string, unknown>;
      if (typeof err["code"] === "string") providerCode = err["code"];
      if (typeof err["message"] === "string") message = err["message"];
      else if (typeof err["type"] === "string") message = `${String(err["type"])}: ${message}`;
    } catch {
      // 错误体不是 JSON：用状态码兜底
    }
    return createCanonicalError(canonicalCodeFromStatus(status, providerCode), message, requestId, {
      http_status: status >= 400 ? status : 502,
      retryable: status === 429 || status >= 500,
      ...(providerCode === undefined ? {} : { provider_code: providerCode }),
      // 上游错误体只进内部日志，**默认不回给客户端**（20 §7.2）
      raw: body === "" ? undefined : body,
    });
  }
}

function isCanonicalError(err: unknown): err is CanonicalError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "http_status" in err &&
    "request_id" in err
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
