/**
 * tests/pipeline-e2e.test.ts —— 端到端往返（mock 上游，不打真实 API）。
 *
 * 这是 70-roadmap Phase 1 的目标验证：「一条请求能从客户端走到上游再回来，可观测、可计费（粗）」。
 *
 * 覆盖四条路径：
 *   A. OpenAI Chat 客户端 → 同格式上游（**fast path**，字节级透传）
 *   B. Anthropic Messages 客户端 → OpenAI Chat 上游（慢路径 + usage 归一 + 诊断）
 *   C. 流式（SSE 聚合与重写）
 *   D. 工具调用多轮循环（网关 agentic loop）
 * 另加：错误映射（上游 500 → canonical 错误体）、插件短路、UsageRecord 落队。
 *
 * 上游全部由 DI 注入的 ScriptedTransport 提供，因此不起真实网络。
 */

import { describe, expect, it } from 'vitest';
import { createGateway } from '../composition-root.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { ScriptedTransport, type ScriptedTransportScript } from '../gateway-core/transport.js';
import type { CanonicalRequestEnvelope, Plugin } from '../ir/index.js';
import { emptyUsage } from '../ir/index.js';

function openAiChatResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test0001',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-test-1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '端到端跑通了。' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 18,
      completion_tokens: 11,
      total_tokens: 29,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

function openAiSseStream(): string[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'gpt-test-1',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: '你好' }),
    chunk({ content: '，世界' }),
    `data: ${JSON.stringify({
      id: 'chatcmpl-stream1',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'gpt-test-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 4,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

/** 读出一段 JSON 响应体；用 Record<string, unknown> 而不是 any，避免 lint 警告。 */
function jsonBody(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

/** 取 choices[0]。 */
function firstChoice(body: Record<string, unknown>): Record<string, unknown> {
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('响应没有 choices');
  return choices[0] as Record<string, unknown>;
}

/** 取 choices[0].message。 */
function firstMessage(body: Record<string, unknown>): Record<string, unknown> {
  const choice = firstChoice(body);
  const message = choice['message'];
  if (typeof message !== 'object' || message === null) throw new Error('choice 没有 message');
  return message as Record<string, unknown>;
}

function runOnce(
  transport: ScriptedTransport,
  clientFormat: 'openai.chat' | 'anthropic.messages',
  body: unknown,
  path: string,
  plugins: Array<{ plugin: Plugin; config?: unknown }> = [],
  aliases: Record<
    string,
    { targets: Array<{ access_path: string; provider: string; model: string }> }
  > = {
    // 走 mock access path（requires_credential: false），因此不需要环境变量里的 key
    'gpt-test-1': { targets: [{ access_path: 'mock', provider: 'mock', model: 'gpt-test-1' }] },
    'claude-test-1': {
      targets: [{ access_path: 'mock-anthropic', provider: 'mock', model: 'claude-test-1' }],
    },
  },
) {
  const gateway = createGateway({
    mode: 'test',
    transport,
    plugins,
    routeTable: { aliases },
  });
  const sink = new MemoryClientSink();
  return {
    gateway,
    sink,
    outcome: gateway.runner.run(
      {
        client_format: clientFormat,
        raw_body: Buffer.from(JSON.stringify(body)),
        headers: { 'content-type': 'application/json' },
        path,
        query: {},
      },
      sink,
    ),
  };
}

describe('端到端：OpenAI Chat 客户端 → 同格式上游（fast path）', () => {
  it('透传原始字节，旁路抽 usage，回程与上游一致', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const { gateway, sink, outcome } = runOnce(
      transport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      '/v1/chat/completions',
    );
    const out = await outcome;

    expect(out.fast_path).toBe(true);
    expect(out.materialized).toBe(false); // D-fastpath-1：fast path 不物化完整 canonical
    expect(out.error).toBeUndefined();

    // 回程：客户端格式响应体
    const body = jsonBody(sink.text());
    expect(body['object']).toBe('chat.completion');
    expect(firstMessage(body)['content']).toBe('端到端跑通了。');
    expect(firstChoice(body)['finish_reason']).toBe('stop');

    // 旁路：usage 已归一（fast path 下唯一必做的事之一，20 §4.2）
    expect(out.usage?.units.tokens).toMatchObject({
      input_tokens: 18,
      output_tokens: 11,
      total_tokens: 29,
      cache_read_tokens: 4,
    });

    // 上游收到的就是原始字节（fast path 透传）
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.body?.toString('utf8')).toBe(
      JSON.stringify({
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    );

    // S10 落了一条 UsageRecord
    await gateway.usageEmitter.flush();
    expect(gateway.usageSink?.records).toHaveLength(1);
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.fast_path).toBe(true);
    expect(rec.provider_format).toBe('openai.chat');
    expect(rec.status).toBe('success');
    expect(rec.model).toBe('gpt-test-1');
  });
});

describe('端到端：Anthropic Messages 客户端 → OpenAI Chat 上游（慢路径）', () => {
  it('跨格式转换 + usage 归一 + conversion_chain 记录', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const { gateway, sink, outcome } = runOnce(
      transport,
      'anthropic.messages',
      {
        model: 'gpt-test-1',
        system: '你是一个简洁的助手。',
        max_tokens: 256,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
      '/v1/messages',
    );
    const out = await outcome;

    expect(out.fast_path).toBe(false);
    expect(out.materialized).toBe(true); // D-fastpath-1：慢路径物化
    expect(out.trace.conversion_chain).toEqual(['anthropic.messages', 'openai.chat']);

    // 回程是 Anthropic Messages 格式
    const body = jsonBody(sink.text());
    expect(body['type']).toBe('message');
    expect(body['role']).toBe('assistant');
    const content = body['content'];
    expect(Array.isArray(content) && (content[0] as Record<string, unknown>)['type']).toBe('text');
    expect(body['stop_reason']).toBe('end_turn');
    // Anthropic wire 格式没有 total_tokens 字段（40 §2.1「需自算」），因此断言 canonical 侧
    // 的归一值：total = input + cache_creation + cache_read + output（40 §2.2 官方口径）
    expect(out.usage?.units.tokens).toMatchObject({
      input_tokens: 18,
      output_tokens: 11,
      cache_read_tokens: 4,
      total_tokens: 18 + 0 + 0 + 11,
    });
    // wire 侧是 Anthropic 原生 usage 形态
    expect(body['usage'] as Record<string, unknown>).toMatchObject({
      input_tokens: 18,
      output_tokens: 11,
      cache_read_input_tokens: 4,
    });

    // 上游收到的是 OpenAI Chat 格式
    expect(transport.requests).toHaveLength(1);
    const upstreamBody = jsonBody(transport.requests[0]!.body!.toString('utf8'));
    expect(upstreamBody['model']).toBe('gpt-test-1');
    const upstreamMessages = upstreamBody['messages'];
    expect(Array.isArray(upstreamMessages)).toBe(true);
    const first = (upstreamMessages as unknown[])[0] as Record<string, unknown>;
    const second = (upstreamMessages as unknown[])[1] as Record<string, unknown>;
    expect(first['role']).toBe('system');
    expect(first['content']).toBe('你是一个简洁的助手。');
    expect(second['role']).toBe('user');

    await gateway.usageEmitter.flush();
    expect(gateway.usageSink?.records).toHaveLength(1);
  });
});

describe('端到端：流式 SSE', () => {
  it('聚合上游 SSE 并按客户端格式重写', async () => {
    const transport = new ScriptedTransport([{ chunks: openAiSseStream() }]);
    const { gateway, sink, outcome } = runOnce(
      transport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
      '/v1/chat/completions',
    );
    const out = await outcome;

    expect(sink.started).toBe(true);
    expect(sink.startStatus).toBe(200);
    const text = sink.text();
    expect(text).toContain('你好');
    expect(text).toContain('，世界');
    // 流尾的 usage 被抽到（20 §4.2：必须解析流尾的 usage 事件）
    expect(out.usage?.units.tokens?.input_tokens).toBe(9);
    expect(out.usage?.units.tokens?.output_tokens).toBe(4);
    expect(gateway).toBeDefined();
  });

  it('慢路径（always-canonical）流式实时逐块下发，不在 S6 缓冲整条流', async () => {
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((r) => {
      releaseSecondChunk = r;
    });
    const slowChunks = openAiSseStream();
    const liveTransport: Transport = {
      async send() {
        async function* gen(): AsyncGenerator<Buffer> {
          yield Buffer.from(slowChunks[0]!, 'utf8');
          yield Buffer.from(slowChunks[1]!, 'utf8'); // 含 "你好"
          await secondChunkGate;
          for (let i = 2; i < slowChunks.length; i += 1) {
            yield Buffer.from(slowChunks[i]!, 'utf8');
          }
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: gen(),
        };
      },
    };

    const { sink, outcome } = runOnce(
      liveTransport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
      '/v1/chat/completions',
    );

    // 等待首个增量写出（此时后续 chunk 仍堵在 secondChunkGate）
    for (let i = 0; i < 40 && !sink.text().includes('你好'); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(sink.started).toBe(true);
    expect(sink.text()).toContain('你好');
    expect(sink.text()).not.toContain('，世界');

    releaseSecondChunk();
    const out = await outcome;
    expect(sink.text()).toContain('，世界');
    expect(out.usage?.units.tokens?.output_tokens).toBe(4);
  });
});

describe('端到端：错误映射', () => {
  it('上游 500 → canonical 错误体，客户端拿到非 2xx', async () => {
    const transport = new ScriptedTransport([
      {
        status: 500,
        body: JSON.stringify({ error: { message: 'upstream boom', type: 'server_error' } }),
      },
      {
        status: 500,
        body: JSON.stringify({ error: { message: 'upstream boom', type: 'server_error' } }),
      },
      {
        status: 500,
        body: JSON.stringify({ error: { message: 'upstream boom', type: 'server_error' } }),
      },
    ]);
    const { gateway, sink, outcome } = runOnce(
      transport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      '/v1/chat/completions',
    );
    const out = await outcome;

    expect(out.error?.code).toBe('provider_unavailable');
    expect(out.error?.http_status).toBe(500);
    expect(sink.startStatus).toBe(500);
    // 错误体由客户端格式 codec 生成，不透传上游错误体（20 §7.2）
    const body = jsonBody(sink.text());
    expect(body['error']).toBeDefined();

    // 失败也记账
    await gateway.usageEmitter.flush();
    expect(gateway.usageSink?.records[0]?.status).toBe('error');
    expect(gateway.usageSink?.records[0]?.error_code).toBe('provider_unavailable');
  });

  it('上游 400 参数错误 → 直接映射为客户端 400，不重试不 fallback', async () => {
    const transport = new ScriptedTransport([
      {
        status: 400,
        body: JSON.stringify({ error: { message: 'bad param', type: 'invalid_request_error' } }),
      },
    ]);
    const { outcome } = runOnce(
      transport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      '/v1/chat/completions',
    );
    const out = await outcome;
    expect(out.error?.http_status).toBe(400);
    // 只打了一次（没有重试）
    expect(transport.requests).toHaveLength(1);
  });
});

describe('端到端：插件短路', () => {
  it('onRequest 返回 ShortCircuit → 跳过上游，直达 S9/S10', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const guardPlugin: Plugin = {
      manifest: { name: 'guard', version: '1.0.0', hooks: ['onRequest', 'onResponse'], order: 10 },
      onRequest: () => ({
        short_circuit: true,
        reason: 'blocked by test guard',
        response: {
          ir_version: 'ag-ir/1',
          kind: 'chat',
          request_id: 'req_short',
          usage: emptyUsage('provider'),
          finish_reason: 'content_filter',
          payload: {
            message: {
              role: 'assistant',
              parts: [{ type: 'refusal', reason: 'blocked by test guard' }],
            },
          },
          warnings: ['short_circuit'],
          raw: {},
        },
      }),
    };
    const { gateway, sink, outcome } = runOnce(
      transport,
      'openai.chat',
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }] },
      '/v1/chat/completions',
      [{ plugin: guardPlugin }],
    );
    const out = await outcome;

    expect(out.short_circuit).toBe(true);
    // 没有打上游
    expect(transport.requests).toHaveLength(0);
    const body = jsonBody(sink.text());
    expect(firstMessage(body)['content']).toBeDefined();

    await gateway.usageEmitter.flush();
    expect(gateway.usageSink?.records[0]?.status).toBe('short_circuit');
  });

  it('full-canonical 请求侧插件禁用 fast path（D-fastpath-2）', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const plugin: Plugin = {
      manifest: {
        name: 'rewriter',
        version: '1.0.0',
        hooks: ['onRequest'],
        scope: 'full-canonical',
      },
      onRequest: (req: CanonicalRequestEnvelope) => req,
    };
    const { outcome } = runOnce(
      transport,
      'openai.chat',
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }] },
      '/v1/chat/completions',
      [{ plugin }],
    );
    const out = await outcome;
    expect(out.fast_path).toBe(false);
    expect(out.materialized).toBe(true);
  });

  it('envelope-only 请求侧插件不禁用 fast path（D-fastpath-2）', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const plugin: Plugin = {
      manifest: { name: 'reader', version: '1.0.0', hooks: ['onRequest'], scope: 'envelope-only' },
      onRequest: (req: CanonicalRequestEnvelope) => req,
    };
    const { outcome } = runOnce(
      transport,
      'openai.chat',
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }] },
      '/v1/chat/completions',
      [{ plugin }],
    );
    const out = await outcome;
    expect(out.fast_path).toBe(true);
  });

  it('full-canonical 响应侧插件禁用 fast path（D-fastpath-2 两侧对称，§4.4 已修）', async () => {
    // 2026-11-16 修（PLUGIN-SYSTEM-REPORT.md §4.4）：D-fastpath-2 原先只写请求侧，于是
    // 一个只声明 onResponse 的审计/脱敏插件在 fast path 下被静默跳过（S6 不解码响应，
    // 整条 onResponse 链不执行）。现在响应侧与请求侧对称：full-canonical（默认档）的
    // 响应侧插件同样让请求改走慢路径——插件永远看得见完整 canonical 响应。
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const plugin: Plugin = {
      manifest: { name: 'auditor', version: '1.0.0', hooks: ['onResponse'] },
      onResponse: (res) => res,
    };
    const { gateway, outcome } = runOnce(
      transport,
      'openai.chat',
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }] },
      '/v1/chat/completions',
      [{ plugin }],
    );
    const out = await outcome;
    expect(out.fast_path).toBe(false);
    expect(out.materialized).toBe(true);
    // 没有任何"插件被跳过"的告警——它确实跑了
    await gateway.usageEmitter.flush();
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.warnings.some((w) => w.startsWith('onResponse_skipped_fast_path'))).toBe(false);
  });
});

describe('端到端：工具调用多轮循环', () => {
  it('网关 agentic loop 跑两轮并记账', async () => {
    const withToolCall: Record<string, unknown> = {
      id: 'chatcmpl-loop1',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-test-1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_loop0001',
                type: 'function',
                function: { name: 'get_time', arguments: JSON.stringify({ tz: 'UTC' }) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const finalAnswer = openAiChatResponse({
      id: 'chatcmpl-loop2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '现在 UTC 时间是 12:00。' },
          finish_reason: 'stop',
        },
      ],
    });

    const script: ScriptedTransportScript = [
      { body: JSON.stringify(withToolCall) },
      { body: JSON.stringify(finalAnswer) },
    ];
    const transport = new ScriptedTransport(script);

    const execPlugin: Plugin = {
      manifest: { name: 'tool-exec', version: '1.0.0', hooks: ['onToolCall'], order: 10 },
      onToolCall: (call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: '12:00 UTC',
      }),
    };

    const { gateway, outcome } = runOnce(
      transport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: '现在 UTC 几点？' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_time',
              description: '查询时区时间',
              parameters: { type: 'object', properties: { tz: { type: 'string' } } },
            },
          },
        ],
        ag_agentic_loop: true,
      },
      '/v1/chat/completions',
      [{ plugin: execPlugin }],
    );
    const out = await outcome;

    expect(out.error).toBeUndefined();
    expect(out.turns).toBeGreaterThanOrEqual(2);
    expect(transport.requests.length).toBeGreaterThanOrEqual(2);
    // 第二轮请求体里应带上 tool_result
    const secondBody = jsonBody(transport.requests[1]!.body!.toString('utf8'));
    const secondMessages = secondBody['messages'];
    expect(
      Array.isArray(secondMessages) &&
        secondMessages.some((m) => (m as Record<string, unknown>)['role'] === 'tool'),
    ).toBe(true);

    await gateway.usageEmitter.flush();
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.agentic_turns).toBeGreaterThanOrEqual(2);
    expect(rec.tool_calls.length).toBeGreaterThanOrEqual(1);
    expect(rec.tool_calls[0]!.name).toBe('get_time');
  });

  it('一轮两个并行工具调用 → 第二轮请求体里是 2 条 role:"tool" 消息（不是 1 条）', async () => {
    // 用户实测故障：内置对话发 hello → 模型决定并行调两个工具 → 网关追发下一轮 →
    // 上游 400 "insufficient tool messages following tool_calls message"。
    // 根因是 codec 把一条 canonical tool 消息（2 个 tool_result）压成 1 条 wire 消息。
    const withTwoToolCalls: Record<string, unknown> = {
      id: 'chatcmpl-loop-parallel',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-test-1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_parallel_1',
                type: 'function',
                function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) },
              },
              {
                id: 'call_parallel_2',
                type: 'function',
                function: { name: 'get_time', arguments: JSON.stringify({ tz: 'CET' }) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const finalAnswer = openAiChatResponse({
      id: 'chatcmpl-loop-parallel-2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '巴黎 18°C，CET 14:05。' },
          finish_reason: 'stop',
        },
      ],
    });

    const transport = new ScriptedTransport([
      { body: JSON.stringify(withTwoToolCalls) },
      { body: JSON.stringify(finalAnswer) },
    ]);

    const execPlugin: Plugin = {
      manifest: { name: 'tool-exec-parallel', version: '1.0.0', hooks: ['onToolCall'], order: 10 },
      onToolCall: (call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: call.name === 'get_weather' ? '18°C, light rain' : '14:05 CET',
      }),
    };

    const { gateway, outcome } = runOnce(
      transport,
      'openai.chat',
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: '巴黎天气如何、现在几点？' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查询城市天气',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
          {
            type: 'function',
            function: {
              name: 'get_time',
              description: '查询时区时间',
              parameters: { type: 'object', properties: { tz: { type: 'string' } } },
            },
          },
        ],
        ag_agentic_loop: true,
      },
      '/v1/chat/completions',
      [{ plugin: execPlugin }],
    );
    const out = await outcome;

    expect(out.error).toBeUndefined();
    expect(transport.requests).toHaveLength(2);

    const secondBody = jsonBody(transport.requests[1]!.body!.toString('utf8'));
    const messages = secondBody['messages'] as Array<Record<string, unknown>>;
    const toolMessages = messages.filter((m) => m['role'] === 'tool');
    // 关键断言：assistant 带了 2 个 tool_calls，后面就必须是 2 条 tool 消息
    const assistant = messages.find((m) => m['role'] === 'assistant');
    expect((assistant?.['tool_calls'] as unknown[]).length).toBe(2);
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((m) => m['tool_call_id'])).toEqual([
      'call_parallel_1',
      'call_parallel_2',
    ]);
    // 每条 tool 消息的内容对得上自己的那次调用，没有串台
    expect(toolMessages.map((m) => m['content'])).toEqual(['18°C, light rain', '14:05 CET']);

    await gateway.usageEmitter.flush();
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.tool_calls.map((c) => c.name).sort()).toEqual(['get_time', 'get_weather']);
  });
});
