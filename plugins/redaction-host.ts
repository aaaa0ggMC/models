/**
 * plugins/redaction-host.ts —— 把工具结果脱敏包进插件主机。
 *
 * 设计依据：docs/design/95-agent-chat.md §7.1。
 *
 * ## 为什么脱敏点在这里
 *
 * 网关 agentic loop 的 APPEND_TURN 只重跑 S4→S8，`onRequest` 看不到追加进来的
 * tool_result（20-pipeline.md §5.2）——所以「请求侧插件脱敏」覆盖不到工具结果。
 * 而工具结果恰恰是最可能泄漏密钥的一路（某个工具实现疏忽，把上游响应原样返回）。
 *
 * `PluginHost.runOnToolCall` 是工具结果进入 canonical 的**唯一入口**，在这里包一层
 * 就覆盖了所有工具（包括将来新增的），且不用改循环编排一行代码。
 *
 * ## 可关
 *
 * `agent_redact_tool_results`（默认开）可以关掉这一层。关掉之后工具结果不再过脱敏，
 * 用户消息与服务端权威规则仍然生效——这是用户对自己的部署做的显式选择。
 */

import type { Plugin, RequestContext, ToolResultPart, ToolUsePart } from '../ir/index.js';
import type {
  CanonicalError,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalStreamEvent,
  PluginResult,
} from '../ir/index.js';
import type { PluginHost } from './host.js';
import type { RedactionConfig } from '../storage/redaction.js';
import { redactText, redactUnknown } from '../storage/redaction.js';
import type { ToolCallRecorder } from './tool-recorder.js';
import { takeStashedSecrets } from './tool-recorder.js';

/** 取当前脱敏配置的钩子（设置热改时立刻换一份）。 */
export type RedactionConfigProvider = () => RedactionConfig;

/** 脱敏一个 tool_result：只动承载文本的 `content` 与 `search_results`。 */
export function redactToolResult(result: ToolResultPart, config: RedactionConfig): ToolResultPart {
  const content =
    typeof result.content === 'string'
      ? redactText(result.content, config).text
      : (redactUnknown(result.content, config) as ToolResultPart['content']);
  return {
    ...result,
    content,
    ...(result.search_results === undefined
      ? {}
      : { search_results: redactUnknown(result.search_results, config) }),
  };
}

/**
 * 插件主机装饰器：`runOnToolCall` 的返回值过一遍脱敏，其余成员原样委派。
 *
 * 委派而不是继承：`DefaultPluginHost` 的注册表 / 排序 / 故障隔离都在里面，
 * 包装类只加一件事，因此永远不可能绕过那些逻辑。
 *
 * 同一个拦截点还顺带记一份工具调用（`recorder`）——工具结果不出现在上游响应里，
 * 界面要的「结果摘要」只能从这里取（见 plugins/tool-recorder.ts）。
 */
export class RedactingPluginHost implements PluginHost {
  constructor(
    private readonly inner: PluginHost,
    private readonly configProvider: RedactionConfigProvider,
    private readonly recorder?: ToolCallRecorder,
  ) {}

  register(plugin: Plugin, config?: unknown): void {
    this.inner.register(plugin, config);
  }

  unregister(name: string): void {
    this.inner.unregister(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    this.inner.setEnabled(name, enabled);
  }

  isEnabled(name: string): boolean {
    return this.inner.isEnabled(name);
  }

  requestSide(): Plugin[] {
    return this.inner.requestSide();
  }

  responseSide(): Plugin[] {
    return this.inner.responseSide();
  }

  streamSide(): Plugin[] {
    return this.inner.streamSide();
  }

  errorSide(): Plugin[] {
    return this.inner.errorSide();
  }

  toolSide(): Plugin[] {
    return this.inner.toolSide();
  }

  hasFullCanonicalRequestSide(): boolean {
    return this.inner.hasFullCanonicalRequestSide();
  }

  hasFullCanonicalResponseSide(): boolean {
    return this.inner.hasFullCanonicalResponseSide();
  }

  onChange(listener: () => void): void {
    this.inner.onChange(listener);
  }

  setDefaultTimeoutMs(ms: number): void {
    // 可选方法：不注入设置服务的装配（测试、demo）没有这个入口，
    // 行为与「没有这一层」完全一致（见 plugins/host.ts 的同名声明）。
    this.inner.setDefaultTimeoutMs?.(ms);
  }

  setMountTargets(name: string, targets: readonly import('../ir/index.js').PluginMountTarget[]): void {
    this.inner.setMountTargets?.(name, targets);
  }

  listPluginSnapshots(): import('./host.js').PluginSnapshot[] {
    return this.inner.listPluginSnapshots?.() ?? [];
  }

  getConfig(name: string): Record<string, unknown> {
    return this.inner.getConfig?.(name) ?? {};
  }

  async setConfig(name: string, config: Record<string, unknown>): Promise<void> {
    await this.inner.setConfig?.(name, config);
  }

  listLogs(filter?: {
    plugin?: string;
    status?: 'ok' | 'error';
    limit?: number;
  }): import('./host.js').PluginLogEntry[] {
    return this.inner.listLogs?.(filter) ?? [];
  }

  clearLogs(plugin?: string): void {
    this.inner.clearLogs?.(plugin);
  }

  async runOnRequest(
    req: CanonicalRequestEnvelope,
    ctx: RequestContext,
  ): Promise<PluginResult<CanonicalRequestEnvelope>> {
    return this.inner.runOnRequest(req, ctx);
  }

  async runOnResponse(
    res: CanonicalResponseEnvelope,
    ctx: RequestContext,
  ): Promise<PluginResult<CanonicalResponseEnvelope>> {
    return this.inner.runOnResponse(res, ctx);
  }

  async runOnStreamChunk(
    ev: CanonicalStreamEvent,
    ctx: RequestContext,
  ): Promise<CanonicalStreamEvent | CanonicalStreamEvent[] | null> {
    return this.inner.runOnStreamChunk(ev, ctx);
  }

  async runOnToolCall(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart> {
    const result = await this.inner.runOnToolCall(call, ctx);
    const config = this.configProvider();
    const redacted = config.redactToolResults ? redactToolResult(result, config) : result;
    // 记脱敏之后的那一份：界面上看到的与模型看到的是同一文本。
    // 待披露的明文（若有）由插件暂存在 ctx.state，这里一并搬进记录——
    // 它只存在于服务端记录里，永不进 tool_result。
    const secrets = takeStashedSecrets(ctx);
    this.recorder?.record(
      ctx.request_id,
      call,
      redacted,
      secrets.length === 1 ? secrets[0] : undefined,
    );
    return redacted;
  }

  async notifyError(err: CanonicalError, ctx: RequestContext): Promise<void> {
    await this.inner.notifyError(err, ctx);
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}
