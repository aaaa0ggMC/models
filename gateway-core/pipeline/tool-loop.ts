/**
 * gateway-core/pipeline/tool-loop.ts —— 网关 agentic loop（工具调用多轮循环）。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §5（两种循环归属 + §5.2 状态机）。
 *
 * 状态机（20 §5.2）：
 *   IDLE → WAIT_MODEL → COLLECT_TOOL_USE →（有 tool_use?）→ EXECUTE_TOOLS → APPEND_TURN → WAIT_MODEL …
 *                                     └（无）→ DONE → S9/S10
 *
 * 要点（逐条落地）：
 *   - **暂存与回填**：模型回合的 tool_use part 必须先完整暂存（流式下靠 part.end 保证
 *     JSON 完整），不能边收边执行；
 *   - **id 映射**：canonical 的 ToolUsePart.id 是权威 id，provider 侧 id 映射表存
 *     ctx.state.tool_id_map；
 *   - **max_turns**：默认 10，超出返回 agentic_loop_exceeded 并带上已有中间 canonical；
 *   - **onToolCall**：仅网关循环模式下触发，在每次工具执行前后各一次（20 §2 / 30 §3）。
 *
 * Phase 1 边界：工具**执行器**由插件（`onToolCall`）或内置执行器提供；本文件只做循环编排，
 * 不实现任何具体工具（内置搜索是 Phase 4）。
 */

import type {
  CanonicalMessage,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  Part,
  RequestContext,
  ToolResultPart,
  ToolUsePart,
} from '../../ir/index.js';
import { CTX_STATE_KEYS, asChatPayload, asChatResponsePayload } from '../../ir/index.js';
import type { PluginHost } from '../../plugins/host.js';

/** 工具执行器：插件（onToolCall）或内置执行器。 */
export interface ToolExecutor {
  execute(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart>;
}

export interface ToolLoopResult {
  /** 最终响应（可能经过多轮）。 */
  response: CanonicalResponseEnvelope;
  /** 实际轮数。 */
  turns: number;
  /** 是否触达 max_turns 上限。 */
  exceeded: boolean;
  /** 中间轮次的 canonical 摘要（进 ctx.state.trace，用于计费归属与调试）。 */
  turn_summaries: Array<{ turn: number; tool_calls: string[] }>;
}

export interface ToolLoopDeps {
  pluginHost: PluginHost;
  /** 发一轮请求（S4→S8 的一次完整执行），由 Runner 提供。 */
  runTurn(req: CanonicalRequestEnvelope, ctx: RequestContext): Promise<CanonicalResponseEnvelope>;
  /** 没有 onToolCall 插件时的兜底执行器（可缺省）。 */
  fallbackExecutor?: ToolExecutor;
}

/** 从响应里收集完整成型的 tool_use part（流式下由 part.end 保证 JSON 完整）。 */
export function collectToolUses(res: CanonicalResponseEnvelope): ToolUsePart[] {
  const payload = asChatResponsePayload(res);
  if (payload === undefined) return [];
  return payload.message.parts.filter((p): p is ToolUsePart => p.type === 'tool_use');
}

/** 把 assistant 回合与 tool_result 回合追加进 canonical.messages（APPEND_TURN）。 */
export function appendTurn(
  req: CanonicalRequestEnvelope,
  assistantMessage: CanonicalMessage,
  results: ToolResultPart[],
): CanonicalRequestEnvelope {
  const payload = asChatPayload(req);
  if (payload === undefined) return req;
  const toolMessage: CanonicalMessage = {
    role: 'tool',
    parts: results,
  };
  return {
    ...req,
    payload: {
      ...payload,
      messages: [...payload.messages, assistantMessage, toolMessage],
    },
  };
}

/**
 * 跑网关 agentic loop。
 *
 * 循环归属（20 §5.1）：只有 `gateway.agentic_loop === true`（或客户端格式为 Responses
 * 且带 tools 且 provider 无原生工具执行）时才进这里；客户端循环模式下网关看不到
 * 工具执行，**不触发 onToolCall**。
 */
export async function runToolLoop(
  initialReq: CanonicalRequestEnvelope,
  ctx: RequestContext,
  deps: ToolLoopDeps,
  maxTurns: number,
): Promise<ToolLoopResult> {
  let req = initialReq;
  const turnSummaries: Array<{ turn: number; tool_calls: string[] }> = [];
  let turns = 0;

  for (;;) {
    const response = await deps.runTurn(req, ctx);
    turns += 1;

    const toolUses = collectToolUses(response);
    if (toolUses.length === 0) {
      return { response, turns, exceeded: false, turn_summaries: turnSummaries };
    }

    if (turns >= maxTurns) {
      return {
        response,
        turns,
        exceeded: true,
        turn_summaries: turnSummaries,
      };
    }

    // EXECUTE_TOOLS：每个 tool_use 产出 tool_result part
    const results: ToolResultPart[] = [];
    const executor: ToolExecutor = deps.fallbackExecutor ?? {
      execute: async (call, c) => deps.pluginHost.runOnToolCall(call, c),
    };

    for (const call of toolUses) {
      const started = Date.now();
      let ok = true;
      let result: ToolResultPart;
      try {
        result = await executor.execute(call, ctx);
      } catch (err) {
        ok = false;
        result = {
          type: 'tool_result',
          tool_use_id: call.id,
          content: `工具 ${call.name} 执行失败: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
      results.push(result);
      ctx.state[CTX_STATE_KEYS.TRACE] = [
        ...((ctx.state[CTX_STATE_KEYS.TRACE] as unknown[]) ?? []),
        { turn: turns, tool: call.name, duration_ms: Date.now() - started, ok },
      ];
    }

    turnSummaries.push({ turn: turns, tool_calls: toolUses.map((t) => t.name) });

    // APPEND_TURN
    const assistantPayload = asChatResponsePayload(response);
    if (assistantPayload === undefined) {
      return { response, turns, exceeded: false, turn_summaries: turnSummaries };
    }
    req = appendTurn(req, assistantPayload.message, results);
  }
}

/**
 * 判断本次请求是否走网关循环（20 §5.1 的触发条件）。
 *
 * Phase 1 只实现 `ag_agentic_loop: true` 这一条显式开关；Responses 入站 + tools +
 * provider 无原生工具执行这一条要等能力矩阵补全 streaming/executor 声明后再接。
 */
export function shouldUseGatewayLoop(req: CanonicalRequestEnvelope): boolean {
  return req.gateway?.agentic_loop === true;
}

/** 从 ctx.state.tool_id_map 维护 provider 侧 id ↔ canonical id 的映射（20 §5.2）。 */
export class ToolIdMap {
  private readonly canonicalToProvider = new Map<string, string>();
  private readonly providerToCanonical = new Map<string, string>();

  put(canonicalId: string, providerId: string): void {
    this.canonicalToProvider.set(canonicalId, providerId);
    this.providerToCanonical.set(providerId, canonicalId);
  }

  providerIdFor(canonicalId: string): string | undefined {
    return this.canonicalToProvider.get(canonicalId);
  }

  canonicalIdFor(providerId: string): string | undefined {
    return this.providerToCanonical.get(providerId);
  }
}

/** 把 ToolIdMap 挂到 ctx.state（Runner 在 S4 前后调用）。 */
export function toolIdMapFrom(ctx: RequestContext): ToolIdMap {
  let map = ctx.state[CTX_STATE_KEYS.TOOL_ID_MAP] as ToolIdMap | undefined;
  if (map === undefined) {
    map = new ToolIdMap();
    ctx.state[CTX_STATE_KEYS.TOOL_ID_MAP] = map;
  }
  return map;
}

/** 判断 part 是否为工具调用（供 runner 统计 tool_calls）。 */
export function isToolUse(part: Part): part is ToolUsePart {
  return part.type === 'tool_use';
}
