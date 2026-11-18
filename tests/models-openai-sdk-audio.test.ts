/**
 * tests/models-openai-sdk-audio.test.ts —— **官方 OpenAI SDK** 打我们的音频端点。
 *
 * 任务书的完成标准原话："能用 OpenAI SDK（`openai.audio.speech.create` /
 * `openai.audio.transcriptions.create`）打我们的 `/v1/audio/speech` 与
 * `/v1/audio/transcriptions` 并拿到预期结果（写一个用官方 SDK 的测试证明，
 * 参考 tests/models-openai-sdk.test.ts 的做法）"——本文件就是那个测试。
 *
 * 与 models-openai-sdk.test.ts 的分工：那个用替身 fetch 打 `/v1/models`（不起服务），
 * 本文件**起真的 HTTP 服务器**、让 SDK 用自己的 multipart 编码器与二进制响应解析
 * 去验收。之所以不起替身：音频这条路上 SDK 自己干了三件我们不想模仿的事——
 * formdata-node 的 multipart 编码（随机 boundary、文件名转义）、二进制响应的
 * `__binaryResponse` 分支、以及 4xx/5xx → 具体错误类的映射。让真 SDK 跑一遍，
 * 这三件事才真的被验证。
 *
 * 断言立场：
 *   1. `speech.create` 拿到的是**音频字节**（Content-Type 与请求的 response_format 一致）；
 *   2. `transcriptions.create` 三种 response_format 各拿到 SDK 自己类型承诺的形状；
 *   3. 错误路径走 SDK 自己的错误类（BadRequestError / AuthenticationError / InternalServerError），
 *      与打真 OpenAI 的行为一致；
 *   4. 客户端可以用 OpenAI 的模型名（tts-1 / whisper-1）与嗓音名（nova），零修改。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import OpenAI, { toFile } from 'openai';
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
import { MemoryUsageSink } from '../metering/memory-emitter.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'openai-sdk-audio-test-passphrase';
const FAKE_KEY = 'sk-fake-deepseek-not-real';
const ACCESS_TOKEN = 'sdk-audio-test-access-token-not-real';

/** 上游 TTS 音频（ASCII 假字节：ScriptedTransport 的 body 是字符串）。 */
const FAKE_WAV = 'RIFF____WAVEfmt fake-audio-bytes-for-sdk';
const FAKE_ASR = JSON.stringify({
  request_id: 'asr_fake',
  text: '这是 SDK 打进来的转写结果',
  duration_ms: 3_400,
});

interface Harness {
  server: Server;
  baseUrl: string;
  gateway: ReturnType<typeof createGateway>;
  transport: ScriptedTransport;
}

async function harness(script: ScriptedTransportScript): Promise<Harness> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const sink = new MemoryUsageSink();
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    clock,
    transport,
    usageSink: sink,
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
    audio: gateway.audioEndpoints,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, gateway, transport };
}

/** 一个 8 字节 WAV 头的假音频（够真实到能当 multipart 的 file）。 */
const FAKE_AUDIO_BYTES = Buffer.from('RIFF____WAVEfmt ', 'utf8');

describe('OpenAI SDK · audio.speech.create()', () => {
  let h: Harness;
  let client: OpenAI;

  beforeAll(async () => {
    // 脚本按请求顺序消费：两个成功请求各要一条（wav / pcm 各一次）
    h = await harness([
      { headers: { 'content-type': 'audio/wav' }, body: FAKE_WAV },
      { headers: { 'content-type': 'audio/pcm' }, body: FAKE_WAV },
      { headers: { 'content-type': 'audio/pcm' }, body: FAKE_WAV },
    ]);
    client = new OpenAI({
      baseURL: `${h.baseUrl}/v1`,
      apiKey: 'test-not-a-real-key',
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => h.server.close(() => r()));
    await h.gateway.shutdown();
  });

  it('SDK 拿到音频二进制，Content-Type 与请求的 response_format 一致', async () => {
    const response = await client.audio.speech.create({
      model: 'tts-1',
      input: '你好世界',
      voice: 'nova',
      response_format: 'wav',
    });
    expect(response.headers.get('content-type')).toBe('audio/wav');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.toString('utf8')).toBe(FAKE_WAV);
    // 上游收到的是 DeepSeek 的 wire 形状（voice_id/format），不是 OpenAI 的 voice
    const wire = JSON.parse(h.transport.requests[0]!.body?.toString('utf8') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(wire).toMatchObject({ text: '你好世界', voice_id: 'stella', format: 'wav' });
  });

  it('response_format=pcm → audio/pcm（SDK 不解码二进制，只透传响应）', async () => {
    const response = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      input: 'hello',
      voice: 'onyx',
      response_format: 'pcm',
    });
    expect(response.headers.get('content-type')).toBe('audio/pcm');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('不支持的格式 → SDK 的 BadRequestError（与打真 OpenAI 同一类）', async () => {
    await expect(
      client.audio.speech.create({
        model: 'tts-1',
        input: 'hi',
        voice: 'alloy',
        response_format: 'mp3',
      }),
    ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    // 一次上游都没打
    expect(h.transport.requests).toHaveLength(2);
  });

  it('voice 未映射 → BadRequestError，消息列出可用名', async () => {
    await expect(
      client.audio.speech.create({ model: 'tts-1', input: 'hi', voice: 'marin' }),
    ).rejects.toThrow(/voice marin 未映射/);
  });

  it('模型解析不到 → BadRequestError（不是 500）', async () => {
    await expect(
      client.audio.speech.create({ model: 'tts-9', input: 'hi', voice: 'alloy' }),
    ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });
});

describe('OpenAI SDK · audio.transcriptions.create()', () => {
  let h: Harness;
  let client: OpenAI;

  beforeAll(async () => {
    h = await harness([{ body: FAKE_ASR }, { body: FAKE_ASR }, { body: FAKE_ASR }]);
    client = new OpenAI({
      baseURL: `${h.baseUrl}/v1`,
      apiKey: 'test-not-a-real-key',
      maxRetries: 0,
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => h.server.close(() => r()));
    await h.gateway.shutdown();
  });

  it('json（默认）→ SDK 的 Transcription 形状 {text}', async () => {
    const result = await client.audio.transcriptions.create({
      file: await toFile(FAKE_AUDIO_BYTES, 'clip.wav'),
      model: 'whisper-1',
    });
    expect(result.text).toBe('这是 SDK 打进来的转写结果');
  });

  it('verbose_json → duration / segments 都在（上游不给分段时是空数组）', async () => {
    const result = await client.audio.transcriptions.create({
      file: await toFile(FAKE_AUDIO_BYTES, 'clip.wav'),
      model: 'whisper-1',
      response_format: 'verbose_json',
    });
    expect(result.text).toBe('这是 SDK 打进来的转写结果');
    expect(result.duration).toBe(3.4);
    expect(result.segments).toEqual([]);
  });

  it('text → 纯字符串', async () => {
    const result = await client.audio.transcriptions.create({
      file: await toFile(FAKE_AUDIO_BYTES, 'clip.wav'),
      model: 'whisper-1',
      response_format: 'text',
    });
    expect(result).toBe('这是 SDK 打进来的转写结果');
  });

  it('SDK 的 multipart 编码（随机 boundary）我们的解析器能吃下', async () => {
    // SDK 用 formdata-node + form-data-encoder，boundary 每次随机；上面三个请求
    // 已经各自成功一次，这里再确认上游收到的是完整音频（一个字节都没被啃掉）
    const sent = h.transport.requests.at(-1)!.body?.toString('latin1') ?? '';
    expect(sent).toContain('RIFF____WAVEfmt ');
    expect(sent).toContain('filename="clip.wav"');
  });

  it('模型名解析不到 → BadRequestError', async () => {
    await expect(
      client.audio.transcriptions.create({
        file: await toFile(FAKE_AUDIO_BYTES, 'clip.wav'),
        model: 'whisper-9',
      }),
    ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });
});

describe('OpenAI SDK · 音频端点的错误类型与鉴权', () => {
  it('translations → SDK 的 InternalServerError（501 明确不支持）', async () => {
    const h = await harness([]);
    const client = new OpenAI({
      baseURL: `${h.baseUrl}/v1`,
      apiKey: 'test-not-a-real-key',
      maxRetries: 0,
    });
    await expect(
      client.audio.translations.create({
        file: await toFile(FAKE_AUDIO_BYTES, 'clip.wav'),
        model: 'whisper-1',
      }),
    ).rejects.toBeInstanceOf(OpenAI.InternalServerError);
    await expect(
      client.audio.translations.create({
        file: await toFile(FAKE_AUDIO_BYTES, 'clip.wav'),
        model: 'whisper-1',
      }),
    ).rejects.toThrow(/不支持翻译/);
    await new Promise<void>((r) => h.server.close(() => r()));
    await h.gateway.shutdown();
  });

  it('极简模式（配了 AG_ACCESS_TOKEN）下不带令牌 → AuthenticationError', async () => {
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const gateway = createGateway({
      mode: 'test',
      clock,
      transport: new ScriptedTransport([{ body: FAKE_WAV }]),
      config: { accessToken: ACCESS_TOKEN },
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
      audio: gateway.audioEndpoints,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    const anon = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'wrong',
      maxRetries: 0,
    });
    await expect(
      anon.audio.speech.create({ model: 'tts-1', input: 'hi', voice: 'alloy' }),
    ).rejects.toBeInstanceOf(OpenAI.AuthenticationError);

    // 带对令牌就通
    const ok = new OpenAI({
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: ACCESS_TOKEN,
      maxRetries: 0,
    });
    const response = await ok.audio.speech.create({ model: 'tts-1', input: 'hi', voice: 'alloy' });
    expect(response.status).toBe(200);

    await new Promise<void>((r) => server.close(() => r()));
    await gateway.shutdown();
  });
});
