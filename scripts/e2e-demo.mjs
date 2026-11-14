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
import { createModelsEndpoints } from '../dist/http/models-endpoint.js';
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
    // 把加密存储里的运行时设置应用回 config（没配 recordStore 时是 no-op）
    startup: () => gateway.loadSettings(),
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

/**
 * 演示 C：模型目录端点（`GET /v1/models`）——元数据面，不进出 pipeline。
 *
 * 这条同时演示三件事：
 *   1. 启动时同步：`startHttpServer` 在 listen 前 await `models.start()`，上游 `/models`
 *      被拉一次并写回能力矩阵（脚本第一条就是它）；
 *   2. 分层合并：响应里的窗口/模态/effort/constraints 来自能力矩阵（运行时真值），
 *      family/发布日期/知识截止来自 vendored models.dev 快照，价格（带峰谷 tiers）与
 *      并发限额来自 DeepSeek 静态表——`provenance` 逐字段记着是谁说的；
 *   3. OpenAI 兼容 superset：`{object:"list", data:[{id, object, created, owned_by}]}`
 *      之外全是扩展键，真实 OpenAI SDK 客户端按已知键取值、忽略多余键。
 */
async function demoModelsEndpoint() {
  section('演示 C · 模型目录：GET /v1/models（分层元数据 + 启动时同步上游 /models）');

  const { ScriptedTransport } = await import('../dist/gateway-core/transport.js');
  const transport = new ScriptedTransport([
    // 第一条：上游 GET /models（启动时同步消费掉）
    {
      status: 200,
      body: JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'deepseek-flash',
            object: 'model',
            owned_by: 'deepseek',
            name: 'DeepSeek-V4.1-Flash',
            context_window: 1048576,
            max_output_tokens: 393216,
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
            api_capabilities: {
              anthropic_messages: {
                system_prompt_update: 'in-history',
                tool_update: 'addition-only',
              },
            },
          },
          {
            id: 'deepseek-v4-pro',
            object: 'model',
            owned_by: 'deepseek',
            name: 'DeepSeek-V4-Pro',
            context_window: 1048576,
            max_output_tokens: 393216,
            input_modalities: ['text'],
            output_modalities: ['text'],
            effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
            api_capabilities: {
              anthropic_messages: {
                system_prompt_update: 'leading-only',
                tool_update: 'leading-only',
              },
            },
          },
        ],
      }),
    },
  ]);

  const gateway = createGateway({
    mode: 'production',
    transport,
    config: { port: PORT, host: HOST },
  });

  const models = createModelsEndpoints({
    catalog: gateway.models,
    sync: gateway.modelSync,
  });

  const server = await startHttpServer({
    port: PORT,
    host: HOST,
    runner: gateway.runner,
    models,
    // 把加密存储里的运行时设置应用回 config（没配 recordStore 时是 no-op）
    startup: () => gateway.loadSettings(),
  });
  process.stdout.write(`ingress 已启动: http://${HOST}:${PORT}（含 /v1/models）\n`);

  // 1) 列表（带过滤：只要 deepseek、按上下文窗口降序）
  process.stdout.write('\n→ GET /v1/models?owned_by=deepseek&sort=-context_window\n');
  const listRes = await fetch(
    `http://${HOST}:${PORT}/v1/models?owned_by=deepseek&sort=-context_window`,
  );
  const list = await listRes.json();
  process.stdout.write(
    `← HTTP ${listRes.status} object=${list.object} total=${list.total}\n` +
      list.data
        .map(
          (m) =>
            `  ${m.id}  owned_by=${m.owned_by}  created=${m.created}  ctx=${m.context_window}\n` +
            `    family=${m.family}  release_date=${m.release_date}  知识截止=${m.knowledge_cutoff ?? '(上游未提供)'}\n` +
            `    modalities=${JSON.stringify(m.input_modalities)}→${JSON.stringify(m.output_modalities)}  effort=${JSON.stringify(m.effort)}\n` +
            `    constraints=${JSON.stringify(m.constraints)}\n` +
            `    pricing=${m.pricing?.table_version} tiers=${m.pricing?.tiers?.length ?? 0} 节假日=${m.pricing?.holidays?.year ?? '—'}\n` +
            `    access_paths=${(m.access_paths ?? []).map((p) => `${p.access_path}[${p.credential?.kind}]`).join(', ')}\n` +
            `    字段来源: ${JSON.stringify(m.provenance.fields)}`,
        )
        .join('\n'),
  );

  // 2) 详情
  process.stdout.write('\n→ GET /v1/models/deepseek-flash\n');
  const oneRes = await fetch(`http://${HOST}:${PORT}/v1/models/deepseek-flash`);
  const one = await oneRes.json();
  process.stdout.write(
    `← HTTP ${oneRes.status} id=${one.id} object=${one.object} owned_by=${one.owned_by}\n` +
      `  supported_parameters(${one.supported_parameters.length})=${JSON.stringify(one.supported_parameters)}\n` +
      `  per_request_limits=${JSON.stringify(one.per_request_limits)} concurrency=${JSON.stringify(one.concurrency)}\n` +
      `  stale=${one.provenance.stale} last_successful_fetch=${one.provenance.last_successful_fetch ?? '—'}\n`,
  );

  // 3) 退役别名：404 且解释原因
  process.stdout.write('\n→ GET /v1/models/deepseek-chat（已退役别名）\n');
  const retiredRes = await fetch(`http://${HOST}:${PORT}/v1/models/deepseek-chat`);
  const retired = await retiredRes.json();
  process.stdout.write(`← HTTP ${retiredRes.status} ${JSON.stringify(retired.error)}\n`);

  // 4) 管理员路由：没配令牌 → 503（拒绝一切，而不是放行）
  process.stdout.write('\n→ GET /ag/models/sync（未配 AG_ADMIN_TOKEN）\n');
  const adminRes = await fetch(`http://${HOST}:${PORT}/ag/models/sync`);
  process.stdout.write(`← HTTP ${adminRes.status} ${JSON.stringify(await adminRes.json())}\n`);

  server.close();
  await gateway.shutdown();
}

const results = [];
results.push(await demoHttpOpenAiChat());
results.push(await demoRunnerAnthropicToOpenAi());
results.push(await demoModelsEndpoint());

section('演示完成');
process.stdout.write(
  `三次往返都跑通了：\n` +
    `  A. HTTP ingress（OpenAI Chat 客户端 → 同格式上游，fast path）\n` +
    `  B. Runner 直跑（Anthropic Messages 客户端 → OpenAI Chat 上游，慢路径 + usage 归一）\n` +
    `  C. 模型目录（GET /v1/models：分层元数据 + 启动时同步 + OpenAI 兼容 superset）\n`,
);
