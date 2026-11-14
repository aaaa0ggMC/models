/**
 * plugins/host.ts —— 插件运行时（hook 调度 + 故障隔离）。
 *
 * 唯一事实来源：docs/design/30-plugin-api.md §2（接口）、§3（生命周期与调用时序）。
 *
 * 调度规则（30 §3，逐条落地）：
 *   - 同一 hook 内多插件按 `order` 升序执行；前一个的输出是后一个的输入；
 *   - `onRequest` 返回 `ShortCircuit` 时**后续插件的 onRequest 不再执行**，直接进 S9
 *     （`onResponse` 仍执行，让审计类插件看到）；
 *   - `onStreamChunk` 返回数组 = 一帧变多帧；返回 null = 丢弃（chat 允许，
 *     tts 音频分片禁止——Runner 对 kind:"tts" 的 delta 强制拒绝 null，违例记 plugin_error）；
 *   - 插件抛异常默认**不阻断**请求（记 metric + warning），注册时声明 `fatal: true` 可改变；
 *   - 单个插件超时（默认 5s）视为失败并按上述策略处理；
 *   - `onError` **不改变控制流**，只做观测/告警/副作用。
 *
 * 硬约束：插件拿到的只有 canonical + RequestContext，拿不到任何 provider 原始 body。
 */

import type {
  CanonicalError,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  GatewayServices,
  MaybePromise,
  Plugin,
  PluginManifest,
  PluginResult,
  RequestContext,
  ShortCircuit,
  ToolResultPart,
  ToolUsePart,
} from '../ir/index.js';
import { effectivePluginScope, validatePluginManifest } from '../ir/index.js';

export interface PluginRegistration {
  plugin: Plugin;
  config: unknown;
  enabled: boolean;
}

export class PluginRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRegistrationError';
  }
}

export interface PluginHost {
  /** 注册插件。manifest 不合法时抛 PluginRegistrationError（启动即失败，不静默）。 */
  register(plugin: Plugin, config?: unknown): void;
  /** 卸载插件（进程退出/热卸载）。 */
  unregister(name: string): void;
  /** 运行中启停；内部广播 onChange 让 fast path 准入失效重算（D-fastpath-2）。 */
  setEnabled(name: string, enabled: boolean): void;
  isEnabled(name: string): boolean;

  /** 各 hook 的插件列表（按 order 升序，已过滤 enabled）。 */
  requestSide(): Plugin[];
  responseSide(): Plugin[];
  streamSide(): Plugin[];
  errorSide(): Plugin[];
  toolSide(): Plugin[];

  /** 是否有任何请求侧插件（D-fastpath-2 的输入之一）。 */
  hasRequestSide(): boolean;
  /** 是否有任何 full-canonical 请求侧插件（D-fastpath-2 的决定性输入）。 */
  hasFullCanonicalRequestSide(): boolean;

  /** 增删/启停时通知订阅者。 */
  onChange(listener: () => void): void;

  /** 执行 onRequest 链。 */
  runOnRequest(
    req: CanonicalRequestEnvelope,
    ctx: RequestContext,
  ): Promise<PluginResult<CanonicalRequestEnvelope>>;
  /** 执行 onResponse 链。 */
  runOnResponse(
    res: CanonicalResponseEnvelope,
    ctx: RequestContext,
  ): Promise<PluginResult<CanonicalResponseEnvelope>>;
  /** 执行 onStreamChunk 链。 */
  runOnStreamChunk(
    ev: CanonicalStreamEvent,
    ctx: RequestContext,
  ): Promise<CanonicalStreamEvent | CanonicalStreamEvent[] | null>;
  /** 执行 onToolCall 链（网关 agentic loop 内）。 */
  runOnToolCall(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart>;
  /** 广播 onError。绝不抛。 */
  notifyError(err: CanonicalError, ctx: RequestContext): Promise<void>;
  /** 全部插件的 dispose。 */
  dispose(): Promise<void>;
}

export class DefaultPluginHost implements PluginHost {
  private readonly registrations = new Map<string, PluginRegistration>();
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly services: GatewayServices,
    private readonly defaultTimeoutMs = 5_000,
  ) {}

  register(plugin: Plugin, config: unknown = {}): void {
    const errors = validatePluginManifest(plugin.manifest);
    if (errors.length > 0) {
      throw new PluginRegistrationError(`插件 manifest 不合法:\n- ${errors.join('\n- ')}`);
    }
    const existing = this.registrations.get(plugin.manifest.name);
    if (existing !== undefined) {
      throw new PluginRegistrationError(`插件重名: ${plugin.manifest.name}`);
    }
    this.registrations.set(plugin.manifest.name, { plugin, config, enabled: true });
    this.emitChange();
  }

  unregister(name: string): void {
    const reg = this.registrations.get(name);
    if (reg === undefined) return;
    this.registrations.delete(name);
    this.emitChange();
  }

  setEnabled(name: string, enabled: boolean): void {
    const reg = this.registrations.get(name);
    if (reg === undefined) return;
    reg.enabled = enabled;
    this.emitChange();
  }

  isEnabled(name: string): boolean {
    return this.registrations.get(name)?.enabled ?? false;
  }

  private byHook(hook: PluginManifest['hooks'][number]): Plugin[] {
    return [...this.registrations.values()]
      .filter((r) => r.enabled && r.plugin.manifest.hooks.includes(hook))
      .sort((a, b) => (a.plugin.manifest.order ?? 100) - (b.plugin.manifest.order ?? 100))
      .map((r) => r.plugin);
  }

  requestSide(): Plugin[] {
    return this.byHook('onRequest');
  }
  responseSide(): Plugin[] {
    return this.byHook('onResponse');
  }
  streamSide(): Plugin[] {
    return this.byHook('onStreamChunk');
  }
  errorSide(): Plugin[] {
    return this.byHook('onError');
  }
  toolSide(): Plugin[] {
    return this.byHook('onToolCall');
  }

  hasRequestSide(): boolean {
    return this.requestSide().length > 0;
  }

  hasFullCanonicalRequestSide(): boolean {
    return this.requestSide().some((p) => effectivePluginScope(p.manifest) === 'full-canonical');
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emitChange(): void {
    for (const l of this.listeners) l();
  }

  /**
   * 带超时 + 故障隔离地调用一个插件方法。
   * 返回 { ok: false } 表示该插件失败（已记 metric + warning），调用方按"不改写"继续。
   */
  private async invoke<T>(
    plugin: Plugin,
    hook: string,
    fn: () => MaybePromise<T>,
    ctx: RequestContext,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const timeout = plugin.manifest.timeout_ms ?? this.defaultTimeoutMs;
    const started = this.services.clock?.now?.() ?? Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => fn())(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`plugin timeout after ${timeout}ms`)), timeout);
          // 不 unref：测试里要让超时真的触发
        }),
      ]);
      this.services.metrics.timing(`plugin.${hook}.duration_ms`, Date.now() - started, {
        plugin: plugin.manifest.name,
        result: 'ok',
      });
      return { ok: true, value: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.services.metrics.increment('plugin.error', 1, {
        plugin: plugin.manifest.name,
        hook,
      });
      this.services.log.warn('plugin 调用失败，按不改写处理', {
        plugin: plugin.manifest.name,
        hook,
        error: message,
        fatal: String(plugin.manifest.fatal ?? false),
      });
      ctx.warn(`plugin_error:${plugin.manifest.name}`, message);
      return { ok: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async runOnRequest(
    req: CanonicalRequestEnvelope,
    ctx: RequestContext,
  ): Promise<PluginResult<CanonicalRequestEnvelope>> {
    let current = req;
    for (const plugin of this.requestSide()) {
      if (plugin.onRequest === undefined) continue;
      const res = await this.invoke(
        plugin,
        'onRequest',
        () => plugin.onRequest!(current, ctx),
        ctx,
      );
      if (!res.ok) {
        if (plugin.manifest.fatal === true) {
          return {
            short_circuit: true,
            reason: `plugin ${plugin.manifest.name} failed (fatal)`,
            error: {
              code: 'plugin_error',
              message: `插件 ${plugin.manifest.name} 失败且声明 fatal: true`,
              http_status: 500,
              retryable: false,
              request_id: ctx.request_id,
            },
          };
        }
        continue;
      }
      const value = res.value;
      if (isShortCircuit(value)) return value;
      if (value !== undefined && value !== null) current = value;
    }
    return current;
  }

  async runOnResponse(
    res: CanonicalResponseEnvelope,
    ctx: RequestContext,
  ): Promise<PluginResult<CanonicalResponseEnvelope>> {
    let current = res;
    for (const plugin of this.responseSide()) {
      if (plugin.onResponse === undefined) continue;
      const out = await this.invoke(
        plugin,
        'onResponse',
        () => plugin.onResponse!(current, ctx),
        ctx,
      );
      if (!out.ok) {
        if (plugin.manifest.fatal === true) {
          return {
            short_circuit: true,
            reason: `plugin ${plugin.manifest.name} failed (fatal)`,
            error: {
              code: 'plugin_error',
              message: `插件 ${plugin.manifest.name} 失败且声明 fatal: true`,
              http_status: 500,
              retryable: false,
              request_id: ctx.request_id,
            },
          };
        }
        continue;
      }
      const value = out.value;
      if (isShortCircuit(value)) return value;
      if (value !== undefined && value !== null) current = value;
    }
    return current;
  }

  async runOnStreamChunk(
    ev: CanonicalStreamEvent,
    ctx: RequestContext,
  ): Promise<CanonicalStreamEvent | CanonicalStreamEvent[] | null> {
    let current: CanonicalStreamEvent | CanonicalStreamEvent[] | null = ev;
    for (const plugin of this.streamSide()) {
      if (plugin.onStreamChunk === undefined) continue;
      const single: CanonicalStreamEvent | null = Array.isArray(current)
        ? (current[0] ?? null)
        : current;
      if (single === null) return null;
      const out = await this.invoke<CanonicalStreamEvent | CanonicalStreamEvent[] | null>(
        plugin,
        'onStreamChunk',
        (): MaybePromise<CanonicalStreamEvent | CanonicalStreamEvent[] | null> =>
          plugin.onStreamChunk!(single, ctx),
        ctx,
      );
      if (!out.ok) continue; // 失败 → 透传原事件
      current = out.value;
    }
    return current;
  }

  async runOnToolCall(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart> {
    // onToolCall 是"每次工具执行前后各一次"的横切点（20 §2）；插件返回的结果
    // 覆盖网关默认执行结果。没有插件时由调用方用默认执行器。
    for (const plugin of this.toolSide()) {
      if (plugin.onToolCall === undefined) continue;
      const out = await this.invoke(plugin, 'onToolCall', () => plugin.onToolCall!(call, ctx), ctx);
      if (out.ok) return out.value;
    }
    throw new Error(
      `工具 ${call.name} 没有可用的 onToolCall 插件执行器。` +
        '网关 agentic loop 里的工具必须由插件或内置执行器提供（30 §2 registerTool）。',
    );
  }

  async notifyError(err: CanonicalError, ctx: RequestContext): Promise<void> {
    for (const plugin of this.errorSide()) {
      if (plugin.onError === undefined) continue;
      await this.invoke(plugin, 'onError', () => plugin.onError!(err, ctx), ctx);
      // onError 的返回值一律忽略：它不改变控制流（30 §3）
    }
  }

  async dispose(): Promise<void> {
    for (const { plugin } of this.registrations.values()) {
      if (plugin.dispose === undefined) continue;
      try {
        await plugin.dispose();
      } catch {
        // dispose 失败不影响进程退出
      }
    }
    this.registrations.clear();
    this.emitChange();
  }
}

function isShortCircuit<T>(value: PluginResult<T>): value is ShortCircuit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'short_circuit' in value &&
    value.short_circuit === true
  );
}
