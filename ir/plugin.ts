/**
 * ir/plugin.ts —— 插件系统接口（5 个 generic hook）。
 *
 * 唯一事实来源：docs/design/30-plugin-api.md §2（接口）、§3（生命周期时序）；
 * 跨帧滚动缓冲器见 docs/design/25-streaming.md §7.2。
 *
 * 硬约束：插件**只面对 canonical**，拿不到任何 provider 原始 body，也拿不到 provider 的 HTTP 客户端。
 *
 * ⚠️ D-fastpath-2（仓库主人 2026-11 拍板， issue #8 第 3 条；2026-11-16 修订为**两侧对称**）：
 *   `PluginManifest.scope` 声明本插件需要看到多大的 canonical：
 *     - "full-canonical"（**默认**）：要完整物化的 canonical → 该请求不能走 fast path；
 *     - "envelope-only"：只读信封 + 路由必需字段 → 不阻止 fast path。
 *   fast path 准入 = 「没有启用任何 scope 为 full-canonical 的**请求侧或响应侧**插件」。
 *   响应侧与请求侧对称，理由是 fast path 对两侧都是「没有 canonical」：请求侧只有浅解析
 *   信封，响应侧只 extractUsage（S6 不解码响应）。只写请求侧会让一个**只声明 onResponse**
 *   的审计/脱敏插件（最常见的形态）在 fast path 下被静默跳过——不报错、不告警，只是从来
 *   没运行（PLUGIN-SYSTEM-REPORT.md §4.4，2026-11-16 已修）。
 *   "响应侧" = `onResponse` + `onStreamChunk`：流式下 canonical 响应就是以
 *   CanonicalStreamEvent 序列存在的（25 §2），fast path 两条都不落 canonical。
 *   `onError` / `onToolCall` 不算：前者收 CanonicalError、后者只在网关 agentic loop 里
 *   跑（而 loop 本身就会关掉 fast path），都不依赖 canonical 请求/响应物料化。
 *   仍被跳过的只有显式声明 envelope-only 的插件——那种情况 S7/S9 会记 warning，
 *   **绝不静默**。
 *   该条件由组合根在启动时计算并缓存（见 composition-root.ts 的
 *   `createFastPathAdmission()`），运行中增删插件时调用 `invalidate()` 失效重算。
 */

import type { JSONSchema } from './json-schema.js';
import type { CanonicalRequestEnvelope, CanonicalResponseEnvelope } from './envelope.js';
import type { CanonicalStreamEvent, StreamFrame } from './stream.js';
import type { CanonicalError } from './error.js';
import type { CanonicalUsage } from './usage.js';
import type { ToolResultPart, ToolUsePart } from './chat.js';
import type { RequestContext } from './context.js';
import type { Clock } from './clock.js';

export type HookName = 'onRequest' | 'onResponse' | 'onStreamChunk' | 'onError' | 'onToolCall';

/**
 * 插件需要的 canonical 完整度（D-fastpath-2）。
 *
 * - "full-canonical"（**默认**）：需要完整物化的 canonical。fast path 下**两侧**都没有
 *   canonical（请求侧只有浅解析信封，响应侧只 extractUsage），因此无论插件声明的是
 *   onRequest 还是 onResponse / onStreamChunk，都会让该请求改走慢路径——插件永远看得见
 *   完整 canonical，不会被静默跳过。
 * - "envelope-only"：只读信封 + 路由必需字段，不阻止 fast path。但 fast path 下依然拿不到
 *   canonical 响应，所以 onResponse / onStreamChunk **不会被调用**；S9 / S7 会各记一条
 *   warning（`onResponse_skipped_fast_path` / `onStreamChunk_skipped_fast_path`），
 *   把「这个插件这次没跑」写进 trace 与 UsageRecord.warnings，而不是静默。
 *
 * 默认 full-canonical 是安全侧优先：忘记声明 scope = 不会被静默跳过。
 */
export type PluginScope = 'envelope-only' | 'full-canonical';

/** 插件挂载平面：内置 AI 对话 / 外部数据面 API 访问。 */
export type PluginMountTarget = 'agent' | 'data_plane';

/** 插件提供的工具规格（供插件中心展示与精确路由）。 */
export interface PluginToolSpec {
  name: string;
  label: string;
  category: string;
  description: string;
  requires_confirmation?: boolean;
  parameters?: JSONSchema;
}

/** 插件声明。注册时提供，运行期不可变。 */
export interface PluginManifest {
  /** 唯一，kebab-case，如 "billion-context"。 */
  name: string;
  /** 人类可读标题（供管理界面展示）。 */
  title?: string;
  /** 一句话职责描述。 */
  description?: string;
  /** semver。 */
  version: string;
  /** 本插件关心的生命周期点。 */
  hooks: HookName[];
  capabilities?: PluginCapability[];
  /** 允许/默认挂载点：内置 AI (`agent`) 或外部 API 访问 (`data_plane`)。缺省为 `['data_plane']`。 */
  mount_targets?: readonly PluginMountTarget[];
  /** 插件对外提供的一组工具（含分类与确认标识）。 */
  tools?: readonly PluginToolSpec[];
  /** 开源主页 / 仓库链接。 */
  homepage?: string;
  /** 开源协议标识（如 MIT）。 */
  license?: string;
  /** 强制署名说明（如 billion-context / acp-kernel 附加条款）。 */
  attribution?: string;
  /** 配置项 schema，WebUI 据此自动生成配置表单。 */
  config_schema?: JSONSchema;
  /**
   * 需要全量响应才能工作（如内容审核、用量改写）。
   * 声明后 Runner 仍以流式转发，但会额外维护聚合视图传给插件。
   */
  needs?: 'aggregate' | 'cross_chunk';
  /** 插件异常是否阻断请求，默认 false。 */
  fatal?: boolean;
  /** 单次调用超时 ms，默认 5000。 */
  timeout_ms?: number;
  /** 执行顺序，小的先跑；默认 100。 */
  order?: number;
  /**
   * 本插件需要的 canonical 完整度（D-fastpath-2）。
   * **默认 "full-canonical"**——不声明就拿不到 fast path 准入，安全侧优先：
   * fast path 下请求侧与响应侧都没有 canonical，full-canonical 插件（无论挂在哪个 hook）
   * 都会让该请求改走慢路径。显式声明 "envelope-only" 才不阻止 fast path，但那种插件在
   * fast path 下也不会被调用（S7/S9 记 warning，不静默）。
   */
  scope?: PluginScope;
}

export type PluginCapability =
  'context_compaction' | 'redaction' | 'tool_provider' | 'audit' | 'guard';

export type PluginResult<T> =
  | T // 改写后的值
  | ShortCircuit // 直接给出应答，跳过后续上游调用
  | void; // 不改写

/**
 * 插件方法的返回值：同步或 Promise（30 §1 约束 4「同步 + 异步双模」）。
 * 插件主体是同步函数（低延迟路径），但可返回 Promise；Runner 对同步插件不做 await
 * 调度以降低开销——因此类型上必须同时容纳两者。
 */
export type MaybePromise<T> = T | Promise<T>;

export interface ShortCircuit {
  short_circuit: true;
  reason: string;
  /** 给出合成响应（缓存命中/mock/guard）。 */
  response?: CanonicalResponseEnvelope;
  /** 或直接报错（guard 拦截）。 */
  error?: CanonicalError;
  http_status?: number;
}

/** 插件可用的网关服务（只读 + 受控副作用）。 */
export interface GatewayServices {
  /** 结构化日志，自动带 request_id / plugin name。 */
  log: Logger;
  /** 指标埋点。 */
  metrics: Metrics;
  /** 时钟（插件内部计时用；不直接 Date.now()，便于测试控制）。 */
  clock?: Clock;
  /** 只读访问当前请求的 usage 累计（流式下为近似值）。 */
  currentUsage(): CanonicalUsage;
  /** 请求一个"网关侧工具"供本插件注册（供 agentic loop 调用）。 */
  registerTool?(tool: GatewayTool): void;
  /** 读本插件的 KV 命名空间（按 plugin name 隔离）。 */
  kv: KVNamespace;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface Metrics {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  timing(name: string, durationMs: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
}

export interface KVNamespace {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 网关侧工具（插件可注册，供 agentic loop 调用）。 */
export interface GatewayTool {
  name: string;
  description?: string;
  parameters: JSONSchema;
  execute(
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> | ToolResultPart;
}

export interface Plugin {
  manifest: PluginManifest;
  init?(cfg: unknown, gw: GatewayServices): void | Promise<void>;
  /**
   * 请求侧：可改写 canonical、可短路、可关闭 fast path。
   * full-canonical（默认）的 onRequest 插件在准入阶段就禁用 fast path（D-fastpath-2），
   * 因此它永远看得到完整物化的 canonical 请求。
   */
  onRequest?(
    req: CanonicalRequestEnvelope,
    ctx: RequestContext,
  ): MaybePromise<PluginResult<CanonicalRequestEnvelope>>;
  /** 流式：逐事件处理，返回 null 表示丢弃；返回 undefined 表示不改写（与其他 hook 一致）。 */
  onStreamChunk?(
    ev: CanonicalStreamEvent,
    ctx: RequestContext,
  ): MaybePromise<CanonicalStreamEvent | CanonicalStreamEvent[] | null | undefined>;
  /**
   * 响应侧：非流式在编码前；流式在流关闭后（只能观测/副作用）。
   * full-canonical（默认）的 onResponse 插件同样在准入阶段禁用 fast path（D-fastpath-2
   * 两侧对称）：fast path 下 S6 只 extractUsage，根本没有 canonical 响应可给。
   */
  onResponse?(
    res: CanonicalResponseEnvelope,
    ctx: RequestContext,
  ): MaybePromise<PluginResult<CanonicalResponseEnvelope>>;
  /** 工具执行（网关 agentic loop 内）。 */
  onToolCall?(call: ToolUsePart, ctx: RequestContext): MaybePromise<ToolResultPart>;
  /** 任意阶段抛错/返回错误时调用。**不改变控制流**（30 §3）。 */
  onError?(err: CanonicalError, ctx: RequestContext): void;
  /** 可选：返回插件自定义运行态指标（供管理界面展示）。 */
  status?(): Record<string, string | number | boolean>;
  /** 可选：运行时配置变更回调。 */
  onConfigChange?(config: Record<string, unknown>): MaybePromise<void>;
  dispose?(): void | Promise<void>;
}

/**
 * 跨帧滚动缓冲器（25-streaming.md §7.2）。
 * 只有声明 `manifest.needs: "cross_chunk"` 的插件才会拿到 buffer。
 */
export interface StreamChunkBuffer {
  /** 把帧推入缓冲区；返回"现在可以安全下发的字节数"。 */
  push(frame: StreamFrame): number;
  /** 冲刷缓冲区剩余部分（流结束或插件卸载时必须调用）。 */
  flush(): StreamFrame[];
  /** 缓冲区的 peek 视图（只读，用于匹配判断）。 */
  peek(n: number): string;
  /** 当前缓冲字节数。 */
  readonly buffered: number;
  /** 超过该阈值强制冲刷，防止无限缓冲。 */
  readonly max_buffer_bytes: number;
}

/** 注册期校验：`onStreamChunk` 插件不能同时声明 context_compaction（25 §7.3）。 */
export function validatePluginManifest(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  if (
    manifest.hooks.includes('onStreamChunk') &&
    manifest.capabilities?.includes('context_compaction')
  ) {
    errors.push(
      `plugin ${manifest.name}: hooks 含 onStreamChunk 时不得声明 capabilities.context_compaction` +
        '（压缩只在 onRequest 生效，25-streaming.md §7.3）',
    );
  }
  if (manifest.hooks.length === 0) {
    errors.push(`plugin ${manifest.name}: hooks 不能为空`);
  }
  for (const hook of manifest.hooks) {
    if (!['onRequest', 'onResponse', 'onStreamChunk', 'onError', 'onToolCall'].includes(hook)) {
      errors.push(`plugin ${manifest.name}: 未知 hook ${hook}`);
    }
  }
  return errors;
}

/** 取生效的 scope；缺省按 full-canonical（安全侧优先，D-fastpath-2）。 */
export function effectivePluginScope(manifest: PluginManifest): PluginScope {
  return manifest.scope ?? 'full-canonical';
}
