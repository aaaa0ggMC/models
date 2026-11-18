/**
 * adaptors/openai-responses/codec.ts —— OpenAI Responses ↔ AG-IR canonical 双向 codec。
 *
 * 唯一事实来源：
 *   - docs/design/42-openai-responses-access.md §4（canonical 映射：§4.1 结构差异总表 /
 *     §4.2 已有概念直接承载 / §4.3 唯一新增 / §4.4 明确暂不支持并报错 / §4.5 流式折叠 /
 *     §4.6 usage 与 finish_reason / §4.7 有状态参数）
 *   - docs/design/10-canonical-schema.md §4（chat payload）、§6.1（usage 规则）、
 *     §7（raw passthrough 两级）、§9.1/§9.2（字段映射表）、§9.3（finish_reason 归一表）
 *   - docs/design/40-provider-adaptors.md §1.1（Adaptor 接口）、§1.5（round-trip 测试模板）、
 *     §2.1（OpenAI Responses usage 口径列）、§2.3（流式 usage 位置）、§7.4（Responses 注意事项）
 *   - docs/design/25-streaming.md §2（帧信封）、§2.2（`ag.frame` 事件名统一）
 *
 * **方向约定**（本文件每个函数的注释都注明）：
 *   - decode*       ：wire → canonical，即「客户端格式 → canonical」
 *   - encode*       ：canonical → wire，即「canonical → 客户端格式」
 *
 * 与 `openai-chat` / `anthropic-messages` 的关系：三者是同一个 chat 模态的**三张入站脸**，
 * 共用同一份 canonical（ir/chat.ts），互不 import。Responses 与 Chat 的结构差异逐条落在
 * 42 §4.1 的总表里，本文件按那张表实现。
 *
 * 三条从设计文档继承的硬约束（逐条落地，注释里点名出处）：
 *   1. **多 system 不丢**：`instructions` 与 system/developer 角色的 message item 共存时
 *      两条都进 `payload.system[]`（42 §4.2 + §7.1 测试 5）。
 *   2. **畸形 tool 参数不毁**：`function_call.arguments` 是 JSON **字符串**，解析失败时
 *      `input` 置 `{}`、`raw_arguments` 留原串，回写优先用原串（10 §7.3）。
 *   3. **未命中不得默认 stop**：`status` 未命中归一表 → `other` + warning
 *      （10 §9.3 注意 2）。
 *
 * 两条本 codec 特有的边界（42 §4.4「不静默」）：
 *   - `previous_response_id` / `conversation` / `background` / `include` → **显式拒**
 *     （`capability_unsupported`）：网关不存上游 response 对象，静默忽略会让请求变成
 *     「没有历史的孤轮」，答案是错的且不可察觉。
 *   - `store: true` → 收下并记诊断，**不执行存储**（40 §7.1 同款立场）。
 *
 * 依赖注入：`Clock` 由构造函数注入（ir/clock.ts 硬约束——禁止模块内 `Date.now()`）。
 * 无模块级单例、无 `process.env` 读取。
 */

import type {
  BuiltinTool,
  CanonicalMessage,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalTool,
  CanonicalUsage,
  ChatParams,
  ChatPayload,
  ChatResponsePayload,
  Clock,
  ConversionDiagnostic,
  DocumentPart,
  FormatId,
  ImagePart,
  InlineMedia,
  JSONSchema,
  Logger,
  MediaRef,
  ModalityKind,
  NormalizedFinishReason,
  Part,
  RequestContext,
  ResponseFormat,
  SearchResultPart,
  StreamFrame,
  StreamPart,
  SystemBlock,
  TextPart,
  ThinkingConfig,
  ThinkingPart,
  ToolChoice,
  ToolResultPart,
  ToolUsePart,
  UriMedia,
} from '../../ir/index.js';
import { CTX_STATE_KEYS, IR_VERSION, createCanonicalError } from '../../ir/index.js';
import type { Adaptor, AdaptorMeta, EncodedRequest, RequestEnvelopeShallow } from '../types.js';
import type { ProviderProfile, ProviderProfileRegistry } from '../../di/ports.js';

/** 本 codec 的格式 id、模态与默认端点（20 §S0 路径签名表）。 */
const FORMAT: FormatId = 'openai.responses';
const MODALITY: ModalityKind = 'chat';
const DEFAULT_PATH = '/v1/responses';

/**
 * 请求侧「已建模」的顶层键集合。两个作用：
 *   1. decode 时把不在集合里的顶层键收进 `raw.unmapped`（20 §S1「不允许丢字段」）；
 *   2. decodeEnvelope 时廉价地收集同一批键（D-fastpath-1 的 `unmapped` 字段）。
 *
 * 42 §4.3 的分界：**canonical 已有概念直接承载的不进 unmapped**（§4.2 那张表），
 * Responses 专有而 canonical 没有的才进 unmapped——后者由「不在这里列出」自动实现
 * （`truncation` / `stream_options` / `max_tool_calls` / `safety_identifier` /
 * `prompt_cache_key` / `prompt_cache_retention` / `context_management` 全部走 unmapped，
 * 回写由 10 §7.2 第 3 条保证）。
 */
const MODELLED_REQUEST_KEYS: readonly string[] = [
  // 入口与指令
  'model',
  'input',
  'instructions',
  // 工具
  'tools',
  'tool_choice',
  // 采样参数（canonical ChatParams 直接承载，42 §4.2 末三行）
  'max_output_tokens',
  'temperature',
  'top_p',
  'top_logprobs',
  'user',
  'metadata',
  'service_tier',
  'parallel_tool_calls',
  // 推理与结构化输出（42 §4.2：reasoning.effort / text.format）
  'reasoning',
  'text',
  // 流式
  'stream',
  // 有状态参数：**收下以便显式拒绝 / 记诊断**（42 §4.4 / §4.9），不进 canonical 也不静默
  'previous_response_id',
  'conversation',
  'background',
  // DeepSeek 扩展参数（`safety_check` / `title`）**故意不列在这里**：42 §4.3 把它们归到
  // 「走 native.openai.responses.* 与 raw.unmapped」，于是自动落进 unmapped 并由
  // 10 §7.2 第 3 条原样回写——同一 FormatId 的 provider 脸（B 期）要解释它们时进
  // ProviderProfile，codec 保持方言无关。
];

/**
 * 响应侧「已建模」的顶层键集合。
 *
 * 只列真正映射进 canonical 的键；其余（`instructions` / `tools` / `tool_choice` /
 * `metadata` / `parallel_tool_calls` / `temperature` / `top_p` / `incomplete_details` /
 * `store` …）**不进**这个集合，于是自动落进 `raw.unmapped` 并由 10 §7.2 第 3 条原样回写
 * ——响应体是上游形态的回声，canonical 不为它单开字段。
 */
const MODELLED_RESPONSE_KEYS: readonly string[] = [
  'id',
  'object',
  'status',
  'model',
  'output',
  'usage',
  'error',
];

/** `message` item 里被 canonical 建模了的键（其余进 `_raw` 逐节点还原）。 */
const MESSAGE_ITEM_MODELLED_KEYS: readonly string[] = ['type', 'role', 'content'];

/**
 * `status` / `incomplete_details.reason` → canonical finish_reason（10 §9.3 的 Responses 列）。
 *
 * 未命中 → `other` + warning，**绝不默认 stop**（10 §9.3 注意 2）。
 */
const FINISH_REASON_TO_CANONICAL: Record<string, NormalizedFinishReason> = {
  completed: 'stop',
  failed: 'error',
  // incomplete_details.reason 的两个已知取值
  max_output_tokens: 'length',
  content_filter: 'content_filter',
};

/** 反向表：canonical finish_reason → Responses 的 `status`（10 §9.3 逆映射）。 */
const CANONICAL_TO_STATUS: Partial<Record<NormalizedFinishReason, string>> = {
  stop: 'completed',
  length: 'incomplete',
  content_filter: 'incomplete',
  error: 'failed',
  tool_use: 'completed',
  stop_sequence: 'completed',
  pause_turn: 'incomplete',
  context_exceeded: 'incomplete',
};

/** canonical finish_reason → `incomplete_details.reason`（只在 status === "incomplete" 时用）。 */
const CANONICAL_TO_INCOMPLETE_REASON: Partial<Record<NormalizedFinishReason, string>> = {
  length: 'max_output_tokens',
  content_filter: 'content_filter',
};

/** Responses 响应体的合法 `status` 取值（`encodeStatus` 的原文校验用）。 */
const RESPONSES_STATUS_VALUES: ReadonlySet<string> = new Set([
  'completed',
  'incomplete',
  'failed',
  'in_progress',
]);

/**
 * 本 codec 认得的来源标识（decode* 时写进 `raw.source_provider`）。
 *
 * **为什么用 FormatId 而不是 "openai"**：`openai.chat` 与 `openai.responses` 是同一家
 * provider 的两张脸，若两边都写 "openai"，`source_provider` 就**分不出**是谁——反向
 * passthrough 的同格式判据（10 §7.2 回写规则第 1 条）会失效，Responses 客户端脸的
 * `raw.unmapped` 会被静默抄进 Chat 上游请求体。仓库里已有同款先例：
 * `providers/decision/mock.ts` 写的是 `mock.decisions`。
 *
 * `finish_reason_provider` 的**原样回写同样只在同格式时成立**，判据就是这个标识。
 */
const PROVIDER_NAME = 'openai.responses';

/** 流式 end 帧的 `output` 里保存 finish_reason 原文的键（10 §9.3 注意 3）。 */
const RAW_FINISH_REASON_KEY = 'finish_reason_provider';

/**
 * canonical 错误码 → Responses 错误体的 `type`（20 §7.2）。
 * 只列会真实出现的；未列的一律落 `server_error`（保守：客户端会重试）。
 */
const RESPONSES_ERROR_TYPE_BY_CODE: Record<string, string> = {
  rate_limited: 'rate_limit_error',
  quota_exceeded: 'insufficient_quota',
  auth_failed: 'invalid_request_error',
  unsupported_format: 'invalid_request_error',
  canonical_decode_error: 'invalid_request_error',
  canonical_encode_error: 'invalid_request_error',
  capability_unsupported: 'invalid_request_error',
  context_length_exceeded: 'invalid_request_error',
  provider_unavailable: 'server_error',
  upstream_timeout: 'server_error',
  upstream_error: 'server_error',
  no_available_provider: 'server_error',
  internal_error: 'server_error',
  plugin_error: 'server_error',
  agentic_loop_exceeded: 'server_error',
  content_filtered: 'server_error',
};

/**
 * 流式 part.begin / part.end 在 `StreamFrame` 上的载体键。
 *
 * **为什么用 meta 帧**：25 §2.1 的 `FrameData` 联合里没有 part.begin/part.end 的负载形状，
 * 而 20 §S6 的折叠表要求「part.begin + N × part.delta + part.end」。`MetaData.notes`
 * 是唯一能带结构化负载又不污染内容增量流的位置，且 part 边界确实是「非内容性元信息」。
 *
 * **形状与另两个 chat adaptor 对齐**（`{phase, index, part}`，见 openai-chat /
 * anthropic-messages 的同名常量）——三个 chat adaptor 产出同一种 meta 帧形状，
 * 插件/管道只需写一份解析。
 */
const PART_FRAME_NOTE_KEY = 'openai.responses.part';

/**
 * 「原样搭车」的 meta 帧载体键。
 *
 * 42 §4.5 的折叠表里有一批 wire 事件在 canonical 里**没有对应帧**（`response.in_progress` /
 * `response.content_part.added` / `response.web_search_call.*` / 未知事件类型）。它们不许
 * 静默丢掉（42 §4.4 末行：「DeepSeek 上游静默忽略，我们不能」），也不该新造帧类型
 * （42 §4.5 结论 1：不新增帧类型、不新增 SSE 事件名），因此按 Anthropic adaptor 的
 * `PASSTHROUGH_FRAME_NOTE_KEY` 同款做法搭 meta 帧，回写时按原事件名还原。
 */
const PASSTHROUGH_FRAME_NOTE_KEY = 'openai.responses.passthrough';

/**
 * 回写时**跳过**的搭车事件名。
 *
 * 这些事件在 `encodeStream` 里已经由 part.begin / part.end 合成出来了；若再把 decode 侧
 * 搭车带来的那份原样写一遍，同一个事件名会出现两次，40 §1.5 第 6 条的「流式事件序列等价」
 * 断言会红。跳过是有损的吗？不是——信息已经在合成的那个里（同一 item、同一序号）。
 */
const SELF_SYNTHESIZED_EVENTS: ReadonlySet<string> = new Set([
  'response.output_item.added',
  'response.content_part.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
]);

/** codec 构造依赖（横切能力全部注入，不用隐式全局）。 */
export interface OpenAIResponsesCodecDeps {
  clock: Clock;
  logger?: Logger;
  /**
   * provider profile 注册表（可选）。
   *
   * 注入后本 codec 在**按 access path 查到 profile** 时启用 provider 专有映射
   * （端点路径 / builtin tool 的厂商专有形态），见 di/ports.ts 的 ProviderProfile。
   * 查不到 profile 时行为与本文件默认一致——一个 codec 实例服务所有同 dialect 的
   * access path，provider 差异必须可插拔（42 §1.3 第 0 条：B 不是第二个 codec，
   * 而是同一个 codec 的第二个 profile 条目）。
   */
  providerProfiles?: ProviderProfileRegistry;
}

/**
 * 流式回写的跨帧累加器（挂在 `ctx.state` 上）。
 *
 * 为什么需要它：S8 是**按事件**调用 `encodeStream` 的（每个 CanonicalStreamEvent 单独
 * 一次），局部变量会在每次调用时重置。`sequence_number` 的单调性、`response.completed`
 * 的完整 `output[]`、惰性开户的 item_id 映射都必须跨调用存活，于是显式用一个 ctx 级
 * 累加器——与 openai-chat 把 `raw_body` 放进 `ctx.state` 同一机制。
 */
interface ResponsesStreamState {
  /** Responses 的 `sequence_number`：单调递增，从 0 开始（42 §2.1）。 */
  next: () => number;
  seq: number;
  /** 响应 id（start 帧的 session_id 优先）。 */
  responseId: string;
  createdAt: number;
  model: string;
  /** `response.created` 是否已发（幂等）。 */
  created: boolean;
  /** 已开流（发过 output_item.added）但未收尾的帧 index。 */
  open: Set<number>;
  /** 帧 index → 当前分配的 Responses output_index（单调递增，避免同 index 复用冲突）。 */
  outputIndices: Map<number, number>;
  /** 下一个可分配的 Responses output_index。 */
  nextOutputIndex: number;
  /** 帧 index → item_id。 */
  itemIds: Map<number, string>;
  /** output_index → 累积的文本/思考（惰性开户的那一类）。 */
  textBuf: Map<number, string>;
  /** 已收尾的 item（`response.completed` 的 `output[]` 用）。 */
  items: unknown[];
  /** 终事件是否已发（幂等：之后的帧一律忽略）。 */
  terminal: boolean;
  /** 最后一次 usage（恒搭终事件）。 */
  usage?: CanonicalUsage;
}

/** 流式累加器在 `ctx.state` 里的键（codec 私有命名空间，不占 CTX_STATE_KEYS）。 */
const STREAM_STATE_KEY = 'openai.responses.stream';

/** 流式折叠时正在累积的 part。 */
interface OpenPart {
  kind: 'text' | 'thinking' | 'tool_use' | 'unknown';
  /** wire 的 `item_id`（Responses 的 item 标识）。 */
  itemId?: string;
  /**
   * tool_use 的 `call_id`（`fc_…` ↔ `call_…` 的另一半）。
   *
   * 只在 `response.output_item.added` / `.done` 的 item 里出现；参数增量事件
   * （`response.function_call_arguments.delta` / `.done`）只带 `item_id`。canonical 的
   * `ToolUsePart.id` 要 `call_id`（回传 `function_call_output.call_id` 引用的就是它），
   * 所以必须在这里把它留下来（42 §4.2 的 id ↔ call_id 映射）。
   */
  callId?: string;
  /** tool_use 的 name。 */
  name?: string;
  /** text / thinking 的累积文本。 */
  text: string;
  /** tool_use 的累积参数串。 */
  args: string;
  /** 该 item 的原文（整 item）。 */
  raw: Record<string, unknown>;
}

/** 流式折叠的共享状态（foldEvent 与 decodeStream 之间传递）。 */
interface StreamFoldState {
  indexByItemId: Map<string, number>;
  openParts: Map<number, OpenPart>;
  warnings: string[];
  /** 是否已经见过终事件（`response.completed` / `.incomplete` / `.failed`）。 */
  terminalSeen: boolean;
  onUsage: (u: CanonicalUsage) => void;
}

export class OpenAIResponsesCodec implements Adaptor {
  readonly format: FormatId = FORMAT;
  readonly modalities: ModalityKind[] = [MODALITY];

  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly providerProfiles: ProviderProfileRegistry | undefined;
  /** 实例内单调的帧序号（25 §2：从 0 开始；不放模块级，避免跨实例共享状态）。 */
  private seqCounter = 0;

  constructor(deps: OpenAIResponsesCodecDeps) {
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.providerProfiles = deps.providerProfiles;
  }

  /**
   * 按本次请求的 access path 取 provider profile（没有则 undefined）。
   *
   * 判据只用 `ctx.route.access_path`：路由（S2）之后 ctx.route 一定存在；
   * 直调 codec 的测试/工具没有 route 时返回 undefined，退回 dialect 默认行为。
   */
  private profileFor(ctx: RequestContext): ProviderProfile | undefined {
    const accessPath = ctx.route?.access_path;
    if (accessPath === undefined || this.providerProfiles === undefined) return undefined;
    return this.providerProfiles.forAccessPath(accessPath);
  }

  /** 上游端点路径：profile 覆盖优先，否则用 OpenAI 本家的默认路径。 */
  private endpointPathFor(ctx: RequestContext): string {
    const profile = this.profileFor(ctx);
    if (profile === undefined) return DEFAULT_PATH;
    return profile.endpointPath?.(ctx.route?.access_path ?? '') ?? DEFAULT_PATH;
  }

  // ===========================================================================
  // 请求：wire → canonical（客户端格式 → canonical）
  // ===========================================================================

  decode(raw: unknown, ctx: RequestContext): CanonicalRequestEnvelope {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error('OpenAI Responses 请求体不是 JSON object（20 §S1：不允许丢字段，也无法猜）');
    }

    // 42 §4.4 / §4.9：有状态参数在入口显式拒，不静默忽略。
    // 抛 CanonicalError（而不是普通 Error）是为了让 runner 的 toCanonicalError 原样保留
    // `capability_unsupported` 与 400——客户端要看见的是「这个能力不支持」，不是「解码失败」。
    this.rejectStatefulParams(obj, ctx);

    const warnings: string[] = [];
    const nodes: Record<string, unknown> = {};
    const system: SystemBlock[] = [];

    // `instructions` 是 Responses 的 system（42 §4.1）；原值进 _raw 供回写时还原成顶层字段
    // 而不是一条 message item（42 §4.2）。
    if (typeof obj['instructions'] === 'string') {
      system.push({ text: obj['instructions'] as string, _raw: obj['instructions'] as string });
    }

    const messages: CanonicalMessage[] = [];
    const input = obj['input'];
    if (typeof input === 'string') {
      // `input` 的字符串形态 = 一条纯文本 user 消息（42 §4.1 首行）。
      // `_raw` 记成**字符串**（而不是造一个 item 对象）：回写时靠它把 `input` 还原成
      // 字符串形态，否则同格式字节级保真会漂成 item 数组。
      messages.push({
        role: 'user',
        parts: [{ type: 'text', text: input }],
        _raw: input,
      });
    } else if (Array.isArray(input)) {
      for (const entry of input) {
        const item = asRecord(entry);
        if (item === undefined) {
          // item 不是 object：整条降级成 UnknownPart，**不抛**（20 §S1 前向兼容）
          messages.push({
            role: 'user',
            parts: [{ type: 'unknown', raw_type: 'item', raw: entry }],
            _raw: entry,
          });
          warnings.push('malformed_input_item');
          continue;
        }
        this.decodeItem(item, system, messages, warnings);
      }
    }

    const tools = this.decodeTools(obj, warnings, nodes, this.profileFor(ctx));
    const toolChoice = this.decodeToolChoice(obj, warnings, nodes);
    const params = this.decodeParams(obj, warnings, nodes);
    const stream = this.decodeStreamOptions(obj);
    const unmapped = collectUnmapped(obj, MODELLED_REQUEST_KEYS);

    // `store: true` 收下但不执行存储（42 §4.4）：unmapped 已经把它原样带过去了，
    // 这里只负责把「不收着」这件事说出来（40 §7.1 同款立场）。
    if (obj['store'] === true) ctx.warn('store_unsupported');
    if (obj['include'] !== undefined) ctx.warn('include_unsupported');

    const payload: ChatPayload = {
      messages,
      ...(system.length > 0 ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(params === undefined ? {} : { params }),
    };

    // 请求信封没有 warnings 字段（ir/envelope.ts），解码期的告警只能走 ctx.warn——
    // 20 §S4「不允许只打日志不上报」的同一立场：降级必须进 UsageRecord.warnings
    for (const warning of warnings) ctx.warn(warning);

    // 网关扩展字段：`ag_agentic_loop` 是客户端侧的网关开关（20 §5.1），映射进 canonical 的
    // `gateway` 命名空间。同时保留在 raw.unmapped 里——它仍是未建模的顶层键，回写要能
    // 原样写回（10 §7）。两者都不进 `MODELLED_REQUEST_KEYS`，回写仍走 unmapped 透传。
    const agenticLoop = obj['ag_agentic_loop'] === true;
    const maxTurnsRaw = obj['ag_max_turns'];
    const maxTurns =
      typeof maxTurnsRaw === 'number' && Number.isInteger(maxTurnsRaw) && maxTurnsRaw > 0
        ? maxTurnsRaw
        : undefined;

    return {
      ir_version: IR_VERSION,
      kind: MODALITY,
      model: typeof obj['model'] === 'string' ? (obj['model'] as string) : '',
      ...(stream === undefined ? {} : { stream }),
      payload,
      source_format: FORMAT,
      ...(agenticLoop || maxTurns !== undefined
        ? {
            gateway: {
              ...(agenticLoop ? { agentic_loop: true } : {}),
              ...(maxTurns === undefined ? {} : { max_turns: maxTurns }),
            },
          }
        : {}),
      raw: {
        source_provider: PROVIDER_NAME,
        ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
        ...(Object.keys(nodes).length > 0 ? { nodes } : {}),
      },
    };
  }

  /**
   * 42 §4.4 / §4.9 的**入口拒绝**：有状态与异步参数显式拒，不静默忽略。
   *
   * 为什么必须拒而不是 drop：网关不存上游 response 对象（40 §7.1），客户端带
   * `previous_response_id` 时若静默丢掉，请求会变成「没有历史的孤轮」——**答案是错的，
   * 且客户端以为历史在**。这正是 40 §1.7「默认按名拒绝」要防的事。
   */
  private rejectStatefulParams(obj: Record<string, unknown>, ctx: RequestContext): void {
    const reject = (key: string, why: string): void => {
      if (obj[key] === undefined) return;
      throw createCanonicalError(
        'capability_unsupported',
        `OpenAI Responses 的 ${key} 不受支持：${why}。` +
          '网关不保存上游 response 对象，请每次发送完整 input。',
        ctx.request_id,
        { field_path: key },
      );
    };
    reject('previous_response_id', '网关是无状态的，不保存上游 response 对象');
    reject('conversation', '网关是无状态的，不保存上游 conversation');
    reject('background', 'v1 只支持同步返回，没有异步任务模型');
  }

  /**
   * 单个 input item → canonical（42 §4.1 的 item 类型逐条）。
   *
   * `message` 的 system/developer 角色进 `payload.system[]`（与 `instructions` 并列，
   * 42 §7.1 测试 5「多 system 消息不丢」）；其余角色进 `messages`。
   */
  private decodeItem(
    item: Record<string, unknown>,
    system: SystemBlock[],
    messages: CanonicalMessage[],
    warnings: string[],
  ): void {
    const type = typeof item['type'] === 'string' ? (item['type'] as string) : 'message';

    if (type === 'message') {
      const role = typeof item['role'] === 'string' ? (item['role'] as string) : '';
      if (role === 'system' || role === 'developer') {
        // developer（o1+ 的新名字）折叠进 system（10 §4.1 注释）；原文进 _raw 供回写还原
        system.push({ text: contentToText(item['content']), _raw: item });
        return;
      }
      messages.push({
        role: role === 'assistant' || role === 'user' ? role : 'user',
        parts: this.decodeContentParts(item['content'], warnings),
        _raw: item,
      });
      if (role !== 'assistant' && role !== 'user') {
        warnings.push(`unknown_message_role:${role === '' ? '<empty>' : role}`);
      }
      return;
    }

    if (type === 'function_call') {
      // 42 §4.2：`id` 为权威 id，`call_id` 进 _raw，codec 维护 id ↔ call_id 映射。
      // **实现时的一处收窄**（已在交付报告里点名）：canonical 的 `ToolUsePart.id` 取
      // `call_id ?? id`——`function_call_output.call_id` 引用的就是它，而网关工具循环的
      // 判据是 `tool_result.tool_use_id === tool_use.id`（tool-loop.ts）。若按字面取 item
      // 的 `id`，多轮工具循环的配对会断。item 的 `id` 由 `_raw` 节点级还原完整保留。
      const callId = str(item['call_id']) ?? str(item['id']) ?? '';
      messages.push({
        role: 'assistant',
        parts: [
          {
            ...this.decodeToolArguments(
              callId,
              str(item['name']) ?? '',
              str(item['arguments']) ?? '',
            ),
            _raw: item,
          },
        ],
        _raw: item,
      });
      return;
    }

    if (type === 'function_call_output') {
      const output = item['output'];
      messages.push({
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            tool_use_id: str(item['call_id']) ?? '',
            content:
              typeof output === 'string' ? output : this.decodeContentParts(output, warnings),
          },
        ],
        // `_raw` 挂在**消息**上：回写时 `encodeToolMessage` 要从它取未建模的 item 键
        // （`status` 等），挂在 part 上读不到。
        _raw: item,
      });
      return;
    }

    if (type === 'reasoning') {
      // 42 §4.2：`reasoning` item 只支持纯文本 content → ThinkingPart。
      // summary / encrypted_content 在 DeepSeek 不支持（42 §2.1），整 item 进 _raw 保留。
      messages.push({
        role: 'assistant',
        parts: [{ type: 'thinking', thinking: reasoningTextOf(item['content']), _raw: item }],
      });
      return;
    }

    // custom_tool_call / custom_tool_call_output / web_search_call / item_reference /
    // 未知 item 类型：**无损收进** canonical（42 §4.4），不当 function tool——
    // `custom_tool_call.input` 是自由文本不是 JSON，猜成 function 会毁掉参数。
    warnings.push(`unknown_input_item_type:${type}`);
    this.logger?.warn('openai.responses: 未建模的 input item 类型，进 UnknownPart 保留', {
      item_type: type,
    });
    messages.push({
      role: 'assistant',
      parts: [{ type: 'unknown', raw_type: type, raw: item }],
      _raw: item,
    });
  }

  /**
   * 内容块（`input_text` / `output_text` / `input_image` / `input_file` / `refusal`）→ Part[]。
   *
   * 未知块类型 → `UnknownPart{type:"unknown", raw_type, raw}`，**绝不抛**（20 §S1）。
   */
  private decodeContentParts(content: unknown, warnings: string[]): Part[] {
    if (typeof content === 'string') {
      return content === '' ? [] : [{ type: 'text', text: content }];
    }
    if (!Array.isArray(content)) return [];

    const parts: Part[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b === undefined) {
        parts.push({ type: 'unknown', raw_type: 'block', raw: block });
        continue;
      }
      const type = typeof b['type'] === 'string' ? (b['type'] as string) : '';
      switch (type) {
        case 'input_text':
        case 'output_text': {
          parts.push({
            type: 'text',
            text: typeof b['text'] === 'string' ? (b['text'] as string) : '',
            _raw: b,
          });
          // 42 §4.4：`annotations` 的引用按 10 §9.2 落 SearchResultPart
          parts.push(...decodeAnnotations(b['annotations']));
          break;
        }
        case 'refusal': {
          parts.push({
            type: 'refusal',
            reason: typeof b['refusal'] === 'string' ? (b['refusal'] as string) : '',
            _raw: b,
          });
          break;
        }
        case 'input_image': {
          parts.push(this.decodeImage(b, warnings));
          break;
        }
        case 'input_file': {
          parts.push(this.decodeDocument(b, warnings));
          break;
        }
        default: {
          parts.push({ type: 'unknown', raw_type: type, raw: block });
          warnings.push(`unknown_content_part_type:${type === '' ? '<empty>' : type}`);
        }
      }
    }
    return parts;
  }

  /**
   * `input_image` → `ImagePart`（42 §4.2）。
   *
   * 两种寻址：`image_url`（URI 或 data: URL）走 `MediaRef` 的 uri / inline 态；
   * `file_id` 没有对应的 MediaRef 形态（ir/media.ts 的三态是 uri / inline / asset），
   * 因此按 42 §4.2 的原文「`file_id` 进 part 的 `_raw`」办——source 给一个空 uri 占位，
   * 回写时靠 `_raw` 节点级还原把 `file_id` 原样写回。
   */
  private decodeImage(b: Record<string, unknown>, warnings: string[]): Part {
    const url = str(b['image_url']);
    if (url !== undefined) {
      const source: MediaRef = url.startsWith('data:')
        ? inlineFromDataUrl(url, warnings)
        : ({ kind: 'uri', uri: url, mime: mimeFromUrl(url) } satisfies UriMedia);
      return { type: 'image', source, _raw: b };
    }
    if (str(b['file_id']) !== undefined) {
      const source: UriMedia = { kind: 'uri', uri: '', mime: 'application/octet-stream' };
      return { type: 'image', source, _raw: b };
    }
    // 两者都不给：不猜（42 §4.8.4 同款立场：上游会 400，我们不能静默造一个）
    warnings.push('input_image_without_source');
    return { type: 'unknown', raw_type: 'input_image', raw: b };
  }

  /** `input_file` → `DocumentPart`（42 §4.2：`media_type` / `title` + `_raw`）。 */
  private decodeDocument(b: Record<string, unknown>, warnings: string[]): Part {
    const fileData = str(b['file_data']);
    const fileUrl = str(b['file_url']);
    let source: MediaRef | undefined;
    if (fileData !== undefined && fileData.startsWith('data:')) {
      source = inlineFromDataUrl(fileData, warnings);
    } else if (fileUrl !== undefined) {
      source = { kind: 'uri', uri: fileUrl, mime: 'application/octet-stream' };
    } else if (str(b['file_id']) !== undefined) {
      // file_id 同上：没有 MediaRef 形态，靠 _raw 节点级还原
      source = { kind: 'uri', uri: '', mime: 'application/octet-stream' };
    }
    if (source === undefined) {
      warnings.push('input_file_without_source');
      return { type: 'unknown', raw_type: 'input_file', raw: b };
    }
    const mediaType = str(b['media_type']);
    const title = str(b['title']);
    const part: DocumentPart = {
      type: 'document',
      source,
      ...(mediaType === undefined ? {} : { media_type: mediaType }),
      ...(title === undefined ? {} : { title }),
      _raw: b,
    };
    return part;
  }

  /**
   * `function_call.arguments`（JSON **字符串**）→ `ToolUsePart`（10 §4.2 D7 + §7.3）。
   *
   * 解析成功进 `input`（对象）；解析失败 `input` 置 `{}`、`raw_arguments` 留**原串**——
   * llm-bridge 的真实缺陷是「存了 raw_arguments 但回写从不读它，畸形参数被静默替换成 {}」。
   */
  private decodeToolArguments(id: string, name: string, argsRaw: string): ToolUsePart {
    let input: Record<string, unknown> = {};
    let rawArguments: string | undefined;
    if (argsRaw !== '') {
      const parsed = tryParseJson(argsRaw);
      if (parsed.ok && asRecord(parsed.value) !== undefined) {
        input = asRecord(parsed.value) as Record<string, unknown>;
      } else {
        input = {};
        rawArguments = argsRaw;
        if (!parsed.ok) {
          this.logger?.warn(
            'openai.responses: function_call arguments 不是合法 JSON，原串进 raw_arguments',
            { tool_call_id: id },
          );
        }
      }
    }
    return {
      type: 'tool_use',
      id,
      name,
      input,
      ...(rawArguments === undefined ? {} : { raw_arguments: rawArguments }),
    };
  }

  /**
   * `tools[]` → `CanonicalTool[]`（42 §4.1：Responses 的工具字段**不嵌套**）。
   *
   * 四种形态：
   *   1. `{type:"function", name, description, parameters}` → `FunctionTool`；
   *   2. OpenAI 标准内置工具（`web_search` / `file_search` / `code_interpreter`）→
   *      `BuiltinTool`，canonical 用稳定名，厂商类型串进 `native.provider_tool_type`；
   *   3. DeepSeek 专有 server tool（`deepseek_web_search` 等，仅当 profile 认识时）→
   *      `BuiltinTool`（50 §3.1 模式 A）；
   *   4. 其它类型（`custom` / `mcp` / `computer_use` / `image_generation` / 未来类型）→
   *      `raw.nodes` 保留 + warning（**不猜也不丢**，40 §1.4 无第四类）。
   *
   * ⚠️ 与 42 §4.4 的一处偏差（已在交付报告点名）：该节写 `computer_use` / `mcp` 「收进
   * BuiltinTool」，但 `ir/chat.ts` 的 `BuiltinTool.name` 是**四个稳定名的闭集联合**
   * （web_search / url_context / code_interpreter / file_search），没有这两个值的槽位；
   * 硬塞会破坏 schema 的枚举校验。因此走第 4 类「原样保留 + warning」。
   */
  private decodeTools(
    obj: Record<string, unknown>,
    warnings: string[],
    nodes: Record<string, unknown>,
    profile: ProviderProfile | undefined,
  ): CanonicalTool[] {
    const raw = obj['tools'];
    if (!Array.isArray(raw)) return [];
    const tools: CanonicalTool[] = [];
    let toolIndex = 0;
    for (const entry of raw) {
      const t = asRecord(entry);
      if (t === undefined) continue;
      const type = typeof t['type'] === 'string' ? (t['type'] as string) : 'function';

      if (type === 'function') {
        const description = str(t['description']);
        tools.push({
          type: 'function',
          name: str(t['name']) ?? '',
          ...(description === undefined ? {} : { description }),
          parameters: (asRecord(t['parameters']) ?? {}) as JSONSchema,
          ...(typeof t['strict'] === 'boolean' ? { strict: t['strict'] as boolean } : {}),
          _raw: t,
        });
        toolIndex += 1;
        continue;
      }

      const builtin = this.decodeBuiltinTool(type, t, profile);
      if (builtin !== undefined) {
        tools.push(builtin);
        toolIndex += 1;
        continue;
      }

      warnings.push(`unknown_tool_type:${type}`);
      nodes[`tool:${toolIndex}`] = entry;
      toolIndex += 1;
      this.logger?.warn('openai.responses: 未建模的 tool 类型，进 raw.nodes 保留', {
        tool_type: type,
      });
    }
    return tools;
  }

  /**
   * 工具类型 → canonical `BuiltinTool`（认不出返回 undefined）。
   *
   * OpenAI 标准的三个内置工具名（`web_search` / `file_search` / `code_interpreter`）是
   * **方言级**语义，不需要 profile 背书；DeepSeek 专有类型（`deepseek_web_search` 等）
   * 只有当前 access path 的 profile 认识时才归一——同一个 codec 实例服务所有
   * openai.responses dialect 的 access path，不能把某一家 provider 的工具名当成
   * dialect 通用语义。
   */
  private decodeBuiltinTool(
    vendorType: string,
    rec: Record<string, unknown>,
    profile: ProviderProfile | undefined,
  ): BuiltinTool | undefined {
    const name = isBuiltinToolName(vendorType)
      ? vendorType
      : profile?.builtinToolCanonicalName?.(vendorType);
    if (name === undefined) return undefined;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'type') continue;
      config[k] = v;
    }
    return {
      type: 'builtin',
      name,
      config,
      native: { provider_tool_type: vendorType },
      executor: 'provider',
      _raw: rec,
    };
  }

  /**
   * `tool_choice` → canonical（10 §9.1）。
   *
   * 字符串 `auto` / `required` / `none` 同名；`{type:"function", name}` → `{type:"tool", name}`；
   * `{type:"web_search"}` 一类 → `{type:"builtin", name}`（canonical 稳定名）。
   * 未建模形态不猜：进 `raw.nodes`，回写时原样还原。
   */
  private decodeToolChoice(
    obj: Record<string, unknown>,
    warnings: string[],
    nodes: Record<string, unknown>,
  ): ToolChoice | undefined {
    const raw = obj['tool_choice'];
    if (raw === undefined) return undefined;
    if (typeof raw === 'string') {
      if (raw === 'auto' || raw === 'required' || raw === 'none') return raw;
      warnings.push(`unknown_tool_choice:${raw}`);
      nodes['tool_choice'] = raw;
      return undefined;
    }
    const c = asRecord(raw);
    if (c === undefined) return undefined;
    const type = str(c['type']);
    if (type === 'function') {
      return { type: 'tool', name: str(c['name']) ?? '' };
    }
    if (type !== undefined && isBuiltinToolName(type)) {
      return { type: 'builtin', name: type };
    }
    warnings.push(`unknown_tool_choice_type:${type ?? '<empty>'}`);
    nodes['tool_choice'] = raw;
    return undefined;
  }

  /**
   * 采样参数 → `ChatParams`（42 §4.2 末三行 + §4.1 的 `max_output_tokens` 行）。
   *
   * Responses **没有** `stop` / `frequency_penalty` / `presence_penalty` / `n` / `seed`
   * （10 §9.1 已把这几行在 Responses 列写「无」）——客户端脸收到这些字段时它们**不在**
   * `MODELLED_REQUEST_KEYS` 里，自动进 `raw.unmapped`（42 §4.2 的「注意」：
   * 不造一个 canonical 字段再丢弃）。
   */
  private decodeParams(
    obj: Record<string, unknown>,
    warnings: string[],
    nodes: Record<string, unknown>,
  ): ChatParams | undefined {
    const params: ChatParams = {};

    const maxOutput = num(obj['max_output_tokens']);
    if (maxOutput !== undefined) params.max_output_tokens = maxOutput;
    const temperature = num(obj['temperature']);
    if (temperature !== undefined) params.temperature = temperature;
    const topP = num(obj['top_p']);
    if (topP !== undefined) params.top_p = topP;
    const topLogprobs = num(obj['top_logprobs']);
    if (topLogprobs !== undefined) params.top_logprobs = topLogprobs;
    if (typeof obj['user'] === 'string') params.user = obj['user'] as string;
    const metadata = asRecord(obj['metadata']);
    if (metadata !== undefined) {
      params.metadata = Object.fromEntries(
        Object.entries(metadata).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
      );
    }
    if (typeof obj['service_tier'] === 'string') {
      params.service_tier = obj['service_tier'] as ChatParams['service_tier'];
    }
    if (typeof obj['parallel_tool_calls'] === 'boolean') {
      params.parallel_tool_calls = obj['parallel_tool_calls'] as boolean;
    }

    const reasoning = asRecord(obj['reasoning']);
    if (reasoning !== undefined) params.thinking = this.decodeThinking(reasoning, nodes);

    const text = asRecord(obj['text']);
    if (text !== undefined) {
      const format = this.decodeResponseFormat(text['format'], warnings);
      if (format !== undefined) params.response_format = format;
      const extras = extrasOf(text, ['format']);
      if (extras !== undefined) nodes['text.extras'] = extras;
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  /**
   * `reasoning` → `ThinkingConfig`（42 §4.2：`reasoning.effort` → `ThinkingConfig.effort`）。
   *
   * `effort: "none"` 的语义是**关推理**（40 §3.1 同 openai-chat 的判据），因此
   * `enabled = effort !== "none"`。`summary` 归一成 `include_summary` 布尔；原文值
   * （auto / concise / detailed）进 `raw.nodes['reasoning.summary']`，回写时还原。
   */
  private decodeThinking(
    reasoning: Record<string, unknown>,
    nodes: Record<string, unknown>,
  ): ThinkingConfig {
    const effort = str(reasoning['effort']);
    const summary = str(reasoning['summary']);
    if (summary !== undefined) nodes['reasoning.summary'] = summary;
    const extras = extrasOf(reasoning, ['effort', 'summary']);
    if (extras !== undefined) nodes['reasoning.extras'] = extras;
    return {
      enabled: effort !== 'none',
      ...(effort === undefined ? {} : { effort: effort as ThinkingConfig['effort'] }),
      ...(summary === undefined ? {} : { include_summary: true }),
    };
  }

  /** `text.format` → `ResponseFormat`（42 §4.2：直接落 `ResponseFormat`，10 §4.4）。 */
  private decodeResponseFormat(raw: unknown, warnings: string[]): ResponseFormat | undefined {
    const r = asRecord(raw);
    if (r === undefined) return undefined;
    const type = str(r['type']);
    if (type === 'text' || type === 'json_object') return { type };
    if (type === 'json_schema') {
      const js = asRecord(r['json_schema']);
      if (js === undefined) {
        warnings.push('response_format_json_schema_missing');
        return undefined;
      }
      const description = str(js['description']);
      return {
        type: 'json_schema',
        json_schema: {
          name: str(js['name']) ?? '',
          ...(description === undefined ? {} : { description }),
          schema: (asRecord(js['schema']) ?? {}) as JSONSchema,
          ...(typeof js['strict'] === 'boolean' ? { strict: js['strict'] as boolean } : {}),
        },
      };
    }
    warnings.push(`unknown_response_format_type:${type ?? '<empty>'}`);
    return undefined;
  }

  /** `stream` → `StreamOptions`（10 §4.5；chat 的 on_mismatch 默认 bridge）。 */
  private decodeStreamOptions(obj: Record<string, unknown>): CanonicalRequestEnvelope['stream'] {
    if (obj['stream'] !== true) return undefined;
    return { enabled: true, mode: 'sse', on_mismatch: 'bridge' };
  }

  // ===========================================================================
  // 请求：canonical → wire（canonical → 客户端格式）
  // ===========================================================================

  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest {
    const diagnostics: ConversionDiagnostic[] = [];
    const dropped: string[] = [];
    const warnings: string[] = [];

    // ---- fast path 短路（20 §4.2：不做任何结构转换，只透传原始字节）----
    // 注意：A 的期一闭环是「客户端说 Responses、上游说 Chat」，两者格式不同，
    // S2 因此不会标 fast_path_eligible（gateway-core/router.ts 的同格式判据）——
    // 这条分支只在「Responses 客户端 + Responses 上游」（B 期）才会真正走到。
    // Responses 侧**不需要**像 Chat 那样补 `stream_options.include_usage`：40 §2.3
    // 明说 Responses 的 usage 恒搭终事件。
    const rawBody = ctx.state[CTX_STATE_KEYS.RAW_BODY];
    if (ctx.fast_path === true && Buffer.isBuffer(rawBody)) {
      return {
        body: undefined,
        raw_bytes: rawBody,
        fast_path: true,
        path: this.endpointPathFor(ctx),
        dropped: [],
        warnings: [],
        diagnostics: [],
      };
    }
    if (ctx.fast_path === true) {
      this.logger?.warn(
        'openai.responses: fast_path 但 ctx.state.raw_body 不是 Buffer，退化为结构编码',
      );
    }

    /** 记录一条 warning 级诊断（20 §S4：六元组，不允许只打日志不上报）。 */
    const warn = (code: string, fieldPath: string, message: string): void => {
      diagnostics.push({
        code,
        field_path: fieldPath,
        from: req.source_format,
        to: FORMAT,
        level: 'warning',
        message,
      });
      warnings.push(code);
      dropped.push(fieldPath);
    };

    const payload = req.payload as ChatPayload;
    const params = payload.params;

    const body: Record<string, unknown> = {
      // **必须用 `resolved_model ?? model`**（与 openai-chat / anthropic-messages 同一立场）：
      // `resolved_model` 是 S2/S3/S4 写入的上游侧真实 model id，客户端传的可能是别名。
      model: req.resolved_model ?? req.model,
      input: this.encodeInput(payload, warn),
    };

    const instructions = this.encodeInstructions(payload.system);
    if (instructions !== undefined) body['instructions'] = instructions;

    if (payload.tools !== undefined && payload.tools.length > 0) {
      const profile = this.profileFor(ctx);
      body['tools'] = payload.tools.map((tool) => this.encodeTool(tool, warn, profile));
    }
    const toolChoice = this.encodeToolChoice(payload.tool_choice, req.raw.nodes);
    if (toolChoice !== undefined) body['tool_choice'] = toolChoice;

    if (params !== undefined) this.encodeParams(params, body, warn, req.raw.nodes);

    if (req.stream !== undefined && req.stream.enabled) body['stream'] = true;

    // 10 §7.2 第 3 条：顶层 unmapped 回写。**只在同格式时成立**（第 1 条「整体还原」的前提
    // 是 source_provider === 目标格式）——跨格式时那些键是别家方言的顶层字段，照抄进
    // Responses 请求体就是静默注入（anthropic adaptor 的 encodeUnmapped 同款判据；
    // s4-encode.ts 文件头「反向 passthrough …同一格式互转时的无损保证」）。
    if (req.raw.source_provider === PROVIDER_NAME) {
      for (const [key, value] of Object.entries(req.raw.unmapped ?? {})) {
        body[key] = value;
      }
      // 10 §7.2 第 2 条：未建模的 tool / tool_choice 节点级还原。
      // 键名是内部索引（`tool:<i>`），回写时要落回 `tools[]` 数组而不是当成顶层字段。
      const unmodelledTools: Array<{ index: number; entry: unknown }> = [];
      for (const [key, value] of Object.entries(req.raw.nodes ?? {})) {
        if (key === 'tool_choice') {
          body['tool_choice'] = value;
        } else if (key.startsWith('tool:')) {
          unmodelledTools.push({ index: Number(key.slice('tool:'.length)), entry: value });
        }
      }
      if (unmodelledTools.length > 0) {
        const modelled = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
        body['tools'] = [
          ...modelled,
          ...unmodelledTools.sort((a, b) => a.index - b.index).map((t) => t.entry),
        ];
      }
    }

    return {
      body,
      fast_path: false,
      path: this.endpointPathFor(ctx),
      dropped,
      warnings,
      diagnostics,
    };
  }

  /**
   * canonical `system[]` → `instructions`（字符串）。
   *
   * 42 §4.2：`instructions` 是 `ChatPayload.system[]` 的一条 `SystemBlock`。回写判据用
   * `_raw` 的**类型**：decode 时来自 `instructions` 的 block 其 `_raw` 是字符串，来自
   * system/developer 角色 message item 的其 `_raw` 是对象——后者不走这里，由
   * `encodeInput` 还原成 message item（42 §7.1 测试 5「多 system 消息不丢」）。
   */
  private encodeInstructions(system: SystemBlock[] | undefined): string | undefined {
    if (system === undefined || system.length === 0) return undefined;
    const first = system[0];
    if (first === undefined || typeof first._raw !== 'string') return undefined;
    return first.text;
  }

  /**
   * canonical `messages` → Responses 的 `input`（42 §4.1 首行：string 或 item 数组）。
   *
   * 字符串形态的判据：**唯一**一条消息、role user、**唯一**一个 TextPart、且该消息的
   * `_raw` 是字符串（decode 时由 `input: "..."` 造出来的标记）。缺 `_raw` 的 canonical
   * （跨格式 / 手写）一律走 item 数组——那是安全的默认形态，不假装字节级保真。
   */
  private encodeInput(
    payload: ChatPayload,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): unknown {
    const system = payload.system ?? [];
    const messages = payload.messages;
    const sole = messages.length === 1 ? messages[0] : undefined;
    if (
      system.length <= 1 &&
      sole !== undefined &&
      sole.role === 'user' &&
      sole.parts.length === 1 &&
      sole.parts[0]?.type === 'text' &&
      typeof sole._raw === 'string'
    ) {
      return (sole.parts[0] as TextPart).text;
    }

    const items: unknown[] = [];
    // system block（除第一条 = instructions 的）还原成 system/developer 角色 message item
    for (const [i, block] of system.entries()) {
      if (i === 0 && typeof block._raw === 'string') continue;
      const raw = asRecord(block._raw);
      const role =
        raw !== undefined && typeof raw['role'] === 'string' ? (raw['role'] as string) : 'system';
      const item: Record<string, unknown> = {
        type: 'message',
        role,
        content: [{ type: 'input_text', text: block.text }],
      };
      Object.assign(item, unmodelledFields(block._raw, MESSAGE_ITEM_MODELLED_KEYS));
      items.push(item);
    }

    for (const message of messages) {
      // canonical 的 `tool` 消息带 N 个 tool_result part（网关 agentic loop 把一轮的结果
      // 拼在一条消息里），而 Responses 的契约是「每个 function_call 各跟一个
      // function_call_output item」。压成一个会让上游配对不上，所以按 part 拆开。
      if (message.role === 'tool') {
        items.push(...this.encodeToolMessage(message, warn));
        continue;
      }
      items.push(this.encodeInputItem(message, warn));
    }
    return items;
  }

  /**
   * 一条 canonical 消息 → 一个 Responses input item。
   *
   * 分发判据是 `_raw` 的 `type`：decode 时 `function_call` / `reasoning` /
   * `custom_tool_call` / `web_search_call` 各自成为独立 canonical 消息，回写时必须
   * **还原成同类型的 item**——把它们一律塞进 `message` item 会把工具调用变成一段
   * 文本，多轮工具循环当场断。
   */
  private encodeInputItem(
    message: CanonicalMessage,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): Record<string, unknown> {
    const raw = asRecord(message._raw);
    const rawType = raw === undefined ? undefined : str(raw['type']);
    if (raw === undefined) return this.encodeMessageItem(message, warn);

    if (rawType === 'function_call') {
      const toolUse = message.parts.find((p): p is ToolUsePart => p.type === 'tool_use');
      return {
        ...raw,
        type: 'function_call',
        ...(toolUse === undefined
          ? {}
          : { arguments: toolUse.raw_arguments ?? JSON.stringify(toolUse.input) }),
      };
    }
    if (rawType === 'reasoning') {
      const text = thinkingTextOf(message.parts);
      const original = raw['content'];
      return {
        ...raw,
        type: 'reasoning',
        content: typeof original === 'string' ? text : [{ type: 'reasoning_text', text }],
      };
    }
    if (rawType !== undefined && rawType !== 'message') {
      // custom_tool_call / custom_tool_call_output / web_search_call / item_reference：
      // 整 item 原文已在 `_raw` 里（含 DeepSeek 扩展字段与 action.sources），原样还原
      return { ...raw };
    }
    return this.encodeMessageItem(message, warn);
  }

  /**
   * canonical `tool` 消息 → **N 个** `function_call_output` item。
   *
   * 没有 tool_result part 时一个都不产（空 `call_id` 的 item 同样是上游会拒的形状），
   * 只记 warning（同 openai-chat 的 `encodeToolMessage`）。
   */
  private encodeToolMessage(
    message: CanonicalMessage,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): Array<Record<string, unknown>> {
    const results = message.parts.filter((p): p is ToolResultPart => p.type === 'tool_result');
    if (results.length === 0) {
      warn(
        'tool_message_without_result',
        'messages.tool',
        'canonical tool 消息里没有 tool_result part，OpenAI Responses 无法表达（已整条丢弃）',
      );
      return [];
    }
    return results.map((result) => {
      const item: Record<string, unknown> = {
        type: 'function_call_output',
        call_id: result.tool_use_id,
        output: this.encodeToolResultContent(result.content, warn),
      };
      Object.assign(item, unmodelledFields(message._raw, ['type', 'call_id', 'output']));
      return item;
    });
  }

  /**
   * canonical 消息 → Responses 的 `message` item（**一条 canonical 一条 item**）。
   *
   * `role === 'tool'` 与 `_raw.type` 非 message 的消息都不走这里（分别见
   * `encodeToolMessage` 与 `encodeInputItem`）。
   */
  private encodeMessageItem(
    message: CanonicalMessage,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): Record<string, unknown> {
    const raw = asRecord(message._raw);
    const role =
      raw !== undefined && typeof raw['role'] === 'string' ? (raw['role'] as string) : message.role;
    // user / system / developer 用 input_text，assistant 用 output_text（42 §4.1）
    const textType =
      role === 'user' || role === 'system' || role === 'developer' ? 'input_text' : 'output_text';

    // `input: "..."` 形态或跨格式 canonical：_raw 不是 item 对象，按默认形状合成
    if (raw === undefined) {
      const content: unknown[] = [];
      const annotations: unknown[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') content.push({ type: textType, text: part.text });
        else if (part.type === 'image') content.push(this.encodeImagePart(part));
        else if (part.type === 'document') content.push(this.encodeDocumentPart(part));
        else if (part.type === 'search_result') {
          const annotation = asRecord(part._raw);
          if (annotation !== undefined) annotations.push(annotation);
        } else {
          warn(
            `${part.type}_not_a_content_part`,
            `parts.${part.type}`,
            `canonical 的 ${part.type} part 在 Responses 的 message item 里没有对应 content part，已丢弃`,
          );
        }
      }
      attachAnnotations(content, annotations);
      return { type: 'message', role, content };
    }

    // 节点级还原优先（10 §7.2 第 2 条）：原 item 还在 → 以它为底，只重建 content
    const content: unknown[] = [];
    const annotations: unknown[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        const block = asRecord(part._raw);
        content.push({ ...(block ?? {}), type: textType, text: part.text });
      } else if (part.type === 'refusal') {
        const block = asRecord(part._raw);
        content.push({ ...(block ?? {}), type: 'refusal', refusal: part.reason });
      } else if (part.type === 'image') {
        content.push(this.encodeImagePart(part));
      } else if (part.type === 'document') {
        content.push(this.encodeDocumentPart(part));
      } else if (part.type === 'search_result') {
        const annotation = asRecord(part._raw);
        if (annotation !== undefined) annotations.push(annotation);
      } else {
        // thinking / tool_use / unknown 在 Responses 里是**独立 item**，不是 message 的
        // content part。decode 时它们已经各自成为独立 canonical 消息，正常不会走到这里；
        // 真走到了（跨格式 canonical 把这些 part 塞进了同一条消息）就丢弃 + 告警。
        warn(
          `${part.type}_not_a_content_part`,
          `parts.${part.type}`,
          `canonical 的 ${part.type} part 在 Responses 的 message item 里没有对应 content part，已丢弃`,
        );
      }
    }
    attachAnnotations(content, annotations);
    return { ...raw, type: 'message', role, content };
  }

  /** `ToolResultPart.content` → `function_call_output.output`（string 或 block 数组）。 */
  private encodeToolResultContent(
    content: Part[] | string,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): unknown {
    if (typeof content === 'string') return content;
    const blocks: unknown[] = [];
    for (const part of content) {
      if (part.type === 'text') blocks.push({ type: 'input_text', text: part.text });
      else if (part.type === 'image') blocks.push(this.encodeImagePart(part));
      else if (part.type === 'document') blocks.push(this.encodeDocumentPart(part));
      else {
        warn(
          'tool_result_part_unsupported',
          `parts.${part.type}`,
          `tool_result 内容里的 ${part.type} part 在 OpenAI Responses 无对应，已丢弃`,
        );
      }
    }
    return blocks.length === 1 && (blocks[0] as { type?: string }).type === 'input_text'
      ? (blocks[0] as { text: string }).text
      : blocks;
  }

  /** `ImagePart` → Responses 的 `input_image` block（节点级还原优先）。 */
  private encodeImagePart(part: ImagePart): unknown {
    const rawBlock = asRecord(part._raw);
    if (rawBlock !== undefined) {
      const rawUrl = rawBlock['image_url'];
      if (typeof rawUrl === 'string' && rawUrl === mediaToUrl(part.source)) {
        return { ...rawBlock };
      }
      // file_id 形态：source 是空 uri 占位，原样回写（detail / file_id 等不丢）
      if (
        typeof rawBlock['file_id'] === 'string' &&
        part.source.kind === 'uri' &&
        part.source.uri === ''
      ) {
        return { ...rawBlock };
      }
    }
    return { type: 'input_image', image_url: mediaToUrl(part.source) };
  }

  /** `DocumentPart` → Responses 的 `input_file` block（节点级还原优先）。 */
  private encodeDocumentPart(part: DocumentPart): unknown {
    const rawBlock = asRecord(part._raw);
    if (rawBlock !== undefined && part.source.kind === 'uri' && part.source.uri === '') {
      return { ...rawBlock };
    }
    const url = mediaToUrl(part.source);
    return {
      type: 'input_file',
      ...(url.startsWith('data:') ? { file_data: url } : { file_url: url }),
      ...(part.media_type === undefined ? {} : { media_type: part.media_type }),
      ...(part.title === undefined ? {} : { title: part.title }),
    };
  }

  private encodeTool(
    tool: CanonicalTool,
    warn: (code: string, fieldPath: string, message: string) => void,
    profile: ProviderProfile | undefined,
  ): unknown {
    if (tool.type === 'builtin') {
      // 50 §3.1 模式 A：上游原生支持 → 透传成厂商专有 server tool 声明。
      // OpenAI 标准的三个内置工具名直接映射；认不出（没有 profile 或 profile 不覆盖该
      // canonical 名）→ 丢弃 + 告警，不猜一个 Responses 专有类型名。
      const wire = builtinToolWireType(tool.name) ?? profile?.builtinToolWire?.(tool.name, FORMAT);
      if (wire === undefined) {
        warn(
          'builtin_tool_unsupported',
          `tools.${tool.name}`,
          `canonical 内置工具 ${tool.name} 在目标 provider 无原生对应，已丢弃`,
        );
        return { type: 'function', name: tool.name, parameters: {} };
      }
      // provider 明确不吃配置字段时丢弃 + 告警，不静默发过去
      const acceptsConfig = profile?.builtinToolAcceptsConfig?.(tool.name) ?? true;
      if (!acceptsConfig && Object.keys(tool.config).length > 0) {
        warn(
          'builtin_tool_config_unsupported',
          `tools.${tool.name}.config`,
          `上游不接受内置工具 ${tool.name} 的配置字段，已丢弃`,
        );
      }
      const native = asRecord(tool.native);
      const providerType =
        typeof native?.['provider_tool_type'] === 'string'
          ? (native['provider_tool_type'] as string)
          : wire;
      return {
        ...(asRecord(tool._raw) ?? {}),
        type: providerType,
        ...(acceptsConfig ? tool.config : {}),
      };
    }
    if (tool.cache_control !== undefined) {
      warn(
        'cache_control_unsupported',
        'tools.cache_control',
        'OpenAI Responses 没有块级 cache_control 断点，已丢弃',
      );
    }
    return {
      type: 'function',
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    };
  }

  private encodeToolChoice(
    choice: ToolChoice | undefined,
    nodes: Record<string, unknown> | undefined,
  ): unknown {
    if (choice === undefined) {
      // 未建模形态的节点级还原（decodeToolChoice 里进了 raw.nodes）
      return nodes?.['tool_choice'];
    }
    if (typeof choice === 'string') return choice;
    if (choice.type === 'builtin') {
      return { type: builtinToolWireType(choice.name) ?? choice.name };
    }
    return { type: 'function', name: choice.name };
  }

  /**
   * `ChatParams` → Responses 顶层字段（42 §4.1 反向）。
   *
   * canonical 有而 Responses 没有的采样参数（`stop` / `frequency_penalty` /
   * `presence_penalty` / `n` / `seed` / `logprobs` / `top_k` / `safety` /
   * `thinking.budget_tokens`）逐条 drop + warning（40 §1.4 第 3 步；
   * 10 §9.1 的 Responses 列写「无」）。
   */
  private encodeParams(
    params: ChatParams,
    body: Record<string, unknown>,
    warn: (code: string, fieldPath: string, message: string) => void,
    nodes: Record<string, unknown> | undefined,
  ): void {
    if (params.max_output_tokens !== undefined) {
      body['max_output_tokens'] = params.max_output_tokens;
    }
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.top_p !== undefined) body['top_p'] = params.top_p;
    if (params.top_logprobs !== undefined) body['top_logprobs'] = params.top_logprobs;
    if (params.user !== undefined) body['user'] = params.user;
    if (params.metadata !== undefined) body['metadata'] = params.metadata;
    if (params.service_tier !== undefined) body['service_tier'] = params.service_tier;
    if (params.parallel_tool_calls !== undefined) {
      body['parallel_tool_calls'] = params.parallel_tool_calls;
    }

    if (params.thinking !== undefined) {
      const thinking = params.thinking;
      const reasoning: Record<string, unknown> = {
        ...(thinking.effort === undefined ? {} : { effort: thinking.effort }),
      };
      const summary = nodes?.['reasoning.summary'];
      if (typeof summary === 'string') reasoning['summary'] = summary;
      else if (thinking.include_summary === true) reasoning['summary'] = 'auto';
      const extras = asRecord(nodes?.['reasoning.extras']);
      if (extras !== undefined) Object.assign(reasoning, extras);
      if (Object.keys(reasoning).length > 0) body['reasoning'] = reasoning;
      if (thinking.budget_tokens !== undefined) {
        warn(
          'thinking_budget_unsupported',
          'params.thinking.budget_tokens',
          'OpenAI Responses 只有 reasoning.effort 档位，没有连续 token 预算，已丢弃',
        );
      }
    }

    if (params.response_format !== undefined) {
      const format = this.encodeResponseFormat(params.response_format);
      const extras = asRecord(nodes?.['text.extras']);
      body['text'] = extras === undefined ? format : { ...format, ...extras };
    } else {
      const extras = asRecord(nodes?.['text.extras']);
      if (extras !== undefined) body['text'] = extras;
    }

    // canonical 有、Responses 没有的采样参数：逐条 drop + warning
    if (params.stop !== undefined) {
      warn('stop_unsupported', 'params.stop', 'OpenAI Responses 不支持 stop，已丢弃');
    }
    if (params.seed !== undefined) {
      warn('seed_unsupported', 'params.seed', 'OpenAI Responses 不支持 seed，已丢弃');
    }
    if (params.frequency_penalty !== undefined) {
      warn(
        'frequency_penalty_unsupported',
        'params.frequency_penalty',
        'OpenAI Responses 不支持 frequency_penalty，已丢弃',
      );
    }
    if (params.presence_penalty !== undefined) {
      warn(
        'presence_penalty_unsupported',
        'params.presence_penalty',
        'OpenAI Responses 不支持 presence_penalty，已丢弃',
      );
    }
    if (params.n !== undefined) {
      warn('n_unsupported', 'params.n', 'OpenAI Responses 不支持 n，已丢弃');
    }
    if (params.logprobs !== undefined) {
      warn('logprobs_unsupported', 'params.logprobs', 'OpenAI Responses 不支持 logprobs，已丢弃');
    }
    if (params.top_k !== undefined) {
      warn('top_k_unsupported', 'params.top_k', 'OpenAI Responses 不支持 top_k，已丢弃');
    }
    if (params.safety !== undefined) {
      warn('safety_unsupported', 'params.safety', 'OpenAI Responses 没有 safetySettings，已丢弃');
    }
  }

  /** `ResponseFormat` → `text.format`（42 §4.2 反向）。 */
  private encodeResponseFormat(format: ResponseFormat): Record<string, unknown> {
    if (format.type === 'json_schema' && format.json_schema !== undefined) {
      const js = format.json_schema;
      const description = js.description;
      return {
        type: 'json_schema',
        name: js.name,
        ...(description === undefined ? {} : { description }),
        schema: js.schema,
        ...(js.strict === undefined ? {} : { strict: js.strict }),
      };
    }
    return { type: format.type };
  }

  // ===========================================================================
  // 响应：wire → canonical（上游格式 → canonical）
  // ===========================================================================

  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error('OpenAI Responses 响应体不是 JSON object');
    }
    const warnings: string[] = [];

    // `output[]` 折成**一条** assistant 消息的 parts（与 openai-chat 把 content + tool_calls
    // 折成一条 message 同构）。每个 part 的 `_raw` 指向产出它的那个 item 对象，回写时按
    // `_raw` **对象标识**把相邻 part 分组还原成 item（10 §7.2 第 2 条逐节点还原）。
    const output = asArray(obj['output']) ?? [];
    const parts: Part[] = [];
    for (const entry of output) {
      const item = asRecord(entry);
      if (item === undefined) {
        parts.push({ type: 'unknown', raw_type: 'item', raw: entry });
        warnings.push('malformed_output_item');
        continue;
      }
      parts.push(...this.decodeOutputItem(item, warnings));
    }

    const usage = this.buildUsage(obj['usage'], warnings);

    const status = str(obj['status']);
    const incompleteDetails = asRecord(obj['incomplete_details']);
    const normalized = this.normalizeFinishReason({
      ...(status === undefined ? {} : { status }),
      ...(incompleteDetails === undefined ? {} : { incomplete_details: incompleteDetails }),
    });
    if (status !== undefined && FINISH_REASON_TO_CANONICAL[status] === undefined) {
      // 10 §9.3 注意 2：未命中不得默认 stop
      warnings.push(`unmapped_finish_reason:${status}`);
      this.logger?.warn('openai.responses: status 未命中归一表', { raw: status });
    }

    const error = asRecord(obj['error']);
    if (error !== undefined) warnings.push('response_error_present');

    const model = str(obj['model']);
    const responsePayload: ChatResponsePayload = {
      message: { role: 'assistant', parts },
      ...(model === undefined ? {} : { model }),
    };

    const unmapped = collectUnmapped(obj, MODELLED_RESPONSE_KEYS);

    return {
      ir_version: IR_VERSION,
      kind: MODALITY,
      request_id: str(obj['id']) ?? ctx.request_id,
      usage,
      finish_reason: normalized,
      payload: responsePayload,
      raw: {
        source_provider: PROVIDER_NAME,
        ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
        // 10 §9.3 注意 3：原文进 RawEnvelope 的顶层一等字段（ir/envelope.ts）
        ...(status === undefined ? {} : { finish_reason_provider: status }),
        // `status:"failed"` 时的 `response.error`：回写时还原，不重新猜
        ...(error === undefined ? {} : { nodes: { error } }),
      },
      warnings,
    };
  }

  /** 单个 output item → Part[]（42 §4.1 的输出行 + §4.4 的 custom/web_search 行）。 */
  private decodeOutputItem(item: Record<string, unknown>, warnings: string[]): Part[] {
    const type = str(item['type']) ?? 'message';

    if (type === 'message') {
      // assistant 的 message item：content[] → text / refusal part，`_raw` 指向 item 本身
      const content = item['content'];
      if (typeof content === 'string') {
        return [{ type: 'text', text: content, _raw: item }];
      }
      const parts: Part[] = [];
      for (const block of asArray(content) ?? []) {
        const b = asRecord(block);
        if (b === undefined) {
          parts.push({ type: 'unknown', raw_type: 'block', raw: block });
          continue;
        }
        const blockType = str(b['type']) ?? '';
        if (blockType === 'output_text' || blockType === 'input_text') {
          parts.push({ type: 'text', text: str(b['text']) ?? '', _raw: item });
          // 42 §4.4：`annotations` 的引用按 10 §9.2 落 SearchResultPart
          parts.push(...decodeAnnotations(b['annotations']));
        } else if (blockType === 'refusal') {
          parts.push({ type: 'refusal', reason: str(b['refusal']) ?? '', _raw: item });
        } else {
          parts.push({ type: 'unknown', raw_type: blockType, raw: block });
          warnings.push(`unknown_content_part_type:${blockType}`);
        }
      }
      return parts;
    }

    if (type === 'reasoning') {
      // 42 §4.2：纯文本 content → ThinkingPart；summary / encrypted_content 整 item 进 _raw
      return [{ type: 'thinking', thinking: reasoningTextOf(item['content']), _raw: item }];
    }

    if (type === 'function_call') {
      // 与 decodeItem 的同款收窄：`ToolUsePart.id` 取 `call_id ?? id`，item 的 `id`
      // 由 `_raw` 节点级还原保留（工具循环的 tool_use_id 配对判据见 tool-loop.ts）。
      const callId = str(item['call_id']) ?? str(item['id']) ?? '';
      return [
        {
          ...this.decodeToolArguments(
            callId,
            str(item['name']) ?? '',
            str(item['arguments']) ?? '',
          ),
          _raw: item,
        },
      ];
    }

    if (type === 'function_call_output') {
      const output = item['output'];
      return [
        {
          type: 'tool_result',
          tool_use_id: str(item['call_id']) ?? '',
          content: typeof output === 'string' ? output : [],
          _raw: item,
        },
      ];
    }

    // custom_tool_call / web_search_call / item_reference / 未知 item 类型：
    // **无损收进** canonical（42 §4.4），不当 function tool，也不静默忽略。
    warnings.push(`unknown_output_item_type:${type}`);
    this.logger?.warn('openai.responses: 未建模的 output item 类型，进 UnknownPart 保留', {
      item_type: type,
    });
    // 42 §4.4：item 本体（含 DeepSeek 扩展字段 kind / page / signature / error 与
    // `action.sources`）整条进 UnknownPart 的 `_raw`，回写时原样还原——canonical 没有
    // 「服务端工具调用记录」这个概念，硬拆成 SearchResultPart 反而回不去。
    return [{ type: 'unknown', raw_type: type, raw: item }];
  }

  /**
   * usage → `CanonicalUsage`（40 §2.1 的 OpenAI Responses 列 + 42 §4.6 的三行补充）。
   *
   * 三条硬约束：
   *   - **I4**：整个原始 usage 对象逐字段进 `usage.raw`，独立于 `units`
   *     （流式聚合只动 units，绝不动 raw，否则 extras 会丢——LiteLLM 的教训）；
   *   - **10 §6.1 规则 2**：上游没给 usage 时 `units.tokens` 键**省略** +
   *     `warnings += "usage_missing"`，绝不用 0 表示未知；
   *   - **I1**：`input_tokens` 记 `input_tokens` 全量（含 cached 部分，不另加，避免双算）。
   *
   * 42 §4.6 的两处补充：
   *   1. `output_tokens_details.safety_tokens`（DeepSeek 扩展）**不加**进 `reasoning_tokens`、
   *      也不加进 `output_tokens`（官方明说已含在 `output_tokens` 内）→ 只进 `details`，
   *      按 40 §2.2 的双算风险表记一行。
   *   2. `server_tool_use{tool_search,tool_fetch,tool_image_search}` 是**按次单位不是 token**
   *      → 落 `usage.units.requests` 的按次槽。
   */
  private buildUsage(rawUsage: unknown, warnings: string[]): CanonicalUsage {
    const usage = asRecord(rawUsage);
    if (usage === undefined) {
      warnings.push('usage_missing');
      return { units: {}, source: 'provider' };
    }

    const inputDetails = asRecord(usage['input_tokens_details']);
    const outputDetails = asRecord(usage['output_tokens_details']);
    const inputTokens = num(usage['input_tokens']);
    const outputTokens = num(usage['output_tokens']);

    const details: Record<string, number> = {};
    const safetyTokens = num(outputDetails?.['safety_tokens']);
    if (safetyTokens !== undefined) details['safety_tokens'] = safetyTokens;

    const tokens: NonNullable<CanonicalUsage['units']['tokens']> = {
      input_tokens: inputTokens ?? 0,
      output_tokens: outputTokens ?? 0,
      total_tokens: num(usage['total_tokens']) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
      cache_read_tokens: num(inputDetails?.['cached_tokens']) ?? 0,
      cache_write_tokens: 0,
      reasoning_tokens: num(outputDetails?.['reasoning_tokens']) ?? 0,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };

    const units: CanonicalUsage['units'] = { tokens };
    const serverToolUse = asRecord(usage['server_tool_use']);
    if (serverToolUse !== undefined) {
      const requests = Object.values(serverToolUse).reduce<number>(
        (acc, v) => (typeof v === 'number' && Number.isFinite(v) ? acc + v : acc),
        0,
      );
      if (requests > 0) units.requests = requests;
    }

    return { units, raw: usage, source: 'provider' };
  }

  // ===========================================================================
  // 响应：canonical → wire（canonical → 客户端格式）
  // ===========================================================================

  encodeResponse(res: CanonicalResponseEnvelope, _ctx: RequestContext): unknown {
    // 20 §7.2：错误体由客户端格式 codec 生成（不直接透传上游错误体，避免泄漏内部细节），
    // Responses 的形状是 `{error:{message,type,code}}`。判定信号是 finish_reason === "error"
    // 且**原文不是** `status:"failed"`——后者是上游通过 HTTP 200 报的失败（42 §4.5 折叠表
    // 末行：「这是 HTTP 200，不能按状态码当成功」），要还原成响应体而不是错误体。
    if (res.finish_reason === 'error' && res.raw.finish_reason_provider !== 'failed') {
      return this.encodeErrorBody(res);
    }

    const payload = res.payload as ChatResponsePayload;
    const status = this.encodeStatus(res);

    const out: Record<string, unknown> = {
      id: res.request_id,
      object: 'response',
      created_at: Math.floor(this.clock.now() / 1000),
      status,
      model: payload.model ?? '',
      output: this.encodeOutputItems(payload.message, res.raw.source_provider === PROVIDER_NAME),
    };

    const error = asRecord(res.raw.nodes?.['error']);
    if (error !== undefined) out['error'] = error;

    const tokens = res.usage.units.tokens;
    if (tokens !== undefined) out['usage'] = this.encodeUsage(tokens, res.usage.raw);

    // 10 §7.2 第 3 条：顶层 unmapped 回写（instructions / metadata / store /
    // incomplete_details 等响应回声字段）
    for (const [key, value] of Object.entries(res.raw.unmapped ?? {})) {
      out[key] = value;
    }
    // `incomplete_details` 在同格式回写时由 unmapped 带上；跨格式 canonical 没有它时，
    // 按 10 §9.3 反查表补一个，让客户端知道「为什么没说完」而不是看到一个光秃秃的
    // `status:"incomplete"`。
    if (status === 'incomplete' && out['incomplete_details'] === undefined) {
      out['incomplete_details'] = { reason: this.encodeIncompleteReason(res) ?? 'other' };
    }
    return out;
  }

  /**
   * canonical `finish_reason` → Responses 的 `status`（10 §9.3 反向）。
   *
   * 可逆性优先（注意 3）：`raw.finish_reason_provider` 有原文时**原样回写**；
   * 否则查反向表；反向表也没有（如 `other` / `recitation`）时落 `incomplete` 并让
   * `incomplete_details.reason` 说清楚，而不是猜一个 `completed`。
   *
   * ⚠️ 原样回写带**同格式前提**（10 §7.2 第 1 条）：只有 `source_provider` 是本格式时
   * 才认这个原文。
   */
  private encodeStatus(res: CanonicalResponseEnvelope): string {
    const provider =
      res.raw.source_provider === PROVIDER_NAME ? res.raw.finish_reason_provider : undefined;
    // 原文必须是 Responses 的合法 status 才认（`PROVIDER_NAME` 用的是 FormatId，所以
    // 跨格式时这里本来就是 undefined；再校验一次是防御将来的第三方信封）。
    if (typeof provider === 'string' && RESPONSES_STATUS_VALUES.has(provider)) return provider;
    return CANONICAL_TO_STATUS[res.finish_reason as NormalizedFinishReason] ?? 'incomplete';
  }

  /** canonical `finish_reason` → `incomplete_details.reason`（反查表，10 §9.3）。 */
  private encodeIncompleteReason(res: CanonicalResponseEnvelope): string | undefined {
    return CANONICAL_TO_INCOMPLETE_REASON[res.finish_reason as NormalizedFinishReason];
  }

  /**
   * canonical 错误 → Responses 错误体（20 §7.2 的映射表第一列）。
   *
   * ⚠️ 数据来源缺口（与 openai-chat 同款，已报告给 lead）：`runner.ts` 的 `errorEnvelope()`
   * 只把 `error.message` 放进 refusal part，`code` / `http_status` / `retryable` 都没进信封，
   * 因此这里只能从 `raw.nodes.error` 里找 canonical error，找不到就退到保守的
   * `server_error` + `code: null`。**不猜具体错误码**——猜错会让客户端把参数错误当
   * 服务端错误重试，或反之。
   */
  private encodeErrorBody(res: CanonicalResponseEnvelope): Record<string, unknown> {
    const payload = res.payload as ChatResponsePayload;
    const refusal = payload.message.parts.find((p) => p.type === 'refusal');
    const text =
      refusal !== undefined && refusal.type === 'refusal'
        ? refusal.reason
        : 'upstream request failed';
    const canonicalError = asRecord(res.raw.nodes?.['error']);
    const code =
      typeof canonicalError?.['code'] === 'string' ? (canonicalError['code'] as string) : undefined;
    const type =
      code === undefined ? 'server_error' : (RESPONSES_ERROR_TYPE_BY_CODE[code] ?? 'server_error');
    return {
      error: {
        message: text,
        type,
        ...(code === undefined ? { code: null } : { code }),
        param: null,
      },
    };
  }

  /**
   * canonical message.parts → Responses 的 `output[]`（42 §4.1 的输出行反向）。
   *
   * 分组规则：**按 part 的 `_raw` 对象标识**把相邻 part 归成一个 item。decode 时同一 item
   * 产出的所有 part 共享同一个 `_raw`（那个 item 对象），因此这里能完整还原
   * 「一个 message item 带 N 个 content part」的形状；没有 `_raw` 的 part（跨格式 canonical）
   * 各自成组，按 Responses 的默认形状合成。
   *
   * `search_result` part 不是独立 item：回写成 `annotations` 挂回 output_text（42 §4.4）。
   */
  private encodeOutputItems(message: CanonicalMessage, sameProvider = true): unknown[] {
    const items: unknown[] = [];
    let group: { raw: unknown; parts: Part[]; annotations: unknown[] } | undefined;
    /** 宿主 part 还没到的引用（手写 canonical 才会出现）：缓冲到下一个带 output_text 的组。 */
    let orphanAnnotations: unknown[] = [];
    const flush = (): void => {
      if (group === undefined) return;
      items.push(this.encodeOutputGroup(group.raw, group.parts, group.annotations));
      group = undefined;
    };

    for (const part of message.parts) {
      if (part.type === 'search_result') {
        const annotation = asRecord(part._raw);
        if (annotation === undefined) continue;
        if (group === undefined) orphanAnnotations.push(annotation);
        else group.annotations.push(annotation);
        continue;
      }
      const raw = sameProvider ? part._raw : undefined;
      if (group !== undefined && raw !== undefined && group.raw === raw) {
        group.parts.push(part);
        continue;
      }
      flush();
      group = { raw, parts: [part], annotations: orphanAnnotations };
      orphanAnnotations = [];
    }
    flush();
    return items;
  }

  /** 一组 part → 一个 Responses item。 */
  private encodeOutputGroup(raw: unknown, parts: Part[], annotations: unknown[]): unknown {
    const rawItem = asRecord(raw);
    if (rawItem === undefined) return this.synthesizeOutputGroup(parts, annotations);
    const type = str(rawItem['type']) ?? 'message';

    if (type === 'message') {
      const rawContent = (asArray(rawItem['content']) ?? []).map((b) => ({
        ...(asRecord(b) ?? {}),
      }));
      const content: Record<string, unknown>[] = [];
      let rawIndex = 0;
      for (const part of parts) {
        const base = asRecord(rawContent[rawIndex]);
        if (part.type === 'text') {
          content.push({ ...(base ?? {}), type: 'output_text', text: part.text });
          rawIndex += 1;
        } else if (part.type === 'refusal') {
          content.push({ ...(base ?? {}), type: 'refusal', refusal: part.reason });
          rawIndex += 1;
        } else if (part.type === 'unknown') {
          content.push({ ...(base ?? asRecord(part.raw) ?? {}), type: part.raw_type ?? 'unknown' });
          rawIndex += 1;
        }
      }
      if (annotations.length > 0) {
        const host = [...content].reverse().find((b) => b['type'] === 'output_text');
        if (host !== undefined) {
          // **替换而不是追加**：decode 时 `annotations` 已整体转成 SearchResultPart，
          // 这里收集到的就是完整集合；追加会让同一批引用出现两次（42 §4.4 往返不变式）。
          host['annotations'] = annotations;
        } else {
          content.push({ type: 'output_text', text: '', annotations });
        }
      }
      return { ...rawItem, type: 'message', content };
    }
    if (type === 'reasoning') {
      return {
        ...rawItem,
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: thinkingTextOf(parts) }],
      };
    }
    if (type === 'function_call') {
      const toolUse = parts.find((p): p is ToolUsePart => p.type === 'tool_use');
      return {
        ...rawItem,
        type: 'function_call',
        ...(toolUse === undefined
          ? {}
          : { arguments: toolUse.raw_arguments ?? JSON.stringify(toolUse.input) }),
      };
    }
    if (type === 'function_call_output') {
      const result = parts.find((p): p is ToolResultPart => p.type === 'tool_result');
      return {
        ...rawItem,
        type: 'function_call_output',
        ...(result === undefined
          ? {}
          : { output: this.encodeToolResultContent(result.content, () => {}) }),
      };
    }
    // unknown / custom_tool_call / web_search_call：原文已在 raw 里，原样还原
    return { ...rawItem };
  }

  /** 没有 `_raw` 的 part 组 → 按 Responses 默认形状合成 item。 */
  private synthesizeOutputGroup(parts: Part[], annotations: unknown[]): unknown {
    const first = parts[0];
    if (first === undefined) return { type: 'message', role: 'assistant', content: [] };
    if (first.type === 'text') {
      return {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: first.text,
            ...(annotations.length > 0 ? { annotations } : {}),
          },
        ],
      };
    }
    if (first.type === 'refusal') {
      return {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: first.reason }],
      };
    }
    if (first.type === 'thinking') {
      return { type: 'reasoning', content: [{ type: 'reasoning_text', text: first.thinking }] };
    }
    if (first.type === 'tool_use') {
      return {
        type: 'function_call',
        id: first.id,
        call_id: first.id,
        name: first.name,
        arguments: first.raw_arguments ?? JSON.stringify(first.input),
      };
    }
    if (first.type === 'tool_result') {
      return {
        type: 'function_call_output',
        call_id: first.tool_use_id,
        output: this.encodeToolResultContent(first.content, () => {}),
      };
    }
    if (first.type !== 'unknown') return { type: 'unknown', raw: first };
    return { type: first.raw_type ?? 'unknown', ...(asRecord(first.raw) ?? {}) };
  }

  /**
   * canonical usage → Responses usage 对象（40 §2.1 反向）。
   *
   * 有 `usage.raw` 时**原样还原优先**（I4 的对账价值）；否则从 `units` 重建，
   * `*_details` 只在对应值非 0 时输出（回写方向同样不得把「上游没给」写成 0，
   * 10 §6.1 规则 2 的同立场）。
   */
  private encodeUsage(
    tokens: NonNullable<CanonicalUsage['units']['tokens']>,
    rawUsage: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    // 原样还原只在 raw **确实是 Responses usage 形状**时成立。跨格式时（客户端是
    // Responses、上游是 Chat）`usage.raw` 是 `{prompt_tokens, completion_tokens, …}`，
    // 照抄会让 Responses 客户端拿到一堆它不认识的键（I4 的对账价值仍在 raw 里，
    // 但 wire 上必须给对的形状）。
    if (rawUsage !== undefined && isResponsesUsageShape(rawUsage)) return { ...rawUsage };
    const usage: Record<string, unknown> = {
      input_tokens: tokens.input_tokens,
      output_tokens: tokens.output_tokens,
      total_tokens: tokens.total_tokens,
    };
    if (tokens.cache_read_tokens !== 0) {
      usage['input_tokens_details'] = { cached_tokens: tokens.cache_read_tokens };
    }
    if (tokens.reasoning_tokens !== 0) {
      usage['output_tokens_details'] = { reasoning_tokens: tokens.reasoning_tokens };
    }
    return usage;
  }

  // ===========================================================================
  // 流式：wire → canonical（上游格式 → canonical，20 §S6 折叠表 + 42 §4.5）
  // ===========================================================================

  async *decodeStream(
    stream: AsyncIterable<unknown>,
    ctx: RequestContext,
  ): AsyncIterable<StreamFrame> {
    const state: StreamFoldState = {
      indexByItemId: new Map(),
      openParts: new Map(),
      warnings: [],
      terminalSeen: false,
      onUsage: () => {},
    };

    for await (const item of stream) {
      const ev = parseWireEvent(item);
      if (ev === undefined) continue;
      const type = str(ev.payload['type']) ?? ev.name;
      if (type === undefined) continue;
      yield* this.foldEvent(type, ev.payload, ctx, state);
    }

    // 流结束：给还没收尾的 part 补 part.end（20 §S6：part.end 带完整 part）
    yield* this.flushOpenParts(ctx, state.openParts, undefined);

    if (state.terminalSeen) return;
    // 残缺流（没有终事件）：补一个终止帧，避免客户端永远等不到结束
    // （anthropic adaptor 的 message_stop 分支同款立场）。
    state.warnings.push('stream_missing_terminal_event');
    yield this.makeFrame('end', ctx, {
      finish_reason: 'stop',
      output: { [RAW_FINISH_REASON_KEY]: 'completed', warnings: state.warnings },
    });
  }

  /** 单个 wire 事件 → 0..n 帧（42 §4.5 的流式折叠表）。 */
  private *foldEvent(
    type: string,
    payload: Record<string, unknown>,
    ctx: RequestContext,
    state: StreamFoldState,
  ): Generator<StreamFrame> {
    const response = asRecord(payload['response']);
    const outputIndex = num(payload['output_index']) ?? 0;
    const itemId = str(payload['item_id']);

    switch (type) {
      case 'response.created': {
        // 42 §4.5：带 model + client_format / provider_format；此时 usage 为 null，**不带**
        const id = response === undefined ? undefined : str(response['id']);
        const model = response === undefined ? undefined : str(response['model']);
        yield this.makeFrame('start', ctx, {
          ...(id === undefined ? {} : { session_id: id }),
          model: model ?? '',
          client_format: ctx.client_format,
          provider_format: ctx.provider_format,
        });
        return;
      }

      case 'response.output_item.added': {
        const item = asRecord(payload['item']);
        if (item === undefined) return;
        const itemType = str(item['type']) ?? 'message';
        if (itemId !== undefined) state.indexByItemId.set(itemId, outputIndex);
        const open: OpenPart = {
          kind: 'text',
          text: '',
          args: '',
          raw: item,
          ...(itemId === undefined ? {} : { itemId }),
        };
        if (itemType === 'function_call') {
          open.kind = 'tool_use';
          open.name = str(item['name']) ?? '';
          const callId = str(item['call_id']);
          if (callId !== undefined) open.callId = callId;
        } else if (itemType === 'reasoning') {
          open.kind = 'thinking';
        } else if (itemType !== 'message') {
          // custom_tool_call / web_search_call / 未知 item：原样进 UnknownPart（42 §4.4）
          open.kind = 'unknown';
          state.warnings.push(`unknown_stream_item_type:${itemType}`);
        }
        state.openParts.set(outputIndex, open);
        yield this.makeFrame('meta', ctx, {
          notes: {
            [PART_FRAME_NOTE_KEY]: {
              phase: 'begin',
              index: outputIndex,
              part: openPartToStream(open),
            },
          },
        });
        return;
      }

      case 'response.output_text.delta': {
        const delta = str(payload['delta']);
        if (delta === undefined || delta === '') return;
        const open = state.openParts.get(outputIndex);
        if (open !== undefined) open.text += delta;
        yield this.makeFrame('delta', ctx, { kind: 'chat', index: outputIndex, text: delta });
        return;
      }

      case 'response.output_text.done': {
        const open = state.openParts.get(outputIndex);
        state.openParts.delete(outputIndex);
        yield this.makeFrame('meta', ctx, {
          notes: {
            [PART_FRAME_NOTE_KEY]: {
              phase: 'end',
              index: outputIndex,
              part: { type: 'text', text: open?.text ?? str(payload['text']) ?? '' },
            },
          },
        });
        return;
      }

      case 'response.reasoning_text.delta': {
        const delta = str(payload['delta']);
        if (delta === undefined || delta === '') return;
        const open = state.openParts.get(outputIndex);
        if (open !== undefined) open.text += delta;
        yield this.makeFrame('delta', ctx, { kind: 'chat', index: outputIndex, thinking: delta });
        return;
      }

      case 'response.reasoning_text.done': {
        const open = state.openParts.get(outputIndex);
        state.openParts.delete(outputIndex);
        yield this.makeFrame('meta', ctx, {
          notes: {
            [PART_FRAME_NOTE_KEY]: {
              phase: 'end',
              index: outputIndex,
              part: { type: 'thinking', thinking: open?.text ?? str(payload['text']) ?? '' },
            },
          },
        });
        return;
      }

      case 'response.function_call_arguments.delta': {
        const delta = str(payload['delta']);
        if (delta === undefined || delta === '') return;
        const open = state.openParts.get(outputIndex);
        if (open !== undefined) open.args += delta;
        // D2（42 §4.3）：带 `tool_call_id` = wire 的 `item_id`——没有 item 标识时并行
        // 工具调用无法归位（part 序号不是 item 标识）。
        yield this.makeFrame('delta', ctx, {
          kind: 'chat',
          index: outputIndex,
          tool_input_json: delta,
          ...(itemId === undefined ? {} : { tool_call_id: itemId }),
        });
        return;
      }

      case 'response.function_call_arguments.done': {
        const open = state.openParts.get(outputIndex);
        state.openParts.delete(outputIndex);
        const args = str(payload['arguments']) ?? open?.args ?? '';
        yield this.makeFrame('meta', ctx, {
          notes: {
            [PART_FRAME_NOTE_KEY]: {
              phase: 'end',
              index: outputIndex,
              part: {
                type: 'tool_use',
                // 与 decodeItem 的同款收窄：id 取 call_id（回传引用的就是它），
                // item 的 `id` 由 openPartToStream 的 finalItem 分支保留。
                id: open?.callId ?? open?.itemId ?? itemId ?? '',
                name: open?.name ?? '',
                input: parseToolInput(args),
                raw_arguments: args,
              },
            },
          },
        });
        return;
      }

      case 'response.custom_tool_call_input.delta': {
        const delta = str(payload['delta']);
        if (delta === undefined || delta === '') return;
        const open = state.openParts.get(outputIndex);
        if (open !== undefined) open.args += delta;
        yield this.makeFrame('delta', ctx, {
          kind: 'chat',
          index: outputIndex,
          tool_input_json: delta,
          ...(itemId === undefined ? {} : { tool_call_id: itemId }),
        });
        return;
      }

      case 'response.custom_tool_call_input.done': {
        const open = state.openParts.get(outputIndex);
        state.openParts.delete(outputIndex);
        yield this.makeFrame('meta', ctx, {
          notes: {
            [PART_FRAME_NOTE_KEY]: {
              phase: 'end',
              index: outputIndex,
              part: { type: 'unknown', raw_type: 'custom_tool_call', raw: open?.raw ?? {} },
            },
          },
        });
        return;
      }

      case 'response.output_item.done': {
        if (itemId !== undefined) state.indexByItemId.set(itemId, outputIndex);
        // 只有**还开着**的 part 才需要这里收尾：`output_text.done` /
        // `function_call_arguments.done` 已经关掉的，这里再发一次 part.end 就是重复。
        // 已关的事件搭 meta 帧原样保留（不许静默丢）。
        const open = state.openParts.get(outputIndex);
        if (open === undefined) {
          yield this.passthroughFrame(ctx, type, payload);
          return;
        }
        state.openParts.delete(outputIndex);
        yield this.makeFrame('meta', ctx, {
          notes: {
            [PART_FRAME_NOTE_KEY]: {
              phase: 'end',
              index: outputIndex,
              part: openPartToStream(open),
            },
          },
        });
        return;
      }

      case 'response.completed':
      case 'response.incomplete': {
        state.terminalSeen = true;
        const status = type === 'response.completed' ? 'completed' : 'incomplete';
        yield* this.flushOpenParts(ctx, state.openParts, response);
        const hasUsage = response !== undefined && response['usage'] !== undefined;
        const usage = hasUsage ? this.buildUsage(response?.['usage'], state.warnings) : undefined;
        if (usage !== undefined) state.onUsage(usage);
        // 42 §4.5：usage 在前、end 在末；**没有 `data: [DONE]`**
        if (usage !== undefined) yield this.makeFrame('usage', ctx, { usage });
        yield this.makeFrame('end', ctx, {
          finish_reason: this.normalizeFinishReason({
            status,
            ...(asRecord(response?.['incomplete_details']) === undefined
              ? {}
              : { incomplete_details: asRecord(response?.['incomplete_details']) }),
          }),
          ...(usage === undefined ? {} : { usage }),
          output: { [RAW_FINISH_REASON_KEY]: status },
        });
        return;
      }

      case 'response.failed': {
        state.terminalSeen = true;
        yield* this.flushOpenParts(ctx, state.openParts, response);
        // 42 §4.5 末行：`response.failed` 是 **HTTP 200** 的事件，不能按状态码当成功。
        const error = asRecord(response?.['error']);
        const code = error === undefined ? undefined : str(error['code']);
        const message =
          (error === undefined ? undefined : str(error['message'])) ?? 'upstream stream failed';
        yield this.makeFrame('error', ctx, {
          error: {
            code: 'upstream_error',
            message,
            ...(code === undefined ? {} : { provider_code: code }),
            http_status: 502,
            retryable: false,
            request_id: ctx.request_id,
            raw: response ?? payload,
          },
          fatal: true,
        });
        return;
      }

      default: {
        // `response.in_progress` / `response.content_part.added` /
        // `response.web_search_call.*` / 未知事件类型：42 §4.5 对 `response.in_progress`
        // 给的备选是「丢弃（记 dropped）或 meta」，这里统一选 meta——静默丢会破坏
        // 40 §1.5 第 6 条的流式事件序列等价断言。
        if (type !== 'response.in_progress') {
          state.warnings.push(`unknown_stream_event:${type}`);
          ctx.warn(`unknown_stream_event:${type}`);
          this.logger?.warn('openai.responses: 未建模的流式事件，搭 meta 帧透传', { event: type });
        }
        yield this.passthroughFrame(ctx, type, payload);
        return;
      }
    }
  }

  /** 给所有未收尾的 part 发 part.end（meta 帧带完整 part）。 */
  private *flushOpenParts(
    ctx: RequestContext,
    openParts: Map<number, OpenPart>,
    response: Record<string, unknown> | undefined,
  ): Generator<StreamFrame> {
    for (const [index, open] of [...openParts.entries()].sort((a, b) => a[0] - b[0])) {
      // 终事件带完整 `response.output` 时优先用它（那才是上游认定的最终形态）
      const finalItem = asArray(response?.['output'])?.[index];
      const item = asRecord(finalItem) ?? open.raw;
      yield this.makeFrame('meta', ctx, {
        notes: {
          [PART_FRAME_NOTE_KEY]: { phase: 'end', index, part: openPartToStream(open, item) },
        },
      });
    }
    openParts.clear();
  }

  /** 构造「原样搭车」的 meta 帧（回写时按原事件名还原）。 */
  private passthroughFrame(
    ctx: RequestContext,
    type: string,
    payload: Record<string, unknown>,
  ): StreamFrame {
    return this.makeFrame('meta', ctx, {
      notes: { [PASSTHROUGH_FRAME_NOTE_KEY]: { event: type, data: payload } },
    });
  }

  /** 构造 StreamFrame：seq 单调递增、ts 来自注入的 Clock（禁止 Date.now()）。 */
  private makeFrame(
    event: StreamFrame['event'],
    ctx: RequestContext,
    data: StreamFrame['data'],
  ): StreamFrame {
    const seq = this.seqCounter;
    this.seqCounter += 1;
    return { event, seq, request_id: ctx.request_id, kind: MODALITY, data, ts: this.clock.now() };
  }

  // ===========================================================================
  // 流式：canonical → wire（canonical → 客户端格式，20 §S8）
  // ===========================================================================

  /**
   * canonical 帧 → Responses 的语义 SSE 事件序列。
   *
   * ⚠️ **调用约定**：S8（gateway-core/pipeline/stages/s8-client-encode.ts）是**按事件**
   * 调用本方法——每个 `CanonicalStreamEvent` 单独过一次 `encodeStream`。因此本方法
   * **不能**把跨帧状态放在局部变量里（那会让每个事件都从零开始，`sequence_number`
   * 归零、`output[]` 丢内容），全部收进 `ctx.state` 的累加器（`ResponsesStreamState`）。
   * 这也是 openai-chat / anthropic-messages 两个 codec 的做法：它们的 encodeStream
   * 本身就是无状态的，Responses 因为要重建 `response.completed` 的完整 `response`
   * 对象而必须累积，于是显式用一个 ctx 级累加器。
   */
  async *encodeStream(
    frames: AsyncIterable<StreamFrame>,
    ctx: RequestContext,
  ): AsyncIterable<unknown> {
    const st = this.streamState(ctx);
    for await (const frame of frames) {
      // `start` 帧永远放行：它会把累加器清零并开一条新流（见 encodeStreamFrame 的
      // start 分支）。其余帧在终事件之后一律忽略—— Responses 的终事件就是流的终止，
      // 没有 `[DONE]` 之后的追加内容。
      if (st.terminal && frame.event !== 'start') continue;
      yield* this.encodeStreamFrame(frame, ctx, st);
    }
  }

  /** 取（或建）本请求的流式累加器。 */
  private streamState(ctx: RequestContext): ResponsesStreamState {
    const existing = ctx.state[STREAM_STATE_KEY];
    if (existing !== undefined) return existing as ResponsesStreamState;
    const fresh: ResponsesStreamState = {
      seq: 0,
      model: '',
      created: false,
      open: new Set(),
      outputIndices: new Map(),
      nextOutputIndex: 0,
      itemIds: new Map(),
      textBuf: new Map(),
      items: [],
      terminal: false,
      responseId: `resp-${ctx.request_id}`,
      createdAt: Math.floor(this.clock.now() / 1000),
      next: () => {
        const v = fresh.seq;
        fresh.seq += 1;
        return v;
      },
    };
    ctx.state[STREAM_STATE_KEY] = fresh;
    return fresh;
  }

  /** 清零累加器（保留对象标识：`ctx.state` 里存的就是这一个）。 */
  private resetStreamState(st: ResponsesStreamState, ctx: RequestContext): void {
    st.seq = 0;
    st.model = '';
    st.created = false;
    st.open = new Set();
    st.outputIndices = new Map();
    st.nextOutputIndex = 0;
    st.itemIds = new Map();
    st.textBuf = new Map();
    st.items = [];
    st.terminal = false;
    st.usage = undefined;
    st.responseId = `resp-${ctx.request_id}`;
    st.createdAt = Math.floor(this.clock.now() / 1000);
  }

  /** 单帧 → 0..n 条 SSE 事件。 */
  private *encodeStreamFrame(
    frame: StreamFrame,
    ctx: RequestContext,
    st: ResponsesStreamState,
  ): Generator<unknown> {
    switch (frame.event) {
      case 'start': {
        const data = frame.data as { model?: string; session_id?: string };
        // 一个 start 帧 = **一条新响应流**的开始：先把累加器清零。
        // 同一个 RequestContext 被复用是可能的（测试里共用一个 ctx；将来一次请求里跑
        // 多条流也是）——不清零的话上一流的 `terminal` 标志会让这一流被整条当成
        // 「已结束」而丢掉。
        this.resetStreamState(st, ctx);
        st.model = data.model ?? '';
        st.created = true;
        yield this.createdEvent(st, data.session_id);
        return;
      }

      case 'delta': {
        const data = frame.data as {
          kind?: string;
          index?: number;
          text?: string;
          thinking?: string;
          tool_input_json?: string;
          refusal?: string;
          tool_call_id?: string;
          part?: StreamPart;
          phase?: 'begin' | 'end';
        };
        if (data.kind !== 'chat') return;
        const index = data.index ?? 0;

        if (data.part !== undefined) {
          const isBegin = data.phase === 'begin' || (data.phase === undefined && !st.open.has(index));
          if (isBegin) {
            if (st.open.has(index)) {
              // 若同一 index 上先前有未收尾的文本/思考 item（如 openai.chat 先推文本再推 index=0 的 tool_call），先收尾再开新 item
              yield* this.endBufferedItem(st, index);
            }
            yield* this.beginItem(st, index, data.part);
          } else {
            yield* this.endItem(st, index, data.part);
          }
          return;
        }

        if (data.tool_input_json !== undefined) {
          // 工具参数增量：item_id 优先用 D2 的 tool_call_id，其次 part.begin 登记的映射
          const itemId = data.tool_call_id ?? st.itemIds.get(index) ?? '';
          const outputIndex = st.outputIndices.get(index) ?? index;
          yield sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            sequence_number: st.next(),
            item_id: itemId,
            output_index: outputIndex,
            delta: data.tool_input_json,
          });
          return;
        }
        if (data.thinking !== undefined) {
          yield* this.openTextLike(st, index, 'thinking');
          st.textBuf.set(index, (st.textBuf.get(index) ?? '') + data.thinking);
          const outputIndex = st.outputIndices.get(index) ?? index;
          yield sseEvent('response.reasoning_text.delta', {
            type: 'response.reasoning_text.delta',
            sequence_number: st.next(),
            item_id: st.itemIds.get(index) ?? '',
            output_index: outputIndex,
            delta: data.thinking,
          });
          return;
        }
        if (data.refusal !== undefined) {
          // Responses 没有流式 refusal 增量事件（42 §4.5 折叠表里没有这一行）——
          // 不猜一个事件名，也不静默丢：记录下来，由 part.end / 终事件的完整载荷表达。
          ctx.warn('stream_refusal_delta_unsupported');
          return;
        }
        if (data.text !== undefined && data.text !== '') {
          // 上游（如 openai-chat）的 decodeStream 不给文本 part 发 part.begin，
          // 这里**惰性开户**：Responses 的协议要求 item 先 added 才有 delta。
          yield* this.openTextLike(st, index, 'text');
          st.textBuf.set(index, (st.textBuf.get(index) ?? '') + data.text);
          const outputIndex = st.outputIndices.get(index) ?? index;
          yield sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            sequence_number: st.next(),
            item_id: st.itemIds.get(index) ?? '',
            output_index: outputIndex,
            content_index: 0,
            delta: data.text,
          });
        }
        return;
      }

      case 'meta': {
        const notes = (frame.data as { notes?: Record<string, unknown> }).notes ?? {};
        const passthrough = asRecord(notes[PASSTHROUGH_FRAME_NOTE_KEY]);
        if (passthrough !== undefined) {
          const name = str(passthrough['event']);
          // 自己合成出来的事件不重复写（见 SELF_SYNTHESIZED_EVENTS 的注释）
          if (name === undefined || SELF_SYNTHESIZED_EVENTS.has(name)) return;
          yield sseEvent(name, {
            ...(asRecord(passthrough['data']) ?? {}),
            sequence_number: st.next(),
          });
          return;
        }
        const note = asRecord(notes[PART_FRAME_NOTE_KEY]);
        if (note === undefined) return;
        const phase = note['phase'];
        const index = typeof note['index'] === 'number' ? (note['index'] as number) : 0;
        const part = note['part'] as StreamPart | undefined;
        if (part === undefined) return;

        if (phase === 'begin') {
          if (st.open.has(index)) return; // 幂等：同 index 重复 begin 不重复发
          yield* this.beginItem(st, index, part);
          return;
        }
        yield* this.endItem(st, index, part);
        return;
      }

      case 'usage': {
        const data = frame.data as { usage?: CanonicalUsage };
        if (data.usage !== undefined) st.usage = data.usage;
        // Responses 没有独立的 usage 事件：usage 恒搭终事件（40 §2.3「恒带」）。
        return;
      }

      case 'end': {
        const data = frame.data as { finish_reason?: string; usage?: CanonicalUsage };
        if (data.usage !== undefined) st.usage = data.usage;
        // 先把还开着的文本/思考 item 收尾（上游没给 part.end 的那一类）
        for (const index of [...st.open].sort((a, b) => a - b)) {
          yield* this.endBufferedItem(st, index);
        }
        yield* this.terminalEvent(st, data.finish_reason);
        return;
      }

      case 'error': {
        const data = frame.data as { error?: { message?: string; code?: string } };
        yield sseEvent('response.failed', {
          type: 'response.failed',
          sequence_number: st.next(),
          response: {
            id: st.responseId,
            object: 'response',
            created_at: st.createdAt,
            status: 'failed',
            error: {
              code: data.error?.code ?? 'server_error',
              message: data.error?.message ?? 'upstream stream failed',
            },
            output: st.items,
            usage: null,
          },
        });
        st.terminal = true;
        return;
      }
    }
  }

  /** `response.created`（幂等：只发一次）。 */
  private createdEvent(st: ResponsesStreamState, sessionId?: string): string {
    return sseEvent('response.created', {
      type: 'response.created',
      sequence_number: st.next(),
      response: {
        id: sessionId ?? st.responseId,
        object: 'response',
        created_at: st.createdAt,
        status: 'in_progress',
        model: st.model,
        output: [],
        usage: null,
      },
    });
  }

  /** 惰性开户：文本 / 思考增量到达时补 `output_item.added` + `content_part.added`。 */
  private *openTextLike(
    st: ResponsesStreamState,
    index: number,
    kind: 'text' | 'thinking',
  ): Generator<unknown> {
    if (st.open.has(index)) return;
    const outputIndex = st.nextOutputIndex++;
    const itemId = kind === 'thinking' ? `rs-${outputIndex}` : `msg-${outputIndex}`;
    st.open.add(index);
    st.outputIndices.set(index, outputIndex);
    st.itemIds.set(index, itemId);
    st.textBuf.set(index, '');
    yield sseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: st.next(),
      output_index: outputIndex,
      item: {
        type: kind === 'thinking' ? 'reasoning' : 'message',
        id: itemId,
        role: 'assistant',
        ...(kind === 'thinking' ? { summary: [], content: [] } : { content: [] }),
        status: 'in_progress',
      },
    });
    yield sseEvent('response.content_part.added', {
      type: 'response.content_part.added',
      sequence_number: st.next(),
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part:
        kind === 'thinking'
          ? { type: 'reasoning_text', text: '' }
          : { type: 'output_text', text: '', annotations: [] },
    });
  }

  /** part.begin → `response.output_item.added`（+ message/reasoning 的 content_part.added）。 */
  private *beginItem(
    st: ResponsesStreamState,
    index: number,
    part: StreamPart,
  ): Generator<unknown> {
    const outputIndex = st.nextOutputIndex++;
    const itemId = synthItemId(part, outputIndex);
    st.open.add(index);
    st.outputIndices.set(index, outputIndex);
    st.itemIds.set(index, itemId);
    st.textBuf.set(index, part.type === 'tool_use' ? '' : streamPartText(part));

    if (part.type === 'tool_use') {
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: st.next(),
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: itemId,
          call_id: itemId,
          name: part.name,
          arguments: '',
          status: 'in_progress',
        },
      });
      return;
    }
    if (part.type === 'thinking') {
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: st.next(),
        output_index: outputIndex,
        item: { type: 'reasoning', id: itemId, summary: [], content: [], status: 'in_progress' },
      });
      return;
    }
    if (part.type === 'unknown') {
      yield sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: st.next(),
        output_index: outputIndex,
        item: {
          ...(asRecord(part.raw) ?? {}),
          type: part.raw_type ?? 'unknown',
          status: 'in_progress',
        },
      });
      return;
    }
    // text / refusal：message item + 第一个 content part
    yield sseEvent('response.output_item.added', {
      type: 'response.output_item.added',
      sequence_number: st.next(),
      output_index: outputIndex,
      item: { type: 'message', id: itemId, role: 'assistant', content: [], status: 'in_progress' },
    });
    yield sseEvent('response.content_part.added', {
      type: 'response.content_part.added',
      sequence_number: st.next(),
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part:
        part.type === 'refusal'
          ? { type: 'refusal', refusal: '' }
          : { type: 'output_text', text: '', annotations: [] },
    });
  }

  /** part.end → 该 item 类型的 `.done` 事件 + `response.output_item.done`。 */
  private *endItem(st: ResponsesStreamState, index: number, part: StreamPart): Generator<unknown> {
    const outputIndex = st.outputIndices.get(index) ?? index;
    st.open.delete(index);
    st.textBuf.delete(index);
    const itemId = st.itemIds.get(index) ?? synthItemId(part, outputIndex);
    st.itemIds.set(index, itemId);
    // **按发出顺序求值** sequence_number：数组字面量里先写的先求值，因此不能把
    // `response.output_item.done` 提前构造成变量——那会让它拿到更小的序号（42 §2.1）。
    if (part.type === 'tool_use') {
      yield sseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        sequence_number: st.next(),
        item_id: itemId,
        output_index: outputIndex,
        arguments: part.raw_arguments ?? JSON.stringify(part.input ?? {}),
      });
      st.items.push(streamPartToOutputItem(part, itemId));
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: st.next(),
        output_index: outputIndex,
        item: streamPartToOutputItem(part, itemId),
      });
      return;
    }
    if (part.type === 'thinking') {
      yield sseEvent('response.reasoning_text.done', {
        type: 'response.reasoning_text.done',
        sequence_number: st.next(),
        item_id: itemId,
        output_index: outputIndex,
        text: part.thinking,
      });
      st.items.push(streamPartToOutputItem(part, itemId));
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: st.next(),
        output_index: outputIndex,
        item: streamPartToOutputItem(part, itemId),
      });
      return;
    }
    if (part.type === 'refusal' || part.type === 'text') {
      const doneName =
        part.type === 'refusal' ? 'response.refusal.done' : 'response.output_text.done';
      yield sseEvent(doneName, {
        type: doneName,
        sequence_number: st.next(),
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text: part.type === 'refusal' ? part.reason : part.text,
      });
      st.items.push(streamPartToOutputItem(part, itemId));
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: st.next(),
        output_index: outputIndex,
        item: streamPartToOutputItem(part, itemId),
      });
      return;
    }
    st.items.push(streamPartToOutputItem(part, itemId));
    yield sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: st.next(),
      output_index: outputIndex,
      item: streamPartToOutputItem(part, itemId),
    });
  }

  /** 终事件前收尾「惰性开户但没等到 part.end」的文本/思考 item。 */
  private *endBufferedItem(st: ResponsesStreamState, index: number): Generator<unknown> {
    const outputIndex = st.outputIndices.get(index) ?? index;
    const itemId = st.itemIds.get(index) ?? `msg-${outputIndex}`;
    const kind = itemId.startsWith('rs-') ? 'thinking' : 'text';
    const text = st.textBuf.get(index) ?? '';
    st.open.delete(index);
    st.textBuf.delete(index);
    const doneName =
      kind === 'thinking' ? 'response.reasoning_text.done' : 'response.output_text.done';
    yield sseEvent(doneName, {
      type: doneName,
      sequence_number: st.next(),
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    const item =
      kind === 'thinking'
        ? {
            type: 'reasoning',
            id: itemId,
            content: [{ type: 'reasoning_text', text }],
            status: 'completed',
          }
        : {
            type: 'message',
            id: itemId,
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
            status: 'completed',
          };
    st.items.push(item);
    yield sseEvent('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: st.next(),
      output_index: outputIndex,
      item,
    });
  }

  /**
   * 终事件：`response.completed` / `response.incomplete` / `response.failed`。
   *
   * 42 §4.5 末行：**没有 `data: [DONE]` 哨兵**——终事件就是流的终止，它自己带 usage。
   */
  private *terminalEvent(
    st: ResponsesStreamState,
    finishReason: string | undefined,
  ): Generator<unknown> {
    const status =
      finishReason === 'error'
        ? 'failed'
        : finishReason === 'length' || finishReason === 'content_filter'
          ? 'incomplete'
          : 'completed';
    const response: Record<string, unknown> = {
      id: st.responseId,
      object: 'response',
      created_at: st.createdAt,
      status,
      model: st.model,
      output: st.items,
      usage: null,
    };
    if (status === 'incomplete') {
      const reason = CANONICAL_TO_INCOMPLETE_REASON[finishReason as NormalizedFinishReason];
      response['incomplete_details'] = { reason: reason ?? 'other' };
    }
    const tokens = st.usage?.units.tokens;
    if (tokens !== undefined) {
      response['usage'] = this.encodeUsage(tokens, st.usage?.raw);
    }
    yield sseEvent(`response.${status}`, {
      type: `response.${status}`,
      sequence_number: st.next(),
      response,
    });
    st.terminal = true;
  }

  // ===========================================================================
  // 公共小能力（40 §1.1 的 8 个必需方法里剩下的两个）
  // ===========================================================================

  /**
   * 从响应体里抽 usage（S6 fast path 用）。
   *
   * 与 decodeResponse 共用 `buildUsage`，保证快慢路径口径一致（40 §2.1 只保留一份表）。
   * 同时接受「整个响应体」与终事件的 `{response:{usage}}` 两种形态（40 §2.3：
   * Responses 的 usage 恒搭终事件 `response.completed` 的 `response.usage`）。
   */
  extractUsage(raw: unknown): CanonicalUsage {
    const obj = asRecord(raw);
    if (obj === undefined) return { units: {}, source: 'provider' };
    const nested = asRecord(obj['usage']) ?? asRecord(asRecord(obj['response'])?.['usage']);
    if (nested !== undefined) return this.buildUsage(nested, []);
    // 也接受「裸 usage 对象」（嗅探器直接把 usage 传进来的情形）
    if ('input_tokens' in obj || 'output_tokens' in obj || 'total_tokens' in obj) {
      return this.buildUsage(obj, []);
    }
    return { units: {}, source: 'provider' };
  }

  /**
   * finish_reason 归一（10 §9.3 的 Responses 列）。
   *
   * 入参**三者都收**：`status` 字符串、`incomplete_details.reason` 字符串、
   * 或响应/终事件对象（此时读 `status` + `incomplete_details.reason`）。
   * 未命中 → `"other"`，**绝不默认 stop**（注意 2）。
   */
  normalizeFinishReason(raw: unknown): NormalizedFinishReason {
    if (typeof raw === 'string') return FINISH_REASON_TO_CANONICAL[raw] ?? 'other';
    const obj = asRecord(raw);
    if (obj === undefined) return 'other';
    const status = str(obj['status']);
    if (status === 'failed') return 'error';
    if (status === 'completed') return 'stop';
    if (status === 'incomplete') {
      const reason = str(asRecord(obj['incomplete_details'])?.['reason']);
      if (reason !== undefined) return FINISH_REASON_TO_CANONICAL[reason] ?? 'other';
      return 'other';
    }
    if (status === undefined) return 'other';
    return FINISH_REASON_TO_CANONICAL[status] ?? 'other';
  }

  // ===========================================================================
  // D-fastpath-1：S1 惰性解码（只解析路由必需集，不物化 input/tools）
  // ===========================================================================

  decodeEnvelope(raw: unknown, ctx: RequestContext): RequestEnvelopeShallow {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error(
        'OpenAI Responses 请求体不是 JSON object（S1 浅解析阶段即失败，避免无谓解码）',
      );
    }
    // 有状态参数已在 `MODELLED_REQUEST_KEYS` 里，因此不会进 unmapped——它们的权威处置在
    // decode() 里显式拒（42 §4.4）。浅解析阶段放行只会让 fast path 把字节原样透传。
    const unmapped = collectUnmapped(obj, MODELLED_REQUEST_KEYS);
    const agenticLoop = obj['ag_agentic_loop'] === true;
    return {
      source_format: FORMAT,
      kind: MODALITY,
      model: typeof obj['model'] === 'string' ? (obj['model'] as string) : '',
      stream: obj['stream'] === true,
      // bytes：S0 已经量过真实字节数（ctx.request_bytes，s0-ingress.ts），优先用它；
      // 直调 codec（测试/工具）没有该字段时才退回复传序列化的紧凑长度。
      bytes: ctx.request_bytes ?? Buffer.byteLength(JSON.stringify(obj), 'utf8'),
      // usage 位置提示（fast path 嗅探器用）：非流式在响应体顶层；流式在终事件的
      // `response.usage`（40 §2.3：恒带）。
      usage_locations: ['$.usage', '$.response.usage'],
      ...(agenticLoop ? { gateway_agentic_loop: true } : {}),
      ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
      default_path: DEFAULT_PATH,
    };
  }
}

// =============================================================================
// 模块级纯函数（无状态、无副作用，便于单测）
// =============================================================================

/** canonical 内置工具名 → Responses 的 wire 工具类型（42 §4.1 的工具行反向）。 */
const BUILTIN_TOOL_WIRE_TYPE: Record<BuiltinTool['name'], string> = {
  web_search: 'web_search',
  url_context: 'web_search',
  code_interpreter: 'code_interpreter',
  file_search: 'file_search',
};

/** 该字符串是否是 canonical 认得的内置工具稳定名（闭集联合的类型守卫）。 */
function isBuiltinToolName(value: string): value is BuiltinTool['name'] {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_WIRE_TYPE, value);
}

/** canonical 稳定名 → wire 工具类型（认不出返回 undefined）。 */
function builtinToolWireType(name: string): string | undefined {
  return isBuiltinToolName(name) ? BUILTIN_TOOL_WIRE_TYPE[name] : undefined;
}

/** Responses usage 对象的键集合（`isResponsesUsageShape` 的判据）。 */
const RESPONSES_USAGE_KEYS: ReadonlySet<string> = new Set([
  'input_tokens',
  'input_tokens_details',
  'output_tokens',
  'output_tokens_details',
  'total_tokens',
  'server_tool_use',
]);

/** 这个 usage 对象是否是 Responses 的形状（每个键都认得才算）。 */
function isResponsesUsageShape(raw: Record<string, unknown>): boolean {
  const keys = Object.keys(raw);
  return keys.length > 0 && keys.every((k) => RESPONSES_USAGE_KEYS.has(k));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** content（string | block[]）→ 纯文本（system block 与 tool_result 共用）。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = asRecord(block);
      return b !== undefined && typeof b['text'] === 'string' ? (b['text'] as string) : '';
    })
    .join('');
}

/** `reasoning` item 的 content[] → 纯文本（42 §4.2：只支持纯文本 content）。 */
function reasoningTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = asRecord(block);
      return b !== undefined && typeof b['text'] === 'string' ? (b['text'] as string) : '';
    })
    .join('');
}

/** 一组 part 里的 thinking 文本（回写 `reasoning` item 用）。 */
function thinkingTextOf(parts: Part[]): string {
  return parts
    .filter((p): p is ThinkingPart => p.type === 'thinking')
    .map((p) => p.thinking)
    .join('');
}

/**
 * `annotations[]` → `SearchResultPart[]`（42 §4.4：引用按 10 §9.2 落 SearchResultPart）。
 *
 * 原文整条进 `_raw`，回写时原样还原成 `annotations`——canonical 的 SearchResultPart
 * 没有 `start_index` / `end_index` 这类字段，节点级还原是唯一不丢信息的路径。
 */
function decodeAnnotations(annotations: unknown): SearchResultPart[] {
  const out: SearchResultPart[] = [];
  for (const entry of asArray(annotations) ?? []) {
    const a = asRecord(entry);
    if (a === undefined) continue;
    out.push({
      type: 'search_result',
      source: 'openai.responses',
      title: str(a['title']) ?? '',
      url: str(a['url']) ?? '',
      snippet: str('snippet' in a ? a['snippet'] : a['text']) ?? '',
      _raw: a,
    });
  }
  return out;
}

/** data: URL → InlineMedia（拆 mime 与 base64，10 §5 三态）。 */
function inlineFromDataUrl(url: string, warnings: string[]): InlineMedia {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(url);
  if (match === null) {
    warnings.push('malformed_data_url');
    return { kind: 'inline', mime: 'application/octet-stream', data: '' };
  }
  const mime = match[1] === undefined || match[1] === '' ? 'application/octet-stream' : match[1];
  const payload = match[3] ?? '';
  if (match[2] === undefined) {
    // 非 base64 的 data: URL（percent-encoded）：不当成 base64 硬解，原样留数据
    warnings.push('data_url_not_base64');
    return { kind: 'inline', mime, data: payload };
  }
  return { kind: 'inline', mime, data: payload };
}

/** MediaRef → Responses 的 url 字符串（inline 还原成 data: URL）。 */
function mediaToUrl(source: MediaRef): string {
  if (source.kind === 'uri') return source.uri;
  if (source.kind === 'inline') return `data:${source.mime};base64,${source.data}`;
  return `asset://${source.asset_id}`;
}

/** 从 URL 猜 mime（只认常见图片扩展名；与 openai-chat 同款判据）。 */
function mimeFromUrl(url: string): string {
  const path = url.split('?')[0] ?? url;
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/** 尝试 JSON.parse；不抛（调用方决定怎么保留原串）。 */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 解析 tool arguments；失败 → `{}`（原串由调用方留在 raw_arguments，10 §7.3）。 */
function parseToolInput(argumentsText: string): Record<string, unknown> {
  if (argumentsText === '') return {};
  const parsed = tryParseJson(argumentsText);
  return parsed.ok ? (asRecord(parsed.value) ?? {}) : {};
}

/** 顶层未建模键收集（20 §S1「不允许丢字段」；10 §7 顶层 unmapped）。 */
function collectUnmapped(
  obj: Record<string, unknown>,
  modelled: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!modelled.includes(key)) out[key] = value;
  }
  return out;
}

/** 取对象里**未建模**的键（10 §7.2 第 2 条逐节点还原）。 */
function extrasOf(
  obj: Record<string, unknown>,
  modelled: readonly string[],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!modelled.includes(key)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 把 `_raw` 里**未建模**的键取出来（10 §7.2 第 2 条逐节点还原）。 */
function unmodelledFields(raw: unknown, modelled: readonly string[]): Record<string, unknown> {
  const obj = asRecord(raw);
  if (obj === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!modelled.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * 把引用挂回 content part 的 `annotations`（42 §4.4 反向）。
 *
 * 宿主是**最后一个** output_text / input_text block——单个 message item 通常只有一个
 * 文本块，多块时引用会归到最后一个（canonical 的 SearchResultPart 没有「属于哪个块」
 * 的字段，这是可表达的上限）。
 */
function attachAnnotations(content: unknown[], annotations: unknown[]): void {
  if (annotations.length === 0) return;
  const host = [...content].reverse().find((b) => {
    const rec = asRecord(b);
    return rec !== undefined && (rec['type'] === 'output_text' || rec['type'] === 'input_text');
  }) as Record<string, unknown> | undefined;
  if (host === undefined) {
    content.push({ type: 'output_text', text: '', annotations });
    return;
  }
  // 替换而不是追加（同 encodeOutputGroup 的理由：收集到的就是完整集合）
  host['annotations'] = annotations;
}

/** 累积中的 part → `StreamPart` 形状（与 ir/stream.ts 的 StreamPart 对齐）。 */
function openPartToStream(open: OpenPart, finalItem?: Record<string, unknown>): StreamPart {
  const item = finalItem ?? open.raw;
  switch (open.kind) {
    case 'tool_use':
      return {
        type: 'tool_use',
        id: str(item['call_id']) ?? str(item['id']) ?? open.itemId ?? '',
        name: str(item['name']) ?? open.name ?? '',
        input: parseToolInput(str(item['arguments']) ?? open.args),
        raw_arguments: str(item['arguments']) ?? open.args,
      };
    case 'thinking':
      return { type: 'thinking', thinking: reasoningTextOf(item['content']) || open.text };
    case 'unknown':
      return { type: 'unknown', raw_type: str(item['type']) ?? str(open.raw['type']), raw: item };
    default:
      return { type: 'text', text: contentToText(item['content']) || open.text };
  }
}

/** `StreamPart` 里已经累积的文本（text / thinking）。 */
function streamPartText(part: StreamPart): string {
  if (part.type === 'text') return part.text;
  if (part.type === 'thinking') return part.thinking;
  if (part.type === 'refusal') return part.reason;
  return '';
}

/** `StreamPart` → Responses 的 output item（`response.output_item.done` 用）。 */
function streamPartToOutputItem(part: StreamPart, itemId: string): Record<string, unknown> {
  switch (part.type) {
    case 'tool_use':
      return {
        type: 'function_call',
        id: itemId,
        call_id: itemId,
        name: part.name,
        arguments: part.raw_arguments ?? JSON.stringify(part.input ?? {}),
        status: 'completed',
      };
    case 'thinking':
      return {
        type: 'reasoning',
        id: itemId,
        content: [{ type: 'reasoning_text', text: part.thinking }],
        status: 'completed',
      };
    case 'refusal':
      return {
        type: 'message',
        id: itemId,
        role: 'assistant',
        content: [{ type: 'refusal', refusal: part.reason }],
        status: 'completed',
      };
    case 'unknown':
      return {
        ...(asRecord(part.raw) ?? {}),
        type: part.raw_type ?? 'unknown',
        status: 'completed',
      };
    default:
      return {
        type: 'message',
        id: itemId,
        role: 'assistant',
        content: [{ type: 'output_text', text: part.text, annotations: [] }],
        status: 'completed',
      };
  }
}

/** 给没有 id 的 part 合成一个稳定的 item_id（Responses 的 item 标识）。 */
function synthItemId(part: StreamPart, index: number): string {
  if (part.type === 'tool_use') return part.id || `fc-${index}`;
  if (part.type === 'unknown') {
    const rawId = str(asRecord(part.raw)?.['id']);
    if (rawId !== undefined) return rawId;
  }
  if (part.type === 'thinking') return `rs-${index}`;
  return `msg-${index}`;
}

/**
 * SSE 文本块 → `{name, payload}`。解析失败返回 undefined（不影响转发）。
 *
 * Responses 的流式是**语义 SSE 事件**（42 §2.1）：每个事件带 `event:` 行与
 * 单调递增的 `sequence_number`，**没有 `data: [DONE]` 哨兵**。
 */
function parseWireEvent(
  item: unknown,
): { name?: string; payload: Record<string, unknown> } | undefined {
  if (typeof item === 'string') {
    let name: string | undefined;
    const dataLines: string[] = [];
    for (const line of item.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return undefined;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join('\n'));
    } catch {
      return undefined;
    }
    const rec = asRecord(payload);
    if (rec === undefined) return undefined;
    return { ...(name === undefined ? {} : { name }), payload: rec };
  }
  if (Buffer.isBuffer(item)) return parseWireEvent(item.toString('utf8'));
  const rec = asRecord(item);
  if (rec === undefined) return undefined;
  const name = str(rec['type']) ?? str(rec['event']);
  return { ...(name === undefined ? {} : { name }), payload: rec };
}

/** 序列化一个 Responses SSE 事件（`event: <name>\ndata: <json>\n\n`）。 */
function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** AdaptorMeta 工厂（40 §1.3：显式登记，集中一处，不做魔法自动发现）。 */
export function openAIResponsesAdaptorMeta(): AdaptorMeta {
  return {
    format: FORMAT,
    modality: MODALITY,
    version: '1.0.0',
    fixtures: 'adaptors/fixtures/openai-responses/from-docs',
    unsupported_fields: [
      // 42 §4.4：明确暂不支持并**显式报错**的（不是静默 drop）
      'previous_response_id',
      'conversation',
      'background',
      'include',
      // 42 §4.3：Responses 专有、canonical 没有概念 → 走 raw.unmapped 透传
      'store',
      'truncation',
      'stream_options',
      'max_tool_calls',
      'safety_identifier',
      'prompt_cache_key',
      'prompt_cache_retention',
      'context_management',
      // canonical 有而 Responses 没有的采样参数（10 §9.1 的 Responses 列写「无」）
      'params.stop',
      'params.seed',
      'params.frequency_penalty',
      'params.presence_penalty',
      'params.n',
      'params.logprobs',
      'params.top_k',
      'params.safety',
      'params.thinking.budget_tokens',
      // item / content part 层面没有 canonical 对应概念的
      'parts.search_result',
    ],
    quirks: [
      'input 是 item 数组（或字符串），不是 messages[]；instructions 才是 system（42 §4.1）',
      '多 system：instructions 与 system/developer 角色 message item 共存时两条都进 payload.system[]，回写时分别还原成 instructions 与 message item',
      'function_call item 的 ToolUsePart.id 取 call_id（回传 function_call_output.call_id 引用的就是它）；item 的 id 由 _raw 节点级还原保留',
      'function_call.arguments 是 JSON 字符串，解析失败时 raw_arguments 保留原串（10 §7.3）',
      'tools[].type="function" 的字段不嵌套（name/description/parameters 在顶层），与 Chat 的 function:{...} 不同',
      'previous_response_id / conversation / background / include 在入口显式拒 capability_unsupported——网关不存上游 response 对象，静默忽略会给出没有历史的答案（42 §4.4）',
      'store:true 收下并记诊断，不执行存储（42 §4.4）',
      'output_text 的 annotations 落 SearchResultPart，回写时按 _raw 还原成 annotations',
      'usage 恒搭终事件 response.completed 的 response.usage，没有独立 usage 事件（40 §2.3）',
      '流式没有 data: [DONE] 哨兵；终事件是 response.completed / .incomplete / .failed，其中 .failed 是 HTTP 200（42 §4.5）',
      'response.in_progress / response.content_part.added / response.web_search_call.* 搭 meta 帧透传，不静默丢（42 §4.5 结论 1：不新增帧类型）',
      'output_tokens_details.safety_tokens（DeepSeek 扩展）只进 usage.raw 与 details，不加进 reasoning_tokens 也不加进 output_tokens（42 §4.6）',
      'server_tool_use 是按次单位不是 token，落 usage.units.requests（42 §4.6）',
      '夹具来自官方文档样本，未经真实上游验证（42 §5.2 的 from-docs/ 子目录约定）',
    ],
    status: 'implemented',
    supports_lazy_decode: true,
  };
}

export { PART_FRAME_NOTE_KEY, PASSTHROUGH_FRAME_NOTE_KEY, DEFAULT_PATH };
