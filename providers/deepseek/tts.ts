/**
 * providers/deepseek/tts.ts —— DeepSeek 独立工具端点 /v1/tools/tts 的 wire codec + 客户端。
 *
 * **这不是 chat pipeline 的一部分**（同目录 search.ts 顶部有完整说明）：不实现 Adaptor
 * 接口、不进 registry、不走 S0–S10。它是 standalone wire codec + 薄客户端。
 *
 * 唯一事实来源：DeepSeek 官方文档 api-docs.deepseek.com 的 TTS 一节
 * （2026-11-14 核对）。要点：
 *   - HTTP 全文本模式：POST https://api.deepseek.com/v1/tools/tts，
 *     Content-Type: application/json；Authorization: Bearer <key>；
 *   - 请求 `{text, voice_id, format, filter_markdown}`：`text` 必填非空、
 *     ≤10,000 **计费字符**、body ≤64 KiB；`voice_id` 默认 "stella"
 *     （stella 女声 / tide 男声）；`format` 默认 "wav"（wav | pcm）；
 *     `filter_markdown` 默认 true（合成前过滤 Markdown 标记）；
 *   - 响应**就是音频流本身**（不是 JSON 信封）：`audio/wav`，或 `audio/pcm`
 *     = 原始 16-bit 有符号单声道 PCM、24 kHz（format=pcm 时）；一次请求最多
 *     返回 30 分钟音频；语言从文本自动检测；无语速控制、不支持续传；
 *   - 计费 $0.45 / 10,000 字符（限时 $0.225）；**一个中文字符按 2 计**，其他字符按 1。
 *
 * **未来工作（不在本文件实现）**：文档还有一个 WebSocket 模式
 * `wss://api.deepseek.com/v1/tools/tts`（流式合成）。本文件只做 HTTP 全文本模式；
 * WS 接入时应新增独立文件（需要流式 transport 与分帧协议，与这里的"一次请求一整段"
 * 假设不同），不要在 HTTP 客户端上堆分支。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
import { DeepSeekApiError, throwIfNotOk } from './search.js';

/** 错误载体从 search.ts 再出口（单一事实来源在 search.ts）。 */
export { DeepSeekApiError };

/** DeepSeek 官方 base URL。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** TTS 端点路径（HTTP 全文本模式；WS 模式同路径不同 scheme，见文件头）。 */
export const DEEPSEEK_TTS_PATH = '/v1/tools/tts';

/** 默认音色（stella 女声；tide 男声）。 */
export const DEEPSEEK_TTS_DEFAULT_VOICE_ID = 'stella';

/** 默认输出格式。 */
export const DEEPSEEK_TTS_DEFAULT_FORMAT = 'wav';

/** 默认过滤 Markdown。 */
export const DEEPSEEK_TTS_DEFAULT_FILTER_MARKDOWN = true;

// ---------------------------------------------------------------------------
// wire 类型
// ---------------------------------------------------------------------------

/** TTS 音色枚举（wire 值）。 */
export type DeepSeekTtsVoiceId = 'stella' | 'tide';

/** TTS 输出格式枚举（wire 值）。 */
export type DeepSeekTtsFormat = 'wav' | 'pcm';

/** TTS 请求（调用方形状）。 */
export interface DeepSeekTtsRequest {
  /** 待合成文本：非空，≤10,000 计费字符，body ≤64 KiB。 */
  text: string;
  /** 默认 'stella'。 */
  voice_id?: DeepSeekTtsVoiceId;
  /** 默认 'wav'；'pcm' = 原始 16-bit 有符号单声道 24 kHz。 */
  format?: DeepSeekTtsFormat;
  /** 默认 true：合成前过滤 Markdown 标记。 */
  filter_markdown?: boolean;
}

/** decodeTtsResponse 的输入（transport 响应的最小投影）。 */
export interface DeepSeekTtsWireResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** decodeTtsResponse 的产物。 */
export interface DecodedDeepSeekTtsResponse {
  /** 音频字节（wav 容器或原始 PCM，取决于 format / content-type）。 */
  audio: Buffer;
  /** 上游声明的 content-type；缺失时回落 audio/wav（见函数注释）。 */
  contentType: string;
  /** 按字符 usage：`{units:{characters:{input,billed}}, source:'provider'}`。 */
  usage: CanonicalUsage;
}

// ---------------------------------------------------------------------------
// 计费字符数
// ---------------------------------------------------------------------------

/**
 * 记 2 个计费字符的 Unicode 区间（文档：「一个中文字符按 2 计，其他字符按 1」）。
 *
 * 「中文」的边界文档没有逐码点定义，这里取最常见实现并**显式列出区间**，便于对账时
 * 调整（改这一个常量即可，不需要动算法）：
 *   - 汉字主体：CJK 统一表意文字及 Ext A/B/C–F、兼容表意文字（含兼容补充）；
 *   - 中文标点与全角符号：CJK 符号和标点（。、〈〉「」…）、全角形式（，！Ａ１…）、
 *     全角符号（￥￡…）。它们在中文排版里占一个汉字宽度，按 2 计；
 *   - **不**包含：日文假名、韩文谚文、emoji、拉丁扩展——文档说"其他字符按 1"。
 */
export const CJK_BILLED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf], // CJK 统一表意文字扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字（基本区）
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0x20000, 0x2a6df], // 扩展 B
  [0x2a700, 0x2ebef], // 扩展 C–F
  [0x2f800, 0x2fa1f], // CJK 兼容表意文字补充
  [0x3000, 0x303f], // CJK 符号和标点
  [0xff01, 0xff60], // 全角形式（全角 ASCII 变体）
  [0xffe0, 0xffe6], // 全角符号
];

/**
 * 计费字符数：中文字符（见 CJK_BILLED_RANGES）记 2，其他字符记 1。
 *
 * 按**码点**迭代而不是 UTF-16 单元：emoji 与扩展区汉字都是代理对，按单元数会把
 * 一个字符算成两个。纯函数，可单测（见 endpoints.test.ts 的 billedCharCount 组）。
 */
export function billedCharCount(text: string): number {
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    total += CJK_BILLED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return total;
}

/** format → 响应对应的 mime（文档：wav=audio/wav，pcm=audio/pcm）。 */
export function ttsMimeType(format: DeepSeekTtsFormat): string {
  return format === 'pcm' ? 'audio/pcm' : 'audio/wav';
}

/**
 * 构造 TTS 的 canonical usage。
 *
 * `characters.input` 与 `billed` 都取 billedCharCount(text)（ir/tts.ts 的
 * `characters?: {input, billed}`）：这个端点没有"输入字符 / 计费字符"的区分概念，
 * 计费就是按 billedCharCount；原始字符数另有用途（≤10,000 的限额说的是计费字符），
 * 故只在 `raw` 里留一份，不塞进 units 冒充第二个口径。
 */
export function buildTtsUsage(text: string): CanonicalUsage {
  const billed = billedCharCount(text);
  return {
    units: { characters: { input: billed, billed } },
    raw: { characters: [...text].length, billed_characters: billed },
    source: 'provider',
  };
}

// ---------------------------------------------------------------------------
// encode / decode
// ---------------------------------------------------------------------------

/**
 * 请求对象 → wire body。**默认值在这里填**（voice_id/format/filter_markdown 各有一个
 * 文档默认值），理由：请求体自解释，且上游将来改默认值时已发出请求的语义不变。
 * 仍然不校验（长度/空串由调用方或上游判，413/400 会带状态码回来）。
 */
export function encodeTtsRequest(req: DeepSeekTtsRequest): Record<string, unknown> {
  return {
    text: req.text,
    voice_id: req.voice_id ?? DEEPSEEK_TTS_DEFAULT_VOICE_ID,
    format: req.format ?? DEEPSEEK_TTS_DEFAULT_FORMAT,
    filter_markdown: req.filter_markdown ?? DEEPSEEK_TTS_DEFAULT_FILTER_MARKDOWN,
  };
}

/** 大小写不敏感地取响应头（transport 可能回大写了，见 FetchTransport 的 forEach）。 */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * transport 响应 → 音频 + content-type + usage。**不抛**（非 2xx 由 throwIfNotOk 先拦）。
 *
 * `req` 可选：计费字符数只能从**请求**的 text 算（音频响应里没有文本），所以 decode
 * 单独调用时 usage 是"未知"（units 为空对象，绝不用 0 冒充——10 §6.1 规则 2）；
 * 客户端 synthesize 一定传入 req。
 *
 * content-type 缺失时回落 audio/wav：文档的默认 format 就是 wav，上游也几乎总会给头。
 * 更严格的调用方应按自己请求的 format 回落（ttsMimeType）——decode 单签名拿不到请求，
 * 只能做这个保守默认。
 */
export function decodeTtsResponse(
  res: DeepSeekTtsWireResponse,
  req?: DeepSeekTtsRequest,
): DecodedDeepSeekTtsResponse {
  const contentType = headerValue(res.headers, 'content-type') ?? 'audio/wav';
  return {
    audio: res.body,
    contentType,
    usage: req === undefined ? { units: {}, source: 'provider' } : buildTtsUsage(req.text),
  };
}

// ---------------------------------------------------------------------------
// 薄客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（传输 + 鉴权头注入；无模块级单例）。 */
export interface DeepSeekTtsClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
}

/** synthesize() 的返回。 */
export interface DeepSeekTtsOutcome {
  audio: Buffer;
  contentType: string;
  usage: CanonicalUsage;
  httpStatus: number;
}

export class DeepSeekTtsClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: DeepSeekTtsClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.path = deps.path ?? DEEPSEEK_TTS_PATH;
  }

  /**
   * 调一次 /v1/tools/tts（HTTP 全文本模式）。非 2xx 抛 `DeepSeekApiError`（status +
   * 错误体）——注意这个端点的错误体是 JSON，成功响应才是音频字节，二者靠状态码区分。
   *
   * 200 但 body 为空：audio 是空 Buffer，**不抛**（二进制响应是否可用由调用方按业务
   * 判断，例如能否解析出 wav 头）。
   */
  async synthesize(req: DeepSeekTtsRequest): Promise<DeepSeekTtsOutcome> {
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
    throwIfNotOk(res, bodyText, 'tts');

    const decoded = decodeTtsResponse(
      { status: res.status, headers: res.headers, body: res.body ?? Buffer.alloc(0) },
      req,
    );
    return {
      audio: decoded.audio,
      contentType: decoded.contentType,
      usage: decoded.usage,
      httpStatus: res.status,
    };
  }
}
