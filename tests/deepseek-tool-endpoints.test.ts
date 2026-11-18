/**
 * tests/deepseek-tool-endpoints.test.ts —— 全家桶五个独立端点的**网关装配**契约测试。
 *
 * wire 层的 round-trip 已由 providers/deepseek/endpoints.test.ts 覆盖；本文件覆盖
 * 任务书要求的另外三件事：**canonical 往返、路由装配、计量**。
 *
 * 分四组：
 *   1. **canonical 往返**（每端点至少一次）：客户端 JSON → canonical → wire 请求体；
 *      上游响应 → canonical → 客户端 JSON。纯函数，不起 HTTP。
 *   2. **路由装配**：五个端点一条不少，路径与 access path 对得上；
 *      `/v1/tools/*` 前缀之外的路径不归它们管。
 *   3. **计量**：每次调用落一条 UsageRecord，单位按端点分（按次 / 按页 / 按音频秒 /
 *      按字符），**失败也记**（429 之前的调用照样可能花了钱）。
 *   4. **鉴权与错误分类**：数据面鉴权（未登录 401）、上游 401/404/429 各自的 code
 *      与一句话文案、坏 JSON 400。
 *
 * 上游一律 ScriptedTransport，不打真实网络；key 一律显式假值。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';

/** 测试不测鉴权，但默认拒绝要求显式注入——这正是「忘了接就关门」的证明。 */
const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { createDeepSeekToolHandlers } from '../providers/deepseek/tool-handlers.js';
import { DeepSeekSearchClient } from '../providers/deepseek/search.js';
import { DeepSeekFetchClient } from '../providers/deepseek/fetch.js';
import { DeepSeekOcrClient } from '../providers/deepseek/ocr.js';
import { DeepSeekAsrClient } from '../providers/deepseek/asr.js';
import { DeepSeekTtsClient } from '../providers/deepseek/tts.js';
import { MemoryUsageSink } from '../metering/memory-emitter.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'tool-endpoints-test-passphrase';
const FAKE_KEY = 'sk-fake-deepseek-not-real';

/** 上游夹具（全是假数据：example.com 域名、假 id、无真实凭据）。 */
const FIXTURES = {
  search: {
    results: [
      {
        rerank_score: 2.5,
        title: '示例页面',
        url: 'https://example.com/a',
        snippet: '短摘要',
        summary: '给模型的长摘要',
        content: '',
        site_name: 'Example',
        site_icon: null,
        date: '2026-11-01T00:00:00Z',
        authority: 3,
      },
    ],
  },
  fetch: { title: '示例标题', content: '# 正文 Markdown' },
  ocr: {
    id: 'ocr_fake',
    object: 'ocr',
    created: FIXED_NOW,
    purpose: 'text_recognition',
    page_count: 2,
    pages: [
      { index: 0, text: '第一页', finish_reason: 'stop' },
      { index: 1, text: '第二页', finish_reason: 'stop' },
    ],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  },
  asr: { request_id: 'asr_fake', text: '转写文本', duration_ms: 12_500 },
  tts: { audio: Buffer.from('RIFFfake-wav-bytes').toString('base64') },
};

/** 建一套纯函数层面的 handler（不起 HTTP、不起网关）。 */
function handlersFor(transport: ScriptedTransport) {
  const headersProvider = async () => ({ authorization: `Bearer ${FAKE_KEY}` });
  return createDeepSeekToolHandlers({
    search: new DeepSeekSearchClient({ transport, headersProvider }),
    fetch: new DeepSeekFetchClient({ transport, headersProvider }),
    ocr: new DeepSeekOcrClient({ transport, headersProvider }),
    asr: new DeepSeekAsrClient({ transport, headersProvider }),
    tts: new DeepSeekTtsClient({ transport, headersProvider }),
  });
}

// ---------------------------------------------------------------------------
// 1. canonical 往返（每端点至少一次）
// ---------------------------------------------------------------------------

describe('canonical 往返：search', () => {
  it('客户端 JSON → canonical → wire 请求体', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(FIXTURES.search) }]);
    const [search] = handlersFor(transport);
    const canonical = search.decodeRequest({
      query: '示例 查询',
      count: 5,
      need_content: true,
      ori_question: '原始问题',
      localization: '203.0.113.10',
    });
    expect(canonical).toMatchObject({
      endpoint: 'search',
      query: '示例 查询',
      count: 5,
      need_content: true,
      ori_question: '原始问题',
      localization: '203.0.113.10',
    });
    const outcome = await search.run(canonical);
    // 响应是 canonical 的 SearchResultPart（与 chat 的 search_result part 同一形状）
    expect(outcome.endpoint).toBe('search');
    if (outcome.endpoint !== 'search') return;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      type: 'search_result',
      source: 'Example',
      title: '示例页面',
      url: 'https://example.com/a',
      snippet: '短摘要',
      score: 2.5,
      citation_index: 0,
    });
    // 上游收到的是 wire 形状（query/count/need_content/ori_question/localization）
    const wire = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(wire).toEqual({
      query: '示例 查询',
      count: 5,
      need_content: true,
      ori_question: '原始问题',
      localization: '203.0.113.10',
    });
    // 回给客户端的 JSON
    const client = search.encodeResponse(outcome) as Record<string, unknown>;
    expect(client['object']).toBe('tools.search.result');
    expect((client['results'] as unknown[]).length).toBe(1);
    expect(client['usage']).toEqual({ units: { requests: 1 }, source: 'provider' });
  });

  it('ori_question 显式 null 不进 wire（文档：null = 不提供）', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(FIXTURES.search) }]);
    const [search] = handlersFor(transport);
    const canonical = search.decodeRequest({ query: 'q', ori_question: null });
    await search.run(canonical);
    const wire = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as Record<
      string,
      unknown
    >;
    expect('ori_question' in wire).toBe(false);
  });

  it('坏 count / 缺 query → 400 级 ToolRequestError', () => {
    const transport = new ScriptedTransport([]);
    const [search] = handlersFor(transport);
    expect(() => search.decodeRequest({ query: 'q', count: 99 })).toThrow(/count/);
    expect(() => search.decodeRequest({})).toThrow(/query/);
    expect(() => search.decodeRequest('nope')).toThrow(/JSON 对象/);
  });
});

describe('canonical 往返：fetch', () => {
  it('客户端 JSON → canonical → wire → canonical → 客户端 JSON', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(FIXTURES.fetch) }]);
    const handlers = handlersFor(transport);
    const fetch = handlers.find((h) => h.id === 'fetch')!;
    const canonical = fetch.decodeRequest({ url: 'https://example.com/page' });
    expect(canonical).toEqual({ endpoint: 'fetch', url: 'https://example.com/page', raw: {} });
    const res = await fetch.run(canonical);
    expect(res).toMatchObject({
      endpoint: 'fetch',
      title: '示例标题',
      content: '# 正文 Markdown',
      usage: { units: { requests: 1 }, source: 'provider' },
    });
    expect(transport.requests[0]!.path).toBe('/v1/tools/fetch');
    const client = fetch.encodeResponse(res) as Record<string, unknown>;
    expect(client['object']).toBe('tools.fetch.result');
    expect(client['content']).toBe('# 正文 Markdown');
  });
});

describe('canonical 往返：ocr', () => {
  it('base64 文件 → multipart wire → 按页 usage → canonical 响应', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(FIXTURES.ocr) }]);
    const handlers = handlersFor(transport);
    const ocr = handlers.find((h) => h.id === 'ocr')!;
    const canonical = ocr.decodeRequest({
      file: {
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        data_base64: Buffer.from('%PDF-fake').toString('base64'),
      },
      purpose: 'rich_layout_recognition',
    });
    expect(canonical).toMatchObject({
      endpoint: 'ocr',
      purpose: 'rich_layout_recognition',
    });
    const res = await ocr.run(canonical);
    // 计费主单位是**页数**（units.requests = page_count，UsageUnits 没有 pages 槽）
    expect(res).toMatchObject({
      endpoint: 'ocr',
      page_count: 2,
      usage: { units: { requests: 2 }, source: 'provider' },
    });
    // 上游拿到的是 multipart，且文件内容能解回原文
    const body = transport.requests[0]!.body?.toString('latin1') ?? '';
    expect(transport.requests[0]!.headers['content-type']).toContain('multipart/form-data');
    expect(body).toContain('%PDF-fake');
    expect(body).toContain('rich_layout_recognition');
    const client = ocr.encodeResponse(res) as Record<string, unknown>;
    expect(client['page_count']).toBe(2);
    expect((client['pages'] as unknown[]).length).toBe(2);
  });

  it('坏 base64 → 400 级 ToolRequestError（不把乱码发给上游）', () => {
    const transport = new ScriptedTransport([]);
    const handlers = handlersFor(transport);
    const ocr = handlers.find((h) => h.id === 'ocr')!;
    expect(() =>
      ocr.decodeRequest({
        file: { filename: 'a', content_type: 'application/pdf', data_base64: '!!!not base64!!!' },
      }),
    ).toThrow(/base64/);
  });
});

describe('canonical 往返：asr', () => {
  it('音频 base64 → multipart wire → 按音频秒 usage', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(FIXTURES.asr) }]);
    const handlers = handlersFor(transport);
    const asr = handlers.find((h) => h.id === 'asr')!;
    const canonical = asr.decodeRequest({
      audio: {
        filename: 'clip.wav',
        content_type: 'audio/wav',
        data_base64: Buffer.from('RIFFfake-wav').toString('base64'),
      },
      language: 'zh-CN',
    });
    expect(canonical).toMatchObject({ endpoint: 'asr', language: 'zh-CN' });
    const res = await asr.run(canonical);
    // duration_ms → 秒；计费主单位是音频时长
    expect(res).toMatchObject({
      endpoint: 'asr',
      text: '转写文本',
      duration_seconds: 12.5,
      usage: {
        units: { audio_seconds: { input: 12.5, billed: 12.5 } },
        source: 'provider',
      },
    });
    expect(transport.requests[0]!.path).toBe('/v1/tools/asr');
    const client = asr.encodeResponse(res) as Record<string, unknown>;
    expect(client['duration_seconds']).toBe(12.5);
  });
});

describe('canonical 往返：tts', () => {
  it('文本 → wire → 音频 base64 + 按字符 usage', async () => {
    // 上游返回二进制音频（content-type 由响应头给）
    const audio = Buffer.from('RIFFfake-wav-bytes');
    const transport = new ScriptedTransport([
      { headers: { 'content-type': 'audio/wav' }, body: audio.toString('latin1') },
    ]);
    const handlers = handlersFor(transport);
    const tts = handlers.find((h) => h.id === 'tts')!;
    const canonical = tts.decodeRequest({ input: '你好世界', voice_id: 'stella', format: 'wav' });
    expect(canonical).toMatchObject({
      endpoint: 'tts',
      input: '你好世界',
      voice_id: 'stella',
      format: 'wav',
    });
    const res = await tts.run(canonical);
    // 计费主单位是字符（CJK 每字 2：4 个汉字 = 8）
    expect(res).toMatchObject({
      endpoint: 'tts',
      content_type: 'audio/wav',
      usage: {
        units: { characters: { input: 8, billed: 8 } },
        source: 'provider',
      },
    });
    expect(res.endpoint === 'tts' && res.audio_base64).toBe(audio.toString('base64'));
    const wire = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(wire).toMatchObject({ text: '你好世界', voice_id: 'stella', format: 'wav' });
    const client = tts.encodeResponse(res) as Record<string, unknown>;
    expect(client['audio_base64']).toBe(audio.toString('base64'));
  });

  it('坏 format → 400 级 ToolRequestError', () => {
    const transport = new ScriptedTransport([]);
    const handlers = handlersFor(transport);
    const tts = handlers.find((h) => h.id === 'tts')!;
    expect(() => tts.decodeRequest({ input: 'hi', format: 'mp3' })).toThrow(/format/);
  });
});

// ---------------------------------------------------------------------------
// 2. 路由装配
// ---------------------------------------------------------------------------

describe('路由装配', () => {
  it('五个端点一条不少，路径与 access path 对得上', () => {
    const transport = new ScriptedTransport([]);
    const handlers = handlersFor(transport);
    expect(handlers.map((h) => h.id)).toEqual(['search', 'fetch', 'ocr', 'asr', 'tts']);
    expect(handlers.map((h) => h.path)).toEqual([
      '/v1/tools/search',
      '/v1/tools/fetch',
      '/v1/tools/ocr',
      '/v1/tools/asr',
      '/v1/tools/tts',
    ]);
    expect(handlers.map((h) => h.access_path)).toEqual([
      'deepseek.tools.search',
      'deepseek.tools.fetch',
      'deepseek.tools.ocr',
      'deepseek.tools.asr',
      'deepseek.tools.tts',
    ]);
    for (const h of handlers) {
      expect(h.provider).toBe('deepseek');
      expect(h.path.startsWith('/v1/tools/')).toBe(true);
    }
  });

  it('网关把 DeepSeek 五个 + MiMo 两个端点挂上（createGateway 的 toolEndpoints.list()）', async () => {
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const gateway = createGateway({
      mode: 'test',
      clock,
      transport: new ScriptedTransport([]),
      recordStore: new DefaultEncryptedRecordStore(
        ks.unlocked(),
        new InMemoryRawRecordStore(),
        clock,
      ),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_KEY,
      }),
      providerProfiles: (() => {
        const r = new InMemoryProviderProfileRegistry();
        r.register(createDeepSeekProfile());
        return r;
      })(),
    });
    // 5 + 2：MiMo 的两个音频端点 2026-11 接入，路径带 /mimo/ 前缀
    // （/v1/tools/mimo/{tts,asr}）——不撞 DeepSeek 的 /v1/tools/{tts,asr}，
    // 见 providers/mimo/tool-handlers.ts 文件头。
    expect(gateway.toolEndpoints.list()).toHaveLength(7);
    expect(gateway.toolEndpoints.list().map((r) => r.path)).toContain('/v1/tools/mimo/tts');
    expect(gateway.toolEndpoints.list().map((r) => r.path)).toContain('/v1/tools/mimo/asr');
    await gateway.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 3. 计量
// ---------------------------------------------------------------------------

interface HttpHarness {
  server: Server;
  baseUrl: string;
  gateway: ReturnType<typeof createGateway>;
  sink: MemoryUsageSink;
  transport: ScriptedTransport;
}

async function httpHarness(
  script: ScriptedTransportScript,
  options: { accessToken?: string } = {},
): Promise<HttpHarness> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const sink = new MemoryUsageSink();
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    clock,
    transport,
    usageSink: sink,
    ...(options.accessToken === undefined ? {} : { config: { accessToken: options.accessToken } }),
    recordStore: new DefaultEncryptedRecordStore(
      ks.unlocked(),
      new InMemoryRawRecordStore(),
      clock,
    ),
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY,
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
  });
  const server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    tools: gateway.toolEndpoints,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, gateway, sink, transport };
}

async function callTool(
  harness: HttpHarness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function close(h: HttpHarness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await h.gateway.shutdown();
}

/**
 * 把计量队列刷进 sink 再读。
 *
 * 为什么必须显式 flush：`MemoryUsageEmitter` 在 test 模式下 `autoFlush: false`
 * （不起定时器，测试才 deterministic），记录会一直排在队列里。直接读
 * `sink.records` 会拿到空数组——那正是本测试第一版踩的坑。
 */
async function recordsOf(h: HttpHarness) {
  await h.gateway.usageEmitter.flush();
  return h.sink.records;
}

describe('HTTP 装配 + 计量', () => {
  it('POST /v1/tools/search → 200，落一条 requests=1 的用量', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.search) }]);
    const res = await callTool(harness, '/v1/tools/search', { query: '示例' });
    expect(res.status).toBe(200);
    expect((res.body['results'] as unknown[]).length).toBe(1);
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.provider).toBe('deepseek');
    expect(rec.access_path).toBe('deepseek.tools.search');
    expect(rec.usage.units).toEqual({ requests: 1 });
    expect(rec.status).toBe('success');
    // DeepSeek pricing.json 的 tools 段（search_per_1000_requests 等）现已接进合成价表，
    // 调用即计价（status = 'priced'，不再掉入 pending_price）。
    expect(rec.cost.status).toBe('priced');
    expect(rec.cost.cash.builtin_tools).toBeGreaterThan(0);
    await close(harness);
  });

  it('OCR 落 requests=page_count（按页计费）', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.ocr) }]);
    const res = await callTool(harness, '/v1/tools/ocr', {
      file: {
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        data_base64: Buffer.from('%PDF-fake').toString('base64'),
      },
    });
    expect(res.status).toBe(200);
    expect((await recordsOf(harness))[0]!.usage.units).toEqual({ requests: 2 });
    await close(harness);
  });

  it('ASR 落 audio_seconds（按音频时长）', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.asr) }]);
    const res = await callTool(harness, '/v1/tools/asr', {
      audio: {
        filename: 'clip.wav',
        content_type: 'audio/wav',
        data_base64: Buffer.from('RIFFfake').toString('base64'),
      },
    });
    expect(res.status).toBe(200);
    expect((await recordsOf(harness))[0]!.usage.units).toEqual({
      audio_seconds: { input: 12.5, billed: 12.5 },
    });
    await close(harness);
  });

  it('TTS 落 characters（按字符，CJK 每字 2）', async () => {
    const harness = await httpHarness([
      {
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('RIFFfake').toString('latin1'),
      },
    ]);
    const res = await callTool(harness, '/v1/tools/tts', { input: '你好世界' });
    expect(res.status).toBe(200);
    expect((await recordsOf(harness))[0]!.usage.units).toEqual({
      characters: { input: 8, billed: 8 },
    });
    await close(harness);
  });

  it('Fetch 落 requests=1（按次计费）', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.fetch) }]);
    const res = await callTool(harness, '/v1/tools/fetch', { url: 'https://example.com/x' });
    expect(res.status).toBe(200);
    expect((await recordsOf(harness))[0]!.usage.units).toEqual({ requests: 1 });
    await close(harness);
  });

  it('上游失败也记用量（429 之前的调用照样可能花了钱）', async () => {
    const harness = await httpHarness([{ status: 429, body: 'slow down' }]);
    const res = await callTool(harness, '/v1/tools/search', { query: 'q' });
    expect(res.status).toBe(429);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('rate_limited');
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('error');
    await close(harness);
  });
});

describe('鉴权与错误分类', () => {
  it('极简模式（配了 AG_ACCESS_TOKEN）下未带令牌 → 401，且不打上游', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.search) }], {
      accessToken: 'test-access-token-not-real',
    });
    const res = await callTool(harness, '/v1/tools/search', { query: 'q' });
    expect(res.status).toBe(401);
    // 错误信息不回显调用方给的串（那把串可能就是 key）
    expect(JSON.stringify(res.body)).not.toContain('test-access-token-not-real');
    expect(harness.transport.requests).toHaveLength(0);
    // 带对令牌就通
    const ok = await callTool(
      harness,
      '/v1/tools/search',
      { query: 'q' },
      { authorization: 'Bearer test-access-token-not-real' },
    );
    expect(ok.status).toBe(200);
    await close(harness);
  });

  it('permissive 模式（什么都没配）下放过——与数据面其余端点同语义', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.search) }]);
    const res = await callTool(harness, '/v1/tools/search', { query: 'q' });
    expect(res.status).toBe(200);
    expect(harness.sink.records.length + (await recordsOf(harness)).length).toBeGreaterThan(0);
    await close(harness);
  });

  it('Bearer 形态的 key 能过（极简/虚拟 key 模式之外的 permissive 演示装配）', async () => {
    const harness = await httpHarness([{ body: JSON.stringify(FIXTURES.search) }]);
    const res = await callTool(
      harness,
      '/v1/tools/search',
      { query: 'q' },
      { authorization: `Bearer ${FAKE_KEY}` },
    );
    expect(res.status).toBe(200);
    await close(harness);
  });

  it('上游 401 → key_invalid + 502（不冒充管理面 401）', async () => {
    const harness = await httpHarness([{ status: 401, body: 'nope' }]);
    const res = await callTool(harness, '/v1/tools/search', { query: 'q' });
    expect(res.status).toBe(502);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('key_invalid');
    await close(harness);
  });

  it('上游 404 → upstream_not_found', async () => {
    const harness = await httpHarness([{ status: 404, body: 'nope' }]);
    const res = await callTool(harness, '/v1/tools/fetch', { url: 'https://example.com/x' });
    expect(res.status).toBe(502);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('upstream_not_found');
    await close(harness);
  });

  it('坏 JSON → 400 invalid_json（不打上游）', async () => {
    const harness = await httpHarness([{ body: '{}' }]);
    const res = await fetch(`${harness.baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('缺字段 → 400 invalid_request + 一句话', async () => {
    const harness = await httpHarness([{ body: '{}' }]);
    const res = await callTool(harness, '/v1/tools/search', {});
    expect(res.status).toBe(400);
    expect((res.body['error'] as Record<string, unknown>)['code']).toBe('invalid_request');
    await close(harness);
  });

  it('GET → 405', async () => {
    const harness = await httpHarness([{ body: '{}' }]);
    const res = await fetch(`${harness.baseUrl}/v1/tools/search`);
    expect(res.status).toBe(405);
    await close(harness);
  });

  it('`/v1/tools/unknown` → 404（不归这五个端点管，也不静默 200）', async () => {
    const harness = await httpHarness([{ body: '{}' }]);
    const res = await callTool(harness, '/v1/tools/unknown', {});
    expect(res.status).toBe(404);
    await close(harness);
  });
});
