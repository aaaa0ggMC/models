/**
 * gateway-core/pipeline/stages/s10-usage-emitter.ts —— S10 UsageEmitter。
 *
 * 职责（20 §S10）：产出 UsageRecord 写入内存队列 → 批量刷到存储。
 *
 * 硬约束（逐条落地）：
 *   - **永不抛异常影响主链路**；队列满时按 drop_policy（默认丢弃最旧 + 计数告警）；
 *   - 异步、批量、可重放；
 *   - 旁路，**插件不参与**（20 §2 阶段表）。
 *
 * 本阶段同时把 RequestTrace 补齐（20 §8），它是 dog-fooding agent 的主要数据面之一。
 */

import type { PipelineDeps, PipelineState, Stage } from "../types.js";
import { createUsageRecord, type ToolCallUsage } from "../../../metering/usage-record.js";
import type { UsageRecord } from "../../../metering/usage-record.js";

export class S10UsageEmitter implements Stage {
  readonly id = "S10";
  readonly name = "UsageEmitter";

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;

    const toolCalls: ToolCallUsage[] = [];
    const traceTools = (ctx.state["trace"] as Array<{ tool: string; duration_ms: number; ok: boolean }>) ?? [];
    for (const t of traceTools) {
      toolCalls.push({ name: t.tool, ok: t.ok, duration_ms: t.duration_ms });
    }

    const record: UsageRecord = createUsageRecord({
      request_id: ctx.request_id,
      ...(ctx.trace_id === undefined ? {} : { trace_id: ctx.trace_id }),
      ts: deps.clock.now(),
      auth: {
        key_id: ctx.auth.key_id,
        ...(ctx.auth.team_id === undefined ? {} : { team_id: ctx.auth.team_id }),
        ...(ctx.auth.user_id === undefined ? {} : { user_id: ctx.auth.user_id }),
      },
      client_format: ctx.client_format,
      provider: ctx.route.provider,
      provider_format: ctx.provider_format,
      model: ctx.route.model,
      model_alias: state.shallow?.model,
      fast_path: ctx.fast_path,
      attempts: ctx.route.attempt_plan.length,
      stream: state.shallow?.stream === true,
      ttfb_ms: state.ttfb_ms ?? 0,
      total_ms: deps.clock.now() - ctx.started_at,
      status: state.status ?? "success",
      finish_reason: state.finish_reason,
      usage: state.usage,
      usage_raw: state.usage?.raw,
      warnings: ctx.warnings,
      dropped_capabilities: state.dropped_capabilities,
      error_code: state.error?.code,
      tool_calls: toolCalls,
      agentic_turns: state.turns,
    });

    // 补齐 RequestTrace（20 §8）
    state.trace.fast_path = ctx.fast_path;
    state.trace.attempts = [
      {
        provider: ctx.route.provider,
        model: ctx.route.model,
        status: state.upstream_status ?? 0,
        ttfb_ms: state.ttfb_ms ?? 0,
        total_ms: deps.clock.now() - ctx.started_at,
        ...(state.error === undefined ? {} : { error: state.error.code }),
      },
    ];
    state.trace.stages = ctx.metrics;
    state.trace.usage = state.usage ?? record.usage;
    state.trace.finish_reason = state.finish_reason === "final" ? "stop" : (state.finish_reason ?? "stop");
    state.trace.warnings = ctx.warnings;
    state.trace.dropped_capabilities = state.dropped_capabilities;
    state.trace.conversion_chain = state.conversion_chain;
    state.trace.turn_count = state.turns;
    state.trace.tool_calls = toolCalls;

    // 发射：永不抛（S10 的语义）
    deps.usageEmitter.emit(record);

    ctx.recordStage(this.id, deps.clock.now() - started, `depth=${deps.usageEmitter.depth()}`);
    deps.metrics.increment("pipeline.stage", 1, { stage: this.id });
    deps.metrics.gauge("metering.queue_depth", deps.usageEmitter.depth());
    if (deps.usageEmitter.dropped() > 0) {
      deps.metrics.increment("metering.dropped", deps.usageEmitter.dropped());
    }
  }
}
