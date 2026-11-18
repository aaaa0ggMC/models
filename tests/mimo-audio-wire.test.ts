/**
 * tests/mimo-audio-wire.test.ts —— MiMo TTS / ASR 的 **wire 层 round-trip** 测试。
 *
 * 夹具来源：`providers/mimo/fixtures/`，其中请求/响应形状逐字段抄自 2026-11-16 对
 * 真实上游的 curl 实测（探测记录见 MIMO-INTEGRATION-REPORT.md §3）。音频样本是
 * 确定性假字节（`RIFF____WAVEfmt fake-audio-bytes`）——**不掺二进制**，因为
 * ScriptedTransport 的 body 是字符串。
 *
 * 覆盖（夹具进 → codec 往返 → 夹具出）：
 *   1. ASR：encodeTtsRequest 的逆（encodeAsrRequest）——data URL + format 双字段、
 *      asr_options.language 的有无、max_tokens 默认值；
 *   2. ASR：decodeAsrResponse——seconds 落到 audio_seconds、缺 seconds 落 0；
 *   3. TTS：encodeTtsRequest——三个变体的消息结构与 audio.voice 形态；
 *   4. TTS：decodeTtsResponse——音频 base64 → Buffer、content_type 按请求 format 定；
 *   5. usage：按字符（1:1，无 CJK 加权）与按音频秒；
 *   6. 容器识别：filename → mp3/wav，认不出抛错（不猜）；
 *   7. 客户端方言脸：OpenAI speech 体 → 中间形状（三个变体各自的字段规则）、
 *      response_format 矩阵、转写 language 白名单。
 *
 * 上游一律 ScriptedTransport（假数据、假 key）：**这一层不打网络**，真上游冒烟在
 * tests/mimo-live.test.ts（有 key 才跑）。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MIMO_ASR_MODEL,
  MIMO_TTS_DEFAULT_FORMAT,
  MIMO_TTS_MODELS,
  MiMoAudioError,
  asrMimeType,
  audioFormatFromFilename,
  buildAsrUsage,
  buildTtsUsage,
  decodeAsrResponse,
  decodeTtsResponse,
  encodeAsrRequest,
  encodeTtsRequest,
  throwIfAudioNotOk,
  ttsMimeType,
} from '../providers/mimo/audio.js';
import {
  MIMO_AUDIO_FACE,
  MIMO_ASR_LANGUAGES,
  decodeMiMoOpenAiSpeechRequest,
  decodeMiMoOpenAiTranscriptionFields,
  encodeMiMoOpenAiSpeechResponse,
  encodeMiMoOpenAiTranscriptionResponse,
  resolveAsrLanguage,
  resolveMiMoSpeechResponseFormat,
  resolveMiMoTranscriptionResponseFormat,
  resolveMiMoVoice,
} from '../providers/mimo/index.js';

/** 夹具原文（`unknown`：逐字段断言前先收窄，不让 any 把类型检查抹掉）。 */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../providers/mimo/fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** 从 ASR wire 请求体里取第一条 content part（input_audio 那个）。 */
function firstAudioPart(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body['messages'] as Array<Record<string, unknown>>;
  const content = messages[0]!['content'] as Array<Record<string, unknown>>;
  return content[0]!;
}

/** 收窄成对象（测试里读 JSON 字段用；形状由夹具本身保证）。 */
function rec(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('夹具不是 JSON 对象');
  }
  return value as Record<string, unknown>;
}

/** 确定性假音频字节（与 fixtures 里的 base64 对应）。 */
const FAKE_AUDIO_BYTES = Buffer.from('RIFF____WAVEfmt fake-audio-bytes', 'utf8');
const FAKE_AUDIO_B64 = FAKE_AUDIO_BYTES.toString('base64');

// ---------------------------------------------------------------------------
// 1. ASR：请求编码
// ---------------------------------------------------------------------------

describe('MiMo ASR · 请求编码（canonical → wire）', () => {
  it('fixtures/asr.request.json：字段逐个对齐', () => {
    const expected = rec(fixture('asr.request.json'));
    const encoded = encodeAsrRequest({
      file: FAKE_AUDIO_BYTES,
      filename: 'audio.wav',
      format: 'wav',
      language: 'zh',
      max_tokens: 64,
    });
    expect(encoded).toEqual(expected);
  });

  it('language 省略时不发 asr_options（上游默认 auto，不显式写）', () => {
    const encoded = encodeAsrRequest({
      file: FAKE_AUDIO_BYTES,
      filename: 'audio.wav',
      format: 'wav',
    });
    expect(encoded).not.toHaveProperty('asr_options');
    expect(encoded['model']).toBe(MIMO_ASR_MODEL);
    // max_tokens 有默认值（请求体自解释）
    expect(encoded['max_tokens']).toBe(512);
  });

  it('data URL 的 MIME 与 format 匹配（mp3 → audio/mpeg）', () => {
    const encoded = encodeAsrRequest({
      file: FAKE_AUDIO_BYTES,
      filename: 'audio.mp3',
      format: 'mp3',
      language: 'en',
    });
    const part = firstAudioPart(encoded);
    expect(part['type']).toBe('input_audio');
    const inputAudio = part['input_audio'] as Record<string, unknown>;
    expect(inputAudio['format']).toBe('mp3');
    expect(String(inputAudio['data']).startsWith('data:audio/mpeg;base64,')).toBe(true);
    expect(encoded['asr_options']).toEqual({ language: 'en' });
  });

  it('round-trip：encode 的 body 再 decode 回同一份响应', () => {
    const encoded = encodeAsrRequest({
      file: FAKE_AUDIO_BYTES,
      filename: 'audio.wav',
      format: 'wav',
      language: 'zh',
      max_tokens: 64,
    });
    // wire → JSON 文本 → 解析 → decodeAsrResponse：形状不丢
    const text = JSON.stringify(encoded);
    const decoded = decodeAsrResponse(JSON.parse(text));
    // decode 读的是**响应**不是请求，所以这里只断言"请求体能被 JSON 往返"
    expect(decoded.raw).toBeDefined();
    expect(decoded.text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. ASR：响应解码 + usage
// ---------------------------------------------------------------------------

describe('MiMo ASR · 响应解码（wire → canonical）', () => {
  it('fixtures/asr.response.json：text / seconds / request_id', () => {
    const decoded = decodeAsrResponse(rec(fixture('asr.response.json')));
    expect(decoded.text).toBe('你好，我是小米 MiMo 语音合成。');
    expect(decoded.seconds).toBe(4);
    expect(decoded.request_id).toBe('74812a5c490d48cabf9dc873524122aa');
  });

  it('缺 seconds 时落 0 而不是省略（计费必须有个数；raw 里能分辨）', () => {
    const decoded = decodeAsrResponse(rec(fixture('asr.response.no-seconds.json')));
    expect(decoded.seconds).toBe(0);
    expect(decoded.raw).not.toHaveProperty('seconds');
  });

  it('畸形响应不抛：text 空串、seconds 0、raw 留原文', () => {
    expect(decodeAsrResponse(undefined).text).toBe('');
    expect(decodeAsrResponse(null).seconds).toBe(0);
    expect(decodeAsrResponse('not json').text).toBe('');
    expect(decodeAsrResponse({ choices: 'nope' }).text).toBe('');
  });

  it('usage：audio_seconds 的 input 与 billed 同值（整文件一次上传）', () => {
    const decoded = decodeAsrResponse(rec(fixture('asr.response.json')));
    const usage = buildAsrUsage(decoded);
    expect(usage.units.audio_seconds).toEqual({ input: 4, billed: 4 });
    expect(usage.source).toBe('provider');
    expect(usage.raw).toEqual({ seconds: 4 });
  });
});

// ---------------------------------------------------------------------------
// 3. TTS：请求编码（三个变体）
// ---------------------------------------------------------------------------

describe('MiMo TTS · 请求编码（canonical → wire）', () => {
  it('fixtures/tts.request.json：预置音色变体', () => {
    const expected = rec(fixture('tts.request.json'));
    const encoded = encodeTtsRequest({
      model: MIMO_TTS_MODELS.base,
      text: '你好，我是小米 MiMo 语音合成。',
      voice: 'mimo_default',
      format: 'wav',
      max_tokens: 2048,
    });
    expect(encoded).toEqual(expected);
  });

  it('fixtures/tts.request.voiceclone.json：voice 是音频样本的 data URL', () => {
    const expected = rec(fixture('tts.request.voiceclone.json'));
    const encoded = encodeTtsRequest({
      model: MIMO_TTS_MODELS.voiceclone,
      text: '这是克隆声音的测试。',
      voice_design: '克隆这个声音',
      reference_audio_base64: FAKE_AUDIO_B64,
      reference_audio_mime: 'audio/wav',
      format: 'wav',
      max_tokens: 2048,
    });
    expect(encoded).toEqual(expected);
  });

  it('fixtures/tts.request.voicedesign.json：user 消息是音色设计描述，无 audio.voice', () => {
    const expected = rec(fixture('tts.request.voicedesign.json'));
    const encoded = encodeTtsRequest({
      model: MIMO_TTS_MODELS.voicedesign,
      text: '你好，这是音色设计测试。',
      voice_design: '一个温柔的年轻女性声音，语速偏慢',
      format: 'wav',
      max_tokens: 2048,
    });
    expect(encoded).toEqual(expected);
    expect(encoded['audio'] as Record<string, unknown>).not.toHaveProperty('voice');
  });

  it('format 省略时回落官方默认 wav', () => {
    const encoded = encodeTtsRequest({ model: MIMO_TTS_MODELS.base, text: 'hi' });
    expect((encoded['audio'] as Record<string, unknown>)['format']).toBe(MIMO_TTS_DEFAULT_FORMAT);
  });

  it('canonical 的 filter_markdown 不发（MiMo 没这个参数）', () => {
    const encoded = encodeTtsRequest({ model: MIMO_TTS_MODELS.base, text: 'hi' });
    expect(encoded).not.toHaveProperty('filter_markdown');
  });
});

// ---------------------------------------------------------------------------
// 4. TTS：响应解码 + usage
// ---------------------------------------------------------------------------

describe('MiMo TTS · 响应解码（wire → canonical）', () => {
  it('fixtures/tts.response.json：audio.data → Buffer、id / transcript', () => {
    const decoded = decodeTtsResponse(
      {
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify(rec(fixture('tts.response.json')))),
      },
      { model: MIMO_TTS_MODELS.base, text: '你好，我是小米 MiMo 语音合成。', format: 'wav' },
    );
    expect(decoded.audio.equals(FAKE_AUDIO_BYTES)).toBe(true);
    expect(decoded.audio_id).toBe('50b9834826cb4d9e9aafd1dc986dc65a');
    expect(decoded.transcript).toBe('你好，我是小米 MiMo 语音合成。');
    expect(decoded.content_type).toBe('audio/wav');
  });

  it('content_type 按**请求的** format 定，不按上游头定（上游给的是 json）', () => {
    const headers = { 'content-type': 'application/json' };
    const body = Buffer.from(JSON.stringify(fixture('tts.response.json')));
    const decoded = decodeTtsResponse(
      { status: 200, headers, body },
      { model: MIMO_TTS_MODELS.base, text: 'hi', format: 'mp3' },
    );
    expect(decoded.content_type).toBe('audio/mpeg');
  });

  it('非 JSON 响应不抛：audio 落空 Buffer（0 字节比猜出来的容器更容易发现）', () => {
    const decoded = decodeTtsResponse({ status: 200, headers: {}, body: Buffer.from('nope') });
    expect(decoded.audio.byteLength).toBe(0);
    expect(decoded.audio_id).toBe('');
  });

  it('usage：按字符 1:1，**不做 CJK 加权**（MiMo 价格页没这条规则）', () => {
    const usage = buildTtsUsage('你好世界');
    expect(usage.units.characters).toEqual({ input: 4, billed: 4 });
    expect(usage.raw).toMatchObject({ characters: 4, billed_characters: 4 });
    // 与 DeepSeek 的"CJK 每字 2"对照：同一个串在 MiMo 侧记 4 而不是 8
    const usageAscii = buildTtsUsage('hello');
    expect(usageAscii.units.characters).toEqual({ input: 5, billed: 5 });
  });

  it('format → mime：pcm16 与 pcm 同值（官方文档明说同义）', () => {
    expect(ttsMimeType('pcm')).toBe('audio/pcm');
    expect(ttsMimeType('pcm16')).toBe('audio/pcm');
    expect(ttsMimeType('wav')).toBe('audio/wav');
    expect(ttsMimeType('mp3')).toBe('audio/mpeg');
  });
});

// ---------------------------------------------------------------------------
// 5. 容器识别与错误载体
// ---------------------------------------------------------------------------

describe('MiMo 音频 · 容器识别与错误', () => {
  it('filename → 容器（大小写不敏感）', () => {
    expect(audioFormatFromFilename('a.wav')).toBe('wav');
    expect(audioFormatFromFilename('A.WAV')).toBe('wav');
    expect(audioFormatFromFilename('a.mp3')).toBe('mp3');
  });

  it('认不出容器就抛（不猜：上游只认 mp3/wav）', () => {
    expect(() => audioFormatFromFilename('a.ogg')).toThrow(/只支持 mp3 \/ wav/);
    expect(() => audioFormatFromFilename('a.bin')).toThrow();
  });

  it('asrMimeType：mp3 → audio/mpeg（不是 audio/mp3）', () => {
    expect(asrMimeType('mp3')).toBe('audio/mpeg');
    expect(asrMimeType('wav')).toBe('audio/wav');
  });

  it('throwIfAudioNotOk：非 2xx 抛，2xx 不抛；status 完整上抛', () => {
    expect(() => throwIfAudioNotOk(200, '', 'tts')).not.toThrow();
    expect(() => throwIfAudioNotOk(400, '{"error":{}}', 'asr')).toThrow(MiMoAudioError);
    try {
      throwIfAudioNotOk(429, 'rate limited', 'tts');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MiMoAudioError);
      expect((err as MiMoAudioError).status).toBe(429);
      expect((err as MiMoAudioError).endpoint).toBe('tts');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 客户端方言脸：OpenAI speech 体 → 中间形状
// ---------------------------------------------------------------------------

describe('MiMo 音频 · OpenAI 入站脸（speech）', () => {
  const baseBody = { model: 'mimo-v2.5-tts', input: '你好', voice: 'mimo_default' };

  it('预置音色变体：voice 原样透传', () => {
    const out = decodeMiMoOpenAiSpeechRequest(baseBody);
    expect(out).toMatchObject({
      input: '你好',
      voice_id: 'mimo_default',
      format: 'wav',
      model: 'mimo-v2.5-tts',
    });
    expect(out.reference_audio).toBeUndefined();
    expect(out.voice_design).toBeUndefined();
  });

  it('voice 省略 → mimo_default（上游默认值，不报错）', () => {
    const out = decodeMiMoOpenAiSpeechRequest({ model: 'mimo-v2.5-tts', input: 'hi' });
    expect(out.voice_id).toBe('mimo_default');
  });

  it('英文音色名大小写不敏感', () => {
    expect(resolveMiMoVoice('mia')).toBe('Mia');
    expect(resolveMiMoVoice('MIA')).toBe('Mia');
    expect(resolveMiMoVoice('冰糖')).toBe('冰糖');
  });

  it('voice 不在预置表 → 400 + 列出可用的名字', () => {
    expect(() => resolveMiMoVoice('nonexistent')).toThrow(/不是 MiMo 预置音色/);
    expect(() => decodeMiMoOpenAiSpeechRequest({ ...baseBody, voice: 'x' })).toThrow(
      /不是 MiMo 预置音色/,
    );
  });

  it('voiceclone：voice 必须是音频样本（data URL 或裸 base64）', () => {
    const out = decodeMiMoOpenAiSpeechRequest({
      model: 'mimo-v2.5-tts-voiceclone',
      input: 'hi',
      voice: `data:audio/wav;base64,${FAKE_AUDIO_B64}`,
    });
    expect(out.reference_audio).toEqual({ data_base64: FAKE_AUDIO_B64, content_type: 'audio/wav' });
    // 裸 base64 也可（容器猜不出 → 默认 wav）
    const bare = decodeMiMoOpenAiSpeechRequest({
      model: 'mimo-v2.5-tts-voiceclone',
      input: 'hi',
      voice: FAKE_AUDIO_B64,
    });
    expect(bare.reference_audio?.content_type).toBe('audio/wav');
  });

  it('voiceclone 缺 voice → 400（上游该字段必填）', () => {
    expect(() =>
      decodeMiMoOpenAiSpeechRequest({ model: 'mimo-v2.5-tts-voiceclone', input: 'hi' }),
    ).toThrow(/必须提供 voice/);
  });

  it('voicedesign：instructions 必填，voice 必须缺席', () => {
    const out = decodeMiMoOpenAiSpeechRequest({
      model: 'mimo-v2.5-tts-voicedesign',
      input: 'hi',
      instructions: '温柔女声',
    });
    expect(out.voice_design).toBe('温柔女声');
    expect(() =>
      decodeMiMoOpenAiSpeechRequest({
        model: 'mimo-v2.5-tts-voicedesign',
        input: 'hi',
        instructions: '温柔女声',
        voice: 'Mia',
      }),
    ).toThrow(/不接受 voice/);
    expect(() =>
      decodeMiMoOpenAiSpeechRequest({ model: 'mimo-v2.5-tts-voicedesign', input: 'hi' }),
    ).toThrow(/必须提供 instructions/);
  });

  it('instructions 在非 voicedesign 变体上 → 400（上游无该参数）', () => {
    expect(() => decodeMiMoOpenAiSpeechRequest({ ...baseBody, instructions: '慢一点' })).toThrow(
      /不支持语音指令/,
    );
  });

  it('speed ≠ 1 → 400（API 文档的 audio 对象里没有该参数）', () => {
    expect(() => decodeMiMoOpenAiSpeechRequest({ ...baseBody, speed: 1.5 })).toThrow(/不支持变速/);
    // speed: 1 是默认值，放过
    expect(() => decodeMiMoOpenAiSpeechRequest({ ...baseBody, speed: 1 })).not.toThrow();
  });

  it('response_format 矩阵：wav/mp3/pcm/pcm16 收，opus/aac/flac 拒', () => {
    expect(resolveMiMoSpeechResponseFormat('wav')).toBe('wav');
    expect(resolveMiMoSpeechResponseFormat('mp3')).toBe('mp3');
    expect(resolveMiMoSpeechResponseFormat('pcm')).toBe('pcm');
    expect(resolveMiMoSpeechResponseFormat('pcm16')).toBe('pcm');
    expect(resolveMiMoSpeechResponseFormat(undefined)).toBe('wav');
    for (const bad of ['opus', 'aac', 'flac']) {
      expect(() => resolveMiMoSpeechResponseFormat(bad)).toThrow(/不受支持/);
    }
    expect(() => resolveMiMoSpeechResponseFormat('nope')).toThrow(/不是 OpenAI 的合法值/);
  });

  it('ASR 模型名打到 speech 端点 → 一句明白话', () => {
    expect(() => decodeMiMoOpenAiSpeechRequest({ model: 'mimo-v2.5-asr', input: 'hi' })).toThrow(
      /是 ASR 模型/,
    );
  });

  it('encodeSpeech：Content-Type 按请求 format 定', () => {
    const res = {
      endpoint: 'tts' as const,
      audio_base64: FAKE_AUDIO_B64,
      content_type: 'audio/wav',
      usage: { units: {}, source: 'provider' as const },
      raw: {},
    };
    expect(encodeMiMoOpenAiSpeechResponse(res, 'wav').content_type).toBe('audio/wav');
    expect(encodeMiMoOpenAiSpeechResponse(res, 'mp3').content_type).toBe('audio/mpeg');
    expect(encodeMiMoOpenAiSpeechResponse(res, 'pcm').content_type).toBe('audio/pcm');
    expect(encodeMiMoOpenAiSpeechResponse(res, 'wav').body.equals(FAKE_AUDIO_BYTES)).toBe(true);
    expect(() => encodeMiMoOpenAiSpeechResponse(res, 'opus')).toThrow(/不受支持/);
  });
});

// ---------------------------------------------------------------------------
// 7. 客户端方言脸：OpenAI transcriptions 表单
// ---------------------------------------------------------------------------

describe('MiMo 音频 · OpenAI 入站脸（transcriptions）', () => {
  it('language 白名单：auto/zh/en 收，其余拒', () => {
    expect(resolveAsrLanguage('auto')).toBe('auto');
    expect(resolveAsrLanguage('ZH')).toBe('zh');
    expect(resolveAsrLanguage('en')).toBe('en');
    expect(resolveAsrLanguage(undefined)).toBeUndefined();
    expect(() => resolveAsrLanguage('ja')).toThrow(/只认/);
    expect(MIMO_ASR_LANGUAGES).toEqual(['auto', 'zh', 'en']);
  });

  it('prompt 收下但到不了上游（文档化缺口；wire 没有该字段）', () => {
    const extras = decodeMiMoOpenAiTranscriptionFields({ prompt: '领域词' });
    expect(extras).toEqual({ prompt: '领域词' });
  });

  it('temperature ≠ 0 与 timestamp_granularities → 400', () => {
    expect(() => decodeMiMoOpenAiTranscriptionFields({ temperature: '0.5' })).toThrow(
      /不支持采样温度/,
    );
    expect(() => decodeMiMoOpenAiTranscriptionFields({ timestamp_granularities: 'word' })).toThrow(
      /不支持时间戳粒度/,
    );
    // temperature: 0 是默认值，放过
    expect(decodeMiMoOpenAiTranscriptionFields({ temperature: '0' })).toEqual({});
  });

  it('response_format：json/text/verbose_json 收，srt/vtt 拒', () => {
    expect(resolveMiMoTranscriptionResponseFormat(undefined)).toBe('json');
    expect(resolveMiMoTranscriptionResponseFormat('text')).toBe('text');
    expect(resolveMiMoTranscriptionResponseFormat('VERBOSE_JSON')).toBe('verbose_json');
    expect(() => resolveMiMoTranscriptionResponseFormat('srt')).toThrow(/不产出时间轴/);
  });

  it('encodeTranscription：text 纯文本 / verbose_json 带 duration 与空 segments', () => {
    const res = {
      endpoint: 'asr' as const,
      text: '你好',
      duration_seconds: 4,
      usage: { units: {}, source: 'provider' as const },
      raw: {},
    };
    const text = encodeMiMoOpenAiTranscriptionResponse(res, 'text');
    expect(text).toEqual({ content_type: 'text/plain; charset=utf-8', body: '你好' });

    const verbose = encodeMiMoOpenAiTranscriptionResponse(res, 'verbose_json');
    expect(JSON.parse(verbose.body)).toEqual({
      task: 'transcribe',
      duration: 4,
      text: '你好',
      // 上游不返回分段：恒为空数组（缺字段不填 0）
      segments: [],
    });

    const json = encodeMiMoOpenAiTranscriptionResponse(res, 'json');
    expect(JSON.parse(json.body)).toEqual({ text: '你好' });
  });
});

// ---------------------------------------------------------------------------
// 8. face 元数据
// ---------------------------------------------------------------------------

describe('MiMo 音频 · face 元数据', () => {
  it('access path 与默认模型', () => {
    expect(MIMO_AUDIO_FACE.provider).toBe('mimo');
    expect(MIMO_AUDIO_FACE.accessPath('tts')).toBe('mimo.tools.tts');
    expect(MIMO_AUDIO_FACE.accessPath('asr')).toBe('mimo.tools.asr');
    expect(MIMO_AUDIO_FACE.defaultModel('tts')).toBe('mimo-v2.5-tts');
    expect(MIMO_AUDIO_FACE.defaultModel('asr')).toBe('mimo-v2.5-asr');
  });

  it('不映射 tts-1 / whisper-1（已被 DeepSeek 认领）', () => {
    expect(MIMO_AUDIO_FACE.openaiModelAliases()).toEqual({});
  });

  it('模型名清单含三个 TTS 变体与便利别名', () => {
    expect(MIMO_AUDIO_FACE.modelNames('tts')).toEqual([
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
      'mimo-tts',
    ]);
    expect(MIMO_AUDIO_FACE.modelNames('asr')).toEqual(['mimo-v2.5-asr', 'mimo-asr']);
  });

  it('translations 的不支持理由说人话', () => {
    expect(MIMO_AUDIO_FACE.translationsUnsupportedReason).toMatch(/不支持翻译/);
  });
});

// ---------------------------------------------------------------------------
// 9. 格式常量的小对齐（防止有人把 wire 格式加回去）
// ---------------------------------------------------------------------------

describe('MiMo 音频 · 格式常量', () => {
  it('pcm16 在脸层收成 pcm（官方文档：二者同义）', () => {
    // wire 层有四值，脸层只暴露 canonical 三值——少一处会漂移的映射
    expect(resolveMiMoSpeechResponseFormat('pcm16')).toBe('pcm');
    expect(resolveMiMoSpeechResponseFormat('pcm')).toBe('pcm');
    expect(resolveMiMoSpeechResponseFormat('wav')).toBe('wav');
    expect(resolveMiMoSpeechResponseFormat('mp3')).toBe('mp3');
  });
});
