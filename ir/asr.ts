/**
 * ir/asr.ts —— ASR 模态 payload。
 *
 * 唯一事实来源：docs/design/15-modalities.md §3（含 §3.3 中间态语义）。
 * 中间态（interim）语义见 docs/design/25-streaming.md §5：按 utterance_id 定位、
 * 按 revision 覆盖，**不是 append**。
 */

import type { MediaRef } from './media.js';
import type { StreamOptions } from './envelope.js';
import type { RawEnvelope } from './envelope.js';

export interface AsrPayload {
  /** 音频输入。 */
  audio: MediaRef;
  /** 语言提示（BCP-47；不给则上游自动检测）。 */
  language?: string;
  /** 提示词/领域词（OpenAI prompt / Deepgram keywords / AssemblyAI word_boost）。 */
  prompt?: string;
  keywords?: string[];
  /** 输出粒度。 */
  granularity?: ('word' | 'segment' | 'utterance')[];
  /** 说话人分离。 */
  diarization?: {
    enabled: boolean;
    speakers_expected?: number;
    min_speakers?: number;
    max_speakers?: number;
  };
  /** 标点/格式化。 */
  punctuate?: boolean;
  format_text?: boolean;
  /** 去口语填充词（AssemblyAI disfluencies）。 */
  remove_disfluencies?: boolean;
  /** 流式（实时）。 */
  stream?: StreamOptions;
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface AsrResponsePayload {
  /** 全文（最终）。 */
  text: string;
  /** 检测到的语言。 */
  language?: string;
  /** 音频时长（秒）——ASR 计费主单位。 */
  duration_seconds?: number;
  /** 分段。 */
  segments?: AsrSegment[];
  /** 话语段（按说话人/静音切分）。 */
  utterances?: AsrUtterance[];
  /** 整段置信度。 */
  confidence?: number;
}

export interface AsrSegment {
  id: number;
  /** 秒。 */
  start: number;
  end: number;
  text: string;
  confidence?: number;
  words?: AsrWord[];
  speaker?: number;
}

export interface AsrUtterance {
  /** 话语段 id，中间态语义见 25-streaming.md §5。 */
  utterance_id: string;
  start: number;
  end: number;
  text: string;
  confidence?: number;
  speaker?: number;
  words?: AsrWord[];
}

export interface AsrWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
  /** 词是否已 final（流式下）。 */
  is_final?: boolean;
}

/**
 * 实时 ASR 的中间态（25-streaming.md §5）。
 * 客户端处理规则：按 utterance_id 定位、按 revision 覆盖；is_final: true 后该段不再有后续帧。
 */
export interface InterimTranscript {
  utterance_id: string;
  /** 该段的修订号，从 0 开始单调递增。 */
  revision: number;
  is_final: boolean;
  text: string;
  /** 相对会话开始的起止时间（秒）。 */
  start: number;
  end: number;
  confidence?: number;
  /** 词级时间戳。 */
  words?: Array<{ text: string; start: number; end: number; confidence: number; speaker?: number }>;
  /** 说话人（diarization 开启时）。 */
  speaker?: number;
  language?: string;
}
