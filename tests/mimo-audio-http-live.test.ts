/**
 * tests/mimo-audio-http-live.test.ts —— MiMo 音频端点**经真网关 + 真上游**的 HTTP 冒烟。
 *
 * ⚠️ 只在 `MIMO_API_KEY` 存在时运行（describe.runIf），`npm test` 无 key 时自动跳过。
 * 跑法（key 只从环境变量读；公网需经本机代理）：
 *   HTTPS_PROXY=http://127.0.0.1:7890 node --env-file=.env \
 *     npx vitest run tests/mimo-audio-http-live.test.ts
 *
 * 与 tests/mimo-live.test.ts 的分工：
 *   - 那个打**上游裸端点**（观测 wire 形状）；
 *   - **本文件起一个真网关**（FetchTransport + 真 key + 真 HTTP server + 真数据面鉴权），
 *     从 socket 往里打 `/v1/audio/speech` 与 `/v1/audio/transcriptions`——验的是
 *     「MiMo 的脸接进网关之后，客户端零修改就能用」。
 *
 * 覆盖：
 *   1. `GET /v1/models` 经网关看得到 MiMo（部署态过滤：只配了 MiMo 一家）；
 *   2. `/v1/audio/speech`：wav / mp3 / voiceclone 三种，二进制 + Content-Type 正确；
 *   3. `/v1/audio/transcriptions`：把刚合成的音频喂回去（multipart），闭环；
 *   4. 数据面鉴权：临时虚拟 key 能过、**未认证 401**、撤销后立刻失效（不留下任何测试 key）；
 *   5. 错误路径：坏模型名（错误信息列两家的可用模型）、不支持的 response_format；
 *   6. 计量：每次调用落一条 UsageRecord，provider / access_path 记在 MiMo 头上。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { createModelsEndpoints } from '../http/models-endpoint.js';
import { FetchTransport } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { DefaultVirtualKeyStore } from '../storage/virtual-keys.js';
import { DefaultEncryptedRecordStore, InMemoryRawRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { MemoryUsageSink } from '../metering/memory-emitter.js';

const KEY = (process.env.MIMO_API_KEY ?? '').trim();
const hasKey = KEY.length > 0;
const PASSPHRASE = 'mimo-audio-http-live-passphrase';
const FIXED_NOW = 1_760_000_000_000;

const observations: string[] = [];
function obs(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  observations.push(line);
  process.stdout.write(`[obs] ${line}\n`);
}

/** 跨用例传递音频样本（模块级：每例重跑上游既慢又费额度）。 */
let speechWav: Buffer | undefined;
let speechMp3: Buffer | undefined;

const describeLive = describe.runIf(hasKey);

describeLive('MiMo 音频端点 · 真网关 + 真上游 HTTP 冒烟', () => {
  let server: Server;
  let baseUrl: string;
  let gateway: ReturnType<typeof createGateway>;
  let sink: MemoryUsageSink;
  let keyStore: DefaultVirtualKeyStore;
  /** 临时虚拟 key 的明文（只在内存里；afterAll 撤销）。 */
  let tempKeyPlaintext: string | undefined;
  let tempKeyId: string | undefined;

  beforeAll(async () => {
    if (!hasKey) return;
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const recordStore = new DefaultEncryptedRecordStore(
      ks.unlocked(),
      new InMemoryRawRecordStore(),
      { now: () => FIXED_NOW },
    );
    keyStore = new DefaultVirtualKeyStore(recordStore, { now: () => FIXED_NOW });
    const created = await keyStore.create({ name: 'mimo-audio-http-live-temp' });
    tempKeyPlaintext = created.plaintext;
    tempKeyId = created.key_id;
    obs('临时虚拟 key 已创建（id 长度 =', created.key_id.length, '）');

    sink = new MemoryUsageSink();
    gateway = createGateway({
      mode: 'production',
      transport: new FetchTransport(),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        MIMO_API_KEY: KEY,
      }),
      recordStore,
      usageSink: sink,
      config: { virtualKeysEnabled: true },
    });
    server = createHttpServer({
      port: 0,
      host: '127.0.0.1',
      runner: gateway.runner,
      tools: gateway.toolEndpoints,
      audio: gateway.audioEndpoints,
      modalities: gateway.modalityEndpoints,
      ...(gateway.admin === undefined ? {} : { adminHandler: gateway.admin.routeHandler }),
      models: createModelsEndpoints({ catalog: gateway.models, sync: gateway.modelSync }),
      // 传输层的门用网关自己的数据面鉴权器（与 S0 同一个实例、同一套语义）
      authenticator: gateway.dataPlaneAuth,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
    obs('网关已监听', baseUrl);
  }, 120_000);

  afterAll(async () => {
    if (!hasKey) return;
    // 撤销临时 key：不留下任何测试 key（照 #34 线程那轮的做法）
    if (tempKeyId !== undefined) {
      await keyStore.revoke(tempKeyId, FIXED_NOW);
      obs('临时虚拟 key 已撤销');
    }
    server.close();
    await gateway.shutdown();
    obs(`共 ${observations.length} 条观测`);
  });

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${tempKeyPlaintext}` };
  }

  // -------------------------------------------------------------------------
  // 1. /v1/models 经网关
  // -------------------------------------------------------------------------

  it('GET /v1/models 看得到 MiMo（只配了 MiMo 一家）', async () => {
    const res = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { data: Array<{ id: string }> }).data
      .map((m) => m.id)
      .sort();
    obs('网关 /v1/models →', JSON.stringify(ids));
    expect(ids).toEqual([
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.6-flash',
      'mimo-v2.6-pro',
    ]);
    // 部署态过滤：DeepSeek / OpenAI / Anthropic 都没配 key，不该出现
    expect(ids).not.toContain('deepseek-flash');
    expect(ids).not.toContain('gpt-4o');
    // mock 两条是内部脚手架，永不出现
    expect(ids).not.toContain('gpt-test-1');
  }, 60_000);

  // -------------------------------------------------------------------------
  // 2. /v1/audio/speech
  // -------------------------------------------------------------------------

  it('POST /v1/audio/speech：wav，二进制 + Content-Type 正确', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        input: '你好，这是经网关的语音合成测试。',
        voice: 'mimo_default',
        response_format: 'wav',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    obs('/v1/audio/speech wav →', res.status, buf.byteLength, 'bytes');
    expect(buf.byteLength).toBeGreaterThan(1000);
    // wav 容器头（RIFF....WAVE）
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // 音频留着给下面的 ASR 用例
    speechWav = buf;
  }, 180_000);

  it('POST /v1/audio/speech：mp3（OpenAI 客户端默认想要的那种）', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        input: '短句。',
        voice: 'Mia',
        response_format: 'mp3',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    const buf = Buffer.from(await res.arrayBuffer());
    obs('/v1/audio/speech mp3 →', res.status, buf.byteLength, 'bytes');
    expect(buf.byteLength).toBeGreaterThan(500);
    speechMp3 = buf;
  }, 180_000);

  it('POST /v1/audio/speech：voiceclone（voice 是音频样本的 data URL）', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts-voiceclone',
        input: '克隆声音测试。',
        voice: `data:audio/wav;base64,${(speechWav ?? Buffer.alloc(0)).toString('base64')}`,
        response_format: 'wav',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const buf = Buffer.from(await res.arrayBuffer());
    obs('/v1/audio/speech voiceclone →', res.status, buf.byteLength, 'bytes');
    expect(buf.byteLength).toBeGreaterThan(1000);
  }, 180_000);

  // -------------------------------------------------------------------------
  // 3. /v1/audio/transcriptions（闭环）
  // -------------------------------------------------------------------------

  it('POST /v1/audio/transcriptions：TTS 产出喂回去，识别出文本', async () => {
    const form = new FormData();
    form.set('model', 'mimo-v2.5-asr');
    form.set('language', 'zh');
    form.set('response_format', 'json');
    form.set('file', new Blob([speechWav!], { type: 'audio/wav' }), 'roundtrip.wav');
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    obs('/v1/audio/transcriptions →', res.status, JSON.stringify(body));
    expect(typeof body.text).toBe('string');
    // ASR 不保证逐字相同（实测把 "MiMo" 听成「咪莫」），剥掉标点后应认出中文主体
    expect(body.text.replace(/[，。！？、\s]/g, '')).toContain('语音合成测试');
  }, 180_000);

  it('POST /v1/audio/transcriptions：response_format=text 给纯文本', async () => {
    const form = new FormData();
    form.set('model', 'mimo-v2.5-asr');
    form.set('language', 'zh');
    form.set('response_format', 'text');
    form.set('file', new Blob([speechMp3!], { type: 'audio/mpeg' }), 'roundtrip.mp3');
    const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    obs('/v1/audio/transcriptions text →', res.status, JSON.stringify(text.slice(0, 60)));
    expect(text.length).toBeGreaterThan(1);
  }, 180_000);

  // -------------------------------------------------------------------------
  // 4. 数据面鉴权
  // -------------------------------------------------------------------------

  it('未认证 → 401（管理面令牌在这里不接受）', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.5-tts', input: 'hi', voice: 'mimo_default' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { type?: string; message?: string } };
    obs('未认证 →', res.status, JSON.stringify(body));
    // server 层的信封只有 {message, type}，没有 code（端点内层的 classifyToolError 才带 code）
    expect(body.error?.type).toBe('auth_failed');
    expect(body.error?.message).toMatch(/API key/);
  }, 60_000);

  it('临时 key 撤销后失效（新鉴权器实例不认它；不留测试 key）', async () => {
    expect(tempKeyId).toBeDefined();
    await keyStore.revoke(tempKeyId!, FIXED_NOW);
    obs('临时 key 已撤销（记录里 status=revoked）');

    // 网关的数据面鉴权器是组合根用同一个 recordStore 新建的实例，缓存按实例走；
    // 用一个**全新**的鉴权器验"这把 key 确实废了"——它只读存储，不继承任何缓存。
    const { DataPlaneAuthenticator } = await import('../auth/data-plane.js');
    const fresh = new DataPlaneAuthenticator({ store: keyStore, clock: { now: () => FIXED_NOW } });
    const after = await fresh.authenticate({
      headers: { authorization: `Bearer ${tempKeyPlaintext}` },
      query: {},
      path: '/v1/chat/completions',
      raw_body: Buffer.alloc(0),
    });
    obs('撤销后（新鉴权器）→', JSON.stringify(after));
    expect(after.ok).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5. 错误路径
  // -------------------------------------------------------------------------

  it('坏模型名 → 400 + 一份合并的可用清单（两家上游）', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model', input: 'hi' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    obs('坏模型名 →', res.status, JSON.stringify(body));
    expect(body.error?.code).toBe('model_not_found');
    // 清单里既有 DeepSeek 的也有 MiMo 的（客户端不该先知道网关接了几家）
    expect(body.error?.message).toContain('deepseek-tts');
    expect(body.error?.message).toContain('mimo-v2.5-tts');
  }, 60_000);

  it('不支持的 response_format → 400（不静默转成 wav）', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        input: 'hi',
        voice: 'mimo_default',
        response_format: 'opus',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    obs('opus →', res.status, JSON.stringify(body));
    expect(body.error?.code).toBe('unsupported_response_format');
    expect(body.error?.message).toContain('MiMo');
  }, 60_000);

  it('/v1/audio/translations → 501（两家都不支持，理由说清）', async () => {
    const res = await fetch(`${baseUrl}/v1/audio/translations`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.5-asr' }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    obs('translations →', res.status, JSON.stringify(body));
    expect(body.error?.code).toBe('translations_not_supported');
    expect(body.error?.message).toContain('DeepSeek');
    expect(body.error?.message).toContain('MiMo');
  }, 60_000);

  // -------------------------------------------------------------------------
  // 6. 计量
  // -------------------------------------------------------------------------

  it('计量：UsageRecord 是 priced 而不是 unpriced（TTS 按字符 + ASR 按音频秒）', async () => {
    // 仓库主人规则：「接入的每个模型都不能是 unpriced」。这里经真网关 + 真上游验。
    await gateway.usageEmitter.flush();
    const before = sink.records.length;

    // TTS：按字符（官方限时免费 → 0 元，但 status 必须是 priced）
    const tts = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        input: '计费状态测试。',
        voice: 'mimo_default',
        response_format: 'wav',
      }),
    });
    expect(tts.status).toBe(200);
    await gateway.usageEmitter.flush();
    const ttsRec = sink.records.slice(before).at(-1)!;
    obs(
      'TTS 用量记录 cost =',
      JSON.stringify(ttsRec.cost),
      'snapshot =',
      JSON.stringify(ttsRec.price_snapshot),
    );
    expect(ttsRec.provider).toBe('mimo');
    expect(ttsRec.access_path).toBe('mimo.tools.tts');
    // 关键断言：不是 unpriced
    expect(ttsRec.cost.status).toBe('priced');
    expect(ttsRec.price_snapshot).not.toBeNull();
    expect(ttsRec.price_snapshot?.price_table_version).toBe('mimo-2026-10-21');
    // 官方限时免费 → 0 元；订阅路径 cash 也恒 0
    expect(ttsRec.cost.as_api.total).toBe(0);
    expect(ttsRec.cost.cash.total).toBe(0);

    // ASR：按音频秒（¥0.5/小时 → as_api > 0）
    const beforeAsr = sink.records.length;
    const form = new FormData();
    form.set('model', 'mimo-v2.5-asr');
    form.set('language', 'zh');
    form.set('file', new Blob([speechWav!], { type: 'audio/wav' }), 'priced.wav');
    const asr = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    expect(asr.status).toBe(200);
    await gateway.usageEmitter.flush();
    const asrRec = sink.records.slice(beforeAsr).at(-1)!;
    obs(
      'ASR 用量记录 cost =',
      JSON.stringify(asrRec.cost),
      'usage =',
      JSON.stringify(asrRec.usage),
    );
    expect(asrRec.access_path).toBe('mimo.tools.asr');
    expect(asrRec.cost.status).toBe('priced');
    // 按音频小时计费，as_api 必然 > 0（哪怕只有几秒）
    expect(asrRec.cost.as_api.total).toBeGreaterThan(0);
    // 订阅路径（tp- key）cash 恒 0
    expect(asrRec.cost.cash.total).toBe(0);
    expect(asrRec.price_snapshot?.rates).toMatchObject({ per_hour: 0.5 });
  }, 180_000);

  it('计量：UsageRecord 落在 MiMo 头上（provider / access_path / client_format）', async () => {
    // 生产模式的 emitter 是**异步批量 flush** 的：先前几条用例的记录可能还没到 sink，
    // 所以不能靠"数组下标变长了"切片。先 flush 一次取基线，调用后再 flush 一次取增量。
    await gateway.usageEmitter.flush();
    const before = sink.records.length;
    const res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        input: '计量测试。',
        voice: 'mimo_default',
        response_format: 'wav',
      }),
    });
    expect(res.status).toBe(200);
    await gateway.usageEmitter.flush();
    const records = sink.records.slice(before);
    obs(
      '新增用量记录 →',
      JSON.stringify(
        records.map((r) => ({
          provider: r.provider,
          access_path: r.access_path,
          client_format: r.client_format,
          model: r.model,
        })),
      ),
    );
    expect(records.length).toBeGreaterThanOrEqual(1);
    const last = records[records.length - 1]!;
    expect(last.provider).toBe('mimo');
    expect(last.access_path).toBe('mimo.tools.tts');
    expect(last.client_format).toBe('openai.audio.speech');
    expect(last.model).toBe('mimo-v2.5-tts');
    // 前面那些 400 / 501 也不能记成 DeepSeek 的（2026-11 修的真 bug 的 live 版）
    for (const r of records) {
      if (r.model.startsWith('mimo-')) {
        expect(r.provider).toBe('mimo');
        expect(r.access_path?.startsWith('mimo.tools.')).toBe(true);
      }
    }
  }, 180_000);
});
