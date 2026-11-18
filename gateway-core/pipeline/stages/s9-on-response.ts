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
 *
 * ⚠️ fast path 与 D-fastpath-2（2026-11-16 修 §4.4）：fast path 下 S6 只 extractUsage、
 * 不解码响应，本阶段拿不到 canonical 响应。因此 full-canonical（默认档）的响应侧插件在
 * **准入阶段就被禁用 fast path**（与请求侧对称，见 fast-path.ts）；只有显式声明
 * `scope: "envelope-only"` 的插件才可能出现在 fast path 请求里，而它们同样不会被调用——
 * 本阶段为它们记 `onResponse_skipped_fast_path` warning，不静默。
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
      this.reencodeClientBytes(state, res);
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

    // 插件链执行前的快照：用来判断"插件是否真的改写了响应"。
    // 只在**有**响应侧插件时才付这份克隆代价——没有插件时 runOnResponse 原样返回，
    // 克隆纯属浪费（这是每个非流式请求都要走的路径）。
    const responsePlugins = deps.pluginHost.responseSide();
    const hasResponsePlugins = responsePlugins.length > 0;
    const before = hasResponsePlugins && res !== undefined ? structuredClone(res) : undefined;

    if (res !== undefined && !ctx.fast_path) {
      const outcome = await deps.pluginHost.runOnResponse(res, ctx);
      if (isShortCircuit(outcome)) {
        // 流式下 ShortCircuit 不允许（25 §7.1）；非流式下视为改写
        ctx.warn('onResponse_short_circuit_ignored');
      } else if (outcome !== undefined && outcome !== null) {
        res = outcome as CanonicalResponseEnvelope;
      }
    } else if (ctx.fast_path && hasResponsePlugins) {
      // fast path 没有 canonical 响应可给（S6 只 extractUsage，`state.response` 恒为
      // undefined），整条 onResponse 链只能跳过。full-canonical 的响应侧插件已经在 S2
      // 被 D-fastpath-2 拦住、根本不会进 fast path（§4.4 已修，两侧对称）；能走到这里
      // 的只有显式声明 envelope-only 的插件。
      //
      // 但**绝不静默**：插件失效曾经是这条链上最难发现的故障（请求本身完全正常，客户端
      // 拿到正确响应、usage 也记上了，失效的只有插件，没有任何信号）。这里记一条 warning
      // 进 UsageRecord.warnings / RequestTrace.warnings，并打一个 metric——"这个插件这次
      // 没跑"从此在 trace 里看得见。
      const names = responsePlugins.map((p) => p.manifest.name).join(', ');
      ctx.warn('onResponse_skipped_fast_path', names);
      deps.metrics.increment('pipeline.plugin_skipped', 1, {
        hook: 'onResponse',
        reason: 'fast_path',
      });
    }

    state.final_response = res;
    if (res !== undefined) {
      state.usage = res.usage;
      state.finish_reason = res.finish_reason as typeof state.finish_reason;
    } else if (state.usage === undefined) {
      state.usage = emptyUsage('provider');
    }

    this.reencodeClientBytes(state, res);

    // 流式：字节已经在线路上，改写 physically 到不了客户端。**不静默**——
    // 记一条 warning，让"客户端拿到 A、审计看到 B"这件事在 trace 里看得见。
    if (
      state.shallow?.stream === true &&
      before !== undefined &&
      res !== undefined &&
      JSON.stringify(before) !== JSON.stringify(res)
    ) {
      ctx.warn('onResponse_rewrite_ignored_streaming');
    }

    ctx.recordStage(this.id, deps.clock.now() - started);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }

  /**
   * 插件改写响应后，把暂存的客户端字节重新编码一遍。
   *
   * S8 只把「canonical → 客户端格式」的产物暂存在 `state.client_bytes`（还没写给
   * sink，见 types.ts 的说明）。插件链跑完若响应变了，这里必须重编码，否则
   * Runner flush 出去的还是改写前的那份——§4.3 的 bug 只是换了个位置。
   *
   * 流式下 `client_bytes` 恒为 undefined（S8 已逐帧写出），因此本方法自动跳过；
   * 那种情况由调用方的 `onResponse_rewrite_ignored_streaming` warning 交代。
   */
  private reencodeClientBytes(
    state: PipelineState,
    res: CanonicalResponseEnvelope | undefined,
  ): void {
    const buffered = state.client_bytes;
    const clientAdaptor = state.clientAdaptor;
    if (buffered === undefined || res === undefined || clientAdaptor === undefined) return;
    if (state.ctx.fast_path) return; // fast path 直通原始字节，没有 canonical 响应可编码
    state.client_bytes = {
      ...buffered,
      body: JSON.stringify(clientAdaptor.encodeResponse(res, state.ctx)),
    };
  }
}

/** 流式但没有聚合视图时，从事件序列合成一个最小响应信封（供 S9/S10 记账）。 */
export function synthesizeFromEvents(state: PipelineState): CanonicalResponseEnvelope | undefined {
  const events = state.stream_events;
  if (events === undefined || events.length === 0) return undefined;
  const lastUsage = [...events].reverse().find((e) => e.type === 'usage');
  const finish = [...events].reverse().find((e) => e.type === 'finish');
  const finishUsage =
    finish !== undefined &&
    finish.type === 'finish' &&
    finish.usage !== undefined &&
    Object.keys(finish.usage.units).length > 0
      ? finish.usage
      : undefined;
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    request_id: state.ctx.request_id,
    usage:
      finishUsage ??
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
