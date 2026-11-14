/**
 * gateway-core/pipeline/stages/s9-on-response.ts —— S9 onResponse。
 *
 * 职责（20 §S9）：后置插件（审计、脱敏、指标）。
 *
 * 关键约束（20 §S9）：流式下本阶段在流关闭后执行，**不再影响已发出的内容**，
 * 只能做记录与副作用。非流式时在编码前执行（插件可改写响应）。
 *
 * 插件短路语义（30 §3）：S3 的 ShortCircuit 直达 S9，此时 `onResponse` 仍执行，
 * 让审计类插件看到这次请求。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type { CanonicalResponseEnvelope, ShortCircuit } from '../../../ir/index.js';
import { emptyUsage } from '../../../ir/index.js';

export class S9OnResponse implements Stage {
  readonly id = 'S9';
  readonly name = 'onResponse';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;

    // S3 短路：合成响应直接进 S9
    if (state.short_circuit_response !== undefined) {
      let res = state.short_circuit_response;
      const outcome = await deps.pluginHost.runOnResponse(res, ctx);
      if (!isShortCircuit(outcome) && outcome !== undefined && outcome !== null) {
        res = outcome as CanonicalResponseEnvelope;
      }
      state.final_response = res;
      state.usage = res.usage;
      state.finish_reason = res.finish_reason as typeof state.finish_reason;
      ctx.recordStage(this.id, deps.clock.now() - started, 'short_circuit');
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, result: 'short_circuit' });
      return;
    }

    if (state.short_circuit_error !== undefined) {
      ctx.recordStage(this.id, deps.clock.now() - started, 'short_circuit_error');
      deps.metrics.increment('pipeline.stage', 1, {
        stage: this.id,
        result: 'short_circuit_error',
      });
      return;
    }

    // 流式：S7 的聚合视图（若插件声明了 needs:"aggregate"）；否则用 S6 的响应
    let res: CanonicalResponseEnvelope | undefined =
      state.aggregated ?? state.response ?? synthesizeFromEvents(state);

    if (res !== undefined && !ctx.fast_path) {
      const outcome = await deps.pluginHost.runOnResponse(res, ctx);
      if (isShortCircuit(outcome)) {
        // 流式下 ShortCircuit 不允许（25 §7.1）；非流式下视为改写
        ctx.warn('onResponse_short_circuit_ignored');
      } else if (outcome !== undefined && outcome !== null) {
        res = outcome as CanonicalResponseEnvelope;
      }
    }

    state.final_response = res;
    if (res !== undefined) {
      state.usage = res.usage;
      state.finish_reason = res.finish_reason as typeof state.finish_reason;
    } else if (state.usage === undefined) {
      state.usage = emptyUsage('provider');
    }

    ctx.recordStage(this.id, deps.clock.now() - started);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }
}

/** 流式但没有聚合视图时，从事件序列合成一个最小响应信封（供 S9/S10 记账）。 */
export function synthesizeFromEvents(state: PipelineState): CanonicalResponseEnvelope | undefined {
  const events = state.stream_events;
  if (events === undefined || events.length === 0) return undefined;
  const lastUsage = [...events].reverse().find((e) => e.type === 'usage');
  const finish = [...events].reverse().find((e) => e.type === 'finish');
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    request_id: state.ctx.request_id,
    usage:
      (finish !== undefined && finish.type === 'finish' ? finish.usage : undefined) ??
      (lastUsage !== undefined && lastUsage.type === 'usage' ? lastUsage.usage : undefined) ??
      emptyUsage('provider'),
    finish_reason:
      (finish !== undefined && finish.type === 'finish' ? finish.finish_reason : 'stop') ?? 'stop',
    payload: { message: { role: 'assistant', parts: [] } },
    warnings: [],
    raw: {},
  };
}

function isShortCircuit(value: unknown): value is ShortCircuit {
  return typeof value === 'object' && value !== null && 'short_circuit' in value;
}
