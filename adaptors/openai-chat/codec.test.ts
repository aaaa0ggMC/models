/**
 * adaptors/openai-chat/codec.test.ts —— OpenAI Chat adaptor 的 round-trip 契约测试。
 *
 * 模板来源：docs/design/40-provider-adaptors.md §1.5（**每个 adaptor 必过**的 6 条
 * adaptor 层断言）+ D-fastpath-1 惰性解码那条。每条断言都对应一个已知的真实缺陷来源：
 *
 *   A. decode → encode 幂等（语义稳定）
 *   B. 同格式 fast path 字节级透传（除归一化白名单外 diff 为空）
 *   C. 未知字段不丢（raw.unmapped 双向存活）——llm-bridge 类缺陷
 *   D. 畸形 tool 参数不被销毁（raw_arguments 回写）——llm-bridge 真实缺陷
 *   E. 多 system 不丢——llm-bridge 真实缺陷（40 §7.2）
 *   F. 流式事件序列等价（decodeStream → encodeStream）
 *   G. decodeEnvelope 只给路由必需集（D-fastpath-1）
 *
 * 外加三条 usage / finish_reason 硬规则：
 *   - 未命中的 finish_reason → "other" + warning，**绝不默认 stop**（10 §9.3 注意 2）
 *   - usage 缺失 → units.tokens 键省略 + "usage_missing"，**绝不用 0 表示未知**（10 §6.1 规则 2）
 *   - usage.raw 逐字段保留（40 §2.2c I4）
 *
 * 夹具全部手写在 adaptors/fixtures/openai-chat/，只含假模型名/假 id/example.com URL，
 * 无真实凭据、无个人信息、无内网地址、无绝对路径。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { OpenAIChatCodec, FINISH_FRAME_NOTE_KEY, PART_FRAME_NOTE_KEY } from './codec.js';
import { asChatPayload, asChatResponsePayload, CTX_STATE_KEYS } from '../../ir/index.js';
import type { RequestContext, StreamFrame } from '../../ir/index.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'openai-chat');

/** 固定时钟：ts 可断言，且不碰 Date.now()（ir/clock.ts 硬约束）。 */
const FIXED_CLOCK = { now: () => 1763000500 };

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

function readText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function readBytes(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

/** 构造一个最小 RequestContext（不依赖 gateway-core，保持 adaptors 层不被反向依赖）。 */
function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    request_id: 'req_test_contract',
    started_at: FIXED_CLOCK.now(),
    deadline: FIXED_CLOCK.now() + 300_000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'test-key' },
    route: {
      access_path: 'openai',
      provider: 'openai',
      provider_format: 'openai.chat',
      model: 'gpt-test-1',
      full_model_id: 'openai/gpt-test-1',
      attempt_plan: [],
      fast_path_eligible: true,
    },
    provider_format: 'openai.chat',
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

/** 窄化成 Record（测试里大量与 unknown 打交道）。 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// B 的辅助：字节级 diff，只容忍「归一化白名单」
// ---------------------------------------------------------------------------

/**
 * fast path 允许的归一化白名单（20 §4.2「做」表 + 40 §2.3）：
 *   1. `stream_options.include_usage` —— 网关在 S4 自动补上，否则上游不回 usage；
 *   2. `finish_reason` / `tool_call id` / `usage` —— 响应侧三件事，请求侧不涉及。
 * 白名单之外的任何差异都算回归。
 */
const NORMALISABLE_KEYS = new Set(['stream_options']);

/** 返回「白名单之外」的差异描述；空数组 = 字节级等价。 */
function normalizableDiff(a: Buffer, b: Buffer): string[] {
  const diffs: string[] = [];
  if (a.equals(b)) return diffs;
  let parsedA: unknown;
  let parsedB: unknown;
  try {
    parsedA = JSON.parse(a.toString('utf8'));
    parsedB = JSON.parse(b.toString('utf8'));
  } catch {
    return [`bytes 不相同且无法按 JSON 比较: ${a.length}B vs ${b.length}B`];
  }
  if (
    typeof parsedA !== 'object' ||
    parsedA === null ||
    typeof parsedB !== 'object' ||
    parsedB === null
  ) {
    return [`JSON 形状不同: ${JSON.stringify(parsedA)} vs ${JSON.stringify(parsedB)}`];
  }
  const objA = parsedA as Record<string, unknown>;
  const objB = parsedB as Record<string, unknown>;
  for (const key of new Set([...Object.keys(objA), ...Object.keys(objB)])) {
    if (NORMALISABLE_KEYS.has(key)) continue;
    if (JSON.stringify(objA[key]) !== JSON.stringify(objB[key])) {
      diffs.push(`${key}: ${JSON.stringify(objA[key])} != ${JSON.stringify(objB[key])}`);
    }
  }
  return diffs;
}

/** F 的辅助：把一段 SSE 文本归一成「语义事件序列」（忽略 id/created/model 等易变字段）。 */
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
    if (payload === '[DONE]') {
      shape.push('[DONE]');
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      shape.push('<unparsable>');
      continue;
    }
    const choices = chunk['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      shape.push(`usage:${JSON.stringify(chunk['usage'] ?? null)}`);
      continue;
    }
    const choice = choices[0] as Record<string, unknown>;
    const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
    if (delta['role'] !== undefined) shape.push(`role:${String(delta['role'])}`);
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      shape.push(`text:${delta['content']}`);
    }
    if (typeof delta['reasoning_content'] === 'string') {
      shape.push(`thinking:${delta['reasoning_content']}`);
    }
    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const c = call as Record<string, unknown>;
        const fn = (c['function'] ?? {}) as Record<string, unknown>;
        const args = typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : '';
        // id/name 与 arguments 可能同一个 chunk 里一起到（真实 OpenAI 两种形态都有），
        // 因此 begin 与 args 分别判定，回写时 begin 独占一个 chunk 也能对上
        if (c['id'] !== undefined || fn['name'] !== undefined) {
          shape.push(
            `tool_begin[${String(c['index'])}]:${String(c['id'] ?? '')}/${String(fn['name'] ?? '')}`,
          );
        }
        if (args !== '') shape.push(`tool_args[${String(c['index'])}]:${args}`);
      }
    }
    const finish = choice['finish_reason'];
    if (finish !== undefined && finish !== null) shape.push(`finish:${String(finish)}`);
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
  'request.multimodal.json',
  'request.malformed-tool-args.json',
  'request.unknown-top-level.json',
  'request.stream.json',
] as const;

describe.each(REQUEST_FIXTURES)('openai.chat round-trip: %s', (name) => {
  const wire = readJson(name);
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

  it('A. decode → encode 幂等（decode(encode(decode(wire))) === decode(wire)）', () => {
    const first = codec.decode(wire, ctx);
    const encoded = codec.encode(first, ctx);
    expect(encoded.fast_path).toBe(false);
    const second = codec.decode(encoded.body, ctx);
    expect(second).toEqual(first);
  });

  it('B. 同格式 fast path 字节级透传（差异只在归一化白名单内）', () => {
    const canonical = codec.decode(wire, ctx);
    const fastCtx = makeCtx({
      fast_path: true,
      state: { [CTX_STATE_KEYS.RAW_BODY]: readBytes(name) },
    });
    const encoded = codec.encode(canonical, fastCtx);
    expect(encoded.fast_path).toBe(true);
    expect(encoded.raw_bytes).toBeDefined();
    expect(normalizableDiff(encoded.raw_bytes as Buffer, readBytes(name))).toEqual([]);
  });

  it('C. 未知字段不丢（raw.unmapped  survive decode 且被 encode 写回）', () => {
    const withExtra = { ...(wire as Record<string, unknown>), __some_future_field: { a: 1 } };
    const canonical = codec.decode(withExtra, ctx);
    expect(canonical.raw.unmapped?.['__some_future_field']).toEqual({ a: 1 });
    const out = codec.encode(canonical, ctx).body as Record<string, unknown>;
    expect(out['__some_future_field']).toEqual({ a: 1 });
  });

  it('G. decodeEnvelope 只给路由必需集（不物化 messages/tools）', () => {
    const envelopeCtx = makeCtx({ request_bytes: readBytes(name).byteLength });
    const shallow = codec.decodeEnvelope(wire, envelopeCtx);
    expect(shallow.source_format).toBe('openai.chat');
    expect(shallow.kind).toBe('chat');
    expect(typeof shallow.model).toBe('string');
    expect(typeof shallow.stream).toBe('boolean');
    expect(shallow.bytes).toBe(readBytes(name).byteLength);
    expect(shallow.default_path).toBe('/v1/chat/completions');
    // 关键：浅解析产物里不得出现 messages / tools（D-fastpath-1 的全部意义）
    expect(shallow).not.toHaveProperty('messages');
    expect(shallow).not.toHaveProperty('tools');
    expect(Object.keys(shallow)).not.toContain('payload');
  });

  it('G2. 浅解析给出 gateway_agentic_loop（Runner 不物化就能判断要不要进工具循环）', () => {
    const withLoop = {
      model: 'gpt-test-1',
      messages: [{ role: 'user', content: 'hi' }],
      ag_agentic_loop: true,
    };
    const shallow = codec.decodeEnvelope(withLoop, makeCtx());
    expect(shallow.gateway_agentic_loop).toBe(true);
    // 没带开关的请求不该出现这个键（不是 false 占位）
    expect(codec.decodeEnvelope({ model: 'gpt-test-1' }, makeCtx())).not.toHaveProperty(
      'gateway_agentic_loop',
    );
    // 完整解码同样映射进 canonical 的 gateway 命名空间（tool-loop.ts 的 A 档判据）
    const canonical = codec.decode(withLoop, ctx);
    expect(canonical.gateway?.agentic_loop).toBe(true);
    // 且仍保留在 raw.unmapped：回写要能原样写回（10 §7）
    expect(canonical.raw.unmapped?.['ag_agentic_loop']).toBe(true);
  });
});

describe('openai.chat fast path 的 include_usage 最小改写（40 §2.3）', () => {
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

  it('流式但没带 stream_options 时，只补这一个字段（字节 diff 最小）', () => {
    const raw = {
      model: 'gpt-test-1',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const bytes = Buffer.from(JSON.stringify(raw), 'utf8');
    const canonical = codec.decode(raw, makeCtx());
    const encoded = codec.encode(
      canonical,
      makeCtx({ fast_path: true, state: { [CTX_STATE_KEYS.RAW_BODY]: bytes } }),
    );
    expect(encoded.fast_path).toBe(true);
    const out = JSON.parse((encoded.raw_bytes as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(out['stream']).toBe(true);
    expect(out['stream_options']).toEqual({ include_usage: true });
    // 除白名单字段外一字不改（模型、消息、键序都没动）
    expect(out['model']).toBe('gpt-test-1');
    expect(out['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(Object.keys(out)).toEqual(['model', 'stream', 'messages', 'stream_options']);
  });

  it('已经带了 include_usage: true → 原字节透传，零 diff', () => {
    const bytes = readBytes('request.stream.json');
    const canonical = codec.decode(readJson('request.stream.json'), makeCtx());
    const encoded = codec.encode(
      canonical,
      makeCtx({ fast_path: true, state: { [CTX_STATE_KEYS.RAW_BODY]: bytes } }),
    );
    expect((encoded.raw_bytes as Buffer).equals(bytes)).toBe(true);
  });

  it('非流式请求不做任何改写', () => {
    const bytes = readBytes('request.basic.json');
    const canonical = codec.decode(readJson('request.basic.json'), makeCtx());
    const encoded = codec.encode(
      canonical,
      makeCtx({ fast_path: true, state: { [CTX_STATE_KEYS.RAW_BODY]: bytes } }),
    );
    expect((encoded.raw_bytes as Buffer).equals(bytes)).toBe(true);
    expect(JSON.parse((encoded.raw_bytes as Buffer).toString('utf8'))).not.toHaveProperty(
      'stream_options',
    );
  });
});

// ---------------------------------------------------------------------------
// D / E：两条针对已知开源缺陷的专项断言（40 §1.5 原文逐条）
// ---------------------------------------------------------------------------

describe('openai.chat thinking / reasoning_effort', () => {
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

  it('reasoning_effort 档位 → thinking.effort，且 "none" 表示关推理', () => {
    const decodeThinking = (effort: string) => {
      const canonical = codec.decode(
        {
          model: 'gpt-test-1',
          reasoning_effort: effort,
          messages: [{ role: 'user', content: 'hi' }],
        },
        ctx,
      );
      return asChatPayload(canonical)?.params?.thinking;
    };
    // "none" 的 OpenAI 语义是关推理 → ThinkingConfig.enabled = false（10 §4.4 的开关）
    expect(decodeThinking('none')).toEqual({ enabled: false, effort: 'none' });
    expect(decodeThinking('high')).toEqual({ enabled: true, effort: 'high' });
    expect(decodeThinking('minimal')).toEqual({ enabled: true, effort: 'minimal' });

    // 回写：effort 原样回 reasoning_effort（"none" 也要能回去）
    const out = codec.encode(
      codec.decode(
        {
          model: 'gpt-test-1',
          reasoning_effort: 'none',
          messages: [{ role: 'user', content: 'hi' }],
        },
        ctx,
      ),
      ctx,
    ).body as { reasoning_effort?: string };
    expect(out.reasoning_effort).toBe('none');
  });

  it('thinking.budget_tokens 在 OpenAI Chat 无对应 → 丢弃 + warning 诊断', () => {
    const canonical = codec.decode(
      { model: 'gpt-test-1', messages: [{ role: 'user', content: 'hi' }] },
      ctx,
    );
    const withBudget = {
      ...canonical,
      payload: {
        ...asChatPayload(canonical)!,
        params: {
          ...asChatPayload(canonical)!.params,
          thinking: { enabled: true, budget_tokens: 4096 },
        },
      },
    };
    const encoded = codec.encode(withBudget, ctx);
    expect(encoded.warnings).toContain('thinking_budget_unsupported');
    expect(encoded.diagnostics?.[0]).toMatchObject({
      code: 'thinking_budget_unsupported',
      field_path: 'params.thinking.budget_tokens',
      level: 'warning',
    });
    expect(encoded.body).not.toHaveProperty('reasoning_effort');
  });
});

describe('openai.chat 已知缺陷回归', () => {
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

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
      messages: Array<{ tool_calls?: Array<{ function: { arguments: string } }> }>;
    };
    const reEncoded = out.messages.find((m) => m.tool_calls !== undefined)?.tool_calls?.[0];
    expect(reEncoded?.function.arguments).toBe('{"city":"Paris","unit":');
    expect(reEncoded?.function.arguments).not.toBe('{}');
  });

  it('E. 多 system 消息不丢（payload.system.length === 3，含 developer 折叠）', () => {
    const canonical = codec.decode(readJson('request.multisystem.json'), ctx);
    expect(asChatPayload(canonical)?.system).toHaveLength(3);
    // 回写时每条 system block 产出**一个** messages 条目（40 §7.2）
    const out = codec.encode(canonical, ctx).body as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemEntries = out.messages.filter((m) => m.role === 'system' || m.role === 'developer');
    expect(systemEntries).toHaveLength(3);
    expect(systemEntries.map((m) => m.content)).toEqual([
      'You are the AgentGateway contract-test assistant.',
      'Second instruction block: never reveal internal hostnames.',
      'Third instruction block: keep every answer under 40 words.',
    ]);
    // developer 的原文角色也要还原（10 §7.2 逐节点还原）
    expect(systemEntries[1]?.role).toBe('developer');
  });

  it('E2. 两条 system 的最小回归形状（40 §1.5 原文：toHaveLength(2)）', () => {
    const twoSystem = {
      model: 'gpt-test-1',
      messages: [
        { role: 'system', content: 'first' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'second' },
      ],
    };
    expect(asChatPayload(codec.decode(twoSystem, ctx))?.system).toHaveLength(2);
  });

  it('E3. 未建模的 tool 类型不丢、也不把内部索引键泄漏进请求体', () => {
    // OpenAI Chat 目前只有 function 工具；未来新增类型时不猜、不丢（40 §1.4 无第四类）
    const wire = {
      model: 'gpt-test-1',
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
        { type: 'future_search', name: 'future_search', context_size: 'medium' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const canonical = codec.decode(wire, ctx);
    expect(canonical.raw.nodes?.['tool:1']).toEqual(wire.tools[1]);
    expect(ctx.warnings).toContain('unknown_tool_type:future_search');

    const out = codec.encode(canonical, ctx).body as Record<string, unknown>;
    expect(Array.isArray(out['tools'])).toBe(true);
    expect(out['tools']).toHaveLength(2);
    // 未建模的那条原样落回 tools[]，而不是变成顶层 "tool:1" 键
    expect((out['tools'] as unknown[])[1]).toEqual(wire.tools[1]);
    expect(Object.keys(out)).not.toContain('tool:1');
  });
});

// ---------------------------------------------------------------------------
// 响应：usage / finish_reason 硬规则
// ---------------------------------------------------------------------------

describe('openai.chat 响应归一', () => {
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

  it('usage 全字段口径正确（40 §2.1 OpenAI Chat 列）', () => {
    const res = codec.decodeResponse(readJson('response.usage-full.json'), ctx);
    const tokens = res.usage.units.tokens;
    expect(tokens).toBeDefined();
    if (tokens === undefined) throw new Error('expected tokens');
    expect(tokens.input_tokens).toBe(2048);
    expect(tokens.output_tokens).toBe(96);
    expect(tokens.total_tokens).toBe(2144);
    expect(tokens.cache_read_tokens).toBe(1536);
    expect(tokens.cache_write_tokens).toBe(128);
    expect(tokens.reasoning_tokens).toBe(64);
  });

  it('I4: usage.raw 逐字段保留（含 *_details 嵌套）', () => {
    const wire = readJson('response.usage-full.json') as { usage: Record<string, unknown> };
    const res = codec.decodeResponse(wire, ctx);
    expect(res.usage.raw).toEqual(wire.usage);
    // 逐字段断言：raw 与 units 相互独立，聚合 units 不会动 raw
    expect((res.usage.raw as Record<string, unknown>)['prompt_tokens_details']).toEqual(
      wire.usage['prompt_tokens_details'],
    );
    expect((res.usage.raw as Record<string, unknown>)['completion_tokens_details']).toEqual(
      wire.usage['completion_tokens_details'],
    );
  });

  it('usage 缺失 → tokens 键省略 + usage_missing warning（绝不用 0 表示未知）', () => {
    const res = codec.decodeResponse(readJson('response.no-usage.json'), ctx);
    expect(res.usage.units.tokens).toBeUndefined();
    expect('tokens' in res.usage.units).toBe(false);
    expect(res.warnings).toContain('usage_missing');
    // extractUsage 与 decodeResponse 口径一致（快慢同路径）
    expect(codec.extractUsage(readJson('response.no-usage.json')).units.tokens).toBeUndefined();
  });

  it('finish_reason 归一：tool_calls → tool_use，原文进 raw 供回写', () => {
    const res = codec.decodeResponse(readJson('response.tools.json'), ctx);
    expect(res.finish_reason).toBe('tool_use');
    // 10 §9.3 注意 3：原文进 RawEnvelope 的顶层一等字段（ir/envelope.ts）
    expect(res.raw.finish_reason_provider).toBe('tool_calls');
    const out = codec.encodeResponse(res, ctx) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    // 可逆：回写用原文而不是猜（10 §9.3 注意 3）
    expect(out.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('未命中的 finish_reason → other + warning，绝不静默 stop（10 §9.3 注意 2）', () => {
    const wire = {
      id: 'chatcmpl-test-weird',
      object: 'chat.completion',
      created: 1763000600,
      model: 'gpt-test-1',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'truncated by a future reason' },
          finish_reason: 'some_future_reason',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };
    const res = codec.decodeResponse(wire, ctx);
    expect(res.finish_reason).toBe('other');
    expect(res.warnings).toContain('unmapped_finish_reason:some_future_reason');
    // normalizeFinishReason 单独调用也走同一张表
    expect(codec.normalizeFinishReason('some_future_reason')).toBe('other');
    expect(codec.normalizeFinishReason(wire)).toBe('other');
    expect(codec.normalizeFinishReason('stop')).toBe('stop');
    expect(codec.normalizeFinishReason('length')).toBe('length');
    expect(codec.normalizeFinishReason('tool_calls')).toBe('tool_use');
    expect(codec.normalizeFinishReason('content_filter')).toBe('content_filter');
    expect(codec.normalizeFinishReason('function_call')).toBe('other');
  });

  it('错误信封 → OpenAI 错误体 {error:{message,type,code}}（20 §7.2，由客户端 codec 生成）', () => {
    // runner 的 errorEnvelope 形状：finish_reason "error" + message 落在 refusal part，
    // 完整 canonical error 挂在 raw.nodes.error（runner 现在会填）
    const errorEnvelope = (canonicalError: Record<string, unknown>) => ({
      ir_version: 'ag-ir/1' as const,
      kind: 'chat' as const,
      request_id: 'req_test_contract',
      usage: { units: {}, source: 'provider' as const },
      finish_reason: 'error' as const,
      payload: {
        message: {
          role: 'assistant' as const,
          parts: [{ type: 'refusal' as const, reason: '上游 openai 调用失败' }],
        },
      },
      warnings: [],
      raw: { nodes: { error: canonicalError } },
    });

    const out = codec.encodeResponse(errorEnvelope({ code: 'provider_unavailable' }), ctx) as {
      error: { message: string; type: string; code: string | null; param: null };
    };
    expect(out.error.message).toBe('上游 openai 调用失败');
    expect(out.error.type).toBe('server_error');
    expect(out.error.code).toBe('provider_unavailable');
    expect(out.error.param).toBeNull();
    // 不得伪装成一次正常的 chat.completion
    expect(out).not.toHaveProperty('choices');
  });

  it('错误 type 按 20 §7.2 的映射表区分可重试/参数类', () => {
    const envelopeFor = (code: string) => ({
      ir_version: 'ag-ir/1' as const,
      kind: 'chat' as const,
      request_id: 'req_test_contract',
      usage: { units: {}, source: 'provider' as const },
      finish_reason: 'error' as const,
      payload: {
        message: {
          role: 'assistant' as const,
          parts: [{ type: 'refusal' as const, reason: `${code} happened` }],
        },
      },
      warnings: [],
      raw: { nodes: { error: { code } } },
    });
    const typeOf = (code: string): string =>
      (codec.encodeResponse(envelopeFor(code), ctx) as { error: { type: string } }).error.type;

    // 429 → rate_limit_error；500/503 → server_error；参数类 400 → invalid_request_error
    expect(typeOf('rate_limited')).toBe('rate_limit_error');
    expect(typeOf('quota_exceeded')).toBe('insufficient_quota');
    expect(typeOf('provider_unavailable')).toBe('server_error');
    expect(typeOf('upstream_timeout')).toBe('server_error');
    expect(typeOf('internal_error')).toBe('server_error');
    expect(typeOf('capability_unsupported')).toBe('invalid_request_error');
    expect(typeOf('context_length_exceeded')).toBe('invalid_request_error');
    expect(typeOf('auth_failed')).toBe('invalid_request_error');
    expect(typeOf('unsupported_format')).toBe('invalid_request_error');
    // 未登记的码不猜：落保守的 server_error（客户端会重试，而不是当成参数错误放弃）
    expect(typeOf('some_future_code')).toBe('server_error');
  });

  it('错误信封没带 canonical error 时退保守值，不猜码', () => {
    const bare = {
      ir_version: 'ag-ir/1' as const,
      kind: 'chat' as const,
      request_id: 'req_test_contract',
      usage: { units: {}, source: 'provider' as const },
      finish_reason: 'error' as const,
      payload: {
        message: {
          role: 'assistant' as const,
          parts: [{ type: 'refusal' as const, reason: '上游 openai 调用失败' }],
        },
      },
      warnings: [],
      raw: {},
    };
    const out = codec.encodeResponse(bare, ctx) as {
      error: { message: string; type: string; code: string | null };
    };
    expect(out.error.type).toBe('server_error');
    expect(out.error.code).toBeNull();
  });

  it('跨格式时不得照抄别家的 finish_reason 原文（10 §7.2 第 1 条的同格式前提）', () => {
    // 模拟「上游是 Anthropic、客户端要 OpenAI」：原文是 Anthropic 的 end_turn
    const crossFormat = {
      ir_version: 'ag-ir/1' as const,
      kind: 'chat' as const,
      request_id: 'chatcmpl-cross',
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
        source: 'provider' as const,
      },
      finish_reason: 'stop' as const,
      payload: {
        message: { role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'hi' }] },
        model: 'gpt-test-1',
      },
      warnings: [],
      raw: { source_provider: 'anthropic', finish_reason_provider: 'end_turn' },
    };
    const out = codec.encodeResponse(crossFormat, ctx) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    // 必须走 §9.3 反查表落到 OpenAI 的 stop，而不是把 end_turn 抄过来
    expect(out.choices[0]?.finish_reason).toBe('stop');

    // 同格式时仍然原样回写（可逆性，10 §9.3 注意 3）
    const sameFormat = {
      ...crossFormat,
      raw: { source_provider: 'openai', finish_reason_provider: 'length' },
      finish_reason: 'length' as const,
    };
    const out2 = codec.encodeResponse(sameFormat, ctx) as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(out2.choices[0]?.finish_reason).toBe('length');
  });

  it('响应回写：text / tool_calls / usage 形状还原', () => {
    const res = codec.decodeResponse(readJson('response.tools.json'), ctx);
    const out = codec.encodeResponse(res, ctx) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{
        message: { role: string; content: string | null; tool_calls?: unknown[] };
        finish_reason: string | null;
      }>;
      usage: Record<string, unknown>;
    };
    expect(out.object).toBe('chat.completion');
    expect(out.id).toBe('chatcmpl-test456');
    expect(out.model).toBe('gpt-test-1');
    expect(out.choices[0]?.message.role).toBe('assistant');
    // 有 tool_calls 时 content 置 null（OpenAI 形态）
    expect(out.choices[0]?.message.content).toBeNull();
    expect(out.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(out.usage['prompt_tokens']).toBe(61);
  });
});

// ---------------------------------------------------------------------------
// F：流式事件序列等价
// ---------------------------------------------------------------------------

describe('openai.chat 流式', () => {
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });
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
  });

  it('F2. tool_call 分片被完整累加（part.end 带完整 tool_use part）', async () => {
    const frames = await collect(codec.decodeStream(parseSse(sseText), ctx));
    const metaFrames = frames.filter((f) => f.event === 'meta');
    // part.begin + part.end + finish 三个 meta 帧
    expect(metaFrames).toHaveLength(3);
    const notes = metaFrames.map((f) => (f.data as { notes: Record<string, unknown> }).notes);
    const begin = asRecord(
      notes.map((n) => n[PART_FRAME_NOTE_KEY]).find((n) => asRecord(n)?.['phase'] === 'begin'),
    );
    const end = asRecord(
      notes.map((n) => n[PART_FRAME_NOTE_KEY]).find((n) => asRecord(n)?.['phase'] === 'end'),
    );
    expect(begin).toBeDefined();
    expect(end).toBeDefined();
    const part = asRecord(end?.['part']);
    expect(part?.['type']).toBe('tool_use');
    expect(part?.['id']).toBe('call_test_stream_1');
    expect(part?.['name']).toBe('get_weather');
    expect(part?.['input']).toEqual({ city: 'Paris' });
    expect(part?.['raw_arguments']).toBe('{"city":"Paris"}');

    // finish_reason 在自己 wire 位置上的 meta 帧 + 流尾的 end 帧汇总
    const finishNote = asRecord(
      notes.map((n) => n[FINISH_FRAME_NOTE_KEY]).find((n) => n !== undefined),
    );
    expect(finishNote?.['finish_reason']).toBe('tool_use');
    expect(finishNote?.['finish_reason_provider']).toBe('tool_calls');

    const endFrame = frames.find((f) => f.event === 'end');
    const data = endFrame?.data as {
      finish_reason: string;
      usage?: { units: { tokens?: unknown } };
      output?: Record<string, unknown>;
    };
    expect(data.finish_reason).toBe('tool_use');
    expect(data.usage?.units.tokens).toBeDefined();
    expect(data.output?.['finish_reason_provider']).toBe('tool_calls');
  });

  it('F3. 流式 usage 走 usage 帧，finish_reason 走 end 帧', async () => {
    const frames = await collect(codec.decodeStream(parseSse(sseText), ctx));
    const usageFrames = frames.filter((f) => f.event === 'usage');
    expect(usageFrames).toHaveLength(1);
    const tokens = (
      usageFrames[0]?.data as { usage: { units: { tokens?: { input_tokens: number } } } }
    ).usage.units.tokens;
    expect(tokens?.input_tokens).toBe(48);
    expect(
      (usageFrames[0]?.data as { usage: { raw?: Record<string, unknown> } }).usage.raw,
    ).toEqual({
      prompt_tokens: 48,
      completion_tokens: 31,
      total_tokens: 79,
      prompt_tokens_details: { cached_tokens: 16 },
      completion_tokens_details: { reasoning_tokens: 12 },
    });
  });

  it('F4. id/name 与首个参数分片同一个 chunk 到达时也不丢顺序（真实 OpenAI 的另一形态）', async () => {
    const chunk = (
      delta: Record<string, unknown>,
      finish: string | null = null,
      usage?: unknown,
    ): string =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-combined',
        object: 'chat.completion.chunk',
        created: 1763000400,
        model: 'gpt-test-1',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage === undefined ? {} : { usage }),
      })}\n\n`;
    const combined = [
      chunk({ role: 'assistant' }),
      // id + name + 第一片参数挤在同一个 chunk 里
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_combined_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ].join('');
    const frames = await collect(codec.decodeStream(parseSse(combined), ctx));
    const endNote = frames
      .filter((f) => f.event === 'meta')
      .map((f) => (f.data as { notes: Record<string, unknown> }).notes)
      .map((n) => asRecord(n[PART_FRAME_NOTE_KEY]))
      .find((n) => n?.['phase'] === 'end');
    expect(asRecord(endNote?.['part'])?.['input']).toEqual({ city: 'Paris' });

    const reEncoded = joinSse(await collect(codec.encodeStream(toAsync(frames), ctx)));
    expect(eventShape(reEncoded)).toEqual(eventShape(combined));
  });
});

/** 把数组包成 AsyncIterable（测试里复用）。 */
async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('openai.chat 流式：S8 形状的帧流（part 边界走类型化 PartBeginData/PartEndData）', () => {
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

  it('part.begin/part.delta/part.end → tool_call chunk 三段齐全，[DONE] 收尾', async () => {
    // 复刻 s8-client-encode.ts 的 eventToFrameData：part 边界折成 {kind:'chat', index, part}
    const frames: StreamFrame[] = [
      {
        event: 'start',
        seq: 0,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { model: 'gpt-test-1', client_format: 'openai.chat', provider_format: 'openai.chat' },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 1,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 0, text: '让我查一下' },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 2,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 0,
          part: { type: 'tool_use', id: 'call_s8_1', name: 'get_weather', input: {} },
        },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 3,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 0, tool_input_json: '{"city":' },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 4,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 0, tool_input_json: '"Paris"}' },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 5,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 0,
          part: {
            type: 'tool_use',
            id: 'call_s8_1',
            name: 'get_weather',
            input: { city: 'Paris' },
            raw_arguments: '{"city":"Paris"}',
          },
        },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'end',
        seq: 6,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          finish_reason: 'tool_use',
          usage: {
            units: {
              tokens: {
                input_tokens: 9,
                output_tokens: 4,
                total_tokens: 13,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
              },
            },
            source: 'provider',
          },
        },
        ts: FIXED_CLOCK.now(),
      },
    ];
    const lines = await collect(codec.encodeStream(toAsync(frames), ctx));
    const text = joinSse(lines);
    expect(eventShape(text)).toEqual([
      'role:assistant',
      'text:让我查一下',
      'tool_begin[0]:call_s8_1/get_weather',
      'tool_args[0]:{"city":',
      'tool_args[0]:"Paris"}',
      'finish:tool_calls',
      '[DONE]',
    ]);
    // part.end 不重复发完整参数（分片已经发过）
    expect(
      text.split('\n\n').filter((b) => b.includes('"arguments":"{\\"city\\":\\"Paris\\"}"')),
    ).toHaveLength(0);
  });

  it('整块到达的 tool_use（没有分片）也能一次发出', async () => {
    const frames: StreamFrame[] = [
      {
        event: 'start',
        seq: 0,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          model: 'gpt-test-1',
          client_format: 'openai.chat',
          provider_format: 'openai.chat',
        },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 1,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 0,
          part: {
            type: 'tool_use',
            id: 'call_whole',
            name: 'get_time',
            input: { tz: 'UTC' },
            raw_arguments: '{"tz":"UTC"}',
          },
        },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'end',
        seq: 2,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { finish_reason: 'tool_use' },
        ts: FIXED_CLOCK.now(),
      },
    ];
    const text = joinSse(await collect(codec.encodeStream(toAsync(frames), ctx)));
    expect(eventShape(text)).toEqual([
      'role:assistant',
      'tool_begin[0]:call_whole/get_time',
      'tool_args[0]:{"tz":"UTC"}',
      'finish:tool_calls',
      '[DONE]',
    ]);
  });

  it('并行 tool_call：分片按帧上的 index 归位，不并到一起', async () => {
    const frames: StreamFrame[] = [
      {
        event: 'delta',
        seq: 0,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 0,
          part: { type: 'tool_use', id: 'call_a', name: 'get_weather', input: {} },
        },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 1,
        request_id: ctx.request_id,
        kind: 'chat',
        data: {
          kind: 'chat',
          index: 1,
          part: { type: 'tool_use', id: 'call_b', name: 'get_time', input: {} },
        },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 2,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 1, tool_input_json: '{"tz":"UTC"}' },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'delta',
        seq: 3,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { kind: 'chat', index: 0, tool_input_json: '{"city":"Paris"}' },
        ts: FIXED_CLOCK.now(),
      },
      {
        event: 'end',
        seq: 4,
        request_id: ctx.request_id,
        kind: 'chat',
        data: { finish_reason: 'tool_use' },
        ts: FIXED_CLOCK.now(),
      },
    ];
    const text = joinSse(await collect(codec.encodeStream(toAsync(frames), ctx)));
    expect(eventShape(text)).toEqual([
      'tool_begin[0]:call_a/get_weather',
      'tool_begin[1]:call_b/get_time',
      'tool_args[1]:{"tz":"UTC"}',
      'tool_args[0]:{"city":"Paris"}',
      'finish:tool_calls',
      '[DONE]',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

describe('openai.chat 边界输入（不猜、不抛、不静默）', () => {
  const ctx = makeCtx();
  const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });

  it('extractUsage 同时接受「整个响应体」与「裸 usage 对象」', () => {
    const bare = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
    expect(codec.extractUsage(bare).units.tokens).toMatchObject({
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
    // 整个响应体：走 usage 字段
    expect(codec.extractUsage({ usage: bare }).units.tokens?.input_tokens).toBe(7);
    // 两者都不是：空 units，不用 0 冒充（10 §6.1 规则 2）
    expect(codec.extractUsage({ choices: [] }).units.tokens).toBeUndefined();
    expect(codec.extractUsage(null).units.tokens).toBeUndefined();
  });

  it('没有 messages / 没有 choices 时不炸', () => {
    const req = codec.decode({ model: 'gpt-test-1' }, ctx);
    expect(asChatPayload(req)?.messages).toEqual([]);
    const encoded = codec.encode(req, ctx).body as { messages: unknown[] };
    expect(encoded.messages).toEqual([]);

    const res = codec.decodeResponse({ id: 'x', object: 'chat.completion', model: 'm' }, ctx);
    expect(asChatResponsePayload(res)?.message.parts).toEqual([]);
    expect(res.finish_reason).toBe('other'); // 没有 finish_reason → 不默认 stop
    expect(res.warnings).toContain('usage_missing');
  });

  it('非 object 的请求/响应体直接抛（由管道的 canonical_decode_error 收口）', () => {
    expect(() => codec.decode('not an object', ctx)).toThrow();
    expect(() => codec.decodeResponse(42, ctx)).toThrow();
    expect(() => codec.decodeEnvelope(null, ctx)).toThrow();
  });

  it('未知 part 类型降级成 UnknownPart，不抛（20 §S1 前向兼容）', () => {
    const wire = {
      model: 'gpt-test-1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } },
          ],
        },
      ],
    };
    const canonical = codec.decode(wire, ctx);
    const parts = asChatPayload(canonical)?.messages[0]?.parts ?? [];
    expect(parts).toHaveLength(2);
    const unknown = parts[1];
    expect(unknown?.type).toBe('unknown');
    if (unknown?.type !== 'unknown') throw new Error('expected unknown part');
    expect(unknown.raw_type).toBe('video_url');
    expect(ctx.warnings).toContain('unknown_part_type:video_url');

    // 回写：丢弃 + warning 诊断，不静默（20 §S4）
    const encoded = codec.encode(canonical, ctx);
    expect(encoded.diagnostics?.some((d) => d.code === 'unknown_part_dropped')).toBe(true);
    expect(encoded.warnings).toContain('unknown_part_dropped');
  });
});

describe('openai.chat AdaptorMeta', () => {
  it('format / modalities / lazy decode 声明与实现一致', async () => {
    const { openAIChatAdaptorMeta } = await import('./index.js');
    const meta = openAIChatAdaptorMeta();
    expect(meta.format).toBe('openai.chat');
    expect(meta.modality).toBe('chat');
    expect(meta.status).toBe('implemented');
    expect(meta.supports_lazy_decode).toBe(true);
    expect(meta.fixtures).toBe('adaptors/fixtures/openai-chat');

    const codec = new OpenAIChatCodec({ clock: FIXED_CLOCK });
    expect(codec.format).toBe('openai.chat');
    expect(codec.modalities).toEqual(['chat']);
    expect(codec.decodeEnvelope).toBeTypeOf('function');
  });
});
