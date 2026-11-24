/**
 * http/images-endpoint.ts —— image 模态的**入站脸**：OpenAI Images 兼容的
 * `POST /v1/images/generations`（JSON）与 `POST /v1/images/edits`（multipart）。
 *
 * ## 分工
 *
 * - 本文件：客户端方言 ↔ canonical 信封（入站脸）+ 端点元数据；
 * - `providers/openai-images/`：canonical ↔ 上游 wire + 传输（adaptor 那一层）；
 * - `http/modality-endpoints.ts`：鉴权 / 分发 / 错误信封 / 计量（三个模态端点共用）。
 *
 * canonical 是网关与客户端之间的唯一语言（00 §5：不存在原样转发字节的路径）——
 * 客户端 JSON 先完整解码成 `CanonicalRequestEnvelope{kind:"image"}`，响应再完整
 * 编码回 OpenAI 形状。未建模的顶层键进 `raw.unmapped`（20 §S1「不允许丢字段」）。
 *
 * ## 与 OpenAI SDK 的字节级同构
 *
 * `images/edits` 的 multipart 编码规则与 openai SDK 一致（uploads.js 的
 * `addFormValue`：数组 → `key[]` 重复 part），因此「客户端打网关」与「客户端打
 * OpenAI 直连」上游看到的 part 集合相同——tests/images-endpoint.test.ts 用官方
 * SDK 打我们的端点做 drop-in 证明。
 *
 * ## 流式
 *
 * OpenAI Images 没有流式语义；客户端发 `stream: true` → 400 + 一句话
 * （15 §8.2 的 image 进度流是 P2，见 85 号矩阵 §5.3）。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  FormatId,
  ImagePayload,
  MediaRef,
} from '../ir/index.js';
import { asImageResponsePayload } from '../ir/guards.js';
import { defaultStreamOptions } from '../ir/modality.js';
import type { ParsedFilePart, ParsedFormData } from './multipart.js';
import type {
  ModalityEndpointHandler,
  ModalityEndpointInput,
} from './modality-endpoints.js';
import { ModalityRequestError } from './modality-endpoints.js';

/** adaptor 调用的可选出参（http 层填）。 */
export interface ImageAdaptorOptions {
  /** 请求 id（落进响应信封与诊断）。 */
  requestId?: string;
  /** 动态路由覆盖：目标渠道的上游 base_url 与鉴权头提供器。 */
  baseUrl?: string;
  headersProvider?: () => Promise<Record<string, string>>;
  /** 目标接入路径与方言（多协议生图分发用）。 */
  accessPath?: string;
  dialect?: string;
}

/** image 模态上游 adaptor 的产物。 */
export interface ImageAdaptorOutcome {
  /** canonical 响应信封（kind: "image"）。 */
  response: CanonicalResponseEnvelope;
  /** 上游 HTTP 状态（成功时 200）。 */
  httpStatus: number;
}

/** image 模态的 provider adaptor 接口（v1 最小面：两个端点）。 */
export interface ImageProviderAdaptor {
  /** provider 标识（计量用）。 */
  readonly provider: string;
  /** access path（计量用，如 "openai.images"）。 */
  readonly access_path: string;
  /** `POST /v1/images/generations`。 */
  generate(req: CanonicalRequestEnvelope, opts?: ImageAdaptorOptions): Promise<ImageAdaptorOutcome>;
  /** `POST /v1/images/edits`。 */
  edit(req: CanonicalRequestEnvelope, opts?: ImageAdaptorOptions): Promise<ImageAdaptorOutcome>;
}

// ---------------------------------------------------------------------------
// 请求体读取小工具（不猜：缺字段/类型错一律 400，不落默认值）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ModalityRequestError('请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

function reqStr(body: Record<string, unknown>, key: string, max = 32_000): string {
  const v = body[key];
  if (typeof v !== 'string' || v === '') {
    throw new ModalityRequestError(`缺少字段 ${key}（应为非空字符串）`);
  }
  if (v.length > max) throw new ModalityRequestError(`字段 ${key} 超过 ${max} 字符`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string, max = 256): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ModalityRequestError(`字段 ${key} 应为字符串`);
  if (v.length > max) throw new ModalityRequestError(`字段 ${key} 超过 ${max} 字符`);
  return v;
}

/**
 * 读整数字段。**multipart 里一切字段都是字符串**（OpenAI SDK 对 `n` 也发文本
 * part），所以合法的整数字符串照收——这是 dialect 差异不是宽容。
 */
function optInt(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  let n: number | undefined;
  if (typeof v === 'number') n = Number.isInteger(v) ? v : undefined;
  else if (typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim())) n = Number.parseInt(v.trim(), 10);
  if (n === undefined) throw new ModalityRequestError(`字段 ${key} 应为整数`);
  if (n < min || n > max) throw new ModalityRequestError(`字段 ${key} 应在 ${min}–${max} 之间`);
  return n;
}

function optEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new ModalityRequestError(`字段 ${key} 应为 ${allowed.join(' / ')} 之一`);
  }
  return v as T;
}

/** "1024x1024" → {width, height}；畸形 → 400。 */
function parseSize(v: string): { width: number; height: number } {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(v.trim());
  if (m === null) throw new ModalityRequestError('字段 size 应为 "宽x高"（如 1024x1024）');
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 客户端显式要求流式 → 拒绝（该端点无流式语义）。 */
function rejectStream(body: Record<string, unknown>): void {
  if (body['stream'] === true) {
    throw new ModalityRequestError('该端点不支持流式（image 的进度流尚未实现）');
  }
}

// ---------------------------------------------------------------------------
// 共享的参数字段读取（generations 与 edits 的 JSON 部分同款）
// ---------------------------------------------------------------------------

/** 已建模的顶层键（其余进 raw.unmapped）。 */
const MODELED_KEYS = new Set([
  'model',
  'prompt',
  'n',
  'size',
  'quality',
  'style',
  'background',
  'output_format',
  'output_compression',
  'moderation',
  'response_format',
  'user',
  'negative_prompt',
  'aspect_ratio',
  'stream',
]);

interface CommonParams {
  n?: number;
  size?: { width: number; height: number };
  quality?: ImagePayload['quality'];
  background?: ImagePayload['background'];
  output_compression?: number;
  moderation?: ImagePayload['moderation'];
  user?: string;
  /** 未建模顶层键（raw.unmapped）。 */
  unmapped: Record<string, unknown>;
}

function readCommonParams(body: Record<string, unknown>): CommonParams {
  const params: CommonParams = { unmapped: {} };
  const n = optInt(body, 'n', 1, 10);
  if (n !== undefined) params.n = n;
  const size = optStr(body, 'size', 32);
  if (size !== undefined) params.size = parseSize(size);
  const quality = optEnum(body, 'quality', [
    'low',
    'medium',
    'high',
    'hd',
    'standard',
    'auto',
  ] as const);
  if (quality !== undefined) params.quality = quality;
  const background = optEnum(body, 'background', ['transparent', 'opaque', 'auto'] as const);
  if (background !== undefined) params.background = background;
  const compression = optInt(body, 'output_compression', 0, 100);
  if (compression !== undefined) params.output_compression = compression;
  const moderation = optEnum(body, 'moderation', ['auto', 'low', 'high'] as const);
  if (moderation !== undefined) params.moderation = moderation;
  const user = optStr(body, 'user', 256);
  if (user !== undefined) params.user = user;
  for (const [k, v] of Object.entries(body)) {
    if (!MODELED_KEYS.has(k)) params.unmapped[k] = v;
  }
  return params;
}

/** output 块：format / response_type / transparent_background。 */
function readOutput(body: Record<string, unknown>): ImagePayload['output'] {
  const format = optEnum(body, 'output_format', ['png', 'jpeg', 'webp'] as const) ?? 'png';
  const responseType = optEnum(body, 'response_format', ['b64_json', 'url'] as const) ?? 'b64_json';
  return { format, response_type: responseType };
}

/**
 * multipart 文本字段 → 普通对象。
 *
 * 文本字段走 `fields`（Map，同名后者覆盖前者——OpenAI 的图片请求没有同名字段）；
 * 文件字段在 `files`（数组，**保留重复**：SDK 把 `image: [f1, f2]` 编码成两个
 * 同名 `image[]` part，见 openai 包 uploads.js 的 `addFormValue`）。
 */
function textFieldsOf(parsed: ParsedFormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of parsed.fields) out[k] = v;
  return out;
}

/** 取某个名字的全部文件 part（`image` 与 `image[]` 都认——SDK 对数组发 `image[]`）。 */
function filesOf(parsed: ParsedFormData, name: string): ParsedFilePart[] {
  return parsed.files.filter((f) => f.name === name || f.name === `${name}[]`);
}

/** 文件 part → inline MediaRef。 */
function toInlineMedia(file: ParsedFilePart): MediaRef {
  return {
    kind: 'inline',
    mime: file.content_type,
    data: file.data.toString('base64'),
    byte_length: file.data.byteLength,
  };
}

// ---------------------------------------------------------------------------
// 入站脸：/v1/images/generations（JSON）
// ---------------------------------------------------------------------------

function decodeGenerations(input: ModalityEndpointInput): CanonicalRequestEnvelope {
  if (input.kind !== 'json') {
    throw new ModalityRequestError('images/generations 只接受 application/json');
  }
  const body = asRecord(input.body);
  rejectStream(body);
  const prompt = reqStr(body, 'prompt');
  const model = reqStr(body, 'model', 128);
  const common = readCommonParams(body);
  const output = readOutput(body);

  const negative = optStr(body, 'negative_prompt', 4000);
  const aspectRatio = optStr(body, 'aspect_ratio', 16);
  const style = optStr(body, 'style', 64);

  const payload: ImagePayload = {
    prompt,
    ...(negative === undefined ? {} : { negative_prompt: negative }),
    ...(common.size === undefined ? {} : { size: common.size }),
    ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
    ...(common.n === undefined ? {} : { n: common.n }),
    ...(common.quality === undefined ? {} : { quality: common.quality }),
    ...(style === undefined ? {} : { style }),
    ...(common.background === undefined ? {} : { background: common.background }),
    output: {
      ...output,
      ...(common.output_compression === undefined
        ? {}
        : { output_compression: common.output_compression }),
    },
    ...(common.moderation === undefined ? {} : { moderation: common.moderation }),
    ...(common.user === undefined ? {} : { user: common.user }),
    native: {},
    raw: {},
  };

  return {
    ir_version: 'ag-ir/1',
    kind: 'image',
    model,
    source_format: 'openai.images.generations',
    stream: defaultStreamOptions('image', false),
    payload,
    raw: {
      ...(Object.keys(common.unmapped).length === 0 ? {} : { unmapped: common.unmapped }),
    },
  };
}

// ---------------------------------------------------------------------------
// 入站脸：/v1/images/edits（multipart）
// ---------------------------------------------------------------------------

function decodeEdits(input: ModalityEndpointInput): CanonicalRequestEnvelope {
  if (input.kind !== 'multipart') {
    throw new ModalityRequestError('images/edits 只接受 multipart/form-data');
  }
  const { parts } = input;
  const body = textFieldsOf(parts);
  rejectStream(body);

  const prompt = reqStr(body, 'prompt');
  const model = reqStr(body, 'model', 128);
  const imageFiles = filesOf(parts, 'image');
  if (imageFiles.length === 0) {
    throw new ModalityRequestError('multipart 里没有 image 文件字段');
  }
  if (imageFiles.length > 16) {
    throw new ModalityRequestError('image 最多 16 张（OpenAI Images 上限）');
  }
  const maskFiles = filesOf(parts, 'mask');
  if (maskFiles.length > 1) {
    throw new ModalityRequestError('mask 只能有一个');
  }

  const common = readCommonParams(body);
  const output = readOutput(body);
  const negative = optStr(body, 'negative_prompt', 4000);
  const aspectRatio = optStr(body, 'aspect_ratio', 16);

  // 第一张图是编辑对象，其余按多参考图携带（canonical 的 reference_images）
  const [primary, ...rest] = imageFiles;
  const payload: ImagePayload = {
    prompt,
    ...(negative === undefined ? {} : { negative_prompt: negative }),
    ...(common.size === undefined ? {} : { size: common.size }),
    ...(aspectRatio === undefined ? {} : { aspect_ratio: aspectRatio }),
    ...(common.n === undefined ? {} : { n: common.n }),
    ...(common.quality === undefined ? {} : { quality: common.quality }),
    ...(common.background === undefined ? {} : { background: common.background }),
    edit: {
      image: toInlineMedia(primary!),
      ...(maskFiles[0] === undefined ? {} : { mask: toInlineMedia(maskFiles[0]) }),
      ...(rest.length === 0
        ? {}
        : {
            reference_images: rest.map((f) => ({ image: toInlineMedia(f) })),
          }),
    },
    output: {
      ...output,
      ...(common.output_compression === undefined
        ? {}
        : { output_compression: common.output_compression }),
    },
    ...(common.moderation === undefined ? {} : { moderation: common.moderation }),
    ...(common.user === undefined ? {} : { user: common.user }),
    native: {},
    raw: {},
  };

  return {
    ir_version: 'ag-ir/1',
    kind: 'image',
    model,
    source_format: 'openai.images.edits',
    stream: defaultStreamOptions('image', false),
    payload,
    raw: {
      ...(Object.keys(common.unmapped).length === 0 ? {} : { unmapped: common.unmapped }),
    },
  };
}

// ---------------------------------------------------------------------------
// 出站：canonical 响应信封 → OpenAI Images 响应 JSON
// ---------------------------------------------------------------------------

function encodeImagesResponse(res: CanonicalResponseEnvelope): unknown {
  const payload = asImageResponsePayload(res);
  if (payload === undefined) {
    throw new Error(`images 端点只编码 kind:"image" 响应，收到 ${res.kind}`);
  }

  const data = payload.images.map((img) => {
    const media = img.image;
    const b64 = media.kind === 'inline' ? media.data : undefined;
    const url = media.kind === 'uri' ? media.uri : undefined;
    return {
      ...(b64 === undefined ? {} : { b64_json: b64 }),
      ...(url === undefined ? {} : { url }),
      ...(img.revised_prompt === undefined ? {} : { revised_prompt: img.revised_prompt }),
    };
  });

  const tokens = res.usage.units.tokens;
  const upstreamCreated = res.raw.nodes?.['upstream_created'];
  return {
    ...(typeof upstreamCreated === 'number' ? { created: upstreamCreated } : {}),
    data,
    ...(payload.background === undefined ? {} : { background: payload.background }),
    ...(tokens === undefined
      ? {}
      : {
          usage: {
            input_tokens: tokens.input_tokens,
            output_tokens: tokens.output_tokens,
            total_tokens: tokens.total_tokens,
            ...(tokens.details === undefined
              ? {}
              : {
                  input_tokens_details: {
                    ...(tokens.details['text_tokens'] === undefined
                      ? {}
                      : { text_tokens: tokens.details['text_tokens'] }),
                    ...(tokens.details['image_tokens'] === undefined
                      ? {}
                      : { image_tokens: tokens.details['image_tokens'] }),
                  },
                }),
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Handler 工厂
// ---------------------------------------------------------------------------

/** 建两个 image 端点的 handler（adaptor 注入；支持按 access_path 动态路由）。 */
export function createImagesEndpointHandlers(
  adaptor: ImageProviderAdaptor,
  resolveTarget?: (accessPath: string) => {
    baseUrl?: string;
    headersProvider?: () => Promise<Record<string, string>>;
    accessPath?: string;
    dialect?: string;
  },
): ModalityEndpointHandler[] {
  const base = {
    kind: 'image' as const,
    provider: adaptor.provider,
    access_path: adaptor.access_path,
  };
  return [
    {
      ...base,
      id: 'images.generations',
      path: '/v1/images/generations',
      client_format: 'openai.images.generations' as FormatId,
      provider_format: 'openai.images.generations' as FormatId,
      input: 'json',
      decodeRequest: decodeGenerations,
      run: (req, target) => {
        const opts =
          target !== undefined && resolveTarget !== undefined
            ? resolveTarget(target.access_path)
            : {};
        return adaptor.generate(req, opts).then((o) => o.response);
      },
      encodeResponse: encodeImagesResponse,
    },
    {
      ...base,
      id: 'images.edits',
      path: '/v1/images/edits',
      client_format: 'openai.images.edits' as FormatId,
      provider_format: 'openai.images.edits' as FormatId,
      input: 'multipart',
      decodeRequest: decodeEdits,
      run: (req, target) => {
        const opts =
          target !== undefined && resolveTarget !== undefined
            ? resolveTarget(target.access_path)
            : {};
        return adaptor.edit(req, opts).then((o) => o.response);
      },
      encodeResponse: encodeImagesResponse,
    },
  ];
}
