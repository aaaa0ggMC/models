/**
 * ir/clock.ts —— 时钟能力接口。
 *
 * 放在 ir/ 是因为插件（ir/plugin.ts 的 GatewayServices）也要看到它；
 * 实现（systemClock / fixedClock / MemoryLogger …）在 di/ports.ts。
 *
 * 硬约束：禁止模块里直接 `Date.now()`——否则重试退避、TTFB 超时、流式空闲超时、
 * 插件耗时统计在测试里全都不可控。
 */

export interface Clock {
  /** epoch ms。 */
  now(): number;
}

/** 单调时钟（不受系统时间回拨影响），用于测量耗时。 */
export interface MonotonicClock {
  /** 单调毫秒数，只用于算差值。 */
  monotonicNow(): number;
}
