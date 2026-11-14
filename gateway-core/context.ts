/**
 * gateway-core/context.ts —— RequestContext 的可变实现。
 *
 * 类型定义在 ir/context.ts（插件也要看到它，放 ir/ 避免 ir → gateway-core 的反向依赖）；
 * 这里只放"怎么改它"的实现。`state` 是工具调用循环与插件跨阶段协作的唯一通道（20 §2.1）。
 */

import type {
  AuthContext,
  RequestContext,
  ResolvedRoute,
  StageMetric,
} from "../ir/index.js";
import { CTX_STATE_KEYS } from "../ir/index.js";

export class MutableRequestContext implements RequestContext {
  request_id: string;
  trace_id?: string;
  started_at: number;
  deadline: number;
  client_format: RequestContext["client_format"];
  client_raw_headers: Record<string, string>;
  auth: AuthContext;
  route!: ResolvedRoute;
  provider_format: RequestContext["provider_format"];
  fast_path: boolean;
  state: Record<string, unknown> = {};
  metrics: StageMetric[] = [];
  request_bytes?: number;

  /** 累积的 warning（最终进响应信封 warnings 与 UsageRecord.warnings）。 */
  readonly warnings: string[] = [];
  /** 累积的 dropped_capabilities。 */
  readonly droppedCapabilities: string[] = [];

  private readonly onDisableFastPath: (reason: string) => void;

  constructor(init: {
    request_id: string;
    started_at: number;
    deadline: number;
    client_format: RequestContext["client_format"];
    client_raw_headers: Record<string, string>;
    auth: AuthContext;
    trace_id?: string;
    onDisableFastPath?: (reason: string) => void;
  }) {
    this.request_id = init.request_id;
    this.started_at = init.started_at;
    this.deadline = init.deadline;
    this.client_format = init.client_format;
    this.client_raw_headers = init.client_raw_headers;
    this.auth = init.auth;
    this.provider_format = init.client_format;
    this.fast_path = false;
    this.onDisableFastPath = init.onDisableFastPath ?? (() => {});
    if (init.trace_id !== undefined) this.trace_id = init.trace_id;
  }

  /** 30 §2.1：关闭 fast path，之后本请求走完整结构转换。 */
  disableFastPath(reason: string): void {
    if (!this.fast_path) return;
    this.fast_path = false;
    this.state[CTX_STATE_KEYS.FAST_PATH_DISABLED_REASON] = reason;
    this.onDisableFastPath(reason);
  }

  /** 30 §2.1：记录一条 warning。 */
  warn(code: string, detail?: string): void {
    this.warnings.push(detail === undefined ? code : `${code}: ${detail}`);
  }

  recordStage(name: string, durationMs: number, note?: string, bytes?: number): void {
    this.metrics.push({
      stage: name,
      duration_ms: durationMs,
      ...(bytes === undefined ? {} : { bytes }),
      ...(note === undefined ? {} : { note }),
    });
  }

  /** 剩余预算（ms）。S5/S8 据此决定还能等多久。 */
  remainingBudgetMs(now: number): number {
    return Math.max(0, this.deadline - now);
  }
}
