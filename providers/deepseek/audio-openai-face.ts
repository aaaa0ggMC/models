/**
 * providers/deepseek/audio-openai-face.ts —— 音频端点的 **OpenAI 入站脸**（客户端方言层）。
 *
 * 位置说明：这里放的是「客户端 dialect ↔ canonical」的映射，与 `adaptors/` 做的是同一类
 * 事（dialect 级双向映射），但这两个端点**不进出 pipeline**（没有 Adaptor 实现、没有
 * S0–S10），所以映射放在 provider 目录、由 http/audio-endpoint.ts 调用，而不是注册进
 * adaptor 注册表。上游字段名（voice_id / format）不出本文件。
 *
 * ## 立场：能力矩阵说什么就做什么，不猜、不静默替换
 *
 * | OpenAI 入参 | 我们的行为 |
 * | --- | --- |
 * | `response_format` ∈ {wav, pcm} | 透传（DeepSeek 原生支持） |
 * | `response_format` ∈ {mp3, opus, aac, flac} | **400**：上游只输出 wav/pcm，不转码 |
 * | `response_format` 省略 | 回落 **wav**（OpenAI 本家默认 mp3，我们给不了；响应 Content-Type 明说是什么） |
 * | `voice` 在映射表里 | 映射到 DeepSeek voice_id |
 * | `voice` 不在映射表里 | **400**：列出可用的名字 |
 * | `speed` ≠ 1 / `instructions` 非空 | **400**：上游无这两个参数 |
 * | 转写 `response_format` = srt / vtt | **400**：上游不产出时间轴 |
 * | 转写 `temperature` ≠ 0 / `timestamp_granularities` | **400**：上游无这两个参数 |
 *
 * 转写的 `language` / `prompt` 是个例外：canonical 的 asr 形状**建模了**这两个字段
 * （ir/tool-endpoints.ts），所以收下并转成 canonical；但 DeepSeek ASR 的 wire 只有
 * `file` 一个字段，它们**到不了上游**（语种自动检测）。这是 canonical 脸既有的事实，
 * 本轮不改 canonical 形状，只在能力条目的 quirks 与本报告里写明。
 *
 * ## 多上游（2026-11 随 MiMo 接入）
 *
 * 本文件同时导出 `DEEPSEEK_AUDIO_FACE`——把上面这些函数按
 * `http/audio-faces.ts` 的 `AudioProviderFace` 接口收成一个对象，http 层按顺序问
 * 每家 face。共享的中间形状（`CanonicalSpeechBody`）也从那个文件 import，
 * 不再在本文件定义（否则两家会各有一份漂移的形状）。
 */

import type { CanonicalToolResponse } from '../../ir/index.js';
import type {
  AudioEndpointId,
  AudioProviderFace,
  CanonicalSpeechBody,
  OpenAiTranscriptionFormat,
  TranscriptionFields,
} from '../../http/audio-faces.js';
import { AudioModelError } from '../../http/audio-faces.js';
import { ToolRequestError } from './tool-handlers.js';
import {
  DEEPSEEK_TTS_DEFAULT_FORMAT,
  ttsMimeType,
  type DeepSeekTtsFormat,
  type DeepSeekTtsVoiceId,
} from './tts.js';
import {
  DEEPSEEK_AUDIO_ACCESS_PATHS,
  DEEPSEEK_AUDIO_MODELS,
  OPENAI_AUDIO_MODEL_ALIASES,
  audioModelNamesFor,
  resolveAudioModel,
} from './audio-models.js';

/**
 * 中间形状与转写格式枚举从 http/audio-faces.ts 再出口（既有 import 路径不变；
 * 定义已移到那里，否则两家 upstream 会各有一份漂移的形状）。
 */
export type { CanonicalSpeechBody, OpenAiTranscriptionFormat, TranscriptionFields };

// ---------------------------------------------------------------------------
// 错误（HTTP 层映射成 400 + OpenAI 风格信封；code 逐类不同，便于客户端分支处理）
// ---------------------------------------------------------------------------

/** OpenAI 脸特有的请求错误（code 进错误信封，与 canonical 的 ToolRequestError 分开）。 */
export class OpenAiFaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAiFaceError';
  }
}

// ---------------------------------------------------------------------------
// voice 映射
// ---------------------------------------------------------------------------

/**
 * OpenAI 嗓音名 → DeepSeek `voice_id`。
 *
 * **这不是音色克隆，是就近映射**：OpenAI 有十来个嗓音，DeepSeek 只有两个
 * （stella 女声 / tide 男声）。映射依据是 OpenAI 官方对各嗓音的描述（性别/音色），
 * 同一个 OpenAI 嗓音在不同批次里也可能不完全一致。要可查：`listOpenAiTtsVoices()`；
 * 要扩展：往这张表里加一行即可（不需要改任何逻辑）。
 *
 * 后两项是 DeepSeek 原生 voice_id 的直通（逃生门）：客户端已知上游只有两个音色时，
 * 可以直接指定，省得猜哪个 OpenAI 名字映射到它。
 */
export const OPENAI_TTS_VOICE_MAP: Readonly<Record<string, DeepSeekTtsVoiceId>> = {
  // OpenAI 官方描述为女声/中性 → stella（女声）
  alloy: 'stella',
  nova: 'stella',
  shimmer: 'stella',
  sage: 'stella',
  coral: 'stella',
  // OpenAI 官方描述为男声 → tide（男声）
  ash: 'tide',
  ballad: 'tide',
  echo: 'tide',
  fable: 'tide',
  onyx: 'tide',
  verse: 'tide',
  // DeepSeek 原生 voice_id 直通
  stella: 'stella',
  tide: 'tide',
};

/** 全部可用的 voice 名（错误信息与文档用；顺序稳定 = 表的插入顺序）。 */
export function listOpenAiTtsVoices(): Array<{ openai: string; deepseek: DeepSeekTtsVoiceId }> {
  return Object.entries(OPENAI_TTS_VOICE_MAP).map(([openai, deepseek]) => ({ openai, deepseek }));
}

/**
 * OpenAI `voice` → DeepSeek `voice_id`。未映射 → 400（列全可用名，一行放下）。
 *
 * 大小写不敏感（`Nova` 与 `nova` 是同一个嗓音；客户端从文档抄名字时大小写经常漂）。
 */
export function resolveOpenAiVoice(voice: unknown): DeepSeekTtsVoiceId {
  if (typeof voice !== 'string' || voice.trim() === '') {
    throw new OpenAiFaceError('missing_voice', '缺少字段 voice（应为非空字符串）');
  }
  const hit = OPENAI_TTS_VOICE_MAP[voice] ?? OPENAI_TTS_VOICE_MAP[voice.trim().toLowerCase()];
  if (hit === undefined) {
    throw new OpenAiFaceError(
      'unmapped_voice',
      `voice ${voice} 未映射：可用 ${Object.keys(OPENAI_TTS_VOICE_MAP).join('/')}`,
    );
  }
  return hit;
}

// ---------------------------------------------------------------------------
// TTS：/v1/audio/speech
// ---------------------------------------------------------------------------

/** OpenAI `response_format` → DeepSeek `format`（null = 上游产不出这种容器）。 */
export const OPENAI_TTS_RESPONSE_FORMATS: Readonly<Record<string, DeepSeekTtsFormat | null>> = {
  wav: 'wav',
  pcm: 'pcm',
  mp3: null,
  opus: null,
  aac: null,
  flac: null,
};

/**
 * 解析 `response_format`。
 *
 * 省略时回落 `wav`：OpenAI 本家默认 mp3，而 DeepSeek 产不出 mp3——为一个**省略的**
 * 可选字段报错会让所有不显式传格式的客户端直接不可用。回落值通过响应的 Content-Type
 * 明确告知客户端（audio/wav），不存在"客户端以为拿到 mp3"的情况。
 */
export function resolveSpeechResponseFormat(format: unknown): DeepSeekTtsFormat {
  if (format === undefined || format === null) return DEEPSEEK_TTS_DEFAULT_FORMAT;
  if (typeof format !== 'string') {
    throw new OpenAiFaceError('invalid_response_format', '字段 response_format 应为字符串');
  }
  const target = OPENAI_TTS_RESPONSE_FORMATS[format.toLowerCase()];
  if (target === undefined) {
    throw new OpenAiFaceError(
      'unsupported_response_format',
      `response_format ${format} 不是 OpenAI 的合法值（wav/pcm/mp3/opus/aac/flac）`,
    );
  }
  if (target === null) {
    throw new OpenAiFaceError(
      'unsupported_response_format',
      `response_format ${format} 不受支持：DeepSeek TTS 只输出 wav/pcm`,
    );
  }
  return target;
}

/** OpenAI speech 请求体 → canonical 工具请求体（`/v1/tools/tts` 的形状）。 */

/**
 * `POST /v1/audio/speech` 的 JSON 体 → canonical tts 请求体。
 *
 * 只做 dialect 映射；长度/空串一类的校验交给 canonical handler（tool-handlers.ts 的
 * ttsHandler.decodeRequest），避免两套限额漂移。
 */
export function decodeOpenAiSpeechRequest(body: unknown): CanonicalSpeechBody {
  const rec = asRecord(body);
  const voice = resolveOpenAiVoice(rec['voice']);
  const format = resolveSpeechResponseFormat(rec['response_format']);
  const input = rec['input'];
  if (typeof input !== 'string' || input.trim() === '') {
    throw new OpenAiFaceError('missing_input', '缺少字段 input（应为非空字符串）');
  }
  rejectUnsupportedSpeechParams(rec);
  return { input, voice_id: voice, format };
}

/** 上游没有的参数：显式拒绝，不静默丢弃（20 §S2 第 6 步的同款立场）。 */
function rejectUnsupportedSpeechParams(rec: Record<string, unknown>): void {
  const speed = rec['speed'];
  if (speed !== undefined && speed !== null) {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw new OpenAiFaceError('invalid_speed', '字段 speed 应在 0.25–4 之间');
    }
    if (speed !== 1) {
      throw new OpenAiFaceError(
        'unsupported_parameter',
        'DeepSeek TTS 不支持变速（speed）：上游无该参数',
      );
    }
  }
  const instructions = rec['instructions'];
  if (typeof instructions === 'string' && instructions.trim() !== '') {
    throw new OpenAiFaceError(
      'unsupported_parameter',
      'DeepSeek TTS 不支持语音指令（instructions）：上游无该参数',
    );
  }
}

/** canonical tts 响应 → 音频二进制 + Content-Type。 */
export function encodeOpenAiSpeechResponse(
  res: CanonicalToolResponse,
  format: DeepSeekTtsFormat,
): { content_type: string; body: Buffer } {
  if (res.endpoint !== 'tts') throw new ToolRequestError('端点不匹配');
  // Content-Type 按**请求的 format** 定，不按上游回声的头定：上游缺失或写错头时，
  // 客户端拿到的仍是一个自洽的响应（请求 wav 就一定是 audio/wav）
  return {
    content_type: ttsMimeType(format),
    body: Buffer.from(res.audio_base64, 'base64'),
  };
}

// ---------------------------------------------------------------------------
// ASR：/v1/audio/transcriptions
// ---------------------------------------------------------------------------

/** OpenAI 转写 `response_format` 枚举（null = 上游产不出）。 */

export const OPENAI_TRANSCRIPTION_RESPONSE_FORMATS: Readonly<
  Record<string, OpenAiTranscriptionFormat | null>
> = {
  json: 'json',
  text: 'text',
  verbose_json: 'verbose_json',
  srt: null,
  vtt: null,
};

/** 省略时 OpenAI 默认 json；我们同样默认 json。 */
export function resolveTranscriptionResponseFormat(format: unknown): OpenAiTranscriptionFormat {
  if (format === undefined || format === null || format === '') return 'json';
  if (typeof format !== 'string') {
    throw new OpenAiFaceError('invalid_response_format', '字段 response_format 应为字符串');
  }
  const target = OPENAI_TRANSCRIPTION_RESPONSE_FORMATS[format.toLowerCase()];
  if (target === undefined) {
    throw new OpenAiFaceError(
      'unsupported_response_format',
      `response_format ${format} 不是 OpenAI 的合法值（json/text/verbose_json）`,
    );
  }
  if (target === null) {
    throw new OpenAiFaceError(
      'unsupported_response_format',
      `response_format ${format} 不受支持：DeepSeek ASR 不产出时间轴字幕`,
    );
  }
  return target;
}

/** multipart 字段 → canonical asr 请求体（`/v1/tools/asr` 的形状）。 */
export interface CanonicalTranscriptionBody {
  audio: { filename: string; content_type: string; data_base64: string };
  language?: string;
  prompt?: string;
}

/** OpenAI 转写表单 → canonical 请求体（文件字段由调用方从 multipart 里取）。 */
export function decodeOpenAiTranscriptionFields(fields: {
  language?: string;
  prompt?: string;
  temperature?: string;
  timestamp_granularities?: string;
}): Pick<CanonicalTranscriptionBody, 'language' | 'prompt'> {
  const temperature = fields.temperature;
  if (temperature !== undefined && temperature !== '') {
    const value = Number(temperature);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new OpenAiFaceError('invalid_temperature', '字段 temperature 应在 0–1 之间');
    }
    if (value !== 0) {
      throw new OpenAiFaceError(
        'unsupported_parameter',
        'DeepSeek ASR 不支持采样温度（temperature）：上游无该参数',
      );
    }
  }
  if (fields.timestamp_granularities !== undefined && fields.timestamp_granularities !== '') {
    throw new OpenAiFaceError(
      'unsupported_parameter',
      'DeepSeek ASR 不支持时间戳粒度（timestamp_granularities）：上游不返回时间轴',
    );
  }
  return {
    ...(fields.language === undefined || fields.language === ''
      ? {}
      : { language: fields.language }),
    ...(fields.prompt === undefined || fields.prompt === '' ? {} : { prompt: fields.prompt }),
  };
}

/** OpenAI 分段形状里我们真的能给的字段（不编 avg_logprob / compression_ratio）。 */
export interface OpenAiTranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  /** 上游给了置信度才出现。 */
  confidence?: number;
}

/**
 * canonical 响应 `raw` 里的分段 → OpenAI `segments`。
 *
 * **上游（DeepSeek ASR）当前不返回分段**，所以这个函数在现网上永远返回 `[]`——留着它
 * 是因为"若上游给"这件事必须有个明确的落点：上游哪天加了 `segments`，改
 * tool-handlers.ts 的 raw 透传即可，HTTP 脸不用动。缺字段的分片会被跳过而不是
 * 填 0（0 是一个合法的起止时间，填了就说谎）。
 */
export function toOpenAiSegments(raw: unknown): OpenAiTranscriptionSegment[] {
  const rawSegments = (raw as { segments?: unknown } | undefined)?.segments;
  if (!Array.isArray(rawSegments)) return [];
  const out: OpenAiTranscriptionSegment[] = [];
  for (const [index, entry] of rawSegments.entries()) {
    const rec = asRecord(entry);
    const start = numberOrUndefined(rec['start']);
    const end = numberOrUndefined(rec['end']);
    const text = typeof rec['text'] === 'string' ? rec['text'] : undefined;
    if (start === undefined || end === undefined || text === undefined) continue;
    const confidence = numberOrUndefined(rec['confidence']);
    out.push({
      id: numberOrUndefined(rec['id']) ?? index,
      start,
      end,
      text,
      ...(confidence === undefined ? {} : { confidence }),
    });
  }
  return out;
}

/** canonical asr 响应 → OpenAI 转写响应（JSON 或纯文本）。 */
export function encodeOpenAiTranscriptionResponse(
  res: CanonicalToolResponse,
  format: OpenAiTranscriptionFormat,
): { content_type: string; body: string } {
  if (res.endpoint !== 'asr') throw new ToolRequestError('端点不匹配');

  if (format === 'text') {
    return { content_type: 'text/plain; charset=utf-8', body: res.text };
  }

  if (format === 'verbose_json') {
    return {
      content_type: 'application/json; charset=utf-8',
      body: JSON.stringify({
        task: 'transcribe',
        // language 省略：上游做语种自动检测且不回传，回显客户端传的值等于谎称"我们检测到了"
        ...(res.duration_seconds === undefined ? {} : { duration: res.duration_seconds }),
        text: res.text,
        segments: toOpenAiSegments(res.raw),
      }),
    };
  }

  return {
    content_type: 'application/json; charset=utf-8',
    body: JSON.stringify({ text: res.text }),
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 字符串 format → DeepSeek 的 wire 格式枚举。
 *
 * http 层传进来的是 `CanonicalSpeechBody.format`（三值联合），而 DeepSeek 只产
 * wav/pcm。走一遍显式收窄而不是 `as`：`decodeSpeech` 已经拒掉 mp3，这里是双保险，
 * 万一将来有人改了入口，错误信息仍然说人话（而不是把 mp3 静默当成 wav 返回）。
 */
function narrowDeepSeekFormat(format: string): DeepSeekTtsFormat {
  if (format === 'pcm') return 'pcm';
  if (format === 'wav') return 'wav';
  throw new OpenAiFaceError(
    'unsupported_response_format',
    `response_format ${format} 不受支持：DeepSeek TTS 只输出 wav/pcm`,
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new OpenAiFaceError('invalid_request', '请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// face 对象（http/audio-faces.ts 的 AudioProviderFace 实现）
// ---------------------------------------------------------------------------

/**
 * DeepSeek 在 `/v1/audio/*` 上的 OpenAI 脸。
 *
 * 组装顺序（组合根的 `providers` 数组）：DeepSeek 在前、MiMo 在后。两家的模型名不重叠
 * （`deepseek-tts` / `tts-1` / `whisper-1` vs `mimo-v2.5-tts` / `mimo-v2.5-asr`），
 * 顺序只影响错误信息里先列谁。
 *
 * `resolveModel` 把"这家不认"变成 `undefined` 而不是抛错：多上游时那是正常控制流
 * （http 层要继续问下一家），单上游语义由内部的 `resolveAudioModel` 保证不变。
 */
export const DEEPSEEK_AUDIO_FACE: AudioProviderFace = {
  provider: 'deepseek',
  accessPath: (endpoint) => DEEPSEEK_AUDIO_ACCESS_PATHS[endpoint],
  defaultModel: (endpoint) => DEEPSEEK_AUDIO_MODELS[endpoint],
  modelNames: (endpoint) => audioModelNamesFor(endpoint),
  openaiModelAliases: () => ({ ...OPENAI_AUDIO_MODEL_ALIASES }),
  resolveModel(deps, model, endpoint) {
    try {
      return resolveAudioModel(deps, model, endpoint);
    } catch (err) {
      if (err instanceof AudioModelError) return undefined;
      throw err;
    }
  },
  decodeSpeech: (body) => decodeOpenAiSpeechRequest(body),
  encodeSpeech(res, format) {
    return encodeOpenAiSpeechResponse(res, narrowDeepSeekFormat(format));
  },
  decodeTranscriptionFields(fields: TranscriptionFields) {
    return decodeOpenAiTranscriptionFields(fields);
  },
  resolveTranscriptionResponseFormat(format: unknown) {
    return resolveTranscriptionResponseFormat(format);
  },
  encodeTranscription(res, format) {
    return encodeOpenAiTranscriptionResponse(res, format);
  },
  translationsUnsupportedReason:
    'DeepSeek ASR 不支持翻译（translations）：上游只做同语言转写，没有翻译目标参数',
};

/** face 用到的端点 id 集合（供组合根与测试引用，避免各处各写一遍字面量）。 */
export const DEEPSEEK_AUDIO_ENDPOINT_IDS: readonly AudioEndpointId[] = ['tts', 'asr'];
