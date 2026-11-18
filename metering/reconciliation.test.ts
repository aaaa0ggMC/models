/**
 * metering/reconciliation.test.ts —— 区间级对账引擎的契约测试。
 *
 * 覆盖对象：reconciliation.ts 的 diffBalance / reconcileInterval / lowBalanceSignal。
 *
 * 测试分五组，对应五类必须兜住的风险：
 *   1. **符号与口径**：diff 是「末 − 初」，记录里的 actual_*_delta 是「下降量」（正数 =
 *      花掉了）。两者差一个负号，搞反了整张对账表就全是反的；
 *   2. **赠送优先扣**（DeepSeek 官方扣费顺序）：topped_up 差很小而 granted 差很大时，
 *      两个 actual 字段必须分开记对，deviation_ratio 只按现金口径算——这是本文件最核心
 *      的一组断言；
 *   3. **不除零**：actual_topped_up_delta === 0 时 deviation_ratio 记 null；
 *   4. **区间边界**：左闭右开（from_ts 计入、to_ts 不计入），缺 cost 的记录计数但不估钱；
 *   5. **低余额信号**：现金阈值 / 总额阈值 / 缺省阈值 / 空数组 / 首个命中。
 *
 * 隐私：全部是构造出来的假余额（110 / 50 / 100 这种文档示例量级），无真实账户数据。
 */

import { describe, expect, it } from 'vitest';

import { diffBalance, lowBalanceSignal, reconcileInterval } from './reconciliation.js';
import type { BalanceSnapshot, ReconciliationRecord } from './reconciliation.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 构造一个余额快照（默认全 0 + 可用，逐字段覆盖）。 */
function snap(over: Partial<BalanceSnapshot> & { ts: number }): BalanceSnapshot {
  return { currency: 'CNY', total: 0, granted: 0, topped_up: 0, is_available: true, ...over };
}

/**
 * 构造一条「可对账记录」——UsageRecord 的窄结构（ts + cost.cash.total）。
 * 不传 cashTotal 时整条没有 cost，用来验证「计数但不估钱」。
 */
function rec(ts: number, cashTotal?: number): { ts: number; cost?: { cash?: { total?: number } } } {
  return cashTotal === undefined ? { ts } : { ts, cost: { cash: { total: cashTotal } } };
}

// ---------------------------------------------------------------------------
// diffBalance：末 − 初
// ---------------------------------------------------------------------------

describe('reconciliation.diffBalance', () => {
  it('末 − 初：消耗为负（与上游「余额」语义同向）', () => {
    const before = snap({ ts: 0, total: 150, granted: 50, topped_up: 100 });
    const after = snap({ ts: 1000, total: 108, granted: 10, topped_up: 98 });
    expect(diffBalance(before, after)).toEqual({ total: -42, granted: -40, topped_up: -2 });
  });

  it('区间内无消耗 → 全 0', () => {
    const s = snap({ ts: 0, total: 10, granted: 10, topped_up: 0 });
    expect(diffBalance(s, snap({ ts: 5, total: 10, granted: 10, topped_up: 0 }))).toEqual({
      total: 0,
      granted: 0,
      topped_up: 0,
    });
  });

  it('只掉赠送、现金不动（赠送优先扣的典型形态）', () => {
    const before = snap({ ts: 0, total: 20, granted: 20, topped_up: 0 });
    const after = snap({ ts: 100, total: 5, granted: 5, topped_up: 0 });
    expect(diffBalance(before, after)).toEqual({ total: -15, granted: -15, topped_up: 0 });
  });
});

// ---------------------------------------------------------------------------
// reconcileInterval：区间对账
// ---------------------------------------------------------------------------

describe('reconciliation.reconcileInterval', () => {
  it('基本区间：估算 vs 事实、偏差率、request_count、告警位', () => {
    const before = snap({ ts: 0, total: 110, granted: 10, topped_up: 100 });
    const after = snap({ ts: 1000, total: 80, granted: 0, topped_up: 80 });
    const record = reconcileInterval({
      before,
      after,
      records: [rec(0, 5), rec(500, 7.5), rec(999, 2.5), rec(1000, 999)],
      now: 2000,
    });

    expect(record).toEqual<ReconciliationRecord>({
      from_ts: 0,
      to_ts: 1000,
      currency: 'CNY',
      // 现金侧下降量 = 100 − 80
      actual_topped_up_delta: 20,
      actual_granted_delta: 10,
      estimated_cash: 15,
      // (15 − 20) / 20 = −0.25 → 估少了 25%
      deviation_ratio: -0.25,
      request_count: 3,
      alert: true,
      alert_threshold: 0.2,
    });
  });

  it('区间边界左闭右开：from_ts 计入、to_ts 不计入、区间外不计入', () => {
    const before = snap({ ts: 100, total: 10, granted: 0, topped_up: 10 });
    const after = snap({ ts: 200, total: 10, granted: 0, topped_up: 10 });
    const record = reconcileInterval({
      before,
      after,
      records: [rec(99, 1), rec(100, 2), rec(150, 3), rec(199, 4), rec(200, 5), rec(201, 6)],
      now: 300,
    });
    expect(record.request_count).toBe(3);
    expect(record.estimated_cash).toBe(9);
  });

  it('缺 cost / 缺 cash / 缺 total：计数但不估钱', () => {
    const before = snap({ ts: 0, total: 10, granted: 0, topped_up: 10 });
    const after = snap({ ts: 100, total: 7, granted: 0, topped_up: 7 });
    const record = reconcileInterval({
      before,
      after,
      records: [
        rec(10),
        rec(20, 3),
        { ts: 30, cost: {} },
        { ts: 40, cost: { cash: {} } },
        { ts: 50, cost: { cash: { total: undefined } } },
      ],
      now: 200,
    });
    expect(record.request_count).toBe(5);
    expect(record.estimated_cash).toBe(3);
    // (3 − 3) / 3 = 0 → 完全吻合，不告警
    expect(record.deviation_ratio).toBe(0);
    expect(record.alert).toBe(false);
  });

  it('空 records：估算 0、条数 0，偏差按现金事实算', () => {
    const before = snap({ ts: 0, total: 10, granted: 0, topped_up: 10 });
    const after = snap({ ts: 100, total: 6, granted: 0, topped_up: 6 });
    const record = reconcileInterval({ before, after, records: [], now: 200 });
    expect(record.request_count).toBe(0);
    expect(record.estimated_cash).toBe(0);
    expect(record.actual_topped_up_delta).toBe(4);
    // (0 − 4) / 4 = −1：钱花了但一条记录都没有 → 必须告警
    expect(record.deviation_ratio).toBe(-1);
    expect(record.alert).toBe(true);
  });

  // ---- 核心：赠送余额优先扣 ----

  it('赠送优先扣：现金差 2、赠送差 40，两者分别记对，偏差只按现金口径算', () => {
    const before = snap({ ts: 0, total: 150, granted: 50, topped_up: 100 });
    const after = snap({ ts: 1000, total: 108, granted: 10, topped_up: 98 });
    const record = reconcileInterval({
      before,
      after,
      // 我们只估算现金支出：区间内两笔请求共 2（现金口径）
      records: [rec(100, 1), rec(900, 1)],
      now: 2000,
    });

    expect(record.actual_topped_up_delta).toBe(2);
    expect(record.actual_granted_delta).toBe(40);
    // 总差额 42 混着两种钱，**不能**当现金事实用
    expect(diffBalance(before, after).total).toBe(-42);
    // 偏差率按现金口径：(2 − 2) / 2 = 0 → 我们估得很准，不该告警
    expect(record.deviation_ratio).toBe(0);
    expect(record.alert).toBe(false);
    expect(record.request_count).toBe(2);
  });

  it('赠送优先扣：赠送扛了全部消耗时现金差为 0，deviation 记 null 而不是除零', () => {
    const before = snap({ ts: 0, total: 60, granted: 60, topped_up: 0 });
    const after = snap({ ts: 1000, total: 20, granted: 20, topped_up: 0 });
    const record = reconcileInterval({
      before,
      after,
      records: [rec(500, 0)],
      now: 2000,
    });

    expect(record.actual_topped_up_delta).toBe(0);
    expect(record.actual_granted_delta).toBe(40);
    // 不除零；且这是已知盲区——estimated > 0 而现金没动时不告警（见 reconcileInterval 注释）
    expect(record.deviation_ratio).toBeNull();
    expect(record.alert).toBe(false);
  });

  it('赠送优先扣：现金差 > 0 但估算远超现金 → 偏差为正且告警', () => {
    const before = snap({ ts: 0, total: 150, granted: 50, topped_up: 100 });
    const after = snap({ ts: 1000, total: 118, granted: 20, topped_up: 98 });
    const record = reconcileInterval({
      before,
      after,
      records: [rec(500, 10)],
      now: 2000,
    });
    // 现金只掉 2，我们却估了 10 → (10 − 2) / 2 = 4
    expect(record.actual_topped_up_delta).toBe(2);
    expect(record.actual_granted_delta).toBe(30);
    expect(record.deviation_ratio).toBe(4);
    expect(record.alert).toBe(true);
  });

  // ---- 告警阈值 ----

  it('缺省阈值 0.2：偏差 0.25 告警，偏差 0.2 不告警（严格大于）', () => {
    const mk = (estimated: number, actual: number): ReconciliationRecord =>
      reconcileInterval({
        before: snap({ ts: 0, total: 100, granted: 0, topped_up: 100 }),
        after: snap({ ts: 100, total: 100 - actual, granted: 0, topped_up: 100 - actual }),
        records: [rec(50, estimated)],
        now: 200,
      });

    const over = mk(25, 20);
    expect(over.deviation_ratio).toBe(0.25);
    expect(over.alert).toBe(true);
    expect(over.alert_threshold).toBe(0.2);

    const edge = mk(24, 20);
    expect(edge.deviation_ratio).toBe(0.2);
    expect(edge.alert).toBe(false);
  });

  it('自定义阈值：0.5 时偏差 0.25 不告警，阈值回显', () => {
    const record = reconcileInterval({
      before: snap({ ts: 0, total: 100, granted: 0, topped_up: 100 }),
      after: snap({ ts: 100, total: 80, granted: 0, topped_up: 80 }),
      records: [rec(50, 25)],
      now: 200,
      alertThreshold: 0.5,
    });
    expect(record.deviation_ratio).toBe(0.25);
    expect(record.alert).toBe(false);
    expect(record.alert_threshold).toBe(0.5);
  });

  it('阈值 0：任何非零偏差都告警', () => {
    const record = reconcileInterval({
      before: snap({ ts: 0, total: 100, granted: 0, topped_up: 100 }),
      after: snap({ ts: 100, total: 99, granted: 0, topped_up: 99 }),
      records: [rec(50, 1.0001)],
      now: 200,
      alertThreshold: 0,
    });
    expect(record.deviation_ratio).toBeCloseTo(0.0001, 10);
    expect(record.alert).toBe(true);
  });

  // ---- now：区间终点截断 ----

  it('after.ts 超过 now（时钟漂移）时区间截到 now，未来记录不计入', () => {
    const before = snap({ ts: 0, total: 10, granted: 0, topped_up: 10 });
    const after = snap({ ts: 2000, total: 8, granted: 0, topped_up: 8 });
    const record = reconcileInterval({
      before,
      after,
      records: [rec(1400, 1), rec(1600, 1)],
      now: 1500,
    });
    expect(record.to_ts).toBe(1500);
    expect(record.request_count).toBe(1);
    expect(record.estimated_cash).toBe(1);
    // 余额值仍取 after 快照（调用方能拿到的最后一个观测值）
    expect(record.actual_topped_up_delta).toBe(2);
  });

  it('正常部署 after.ts <= now：截断不触发', () => {
    const record = reconcileInterval({
      before: snap({ ts: 0, total: 10, granted: 0, topped_up: 10 }),
      after: snap({ ts: 100, total: 10, granted: 0, topped_up: 10 }),
      records: [],
      now: 999_999,
    });
    expect(record.to_ts).toBe(100);
  });

  it('乱序窗口（before.ts >= to_ts）：不抛、不纠错，产出 0 估算 + 大概率告警', () => {
    const before = snap({ ts: 1000, total: 110, granted: 10, topped_up: 100 });
    const after = snap({ ts: 500, total: 100, granted: 10, topped_up: 90 });
    const record = reconcileInterval({
      before,
      after,
      records: [rec(700, 5)],
      now: 2000,
    });
    expect(record.from_ts).toBe(1000);
    expect(record.to_ts).toBe(500);
    expect(record.request_count).toBe(0);
    expect(record.estimated_cash).toBe(0);
    // 时间反了，「下降量」按 初 − 末 仍算成 +10（garbage in, garbage out）→ 偏差 −1
    expect(record.actual_topped_up_delta).toBe(10);
    expect(record.deviation_ratio).toBe(-1);
    expect(record.alert).toBe(true);
  });

  // ---- 币种分离 ----

  it('两个币种各自对账，互不串味（currency 标注口径）', () => {
    const cnyBefore = snap({ ts: 0, currency: 'CNY', total: 150, granted: 50, topped_up: 100 });
    const cnyAfter = snap({ ts: 1000, currency: 'CNY', total: 148, granted: 48, topped_up: 100 });
    const usdBefore = snap({ ts: 0, currency: 'USD', total: 25.5, granted: 0, topped_up: 25.5 });
    const usdAfter = snap({ ts: 1000, currency: 'USD', total: 20.5, granted: 0, topped_up: 20.5 });

    const cny = reconcileInterval({
      before: cnyBefore,
      after: cnyAfter,
      records: [rec(500, 0)],
      now: 2000,
    });
    const usd = reconcileInterval({
      before: usdBefore,
      after: usdAfter,
      records: [rec(500, 5)],
      now: 2000,
    });

    expect(cny.currency).toBe('CNY');
    expect(cny.actual_topped_up_delta).toBe(0);
    expect(cny.actual_granted_delta).toBe(2);
    expect(cny.deviation_ratio).toBeNull();

    expect(usd.currency).toBe('USD');
    expect(usd.actual_topped_up_delta).toBe(5);
    expect(usd.actual_granted_delta).toBe(0);
    expect(usd.deviation_ratio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// lowBalanceSignal
// ---------------------------------------------------------------------------

describe('reconciliation.lowBalanceSignal', () => {
  it('现金低于阈值 → low + reason + currency', () => {
    const sig = lowBalanceSignal([snap({ ts: 0, total: 13, granted: 10, topped_up: 3 })], {
      minToppedUp: 5,
    });
    expect(sig).toEqual({ low: true, reason: 'topped_up below threshold', currency: 'CNY' });
  });

  it('现金够但总额低于阈值 → low（总额口径）', () => {
    const sig = lowBalanceSignal([snap({ ts: 0, total: 3, granted: 3, topped_up: 10 })], {
      minToppedUp: 1,
      minTotal: 5,
    });
    expect(sig).toEqual({ low: true, reason: 'total below threshold', currency: 'CNY' });
  });

  it('两个都够 → 不低（且不吐 reason/currency）', () => {
    const sig = lowBalanceSignal([snap({ ts: 0, total: 100, granted: 10, topped_up: 90 })], {
      minToppedUp: 5,
      minTotal: 5,
    });
    expect(sig.low).toBe(false);
    expect(sig.reason).toBeUndefined();
    expect(sig.currency).toBeUndefined();
  });

  it('边界是严格小于：等于阈值不算低', () => {
    const sig = lowBalanceSignal([snap({ ts: 0, total: 5, granted: 0, topped_up: 5 })], {
      minToppedUp: 5,
      minTotal: 5,
    });
    expect(sig.low).toBe(false);
  });

  it('缺省阈值 0：只有负余额才算低', () => {
    const zero = lowBalanceSignal([snap({ ts: 0, total: 0, granted: 0, topped_up: 0 })], {});
    expect(zero.low).toBe(false);

    const negative = lowBalanceSignal([snap({ ts: 0, total: -1, granted: 0, topped_up: -1 })], {});
    expect(negative.low).toBe(true);
    expect(negative.reason).toBe('topped_up below threshold');
  });

  it('空快照数组 → 不低（没有数据不下结论）', () => {
    expect(lowBalanceSignal([], { minToppedUp: 5, minTotal: 5 }).low).toBe(false);
  });

  it('多币种都低时只报第一个（输入顺序）', () => {
    const sig = lowBalanceSignal(
      [
        snap({ ts: 0, currency: 'CNY', total: 1, granted: 1, topped_up: 0 }),
        snap({ ts: 0, currency: 'USD', total: 1, granted: 1, topped_up: 0 }),
      ],
      { minToppedUp: 5 },
    );
    expect(sig.currency).toBe('CNY');
  });

  it('第一个币种够、第二个不够 → 报第二个', () => {
    const sig = lowBalanceSignal(
      [
        snap({ ts: 0, currency: 'CNY', total: 100, granted: 0, topped_up: 100 }),
        snap({ ts: 0, currency: 'USD', total: 2, granted: 0, topped_up: 2 }),
      ],
      { minToppedUp: 5 },
    );
    expect(sig.currency).toBe('USD');
  });
});
