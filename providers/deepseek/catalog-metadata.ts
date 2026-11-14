/**
 * providers/deepseek/catalog-metadata.ts —— DeepSeek 贡献给 canonical 模型目录的元数据。
 *
 * ## 这个文件放什么、不放什么
 *
 * **只放 models.dev 快照给不了的东西**（vendor 数据见 `catalog/vendor/models-dev.json`，
 * 由 scripts/fetch-models-dev.mjs 生成）：
 *   - `concurrency`：官方价格页口径（flash 2500 / v4-pro 500），models.dev 没有；
 *   - `pricing`：带峰谷 tiers + 规则集生效日期 + 节假日引用的完整价格（models.dev 只有
 *     一条扁平费率，且**不含峰谷**——DeepSeek 官方价格页才有时段规则）；
 *   - `aliases`：从 `deepseekRouteAliases()` 推（不手抄，避免路由表与目录漂移）；
 *   - `retired`：`deepseek-chat` / `deepseek-reasoner` 的退役说明；
 *   - `constraints` 的**官方语义文字**（值在能力矩阵里，这里只补"这句话是什么意思"）。
 *
 * family / release_date / knowledge_cutoff / temperature / structured_output /
 * open_weights / description **不在这里重复**——它们来自 models.dev 离线快照。在两处
 * 各写一份必然漂移，而离线快照是可以脚本刷新的。
 *
 * ## 上游源（`createDeepSeekUpstreamSource`）为什么顺手刷新能力矩阵
 *
 * `/v1/models` 的响应与 `ir/capability.ts` 的能力矩阵必须同源（任务书硬约束）。上游
 * `GET /models` 的窗口/模态/effort/constraints 如果直接合并进响应，就会出现两个写者：
 * discovery 刷新矩阵、目录又采信上游快照，任一人落后一点响应就与路由不一致。所以上游
 * 数据进入系统只有**一个入口**——`load()` 里先把响应写回矩阵，再把它当元数据快照交出；
 * 目录随后从矩阵读这些字段（矩阵永远是最新的那一份）。
 */

import type { Clock } from '../../di/ports.js';
import type {
  HolidayCalendarRef,
  ModelMetadata,
  ModelMetadataSource,
  ModelMetadataSnapshot,
  ModelPricing,
  PriceRuleSetInfo,
  PriceTier,
} from '../../catalog/index.js';
import type { CapabilityRegistryWriter, DeepSeekModelsResponse } from './discovery.js';
import { DeepSeekModelDiscovery } from './discovery.js';
import {
  DEEPSEEK_ACCESS_PATHS,
  DEEPSEEK_MODELS,
  DEEPSEEK_MODEL_META,
  deepseekRouteAliases,
} from './profile.js';
import { loadDeepSeekPriceTables, type DeepSeekPriceTables } from './pricing.js';
import { loadDeepSeekHolidayCalendars } from './holidays.js';
import type { PriceEntry, PriceWindow } from '../../metering/pricing.js';

/** 离线层来源 id（进 `provenance.fields`）。 */
export const DEEPSEEK_CATALOG_SOURCE_ID = 'offline:deepseek-static';

/** 上游层来源 id（进 `provenance.fields`）。 */
export const DEEPSEEK_UPSTREAM_SOURCE_ID = 'upstream:deepseek';

/**
 * 已退役的模型/别名。
 *
 * `deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 15:59 UTC 全部退役
 * （https://api-docs.deepseek.com/news/news260424 ）。**实测：退役名仍返回 200 并被
 * 静默路由到 `deepseek-flash`**（响应 `model` 字段证实）——退役公告与线上行为不一致。
 * 网关的立场是**不登记**这两个别名（路由层直接拒绝），目录里只留一条退役说明，让
 * `GET /v1/models/deepseek-chat` 的 404 解释得清楚，而不是一个干巴巴的 not_found。
 */
export const DEEPSEEK_RETIRED_MODELS: ReadonlyArray<{
  id: string;
  retired_at: string;
  note: string;
  succeeded_by: string;
}> = [
  {
    id: 'deepseek-chat',
    retired_at: '2026-07-24T15:59:00Z',
    note:
      '已于 2026-07-24 15:59 UTC 退役（官方公告 /news/news260424）。实测退役名仍返回 200 ' +
      '并被静默路由到 deepseek-flash，故网关不登记该别名：路由层直接拒绝，不做静默重路由。',
    succeeded_by: DEEPSEEK_MODELS.flash,
  },
  {
    id: 'deepseek-reasoner',
    retired_at: '2026-07-24T15:59:00Z',
    note:
      '已于 2026-07-24 15:59 UTC 退役（官方公告 /news/news260424）。实测退役名仍返回 200 ' +
      '并被静默路由到 deepseek-flash，故网关不登记该别名：路由层直接拒绝，不做静默重路由。',
    succeeded_by: DEEPSEEK_MODELS.flash,
  },
];

/**
 * 上游行为约束的官方语义（https://api-docs.deepseek.com/api/list-models ）。
 *
 * 只有声明方（provider）能给这段文字——目录/矩阵只存机读值。分开存放是为了让"值"与
 * "值的解释"各有单一事实来源：值在能力矩阵（discovery 可刷新），解释在这里。
 */
export const DEEPSEEK_CONSTRAINT_SEMANTICS: Readonly<{
  system_prompt_update: Record<string, string>;
  tool_update: Record<string, string>;
}> = {
  system_prompt_update: {
    'leading-only':
      '只有对话开头的 system prompt 生效；历史中后出现的 system 消息不被当作系统提示更新，' +
      '要改系统提示只能改开头那条。',
    'in-history':
      'system 消息可以追加进历史；历史中最后一条 system 消息提供完整生效的系统提示，' +
      '替换更早的所有 system 消息。',
  },
  tool_update: {
    'addition-only': '后续轮次只能新增工具，不能移除或修改已声明的工具。',
    'leading-only': '只有对话首次请求的工具声明生效，后续变更被上游忽略。',
  },
};

/** 静态目录数据（每个模型一条；字段见文件头"放什么"）。 */
export function deepseekCatalogMetadata(): ModelMetadata[] {
  const out: ModelMetadata[] = [];
  const aliasesByModel = aliasesGroupedByModel();

  for (const model of Object.values(DEEPSEEK_MODELS)) {
    const meta = DEEPSEEK_MODEL_META[model];
    if (meta === undefined) continue;
    out.push({
      id: model,
      provider: 'deepseek',
      concurrency: {
        max_concurrent_requests: model === DEEPSEEK_MODELS.flash ? 2500 : 500,
        source: 'DeepSeek 官方价格页（2026-11-14 核对）',
      },
      per_request_limits: {
        max_input_tokens: meta.context_window - meta.max_output_tokens,
        max_output_tokens: meta.max_output_tokens,
      },
      // 约束的机读值在能力矩阵里（单一事实来源）；这里只补官方语义文字
      constraints: [
        {
          dialect: 'anthropic.messages',
          system_prompt_update: meta.constraints.system_prompt_update,
          tool_update: meta.constraints.tool_update,
          semantics: {
            system_prompt_update:
              DEEPSEEK_CONSTRAINT_SEMANTICS.system_prompt_update[
                meta.constraints.system_prompt_update
              ],
            tool_update: DEEPSEEK_CONSTRAINT_SEMANTICS.tool_update[meta.constraints.tool_update],
          },
          source: 'upstream-declared',
        },
      ],
      // 两个 dialect 共用同一份并发限额（官方按模型给，不按 dialect 给）
      access_path_limits: {
        [DEEPSEEK_ACCESS_PATHS.openaiChat]: {
          concurrency: {
            max_concurrent_requests: model === DEEPSEEK_MODELS.flash ? 2500 : 500,
            source: 'DeepSeek 官方价格页（2026-11-14 核对）',
          },
        },
        [DEEPSEEK_ACCESS_PATHS.anthropicMessages]: {
          concurrency: {
            max_concurrent_requests: model === DEEPSEEK_MODELS.flash ? 2500 : 500,
            source: 'DeepSeek 官方价格页（2026-11-14 核对）',
          },
        },
      },
      ...(aliasesByModel[model] === undefined ? {} : { aliases: aliasesByModel[model] }),
    });
  }

  for (const retired of DEEPSEEK_RETIRED_MODELS) {
    out.push({
      id: retired.id,
      provider: 'deepseek',
      retired: {
        retired_at: retired.retired_at,
        note: retired.note,
        succeeded_by: retired.succeeded_by,
      },
    });
  }

  return out;
}

/** 从路由表反推「模型 → 别名」（含 `-messages` 那条 Anthropic 方言别名）。 */
function aliasesGroupedByModel(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [alias, spec] of Object.entries(deepseekRouteAliases())) {
    for (const target of spec.targets) {
      if (alias === target.model) continue; // 本体不是自己的别名
      out[target.model] = [...(out[target.model] ?? []), alias];
    }
  }
  return out;
}

export interface DeepSeekCatalogSourceOptions {
  /** 价格表（缺省读仓库内 pricing.json）。 */
  tables?: DeepSeekPriceTables;
  /** 节假日日历（缺省读仓库内 holidays.json）。 */
  holidays?: HolidayCalendarRef[];
  clock?: Clock;
}

/**
 * DeepSeek 的**离线层**元数据来源。
 *
 * 价格表/节假日表加载失败不该让端点挂掉：退化成"没有价格的那一层"（其余字段照常），
 * 与 pricing-service.ts 的 safeHolidayCalendars 同一立场。
 */
export function createDeepSeekCatalogSource(
  options: DeepSeekCatalogSourceOptions = {},
): ModelMetadataSource {
  const clock = options.clock;
  return {
    id: DEEPSEEK_CATALOG_SOURCE_ID,
    layer: 'offline',
    providers: ['deepseek'],
    async load(): Promise<ModelMetadataSnapshot> {
      const tables = options.tables ?? safePriceTables();
      const holidays = options.holidays ?? safeHolidayRefs();
      const models = deepseekCatalogMetadata().map((meta) => ({
        ...meta,
        // 价格表读不到时该字段整体缺席（不造 0 价），其余字段照常
        ...(tables === undefined ? {} : { pricing: deepseekPricingFor(meta.id, tables, holidays) }),
      }));
      return {
        sourceId: DEEPSEEK_CATALOG_SOURCE_ID,
        fetchedAt: snapshotFetchedAt(tables, clock),
        models,
      };
    },
  };
}

export interface DeepSeekUpstreamSourceOptions {
  discovery: DeepSeekModelDiscovery;
  /** 写回目标（能力矩阵）；上游运行时字段进入系统的唯一入口。 */
  capabilityRegistry: CapabilityRegistryWriter;
  clock: Clock;
}

/**
 * DeepSeek 的**上游层**元数据来源（`GET /models`）。
 *
 * `load()` 做两件事（顺序固定）：① 把响应写回能力矩阵；② 把响应当元数据快照交出。
 * 同一次 HTTP 两用，一个 tick 只打一次上游。
 */
export function createDeepSeekUpstreamSource(
  options: DeepSeekUpstreamSourceOptions,
): ModelMetadataSource {
  return {
    id: DEEPSEEK_UPSTREAM_SOURCE_ID,
    layer: 'upstream',
    providers: ['deepseek'],
    async load(): Promise<ModelMetadataSnapshot> {
      const response: DeepSeekModelsResponse = await options.discovery.discover();
      await options.discovery.refresh(options.capabilityRegistry, response);
      return {
        sourceId: DEEPSEEK_UPSTREAM_SOURCE_ID,
        fetchedAt: options.clock.now(),
        models: response.data.map((meta) => ({
          id: meta.id,
          provider: 'deepseek',
          ...(meta.name === undefined ? {} : { name: meta.name }),
          ...(meta.raw === undefined ? {} : { raw: meta.raw }),
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 价格表 → ModelPricing
// ---------------------------------------------------------------------------

/**
 * `PriceTable` → canonical `ModelPricing`（**原样搬字段，不重算任何数字**）。
 *
 * 峰谷规则本身不在 `/models` 里（已核实：没有任何官方 API 提供峰谷规则或实时价格），
 * 唯一来源是官方价格页 → 仓库内静态表。这里只做可解释的展示：窗口、规则集生效日期、
 * 节假日日历引用全部保留，让"这个费率什么时候有效"在响应里就能看出来。
 */
export function deepseekPricingFor(
  model: string,
  tables: DeepSeekPriceTables,
  holidays: HolidayCalendarRef[],
): ModelPricing | undefined {
  const table = tables.tables[model];
  if (table === undefined) return undefined;
  const entry = currentEntry(table.entries);
  if (entry === undefined) return undefined;

  const ruleSets: PriceRuleSetInfo[] = (entry.rule_sets ?? []).map((rs) => ({
    effective_from: rs.effective_from,
    ...(rs.effective_to === undefined ? {} : { effective_to: rs.effective_to }),
    tiers: rs.windows.map(toPriceTier),
  }));
  // 旧形态（无 rule_sets）也支持：窗口集合直接当 tiers
  if (ruleSets.length === 0 && entry.time_windows !== undefined) {
    ruleSets.push({
      effective_from: entry.effective_from,
      tiers: entry.time_windows.map(toPriceTier),
    });
  }

  return {
    currency: table.currency,
    unit: table.unit,
    table_version: table.table_version,
    source_url: table.source_url,
    fetched_at: table.fetched_at,
    rates: { ...entry.rates },
    tiers: ruleSets.flatMap((rs) => rs.tiers),
    rule_sets: ruleSets,
    ...(holidays.length === 0 ? {} : { holidays: holidays[0] }),
    as_api_reference: {
      rates: { ...entry.rates },
      // DeepSeek 两条 access path 都是 API key 路径，没有订阅路径；将来接入订阅
      // （OAuth）路径时把对应 access path  id 加进来，现金口径即恒 0
      subscription_paths: [],
      note:
        '订阅路径现金恒 0、等值 API 用量照算（60-billing-and-dogfooding.md §4.1 双口径）；' +
        '此处给出 as_api 参考费率，避免订阅请求在成本报表里消失。',
    },
    ...(Object.keys(tables.tools).length === 0 ? {} : { tools: { ...tables.tools } }),
  };
}

function toPriceTier(window: PriceWindow): PriceTier {
  return {
    tier: window.tier,
    start: window.start,
    end: window.end,
    tz: window.tz,
    ...(window.days_of_week === undefined ? {} : { days_of_week: [...window.days_of_week] }),
    ...(window.exclude_dates === undefined ? {} : { exclude_dates: [...window.exclude_dates] }),
    rates: { ...window.rates },
  };
}

/** 取当前生效的 entry（`effective_from` 最大且未过期）；表是 append-only 的。 */
function currentEntry(entries: PriceEntry[]): PriceEntry | undefined {
  const today = new Date().toISOString().slice(0, 10);
  let best: PriceEntry | undefined;
  for (const e of entries) {
    if (e.effective_from > today) continue;
    if (e.effective_to !== undefined && today >= e.effective_to) continue;
    if (best === undefined || e.effective_from > best.effective_from) best = e;
  }
  return best ?? entries[0];
}

/** 离线快照的"抓取时间"：优先用价格表自己记的 fetched_at（数据日期比加载时间有用）。 */
function snapshotFetchedAt(
  tables: DeepSeekPriceTables | undefined,
  clock: Clock | undefined,
): number {
  const first = tables === undefined ? undefined : Object.values(tables.tables)[0];
  if (first === undefined) return clock?.now() ?? Date.now();
  const ms = Date.parse(`${first.fetched_at}T00:00:00Z`);
  return Number.isNaN(ms) ? (clock?.now() ?? Date.now()) : ms;
}

/** 价格表加载失败 → 该层缺席（不影响端点）。 */
function safePriceTables(): DeepSeekPriceTables | undefined {
  try {
    return loadDeepSeekPriceTables();
  } catch {
    return undefined;
  }
}

function safeHolidayRefs(): HolidayCalendarRef[] {
  try {
    return loadDeepSeekHolidayCalendars().map((c) => ({
      year: c.year,
      source: c.source,
      holidays: [...c.holidays],
      workdays: [...c.workdays],
    }));
  } catch {
    return [];
  }
}
