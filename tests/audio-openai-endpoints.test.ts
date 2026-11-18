/**
 * tests/audio-openai-endpoints.test.ts —— `/v1/audio/*` OpenAI 兼容入站脸的契约测试。
 *
 * 覆盖任务书点名的七类：两个端点的 round-trip、verbose_json 分段、response_format
 * 各变体、voice 映射命中/未命中、multipart 缺文件、超大文件拒绝、模型解析失败；
 * 外加计费口径（复用多单位计量）、401、translations 明确不支持、错误信封形状。
 *
 * 上游一律 ScriptedTransport（假数据：example.com、假 id、无真实凭据）；
 * `/v1/audio/translations` 的 501 与"上游不支持"的立场也在这里钉死。
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
import { MemoryUsageSink } from '../metering/memory-emitter.js';
import {
  OPENAI_TTS_RESPONSE_FORMATS,
  OPENAI_TTS_VOICE_MAP,
  encodeOpenAiTranscriptionResponse,
  encodeOpenAiSpeechResponse,
  listOpenAiTtsVoices,
  resolveOpenAiVoice,
  resolveSpeechResponseFormat,
  resolveTranscriptionResponseFormat,
  toOpenAiSegments,
} from '../providers/deepseek/audio-openai-face.js';
import {
  DEEPSEEK_AUDIO_MODELS,
  deepseekAudioCapabilities,
  resolveAudioModel,
} from '../providers/deepseek/audio-models.js';
import { InMemoryCapabilityRegistry } from '../credentials/capability-registry.js';
import { DefaultAliasResolver, defaultAliasRules } from '../admin/aliases.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'audio-endpoints-test-passphrase';
const FAKE_KEY = 'sk-fake-deepseek-not-real';
const ACCESS_TOKEN = 'audio-test-access-token-not-real';

/** 上游 TTS 音频（ASCII 假字节：ScriptedTransport 的 body 是字符串，别掺非 ASCII）。 */
const FAKE_WAV = 'RIFF____WAVEfmt fake-audio-bytes';
const FAKE_ASR = JSON.stringify({ request_id: 'asr_fake', text: '转写文本', duration_ms: 12_500 });

// ---------------------------------------------------------------------------
// 1. 纯函数：voice 映射 / response_format 矩阵 / 响应编码
// ---------------------------------------------------------------------------

describe('OpenAI 脸 · voice 映射', () => {
  it('OpenAI 嗓音名 → DeepSeek voice_id（按官方描述的性别就近映射）', () => {
    expect(resolveOpenAiVoice('nova')).toBe('stella');
    expect(resolveOpenAiVoice('onyx')).toBe('tide');
    // 大小写不敏感（客户端从文档抄名字时大小写经常漂）
    expect(resolveOpenAiVoice('Nova')).toBe('stella');
    // DeepSeek 原生 voice_id 直通（逃生门）
    expect(resolveOpenAiVoice('stella')).toBe('stella');
    expect(resolveOpenAiVoice('tide')).toBe('tide');
  });

  it('未映射的 voice → 明确错误，并列出全部可用名', () => {
    expect(() => resolveOpenAiVoice('marin')).toThrow(/voice marin 未映射/);
    expect(() => resolveOpenAiVoice('marin')).toThrow(/alloy/);
    expect(() => resolveOpenAiVoice('')).toThrow(/缺少字段 voice/);
  });

  it('映射表可查：每个 OpenAI 嗓音都落到 DeepSeek 的两个 voice_id 之一', () => {
    const rows = listOpenAiTtsVoices();
    expect(rows.length).toBeGreaterThanOrEqual(11);
    for (const row of rows) {
      expect(['stella', 'tide']).toContain(row.deepseek);
    }
    // 女声/男声都有人用：不然映射表退化成"全是同一个音色"
    expect(new Set(rows.map((r) => r.deepseek)).size).toBe(2);
  });
});

describe('OpenAI 脸 · response_format 矩阵', () => {
  it('wav / pcm 透传；mp3 / opus / aac / flac 明确拒绝（不静默转码）', () => {
    expect(resolveSpeechResponseFormat('wav')).toBe('wav');
    expect(resolveSpeechResponseFormat('pcm')).toBe('pcm');
    for (const bad of ['mp3', 'opus', 'aac', 'flac']) {
      expect(() => resolveSpeechResponseFormat(bad)).toThrow(/只输出 wav\/pcm/);
      expect(OPENAI_TTS_RESPONSE_FORMATS[bad]).toBeNull();
    }
  });

  it('省略时回落 wav（OpenAI 本家默认 mp3，我们给不了）', () => {
    expect(resolveSpeechResponseFormat(undefined)).toBe('wav');
  });

  it('完全不像格式值的串 → 另一个错误（列全合法值）', () => {
    expect(() => resolveSpeechResponseFormat('ogg')).toThrow(/不是 OpenAI 的合法值/);
  });

  it('转写侧：json / text / verbose_json 支持，srt / vtt 明确拒绝', () => {
    expect(resolveTranscriptionResponseFormat(undefined)).toBe('json');
    expect(resolveTranscriptionResponseFormat('text')).toBe('text');
    expect(resolveTranscriptionResponseFormat('verbose_json')).toBe('verbose_json');
    expect(() => resolveTranscriptionResponseFormat('srt')).toThrow(/不产出时间轴字幕/);
    expect(() => resolveTranscriptionResponseFormat('vtt')).toThrow(/不产出时间轴字幕/);
  });
});

describe('OpenAI 脸 · 响应编码', () => {
  it('speech：音频二进制 + 按请求 format 定的 Content-Type', () => {
    const audio = Buffer.from(FAKE_WAV, 'utf8');
    const res = encodeOpenAiSpeechResponse(
      {
        endpoint: 'tts',
        audio_base64: audio.toString('base64'),
        content_type: 'audio/wav',
        usage: { units: {}, source: 'provider' },
        raw: {},
      },
      'wav',
    );
    expect(res.content_type).toBe('audio/wav');
    expect(res.body.equals(audio)).toBe(true);
    expect(
      encodeOpenAiSpeechResponse(
        {
          endpoint: 'tts',
          audio_base64: '',
          content_type: '',
          usage: { units: {}, source: 'provider' },
          raw: {},
        },
        'pcm',
      ).content_type,
    ).toBe('audio/pcm');
  });

  it('transcription json → {text}；text → 纯文本', () => {
    const base = {
      endpoint: 'asr' as const,
      text: '你好',
      duration_seconds: 1.5,
      usage: { units: {}, source: 'provider' as const },
      raw: {},
    };
    const json = encodeOpenAiTranscriptionResponse(base, 'json');
    expect(JSON.parse(json.body)).toEqual({ text: '你好' });
    const text = encodeOpenAiTranscriptionResponse(base, 'text');
    expect(text.content_type).toBe('text/plain; charset=utf-8');
    expect(text.body).toBe('你好');
  });

  it('verbose_json → task / duration / text / segments（上游不给分段时是空数组）', () => {
    const res = encodeOpenAiTranscriptionResponse(
      {
        endpoint: 'asr',
        text: '你好',
        duration_seconds: 12.5,
        usage: { units: {}, source: 'provider' },
        raw: {},
      },
      'verbose_json',
    );
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toMatchObject({ task: 'transcribe', duration: 12.5, text: '你好', segments: [] });
    // language 省略：上游自动检测语种且不回传，回显客户端传的值等于谎称"我们检测到了"
    expect('language' in body).toBe(false);
  });

  it('上游给了分段时才填 segments（起止时间 + 置信度，不编 avg_logprob）', () => {
    const segments = toOpenAiSegments({
      segments: [
        { id: 0, start: 0, end: 1.25, text: '第一段', confidence: 0.93 },
        { start: 1.25, end: 2.5, text: '第二段' },
        // 缺 start 的分片被跳过，而不是填 0（0 是合法的起止时间，填了就说谎）
        { end: 3, text: '残缺' },
      ],
    });
    expect(segments).toEqual([
      { id: 0, start: 0, end: 1.25, text: '第一段', confidence: 0.93 },
      { id: 1, start: 1.25, end: 2.5, text: '第二段' },
    ]);
    expect(toOpenAiSegments({})).toEqual([]);
    expect(toOpenAiSegments(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 模型解析（走既有路由/能力矩阵，含 namespace 生效名）
// ---------------------------------------------------------------------------

describe('音频模型解析', () => {
  function deps() {
    const registry = new InMemoryCapabilityRegistry();
    for (const entry of deepseekAudioCapabilities()) registry.register(entry);
    return { capabilities: registry };
  }

  it('OpenAI 客户端模型名 → 网关模型名（tts-1 / whisper-1 零修改可用）', () => {
    expect(resolveAudioModel(deps(), 'tts-1', 'tts')).toMatchObject({
      access_path: 'deepseek.tools.tts',
      model: 'deepseek-tts',
      source: 'openai-alias',
    });
    expect(resolveAudioModel(deps(), 'whisper-1', 'asr')).toMatchObject({
      access_path: 'deepseek.tools.asr',
      model: 'deepseek-asr',
    });
  });

  it('网关模型名 passthrough（能力矩阵里真有这个 (access_path, model, modality)）', () => {
    expect(resolveAudioModel(deps(), 'deepseek-tts', 'tts')).toMatchObject({
      source: 'matrix',
      model: 'deepseek-tts',
    });
  });

  it('跨端点不串：tts 的模型名去打 asr → 解析不到', () => {
    expect(() => resolveAudioModel(deps(), 'deepseek-tts', 'asr')).toThrow(/解析不到/);
    expect(() => resolveAudioModel(deps(), 'tts-1', 'asr')).toThrow(/解析不到/);
  });

  it('完全未知的模型 → 400 级错误，并列全本端点可用的名字', () => {
    expect(() => resolveAudioModel(deps(), 'tts-9', 'tts')).toThrow(
      /模型 tts-9 解析不到：本端点可用 deepseek-tts \/ tts-1 \/ tts-1-hd \/ gpt-4o-mini-tts/,
    );
    expect(() => resolveAudioModel(deps(), '  ', 'tts')).toThrow(/缺少字段 model/);
  });

  it('namespace 生效名：<ns>/deepseek-tts 走管理面同一条解析链', () => {
    const registry = deps().capabilities;
    const aliasResolver = new DefaultAliasResolver(defaultAliasRules(), {
      list: (modality) =>
        registry.list(modality).map((e) => ({ access_path: e.access_path, model: e.model })),
    });
    // 管理面在 provider 保存时派生 namespace 规则（admin/service.ts）
    aliasResolver.setNamespaces([
      {
        namespace: 'ds',
        provider: 'deepseek',
        access_paths: ['deepseek.openai-chat', 'deepseek.tools.tts', 'deepseek.tools.asr'],
        enabled: true,
      },
    ]);
    const withNs = { capabilities: registry, aliasResolver };
    expect(resolveAudioModel(withNs, 'ds/deepseek-tts', 'tts')).toMatchObject({
      source: 'namespace',
      access_path: 'deepseek.tools.tts',
      model: 'deepseek-tts',
    });
    // namespace 前缀对、但模型不在这个端点上 → 仍然拒（不静默改打别的端点）
    expect(() => resolveAudioModel(withNs, 'ds/deepseek-flash', 'tts')).toThrow(/解析不到/);
    // 未配置的 namespace 前缀 → 解析不到
    expect(() => resolveAudioModel(withNs, 'zz/deepseek-tts', 'tts')).toThrow(/解析不到/);
  });

  it('显式别名指向别的 access path 时不串端点', () => {
    const registry = deps().capabilities;
    const aliasResolver = new DefaultAliasResolver(
      [
        {
          id: 'test:tts-alias',
          kind: 'exact',
          pattern: 'my-tts',
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.tools.tts',
            model: 'deepseek-tts',
          },
          priority: 100,
          enabled: true,
        },
        {
          id: 'test:chat-alias',
          kind: 'exact',
          pattern: 'my-chat',
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-flash',
          },
          priority: 100,
          enabled: true,
        },
      ],
      {
        list: (modality) =>
          registry.list(modality).map((e) => ({ access_path: e.access_path, model: e.model })),
      },
    );
    expect(
      resolveAudioModel({ capabilities: registry, aliasResolver }, 'my-tts', 'tts'),
    ).toMatchObject({ source: 'exact', model: 'deepseek-tts' });
    expect(() =>
      resolveAudioModel({ capabilities: registry, aliasResolver }, 'my-chat', 'tts'),
    ).toThrow(/解析不到/);
  });

  it('音频能力条目：两条，implemented + contract_tested，流式明确为 none', () => {
    const entries = deepseekAudioCapabilities();
    expect(entries.map((e) => e.model)).toEqual(['deepseek-tts', 'deepseek-asr']);
    for (const e of entries) {
      expect(e.status).toBe('implemented');
      expect(e.contract_tested).toBe(true);
      expect(e.streaming?.mode).toBe('none');
      expect(e.access_path.startsWith('deepseek.tools.')).toBe(true);
    }
    expect(DEEPSEEK_AUDIO_MODELS).toEqual({ tts: 'deepseek-tts', asr: 'deepseek-asr' });
    expect(OPENAI_TTS_VOICE_MAP['alloy']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP round-trip
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
    audio: gateway.audioEndpoints,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, gateway, sink, transport };
}

async function close(h: HttpHarness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await h.gateway.shutdown();
}

async function recordsOf(h: HttpHarness) {
  await h.gateway.usageEmitter.flush();
  return h.sink.records;
}

/** 拼一个 multipart 转写请求（自己写编码器：被解析的字节必须完全可控）。 */
function transcriptionForm(
  fields: Record<string, string>,
  options: { audio?: string; withFile?: boolean } = {},
): { body: Buffer; contentType: string } {
  const audio = options.audio ?? 'RIFF____WAVEfmt ';
  const withFile = options.withFile ?? true;
  const boundary = '----AudioEndpointTestBoundary';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  if (withFile) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`,
        'utf8',
      ),
    );
    parts.push(Buffer.from(audio, 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function speechBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'deepseek-tts', input: '你好世界', voice: 'nova', ...extra };
}

describe('POST /v1/audio/speech', () => {
  it('200 + 音频二进制（Content-Type / Content-Length 与请求的 format 一致）', async () => {
    const harness = await httpHarness([
      { headers: { 'content-type': 'audio/wav' }, body: FAKE_WAV },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(FAKE_WAV)));
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe(FAKE_WAV);
    // 上游收到的是 canonical wire 形状（voice_id / format），不是 OpenAI 的 voice
    const wire = JSON.parse(
      harness.transport.requests[0]!.body?.toString('utf8') ?? '{}',
    ) as Record<string, unknown>;
    expect(wire).toMatchObject({ text: '你好世界', voice_id: 'stella', format: 'wav' });
    await close(harness);
  });

  it('pcm 格式 → audio/pcm', async () => {
    const harness = await httpHarness([
      { headers: { 'content-type': 'audio/pcm' }, body: FAKE_WAV },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody({ response_format: 'pcm' })),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/pcm');
    await close(harness);
  });

  it('不支持的 response_format → 400 + 可操作错误（不静默转成 wav）', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }]);
    for (const format of ['mp3', 'opus', 'aac', 'flac']) {
      const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(speechBody({ response_format: format })),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string; type: string } };
      expect(body.error.code).toBe('unsupported_response_format');
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toContain('只输出 wav/pcm');
    }
    // 一次上游都没打（拒绝发生在打之前）
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('voice 未映射 → 400 + 列出可用名', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody({ voice: 'marin' })),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unmapped_voice');
    expect(body.error.message).toMatch(/voice marin 未映射：可用/);
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('上游没有的参数（speed ≠ 1）→ 400，不静默丢弃', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody({ speed: 1.5 })),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_parameter',
    );
    // speed = 1 是上游默认值，收了不改变语义
    const ok = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody({ speed: 1 })),
    });
    expect(ok.status).toBe(200);
    await close(harness);
  });

  it('缺 voice / 缺 input → 400（OpenAI 这两个字段是必填）', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }]);
    const noVoice = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-tts', input: 'hi' }),
    });
    expect(noVoice.status).toBe(400);
    expect(((await noVoice.json()) as { error: { code: string } }).error.code).toBe(
      'missing_voice',
    );
    const noInput = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-tts', voice: 'nova' }),
    });
    expect(((await noInput.json()) as { error: { code: string } }).error.code).toBe(
      'missing_input',
    );
    await close(harness);
  });

  it('模型解析失败 → 400 model_not_found + 一句话列可用名', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody({ model: 'tts-9' })),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('deepseek-tts');
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('OpenAI 客户端模型名 tts-1 直接可用（别名档）', async () => {
    const harness = await httpHarness([
      { headers: { 'content-type': 'audio/wav' }, body: FAKE_WAV },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: 'hi', voice: 'alloy' }),
    });
    expect(res.status).toBe(200);
    const records = await recordsOf(harness);
    expect(records[0]!.model).toBe('deepseek-tts');
    expect(records[0]!.model_alias).toBe('tts-1');
    await close(harness);
  });

  it('坏 JSON → 400 invalid_json；非 JSON 的 Content-Type → 415', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }]);
    const bad = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_json');

    const wrongType = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(wrongType.status).toBe(415);
    expect(((await wrongType.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_media_type',
    );

    // 合法 JSON 但不是对象（数组）：报"体形状不对"，不要报成"缺 model 字段"
    const array = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[1,2]',
    });
    expect(array.status).toBe(400);
    expect(((await array.json()) as { error: { message: string } }).error.message).toBe(
      '请求体必须是 JSON 对象',
    );
    await close(harness);
  });

  it('计费：按字符（CJK 每字 2），access_path 与 client_format 是音频口径', async () => {
    const harness = await httpHarness([
      { headers: { 'content-type': 'audio/wav' }, body: FAKE_WAV },
    ]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody()),
    });
    expect(res.status).toBe(200);
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.access_path).toBe('deepseek.tools.tts');
    expect(rec.provider).toBe('deepseek');
    expect(rec.client_format).toBe('openai.audio.speech');
    // 4 个汉字 × 2 = 8（与 canonical /v1/tools/tts 同一口径）
    expect(rec.usage.units).toEqual({ characters: { input: 8, billed: 8 } });
    // DeepSeek pricing.json 的 tools 段（tts_per_10000_characters）现已接进通用合成价表，
    // 所以 TTS 调用实时计价并返回 priced（currency = USD）。
    expect(rec.cost.status).toBe('priced');
    expect(rec.cost.cash.builtin_tools).toBeGreaterThan(0);
    await close(harness);
  });

  it('上游 429 → 429 + rate_limited（失败也记用量）', async () => {
    const harness = await httpHarness([{ status: 429, body: 'slow down' }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody()),
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('error');
    await close(harness);
  });

  it('GET → 405；未登录 → 401 且不打上游', async () => {
    const harness = await httpHarness([{ body: FAKE_WAV }], { accessToken: ACCESS_TOKEN });
    const get = await fetch(`${harness.baseUrl}/v1/audio/speech`);
    expect(get.status).toBe(405);

    const anon = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(speechBody()),
    });
    expect(anon.status).toBe(401);
    const anonBody = (await anon.json()) as { error: { type: string; message: string } };
    expect(anonBody.error.type).toBe('authentication_error');
    // 错误信息不回显调用方给的串（那把串可能就是 key）
    expect(JSON.stringify(anonBody)).not.toContain(ACCESS_TOKEN);
    expect(harness.transport.requests).toHaveLength(0);

    const ok = await fetch(`${harness.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_TOKEN}` },
      body: JSON.stringify(speechBody()),
    });
    expect(ok.status).toBe(200);
    await close(harness);
  });
});

describe('POST /v1/audio/transcriptions', () => {
  it('multipart file → 200 json {text}，上游收到的是 multipart 音频', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const form = transcriptionForm({ model: 'deepseek-asr' });
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '转写文本' });
    const upstream = harness.transport.requests[0]!;
    expect(upstream.path).toBe('/v1/tools/asr');
    expect(upstream.headers['content-type']).toContain('multipart/form-data');
    // 文件内容能解回原文（一个字节都没被分隔符扫描啃掉）
    const sent = upstream.body?.toString('latin1') ?? '';
    expect(sent).toContain('RIFF____WAVEfmt ');
    expect(sent).toContain('filename="clip.wav"');
    await close(harness);
  });

  it('response_format=text → 纯文本；verbose_json → 分段字段齐全', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }, { body: FAKE_ASR }]);
    const text = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'content-type': transcriptionForm({ model: 'whisper-1', response_format: 'text' })
          .contentType,
      },
      body: transcriptionForm({ model: 'whisper-1', response_format: 'text' }).body,
    });
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('转写文本');

    const verbose = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'content-type': transcriptionForm({ model: 'whisper-1', response_format: 'verbose_json' })
          .contentType,
      },
      body: transcriptionForm({ model: 'whisper-1', response_format: 'verbose_json' }).body,
    });
    const body = (await verbose.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      task: 'transcribe',
      duration: 12.5,
      text: '转写文本',
      segments: [],
    });
    await close(harness);
  });

  it('language / prompt 收下并转 canonical（上游 wire 只有 file，到不了上游）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const form = transcriptionForm({
      model: 'deepseek-asr',
      language: 'zh',
      prompt: '领域词：AgentGateway',
    });
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(200);
    // 上游只收到 file 一个字段（文档口径：多传可能被拒）
    const sent = harness.transport.requests[0]!.body?.toString('latin1') ?? '';
    expect(sent).not.toContain('name="language"');
    expect(sent).not.toContain('name="prompt"');
    await close(harness);
  });

  it('multipart 缺 file → 400 missing_file', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const form = transcriptionForm({ model: 'deepseek-asr' }, { withFile: false });
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string; message: string } };
    expect(err.error.code).toBe('missing_file');
    expect(err.error.message).toContain('file');
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('超大文件 → 400 part_too_large（不打上游）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    // 32 MiB + 1 字节：超过网关文件上传限额，也超过解析器的 max_file_bytes
    const form = transcriptionForm(
      { model: 'deepseek-asr' },
      { audio: 'x'.repeat(32 * 1024 * 1024 + 1) },
    );
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('part_too_large');
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('整个请求体超上限 → 413 payload_too_large', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    // 文件本身合规，但把无关字段撑到超过 32 MiB + 64 KiB 的体上限
    const form = transcriptionForm(
      { model: 'deepseek-asr', junk: 'y'.repeat(33 * 1024 * 1024) },
      { audio: 'RIFF' },
    );
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'payload_too_large',
    );
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('JSON 体打转写端点 → 415（这个端点只要 multipart）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-asr' }),
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_media_type',
    );
    await close(harness);
  });

  it('模型解析失败 / temperature ≠ 0 / srt → 400（各自一个 code）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const noModel = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': transcriptionForm({ model: 'whisper-9' }).contentType },
      body: transcriptionForm({ model: 'whisper-9' }).body,
    });
    expect(((await noModel.json()) as { error: { code: string } }).error.code).toBe(
      'model_not_found',
    );

    const hot = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'content-type': transcriptionForm({ model: 'whisper-1', temperature: '0.4' }).contentType,
      },
      body: transcriptionForm({ model: 'whisper-1', temperature: '0.4' }).body,
    });
    expect(((await hot.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_parameter',
    );

    const srt = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'content-type': transcriptionForm({ model: 'whisper-1', response_format: 'srt' })
          .contentType,
      },
      body: transcriptionForm({ model: 'whisper-1', response_format: 'srt' }).body,
    });
    expect(((await srt.json()) as { error: { code: string } }).error.code).toBe(
      'unsupported_response_format',
    );
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('计费：按音频秒（duration_ms 是唯一依据），access_path 是 asr 口径', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const form = transcriptionForm({ model: 'deepseek-asr' });
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(200);
    const records = await recordsOf(harness);
    expect(records).toHaveLength(1);
    expect(records[0]!.access_path).toBe('deepseek.tools.asr');
    expect(records[0]!.client_format).toBe('openai.audio.transcription');
    expect(records[0]!.model).toBe('deepseek-asr');
    expect(records[0]!.usage.units).toEqual({ audio_seconds: { input: 12.5, billed: 12.5 } });
    await close(harness);
  });

  it('上游 5xx → 502 upstream_error（不裸抛栈）', async () => {
    const harness = await httpHarness([{ status: 500, body: 'boom' }]);
    const form = transcriptionForm({ model: 'deepseek-asr' });
    const res = await fetch(`${harness.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.type).toBe('server_error');
    expect(body.error.message).not.toContain('boom');
    await close(harness);
  });
});

describe('/v1/audio/translations 与未知路由', () => {
  it('translations → 501 + translations_not_supported（不假装支持）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'whisper-1', file: 'x' }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe('translations_not_supported');
    expect(body.error.type).toBe('not_implemented');
    expect(body.error.message).toContain('不支持翻译');
    // 从不打上游
    expect(harness.transport.requests).toHaveLength(0);
    await close(harness);
  });

  it('translations 未登录也先 401（不给未认证方端点能力清单）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }], { accessToken: ACCESS_TOKEN });
    const res = await fetch(`${harness.baseUrl}/v1/audio/translations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'whisper-1' }),
    });
    expect(res.status).toBe(401);
    await close(harness);
  });

  it('list() 三个路由 × 两家上游一条不少，translations 标 supported:false', () => {
    const harnessReady = createGateway({ mode: 'test' });
    const list = harnessReady.audioEndpoints.list();
    // 多上游（2026-11 接 MiMo）：每个路由一行一家，顺序 = providers 数组顺序
    // （DeepSeek 在前、MiMo 在后）
    expect(list.map((r) => r.path)).toEqual([
      '/v1/audio/speech',
      '/v1/audio/speech',
      '/v1/audio/transcriptions',
      '/v1/audio/transcriptions',
      '/v1/audio/translations',
      '/v1/audio/translations',
    ]);
    expect(list.filter((r) => r.id === 'translations').every((r) => r.supported === false)).toBe(
      true,
    );
    expect(list.filter((r) => r.id !== 'translations').every((r) => r.supported === true)).toBe(
      true,
    );
    expect(list.map((r) => r.provider)).toEqual([
      'deepseek',
      'mimo',
      'deepseek',
      'mimo',
      'deepseek',
      'mimo',
    ]);
    expect(list.find((r) => r.id === 'speech')?.access_path).toBe('deepseek.tools.tts');
    expect(list.find((r) => r.provider === 'mimo' && r.id === 'speech')?.access_path).toBe(
      'mimo.tools.tts',
    );
    expect(list.find((r) => r.provider === 'mimo' && r.id === 'transcriptions')?.access_path).toBe(
      'mimo.tools.asr',
    );
    void harnessReady.shutdown();
  });

  it('`/v1/audio/unknown` → 404（不归这三个路由管，也不静默 200）', async () => {
    const harness = await httpHarness([{ body: FAKE_ASR }]);
    const res = await fetch(`${harness.baseUrl}/v1/audio/unknown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    await close(harness);
  });
});
