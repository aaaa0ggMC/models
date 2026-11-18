/**
 * ir/context.ts —— RequestContext：贯穿全链路、只增不改的上下文对象。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §2.1；插件可见的扩展方法见
 * docs/design/30-plugin-api.md §2.1。
 *
 * `state` 是工具调用循环与插件跨阶段协作的唯一通道（20 §2.1）。
 */

import type { FormatId } from './format.js';
import type { CanonicalError } from './error.js';
import type { StageMetric } from './trace.js';
import type { CanonicalUsage } from './usage.js';

/** 路由节点或脚本可选的 canonical 参数覆盖。 */
export interface RouteParamOverrides {
  thinking_enabled?: boolean;
  thinking_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinking_budget_tokens?: number;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  system_prompt_append?: string;
}

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
  /** 目标模态（当对话端点桥接到生图等专用模态时设为 `'image'`）。 */
  target_modality?: import('./modality.js').ModalityKind;
  /** 命中的路由图标识（若走路由图引擎）。 */
  route_graph_id?: string;
  /** 路由图节点求值轨迹摘要（观测与模拟器用）。 */
  route_trace?: string[];
}

export interface Attempt {
  provider: string;
  access_path: string;
  provider_format: FormatId;
  model: string;
  weight?: number;
  fast_path_eligible: boolean;
  target_modality?: import('./modality.js').ModalityKind;
  /** 路由节点附带的 canonical 请求参数覆盖。 */
  overrides?: RouteParamOverrides;
  /** 产生该 attempt 的路由图节点 id。 */
  route_node_id?: string;
}

/** 数据面鉴权上下文（virtual key / team / user 标识，**不含明文 key**）。 */
export interface AuthContext {
  /** virtual key 的 id（不是 key 本身）。 */
  key_id: string;
  team_id?: string;
  user_id?: string;
  /** 该 key 允许的模型别名/access path 白名单。 */
  allowed_models?: string[];
  /**
   * 该 key 允许的 provider 白名单（66 §2.1）。
   *
   * 为什么在 S0 填、在 S2 判：provider 只有路由之后才知道（S2 才解析出
   * access path → provider）。放在 ctx 里而不是 stage 私有变量，是为了让
   * 插件与 dog-fooding 工具也能看到「这把 key 被限定了哪些 provider」。
   */
  allowed_providers?: string[];
  /** 是否允许开 Tier-2 消息持久化（66 §2.1；默认 false）。 */
  allow_message_persistence?: boolean;
  /** 是否允许流式响应（默认 true）。 */
  allow_streaming?: boolean;
  /** 该 key 允许的插件白名单（空/未填 = 全部已挂载到 API 的插件）。 */
  allowed_plugins?: string[];
  /** 该 key 明确禁用的插件黑名单。 */
  disabled_plugins?: string[];
  /** 该 key 允许的模态白名单（空/未填 = 全部）。 */
  allowed_modalities?: import('./modality.js').ModalityKind[];
  /** 该 key 的插件配置覆盖来源标记。 */
  scopes?: string[];
}

/** 阶段间共享的暂存区里约定俗成的键（集中在这里，避免魔法字符串散落）。 */
export const CTX_STATE_KEYS = {
  /** 网关工具循环的 tool id 映射表（canonical id ↔ provider 侧 id）。 */
  TOOL_ID_MAP: 'tool_id_map',
  /** 插件改写过的 canonical 路径（用于 raw 回写的"未被改动"判定，10 §7.2）。 */
  REWRITTEN_PATHS: 'rewritten_paths',
  /** 关闭 fast path 的原因（20 §4.1）。 */
  FAST_PATH_DISABLED_REASON: 'fast_path_disabled_reason',
  /** 压缩插件的记账结果（30 §4.2）。 */
  COMPACTION: 'compaction',
  /** 网关工具循环的轮次 canonical 摘要。 */
  TRACE: 'trace',
  /**
   * Agent 管理插件暂存的待披露明文。
   *
   * 只为「把新建虚拟 key 的明文送到浏览器」而存在（95 §3.3）：它经
   * `plugins/tool-recorder.ts` 搬进服务端记录，**从不进 canonical、不进
   * tool_result**，因此模型看不到。每个请求一个 ctx，天然按请求隔离。
   */
  AGENT_PENDING_SECRET: 'agent_pending_secret',
  /** 惰性解码的请求信封（D-fastpath-1）：S1 只填信封级字段。 */
  LAZY_ENVELOPE: 'lazy_envelope',
  /** 客户端原始请求体字节引用（fast path 透传用）。 */
  RAW_BODY: 'raw_body',
  /**
   * 本次实际使用的上游凭据 id（S5 填，S10 读；多 key 换钥时是**最终成功的那一把**）。
   *
   * 只有 id，绝不放 key 本体（60 §3 的硬约束）。同一 access path 下配了多把 key 时，
   * 它是"这笔用量烧在哪把 key 上"的唯一依据——按 key 对账、按 key 排障都靠它。
   * 路径不需要凭据（mock / local）时为 undefined。
   */
  ATTEMPT_CREDENTIAL_ID: 'attempt_credential_id',
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
  /** 客户端断联中止信号（按策略在立即或宽限期后触发）。 */
  abort_signal?: AbortSignal;

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
