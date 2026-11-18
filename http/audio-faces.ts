/**
 * http/audio-faces.ts —— `/v1/audio/*` 入站脸的**多上游抽象**（接口 + 共享类型 + 解析）。
 *
 * ## 为什么有这一层
 *
 * `http/audio-endpoint.ts` 起家时只服务 DeepSeek 一家：模型解析、voice 映射、
 * response_format 矩阵、错误文案全都写死 deepseek。接第二家音频上游（MiMo）时如果继续
 * 在 http 层加分支，就会出现「上游字段名泄漏到传输层」——而传输层本该对上游一无所知
 * （providers/deepseek/tool-handlers.ts 文件头的同款立场）。
 *
 * 因此把「一家上游在音频端点上的全部差异」收进一个 **AudioProviderFace**：
 * 模型解析、客户端方言 → canonical 的解码、canonical → 客户端方言的编码、计量归属。
 * http 层只认这个接口，按顺序问一遍，**第一家认领的赢**。
 *
 * ## 为什么 face 放 providers/ 而接口放这里
 *
 * 实现（voice 映射表、上游格式矩阵）是 provider 专有知识，归 `providers/<provider>/`；
 * 接口是 http 层的消费契约，放这里。`providers/` 只 import 本文件的**类型**
 * （`import type`，无运行时依赖，不成环）。
 *
 * ## 认领顺序
 *
 * 顺序即 `createAudioEndpoints` 的 `providers` 数组顺序（组合根决定，默认 DeepSeek 在前）。
 * 两家的模型名不重叠（`deepseek-tts` / `whisper-1` vs `mimo-v2.5-tts`），所以顺序只影响
 * 错误信息里先列谁；真要重叠时**先注册者赢**是有意的——重叠本身就是配置错误，该由
 * 管理员改渠道而不是由网关猜。
 */

import type { CanonicalToolResponse, FormatId } from '../ir/index.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { AliasResolver } from '../admin/aliases.js';
import type { ToolEndpointHandler } from './tools-endpoint.js';

/** 两个音频端点（与 canonical 工具端点的 tts / asr 同源）。 */
export type AudioEndpointId = 'tts' | 'asr';

/** 端点 → 客户端格式（UsageRecord.client_format 用；两个 id 都已在 ir/format.ts 登记）。 */
export const AUDIO_CLIENT_FORMATS: Readonly<Record<AudioEndpointId, FormatId>> = {
  tts: 'openai.audio.speech',
  asr: 'openai.audio.transcription',
};

/**
 * 解析成功的产物（provider 侧真实 model id + 来源，供计量与可观测用）。
 *
 * `source` 记「模型名是怎么来的」：请求路径上要能回答这个问题（与
 * providers/deepseek/audio-models.ts 的六档同源）。
 */
export interface AudioModelTarget {
  provider: string;
  access_path: string;
  /** provider 侧真实 model id（客户端传别名时这是解析后的名字）。 */
  model: string;
  source: 'openai-alias' | 'exact' | 'namespace' | 'prefix' | 'passthrough' | 'matrix';
}

/** 模型解析依赖（管理面别名解析器可选；能力矩阵必给）。 */
export interface AudioModelResolverDeps {
  aliasResolver?: AliasResolver;
  capabilities: CapabilityRegistry;
}

/**
 * `/v1/audio/speech` 的 JSON 体 → 中间形状（**还不是 canonical**：`voice_id` / `format`
 * 是 dialect 脸与 canonical 工具面之间的公共词汇，各上游的合法值集不同）。
 *
 * `model` / `reference_audio` / `voice_design` 是可选增量字段：只有上游有多个 TTS 变体
 * （MiMo 的三个）时才用得到，DeepSeek 的脸不给（它的 canonical 请求本来就没有这几个字段）。
 */
export interface CanonicalSpeechBody {
  input: string;
  voice_id: string;
  format: 'wav' | 'pcm' | 'mp3';
  /** provider 侧 TTS 模型变体（缺省 = 该 face 的默认 TTS 模型）。 */
  model?: string;
  /** 音色克隆的参考音频（base64，不含 `data:` 前缀）。 */
  reference_audio?: { data_base64: string; content_type: string };
  /** 音色设计描述（上游用 user 消息表达的那个字段）。 */
  voice_design?: string;
}

/** `/v1/audio/transcriptions` 的 multipart 字段里与 canonical 有关的那些。 */
export interface TranscriptionFields {
  language?: string;
  prompt?: string;
  temperature?: string;
  timestamp_granularities?: string;
}

/** canonical asr 请求体里 language / prompt 两个可选字段（各家映射不同）。 */
export interface TranscriptionExtras {
  language?: string;
  prompt?: string;
}

/** OpenAI 转写 `response_format` 三家共用的枚举（null = 上游产不出）。 */
export type OpenAiTranscriptionFormat = 'json' | 'text' | 'verbose_json';

/**
 * 一家上游在音频端点上的「OpenAI 脸」。
 *
 * 全部方法都是纯函数或在 deps 上操作的薄封装——**不起 HTTP、不读 process.env、
 * 不建单例**（上游调用走 `handlers`，那是 tool-handlers 的事）。
 */
export interface AudioProviderFace {
  /** provider id（计量归属；同时是能力矩阵里 access_path 的点号前前缀）。 */
  readonly provider: string;
  /** 该 face 在 endpoint 上的 access path（= 计量口径）。 */
  accessPath(endpoint: AudioEndpointId): string;
  /** 该 face 在 endpoint 上的默认模型 id（解析前就失败时记账用）。 */
  defaultModel(endpoint: AudioEndpointId): string;
  /** 该 face 在 endpoint 上客户端可用的模型名全集（错误信息列给用户看）。 */
  modelNames(endpoint: AudioEndpointId): string[];
  /**
   * OpenAI 客户端模型名 → 本 face 的模型名（第 0 档便利映射）。
   *
   * 没有则返回 `{}`——不是每家都值得把 `tts-1` 之类的名字接进来。
   */
  openaiModelAliases(): Record<string, string>;
  /**
   * 解析 `model` 字段；返回 undefined = **本 face 不认**（调用方试下一家）。
   *
   * 与抛错的 `resolveAudioModel` 的分工：多上游时"这家不认"是正常控制流不是异常，
   * 所以 face 层吞掉 `AudioModelError` 改返回 undefined；单上游的内部实现仍可抛。
   */
  resolveModel(
    deps: AudioModelResolverDeps,
    model: string,
    endpoint: AudioEndpointId,
  ): AudioModelTarget | undefined;
  /** `/v1/audio/speech` 的 JSON 体 → 中间形状（不合法时抛，http 层映射成 400）。 */
  decodeSpeech(body: unknown): CanonicalSpeechBody;
  /** canonical tts 响应 → 音频二进制 + Content-Type。 */
  encodeSpeech(res: CanonicalToolResponse, format: string): { content_type: string; body: Buffer };
  /** multipart 字段 → canonical asr 请求体的 language / prompt。 */
  decodeTranscriptionFields(fields: TranscriptionFields): TranscriptionExtras;
  /**
   * 解析转写的 `response_format`。
   *
   * 在 face 上而不在 http 层：两家的合法值集不同（DeepSeek 与 MiMo 都不产时间轴，
   * 但错误文案要各自说清"谁不产"），而 http 层只该知道"解析出来了什么"。
   */
  resolveTranscriptionResponseFormat(format: unknown): OpenAiTranscriptionFormat;
  /** canonical asr 响应 → OpenAI 转写响应（JSON 或纯文本）。 */
  encodeTranscription(
    res: CanonicalToolResponse,
    format: OpenAiTranscriptionFormat,
  ): { content_type: string; body: string };
  /** `/v1/audio/translations` 明确不支持的原因（501 响应与 list() 用）。 */
  translationsUnsupportedReason: string;
}

/** 一家上游的完整装配：脸（ dialect 映射）+ 上游 handler（canonical 工具面）。 */
export interface AudioEndpointProvider {
  readonly face: AudioProviderFace;
  readonly handlers: { tts: ToolEndpointHandler; asr: ToolEndpointHandler };
  /**
   * 计费路径判据要查的 access path（缺省 = 该 face 自己的 endpoint access path）。
   *
   * 与 `ToolEndpointHandler.billing_access_path` 同款理由：音频端点的 access path
   * （`mimo.tools.tts` / `deepseek.tools.asr`）不在凭据启动表里，凭据登记在
   * `<provider>.openai-chat` 上。订阅/按量是**凭据的属性**，所以要去有凭据的那条
   * path 上问——不问就永远按非订阅处理，订阅用量会被记成现金支出。
   */
  readonly billingAccessPath?: string;
}

/** 模型解析不到（http 层 → 400 + 一句话）。 */
export class AudioModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioModelError';
  }
}

/**
 * 按顺序问每一家 face，第一家认领的赢；都不认 → 400 + 一份合并的可用模型清单。
 *
 * **为什么合并清单**：客户端打 `/v1/audio/speech` 时不该先知道网关接了几家上游，
 * 错误信息把两家的模型名列在一起，比"DeepSeek 不认这个名字"更可操作。
 */
export function resolveAudioModelOnFaces(
  providers: readonly AudioEndpointProvider[],
  deps: AudioModelResolverDeps,
  model: string,
  endpoint: AudioEndpointId,
): { provider: AudioEndpointProvider; target: AudioModelTarget } {
  for (const provider of providers) {
    const target = provider.face.resolveModel(deps, model, endpoint);
    if (target !== undefined) return { provider, target };
  }
  const names = providers.flatMap((p) => p.face.modelNames(endpoint));
  throw new AudioModelError(`模型 ${model} 解析不到：本端点可用 ${names.join(' / ')}`);
}

/** 某一端点上的「OpenAI 客户端模型名别名」合并表（第 0 档；后注册的不覆盖先注册的）。 */
export function mergedOpenAiAudioAliases(
  providers: readonly AudioEndpointProvider[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of providers) Object.assign(out, p.face.openaiModelAliases());
  return out;
}
