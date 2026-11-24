/**
 * adaptors/gemini-generate-content/codec.test.ts —— Gemini generateContent codec 契约、往返、
 * 跨格式互转与全链路 Pipeline 集成测试。
 */

import { describe, it, expect } from 'vitest';
import {
  GeminiGenerateContentCodec,
  geminiGenerateContentAdaptorMeta,
  parseGeminiPath,
  buildGeminiPath,
} from './index.js';
import { OpenAIChatCodec } from '../openai-chat/index.js';
import { createAdaptorRegistry } from '../index.js';
import {
  CTX_STATE_KEYS,
  type CanonicalRequestEnvelope,
  type ChatPayload,
  type ChatResponsePayload,
  type Clock,
  type RequestContext,
  type StreamFrame,
} from '../../ir/index.js';
import { createGateway } from '../../composition-root.js';
import { MemoryClientSink } from '../../gateway-core/pipeline/sink.js';
import { EnvCredentialResolver } from '../../credentials/resolver.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';

const fixedClock = (ms = 1_700_000_000_000): Clock => ({ now: () => ms });

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  const warnings: string[] = [];
  return {
    request_id: 'req_gemini_test',
    started_at: 1_700_000_000_000,
    deadline: 1_700_000_060_000,
    client_format: 'gemini.generateContent',
    client_raw_headers: {},
    auth: { key_id: 'test-key' },
    route: {
      access_path: 'gemini.generateContent',
      provider: 'gemini',
      provider_format: 'gemini.generateContent',
      model: 'gemini-2.5-pro',
      full_model_id: 'gemini.generateContent/gemini-2.5-pro',
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'gemini.generateContent',
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath() {},
    warn(code: string) {
      warnings.push(code);
    },
    ...overrides,
  };
}

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('GeminiGenerateContentCodec · 路径与元数据', () => {
  it('meta 状态为 implemented 且支持惰性解码', () => {
    const meta = geminiGenerateContentAdaptorMeta();
    expect(meta.format).toBe('gemini.generateContent');
    expect(meta.modality).toBe('chat');
    expect(meta.status).toBe('implemented');
    expect(meta.supports_lazy_decode).toBe(true);
  });

  it('parseGeminiPath 解析 v1beta/v1、generateContent/streamGenerateContent 与 query', () => {
    expect(parseGeminiPath('/v1beta/models/gemini-2.5-pro:generateContent')).toEqual({
      model: 'gemini-2.5-pro',
      stream: false,
    });
    expect(
      parseGeminiPath('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'),
    ).toEqual({
      model: 'gemini-2.5-flash',
      stream: true,
    });
    expect(parseGeminiPath('/v1/models/gemini-2.0-flash:generateContent')).toEqual({
      model: 'gemini-2.0-flash',
      stream: false,
    });
    expect(parseGeminiPath('/v1/chat/completions')).toBeUndefined();
  });

  it('buildGeminiPath 剥离重复 models/ 前缀并拼接流式参数', () => {
    expect(buildGeminiPath('gemini-2.5-pro', false)).toBe(
      '/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(buildGeminiPath('models/gemini-2.5-flash', true)).toBe(
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
    );
  });

  it('decodeEnvelope 从 REQUEST_PATH 提取 model/stream 并保留 unmapped', () => {
    const codec = new GeminiGenerateContentCodec({ clock: fixedClock(1_700_000_000_000) });
    const ctx = makeCtx({
      state: { [CTX_STATE_KEYS.REQUEST_PATH]: '/v1beta/models/gemini-2.5-pro:streamGenerateContent' },
    });
    const shallow = codec.decodeEnvelope(
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], customExtra: 42 },
      ctx,
    );
    expect(shallow.model).toBe('gemini-2.5-pro');
    expect(shallow.stream).toBe(true);
    expect(shallow.usage_locations).toEqual(['usageMetadata']);
    expect(shallow.unmapped).toEqual({ customExtra: 42 });
    expect(shallow.default_path).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  });
});

describe('GeminiGenerateContentCodec · 请求双向转换与往返', () => {
  const codec = new GeminiGenerateContentCodec({ clock: fixedClock(1_700_000_000_000) });

  it('systemInstruction / contents / tools / toolConfig / generationConfig / safetySettings 完整往返', () => {
    const ctx = makeCtx({
      state: { [CTX_STATE_KEYS.REQUEST_PATH]: '/v1beta/models/gemini-2.5-pro:generateContent' },
    });
    const rawReq = {
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      cachedContent: 'cachedContents/abc123',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Check weather' },
            { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
        {
          role: 'model',
          parts: [
            { text: 'Let me think...', thought: true, thoughtSignature: 'sig-1' },
            {
              functionCall: { id: 'fc_1', name: 'get_weather', args: { city: 'Beijing' } },
              thoughtSignature: 'sig-fc-1',
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'fc_1',
                name: 'get_weather',
                response: { temp: 22, unit: 'C' },
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get city weather',
              parameters: {
                type: 'OBJECT',
                properties: { city: { type: 'STRING' } },
                required: ['city'],
              },
            },
          ],
        },
        { googleSearch: {} },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['get_weather'],
        },
      },
      generationConfig: {
        temperature: 0.3,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 1024,
        stopSequences: ['END'],
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
      },
      safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }],
      customTopLevel: 'keep-me',
    };

    const canonical = codec.decode(rawReq, ctx);
    const payload = canonical.payload as ChatPayload;
    expect(canonical.model).toBe('gemini-2.5-pro');
    expect(payload.system?.[0]?.text).toBe('You are helpful.');
    expect(payload.system?.[0]?.cache_control?.cache_name).toBe('cachedContents/abc123');
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0]?.parts[1]?.type).toBe('image');
    expect(payload.messages[1]?.role).toBe('assistant');
    expect(payload.messages[1]?.parts[0]).toMatchObject({
      type: 'thinking',
      thinking: 'Let me think...',
      signature: 'sig-1',
    });
    expect(payload.messages[1]?.parts[1]).toMatchObject({
      type: 'tool_use',
      id: 'fc_1',
      name: 'get_weather',
      input: { city: 'Beijing' },
    });
    expect(payload.messages[2]?.role).toBe('tool');
    expect(payload.messages[2]?.parts[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'fc_1',
    });
    expect(payload.tools).toHaveLength(2);
    expect(payload.tools?.[0]).toMatchObject({
      type: 'function',
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    });
    expect(payload.tools?.[1]).toMatchObject({ type: 'builtin', name: 'web_search' });
    expect(payload.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    expect(payload.params?.thinking).toEqual({
      enabled: true,
      budget_tokens: 4096,
      include_summary: true,
    });
    expect(canonical.raw.unmapped).toEqual({ customTopLevel: 'keep-me' });

    const encoded = codec.encode(canonical, ctx);
    expect(encoded.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    const body = encoded.body as Record<string, unknown>;
    expect(body['cachedContent']).toBe('cachedContents/abc123');
    expect(body['customTopLevel']).toBe('keep-me');
    const modelTurn = (body['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>)[1];
    expect(modelTurn?.parts[0]?.['thoughtSignature']).toBe('sig-1');
    expect(modelTurn?.parts[1]?.['thoughtSignature']).toBe('sig-fc-1');
    const genCfg = body['generationConfig'] as Record<string, unknown>;
    expect(genCfg['thinkingConfig']).toEqual({ thinkingBudget: 4096, includeThoughts: true });
  });

  it('Gemini 3+ effort 映射到 thinkingLevel 且绝不与 thinkingBudget 混传', () => {
    const ctx = makeCtx();
    const req: CanonicalRequestEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      model: 'gemini-3-pro',
      resolved_model: 'gemini-3-pro',
      source_format: 'openai.chat',
      raw: {},
      payload: {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Solve this' }] }],
        params: {
          thinking: { enabled: true, effort: 'high', include_summary: true },
          parallel_tool_calls: false,
        },
      },
    };
    const encoded = codec.encode(req, ctx);
    const genCfg = (encoded.body as Record<string, unknown>)['generationConfig'] as Record<string, unknown>;
    const tc = genCfg['thinkingConfig'] as Record<string, unknown>;
    expect(tc['thinkingLevel']).toBe('HIGH');
    expect(tc['thinkingBudget']).toBeUndefined();
    expect(encoded.dropped).toContain('params.parallel_tool_calls');
  });

  it('清理 OpenAI 工具 schema 中的 $schema 和 additionalProperties', () => {
    const ctx = makeCtx();
    const req: CanonicalRequestEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      model: 'gemini-2.5-flash',
      resolved_model: 'gemini-2.5-flash',
      source_format: 'openai.chat',
      raw: {},
      payload: {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        tools: [
          {
            type: 'function',
            name: 'search',
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              additionalProperties: false,
              properties: { q: { type: 'string' } },
            },
          },
        ],
      },
    };
    const encoded = codec.encode(req, ctx);
    const tools = (encoded.body as Record<string, unknown>)['tools'] as Array<{
      functionDeclarations?: Array<{ parameters?: Record<string, unknown> }>;
    }>;
    const params = tools[0]?.functionDeclarations?.[0]?.parameters;
    expect(params?.['$schema']).toBeUndefined();
    expect(params?.['additionalProperties']).toBeUndefined();
    expect(params?.['type']).toBe('object');
  });
});

describe('GeminiGenerateContentCodec · 响应、Usage 与 finishReason', () => {
  const codec = new GeminiGenerateContentCodec({ clock: fixedClock(1_700_000_000_000) });

  it('正确抽取 usageMetadata（含 cachedContentTokenCount 与 thoughtsTokenCount I2 校验）', () => {
    // 场景 A：total = prompt + candidates + thoughts（candidates 未含 thoughts → output 应加上 thoughts）
    const u1 = codec.extractUsage({
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        totalTokenCount: 180,
      },
    });
    expect(u1.units.tokens).toMatchObject({
      input_tokens: 100,
      cache_read_tokens: 40,
      output_tokens: 80,
      reasoning_tokens: 30,
      total_tokens: 180,
    });

    // 场景 B：无 usageMetadata → 空 units（绝不伪造 0）
    const u2 = codec.extractUsage({ candidates: [] });
    expect(u2.units.tokens).toBeUndefined();
  });

  it('finishReason 归一：MALFORMED_FUNCTION_CALL → error，未知值 → other + warning', () => {
    expect(codec.normalizeFinishReason('STOP')).toBe('stop');
    expect(codec.normalizeFinishReason('MAX_TOKENS')).toBe('length');
    expect(codec.normalizeFinishReason('SAFETY')).toBe('content_filter');
    expect(codec.normalizeFinishReason('RECITATION')).toBe('recitation');
    expect(codec.normalizeFinishReason('MALFORMED_FUNCTION_CALL')).toBe('error');
    expect(codec.normalizeFinishReason('MISSING_THOUGHT_SIGNATURE')).toBe(
      'missing_thought_signature',
    );
    expect(codec.normalizeFinishReason('SOME_FUTURE_REASON')).toBe('other');

    const res = codec.decodeResponse(
      {
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: 'ok' }] },
            finishReason: 'SOME_FUTURE_REASON',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
      makeCtx(),
    );
    expect(res.finish_reason).toBe('other');
    expect(res.warnings).toContain('unmapped_finish_reason:SOME_FUTURE_REASON');
  });

  it('响应含 functionCall 且 finishReason=STOP 时归一为 tool_use', () => {
    const ctx = makeCtx();
    const res = codec.decodeResponse(
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'calc', args: { x: 2 } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        modelVersion: 'gemini-2.5-flash',
      },
      ctx,
    );
    expect(res.finish_reason).toBe('tool_use');
    const payload = res.payload as ChatResponsePayload;
    expect(payload.message.parts[0]).toMatchObject({
      type: 'tool_use',
      name: 'calc',
      input: { x: 2 },
    });
    expect(res.raw.finish_reason_provider).toBe('STOP');

    // encodeResponse 往返
    const wire = codec.encodeResponse(res, ctx) as Record<string, unknown>;
    expect(wire['modelVersion']).toBe('gemini-2.5-flash');
    expect((wire['candidates'] as Array<Record<string, unknown>>)[0]?.['finishReason']).toBe('STOP');
  });
});

describe('GeminiGenerateContentCodec · 流式解码与编码', () => {
  const codec = new GeminiGenerateContentCodec({ clock: fixedClock(1_700_000_000_000) });

  it('decodeStream 解码 thinking + text + functionCall + usage + end', async () => {
    const ctx = makeCtx();
    async function* sseChunks() {
      yield `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hmm', thought: true }] } }],
        modelVersion: 'gemini-2.5-pro',
      })}`;
      yield `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello ' }] } }],
      })}`;
      yield `data: ${JSON.stringify({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: 'world!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
      })}`;
    }

    const frames = await collectAsync(codec.decodeStream(sseChunks(), ctx));
    expect(frames[0]?.event).toBe('start');
    expect(frames.some((f) => f.event === 'delta' && (f.data as { thinking?: string }).thinking === 'hmm')).toBe(
      true,
    );
    const texts = frames
      .filter((f) => f.event === 'delta' && typeof (f.data as { text?: string }).text === 'string')
      .map((f) => (f.data as { text: string }).text);
    expect(texts.join('')).toBe('Hello world!');
    const end = frames.find((f) => f.event === 'end');
    expect(end?.data).toMatchObject({ finish_reason: 'stop' });
  });

  it('encodeStream 兼容 S8 逐帧调用（含 tool_use 跨帧拼接）', async () => {
    const ctx = makeCtx();
    const frames: StreamFrame[] = [
      {
        event: 'start',
        seq: 0,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { model: 'gemini-2.5-pro', client_format: 'gemini.generateContent', provider_format: 'openai.chat' },
        ts: 1,
      },
      {
        event: 'delta',
        seq: 1,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 0, text: 'Hi' },
        ts: 2,
      },
      {
        event: 'delta',
        seq: 2,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 1,
          phase: 'begin',
          part: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
        },
        ts: 3,
      },
      {
        event: 'delta',
        seq: 3,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 1, tool_input_json: '{"q":"test"}' },
        ts: 4,
      },
      {
        event: 'delta',
        seq: 4,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 1,
          phase: 'end',
          part: { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'test' } },
        },
        ts: 5,
      },
      {
        event: 'end',
        seq: 5,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          finish_reason: 'tool_use',
          usage: {
            units: {
              tokens: {
                input_tokens: 5,
                output_tokens: 7,
                total_tokens: 12,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
              },
            },
            source: 'provider',
          },
        },
        ts: 6,
      },
    ];

    // 模拟 S8ClientEncode：每次只传 1 帧调用 encodeStream
    const wireOut: string[] = [];
    for (const f of frames) {
      async function* one() {
        yield f;
      }
      for await (const chunk of codec.encodeStream(one(), ctx)) {
        wireOut.push(String(chunk));
      }
    }

    expect(wireOut.length).toBe(3); // text + functionCall + final finish/usage
    expect(wireOut[0]).toContain('"text":"Hi"');
    expect(wireOut[1]).toContain('"name":"lookup"');
    expect(wireOut[1]).toContain('"q":"test"');
    expect(wireOut[2]).toContain('"finishReason":"STOP"');
    expect(wireOut[2]).toContain('"promptTokenCount":5');
  });
});

describe('跨格式互转 & 全链路 Pipeline（OpenAI ↔ Gemini、Gemini ↔ Gemini）', () => {
  it('OpenAI Chat 客户端请求经 Pipeline 路由到 Gemini 原生上游（非流式 + 流式）', async () => {
    const clock = fixedClock(1_700_000_000_000);
    const { registry: adaptors } = createAdaptorRegistry({ clock });
    expect(adaptors.find('gemini.generateContent', 'chat')).toBeDefined();

    const captured: UpstreamRequest[] = [];
    const transport: Transport = {
      async send(req: UpstreamRequest): Promise<UpstreamResponse> {
        captured.push(req);
        if (req.stream) {
          const sse =
            `data: ${JSON.stringify({
              candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '你好 Gemini' }] } }],
              modelVersion: 'gemini-2.5-pro',
            })}\n\n` +
            `data: ${JSON.stringify({
              candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 },
            })}\n\n`;
          return {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            chunks: (async function* () {
              yield Buffer.from(sse, 'utf8');
            })(),
          };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify({
              candidates: [
                {
                  index: 0,
                  content: { role: 'model', parts: [{ text: 'Hello from Gemini!' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 6, totalTokenCount: 17 },
              modelVersion: 'gemini-2.5-pro',
            }),
            'utf8',
          ),
        };
      },
    };

    const credentials = new EnvCredentialResolver(undefined, undefined, {
      GEMINI_API_KEY: 'AIza-test-key-placeholder',
    });

    const gw = createGateway({
      mode: 'test',
      clock,
      transport,
      credentialResolver: credentials,
      routeTable: {
        aliases: {
          'gemini-2.5-pro': {
            targets: [{ provider: 'gemini', access_path: 'gemini.generateContent', model: 'gemini-2.5-pro' }],
          },
        },
      },
    });
    const runner = gw.runner;

    // 1) 非流式：OpenAI Chat → Gemini generateContent → OpenAI Chat
    const sink1 = new MemoryClientSink();
    await runner.run(
      {
        client_format: 'openai.chat',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        query: {},
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'gemini-2.5-pro',
            messages: [{ role: 'user', content: 'Say hi' }],
          }),
          'utf8',
        ),
      },
      sink1,
    );

    expect(sink1.startStatus).toBe(200);
    expect(captured[0]?.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(captured[0]?.headers['x-goog-api-key']).toBe('AIza-test-key-placeholder');
    const openaiBody = JSON.parse(sink1.text()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(openaiBody.choices[0]?.message.content).toBe('Hello from Gemini!');
    expect(openaiBody.choices[0]?.finish_reason).toBe('stop');
    expect(openaiBody.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 6,
      total_tokens: 17,
    });

    // 2) 流式：OpenAI Chat → Gemini streamGenerateContent?alt=sse → OpenAI Chat SSE
    const sink2 = new MemoryClientSink();
    await runner.run(
      {
        client_format: 'openai.chat',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        query: {},
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'gemini-2.5-pro',
            stream: true,
            messages: [{ role: 'user', content: 'Say hi' }],
          }),
          'utf8',
        ),
      },
      sink2,
    );

    expect(sink2.startStatus).toBe(200);
    expect(captured[1]?.path).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(sink2.text()).toContain('你好 Gemini');
    expect(sink2.text()).toContain('data: [DONE]');

    // 3) 原生 Gemini 客户端入站 → Gemini 原生上游
    const sink3 = new MemoryClientSink();
    await runner.run(
      {
        client_format: 'gemini.generateContent',
        path: '/v1beta/models/gemini-2.5-pro:generateContent',
        headers: { 'content-type': 'application/json' },
        query: {},
        raw_body: Buffer.from(
          JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Native call' }] }],
          }),
          'utf8',
        ),
      },
      sink3,
    );

    expect(sink3.startStatus).toBe(200);
    expect(captured[2]?.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    const nativeRes = JSON.parse(sink3.text()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    expect(nativeRes.candidates[0]?.content.parts[0]?.text).toBe('Hello from Gemini!');
  });

  it('OpenAI Chat → Gemini → OpenAI Chat codec 级别工具调用互转', () => {
    const clock = fixedClock(1_700_000_000_000);
    const openai = new OpenAIChatCodec({ clock });
    const gemini = new GeminiGenerateContentCodec({ clock });
    const ctx = makeCtx({ client_format: 'openai.chat', provider_format: 'gemini.generateContent' });

    const canonical = openai.decode(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Weather in Tokyo?' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          },
        ],
        tool_choice: 'auto',
      },
      ctx,
    );

    const encoded = gemini.encode(canonical, ctx);
    expect(encoded.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    const gBody = encoded.body as Record<string, unknown>;
    expect(gBody['systemInstruction']).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(gBody['toolConfig']).toEqual({ functionCallingConfig: { mode: 'AUTO' } });

    const gResp = gemini.decodeResponse(
      {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'fc_tokyo', name: 'get_weather', args: { city: 'Tokyo' } } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
      },
      ctx,
    );

    const oResp = openai.encodeResponse(gResp, ctx) as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      }>;
    };
    expect(oResp.choices[0]?.finish_reason).toBe('tool_calls');
    expect(oResp.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      id: 'fc_tokyo',
      function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
    });
  });
});
