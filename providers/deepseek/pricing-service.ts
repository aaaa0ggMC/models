/**
 * providers/deepseek/pricing-service.ts —— DeepSeek 定价服务（S10 计量边界调用）。
 *
 * 落地仓库主人定的计费原则：
 *   1. **不可变 + 快照**：每次计费把命中的费率、档位（tier）、生效日期、表版本一并
 *      写进 `price_snapshot`；价格表更新后不得重算已有记录（backfill 走历史价格）；
 *   2. **请求时尝试计费**：完成时用当时可得价格算；拿不到 → `pending_price`，usage 保留；
 *   3. **as_api 永远尝试计算**：订阅路径现金恒 0，但等值 API 计费照算；
 *   4. **as_api 与 cash 同一次解析**：同一个 resolvePrice 结果算两遍，不错峰。
 *
 * 档位（tier）必须由**我们按请求时间戳自己算**——上游响应不会告诉你这笔命中了峰还是谷
 * （已核实：没有任何官方 API 提供峰谷规则或实时价格，价格只公布在官方价格页）。
 * 流式跨时段边界的规则：**按请求开始时间定档**（确定性优先；另一种选择是按 chunk
 * 时间戳拆分，实现与对账都更复杂，本实现不采用）。
 *
 * 赠送余额优先扣：余额差不等于现金支出，对账见 metering/reconciliation.ts。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { HolidayCalendar, PriceSnapshot, UsageCost } from '../../metering/pricing.js';
import {
  computeCost,
  estimateCanonicalUsage,
  priceSnapshotFrom,
  resolvePrice,
} from '../../metering/pricing.js';
import {
  deepseekPriceTableFor,
  loadDeepSeekPriceTables,
  type DeepSeekPriceTables,
} from './pricing.js';
import { loadDeepSeekHolidayCalendars } from './holidays.js';

/** 一次计费的输入（S10 在请求完成时组装）。 */
export interface PricingRequest {
  /** 请求开始时间戳（epoch ms）——定档与对账都用它（流式跨时段按开始时间定档）。 */
  ts: number;
  /** 目标模型（provider 侧真实 id）。 */
  model: string;
  /** 已归一的 usage（含 raw）。 */
  usage: CanonicalUsage;
  /** 订阅路径：cash 恒 0，as_api 照算。 */
  subscription?: boolean;
  /** usage 缺失时用于 as_api 自估算的文本（标注 estimate_method）。 */
  estimateText?: string;
}

export interface PricingResult {
  cost: UsageCost;
  /** 命中的价格快照；拿不到价格 = null（pending_price / unpriced）。 */
  price_snapshot: PriceSnapshot | null;
  /** 走了自估算时标注方法（R2：估算值必须与真实值可区分）。 */
  estimate_method?: string;
  /**
   * 自估算出来的 usage（仅当上游没给 usage 且提供了 estimateText 时出现）。
   * S10 把它写回 record.usage——否则记录里 usage 空着而 as_api 有值，对账时
   * 看不出这个数是怎么来的（R2：估算值必须可区分、可解释）。
   */
  estimated_usage?: CanonicalUsage;
}

/** S10 依赖的定价端口（组合根注入 DeepSeek 实现；测试可整体替换）。 */
export interface PricingService {
  price(req: PricingRequest): PricingResult;
}

/**
 * DeepSeek 定价服务。
 *
 * 表来自仓库内静态 pricing.json（带版本 + 来源 URL + 抓取日期；价格不在 /models 里）。
 * 节假日日历可注入（按年维护的表；缺日期时 resolvePrice 打 holiday_unknown）。
 */
export function createDeepSeekPricingService(
  opts: {
    tables?: DeepSeekPriceTables;
    holidays?: HolidayCalendar[];
  } = {},
): PricingService {
  const tables = opts.tables ?? loadDeepSeekPriceTables();
  // 节假日表按年维护（ holidays.json ）；缺年份时 resolvePrice 打 holiday_unknown
  const holidays = opts.holidays ?? safeHolidayCalendars();
  return {
    price(req: PricingRequest): PricingResult {
      const table = deepseekPriceTableFor(req.model, tables.tables);
      const price =
        table === undefined
          ? undefined
          : resolvePrice(table, req.ts, holidays === undefined ? {} : { holidays });
      // priceSnapshotFrom 已从 per-model 表填好 table_version / tier / window / 生效日
      const snapshot = price === undefined ? null : priceSnapshotFrom(price);
      // usage 完全缺失时用自估算补 as_api（订阅路径的真值来源；方法标注可区分）
      const estimated =
        req.usage.units.tokens === undefined && req.estimateText !== undefined
          ? estimateCanonicalUsage(req.estimateText)
          : undefined;
      const usage =
        estimated === undefined
          ? req.usage
          : { ...req.usage, units: { ...req.usage.units, ...estimated.usage.units } };
      const cost = computeCost(usage, price, {
        ...(req.subscription === undefined ? {} : { subscription: req.subscription }),
      });
      return {
        cost,
        price_snapshot: snapshot,
        ...(estimated === undefined
          ? {}
          : {
              estimate_method: estimated.estimate_method,
              estimated_usage: {
                ...req.usage,
                units: { ...req.usage.units, ...estimated.usage.units },
                source: 'estimated',
              },
            }),
      };
    },
  };
}

/** 节假日表加载失败不该让整个网关起不来：退化成「无节假日数据」（holiday_unknown）。 */
function safeHolidayCalendars(): HolidayCalendar[] {
  try {
    return loadDeepSeekHolidayCalendars();
  } catch {
    return [];
  }
}
