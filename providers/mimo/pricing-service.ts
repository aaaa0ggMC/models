/**
 * providers/mimo/pricing-service.ts —— MiMo 定价服务（S10 与工具/音频端点调用）。
 *
 * 落地仓库主人定的计费原则（本文件是 MiMo 那一半的落地处）：
 *   1. **不可变 + 快照**：每次计费把命中的费率、档位、生效日期、表版本一并写进
 *      `price_snapshot`；
 *   2. **请求时尝试计费**：拿不到 → `pending_price`；
 *   3. **as_api 永远尝试计算**：订阅路径现金恒 0，等值 API 计费照算；
 *   4. **Token Plan 是订阅路径**：官方按量计费页明文「按量计费使用开放平台普通 API
 *      Key……与 Token Plan 套餐额度不互通」——两条路的钱走不同渠道。所以 Token Plan
 *      key（`tp-`）走订阅口径（cash 恒 0、as_api 照算），按量 key（`sk-`）走现金口径。
 *      **判据是 key 前缀**（官方文档两处明文），不是配置项也不是猜的，实现见
 *      credentials/resolver.ts 的 `BILLING_MODE_BY_KEY_PREFIX` 与 `billingModeFor`。
 *
 * ## TTS / ASR 为什么也能价
 *
 * 官方页给的是「非 token 槽」价格：ASR 按输入音频时长（¥0.5/小时）、TTS 系列限时免费。
 * 这两者直接落进通用引擎已有的 `per_hour` / `per_10000_characters` 槽
 * （NON_TOKEN_SLOT_SCALE：per_hour 按秒除 3600、per_10000_characters 除 10000），
 * **不需要新槽位**。于是 TTS/ASR 的用量记录与 chat 走同一条 computeCost 路，
 * `cost.status` 同样是 `priced` 而不是 `unpriced`——这正是仓库主人
 * 「接入的每个模型都不能是 unpriced」要求的那一条。
 *
 * ## 与 DeepSeek 定价服务的分工
 *
 * 两个服务各自只知道自己的模型（`handles` 谓词），由 metering/composite-pricing.ts
 * 组合。没有抽象共享基类：DeepSeek 有峰谷 tier 与节假日日历，MiMo 两者皆无
 * （见 providers/mimo/pricing.ts 文件头的论证），硬合到一起会出现
 * 「为什么这个方法在 DeepSeek 那边这么做」的分裂。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type {
  HolidayCalendar,
  PriceSnapshot,
  PricingRequest,
  PricingResult,
  PricingService,
  ProviderPricingService,
  UsageCost,
} from '../../metering/pricing.js';
import {
  computeCost,
  estimateCanonicalUsage,
  priceSnapshotFrom,
  resolvePrice,
} from '../../metering/pricing.js';
import { loadMiMoPriceTables, mimoPriceTableFor, type MiMoPriceTables } from './pricing.js';

export type { PricingRequest, PricingResult, PricingService };

/**
 * MiMo 定价服务。
 *
 * 表来自仓库内静态 pricing.json（带版本 + 来源 URL + 抓取日期；价格不在 /models 里）。
 * **不注入节假日日历**：MiMo 官方页没有任何峰谷时段表述，节假日只在其被用于
 * 「法定节假日强制低谷」时影响价格，没有低谷体系时它不该参与决策。
 * `holiday_unknown` 会照实记进 snapshot（那是"我们没有节假日数据"的诚实标记）。
 */
export function createMiMoPricingService(
  opts: { tables?: MiMoPriceTables; holidays?: HolidayCalendar[] } = {},
): ProviderPricingService {
  const tables = opts.tables ?? loadMiMoPriceTables();
  const holidays = opts.holidays;
  return {
    provider: 'mimo',
    accessPaths: ['mimo.openai-chat', 'mimo.tools.tts', 'mimo.tools.asr'],
    handles(model: string): boolean {
      return mimoPriceTableFor(model, tables.tables) !== undefined;
    },
    price(req: PricingRequest): PricingResult {
      const table = mimoPriceTableFor(req.model, tables.tables);
      const price =
        table === undefined
          ? undefined
          : resolvePrice(table, req.ts, holidays === undefined ? {} : { holidays });
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

/**
 * 工具/音频端点的计费入口（`/v1/tools/*` 与 `/v1/audio/*` 不走 S10，自己算）。
 *
 * 与 S10 的分工：S10 有完整的 RequestContext（能拿 estimateText、access_path），
 * 工具端点只有 (model, usage)。所以这里只做「有价格就算、没价格记 pending_price」，
 * **不做字符启发式自估算**——那需要请求文本，而工具端点的 usage 已经带了
 * characters / audio_seconds，猜不出来也不该猜。
 */
export function priceMiMoToolCall(req: {
  ts: number;
  model: string;
  usage: CanonicalUsage;
  subscription?: boolean;
  tables?: MiMoPriceTables;
}): { cost: UsageCost; price_snapshot: PriceSnapshot | null } {
  const table = mimoPriceTableFor(req.model, req.tables ?? loadMiMoPriceTables());
  const price = table === undefined ? undefined : resolvePrice(table, req.ts);
  return {
    cost: computeCost(req.usage, price, {
      ...(req.subscription === undefined ? {} : { subscription: req.subscription }),
    }),
    price_snapshot: price === undefined ? null : priceSnapshotFrom(price),
  };
}
