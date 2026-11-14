/**
 * providers/deepseek/pricing.ts —— DeepSeek 静态价格表 loader。
 *
 * 数据在 `pricing.json`（同目录），本文件只负责：读文件 → 校验结构 → 把每个 model
 * 包成一张完整的 `PriceTable`（metering/pricing.ts 的通用类型）。
 *
 * 唯一事实来源：DeepSeek 官方价格页 https://api-docs.deepseek.com/quick_start/pricing
 * （2026-11-14 核对），峰谷时段定义另见
 * https://finance.sina.com.cn/tech/digi/2026-08-17/doc-ininqpev7133165.shtml 等第三方
 * 报道（官方价格页只列价格不列时段）。要点：
 *   - Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 *     excluding Chinese public holidays = **北京时间 09:00-12:00 与 14:00-18:00**；
 *   - off-peak = peak 的一半（表里 off_peak 是 entry 默认费率，peak 在窗口里）；
 *   - 峰谷体系 2026-08-17 00:00（北京时间）生效；**周末全天低谷**规则 2026-08-23 00:00
 *     起生效（此前周末也分峰谷）。官方明确"新规则生效前产生的费用，仍按原计费标准
 *     结算"（祖父规则）——所以这里是两条 rule_set 而不是一条，见 pricing.json。
 *
 * ## 三个实现决定（为什么这么写）
 *
 * 1. **为什么是 readFileSync + JSON.parse，不是 `import ... with { type: 'json' }`**：
 *    import attributes 需要 tsconfig 开 `resolveJsonModule`，而 tsconfig 不在本线程
 *    写权限内（也不该为一个数据文件改全仓编译选项）。ESM 下 `createRequire` 同样是
 *    绕路。`new URL('./pricing.json', import.meta.url)` 不依赖 `process.cwd()`，
 *    无论从仓库根、dist/ 还是 vitest 里跑都能定位到同目录的 json。
 * 2. **为什么没有模块级缓存**：价格表是会被注入的共享数据（S10 启动时 load 一次，
 *    经 DI 传给管道），在模块里藏一份单例会让"换表版本"必须重启进程，也没法在测试里
 *    隔离。热路径请自己 load 一次再注入；`deepseekPriceTableFor(model, tables)` 的
 *    第二个参数就是给这种用法留的。
 * 3. **为什么加载时校验结构**：价格表是配置不是用户输入，一个错字（tz 写成
 *    "Asia/Shanghai "、rates 里多个 0）会让计费**静默**算错。所以在这里fail fast，
 *    把错误暴露在启动阶段，而不是等到某条记录对不上账。
 *
 * ## tools 段与通用 slot 的映射（重要）
 * `tools` 里的价格**不是** metering/pricing.ts 认识的 slot 名（通用引擎只认
 * per_request / per_10000_characters / per_hour / per_image）。映射关系由 S10 的
 * builtin tool 计费侧做，本 loader 只原样交出数字：
 *   - `search_per_1000_requests` / `fetch_per_1000_requests` → per_request（除 1000）
 *   - `ocr_per_1000_pages` → 目前 UsageUnits 没有 pages 槽（见 ocr.ts 的论证），
 *     由 builtin_tool_usage 单独记，不走通用 slot；
 *   - `tts_per_10000_characters` → per_10000_characters（**已含 1 万字符的单位**，
 *     通用引擎会再除 10000，所以映射时要把"每 1000 字符"换算成"每 1 万字符"）
 *   - `asr_per_hour` → per_hour（通用引擎按秒除 3600）。
 * `*_discounted` 是错峰折扣价，与峰谷体系同源：命中 peak 窗口时用非折扣价，
 * 否则用折扣价——由调用方按 resolvePrice 的 tier 决定取哪一个。
 *
 * ## 法定节假日
 * 窗口里的 `exclude_dates: []` 是空占位：中国法定节假日每年由国务院单独发文，
 * 没有可推算的公式，**必须按年维护**。真正的维护入口是
 * metering/pricing.ts 的 `HolidayCalendar`（可注入，支持多来源合并），本表不改。
 * 一旦注入了节假日日历，`exclude_dates` 就只是 per-window 的逃生门。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PriceEntry, PriceRuleSet, PriceTable, PriceWindow } from '../../metering/pricing.js';

// AI 辅助刷新的契约在通用引擎里定义（append-only 规则的单一事实来源），这里再出口，
// 让"改 DeepSeek 价格"的调用方不必反向 import metering/。
export type { PricingRefreshProposal } from '../../metering/pricing.js';
export { applyPricingRefresh } from '../../metering/pricing.js';

/** pricing.json 的路径（相对本文件，不依赖 process.cwd()）。 */
const PRICING_JSON_PATH = fileURLToPath(new URL('./pricing.json', import.meta.url));

/** loadDeepSeekPriceTables 的产物。 */
export interface DeepSeekPriceTables {
  /** model id → 价格表。多模型由调用方按 model 取不同的表（通用引擎不认 scope）。 */
  tables: Record<string, PriceTable>;
  /** 独立工具端点的单价（slot 名不是通用 slot，映射见文件头）。 */
  tools: Record<string, number>;
}

/** pricing.json 的期望结构（加载时逐字段校验）。 */
interface DeepSeekPricingFile {
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
 * 每次调用重新读文件（无模块级单例，见文件头决定 2）。抛带路径的 Error 而不是
 * 返回 undefined：价格表缺失/损坏必须让启动失败，不能让管道带着坏表跑。
 */
export function loadDeepSeekPriceTables(): DeepSeekPriceTables {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PRICING_JSON_PATH, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`deepseek pricing.json 读取/解析失败: ${String(err)}`, { cause: err });
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
 * 取某个 model 的价格表；没有定价的 model 返回 undefined（调用方记 pending_price /
 * unpriced，见 60 §4.1 的 is_priceable 预检）。
 *
 * `tables` 可传预加载的结果，避免每次调用重读文件；省略时当场 load（便利路径，
 * 不要放进热循环）。第二参**两种形态都收**：`loadDeepSeekPriceTables()` 的 bundle
 * （`{tables, tools}`）或已拆好的 `Record<string, PriceTable>`——调用方手上最自然的
 * 就是前者，逼他们写 `.tables` 只会让每个调用点都多个可能写错的后缀。
 */
export function deepseekPriceTableFor(
  model: string,
  tables?: DeepSeekPriceTables | Record<string, PriceTable>,
): PriceTable | undefined {
  const loaded = tables ?? loadDeepSeekPriceTables();
  const record = isPriceTablesBundle(loaded) ? loaded.tables : loaded;
  return record[model];
}

/**
 * 区分第二参的两种形态（bundle vs 已拆好的 Record）。
 *
 * 判据是 `tables` 字段的值是不是"字典"：bundle 的 `tables` 是 `model → PriceTable`，
 * 而 PriceTable 自己没有 `tables` 字段。不用 `'tables' in value` 单独判断是因为
 * `Record<string, PriceTable>` 带索引签名，`in` 窄化不掉它（TS7053）；也不假设
 * "model 不会叫 tools"——那是靠运气。
 */
function isPriceTablesBundle(
  value: DeepSeekPriceTables | Record<string, PriceTable>,
): value is DeepSeekPriceTables {
  const inner: unknown = (value as { tables?: unknown }).tables;
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner);
}

// ---------------------------------------------------------------------------
// 结构校验（fail fast，见文件头决定 3）
// ---------------------------------------------------------------------------

function parsePricingFile(raw: unknown): DeepSeekPricingFile {
  const root = asRecord(raw, '$');
  const file: DeepSeekPricingFile = {
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
      throw new Error(`deepseek pricing: $.models.${model}.entries 不能为空`);
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
        throw new Error(`deepseek pricing: ${path}.days_of_week[${i}] 必须是 1..7 的 ISO 周几`);
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

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`deepseek pricing: ${path} 必须是 object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`deepseek pricing: ${path} 必须是 array`);
  }
  return value;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`deepseek pricing: ${path} 必须是非空字符串`);
  }
  return value;
}

function asFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`deepseek pricing: ${path} 必须是有限数字（收到 ${typeof value}）`);
  }
  return value;
}

function asRates(value: unknown, path: string): Record<string, number> {
  const rec = asRecord(value, path);
  const rates: Record<string, number> = {};
  for (const [slot, price] of Object.entries(rec)) {
    rates[slot] = asFiniteNumber(price, `${path}.${slot}`);
  }
  return rates;
}

function asIsoDate(value: unknown, path: string): string {
  const s = asNonEmptyString(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`deepseek pricing: ${path} 必须是 YYYY-MM-DD（收到 "${s}"）`);
  }
  return s;
}

function asHhMm(value: unknown, path: string): string {
  const s = asNonEmptyString(value, path);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    throw new Error(`deepseek pricing: ${path} 必须是 "HH:mm"（收到 "${s}"）`);
  }
  return s;
}

function asTimeZone(value: unknown, path: string): string {
  const s = asNonEmptyString(value, path);
  try {
    // 构造一次 formatter 让 Intl 用 tzdb 校验；非法时区在这里就炸，而不是等某条
    // 记录对不上账（resolvePrice 故意不 catch Intl 的 RangeError，见那里的注释）。
    new Intl.DateTimeFormat('en-CA', { timeZone: s });
  } catch {
    throw new Error(`deepseek pricing: ${path} 不是合法的 IANA 时区（收到 "${s}"）`);
  }
  return s;
}
