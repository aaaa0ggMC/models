/**
 * providers/deepseek/search.ts —— DeepSeek 独立工具端点 /v1/tools/search 的 wire codec + 客户端。
 *
 * **这不是 chat pipeline 的一部分**：本文件（以及同目录的 fetch / ocr / asr / tts）
 * 不实现 Adaptor 接口、不进 adaptors/registry.ts、不走 S0–S10 的任何一个阶段。
 * 它们是「standalone wire-format codec + 薄客户端」——网关把 DeepSeek 的工具端点
 * 当作搜索后端 / OCR / ASR / TTS 能力直接调用，用 canonical usage 记账后把结果
 * 注入 builtin tool 或直接回给客户端。装配在 providers/deepseek/index.ts 与
 * composition-root.ts（不由本文件负责）。
 *
 * 唯一事实来源：DeepSeek 官方文档 api-docs.deepseek.com 的 Search 一节
 * （2026-11-14 核对）。要点：
 *   - POST https://api.deepseek.com/v1/tools/search，Authorization: Bearer <key>
 *     + Content-Type: application/json；
 *   - 请求 `query` 必填（1–128 Unicode 字符，不支持纯空白，支持 site:/lang:/after:/before:
 *     与 "-exact" 操作符），`count` 默认 10（1–50），`ori_question` 可显式传 null 表示
 *     「不提供」，`localization` 是用于本地化结果的 IP 串（默认 ""），`need_content`
 *     默认 false；未知字段被服务端忽略；
 *   - 响应 `results[]` 每项 9 个字段：`rerank_score`（0–3，必填）、`title`、`url`、
 *     `snippet`（100–200 字符，给 UI）、`summary`（600–800 字符，给模型）、`content`
 *     （need_content=false 或取不到时为空串）、`site_name` / `site_icon`（可 null）、
 *     `date`（RFC3339 UTC 发布时间，可 null）、`authority`（−1..4，−1 = 未知，
 *     ≥3 视为高权威）；无匹配时 `results` 是空数组；
 *   - 错误体是 OpenAI 兼容形状 `{"error":{"message","type","param","code"}}`，`param`
 *     恒为 null；400/401/402 余额不足/403 被安全策略拒绝/404 无可取内容/408/413/429
 *     （Search QPS 100）/500/504；
 *   - 计费 $0.75 / 1000 次**成功**请求（HTTP 200 且 results 非空）；失败/空结果/超时不计费。
 *
 * 三条与仓库既有约定对齐的设计取舍（都写在对应函数上方）：
 *   1. decode **不猜也不丢**：缺字段落该类型的默认值，绝不抛；未知顶层键整包进 `raw`
 *      （10 §7 的 raw passthrough 立场，adaptors/openai-chat/codec.ts 的同款做法）；
 *   2. usage 是**按次**而不是按 token：`units.requests = 1`（ir/usage.ts 的
 *      `UsageUnits.requests` 就是「按次计费的内置工具」这个槽），计费事实（是否成功、
 *      是否空结果）由调用方结合 httpStatus 与 results.length 判断；
 *   3. 鉴权头与 base URL 一律由构造函数注入，本文件不读 process.env、不硬编码 key。
 */

import type { CanonicalUsage, SearchResultPart } from '../../ir/index.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../../gateway-core/transport.js';

// ---------------------------------------------------------------------------
// 端点常量（可覆盖：代理 / 内网镜像场景）
// ---------------------------------------------------------------------------

/** DeepSeek 官方 base URL（api-docs.deepseek.com）。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** Search 端点路径（注意带 /v1，与 chat 的 /chat/completions 不同 dialect）。 */
export const DEEPSEEK_SEARCH_PATH = '/v1/tools/search';

// ---------------------------------------------------------------------------
// wire 类型
// ---------------------------------------------------------------------------

/** Search 请求体（wire 形状）。未知字段服务端忽略，故 encode 只发已知键。 */
export interface DeepSeekSearchRequest {
  /** 搜索词，1–128 Unicode 字符，不支持纯空白；支持 site:/lang:/after:/before:/-"exact"。 */
  query: string;
  /** 返回条数，默认 10，范围 1–50。 */
  count?: number;
  /** 用户原始问题（用于改写 query 的上游参考）。文档：显式 null = 不提供。 */
  ori_question?: string | null;
  /** 用于本地化结果的 IP 串，默认 ""（空 = 不本地化）。 */
  localization?: string;
  /** 是否回正文 Markdown，默认 false。 */
  need_content?: boolean;
}

/** 单条搜索结果（wire 形状，9 个字段全建模）。 */
export interface DeepSeekSearchResult {
  /** 重排分 0–3；文档标 required，缺失时 decode 落 0（见 decodeSearchResult）。 */
  rerank_score: number;
  title: string;
  url: string;
  /** 100–200 字符，面向 UI 展示。 */
  snippet: string;
  /** 600–800 字符，面向模型消化。 */
  summary: string;
  /** need_content=false 或取不到时为空串。 */
  content: string;
  site_name: string | null;
  site_icon: string | null;
  /** RFC3339 UTC 发布时间；未知为 null。 */
  date: string | null;
  /** 权威分层 −1..4；−1 = 未知，≥3 = 高权威。 */
  authority: number;
}

/** Search 响应体。 */
export interface DeepSeekSearchResponse {
  results: DeepSeekSearchResult[];
  /**
   * 上游响应体原文（未建模顶层键因此不丢——10 §7 的 raw passthrough 立场）。
   * 恒存在，可能是 `{}`；调用方要"整包原样"时用它，不要重新序列化 results。
   */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 映射目标：网关搜索后端的 hit 形状
// ---------------------------------------------------------------------------

/**
 * 网关搜索后端的 hit（内置 web_search 的后端契约）。
 *
 * 字段名向 ir/chat.ts 的 `SearchResultPart`（source / title / url / snippet /
 * content / published_at / citation_index / score）对齐，但不强行同名——
 * DeepSeek 有三个 canonical 没有槽位的字段（summary / site_icon / authority），
 * 丢掉它们等于丢掉"给模型的长摘要"与"权威分层"，故在 hit 上保留原名。
 *
 * 与 SearchResultPart 的对应关系（同一批数据，两种消费者）：
 *   | SearchHit        | SearchResultPart | 说明                                   |
 *   | ---------------- | ---------------- | -------------------------------------- |
 *   | title            | title            | 同名                                   |
 *   | url              | url              | 同名                                   |
 *   | snippet          | snippet          | 同名（UI 用短摘要）                    |
 *   | summary          | —                | canonical 无槽位，hit 上保留           |
 *   | content          | content          | need_content=true 才有，空串时省略     |
 *   | score            | score            | ← rerank_score                        |
 *   | published_at     | published_at     | ← date（RFC3339）                      |
 *   | site_name        | source           | ← site_name（canonical 的 source 语义）|
 *   | —                | citation_index   | 由调用方编号，decode 不猜              |
 *   | authority        | —                | canonical 无槽位，hit 上保留           |
 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  content?: string;
  score?: number;
  authority?: number;
  site_name?: string | null;
  published_at?: string | null;
}

/** DeepSeek 结果 → 网关搜索 hit。纯函数，不抛（输入已由 decodeSearchResponse 收口）。 */
export function toSearchHits(res: DeepSeekSearchResponse): SearchHit[] {
  return res.results.map((r) => {
    const hit: SearchHit = {
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      summary: r.summary,
      score: r.rerank_score,
      authority: r.authority,
      site_name: r.site_name,
      published_at: r.date,
    };
    // content 空串 = 「没取正文」，省略而不是塞空串：下游渲染"展开原文"要靠有无判断
    if (r.content !== '') hit.content = r.content;
    return hit;
  });
}

/**
 * DeepSeek 结果 → canonical `SearchResultPart[]`（注入 chat 的 search_result part 用）。
 *
 * `citation_index` 由调用方给（`startCitationIndex` 起编号）：引用编号是**整轮对话**的
 * 属性，单个后端看不到全局序号，decode 猜一个必然与别家冲突（10 §9.1 的同一立场）。
 */
export function toSearchResultParts(
  res: DeepSeekSearchResponse,
  startCitationIndex = 0,
): SearchResultPart[] {
  return res.results.map((r, i) => {
    const part: SearchResultPart = {
      type: 'search_result',
      // canonical 的 source 必填：site_name 缺失时落空串，**不拿 url host 猜**
      source: r.site_name ?? '',
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      score: r.rerank_score,
      citation_index: startCitationIndex + i,
    };
    // canonical 的 published_at 是 string|undefined（没有 null 槽）：date 为 null
    // （发布时间未知）时**省略键**，而不是把 null/undefined 塞进去让下游按"有值"处理
    if (r.date !== null) part.published_at = r.date;
    if (r.content !== '') part.content = r.content;
    return part;
  });
}

// ---------------------------------------------------------------------------
// 共享错误类型
// ---------------------------------------------------------------------------

/**
 * DeepSeek 端点非 2xx 的统一错误载体。
 *
 * 为什么不复用 ir/error.ts 的 `CanonicalError`：那是有 `request_id` 的管道内错误模型
 * （20 §7.1），而这些端点不在管道里；调用方（providers/deepseek/index.ts）负责把它
 * 归一成 CanonicalError。这里只保证「状态码 + 解析后的错误体」不丢，方便对账。
 *
 * 按本次任务的写权限只能创建本目录这几个文件，故共享类型落在 search.ts
 * （spec 里第一个端点文件），fetch / ocr / asr / tts 从这儿 import。
 * 若后续允许新增文件，应抽到 providers/deepseek/client-error.ts。
 */
export class DeepSeekApiError extends Error {
  constructor(
    readonly status: number,
    /** 解析后的上游错误体；解析失败时是原始文本（不猜结构）。 */
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'DeepSeekApiError';
  }
}

/**
 * 解析上游错误体：OpenAI 兼容形状 `{"error":{...}}` 优先；解析失败原样返回文本。
 * 纯函数，不抛（畸形错误体也要能把状态码带上去）。
 */
export function parseUpstreamErrorBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * 非 2xx → 抛 `DeepSeekApiError`（状态码 + 错误体都在上面，不吞）。
 * 2xx 静默返回，便于在表达式位置调用。
 */
export function throwIfNotOk(res: UpstreamResponse, bodyText: string, label: string): void {
  if (res.status >= 200 && res.status < 300) return;
  throw new DeepSeekApiError(
    res.status,
    parseUpstreamErrorBody(bodyText),
    `DeepSeek ${label} 上游返回 HTTP ${res.status}`,
  );
}

// ---------------------------------------------------------------------------
// encode：canonical/调用方形状 → wire
// ---------------------------------------------------------------------------

/**
 * 请求对象 → wire body。**纯函数**：只丢 `undefined`（JSON.stringify 本来也会丢），
 * 不做任何校验——长度/范围/空白校验是调用方或上游的职责，codec 不重复实现一套
 * 会漂移的规则（40 §1.4：不猜）。
 *
 * `ori_question` 的 `null` 一并省掉：文档写明「null = 不提供」，与省略在服务端等价，
 * 落成 null 只是多几个字节。
 */
export function encodeSearchRequest(req: DeepSeekSearchRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { query: req.query };
  if (req.count !== undefined) body['count'] = req.count;
  if (req.ori_question !== undefined && req.ori_question !== null) {
    body['ori_question'] = req.ori_question;
  }
  if (req.localization !== undefined) body['localization'] = req.localization;
  if (req.need_content !== undefined) body['need_content'] = req.need_content;
  return body;
}

// ---------------------------------------------------------------------------
// decode：wire → 类型化形状（不猜也不丢）
// ---------------------------------------------------------------------------

/**
 * 任意 unknown → object（不是 object 时返回 undefined）。
 * 与 adaptors/openai-chat/codec.ts 的 asRecord 同款：decode 的前向兼容底座。
 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** 数字字段读取：只认有限 number，其余（字符串数字 / null / undefined）一律 undefined。 */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 字符串字段读取：只认 string，其余 undefined（调用方决定默认值）。 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 可空字符串：string 原样，null 原样，其余（缺失 / 数字…）落 null。 */
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * 响应体 → 类型化 Search 响应。**不抛**：非 object、`results` 不是数组、数组里混着
 * 非 object 条目，全部退化成「空结果 + raw 留原文」，让调用方按"无匹配"处理而不是炸。
 */
export function decodeSearchResponse(raw: unknown): DeepSeekSearchResponse {
  const obj = asRecord(raw);
  const rawResults = obj?.['results'];
  const results = Array.isArray(rawResults)
    ? rawResults.map((entry) => decodeSearchResult(entry))
    : [];
  return { results, raw: obj ?? {} };
}

/**
 * 单条结果 → 类型化形状。
 *
 * 缺字段的默认值（逐个说明为什么是这个值，而不是 0/'' 一把梭）：
 *   - `rerank_score` 缺失 → 0：文档标 required，真实响应必有；0 表示"无排序分"，
 *     排序上等价于排最后，比抛异常或整条丢弃更可用；
 *   - `title` / `url` / `snippet` / `summary` / `content` 缺失 → ''：渲染层对空串
 *     有既定处理（不显示），比塞占位符安全；
 *   - `site_name` / `site_icon` / `date` 缺失 → null：文档就是 string|null，
 *     null = 未知，与"空串"语义不同（空串会被误显示成空白条目）；
 *   - `authority` 缺失 → −1：文档的"未知"哨兵值，绝不默认成 0（0 是一个真实档位）。
 */
function decodeSearchResult(entry: unknown): DeepSeekSearchResult {
  const r = asRecord(entry) ?? {};
  return {
    rerank_score: num(r['rerank_score']) ?? 0,
    title: str(r['title']) ?? '',
    url: str(r['url']) ?? '',
    snippet: str(r['snippet']) ?? '',
    summary: str(r['summary']) ?? '',
    content: str(r['content']) ?? '',
    site_name: nullableStr(r['site_name']),
    site_icon: nullableStr(r['site_icon']),
    date: nullableStr(r['date']),
    authority: num(r['authority']) ?? -1,
  };
}

// ---------------------------------------------------------------------------
// 薄客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（横切能力全部注入：传输、鉴权头；无模块级单例）。 */
export interface DeepSeekSearchClientDeps {
  transport: Transport;
  /** 产出鉴权头（含 Authorization: Bearer <key>）。每次调用重新取，便于轮换 key。 */
  headersProvider: () => Promise<Record<string, string>>;
  /** 上游 base URL，默认 DEEPSEEK_DEFAULT_BASE_URL。 */
  baseUrl?: string;
  /** 端点路径，默认 DEEPSEEK_SEARCH_PATH。 */
  path?: string;
}

/** search() 的返回。 */
export interface DeepSeekSearchOutcome {
  results: DeepSeekSearchResult[];
  /**
   * 按次 usage：`{units:{requests:1}, source:'provider'}`。
   * 这三个端点都不按 token 计费（Search/Fetch $0.75 每千次**成功**请求），
   * 因此不造 units.tokens——填 0 会冒充"已计量为 0"（10 §6.1 规则 2）。
   */
  usage: CanonicalUsage;
  httpStatus: number;
}

export class DeepSeekSearchClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;

  constructor(deps: DeepSeekSearchClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.path = deps.path ?? DEEPSEEK_SEARCH_PATH;
  }

  /**
   * 调一次 /v1/tools/search。
   *
   * 非 2xx 抛 `DeepSeekApiError`（status + 解析后错误体）——403/404/429 各有各的
   * 处置（换 localization、换 URL、退避重试），吞掉状态码就没法决策。
   */
  async search(req: DeepSeekSearchRequest): Promise<DeepSeekSearchOutcome> {
    const headers: Record<string, string> = {
      ...(await this.headersProvider()),
      'content-type': 'application/json',
    };
    const upstream: UpstreamRequest = {
      method: 'POST',
      base_url: this.baseUrl,
      path: this.path,
      headers,
      body: Buffer.from(JSON.stringify(encodeSearchRequest(req)), 'utf8'),
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const bodyText = (res.body ?? Buffer.alloc(0)).toString('utf8');
    throwIfNotOk(res, bodyText, 'search');

    return {
      results: decodeSearchResponse(parseJsonOrUndefined(bodyText)).results,
      usage: { units: { requests: 1 }, source: 'provider' },
      httpStatus: res.status,
    };
  }
}

/** 响应体 JSON 解析：失败返回 undefined（decodeSearchResponse 会把非 object 当空结果）。 */
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
