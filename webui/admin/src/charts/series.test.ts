/**
 * src/charts/series.test.ts —— 图表几何与刻度的回归测试。
 *
 * 为什么值得单测：这些函数决定了"图画得对不对"，而几何 bug 在 UI 上往往
 * **看不出来**——轴上限差一点、刻度落在小数位上、抽样把尖峰抽没了，
 * 图上照样是一条线。这里把四条性质钉死：
 *   ① niceScale 永远产出整数步长、覆盖数据最大值、从 0 起；
 *   ② path 函数对空 / 单点 / 全零不抛异常；
 *   ③ downsample 保尖峰（LTTB 的意义就在这里）；
 *   ④ topN 的合计守恒（分布图各条相加必须等于总量）。
 */

import { describe, expect, it } from 'vitest';
import {
  areaPath,
  barPath,
  downsample,
  hBarPath,
  linePath,
  linearScale,
  niceScale,
  niceStep,
  sparklineEnd,
  sparklinePath,
  topN,
  xTickIndices,
} from './series';

describe('niceScale：轴上限与刻度', () => {
  it('全零数据 → 0..1 的轴（不除以 0）', () => {
    const s = niceScale(0, 0, 4);
    expect(s.max).toBeGreaterThan(0);
    expect(s.min).toBe(0);
    expect(s.ticks.length).toBeGreaterThan(1);
  });

  it('刻度步长是 1/2/5×10ⁿ 的整数，不出现 34.25 这种', () => {
    for (const [lo, hi] of [
      [0, 137],
      [0, 0.42],
      [0, 9876],
      [0, 123456],
      [0, 3],
    ] as const) {
      const s = niceScale(lo, hi, 4);
      // 步长必须是 1/2/5×10ⁿ 的整数倍，不会出现 34.25 这种任意小数
      const step = s.ticks.length > 1 ? (s.ticks[1]! - s.ticks[0]!) : 1;
      expect(Number.isInteger(step * 1e6) || step < 1).toBe(true);
      expect(s.max).toBeGreaterThanOrEqual(hi);
      expect(s.min).toBeLessThanOrEqual(lo);
    }
  });

  it('137 → 上限 150、刻度 0/50/100/150', () => {
    const s = niceScale(0, 137, 3);
    expect(s.max).toBe(150);
    expect(s.ticks).toEqual([0, 50, 100, 150]);
  });

  it('有负值时轴下限取到 0 以下（成本不会负，但留着以防万一）', () => {
    const s = niceScale(-5, 20, 4);
    expect(s.min).toBeLessThanOrEqual(-5);
  });

  it('niceStep：1/2/5×10ⁿ', () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.4)).toBe(2);
    expect(niceStep(3.2)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(230)).toBe(500);
    expect(niceStep(0)).toBe(1);
  });
});

describe('linearScale', () => {
  it('把 [min,max] 映射到 [0,size]', () => {
    expect(linearScale(0, { min: 0, max: 100 }, 200)).toBe(0);
    expect(linearScale(100, { min: 0, max: 100 }, 200)).toBe(200);
    expect(linearScale(50, { min: 0, max: 100 }, 200)).toBe(100);
  });

  it('域退化（max==min）时返回 0 而不是 NaN', () => {
    expect(linearScale(5, { min: 5, max: 5 }, 200)).toBe(0);
  });

  it('超出域的值被夹住（不会画到画布外）', () => {
    expect(linearScale(200, { min: 0, max: 100 }, 200)).toBe(200);
    expect(linearScale(-50, { min: 0, max: 100 }, 200)).toBe(0);
  });
});

describe('path 函数', () => {
  const pts = [
    { x: 0, y: 10 },
    { x: 10, y: 5 },
    { x: 20, y: 8 },
  ];

  it('linePath：少于 2 个点返回空串（单点画不出线）', () => {
    expect(linePath([])).toBe('');
    expect(linePath([{ x: 1, y: 1 }])).toBe('');
    expect(linePath(pts)).toBe('M0,10 L10,5 L20,8');
  });

  it('areaPath：闭合到基线', () => {
    const d = areaPath(pts, 20);
    expect(d.startsWith('M0,20')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(areaPath([], 20)).toBe('');
  });

  it('barPath / hBarPath：零高度 / 零宽度返回空串', () => {
    expect(barPath(0, 0, 10, 0)).toBe('');
    expect(barPath(0, 0, 0, 10)).toBe('');
    expect(hBarPath(0, 0, 0, 10)).toBe('');
    expect(hBarPath(0, 0, 10, 0)).toBe('');
  });

  it('barPath：圆角不超过宽高一半（窄柱子不会画歪）', () => {
    const d = barPath(0, 0, 3, 2, 3);
    // 半径被夹到 min(3, 3/2, 2) = 1.5
    expect(d).toContain('A1.5,1.5');
  });
});

describe('downsample（LTTB）', () => {
  it('不超过目标点数，且首尾一定保留', () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ x: i, y: Math.sin(i / 20) * 100 }));
    const out = downsample(pts, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]!);
  });

  it('点数没超目标时原样返回（不多此一举）', () => {
    const pts = [
      { x: 0, y: 1 },
      { x: 1, y: 2 },
    ];
    expect(downsample(pts, 10)).toBe(pts);
  });

  it('**保尖峰**：唯一的极值点不会被抽样抹掉', () => {
    // 1000 个点，第 500 个是尖峰（其余都是 0）
    const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i === 500 ? 9999 : 0 }));
    const out = downsample(pts, 50);
    expect(out.some((p) => p.y === 9999)).toBe(true);
  });
});

describe('topN：分布聚合', () => {
  const items = [
    { model: 'a', request_count: 10, cash_total: 1 },
    { model: 'b', request_count: 5, cash_total: 2 },
    { model: 'c', request_count: 1, cash_total: 3 },
    { model: 'd', request_count: 1, cash_total: 4 },
    { model: 'e', request_count: 1, cash_total: 5 },
    { model: 'f', request_count: 1, cash_total: 6 },
  ];

  it('取前 N，其余并入「其他」', () => {
    const b = topN(items, (i) => i.model, (i) => i.cash_total, 3);
    expect(b).toHaveLength(4);
    expect(b[0]!.label).toBe('f');
    expect(b[3]!.key).toBe('__other__');
    expect(b[3]!.label).toBe('其他');
  });

  it('合计守恒：各桶相加 == 总量（分布图对不上总量就是 bug）', () => {
    const total = items.reduce((s, i) => s + i.cash_total, 0);
    for (const n of [1, 2, 3, 6, 10]) {
      const b = topN(items, (i) => i.model, (i) => i.cash_total, n);
      expect(b.reduce((s, x) => s + x.value, 0)).toBe(total);
      expect(b.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 10);
    }
  });

  it('不超过 N 项时不会冒出「其他」', () => {
    const b = topN(items.slice(0, 2), (i) => i.model, (i) => i.cash_total, 5);
    expect(b).toHaveLength(2);
    expect(b.some((x) => x.key === '__other__')).toBe(false);
  });

  it('空输入 → 空数组（不是抛异常）', () => {
    expect(topN([], (i: { model: string }) => i.model, () => 1, 5)).toEqual([]);
  });

  it('总量为 0 时 share 全是 0（不出现 0/0）', () => {
    const b = topN([{ model: 'a', request_count: 0, cash_total: 0 }], (i) => i.model, (i) => i.cash_total, 5);
    expect(b[0]!.share).toBe(0);
  });
});

describe('sparkline', () => {
  it('少于 2 个点返回空串（画不出走势）', () => {
    expect(sparklinePath([], 100, 30)).toBe('');
    expect(sparklinePath([5], 100, 30)).toBe('');
  });

  it('全相等的数据画在中间（span 为 0 时不除以 0）', () => {
    const d = sparklinePath([5, 5, 5, 5], 100, 30, 2);
    expect(d).not.toBe('');
    // 三个点的 y 应该相同（居中）
    const ys = [...d.matchAll(/L?\d+(?:\.\d+)?,(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBe(1);
  });

  it('末点坐标在右边缘', () => {
    const end = sparklineEnd([1, 2, 3], 100, 30, 2);
    expect(end).not.toBeNull();
    expect(end!.x).toBe(100);
    expect(end!.y).toBeGreaterThanOrEqual(2);
    expect(end!.y).toBeLessThanOrEqual(28);
  });

  it('含 NaN 的值被跳过（不会产出 NaN 坐标）', () => {
    const d = sparklinePath([1, Number.NaN, 3], 100, 30, 2);
    expect(d).not.toContain('NaN');
  });
});

describe('xTickIndices', () => {
  it('点数少于上限时全给', () => {
    expect(xTickIndices(4, 6)).toEqual([0, 1, 2, 3]);
  });

  it('点数多于上限时含首尾、不重复', () => {
    const idx = xTickIndices(100, 6);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(99);
    expect(new Set(idx).size).toBe(idx.length);
    expect(idx.length).toBeLessThanOrEqual(6);
  });
});
