/**
 * http/chat-image-bridge.ts —— OpenAI Chat Completions → 上游 Images API 桥接。
 *
 * 当下游客户端向 `POST /v1/chat/completions` 发送请求、且目标模型在网关目录中
 * 明确为生图模型（`modality === 'image'` 且非对话模型）时，本桥接层：
 *   1. 从 `messages` 提取提示词（最后一条 `user` 消息文本，若有 `system` 则前置）；
 *   2. 组装 canonical `CanonicalRequestEnvelope{ kind: "image" }`，复用现有
 *      `ImageProviderAdaptor`（同时支持 OpenAI Images 与 Gemini Images 上游）；
 *   3. 将上游返回的图片包装为标准 OpenAI Chat Completion 响应（支持非流式 JSON
 *      与 `stream: true` SSE），正文包含 Markdown 图片，并附带 `choices[0].message.images`；
 *   4. 旁路落一条 `UsageRecord`（不漏计费）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CapabilityEntry,
  FormatId,
  ImagePayload,
  MediaRef,
  ModalityKind,
} from '../ir/index.js';
import { IR_VERSION, defaultStreamOptions } from '../ir/index.js';
import { asImageResponsePayload } from '../ir/guards.js';
import type { Clock, IdGenerator } from '../di/index.js';
import { createUsageRecord, type UsageEmitter } from '../metering/index.js';
import type { ImageAdaptorOptions, ImageProviderAdaptor } from './images-endpoint.js';

export interface ChatImageBridgeDeps {
  imagesAdaptor: ImageProviderAdaptor;
  resolveTarget: (accessPath: string) => ImageAdaptorOptions;
  aliasResolver?: {
    resolve(
      model: string,
      modality: ModalityKind,
    ):
      | { source: string; target: { provider: string; access_path: string; model: string } }
      | undefined;
  };
  listCapabilities?: () => readonly CapabilityEntry[];
  usageEmitter: UsageEmitter;
  clock: Clock;
  ids: IdGenerator;
  /** 动态开关（对应系统设置 `cross_modality_bridge`，缺省开启）。 */
  enabled?: () => boolean;
}

export interface ChatImageBridge {
  /**
   * 检查是否为指向生图模型的 `/v1/chat/completions` 请求。
   * 返回 `false` 表示不拦截，交回正常 chat pipeline。
   */
  tryHandle(
    req: IncomingMessage,
    res: ServerResponse,
    rawBody: Buffer,
    keyId?: string,
  ): Promise<boolean>;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    const rec = asRecord(item);
    if (rec?.['type'] === 'text' && typeof rec['text'] === 'string') {
      const t = rec['text'].trim();
      if (t !== '') parts.push(t);
    }
  }
  return parts.join('\n');
}

/** 从 OpenAI Chat `messages[]` 提取生图提示词。 */
export function extractPromptFromChatMessages(messages: readonly unknown[]): string {
  let systemText = '';
  let lastUserText = '';
  for (const msg of messages) {
    const rec = asRecord(msg);
    if (rec === undefined) continue;
    const role = rec['role'];
    const text = extractMessageText(rec['content']);
    if (text === '') continue;
    if ((role === 'system' || role === 'developer') && systemText === '') {
      systemText = text;
    } else if (role === 'user') {
      lastUserText = text;
    }
  }
  if (lastUserText === '') return systemText;
  return systemText === '' ? lastUserText : `${systemText}\n\n${lastUserText}`;
}

function parsePixelSize(raw: unknown): { width: number; height: number } | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (m === null) return undefined;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

function mediaRefToUrl(ref: MediaRef): string | undefined {
  if (ref.kind === 'uri') return ref.uri;
  if (ref.kind === 'inline') return `data:${ref.mime || 'image/png'};base64,${ref.data}`;
  return undefined;
}

/** 将 canonical Image 响应格式化为 OpenAI Chat Completion 非流式响应体。 */
export function formatImagesAsChatCompletion(
  res: CanonicalResponseEnvelope,
  model: string,
  completionId: string,
  createdSec: number,
): Record<string, unknown> {
  const payload = asImageResponsePayload(res);
  const urls: string[] = [];
  const revised: string[] = [];
  for (const item of payload?.images ?? []) {
    const u = mediaRefToUrl(item.image);
    if (u !== undefined) urls.push(u);
    if (item.revised_prompt !== undefined && item.revised_prompt !== '') {
      revised.push(item.revised_prompt);
    }
  }

  const markdown =
    urls.length > 0
      ? urls.map((u, idx) => `![image_${idx + 1}](${u})`).join('\n\n')
      : revised.join('\n\n');
  const images = urls.map((url) => ({ type: 'image_url', image_url: { url } }));
  const tokens = res.usage.units.tokens;

  return {
    id: completionId,
    object: 'chat.completion',
    created: createdSec,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: markdown,
          ...(images.length > 0 ? { images } : {}),
        },
        finish_reason: 'stop',
      },
    ],
    ...(tokens === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: tokens.input_tokens,
            completion_tokens: tokens.output_tokens,
            total_tokens: tokens.total_tokens,
          },
        }),
  };
}

/** 将 canonical Image 响应格式化为 OpenAI Chat Completion SSE 文本。 */
export function formatImagesAsChatStreamSse(
  res: CanonicalResponseEnvelope,
  model: string,
  completionId: string,
  createdSec: number,
): string {
  const full = formatImagesAsChatCompletion(res, model, completionId, createdSec);
  const firstChoice = (full['choices'] as Array<{ message: Record<string, unknown> }>)[0]!;
  const content = String(firstChoice.message['content'] ?? '');
  const images = firstChoice.message['images'];

  const chunk1 = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: createdSec,
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content,
          ...(images === undefined ? {} : { images }),
        },
        finish_reason: null,
      },
    ],
  };
  const chunk2 = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: createdSec,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ...(full['usage'] === undefined ? {} : { usage: full['usage'] }),
  };

  return `data: ${JSON.stringify(chunk1)}\n\ndata: ${JSON.stringify(chunk2)}\n\ndata: [DONE]\n\n`;
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

const VALID_QUALITIES = new Set(['low', 'medium', 'high', 'hd', 'standard', 'auto']);

export function createChatImageBridge(deps: ChatImageBridgeDeps): ChatImageBridge {
  function resolveImageTarget(
    model: string,
  ): { provider: string; access_path: string; model: string } | undefined {
    // 1. 先检查是否为 chat 模态（若同时支持 chat 则走正常 chat pipeline，不劫持）
    if (deps.aliasResolver?.resolve(model, 'chat') !== undefined) {
      return undefined;
    }
    const viaAlias = deps.aliasResolver?.resolve(model, 'image');
    if (viaAlias !== undefined) {
      return viaAlias.target;
    }
    const caps = deps.listCapabilities?.() ?? [];
    if (caps.some((c) => c.model === model && c.modality === 'chat')) {
      return undefined;
    }
    const imgCap = caps.find((c) => c.model === model && c.modality === 'image');
    if (imgCap !== undefined) {
      return {
        provider: imgCap.access_path.split('.')[0] ?? imgCap.access_path,
        access_path: imgCap.access_path,
        model: imgCap.model,
      };
    }
    return undefined;
  }

  return {
    async tryHandle(_req, res, rawBody, keyId = 'anonymous'): Promise<boolean> {
      if (deps.enabled !== undefined && !deps.enabled()) {
        return false;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        return false;
      }
      const body = asRecord(parsed);
      if (body === undefined) return false;
      const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
      if (model === '' || !Array.isArray(body['messages'])) return false;

      const target = resolveImageTarget(model);
      if (target === undefined) return false;

      const prompt = extractPromptFromChatMessages(body['messages']);
      if (prompt === '') {
        sendJson(res, 400, {
          error: {
            message: '生图桥接需要至少一条非空文本消息作为 prompt',
            type: 'invalid_request_error',
            code: 'invalid_request',
          },
        });
        return true;
      }

      const started = deps.clock.now();
      const size = parsePixelSize(body['size']);
      const aspectRatio =
        typeof body['aspect_ratio'] === 'string' && body['aspect_ratio'].trim() !== ''
          ? body['aspect_ratio'].trim()
          : undefined;
      const n =
        typeof body['n'] === 'number' && Number.isInteger(body['n']) && body['n'] >= 1
          ? Math.min(body['n'], 10)
          : undefined;
      const rawQuality = typeof body['quality'] === 'string' ? body['quality'] : undefined;
      const quality =
        rawQuality !== undefined && VALID_QUALITIES.has(rawQuality)
          ? (rawQuality as ImagePayload['quality'])
          : undefined;
      const stream = body['stream'] === true;

      const payload: ImagePayload = {
        prompt,
        ...(size === undefined ? {} : { size }),
        ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
        ...(n === undefined ? {} : { n }),
        ...(quality === undefined ? {} : { quality }),
        output: {
          format: 'png',
          response_type: 'b64_json',
        },
        raw: {},
      };

      const canonical: CanonicalRequestEnvelope = {
        ir_version: IR_VERSION,
        kind: 'image',
        model,
        resolved_model: target.model,
        source_format: 'openai.chat',
        stream: defaultStreamOptions('image', false),
        payload,
        raw: {},
      };

      try {
        const opts = deps.resolveTarget(target.access_path);
        const outcome = await deps.imagesAdaptor.generate(canonical, {
          ...opts,
          requestId: deps.ids.requestId(),
        });
        const now = deps.clock.now();
        const createdSec = Math.floor(now / 1000);
        const completionId = `chatcmpl-img-${deps.ids.requestId()}`;

        deps.usageEmitter.emit(
          createUsageRecord({
            request_id: deps.ids.requestId(),
            ts: now,
            auth: { key_id: keyId },
            client_format: 'openai.chat' as FormatId,
            provider: target.provider,
            provider_format: 'openai.images.generations' as FormatId,
            model: target.model,
            ...(target.model !== model ? { model_alias: model } : {}),
            access_path: target.access_path,
            fast_path: false,
            attempts: 1,
            stream,
            ttfb_ms: now - started,
            total_ms: now - started,
            status: 'success',
            usage: outcome.response.usage,
            finish_reason: 'stop',
            warnings: ['bridge:openai.chat->images.generations', ...outcome.response.warnings],
          }),
        );

        if (stream) {
          const sse = formatImagesAsChatStreamSse(outcome.response, model, completionId, createdSec);
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.end(sse);
        } else {
          sendJson(
            res,
            200,
            formatImagesAsChatCompletion(outcome.response, model, completionId, createdSec),
          );
        }
        return true;
      } catch (err) {
        const now = deps.clock.now();
        const status =
          err instanceof Error && typeof (err as Error & { status?: unknown }).status === 'number'
            ? (err as Error & { status: number }).status
            : 502;
        const message = err instanceof Error ? err.message : '上游生图失败';
        deps.usageEmitter.emit(
          createUsageRecord({
            request_id: deps.ids.requestId(),
            ts: now,
            auth: { key_id: keyId },
            client_format: 'openai.chat' as FormatId,
            provider: target.provider,
            provider_format: 'openai.images.generations' as FormatId,
            model: target.model,
            ...(target.model !== model ? { model_alias: model } : {}),
            access_path: target.access_path,
            fast_path: false,
            attempts: 1,
            stream,
            ttfb_ms: 0,
            total_ms: now - started,
            status: 'error',
            error_code: 'upstream_error',
            finish_reason: 'error',
            warnings: ['bridge:openai.chat->images.generations'],
          }),
        );
        sendJson(res, status >= 400 && status < 600 ? status : 502, {
          error: { message, type: 'upstream_error', code: 'upstream_error' },
        });
        return true;
      }
    },
  };
}
