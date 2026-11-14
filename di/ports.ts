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
  /**
   * DeepSeek 上游 base URL 覆盖（可选）。
   *
   * 两个 DeepSeek access path（deepseek.openai-chat / deepseek.anthropic-messages）
   * 共用这一个 base；dialect 差异（/chat/completions 与 /anthropic/v1/messages）
   * 由 provider profile 的 endpointPath 表达，不靠 base URL 拼接。
   * 留空 = 用默认值 https://api.deepseek.com（代理/内网镜像场景才需要覆盖）。
   */
  deepseekBaseUrl?: string;
  /** 模型目录：启动时是否同步一次上游元数据（默认 true；关掉=只用静态表）。 */
  modelSyncOnStart: boolean;
  /** 模型目录：周期同步间隔（ms）；<= 0 = 不定时。 */
  modelSyncIntervalMs: number;
  /** 模型目录：上游元数据 TTL（ms），超过即在响应里标 `stale: true`。 */
  modelUpstreamTtlMs: number;
  /**
   * 管理员令牌（只从 `AG_ADMIN_TOKEN` 读；**值不落盘、不进日志/trace**）。
   *
   * 门禁 `/ag/models/sync`（手动触发元数据同步，给将来 WebUI 用）。未配置时该路由
   * 返回 503 并拒绝一切请求——"没配令牌"与"令牌不对"必须可区分。
   */
  adminToken?: string;
  /**
   * 数据面单 access token（66 §2.2 的极简模式；只从 `AG_ACCESS_TOKEN` 读）。
   *
   * 与虚拟 key **互斥**：虚拟 key 模式启用时它被忽略（判定与补偿见
   * auth/data-plane.ts 的文件头）。值不落盘、不进日志/trace。
   */
  accessToken?: string;
  /**
   * 显式启用数据面虚拟 key 模式（`AG_VIRTUAL_KEYS=1`）。
   *
   * 不设也行：虚拟 key 库里一旦有 ≥1 把 key，会自动切到虚拟 key 模式。
   * 这个开关的用途是「库还空着时就要按虚拟 key 模式跑」（例如先配好模式再建 key）。
   */
  virtualKeysEnabled?: boolean;
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
  modelSyncOnStart: true,
  modelSyncIntervalMs: 15 * 60 * 1000,
  modelUpstreamTtlMs: 60 * 60 * 1000,
};

/**
 * Provider profile：**单个上游 provider 的专有知识**。
 *
 * 为什么需要它（而不是把 provider 知识塞进 dialect codec）：codec 按
 * (FormatId, ModalityKind) 注册、一个实例服务所有同 dialect 的 access path
 * （openai / mock / deepseek.openai-chat 共用 OpenAIChatCodec）。DeepSeek 的
 * OpenAI 兼容面与 OpenAI 本家有系统性差异（端点路径、usage 缓存字段名、
 * 服务端工具类型名、thinking 开关形态），这些是 **provider 级**而不是
 * dialect 级的差异。按 00 §4.2 的模块划分，这类知识集中在
 * `providers/<provider>/profile.ts`，经本端口注入：
 *   - adaptor（codec）在 encode/decode 时按 `ctx.route.access_path` 查 profile，
 *     拿到端点路径 / builtin tool 的厂商专有形态；
 *   - S10（计量边界）按 access path 查 profile，把厂商专有 usage 字段名
 *     归一成 canonical（metering 模块的「usage 归一」职责，60-billing §2）。
 *
 * 全部方法可选：没有 profile（openai / anthropic / mock）时行为与今天完全一致。
 */
export interface ProviderProfile {
  readonly id: string;
  /** 该 profile 覆盖的 access path id 列表。 */
  readonly accessPaths: readonly string[];
  /**
   * 端点路径覆盖：该 access path 的上游路径。
   *
   * 典型用例：DeepSeek 的 OpenAI 兼容面是 `POST /chat/completions`（**没有 /v1**，
   * 与 OpenAI 本家的 `/v1/chat/completions` 不同），Anthropic 兼容面是
   * `/anthropic/v1/messages`（SDK base_url 是 `https://api.deepseek.com/anthropic`）。
   * 返回 undefined = 用 dialect codec 的默认路径。
   */
  endpointPath?(accessPath: string): string | undefined;
  /**
   * usage 归一：从**上游原始 usage 对象**导出 token 计量。
   *
   * 入参是 dialect codec 逐字段保留进 `CanonicalUsage.raw` 的那份原文
   * （40 §2.2c I4：raw 独立于 units，永不被聚合破坏）。典型用例：DeepSeek 的
   * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 是 usage **顶层**字段，
   * 而 OpenAI 系把缓存数埋在 `prompt_tokens_details.cached_tokens` 里。
   * 返回 undefined = 不干预（沿用 dialect codec 已算出的 units）。
   */
  usageFromRaw?(raw: Record<string, unknown>): import('../ir/index.js').TokenUsage | undefined;
  /**
   * canonical builtin tool 名 → 上游 wire 形态（`tools[]` 条目）。
   *
   * 50-builtin-search.md §3.1 模式 A（上游原生执行）：canonical 只用稳定名
   * （web_search / url_context），厂商专有类型串（deepseek_web_search …）在
   * 映射时还原。`format` 让同一 provider 在不同 dialect 下给不同形态——
   * DeepSeek 的 Messages 面要求 `{"type":"deepseek_web_search","name":"deepseek_web_search"}`
   * （name 必填且等于 type），Chat Completions 面只要 `{"type":"deepseek_web_search"}`。
   * 返回 undefined = 该 canonical 名在此 provider 无原生对应（调用方丢弃 + 告警）。
   */
  builtinToolWire?(
    canonicalName: import('../ir/index.js').BuiltinTool['name'],
    format: string,
  ): { type: string; name?: string } | undefined;
  /**
   * 上游 wire 的 `tools[].type` → canonical builtin 名（`builtinToolWire` 的逆）。
   * 认不出返回 undefined（调用方按未建模节点保留，不猜）。
   */
  builtinToolCanonicalName?(
    vendorType: string,
  ): import('../ir/index.js').BuiltinTool['name'] | undefined;
  /**
   * 该 canonical builtin 工具在上游是否接受 `BuiltinTool.config` 里的配置字段
   * （缺省 true = 原样带上）。
   *
   * 为什么需要这个开关：canonical 的 WebSearchConfig 有 max_results / allowed_domains /
   * recency 等一整套过滤能力，但不是每家上游都认——DeepSeek 的全家桶工具是**裸能力
   * 开关**，官方文档明确 `allowed_domains` / `blocked_domains` / `user_location`
   * 一律返回 400，「A tool has allowed_domains … → tools: allowed_domains is not
   * supported」。这种 provider 必须显式声明「不吃配置」，让调用方丢弃 + 告警，
   * 而不是把一个上游会 400 的字段原样发过去。
   */
  builtinToolAcceptsConfig?(canonicalName: import('../ir/index.js').BuiltinTool['name']): boolean;
  /**
   * canonical `ThinkingConfig` → 上游请求参数字段（provider 专有形态）。
   *
   * 典型用例：DeepSeek 的 Chat Completions 面用 `thinking: {"type":"enabled"|"disabled"}`
   * 对象开关（省略时**默认开启**推理），而 OpenAI 本家只有离散 `reasoning_effort`。
   * 若 provider 的默认值与 canonical 的 `enabled` 语义相反，必须在这里显式表达，
   * 否则「客户端要求关推理」会被上游的默认开启吞掉。返回 undefined = 用 dialect
   * codec 的默认映射。
   */
  thinkingWire?(thinking: import('../ir/index.js').ThinkingConfig): Record<string, unknown>;
}

/** provider profile 注册表（按 access path 查；组合根装配时注入）。 */
export interface ProviderProfileRegistry {
  forAccessPath(accessPath: string): ProviderProfile | undefined;
  list(): ProviderProfile[];
}

/** 内存实现：显式注册、重复 id 即报错（与 InMemoryAdaptorRegistry 同立场）。 */
export class InMemoryProviderProfileRegistry implements ProviderProfileRegistry {
  private readonly profiles: ProviderProfile[] = [];

  register(profile: ProviderProfile): void {
    if (this.profiles.some((p) => p.id === profile.id)) {
      throw new Error(`provider profile 重复注册: ${profile.id}`);
    }
    this.profiles.push(profile);
  }

  forAccessPath(accessPath: string): ProviderProfile | undefined {
    return this.profiles.find((p) => p.accessPaths.includes(accessPath));
  }

  list(): ProviderProfile[] {
    return [...this.profiles];
  }
}

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
