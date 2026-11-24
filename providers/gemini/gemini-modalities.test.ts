/**
 * providers/gemini/gemini-modalities.test.ts —— Gemini 原生图像生成/编辑与 Embeddings adaptor 测试。
 */

import { describe, it, expect } from 'vitest';
import {
  GeminiImagesAdaptor,
  GeminiEmbeddingsAdaptor,
  sizeToGeminiAspectRatio,
} from './index.js';
import type { CanonicalRequestEnvelope } from '../../ir/index.js';
import { IR_VERSION } from '../../ir/index.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';

function makeTransport(
  responder: (req: UpstreamRequest) => { status: number; body: unknown },
): { transport: Transport; requests: UpstreamRequest[] } {
  const requests: UpstreamRequest[] = [];
  const transport: Transport = {
    async send(req: UpstreamRequest): Promise<UpstreamResponse> {
      requests.push(req);
      const res = responder(req);
      return {
        status: res.status,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(res.body), 'utf8'),
      };
    },
  };
  return { transport, requests };
}

describe('GeminiImagesAdaptor', () => {
  it('sizeToGeminiAspectRatio 将常见像素尺寸映射到 Gemini 宽高比', () => {
    expect(sizeToGeminiAspectRatio({ width: 1024, height: 1024 })).toBe('1:1');
    expect(sizeToGeminiAspectRatio({ width: 1792, height: 1024 })).toBe('16:9');
    expect(sizeToGeminiAspectRatio({ width: 1024, height: 1792 })).toBe('9:16');
    expect(sizeToGeminiAspectRatio({ width: 1536, height: 1024 })).toBe('3:2');
    expect(sizeToGeminiAspectRatio(undefined, '4:3')).toBe('4:3');
  });

  it('gemini-*-image 模型走 :generateContent 并携带 responseModalities + imageConfig', async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'Here is your cat.' },
                { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 258, totalTokenCount: 273 },
      },
    }));

    const adaptor = new GeminiImagesAdaptor({
      transport,
      headersProvider: async () => ({ 'x-goog-api-key': 'AIza-placeholder' }),
    });

    const req: CanonicalRequestEnvelope = {
      ir_version: IR_VERSION,
      kind: 'image',
      model: 'gemini-2.5-flash-image',
      resolved_model: 'gemini-2.5-flash-image',
      source_format: 'openai.images.generations',
      raw: {},
      payload: {
        prompt: 'A cute cat in space',
        size: { width: 1792, height: 1024 },
        output: { format: 'png', response_type: 'b64_json' },
        raw: {},
      },
    };

    const outcome = await adaptor.generate(req, { requestId: 'req_img_1' });
    expect(outcome.httpStatus).toBe(200);
    expect(requests[0]?.path).toBe('/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(requests[0]?.headers['x-goog-api-key']).toBe('AIza-placeholder');
    const sent = JSON.parse(requests[0]!.body!.toString('utf8')) as {
      generationConfig: { responseModalities: string[]; imageConfig?: { aspectRatio: string } };
    };
    expect(sent.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(sent.generationConfig.imageConfig?.aspectRatio).toBe('16:9');

    const payload = outcome.response.payload as {
      images: Array<{ image: { kind: string; mime: string; data: string }; revised_prompt?: string }>;
    };
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]?.image).toEqual({
      kind: 'inline',
      mime: 'image/png',
      data: 'iVBORw0KGgo=',
    });
    expect(payload.images[0]?.revised_prompt).toBe('Here is your cat.');
    expect(outcome.response.usage.units.images).toEqual({ generated: 1, edited: 0 });
    expect(outcome.response.usage.units.tokens?.total_tokens).toBe(273);
  });

  it('gemini-*-image edit() 携带原图 inlineData', async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ' } }],
            },
          },
        ],
      },
    }));

    const adaptor = new GeminiImagesAdaptor({
      transport,
      headersProvider: async () => ({ 'x-goog-api-key': 'AIza-placeholder' }),
    });

    const req: CanonicalRequestEnvelope = {
      ir_version: IR_VERSION,
      kind: 'image',
      model: 'gemini-2.5-flash-image',
      source_format: 'openai.images.edits',
      raw: {},
      payload: {
        prompt: 'Add a red hat',
        edit: {
          image: { kind: 'inline', mime: 'image/png', data: 'ORIG_IMG_B64' },
        },
        output: { format: 'jpeg', response_type: 'b64_json' },
        raw: {},
      },
    };

    const outcome = await adaptor.edit(req);
    expect(outcome.httpStatus).toBe(200);
    const sent = JSON.parse(requests[0]!.body!.toString('utf8')) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(sent.contents[0]?.parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'ORIG_IMG_B64' },
    });
    expect(sent.contents[0]?.parts[1]).toEqual({ text: 'Add a red hat' });
    expect(outcome.response.usage.units.images).toEqual({ generated: 0, edited: 1 });
  });

  it('imagen-* 模型走 :predict 并解析 predictions[].bytesBase64Encoded', async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: {
        predictions: [
          { bytesBase64Encoded: 'IMAGEN_B64_1', mimeType: 'image/png' },
          { bytesBase64Encoded: 'IMAGEN_B64_2', mimeType: 'image/png' },
        ],
      },
    }));

    const adaptor = new GeminiImagesAdaptor({
      transport,
      headersProvider: async () => ({ 'x-goog-api-key': 'AIza-placeholder' }),
    });

    const req: CanonicalRequestEnvelope = {
      ir_version: IR_VERSION,
      kind: 'image',
      model: 'imagen-4.0-generate-001',
      source_format: 'openai.images.generations',
      raw: {},
      payload: {
        prompt: 'Mountain sunrise',
        n: 2,
        aspect_ratio: '16:9',
        output: { format: 'png', response_type: 'b64_json' },
        raw: {},
      },
    };

    const outcome = await adaptor.generate(req);
    expect(requests[0]?.path).toBe('/v1beta/models/imagen-4.0-generate-001:predict');
    const sent = JSON.parse(requests[0]!.body!.toString('utf8')) as {
      instances: Array<{ prompt: string }>;
      parameters: { sampleCount: number; aspectRatio: string };
    };
    expect(sent.instances).toEqual([{ prompt: 'Mountain sunrise' }]);
    expect(sent.parameters).toEqual({ sampleCount: 2, aspectRatio: '16:9' });
    const payload = outcome.response.payload as { images: Array<{ image: { data: string } }> };
    expect(payload.images).toHaveLength(2);
    expect(payload.images[1]?.image.data).toBe('IMAGEN_B64_2');
  });
});

describe('GeminiEmbeddingsAdaptor', () => {
  it('单条文本走 :embedContent 并透传 outputDimensionality 与 taskType', async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: { embedding: { values: [0.1, 0.2, 0.3] } },
    }));

    const adaptor = new GeminiEmbeddingsAdaptor({
      transport,
      headersProvider: async () => ({ 'x-goog-api-key': 'AIza-placeholder' }),
    });

    const req: CanonicalRequestEnvelope = {
      ir_version: IR_VERSION,
      kind: 'embedding',
      model: 'text-embedding-004',
      source_format: 'openai.embeddings',
      raw: {},
      payload: {
        input: 'hello world',
        dimensions: 256,
        native: { gemini: { task_type: 'RETRIEVAL_QUERY' } },
        raw: {},
      },
    };

    const outcome = await adaptor.embed(req);
    expect(requests[0]?.path).toBe('/v1beta/models/text-embedding-004:embedContent');
    const sent = JSON.parse(requests[0]!.body!.toString('utf8')) as Record<string, unknown>;
    expect(sent['outputDimensionality']).toBe(256);
    expect(sent['taskType']).toBe('RETRIEVAL_QUERY');
    const payload = outcome.response.payload as { embeddings: Array<{ vector: number[] }> };
    expect(payload.embeddings[0]?.vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('多条文本走 :batchEmbedContents', async () => {
    const { transport, requests } = makeTransport(() => ({
      status: 200,
      body: {
        embeddings: [{ values: [1, 2] }, { values: [3, 4] }],
      },
    }));

    const adaptor = new GeminiEmbeddingsAdaptor({
      transport,
      headersProvider: async () => ({ 'x-goog-api-key': 'AIza-placeholder' }),
    });

    const req: CanonicalRequestEnvelope = {
      ir_version: IR_VERSION,
      kind: 'embedding',
      model: 'gemini-embedding-001',
      source_format: 'openai.embeddings',
      raw: {},
      payload: {
        input: ['first', 'second'],
        raw: {},
      },
    };

    const outcome = await adaptor.embed(req);
    expect(requests[0]?.path).toBe('/v1beta/models/gemini-embedding-001:batchEmbedContents');
    const payload = outcome.response.payload as {
      embeddings: Array<{ index: number; vector: number[] }>;
    };
    expect(payload.embeddings).toEqual([
      { index: 0, vector: [1, 2] },
      { index: 1, vector: [3, 4] },
    ]);
  });
});
