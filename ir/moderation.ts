/**
 * ir/moderation.ts —— Moderation 模态 payload `[later]`。
 *
 * 状态：00-overview.md §2.1 标 [later]（schema 已留位）。
 */

import type { RawEnvelope } from './envelope.js';

export interface ModerationPayload {
  /** 待审核内容：纯文本或多模态引用。 */
  input: string | Array<{ type: 'text'; text: string }>;
  /** 指定审核类目（上游类目名）。 */
  categories?: string[];
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface ModerationResponsePayload {
  results: Array<{
    flagged: boolean;
    categories: Record<string, boolean>;
    category_scores?: Record<string, number>;
    /** 上游原始结果对象。 */
    raw?: unknown;
  }>;
}
