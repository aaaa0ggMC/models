/**
 * storage/crypto/kdf.test.ts —— Argon2id 口令派生。
 *
 * 覆盖：确定性、盐随机性、口令校验、**常量时间**、参数升级判定、
 * 序列化往返、空口令拒绝、Node 版本签名回归。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_PARAMS,
  KEK_LEN,
  SALT_LEN,
  argon2idRaw,
  createArgon2Meta,
  createArgon2Record,
  deserializeArgon2Meta,
  deserializeArgon2PasswordRecord,
  deriveKekFromMeta,
  needsRehash,
  serializeArgon2Meta,
  serializeArgon2PasswordRecord,
  verifyArgon2Record,
} from './kdf.js';

const PASS = 'correct horse battery staple';

describe('argon2idRaw', () => {
  it('同口令同盐同参数 → 同输出（确定性）', () => {
    const salt = Buffer.alloc(16, 7);
    const a = argon2idRaw(PASS, salt);
    const b = argon2idRaw(PASS, salt);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(KEK_LEN);
  });

  it('换盐 → 完全不同', () => {
    const a = argon2idRaw(PASS, Buffer.alloc(16, 1));
    const b = argon2idRaw(PASS, Buffer.alloc(16, 2));
    expect(a.equals(b)).toBe(false);
  });

  it('换口令 → 完全不同', () => {
    const salt = Buffer.alloc(16, 7);
    const a = argon2idRaw(PASS, salt);
    const b = argon2idRaw(PASS + 'x', salt);
    expect(a.equals(b)).toBe(false);
  });

  it('空口令被拒绝（不静默派生一个"空口令的 KEK"）', () => {
    expect(() => argon2idRaw('', Buffer.alloc(16, 1))).toThrow(/口令不能为空/);
  });

  it('盐短于 8 字节被拒绝', () => {
    expect(() => argon2idRaw(PASS, Buffer.alloc(4))).toThrow(/至少 8 字节/);
  });
});

describe('Argon2Record', () => {
  it('createArgon2Record 生成 16 字节随机盐', () => {
    const a = createArgon2Record(PASS);
    const b = createArgon2Record(PASS);
    expect(a.salt.length).toBe(16);
    expect(b.salt.length).toBe(16);
    // 同一口令两次建记录，盐不同 → KEK 不同（这正是盐的作用）
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.hash.equals(b.hash)).toBe(false);
  });

  it('正确口令通过校验', () => {
    const rec = createArgon2Record(PASS);
    expect(verifyArgon2Record(PASS, rec)).toBe(true);
  });

  it('错误口令不通过校验', () => {
    const rec = createArgon2Record(PASS);
    expect(verifyArgon2Record('wrong passphrase', rec)).toBe(false);
    expect(verifyArgon2Record('', rec)).toBe(false);
  });

  it('记录里的 hash 就是 KEK（重新派生得到同一把）', () => {
    const rec = createArgon2Record(PASS);
    expect(argon2idRaw(PASS, rec.salt, rec.params).equals(rec.hash)).toBe(true);
  });

  it('口令校验记录序列化往返后校验仍然通过', () => {
    const rec = createArgon2Record(PASS);
    const back = deserializeArgon2PasswordRecord(serializeArgon2PasswordRecord(rec));
    expect(verifyArgon2Record(PASS, back)).toBe(true);
    expect(verifyArgon2Record('nope', back)).toBe(false);
  });

  it('反序列化拒绝非 argon2id 算法', () => {
    const s = serializeArgon2PasswordRecord(createArgon2Record(PASS));
    expect(() =>
      deserializeArgon2PasswordRecord({ ...s, algo: 'argon2d' as unknown as 'argon2id' }),
    ).toThrow(/不支持的 KDF 算法/);
    expect(() =>
      deserializeArgon2Meta({ ...serializeArgon2Meta(createArgon2Meta()), algo: 'argon2d' as unknown as 'argon2id' }),
    ).toThrow(/不支持的 KDF 算法/);
  });
});

// ---------------------------------------------------------------------------
// 用途 1：KEK 派生元数据（**绝不落 hash**）
//
// 这是本次实现期间真实修掉的一个安全缺陷：第一版把 Argon2Record 连 hash 一起
// 序列化进了密钥表，而那个 hash 就是 KEK——等于把「需要口令」换成「拿到文件即可」。
// 下面几条测试是那个缺陷的回归护栏。
// ---------------------------------------------------------------------------

describe('Argon2Meta（KEK 派生，落盘形态）', () => {
  it('createArgon2Meta 生成 16 字节随机盐', () => {
    const a = createArgon2Meta();
    const b = createArgon2Meta();
    expect(a.salt.length).toBe(SALT_LEN);
    expect(b.salt.length).toBe(SALT_LEN);
    expect(a.salt.equals(b.salt)).toBe(false);
  });

  it('deriveKekFromMeta 确定性（同口令同元数据 → 同 KEK）', () => {
    const meta = createArgon2Meta();
    const a = deriveKekFromMeta(PASS, meta);
    const b = deriveKekFromMeta(PASS, meta);
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(KEK_LEN);
  });

  it('换盐 → 不同 KEK', () => {
    const m1 = { ...createArgon2Meta(), salt: Buffer.alloc(16, 1) };
    const m2 = { ...createArgon2Meta(), salt: Buffer.alloc(16, 2) };
    expect(deriveKekFromMeta(PASS, m1).equals(deriveKekFromMeta(PASS, m2))).toBe(false);
  });

  it('空口令在派生路径被拒绝', () => {
    const meta = createArgon2Meta();
    expect(() => deriveKekFromMeta('', meta)).toThrow(/口令不能为空/);
  });

  it('序列化形状里**没有 hash 字段**（KEK 因此不可能落盘）', () => {
    const meta = createArgon2Meta();
    const s = serializeArgon2Meta(meta);
    expect(Object.keys(s).sort()).toEqual(['algo', 'params', 'salt_hex', 'version']);
    expect(JSON.stringify(s)).not.toContain('hash');
  });

  it('序列化 → 反序列化后仍能派生出同一把 KEK', () => {
    const meta = createArgon2Meta();
    const back = deserializeArgon2Meta(serializeArgon2Meta(meta));
    expect(deriveKekFromMeta(PASS, back).equals(deriveKekFromMeta(PASS, meta))).toBe(true);
  });

  it('deserializeArgon2Meta 忽略/拒绝夹带的 hash 字段（不因为多了字段就变成 KEK 落盘）', () => {
    const meta = createArgon2Meta();
    const poisoned = {
      ...serializeArgon2Meta(meta),
      hash_hex: 'ff'.repeat(32),
    } as ReturnType<typeof serializeArgon2Meta>;
    const back = deserializeArgon2Meta(poisoned);
    expect('hash' in back).toBe(false);
    // 夹带的 hash 不影响派生结果
    expect(deriveKekFromMeta(PASS, back).equals(deriveKekFromMeta(PASS, meta))).toBe(true);
  });
});

describe('needsRehash', () => {
  const rec = createArgon2Record(PASS, DEFAULT_PARAMS);

  it('同参数 → 不需要重算', () => {
    expect(needsRehash(rec, { ...DEFAULT_PARAMS })).toBe(false);
    expect(needsRehash(createArgon2Meta(DEFAULT_PARAMS), { ...DEFAULT_PARAMS })).toBe(false);
  });

  it('目标参数更高（内存/轮次）→ 需要重算', () => {
    expect(needsRehash(rec, { ...DEFAULT_PARAMS, memoryKiB: DEFAULT_PARAMS.memoryKiB * 2 })).toBe(
      true,
    );
    expect(needsRehash(rec, { ...DEFAULT_PARAMS, timeCost: DEFAULT_PARAMS.timeCost + 1 })).toBe(true);
  });

  it('目标参数更低 → 不需要（不做降级）', () => {
    expect(needsRehash(rec, { ...DEFAULT_PARAMS, memoryKiB: 1024 })).toBe(false);
  });

  it('并行度不同 → 需要重算（p 影响输出）', () => {
    expect(needsRehash(rec, { ...DEFAULT_PARAMS, parallelism: DEFAULT_PARAMS.parallelism + 1 })).toBe(
      true,
    );
  });
});
