/**
 * gateway-core/audio-chunker.ts —— 通用（provider 无关）音频切片工具。
 *
 * 职责：当客户端上传的 WAV / MP3 音频超过上游单次请求体积上限时，在不依赖
 * ffmpeg 等外部二进制的前提下，按容器帧边界无损切分为多段合规音频，供上层
 * adaptor 透明分段转写并合并结果。
 *
 * 约束：本模块属于 gateway-core，不引入任何 `providers/*` 或 `ir/*` 之外的业务语义。
 */

const MPEG_SAMPLE_RATES: Record<number, readonly [number, number, number]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

// Layer III (MP3) bitrate table (kbps), index 1..14
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset]! |
      (buf[offset + 1]! << 8) |
      (buf[offset + 2]! << 16) |
      (buf[offset + 3]! << 24)) >>>
    0
  );
}

function writeU32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8);
}

function asciiAt(buf: Uint8Array, offset: number, len = 4): string {
  let s = '';
  for (let i = 0; i < len && offset + i < buf.length; i += 1) {
    s += String.fromCharCode(buf[offset + i]!);
  }
  return s;
}

/**
 * 按 RIFF/WAVE 的 `blockAlign` 边界切分 PCM WAV 音频，每段生成合法的独立 WAV 头。
 */
export function splitWavIntoChunks(file: Uint8Array, maxChunkBytes: number): Uint8Array[] {
  if (file.byteLength <= maxChunkBytes || file.byteLength < 44) return [file];
  if (asciiAt(file, 0, 4) !== 'RIFF' || asciiAt(file, 8, 4) !== 'WAVE') {
    return [file];
  }

  let fmtChunk: Uint8Array | undefined;
  let blockAlign = 4;
  let dataOffset = -1;
  let dataSize = 0;

  let pos = 12;
  while (pos + 8 <= file.byteLength) {
    const id = asciiAt(file, pos, 4);
    const size = readU32LE(file, pos + 4);
    const bodyStart = pos + 8;
    const bodyEnd = Math.min(file.byteLength, bodyStart + size);
    if (id === 'fmt ' && bodyStart + 16 <= bodyEnd) {
      fmtChunk = file.subarray(pos, bodyEnd);
      const parsedAlign = readU16LE(file, bodyStart + 12);
      if (parsedAlign > 0) blockAlign = parsedAlign;
    } else if (id === 'data') {
      dataOffset = bodyStart;
      dataSize = bodyEnd - bodyStart;
      break;
    }
    // RIFF 子块按偶数字节对齐
    pos = bodyStart + size + (size % 2);
  }

  if (fmtChunk === undefined || dataOffset < 0 || dataSize <= 0) {
    return [file];
  }

  const headerLen = 12 + fmtChunk.length + 8;
  const rawBudget = maxChunkBytes - headerLen;
  if (rawBudget < blockAlign) return [file];

  const maxDataPerChunk = Math.floor(rawBudget / blockAlign) * blockAlign;
  if (maxDataPerChunk <= 0 || dataSize <= maxDataPerChunk) {
    return [file];
  }

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < dataSize; offset += maxDataPerChunk) {
    const end = Math.min(dataSize, offset + maxDataPerChunk);
    const sliceLen = end - offset;
    const out = new Uint8Array(headerLen + sliceLen);

    // "RIFF" + riffSize + "WAVE"
    out.set([0x52, 0x49, 0x46, 0x46], 0);
    writeU32LE(out, 4, 4 + fmtChunk.length + 8 + sliceLen);
    out.set([0x57, 0x41, 0x56, 0x45], 8);

    // 原样保留 fmt 块
    out.set(fmtChunk, 12);

    // "data" + sliceLen + PCM 采样字节
    const dataHeaderPos = 12 + fmtChunk.length;
    out.set([0x64, 0x61, 0x74, 0x61], dataHeaderPos);
    writeU32LE(out, dataHeaderPos + 4, sliceLen);
    out.set(file.subarray(dataOffset + offset, dataOffset + end), dataHeaderPos + 8);

    chunks.push(out);
  }

  return chunks.length > 0 ? chunks : [file];
}

function parseMpegFrameLength(buf: Uint8Array, offset: number): number | null {
  if (offset + 4 > buf.length) return null;
  const b0 = buf[offset]!;
  const b1 = buf[offset + 1]!;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  // layer 1 = Layer III, version 1 = reserved
  if (version === 1 || layer !== 1) return null;

  const b2 = buf[offset + 2]!;
  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;

  if (bitrateIdx === 0 || bitrateIdx === 15 || sampleRateIdx === 3) return null;
  const sampleRates = MPEG_SAMPLE_RATES[version];
  if (!sampleRates) return null;
  const sampleRate = sampleRates[sampleRateIdx]!;
  const bitrateKbps =
    version === 3 ? MPEG1_L3_BITRATES[bitrateIdx]! : MPEG2_L3_BITRATES[bitrateIdx]!;
  if (bitrateKbps <= 0 || sampleRate <= 0) return null;

  const coeff = version === 3 ? 144 : 72;
  const frameLen = Math.floor((coeff * bitrateKbps * 1000) / sampleRate) + padding;
  return frameLen >= 4 ? frameLen : null;
}

/**
 * 按 MPEG Layer III 帧边界切分 MP3 音频，跳过前导 ID3v2 标签，保证每段可独立解码。
 */
export function splitMp3IntoChunks(file: Uint8Array, maxChunkBytes: number): Uint8Array[] {
  if (file.byteLength <= maxChunkBytes || file.byteLength < 16) return [file];

  let pos = 0;
  // 跳过前导 ID3v2 标签（如存在）
  if (file.byteLength >= 10 && asciiAt(file, 0, 3) === 'ID3') {
    const tagSize =
      ((file[6]! & 0x7f) << 21) |
      ((file[7]! & 0x7f) << 14) |
      ((file[8]! & 0x7f) << 7) |
      (file[9]! & 0x7f);
    pos = Math.min(file.byteLength, 10 + tagSize);
  }

  // 定位首个合法 MPEG 帧头
  while (pos + 4 <= file.byteLength && parseMpegFrameLength(file, pos) === null) {
    pos += 1;
  }
  if (pos + 4 > file.byteLength) return [file];

  const chunks: Uint8Array[] = [];
  let chunkStart = pos;
  let cursor = pos;

  while (cursor + 4 <= file.byteLength) {
    const frameLen = parseMpegFrameLength(file, cursor);
    if (frameLen === null || cursor + frameLen > file.byteLength) {
      break;
    }
    if (cursor - chunkStart + frameLen > maxChunkBytes && cursor > chunkStart) {
      chunks.push(file.subarray(chunkStart, cursor));
      chunkStart = cursor;
    }
    cursor += frameLen;
  }

  if (cursor > chunkStart) {
    chunks.push(file.subarray(chunkStart, cursor));
  }

  return chunks.length > 0 ? chunks : [file];
}

/**
 * 按音频容器格式切分为不超过 `maxChunkBytes` 的独立片段。
 */
export function splitAudioIntoChunks(
  file: Uint8Array,
  format: 'mp3' | 'wav',
  maxChunkBytes: number,
): Uint8Array[] {
  if (file.byteLength <= maxChunkBytes) return [file];
  return format === 'wav'
    ? splitWavIntoChunks(file, maxChunkBytes)
    : splitMp3IntoChunks(file, maxChunkBytes);
}
