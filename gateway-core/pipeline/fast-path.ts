/**
 * gateway-core/pipeline/fast-path.ts —— fast path 判定与准入。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §4（判定条件 / 做什么不做什么 / usage 口径修正）。
 *
 * 两条仓库主人拍板（issue #8 第 3 条，2026-11）：
 *
 * **D-fastpath-1（惰性解码）**：S1 只解析「信封 + 路由必需字段」；完整 canonical 物化
 * 推迟到真正需要它的阶段——S3 插件链（有请求侧插件时）、S4 Encode（非 fast path 时）、
 * S6 ProviderDecode（非 fast path 时）。fast path 下响应侧只抽取 usage 信封并直通原始字节。
 * 动机：长上下文大请求体在 fast path 下也付完整解码代价，与「附加延迟 < 3ms p99」冲突。
 *
 * **D-fastpath-2（fast path 准入）**：fast path 仅在「没有启用需要完整 canonical 的插件」时
 * 可用，**请求侧与响应侧对称**（2026-11-16 修订，修 PLUGIN-SYSTEM-REPORT.md §4.4）。
 * 插件 manifest 声明 `scope: "envelope-only" | "full-canonical"`；只要有一个已启用的
 * full-canonical 插件挂在**请求侧（onRequest）或响应侧（onResponse / onStreamChunk）**上，
 * 就不允许走 fast path。
 *
 * 为什么响应侧也要拦：fast path 对两侧都是「没有 canonical」——请求侧只有 S1 的浅解析信封，
 * 响应侧 S6 只 `extractUsage` 不解码响应。只拦请求侧的话，一个**只声明 onResponse** 的
 * 审计 / 脱敏插件（最常见的形态）会在 fast path 下被静默跳过：不报错、不告警，只是从来没
 * 运行。D-fastpath-2 原先只写请求侧，是遗漏而非决定。
 * `onError` / `onToolCall` 不参与准入：前者收 CanonicalError，后者只在网关 agentic loop
 * 里跑（loop 本身就会关掉 fast path），都不依赖 canonical 物料化。
 *
 * 显式声明 `envelope-only` 的插件不拦 fast path，但它们在 fast path 下也拿不到 canonical
 * 响应，因此同样不会被调用——S7 / S9 会为它们记 warning（`onStreamChunk_skipped_fast_path`
 * / `onResponse_skipped_fast_path`），不静默。
 *
 * 该条件由配置/组合根在启动时计算并缓存，运行中增删插件要能失效重算。
 *
 * §4.1 的四个判定条件在这里落成代码：
 *   1. ctx.client_format === ctx.provider_format
 *   2. route.provider === 该格式的参考实现（或显式声明兼容）
 *   3. !ctx.state.requires_structural_change（插件有权关闭）
 *   4. ctx.client_raw_body_available（保留了原始字节）
 */

import type { PluginHost } from '../../plugins/host.js';
import type { Plugin, RequestContext } from '../../ir/index.js';
import type { ResolvedRoute } from '../../ir/index.js';
import { effectivePluginScope } from '../../ir/index.js';

/** fast path 准入判定器。结果被缓存，插件增减时失效重算（D-fastpath-2）。 */
export interface FastPathAdmission {
  /** 当前是否允许 fast path。 */
  allowed(): boolean;
  /** 不允许时的原因（进 trace / 观测"多少请求因为插件/能力不支持走了转换"）。 */
  reason(): string | undefined;
  /** 使缓存失效（运行中增删插件后调用）。 */
  invalidate(): void;
}

/**
 * 由组合根在启动时创建一次并缓存。
 *
 * 为什么在这里算而不在每请求算：准入要遍历插件表，每请求做一次是纯浪费；而插件表在运行中
 * 会变，所以必须能失效。
 */
export function createFastPathAdmission(pluginHost: PluginHost): FastPathAdmission {
  let cached: { allowed: boolean; reason: string | undefined } | undefined;

  const compute = (): { allowed: boolean; reason: string | undefined } => {
    // 早退（也是 PluginHost 上两个 hasFullCanonical* 判据的存在理由）：两侧都没有
    // full-canonical 插件时，连名字都不必收集。
    if (!pluginHost.hasFullCanonicalRequestSide() && !pluginHost.hasFullCanonicalResponseSide()) {
      return { allowed: true, reason: undefined };
    }
    // 两侧分开收集：请求侧（onRequest）与响应侧（onResponse / onStreamChunk）对称，
    // 但 reason 要能说清"是谁拦的"——观测"多少请求因为插件走了转换"时这条差异有用。
    const requestBlockers = fullCanonicalNames(pluginHost.requestSide());
    const responseBlockers = fullCanonicalNames([
      ...pluginHost.responseSide(),
      ...pluginHost.streamSide(),
    ]);
    return {
      allowed: false,
      reason: blockerReason(requestBlockers, responseBlockers),
    };
  };

  const admission: FastPathAdmission = {
    allowed(): boolean {
      cached ??= compute();
      return cached.allowed;
    },
    reason(): string | undefined {
      cached ??= compute();
      return cached.reason;
    },
    invalidate(): void {
      cached = undefined;
    },
  };

  // 插件表变化（register / unregister / setEnabled）→ 自动失效重算
  pluginHost.onChange(() => admission.invalidate());

  return admission;
}

/** §4.1 的四个条件，逐条对应。 */
export function isFastPathEligible(
  ctx: RequestContext,
  route: ResolvedRoute,
  admission: FastPathAdmission,
  rawBodyAvailable: boolean,
): boolean {
  if (!admission.allowed()) return false; // D-fastpath-2：插件准入
  if (ctx.client_format !== route.provider_format) return false; // 条件 1：格式同一
  if (!route.fast_path_eligible) return false; // 条件 2：参考实现/显式声明兼容
  if (ctx.state['requires_structural_change'] === true) return false; // 条件 3：无结构改写
  if (!rawBodyAvailable) return false; // 条件 4：保留了原始字节
  return true;
}

/** fast path 下**做**的三件事（20 §4.2 表格）：finish_reason 别名、tool id 补全、usage 口径。 */
export const FAST_PATH_NORMALIZATIONS = [
  'finish_reason', // 响应侧只改这一个字符串字段，或仅在 usage record 里记录规范化值
  'tool_call_id', // 生成 call_<ulid>，维护 tool_use_id → call_id 映射
  'usage', // 口径修正只写 UsageRecord，不动响应体
] as const;

/** fast path 下**不做**的事（20 §4.2）：任何结构转换、字段重命名、类型强转。 */
export const FAST_PATH_FORBIDDEN = [
  'structural_conversion',
  'field_rename',
  'type_coercion',
] as const;

/** 取出一组插件里 full-canonical（默认档）的那些的名字。 */
function fullCanonicalNames(plugins: Plugin[]): string[] {
  return plugins
    .filter((p) => effectivePluginScope(p.manifest) === 'full-canonical')
    .map((p) => p.manifest.name);
}

/**
 * 组装「为什么不能走 fast path」的原因文案。
 *
 * 单侧时保持历史上的原句式（`请求侧插件需要完整 canonical: x`，tests/fast-path.test.ts
 * 钉着它）；两侧都有时合并成一句，避免两条原因互相覆盖。
 */
function blockerReason(requestBlockers: string[], responseBlockers: string[]): string {
  if (requestBlockers.length > 0 && responseBlockers.length > 0) {
    return (
      `插件需要完整 canonical（请求侧: ${requestBlockers.join(', ')}；` +
      `响应侧: ${responseBlockers.join(', ')}）`
    );
  }
  if (requestBlockers.length > 0) {
    return `请求侧插件需要完整 canonical: ${requestBlockers.join(', ')}`;
  }
  return `响应侧插件需要完整 canonical: ${responseBlockers.join(', ')}`;
}
