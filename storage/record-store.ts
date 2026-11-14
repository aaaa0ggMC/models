/**
 * storage/record-store.ts —— 加密的记录存储（DI 注入，接口 + 内存实现 + JSON 文件实现）。
 *
 * 唯一事实来源：docs/design/65-storage-and-retention.md §1 决策 S1 的第二层
 * （payload 列应用层信封加密）、§3.1 的密钥层次、§6.3 的脱敏立场。
 *
 * ## 分层
 *
 * ```text
 * EncryptedRecordStore  ──负责加密/解密/AAD/DEK 选择──▶  UnlockedKeystore
 *        │
 *        └──负责持久化──▶  RawRecordStore（接口）
 *                              ├── InMemoryRawRecordStore   测试 / 单进程演示
 *                              └── JsonFileRecordStore      0600 原子写，单机部署
 * ```
 *
 * 持久化与加密**分开**是两个理由：
 *   1. 测试用内存 store，不建临时文件、不碰磁盘权限；
 *   2. 换持久化后端（换 SQLite，见 65 §1 决策 S1 的第一层整库加密）时，
 *      `EncryptedRecordStore` 一行都不用改——它只依赖 `RawRecordStore` 接口。
 *      本线程不引 `better-sqlite3-multiple-ciphers`（原生依赖，装不动就跑不起来），
 *      用 JSON 文件先落地「应用层信封加密」这一层；整库加密标 **[待实现]**。
 *
 * ## 明文列 / 密文列
 *
 * `kind` / `id` / `created_at` / `updated_at` / `dek_id` 是**明文元数据**
 * （65 §4.3：敏感列的检索必须走明文索引列）。`ciphertext` + `tag` + `nonce` 是密文。
 * **secret 本体永远只在 ciphertext 里**——列出记录时只能看到元数据，
 * 这正是管理 API「列出凭据只返回掩码」的存储侧保证（见 maskSecret）。
 *
 * ## 为什么不用 SQL
 *
 * 65 §1 的代价一节写明了：整库加密后**无法在 SQL 里对密文列做 WHERE 查询**，
 * 敏感列必须「先解密再过滤」或用明文索引列。控制面存储的量级（几十条凭据、
 * 几百条别名、几千条审计）根本不需要 SQL——内存 Map + 全量解密过滤就够，
 * 引入 SQLite 只会把「明文索引列」这个约束变成需要人为记得的事。
 */

import type { AadRecordKind } from './crypto/aad.js';
import type { SealedForDek, UnlockedKeystore } from './keystore.js';

/** 一条落盘的记录。二进制字段一律 hex 编码后进 JSON。 */
export interface StoredRecord {
  kind: AadRecordKind;
  id: string;
  /** 加密时用的 DEK（旧记录用旧 DEK；轮换后仍可读）。 */
  dek_id: string;
  ciphertext: Buffer;
  tag: Buffer;
  nonce: Buffer;
  created_at: number;
  updated_at: number;
}

/** 记录元数据（**不含密文**，可安全展示）。 */
export interface RecordMeta {
  kind: AadRecordKind;
  id: string;
  dek_id: string;
  created_at: number;
  updated_at: number;
}

/** 持久化端口。测试可整体替换（内存实现），生产用 JSON 文件。 */
export interface RawRecordStore {
  put(record: StoredRecord): Promise<void>;
  get(kind: AadRecordKind, id: string): Promise<StoredRecord | undefined>;
  list(kind: AadRecordKind): Promise<StoredRecord[]>;
  /** 全量（备份 / 导出 / 迁移用）。 */
  all(): Promise<StoredRecord[]>;
  delete(kind: AadRecordKind, id: string): Promise<boolean>;
  /** 用一批记录整体替换（导入 / 恢复用）。 */
  replaceAll(records: StoredRecord[]): Promise<void>;
}

/** 内存实现：Map 套 Map，测试与单进程演示用。 */
export class InMemoryRawRecordStore implements RawRecordStore {
  private readonly byKind = new Map<AadRecordKind, Map<string, StoredRecord>>();

  async put(record: StoredRecord): Promise<void> {
    const bucket = this.byKind.get(record.kind) ?? new Map<string, StoredRecord>();
    const prev = bucket.get(record.id);
    bucket.set(record.id, {
      ...record,
      created_at: prev?.created_at ?? record.created_at,
    });
    this.byKind.set(record.kind, bucket);
  }

  async get(kind: AadRecordKind, id: string): Promise<StoredRecord | undefined> {
    return this.byKind.get(kind)?.get(id);
  }

  async list(kind: AadRecordKind): Promise<StoredRecord[]> {
    return [...(this.byKind.get(kind)?.values() ?? [])];
  }

  async all(): Promise<StoredRecord[]> {
    const out: StoredRecord[] = [];
    for (const bucket of this.byKind.values()) out.push(...bucket.values());
    return out;
  }

  async delete(kind: AadRecordKind, id: string): Promise<boolean> {
    return this.byKind.get(kind)?.delete(id) ?? false;
  }

  async replaceAll(records: StoredRecord[]): Promise<void> {
    this.byKind.clear();
    for (const r of records) await this.put(r);
  }
}

/**
 * JSON 文件实现：0600 权限 + 原子替换（写临时文件再 rename）。
 *
 * 为什么原子替换而不是就地改：就地写 JSON 意味着「读全量 → 改 → 写全量」，
 * 中途崩掉就留下一个截断的文件，而截断的 JSON **整个库都读不出来**。
 * 写 `*.tmp` 再 `rename` 是 POSIX 原子操作，崩了最多留下一个没人引用的 tmp。
 *
 * 文件权限 0600：65 §3.2 C 档的要求（属主隔离）。注意这只管**文件系统**权限，
 * 管不了「攻陷运行账号」——那一层代价见 keystore.ts 的 tradeoffNote。
 */
export interface FileSystemPort {
  readFile(path: string): Promise<Buffer | undefined>;
  writeFileAtomic(path: string, data: Buffer, mode: number): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class JsonFileRecordStore implements RawRecordStore {
  constructor(
    private readonly path: string,
    private readonly fs: FileSystemPort,
    /** 文件权限，缺省 0600（属主读写）。 */
    private readonly mode: number = 0o600,
  ) {}

  private async load(): Promise<StoredRecord[]> {
    const raw = await this.fs.readFile(this.path);
    if (raw === undefined) return [];
    const text = raw.toString('utf8').trim();
    if (text === '') return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${this.path} 不是记录数组`);
    return (parsed as SerializedRecord[]).map(deserializeRecord);
  }

  private async save(records: StoredRecord[]): Promise<void> {
    const payload = JSON.stringify(records.map(serializeRecord), null, 2);
    await this.fs.writeFileAtomic(this.path, Buffer.from(payload, 'utf8'), this.mode);
  }

  async put(record: StoredRecord): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex((r) => r.kind === record.kind && r.id === record.id);
    const merged: StoredRecord = {
      ...record,
      created_at: idx >= 0 ? all[idx]!.created_at : record.created_at,
    };
    if (idx >= 0) all[idx] = merged;
    else all.push(merged);
    await this.save(all);
  }

  async get(kind: AadRecordKind, id: string): Promise<StoredRecord | undefined> {
    return (await this.load()).find((r) => r.kind === kind && r.id === id);
  }

  async list(kind: AadRecordKind): Promise<StoredRecord[]> {
    return (await this.load()).filter((r) => r.kind === kind);
  }

  async all(): Promise<StoredRecord[]> {
    return this.load();
  }

  async delete(kind: AadRecordKind, id: string): Promise<boolean> {
    const all = await this.load();
    const next = all.filter((r) => !(r.kind === kind && r.id === id));
    if (next.length === all.length) return false;
    await this.save(next);
    return true;
  }

  async replaceAll(records: StoredRecord[]): Promise<void> {
    await this.save(records);
  }
}

interface SerializedRecord {
  kind: AadRecordKind;
  id: string;
  dek_id: string;
  ciphertext_hex: string;
  tag_hex: string;
  nonce_hex: string;
  created_at: number;
  updated_at: number;
}

function serializeRecord(r: StoredRecord): SerializedRecord {
  return {
    kind: r.kind,
    id: r.id,
    dek_id: r.dek_id,
    ciphertext_hex: r.ciphertext.toString('hex'),
    tag_hex: r.tag.toString('hex'),
    nonce_hex: r.nonce.toString('hex'),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function deserializeRecord(s: SerializedRecord): StoredRecord {
  return {
    kind: s.kind,
    id: s.id,
    dek_id: s.dek_id,
    ciphertext: Buffer.from(s.ciphertext_hex, 'hex'),
    tag: Buffer.from(s.tag_hex, 'hex'),
    nonce: Buffer.from(s.nonce_hex, 'hex'),
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 加密存储门面
// ---------------------------------------------------------------------------

/** 加密记录存储（管理面与 dog-fooding 接口共用的入口）。 */
export interface EncryptedRecordStore {
  /** 写入 / 覆盖一条记录（value 会被 JSON 序列化后加密）。 */
  put(kind: AadRecordKind, id: string, value: unknown, now?: number): Promise<void>;
  /** 读出并解密。不存在或认证失败返回 undefined（认证失败另见 getStrict）。 */
  get<T>(kind: AadRecordKind, id: string): Promise<T | undefined>;
  /** 读出并解密，不存在即抛错（调用方明确要求"必须有"时用）。 */
  getStrict<T>(kind: AadRecordKind, id: string): Promise<T>;
  /** 列出某类的元数据（**不解密**，因此绝不泄漏 secret）。 */
  listMeta(kind: AadRecordKind): Promise<RecordMeta[]>;
  /**
   * 列出某类并解密全部（量小才用；管理面 CRUD 走这条）。
   *
   * 带上 created_at / updated_at：管理面列表要显示「什么时候建的」，
   * 而时间戳是**明文元数据**（65 §4.3 的明文索引列），不涉及解密成本。
   */
  listDecrypted<T>(
    kind: AadRecordKind,
  ): Promise<Array<{ id: string; value: T; created_at: number; updated_at: number; dek_id: string }>>;
  delete(kind: AadRecordKind, id: string): Promise<boolean>;
  /** 全量导出（密文形态，可安全外传；65 §7 的备份立场）。 */
  exportCiphertext(): Promise<StoredRecord[]>;
  /** 从密文整体恢复（配合密钥表备份；65 §3.1 的「密钥表 + 数据库必须一起备份」）。 */
  importCiphertext(records: StoredRecord[]): Promise<void>;
  /** 当前是否该轮换 DEK。 */
  shouldRotateDek(): boolean;
  /** 轮换 DEK（新记录用新 DEK，旧记录靠 dek_id 继续可读）。 */
  rotateDek(now: number): Promise<string>;
  /** 把仍在用旧 DEK 的记录重加密到 active DEK（可选维护动作，非必须）。 */
  reencryptToActiveDek(now: number): Promise<number>;
}

export class DefaultEncryptedRecordStore implements EncryptedRecordStore {
  constructor(
    private readonly keystore: UnlockedKeystore,
    private readonly raw: RawRecordStore,
    private readonly clock: { now(): number },
  ) {}

  async put(kind: AadRecordKind, id: string, value: unknown, now?: number): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const box = this.keystore.encrypt(kind, id, plaintext);
    const ts = now ?? this.clock.now();
    await this.raw.put({
      kind,
      id,
      dek_id: box.dek_id,
      ciphertext: box.ciphertext,
      tag: box.tag,
      nonce: box.nonce,
      created_at: ts,
      updated_at: ts,
    });
  }

  async get<T>(kind: AadRecordKind, id: string): Promise<T | undefined> {
    const rec = await this.raw.get(kind, id);
    if (rec === undefined) return undefined;
    return this.decryptRecord<T>(kind, id, rec);
  }

  async getStrict<T>(kind: AadRecordKind, id: string): Promise<T> {
    const value = await this.get<T>(kind, id);
    if (value === undefined) {
      throw new Error(`记录不存在: ${kind}/${id}`);
    }
    return value;
  }

  async listMeta(kind: AadRecordKind): Promise<RecordMeta[]> {
    return (await this.raw.list(kind)).map((r) => ({
      kind: r.kind,
      id: r.id,
      dek_id: r.dek_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  async listDecrypted<T>(
    kind: AadRecordKind,
  ): Promise<
    Array<{ id: string; value: T; created_at: number; updated_at: number; dek_id: string }>
  > {
    const records = await this.raw.list(kind);
    const out: Array<{
      id: string;
      value: T;
      created_at: number;
      updated_at: number;
      dek_id: string;
    }> = [];
    for (const rec of records) {
      out.push({
        id: rec.id,
        value: this.decryptRecord<T>(kind, rec.id, rec),
        created_at: rec.created_at,
        updated_at: rec.updated_at,
        dek_id: rec.dek_id,
      });
    }
    return out;
  }

  async delete(kind: AadRecordKind, id: string): Promise<boolean> {
    return this.raw.delete(kind, id);
  }

  async exportCiphertext(): Promise<StoredRecord[]> {
    return this.raw.all();
  }

  async importCiphertext(records: StoredRecord[]): Promise<void> {
    await this.raw.replaceAll(records);
  }

  shouldRotateDek(): boolean {
    return this.keystore.shouldRotateDek();
  }

  async rotateDek(now: number): Promise<string> {
    return this.keystore.rotateDek(now);
  }

  /**
   * 把旧 DEK 的记录重加密到 active DEK。
   *
   * **不是必须的**——`decrypt` 按 `dek_id` 找 DEK，旧记录永远可读。这个方法的
   * 用途是「让 retired DEK 可以被彻底丢弃」：重加密完成后，旧 DEK 就可以从
   * 密钥表里删掉，攻击面随之缩小。返回重加密的条数。
   */
  async reencryptToActiveDek(now: number): Promise<number> {
    const all = await this.raw.all();
    let moved = 0;
    for (const rec of all) {
      if (this.keystore.isCurrentDek(rec.dek_id)) continue;
      const value = this.decryptRecord<unknown>(rec.kind, rec.id, rec);
      const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
      const box = this.keystore.encrypt(rec.kind, rec.id, plaintext);
      await this.raw.put({
        ...rec,
        dek_id: box.dek_id,
        ciphertext: box.ciphertext,
        tag: box.tag,
        nonce: box.nonce,
        updated_at: now,
      });
      moved += 1;
    }
    return moved;
  }

  private decryptRecord<T>(kind: AadRecordKind, id: string, rec: StoredRecord): T {
    const box: SealedForDek = {
      dek_id: rec.dek_id,
      ciphertext: rec.ciphertext,
      tag: rec.tag,
      nonce: rec.nonce,
    };
    const plaintext = this.keystore.decrypt(kind, id, box);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/**
 * secret 掩码。
 *
 * 规则（与 66 §3.4「WebUI 只回显掩码预览」一致）：
 *   - 保留**前缀**（到第一个非字母数字分隔符为止，最多 6 字符）与**后 4 位**；
 *   - 中间一律 `****`，**长度不泄露**（不按原长度生成对应数量的 `*`）；
 *   - 原串 ≤ 8 字符时**整串掩掉**——短串的后 4 位几乎就是全部，露出来没意义。
 *
 * 为什么不让 `*` 的数量跟随原长度：那等于把 secret 的长度告诉每一个能看列表的人，
 * 而长度本身就是一条可用于暴力破解的信息（也知道该猜多长）。
 *
 * ⚠️ 这是**展示函数**，不是安全边界。真正的边界是 `listMeta` 根本不返回密文
 * （见本文件头部「明文列 / 密文列」）。掩码只是给人看的。
 */
export function maskSecret(secret: string): string {
  if (secret.length === 0) return '(空)';
  if (secret.length <= 8) return '*'.repeat(8);
  const prefixMatch = /^[A-Za-z0-9_-]{2,6}(?=[^A-Za-z0-9_-]|$)/.exec(secret);
  const prefix = prefixMatch?.[0] ?? secret.slice(0, 3);
  const tail = secret.slice(-4);
  return `${prefix}****${tail}`;
}

/** 掩码 + 元数据（管理 API 的凭据列表条目）。 */
export interface MaskedSecret {
  masked: string;
  /** 明文长度（**不含内容**；给 UI 显示"这是一把 51 位的 key"用）。 */
  length: number;
  /** 前 4 位（不含后半），便于人认出是哪把 key。空串表示太短不露。 */
  head: string;
}

export function describeSecret(secret: string): MaskedSecret {
  if (secret.length <= 8) {
    return { masked: maskSecret(secret), length: secret.length, head: '' };
  }
  return {
    masked: maskSecret(secret),
    length: secret.length,
    head: secret.slice(0, 4),
  };
}
