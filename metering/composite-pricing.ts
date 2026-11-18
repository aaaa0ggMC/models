/**
 * metering/composite-pricing.ts —— 多维分层聚合定价服务。
 *
 * ## 三级查表优先级
 *
 *   1. **渠道自定义单价（`ChannelPricingResolver.models`）**：管理员在渠道面板为某模型
 *      配置的单价直接覆盖所有上游表，可附带渠道倍率 `multiplier`；
 *   2. **二维 `(provider / access_path, model)` 上游专属定价服务**：按渠道/供应商与模型
 *      二维精确路由（如 DeepSeek 含中国法定节假日与峰谷折扣、MiMo CNY 定价、OpenAI Images）；
 *      兼容无上下文旧测试调用与未标 provider 元数据的桩服务；
 *   3. **models.dev 离线目录兜底定价（`options.fallback`）**：当上游专属服务未覆盖该模型
 *      或自定义兼容渠道走透传模型时，从 models.dev 快照兜底，避免落入 `pending_price`。
 *
 * 若渠道配置了 `multiplier !== 1`，还会对 Tier 2 / Tier 3 解析到的费率统一乘以倍率并
 * 重算 `UsageCost` 与 `price_snapshot`。
 */

import {
  computeCost,
  estimateCanonicalUsage,
  priceSnapshotFrom,
  type ChannelModelRateOverride,
  type ChannelPricingConfig,
  type ChannelPricingResolver,
  type PricingRequest,
  type PricingResult,
  type PricingService,
  type ProviderPricingService,
  type ResolvedPrice,
} from './pricing.js';

export type { ProviderPricingService };

export interface CompositePricingOptions {
  /** Tier 1: 渠道级自定义单价表与倍率解析器。 */
  channelPricing?: ChannelPricingResolver;
  /** Tier 3: 目录兜底定价服务（如 createModelsDevPricingService）。 */
  fallback?: PricingService;
}

function providerFromContext(req: PricingRequest): string | undefined {
  if (req.provider !== undefined && req.provider !== '') return req.provider;
  if (req.access_path !== undefined && req.access_path !== '') {
    const dot = req.access_path.indexOf('.');
    return dot > 0 ? req.access_path.slice(0, dot) : req.access_path;
  }
  return undefined;
}

function matchesServiceContext(svc: ProviderPricingService, req: PricingRequest): boolean {
  if (req.access_path !== undefined && req.access_path !== '' && svc.accessPaths !== undefined) {
    if (svc.accessPaths.includes(req.access_path)) return true;
  }
  const effectiveProvider = providerFromContext(req);
  if (effectiveProvider !== undefined && svc.provider !== undefined) {
    if (svc.provider === effectiveProvider) return true;
  }
  return false;
}

function resolveChannelOverride(
  resolver: ChannelPricingResolver | undefined,
  req: PricingRequest,
): ChannelPricingConfig | undefined {
  if (resolver === undefined) return undefined;
  if (req.access_path !== undefined && req.access_path !== '') {
    const hit = resolver.pricingFor(req.access_path);
    if (hit !== undefined) return hit;
  }
  if (req.provider !== undefined && req.provider !== '') {
    return resolver.pricingFor(req.provider);
  }
  return undefined;
}

function findModelOverride(
  config: ChannelPricingConfig | undefined,
  model: string,
): ChannelModelRateOverride | undefined {
  const models = config?.models;
  if (models === undefined) return undefined;
  if (Object.hasOwn(models, model)) return models[model];
  const lower = model.toLowerCase();
  for (const [k, v] of Object.entries(models)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function buildOverrideRates(
  ov: ChannelModelRateOverride,
  multiplier: number,
): Record<string, number> {
  const rates: Record<string, number> = {};
  if (ov.input !== undefined) {
    rates.input_cache_miss = ov.input * multiplier;
    rates.input_cache_hit = (ov.input_cache_hit ?? ov.input) * multiplier;
  } else if (ov.input_cache_hit !== undefined) {
    rates.input_cache_hit = ov.input_cache_hit * multiplier;
  }
  if (ov.output !== undefined) rates.output = ov.output * multiplier;
  if (ov.cache_write !== undefined) rates.input_cache_write = ov.cache_write * multiplier;
  if (ov.per_request !== undefined) rates.per_request = ov.per_request * multiplier;
  if (ov.per_image !== undefined) rates.per_image = ov.per_image * multiplier;
  if (ov.per_hour !== undefined) rates.per_hour = ov.per_hour * multiplier;
  if (ov.per_10000_characters !== undefined) {
    rates.per_10000_characters = ov.per_10000_characters * multiplier;
  }
  return rates;
}

function validMultiplier(config: ChannelPricingConfig | undefined): number {
  const m = config?.multiplier;
  if (m === undefined || !Number.isFinite(m) || m < 0) return 1;
  return m;
}

function applyMultiplierToResult(
  base: PricingResult,
  req: PricingRequest,
  multiplier: number,
): PricingResult {
  if (multiplier === 1 || base.price_snapshot === null) return base;
  const scaledRates: Record<string, number> = {};
  for (const [slot, val] of Object.entries(base.price_snapshot.rates)) {
    scaledRates[slot] = val * multiplier;
  }
  const scaledPrice: ResolvedPrice = {
    rates: scaledRates,
    tier: `${base.price_snapshot.tier}_x${multiplier}`,
    effective_from: base.price_snapshot.effective_date,
    table_version: base.price_snapshot.price_table_version,
    rule_effective_from:
      base.price_snapshot.rule_effective_from ?? base.price_snapshot.effective_date,
    ...(base.price_snapshot.currency === undefined
      ? {}
      : { currency: base.price_snapshot.currency }),
    ...(base.price_snapshot.holiday === true ? { holiday: true } : {}),
    ...(base.price_snapshot.holiday_unknown === true ? { holiday_unknown: true } : {}),
    ...(base.price_snapshot.window === undefined
      ? {}
      : {
          window: {
            ...base.price_snapshot.window,
            tier: base.price_snapshot.tier,
            rates: scaledRates,
          },
        }),
  };
  const effectiveUsage = base.estimated_usage ?? req.usage;
  const cost = computeCost(effectiveUsage, scaledPrice, {
    ...(req.subscription === undefined ? {} : { subscription: req.subscription }),
  });
  return {
    cost,
    price_snapshot: priceSnapshotFrom(scaledPrice),
    ...(base.estimate_method === undefined ? {} : { estimate_method: base.estimate_method }),
    ...(base.estimated_usage === undefined ? {} : { estimated_usage: base.estimated_usage }),
  };
}

/** 构造多维分级定价服务。 */
export function createCompositePricingService(
  services: readonly ProviderPricingService[],
  options: CompositePricingOptions = {},
): PricingService {
  return {
    price(req: PricingRequest): PricingResult {
      const channelConfig = resolveChannelOverride(options.channelPricing, req);
      const multiplier = validMultiplier(channelConfig);

      // Tier 1: 渠道级单模型自定义单价
      const modelOverride = findModelOverride(channelConfig, req.model);
      if (modelOverride !== undefined) {
        const rates = buildOverrideRates(modelOverride, multiplier);
        const resolved: ResolvedPrice = {
          rates,
          tier: multiplier === 1 ? 'custom' : `custom_x${multiplier}`,
          effective_from: '1970-01-01',
          table_version: 'channel-override',
          rule_effective_from: '1970-01-01',
          currency: channelConfig?.currency ?? 'USD',
        };
        const estimated =
          req.usage.units.tokens === undefined && req.estimateText !== undefined
            ? estimateCanonicalUsage(req.estimateText)
            : undefined;
        const usage =
          estimated === undefined
            ? req.usage
            : { ...req.usage, units: { ...req.usage.units, ...estimated.usage.units } };
        return {
          cost: computeCost(usage, resolved, {
            ...(req.subscription === undefined ? {} : { subscription: req.subscription }),
          }),
          price_snapshot: priceSnapshotFrom(resolved),
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
      }

      // Tier 2: (provider / access_path, model) 二维专属服务匹配
      const ctx = {
        ...(req.provider === undefined ? {} : { provider: req.provider }),
        ...(req.access_path === undefined ? {} : { access_path: req.access_path }),
      };
      const hasContext =
        (req.provider !== undefined && req.provider !== '') ||
        (req.access_path !== undefined && req.access_path !== '');

      let matched: ProviderPricingService | undefined;
      if (hasContext) {
        for (const svc of services) {
          if (
            (svc.provider !== undefined || svc.accessPaths !== undefined) &&
            matchesServiceContext(svc, req) &&
            svc.handles(req.model, ctx)
          ) {
            matched = svc;
            break;
          }
        }
        if (matched === undefined) {
          for (const svc of services) {
            if (
              svc.provider === undefined &&
              svc.accessPaths === undefined &&
              svc.handles(req.model, ctx)
            ) {
              matched = svc;
              break;
            }
          }
        }
      } else {
        for (const svc of services) {
          if (svc.handles(req.model, ctx)) {
            matched = svc;
            break;
          }
        }
      }

      if (matched !== undefined) {
        return applyMultiplierToResult(matched.price(req), req, multiplier);
      }

      // Tier 3: models.dev 目录兜底
      if (options.fallback !== undefined) {
        const fb = options.fallback.price(req);
        if (fb.price_snapshot !== null) {
          return applyMultiplierToResult(fb, req, multiplier);
        }
      }

      const estimated =
        req.usage.units.tokens === undefined && req.estimateText !== undefined
          ? estimateCanonicalUsage(req.estimateText)
          : undefined;
      const effectiveUsage =
        estimated === undefined
          ? req.usage
          : { ...req.usage, units: { ...req.usage.units, ...estimated.usage.units } };

      return {
        cost: computeCost(effectiveUsage, undefined),
        price_snapshot: null,
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
