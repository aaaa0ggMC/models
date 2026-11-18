/**
 * tests/deepseek-constraints.test.ts —— 上游声明的行为约束（api_capabilities）的执行测试。
 *
 * 背景：DeepSeek `GET /models` 按 (model, dialect) 主动声明行为约束
 * （`api_capabilities.anthropic_messages`），这是 2026-11-13 全家桶发布后新增的机制：
 *   - `system_prompt_update`：leading-only（只有开头的 system 生效）vs in-history
 *     （历史中最后一条 system 提供完整生效的系统提示）；
 *   - `tool_update`：addition-only（只能新增工具）vs leading-only（只有首次请求的
 *     工具声明生效）。
 * adaptor 必须执行这些约束：客户端行为超出约束时，要么做合规转换（合并/前移），
 * 要么明确报错，**不允许静默发出一个上游会误解的请求**。
 *
 * 两层覆盖：
 *   A. codec 层（确定性）：手工 canonical 信封 + 注入能力矩阵，断言 wire 输出；
 *   B. 管道层（e2e）：注册 full-canonical 请求侧插件强制走慢路径（否则同 dialect
 *      会走 fast path 字节透传、不经 codec），断言约束经「矩阵 → codec」这条链生效。
 */

import { describe, expect, it } from 'vitest';
import type { CanonicalRequestEnvelope, Plugin } from '../ir/index.js';
import { AnthropicMessagesCodec } from '../adaptors/anthropic-messages/index.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile, deepseekCapabilities } from '../providers/deepseek/index.js';
import { InMemoryCapabilityRegistry } from '../credentials/capability-registry.js';
import { createGateway, defaultRouteTable } from '../composition-root.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';

const FAKE_KEY = 'sk-test-not-a-real-key';

function codecWithConstraints() {
  const caps = new InMemoryCapabilityRegistry();
  for (const entry of deepseekCapabilities()) caps.register(entry);
  const profiles = new InMemoryProviderProfileRegistry();
  profiles.register(createDeepSeekProfile());
  return new AnthropicMessagesCodec({
    clock: { now: () => 0 },
    providerProfiles: profiles,
    capabilityRegistry: caps,
  });
}

function ctxFor(accessPath: string) {
  return {
    request_id: 'req_test',
    started_at: 0,
    deadline: 1000,
    client_format: 'anthropic.messages' as const,
    client_raw_headers: {},
    auth: { key_id: 'k' },
    route: {
      access_path: accessPath,
      provider: 'deepseek',
      provider_format: 'anthropic.messages' as const,
      model: 'deepseek-flash',
      full_model_id: `${accessPath}/deepseek-flash`,
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'anthropic.messages' as const,
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    warn: () => {},
  };
}

/** 历史中段插入了一条 system 消息的 canonical 请求（openai 风格的客户端会这样发）。 */
function requestWithMidHistorySystem(model = 'deepseek-flash'): CanonicalRequestEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    model,
    payload: {
      system: [{ text: '你是助手。' }],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '第一轮问题' }] },
        { role: 'assistant', parts: [{ type: 'text', text: '第一轮回答' }] },
        // 中途更新系统提示：v4-pro（leading-only）不认，flash（in-history）认
        { role: 'system', parts: [{ type: 'text', text: '补充规则：只回答中文。' }] },
        { role: 'user', parts: [{ type: 'text', text: '第二轮问题' }] },
      ],
    },
    source_format: 'anthropic.messages',
    raw: { source_provider: 'anthropic' },
  } as unknown as CanonicalRequestEnvelope;
}

/** 历史里调用过 get_weather，但本次请求不再声明它的 canonical 请求。 */
function requestWithRemovedTool(model = 'deepseek-flash'): CanonicalRequestEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    model,
    payload: {
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '北京天气？' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } }],
        },
        {
          role: 'user',
          parts: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '晴',
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'get_time',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    source_format: 'anthropic.messages',
    raw: { source_provider: 'anthropic' },
  } as unknown as CanonicalRequestEnvelope;
}

describe('A · codec 层：system_prompt_update 约束', () => {
  it('leading-only（v4-pro）：历史中的 system 消息合并进开头 system 字段', () => {
    const codec = codecWithConstraints();
    const req = requestWithMidHistorySystem('deepseek-v4-pro');
    const encoded = codec.encode(req, ctxFor('deepseek.anthropic-messages'));
    const body = encoded.body as Record<string, unknown>;
    // 合规转换：两条 system 合成开头的 system（顺序保留）
    expect(body['system']).toEqual([
      { type: 'text', text: '你是助手。' },
      { type: 'text', text: '补充规则：只回答中文。' },
    ]);
    // messages 里不再有 system-role 消息（否则同一份内容出现两次）
    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m['role'] === 'system')).toBe(false);
    expect(messages).toHaveLength(3);
    // 诊断不静默
    expect(encoded.warnings).toContain('system_prompt_merged_leading_only');
  });

  it('in-history（flash）：历史中的 system 消息原样透传', () => {
    const codec = codecWithConstraints();
    const req = requestWithMidHistorySystem('deepseek-flash');
    const encoded = codec.encode(req, ctxFor('deepseek.anthropic-messages'));
    const body = encoded.body as Record<string, unknown>;
    // 开头的 system 保持顶层字段
    expect(body['system']).toEqual([{ type: 'text', text: '你是助手。' }]);
    // 历史里的 system 消息以 system role 出现在 messages 中（DeepSeek flash 认这个形态）
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const systemMsg = messages.find((m) => m['role'] === 'system');
    expect(systemMsg).toBeDefined();
    const content = systemMsg!['content'] as Array<Record<string, unknown>>;
    expect(content[0]!['text']).toBe('补充规则：只回答中文。');
  });

  it('无约束声明的 access path（anthropic 本家）：折叠进 user + 告警（历史行为不变）', () => {
    const codec = codecWithConstraints();
    const req = requestWithMidHistorySystem();
    const encoded = codec.encode(req, ctxFor('anthropic'));
    const body = encoded.body as Record<string, unknown>;
    const messages = body['messages'] as Array<Record<string, unknown>>;
    // 没有 system-role 透传，也没有合并诊断
    expect(messages.some((m) => m['role'] === 'system')).toBe(false);
    expect(encoded.warnings).not.toContain('system_prompt_merged_leading_only');
  });
});

describe('B · codec 层：tool_update 约束', () => {
  it('addition-only（flash）：移除历史调用过的工具 → 明确报错', () => {
    const codec = codecWithConstraints();
    const req = requestWithRemovedTool('deepseek-flash');
    expect(() => codec.encode(req, ctxFor('deepseek.anthropic-messages'))).toThrowError(
      /tool_update=addition-only/,
    );
  });

  it('leading-only（v4-pro）：移除历史调用过的工具 → warning 不抛错', () => {
    const codec = codecWithConstraints();
    const req = requestWithRemovedTool('deepseek-v4-pro');
    const encoded = codec.encode(req, ctxFor('deepseek.anthropic-messages'));
    expect(encoded.warnings).toContain('tool_update_leading_only');
    // 请求仍然发出（上游会忽略工具变更），但诊断里写明了后果
    const body = encoded.body as Record<string, unknown>;
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools.map((t) => t['name'])).toEqual(['get_time']);
  });

  it('工具未被移除时不触发任何检查', () => {
    const codec = codecWithConstraints();
    const req = requestWithRemovedTool('deepseek-v4-pro');
    // 把 get_weather 加回声明
    const payload = req.payload as { tools?: Array<Record<string, unknown>> };
    payload.tools = [
      ...(payload.tools ?? []),
      { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } },
    ];
    const encoded = codec.encode(req, ctxFor('deepseek.anthropic-messages'));
    expect(encoded.warnings).not.toContain('tool_update_leading_only');
  });
});

describe('C · 管道层：约束经能力矩阵送达 codec（强制慢路径）', () => {
  /** full-canonical 请求侧插件：禁用 fast path，让请求真的过 codec。 */
  const forceSlowPath: Plugin = {
    manifest: {
      name: 'force-slow-path',
      version: '1.0.0',
      hooks: ['onRequest'],
      order: 10,
      scope: 'full-canonical',
    },
    onRequest: (req) => req,
  };

  async function run(model: string, body: unknown) {
    const transport = new ScriptedTransport([
      {
        body: JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0 },
        }),
      },
    ]);
    const gateway = createGateway({
      mode: 'test',
      transport,
      routeTable: defaultRouteTable(),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_KEY,
      }),
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
      plugins: [{ plugin: forceSlowPath, config: {} }],
    });
    const sink = new MemoryClientSink();
    const out = await gateway.runner.run(
      {
        client_format: 'anthropic.messages',
        raw_body: Buffer.from(JSON.stringify(body)),
        headers: { 'content-type': 'application/json' },
        path: '/v1/messages',
        query: {},
      },
      sink,
    );
    return { gateway, sink, transport, out };
  }

  it('v4-pro + 中途 system → 上游收到合并后的开头 system', async () => {
    const { transport, out } = await run('deepseek-v4-pro-messages', {
      model: 'deepseek-v4-pro-messages',
      max_tokens: 128,
      system: '你是助手。',
      messages: [
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'system', content: '补充规则：只回答中文。' },
        { role: 'user', content: '第二轮问题' },
      ],
    });
    expect(out.error).toBeUndefined();
    const upstream = JSON.parse(transport.requests[0]!.body!.toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(upstream['system'])).toBe(true);
    const system = upstream['system'] as Array<Record<string, unknown>>;
    expect(system.map((b) => b['text'])).toEqual(['你是助手。', '补充规则：只回答中文。']);
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m['role'] === 'system')).toBe(false);
    // 端点路径也走 profile（/anthropic/v1/messages）
    expect(transport.requests[0]!.path).toBe('/anthropic/v1/messages');
  });

  it('flash + 中途 system → 上游收到 system-role 历史消息', async () => {
    const { transport, out } = await run('deepseek-flash-messages', {
      model: 'deepseek-flash-messages',
      max_tokens: 128,
      system: '你是助手。',
      messages: [
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'system', content: '补充规则：只回答中文。' },
        { role: 'user', content: '第二轮问题' },
      ],
    });
    expect(out.error).toBeUndefined();
    const upstream = JSON.parse(transport.requests[0]!.body!.toString('utf8')) as Record<
      string,
      unknown
    >;
    const messages = upstream['messages'] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m['role'] === 'system')).toBe(true);
  });

  it('flash + 移除历史工具 → 请求被拒绝（canonical 错误，不出网）', async () => {
    const { transport, out } = await run('deepseek-flash-messages', {
      model: 'deepseek-flash-messages',
      max_tokens: 128,
      tools: [{ name: 'get_time', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: '北京天气？' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '晴' }],
        },
      ],
    });
    expect(out.error?.code).toBe('capability_unsupported');
    // 明确报错 = 不发上游
    expect(transport.requests).toHaveLength(0);
  });
});
