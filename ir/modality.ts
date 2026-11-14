/**
 * ir/modality.ts —— 模态判别式与注册表。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §3（判别式 + 注册表 + §3.3 未知模态处理）。
 *
 * 硬约束（§3.2 第 7 条）：新增模态必须是**增量**——不改 CanonicalRequestEnvelope 的任何现有字段，
 * 否则老插件的类型会炸。新增步骤见该节 6 步。
 */

import type { ChatPayload, ChatResponsePayload } from "./chat.js";
import type { DecisionPayload, DecisionResponsePayload } from "./decision.js";
import type { EmbeddingPayload, EmbeddingResponsePayload } from "./embedding.js";
import type { TtsPayload, TtsResponsePayload } from "./tts.js";
import type { AsrPayload, AsrResponsePayload } from "./asr.js";
import type { ImagePayload, ImageResponsePayload } from "./image.js";
import type { RerankPayload, RerankResponsePayload } from "./rerank.js";
import type { ModerationPayload, ModerationResponsePayload } from "./moderation.js";
import type { VideoPayload, VideoResponsePayload } from "./video.js";
import type { StreamOptions } from "./envelope.js";

/**
 * 模态判别。注意：decision 是 2026-11 新增的**第 9 个模态**，只是在联合类型里排第 2，
 * **勿称"第五模态"**（00-overview.md §5 术语表）。
 */
export type ModalityKind =
  | "chat" // [v1] 最丰富
  | "decision" // [v1.5] 第 9 个模态，控制面能力，不是 chat 的特例
  | "embedding" // [v1]
  | "tts" // [v1.5]
  | "asr" // [v1.5]
  | "image" // [v1.5]
  | "rerank" // [later]
  | "moderation" // [later]
  | "video"; // [later] 仅 schema 占位，不实现

export type ModalityPayload =
  | ChatPayload
  | DecisionPayload
  | EmbeddingPayload
  | TtsPayload
  | AsrPayload
  | ImagePayload
  | RerankPayload
  | ModerationPayload
  | VideoPayload;

export type ModalityResponsePayload =
  | ChatResponsePayload
  | DecisionResponsePayload
  | EmbeddingResponsePayload
  | TtsResponsePayload
  | AsrResponsePayload
  | ImageResponsePayload
  | RerankResponsePayload
  | ModerationResponsePayload
  | VideoResponsePayload;

/** 所有模态的稳定顺序（用于遍历/渲染，不参与语义）。 */
export const MODALITY_KINDS: readonly ModalityKind[] = [
  "chat",
  "decision",
  "embedding",
  "tts",
  "asr",
  "image",
  "rerank",
  "moderation",
  "video",
];

export function isModalityKind(value: string): value is ModalityKind {
  return (MODALITY_KINDS as readonly string[]).includes(value);
}

/** 该模态的默认流式策略（10 §4.5 末尾）。 */
export function defaultStreamOptions(kind: ModalityKind, enabled: boolean): StreamOptions {
  const onMismatch: StreamOptions["on_mismatch"] =
    kind === "decision" ? "reject" : enabled ? "bridge" : "reject";
  return {
    enabled,
    mode: enabled ? "sse" : "none",
    on_mismatch: onMismatch,
  };
}
