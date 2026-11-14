/**
 * ir/tts.ts —— TTS 模态 payload。
 *
 * 唯一事实来源：docs/design/15-modalities.md §2（含 §2.3 流式语义）。
 * 字段映射示例见同文 §9.1（openai.audio.speech + elevenlabs.tts 写透）。
 *
 * 设计说明：`prosody.ssml` 是逃生舱——Azure 的 SSML 表达力远超结构化字段，
 * 硬建模 SSML 会让 canonical 爆炸。给了 ssml 就走 Azure 路线，结构化字段忽略并 warnings。
 */

import type { MediaRef } from "./media.js";
import type { StreamOptions } from "./envelope.js";
import type { RawEnvelope } from "./envelope.js";

export interface TtsPayload {
  /** 要合成的文本。 */
  input: string;
  /** 声音规格。 */
  voice: VoiceSpec;
  /** 输出音频格式。 */
  output: AudioOutputSpec;
  /** 语言（BCP-47，如 "zh-CN"）。 */
  language?: string;
  /** 语速 0.25–4.0，1.0 = 正常。 */
  speed?: number;
  /** 音调 / 音量 / 稳定性等，按 target 映射。 */
  prosody?: ProsodySpec;
  /** 流式。 */
  stream?: StreamOptions;
  /** 上游专有配置逃逸阀。 */
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface VoiceSpec {
  /** 上游 voice id（alloy / nova / 21m00Tcm4TlvDq8ikWAM / ...）。 */
  voice_id: string;
  /** 声音性别/年龄等元信息（仅记录，不映射）。 */
  gender?: "male" | "female" | "neutral";
  /** 参考音频（声音克隆）——三态引用。 */
  reference_audio?: MediaRef;
  /** 相似度/稳定性等（ElevenLabs voice_settings）。 */
  settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

export interface AudioOutputSpec {
  /** 容器/编码：mp3 / opus / aac / flac / wav / pcm / mulaw / alaw。 */
  format: string;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  /** kbps。 */
  bitrate?: number;
  /** 一次性 or 流式。 */
  mode: "once" | "stream";
}

export interface ProsodySpec {
  /** 音调（Azure prosody pitch / Google pitch，相对量或半音）。 */
  pitch?: number;
  /** 音量（Google volumeGain, dB）。 */
  volume_gain?: number;
  /** 情感/风格指令（OpenAI gpt-4o-mini-tts instructions）。 */
  instructions?: string;
  /** SSML 原文（Azure 路线；给了就走 SSML，忽略结构化字段）。 */
  ssml?: string;
  /** 发音词典（MiniMax pronunciation_dict）。 */
  pronunciation_dict?: Array<{ word: string; pronunciation: string }>;
  /** 前后文（ElevenLabs previous_text / next_text，用于连贯性）。 */
  context?: { previous?: string; next?: string };
  seed?: number;
}

export interface TtsResponsePayload {
  /** 合成的音频。 */
  audio: MediaRef;
  /** 上游返回的格式（可能与请求不同）。 */
  actual_format: AudioOutputSpec;
  /** 音频时长（秒），用于计费兜底。 */
  duration_seconds?: number;
  /** 上游原始响应头里的 id（history-item-id / request-id）。 */
  upstream_request_id?: string;
}
