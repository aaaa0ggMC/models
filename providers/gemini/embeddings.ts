/**
 * providers/gemini/embeddings.ts —— Google Gemini 原生 Embeddings adaptor。
 *
 * 按官方 Gemini Developer API 规范：
 *   - 单条输入：`POST /v1beta/models/{model}:embedContent`
 *   - 批量输入：`POST /v1beta/models/{model}:batchEmbedContents`
 *   - 支持 `outputDimensionality`（对应 canonical `dimensions`）与 `taskType`（`native.gemini.task_type`）。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  EmbeddingPayload,
  EmbeddingResponsePayload,
} from '../../ir/index.js';
import { IR_VERSION, emptyUsage } from '../../ir/index.js';
import { asEmbeddingPayload } from '../../ir/guards.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';
import type {
  EmbeddingAdaptorOptions,
  EmbeddingAdaptorOutcome,
  EmbeddingProviderAdaptor,
} from '../../http/embeddings-endpoint.js';

export const GEMINI_EMBEDDINGS_BASE_URL = 'https://generativelanguage.googleapis.com';

export class GeminiEmbeddingsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Gemini embeddings 上游返回 HTTP ${status}`);
    this.name = 'GeminiEmbeddingsApiError';
  }
}

export interface GeminiEmbeddingsAdaptorDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  provider?: string;
  accessPath?: string;
}

export class GeminiEmbeddingsAdaptor implements EmbeddingProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;

  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;

  constructor(deps: GeminiEmbeddingsAdaptorDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? GEMINI_EMBEDDINGS_BASE_URL;
    this.provider = deps.provider ?? 'gemini';
    this.access_path = deps.accessPath ?? 'gemini.generateContent';
  }

  async embed(
    req: CanonicalRequestEnvelope,
    opts: EmbeddingAdaptorOptions = {},
  ): Promise<EmbeddingAdaptorOutcome> {
    const payload = asEmbeddingPayload(req);
    if (payload === undefined) {
      throw new Error(`GeminiEmbeddingsAdaptor 只接 kind:"embedding"，收到 ${req.kind}`);
    }
    const model = (req.resolved_model ?? req.model).replace(/^models\//, '');
    const modelResource = `models/${model}`;
    const taskType = extractTaskType(payload);
    const texts = normalizeEmbeddingInputs(payload.input);

    const isBatch = texts.length > 1;
    const path = isBatch
      ? `/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`
      : `/v1beta/models/${encodeURIComponent(model)}:embedContent`;

    const buildSingle = (text: string): Record<string, unknown> => ({
      model: modelResource,
      content: { parts: [{ text }] },
      ...(taskType !== undefined ? { taskType } : {}),
      ...(payload.dimensions !== undefined ? { outputDimensionality: payload.dimensions } : {}),
    });

    const body = isBatch
      ? { requests: texts.map((t) => buildSingle(t)) }
      : buildSingle(texts[0] ?? '');

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
      throw new GeminiEmbeddingsApiError(res.status, resBody.toString('utf8').slice(0, 2048));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(resBody.toString('utf8')) as unknown;
    } catch {
      throw new GeminiEmbeddingsApiError(res.status, '上游返回的不是合法 JSON');
    }
    const rec = asRecord(parsed);
    if (rec === undefined) {
      throw new GeminiEmbeddingsApiError(res.status, '上游响应不是 JSON 对象');
    }

    const embeddings: EmbeddingResponsePayload['embeddings'] = [];
    if (isBatch) {
      const list = Array.isArray(rec['embeddings']) ? rec['embeddings'] : [];
      list.forEach((item, index) => {
        const vals = asRecord(item)?.['values'];
        if (Array.isArray(vals)) {
          embeddings.push({
            index,
            vector: vals.filter((n): n is number => typeof n === 'number'),
          });
        }
      });
    } else {
      const vals = asRecord(rec['embedding'])?.['values'];
      if (Array.isArray(vals)) {
        embeddings.push({
          index: 0,
          vector: vals.filter((n): n is number => typeof n === 'number'),
        });
      }
    }

    const response: CanonicalResponseEnvelope = {
      ir_version: IR_VERSION,
      kind: 'embedding',
      request_id: opts.requestId ?? '',
      usage: emptyUsage('provider'),
      finish_reason: 'stop',
      payload: {
        embeddings,
        model,
      } satisfies EmbeddingResponsePayload,
      warnings: ['usage_missing'],
      raw: {
        source_provider: 'gemini.generateContent',
      },
    };
    return { response, httpStatus: 200 };
  }
}

function extractTaskType(payload: EmbeddingPayload): string | undefined {
  const gem = asRecord(payload.native?.['gemini']);
  const tt = gem?.['task_type'] ?? gem?.['taskType'];
  return typeof tt === 'string' && tt !== '' ? tt : undefined;
}

function normalizeEmbeddingInputs(input: EmbeddingPayload['input']): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) {
    return input.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  }
  return [''];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
