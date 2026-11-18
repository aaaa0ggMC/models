/**
 * providers/deepseek/tool-handlers.ts —— DeepSeek 全家桶五个独立端点的 **canonical 往返**装配。
 *
 * 分工（本目录内的边界）：
 *   - `search.ts` / `fetch.ts` / `ocr.ts` / `asr.ts` / `tts.ts`：**wire codec + 薄客户端**
 *     （上游长什么样、怎么编解码、按什么单位计费）。它们不知道 canonical 的存在。
 *   - **本文件**：canonical ↔ wire 的双向映射（客户端 JSON → canonical → wire；
 *     上游响应 → canonical → 客户端 JSON）+ 端点路由元数据。这是"接入网关"的那一层。
 *   - `http/tools-endpoint.ts`：HTTP 层的鉴权、分发、错误信封、计量落库。
 *
 * ## 为什么往返在本文件而不在 http 层
 *
 * canonical 是网关与客户端之间的唯一语言（00 §5：不存在原样转发字节的路径）。
 * 把映射放在 provider 目录里，换一家上游时只需替换这一个文件；放在 http 层则会让
 * "上游字段名"泄漏到传输层，而传输层本该对上游一无所知。
 *
 * ## 计费口径（与 UsageUnits 的对应，**峰谷无关**）
 *
 * | 端点 | 上游计费 | canonical units | 说明 |
 * | --- | --- | --- | --- |
 * | search | $0.75 / 1000 次**成功**请求 | `requests: 1` | 失败/空结果不计费 |
 * | fetch | 同上 | `requests: 1` | 同上 |
 * | ocr | $0.225 / 1000 页 | `requests: page_count` | 上游 usage 仅参考，**不用于计费** |
 * | asr | 按音频时长 | `audio_seconds: {input, billed}` | duration_ms 是唯一依据 |
 * | tts | 按字符（CJK 每字 2） | `characters: {input, billed}` | 在网关侧算，上游不给 |
 *
 * 按次计费的两个端点**与峰谷时段无关**（没有 off-peak 折扣），因此这里不做任何
 * 点时间解析——价格查表在 metering/pricing.ts，与 chat 的 token 计价同一条路。
 */

import { Buffer } from 'node:buffer';
import type { CanonicalToolRequest, SearchResultPart } from '../../ir/index.js';
import { ToolRequestError, type ToolEndpointHandler } from '../../http/tools-endpoint.js';
import { toSearchResultParts } from './search.js';
import type { DeepSeekSearchClient } from './search.js';
import { DeepSeekFetchClient } from './fetch.js';
import { DeepSeekOcrClient } from './ocr.js';
import { DeepSeekAsrClient } from './asr.js';
import { DeepSeekTtsClient } from './tts.js';

export { ToolRequestError, type ToolEndpointHandler };

/** 五个 handler 的构造依赖（横切能力全部注入；无模块级单例）。 */
export interface DeepSeekToolHandlerDeps {
  search: DeepSeekSearchClient;
  fetch: DeepSeekFetchClient;
  ocr: DeepSeekOcrClient;
  asr: DeepSeekAsrClient;
  tts: DeepSeekTtsClient;
}

// ---------------------------------------------------------------------------
// 请求体读取小工具（不猜：缺字段/类型错一律 400，不落默认值）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ToolRequestError('请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

function reqStr(body: Record<string, unknown>, key: string, max = 8192): string {
  const v = body[key];
  if (typeof v !== 'string' || v === '') {
    throw new ToolRequestError(`缺少字段 ${key}（应为非空字符串）`);
  }
  if (v.length > max) throw new ToolRequestError(`字段 ${key} 超过 ${max} 字符`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolRequestError(`字段 ${key} 应为字符串`);
  return v;
}

function optBool(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolRequestError(`字段 ${key} 应为布尔值`);
  return v;
}

function optCount(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ToolRequestError(`字段 ${key} 应为整数`);
  }
  if (v < min || v > max) throw new ToolRequestError(`字段 ${key} 应在 ${min}–${max} 之间`);
  return v;
}

/** 读 base64 文件字段（**严格的 base64 校验**：坏 base64 会让上游收到乱码文件）。 */
function reqFile(
  body: Record<string, unknown>,
  key: string,
): { filename: string; content_type: string; data_base64: string } {
  const v = body[key];
  const rec = asRecord(v);
  const filename = reqStr(rec, 'filename', 256);
  const content_type = reqStr(rec, 'content_type', 128);
  const data_base64 = reqStr(rec, 'data_base64', 32 * 1024 * 1024);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data_base64) || data_base64.length % 4 !== 0) {
    throw new ToolRequestError(`字段 ${key}.data_base64 不是合法 base64`);
  }
  return { filename, content_type, data_base64 };
}

function decodeBase64(data: string): Buffer {
  return Buffer.from(data, 'base64');
}

// ---------------------------------------------------------------------------
// 五个 handler
// ---------------------------------------------------------------------------

const SEARCH_PATH = '/v1/tools/search';
const FETCH_PATH = '/v1/tools/fetch';
const OCR_PATH = '/v1/tools/ocr';
const ASR_PATH = '/v1/tools/asr';
const TTS_PATH = '/v1/tools/tts';

/** 五个端点的装配（顺序即文档里的列举顺序）。 */
export function createDeepSeekToolHandlers(deps: DeepSeekToolHandlerDeps): ToolEndpointHandler[] {
  return [
    searchHandler(deps),
    fetchHandler(deps),
    ocrHandler(deps),
    asrHandler(deps),
    ttsHandler(deps),
  ];
}

function searchHandler(deps: DeepSeekToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'search',
    path: SEARCH_PATH,
    provider: 'deepseek',
    access_path: 'deepseek.tools.search',
    // 计费判据去 chat 那条 path 上问（凭据登记在那里；同一把 key、同一个账号）
    billing_access_path: 'deepseek.openai-chat',
    decodeRequest(body) {
      const rec = asRecord(body);
      const req: CanonicalToolRequest = {
        endpoint: 'search',
        query: reqStr(rec, 'query', 128),
        raw: {},
      };
      const count = optCount(rec, 'count', 1, 50);
      if (count !== undefined) req.count = count;
      const need = optBool(rec, 'need_content');
      if (need !== undefined) req.need_content = need;
      const ori = optStr(rec, 'ori_question');
      if (ori !== undefined) req.ori_question = ori;
      const loc = optStr(rec, 'localization');
      if (loc !== undefined) req.localization = loc;
      return req;
    },
    async run(req) {
      if (req.endpoint !== 'search') throw new ToolRequestError('端点不匹配');
      const outcome = await deps.search.search({
        query: req.query,
        ...(req.count === undefined ? {} : { count: req.count }),
        ...(req.need_content === undefined ? {} : { need_content: req.need_content }),
        ...(req.ori_question === undefined ? {} : { ori_question: req.ori_question }),
        ...(req.localization === undefined ? {} : { localization: req.localization }),
      });
      // canonical `SearchResultPart`：与 chat 的 search_result part 同一形状，
      // 引用编号从 0 起（单端点调用没有"整轮对话"可言）
      const results: SearchResultPart[] = toSearchResultParts(
        { results: outcome.results, raw: {} },
        0,
      );
      return { endpoint: 'search', results, usage: outcome.usage, raw: {} };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'search') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.search.result',
        results: res.results.map((r) => ({
          source: r.source,
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          ...(r.content === undefined ? {} : { content: r.content }),
          ...(r.published_at === undefined ? {} : { published_at: r.published_at }),
          citation_index: r.citation_index,
          score: r.score,
        })),
        usage: res.usage,
      };
    },
  };
}

function fetchHandler(deps: DeepSeekToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'fetch',
    path: FETCH_PATH,
    provider: 'deepseek',
    access_path: 'deepseek.tools.fetch',
    // 计费判据去 chat 那条 path 上问（凭据登记在那里；同一把 key、同一个账号）
    billing_access_path: 'deepseek.openai-chat',
    decodeRequest(body) {
      const rec = asRecord(body);
      return { endpoint: 'fetch', url: reqStr(rec, 'url', 8192), raw: {} };
    },
    async run(req) {
      if (req.endpoint !== 'fetch') throw new ToolRequestError('端点不匹配');
      const outcome = await deps.fetch.fetch({ url: req.url });
      return {
        endpoint: 'fetch',
        content: outcome.content,
        ...(outcome.title === '' ? {} : { title: outcome.title }),
        usage: outcome.usage,
        raw: {},
      };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'fetch') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.fetch.result',
        title: res.title ?? '',
        content: res.content,
        usage: res.usage,
      };
    },
  };
}

function ocrHandler(deps: DeepSeekToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'ocr',
    path: OCR_PATH,
    provider: 'deepseek',
    access_path: 'deepseek.tools.ocr',
    // 计费判据去 chat 那条 path 上问（凭据登记在那里；同一把 key、同一个账号）
    billing_access_path: 'deepseek.openai-chat',
    decodeRequest(body) {
      const rec = asRecord(body);
      const purpose = optStr(rec, 'purpose') ?? 'text_recognition';
      if (purpose !== 'text_recognition' && purpose !== 'rich_layout_recognition') {
        throw new ToolRequestError('字段 purpose 应为 text_recognition 或 rich_layout_recognition');
      }
      return { endpoint: 'ocr', file: reqFile(rec, 'file'), purpose, raw: {} };
    },
    async run(req) {
      if (req.endpoint !== 'ocr') throw new ToolRequestError('端点不匹配');
      const outcome = await deps.ocr.recognize({
        file: decodeBase64(req.file.data_base64),
        filename: req.file.filename,
        purpose: req.purpose ?? 'text_recognition',
      });
      return {
        endpoint: 'ocr',
        page_count: outcome.response.page_count,
        pages: outcome.response.pages.map((p) => ({
          index: p.index,
          text: p.text,
          finish_reason: p.finish_reason,
        })),
        usage: outcome.usage,
        raw: {},
      };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'ocr') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.ocr.result',
        page_count: res.page_count,
        pages: res.pages,
        usage: res.usage,
      };
    },
  };
}

function asrHandler(deps: DeepSeekToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'asr',
    path: ASR_PATH,
    provider: 'deepseek',
    access_path: 'deepseek.tools.asr',
    // 计费判据去 chat 那条 path 上问（凭据登记在那里；同一把 key、同一个账号）
    billing_access_path: 'deepseek.openai-chat',
    decodeRequest(body) {
      const rec = asRecord(body);
      const req: CanonicalToolRequest = {
        endpoint: 'asr',
        audio: reqFile(rec, 'audio'),
        raw: {},
      };
      const language = optStr(rec, 'language');
      if (language !== undefined) req.language = language;
      const prompt = optStr(rec, 'prompt');
      if (prompt !== undefined) req.prompt = prompt;
      return req;
    },
    async run(req) {
      if (req.endpoint !== 'asr') throw new ToolRequestError('端点不匹配');
      const outcome = await deps.asr.transcribe({
        file: decodeBase64(req.audio.data_base64),
        filename: req.audio.filename,
      });
      return {
        endpoint: 'asr',
        text: outcome.text,
        duration_seconds: outcome.duration_ms / 1000,
        usage: outcome.usage,
        raw: {},
      };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'asr') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.asr.result',
        text: res.text,
        ...(res.duration_seconds === undefined ? {} : { duration_seconds: res.duration_seconds }),
        usage: res.usage,
      };
    },
  };
}

function ttsHandler(deps: DeepSeekToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'tts',
    path: TTS_PATH,
    provider: 'deepseek',
    access_path: 'deepseek.tools.tts',
    // 计费判据去 chat 那条 path 上问（凭据登记在那里；同一把 key、同一个账号）
    billing_access_path: 'deepseek.openai-chat',
    decodeRequest(body) {
      const rec = asRecord(body);
      const format = optStr(rec, 'format') ?? 'wav';
      if (format !== 'wav' && format !== 'pcm') {
        throw new ToolRequestError('字段 format 应为 wav 或 pcm');
      }
      const req: CanonicalToolRequest = {
        endpoint: 'tts',
        input: reqStr(rec, 'input', 10_000),
        voice_id: optStr(rec, 'voice_id') ?? 'stella',
        format,
        raw: {},
      };
      const filter = optBool(rec, 'filter_markdown');
      if (filter !== undefined) req.filter_markdown = filter;
      return req;
    },
    async run(req) {
      if (req.endpoint !== 'tts') throw new ToolRequestError('端点不匹配');
      // DeepSeek 只产 wav/pcm：canonical 的 format 联合 2026-11 加了 mp3（MiMo 用），
      // 这里显式拒掉而不是静默按 wav 发——上游会为一个它不认的格式报错，
      // 而网关先拒能给一句"这家上游不支持 mp3"的人话。
      if (req.format === 'mp3') {
        throw new ToolRequestError('DeepSeek TTS 只输出 wav / pcm，不支持 mp3');
      }
      const outcome = await deps.tts.synthesize({
        text: req.input,
        voice_id: req.voice_id as 'stella' | 'tide',
        format: req.format,
        ...(req.filter_markdown === undefined ? {} : { filter_markdown: req.filter_markdown }),
      });
      return {
        endpoint: 'tts',
        audio_base64: outcome.audio.toString('base64'),
        content_type: outcome.contentType,
        usage: outcome.usage,
        raw: {},
      };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'tts') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.tts.result',
        audio_base64: res.audio_base64,
        content_type: res.content_type,
        usage: res.usage,
      };
    },
  };
}

/** 导出给测试用（断言"五个端点一条不少"）。 */
export const DEEPSEEK_TOOL_ENDPOINT_PATHS = {
  search: SEARCH_PATH,
  fetch: FETCH_PATH,
  ocr: OCR_PATH,
  asr: ASR_PATH,
  tts: TTS_PATH,
} as const;
