/**
 * adaptors/anthropic-messages/codec.test.ts —— Anthropic Messages adaptor 的契约测试。
 *
 * 两层目标（40 §1.5 原文）：
 *   - **adaptor 层**：wire → canonical → wire 对本 adaptor 支持的格式无损；
 *   - 硬门槛：40 §1.5 的 6 条 adaptor 断言 + 任务书追加的 7 条 + Anthropic 专项 6 条。
 *
 * 目录约定：夹具在 `adaptors/fixtures/anthropic-messages/`，**手写、无真实凭据/个人信息/
 * 内网地址/绝对 home 路径**（40 §1.6 检查清单最后一条）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  RequestContext,
  StreamFrame,
} from '../../ir/index.js';
import { CTX_STATE_KEYS } from '../../ir/index.js';
import { MutableRequestContext } from '../../gateway-core/context.js';
import type { ResolvedRoute } from '../../ir/index.js';
import { AnthropicMessagesCodec, PART_FRAME_NOTE_KEY } from './codec.js';
const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'anthropic-messages');

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function fixtureJson(name: string): unknown {
  return JSON.parse(fixture(name));
}

/** 收集 async iterable 成数组（流式断言用）。 */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

/** 把 SSE 文本按事件边界切成块——与 S6 的 collectEvents 切法一致。 */
function sseBlocks(text: string): string[] {
  return text
    .split(/\n\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

/** 从一串 SSE 文本里取出事件名序列（流式事件序列等价性断言用）。 */
function eventNames(sse: string[]): string[] {
  const names: string[] = [];
  for (const block of sse) {
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) names.push(line.slice(6).trim());
    }
  }
  return names;
}

function makeCtx(overrides: Partial<RequestContext> = {}): MutableRequestContext {
  const ctx = new MutableRequestContext({
    request_id: 'req_test_anthropic',
    started_at: 0,
    deadline: 30_000,
    client_format: 'anthropic.messages',
    client_raw_headers: {},
    auth: { key_id: 'key_test' },
  });
  Object.assign(ctx, overrides);
  return ctx;
}

/** 固定时钟：流式帧的 ts 必须可断言（禁止 Date.now()）。 */
function fixedClock(startMs = 1_700_000_000_000, stepMs = 1) {
  let current = startMs;
  return {
    now(): number {
      const v = current;
      current += stepMs;
      return v;
    },
  };
}

function makeCodec(): AnthropicMessagesCodec {
  return new AnthropicMessagesCodec({ clock: fixedClock() });
}

/** 构造一个最小的 ResolvedRoute（S2 之后才填，codec 不依赖它）。 */
const ROUTE: ResolvedRoute = {
  access_path: 'anthropic',
  provider: 'anthropic',
  provider_format: 'anthropic.messages',
  model: 'claude-test-1',
  full_model_id: 'anthropic/claude-test-1',
  attempt_plan: [],
  fast_path_eligible: true,
};

/** 给 ctx 补上 route（Object.assign 需要 route 存在才能赋值）。 */
function ctxWithRoute(ctx: MutableRequestContext): MutableRequestContext {
  ctx.route = ROUTE;
  return ctx;
}

/**
 * `normalizableDiff(a, b)`：40 §1.5 断言 B 的"归一化字段白名单"比较器。
 *
 * fast path 下响应体/请求体**字节级**透传，唯一允许的差异是"统计口径错位修正"那三类
 * （20 §4.2：finish_reason / tool_call id / usage 口径）。这里把它们做成路径白名单，
 * 白名单外的任何差异都算失败——比"直接 toEqual"更严格，比"逐字节比"更贴合语义。
 */
function normalizableDiff(a: unknown, b: unknown, path = '$'): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b) return [`${path}: 类型不同 (${typeof a} vs ${typeof b})`];
  if (typeof a !== 'object' || a === null || b === null) {
    return a === b ? [] : [`${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${path}: 一侧是数组一侧不是`];
    if (a.length !== b.length) return [`${path}: 数组长度 ${a.length} vs ${b.length}`];
    const diffs: string[] = [];
    for (let i = 0; i < a.length; i += 1)
      diffs.push(...normalizableDiff(a[i], b[i], `${path}[${i}]`));
    return diffs;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const diffs: string[] = [];
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (!(k in ao)) {
      diffs.push(`${path}.${k}: 仅右侧有`);
      continue;
    }
    if (!(k in bo)) {
      diffs.push(`${path}.${k}: 仅左侧有`);
      continue;
    }
    diffs.push(...normalizableDiff(ao[k], bo[k], `${path}.${k}`));
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// 40 §1.5 的 6 条 adaptor round-trip 断言（对每个请求夹具跑一遍）
// ---------------------------------------------------------------------------

const REQUEST_FIXTURES = [
  'request.basic.json',
  'request.system-blocks.json',
  'request.multisystem.json',
  'request.tools.json',
  'request.thinking.json',
  'request.server-tool.json',
  'request.multimodal.json',
  'request.unknown-top-level.json',
  'request.stream.json',
];

describe.each(REQUEST_FIXTURES)('adaptor anthropic.messages round-trip · %s', (name) => {
  const wire = fixtureJson(name) as Record<string, unknown>;
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('A. decode → encode 幂等（decode(encode(decode(wire))) === decode(wire)）', () => {
    const c1 = codec.decode(wire, ctx);
    const c2 = codec.decode(codec.encode(c1, ctx).body, ctx);
    expect(c2).toEqual(c1);
  });

  it('B. same-format fast path 字节级透传', () => {
    const c1 = codec.decode(wire, ctx);
    const rawBody = Buffer.from(JSON.stringify(wire), 'utf8');
    const fpCtx = ctxWithRoute(makeCtx({ fast_path: true }));
    fpCtx.state[CTX_STATE_KEYS.RAW_BODY] = rawBody;

    const encoded = codec.encode(c1, fpCtx);

    expect(encoded.fast_path).toBe(true);
    expect(encoded.raw_bytes).toBeDefined();
    expect(
      normalizableDiff(JSON.parse((encoded.raw_bytes as Buffer).toString('utf8')), wire),
    ).toEqual([]);
    // fast path 下不允许产生任何结构诊断——那说明我们"假装透传"其实做了事。
    expect(encoded.diagnostics ?? []).toEqual([]);
  });

  it('C. 未知顶层字段不丢（decode 进 unmapped，encode 写回）', () => {
    const withExtra: Record<string, unknown> = { ...wire, __some_future_field: { a: 1 } };
    const c = codec.decode(withExtra, ctx);
    expect(c.raw.unmapped?.['__some_future_field']).toEqual({ a: 1 });

    const out = codec.encode(c, ctx).body as Record<string, unknown>;
    expect(out['__some_future_field']).toEqual({ a: 1 });
  });

  it('D. 畸形 tool 参数不被销毁（raw_arguments 原样回写）', () => {
    const badArgs = '这不是合法 JSON，也不是 {}';
    const badWire: Record<string, unknown> = {
      model: 'claude-test-1',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_test_bad',
              name: 't',
              input: { ok: true },
              raw_arguments: badArgs,
            },
          ],
        },
      ],
    };
    const c = codec.decode(badWire, ctx);
    const part = (c.payload as { messages: Array<{ parts: unknown[] }> }).messages[1]!.parts[0] as {
      type: string;
      raw_arguments?: string;
    };
    expect(part.raw_arguments).toBe(badArgs);

    const out = codec.encode(c, ctx).body as {
      messages: Array<{ content: Array<{ input: unknown }> }>;
    };
    expect(out.messages[1]!.content[0]!.input).toBe(badArgs);
  });

  it('E. 多 system block 不丢', () => {
    const multi: Record<string, unknown> = {
      model: 'claude-test-1',
      max_tokens: 64,
      system: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const c = codec.decode(multi, ctx);
    expect((c.payload as { system?: unknown[] }).system).toHaveLength(2);

    const out = codec.encode(c, ctx).body as { system: unknown[] };
    expect(out.system).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 任务书追加的 7 条
// ---------------------------------------------------------------------------

describe('round-trip：任务书追加断言', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('1. decode → encode idempotence（deep equal，含响应夹具）', () => {
    for (const name of REQUEST_FIXTURES) {
      const wire = fixtureJson(name);
      const c1 = codec.decode(wire, ctx);
      const c2 = codec.decode(codec.encode(c1, ctx).body, ctx);
      expect(c2, name).toEqual(c1);
    }
    for (const name of [
      'response.basic.json',
      'response.tools.json',
      'response.usage-full.json',
      'response.no-usage.json',
    ]) {
      const wire = fixtureJson(name);
      const r1 = codec.decodeResponse(wire, ctx);
      const r2 = codec.decodeResponse(codec.encodeResponse(r1, ctx), ctx);
      expect(r2, name).toEqual(r1);
    }
  });

  it('2. same-format fast path 字节级透传（normalizableDiff 为空）', () => {
    const wire = fixtureJson('request.tools.json');
    const rawBody = Buffer.from(JSON.stringify(wire), 'utf8');
    const fpCtx = ctxWithRoute(makeCtx({ fast_path: true }));
    fpCtx.state[CTX_STATE_KEYS.RAW_BODY] = rawBody;

    const encoded = codec.encode(codec.decode(wire, ctx), fpCtx);

    expect(encoded.fast_path).toBe(true);
    expect(
      normalizableDiff(JSON.parse((encoded.raw_bytes as Buffer).toString('utf8')), wire),
    ).toEqual([]);
  });

  it('3. 未知顶层字段 survive decode 且被 encode 写回', () => {
    const withExtra = {
      ...(fixtureJson('request.basic.json') as Record<string, unknown>),
      zz_future: [1, 2],
    };
    const c = codec.decode(withExtra, ctx);
    expect(c.raw.unmapped?.['zz_future']).toEqual([1, 2]);
    const out = codec.encode(c, ctx).body as Record<string, unknown>;
    expect(out['zz_future']).toEqual([1, 2]);
  });

  it('4. 畸形 tool 参数不被销毁', () => {
    const c = codec.decode(
      {
        model: 'claude-test-1',
        max_tokens: 8,
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_test_bad',
                name: 't',
                input: {},
                raw_arguments: '坏参数{',
              },
            ],
          },
        ],
      },
      ctx,
    );
    const out = codec.encode(c, ctx).body as {
      messages: Array<{ content: Array<{ input: unknown }> }>;
    };
    expect(out.messages[1]!.content[0]!.input).toBe('坏参数{');
  });

  it('5. 多 system blocks 不丢', () => {
    const wire = fixtureJson('request.multisystem.json');
    const c = codec.decode(wire, ctx);
    expect((c.payload as { system?: unknown[] }).system).toHaveLength(3);
    const out = codec.encode(c, ctx).body as { system: unknown[] };
    expect(out.system).toHaveLength(3);
    expect((out.system[1] as { cache_control?: { ttl?: string } }).cache_control?.ttl).toBe('1h');
  });

  it('6. 流式事件序列等价（decodeStream → encodeStream → 事件形状一致）', async () => {
    const sseText = fixture('response.stream.sse.txt');
    const frames = await collect(codec.decodeStream(toAsync(sseBlocks(sseText)), ctx));
    const reEncoded = (await collect(codec.encodeStream(toAsync(frames), ctx))) as string[];

    expect(eventNames(reEncoded)).toEqual(eventNames(sseBlocks(sseText)));
  });

  it('7. decodeEnvelope 只返回路由必需集', () => {
    const wire = fixtureJson('request.tools.json');
    const shallow = codec.decodeEnvelope(wire, ctx);

    expect(shallow.source_format).toBe('anthropic.messages');
    expect(shallow.kind).toBe('chat');
    expect(shallow.model).toBe('claude-test-1');
    expect(shallow.stream).toBe(false);
    expect(shallow.bytes).toBe(Buffer.byteLength(JSON.stringify(wire), 'utf8'));
    expect(shallow.default_path).toBe('/v1/messages');
    expect(shallow.usage_locations).toEqual(['message_start.usage', 'message_delta.usage']);

    // 关键：**不物化** messages/system/tools（D-fastpath-1 的全部意义所在）。
    const keys = Object.keys(shallow);
    expect(keys).not.toContain('messages');
    expect(keys).not.toContain('system');
    expect(keys).not.toContain('tools');
    expect(keys).not.toContain('payload');
    // `request.tools.json` 没带 ag_agentic_loop，所以这个键也不该出现
    expect(keys).not.toContain('gateway_agentic_loop');
    expect(keys.sort()).toEqual(
      [
        'bytes',
        'default_path',
        'kind',
        'model',
        'source_format',
        'stream',
        'usage_locations',
      ].sort(),
    );
  });

  it('7b. ag_agentic_loop: true → gateway_agentic_loop（路由必需集，20 §5.1）', () => {
    const wire = { ...(fixtureJson('request.basic.json') as Record<string, unknown>) };
    wire['ag_agentic_loop'] = true;
    const shallow = codec.decodeEnvelope(wire, ctx);
    expect(shallow.gateway_agentic_loop).toBe(true);
    // 该键是**建模**的路由字段，不该同时出现在 unmapped 里
    expect(shallow.unmapped?.['ag_agentic_loop']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anthropic 专项
// ---------------------------------------------------------------------------

describe('Anthropic 专项：2026-10-21 协议变更', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('temperature / top_p / top_k 在 encode 时被丢弃并给出诊断', () => {
    const wire = fixtureJson('request.temperature.json');
    const c = codec.decode(wire, ctx);

    // canonical 是超集：三个字段都还在（OpenAI/Gemini 还要用，10 §9.4）。
    expect((c.payload as { params?: Record<string, unknown> }).params).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
    });

    const encoded = codec.encode(c, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['temperature']).toBeUndefined();
    expect(body['top_p']).toBeUndefined();
    expect(body['top_k']).toBeUndefined();
    expect(body['max_tokens']).toBe(1024);

    expect(encoded.warnings).toContain('temperature_unsupported');
    expect(encoded.dropped).toEqual(
      expect.arrayContaining(['params.temperature', 'params.top_p', 'params.top_k']),
    );
    const codes = (encoded.diagnostics ?? []).map((d) => d.code);
    expect(codes.filter((c) => c === 'temperature_unsupported')).toHaveLength(3);
    for (const d of encoded.diagnostics ?? []) {
      expect(d.level).toBe('warning');
      expect(d.to).toBe('anthropic.messages');
    }
    expect((encoded.diagnostics ?? []).map((d) => d.field_path)).toEqual(
      expect.arrayContaining(['params.temperature', 'params.top_p', 'params.top_k']),
    );
  });
});

describe('Anthropic 专项：D7c tool_use 移到段尾', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('tool_use 不在段尾时，encode 把它移到最后', () => {
    const c = codec.decode(
      {
        model: 'claude-test-1',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_test_a', name: 'a', input: {} },
              { type: 'text', text: 'after' },
              { type: 'tool_use', id: 'toolu_test_b', name: 'b', input: {} },
            ],
          },
        ],
      },
      ctx,
    );
    const out = codec.encode(c, ctx).body as {
      messages: Array<{ content: Array<{ type: string; id?: string }> }>;
    };
    const types = out.messages[1]!.content.map((b) => b.type);
    expect(types).toEqual(['text', 'tool_use', 'tool_use']);
    expect(out.messages[1]!.content[1]!.id).toBe('toolu_test_a');
    expect(out.messages[1]!.content[2]!.id).toBe('toolu_test_b');
  });

  it('本来就在段尾时顺序不变（不无谓重排）', () => {
    const wire = fixtureJson('request.tools.json');
    const out = codec.encode(codec.decode(wire, ctx), ctx).body as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    expect(out.messages[1]!.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
  });
});

describe('Anthropic 专项：多个 tool_result 放在同一条 user 消息里（与 OpenAI 的形状差异）', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  /**
   * canonical 的一条 `tool` 消息带 N 个 tool_result part（网关 agentic loop 的
   * `appendTurn` 就是把一轮的结果拼成一条）。
   *
   * 这条测试是**形状说明**，不是缺陷回归：OpenAI Chat 要求每个 tool_call_id 各跟一条
   * `role:"tool"` 消息（见 adaptors/openai-chat/codec.test.ts 的 H 组），而 Anthropic 的
   * `tool_result` 是 **user 消息 content 里的 block**，一轮的多个结果放在同一条 user
   * 消息里就是上游认可的正确形状——所以这边**不拆**，拆了反而是错的。
   */
  function canonicalWithTwoResults(): CanonicalRequestEnvelope {
    return {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      model: 'claude-test-1',
      source_format: 'anthropic.messages',
      payload: {
        messages: [
          { role: 'user', parts: [{ type: 'text', text: '巴黎现在几点、天气如何？' }] },
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool_use',
                id: 'toolu_test_a',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
              { type: 'tool_use', id: 'toolu_test_b', name: 'get_time', input: { tz: 'CET' } },
            ],
          },
          {
            role: 'tool',
            parts: [
              { type: 'tool_result', tool_use_id: 'toolu_test_a', content: '18°C, light rain' },
              { type: 'tool_result', tool_use_id: 'toolu_test_b', content: '14:05 CET' },
            ],
          },
        ],
      },
      raw: {},
    } as unknown as CanonicalRequestEnvelope;
  }

  it('一条 tool 消息 2 个 tool_result → 1 条 user 消息带 2 个 tool_result block', () => {
    const out = codec.encode(canonicalWithTwoResults(), ctx).body as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    // canonical tool role 折叠成 user（Anthropic 只有 user / assistant）
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const toolResults = out.messages[2]!.content.filter((b) => b['type'] === 'tool_result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults.map((b) => b['tool_use_id'])).toEqual(['toolu_test_a', 'toolu_test_b']);
    expect(toolResults.map((b) => b['content'])).toEqual(['18°C, light rain', '14:05 CET']);
    // 每条 tool_result 的 tool_use_id 都要能在上一条 assistant 消息里找到对应的 tool_use
    const toolUses = out.messages[1]!.content.filter((b) => b['type'] === 'tool_use');
    expect(toolUses.map((b) => b['id'])).toEqual(['toolu_test_a', 'toolu_test_b']);
    expect(toolResults.map((b) => b['tool_use_id']).sort()).toEqual(
      toolUses.map((b) => b['id']).sort(),
    );
  });

  it('decode 回来再 encode，wire 形状稳定（round-trip 不漂）', () => {
    const first = codec.encode(canonicalWithTwoResults(), ctx).body;
    const canonical = codec.decode(first, ctx);
    const second = codec.encode(canonical, ctx).body;
    expect(second).toEqual(first);
  });
});

describe('Anthropic 专项：usage 归一', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('total_tokens = input + cache_creation + cache_read + output；5m/1h 进 details', () => {
    const res = codec.decodeResponse(fixtureJson('response.usage-full.json'), ctx);
    const t = res.usage.units.tokens!;

    expect(t.input_tokens).toBe(120);
    expect(t.output_tokens).toBe(80);
    expect(t.cache_read_tokens).toBe(45);
    expect(t.cache_write_tokens).toBe(300);
    expect(t.reasoning_tokens).toBe(32);
    // 40 §2.1：Anthropic **不返回** total，官方口径自算。
    expect(t.total_tokens).toBe(120 + 300 + 45 + 80);
    expect(t.details).toEqual({ cache_write_ttl_5m: 200, cache_write_ttl_1h: 100 });

    // 40 §2.2 I2：thinking_tokens 已计入 output_tokens，必须告警防止双算。
    expect(res.warnings).toContain('reasoning_in_output');

    // I4：原始 usage 全量存档（含 service_tier 这种我们不建模的键）。
    expect(res.usage.raw).toMatchObject({
      input_tokens: 120,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 45,
      output_tokens: 80,
      service_tier: 'standard',
    });
  });

  it('I4：usage.raw 里未建模的键（service_tier）在 encodeResponse 时原样回写', () => {
    const res = codec.decodeResponse(fixtureJson('response.usage-full.json'), ctx);
    const out = codec.encodeResponse(res, ctx) as { usage: Record<string, unknown> };
    expect(out.usage['service_tier']).toBe('standard');
    expect(out.usage['cache_creation']).toEqual({
      ephemeral_5m_input_tokens: 200,
      ephemeral_1h_input_tokens: 100,
    });
    expect(out.usage['output_tokens_details']).toEqual({ thinking_tokens: 32 });
    expect(out.usage['total_tokens']).toBeUndefined(); // Anthropic 不返回 total
  });

  it('usage 缺失 → 省略 tokens 键 + usage_missing（不用 0 冒充）', () => {
    const res = codec.decodeResponse(fixtureJson('response.no-usage.json'), ctx);
    expect(res.usage.units.tokens).toBeUndefined();
    expect(res.warnings).toContain('usage_missing');
  });

  it('流式 usage 从 message_start + message_delta 合并', async () => {
    const sseText = fixture('response.stream.sse.txt');
    const frames = await collect(codec.decodeStream(toAsync(sseBlocks(sseText)), ctx));
    const end = frames.find((f) => f.event === 'end') as StreamFrame | undefined;
    expect(end).toBeDefined();
    const t = (end!.data as { usage?: { units: { tokens?: Record<string, number> } } }).usage?.units
      .tokens;
    expect(t).toBeDefined();
    expect(t!['input_tokens']).toBe(120); // 来自 message_start
    expect(t!['output_tokens']).toBe(55); // 来自 message_delta（message_start 的 1 是占位值）
    expect(t!['cache_creation_input_tokens']).toBeUndefined();
    expect(t!['cache_read_tokens']).toBe(45); // 两处都带同一累计值，覆盖而非相加
    expect(t!['cache_write_tokens']).toBe(300); // 只来自 message_start
    expect(t!['total_tokens']).toBe(120 + 300 + 45 + 55);
  });
});

describe('Anthropic 专项：finish_reason 归一', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_use'],
    ['stop_sequence', 'stop_sequence'],
    ['refusal', 'content_filter'],
    ['pause_turn', 'pause_turn'],
    ['model_context_window_exceeded', 'context_exceeded'],
  ])('%s → %s', (provider, canonical) => {
    expect(codec.normalizeFinishReason({ stop_reason: provider })).toBe(canonical);
  });

  it('未命中的 stop_reason → other + 告警，绝不静默 stop', () => {
    const res = codec.decodeResponse(
      {
        id: 'msg_test_x',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content: [{ type: 'text', text: 'x' }],
        stop_reason: 'brand_new_reason_2027',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ctx,
    );
    expect(res.finish_reason).toBe('other');
    expect(res.warnings).toContain('unmapped_finish_reason:brand_new_reason_2027');
    // 注意 3：原文双留——现在是 RawEnvelope 的一等字段，回写时用它（可逆）。
    expect(res.raw.finish_reason_provider).toBe('brand_new_reason_2027');
    // 一等字段不占用 unmapped（unmapped 只放真正未建模的顶层键）
    expect(res.raw.unmapped?.['finish_reason_provider']).toBeUndefined();
  });

  it('回写优先用 raw.finish_reason_provider（可逆性）', () => {
    const wire = fixtureJson('response.basic.json') as Record<string, unknown>;
    const r1 = codec.decodeResponse(wire, ctx);
    const out = codec.encodeResponse(r1, ctx) as Record<string, unknown>;
    expect(out['stop_reason']).toBe('end_turn');

    const weird = { ...wire, stop_reason: 'brand_new_reason_2027' };
    const r2 = codec.decodeResponse(weird, ctx);
    expect(r2.raw.source_provider).toBe('anthropic');
    const out2 = codec.encodeResponse(r2, ctx) as Record<string, unknown>;
    expect(out2['stop_reason']).toBe('brand_new_reason_2027');
    // 一等字段不得泄进响应体（它本来就不在 unmapped 里，天然安全）。
    expect(out2['finish_reason_provider']).toBeUndefined();
  });

  it('跨格式来的 stop_reason 原文**不**原样回写（OpenAI 的 "stop" → Anthropic 的 end_turn）', () => {
    // 这是 e2e「Anthropic 客户端 → OpenAI 上游」真实抓到的 bug：原文是 OpenAI 的 "stop"，
    // 照抄进 Anthropic 响应体就是非法 stop_reason，客户端会解析失败（10 §7.2 回写规则第 1 条
    // 的同格式前提 + 10 §9.3 注意 3 的"同格式回写才用原文"）。
    const res: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      request_id: 'req_test_anthropic',
      usage: {
        units: {
          tokens: {
            input_tokens: 18,
            output_tokens: 11,
            total_tokens: 29,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
          },
        },
        source: 'provider',
      },
      finish_reason: 'stop',
      payload: {
        message: {
          role: 'assistant',
          parts: [{ type: 'text', text: '端到端跑通了。' }],
        },
        model: 'gpt-test-1',
      },
      warnings: [],
      // 来源是 openai（provider codec 的 decodeResponse 写的）
      raw: { source_provider: 'openai', finish_reason_provider: 'stop' },
    };
    const out = codec.encodeResponse(res, ctx) as Record<string, unknown>;
    expect(out['stop_reason']).toBe('end_turn');
  });

  it('跨格式 + 来源缺失时也不信原文（保守走反查表）', () => {
    const res: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      request_id: 'req_test_anthropic',
      usage: { units: {}, source: 'provider' },
      finish_reason: 'length',
      payload: { message: { role: 'assistant', parts: [{ type: 'text', text: 'x' }] } },
      warnings: [],
      // 没有 source_provider（插件手搓的信封），原文又不在合法值集里 → 不信
      raw: { finish_reason_provider: 'length' },
    };
    const out = codec.encodeResponse(res, ctx) as Record<string, unknown>;
    expect(out['stop_reason']).toBe('max_tokens');
  });

  it('原文本身是合法 Anthropic 取值 → 原样回写（不管来源）', () => {
    const res: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      request_id: 'req_test_anthropic',
      usage: { units: {}, source: 'provider' },
      finish_reason: 'stop',
      payload: { message: { role: 'assistant', parts: [{ type: 'text', text: 'x' }] } },
      warnings: [],
      raw: { finish_reason_provider: 'end_turn' },
    };
    const out = codec.encodeResponse(res, ctx) as Record<string, unknown>;
    expect(out['stop_reason']).toBe('end_turn');
  });
});

describe('Anthropic 专项：内置 server tool → BuiltinTool', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('web_search_20250305 → BuiltinTool，版本串进 native.provider_tool_type', () => {
    const c = codec.decode(fixtureJson('request.server-tool.json'), ctx);
    const tools = (c.payload as { tools?: unknown[] }).tools!;
    expect(tools).toHaveLength(1);
    const tool = tools[0] as {
      type: string;
      name: string;
      config: Record<string, unknown>;
      native?: Record<string, unknown>;
      executor?: string;
    };
    expect(tool.type).toBe('builtin');
    expect(tool.name).toBe('web_search'); // canonical 稳定名，不带版本串
    expect(tool.native?.['provider_tool_type']).toBe('web_search_20250305');
    expect(tool.config).toEqual({ max_uses: 3 });
    expect(tool.executor).toBe('provider');

    // 反向：版本串从 native 还原，round-trip 无损。
    const out = codec.encode(c, ctx).body as { tools: Array<Record<string, unknown>> };
    expect(out.tools[0]).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
  });

  it('function tool → FunctionTool{parameters: input_schema}，且 Anthropic 侧无 type 字段', () => {
    const c = codec.decode(fixtureJson('request.tools.json'), ctx);
    const tools = (c.payload as { tools?: unknown[] }).tools!;
    expect(tools[0]).toMatchObject({ type: 'function', name: 'get_weather' });
    expect((tools[0] as { parameters: unknown }).parameters).toMatchObject({ type: 'object' });

    const out = codec.encode(c, ctx).body as { tools: Array<Record<string, unknown>> };
    expect(out.tools[0]!['type']).toBeUndefined();
    expect(out.tools[0]!['input_schema']).toEqual(
      (fixtureJson('request.tools.json') as { tools: Array<{ input_schema: unknown }> }).tools[0]!
        .input_schema,
    );
  });
});

describe('Anthropic 专项：thinking 与 effort 阈值表', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('budget_tokens 直接映射；thinking block 的 signature 保留', () => {
    const c = codec.decode(fixtureJson('request.thinking.json'), ctx);
    expect((c.payload as { params?: { thinking?: unknown } }).params?.thinking).toEqual({
      enabled: true,
      budget_tokens: 2048,
    });

    const out = codec.encode(c, ctx).body as Record<string, unknown>;
    expect(out['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });

    const assistant = (out['messages'] as Array<{ content: Array<Record<string, unknown>> }>)[1]!;
    expect(assistant.content[0]).toMatchObject({
      type: 'thinking',
      signature: 'ErUBCkYIBxgCKkDtest-signature-block',
    });
    expect(assistant.content[1]).toEqual({
      type: 'redacted_thinking',
      data: 'Et0BCkYIBxgCKkDtest-redacted-payload',
    });
  });

  it('effort 按 40 §3.2 阈值表换算成 budget_tokens 并记录用了哪一档', () => {
    const cases: Array<[string, number]> = [
      ['minimal', 1024],
      ['low', 2048],
      ['medium', 8192],
      ['high', 16384],
      ['xhigh', 32768],
      ['max', 64000],
    ];
    for (const [effort, budget] of cases) {
      const c = codec.decode(
        {
          model: 'claude-test-1',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'x' }],
        },
        ctx,
      );
      (c.payload as { params?: { thinking?: unknown } }).params!.thinking = {
        enabled: true,
        effort,
      } as never;

      const encoded = codec.encode(c, ctx);
      const body = encoded.body as Record<string, unknown>;
      expect(body['thinking'], effort).toEqual({ type: 'enabled', budget_tokens: budget });
      expect(encoded.warnings, effort).toContain(
        `thinking_effort_to_budget_tokens:${effort}->${budget}`,
      );
    }
  });

  it('response_format → drop + warning（10 §9.1：无对应，靠 prompt）', () => {
    const c = codec.decode(
      { model: 'claude-test-1', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] },
      ctx,
    );
    (c.payload as { params?: Record<string, unknown> }).params!.response_format = {
      type: 'json_object',
    };
    const encoded = codec.encode(c, ctx);
    expect((encoded.body as Record<string, unknown>)['response_format']).toBeUndefined();
    expect(encoded.warnings).toContain('response_format_unsupported');
    expect(encoded.dropped).toContain('params.response_format');
  });
});

describe('Anthropic 专项：未知 part 类型不抛错（20 §S1）', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('audio / video part 在 Anthropic 无对应 → 丢弃（不偷偷换成空 text）', () => {
    // 直接从 canonical 侧构造：Anthropic wire 上没有 audio block 类型，只有跨格式转过来
    // 才会出现 AudioPart/VideoPart。此时 10 §9.1 要求 drop + warning，
    // 而不是塞一个空 text block 让上游以为模型说了空话。
    const c = codec.decode(
      { model: 'claude-test-1', max_tokens: 64, messages: [{ role: 'user', content: 'keep me' }] },
      ctx,
    );
    (c.payload as { messages: Array<{ parts: unknown[] }> }).messages[0]!.parts = [
      { type: 'text', text: 'keep me' },
      { type: 'audio', source: { kind: 'inline', mime: 'audio/wav', data: 'YXVkaW8=' } },
      {
        type: 'video',
        source: { kind: 'uri', mime: 'video/mp4', uri: 'https://example.invalid/v.mp4' },
      },
    ];
    const out = codec.encode(c, ctx).body as { messages: Array<{ content: unknown[] }> };
    expect(out.messages[0]!.content).toEqual([{ type: 'text', text: 'keep me' }]);
  });

  it('asset 媒体（MediaRef 第三态）在 Anthropic 无对应 → 丢弃该 part', () => {
    const c = codec.decode(
      { model: 'claude-test-1', max_tokens: 64, messages: [{ role: 'user', content: 'keep me' }] },
      ctx,
    );
    (c.payload as { messages: Array<{ parts: unknown[] }> }).messages[0]!.parts = [
      { type: 'text', text: 'keep me' },
      { type: 'image', source: { kind: 'asset', mime: 'image/png', asset_id: 'asset_test123' } },
    ];
    const out = codec.encode(c, ctx).body as { messages: Array<{ content: unknown[] }> };
    expect(out.messages[0]!.content).toEqual([{ type: 'text', text: 'keep me' }]);
  });

  it('search_result block 往返无损（snippet ↔ content）', () => {
    const block = {
      type: 'search_result',
      title: 'AgentGateway',
      url: 'https://example.invalid/agentgateway',
      content: 'A self-hosted multi-modal LLM API gateway.',
      citation_index: 1,
    };
    const c = codec.decode(
      { model: 'claude-test-1', max_tokens: 64, messages: [{ role: 'user', content: [block] }] },
      ctx,
    );
    const part = (c.payload as { messages: Array<{ parts: unknown[] }> }).messages[0]!
      .parts[0] as Record<string, unknown>;
    expect(part).toEqual({
      type: 'search_result',
      source: 'anthropic',
      title: 'AgentGateway',
      url: 'https://example.invalid/agentgateway',
      snippet: 'A self-hosted multi-modal LLM API gateway.',
      // wire 的 content 同时喂给 snippet（SearchResultPart.snippet 必填）与 content（可选）
      content: 'A self-hosted multi-modal LLM API gateway.',
      citation_index: 1,
    });
    const out = codec.encode(c, ctx).body as { messages: Array<{ content: unknown[] }> };
    expect(out.messages[0]!.content[0]).toEqual(block);
  });

  it('未知 block → UnknownPart，原文进 raw', () => {
    const c = codec.decode(
      {
        model: 'claude-test-1',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [{ type: 'brand_new_block_2027', payload: { a: 1 } }],
          },
        ],
      },
      ctx,
    );
    const part = (c.payload as { messages: Array<{ parts: unknown[] }> }).messages[0]!.parts[0] as {
      type: string;
      raw_type?: string;
      raw: unknown;
    };
    expect(part.type).toBe('unknown');
    expect(part.raw_type).toBe('brand_new_block_2027');
    expect(part.raw).toEqual({ type: 'brand_new_block_2027', payload: { a: 1 } });

    // 反向：UnknownPart 原样还原成同一个 block（保真）。
    const out = codec.encode(c, ctx).body as { messages: Array<{ content: unknown[] }> };
    expect(out.messages[0]!.content[0]).toEqual({
      type: 'brand_new_block_2027',
      payload: { a: 1 },
    });
  });
});

describe('Anthropic 专项：流式帧细节', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('message_start → start 帧（带 model / session_id）', async () => {
    const frames = await collect(
      codec.decodeStream(toAsync(sseBlocks(fixture('response.stream.sse.txt'))), ctx),
    );
    const start = frames.find((f) => f.event === 'start')!;
    expect(start.data).toMatchObject({
      model: 'claude-test-1',
      client_format: 'anthropic.messages',
      provider_format: 'anthropic.messages',
      session_id: 'msg_test_stream',
    });
    expect(start.seq).toBe(0);
    expect(start.request_id).toBe('req_test_anthropic');
    expect(start.kind).toBe('chat');
  });

  it('seq 单调递增、ts 来自注入的 Clock（不是 Date.now）', async () => {
    const frames = await collect(
      codec.decodeStream(toAsync(sseBlocks(fixture('response.stream.sse.txt'))), ctx),
    );
    const seqs = frames.map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const f of frames) expect(typeof f.ts).toBe('number');
  });

  it('tool_use 的 input_json_delta 分片在 part.end 合成完整 input', async () => {
    const frames = await collect(
      codec.decodeStream(toAsync(sseBlocks(fixture('response.stream.sse.txt'))), ctx),
    );
    const partEnds = frames.filter(
      (f) =>
        f.event === 'meta' &&
        (f.data as { notes?: Record<string, { phase?: string }> }).notes?.[PART_FRAME_NOTE_KEY]
          ?.phase === 'end',
    );
    const toolEnd = partEnds.find(
      (f) =>
        (f.data as { notes?: Record<string, { part?: { type?: string } }> }).notes?.[
          PART_FRAME_NOTE_KEY
        ]?.part?.type === 'tool_use',
    );
    expect(toolEnd).toBeDefined();
    const part = (toolEnd!.data as { notes: Record<string, { part: Record<string, unknown> }> })
      .notes[PART_FRAME_NOTE_KEY]!.part;
    expect(part).toEqual({
      type: 'tool_use',
      id: 'toolu_test_stream',
      name: 'get_weather',
      input: { city: 'Paris' },
    });
  });

  it('message_delta → end 帧带 finish_reason + 合并后的 usage', async () => {
    const frames = await collect(
      codec.decodeStream(toAsync(sseBlocks(fixture('response.stream.sse.txt'))), ctx),
    );
    const end = frames.find((f) => f.event === 'end')!;
    expect((end.data as { finish_reason?: string }).finish_reason).toBe('tool_use');
    expect((end.data as { usage?: unknown }).usage).toBeDefined();
  });

  it('error 事件 → error 帧（fatal）', async () => {
    const frames = await collect(
      codec.decodeStream(
        toAsync([
          'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        ]),
        ctx,
      ),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('error');
    expect((frames[0]!.data as { fatal?: boolean }).fatal).toBe(true);
    expect(
      (frames[0]!.data as { error?: { code?: string; retryable?: boolean } }).error?.code,
    ).toBe('provider_unavailable');
  });

  it('残缺流（没有 message_delta）也能在 message_stop 补出 end 帧', async () => {
    const frames = await collect(
      codec.decodeStream(
        toAsync([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-test-1","usage":{"input_tokens":3}}}',
          'event: message_stop\ndata: {"type":"message_stop"}',
        ]),
        ctx,
      ),
    );
    expect(frames.filter((f) => f.event === 'end')).toHaveLength(1);
  });

  it('ping / 未知事件被透传而不丢弃（keep-alive 不能丢）', async () => {
    const frames = await collect(
      codec.decodeStream(toAsync(sseBlocks(fixture('response.stream.sse.txt'))), ctx),
    );
    const pings = frames.filter((f) => f.event === 'meta');
    // 两个 part 边界帧（begin/end）× 2 个 block + 1 个 ping 透传帧
    expect(pings.length).toBe(5);
    const out = (await collect(codec.encodeStream(toAsync(frames), ctx))) as string[];
    expect(out.some((b) => b.startsWith('event: ping'))).toBe(true);
  });
});

describe('Anthropic 专项：encodeStream 反向', () => {
  const codec = makeCodec();
  const ctx = ctxWithRoute(makeCtx());

  it('canonical 帧 → Anthropic SSE 事件串', async () => {
    const sseText = fixture('response.stream.sse.txt');
    const frames = await collect(codec.decodeStream(toAsync(sseBlocks(sseText)), ctx));
    const out = (await collect(codec.encodeStream(toAsync(frames), ctx))) as string[];

    // 每个产出都是合法的 SSE 事件块
    for (const block of out) {
      expect(block).toMatch(/^event: [a-z_]+\ndata: \{.*\}\n\n$/);
    }
    expect(out.some((b) => b.startsWith('event: message_start'))).toBe(true);
    expect(out.some((b) => b.startsWith('event: content_block_delta'))).toBe(true);
    expect(out.some((b) => b.startsWith('event: message_delta'))).toBe(true);
    expect(out.some((b) => b.startsWith('event: message_stop'))).toBe(true);
  });

  it('error 帧 → error 事件', async () => {
    const out = (await collect(
      codec.encodeStream(
        toAsync([
          {
            event: 'error' as const,
            seq: 0,
            request_id: 'req_test_anthropic',
            kind: 'chat' as const,
            data: {
              error: {
                code: 'upstream_error' as const,
                message: 'boom',
                http_status: 502,
                retryable: false,
                request_id: 'req_test_anthropic',
              },
              fatal: true,
            },
            ts: 1,
          },
        ]),
        ctx,
      ),
    )) as string[];
    expect(out[0]).toContain('event: error');
    expect(out[0]).toContain('"message":"boom"');
  });
});

describe('Anthropic 专项：S1 惰性解码', () => {
  const codec = makeCodec();

  it('stream:true 时 shallow.stream = true，usage_locations 提示分两处', () => {
    const ctx = makeCtx();
    const wire = fixtureJson('request.stream.json');
    const shallow = codec.decodeEnvelope(wire, ctx);
    expect(shallow.stream).toBe(true);
    expect(shallow.usage_locations).toEqual(['message_start.usage', 'message_delta.usage']);
    expect(shallow.unmapped).toBeUndefined();
  });

  it('bytes 优先取 ctx.state 的原始字节长度', () => {
    const ctx = makeCtx();
    ctx.state[CTX_STATE_KEYS.RAW_BODY] = Buffer.from('x'.repeat(1234), 'utf8');
    const shallow = codec.decodeEnvelope(fixtureJson('request.basic.json'), ctx);
    expect(shallow.bytes).toBe(1234);
  });

  it('未知顶层键进 unmapped（供 10 §7.2 第 3 条回写）', () => {
    const shallow = codec.decodeEnvelope(fixtureJson('request.unknown-top-level.json'), makeCtx());
    expect(shallow.unmapped).toEqual({
      container: 'container_test123',
      mcp_servers: [{ type: 'url', url: 'https://mcp.example.invalid/sse', name: 'fixture-mcp' }],
      future_top_level_flag: { nested: [1, 2, 3], enabled: true },
    });
  });
});

describe('Anthropic 专项：fast path 与完整性', () => {
  const codec = makeCodec();

  it('fast path 时不做任何结构工作，路径与版本头正确', () => {
    const wire = fixtureJson('request.basic.json');
    const rawBody = Buffer.from(JSON.stringify(wire), 'utf8');
    const ctx = ctxWithRoute(makeCtx({ fast_path: true }));
    ctx.state[CTX_STATE_KEYS.RAW_BODY] = rawBody;

    const encoded = codec.encode(codec.decode(wire, ctx), ctx);
    expect(encoded.body).toBeUndefined();
    expect(encoded.fast_path).toBe(true);
    expect(encoded.raw_bytes).toBe(rawBody);
    expect(encoded.path).toBe('/v1/messages');
    expect(encoded.headers).toEqual({ 'anthropic-version': '2026-10-21' });
  });

  it('每个请求夹具的 canonical 都带 source_provider=anthropic', () => {
    const ctx = ctxWithRoute(makeCtx());
    for (const name of REQUEST_FIXTURES) {
      const c = codec.decode(fixtureJson(name), ctx);
      expect(c.raw.source_provider, name).toBe('anthropic');
      expect(c.source_format).toBe('anthropic.messages');
      expect(c.ir_version).toBe('ag-ir/1');
      expect(c.kind).toBe('chat');
    }
  });

  it('夹具目录里没有夹带凭据样式的字符串', () => {
    // 40 §1.6 检查清单最后一条的轻量自检：fixtures 也要过隐私检查。
    for (const f of readdirSync(FIXTURE_DIR)) {
      const text = fixture(f);
      expect(text, f).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(text, f).not.toMatch(/\/home\/[a-z]/);
      expect(text, f).not.toMatch(/\b10\.\d+\.\d+\.\d+\b/);
    }
  });

  it('max_tokens 缺失时告警（Anthropic 必填）', () => {
    const ctx = ctxWithRoute(makeCtx());
    const c = codec.decode(
      { model: 'claude-test-1', messages: [{ role: 'user', content: 'x' }] },
      ctx,
    );
    const encoded = codec.encode(c, ctx);
    expect((encoded.body as Record<string, unknown>)['max_tokens']).toBeUndefined();
    expect(encoded.warnings).toContain('max_output_tokens_missing');
  });

  it('stream:true → envelope.stream = {enabled, sse, bridge}', () => {
    const ctx = ctxWithRoute(makeCtx());
    const c = codec.decode(fixtureJson('request.stream.json'), ctx);
    expect(c.stream).toEqual({ enabled: true, mode: 'sse', on_mismatch: 'bridge' });
    expect((codec.encode(c, ctx).body as Record<string, unknown>)['stream']).toBe(true);
  });

  it('错误信封 → Anthropic 错误体（20 §7.2）', () => {
    const ctx = ctxWithRoute(makeCtx());
    const errRes: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'chat',
      request_id: 'req_test_anthropic',
      usage: { units: {}, source: 'provider' },
      finish_reason: 'error',
      payload: {
        message: { role: 'assistant', parts: [{ type: 'refusal', reason: 'blocked by policy' }] },
      },
      warnings: [],
      raw: {},
    };
    // 没有 raw.nodes.error 时退化成保守的 api_error + refusal 文本
    expect(codec.encodeResponse(errRes, ctx)).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'blocked by policy' },
    });
  });

  it('错误信封带 raw.nodes.error → 按 20 §7.2 填真实 type/code', () => {
    const ctx = ctxWithRoute(makeCtx());
    const makeErrRes = (err: Record<string, unknown>): CanonicalResponseEnvelope => ({
      ir_version: 'ag-ir/1',
      kind: 'chat',
      request_id: 'req_test_anthropic',
      usage: { units: {}, source: 'provider' },
      finish_reason: 'error',
      payload: {
        message: { role: 'assistant', parts: [{ type: 'refusal', reason: 'upstream failed' }] },
      },
      warnings: [],
      raw: { nodes: { error: err } },
    });

    // 500 / provider_unavailable → overloaded_error（20 §7.3 矩阵点名的 Anthropic 专有值）
    expect(
      codec.encodeResponse(
        makeErrRes({
          code: 'provider_unavailable',
          message: 'upstream 500',
          http_status: 500,
          retryable: true,
          request_id: 'req_test_anthropic',
        }),
        ctx,
      ),
    ).toEqual({
      type: 'error',
      error: { type: 'overloaded_error', code: 'provider_unavailable', message: 'upstream 500' },
    });

    // 429 / rate_limited → rate_limit_error
    expect(
      codec.encodeResponse(
        makeErrRes({
          code: 'rate_limited',
          message: 'slow down',
          http_status: 429,
          retryable: true,
          request_id: 'req_test_anthropic',
        }),
        ctx,
      ),
    ).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', code: 'rate_limited', message: 'slow down' },
    });

    // 400 / capability_unsupported → invalid_request_error
    expect(
      codec.encodeResponse(
        makeErrRes({
          code: 'capability_unsupported',
          message: 'model does not support tools',
          http_status: 400,
          retryable: false,
          request_id: 'req_test_anthropic',
        }),
        ctx,
      ),
    ).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'capability_unsupported',
        message: 'model does not support tools',
      },
    });

    // 401 / auth_failed → authentication_error
    expect(
      codec.encodeResponse(
        makeErrRes({
          code: 'auth_failed',
          message: 'bad key',
          http_status: 401,
          retryable: false,
          request_id: 'req_test_anthropic',
        }),
        ctx,
      ),
    ).toEqual({
      type: 'error',
      error: { type: 'authentication_error', code: 'auth_failed', message: 'bad key' },
    });

    // 表外码 → api_error 兜底，不猜更具体的值（40 §1.7）
    expect(
      codec.encodeResponse(
        makeErrRes({
          code: 'some_future_code',
          message: '?',
          http_status: 500,
          retryable: false,
          request_id: 'req_test_anthropic',
        }),
        ctx,
      ),
    ).toEqual({
      type: 'error',
      error: { type: 'api_error', code: 'some_future_code', message: '?' },
    });
  });

  it('reasoning_effort: "none" → 关思考（不发 thinking 字段）', () => {
    const ctx = ctxWithRoute(makeCtx());
    const c = codec.decode(
      { model: 'claude-test-1', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] },
      ctx,
    );
    // 自相矛盾的组合：enabled: true 但 effort: none。OpenAI 语义是"不要推理"，
    // 所以按"关"处理（normalizeThinkingEnabled），否则 Anthropic 会收到 budget_tokens。
    (c.payload as { params?: Record<string, unknown> }).params!.thinking = {
      enabled: true,
      effort: 'none',
    };
    const encoded = codec.encode(c, ctx);
    expect((encoded.body as Record<string, unknown>)['thinking']).toBeUndefined();
    expect(encoded.warnings).toContain('thinking_disabled');
  });

  it('reasoning_effort 其他值 → enabled 恒 true', () => {
    const ctx = ctxWithRoute(makeCtx());
    const c = codec.decode(
      { model: 'claude-test-1', max_tokens: 64, messages: [{ role: 'user', content: 'x' }] },
      ctx,
    );
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      (c.payload as { params?: Record<string, unknown> }).params!.thinking = {
        enabled: true,
        effort,
      };
      const encoded = codec.encode(c, ctx);
      expect((encoded.body as Record<string, unknown>)['thinking'], effort).toBeDefined();
    }
  });

  it('非 anthropic 来源的 unmapped 不被写回（10 §7.2 第 3 条的边界）', () => {
    const ctx = ctxWithRoute(makeCtx());
    const c = codec.decode(fixtureJson('request.basic.json'), ctx);
    c.raw.unmapped = { openai_only_field: 1 };
    c.raw.source_provider = 'openai';
    const out = codec.encode(c, ctx).body as Record<string, unknown>;
    expect(out['openai_only_field']).toBeUndefined();
  });

  it('认不出的 tool_choice.type → 整个键退回 raw.unmapped，且不修改入参', () => {
    const ctx = ctxWithRoute(makeCtx());
    const wire: Record<string, unknown> = {
      model: 'claude-test-1',
      max_tokens: 8,
      tool_choice: { type: 'brand_new_2027', name: 'x' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const snapshot = JSON.stringify(wire);
    const c = codec.decode(wire, ctx);
    expect((c.payload as { tool_choice?: unknown }).tool_choice).toBeUndefined();
    expect(c.raw.unmapped?.['tool_choice']).toEqual({ type: 'brand_new_2027', name: 'x' });
    // decode 不得就地修改调用方传进来的对象
    expect(JSON.stringify(wire)).toBe(snapshot);

    const out = codec.encode(c, ctx).body as Record<string, unknown>;
    expect(out['tool_choice']).toEqual({ type: 'brand_new_2027', name: 'x' });
  });

  it('tool_choice any → required → {type:any} 往返', () => {
    const ctx = ctxWithRoute(makeCtx());
    const c = codec.decode(fixtureJson('request.tools.json'), ctx);
    expect((c.payload as { tool_choice?: unknown }).tool_choice).toBe('required');
    const out = codec.encode(c, ctx).body as Record<string, unknown>;
    expect(out['tool_choice']).toEqual({ type: 'any' });
  });
});

/** 把数组包成 AsyncIterable（codec 的流式入参就是 AsyncIterable<unknown>）。 */
async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
