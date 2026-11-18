/**
 * providers/decision/mock.ts —— decision 模态的**确定性 mock adaptor**（不打网络）。
 *
 * 定位（85 号矩阵 decision 卡片的 adaptor 列）：接口 + mock。真实上游
 * （gemini / jev / openai decisions）没有 key，未接；本 mock 让「入站脸 →
 * canonical → adaptor → canonical → 客户端」整条链路可跑、可测，答案**确定性**
 * （同一问题同一答案），便于测试断言与降级路径对照。
 *
 * 答案生成规则（刻意简单、可解释，不伪装成模型）：
 *   - 每题的种子 = FNV-1a(question_id) → 32 位无符号整数；
 *   - binary：`probability = 0.05 + (seed % 91) / 100`（0.05–0.95），
 *     label = probability >= 0.5 ? "yes" : "no"（客户端给了 options 时用选项值）；
 *   - choice：按种子取模选一项，逐选项概率按种子派生并归一；
 *   - scale：`min + seed % (max - min + 1)`（含端点）；
 *   - rubric：0–1 的确定性分数（种子 / 2^32）；
 *   - box：四边 0–1 的确定性坐标。
 *
 * usage：`units.tokens`（按输入文本的字符启发式估算，标注 source: "estimated"）
 * + `units.questions`（asked/answered）+ `pricing_state.output = "free"`
 * （decision 的典型定价形态：输入计费、输出免费，12 §1.5）。
 *
 * ⚠️ 校准性标记：mock 站在 **native** adaptor 的位置（它不是 chat 模拟），
 * 故 `calibration: "native"`；同时 response.warnings 带 `mock_upstream`、
 * raw.source_provider = "mock.decisions"、计量记 provider "mock"——三处都说清
 * 「这是 mock，不是真 decision 模型」。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  DecisionAnswer,
  DecisionPayload,
} from '../../ir/index.js';
import { asDecisionPayload } from '../../ir/guards.js';
import type {
  DecisionAdaptorOptions,
  DecisionAdaptorOutcome,
  DecisionProviderAdaptor,
} from './types.js';

/** FNV-1a 32 位哈希（确定性、无依赖）。 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 种子 → [0,1) 的确定性小数。 */
function unit(seed: number): number {
  return seed / 0x100000000;
}

/** 决策请求的全部输入文本（token 估算用）。 */
function inputTextOf(payload: DecisionPayload): string {
  const parts: string[] = [];
  for (const c of payload.content) {
    if (c.text !== undefined) parts.push(c.text);
  }
  for (const q of payload.questions) {
    parts.push(q.prompt);
    for (const o of q.options ?? []) parts.push(`${o.value} ${o.description ?? ''}`);
  }
  return parts.join('\n');
}

/** 字符启发式 token 估算（与 metering/pricing.ts 同一经验公式；mock 不需要更准）。 */
function estimateTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isWide =
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0x3040 && cp <= 0x309f) ||
      (cp >= 0x30a0 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef);
    if (isWide) wide += 1;
    else other += 1;
  }
  return wide + Math.ceil(other / 4);
}

/** 给一道题造一个确定性答案。 */
function answerFor(question: DecisionPayload['questions'][number]): DecisionAnswer {
  const seed = fnv1a(question.id);
  const base: DecisionAnswer = { question_id: question.id, label: '' };

  switch (question.type) {
    case 'binary': {
      const probability = 0.05 + (seed % 91) / 100;
      const options = question.options ?? [{ value: 'yes' }, { value: 'no' }];
      const positive = options[0]?.value ?? 'yes';
      const negative = options[1]?.value ?? 'no';
      return {
        ...base,
        label: probability >= 0.5 ? positive : negative,
        probability,
        option_probabilities: [
          { value: positive, probability },
          { value: negative, probability: 1 - probability },
        ],
      };
    }
    case 'choice': {
      const options = question.options ?? [];
      if (options.length === 0) return { ...base, label: '' };
      const pick = options[seed % options.length]!;
      // 逐选项概率：选中项 0.5–0.9，其余均分剩余
      const chosen = 0.5 + unit(seed >>> 8) * 0.4;
      const rest = (1 - chosen) / Math.max(1, options.length - 1);
      return {
        ...base,
        label: pick.value,
        probability: chosen,
        option_probabilities: options.map((o) => ({
          value: o.value,
          probability: o.value === pick.value ? chosen : rest,
        })),
      };
    }
    case 'scale': {
      const scale = question.scale ?? { min: 1, max: 5 };
      const span = scale.max - scale.min + 1;
      const value = scale.min + (seed % span);
      return { ...base, label: String(value), probability: 1 / span };
    }
    case 'rubric': {
      const score = unit(seed);
      const threshold = question.rubric?.pass_threshold ?? 0.5;
      return {
        ...base,
        label: score >= threshold ? 'pass' : 'fail',
        probability: score,
      };
    }
    case 'box': {
      const t = unit(seed);
      const l = unit(seed >>> 3);
      return {
        ...base,
        label: 'box',
        probability: 1,
        raw: { top: t, bottom: t + 0.2, left: l, right: l + 0.2 },
      };
    }
  }
}

/** 确定性 mock adaptor。 */
export class MockDecisionAdaptor implements DecisionProviderAdaptor {
  readonly provider = 'mock';
  readonly access_path = 'mock.decisions';
  readonly calibration = 'native' as const;

  async decide(
    req: CanonicalRequestEnvelope,
    opts: DecisionAdaptorOptions = {},
  ): Promise<DecisionAdaptorOutcome> {
    const payload = asDecisionPayload(req);
    if (payload === undefined) {
      throw new Error(`MockDecisionAdaptor 只接 kind:"decision"，收到 ${req.kind}`);
    }
    const answers = payload.questions.map(answerFor);
    const tokens = estimateTokens(inputTextOf(payload));

    const response: CanonicalResponseEnvelope = {
      ir_version: 'ag-ir/1',
      kind: 'decision',
      request_id: opts.requestId ?? '',
      usage: {
        units: {
          tokens: {
            input_tokens: tokens,
            output_tokens: 0,
            total_tokens: tokens,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            // decision 的典型定价形态：输入计费、输出免费（12 §1.5）。
            // mock 估的 output_tokens 是 0（没有生成），故只声明 input 的计价状态。
            pricing_state: { input: 'billed' },
          },
          questions: { asked: payload.questions.length, answered: answers.length },
        },
        source: 'estimated',
        precision: 'approx',
      },
      finish_reason: 'stop',
      payload: { answers },
      calibration: { calibration: 'native' },
      warnings: ['mock_upstream'],
      raw: { source_provider: 'mock.decisions' },
    };
    return { response, httpStatus: 200 };
  }
}
