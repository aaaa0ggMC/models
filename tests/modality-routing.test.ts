import { describe, expect, it } from 'vitest';
import { createGateway } from '../composition-root.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { DefaultEncryptedRecordStore, InMemoryRawRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { startHttpServer } from '../http/server.js';
import type { RequestContext } from '../ir/index.js';

async function makeStore() {
  const ks = new Keystore(new PassphraseKekSource(), undefined, 1_760_000_000_000);
  await ks.unlock('modality-routing-test-passphrase');
  return new DefaultEncryptedRecordStore(ks.unlocked(), new InMemoryRawRecordStore(), {
    now: () => 1_760_000_000_000,
  });
}

function fakeCtx(headers: Record<string, string> = {}): RequestContext {
  return {
    request_id: 'req-hint-1',
    trace_id: 'trace-hint-1',
    client_raw_headers: headers,
  } as unknown as RequestContext;
}

describe('通用多模态动态路由 & 声明式 transport_hints', () => {
  it('POST /v1/images/generations 按 AliasResolver 动态路由 xAI grok-imagine-image-2.0（含 namespace）', async () => {
    const transport = new ScriptedTransport([
      {
        status: 200,
        body: JSON.stringify({
          created: 1794927000,
          data: [{ b64_json: 'iVBORw0KGgo=' }],
        }),
      },
    ]);
    const gateway = createGateway({
      mode: 'test',
      config: { accessToken: 'test-data-plane-token' },
      transport,
      recordStore: await makeStore(),
      credentialResolver: new EnvCredentialResolver(
        undefined,
        undefined,
        { AG_XAI_OPENAI_RESPONSES_API_KEY: 'xai-fake-key-for-test' },
        {},
        { autoRegisterEnv: true },
      ),
    });

    const upsertRes = await gateway.admin!.adminService.upsertProvider('owner', {
      id: 'xai',
      label: 'xAI Grok',
      dialect: 'openai.responses',
      base_url: 'https://api.x.ai/v1',
      namespace: 'xai',
      model_source: { kind: 'static', models: ['grok-4.7', 'grok-imagine-image-2.0'] },
    });
    expect(upsertRes.ok).toBe(true);

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      modalities: gateway.modalityEndpoints,
      authenticator: gateway.dataPlaneAuth,
    });
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-data-plane-token',
        },
        body: JSON.stringify({
          model: 'xai/grok-imagine-image-2.0',
          prompt: 'a futuristic city',
        }),
      });
      expect(res.status).toBe(200);
      expect(transport.requests).toHaveLength(1);
      expect(transport.requests[0]!.base_url).toBe('https://api.x.ai/v1');
      expect(transport.requests[0]!.path).toBe('/v1/images/generations');
      expect(transport.requests[0]!.headers['authorization']).toBe('Bearer xai-fake-key-for-test');
      const sentBody = JSON.parse((transport.requests[0]!.body ?? Buffer.alloc(0)).toString('utf8'));
      expect(sentBody.model).toBe('grok-imagine-image-2.0');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await gateway.shutdown();
    }
  });


  it('POST /v1/responses 传 system prompt 调 xai/grok-imagine-image-2.0 → 自动桥接生图并返回不支持上下文提示 + 图片', async () => {
    const transport = new ScriptedTransport([
      {
        status: 200,
        body: JSON.stringify({
          created: 1794927000,
          data: [{ url: 'https://img.example.com/gen.png', revised_prompt: 'a cute cat' }],
        }),
      },
    ]);
    const gateway = createGateway({
      mode: 'test',
      config: { accessToken: 'test-data-plane-token' },
      transport,
      recordStore: await makeStore(),
      credentialResolver: new EnvCredentialResolver(
        undefined,
        undefined,
        { AG_XAI_OPENAI_RESPONSES_API_KEY: 'xai-fake-key-for-test' },
        {},
        { autoRegisterEnv: true },
      ),
    });

    await gateway.admin!.adminService.upsertProvider('owner', {
      id: 'xai',
      label: 'xAI Grok',
      dialect: 'openai.responses',
      base_url: 'https://api.x.ai/v1',
      namespace: 'xai',
      model_source: { kind: 'static', models: ['grok-4.7', 'grok-imagine-image-2.0'] },
    });

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      modalities: gateway.modalityEndpoints,
      authenticator: gateway.dataPlaneAuth,
    });
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-data-plane-token',
        },
        body: JSON.stringify({
          model: 'xai/grok-imagine-image-2.0',
          instructions: 'You are an artist',
          input: 'draw a cute cat',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        output?: Array<{ content?: Array<{ text?: string }> }>;
      };
      const text = body.output?.[0]?.content?.[0]?.text ?? '';
      expect(text).toContain('does not support system prompt or multi-turn context');
      expect(text).toContain('![generated](https://img.example.com/gen.png)');
      expect(transport.requests[0]!.base_url).toBe('https://api.x.ai/v1');
      expect(transport.requests[0]!.path).toBe('/v1/images/generations');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await gateway.shutdown();
    }
  });


  it('POST /v1/responses 流式转 openai.chat 上游返回 tool_calls → 正确发出 function_call SSE 事件', async () => {
    const sseChunks = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"BJ\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const transport = new ScriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: sseChunks,
      },
    ]);
    const gateway = createGateway({
      mode: 'test',
      config: { accessToken: 'test-data-plane-token' },
      transport,
      recordStore: await makeStore(),
      credentialResolver: new EnvCredentialResolver(
        undefined,
        undefined,
        { AG_OPENCODE_OPENAI_CHAT_API_KEY: 'oc-fake-key' },
        {},
        { autoRegisterEnv: true },
      ),
    });

    await gateway.admin!.adminService.upsertProvider('owner', {
      id: 'opencode',
      label: 'OpenCode',
      dialect: 'openai.chat',
      base_url: 'https://opencode.ai/zen/go/v1',
      model_source: { kind: 'static', models: ['m1'] },
    });

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      modalities: gateway.modalityEndpoints,
      authenticator: gateway.dataPlaneAuth,
    });
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-data-plane-token',
        },
        body: JSON.stringify({
          model: 'm1',
          stream: true,
          input: 'weather in BJ',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const sseText = await res.text();
      expect(sseText).toContain('response.output_item.added');
      expect(sseText).toContain('"type":"function_call"');
      expect(sseText).toContain('"name":"get_weather"');
      expect(sseText).toContain('response.function_call_arguments.delta');
      expect(sseText).toContain('response.function_call_arguments.done');
      expect(sseText).toContain('response.output_item.done');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await gateway.shutdown();
    }
  });

  it('openai.responses 流式先文本后 tool_call（同 index=0）与非流式 tool_call 均正确编码为 function_call', async () => {
    const sseChunks = [
      'data: {"id":"chatcmpl-s2","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"Checking..."},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s2","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_s_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s2","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"SH\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-s2","object":"chat.completion.chunk","model":"m1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const transport = new ScriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'chatcmpl-nonstream-1',
          object: 'chat.completion',
          model: 'm1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Checking weather...',
                tool_calls: [
                  {
                    id: 'call_ns_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"BJ"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }),
      },
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: sseChunks,
      },
    ]);

    const gateway = createGateway({
      mode: 'test',
      config: { accessToken: 'test-data-plane-token' },
      transport,
      recordStore: await makeStore(),
      credentialResolver: new EnvCredentialResolver(
        undefined,
        undefined,
        { AG_OPENCODE_OPENAI_CHAT_API_KEY: 'oc-fake-key' },
        {},
        { autoRegisterEnv: true },
      ),
    });

    await gateway.admin!.adminService.upsertProvider('owner', {
      id: 'opencode',
      label: 'OpenCode',
      dialect: 'openai.chat',
      base_url: 'https://opencode.ai/zen/go/v1',
      model_source: { kind: 'static', models: ['m1'] },
    });

    const server = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      modalities: gateway.modalityEndpoints,
      authenticator: gateway.dataPlaneAuth,
    });
    const addr = server.address() as { port: number };

    try {
      // 1. 非流式
      const nsRes = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-data-plane-token',
        },
        body: JSON.stringify({
          model: 'm1',
          stream: false,
          input: 'weather in BJ',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        }),
      });
      expect(nsRes.status).toBe(200);
      const nsJson = (await nsRes.json()) as {
        output: Array<{ type: string; call_id?: string; name?: string; arguments?: string }>;
      };
      expect(nsJson.output.some((item) => item.type === 'message')).toBe(true);
      const fc = nsJson.output.find((item) => item.type === 'function_call');
      expect(fc).toMatchObject({
        type: 'function_call',
        call_id: 'call_ns_1',
        name: 'get_weather',
        arguments: '{"city":"BJ"}',
      });

      // 2. 流式（先文本后 tool_call，同 index=0）
      const sRes = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-data-plane-token',
        },
        body: JSON.stringify({
          model: 'm1',
          stream: true,
          input: 'weather in SH',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        }),
      });
      expect(sRes.status).toBe(200);
      const sseText = await sRes.text();
      const events = sseText
        .split('\n\n')
        .map((block) => {
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) return undefined;
          try {
            return JSON.parse(dataLine.slice(6)) as {
              type: string;
              output_index?: number;
              item?: { type?: string };
            };
          } catch {
            return undefined;
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== undefined);

      const addedMessage = events.find(
        (e) => e.type === 'response.output_item.added' && e.item?.type === 'message',
      );
      const addedFn = events.find(
        (e) => e.type === 'response.output_item.added' && e.item?.type === 'function_call',
      );
      const fnArgsDelta = events.find((e) => e.type === 'response.function_call_arguments.delta');
      const fnArgsDone = events.find((e) => e.type === 'response.function_call_arguments.done');
      expect(addedMessage?.output_index).toBe(0);
      expect(addedFn?.output_index).toBe(1);
      expect(fnArgsDelta?.output_index).toBe(1);
      expect(fnArgsDone?.output_index).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await gateway.shutdown();
    }
  });

  it('EnvCredentialResolver 按声明式 transport_hints 注入 extra_headers 与 session_header', async () => {
    const resolver = new EnvCredentialResolver([], undefined, {}, {}, { autoRegisterEnv: false });
    resolver.registerAccessPath({
      id: 'custom.openai-chat',
      label: 'Custom',
      format: 'openai.chat',
      base_url: 'https://custom.example.com/v1',
      usage_source: 'provider',
      model_namespaces: ['custom'],
      requires_credential: true,
      transport_hints: {
        extra_headers: { 'x-custom-beta': 'v1' },
        session_header: 'x-session-token',
      },
    });
    resolver.registerCredential(
      {
        id: 'cred-custom-1',
        name: 'custom-1',
        access_path: 'custom.openai-chat',
        model_namespace: 'custom',
        type: 'api_key',
        storage: { location: 'vault', ref: 'cred:cred-custom-1', encrypted: true },
        health: { status: 'healthy' },
        priority: 0,
        enabled: true,
      },
      'sk-custom-test', // privacy-scan: ignore —— 测试假 key
    );

    const resolved = await resolver.headersFor('custom.openai-chat', fakeCtx());
    expect(resolved.headers['authorization']).toBe('Bearer sk-custom-test');
    expect(resolved.headers['x-custom-beta']).toBe('v1');
    expect(resolved.headers['x-session-token']).toBe('trace-hint-1');
  });
});
