/**
 * http/multipart.ts —— multipart/form-data 解析（**自研，零运行时依赖**）。
 *
 * ## 为什么不用库
 *
 * 候选是 `busboy`（+ `@fastify/busboy`）与 `formidable`。三个理由都不划算：
 *   1. **体积**：busboy 本体 ~30 KB，但它把 `streamsearch` 拖进来，formidable 更是把
 *      `lodash`/`qs` 一起带上——而这个仓库的生产依赖目前只有 `ajv` 一个；
 *   2. **我们不需要流式**：DeepSeek ASR 的用法是「整个文件一次上传、一次拿完整转写」
 *      （providers/deepseek/asr.ts：无流式），上游还限 ≤8 MiB。既然必须整块读进内存，
 *      流式解析器省下的只是「边收边吐字段」这一点点，却要多背一条依赖树；
 *   3. **错误可观测性**：自研可以把每一类畸形输入映射成一个短 code（缺 boundary /
 *      缺结束边界 / 分片过大 / 缺 file 字段…），测试逐条断言；库的错误对象形状各异，
 *      还要再包一层才能进我们的 OpenAI 风格错误信封。
 *
 * 代价（写在这里而不是藏在注释里）：分隔符扫描是 O(n·m) 的 `Buffer.indexOf`
 * （Node 内部用 Boyer-Moore-Horspool，实际接近线性），整块缓冲使峰值内存 ≈ 请求体
 * 大小 + 最大的那个文件副本。对 8 MiB 上限完全可接受。
 *
 * ## 安全边界（不弱化）
 *
 * - **分片数 / 字段大小 / 文件大小 / 头部大小**四条上限，缺一个就能被一个畸形请求
 *   打爆内存（例如 100 万个 1 字节的"分片"）；
 * - **boundary 白名单字符**（RFC 2046）：不接受控制字符与超长边界，避免把奇怪的串
 *   喂进分隔符扫描；
 * - **必须 CRLF**：分隔符只认 `\r\n`，不做 LF 兜底猜测——猜错的代价是把音频字节
 *   切错位置，而那在上游是 400，在客户端是"转写结果莫名其妙"。
 */

import { Buffer } from 'node:buffer';

/**
 * 文件名净化：引号/反斜杠删掉（否则能注入任意头），其余非可打印 ASCII 统一下划线。
 * 空结果回落 `'upload.bin'`，保证传给上游的 multipart file part 始终带安全文件名。
 */
export function sanitizeMultipartFilename(name: string): string {
  const cleaned = name.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_');
  return cleaned === '' ? 'upload.bin' : cleaned;
}

// ---------------------------------------------------------------------------
// 限额
// ---------------------------------------------------------------------------

/** 解析限额（调用方可按端点收紧；缺省值对齐 DeepSeek ASR 的 8 MiB 文件上限）。 */
export interface MultipartLimits {
  /** 最多多少个分片（字段 + 文件一起数）。 */
  readonly max_parts: number;
  /** 单个**文本字段**的字节上限（model / language / prompt 都远小于它）。 */
  readonly max_field_bytes: number;
  /** 单个**文件**的字节上限（ASR：8 MiB，与上游一致）。 */
  readonly max_file_bytes: number;
  /** 单个分片头部的字节上限（Content-Disposition + Content-Type 就那么长）。 */
  readonly max_header_bytes: number;
}

export const DEFAULT_MULTIPART_LIMITS: MultipartLimits = {
  max_parts: 16,
  max_field_bytes: 256 * 1024,
  max_file_bytes: 8 * 1024 * 1024,
  max_header_bytes: 16 * 1024,
};

/** 畸形 multipart 的短 code（HTTP 层原样进 OpenAI 风格错误信封的 `code`）。 */
export type MultipartErrorCode =
  | 'unsupported_media_type'
  | 'missing_boundary'
  | 'bad_boundary'
  | 'malformed_body'
  | 'missing_terminator'
  | 'part_too_large'
  | 'too_many_parts'
  | 'headers_too_large'
  | 'bad_content_disposition'
  | 'missing_file';

/** 请求体不合法（http 层 → 400 + 一句话）。 */
export class MultipartError extends Error {
  constructor(
    readonly code: MultipartErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MultipartError';
  }
}

// ---------------------------------------------------------------------------
// 解析结果
// ---------------------------------------------------------------------------

/** 一个文件分片（`filename` 已净化，见 sanitizeMultipartFilename）。 */
export interface ParsedFilePart {
  readonly name: string;
  readonly filename: string;
  readonly content_type: string;
  readonly data: Buffer;
}

export interface ParsedFormData {
  /** 文本字段（同名后者覆盖前者——OpenAI 的转写请求没有同名字段）。 */
  readonly fields: Map<string, string>;
  readonly files: ParsedFilePart[];
}

/** 取一个必需的文件字段（缺了就是客户端没带 file，不是上游的错）。 */
export function requireFile(parsed: ParsedFormData, name = 'file'): ParsedFilePart {
  const file = parsed.files.find((f) => f.name === name);
  if (file === undefined) {
    throw new MultipartError('missing_file', `multipart 缺少 ${name} 文件字段`);
  }
  return file;
}

/** 取一个可选的文本字段（不存在 = 没传，不是空串）。 */
export function optionalField(parsed: ParsedFormData, name: string): string | undefined {
  return parsed.fields.get(name);
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * boundary 的合法字符（RFC 2046 §5.1.1 的 bcharsnospace + 空格）。
 *
 * 白名单而不是黑名单：控制字符与超长边界必须在进分隔符扫描之前拦掉。
 */
const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,\-./:=? ]+$/;

/** 从 Content-Type 里取 boundary（缺 / 超长 / 含非法字符各自一个短 code）。 */
export function extractBoundary(contentType: string | undefined): string {
  if (contentType === undefined || !/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) {
    throw new MultipartError('unsupported_media_type', 'Content-Type 应为 multipart/form-data');
  }
  // 带引号取引号内；不带引号取到下一个 `;` 为止——后者含 `"` 时说明这个 boundary
  // 根本不是合法 token（RFC 2046 的 bchars 不含引号），交给下面的字符白名单拦
  const m = /[;,]\s*boundary\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(contentType);
  const raw = (m?.[1] ?? m?.[2] ?? '').trim();
  if (raw === '') throw new MultipartError('missing_boundary', 'multipart 缺少 boundary 参数');
  if (raw.length > 70) throw new MultipartError('bad_boundary', 'multipart boundary 超过 70 字符');
  if (!BOUNDARY_CHARS.test(raw)) {
    throw new MultipartError('bad_boundary', 'multipart boundary 含非法字符');
  }
  return raw;
}

/**
 * 解析整个 multipart 体。**纯函数**（同一个 Buffer 永远得到同一个结果）。
 *
 * 结构（RFC 7578）：
 * ```text
 * --boundary\r\n
 * Content-Disposition: form-data; name="file"; filename="a.wav"\r\n
 * Content-Type: application/octet-stream\r\n
 * \r\n
 * <字节>\r\n
 * --boundary\r\n
 * ...\r\n
 * --boundary--\r\n
 * ```
 */
export function parseMultipartFormData(
  body: Buffer,
  contentType: string | undefined,
  limits: MultipartLimits = DEFAULT_MULTIPART_LIMITS,
): ParsedFormData {
  const boundary = extractBoundary(contentType);
  const dashBoundary = `--${boundary}`;
  const separator = `\r\n${dashBoundary}`;

  // 体必须以边界开头（不允许前导空白：那说明 Content-Length 与实体对不上）
  if (body.indexOf(dashBoundary, 0, 'latin1') !== 0) {
    throw new MultipartError('malformed_body', 'multipart 体不是以边界开头');
  }

  const fields = new Map<string, string>();
  const files: ParsedFilePart[] = [];
  let pos = dashBoundary.length;
  let parts = 0;

  for (;;) {
    // 紧跟边界的 `--` = 收尾分隔符（后面可以没有 CRLF）
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) {
      throw new MultipartError('malformed_body', 'multipart 边界之后缺少 CRLF');
    }
    pos += 2;

    const next = body.indexOf(separator, pos, 'latin1');
    if (next < 0) {
      throw new MultipartError('missing_terminator', 'multipart 体缺少结束边界');
    }
    const raw = body.subarray(pos, next);
    pos = next + separator.length;

    if (++parts > limits.max_parts) {
      throw new MultipartError('too_many_parts', `multipart 分片超过 ${limits.max_parts} 个`);
    }
    addPart(raw, fields, files, limits);
  }

  return { fields, files };
}

/** 一个分片 → fields / files。畸形分片一律抛（不猜、不跳过）。 */
function addPart(
  raw: Buffer,
  fields: Map<string, string>,
  files: ParsedFilePart[],
  limits: MultipartLimits,
): void {
  const headerEnd = raw.indexOf('\r\n\r\n', 0, 'latin1');
  if (headerEnd < 0) {
    throw new MultipartError('malformed_body', 'multipart 分片缺少头部与主体的分隔');
  }
  const headerBytes = raw.subarray(0, headerEnd);
  if (headerBytes.length > limits.max_header_bytes) {
    throw new MultipartError('headers_too_large', `分片头部超过 ${limits.max_header_bytes} 字节`);
  }
  const headers = parsePartHeaders(headerBytes.toString('utf8'));
  const disposition = headers.get('content-disposition');
  if (disposition === undefined) {
    throw new MultipartError('bad_content_disposition', '分片缺少 Content-Disposition 头');
  }
  const { name, filename } = parseContentDisposition(disposition);
  if (name === '') {
    throw new MultipartError('bad_content_disposition', '分片的 Content-Disposition 缺少 name');
  }

  const content = raw.subarray(headerEnd + 4);
  if (filename === undefined) {
    if (content.length > limits.max_field_bytes) {
      throw new MultipartError(
        'part_too_large',
        `字段 ${name} 超过 ${limits.max_field_bytes} 字节`,
      );
    }
    fields.set(name, content.toString('utf8'));
    return;
  }
  if (content.length > limits.max_file_bytes) {
    throw new MultipartError('part_too_large', `文件 ${name} 超过 ${limits.max_file_bytes} 字节`);
  }
  files.push({
    name,
    // 只留最后一段：文件名只是给上游的标签（服务端按内容探测格式），但没必要把
    // 目录结构带进 Content-Disposition 与日志
    filename: sanitizeMultipartFilename(lastPathSegment(filename)),
    content_type: headers.get('content-type') ?? 'application/octet-stream',
    // 拷贝而不是留 subarray 视图：视图会把整个请求体（含别人的字段）一起钉在内存里
    data: Buffer.from(content),
  });
}

/** `a/b/c.wav` → `c.wav`（反斜杠也切：Windows 风格路径同样是路径）。 */
function lastPathSegment(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return slash < 0 ? name : name.slice(slash + 1);
}

/** 分片头部 → 小写键的表。不支持 obs-fold 续行（真实编码器都不发）。 */
function parsePartHeaders(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

/**
 * `Content-Disposition: form-data; name="file"; filename="a.wav"` → 参数表。
 *
 * 手写而不用 `new URLSearchParams(...)`：参数值是带引号的串，引号里可以含 `;`，
 * 而 SearchParams 的切分不认识引号。同时支持 RFC 5987 的 `filename*=UTF-8''…`
 * （部分客户端对非 ASCII 文件名会发它）。
 */
export function parseContentDisposition(value: string): { name: string; filename?: string } {
  const params = headerParams(value);
  const name = params.get('name') ?? '';
  const encoded = params.get('filename*');
  const filename =
    encoded !== undefined && encoded !== ''
      ? decodeExtendedFilename(encoded)
      : params.get('filename');
  return filename === undefined || filename === '' ? { name } : { name, filename };
}

/** `UTF-8''%E9%9F%B3` → 原串（解不了就回落原文，不让上传整体失败）。 */
function decodeExtendedFilename(value: string): string {
  const quote = value.indexOf("''");
  if (quote < 0) return value;
  const encoded = value.slice(quote + 2);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** 头参数切分（认识引号与 `\"` 转义）。 */
function headerParams(value: string): Map<string, string> {
  const out = new Map<string, string>();
  const semi = value.indexOf(';');
  if (semi < 0) return out;
  const rest = value.slice(semi + 1);
  let pos = 0;
  while (pos < rest.length) {
    while (pos < rest.length && (rest[pos] === ';' || rest[pos] === ' ' || rest[pos] === '\t')) {
      pos++;
    }
    let key = '';
    while (pos < rest.length && rest[pos] !== '=' && rest[pos] !== ';') key += rest[pos++];
    key = key.trim().toLowerCase();
    if (rest[pos] !== '=') {
      if (key !== '') out.set(key, '');
      continue;
    }
    pos++; // 跳过 '='
    let val = '';
    if (rest[pos] === '"') {
      pos++;
      while (pos < rest.length && rest[pos] !== '"') {
        if (rest[pos] === '\\' && pos + 1 < rest.length) {
          val += rest[pos + 1];
          pos += 2;
          continue;
        }
        val += rest[pos++];
      }
      if (rest[pos] === '"') pos++;
    } else {
      while (pos < rest.length && rest[pos] !== ';') val += rest[pos++];
      val = val.trim();
    }
    if (key !== '') out.set(key, val);
  }
  return out;
}
