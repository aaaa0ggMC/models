/**
 * storage/crypto/wrap.test.ts —— AES-256-KW 密钥包裹。
 *
 * 覆盖：往返、KEK 不对解不开、密文被改解不开、长度校验、指纹稳定性。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KW_AIV, kekFingerprint, randomDek, unwrapKey, wrapKey } from './wrap.js';

/** 固定的测试 KEK（指纹类断言需要可复现的输入）。 */
const KEK = Buffer.from(
  '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  'hex',
);

describe('AES-256-KW 包裹', () => {
  it('往返一致', () => {
    const dek = randomDek();
    const wrapped = wrapKey(KEK, dek);
    expect(wrapped.length).toBe(40);
    expect(unwrapKey(KEK, wrapped).equals(dek)).toBe(true);
  });

  it('匹配 RFC 3394 §4.1 官方向量（证明 Node 的 wrap 是真的 KW）', () => {
    // RFC 3394 §4.1：128-bit KEK 包 128-bit key data
    const kek = Buffer.from('000102030405060708090A0B0C0D0E0F', 'hex');
    const key = Buffer.from('00112233445566778899AABBCCDDEEFF', 'hex');
    const c = createCipheriv('id-aes128-wrap', kek, KW_AIV);
    const wrapped = Buffer.concat([c.update(key), c.final()]);
    expect(wrapped.toString('hex')).toBe('1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5');
    const d = createDecipheriv('id-aes128-wrap', kek, KW_AIV);
    expect(Buffer.concat([d.update(wrapped), d.final()]).equals(key)).toBe(true);
  });

  it('256-bit 情形与 Python cryptography.keywrap 交叉验证一致', () => {
    // 同一输入的 Node 结果与 Python `cryptography.hazmat.primitives.keywrap.aes_key_wrap`
    // 逐字节相同（见提交说明里的交叉验证记录）
    const kek = Buffer.from(Array.from({ length: 32 }, (_, i) => i).map((b) => b.toString(16).padStart(2, '0')).join(''), 'hex');
    const key = Buffer.from('00112233445566778899aabbccddeeff000102030405060708090a0b0c0d0e0f', 'hex');
    expect(wrapKey(kek, key).toString('hex')).toBe(
      '28c9f404c4b810f4cbccb35cfb87f8263f5786e2d80ed326cbc7f0e71a99f43bfb988b9b7a02dd21',
    );
  });

  it('AIV 是 RFC 3394 的固定常量', () => {
    expect(KW_AIV.toString('hex')).toBe('a6a6a6a6a6a6a6a6');
  });

  it('换 KEK 解不开（fail fast 而不是返回垃圾）', () => {
    const dek = randomDek();
    const wrapped = wrapKey(KEK, dek);
    expect(() => unwrapKey(randomBytes(32), wrapped)).toThrow();
  });

  it('改包裹结果一个字节 → 解不开', () => {
    const dek = randomDek();
    const wrapped = Buffer.from(wrapKey(KEK, dek));
    wrapped[3] = wrapped[3]! ^ 0x01;
    expect(() => unwrapKey(KEK, wrapped)).toThrow();
  });

  it('错误的 key / wrapped 长度被显式拒绝', () => {
    const dek = randomDek();
    expect(() => wrapKey(Buffer.alloc(16), dek)).toThrow(/KEK 长度/);
    expect(() => wrapKey(KEK, Buffer.alloc(16))).toThrow(/DEK 长度/);
    expect(() => unwrapKey(Buffer.alloc(16), Buffer.alloc(40))).toThrow(/KEK 长度/);
    expect(() => unwrapKey(KEK, Buffer.alloc(32))).toThrow(/40 字节/);
  });

  it('randomDek 每次不同且 32 字节', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const d = randomDek();
      expect(d.length).toBe(32);
      seen.add(d.toString('hex'));
    }
    expect(seen.size).toBe(50);
  });
});

describe('kekFingerprint', () => {
  it('同一 KEK → 同一指纹', () => {
    expect(kekFingerprint(KEK)).toBe(kekFingerprint(Buffer.from(KEK)));
  });

  it('不同 KEK → 不同指纹', () => {
    expect(kekFingerprint(KEK)).not.toBe(kekFingerprint(randomBytes(32)));
  });

  it('指纹是 16 hex 字符（SHA-256 前 8 字节）且**不含** KEK 本体', () => {
    const fp = kekFingerprint(KEK);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain(KEK.toString('hex').slice(0, 8));
  });
});
