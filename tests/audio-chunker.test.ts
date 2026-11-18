import { describe, expect, it } from 'vitest';
import { splitMp3IntoChunks, splitWavIntoChunks } from '../gateway-core/audio-chunker.js';
import { MiMoAsrClient } from '../providers/mimo/audio.js';
import type { Transport, UpstreamRequest, UpstreamResponse } from '../gateway-core/transport.js';

function makePcmWav(pcmBytes: number, blockAlign = 4): Uint8Array {
  const buf = new Uint8Array(44 + pcmBytes);
  const view = new DataView(buf.buffer);
  // RIFF
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + pcmBytes, true);
  // WAVE
  buf.set([0x57, 0x41, 0x56, 0x45], 8);
  // fmt
  buf.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  // data
  buf.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, pcmBytes, true);
  for (let i = 0; i < pcmBytes; i += 1) {
    buf[44 + i] = i & 0xff;
  }
  return buf;
}

function makeFakeMp3(frameCount: number): { full: Uint8Array; frameSize: number; id3Len: number } {
  // MPEG-1 Layer III, 128 kbps (idx 9), 44100 Hz (idx 0), padding 0 -> frameLen = 417 bytes
  const frameSize = 417;
  const id3Len = 10 + 16; // 10-byte ID3v2 header + 16-byte tag body
  const full = new Uint8Array(id3Len + frameCount * frameSize);
  // ID3v2
  full.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 16], 0);
  for (let i = 0; i < frameCount; i += 1) {
    const off = id3Len + i * frameSize;
    full[off] = 0xff;
    full[off + 1] = 0xfb; // MPEG1 Layer3
    full[off + 2] = 0x90; // 128kbps, 44100Hz, no padding
    full[off + 3] = 0x00;
    full[off + 4] = i & 0xff;
  }
  return { full, frameSize, id3Len };
}

describe('gateway-core/audio-chunker', () => {
  it('按 blockAlign 切分 WAV，每段带合法 RIFF/WAVE 头且总采样字节无损', () => {
    const wav = makePcmWav(1000, 4); // 1044 bytes
    const chunks = splitWavIntoChunks(wav, 400);
    expect(chunks.length).toBeGreaterThan(2);

    const recoveredPcm: number[] = [];
    for (const c of chunks) {
      expect(c.byteLength).toBeLessThanOrEqual(400);
      expect(String.fromCharCode(...c.slice(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...c.slice(8, 12))).toBe('WAVE');
      const dataSize = new DataView(c.buffer, c.byteOffset, c.byteLength).getUint32(40, true);
      expect(dataSize % 4).toBe(0);
      expect(c.byteLength).toBe(44 + dataSize);
      recoveredPcm.push(...c.slice(44));
    }
    expect(Uint8Array.from(recoveredPcm)).toEqual(wav.slice(44));
  });

  it('按 MPEG Layer III 帧边界切分 MP3，跳过 ID3v2 且每段帧完整', () => {
    const { full, frameSize, id3Len } = makeFakeMp3(10); // 10 * 417 = 4170 bytes audio
    const chunks = splitMp3IntoChunks(full, 1500); // max 3 frames (1251 bytes) per chunk -> 4 chunks
    expect(chunks.length).toBe(4);
    let totalAudio = 0;
    for (const c of chunks) {
      expect(c.byteLength).toBeLessThanOrEqual(1500);
      expect(c.byteLength % frameSize).toBe(0);
      expect(c[0]).toBe(0xff);
      expect(c[1]).toBe(0xfb);
      totalAudio += c.byteLength;
    }
    expect(totalAudio).toBe(full.byteLength - id3Len);
  });

  it('MiMoAsrClient 超出分片上限时自动切分、多次请求上游并汇总文本与时长', async () => {
    const calls: UpstreamRequest[] = [];
    let idx = 0;
    const transport: Transport = {
      async send(req: UpstreamRequest): Promise<UpstreamResponse> {
        calls.push(req);
        idx += 1;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(
            JSON.stringify({
              id: `req-${idx}`,
              choices: [{ message: { content: `第${idx}段` } }],
              usage: { seconds: 12.5 },
            }),
            'utf8',
          ),
        };
      },
    };

    const client = new MiMoAsrClient({
      transport,
      headersProvider: async () => ({ authorization: 'Bearer test' }),
      maxChunkBytes: 400,
    });

    const wav = makePcmWav(1000, 4);
    const outcome = await client.transcribe({
      file: wav,
      filename: 'long.wav',
      format: 'wav',
    });

    expect(calls.length).toBeGreaterThan(2);
    expect(outcome.text).toBe('第1段 第2段 第3段');
    expect(outcome.seconds).toBe(37.5);
    expect(outcome.usage.units.audio_seconds?.billed).toBe(37.5);
  });
});
