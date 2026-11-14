/**
 * providers/deepseek/fetch.ts —— DeepSeek 独立工具端点 /v1/tools/fetch 的 wire codec + 客户端。
 *
 * **这不是 chat pipeline 的一部分**（同目录 search.ts 顶部有完整说明）：不实现 Adaptor
 * 接口、不进 registry、不走 S0–S10。它是 standalone wire codec + 薄客户端。
 *
 * 唯一事实来源：DeepSeek 官方文档 api-docs.deepseek.com 的 Fetch 一节
 * （2026-11-14 核对）。要点：
 *   - POST https://api.deepseek.com/v1/tools/fetch，Authorization: Bearer <key>
 *     + Content-Type: application/json；
 *   - 请求只有一个必填字段 `url`：≤8192 字符，http/https 且带 host，
 *     **不允许**带用户名/密码（userinfo）；
 *   - 响应 `{title, content}`：`title` 取不到时是空串，`content` 是整页转成的
 *     Markdown（这是该端点唯一的正文出口，Search 的 need_content 之外的另一条路）；
 *   - 错误体与 Search 同款 OpenAI 兼容形状；403（被安全策略拒绝）/404（无可取内容）
 *     是这个端点最常见的两类失败；
 *   - 计费 $0.75 / 1000 次**成功**请求（200 且有正文返回）。
 *
 * 与 search.ts 的分工：search 管"找到哪些 URL"，fetch 管"把某个 URL 读成 Markdown"。
 * 两者共用 `DeepSeekApiError` / `throwIfNotOk`（定义在 search.ts，见那里的说明）。
 */

import type { CanonicalUsage } from '../../ir/index.js';
import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
import { DeepSeekApiError, throwIfNotOk } from './search.js';

/** 错误载体从 search.ts 再出口，便于调用方从任一端点文件 import 同一个类。 */
export { DeepSeekApiError };

/** DeepSeek 官方 base URL（与 search 同源，单独导出以便按端点覆盖）。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** Fetch 端点路径。 */
export const DEEPSEEK_FETCH_PATH = '/v1/tools/fetch';

// ---------------------------------------------------------------------------
// wire 类型
// ---------------------------------------------------------------------------

/** Fetch 请求体：只有一个字段。 */
export interface DeepSeekFetchRequest {
  /** http/https URL，≤8192 字符，带 host，不带 userinfo。 */
  url: string;
}

/** Fetch 响应体。 */
export interface DeepSeekFetchResponse {
  /** 取不到时是空串（不是 null——文档如此）。 */
  title: string;
  /** 整页 Markdown；失败页可能是空串。 */
  content: string;
  /** 上游响应体原文（未建模顶层键不丢；恒存在，可能为 `{}`）。 */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// encode / decode
// ---------------------------------------------------------------------------

/**
 * 请求对象 → wire body。纯函数，只发已建模字段（`url`）。
 * 保守理由：这些端点对未知字段的处理并不统一（OCR 明确「多余字段 → 400」），
 * 只发已知键在任何版本下都安全。
 */
export function encodeFetchRequest(req: DeepSeekFetchRequest): Record<string, unknown> {
  return { url: req.url };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 响应体 → 类型化 Fetch 响应。**不抛**：非 object 或缺字段时 title/content 落空串、
 * raw 留原文，调用方按"没取到内容"处理（与 404 的处置一致：换 URL 或放弃）。
 */
export function decodeFetchResponse(raw: unknown): DeepSeekFetchResponse {
  const obj = asRecord(raw);
  return {
    title: str(obj?.['title']) ?? '',
    content: str(obj?.['content']) ?? '',
    raw: obj ?? {},
  };
}

// ---------------------------------------------------------------------------
// 薄客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（传输 + 鉴权头注入；无模块级单例）。 */
export interface DeepSeekFetchClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  path?: string;
}

/** fetch() 的返回。 */
export interface DeepSeekFetchOutcome {
  title: string;
  content: string;
  /** 按次 usage：`{units:{requests:1}, source:'provider'}`（Fetch 按成功请求计费）。 */
  usage: CanonicalUsage;
  httpStatus: number;
}

export class DeepSeekFetchClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: DeepSeekFetchClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.path = deps.path ?? DEEPSEEK_FETCH_PATH;
  }

  /**
   * 调一次 /v1/tools/fetch。非 2xx 抛 `DeepSeekApiError`（status + 错误体）。
   *
   * 403/404 在这个端点上是"预期内"的失败（页面被安全策略拒绝 / 无可取内容），
   * 因此必须把状态码完整交给调用方去决定重试或换源，而不是包装成笼统的 Error。
   */
  async fetch(req: DeepSeekFetchRequest): Promise<DeepSeekFetchOutcome> {
    const headers: Record<string, string> = {
      ...(await this.headersProvider()),
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: this.baseUrl,
      path: this.path,
      headers,
      body: Buffer.from(JSON.stringify(encodeFetchRequest(req)), 'utf8'),
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const bodyText = (res.body ?? Buffer.alloc(0)).toString('utf8');
    throwIfNotOk(res, bodyText, 'fetch');

    const decoded = decodeFetchResponse(parseJsonOrUndefined(bodyText));
    return {
      title: decoded.title,
      content: decoded.content,
      usage: { units: { requests: 1 }, source: 'provider' },
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
