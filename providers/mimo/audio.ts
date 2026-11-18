/**
 * providers/mimo/audio.ts —— MiMo TTS / ASR 的 wire codec + 薄客户端。
 *
 * **这不是 chat pipeline 的一部分**（同 providers/deepseek/search.ts 的立场）：不实现
 * Adaptor 接口、不进 registry、不走 S0–S10。它是 standalone wire codec + 薄客户端，
 * canonical↔wire 的装配在 tool-handlers.ts，客户端 dialect 编解码在
 * audio-openai-face.ts。
 *
 * ## 形状：没有独立 REST 端点，全部走 `/v1/chat/completions`
 *
 * 穷举 `/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/tts`、`/v1/asr`、
 * `/v1/speech`、`/v1/audio/*` 等 20+ 个路径（GET/POST 都试）**全部 404**——MiMo 的
 * 音频能力不在独立端点上，而是 Chat Completions 按 `model` 分发。官方文档两页
 * （Speech-Recognition-post / tts-post）的「请求地址」写的都是
 * `https://<host>/v1/chat/completions`。逐条实测记录见 MIMO-INTEGRATION-REPORT.md §3。
 *
 * ### TTS（model = mimo-v2.5-tts | -voiceclone | -voicedesign）
 *
 * ```json
 * {
 *   "model": "mimo-v2.5-tts",
 *   "messages": [
 *     {"role":"user","content":"<音色设计描述 / 提示>"},
 *     {"role":"assistant","content":"<要合成的文本>"}
 *   ],
 *   "audio": {"format":"wav","voice":"mimo_default"},
 *   "max_tokens": 2048
 * }
 * ```
 * 响应：`choices[0].message.audio = {id, data(base64 音频), transcript, expires_at}`，
 * `message.content` 是空串。usage 是标准 token 形状（音频模型不计音频秒）。
 *
 * ### ASR（model = mimo-v2.5-asr）
 *
 * ```json
 * {
 *   "model": "mimo-v2.5-asr",
 *   "messages": [{"role":"user","content":[
 *     {"type":"input_audio","input_audio":{"data":"data:audio/wav;base64,<b64>","format":"wav"}}
 *   ]}],
 *   "asr_options": {"language":"auto"},
 *   "max_tokens": 64
 * }
 * ```
 * 响应：`choices[0].message.content` = 转写文本；`message.audio` = null。
 * usage 顶层有 `seconds`（音频时长秒）——**ASR 计费主单位**（官方 ¥0.5/音频小时）。
 *
 * ## 计费口径
 *
 * | 端点 | 上游计费 | canonical units | 说明 |
 * |---|---|---|---|
 * | tts | Token Plan 价格页（限时免费，2026-11-16 核对） | `characters: {input, billed}` | 上游不给字符数，网关侧按合成文本算（与 DeepSeek TTS 同口径，但 MiMo 没有"CJK 每字 2"的规则，按字符数 1:1） |
 * | asr | ¥0.5 / 音频小时 | `audio_seconds: {input, billed}` | `usage.seconds` 是唯一依据 |
 *
 * `characters` 的 `input` 与 `billed` 同值：上游没有"输入字符 / 计费字符"的区分概念
 * （DeepSeek 有"CJK 每字 2"，MiMo 价格页没有这条规则），原始字符数另进 `raw`。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
import { splitAudioIntoChunks } from '../../gateway-core/audio-chunker.js';

/**
 * MiMo 上游默认 base URL（与 profile.ts 的 MIMO_BASE_URL 同值；那边是单一事实来源）。
 *
 * **只到 host，不含 /v1**：transport 用 `new URL(path, base_url)` 拼地址，base 带路径时
 * 绝对路径会把它整段替换掉，于是"base 含版本路径"会拼出少了 /v1 的 URL（上游 404）。
 * 版本路径在 `MIMO_AUDIO_PATH` 里。
 */
export const MIMO_DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com';

/** TTS / ASR 共用同一个上游路径（按 model 分发）。 */
export const MIMO_AUDIO_PATH = '/v1/chat/completions';

/** ASR 模型 id。 */
export const MIMO_ASR_MODEL = 'mimo-v2.5-asr';

/** TTS 模型 id（三个变体）。 */
export const MIMO_TTS_MODELS = {
  base: 'mimo-v2.5-tts',
  voiceclone: 'mimo-v2.5-tts-voiceclone',
  voicedesign: 'mimo-v2.5-tts-voicedesign',
} as const;

export type MiMoTtsModel = (typeof MIMO_TTS_MODELS)[keyof typeof MIMO_TTS_MODELS];

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

/** TTS 输出格式枚举（官方 enum：wav / mp3 / pcm / pcm16）。 */
export type MiMoTtsFormat = 'wav' | 'mp3' | 'pcm' | 'pcm16';

/** 默认输出格式（官方默认值）。 */
export const MIMO_TTS_DEFAULT_FORMAT: MiMoTtsFormat = 'wav';

/**
 * `mimo-v2.5-tts` 的预置音色 id（官方文档 enum）。
 *
 * 后四个是英文名（OpenAI 脸直接可用的那几个），前五个是中文名——客户端打中文名时
 * 原样透传即可，不需要映射表（上游认的就是这些字符串）。
 */
export const MIMO_TTS_PRESET_VOICES: readonly string[] = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
];

/** TTS 请求（调用方形状）。 */
export interface MiMoTtsRequest {
  /** 用哪个 TTS 模型变体（三个都实测可用）。 */
  model: MiMoTtsModel;
  /** 要合成的文本（非空；≤2048 token 的上游 max_tokens 由调用方控制）。 */
  text: string;
  /** 预置音色 id（`mimo-v2.5-tts`；默认 mimo_default）。 */
  voice?: string;
  /** 音色克隆的参考音频 base64（`mimo-v2.5-tts-voiceclone`，必填）。 */
  reference_audio_base64?: string;
  /** 参考音频的 MIME（voiceclone 用；wav/mp3）。 */
  reference_audio_mime?: string;
  /** 音色设计描述（`mimo-v2.5-tts-voicedesign` 的 user 消息，必填）。 */
  voice_design?: string;
  /** 默认 'wav'。 */
  format?: MiMoTtsFormat;
  /** 上游 max_tokens（音频生成的上界；默认 2048）。 */
  max_tokens?: number;
}

/** decodeTtsResponse 的输入（transport 响应的最小投影）。 */
export interface MiMoTtsWireResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** decodeTtsResponse 的产物。 */
export interface DecodedMiMoTtsResponse {
  /** 音频字节（按 format 定的容器；pcm 是裸 16-bit 单声道 24 kHz）。 */
  audio: Buffer;
  /** 按 format 定的 mime（不读上游头：上游给的是 application/json）。 */
  content_type: string;
  /** 上游音频 id（排查/对账用；官方字段名 `audio.id`）。 */
  audio_id: string;
  /** 上游回显的合成文本（`audio.transcript`；缺失时回落请求的 text）。 */
  transcript: string;
  /** 按字符 usage。 */
  usage: CanonicalUsage;
}

/** format → 响应对应的 mime（`pcm16` 与 `pcm` 同值，官方文档明确二者同义）。 */
export function ttsMimeType(format: MiMoTtsFormat): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'pcm':
    case 'pcm16':
      return 'audio/pcm';
  }
}

/**
 * 构造 TTS 的 canonical usage。
 *
 * MiMo 价格页（2026-11-16）对 TTS 系列标「限时免费」且**没有**按字符计费的规则说明，
 * 而响应里也没有字符数。网关侧按合成文本的字符数记账（`characters` 槽），与 DeepSeek TTS
 * 同口径但**不做** CJK 加权——给 MiMo 编一条"每字 2"的规则等于替上游定价格。
 * 原始字符数另进 `raw`，将来上游公布计费规则时可直接对账。
 */
export function buildTtsUsage(text: string): CanonicalUsage {
  const characters = [...text].length;
  return {
    units: { characters: { input: characters, billed: characters } },
    raw: { characters, billed_characters: characters, model_family: 'mimo-v2.5-tts' },
    source: 'provider',
  };
}

/**
 * 请求对象 → wire body。**默认值在这里填**（format 有官方默认值），理由：请求体自解释。
 *
 * 三个模型变体的消息结构差异（官方文档 + 实测）：
 *   - `mimo-v2.5-tts`：assistant 消息 = 合成文本；user 消息可选（提示）；
 *   - `mimo-v2.5-tts-voiceclone`：`audio.voice` 必填且只接受音频样本的 data URL，
 *     user 消息说明样本用途；
 *   - `mimo-v2.5-tts-voicedesign`：user 消息必填（音色设计描述），**不接受** `audio.voice`；
 *     `audio.optimize_text_preview: true` 时可省略 assistant 消息（本轮不用：那会让
 *     "合成什么文本"由上游决定，与 canonical `input` 的语义冲突）。
 *
 * canonical 的 `filter_markdown` **不发**：MiMo 没有这个参数（那是 DeepSeek TTS 的
 * 专有字段），静默丢弃而不是编一个同名参数。
 */
export function encodeTtsRequest(req: MiMoTtsRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  messages.push({ role: 'user', content: req.voice_design ?? '朗读以下文本' });
  messages.push({ role: 'assistant', content: req.text });

  const audio: Record<string, unknown> = { format: req.format ?? MIMO_TTS_DEFAULT_FORMAT };
  if (req.reference_audio_base64 !== undefined) {
    // voiceclone：voice 是音频样本的 data URL（官方文档原文）
    const mime = req.reference_audio_mime ?? 'audio/wav';
    audio['voice'] = `data:${mime};base64,${req.reference_audio_base64}`;
  } else if (req.model !== MIMO_TTS_MODELS.voicedesign && req.voice !== undefined) {
    audio['voice'] = req.voice;
  }

  return {
    model: req.model,
    messages,
    audio,
    max_tokens: req.max_tokens ?? 2048,
  };
}

/**
 * transport 响应 → 音频 + content-type + usage。**不抛**（非 2xx 由 throwIfNotOk 先拦）。
 *
 * 上游的成功响应是 **JSON 信封**（不是音频字节）：音频在
 * `choices[0].message.audio.data`（base64）。解析不出该字段时 audio 落空 Buffer、
 * audio_id 落空串——**不猜**（0 字节音频比一个猜出来的容器更容易被发现）。
 */
export function decodeTtsResponse(
  res: MiMoTtsWireResponse,
  req?: MiMoTtsRequest,
): DecodedMiMoTtsResponse {
  const format = req?.format ?? MIMO_TTS_DEFAULT_FORMAT;
  let audio = Buffer.alloc(0);
  let audioId = '';
  let transcript = '';
  try {
    const obj = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
    const choices = obj['choices'];
    const message = Array.isArray(choices)
      ? ((choices[0] as Record<string, unknown> | undefined)?.['message'] as
          | Record<string, unknown>
          | undefined)
      : undefined;
    const audioObj = message?.['audio'] as Record<string, unknown> | undefined;
    const data = audioObj?.['data'];
    if (typeof data === 'string' && data !== '') audio = Buffer.from(data, 'base64');
    if (typeof audioObj?.['id'] === 'string') audioId = audioObj['id'] as string;
    if (typeof audioObj?.['transcript'] === 'string') transcript = audioObj['transcript'] as string;
  } catch {
    // 非 JSON：audio 保持空 Buffer（调用方按 0 字节判断）
  }
  return {
    audio,
    content_type: ttsMimeType(format),
    audio_id: audioId,
    transcript: transcript === '' ? (req?.text ?? '') : transcript,
    usage: req === undefined ? { units: {}, source: 'provider' } : buildTtsUsage(req.text),
  };
}

/** 客户端构造依赖（传输 + 鉴权头注入；无模块级单例）。 */
export interface MiMoAudioClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
  /** 单次上游 ASR 分片字节上限（默认 7.5 MiB，留出 8 MiB 上游安全余量）。 */
  maxChunkBytes?: number;
}

/** synthesize() 的返回。 */
export interface MiMoTtsOutcome {
  audio: Buffer;
  content_type: string;
  audio_id: string;
  transcript: string;
  usage: CanonicalUsage;
  httpStatus: number;
}

export class MiMoTtsClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: MiMoAudioClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? MIMO_DEFAULT_BASE_URL;
    this.path = deps.path ?? MIMO_AUDIO_PATH;
  }

  /** 调一次 TTS。非 2xx 抛错（status + 错误体，由 tool-handlers 的分类器映射）。 */
  async synthesize(req: MiMoTtsRequest): Promise<MiMoTtsOutcome> {
    const headers: Record<string, string> = {
      ...(await this.headersProvider()),
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: this.baseUrl,
      path: this.path,
      headers,
      body: Buffer.from(JSON.stringify(encodeTtsRequest(req)), 'utf8'),
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const bodyText = (res.body ?? Buffer.alloc(0)).toString('utf8');
    throwIfAudioNotOk(res.status, bodyText, 'tts');
    const decoded = decodeTtsResponse(
      { status: res.status, headers: res.headers, body: res.body ?? Buffer.alloc(0) },
      req,
    );
    return {
      audio: decoded.audio,
      content_type: decoded.content_type,
      audio_id: decoded.audio_id,
      transcript: decoded.transcript,
      usage: decoded.usage,
      httpStatus: res.status,
    };
  }
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

/** ASR 语种（官方 enum；`auto` = 自动检测，也是上游默认值）。 */
export type MiMoAsrLanguage = 'auto' | 'zh' | 'en';

/** ASR 音频容器（官方文档：仅 mp3 与 wav）。 */
export type MiMoAsrAudioFormat = 'mp3' | 'wav';

/** ASR 请求（调用方形状）。 */
export interface MiMoAsrRequest {
  /** 音频字节（mp3 或 wav）。 */
  file: Buffer | Uint8Array;
  /** 客户端侧文件名（仅用于推导容器格式）。 */
  filename: string;
  /** 音频容器（与 data URL 的 MIME 必须匹配，官方文档明说）。 */
  format: MiMoAsrAudioFormat;
  /** 语种提示；省略 = 上游自动检测（官方默认 auto）。 */
  language?: MiMoAsrLanguage;
  /** 上游 max_tokens（转写文本的上界；默认 512）。 */
  max_tokens?: number;
}

/** ASR 响应体（上游 JSON 信封的相关字段）。 */
export interface MiMoAsrResponse {
  /** 上游请求 id。 */
  request_id: string;
  /** 完整转写文本。 */
  text: string;
  /** 音频时长（秒）——计费的唯一计量依据（usage.seconds）。 */
  seconds: number;
  /** 上游响应体原文（未建模顶层键不丢；恒存在，可能为 `{}`）。 */
  raw: Record<string, unknown>;
}

/** filename → 容器格式（只认官方支持的两个；认不出抛错，不猜）。 */
export function audioFormatFromFilename(filename: string): MiMoAsrAudioFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mp3')) return 'mp3';
  if (lower.endsWith('.wav')) return 'wav';
  throw new Error(`MiMo ASR 只支持 mp3 / wav，认不出 ${filename} 的格式`);
}

/** 容器格式 → data URL 的 MIME（官方文档：mp3 = audio/mpeg 或 audio/mp3；wav = audio/wav）。 */
export function asrMimeType(format: MiMoAsrAudioFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

/**
 * 请求对象 → wire body（Chat Completions 形状，音频走 input_audio content part）。
 *
 * `format` 与 data URL 的 MIME **必须匹配**（官方文档明说）；两者都发，让上游的双重
 * 校验都通过（只发 base64 时 format 是必填项，只发 data URL 时 format 选填）。
 */
export function encodeAsrRequest(req: MiMoAsrRequest): Record<string, unknown> {
  const b64 = Buffer.from(req.file).toString('base64');
  const message: Record<string, unknown> = {
    role: 'user',
    content: [
      {
        type: 'input_audio',
        input_audio: { data: `data:${asrMimeType(req.format)};base64,${b64}`, format: req.format },
      },
    ],
  };
  return {
    model: MIMO_ASR_MODEL,
    messages: [message],
    ...(req.language === undefined ? {} : { asr_options: { language: req.language } }),
    max_tokens: req.max_tokens ?? 512,
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 响应体 → 类型化 ASR 响应。**不抛**：非 object 或缺字段时 text 落空串、seconds 落 0、
 * request_id 落空串，raw 留原文。
 *
 * seconds 落 0 而不是省略：下游按音频秒计费必须有个数，而"上游没给时长"在这个端点是
 * 异常情况（实测必返）。0 会让计费记 0 秒——调用方若想区分"真的 0 秒"与"上游没给"，
 * 读 `raw` 原文即可（decode 不做静默猜测，只给可用默认值）。
 */
export function decodeAsrResponse(raw: unknown): MiMoAsrResponse {
  const obj = asRecord(raw);
  const choices = obj?.['choices'];
  const message = Array.isArray(choices)
    ? ((choices[0] as Record<string, unknown> | undefined)?.['message'] as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const usage = asRecord(obj?.['usage']);
  return {
    request_id: str(obj?.['id']) ?? '',
    text: str(message?.['content']) ?? '',
    seconds: num(usage?.['seconds']) ?? 0,
    raw: obj ?? {},
  };
}

/**
 * 构造 ASR 的 canonical usage。
 *
 * **为什么是 `audio_seconds`**：上游按音频小时计费（¥0.5/h），`usage.seconds` 是唯一
 * 依据；ir/usage.ts 的 `UsageUnits.audio_seconds`（`{input, billed}`）就是为按时长计费
 * 准备的槽。
 *
 * **为什么 input 与 billed 同值**：整个文件一次上传、一次拿完整转写，不存在"上传了但没
 * 识别"的部分。上游的 token usage（prompt_tokens 里的 audio_tokens）另进 `raw`，
 * 不塞进 units 冒充第二个口径。
 */
export function buildAsrUsage(res: MiMoAsrResponse): CanonicalUsage {
  return {
    units: { audio_seconds: { input: res.seconds, billed: res.seconds } },
    raw: { seconds: res.seconds },
    source: 'provider',
  };
}

/** transcribe() 的返回。 */
export interface MiMoAsrOutcome {
  request_id: string;
  text: string;
  seconds: number;
  usage: CanonicalUsage;
  httpStatus: number;
}

export const MIMO_ASR_MAX_CHUNK_BYTES = 7_500_000;

export class MiMoAsrClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly maxChunkBytes: number;

  constructor(deps: MiMoAudioClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? MIMO_DEFAULT_BASE_URL;
    this.path = deps.path ?? MIMO_AUDIO_PATH;
    this.maxChunkBytes = deps.maxChunkBytes ?? MIMO_ASR_MAX_CHUNK_BYTES;
  }

  private async sendSingleChunk(req: MiMoAsrRequest): Promise<MiMoAsrOutcome> {
    const headers: Record<string, string> = {
      ...(await this.headersProvider()),
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: this.baseUrl,
      path: this.path,
      headers,
      body: Buffer.from(JSON.stringify(encodeAsrRequest(req)), 'utf8'),
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const bodyText = (res.body ?? Buffer.alloc(0)).toString('utf8');
    throwIfAudioNotOk(res.status, bodyText, 'asr');
    const decoded = decodeAsrResponse(parseJsonOrUndefined(bodyText));
    return {
      request_id: decoded.request_id,
      text: decoded.text,
      seconds: decoded.seconds,
      usage: buildAsrUsage(decoded),
      httpStatus: res.status,
    };
  }

  /**
   * 调 ASR：小于上限时单次直发；大于上限时自动按容器帧边界切分并透明拼接结果与累计时长。
   */
  async transcribe(req: MiMoAsrRequest): Promise<MiMoAsrOutcome> {
    const chunks = splitAudioIntoChunks(req.file, req.format, this.maxChunkBytes);
    if (chunks.length <= 1) {
      return this.sendSingleChunk(req);
    }

    const texts: string[] = [];
    let totalSeconds = 0;
    let lastRequestId = '';
    let lastHttpStatus = 200;

    for (const chunk of chunks) {
      const outcome = await this.sendSingleChunk({ ...req, file: chunk });
      if (outcome.text.trim() !== '') texts.push(outcome.text.trim());
      totalSeconds += outcome.seconds;
      lastRequestId = outcome.request_id;
      lastHttpStatus = outcome.httpStatus;
    }

    return {
      request_id: lastRequestId,
      text: texts.join(' '),
      seconds: totalSeconds,
      usage: {
        units: { audio_seconds: { input: totalSeconds, billed: totalSeconds } },
        raw: { seconds: totalSeconds, chunks: chunks.length },
        source: 'provider',
      },
      httpStatus: lastHttpStatus,
    };
  }
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 上游音频调用失败（http 层按 status 分类成 4xx/5xx）。
 *
 * 单独一个类而不复用 DeepSeek 的 `DeepSeekApiError`：providers/ 之间不互相 import
 * （di/ports.ts 的模块边界），而分类器只需要 status + 错误体两件事。
 */
export class MiMoAudioError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: 'tts' | 'asr',
  ) {
    super(`MiMo ${endpoint} 上游返回 ${status}: ${body.slice(0, 200)}`);
    this.name = 'MiMoAudioError';
  }
}

/** 非 2xx 抛 `MiMoAudioError`（状态码必须完整上抛，调用方要分流 400/413/429）。 */
export function throwIfAudioNotOk(status: number, body: string, endpoint: 'tts' | 'asr'): void {
  if (status < 200 || status >= 300) throw new MiMoAudioError(status, body, endpoint);
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
