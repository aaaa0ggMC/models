/**
 * tests/decisions-endpoint.test.ts —— decision 模态端到端契约测试。
 *
 * 覆盖（85 号矩阵 decision 卡片）：
 *   1. **入站脸**：`POST /v1/decisions`（请求/响应体即 canonical 信封，15 §6.3）；
 *   2. **mock adaptor**：确定性答案 + `units.questions` + `calibration: "native"`；
 *   3. **降级路径**：没有 native 上游时用 chat + json_schema 模拟，响应标
 *      `calibration: "degraded"` + `degraded_by`（40 §6.3），输出计费；
 *   4. **高风险不降级**：策略检查/stop 判断拿不到真 decision 就明确失败；
 *   5. 校验错误（kind/ir_version/questions 形状/流式）。
 *
 * chat 模拟的上游走同一个 ScriptedTransport（OpenAI chat 形状的 mock 响应），
 * 解析复用 adaptors/openai-chat 的 codec——不另写一份 chat 映射。
 */

import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { CanonicalRequestEnvelope } from '../ir/index.js';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { MemoryUsageEmitter, MemoryUsageSink } from '../metering/memory-emitter.js';
import type { PipelineRunner } from '../gateway-core/pipeline/runner.js';
import { createModalityEndpoints } from '../http/modality-endpoints.js';
import { createDecisionsEndpointHandler } from '../http/decisions-endpoint.js';
import {
  ChatSimulatedDecisionAdaptor,
  MockDecisionAdaptor,
  TransportChatPort,
} from '../providers/decision/index.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const FAKE_KEY = 'sk-fake-openai-not-real';

/** 一个合法的 decision 请求信封（canonical 原生）。 */
function decisionEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ir_version: 'ag-ir/1',
    kind: 'decision',
    model: 'mock-decision-1',
    source_format: 'mock.decisions',
    payload: {
      content: [{ text: '用户在 30 分钟内第 4 次请求同一个问题。', role: 'context' }],
      // 注意：问题 id 刻意避开 escalate/stop/policy 等高风险关键词——
      // 默认降级策略不允许高风险判断降级（15 §6.5），高风险用例在下面显式构造。
      questions: [
        {
          id: 'q_route',
          type: 'choice',
          prompt: '这个请求应该路由到哪条 access path？',
          options: [
            { value: 'strong_reasoning', label: '强推理' },
            { value: 'fast_cheap', label: '轻量快速' },
          ],
        },
        {
          id: 'q_quality',
          type: 'scale',
          prompt: '这段上下文的历史信息量还有多少？',
          scale: { min: 1, max: 5 },
        },
      ],
    },
    raw: {},
    ...overrides,
  };
}

/** OpenAI chat 形状的 mock 响应（内容是一段 JSON answers）。 */
function chatUpstream(answersJson: string): string {
  return JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1_760_000_000,
    model: 'gpt-5.4',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: answersJson },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HttpHarness {
  server: Server;
  baseUrl: string;
  emitter: MemoryUsageEmitter;
  sink: MemoryUsageSink;
  transport: ScriptedTransport;
}

/** request id 生成器（测试要可预测）。 */
const ids = { requestId: () => 'req_decision_test', toolCallId: () => 'call_test' };

/** permissive 数据面鉴权（与 S0 的 permissive 档同语义；鉴权本身由 tools 测试覆盖）。 */
const permissiveAuth = {
  authenticate: async () => ({ ok: true as const, key_id: 'local-dev' }),
};

/**
 * 起一个只挂 decisions 端点的服务。
 *
 * runner 用真 gateway 的（`/v1/decisions` 在 ROUTES 之前被 modalities 端口接走，
 * runner 永远不会被调用——这里只需要一个满足类型的实例）。
 */
async function harnessWith(
  script: ScriptedTransportScript,
  buildHandler: (transport: ScriptedTransport) => ReturnType<typeof createDecisionsEndpointHandler>,
): Promise<HttpHarness> {
  const sink = new MemoryUsageSink();
  const emitter = new MemoryUsageEmitter({ autoFlush: false });
  emitter.setSink(sink);
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({ mode: 'test', clock, transport });
  const port = createModalityEndpoints({
    handlers: [buildHandler(transport)],
    authenticator: permissiveAuth,
    usageEmitter: emitter,
    clock,
    ids,
  });
  const server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner as PipelineRunner,
    modalities: port,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const portNum = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${portNum}`, emitter, sink, transport };
}

/** 默认 harness：native = mock，降级 = chat 模拟（默认策略）。 */
function defaultHarness(script: ScriptedTransportScript): Promise<HttpHarness> {
  return harnessWith(script, (transport) =>
    createDecisionsEndpointHandler({
      native: new MockDecisionAdaptor(),
      degraded: new ChatSimulatedDecisionAdaptor(
        new TransportChatPort({
          transport,
          headersProvider: async () => ({ authorization: `Bearer ${FAKE_KEY}` }),
          clock,
        }),
        { chatModel: 'gpt-5.4' },
      ),
    }),
  );
}

async function close(h: HttpHarness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
}

async function recordsOf(h: HttpHarness) {
  await h.emitter.flush();
  return h.sink.records;
}

async function post(
  h: HttpHarness,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}/v1/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// 1. 入站脸 + mock adaptor
// ---------------------------------------------------------------------------

describe('POST /v1/decisions（canonical 原生信封）', () => {
  it('mock adaptor：确定性答案 + questions 计量 + calibration native', async () => {
    const harness = await defaultHarness([]);
    const res = await post(harness, decisionEnvelope());
    expect(res.status).toBe(200);
    expect(res.body['kind']).toBe('decision');
    expect(res.body['calibration']).toEqual({ calibration: 'native' });
    const payload = res.body['payload'] as {
      answers: Array<{ question_id: string; label: string; probability?: number }>;
    };
    expect(payload.answers).toHaveLength(2);
    expect(payload.answers.map((a) => a.question_id)).toEqual(['q_route', 'q_quality']);
    // 确定性：同一请求两次 → 同一答案
    const res2 = await post(harness, decisionEnvelope());
    const payload2 = res2.body['payload'] as typeof payload;
    expect(payload2.answers).toEqual(payload.answers);
    // raw 不回客户端（20 §7.2）
    expect(res.body['raw']).toBeUndefined();

    const records = await recordsOf(harness);
    expect(records).toHaveLength(2);
    expect(records[0]!.access_path).toBe('mock.decisions');
    expect(records[0]!.usage.units.questions).toEqual({ asked: 2, answered: 2 });
    expect(records[0]!.usage.units.tokens?.input_tokens).toBeGreaterThan(0);
    // decision 的典型定价形态：输出免费（pricing_state.input=billed 已声明）
    await close(harness);
  });

  it('批量：100 题一次请求（Gemini 上限内）', async () => {
    const harness = await defaultHarness([]);
    const questions = Array.from({ length: 100 }, (_, i) => ({
      id: `q_${i}`,
      type: 'binary',
      prompt: `第 ${i} 个判断`,
    }));
    const res = await post(harness, decisionEnvelope({ payload: { content: [], questions } }));
    expect(res.status).toBe(200);
    const payload = res.body['payload'] as { answers: unknown[] };
    expect(payload.answers).toHaveLength(100);
    const records = await recordsOf(harness);
    expect(records[0]!.usage.units.questions).toEqual({ asked: 100, answered: 100 });
    await close(harness);
  });

  it('校验：坏 ir_version / 坏 kind / 空 questions / 超 1000 题 / 流式 → 400', async () => {
    const harness = await defaultHarness([]);
    const bad: Array<Record<string, unknown>> = [
      { ...decisionEnvelope(), ir_version: 'ag-ir/2' },
      { ...decisionEnvelope(), kind: 'chat' },
      decisionEnvelope({ payload: { content: [], questions: [] } }),
      decisionEnvelope({
        payload: {
          content: [],
          questions: Array.from({ length: 1001 }, (_, i) => ({
            id: `q${i}`,
            type: 'binary',
            prompt: 'p',
          })),
        },
      }),
      decisionEnvelope({ stream: { enabled: true, mode: 'sse', on_mismatch: 'reject' } }),
      decisionEnvelope({
        payload: { content: [], questions: [{ id: 'q', type: 'noul', prompt: 'p' }] },
      }),
    ];
    for (const body of bad) {
      const res = await post(harness, body);
      expect(res.status).toBe(400);
      expect((res.body['error'] as { code: string }).code).toBe('invalid_request');
    }
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });
});

// ---------------------------------------------------------------------------
// 2. 降级路径
// ---------------------------------------------------------------------------

describe('降级路径：chat 模拟 decision', () => {
  it('没有 native → chat + json_schema → calibration degraded + 输出计费', async () => {
    const answersJson = JSON.stringify({
      answers: [
        { question_id: 'q_route', label: 'fast_cheap', probability: 0.61 },
        { question_id: 'q_quality', label: '4', probability: 0.55 },
      ],
    });
    const harness = await harnessWith([{ body: chatUpstream(answersJson) }], (transport) =>
      createDecisionsEndpointHandler({
        // 故意不给 native：只有降级位
        degraded: new ChatSimulatedDecisionAdaptor(
          new TransportChatPort({
            transport,
            headersProvider: async () => ({ authorization: `Bearer ${FAKE_KEY}` }),
            clock,
          }),
          { chatModel: 'gpt-5.4' },
        ),
      }),
    );
    const res = await post(harness, decisionEnvelope());
    expect(res.status).toBe(200);
    expect(res.body['calibration']).toEqual({
      calibration: 'degraded',
      degraded_by: {
        reason: expect.stringContaining('chat'),
        model: 'gpt-5.4',
        chat_adaptor: 'openai.chat',
      },
    });
    const payload = res.body['payload'] as {
      answers: Array<{ question_id: string; label: string; probability?: number }>;
    };
    expect(payload.answers).toEqual([
      { question_id: 'q_route', label: 'fast_cheap', probability: 0.61 },
      { question_id: 'q_quality', label: '4', probability: 0.55 },
    ]);
    // 上游 chat 请求带 json_schema 结构化输出（降级路径的命脉）
    const wire = JSON.parse(harness.transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      response_format?: { type: string; json_schema?: { name: string } };
      messages: Array<{ role: string; content: string }>;
    };
    expect(wire.response_format?.type).toBe('json_schema');
    expect(wire.response_format?.json_schema?.name).toBe('decision_answers');
    expect(wire.messages[0]!.role).toBe('system');
    expect(wire.messages[1]!.content).toContain('q_route');

    // 计量：chat 的 token 用量 + questions；输出**计费**（不标 free）
    const records = await recordsOf(harness);
    expect(records[0]!.usage.units.questions).toEqual({ asked: 2, answered: 2 });
    expect(records[0]!.usage.units.tokens).toMatchObject({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
    });
    await close(harness);
  });

  it('chat 响应不是合法 JSON → 502（不猜答案）', async () => {
    const harness = await harnessWith([{ body: chatUpstream('我不是 JSON') }], (transport) =>
      createDecisionsEndpointHandler({
        degraded: new ChatSimulatedDecisionAdaptor(
          new TransportChatPort({
            transport,
            headersProvider: async () => ({ authorization: `Bearer ${FAKE_KEY}` }),
            clock,
          }),
          { chatModel: 'gpt-5.4' },
        ),
      }),
    );
    const res = await post(
      harness,
      decisionEnvelope({
        payload: { content: [], questions: [{ id: 'q_route', type: 'binary', prompt: 'p' }] },
      }),
    );
    expect(res.status).toBe(502);
    expect((res.body['error'] as { code: string }).code).toBe('network_error');
    await close(harness);
  });

  it('高风险判断显式允许降级（allow_degrade_high_stakes）→ 走降级', async () => {
    const answersJson = JSON.stringify({
      answers: [{ question_id: 'q_policy', label: 'no', probability: 0.3 }],
    });
    const harness = await harnessWith([{ body: chatUpstream(answersJson) }], (transport) =>
      createDecisionsEndpointHandler({
        degraded: new ChatSimulatedDecisionAdaptor(
          new TransportChatPort({
            transport,
            headersProvider: async () => ({ authorization: `Bearer ${FAKE_KEY}` }),
            clock,
          }),
          { chatModel: 'gpt-5.4' },
        ),
        policy: {
          mode: 'on_missing_upstream',
          allow_degrade_high_stakes: true,
        },
      }),
    );
    const res = await post(
      harness,
      decisionEnvelope({
        payload: {
          content: [],
          questions: [{ id: 'q_policy', type: 'binary', prompt: '这个请求是否触碰策略红线？' }],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body['calibration']).toMatchObject({ calibration: 'degraded' });
    await close(harness);
  });

  it('高风险判断（策略检查）不允许降级 → 明确失败，不用 chat 顶替', async () => {
    const harness = await harnessWith([], (transport) =>
      createDecisionsEndpointHandler({
        degraded: new ChatSimulatedDecisionAdaptor(
          new TransportChatPort({
            transport,
            headersProvider: async () => ({ authorization: `Bearer ${FAKE_KEY}` }),
            clock,
          }),
          { chatModel: 'gpt-5.4' },
        ),
      }),
    );
    const res = await post(
      harness,
      decisionEnvelope({
        payload: {
          content: [],
          questions: [{ id: 'q_policy', type: 'binary', prompt: '这个请求是否触碰策略红线？' }],
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body['error'] as { message: string }).message).toContain('不允许降级');
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('高风险判断有 native → 走 native（不降级）', async () => {
    const harness = await defaultHarness([]);
    const res = await post(
      harness,
      decisionEnvelope({
        payload: {
          content: [],
          questions: [{ id: 'q_stop', type: 'binary', prompt: '该停止 agentic loop 吗？' }],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body['calibration']).toEqual({ calibration: 'native' });
    await close(harness);
  });
});

// ---------------------------------------------------------------------------
// 3. mock adaptor 纯函数层
// ---------------------------------------------------------------------------

describe('MockDecisionAdaptor（纯函数层）', () => {
  const adaptor = new MockDecisionAdaptor();

  it('五种问题类型都有确定性答案', async () => {
    const req: CanonicalRequestEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'decision',
      model: 'm',
      source_format: 'mock.decisions',
      payload: {
        content: [],
        questions: [
          { id: 'b1', type: 'binary', prompt: 'p' },
          {
            id: 'c1',
            type: 'choice',
            prompt: 'p',
            options: [{ value: 'a' }, { value: 'b' }],
          },
          { id: 's1', type: 'scale', prompt: 'p', scale: { min: 1, max: 5 } },
          { id: 'r1', type: 'rubric', prompt: 'p', rubric: { criteria: 'c' } },
          { id: 'x1', type: 'box', prompt: 'p' },
        ],
        raw: {},
      },
      raw: {},
    };
    const { response } = await adaptor.decide(req);
    const answers = (response.payload as unknown as { answers: Array<Record<string, unknown>> })
      .answers;
    expect(answers).toHaveLength(5);
    expect(answers.every((a) => typeof a['label'] === 'string' && a['label'] !== '')).toBe(true);
    // 逐选项概率归一（choice）
    const choice = answers.find((a) => a['question_id'] === 'c1')!;
    const probs = (choice['option_probabilities'] as Array<{ probability: number }>).map(
      (o) => o.probability,
    );
    expect(probs.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
    // scale 落在量表内
    const scale = answers.find((a) => a['question_id'] === 's1')!;
    expect(Number(scale['label'])).toBeGreaterThanOrEqual(1);
    expect(Number(scale['label'])).toBeLessThanOrEqual(5);
  });

  it('usage：tokens（estimated）+ questions，输入计费状态显式', async () => {
    const req: CanonicalRequestEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'decision',
      model: 'm',
      source_format: 'mock.decisions',
      payload: {
        content: [{ text: '一段中文上下文' }],
        questions: [{ id: 'q', type: 'binary', prompt: 'p' }],
        raw: {},
      },
      raw: {},
    };
    const { response } = await adaptor.decide(req);
    expect(response.usage.source).toBe('estimated');
    expect(response.usage.precision).toBe('approx');
    expect(response.usage.units.tokens?.pricing_state).toEqual({ input: 'billed' });
    expect(response.usage.units.questions).toEqual({ asked: 1, answered: 1 });
    expect(response.warnings).toContain('mock_upstream');
  });
});
