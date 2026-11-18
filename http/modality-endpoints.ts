/**
 * http/modality-endpoints.ts —— **模态端点**（image / embedding / decision）的数据面
 * HTTP 装配：鉴权、分发、错误信封、计量落库。
 *
 * ## 与推理路由（S0–S10）的关系
 *
 * 与 `http/tools-endpoint.ts` 完全同构，理由也相同：这三个模态的端点**当前不跑
 * pipeline**。image / embedding / decision 的 dialect 形态（OpenAI Images /
 * Embeddings / Decisions）在 [00](../docs/design/00-overview.md) §4.3 的设计里是
 * 要过 S0–S10 的，但 pipeline 的 fast path / usage 嗅探 / 工具循环都深度假设 chat
 * 形态，硬接会碰那些不变量。因此先用注入端口把「canonical 往返 + 计量」这条链路
 * 打通（四件套里的入站脸、adaptor、计量三样落地），并入轨列为 P1
 * （85-modality-surface-matrix.md §5.2）。并入轨时本文件整体搬进 pipeline 的
 * S1/S6/S8，HTTP 层只剩路径匹配。
 *
 * ## 鉴权（66 §1：两个认证平面不要混）
 *
 * 走**数据面**鉴权（与 S0、`/v1/tools/*` 同一个实例、同一套语义）。管理面会话
 * 令牌在这里不接受——反过来也不行。
 *
 * ## 计量
 *
 * 每次调用（成功与失败都记）落一条 `UsageRecord`：
 *   - `client_format` = 入站 dialect（如 `openai.images.generations`）；
 *   - `provider_format` = 上游 dialect（同款 id）；
 *   - `access_path` = 上游 access path（如 `openai.images`）；
 *   - `usage.units` 按模态分（image：`images` + `tokens`；embedding：`tokens`；
 *     decision：`tokens` + `questions`）；
 *   - `cost` 走注入的定价端口（token 槽位 / `per_image` 都能表达）；没有定价端口
 *     或表里没有该模型 → `pending_price` / `unpriced`，**不是免费**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalUsage,
  FormatId,
  ModalityKind,
} from '../ir/index.js';
import type { UsageRecord } from '../metering/index.js';
import { createUsageRecord } from '../metering/usage-record.js';
import type { UsageEmitter } from '../metering/emitter.js';
import type { Clock, IdGenerator } from '../di/ports.js';
import { MultipartError, parseMultipartFormData, type ParsedFormData } from './multipart.js';

/** 请求体大小上限（images/edits 的 base64 图片可以很大；与 /v1/tools/* 同量级）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 请求体不合法（http 层 → 400 + 一句话）。 */
export class ModalityRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModalityRequestError';
  }
}

/** 一个模态端点的全部装配信息（http 层只认这个形状）。 */
export interface ModalityEndpointHandler {
  /** 端点 id（计量记录与健康检查用，如 "images.generations"）。 */
  readonly id: string;
  /** 网关路由路径（数据面）。 */
  readonly path: string;
  /** 模态判别。 */
  readonly kind: ModalityKind;
  /** 归属 provider（计量用）。 */
  readonly provider: string;
  /** 计量记录里的 access path（如 "openai.images"）。 */
  readonly access_path: string;
  /** 入站 dialect（UsageRecord.client_format）。 */
  readonly client_format: FormatId;
  /** 上游 dialect（UsageRecord.provider_format）。 */
  readonly provider_format: FormatId;
  /** 请求体形态：JSON 或 multipart。 */
  readonly input: 'json' | 'multipart';
  /**
   * 客户端请求体 → canonical 请求信封。**纯函数**，可单测。
   * 请求不合法时抛 `ModalityRequestError`（http 层映射成 400）。
   */
  decodeRequest(input: ModalityEndpointInput): CanonicalRequestEnvelope;
  /** 跑上游，返回 canonical 响应信封。非 2xx 抛带 `status` 的 Error（http 层分类）。 */
  run(
    req: CanonicalRequestEnvelope,
    target?: { provider: string; access_path: string },
  ): Promise<CanonicalResponseEnvelope>;
  /** canonical 响应信封 → 客户端 JSON。**纯函数**，可单测。 */
  encodeResponse(res: CanonicalResponseEnvelope): unknown;
}

/** decodeRequest 的入参：JSON 端点收解析后的值，multipart 端点收解析出的表单。 */
export type ModalityEndpointInput =
  { kind: 'json'; body: unknown } | { kind: 'multipart'; parts: ParsedFormData };

export interface ModalityEndpoints {
  /** 处理一个已登记路径的请求；返回 true = 已处理（含 4xx/5xx 响应）。 */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    readBody: () => Promise<Buffer | undefined>,
  ): Promise<boolean>;
  /** 已登记的端点清单（健康检查 / 文档用）。 */
  list(): Array<{
    id: string;
    path: string;
    kind: ModalityKind;
    provider: string;
    access_path: string;
  }>;
}

/** 定价端口（与 metering/pricing.ts 的 PricingService 兼容）。 */
export interface ModalityPricingPort {
  price(req: {
    ts: number;
    model: string;
    usage: CanonicalUsage;
    provider?: string;
    access_path?: string;
  }): {
    cost: import('../metering/pricing.js').UsageCost;
    price_snapshot: import('../metering/pricing.js').PriceSnapshot | null;
    estimate_method?: string;
    estimated_usage?: CanonicalUsage;
  };
}

export interface ModalityEndpointsDeps {
  handlers: ModalityEndpointHandler[];
  /** 数据面鉴权器（与 S0 同一个实例）。 */
  authenticator: {
    authenticate(request: {
      headers: Record<string, string>;
      query: Record<string, string>;
      path: string;
      raw_body: Buffer;
    }): Promise<{ ok: true; key_id: string } | { ok: false; error: { message: string } }>;
  };
  usageEmitter: UsageEmitter;
  clock: Clock;
  ids: IdGenerator;
  /** 定价端口（可选；不注入 = 未接定价表，记 unpriced）。 */
  /** 可选别名/namespace 解析器（用于剥离 `<ns>/<model>` 前缀与展开别名）。 */
  aliasResolver?: {
    resolve(
      model: string,
      modality: ModalityKind,
    ):
      | { source: string; target: { provider: string; access_path: string; model: string } }
      | undefined;
    listNamespaces?: () => readonly { namespace: string; provider: string; enabled: boolean }[];
  };
  pricing?: ModalityPricingPort;
  resolveCredentialId?: (accessPath: string) => string | undefined;
  log?: (message: string) => void;
}

export function createModalityEndpoints(deps: ModalityEndpointsDeps): ModalityEndpoints {
  const byPath = new Map(deps.handlers.map((h) => [h.path, h]));

  return {
    list() {
      return deps.handlers.map((h) => ({
        id: h.id,
        path: h.path,
        kind: h.kind,
        provider: h.provider,
        access_path: h.access_path,
      }));
    },

    async handle(req, res, url, readBody) {
      const handler = byPath.get(url.pathname);
      if (handler === undefined) return false;
      const started = deps.clock.now();

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 POST' } });
        return true;
      }

      // ---- 鉴权（数据面；与 S0 同一实例同一语义）----
      const rawBody = (await readBody()) ?? Buffer.alloc(0);
      const auth = await deps.authenticator.authenticate({
        headers: sanitize(req.headers),
        query: Object.fromEntries(url.searchParams.entries()),
        path: url.pathname,
        raw_body: rawBody,
      });
      if (!auth.ok) {
        // 不回显调用方给的串（那把串可能就是 key）
        emitUsage(deps, handler, started, 'anonymous', 'error', 'auth_failed');
        sendJson(res, 401, { error: { code: 'unauthorized', message: auth.error.message } });
        return true;
      }

      // ---- 解析请求体 ----
      let input: ModalityEndpointInput;
      try {
        input =
          handler.input === 'multipart'
            ? {
                kind: 'multipart',
                // 图片上限比音频宽（gpt-image-1 的图片 ≤25 MiB），按端点收紧 limits
                parts: parseMultipartFormData(rawBody, headerValue(req.headers['content-type']), {
                  max_parts: 32,
                  max_field_bytes: 1024 * 1024,
                  max_file_bytes: 32 * 1024 * 1024,
                  max_header_bytes: 16 * 1024,
                }),
              }
            : { kind: 'json', body: JSON.parse(rawBody.toString('utf8')) as unknown };
      } catch (err) {
        const message =
          err instanceof MultipartError
            ? err.message
            : err instanceof ModalityRequestError
              ? err.message
              : '请求体不是合法 JSON';
        sendJson(res, 400, {
          error: {
            code: err instanceof MultipartError ? err.code : 'invalid_request',
            message,
          },
        });
        return true;
      }

      // ---- 客户端方言 → canonical ----
      let canonical: CanonicalRequestEnvelope;
      let resolvedTarget: { provider: string; access_path: string } | undefined;
      try {
        const resolved = resolveModalityModel(deps, handler, handler.decodeRequest(input));
        canonical = resolved.canonical;
        resolvedTarget = resolved.target;
      } catch (err) {
        const message = err instanceof ModalityRequestError ? err.message : '请求体不合法';
        emitUsage(deps, handler, started, auth.key_id, 'error', 'invalid_request');
        sendJson(res, 400, { error: { code: 'invalid_request', message } });
        return true;
      }

      // ---- 打上游 ----
      let response: CanonicalResponseEnvelope;
      try {
        response = await handler.run(canonical, resolvedTarget);
      } catch (err) {
        const { status, code, message } = classify(err);
        if (isCredentialError(err)) {
          // 凭据缺失是**配置错误**：原文（含该设哪个环境变量）只进服务端日志，
          // 客户端拿一句话（60 §3：错误信息不携带配置细节给调用方）。
          deps.log?.(`模态端点 ${handler.id} 凭据错误: ${errMessage(err)}`);
        }
        emitUsage(deps, handler, started, auth.key_id, 'error', code, canonical, undefined, resolvedTarget);
        sendJson(res, status, { error: { code, message } });
        return true;
      }

      emitUsage(deps, handler, started, auth.key_id, 'success', undefined, canonical, response, resolvedTarget);
      sendJson(res, 200, handler.encodeResponse(response));
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 计量
// ---------------------------------------------------------------------------

/**
 * 落一条 UsageRecord。
 *
 * **失败也记**（与 tools-endpoint 同一立场：429 之前的调用照样可能花了钱）。
 * `model` 取 canonical 信封的 `resolved_model ?? model`——客户端可能发网关别名，
 * 计量要能按上游真实 model 归集；失败时若还没解出 resolved_model 就退客户端名。
 */
function emitUsage(
  deps: ModalityEndpointsDeps,
  handler: ModalityEndpointHandler,
  started: number,
  keyId: string,
  status: 'success' | 'error',
  errorCode: string | undefined,
  canonical?: CanonicalRequestEnvelope,
  response?: CanonicalResponseEnvelope,
  target?: { provider: string; access_path: string },
): void {
  const now = deps.clock.now();
  const model = canonical?.resolved_model ?? canonical?.model ?? handler.id;
  const usage: CanonicalUsage = response?.usage ?? { units: {}, source: 'provider' };
  const targetProvider = target?.provider ?? handler.provider;
  const targetAccessPath = target?.access_path ?? handler.access_path;
  const credentialId = deps.resolveCredentialId?.(targetAccessPath);
  const priced =
    status === 'success' && deps.pricing !== undefined
      ? deps.pricing.price({
          ts: started,
          model,
          usage,
          provider: targetProvider,
          access_path: targetAccessPath,
        })
      : undefined;

  const record: UsageRecord = createUsageRecord({
    request_id: deps.ids.requestId(),
    ts: now,
    auth: { key_id: keyId },
    client_format: handler.client_format,
    provider: targetProvider,
    provider_format: handler.provider_format,
    model,
    ...(canonical?.resolved_model !== undefined && canonical.resolved_model !== canonical.model
      ? { model_alias: canonical.model }
      : {}),
    access_path: targetAccessPath,
    ...(credentialId === undefined ? {} : { credential_id: credentialId }),
    fast_path: false,
    attempts: 1,
    stream: false,
    ttfb_ms: 0,
    total_ms: now - started,
    status,
    ...(errorCode === undefined ? {} : { error_code: errorCode as UsageRecord['error_code'] }),
    ...(response === undefined ? {} : { usage }),
    ...(response?.raw?.nodes?.['usage'] === undefined
      ? {}
      : { usage_raw: response.raw.nodes['usage'] as Record<string, unknown> }),
    ...(priced === undefined
      ? {}
      : {
          cost: priced.cost,
          ...(priced.price_snapshot === null
            ? { price_snapshot: null }
            : { price_snapshot: priced.price_snapshot }),
          ...(priced.estimate_method === undefined
            ? {}
            : { estimate_method: priced.estimate_method }),
          ...(priced.estimated_usage === undefined ? {} : { usage: priced.estimated_usage }),
        }),
    finish_reason: status === 'success' ? 'stop' : 'error',
    // 响应信封的 warnings（usage_missing 等）与端点标记一起落账
    warnings: [`modality_endpoint:${handler.id}`, ...(response?.warnings ?? [])],
  });
  deps.usageEmitter.emit(record);
}

// ---------------------------------------------------------------------------
// 错误分类（一句话 + 一个 code；上游错误体原文不进客户端响应）
// ---------------------------------------------------------------------------

/** 带 HTTP 状态的上游错误（OpenAIImagesApiError / DeepSeekApiError 等都满足这个形状）。 */
interface UpstreamStatusError extends Error {
  status: number;
}

function isUpstreamStatusError(err: unknown): err is UpstreamStatusError {
  return err instanceof Error && typeof (err as { status?: unknown }).status === 'number';
}

/** err.message 的安全读取（分类与日志用）。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 凭据缺失/不可用（EnvCredentialResolver.headersFor 的既定错误文案）。
 *
 * 匹配**我们自己的**错误消息是安全的（那是 resolver 的契约，不是上游字节）；
 * 目的是把「没配 key」从「网络不通」里分出来——前者是配置错误，运维该看
 * 服务端日志里的环境变量名，而不是去排查网络。
 */
function isCredentialError(err: unknown): boolean {
  return err instanceof Error && /没有可用凭据|请设置环境变量/.test(err.message);
}

function classify(err: unknown): { status: number; code: string; message: string } {
  if (isCredentialError(err)) {
    return { status: 502, code: 'key_invalid', message: '上游 Key 未配置或无效' };
  }
  if (isUpstreamStatusError(err)) {
    switch (err.status) {
      case 401:
      case 403:
        return { status: 502, code: 'key_invalid', message: '上游 Key 无效或没有该端点权限' };
      case 404:
        return { status: 502, code: 'upstream_not_found', message: '上游没有这个资源' };
      case 429:
        return { status: 429, code: 'rate_limited', message: '上游限流，请稍后重试' };
      case 408:
        return { status: 504, code: 'upstream_timeout', message: '上游超时' };
      default:
        return { status: 502, code: 'upstream_error', message: `上游返回 HTTP ${err.status}` };
    }
  }
  if (err instanceof ModalityRequestError) {
    return { status: 400, code: 'invalid_request', message: err.message };
  }
  // 网络层失败 / 响应违约：不带 err.message（可能含内网地址 / 完整 URL）
  return { status: 502, code: 'network_error', message: '网关到上游不通' };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 只留鉴权相关的头（其余不进鉴权器，也不进任何记录）。 */
function sanitize(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['authorization', 'x-api-key']) {
    const v = headers[key];
    if (typeof v === 'string') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.join(', ');
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function resolveModalityModel(
  deps: ModalityEndpointsDeps,
  handler: ModalityEndpointHandler,
  canonical: CanonicalRequestEnvelope,
): { canonical: CanonicalRequestEnvelope; target?: { provider: string; access_path: string } } {
  const resolver = deps.aliasResolver;
  if (resolver === undefined) return { canonical };

  const byKind = resolver.resolve(canonical.model, handler.kind);
  let resolved: string | undefined;
  let target: { provider: string; access_path: string } | undefined;
  if (byKind !== undefined) {
    resolved = byKind.target.model;
    target = { provider: byKind.target.provider, access_path: byKind.target.access_path };
  } else {
    const byChat = resolver.resolve(canonical.model, 'chat');
    if (byChat !== undefined) {
      resolved = byChat.target.model;
      target = { provider: byChat.target.provider, access_path: byChat.target.access_path };
    } else if (resolver.listNamespaces !== undefined) {
      for (const ns of resolver.listNamespaces()) {
        if (!ns.enabled || ns.provider !== handler.provider) continue;
        const prefix = `${ns.namespace}/`;
        if (canonical.model.startsWith(prefix) && canonical.model.length > prefix.length) {
          resolved = canonical.model.slice(prefix.length);
          break;
        }
      }
    }
  }

  const nextCanonical =
    resolved === undefined || resolved === canonical.model
      ? canonical
      : { ...canonical, resolved_model: resolved };
  return { canonical: nextCanonical, ...(target === undefined ? {} : { target }) };
}

export { MAX_BODY_BYTES };
