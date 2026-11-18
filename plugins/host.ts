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
  HookName,
  MaybePromise,
  Plugin,
  PluginCapability,
  PluginManifest,
  PluginMountTarget,
  PluginResult,
  PluginScope,
  PluginToolSpec,
  RequestContext,
  ShortCircuit,
  ToolResultPart,
  ToolUsePart,
} from '../ir/index.js';
import type { JSONSchema } from '../ir/index.js';
import { effectivePluginScope, validatePluginManifest } from '../ir/index.js';

export interface PluginRuntimeStats {
  call_count: number;
  error_count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  last_called_at?: number;
  last_error?: string;
  hook_counts: Record<string, number>;
}

export interface PluginLogEntry {
  id: string;
  ts: number;
  plugin: string;
  hook: string;
  tool_name?: string;
  request_id?: string;
  status: 'ok' | 'error';
  duration_ms: number;
  summary: string;
}

export interface PluginSnapshot {
  name: string;
  title?: string;
  description?: string;
  version: string;
  hooks: HookName[];
  capabilities: PluginCapability[];
  scope: PluginScope;
  order: number;
  timeout_ms: number;
  fatal: boolean;
  enabled: boolean;
  mount_targets: PluginMountTarget[];
  homepage?: string;
  license?: string;
  attribution?: string;
  tools?: readonly PluginToolSpec[];
  config_schema?: JSONSchema;
  config: Record<string, unknown>;
  stats: PluginRuntimeStats;
  custom_status?: Record<string, string | number | boolean>;
}

export interface PluginRegistration {
  plugin: Plugin;
  config: Record<string, unknown>;
  enabled: boolean;
  mountTargets: PluginMountTarget[];
  stats: PluginRuntimeStats;
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
  /** 设置插件挂载平面（内置 AI / API 访问）。 */
  setMountTargets?(name: string, targets: readonly PluginMountTarget[]): void;
  /** 列出所有已注册插件的运行态快照。 */
  listPluginSnapshots?(): PluginSnapshot[];
  /** 获取/更新插件运行时配置。 */
  getConfig?(name: string): Record<string, unknown>;
  setConfig?(name: string, config: Record<string, unknown>): Promise<void>;
  /** 查询/清空插件执行日志。 */
  listLogs?(filter?: { plugin?: string; status?: 'ok' | 'error'; limit?: number }): PluginLogEntry[];
  clearLogs?(plugin?: string): void;

  /** 各 hook 的插件列表（按 order 升序，已过滤 enabled）。 */
  requestSide(): Plugin[];
  responseSide(): Plugin[];
  streamSide(): Plugin[];
  errorSide(): Plugin[];
  toolSide(): Plugin[];

  /** 是否有任何 full-canonical 请求侧插件（onRequest；D-fastpath-2 的决定性输入）。 */
  hasFullCanonicalRequestSide(): boolean;
  /**
   * 是否有任何 full-canonical **响应侧**插件（D-fastpath-2 的决定性输入，2026-11-16
   * 起与请求侧对称，见 ir/plugin.ts 文件头的 D-fastpath-2）。
   *
   * "响应侧" = `onResponse` + `onStreamChunk`：流式下 canonical 响应就是以
   * CanonicalStreamEvent 序列存在的（25 §2），fast path 两条都不落 canonical——
   * 于是 full-canonical 的响应侧插件在 fast path 下同样什么都拿不到，必须禁用 fast path。
   */
  hasFullCanonicalResponseSide(): boolean;

  /** 增删/启停时通知订阅者。 */
  onChange(listener: () => void): void;

  /**
   * 改插件单次调用的缺省超时（运行时设置用，见 config/settings.ts）。
   *
   * 可选方法：不注入设置服务的装配（测试、demo）没有这个入口，行为与之前一致。
   * manifest 里显式声明了 `timeout_ms` 的插件不受影响（显式优于缺省）。
   */
  setDefaultTimeoutMs?(ms: number): void;

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

const MAX_PLUGIN_LOGS = 300;

export class DefaultPluginHost implements PluginHost {
  private readonly registrations = new Map<string, PluginRegistration>();
  private readonly listeners = new Set<() => void>();
  private readonly logs: PluginLogEntry[] = [];
  private logSeq = 0;
  /** 缺省超时。可变是为了让「插件超时」成为运行时设置（config/settings.ts）。 */
  private defaultTimeoutMs: number;
  constructor(
    private readonly services: GatewayServices,
    defaultTimeoutMs = 5_000,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** 改缺省超时（热生效）。manifest 显式声明了 `timeout_ms` 的插件不受影响。 */
  setDefaultTimeoutMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`插件缺省超时必须为正数，收到 ${ms}`);
    }
    this.defaultTimeoutMs = ms;
  }

  register(plugin: Plugin, config: unknown = {}): void {
    const errors = validatePluginManifest(plugin.manifest);
    if (errors.length > 0) {
      throw new PluginRegistrationError(`插件 manifest 不合法:\n- ${errors.join('\n- ')}`);
    }
    const existing = this.registrations.get(plugin.manifest.name);
    if (existing !== undefined) {
      throw new PluginRegistrationError(`插件重名: ${plugin.manifest.name}`);
    }
    const defaultTargets: PluginMountTarget[] =
      plugin.manifest.mount_targets && plugin.manifest.mount_targets.length > 0
        ? [...plugin.manifest.mount_targets]
        : ['agent', 'data_plane'];
    const cfgObj =
      config !== null && typeof config === 'object' && !Array.isArray(config)
        ? { ...(config as Record<string, unknown>) }
        : {};
    this.registrations.set(plugin.manifest.name, {
      plugin,
      config: cfgObj,
      enabled: true,
      mountTargets: defaultTargets,
      stats: {
        call_count: 0,
        error_count: 0,
        total_duration_ms: 0,
        avg_duration_ms: 0,
        hook_counts: {},
      },
    });
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

  setMountTargets(name: string, targets: readonly PluginMountTarget[]): void {
    const reg = this.registrations.get(name);
    if (reg === undefined) return;
    reg.mountTargets = [...new Set(targets)];
    this.emitChange();
  }

  getConfig(name: string): Record<string, unknown> {
    return { ...(this.registrations.get(name)?.config ?? {}) };
  }

  async setConfig(name: string, config: Record<string, unknown>): Promise<void> {
    const reg = this.registrations.get(name);
    if (reg === undefined) return;
    reg.config = { ...config };
    if (reg.plugin.onConfigChange !== undefined) {
      await reg.plugin.onConfigChange(reg.config);
    }
    this.emitChange();
  }

  listPluginSnapshots(): PluginSnapshot[] {
    return [...this.registrations.values()]
      .sort((a, b) => (a.plugin.manifest.order ?? 100) - (b.plugin.manifest.order ?? 100))
      .map((reg) => {
        const m = reg.plugin.manifest;
        let customStatus: Record<string, string | number | boolean> | undefined;
        if (reg.plugin.status !== undefined) {
          try {
            customStatus = reg.plugin.status();
          } catch {
            customStatus = undefined;
          }
        }
        return {
          name: m.name,
          ...(m.title === undefined ? {} : { title: m.title }),
          ...(m.description === undefined ? {} : { description: m.description }),
          version: m.version,
          hooks: [...m.hooks],
          capabilities: [...(m.capabilities ?? [])],
          scope: effectivePluginScope(m),
          order: m.order ?? 100,
          timeout_ms: m.timeout_ms ?? this.defaultTimeoutMs,
          fatal: m.fatal === true,
          enabled: reg.enabled,
          mount_targets: [...reg.mountTargets],
          ...(m.homepage === undefined ? {} : { homepage: m.homepage }),
          ...(m.license === undefined ? {} : { license: m.license }),
          ...(m.attribution === undefined ? {} : { attribution: m.attribution }),
          ...(m.tools === undefined ? {} : { tools: m.tools }),
          ...(m.config_schema === undefined ? {} : { config_schema: m.config_schema }),
          config: { ...reg.config },
          stats: {
            ...reg.stats,
            hook_counts: { ...reg.stats.hook_counts },
          },
          ...(customStatus === undefined ? {} : { custom_status: customStatus }),
        };
      });
  }

  listLogs(filter?: {
    plugin?: string;
    status?: 'ok' | 'error';
    limit?: number;
  }): PluginLogEntry[] {
    let items = [...this.logs];
    if (filter?.plugin !== undefined && filter.plugin !== '') {
      items = items.filter((l) => l.plugin === filter.plugin);
    }
    if (filter?.status !== undefined) {
      items = items.filter((l) => l.status === filter.status);
    }
    items.reverse();
    const limit = filter?.limit ?? 100;
    return items.slice(0, Math.max(1, Math.min(MAX_PLUGIN_LOGS, limit)));
  }

  clearLogs(plugin?: string): void {
    if (plugin === undefined || plugin === '') {
      this.logs.length = 0;
      return;
    }
    for (let i = this.logs.length - 1; i >= 0; i -= 1) {
      if (this.logs[i]?.plugin === plugin) {
        this.logs.splice(i, 1);
      }
    }
  }

  private registrationsByHook(
    hook: PluginManifest['hooks'][number],
    ctx?: RequestContext,
  ): PluginRegistration[] {
    return [...this.registrations.values()]
      .filter((r) => {
        if (!r.enabled || !r.plugin.manifest.hooks.includes(hook)) return false;
        if (ctx === undefined) return true;
        return this.shouldRunForContext(r, ctx);
      })
      .sort((a, b) => (a.plugin.manifest.order ?? 100) - (b.plugin.manifest.order ?? 100));
  }

  private shouldRunForContext(reg: PluginRegistration, ctx: RequestContext): boolean {
    const target: PluginMountTarget = ctx.auth?.key_id === 'agent-builtin' ? 'agent' : 'data_plane';
    if (!reg.mountTargets.includes(target)) return false;
    if (target === 'data_plane') {
      const name = reg.plugin.manifest.name;
      if (ctx.auth?.disabled_plugins?.includes(name)) return false;
      if (
        ctx.auth?.allowed_plugins !== undefined &&
        ctx.auth.allowed_plugins.length > 0 &&
        !ctx.auth.allowed_plugins.includes(name)
      ) {
        return false;
      }
    }
    return true;
  }

  private byHook(hook: PluginManifest['hooks'][number]): Plugin[] {
    return this.registrationsByHook(hook).map((r) => r.plugin);
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

  hasFullCanonicalRequestSide(): boolean {
    return this.requestSide().some((p) => effectivePluginScope(p.manifest) === 'full-canonical');
  }

  hasFullCanonicalResponseSide(): boolean {
    // onResponse + onStreamChunk 都算响应侧：流式下 canonical 响应就是事件序列。
    const side = [...this.responseSide(), ...this.streamSide()];
    return side.some((p) => effectivePluginScope(p.manifest) === 'full-canonical');
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emitChange(): void {
    for (const l of this.listeners) l();
  }

  private appendLog(entry: Omit<PluginLogEntry, 'id'>): void {
    this.logSeq += 1;
    this.logs.push({ id: `plog_${this.logSeq}`, ...entry });
    if (this.logs.length > MAX_PLUGIN_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_PLUGIN_LOGS);
    }
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
    meta?: { toolName?: string; skipOkLog?: boolean; summarize?: (val: T) => string },
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const timeout = plugin.manifest.timeout_ms ?? this.defaultTimeoutMs;
    const nowFn = () => this.services.clock?.now?.() ?? Date.now();
    const started = nowFn();
    const reg = this.registrations.get(plugin.manifest.name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        (async () => fn())(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`plugin timeout after ${timeout}ms`)), timeout);
          // 不 unref：测试里要让超时真的触发
        }),
      ]);
      const durationMs = Math.max(0, nowFn() - started);
      if (reg !== undefined) {
        reg.stats.call_count += 1;
        reg.stats.total_duration_ms += durationMs;
        reg.stats.avg_duration_ms = Math.round(reg.stats.total_duration_ms / reg.stats.call_count);
        reg.stats.last_called_at = nowFn();
        reg.stats.hook_counts[hook] = (reg.stats.hook_counts[hook] ?? 0) + 1;
      }
      if (meta?.skipOkLog !== true) {
        this.appendLog({
          ts: nowFn(),
          plugin: plugin.manifest.name,
          hook,
          ...(meta?.toolName === undefined ? {} : { tool_name: meta.toolName }),
          ...(ctx.request_id ? { request_id: ctx.request_id } : {}),
          status: 'ok',
          duration_ms: durationMs,
          summary: meta?.summarize ? meta.summarize(result) : `${hook} 执行成功`,
        });
      }
      this.services.metrics.timing(`plugin.${hook}.duration_ms`, durationMs, {
        plugin: plugin.manifest.name,
        result: 'ok',
      });
      return { ok: true, value: result };
    } catch (err) {
      const durationMs = Math.max(0, nowFn() - started);
      const message = err instanceof Error ? err.message : String(err);
      if (reg !== undefined) {
        reg.stats.call_count += 1;
        reg.stats.error_count += 1;
        reg.stats.total_duration_ms += durationMs;
        reg.stats.avg_duration_ms = Math.round(reg.stats.total_duration_ms / reg.stats.call_count);
        reg.stats.last_called_at = nowFn();
        reg.stats.last_error = message;
        reg.stats.hook_counts[hook] = (reg.stats.hook_counts[hook] ?? 0) + 1;
      }
      this.appendLog({
        ts: nowFn(),
        plugin: plugin.manifest.name,
        hook,
        ...(meta?.toolName === undefined ? {} : { tool_name: meta.toolName }),
        ...(ctx.request_id ? { request_id: ctx.request_id } : {}),
        status: 'error',
        duration_ms: durationMs,
        summary: message.slice(0, 240),
      });
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
    for (const reg of this.registrationsByHook('onRequest', ctx)) {
      const plugin = reg.plugin;
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
    for (const reg of this.registrationsByHook('onResponse', ctx)) {
      const plugin = reg.plugin;
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
    for (const reg of this.registrationsByHook('onStreamChunk', ctx)) {
      const plugin = reg.plugin;
      if (plugin.onStreamChunk === undefined) continue;
      const single: CanonicalStreamEvent | null = Array.isArray(current)
        ? (current[0] ?? null)
        : current;
      if (single === null) return null;
      const out = await this.invoke<
        CanonicalStreamEvent | CanonicalStreamEvent[] | null | undefined
      >(
        plugin,
        'onStreamChunk',
        (): MaybePromise<CanonicalStreamEvent | CanonicalStreamEvent[] | null | undefined> =>
          plugin.onStreamChunk!(single, ctx),
        ctx,
        { skipOkLog: true },
      );
      if (!out.ok) continue; // 失败 → 透传原事件
      if (out.value === undefined) continue;
      current = out.value;
    }
    return current;
  }

  async runOnToolCall(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart> {
    const candidates = this.registrationsByHook('onToolCall', ctx);
    // 优先按 manifest.tools 精确路由到声明了该工具的插件
    const directOwner = candidates.find((r) =>
      r.plugin.manifest.tools?.some((t) => t.name === call.name),
    );
    const ordered =
      directOwner !== undefined
        ? [directOwner, ...candidates.filter((r) => r !== directOwner)]
        : candidates;

    for (const reg of ordered) {
      const plugin = reg.plugin;
      if (plugin.onToolCall === undefined) continue;
      const out = await this.invoke(
        plugin,
        'onToolCall',
        () => plugin.onToolCall!(call, ctx),
        ctx,
        {
          toolName: call.name,
          summarize: (res) =>
            res.is_error ? `${call.name} 返回错误` : `${call.name} 执行完成`,
        },
      );
      if (out.ok) return out.value;
    }
    throw new Error(
      `工具 ${call.name} 没有可用的 onToolCall 插件执行器。` +
        '网关 agentic loop 里的工具必须由插件或内置执行器提供（30 §2 registerTool）。',
    );
  }

  async notifyError(err: CanonicalError, ctx: RequestContext): Promise<void> {
    for (const reg of this.registrationsByHook('onError', ctx)) {
      const plugin = reg.plugin;
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
