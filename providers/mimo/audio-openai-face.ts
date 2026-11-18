/**
 * providers/mimo/audio-openai-face.ts —— MiMo 音频端点的 **OpenAI 入站脸**（客户端方言层）。
 *
 * 位置说明（与 DeepSeek 侧同款）：这里放「客户端 dialect ↔ 中间形状」的映射，与
 * `adaptors/` 做的是同一类事（dialect 级双向映射），但这两个端点**不进出 pipeline**
 * （没有 Adaptor 实现、没有 S0–S10），所以映射放在 provider 目录、由
 * `http/audio-endpoint.ts` 经 `AudioProviderFace` 接口调用，而不是注册进 adaptor
 * 注册表。上游字段名（`audio.format` / `audio.voice` / `asr_options.language` /
 * `input_audio` / `message.audio.data`）不出本文件。
 *
 * ## 立场：能力矩阵说什么就做什么，不猜、不静默替换
 *
 * | OpenAI 入参 | 我们的行为 |
 * | --- | --- |
 * | `response_format` ∈ {wav, mp3, pcm, pcm16} | 透传（MiMo 原生支持四个） |
 * | `response_format` ∈ {opus, aac, flac} | **400**：上游产不出，不转码 |
 * | `response_format` 省略 | 回落 **wav**（上游默认值；Content-Type 明说是什么） |
 * | `voice` 是预置音色名（`mimo-v2.5-tts`） | 原样透传（上游认的就是这些字符串） |
 * | `voice` 不在预置表里 | **400**：列出可用的名字 |
 * | `voice` 是 data URL / base64（`-voiceclone`） | 当参考音频样本透传 |
 * | `instructions`（仅 `-voicedesign`） | 映射成 user 消息的音色设计描述 |
 * | `instructions`（其余变体） | **400**：上游无该参数 |
 * | `speed` ≠ 1 | **400**：上游无该参数（营销页提过"语速控制"，API 文档的 `audio` 对象里没有） |
 * | 转写 `language` ∈ {auto, zh, en} | 映射到 `asr_options.language` |
 * | 转写 `language` 是别的值 | **400**：上游只认这三个，不静默按 auto 发 |
 * | 转写 `response_format` = srt / vtt | **400**：上游不产出时间轴 |
 * | 转写 `temperature` ≠ 0 / `timestamp_granularities` | **400**：上游无这两个参数 |
 *
 * 转写的 `prompt` 与 DeepSeek 侧同款：canonical 的 asr 形状**建模了**这个字段，收下并
 * 转成 canonical，但 MiMo 的 wire 没有它——**到不了上游**（文档化的缺口，进 quirks）。
 */

import type { CanonicalToolResponse } from '../../ir/index.js';
import {
  AudioModelError,
  type AudioEndpointId,
  type AudioModelResolverDeps,
  type AudioModelTarget,
  type AudioProviderFace,
  type CanonicalSpeechBody,
  type OpenAiTranscriptionFormat,
  type TranscriptionExtras,
  type TranscriptionFields,
} from '../../http/audio-faces.js';
import { ToolRequestError } from '../deepseek/tool-handlers.js';
import {
  MIMO_AUDIO_ACCESS_PATHS,
  MIMO_AUDIO_DEFAULT_MODELS,
  MIMO_AUDIO_MODELS,
  audioModelNamesFor,
  resolveAudioModel,
} from './audio-models.js';
import {
  MIMO_TTS_MODELS,
  MIMO_TTS_PRESET_VOICES,
  ttsMimeType,
  type MiMoTtsFormat,
} from './audio.js';

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
// voice：三种形态（预置名 / 克隆样本 / 设计描述）
// ---------------------------------------------------------------------------

/** OpenAI `voice` → MiMo 预置音色 id（大小写不敏感：上游英文名大小写混用会被抄歪）。 */
export function resolveMiMoVoice(voice: unknown): string {
  if (typeof voice !== 'string' || voice.trim() === '') {
    throw new OpenAiFaceError('missing_voice', '缺少字段 voice（应为非空字符串）');
  }
  const trimmed = voice.trim();
  const hit =
    MIMO_TTS_PRESET_VOICES.find((v) => v === trimmed) ??
    MIMO_TTS_PRESET_VOICES.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  if (hit === undefined) {
    throw new OpenAiFaceError(
      'unmapped_voice',
      `voice ${voice} 不是 MiMo 预置音色：可用 ${MIMO_TTS_PRESET_VOICES.join(' / ')}`,
    );
  }
  return hit;
}

/**
 * 是不是裸 base64（客户端不愿包 data URL 时的逃生门）。
 *
 * 判据只有字符集与长度下限：**不按长度猜容器**（一个 44 字符的假样本与一个 40 KB 的
 * 真样本都是合法 base64，长度说明不了任何事）。下限 16 是为了把明显不是音频的短串
 * （如 `abc`）挡掉，让错误信息说"应该是 data URL 或 base64"而不是别的。
 */
function looksLikeBase64Audio(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

/** data URL / 裸 base64 → (base64, mime)。认不出抛错（不猜容器）。 */
function parseReferenceAudio(value: string): { data_base64: string; content_type: string } {
  const dataUrl = /^data:(audio\/(?:mpeg|mp3|wav));base64,(.+)$/i.exec(value);
  if (dataUrl !== null) {
    const mime = dataUrl[1]!.toLowerCase() === 'audio/mp3' ? 'audio/mpeg' : 'audio/wav';
    return { data_base64: dataUrl[2]!, content_type: mime };
  }
  if (looksLikeBase64Audio(value)) {
    // 容器猜不出来：默认 wav（上游默认 format 也是 wav），但在 quirks 里记明
    return { data_base64: value, content_type: 'audio/wav' };
  }
  throw new OpenAiFaceError(
    'invalid_voice',
    'voiceclone 变体的 voice 应为音频样本：data:audio/wav;base64,... 或裸 base64',
  );
}

// ---------------------------------------------------------------------------
// TTS：/v1/audio/speech
// ---------------------------------------------------------------------------

/** OpenAI `response_format` → MiMo `format`（null = 上游产不出这种容器）。
 *
 * `pcm16` 与 `pcm` 都映射到 `pcm`：官方文档明说「传入 `pcm` 或 `pcm16`，均表示指定使用
 * `pcm16` 格式」，二者同义，所以在 canonical 三值联合（wav/pcm/mp3）里收成一个。
 */
export const OPENAI_TTS_RESPONSE_FORMATS: Readonly<Record<string, MiMoTtsFormat | null>> = {
  wav: 'wav',
  mp3: 'mp3',
  pcm: 'pcm',
  pcm16: 'pcm',
  opus: null,
  aac: null,
  flac: null,
};

/** canonical 三值格式 → MiMo wire 格式（pcm16 在 wire 层与 pcm 同义，见上）。 */
const CANONICAL_TO_MIMO_FORMAT: Readonly<Record<'wav' | 'pcm' | 'mp3', MiMoTtsFormat>> = {
  wav: 'wav',
  pcm: 'pcm',
  mp3: 'mp3',
};

/**
 * MiMo wire 格式 → canonical 三值（`pcm16` 收成 `pcm`，见 OPENAI_TTS_RESPONSE_FORMATS）。
 *
 * 单独一个函数而不是内联在 decode 里：encodeSpeech 要做反向映射，两边必须同源，
 * 否则"请求 pcm 响应 audio/pcm、请求 pcm16 响应 audio/x-pcm16"这种漂移会自己长出来。
 */
function canonicalFormat(format: MiMoTtsFormat): 'wav' | 'pcm' | 'mp3' {
  return format === 'pcm16' ? 'pcm' : format;
}

/**
 * 解析 `response_format` → **canonical 三值**（wav / pcm / mp3）。
 *
 * 省略时回落 `wav`：上游默认值就是 wav（`stream:true` 时才默认 pcm，本轮不做流式），
 * 且回落值通过响应的 Content-Type 明确告知客户端，不存在"客户端以为拿到 mp3"的情况。
 *
 * 返回 canonical 而不是 wire 四值：`pcm16` 与 `pcm` 在官方文档里同义，收成一个之后
 * 整个脸（decode → canonical → encode）只需处理三个值，少一处会漂移的映射。
 */
export function resolveSpeechResponseFormat(format: unknown): 'wav' | 'pcm' | 'mp3' {
  // 回落字面量 'wav' 而不是 MIMO_TTS_DEFAULT_FORMAT：后者是 wire 四值枚举，
  // 这里是 canonical 三值——写成常量会把"canonical 少一个值"这件事藏起来
  if (format === undefined || format === null || format === '') return 'wav';
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
      `response_format ${format} 不受支持：MiMo TTS 只输出 wav/mp3/pcm`,
    );
  }
  return canonicalFormat(target);
}

/**
 * `POST /v1/audio/speech` 的 JSON 体 → 中间形状（`http/audio-faces.ts` 的
 * `CanonicalSpeechBody`）。
 *
 * `model` 决定用哪个 TTS 变体，因此三个变体的字段规则都在这里分支：
 *   - `mimo-v2.5-tts`：`voice` = 预置音色名（缺省 `mimo_default`）；
 *   - `mimo-v2.5-tts-voiceclone`：`voice` = 音频样本（data URL 或裸 base64），必填；
 *   - `mimo-v2.5-tts-voicedesign`：`instructions` = 音色设计描述，必填；不接受 `voice`。
 *
 * 只做 dialect 映射；长度/空串一类的校验交给 canonical handler
 * （tool-handlers.ts 的 ttsHandler.decodeRequest），避免两套限额漂移。
 */
export function decodeOpenAiSpeechRequest(body: unknown): CanonicalSpeechBody {
  const rec = asRecord(body);
  const model = requireTtsModel(rec['model']);
  const format = resolveSpeechResponseFormat(rec['response_format']);
  const input = rec['input'];
  if (typeof input !== 'string' || input.trim() === '') {
    throw new OpenAiFaceError('missing_input', '缺少字段 input（应为非空字符串）');
  }

  const out: CanonicalSpeechBody = { input, voice_id: '', format, model };
  const voice = rec['voice'];
  const instructions = rec['instructions'];

  if (model === MIMO_TTS_MODELS.voicedesign) {
    if (voice !== undefined && voice !== null && voice !== '') {
      throw new OpenAiFaceError(
        'unsupported_parameter',
        'voicedesign 变体不接受 voice：音色由 instructions 描述，上游没有 voice 字段',
      );
    }
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      throw new OpenAiFaceError(
        'missing_instructions',
        'voicedesign 变体必须提供 instructions（音色设计描述）',
      );
    }
    out.voice_design = instructions;
  } else if (model === MIMO_TTS_MODELS.voiceclone) {
    if (typeof voice !== 'string' || voice.trim() === '') {
      throw new OpenAiFaceError(
        'missing_voice',
        'voiceclone 变体必须提供 voice（音频样本：data:audio/wav;base64,... 或裸 base64）',
      );
    }
    const ref = parseReferenceAudio(voice.trim());
    out.reference_audio = ref;
  } else {
    out.voice_id = voice === undefined || voice === null || voice === '' ? 'mimo_default' : resolveMiMoVoice(voice);
  }

  rejectUnsupportedSpeechParams(rec, model);
  return out;
}

/** 上游没有的参数：显式拒绝，不静默丢弃（20 §S2 第 6 步的同款立场）。 */
function rejectUnsupportedSpeechParams(rec: Record<string, unknown>, model: string): void {
  const speed = rec['speed'];
  if (speed !== undefined && speed !== null) {
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw new OpenAiFaceError('invalid_speed', '字段 speed 应在 0.25–4 之间');
    }
    if (speed !== 1) {
      throw new OpenAiFaceError(
        'unsupported_parameter',
        'MiMo TTS 不支持变速（speed）：API 文档的 audio 对象里没有该参数',
      );
    }
  }
  // instructions 只在 voicedesign 变体有落点（user 消息的音色设计描述）
  if (model !== MIMO_TTS_MODELS.voicedesign) {
    const instructions = rec['instructions'];
    if (typeof instructions === 'string' && instructions.trim() !== '') {
      throw new OpenAiFaceError(
        'unsupported_parameter',
        'MiMo TTS 不支持语音指令（instructions）：只有 voicedesign 变体用它描述音色',
      );
    }
  }
}

/** `model` 必须是 TTS 变体之一（大小写不敏感；ASR 模型名打进来要给一句明白话）。 */
function requireTtsModel(model: unknown): string {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new OpenAiFaceError(
      'missing_model',
      `缺少字段 model：本端点可用 ${audioModelNamesFor('tts').join(' / ')}`,
    );
  }
  const hit = MIMO_AUDIO_MODELS.tts.find((m) => m.toLowerCase() === model.trim().toLowerCase());
  if (hit === undefined) {
    if (MIMO_AUDIO_MODELS.asr.some((m) => m.toLowerCase() === model.trim().toLowerCase())) {
      throw new OpenAiFaceError(
        'model_not_found',
        `模型 ${model} 是 ASR 模型，不能用于语音合成（/v1/audio/speech）`,
      );
    }
    throw new OpenAiFaceError(
      'model_not_found',
      `模型 ${model} 不是 MiMo TTS 变体：可用 ${audioModelNamesFor('tts').join(' / ')}`,
    );
  }
  return hit;
}

/** canonical tts 响应 → 音频二进制 + Content-Type。 */
export function encodeOpenAiSpeechResponse(
  res: CanonicalToolResponse,
  format: string,
): { content_type: string; body: Buffer } {
  if (res.endpoint !== 'tts') throw new ToolRequestError('端点不匹配');
  const canonical = CANONICAL_TO_MIMO_FORMAT[format as 'wav' | 'pcm' | 'mp3'];
  if (canonical === undefined) {
    throw new OpenAiFaceError(
      'unsupported_response_format',
      `response_format ${format} 不受支持：MiMo TTS 只输出 wav/mp3/pcm`,
    );
  }
  // Content-Type 按**请求的 format** 定，不按上游回声的头定：上游给的是
  // application/json（音频在 JSON 信封里），照它的头回客户端会直接坏掉
  return {
    content_type: ttsMimeType(canonical),
    body: Buffer.from(res.audio_base64, 'base64'),
  };
}

// ---------------------------------------------------------------------------
// ASR：/v1/audio/transcriptions
// ---------------------------------------------------------------------------

/** OpenAI 转写 `response_format` 三家共用的枚举（null = 上游产不出）。 */
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
      `response_format ${format} 不受支持：MiMo ASR 不产出时间轴字幕`,
    );
  }
  return target;
}

/** MiMo 的语种枚举（官方文档 `asr_options.language`）。 */
export const MIMO_ASR_LANGUAGES: readonly string[] = ['auto', 'zh', 'en'];

/**
 * OpenAI `language` → MiMo `asr_options.language`。
 *
 * 只认 `auto` / `zh` / `en`（大小写不敏感）。**不静默按 auto 发**：客户端传 `ja` 时
 * 上游会 400，网关先拒并列出可用值，比让客户端看到一个上游错误消息更可操作。
 * 省略（undefined）= 上游自己自动检测（官方默认 auto），与显式传 auto 等价。
 */
export function resolveAsrLanguage(language: unknown): string | undefined {
  if (language === undefined || language === null || language === '') return undefined;
  if (typeof language !== 'string') {
    throw new OpenAiFaceError('invalid_language', '字段 language 应为字符串');
  }
  const hit = MIMO_ASR_LANGUAGES.find((l) => l === language.trim().toLowerCase());
  if (hit === undefined) {
    throw new OpenAiFaceError(
      'unsupported_language',
      `language ${language} 不受支持：MiMo ASR 只认 ${MIMO_ASR_LANGUAGES.join(' / ')}`,
    );
  }
  return hit;
}

/** OpenAI 转写表单 → canonical 请求体的 language / prompt（文件字段由调用方从 multipart 取）。 */
export function decodeOpenAiTranscriptionFields(fields: TranscriptionFields): TranscriptionExtras {
  const temperature = fields.temperature;
  if (temperature !== undefined && temperature !== '') {
    const value = Number(temperature);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new OpenAiFaceError('invalid_temperature', '字段 temperature 应在 0–1 之间');
    }
    if (value !== 0) {
      throw new OpenAiFaceError(
        'unsupported_parameter',
        'MiMo ASR 不支持采样温度（temperature）：上游无该参数',
      );
    }
  }
  if (fields.timestamp_granularities !== undefined && fields.timestamp_granularities !== '') {
    throw new OpenAiFaceError(
      'unsupported_parameter',
      'MiMo ASR 不支持时间戳粒度（timestamp_granularities）：上游不返回时间轴',
    );
  }
  const language = resolveAsrLanguage(fields.language);
  return {
    ...(language === undefined ? {} : { language }),
    ...(fields.prompt === undefined || fields.prompt === '' ? {} : { prompt: fields.prompt }),
  };
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
        // language 省略：上游不回传检测到的语种，回显客户端传的值等于谎称"我们检测到了"
        ...(res.duration_seconds === undefined ? {} : { duration: res.duration_seconds }),
        text: res.text,
        // 上游不返回分段：恒为空数组（与 DeepSeek 侧同款立场，缺字段不填 0）
        segments: [],
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

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new OpenAiFaceError('invalid_request', '请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// face 对象（http/audio-faces.ts 的 AudioProviderFace 实现）
// ---------------------------------------------------------------------------

/**
 * MiMo 在 `/v1/audio/*` 上的 OpenAI 脸。
 *
 * 组装顺序：DeepSeek 在前、MiMo 在后（组合根的 `providers` 数组）。两家的模型名不重叠，
 * 顺序只影响错误信息里先列谁。
 */
export const MIMO_AUDIO_FACE: AudioProviderFace = {
  provider: 'mimo',
  accessPath: (endpoint: AudioEndpointId) => MIMO_AUDIO_ACCESS_PATHS[endpoint],
  defaultModel: (endpoint: AudioEndpointId) => MIMO_AUDIO_DEFAULT_MODELS[endpoint],
  modelNames: (endpoint: AudioEndpointId) => audioModelNamesFor(endpoint),
  // 不映射 tts-1 / whisper-1：那两个名字已被 DeepSeek 认领（见 audio-models.ts 文件头）
  openaiModelAliases: () => ({}),
  resolveModel(
    deps: AudioModelResolverDeps,
    model: string,
    endpoint: AudioEndpointId,
  ): AudioModelTarget | undefined {
    try {
      return resolveAudioModel(deps, model, endpoint);
    } catch (err) {
      if (err instanceof AudioModelError) return undefined;
      throw err;
    }
  },
  decodeSpeech: (body) => decodeOpenAiSpeechRequest(body),
  encodeSpeech: (res, format) => encodeOpenAiSpeechResponse(res, format),
  decodeTranscriptionFields: (fields) => decodeOpenAiTranscriptionFields(fields),
  resolveTranscriptionResponseFormat: (format) => resolveTranscriptionResponseFormat(format),
  encodeTranscription: (res, format) => encodeOpenAiTranscriptionResponse(res, format),
  translationsUnsupportedReason:
    'MiMo ASR 不支持翻译（translations）：上游只有同语言转写，没有翻译目标参数',
};
