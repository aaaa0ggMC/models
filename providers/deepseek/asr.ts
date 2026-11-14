/**
 * providers/deepseek/asr.ts —— DeepSeek 独立工具端点 /v1/tools/asr 的 wire codec + 客户端。
 *
 * **这不是 chat pipeline 的一部分**（同目录 search.ts 顶部有完整说明）：不实现 Adaptor
 * 接口、不进 registry、不走 S0–S10。它是 standalone wire codec + 薄客户端。
 *
 * 唯一事实来源：DeepSeek 官方文档 api-docs.deepseek.com 的 ASR 一节
 * （2026-11-14 核对）。要点：
 *   - POST https://api.deepseek.com/v1/tools/asr，multipart/form-data，**只有一个字段**
 *     `file`（二进制，必填，带 filename）；Authorization: Bearer <key>；
 *   - 音频格式按内容探测：16-bit PCM WAV 或 Ogg Opus；WAV 采样率限
 *     8000/16000/22050/24000/32000/44100/48000 Hz，单/双声道（双声道只取左声道）；
 *     ≤8 MiB、上传 ≤10 min、时长 ≤120s；
 *   - **没有流式**：整个文件一次上传、一次拿完整转写（所以本客户端是非流式的，
 *     不需要 UpstreamRequest.stream=true，也不消费 chunks）；
 *   - **没有语言参数**：语言自动检测（zh/yue/en/ja/ko/de/fr/es/pt/it/ru/ar/hi/id/vi/
 *     th/tr/ms/fil/pl/hu）；
 *   - 响应 `{request_id, text, duration_ms}`；
 *   - 计费 $0.116 / 音频小时（限时半价 $0.058），按秒累计；单账号 ≤50 并发。
 *
 * multipart 编码器复用 ocr.ts 的 `encodeMultipartFormData`（含固定边界与文件名净化）：
 * 写权限内不允许新增共享文件，而"手写 multipart"这种易错代码只应有一份实现。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
import { DeepSeekApiError, throwIfNotOk } from './search.js';
import { encodeMultipartFormData } from './ocr.js';

/** 错误载体与 multipart 编码器从兄弟文件再出口（单一事实来源在 search.ts / ocr.ts）。 */
export { DeepSeekApiError, encodeMultipartFormData };

/** DeepSeek 官方 base URL。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** ASR 端点路径。 */
export const DEEPSEEK_ASR_PATH = '/v1/tools/asr';

// ---------------------------------------------------------------------------
// wire 类型
// ---------------------------------------------------------------------------

/** ASR 请求（调用方形状）。 */
export interface DeepSeekAsrRequest {
  /** 音频字节（WAV 或 Ogg Opus，按内容探测）。 */
  file: Buffer | Uint8Array;
  /** 客户端侧文件名，写进 Content-Disposition；空串回落 'upload.bin'。 */
  filename: string;
}

/** ASR 响应体。 */
export interface DeepSeekAsrResponse {
  /** 上游请求 id（排查/对账用；文档没给前缀约定，故不猜格式）。 */
  request_id: string;
  /** 完整转写文本。 */
  text: string;
  /** 音频时长（毫秒）——计费的唯一计量依据。 */
  duration_ms: number;
  /** 上游响应体原文（未建模顶层键不丢；恒存在，可能为 `{}`）。 */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// encode / decode
// ---------------------------------------------------------------------------

/**
 * ASR 请求 → multipart 请求体 + content-type 头。纯函数。
 * 只有 `file` 一个字段——多传任何字段都可能被上游拒（OCR 明确 400，ASR 未明说，
 * 保守起见只发文档列出的字段）。
 */
export function encodeAsrRequest(req: DeepSeekAsrRequest): {
  body: Buffer;
  headers: Record<string, string>;
} {
  return encodeMultipartFormData({ name: 'file', filename: req.filename, data: req.file }, []);
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
 * 响应体 → 类型化 ASR 响应。**不抛**：非 object 或缺字段时 text 落空串、
 * duration_ms 落 0、request_id 落空串，raw 留原文。
 *
 * duration_ms 落 0 而不是省略：下游按秒计费必须有个数，而"上游没给时长"在这个
 * 端点上是异常情况（文档标必返），0 会让计费记 0 秒——调用方若想区分"真的 0 秒"
 * 与"上游没给"，读 `raw` 原文即可（decode 不做静默猜测，只给可用默认值）。
 */
export function decodeAsrResponse(raw: unknown): DeepSeekAsrResponse {
  const obj = asRecord(raw);
  return {
    request_id: str(obj?.['request_id']) ?? '',
    text: str(obj?.['text']) ?? '',
    duration_ms: num(obj?.['duration_ms']) ?? 0,
    raw: obj ?? {},
  };
}

/**
 * 构造 ASR 的 canonical usage。
 *
 * **为什么是 `audio_seconds`**：上游按音频小时计费（$0.116/h，限时半价），
 * ir/usage.ts 的 `UsageUnits.audio_seconds`（`{input, billed}`）就是为 ASR/TTS 的
 * 按时长计费准备的槽，比 `requests` 更贴合账单口径。
 *
 * **为什么 input 与 billed 同值**：这个端点把整个文件一次上传、一次返回完整转写，
 * 不存在"上传了但没识别"的部分；时长就是 duration_ms/1000（毫秒→秒，
 * 非整数秒是正常的——上游按秒计费会自行取整，网关这里保留原精度）。
 */
export function buildAsrUsage(res: DeepSeekAsrResponse): CanonicalUsage {
  const seconds = res.duration_ms / 1000;
  return {
    units: { audio_seconds: { input: seconds, billed: seconds } },
    // ASR 响应没有 usage 字段；duration_ms 是计费唯一依据，进 raw 供对账
    raw: { duration_ms: res.duration_ms },
    source: 'provider',
  };
}

// ---------------------------------------------------------------------------
// 薄客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（传输 + 鉴权头注入；无模块级单例）。 */
export interface DeepSeekAsrClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
}

/** transcribe() 的返回。 */
export interface DeepSeekAsrOutcome {
  request_id: string;
  text: string;
  duration_ms: number;
  usage: CanonicalUsage;
  httpStatus: number;
}

export class DeepSeekAsrClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: DeepSeekAsrClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.path = deps.path ?? DEEPSEEK_ASR_PATH;
  }

  /**
   * 调一次 /v1/tools/asr。非 2xx 抛 `DeepSeekApiError`（status + 错误体）。
   *
   * 413（>8 MiB）与 429（>50 并发）需要调用方分流，状态码必须完整上抛。
   */
  async transcribe(req: DeepSeekAsrRequest): Promise<DeepSeekAsrOutcome> {
    const encoded = encodeAsrRequest(req);
    const headers: Record<string, string> = {
      ...(await this.headersProvider()),
      ...encoded.headers,
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: this.baseUrl,
      path: this.path,
      headers,
      body: encoded.body,
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const bodyText = (res.body ?? Buffer.alloc(0)).toString('utf8');
    throwIfNotOk(res, bodyText, 'asr');

    const decoded = decodeAsrResponse(parseJsonOrUndefined(bodyText));
    return {
      request_id: decoded.request_id,
      text: decoded.text,
      duration_ms: decoded.duration_ms,
      usage: buildAsrUsage(decoded),
      httpStatus: res.status,
    };
  }
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
