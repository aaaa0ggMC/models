/**
 * storage/record-store.test.ts —— 加密记录存储 + 脱敏。
 *
 * 覆盖：
 *   - 往返（put / get / list / delete）；
 *   - **密文落盘、明文不落盘**（JSON 序列化后搜不到 secret）；
 *   - AAD 绑定让「换 kind / 换 id」解不开；
 *   - DEK 轮换后旧记录仍可读、reencryptToActiveDek 能收敛；
 *   - 掩码规则（含「短串整串掩掉」「不泄露长度」）；
 *   - JSON 文件实现的原子性与 created_at 保留。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { PassphraseKekSource, Keystore } from './keystore.js';
import {
  DefaultEncryptedRecordStore,
  InMemoryRawRecordStore,
  JsonFileRecordStore,
  describeSecret,
  maskSecret,
  type FileSystemPort,
  type RawRecordStore,
} from './record-store.js';

const PASS = 'test-passphrase-not-a-real-secret';
const NOW = 1_700_000_000_000;

/** 固定时钟，避免测试里出现时间抖动。 */
const fixedClock = { now: () => NOW };

/** 内存文件系统（测试不碰磁盘）。 */
class MemoryFs implements FileSystemPort {
  readonly files = new Map<string, Buffer>();
  readonly modes = new Map<string, number>();
  /** 记录 writeFileAtomic 被调了几次（用于断言原子写路径真的走了）。 */
  atomicWrites = 0;

  async readFile(path: string): Promise<Buffer | undefined> {
    const f = this.files.get(path);
    return f === undefined ? undefined : Buffer.from(f);
  }

  async writeFileAtomic(path: string, data: Buffer, mode: number): Promise<void> {
    this.atomicWrites += 1;
    this.files.set(path, Buffer.from(data));
    this.modes.set(path, mode);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}

/**
 * 建一个 store。
 *
 * ⚠️ **每次调用都生成一把新的随机 DEK**（新 Keystore → 新 DEK）。所以两个 store
 * 之间默认**不能**互解密——这是正确的安全行为，不是缺陷：跨进程/跨后端共享数据
 * 必须共享同一把 keystore（这正是真实部署的形态：一个 keystore 文件 + 一个
 * 记录存储文件，一起备份，见 65 §3.1 的「密钥表 + 数据库必须一起备份」）。
 * 需要互操作的测试用 `makeStoreWithSharedKeystore`。
 */
async function makeStore(
  raw: RawRecordStore = new InMemoryRawRecordStore(),
): Promise<DefaultEncryptedRecordStore> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, NOW);
  await ks.unlock(PASS);
  return new DefaultEncryptedRecordStore(ks.unlocked(), raw, fixedClock);
}

/** 拿一把已解锁的 keystore，测试可自行拼多个 store（共享同一把密钥）。 */
async function unlockedKeystore(): Promise<ReturnType<Keystore['unlocked']>> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, NOW);
  await ks.unlock(PASS);
  return ks.unlocked();
}

/** 两个 store 共享同一把 keystore（模拟「换后端但同一套密钥」）。 */
async function makeStoresSharingKeystore(
  rawA: RawRecordStore,
  rawB: RawRecordStore,
): Promise<[DefaultEncryptedRecordStore, DefaultEncryptedRecordStore]> {
  const unlocked = await unlockedKeystore();
  return [
    new DefaultEncryptedRecordStore(unlocked, rawA, fixedClock),
    new DefaultEncryptedRecordStore(unlocked, rawB, fixedClock),
  ];
}

interface CredentialValue {
  provider: string;
  access_path: string;
  secret: string;
  note?: string;
}

const CRED: CredentialValue = {
  provider: 'deepseek',
  access_path: 'deepseek.openai-chat',
  secret: 'sk-fake-test-key-abcdef123456',
  note: '测试用假 key，不是真密钥',
};

describe('加密记录存储', () => {
  it('put → get 往返一致', async () => {
    const store = await makeStore();
    await store.put('credential', 'cred_1', CRED, NOW);
    expect(await store.get<CredentialValue>('credential', 'cred_1')).toEqual(CRED);
  });

  it('不存在的记录返回 undefined（不是抛错）', async () => {
    const store = await makeStore();
    expect(await store.get('credential', 'nope')).toBeUndefined();
  });

  it('getStrict 对不存在的记录抛错', async () => {
    const store = await makeStore();
    await expect(store.getStrict('credential', 'nope')).rejects.toThrow(/记录不存在/);
  });

  it('覆盖写保留 created_at、更新 updated_at', async () => {
    const store = await makeStore();
    await store.put('credential', 'cred_1', CRED, NOW);
    await store.put('credential', 'cred_1', { ...CRED, note: '改了' }, NOW + 5_000);
    const meta = await store.listMeta('credential');
    expect(meta).toHaveLength(1);
    expect(meta[0]!.created_at).toBe(NOW);
    expect(meta[0]!.updated_at).toBe(NOW + 5_000);
    expect((await store.get<CredentialValue>('credential', 'cred_1'))!.note).toBe('改了');
  });

  it('listMeta **不解密**，因此绝不泄漏 secret', async () => {
    const store = await makeStore();
    await store.put('credential', 'cred_1', CRED, NOW);
    await store.put('credential', 'cred_2', { ...CRED, secret: 'sk-another-fake' }, NOW);
    const meta = await store.listMeta('credential');
    expect(meta.map((m) => m.id).sort()).toEqual(['cred_1', 'cred_2']);
    const json = JSON.stringify(meta);
    expect(json).not.toContain('sk-fake-test-key');
    expect(json).not.toContain('sk-another-fake');
    // 元数据只有定位信息
    expect(Object.keys(meta[0]!).sort()).toEqual([
      'created_at',
      'dek_id',
      'id',
      'kind',
      'updated_at',
    ]);
  });

  it('delete 真的删掉了', async () => {
    const store = await makeStore();
    await store.put('credential', 'cred_1', CRED, NOW);
    expect(await store.delete('credential', 'cred_1')).toBe(true);
    expect(await store.get('credential', 'cred_1')).toBeUndefined();
    expect(await store.delete('credential', 'cred_1')).toBe(false);
  });

  it('按 kind 隔离列表', async () => {
    const store = await makeStore();
    await store.put('credential', 'c1', CRED, NOW);
    await store.put('alias', 'a1', { pattern: 'fast', target: {} }, NOW);
    expect(await store.listMeta('credential')).toHaveLength(1);
    expect(await store.listMeta('alias')).toHaveLength(1);
  });

  it('密文落盘：底层 store 里只有密文，明文 secret 一个字节都不在', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'cred_1', CRED, NOW);

    const all = await raw.all();
    expect(all).toHaveLength(1);
    const rec = all[0]!;
    // 密文字节与明文不同
    expect(rec.ciphertext.toString('utf8')).not.toContain('sk-fake-test-key');
    // 整个底层 JSON 里搜不到明文
    const dump = JSON.stringify(
      all.map((r) => ({
        kind: r.kind,
        id: r.id,
        ciphertext: r.ciphertext.toString('hex'),
        tag: r.tag.toString('hex'),
        nonce: r.nonce.toString('hex'),
      })),
    );
    expect(dump).not.toContain('sk-fake');
    expect(dump).not.toContain('deepseek.openai-chat');
    expect(dump).not.toContain(PASS);
  });

  it('同一条记录两次写入得到不同密文（nonce 随机化）', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'cred_1', CRED, NOW);
    const first = (await raw.get('credential', 'cred_1'))!;
    await store.put('credential', 'cred_1', CRED, NOW + 1);
    const second = (await raw.get('credential', 'cred_1'))!;
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });
});

describe('AAD 绑定在存储层的效果', () => {
  it('把 A 记录的密文挪到 B 的 id 下 → 解不开', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'cred_a', CRED, NOW);
    const recA = (await raw.get('credential', 'cred_a'))!;

    // 手工伪造一条 id 不同、密文相同的记录
    await raw.put({ ...recA, id: 'cred_b' });
    await expect(store.get('credential', 'cred_b')).rejects.toThrow();
    // 原记录不受影响
    expect((await store.get<CredentialValue>('credential', 'cred_a'))!.secret).toBe(CRED.secret);
  });

  it('把凭据密文挪成别名 → 解不开（kind 也进了 AAD）', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'same_id', CRED, NOW);
    const rec = (await raw.get('credential', 'same_id'))!;
    await raw.put({ ...rec, kind: 'alias' });
    await expect(store.get('alias', 'same_id')).rejects.toThrow();
  });
});

describe('DEK 轮换与重加密', () => {
  it('轮换后旧记录仍可读，新记录用新 DEK', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'cred_old', CRED, NOW);
    const oldRec = (await raw.get('credential', 'cred_old'))!;

    const newDekId = await store.rotateDek(NOW + 1);
    expect(store.shouldRotateDek()).toBe(false);

    await store.put('credential', 'cred_new', CRED, NOW + 2);
    const newRec = (await raw.get('credential', 'cred_new'))!;
    expect(newRec.dek_id).toBe(newDekId);
    expect(oldRec.dek_id).not.toBe(newDekId);

    // 两条都读得出
    expect((await store.get<CredentialValue>('credential', 'cred_old'))!.secret).toBe(CRED.secret);
    expect((await store.get<CredentialValue>('credential', 'cred_new'))!.secret).toBe(CRED.secret);
  });

  it('reencryptToActiveDek 把旧 DEK 的记录收敛到 active DEK', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'cred_old', CRED, NOW);
    await store.rotateDek(NOW + 1);

    const moved = await store.reencryptToActiveDek(NOW + 2);
    expect(moved).toBe(1);

    const after = (await raw.get('credential', 'cred_old'))!;
    const activeDekId = (await raw.list('credential'))[0]!.dek_id;
    expect(after.dek_id).toBe(activeDekId);
    expect((await store.get<CredentialValue>('credential', 'cred_old'))!.secret).toBe(CRED.secret);

    // 再跑一次：没有可搬的
    expect(await store.reencryptToActiveDek(NOW + 3)).toBe(0);
  });
});

describe('导出 / 导入（密文形态）', () => {
  it('导出的是密文，导入到另一个 store 后仍能解密', async () => {
    const raw = new InMemoryRawRecordStore();
    const raw2 = new InMemoryRawRecordStore();
    // 两个 store 共享同一把 keystore（同一套 DEK），只换持久化后端
    const [store, store2] = await makeStoresSharingKeystore(raw, raw2);
    await store.put('credential', 'cred_1', CRED, NOW);

    const exported = await store.exportCiphertext();
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported.map((r) => r.ciphertext.toString('hex')))).not.toContain(
      'sk-fake',
    );

    // 导入到另一个后端（模拟换机器/换存储，密钥表一起带走）
    await store2.importCiphertext(exported);
    expect((await store2.get<CredentialValue>('credential', 'cred_1'))!.secret).toBe(CRED.secret);
  });

  it('导出内容不含口令', async () => {
    const raw = new InMemoryRawRecordStore();
    const store = await makeStore(raw);
    await store.put('credential', 'cred_1', CRED, NOW);
    const dump = JSON.stringify(
      (await store.exportCiphertext()).map((r) => r.ciphertext.toString('hex')),
    );
    expect(dump).not.toContain(PASS);
  });
});

describe('JsonFileRecordStore', () => {
  it('落盘是 JSON 且权限 0600；读回来一致', async () => {
    const fs = new MemoryFs();
    // 先拿 keystore，两个 store 共用（跨进程重启的真实形态）
    const unlocked = await unlockedKeystore();
    const store = new DefaultEncryptedRecordStore(
      unlocked,
      new JsonFileRecordStore('/x/records.json', fs),
      fixedClock,
    );
    await store.put('credential', 'cred_1', CRED, NOW);

    const onDisk = fs.files.get('/x/records.json')!;
    expect(fs.modes.get('/x/records.json')).toBe(0o600);
    const parsed: unknown = JSON.parse(onDisk.toString('utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    // 落盘的是密文
    expect(onDisk.toString('utf8')).not.toContain('sk-fake-test-key');

    // 另一个指向同一文件的 store 读回来
    // （跨进程重启的真实形态：keystore 文件与记录文件都在，DEK 表能对上）
    const store2 = new DefaultEncryptedRecordStore(
      unlocked,
      new JsonFileRecordStore('/x/records.json', fs),
      fixedClock,
    );
    expect((await store2.get<CredentialValue>('credential', 'cred_1'))!.secret).toBe(CRED.secret);
  });

  it('空文件 / 不存在都当空库（不抛错）', async () => {
    const fs = new MemoryFs();
    const store = await makeStore(new JsonFileRecordStore('/x/empty.json', fs));
    expect(await store.listMeta('credential')).toEqual([]);
  });

  it('writeFileAtomic 走的是原子替换路径（不是就地写）', async () => {
    const fs = new MemoryFs();
    const store = await makeStore(new JsonFileRecordStore('/x/records.json', fs));
    await store.put('credential', 'cred_1', CRED, NOW);
    await store.put('credential', 'cred_2', CRED, NOW);
    expect(fs.atomicWrites).toBe(2);
  });

  it('覆盖写保留 created_at', async () => {
    const fs = new MemoryFs();
    const store = await makeStore(new JsonFileRecordStore('/x/records.json', fs));
    await store.put('credential', 'cred_1', CRED, NOW);
    await store.put('credential', 'cred_1', { ...CRED, note: 'x' }, NOW + 9_000);
    const meta = await store.listMeta('credential');
    expect(meta[0]!.created_at).toBe(NOW);
    expect(meta[0]!.updated_at).toBe(NOW + 9_000);
  });

  it('delete 后文件里也少了', async () => {
    const fs = new MemoryFs();
    const store = await makeStore(new JsonFileRecordStore('/x/records.json', fs));
    await store.put('credential', 'cred_1', CRED, NOW);
    await store.delete('credential', 'cred_1');
    const onDisk = fs.files.get('/x/records.json')!;
    expect(JSON.parse(onDisk.toString('utf8'))).toHaveLength(0);
  });
});

describe('maskSecret / describeSecret', () => {
  it('典型 sk- key：保留前缀与后 4 位，中间固定 4 个星号', () => {
    expect(maskSecret('sk-abcdef1234567890')).toBe('sk-****7890');
  });

  it('**不按原长度生成星号**（不泄露 secret 长度）', () => {
    const a = maskSecret('sk-' + 'a'.repeat(20));
    const b = maskSecret('sk-' + 'a'.repeat(60));
    expect(a).toBe('sk-****' + 'a'.repeat(4));
    expect(b).toBe('sk-****' + 'a'.repeat(4));
    expect(a.length).toBe(b.length);
  });

  it('短串（≤8）整串掩掉——后 4 位几乎就是全部，露出来没意义', () => {
    expect(maskSecret('sk-1234')).toBe('********');
    expect(maskSecret('abcdefgh')).toBe('********');
  });

  it('空前串有明确占位', () => {
    expect(maskSecret('')).toBe('(空)');
  });

  it('无前缀可切时退化成前 3 字符', () => {
    expect(maskSecret('1234567890')).toBe('123****7890');
  });

  it('describeSecret 给长度与前 4 位；短串不给 head', () => {
    const long = describeSecret('sk-abcdef1234567890');
    expect(long.masked).toBe('sk-****7890');
    expect(long.length).toBe(19); // 'sk-abcdef1234567890' 是 19 个字符
    expect(long.head).toBe('sk-a');

    const short = describeSecret('sk-1234');
    expect(short.head).toBe('');
    expect(short.length).toBe(7);
  });

  it('掩码结果不含完整 secret', () => {
    const secret = 'sk-fake-test-key-abcdef123456';
    expect(maskSecret(secret)).not.toContain(secret);
    expect(maskSecret(secret)).not.toContain('abcdef123456');
  });
});
