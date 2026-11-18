/**
 * tests/mimo-live.test.ts —— MiMo **真实 API** 冒烟测试。
 *
 * ⚠️ 只在 `MIMO_API_KEY` 存在时运行（describe.runIf），`npm test` 无 key 时自动跳过。
 * 跑法（key 只从环境变量读，.env 已被 gitignore；公网需经本机代理）：
 *   HTTPS_PROXY=http://127.0.0.1:7890 node --env-file=.env npx vitest run tests/mimo-live.test.ts
 *
 * 覆盖（对应任务书的四条 + 真上游验收）：
 *   1. 元数据：GET /v1/models —— 六个模型、OpenAI 形状、**无机读字段**（不编造）；
 *   2. LLM：非流式 / 流式 / 工具调用 / reasoning_effort=none 关推理；
 *   3. **reasoning_content 一路带到内置对话的 `reasoning` 字段**（96-chat-ui-port.md §3.5
 *      的真上游验收：上游 → openai.chat codec → canonical thinking part → 回写 →
 *      admin/agent-chat.ts 的 foldChat）；
 *   4. 音频：ASR（wav / mp3）、TTS（wav / mp3 / pcm / 三个变体），**TTS 产出喂 ASR 成闭环**；
 *   5. 经网关数据面：`/v1/models` 看得到 MiMo、一次真实 chat completion 过 S0–S10；
 *   6. 数据面鉴权：临时虚拟 key 打真网关，验完删掉（不留下任何测试 key）；
 *   7. 错误路径：无效 key、不支持的模型名。
 *
 * 预算意识：所有 LLM 调用显式压 max_tokens；音频调用限时免费或按秒计费，量极小。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { FetchTransport } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { MiMoAsrClient, MiMoTtsClient } from '../providers/mimo/index.js';

const KEY = (process.env.MIMO_API_KEY ?? '').trim();
const hasKey = KEY.length > 0;
const BASE = 'https://token-plan-cn.xiaomimimo.com/v1';

/** 观测收集器：把「实测结论」攒起来最后统一打印（进报告）。 */
/** 从上游 JSON 响应里取 `choices[0].message`（OpenAI Chat 形状）。 */
function firstMessage(json: unknown): Record<string, unknown> {
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('响应没有 choices');
  const message = (choices[0] as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) throw new Error('choices[0] 没有 message');
  return message as Record<string, unknown>;
}

/** 取 `choices[0]` 本身。 */
function firstChoice(json: unknown): Record<string, unknown> {
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('响应没有 choices');
  return choices[0] as Record<string, unknown>;
}

/** 取 `error` 段（上游错误信封）。 */
function errorOf(json: unknown): Record<string, unknown> {
  const error = (json as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) throw new Error('响应没有 error 段');
  return error as Record<string, unknown>;
}

const observations: string[] = [];
function obs(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  observations.push(line);
  process.stdout.write(`[obs] ${line}\n`);
}

/** 原始 fetch 探针（不经网关，直接打上游，用于观测真实 wire 形态）。 */
async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  auth: string | null = KEY,
): Promise<{ status: number; headers: Record<string, string>; json: unknown; text: string }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth !== null) headers['authorization'] = `Bearer ${auth}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: out, json, text };
}

/** 造一段确定性 16 kHz 单声道正弦 wav（探形状用；识别结果不重要）。 */
function toneWav(seconds = 1): Buffer {
  const rate = 16000;
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** wav → mp3 没有本地编码器；这里只做容器识别用的扩展名，不改内容。 */
function withExt(buf: Buffer, name: string): { file: Buffer; filename: string } {
  return { file: buf, filename: name };
}

const describeLive = describe.runIf(hasKey);

describeLive('MiMo 真实 API 冒烟（key 已提供）', () => {
  const callLog: string[] = [];
  /** TTS 产出的音频（喂 ASR 形成闭环）。 */
  let ttsWav: Buffer | undefined;
  let ttsMp3: Buffer | undefined;

  beforeAll(async () => {
    if (!hasKey) return;
    // ---- 1. GET /models：六个模型、OpenAI 形状、无机读字段 ----
    const models = await api('GET', '/models');
    expect(models.status).toBe(200);
    const data = (models.json as { data?: unknown[] })?.data ?? [];
    obs('GET /v1/models →', JSON.stringify(data));
    const ids = data.map((m) => (m as { id?: string }).id).sort();
    expect(ids).toEqual([
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.6-flash',
      'mimo-v2.6-pro',
    ]);
    for (const m of data) {
      const rec = m as Record<string, unknown>;
      expect(rec['owned_by']).toBe('xiaomi');
      // 上游**不给**机读字段：这是"矩阵里这些字段留空"的实测依据
      expect(rec['context_window']).toBeUndefined();
      expect(rec['input_modalities']).toBeUndefined();
    }
    callLog.push('GET /models');
  }, 120_000);

  afterAll(() => {
    if (!hasKey) return;
    obs(`调用日志（${callLog.length} 次）:`);
    for (const c of callLog) obs(' -', c);
    obs(`共 ${observations.length} 条观测`);
  });

  // -------------------------------------------------------------------------
  // 2. LLM
  // -------------------------------------------------------------------------

  it('非流式对话：reasoning_content 在响应里', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: '1+1=? 只回答数字' }],
      max_tokens: 1024,
    });
    expect(r.status).toBe(200);
    const body = r.json as Record<string, unknown>;
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0]!;
    const message = choice['message'] as Record<string, unknown>;
    obs('chat 非流式 content =', JSON.stringify(String(message['content']).slice(0, 60)));
    obs('chat 非流式 reasoning_content =', JSON.stringify(String(message['reasoning_content'])));
    obs('chat 非流式 usage =', JSON.stringify(body['usage']));
    callLog.push('chat non-stream');
    expect(typeof message['content']).toBe('string');
    expect(typeof message['reasoning_content']).toBe('string');
    expect((message['reasoning_content'] as string).length).toBeGreaterThan(0);
    const usage = body['usage'] as Record<string, unknown>;
    expect(typeof usage['prompt_tokens']).toBe('number');
    expect(typeof usage['completion_tokens']).toBe('number');
    expect(typeof usage['total_tokens']).toBe('number');
  }, 120_000);

  it('reasoning_effort=none 关推理：不回 reasoning_content', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
      reasoning_effort: 'none',
    });
    expect(r.status).toBe(200);
    const message = firstMessage(r.json);
    obs(
      'reasoning_effort=none → reasoning_content =',
      JSON.stringify(message['reasoning_content']),
    );
    callLog.push('chat reasoning off');
    // 语义与 OpenAI 一致：none = 关推理。codec 的默认映射因此够用，不需要 profile 覆盖
    expect(message['reasoning_content']).toBeUndefined();
  }, 120_000);

  it('流式对话：SSE 形态、delta.reasoning_content、末帧 [DONE]', async () => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.6-flash',
        messages: [{ role: 'user', content: '数到三' }],
        max_tokens: 256,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.startsWith('data: '));
    obs(`流式 SSE：${lines.length} 个 data 行`);
    expect(lines.some((l) => l.trim() === 'data: [DONE]')).toBe(true);
    let sawReasoningDelta = false;
    let sawContent = false;
    let sawUsageOnly = false;
    for (const line of lines) {
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      const obj = JSON.parse(payload) as Record<string, unknown>;
      const choices = obj['choices'] as Array<Record<string, unknown>> | undefined;
      if (choices === undefined || choices.length === 0) {
        if (obj['usage'] !== undefined) sawUsageOnly = true;
        continue;
      }
      const delta = choices[0]!['delta'] as Record<string, unknown>;
      if (typeof delta['reasoning_content'] === 'string') sawReasoningDelta = true;
      if (typeof delta['content'] === 'string' && delta['content'] !== '') sawContent = true;
    }
    obs(
      `流式观测：reasoning delta=${sawReasoningDelta} content=${sawContent} usage-only chunk=${sawUsageOnly}`,
    );
    callLog.push('chat stream');
    expect(sawReasoningDelta).toBe(true);
    expect(sawContent).toBe(true);
    expect(sawUsageOnly).toBe(true);
  }, 120_000);

  it('工具调用：finish_reason=tool_calls，arguments 是合法 JSON', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: '北京天气怎么样？' }],
      max_tokens: 512,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询城市天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    });
    expect(r.status).toBe(200);
    const choice = firstChoice(r.json);
    const message = choice['message'] as Record<string, unknown>;
    obs('tool_calls finish_reason =', String(choice['finish_reason']));
    obs('tool_calls =', JSON.stringify(message['tool_calls']));
    callLog.push('chat tools');
    expect(choice['finish_reason']).toBe('tool_calls');
    const calls = message['tool_calls'] as Array<Record<string, unknown>>;
    expect(Array.isArray(calls)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    const fn = calls[0]!['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('get_weather');
    expect(() => JSON.parse(String(fn['arguments']))).not.toThrow();
  }, 120_000);

  // -------------------------------------------------------------------------
  // 3. reasoning_content → 内置对话的 reasoning 字段（96 §3.5 真上游验收）
  // -------------------------------------------------------------------------

  it('reasoning_content 一路带到内置对话的 reasoning 字段', async () => {
    const { foldChat } = await import('../admin/agent-chat.js');
    // 上游真实响应（非流式）→ 原样喂 foldChat
    const r = await api('POST', '/chat/completions', {
      model: 'mimo-v2.6-flash',
      messages: [{ role: 'user', content: '用一句话说明什么是网关。' }],
      max_tokens: 1024,
    });
    expect(r.status).toBe(200);
    callLog.push('agent-chat reasoning');
    obs('foldChat 入参（上游原文） =', r.text.slice(0, 200));

    const view = foldChat(r.text, []);
    expect(view.error).toBeUndefined();
    expect(view.reply.length).toBeGreaterThan(0);
    expect(view.model).toBe('mimo-v2.6-flash');
    // 关键断言：思考正文从上游一路带到了界面视图
    expect(typeof view.reasoning).toBe('string');
    expect((view.reasoning as string).length).toBeGreaterThan(0);
    obs('foldChat.reply =', JSON.stringify(view.reply.slice(0, 80)));
    obs('foldChat.reasoning =', JSON.stringify((view.reasoning ?? '').slice(0, 120)));

    // 上游不给 reasoning_content 时字段省略（不造假空串）
    const noReasoning = foldChat(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        model: 'mimo-v2.6-flash',
      }),
      [],
    );
    expect(noReasoning.reasoning).toBeUndefined();
    expect(noReasoning.reply).toBe('ok');
  }, 120_000);

  // -------------------------------------------------------------------------
  // 4. 音频：ASR / TTS + 端到端闭环
  // -------------------------------------------------------------------------

  it('TTS：wav / mp3 / pcm 三种格式都产出音频', async () => {
    const client = new MiMoTtsClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    for (const format of ['wav', 'mp3', 'pcm'] as const) {
      const out = await client.synthesize({
        model: 'mimo-v2.5-tts',
        text: '你好，这是 MiMo 语音合成测试。',
        voice: 'mimo_default',
        format,
      });
      expect(out.httpStatus).toBe(200);
      expect(out.audio.byteLength).toBeGreaterThan(0);
      obs(`TTS ${format} → ${out.audio.byteLength} 字节，content_type=${out.content_type}`);
      callLog.push(`tts ${format}`);
      if (format === 'wav') ttsWav = out.audio;
      if (format === 'mp3') ttsMp3 = out.audio;
    }
    expect(ttsWav).toBeDefined();
    expect(ttsMp3).toBeDefined();
  }, 180_000);

  it('TTS 变体：voicedesign 与 voiceclone 都通', async () => {
    const client = new MiMoTtsClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const vd = await client.synthesize({
      model: 'mimo-v2.5-tts-voicedesign',
      text: '你好，这是音色设计测试。',
      voice_design: '一个温柔的年轻女性声音，语速偏慢',
      format: 'wav',
    });
    expect(vd.httpStatus).toBe(200);
    expect(vd.audio.byteLength).toBeGreaterThan(0);
    obs('TTS voicedesign →', vd.audio.byteLength, '字节');
    callLog.push('tts voicedesign');

    // voiceclone 的参考音频样本用上一步产出的 wav
    const vc = await client.synthesize({
      model: 'mimo-v2.5-tts-voiceclone',
      text: '这是克隆声音的测试。',
      voice_design: '克隆这个声音',
      reference_audio_base64: (ttsWav ?? toneWav()).toString('base64'),
      reference_audio_mime: 'audio/wav',
      format: 'wav',
    });
    expect(vc.httpStatus).toBe(200);
    expect(vc.audio.byteLength).toBeGreaterThan(0);
    obs('TTS voiceclone →', vc.audio.byteLength, '字节');
    callLog.push('tts voiceclone');
  }, 180_000);

  it('ASR：wav 与 mp3 都识别得出文本', async () => {
    const client = new MiMoAsrClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    for (const sample of [
      withExt(toneWav(), 'tone.wav'),
      withExt(ttsMp3 ?? toneWav(), 'tts.mp3'),
    ]) {
      const out = await client.transcribe({
        file: sample.file,
        filename: sample.filename,
        format: sample.filename.endsWith('.mp3') ? 'mp3' : 'wav',
        language: 'auto',
      });
      expect(out.httpStatus).toBe(200);
      expect(typeof out.text).toBe('string');
      obs(`ASR ${sample.filename} → text=${JSON.stringify(out.text)} seconds=${out.seconds}`);
      callLog.push(`asr ${sample.filename}`);
      // 计费口径：audio_seconds 的 input 与 billed 同值
      expect(out.usage.units.audio_seconds?.input).toBe(out.usage.units.audio_seconds?.billed);
    }
  }, 180_000);

  it('端到端：TTS 产出的音频喂 ASR，识别回原文', async () => {
    const expected = '你好，这是 MiMo 语音合成测试。';
    const tts = new MiMoTtsClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const synth = await tts.synthesize({
      model: 'mimo-v2.5-tts',
      text: expected,
      voice: 'mimo_default',
      format: 'wav',
    });
    expect(synth.audio.byteLength).toBeGreaterThan(0);

    const asr = new MiMoAsrClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const transcript = await asr.transcribe({
      file: synth.audio,
      filename: 'roundtrip.wav',
      format: 'wav',
      language: 'zh',
    });
    expect(transcript.httpStatus).toBe(200);
    obs('端到端 原文 =', JSON.stringify(expected));
    obs('端到端 识别 =', JSON.stringify(transcript.text));
    obs('端到端 usage =', JSON.stringify(transcript.usage));
    callLog.push('tts→asr e2e');
    // 宽松断言：ASR 不保证逐字相同——实测把 "MiMo" 听成「咪莫」（中文音译），
    // 把标点/空白剥掉后应仍认出中文主体。逐字比对会在这种正常现象上误红。
    const stripped = transcript.text.replace(/[，。！？、\s]/g, '');
    expect(stripped).toContain('语音合成测试');
    expect(stripped.length).toBeGreaterThan(6);
  }, 180_000);

  // -------------------------------------------------------------------------
  // 5. 经网关数据面
  // -------------------------------------------------------------------------

  it('网关 /v1/models 看得到 MiMo 的模型（配了 key 就出现）', async () => {
    const gateway = createGateway({
      mode: 'production',
      transport: new FetchTransport(),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        MIMO_API_KEY: KEY,
      }),
    });
    try {
      const models = await gateway.models.list({});
      const ids = models.data.map((m) => m.id).sort();
      obs('网关 /v1/models →', JSON.stringify(ids));
      expect(ids).toContain('mimo-v2.6-flash');
      expect(ids).toContain('mimo-v2.6-pro');
      expect(ids).toContain('mimo-v2.5-asr');
      expect(ids).toContain('mimo-v2.5-tts');
      // 部署态过滤：只配了 MiMo 一家，DeepSeek / OpenAI / Anthropic 都不该出现
      expect(ids).not.toContain('deepseek-flash');
      expect(ids).not.toContain('gpt-4o');
      // namespace 生效名默认**不出现**（namespace 要管理面显式配，见
      // composition-root 的 namespaceResolver）；配了才会多一个 mimo/xxx 名字
      expect(ids.some((id) => id.startsWith('mimo/'))).toBe(false);
    } finally {
      await gateway.shutdown();
    }
  }, 120_000);

  it('网关一次真实 chat completion（mimo-v2.6-flash，过 S0–S10）', async () => {
    const gateway = createGateway({
      mode: 'production',
      transport: new FetchTransport(),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        MIMO_API_KEY: KEY,
      }),
      config: { permissiveEnabled: true },
    });
    try {
      const res = await fetch('http://127.0.0.1:0/v1/chat/completions', {
        method: 'OPTIONS',
      }).catch(() => undefined);
      void res;
      // 直接跑 pipeline（不起 HTTP 服务，避免占端口）
      const { MemoryClientSink } = await import('../gateway-core/pipeline/sink.js');
      const sink = new MemoryClientSink();
      const outcome = await gateway.runner.run(
        {
          client_format: 'openai.chat',
          raw_body: Buffer.from(
            JSON.stringify({
              model: 'mimo-v2.6-flash',
              messages: [{ role: 'user', content: '用一句话介绍小米。' }],
              max_tokens: 512,
            }),
            'utf8',
          ),
          headers: { 'content-type': 'application/json' },
          path: '/v1/chat/completions',
          query: {},
          auth_exemption: { caller: 'agent-builtin' },
        },
        sink,
      );
      expect(outcome.error).toBeUndefined();
      const body = JSON.parse(sink.text()) as Record<string, unknown>;
      const message = firstMessage(body);
      obs('网关 chat reply =', JSON.stringify(String(message['content']).slice(0, 80)));
      obs(
        '网关 chat reasoning =',
        JSON.stringify(String(message['reasoning_content']).slice(0, 120)),
      );
      callLog.push('gateway chat');
      expect(typeof message['content']).toBe('string');
      expect((message['content'] as string).length).toBeGreaterThan(0);
      // 思考正文经「解码 → canonical → 编码」往返后仍在（96 §3.2 事实链第 3 条）
      expect(typeof message['reasoning_content']).toBe('string');
    } finally {
      await gateway.shutdown();
    }
  }, 180_000);

  // -------------------------------------------------------------------------
  // 5b. 计费：订阅路径 cash 恒 0、as_api 照算（Token Plan 的真上游验收）
  // -------------------------------------------------------------------------

  it('计费：Token Plan（tp- key）= 订阅路径，cash 0 / as_api > 0 / priced', async () => {
    const { MemoryUsageSink } = await import('../metering/memory-emitter.js');
    const { MemoryClientSink } = await import('../gateway-core/pipeline/sink.js');
    const sink = new MemoryUsageSink();
    const gateway = createGateway({
      mode: 'production',
      transport: new FetchTransport(),
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        MIMO_API_KEY: KEY,
      }),
      usageSink: sink,
    });
    try {
      // 判据先验：tp- 前缀 → 订阅（官方文档明文）
      expect(
        gateway.container
          .resolve<import('../credentials/resolver.js').CredentialResolver>(
            (await import('../di/index.js')).TOKENS.CredentialResolver,
          )
          .billingModeFor?.('mimo.openai-chat'),
      ).toBe('subscription');

      const clientSink = new MemoryClientSink();
      await gateway.runner.run(
        {
          client_format: 'openai.chat',
          raw_body: Buffer.from(
            JSON.stringify({
              model: 'mimo-v2.6-flash',
              messages: [{ role: 'user', content: '用一句话介绍北京。' }],
              max_tokens: 512,
            }),
            'utf8',
          ),
          headers: { 'content-type': 'application/json' },
          path: '/v1/chat/completions',
          query: {},
          auth_exemption: { caller: 'agent-builtin' },
        },
        clientSink,
      );
      await gateway.usageEmitter.flush();
      const records = sink.records;
      expect(records.length).toBeGreaterThanOrEqual(1);
      const rec = records[records.length - 1]!;
      obs('订阅路径用量记录 cost =', JSON.stringify(rec.cost));
      obs('订阅路径 price_snapshot =', JSON.stringify(rec.price_snapshot));
      callLog.push('billing subscription');

      // 关键断言（仓库主人规则）：
      expect(rec.provider).toBe('mimo');
      expect(rec.cost.status).toBe('priced'); // 不是 unpriced
      expect(rec.price_snapshot?.price_table_version).toBe('mimo-2026-10-21');
      // 订阅：现金恒 0，等值 API 价值照算
      expect(rec.cost.cash.total).toBe(0);
      expect(rec.cost.as_api.total).toBeGreaterThan(0);
    } finally {
      await gateway.shutdown();
    }
  }, 180_000);

  it('官方计费接口：Token Plan 余量查得到（订阅路径的对账真值源）', async () => {
    const { MiMoBalanceClient } = await import('../providers/mimo/balance.js');
    const client = new MiMoBalanceClient({
      transport: new FetchTransport(),
      headersProvider: async () => ({ authorization: `Bearer ${KEY}` }),
    });
    const info = await client.tokenPlan();
    obs('GET /v1/platform/token_plan →', JSON.stringify(info.quota), 'plan =', info.plan_code);
    callLog.push('token_plan');
    expect(info.object).toBe('token_plan');
    expect(info.plan_code.length).toBeGreaterThan(0);
    expect(info.quota.total_credits).toBeGreaterThan(0);
    // remaining = max(0, total - used)（上游自己算，我们夹到 0 不传播负数）
    expect(info.quota.remaining_credits).toBe(
      Math.max(0, info.quota.total_credits - info.quota.used_credits),
    );
    expect(info.period.start_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 按量渠道的余额接口要 sk- key；我们的 tp- key 打过去会 401（官方文档明文）。
    // 那不是故障，是"这个部署没有按量渠道"——记录下来，不断言成功。
    try {
      await client.balance();
      obs('balance（sk- 渠道）意外成功');
    } catch (err) {
      obs('balance（sk- 渠道）按预期被拒：', String(err).slice(0, 120));
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // 6. 数据面鉴权：临时虚拟 key，验完删掉
  // -------------------------------------------------------------------------

  it('数据面鉴权：临时虚拟 key 能过、撤销后立刻失效', async () => {
    const { DefaultVirtualKeyStore } = await import('../storage/virtual-keys.js');
    const { InMemoryRawRecordStore } = await import('../storage/record-store.js');
    const { Keystore, PassphraseKekSource } = await import('../storage/keystore.js');
    const { DefaultEncryptedRecordStore } = await import('../storage/record-store.js');
    const { DataPlaneAuthenticator } = await import('../auth/data-plane.js');
    const { systemClock } = await import('../di/index.js');

    const ks = new Keystore(new PassphraseKekSource(), undefined, 1_760_000_000_000);
    await ks.unlock('mimo-live-test-passphrase');
    const store = new DefaultEncryptedRecordStore(ks.unlocked(), new InMemoryRawRecordStore(), {
      now: () => 1_760_000_000_000,
    });
    const keyStore = new DefaultVirtualKeyStore(store, systemClock);

    // 建一把临时 key（名字带 live-smoke 前缀，便于排查；明文只在内存里）
    const created = await keyStore.create({ name: 'mimo-live-smoke-temp' });
    obs('临时虚拟 key 已创建（id 长度 =', created.key_id.length, '）');
    callLog.push('virtual key create');

    const auth = new DataPlaneAuthenticator({ store: keyStore, clock: systemClock });
    const ok = await auth.authenticate({
      headers: { authorization: `Bearer ${created.plaintext}` },
      query: {},
      path: '/v1/chat/completions',
      raw_body: Buffer.alloc(0),
    });
    expect(ok.ok).toBe(true);
    obs('临时 key 鉴权通过');

    //  revoked 后立刻失效（存储内部写操作清缓存，不需要跨组件通知）
    await keyStore.revoke(created.key_id, systemClock.now());
    const after = await auth.authenticate({
      headers: { authorization: `Bearer ${created.plaintext}` },
      query: {},
      path: '/v1/chat/completions',
      raw_body: Buffer.alloc(0),
    });
    expect(after.ok).toBe(false);
    obs('撤销后鉴权失败（符合预期）');
    callLog.push('virtual key revoke');

    // 没有 key 时的拒绝
    const anon = await auth.authenticate({
      headers: {},
      query: {},
      path: '/v1/chat/completions',
      raw_body: Buffer.alloc(0),
    });
    expect(anon.ok).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 7. 错误路径
  // -------------------------------------------------------------------------

  it('无效 key → 401，错误体是 OpenAI 形状', async () => {
    const r = await api(
      'POST',
      '/chat/completions',
      { model: 'mimo-v2.6-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 },
      'tp-invalid-key-for-smoke-test',
    );
    obs('无效 key →', r.status, r.text.slice(0, 200));
    callLog.push('bad key');
    expect(r.status).toBe(401);
    expect(errorOf(r.json)['type']).toBe('invalid_key');
  }, 60_000);

  it('不支持的模型名 → 400 + Unsupported model', async () => {
    const r = await api('POST', '/chat/completions', {
      model: 'no-such-model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    });
    obs('坏模型名 →', r.status, r.text.slice(0, 200));
    callLog.push('bad model');
    expect(r.status).toBe(400);
    expect(String(errorOf(r.json)['message'])).toMatch(/Unsupported model/);
  }, 60_000);
});
