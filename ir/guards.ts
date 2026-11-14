/**
 * ir/guards.ts —— 信封 → 模态 payload 的结构化收窄助手。
 *
 * 为什么需要它：`CanonicalRequestEnvelope` 的 `kind` 与 `payload` 是**两个独立属性**，
 * 不是判别式联合（10 §2 的信封形状如此，且新增模态不能改信封——§3.2 第 7 条硬约束）。
 * 因此 `if (env.kind !== "chat")` **不会**把 `env.payload` 收窄成 `ChatPayload`。
 * 这些 helper 把"按 kind 判别 + 结构校验"收在一处，避免每个调用点各写一遍断言。
 */

import type {
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  ChatPayload,
  ChatResponsePayload,
  DecisionPayload,
  DecisionResponsePayload,
} from "./index.js";

function hasMessageShape(v: unknown): v is { messages: unknown } {
  return typeof v === "object" && v !== null && "messages" in v;
}

function hasAssistantShape(v: unknown): v is { message: unknown } {
  return typeof v === "object" && v !== null && "message" in v;
}

/** 把请求信封收窄成 chat payload；不是 chat 模态时返回 undefined。 */
export function asChatPayload(env: CanonicalRequestEnvelope): ChatPayload | undefined {
  if (env.kind !== "chat") return undefined;
  if (!hasMessageShape(env.payload)) return undefined;
  return env.payload as ChatPayload;
}

/** 把响应信封收窄成 chat 响应 payload。 */
export function asChatResponsePayload(
  env: CanonicalResponseEnvelope,
): ChatResponsePayload | undefined {
  if (env.kind !== "chat") return undefined;
  if (!hasAssistantShape(env.payload)) return undefined;
  return env.payload as ChatResponsePayload;
}

/** 把请求信封收窄成 decision payload。 */
export function asDecisionPayload(env: CanonicalRequestEnvelope): DecisionPayload | undefined {
  if (env.kind !== "decision") return undefined;
  if (typeof env.payload !== "object" || env.payload === null) return undefined;
  if (!("questions" in env.payload)) return undefined;
  return env.payload as DecisionPayload;
}

/** 把响应信封收窄成 decision 响应 payload。 */
export function asDecisionResponsePayload(
  env: CanonicalResponseEnvelope,
): DecisionResponsePayload | undefined {
  if (env.kind !== "decision") return undefined;
  if (typeof env.payload !== "object" || env.payload === null) return undefined;
  if (!("answers" in env.payload)) return undefined;
  return env.payload as DecisionResponsePayload;
}
