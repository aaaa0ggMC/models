/**
 * adaptors/openai-chat/codec.ts —— OpenAI Chat Completions ↔ AG-IR canonical 双向 codec。
 *
 * 唯一事实来源：
 *   - docs/design/10-canonical-schema.md §4（chat payload）、§6.1（usage 规则）、
 *     §7（raw passthrough 两级）、§9.1/§9.2（字段映射表）、§9.3（finish_reason 归一表）
 *   - docs/design/40-provider-adaptors.md §1.1（Adaptor 接口）、§1.5（round-trip 测试模板）、
 *     §2.1（OpenAI Chat usage 口径表）、§2.2b（2026 协议变更）、§2.2c（I1–I4 硬不变量）、
 *     §2.3（流式 usage 位置）、§7.1（OpenAI 注意事项）
 *   - docs/design/20-pipeline.md §S1/S4/S6/S8、§4（fast path）
 *
 * **方向约定**（本文件每个函数的注释都注明）：
 *   - decode*       ：wire → canonical，即「客户端/上游格式 → canonical」
 *   - encode*       ：canonical → wire，即「canonical → 客户端/上游格式」
 *
 * 四条从真实缺陷里长出来的硬约束（逐条落地）：
 *   1. **多 system 不丢**：OpenAI 用 `messages[{role:"system"}]` 表达系统提示，llm-bridge
 *      只取第一条（40 §7.2 记录的真实缺陷）。本 codec 收集**全部** system/developer 消息
 *      进 `payload.system[]`，回写时每条 system block 产出**一个** messages 条目。
 *   2. **畸形 tool 参数不毁**：`JSON.parse(function.arguments)` 失败时 `input` 置 `{}`、
 *      `raw_arguments` 留原串（10 §4.2 D7 + §7.3）；回写时**优先用 `raw_arguments`**，
 *      绝不静默替换成 `JSON.stringify({})`。
 *   3. **未命中不得默认 stop**：finish_reason 归一表未命中 → `other` +
 *      `warnings += "unmapped_finish_reason:<原文>"`（10 §9.3 注意 2，反 LiteLLM 教训）。
 *   4. **一条 tool 消息 → N 条 wire 消息**：canonical 的 `tool` 消息可以带多个
 *      tool_result part（网关 agentic loop 把一轮的结果拼在一条消息里），而 OpenAI 要求
 *      「assistant 的每个 tool_call 各跟一条 role:'tool' 消息」。压成一条会让上游 400
 *      "insufficient tool messages following tool_calls message"——内置对话一调工具就炸。
 *
 * 依赖注入：`Clock` 由构造函数注入（ir/clock.ts 硬约束——禁止模块内 `Date.now()`，
 * 否则流式 ts、重试退避在测试里不可控）。无模块级单例、无 `process.env` 读取。
 */

import type {
  AudioPart,
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
  RefusalPart,
  RequestContext,
  ResponseFormat,
  StreamFrame,
  StreamPart,
  SystemBlock,
  TextPart,
  ThinkingConfig,
  ThinkingPart,
  ToolChoice,
  ToolResultPart,
  ToolUsePart,
  UnknownPart,
  UriMedia,
  VideoPart,
} from '../../ir/index.js';
import { CTX_STATE_KEYS, IR_VERSION } from '../../ir/index.js';
import type { Adaptor, AdaptorMeta, EncodedRequest, RequestEnvelopeShallow } from '../types.js';
import type { ProviderProfile, ProviderProfileRegistry } from '../../di/ports.js';

/** 本 codec 的格式 id、模态与默认端点（20 §S0 路径签名表）。 */
const FORMAT: FormatId = 'openai.chat';
const MODALITY: ModalityKind = 'chat';
const DEFAULT_PATH = '/v1/chat/completions';

/**
 * 请求侧「已建模」的顶层键集合。两个作用：
 *   1. decode 时把不在集合里的顶层键收进 `raw.unmapped`（20 §S1「不允许丢字段」）；
 *   2. decodeEnvelope 时廉价地收集同一批键（D-fastpath-1 的 `unmapped` 字段）。
 * 新增 wire 字段必须同时更新这里与下面的映射函数——40 §1.4 第 2 步明令禁止
 * 「第四类：忘了处理」。
 */
const MODELLED_REQUEST_KEYS: readonly string[] = [
  // 消息与工具
  'messages',
  'tools',
  'tool_choice',
  // 模型与采样参数
  'model',
  'max_tokens', // 旧名；2026 协议变更后由 max_completion_tokens 取代（40 §2.2b）
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'top_logprobs',
  'n',
  'user',
  'metadata',
  'service_tier',
  'parallel_tool_calls',
  // 结构化输出与推理
  'response_format',
  'reasoning_effort',
  // 流式
  'stream',
  'stream_options',
];

/** 响应侧「已建模」的顶层键集合（响应方向的同一机制）。 */
const MODELLED_RESPONSE_KEYS: readonly string[] = [
  'id',
  'object',
  'created',
  'model',
  'choices',
  'usage',
  'system_fingerprint',
  'service_tier',
];

/**
 * 消息级「已建模」的键。未建模的消息级键在回写时从 `_raw` 原样拷回
 * （10 §7.2 第 2 条「逐节点还原」）。
 */
const MODELLED_MESSAGE_KEYS: readonly string[] = [
  'role',
  'content',
  'tool_calls',
  'tool_call_id',
  'name',
  'refusal',
  // DeepSeek 思考内容的 wire 字段名（非流式 message / 流式 delta 都有）。
  // 建模它而不是走「未建模键原样拷回」：回写时要能区分「原文照抄」与
  // 「canonical thinking part 重新生成」，两者在跨格式转换时来源不同。
  'reasoning_content',
];

/** canonical 认得的消息角色（用于判断 wire 角色是否需要原样还原）。 */
const CANONICAL_ROLES: readonly string[] = ['user', 'assistant', 'system', 'tool'];

/** finish_reason 归一表（10 §9.3，OpenAI Chat 列）。未命中 → other，绝不默认 stop。 */
const FINISH_REASON_TO_CANONICAL: Record<string, NormalizedFinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_use',
  content_filter: 'content_filter',
  // 已弃用的 legacy 值：规范归入 other（10 §9.3 表格末行）
  function_call: 'other',
};

/** finish_reason 反向表（canonical → OpenAI Chat，10 §9.3 的逆映射）。 */
const CANONICAL_TO_FINISH_REASON: Partial<Record<NormalizedFinishReason, string>> = {
  stop: 'stop',
  length: 'length',
  tool_use: 'tool_calls',
  content_filter: 'content_filter',
  // OpenAI Chat 的 stop_sequence 与 stop 同值（§9.3 表格），反向只能落到 stop
  stop_sequence: 'stop',
};

/** OpenAI 流式 finish_reason 的原生取值（反向时优先用原文，见 encodeStreamFinishReason）。 */
const OPENAI_STREAM_FINISH_REASONS: readonly string[] = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
];

/**
 * 本 codec 认得的来源 provider 名（decode* 时写进 `raw.source_provider`）。
 *
 * `finish_reason_provider` 的**原样回写只在同格式时成立**：10 §7.2 回写规则第 1 条
 * 「整体还原」的前提就是 `source_provider === 目标格式`。跨格式时那个原文是**别家**的
 * 枚举值（Anthropic 的 `end_turn`、Gemini 的 `MAX_TOKENS`…），照抄进 OpenAI 响应就是
 * 一个非法 finish_reason——必须走 §9.3 的反查表。
 */
const PROVIDER_NAME = 'openai';

/**
 * 流式 end 帧的 `output` 里保存 finish_reason 原文的键（10 §9.3 注意 3：双向可逆）。
 *
 * 非流式走 `RawEnvelope.finish_reason_provider` 顶层一等字段（ir/envelope.ts）；
 * 流式的 `EndData.output` 是自由负载，只能内嵌一个同名键。
 */
const RAW_FINISH_REASON_KEY = 'finish_reason_provider';

/**
 * canonical 错误码 → OpenAI Chat 错误体的 `type`（20 §7.2 第二行：`retryable` 体现在 type 上）。
 * 只列会真实出现的；未列的一律落 `server_error`（保守：客户端会重试，而不是当成参数错误放弃）。
 */
const OPENAI_ERROR_TYPE_BY_CODE: Record<string, string> = {
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
 * **为什么用 meta 帧**：25 §2.1 的 `FrameData` 联合里没有 part.begin/part.end 的
 * 负载形状（`DeltaData` 只有 text/thinking/tool_input_json/refusal 四个槽），
 * 而 20 §S6 的折叠表要求「part.begin + N × part.delta{tool_input_json} + part.end」。
 * `MetaData.notes`（`Record<string, unknown>`）是唯一能带结构化负载又不污染内容
 * 增量流的位置，且 part 边界确实是「非内容性元信息」，故走 `event:"meta"`；
 * 参数分片本身仍是标准的 `delta{tool_input_json}` 帧。
 *
 * **形状与 anthropic-messages adaptor 对齐**（`{phase, index, part}`，见
 * adaptors/anthropic-messages/codec.ts 的 `PART_FRAME_NOTE_KEY`）——两个 chat adaptor
 * 产出同一种 meta 帧形状，插件/管道只需写一份解析。（这是 ir/stream.ts 类型与
 * 20 §S6 之间的缝隙，已报告给 lead，不在本文件私改 ir 类型。）
 */
const PART_FRAME_NOTE_KEY = 'openai.chat.part';
/**
 * finish_reason 在 `StreamFrame` 上的载体键。
 *
 * **为什么 finish_reason 也需要一个独立帧**：wire 里 `finish_reason` chunk 排在
 * usage chunk **之前**（OpenAI 的既定顺序：finish chunk → usage chunk → `[DONE]`），
 * 而 canonical 的 `end` 帧按 20 §S6 的定义是**终止帧**、只能出现在流尾（还要带上
 * 汇总 usage）。若只靠 end 帧承载 finish_reason，回写时 finish chunk 会被排到
 * usage chunk 之后，事件顺序与原文不符（round-trip 测试 F 会红）。
 * 因此 finish_reason 在它自己的 wire 位置上单独出一帧，end 帧仍然是流尾的汇总帧。
 */
const FINISH_FRAME_NOTE_KEY = 'openai.chat.finish';

/**
 * 两个 meta 载体键对外导出：测试要用，也方便其他 adaptor / 插件按同一形状解析
 * （anthropic-messages 用同样的 `{phase, index, part}` notes 形状）。
 */
export { PART_FRAME_NOTE_KEY, FINISH_FRAME_NOTE_KEY };

/** codec 构造依赖（横切能力全部注入，不用隐式全局）。 */
export interface OpenAIChatCodecDeps {
  clock: Clock;
  logger?: Logger;
  /**
   * provider profile 注册表（可选）。
   *
   * 注入后本 codec 在**按 access path 查到 profile** 时启用三类 provider 专有映射
   * （见 di/ports.ts 的 ProviderProfile）：
   *   1. 端点路径（DeepSeek 是 `/chat/completions` 而非 `/v1/chat/completions`）；
   *   2. builtin tool 的厂商专有形态（DeepSeek `deepseek_web_search` 等）；
   *   3. thinking 开关的厂商专有形态（DeepSeek `thinking:{type}` 对象）。
   * 查不到 profile（openai / mock 等）时行为与本文件历史版本完全一致——
   * 一个 codec 实例服务所有同 dialect 的 access path，provider 差异必须可插拔。
   */
  providerProfiles?: ProviderProfileRegistry;
}

/** 把一个 SSE chunk 序列折叠成 canonical 帧时的累加器。 */
interface StreamFoldState {
  /** start 帧是否已发（幂等：只发一次）。 */
  started: boolean;
  /** tool_call index → 累加中的参数片段。 */
  pendingTools: Map<number, { id?: string; name?: string; arguments: string }>;
  /** 已见过的 finish_reason **原文**（未归一化，用于 end 帧回写与告警）。 */
  lastFinishReasonRaw: string | undefined;
  /** 已见过的 usage（canonical 化之后，取最后一次非空，25 §8.3 规则 5）。 */
  lastUsage: CanonicalUsage | undefined;
  /** 本批次产生的 warning（进 end 帧的 output.warnings，不静默）。 */
  warnings: string[];
}

export class OpenAIChatCodec implements Adaptor {
  readonly format: FormatId = FORMAT;
  readonly modalities: ModalityKind[] = [MODALITY];

  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly providerProfiles: ProviderProfileRegistry | undefined;
  /** 实例内单调的帧序号（25 §2：从 0 开始；不放模块级，避免跨实例共享状态）。 */
  private seqCounter = 0;

  constructor(deps: OpenAIChatCodecDeps) {
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
      throw new Error('OpenAI Chat 请求体不是 JSON object（20 §S1：不允许丢字段，也无法猜）');
    }

    const warnings: string[] = [];
    const nodes: Record<string, unknown> = {};
    const system: SystemBlock[] = [];
    const messages: CanonicalMessage[] = [];

    const rawMessages = obj['messages'];
    if (Array.isArray(rawMessages)) {
      for (const entry of rawMessages) {
        const message = asRecord(entry);
        if (message === undefined) {
          // 消息条目不是 object：整条降级成 UnknownPart，**不抛**（20 §S1 前向兼容）
          messages.push({
            role: 'user',
            parts: [{ type: 'unknown', raw_type: 'message', raw: entry }],
            _raw: entry,
          });
          continue;
        }
        const role = typeof message['role'] === 'string' ? (message['role'] as string) : '';
        if (role === 'system' || role === 'developer') {
          // developer（o1+ 的新名字）折叠进 system（10 §4.1 注释）；原文进 _raw 供回写还原
          system.push({ text: contentToText(message['content']), _raw: message });
          continue;
        }
        messages.push(this.decodeMessage(message, warnings));
      }
    }

    const tools = this.decodeTools(obj, warnings, nodes, this.profileFor(ctx));
    const toolChoice = this.decodeToolChoice(obj, warnings, nodes);
    const params = this.decodeParams(obj, warnings);
    const stream = this.decodeStreamOptions(obj);
    const unmapped = collectUnmapped(obj, MODELLED_REQUEST_KEYS);

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

    // 网关扩展字段：`ag_agentic_loop` 是客户端侧的网关开关（20 §5.1 网关循环触发条件），
    // 映射进 canonical 的 `gateway` 命名空间（tool-loop.ts 的 A 档判据）。
    // 同时保留在 raw.unmapped 里——它仍是未建模的顶层键，回写要能原样写回（10 §7）。
    // `ag_max_turns` 是它的邻居：循环轮次上限（runner.ts 读 gateway.max_turns）。
    // 两者都不进 `MODELLED_REQUEST_KEYS`，因此回写仍走 unmapped 透传，round-trip 不变。
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

  /** 单条消息 → canonical。tool role 单独走 ToolResultPart（10 §4.2）。 */
  private decodeMessage(message: Record<string, unknown>, warnings: string[]): CanonicalMessage {
    const role = typeof message['role'] === 'string' ? (message['role'] as string) : '';

    if (role === 'tool') {
      const toolCallId =
        typeof message['tool_call_id'] === 'string' ? (message['tool_call_id'] as string) : '';
      const content = message['content'];
      const result: ToolResultPart = {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: typeof content === 'string' ? content : this.decodeParts(content, warnings),
      };
      return { role: 'tool', parts: [result], _raw: message };
    }

    if (!CANONICAL_ROLES.includes(role)) {
      // 角色不在 canonical 枚举里：落 user + 原文进 _raw（回写时按 _raw.role 还原，不猜）
      warnings.push(`unknown_message_role:${role === '' ? '<empty>' : role}`);
    }

    const parts: Part[] = this.decodeParts(message['content'], warnings);
    const refusal = message['refusal'];
    if (typeof refusal === 'string') {
      const refusalPart: RefusalPart = { type: 'refusal', reason: refusal };
      parts.push(refusalPart);
    }
    const toolCalls = message['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const toolUse = this.decodeToolCall(call);
        if (toolUse !== undefined) parts.push(toolUse);
      }
    }

    return {
      role: role === 'assistant' || role === 'system' ? role : 'user',
      parts,
      _raw: message,
    };
  }

  /**
   * content（string | block[] | null）→ Part[]。
   *
   * 未知 block 类型 → `UnknownPart{type:"unknown", raw_type, raw}`，**绝不抛**
   * （20 §S1：provider 新增 block 类型时网关不炸）。
   */
  private decodeParts(content: unknown, warnings: string[]): Part[] {
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
        case 'text': {
          const part: TextPart = {
            type: 'text',
            text: typeof b['text'] === 'string' ? (b['text'] as string) : '',
          };
          parts.push(part);
          break;
        }
        case 'image_url': {
          const inner = asRecord(b['image_url']);
          const url =
            inner !== undefined && typeof inner['url'] === 'string' ? (inner['url'] as string) : '';
          // data: URL → InlineMedia（拆 mime 与 base64）；否则 UriMedia（10 §5 三态）
          const source: MediaRef = url.startsWith('data:')
            ? inlineFromDataUrl(url, warnings)
            : ({ kind: 'uri', uri: url, mime: mimeFromUrl(url) } satisfies UriMedia);
          // 原 block 进 _raw：detail 等 OpenAI 专有字段在回写时逐节点还原（10 §7.2 第 2 条）
          const part: ImagePart = { type: 'image', source, _raw: b };
          parts.push(part);
          break;
        }
        case 'input_audio': {
          const inner = asRecord(b['input_audio']);
          const data =
            inner !== undefined && typeof inner['data'] === 'string'
              ? (inner['data'] as string)
              : '';
          const format =
            inner !== undefined && typeof inner['format'] === 'string'
              ? (inner['format'] as string)
              : '';
          const mime = format === '' ? 'audio/wav' : `audio/${format}`;
          const source: InlineMedia = { kind: 'inline', mime, data };
          const part: AudioPart = { type: 'audio', source, format: { mime } };
          parts.push(part);
          break;
        }
        default: {
          const part: UnknownPart = { type: 'unknown', raw_type: type, raw: block };
          parts.push(part);
          warnings.push(`unknown_part_type:${type === '' ? '<empty>' : type}`);
        }
      }
    }
    return parts;
  }

  /**
   * assistant.tool_calls[] → ToolUsePart（10 §4.2 D7 + §7.3）。
   *
   * `function.arguments` 是 JSON **字符串**：解析成功进 `input`（对象）；
   * 解析失败 `input` 置 `{}`、`raw_arguments` 留**原串**——llm-bridge 的真实缺陷是
   * 「存了 raw_arguments 但回写从不读它，畸形参数被静默替换成 {}」。
   */
  private decodeToolCall(call: unknown): ToolUsePart | undefined {
    const c = asRecord(call);
    if (c === undefined) return undefined;
    const fn = asRecord(c['function']);
    const id = typeof c['id'] === 'string' ? (c['id'] as string) : '';
    const name = fn !== undefined && typeof fn['name'] === 'string' ? (fn['name'] as string) : '';
    const argsRaw =
      fn !== undefined && typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : '';

    let input: Record<string, unknown> = {};
    let rawArguments: string | undefined;
    if (argsRaw !== '') {
      const parsed = tryParseJson(argsRaw);
      if (parsed.ok && asRecord(parsed.value) !== undefined) {
        input = asRecord(parsed.value) as Record<string, unknown>;
      } else {
        // 解析失败，或合法 JSON 但不是 object（如 "[]" / "3"）：input 退化为 {}，原串保留
        input = {};
        rawArguments = argsRaw;
        if (!parsed.ok) {
          this.logger?.warn(
            'openai.chat: tool_call arguments 不是合法 JSON，原串进 raw_arguments',
            {
              tool_call_id: id,
            },
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
      _raw: c,
    };
  }

  /**
   * tools[] → CanonicalTool[]（10 §9.1：`function.parameters` 原样透传）。
   *
   * 三种形态：
   *   1. `{type:"function", function:{...}}` → FunctionTool（OpenAI 本家标准形态）；
   *   2. **provider 专有 server tool**（如 DeepSeek 的 `deepseek_web_search` /
   *      `deepseek_read_url`，见 50-builtin-search.md §3.1 模式 A）→ BuiltinTool，
   *      厂商类型串进 `native.provider_tool_type`，canonical 名保持稳定名；
   *   3. 其它未建模类型 → raw.nodes 保留 + warning（不猜也不丢）。
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
      const fn = asRecord(t['function']);
      if (type === 'function' && fn !== undefined) {
        tools.push({
          type: 'function',
          name: typeof fn['name'] === 'string' ? (fn['name'] as string) : '', // privacy-scan: ignore —— OpenAI function tool name 字段类型收窄，非姓名
          ...(typeof fn['description'] === 'string'
            ? { description: fn['description'] as string }
            : {}),
          parameters: (asRecord(fn['parameters']) ?? {}) as JSONSchema,
          ...(typeof fn['strict'] === 'boolean' ? { strict: fn['strict'] as boolean } : {}),
          _raw: t,
        });
        toolIndex += 1;
        continue;
      }
      // provider 专有 server tool → canonical BuiltinTool（上游原生执行，executor=provider）
      const builtin = this.decodeBuiltinTool(type, t, profile);
      if (builtin !== undefined) {
        tools.push(builtin);
        toolIndex += 1;
        continue;
      }
      // 非 function 工具（builtin / 未来类型）：canonical 只有 FunctionTool | BuiltinTool
      // 两种，未知类型**不猜也不丢**——进 raw.nodes，回写时原样还原（10 §7.1 节点级 raw）
      warnings.push(`unknown_tool_type:${type}`);
      nodes[`tool:${toolIndex}`] = entry;
      toolIndex += 1;
      this.logger?.warn('openai.chat: 未建模的 tool 类型，进 raw.nodes 保留', { tool_type: type });
    }
    return tools;
  }

  /**
   * provider 专有 server tool 类型 → canonical `BuiltinTool`（认不出返回 undefined）。
   *
   * 只有**当前 access path 的 profile 认识**的类型才归一——同一个 codec 实例服务
   * 所有 openai.chat dialect 的 access path，不能把某一家 provider 的工具名当成
   * dialect 通用语义（例如 `deepseek_web_search` 对 OpenAI 本家毫无意义）。
   */
  private decodeBuiltinTool(
    vendorType: string,
    rec: Record<string, unknown>,
    profile: ProviderProfile | undefined,
  ): BuiltinTool | undefined {
    if (profile?.builtinToolCanonicalName === undefined) return undefined;
    const name = profile.builtinToolCanonicalName(vendorType);
    if (name === undefined) return undefined;
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'type' || k === 'name') continue;
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
   * tool_choice → canonical（10 §9.1：字符串同名；
   * `{type:"function", function:{name}}` → `{type:"tool", name}`）。
   *
   * 未建模形态（未来的 `allowed_tools` 之类）不猜：进 `raw.nodes`，回写时原样还原。
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
    if (typeof c['type'] === 'string' && c['type'] === 'function') {
      const fn = asRecord(c['function']);
      const name = fn !== undefined && typeof fn['name'] === 'string' ? (fn['name'] as string) : '';
      return { type: 'tool', name };
    }
    warnings.push(`unknown_tool_choice_type:${String(c['type'] ?? '<empty>')}`);
    nodes['tool_choice'] = raw;
    return undefined;
  }

  /** 采样参数 → ChatParams（10 §9.1 请求映射表的 OpenAI Chat 列）。 */
  private decodeParams(obj: Record<string, unknown>, warnings: string[]): ChatParams | undefined {
    const params: ChatParams = {};

    // 新旧名都收；同传时以新名 max_completion_tokens 为准（40 §2.2b）
    const maxOutput = num(obj['max_completion_tokens']) ?? num(obj['max_tokens']);
    if (maxOutput !== undefined) params.max_output_tokens = maxOutput;

    const temperature = num(obj['temperature']);
    if (temperature !== undefined) params.temperature = temperature;
    const topP = num(obj['top_p']);
    if (topP !== undefined) params.top_p = topP;
    const stop = obj['stop'];
    if (typeof stop === 'string') params.stop = [stop];
    else if (Array.isArray(stop)) {
      params.stop = stop.filter((s): s is string => typeof s === 'string');
    }
    const seed = num(obj['seed']);
    if (seed !== undefined) params.seed = seed;
    const frequencyPenalty = num(obj['frequency_penalty']);
    if (frequencyPenalty !== undefined) params.frequency_penalty = frequencyPenalty;
    const presencePenalty = num(obj['presence_penalty']);
    if (presencePenalty !== undefined) params.presence_penalty = presencePenalty;
    if (typeof obj['logprobs'] === 'boolean') params.logprobs = obj['logprobs'] as boolean;
    const topLogprobs = num(obj['top_logprobs']);
    if (topLogprobs !== undefined) params.top_logprobs = topLogprobs;
    const n = num(obj['n']);
    if (n !== undefined) params.n = n;
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

    const responseFormat = this.decodeResponseFormat(obj['response_format'], warnings);
    if (responseFormat !== undefined) params.response_format = responseFormat;

    const effort = obj['reasoning_effort'];
    if (typeof effort === 'string') {
      // OpenAI Chat 只有离散档位；canonical 统一成 ThinkingConfig.effort（40 §3.1）。
      // `enabled` 的判据是 `effort !== "none"`：OpenAI 的 "none" 语义是**关推理**，
      // 而 canonical 的 ThinkingConfig.enabled 正是"开/关"开关（10 §4.4）。
      const thinking: ThinkingConfig = {
        enabled: effort !== 'none',
        effort: effort as ThinkingConfig['effort'],
      };
      params.thinking = thinking;
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  /** response_format → canonical（`json_schema` 形状直接对应，10 §9.1）。 */
  private decodeResponseFormat(raw: unknown, warnings: string[]): ResponseFormat | undefined {
    const r = asRecord(raw);
    if (r === undefined) return undefined;
    const type = typeof r['type'] === 'string' ? (r['type'] as string) : '';
    if (type === 'text' || type === 'json_object') return { type };
    if (type === 'json_schema') {
      const js = asRecord(r['json_schema']);
      if (js === undefined) {
        warnings.push('response_format_json_schema_missing');
        return undefined;
      }
      return {
        type: 'json_schema',
        json_schema: {
          name: typeof js['name'] === 'string' ? (js['name'] as string) : '', // privacy-scan: ignore —— OpenAI json_schema name 字段类型收窄，非姓名
          ...(typeof js['description'] === 'string'
            ? { description: js['description'] as string }
            : {}),
          schema: (asRecord(js['schema']) ?? {}) as JSONSchema,
          ...(typeof js['strict'] === 'boolean' ? { strict: js['strict'] as boolean } : {}),
        },
      };
    }
    warnings.push(`unknown_response_format_type:${type}`);
    return undefined;
  }

  /** stream / stream_options → StreamOptions（10 §4.5；chat 的 on_mismatch 默认 bridge）。 */
  private decodeStreamOptions(obj: Record<string, unknown>): CanonicalRequestEnvelope['stream'] {
    const stream = obj['stream'];
    const streamOptions = asRecord(obj['stream_options']);
    if (stream !== true && streamOptions === undefined) return undefined;
    const includeUsage =
      streamOptions !== undefined && typeof streamOptions['include_usage'] === 'boolean'
        ? (streamOptions['include_usage'] as boolean)
        : undefined;
    return {
      enabled: stream === true,
      mode: stream === true ? 'sse' : 'none',
      ...(includeUsage === undefined ? {} : { include_usage: includeUsage }),
      on_mismatch: 'bridge',
    };
  }

  // ===========================================================================
  // 请求：canonical → wire（canonical → 客户端/上游格式）
  // ===========================================================================

  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest {
    const diagnostics: ConversionDiagnostic[] = [];
    const dropped: string[] = [];
    const warnings: string[] = [];

    // ---- fast path 短路（20 §4.2：不做任何结构转换，只透传原始字节）----
    // S1 把客户端原始字节放进 ctx.state[RAW_BODY]（s1-decode.ts），这里直接取用。
    const rawBody = ctx.state[CTX_STATE_KEYS.RAW_BODY];
    if (ctx.fast_path === true && Buffer.isBuffer(rawBody)) {
      return {
        body: undefined,
        raw_bytes: this.ensureIncludeUsage(rawBody),
        fast_path: true,
        path: this.endpointPathFor(ctx),
        dropped: [],
        warnings: [],
        diagnostics: [],
      };
    }
    if (ctx.fast_path === true) {
      // 理论上不该发生（fast path 判定条件 4 就是"保留了原始字节"）；真发生了就退化到
      // 结构编码，而不是静默发一个空 body。
      this.logger?.warn('openai.chat: fast_path 但 ctx.state.raw_body 不是 Buffer，退化为结构编码');
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
      // **必须用 `resolved_model ?? model`**（与 adaptors/anthropic-messages/codec.ts
      // 的 encode 同一立场，见那里的注释）：
      //
      // `resolved_model` 是 S2/S3/S4 写入的**上游侧真实 model id**——客户端传的
      // 可能是别名（`fast`）、命名空间路径（`deepseek/v4-pro`）或网关内部的
      // 路由名，而上游只认自己的 model id。直接用 `req.model` 会把别名原样发给
      // 上游，客户端拿到一个莫名的 400，而网关侧 trace 显示一切正常。
      //
      // 缺省回落到 `req.model`：没有走 S2 路由的场景（dog-fooding 直调 codec、
      // 单元测试）下 `resolved_model` 是 undefined，那时客户端传的就是上游名。
      model: req.resolved_model ?? req.model,
      messages: this.encodeMessages(payload, warn),
    };

    if (payload.tools !== undefined && payload.tools.length > 0) {
      const profile = this.profileFor(ctx);
      body['tools'] = payload.tools.map((tool) => this.encodeTool(tool, warn, profile));
    }
    const toolChoice = this.encodeToolChoice(payload.tool_choice, req.raw.nodes);
    if (toolChoice !== undefined) body['tool_choice'] = toolChoice;

    if (params !== undefined) this.encodeParams(params, body, warn, this.profileFor(ctx));

    if (req.stream !== undefined) {
      body['stream'] = req.stream.enabled;
      // 40 §2.3：OpenAI Chat 的 usage 只在末 chunk，且必须 stream_options.include_usage=true
      if (req.stream.enabled === true && req.stream.include_usage === true) {
        body['stream_options'] = { include_usage: true };
      }
    }

    // 10 §7.2 第 3 条：顶层 unmapped 回写（同格式互转时的无损保证）。
    //
    // **只在同格式时成立**（第 1 条「整体还原」的前提是 `source_provider === 目标格式`，
    // s4-encode.ts 文件头「反向 passthrough …同一格式互转时的无损保证」；anthropic
    // adaptor 的 `encodeUnmapped` 早有同款判据）。跨格式时那些键是**别家方言**的顶层
    // 字段—— Responses 客户端脸（42 期一）落地后，`previous_response_id` /
    // `truncation` / `prompt_cache_key` 之类会顺着 canonical 的 `raw.unmapped` 流到这里，
    // 照抄进 Chat 请求体就是静默注入（上游要么忽略、要么 400，而我们没有任何诊断）。
    if (req.raw.source_provider === PROVIDER_NAME) {
      for (const [key, value] of Object.entries(req.raw.unmapped ?? {})) {
        body[key] = value;
      }
      // 10 §7.2 第 2 条：未建模的 tool / tool_choice 节点级还原。
      // 注意键名是内部索引（`tool:<i>`），回写时要落回 `tools[]` 数组而不是当成顶层字段。
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
   * fast path 的**唯一**允许改写：补 `stream_options.include_usage`。
   *
   * 选择「最小字节改写」而不是「降级到慢路径」的理由：
   *   - 40 §2.3 要求网关在 S4 自动补上 include_usage，否则上游流式不回 usage、计费少报；
   *   - 为这一个字段降级到慢路径要付完整结构转换的代价，与 fast path 的目的相悖；
   *   - 因此只做「parse → 设一个字段 → re-serialise」的定点改写。JSON.parse/stringify
   *     保持键序，除新增键外字节 diff 为空（20 §4.2「仅在必要场景做极小改写」）。
   *
   * 判据用**原始字节里的 `stream`** 而不是 canonical：fast path 下发给上游的就是这些字节，
   * 「客户端要了流式」这件事以字节为准（20 §4.2：请求体以上游原始字节透传）。
   */
  private ensureIncludeUsage(rawBody: Buffer): Buffer {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return rawBody; // 解析失败不改写：透传优先（20 §4.2）
    }
    const obj = asRecord(parsed);
    if (obj === undefined || obj['stream'] !== true) return rawBody;
    const streamOptions = asRecord(obj['stream_options']);
    if (streamOptions !== undefined && streamOptions['include_usage'] === true) return rawBody;
    const next: Record<string, unknown> = {
      ...obj,
      stream_options: { ...(streamOptions ?? {}), include_usage: true },
    };
    return Buffer.from(JSON.stringify(next), 'utf8');
  }

  /** payload → messages[]（多 system 每条一个 messages 条目，40 §7.2）。 */
  private encodeMessages(
    payload: ChatPayload,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): unknown[] {
    const out: unknown[] = [];

    // system block → messages[{role:"system"}]；developer 原文按 _raw.role 还原
    for (const block of payload.system ?? []) {
      const raw = asRecord(block._raw);
      const role =
        raw !== undefined && typeof raw['role'] === 'string' ? (raw['role'] as string) : 'system';
      const entry: Record<string, unknown> = { role, content: block.text };
      Object.assign(entry, unmodelledMessageFields(block._raw));
      out.push(entry);
      if (block.cache_control !== undefined) {
        // 10 §9.1 末行：OpenAI Chat 的 cache_control「无（自动）」——prompt caching 自动生效
        warn(
          'cache_control_unsupported',
          'system.cache_control',
          'OpenAI prompt caching 自动生效，没有块级 cache_control 断点，已丢弃',
        );
      }
    }

    for (const message of payload.messages) {
      // canonical 的 `tool` 消息带 N 个 tool_result part（tool-loop.ts 的 appendTurn 把
      // 一轮的所有工具结果拼成**一条** canonical 消息），而 OpenAI Chat 的 wire 契约是
      // 「assistant 带 N 个 tool_calls → 后面必须跟 N 条 role:'tool' 消息，每条对一个
      // tool_call_id」。只产一条会让上游 400
      // "insufficient tool messages following tool_calls message"——内置对话一调工具
      // 就炸，所以这里按 tool_result part 拆开，不走 encodeMessage 的单条返回。
      if (message.role === 'tool') {
        out.push(...this.encodeToolMessage(message, warn));
        continue;
      }
      out.push(this.encodeMessage(message, warn));
    }
    return out;
  }

  /**
   * canonical `tool` 消息 → **N 条** `{role:"tool", tool_call_id, content}` wire 消息。
   *
   * 为什么要拆（三条边界都来自真实故障）：
   *   1. **一条 canonical → N 条 wire**：OpenAI Chat 要求每个 tool_call_id 各跟一条
   *      tool 消息；assistant 带 N 个 tool_calls 却只跟 1 条 → 上游 400
   *      "insufficient tool messages following tool_calls message"。
   *   2. **没有 tool_result part 时一条都不产**：`tool_call_id: ''` 的空消息同样是
   *      上游会拒的形状（退化输入不猜 id），只记 warning。
   *   3. **`_raw` 只在能明确对应时回填**（N === 1，即这条 canonical 消息就是一条 wire
   *      tool 消息解来的）：N > 1 时那份 raw 属于哪一条 wire 无从判断，重复 N 份等于
   *      把同一份未建模键复制进多条消息，回写会漂。
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
        'canonical tool 消息里没有 tool_result part，OpenAI Chat 无法表达（已整条丢弃）',
      );
      return [];
    }
    const unmodelled = results.length === 1 ? unmodelledMessageFields(message._raw) : {};
    return results.map((result) => {
      const entry: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: this.encodeToolResultContent(result.content, warn),
      };
      Object.assign(entry, unmodelled);
      return entry;
    });
  }

  /**
   * canonical 消息 → OpenAI wire 消息（**一条 canonical 一条 wire**）。
   *
   * `role === 'tool'` 的消息不走这里：一条 canonical tool 消息要拆成 N 条 wire 消息
   * （见 `encodeToolMessage`）。把两条路径合在一起正是上次 bug 的来源——两个函数
   * 对「一条 canonical 该产几条 wire」各有一半话语权。
   */
  private encodeMessage(
    message: CanonicalMessage,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): Record<string, unknown> {
    const raw = asRecord(message._raw);

    // 角色回写：canonical 枚举外的角色（如未来的 "tool_caller"）按 _raw.role 原样还原，
    // 不猜成 user（10 §7.2 第 2 条逐节点还原）
    const rawRole = raw?.['role'];
    const role =
      typeof rawRole === 'string' && !CANONICAL_ROLES.includes(rawRole) ? rawRole : message.role;

    const entry: Record<string, unknown> = { role };
    const text = message.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const toolCalls = message.parts.filter((p): p is ToolUsePart => p.type === 'tool_use');
    const refusal = message.parts.find((p): p is RefusalPart => p.type === 'refusal');
    const media = message.parts.filter(isMediaPart);

    if (media.length > 0) {
      // 多模态 content 必须是 block 数组（10 §9.1）
      const blocks: unknown[] = [];
      if (text !== '') blocks.push({ type: 'text', text });
      for (const part of media) blocks.push(this.encodeMediaPart(part, warn));
      entry['content'] = blocks;
    } else if (text === '' && toolCalls.length > 0) {
      // OpenAI 在只有 tool_calls 时把 content 置 null（不是空串）——保持 wire 形态，
      // 否则 decode→encode→decode 的 _raw 会从 null 漂移成 ""
      entry['content'] = null;
    } else {
      entry['content'] = text;
    }

    if (toolCalls.length > 0) {
      entry['tool_calls'] = toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          // 10 §7.3：优先 raw_arguments——畸形参数不得被 JSON.stringify(input) 静默替换
          arguments: call.raw_arguments ?? JSON.stringify(call.input),
        },
      }));
    }
    if (refusal !== undefined) entry['refusal'] = refusal.reason;

    // thinking part → reasoning_content（DeepSeek 的 wire 字段名，与 decodeResponse 对称）。
    // 这不是可选的礼貌：DeepSeek 官方文档明确「带 tools 的请求必须在后续每一轮完整
    // 回传 reasoning_content，否则 400」——多轮工具循环丢掉它，第二次上游调用就炸。
    const thinkingText = message.parts
      .filter((p): p is ThinkingPart => p.type === 'thinking')
      .map((p) => p.thinking)
      .join('');
    if (thinkingText !== '') entry['reasoning_content'] = thinkingText;

    for (const part of message.parts) {
      switch (part.type) {
        case 'redacted_thinking':
          // thinking 已映射到 reasoning_content；redacted（加密块）在 OpenAI Chat 无对应
          warn(
            'thinking_unsupported',
            `parts.${part.type}`,
            `canonical 的 ${part.type} part 在 OpenAI Chat 无对应，已丢弃`,
          );
          break;
        case 'search_result':
          warn(
            'search_result_unsupported',
            'parts.search_result',
            'OpenAI Chat 没有搜索引用块，已丢弃',
          );
          break;
        case 'unknown':
          warn(
            'unknown_part_dropped',
            `parts.${part.raw_type ?? '<empty>'}`,
            `未建模的 part（raw_type=${part.raw_type ?? '<empty>'}）在 OpenAI Chat 无对应，已丢弃`,
          );
          break;
        default:
          break;
      }
    }

    Object.assign(entry, unmodelledMessageFields(message._raw));
    return entry;
  }

  /**
   * ToolResultPart.content → OpenAI 的 `content`（string 或 block 数组，10 §9.1）。
   * 方向：canonical → 上游格式。
   */
  private encodeToolResultContent(
    content: Part[] | string,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): unknown {
    if (typeof content === 'string') return content;
    const blocks: unknown[] = [];
    for (const part of content) {
      if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
      else if (isMediaPart(part)) blocks.push(this.encodeMediaPart(part, warn));
      else {
        warn(
          `tool_result_part_unsupported`,
          `parts.${part.type}`,
          `tool_result 内容里的 ${part.type} part 在 OpenAI Chat 无对应，已丢弃`,
        );
      }
    }
    // 只有一段纯文本时退化成字符串，和 OpenAI 最常见的形态一致
    return blocks.length === 1 && (blocks[0] as { type?: string }).type === 'text'
      ? (blocks[0] as { text: string }).text
      : blocks;
  }

  /** 媒体 part → OpenAI block（image_url / input_audio）。 */
  private encodeMediaPart(
    part: ImagePart | AudioPart | DocumentPart | VideoPart,
    warn: (code: string, fieldPath: string, message: string) => void,
  ): unknown {
    if (part.type === 'image') {
      // 节点级还原优先（10 §7.2 第 2 条）：原 block 还在且 url 未变 → 原样回写，
      // 这样 detail 等 OpenAI 专有字段不丢
      const rawBlock = asRecord(part._raw);
      const rawUrl = asRecord(rawBlock?.['image_url'])?.['url'];
      const canonicalUrl = mediaToUrl(part.source);
      if (rawBlock !== undefined && typeof rawUrl === 'string' && rawUrl === canonicalUrl) {
        return { ...rawBlock };
      }
      return { type: 'image_url', image_url: { url: canonicalUrl } };
    }
    if (part.type === 'audio') {
      const source = part.source;
      if (source.kind === 'inline') {
        const format = source.mime.startsWith('audio/')
          ? source.mime.slice('audio/'.length)
          : 'wav';
        return { type: 'input_audio', input_audio: { data: source.data, format } };
      }
      warn(
        'audio_uri_unsupported',
        'parts.audio',
        'OpenAI Chat 的 input_audio 只接受 base64 data，URI 形态已丢弃',
      );
      return { type: 'text', text: '' };
    }
    warn(
      `${part.type}_unsupported`,
      `parts.${part.type}`,
      `OpenAI Chat 无 ${part.type} 输入形态，已丢弃`,
    );
    return { type: 'text', text: '' };
  }

  private encodeTool(
    tool: CanonicalTool,
    warn: (code: string, fieldPath: string, message: string) => void,
    profile: ProviderProfile | undefined,
  ): unknown {
    if (tool.type === 'builtin') {
      // 50 §3.1 模式 A：上游原生支持 → 透传成厂商专有 server tool 声明。
      // 认不出（没有 profile 或 profile 不覆盖该 canonical 名）→ 丢弃 + 告警，
      // 不猜一个 OpenAI 专有类型名（猜错会让上游 400 或静默失效）。
      const wire = profile?.builtinToolWire?.(tool.name, FORMAT);
      if (wire === undefined) {
        warn(
          'builtin_tool_unsupported',
          `tools.${tool.name}`,
          `canonical 内置工具 ${tool.name} 在目标 provider 无原生对应，已丢弃`,
        );
        return { type: 'function', function: { name: tool.name, parameters: {} } };
      }
      // provider 明确不吃配置字段时（DeepSeek 的 web 工具是裸开关，带配置上游 400）
      // 丢弃 + 告警，不静默发过去。
      const acceptsConfig = profile?.builtinToolAcceptsConfig?.(tool.name) ?? true;
      if (!acceptsConfig && Object.keys(tool.config).length > 0) {
        warn(
          'builtin_tool_config_unsupported',
          `tools.${tool.name}.config`,
          `上游不接受内置工具 ${tool.name} 的配置字段，已丢弃`,
        );
      }
      return { ...wire, ...(acceptsConfig ? tool.config : {}) };
    }
    if (tool.cache_control !== undefined) {
      warn(
        'cache_control_unsupported',
        'tools.cache_control',
        'OpenAI prompt caching 自动生效，没有块级 cache_control 断点，已丢弃',
      );
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.parameters,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
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
    if (choice.type === 'builtin') return { type: choice.name };
    return { type: 'function', function: { name: choice.name } };
  }

  /** ChatParams → wire 字段（10 §9.1 反向；40 §2.2b：统一发新名 max_completion_tokens）。 */
  private encodeParams(
    params: ChatParams,
    body: Record<string, unknown>,
    warn: (code: string, fieldPath: string, message: string) => void,
    profile: ProviderProfile | undefined,
  ): void {
    if (params.max_output_tokens !== undefined) {
      body['max_completion_tokens'] = params.max_output_tokens;
    }
    if (params.temperature !== undefined) body['temperature'] = params.temperature;
    if (params.top_p !== undefined) body['top_p'] = params.top_p;
    if (params.stop !== undefined) body['stop'] = params.stop;
    if (params.seed !== undefined) body['seed'] = params.seed;
    if (params.frequency_penalty !== undefined)
      body['frequency_penalty'] = params.frequency_penalty;
    if (params.presence_penalty !== undefined) body['presence_penalty'] = params.presence_penalty;
    if (params.logprobs !== undefined) body['logprobs'] = params.logprobs;
    if (params.top_logprobs !== undefined) body['top_logprobs'] = params.top_logprobs;
    if (params.n !== undefined) body['n'] = params.n;
    if (params.user !== undefined) body['user'] = params.user;
    if (params.metadata !== undefined) body['metadata'] = params.metadata;
    if (params.service_tier !== undefined) body['service_tier'] = params.service_tier;
    if (params.parallel_tool_calls !== undefined) {
      body['parallel_tool_calls'] = params.parallel_tool_calls;
    }
    if (params.response_format !== undefined) body['response_format'] = params.response_format;

    if (params.thinking !== undefined) {
      // provider 专有形态优先（DeepSeek：thinking:{type:enabled/disabled} 对象 +
      // 归一后的 reasoning_effort 枚举）。没有 profile 时走 OpenAI 本家默认映射。
      // 为什么必须让 provider 显式表达「关推理」：DeepSeek 省略 thinking 字段时
      // **默认开启**推理，静默省略会把客户端的 enabled:false 吞掉（语义反转）。
      const wire = profile?.thinkingWire?.(params.thinking);
      if (wire !== undefined) {
        Object.assign(body, wire);
      } else if (params.thinking.effort !== undefined) {
        body['reasoning_effort'] = params.thinking.effort;
      }
      if (params.thinking.budget_tokens !== undefined) {
        // 40 §3.1：OpenAI 只有离散档位，没有连续预算——必须显式丢弃 + 告警
        warn(
          'thinking_budget_unsupported',
          'params.thinking.budget_tokens',
          'OpenAI Chat 只有 reasoning_effort 档位，没有连续 token 预算，已丢弃',
        );
      }
      if (params.thinking.include_summary !== undefined) {
        warn(
          'thinking_include_summary_unsupported',
          'params.thinking.include_summary',
          'OpenAI Chat 没有思考摘要开关，已丢弃',
        );
      }
    }

    // canonical 有、OpenAI Chat 没有的采样参数：逐条 drop + warning（40 §1.4 第 3 步）
    if (params.top_k !== undefined) {
      warn('top_k_unsupported', 'params.top_k', 'OpenAI Chat 不支持 top_k，已丢弃');
    }
    if (params.safety !== undefined) {
      warn('safety_unsupported', 'params.safety', 'OpenAI Chat 没有 safetySettings，已丢弃');
    }
  }

  // ===========================================================================
  // 响应：wire → canonical（上游格式 → canonical）
  // ===========================================================================

  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error('OpenAI Chat 响应体不是 JSON object');
    }
    const warnings: string[] = [];

    const choice = firstChoice(obj);
    const message = asRecord(choice?.['message']);

    const parts: Part[] = [];
    if (message !== undefined) {
      // reasoning_content（DeepSeek 思考内容的 wire 字段名，与流式 delta 的同名字段对齐）
      // 排在 content 之前：它在 wire 上就是「最终答案之前」的那段推理。
      // 为什么非流式也要收：流式路径早就读 delta.reasoning_content（见 foldChunk），
      // 非流式不收会造成同一 dialect 两条路径的 canonical 不一致。
      const reasoning = message['reasoning_content'] ?? message['reasoning'];
      if (typeof reasoning === 'string' && reasoning !== '') {
        parts.push({ type: 'thinking', thinking: reasoning });
      }
      parts.push(...this.decodeParts(message['content'], warnings));
      const refusal = message['refusal'];
      if (typeof refusal === 'string') parts.push({ type: 'refusal', reason: refusal });
      const toolCalls = message['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          const toolUse = this.decodeToolCall(call);
          if (toolUse !== undefined) parts.push(toolUse);
        }
      }
    }

    const usage = this.buildUsage(obj['usage'], warnings);

    const finishReasonRaw =
      choice !== undefined && typeof choice['finish_reason'] === 'string'
        ? (choice['finish_reason'] as string)
        : undefined;
    const normalized = this.normalizeFinishReason(finishReasonRaw);
    if (
      finishReasonRaw !== undefined &&
      FINISH_REASON_TO_CANONICAL[finishReasonRaw] === undefined
    ) {
      // 10 §9.3 注意 2：未命中不得默认 stop
      warnings.push(`unmapped_finish_reason:${finishReasonRaw}`);
      this.logger?.warn('openai.chat: finish_reason 未命中归一表', { raw: finishReasonRaw });
    }

    const responsePayload: ChatResponsePayload = {
      message: {
        role: 'assistant',
        parts,
        ...(message === undefined ? {} : { _raw: message }),
      },
      ...(typeof obj['model'] === 'string' ? { model: obj['model'] as string } : {}),
      ...(choice !== undefined && typeof choice['index'] === 'number'
        ? { index: choice['index'] as number }
        : {}),
    };

    const unmapped = collectUnmapped(obj, MODELLED_RESPONSE_KEYS);

    return {
      ir_version: IR_VERSION,
      kind: MODALITY,
      request_id: typeof obj['id'] === 'string' ? (obj['id'] as string) : ctx.request_id,
      usage,
      finish_reason: normalized,
      payload: responsePayload,
      raw: {
        source_provider: PROVIDER_NAME,
        ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
        // 10 §9.3 注意 3：原文进 raw 顶层一等字段，回写与对账用
        ...(finishReasonRaw === undefined ? {} : { finish_reason_provider: finishReasonRaw }),
      },
      warnings,
    };
  }

  /**
   * usage → CanonicalUsage（40 §2.1 的 OpenAI Chat 列）。
   *
   * 三条硬约束：
   *   - **I4**：整个原始 usage 对象逐字段进 `usage.raw`，独立于 `units`
   *     （流式聚合只动 units，绝不动 raw，否则 extras 会丢——LiteLLM 的教训）；
   *   - **10 §6.1 规则 2**：上游没给 usage 时 `units.tokens` 键**省略** +
   *     `warnings += "usage_missing"`，绝不用 0 表示未知；
   *   - **I1**：`input_tokens` 记 `prompt_tokens` 全量（含 cached 部分，不另加，避免双算）。
   */
  private buildUsage(rawUsage: unknown, warnings: string[]): CanonicalUsage {
    const usage = asRecord(rawUsage);
    if (usage === undefined) {
      warnings.push('usage_missing');
      return { units: {}, source: 'provider' };
    }

    const promptDetails = asRecord(usage['prompt_tokens_details']);
    const completionDetails = asRecord(usage['completion_tokens_details']);
    const promptTokens = num(usage['prompt_tokens']);
    const completionTokens = num(usage['completion_tokens']);

    const tokens: NonNullable<CanonicalUsage['units']['tokens']> = {
      input_tokens: promptTokens ?? 0,
      output_tokens: completionTokens ?? 0,
      total_tokens: num(usage['total_tokens']) ?? (promptTokens ?? 0) + (completionTokens ?? 0),
      cache_read_tokens: num(promptDetails?.['cached_tokens']) ?? 0,
      cache_write_tokens: num(promptDetails?.['cache_write_tokens']) ?? 0,
      reasoning_tokens: num(completionDetails?.['reasoning_tokens']) ?? 0,
    };

    return { units: { tokens }, raw: usage, source: 'provider' };
  }

  // ===========================================================================
  // 响应：canonical → wire（canonical → 客户端格式）
  // ===========================================================================

  encodeResponse(res: CanonicalResponseEnvelope, _ctx: RequestContext): unknown {
    // 20 §7.2：错误体由客户端格式 codec 生成（不直接透传上游错误体，避免泄漏内部细节），
    // OpenAI Chat 的形状是 `{error:{message,type,code}}`。判定信号是 finish_reason === "error"
    // ——OpenAI Chat 的 finish_reason 永远映射不到 "error"（10 §9.3 该列为「—」），所以这个值
    // 只可能来自网关的错误信封（runner 的 errorEnvelope）。
    if (res.finish_reason === 'error') {
      return this.encodeErrorBody(res);
    }

    const payload = res.payload as ChatResponsePayload;
    const message = payload.message;

    const text = message.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const toolCalls = message.parts.filter((p): p is ToolUsePart => p.type === 'tool_use');
    const refusal = message.parts.find((p): p is RefusalPart => p.type === 'refusal');
    // thinking part → reasoning_content（与 decodeResponse 对称；DeepSeek 的字段名）
    const reasoning = message.parts
      .filter((p): p is ThinkingPart => p.type === 'thinking')
      .map((p) => p.thinking)
      .join('');

    const out: Record<string, unknown> = {
      id: res.request_id,
      object: 'chat.completion',
      created: Math.floor(this.clock.now() / 1000),
      model: payload.model ?? '',
      choices: [
        {
          index: payload.index ?? 0,
          message: {
            role: 'assistant',
            // OpenAI 在没有文本内容时把 content 置 null（有 tool_calls 或 refusal 时）
            content: text === '' && (toolCalls.length > 0 || refusal !== undefined) ? null : text,
            ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
            ...(toolCalls.length > 0
              ? {
                  tool_calls: toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                      name: call.name,
                      // 10 §7.3：优先 raw_arguments
                      arguments: call.raw_arguments ?? JSON.stringify(call.input),
                    },
                  })),
                }
              : {}),
            ...(refusal === undefined ? {} : { refusal: refusal.reason }),
          },
          finish_reason: this.encodeFinishReason(res),
        },
      ],
    };

    const tokens = res.usage.units.tokens;
    if (tokens !== undefined) {
      out['usage'] = this.encodeUsage(tokens, res.usage.raw);
    }
    // 10 §7.2 第 3 条：顶层 unmapped 回写（system_fingerprint / service_tier 等）
    for (const [key, value] of Object.entries(res.raw.unmapped ?? {})) {
      out[key] = value;
    }
    return out;
  }

  /**
   * canonical 错误 → OpenAI Chat 错误体（20 §7.2 的映射表第一列）。
   *
   * `type` 的取值体现 `retryable` 语义（20 §7.2 第二行）：限流/过载用
   * `rate_limit_error` / `server_error`，参数类用 `invalid_request_error`。
   *
   * ⚠️ **数据来源缺口（已报告给 lead，不在本文件写权限内）**：
   * `gateway-core/pipeline/runner.ts` 的 `errorEnvelope()` 只把 `error.message` 放进
   * refusal part，`code` / `http_status` / `retryable` 都没进信封，因此这里只能从
   * `raw.nodes.error` 里找 canonical error（runner 哪天补上就自动生效），找不到就退到
   * 保守的 `server_error` + `code: null`。**不猜具体错误码**——猜错会让客户端把
   * 参数错误当服务端错误重试，或反之。
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
      code === undefined ? 'server_error' : (OPENAI_ERROR_TYPE_BY_CODE[code] ?? 'server_error');
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
   * canonical usage → OpenAI usage 对象（40 §2.1 反向）。
   *
   * `*_details` 只在对应值非 0 时输出：回写方向同样不得把「上游没给」写成 0
   * （10 §6.1 规则 2 的同立场）。有 `usage.raw` 时**原样还原优先**（I4 的对账价值）。
   */
  private encodeUsage(
    tokens: NonNullable<CanonicalUsage['units']['tokens']>,
    rawUsage: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (rawUsage !== undefined) return { ...rawUsage };
    const usage: Record<string, unknown> = {
      prompt_tokens: tokens.input_tokens,
      completion_tokens: tokens.output_tokens,
      total_tokens: tokens.total_tokens,
    };
    if (tokens.cache_read_tokens !== 0 || tokens.cache_write_tokens !== 0) {
      usage['prompt_tokens_details'] = {
        ...(tokens.cache_read_tokens === 0 ? {} : { cached_tokens: tokens.cache_read_tokens }),
        ...(tokens.cache_write_tokens === 0
          ? {}
          : { cache_write_tokens: tokens.cache_write_tokens }),
      };
    }
    if (tokens.reasoning_tokens !== 0) {
      usage['completion_tokens_details'] = { reasoning_tokens: tokens.reasoning_tokens };
    }
    return usage;
  }

  /**
   * canonical finish_reason → OpenAI 值（10 §9.3 反向）。
   *
   * 可逆性优先（注意 3）：`raw.finish_reason_provider` 有原文时**原样回写**；
   * 否则查反向表；反向表也没有（如 `pause_turn` / `recitation`）时返回 null 让客户端
   * 自己判断，而不是猜一个 `stop`。
   *
   * ⚠️ 原样回写带**同格式前提**（10 §7.2 第 1 条）：只有 `source_provider` 是本格式时
   * 才认这个原文。跨格式时原文是别家枚举，照抄会产出非法 finish_reason。
   */
  private encodeFinishReason(res: CanonicalResponseEnvelope): string | null {
    const provider =
      res.raw.source_provider === PROVIDER_NAME ? res.raw.finish_reason_provider : undefined;
    if (typeof provider === 'string') return provider;
    // finish_reason 的类型是 FinishReason（含 ASR 的 "final" 哨兵），表里没有的键自然落 null
    const mapped = CANONICAL_TO_FINISH_REASON[res.finish_reason as NormalizedFinishReason];
    return mapped ?? null;
  }

  // ===========================================================================
  // 流式：wire → canonical（上游格式 → canonical，20 §S6 折叠表）
  // ===========================================================================

  async *decodeStream(
    stream: AsyncIterable<unknown>,
    ctx: RequestContext,
  ): AsyncIterable<StreamFrame> {
    const state: StreamFoldState = {
      started: false,
      pendingTools: new Map(),
      lastFinishReasonRaw: undefined,
      lastUsage: undefined,
      warnings: [],
    };

    for await (const item of stream) {
      for (const payload of ssePayloadsOf(item)) {
        if (payload === DONE_SENTINEL) continue; // [DONE]：哨兵本身不产帧，end 帧在流尾发
        yield* this.foldChunk(payload, ctx, state);
      }
    }

    // 流结束：给还没收尾的 tool_call 补 part.end（20 §S6：part.end 带完整 tool_use part）
    yield* this.flushPendingTools(state, ctx);
    yield this.makeFrame('end', ctx, {
      finish_reason: this.normalizeFinishReason(state.lastFinishReasonRaw),
      ...(state.lastUsage === undefined ? {} : { usage: state.lastUsage }),
      // EndData.output 是唯一的结构化自由槽：放回写要用的原文 + 本次累积的 warning
      ...(state.warnings.length > 0 || state.lastFinishReasonRaw !== undefined
        ? {
            output: {
              ...(state.lastFinishReasonRaw === undefined
                ? {}
                : { [RAW_FINISH_REASON_KEY]: state.lastFinishReasonRaw }),
              ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
            },
          }
        : {}),
    });
  }

  /** 单个 chunk → 0..n 帧（20 §S6 折叠表的 OpenAI Chat 行）。 */
  private *foldChunk(
    chunk: Record<string, unknown>,
    ctx: RequestContext,
    state: StreamFoldState,
  ): Generator<StreamFrame> {
    if (!state.started) {
      state.started = true;
      yield this.makeFrame('start', ctx, {
        ...(typeof chunk['id'] === 'string' ? { session_id: chunk['id'] as string } : {}),
        model: typeof chunk['model'] === 'string' ? (chunk['model'] as string) : '',
        client_format: ctx.client_format,
        provider_format: ctx.provider_format,
      });
    }

    const chunkUsage = asRecord(chunk['usage']);
    if (chunkUsage !== undefined) {
      const usage = this.buildUsage(chunkUsage, state.warnings);
      state.lastUsage = usage;
      yield this.makeFrame('usage', ctx, { usage });
    }

    const choice = firstChoice(chunk);
    if (choice === undefined) return;
    const delta = asRecord(choice['delta']);
    if (delta === undefined) return;

    const content = delta['content'];
    if (typeof content === 'string' && content !== '') {
      yield this.makeFrame('delta', ctx, { kind: 'chat', text: content });
    }
    const reasoning = delta['reasoning_content'] ?? delta['reasoning'];
    if (typeof reasoning === 'string' && reasoning !== '') {
      yield this.makeFrame('delta', ctx, { kind: 'chat', thinking: reasoning });
    }
    const refusal = delta['refusal'];
    if (typeof refusal === 'string' && refusal !== '') {
      yield this.makeFrame('delta', ctx, { kind: 'chat', refusal });
    }

    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const c = asRecord(call);
        if (c === undefined) continue;
        const index = typeof c['index'] === 'number' ? (c['index'] as number) : 0;
        const fn = asRecord(c['function']);
        const id = typeof c['id'] === 'string' ? (c['id'] as string) : undefined;
        const name =
          fn !== undefined && typeof fn['name'] === 'string' ? (fn['name'] as string) : undefined;
        const argsFragment =
          fn !== undefined && typeof fn['arguments'] === 'string'
            ? (fn['arguments'] as string)
            : '';

        const pending = state.pendingTools.get(index);
        if (pending === undefined) {
          // part.begin（20 §S6 折叠表）：新 tool_call 的首片
          state.pendingTools.set(index, {
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name }),
            arguments: argsFragment,
          });
          yield this.makeFrame('meta', ctx, {
            notes: {
              [PART_FRAME_NOTE_KEY]: {
                phase: 'begin',
                index,
                part: { type: 'tool_use', id: id ?? '', name: name ?? '' },
              },
            },
          });
        } else {
          if (id !== undefined && pending.id === undefined) pending.id = id;
          if (name !== undefined && pending.name === undefined) pending.name = name;
          pending.arguments += argsFragment;
        }
        if (argsFragment !== '') {
          // index 一起下发：s6 的 frameToEvent 读 DeltaData.index 还原 part.delta 的
          // part 序号，缺省会落 0——并行 tool_call 时两个分片会被并到同一个 part 上
          yield this.makeFrame('delta', ctx, {
            kind: 'chat',
            index,
            tool_input_json: argsFragment,
          });
        }
      }
    }

    const finishReason = choice['finish_reason'];
    if (typeof finishReason === 'string') {
      state.lastFinishReasonRaw = finishReason;
      if (FINISH_REASON_TO_CANONICAL[finishReason] === undefined) {
        state.warnings.push(`unmapped_finish_reason:${finishReason}`);
      }
      // 20 §S6：finish_reason 到达即给已累加的 tool_call 收尾
      yield* this.flushPendingTools(state, ctx);
      // finish_reason 在它自己的 wire 位置上单独成帧（见 FINISH_FRAME_NOTE_KEY 注释）
      yield this.makeFrame('meta', ctx, {
        notes: {
          [FINISH_FRAME_NOTE_KEY]: {
            finish_reason: this.normalizeFinishReason(finishReason),
            [RAW_FINISH_REASON_KEY]: finishReason,
          },
        },
      });
    }
  }

  /** 给所有未收尾的 tool_call 发 part.end（meta 帧带完整 tool_use part）。 */
  private *flushPendingTools(state: StreamFoldState, ctx: RequestContext): Generator<StreamFrame> {
    for (const [index, pending] of [...state.pendingTools.entries()].sort((a, b) => a[0] - b[0])) {
      const part: StreamPart = {
        type: 'tool_use',
        id: pending.id ?? '',
        name: pending.name ?? '',
        input: parseToolInput(pending.arguments),
        raw_arguments: pending.arguments,
      };
      yield this.makeFrame('meta', ctx, {
        notes: { [PART_FRAME_NOTE_KEY]: { phase: 'end', index, part } },
      });
    }
    state.pendingTools.clear();
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

  async *encodeStream(
    frames: AsyncIterable<StreamFrame>,
    ctx: RequestContext,
  ): AsyncIterable<unknown> {
    /** index → 已开流（发过 part.begin）但未收尾的 tool_call。 */
    const openTools = new Map<number, { id: string; name: string; arguments: string }>();
    /** 本次调用里是否已经发过 finish chunk（meta(finish) 与 end 帧都可能发，只发一次）。 */
    let finishEmitted = false;
    let emittedDone = false;

    for await (const frame of frames) {
      if (emittedDone) continue;
      for (const line of this.encodeFrame(
        frame,
        ctx,
        openTools,
        () => finishEmitted,
        () => {
          finishEmitted = true;
        },
      )) {
        yield line;
      }
      if (frame.event === 'end') {
        // [DONE] 只跟 end 帧走一次（S8 按事件逐个调用 encodeStream，若无 end 帧也补
        // [DONE]，客户端会在第一个事件后就收到终止哨兵）
        yield 'data: [DONE]\n\n';
        emittedDone = true;
      }
    }
  }

  /** 单帧 → SSE 行（0..n 条 `data: {...}\n\n`）。 */
  private encodeFrame(
    frame: StreamFrame,
    ctx: RequestContext,
    openTools: Map<number, { id: string; name: string; arguments: string }>,
    isFinishEmitted: () => boolean,
    markFinishEmitted: () => void,
  ): string[] {
    const id = `chatcmpl-${ctx.request_id}`;
    const created = Math.floor(this.clock.now() / 1000);

    switch (frame.event) {
      case 'start': {
        const data = frame.data as { model?: string; session_id?: string };
        return [
          sse({
            id: data.session_id ?? id,
            object: 'chat.completion.chunk',
            created,
            model: data.model ?? '',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }),
        ];
      }
      case 'delta': {
        const data = frame.data as {
          kind?: string;
          index?: number;
          text?: string;
          thinking?: string;
          tool_input_json?: string;
          refusal?: string;
          /** part 边界帧（ir/stream.ts 的 PartBeginData / PartEndData，S8 现在走这条）。 */
          part?: StreamPart;
        };
        if (data.kind !== 'chat') return [];

        // part 边界（S8 的 eventToFrameData 把 part.begin / part.end 折成
        // `{kind:'chat', index, part}`；两者形状相同，用「这个 index 是否已开流」区分）
        if (data.part !== undefined) {
          return this.encodePartBoundary(data.part, data.index ?? 0, id, created, openTools);
        }

        if (data.tool_input_json !== undefined) {
          // 参数分片：优先用帧上带的 index（s8 现在会填，20 §S6 的 part.delta 带序号）；
          // 老帧没有 index 时退到「最近打开且未收尾」的那个 tool_call
          const entries = [...openTools.entries()];
          const index =
            typeof data.index === 'number'
              ? data.index
              : entries.length > 0
                ? entries[entries.length - 1][0]
                : 0;
          const open = openTools.get(index);
          if (open !== undefined) open.arguments += data.tool_input_json;
          return [
            sse({
              id,
              object: 'chat.completion.chunk',
              created,
              model: '',
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index, function: { arguments: data.tool_input_json } }] },
                  finish_reason: null,
                },
              ],
            }),
          ];
        }

        const delta: Record<string, unknown> = {};
        if (data.text !== undefined && data.text !== '') delta['content'] = data.text;
        if (data.thinking !== undefined && data.thinking !== '') {
          delta['reasoning_content'] = data.thinking;
        }
        if (data.refusal !== undefined && data.refusal !== '') delta['refusal'] = data.refusal;
        if (Object.keys(delta).length === 0) return [];
        return [
          sse({
            id,
            object: 'chat.completion.chunk',
            created,
            model: '',
            choices: [{ index: 0, delta, finish_reason: null }],
          }),
        ];
      }
      case 'meta':
        return this.encodeMeta(frame, id, created, openTools, isFinishEmitted, markFinishEmitted);
      case 'usage': {
        const data = frame.data as { usage?: CanonicalUsage };
        const tokens = data.usage?.units.tokens;
        if (tokens === undefined) return [];
        return [
          sse({
            id,
            object: 'chat.completion.chunk',
            created,
            model: '',
            choices: [],
            usage: this.encodeUsage(tokens, data.usage?.raw),
          }),
        ];
      }
      case 'end': {
        const data = frame.data as { finish_reason?: string; output?: unknown };
        // finish chunk 的两个可能来源：meta(finish) 帧（保持 wire 顺序）与 end 帧
        // （S8 按事件逐帧调用 encodeStream 时的唯一来源）。同一次调用里只发一次。
        const lines: string[] = [];
        if (!isFinishEmitted()) {
          lines.push(
            sse({
              id,
              object: 'chat.completion.chunk',
              created,
              model: '',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: this.encodeStreamFinishReason(data.finish_reason, data.output),
                },
              ],
            }),
          );
          markFinishEmitted();
        }
        // usage 已由 usage 帧单独发过（OpenAI 末 chunk 形态），这里不重复，
        // 否则客户端会把 usage 算两遍
        return lines;
      }
      case 'error':
        return [];
    }
  }

  /**
   * part 边界帧 → OpenAI tool_call chunk。
   *
   * **两种入参形状都支持**（管道与 codec 各有一条路）：
   *   A. `ir/stream.ts` 的类型化 `PartBeginData` / `PartEndData`：
   *      `{kind:'chat', index, part}` 挂在 `event:'delta'` 上——S8 的
   *      `eventToFrameData()` 现在把 `part.begin`/`part.end` 折成这个形状；
   *   B. 本 codec `decodeStream` 自己产出的 meta 帧（`notes` 挂 `{phase, index, part}`），
   *      s6 的 `partNoteFrom()` 认这一种。
   * 两者形状相同（都没有显式的 begin/end 标记），因此用「这个 index 是否已开流」区分：
   * 没开过 = begin，开着 = end。
   *
   * part.end 的语义是「这个 tool_use part 已完整」：如果它的参数已经通过分片发过
   * （openTools 里还开着），wire 侧**不需要**再发一次——OpenAI 的客户端本来就是从
   * 分片自行拼装的，再发一遍完整参数等于重复。只有在「从没见过分片」时
   * （整块到达的上游，如 Gemini functionCall）才把完整 tool_call 一次发出。
   */
  private encodePartBoundary(
    part: StreamPart,
    index: number,
    id: string,
    created: number,
    openTools: Map<number, { id: string; name: string; arguments: string }>,
  ): string[] {
    if (part.type !== 'tool_use') return []; // text / thinking 的边界在 OpenAI 侧没有对应事件
    const toolId = part.id ?? '';
    const name = part.name ?? '';

    const open = openTools.get(index);
    if (open === undefined) {
      // 没见过分片：若这个 part 已带完整参数（整块到达），直接把完整 tool_call 一次发出；
      // 否则它是 begin——发 id/name，参数等后续分片
      const hasCompleteArgs =
        typeof part.raw_arguments === 'string' || Object.keys(part.input ?? {}).length > 0;
      if (hasCompleteArgs) {
        return [
          sse({
            id,
            object: 'chat.completion.chunk',
            created,
            model: '',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: toolId,
                      type: 'function',
                      function: {
                        name,
                        arguments: part.raw_arguments ?? JSON.stringify(part.input ?? {}),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        ];
      }
      openTools.set(index, { id: toolId, name, arguments: '' });
      return [
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: '',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index, id: toolId, type: 'function', function: { name, arguments: '' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      ];
    }

    // 已开流 = end：参数已分片发过，wire 侧无需再发
    openTools.delete(index);
    return [];
  }

  /**
   * meta 帧 → OpenAI chunk。
   *
   * 两种 meta 帧：
   *   - part.begin / part.end（`PART_FRAME_NOTE_KEY`）→ tool_call chunk；
   *   - finish（`FINISH_FRAME_NOTE_KEY`）→ 带 finish_reason 的收尾 chunk。
   */
  private encodeMeta(
    frame: StreamFrame,
    id: string,
    created: number,
    openTools: Map<number, { id: string; name: string; arguments: string }>,
    isFinishEmitted: () => boolean,
    markFinishEmitted: () => void,
  ): string[] {
    const notes = (frame.data as { notes?: Record<string, unknown> }).notes ?? {};

    const finish = asRecord(notes[FINISH_FRAME_NOTE_KEY]);
    if (finish !== undefined) {
      if (isFinishEmitted()) return [];
      markFinishEmitted();
      return [
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: '',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: this.encodeStreamFinishReason(
                typeof finish['finish_reason'] === 'string'
                  ? (finish['finish_reason'] as string)
                  : undefined,
                finish,
              ),
            },
          ],
        }),
      ];
    }

    const note = asRecord(notes[PART_FRAME_NOTE_KEY]);
    if (note === undefined) return [];
    const phase = note['phase'];
    const index = typeof note['index'] === 'number' ? (note['index'] as number) : openTools.size;
    const part = note['part'] as StreamPart | undefined;
    if (part === undefined || part.type !== 'tool_use') return [];

    if (phase === 'begin') {
      // begin：显式 phase，直接走开户分支（part 里通常还没有参数）
      openTools.delete(index);
      return this.encodePartBoundary(
        { ...part, input: {}, raw_arguments: undefined },
        index,
        id,
        created,
        openTools,
      );
    }
    return this.encodePartBoundary(part, index, id, created, openTools);
  }

  /** 流式 finish_reason 回写：优先 end 帧带的原文，其次原生取值表，都没有则 null（不猜 stop）。 */
  private encodeStreamFinishReason(raw: string | undefined, output: unknown): string | null {
    const provider = asRecord(output)?.[RAW_FINISH_REASON_KEY];
    if (typeof provider === 'string') return provider;
    if (raw !== undefined && OPENAI_STREAM_FINISH_REASONS.includes(raw)) return raw;
    if (raw === undefined) return null;
    const mapped = CANONICAL_TO_FINISH_REASON[raw as NormalizedFinishReason];
    return mapped ?? null;
  }

  // ===========================================================================
  // 公共小能力（40 §1.1 的 8 个必需方法里剩下的两个）
  // ===========================================================================

  /**
   * 从响应体里抽 usage（S6 fast path 用）。
   *
   * 与 decodeResponse 共用 `buildUsage`，保证快慢路径口径一致（40 §2.1 只保留一份表，
   * 20 §4.3 的去重说明同一立场）。
   */
  extractUsage(raw: unknown): CanonicalUsage {
    const obj = asRecord(raw);
    if (obj === undefined) return { units: {}, source: 'provider' };
    const nested = asRecord(obj['usage']);
    if (nested !== undefined) return this.buildUsage(nested, []);
    // 也接受「裸 usage 对象」（嗅探器直接把 chunk.usage 传进来的情形）
    if ('prompt_tokens' in obj || 'completion_tokens' in obj || 'total_tokens' in obj) {
      return this.buildUsage(obj, []);
    }
    return { units: {}, source: 'provider' };
  }

  /**
   * finish_reason 归一（10 §9.3）。
   *
   * 入参**两者都收**：原始字符串（规范用法），或响应对象（此时读 `choices[0].finish_reason`，
   * 方便嗅探器直接传响应体）。未命中 → `"other"`，**绝不默认 stop**（注意 2）。
   */
  normalizeFinishReason(raw: unknown): NormalizedFinishReason {
    if (typeof raw === 'string') return FINISH_REASON_TO_CANONICAL[raw] ?? 'other';
    const obj = asRecord(raw);
    if (obj === undefined) return 'other';
    const value = firstChoice(obj)?.['finish_reason'];
    if (typeof value !== 'string') return 'other';
    return FINISH_REASON_TO_CANONICAL[value] ?? 'other';
  }

  // ===========================================================================
  // D-fastpath-1：S1 惰性解码（只解析路由必需集，不物化 messages/tools）
  // ===========================================================================

  decodeEnvelope(raw: unknown, ctx: RequestContext): RequestEnvelopeShallow {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error('OpenAI Chat 请求体不是 JSON object（S1 浅解析阶段即失败，避免无谓解码）');
    }
    const stream = obj['stream'] === true;
    const unmapped = collectUnmapped(obj, MODELLED_REQUEST_KEYS);
    // 网关扩展开关（20 §5.1）：浅解析就要给出，Runner 才能**不物化 canonical** 就判断
    // 要不要进工具循环（D-fastpath-1 的第三种物化触发点）。
    const agenticLoop = obj['ag_agentic_loop'] === true;
    return {
      source_format: FORMAT,
      kind: MODALITY,
      model: typeof obj['model'] === 'string' ? (obj['model'] as string) : '',
      stream,
      // bytes：请求体字节长度（ROUTING_REQUIRED_FIELDS 之一，限额与观测用）。
      // S0 已经量过真实字节数（ctx.request_bytes，s0-ingress.ts），优先用它；
      // 直调 codec（测试/工具）没有该字段时才退回复传序列化的紧凑长度。
      bytes: ctx.request_bytes ?? Buffer.byteLength(JSON.stringify(obj), 'utf8'),
      // usage 位置提示（fast path 嗅探器用）：非流式在响应体顶层；流式在每个 chunk 顶层
      usage_locations: stream ? ['$.choices[*].usage', '$.usage'] : ['$.usage'],
      ...(agenticLoop ? { gateway_agentic_loop: true } : {}),
      ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
      default_path: DEFAULT_PATH,
    };
  }
}

// =============================================================================
// 模块级纯函数（无状态、无副作用，便于单测）
// =============================================================================

/** SSE 的 `[DONE]` 哨兵在内部用这个唯一对象表示（避免与合法 JSON 字符串混淆）。 */
const DONE_SENTINEL = Symbol('[DONE]');

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
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

/** MediaRef → OpenAI 的 url 字符串（inline 还原成 data: URL）。 */
function mediaToUrl(source: MediaRef): string {
  if (source.kind === 'uri') return source.uri;
  if (source.kind === 'inline') return `data:${source.mime};base64,${source.data}`;
  return `asset://${source.asset_id}`;
}

/**
 * 从 URL 猜 mime（只认常见图片扩展名）。
 *
 * 为什么需要猜：`MediaBase.mime` 在 ir/media.ts 里是**必填**，而 OpenAI 的
 * `image_url.url` 只是个 URL、不带 mime。猜不出来时用 `application/octet-stream`
 * 而不是留空——canonical 消费方（如媒体落盘）需要一个确定值；wire 侧回写时走
 * `_raw` 节点级还原，这个猜测值不会泄漏到上游。
 */
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

/** 取 choices[0]（响应与流式共用）。 */
function firstChoice(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = obj['choices'];
  if (!Array.isArray(choices)) return undefined;
  return asRecord(choices[0]);
}

/** 该 part 是否是 OpenAI Chat 认识的多模态输入 part。 */
function isMediaPart(part: Part): part is ImagePart | AudioPart | DocumentPart | VideoPart {
  return (
    part.type === 'image' ||
    part.type === 'audio' ||
    part.type === 'document' ||
    part.type === 'video'
  );
}

/** 把 `_raw` 里**未建模**的消息级键取出来（10 §7.2 第 2 条逐节点还原）。 */
function unmodelledMessageFields(raw: unknown): Record<string, unknown> {
  const obj = asRecord(raw);
  if (obj === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!MODELLED_MESSAGE_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

/** 序列化一个 SSE data 行（20 §S8：`data: {...}\n\n`）。 */
function sse(body: unknown): string {
  return `data: ${JSON.stringify(body)}\n\n`;
}

/**
 * 从上游来的一个元素里取出所有 SSE `data:` 负载。
 *
 * S6 传入的是「按 SSE 事件边界切好的 block 字符串」，但也兼容整段 SSE 文本 /
 * Buffer / 已解析对象（不同 transport 的切分粒度不同，codec 不假设）。
 * `[DONE]` 哨兵返回 `DONE_SENTINEL`。
 */
function ssePayloadsOf(item: unknown): Array<Record<string, unknown> | typeof DONE_SENTINEL> {
  if (typeof item === 'string') return payloadsOfText(item);
  if (Buffer.isBuffer(item)) return payloadsOfText(item.toString('utf8'));
  const obj = asRecord(item);
  if (obj === undefined) return [];
  const data = obj['data'];
  if (typeof data === 'string') return payloadsOfText(data);
  return [obj]; // 已经是解析好的 chunk 对象
}

function payloadsOfText(text: string): Array<Record<string, unknown> | typeof DONE_SENTINEL> {
  const out: Array<Record<string, unknown> | typeof DONE_SENTINEL> = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\n/)) {
    if (block.trim() === '') continue;
    const lines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
    }
    if (lines.length === 0) continue;
    const payload = lines.join('\n');
    if (payload === '[DONE]') {
      out.push(DONE_SENTINEL);
      continue;
    }
    const parsed = tryParseJson(payload);
    if (parsed.ok) {
      const record = asRecord(parsed.value);
      if (record !== undefined) out.push(record);
    }
    // 解析失败：跳过该事件，不影响其余转发（20 §4.2 嗅探器同立场）
  }
  return out;
}

/** AdaptorMeta 工厂（40 §1.3：显式登记，集中一处，不做魔法自动发现）。 */
export function openAIChatAdaptorMeta(): AdaptorMeta {
  return {
    format: FORMAT,
    modality: MODALITY,
    version: '1.0.0',
    fixtures: 'adaptors/fixtures/openai-chat',
    unsupported_fields: [
      'params.top_k',
      'params.safety',
      'params.thinking.budget_tokens',
      'params.thinking.include_summary',
      'cache_control',
      'parts.redacted_thinking',
      'parts.search_result',
    ],
    quirks: [
      "system 是 messages[{role:'system'}] 而非顶层字段；developer 角色折叠进 system，多 system 必须全部保留（40 §7.2，llm-bridge 的真实缺陷）",
      'max_tokens 已由 max_completion_tokens 取代（40 §2.2b），编码统一发新名',
      'reasoning_effort 是离散档位，没有连续 budget_tokens（40 §3.1）',
      'reasoning_content 是思考内容的 wire 字段名（DeepSeek 用法）：非流式 message 与流式 delta 都认，双向映射到 canonical thinking part；带 tools 的多轮必须回传否则上游 400',
      'stream_options.include_usage 必须显式打开才有流式 usage（40 §2.3），网关在 S4 自动补',
      'tool_call arguments 是 JSON 字符串，解析失败时 raw_arguments 保留原串（10 §7.3）',
      'function_call finish_reason 已弃用，归一为 other（10 §9.3）',
      '流式 part.begin/part.end 走 meta 帧（ir/stream.ts 的 FrameData 没有对应负载形状）',
    ],
    status: 'implemented',
    supports_lazy_decode: true,
  };
}
