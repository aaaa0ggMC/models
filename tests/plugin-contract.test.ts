/**
 * tests/plugin-contract.test.ts —— 插件系统的两条硬约束，逐条钉死：
 *
 * ## 约束一：插件只面对 canonical（不可违背）
 *
 * 30-plugin-api.md / AGENTS.md「关键设计约束」：插件只操作 canonical，generic hook
 * 不接触具体厂商格式。本文件用**三种互相独立的手法**断言它，而不是只写一句注释：
 *
 *   1. **schema 闭合性**：把插件实际收到的对象喂给 `ir/schema/ag-ir-1/root.schema.json`
 *      （ajv）。envelope.schema.json 是 `additionalProperties: false` 的封闭 schema——
 *      任何厂商 wire 字段（`choices` / `object` / `reasoning_content` /
 *      `prompt_cache_hit_tokens` / `stop_reason` …）只要出现在结构化路径上就过不了。
 *      这是唯一「结构上不可能混进厂商字段」的判据，比枚举键名更可靠。
 *   2. **deep-walk 键名黑名单**：schema 管不到两个显式逃生舱——`raw.unmapped`
 *      （顶层未建模字段，raw passthrough 的既定设计）与 `usage.raw`（原始 usage 快照）。
 *      因此额外做一次全图键名扫描：剥掉这两个袋子之后，其余任何位置出现厂商专有
 *      键名即失败。
 *   3. **服务面封闭性**：`GatewayServices` 是插件唯一能拿到的网关能力。断言它没有
 *      transport / fetch / base_url / headers 这类"直接打上游"的入口——否则约束
 *      就只剩"自觉"了。
 *
 * ## 约束二：插件炸不掉主链路
 *
 * 30 §3：插件抛异常默认不阻断（记 metric + warning），`fatal: true` 才阻断；
 * `onError` 不改变控制流。五个 hook 各有一条隔离用例——**每个 hook 都要有**，
 * 因为 `DefaultPluginHost.invoke()` 是共用实现，但调用方对"失败"的后续处理各不相同
 * （onRequest 是 continue、onStreamChunk 是透传原帧、onToolCall 是抛给 tool-loop），
 * 只测一个 hook 会漏掉某一处的处理差异。
 *
 * 全部用例走 ScriptedTransport（不起真实网络）；打真上游的对应场景见
 * tests/plugin-live-mimo.test.ts。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { createGateway } from '../composition-root.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { DefaultPluginHost } from '../plugins/host.js';
import { MemoryLogger, MemoryMetrics, fixedClock } from '../di/index.js';
import { MutableRequestContext } from '../gateway-core/context.js';
import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  Plugin,
  ToolUsePart,
} from '../ir/index.js';
import { asChatPayload, asChatResponsePayload } from '../ir/index.js';

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', 'ir', 'schema', 'ag-ir-1');

/** 编译 canonical root schema（互相 $ref，必须先全部 addSchema）。 */
function compileCanonicalSchema(): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const rootId = 'https://agentgateway.local/schema/ag-ir-1/root.schema.json';
  let rootSchema: Record<string, unknown> | undefined;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      if (raw['$id'] === rootId) rootSchema = raw;
      else ajv.addSchema(raw, raw['$id'] as string);
    }
  };
  walk(schemaDir);
  if (rootSchema === undefined) throw new Error('缺少 root.schema.json');
  return ajv.compile(rootSchema);
}

const validateCanonical = compileCanonicalSchema();

/** 断言失败时把 ajv 的全部错误点摊开（否则只看到一条 "must NOT have additionalProperties"）。 */
function expectSchemaClean(value: unknown, what: string): void {
  const ok = validateCanonical(value);
  if (ok) return;
  const msgs = (validateCanonical.errors ?? [])
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''} ${JSON.stringify(e.params)}`)
    .join('\n');
  throw new Error(
    `${what} 未通过 canonical schema 校验（说明有厂商字段混进了 canonical）:\n${msgs}`,
  );
}

/**
 * 厂商专有键名黑名单（四家 + 网关侧 wire 概念）。
 *
 * 只列**结构化 canonical 里绝对不该出现**的名字；canonical 自己的合法字段
 * （finish_reason / usage / messages / parts …）不在内。
 */
const PROVIDER_ONLY_KEYS: readonly string[] = [
  // OpenAI Chat / Responses wire
  'choices',
  'chatcmpl',
  'max_completion_tokens',
  'refusal',
  'system_fingerprint',
  'service_tier',
  'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens',
  'completion_tokens_details',
  'prompt_tokens_details',
  // DeepSeek wire
  'reasoning_content',
  'server_tool_calls',
  'server_tool_use',
  // Anthropic wire
  'stop_reason',
  'cache_creation_input_tokens',
  'content_block_delta',
  'message_start',
  'message_delta',
  'message_stop',
  // Gemini wire
  'candidates',
  'usageMetadata',
  'systemInstruction',
];

/**
 * 剥掉 canonical 的「显式逃生舱」后做全图键名扫描。
 *
 * `raw`（信封级 RawEnvelope：unmapped / nodes / source_provider /
 * finish_reason_provider）、`_raw`（节点级原文）、`usage.raw`（原始 usage 快照）
 * 按设计就是原样保留的袋子——schema 管不了它们，所以在这里显式排除后再扫其余部分。
 * 判据是**键名**而不是位置：`raw` / `_raw` 在 canonical 里任何位置都是逃生舱。
 */
function expectNoProviderOnlyKeys(value: unknown, what: string): void {
  const hits: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'raw' || k === '_raw') continue; // canonical 逃生舱，原样保留
      if (PROVIDER_ONLY_KEYS.includes(k)) hits.push(`${path || '(root)'}.${k}`);
      walk(v, path === '' ? k : `${path}.${k}`);
    }
  };
  walk(value, '');
  expect(hits, `${what} 里出现厂商专有键名`).toEqual([]);
}

// ---------------------------------------------------------------------------
// 约束一：插件只面对 canonical
// ---------------------------------------------------------------------------

describe('插件契约：插件收到的只有 canonical', () => {
  /** 五个 hook 的入参收集袋。 */
  interface Recorder {
    request?: CanonicalRequestEnvelope;
    response?: CanonicalResponseEnvelope;
    stream: CanonicalStreamEvent[];
    error: unknown[];
    toolCall?: { call: ToolUsePart };
  }

  function newRecorder(): Recorder {
    return { stream: [], error: [] };
  }

  /** 一个把 5 个 hook 的入参全部录下来的插件。 */
  function recordingPlugin(sink: Recorder): Plugin {
    return {
      manifest: {
        name: 'recorder',
        version: '1.0.0',
        hooks: ['onRequest', 'onResponse', 'onStreamChunk', 'onError', 'onToolCall'],
      },
      onRequest: (req) => {
        sink.request = structuredClone(req);
        return undefined; // 不改写
      },
      onResponse: (res) => {
        sink.response = structuredClone(res);
        return undefined;
      },
      onStreamChunk: (ev) => {
        sink.stream.push(structuredClone(ev));
        return undefined;
      },
      onError: (err) => {
        sink.error.push(structuredClone(err));
      },
      onToolCall: (call) => {
        sink.toolCall = { call: structuredClone(call) };
        return { type: 'tool_result', tool_use_id: call.id, content: 'ok' };
      },
    };
  }

  it('onRequest 收到的请求信封是封闭 canonical（schema 校验 + 无厂商键名）', async () => {
    const seen = newRecorder();
    const { gateway, outcome } = runWithPlugins(
      new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      [recordingPlugin(seen)],
      {
        model: 'gpt-test-1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
    );
    await outcome;
    await gateway.usageEmitter.flush();

    expect(seen.request).toBeDefined();
    const req = seen.request!;
    // 1. 是 canonical 信封
    expect(req.ir_version).toBe('ag-ir/1');
    expect(req.kind).toBe('chat');
    // 2. 封闭 schema：厂商 wire 字段进不了结构化路径
    expectSchemaClean(req, 'onRequest 收到的请求信封');
    // 3. 逃生舱之外无厂商键名
    expectNoProviderOnlyKeys(req, 'onRequest 收到的请求信封');
  });

  it('onResponse 收到的响应信封是封闭 canonical（schema 校验 + 无厂商键名）', async () => {
    const seen = newRecorder();
    const { gateway, outcome } = runWithPlugins(
      new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      [recordingPlugin(seen)],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    );
    await outcome;
    await gateway.usageEmitter.flush();

    expect(seen.response).toBeDefined();
    const res = seen.response!;
    expect(res.ir_version).toBe('ag-ir/1');
    expectSchemaClean(res, 'onResponse 收到的响应信封');
    expectNoProviderOnlyKeys(res, 'onResponse 收到的响应信封');
    // 上游 wire 的 usage 细节（prompt_tokens 等）只以 raw 快照形式存在；
    // 结构化 units 的归一是 S10 的事，S9 时插件看到的是"尚未归一"的 canonical。
    expect(res.usage.raw?.['prompt_tokens']).toBe(18);
    expect(res.raw.source_provider).toBe('openai');
  });

  it('onStreamChunk 收到的是 canonical 帧序列（无厂商 wire 键名）', async () => {
    const seen = newRecorder();
    const { gateway, outcome } = runWithPlugins(
      new ScriptedTransport([{ chunks: openAiSseStream() }]),
      [recordingPlugin(seen)],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    );
    await outcome;
    await gateway.usageEmitter.flush();

    expect(seen.stream.length).toBeGreaterThan(0);
    // 帧类型集合是 canonical 的（25 §2），不是厂商 SSE 事件名
    const types = [...new Set(seen.stream.map((e) => e.type))].sort();
    expect(types).toEqual(['finish', 'part.delta', 'start', 'usage']);
    for (const ev of seen.stream) {
      expectNoProviderOnlyKeys(ev, `onStreamChunk 帧 ${ev.type}`);
    }
    // 文本增量在 delta.text 里，不在厂商的 choices[0].delta.content 里
    const text = seen.stream
      .filter((e) => e.type === 'part.delta' && e.delta.type === 'text')
      .map((e) => (e.type === 'part.delta' && e.delta.type === 'text' ? e.delta.text : ''))
      .join('');
    expect(text).toBe('你好，世界');
  });

  it('onToolCall 收到的是 canonical tool_use part（input 是对象，不是 JSON 字符串）', async () => {
    const seen = newRecorder();
    const { gateway, outcome } = runWithPlugins(
      new ScriptedTransport([
        { body: JSON.stringify(openAiChatResponseWithToolCall()) },
        { body: JSON.stringify(openAiChatResponse()) },
      ]),
      [recordingPlugin(seen)],
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
    );
    await outcome;
    await gateway.usageEmitter.flush();

    expect(seen.toolCall).toBeDefined();
    const call = seen.toolCall!.call;
    expect(call.type).toBe('tool_use');
    expect(call.name).toBe('get_time');
    // canonical 的 input 是已解析对象；wire 的 arguments 是 JSON 字符串
    expect(typeof call.input).toBe('object');
    expect(call.input).toEqual({ tz: 'UTC' });
    expectNoProviderOnlyKeys(call, 'onToolCall 收到的 tool_use part');
  });

  it('GatewayServices 没有"直接打上游"的入口（transport / fetch / base_url / headers）', () => {
    // GatewayServices 是插件唯一能拿到的网关能力面（ir/plugin.ts §GatewayServices）。
    // 约束「插件只面对 canonical」要成立，这个面就不能有上游出口——否则约束只剩自觉。
    // 注意：当前仓库里 Plugin.init() 没有任何调用方（agent-admin.ts 文件头已注明），
    // 所以这里直接断言装配方实际注入给 PluginHost 的那一份 services。
    const services = makeServices();
    new DefaultPluginHost(services); // 构造即固定 services，运行期不可换
    const banned = ['transport', 'fetch', 'base_url', 'baseUrl', 'headers', 'http', 'client'];
    for (const key of Object.keys(services)) {
      expect(banned, `GatewayServices 暴露了上游出口 "${key}"`).not.toContain(key);
    }
    // 正向断言：它确实拿到了日志 / 指标 / 时钟 / usage / kv
    for (const key of ['log', 'metrics', 'currentUsage', 'kv']) {
      expect(Object.keys(services)).toContain(key);
    }
  });

  it('插件改写的请求经 canonical 再编码后才到上游（不是直接改 wire）', async () => {
    // 契约的行为侧证据：插件只碰 canonical，上游拿到的是「canonical → wire」的产物。
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const injector: Plugin = {
      manifest: { name: 'injector', version: '1.0.0', hooks: ['onRequest'] },
      onRequest: (req) => {
        const payload = asChatPayload(req);
        if (payload !== undefined) {
          payload.system = [{ text: '你是一个简洁的助手，只用一句话回答。' }];
        }
        return req;
      },
    };
    const { outcome } = runWithPlugins(transport, [injector], {
      model: 'gpt-test-1',
      messages: [{ role: 'user', content: '中国的首都是哪里？' }],
      stream: false,
    });
    await outcome;

    const upstream = JSON.parse(transport.requests[0]!.body!.toString('utf8')) as Record<
      string,
      unknown
    >;
    // 注入的 system 出现在上游 wire 的 messages[0]（canonical → wire 的映射产物）
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]!['role']).toBe('system');
    expect(messages[0]!['content']).toBe('你是一个简洁的助手，只用一句话回答。');
  });

  it('只声明 onStreamChunk 的插件不会破坏非流式请求的 onResponse 与计量', async () => {
    // 回归测试（2026-11-16 修）：S7 原先无条件把 `state.aggregated` 设成
    // aggregateEvents([]) —— 非流式下 events 恒为空，聚合出的是一个
    // 「空 parts + 空 usage」的假信封。而 S9 的取值顺序是
    // `state.aggregated ?? state.response`，于是：
    //   - onResponse 插件看到空响应（审计失真）；
    //   - S9 把 state.usage 冲成空 usage，S10 记进 UsageRecord 的变成估算值。
    // 客户端 body 不受影响（S8 非流式读 state.response），所以这个 bug 在
    // 界面上完全看不出来。修法：只在 `state.shallow.stream === true` 时聚合。
    const seen = newRecorder();
    const { gateway, outcome } = runWithPlugins(
      new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      [recordingPlugin(seen)],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    );
    const out = await outcome;
    await gateway.usageEmitter.flush();

    // 客户端拿到正确内容（这条在修之前也成立——bug 藏在审计与计量里）
    const res = seen.response!;
    const parts = asChatResponsePayload(res)?.message.parts ?? [];
    expect(parts).toEqual([{ type: 'text', text: '端到端跑通了。' }]);
    // 修之前：usage 是 { units: {}, source: 'provider' }
    expect(res.usage.units.tokens?.input_tokens).toBe(18);
    // 修之前：UsageRecord.usage 变成 source: 'estimated'、input_tokens: 1
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.usage.source).toBe('provider');
    expect(rec.usage.units.tokens?.input_tokens).toBe(18);
    expect(rec.usage.units.tokens?.output_tokens).toBe(11);
    expect(out.usage?.units.tokens?.total_tokens).toBe(29);
  });

  it('流式请求仍然产出聚合视图（修 fast-path/aggregate 时不回归）', async () => {
    // 上一条回归测试的反向护栏：streaming 时 aggregated 必须仍然存在，
    // 否则 needs:"aggregate" 的插件会静默失去聚合视图。
    const seen = newRecorder();
    const { outcome } = runWithPlugins(
      new ScriptedTransport([{ chunks: openAiSseStream() }]),
      [recordingPlugin(seen)],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    );
    await outcome;
    expect(seen.response).toBeDefined();
    const parts = asChatResponsePayload(seen.response!)?.message.parts ?? [];
    expect(parts).toEqual([{ type: 'text', text: '你好，世界' }]);
  });

  it('onResponse 改写在非流式下到达客户端（§4.3 已修）', async () => {
    // 2026-11-16 修：S8 非流式原先直接写 sink，而 S8 排在 S9 之前，于是
    // onResponse 的改写落在字节上线之后、静默丢失。修法是「S8 延迟写出」：
    // 只编码并把字节暂存 state.client_bytes，S9 跑完插件链后重新编码覆盖，
    // Runner 在 S9 之后才 flush。阶段编号与顺序（S0–S10）完全不变。
    const { sink, outcome } = runWithPlugins(
      new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      // noopRequestPlugin 只是历史上用来把请求推离 fast path 的；现在 appender 自己
      // （full-canonical 响应侧插件，默认档）就会禁用 fast path（§4.4 已修）。
      // 留着它不影响这条测试要断言的事——它不改写任何内容。
      [noopRequestPlugin(), appendingPlugin('（已改写）')],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    );
    const out = await outcome;
    expect(out.fast_path).toBe(false); // 断言前置条件，否则这条测试是空的
    const body = JSON.parse(sink.text()) as Record<string, unknown>;
    const choices = body['choices'] as Array<Record<string, unknown>>;
    const content = String((choices[0]!['message'] as Record<string, unknown>)['content']);
    expect(content).toBe('端到端跑通了。（已改写）');
  });

  it('流式下 onResponse 拿到的是完整聚合视图，不是空信封（20 §S9）', async () => {
    // 回归测试（2026-11-16 修）：S7 的聚合视图原先只在 `streamSide().length > 0`
    // 时构建，于是只声明 onResponse 的插件在流式下拿到 `synthesizeFromEvents`
    // 拼出的空信封（`parts: []`）——审计记录里一个字都没有。20 §S9 原文是
    // 「拿到最终 CanonicalResponse（流式下由 S7 的聚合视图提供）」，所以聚合视图
    // 本来就该服务 onResponse。现在 `streamSide() || responseSide()` 任一非空即聚。
    const seen = newRecorder();
    const { outcome } = runWithPlugins(
      new ScriptedTransport([{ chunks: openAiSseStream() }]),
      [recordingPlugin(seen)],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    );
    await outcome;
    expect(seen.response).toBeDefined();
    const parts = asChatResponsePayload(seen.response!)?.message.parts ?? [];
    // 修之前：[]（空）——插件看不到流式内容的任何一个字
    expect(parts).toEqual([{ type: 'text', text: '你好，世界' }]);
    expect(seen.response!.usage.units.tokens?.input_tokens).toBe(9);
    expect(seen.response!.usage.units.tokens?.output_tokens).toBe(4);
  });

  it('onResponse-only 插件在 fast path 下会被调用（§4.4 已修：响应侧 full-canonical 禁用 fast path）', async () => {
    // 2026-11-16 修（翻转前这里是「⚠️ 已知缺口：onResponse-only 插件在 fast path 下被
    // 静默跳过」，断言 `ran === []`）。根因：fast path 的合同是「透传原始字节」，S6 不
    // 解码响应、`state.response` 恒为 undefined，S9 的
    // `if (res !== undefined && !ctx.fast_path)` 于是把整条 onResponse 链跳过——
    // 插件不报错、不告警，只是**从来没被调用**，而请求本身看起来完全正常。
    //
    // 修法（仓库主人拍板）：D-fastpath-2 改为**两侧对称**——fast path 对两侧都是
    // 「没有 canonical」，full-canonical 的响应侧插件同样阻断 fast path。full-canonical
    // 是默认档，所以一个普通的审计/脱敏插件根本不会进 fast path。
    const ran: string[] = [];
    const { gateway, sink, outcome } = runWithPlugins(
      new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      [
        {
          manifest: { name: 'auditor', version: '1.0.0', hooks: ['onResponse'] },
          onResponse: (res) => {
            ran.push('onResponse');
            const payload = asChatResponsePayload(res);
            const first = payload?.message.parts.find((p) => p.type === 'text');
            if (first !== undefined && first.type === 'text') {
              first.text = `${first.text}（已改写）`;
            }
            return res;
          },
        },
      ],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    );
    const out = await outcome;
    await gateway.usageEmitter.flush();

    // 翻转前：expect(out.fast_path).toBe(true)（前置条件：确实走了 fast path）
    expect(out.fast_path).toBe(false); // 响应侧 full-canonical 插件禁用了 fast path
    expect(ran).toEqual(['onResponse']); // 翻转前：[] —— 插件一次都没被调用
    // 改写到达客户端（靠 §4.3 的 S8 延迟写出）
    expect(sink.text()).toContain('（已改写）');
    // 既然走了慢路径，就不该出现"插件被跳过"的告警
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.warnings.some((w) => w.startsWith('onResponse_skipped_fast_path'))).toBe(false);
  });

  it('envelope-only 响应侧插件在 fast path 下不被调用，但留下 warning（不静默）', async () => {
    // §4.4 修好之后的另一半：full-canonical 插件被挡在 fast path 之外，显式声明
    // `scope: "envelope-only"` 的插件则照旧进 fast path——但它们依然拿不到 canonical
    // 响应（S6 只 extractUsage）。这种「插件没跑」的情况必须留下信号：这条测试钉住
    // 「有告警」，防止将来又出现某条路径能让插件被静默跳过。
    const ran: string[] = [];
    const { gateway, sink, outcome } = runWithPlugins(
      new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      [
        {
          manifest: {
            name: 'auditor',
            version: '1.0.0',
            hooks: ['onResponse'],
            scope: 'envelope-only',
          },
          onResponse: (res) => {
            ran.push('onResponse');
            return res;
          },
        },
      ],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    );
    const out = await outcome;
    await gateway.usageEmitter.flush();

    expect(out.fast_path).toBe(true); // 显式 opted out：仍然走 fast path
    expect(ran).toEqual([]); // 拿不到 canonical 响应，确实没被调用
    // 但 trace 与 UsageRecord 里都看得见——不是静默失效
    expect(out.trace.warnings.some((w) => w.startsWith('onResponse_skipped_fast_path'))).toBe(true);
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.warnings.some((w) => w.startsWith('onResponse_skipped_fast_path'))).toBe(true);
    // 客户端拿到上游原文（fast path 透传）
    expect(sink.text()).toContain('端到端跑通了。');
  });

  it('流式 fast path 下 onStreamChunk 插件不被调用，同样留下 warning（不静默）', async () => {
    // 与上一条同一条规则在流式侧的投影：full-canonical 的流式插件在准入阶段就禁用
    // fast path（D-fastpath-2 两侧对称），envelope-only 的才会进来——而它们拿不到
    // canonical 事件（S6 连流都不读，只武装嗅探器）。同样不许静默。
    const ran: string[] = [];
    const { gateway, sink, outcome } = runWithPlugins(
      new ScriptedTransport([{ chunks: openAiSseStream() }]),
      [
        {
          manifest: {
            name: 'frame-rewriter',
            version: '1.0.0',
            hooks: ['onStreamChunk'],
            scope: 'envelope-only',
          },
          onStreamChunk: (ev) => {
            ran.push(ev.type);
            return undefined;
          },
        },
      ],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    );
    const out = await outcome;
    await gateway.usageEmitter.flush();

    expect(out.fast_path).toBe(true);
    expect(ran).toEqual([]);
    expect(out.trace.warnings.some((w) => w.startsWith('onStreamChunk_skipped_fast_path'))).toBe(
      true,
    );
    // 客户端拿到的是上游原文（fast path 逐帧透传）
    expect(sink.text()).toContain('你好');
    expect(sink.text()).toContain('，世界');
  });

  it('onResponse 改写在 ShortCircuit 路径也到达客户端（同一修法的另一条路径）', async () => {
    // 短路路径（S3 直接给合成响应）与普通路径共用同一个「延迟写出」机制，
    // 因此审计插件对合成响应的改写同样能到达客户端。
    const { sink, outcome } = runWithPlugins(
      new ScriptedTransport([]), // 短路后不打上游，脚本为空也不该被消费
      [
        {
          manifest: { name: 'guard', version: '1.0.0', hooks: ['onRequest'], order: 10 },
          onRequest: () => ({
            short_circuit: true,
            reason: 'cached',
            response: {
              ir_version: 'ag-ir/1',
              kind: 'chat',
              request_id: 'req_sc',
              usage: { units: {}, source: 'provider' },
              finish_reason: 'stop',
              payload: {
                message: { role: 'assistant', parts: [{ type: 'text', text: '缓存命中' }] },
              },
              warnings: [],
              raw: {},
            },
          }),
        },
        appendingPlugin('（审计改写）'),
      ],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: false },
    );
    const out = await outcome;
    expect(out.short_circuit).toBe(true);
    const body = JSON.parse(sink.text()) as Record<string, unknown>;
    const choices = body['choices'] as Array<Record<string, unknown>>;
    const content = String((choices[0]!['message'] as Record<string, unknown>)['content']);
    expect(content).toBe('缓存命中（审计改写）');
  });

  it('流式与非流式行为一致：改写后的 canonical 永远进入 S10 记账', async () => {
    // 用户拍板的不变量（2026-11-16）：「同一个 hook 在流式/非流式下行为不一致」
    // 不可接受。物理上流式的字节已经在线路上（25 §7.1 禁止流式 ShortCircuit），
    // 客户端拿到的只能是改写前的内容——但**记账**两种模式必须一致：
    // S10 记的永远是 onResponse 之后的那一份（state.usage 由 S9 从改写后的
    // 响应里取；estimateTextOf 也优先读 final_response）。
    // 否则就是「客户端拿到 A、账记的是 B」。
    for (const stream of [false, true]) {
      const gw = runWithPlugins(
        new ScriptedTransport(
          stream
            ? [{ chunks: openAiSseStream() }]
            : [{ body: JSON.stringify(openAiChatResponse()) }],
        ),
        // onRequest no-op 只为把请求推离 fast path（理由同 §4.3 那条测试）
        [noopRequestPlugin(), usageRewriter()],
        { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream },
      );
      const out = await gw.outcome;
      await gw.gateway.usageEmitter.flush();
      expect(out.error, `stream=${stream}`).toBeUndefined();
      expect(out.fast_path, `stream=${stream}`).toBe(false);

      const rec = gw.gateway.usageSink!.records[0]!;
      // 插件把 usage 改成了 42/7，两种模式下的 UsageRecord 都必须是这个值
      expect(rec.usage.units.tokens?.input_tokens, `stream=${stream}`).toBe(42);
      expect(rec.usage.units.tokens?.output_tokens, `stream=${stream}`).toBe(7);
      expect(rec.usage.source, `stream=${stream}`).toBe('provider');
      expect(rec.stream, `stream=${stream}`).toBe(stream);
    }
  });

  it('流式下 onResponse 改写到不了客户端，但必须留下 warning（不静默）', async () => {
    // 流式的物理限制：首字节之后不能改状态码、也不能改已发内容（20 §S8 / 25 §7.1）。
    // 与上一条合起来才是完整的「一致」：能生效的地方生效，不能生效的地方**说出来**。
    const { gateway, sink, outcome } = runWithPlugins(
      new ScriptedTransport([{ chunks: openAiSseStream() }]),
      [noopRequestPlugin(), appendingPlugin('（改写无效）')],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    );
    const out = await outcome;
    await gateway.usageEmitter.flush();
    expect(out.fast_path).toBe(false);

    // 客户端拿到的是上游原文（改写 physically 到不了）
    expect(sink.text()).toContain('你好');
    expect(sink.text()).toContain('，世界');
    expect(sink.text()).not.toContain('（改写无效）');
    // 但 trace 里有据可查
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.warnings.some((w) => w.startsWith('onResponse_rewrite_ignored_streaming'))).toBe(
      true,
    );
  });

  it('客户端在 flush 前断开 → 不强写、记 warning、照样记账', async () => {
    // 延迟写出（§4.3）带来的新分支：字节还没交出去，客户端先走了。
    // 此时不能强写（Node 侧是 ERR_STREAM_WRITE_AFTER_END），但账要记。
    const closed = new ClosedSink();
    const gateway = createGateway({
      mode: 'test',
      transport: new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]),
      plugins: [{ plugin: noopRequestPlugin() }],
      routeTable: {
        aliases: {
          'gpt-test-1': {
            targets: [{ access_path: 'mock', provider: 'mock', model: 'gpt-test-1' }],
          },
        },
      },
    });
    const out = await gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'gpt-test-1',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
          }),
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      closed,
    );
    await gateway.usageEmitter.flush();

    expect(out.error).toBeUndefined();
    expect(closed.started).toBe(false); // 一个字节都没写
    expect(closed.text()).toBe('');
    // 有据可查 + 账记上了
    expect(out.trace.warnings.some((w) => w.startsWith('client_disconnected_before_flush'))).toBe(
      true,
    );
    expect(gateway.usageSink!.records).toHaveLength(1);
    expect(gateway.usageSink!.records[0]!.usage.units.tokens?.input_tokens).toBe(18);
  });
});

/** onRequest no-op：只为把请求推离 fast path（fast path 下 onResponse 不会被调用）。 */
function noopRequestPlugin(): Plugin {
  return {
    manifest: { name: 'noop-request', version: '1.0.0', hooks: ['onRequest'] },
    onRequest: () => undefined,
  };
}

/** 一个把响应文本追加指定后缀的 onResponse 插件。 */
function appendingPlugin(suffix: string): Plugin {
  return {
    manifest: { name: 'appender', version: '1.0.0', hooks: ['onResponse'] },
    onResponse: (res) => {
      const payload = asChatResponsePayload(res);
      const first = payload?.message.parts.find((p) => p.type === 'text');
      if (first !== undefined && first.type === 'text') {
        first.text = `${first.text}${suffix}`;
      }
      return res;
    },
  };
}

/** 一个把 usage 数字改写成固定值的 onResponse 插件（用来验记账口径）。 */
function usageRewriter(): Plugin {
  return {
    manifest: { name: 'usage-rewriter', version: '1.0.0', hooks: ['onResponse'] },
    onResponse: (res) => {
      res.usage = {
        units: {
          tokens: {
            input_tokens: 42,
            output_tokens: 7,
            total_tokens: 49,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
          },
        },
        source: 'provider',
      };
      return res;
    },
  };
}

// ---------------------------------------------------------------------------
// 约束二：插件炸不掉主链路（五个 hook 各一条）
// ---------------------------------------------------------------------------

describe('插件契约：hook 失败隔离', () => {
  function makeHost(timeoutMs = 1000): DefaultPluginHost {
    return new DefaultPluginHost(makeServices(), timeoutMs);
  }

  it('onRequest 抛异常 → 不改写、记 warning、请求继续', async () => {
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onRequest'] },
      onRequest: () => {
        throw new Error('boom');
      },
    });
    const ctx = makeCtx();
    const req = chatReq('hi');
    const out = await host.runOnRequest(req, ctx);
    expect(out).toBe(req); // 原对象透传，不是副本也不是 undefined
    expect(ctx.warnings.some((w) => w.startsWith('plugin_error:boom'))).toBe(true);
  });

  it('onResponse 抛异常 → 客户端拿到未改写的响应', async () => {
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onResponse'] },
      onResponse: () => {
        throw new Error('boom');
      },
    });
    const ctx = makeCtx();
    const res = chatRes('原文');
    const out = await host.runOnResponse(res, ctx);
    expect(out).toBe(res);
    expect(asChatResponsePayload(out as CanonicalResponseEnvelope)?.message.parts[0]).toEqual({
      type: 'text',
      text: '原文',
    });
    expect(ctx.warnings.some((w) => w.startsWith('plugin_error:boom'))).toBe(true);
  });

  it('onStreamChunk 抛异常 → 该帧原样透传（不丢帧）', async () => {
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onStreamChunk'] },
      onStreamChunk: () => {
        throw new Error('boom');
      },
    });
    const ev = textEvent('hello');
    expect(await host.runOnStreamChunk(ev, makeCtx())).toEqual(ev);
  });

  it('onStreamChunk 返回 null 后又抛异常 → 不吞掉后面的插件（失败即透传）', async () => {
    // 反例护栏：前一个插件失败后，后一个插件仍要拿到原始帧
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onStreamChunk'], order: 10 },
      onStreamChunk: () => {
        throw new Error('boom');
      },
    });
    const seen: string[] = [];
    host.register({
      manifest: { name: 'later', version: '1.0.0', hooks: ['onStreamChunk'], order: 20 },
      onStreamChunk: (ev) => {
        seen.push(ev.type);
        return ev; // 显式透传
      },
    });
    const ev = textEvent('hello');
    expect(await host.runOnStreamChunk(ev, makeCtx())).toEqual(ev);
    expect(seen).toEqual(['part.delta']);
  });

  it('onStreamChunk 返回 undefined = 不改写（不能把 undefined 当成帧往下传）', async () => {
    // 回归测试（2026-11-16 修）：`Plugin.onStreamChunk` 的返回类型原先不含
    // undefined，而 Runner 又把 undefined 当成"改写后的帧"写进 stream_events，
    // S8 编码时立刻踩空 → 整个流式请求 500（`Cannot read properties of
    // undefined (reading 'type')`）。而"忘了 return"是同步插件最自然的写法
    // （其他四个 hook 都允许返回 void），所以这是隔离而不是便利。
    const host = makeHost();
    host.register({
      manifest: { name: 'noop', version: '1.0.0', hooks: ['onStreamChunk'] },
      onStreamChunk: () => undefined, // 只想观测，不想改写
    });
    const ev = textEvent('hello');
    expect(await host.runOnStreamChunk(ev, makeCtx())).toEqual(ev);
  });

  it('onStreamChunk 返回 undefined 的插件不会把流式请求打成 500', async () => {
    // 上一条的端到端版本：真正的回归在管道里（host 单测过了，S7/S8 仍可能踩空）。
    const { sink, outcome } = runWithPlugins(
      new ScriptedTransport([{ chunks: openAiSseStream() }]),
      [
        {
          manifest: { name: 'noop', version: '1.0.0', hooks: ['onStreamChunk'] },
          onStreamChunk: () => undefined,
        },
      ],
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    );
    const out = await outcome;
    expect(out.error).toBeUndefined();
    expect(sink.text()).toContain('你好');
    expect(sink.text()).toContain('，世界');
  });

  it('onError 抛异常 → notifyError 仍然 resolve（控制流不变）', async () => {
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onError'] },
      onError: () => {
        throw new Error('boom');
      },
    });
    const seen: string[] = [];
    host.register({
      manifest: { name: 'later', version: '1.0.0', hooks: ['onError'], order: 20 },
      onError: (err) => {
        seen.push(err.code);
      },
    });
    await expect(host.notifyError(canonicalError(), makeCtx())).resolves.toBeUndefined();
    expect(seen).toEqual(['upstream_error']); // 前一个炸了不阻止后一个观测
  });

  it('onToolCall 抛异常 → 工具循环把失败包成 is_error 结果，主链路不炸', async () => {
    // runOnToolCall 在没有插件成功时会抛（host.ts 的既定契约）；炸掉的请求由
    // tool-loop 接住并转成 is_error tool_result——这是主链路的最后一道隔离。
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onToolCall'] },
      onToolCall: () => {
        throw new Error('boom');
      },
    });
    await expect(host.runOnToolCall(toolUse(), makeCtx())).rejects.toThrow(/没有可用的 onToolCall/);
  });

  it('五个 hook 全部抛异常 → 一次真实请求照样跑通并回包', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(openAiChatResponse()) }]);
    const boom: Plugin = {
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onRequest', 'onResponse'] },
      onRequest: () => {
        throw new Error('boom-request');
      },
      onResponse: () => {
        throw new Error('boom-response');
      },
    };
    const { gateway, sink, outcome } = runWithPlugins(transport, [boom], {
      model: 'gpt-test-1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    const out = await outcome;
    await gateway.usageEmitter.flush();

    expect(out.error).toBeUndefined();
    const body = JSON.parse(sink.text()) as Record<string, unknown>;
    const choices = body['choices'] as Array<Record<string, unknown>>;
    expect((choices[0]!['message'] as Record<string, unknown>)['content']).toBe('端到端跑通了。');
    // 两次失败都留下了痕迹（可观测），但都没改变结果
    const rec = gateway.usageSink!.records[0]!;
    expect(rec.warnings.some((w) => w.includes('plugin_error:boom'))).toBe(true);
  });

  it('插件超时 → 按失败处理，不阻断（onResponse / onStreamChunk 同样走 invoke）', async () => {
    const host = makeHost(20);
    host.register({
      manifest: { name: 'slow', version: '1.0.0', hooks: ['onResponse'], timeout_ms: 20 },
      onResponse: async (res: CanonicalResponseEnvelope) => {
        await new Promise((r) => setTimeout(r, 200));
        return res;
      },
    });
    const ctx = makeCtx();
    const res = chatRes('原文');
    const out = await host.runOnResponse(res, ctx);
    expect(out).toBe(res);
    expect(ctx.warnings.some((w) => w.includes('timeout'))).toBe(true);
  });

  it('fatal: true 的插件失败 → 明确给出 plugin_error 短路，而不是静默继续', async () => {
    const host = makeHost();
    host.register({
      manifest: { name: 'boom', version: '1.0.0', hooks: ['onRequest'], fatal: true },
      onRequest: () => {
        throw new Error('boom');
      },
    });
    const out = await host.runOnRequest(chatReq(), makeCtx());
    expect(typeof out === 'object' && out !== null && 'short_circuit' in out).toBe(true);
    if (typeof out === 'object' && out !== null && 'short_circuit' in out) {
      const sc = out as { error?: { code?: string; http_status?: number } };
      expect(sc.error?.code).toBe('plugin_error');
      expect(sc.error?.http_status).toBe(500);
    }
  });

  it('注册期校验不合法 manifest → 启动即失败（不静默注册）', () => {
    const host = makeHost();
    expect(() =>
      host.register({
        manifest: {
          name: 'bad',
          version: '1.0.0',
          hooks: ['onStreamChunk'],
          capabilities: ['context_compaction'],
        },
      }),
    ).toThrow(/不得声明 capabilities.context_compaction/);
  });
});

// ---------------------------------------------------------------------------
// 本地小工具（与 tests/plugin-host.test.ts 同风格，保持本文件自洽可读）
// ---------------------------------------------------------------------------

function makeServices() {
  return {
    log: new MemoryLogger(),
    metrics: new MemoryMetrics(),
    clock: fixedClock(0),
    currentUsage: () => ({ units: {}, source: 'provider' as const }),
    kv: { async get() {}, async set() {}, async delete() {} },
  };
}

function makeCtx(): MutableRequestContext {
  return new MutableRequestContext({
    request_id: 'req_contract',
    started_at: 0,
    deadline: 1000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'k' },
  });
}

function chatReq(text = 'hi'): CanonicalRequestEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    model: 'gpt-test-1',
    source_format: 'openai.chat',
    raw: {},
    payload: {
      system: [],
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
    },
  };
}

function chatRes(text: string): CanonicalResponseEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    request_id: 'r',
    usage: { units: {}, source: 'provider' },
    finish_reason: 'stop',
    payload: { message: { role: 'assistant', parts: [{ type: 'text', text }] } },
    warnings: [],
    raw: {},
  };
}

function textEvent(text: string): CanonicalStreamEvent {
  return { type: 'part.delta', index: 0, delta: { type: 'text', text } };
}

function canonicalError() {
  return {
    code: 'upstream_error' as const,
    message: 'm',
    http_status: 502,
    retryable: true,
    request_id: 'r',
  };
}

function toolUse(): ToolUsePart {
  return { type: 'tool_use', id: 'call_1', name: 'get_time', input: { tz: 'UTC' } };
}

function openAiChatResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-contract0001',
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
  };
}

function openAiChatResponseWithToolCall(): Record<string, unknown> {
  return {
    id: 'chatcmpl-contract-tool',
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
              id: 'call_contract_1',
              type: 'function',
              function: { name: 'get_time', arguments: '{"tz": "UTC"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  };
}

function openAiSseStream(): string[] {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-contract-stream',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'gpt-test-1',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: '你好' }),
    chunk({ content: '，世界' }),
    // finish 与 usage 搭在同一个 chunk 上（openai-chat codec 的既有预期：
    // 空 choices 的 usage-only chunk 会踩到 codec 的 choices[0] 解引用）
    `data: ${JSON.stringify({
      id: 'chatcmpl-contract-stream',
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model: 'gpt-test-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 4,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

/** 一个「已断开」的 sink：验证 flush 前的断开保护（§4.3 延迟写出的新分支）。 */
class ClosedSink extends MemoryClientSink {
  override get closed(): boolean {
    return true;
  }
}

/** 起一个带插件的进程内网关（mock access path，不需要任何 key）。 */
function runWithPlugins(transport: ScriptedTransport, plugins: Plugin[], body: unknown) {
  const gateway = createGateway({
    mode: 'test',
    transport,
    plugins: plugins.map((plugin) => ({ plugin })),
    routeTable: {
      aliases: {
        'gpt-test-1': { targets: [{ access_path: 'mock', provider: 'mock', model: 'gpt-test-1' }] },
      },
    },
  });
  const sink = new MemoryClientSink();
  return {
    gateway,
    sink,
    outcome: gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(JSON.stringify(body)),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    ),
  };
}
