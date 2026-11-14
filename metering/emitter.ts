/**
 * metering/emitter.ts —— UsageEmitter 接口。
 *
 * 唯一事实来源：docs/design/60-billing-and-dogfooding.md §1（设计原则）、§2（管道结构）。
 *
 * 硬约束（逐条落地）：
 *   - **永不抛异常影响主链路**；队列满时按 drop_policy（默认丢弃最旧 + 计数告警）处理；
 *   - 聚合器与主链路之间只有一条**单向通道，没有回压路径**；
 *   - Tier-1（usage 元数据）默认常开；Tier-2（消息内容）默认关闭，由 persist_messages
 *     开关控制——Phase 1 不落 Tier-2（70 §2）。
 */

import type { UsageRecord } from "./usage-record.js";

export type DropPolicy = "drop_oldest" | "drop_newest" | "block";

export interface UsageEmitter {
  /**
   * 发射一条 UsageRecord。**永不抛**：内部失败只记 metric + warning。
   * 调用方（S10）不需要 try/catch。
   */
  emit(record: UsageRecord): void;
  /** 队列深度（观测用）。 */
  depth(): number;
  /** 因队列满被丢弃的条数（观测用；>0 应告警）。 */
  dropped(): number;
  /** 冲刷：把队列里的记录交给下游（测试与优雅退出用）。 */
  flush(): Promise<UsageRecord[]>;
  /** 下游消费者（存储/聚合器）。 */
  setSink(sink: UsageSink): void;
}

/** 下游：Tier-1 存储 / 聚合器。Phase 1 用内存实现。 */
export interface UsageSink {
  write(records: UsageRecord[]): Promise<void>;
}

/** 队列满时的处理结果（内部用）。 */
export interface EnqueueResult {
  accepted: boolean;
  dropped: number;
}
