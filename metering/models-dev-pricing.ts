/**
 * metering/models-dev-pricing.ts —— 基于离线 models.dev 快照的通用兜底定价服务。
 *
 * 用于聚合站场景下的 Tier 3 兜底（当某供应商没有自维护定价服务、或该供应商
 * 未覆盖某模型时，从 `catalog/vendor/models-dev.json` 查表计价，避免无故落入
 * pending_price）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PriceTable } from './pricing.js';
import {
  computeCost,
  estimateCanonicalUsage,
  priceSnapshotFrom,
  resolvePrice,
  type PricingRequest,
  type PricingResult,
  type ProviderPricingService,
} from './pricing.js';

const DEFAULT_SNAPSHOT_PATH = fileURLToPath(
  new URL('../catalog/vendor/models-dev.json', import.meta.url),
);

interface RawModelsDevFile {
  source_url?: string;
  fetched_at?: string;
  providers?: Record<
    string,
    {
      id?: string;
      models?: Array<{
        id?: string;
        pricing?: {
          currency?: string;
          unit?: string;
          table_version?: string;
          source_url?: string;
          fetched_at?: string;
          rates?: Record<string, number>;
        };
        raw?: {
          upstream?: {
            cost?: {
              cache_write?: number;
            };
          };
        };
      }>;
    }
  >;
}

export interface ModelsDevPricingOptions {
  /** 测试注入用快照路径；缺省读 `catalog/vendor/models-dev.json`。 */
  snapshotPath?: string;
  /** 预先解析好的快照对象（测试隔离用，避免磁盘 IO）。 */
  snapshotData?: unknown;
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  gemini: 'google',
  'google-ai': 'google',
};

function candidateModelIds(model: string): string[] {
  const candidates = new Set<string>();
  const trimmed = model.trim();
  if (trimmed === '') return [];
  candidates.add(trimmed);
  candidates.add(trimmed.toLowerCase());
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
    const stripped = trimmed.slice(slashIdx + 1);
    candidates.add(stripped);
    candidates.add(stripped.toLowerCase());
  }
  return [...candidates];
}

function toPriceTable(
  rawFile: RawModelsDevFile,
  entry: NonNullable<NonNullable<RawModelsDevFile['providers']>[string]['models']>[number],
): PriceTable | undefined {
  const rawRates = entry.pricing?.rates;
  if (rawRates === undefined || typeof rawRates !== 'object' || rawRates === null) {
    return undefined;
  }
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawRates)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      rates[k] = v;
    }
  }
  const cw = entry.raw?.upstream?.cost?.cache_write;
  if (typeof cw === 'number' && Number.isFinite(cw) && !Object.hasOwn(rates, 'input_cache_write')) {
    rates.input_cache_write = cw;
  }
  if (Object.keys(rates).length === 0) return undefined;

  return {
    table_version: entry.pricing?.table_version ?? rawFile.fetched_at ?? 'models.dev',
    source_url: entry.pricing?.source_url ?? rawFile.source_url ?? 'https://models.dev/api.json',
    fetched_at: entry.pricing?.fetched_at ?? rawFile.fetched_at ?? '2026-11-14',
    currency: entry.pricing?.currency ?? 'USD',
    unit: entry.pricing?.unit ?? 'USD per 1M tokens',
    entries: [
      {
        effective_from: '1970-01-01',
        tier: 'default',
        rates,
      },
    ],
  };
}

/**
 * 构造基于离线 models.dev 快照的兜底定价服务。
 *
 * 查询策略：优先 `(provider, model)` 二维精确命中，再退回跨 provider 按 model 命中
 * （适配 OpenRouter / 兼容转发 / 自定义代理渠道复用上游标准模型定价的场景）。
 */
export function createModelsDevPricingService(
  options: ModelsDevPricingOptions = {},
): ProviderPricingService {
  let rawFile: RawModelsDevFile = {};
  if (options.snapshotData !== undefined) {
    rawFile = (options.snapshotData as RawModelsDevFile) ?? {};
  } else {
    try {
      const path = options.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
      rawFile = JSON.parse(readFileSync(path, 'utf8')) as RawModelsDevFile;
    } catch {
      rawFile = {};
    }
  }

  const byProvider = new Map<string, Map<string, PriceTable>>();
  const byModel = new Map<string, PriceTable>();

  for (const [providerKey, spec] of Object.entries(rawFile.providers ?? {})) {
    const pLower = providerKey.toLowerCase();
    let pMap = byProvider.get(pLower);
    if (pMap === undefined) {
      pMap = new Map<string, PriceTable>();
      byProvider.set(pLower, pMap);
    }
    for (const modelSpec of spec.models ?? []) {
      const id = modelSpec.id;
      if (typeof id !== 'string' || id === '') continue;
      const table = toPriceTable(rawFile, modelSpec);
      if (table === undefined) continue;
      pMap.set(id.toLowerCase(), table);
      if (!byModel.has(id.toLowerCase())) {
        byModel.set(id.toLowerCase(), table);
      }
    }
  }

  function lookupTable(model: string, provider?: string): PriceTable | undefined {
    const candidates = candidateModelIds(model);
    if (candidates.length === 0) return undefined;

    if (provider !== undefined && provider !== '') {
      const pLower = provider.toLowerCase();
      const mapped = PROVIDER_ALIASES[pLower] ?? pLower;
      const pMap = byProvider.get(pLower) ?? byProvider.get(mapped);
      if (pMap !== undefined) {
        for (const c of candidates) {
          const hit = pMap.get(c.toLowerCase());
          if (hit !== undefined) return hit;
        }
      }
    }

    for (const c of candidates) {
      const hit = byModel.get(c.toLowerCase());
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  return {
    handles(model: string, ctx?: { provider?: string; access_path?: string }): boolean {
      return lookupTable(model, ctx?.provider) !== undefined;
    },
    price(req: PricingRequest): PricingResult {
      const table = lookupTable(req.model, req.provider);
      const price = table === undefined ? undefined : resolvePrice(table, req.ts);
      const snapshot = price === undefined ? null : priceSnapshotFrom(price);
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
