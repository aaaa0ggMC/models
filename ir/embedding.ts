/**
 * ir/embedding.ts —— Embedding 模态 payload。
 *
 * 唯一事实来源：docs/design/15-modalities.md §5。
 * 计费单位：`usage.units.tokens`。Gemini 的 `taskType` 进 `native.gemini.task_type`。
 */

import type { MediaRef } from './media.js';
import type { RawEnvelope } from './envelope.js';

export interface EmbeddingPayload {
  /** 文本或多模态 embedding。 */
  input: string | string[] | MediaRef[];
  /** 截断维度（OpenAI dimensions）。 */
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  user?: string;
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface EmbeddingResponsePayload {
  embeddings: Array<{ index: number; vector: number[] | string }>;
  model: string;
}
