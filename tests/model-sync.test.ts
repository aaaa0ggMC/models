/**
 * tests/model-sync.test.ts —— 元数据同步服务：启动 / 周期 / 管理员触发三种方式 +
 * 上游 TTL + stale 标记 + 容错（last-known-good）。
 *
 * 时间与定时器全部注入（fixedClock + ManualScheduler），不睡真时间、不依赖墙上时钟。
 */

import { describe, expect, it } from 'vitest';
import { ManualScheduler, ModelSyncService, type TimerScheduler } from '../catalog/index.js';
import { MemoryLogger, MemoryMetrics, fixedClock } from '../di/ports.js';
import type { ModelMetadataSource, ModelMetadataSnapshot } from '../catalog/index.js';

const T0 = 1_800_000_000_000;

/** 可编程的假上游来源：`results` 依次返回，抛完就抛最后一个错误。 */
function scriptedSource(
  id: string,
  script: Array<ModelMetadataSnapshot | Error>,
): ModelMetadataSource & { calls: number } {
  const source = {
    id,
    layer: 'upstream' as const,
    calls: 0,
    async load(): Promise<ModelMetadataSnapshot> {
      const step = script[Math.min(source.calls, script.length - 1)];
      source.calls += 1;
      if (step === undefined) throw new Error('script exhausted');
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return source;
}

function snapshot(id: string, models: Array<{ id: string; name?: string }>): ModelMetadataSnapshot {
  return {
    sourceId: id,
    fetchedAt: T0,
    models: models.map((m) => ({ ...m, provider: 'deepseek' })),
  };
}

/** 可前进的时钟（fixedClock 的 step 语义不够表达"同步完再过期"）。 */
function mutableClock(start = T0): { now(): number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function service(
  sources: ModelMetadataSource[],
  opts: {
    clock?: ReturnType<typeof fixedClock>;
    scheduler?: TimerScheduler;
    intervalMs?: number;
    ttlMs?: number;
    syncOnStart?: boolean;
    logger?: MemoryLogger;
    metrics?: MemoryMetrics;
  } = {},
): ModelSyncService {
  return new ModelSyncService({
    clock: opts.clock ?? fixedClock(T0),
    sources,
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
    ...(opts.metrics === undefined ? {} : { metrics: opts.metrics }),
    ...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs }),
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
    ...(opts.syncOnStart === undefined ? {} : { syncOnStart: opts.syncOnStart }),
    ...(opts.scheduler === undefined ? {} : { scheduler: opts.scheduler }),
  });
}

describe('ModelSyncService · 启动时同步', () => {
  it('start() 先同步一次再定时', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'deepseek-flash' }]),
    ]);
    const scheduler = new ManualScheduler();
    const sync = service([source], { scheduler, intervalMs: 60_000, ttlMs: 600_000 });

    await sync.start();

    expect(source.calls).toBe(1);
    expect(sync.running).toBe(true);
    expect(scheduler.pending).toBe(1);
    expect(scheduler.intervals()).toEqual([60_000]);
    expect(sync.snapshotFor('upstream:deepseek')?.models).toHaveLength(1);
    sync.stop();
    expect(scheduler.pending).toBe(0);
  });

  it('syncOnStart=false 时启动不拉，但周期定时照样建', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const scheduler = new ManualScheduler();
    const sync = service([source], { scheduler, intervalMs: 60_000, syncOnStart: false });

    await sync.start();

    expect(source.calls).toBe(0);
    expect(scheduler.pending).toBe(1);
    sync.stop();
  });

  it('intervalMs<=0 时不定时（只保留手动/启动触发）', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const scheduler = new ManualScheduler();
    const sync = service([source], { scheduler, intervalMs: 0 });
    await sync.start();
    expect(scheduler.pending).toBe(0);
    sync.stop();
  });

  it('start() 幂等：重复调用不会建两个定时器', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const scheduler = new ManualScheduler();
    const sync = service([source], { scheduler, intervalMs: 1000 });
    await sync.start();
    await sync.start();
    expect(scheduler.pending).toBe(1);
    expect(source.calls).toBe(1);
    sync.stop();
  });
});

describe('ModelSyncService · 周期性同步', () => {
  it('每个 interval 触发一次拉取', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm1' }]),
      snapshot('upstream:deepseek', [{ id: 'm2' }]),
    ]);
    const scheduler = new ManualScheduler();
    const sync = service([source], { scheduler, intervalMs: 60_000, syncOnStart: false });
    await sync.start();

    await scheduler.tick();
    expect(source.calls).toBe(1);
    expect(sync.snapshotFor('upstream:deepseek')?.models[0]?.id).toBe('m1');

    await scheduler.tick();
    expect(source.calls).toBe(2);
    expect(sync.snapshotFor('upstream:deepseek')?.models[0]?.id).toBe('m2');
    sync.stop();
  });

  it('stop() 之后 tick 不再触发', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const scheduler = new ManualScheduler();
    const sync = service([source], { scheduler, intervalMs: 1000, syncOnStart: false });
    await sync.start();
    sync.stop();
    await scheduler.tick();
    expect(source.calls).toBe(0);
  });
});

describe('ModelSyncService · 管理员触发', () => {
  it('syncNow("admin") 立即拉一次并回报每个来源的结果', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm1' }, { id: 'm2' }]),
    ]);
    const sync = service([source], { syncOnStart: false });
    const report = await sync.syncNow('admin');
    expect(report.reason).toBe('admin');
    expect(report.sources).toEqual([{ sourceId: 'upstream:deepseek', ok: true, models: 2 }]);
    expect(source.calls).toBe(1);
  });

  it('并发 syncNow 合并成一次拉取（不会两个 tick 同时打上游）', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const sync = service([source], { syncOnStart: false });
    const [a, b] = await Promise.all([sync.syncNow('admin'), sync.syncNow('admin')]);
    expect(source.calls).toBe(1);
    expect(a.sources[0]?.ok).toBe(true);
    expect(b.sources[0]?.ok).toBe(true);
  });
});

describe('ModelSyncService · 容错与 TTL', () => {
  it('上游挂掉：保留 last-known-good + 记 lastError + 不抛', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'deepseek-flash', name: '第一次' }]),
      new Error('DeepSeek /models 返回 503'),
    ]);
    const logger = new MemoryLogger();
    const metrics = new MemoryMetrics();
    const clock = mutableClock();
    const sync = service([source], { clock, syncOnStart: false, logger, metrics });

    await sync.syncNow('startup');
    expect(sync.snapshotFor('upstream:deepseek')?.models[0]?.name).toBe('第一次');

    const report = await sync.syncNow('periodic');
    expect(report.sources[0]?.ok).toBe(false);
    expect(report.sources[0]?.error).toContain('503');
    // last-known-good 还在
    expect(sync.snapshotFor('upstream:deepseek')?.models[0]?.name).toBe('第一次');
    // 状态里留下错误，供 provenance 展示
    const state = sync.states()[0];
    expect(state?.lastError).toContain('503');
    expect(state?.snapshot?.models).toHaveLength(1);
    // 日志与埋点都记了（不静默）
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('同步失败'))).toBe(
      true,
    );
    expect(metrics.snapshot().some((s) => s.name === 'catalog_sync_failed')).toBe(true);
  });

  it('上游从未成功过：没有快照、不算 stale（没有旧数据可过期）', async () => {
    const source = scriptedSource('upstream:deepseek', [new Error('network down')]);
    const sync = service([source], { syncOnStart: false, ttlMs: 1000 });
    await sync.syncNow('startup');
    const state = sync.states()[0];
    expect(state?.snapshot).toBeUndefined();
    expect(state?.stale).toBe(false);
    expect(state?.lastError).toContain('network down');
  });

  it('超过 TTL → stale: true；未超过 → false', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const clock = mutableClock();
    const sync = service([source], { clock, syncOnStart: false, ttlMs: 60_000 });

    await sync.syncNow('startup');
    expect(sync.isStale('upstream:deepseek')).toBe(false);
    expect(sync.states()[0]?.stale).toBe(false);

    clock.advance(59_000);
    expect(sync.isStale('upstream:deepseek')).toBe(false);

    clock.advance(2_000); // 合计 61s > TTL 60s
    expect(sync.isStale('upstream:deepseek')).toBe(true);
    expect(sync.states()[0]?.stale).toBe(true);
  });

  it('ttlMs<=0 = 不判过期（永远新鲜）', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const clock = fixedClock(T0);
    const sync = service([source], { clock, syncOnStart: false, ttlMs: 0 });
    await sync.syncNow('startup');
    clock.now();
    expect(sync.isStale('upstream:deepseek')).toBe(false);
  });

  it('多个来源互不影响：一个挂一个通', async () => {
    const good = scriptedSource('upstream:a', [snapshot('upstream:a', [{ id: 'm' }])]);
    const bad = scriptedSource('upstream:b', [new Error('boom')]);
    const sync = service([good, bad], { syncOnStart: false });
    const report = await sync.syncNow('admin');
    expect(report.sources.map((s) => [s.sourceId, s.ok])).toEqual([
      ['upstream:a', true],
      ['upstream:b', false],
    ]);
    expect(sync.snapshotFor('upstream:a')).toBeDefined();
    expect(sync.snapshotFor('upstream:b')).toBeUndefined();
  });
});

describe('ModelSyncService · status() 运维视图', () => {
  it('回报运行状态、间隔、TTL 与各来源健康度（不含任何凭据）', async () => {
    const source = scriptedSource('upstream:deepseek', [
      snapshot('upstream:deepseek', [{ id: 'm' }]),
    ]);
    const clock = fixedClock(T0);
    const sync = service([source], { clock, intervalMs: 900_000, ttlMs: 3_600_000 });
    await sync.start();
    const status = sync.status();
    expect(status.running).toBe(true);
    expect(status.interval_ms).toBe(900_000);
    expect(status.ttl_ms).toBe(3_600_000);
    expect(status.sources[0]?.sourceId).toBe('upstream:deepseek');
    expect(status.sources[0]?.models).toBe(1);
    expect(status.sources[0]?.stale).toBe(false);
    expect(status.sources[0]?.last_error).toBeUndefined();
    // 整个视图可以安全 JSON 序列化进日志/响应（没有 secret 槽位）
    expect(() => JSON.stringify(status)).not.toThrow();
    sync.stop();
  });
});
