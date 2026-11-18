/**
 * ir/stream.ts —— 统一流式帧信封（canonical 的第二公民）。
 *
 * 唯一事实来源：docs/design/25-streaming.md §2（帧信封）、§2.1（帧类型与 FrameData 联合）。
 *
 * ⚠️ 命名统一说明：docs/design/10-canonical-schema.md §2 曾用 `CanonicalStreamFrame` 指同一个类型。
 * 本仓库以 25-streaming.md §2 的定义为**唯一形状定义**，统一命名为 `StreamFrame`
 * （`CanonicalStreamFrame` 仅作为兼容别名导出，避免仓库里出现两份形状定义）。
 *
 * 客户端侧 SSE 事件名统一为 `ag.frame`（25 §2.2），新增模态不需要新事件名。
 */

import type { ModalityKind } from './modality.js';
import type { CanonicalError, FinishReason } from './error.js';
import type { CanonicalUsage } from './usage.js';
import type { MediaChunk, MediaRef } from './media.js';
import type { InterimTranscript } from './asr.js';
import type { FormatId } from './format.js';

export type StreamEventType = 'start' | 'delta' | 'end' | 'error' | 'usage' | 'meta';

export interface StreamFrame<E extends StreamEventType = StreamEventType> {
  event: E;
  /** 单调递增，从 0 开始。用于客户端乱序检测与断线重传定位。 */
  seq: number;
  request_id: string;
  kind: ModalityKind;
  data: FrameData;
  /** 帧产生时间（网关侧，epoch ms）。 */
  ts: number;
}

/** 兼容别名：10-canonical-schema.md §2 的旧名，形状与 StreamFrame 完全相同。 */
export type CanonicalStreamFrame<E extends StreamEventType = StreamEventType> = StreamFrame<E>;

export type FrameData =
  StartData | DeltaData | PartBeginData | PartEndData | EndData | ErrorData | UsageData | MetaData;

export interface StartData {
  /** 会话/轮次标识；ASR 下为 utterance_id 的容器。 */
  session_id?: string;
  model: string;
  /** 客户端格式 + 上游格式（透传模式下仍记录）。 */
  client_format: FormatId;
  provider_format: FormatId;
  /** 声明的模态能力子集。 */
  capabilities?: string[];
}

/** delta 的 payload 由 kind 决定。 */
export type DeltaData =
  | {
      kind: 'chat';
      /** 所属 part 的序号（part.begin 时分配）。缺省 0。 */
      index?: number;
      text?: string;
      thinking?: string;
      tool_input_json?: string;
      refusal?: string;
      /**
       * 工具调用的**权威标识**（可选，2026-11-16 加，42 §4.3 的 D2）。
       *
       * 为什么需要它：OpenAI Responses 的 `response.function_call_arguments.delta`
       * 必须带 `item_id` 才能归位——并行工具调用时只有参数增量而没有 item 标识，
       * 就无法重建哪个调用属于哪个 `function_call`。`index` 是 part 序号，
       * **不是** item 标识（ Responses 的 item id 是 `fc_…` 形态的独立字符串）。
       *
       * 这是 12 §3 规则 F5 第 3 步的「新增一个可选字段」：**纯加法**——不改现有字段、
       * 不改联合成员、不影响 `additionalProperties: false`，也不需要 bump `ir_version`。
       * 没有该字段的帧（OpenAI Chat / Anthropic 路径）行为与历史版本完全一致。
       */
      tool_call_id?: string;
      /** part 边界（S8 把 part.begin / part.end 转成 delta 帧时携带）。 */
      part?: StreamPart;
      phase?: 'begin' | 'end';
    }
  | { kind: 'tts'; audio: MediaChunk }
  | { kind: 'asr'; transcript: InterimTranscript }
  | { kind: 'image'; progress?: number; partial?: MediaRef; index: number }
  | { kind: 'embedding'; vector_chunk?: number[]; index: number }
  | { kind: 'moderation'; scores: Record<string, number>; index: number };

/**
 * part 开始帧（20 §S6 的 `part.begin`）。
 *
 * 为什么需要它：Anthropic 的 `content_block_start{type:"tool_use"}` 带 id 与 name，
 * 是整个 tool_use 的"开户"事件；丢掉它，客户端侧重写出的 SSE 就没有
 * `content_block_start`，tool_call 会变成悬空的参数增量。
 */
export interface PartBeginData {
  kind: 'chat';
  index: number;
  part: StreamPart;
}

/** part 结束帧（20 §S6 的 `part.end`）——完整 part 在此成型（流式 tool_use 靠它保证 JSON 完整）。 */
export interface PartEndData {
  kind: 'chat';
  index: number;
  part: StreamPart;
}

export interface EndData {
  /** 归一化 finish_reason；ASR 下为 "final"。 */
  finish_reason: FinishReason;
  /**
   * 流尾 usage（20 §S6 的 finish 事件带 usage；OpenAI Chat 的 usage 只在最后一个 chunk，
   * 且需 `stream_options.include_usage`——网关在 S4 自动补上，40 §2.3）。
   * 与独立的 `usage` 帧并存：后者可能多次到达，取最后一次非空（25 §8.3 规则 5）。
   */
  usage?: CanonicalUsage;
  /** 完整载荷的摘要（可选）。 */
  output?: unknown;
}

export interface ErrorData {
  error: CanonicalError;
  /** 该错误是否已使输出不可用。 */
  fatal: boolean;
}

export interface UsageData {
  usage: CanonicalUsage;
}

export interface MetaData {
  /** 非内容性元信息：cache 命中、降级说明、provider 切换等。 */
  notes?: Record<string, unknown>;
  warnings?: string[];
}

/**
 * S6 产出的规范流事件（20-pipeline.md §S6）。
 * 各 provider 的原生流事件折叠进这 7 种事件，是 codec 的核心工作。
 */
export type CanonicalStreamEvent =
  | { type: 'start'; message: MessageMeta }
  | { type: 'part.begin'; index: number; part: StreamPart }
  | { type: 'part.delta'; index: number; delta: PartDelta }
  | { type: 'part.end'; index: number; part: StreamPart }
  | { type: 'usage'; usage: CanonicalUsage }
  | { type: 'finish'; finish_reason: FinishReason; usage: CanonicalUsage }
  | { type: 'error'; error: CanonicalError };

export interface MessageMeta {
  id?: string;
  model: string;
  role: 'assistant';
}

/** part 级别的流式增量。 */
export type PartDelta =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_input_json'; partial_json: string }
  | { type: 'refusal'; refusal: string };

/** 流式里出现的 part（与 ir/chat.ts 的 Part 同源，这里只引用需要的子集形状）。 */
export type StreamPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      raw_arguments?: string;
    }
  | { type: 'refusal'; reason: string }
  | { type: 'unknown'; raw_type?: string; raw: unknown };

/**
 * SSE 序列化/反序列化（25 §2.2）。
 * 网关对客户端暴露为 SSE 时事件名统一为 `ag.frame`；`nativeEventNames` 模式下只改 `event:` 行。
 */
export const AG_FRAME_EVENT_NAME = 'ag.frame';

export function frameToSse(frame: StreamFrame, nativeEventNames = false): string {
  const event = nativeEventNames ? nativeEventNameFor(frame) : AG_FRAME_EVENT_NAME;
  return `event: ${event}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * 原生事件名映射（仅 OpenAI 事件名族的客户端需要）。
 *
 * 注：`StreamFrame.data` 在类型上是整个 `FrameData` 联合（帧类型与负载未做判别式绑定，
 * 以保持 25 §2 的形状不变），因此在已由 `event` 收窄的分支里显式断言负载类型。
 */
function nativeEventNameFor(frame: StreamFrame): string {
  switch (frame.event) {
    case 'start':
      return 'message_start';
    case 'delta': {
      const data = frame.data as DeltaData;
      if (data.kind === 'chat' && data.tool_input_json !== undefined) {
        return 'content_block_delta';
      }
      return 'content_block_delta';
    }
    case 'end':
      return 'message_stop';
    case 'usage':
      return 'message_delta';
    case 'error':
      return 'error';
    case 'meta':
      return 'meta';
  }
}

/** 解析一段 SSE 文本为帧列表（`data:` 多行按 SSE 规范拼接；`[DONE]` 哨兵忽略）。 */
export function parseSseFrames(text: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  for (const block of text.split(/\n\n/)) {
    if (block.trim() === '') continue;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;
    try {
      frames.push(JSON.parse(payload) as StreamFrame);
    } catch {
      // 解析失败不影响转发（20 §4.2 嗅探器同立场）
    }
  }
  return frames;
}
