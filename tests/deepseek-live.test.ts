/**
 * tests/deepseek-live.test.ts —— DeepSeek **真实 API** 冒烟测试。
 *
 * ⚠️ 只在 `DEEPSEEK_API_KEY` 存在时运行（describe.runIf），`npm test` 无 key 时自动跳过。
 * 跑法（key 只从环境变量读，.env 已被 gitignore）：
 *   node --env-file=.env npx vitest run tests/deepseek-live.test.ts
 *
 * 覆盖（任务书 + 仓库主人后续要求）：
 *   1. 元数据：GET /models（核对 api_capabilities 约束）、GET /user/balance（对账真值源）
 *   2. OpenAI 方言：非流式 / 流式 / 工具调用 / thinking（reasoning_content + usage）/
 *      上下文缓存（同前缀连发两次看 cache hit 字段）/ 基本参数
 *   3. Anthropic 方言：非流式、max_tokens 是否强制、system 传法、usage 字段
 *   4. 跨 dialect：客户端 Anthropic 格式 → canonical → DeepSeek(OpenAI 面)（过网关管道）
 *   5. 服务端工具：deepseek_web_search / deepseek_read_url 在三个接口下的参数名与返回形态
 *   6. 独立端点：Search / Fetch / OCR / TTS / ASR（TTS 生成音频喂 ASR 形成闭环）
 *   7. 错误路径：非法模型名（已退役的 deepseek-chat）、空 messages、无效 key
 *   8. 计量：每类调用的 usage 原样记录 + 与余额差对账
 *
 * 预算意识：所有调用都显式限制 max_tokens；思考模式是主要成本项（默认 64K 上限），
 * 因此思考类调用把 max_tokens 压到 1024。总预算约 ¥0.5。
 */

import { createRequire } from 'node:module';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

/** ESM 里取 Node 内置模块的 require（仅 PNG 编码器用）。 */
const requireZlib = createRequire(import.meta.url);
import { createGateway } from '../composition-root.js';
import { FetchTransport } from '../gateway-core/transport.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import {
  DeepSeekModelDiscovery,
  DeepSeekSearchClient,
  DeepSeekFetchClient,
  DeepSeekOcrClient,
  DeepSeekTtsClient,
  DeepSeekAsrClient,
} from '../providers/deepseek/index.js';

const KEY = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const hasKey = KEY.length > 0;
const BASE = 'https://api.deepseek.com';

/** 观测收集器：测试断言之外，把所有「实测结论」攒起来最后统一打印（进报告）。 */
const observations: string[] = [];
function obs(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  observations.push(line);
  process.stdout.write(`[obs] ${line}\n`);
}

/** 原始 fetch 探针（不经网关，直接打上游，用于观测真实 wire 形态）。 */
async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  auth: string | null = KEY,
): Promise<{ status: number; headers: Record<string, string>; json: unknown; text: string }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth !== null) headers['authorization'] = `Bearer ${auth}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: out, json, text };
}

/**
 * 记录型 transport：包一层 FetchTransport，把每个上游请求记下来
 * （FetchTransport 本身不记录——只有 ScriptedTransport 记录）。
 */
class RecordingTransport {
  readonly requests: Array<{
    method: string;
    base_url: string;
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
  }> = [];
  constructor(private readonly inner: FetchTransport) {}
  async send(req: Parameters<FetchTransport['send']>[0]) {
    this.requests.push({
      method: req.method,
      base_url: req.base_url,
      path: req.path,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    return this.inner.send(req);
  }
}

const describeLive = describe.runIf(hasKey);

describeLive('DeepSeek 真实 API 冒烟（key 已提供）', () => {
  let balanceBefore: { currency: string; total: number; granted: number; topped_up: number }[] = [];
  const callLog: Array<{ what: string; usage?: Record<string, unknown> }> = [];

  beforeAll(async () => {
    if (!hasKey) return;
    // ---- 1a. GET /models：核对上游声明的行为约束 ----
    const models = await api('GET', '/models');
    expect(models.status).toBe(200);
    const data = (models.json as { data?: unknown[] })?.data ?? [];
    obs('GET /models →', JSON.stringify(data));
    for (const m of data) {
      const rec = m as Record<string, unknown>;
      callLog.push({ what: 'GET /models' });
      expect(typeof rec['id']).toBe('string');
    }
    // 与仓库主人提供的样本核对：flash=in-history+addition-only、pro=leading-only+leading-only
    const flash = data.find((m) => (m as { id?: string }).id === 'deepseek-flash') as
      Record<string, unknown> | undefined;
    const pro = data.find((m) => (m as { id?: string }).id === 'deepseek-v4-pro') as
      Record<string, unknown> | undefined;
    expect(flash).toBeDefined();
    expect(pro).toBeDefined();
    const flashCaps = (flash?.['api_capabilities'] as Record<string, unknown> | undefined)
      ?.anthropic_messages as Record<string, unknown> | undefined;
    const proCaps = (pro?.['api_capabilities'] as Record<string, unknown> | undefined)
      ?.anthropic_messages as Record<string, unknown> | undefined;
    obs('flash api_capabilities =', JSON.stringify(flashCaps));
    obs('v4-pro api_capabilities =', JSON.stringify(proCaps));
    // 实测与静态种子不一致时以实测为准（测试不断言具体值，只记录——避免上游变动弄红测试）

    // ---- 1b. GET /user/balance：对账真值源（起始快照）----
    const balance = await api('GET', '/user/balance');
    obs('GET /user/balance →', balance.text);
    if (balance.status === 200) {
      const infos = (balance.json as { balance_infos?: unknown[] })?.balance_infos ?? [];
      balanceBefore = infos.map((i) => {
        const r = i as Record<string, unknown>;
        return {
          currency: String(r['currency']),
          total: Number(r['total_balance']),
          granted: Number(r['granted_balance']),
          topped_up: Number(r['topped_up_balance']),
        };
      });
    }
  }, 120_000);

  afterAll(async () => {
    if (!hasKey) return;
    // ---- 8. 余额收尾快照 + 对账 ----
    try {
      const balance = await api('GET', '/user/balance');
      const infos = (balance.json as { balance_infos?: unknown[] })?.balance_infos ?? [];
      const after = infos.map((i) => {
        const r = i as Record<string, unknown>;
        return {
          currency: String(r['currency']),
          total: Number(r['total_balance']),
          granted: Number(r['granted_balance']),
          topped_up: Number(r['topped_up_balance']),
        };
      });
      obs('balance after =', JSON.stringify(after));
      for (const b of balanceBefore) {
        const a = after.find((x) => x.currency === b.currency);
        if (a === undefined) continue;
        obs(
          `对账 ${b.currency}: 区间余额差 total=${(a.total - b.total).toFixed(6)} ` +
            `granted=${(a.granted - b.granted).toFixed(6)} ` +
            `topped_up=${(a.topped_up - b.topped_up).toFixed(6)}（赠送余额优先扣，现金差不等于总消耗）`,
        );
      }
    } catch (err) {
      obs('balance after 查询失败（不影响测试结果）:', String(err));
    }
    obs(`调用日志（${callLog.length} 次）:`);
    for (const c of callLog) {
      obs(' -', c.what, c.usage === undefined ? '' : JSON.stringify(c.usage));
    }
    obs(`共 ${observations.length} 条观测`);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // 2. OpenAI 方言
  // ---------------------------------------------------------------------------

  it('非流式对话：usage 字段原样记录', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: '你是一个简洁的助手，只用一句话回答。' },
        { role: 'user', content: '中国的首都是哪里？' },
      ],
      max_tokens: 64,
      temperature: 0,
      stream: false,
    });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    const usage = body['usage'] as Record<string, unknown>;
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!;
    const message = choice['message'] as Record<string, unknown>;
    obs('chat/completions 非流式 usage =', JSON.stringify(usage));
    obs('chat/completions 非流式 finish_reason =', String(choice['finish_reason']));
    obs(
      'chat/completions 非流式 content =',
      JSON.stringify(String(message['content']).slice(0, 80)),
    );
    callLog.push({ what: 'chat non-stream', usage });
    expect(typeof usage['prompt_tokens']).toBe('number');
    expect(typeof usage['completion_tokens']).toBe('number');
    expect(typeof usage['total_tokens']).toBe('number');
  }, 120_000);

  it('流式对话：SSE 形态、usage 搭末 chunk、[DONE]', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '用一句话介绍北京。' }],
      max_tokens: 64,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(r.status).toBe(200);
    const text = r.text;
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    obs(
      `流式 SSE：${lines.length} 个 data 行；含 keep-alive 注释 = ${text.includes(': keep-alive')}`,
    );
    const lastData = lines[lines.length - 1];
    obs('流式最后一个 data 行 =', (lastData ?? '').slice(0, 400));
    const hasDone = lines.some((l) => l.trim() === 'data: [DONE]');
    obs('流式以 data: [DONE] 结束 =', String(hasDone));
    expect(hasDone).toBe(true);
    // usage 搭在最后一个内容 chunk 上（无独立 usage-only chunk）
    let usage: Record<string, unknown> | undefined;
    for (const line of lines) {
      const payload = line.slice('data: '.length).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as Record<string, unknown>;
        const u = chunk['usage'] as Record<string, unknown> | null | undefined;
        if (u !== null && u !== undefined) usage = u;
      } catch {
        /* 忽略 */
      }
    }
    obs('流式 usage（末 chunk 搭车） =', JSON.stringify(usage));
    callLog.push({ what: 'chat stream', usage });
    expect(usage).toBeDefined();
  }, 120_000);

  it('工具调用：function calling 往返', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '北京现在的天气怎么样？请调用工具查询。' }],
      max_tokens: 256,
      thinking: { type: 'disabled' },
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询指定城市的当前天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: '城市名' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'required',
    });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!;
    const message = choice['message'] as Record<string, unknown>;
    const toolCalls = message['tool_calls'] as Array<Record<string, unknown>> | undefined;
    obs('工具调用 finish_reason =', String(choice['finish_reason']));
    obs('工具调用 tool_calls =', JSON.stringify(toolCalls));
    obs('工具调用 usage =', JSON.stringify(body['usage']));
    callLog.push({ what: 'chat tool call', usage: body['usage'] as Record<string, unknown> });
    expect(Array.isArray(toolCalls)).toBe(true);
    const fn = (toolCalls?.[0]?.['function'] ?? {}) as Record<string, unknown>;
    expect(typeof fn['arguments']).toBe('string'); // arguments 是 JSON 字符串
  }, 120_000);

  it('thinking 模式：reasoning_content 与 usage.reasoning_tokens', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '3 的 4 次方是多少？简要推理。' }],
      max_tokens: 1024,
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!;
    const message = choice['message'] as Record<string, unknown>;
    const usage = body['usage'] as Record<string, unknown>;
    const completionDetails = usage['completion_tokens_details'] as
      Record<string, unknown> | undefined;
    obs('thinking: message.reasoning_content 存在 =', typeof message['reasoning_content']);
    obs(
      'thinking: reasoning_content 前 80 字 =',
      String(message['reasoning_content'] ?? '').slice(0, 80),
    );
    obs('thinking: completion_tokens_details =', JSON.stringify(completionDetails));
    obs('thinking: usage =', JSON.stringify(usage));
    callLog.push({ what: 'chat thinking', usage });
    expect(typeof message['reasoning_content']).toBe('string');
    expect(typeof completionDetails?.['reasoning_tokens']).toBe('number');
  }, 120_000);

  it('上下文缓存：相同前缀连发两次，观察 cache hit 字段', async () => {
    const longPrefix =
      '请记住下面这段材料并只回答"记住了"：' +
      'AgentGateway 是一个 LLM API 网关，客户端可以用任意主流格式发请求，网关负责转成上游 provider 格式、再把响应转回客户端格式，并在链路上提供插件、内置工具、用量统计与计费等能力。'.repeat(
        3,
      );
    const req = {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: longPrefix },
        { role: 'user', content: '记住了吗？' },
      ],
      max_tokens: 32,
      thinking: { type: 'disabled' },
    };
    const first = await api('POST', '/chat/completions', req);
    expect(first.status).toBe(200);
    const second = await api('POST', '/chat/completions', req);
    expect(second.status).toBe(200);
    const u1 = (first.json as Record<string, unknown>)['usage'] as Record<string, unknown>;
    const u2 = (second.json as Record<string, unknown>)['usage'] as Record<string, unknown>;
    obs('缓存第一次 usage =', JSON.stringify(u1));
    obs('缓存第二次 usage =', JSON.stringify(u2));
    obs(
      '缓存判定：prompt_cache_hit_tokens 第一次 =',
      String(u1['prompt_cache_hit_tokens']),
      '第二次 =',
      String(u2['prompt_cache_hit_tokens']),
    );
    callLog.push({ what: 'cache probe #1', usage: u1 });
    callLog.push({ what: 'cache probe #2', usage: u2 });
    expect(typeof u2['prompt_cache_hit_tokens']).toBe('number');
  }, 120_000);

  it('基本参数：max_tokens 生效、temperature 不报错', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '数到 20。' }],
      max_tokens: 8,
      temperature: 0.5,
      thinking: { type: 'disabled' },
    });
    expect(r.status).toBe(200);
    const choice = (r.json as Record<string, unknown>)['choices'] as Array<Record<string, unknown>>;
    obs('max_tokens=8 → finish_reason =', String(choice[0]!['finish_reason']));
    expect(choice[0]!['finish_reason']).toBe('length');
  }, 120_000);

  // ---------------------------------------------------------------------------
  // 3. Anthropic 方言
  // ---------------------------------------------------------------------------

  it('Anthropic 方言：非流式 + system 顶层字段 + usage', async () => {
    const r = await api('POST', '/anthropic/v1/messages', {
      model: 'deepseek-flash',
      max_tokens: 64,
      system: '你是一个简洁的助手。',
      messages: [{ role: 'user', content: '中国的首都是哪里？' }],
    });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    const usage = body['usage'] as Record<string, unknown>;
    obs('anthropic 非流式 usage =', JSON.stringify(usage));
    obs('anthropic 非流式 stop_reason =', String(body['stop_reason']));
    obs('anthropic 非流式 content =', JSON.stringify(body['content']).slice(0, 200));
    callLog.push({ what: 'anthropic non-stream', usage });
    expect(typeof usage['input_tokens']).toBe('number');
    expect(typeof usage['output_tokens']).toBe('number');
  }, 120_000);

  it('Anthropic 方言：max_tokens 是否强制（省略后看是否 400）', async () => {
    const r = await api('POST', '/anthropic/v1/messages', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    obs(
      'anthropic 省略 max_tokens → status =',
      String(r.status),
      r.status === 200 ? '（HTTP 层非必填）' : r.text.slice(0, 200),
    );
    callLog.push({ what: 'anthropic no max_tokens' });
    // 官方文档：HTTP 层可选（SDK 才强制）。不断言 200，只记录实测。
    expect([200, 400]).toContain(r.status);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // 4. 跨 dialect：客户端 Anthropic 格式 → canonical → DeepSeek(OpenAI 面)
  // ---------------------------------------------------------------------------

  it('网关管道：anthropic 客户端 → deepseek.openai-chat（canonical 转换）', async () => {
    const recording = new RecordingTransport(new FetchTransport());
    const gateway = createGateway({
      mode: 'test',
      transport: recording,
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: KEY,
      }),
    });
    const sink = new MemoryClientSink();
    const out = await gateway.runner.run(
      {
        client_format: 'anthropic.messages',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'deepseek-flash',
            max_tokens: 64,
            system: '你是一个简洁的助手。',
            messages: [{ role: 'user', content: [{ type: 'text', text: '中国的首都是哪里？' }] }],
          }),
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/messages',
        query: {},
      },
      sink,
    );
    await gateway.usageEmitter.flush();
    const transport = recording;
    expect(out.error).toBeUndefined();
    const clientBody = JSON.parse(sink.text()) as Record<string, unknown>;
    obs('跨 dialect 回程（anthropic 格式）=', JSON.stringify(clientBody).slice(0, 300));
    // 上游收到的是 OpenAI Chat 格式（路径 + body 形状）
    const upstream = transport.requests[0];
    expect(upstream?.path).toBe('/chat/completions');
    const upstreamBody = JSON.parse(upstream!.body!.toString('utf8')) as Record<string, unknown>;
    obs('跨 dialect 上游请求体 =', JSON.stringify(upstreamBody).slice(0, 400));
    const messages = upstreamBody['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['role']).toBe('system');
    expect(typeof upstreamBody['max_completion_tokens']).toBe('number');
    expect(clientBody['type']).toBe('message');
  }, 120_000);

  // ---------------------------------------------------------------------------
  // 5. 服务端工具（全家桶）：三个接口
  // ---------------------------------------------------------------------------

  it('web 工具：Chat Completions 面 deepseek_web_search', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      max_tokens: 512,
      tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }],
      messages: [{ role: 'user', content: 'DeepSeek V4.1 是什么时候发布的？搜一下然后告诉我。' }],
    });
    obs('web 工具 chat 面 status =', String(r.status));
    if (r.status === 200) {
      const body = r.json as Record<string, unknown>;
      const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!;
      const message = choice['message'] as Record<string, unknown>;
      const usage = body['usage'] as Record<string, unknown>;
      obs(
        'web 工具 chat 面 message.server_tool_calls =',
        JSON.stringify(message['server_tool_calls']),
      );
      obs('web 工具 chat 面 message.annotations =', JSON.stringify(message['annotations']));
      obs('web 工具 chat 面 usage =', JSON.stringify(usage));
      obs('web 工具 chat 面 content 前 120 字 =', String(message['content']).slice(0, 120));
      callLog.push({ what: 'web tool chat', usage });
      expect(typeof usage['server_tool_use']).toBe('object');
    } else {
      obs('web 工具 chat 面错误体 =', r.text.slice(0, 300));
      callLog.push({ what: 'web tool chat (error)' });
    }
  }, 120_000);

  it('web 工具：Messages 面（name 必填）', async () => {
    const r = await api('POST', '/anthropic/v1/messages', {
      model: 'deepseek-flash',
      max_tokens: 512,
      thinking: { type: 'disabled' },
      tools: [
        { type: 'deepseek_web_search', name: 'deepseek_web_search' },
        { type: 'deepseek_read_url', name: 'deepseek_read_url' },
      ],
      messages: [{ role: 'user', content: 'DeepSeek V4.1 是什么时候发布的？搜一下。' }],
    });
    obs('web 工具 messages 面 status =', String(r.status));
    if (r.status === 200) {
      const body = r.json as Record<string, unknown>;
      const usage = body['usage'] as Record<string, unknown>;
      const serverToolUse = usage['server_tool_use'] as Record<string, unknown> | undefined;
      obs('web 工具 messages 面 usage =', JSON.stringify(usage));
      obs('web 工具 messages 面 server_tool_use =', JSON.stringify(serverToolUse));
      const content = body['content'] as Array<Record<string, unknown>>;
      obs(
        'web 工具 messages 面 content block 类型 =',
        JSON.stringify(content.map((b) => b['type'])),
      );
      callLog.push({ what: 'web tool messages', usage });
    } else {
      obs('web 工具 messages 面错误体 =', r.text.slice(0, 300));
    }
  }, 120_000);

  it('web 工具：Responses 面（只认 type，无 name）', async () => {
    const r = await api('POST', '/responses', {
      model: 'deepseek-flash',
      reasoning: { effort: 'low' },
      max_output_tokens: 512,
      tools: [{ type: 'deepseek_web_search' }],
      input: 'DeepSeek V4.1 是什么时候发布的？搜一下。',
    });
    obs('web 工具 responses 面 status =', String(r.status));
    if (r.status === 200) {
      const body = r.json as Record<string, unknown>;
      obs(
        'web 工具 responses 面 output 类型 =',
        JSON.stringify(
          ((body['output'] as Array<Record<string, unknown>>) ?? []).map((o) => o['type']),
        ),
      );
      obs('web 工具 responses 面 usage =', JSON.stringify(body['usage']));
      callLog.push({ what: 'web tool responses', usage: body['usage'] as Record<string, unknown> });
    } else {
      obs('web 工具 responses 面错误体 =', r.text.slice(0, 300));
      callLog.push({ what: 'web tool responses (error)' });
    }
  }, 120_000);

  // ---------------------------------------------------------------------------
  // 6. 独立端点
  // ---------------------------------------------------------------------------

  it('Search 端点：请求/响应 schema 实测', async () => {
    const client = new DeepSeekSearchClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const outcome = await client.search({ query: 'DeepSeek V4.1 发布', count: 3 });
    obs('search 结果条数 =', String(outcome.results.length));
    obs('search 首条 =', JSON.stringify(outcome.results[0]).slice(0, 400));
    obs('search usage =', JSON.stringify(outcome.usage));
    callLog.push({
      what: 'search',
      usage: outcome.usage.raw as Record<string, unknown> | undefined,
    });
    expect(outcome.results.length).toBeGreaterThan(0);
    const first = outcome.results[0]!;
    expect(typeof first['rerank_score']).toBe('number');
    expect(typeof first['authority']).toBe('number');
  }, 120_000);

  it('Fetch 端点：页面转 Markdown', async () => {
    const client = new DeepSeekFetchClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const outcome = await client.fetch({ url: 'https://api-docs.deepseek.com/' });
    obs('fetch title =', JSON.stringify(outcome.title));
    obs('fetch content 前 200 字 =', JSON.stringify(outcome.content.slice(0, 200)));
    callLog.push({ what: 'fetch' });
    expect(outcome.content.length).toBeGreaterThan(0);
  }, 120_000);

  it('OCR 端点：手搓 PNG（位图字体渲染）→ 识别', async () => {
    const png = renderTextPng('DEEPSEEK 2026');
    const client = new DeepSeekOcrClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const outcome = await client.recognize({
      file: png,
      filename: 'probe.png',
      purpose: 'text_recognition',
    });
    obs('OCR page_count =', String(outcome.response.page_count));
    obs('OCR pages =', JSON.stringify(outcome.response.pages).slice(0, 400));
    obs('OCR usage =', JSON.stringify(outcome.usage));
    callLog.push({ what: 'ocr', usage: outcome.usage.raw as Record<string, unknown> | undefined });
    expect(outcome.response.page_count).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('TTS → ASR 闭环：合成一段中文语音再转回文字', async () => {
    const tts = new DeepSeekTtsClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const speech = await tts.synthesize({
      text: '你好，这是 DeepSeek 语音合成的测试。',
      voice_id: 'stella',
      format: 'wav',
    });
    obs(
      'TTS audio 字节数 =',
      String(speech.audio.byteLength),
      'content-type =',
      speech.contentType,
    );
    obs('TTS usage =', JSON.stringify(speech.usage));
    callLog.push({ what: 'tts', usage: speech.usage.raw as Record<string, unknown> | undefined });

    const asr = new DeepSeekAsrClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const transcript = await asr.transcribe({ file: speech.audio, filename: 'tts.wav' });
    obs('ASR text =', JSON.stringify(transcript.text));
    obs('ASR duration_ms =', String(transcript.duration_ms));
    obs('ASR usage =', JSON.stringify(transcript.usage));
    callLog.push({
      what: 'asr',
      usage: transcript.usage.raw as Record<string, unknown> | undefined,
    });
    expect(transcript.text.length).toBeGreaterThan(0);
  }, 180_000);

  // ---------------------------------------------------------------------------
  // 7. 错误路径
  // ---------------------------------------------------------------------------

  it('错误路径：已退役模型名 deepseek-chat 的实际行为（记录映射目标）', async () => {
    // 官方公告 deepseek-chat 已于 2026-07-24 退役——但实测可能仍被静默路由。
    // 不断言 4xx：如实记录 status 与响应里的 model 字段（它被映射成了什么）。
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    });
    const body = (r.json ?? {}) as Record<string, unknown>;
    obs(
      'deepseek-chat → status =',
      String(r.status),
      '响应 model =',
      String(body['model']),
      'body =',
      r.text.slice(0, 200),
    );
    callLog.push({
      what: 'probe: retired model deepseek-chat',
      usage: body['usage'] as Record<string, unknown> | undefined,
    });
    expect([200, 400, 404]).toContain(r.status);
  }, 120_000);

  it('错误路径：空 messages', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'deepseek-flash',
      messages: [],
      max_tokens: 8,
    });
    obs('空 messages → status =', String(r.status), 'body =', r.text.slice(0, 300));
    callLog.push({ what: 'error: empty messages' });
    expect(r.status).toBeGreaterThanOrEqual(400);
  }, 120_000);

  it('错误路径：无效 key（sk-invalid，不用真 key 试错）', async () => {
    const r = await api(
      'POST',
      '/chat/completions',
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 },
      'sk-invalid',
    );
    obs('无效 key → status =', String(r.status), 'body =', r.text.slice(0, 300));
    callLog.push({ what: 'error: invalid key' });
    expect(r.status).toBe(401);
  }, 120_000);

  it('错误路径： anthropic 面的错误信封形态', async () => {
    const r = await api(
      'POST',
      '/anthropic/v1/messages',
      { model: 'deepseek-flash', messages: [] },
      'sk-invalid',
    );
    obs('anthropic 面无效 key → status =', String(r.status), 'body =', r.text.slice(0, 300));
    callLog.push({ what: 'error: anthropic invalid key' });
    expect(r.status).toBe(401);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // 9. 模型发现走网关装配路径（验证 discovery 客户端可用）
  // ---------------------------------------------------------------------------

  it('模型发现：DeepSeekModelDiscovery 能拉到元数据', async () => {
    const discovery = new DeepSeekModelDiscovery({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const models = await discovery.discover();
    obs('discovery 拿到模型 =', JSON.stringify(models.data.map((m) => m.id)));
    expect(models.data.length).toBeGreaterThan(0);
    for (const m of models.data) {
      expect(typeof m.context_window).toBe('number');
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 无 key 时的占位（保证 npm test 不失败）
// ---------------------------------------------------------------------------

describe.runIf(!hasKey)('DeepSeek 真实 API 冒烟（未提供 key，跳过）', () => {
  it.skip('DEEPSEEK_API_KEY 未设置：跳过真实 API 冒烟（node --env-file=.env 可启用）', () => {
    // 故意留空：skip 的理由写在用例名里
  });
});

// ---------------------------------------------------------------------------
// 5x7 位图字体 + 最小 PNG 编码器（OCR 探针用；无第三方依赖）
// ---------------------------------------------------------------------------

/** 渲染文本用的 5x7 位图字体（只含本探针需要的字符）。 */
const GLYPHS: Record<string, string[]> = {
  D: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** 把文本渲染成 8bit 灰度 PNG（黑字白底，2 倍缩放）。 */
function renderTextPng(text: string, scale = 6): Buffer {
  const glyphW = 5;
  const gap = 1;
  const width = text.length * (glyphW + gap) * scale + 2 * scale;
  const height = 9 * scale;
  // 8bit 灰度：0 = 黑，255 = 白
  const pixels = Buffer.alloc(width * height, 255);
  text.split('').forEach((ch, i) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < glyphW; col += 1) {
        if (glyph[row]![col] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = (i * (glyphW + gap) + col) * scale + dx + scale;
            const y = row * scale + dy + scale;
            if (x < width && y < height) pixels[y * width + x] = 0;
          }
        }
      }
    }
  });
  return encodePng(width, height, pixels);
}

/** 最小 PNG 编码器（8bit 灰度，无交错；zlib 来自 Node 内置）。 */
function encodePng(width: number, height: number, pixels: Buffer): Buffer {
  const zlib: typeof import('node:zlib') = requireZlib('node:zlib');
  // 每行前加 filter 字节 0
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const idat = zlib.deflateSync(raw);

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable: number[] | undefined;
function crc32(buf: Buffer): number {
  if (crcTable === undefined) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
