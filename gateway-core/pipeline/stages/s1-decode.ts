/**
 * gateway-core/pipeline/stages/s1-decode.ts —— S1 Decode（客户端格式 → canonical）。
 *
 * 职责（20 §S1）：客户端格式 codec 解码；产物带 source_format。
 * 硬性要求：**不允许丢字段**（未建模顶层键必须进 raw.unmapped）；遇到未知 part 类型
 * 降级为 UnknownPart 而不是报错；解码失败返回 canonical_decode_error。
 *
 * ⚠️ D-fastpath-1（仓库主人拍板）：本阶段**只做浅解析**——解析「信封 + 路由必需字段」，
 * 不物化完整 canonical。完整物化推迟到 S3（有请求侧插件）/ S4（非 fast path）/
 * S6（非 fast path）。浅解析产物见 lazy-decode.ts 的 ROUTING_REQUIRED_FIELDS。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import { createCanonicalError } from '../../../ir/index.js';
import { LazyRequest, shallowDecode } from '../lazy-decode.js';

export class S1Decode implements Stage {
  readonly id = 'S1';
  readonly name = 'Decode';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx, input } = state;

    const adaptor = deps.adaptors.find(ctx.client_format, state.modality);
    if (adaptor === undefined) {
      throw createCanonicalError(
        'capability_unsupported',
        `客户端格式 ${ctx.client_format} 没有适配 ${state.modality} 模态的 adaptor。` +
          'adaptor 按需写（40 §1.0），缺失说明该组合尚未实现。',
        ctx.request_id,
      );
    }
    state.clientAdaptor = adaptor;

    let shallow;
    try {
      shallow = shallowDecode(adaptor, input.raw_body, ctx, state.modality);
    } catch (err) {
      throw createCanonicalError(
        'canonical_decode_error',
        `S1 浅解析失败: ${err instanceof Error ? err.message : String(err)}`,
        ctx.request_id,
        { field_path: '$' },
      );
    }
    state.shallow = shallow;

    // 保留原始字节引用（fast path 判定条件 4：client_raw_body_available）
    ctx.state['raw_body'] = input.raw_body;

    state.lazy = new LazyRequest(shallow, input.raw_body, adaptor, ctx);

    ctx.recordStage(
      this.id,
      deps.clock.now() - started,
      adaptor.decodeEnvelope === undefined ? 'shallow(generic)' : 'shallow(codec)',
      input.raw_body.byteLength,
    );
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
    deps.metrics.increment('pipeline.lazy_decode', 1, {
      codec_shallow: String(adaptor.decodeEnvelope !== undefined),
    });
  }
}
