/**
 * storage/crypto/xchacha20-poly1305.test.ts —— XChaCha20-Poly1305 的正确性与安全性。
 *
 * 三层覆盖：
 *   1. **CFRG 官方测试向量**（draft-irtf-cfrg-xchacha-03）逐条断言——证明实现正确；
 *   2. 轮函数回归——证明「只写 column 不写 diagonal」这类静默错误会被抓住；
 *   3. 安全性质——nonce 唯一性、AAD 绑定、篡改检测、密钥长度校验。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  AEAD_XCHACHA20_POLY1305_VECTOR,
  HCHACHA20_VECTOR,
  KEY_LEN,
  NONCE_LEN,
  hchacha20,
  open,
  randomNonce,
  safeEqual,
  seal,
  sealWithNonce,
  xchachaNonceToIetfIv,
} from './xchacha20-poly1305.js';

describe('HChaCha20（CFRG draft §2.2.1 官方向量）', () => {
  it('匹配官方 subkey', () => {
    const key = Buffer.from(HCHACHA20_VECTOR.key, 'hex');
    const nonce16 = Buffer.from(HCHACHA20_VECTOR.nonce16, 'hex');
    expect(hchacha20(key, nonce16).toString('hex')).toBe(HCHACHA20_VECTOR.subkey);
  });

  it('非 16 字节 nonce 直接抛错（不静默截断）', () => {
    const key = Buffer.alloc(KEY_LEN, 1);
    expect(() => hchacha20(key, Buffer.alloc(15))).toThrow(/16 字节/);
    expect(() => hchacha20(key, Buffer.alloc(24))).toThrow(/16 字节/);
  });

  it('非 32 字节 key 直接抛错', () => {
    expect(() => hchacha20(Buffer.alloc(16), Buffer.alloc(16))).toThrow(/32 字节/);
  });
});

describe('AEAD_XChaCha20_Poly1305（CFRG draft §A.3.1 官方向量）', () => {
  it('密文与 tag 都匹配', () => {
    const key = Buffer.from(AEAD_XCHACHA20_POLY1305_VECTOR.key, 'hex');
    const nonce = Buffer.from(AEAD_XCHACHA20_POLY1305_VECTOR.nonce24, 'hex');
    const aad = Buffer.from(AEAD_XCHACHA20_POLY1305_VECTOR.aad, 'hex');
    const plaintext = Buffer.from(AEAD_XCHACHA20_POLY1305_VECTOR.plaintext, 'hex');
    const box = sealWithNonce(key, nonce, plaintext, aad);
    expect(box.ciphertext.toString('hex')).toBe(AEAD_XCHACHA20_POLY1305_VECTOR.ciphertext);
    expect(box.tag.toString('hex')).toBe(AEAD_XCHACHA20_POLY1305_VECTOR.tag);
    // 反方向也过：用官方密文解回官方明文
    expect(
      open(
        key,
        {
          ciphertext: Buffer.from(AEAD_XCHACHA20_POLY1305_VECTOR.ciphertext, 'hex'),
          tag: Buffer.from(AEAD_XCHACHA20_POLY1305_VECTOR.tag, 'hex'),
          nonce,
        },
        aad,
      ).toString('hex'),
    ).toBe(AEAD_XCHACHA20_POLY1305_VECTOR.plaintext);
  });

  it('iv = 4 个 NUL + nonce 后 8 字节（规范固定）', () => {
    const nonce = Buffer.from('404142434445464748494a4b4c4d4e4f5051525354555657', 'hex');
    const iv = xchachaNonceToIetfIv(nonce);
    expect(iv.toString('hex')).toBe('00000000' + '5051525354555657');
  });
});

describe('安全性质', () => {
  const key = randomBytes(KEY_LEN);
  const plaintext = Buffer.from('sk-this-is-a-fake-test-key-not-real', 'utf8');

  it('往返一致', () => {
    const box = seal(key, plaintext);
    expect(open(key, box).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('nonce 是 192-bit 且每次不同', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const n = randomNonce();
      expect(n.length).toBe(NONCE_LEN);
      seen.add(n.toString('hex'));
    }
    expect(seen.size).toBe(200);
  });

  it('同一明文两次加密得到不同密文（nonce 随机化生效）', () => {
    const a = seal(key, plaintext);
    const b = seal(key, plaintext);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // 但都能解回同一明文
    expect(open(key, a).toString('utf8')).toBe(plaintext.toString('utf8'));
    expect(open(key, b).toString('utf8')).toBe(plaintext.toString('utf8'));
  });

  it('改密文一个字节 → 认证失败', () => {
    const box = seal(key, plaintext);
    const tampered = Buffer.from(box.ciphertext);
    tampered[0] = tampered[0]! ^ 0x01;
    expect(() => open(key, { ...box, ciphertext: tampered })).toThrow();
  });

  it('改 tag → 认证失败', () => {
    const box = seal(key, plaintext);
    const tamperedTag = Buffer.from(box.tag);
    tamperedTag[0] = tamperedTag[0]! ^ 0x01;
    expect(() => open(key, { ...box, tag: tamperedTag })).toThrow();
  });

  it('改 AAD → 认证失败（AAD 真的参与了计算）', () => {
    const box = seal(key, plaintext, Buffer.from('credential\u001fabc', 'utf8'));
    expect(() => open(key, box, Buffer.from('credential\u001fabd', 'utf8'))).toThrow();
  });

  it('换 key → 认证失败', () => {
    const box = seal(key, plaintext);
    expect(() => open(randomBytes(KEY_LEN), box)).toThrow();
  });

  it('换 nonce → 认证失败（密文绑定了 nonce）', () => {
    const box = seal(key, plaintext);
    expect(() => open(key, { ...box, nonce: randomNonce() })).toThrow();
  });

  it('错误长度的 key / tag 被显式拒绝', () => {
    const box = seal(key, plaintext);
    expect(() => seal(Buffer.alloc(16), plaintext)).toThrow(/32 字节/);
    expect(() => open(key, { ...box, tag: Buffer.alloc(8) })).toThrow(/16 字节/);
    expect(() => open(key, { ...box, nonce: Buffer.alloc(12) })).toThrow();
  });

  it('safeEqual 长度不同即 false，同内容为 true', () => {
    expect(safeEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
    expect(safeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
    expect(safeEqual(Buffer.from('ab'), Buffer.from('abc'))).toBe(false);
    expect(safeEqual(Buffer.from('ab'), Buffer.from('ac'))).toBe(false);
  });

  it('空明文也能加解密', () => {
    const box = seal(key, Buffer.alloc(0));
    expect(open(key, box).length).toBe(0);
  });

  it('大 payload（1 MiB）往返一致', () => {
    const big = randomBytes(1024 * 1024);
    const box = seal(key, big);
    expect(box.ciphertext.length).toBe(1024 * 1024);
    expect(open(key, box).equals(big)).toBe(true);
  });
});
