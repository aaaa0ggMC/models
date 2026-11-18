/**
 * tests/multipart.test.ts —— 自研 multipart/form-data 解析器的单测。
 *
 * 覆盖四类：**正常路径**（文件 + 文本字段、二进制内容不被切坏）、**边界**
 * （空体、只有结束边界、CRLF 严格性）、**文件名**（引号/转义/路径穿越/RFC 5987）、
 * **限额**（分片数 / 字段大小 / 文件大小 / 头部大小）。
 *
 * 为什么值得单测：这个解析器是 `/v1/audio/transcriptions` 的唯一入口，而它的输入是
 * **不可信字节**。分隔符扫描错一个字节，后果是"音频被切掉一块"——那种错在上游只表现
 * 为 400 或一段乱码转写，极难定位。宁可在这里把畸形输入全试一遍。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_MULTIPART_LIMITS,
  MultipartError,
  extractBoundary,
  optionalField,
  parseContentDisposition,
  parseMultipartFormData,
  requireFile,
  type ParsedFormData,
} from '../http/multipart.js';

const BOUNDARY = '----AgentGatewayTestBoundary';

/** 拼一个 multipart 体（测试自己写编码器：被解析的字节必须完全可控）。 */
function body(parts: Array<Record<string, unknown>>, boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const headers: string[] = [`--${boundary}\r\n`];
    if (part.file !== undefined) {
      headers.push(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
      );
      headers.push(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`);
      chunks.push(Buffer.from(headers.join(''), 'utf8'));
      const data =
        part.file instanceof Buffer ? part.file : Buffer.from(part.file as string, 'utf8');
      chunks.push(data);
      chunks.push(Buffer.from('\r\n', 'utf8'));
      continue;
    }
    headers.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
    chunks.push(Buffer.from(headers.join(''), 'utf8'));
    chunks.push(Buffer.from(part.value as string, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

const CT = `multipart/form-data; boundary=${BOUNDARY}`;

describe('multipart · 正常路径', () => {
  it('文件 + 文本字段都解出来，二进制内容一个字节不改', () => {
    // 0x00/0xFF/CR/LF 全齐：任何"按行切"的实现都会在这里出错
    const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x0d, 0x0a, 0x42, 0x4f]);
    const buf = body([
      { name: 'model', value: 'deepseek-asr' },
      { name: 'file', file: audio, filename: 'clip.wav' },
      { name: 'response_format', value: 'verbose_json' },
    ]);
    const parsed = parseMultipartFormData(buf, CT);
    expect(parsed.fields.get('model')).toBe('deepseek-asr');
    expect(parsed.fields.get('response_format')).toBe('verbose_json');
    expect(parsed.files).toHaveLength(1);
    const file = requireFile(parsed);
    expect(file.name).toBe('file');
    expect(file.filename).toBe('clip.wav');
    expect(file.content_type).toBe('application/octet-stream');
    expect(file.data.equals(audio)).toBe(true);
  });

  it('字段顺序无关（OpenAI SDK 把 model 放前面还是后面都能解）', () => {
    const a = body([
      { name: 'model', value: 'm' },
      { name: 'file', file: 'RIFF', filename: 'a.wav' },
    ]);
    const b = body([
      { name: 'file', file: 'RIFF', filename: 'a.wav' },
      { name: 'model', value: 'm' },
    ]);
    expect([...parseMultipartFormData(a, CT).fields.keys()]).toEqual(['model']);
    expect([...parseMultipartFormData(b, CT).fields.keys()]).toEqual(['model']);
  });

  it('没有 Content-Type 的文件分片回落 application/octet-stream', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n\r\nXYZ\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    expect(requireFile(parseMultipartFormData(raw, CT)).content_type).toBe(
      'application/octet-stream',
    );
  });

  it('边界带引号 / 大小写混写的 Content-Type 也认（RFC 与真实客户端都这么发）', () => {
    const raw = body([{ name: 'file', file: 'RIFF', filename: 'a.wav' }]);
    const parsed = parseMultipartFormData(raw, `Multipart/Form-Data; boundary="${BOUNDARY}"`);
    expect(requireFile(parsed).filename).toBe('a.wav');
  });
});

describe('multipart · 边界', () => {
  it('空体（只有结束边界）→ 0 个分片，不抛', () => {
    const parsed = parseMultipartFormData(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'), CT);
    expect(parsed.fields.size).toBe(0);
    expect(parsed.files).toHaveLength(0);
  });

  it('缺结束边界 → missing_terminator（不收半截请求）', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n`,
      'utf8',
    );
    expect(() => parseMultipartFormData(raw, CT)).toThrow(/缺少结束边界/);
  });

  it('体不是以边界开头（前导空白）→ malformed_body', () => {
    const raw = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8');
    expect(() => parseMultipartFormData(raw, CT)).toThrow(/不是以边界开头/);
  });

  it('LF-only 分隔符 → malformed_body（不猜：猜错会把音频切错位置）', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\nContent-Disposition: form-data; name="model"\n\nm\n--${BOUNDARY}--\n`,
      'utf8',
    );
    expect(() => parseMultipartFormData(raw, CT)).toThrow(MultipartError);
  });

  it('分片里没有头尾分隔 → malformed_body', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="model"\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    expect(() => parseMultipartFormData(raw, CT)).toThrow(/头部与主体的分隔/);
  });

  it('分片缺 Content-Disposition → bad_content_disposition', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nm\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    expect(() => parseMultipartFormData(raw, CT)).toThrow(/Content-Disposition/);
  });

  it('分片没有 name 参数 → bad_content_disposition', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; filename="a.wav"\r\n\r\nm\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    expect(() => parseMultipartFormData(raw, CT)).toThrow(/缺少 name/);
  });
});

describe('multipart · Content-Type 头', () => {
  it('不是 multipart/form-data → unsupported_media_type', () => {
    expect(() => extractBoundary('application/json')).toThrow(/multipart\/form-data/);
    expect(() => extractBoundary(undefined)).toThrow(/multipart\/form-data/);
  });

  it('缺 boundary 参数 → missing_boundary', () => {
    expect(() => extractBoundary('multipart/form-data')).toThrow(/boundary/);
  });

  it('boundary 超长 / 含非法字符 → bad_boundary', () => {
    expect(() => extractBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toThrow(
      /70 字符/,
    );
    expect(() => extractBoundary('multipart/form-data; boundary=a"b')).toThrow(/非法字符/);
  });
});

describe('multipart · 文件名', () => {
  it('引号内的分号不切断参数', () => {
    const cd = 'form-data; name="file"; filename="a;b.wav"';
    expect(parseContentDisposition(cd)).toEqual({ name: 'file', filename: 'a;b.wav' });
  });

  it('反斜杠转义被解开（否则文件名会多一个反斜杠）', () => {
    const cd = 'form-data; name="file"; filename="a\\"b.wav"';
    expect(parseContentDisposition(cd).filename).toBe('a"b.wav');
  });

  it('CRLF 进不了文件名（否则能往上游头里注入行）', () => {
    // 文件名里的 CRLF 会提前结束 Content-Disposition 行：结果只是文件名被截断，
    // 注入的内容变成一条没有冒号的"头"被忽略——既不报错也不放行
    const raw = body([{ name: 'file', file: 'RIFF', filename: 'a\r\nX-Evil: 1' }]);
    const parsed = parseMultipartFormData(raw, CT);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.filename).toBe('a');
    expect(parsed.fields.size).toBe(0);
  });

  it('路径穿越被削成裸文件名（../ 不进任何下游）', () => {
    const raw = body([{ name: 'file', file: 'RIFF', filename: '../../etc/passwd' }]);
    const file = requireFile(parseMultipartFormData(raw, CT));
    expect(file.filename).toBe('passwd');
  });

  it('非 ASCII 文件名被替换成下划线（内容探测按字节，不看文件名）', () => {
    const raw = body([{ name: 'file', file: 'RIFF', filename: '音频.wav' }]);
    expect(requireFile(parseMultipartFormData(raw, CT)).filename).toBe('__.wav');
  });

  it('RFC 5987 的 filename* 优先（percent-decoded）', () => {
    const cd = 'form-data; name="file"; filename="fallback.bin"; filename*=UTF-8\'\'%E9%9F%B3.wav';
    expect(parseContentDisposition(cd).filename).toBe('音.wav');
  });

  it('空 filename 当作纯文本字段（没有文件内容可给）', () => {
    const raw = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename=""\r\n\r\nm\r\n--${BOUNDARY}--\r\n`,
      'utf8',
    );
    const parsed = parseMultipartFormData(raw, CT);
    expect(parsed.files).toHaveLength(0);
    expect(parsed.fields.get('file')).toBe('m');
  });
});

describe('multipart · 限额', () => {
  it('分片数超限 → too_many_parts', () => {
    const parts = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, value: 'x' }));
    const raw = body(parts);
    expect(() =>
      parseMultipartFormData(raw, CT, { ...DEFAULT_MULTIPART_LIMITS, max_parts: 3 }),
    ).toThrow(/分片超过 3 个/);
  });

  it('文本字段超限 → part_too_large', () => {
    const raw = body([{ name: 'prompt', value: 'x'.repeat(1024) }]);
    expect(() =>
      parseMultipartFormData(raw, CT, { ...DEFAULT_MULTIPART_LIMITS, max_field_bytes: 256 }),
    ).toThrow(/字段 prompt 超过 256 字节/);
  });

  it('文件超限 → part_too_large（在拷贝之前就拦，不先攒内存）', () => {
    const raw = body([{ name: 'file', file: 'x'.repeat(4096), filename: 'big.wav' }]);
    expect(() =>
      parseMultipartFormData(raw, CT, { ...DEFAULT_MULTIPART_LIMITS, max_file_bytes: 1024 }),
    ).toThrow(/文件 file 超过 1024 字节/);
  });

  it('分片头部超限 → headers_too_large', () => {
    const raw = body([{ name: 'file', file: 'RIFF', filename: `a${'b'.repeat(512)}.wav` }]);
    expect(() =>
      parseMultipartFormData(raw, CT, { ...DEFAULT_MULTIPART_LIMITS, max_header_bytes: 128 }),
    ).toThrow(/头部超过 128 字节/);
  });

  it('默认限额下 8 MiB 文件可过（对齐上游 ASR 上限）', () => {
    const raw = body([{ name: 'file', file: 'x'.repeat(1024), filename: 'ok.wav' }]);
    expect(requireFile(parseMultipartFormData(raw, CT)).data.byteLength).toBe(1024);
  });
});

describe('multipart · 取字段的小工具', () => {
  it('requireFile 缺 file → missing_file（一句话说清缺哪个字段）', () => {
    const parsed: ParsedFormData = { fields: new Map([['model', 'm']]), files: [] };
    expect(() => requireFile(parsed)).toThrow(/缺少 file 文件字段/);
  });

  it('optionalField 区分"没传"与"传了空串"', () => {
    const parsed = parseMultipartFormData(
      body([
        { name: 'language', value: '' },
        { name: 'model', value: 'm' },
      ]),
      CT,
    );
    expect(optionalField(parsed, 'language')).toBe('');
    expect(optionalField(parsed, 'prompt')).toBeUndefined();
  });

  it('同名文本字段后者覆盖前者（OpenAI 转写请求没有同名字段，不报错）', () => {
    const parsed = parseMultipartFormData(
      body([
        { name: 'model', value: 'first' },
        { name: 'model', value: 'second' },
      ]),
      CT,
    );
    expect(parsed.fields.get('model')).toBe('second');
  });
});
