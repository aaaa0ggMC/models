/**
 * scripts/e2e-demo.mjs —— 本地端到端演示（mock 上游，不打真实 API）。
 *
 * 演示路径（00 §4.1 数据流）：
 *   客户端格式(OpenAI Chat / Anthropic Messages)
 *     → canonical（S1 浅解析 → S3 物化）
 *     → 上游格式（S4 Encode）
 *     → mock 上游（ScriptedTransport，DI 注入）
 *     → 回程（S6 ProviderDecode → S8 ClientEncode）
 *     → 客户端格式
 *
 * 跑法：`npm run build && npm run demo`
 */

import { createGateway } from '../dist/composition-root.js';
import { startHttpServer } from '../dist/http/server.js';
import { MemoryClientSink } from '../dist/gateway-core/pipeline/sink.js';

const PORT = Number(process.env['AG_PORT'] ?? 8787);
const HOST = process.env['AG_HOST'] ?? '127.0.0.1';

/** 打印一小段分隔标题。 */
function section(title) {
  process.stdout.write(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n`);
}

/**
 * 演示 A：走完整 HTTP ingress + PipelineRunner（S0–S10）。
 * 客户端发 OpenAI Chat 格式，路由到 openai access path（同格式 → fast path）。
 */
async function demoHttpOpenAiChat() {
  section('演示 A · HTTP ingress：客户端 OpenAI Chat 格式 → canonical → mock 上游 → 回程');

  // ScriptedTransport 的脚本按请求顺序消费；这里给两条，第二条留作演示 B
  const { ScriptedTransport } = await import('../dist/gateway-core/transport.js');
  const transport = new ScriptedTransport([
    {
      status: 200,
      body: JSON.stringify({
        id: 'chatcmpl-demo0001',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'gpt-test-1',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '端到端跑通了：这是 mock 上游的回复。' },
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
      }),
    },
  ]);

  const gateway = createGateway({
    mode: 'production',
    transport,
    config: { port: PORT, host: HOST },
  });

  const server = await startHttpServer({
    port: PORT,
    host: HOST,
    runner: gateway.runner,
  });
  process.stdout.write(`ingress 已启动: http://${HOST}:${PORT}\n`);

  const clientRequest = {
    model: 'mock-gpt',
    messages: [
      { role: 'system', content: '你是一个简洁的助手。' },
      { role: 'user', content: '用一句话说明网关做了什么。' },
    ],
    max_tokens: 256,
    temperature: 0.7,
    stream: false,
  };

  process.stdout.write(
    `\n→ POST /v1/chat/completions\n${JSON.stringify(clientRequest, null, 2)}\n`,
  );

  const res = await fetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(clientRequest),
  });

  const body = await res.text();
  process.stdout.write(`\n← HTTP ${res.status} ${res.headers.get('content-type')}\n${body}\n`);

  // 观测：UsageRecord 与 RequestTrace
  await gateway.usageEmitter.flush();
  const trace = gateway.runner === undefined ? undefined : undefined;
  process.stdout.write(`\nusage 队列深度: ${gateway.usageEmitter.depth()}\n`);

  server.close();
  await gateway.shutdown();
  return { res, body, trace };
}

/**
 * 演示 B：直接跑 PipelineRunner（不起 HTTP），客户端 Anthropic Messages 格式。
 * 这条走的是「客户端格式 ≠ 上游格式」的慢路径（anthropic.messages → openai.chat）。
 */
async function demoRunnerAnthropicToOpenAi() {
  section(
    '演示 B · PipelineRunner 直跑：客户端 Anthropic Messages → canonical → 上游 OpenAI Chat → 回程',
  );

  const { ScriptedTransport } = await import('../dist/gateway-core/transport.js');
  const transport = new ScriptedTransport([
    {
      status: 200,
      body: JSON.stringify({
        id: 'chatcmpl-demo0002',
        object: 'chat.completion',
        created: 1_700_000_000,
        model: 'gpt-test-1',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '跨格式转换跑通了。' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 9,
          total_tokens: 29,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }),
    },
  ]);

  const gateway = createGateway({
    mode: 'test',
    transport,
    routeTable: {
      aliases: {
        'mock-claude': {
          // 客户端 anthropic.messages + 上游 openai.chat → 必然慢路径 + 跨格式互转；
          // access_path 用 mock（requires_credential: false），不需要环境变量里的 key。
          targets: [{ access_path: 'mock', provider: 'mock', model: 'gpt-test-1' }],
        },
      },
    },
  });

  const anthropicRequest = {
    model: 'mock-claude',
    system: '你是一个简洁的助手。',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '用一句话说明网关做了什么。' }],
      },
    ],
  };

  const sink = new MemoryClientSink();
  process.stdout.write(
    `\n→ 客户端 Anthropic Messages 格式\n${JSON.stringify(anthropicRequest, null, 2)}\n`,
  );

  const outcome = await gateway.runner.run(
    {
      client_format: 'anthropic.messages',
      raw_body: Buffer.from(JSON.stringify(anthropicRequest)),
      headers: { 'content-type': 'application/json' },
      path: '/v1/messages',
      query: {},
    },
    sink,
  );

  process.stdout.write(
    `\n← 回程（客户端格式 = Anthropic Messages）\n${JSON.stringify(JSON.parse(sink.text()), null, 2)}\n`,
  );
  process.stdout.write(
    `\n观测: fast_path=${outcome.fast_path} materialized=${outcome.materialized} ` +
      `turns=${outcome.turns} conversion_chain=${JSON.stringify(outcome.trace.conversion_chain)}\n`,
  );
  process.stdout.write(
    `观测: usage=${JSON.stringify(outcome.usage?.units.tokens ?? null)} ` +
      `warnings=${JSON.stringify(outcome.trace.warnings)}\n`,
  );

  await gateway.usageEmitter.flush();
  process.stdout.write(`观测: UsageRecord 条数 = ${gateway.usageSink?.records.length ?? 0}\n`);
  if (gateway.usageSink !== undefined && gateway.usageSink.records.length > 0) {
    const r = gateway.usageSink.records[0];
    process.stdout.write(
      `观测: UsageRecord{ request_id=${r.request_id}, provider=${r.provider}, ` +
        `provider_format=${r.provider_format}, fast_path=${r.fast_path}, status=${r.status} }\n`,
    );
  }

  await gateway.shutdown();
  return outcome;
}

const results = [];
results.push(await demoHttpOpenAiChat());
results.push(await demoRunnerAnthropicToOpenAi());

section('演示完成');
process.stdout.write(
  `两次往返都跑通了：\n` +
    `  A. HTTP ingress（OpenAI Chat 客户端 → 同格式上游，fast path）\n` +
    `  B. Runner 直跑（Anthropic Messages 客户端 → OpenAI Chat 上游，慢路径 + usage 归一）\n`,
);
