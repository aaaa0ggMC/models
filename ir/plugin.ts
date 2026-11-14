/**
 * ir/plugin.ts —— 插件系统接口（5 个 generic hook）。
 *
 * 唯一事实来源：docs/design/30-plugin-api.md §2（接口）、§3（生命周期时序）；
 * 跨帧滚动缓冲器见 docs/design/25-streaming.md §7.2。
 *
 * 硬约束：插件**只面对 canonical**，拿不到任何 provider 原始 body，也拿不到 provider 的 HTTP 客户端。
 *
 * ⚠️ D-fastpath-2（仓库主人 2026-11 拍板， issue #8 第 3 条）：
 *   `PluginManifest.scope` 声明本插件需要看到多大的 canonical：
 *     - "full-canonical"（**默认**）：要完整物化的 canonical → 该请求不能走 fast path；
 *     - "envelope-only"：只读信封 + 路由必需字段 → 不阻止 fast path。
 *   fast path 准入 = 「没有启用任何 scope 为 full-canonical 的请求侧插件」。
 *   该条件由组合根在启动时计算并缓存（见 composition-root.ts 的
 *   `createFastPathAdmission()`），运行中增删插件时调用 `invalidate()` 失效重算。
 */

import type { JSONSchema } from "./json-schema.js";
import type { CanonicalRequestEnvelope, CanonicalResponseEnvelope } from "./envelope.js";
import type { CanonicalStreamEvent, StreamFrame } from "./stream.js";
import type { CanonicalError } from "./error.js";
import type { CanonicalUsage } from "./usage.js";
import type { ToolResultPart, ToolUsePart } from "./chat.js";
import type { RequestContext } from "./context.js";

export type HookName = "onRequest" | "onResponse" | "onStreamChunk" | "onError" | "onToolCall";

/** 插件需要的 canonical 完整度（D-fastpath-2）。 */
export type PluginScope = "envelope-only" | "full-canonical";

/** 插件声明。注册时提供，运行期不可变。 */
export interface PluginManifest {
  /** 唯一，kebab-case，如 "billion-context"。 */
  name: string;
  /** semver。 */
  version: string;
  /** 本插件关心的生命周期点。 */
  hooks: HookName[];
  capabilities?: PluginCapability[];
  /** 配置项 schema，WebUI 据此自动生成配置表单。 */
  config_schema?: JSONSchema;
  /**
   * 需要全量响应才能工作（如内容审核、用量改写）。
   * 声明后 Runner 仍以流式转发，但会额外维护聚合视图传给插件。
   */
  needs?: "aggregate" | "cross_chunk";
  /** 插件异常是否阻断请求，默认 false。 */
  fatal?: boolean;
  /** 单次调用超时 ms，默认 5000。 */
  timeout_ms?: number;
  /** 执行顺序，小的先跑；默认 100。 */
  order?: number;
  /**
   * 本插件需要的 canonical 完整度（D-fastpath-2）。
   * **默认 "full-canonical"**——不声明就拿不到 fast path 准入，安全侧优先。
   */
  scope?: PluginScope;
}

export type PluginCapability =
  | "context_compaction"
  | "redaction"
  | "tool_provider"
  | "audit"
  | "guard";

export type PluginResult<T> =
  | T // 改写后的值
  | ShortCircuit // 直接给出应答，跳过后续上游调用
  | void; // 不改写

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
  execute(input: Record<string, unknown>, ctx: RequestContext): Promise<ToolResultPart> | ToolResultPart;
}

export interface Plugin {
  manifest: PluginManifest;
  init?(cfg: unknown, gw: GatewayServices): void | Promise<void>;
  /** 请求侧：可改写 canonical、可短路、可关闭 fast path。 */
  onRequest?(
    req: CanonicalRequestEnvelope,
    ctx: RequestContext,
  ): PluginResult<CanonicalRequestEnvelope>;
  /** 流式：逐事件处理，返回 null 表示丢弃。 */
  onStreamChunk?(ev: CanonicalStreamEvent, ctx: RequestContext): CanonicalStreamEvent | CanonicalStreamEvent[] | null;
  /** 响应侧：非流式在编码前；流式在流关闭后（只能观测/副作用）。 */
  onResponse?(
    res: CanonicalResponseEnvelope,
    ctx: RequestContext,
  ): PluginResult<CanonicalResponseEnvelope>;
  /** 工具执行（网关 agentic loop 内）。 */
  onToolCall?(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart> | ToolResultPart;
  /** 任意阶段抛错/返回错误时调用。**不改变控制流**（30 §3）。 */
  onError?(err: CanonicalError, ctx: RequestContext): void;
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
  if (manifest.hooks.includes("onStreamChunk") && manifest.capabilities?.includes("context_compaction")) {
    errors.push(
      `plugin ${manifest.name}: hooks 含 onStreamChunk 时不得声明 capabilities.context_compaction` +
        "（压缩只在 onRequest 生效，25-streaming.md §7.3）",
    );
  }
  if (manifest.hooks.length === 0) {
    errors.push(`plugin ${manifest.name}: hooks 不能为空`);
  }
  for (const hook of manifest.hooks) {
    if (!["onRequest", "onResponse", "onStreamChunk", "onError", "onToolCall"].includes(hook)) {
      errors.push(`plugin ${manifest.name}: 未知 hook ${hook}`);
    }
  }
  return errors;
}

/** 取生效的 scope；缺省按 full-canonical（安全侧优先，D-fastpath-2）。 */
export function effectivePluginScope(manifest: PluginManifest): PluginScope {
  return manifest.scope ?? "full-canonical";
}
