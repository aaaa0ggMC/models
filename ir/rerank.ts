/**
 * ir/rerank.ts —— Rerank 模态 payload `[later]`。
 *
 * 状态：00-overview.md §2.1 标 [later]（schema 已留位，adaptor 按需写）。
 * 这里只放 schema 占位 + raw 透传；等第一个 rerank adaptor 开工时再按 40 §1.6 检查清单校准字段。
 */

import type { RawEnvelope } from './envelope.js';

export interface RerankPayload {
  /** 查询。 */
  query: string;
  /** 待重排的文档。 */
  documents: string[];
  /** 返回前 K 个。 */
  top_k?: number;
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface RerankResponsePayload {
  results: Array<{ index: number; score: number; document?: string }>;
}
