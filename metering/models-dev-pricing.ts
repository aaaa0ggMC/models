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

/**
 * 官方已公布、但离线 models.dev 快照尚未收录的常见决策/嵌入模型兜底单价
 * （USD per 1M tokens；仅当 snapshots 未命中时作为最后兜底）。
 */
const BUILTIN_FALLBACK_RATES: Readonly<
  Record<string, { input: number; output: number; input_cache_hit?: number }>
> = {
  'gemini-decision-1': { input: 0.1, output: 0 },
  'gpt-6-luna-decision': { input: 0.1, output: 0 },
  'jev-1.14': { input: 0.042, output: 0 },
  'jev-1.14.0': { input: 0.042, output: 0 },
  'qwen3-embedding-8b': { input: 0.01, output: 0 },
  'gemini-embedding-2': { input: 0.2, output: 0 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  // OpenCode Go / OpenRouter 近期新模型官方公开单价（USD per 1M tokens）
  'longcat-2.5': { input: 0.3, output: 1.2, input_cache_hit: 0.006 },
  'hungerg-free': { input: 0, output: 0 },
  'gpt-astra-latest': { input: 8, output: 40, input_cache_hit: 0.4 },
  'gpt-astra': { input: 8, output: 40, input_cache_hit: 0.4 },
  'gpt-sol-latest': { input: 2, output: 10, input_cache_hit: 0.1 },
  'gpt-sol': { input: 2, output: 10, input_cache_hit: 0.1 },
  'gpt-terra-latest': { input: 1, output: 5, input_cache_hit: 0.05 },
  'gpt-terra': { input: 1, output: 5, input_cache_hit: 0.05 },
  'gpt-luna-latest': { input: 0.1, output: 0.5, input_cache_hit: 0.01 },
  'gpt-luna': { input: 0.1, output: 0.5, input_cache_hit: 0.01 },
  'gemini-4-neon': { input: 3, output: 15, input_cache_hit: 0.15 },
  'gemini-4-neon-fast': { input: 5.4, output: 27, input_cache_hit: 0.27 },
  'chatgpt-image-latest': { input: 5, output: 10, input_cache_hit: 1.25 },
};

/** 在线 `https://models.dev/api.json` 同步后的实时价格缓存（高于离线旧快照）。 */
const onlineByProvider = new Map<string, Map<string, PriceTable>>();
const onlineByModel = new Map<string, PriceTable>();

/**
 * 将在线 `https://models.dev/api.json` 的最新价格写入内存缓存。
 * 每次管理面同步 `models.dev` 时调用，让新发布模型无需更新仓库静态快照即可自动定价。
 */
export function updateOnlineModelsDevPricing(raw: unknown): number {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  let count = 0;
  const fetchedAt = new Date().toISOString().slice(0, 10);
  for (const [providerKey, providerVal] of Object.entries(raw as Record<string, unknown>)) {
    if (providerVal === null || typeof providerVal !== 'object' || Array.isArray(providerVal)) {
      continue;
    }
    const modelsObj = (providerVal as Record<string, unknown>)['models'];
    if (modelsObj === null || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) continue;
    const pLower = providerKey.toLowerCase();
    let pMap = onlineByProvider.get(pLower);
    if (pMap === undefined) {
      pMap = new Map<string, PriceTable>();
      onlineByProvider.set(pLower, pMap);
    }
    for (const [key, item] of Object.entries(modelsObj as Record<string, unknown>)) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' && rec['id'] !== '' ? rec['id'] : key;
      const cost = rec['cost'];
      if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) continue;
      const c = cost as Record<string, unknown>;
      const rates: Record<string, number> = {};
      if (typeof c['input'] === 'number' && Number.isFinite(c['input'])) {
        rates.input_cache_miss = c['input'];
      }
      if (typeof c['output'] === 'number' && Number.isFinite(c['output'])) {
        rates.output = c['output'];
      }
      if (typeof c['cache_read'] === 'number' && Number.isFinite(c['cache_read'])) {
        rates.input_cache_hit = c['cache_read'];
      }
      if (typeof c['cache_write'] === 'number' && Number.isFinite(c['cache_write'])) {
        rates.input_cache_write = c['cache_write'];
      }
      if (Object.keys(rates).length === 0) continue;
      const table: PriceTable = {
        table_version: `models.dev-online-${fetchedAt}`,
        source_url: 'https://models.dev/api.json',
        fetched_at: fetchedAt,
        currency: 'USD',
        unit: 'USD per 1M tokens',
        entries: [{ effective_from: '1970-01-01', tier: 'default', rates }],
      };
      const idLower = id.toLowerCase();
      pMap.set(idLower, table);
      if (!onlineByModel.has(idLower)) {
        onlineByModel.set(idLower, table);
      }
      count += 1;
    }
  }
  return count;
}

function makeBuiltinPriceTable(rates: {
  input: number;
  output: number;
  input_cache_hit?: number;
}): PriceTable {
  return {
    table_version: 'builtin-fallback',
    source_url: 'https://opencode.ai/inference/go/openai/v1/models',
    fetched_at: '2026-11-27',
    currency: 'USD',
    unit: 'USD per 1M tokens',
    entries: [
      {
        effective_from: '1970-01-01',
        tier: 'default',
        rates: {
          input: rates.input,
          output: rates.output,
          ...(rates.input_cache_hit === undefined
            ? {}
            : { input_cache_hit: rates.input_cache_hit }),
        },
      },
    ],
  };
}

function candidateModelIds(model: string): string[] {
  const candidates = new Set<string>();
  const addVariants = (raw: string) => {
    const s = raw.trim().toLowerCase().replace(/^~+/, '');
    if (s === '') return;
    candidates.add(s);
    // 去掉 :free / :exacto 等后缀
    const noColon = s.replace(/:[a-z0-9_-]+$/i, '');
    if (noColon !== s) candidates.add(noColon);
    // 去掉日期戳（如 -20260501 / -0309）
    const noDate = noColon.replace(/-(?:20\d{6}|\d{4})(?=-|$)/g, '');
    if (noDate !== noColon) candidates.add(noDate);
    // 去掉常见变体后缀（-latest / -preview / -beta / -non-reasoning / -reasoning）
    const noVariant = noDate.replace(/-(?:latest|preview|beta|non-reasoning|reasoning)$/i, '');
    if (noVariant !== noDate) candidates.add(noVariant);
    // 版本号 .0 对齐（如 jev-1.14 <-> jev-1.14.0）
    if (/\.0$/.test(noColon)) candidates.add(noColon.slice(0, -2));
    else if (/\d+\.\d+$/.test(noColon)) candidates.add(`${noColon}.0`);
  };

  const trimmed = model.trim();
  if (trimmed === '') return [];
  addVariants(trimmed);
  // 逐级剥离斜杠前缀（如 or/~openai/gpt-sol-latest -> ~openai/gpt-sol-latest -> gpt-sol-latest）
  let rest = trimmed;
  while (rest.includes('/')) {
    const slashIdx = rest.indexOf('/');
    rest = rest.slice(slashIdx + 1);
    if (rest !== '') addVariants(rest);
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
      // 优先查在线同步缓存，再查离线快照
      const onlinePMap = onlineByProvider.get(pLower) ?? onlineByProvider.get(mapped);
      if (onlinePMap !== undefined) {
        for (const c of candidates) {
          const hit = onlinePMap.get(c.toLowerCase());
          if (hit !== undefined) return hit;
        }
      }
      const pMap = byProvider.get(pLower) ?? byProvider.get(mapped);
      if (pMap !== undefined) {
        for (const c of candidates) {
          const hit = pMap.get(c.toLowerCase());
          if (hit !== undefined) return hit;
        }
      }
    }

    for (const c of candidates) {
      const hit = onlineByModel.get(c.toLowerCase());
      if (hit !== undefined) return hit;
    }

    for (const c of candidates) {
      const hit = byModel.get(c.toLowerCase());
      if (hit !== undefined) return hit;
    }

    // 兜底 1：内置官方决策/嵌入/新模型单价
    for (const c of candidates) {
      const builtin = BUILTIN_FALLBACK_RATES[c.toLowerCase()];
      if (builtin !== undefined) return makeBuiltinPriceTable(builtin);
    }

    // 兜底 1.5：明确标明免费的模型（*-free / *:free）记为 $0/$0 而非缺价
    if (/(?::free|-free)$/i.test(model.trim())) {
      return makeBuiltinPriceTable({ input: 0, output: 0 });
    }

    // 兜底 2：同家族最长前缀匹配（例如 grok-4.20-0309 -> grok-4.20 / grok-4）
    const base = candidates[candidates.length - 1] ?? candidates[0] ?? '';
    if (base.length >= 4) {
      let bestKey = '';
      let bestTable: PriceTable | undefined;
      for (const [k, table] of byModel.entries()) {
        if (
          k.length >= 4 &&
          (base.startsWith(`${k}-`) || base.startsWith(`${k}.`) || k.startsWith(`${base}-`) || k.startsWith(`${base}.`))
        ) {
          if (k.length > bestKey.length) {
            bestKey = k;
            bestTable = table;
          }
        }
      }
      if (bestTable !== undefined) return bestTable;
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
