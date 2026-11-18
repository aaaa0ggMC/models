/**
 * admin/provider-runtime.ts —— 存储里的 provider 配置 → **请求路径可读的运行时投影**。
 *
 * ## 为什么需要它
 *
 * provider 配置（`ProviderConfig`）住在加密存储里，读取是异步的；而请求路径上的两个
 * 消费者都要**同步**读它：
 *   - S2 的别名解析（`<ns>/<model>` 的 namespace 归属）；
 *   - `/v1/models`（每个模型要同时暴露裸 id 与 namespace 生效名）；
 *   - S3 的服务端工具默认注入开关（provider 级）。
 *
 * 解法是"投影 + 热更新"：管理面每一次 provider CRUD 之后整表重算，写进这个内存对象；
 * 请求路径只读这个对象。与 `aliasResolver.setRules()` 是同一条路线（别名规则早就这么
 * 做），不引入缓存失效问题——**没有缓存，只有一份当前值**。
 *
 * ## 为什么不是每次请求去读存储
 *
 * 加密存储的读取要解密，放在请求路径上等于给每个请求加一次对称解密；而且"读一半"
 * 的中间态会让两个消费者看到不同的配置。整表替换的代价是一次 CRUD 一次全量重算
 * （provider 数量是个位数到几十），换来请求路径上是纯内存读。
 *
 * 依赖全部注入、无模块级单例（仓库硬约束）。
 */

import type { ChannelPricingConfig } from '../metering/pricing.js';
import type { ProviderBuiltinToolDefaults } from './api-types.js';

/**
 * 「连续失败计数中」状态的原因串（`recordUpstreamFailure` 未达阈值时写的那一态）。
 *
 * 为什么用原因串当判据而不是 `consecutive_failures`：401/403 是**立即禁用**，写进去的
 * `consecutive_failures` 可能只有 1（之前没有失败过），按次数比较会把「已经关掉了」
 * 误判成「还在计数」。原因串是 `recordUpstreamFailure` 里唯一区分两态的显式标记，
 * 收敛成一个导出常量，写方（admin/service.ts）与读方（本文件）就不会漂。
 */
export const AUTO_DISABLE_COUNTING_REASON = '连续失败计数中';

/**
 * 这条 `auto_disabled` 记录是不是「真的把渠道关掉了」。
 *
 * 「计数中」不是不可用：它只是失败次数还没到阈值，渠道照样该参与轮换——否则一次上游
 * 400 之后请求全被 `ProviderStateFilter` 挡下，成功恢复的路径永远跑不到，只能人工
 * 停用/启用才能救回来（用户实测过的死锁）。
 */
export function isAutoDisabled(
  autoDisabled: { reason: string } | undefined,
): autoDisabled is { reason: string; at: number; consecutive_failures: number } {
  return autoDisabled !== undefined && autoDisabled.reason !== AUTO_DISABLE_COUNTING_REASON;
}

/** 运行时投影里的一条 provider 记录（只放请求路径真的会读的字段）。 */
export interface ProviderRuntimeEntry {
  id: string;
  dialect: string;
  base_url: string;
  /** 命名空间（空串 = 未启用）。 */
  namespace: string;
  /** 该 provider 派生出的 access path（`<id>.<dialect 点换横线>`）。 */
  access_path: string;
  /** 静态模型清单（discovery 渠道为空数组——模型由能力矩阵实时回答）。 */
  models: string[];
  enabled: boolean;
  /**
   * 自动禁用状态（存在 = 网关记了它一笔；**只有 `isAutoDisabled` 为真才是真关掉了**）。
   *
   * 同一字段承载两态：未达阈值时是「连续失败计数中」，达到阈值 / 401 立即禁用时是
   * 「已自动禁用」。判据见 `isAutoDisabled` 与 api-types.ts 的字段说明。
   */
  auto_disabled?: { reason: string; at: number; consecutive_failures: number };
  builtin_tools: ProviderBuiltinToolDefaults;
  /** 渠道级自定义单价表与倍率（用于聚合站分层计价 Tier 1 / 倍率放大）。 */
  pricing?: ChannelPricingConfig;
}

/** 请求路径读 provider 运行时投影的窄接口（三个消费者共用）。 */
export interface ProviderRuntimeIndex {
  /** 当前全部条目（整表替换语义；调用方拿到的是拷贝）。 */
  entries(): ProviderRuntimeEntry[];
  /** 单个 provider（找不到 = undefined）。 */
  get(providerId: string): ProviderRuntimeEntry | undefined;
  /** provider → namespace（空串按未启用处理，返回 undefined）。 */
  namespaceFor(providerId: string): string | undefined;
  /** provider → 服务端工具默认开关（全关 / 找不到都返回 undefined）。 */
  builtinToolsFor(providerId: string): ProviderBuiltinToolDefaults | undefined;
  /**
   * 该 provider 当前是否不可用（管理员禁用或网关自动禁用）。
   *
   * 请求路径（S2 的 ProviderStateFilter）每次都问这个——所以它必须是纯内存读。
   * 不知道的 provider（没登记过）返回 false（放行），理由见 ProviderStateFilter 的文件注释。
   *
   * 「计数中」的 auto_disabled **不算**不可用（见 `isAutoDisabled`）：未达阈值的累计
   * 失败不该把渠道踢出轮换。
   */
  isUnavailable(providerId: string): boolean;
  /** 整表替换（管理面 provider CRUD 后调）。 */
  replace(entries: ProviderRuntimeEntry[]): void;
}

/** 内存实现：一份 Map + 整体替换。 */
export class InMemoryProviderRuntimeIndex implements ProviderRuntimeIndex {
  private table = new Map<string, ProviderRuntimeEntry>();

  entries(): ProviderRuntimeEntry[] {
    return [...this.table.values()].map((e) => ({
      ...e,
      models: [...e.models],
      ...(e.pricing === undefined ? {} : { pricing: { ...e.pricing } }),
    }));
  }

  get(providerId: string): ProviderRuntimeEntry | undefined {
    const found = this.table.get(providerId);
    return found === undefined
      ? undefined
      : {
          ...found,
          models: [...found.models],
          ...(found.pricing === undefined ? {} : { pricing: { ...found.pricing } }),
        };
  }

  pricingFor(accessPathOrProvider: string): ChannelPricingConfig | undefined {
    const direct = this.table.get(accessPathOrProvider);
    if (direct?.pricing !== undefined) return direct.pricing;
    for (const entry of this.table.values()) {
      if (entry.access_path === accessPathOrProvider && entry.pricing !== undefined) {
        return entry.pricing;
      }
    }
    return undefined;
  }

  namespaceFor(providerId: string): string | undefined {
    const ns = this.table.get(providerId)?.namespace ?? '';
    return ns === '' ? undefined : ns;
  }

  builtinToolsFor(providerId: string): ProviderBuiltinToolDefaults | undefined {
    const tools = this.table.get(providerId)?.builtin_tools;
    if (tools === undefined) return undefined;
    // 全关与"没配"在请求路径上是同一回事：返回 undefined，让调用方少一次判断
    const on = tools.web_search === true || tools.url_context === true;
    return on ? { ...tools } : undefined;
  }

  isUnavailable(providerId: string): boolean {
    const entry = this.table.get(providerId);
    // 没登记过 = 不知道状态 = 放行（静态装配的渠道不因为这个过滤器消失）
    if (entry === undefined) return false;
    // 管理员停用 → 不可用；auto_disabled 只在「真的关掉了」时不可用（计数中放行）
    return !entry.enabled || isAutoDisabled(entry.auto_disabled);
  }

  replace(entries: ProviderRuntimeEntry[]): void {
    this.table = new Map(
      entries.map((e) => [
        e.id,
        {
          ...e,
          models: [...e.models],
          ...(e.pricing === undefined ? {} : { pricing: { ...e.pricing } }),
        },
      ]),
    );
  }
}
