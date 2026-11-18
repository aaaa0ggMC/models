/**
 * tests/embeddings-endpoint.test.ts —— embedding 模态端到端契约测试。
 *
 * 覆盖：入站脸（OpenAI 形状 `/v1/embeddings`）→ canonical → wire（mock 上游）→
 * canonical → 客户端 JSON；计量（`units.tokens`）；官方 SDK drop-in；错误路径。
 *
 * DeepSeek **没有** embeddings 端点（官方 API reference 已核实，85 号矩阵 §6.2），
 * 上游按 OpenAI 兼容形状实现；没有 key → 未接真实上游，测试走 ScriptedTransport。
 */

import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import OpenAI from 'openai';
import type { Fetch as OpenAIFetch } from 'openai/core';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { MemoryUsageSink } from '../metering/memory-emitter.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const FAKE_KEY = 'sk-fake-openai-not-real';

/** OpenAI embeddings 的 mock 上游响应。 */
function embeddingsUpstream(): string {
  return JSON.stringify({
    object: 'list',
    data: [
      { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
      { object: 'embedding', index: 1, embedding: [0.4, 0.5, 0.6] },
    ],
    model: 'text-embedding-3-large',
    usage: { prompt_tokens: 8, total_tokens: 8 },
  });
}

interface HttpHarness {
  server: Server;
  baseUrl: string;
  gateway: ReturnType<typeof createGateway>;
  sink: MemoryUsageSink;
  transport: ScriptedTransport;
}

async function httpHarness(script: ScriptedTransportScript): Promise<HttpHarness> {
  const sink = new MemoryUsageSink();
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    clock,
    transport,
    usageSink: sink,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      AG_OPENAI_API_KEY: FAKE_KEY,
    }),
  });
  const server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    modalities: gateway.modalityEndpoints,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, gateway, sink, transport };
}

async function close(h: HttpHarness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await h.gateway.shutdown();
}

async function recordsOf(h: HttpHarness) {
  await h.gateway.usageEmitter.flush();
  return h.sink.records;
}

describe('POST /v1/embeddings（OpenAI 形状入站脸）', () => {
  it('客户端 JSON → canonical → wire → canonical → 客户端 JSON', async () => {
    const harness = await httpHarness([{ body: embeddingsUpstream() }]);
    const res = await fetch(`${harness.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-large',
        input: ['水獺宝宝', 'A cute baby sea otter'],
        dimensions: 1536,
        encoding_format: 'float',
        user: 'end-user-1',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ object: string; index: number; embedding: number[] }>;
      model: string;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] });
    expect(body.model).toBe('text-embedding-3-large');
    expect(body.usage).toEqual({ prompt_tokens: 8, total_tokens: 8 });

    // 上游收到 OpenAI wire 形状
    const wire = JSON.parse(
      harness.transport.requests[0]!.body?.toString('utf8') ?? '{}',
    ) as Record<string, unknown>;
    expect(wire).toEqual({
      model: 'text-embedding-3-large',
      input: ['水獺宝宝', 'A cute baby sea otter'],
      dimensions: 1536,
      encoding_format: 'float',
      user: 'end-user-1',
    });
    expect(harness.transport.requests[0]!.path).toBe('/v1/embeddings');

    // 计量：tokens（prompt 8）
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    expect(records[0]!.access_path).toBe('openai.embeddings');
    expect(records[0]!.usage.units.tokens).toMatchObject({
      input_tokens: 8,
      output_tokens: 0,
      total_tokens: 8,
    });
    // text-embedding-3-large 已由 models.dev 目录兜底表覆盖定价 → priced
    expect(records[0]!.cost.status).toBe('priced');
    expect(records[0]!.price_snapshot?.price_table_version).toBe('models.dev');
    await close(harness);
  });

  it('单字符串 input 也收（OpenAI 允许 string | string[]）', async () => {
    const harness = await httpHarness([{ body: embeddingsUpstream() }]);
    const res = await fetch(`${harness.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: '单条文本' }),
    });
    expect(res.status).toBe(200);
    const wire = JSON.parse(
      harness.transport.requests[0]!.body?.toString('utf8') ?? '{}',
    ) as Record<string, unknown>;
    expect(wire['input']).toBe('单条文本');
    await close(harness);
  });

  it('上游没给 usage → tokens 单位省略（R2）+ warning usage_missing', async () => {
    const harness = await httpHarness([
      {
        body: JSON.stringify({ object: 'list', data: [{ index: 0, embedding: [1] }], model: 'm' }),
      },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'x' }),
    });
    expect(res.status).toBe(200);
    const records = await recordsOf(harness);
    expect(records[0]!.usage.units.tokens).toBeUndefined();
    expect(records[0]!.warnings).toContain('usage_missing');
    await close(harness);
  });

  it('坏 input（数字/空数组/对象）→ 400 + 一句话', async () => {
    const harness = await httpHarness([{ body: embeddingsUpstream() }]);
    for (const bad of [{ input: 42 }, { input: [] }, { input: { a: 1 } }, { input: '' }]) {
      const res = await fetch(`${harness.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', ...bad }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    }
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('stream: true → 400（该端点无流式）', async () => {
    const harness = await httpHarness([{ body: embeddingsUpstream() }]);
    const res = await fetch(`${harness.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'x', stream: true }),
    });
    expect(res.status).toBe(400);
    await close(harness);
  });

  it('上游 429 → rate_limited；上游 500 → upstream_error', async () => {
    const h1 = await httpHarness([{ status: 429, body: 'slow' }]);
    const r1 = await fetch(`${h1.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'x' }),
    });
    expect(r1.status).toBe(429);
    await close(h1);

    const h2 = await httpHarness([{ status: 500, body: 'boom' }]);
    const r2 = await fetch(`${h2.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'x' }),
    });
    expect(r2.status).toBe(502);
    const body = (await r2.json()) as { error: { code: string } };
    expect(body.error.code).toBe('upstream_error');
    await close(h2);
  });
});

describe('OpenAI SDK · embeddings.create() drop-in', () => {
  it('SDK 能无修正地解析我们的响应', async () => {
    const harness = await httpHarness([{ body: embeddingsUpstream() }]);
    const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const raw =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : String((input as { url?: unknown }).url ?? input);
      const url = new URL(raw, harness.baseUrl);
      const res = await fetch(`${harness.baseUrl}${url.pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: init?.body as string | undefined,
      });
      return new Response(await res.text(), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new OpenAI({
      apiKey: 'test-not-a-real-key',
      fetch: fetchImpl as unknown as OpenAIFetch,
      maxRetries: 0,
    });
    // 显式要 float：openai SDK 在用户不传 encoding_format 时**默认 base64**
    // （SDK 与 API 的默认值不同，见 SDK 的 embeddings.create 实现），随后会把
    // 响应按 base64 解成 Float32Array——passthrough 网关返回什么它就解什么。
    const res = await client.embeddings.create({
      model: 'text-embedding-3-large',
      input: ['a', 'b'],
      encoding_format: 'float',
    });
    expect(res.object).toBe('list');
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.index).toBe(0);
    expect(res.data[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res.model).toBe('text-embedding-3-large');
    expect(res.usage?.prompt_tokens).toBe(8);
    expect(res.usage?.total_tokens).toBe(8);
    await close(harness);
  });
});
