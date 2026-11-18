/**
 * catalog/projection.ts —— 列表响应的**字段投影**（紧凑默认 + 显式展开）。
 *
 * ## 为什么列表端点默认不返回全量
 *
 * 一份 `CanonicalModelRecord` 里最重的四样东西是 `provenance`（逐字段来源 + 各层状态 +
 * `last_error`）、`access_paths[].quirks`（每条路径十来条）、`pricing`（`holidays` 37 天 +
 * `rule_sets` + `tiers`）与 `raw.upstream`。它们在**详情**里有真实读者（排障、对账），
 * 在**列表**里一个都没有：客户端问"你有哪些模型"时想知道的只有 id / 名字 / provider /
 * 窗口 / 主要能力 / 价格量级。把这些塞进 `data[]` 的后果是每个模型重复一遍，响应体积
 * 翻几倍，还把"哪个模型窗口多大"淹在噪声里。
 *
 * ## 三条取全量的路（都不破坏老客户端）
 *
 * 1. `GET /v1/models/{id}`：详情端点本来就返回全量；
 * 2. `?expand=<分组>`：紧凑集 + 分组追加（`provenance` / `pricing` / `access_paths` /
 *    `constraints` / `parameters` / `limits` / `description` / `raw` / `retired` / `all`）；
 * 3. `?fields=<键,键>`：显式白名单（要什么给什么，不多给）。
 *
 * **向后兼容**：OpenAI 兼容四键（`id` / `object` / `created` / `owned_by`）与 `provider`
 * 永远在投影结果里——老客户端只读 `data[].id` 的行为一字不变。
 *
 * ## 省略与置空是两回事
 *
 * 源记录里没有的键**不出现**在投影结果里（不是 `key: undefined`）。JSON 序列化会丢掉
 * undefined，但内存里的对象会留着这个键，`Object.keys()` 与 `'k' in obj` 都会被骗
 * （ir/usage.ts 的 R2 同立场）。
 */

import type { CanonicalModelRecord, ModelListItem, ModelPricing, ModelQuery } from './types.js';

/** OpenAI 兼容四键 + provider：任何投影下都必须存在（drop-in 兼容的底线）。 */
const ALWAYS_KEYS: ReadonlyArray<keyof CanonicalModelRecord> = [
  'id',
  'object',
  'created',
  'owned_by',
  'provider',
];

/**
 * 紧凑字段集：`GET /v1/models` 的默认形状。
 *
 * 选入标准只有一个——**客户端挑模型时真的会读**。名字/家族帮人认模型，窗口与输出上限
 * 是路由判据，模态把 chat 与工具端点分开，能力布尔是过滤结果的复述，`pricing` 给价格
 * 量级（剪过肥的版本，见 prunePricing），`namespaced_ids` 是"这个模型还有第二个名字"
 * 的唯一发现途径。其余全部进分组、按需取。
 */
export const COMPACT_FIELDS: ReadonlyArray<keyof CanonicalModelRecord> = [
  ...ALWAYS_KEYS,
  'name',
  'family',
  'context_window',
  'max_output_tokens',
  'input_modalities',
  'output_modalities',
  'modalities',
  'availability',
  'namespaced_ids',
  'aliases',
  'temperature',
  'structured_output',
  'tool_call',
  'reasoning',
  'attachment',
  'effort',
  'pricing',
];

/** 可展开分组 → 追加的顶层键（`all` = 全量，含紧凑集里已有的）。 */
export const EXPAND_GROUPS: Readonly<Record<string, ReadonlyArray<keyof CanonicalModelRecord>>> = {
  description: [
    'description',
    'release_date',
    'knowledge_cutoff',
    'license',
    'open_weights',
    'tokenizer',
  ],
  parameters: ['supported_parameters'],
  limits: ['per_request_limits', 'concurrency', 'benchmarks'],
  constraints: ['constraints'],
  access_paths: ['access_paths'],
  provenance: ['provenance'],
  raw: ['raw'],
  retired: ['retired'],
  all: [],
};

/** 全部可投影的顶层键（`expand=all` 与未知分组校验用）。 */
export const PROJECTABLE_FIELDS: ReadonlyArray<keyof CanonicalModelRecord> = [
  ...COMPACT_FIELDS,
  'description',
  'release_date',
  'knowledge_cutoff',
  'license',
  'open_weights',
  'tokenizer',
  'supported_parameters',
  'per_request_limits',
  'concurrency',
  'benchmarks',
  'constraints',
  'access_paths',
  'provenance',
  'raw',
  'retired',
];

/**
 * 一条记录 → 列表元素。
 *
 * 纯函数：不改源记录（调用方可能还要用全量做过滤/排序），返回新对象。
 */
export function projectRecord(record: CanonicalModelRecord, query: ModelQuery): ModelListItem {
  const keys = resolveKeys(query);
  const fullPricing = wantsFullPricing(query);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    // 省略与置空是两回事（见文件头）
    if (value === undefined) continue;
    out[key] = key === 'pricing' && !fullPricing ? prunePricing(value as ModelPricing) : value;
  }
  // `id` / `object` / `owned_by` / `provider` 恒有值，ALWAYS_KEYS 保证它们在；
  // 这里再兜一次，避免将来有人改了 ALWAYS_KEYS 却没人发现
  out['id'] = record.id;
  out['object'] = record.object;
  out['owned_by'] = record.owned_by;
  out['provider'] = record.provider;
  return out as ModelListItem;
}

/** 本次查询要投影出哪些顶层键。 */
function resolveKeys(query: ModelQuery): ReadonlyArray<keyof CanonicalModelRecord> {
  if (query.fields !== undefined && query.fields.length > 0) {
    // 显式白名单：调用方点菜，不做"贴心补全"（点了 id 就只给 id + 兼容四键）
    const asked = query.fields.filter((f) => isProjectable(f));
    return [...new Set([...ALWAYS_KEYS, ...asked])] as Array<keyof CanonicalModelRecord>;
  }
  const expanded = query.expand ?? [];
  if (expanded.includes('all')) return PROJECTABLE_FIELDS;
  if (expanded.length === 0) return COMPACT_FIELDS;
  const extra: Array<keyof CanonicalModelRecord> = [];
  for (const group of expanded) {
    const keys = EXPAND_GROUPS[group];
    if (keys === undefined || keys.length === 0) continue; // 未知分组：query.ts 已拦，这里双保险
    extra.push(...keys);
  }
  return [...new Set([...COMPACT_FIELDS, ...extra])] as Array<keyof CanonicalModelRecord>;
}

/**
 * `pricing` 是否要给全量。
 *
 * 判据是"显式要过"：`?expand=pricing` / `?expand=all` / `?fields=pricing`。紧凑集里那个
 * 是剪过肥的摘要（`prunePricing`），不是同一份数据的另一种序列化。
 */
function wantsFullPricing(query: ModelQuery): boolean {
  if (query.fields?.includes('pricing') === true) return true;
  const expanded = query.expand ?? [];
  return expanded.includes('all') || expanded.includes('pricing');
}

/**
 * 价格摘要：只留费率与出处，剪掉 `tiers` / `rule_sets` / `holidays` / `as_api_reference` / `tools`。
 *
 * 剪掉的都是**规则**而不是**数字**：峰谷时段窗口、节假日日历、生效区间是计费引擎的输入，
 * 客户端挑模型时只需要"每 1M token 多少钱"这一个量级。全量仍在详情端点与
 * `?expand=pricing` 里，一行没丢。
 */
export function prunePricing(pricing: ModelPricing): ModelPricing {
  return {
    currency: pricing.currency,
    unit: pricing.unit,
    table_version: pricing.table_version,
    source_url: pricing.source_url,
    fetched_at: pricing.fetched_at,
    rates: { ...pricing.rates },
    tiers: [],
    rule_sets: [],
  };
}

function isProjectable(field: string): field is keyof CanonicalModelRecord {
  return (PROJECTABLE_FIELDS as ReadonlyArray<string>).includes(field);
}
