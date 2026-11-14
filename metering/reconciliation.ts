/**
 * metering/reconciliation.ts —— 区间级对账引擎（上游余额快照 ↔ 我们估算的费用）。
 *
 * 定位：周期任务每 N 分钟打一次上游余额快照，把「区间内余额差」与「区间内我们估算的
 * cash 总和」摆在一起，产出对账记录（估算 vs 事实 + 偏差率 + 告警位）。消费者是看板 /
 * 告警 / 定价表校准，**不影响任何请求结果**（60 §1 的旁路原则：统计管道挂了不阻塞主链路）。
 *
 * 唯一事实来源：仓库主人定的对账规则，三条硬约束如下。
 *
 * 1. **只做区间级对账，绝不把余额差逐笔归因到单个请求**。理由写死在这里，防止后来人
 *    「优化」成逐笔归因：
 *      - 余额端点给的是「当前余额」快照，上游没有 per-request 的扣费流水，单笔扣费额
 *        在上游侧就不可观测；
 *      - 并发下多个请求交错扣费：区间内任意两次快照之间的差，是这窗口里**所有**请求
 *        （含别的 key、别的进程、别的客户端、别的服务端账单周期）扣费的总和，把它摊到
 *        某一笔上等于编造因果；
 *      - 我们的 UsageRecord 有 request_id，上游侧没有对应物，两边对不上号。
 *    所以对账粒度就是「区间」：区间内我们说了算（记录齐全），区间内上游只给一个净值。
 *    能回答的问题是「这个周期我们的估算准不准」，不是「哪一笔算错了」。
 *
 * 2. **分币种、分 granted / topped_up**。DeepSeek 扣费顺序是**赠送余额优先扣、现金后扣**
 *    （官方文档），因此：
 *      - 区间末 − 区间初 = −(granted 消耗 + topped_up 消耗)，一个 total 差里混着两种
 *        性质完全不同的钱；
 *      - 我们的估算只有**现金**口径（UsageRecord.cost.cash.total，USD），所以主比较用
 *        topped_up 侧的差（现金事实）；granted 侧的差单独记录——赠送优先扣会让现金差
 *        看起来偏小（甚至为 0），只看现金差会误判「我们低估了」，实际是赠送在扛。
 *
 * 3. **永不抛**。这是周期任务：一次坏输入（缺快照、乱序、半个 record 对象）不能炸掉
 *    整轮对账。
 *
 * 单位与币种（**换算责任在调用方**）：`estimated_cash` 是 USD（定价表口径），快照里的
 * 金额则是上游报的币种（CNY / USD）。`reconcileInterval` 只按传入的快照算，不做汇率
 * 换算——上游报 CNY 时调用方必须先换成 USD 再喂进来，否则偏差率是两种货币之比，数值上
 * 没有意义。记录里的 `currency` 字段说明该偏差率是基于哪个币种算的。
 *
 * 接线示意（composition-root 的周期任务，本文件不负责装配）：
 * ```ts
 * const snap = await balanceClient.snapshot();               // providers/deepseek/balance.ts
 * for (const info of snap.balance.balance_infos) {
 *   const s: BalanceSnapshot = {
 *     ts: snap.fetched_at,
 *     currency: info.currency,
 *     total: parseDecimalOrZero(info.total_balance),
 *     granted: parseDecimalOrZero(info.granted_balance),
 *     topped_up: parseDecimalOrZero(info.topped_up_balance),
 *     is_available: snap.balance.is_available,
 *   };
 *   // 按 currency 与上一周期的快照配对 → reconcileInterval({ before, after, records, now })
 * }
 * // lowBalanceSignal(本周期快照数组, { minToppedUp: 5 }) → 路由信号 / 请求前预检
 * ```
 */

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/**
 * 一个币种在某一时刻的余额快照。
 *
 * `total` / `granted` / `topped_up` 已是 number（构造快照时用
 * providers/deepseek/balance.ts 的 `parseDecimalOrZero` 转）——对账要的是可加减的数，
 * 字符串留到 wire codec 那一层就够了。
 */
export interface BalanceSnapshot {
  /** 观测时刻（epoch ms），即 DeepSeekBalanceSnapshot.fetched_at。 */
  ts: number;
  /** 币种（CNY / USD；上游没给时是空串，按独立桶处理，不猜）。 */
  currency: string;
  total: number;
  granted: number;
  topped_up: number;
  /** 上游报的账号可用位（本模块不算它，见 lowBalanceSignal 的说明）。 */
  is_available: boolean;
}

/** 一个区间（一个计费周期）的对账结果。 */
export interface ReconciliationRecord {
  from_ts: number;
  to_ts: number;
  /** 本记录基于哪个币种（= before.currency）。 */
  currency: string;
  /**
   * 区间估算：区间内 UsageRecord 的 `cost.cash.total` 之和，单位 **USD**。
   *
   * 不是 USD 时（快照是 CNY）调用方必须先换算——见文件头的「单位与币种」。
   */
  estimated_cash: number;
  /** 区间事实：topped_up 侧余额**下降量**（现金口径，正数 = 花掉了）。 */
  actual_topped_up_delta: number;
  /** 区间事实：granted 侧余额**下降量**（赠送口径，单独记录，见文件头第 2 条）。 */
  actual_granted_delta: number;
  /**
   * 偏差率 = (estimated_cash − actual_topped_up_delta) / actual_topped_up_delta。
   *
   * 正数 = 我们估多了，负数 = 我们估少了。分母为 0 时记 **null**（不除零）：此时
   * 「估算 > 0 而现金余额没动」本身就是信号，但把它塞进 deviation 会得到 Infinity，
   * 下游的看板与告警都要为这个特例单开分支，不如留 null 让调用方显式处理。
   */
  deviation_ratio: number | null;
  /** 区间内计入对账的记录条数（= request_count，不是 token 数）。 */
  request_count: number;
  /** 偏差率绝对值是否超过告警阈值（deviation_ratio 为 null 时恒 false，见 reconcileInterval）。 */
  alert: boolean;
  /** 本次生效的告警阈值（回显，便于看板标注这条记录是按多严的标准判的）。 */
  alert_threshold: number;
}

// ---------------------------------------------------------------------------
// 余额差
// ---------------------------------------------------------------------------

/**
 * 两个快照的余额差：**末 − 初**（与上游「余额」语义同向，消耗为负）。
 *
 * 前置条件：`before` / `after` **同币种**（按 `currency` 配对是调用方的事——周期任务
 * 手里有每个币种的上一条快照）。跨币种相减没有意义，本函数不做静默纠正：传入跨币种
 * 快照得到的就是一个无意义的数，别指望它替你做校验。
 *
 * 为什么返回「末 − 初」而不是「下降量」：diff 的读法就该是末减初，省得每个调用点在
 * 心里翻一次符号；要下降量（正数 = 花掉了）就自己算 `before.x - after.x`，别对这里的
 * 结果取负——取负会把 0 变成 -0。对账记录内部就是这么做的（见 reconcileInterval）。
 */
export function diffBalance(
  before: BalanceSnapshot,
  after: BalanceSnapshot,
): { total: number; granted: number; topped_up: number } {
  return {
    total: after.total - before.total,
    granted: after.granted - before.granted,
    topped_up: after.topped_up - before.topped_up,
  };
}

// ---------------------------------------------------------------------------
// 区间对账
// ---------------------------------------------------------------------------

/** 偏差率告警阈值缺省 20%：低于它的是定价表四舍五入与缓存计费的正常噪声。 */
const DEFAULT_ALERT_THRESHOLD = 0.2;

/**
 * 一个区间的对账。
 *
 * 统计口径：
 *   - 只计入 `from_ts <= r.ts < to_ts` 的记录（左闭右开——区间首的快照时刻算上一个
 *     周期的尾巴还是这一个周期的头，必须有个一致答案，否则边界记录会被重复计或漏计）；
 *   - `estimated_cash` = 这些记录 `cost.cash.total` 之和，缺字段记 0；
 *   - `request_count` = 这些记录的条数（缺 cost 的记录也计数——它确实发生过，只是没钱
 *     可估，混在 estimated 里当 0 会让「请求很多但估算为 0」看起来像漏记）。
 *
 * `now`（对账执行时刻）的用途：把区间终点向下截到 `now`。快照时间戳跑在未来（多主机
 * 时钟漂移，或上游缓存了旧响应又盖了新戳）时，「区间」事实上还没结束，此时只对账到
 * now 为止；正常部署 `after.ts <= now`，截断不触发。余额值仍取 `after` 快照——那是调用方
 * 能拿到的最后一个观测值，这个残余的不对称只发生在漂移场景。
 *
 * 乱序 / 空区间（`before.ts >= to_ts`）：不抛也不纠错，产出的是一条 estimated_cash = 0、
 * request_count = 0 的记录 + 按乱序窗口算出来的 actual。deviation 大概率触发告警——
 * 「看起来不对劲」比「静默正常」好。
 *
 * 已知盲区（写下来免得后来人以为是 bug）：`actual_topped_up_delta === 0` 而
 * `estimated_cash > 0` 时，deviation_ratio 记 null、alert 不触发。要覆盖这个盲区的
 * 调用方请自己加规则（例如「估算 > 0 且现金差为 0」也告警）——那是策略不是算术。
 */
export function reconcileInterval(opts: {
  before: BalanceSnapshot;
  after: BalanceSnapshot;
  /**
   * 区间内的 UsageRecord。**只读这一小片**（ts + cost.cash.total），不 import
   * usage-record.ts 的具体类型：结构兼容即可，窄依赖让「记录里加字段」永远不影响对账。
   */
  records: Array<{ ts: number; cost?: { cash?: { total?: number } } }>;
  /** 对账执行时刻（注入的时钟值，模块内不读系统时间）。 */
  now: number;
  /** 告警阈值，缺省 0.2（20%）。 */
  alertThreshold?: number;
}): ReconciliationRecord {
  const threshold = opts.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
  const from_ts = opts.before.ts;
  const to_ts = Math.min(opts.after.ts, opts.now);

  let estimated_cash = 0;
  let request_count = 0;
  for (const r of opts.records) {
    if (r.ts < from_ts || r.ts >= to_ts) continue;
    request_count += 1;
    estimated_cash += r.cost?.cash?.total ?? 0;
  }

  // 「下降量」= 初 − 末（正数 = 花掉了）。
  // 不写成 `-diffBalance(...).topped_up`：那样会把「区间内没变化」的 0 变成 **-0**，
  // 落进 JSON / 看板就是个 -0，对账时还得再判一次符号。diffBalance 仍对外导出
  // （看板要「末 − 初」的原始差额时用它），这里要的是下降量，直接相减。
  const actual_topped_up_delta = opts.before.topped_up - opts.after.topped_up;
  const actual_granted_delta = opts.before.granted - opts.after.granted;

  const deviation_ratio =
    actual_topped_up_delta === 0
      ? null
      : (estimated_cash - actual_topped_up_delta) / actual_topped_up_delta;

  const alert = deviation_ratio !== null && Math.abs(deviation_ratio) > threshold;

  return {
    from_ts,
    to_ts,
    // 同币种是前置条件（见 diffBalance）；取 before 的币种标注这条记录的口径
    currency: opts.before.currency,
    estimated_cash,
    actual_topped_up_delta,
    actual_granted_delta,
    deviation_ratio,
    request_count,
    alert,
    alert_threshold: threshold,
  };
}

// ---------------------------------------------------------------------------
// 低余额信号
// ---------------------------------------------------------------------------

/**
 * 低余额信号：**路由信号 + 请求前预检**，不是计费逻辑。
 *
 * 用途：
 *   - 路由：配合 Plan 感知路由，余额见底时优先走订阅路径（现金不再被烧）；
 *   - 预检：请求进来前先看一眼，省得每个请求都打到上游吃一个 402。
 *
 * 为什么只比 topped_up / total，不掺 `is_available`：那是「账号级」开关（余额为 0 时上游
 * 置 false），语义与「余额低」不同，混在一起会让 reason 不纯；调用方要两个信号就都看。
 *
 * 只报**第一个**命中的币种 / 规则（输入顺序）：本函数的定位是一个布尔 + 一个原因，
 * 别在这里建告警系统——要全量告警的调用方自己遍历快照数组。
 */
export function lowBalanceSignal(
  snapshots: BalanceSnapshot[],
  opts: { minToppedUp?: number; minTotal?: number },
): { low: boolean; reason?: string; currency?: string } {
  const minToppedUp = opts.minToppedUp ?? 0;
  const minTotal = opts.minTotal ?? 0;
  for (const s of snapshots) {
    // 先查现金：现金是「扣完就真的不能用了」的那一侧（赠送虽优先扣，但赠送见底还能靠
    // 现金续命；现金见底就只剩关停或换路径）。
    if (s.topped_up < minToppedUp) {
      return { low: true, reason: 'topped_up below threshold', currency: s.currency };
    }
    if (s.total < minTotal) {
      return { low: true, reason: 'total below threshold', currency: s.currency };
    }
  }
  return { low: false };
}
