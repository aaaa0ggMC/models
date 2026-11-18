/**
 * providers/deepseek/endpoints.test.ts —— DeepSeek 五个独立工具端点的 round-trip 契约测试。
 *
 * 覆盖对象：search / fetch / ocr / asr / tts 五个 standalone wire codec + 薄客户端
 * （**不是** chat pipeline 的 adaptor，故没有 Adaptor 六条断言那套东西，见各文件头）。
 *
 * 测试分四组，对应四类必须兜住的风险：
 *   1. **codec round-trip**：夹具（providers/deepseek/fixtures/，全是假数据：
 *      example.com URL、假 id、无真实凭据）→ decode → 逐字段断言；请求侧则
 *      encode → JSON → 再 encode 幂等。OCR/ASR 额外把 multipart 请求体**解析回字段**
 *      （手写编码器最容易错的就是 CRLF / 边界 / 二进制安全）。
 *   2. **不猜也不丢**：字段类型错、缺字段、results 为 null、整个 body 不是 object——
 *      一律不抛，落文档化的默认值，未知顶层键整包进 `raw`。
 *   3. **客户端**：用 gateway-core/transport.ts 的 `ScriptedTransport`（DI 注入的假上游，
 *      不打真实网络）跑 2xx 与**非 2xx** 两条路径；非 2xx 必须抛
 *      `DeepSeekApiError` 且带上状态码 + 解析后的错误体（不吞）。
 *   4. **计费口径**：`billedCharCount`（中文字符 2、其他 1，按码点迭代）与各端点的
 *      canonical usage 形状（按次 / 按页 / 按音频秒 / 按字符）。
 *
 * 隐私：夹具与常量里的 key 一律是 `fake-test-key` 这种显式假值，无 sk- 形态、
 * 无真实域名（只有 example.com）、无内网地址。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_SEARCH_PATH,
  DeepSeekApiError,
  DeepSeekSearchClient,
  decodeSearchResponse,
  encodeSearchRequest,
  toSearchHits,
  toSearchResultParts,
} from './search.js';
import type { DeepSeekSearchClientDeps, DeepSeekSearchRequest } from './search.js';
import {
  DEEPSEEK_FETCH_PATH,
  DeepSeekFetchClient,
  decodeFetchResponse,
  encodeFetchRequest,
} from './fetch.js';
import type { DeepSeekFetchRequest } from './fetch.js';
import {
  DEEPSEEK_MULTIPART_BOUNDARY,
  DEEPSEEK_OCR_PATH,
  DeepSeekOcrClient,
  buildOcrUsage,
  decodeOcrResponse,
  encodeOcrRequest,
  sanitizeMultipartFilename,
} from './ocr.js';
import type { DeepSeekOcrRequest } from './ocr.js';
import {
  DEEPSEEK_ASR_PATH,
  DeepSeekAsrClient,
  buildAsrUsage,
  decodeAsrResponse,
  encodeAsrRequest,
} from './asr.js';
import type { DeepSeekAsrRequest } from './asr.js';
import {
  DEEPSEEK_TTS_PATH,
  DeepSeekTtsClient,
  billedCharCount,
  buildTtsUsage,
  decodeTtsResponse,
  encodeTtsRequest,
  ttsMimeType,
} from './tts.js';
import type { DeepSeekTtsRequest } from './tts.js';
import { ScriptedTransport } from '../../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../../gateway-core/transport.js';
import type { CanonicalUsage } from '../../ir/index.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, 'fixtures');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as unknown;
}

/** 显式假的鉴权头（无 sk- 形态、不是任何真实 key）。 */
const FAKE_AUTH_HEADERS: Record<string, string> = { authorization: 'Bearer fake-test-key' };

/** 五个客户端共用的 headersProvider 形态（每次调用重新取，便于 key 轮换）。 */
function fakeHeadersProvider(): Promise<Record<string, string>> {
  return Promise.resolve({ ...FAKE_AUTH_HEADERS });
}

/** 把抛出的错误窄化成 DeepSeekApiError（测试辅助）。 */
async function captureApiError(fn: () => Promise<unknown>): Promise<DeepSeekApiError> {
  try {
    await fn();
  } catch (err) {
    return err as DeepSeekApiError;
  }
  throw new Error('expected the call to throw');
}

/** 断言一次 usage 的形状（按次计费的两个端点共用）。 */
function expectPerRequestUsage(usage: CanonicalUsage): void {
  expect(usage.units).toEqual({ requests: 1 });
  expect(usage.source).toBe('provider');
}

// ---------------------------------------------------------------------------
// multipart 解析辅助（把请求体解析回字段，验证手写编码器）
// ---------------------------------------------------------------------------

interface ParsedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/**
 * 解析手写 multipart 请求体。按 Buffer 切分而不是先转字符串——文件字段是二进制，
 * 走 utf8 会被替换字符破坏（0xB0 这类单字节在 utf8 里非法）。
 */
function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
  const marker = Buffer.from(`--${boundary}`, 'utf8');
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const idx = body.indexOf(marker, cursor);
    if (idx === -1) break;
    chunks.push(body.subarray(cursor, idx));
    cursor = idx + marker.length;
  }
  chunks.push(body.subarray(cursor)); // 收尾：epilogue（"--\r\n"）

  const parts: ParsedPart[] = [];
  // chunks[0] 是 preamble（空），最后一个是 epilogue，中间每个都是一段 part
  for (const chunk of chunks.slice(1, -1)) {
    const headerEnd = chunk.indexOf(Buffer.from('\r\n\r\n', 'utf8'));
    if (headerEnd === -1) continue;
    const headerText = chunk.subarray(0, headerEnd).toString('utf8');
    let data = chunk.subarray(headerEnd + 4);
    // 去掉下一段分隔符前的 CRLF
    if (data.subarray(-2).toString('utf8') === '\r\n') {
      data = data.subarray(0, data.length - 2);
    }
    const disposition = /name="([^"]*)"/.exec(headerText);
    const filename = /filename="([^"]*)"/.exec(headerText);
    const contentType = /content-type:[ ]*([^\r\n]+)/i.exec(headerText);
    parts.push({
      name: disposition?.[1] ?? '',
      ...(filename === null ? {} : { filename: filename[1] }),
      ...(contentType === null ? {} : { contentType: contentType[1] }),
      data,
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('deepseek.search codec', () => {
  it('encode：全字段请求逐键相等，undefined 被丢掉', () => {
    const wire = readJson('search.request.json');
    expect(encodeSearchRequest(wire as DeepSeekSearchRequest)).toEqual({
      query: 'site:example.com agentgateway canonical 格式',
      count: 5,
      ori_question: '网关怎么把各家 provider 的格式统一起来？',
      // RFC 5737 文档段（TEST-NET-3）假 IP：localization 字段语义就是 IP 地址
      localization: '203.0.113.7', // privacy-scan: ignore
      need_content: true,
    });
  });

  it('encode：ori_question 显式 null 与省略等价（文档：null = 不提供）', () => {
    const withNull = encodeSearchRequest({ query: 'q', ori_question: null });
    const without = encodeSearchRequest({ query: 'q' });
    expect(withNull).toEqual({ query: 'q' });
    expect(without).toEqual(withNull);
    expect('ori_question' in withNull).toBe(false);
  });

  it('encode：只发已建模字段，且 encode → JSON → encode 幂等', () => {
    const req: DeepSeekSearchRequest = {
      query: 'agentgateway',
      count: 20,
      need_content: false,
      // 未建模字段不应出现在请求体里
      ...({ future_field: 'ignored' } as Partial<DeepSeekSearchRequest>),
    };
    const first = encodeSearchRequest(req);
    expect(Object.keys(first).sort()).toEqual(['count', 'need_content', 'query']);
    const roundTripped = encodeSearchRequest(
      JSON.parse(JSON.stringify(first)) as DeepSeekSearchRequest,
    );
    expect(roundTripped).toEqual(first);
  });

  it('decode：完整响应逐字段收口，未知顶层键活着进 raw', () => {
    const wire = readJson('search.response.json');
    const res = decodeSearchResponse(wire);
    expect(res.results).toHaveLength(2);

    const first = res.results[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error('expected first result');
    expect(first.rerank_score).toBe(2.87);
    expect(first.title).toBe('AgentGateway 架构总览（示例文档）');
    expect(first.url).toBe('https://example.com/docs/agentgateway/overview');
    expect(first.content.startsWith('# AgentGateway')).toBe(true);
    expect(first.site_name).toBe('Example Docs');
    expect(first.site_icon).toBe('https://example.com/favicon.ico');
    expect(first.date).toBe('2026-10-01T08:30:00Z');
    expect(first.authority).toBe(4);

    // 第二条：need_content=false 形态（content 空串、site_*/date 为 null、authority 未知）
    const second = res.results[1];
    expect(second).toBeDefined();
    if (second === undefined) throw new Error('expected second result');
    expect(second.content).toBe('');
    expect(second.site_name).toBeNull();
    expect(second.site_icon).toBeNull();
    expect(second.date).toBeNull();
    expect(second.authority).toBe(-1);

    // 10 §7 的 raw passthrough：未知顶层键不丢
    expect(res.raw['future_top_level_field']).toEqual({
      kept_for_raw: true,
      note: '未知顶层键必须活着进 raw',
    });
  });

  it('decode：空结果 → results: []（无匹配不是错误）', () => {
    expect(decodeSearchResponse(readJson('search.response.empty.json')).results).toEqual([]);
  });

  it('decode：results 为 null / 非 object body → 空结果，不抛', () => {
    expect(decodeSearchResponse(readJson('search.response.null-results.json')).results).toEqual([]);
    for (const odd of [null, undefined, 'a string', 42, [], true]) {
      const res = decodeSearchResponse(odd);
      expect(res.results).toEqual([]);
      expect(res.raw).toEqual({});
    }
  });

  it('decode：字段类型错/缺字段 → 文档化的默认值，不抛', () => {
    const res = decodeSearchResponse(readJson('search.response.odd.json'));
    expect(res.results).toHaveLength(3);

    // 非 object 条目：全部落默认值
    const bogus = res.results[0];
    expect(bogus).toBeDefined();
    if (bogus === undefined) throw new Error('expected bogus entry');
    expect(bogus).toEqual({
      rerank_score: 0,
      title: '',
      url: '',
      snippet: '',
      summary: '',
      content: '',
      site_name: null,
      site_icon: null,
      date: null,
      authority: -1,
    });

    // 类型错：字符串 rerank_score / 数字 title / 数字 site_name / 数字 date / null authority
    const mistyped = res.results[1];
    expect(mistyped).toBeDefined();
    if (mistyped === undefined) throw new Error('expected mistyped entry');
    expect(mistyped.rerank_score).toBe(0);
    expect(mistyped.title).toBe('');
    expect(mistyped.url).toBe('https://example.com/odd');
    expect(mistyped.site_name).toBeNull();
    expect(mistyped.date).toBeNull();
    expect(mistyped.authority).toBe(-1); // 绝不默认成 0（0 是真实档位）

    // 缺 index 之外的少量字段：snippet 有值、其余默认
    const sparse = res.results[2];
    expect(sparse).toBeDefined();
    if (sparse === undefined) throw new Error('expected sparse entry');
    expect(sparse.rerank_score).toBe(0.5);
    expect(sparse.summary).toBe('');
    expect(sparse.authority).toBe(-1);

    expect(res.raw['extra']).toBe('results 之外的顶层键');
  });

  it('toSearchHits：rerank_score→score、date→published_at，content 空串时省略', () => {
    const hits = toSearchHits(decodeSearchResponse(readJson('search.response.json')));
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: 'AgentGateway 架构总览（示例文档）',
      url: 'https://example.com/docs/agentgateway/overview',
      snippet: hits[0]?.snippet,
      summary: hits[0]?.summary,
      score: 2.87,
      authority: 4,
      site_name: 'Example Docs',
      published_at: '2026-10-01T08:30:00Z',
      content: hits[0]?.content,
    });
    // content 空串（没取正文）→ 键省略，而不是塞空串
    expect(hits[1]).toBeDefined();
    if (hits[1] === undefined) throw new Error('expected second hit');
    expect('content' in hits[1]).toBe(false);
    expect(hits[1]?.site_name).toBeNull();
  });

  it('toSearchResultParts：citation_index 由调用方起编号，source 不拿 url host 猜', () => {
    const parts = toSearchResultParts(decodeSearchResponse(readJson('search.response.json')), 7);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.type).toBe('search_result');
    expect(parts[0]?.citation_index).toBe(7);
    expect(parts[1]?.citation_index).toBe(8);
    expect(parts[0]?.source).toBe('Example Docs');
    expect(parts[0]?.published_at).toBe('2026-10-01T08:30:00Z');
    expect(parts[0]?.content).toBeDefined();
    // site_name 为 null → source 空串，不用 url 的 host 顶替
    expect(parts[1]?.source).toBe('');
    expect(parts[1]?.score).toBe(1.42);
    // date 为 null（发布时间未知）→ published_at 键省略：canonical 没有 null 槽，
    // 塞 null 会让下游按"有值"处理（见 toSearchResultParts 注释）
    expect('published_at' in (parts[1] ?? {})).toBe(false);
    expect('content' in (parts[1] ?? {})).toBe(false);
  });
});

describe('deepseek.search client', () => {
  const deps = (transport: ScriptedTransport): DeepSeekSearchClientDeps => ({
    transport,
    headersProvider: fakeHeadersProvider,
  });

  it('2xx：结果与 decode 一致，usage 是按次口径，请求形状正确', async () => {
    const script: ScriptedTransportScript = [
      { status: 200, body: JSON.stringify(readJson('search.response.json')) },
    ];
    const transport = new ScriptedTransport(script);
    const client = new DeepSeekSearchClient(deps(transport));

    const outcome = await client.search({ query: 'agentgateway', count: 5, need_content: true });

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.results).toEqual(decodeSearchResponse(readJson('search.response.json')).results);
    expectPerRequestUsage(outcome.usage);

    // 请求侧：方法/路径/base URL/头/体
    const sent = transport.requests[0];
    expect(sent).toBeDefined();
    if (sent === undefined) throw new Error('expected one upstream request');
    expect(sent.method).toBe('POST');
    expect(sent.base_url).toBe(DEEPSEEK_DEFAULT_BASE_URL);
    expect(sent.path).toBe(DEEPSEEK_SEARCH_PATH);
    expect(sent.stream).toBe(false);
    expect(sent.headers['authorization']).toBe('Bearer fake-test-key');
    expect(sent.headers['content-type']).toBe('application/json');
    const body = JSON.parse((sent.body ?? Buffer.alloc(0)).toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ query: 'agentgateway', count: 5, need_content: true });
  });

  it('2xx：空结果也记 1 次请求（是否计费由调用方结合 results.length 判断）', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(readJson('search.response.empty.json')) },
    ]);
    const outcome = await new DeepSeekSearchClient(deps(transport)).search({ query: 'no-match' });
    expect(outcome.results).toEqual([]);
    expectPerRequestUsage(outcome.usage);
  });

  it('非 2xx：429 带解析后的错误体上抛，不吞状态码', async () => {
    const errorBody = {
      error: {
        message: 'Rate limit reached for search (100 QPS)',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
    };
    const transport = new ScriptedTransport([{ status: 429, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() =>
      new DeepSeekSearchClient(deps(transport)).search({ query: 'agentgateway' }),
    );
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.name).toBe('DeepSeekApiError');
    expect(err.status).toBe(429);
    expect(err.body).toEqual(errorBody);
    expect(err.message).toContain('429');
  });

  it('非 2xx：错误体不是 JSON 时保留原文文本', async () => {
    const transport = new ScriptedTransport([{ status: 502, body: '<html>bad gateway</html>' }]);
    const err = await captureApiError(() =>
      new DeepSeekSearchClient(deps(transport)).search({ query: 'agentgateway' }),
    );
    expect(err.status).toBe(502);
    expect(err.body).toBe('<html>bad gateway</html>');
  });

  it('baseUrl / path 可被覆盖（代理与内网镜像场景）', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(readJson('search.response.empty.json')) },
    ]);
    const client = new DeepSeekSearchClient({
      transport,
      headersProvider: fakeHeadersProvider,
      baseUrl: 'http://127.0.0.1:9',
      path: '/mirror/v1/tools/search',
    });
    await client.search({ query: 'agentgateway' });
    const sent = transport.requests[0];
    expect(sent?.base_url).toBe('http://127.0.0.1:9');
    expect(sent?.path).toBe('/mirror/v1/tools/search');
  });
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

describe('deepseek.fetch codec', () => {
  it('encode：只有一个 url 字段', () => {
    const req = readJson('fetch.request.json') as DeepSeekFetchRequest;
    expect(encodeFetchRequest(req)).toEqual({
      url: 'https://example.com/docs/agentgateway/overview',
    });
  });

  it('decode：title/content 收口，未知顶层键进 raw', () => {
    const res = decodeFetchResponse(readJson('fetch.response.json'));
    expect(res.title).toBe('AgentGateway 架构总览（示例文档）');
    expect(res.content).toContain('AG-IR 是唯一事实来源。');
    expect(res.raw['future_top_level_field']).toBe('未知顶层键必须活着进 raw');
  });

  it('decode：非 object / 缺字段 → 空串，不抛', () => {
    for (const odd of [null, undefined, 'text', 42, []]) {
      const res = decodeFetchResponse(odd);
      expect(res.title).toBe('');
      expect(res.content).toBe('');
      expect(res.raw).toEqual({});
    }
    const partial = decodeFetchResponse({ title: '只有标题' });
    expect(partial.title).toBe('只有标题');
    expect(partial.content).toBe('');
  });
});

describe('deepseek.fetch client', () => {
  it('2xx：title/content + 按次 usage；403/404 由调用方分流', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(readJson('fetch.response.json')) },
    ]);
    const client = new DeepSeekFetchClient({
      transport,
      headersProvider: fakeHeadersProvider,
    });
    const outcome = await client.fetch({ url: 'https://example.com/docs/agentgateway/overview' });
    expect(outcome.title).toBe('AgentGateway 架构总览（示例文档）');
    expect(outcome.content.length).toBeGreaterThan(0);
    expectPerRequestUsage(outcome.usage);
    expect(outcome.httpStatus).toBe(200);
    expect(transport.requests[0]?.path).toBe(DEEPSEEK_FETCH_PATH);
    expect(transport.requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('非 2xx：404（无可取内容）带错误体上抛', async () => {
    const errorBody = {
      error: {
        message: 'No usable content',
        type: 'invalid_request_error',
        param: null,
        code: 'no_content',
      },
    };
    const transport = new ScriptedTransport([{ status: 404, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() =>
      new DeepSeekFetchClient({ transport, headersProvider: fakeHeadersProvider }).fetch({
        url: 'https://example.com/missing',
      }),
    );
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(404);
    expect(err.body).toEqual(errorBody);
  });
});

// ---------------------------------------------------------------------------
// ocr
// ---------------------------------------------------------------------------

describe('deepseek.ocr multipart 编码', () => {
  const fileBytes = Buffer.from(
    (readJson('ocr.request.json') as { file_base64: string }).file_base64,
    'base64',
  );
  const req: DeepSeekOcrRequest = {
    file: fileBytes,
    filename: 'fixture-overview.pdf',
    purpose: 'rich_layout_recognition',
  };

  it('请求体可被解析回字段：file 二进制逐字节往返 + purpose 文本字段', () => {
    const encoded = encodeOcrRequest(req);
    expect(encoded.headers['content-type']).toBe(
      `multipart/form-data; boundary=${DEEPSEEK_MULTIPART_BOUNDARY}`,
    );

    const parts = parseMultipart(encoded.body, DEEPSEEK_MULTIPART_BOUNDARY);
    // 只有两个字段（文档：任何其他字段 → 400）
    expect(parts).toHaveLength(2);

    const filePart = parts[0];
    expect(filePart).toBeDefined();
    if (filePart === undefined) throw new Error('expected file part');
    expect(filePart.name).toBe('file');
    expect(filePart.filename).toBe('fixture-overview.pdf');
    // 格式由服务端按内容探测，不猜 mime
    expect(filePart.contentType).toBe('application/octet-stream');
    expect(filePart.data.equals(fileBytes)).toBe(true);

    const purposePart = parts[1];
    expect(purposePart).toBeDefined();
    if (purposePart === undefined) throw new Error('expected purpose part');
    expect(purposePart.name).toBe('purpose');
    expect(purposePart.data.toString('utf8')).toBe('rich_layout_recognition');

    // 终止分隔符与 CRLF 收尾
    const tail = encoded.body.subarray(-64).toString('utf8');
    expect(tail).toContain(`--${DEEPSEEK_MULTIPART_BOUNDARY}--\r\n`);
    expect(encoded.body.toString('utf8').endsWith(`--${DEEPSEEK_MULTIPART_BOUNDARY}--\r\n`)).toBe(
      true,
    );
  });

  it('同样的输入 → 同样的字节（固定边界，无随机）', () => {
    expect(encodeOcrRequest(req).body.equals(encodeOcrRequest(req).body)).toBe(true);
  });

  it('Uint8Array 与 Buffer 输入等价', () => {
    const asUint8 = new Uint8Array(fileBytes);
    expect(
      encodeOcrRequest({ ...req, file: asUint8 }).body.equals(encodeOcrRequest(req).body),
    ).toBe(true);
  });

  it('文件名净化：引号/反斜杠/控制字符/非 ASCII 不能注入头', () => {
    expect(sanitizeMultipartFilename('ok.pdf')).toBe('ok.pdf');
    // 引号/反斜杠删掉，CR/LF 换成下划线（直接删会把两边 token 粘起来）
    expect(sanitizeMultipartFilename('a"b\\c\r\nd.pdf')).toBe('abc__d.pdf');
    expect(sanitizeMultipartFilename('文档.pdf')).toBe('__.pdf');
    expect(sanitizeMultipartFilename('')).toBe('upload.bin');
    expect(sanitizeMultipartFilename('   ')).toBe('   '); // 空格是合法文件名字符
  });
});

describe('deepseek.ocr codec', () => {
  it('decode：完整响应逐字段收口（含版面 token 原文）', () => {
    const res = decodeOcrResponse(readJson('ocr.response.json'));
    expect(res.id).toBe('ocr-fixture-0001');
    expect(res.object).toBe('ocr.result');
    expect(res.created).toBe(1763000400);
    expect(res.purpose).toBe('rich_layout_recognition');
    expect(res.page_count).toBe(2);
    expect(res.pages).toHaveLength(2);
    expect(res.pages[0]?.index).toBe(0);
    expect(res.pages[0]?.text).toContain('<|ref|>AgentGateway 架构总览<|/ref|>');
    expect(res.pages[0]?.text).toContain('<|box|>[[52, 40, 948, 96]]<|/box|>');
    expect(res.pages[0]?.finish_reason).toBe('stop');
    expect(res.pages[1]?.finish_reason).toBe('length');
    expect(res.usage).toEqual({ input_tokens: 1234, output_tokens: 567, total_tokens: 1801 });
    expect(res.raw['future_top_level_field']).toBe('未知顶层键必须活着进 raw');
  });

  it('decode：最小响应用 pages.length 兜底 page_count，缺 usage 时省略该键', () => {
    const res = decodeOcrResponse(readJson('ocr.response.minimal.json'));
    expect(res.id).toBe('');
    expect(res.object).toBe('');
    expect(res.created).toBe(0);
    expect(res.purpose).toBe('');
    expect(res.page_count).toBe(1); // pages.length 兜底（同一事实的另一种表达）
    expect(res.pages[0]?.index).toBe(0); // 缺 index → 数组下标
    expect(res.pages[0]?.finish_reason).toBe('stop');
    expect('usage' in res).toBe(false); // 绝不用 0 冒充"已计量"
    expect(res.raw).toEqual({ pages: [{ text: expect.any(String), finish_reason: 'stop' }] });
  });

  it('decode：非 object body → 空 pages 且 raw 为 {}，不抛', () => {
    for (const odd of [null, undefined, 'text', 42, []]) {
      const res = decodeOcrResponse(odd);
      expect(Array.isArray(res.pages)).toBe(true);
      expect(res.pages).toEqual([]);
      expect(res.page_count).toBe(0);
      expect(res.raw).toEqual({});
    }
  });

  it('decode：object 但 pages 畸形 → 空 pages，raw 仍是原文（不丢）', () => {
    for (const odd of [{ pages: 'nope' }, { pages: null }, { pages: {} }]) {
      const res = decodeOcrResponse(odd);
      expect(res.pages).toEqual([]);
      expect(res.page_count).toBe(0);
      expect(res.raw).toEqual(odd);
    }
    // pages 是数组但条目不是 object：逐条落默认值，不进 raw.nodes
    const res = decodeOcrResponse({ pages: [1, 'x'] });
    expect(res.pages).toHaveLength(2);
    expect(res.page_count).toBe(2);
    expect(res.pages[0]).toEqual({ index: 0, text: '', finish_reason: '' });
    expect(res.pages[1]).toEqual({ index: 1, text: '', finish_reason: '' });
  });

  it('buildOcrUsage：按页计费 → requests = page_count，token 只进 raw', () => {
    const res = decodeOcrResponse(readJson('ocr.response.json'));
    expect(buildOcrUsage(res)).toEqual({
      units: { requests: 2 },
      raw: { input_tokens: 1234, output_tokens: 567, total_tokens: 1801, page_count: 2 },
      source: 'provider',
    });
    // 上游没给 usage 时 raw 也没有（不造 0）
    const minimal = decodeOcrResponse(readJson('ocr.response.minimal.json'));
    expect(buildOcrUsage(minimal)).toEqual({ units: { requests: 1 }, source: 'provider' });
  });
});

describe('deepseek.ocr client', () => {
  const fileBytes = Buffer.from(
    (readJson('ocr.request.json') as { file_base64: string }).file_base64,
    'base64',
  );
  const req: DeepSeekOcrRequest = {
    file: fileBytes,
    filename: 'fixture-overview.pdf',
    purpose: 'rich_layout_recognition',
  };

  it('2xx：multipart 请求头（不是 application/json）+ 解码后的响应', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(readJson('ocr.response.json')) },
    ]);
    const client = new DeepSeekOcrClient({ transport, headersProvider: fakeHeadersProvider });
    const outcome = await client.recognize(req);

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.response).toEqual(decodeOcrResponse(readJson('ocr.response.json')));
    expect(outcome.usage.units).toEqual({ requests: 2 });

    const sent = transport.requests[0];
    expect(sent?.path).toBe(DEEPSEEK_OCR_PATH);
    expect(sent?.headers['content-type']).toBe(
      `multipart/form-data; boundary=${DEEPSEEK_MULTIPART_BOUNDARY}`,
    );
    expect(sent?.headers['authorization']).toBe('Bearer fake-test-key');
    // 请求体就是 encodeOcrRequest 的产物（逐字节）
    expect((sent?.body ?? Buffer.alloc(0)).equals(encodeOcrRequest(req).body)).toBe(true);
  });

  it('非 2xx：413（超 100 MiB）带错误体上抛', async () => {
    const errorBody = {
      error: {
        message: 'File too large',
        type: 'invalid_request_error',
        param: null,
        code: 'file_too_large',
      },
    };
    const transport = new ScriptedTransport([{ status: 413, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() =>
      new DeepSeekOcrClient({ transport, headersProvider: fakeHeadersProvider }).recognize(req),
    );
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(413);
    expect(err.body).toEqual(errorBody);
  });
});

// ---------------------------------------------------------------------------
// asr
// ---------------------------------------------------------------------------

describe('deepseek.asr codec', () => {
  const fileBytes = Buffer.from(
    (readJson('asr.request.json') as { file_base64: string }).file_base64,
    'base64',
  );
  const req: DeepSeekAsrRequest = { file: fileBytes, filename: 'fixture-greeting.wav' };

  it('multipart：只有一个 file 字段（多传字段有被拒风险）', () => {
    const encoded = encodeAsrRequest(req);
    const parts = parseMultipart(encoded.body, DEEPSEEK_MULTIPART_BOUNDARY);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.name).toBe('file');
    expect(parts[0]?.filename).toBe('fixture-greeting.wav');
    // 二进制（含 0x00 与非 ASCII 字节）逐字节往返
    expect(parts[0]?.data.equals(fileBytes)).toBe(true);
    expect(encoded.headers['content-type']).toContain('multipart/form-data; boundary=');
  });

  it('decode：request_id/text/duration_ms 收口，未知键进 raw', () => {
    const res = decodeAsrResponse(readJson('asr.response.json'));
    expect(res.request_id).toBe('asr-fixture-req-0001');
    expect(res.text).toContain('示例转写文本');
    expect(res.duration_ms).toBe(7530);
    expect(res.raw['future_top_level_field']).toBe('未知顶层键必须活着进 raw');
  });

  it('decode：非 object / 缺字段 → 空串与 0，不抛', () => {
    for (const odd of [null, undefined, 'text', 42, []]) {
      expect(decodeAsrResponse(odd)).toEqual({ request_id: '', text: '', duration_ms: 0, raw: {} });
    }
    expect(decodeAsrResponse({ text: '只有文本' }).duration_ms).toBe(0);
  });

  it('buildAsrUsage：按音频秒计费，input 与 billed 同值', () => {
    const res = decodeAsrResponse(readJson('asr.response.json'));
    expect(buildAsrUsage(res)).toEqual({
      units: { audio_seconds: { input: 7.53, billed: 7.53 } },
      raw: { duration_ms: 7530 },
      source: 'provider',
    });
  });
});

describe('deepseek.asr client', () => {
  const fileBytes = Buffer.from(
    (readJson('asr.request.json') as { file_base64: string }).file_base64,
    'base64',
  );

  it('2xx：转写文本 + audio_seconds usage', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(readJson('asr.response.json')) },
    ]);
    const client = new DeepSeekAsrClient({ transport, headersProvider: fakeHeadersProvider });
    const outcome = await client.transcribe({ file: fileBytes, filename: 'fixture-greeting.wav' });

    expect(outcome.text).toContain('示例转写文本');
    expect(outcome.duration_ms).toBe(7530);
    expect(outcome.request_id).toBe('asr-fixture-req-0001');
    expect(outcome.usage.units).toEqual({ audio_seconds: { input: 7.53, billed: 7.53 } });
    expect(transport.requests[0]?.path).toBe(DEEPSEEK_ASR_PATH);
    expect(transport.requests[0]?.stream).toBe(false); // 无流式：整文件一次上传
  });

  it('非 2xx：429（>50 并发）带错误体上抛', async () => {
    const errorBody = {
      error: {
        message: 'Too many concurrent requests',
        type: 'rate_limit_error',
        param: null,
        code: 'concurrency_limit',
      },
    };
    const transport = new ScriptedTransport([{ status: 429, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() =>
      new DeepSeekAsrClient({ transport, headersProvider: fakeHeadersProvider }).transcribe({
        file: fileBytes,
        filename: 'fixture-greeting.wav',
      }),
    );
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(429);
    expect(err.body).toEqual(errorBody);
  });
});

// ---------------------------------------------------------------------------
// tts
// ---------------------------------------------------------------------------

describe('deepseek.tts billedCharCount', () => {
  it('中文字符记 2，其他字符记 1', () => {
    expect(billedCharCount('')).toBe(0);
    expect(billedCharCount('hello')).toBe(5);
    expect(billedCharCount('你好')).toBe(4);
    expect(billedCharCount('hi你好')).toBe(6);
    expect(billedCharCount('。、〈〉')).toBe(8); // CJK 标点也占一个汉字宽度
    expect(billedCharCount('Ａ１')).toBe(4); // 全角形式
  });

  it('按码点迭代：代理对（扩展区汉字 / emoji）不算成两个字符', () => {
    expect(billedCharCount('\u{20000}')).toBe(2); // CJK 扩展 B
    expect(billedCharCount('🎉')).toBe(1); // emoji 按 1
    expect(billedCharCount('a🎉b')).toBe(3);
  });

  it('日文假名 / 韩文按 1（文档只说"中文字符"记 2）', () => {
    expect(billedCharCount('こんにちは')).toBe(5);
    expect(billedCharCount('안녕하세요')).toBe(5); // 5 个谚文字节
  });

  it('区间表可审计：列出的每个区间端点都记 2', () => {
    // 改计费口径只需改 CJK_BILLED_RANGES；这里锁住当前口径
    expect(billedCharCount(String.fromCodePoint(0x3400))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x4dbf))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x4e00))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x9fff))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0xf900))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x2a6df))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x2fa1f))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x3000))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0x303f))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0xff01))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0xff60))).toBe(2);
    expect(billedCharCount(String.fromCodePoint(0xffe6))).toBe(2);
    // 区间外
    expect(billedCharCount(String.fromCodePoint(0x33ff))).toBe(1);
    expect(billedCharCount(String.fromCodePoint(0x3040))).toBe(1); // 假名边界外
  });
});

describe('deepseek.tts codec', () => {
  it('encode：默认值在客户端填（自解释 + 上游改默认值不影响已发请求）', () => {
    expect(encodeTtsRequest({ text: 'hi' })).toEqual({
      text: 'hi',
      voice_id: 'stella',
      format: 'wav',
      filter_markdown: true,
    });
    expect(
      encodeTtsRequest({ text: 'hi', voice_id: 'tide', format: 'pcm', filter_markdown: false }),
    ).toEqual({ text: 'hi', voice_id: 'tide', format: 'pcm', filter_markdown: false });
    // 部分覆盖：未给的仍落默认
    expect(encodeTtsRequest({ text: 'hi', format: 'pcm' })).toEqual({
      text: 'hi',
      voice_id: 'stella',
      format: 'pcm',
      filter_markdown: true,
    });
  });

  it('encode：与夹具 round-trip 幂等', () => {
    const req = readJson('tts.request.json') as DeepSeekTtsRequest;
    const first = encodeTtsRequest(req);
    expect(first).toEqual(req);
    const again = encodeTtsRequest(JSON.parse(JSON.stringify(first)) as DeepSeekTtsRequest);
    expect(again).toEqual(first);
  });

  it('decode：音频字节 + content-type + 按字符 usage', () => {
    const fixture = readJson('tts.response.audio.json') as {
      content_type: string;
      audio_base64: string;
    };
    const audio = Buffer.from(fixture.audio_base64, 'base64');
    const decoded = decodeTtsResponse(
      { status: 200, headers: { 'content-type': fixture.content_type }, body: audio },
      { text: '你好世界' },
    );
    expect(decoded.audio.equals(audio)).toBe(true);
    expect(decoded.contentType).toBe('audio/wav');
    expect(decoded.usage).toEqual({
      units: { characters: { input: 8, billed: 8 } },
      raw: { characters: 4, billed_characters: 8 },
      source: 'provider',
    });
  });

  it('decode：content-type 大小写不敏感；缺失回落 audio/wav', () => {
    const audio = Buffer.from([1, 2, 3]);
    expect(
      decodeTtsResponse({ status: 200, headers: { 'Content-Type': 'audio/pcm' }, body: audio })
        .contentType,
    ).toBe('audio/pcm');
    expect(decodeTtsResponse({ status: 200, headers: {}, body: audio }).contentType).toBe(
      'audio/wav',
    );
  });

  it('decode：不带 req 时 usage 是"未知"（空 units，不用 0 冒充）', () => {
    const decoded = decodeTtsResponse({
      status: 200,
      headers: { 'content-type': 'audio/wav' },
      body: Buffer.alloc(0),
    });
    expect(decoded.usage.units).toEqual({});
    expect(decoded.usage.source).toBe('provider');
    expect('characters' in decoded.usage.units).toBe(false);
  });

  it('buildTtsUsage / ttsMimeType 的口径', () => {
    expect(buildTtsUsage('hello').units.characters).toEqual({ input: 5, billed: 5 });
    expect(buildTtsUsage('你好').units.characters).toEqual({ input: 4, billed: 4 });
    expect(ttsMimeType('wav')).toBe('audio/wav');
    expect(ttsMimeType('pcm')).toBe('audio/pcm');
  });
});

describe('deepseek.tts client', () => {
  /**
   * 二进制夹具说明：`ScriptedTransport` 的 `ScriptedStep.body` 是 **string**，内部走
   * `Buffer.from(str)`（UTF-8）。只有每个字节都 < 0x80 的负载能无损往返，所以客户端
   * 的成功路径用 `tts.response.pcm.json`（全正样本的原始 PCM，见夹具里的 note）；
   * 真正的 WAV 字节往返在 codec 组里直接用 Buffer 断言（不经过 string）。
   */
  const pcm = readJson('tts.response.pcm.json') as {
    content_type: string;
    audio_base64: string;
  };
  const pcmBytes = Buffer.from(pcm.audio_base64, 'base64');

  it('2xx：音频流 + characters usage；请求是 JSON', async () => {
    const transport = new ScriptedTransport([
      {
        status: 200,
        headers: { 'content-type': pcm.content_type },
        body: pcmBytes.toString('latin1'),
      },
    ]);
    const client = new DeepSeekTtsClient({ transport, headersProvider: fakeHeadersProvider });
    const outcome = await client.synthesize({ text: '你好，这是一段示例合成文本。' });

    expect(outcome.httpStatus).toBe(200);
    expect(outcome.audio.equals(pcmBytes)).toBe(true);
    expect(outcome.contentType).toBe('audio/pcm');
    expect(outcome.usage.units.characters?.billed).toBe(
      billedCharCount('你好，这是一段示例合成文本。'),
    );

    const sent = transport.requests[0];
    expect(sent?.path).toBe(DEEPSEEK_TTS_PATH);
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(JSON.parse((sent?.body ?? Buffer.alloc(0)).toString('utf8'))).toEqual({
      text: '你好，这是一段示例合成文本。',
      voice_id: 'stella',
      format: 'wav',
      filter_markdown: true,
    });
  });

  it('2xx：format=pcm 时 audio 就是原始 PCM 字节（content-type 来自上游头）', async () => {
    const transport = new ScriptedTransport([
      {
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
        body: pcmBytes.toString('latin1'),
      },
    ]);
    const outcome = await new DeepSeekTtsClient({
      transport,
      headersProvider: fakeHeadersProvider,
    }).synthesize({ text: 'hi', format: 'pcm' });
    expect(outcome.contentType).toBe('audio/pcm');
    expect(outcome.audio.equals(pcmBytes)).toBe(true);
    expect(JSON.parse((transport.requests[0]?.body ?? Buffer.alloc(0)).toString('utf8'))).toEqual({
      text: 'hi',
      voice_id: 'stella',
      format: 'pcm',
      filter_markdown: true,
    });
  });

  it('非 2xx：402（余额不足）带 JSON 错误体上抛——成功响应才是音频字节', async () => {
    const errorBody = {
      error: {
        message: 'Insufficient balance',
        type: 'insufficient_balance',
        param: null,
        code: 'insufficient_balance',
      },
    };
    const transport = new ScriptedTransport([{ status: 402, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() =>
      new DeepSeekTtsClient({ transport, headersProvider: fakeHeadersProvider }).synthesize({
        text: '你好',
      }),
    );
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(402);
    expect(err.body).toEqual(errorBody);
  });
});
