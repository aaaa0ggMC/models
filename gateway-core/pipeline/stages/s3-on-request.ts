/**
 * gateway-core/pipeline/stages/s3-on-request.ts —— S3 onRequest 插件链。
 *
 * 职责（20 §S3）：按注册顺序执行插件链（压缩、注入、改写、短路返回）。
 *
 * 要点（20 §S3，逐条落地）：
 *   - 插件只能看到 canonical + RequestContext，看不到任何厂商原始 body；
 *   - 插件可返回 ShortCircuit 直接给出应答，此时跳过 S4–S8 直达 S9；
 *   - 插件可设置 ctx.state.<key> 供后续阶段读取；
 *   - 插件抛异常默认不阻断请求（记 metric + warning），fatal: true 时阻断；
 *   - 单个插件超时（默认 5s）视为失败并按上述策略处理。
 *
 * ⚠️ D-fastpath-1：**有请求侧插件时本阶段触发完整 canonical 物化**——这是"插件只面对
 * canonical"硬约束的直接后果：插件拿不到浅解析产物，只有完整 canonical。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type { ShortCircuit } from '../../../ir/index.js';

export class S3OnRequest implements Stage {
  readonly id = 'S3';
  readonly name = 'onRequest';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const lazy = state.lazy;
    if (lazy === undefined) throw new Error('S3 需要 S1 的惰性请求句柄');

    // D-fastpath-1：**只有存在请求侧插件时**才物化完整 canonical。
    // 没有插件时本阶段是纯 no-op——这是 fast path 不付完整解码代价的关键一环
    // （长上下文大请求体在 fast path 下也不该为"一个空插件链"付出全量解码）。
    const requestSidePlugins = deps.pluginHost.requestSide();
    if (requestSidePlugins.length === 0) {
      ctx.recordStage(this.id, deps.clock.now() - started, 'no-request-side-plugin');
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, result: 'noop' });
      return;
    }

    let req = state.canonical_override ?? lazy.full();
    state.canonical = req;
    state.materialized = true;

    const outcome = await deps.pluginHost.runOnRequest(req, ctx);

    if (isShortCircuit(outcome)) {
      const sc = outcome as ShortCircuit;
      state.short_circuit_response = sc.response;
      state.short_circuit_error = sc.error;
      ctx.recordStage(this.id, deps.clock.now() - started, `short_circuit:${sc.reason}`);
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, result: 'short_circuit' });
      return;
    }

    // 插件可能改写了 canonical：标记被改写过的路径（10 §7.2 的"未被改动"判定）
    const rewritten = outcome as typeof req;
    if (rewritten !== req) {
      ctx.state['rewritten_paths'] = [
        ...((ctx.state['rewritten_paths'] as string[]) ?? []),
        'messages',
      ];
      // 插件改写了内容 → 关闭 fast path（20 §4.1 第三条）
      if (ctx.fast_path) ctx.disableFastPath('plugin rewrote canonical');
      state.canonical = rewritten;
      req = rewritten;
      state.materialized = true;
    }

    ctx.recordStage(
      this.id,
      deps.clock.now() - started,
      `plugins=${deps.pluginHost.requestSide().length}`,
    );
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }
}

function isShortCircuit(value: unknown): value is ShortCircuit {
  return typeof value === 'object' && value !== null && 'short_circuit' in value;
}
