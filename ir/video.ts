/**
 * ir/video.ts —— Video 模态 payload `[later]`。
 *
 * 状态：00-overview.md §2.2 第 6 条「不做视频模态实现（v1.5 前）」；
 * 70-roadmap §7「Phase 5 前不做 video 模态实现（schema 留位）」。
 * 因此这里只有**空占位 + raw**——刻意不留任何猜测字段，等真实上游样本再按 40 §1.4 校准。
 */

import type { RawEnvelope } from "./envelope.js";

export interface VideoPayload {
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface VideoResponsePayload {
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}
