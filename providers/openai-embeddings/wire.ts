/**
 * providers/openai-embeddings/wire.ts —— OpenAI Embeddings 的 wire codec（纯映射）。
 *
 * 唯一事实来源：OpenAI `POST /v1/embeddings` 的 API reference 与 openai SDK v4 的
 * 类型定义（`node_modules/openai/resources/embeddings.d.ts`，2026-11-14 核对）：
 *   - 请求 `{model, input: string | string[] | tokens[], dimensions?, encoding_format?,
 *     user?}`；
 *   - 响应 `{object: "list", data: [{object: "embedding", index, embedding}], model,
 *     usage: {prompt_tokens, total_tokens}}`。
 *
 * DeepSeek **没有** embeddings 端点（已核实：官方 API reference 的全部端点见
 * api-docs.deepseek.com/api/create-chat-completion，价格页无 embedding 项）——所以
 * 本 codec 的上游默认是 OpenAI 或任何 OpenAI 兼容的第三方网关，计量按 token
 * （`units.tokens`，prompt/total）。
 *
 * Gemini 的 `taskType`（RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY 等）不进结构化字段，
 * 走 `native.gemini.task_type`（15 §5 的既定决策）。
 */

import type { CanonicalUsage, EmbeddingPayload, EmbeddingResponsePayload } from '../../ir/index.js';

/** `/v1/embeddings` 的 JSON 请求体。 */
export interface OpenAIEmbeddingsRequest {
  model: string;
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
}

/** 响应体的最小投影。 */
export interface OpenAIEmbeddingsWireResponse {
  data?: Array<{ index?: number; embedding?: number[] | string }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/** decode 的产物。 */
export interface DecodedEmbeddingResponse {
  payload: EmbeddingResponsePayload;
  usage: CanonicalUsage;
  usageRaw?: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * canonical EmbeddingPayload → wire 请求体。
 *
 * `input` 为 MediaRef[] 时**拒绝**（OpenAI embeddings 只收文本/token 数组）：
 * 多模态 embedding 是 Gemini 的形态，本 adaptor 不接——静默丢输入比报错危险。
 */
export function encodeEmbeddingsRequest(
  payload: EmbeddingPayload,
  model: string,
): OpenAIEmbeddingsRequest {
  const input: string | string[] = Array.isArray(payload.input)
    ? payload.input.map((v) => {
        if (typeof v !== 'string') {
          throw new Error(
            'OpenAI embeddings 只接受文本输入；MediaRef 输入是 Gemini 形态，本 adaptor 不接',
          );
        }
        return v;
      })
    : payload.input;
  return {
    model,
    input,
    ...(payload.dimensions === undefined ? {} : { dimensions: payload.dimensions }),
    ...(payload.encoding_format === undefined ? {} : { encoding_format: payload.encoding_format }),
    ...(payload.user === undefined ? {} : { user: payload.user }),
  };
}

/**
 * wire 响应 → canonical payload + usage。**不抛**：形状不符逐字段退化。
 *
 * 计费：`units.tokens`（上游给了 prompt/total 才落；R2：未知绝不用 0 表示——
 * 上游没给 usage 时 tokens 单位整个省略，只留 warnings 由调用方处理）。
 */
export function decodeEmbeddingsResponse(raw: unknown): DecodedEmbeddingResponse {
  const root = asRecord(raw);
  const data = Array.isArray(root?.['data']) ? (root!['data'] as unknown[]) : [];
  const embeddings: EmbeddingResponsePayload['embeddings'] = [];
  data.forEach((item, i) => {
    const rec = asRecord(item);
    const vector = rec?.['embedding'];
    if (!Array.isArray(vector) && typeof vector !== 'string') return;
    embeddings.push({
      index: num(rec?.['index']) ?? i,
      vector: vector as number[] | string,
    });
  });

  const usageRaw = asRecord(root?.['usage']);
  const usage: CanonicalUsage = {
    units: {},
    source: 'provider',
    ...(usageRaw === undefined ? {} : { raw: usageRaw }),
  };
  if (usageRaw !== undefined) {
    const promptTokens = num(usageRaw['prompt_tokens']);
    const totalTokens = num(usageRaw['total_tokens']);
    if (promptTokens !== undefined || totalTokens !== undefined) {
      usage.units.tokens = {
        input_tokens: promptTokens ?? 0,
        output_tokens: 0,
        total_tokens: totalTokens ?? promptTokens ?? 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      };
    }
  }

  return {
    payload: {
      embeddings,
      model: typeof root?.['model'] === 'string' ? (root!['model'] as string) : '',
    },
    usage,
    ...(usageRaw === undefined ? {} : { usageRaw }),
  };
}
