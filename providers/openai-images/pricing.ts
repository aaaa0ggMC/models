/**
 * providers/openai-images/pricing.ts —— OpenAI Images 定价表加载（S10/计量边界用）。
 *
 * 与 providers/deepseek/pricing.ts 同构但更小：没有峰谷体系（OpenAI 图片定价
 * 不按时段折扣），只有「token 槽位」一种计费形态。按张计费形态（per_image）的
 * 定价用例在 tests/openai-images-pricing.test.ts 用合成表证明可表达，**不**写进
 * 本表——见 pricing.json 的 notes（同一张表同时配 token 与 per_image 会双算）。
 *
 * 加载时校验结构（价格表是配置不是用户输入，一个错字会让计费静默算错），
 * 无模块级缓存（注入优先，测试可隔离）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CanonicalUsage } from '../../ir/index.js';
import type {
  PriceSnapshot,
  PricingRequest,
  ProviderPricingService,
  UsageCost,
} from '../../metering/pricing.js';
import { computeCost, priceSnapshotFrom, resolvePrice } from '../../metering/pricing.js';
import type { PriceEntry, PriceTable } from '../../metering/pricing.js';

/** pricing.json 的路径（相对本文件，不依赖 process.cwd()）。 */
const PRICING_JSON_PATH = fileURLToPath(new URL('./pricing.json', import.meta.url));

/** 期望结构（加载时逐字段校验）。 */
interface OpenAIImagesPricingFile {
  table_version: string;
  source_url: string;
  fetched_at: string;
  currency: string;
  unit: string;
  models: Record<string, { entries: PriceEntry[] }>;
}

/** model id → 价格表。 */
export type OpenAIImagesPriceTables = Record<string, PriceTable>;

/** 读 pricing.json 并校验结构；失败抛带路径的 Error（启动期 fail fast）。 */
export function loadOpenAIImagesPriceTables(): OpenAIImagesPriceTables {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PRICING_JSON_PATH, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`openai-images pricing.json 读取/解析失败: ${String(err)}`, { cause: err });
  }
  const file = parsePricingFile(raw);
  const tables: OpenAIImagesPriceTables = {};
  for (const [model, spec] of Object.entries(file.models)) {
    tables[model] = {
      table_version: file.table_version,
      source_url: file.source_url,
      fetched_at: file.fetched_at,
      currency: file.currency,
      unit: file.unit,
      entries: spec.entries,
    };
  }
  return tables;
}

/** 取某个 model 的价格表；没有定价的 model 返回 undefined（调用方记 pending_price）。 */
export function openAIImagesPriceTableFor(
  model: string,
  tables?: OpenAIImagesPriceTables,
): PriceTable | undefined {
  return (tables ?? loadOpenAIImagesPriceTables())[model];
}

// ---------------------------------------------------------------------------
// 定价服务（http/modality-endpoints.ts 的 ModalityPricingPort 形状）
// ---------------------------------------------------------------------------

/** 一次计费的产物（与 DeepSeek 的 PricingResult 同构，方便两套并存）。 */
export interface OpenAIImagesPricingResult {
  cost: UsageCost;
  price_snapshot: PriceSnapshot | null;
  estimate_method?: string;
  estimated_usage?: CanonicalUsage;
}

/**
 * OpenAI Images 定价服务。
 *
 * 与 DeepSeek 的差异：**没有峰谷/节假日**（OpenAI 图片定价不按时段折扣），
 * 所以这里没有假日日历注入，也没有档位解析的额外参数。其余原则完全一致：
 * 快照固化、事件时间定价、`pending_price` / `unpriced` / `priced` 三态不混。
 */
export function createOpenAIImagesPricingService(
  tables?: OpenAIImagesPriceTables,
): ProviderPricingService {
  const loaded = tables ?? loadOpenAIImagesPriceTables();
  return {
    provider: 'openai',
    accessPaths: ['openai.images', 'xai.images', 'xai.openai-responses', 'xai.openai-chat'],
    handles(model: string): boolean {
      return openAIImagesPriceTableFor(model, loaded) !== undefined;
    },
    price(req: PricingRequest): OpenAIImagesPricingResult {
      const table = openAIImagesPriceTableFor(req.model, loaded);
      const price = table === undefined ? undefined : resolvePrice(table, req.ts);
      const snapshot = price === undefined ? null : priceSnapshotFrom(price);
      // 表里没有 per_image 槽（token 计费形态）而上游又没给 token 用量时：
      // 算出来会是 priced + $0.00——那会把「没算成钱」伪装成「这次免费」。
      // 按通用引擎同款立场归一到 pending_price，让它在对账时显眼。
      const perImageSlot = price !== undefined && Object.hasOwn(price.rates, 'per_image');
      const unpriceable =
        price !== undefined && !perImageSlot && req.usage.units.tokens === undefined;
      const cost = unpriceable ? computeCost(req.usage, undefined) : computeCost(req.usage, price);
      return {
        cost,
        price_snapshot: unpriceable ? null : snapshot,
      };
    },
  };
}

function parsePricingFile(raw: unknown): OpenAIImagesPricingFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('pricing.json 顶层必须是对象');
  const root = raw as Record<string, unknown>;
  for (const key of ['table_version', 'source_url', 'fetched_at', 'currency', 'unit']) {
    if (typeof root[key] !== 'string' || (root[key] as string) === '') {
      throw new Error(`pricing.json 缺少字符串字段 ${key}`);
    }
  }
  const models = root['models'];
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error('pricing.json 缺少 models 对象');
  }
  for (const [model, spec] of Object.entries(models as Record<string, unknown>)) {
    const rec = spec as Record<string, unknown>;
    if (!Array.isArray(rec['entries']) || (rec['entries'] as unknown[]).length === 0) {
      throw new Error(`pricing.json 的模型 ${model} 缺少非空 entries`);
    }
    for (const entry of rec['entries'] as Array<Record<string, unknown>>) {
      if (typeof entry['effective_from'] !== 'string') {
        throw new Error(`pricing.json 的模型 ${model} 有 entry 缺 effective_from`);
      }
      if (typeof entry['rates'] !== 'object' || entry['rates'] === null) {
        throw new Error(`pricing.json 的模型 ${model} 有 entry 缺 rates`);
      }
    }
  }
  return raw as OpenAIImagesPricingFile;
}
