/**
 * providers/mimo/pricing.ts —— MiMo 静态价格表 loader。
 *
 * 数据在 `pricing.json`（同目录），本文件只负责：读文件 → 校验结构 → 把每个 model
 * 包成一张完整的 `PriceTable`（metering/pricing.ts 的通用类型）。
 *
 * 唯一事实来源：MiMo 官方按量计费页
 * https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go （页面标注「更新时间 2026 年
 * 10 月 21 日」，2026-11-16 逐格核对）。**没有**用任何第三方价格源——官方页同时给出
 * 国内（CNY）与海外（USD）两张表，本仓库的 key 是 Token Plan 中国区（host
 * `token-plan-cn.xiaomimimo.com`、key 前缀 `tp-`），所以取**国内 CNY 表**。
 * 海外 USD 表的数字在同一页上，将来若要接海外 host，加一个 currency 维度即可
 * （PriceTable.currency 是单值，混用两种币种会让 computeCost 的求和失去意义）。
 *
 * ## 官方页的关键计费说明（逐条落库）
 *
 * 1. **按量计费与 Token Plan 不互通**：「按量计费使用开放平台普通 API Key，并按实际
 *    Token 用量消耗账户余额，与 Token Plan 套餐额度不互通」。这正是仓库主人
 *    「订阅路径 cash 恒 0、as_api 照算」规则的官方依据——两条路的钱走不同渠道。
 * 2. key 前缀是官方明文的分辨判据：Token Plan 专属 key 是 `tp-`（官方文档
 *    「本接口需使用 Token Plan 专属 API Key `tp-`」），普通按量 key 是 `sk-`
 *    （「本接口需使用普通 API Key `sk-`」）。判据实现在 credentials/resolver.ts 的
 *    `BILLING_MODE_BY_KEY_PREFIX`，不在本文件——key 形态是凭据层的事。
 * 3. **缓存写入限时免费** → `input_cache_write: 0`。MiMo 的 usage 里本来也没有
 *    cache_write 字段，这个 0 只是把官方立场写进表里，不是凭空造一个计费项。
 * 4. **ASR 按输入音频时长计费**，「时长统计精确到秒，最终折算成小时计费」→
 *    `per_hour` 槽（通用引擎按秒除 3600，见 NON_TOKEN_SLOT_SCALE）。我们的
 *    `usage.seconds` 就是上游自报的秒数，口径一致。
 * 5. **TTS 系列限时免费**（三个变体都标「限时免费」）→ `per_10000_characters: 0`。
 *    记 0 而不是省略：省略会让「官方说免费」这件事只存在于注释里，而 0 是一句
 *    可被断言、可被对账的声明。限时意味着会变，所以表带 `fetched_at`。
 * 6. **联网搜索按调用次数独立计费**（国内 ¥16/1000 次）→ 进 `tools` 段。
 *    本仓库没有实现 MiMo 的联网搜索工具，所以这个数字**只登记不使用**
 *    （与 DeepSeek 侧 search_per_1000_requests 的同款立场：价格先落库，能力后接）。
 *
 * ## 为什么 `rule_sets` 是空数组、tier 叫 `realtime`
 *
 * 官方页把语言模型分成**实时推理**与**批量推理**两档，但这不是时段窗口——
 * 它是请求模式（批量是另一套 API 形态），同一个时刻两种都可用。因此：
 *   - `rule_sets: []`：没有任何 time window 可匹配，字段保留是为了与
 *     providers/deepseek/pricing.json 形状一致（loader 对两种形态都收），空数组
 *     明确表示「无时段规则」而不是「忘了写」；
 *   - `tier: 'realtime'`：本表全部是实时推理价。批量推理价（Flash ¥0.5/¥1、Pro
 *     ¥1.5/¥3）**不在表里**——我们不发批量请求，登记一份用不到的价只会让
 *     「这个数是怎么来的」变难答。将来接批量 API 时按请求模式选表，不要塞进
 *     同一张表的 entry（entry 是 append-only 的时间区间，表达不了并发两种模式）。
 *
 * MiMo **没有峰谷时段**（官方页无任何时段表述），所以本 loader 不注入节假日日历：
 * 节假日只在其被用于「强制低谷」时影响价格，没有低谷体系时它不该参与决策
 * （holiday_unknown 会照实记进 snapshot，见 metering/pricing.ts）。
 *
 * ## 与 DeepSeek loader 的关系
 *
 * 结构校验逐字段照抄 providers/deepseek/pricing.ts（fail-fast 的同款立场：一个错字
 * 会让计费静默算错，必须暴露在启动阶段）。**没有**抽象出一个共享基类——两家的
 * `tools` 段语义不同（DeepSeek 的 ocr 没有 pages 槽、MiMo 的 TTS 是 0 价），硬合
 * 到一起会出现「为什么这个方法在 DeepSeek 那边这么做」的分裂。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PriceEntry, PriceRuleSet, PriceTable, PriceWindow } from '../../metering/pricing.js';

/** pricing.json 的路径（相对本文件，不依赖 process.cwd()）。 */
const PRICING_JSON_PATH = fileURLToPath(new URL('./pricing.json', import.meta.url));

/** loadMiMoPriceTables 的产物。 */
export interface MiMoPriceTables {
  /** model id → 价格表。多模型由调用方按 model 取不同的表（通用引擎不认 scope）。 */
  tables: Record<string, PriceTable>;
  /** 独立工具端点的单价（slot 名不是通用 slot，映射见文件头）。 */
  tools: Record<string, number>;
}

/** pricing.json 的期望结构（加载时逐字段校验）。 */
interface MiMoPricingFile {
  table_version: string;
  source_url: string;
  fetched_at: string;
  currency: string;
  unit: string;
  models: Record<string, { entries: PriceEntry[] }>;
  tools: Record<string, number>;
}

/**
 * 读 pricing.json 并校验结构。
 *
 * 每次调用重新读文件（无模块级单例，同 DeepSeek loader 的决定 2）。抛带路径的 Error
 * 而不是返回 undefined：价格表缺失/损坏必须让启动失败，不能让管道带着坏表跑。
 */
export function loadMiMoPriceTables(): MiMoPriceTables {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PRICING_JSON_PATH, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`mimo pricing.json 读取/解析失败: ${String(err)}`, { cause: err });
  }
  const file = parsePricingFile(raw);
  const tables: Record<string, PriceTable> = {};
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
  return { tables, tools: file.tools };
}

/**
 * 取某个 model 的价格表；没有定价的 model 返回 undefined（调用方记 pending_price）。
 *
 * 第二参**两种形态都收**（bundle 或已拆好的 Record），理由同 DeepSeek loader：
 * 调用方手上最自然的就是前者，逼他们写 `.tables` 只会让每个调用点都多个可能写错的后缀。
 */
export function mimoPriceTableFor(
  model: string,
  tables?: MiMoPriceTables | Record<string, PriceTable>,
): PriceTable | undefined {
  const loaded = tables ?? loadMiMoPriceTables();
  const record = isPriceTablesBundle(loaded) ? loaded.tables : loaded;
  return record[model];
}

/** 区分第二参的两种形态（bundle vs 已拆好的 Record）。 */
function isPriceTablesBundle(
  value: MiMoPriceTables | Record<string, PriceTable>,
): value is MiMoPriceTables {
  const inner: unknown = (value as { tables?: unknown }).tables;
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}

// ---------------------------------------------------------------------------
// 结构校验（fail fast）
// ---------------------------------------------------------------------------

function parsePricingFile(raw: unknown): MiMoPricingFile {
  const root = asRecord(raw, '$');
  const file: MiMoPricingFile = {
    table_version: asNonEmptyString(root.table_version, '$.table_version'),
    source_url: asNonEmptyString(root.source_url, '$.source_url'),
    fetched_at: asNonEmptyString(root.fetched_at, '$.fetched_at'),
    currency: asNonEmptyString(root.currency, '$.currency'),
    unit: asNonEmptyString(root.unit, '$.unit'),
    models: {},
    tools: {},
  };
  const models = asRecord(root.models, '$.models');
  for (const [model, spec] of Object.entries(models)) {
    const m = asRecord(spec, `$.models.${model}`);
    const entries = asArray(m.entries, `$.models.${model}.entries`);
    if (entries.length === 0) {
      throw new Error(`mimo pricing: $.models.${model}.entries 不能为空`);
    }
    file.models[model] = {
      entries: entries.map((e, i) => parseEntry(e, `$.models.${model}.entries[${i}]`)),
    };
  }
  const tools = asRecord(root.tools, '$.tools');
  for (const [name, value] of Object.entries(tools)) {
    file.tools[name] = asFiniteNumber(value, `$.tools.${name}`);
  }
  return file;
}

function parseEntry(raw: unknown, path: string): PriceEntry {
  const e = asRecord(raw, path);
  const entry: PriceEntry = {
    effective_from: asIsoDate(e.effective_from, `${path}.effective_from`),
    rates: asRates(e.rates, `${path}.rates`),
  };
  if (e.effective_to !== undefined) {
    entry.effective_to = asIsoDate(e.effective_to, `${path}.effective_to`);
  }
  if (e.tier !== undefined) entry.tier = asNonEmptyString(e.tier, `${path}.tier`);
  if (e.time_windows !== undefined) {
    entry.time_windows = asArray(e.time_windows, `${path}.time_windows`).map((w, i) =>
      parseWindow(w, `${path}.time_windows[${i}]`),
    );
  }
  if (e.rule_sets !== undefined) {
    entry.rule_sets = asArray(e.rule_sets, `${path}.rule_sets`).map((rs, i) =>
      parseRuleSet(rs, `${path}.rule_sets[${i}]`),
    );
  }
  return entry;
}

function parseRuleSet(raw: unknown, path: string): PriceRuleSet {
  const rs = asRecord(raw, path);
  const ruleSet: PriceRuleSet = {
    effective_from: asIsoDate(rs.effective_from, `${path}.effective_from`),
    windows: asArray(rs.windows, `${path}.windows`).map((w, i) =>
      parseWindow(w, `${path}.windows[${i}]`),
    ),
  };
  if (rs.effective_to !== undefined) {
    ruleSet.effective_to = asIsoDate(rs.effective_to, `${path}.effective_to`);
  }
  return ruleSet;
}

function parseWindow(raw: unknown, path: string): PriceWindow {
  const w = asRecord(raw, path);
  const window: PriceWindow = {
    start: asHhMm(w.start, `${path}.start`),
    end: asHhMm(w.end, `${path}.end`),
    tz: asTimeZone(w.tz, `${path}.tz`),
    tier: asNonEmptyString(w.tier, `${path}.tier`),
    rates: asRates(w.rates, `${path}.rates`),
  };
  if (w.days_of_week !== undefined) {
    window.days_of_week = asArray(w.days_of_week, `${path}.days_of_week`).map((d, i) => {
      const n = asFiniteNumber(d, `${path}.days_of_week[${i}]`);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        throw new Error(`mimo pricing: ${path}.days_of_week[${i}] 必须是 1..7 的 ISO 周几`);
      }
      return n;
    });
  }
  if (w.exclude_dates !== undefined) {
    window.exclude_dates = asArray(w.exclude_dates, `${path}.exclude_dates`).map((d, i) =>
      asIsoDate(d, `${path}.exclude_dates[${i}]`),
    );
  }
  return window;
}

// ---------------------------------------------------------------------------
// 校验小工具（错误信息带 JSON 路径：价格表错一个字就要能定位到那一格）
// ---------------------------------------------------------------------------

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`mimo pricing: ${path} 应为 JSON 对象`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`mimo pricing: ${path} 应为数组`);
  return v;
}

function asNonEmptyString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new Error(`mimo pricing: ${path} 应为非空字符串`);
  }
  return v;
}

function asFiniteNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`mimo pricing: ${path} 应为有限数字`);
  }
  return v;
}

function asIsoDate(v: unknown, path: string): string {
  const s = asNonEmptyString(v, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`mimo pricing: ${path} 应为 ISO date（YYYY-MM-DD），实际 ${s}`);
  }
  return s;
}

function asHhMm(v: unknown, path: string): string {
  const s = asNonEmptyString(v, path);
  if (!/^\d{2}:\d{2}$/.test(s)) {
    throw new Error(`mimo pricing: ${path} 应为 HH:mm，实际 ${s}`);
  }
  return s;
}

/** IANA 时区名（用 Intl 校验，不手写白名单——tzdb 会变）。 */
function asTimeZone(v: unknown, path: string): string {
  const s = asNonEmptyString(v, path);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
  } catch {
    throw new Error(`mimo pricing: ${path} 不是合法 IANA 时区：${s}`);
  }
  return s;
}

/** 费率表：slot → 非负数字。允许 0（官方限时免费就是 0），不允许负。 */
function asRates(v: unknown, path: string): Record<string, number> {
  const rec = asRecord(v, path);
  const out: Record<string, number> = {};
  for (const [slot, value] of Object.entries(rec)) {
    const n = asFiniteNumber(value, `${path}.${slot}`);
    if (n < 0) throw new Error(`mimo pricing: ${path}.${slot} 不应为负（${n}）`);
    out[slot] = n;
  }
  return out;
}
