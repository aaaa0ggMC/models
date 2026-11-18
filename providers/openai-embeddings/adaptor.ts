/**
 * providers/openai-embeddings/adaptor.ts —— embedding 模态的 adaptor 接口 +
 * OpenAI 兼容实现（含薄客户端）。
 *
 * 与 openai-images 同构：接口放在 provider 目录（第二家上游落地时移到共享位置）。
 * wire 映射在 wire.ts，本文件做装配 + 传输。
 *
 * ⚠️ **未接真实上游**：DeepSeek 无 embeddings 端点（官方 API reference 已核实），
 * 本 adaptor 按 OpenAI 兼容形状实现；没有 key，测试走 ScriptedTransport。
 */

import type { CanonicalRequestEnvelope, CanonicalResponseEnvelope } from '../../ir/index.js';
import { asEmbeddingPayload } from '../../ir/guards.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';
import { decodeEmbeddingsResponse, encodeEmbeddingsRequest } from './wire.js';

/** OpenAI 兼容 embeddings 的 base URL 与路径。 */
export const OPENAI_EMBEDDINGS_BASE_URL = 'https://api.openai.com';
export const OPENAI_EMBEDDINGS_PATH = '/v1/embeddings';

/** 上游返回了非 2xx。 */
export class OpenAIEmbeddingsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`embeddings 上游返回 HTTP ${status}`);
    this.name = 'OpenAIEmbeddingsApiError';
  }
}

import type {
  EmbeddingAdaptorOptions,
  EmbeddingAdaptorOutcome,
  EmbeddingProviderAdaptor,
} from '../../http/embeddings-endpoint.js';

export type { EmbeddingAdaptorOptions, EmbeddingAdaptorOutcome, EmbeddingProviderAdaptor };

export interface OpenAIEmbeddingsAdaptorDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
  provider?: string;
  accessPath?: string;
}

export class OpenAIEmbeddingsAdaptor implements EmbeddingProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;

  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: OpenAIEmbeddingsAdaptorDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? OPENAI_EMBEDDINGS_BASE_URL;
    this.path = deps.path ?? OPENAI_EMBEDDINGS_PATH;
    this.provider = deps.provider ?? 'openai';
    this.access_path = deps.accessPath ?? 'openai.embeddings';
  }

  async embed(
    req: CanonicalRequestEnvelope,
    opts: EmbeddingAdaptorOptions = {},
  ): Promise<EmbeddingAdaptorOutcome> {
    const payload = asEmbeddingPayload(req);
    if (payload === undefined) {
      throw new Error(`OpenAIEmbeddingsAdaptor 只接 kind:"embedding"，收到 ${req.kind}`);
    }
    const model = req.resolved_model ?? req.model;
    const body = encodeEmbeddingsRequest(payload, model);

    const getHeaders = opts.headersProvider ?? this.headersProvider;
    const headers: Record<string, string> = {
      ...(await getHeaders()),
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: opts.baseUrl ?? this.baseUrl,
      path: this.path,
      headers,
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      stream: false,
    };
    const res: UpstreamResponse = await this.transport.send(upstream);
    const resBody = res.body ?? Buffer.alloc(0);
    if (res.status < 200 || res.status >= 300) {
      throw new OpenAIEmbeddingsApiError(res.status, resBody.toString('utf8').slice(0, 2048));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(resBody.toString('utf8')) as unknown;
    } catch {
      throw new Error('上游响应不是合法 JSON');
    }
    const decoded = decodeEmbeddingsResponse(parsed);

    const response: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'embedding',
      request_id: opts.requestId ?? '',
      usage: decoded.usage,
      finish_reason: 'stop',
      payload: decoded.payload,
      warnings: decoded.usage.units.tokens === undefined ? ['usage_missing'] : [],
      raw: {
        ...(decoded.usageRaw === undefined ? {} : { nodes: { usage: decoded.usageRaw } }),
        source_provider: this.provider,
      },
    };
    return { response, httpStatus: res.status };
  }
}
