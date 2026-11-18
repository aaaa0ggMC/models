/**
 * providers/decision/degraded.ts —— decision 的**降级路径**：用 chat + 结构化输出
 * 模拟 decision（40 §6.3）。
 *
 * ## 什么时候走这条路
 *
 * 路由不到 decision 上游时（`DEFAULT_DECISION_DEGRADATION_POLICY.mode =
 * "on_missing_upstream"`，15 §6.5）。**策略检查与 stop 决策不允许降级**
 * （`allow_degrade_high_stakes: false`）——那两类判断拿不到真 decision 就明确
 * 失败，不用 chat 顶替。降级策略的判定在 http/decisions-endpoint.ts。
 *
 * ## 实现立场：复用 openai.chat codec，不另写一份映射
 *
 * chat 模拟的 wire 形状（messages + `response_format: json_schema`）与
 * pipeline 的 chat 链路是同一件事，所以这里直接复用 `adaptors/openai-chat` 的
 * codec 做 canonical → wire → canonical，自己只做三件 decision 专属的事：
 *   1. 把 decision 请求**降维**成 chat 请求（系统指令 + JSON schema）；
 *   2. 把 chat 响应的助手文本**解析回** answers[]；
 *   3. 标 `calibration: "degraded"` + `degraded_by`。
 *
 * 实测代价（TypeSafe cookbook 2026-11-02，15 §6.1）：即使最便宜的 LLM +
 * temperature 0 + structured output，也要 ~27x 延迟、~4x 成本；判断稳定性
 * （帖子变号 >10% vs Jev ≤6.7%）也更差。**降级是兜底不是平权**。
 *
 * ## chat 上游客口
 *
 * `ChatCompletionsPort` 是一个最小端口（complete(canonical chat req) → canonical
 * chat res）。本文件提供基于 Transport 的默认实现；测试可整体替换。
 */

import type {
  CanonicalMessage,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  DecisionAnswer,
  DecisionPayload,
  FormatId,
  JSONSchema,
  RequestContext,
  TextPart,
} from '../../ir/index.js';
import { asChatResponsePayload, asDecisionPayload } from '../../ir/guards.js';
import type { Transport } from '../../gateway-core/transport.js';
import { OpenAIChatCodec } from '../../adaptors/openai-chat/codec.js';
import type { Clock } from '../../ir/index.js';
import type {
  DecisionAdaptorOptions,
  DecisionAdaptorOutcome,
  DecisionProviderAdaptor,
} from './types.js';

/** chat 上游客口（降级路径的最小依赖）。 */
export interface ChatCompletionsPort {
  complete(req: CanonicalRequestEnvelope): Promise<CanonicalResponseEnvelope>;
}

/** 基于 Transport + openai.chat codec 的 chat 端口实现。 */
export interface TransportChatPortDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
  clock: Clock;
}

export class TransportChatPort implements ChatCompletionsPort {
  private readonly codec: OpenAIChatCodec;

  constructor(private readonly deps: TransportChatPortDeps) {
    this.codec = new OpenAIChatCodec({ clock: deps.clock });
  }

  async complete(req: CanonicalRequestEnvelope): Promise<CanonicalResponseEnvelope> {
    const ctx = standaloneContext(this.deps.clock.now(), req.source_format, req.model);
    const encoded = this.codec.encode(req, ctx);
    const headers: Record<string, string> = {
      ...(await this.deps.headersProvider()),
      'content-type': 'application/json',
      ...(encoded.headers ?? {}),
    };
    const res = await this.deps.transport.send({
      method: 'POST',
      base_url: this.deps.baseUrl ?? 'https://api.openai.com',
      path: encoded.path ?? this.deps.path ?? '/v1/chat/completions',
      headers,
      body: Buffer.from(JSON.stringify(encoded.body ?? {}), 'utf8'),
      stream: false,
    });
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`chat 上游返回 HTTP ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((res.body ?? Buffer.alloc(0)).toString('utf8')) as unknown;
    } catch {
      throw new Error('chat 上游响应不是合法 JSON');
    }
    return this.codec.decodeResponse(parsed, ctx);
  }
}

/**
 * 造一个**独立**的 RequestContext（不经过 S0–S10）。
 *
 * codec 只读少量字段（request_id / client_format / provider_format / warn /
 * fast_path / route?.access_path / request_bytes），这里给一份满足类型的最小值。
 * `fast_path: false` 是硬编码——降级路径必须走完整结构转换（字节透传会把
 * decision 的 prompt 原样发给 chat 上游，那是另一个 bug）。
 */
function standaloneContext(now: number, clientFormat: FormatId, model: string): RequestContext {
  return {
    request_id: `decision-degraded-${now.toString(36)}`,
    started_at: now,
    deadline: now + 60_000,
    client_format: clientFormat,
    client_raw_headers: {},
    auth: { key_id: 'local-dev' },
    route: {
      access_path: 'openai',
      provider: 'openai',
      provider_format: 'openai.chat',
      model,
      full_model_id: `openai/${model}`,
      attempt_plan: [
        {
          provider: 'openai',
          access_path: 'openai',
          provider_format: 'openai.chat',
          model,
          fast_path_eligible: false,
        },
      ],
      fast_path_eligible: false,
    },
    provider_format: 'openai.chat',
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    warn: () => {},
  } as unknown as RequestContext;
}

// ---------------------------------------------------------------------------
// decision 请求 → chat 请求（降维）
// ---------------------------------------------------------------------------

/** answers[] 的 JSON schema（chat 结构化输出的契约）。 */
const ANSWER_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question_id: { type: 'string' },
          label: { type: 'string' },
          probability: { type: 'number' },
          confidence: { type: 'number' },
          option_probabilities: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string' },
                probability: { type: 'number' },
              },
              required: ['value', 'probability'],
            },
          },
          rationale: { type: 'string' },
        },
        required: ['question_id', 'label'],
      },
    },
  },
  required: ['answers'],
};

const SYSTEM_INSTRUCTION = [
  'You answer structured judgment questions (a "decision" task).',
  'Reply with ONLY a JSON object matching the given schema: an "answers" array,',
  'one entry per question_id. Each entry needs "label"; include "probability"',
  '(0-1, your calibrated estimate) and "option_probabilities" when the question',
  'has options. Do not add prose outside the JSON.',
].join(' ');

/** 把 decision 的问题清单序列成 user 消息文本。 */
function questionsText(payload: DecisionPayload): string {
  const lines: string[] = [];
  if (payload.content.length > 0) {
    lines.push('# Content to judge');
    for (const c of payload.content) {
      if (c.text !== undefined) lines.push(c.text);
    }
    lines.push('');
  }
  lines.push('# Questions');
  for (const q of payload.questions) {
    lines.push(`- id: ${q.id} | type: ${q.type} | prompt: ${q.prompt}`);
    if (q.options !== undefined && q.options.length > 0) {
      lines.push(
        `  options: ${q.options.map((o) => `${o.value}${o.description ? ` (${o.description})` : ''}`).join(', ')}`,
      );
    }
    if (q.scale !== undefined) {
      lines.push(`  scale: ${q.scale.min}–${q.scale.max}`);
    }
  }
  return lines.join('\n');
}

/** decision 请求信封 → chat 请求信封（kind: chat, openai.chat）。 */
export function buildDegradedChatRequest(
  req: CanonicalRequestEnvelope,
  chatModel: string,
): CanonicalRequestEnvelope {
  const payload = asDecisionPayload(req);
  if (payload === undefined) {
    throw new Error(`降级路径只接 kind:"decision"，收到 ${req.kind}`);
  }
  const userMessage: CanonicalMessage = {
    role: 'user',
    parts: [{ type: 'text', text: questionsText(payload) } satisfies TextPart],
  };
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    model: chatModel,
    source_format: 'openai.chat',
    payload: {
      system: [{ text: SYSTEM_INSTRUCTION }],
      messages: [userMessage],
      params: {
        temperature: 0,
        max_output_tokens: 4096,
        // 结构化输出是降级路径的命脉：没有它，解析 answers[] 全靠运气
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'decision_answers',
            description: 'decision 模态的 answers 数组',
            schema: ANSWER_SCHEMA,
            strict: false,
          },
        },
      },
    },
    raw: {},
  };
}

/** chat 响应的助手文本 → answers[]。解析失败抛错（不猜答案）。 */
export function parseAnswersFromChat(res: CanonicalResponseEnvelope): DecisionAnswer[] {
  const chat = asChatResponsePayload(res);
  if (chat === undefined) {
    throw new Error(`降级解析只接 kind:"chat"，收到 ${res.kind}`);
  }
  const text = chat.message.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const jsonText = extractJsonObject(text);
  if (jsonText === undefined) {
    throw new Error('chat 模拟响应里找不到 JSON 对象');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    throw new Error('chat 模拟响应的 JSON 解析失败');
  }
  const answers = (parsed as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) {
    throw new Error('chat 模拟响应缺少 answers 数组');
  }
  const out: DecisionAnswer[] = [];
  for (const item of answers) {
    const rec = item as Record<string, unknown>;
    if (typeof rec['question_id'] !== 'string' || typeof rec['label'] !== 'string') continue;
    out.push({
      question_id: rec['question_id'],
      label: rec['label'],
      ...(typeof rec['probability'] === 'number' ? { probability: rec['probability'] } : {}),
      ...(typeof rec['confidence'] === 'number' ? { confidence: rec['confidence'] } : {}),
      ...(Array.isArray(rec['option_probabilities'])
        ? {
            option_probabilities: (rec['option_probabilities'] as Array<Record<string, unknown>>)
              .filter((o) => typeof o['value'] === 'string' && typeof o['probability'] === 'number')
              .map((o) => ({
                value: o['value'] as string,
                probability: o['probability'] as number,
              })),
          }
        : {}),
      ...(typeof rec['rationale'] === 'string' ? { rationale: rec['rationale'] } : {}),
    });
  }
  return out;
}

/** 从模型文本里抠出第一个完整 JSON 对象（容忍 ```json 围栏与前后散文）。 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// adaptor
// ---------------------------------------------------------------------------

/** chat 模拟 decision 的 adaptor。 */
export class ChatSimulatedDecisionAdaptor implements DecisionProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;
  readonly calibration = 'degraded' as const;

  constructor(
    private readonly chat: ChatCompletionsPort,
    opts: { chatModel: string; provider?: string; accessPath?: string },
  ) {
    this.provider = opts.provider ?? 'openai';
    this.access_path = opts.accessPath ?? 'openai.decisions';
    this.chatModel = opts.chatModel;
  }

  private readonly chatModel: string;

  async decide(
    req: CanonicalRequestEnvelope,
    opts: DecisionAdaptorOptions = {},
  ): Promise<DecisionAdaptorOutcome> {
    const chatReq = buildDegradedChatRequest(req, this.chatModel);
    const chatRes = await this.chat.complete(chatReq);
    const answers = parseAnswersFromChat(chatRes);

    // usage 原样带 chat 的（降级路径输出**要计费**——chat 不像 decision 输出免费）
    const response: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'decision',
      request_id: opts.requestId ?? '',
      usage: {
        ...chatRes.usage,
        units: {
          ...chatRes.usage.units,
          questions: {
            asked: asDecisionPayload(req)?.questions.length ?? 0,
            answered: answers.length,
          },
        },
      },
      finish_reason: 'stop',
      payload: { answers },
      calibration: {
        calibration: 'degraded',
        degraded_by: {
          reason: '路由不到 decision 上游，用 chat + 结构化输出模拟（代价见 15 §6.1）',
          model: this.chatModel,
          chat_adaptor: 'openai.chat',
        },
      },
      warnings: ['decision_degraded_to_chat'],
      raw: { source_provider: this.provider },
    };
    return { response, httpStatus: 200 };
  }
}
