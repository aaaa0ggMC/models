/**
 * providers/decision/index.ts —— decision 模态 provider 侧的出口。
 *
 * 交付形态（85 号矩阵 decision 卡片）：**接口 + mock + 降级路径**。
 * 三家真实上游（gemini / jev / openai decisions）未接（无 key），字段级映射
 * 已在 docs/design/12-coverage-survey.md §1.5 按官方 API reference 落库。
 */

export type {
  DecisionProviderAdaptor,
  DecisionAdaptorOutcome,
  DecisionAdaptorOptions,
} from './types.js';
export { MockDecisionAdaptor } from './mock.js';
export {
  ChatSimulatedDecisionAdaptor,
  TransportChatPort,
  buildDegradedChatRequest,
  parseAnswersFromChat,
  type ChatCompletionsPort,
  type TransportChatPortDeps,
} from './degraded.js';
