/**
 * gateway-core/pipeline/stages/s3-on-request.ts —— S3 onRequest 插件链 + provider 默认 builtin tool 注入。
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
 *
 * ## provider 级默认 builtin tool 注入（默认关）
 *
 * provider 配置里可以开「这个渠道的每个请求都默认带上 `web_search` / `url_context`」。
 * 注入走**既有 builtin tool 链路**：往 canonical 的 `params.tools` 里补一个
 * `BuiltinTool`（canonical 稳定名），S4 的 codec 再按 provider 方言映射成
 * `deepseek_web_search` / `deepseek_read_url`——不绕过 canonical，也不在这里碰
 * 任何厂商字段名。
 *
 * 三条约定的理由：
 *   1. **只在该 provider 真的有方言映射时才注入**（问 `providerProfiles`）：给一个
 *      不认这个工具的上游硬塞一个工具定义，上游只会 400，而客户端什么都没要求。
 *   2. **客户端已声明的同名工具不重复注入**：注入是"补默认值"，不是"覆盖客户端"。
 *   3. **注入即关 fast path**：fast path 的合同是透传原始字节，而注入改的是
 *      `tools[]` 结构。这与"别名改写模型名关 fast path"是同一条理由（见 s2-route.ts），
 *      在**消费**判定结果的地方加前置条件，不改 fast-path.ts 本身的任何逻辑。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import type { ShortCircuit } from '../../../ir/index.js';
import { injectDefaultBuiltinTools } from '../../builtin-tool-defaults.js';

export class S3OnRequest implements Stage {
  readonly id = 'S3';
  readonly name = 'onRequest';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;
    const lazy = state.lazy;
    if (lazy === undefined) throw new Error('S3 需要 S1 的惰性请求句柄');

    // ---- provider 级默认 builtin tool 注入（默认关；开着才付物化代价）----
    this.injectProviderBuiltinTools(state, deps);

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
    // S2 路由后把 provider 侧真实 model id 写进信封（ir/envelope.ts 的 resolved_model）：
    // 不写的话 encode 时 body.model 会是**客户端别名**（如 deepseek-flash-messages），
    // 上游对不上模型名直接 400；adaptor 查上游声明的行为约束也依赖这个 id。
    if (req.resolved_model === undefined) req.resolved_model = ctx.route.model;
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

  /**
   * provider 级默认 builtin tool 注入。
   *
   * 顺序在插件链**之前**：插件看到的 canonical 应该是"最终要发出去的形态"，
   * 否则一个想改 tools[] 的插件看不到默认注入的那两个工具，而它下一次保存就把
   * 注入结果覆盖没了——那种 bug 在 UI 上完全看不出来。
   *
   * 没有开任何开关时**不物化 canonical**（保持 fast path 零解码代价）：这一条把
   * "开着开关"与"关着开关"的成本差异做到极小——关着时这条路径等于不存在。
   */
  private injectProviderBuiltinTools(state: PipelineState, deps: PipelineDeps): void {
    const { ctx } = state;
    const lazy = state.lazy;
    if (lazy === undefined) return;
    const defaults = deps.providerDefaults?.builtinToolsFor(ctx.route.provider);
    if (defaults === undefined) return;

    const profile = deps.providerProfiles?.forAccessPath(ctx.route.access_path);
    const supported = (['web_search', 'url_context'] as const).filter(
      (name) => profile?.builtinToolWire?.(name, ctx.provider_format) !== undefined,
    );
    const wanted = supported.filter((name) => defaults[name] === true);
    if (wanted.length === 0) return;

    // 到这里才物化：注入必须改 canonical 的 tools[]
    const req = state.canonical_override ?? lazy.full();
    if (req.resolved_model === undefined) req.resolved_model = ctx.route.model;
    const injected = injectDefaultBuiltinTools(req, wanted);
    state.canonical = req;
    state.materialized = true;

    if (injected.length > 0) {
      // 注入改写了请求结构 → fast path 必须失效（同 s2-route.ts 的别名改写立场）
      if (ctx.fast_path) ctx.disableFastPath('provider_default_builtin_tools');
      ctx.state['injected_builtin_tools'] = injected;
      deps.metrics.increment('pipeline.builtin_tool_injected', injected.length, {
        provider: ctx.route.provider,
      });
    }
  }
}

function isShortCircuit(value: unknown): value is ShortCircuit {
  return typeof value === 'object' && value !== null && 'short_circuit' in value;
}
