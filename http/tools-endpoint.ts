/**
 * http/tools-endpoint.ts —— 独立工具端点（DeepSeek 全家桶）的数据面 HTTP 装配。
 *
 * ## 与推理路由的关系
 *
 * 这五个端点**不进出 pipeline**（S0–S10 一条阶段都不跑）：它们不是"帮我调一次模型"，
 * 而是"帮我做一次搜索/抓取/识别/合成"。把它们塞进 `ROUTES`（POST + 客户端格式）会
 * 让那张表的假设多出五个例外。做法与 `/v1/models` 相同——注入一个端口，
 * server.ts 只负责"路径匹配 → 调端口 → 写响应"。
 *
 * ## 鉴权（66 §1：两个认证平面不要混）
 *
 * 走**数据面**鉴权（`DataPlaneAuthenticator`，与 S0 同一个实例、同一套语义）：
 * 这些端点花的是上游的真钱（按次/按页/按秒/按字符计费），必须知道是谁调的。
 * 管理面会话令牌在这里**不接受**——反过来也不行（控制面端点不接受数据面 key）。
 *
 * ## 计量
 *
 * 每次调用（成功与失败都记）落一条 `UsageRecord`：
 *   - `access_path` = `deepseek.tools.<端点>`（与 S10 的口径一致）；
 *   - `usage.units` 用端点自己的单位（requests / audio_seconds / characters）；
 *   - `cost` 缺省 = unpriced（未接定价表，**不是免费**）——价格查表在
 *     metering/pricing.ts，与 chat 同一条路，本文件不算钱。
 *
 * ## 与 http/audio-endpoint.ts 的共用面
 *
 * `/v1/audio/speech` 与 `/v1/audio/transcriptions` 打的是**同一批上游**（tts / asr），
 * 所以鉴权头脱敏（`sanitizeAuthHeaders`）、错误分类（`classifyToolError`）、用量记录
 * （`emitToolUsageRecord`）三个 helper 从这里导出给那边用：同一上游、同一套错误码与
 * 计量口径，不各写一份——否则"同一个上游故障在两张脸上是两个 code"没法对账。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CanonicalToolRequest,
  CanonicalToolResponse,
  CanonicalUsage,
  FormatId,
  ToolEndpointId,
} from '../ir/index.js';
import type { UsageRecord } from '../metering/index.js';
import { createUsageRecord } from '../metering/usage-record.js';
import type { UsageEmitter } from '../metering/emitter.js';
import type { Clock, IdGenerator } from '../di/ports.js';
import type { PricingService, PriceSnapshot, UsageCost } from '../metering/pricing.js';
import type { BillingMode } from '../credentials/resolver.js';

/** 一个独立工具端点的装配契约（http 层只认这个形状）。 */
export interface ToolEndpointHandler {
  readonly id: ToolEndpointId;
  /** 网关路由路径（数据面）。 */
  readonly path: string;
  /** 归属 provider（计量用）。 */
  readonly provider: string;
  /** 计量记录里的 access path（S10 的同款口径，如 `deepseek.tools.search`）。 */
  readonly access_path: string;
  /** 计费路径判据要查的 access path（缺省 = `access_path`）。 */
  readonly billing_access_path?: string;
  /** 客户端 JSON → canonical 请求。请求不合法时抛 `ToolRequestError`（http 层映射成 400）。 */
  decodeRequest(body: unknown): CanonicalToolRequest;
  /** 跑上游，返回 canonical 响应。非 2xx 抛带 numeric `status` 的上游 Error（http 层分类）。 */
  run(req: CanonicalToolRequest): Promise<CanonicalToolResponse>;
  /** canonical 响应 → 客户端 JSON。 */
  encodeResponse(res: CanonicalToolResponse): unknown;
}

/** 请求体不合法（http 层 → 400 + 一句话）。 */
export class ToolRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRequestError';
  }
}

/** 请求体大小上限（OCR/ASR 的 base64 音频可以很大；chat 的 256KB 不够）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ToolEndpoints {
  /** 处理一个 `/v1/tools/*` 请求；返回 true = 已处理。 */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    readBody: () => Promise<Buffer | undefined>,
  ): Promise<boolean>;
  /** 已登记的端点清单（健康检查 / 文档用）。 */
  list(): Array<{ id: string; path: string; provider: string; access_path: string }>;
}

export interface ToolEndpointsDeps {
  handlers: ToolEndpointHandler[];
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
  /**
   * 定价服务（可缺省）：给工具/音频调用算 cost。
   *
   * 这些端点**不走 S0–S10**，所以自己算——不接就记 `unpriced`（Phase 1 历史行为），
   * 而不是假装免费。接上之后 TTS/ASR 的用量记录与 chat 同口径：
   * `cost.status === 'priced'`（仓库主人「接入的每个模型都不能是 unpriced」）。
   */
  pricingService?: PricingService;
  /**
   * 计费路径判据（可缺省）：按 access path 问出订阅/按量，决定 cash 口径。
   *
   * 订阅路径（MiMo Token Plan，key 前缀 `tp-`）cash 恒 0、as_api 照算；按量路径
   * 两者都照算。判据是 key 前缀（官方明文），实现见 credentials/resolver.ts。
   * 不传 = 分不清，按非订阅处理（照算 cash，保守方向）。
   */
  billingModeFor?: (accessPath: string) => BillingMode | undefined;
  log?: (message: string) => void;
}

export function createToolEndpoints(deps: ToolEndpointsDeps): ToolEndpoints {
  const byPath = new Map(deps.handlers.map((h) => [h.path, h]));

  return {
    list() {
      return deps.handlers.map((h) => ({
        id: h.id,
        path: h.path,
        provider: h.provider,
        access_path: h.access_path,
      }));
    },

    async handle(req, res, url, readBody) {
      const handler = byPath.get(url.pathname);
      if (handler === undefined) return false;
      const started = deps.clock.now();

      if (req.method !== 'POST') {
        sendJson(res, 405, {
          error: { code: 'method_not_allowed', message: '只支持 POST' },
        });
        return true;
      }

      // ---- 鉴权（数据面；与 S0 同一实例同一语义）----
      const rawBody = (await readBody()) ?? Buffer.alloc(0);
      const auth = await deps.authenticator.authenticate({
        headers: sanitizeAuthHeaders(req.headers),
        query: Object.fromEntries(url.searchParams.entries()),
        path: url.pathname,
        raw_body: rawBody,
      });
      if (!auth.ok) {
        // 不回显调用方给的串（那把串可能就是 key）——auth 的错误信息本来就只说原因
        emitToolUsageRecord(
          deps,
          {
            provider: handler.provider,
            access_path: handler.access_path,
            provider_format: handler.access_path,
            client_format: 'openai.chat',
            model: handler.id,
            ...(handler.billing_access_path === undefined
              ? {}
              : { billing_access_path: handler.billing_access_path }),
            warning_tag: `tool_endpoint:${handler.id}`,
          },
          started,
          'anonymous',
          'error',
          'auth_failed',
        );
        sendJson(res, 401, { error: { code: 'unauthorized', message: auth.error.message } });
        return true;
      }

      // ---- 解析请求体 ----
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, {
          error: { code: 'invalid_json', message: '请求体不是合法 JSON' },
        });
        return true;
      }

      let canonical;
      try {
        canonical = handler.decodeRequest(parsed);
      } catch (err) {
        const message = err instanceof ToolRequestError ? err.message : '请求体不合法';
        sendJson(res, 400, { error: { code: 'invalid_request', message } });
        return true;
      }

      // ---- 打上游 ----
      let response: CanonicalToolResponse;
      try {
        response = await handler.run(canonical);
      } catch (err) {
        const { status, code, message } = classifyToolError(err);
        emitToolUsageRecord(
          deps,
          {
            provider: handler.provider,
            access_path: handler.access_path,
            provider_format: handler.access_path,
            client_format: 'openai.chat',
            model: handler.id,
            ...(handler.billing_access_path === undefined
              ? {}
              : { billing_access_path: handler.billing_access_path }),
            warning_tag: `tool_endpoint:${handler.id}`,
          },
          started,
          auth.key_id,
          'error',
          code,
        );
        sendJson(res, status, { error: { code, message } });
        return true;
      }

      emitToolUsageRecord(
        deps,
        {
          provider: handler.provider,
          access_path: handler.access_path,
          provider_format: handler.access_path,
          client_format: 'openai.chat',
          model: handler.id,
          ...(handler.billing_access_path === undefined
            ? {}
            : { billing_access_path: handler.billing_access_path }),
          warning_tag: `tool_endpoint:${handler.id}`,
        },
        started,
        auth.key_id,
        'success',
        undefined,
        response.usage,
      );
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
 * **失败也记**：按次计费的端点失败了照样可能产生上游成本（429 之前的调用、
 * 已传输的字节），而"只看成功记录"会让成本报表系统性偏低。
 * `cost` 缺省 = unpriced（未接定价表），与 chat 的 Phase 1 行为一致。
 *
 * 由 `http/audio-endpoint.ts`（OpenAI 音频入站脸）共用：两个入口打的是同一个上游
 * access path、同一套计量口径，只是客户端格式不同。共用而不是各写一份，是为了
 * "同一次上游调用在两张表里记成两个样子"这种事不可能发生。
 */
export function emitToolUsageRecord(
  deps: Pick<
    ToolEndpointsDeps,
    'usageEmitter' | 'clock' | 'ids' | 'pricingService' | 'billingModeFor'
  >,
  meta: ToolUsageMeta,
  started: number,
  keyId: string,
  status: 'success' | 'error',
  errorCode: string | undefined,
  usage?: CanonicalUsage,
): void {
  const now = deps.clock.now();
  // ---- 定价（与 S10 同口径，但这里没有 RequestContext：只有 model + usage）----
  // 订阅/按量由 access path 问凭据层（key 前缀判据）；分不清时不传 subscription。
  const priced =
    deps.pricingService === undefined || usage === undefined
      ? undefined
      : deps.pricingService.price({
          ts: started,
          model: meta.model,
          usage,
          provider: meta.provider,
          access_path: meta.access_path,
          ...(deps.billingModeFor?.(meta.billing_access_path ?? meta.access_path) === 'subscription'
            ? { subscription: true }
            : {}),
        });
  const record: UsageRecord = createUsageRecord({
    request_id: deps.ids.requestId(),
    ts: now,
    auth: { key_id: keyId },
    client_format: meta.client_format,
    provider: meta.provider,
    provider_format: meta.provider_format as UsageRecord['provider_format'],
    model: meta.model,
    ...(meta.model_alias === undefined ? {} : { model_alias: meta.model_alias }),
    access_path: meta.access_path,
    fast_path: false,
    attempts: 1,
    stream: false,
    ttfb_ms: 0,
    total_ms: now - started,
    status,
    ...(errorCode === undefined ? {} : { error_code: errorCode as UsageRecord['error_code'] }),
    ...((priced?.estimated_usage ?? usage === undefined)
      ? {}
      : { usage: priced?.estimated_usage ?? usage }),
    ...(priced === undefined
      ? {}
      : {
          cost: priced.cost,
          ...(priced.price_snapshot === null
            ? { price_snapshot: null }
            : { price_snapshot: priced.price_snapshot as PriceSnapshot }),
          ...(priced.estimate_method === undefined
            ? {}
            : { estimate_method: priced.estimate_method }),
        }),
    finish_reason: status === 'success' ? 'stop' : 'error',
    warnings: [meta.warning_tag],
  });
  deps.usageEmitter.emit(record);
}

/** 计费结果的窄投影（测试与调用方断言用，不必 import 整个 PricingResult）。 */
export interface ToolUsagePricing {
  cost: UsageCost;
  price_snapshot: PriceSnapshot | null;
}

/** 计量记录的来源描述（canonical 工具端点与 OpenAI 音频脸共用）。 */
export interface ToolUsageMeta {
  provider: string;
  /** 计量记录里的 access path（S10 的同款口径，如 `deepseek.tools.tts`）。 */
  access_path: string;
  /** 与 access_path 同值：说不出来源的字符串没人要。 */
  provider_format: string;
  client_format: FormatId;
  /** provider 侧真实 model id。 */
  model: string;
  /** 客户端传的模型名（与 model 不同时才记）。 */
  model_alias?: string;
  /**
   * 计费路径判据要查的 access path（缺省 = `access_path`）。
   *
   * 工具端点的 access path（`mimo.tools.tts` / `deepseek.tools.asr`）**不在凭据启动表
   * 里**——它们与 chat 端点共用同一把 key、同一个账号，凭据登记在
   * `<provider>.openai-chat` 上。订阅/按量是**凭据的属性**（key 前缀），所以判据要去
   * 有凭据的那条 path 上问；不问就会永远按非订阅处理，订阅用量被记成现金支出。
   */
  billing_access_path?: string;
  /** warnings 里的端点标识（如 `tool_endpoint:tts` / `audio_endpoint:speech`）。 */
  warning_tag: string;
}

// ---------------------------------------------------------------------------
// 错误分类（与 admin 的 provider-models 同一套思路：一句话 + 一个 code）
// ---------------------------------------------------------------------------

/**
 * 上游/请求/网络错误 → (status, code, message)。
 *
 * 导出给 `http/audio-endpoint.ts` 共用：两个入口打同一个上游，错误分类必须同一套，
 * 否则"同一个上游故障在两张脸上是两个 code"没法对账。
 *
 * 多个上游的错误载体（`DeepSeekApiError` / `MiMoAudioError`）都收敛成
 * `(status, body)` 再走同一张 switch——新增上游只加一个 instanceof 分支，
 * 不需要复制这张表。
 */
export function classifyToolError(err: unknown): { status: number; code: string; message: string } {
  const upstream = upstreamErrorOf(err);
  if (upstream !== undefined) {
    switch (upstream.status) {
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
        return {
          status: 502,
          code: 'upstream_error',
          message: `上游返回 HTTP ${upstream.status}`,
        };
    }
  }
  if (err instanceof ToolRequestError || (err instanceof Error && err.name === 'ToolRequestError')) {
    return { status: 400, code: 'invalid_request', message: err.message };
  }
  // 网络层失败：不带 err.message（可能含内网地址 / 完整 URL）
  return { status: 502, code: 'network_error', message: '网关到上游不通' };
}

/** 各上游错误载体 → (status, body)。认不出返回 undefined（交给下一级分类）。 */
function upstreamErrorOf(err: unknown): { status: number; body?: unknown } | undefined {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      return { status, body: (err as { body?: unknown }).body };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 只留鉴权相关的头（其余不进鉴权器，也不进任何记录）。 */
export function sanitizeAuthHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['authorization', 'x-api-key']) {
    const v = headers[key];
    if (typeof v === 'string') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.join(', ');
  }
  return out;
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

export { MAX_BODY_BYTES };
