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
 * **D-fastpath-2（fast path 准入）**：fast path 仅在「没有启用需要完整 canonical 的请求侧
 * 插件」时可用。插件 manifest 声明 `scope: "envelope-only" | "full-canonical"`；只有全部
 * 已启用请求侧插件都是 envelope-only（或没有请求侧插件）时才允许走 fast path。
 * 该条件由配置/组合根在启动时计算并缓存，运行中增删插件要能失效重算。
 *
 * §4.1 的四个判定条件在这里落成代码：
 *   1. ctx.client_format === ctx.provider_format
 *   2. route.provider === 该格式的参考实现（或显式声明兼容）
 *   3. !ctx.state.requires_structural_change（插件有权关闭）
 *   4. ctx.client_raw_body_available（保留了原始字节）
 */

import type { PluginHost } from '../../plugins/host.js';
import type { RequestContext } from '../../ir/index.js';
import type { ResolvedRoute } from '../../ir/index.js';

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
 * 为什么在这里算而不在每请求算：`hasFullCanonicalRequestSide()` 要遍历插件表，
 * 每请求做一次是纯浪费；而插件表在运行中会变，所以必须能失效。
 */
export function createFastPathAdmission(pluginHost: PluginHost): FastPathAdmission {
  let cached: { allowed: boolean; reason: string | undefined } | undefined;

  const compute = (): { allowed: boolean; reason: string | undefined } => {
    if (!pluginHost.hasRequestSide()) {
      return { allowed: true, reason: undefined };
    }
    if (!pluginHost.hasFullCanonicalRequestSide()) {
      // 全部请求侧插件都是 envelope-only：不阻止 fast path（D-fastpath-2）
      return { allowed: true, reason: undefined };
    }
    const blockers = pluginHost
      .requestSide()
      .filter((p) => (p.manifest.scope ?? 'full-canonical') === 'full-canonical')
      .map((p) => p.manifest.name);
    return {
      allowed: false,
      reason: `请求侧插件需要完整 canonical: ${blockers.join(', ')}`,
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
