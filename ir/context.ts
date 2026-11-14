/**
 * ir/context.ts —— RequestContext：贯穿全链路、只增不改的上下文对象。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §2.1；插件可见的扩展方法见
 * docs/design/30-plugin-api.md §2.1。
 *
 * `state` 是工具调用循环与插件跨阶段协作的唯一通道（20 §2.1）。
 */

import type { FormatId } from "./format.js";
import type { CanonicalError } from "./error.js";
import type { StageMetric } from "./trace.js";
import type { CanonicalUsage } from "./usage.js";

/** S2 路由后的解析结果。 */
export interface ResolvedRoute {
  /** 选中的 access path（45 §3）。 */
  access_path: string;
  /** provider 标识（与 access path 可能同名，Bedrock/Vertex 等场景不同）。 */
  provider: string;
  /** 上游 wire 格式。 */
  provider_format: FormatId;
  /** provider 侧真实 model id。 */
  model: string;
  /** 本次请求的完整模型 id = `<access_path>/<model_namespace>/<model>`。 */
  full_model_id: string;
  /** 有序 attempt 计划（20 §S2 第 3 步）。 */
  attempt_plan: Attempt[];
  /** 该 attempt 是否满足 fast path 判定（同格式 + 声明兼容）。 */
  fast_path_eligible: boolean;
  /** 模型元数据（上下文窗口等，压缩插件要用）。 */
  model_meta?: { max_context_tokens?: number; [k: string]: unknown };
  /** 粘性会话键（30 §4.3 / 20 §S2 第 8 步）。 */
  session_key?: string;
}

export interface Attempt {
  provider: string;
  access_path: string;
  provider_format: FormatId;
  model: string;
  weight?: number;
  fast_path_eligible: boolean;
}

/** 数据面鉴权上下文（virtual key / team / user 标识，**不含明文 key**）。 */
export interface AuthContext {
  /** virtual key 的 id（不是 key 本身）。 */
  key_id: string;
  team_id?: string;
  user_id?: string;
  /** 该 key 允许的模型别名/access path 白名单。 */
  allowed_models?: string[];
  /** 该 key 的插件配置覆盖来源标记。 */
  scopes?: string[];
}

/** 阶段间共享的暂存区里约定俗成的键（集中在这里，避免魔法字符串散落）。 */
export const CTX_STATE_KEYS = {
  /** 网关工具循环的 tool id 映射表（canonical id ↔ provider 侧 id）。 */
  TOOL_ID_MAP: "tool_id_map",
  /** 插件改写过的 canonical 路径（用于 raw 回写的"未被改动"判定，10 §7.2）。 */
  REWRITTEN_PATHS: "rewritten_paths",
  /** 关闭 fast path 的原因（20 §4.1）。 */
  FAST_PATH_DISABLED_REASON: "fast_path_disabled_reason",
  /** 压缩插件的记账结果（30 §4.2）。 */
  COMPACTION: "compaction",
  /** 网关工具循环的轮次 canonical 摘要。 */
  TRACE: "trace",
  /** 惰性解码的请求信封（D-fastpath-1）：S1 只填信封级字段。 */
  LAZY_ENVELOPE: "lazy_envelope",
  /** 客户端原始请求体字节引用（fast path 透传用）。 */
  RAW_BODY: "raw_body",
} as const;

export interface RequestContext {
  /** "req_" + ulid。 */
  request_id: string;
  /** 若上游带 W3C traceparent。 */
  trace_id?: string;
  /** epoch ms。 */
  started_at: number;
  /** S0 计算的绝对超时时刻（剩余预算贯穿 S5/S8）。 */
  deadline: number;

  client_format: FormatId;
  /** 已脱敏。 */
  client_raw_headers: Record<string, string>;

  auth: AuthContext;
  /** S2 后填充。 */
  route: ResolvedRoute;
  provider_format: FormatId;
  /** 见 20-pipeline.md §4。 */
  fast_path: boolean;

  /** 阶段间共享的暂存区。 */
  state: Record<string, unknown>;
  metrics: StageMetric[];

  /** 客户端请求体字节长度（S0 记录，用于限额与观测）。 */
  request_bytes?: number;

  /** 关闭 fast path，之后本请求走完整结构转换（30 §2.1）。 */
  disableFastPath(reason: string): void;
  /** 记录一条 warning，最终进入 UsageRecord.warnings。 */
  warn(code: string, detail?: string): void;
}

/** 收集到的 warning（Runner 内部用，最终进响应信封与 UsageRecord）。 */
export interface WarningSink {
  warnings: string[];
}

/** 插件/阶段可调用的最小上下文视图（只读 + 受控副作用）。 */
export interface ContextView {
  readonly request_id: string;
  readonly client_format: FormatId;
  readonly provider_format: FormatId;
  readonly fast_path: boolean;
  readonly state: Record<string, unknown>;
  currentUsage(): CanonicalUsage;
  warn(code: string, detail?: string): void;
}

/** 把 CanonicalError 收敛成一个"阶段失败"结果，供 Runner 统一处理。 */
export interface StageFailure {
  error: CanonicalError;
  /** 是否已经向客户端写过字节（写过就不能再改状态码，20 §S8）。 */
  bytes_written: boolean;
}
