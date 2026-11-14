/**
 * di/ports.ts —— 跨切面基础设施的能力接口。
 *
 * 这些是「能力」而不是「领域模块」，不在 docs/design/00-overview.md §4.2 的模块表里
 * （那张表列的是 gateway-core / ir / adaptors / plugins / metering / credentials …）。
 * 统一放 di/ 下并**经构造函数注入**，是为了满足两条硬约束：
 *   1. 禁止模块级单例、禁止隐式全局状态；
 *   2. `process.env` 的直接读取只允许出现在 di/config.ts 一处，其余全部注入。
 *
 * 每个接口都配一个最小内存实现（同文件或相邻文件），测试里可整体替换。
 */

/** 时间来源。禁止模块里直接 `Date.now()`——否则重试/超时/流式空闲判定无法在测试里控制。 */
export interface Clock {
  now(): number;
}

/** 生产时钟：直接读系统时间。测试注入 fixedClock 替代。 */
export const systemClock: Clock = { now: () => Date.now() };

/** 可替换的时钟（测试用）。 */
export function fixedClock(startMs: number, stepMs = 0): Clock {
  let current = startMs;
  return {
    now() {
      const v = current;
      current += stepMs;
      return v;
    },
  };
}

/** 结构化日志。字段自动带 request_id / plugin name。 */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** 指标埋点。Phase 1 用内存实现；Prometheus 出口在 Phase 5。 */
export interface Metrics {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  timing(name: string, durationMs: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  /** 读出已采集的样本（测试与 dog-fooding 用）。 */
  snapshot(): MetricSample[];
}

export interface MetricSample {
  name: string;
  kind: 'counter' | 'timing' | 'gauge';
  value: number;
  tags: Record<string, string>;
  ts: number;
}

/** id 生成。集中一处，便于测试里换成确定性 id。 */
export interface IdGenerator {
  /** request_id，形如 "req_" + ulid。 */
  requestId(): string;
  /** tool_call id 缺失时的统一补全值（10 §4.2 D7b：`call_<ulid>`）。 */
  toolCallId(): string;
}

/** 网关配置。字段与默认值集中在这里，env 读取只发生在 di/config.ts。 */
export interface GatewayConfig {
  /** 全局超时上限（ms）。 */
  globalTimeoutMs: number;
  /** 上游首字节超时 TTFB（ms）。 */
  ttfbTimeoutMs: number;
  /** 流式空闲超时（ms），专门杀"发了首块后静默"的流（20 §S5）。 */
  streamIdleTimeoutMs: number;
  /** 同 attempt 内最大重试次数（20 §7.3：默认 2）。 */
  maxRetries: number;
  /** 重试基础退避（ms），指数退避 + jitter。 */
  retryBaseDelayMs: number;
  /** 网关工具循环默认轮数上限（20 §5.2：默认 10）。 */
  maxTurns: number;
  /** 插件单次调用超时（ms）。 */
  pluginTimeoutMs: number;
  /** usage 嗅探器的字节上限（20 §4.2：默认 256KB/请求）。 */
  usageSnifferMaxBytes: number;
  /** loss policy 默认档。 */
  lossPolicy: 'allow' | 'safe' | 'strict' | 'emulate';
  /** 响应里是否带 ag_* 调试字段。 */
  debug: boolean;
  /** HTTP ingress 监听端口。 */
  port: number;
  /** HTTP ingress 监听 host。 */
  host: string;
}

export const DEFAULT_CONFIG: GatewayConfig = {
  globalTimeoutMs: 300_000,
  ttfbTimeoutMs: 30_000,
  streamIdleTimeoutMs: 120_000,
  maxRetries: 2,
  retryBaseDelayMs: 200,
  maxTurns: 10,
  pluginTimeoutMs: 5_000,
  usageSnifferMaxBytes: 256 * 1024,
  lossPolicy: 'allow',
  debug: false,
  port: 8787,
  host: '127.0.0.1',
};

/** 内存 Logger：把日志收进数组，测试可断言。 */
export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> =
    [];

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level, message, ...(fields === undefined ? {} : { fields }) });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }
}

/** 控制台 Logger：单行 JSON，便于本地起服务时观测。 */
export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {}

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    const order = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
    const line = JSON.stringify({ level, message, ...(fields ?? {}) });
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }
}

/** 内存 Metrics。 */
export class MemoryMetrics implements Metrics {
  private readonly samples: MetricSample[] = [];

  increment(name: string, value = 1, tags: Record<string, string> = {}): void {
    this.samples.push({ name, kind: 'counter', value, tags, ts: Date.now() });
  }
  timing(name: string, durationMs: number, tags: Record<string, string> = {}): void {
    this.samples.push({ name, kind: 'timing', value: durationMs, tags, ts: Date.now() });
  }
  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    this.samples.push({ name, kind: 'gauge', value, tags, ts: Date.now() });
  }
  snapshot(): MetricSample[] {
    return [...this.samples];
  }
}

/** 空 Metrics：不采集时注入，避免各处判空。 */
export class NoopMetrics implements Metrics {
  increment(): void {}
  timing(): void {}
  gauge(): void {}
  snapshot(): MetricSample[] {
    return [];
  }
}

/** 单调递增 id 生成器（测试确定性）；生产用 ulid 版本。 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  requestId(): string {
    this.counter += 1;
    return `req_test_${this.counter.toString().padStart(6, '0')}`;
  }
  toolCallId(): string {
    this.counter += 1;
    return `call_test_${this.counter.toString().padStart(6, '0')}`;
  }
}

/** 生产 id 生成器：request_id 形如 "req_" + ulid（20 §2.1）。 */
export class UlidIdGenerator implements IdGenerator {
  requestId(): string {
    return `req_${ulid()}`;
  }
  toolCallId(): string {
    return `call_${ulid()}`;
  }
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;

/** 最小 ulid 实现（26 字符，Cro bford base32，时间戳 48bit）。 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let out = '';
  for (let i = 0; i < ULID_TIME_LEN; i += 1) {
    out = ULID_ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  for (let i = 0; i < ULID_RANDOM_LEN; i += 1) {
    out += ULID_ALPHABET[Math.floor(Math.random() * 32)];
  }
  return out;
}
