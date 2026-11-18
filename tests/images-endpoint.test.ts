/**
 * tests/images-endpoint.test.ts —— image 模态端到端契约测试。
 *
 * 覆盖任务书要求的四件事：
 *   1. **canonical 往返**：客户端 JSON → canonical 信封 → OpenAI wire →（mock 上游）
 *      → canonical 响应信封 → 客户端 JSON。纯函数层面 + HTTP 层面各至少一次；
 *   2. **入站脸契约**：用**官方 openai SDK**（devDependency）打我们的
 *      `/v1/images/generations` 与 `/v1/images/edits`，让 SDK 自己的类型与
 *      multipart 编码逻辑验收 drop-in（同 tests/models-openai-sdk.test.ts 的姿势）；
 *   3. **计量**：`units.images`（按张）+ `units.tokens`（gpt-image token 形态）+
 *      pricing snapshot（token 槽位）+ 失败也记账；
 *   4. **multipart**：edits 的入站解析（`image[]` 重复 part / `mask` / 文本字段）。
 *
 * 上游一律 ScriptedTransport（**未接真实上游**：没有 OpenAI key，wire 形状按官方
 * API reference 与 SDK 类型实现），key 一律显式假值。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
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
import { createImagesEndpointHandlers } from '../http/images-endpoint.js';
import {
  OpenAIImagesAdaptor,
  OpenAIImagesClient,
  createOpenAIImagesPricingService,
} from '../providers/openai-images/index.js';
import { parseMultipartFormData } from '../http/multipart.js';
import { computeCost, resolvePrice } from '../metering/pricing.js';
import {
  DefaultEncryptedRecordStore,
  InMemoryRawRecordStore,
  Keystore,
  PassphraseKekSource,
} from '../storage/index.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const FAKE_KEY = 'sk-fake-openai-not-real';

/** 1x1 透明 PNG 的 base64（真实可解码的图片字节，测试断言用）。 */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** OpenAI Images 的 mock 上游响应（gpt-image 形态：b64 + token usage）。 */
function imagesUpstream(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    created: 1_760_000_000,
    background: 'opaque',
    data: [
      { b64_json: TINY_PNG_B64 },
      { b64_json: TINY_PNG_B64, revised_prompt: '改写后的 prompt' },
    ],
    usage: {
      input_tokens: 100,
      input_tokens_details: { text_tokens: 40, image_tokens: 60 },
      output_tokens: 500,
      total_tokens: 600,
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

/** 不起服务的纯函数 handler 装配（canonical 往返用）。 */
function handlersFor(transport: ScriptedTransport) {
  const adaptor = new OpenAIImagesAdaptor({
    client: new OpenAIImagesClient({
      transport,
      headersProvider: async () => ({ authorization: `Bearer ${FAKE_KEY}` }),
    }),
  });
  return createImagesEndpointHandlers(adaptor);
}

// ---------------------------------------------------------------------------
// 1. canonical 往返（纯函数层面）
// ---------------------------------------------------------------------------

describe('canonical 往返：images/generations', () => {
  it('客户端 JSON → canonical → wire → canonical → 客户端 JSON', async () => {
    const transport = new ScriptedTransport([{ body: imagesUpstream() }]);
    const [generations] = handlersFor(transport);

    const canonical = generations.decodeRequest({
      kind: 'json',
      body: {
        model: 'gpt-image-2.6',
        prompt: '一只戴贝雷帽的水獺',
        n: 2,
        size: '1024x1024',
        quality: 'high',
        background: 'auto',
        output_format: 'png',
        output_compression: 90,
        user: 'end-user-1',
        some_future_field: { a: 1 },
      },
    });
    expect(canonical).toMatchObject({
      ir_version: 'ag-ir/1',
      kind: 'image',
      model: 'gpt-image-2.6',
      source_format: 'openai.images.generations',
    });
    expect(canonical.payload).toMatchObject({
      prompt: '一只戴贝雷帽的水獺',
      n: 2,
      size: { width: 1024, height: 1024 },
      quality: 'high',
      background: 'auto',
      output: { format: 'png', response_type: 'b64_json', output_compression: 90 },
      user: 'end-user-1',
    });
    // 未建模顶层键进 raw.unmapped（20 §S1：不允许丢字段）
    expect(canonical.raw.unmapped).toEqual({ some_future_field: { a: 1 } });

    const response = await generations.run(canonical);
    // 上游收到的是 OpenAI wire 形状
    const wire = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(wire).toMatchObject({
      model: 'gpt-image-2.6',
      prompt: '一只戴贝雷帽的水獺',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      background: 'auto',
      output_format: 'png',
      output_compression: 90,
    });
    expect(transport.requests[0]!.path).toBe('/v1/images/generations');

    // canonical 响应：两张图 + token usage + 按张 usage
    expect(response.kind).toBe('image');
    expect(response.payload).toMatchObject({
      images: [
        { image: { kind: 'inline', mime: 'image/png', data: TINY_PNG_B64 } },
        { image: { kind: 'inline', mime: 'image/png' }, revised_prompt: '改写后的 prompt' },
      ],
      background: 'opaque',
    });
    expect(response.usage.units).toEqual({
      images: { generated: 2, edited: 0 },
      tokens: {
        input_tokens: 100,
        output_tokens: 500,
        total_tokens: 600,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        details: { text_tokens: 40, image_tokens: 60 },
      },
    });
    expect(response.usage.raw).toMatchObject({ input_tokens: 100 });

    // 回给客户端的 JSON 是 OpenAI 形状
    const client = generations.encodeResponse(response) as Record<string, unknown>;
    expect(client['created']).toBe(1_760_000_000);
    expect(client['background']).toBe('opaque');
    const data = client['data'] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(2);
    expect(data[0]!['b64_json']).toBe(TINY_PNG_B64);
    expect(data[1]!['revised_prompt']).toBe('改写后的 prompt');
    expect(client['usage']).toMatchObject({
      input_tokens: 100,
      output_tokens: 500,
      total_tokens: 600,
      input_tokens_details: { text_tokens: 40, image_tokens: 60 },
    });
  });

  it('negative_prompt / aspect_ratio / sampling → 显式 drop + warning（不静默）', async () => {
    const transport = new ScriptedTransport([{ body: imagesUpstream() }]);
    const [generations] = handlersFor(transport);
    const canonical = generations.decodeRequest({
      kind: 'json',
      body: {
        model: 'gpt-image-2.6',
        prompt: 'p',
        negative_prompt: '不要暴力',
        aspect_ratio: '16:9',
        // sampling 不在 OpenAI 客户端方言里 → 进 raw.unmapped（不是 drop+warning）
        sampling: { steps: 30, seed: 1 },
      },
    });
    expect(canonical.raw.unmapped).toEqual({ sampling: { steps: 30, seed: 1 } });
    const response = await generations.run(canonical);
    expect(response.warnings).toContain('negative_prompt_dropped: OpenAI Images 不支持负向 prompt');
    expect(response.warnings).toContain(
      'aspect_ratio_dropped: OpenAI Images 用 size 不用比例，请改传 size',
    );
    // 诊断进 degraded[]（转换诊断是一等公民）
    expect(response.degraded?.map((d) => d.field_path)).toEqual(
      expect.arrayContaining(['negative_prompt', 'aspect_ratio']),
    );
    // 上游 wire 里没有这些字段
    const wire = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as Record<
      string,
      unknown
    >;
    expect('negative_prompt' in wire).toBe(false);
    expect('aspect_ratio' in wire).toBe(false);
  });

  it('stream: true → 400 级 ModalityRequestError（该端点无流式语义）', () => {
    const transport = new ScriptedTransport([]);
    const [generations] = handlersFor(transport);
    expect(() =>
      generations.decodeRequest({ kind: 'json', body: { model: 'm', prompt: 'p', stream: true } }),
    ).toThrow(/不支持流式/);
  });

  it('缺 prompt / 坏 size / 坏 quality → 400 + 一句话', () => {
    const transport = new ScriptedTransport([]);
    const [generations] = handlersFor(transport);
    expect(() => generations.decodeRequest({ kind: 'json', body: { model: 'm' } })).toThrow(
      /prompt/,
    );
    expect(() =>
      generations.decodeRequest({ kind: 'json', body: { model: 'm', prompt: 'p', size: 'big' } }),
    ).toThrow(/size/);
    expect(() =>
      generations.decodeRequest({
        kind: 'json',
        body: { model: 'm', prompt: 'p', quality: 'ultra' },
      }),
    ).toThrow(/quality/);
  });
});

describe('canonical 往返：images/edits（multipart）', () => {
  it('multipart 入站 → canonical（edit.image + mask）→ wire multipart → 响应', async () => {
    const transport = new ScriptedTransport([{ body: imagesUpstream() }]);
    const handlers = handlersFor(transport);
    const edits = handlers.find((h) => h.id === 'images.edits')!;

    // 按 openai SDK 的规则手搓 multipart：数组 → image[] 重复 part
    const boundary = '----test-boundary';
    const part = (headers: string, body: string | Buffer): Buffer =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`, 'utf8'),
        Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
        Buffer.from('\r\n', 'utf8'),
      ]);
    const imageBytes = Buffer.from(TINY_PNG_B64, 'base64');
    const bodyBuf = Buffer.concat([
      part(
        'Content-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png',
        imageBytes,
      ),
      part(
        'Content-Disposition: form-data; name="image[]"; filename="b.png"\r\nContent-Type: image/png',
        imageBytes,
      ),
      part(
        'Content-Disposition: form-data; name="mask"; filename="mask.png"\r\nContent-Type: image/png',
        imageBytes,
      ),
      part('Content-Disposition: form-data; name="prompt"', '把背景换成海滩'),
      part('Content-Disposition: form-data; name="model"', 'gpt-image-2.6'),
      part('Content-Disposition: form-data; name="n"', '1'),
      part('Content-Disposition: form-data; name="output_format"', 'webp'),
      Buffer.from(`--${boundary}--\r\n`, 'utf8'),
    ]);

    const parts = parseMultipartFormData(bodyBuf, `multipart/form-data; boundary=${boundary}`);
    const canonical = edits.decodeRequest({ kind: 'multipart', parts });
    expect(canonical.source_format).toBe('openai.images.edits');
    const payload = canonical.payload as unknown as {
      prompt: string;
      edit?: { image?: { kind: string; data: string }; mask?: { kind: string } };
      output: { format: string };
    };
    expect(payload.prompt).toBe('把背景换成海滩');
    expect(payload.edit?.image).toMatchObject({ kind: 'inline', mime: 'image/png' });
    expect(payload.edit?.image?.data).toBe(TINY_PNG_B64);
    expect(payload.edit?.mask?.kind).toBe('inline');
    expect(payload.output.format).toBe('webp');

    const response = await edits.run(canonical);
    // 上游收到 multipart，且图片字节能解回原文
    expect(transport.requests[0]!.headers['content-type']).toContain('multipart/form-data');
    const sentParts = parseMultipartFormData(
      transport.requests[0]!.body!,
      transport.requests[0]!.headers['content-type']!,
    );
    expect(sentParts.files.filter((f) => f.name === 'image[]')).toHaveLength(2);
    expect(sentParts.files.find((f) => f.name === 'image[]')!.data.equals(imageBytes)).toBe(true);
    expect(sentParts.files.find((f) => f.name === 'mask')!.data.equals(imageBytes)).toBe(true);
    expect(Object.fromEntries(sentParts.fields)).toMatchObject({
      prompt: '把背景换成海滩',
      model: 'gpt-image-2.6',
      output_format: 'webp',
      n: '1',
    });
    // 按张计费：edits 的图进 edited 槽
    expect(response.usage.units.images).toEqual({ generated: 2, edited: 2 });
  });

  it('没有 image 文件字段 → 400 + 一句话', () => {
    const transport = new ScriptedTransport([]);
    const handlers = handlersFor(transport);
    const edits = handlers.find((h) => h.id === 'images.edits')!;
    expect(() =>
      edits.decodeRequest({
        kind: 'multipart',
        parts: {
          fields: new Map([
            ['prompt', 'p'],
            ['model', 'gpt-image-2.6'],
          ]),
          files: [],
        },
      }),
    ).toThrow(/image/);
  });
});

// ---------------------------------------------------------------------------
// 2. 官方 SDK drop-in
// ---------------------------------------------------------------------------

/** 把我们的处理器包成 OpenAI SDK 能用的 fetch（不起真服务）。 */
function sdkClient(baseUrl: string): OpenAI {
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url ?? input);
    const url = new URL(raw, baseUrl);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
      return new Response(JSON.stringify({ error: { message: 'method' } }), { status: 405 });
    }
    // SDK 的 multipart body 是 FormData：包成真 Request 再读字节
    let bodyBuf: Buffer;
    const contentType = new Headers(init?.headers).get('content-type') ?? '';
    let realContentType = contentType;
    if (init?.body !== undefined && !(typeof init.body === 'string')) {
      const req = new Request(url, {
        method: 'POST',
        body: init.body as never,
        duplex: 'half',
      } as RequestInit);
      bodyBuf = Buffer.from(await req.arrayBuffer());
      realContentType = req.headers.get('content-type') ?? contentType;
    } else {
      bodyBuf = Buffer.from((init?.body as string | undefined) ?? '', 'utf8');
    }
    const res = await fetch(`${baseUrl}${url.pathname}`, {
      method: 'POST',
      headers: { 'content-type': realContentType },
      body: bodyBuf,
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return new OpenAI({
    apiKey: 'test-not-a-real-key',
    fetch: fetchImpl as unknown as OpenAIFetch,
    maxRetries: 0,
  });
}

describe('OpenAI SDK · images.generate() drop-in', () => {
  it('SDK 能无修正地解析我们的响应', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const client = sdkClient(harness.baseUrl);
    const res = await client.images.generate({
      model: 'gpt-image-2.6',
      prompt: '一只戴贝雷帽的水獺',
      n: 2,
      size: '1024x1024',
      quality: 'high',
      output_format: 'png',
    });
    expect(typeof res.created).toBe('number');
    expect(res.data).toHaveLength(2);
    expect(res.data?.[0]?.b64_json).toBe(TINY_PNG_B64);
    expect(res.data?.[1]?.revised_prompt).toBe('改写后的 prompt');
    expect(res.usage?.input_tokens).toBe(100);
    expect(res.usage?.output_tokens).toBe(500);
    expect(res.usage?.total_tokens).toBe(600);
    expect(res.usage?.input_tokens_details.text_tokens).toBe(40);
    expect(res.usage?.input_tokens_details.image_tokens).toBe(60);
    await close(harness);
  });

  it('SDK 认识的字段我们都发给了上游（wire 同构）', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const client = sdkClient(harness.baseUrl);
    await client.images.generate({
      model: 'gpt-image-2.6',
      prompt: 'p',
      n: 3,
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      output_compression: 80,
      moderation: 'low',
      user: 'u-1',
    });
    const wire = JSON.parse(
      harness.transport.requests[0]!.body?.toString('utf8') ?? '{}',
    ) as Record<string, unknown>;
    expect(wire).toMatchObject({
      model: 'gpt-image-2.6',
      prompt: 'p',
      n: 3,
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      output_compression: 80,
      moderation: 'low',
      user: 'u-1',
    });
    await close(harness);
  });
});

describe('OpenAI SDK · images.edit() drop-in（multipart）', () => {
  it('SDK 的 FormData 编码 → 我们的 multipart 解析 → 上游同构', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const client = sdkClient(harness.baseUrl);
    const file = new File([Buffer.from(TINY_PNG_B64, 'base64')], 'pic.png', {
      type: 'image/png',
    });
    const res = await client.images.edit({
      model: 'gpt-image-2.6',
      image: file,
      mask: file,
      prompt: '把背景换成日落海滩',
      size: '1024x1024',
    });
    expect(res.data).toHaveLength(2);
    expect(res.data?.[0]?.b64_json).toBe(TINY_PNG_B64);
    // 上游收到的是 multipart：image + mask + 文本字段
    const sent = parseMultipartFormData(
      harness.transport.requests[0]!.body!,
      harness.transport.requests[0]!.headers['content-type']!,
    );
    expect(sent.files.map((f) => f.name).sort()).toEqual(['image[]', 'mask']);
    expect(Object.fromEntries(sent.fields)).toMatchObject({
      prompt: '把背景换成日落海滩',
      model: 'gpt-image-2.6',
      size: '1024x1024',
    });
    await close(harness);
  });

  it('SDK 的 image 数组 → 多个 image[] part', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const client = sdkClient(harness.baseUrl);
    const f1 = new File([Buffer.from(TINY_PNG_B64, 'base64')], 'a.png', { type: 'image/png' });
    const f2 = new File([Buffer.from(TINY_PNG_B64, 'base64')], 'b.png', { type: 'image/png' });
    await client.images.edit({ model: 'gpt-image-2.6', image: [f1, f2], prompt: 'p' });
    const sent = parseMultipartFormData(
      harness.transport.requests[0]!.body!,
      harness.transport.requests[0]!.headers['content-type']!,
    );
    expect(sent.files.filter((f) => f.name === 'image[]')).toHaveLength(2);
    await close(harness);
  });
});

// ---------------------------------------------------------------------------
// 3. 计量
// ---------------------------------------------------------------------------

describe('计量：images 端点', () => {
  it('成功 → 一条 UsageRecord：images + tokens 单位 + 定价快照', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const res = await fetch(`${harness.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2.6', prompt: '一只水獺' }),
    });
    expect(res.status).toBe(200);
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.provider).toBe('openai');
    expect(rec.access_path).toBe('openai.images');
    expect(rec.client_format).toBe('openai.images.generations');
    expect(rec.model).toBe('gpt-image-2.6');
    expect(rec.usage.units.images).toEqual({ generated: 2, edited: 0 });
    expect(rec.usage.units.tokens?.input_tokens).toBe(100);
    expect(rec.status).toBe('success');
    // 定价：gpt-image-2.6 表存在 → priced + 快照（4.0/M input、15.0/M output）
    expect(rec.cost.status).toBe('priced');
    expect(rec.price_snapshot?.rates).toMatchObject({
      input_cache_miss: 4.0,
      output: 15.0,
    });
    // 600 tokens 里 input 100 / output 500 → 100/1M*4 + 500/1M*15 = 0.0079
    expect(rec.cost.cash.total).toBeCloseTo(0.0079, 10);
    await close(harness);
  });

  it('上游 429 → 429 给客户端，且失败也记账', async () => {
    const harness = await httpHarness([{ status: 429, body: 'slow down' }]);
    const res = await fetch(`${harness.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2.6', prompt: 'p' }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('error');
    expect(records[0]!.error_code).toBe('rate_limited');
    await close(harness);
  });

  it('上游 401 → key_invalid + 502（不冒充客户端 401）', async () => {
    const harness = await httpHarness([{ status: 401, body: 'bad key' }]);
    const res = await fetch(`${harness.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2.6', prompt: 'p' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('key_invalid');
    // 错误信息一句话，且不回显上游错误体原文
    expect(body.error.message).toBe('上游 Key 无效或没有该端点权限');
    await close(harness);
  });

  it('没有 usage 的上游 → tokens 单位省略（R2：未知绝不用 0），images 仍在', async () => {
    const harness = await httpHarness([
      { body: JSON.stringify({ created: 1, data: [{ b64_json: TINY_PNG_B64 }] }) },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2.6', prompt: 'p' }),
    });
    expect(res.status).toBe(200);
    const records = await recordsOf(harness);
    expect(records[0]!.usage.units.tokens).toBeUndefined();
    expect(records[0]!.usage.units.images).toEqual({ generated: 1, edited: 0 });
    // 表存在（token 计费形态）但上游没给 token 用量 → pending_price：
    // 有计量内容却算不出钱，**不是** unpriced（没内容）也不是 priced $0（免费）
    expect(records[0]!.cost.status).toBe('pending_price');
    expect(records[0]!.price_snapshot).toBeNull();
    await close(harness);
  });

  it('缺 AG_OPENAI_API_KEY → 502 key_invalid（配置错误，不是网络不通）', async () => {
    // 不起 key 的 resolver：凭据缺失要在**调用时**暴露，且分类成 key_invalid
    const sink = new MemoryUsageSink();
    const transport = new ScriptedTransport([{ body: imagesUpstream() }]);
    const gateway = createGateway({
      mode: 'test',
      clock,
      transport,
      usageSink: sink,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {}),
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
    const res = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2.6', prompt: 'p' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('key_invalid');
    // 一句话，且不泄露环境变量名/内部细节
    expect(body.error.message).toBe('上游 Key 未配置或无效');
    // 没打上游（凭据在发请求前就失败了）
    expect(transport.requests).toHaveLength(0);
    await new Promise<void>((r) => server.close(() => r()));
    await gateway.shutdown();
  });

  it('GET → 405；未登记路径 → 404', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const get = await fetch(`${harness.baseUrl}/v1/images/generations`);
    expect(get.status).toBe(405);
    const unknown = await fetch(`${harness.baseUrl}/v1/images/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unknown.status).toBe(404);
    await close(harness);
  });

  it('坏 JSON → 400 invalid_request（不打上游）', async () => {
    const harness = await httpHarness([{ body: imagesUpstream() }]);
    const res = await fetch(`${harness.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });
});

// ---------------------------------------------------------------------------
// 4. multipart 解析器单测
// ---------------------------------------------------------------------------

describe('http/multipart.ts', () => {
  it('解析文本 + 文件字段，保留重复字段与二进制', () => {
    const boundary = '----b';
    const png = Buffer.from(TINY_PNG_B64, 'base64');
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n画一只水獺\r\n`,
        'utf8',
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
        'utf8',
      ),
      png,
      Buffer.from('\r\n', 'utf8'),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="b.png"\r\nContent-Type: image/png\r\n\r\n`,
        'utf8',
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const parsed = parseMultipartFormData(body, `multipart/form-data; boundary=${boundary}`);
    expect(parsed.fields.get('prompt')).toBe('画一只水獺');
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]).toEqual({
      name: 'image[]',
      filename: 'a.png',
      content_type: 'image/png',
      data: png,
    });
    expect(parsed.files[1]!.data.equals(png)).toBe(true);
  });

  it('缺 boundary / 不完整 / 非 multipart → MultipartParseError', () => {
    expect(() => parseMultipartFormData(Buffer.from('x'), 'application/json')).toThrow(
      /multipart\/form-data/,
    );
    expect(() => parseMultipartFormData(Buffer.from('x'), 'multipart/form-data')).toThrow(
      /boundary/,
    );
    expect(() =>
      parseMultipartFormData(
        Buffer.from('--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nv'),
        'multipart/form-data; boundary=b',
      ),
    ).toThrow(/结束边界/);
  });
});

// ---------------------------------------------------------------------------
// 5. 定价：per_image 形态（合成表，不冒充官方价）
// ---------------------------------------------------------------------------

describe('定价：图片计费形态', () => {
  it('token 表：gpt-image-2.6 按 token 计（600 tokens → $0.0079）', () => {
    const pricing = createOpenAIImagesPricingService();
    const result = pricing.price({
      ts: FIXED_NOW,
      model: 'gpt-image-2.6',
      usage: {
        units: {
          tokens: {
            input_tokens: 100,
            output_tokens: 500,
            total_tokens: 600,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
          },
          images: { generated: 2, edited: 0 },
        },
        source: 'provider',
      },
    });
    expect(result.cost.status).toBe('priced');
    expect(result.cost.cash.total).toBeCloseTo(0.0079, 10);
    // 快照固化（对账依据）
    expect(result.price_snapshot?.rates).toMatchObject({ input_cache_miss: 4.0, output: 15.0 });
  });

  it('per_image 表：按张计费也能表达（$0.04/张 × 2 = $0.08）', () => {
    const perImageTable = {
      table_version: 'synthetic-dall-e-3',
      source_url: 'https://example.com/synthetic',
      fetched_at: '2026-11-14',
      currency: 'USD',
      unit: 'USD per image',
      entries: [
        {
          effective_from: '2025-01-01',
          tier: 'default',
          rates: { per_image: 0.04 },
        },
      ],
    };
    // 直接用通用引擎证明 slot 可表达（不经过 openai-images 的 loader）
    const price = resolvePrice(perImageTable, FIXED_NOW);
    const cost = computeCost(
      {
        units: { images: { generated: 2, edited: 0 } },
        source: 'provider',
      },
      price,
    );
    expect(cost.status).toBe('priced');
    expect(cost.cash.total).toBeCloseTo(0.08, 10);
  });

  it('未知模型 → pending_price（不是免费）', () => {
    const pricing = createOpenAIImagesPricingService();
    const result = pricing.price({
      ts: FIXED_NOW,
      model: 'no-such-model',
      usage: { units: { images: { generated: 1, edited: 0 } }, source: 'provider' },
    });
    expect(result.cost.status).toBe('pending_price');
    expect(result.price_snapshot).toBeNull();
  });

  it('带 namespace 的生图请求会剥离 oai/ 前缀，并能回退使用 openai.openai-responses 凭据', async () => {
    const sink = new MemoryUsageSink();
    const transport = new ScriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(imagesUpstream(), 'utf8'),
      },
    ]);
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock('test-passphrase-for-images');
    const recordStore = new DefaultEncryptedRecordStore(
      ks.unlocked(),
      new InMemoryRawRecordStore(),
      clock,
    );
    const gateway = createGateway({
      mode: 'test',
      clock,
      transport,
      usageSink: sink,
      recordStore,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {}),
      modelSync: { syncOnStart: false, intervalMs: 0, ttlMs: 60_000 },
    });
    await gateway.loadSettings();
    const admin = gateway.admin!;
    await admin.adminService.upsertProvider('test', {
      id: 'openai',
      label: 'OpenAI',
      dialect: 'openai.responses',
      base_url: 'https://api.openai.com/v1',
      namespace: 'oai',
      model_source: { kind: 'static', models: ['chatgpt-image-latest'] },
    });
    await admin.adminService.createCredential('test', {
      provider: 'openai',
      access_path: 'openai.openai-responses',
      secret: FAKE_KEY, // privacy-scan: ignore —— 测试假密钥
    });
    const server = createHttpServer({
      authenticator: PERMISSIVE_AUTH,
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      modalities: gateway.modalityEndpoints,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'oai/chatgpt-image-latest', prompt: '一只橘猫' }),
      });
      expect(res.status).toBe(200);
      expect(transport.requests).toHaveLength(1);
      const upstreamBody = JSON.parse(transport.requests[0]!.body!.toString('utf8'));
      expect(upstreamBody.model).toBe('chatgpt-image-latest');
      expect(transport.requests[0]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);

      await gateway.usageEmitter.flush();
      const rec = sink.records[0]!;
      expect(rec.model).toBe('chatgpt-image-latest');
      expect(rec.model_alias).toBe('oai/chatgpt-image-latest');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await gateway.shutdown();
    }
  });
});
