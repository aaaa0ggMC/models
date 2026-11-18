/**
 * providers/deepseek/ocr.ts —— DeepSeek 独立工具端点 /v1/tools/ocr 的 wire codec + 客户端。
 *
 * **这不是 chat pipeline 的一部分**（同目录 search.ts 顶部有完整说明）：不实现 Adaptor
 * 接口、不进 registry、不走 S0–S10。它是 standalone wire codec + 薄客户端。
 *
 * 唯一事实来源：DeepSeek 官方文档 api-docs.deepseek.com 的 OCR 一节
 * （2026-11-14 核对）。要点：
 *   - POST https://api.deepseek.com/v1/tools/ocr，multipart/form-data；
 *     Authorization: Bearer <key>；**没有** Content-Type: application/json（由
 *     multipart 的 boundary 头代替）；
 *   - 字段只有两个：`file`（二进制，必填，**必须带 filename**；支持
 *     PDF/DOC/DOCX/PPT/PPTX/PNG/JPEG/WebP/GIF/BMP/TIFF，格式按**内容**探测）
 *     与 `purpose`（必填，枚举 text_recognition | rich_layout_recognition）；
 *     **任何其他字段 → 400**，所以 encode 绝不附带多余字段；
 *   - 限制：≤100 MiB（超了 413）、≤1000 页、上传 ≤120s 且停顿不得 >30s、整体 ≤180s；
 *   - 响应 `{id:"ocr-...", object:"ocr.result", created:unix_seconds, purpose,
 *     page_count, pages[{index,text,finish_reason}], usage:{input_tokens,
 *     output_tokens,total_tokens}}`；`text` 是模型原始输出、不做清洗，保留
 *     `<|ref|>Title<|/ref|><|box|>[[52,40,948,96]]<|/box|>` 这类版面 token
 *     （竖线为半角，坐标归一化到 0–1000）；`usage` 文档原话「仅供参考，不用于计费」；
 *   - 计费 $0.225 / 1000 **成功识别的页**；单账号 ≤15 个并发识别。
 *
 * 两个本文件特有的设计决定（详见下方注释）：
 *   1. multipart 手写编码，不用 FormData：Node 的 FormData 会把 filename 按
 *      RFC 7578 规范化、并可能改写 Content-Type，而这里要求「字节可控 + 边界固定」
 *      （测试要能逐字节断言）。编码器同时被 asr.ts 复用（写权限内不新增共享文件）。
 *   2. usage 用 `units.requests = page_count`：上游按页计费，而 UsageUnits 没有
 *      pages 槽（见 buildOcrUsage 的完整论证）。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
import { DeepSeekApiError, throwIfNotOk } from './search.js';

/** 错误载体从 search.ts 再出口（单一事实来源在 search.ts）。 */
export { DeepSeekApiError };

/** DeepSeek 官方 base URL。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** OCR 端点路径。 */
export const DEEPSEEK_OCR_PATH = '/v1/tools/ocr';

/**
 * 固定 multipart 边界。
 *
 * 为什么固定而不是随机：边界只需在本请求体内唯一即可（RFC 2046），固定值让
 * 测试可以逐字节断言请求体，也让抓包排查时能一眼认出是本网关发出的请求。
 * 取值不含引号/反斜杠/控制字符，也不会出现在正常文件内容的行首。
 */
export const DEEPSEEK_MULTIPART_BOUNDARY = '----agentgateway-deepseek-multipart-0001';

// ---------------------------------------------------------------------------
// wire 类型
// ---------------------------------------------------------------------------

/** OCR 用途枚举（wire 值就是这两个字符串，无 canonical 中间层）。 */
export type DeepSeekOcrPurpose = 'text_recognition' | 'rich_layout_recognition';

/** OCR 请求（调用方形状）。 */
export interface DeepSeekOcrRequest {
  /** 文件字节（Buffer | Uint8Array；Uint8Array 覆盖 fetch/Blob 读出的形态）。 */
  file: Buffer | Uint8Array;
  /** 客户端侧文件名，会写进 Content-Disposition；空串时回落 'upload.bin'。 */
  filename: string;
  purpose: DeepSeekOcrPurpose;
}

/** 手写 multipart 的产物。 */
export interface EncodedMultipartRequest {
  body: Buffer;
  /** 至少含 content-type（带 boundary）；鉴权头由客户端合并。 */
  headers: Record<string, string>;
}

/** 单页识别结果。 */
export interface DeepSeekOcrPage {
  /** 从 0 开始的页序号；缺失时用数组下标兜底（见 decodeOcrResponse）。 */
  index: number;
  /** 模型原始输出，不清洗：保留 <｜ref｜>/<｜box｜> 版面 token，坐标 0–1000。 */
  text: string;
  /**
   * 文档枚举 `stop` | `length`。这里收成 string 而不是联合类型：未知值**原样保留**
   * （不猜、不默认 stop——10 §9.3 注意 2 的同一立场），联合类型会逼着 decode 造假。
   */
  finish_reason: string;
}

/** OCR 的 token 用量（文档：仅供参考，不用于计费）。 */
export interface DeepSeekOcrTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** OCR 响应体。 */
export interface DeepSeekOcrResponse {
  id: string;
  object: string;
  /** unix 秒；缺失落 0（时间戳没有"未知"的安全默认值，0 即 epoch，调用方可判）。 */
  created: number;
  /** 回显请求里的 purpose；未知值时原样保留为字符串。 */
  purpose: string;
  /** 页数；缺失时用 pages.length 兜底（见 decodeOcrResponse）。 */
  page_count: number;
  pages: DeepSeekOcrPage[];
  /** 上游给了 usage 对象才有；缺失时整个键省略（绝不用 0 冒充，10 §6.1 规则 2）。 */
  usage?: DeepSeekOcrTokenUsage;
  /** 上游响应体原文（未建模顶层键不丢；恒存在，可能为 `{}`）。 */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// multipart/form-data 编码（OCR 与 ASR 共用）
// ---------------------------------------------------------------------------

/** multipart 里的文件字段。 */
export interface MultipartFileField {
  /** 表单字段名（OCR/ASR 都是 "file"）。 */
  name: string;
  filename: string;
  data: Uint8Array;
}

/** multipart 里的纯文本字段。 */
export interface MultipartTextField {
  name: string;
  value: string;
}

import { sanitizeMultipartFilename } from '../../http/multipart.js';

export { sanitizeMultipartFilename };

/**
 * 手写 multipart/form-data：一个文件字段 + N 个文本字段，边界用固定常量。
 *
 * 为什么不用 Node 18+ 的 FormData + fetch：那条路由把请求体形态交给运行时
 * （文件名规范化、Content-Type 选择、字节分块都不可控），而这个仓库的立场是
 * 「codec 产出确定的字节，transport 只负责发送」。手写后 OCR/ASR 的请求体可以被
 * 测试逐字节断言，也不会在升级 Node 时悄悄变形。
 *
 * 纯函数：同样的输入永远得到同样的字节（边界固定是无随机的前提）。
 */
export function encodeMultipartFormData(
  file: MultipartFileField,
  textFields: readonly MultipartTextField[],
): EncodedMultipartRequest {
  const boundary = DEEPSEEK_MULTIPART_BOUNDARY;
  const parts: Buffer[] = [];

  // 文件字段在前（文档的字段顺序），文本字段按给定顺序追加
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.name}"; filename="${sanitizeMultipartFilename(file.filename)}"\r\n` +
        // 格式由服务端按内容探测，这里不猜 mime（按扩展名猜反而可能误导）
        `Content-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    ),
  );
  parts.push(Buffer.from(file.data));
  parts.push(Buffer.from('\r\n', 'utf8'));

  for (const field of textFields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ---------------------------------------------------------------------------
// encode / decode
// ---------------------------------------------------------------------------

/**
 * OCR 请求 → multipart 请求体 + content-type 头。纯函数，不做校验（文件大小/页数
 * 由上游判，413 会带着状态码回来；本地重复一套上限只会漂移）。
 */
export function encodeOcrRequest(req: DeepSeekOcrRequest): EncodedMultipartRequest {
  return encodeMultipartFormData({ name: 'file', filename: req.filename, data: req.file }, [
    { name: 'purpose', value: req.purpose },
  ]);
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
 * 响应体 → 类型化 OCR 响应。**不抛**：非 object / pages 不是数组 / 页条目畸形全部
 * 退化成空 pages，raw 留原文。
 *
 * 两处兜底说明（都不是"猜"，是同一事实的另一种表达）：
 *   - `page_count` 缺失 → `pages.length`：文档里两者必然相等（page_count 就是页数），
 *     取 0 会让计费少记整个请求；
 *   - `pages[i].index` 缺失 → 数组下标：index 的语义就是"第几页"，与位置同义。
 */
export function decodeOcrResponse(raw: unknown): DeepSeekOcrResponse {
  const obj = asRecord(raw);
  const rawPages = obj?.['pages'];
  const pages = Array.isArray(rawPages) ? rawPages.map((entry, i) => decodeOcrPage(entry, i)) : [];
  const rawUsage = asRecord(obj?.['usage']);
  const usage: DeepSeekOcrTokenUsage | undefined =
    rawUsage === undefined
      ? undefined
      : {
          input_tokens: num(rawUsage['input_tokens']) ?? 0,
          output_tokens: num(rawUsage['output_tokens']) ?? 0,
          total_tokens: num(rawUsage['total_tokens']) ?? 0,
        };

  return {
    id: str(obj?.['id']) ?? '',
    object: str(obj?.['object']) ?? '',
    created: num(obj?.['created']) ?? 0,
    purpose: str(obj?.['purpose']) ?? '',
    page_count: num(obj?.['page_count']) ?? pages.length,
    pages,
    ...(usage === undefined ? {} : { usage }),
    raw: obj ?? {},
  };
}

function decodeOcrPage(entry: unknown, position: number): DeepSeekOcrPage {
  const p = asRecord(entry) ?? {};
  return {
    index: num(p['index']) ?? position,
    text: str(p['text']) ?? '',
    finish_reason: str(p['finish_reason']) ?? '',
  };
}

/**
 * 构造 OCR 的 canonical usage。
 *
 * **为什么 `units.requests = page_count` 而不是 1**：上游按**页**计费
 * （$0.225 / 1000 页），而 ir/usage.ts 的 `UsageUnits` 没有 pages 槽；`requests`
 * 是唯一表达"按次计费的内置工具"的通用槽。一次 100 页的 PDF 如果记 1 次请求，
 * metering 会少报 99 页的钱。取 page_count 后，按次计费口径与上游账单一致。
 *
 * 代价与缓解：`requests` 在语义上也用于"HTTP 请求数"（QPS 统计）。若调用方需要
 * 区分二者，请同时读 `raw.page_count` 与 `raw.pages`（原文都在），或在本函数外
 * 另行按端累计。这个权衡在任务书里被明确点名要求解释，故记录在此。
 *
 * **为什么不造 `units.tokens`**：文档原话"usage 仅供参考，不用于计费"，且 canonical
 * `TokenUsage` 的六个槽位里 cache_read/cache_write/reasoning 上游根本没给——填 0
 * 会冒充"已计量为 0"（10 §6.1 规则 2）。因此 token 数只进 `usage.raw` 逐字段保留。
 */
export function buildOcrUsage(res: DeepSeekOcrResponse): CanonicalUsage {
  return {
    units: { requests: res.page_count },
    ...(res.usage === undefined
      ? {}
      : {
          raw: {
            input_tokens: res.usage.input_tokens,
            output_tokens: res.usage.output_tokens,
            total_tokens: res.usage.total_tokens,
            // 计费真正的依据，进 raw 供对账（usage.raw 的既定用途）
            page_count: res.page_count,
          },
        }),
    source: 'provider',
  };
}

// ---------------------------------------------------------------------------
// 薄客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（传输 + 鉴权头注入；无模块级单例）。 */
export interface DeepSeekOcrClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
}

/** recognize() 的返回：解码后的完整响应 + usage + 状态码。 */
export interface DeepSeekOcrOutcome {
  /** decodeOcrResponse 的完整产物（含 raw 原文与逐页 text）。 */
  response: DeepSeekOcrResponse;
  usage: CanonicalUsage;
  httpStatus: number;
}

export class DeepSeekOcrClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: DeepSeekOcrClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.path = deps.path ?? DEEPSEEK_OCR_PATH;
  }

  /**
   * 调一次 /v1/tools/ocr。非 2xx 抛 `DeepSeekApiError`（status + 错误体）。
   *
   * 413（超 100 MiB）与 429（>15 并发）是调用方要分流的两类失败，状态码必须完整上抛。
   */
  async recognize(req: DeepSeekOcrRequest): Promise<DeepSeekOcrOutcome> {
    const encoded = encodeOcrRequest(req);
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
    throwIfNotOk(res, bodyText, 'ocr');

    const response = decodeOcrResponse(parseJsonOrUndefined(bodyText));
    return { response, usage: buildOcrUsage(response), httpStatus: res.status };
  }
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
