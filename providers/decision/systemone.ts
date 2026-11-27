/**
 * providers/decision/systemone.ts —— TypeSafe SystemOne / OpenCode Go 决策模型 adaptor。
 *
 * 协议规范见 docs/design/12-coverage-survey.md §1.5 与
 * docs/design/40-provider-adaptors.md §6.2（Jev / SystemOne）：
 *   - 端点：`POST /v1/systemone`（经 `resolveUpstreamUrl` 与 `base_url` 合并；
 *     OpenCode Go 为 `https://opencode.ai/inference/go/systemone/v1/systemone`，
 *     承载 `jev-1.14`、`gemini-decision-1`、`gpt-6-luna-decision`）。
 *   - 请求体：`{ model, state, questions: Record<id, Question>, assets? }`。
 *   - 响应体：`{ answers: Record<id, Answer>, usage?: { input_tokens, output_tokens } }`。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalUsage,
  DecisionAnswer,
  DecisionPayload,
  DecisionQuestion,
} from '../../ir/index.js';
import { IR_VERSION } from '../../ir/index.js';
import { asDecisionPayload } from '../../ir/guards.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';
import type {
  DecisionAdaptorOptions,
  DecisionAdaptorOutcome,
  DecisionProviderAdaptor,
} from '../../http/decisions-endpoint.js';

export const SYSTEMONE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const SYSTEMONE_PATH = '/v1/systemone';

/** 上游返回了非 2xx。 */
export class SystemOneDecisionApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`SystemOne decision 上游返回 HTTP ${status}`);
    this.name = 'SystemOneDecisionApiError';
  }
}

export interface SystemOneDecisionAdaptorDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
  provider?: string;
  accessPath?: string;
}

export interface EncodedSystemOneRequest {
  body: Record<string, unknown>;
  extraHeaders: Record<string, string>;
  warnings: string[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function encodeQuestion(q: DecisionQuestion, warnings: string[]): Record<string, unknown> {
  if (q.multiple === true) {
    warnings.push(`decision_multiple_dropped:${q.id}`);
  }
  switch (q.type) {
    case 'binary': {
      const out: Record<string, unknown> = {
        type: 'noul',
        instructions: q.prompt,
      };
      if (q.options !== undefined && q.options.length >= 2) {
        const first = q.options[0]!;
        const second = q.options[1]!;
        out['criteria'] = {
          true: first.description ?? first.label ?? first.value,
          false: second.description ?? second.label ?? second.value,
        };
      }
      return out;
    }
    case 'choice': {
      const criteria: Record<string, string> = {};
      for (const opt of q.options ?? []) {
        criteria[opt.value] = opt.description ?? opt.label ?? opt.value;
      }
      return {
        type: 'choice',
        instructions: q.prompt,
        criteria,
      };
    }
    case 'scale': {
      let criteria: string[];
      if (q.scale?.labels !== undefined && q.scale.labels.length > 0) {
        criteria = [...q.scale.labels];
      } else if (q.scale !== undefined) {
        const step = q.scale.step !== undefined && q.scale.step > 0 ? q.scale.step : 1;
        criteria = [];
        for (let v = q.scale.min; v <= q.scale.max && criteria.length < 10; v += step) {
          criteria.push(String(v));
        }
      } else {
        criteria = ['1', '2', '3', '4', '5'];
      }
      return {
        type: 'score',
        instructions: q.prompt,
        criteria,
      };
    }
    case 'rubric': {
      const instructions =
        q.rubric?.criteria !== undefined && q.rubric.criteria !== ''
          ? `${q.prompt}\nCriteria: ${q.rubric.criteria}`
          : q.prompt;
      return {
        type: 'noul',
        instructions,
      };
    }
    case 'box': {
      return {
        type: 'box',
        instructions: q.prompt,
      };
    }
  }
}

/** 将 canonical DecisionPayload 编码为 SystemOne wire 请求体。 */
export function encodeSystemOneRequest(
  payload: DecisionPayload,
  model: string,
): EncodedSystemOneRequest {
  const warnings: string[] = [];
  const extraHeaders: Record<string, string> = {};
  const textParts: string[] = [];
  const assets: Record<string, unknown> = {};
  let assetIndex = 0;

  for (const item of payload.content) {
    if (item.text !== undefined && item.text !== '') {
      textParts.push(item.role !== undefined ? `[${item.role}] ${item.text}` : item.text);
    }
    if (item.media !== undefined) {
      assetIndex += 1;
      const key = `asset_${assetIndex}`;
      if (item.media.kind === 'inline') {
        assets[key] = `data:${item.media.mime};base64,${item.media.data}`;
      } else if (item.media.kind === 'uri') {
        assets[key] = item.media.uri;
      } else if (item.media.kind === 'asset') {
        assets[key] = item.media.asset_id;
      }
    }
  }

  const state: unknown =
    textParts.length === 0 ? '' : textParts.length === 1 ? textParts[0]! : textParts.join('\n\n');

  const questions: Record<string, unknown> = {};
  for (const q of payload.questions) {
    questions[q.id] = encodeQuestion(q, warnings);
  }

  const body: Record<string, unknown> = {
    model,
    state,
    questions,
  };
  if (Object.keys(assets).length > 0) {
    body['assets'] = assets;
    extraHeaders['TypeSafe-Danger-Zone-Images'] = 'true';
  }

  return { body, extraHeaders, warnings };
}

function decodeProbabilitiesMap(
  raw: unknown,
): Array<{ value: string; probability: number }> | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const out: Array<{ value: string; probability: number }> = [];
  for (const [value, prob] of Object.entries(rec)) {
    if (typeof prob === 'number' && Number.isFinite(prob)) {
      out.push({ value, probability: prob });
    }
  }
  return out.length > 0 ? out : undefined;
}

function decodeAnswer(q: DecisionQuestion, rawAns: unknown): DecisionAnswer {
  const rec = asRecord(rawAns);
  if (rec === undefined) {
    return {
      question_id: q.id,
      label: String(rawAns ?? ''),
      raw: rawAns,
    };
  }

  const confidence =
    typeof rec['confidence'] === 'number' && Number.isFinite(rec['confidence'])
      ? rec['confidence']
      : undefined;
  const optionProbs = decodeProbabilitiesMap(rec['probabilities']);

  if (typeof rec['noul'] === 'number' && Number.isFinite(rec['noul'])) {
    const prob = rec['noul'];
    const trueLabel = q.options?.[0]?.value ?? 'yes';
    const falseLabel = q.options?.[1]?.value ?? 'no';
    return {
      question_id: q.id,
      label: prob >= 0.5 ? trueLabel : falseLabel,
      probability: prob,
      ...(confidence === undefined ? {} : { confidence }),
      ...(optionProbs === undefined ? {} : { option_probabilities: optionProbs }),
      raw: rawAns,
    };
  }

  if (rec['choice'] !== undefined) {
    const label = String(rec['choice']);
    const probsRec = asRecord(rec['probabilities']);
    const matchedProb =
      probsRec !== undefined && typeof probsRec[label] === 'number' ? probsRec[label] : undefined;
    return {
      question_id: q.id,
      label,
      ...(matchedProb === undefined ? {} : { probability: matchedProb }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(optionProbs === undefined ? {} : { option_probabilities: optionProbs }),
      raw: rawAns,
    };
  }

  if (rec['score'] !== undefined) {
    const label = String(rec['score']);
    const probsRec = asRecord(rec['probabilities']);
    const matchedProb =
      probsRec !== undefined && typeof probsRec[label] === 'number' ? probsRec[label] : undefined;
    return {
      question_id: q.id,
      label,
      ...(matchedProb === undefined ? {} : { probability: matchedProb }),
      ...(confidence === undefined ? {} : { confidence }),
      ...(optionProbs === undefined ? {} : { option_probabilities: optionProbs }),
      raw: rawAns,
    };
  }

  if (rec['box'] !== undefined) {
    return {
      question_id: q.id,
      label: JSON.stringify(rec['box']),
      ...(confidence === undefined ? {} : { confidence }),
      raw: rawAns,
    };
  }

  return {
    question_id: q.id,
    label: typeof rec['label'] === 'string' ? rec['label'] : JSON.stringify(rec),
    ...(typeof rec['probability'] === 'number' ? { probability: rec['probability'] } : {}),
    ...(confidence === undefined ? {} : { confidence }),
    ...(optionProbs === undefined ? {} : { option_probabilities: optionProbs }),
    raw: rawAns,
  };
}

/** 解码 SystemOne wire 响应为 canonical DecisionAnswer[] + CanonicalUsage。 */
export function decodeSystemOneResponse(
  parsed: unknown,
  questions: readonly DecisionQuestion[],
): {
  answers: DecisionAnswer[];
  usage: CanonicalUsage;
  usageRaw?: Record<string, unknown>;
  warnings: string[];
} {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    throw new Error('SystemOne 上游响应不是 JSON 对象');
  }
  const answersMap = asRecord(rec['answers']) ?? {};
  const warnings: string[] = [];
  const answers: DecisionAnswer[] = [];

  for (const q of questions) {
    if (answersMap[q.id] === undefined) {
      warnings.push('partial_answers');
      answers.push({
        question_id: q.id,
        label: '',
        raw: { error: 'missing_answer' },
      });
    } else {
      answers.push(decodeAnswer(q, answersMap[q.id]));
    }
  }

  const usageRec = asRecord(rec['usage']);
  const inputTokens =
    typeof usageRec?.['input_tokens'] === 'number'
      ? usageRec['input_tokens']
      : typeof usageRec?.['prompt_tokens'] === 'number'
        ? usageRec['prompt_tokens']
        : undefined;
  const outputTokens =
    typeof usageRec?.['output_tokens'] === 'number'
      ? usageRec['output_tokens']
      : typeof usageRec?.['completion_tokens'] === 'number'
        ? usageRec['completion_tokens']
        : 0;

  const answeredCount = answers.filter(
    (a) => !(typeof a.raw === 'object' && a.raw !== null && (a.raw as { error?: string }).error === 'missing_answer'),
  ).length;
  const usage: CanonicalUsage = {
    units: {
      ...(inputTokens === undefined
        ? {}
        : {
            tokens: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              total_tokens:
                typeof usageRec?.['total_tokens'] === 'number'
                  ? usageRec['total_tokens']
                  : inputTokens + outputTokens,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              reasoning_tokens: 0,
              pricing_state: { input: 'billed', output: 'free' },
            },
          }),
      questions: { asked: questions.length, answered: answeredCount },
    },
    source: 'provider',
  };
  if (inputTokens === undefined) warnings.push('usage_missing');

  return {
    answers,
    usage,
    ...(usageRec === undefined ? {} : { usageRaw: usageRec }),
    warnings: [...new Set(warnings)],
  };
}

export class SystemOneDecisionAdaptor implements DecisionProviderAdaptor {
  readonly provider: string;
  readonly access_path: string;
  readonly calibration = 'native' as const;

  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: SystemOneDecisionAdaptorDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? SYSTEMONE_DEFAULT_BASE_URL;
    this.path = deps.path ?? SYSTEMONE_PATH;
    this.provider = deps.provider ?? 'typesafe';
    this.access_path = deps.accessPath ?? 'jev.decisions';
  }

  async decide(
    req: CanonicalRequestEnvelope,
    opts: DecisionAdaptorOptions = {},
  ): Promise<DecisionAdaptorOutcome> {
    const payload = asDecisionPayload(req);
    if (payload === undefined) {
      throw new Error(`SystemOneDecisionAdaptor 只接 kind:"decision"，收到 ${req.kind}`);
    }
    const model = req.resolved_model ?? req.model;
    const encoded = encodeSystemOneRequest(payload, model);

    const getHeaders = opts.headersProvider ?? this.headersProvider;
    const headers: Record<string, string> = {
      ...(await getHeaders()),
      ...encoded.extraHeaders,
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: opts.baseUrl ?? this.baseUrl,
      path: this.path,
      headers,
      body: Buffer.from(JSON.stringify(encoded.body), 'utf8'),
      stream: false,
    };
    const res: UpstreamResponse = await this.transport.send(upstream);
    const resBody = res.body ?? Buffer.alloc(0);
    if (res.status < 200 || res.status >= 300) {
      throw new SystemOneDecisionApiError(res.status, resBody.toString('utf8').slice(0, 2048));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(resBody.toString('utf8')) as unknown;
    } catch {
      throw new Error('SystemOne 上游响应不是合法 JSON');
    }
    const decoded = decodeSystemOneResponse(parsed, payload.questions);

    const response: CanonicalResponseEnvelope = {
      ir_version: IR_VERSION,
      kind: 'decision',
      request_id: opts.requestId ?? '',
      usage: decoded.usage,
      finish_reason: 'stop',
      payload: { answers: decoded.answers },
      calibration: { calibration: 'native' },
      warnings: [...encoded.warnings, ...decoded.warnings],
      raw: {
        ...(decoded.usageRaw === undefined ? {} : { nodes: { usage: decoded.usageRaw } }),
        source_provider: opts.accessPath ?? this.provider,
      },
    };
    return { response, httpStatus: res.status };
  }
}
