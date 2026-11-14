/**
 * metering/pricing.ts —— 通用价格引擎（**不含任何 provider 知识**）。
 *
 * 唯一事实来源：docs/design/60-billing-and-dogfooding.md §4.1（定价）。
 * provider 侧的价格数据放在 `providers/<provider>/pricing.json`，由各自的 loader
 * （如 providers/deepseek/pricing.ts）包成本文件里的 PriceTable 再注入进来。
 * 本文件只认 PriceTable，不知道 DeepSeek/OpenAI 的存在。
 *
 * ## 五条必须记住的规则（改这个文件前先读）
 *
 * 1. **上游不会告诉你这笔命中了哪个档位**。provider 响应里只有用量数字，没有
 *    "this request was billed at off-peak" 这种字段；峰/谷完全由我们按**请求
 *    时间戳**自己算（峰谷时段、星期几、法定节假日、调休上班日，见 resolvePrice）。
 *    这正是 price_snapshot 要记 tier / window / rule_effective_from / holiday 的
 *    原因——没有这些，每笔成本都不可解释、不可对账。
 * 2. **同一个 ts 只解析一次价格**：resolvePrice 对 (table, ts, opts) 是纯函数。
 *    流式请求跨峰谷边界时我们**不按 chunk 拆分计费**——一次请求一个档位，按请求
 *    开始时间定档。取舍：拆分需要把每个 chunk 的时间戳传进来（流式管线里 chunk
 *    没有可靠时间戳，只有到达时间，而到达时间受网络抖动影响），且会让"一次请求的
 *    费用"不再是一个数，对账和预算都更难。Phase 1 取简单可解释。
 * 3. **价格变更不追溯改写历史**（60 §4.1）：UsageRecord 只留 token + price_snapshot，
 *    改价后重算用的是"事件时间对应的单价版本"，不是当前价。所以 backfillCost
 *     永远用 `record.ts` 解析，**绝不用 now**；也所以 applyPricingRefresh 只允许
 *    新增表版本、不允许改旧版本（append-only）。
 * 4. **金额是 USD 浮点，不是整数微美元**。60 §4.1 要求 cost_micros，但那是**持久层**
 *    的事；本文件算的是管道中间值。Phase 1 单次请求的量级（几分钱）用 float64 的
 *    相对误差在 1e-15，远小于任何计价粒度（最小 slot 价 $0.003 / 1M token ≈ 一次
 *    请求的 1e-9 美元）。真正要累加百万笔做汇总时，才在 storage 层转 micros。
 * 5. **token 槽位的费率单位固定是「每 1M tokens」**（TOKEN_PRICE_UNIT）。所有 LLM
 *    厂商都按 1M tokens 报价（DeepSeek/OpenAI/Anthropic 无一例外），所以把它定成
 *    引擎常量而不是每张表配一个 scale——PriceTable.unit = "USD per 1M tokens" 只是
 *    这句话的人类可读副本，解析器不读它。若某厂商按 1K tokens 报价，由 loader 先把
 *    费率换算成每 1M 再进表（一行乘法），引擎只认一种 scale：混用两种 scale 比
 *    换算更容易出错。非 token 槽位的 scale 写在 slot 名里（per_10000_characters /
 *    per_hour / per_image / per_request），见 NON_TOKEN_SLOT_SCALE。
 *
 * ## 与 DeepSeek 余额的对账关系（repo owner 结论）
 * DeepSeek 暴露 `GET /user/balance`（Bearer 鉴权），返回
 * `{"is_available":bool,"balance_infos":[{"currency":"CNY"|"USD",
 * "total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}`
 * （金额是**字符串**，不是数字）。它是"实际扣费"的真值源：我们 computeCost 算出来
 * 的是**估算**（基于上游自报 usage + 静态价格表），余额差是**事实**。两者不一致时
 * 的排查顺序：① usage 口径（cache_read 是否含在 input_tokens 里，60 §4 规则 2
 * 待验证）→ ② 档位（tier/window/holiday 是否判对）→ ③ 表版本（是否用了旧的
 * effective_from）。本文件不实现 balance 调用方（在 live 冒烟测试里实测并记录）。
 */

import type { CanonicalUsage, UsageUnits } from '../ir/index.js';
import { zeroCost } from './usage-record.js';
import type { UsageCostBreakdown, UsageRecord } from './usage-record.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 费用计算状态。 */
export type CostStatus = 'priced' | 'pending_price' | 'unpriced';

/**
 * 双口径费用（45 §7.2 的运行时形态）。
 *
 * - `cash`：实际现金成本。订阅路径恒 0（钱已经按月/年付过了）。
 * - `as_api`：等价 API 用量价值。**订阅路径也照算**——否则订阅请求在成本报表里会
 *   "消失"，看不出它到底消耗了多少上游额度；as_api 也是拿自估 usage 兜底时的唯一口径。
 * - `status`：见下方三个取值的说明。
 */
export interface UsageCost {
  cash: UsageCostBreakdown;
  as_api: UsageCostBreakdown;
  status: CostStatus;
}

/** 时段窗口（半开区间 [start, end)，按 tz 解释）。 */
export interface PriceWindow {
  /** "HH:mm" 当日时刻（含），按 tz 解释。 */
  start: string;
  /** "HH:mm" 当日时刻（不含）；`end <= start` 表示跨零点。 */
  end: string;
  /** IANA 时区（如 "Asia/Shanghai"）。**时区换算必须用 Intl，禁止手算 UTC+8**——
   *  夏令时/历史偏移会让手算错，而 Intl 自带 tzdb。 */
  tz: string;
  /** 命中档名，如 "peak" / "off_peak"。 */
  tier: string;
  /** 该窗口费率（每单位价格，单位见文件头的 TOKEN_PRICE_UNIT / NON_TOKEN_SLOT_SCALE）。 */
  rates: Record<string, number>;
  /** 1=周一..7=周日（ISO）；缺省 = 每天。 */
  days_of_week?: number[];
  /** 排除的 ISO 日期（如中国法定节假日）。 */
  exclude_dates?: string[];
}

/**
 * 规则集：一整套时段窗口的**生效区间**。
 *
 * 为什么要在 entry.time_windows 之上再加一层：峰谷规则本身也会改。典型如 DeepSeek
 * 2026-08-17 上线峰谷计价、2026-08-23 起改成"周末全天低谷"——同一个 entry 的费率
 * 没变，但**窗口集合**变了。若只有一层 windows，"改规则"就只能新增一个 entry，
 * 而 entry 还带着 rates，于是同一份费率要复制两份，改价时容易漏改其中一份。
 * 拆开后：entry 管"费率什么时候有效"，rule_set 管"这套窗口什么时候有效"。
 */
export interface PriceRuleSet {
  /** ISO date（含）。 */
  effective_from: string;
  /** ISO date（不含）；缺省 = 至今。 */
  effective_to?: string;
  windows: PriceWindow[];
}

/** 一条价格条目（append-only：同一 slot 的旧条目不删，用 effective_from/to 管有效期）。 */
export interface PriceEntry {
  /** ISO date（含）。 */
  effective_from: string;
  /** ISO date（不含）；缺省 = 至今。 */
  effective_to?: string;
  /** 默认档名（窗口之外），缺省 "default"。 */
  tier?: string;
  /** 默认费率（窗口未命中时用；也是节假日强制低谷时用的费率）。 */
  rates: Record<string, number>;
  /** 旧形态：无 rule_sets 时的窗口集合（向后兼容）。 */
  time_windows?: PriceWindow[];
  /** 新形态：按生效日期分组的窗口集合；存在时优先于 time_windows。 */
  rule_sets?: PriceRuleSet[];
}

/** 一张价格表 = 一个 (provider, model) 的全部历史版本。 */
export interface PriceTable {
  /** 表版本号（如 "deepseek-2026-11-14"）。 */
  table_version: string;
  /** 价格来源 URL。 */
  source_url: string;
  /** 抓取日期 ISO date-time。 */
  fetched_at: string;
  /** "USD"。 */
  currency: string;
  /** 如 "USD per 1M tokens" / "USD per 1000 requests"（人类可读声明，解析器不读）。 */
  unit: string;
  entries: PriceEntry[];
}

/** resolvePrice 的解析结果。 */
export interface ResolvedPrice {
  rates: Record<string, number>;
  tier: string;
  /** 命中的窗口（缺省 = 默认档）。克隆而非引用，调用方改不到表。 */
  window?: PriceWindow;
  /** 命中条目的 effective_from。 */
  effective_from: string;
  table_version: string;
  /** 命中的 rule_set 生效日；无 rule_sets 时 = entry.effective_from。 */
  rule_effective_from: string;
  /** 当日命中节假日表 → 强制低谷（跳过窗口匹配）。 */
  holiday?: boolean;
  /** 没有可用的节假日数据（没传 calendar，或传了但当日不在表中）→ 按工作日保守处理。 */
  holiday_unknown?: boolean;
}

/** 写进 UsageRecord 的价格快照（对账/重算的唯一依据）。 */
export interface PriceSnapshot {
  price_table_version: string;
  /** 命中条目的 effective_from。 */
  effective_date: string;
  /** 命中档（off_peak / peak / default）。 */
  tier: string;
  /** 命中的时段窗口（可对账）。 */
  window?: { start: string; end: string; tz: string };
  /** 命中的 rule_set 生效日（峰谷规则本身的版本）。 */
  rule_effective_from?: string;
  holiday?: boolean;
  holiday_unknown?: boolean;
  rates: Record<string, number>;
}

/**
 * 法定节假日 / 调休上班日日历。
 *
 * **只做数据不做算法**：中国法定节假日的调休规则（哪年国庆连休 8 天、哪个周末要
 * 上班）每年由国务院单独发文，没有可推导的公式，任何"按农历/按固定规则推算"的实现
 * 都会错。所以这里是纯数据表，由外部按年维护/注入（将来可从公共节假日 API 生成，
 * 见 mergeHolidayCalendars）。
 */
export interface HolidayCalendar {
  year: number;
  /** 数据来源（URL 或 "manual"），便于追责。 */
  source: string;
  /** 放假的 ISO 日期，含调休生成的连休。 */
  holidays: string[];
  /** 调休上班的周末日期。 */
  workdays: string[];
}

/** resolvePrice 的可选入参。 */
export interface ResolvePriceOptions {
  /**
   * 预留：将来 rates 支持按 scope 嵌套（`{scope: {slot: price}}`）时启用。
   * 当前 rates 一律是 `{slot: number}`，多模型由调用方传不同的 table，
   * 因此实现不读它——留形参是为了让调用点不必为将来的形态改签名。
   */
  scope?: string;
  /** 法定节假日/调休日历；缺省 = 无节假日数据（此时 holiday_unknown 恒 true）。 */
  holidays?: HolidayCalendar[];
}

/** computeCost 的可选入参。 */
export interface ComputeCostOptions {
  /** 订阅路径：cash 恒 0，as_api 照算。 */
  subscription?: boolean;
}

/** backfillCost 的可选入参。 */
export interface BackfillCostOptions {
  /** 补算历史记录时用的节假日日历（必须覆盖 record.ts 那一年）。 */
  holidays?: HolidayCalendar[];
}

/** 字符启发式估算的方法标识（落进 UsageRecord.estimate_method）。 */
export const CHAR_HEURISTIC_METHOD = 'char_heuristic_v1';

/** token 槽位费率的计价单位：每 1M tokens（理由见文件头规则 5）。 */
export const TOKEN_PRICE_UNIT = 1_000_000;

/** 默认档名（窗口之外）。 */
const DEFAULT_TIER = 'default';

/** 节假日强制低谷时的档名。 */
const OFF_PEAK_TIER = 'off_peak';

/** 调休上班日参与 days_of_week 匹配时一律按周一（规则只分"工作日/周末"两形）。 */
const WORKDAY_ISO_WEEKDAY = 1;

/** 日期不可解析时的保守星期几（周一 = 工作日，可能多计）。 */
const UNKNOWN_ISO_WEEKDAY = 1;

/**
 * 非 token 槽位的计价单位大小（费率是"一整个单位"的价，要先除掉）。
 * slot 名自带 scale 是这个设计的核心：`per_request` 的单位是 1 次请求，
 * `per_10000_characters` 的单位是 1 万字符——名字说清楚，就不必再配一张 scale 表。
 */
const NON_TOKEN_SLOT_SCALE: Record<string, number> = {
  per_request: 1,
  per_10000_characters: 10_000,
  per_hour: 3_600,
  per_image: 1,
};

// ---------------------------------------------------------------------------
// 价格解析
// ---------------------------------------------------------------------------

/**
 * 把 ts 解析成一条价格。
 *
 * 分三步：**先选 entry，再选 rule_set，最后在窗口集合里定档**。
 *
 * 1. **entry 选择**：`effective_from <= utcDate(ts) < effective_to ?? ∞`，多条命中取
 *    effective_from 最大者（append-only 语义：新的覆盖旧的，旧的不删）。日期一律按
 *    **UTC 日期**比较——ISO date 字符串定长，字典序即时间序，不需要 Date 运算。
 *    ⚠️ 已知取舍：DeepSeek 的峰谷体系是"2026-08-17 00:00 **北京时间**"生效的，
 *    而 UTC 日期比较会把边界放在 UTC 00:00，两者相差 8 小时（regime 变更日前一天
 *    16:00–24:00 UTC 这段会落到旧 entry）。接受它的理由：① entry/rule_set 是"表版本"
 *    层面的行政区间，用 UTC 是唯一无歧义的锚，不随窗口 tz 变；② 误落旧档的记录在
 *    snapshot 里留着 `rule_effective_from`，可审计、可按正确表重算；③ 改成按窗口 tz
 *    的当地日期只需动 `utcDate(ts)` 一处，价格表本身不用改。
 * 2. **rule_set 选择**：同上按 UTC 日期比区间，取 effective_from 最大者；没有
 *    rule_sets（或都不命中）时退回 entry.time_windows（向后兼容），再没有就只剩默认档。
 * 3. **定档**：节假日优先（命中 → 强制 off_peak，跳过窗口），否则按窗口的 tz/星期几/
 *    exclude_dates 取**第一个**命中的窗口；都不命中 → entry 的默认档。
 */
export function resolvePrice(
  table: PriceTable,
  ts: number,
  opts?: ResolvePriceOptions,
): ResolvedPrice | undefined {
  // scope 见 ResolvePriceOptions.scope：当前 rates 一律 {slot: number}，不读它。
  // 显式 void 一次，让"不是漏了"在代码里可读（也顺带满足 noUnusedParameters）。
  void opts?.scope;

  const date = utcDate(ts);
  const entry = pickEntry(table.entries, date);
  if (entry === undefined) return undefined;

  const ruleSet = pickRuleSet(entry, date);
  const windows = ruleSet?.windows ?? entry.time_windows ?? [];
  const ruleEffectiveFrom = ruleSet?.effective_from ?? entry.effective_from;

  // 节假日按**当地日期**判定（中国法定节假日是北京日历日）。tz 取规则集第一个窗口的
  // tz：同一套峰谷规则必然处在同一个监管时区（DeepSeek 两套都是 Asia/Shanghai）；
  // 规则集没有窗口（纯默认档）时没有 tz 可用，退回落 UTC 日期。
  const holidayTz = windows[0]?.tz ?? 'UTC';
  const local = zonedParts(ts, holidayTz);
  const dateClass = classifyDate(local.date, opts?.holidays);
  const holidayUnknown = dateClass === 'unknown';

  if (dateClass === 'holiday') {
    // 法定节假日 = 低谷：跳过窗口匹配，费率回落 entry.rates（表内约定的非峰时价），
    // tier 记 off_peak。这是规格的明文规则，不是启发式。
    return {
      rates: { ...entry.rates },
      tier: OFF_PEAK_TIER,
      effective_from: entry.effective_from,
      table_version: table.table_version,
      rule_effective_from: ruleEffectiveFrom,
      holiday: true,
    };
  }

  // 调休上班日：周末被改成上班，按正常工作日匹配窗口（否则 days_of_week [1-5] 会把
  // 它筛掉，白调休）。节假日已在上面返回，不会走到这里。
  const effectiveWeekday = dateClass === 'workday' ? WORKDAY_ISO_WEEKDAY : local.weekday;

  for (const w of windows) {
    // 每个窗口仍按**自己的** tz 取当地时间：规则集内 tz 理论上一致，但不假设。
    const wl = zonedParts(ts, w.tz);
    if (!windowMatches(w, wl, effectiveWeekday)) continue;
    return {
      rates: { ...w.rates },
      tier: w.tier,
      window: cloneWindow(w),
      effective_from: entry.effective_from,
      table_version: table.table_version,
      rule_effective_from: ruleEffectiveFrom,
      ...(holidayUnknown ? { holiday_unknown: true } : {}),
    };
  }

  return {
    rates: { ...entry.rates },
    tier: entry.tier ?? DEFAULT_TIER,
    effective_from: entry.effective_from,
    table_version: table.table_version,
    rule_effective_from: ruleEffectiveFrom,
    ...(holidayUnknown ? { holiday_unknown: true } : {}),
  };
}

/** 取 UTC 日期（"YYYY-MM-DD"）。ISO date 定长，字符串比较即时间比较。 */
function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** 在 entries 里取生效且 effective_from 最大的那条。 */
function pickEntry(entries: PriceEntry[], date: string): PriceEntry | undefined {
  let best: PriceEntry | undefined;
  for (const e of entries) {
    if (e.effective_from > date) continue;
    if (e.effective_to !== undefined && date >= e.effective_to) continue;
    if (best === undefined || e.effective_from > best.effective_from) best = e;
  }
  return best;
}

/** 在 entry.rule_sets 里取生效且 effective_from 最大的那套；没有 rule_sets → undefined。 */
function pickRuleSet(entry: PriceEntry, date: string): PriceRuleSet | undefined {
  if (entry.rule_sets === undefined) return undefined;
  let best: PriceRuleSet | undefined;
  for (const rs of entry.rule_sets) {
    if (rs.effective_from > date) continue;
    if (rs.effective_to !== undefined && date >= rs.effective_to) continue;
    if (best === undefined || rs.effective_from > best.effective_from) best = rs;
  }
  return best;
}

/** 某一时区下的当地日期/时刻/ISO 周几。 */
interface ZonedParts {
  /** "YYYY-MM-DD"（当地日期）。 */
  date: string;
  /** 当日分钟数（0..1439）。 */
  minutes: number;
  /** ISO 周几，1=周一..7=周日。 */
  weekday: number;
}

/**
 * 用 Intl 把 ts 格式化成 tz 下的当地日期与时刻。
 *
 * `hourCycle: 'h23'` 是必须的：只写 `hour12: false` 时部分环境/版本会把午夜格式化成
 * "24"，于是 00:30 变成 24*60+30 分钟，跨零点窗口全盘判错。en-CA locale 输出
 * YYYY-MM-DD（加拿大格式正好是 ISO 序），免去按月/日/年字段拼字符串的顺序猜测。
 *
 * 时区名非法时 Intl 会抛 RangeError——**故意不 catch**：价格表是配置不是用户输入，
 * 静默按 UTC 兜底等于静默算错钱；而 resolvePrice 只跑在异步统计管道里（60 §1），
 * 抛错影响不到任何用户请求。DeepSeek 的 loader 在加载时就校验表结构。
 */
function zonedParts(ts: number, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    hour12: false,
  }).formatToParts(ts);
  const field = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${field('year')}-${field('month')}-${field('day')}`;
  const hour = Number.parseInt(field('hour'), 10);
  const minute = Number.parseInt(field('minute'), 10);
  return { date, minutes: hour * 60 + minute, weekday: isoWeekday(date) };
}

/**
 * ISO 周几（1=周一..7=周日）。
 *
 * 从当地日期字符串算，而不是解析 Intl 的 `weekday: 'short'`（"Mon"/"周一"随 locale
 * 变，还要维护一张映射表）。纯日期算术，不涉及时区偏移，因此不是"手算时区"。
 */
function isoWeekday(isoDate: string): number {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) return UNKNOWN_ISO_WEEKDAY;
  return ((new Date(ms).getUTCDay() + 6) % 7) + 1;
}

/** 窗口是否命中。`effectiveWeekday` 已被调休上班日改写（见 resolvePrice）。 */
function windowMatches(w: PriceWindow, local: ZonedParts, effectiveWeekday: number): boolean {
  if (w.exclude_dates !== undefined && w.exclude_dates.includes(local.date)) return false;
  if (w.days_of_week !== undefined && !w.days_of_week.includes(effectiveWeekday)) return false;
  const span = windowSpan(w.start, w.end);
  if (span === undefined) return false;
  if (span.end <= span.start) {
    // 跨零点（含 end === start 表示全天）：>= start 或 < end。
    return local.minutes >= span.start || local.minutes < span.end;
  }
  return local.minutes >= span.start && local.minutes < span.end;
}

/** 解析 "HH:mm" 成当日分钟数；写法非法 → undefined（该窗口视为不命中，不抛错）。 */
function windowSpan(start: string, end: string): { start: number; end: number } | undefined {
  const s = parseHhMm(start);
  const e = parseHhMm(end);
  if (s === undefined || e === undefined) return undefined;
  return { start: s, end: e };
}

function parseHhMm(value: string): number | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return undefined;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (h > 23 || min > 59) return undefined;
  return h * 60 + min;
}

/** 某一日期在节假日语义下的分类。 */
type DateClass = 'holiday' | 'workday' | 'unknown';

/**
 * 判定当地日期是节假日 / 调休上班日 / 未知。
 *
 * 冲突时（同一日期既在 holidays 又在 workdays，通常是维护失误）**按 workday 处理**：
 * 未知/缺数据时保守 = 可能多计，绝不允许静默按节假日放过（少收钱是单向不可逆的）。
 * 没传 calendar 同样返回 'unknown'——"没有数据"和"数据说不是节假日"是两回事，
 * 前者必须在 snapshot 里留 holiday_unknown 痕迹。
 */
function classifyDate(date: string, calendars?: HolidayCalendar[]): DateClass {
  if (calendars === undefined) return 'unknown';
  let holiday = false;
  for (const c of calendars) {
    if (c.workdays.includes(date)) return 'workday';
    if (c.holidays.includes(date)) holiday = true;
  }
  return holiday ? 'holiday' : 'unknown';
}

/**
 * 合并多份节假日日历（按 year 分组，holidays/workdays 取并集，日期排序去重）。
 *
 * 纯函数，无 IO：预留给"从公共节假日 API 生成日历"的入口——抓取、校验、落文件都在
 * 调用方，这里只负责把多来源（官方 + 第三方 + 手补）合成一份不重复的注入数据。
 * source 取第一个非空值（按输入序），便于追溯"这份数据最初是谁给的"。
 */
export function mergeHolidayCalendars(calendars: HolidayCalendar[]): HolidayCalendar[] {
  const byYear = new Map<number, HolidayCalendar>();
  for (const c of calendars) {
    const acc = byYear.get(c.year);
    if (acc === undefined) {
      byYear.set(c.year, {
        year: c.year,
        source: c.source,
        holidays: sortedUnique(c.holidays),
        workdays: sortedUnique(c.workdays),
      });
      continue;
    }
    acc.holidays = sortedUnique([...acc.holidays, ...c.holidays]);
    acc.workdays = sortedUnique([...acc.workdays, ...c.workdays]);
    if (acc.source === '' && c.source !== '') acc.source = c.source;
  }
  return [...byYear.values()];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function cloneWindow(w: PriceWindow): PriceWindow {
  return {
    start: w.start,
    end: w.end,
    tz: w.tz,
    tier: w.tier,
    rates: { ...w.rates },
    ...(w.days_of_week === undefined ? {} : { days_of_week: [...w.days_of_week] }),
    ...(w.exclude_dates === undefined ? {} : { exclude_dates: [...w.exclude_dates] }),
  };
}

/** 从 ResolvedPrice 生成要落库的价格快照。只有 true 的布尔才落字段（false 是绝大多数）。 */
export function priceSnapshotFrom(price: ResolvedPrice): PriceSnapshot {
  return {
    price_table_version: price.table_version,
    effective_date: price.effective_from,
    tier: price.tier,
    ...(price.window === undefined
      ? {}
      : { window: { start: price.window.start, end: price.window.end, tz: price.window.tz } }),
    rule_effective_from: price.rule_effective_from,
    ...(price.holiday === true ? { holiday: true } : {}),
    ...(price.holiday_unknown === true ? { holiday_unknown: true } : {}),
    rates: { ...price.rates },
  };
}

// ---------------------------------------------------------------------------
// 费用计算
// ---------------------------------------------------------------------------

/**
 * 算一笔费用。
 *
 * `cash` 与 `as_api` **必须用同一次 resolvePrice 的结果**（同档费率）——实现上就是
 * 同一个 price 对象算两遍（subscription 时 cash 归零），不存在"两个档位"的可能。
 *
 * status 语义（三个状态是**正交**的两问：有没有用量？有没有价格？）：
 * - `priced`：有价格**且** usage 有内容，费用算出来了（subscription 路径也算 priced，
 *   as_api 算成了）；
 * - `pending_price`：usage 有内容但没价格——等 backfill 或等定价表补上；
 * - `unpriced`：usage 没内容（R2 的"未知"是省略键，不是 0），没什么可算的。
 *
 * ⚠️ 为什么"有价格但 usage 没内容"也判 `unpriced` 而不是 `priced`（$0）：上游漏报
 * usage 时（流式没开 include_usage、末 chunk 没带、Gemini 的 known quirk），这一笔的
 * 真实费用是**未知**的，不是 0。如果记成 `priced` + total 0，整条请求会在成本报表里
 * 静默变成"免费请求"——少收钱是单向不可逆的，而且没有任何告警。宁可标成 unpriced 让
 * 它对账时显眼，也不要一个看起来很正常的 $0.00。
 */
export function computeCost(
  usage: CanonicalUsage,
  price: ResolvedPrice | undefined,
  opts?: ComputeCostOptions,
): UsageCost {
  if (!hasUsage(usage)) {
    // 没用量可算：不管有没有价格都是 unpriced（现金/等值口径都留 0，不猜）。
    return { cash: zeroCost(), as_api: zeroCost(), status: 'unpriced' };
  }
  if (price === undefined) {
    return { cash: zeroCost(), as_api: zeroCost(), status: 'pending_price' };
  }
  const subscription = opts?.subscription === true;
  // 价格拿得到但**没有任何用量**（上游没给 usage、也没有可估算的文本）：
  // 记 unpriced 而不是 priced——全 0 的"已计价"会被读成"这次请求免费"，
  // 而事实是"没东西可计"（与 pending_price 的区别：那个是缺价格，这个是缺用量）。
  if (!hasUsage(usage)) {
    return { cash: zeroCost(), as_api: zeroCost(), status: 'unpriced' };
  }
  const asApi = breakdownFor(usage, price.rates);
  return {
    // 订阅路径：现金恒 0（钱已经按月/年付过了），但 as_api 照算——否则订阅请求在
    // 成本报表里会"消失"，看不出它到底消耗了多少上游额度。
    cash: subscription ? zeroCost() : breakdownFor(usage, price.rates),
    as_api: asApi,
    status: 'priced',
  };
}

/** usage 是否有内容：units 里至少有一个计量键（含上游明确给的 0）。 */
function hasUsage(usage: CanonicalUsage): boolean {
  return Object.keys(usage.units).length > 0;
}

/** 按费率算一份费用拆分。 */
function breakdownFor(usage: CanonicalUsage, rates: Record<string, number>): UsageCostBreakdown {
  const b = zeroCost();
  const t = usage.units.tokens;
  if (t !== undefined) {
    // input 拆成 cache hit / miss 两半。cache_read_tokens 可能大于 input_tokens
    // （各 provider 口径不一，60 §4 规则 2 待验证），负的 miss 没有意义，夹到 0。
    const miss = Math.max(0, t.input_tokens - t.cache_read_tokens);
    b.input = tokenCost(miss, rates, 'input_cache_miss');
    b.cache_read = tokenCost(t.cache_read_tokens, rates, 'input_cache_hit');
    b.output = tokenCost(t.output_tokens, rates, 'output');
    // 只有该 slot 存在才计 cache write（多数厂商没有，缺了就是 0，不抛错）。
    b.cache_write = tokenCost(t.cache_write_tokens, rates, 'input_cache_write');
    // reasoning 恒 0：DeepSeek 官方口径 reasoning tokens 含在 completion_tokens 里
    // （Anthropic 同），单独计就是双算。若将来某厂商把 reasoning 单独出价，加 slot 时
    // **必须**同时确认它的 output_tokens 不含 reasoning，否则这里会变成双算。
    b.reasoning = 0;
  }
  b.builtin_tools = nonTokenCost(usage.units, rates);
  b.total =
    b.input + b.output + b.cache_read + b.cache_write + b.reasoning + b.builtin_tools + b.external;
  return b;
}

/** token 槽位：费率单位是每 1M tokens（TOKEN_PRICE_UNIT）。slot 缺失 → 0。 */
function tokenCost(tokens: number, rates: Record<string, number>, slot: string): number {
  if (!Object.hasOwn(rates, slot)) return 0;
  return (tokens / TOKEN_PRICE_UNIT) * rates[slot];
}

/**
 * 非 token 单位（按次 / 按字符 / 按音频时长 / 按张）。
 *
 * 全部记进 `builtin_tools`：UsageCostBreakdown 没有为它们单独开槽（§3 的字段集是
 * Phase 1 定稿的，改它要走 PR），而它们共同的形态是"不是输入输出 token 的计费形态"，
 * builtin_tools 是既有字段里唯一语义接近的桶。`external` 刻意不写——它专属于
 * `external_cost[]`（上游直接报的第三方费用），价格引擎不碰。
 *
 * 单位换算按 slot 名自带的 scale（NON_TOKEN_SLOT_SCALE）：费率是"一整个单位"的价，
 * 因此要先除掉。`per_10000_characters: 0.45` 表示 1 万字符 0.45 美元，**不是**
 * 每字符 0.45 美元——差 1 万倍，这是本函数最容易错的一处。
 */
function nonTokenCost(units: UsageUnits, rates: Record<string, number>): number {
  let sum = 0;
  if (units.requests !== undefined) {
    sum += nonTokenSlotCost(units.requests, rates, 'per_request');
  }
  if (units.characters !== undefined) {
    sum += nonTokenSlotCost(units.characters.billed, rates, 'per_10000_characters');
  }
  if (units.audio_seconds !== undefined) {
    sum += nonTokenSlotCost(units.audio_seconds.billed, rates, 'per_hour');
  }
  if (units.images !== undefined) {
    // 只计 generated：DeepSeek 没有图片编辑定价，edited 单独计会凭空造钱。
    sum += nonTokenSlotCost(units.images.generated, rates, 'per_image');
  }
  return sum;
}

function nonTokenSlotCost(quantity: number, rates: Record<string, number>, slot: string): number {
  if (!Object.hasOwn(rates, slot)) return 0;
  const scale = NON_TOKEN_SLOT_SCALE[slot] ?? 1;
  return (quantity / scale) * rates[slot];
}

// ---------------------------------------------------------------------------
// 用量估算（as_api 在「上游没给 usage」时的兜底）
// ---------------------------------------------------------------------------

/**
 * 字符启发式 token 估算。
 *
 * CJK 字符每字 1 token，其余每 4 字符 1 token（Math.ceil）——对应主流 BPE 分词器
 * 的两个经验值（中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token）。按**码点**迭代
 * （for...of），emoji 不会被劈成半个代理对。
 *
 * 精度定位：这是 as_api 的兜底，不是计费真值。误差可能到 ±30%，因此
 * UsageRecord.estimate_method 必须标注方法（R2：估算值必须与真实值可区分），
 * 聚合侧可对 estimated 来源的请求单独告警（60 §7 待验证清单第 5 条）。
 */
export function estimateUsage(text: string): { tokens: number; method: string } {
  let wide = 0;
  let other = 0;
  for (const ch of text) {
    if (isWideChar(ch.codePointAt(0) ?? 0)) wide += 1;
    else other += 1;
  }
  return { tokens: wide + Math.ceil(other / 4), method: CHAR_HEURISTIC_METHOD };
}

/** 是否"宽字符"（中日韩表意文字/假名/全角形态，约 1 字 = 1 token）。 */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 符号与标点（。、「」…）
    (cp >= 0x3040 && cp <= 0x309f) || // 平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 统一表意文字扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字（主体）
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意文字
    (cp >= 0xff00 && cp <= 0xffef) // 全角 forms（全角字母/数字/标点）
  );
}

/**
 * 估算一份 canonical usage（estimateUsage 的 record 级包装）。
 *
 * 给 S10 用：上游完全没给 usage 时，用 prompt 原文估一份 input_tokens 出来算 as_api，
 * 并把 estimate_method 标注到 UsageRecord 上。**估算只能在请求时做**——UsageRecord
 * 刻意不存正文（隐私），事后补算拿不到原文。
 */
export function estimateCanonicalUsage(text: string): {
  usage: CanonicalUsage;
  estimate_method: string;
} {
  const est = estimateUsage(text);
  return {
    usage: {
      units: {
        tokens: {
          input_tokens: est.tokens,
          output_tokens: 0,
          total_tokens: est.tokens,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
      },
      source: 'estimated',
      precision: 'approx',
    },
    estimate_method: est.method,
  };
}

// ---------------------------------------------------------------------------
// 事后补算
// ---------------------------------------------------------------------------

/**
 * 用**请求时点**的价格补算一条历史记录。
 *
 * 三条硬规则：
 * 1. **不可变**：记录已有 price_snapshot 且 cost.status !== 'pending_price' → 原样返回，
 *    不重算。已定过的价就是历史事实，改表不改旧账。
 * 2. **绝不用"当前价格"补历史**：解析用的是 `record.ts`（事件时间），不是 now。
 *    价格表是 append-only 的，所以同一 ts 在新旧表下会解析到不同的 entry——
 *    这正是重算不污染历史的原因（测试 backfill-历史价格 覆盖这条）。
 * 3. **补不了估算**：只重算 record.usage 里已有的 units。上游没给 usage 时 as_api 的
 *    估算需要 prompt 原文，而 UsageRecord 刻意不存正文，所以事后补不了——
 *    这也是 estimate_method 必须在请求时标注的原因。同理，usage 为空的记录补不出
 *    任何费用，只归一 status、不落快照（见函数体）。
 */
export function backfillCost(
  record: UsageRecord,
  tableFor: (model: string) => PriceTable | undefined,
  now: number,
  opts?: BackfillCostOptions,
): UsageRecord {
  if (record.price_snapshot != null && record.cost.status !== 'pending_price') {
    return record;
  }
  // 没有用量就没有可补算的费用（R2：未知≠0）。此时**不写 price_snapshot /
  // backfilled_at**——落了快照就等于宣称"这条按 X 价算过"，而实际上一分钱都没算；
  // 只把 status 归一成 unpriced，让它在对账时显眼（同 computeCost 的注释）。
  if (!hasUsage(record.usage)) {
    return { ...record, cost: computeCost(record.usage, undefined) };
  }
  const table = tableFor(record.model);
  const price = table === undefined ? undefined : resolvePrice(table, record.ts, opts);
  if (price === undefined) {
    // 表里没有覆盖 record.ts 的条目（或该模型根本没表）：只把 status 归一成
    // pending_price，**不写 backfilled_at**——下次还能重试。
    return { ...record, cost: computeCost(record.usage, undefined) };
  }
  return {
    ...record,
    cost: computeCost(record.usage, price),
    price_snapshot: priceSnapshotFrom(price),
    backfilled_at: now,
    backfill_price_table_version: price.table_version,
  };
}

// ---------------------------------------------------------------------------
// 价格表刷新（占位）
// ---------------------------------------------------------------------------

/** AI 辅助刷新价格表的提案（**提案**，不是执行）。 */
export interface PricingRefreshProposal {
  table_version: string;
  source_url: string;
  fetched_at: string;
  /** 人类可读的变更说明（如 "deepseek-flash off-peak input 0.15 → 0.12"）。 */
  changes: string[];
}

/**
 * 应用一份刷新提案——**故意不实现**。
 *
 * 规则：AI/脚本可以**提案**（抓页面、算 diff、生成 changes），但**执行**必须由仓库
 * 主人确认后**新增一个表版本**（新的 table_version + 新的 effective_from），
 * **绝不改旧版本**。理由：旧版本的条目是历史记录的计价依据（60 §4.1「定价变更不
 * 追溯改写历史」），改一个数字就会让所有引用它的历史对账全部失真；而 append-only
 * 让"这条记录当时用的什么价"永远可查。
 */
export function applyPricingRefresh(_p: PricingRefreshProposal): void {
  throw new Error('not implemented: AI 辅助刷新由仓库主人确认后新增表版本，不改旧版本');
}
