/**
 * providers/openai-images/adaptor.ts —— image 模态的 **provider adaptor 接口** +
 * OpenAI Images 实现。
 *
 * ## 接口为什么在这里
 *
 * 与 `providers/deepseek/tool-handlers.ts` 的 `ToolEndpointHandler` 同一立场：
 * 「接入网关的那一层」放在 provider 目录里，换一家上游只替换这一个文件，http 层
 * 对上游字段名一无所知。第二家图片上游（Stability / BFL）落地时，把
 * `ImageProviderAdaptor` 接口移到共享位置（如 `providers/image/types.ts`）——
 * 现在只有一家，提前抽象会造出无人实现的接口。
 *
 * ## 装配范围（85 号矩阵 image 卡片的 adaptor 列）
 *
 * - canonical → wire：`encodeGenerateRequest` / `encodeEditRequest`（wire.ts）；
 * - wire → canonical：`decodeImagesResponse`（wire.ts）；
 * - 传输/鉴权：client.ts（薄客户端，注入 Transport + headersProvider）；
 * - 本文件只做装配：canonical 请求信封 → wire 编码 → 客户端 → 解码响应 →
 *   组装 canonical 响应信封（usage / warnings / degraded 诊断 / raw）。
 *
 * ## 未接真实上游
 *
 * 没有 OpenAI key：生产装配见 composition-root（key 走 `AG_OPENAI_API_KEY`，
 * 缺 key 时调用以 `key_invalid` 失败，而不是静默返回空实现），测试全部走
 * ScriptedTransport。这不是「留到以后」的占位——wire 形状已按官方 reference 与
 * SDK 类型逐字段核对，缺的只是凭据。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  ConversionDiagnostic,
} from '../../ir/index.js';
import { asImagePayload } from '../../ir/guards.js';
import {
  decodeImagesResponse,
  encodeEditMultipart,
  encodeEditRequest,
  encodeGenerateRequest,
} from './wire.js';
import { OpenAIImagesClient, type ImagesUpstreamResponse } from './client.js';

import type {
  ImageAdaptorOptions,
  ImageAdaptorOutcome,
  ImageProviderAdaptor,
} from '../../http/images-endpoint.js';

export type { ImageAdaptorOptions, ImageAdaptorOutcome, ImageProviderAdaptor };

/** OpenAI Images adaptor 的构造依赖。 */
export interface OpenAIImagesAdaptorDeps {
  client: OpenAIImagesClient;
  /** 覆盖 provider / access path 标识（测试可用假值）。 */
  provider?: string;
  accessPath?: string;
}

/** 从 canonical 信封里取 image payload（类型守卫；调用方已判过 kind）。 */
function imagePayloadOf(req: CanonicalRequestEnvelope): ImagePayloadShape {
  const payload = asImagePayload(req);
  if (payload === undefined) {
    throw new Error(`OpenAIImagesAdaptor 只接 kind:"image"，收到 ${req.kind}`);
  }
  return payload;
}

/** ImagePayload 的结构化形状（避免在本文件重复 import 类型名）。 */
type ImagePayloadShape = ReturnType<typeof asImagePayload> & object;

export class OpenAIImagesAdaptor implements ImageProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;

  private readonly client: OpenAIImagesClient;

  constructor(deps: OpenAIImagesAdaptorDeps) {
    this.client = deps.client;
    this.provider = deps.provider ?? 'openai';
    this.access_path = deps.accessPath ?? 'openai.images';
  }

  async generate(
    req: CanonicalRequestEnvelope,
    opts: ImageAdaptorOptions = {},
  ): Promise<ImageAdaptorOutcome> {
    const payload = imagePayloadOf(req);
    const model = req.resolved_model ?? req.model;
    const { request, dropped, warnings } = encodeGenerateRequest(payload, model);

    const upstream = await this.client.generate(request, {
      ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
      ...(opts.headersProvider === undefined ? {} : { headersProvider: opts.headersProvider }),
    });
    return this.assemble(upstream, opts, {
      requestedFormat: payload.output.format,
      edited: false,
      dropped,
      warnings,
    });
  }

  async edit(
    req: CanonicalRequestEnvelope,
    opts: ImageAdaptorOptions = {},
  ): Promise<ImageAdaptorOutcome> {
    const payload = imagePayloadOf(req);
    const model = req.resolved_model ?? req.model;
    const edit = payload.edit;
    if (edit === undefined || edit.image === undefined) {
      throw new Error('images/edits 需要 payload.edit.image（原图）');
    }

    // canonical MediaRef → wire 文件字段。v1 只接受 inline（base64）——uri/asset
    // 三态的完整支持要等媒体库（10 §5.1），提前做会出现「引用了取不到」的半链路。
    const images = [edit.image, ...(edit.reference_images ?? []).map((r) => r.image)].map(
      (media) => {
        if (media.kind !== 'inline') {
          throw new Error(
            `images/edits 的参考图只支持 inline base64（收到 ${media.kind}）；uri/asset 待媒体库落地`,
          );
        }
        return {
          filename: 'image.png',
          contentType: media.mime,
          data: Buffer.from(media.data, 'base64'),
        };
      },
    );
    if (edit.mask !== undefined && edit.mask.kind !== 'inline') {
      throw new Error('images/edits 的 mask 只支持 inline base64');
    }
    const mask =
      edit.mask === undefined || edit.mask.kind !== 'inline'
        ? undefined
        : {
            filename: 'mask.png',
            contentType: edit.mask.mime,
            data: Buffer.from(edit.mask.data, 'base64'),
          };

    const { request, dropped, warnings } = encodeEditRequest(payload, model, {
      images,
      ...(mask === undefined ? {} : { mask }),
    });
    const encoded = encodeEditMultipart(request);
    const upstream = await this.client.edit(encoded.body, encoded.headers['content-type'], {
      ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
      ...(opts.headersProvider === undefined ? {} : { headersProvider: opts.headersProvider }),
    });
    return this.assemble(upstream, opts, {
      requestedFormat: payload.output.format,
      edited: true,
      dropped,
      warnings,
    });
  }

  /** 上游响应 → canonical 响应信封。 */
  private assemble(
    upstream: ImagesUpstreamResponse,
    opts: ImageAdaptorOptions,
    wire: {
      requestedFormat: string;
      edited: boolean;
      dropped: string[];
      warnings: string[];
    },
  ): ImageAdaptorOutcome {
    let parsed: unknown;
    try {
      parsed = JSON.parse(upstream.body.toString('utf8')) as unknown;
    } catch {
      throw new Error('上游响应不是合法 JSON');
    }
    const decoded = decodeImagesResponse(parsed, {
      requestedFormat: wire.requestedFormat,
      edited: wire.edited,
    });

    const diagnostics: ConversionDiagnostic[] = wire.dropped.map((field) => ({
      code: 'capability_dropped',
      field_path: field,
      from: 'openai.images.generations',
      to: 'openai.images.generations',
      level: 'warning',
      message: `上游不支持 ${field}，已丢弃`,
    }));

    const response: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'image',
      request_id: opts.requestId ?? '',
      usage: decoded.usage,
      finish_reason: 'stop',
      payload: decoded.payload,
      ...(diagnostics.length === 0 ? {} : { degraded: diagnostics }),
      warnings: wire.warnings,
      raw: {
        ...(decoded.usageRaw === undefined ? {} : { nodes: { usage: decoded.usageRaw } }),
        ...(decoded.created === undefined
          ? {}
          : {
              nodes: {
                ...(decoded.usageRaw === undefined ? {} : { usage: decoded.usageRaw }),
                upstream_created: decoded.created,
              },
            }),
        source_provider: this.provider,
      },
    };
    return { response, httpStatus: upstream.status };
  }
}
