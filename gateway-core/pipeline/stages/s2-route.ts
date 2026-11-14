/**
 * gateway-core/pipeline/stages/s2-route.ts —— S2 Route。
 *
 * 职责（20 §S2）：别名解析、provider 候选列表、健康/熔断过滤、fast path 判定、
 * 参数兼容性预检、预算预检、sticky 会话键。
 *
 * ⚠️ D-fastpath-2（仓库主人拍板）：fast path 准入 = 「没有启用任何 scope 为
 * full-canonical 的请求侧插件」。该条件由组合根在启动时计算并缓存
 * （见 fast-path.ts 的 createFastPathAdmission），运行中增删插件自动失效重算。
 * 本阶段只做**消费**，不重新计算。
 */

import type { PipelineDeps, PipelineState, Stage } from "../types.js";
import { isFastPathEligible } from "../fast-path.js";

export class S2Route implements Stage {
  readonly id = "S2";
  readonly name = "Route";

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const shallow = state.shallow;
    if (shallow === undefined || state.lazy === undefined) {
      throw new Error("S2 需要 S1 的浅解析产物");
    }

    const result = deps.router.resolve(
      {
        model: shallow.model,
        modality: state.modality,
        stream: shallow.stream,
        on_unsupported: deps.config.lossPolicy === "strict" ? "error" : "allow",
      },
      ctx,
    );

    if (!result.ok) {
      throw result.error;
    }

    ctx.route = result.route;
    ctx.provider_format = result.route.provider_format;
    ctx.state["route_capability"] = result.capability;
    state.route_ready = true;

    // fast path 判定：§4.1 四条件 + D-fastpath-2 插件准入
    const rawBodyAvailable = state.lazy.raw.byteLength > 0;
    const eligible = isFastPathEligible(ctx, result.route, deps.fastPathAdmission, rawBodyAvailable);
    ctx.fast_path = eligible;
    if (!eligible) {
      const reason =
        deps.fastPathAdmission.reason() ??
        (ctx.client_format !== result.route.provider_format
          ? `客户端格式 ${ctx.client_format} ≠ 上游格式 ${result.route.provider_format}`
          : "路由未标记 fast_path_eligible");
      ctx.state["fast_path_disabled_reason"] = reason;
    }

    // 记录实际走过的转换链（20 §S4）
    state.conversion_chain = [ctx.client_format, ctx.provider_format];

    ctx.recordStage(this.id, deps.clock.now() - started, `fast_path=${String(eligible)}`);
    deps.metrics.increment("pipeline.stage", 1, { stage: this.id });
    deps.metrics.increment("pipeline.fast_path", 1, { enabled: String(eligible) });
  }
}
