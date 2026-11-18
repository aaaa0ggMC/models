/**
 * metering/memory-emitter.ts —— 异步非阻塞 usage 发射器的内存/队列实现。
 *
 * 结构（60 §2）：S10 → 内存环形队列（有界，默认 10k 条）→ Aggregator（微批聚合，
 * 默认 2s / 500 条）→ Tier-1 存储。
 *
 * 「异步非阻塞」体现在三处：
 *   1. `emit()` 是**同步返回**的——只做入队，不做任何 IO；
 *   2. 批量下沉由定时器/阈值触发，不在请求路径上；
 *   3. **没有回压路径**：队列满时按 drop_policy 丢弃最旧 + 计数，绝不阻塞请求。
 */

import type { DropPolicy, UsageEmitter, UsageSink } from './emitter.js';
import type { UsageRecord } from './usage-record.js';

export interface MemoryUsageEmitterOptions {
  /** 队列容量上限（60 §2：默认 10k 条）。 */
  capacity?: number;
  drop_policy?: DropPolicy;
  /** 微批聚合触发条数（60 §2：默认 500）。 */
  batchSize?: number;
  /** 微批聚合触发间隔 ms（60 §2：默认 2s）。 */
  flushIntervalMs?: number;
  /** 是否自动启动定时冲刷（测试里关掉以避免悬挂定时器）。 */
  autoFlush?: boolean;
}

export class MemoryUsageEmitter implements UsageEmitter {
  private queue: UsageRecord[] = [];
  private droppedCount = 0;
  private sink: UsageSink | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> = Promise.resolve();

  readonly capacity: number;
  readonly dropPolicy: DropPolicy;
  readonly batchSize: number;
  readonly flushIntervalMs: number;

  /** 观测：已下沉到 sink 的总条数。 */
  flushedCount = 0;

  constructor(options: MemoryUsageEmitterOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
    this.dropPolicy = options.drop_policy ?? 'drop_oldest';
    this.batchSize = options.batchSize ?? 500;
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
    if (options.autoFlush ?? true) {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      // 不阻止进程退出
      this.timer.unref?.();
    }
  }

  setSink(sink: UsageSink): void {
    this.sink = sink;
  }

  /**
   * 入队。**永不抛**——这是 S10 能"失败只丢统计，不丢响应"的前提。
   */
  emit(record: UsageRecord): void {
    if (this.queue.length >= this.capacity) {
      if (this.dropPolicy === 'drop_newest') {
        this.droppedCount += 1;
        return;
      }
      // drop_oldest：丢最旧 + 计数（60 §2 默认策略）
      this.queue.shift();
      this.droppedCount += 1;
    }
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  depth(): number {
    return this.queue.length;
  }

  dropped(): number {
    return this.droppedCount;
  }

  /** 冲刷：把队列里的记录交给下游。并发安全（串行化）。 */
  async flush(): Promise<UsageRecord[]> {
    const batch = this.queue;
    if (batch.length === 0) return [];
    this.queue = [];
    if (this.sink === undefined) {
      // 没有下游时原样放回（避免丢统计）
      this.queue = [...batch, ...this.queue];
      return [];
    }
    this.flushing = this.flushing.then(async () => {
      try {
        await this.sink!.write(batch);
        this.flushedCount += batch.length;
      } catch {
        // 下沉失败：放回队列头部，等待下次重试（可重放）
        this.queue = [...batch, ...this.queue];
      }
    });
    await this.flushing;
    return batch;
  }

  /** 停止定时冲刷（优雅退出）。 */
  close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** 内存 sink：把记录收进数组，测试可断言。 */
export class MemoryUsageSink implements UsageSink {
  readonly records: UsageRecord[] = [];

  async write(records: UsageRecord[]): Promise<void> {
    this.records.push(...records);
  }
}

/** 空 sink：丢弃一切（用于"只想验证不抛"的场景）。 */
export class NullUsageSink implements UsageSink {
  async write(): Promise<void> {}
}
