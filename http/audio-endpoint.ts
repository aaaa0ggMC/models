/**
 * http/audio-endpoint.ts —— `/v1/audio/*` 的 **OpenAI 兼容入站脸**（数据面 HTTP 装配）。
 *
 * ## 与 `/v1/tools/*` 的关系（同一批上游，两张客户端脸）
 *
 * | 客户端形状 | 路径 | 请求体 | 响应体 |
 * | --- | --- | --- | --- |
 * | canonical | `POST /v1/tools/{tts,asr}`（DeepSeek）<br>`POST /v1/tools/mimo/{tts,asr}`（MiMo） | JSON（voice_id / format） | JSON（audio_base64 / text） |
 * | **OpenAI** | `POST /v1/audio/speech` | JSON（voice / response_format） | **音频二进制** |
 * | canonical | `POST /v1/tools/asr` | JSON（audio.data_base64） | JSON（text） |
 * | **OpenAI** | `POST /v1/audio/transcriptions` | **multipart/form-data** | JSON / 纯文本 |
 *
 * 两张脸**共用同一个上游调用路径**（`ToolEndpointHandler.run`）与同一套计量口径，
 * 差别只在客户端 dialect 的编解码——那部分在各 provider 的
 * `providers/<provider>/audio-openai-face.ts`，上游字段名不出那些文件。
 *
 * ## 多上游（2026-11 随 MiMo 接入）
 *
 * 本文件原本只服务 DeepSeek 一家：模型解析、voice 映射、错误文案全写死。接第二家时
 * 把「一家上游的全部差异」收进 `AudioProviderFace`（http/audio-faces.ts），本文件按
 * `providers` 数组顺序问一遍，**第一家认领的赢**。DeepSeek 在前、MiMo 在后（组合根决定）；
 * 两家模型名不重叠，顺序只影响错误信息里先列谁。
 *
 * ## 鉴权与计量
 *
 * 与 `http/tools-endpoint.ts` 完全同款：数据面鉴权（`DataPlaneAuthenticator`，与 S0
 * 同一实例同一语义；未登录/无效虚拟 key → 401，管理面令牌在这里不接受），每次调用
 * （成功与失败都记）落一条 UsageRecord，`client_format` 记客户端实际用的形状
 * （`openai.audio.speech` / `openai.audio.transcription`），`provider` / `access_path`
 * 记**实际认领的那一家**（客户端传 `mimo-v2.5-tts` 时记账记在 MiMo 头上）。
 *
 * ## 错误信封
 *
 * OpenAI 风格 `{error:{message, type, code}}`：`message` 短到能塞进一行，
 * `code` 逐类不同（unsupported_response_format / unmapped_voice / missing_file /
 * payload_too_large …），客户端可以按 code 分支而不用解析中文。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CanonicalUsage, FormatId } from '../ir/index.js';
import type { UsageEmitter } from '../metering/emitter.js';
import type { Clock, IdGenerator } from '../di/ports.js';
import type { PricingService } from '../metering/pricing.js';
import type { BillingMode } from '../credentials/resolver.js';
import { ToolRequestError } from './tools-endpoint.js';
import {
  AUDIO_CLIENT_FORMATS,
  AudioModelError,
  type AudioEndpointId,
  type AudioEndpointProvider,
  type AudioModelTarget,
  type CanonicalSpeechBody,
  type OpenAiTranscriptionFormat,
} from './audio-faces.js';
import {
  DEFAULT_MULTIPART_LIMITS,
  MultipartError,
  optionalField,
  parseMultipartFormData,
  requireFile,
} from './multipart.js';
import {
  classifyToolError,
  emitToolUsageRecord,
  sanitizeAuthHeaders,
  type ToolUsageMeta,
} from './tools-endpoint.js';

/** `/v1/audio/*` 前缀（server.ts 只认这个常量做路径分发）。 */
export const AUDIO_PATH_PREFIX = '/v1/audio/';

/**
 * 单文件上传上限（32 MiB，与 tools/modality 端点对齐；超过上游单次上限的部分由 adaptor 自动切片）。
 */
export const MAX_AUDIO_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * 请求体上限 = 文件上限 + multipart 包装与其余字段的余量。
 *
 * 余量 64 KiB 是粗算：边界串 ~80 字节 + 每个分片两头 ~200 字节 × 16 个分片
 * （DEFAULT_MULTIPART_LIMITS.max_parts）+ 文本字段 256 KiB 上限。文件本体的超额在
 * multipart 解析器里按 `max_file_bytes` 再拦一次（两层，见下）。
 */
export const MAX_AUDIO_BODY_BYTES = MAX_AUDIO_UPLOAD_BYTES + 64 * 1024;

/** 三个路由（translations 明确不支持，见 handle 里的 501 分支）。 */
const SPEECH_PATH = '/v1/audio/speech';
const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';
const TRANSLATIONS_PATH = '/v1/audio/translations';

type AudioRouteId = 'speech' | 'transcriptions' | 'translations';

/** 路由 → 上游端点（translations 从不打上游，这里只用于计量归属）。 */
const ROUTE_ENDPOINT: Record<AudioRouteId, AudioEndpointId> = {
  speech: 'tts',
  transcriptions: 'asr',
  translations: 'asr',
};

export interface AudioEndpoints {
  /** 处理一个 `/v1/audio/*` 请求；返回 true = 已处理（含 404 之外的拒绝）。 */
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    readBody: () => Promise<Buffer | undefined>,
  ): Promise<boolean>;
  /** 已登记的路由清单（健康检查 / 文档用；`supported:false` = 明确不支持）。 */
  list(): Array<{
    id: string;
    path: string;
    provider: string;
    access_path: string;
    supported: boolean;
  }>;
}

export interface AudioEndpointsDeps {
  /**
   * 已装配的上游（顺序即认领顺序；组合根默认 DeepSeek 在前、MiMo 在后）。
   *
   * 每条带自己的 face（dialect 映射）与 handlers（canonical 工具面上游调用）。
   */
  providers: readonly AudioEndpointProvider[];
  /** 模型解析依赖（管理面别名解析器可选；能力矩阵是唯一事实来源）。 */
  aliasResolver?: AudioModelResolverDeps['aliasResolver'];
  capabilities: AudioModelResolverDeps['capabilities'];
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
   * 定价服务（可缺省）：给 TTS/ASR 调用算 cost。
   *
   * 与 `http/tools-endpoint.ts` 同款立场：这两个端点不走 S0–S10，所以自己算；
   * 不接就记 `unpriced`，不假装免费。接上之后 MiMo 的 TTS（按字符）与 ASR
   * （按音频秒）用量记录与 chat 同口径 `priced`。
   */
  pricingService?: PricingService;
  /**
   * 计费路径判据（可缺省）：按 access path 问出订阅/按量，决定 cash 口径。
   * Token Plan（`tp-`）= 订阅 → cash 恒 0、as_api 照算；按量（`sk-`）两者都照算。
   */
  billingModeFor?: (accessPath: string) => BillingMode | undefined;
  log?: (message: string) => void;
}

// `AudioModelResolverDeps` 与 `AudioEndpointProvider` 从 audio-faces.ts 再出口，
// 让组合根与测试只 import 本文件就能拿到全部音频端点装配类型。
export type {
  AudioEndpointProvider,
  AudioProviderFace,
  AudioModelTarget,
  AudioModelResolverDeps,
  CanonicalSpeechBody,
  OpenAiTranscriptionFormat,
  AudioEndpointId,
} from './audio-faces.js';
import type { AudioModelResolverDeps } from './audio-faces.js';

export function createAudioEndpoints(deps: AudioEndpointsDeps): AudioEndpoints {
  return {
    list() {
      const rows: Array<{
        id: string;
        path: string;
        provider: string;
        access_path: string;
        supported: boolean;
      }> = [];
      for (const route of ['speech', 'transcriptions', 'translations'] as const) {
        for (const provider of deps.providers) {
          rows.push({
            id: route,
            path:
              route === 'speech'
                ? SPEECH_PATH
                : route === 'transcriptions'
                  ? TRANSCRIPTIONS_PATH
                  : TRANSLATIONS_PATH,
            provider: provider.face.provider,
            access_path: provider.face.accessPath(ROUTE_ENDPOINT[route]),
            // 明确不支持：两家的 ASR 都没有翻译目标参数（只做同语言转写）
            supported: route !== 'translations',
          });
        }
      }
      return rows;
    },

    async handle(req, res, url, readBody) {
      const route = routeFor(url.pathname);
      if (route === undefined) return false;
      const endpoint = ROUTE_ENDPOINT[route];
      const started = deps.clock.now();

      if (req.method !== 'POST') {
        emit(deps, {
          endpoint,
          started,
          keyId: 'anonymous',
          status: 'error',
          errorCode: 'method_not_allowed',
        });
        sendError(res, 405, 'invalid_request_error', 'method_not_allowed', '只支持 POST');
        return true;
      }

      // ---- 鉴权（数据面；与 /v1/tools/* 同一实例同一语义）----
      // 体过大时先用空 Buffer 过鉴权：未登录的调用方拿到的仍是 401（而不是 413），
      // 413 只告诉"已经认证过、但体太大"的调用方。
      const rawBody = await readBody();
      const tooLarge = rawBody === undefined;
      const body = rawBody ?? Buffer.alloc(0);
      const auth = await deps.authenticator.authenticate({
        headers: sanitizeAuthHeaders(req.headers),
        query: Object.fromEntries(url.searchParams.entries()),
        path: url.pathname,
        raw_body: body,
      });
      if (!auth.ok) {
        emit(deps, {
          endpoint,
          started,
          keyId: 'anonymous',
          status: 'error',
          errorCode: 'auth_failed',
        });
        sendError(res, 401, 'authentication_error', 'unauthorized', auth.error.message);
        return true;
      }

      // ---- 体过大 → 413（不打上游、不攒内存）----
      if (tooLarge) {
        emit(deps, {
          endpoint,
          started,
          keyId: auth.key_id,
          status: 'error',
          errorCode: 'payload_too_large',
        });
        sendError(
          res,
          413,
          'invalid_request_error',
          'payload_too_large',
          `请求体超过 ${MAX_AUDIO_BODY_BYTES} 字节（音频文件上限 ${MAX_AUDIO_UPLOAD_BYTES} 字节）`,
        );
        return true;
      }

      // ---- translations：明确不支持（不假装支持）----
      if (route === 'translations') {
        const reasons = deps.providers.map((p) => p.face.translationsUnsupportedReason);
        emit(deps, {
          endpoint,
          started,
          keyId: auth.key_id,
          status: 'error',
          errorCode: 'not_implemented',
        });
        sendError(res, 501, 'not_implemented', 'translations_not_supported', reasons.join('；'));
        return true;
      }

      if (route === 'speech') {
        await handleSpeech(req, res, body, auth.key_id, started, deps);
        return true;
      }
      await handleTranscriptions(req, res, body, auth.key_id, started, deps);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// /v1/audio/speech
// ---------------------------------------------------------------------------

async function handleSpeech(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  keyId: string,
  started: number,
  deps: AudioEndpointsDeps,
): Promise<void> {
  const contentType = headerValue(req.headers['content-type']);
  if (contentType !== undefined && !isJson(contentType)) {
    emit(deps, {
      endpoint: 'tts',
      started,
      keyId,
      status: 'error',
      errorCode: 'unsupported_media_type',
    });
    sendError(
      res,
      415,
      'invalid_request_error',
      'unsupported_media_type',
      '/v1/audio/speech 只接受 application/json（音频结果由响应体返回）',
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    emit(deps, { endpoint: 'tts', started, keyId, status: 'error', errorCode: 'invalid_json' });
    sendError(res, 400, 'invalid_request_error', 'invalid_json', '请求体不是合法 JSON');
    return;
  }

  // 非对象体（数组 / 字符串 / 数字）先拒：不然下面的"缺少字段 model"会让人以为
  // 是字段漏了，而实际是整个体的形状不对
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    emit(deps, { endpoint: 'tts', started, keyId, status: 'error', errorCode: 'invalid_request' });
    sendError(res, 400, 'invalid_request_error', 'invalid_request', '请求体必须是 JSON 对象');
    return;
  }

  // ---- 模型解析（按顺序问每一家 face，第一家认领的赢）----
  let target: AudioModelTarget;
  let provider: AudioEndpointProvider;
  const requestedModel = modelNameOf(parsed);
  try {
    const hit = resolveOnFaces(deps, requestedModel, 'tts');
    target = hit.target;
    provider = hit.provider;
  } catch (err) {
    const message = err instanceof AudioModelError ? err.message : '模型解析失败';
    emit(deps, {
      endpoint: 'tts',
      started,
      keyId,
      status: 'error',
      errorCode: 'model_not_found',
      modelAlias: requestedModel,
    });
    sendError(res, 400, 'invalid_request_error', 'model_not_found', message);
    return;
  }

  // ---- 客户端 dialect → canonical ----
  // 把**解析后的**模型名交给 face：便利别名（mimo-tts）在这一步归一成上游 id，
  // 否则 face 的字段规则按客户端传来的别名判断，会把它当"未知模型"拒掉——
  // 而解析那一关已经认过了，两关不一致就会"解析得到但解码不了"。
  let canonicalBody: CanonicalSpeechBody;
  try {
    canonicalBody = provider.face.decodeSpeech(withModel(parsed, target.model));
  } catch (err) {
    const { code, message } = faceError(err, '请求体不合法');
    emit(deps, {
      endpoint: 'tts',
      started,
      keyId,
      status: 'error',
      errorCode: code,
      provider,
      model: target.model,
      modelAlias: requestedModel,
    });
    sendError(res, 400, 'invalid_request_error', code, message);
    return;
  }

  let canonical;
  try {
    canonical = provider.handlers.tts.decodeRequest(canonicalBody);
  } catch (err) {
    const message = err instanceof ToolRequestError ? err.message : '请求体不合法';
    emit(deps, {
      endpoint: 'tts',
      started,
      keyId,
      status: 'error',
      errorCode: 'invalid_request',
      provider,
      model: target.model,
      modelAlias: requestedModel,
    });
    sendError(res, 400, 'invalid_request_error', 'invalid_request', message);
    return;
  }

  let response;
  try {
    response = await provider.handlers.tts.run(canonical);
  } catch (err) {
    const { status, code, message } = classifyToolError(err);
    emit(deps, {
      endpoint: 'tts',
      started,
      keyId,
      status: 'error',
      errorCode: code,
      provider,
      model: target.model,
      modelAlias: requestedModel,
    });
    sendError(res, status, errorTypeFor(status), code, message);
    return;
  }

  const audio = provider.face.encodeSpeech(response, canonicalBody.format);
  emit(deps, {
    endpoint: 'tts',
    started,
    keyId,
    status: 'success',
    provider,
    model: target.model,
    modelAlias: requestedModel,
    usage: response.usage,
  });
  res.writeHead(200, {
    'content-type': audio.content_type,
    'content-length': audio.body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(audio.body);
}

// ---------------------------------------------------------------------------
// /v1/audio/transcriptions
// ---------------------------------------------------------------------------

async function handleTranscriptions(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  keyId: string,
  started: number,
  deps: AudioEndpointsDeps,
): Promise<void> {
  const contentType = headerValue(req.headers['content-type']);
  if (contentType === undefined || !/^\s*multipart\/form-data\s*[;,]/i.test(contentType)) {
    emit(deps, {
      endpoint: 'asr',
      started,
      keyId,
      status: 'error',
      errorCode: 'unsupported_media_type',
    });
    sendError(
      res,
      415,
      'invalid_request_error',
      'unsupported_media_type',
      '/v1/audio/transcriptions 只接受 multipart/form-data（file 字段为音频二进制）',
    );
    return;
  }

  // ---- multipart 解析（自研解析器；限额收紧到上游的 8 MiB）----
  let form;
  try {
    form = parseMultipartFormData(rawBody, contentType, {
      ...DEFAULT_MULTIPART_LIMITS,
      max_file_bytes: MAX_AUDIO_UPLOAD_BYTES,
    });
  } catch (err) {
    const { code, message } = multipartError(err);
    emit(deps, { endpoint: 'asr', started, keyId, status: 'error', errorCode: code });
    sendError(res, 400, 'invalid_request_error', code, message);
    return;
  }

  let file;
  try {
    file = requireFile(form, 'file');
  } catch (err) {
    const { code, message } = multipartError(err);
    emit(deps, { endpoint: 'asr', started, keyId, status: 'error', errorCode: code });
    sendError(res, 400, 'invalid_request_error', code, message);
    return;
  }

  // ---- 模型解析 ----
  let target: AudioModelTarget;
  let provider: AudioEndpointProvider;
  const requestedModel = optionalField(form, 'model') ?? '';
  try {
    const hit = resolveOnFaces(deps, requestedModel, 'asr');
    target = hit.target;
    provider = hit.provider;
  } catch (err) {
    const message = err instanceof AudioModelError ? err.message : '模型解析失败';
    emit(deps, {
      endpoint: 'asr',
      started,
      keyId,
      status: 'error',
      errorCode: 'model_not_found',
      modelAlias: requestedModel,
    });
    sendError(res, 400, 'invalid_request_error', 'model_not_found', message);
    return;
  }

  // ---- 表单字段 → canonical（response_format 先解：它决定响应形状）----
  let responseFormat: OpenAiTranscriptionFormat;
  let extras;
  try {
    responseFormat = provider.face.resolveTranscriptionResponseFormat(
      optionalField(form, 'response_format'),
    );
    extras = provider.face.decodeTranscriptionFields({
      language: optionalField(form, 'language'),
      prompt: optionalField(form, 'prompt'),
      temperature: optionalField(form, 'temperature'),
      timestamp_granularities: optionalField(form, 'timestamp_granularities'),
    });
  } catch (err) {
    const { code, message } = faceError(err, '请求字段不合法');
    emit(deps, {
      endpoint: 'asr',
      started,
      keyId,
      status: 'error',
      errorCode: code,
      provider,
      model: target.model,
      modelAlias: requestedModel,
    });
    sendError(res, 400, 'invalid_request_error', code, message);
    return;
  }

  let canonical;
  try {
    canonical = provider.handlers.asr.decodeRequest({
      audio: {
        filename: file.filename,
        content_type: file.content_type,
        data_base64: file.data.toString('base64'),
      },
      ...extras,
    });
  } catch (err) {
    const message = err instanceof ToolRequestError ? err.message : '请求体不合法';
    emit(deps, {
      endpoint: 'asr',
      started,
      keyId,
      status: 'error',
      errorCode: 'invalid_request',
      provider,
      model: target.model,
      modelAlias: requestedModel,
    });
    sendError(res, 400, 'invalid_request_error', 'invalid_request', message);
    return;
  }

  let response;
  try {
    response = await provider.handlers.asr.run(canonical);
  } catch (err) {
    const { status, code, message } = classifyToolError(err);
    emit(deps, {
      endpoint: 'asr',
      started,
      keyId,
      status: 'error',
      errorCode: code,
      provider,
      model: target.model,
      modelAlias: requestedModel,
    });
    sendError(res, status, errorTypeFor(status), code, message);
    return;
  }

  const encoded = provider.face.encodeTranscription(response, responseFormat);
  emit(deps, {
    endpoint: 'asr',
    started,
    keyId,
    status: 'success',
    provider,
    model: target.model,
    modelAlias: requestedModel,
    usage: response.usage,
  });
  const payload = Buffer.from(encoded.body, 'utf8');
  res.writeHead(200, {
    'content-type': encoded.content_type,
    'content-length': payload.byteLength,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// 模型解析（多上游）
// ---------------------------------------------------------------------------

/**
 * 按顺序问每一家 face。都不认 → 抛 `AudioModelError`（消息里带一份合并的可用清单）。
 *
 * 为什么在 http 层而不是 audio-faces.ts：这里才知道 `deps` 的形状（aliasResolver 由
 * 组合根经 `AudioModelDeps` 注入），而 audio-faces.ts 只定义接口与纯函数。
 */
function resolveOnFaces(
  deps: AudioEndpointsDeps,
  model: string,
  endpoint: AudioEndpointId,
): { provider: AudioEndpointProvider; target: AudioModelTarget } {
  for (const provider of deps.providers) {
    const target = provider.face.resolveModel(modelDeps(deps), model, endpoint);
    if (target !== undefined) return { provider, target };
  }
  // 谁都不要它。先看它是不是**另一端点**上的模型——那种错的错误信息该说
  // "这是 ASR 模型，不能用于语音合成"，而不是一份与本端点无关的可用清单。
  const other: AudioEndpointId = endpoint === 'tts' ? 'asr' : 'tts';
  for (const provider of deps.providers) {
    if (provider.face.modelNames(other).some((m) => m.toLowerCase() === model.toLowerCase())) {
      const label = other === 'asr' ? 'ASR' : 'TTS';
      const here =
        endpoint === 'tts'
          ? '语音合成（/v1/audio/speech）'
          : '语音识别（/v1/audio/transcriptions）';
      throw new AudioModelError(`模型 ${model} 是${label}模型，不能用于${here}`);
    }
  }
  const names = deps.providers.flatMap((p) => p.face.modelNames(endpoint));
  throw new AudioModelError(`模型 ${model} 解析不到：本端点可用 ${names.join(' / ')}`);
}

/** 请求体副本，`model` 换成解析后的 provider 侧 id（其余字段不动）。 */
function withModel(body: unknown, model: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), model };
}

/**
 * 模型解析依赖（**每次现造**：能力矩阵会随 discovery 刷新与管理面登记而变，
 * 缓存一份旧表就会漏掉"新路径 + 新凭据"这个组合——与组合根的
 * providerAvailabilityResolver 同款立场）。
 */
function modelDeps(deps: AudioEndpointsDeps): AudioModelResolverDeps {
  return {
    ...(deps.aliasResolver === undefined ? {} : { aliasResolver: deps.aliasResolver }),
    capabilities: deps.capabilities,
  };
}

// ---------------------------------------------------------------------------
// 计量
// ---------------------------------------------------------------------------

/** emit() 的入参（位置参数超过四个就该换成对象：调用点会看错顺序）。 */
interface EmitArgs {
  endpoint: AudioEndpointId;
  started: number;
  keyId: string;
  status: 'success' | 'error';
  errorCode?: string;
  /** 认领了这次调用的上游（解析前就失败时缺省 = 第一家）。 */
  provider?: AudioEndpointProvider;
  /** 解析后的 provider 侧 model id（解析前就失败时缺省 = 端点自己的模型）。 */
  model?: string;
  /** 客户端传的模型名（与 model 不同时才记）。 */
  modelAlias?: string;
  usage?: CanonicalUsage;
}

/**
 * 落一条用量记录（失败也记，与 /v1/tools/* 同立场）。
 *
 * `model` 用**解析后**的 provider 侧 model id；客户端传了别名时另记 `model_alias`，
 * 这样"客户端打 tts-1、实际打 deepseek-tts"在报表里看得出来。`provider` /
 * `access_path` 用**实际认领的那一家**——多上游下这是"这次调用记在谁头上"的唯一依据。
 *
 * **错误路径也要带 `provider`**（2026-11 live 冒烟抓到的真 bug）：解析成功之后的
 * 400（voice 未映射 / response_format 不支持 …）如果省了 `provider`，就会回落成
 * `deps.providers[0]`（DeepSeek），于是报表里出现"provider=deepseek 而
 * model=mimo-v2.5-tts"这种自相矛盾的记录——对账时完全没法用。只有**解析之前**就失败
 * 的调用（未认证 / 体过大 / 坏模型名）才没有 provider 可记，那时回落是唯一选择。
 */
function emit(deps: AudioEndpointsDeps, args: EmitArgs): void {
  const route = args.endpoint === 'tts' ? 'speech' : 'transcriptions';
  const provider = args.provider ?? deps.providers[0];
  const accessPath = provider?.face.accessPath(args.endpoint) ?? 'unknown';
  const meta: ToolUsageMeta = {
    provider: provider?.face.provider ?? 'unknown',
    access_path: accessPath,
    // 计费判据查有凭据的那条 path（音频 access path 不在凭据启动表里）
    ...(provider?.billingAccessPath === undefined
      ? {}
      : { billing_access_path: provider.billingAccessPath }),
    provider_format: accessPath,
    client_format: AUDIO_CLIENT_FORMATS[args.endpoint] as FormatId,
    model: args.model ?? provider?.face.defaultModel(args.endpoint) ?? 'unknown',
    ...(args.modelAlias === undefined || args.modelAlias === '' || args.modelAlias === args.model
      ? {}
      : { model_alias: args.modelAlias.slice(0, 128) }),
    warning_tag: `audio_endpoint:${route}`,
  };
  emitToolUsageRecord(
    deps,
    meta,
    args.started,
    args.keyId,
    args.status,
    args.errorCode,
    args.usage,
  );
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function routeFor(path: string): AudioRouteId | undefined {
  if (path === SPEECH_PATH) return 'speech';
  if (path === TRANSCRIPTIONS_PATH) return 'transcriptions';
  if (path === TRANSLATIONS_PATH) return 'translations';
  return undefined;
}

function isJson(contentType: string): boolean {
  return /^\s*application\/(json|[a-z.]*\+json)\s*(;|$)/i.test(contentType);
}

/** 从请求体里取 `model`（取不到给空串，由解析器报"缺少字段"）。 */
function modelNameOf(body: unknown): string {
  const rec = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
  const model = (rec as Record<string, unknown>)['model'];
  return typeof model === 'string' ? model.slice(0, 128) : '';
}

/** OpenAI 脸错误 → (code, message)。非本类错误不泄露内部细节。 */
function faceError(err: unknown, fallback: string): { code: string; message: string } {
  if (err instanceof ToolRequestError) return { code: 'invalid_request', message: err.message };
  // 两家的脸错误都带 `code`（OpenAiFaceError）；用结构判而不是 import 两个类，
  // 免得 http 层反向依赖每个 provider 的错误类
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && err instanceof Error) {
    return { code, message: err.message };
  }
  return { code: 'invalid_request', message: fallback };
}

/** multipart 错误 → (code, message)。 */
function multipartError(err: unknown): { code: string; message: string } {
  if (err instanceof MultipartError) return { code: err.code, message: err.message };
  return { code: 'invalid_request', message: 'multipart 请求体不合法' };
}

/** HTTP 状态 → OpenAI 错误 type（SDK 按 type 决定抛哪个错误类）。 */
function errorTypeFor(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

function sendError(
  res: ServerResponse,
  status: number,
  type: string,
  code: string,
  message: string,
): void {
  const payload = JSON.stringify({ error: { message, type, code } });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return undefined;
}
