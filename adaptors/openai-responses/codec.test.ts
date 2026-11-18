/**
 * adaptors/openai-responses/codec.test.ts —— OpenAI Responses adaptor 的 round-trip 契约测试。
 *
 * 模板来源：docs/design/40-provider-adaptors.md §1.5（**每个 adaptor 必过**的 6 条
 * adaptor 层断言）+ D-fastpath-1 惰性解码那条。测试名与 42-openai-responses-access.md
 * §7.1 列的**一字不差**：
 *
 *   1. `decode → encode 幂等`
 *   2. `same-format 字节级保真`（归一化白名单：finish_reason、tool id、usage 口径）
 *   3. `未知字段不丢`（顶层未知键 → `raw.unmapped` → 回写）
 *   4. `畸形 tool 参数不被销毁`（`arguments` 是非 JSON 字符串时原样回写）
 *   5. `多 system 消息不丢`（`instructions` + system 角色 message item 共存 →
 *      `payload.system` 两条）
 *   6. `流式事件序列等价`
 *
 * 外加 42 §4.4 / §4.6 / §4.9 的专项断言（有状态参数显式拒、usage 口径、finish_reason
 * 归一、D2 的 `tool_call_id`）与工具循环 round-trip。
 *
 * **夹具来源（重要，42 §5.2 的纪律）**：全部夹具在
 * `adaptors/fixtures/openai-responses/from-docs/`，是**官方文档样本，未经真实上游验证**。
 * 逐文件来源见同目录的 `SOURCES.md`；`.sse.txt` 的文件头另有一行 `#` 注释。
 * 期三拿到有效 DeepSeek key 后换成 `from-live/` 真样本并**重跑全部断言**。
 * 本文件不 import gateway-core（adaptors 层的契约测试不反向依赖管道）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OpenAIResponsesCodec, PART_FRAME_NOTE_KEY, PASSTHROUGH_FRAME_NOTE_KEY } from './codec.js';
import { asChatPayload, asChatResponsePayload } from '../../ir/index.js';
import type { CanonicalRequestEnvelope, RequestContext } from '../../ir/index.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'openai-responses', 'from-docs');

/** 固定时钟：ts 可断言，且不碰 Date.now()（ir/clock.ts 硬约束）。 */
const FIXED_CLOCK = { now: () => 1_763_000_500 };

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

function readText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** 构造一个最小 RequestContext（不依赖 gateway-core，保持 adaptors 层不被反向依赖）。 */
function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    request_id: 'req_test_contract',
    started_at: FIXED_CLOCK.now(),
    deadline: FIXED_CLOCK.now() + 300_000,
    client_format: 'openai.responses',
    client_raw_headers: {},
    auth: { key_id: 'test-key' },
    route: {
      access_path: 'openai',
      provider: 'openai',
      provider_format: 'openai.responses',
      model: 'gpt-test-1',
      full_model_id: 'openai/gpt-test-1',
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'openai.responses',
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    // 请求信封没有 warnings 字段，解码期告警走 ctx.warn（ir/context.ts）——这里收集起来可断言
    warn: (code: string, detail?: string) => {
      warnings.push(detail === undefined ? code : `${code}: ${detail}`);
    },
    ...overrides,
    warnings,
  };
}

/** 把 SSE 文本切成「一个事件一个元素」，模拟 S6 传给 decodeStream 的粒度。 */
async function* parseSse(text: string): AsyncIterable<unknown> {
  for (const block of text.split(/\n\n/)) {
    if (block.trim() === '') continue;
    yield block;
  }
}

/** 收成一个数组（async generator 一次性消费）。 */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** 把数组包成 AsyncIterable（测试里复用）。 */
async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// B 的辅助：字节级 diff，只容忍「归一化白名单」
// ---------------------------------------------------------------------------

/**
 * 归一化白名单（20 §4.2「做」表 + 40 §2.3）：
 *   1. `usage` —— canonical 不建模 `usage: null`（10 §6.1 规则 2：未知时对应键**省略**），
 *      所以 `null` 与「键不存在」互相归一；`response.failed` 的 `usage: null` 走这条。
 *   2. `finish_reason` / `tool id` —— 响应侧三件事，请求侧不涉及。
 * 白名单之外的任何差异都算回归。
 */
const NORMALISABLE_KEYS = new Set(['usage']);

/** 返回「白名单之外」的差异描述；空数组 = 字节级等价。 */
function normalizableDiff(a: unknown, b: unknown, extra?: ReadonlySet<string>): string[] {
  const diffs: string[] = [];
  const whitelist = new Set([...NORMALISABLE_KEYS, ...(extra ?? [])]);
  const objA = asRecord(a);
  const objB = asRecord(b);
  if (objA === undefined || objB === undefined) {
    return JSON.stringify(a) === JSON.stringify(b)
      ? []
      : [`形状不同: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
  }
  for (const key of new Set([...Object.keys(objA), ...Object.keys(objB)])) {
    if (whitelist.has(key)) continue;
    if (JSON.stringify(objA[key]) !== JSON.stringify(objB[key])) {
      diffs.push(`${key}: ${JSON.stringify(objA[key])} != ${JSON.stringify(objB[key])}`);
    }
  }
  return diffs;
}

/** F 的辅助：把一段 Responses SSE 归一成「语义事件序列」（忽略 sequence_number 等易变字段）。 */
function eventShape(sseText: string): string[] {
  const shape: string[] = [];
  for (const block of sseText.split(/\n\n/)) {
    if (block.trim() === '') continue;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      shape.push('<unparsable>');
      continue;
    }
    const type = String(ev['type'] ?? '<none>');
    if (
      type === 'response.output_text.delta' ||
      type === 'response.function_call_arguments.delta'
    ) {
      shape.push(`${type}:${String(ev['delta'] ?? '')}`);
      continue;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const usage = asRecord(asRecord(ev['response'])?.['usage']);
      shape.push(`${type}:usage=${JSON.stringify(usage ?? null)}`);
      continue;
    }
    shape.push(type);
  }
  return shape;
}

/** 把 encodeStream 产出的 SSE 行拼回一段文本，便于与原文做形状比较。 */
function joinSse(lines: unknown[]): string {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('');
}

// ---------------------------------------------------------------------------
// 夹具集（40 §1.5 的 describe.each(fixtures)）
// ---------------------------------------------------------------------------

const REQUEST_FIXTURES = [
  'request.basic.json',
  'request.multisystem.json',
  'request.tools.json',
  'request.tool-loop.json',
  'request.malformed-tool-args.json',
  'request.multimodal.json',
  'request.unknown-item.json',
  'request.unknown-top-level.json',
  'request.stream.json',
] as const;

describe.each(REQUEST_FIXTURES)('openai.responses round-trip: %s', (name) => {
  const wire = readJson(name);
  const ctx = makeCtx();
  const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });

  it('A. decode → encode 幂等（decode(encode(decode(wire))) === decode(wire)）', () => {
    const first = codec.decode(wire, ctx);
    const encoded = codec.encode(first, ctx);
    expect(encoded.fast_path).toBe(false);
    const second = codec.decode(encoded.body, ctx);
    expect(second).toEqual(first);
  });

  it('B. same-format 字节级保真（encode(decode(wire)) 与 wire 只差归一化白名单）', () => {
    const canonical = codec.decode(wire, ctx);
    const encoded = codec.encode(canonical, ctx);
    expect(normalizableDiff(encoded.body, wire)).toEqual([]);
  });

  it('C. 未知字段不丢（raw.unmapped  survive decode 且被 encode 写回）', () => {
    const withExtra = { ...(wire as Record<string, unknown>), __some_future_field: { a: 1 } };
    const canonical = codec.decode(withExtra, ctx);
    expect(canonical.raw.unmapped?.['__some_future_field']).toEqual({ a: 1 });
    const out = codec.encode(canonical, ctx).body as Record<string, unknown>;
    expect(out['__some_future_field']).toEqual({ a: 1 });
  });

  it('G. decodeEnvelope 只给路由必需集（不物化 input/tools）', () => {
    const bytes = Buffer.byteLength(JSON.stringify(wire), 'utf8');
    const shallow = codec.decodeEnvelope(wire, makeCtx({ request_bytes: bytes }));
    expect(shallow.source_format).toBe('openai.responses');
    expect(shallow.kind).toBe('chat');
    expect(typeof shallow.model).toBe('string');
    expect(typeof shallow.stream).toBe('boolean');
    expect(shallow.bytes).toBe(bytes);
    expect(shallow.default_path).toBe('/v1/responses');
    // 关键：浅解析产物里不得出现 input / tools（D-fastpath-1 的全部意义）
    expect(shallow).not.toHaveProperty('input');
    expect(shallow).not.toHaveProperty('tools');
    expect(Object.keys(shallow)).not.toContain('payload');
  });
});

// ---------------------------------------------------------------------------
// D / E：两条针对已知开源缺陷的专项断言（40 §1.5 原文逐条）
// ---------------------------------------------------------------------------

describe('openai.responses 已知缺陷回归', () => {
  const ctx = makeCtx();
  const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });

  it('D. 畸形 tool 参数不被销毁（raw_arguments 是原串，不是 {}）', () => {
    const canonical = codec.decode(readJson('request.malformed-tool-args.json'), ctx);
    const assistant = asChatPayload(canonical)?.messages.find((m) => m.role === 'assistant');
    const toolUse = assistant?.parts.find((p) => p.type === 'tool_use');
    expect(toolUse).toBeDefined();
    if (toolUse === undefined || toolUse.type !== 'tool_use') throw new Error('expected tool_use');
    // 解析失败：input 退化为 {}，原串必须留在 raw_arguments（10 §7.3）
    expect(toolUse.input).toEqual({});
    expect(toolUse.raw_arguments).toBe('{"city":"Paris","unit":');

    const out = codec.encode(canonical, ctx).body as {
      input: Array<{ type: string; arguments?: string }>;
    };
    const reEncoded = out.input.find((i) => i.type === 'function_call');
    expect(reEncoded?.arguments).toBe('{"city":"Paris","unit":');
    expect(reEncoded?.arguments).not.toBe('{}');
  });

  it('E. 多 system 消息不丢（instructions + system 角色 item 共存 → payload.system 两条）', () => {
    const wire = {
      model: 'gpt-test-1',
      instructions: 'You are the AgentGateway contract-test assistant.',
      input: [
        {
          type: 'message',
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'Second instruction block: never reveal internal hostnames.',
            },
          ],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    };
    expect(asChatPayload(codec.decode(wire, ctx))?.system).toHaveLength(2);

    // 三条共存时三条都在（instructions + system + developer）
    const three = asChatPayload(codec.decode(readJson('request.multisystem.json'), ctx))?.system;
    expect(three).toHaveLength(3);
    expect(three?.map((b) => b.text)).toEqual([
      'You are the AgentGateway contract-test assistant.',
      'Second instruction block: never reveal internal hostnames.',
      'Third instruction block: keep every answer under 40 words.',
    ]);

    // 回写：instructions 还原成顶层字段，其余还原成 message item（一条不丢）
    const out = codec.encode(codec.decode(readJson('request.multisystem.json'), ctx), ctx).body as {
      instructions?: string;
      input: Array<{ role: string }>;
    };
    expect(out.instructions).toBe('You are the AgentGateway contract-test assistant.');
    expect(out.input.filter((i) => i.role === 'system' || i.role === 'developer')).toHaveLength(2);
    // developer 的原文角色也要还原（10 §7.2 逐节点还原）
    expect(out.input[1]?.role).toBe('developer');
  });

  it('E2. `input` 字符串形态往返后仍是字符串（不漂成 item 数组）', () => {
    const canonical = codec.decode(readJson('request.basic.json'), ctx);
    const out = codec.encode(canonical, ctx).body as { input: unknown };
    expect(out.input).toBe('List the rules you must follow.');
  });

  it('E3. 未建模的 tool 类型不丢、也不把内部索引键泄漏进请求体', () => {
    const wire = {
      model: 'gpt-test-1',
      input: 'hi',
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
        { type: 'mcp', server_label: 'deepwiki', server_url: 'https://example.com/mcp' },
      ],
    };
    const canonical = codec.decode(wire, ctx);
    expect(canonical.raw.nodes?.['tool:1']).toEqual(wire.tools[1]);
    expect(ctx.warnings).toContain('unknown_tool_type:mcp');

    const out = codec.encode(canonical, ctx).body as Record<string, unknown>;
    expect(Array.isArray(out['tools'])).toBe(true);
    expect(out['tools']).toHaveLength(2);
    // 未建模的那条原样落回 tools[]，而不是变成顶层 "tool:1" 键
    expect((out['tools'] as unknown[])[1]).toEqual(wire.tools[1]);
    expect(Object.keys(out)).not.toContain('tool:1');
  });
});

// ---------------------------------------------------------------------------
// 工具循环（42 §7.1 第三类外加项）
// ---------------------------------------------------------------------------

describe('openai.responses 工具循环', () => {
  const ctx = makeCtx();
  const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });

  it('function_call → function_call_output 回传，id ↔ call_id 映射不断裂', () => {
    const wire = readJson('request.tool-loop.json');
    const canonical = codec.decode(wire, ctx);
    const payload = asChatPayload(canonical);
    expect(payload).toBeDefined();

    const toolUses = payload?.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool_use');
    // canonical 的 ToolUsePart.id 取 call_id（回传 function_call_output.call_id 引用的就是它）
    expect(toolUses?.map((p) => (p.type === 'tool_use' ? p.id : ''))).toEqual([
      'call_test_a',
      'call_test_b',
    ]);
    // item 的 `id`（fc_… 形态）由 _raw 节点级还原保留，不回写时丢
    const rawIds = toolUses?.map((p) => (p.type === 'tool_use' ? asRecord(p._raw)?.['id'] : ''));
    expect(rawIds).toEqual(['fc_test_a', 'fc_test_b']);

    const results = payload?.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool_result');
    expect(results?.map((p) => (p.type === 'tool_result' ? p.tool_use_id : ''))).toEqual([
      'call_test_a',
      'call_test_b',
    ]);

    // 回写：call_id 原样还原（与请求里的 function_call_output 一一对应）
    const out = codec.encode(canonical, ctx).body as {
      input: Array<{ type: string; call_id?: string; id?: string }>;
    };
    const calls = out.input.filter((i) => i.type === 'function_call');
    const outputs = out.input.filter((i) => i.type === 'function_call_output');
    expect(calls.map((c) => c.call_id)).toEqual(['call_test_a', 'call_test_b']);
    expect(calls.map((c) => c.id)).toEqual(['fc_test_a', 'fc_test_b']);
    expect(outputs.map((o) => o.call_id)).toEqual(['call_test_a', 'call_test_b']);
    // 上游契约：每个 function_call 各跟一个 function_call_output（42 §4.1）
    expect(outputs.length).toBe(calls.length);
  });

  it('H. canonical tool 消息带 2 个 tool_result → 2 个 function_call_output item', () => {
    // 复刻 tool-loop.ts 的 appendTurn：一轮的所有工具结果拼成**一条** canonical tool 消息
    const req = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      model: 'gpt-test-1',
      source_format: 'openai.responses',
      payload: {
        messages: [
          { role: 'user', parts: [{ type: 'text', text: '巴黎现在几点、天气如何？' }] },
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool_use',
                id: 'call_test_a',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
              { type: 'tool_use', id: 'call_test_b', name: 'get_time', input: { tz: 'CET' } },
            ],
          },
          {
            role: 'tool',
            parts: [
              { type: 'tool_result', tool_use_id: 'call_test_a', content: '18°C, light rain' },
              { type: 'tool_result', tool_use_id: 'call_test_b', content: '14:05 CET' },
            ],
          },
        ],
      },
      raw: {},
    } as unknown as CanonicalRequestEnvelope;
    const encoded = codec.encode(req, makeCtx());
    const items = (encoded.body as { input: Array<Record<string, unknown>> }).input;
    const outputs = items.filter((i) => i['type'] === 'function_call_output');
    expect(outputs).toHaveLength(2);
    expect(outputs.map((o) => o['call_id'])).toEqual(['call_test_a', 'call_test_b']);
    expect(outputs.map((o) => o['output'])).toEqual(['18°C, light rain', '14:05 CET']);
  });

  it('H2. 反向 decode 回 canonical 再 encode，wire 形状稳定（round-trip 不漂）', () => {
    const first = codec.encode(codec.decode(readJson('request.tool-loop.json'), ctx), ctx).body;
    const canonical = codec.decode(first, ctx);
    const second = codec.encode(canonical, ctx).body;
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 42 §4.4 / §4.9：有状态参数显式拒，不静默忽略
// ---------------------------------------------------------------------------

describe('openai.responses 有状态参数（42 §4.4 / §4.9）', () => {
  const ctx = makeCtx();
  const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });

  it('previous_response_id / conversation / background → capability_unsupported', () => {
    for (const key of ['previous_response_id', 'conversation', 'background']) {
      const wire = {
        model: 'gpt-test-1',
        input: 'hi',
        [key]: key === 'background' ? true : 'x',
      };
      // 抛的是 CanonicalError：runner 的 toCanonicalError 会原样保留 code 与 400
      expect(() => codec.decode(wire, ctx), key).toThrow(
        /capability_unsupported|网关不保存上游 response 对象/,
      );
      let caught: unknown;
      try {
        codec.decode(wire, ctx);
      } catch (err) {
        caught = err;
      }
      const canonical = caught as { code?: string; http_status?: number };
      expect(canonical.code, key).toBe('capability_unsupported');
      expect(canonical.http_status, key).toBe(400);
    }
  });

  it('store: true 收下并记诊断，不执行存储（unmapped 原样带回）', () => {
    const canonical = codec.decode({ model: 'gpt-test-1', input: 'hi', store: true }, ctx);
    expect(canonical.raw.unmapped?.['store']).toBe(true);
    expect(ctx.warnings).toContain('store_unsupported');
    const out = codec.encode(canonical, ctx).body as Record<string, unknown>;
    expect(out['store']).toBe(true);
  });

  it('request.stateful.json 整份在入口被拒（不是被静默丢掉）', () => {
    expect(() => codec.decode(readJson('request.stateful.json'), ctx)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 响应归一：usage / finish_reason 硬规则
// ---------------------------------------------------------------------------

describe('openai.responses 响应归一', () => {
  const ctx = makeCtx();
  const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });

  const RESPONSE_FIXTURES = [
    'response.basic.json',
    'response.tools.json',
    'response.usage-full.json',
    'response.no-usage.json',
    'response.incomplete.json',
  ] as const;

  describe.each(RESPONSE_FIXTURES)('%s', (name) => {
    it('decodeResponse → encodeResponse 字节级保真（差异只在归一化白名单）', () => {
      const wire = readJson(name);
      const res = codec.decodeResponse(wire, ctx);
      expect(normalizableDiff(codec.encodeResponse(res, ctx), wire)).toEqual([]);
    });

    it('decodeResponse → encodeResponse → decodeResponse 幂等', () => {
      const wire = readJson(name);
      const first = codec.decodeResponse(wire, ctx);
      const second = codec.decodeResponse(codec.encodeResponse(first, ctx), ctx);
      expect(second).toEqual(first);
    });
  });

  it('response.failed.json：status:"failed" 还原成响应体而不是错误体（42 §4.5：HTTP 200）', () => {
    const wire = readJson('response.failed.json');
    const res = codec.decodeResponse(wire, ctx);
    expect(res.finish_reason).toBe('error');
    // 10 §9.3 注意 3：原文进 raw 顶层一等字段
    expect(res.raw.finish_reason_provider).toBe('failed');
    const out = codec.encodeResponse(res, ctx) as Record<string, unknown>;
    expect(out['status']).toBe('failed');
    expect(out['error']).toEqual({
      code: 'server_error',
      message: 'Upstream failed while streaming.',
    });
    // 不得伪装成错误体（那会让客户端以为请求被拒）
    expect(out).not.toHaveProperty('choices');
  });

  it('网关错误信封 → Responses 错误体 {error:{message,type,code}}（20 §7.2）', () => {
    const errorEnvelope = (canonicalError: Record<string, unknown>) => ({
      ir_version: 'ag-ir/1' as const,
      kind: 'chat' as const,
      request_id: 'req_test_contract',
      usage: { units: {}, source: 'provider' as const },
      finish_reason: 'error' as const,
      payload: {
        message: {
          role: 'assistant' as const,
          parts: [{ type: 'refusal' as const, reason: '上游 deepseek 调用失败' }],
        },
      },
      warnings: [],
      raw: { nodes: { error: canonicalError } },
    });
    const out = codec.encodeResponse(errorEnvelope({ code: 'provider_unavailable' }), ctx) as {
      error: { message: string; type: string; code: string | null; param: null };
    };
    expect(out.error.message).toBe('上游 deepseek 调用失败');
    expect(out.error.type).toBe('server_error');
    expect(out.error.code).toBe('provider_unavailable');
    expect(out.error.param).toBeNull();
    expect(out).not.toHaveProperty('output');

    // 错误 type 按 20 §7.2 的映射表区分可重试/参数类；未登记的码不猜
    const typeOf = (code: string): string =>
      (codec.encodeResponse(errorEnvelope({ code }), ctx) as { error: { type: string } }).error
        .type;
    expect(typeOf('rate_limited')).toBe('rate_limit_error');
    expect(typeOf('quota_exceeded')).toBe('insufficient_quota');
    expect(typeOf('capability_unsupported')).toBe('invalid_request_error');
    expect(typeOf('some_future_code')).toBe('server_error');
  });

  it('usage 全字段口径正确（40 §2.1 的 OpenAI Responses 列 + 42 §4.6 三行补充）', () => {
    const res = codec.decodeResponse(readJson('response.usage-full.json'), ctx);
    const tokens = res.usage.units.tokens;
    expect(tokens).toBeDefined();
    if (tokens === undefined) throw new Error('expected tokens');
    expect(tokens.input_tokens).toBe(2048);
    expect(tokens.output_tokens).toBe(96);
    expect(tokens.total_tokens).toBe(2144);
    // input_tokens_details.cached_tokens = kv cache 命中（与 chat 面顶层 prompt_cache_hit_tokens 同义不同位）
    expect(tokens.cache_read_tokens).toBe(1536);
    expect(tokens.reasoning_tokens).toBe(64);
    // 42 §4.6 补充 1：safety_tokens 只进 details，不加进 reasoning_tokens 也不加进 output_tokens
    expect(tokens.details?.['safety_tokens']).toBe(8);
    // 42 §4.6 补充 2：server_tool_use 是按次单位不是 token → usage.units.requests
    expect(res.usage.units.requests).toBe(3);
  });

  it('I4: usage.raw 逐字段保留（含 *_details 嵌套与 server_tool_use）', () => {
    const wire = readJson('response.usage-full.json') as { usage: Record<string, unknown> };
    const res = codec.decodeResponse(wire, ctx);
    expect(res.usage.raw).toEqual(wire.usage);
    // 回写原样还原（I4 的对账价值）
    const out = codec.encodeResponse(res, ctx) as { usage: Record<string, unknown> };
    expect(out.usage).toEqual(wire.usage);
  });

  it('usage 缺失 → tokens 键省略 + usage_missing warning（绝不用 0 表示未知）', () => {
    const res = codec.decodeResponse(readJson('response.no-usage.json'), ctx);
    expect(res.usage.units.tokens).toBeUndefined();
    expect('tokens' in res.usage.units).toBe(false);
    expect(res.warnings).toContain('usage_missing');
    // extractUsage 与 decodeResponse 口径一致（快慢同路径）
    expect(codec.extractUsage(readJson('response.no-usage.json')).units.tokens).toBeUndefined();
    expect(codec.extractUsage({ usage: null }).units.tokens).toBeUndefined();
  });

  it('extractUsage 同时接受「整个响应体」与终事件的 {response:{usage}}', () => {
    const bare = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
    expect(codec.extractUsage(bare).units.tokens).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
    expect(codec.extractUsage({ usage: bare }).units.tokens?.input_tokens).toBe(7);
    // 40 §2.3：Responses 的流式 usage 搭终事件 response.completed 的 response.usage
    expect(codec.extractUsage({ response: { usage: bare } }).units.tokens?.input_tokens).toBe(7);
    // 两者都不是：空 units，不用 0 冒充（10 §6.1 规则 2）
    expect(codec.extractUsage({ output: [] }).units.tokens).toBeUndefined();
    expect(codec.extractUsage(null).units.tokens).toBeUndefined();
  });

  it('finish_reason 归一：completed → stop，原文进 raw 供回写', () => {
    const res = codec.decodeResponse(readJson('response.tools.json'), ctx);
    expect(res.finish_reason).toBe('stop');
    expect(res.raw.finish_reason_provider).toBe('completed');
    const out = codec.encodeResponse(res, ctx) as { status: string };
    expect(out.status).toBe('completed');
  });

  it('finish_reason 归一：incomplete + max_output_tokens → length，incomplete_details 原样回写', () => {
    const res = codec.decodeResponse(readJson('response.incomplete.json'), ctx);
    expect(res.finish_reason).toBe('length');
    const out = codec.encodeResponse(res, ctx) as {
      status: string;
      incomplete_details?: { reason: string };
    };
    expect(out.status).toBe('incomplete');
    expect(out.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('未命中的 status → other + warning，绝不静默 stop（10 §9.3 注意 2）', () => {
    const wire = {
      id: 'resp_test_weird',
      object: 'response',
      created_at: 1_763_000_500,
      status: 'some_future_status',
      model: 'gpt-test-1',
      output: [],
    };
    const res = codec.decodeResponse(wire, ctx);
    expect(res.finish_reason).toBe('other');
    expect(res.warnings).toContain('unmapped_finish_reason:some_future_status');
    // normalizeFinishReason 单独调用也走同一张表
    expect(codec.normalizeFinishReason('some_future_status')).toBe('other');
    expect(codec.normalizeFinishReason('completed')).toBe('stop');
    expect(codec.normalizeFinishReason('failed')).toBe('error');
    expect(codec.normalizeFinishReason('max_output_tokens')).toBe('length');
    expect(codec.normalizeFinishReason('content_filter')).toBe('content_filter');
    expect(
      codec.normalizeFinishReason({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
      }),
    ).toBe('content_filter');
    expect(codec.normalizeFinishReason({ status: 'incomplete' })).toBe('other');
    expect(codec.normalizeFinishReason(wire)).toBe('other');
    // 跨格式时不得照抄别家的 status 原文（10 §7.2 第 1 条的同格式前提）
    const crossFormat = {
      ir_version: 'ag-ir/1' as const,
      kind: 'chat' as const,
      request_id: 'resp_cross',
      usage: { units: {}, source: 'provider' as const },
      finish_reason: 'stop' as const,
      payload: {
        message: { role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'hi' }] },
      },
      warnings: [],
      raw: { source_provider: 'anthropic', finish_reason_provider: 'end_turn' },
    };
    expect((codec.encodeResponse(crossFormat, ctx) as { status: string }).status).toBe('completed');
  });

  it('响应回写：output[] 按 _raw 对象标识分组还原（一个 message item 带 N 个 content part）', () => {
    const res = codec.decodeResponse(readJson('response.basic.json'), ctx);
    const out = codec.encodeResponse(res, ctx) as { output: Array<Record<string, unknown>> };
    expect(out.output).toHaveLength(1);
    expect(out.output[0]?.['type']).toBe('message');
    expect(out.output[0]?.['id']).toBe('msg_test_1');
    const content = out.output[0]?.['content'] as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: 'output_text',
      text: 'Let me check the weather for you.',
      annotations: [],
    });
  });

  it('output_text 的 annotations 落 SearchResultPart，回写时还原且不重复（42 §4.4）', () => {
    const res = codec.decodeResponse(readJson('response.usage-full.json'), ctx);
    const parts = asChatResponsePayload(res)?.message.parts ?? [];
    const citations = parts.filter((p) => p.type === 'search_result');
    expect(citations).toHaveLength(1);
    if (citations[0]?.type !== 'search_result') throw new Error('expected search_result');
    expect(citations[0].url).toBe('https://example.com/weather/paris');
    expect(citations[0].title).toBe('Paris weather');

    const out = codec.encodeResponse(res, ctx) as {
      output: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const annotations = out.output[0]?.content[0]?.['annotations'] as unknown[];
    expect(annotations).toHaveLength(1);
  });

  it('未知 output item 类型 → UnknownPart + warning，不静默忽略（42 §4.4）', () => {
    const wire = {
      id: 'resp_test_unknown_item',
      object: 'response',
      created_at: 1_763_000_500,
      status: 'completed',
      model: 'gpt-test-1',
      output: [{ type: 'item_reference', id: 'item_test_1' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    const res = codec.decodeResponse(wire, ctx);
    const parts = asChatResponsePayload(res)?.message.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe('unknown');
    if (parts[0]?.type !== 'unknown') throw new Error('expected unknown part');
    expect(parts[0].raw_type).toBe('item_reference');
    expect(res.warnings).toContain('unknown_output_item_type:item_reference');
    // 回写：原样还原（不猜、不丢）
    const out = codec.encodeResponse(res, ctx) as { output: unknown[] };
    expect(out.output[0]).toEqual({ type: 'item_reference', id: 'item_test_1' });
  });

  it('没有 output / 没有 usage 时不炸', () => {
    const res = codec.decodeResponse(
      { id: 'x', object: 'response', status: 'completed', model: 'm' },
      ctx,
    );
    expect(asChatResponsePayload(res)?.message.parts).toEqual([]);
    expect(res.finish_reason).toBe('stop');
    expect(res.warnings).toContain('usage_missing');
  });

  it('非 object 的请求/响应体直接抛（由管道的 canonical_decode_error 收口）', () => {
    expect(() => codec.decode('not an object', ctx)).toThrow();
    expect(() => codec.decodeResponse(42, ctx)).toThrow();
    expect(() => codec.decodeEnvelope(null, ctx)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// F：流式事件序列等价
// ---------------------------------------------------------------------------

describe('openai.responses 流式', () => {
  const ctx = makeCtx();
  const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });
  const sseText = readText('response.stream.sse.txt');

  it('F. 流式事件序列等价（decodeStream → encodeStream）', async () => {
    const frames = await collect(codec.decodeStream(parseSse(sseText), ctx));
    expect(frames.length).toBeGreaterThan(0);
    // seq 从 0 单调递增；kind 恒为 chat；ts 来自注入的时钟
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i));
    expect(frames.every((f) => f.kind === 'chat')).toBe(true);
    expect(frames.every((f) => f.ts === FIXED_CLOCK.now())).toBe(true);

    const reEncoded = joinSse(await collect(codec.encodeStream(toAsync(frames), ctx)));
    expect(eventShape(reEncoded)).toEqual(eventShape(sseText));
    // 42 §4.5 末行：**没有 `data: [DONE]` 哨兵**
    expect(reEncoded).not.toContain('[DONE]');
    // 42 §2.1：每个事件带单调递增的 sequence_number
    const seqs = [...reEncoded.matchAll(/"sequence_number":(\d+)/g)].map((m) => Number(m[1]));
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it('F2. tool_call 分片被完整累加（part.end 带完整 tool_use part，带 D2 的 tool_call_id）', async () => {
    const frames = await collect(codec.decodeStream(parseSse(sseText), ctx));
    const metaFrames = frames.filter((f) => f.event === 'meta');
    const notes = metaFrames.map((f) => (f.data as { notes: Record<string, unknown> }).notes);
    const ends = notes
      .map((n) => asRecord(n[PART_FRAME_NOTE_KEY]))
      .filter((n) => n?.['phase'] === 'end');
    expect(ends).toHaveLength(2); // message 的 text + function_call
    const toolEnd = ends.find((n) => asRecord(n?.['part'])?.['type'] === 'tool_use');
    expect(toolEnd).toBeDefined();
    const part = asRecord(toolEnd?.['part']);
    expect(part?.['type']).toBe('tool_use');
    // canonical 的 ToolUsePart.id 取 call_id（42 §4.2 的实现收窄，见 decodeItem 注释）
    expect(part?.['id']).toBe('call_test_stream_1');
    expect(part?.['name']).toBe('get_weather');
    expect(part?.['input']).toEqual({ city: 'Paris' });
    expect(part?.['raw_arguments']).toBe('{"city":"Paris"}');

    // D2（42 §4.3）：参数增量帧带 tool_call_id = wire 的 item_id
    const argDeltas = frames
      .filter((f) => f.event === 'delta')
      .map((f) => f.data as { tool_input_json?: string; tool_call_id?: string })
      .filter((d) => d.tool_input_json !== undefined);
    expect(argDeltas).toHaveLength(2);
    expect(argDeltas.every((d) => d.tool_call_id === 'fc_test_stream')).toBe(true);
  });

  it('F3. 流式 usage 走 usage 帧并搭上 end 帧；没有 [DONE]', async () => {
    const frames = await collect(codec.decodeStream(parseSse(sseText), ctx));
    const usageFrames = frames.filter((f) => f.event === 'usage');
    expect(usageFrames).toHaveLength(1);
    const tokens = (
      usageFrames[0]?.data as { usage: { units: { tokens?: { input_tokens: number } } } }
    ).usage.units.tokens;
    expect(tokens?.input_tokens).toBe(48);
    // I4：raw 逐字段保留
    expect((usageFrames[0]?.data as { usage: { raw?: unknown } }).usage.raw).toEqual({
      input_tokens: 48,
      input_tokens_details: { cached_tokens: 16 },
      output_tokens: 31,
      output_tokens_details: { reasoning_tokens: 12 },
      total_tokens: 79,
    });

    const endFrame = frames.find((f) => f.event === 'end');
    const data = endFrame?.data as {
      finish_reason: string;
      usage?: { units: { tokens?: unknown } };
    };
    expect(data.finish_reason).toBe('stop');
    expect(data.usage?.units.tokens).toBeDefined();
  });

  it('F4. 无对应帧的 wire 事件搭 meta 帧透传，不静默丢（42 §4.5 结论 1）', async () => {
    const frames = await collect(codec.decodeStream(parseSse(sseText), ctx));
    const passthroughs = frames
      .filter((f) => f.event === 'meta')
      .map((f) => (f.data as { notes: Record<string, unknown> }).notes)
      .map((n) => asRecord(n[PASSTHROUGH_FRAME_NOTE_KEY]))
      .filter((n) => n !== undefined);
    const names = passthroughs.map((n) => n?.['event']);
    // response.in_progress（无新增信息）+ response.content_part.added（同 index 的
    // part.begin 已由 output_item.added 发出）+ 已由 .done 收尾的 output_item.done ×2
    expect(names).toEqual([
      'response.in_progress',
      'response.content_part.added',
      'response.output_item.done',
      'response.output_item.done',
    ]);
  });

  it('F5. 残缺流（没有终事件）补一个 end 帧，客户端不会永远等不到结束', async () => {
    const truncated = sseText.split('event: response.completed')[0] ?? '';
    const frames = await collect(codec.decodeStream(parseSse(truncated), ctx));
    const end = frames.find((f) => f.event === 'end');
    expect(end).toBeDefined();
    expect((end?.data as { finish_reason: string }).finish_reason).toBe('stop');
  });

  it('F6. response.failed 是 HTTP 200 的事件 → error{fatal:true}，不是成功（42 §4.5 末行）', async () => {
    const failed = [
      'event: response.created',
      'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_test_failed_stream","object":"response","created_at":1763000400,"status":"in_progress","model":"gpt-test-1","output":[],"usage":null}}',
      '',
      'event: response.failed',
      'data: {"type":"response.failed","sequence_number":1,"response":{"id":"resp_test_failed_stream","object":"response","created_at":1763000400,"status":"failed","error":{"code":"server_error","message":"upstream exploded"},"output":[],"usage":null}}',
      '',
    ].join('\n');
    const frames = await collect(codec.decodeStream(parseSse(failed), ctx));
    const errorFrame = frames.find((f) => f.event === 'error');
    expect(errorFrame).toBeDefined();
    const data = errorFrame?.data as {
      error: { code: string; message: string; provider_code?: string };
      fatal: boolean;
    };
    expect(data.fatal).toBe(true);
    expect(data.error.message).toBe('upstream exploded');
    expect(data.error.provider_code).toBe('server_error');
    // 不得再补一个 end 帧把失败说成成功
    expect(frames.find((f) => f.event === 'end')).toBeUndefined();

    // 回写：error 帧 → response.failed 事件
    const reEncoded = joinSse(await collect(codec.encodeStream(toAsync(frames), ctx)));
    expect(eventShape(reEncoded)).toEqual(['response.created', 'response.failed']);
  });

  it('F7. 未知流式事件类型搭 meta 帧透传 + warning（前向兼容，不静默丢）', async () => {
    const future = [
      'event: response.created',
      'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_test_future","object":"response","created_at":1763000400,"status":"in_progress","model":"gpt-test-1","output":[],"usage":null}}',
      '',
      'event: response.brand_new_event',
      'data: {"type":"response.brand_new_event","sequence_number":1,"foo":"bar"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","sequence_number":2,"response":{"id":"resp_test_future","object":"response","created_at":1763000400,"status":"completed","model":"gpt-test-1","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      '',
    ].join('\n');
    const frames = await collect(codec.decodeStream(parseSse(future), ctx));
    expect(ctx.warnings).toContain('unknown_stream_event:response.brand_new_event');
    const reEncoded = joinSse(await collect(codec.encodeStream(toAsync(frames), ctx)));
    expect(reEncoded).toContain('event: response.brand_new_event');
    expect(reEncoded).toContain('"foo":"bar"');
  });
});

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

describe('openai.responses AdaptorMeta', () => {
  it('format / modalities / lazy decode 声明与实现一致', async () => {
    const { openAIResponsesAdaptorMeta } = await import('./index.js');
    const meta = openAIResponsesAdaptorMeta();
    expect(meta.format).toBe('openai.responses');
    expect(meta.modality).toBe('chat');
    expect(meta.status).toBe('implemented');
    expect(meta.supports_lazy_decode).toBe(true);
    // 42 §5.2：夹具目录是 from-docs/（官方文档样本，未经 live 验证）
    expect(meta.fixtures).toBe('adaptors/fixtures/openai-responses/from-docs');
    // 42 §4.4：显式拒的四个字段必须登记进 unsupported_fields（S2 参数预检的输入）
    for (const field of ['previous_response_id', 'conversation', 'background', 'include']) {
      expect(meta.unsupported_fields).toContain(field);
    }

    const codec = new OpenAIResponsesCodec({ clock: FIXED_CLOCK });
    expect(codec.format).toBe('openai.responses');
    expect(codec.modalities).toEqual(['chat']);
    expect(codec.decodeEnvelope).toBeTypeOf('function');
  });
});
