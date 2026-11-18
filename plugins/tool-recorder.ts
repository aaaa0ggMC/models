/**
 * plugins/tool-recorder.ts —— 工具调用旁路记录（给界面看「哪个工具、入参、结果摘要」）。
 *
 * 设计依据：docs/design/95-agent-chat.md §2.2（工具调用可视化）、§3.3（明文披露通道）。
 *
 * ## 为什么需要它
 *
 * 工具结果由网关 agentic loop 自己消费，**不出现在上游响应里**——客户端打
 * `/v1/chat/completions` 永远看不到 tool_result。于是「结果摘要」这一路只能从循环
 * 内部取。`PluginHost.runOnToolCall` 是唯一同时看得见调用与（脱敏后的）结果的地方，
 * 因此记录器挂在 `plugins/redaction-host.ts` 的同一个装饰点上，一次拦截两用。
 *
 * ## 明文披露为什么也走这里
 *
 * `create_virtual_key` 会产生一把明文 key。它**不能**进 tool_result（模型会看见），
 * 因此需要一条与 canonical 完全分离的旁路送到浏览器。这条旁路就是本记录器：
 *
 *   - 按 `request_id` 分桶，聊天端点在一次请求结束后 `take(requestId)` 取走即删；
 *   - `secret` 字段只存在于**服务端的这条记录**里，从不进 tool_result、不进 canonical、
 *     不落盘、不进日志；
 *   - 分桶而不是共享单例：并发两次对话时，A 的密钥不会被 B 拿走。
 *
 * 插件侧把待披露的明文暂存在 `ctx.state`（每个请求一个 ctx，天然隔离），
 * 装饰器在拿到脱敏结果后一并搬进记录。
 *
 * ## 记下来的是什么
 *
 * 工具名、入参、结果文本、是否出错、结果 JSON 里的 `status`，以及可选的旁路披露。
 * 结果文本是**脱敏之后**的那一份——界面上看到的与模型看到的是同一文本。
 */

import type { RequestContext, ToolResultPart, ToolUsePart } from '../ir/index.js';
import { CTX_STATE_KEYS } from '../ir/index.js';

/** 一次工具调用的记录。 */
export interface ToolCallRecord {
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
  /** 结果文本（已脱敏）。 */
  result_text: string;
  /** 结果 JSON 里的 `status` 字段（界面用来配色）。 */
  status?: string;
  is_error: boolean;
  /**
   * 旁路披露：这一轮创建出来的虚拟 key 明文。
   *
   * **只存在于服务端记录里**，永不进 tool_result（模型看不到）、不落盘、不进日志。
   */
  secret?: { key_id: string; plaintext: string; name: string; masked: string };
}

/** 最多保留多少个请求的记录（超出淘汰最旧）。 */
const MAX_BUCKETS = 256;

export class ToolCallRecorder {
  private readonly buckets = new Map<string, ToolCallRecord[]>();
  private readonly listeners = new Set<(requestId: string, record: ToolCallRecord) => void>();

  /** 订阅实时工具调用完成事件（供流式内置对话即时推送 tool 帧）。 */
  subscribe(listener: (requestId: string, record: ToolCallRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 记一次工具调用（装饰器拿到脱敏结果后调用）。 */
  record(
    requestId: string,
    call: ToolUsePart,
    result: ToolResultPart,
    secret?: ToolCallRecord['secret'],
  ): void {
    const list = this.buckets.get(requestId) ?? [];
    const text = typeof result.content === 'string' ? result.content : '';
    const rec: ToolCallRecord = {
      tool_use_id: call.id,
      name: call.name,
      input: call.input,
      result_text: text,
      ...(statusOf(text) === undefined ? {} : { status: statusOf(text) }),
      is_error: result.is_error === true,
      ...(secret === undefined ? {} : { secret }),
    };
    list.push(rec);
    this.buckets.set(requestId, list);
    if (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next();
      if (!oldest.done) this.buckets.delete(oldest.value);
    }
    for (const listener of this.listeners) {
      try {
        listener(requestId, rec);
      } catch {
        // 旁路订阅者不得阻断工具记录
      }
    }
  }

  /** 取走并清空某个请求的记录。 */
  take(requestId: string): ToolCallRecord[] {
    const list = this.buckets.get(requestId) ?? [];
    this.buckets.delete(requestId);
    return list;
  }

  /** 当前桶数（测试与自省用）。 */
  get size(): number {
    return this.buckets.size;
  }
}

/**
 * 插件把待披露的明文暂存进 `ctx.state`（每个请求一个 ctx，天然隔离）。
 *
 * 之所以绕一圈而不是让插件直接写记录器：插件拿到的结果是**脱敏前**的
 * （脱敏在装饰器里做），由插件记录就会把未脱敏文本写进界面视图。
 */
export function stashSecret(
  ctx: RequestContext,
  secret: NonNullable<ToolCallRecord['secret']>, // privacy-scan: ignore —— 类型/参数名（字段名，无值）
): void {
  const pending =
    (ctx.state[CTX_STATE_KEYS.AGENT_PENDING_SECRET] as
      Array<NonNullable<ToolCallRecord['secret']>> | undefined) ?? [];
  pending.push(secret);
  ctx.state[CTX_STATE_KEYS.AGENT_PENDING_SECRET] = pending;
}

/** 装饰器取走暂存的披露（取走即清空，避免同一份明文被记两次）。 */
export function takeStashedSecrets(
  ctx: RequestContext,
): Array<NonNullable<ToolCallRecord['secret']>> {
  const pending = ctx.state[CTX_STATE_KEYS.AGENT_PENDING_SECRET] as
    Array<NonNullable<ToolCallRecord['secret']>> | undefined;
  if (pending === undefined) return [];
  delete ctx.state[CTX_STATE_KEYS.AGENT_PENDING_SECRET];
  return pending;
}

/** 从工具结果文本里挑 `status`（JSON 结果才有；纯文本结果没有）。 */
export function statusOf(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const status = parsed['status'];
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}
