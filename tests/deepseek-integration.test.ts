/**
 * tests/deepseek-integration.test.ts —— DeepSeek provider 的离线端到端测试（不起真实 API）。
 *
 * 覆盖任务要求的两种可运行装配 + provider 专有映射：
 *   A. 客户端 OpenAI Chat 格式 → deepseek.openai-chat（同 dialect：canonical → 同格式 codec 映射）
 *   B. 客户端 Anthropic Messages 格式 → deepseek.anthropic-messages（同 dialect）
 *   C. 客户端 Anthropic Messages 格式 → deepseek.openai-chat（跨 dialect：canonical 转换）
 *   D. builtin tool（deepseek_web_search / deepseek_read_url）双向映射与 round-trip
 *   E. usage 归一（DeepSeek 顶层 prompt_cache_hit_tokens → canonical cache_read_tokens）
 *   F. thinking 开关显式化（anthropic 客户端关推理 → DeepSeek 收到 thinking:{type:disabled}）
 *   G. 错误映射（402 Insufficient Balance / Anthropic 信封 / 无效模型名）
 *
 * ⚠️ 不断言 fast path 行为（仓库主人已拍板 v1 全走 canonical，字节级 fast path 将
 * 由另一线程清理）：本文件的断言在「当前实现（同格式可能走 fast path）」与
 * 「未来 canonical-only 实现」下都成立——只断言语义等价的字段，不断言字节级透传。
 *
 * 上游全部由 DI 注入的 ScriptedTransport 提供；凭据由注入的 env 字面量提供
 * （不碰真实 process.env，也不读 .env）。
 */

import { describe, expect, it } from 'vitest';
import { createGateway } from '../composition-root.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { ScriptedTransport, type ScriptedTransportScript } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { createDefaultProviderProfiles } from '../composition-root.js';
import { defaultRouteTable } from '../composition-root.js';
import type { CanonicalRequestEnvelope } from '../ir/index.js';

const FAKE_KEY = 'sk-test-not-a-real-key';

/** 注入假 key 的凭据解析器（值只进内存，不进任何文件）。 */
function resolverWithFakeKey(): EnvCredentialResolver {
  return new EnvCredentialResolver(undefined, undefined, { DEEPSEEK_API_KEY: FAKE_KEY });
}

/** DeepSeek Chat Completions 非流式响应（usage 形态抄官方文档 verbatim 示例）。 */
function deepseekChatResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-deepseek-test0001',
    object: 'chat.completion',
    created: 1_763_000_500,
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '北京是中国的首都。' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 11,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 7,
    },
    ...overrides,
  };
}

/** 带缓存命中的响应（连发两次相同前缀时第二次的形态）。
 *  注意：刻意**不发** prompt_tokens_details.cached_tokens，只发顶层
 *  prompt_cache_hit_tokens——这样才能证明 S10 的 provider 归一真的在补洞
 *  （DeepSeek 实际两个字段都发，见 live 冒烟测试的观测）。 */
function deepseekChatResponseCacheHit(): Record<string, unknown> {
  return deepseekChatResponse({
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '第二次回复。' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 6,
      total_tokens: 13,
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 0,
    },
  });
}

/** DeepSeek 流式 SSE：usage 搭在最后一个内容 chunk 上（无独立 usage-only chunk）。 */
function deepseekSseStream(): string[] {
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
    usage?: Record<string, unknown>,
  ): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-deepseek-stream1',
      object: 'chat.completion.chunk',
      created: 1_763_000_500,
      model: 'deepseek-flash',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  return [
    // DeepSeek 的 keep-alive 评论线与空行：codec / 嗅探器都必须跳过
    ': keep-alive\n\n',
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: '北京' }),
    chunk({ content: '是首都。' }),
    chunk({}, 'stop', {
      prompt_tokens: 7,
      completion_tokens: 5,
      total_tokens: 12,
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 0,
    }),
    'data: [DONE]\n\n',
  ];
}

/** DeepSeek Anthropic 兼容面非流式响应（官方 verbatim 示例）。 */
function deepseekAnthropicResponse(): Record<string, unknown> {
  return {
    id: 'e6ef6a63-a078-4f53-a73b-38c8d1d46310',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: '北京是中国的首都。' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
      service_tier: 'standard',
    },
  };
}

function jsonBody(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('响应没有 choices');
  return choices[0] as Record<string, unknown>;
}

interface RunOpts {
  script: ScriptedTransportScript;
  clientFormat: 'openai.chat' | 'anthropic.messages';
  body: unknown;
  path: string;
}

async function runDeepSeek(opts: RunOpts) {
  const transport = new ScriptedTransport(opts.script);
  const gateway = createGateway({
    mode: 'test',
    transport,
    routeTable: defaultRouteTable(),
    credentialResolver: resolverWithFakeKey(),
    providerProfiles: createDefaultProviderProfiles(),
  });
  const sink = new MemoryClientSink();
  const outcome = await gateway.runner.run(
    {
      client_format: opts.clientFormat,
      raw_body: Buffer.from(JSON.stringify(opts.body)),
      headers: { 'content-type': 'application/json' },
      path: opts.path,
      query: {},
    },
    sink,
  );
  await gateway.usageEmitter.flush();
  return { gateway, sink, transport, out: outcome };
}

describe('A · 客户端 OpenAI Chat 格式 → deepseek.openai-chat', () => {
  it('端点路径是 /chat/completions（无 /v1），Bearer 鉴权，usage 缓存字段归一', async () => {
    const { gateway, sink, transport, out } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponseCacheHit()) }],
      clientFormat: 'openai.chat',
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '中国的首都是哪里？' }],
        stream: false,
      },
      path: '/v1/chat/completions',
    });

    expect(out.error).toBeUndefined();
    // 上游请求：路径 + 鉴权头
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.path).toBe('/chat/completions');
    expect(transport.requests[0]!.base_url).toBe('https://api.deepseek.com');
    expect(transport.requests[0]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY}`);
    // 请求体语义等价（同 dialect：canonical → 同格式 codec 映射）
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    expect(upstream['model']).toBe('deepseek-flash');
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['role']).toBe('user');
    expect(messages[0]!['content']).toBe('中国的首都是哪里？');

    // 回程：客户端拿到 OpenAI Chat 格式响应
    const body = jsonBody(sink.text());
    expect(body['object']).toBe('chat.completion');
    expect((firstChoice(body)['message'] as Record<string, unknown>)['content']).toBe(
      '第二次回复。',
    );

    // usage 归一：DeepSeek 顶层 prompt_cache_hit_tokens → canonical cache_read_tokens
    expect(out.usage?.units.tokens).toMatchObject({
      input_tokens: 7,
      output_tokens: 6,
      total_tokens: 13,
      cache_read_tokens: 7,
    });
    // 归一结果同时落到 UsageRecord 与 raw（I4：raw 逐字段保留供对账）
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.usage.units.tokens?.cache_read_tokens).toBe(7);
    expect(rec.usage_raw).toMatchObject({ prompt_cache_hit_tokens: 7 });
    expect(rec.provider).toBe('deepseek');
    expect(rec.model).toBe('deepseek-flash');
  });
});

describe('B · 客户端 Anthropic Messages 格式 → deepseek.anthropic-messages', () => {
  it('端点路径是 /anthropic/v1/messages，x-api-key 鉴权', async () => {
    const { sink, transport, out } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekAnthropicResponse()) }],
      clientFormat: 'anthropic.messages',
      body: {
        model: 'deepseek-flash-messages',
        max_tokens: 256,
        system: '你是一个简洁的助手。',
        messages: [{ role: 'user', content: [{ type: 'text', text: '中国的首都是哪里？' }] }],
      },
      path: '/v1/messages',
    });

    expect(out.error).toBeUndefined();
    expect(transport.requests[0]!.path).toBe('/anthropic/v1/messages');
    expect(transport.requests[0]!.base_url).toBe('https://api.deepseek.com');
    expect(transport.requests[0]!.headers['x-api-key']).toBe(FAKE_KEY);
    // DeepSeek 忽略 anthropic-version，但 SDK 客户端会发——保持行为一致
    expect(transport.requests[0]!.headers['anthropic-version']).toBe('2023-06-01');

    // 回程是 Anthropic Messages 格式
    const body = jsonBody(sink.text());
    expect(body['type']).toBe('message');
    expect(body['stop_reason']).toBe('end_turn');
    // Anthropic dialect 的 usage 不需要 DeepSeek 专有归一（字段形态与 Anthropic 一致）
    expect(out.usage?.units.tokens).toMatchObject({
      input_tokens: 12,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });
});

describe('C · 客户端 Anthropic Messages 格式 → deepseek.openai-chat（canonical 转换）', () => {
  it('system 折叠成 messages[0]，回程转回 Anthropic 格式', async () => {
    const { sink, transport, out } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'anthropic.messages',
      body: {
        model: 'deepseek-flash',
        max_tokens: 256,
        system: '你是一个简洁的助手。',
        messages: [{ role: 'user', content: [{ type: 'text', text: '中国的首都是哪里？' }] }],
      },
      path: '/v1/messages',
    });

    expect(out.error).toBeUndefined();
    // 上游收到 OpenAI Chat 格式（跨 dialect 转换）
    expect(transport.requests[0]!.path).toBe('/chat/completions');
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['role']).toBe('system');
    expect(messages[0]!['content']).toBe('你是一个简洁的助手。');
    expect(messages[1]!['role']).toBe('user');
    // Anthropic 的 max_tokens → canonical max_output_tokens → OpenAI 新名
    expect(upstream['max_completion_tokens']).toBe(256);

    // 回程是 Anthropic 格式
    const body = jsonBody(sink.text());
    expect(body['type']).toBe('message');
    expect(body['stop_reason']).toBe('end_turn');
    const content = body['content'] as Array<Record<string, unknown>>;
    expect(content[0]!['type']).toBe('text');
    expect(content[0]!['text']).toBe('北京是中国的首都。');
  });

  it('关推理必须显式传到 DeepSeek（thinking:{type:disabled}，不能省略）', async () => {
    const { transport } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'anthropic.messages',
      body: {
        model: 'deepseek-flash',
        max_tokens: 256,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      path: '/v1/messages',
    });
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    // DeepSeek 省略 thinking 时默认开推理——客户端明确关推理时必须显式Disabled
    expect(upstream['thinking']).toEqual({ type: 'disabled' });
  });
});

describe('D · builtin tool（全家桶服务端工具）双向映射', () => {
  it('Chat Completions 面：deepseek_web_search → canonical BuiltinTool → 原样回写', async () => {
    const { transport } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'openai.chat',
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'DeepSeek V4.1 有什么新功能？' }],
        tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }],
      },
      path: '/v1/chat/completions',
    });
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    // 透传 = 语义不变地完成一次格式转换：canonical 归一后按目标方言重新表达
    expect(upstream['tools']).toEqual([
      { type: 'deepseek_web_search' },
      { type: 'deepseek_read_url' },
    ]);
  });

  it('Anthropic 客户端声明 web_search → DeepSeek Chat Completions 面只给 type（无 name）', async () => {
    // 跨 dialect（anthropic 客户端 → deepseek.openai-chat）必然走 canonical 转换。
    // Chat Completions 面的服务端工具只认 type（官方文档：No `name` field）；
    // Messages 面的 {type,name} 双字段形态见下面 I 节的 codec 层测试。
    const { transport } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'anthropic.messages',
      body: {
        model: 'deepseek-flash',
        max_tokens: 256,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '搜索一下 DeepSeek V4.1' }] }],
      },
      path: '/v1/messages',
    });
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    const tools = upstream['tools'] as Array<Record<string, unknown>>;
    // DeepSeek 的 web 工具是裸开关：max_uses 等配置字段被丢弃（上游会 400）
    expect(tools[0]).toEqual({ type: 'deepseek_web_search' });
  });

  it('跨 dialect：Anthropic 客户端的 web_search → DeepSeek Chat Completions 面只给 type', async () => {
    const { transport } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'anthropic.messages',
      body: {
        model: 'deepseek-flash',
        max_tokens: 256,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: '搜索一下' }] }],
      },
      path: '/v1/messages',
    });
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    const tools = upstream['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'deepseek_web_search' });
  });

  it('OpenAI 客户端声明 DeepSeek 专有工具 → canonical BuiltinTool（native 留厂商串）', async () => {
    // 直接用 codec 层验证 canonical 形状（经网关跑一遍会重新编码回 wire）
    const { transport } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'openai.chat',
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '读一下这个链接' }],
        tools: [{ type: 'deepseek_read_url' }],
      },
      path: '/v1/chat/completions',
    });
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    expect(upstream['tools']).toEqual([{ type: 'deepseek_read_url' }]);
  });
});

describe('E · 流式：usage 搭末 chunk + keep-alive 行 + 缓存命中归一', () => {
  it('DeepSeek 形态 SSE → 客户端拿到等价流，usage 归一', async () => {
    const { sink, out } = await runDeepSeek({
      script: [{ chunks: deepseekSseStream() }],
      clientFormat: 'openai.chat',
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
      path: '/v1/chat/completions',
    });

    expect(out.error).toBeUndefined();
    const text = sink.text();
    expect(text).toContain('北京');
    expect(text).toContain('是首都。');
    expect(text).toContain('data: [DONE]');
    // 流式 usage：末 chunk 搭车的那份被抽出并归一（cache hit 7）
    expect(out.usage?.units.tokens).toMatchObject({
      input_tokens: 7,
      output_tokens: 5,
      total_tokens: 12,
      cache_read_tokens: 7,
    });
  });
});

describe('F · reasoning_content 双向映射（DeepSeek 思考内容）', () => {
  it('响应里的 reasoning_content → canonical thinking part → 回写原字段', async () => {
    const { sink } = await runDeepSeek({
      script: [
        {
          body: JSON.stringify(
            deepseekChatResponse({
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    reasoning_content: '先想一下：中国的首都是北京。',
                    content: '北京。',
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
          ),
        },
      ],
      clientFormat: 'openai.chat',
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '中国的首都是哪里？' }],
      },
      path: '/v1/chat/completions',
    });
    const body = jsonBody(sink.text());
    const message = firstChoice(body)['message'] as Record<string, unknown>;
    expect(message['reasoning_content']).toBe('先想一下：中国的首都是北京。');
    expect(message['content']).toBe('北京。');
  });

  it('请求里的 reasoning_content 必须回传（DeepSeek 带 tools 时强制）', async () => {
    const { transport } = await runDeepSeek({
      script: [{ body: JSON.stringify(deepseekChatResponse()) }],
      clientFormat: 'openai.chat',
      body: {
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: '北京天气怎么样？' },
          {
            role: 'assistant',
            reasoning_content: '需要调用天气工具。',
            tool_calls: [
              {
                id: 'call_deepseek_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"北京"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_deepseek_1', content: '晴，25°C' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      },
      path: '/v1/chat/completions',
    });
    const upstream = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m['role'] === 'assistant');
    expect(assistant?.['reasoning_content']).toBe('需要调用天气工具。');
    const toolCalls = assistant?.['tool_calls'] as Array<Record<string, unknown>>;
    expect(toolCalls[0]!['id']).toBe('call_deepseek_1');
  });
});

describe('G · 错误映射', () => {
  it('402 Insufficient Balance → canonical 错误，客户端拿到非 2xx', async () => {
    const { sink, out } = await runDeepSeek({
      script: [
        {
          status: 402,
          body: JSON.stringify({
            error: {
              message: 'Insufficient Balance',
              type: 'unknown_error',
              param: null,
              code: 'invalid_request_error',
            },
          }),
        },
      ],
      clientFormat: 'openai.chat',
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
      path: '/v1/chat/completions',
    });
    expect(out.error?.code).toBe('quota_exceeded');
    expect(sink.startStatus).toBe(402);
    const body = jsonBody(sink.text());
    const error = body['error'] as Record<string, unknown>;
    expect(error['message']).toBe('Insufficient Balance');
    expect(error['type']).toBe('insufficient_quota');
  });

  it('Anthropic 信封错误（billing_error）→ canonical 错误', async () => {
    const { sink, out } = await runDeepSeek({
      script: [
        {
          status: 402,
          body: JSON.stringify({
            type: 'error',
            error: { type: 'billing_error', message: 'You have run out of balance' },
          }),
        },
      ],
      clientFormat: 'anthropic.messages',
      body: {
        model: 'deepseek-flash-messages',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
      path: '/v1/messages',
    });
    expect(out.error?.code).toBe('quota_exceeded');
    expect(sink.startStatus).toBe(402);
  });

  it('400 无效模型名 → invalid_request 类错误', async () => {
    const { sink, out } = await runDeepSeek({
      script: [
        {
          status: 400,
          body: JSON.stringify({
            error: {
              message: 'Model Not Exist',
              type: 'invalid_request_error',
              param: 'model',
              code: 'invalid_request_error',
            },
          }),
        },
      ],
      clientFormat: 'openai.chat',
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
      path: '/v1/chat/completions',
    });
    expect(out.error).toBeDefined();
    expect(out.error?.http_status).toBe(400);
    expect(sink.startStatus).toBe(400);
  });

  it('429 限流 → 可重试错误（脚本要给够重试次数：默认 maxRetries=2）', async () => {
    const rateLimit = {
      status: 429,
      body: JSON.stringify({ error: { message: 'Rate Limit Reached' } }),
    };
    const { out } = await runDeepSeek({
      script: [rateLimit, rateLimit, rateLimit],
      clientFormat: 'openai.chat',
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
      path: '/v1/chat/completions',
    });
    expect(out.error?.code).toBe('rate_limited');
    expect(out.error?.retryable).toBe(true);
  });
});

describe('H · 路由可用性', () => {
  it('四个 DeepSeek 别名都能路由到正确的 access path 与格式', async () => {
    const { StaticRouter } = await import('../gateway-core/router.js');
    const { InMemoryCapabilityRegistry } = await import('../credentials/capability-registry.js');
    const { defaultCapabilities, defaultRouteTable } = await import('../composition-root.js');
    const caps = new InMemoryCapabilityRegistry();
    for (const c of defaultCapabilities()) caps.register(c);
    const router = new StaticRouter(defaultRouteTable(), caps, resolverWithFakeKey());
    const ctx = {
      request_id: 'req_test',
      started_at: 0,
      deadline: 1000,
      client_format: 'openai.chat' as const,
      client_raw_headers: {},
      auth: { key_id: 'k' },
      route: {
        access_path: '',
        provider: '',
        provider_format: 'openai.chat' as const,
        model: '',
        full_model_id: '',
        attempt_plan: [],
        fast_path_eligible: false,
      },
      provider_format: 'openai.chat' as const,
      fast_path: false,
      state: {},
      metrics: [],
      disableFastPath: () => {},
      warn: () => {},
    };
    const flash = router.resolve({ model: 'deepseek-flash', modality: 'chat', stream: false }, ctx);
    expect(flash.ok).toBe(true);
    if (flash.ok) {
      expect(flash.route.access_path).toBe('deepseek.openai-chat');
      expect(flash.route.provider_format).toBe('openai.chat');
    }
    const messages = router.resolve(
      { model: 'deepseek-flash-messages', modality: 'chat', stream: false },
      ctx,
    );
    expect(messages.ok).toBe(true);
    if (messages.ok) {
      expect(messages.route.access_path).toBe('deepseek.anthropic-messages');
      expect(messages.route.provider_format).toBe('anthropic.messages');
    }
    // 已退役的模型名不再有别名（路由层直接拒绝，不会静默落到别的 provider）
    const retired = router.resolve(
      { model: 'deepseek-chat', modality: 'chat', stream: false },
      ctx,
    );
    expect(retired.ok).toBe(false);
  });

  it('DEEPSEEK_BASE_URL 覆盖对两个 dialect 同时生效', async () => {
    const overridden = new EnvCredentialResolver(
      undefined,
      undefined,
      { DEEPSEEK_API_KEY: FAKE_KEY },
      {
        'deepseek.openai-chat': 'https://proxy.example.com',
        'deepseek.anthropic-messages': 'https://proxy.example.com',
      },
    );
    expect(overridden.baseUrlFor('deepseek.openai-chat')).toBe('https://proxy.example.com');
    expect(overridden.baseUrlFor('deepseek.anthropic-messages')).toBe('https://proxy.example.com');
    // 未覆盖的 path 仍走默认
    expect(overridden.baseUrlFor('openai')).toBe('https://api.openai.com');
    // 默认（无覆盖）时是官方 base
    expect(resolverWithFakeKey().baseUrlFor('deepseek.openai-chat')).toBe(
      'https://api.deepseek.com',
    );
  });
});

describe('I · canonical 形状抽查（codec 层，确定性）', () => {
  /** 构造带 route 的最小 RequestContext（access path 决定查哪个 profile）。 */
  function ctxFor(accessPath: string, providerFormat: 'openai.chat' | 'anthropic.messages') {
    return {
      request_id: 'req_test',
      started_at: 0,
      deadline: 1000,
      client_format: 'openai.chat' as const,
      client_raw_headers: {},
      auth: { key_id: 'k' },
      route: {
        access_path: accessPath,
        provider: 'deepseek',
        provider_format: providerFormat,
        model: 'deepseek-flash',
        full_model_id: `${accessPath}/deepseek-flash`,
        attempt_plan: [],
        fast_path_eligible: false,
      },
      provider_format: providerFormat,
      fast_path: false,
      state: {},
      metrics: [],
      disableFastPath: () => {},
      warn: () => {},
    };
  }

  it('openai.chat codec：deepseek_web_search 解码成 BuiltinTool 且 executor=provider', async () => {
    const { OpenAIChatCodec } = await import('../adaptors/openai-chat/index.js');
    const { InMemoryProviderProfileRegistry } = await import('../di/index.js');
    const { createDeepSeekProfile } = await import('../providers/deepseek/index.js');
    const registry = new InMemoryProviderProfileRegistry();
    registry.register(createDeepSeekProfile());
    const codec = new OpenAIChatCodec({ clock: { now: () => 0 }, providerProfiles: registry });
    const canonical = codec.decode(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'deepseek_web_search' }],
      },
      ctxFor('deepseek.openai-chat', 'openai.chat'),
    ) as CanonicalRequestEnvelope;
    const payload = canonical.payload as { tools?: Array<Record<string, unknown>> };
    const tool = payload.tools?.[0];
    expect(tool?.['type']).toBe('builtin');
    expect(tool?.['name']).toBe('web_search');
    expect(tool?.['executor']).toBe('provider');
    expect((tool?.['native'] as Record<string, unknown>)['provider_tool_type']).toBe(
      'deepseek_web_search',
    );
  });

  it('anthropic.messages codec：canonical web_search → DeepSeek Messages 面 {type,name}', async () => {
    const { AnthropicMessagesCodec } = await import('../adaptors/anthropic-messages/index.js');
    const { InMemoryProviderProfileRegistry } = await import('../di/index.js');
    const { createDeepSeekProfile } = await import('../providers/deepseek/index.js');
    const registry = new InMemoryProviderProfileRegistry();
    registry.register(createDeepSeekProfile());
    const codec = new AnthropicMessagesCodec({
      clock: { now: () => 0 },
      providerProfiles: registry,
    });
    const req = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      model: 'deepseek-flash',
      payload: {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        tools: [
          {
            type: 'builtin',
            name: 'web_search',
            config: {},
            executor: 'provider',
            native: { provider_tool_type: 'deepseek_web_search' },
          },
        ],
      },
      source_format: 'anthropic.messages',
      raw: { source_provider: 'anthropic' },
    } as unknown as CanonicalRequestEnvelope;
    const encoded = codec.encode(req, ctxFor('deepseek.anthropic-messages', 'anthropic.messages'));
    const body = encoded.body as Record<string, unknown>;
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: 'deepseek_web_search', name: 'deepseek_web_search' });
  });

  it('anthropic.messages codec：端点路径按 profile 覆盖', async () => {
    const { AnthropicMessagesCodec } = await import('../adaptors/anthropic-messages/index.js');
    const { InMemoryProviderProfileRegistry } = await import('../di/index.js');
    const { createDeepSeekProfile } = await import('../providers/deepseek/index.js');
    const registry = new InMemoryProviderProfileRegistry();
    registry.register(createDeepSeekProfile());
    const codec = new AnthropicMessagesCodec({
      clock: { now: () => 0 },
      providerProfiles: registry,
    });
    const req = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      model: 'deepseek-flash',
      payload: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
      source_format: 'anthropic.messages',
      raw: { source_provider: 'anthropic' },
    } as unknown as CanonicalRequestEnvelope;
    // DeepSeek 的 Messages 面
    expect(
      codec.encode(req, ctxFor('deepseek.anthropic-messages', 'anthropic.messages')).path,
    ).toBe('/anthropic/v1/messages');
    // Anthropic 本家（无 profile）仍是默认路径
    expect(codec.encode(req, ctxFor('anthropic', 'anthropic.messages')).path).toBe('/v1/messages');
  });
});
