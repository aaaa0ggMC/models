/**
 * catalog/sync.ts —— 元数据同步服务（启动 / 周期 / 管理员触发 + TTL + 容错）。
 *
 * ## 三种触发方式（任务书要求，全部经注入端口，不硬编码 HTTP）
 *
 * 1. **启动时同步**：`start()` 里先跑一次（`syncOnStart` 可关）。失败只记日志——
 *    静态能力表本来就可用，起不来服务没有任何理由。
 * 2. **周期性同步**：`intervalMs` 可配；经注入的 `TimerScheduler` 定时，测试里换成
 *    `ManualScheduler` 就能用假时钟精确驱动（不睡真时间）。
 * 3. **管理员触发同步**：`syncNow('admin')`，由 HTTP 的管理员路由调用（token 门控）。
 *
 * `ttlMs` 是**上游 TTL**：数据超过它就打 `stale` 标记。它不改变拉取行为（拉取由
 * `intervalMs` 驱动），只决定"这份数据还算不算新鲜"——两个旋钮分开，因为"多久拉一次"
 * 是成本问题，"多久算过期"是正确性问题。
 *
 * ## 容错（端点绝不能因为上游挂了而失败）
 *
 * 拉取失败时**保留上一份快照**（last-known-good），只记 `lastError`；`states()` 据此把
 * 记录标成 `stale: true` + `last_successful_fetch`，调用方看得见"这是旧数据"。从未成功
 * 过则没有快照，该层 simply 不贡献字段（矩阵种子值照常返回）。
 *
 * 并发：`syncNow` 合并并发调用（第二次调用拿到同一个 Promise），不会出现两个 tick 同时
 * 打上游。
 */

import type { Clock, Logger, Metrics } from '../di/ports.js';
import type {
  MetadataLayer,
  ModelMetadata,
  ModelMetadataSnapshot,
  ModelMetadataSource,
  UpstreamSnapshotProvider,
  UpstreamSourceState,
} from './types.js';

/** 定时器句柄（不透明；由具体 scheduler 定义）。 */
export type TimerHandle = unknown;

/**
 * 可替换的定时器（测试注入 `ManualScheduler`，生产用 `systemTimerScheduler`）。
 *
 * 为什么抽象它：周期同步要用假时钟测，"睡 60 秒真时间"的测试既慢又抖。注入之后测试
 * 里 `clock.advance()` + `scheduler.tick()` 就能确定性地验证周期行为。
 */
export interface TimerScheduler {
  /**
   * 登记一个周期任务。回调可以返回 Promise（周期同步就是异步的）——`ManualScheduler.tick()`
   * 会等所有回调落地，测试因此不必跟 microtask 赛跑。
   */
  setInterval(fn: () => void | Promise<void>, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** 生产定时器：直接包全局 setInterval（唯一允许出现全局定时器的地方）。 */
export const systemTimerScheduler: TimerScheduler = {
  setInterval(fn: () => void | Promise<void>, ms: number): TimerHandle {
    return setInterval(() => {
      // 周期任务的拒绝必须被接住：setInterval 不会等 Promise，一次未处理的 rejection
      // 会掀掉整个进程（而 syncNow 内部已经把每个来源的错都消化掉了）
      void (async () => fn())().catch(() => {});
    }, ms);
  },
  clearInterval(handle: TimerHandle): void {
    if (handle !== undefined) clearInterval(handle as NodeJS.Timeout);
  },
};

/** 手动定时器：测试替身，`tick()` 触发所有已登记的定时器。 */
export class ManualScheduler implements TimerScheduler {
  private readonly handles = new Map<number, { fn: () => void | Promise<void>; ms: number }>();
  private nextId = 1;

  setInterval(fn: () => void | Promise<void>, ms: number): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.handles.set(id, { fn, ms });
    return id;
  }

  clearInterval(handle: TimerHandle): void {
    this.handles.delete(handle as number);
  }

  /** 触发一次全部定时器，并等所有回调落地（周期同步测试用）。 */
  async tick(): Promise<void> {
    await Promise.all([...this.handles.values()].map(({ fn }) => fn()));
  }

  /** 已登记的定时器个数（`stop()` 后应为 0）。 */
  get pending(): number {
    return this.handles.size;
  }

  /** 已登记的间隔（测试断言用）。 */
  intervals(): number[] {
    return [...this.handles.values()].map((h) => h.ms);
  }
}

export interface ModelSyncOptions {
  clock: Clock;
  /** 上游层来源（只同步这一层；离线/配置层由目录自己加载）。 */
  sources: ModelMetadataSource[];
  logger?: Logger;
  metrics?: Metrics;
  /** 周期同步间隔（ms）；<= 0 = 不定时。 */
  intervalMs?: number;
  /** 上游 TTL（ms）：超过即标 stale。 */
  ttlMs?: number;
  /** 启动时是否立即同步一次（默认 true）。 */
  syncOnStart?: boolean;
  scheduler?: TimerScheduler;
}

/** 一次同步的报告（管理员路由直接把它回给调用方）。 */
export interface ModelSyncReport {
  reason: string;
  at: number;
  sources: Array<{ sourceId: string; ok: boolean; models?: number; error?: string }>;
}

/** 单个来源的内部状态。 */
interface SourceState {
  snapshot?: ModelMetadataSnapshot;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export class ModelSyncService implements UpstreamSnapshotProvider {
  private readonly clock: Clock;
  private readonly sources: ModelMetadataSource[];
  private readonly logger: Logger | undefined;
  private readonly metrics: Metrics | undefined;
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private readonly syncOnStart: boolean;
  private readonly scheduler: TimerScheduler;

  private readonly sourceStates = new Map<string, SourceState>();
  private timer: TimerHandle | undefined;
  private started = false;
  private startPromise: Promise<void> | undefined;
  private inFlight: Promise<ModelSyncReport> | undefined;

  constructor(options: ModelSyncOptions) {
    this.clock = options.clock;
    this.sources = options.sources;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.intervalMs = options.intervalMs ?? 0;
    this.ttlMs = options.ttlMs ?? 0;
    this.syncOnStart = options.syncOnStart ?? true;
    this.scheduler = options.scheduler ?? systemTimerScheduler;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * 启动：先做一次同步（可关），再按 intervalMs 定时。
   *
   * 幂等；并发调用拿到同一个 Promise。**同步失败不抛**——启动同步失败只记日志，
   * 静态能力表已经可用（见文件头容错一节）。
   */
  async start(): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this.runStart();
    return this.startPromise;
  }

  private async runStart(): Promise<void> {
    this.started = true;
    if (this.syncOnStart) {
      await this.syncNow('startup');
    }
    if (this.intervalMs > 0) {
      this.timer = this.scheduler.setInterval(async () => {
        await this.syncNow('periodic');
      }, this.intervalMs);
    }
    this.logger?.info('catalog: 元数据同步已启动', {
      sources: this.sources.map((s) => s.id),
      interval_ms: this.intervalMs,
      ttl_ms: this.ttlMs,
    });
  }

  /** 停止周期同步（优雅退出用）。 */
  stop(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.started = false;
    this.startPromise = undefined;
  }

  get running(): boolean {
    return this.started;
  }

  // -------------------------------------------------------------------------
  // 同步
  // -------------------------------------------------------------------------

  /** 立即同步一次（启动 / 周期 / 管理员触发都走这里）。并发调用会合并。 */
  async syncNow(reason = 'manual'): Promise<ModelSyncReport> {
    if (this.inFlight !== undefined) return this.inFlight;
    const promise = this.runSync(reason);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) this.inFlight = undefined;
    }
  }

  private async runSync(reason: string): Promise<ModelSyncReport> {
    const at = this.clock.now();
    const report: ModelSyncReport = { reason, at, sources: [] };
    for (const source of this.sources) {
      const state = this.ensureState(source.id);
      state.lastAttemptAt = at;
      try {
        const snapshot = await source.load();
        // 失败时**不清空**上一份快照（last-known-good），只更新成功状态
        state.snapshot = snapshot;
        state.lastSuccessAt = at;
        state.lastError = undefined;
        report.sources.push({ sourceId: source.id, ok: true, models: snapshot.models.length });
        this.metrics?.increment('catalog_sync_ok', 1, { source: source.id, reason });
        this.logger?.info('catalog: 元数据同步成功', {
          source: source.id,
          reason,
          models: snapshot.models.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.lastError = message;
        report.sources.push({ sourceId: source.id, ok: false, error: message });
        this.metrics?.increment('catalog_sync_failed', 1, { source: source.id, reason });
        this.logger?.warn('catalog: 元数据同步失败，沿用 last-known-good', {
          source: source.id,
          reason,
          error: message,
          stale_snapshot: state.snapshot !== undefined,
        });
      }
    }
    return report;
  }

  // -------------------------------------------------------------------------
  // 状态（UpstreamSnapshotProvider）
  // -------------------------------------------------------------------------

  /** 各上游来源的当前状态（目录据此合并 + 打 stale 标记）。 */
  states(): UpstreamSourceState[] {
    const now = this.clock.now();
    return this.sources.map((source) => {
      const state = this.ensureState(source.id);
      return {
        sourceId: source.id,
        layer: 'upstream' as MetadataLayer,
        ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }),
        stale: this.isStaleAt(state, now),
        ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
        ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      };
    });
  }

  /** 该来源的数据是否已超过 TTL。从未成功过 → false（没有旧数据可过期）。 */
  isStale(sourceId: string): boolean {
    const state = this.sourceStates.get(sourceId);
    if (state === undefined) return false;
    return this.isStaleAt(state, this.clock.now());
  }

  private isStaleAt(state: SourceState, now: number): boolean {
    if (state.lastSuccessAt === undefined) return false;
    if (this.ttlMs <= 0) return false;
    return now - state.lastSuccessAt > this.ttlMs;
  }

  /** last-known-good 快照（测试与 dog-fooding 用）。 */
  snapshotFor(sourceId: string): ModelMetadataSnapshot | undefined {
    return this.sourceStates.get(sourceId)?.snapshot;
  }

  /** 运维视图（管理员路由 GET 用；不含任何凭据）。 */
  status(): {
    running: boolean;
    interval_ms: number;
    ttl_ms: number;
    sources: Array<{
      sourceId: string;
      last_successful_fetch?: number;
      last_attempt?: number;
      stale: boolean;
      models?: number;
      last_error?: string;
    }>;
  } {
    const now = this.clock.now();
    return {
      running: this.running,
      interval_ms: this.intervalMs,
      ttl_ms: this.ttlMs,
      sources: this.sources.map((source) => {
        const state = this.ensureState(source.id);
        return {
          sourceId: source.id,
          ...(state.lastSuccessAt === undefined
            ? {}
            : { last_successful_fetch: state.lastSuccessAt }),
          ...(state.lastAttemptAt === undefined ? {} : { last_attempt: state.lastAttemptAt }),
          stale: this.isStaleAt(state, now),
          ...(state.snapshot === undefined ? {} : { models: state.snapshot.models.length }),
          ...(state.lastError === undefined ? {} : { last_error: state.lastError }),
        };
      }),
    };
  }

  private ensureState(sourceId: string): SourceState {
    let state = this.sourceStates.get(sourceId);
    if (state === undefined) {
      state = {};
      this.sourceStates.set(sourceId, state);
    }
    return state;
  }
}

/** 重新导出，方便测试只 import catalog/。 */
export type { ModelMetadata, ModelMetadataSnapshot };
