/**
 * http/embeddings-endpoint.ts —— embedding 模态的**入站脸**：OpenAI 兼容
 * `POST /v1/embeddings`。
 *
 * 分工同 http/images-endpoint.ts：本文件管客户端方言 ↔ canonical 信封，
 * providers/openai-embeddings/ 管 canonical ↔ 上游 wire，计量在
 * http/modality-endpoints.ts。
 *
 * 请求体（OpenAI 形状）：`{model, input: string | string[], dimensions?,
 * encoding_format?, user?}`。未建模顶层键进 `raw.unmapped`（20 §S1）。
 * 响应体：`{object: "list", data: [{object: "embedding", index, embedding}],
 * model, usage: {prompt_tokens, total_tokens}}`。
 *
 * DeepSeek 无 embeddings 端点（官方 API reference 已核实，见 85 号矩阵 §6.2）——
 * 上游默认 OpenAI 兼容形态，未接真实上游（无 key），测试走 ScriptedTransport。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  EmbeddingPayload,
  FormatId,
} from '../ir/index.js';
import { asEmbeddingResponsePayload } from '../ir/guards.js';
import { defaultStreamOptions } from '../ir/modality.js';
import {
  ModalityRequestError,
  type ModalityEndpointHandler,
  type ModalityEndpointInput,
} from './modality-endpoints.js';

/** adaptor 调用的可选出参。 */
export interface EmbeddingAdaptorOptions {
  requestId?: string;
  /** 动态路由覆盖：目标渠道的上游 base_url 与鉴权头提供器。 */
  baseUrl?: string;
  headersProvider?: () => Promise<Record<string, string>>;
}

/** embedding 模态上游 adaptor 的产物。 */
export interface EmbeddingAdaptorOutcome {
  response: CanonicalResponseEnvelope;
  httpStatus: number;
}

/** embedding 模态的 provider adaptor 接口（v1 最小面：一个端点）。 */
export interface EmbeddingProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;
  embed(
    req: CanonicalRequestEnvelope,
    opts?: EmbeddingAdaptorOptions,
  ): Promise<EmbeddingAdaptorOutcome>;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ModalityRequestError('请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

function reqStr(body: Record<string, unknown>, key: string, max = 256): string {
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

/** 已建模的顶层键（其余进 raw.unmapped）。 */
const MODELED_KEYS = new Set(['model', 'input', 'dimensions', 'encoding_format', 'user', 'stream']);

function decodeEmbeddings(input: ModalityEndpointInput): CanonicalRequestEnvelope {
  if (input.kind !== 'json') {
    throw new ModalityRequestError('embeddings 只接受 application/json');
  }
  const body = asRecord(input.body);
  if (body['stream'] === true) {
    throw new ModalityRequestError('该端点不支持流式');
  }
  const model = reqStr(body, 'model', 128);

  const rawInput = body['input'];
  let embeddingInput: EmbeddingPayload['input'];
  if (typeof rawInput === 'string') {
    if (rawInput === '') throw new ModalityRequestError('字段 input 不能为空串');
    embeddingInput = rawInput;
  } else if (Array.isArray(rawInput)) {
    if (rawInput.length === 0) throw new ModalityRequestError('字段 input 不能是空数组');
    for (const v of rawInput) {
      if (typeof v !== 'string') {
        throw new ModalityRequestError('字段 input 数组只支持字符串（多模态输入尚未接入）');
      }
    }
    embeddingInput = rawInput as string[];
  } else {
    throw new ModalityRequestError('字段 input 应为字符串或字符串数组');
  }

  const dimensions = body['dimensions'];
  if (dimensions !== undefined && dimensions !== null) {
    if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions <= 0) {
      throw new ModalityRequestError('字段 dimensions 应为正整数');
    }
  }
  const encodingFormat = body['encoding_format'];
  if (
    encodingFormat !== undefined &&
    encodingFormat !== null &&
    encodingFormat !== 'float' &&
    encodingFormat !== 'base64'
  ) {
    throw new ModalityRequestError('字段 encoding_format 应为 float / base64');
  }

  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!MODELED_KEYS.has(k)) unmapped[k] = v;
  }

  const payload: EmbeddingPayload = {
    input: embeddingInput,
    ...(dimensions === undefined || dimensions === null
      ? {}
      : { dimensions: dimensions as number }),
    ...(encodingFormat === undefined || encodingFormat === null
      ? {}
      : { encoding_format: encodingFormat as 'float' | 'base64' }),
    ...(optStr(body, 'user') === undefined ? {} : { user: optStr(body, 'user') }),
    native: {},
    raw: {},
  };

  return {
    ir_version: 'ag-ir/1',
    kind: 'embedding',
    model,
    source_format: 'openai.embeddings',
    stream: defaultStreamOptions('embedding', false),
    payload,
    raw: {
      ...(Object.keys(unmapped).length === 0 ? {} : { unmapped }),
    },
  };
}

function encodeEmbeddingsResponse(res: CanonicalResponseEnvelope): unknown {
  const payload = asEmbeddingResponsePayload(res);
  if (payload === undefined) {
    throw new Error(`embeddings 端点只编码 kind:"embedding" 响应，收到 ${res.kind}`);
  }
  const tokens = res.usage.units.tokens;
  return {
    object: 'list',
    data: payload.embeddings.map((e) => ({
      object: 'embedding',
      index: e.index,
      embedding: e.vector,
    })),
    model: payload.model,
    ...(tokens === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: tokens.input_tokens,
            total_tokens: tokens.total_tokens,
          },
        }),
  };
}

/** 建 embeddings 端点的 handler（adaptor 注入；支持按 access_path 动态路由）。 */
export function createEmbeddingsEndpointHandler(
  adaptor: EmbeddingProviderAdaptor,
  resolveTarget?: (accessPath: string) => {
    baseUrl?: string;
    headersProvider?: () => Promise<Record<string, string>>;
  },
): ModalityEndpointHandler {
  return {
    id: 'embeddings',
    path: '/v1/embeddings',
    kind: 'embedding',
    provider: adaptor.provider,
    access_path: adaptor.access_path,
    client_format: 'openai.embeddings' as FormatId,
    provider_format: 'openai.embeddings' as FormatId,
    input: 'json',
    decodeRequest: decodeEmbeddings,
    run: (req, target) => {
      const opts =
        target !== undefined && resolveTarget !== undefined
          ? resolveTarget(target.access_path)
          : {};
      return adaptor.embed(req, opts).then((o) => o.response);
    },
    encodeResponse: encodeEmbeddingsResponse,
  };
}
