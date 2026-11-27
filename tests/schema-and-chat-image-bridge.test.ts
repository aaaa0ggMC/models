import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { startHttpServer } from '../http/server.js';
import { createChatImageBridge } from '../http/chat-image-bridge.js';
import { createSchemaEndpoints } from '../http/schema-endpoint.js';
import { createModalityMismatchGuard } from '../http/error-guidance.js';
import { IR_VERSION, type CanonicalResponseEnvelope } from '../ir/index.js';
import type { ImageProviderAdaptor } from '../http/images-endpoint.js';
import type { UsageEmitter, UsageRecord } from '../metering/index.js';
import type { Authenticator } from '../gateway-core/pipeline/stages/s0-ingress.js';

function makeStaticAuth(expectedToken: string, keyId: string): Authenticator {
  return {
    async authenticate(req) {
      const auth = req.headers['authorization'] ?? '';
      if (auth === `Bearer ${expectedToken}`) {
        return { ok: true, key_id: keyId, via: 'bearer' };
      }
      return {
        ok: false,
        error: {
          code: 'auth_failed',
          http_status: 401,
          message: 'unauthorized',
          retryable: false,
          source: 'gateway',
          request_id: 'test',
        },
      };
    },
  };
}

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('GET /v1/schema, /v1/openapi.json & Chat-to-Images Bridge', () => {
  it('serves /v1/schema, /v1/schema/{id}, /v1/schema?model=..., and /v1/openapi.json behind data-plane auth', async () => {
    const gw = createGateway({ mode: 'test' });
    const capabilities = [
      {
        access_path: 'opencode-go.openai-chat',
        model: 'jev-1.14',
        modality: 'decision' as const,
        format: 'jev.decisions' as const,
        usage_source: 'provider' as const,
        usage_units: ['tokens' as const, 'questions' as const],
        quirks: [],
        contract_tested: false,
        status: 'implemented' as const,
      },
      {
        access_path: 'openai.images',
        model: 'gpt-image-1',
        modality: 'image' as const,
        format: 'openai.images.generations' as const,
        usage_source: 'provider' as const,
        usage_units: ['images' as const],
        quirks: [],
        contract_tested: false,
        status: 'implemented' as const,
      },
    ];
    const schema = createSchemaEndpoints({
      listCapabilities: () => capabilities,
      aliasResolver: {
        resolve(model, modality) {
          if (model === 'oc/jev-1.14' && modality === 'decision') {
            return {
              source: 'namespace',
              target: { provider: 'opencode-go', access_path: 'opencode-go.openai-chat', model: 'jev-1.14' },
            };
          }
          if (model === 'img/gpt-image-1' && modality === 'image') {
            return {
              source: 'namespace',
              target: { provider: 'openai', access_path: 'openai.images', model: 'gpt-image-1' },
            };
          }
          return undefined;
        },
      },
      chatImageBridgeEnabled: true,
    });

    const auth = makeStaticAuth('sk-ag-test-token', 'vk_test');
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gw.runner,
      authenticator: auth,
      schema,
    });
    servers.push(server);
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('unexpected address');
    const base = `http://127.0.0.1:${addr.port}`;
    const headers = { authorization: 'Bearer sk-ag-test-token' };

    // 1. Deny-first auth check
    const unauth = await fetch(`${base}/v1/schema`);
    expect(unauth.status).toBe(401);

    // 2. Overview
    const overviewRes = await fetch(`${base}/v1/schema`, { headers });
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      schema_version: string;
      openapi_url: string;
      endpoints: Array<{ id: string; available: boolean }>;
      mappings: Array<{ id: string; kind: string }>;
    };
    expect(overview.schema_version).toBe('ag-surface/1');
    expect(overview.openapi_url).toBe('/v1/openapi.json');
    expect(overview.endpoints.find((e) => e.id === 'decisions')?.available).toBe(true);
    expect(overview.endpoints.find((e) => e.id === 'images.generations')?.available).toBe(true);
    expect(overview.mappings.some((m) => m.id === 'openai.chat->openai.images' && m.kind === 'modality_bridge')).toBe(
      true,
    );

    // 3. Detail
    const detailRes = await fetch(`${base}/v1/schema/decisions`, { headers });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      id: string;
      request_schema: Record<string, unknown>;
      mappings: Array<{ id: string }>;
    };
    expect(detail.id).toBe('decisions');
    expect(detail.request_schema['type']).toBe('object');
    expect(detail.mappings.some((m) => m.id === 'decisions->jev.decisions')).toBe(true);

    // 4. Unknown detail -> 404
    const notFound = await fetch(`${base}/v1/schema/nonexistent`, { headers });
    expect(notFound.status).toBe(404);

    // 5. Model lookup: decision model
    const decLookupRes = await fetch(`${base}/v1/schema?model=oc/jev-1.14`, { headers });
    expect(decLookupRes.status).toBe(200);
    const decLookup = (await decLookupRes.json()) as {
      found: boolean;
      recommended_endpoint: { id: string; path: string };
    };
    expect(decLookup.found).toBe(true);
    expect(decLookup.recommended_endpoint).toMatchObject({ id: 'decisions', path: '/v1/decisions' });

    // 6. Model lookup: image model (shows both /v1/images/generations and bridged /v1/chat/completions)
    const imgLookupRes = await fetch(`${base}/v1/schema?model=img/gpt-image-1`, { headers });
    expect(imgLookupRes.status).toBe(200);
    const imgLookup = (await imgLookupRes.json()) as {
      found: boolean;
      recommended_endpoint: { id: string; path: string };
      supported_endpoints: Array<{ id: string; bridge?: boolean }>;
    };
    expect(imgLookup.found).toBe(true);
    expect(imgLookup.recommended_endpoint.id).toBe('images.generations');
    expect(imgLookup.supported_endpoints.find((e) => e.id === 'openai.chat')?.bridge).toBe(true);

    // 7. OpenAPI 3.1.0
    const oaRes = await fetch(`${base}/v1/openapi.json`, { headers });
    expect(oaRes.status).toBe(200);
    const oa = (await oaRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      'x-ag-mappings': unknown[];
    };
    expect(oa.openapi).toBe('3.1.0');
    expect(oa.paths['/v1/chat/completions']).toBeDefined();
    expect(oa.paths['/v1/decisions']).toBeDefined();
    expect(oa.paths['/v1/schema']).toBeDefined();
    expect(oa['x-ag-mappings'].length).toBeGreaterThan(0);

    await gw.shutdown();
  });

  it('bridges POST /v1/chat/completions to Images API for image-only models (both non-stream and stream)', async () => {
    const gw = createGateway({ mode: 'test' });
    const generatedPrompts: Array<{ model: string; prompt: string; size?: { width: number; height: number } }> = [];
    const fakeImagesAdaptor: ImageProviderAdaptor = {
      provider: 'openai',
      access_path: 'openai.images',
      async generate(req) {
        const p = req.payload as { prompt: string; size?: { width: number; height: number } };
        generatedPrompts.push({
          model: req.resolved_model ?? req.model,
          prompt: p.prompt,
          ...(p.size === undefined ? {} : { size: p.size }),
        });
        const response: CanonicalResponseEnvelope = {
          ir_version: IR_VERSION,
          kind: 'image',
          request_id: 'req_img_1',
          usage: {
            units: { images: { generated: 1, edited: 0 } },
            source: 'provider',
          },
          finish_reason: 'stop',
          payload: {
            images: [
              {
                image: { kind: 'inline', mime: 'image/png', data: 'iVBORw0KGgo=' },
                revised_prompt: 'A neon cat',
              },
            ],
          },
          warnings: [],
          raw: {},
        };
        return { response, httpStatus: 200 };
      },
      async edit() {
        throw new Error('not used');
      },
    };

    const records: UsageRecord[] = [];
    const emitter: UsageEmitter = {
      emit(record) {
        records.push(record);
      },
      async flush() {},
    };
    const bridge = createChatImageBridge({
      imagesAdaptor: fakeImagesAdaptor,
      resolveTarget: () => ({ baseUrl: 'https://example.invalid' }),
      aliasResolver: {
        resolve(model, modality) {
          if (model === 'img/gpt-image-1' && modality === 'image') {
            return {
              source: 'namespace',
              target: { provider: 'openai', access_path: 'openai.images', model: 'gpt-image-1' },
            };
          }
          return undefined;
        },
      },
      usageEmitter: emitter,
      clock: { now: () => 1_760_000_000_000 },
      ids: {
        requestId: () => 'id_1',
        traceId: () => 'tr_1',
        spanId: () => 'sp_1',
      },
    });

    const auth = makeStaticAuth('sk-ag-test-token', 'vk_img');
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gw.runner,
      authenticator: auth,
      chatImageBridge: bridge,
    });
    servers.push(server);
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('unexpected address');
    const base = `http://127.0.0.1:${addr.port}`;
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer sk-ag-test-token',
    };

    // 1. Non-stream bridged chat completion
    const res1 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'img/gpt-image-1',
        messages: [
          { role: 'system', content: 'Minimalist vector art' },
          { role: 'user', content: 'Draw a cat' },
        ],
        size: '1024x1024',
      }),
    });
    expect(res1.status).toBe(200);
    const json1 = (await res1.json()) as {
      object: string;
      model: string;
      choices: Array<{
        message: {
          content: string;
          images?: Array<{ type: string; image_url: { url: string } }>;
        };
      }>;
    };
    expect(json1.object).toBe('chat.completion');
    expect(json1.model).toBe('img/gpt-image-1');
    expect(json1.choices[0]!.message.content).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(json1.choices[0]!.message.images?.[0]?.image_url.url).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
    expect(generatedPrompts[0]).toEqual({
      model: 'gpt-image-1',
      prompt: 'Minimalist vector art\n\nDraw a cat',
      size: { width: 1024, height: 1024 },
    });

    // 2. Streaming bridged chat completion
    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'img/gpt-image-1',
        messages: [{ role: 'user', content: 'Draw a dog' }],
        stream: true,
      }),
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('content-type')).toContain('text/event-stream');
    const sseText = await res2.text();
    expect(sseText).toContain('"object":"chat.completion.chunk"');
    expect(sseText).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(sseText).toContain('data: [DONE]');

    await emitter.flush();
    expect(records).toHaveLength(2);
    expect(records[0]!.warnings).toContain('bridge:openai.chat->images.generations');

    await gw.shutdown();
  });

  it('accepts simplified /v1/decisions payloads and returns centralized endpoint guidance on protocol mismatch', async () => {
    const gw = createGateway({ mode: 'test' });
    const guard = createModalityMismatchGuard({
      aliasResolver: {
        resolve(model, modality) {
          if (model === 'oc/jev-1.14' && modality === 'decision') {
            return {
              source: 'namespace',
              target: { provider: 'opencode-go', access_path: 'opencode-go.openai-chat', model: 'jev-1.14' },
            };
          }
          if (model === 'oc/gemini-embedding-2' && modality === 'embedding') {
            return {
              source: 'namespace',
              target: {
                provider: 'opencode-go',
                access_path: 'opencode-go.openai-chat',
                model: 'gemini-embedding-2',
              },
            };
          }
          return undefined;
        },
      },
    });

    const auth = makeStaticAuth('sk-ag-test-token', 'vk_test');
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gw.runner,
      authenticator: auth,
      modalities: gw.modalityEndpoints,
      modalityMismatchGuard: guard,
    });
    servers.push(server);
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('unexpected address');
    const base = `http://127.0.0.1:${addr.port}`;
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer sk-ag-test-token',
    };

    // 1. Simplified flat /v1/decisions (no ir_version / kind / source_format / payload wrapper)
    const decRes = await fetch(`${base}/v1/decisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'oc/jev-1.14',
        content: 'User asks to summarize an article.',
        questions: [{ id: 'is_safe', type: 'binary', prompt: 'Is this safe?' }],
      }),
    });
    expect(decRes.status).toBe(200);
    const decJson = (await decRes.json()) as { kind: string; payload: { answers: unknown[] } };
    expect(decJson.kind).toBe('decision');
    expect(decJson.payload.answers).toHaveLength(1);

    // 2. Sending decision model to /v1/chat/completions -> 400 with exact endpoint + schema guidance
    const misDec = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'oc/jev-1.14',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(misDec.status).toBe(400);
    const misDecJson = (await misDec.json()) as {
      error: { message: string; code: string; recommended_endpoint: string; schema_ref: string };
    };
    expect(misDecJson.error.code).toBe('capability_unsupported');
    expect(misDecJson.error.message).toContain('Please use POST /v1/decisions (see GET /v1/schema/decisions)');
    expect(misDecJson.error.recommended_endpoint).toBe('POST /v1/decisions');
    expect(misDecJson.error.schema_ref).toBe('/v1/schema/decisions');

    // 3. Sending embedding model to /v1/chat/completions -> 400 with embedding endpoint guidance
    const misEmb = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'oc/gemini-embedding-2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(misEmb.status).toBe(400);
    const misEmbJson = (await misEmb.json()) as { error: { message: string } };
    expect(misEmbJson.error.message).toContain(
      'Please use POST /v1/embeddings (see GET /v1/schema/openai.embeddings)',
    );

    await gw.shutdown();
  });

  it('rejects Chat -> Images bridge with guidance when crossModalityBridge setting is disabled', async () => {
    const gw = createGateway({ mode: 'test' });
    let bridgeEnabled = false;
    const fakeImagesAdaptor: ImageProviderAdaptor = {
      provider: 'openai',
      access_path: 'openai.images',
      async generate() {
        throw new Error('should not be called when bridge is disabled');
      },
      async edit() {
        throw new Error('not used');
      },
    };
    const resolver = {
      resolve(model: string, modality: string) {
        if (model === 'img/gpt-image-1' && modality === 'image') {
          return {
            source: 'namespace',
            target: { provider: 'openai', access_path: 'openai.images', model: 'gpt-image-1' },
          };
        }
        return undefined;
      },
    };
    const bridge = createChatImageBridge({
      imagesAdaptor: fakeImagesAdaptor,
      resolveTarget: () => ({}),
      aliasResolver: resolver,
      usageEmitter: { emit() {}, async flush() {} },
      clock: { now: () => 1_760_000_000_000 },
      ids: { requestId: () => 'r1', traceId: () => 't1', spanId: () => 's1' },
      enabled: () => bridgeEnabled,
    });
    const guard = createModalityMismatchGuard({ aliasResolver: resolver });
    const schema = createSchemaEndpoints({
      aliasResolver: resolver,
      chatImageBridgeEnabled: () => bridgeEnabled,
    });

    const auth = makeStaticAuth('sk-ag-test-token', 'vk_test');
    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gw.runner,
      authenticator: auth,
      schema,
      chatImageBridge: bridge,
      modalityMismatchGuard: guard,
    });
    servers.push(server);
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('unexpected address');
    const base = `http://127.0.0.1:${addr.port}`;
    const headers = {
      'content-type': 'application/json',
      authorization: 'Bearer sk-ag-test-token',
    };

    // Bridge disabled -> 400 with recommended_endpoint = POST /v1/images/generations
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'img/gpt-image-1',
        messages: [{ role: 'user', content: 'draw a cat' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { message: string; recommended_endpoint: string; schema_ref: string };
    };
    expect(body.error.message).toContain(
      'Please use POST /v1/images/generations (see GET /v1/schema/images.generations)',
    );
    expect(body.error.recommended_endpoint).toBe('POST /v1/images/generations');

    // /v1/schema dynamically omits the bridge mapping when disabled
    const schemaOff = (await (await fetch(`${base}/v1/schema`, { headers })).json()) as {
      mappings: Array<{ id: string }>;
    };
    expect(schemaOff.mappings.some((m) => m.id === 'openai.chat->openai.images')).toBe(false);

    // Toggle on dynamically -> /v1/schema includes the bridge mapping immediately
    bridgeEnabled = true;
    const schemaOn = (await (await fetch(`${base}/v1/schema`, { headers })).json()) as {
      mappings: Array<{ id: string }>;
    };
    expect(schemaOn.mappings.some((m) => m.id === 'openai.chat->openai.images')).toBe(true);

    await gw.shutdown();
  });
});
