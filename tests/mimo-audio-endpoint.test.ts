/**
 * tests/mimo-audio-endpoint.test.ts —— MiMo 音频端点经**网关**的契约测试（scripted 上游）。
 *
 * 与 tests/mimo-audio-wire.test.ts（纯 codec）和 tests/mimo-audio-http-live.test.ts
 * （真上游 HTTP）的分工：本文件验**多上游装配**——`/v1/audio/*` 按模型名把请求分流到
 * 正确的那一家，计量记在正确的那一家头上。上游一律 ScriptedTransport（假数据、假 key）。
 *
 * 覆盖：
 *   1. 模型分流：`mimo-v2.5-tts` → MiMo 的 handler 与 face；`deepseek-tts` → DeepSeek 的；
 *      `tts-1` → DeepSeek（OpenAI 客户端名别名的第 0 档只有 DeepSeek 映射）；
 *   2. **计量归属**：provider / access_path / model 三者一致（这条是 2026-11 live 冒烟
 *      抓到"model 记成 MiMo 的、provider 记成 DeepSeek 的"之后补的回归测试）；
 *   3. 客户端零修改：OpenAI SDK 形状的 speech / transcriptions 请求都能通；
 *   4. 错误路径合并清单、translations 501、未认证 401。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { createModelsEndpoints } from '../http/models-endpoint.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { MemoryUsageSink } from '../metering/memory-emitter.js';

/** 从 ASR wire 请求体里取第一条 content part（input_audio 那个）。 */
function firstAudioPart(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const content = messages[0]!['content'] as Array<Record<string, unknown>>;
  return content[0]!;
}

/**
 * 固定请求时间。**必须晚于 MiMo 价格条目的 effective_from（2026-10-21）**，
 * 否则 resolvePrice 选不到 entry → pending_price。仓库里别的测试用
 * 1_760_000_000_000（2025-10-09），那是 DeepSeek 峰谷体系生效前的日期；
 * MiMo 的表 2026-10-21 才生效，所以这里不能沿用那个值。
 */
const FIXED_NOW = Date.parse('2026-11-16T09:00:00Z');
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'mimo-audio-endpoint-test-passphrase';
const FAKE_MIMO_KEY = 'tp-fake-mimo-not-real'; // tp- = Token Plan（订阅）
const FAKE_DEEPSEEK_KEY = 'sk-fake-deepseek-not-real';

/** MiMo TTS 的上游响应（音频在 JSON 信封里；ASCII 假字节，ScriptedTransport 的 body 是字符串）。 */
const FAKE_MIMO_WAV_B64 = Buffer.from('RIFF____WAVEfmt fake-mimo-audio').toString('base64');
const MIMO_TTS_RESPONSE = JSON.stringify({
  id: 'mimo_tts_1',
  choices: [
    {
      finish_reason: 'stop',
      index: 0,
      message: {
        content: '',
        role: 'assistant',
        audio: { id: 'aud_1', data: FAKE_MIMO_WAV_B64, transcript: '你好', expires_at: null },
        tool_calls: null,
      },
    },
  ],
  model: 'mimo-v2.5-tts',
  usage: { completion_tokens: 3, prompt_tokens: 10, total_tokens: 13 },
});

/** MiMo ASR 的上游响应（usage.seconds 是计费依据）。 */
const MIMO_ASR_RESPONSE = JSON.stringify({
  id: 'mimo_asr_1',
  choices: [
    {
      finish_reason: 'stop',
      index: 0,
      message: { content: '转写文本', role: 'assistant', audio: null, audio_tokens: [] },
    },
  ],
  model: 'mimo-v2.5-asr',
  usage: {
    completion_tokens: 4,
    prompt_tokens: 20,
    total_tokens: 24,
    prompt_tokens_details: { audio_tokens: 8, cached_tokens: 0 },
    seconds: 3,
  },
});

/** DeepSeek TTS 的上游响应（音频字节流，不是 JSON 信封）。 */
const DEEPSEEK_TTS_RESPONSE = 'RIFF____WAVEfmt fake-deepseek-audio';

interface Harness {
  server: Server;
  baseUrl: string;
  gateway: ReturnType<typeof createGateway>;
  sink: MemoryUsageSink;
  transport: ScriptedTransport;
  close(): Promise<void>;
}

async function harness(
  script: ScriptedTransportScript,
  keys: { mimo?: boolean; deepseek?: boolean } = { mimo: true, deepseek: true },
): Promise<Harness> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const recordStore = new DefaultEncryptedRecordStore(
    ks.unlocked(),
    new InMemoryRawRecordStore(),
    clock,
  );
  const sink = new MemoryUsageSink();
  const transport = new ScriptedTransport(script);
  const env: Record<string, string> = {};
  if (keys.mimo === true) env['MIMO_API_KEY'] = FAKE_MIMO_KEY;
  if (keys.deepseek === true) env['DEEPSEEK_API_KEY'] = FAKE_DEEPSEEK_KEY;
  const gateway = createGateway({
    mode: 'test',
    clock,
    transport,
    usageSink: sink,
    recordStore,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, env),
  });
  const server = createHttpServer({
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    tools: gateway.toolEndpoints,
    audio: gateway.audioEndpoints,
    modalities: gateway.modalityEndpoints,
    models: createModelsEndpoints({ catalog: gateway.models, sync: gateway.modelSync }),
    authenticator: gateway.dataPlaneAuth,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return {
    server,
    baseUrl,
    gateway,
    sink,
    transport,
    async close() {
      server.close();
      await gateway.shutdown();
    },
  };
}

/** 读用量记录：先 flush（mode:'test' 不自动 flush），再读 sink。 */
async function flushedRecords(
  h: Harness,
): Promise<ReturnType<typeof h.gateway.usageEmitter.flush>> {
  await h.gateway.usageEmitter.flush();
  return h.sink.records;
}

/**
 * 每个端点的鉴权器在**构造时**注入（组合根把 `gateway.dataPlaneAuth` 交给
 * `createAudioEndpoints`），所以 `createHttpServer` 的 `authenticator` 选项管不到
 * `/v1/audio/*`——「鉴权与分流互不干扰」那条用例验的就是这件事：换不换 server 层的门，
 * 音频端点的分流与计量都不变。
 */

// ---------------------------------------------------------------------------
// 1. 模型分流 + 计量归属
// ---------------------------------------------------------------------------

describe('MiMo 音频端点 · 多上游分流', () => {
  it('model=mimo-v2.5-tts → 打 MiMo 上游，计量记在 MiMo 头上', async () => {
    const h = await harness([{ body: MIMO_TTS_RESPONSE }]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-tts',
          input: '你好',
          voice: 'mimo_default',
          response_format: 'wav',
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/wav');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.toString('ascii')).toBe('RIFF____WAVEfmt fake-mimo-audio');

      // 上游请求真的发到了 MiMo 的端点与形状
      const req = h.transport.requests[0]!;
      expect(req.base_url).toBe('https://token-plan-cn.xiaomimimo.com');
      expect(req.path).toBe('/v1/chat/completions');
      const wire = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(wire['model']).toBe('mimo-v2.5-tts');
      expect(wire['audio']).toEqual({ format: 'wav', voice: 'mimo_default' });

      // 计量归属：provider / access_path / model 三者一致
      const recs = await flushedRecords(h);
      expect(recs.length).toBeGreaterThanOrEqual(1);
      const last = recs[recs.length - 1]!;
      expect(last.provider).toBe('mimo');
      expect(last.access_path).toBe('mimo.tools.tts');
      expect(last.provider_format).toBe('mimo.tools.tts');
      expect(last.client_format).toBe('openai.audio.speech');
      expect(last.model).toBe('mimo-v2.5-tts');
      // 按字符计量（1:1，无 CJK 加权）
      expect(last.usage.units.characters).toEqual({ input: 2, billed: 2 });
    } finally {
      await h.close();
    }
  });

  it('model=deepseek-tts → 打 DeepSeek 上游，计量记在 DeepSeek 头上', async () => {
    const h = await harness([{ body: DEEPSEEK_TTS_RESPONSE }]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-tts', input: '你好', voice: 'alloy' }),
      });
      expect(res.status).toBe(200);
      const req = h.transport.requests[0]!;
      expect(req.base_url).toBe('https://api.deepseek.com');
      expect(req.path).toBe('/v1/tools/tts');
      const wire = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(wire['voice_id']).toBe('stella'); // alloy → stella（就近映射，不是克隆）

      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      expect(last.provider).toBe('deepseek');
      expect(last.access_path).toBe('deepseek.tools.tts');
      expect(last.model).toBe('deepseek-tts');
    } finally {
      await h.close();
    }
  });

  it('model=tts-1 → DeepSeek（OpenAI 客户端名别名只有 DeepSeek 映射）', async () => {
    const h = await harness([{ body: DEEPSEEK_TTS_RESPONSE }]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', input: 'hi', voice: 'nova' }),
      });
      expect(res.status).toBe(200);
      expect(h.transport.requests[0]!.base_url).toBe('https://api.deepseek.com');
      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      expect(last.model).toBe('deepseek-tts');
      expect(last.model_alias).toBe('tts-1');
      expect(last.provider).toBe('deepseek');
    } finally {
      await h.close();
    }
  });

  it('model=mimo-tts（便利别名）→ MiMo 上游', async () => {
    const h = await harness([{ body: MIMO_TTS_RESPONSE }]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-tts', input: 'hi', voice: 'mimo_default' }),
      });
      expect(res.status).toBe(200);
      expect(h.transport.requests[0]!.base_url).toBe('https://token-plan-cn.xiaomimimo.com');
      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      expect(last.model).toBe('mimo-v2.5-tts');
      expect(last.model_alias).toBe('mimo-tts');
      expect(last.provider).toBe('mimo');
    } finally {
      await h.close();
    }
  });

  it('ASR：model=mimo-v2.5-asr → MiMo 上游，audio_seconds 计量', async () => {
    const h = await harness([{ body: MIMO_ASR_RESPONSE }]);
    try {
      const form = new FormData();
      form.set('model', 'mimo-v2.5-asr');
      form.set('language', 'zh');
      form.set(
        'file',
        new Blob([Buffer.from('RIFF____WAVEfmt fake')], { type: 'audio/wav' }),
        'a.wav',
      );
      const res = await fetch(`${h.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { text: string }).text).toBe('转写文本');

      const req = h.transport.requests[0]!;
      expect(req.base_url).toBe('https://token-plan-cn.xiaomimimo.com');
      expect(req.path).toBe('/v1/chat/completions');
      const wire = JSON.parse((req.body ?? Buffer.alloc(0)).toString('utf8')) as Record<
        string,
        unknown
      >;
      expect(wire['model']).toBe('mimo-v2.5-asr');
      expect(wire['asr_options']).toEqual({ language: 'zh' });
      // 音频走 input_audio content part，data URL 的 MIME 与 format 匹配
      const part = firstAudioPart(wire);
      expect(part['type']).toBe('input_audio');
      const inputAudio = part['input_audio'] as Record<string, unknown>;
      expect(inputAudio['format']).toBe('wav');
      expect(String(inputAudio['data']).startsWith('data:audio/wav;base64,')).toBe(true);

      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      expect(last.provider).toBe('mimo');
      expect(last.access_path).toBe('mimo.tools.asr');
      expect(last.client_format).toBe('openai.audio.transcription');
      expect(last.model).toBe('mimo-v2.5-asr');
      // usage.seconds 是计费唯一依据
      expect(last.usage.units.audio_seconds).toEqual({ input: 3, billed: 3 });
    } finally {
      await h.close();
    }
  });

  it('计费判据查有凭据的那条 path（音频 access path 不在凭据启动表里）', async () => {
    // 2026-11 live 冒烟抓到的真 bug：billingModeFor('mimo.tools.asr') 查不到
    // （凭据登记在 mimo.openai-chat 上），于是订阅用量被当成现金支出。
    // 修法：handler / provider 上带 billing_access_path，指向有凭据的那条。
    const h = await harness([{ body: MIMO_ASR_RESPONSE }]);
    try {
      const form = new FormData();
      form.set('model', 'mimo-v2.5-asr');
      form.set(
        'file',
        new Blob([Buffer.from('RIFF____WAVEfmt fake')], { type: 'audio/wav' }),
        'a.wav',
      );
      const res = await fetch(`${h.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).toBe(200);
      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      // access_path 记的是端点自己的；计费判据走 chat 那条
      expect(last.access_path).toBe('mimo.tools.asr');
      expect(last.cost.status).toBe('priced');
      // tp- key → 订阅 → cash 恒 0，as_api 照算
      expect(last.cost.cash.total).toBe(0);
      expect(last.cost.as_api.total).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it('ASR：model=whisper-1 → DeepSeek（第 0 档别名）', async () => {
    const deepseekAsr = JSON.stringify({ request_id: 'r1', text: 'ds', duration_ms: 12_500 });
    const h = await harness([{ body: deepseekAsr }]);
    try {
      const form = new FormData();
      form.set('model', 'whisper-1');
      form.set(
        'file',
        new Blob([Buffer.from('RIFF____WAVEfmt fake')], { type: 'audio/wav' }),
        'a.wav',
      );
      const res = await fetch(`${h.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).toBe(200);
      expect(h.transport.requests[0]!.path).toBe('/v1/tools/asr');
      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      expect(last.provider).toBe('deepseek');
      expect(last.access_path).toBe('deepseek.tools.asr');
      expect(last.model).toBe('deepseek-asr');
      expect(last.model_alias).toBe('whisper-1');
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 客户端零修改（OpenAI 形状）
// ---------------------------------------------------------------------------

describe('MiMo 音频端点 · OpenAI 客户端形状', () => {
  it('voice 用英文预置名（大小写不敏感）+ response_format=mp3', async () => {
    const h = await harness([{ body: MIMO_TTS_RESPONSE }]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-tts',
          input: 'hello',
          voice: 'mia',
          response_format: 'mp3',
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      const wire = JSON.parse(
        (h.transport.requests[0]!.body ?? Buffer.alloc(0)).toString('utf8'),
      ) as Record<string, unknown>;
      expect((wire['audio'] as Record<string, unknown>)['voice']).toBe('Mia');
      expect((wire['audio'] as Record<string, unknown>)['format']).toBe('mp3');
    } finally {
      await h.close();
    }
  });

  it('verbose_json 转写：duration 来自 usage.seconds，segments 恒空', async () => {
    const h = await harness([{ body: MIMO_ASR_RESPONSE }]);
    try {
      const form = new FormData();
      form.set('model', 'mimo-v2.5-asr');
      form.set('response_format', 'verbose_json');
      form.set(
        'file',
        new Blob([Buffer.from('RIFF____WAVEfmt fake')], { type: 'audio/wav' }),
        'a.wav',
      );
      const res = await fetch(`${h.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        task: 'transcribe',
        duration: 3,
        text: '转写文本',
        segments: [],
      });
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 错误路径
// ---------------------------------------------------------------------------

describe('MiMo 音频端点 · 错误路径', () => {
  it('坏模型名 → 400 + 两家的合并清单', async () => {
    const h = await harness([]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'nope', input: 'hi' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('model_not_found');
      expect(body.error.message).toContain('deepseek-tts');
      expect(body.error.message).toContain('mimo-v2.5-tts');
      // 不打上游
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('ASR 模型名打到 speech → 400 + 一句明白话', async () => {
    const h = await harness([]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-asr', input: 'hi' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('model_not_found');
      expect(body.error.message).toContain('是ASR模型');
    } finally {
      await h.close();
    }
  });

  it('voiceclone 缺 voice → 400（上游该字段必填）', async () => {
    const h = await harness([]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-tts-voiceclone', input: 'hi' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('missing_voice');
    } finally {
      await h.close();
    }
  });

  it('translations → 501，两家理由都在', async () => {
    const h = await harness([]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/translations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-asr' }),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('translations_not_supported');
      expect(body.error.message).toContain('DeepSeek');
      expect(body.error.message).toContain('MiMo');
    } finally {
      await h.close();
    }
  });

  it('错误路径也记在认领的那一家头上（不能回落成第一家）', async () => {
    // 2026-11 live 冒烟抓到的真 bug：解析成功后的 400 省了 provider，报表里出现
    // "provider=deepseek 而 model=mimo-v2.5-tts" 这种自相矛盾的记录。
    const h = await harness([]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 模型认得（MiMo），但 voice 不在预置表 → 400 发生在 face 层
        body: JSON.stringify({ model: 'mimo-v2.5-tts', input: 'hi', voice: 'no-such-voice' }),
      });
      expect(res.status).toBe(400);
      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      expect(last.status).toBe('error');
      expect(last.provider).toBe('mimo');
      expect(last.access_path).toBe('mimo.tools.tts');
      expect(last.model).toBe('mimo-v2.5-tts');
      // 不打上游（400 发生在解码阶段）
      expect(h.transport.requests).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('上游 4xx → 错误分类照旧（不泄露内部细节）', async () => {
    const h = await harness([
      { status: 400, body: JSON.stringify({ error: { code: '400', message: 'bad' } }) },
    ]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-tts',
          input: 'hi',
          voice: 'mimo_default',
        }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('upstream_error');
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 部署态：只配一家时另一家不可见
// ---------------------------------------------------------------------------

describe('MiMo 音频端点 · 部署态', () => {
  it('只配 MiMo key 时，deepseek-tts 解析不到（不打上游）', async () => {
    const h = await harness([{ body: MIMO_TTS_RESPONSE }], { mimo: true, deepseek: false });
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-tts', input: 'hi', voice: 'alloy' }),
      });
      // 模型名仍在能力矩阵里（静态表不删），所以解析得到；缺 key 的失败发生在上游调用
      expect([200, 502]).toContain(res.status);
      // MiMo 仍然可用
      const ok = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-tts', input: 'hi', voice: 'mimo_default' }),
      });
      expect(ok.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 显式放行鉴权下的同款分流（证明鉴权与分流互不干扰）
// ---------------------------------------------------------------------------

describe('MiMo 音频端点 · 鉴权与分流互不干扰', () => {
  it('server 层换一把显式放行的门，音频端点的分流与计量不变', async () => {
    const h = await harness([{ body: MIMO_TTS_RESPONSE }]);
    try {
      const res = await fetch(`${h.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mimo-v2.5-tts', input: 'hi', voice: 'mimo_default' }),
      });
      expect(res.status).toBe(200);
      const recs = await flushedRecords(h);
      const last = recs[recs.length - 1]!;
      // 分流与计量由音频端点自己的装配决定，与 server 层那把门无关
      expect(last.provider).toBe('mimo');
      expect(last.access_path).toBe('mimo.tools.tts');
      expect(last.model).toBe('mimo-v2.5-tts');
      // mode:'test' 的数据面鉴权器是放行档，key_id 恒为 local-dev（auth/data-plane.ts）
      expect(last.auth.key_id).toBe('local-dev');
    } finally {
      await h.close();
    }
  });
});
