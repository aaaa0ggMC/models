/**
 * providers/openai-images/client.ts —— OpenAI Images 的薄客户端（传输 + 错误分类）。
 *
 * 与同目录 wire.ts 的分工：wire.ts 是纯映射（canonical ↔ wire），本文件只做
 * 「发请求、读响应、非 2xx 分类」。无模块级单例、无 `process.env` 读取——
 * 传输与鉴权头全部注入（与 providers/deepseek/ 各客户端同立场）。
 *
 * ⚠️ **未接真实上游**：本客户端按官方 API reference 与 SDK 类型实现，但本仓库
 * 没有 OpenAI key，所有测试走 `ScriptedTransport`（mock 上游）。拿到 key 后只需
 * 在组合根里注入真实 transport 与凭据解析，代码路径不变——85 号矩阵文档的
 * image 卡片记的就是这个状态。
 */

import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';

/** OpenAI Images 的官方 base URL。 */
export const OPENAI_IMAGES_BASE_URL = 'https://api.openai.com';

/** generations 端点路径。 */
export const OPENAI_IMAGES_GENERATIONS_PATH = '/v1/images/generations';

/** edits 端点路径。 */
export const OPENAI_IMAGES_EDITS_PATH = '/v1/images/edits';

/** 上游返回了非 2xx（http 层分类成客户端错误）。 */
export class OpenAIImagesApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`OpenAI Images 上游返回 HTTP ${status}`);
    this.name = 'OpenAIImagesApiError';
  }
}

/** 客户端构造依赖。 */
export interface OpenAIImagesClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  baseUrl?: string;
  generationsPath?: string;
  editsPath?: string;
}

/** 上游响应的最小投影（status + body 字节 + 响应头）。 */
export interface ImagesUpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * 薄客户端：两个方法对应两个端点。
 *
 * 非 2xx 抛 `OpenAIImagesApiError`（带 status 与错误体原文——**原文只进日志/对账，
 * 不回显客户端**：http 层的 classify 会挑一句话）。2xx 但 body 不是合法 JSON 时
 * 同样抛（上游违约，不能当空响应吞掉）。
 */
export class OpenAIImagesClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly generationsPath: string;
  private readonly editsPath: string;

  constructor(deps: OpenAIImagesClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? OPENAI_IMAGES_BASE_URL;
    this.generationsPath = deps.generationsPath ?? OPENAI_IMAGES_GENERATIONS_PATH;
    this.editsPath = deps.editsPath ?? OPENAI_IMAGES_EDITS_PATH;
  }

  /** `POST /v1/images/generations`（JSON）。 */
  async generate(
    body: unknown,
    override?: { baseUrl?: string; headersProvider?: () => Promise<Record<string, string>> },
  ): Promise<ImagesUpstreamResponse> {
    return this.send(
      this.generationsPath,
      Buffer.from(JSON.stringify(body), 'utf8'),
      { 'content-type': 'application/json' },
      override,
    );
  }

  /** `POST /v1/images/edits`（multipart：body 已由 wire.ts 编码好）。 */
  async edit(
    body: Buffer,
    contentType: string,
    override?: { baseUrl?: string; headersProvider?: () => Promise<Record<string, string>> },
  ): Promise<ImagesUpstreamResponse> {
    return this.send(this.editsPath, body, { 'content-type': contentType }, override);
  }

  private async send(
    path: string,
    body: Buffer,
    extraHeaders: Record<string, string>,
    override?: { baseUrl?: string; headersProvider?: () => Promise<Record<string, string>> },
  ): Promise<ImagesUpstreamResponse> {
    const getHeaders = override?.headersProvider ?? this.headersProvider;
    const headers: Record<string, string> = {
      ...(await getHeaders()),
      ...extraHeaders,
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: override?.baseUrl ?? this.baseUrl,
      path,
      headers,
      body,
      stream: false,
    };
    const res: UpstreamResponse = await this.transport.send(upstream);
    const resBody = res.body ?? Buffer.alloc(0);
    if (res.status < 200 || res.status >= 300) {
      throw new OpenAIImagesApiError(res.status, resBody.toString('utf8').slice(0, 2048));
    }
    return { status: res.status, headers: res.headers, body: resBody };
  }
}
