/**
 * tests/plugin-live-mimo.test.ts —— 插件系统 **5 个 hook 对 MiMo 真上游**各跑一遍。
 *
 * ## 为什么是 MiMo
 *
 * DeepSeek 那把 key 已作废；MiMo（小米 token-plan，OpenAI 兼容面）是仓库主人指定的
 * 「薅额度练手上游」。本文件**不接 MiMo provider**（那是另一条线程的事）——只在测试
 * 进程内用 `EnvCredentialResolver.registerAccessPath()` 登记一条 access path，复用既有
 * 的 openai.chat codec 打真上游。因此对仓库零侵入：不新增 provider、不改启动表、
 * 不碰 `providers/`。
 *
 * ## 跑法（key 只从环境变量读，.env 已被 gitignore）
 *
 *   node --env-file=.env npx vitest run tests/plugin-live-mimo.test.ts
 *
 * 没有 `MIMO_API_KEY` 时整个 describe 被 `describe.runIf` 跳过——**skip 而不是 fail**
 * （与 tests/deepseek-live.test.ts 同一立场）。
 *
 * ## 预算意识
 *
 * 每个场景都显式压 `max_output_tokens`（≤64）并用 `reasoning_effort: "none"` 关掉推理
 * ——实测不关时小预算会被思考吃光、content 为空。全部场景合计约 8 次上游调用、
 * 几百 token。
 *
 * ## 五个场景与「验证上游/客户端哪一侧」
 *
 * | hook | 场景 | 验证点 |
 * |---|---|---|
 * | onRequest | 注入 system + 关推理 | 上游 body 是改后的（RecordingTransport 留痕） |
 * | onResponse | 改写 canonical 响应文本 | 客户端 body 是改后的，上游未被动 |
 * | onStreamChunk | 逐帧给文本分片加包装 | 客户端 SSE 每帧都带包装 |
 * | onError | 不存在的模型名 / 错 key | hook 被调到 + 主链路结果未被改写 |
 * | onToolCall | 模型调 get_weather | 工具执行 + redaction-host 脱敏后追发给模型 |
 */

import { describe, expect, it, afterAll } from 'vitest';
import { createGateway } from '../composition-root.js';
import { FetchTransport } from '../gateway-core/transport.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../gateway-core/transport.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  Plugin,
  ToolUsePart,
} from '../ir/index.js';
import { asChatPayload, asChatResponsePayload } from '../ir/index.js';

// ---------------------------------------------------------------------------
// 上游接入（测试进程内登记，不动仓库任何文件）
// ---------------------------------------------------------------------------

const KEY = (process.env.MIMO_API_KEY ?? '').trim();
const hasKey = KEY.length > 0;
/**
 * 上游 base URL。`.env` 里带 `/v1` 后缀，而 `AccessPath.base_url` 的契约是
 * 「**不含路径**」（端点路径由 codec 给）——所以这里把末尾的 `/v1` 与斜杠归一掉，
 * 让 `new URL('/v1/chat/completions', base)` 自己拼出来。
 */
const BASE = (process.env.MIMO_BASE_URL ?? 'https://token-plan-cn.xiaomimimo.com')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');
/** 便宜档模型：mimo-v2.6-flash（GET /v1/models 实测存在）。 */
const MODEL = 'mimo-v2.6-flash';
const ACCESS_PATH = 'mimo.openai-chat';

/** 观测收集器：把「实测结论」攒起来，收尾时统一打印（进报告）。 */
const observations: string[] = [];
function obs(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  observations.push(line);
  process.stdout.write(`[obs] ${line}\n`);
}

/**
 * 记录型 transport：包一层 FetchTransport，把每个上游请求记下来
 * （FetchTransport 本身不记录——只有 ScriptedTransport 记录）。
 * 这是「验证上游收到的是改后的」的唯一手段。
 */
class RecordingTransport implements Transport {
  readonly requests: Array<{
    method: string;
    base_url: string;
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
  }> = [];
  constructor(private readonly inner: Transport) {}
  async send(req: UpstreamRequest): Promise<UpstreamResponse> {
    this.requests.push({
      method: req.method,
      base_url: req.base_url,
      path: req.path,
      headers: { ...req.headers },
      ...(req.body === undefined ? {} : { body: req.body }),
    });
    return this.inner.send(req);
  }
  /** 第 n 个上游请求的 JSON body。 */
  json(n = 0): Record<string, unknown> {
    const body = this.requests[n]?.body;
    if (body === undefined) throw new Error(`上游请求 ${n} 没有 body`);
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  }
}

/**
 * 起一个打 MiMo 真上游的网关。
 *
 * 三件事：
 *   1. `EnvCredentialResolver` + `registerAccessPath`：把 `MIMO_API_KEY` /
 *      `MIMO_BASE_URL` 接成一条 `mimo.openai-chat` access path（Bearer 鉴权走
 *      `authHeadersFor` 的 default 分支，正是 MiMo 的形状）；
 *   2. routeTable：客户端模型名直接映射到这条 path（无别名改写）；
 *   3. transport：RecordingTransport(FetchTransport())——真上游 + 请求留痕。
 */
function makeLiveGateway(plugins: Plugin[] = [], key: string = KEY, extraAliases: string[] = []) {
  const transport = new RecordingTransport(new FetchTransport());
  const resolver = new EnvCredentialResolver(undefined, undefined, {
    MIMO_API_KEY: key,
    MIMO_BASE_URL: BASE,
  });
  resolver.registerAccessPath({
    id: ACCESS_PATH,
    label: 'MiMo (OpenAI 兼容)',
    format: 'openai.chat',
    usage_source: 'provider',
    model_namespaces: ['mimo'],
    requires_credential: true,
    base_url: BASE,
    key_env: 'MIMO_API_KEY',
  });
  const gateway = createGateway({
    mode: 'test',
    transport,
    plugins: plugins.map((plugin) => ({ plugin })),
    credentialResolver: resolver,
    // 数据面鉴权显式关掉虚拟 key 模式：本文件测的是插件 hook，不是鉴权。
    // `.env` 里可能有 `AG_VIRTUAL_KEYS=1`（deny-first 下它会盖过 mode:'test' 的
    // permissive 兜底），不显式关掉会让整个文件 401——与插件无关。
    config: { virtualKeysEnabled: false },
    routeTable: {
      aliases: {
        [MODEL]: { targets: [{ access_path: ACCESS_PATH, provider: 'mimo', model: MODEL }] },
        // 额外别名（测试专用）：让"上游真的返回错误"可复现——例如指向一个
        // 上游不认识的模型名，从而拿到一次**真** 4xx 而不是本地路由失败。
        ...Object.fromEntries(
          extraAliases.map((m) => [
            m,
            { targets: [{ access_path: ACCESS_PATH, provider: 'mimo', model: m }] },
          ]),
        ),
      },
    },
  });
  const sink = new MemoryClientSink();
  return { gateway, sink, transport };
}

/** 发一次 OpenAI Chat 请求（客户端格式与上游同方言）。 */
async function chat(
  gw: ReturnType<typeof makeLiveGateway>,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; fast_path: boolean; error?: unknown }> {
  const out = await gw.gateway.runner.run(
    {
      client_format: 'openai.chat',
      raw_body: Buffer.from(JSON.stringify(body)),
      headers: { 'content-type': 'application/json' },
      path: '/v1/chat/completions',
      query: {},
    },
    gw.sink,
  );
  await gw.gateway.usageEmitter.flush();
  return {
    status: out.status,
    text: gw.sink.text(),
    fast_path: out.fast_path,
    ...(out.error === undefined ? {} : { error: out.error }),
  };
}

/** 关推理 + 小预算的公共参数（MiMo 默认开思考，不关会把 max_tokens 吃光）。 */
function cheap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    max_output_tokens: 64,
    thinking: { enabled: false, effort: 'none' },
    ...overrides,
  };
}

/** 取客户端响应体 choices[0].message.content（非空串）。 */
function clientContent(text: string): string {
  const body = JSON.parse(text) as Record<string, unknown>;
  const choices = body['choices'] as Array<Record<string, unknown>>;
  const message = choices[0]!['message'] as Record<string, unknown>;
  const content = message['content'];
  return typeof content === 'string' ? content : '';
}

const describeLive = describe.runIf(hasKey);

describeLive('MiMo 真上游：5 个 hook 各跑一遍', () => {
  afterAll(() => {
    obs(`MiMo base = ${BASE}，model = ${MODEL}，共 ${observations.length} 条观测`);
  });

  // -------------------------------------------------------------------------
  // 1. onRequest
  // -------------------------------------------------------------------------

  it('onRequest：注入 system + 关推理 → 上游收到的是改后的 canonical', async () => {
    const seen: CanonicalRequestEnvelope[] = [];
    const injector: Plugin = {
      manifest: { name: 'prompt-injector', version: '1.0.0', hooks: ['onRequest'] },
      onRequest: (req) => {
        seen.push(structuredClone(req));
        const payload = asChatPayload(req);
        if (payload === undefined) return undefined;
        payload.system = [{ text: '你是一个简洁的助手，只回答城市名，不要解释。' }];
        payload.params = { ...payload.params, thinking: { enabled: false, effort: 'none' } };
        return req; // 改写：返回同一个（已变更的）canonical
      },
    };
    const gw = makeLiveGateway([injector]);
    const res = await chat(gw, {
      model: MODEL,
      // 客户端是 OpenAI Chat 方言：用 max_tokens（canonical 的 max_output_tokens）
      max_tokens: 64,
      messages: [{ role: 'user', content: '中国的首都是哪里？' }],
    });

    expect(res.error).toBeUndefined();
    // ---- 插件侧：看到的是 canonical ----
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ir_version).toBe('ag-ir/1');
    expect(seen[0]!.kind).toBe('chat');
    // 插件看到的是 canonical 消息结构（role + parts），不是厂商 wire 的 messages 数组
    const seenMessages = asChatPayload(seen[0]!)?.messages ?? [];
    expect(seenMessages).toHaveLength(1);
    expect(seenMessages[0]!.role).toBe('user');

    // ---- 上游侧：收到的是「canonical → wire」的产物 ----
    expect(gw.transport.requests[0]!.path).toBe('/v1/chat/completions');
    expect(gw.transport.requests[0]!.base_url).toBe(BASE);
    const upstream = gw.transport.json();
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['role']).toBe('system');
    expect(messages[0]!['content']).toBe('你是一个简洁的助手，只回答城市名，不要解释。');
    expect(messages[1]!['content']).toBe('中国的首都是哪里？');
    // 关推理确实到了上游（否则 MiMo 会先思考、content 为空）
    expect(upstream['reasoning_effort']).toBe('none');
    expect(upstream['max_completion_tokens']).toBe(64);

    // ---- 客户端侧：拿到的是真上游的回答 ----
    // 不断言具体文字（模型输出不确定），只断言"非空 + 真是上游回的"
    const content = clientContent(res.text);
    obs('onRequest 上游 messages =', JSON.stringify(messages));
    obs('onRequest 上游 reasoning_effort =', String(upstream['reasoning_effort']));
    obs('onRequest 客户端 content =', JSON.stringify(content));
    expect(content.length).toBeGreaterThan(0);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 2. onResponse
  // -------------------------------------------------------------------------

  it('onResponse：改写 canonical 响应 → 客户端拿到的是改后的', async () => {
    // before / after 两份快照：证明插件确实拿到了 canonical、也确实改写了它
    const before: CanonicalResponseEnvelope[] = [];
    const after: CanonicalResponseEnvelope[] = [];
    const rewriter: Plugin = {
      manifest: { name: 'response-rewriter', version: '1.0.0', hooks: ['onResponse'] },
      onResponse: (res) => {
        before.push(structuredClone(res));
        const payload = asChatResponsePayload(res);
        const first = payload?.message.parts.find((p) => p.type === 'text');
        if (first !== undefined && first.type === 'text') {
          first.text = `${first.text}（由 onResponse 插件改写）`;
        }
        after.push(structuredClone(res));
        return res;
      },
    };
    const gw = makeLiveGateway([rewriter]);
    const res = await chat(
      gw,
      cheap({ messages: [{ role: 'user', content: '中国的首都是哪里？' }] }),
    );

    expect(res.error).toBeUndefined();
    // 前置条件：必须走慢路径。MiMo 这条 access path 没有能力矩阵条目，因此
    // `fast_path_eligible` 恒 false——将来若补了条目，这里会先红，提醒补测。
    // （补测时不用担心 §4.4：full-canonical 的响应侧插件自己就会禁用 fast path，
    //  onResponse 一定跑得到。）
    expect(res.fast_path).toBe(false);
    // ---- 插件侧：拿到的是真上游解出来的 canonical 响应（不是厂商 wire）----
    expect(before).toHaveLength(1);
    expect(before[0]!.ir_version).toBe('ag-ir/1');
    expect(before[0]!.usage.units.tokens?.input_tokens).toBeGreaterThan(0);
    // 取第一个**文本** part：MiMo 偶尔仍会回一段 reasoning（thinking part 在前），
    // 因此不能假定 parts[0] 就是 text。
    const pluginParts = asChatResponsePayload(after[0]!)?.message.parts ?? [];
    const pluginTextPart = pluginParts.find((p) => p.type === 'text');
    expect(pluginTextPart).toBeDefined();
    const pluginText = pluginTextPart?.type === 'text' ? pluginTextPart.text : '';
    expect(pluginText.length).toBeGreaterThan(0);
    // 插件确实改写了它自己那一份 canonical
    expect(pluginText).toContain('（由 onResponse 插件改写）');

    // ---- 客户端侧：改写**到达**客户端（2026-11-16 修，§4.3）----
    // 修法：S8 非流式只编码不写出，字节暂存 state.client_bytes；S9 跑完插件链后
    // 重新编码覆盖它；Runner 在 S9 之后才 flush 给 sink。阶段编号与顺序不变。
    const content = clientContent(res.text);
    obs('onResponse 插件改写的 canonical =', JSON.stringify(pluginTextPart));
    obs('onResponse 客户端实际拿到 =', JSON.stringify(content));
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('（由 onResponse 插件改写）');

    // ---- 同一份改写后的 canonical 也必须进入 S10 记账（不许「客户端 A、账 B」）----
    const rec = gw.gateway.usageSink!.records[0]!;
    obs('onResponse UsageRecord status =', rec.status, 'finish_reason =', rec.finish_reason);
    expect(rec.status).toBe('success');
    // usage 数字仍来自上游（插件只改文本，没改 usage）——证明改写没有顺手改账
    expect(rec.usage.units.tokens?.input_tokens).toBeGreaterThan(0);
    // 上游那一路没被动过（改写只发生在 canonical 侧，回程才编码）
    const upstream = gw.transport.json();
    expect((upstream['messages'] as unknown[]).length).toBe(1);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 3. onStreamChunk
  // -------------------------------------------------------------------------

  it('onStreamChunk：流式回合里逐帧改写 → 客户端 SSE 每帧都是改后的', async () => {
    const seen: CanonicalStreamEvent[] = [];
    const framer: Plugin = {
      manifest: { name: 'frame-rewriter', version: '1.0.0', hooks: ['onStreamChunk'] },
      onStreamChunk: (ev) => {
        seen.push(structuredClone(ev));
        if (ev.type === 'part.delta' && ev.delta.type === 'text') {
          // 逐帧改写：给每个文本分片加一个前后标记
          return { ...ev, delta: { type: 'text', text: `[${ev.delta.text}]` } };
        }
        return ev;
      },
    };
    const gw = makeLiveGateway([framer]);
    const res = await chat(
      gw,
      cheap({
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: '数到三' }],
      }),
    );

    expect(res.error).toBeUndefined();
    // ---- 插件侧：拿到的是 canonical 帧序列 ----
    expect(seen.length).toBeGreaterThan(0);
    const textFrames = seen.filter((e) => e.type === 'part.delta' && e.delta.type === 'text');
    expect(textFrames.length).toBeGreaterThan(0);

    // ---- 客户端侧：每个 data 行的 content 都带上了标记 ----
    const dataLines = res.text.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines.length).toBeGreaterThan(0);
    const contents: string[] = [];
    for (const line of dataLines) {
      const payload = line.slice('data: '.length).trim();
      if (payload === '[DONE]') continue;
      const chunk = JSON.parse(payload) as Record<string, unknown>;
      const choices = chunk['choices'] as Array<Record<string, unknown>> | undefined;
      const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
      const content = delta?.['content'];
      if (typeof content === 'string' && content !== '') contents.push(content);
    }
    obs('onStreamChunk canonical 文本帧数 =', String(textFrames.length));
    obs('onStreamChunk 客户端逐帧 content =', JSON.stringify(contents));
    expect(contents.length).toBeGreaterThan(0);
    for (const c of contents) {
      expect(c.startsWith('[') && c.endsWith(']')).toBe(true);
    }
    // 逐帧改写保留了帧数（一进一出），没有吞帧也没有并帧
    expect(contents.length).toBe(textFrames.length);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 4. onError
  // -------------------------------------------------------------------------

  it('onError：真失败（不存在的模型名）→ hook 被调到，且不改写主链路结果', async () => {
    const errors: Array<{ code: string; http_status: number; message: string }> = [];
    const observer: Plugin = {
      manifest: { name: 'error-observer', version: '1.0.0', hooks: ['onError'] },
      onError: (err) => {
        errors.push({ code: err.code, http_status: err.http_status ?? 0, message: err.message });
      },
    };
    const BOGUS = 'mimo-no-such-model-xyz';
    const gw = makeLiveGateway([observer], KEY, [BOGUS]);
    const res = await chat(gw, {
      model: BOGUS,
      max_output_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });

    // ---- hook 侧：onError 被调到，拿到的是 canonical 错误 ----
    expect(errors.length).toBeGreaterThanOrEqual(1);
    obs('onError 收到的 canonical 错误 =', JSON.stringify(errors));
    expect(errors[0]!.http_status).toBe(400);
    expect(errors[0]!.message).toContain('Unsupported model');

    // ---- 主链路侧：结果没被 hook 改写（onError 不改变控制流，30 §3）----
    expect(res.error).toBeDefined();
    const body = JSON.parse(res.text) as Record<string, unknown>;
    expect(body['error']).toBeDefined();
    expect(res.status).toBe(400); // 首字节前失败 → 直接映射状态码
    expect(gw.sink.startStatus).toBe(400);
    obs('onError 客户端 status =', String(res.status), 'body =', res.text.slice(0, 200));
    // 上游确实打过去了（失败是真的，不是本地路由失败）
    expect(gw.transport.requests).toHaveLength(1);
    expect(gw.transport.json()['model']).toBe(BOGUS);
  }, 120_000);

  it('onError：真失败（错误 key）→ hook 同样被调到，客户端 401', async () => {
    const errors: string[] = [];
    const observer: Plugin = {
      manifest: { name: 'error-observer-badkey', version: '1.0.0', hooks: ['onError'] },
      onError: (err) => {
        errors.push(`${err.code}/${err.http_status ?? 0}`);
      },
    };
    // 换一把错 key：走同一条 makeLiveGateway，只把 key 换掉
    const gw = makeLiveGateway([observer], 'sk-invalid-not-a-real-key');
    const res = await chat(gw, cheap({ messages: [{ role: 'user', content: 'hi' }] }));

    obs('onError(错 key) hook 收到 =', JSON.stringify(errors), 'status =', String(res.status));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(res.error).toBeDefined();
    expect(res.status).toBe(401);
    // 上游那一路确实带着错 key 打过去了
    expect(gw.transport.requests).toHaveLength(1);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 5. onToolCall
  // -------------------------------------------------------------------------

  it('onToolCall：模型调一次工具 → 插件执行 + redaction-host 脱敏（密钥到不了模型）', async () => {
    const calls: ToolUsePart[] = [];
    const FAKE_SECRET = 'sk-live-abcdefgh12345678ijklmnop'; // 假 key，形态像真 key
    const exec: Plugin = {
      manifest: { name: 'weather-exec', version: '1.0.0', hooks: ['onToolCall'] },
      onToolCall: (call) => {
        calls.push(structuredClone(call));
        // 模拟一个"实现疏忽"的工具：把上游响应里的密钥原样返回
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: `北京晴，26℃。调试信息：upstream_key=${FAKE_SECRET}`,
        };
      },
    };
    const gw = makeLiveGateway([exec]);
    const res = await chat(
      gw,
      cheap({
        messages: [{ role: 'user', content: '北京现在天气如何？请调用工具查询。' }],
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
        ag_agentic_loop: true,
      }),
    );

    expect(res.error).toBeUndefined();
    // ---- 插件侧：onToolCall 拿到的是 canonical tool_use part ----
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('tool_use');
    expect(calls[0]!.name).toBe('get_weather');
    expect(typeof calls[0]!.input).toBe('object');
    obs('onToolCall 收到的 call =', JSON.stringify(calls[0]));

    // ---- 两轮：第一轮 tool_calls，第二轮带 tool_result ----
    expect(gw.transport.requests.length).toBeGreaterThanOrEqual(2);
    const second = gw.transport.json(1);
    const messages = second['messages'] as Array<Record<string, unknown>>;
    const toolMessages = messages.filter((m) => m['role'] === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);

    // ---- 脱敏：模型看到的是占位符，不是密钥 ----
    const toolText = String(toolMessages[0]!['content']);
    obs('onToolCall 追发给模型的 tool 消息 =', JSON.stringify(toolText));
    expect(toolText).toContain('北京晴');
    expect(toolText).toContain('<redacted_key>');
    expect(toolText).not.toContain(FAKE_SECRET);

    // ---- 客户端侧：最终答案 ----
    const content = clientContent(res.text);
    obs('onToolCall 客户端最终 content =', JSON.stringify(content));
    expect(content.length).toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 无 key 时的占位（保证 npm test 不失败）
// ---------------------------------------------------------------------------

describe.runIf(!hasKey)('MiMo 真上游：插件 hook（未提供 key，跳过）', () => {
  it.skip('MIMO_API_KEY 未设置：跳过真上游插件场景（node --env-file=.env 可启用）', () => {
    // 故意留空：skip 的理由写在用例名里
  });
});
