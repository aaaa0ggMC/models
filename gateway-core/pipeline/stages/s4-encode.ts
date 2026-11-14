/**
 * gateway-core/pipeline/stages/s4-encode.ts —— S4 Encode（canonical → 上游格式）。
 *
 * 职责（20 §S4）：provider codec 编码；fast path 时输出原始字节。
 *
 * 非 fast path 时（20 §S4，逐条落地）：
 *   - 按 10 §9 的字段映射表逐字段转换；
 *   - 目标格式不支持的 canonical 能力 → 按 loss_policy 三档处置；
 *   - **转换诊断是一等公民**，进响应信封 degraded[] 与 RequestTrace，不允许只打日志；
 *   - 记录 conversion_chain；
 *   - 反向 passthrough：canonical 的 raw.unmapped 若带 source_format == provider_format，
 *     则原样写回请求体（同一格式互转时的无损保证）。
 *
 * ⚠️ D-fastpath-1：**非 fast path 时本阶段触发完整 canonical 物化**。
 * fast path 时**不物化**——直接用 S1 保留的原始字节透传。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type { EncodedRequest } from '../../../adaptors/types.js';
import { createCanonicalError } from '../../../ir/index.js';

export class S4Encode implements Stage {
  readonly id = 'S4';
  readonly name = 'Encode';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const lazy = state.lazy;
    if (lazy === undefined) throw new Error('S4 需要 S1 的惰性请求句柄');

    const providerAdaptor = deps.adaptors.find(ctx.provider_format, state.modality);
    if (providerAdaptor === undefined) {
      throw createCanonicalError(
        'capability_unsupported',
        `上游格式 ${ctx.provider_format} 没有适配 ${state.modality} 模态的 adaptor`,
        ctx.request_id,
      );
    }
    state.providerAdaptor = providerAdaptor;

    if (ctx.fast_path) {
      // fast path：透传原始字节，**不物化 canonical**（D-fastpath-1）
      const rawBytes = lazy.raw;
      const encoded: EncodedRequest = {
        body: undefined,
        raw_bytes: rawBytes,
        fast_path: true,
        path: state.shallow?.default_path ?? '/v1/chat/completions',
      };
      state.encoded = encoded;
      ctx.recordStage(
        this.id,
        deps.clock.now() - started,
        'fast_path:passthrough',
        rawBytes.byteLength,
      );
      deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'fast_path' });
      return;
    }

    // 慢路径：物化完整 canonical 后编码（D-fastpath-1 的第二个物化触发点）
    const req = state.canonical_override ?? lazy.full();
    state.canonical = req;
    state.materialized = true;

    const encoded = providerAdaptor.encode(req, ctx);
    state.encoded = encoded;
    if (encoded.diagnostics !== undefined) {
      state.diagnostics.push(...encoded.diagnostics);
    }
    for (const w of encoded.warnings ?? []) ctx.warn(w);
    for (const d of encoded.dropped ?? []) {
      state.dropped_capabilities.push(d);
    }

    ctx.recordStage(
      this.id,
      deps.clock.now() - started,
      `slow:${ctx.client_format}->${ctx.provider_format}`,
    );
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id, mode: 'slow' });
  }
}
