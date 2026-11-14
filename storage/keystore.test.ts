/**
 * storage/keystore.test.ts —— 密钥管理：两种解锁模式、DEK 轮换、KEK 轮换、canary。
 *
 * 这是本模块**最重要的测试文件**：它证明「加密/轮换/nonce 安全性」不是嘴上说的。
 * 关键断言：
 *   - DEK 是随机生成的（不是从 KEK 派生的）；
 *   - 轮换 KEK **不重加密数据**（数据密文逐字节不变）；
 *   - 口令错 / KEK 错 → fail fast，绝不静默建新库；
 *   - 轮换 DEK 后旧记录仍可读；
 *   - 密钥不明文落盘（序列化结果里搜不到 KEK / 口令）。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
  CANARY_PLAINTEXT,
  Keystore,
  KeystoreLockedError,
  KeyFileKekSource,
  PassphraseKekSource,
  ROTATE_AFTER_ENCRYPTIONS,
  deserializeKeystoreFile,
  serializeKeystoreFile,
  type KeyFileReader,
  type KeyFileWriter,
  type KeystoreFile,
} from './keystore.js';
import { deriveKekFromMeta } from './crypto/kdf.js';
import { unwrapKey } from './crypto/wrap.js';

const PASS = 'test-passphrase-not-a-real-secret';
const NOW = 1_700_000_000_000;

/** 内存 key 文件（测试不碰磁盘）。文件内容是 KEK 的 **hex 文本**（0600 文件同格式）。 */
class MemoryKeyFile implements KeyFileReader, KeyFileWriter {
  private content: Buffer | undefined;

  async read(): Promise<Buffer | undefined> {
    return this.content === undefined ? undefined : Buffer.from(this.content);
  }

  async write(kek: Buffer): Promise<void> {
    this.content = Buffer.from(kek.toString('hex'), 'utf8');
  }
}

async function unlockNew(passphrase = PASS): Promise<Keystore> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, NOW);
  await ks.unlock(passphrase);
  return ks;
}

describe('首次建库', () => {
  it('建库后生成一把 active DEK + canary', async () => {
    const ks = await unlockNew();
    const file = ks.unlocked().serialize();
    expect(file.deks).toHaveLength(1);
    expect(file.deks[0]!.status).toBe('active');
    expect(file.canary.dek_id).toBe(file.deks[0]!.dek_id);
    expect(file.unlock_mode).toBe('passphrase');
    expect(file.argon2).toBeDefined();
  });

  it('DEK 是随机的（两次建库得到不同 DEK，且不等于 KEK）', async () => {
    const a = await unlockNew();
    const b = await unlockNew();
    const fa = a.unlocked().serialize();
    const fb = b.unlocked().serialize();
    expect(fa.deks[0]!.wrapped.equals(fb.deks[0]!.wrapped)).toBe(false);

    // 解开看看：DEK != KEK（KEK = Argon2id(口令)）
    const kek = deriveKekFromMeta(PASS, {
      algo: 'argon2id',
      version: 19,
      params: fa.argon2!.params,
      salt: Buffer.from(fa.argon2!.salt_hex, 'hex'),
    });
    const dek = unwrapKey(kek, fa.deks[0]!.wrapped);
    expect(dek.equals(kek)).toBe(false);
  });

  it('canary 明文是固定已知值（65 §3.3 第 4 条）', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const box = u.encrypt('meta', 'canary-probe', Buffer.from(CANARY_PLAINTEXT, 'utf8'));
    expect(u.decrypt('meta', 'canary-probe', box).toString('utf8')).toBe(CANARY_PLAINTEXT);
  });
});

describe('解锁已有库', () => {
  it('正确口令能解开，且 DEK 不变', async () => {
    const first = await unlockNew();
    const file = serializeKeystoreFile(first.unlocked().serialize());
    const before = file.deks[0]!.wrapped_hex;

    const second = new Keystore(new PassphraseKekSource(), deserializeKeystoreFile(file), NOW);
    await second.unlock(PASS);
    expect(serializeKeystoreFile(second.unlocked().serialize()).deks[0]!.wrapped_hex).toBe(before);
  });

  it('错误口令 → KeystoreLockedError，**不建新库**', async () => {
    // 口令错 → KEK 错 → AES-256-KW 的 AIV 完整性校验失败 → 抛错。
    // 关键是：没有静默产生一把新 DEK 把旧数据覆盖掉（65 §3.3 第 4 条）。
    const first = await unlockNew();
    const file = serializeKeystoreFile(first.unlocked().serialize());
    const second = new Keystore(new PassphraseKekSource(), deserializeKeystoreFile(file), NOW);
    await expect(second.unlock('wrong-passphrase')).rejects.toThrow(KeystoreLockedError);
    expect(second.locked).toBe(true);
  });

  it('空口令也解不开（不会因为空串巧合命中）', async () => {
    const first = await unlockNew();
    const file = serializeKeystoreFile(first.unlocked().serialize());
    const second = new Keystore(new PassphraseKekSource(), deserializeKeystoreFile(file), NOW);
    await expect(second.unlock('')).rejects.toThrow(KeystoreLockedError);
  });

  it('KEK 对但 DEK 被改 → KeystoreLockedError（fail fast）', async () => {
    const first = await unlockNew();
    const file = first.unlocked().serialize();
    // 破坏 wrapped DEK：KW 的 AIV 完整性校验会失败
    const broken: KeystoreFile = {
      ...file,
      deks: [{ ...file.deks[0]!, wrapped: Buffer.alloc(40, 0xab) }],
    };
    const second = new Keystore(new PassphraseKekSource(), broken, NOW);
    await expect(second.unlock(PASS)).rejects.toThrow(KeystoreLockedError);
  });

  it('key_file 模式：换一个 KEK 文件就解不开（且不建新库）', async () => {
    const keyFile = new MemoryKeyFile();
    const originalKek = randomBytes(32);
    await keyFile.write(originalKek);

    const first = new Keystore(new KeyFileKekSource(keyFile), undefined, NOW);
    await first.unlock();
    const file = serializeKeystoreFile(first.unlocked().serialize());

    // 换成另一把 KEK
    await keyFile.write(randomBytes(32));
    const second = new Keystore(new KeyFileKekSource(keyFile), deserializeKeystoreFile(file), NOW);
    await expect(second.unlock()).rejects.toThrow(KeystoreLockedError);
  });

  it('key_file 模式：同一个 KEK 文件能重新解锁', async () => {
    const keyFile = new MemoryKeyFile();
    await keyFile.write(randomBytes(32));
    const first = new Keystore(new KeyFileKekSource(keyFile), undefined, NOW);
    await first.unlock();
    const file = serializeKeystoreFile(first.unlocked().serialize());
    const second = new Keystore(new KeyFileKekSource(keyFile), deserializeKeystoreFile(file), NOW);
    await second.unlock();
    expect(second.locked).toBe(false);
  });

  it('key_file 缺失 → 明确报错并提示初始化命令', async () => {
    const ks = new Keystore(new KeyFileKekSource(new MemoryKeyFile()), undefined, NOW);
    await expect(ks.unlock()).rejects.toThrow(/keystore init/);
  });
});

describe('KEK 轮换（65 §3.1 设计风险 1 的定稿解法）', () => {
  it('轮换 KEK 只重包 DEK，**数据密文逐字节不变**', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();

    // 先加密几条记录
    const boxA = u.encrypt('credential', 'cred_1', Buffer.from('secret-A', 'utf8'));
    const boxB = u.encrypt('credential', 'cred_2', Buffer.from('secret-B', 'utf8'));
    const ctBefore = boxA.ciphertext.toString('hex');
    const tagBefore = boxA.tag.toString('hex');

    const dekIdBefore = u.activeDekId;
    const wrappedBefore = u.serialize().deks[0]!.wrapped.toString('hex');

    // 轮换 KEK
    u.rotateKek(randomBytes(32), NOW + 1);
    const wrappedAfter = u.serialize().deks[0]!.wrapped.toString('hex');
    expect(wrappedAfter).not.toBe(wrappedBefore);

    // 同一把 DEK 还在（dek_id 没变）
    expect(u.activeDekId).toBe(dekIdBefore);

    // 旧记录仍能解出同一明文（DEK 没换，所以密文不用动）
    expect(u.decrypt('credential', 'cred_1', boxA).toString('utf8')).toBe('secret-A');
    expect(u.decrypt('credential', 'cred_2', boxB).toString('utf8')).toBe('secret-B');
    expect(boxA.ciphertext.toString('hex')).toBe(ctBefore);
    expect(boxA.tag.toString('hex')).toBe(tagBefore);

    // 新记录用同一把 DEK 加密，与旧记录共存无冲突
    const boxC = u.encrypt('credential', 'cred_3', Buffer.from('secret-C', 'utf8'));
    expect(boxC.dek_id).toBe(dekIdBefore);
  });

  it('轮换 KEK 后旧 KEK 解不开新包裹的 DEK', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const oldWrapped = u.serialize().deks[0]!.wrapped;
    const argon2 = u.serialize().argon2!;
    const oldKek = deriveKekFromMeta(PASS, {
      algo: 'argon2id',
      version: 19,
      params: argon2.params,
      salt: Buffer.from(argon2.salt_hex, 'hex'),
    });
    expect(unwrapKey(oldKek, oldWrapped).length).toBe(32);

    u.rotateKek(randomBytes(32), NOW + 1);
    const newWrapped = u.serialize().deks[0]!.wrapped;
    expect(() => unwrapKey(oldKek, newWrapped)).toThrow();
  });
});

describe('DEK 轮换', () => {
  it('轮换后旧记录仍可读，新记录用新 DEK', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const oldBox = u.encrypt('credential', 'cred_old', Buffer.from('old-secret', 'utf8'));

    const newId = u.rotateDek(NOW + 10);
    expect(newId).not.toBe(oldBox.dek_id);
    expect(u.activeDekId).toBe(newId);
    expect(u.isCurrentDek(oldBox.dek_id)).toBe(false);

    // 旧记录照样解得出
    expect(u.decrypt('credential', 'cred_old', oldBox).toString('utf8')).toBe('old-secret');

    // 新记录用新 DEK
    const newBox = u.encrypt('credential', 'cred_new', Buffer.from('new-secret', 'utf8'));
    expect(newBox.dek_id).toBe(newId);
    expect(u.decrypt('credential', 'cred_new', newBox).toString('utf8')).toBe('new-secret');

    // 密钥表里两把 DEK 都在，旧的那把转 retired
    const deks = u.serialize().deks;
    expect(deks).toHaveLength(2);
    expect(deks.find((d) => d.dek_id === oldBox.dek_id)!.status).toBe('retired');
    expect(deks.find((d) => d.dek_id === newId)!.status).toBe('active');
  });

  it('引用不存在的 DEK → 明确报错（不是返回垃圾）', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const box = u.encrypt('credential', 'x', Buffer.from('v', 'utf8'));
    expect(() => u.decrypt('credential', 'x', { ...box, dek_id: 'dek_does_not_exist' })).toThrow(
      /密钥表里没有 DEK/,
    );
  });

  it('encryptionCount 累计；阈值即 ROTATE_AFTER_ENCRYPTIONS', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    expect(u.encryptionCount()).toBe(0);
    expect(u.shouldRotateDek()).toBe(false);
    for (let i = 0; i < 5; i += 1) u.encrypt('audit', `a${i}`, Buffer.from('x', 'utf8'));
    expect(u.encryptionCount()).toBe(5);
    expect(u.shouldRotateDek()).toBe(false);
    expect(ROTATE_AFTER_ENCRYPTIONS).toBe(2 ** 20);
  });
});

describe('AAD 绑定（密文换位/重放防护）', () => {
  it('A 记录的密文拿到 B 的 id 下解不开', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const box = u.encrypt('credential', 'cred_a', Buffer.from('secret', 'utf8'));
    expect(() => u.decrypt('credential', 'cred_b', box)).toThrow();
    // 用对的 id 就解得出
    expect(u.decrypt('credential', 'cred_a', box).toString('utf8')).toBe('secret');
  });

  it('跨 kind 也解不开（kind 进了 AAD）', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const box = u.encrypt('credential', 'same_id', Buffer.from('secret', 'utf8'));
    expect(() => u.decrypt('alias', 'same_id', box)).toThrow();
  });
});

describe('Argon2 参数升级', () => {
  it('needsArgon2Rehash 判定 + rehash 后旧数据仍可读', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const box = u.encrypt('credential', 'cred_1', Buffer.from('secret', 'utf8'));

    expect(ks.needsArgon2Rehash({ memoryKiB: 19_456, timeCost: 2, parallelism: 1 })).toBe(false);
    expect(ks.needsArgon2Rehash({ memoryKiB: 65_536, timeCost: 2, parallelism: 1 })).toBe(true);

    await ks.rehashArgon2(PASS, { memoryKiB: 65_536, timeCost: 2, parallelism: 1 }, NOW + 5);
    // 参数升级后：换了新盐 → KEK 变 → DEK 被重包；但 DEK 本身没变 → 数据仍可读
    expect(u.decrypt('credential', 'cred_1', box).toString('utf8')).toBe('secret');
    expect(u.serialize().argon2!.params.memoryKiB).toBe(65_536);
    // 升级后旧口令解不开新库（盐也换了），但新库用同一口令能重开
    const upgraded = serializeKeystoreFile(u.serialize());
    const reopened = new Keystore(
      new PassphraseKekSource(),
      deserializeKeystoreFile(upgraded),
      NOW,
    );
    await reopened.unlock(PASS);
    expect(reopened.locked).toBe(false);
  });

  it('非 passphrase 模式调 rehash 被拒绝', async () => {
    const keyFile = new MemoryKeyFile();
    await keyFile.write(randomBytes(32));
    const ks = new Keystore(new KeyFileKekSource(keyFile), undefined, NOW);
    await ks.unlock();
    await expect(
      ks.rehashArgon2(PASS, { memoryKiB: 65_536, timeCost: 2, parallelism: 1 }, NOW),
    ).rejects.toThrow(/只有 passphrase 模式/);
  });
});

describe('密钥不明文落盘（本次实现期间真实修掉的缺陷的回归护栏）', () => {
  it('密钥表里没有 KEK：连 hash_hex 字段都不存在', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    u.encrypt('credential', 'cred_1', Buffer.from('sk-fake-test-key', 'utf8'));

    const serialized = serializeKeystoreFile(u.serialize());
    const json = JSON.stringify(serialized);

    // 明文 secret 不出现在密钥表里
    expect(json).not.toContain('sk-fake-test-key');
    // 口令不出现在密钥表里
    expect(json).not.toContain(PASS);

    // argon2 段只有 salt + params，**没有任何 hash 字段**
    expect(serialized.argon2).toBeDefined();
    expect(Object.keys(serialized.argon2!).sort()).toEqual([
      'algo',
      'params',
      'salt_hex',
      'version',
    ]);

    // KEK 本体不以 hex / base64 形式出现在任何地方
    const kek = deriveKekFromMeta(PASS, {
      algo: 'argon2id',
      version: 19,
      params: serialized.argon2!.params,
      salt: Buffer.from(serialized.argon2!.salt_hex, 'hex'),
    });
    expect(json).not.toContain(kek.toString('hex'));
    expect(json).not.toContain(kek.toString('base64'));

    // DEK 本体也不出现（只有 wrapped 形态）
    const dek = unwrapKey(kek, Buffer.from(serialized.deks[0]!.wrapped_hex, 'hex'));
    expect(json).not.toContain(dek.toString('hex'));
    expect(json).not.toContain(dek.toString('base64'));

    // wrapped 是 40 字节（AES-256-KW 输出），不是裸 DEK
    expect(Buffer.from(serialized.deks[0]!.wrapped_hex, 'hex').length).toBe(40);
  });

  it('kekFingerprint 不泄露 KEK', async () => {
    const ks = await unlockNew();
    const u = ks.unlocked();
    const fp = u.kekFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    const argon2 = u.serialize().argon2!;
    const kek = deriveKekFromMeta(PASS, {
      algo: 'argon2id',
      version: 19,
      params: argon2.params,
      salt: Buffer.from(argon2.salt_hex, 'hex'),
    });
    expect(fp).not.toContain(kek.toString('hex').slice(0, 8));
  });

  it('key_file 模式下密钥表里连 argon2 段都没有（KEK 只在 key 文件里）', async () => {
    const keyFile = new MemoryKeyFile();
    await keyFile.write(randomBytes(32));
    const ks = new Keystore(new KeyFileKekSource(keyFile), undefined, NOW);
    await ks.unlock();
    const serialized = serializeKeystoreFile(ks.unlocked().serialize());
    expect(serialized.argon2).toBeUndefined();
    expect(serialized.unlock_mode).toBe('key_file');
    expect(serialized.kek_source).toBe('key_file');
    // key 文件内容（KEK 的 hex）不出现在密钥表里
    const keyFileText = (await keyFile.read())!.toString('utf8');
    expect(JSON.stringify(serialized)).not.toContain(keyFileText);
  });
});

describe('未解锁时', () => {
  it('unlocked() 抛错（不会返回一个能加密的半成品）', async () => {
    const ks = new Keystore(new PassphraseKekSource(), undefined, NOW);
    expect(ks.locked).toBe(true);
    expect(() => ks.unlocked()).toThrow();
  });
});
