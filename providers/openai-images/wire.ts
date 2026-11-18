/**
 * providers/openai-images/wire.ts —— OpenAI Images（generations / edits）的 wire codec。
 *
 * **纯函数**：canonical `ImagePayload` ↔ OpenAI 请求体 / 响应体，不做 IO、不抛业务错。
 * 上游调用在 client.ts，canonical↔wire 的「接入网关」装配在 adaptor.ts。
 *
 * 唯一事实来源：OpenAI 官方 API reference 与 openai SDK v4 的类型定义
 * （`node_modules/openai/resources/images.d.ts`，2026-11-14 核对）。要点：
 *   - `POST /v1/images/generations`：JSON。字段 `prompt` / `model` / `n` / `size`
 *     （"1024x1024" / "1536x1024" / "1024x1536" / "auto"）/ `quality`
 *     （standard|hd|low|medium|high|auto）/ `style`（vivid|natural，仅 dall-e-3）/
 *     `background`（transparent|opaque|auto，仅 gpt-image-1+）/ `output_format`
 *     （png|jpeg|webp，仅 gpt-image-1+）/ `output_compression`（0–100）/ `moderation`
 *     （low|auto）/ `response_format`（url|b64_json，仅 dall-e 系）/ `user`；
 *   - `POST /v1/images/edits`：**multipart**。SDK 的编码规则（uploads.js 的
 *     `addFormValue`）：字符串/数字/布尔 → 同名文本 part；数组 → `key[]` 重复 part
 *     （`image: [f1, f2]` → 两个 `image[]` 文件 part）；文件 → 带 filename 的 part。
 *     本文件的 `encodeEditRequest` 产出同一形状，保证「客户端 → 网关 → 上游」与
 *     「客户端 → OpenAI 直连」字节级同构；
 *   - 响应：`{created, data: [{b64_json | url, revised_prompt}], background?, usage?}`。
 *     gpt-image 系**恒返回 b64_json** 且 usage 是 token 形态
 *     （`input_tokens` / `output_tokens` / `total_tokens` /
 *     `input_tokens_details.{text_tokens,image_tokens}`）；dall-e 系按张计费、
 *     usage 缺省。两种计费形态 canonical 都装得下（units.tokens + units.images）。
 *
 * 丢弃策略：canonical 是超集，OpenAI 装不下的字段（negative_prompt / aspect_ratio /
 * sampling.* / edit.strength / reference_images 的 weight）**显式 drop + warn**——
 * 静默丢字段比报错更危险（决策 M3）。
 */

import { Buffer } from 'node:buffer';
import type {
  CanonicalUsage,
  ImagePayload,
  ImageResponsePayload,
  MediaRef,
} from '../../ir/index.js';

// ---------------------------------------------------------------------------
// wire 类型（请求）
// ---------------------------------------------------------------------------

/** `/v1/images/generations` 的 JSON 请求体。 */
export interface OpenAIImagesGenerateRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
  response_format?: string;
  user?: string;
}

/** multipart 编码产物（与 ocr.ts 的 EncodedMultipartRequest 同构）。 */
export interface EncodedMultipartRequest {
  body: Buffer;
  headers: { 'content-type': string };
}

/** `/v1/images/edits` 的 multipart 请求体 + content-type 头。 */
export interface OpenAIImagesEditRequest {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  quality?: string;
  background?: string;
  output_format?: string;
  output_compression?: number;
  moderation?: string;
  response_format?: string;
  user?: string;
  /** 原图（1–16 张；SDK 对数组发 `image[]` 重复 part）。 */
  images: Array<{ filename: string; contentType: string; data: Buffer }>;
  /** mask（可选）。 */
  mask?: { filename: string; contentType: string; data: Buffer };
}

// ---------------------------------------------------------------------------
// wire 类型（响应）
// ---------------------------------------------------------------------------

/** OpenAI Images 响应体的最小投影（未建模字段由调用方进 raw）。 */
export interface OpenAIImagesWireResponse {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  background?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
}

/** decodeImagesResponse 的产物。 */
export interface DecodedImagesResponse {
  /** canonical 响应 payload。 */
  payload: ImageResponsePayload;
  /** 归一 usage：token 形态（上游给了 usage）+ 按张（data 长度）两个单位都落。 */
  usage: CanonicalUsage;
  /** 上游原始 usage（对账用）。 */
  usageRaw?: Record<string, unknown>;
  /** 上游的 created（unix 秒；回给客户端时原样带，见 http/images-endpoint.ts）。 */
  created?: number;
}

// ---------------------------------------------------------------------------
// 小工具（不猜：类型不对就当时返回 undefined，由调用方决定 drop/warn）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** `size: {width, height}` → "1024x1024"。 */
function encodeSize(payload: ImagePayload): string | undefined {
  if (payload.size !== undefined) {
    return `${payload.size.width}x${payload.size.height}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// encode：canonical → wire
// ---------------------------------------------------------------------------

/**
 * canonical ImagePayload → `/v1/images/generations` 请求体。
 *
 * `dropped` / `warnings` 通过返回值交给调用方（adaptor 层）——本函数保持纯映射，
 * 不自己决定错误语义。`output.response_type` 为 `"b64_json"` 时显式发
 * `response_format`；`"url"` 时同理（gpt-image 系会忽略它并恒返回 b64，这是上游
 * 行为，不是网关的丢失）。
 */
export function encodeGenerateRequest(
  payload: ImagePayload,
  model: string,
): { request: OpenAIImagesGenerateRequest; dropped: string[]; warnings: string[] } {
  const dropped: string[] = [];
  const warnings: string[] = [];
  const request: OpenAIImagesGenerateRequest = {
    prompt: payload.prompt,
    model,
  };

  if (payload.n !== undefined) request.n = payload.n;
  const size = encodeSize(payload);
  if (size !== undefined) request.size = size;
  if (payload.quality !== undefined) request.quality = payload.quality;
  if (payload.style !== undefined) request.style = payload.style;
  if (payload.background !== undefined) request.background = payload.background;
  if (payload.moderation !== undefined) request.moderation = payload.moderation;
  if (payload.user !== undefined) request.user = payload.user;

  // output 块：format / response_type / transparent_background / output_compression
  request.output_format = payload.output.format;
  if (payload.output.response_type !== undefined) {
    request.response_format = payload.output.response_type;
  }
  if (payload.output.output_compression !== undefined) {
    request.output_compression = payload.output.output_compression;
  }
  // background 缺省时 transparent_background 仍是合法的粗粒度表达
  if (payload.background === undefined && payload.output.transparent_background !== undefined) {
    request.background = payload.output.transparent_background ? 'transparent' : 'opaque';
  }

  // ---- 显式 drop + warn（OpenAI 装不下）----
  if (payload.negative_prompt !== undefined) {
    dropped.push('negative_prompt');
    warnings.push('negative_prompt_dropped: OpenAI Images 不支持负向 prompt');
  }
  if (payload.aspect_ratio !== undefined) {
    dropped.push('aspect_ratio');
    warnings.push('aspect_ratio_dropped: OpenAI Images 用 size 不用比例，请改传 size');
  }
  if (payload.sampling !== undefined) {
    dropped.push('sampling');
    warnings.push('sampling_dropped: OpenAI Images 不暴露 steps/guidance/sampler/seed');
  }
  if (payload.edit !== undefined) {
    dropped.push('edit');
    warnings.push('edit_dropped: generations 端点不接受参考图，请改用 images/edits');
  }
  // allow_prompt_rewrite：dall-e-3 恒改写、gpt-image 由上游自决，无对应字段。
  // 仅当客户端**显式要求不改写**时警告（默认语义与上游一致，不必噪音）。
  if (payload.allow_prompt_rewrite === false) {
    warnings.push('allow_prompt_rewrite_ignored: OpenAI Images 的 prompt 改写不可关闭');
  }

  return { request, dropped, warnings };
}

/**
 * canonical ImagePayload（带 edit）→ `/v1/images/edits` 的 multipart 请求体。
 *
 * 字段顺序与 openai SDK 的 `addFormValue` 对齐：文件 part 用 `image[]`（多图）与
 * `mask`，文本 part 同名直发。这样「客户端打网关」与「客户端打 OpenAI」在字节层
 * 同构，SDK drop-in 测试可以直接比对上游收到的 part 集合。
 */
export function encodeEditRequest(
  payload: ImagePayload,
  model: string,
  files: {
    images: Array<{ filename: string; contentType: string; data: Buffer }>;
    mask?: { filename: string; contentType: string; data: Buffer };
  },
): { request: OpenAIImagesEditRequest; dropped: string[]; warnings: string[] } {
  const dropped: string[] = [];
  const warnings: string[] = [];
  const request: OpenAIImagesEditRequest = {
    prompt: payload.prompt,
    model,
    images: files.images,
    ...(files.mask === undefined ? {} : { mask: files.mask }),
  };

  if (payload.n !== undefined) request.n = payload.n;
  const size = encodeSize(payload);
  if (size !== undefined) request.size = size;
  if (payload.quality !== undefined) request.quality = payload.quality;
  if (payload.background !== undefined) request.background = payload.background;
  if (payload.moderation !== undefined) request.moderation = payload.moderation;
  if (payload.user !== undefined) request.user = payload.user;
  request.output_format = payload.output.format;
  if (payload.output.response_type !== undefined) {
    request.response_format = payload.output.response_type;
  }
  if (payload.output.output_compression !== undefined) {
    request.output_compression = payload.output.output_compression;
  }
  if (payload.background === undefined && payload.output.transparent_background !== undefined) {
    request.background = payload.output.transparent_background ? 'transparent' : 'opaque';
  }

  if (payload.negative_prompt !== undefined) {
    dropped.push('negative_prompt');
    warnings.push('negative_prompt_dropped: OpenAI Images 不支持负向 prompt');
  }
  if (payload.aspect_ratio !== undefined) {
    dropped.push('aspect_ratio');
    warnings.push('aspect_ratio_dropped: OpenAI Images 用 size 不用比例，请改传 size');
  }
  if (payload.sampling !== undefined) {
    dropped.push('sampling');
    warnings.push('sampling_dropped: OpenAI Images 不暴露 steps/guidance/sampler/seed');
  }
  if (payload.edit?.strength !== undefined) {
    dropped.push('edit.strength');
    warnings.push('edit_strength_dropped: OpenAI Images edits 没有强度参数');
  }
  if (payload.edit?.reference_images !== undefined && payload.edit.reference_images.length > 0) {
    dropped.push('edit.reference_images');
    warnings.push('reference_images_dropped: OpenAI Images edits 只用 image[]，权重/模式不映射');
  }
  if (payload.style !== undefined) {
    dropped.push('style');
    warnings.push('style_dropped: edits 端点不支持 style（仅 dall-e-3 generations）');
  }
  if (payload.allow_prompt_rewrite === false) {
    warnings.push('allow_prompt_rewrite_ignored: OpenAI Images 的 prompt 改写不可关闭');
  }

  return { request, dropped, warnings };
}

/** 把 edit 请求编码成 multipart 字节（固定边界；文件名净化防 CRLF 注入）。 */
export function encodeEditMultipart(req: OpenAIImagesEditRequest): EncodedMultipartRequest {
  const boundary = '----agentgateway-openai-images-0001';
  const parts: Buffer[] = [];
  const push = (buf: Buffer) => parts.push(buf);

  const filePart = (name: string, filename: string, contentType: string, data: Buffer): void => {
    push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"; filename="${sanitizeFilename(filename)}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      ),
    );
    push(data);
    push(Buffer.from('\r\n', 'utf8'));
  };
  const textPart = (name: string, value: string): void => {
    push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  };

  // 顺序对齐 SDK：先文件后文本（SDK 用 Promise.all 无序，但字段集合一致即可）
  for (const img of req.images) filePart('image[]', img.filename, img.contentType, img.data);
  if (req.mask !== undefined)
    filePart('mask', req.mask.filename, req.mask.contentType, req.mask.data);
  if (req.model !== undefined) textPart('model', req.model);
  textPart('prompt', req.prompt);
  if (req.n !== undefined) textPart('n', String(req.n));
  if (req.size !== undefined) textPart('size', req.size);
  if (req.quality !== undefined) textPart('quality', req.quality);
  if (req.background !== undefined) textPart('background', req.background);
  if (req.output_format !== undefined) textPart('output_format', req.output_format);
  if (req.output_compression !== undefined) {
    textPart('output_compression', String(req.output_compression));
  }
  if (req.moderation !== undefined) textPart('moderation', req.moderation);
  if (req.response_format !== undefined) textPart('response_format', req.response_format);
  if (req.user !== undefined) textPart('user', req.user);

  push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 文件名净化：只留安全字符（防 Content-Disposition 头注入 CRLF）。 */
function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^\w.-]/g, '_').slice(0, 128);
  return cleaned === '' ? 'upload.png' : cleaned;
}

// ---------------------------------------------------------------------------
// decode：wire → canonical
// ---------------------------------------------------------------------------

/** mime ← output.format（gpt-image 系的 output_format 枚举）。 */
function mimeForFormat(format: string | undefined): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/**
 * OpenAI Images 响应体 → canonical 响应 payload + usage。**不抛**：形状不符时
 * 逐字段退化（data 缺省 → 空数组、usage 缺省 → tokens 单位整个省略）。
 *
 * 计费口径（两条都在 canonical 里表达，不互相冒充）：
 *   - `units.tokens`：上游给了 token usage 才落（gpt-image 系）；
 *   - `units.images.generated`：**恒落** data 长度——按张计费的上游（dall-e/Stability）
 *     与按 token 计费的上游（gpt-image）都能被定价引擎表达（per_image / token 五槽）。
 */
export function decodeImagesResponse(
  raw: unknown,
  opts: { requestedFormat?: string; edited?: boolean } = {},
): DecodedImagesResponse {
  const root = asRecord(raw);
  const data = Array.isArray(root?.['data']) ? (root!['data'] as unknown[]) : [];
  const mime = mimeForFormat(opts.requestedFormat);

  const images: ImageResponsePayload['images'] = [];
  for (const item of data) {
    const rec = asRecord(item);
    if (rec === undefined) continue;
    const b64 = str(rec['b64_json']);
    const url = str(rec['url']);
    const revised = str(rec['revised_prompt']);
    const media: MediaRef | undefined =
      b64 !== undefined
        ? { kind: 'inline', mime, data: b64 }
        : url !== undefined
          ? { kind: 'uri', mime, uri: url }
          : undefined;
    if (media === undefined) continue;
    images.push({
      image: media,
      ...(revised === undefined ? {} : { revised_prompt: revised }),
    });
  }

  const payload: ImageResponsePayload = {
    images,
  };
  const background = str(root?.['background']);
  if (background === 'transparent' || background === 'opaque' || background === 'auto') {
    payload.background = background;
  }

  // ---- usage：token 形态（上游给了才有）+ 按张（恒有）----
  const usageRaw = asRecord(root?.['usage']);
  const usage: CanonicalUsage = {
    units: {
      images: { generated: images.length, edited: opts.edited === true ? images.length : 0 },
    },
    source: 'provider',
  };
  if (usageRaw !== undefined) {
    usage.raw = usageRaw;
    const inputTokens = num(usageRaw['input_tokens']);
    const outputTokens = num(usageRaw['output_tokens']);
    const totalTokens = num(usageRaw['total_tokens']);
    if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
      const details = asRecord(usageRaw['input_tokens_details']);
      usage.units.tokens = {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        total_tokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        ...(details === undefined
          ? {}
          : {
              details: {
                ...(num(details['text_tokens']) === undefined
                  ? {}
                  : { text_tokens: num(details['text_tokens'])! }),
                ...(num(details['image_tokens']) === undefined
                  ? {}
                  : { image_tokens: num(details['image_tokens'])! }),
              },
            }),
      };
    }
  }

  return {
    payload,
    usage,
    ...(usageRaw === undefined ? {} : { usageRaw }),
    ...(num(root?.['created']) === undefined ? {} : { created: num(root?.['created']) }),
  };
}
