/**
 * catalog/visibility.ts —— 「这条能力矩阵条目该不该出现在用户眼前」的**唯一判据**。
 *
 * ## 为什么单独一个文件
 *
 * 这两个判据有两个消费方，而它们曾经**只各写各的**：
 *
 * 1. `ModelCatalog.list()`（`GET /v1/models`）：上一轮加上了部署态过滤，数据面干净了；
 * 2. `AdminService.listCapabilityMatrix()`（`GET /admin/api/capabilities`，管理面
 *    「模型目录」页的数据源）：直通 `capabilityRegistry.list()`，两条判据一条都没过
 *    ——于是同一个部署里，客户端看到 4 个模型，管理员看到 12 条（含 mock 脚手架与
 *    没配 key 的 provider），状态还全是绿色「可用」。
 *
 * 判据收在本文件之后，两边问的是同一份实现、同一个 `providerAvailability` 端口实例
 * （组合根建一次、注入两处），不会再分叉。
 *
 * ## 两条判据都是真实读取，不是猜
 *
 * - **内部脚手架**：矩阵条目上的 `internal` 标记（ir/capability.ts）。mock 路径是
 *   演示与测试的替身，不是可调用的上游；条目**不从矩阵删**（路由的能力预检与 fast
 *   path 资格都读矩阵），只标记 + 默认过滤。
 * - **provider 已配置**：问 `providerAvailability` 端口（组合根用渠道表 + 凭据库实现）。
 *   没配渠道也没配 key 的 provider，其模型列出来只会让调用方挑一个然后 401。
 *
 * 默认两个都过滤，各有一个显式开关（`include_internal` / `include_unconfigured`）——
 * 「默认隐藏 + 一个开关」比「全列出来让调用方自己猜哪个能调通」诚实。
 *
 * ## 与路由准入的口径差异（有意为之）
 *
 * 本文件答「这个部署配过这个 provider 吗」（渠道表 / 凭据库任一命中）；
 * S2 路由准入答「建过渠道吗」（只认渠道表，见 gateway-core/router.ts 的
 * ProviderStateFilter）。于是 0 渠道 + env key 的部署上会出现「目录说有、路由说
 * 没有」——理由与代价说清在 composition-root.ts 的 `providerAvailabilityResolver`
 * 注释里（目录服务客户端探测、准入服务运维动作；准入只在有管理面的装配上生效）。
 *
 * ## 粒度差异（有意为之，文档说清）
 *
 * `/v1/models` 按**记录**（provider × model）过滤：一条记录只有全部 access path 都是
 * 内部脚手架时才整条消失（混合装配下它对用户仍有可用的一面）。管理面按**条目**
 * （access_path × model × modality）过滤：内部条目不占主行。两者在「模型集合」上一致
 * ——`tests/admin-capabilities.test.ts` 就是这么断言的（两个端点的模型集合必须相同）。
 */

import type { CapabilityEntry } from '../ir/index.js';
import type { ProviderAvailabilityResolver } from './types.js';

/** 可见性判据的注入依赖（两个消费方共用同一个实例）。 */
export interface CapabilityVisibilityDeps {
  /** access path → provider（与 `ModelCatalog` 同一个解析器，见 catalog/types.ts）。 */
  providerOf: (accessPath: string) => string;
  /**
   * provider → 是否已配置（**端口**，组合根用渠道表 + 凭据库实现）。
   *
   * 不注入 = 全部算已配置、不过滤：目录本身对「这个部署配了什么」没有任何先验，
   * 装配方不告诉它就不能替它决定（测试合并逻辑时也不想被部署状态干扰）。
   */
  providerAvailability?: ProviderAvailabilityResolver;
}

/** 可见性开关（与 `/v1/models` 的查询参数同名同义）。 */
export interface CapabilityVisibilityOptions {
  /** 未配置 provider 的条目也列出来（默认 false）。 */
  includeUnconfigured?: boolean;
  /** 内部脚手架条目也列出来（默认 false）。 */
  includeInternal?: boolean;
}

/** 单条矩阵条目是否内部脚手架（mock 路径：做给机器看，不是给用户调的）。 */
export function isInternalEntry(entry: CapabilityEntry): boolean {
  return isInternalFlag(entry.internal);
}

/**
 * `internal` 标记的布尔语义（**唯一一处**解读）。
 *
 * 矩阵条目（`CapabilityEntry.internal`）与目录记录的投影（`AccessPathInfo.internal`，
 * 见 registry.ts 的 `accessPathInfo`）读的是同一个标记，所以判据也只有一个：未设置或
 * false = 不是脚手架。两个消费方（`/v1/models` 的记录级过滤、管理面的条目级过滤）
 * 都走这里，不各写一遍。
 */
export function isInternalFlag(internal: boolean | undefined): boolean {
  return internal === true;
}

/**
 * 该条目所在 provider 是否已配置。
 *
 * 未注入 `providerAvailability` = 不过滤（全部算已配置），与
 * `ProviderAvailabilityResolver` 的端口语义一致。
 */
export function isConfiguredEntry(entry: CapabilityEntry, deps: CapabilityVisibilityDeps): boolean {
  if (deps.providerAvailability === undefined) return true;
  return deps.providerAvailability(deps.providerOf(entry.access_path));
}

/**
 * 单条矩阵条目默认是否对用户可见（管理面与数据面共用的判据）。
 *
 * 纯函数、不读 `process.env`、不起 IO——测试直接喂条目与假 resolver。
 */
export function capabilityEntryVisible(
  entry: CapabilityEntry,
  deps: CapabilityVisibilityDeps,
  options: CapabilityVisibilityOptions = {},
): boolean {
  if (isInternalEntry(entry) && options.includeInternal !== true) return false;
  if (options.includeUnconfigured !== true && !isConfiguredEntry(entry, deps)) return false;
  return true;
}
