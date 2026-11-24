/**
 * providers/gemini/images.ts —— Google Gemini 原生图像生成 / 编辑 adaptor。
 *
 * 按官方 Gemini Developer API 规范支持两类图像模型：
 *   1. **Gemini 原生多模态生图模型**（如 `gemini-2.5-flash-image`、`gemini-2.0-flash-preview-image-generation`、
 *      `gemini-3-pro-image-preview`、`gemini-4-*-image` 等）：
 *      - 端点：`POST /v1beta/models/{model}:generateContent`
 *      - 请求：`generationConfig.responseModalities = ["TEXT", "IMAGE"]` + `imageConfig.aspectRatio`
 *      - 编辑（`edit()`）：将原图 / 参考图作为 `inlineData` 与提示词一起放进 `contents[0].parts`
 *      - 响应：从 `candidates[].content.parts` 提取 `inlineData`（`mimeType: image/*`）与文本修订提示
 *   2. **Imagen 系列模型**（如 `imagen-3.0-generate-002`、`imagen-4.0-generate-001` 等）：
 *      - 端点：`POST /v1beta/models/{model}:predict`
 *      - 请求：`{ instances: [{ prompt }], parameters: { sampleCount, aspectRatio? } }`
 *      - 响应：从 `predictions[].bytesBase64Encoded` + `mimeType` 提取图像
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalUsage,
  ImagePayload,
  ImageResponsePayload,
  MediaRef,
  TokenUsage,
} from '../../ir/index.js';
import { IR_VERSION, emptyUsage } from '../../ir/index.js';
import { asImagePayload } from '../../ir/guards.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';
import type {
  ImageAdaptorOptions,
  ImageAdaptorOutcome,
  ImageProviderAdaptor,
} from '../../http/images-endpoint.js';

export const GEMINI_IMAGES_BASE_URL = 'https://generativelanguage.googleapis.com';

export class GeminiImagesApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gemini 图像上游返回 HTTP ${status}`);
    this.name = 'GeminiImagesApiError';
  }
}

export interface GeminiImagesAdaptorDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  provider?: string;
  accessPath?: string;
}

/** 将像素宽高或字符串比例归一成 Gemini 支持的 aspectRatio。 */
export function sizeToGeminiAspectRatio(
  size?: { width: number; height: number },
  aspectRatio?: string,
): string | undefined {
  if (aspectRatio !== undefined && aspectRatio !== '' && aspectRatio !== 'auto') {
    return aspectRatio;
  }
  if (size === undefined || size.width <= 0 || size.height <= 0) return undefined;
  const ratio = size.width / size.height;
  if (Math.abs(ratio - 1) < 0.08) return '1:1';
  if (Math.abs(ratio - 16 / 9) < 0.12) return '16:9';
  if (Math.abs(ratio - 9 / 16) < 0.08) return '9:16';
  if (Math.abs(ratio - 4 / 3) < 0.1) return '4:3';
  if (Math.abs(ratio - 3 / 4) < 0.08) return '3:4';
  if (Math.abs(ratio - 3 / 2) < 0.1) return '3:2';
  if (Math.abs(ratio - 2 / 3) < 0.08) return '2:3';
  return ratio > 1 ? '16:9' : '9:16';
}

export function isImagenModel(model: string): boolean {
  const clean = model.replace(/^models\//, '').replace(/^[^/]+\//, '');
  return /^imagen-/i.test(clean);
}

export class GeminiImagesAdaptor implements ImageProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;

  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;

  constructor(deps: GeminiImagesAdaptorDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? GEMINI_IMAGES_BASE_URL;
    this.provider = deps.provider ?? 'gemini';
    this.access_path = deps.accessPath ?? 'gemini.generateContent';
  }

  async generate(
    req: CanonicalRequestEnvelope,
    opts: ImageAdaptorOptions = {},
  ): Promise<ImageAdaptorOutcome> {
    const payload = asImagePayload(req);
    if (payload === undefined) {
      throw new Error(`GeminiImagesAdaptor 只接 kind:"image"，收到 ${req.kind}`);
    }
    const model = (req.resolved_model ?? req.model).replace(/^models\//, '');
    if (isImagenModel(model)) {
      return this.generateWithImagenPredict(model, payload, opts);
    }
    return this.generateWithGeminiContent(model, payload, opts, false);
  }

  async edit(
    req: CanonicalRequestEnvelope,
    opts: ImageAdaptorOptions = {},
  ): Promise<ImageAdaptorOutcome> {
    const payload = asImagePayload(req);
    if (payload === undefined) {
      throw new Error(`GeminiImagesAdaptor 只接 kind:"image"，收到 ${req.kind}`);
    }
    const model = (req.resolved_model ?? req.model).replace(/^models\//, '');
    return this.generateWithGeminiContent(model, payload, opts, true);
  }

  /** Imagen 系列：`POST /v1beta/models/{model}:predict`。 */
  private async generateWithImagenPredict(
    model: string,
    payload: ImagePayload,
    opts: ImageAdaptorOptions,
  ): Promise<ImageAdaptorOutcome> {
    const aspectRatio = sizeToGeminiAspectRatio(payload.size, payload.aspect_ratio);
    const parameters: Record<string, unknown> = {
      sampleCount: Math.max(1, Math.min(4, payload.n ?? 1)),
      ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    };
    const body = {
      instances: [{ prompt: payload.prompt }],
      parameters,
    };

    const parsed = await this.postJson(
      `/v1beta/models/${encodeURIComponent(model)}:predict`,
      body,
      opts,
    );

    const predictions = Array.isArray(parsed['predictions']) ? parsed['predictions'] : [];
    const images: ImageResponsePayload['images'] = [];
    for (const pred of predictions) {
      const rec = asRecord(pred);
      const b64 = asString(rec?.['bytesBase64Encoded']);
      if (b64 === undefined || b64 === '') continue;
      const mime = asString(rec?.['mimeType']) ?? `image/${payload.output.format ?? 'png'}`;
      const revised = asString(rec?.['prompt']);
      images.push({
        image: { kind: 'inline', mime, data: b64 },
        ...(revised !== undefined ? { revised_prompt: revised } : {}),
      });
    }

    const usage: CanonicalUsage = {
      units: { images: { generated: images.length, edited: 0 } },
      source: 'provider',
    };

    const response: CanonicalResponseEnvelope = {
      ir_version: IR_VERSION,
      kind: 'image',
      request_id: opts.requestId ?? '',
      usage,
      finish_reason: 'stop',
      payload: { images } satisfies ImageResponsePayload,
      warnings: [],
      raw: {
        source_provider: 'gemini.generateContent',
        unmapped: { model, endpoint: 'predict' },
      },
    };
    return { response, httpStatus: 200 };
  }

  /** Gemini 原生生图/编辑模型：`POST /v1beta/models/{model}:generateContent`。 */
  private async generateWithGeminiContent(
    model: string,
    payload: ImagePayload,
    opts: ImageAdaptorOptions,
    edited: boolean,
  ): Promise<ImageAdaptorOutcome> {
    const parts: Array<Record<string, unknown>> = [];

    // 编辑 / 参考图场景：把原图与参考图作为 inlineData / fileData 附在 prompt 前面
    if (payload.edit?.image !== undefined) {
      parts.push(encodeMediaPart(payload.edit.image));
    }
    if (payload.edit?.mask !== undefined) {
      parts.push(encodeMediaPart(payload.edit.mask));
    }
    for (const ref of payload.edit?.reference_images ?? []) {
      parts.push(encodeMediaPart(ref.image));
    }
    parts.push({ text: payload.prompt });

    const aspectRatio = sizeToGeminiAspectRatio(payload.size, payload.aspect_ratio);
    const generationConfig: Record<string, unknown> = {
      responseModalities: ['TEXT', 'IMAGE'],
      ...(aspectRatio !== undefined ? { imageConfig: { aspectRatio } } : {}),
      ...(payload.n !== undefined && payload.n > 1 ? { candidateCount: payload.n } : {}),
    };

    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig,
    };

    const parsed = await this.postJson(
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      body,
      opts,
    );

    const candidates = Array.isArray(parsed['candidates']) ? parsed['candidates'] : [];
    const images: ImageResponsePayload['images'] = [];
    const textNotes: string[] = [];

    for (const cand of candidates) {
      const cRec = asRecord(cand);
      const content = asRecord(cRec?.['content']);
      const rawParts = Array.isArray(content?.['parts']) ? content['parts'] : [];
      for (const p of rawParts) {
        const pRec = asRecord(p);
        if (pRec === undefined) continue;
        if (typeof pRec['text'] === 'string' && pRec['thought'] !== true) {
          textNotes.push(pRec['text']);
        }
        const inline = asRecord(pRec['inlineData'] ?? pRec['inline_data']);
        if (inline !== undefined) {
          const mime = asString(inline['mimeType'] ?? inline['mime_type']) ?? 'image/png';
          const data = asString(inline['data']) ?? '';
          if (mime.startsWith('image/') && data !== '') {
            images.push({
              image: { kind: 'inline', mime, data },
            });
          }
        }
      }
    }

    if (textNotes.length > 0 && images.length > 0) {
      images[0] = { ...images[0]!, revised_prompt: textNotes.join('\n').trim() };
    }

    const usage = extractGeminiImageUsage(parsed['usageMetadata'], images.length, edited);
    const response: CanonicalResponseEnvelope = {
      ir_version: IR_VERSION,
      kind: 'image',
      request_id: opts.requestId ?? '',
      usage,
      finish_reason: 'stop',
      payload: { images } satisfies ImageResponsePayload,
      warnings: images.length === 0 ? ['gemini_image_empty_response'] : [],
      raw: {
        source_provider: 'gemini.generateContent',
        unmapped: { model, endpoint: 'generateContent' },
      },
    };
    return { response, httpStatus: 200 };
  }

  private async postJson(
    path: string,
    body: unknown,
    opts: ImageAdaptorOptions,
  ): Promise<Record<string, unknown>> {
    const getHeaders = opts.headersProvider ?? this.headersProvider;
    const headers: Record<string, string> = {
      ...(await getHeaders()),
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: opts.baseUrl ?? this.baseUrl,
      path,
      headers,
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      stream: false,
    };
    const res: UpstreamResponse = await this.transport.send(upstream);
    const resBody = res.body ?? Buffer.alloc(0);
    if (res.status < 200 || res.status >= 300) {
      throw new GeminiImagesApiError(res.status, resBody.toString('utf8').slice(0, 2048));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(resBody.toString('utf8')) as unknown;
    } catch {
      throw new GeminiImagesApiError(res.status, '上游返回的不是合法 JSON');
    }
    const rec = asRecord(parsed);
    if (rec === undefined) {
      throw new GeminiImagesApiError(res.status, '上游响应不是 JSON 对象');
    }
    return rec;
  }
}

function encodeMediaPart(ref: MediaRef): Record<string, unknown> {
  if (ref.kind === 'inline') {
    return { inlineData: { mimeType: ref.mime, data: ref.data } };
  }
  if (ref.kind === 'uri') {
    return { fileData: { ...(ref.mime !== '' ? { mimeType: ref.mime } : {}), fileUri: ref.uri } };
  }
  return {
    fileData: { ...(ref.mime !== '' ? { mimeType: ref.mime } : {}), fileUri: ref.asset_id },
  };
}

function extractGeminiImageUsage(
  rawMeta: unknown,
  count: number,
  edited: boolean,
): CanonicalUsage {
  const imageUnits = edited ? { generated: 0, edited: count } : { generated: count, edited: 0 };
  const meta = asRecord(rawMeta);
  if (meta === undefined) {
    return { units: { images: imageUnits }, source: 'provider' };
  }
  const prompt = asNumber(meta['promptTokenCount']);
  const candidates = asNumber(meta['candidatesTokenCount']);
  const total = asNumber(meta['totalTokenCount']);
  if (prompt === undefined && candidates === undefined && total === undefined) {
    return { units: { images: imageUnits }, source: 'provider' };
  }
  const inputTokens = prompt ?? 0;
  const outputTokens = candidates ?? 0;
  const tokens: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: total ?? inputTokens + outputTokens,
    cache_read_tokens: asNumber(meta['cachedContentTokenCount']) ?? 0,
    cache_write_tokens: 0,
    reasoning_tokens: asNumber(meta['thoughtsTokenCount']) ?? 0,
  };
  return {
    ...emptyUsage('provider'),
    units: { images: imageUnits, tokens },
    raw: { gemini: meta },
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
