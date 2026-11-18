/**
 * providers/decision/types.ts —— decision 模态的 provider adaptor 接口。
 *
 * 三家真实上游（gemini.decisions / jev.decisions / openai.decisions）的字段级
 * 映射已在 [12-coverage-survey.md](../../docs/design/12-coverage-survey.md) §1.5
 * 按官方 API reference 落库；本文件只定**接口**——本仓库没有 key，v1 交付的是
 * 「接口 + mock + chat 降级路径」（85 号矩阵 decision 卡片）。
 *
 * 两个实现的分工：
 *   - `MockDecisionAdaptor`（mock.ts）：确定性答案，**不打网络**。它站在
 *     native adaptor 的位置上（接口/wire 形状就绪），不是 chat 模拟——
 *     响应标 `calibration: "native"` + warning `mock_upstream`，计量记
 *     `provider: "mock"`。接上真实上游时整体替换，调用方无感。
 *   - `ChatSimulatedDecisionAdaptor`（degraded.ts）：chat + `json_schema`
 *     模拟 decision，响应标 `calibration: "degraded"` 并带 `degraded_by`
 *     （40 §6.3 的降级路径）。
 */

import type {
  DecisionAdaptorOptions,
  DecisionAdaptorOutcome,
  DecisionProviderAdaptor,
} from '../../http/decisions-endpoint.js';

export type { DecisionAdaptorOptions, DecisionAdaptorOutcome, DecisionProviderAdaptor };
