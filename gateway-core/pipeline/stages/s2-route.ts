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

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import { isFastPathEligible } from '../fast-path.js';
import { createCanonicalError } from '../../../ir/index.js';
import { applyRouteParamOverrides } from '../../routing-engine.js';

export class S2Route implements Stage {
  readonly id = 'S2';
  readonly name = 'Route';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const shallow = state.shallow;
    if (shallow === undefined || state.lazy === undefined) {
      throw new Error('S2 需要 S1 的浅解析产物');
    }

    if (ctx.auth.allow_streaming === false && shallow.stream === true) {
      throw createCanonicalError(
        'auth_failed',
        '该 key 不允许使用流式响应',
        ctx.request_id,
        { http_status: 403 },
      );
    }

    if (deps.router.needsCanonical?.(shallow.model) === true && state.canonical === undefined) {
      state.canonical = state.lazy.full();
      state.materialized = true;
    }

    const result = deps.router.resolve(
      {
        model: shallow.model,
        modality: state.modality,
        stream: shallow.stream,
        on_unsupported: deps.config.lossPolicy === 'strict' ? 'error' : 'allow',
        ...(state.canonical === undefined ? {} : { canonical: state.canonical }),
      },
      ctx,
    );

    if (!result.ok) {
      throw result.error;
    }

    // ---- provider 白名单（66 §2.1 的 `providers` 限制）----
    //
    // 为什么在 S2 而不是 S0：provider 只有路由之后才知道（S0 时机拿不到）。
    // 模型白名单已经在 S0 判过了（20 §S0 第 2 条：不进 S1），provider 白名单
    // 只能在这里补——代价是这类请求多付一次浅解析，而它们本来就会被拒。
    const allowedProviders = ctx.auth.allowed_providers;
    if (
      allowedProviders !== undefined &&
      allowedProviders.length > 0 &&
      !allowedProviders.includes(result.route.provider)
    ) {
      throw createCanonicalError(
        'auth_failed',
        `该 key 不允许使用 provider ${result.route.provider}`,
        ctx.request_id,
        { http_status: 403 },
      );
    }

    ctx.route = result.route;
    ctx.provider_format = result.route.provider_format;
    ctx.state['route_capability'] = result.capability;
    state.route_ready = true;

    const primaryOverrides = result.route.attempt_plan[0]?.overrides;
    if (result.route.route_graph_id !== undefined || primaryOverrides !== undefined) {
      if (state.canonical === undefined) {
        state.canonical = state.lazy.full();
        state.materialized = true;
      }
      state.base_canonical = JSON.parse(JSON.stringify(state.canonical)) as typeof state.canonical;
      if (primaryOverrides !== undefined) {
        state.canonical = applyRouteParamOverrides(state.base_canonical, primaryOverrides);
        state.canonical_override = state.canonical;
      }
    }

    // fast path 判定：§4.1 四条件 + D-fastpath-2 插件准入
    const rawBodyAvailable = state.lazy.raw.byteLength > 0;
    let eligible = isFastPathEligible(ctx, result.route, deps.fastPathAdmission, rawBodyAvailable);
    if (eligible && (result.route.route_graph_id !== undefined || primaryOverrides !== undefined)) {
      eligible = false;
      ctx.state['fast_path_disabled_reason'] = 'route_graph';
    }

    // ---- 别名改写模型名 → fast path 必须失效 ----
    //
    // **为什么**：fast path 的合同是「透传原始字节，不做任何结构转换 / 字段
    // 重命名 / 类型强转」（fast-path.ts 的 FAST_PATH_FORBIDDEN）。而别名解析
    // （S2 第 1 步）会把客户端传的 `model` 换成上游真实 model id——这个改写
    // 只发生在 S4 的**慢路径**编码里，fast path 压根不会做。
    //
    // 于是「客户端格式 == 上游格式 + 用了别名」这个最普通的组合会静默把
    // **别名原样**发给上游：客户端拿到一个莫名的 400（上游不认识这个模型名），
    // 而网关侧 trace 显示一切正常。这是最难查的一类 bug。
    //
    // 处置：只要本次请求的模型名被改写（客户端名 ≠ 解析出的上游名），就明确
    // 关掉 fast path 走完整编码。代价是这些请求多付一次编解码——正确性优先，
    // 且走别名的请求量级远小于直连真实 model id 的请求。
    //
    // 注意这**不改 fast-path.ts 的任何逻辑**，只是在消费判定结果的地方加一条
    // 前置条件（同 D-fastpath-2 的插件准入在 S2 被消费的立场）。
    if (eligible && shallow.model !== result.route.model) {
      eligible = false;
      ctx.state['fast_path_disabled_reason'] = 'alias_rewrote_model';
    }

    ctx.fast_path = eligible;
    if (!eligible) {
      const reason =
        deps.fastPathAdmission.reason() ??
        (ctx.client_format !== result.route.provider_format
          ? `客户端格式 ${ctx.client_format} ≠ 上游格式 ${result.route.provider_format}`
          : '路由未标记 fast_path_eligible');
      ctx.state['fast_path_disabled_reason'] = reason;
    }

    // 记录实际走过的转换链（20 §S4）
    state.conversion_chain = [ctx.client_format, ctx.provider_format];

    ctx.recordStage(this.id, deps.clock.now() - started, `fast_path=${String(eligible)}`);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
    deps.metrics.increment('pipeline.fast_path', 1, { enabled: String(eligible) });
  }
}
