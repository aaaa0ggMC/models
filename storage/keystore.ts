/**
 * storage/keystore.ts —— 密钥管理：两种解锁模式、DEK 生成/包裹、KEK 轮换、canary。
 *
 * 唯一事实来源：docs/design/65-storage-and-retention.md §3（密钥管理）、
 * §3.2（三档来源）、§3.2b（**自动解锁换不来运行时防护**）、§3.3（启动解锁时序）。
 *
 * 仓库主人已拍板的 #8 决定：
 *   - DEK **随机生成** + KEK **包裹**（信封加密），轮换 KEK 只重包 DEK、不重加密数据；
 *   - **不**用 `DEK = HKDF(KEK, session_id)` 派生式；
 *   - nonce 用 192-bit 随机（XChaCha20-Poly1305），不持久化计数器。
 *
 * ## 密钥层次
 *
 * ```text
 * 口令模式:  用户口令 ──Argon2id──▶ KEK ──AES-256-KW──▶ DEK ──XChaCha20-Poly1305──▶ 记录密文
 * 密钥文件:  key 文件里的 256-bit KEK ─AES-256-KW──▶ DEK ──XChaCha20-Poly1305──▶ 记录密文
 * ```
 *
 * DEK 是随机生成的（`randomDek()`），**不是**从 KEK 派生的。所以换 KEK 只需要
 * 把密钥表里的 wrapped DEK 重新包一遍（`rotateKek`），数据密文一个字节都不动。
 *
 * ## 两种解锁模式与它们的代价（65 §3.2b，**不得美化**）
 *
 * | 模式 | 密钥来源 | 解锁方式 | 防备份被拷走 | 防攻陷运行账号 | 防读进程内存 | 无人值守重启 |
 * |---|---|---|---|---|---|---|
 * | `passphrase`（A 档） | 用户口令 → Argon2id | 启动时交互输入 | ✅ | ✅ | ❌ | ❌ |
 * | `key_file`（C 档） | key 文件里的 256-bit KEK（0600 + 属主隔离） | 无人值守自动 | ✅ | ❌ | ❌ | ✅ |
 *
 * **诚实结论**：自动解锁（key_file）的本质是产品层取舍——用「无人值守」换
 * 「离线泄露防护」。它**不能**防御「同机运行时读取」：一旦进程解锁，KEK 与 DEK
 * 就在内存里，任何能读该进程内存的攻击者（同账号恶意代码、`/proc/<pid>/mem`、
 * core dump、swap 落盘）都能拿到密钥。这个边界 UI 与文档必须明示
 * （见 webui/admin/ 的解锁说明与报告）。
 *
 * B 档（OS keyring / systemd credential）在 65 §3.2 是推荐默认，但它依赖
 * 调研样机已确认可用的 `systemd-creds` / `LoadCredentialEncrypted=`，
 * 或原生 keyring 绑定（`@napi-rs/keyring`）。本模块把 B 档建模成
 * `key_file` + 一个可注入的 `KekSource`：部署时把 systemd 解密后的凭据
 * 写进那个文件即可，语义与 C 档一致（「密钥与数据同机，只防拷贝」）。
 * 真正的 keyring 绑定标 **[待验证]**，不在本线程实现。
 *
 * ## 启动解锁时序（65 §3.3）
 *
 * 1. 读 KEK 来源（key_file 档）或提示口令（passphrase 档）；
 * 2. Argon2id 派生（~70 ms，阻塞，只在启动路径）；
 * 3. 解包 DEK；
 * 4. **canary 校验**：用一个已知明文解一次，失败 → 明确报「密钥错误」并退出，
 *    绝不静默建新库（静默建新库会用错密钥写入不可解的数据，覆盖旧数据）；
 * 5. 起服务。
 */

import { Buffer } from 'node:buffer';
import {
  type Argon2IdParams,
  type Argon2Meta,
  type SerializedArgon2Meta,
  DEFAULT_PARAMS,
  createArgon2Meta,
  deriveKekFromMeta,
  needsRehash,
  serializeArgon2Meta,
  deserializeArgon2Meta,
} from './crypto/kdf.js';
import { kekFingerprint, randomDek, unwrapKey, wrapKey } from './crypto/wrap.js';
import { buildAad, type AadRecordKind } from './crypto/aad.js';
import { open, seal } from './crypto/xchacha20-poly1305.js';

// ---------------------------------------------------------------------------
// 解锁模式
// ---------------------------------------------------------------------------

/** KEK 来源。`passphrase` = A 档（启动口令）；`key_file` = C 档（密钥文件自动解锁）。 */
export type UnlockMode = 'passphrase' | 'key_file';

/**
 * KEK 来源端口（DI 注入）。
 *
 * 抽象出「KEK 从哪来」而不是把文件读死在 keystore 里，理由：
 *   - 测试用内存 source，不碰磁盘、不建临时文件；
 *   - 部署时可换成 systemd credential / Docker secret / keyring，
 *     换 source 不改 keystore 逻辑（65 §3.2 的三档就落在这个端口上）。
 */
export interface KekSource {
  readonly mode: UnlockMode;
  /**
   * 取 KEK。
   *
   * - `passphrase` 模式：入参是用户这次输入的口令，用 `existing`（盐 + 参数）
   *   派生 KEK；首次建库时 `existing` 为 undefined，现场生成盐。
   * - `key_file` 模式：忽略入参，直接从来源读 256-bit KEK。
   *
   * **返回值里没有「口令对不对」这个信息**——口令校验由 keystore 的
   * 「解包 DEK + canary」完成（见 `unlock()`）。这样 `KekSource` 就不可能
   * 被诱使返回一个「自称校验过、其实是错的」KEK。
   */
  acquire(input: {
    passphrase?: string;
    existing?: Argon2Meta;
    params?: Argon2IdParams;
  }): Promise<{ kek: Buffer; meta?: Argon2Meta }>;
  /** 供 UI 展示的代价说明（65 §3.2b 要求「如实呈现」，这里给权威文案）。 */
  readonly tradeoffNote: string;
}

/** A 档：启动口令解锁。KEK = Argon2id(口令)。有人值守，最安全，但网关无法自动重启。 */
export class PassphraseKekSource implements KekSource {
  readonly mode = 'passphrase' as const;
  readonly tradeoffNote =
    '启动口令解锁：最安全的一档，但每次重启都要有人输入口令，网关无法无人值守自动重启。';

  constructor(private readonly params: Argon2IdParams = DEFAULT_PARAMS) {}

  async acquire(input: {
    passphrase?: string;
    existing?: Argon2Meta;
  }): Promise<{ kek: Buffer; meta?: Argon2Meta }> {
    if (input.passphrase === undefined) {
      throw new Error('passphrase 模式必须提供口令');
    }
    if (input.existing !== undefined) {
      // 已建过库：落盘的只有盐 + 参数（**没有 hash**——hash 就是 KEK，
      // 把它写进密钥表等于把「需要口令」换成「拿到文件即可」）。
      // 重新派生即得 KEK；口令对不对由调用方解包 DEK + canary 判定。
      return { kek: deriveKekFromMeta(input.passphrase, input.existing), meta: input.existing };
    }
    const meta = createArgon2Meta(this.params);
    return { kek: deriveKekFromMeta(input.passphrase, meta), meta };
  }
}

/**
 * C 档：密钥文件自动解锁。
 *
 * key 文件里放 **256-bit KEK 的 hex**（0600 权限 + 属主隔离）。
 * 65 §3.2 对这一档的判定原话：**「等同密钥与数据同机，只防拷贝」**。
 * 它能防住「备份文件被拷走 / 库文件外泄」，防不住「攻陷运行账号」与
 * 「读运行中进程内存」——这两条写进 tradeoffNote，UI 原样展示，不改写。
 */
export class KeyFileKekSource implements KekSource {
  readonly mode = 'key_file' as const;
  readonly tradeoffNote =
    '密钥文件自动解锁：换取无人值守自动重启；密钥与数据同机，只防「库文件被拷走」，' +
    '不防攻陷运行账号，也不防读取运行中进程的内存。';

  constructor(private readonly reader: KeyFileReader) {}

  async acquire(): Promise<{ kek: Buffer; meta?: Argon2Meta }> {
    const raw = await this.reader.read();
    if (raw === undefined) {
      throw new Error(
        'key 文件不存在或为空。首次使用请用 `agentgateway keystore init` 生成（会写 0600 权限的文件）。',
      );
    }
    const text = raw.toString('utf8').trim();
    // 容忍 hex / base64 两种编码：hex 是 64 字符，base64 是 44 字符（带填充）。
    let kek: Buffer;
    if (/^[0-9a-f]{64}$/i.test(text)) {
      kek = Buffer.from(text, 'hex');
    } else {
      kek = Buffer.from(text, 'base64');
      if (kek.length !== 32) throw new Error('key 文件内容不是 32 字节 KEK（hex 或 base64）');
    }
    if (kek.length !== 32) {
      throw new Error(`key 文件里的 KEK 长度必须是 32 字节，收到 ${kek.length}`);
    }
    return { kek };
  }
}

/** key 文件读取端口（DI 注入：测试用内存实现，生产用 0600 文件）。 */
export interface KeyFileReader {
  read(): Promise<Buffer | undefined>;
}

/** key 文件写入端口。 */
export interface KeyFileWriter {
  write(kek: Buffer): Promise<void>;
}

/** 口令不正确。单独的错误类型，让调用方能给「密钥错误」而不是「内部错误」。 */
export class IncorrectPassphraseError extends Error {
  constructor() {
    super('口令不正确（Argon2id 校验失败）');
    this.name = 'IncorrectPassphraseError';
  }
}

/** 密钥错误（KEK 解不开 DEK / 取不到 KEK）。65 §3.3 第 4 条要求 fail fast。 */
export class KeystoreLockedError extends Error {
  constructor(cause?: unknown) {
    // 把 cause 的 message 拼进来：取 KEK 失败的**可操作提示**（如「key 文件不存在，
    // 请先 keystore init」）必须让用户看到，包一层就吞掉是最糟的失败模式。
    // 只拼 message 不拼 stack——cause 来自我们自己的 KekSource，其 message 是
    // 刻意写成用户可读的；若将来接入外部来源，这里要重新评估。
    const causeMessage =
      cause instanceof Error && cause.message.length > 0 ? `（${cause.message}）` : '';
    super(
      '密钥错误：无法用该 KEK 解包 DEK。请检查口令 / key 文件是否正确；' +
        '若是密钥文件损坏或被替换，请从备份恢复，切勿让网关静默建新库（那会用错密钥覆盖旧数据）。' +
        causeMessage,
    );
    this.name = 'KeystoreLockedError';
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// 密钥表
// ---------------------------------------------------------------------------

/**
 * 单把 DEK 在密钥表里的一行。
 *
 * `wrapped` 是 AES-256-KW 输出（40 字节）。`kek_fingerprint` 标出它是哪把 KEK
 * 包的——轮换 KEK 后旧行的指纹与新 KEK 不符，一眼能看出「该重包了」。
 */
export interface DekEntry {
  dek_id: string;
  wrapped: Buffer;
  kek_fingerprint: string;
  created_at: number;
  /** 这把 DEK 已参与过的加密次数（用于轮换判定，见 ROTATE_AFTER_ENCRYPTIONS）。 */
  encryptions: number;
  status: 'active' | 'retired';
}

/** canary：65 §3.3 第 4 条的「读一个已知记录并尝试解密」。 */
export interface Canary {
  dek_id: string;
  /** 固定明文 `CANARY_PLAINTEXT` 的密文。 */
  ciphertext: Buffer;
  tag: Buffer;
  nonce: Buffer;
}

/** canary 的已知明文。改它会毁掉已建库的 canary（版本化处理）。 */
export const CANARY_PLAINTEXT = 'agentgateway-keystore-canary-v1';

/**
 * 密钥表（「按 session 一行」的那张表，65 §3.1）。
 *
 * 本实现只有**一把 active DEK**（不需要 per-session DEK：控制面存储没有
 * 长会话前缀压缩那种 O(N²) 问题，per-session 隔离在这里是纯负担）。
 * 轮换 DEK 时新建一行 active、旧的转 retired——旧记录靠 `dek_id` 继续可读。
 */
export interface KeystoreFile {
  format: 'agentgateway-keystore';
  version: 1;
  unlock_mode: UnlockMode;
  /** passphrase 模式下的 Argon2 记录（含盐/参数/hash=KEK）。key_file 模式缺省。 */
  argon2?: SerializedArgon2Meta;
  /** key_file 模式下来源描述（不含 KEK 本身；KEK 只在 key 文件里）。 */
  kek_source?: string;
  deks: DekEntry[];
  canary: Canary;
  created_at: number;
  updated_at: number;
}

/**
 * DEK 轮换阈值。
 *
 * 65 §3.1 设计风险 2 的建议解法 ①给的是「随机 96-bit nonce 时最多 2^32 次；
 * 保守取 2^24 次就轮换」。本实现用 **192-bit 随机 nonce**（解法 ②），
 * 随机 nonce 碰撞概率本身已低到 2^96 条才 50%（draft-irtf-cfrg-xchacha §2.1）。
 * 仍设一个显式阈值，理由不是 nonce 碰撞，而是**可观测的密钥卫生**：
 * 一把 DEK 加密条数过多时，哪怕算法上安全，也应该换一把——这样"这把 DEK 包过
 * 多少数据"始终是一个可控的、能写进审计的数字。取 2^20（约 100 万条），
 * 对单用户控制面存储是一个永远摸不到的保守值。
 */
export const ROTATE_AFTER_ENCRYPTIONS = 2 ** 20;

// ---------------------------------------------------------------------------
// Keystore
// ---------------------------------------------------------------------------

/** 已解锁的密钥库：能拿 DEK、能加密解密、能轮换。 */
export interface UnlockedKeystore {
  readonly unlockMode: UnlockMode;
  readonly activeDekId: string;
  /** 该 DEK 已加密次数。 */
  encryptionCount(): number;
  /** 是否需要轮换 DEK。 */
  shouldRotateDek(): boolean;
  /** 用 active DEK 加密（AAD 由调用方给，见 storage/crypto/aad.ts）。 */
  encrypt(kind: AadRecordKind, id: string, plaintext: Buffer): SealedForDek;
  /** 按 dek_id 解密（旧记录用旧 DEK）。 */
  decrypt(kind: AadRecordKind, id: string, box: SealedForDek): Buffer;
  /** 轮换 DEK：新 DEK 只加密新记录，旧记录靠 dek_id 继续可读。 */
  rotateDek(now: number): string;
  /** 轮换 KEK：只重包密钥表里的 DEK，**不重加密任何数据**。 */
  rotateKek(newKek: Buffer, now: number): void;
  /** 落盘当前密钥表（含新 wrapped DEK / canary）。 */
  serialize(): KeystoreFile;
  /** 当前 KEK 指纹（用于审计展示，不含 KEK 本身）。 */
  kekFingerprint(): string;
  /** 该记录是否用当前 active DEK 加密（= 是否需要在新 DEK 下重加密）。 */
  isCurrentDek(dekId: string): boolean;
}

/** 一段用某把 DEK 加出来的密文 + 它属于哪把 DEK。 */
export interface SealedForDek {
  dek_id: string;
  ciphertext: Buffer;
  tag: Buffer;
  nonce: Buffer;
}

export class KeystoreLocked extends Error {
  constructor() {
    super('keystore 未解锁');
    this.name = 'KeystoreLocked';
  }
}

/**
 * 进程内的密钥库。
 *
 * 构造后处于**锁定**态；`unlock()` 成功才可用。解锁失败（口令错 / KEK 解不开
 * DEK / canary 不过）一律抛错——**绝不静默建新库**（65 §3.3 第 4 条）。
 */
export class Keystore {
  private kek: Buffer | undefined;
  private deks = new Map<string, { entry: DekEntry; key: Buffer }>();
  private activeId: string | undefined;
  /** KEK 派生元数据（盐 + 参数）。**不含 hash**——hash 就是 KEK，不落盘也不常驻。 */
  private meta: Argon2Meta | undefined;
  private now: number;

  constructor(
    private readonly source: KekSource,
    /** 已存在的密钥表（新建库时为 undefined）。 */
    private file: KeystoreFile | undefined,
    /** 时钟注入（模块内不读系统时间）。 */
    now: number = Date.now(),
  ) {
    this.now = now;
  }

  get locked(): boolean {
    return this.kek === undefined;
  }

  /**
   * 解锁（或首次建库）。
   *
   * @param passphrase passphrase 模式下的口令；key_file 模式忽略
   */
  async unlock(passphrase?: string): Promise<void> {
    const existing =
      this.file?.argon2 === undefined ? undefined : deserializeArgon2Meta(this.file.argon2);

    let kek: Buffer;
    let meta: Argon2Meta | undefined;
    try {
      const acquired = await this.source.acquire({
        ...(passphrase === undefined ? {} : { passphrase }),
        ...(existing === undefined ? {} : { existing }),
      });
      kek = acquired.kek;
      meta = acquired.meta;
    } catch (err) {
      // 取 KEK 就失败（空口令 / key 文件读不到 / 内容不是 32 字节）——
      // 一律包成 KeystoreLockedError，让调用方有一个统一的「解锁失败」信号，
      // 同时用 cause 保留原始信息（不丢上下文，也不把内部细节当作用户文案）。
      throw new KeystoreLockedError(err);
    }

    if (this.file === undefined) {
      this.kek = kek;
      this.meta = meta;
      this.bootstrap(kek);
      return;
    }

    // 已存在的库：解包所有 DEK + canary 校验。
    // 口令错 → KEK 错 → unwrapKey 在这里就失败（KW 的 AIV 完整性校验）。
    //
    // **事务性**：先解到局部 Map，全部成功后才提交到 this.deks / this.kek。
    // 否则半失败状态下 this.kek 已被赋值，`locked` 会返回 false——
    // 一个「解开了但其实没有」的密钥库比完全锁着更危险。
    const deks = new Map<string, { entry: DekEntry; key: Buffer }>();
    try {
      for (const entry of this.file.deks) {
        deks.set(entry.dek_id, { entry, key: unwrapKey(kek, entry.wrapped) });
      }
    } catch (err) {
      throw new KeystoreLockedError(err);
    }
    const activeId = this.file.deks.find((d) => d.status === 'active')?.dek_id;
    if (activeId === undefined) {
      throw new KeystoreLockedError(new Error('密钥表里没有 active DEK'));
    }

    // ---- 到这里才提交 ----
    this.kek = kek;
    this.meta = meta;
    this.deks = deks;
    this.activeId = activeId;
    this.verifyCanary();
  }

  /** 首次建库：生成 DEK、包好、写 canary。 */
  private bootstrap(kek: Buffer): void {
    const dekId = `dek_${randomDek().toString('hex').slice(0, 12)}`;
    const dek = randomDek();
    const entry: DekEntry = {
      dek_id: dekId,
      wrapped: wrapKey(kek, dek),
      kek_fingerprint: kekFingerprint(kek),
      created_at: this.now,
      encryptions: 0,
      status: 'active',
    };
    const canaryBox = seal(dek, Buffer.from(CANARY_PLAINTEXT, 'utf8'), canaryAad(dekId));
    this.deks.set(dekId, { entry, key: dek });
    this.activeId = dekId;
    this.file = {
      format: 'agentgateway-keystore',
      version: 1,
      unlock_mode: this.source.mode,
      ...(this.meta === undefined ? {} : { argon2: serializeArgon2Meta(this.meta) }),
      ...(this.source.mode === 'key_file' ? { kek_source: 'key_file' } : {}),
      deks: [entry],
      canary: { dek_id: dekId, ...canaryBox },
      created_at: this.now,
      updated_at: this.now,
    };
  }

  /**
   * canary 校验（65 §3.3 第 4 条）。
   *
   * 用**已知明文**解一次：KEK 不对 → KW 解包就失败了（更早抛出）；KEK 对但
   * DEK 被改 → 这里失败。两种都算「密钥错误」，fail fast。
   */
  private verifyCanary(): void {
    const file = this.file;
    if (file === undefined) return;
    const active = this.deks.get(file.canary.dek_id);
    if (active === undefined) {
      throw new KeystoreLockedError(new Error(`canary 引用的 DEK 不存在: ${file.canary.dek_id}`));
    }
    try {
      const plaintext = open(
        active.key,
        {
          ciphertext: file.canary.ciphertext,
          tag: file.canary.tag,
          nonce: file.canary.nonce,
        },
        canaryAad(file.canary.dek_id),
      );
      if (plaintext.toString('utf8') !== CANARY_PLAINTEXT) {
        throw new Error('canary 明文不匹配');
      }
    } catch (err) {
      throw new KeystoreLockedError(err);
    }
  }

  /** 解锁后的操作面。 */
  unlocked(): UnlockedKeystore {
    if (this.kek === undefined || this.activeId === undefined) throw new KeystoreLocked();
    const self = this;
    return {
      get unlockMode() {
        return self.source.mode;
      },
      get activeDekId() {
        return self.activeId!;
      },
      encryptionCount(): number {
        return self.deks.get(self.activeId!)!.entry.encryptions;
      },
      shouldRotateDek(): boolean {
        // 直接读 entry，不调 self.encryptionCount()——`self` 是 Keystore，
        // 而 encryptionCount 定义在下面这个对象字面量上（不在 Keystore 上）。
        return self.deks.get(self.activeId!)!.entry.encryptions >= ROTATE_AFTER_ENCRYPTIONS;
      },
      encrypt(kind, id, plaintext): SealedForDek {
        const active = self.deks.get(self.activeId!)!;
        const box = seal(active.key, plaintext, buildAad({ kind, id }));
        active.entry.encryptions += 1;
        self.touch();
        return { dek_id: active.entry.dek_id, ...box };
      },
      decrypt(kind, id, box): Buffer {
        const target = self.deks.get(box.dek_id);
        if (target === undefined) {
          throw new Error(`密钥表里没有 DEK ${box.dek_id}（记录 ${kind}/${id} 解不开）`);
        }
        return open(
          target.key,
          { ciphertext: box.ciphertext, tag: box.tag, nonce: box.nonce },
          buildAad({ kind, id }),
        );
      },
      rotateDek(now: number): string {
        const newId = `dek_${randomDek().toString('hex').slice(0, 12)}`;
        const dek = randomDek();
        const old = self.deks.get(self.activeId!);
        if (old !== undefined) old.entry.status = 'retired';
        self.deks.set(newId, {
          entry: {
            dek_id: newId,
            wrapped: wrapKey(self.kek!, dek),
            kek_fingerprint: kekFingerprint(self.kek!),
            created_at: now,
            encryptions: 0,
            status: 'active',
          },
          key: dek,
        });
        self.activeId = newId;
        self.touch();
        return newId;
      },
      rotateKek(newKek: Buffer, now: number): void {
        if (newKek.length !== 32) throw new Error('新 KEK 必须是 32 字节');
        // 只重包，不重加密：旧 wrapped 全部作废，用新 KEK 重新包同一把 DEK。
        for (const { entry, key } of self.deks.values()) {
          entry.wrapped = wrapKey(newKek, key);
          entry.kek_fingerprint = kekFingerprint(newKek);
        }
        self.kek = newKek;
        self.now = now;
        self.touch();
      },
      serialize(): KeystoreFile {
        const file = self.file!;
        return {
          ...file,
          deks: [...self.deks.values()].map((d) => ({ ...d.entry, wrapped: d.entry.wrapped })),
          updated_at: self.now,
        };
      },
      kekFingerprint(): string {
        return kekFingerprint(self.kek!);
      },
      isCurrentDek(dekId: string): boolean {
        return dekId === self.activeId;
      },
    };
  }

  /** 是否需要按新参数重算 Argon2（口令模式下升级成本用）。 */
  needsArgon2Rehash(target: Argon2IdParams): boolean {
    return this.meta !== undefined && needsRehash(this.meta, target);
  }

  /**
   * 升级 Argon2 参数：用新盐 + 新参数重新派生 KEK，并重包所有 DEK（数据不动）。
   *
   * 旧盐作废——这是必要的：参数升级意味着旧的 (盐, 参数, 口令) 组合不再使用。
   * DEK 本身不变，所以已加密的记录一个字节都不用动。
   */
  async rehashArgon2(passphrase: string, target: Argon2IdParams, now: number): Promise<void> {
    if (this.meta === undefined) {
      throw new Error('只有 passphrase 模式能升级 Argon2 参数');
    }
    const next = createArgon2Meta(target);
    this.meta = next;
    this.unlocked().rotateKek(deriveKekFromMeta(passphrase, next), now);
    if (this.file !== undefined) this.file.argon2 = serializeArgon2Meta(next);
  }

  private touch(): void {
    this.now = Date.now();
    if (this.file !== undefined) this.file.updated_at = this.now;
  }
}

/** canary 的 AAD：把 canary 密文绑回它所属的 DEK。 */
function canaryAad(dekId: string): Buffer {
  return buildAad({ kind: 'meta', id: `canary:${dekId}` });
}

// ---------------------------------------------------------------------------
// 序列化辅助（JSON 落盘）
// ---------------------------------------------------------------------------

export interface SerializedKeystoreFile {
  format: 'agentgateway-keystore';
  version: 1;
  unlock_mode: UnlockMode;
  argon2?: SerializedArgon2Meta;
  kek_source?: string;
  deks: Array<{
    dek_id: string;
    wrapped_hex: string;
    kek_fingerprint: string;
    created_at: number;
    encryptions: number;
    status: 'active' | 'retired';
  }>;
  canary: { dek_id: string; ciphertext_hex: string; tag_hex: string; nonce_hex: string };
  created_at: number;
  updated_at: number;
}

export function serializeKeystoreFile(f: KeystoreFile): SerializedKeystoreFile {
  return {
    format: f.format,
    version: f.version,
    unlock_mode: f.unlock_mode,
    ...(f.argon2 === undefined ? {} : { argon2: f.argon2 }),
    ...(f.kek_source === undefined ? {} : { kek_source: f.kek_source }),
    deks: f.deks.map((d) => ({
      dek_id: d.dek_id,
      wrapped_hex: d.wrapped.toString('hex'),
      kek_fingerprint: d.kek_fingerprint,
      created_at: d.created_at,
      encryptions: d.encryptions,
      status: d.status,
    })),
    canary: {
      dek_id: f.canary.dek_id,
      ciphertext_hex: f.canary.ciphertext.toString('hex'),
      tag_hex: f.canary.tag.toString('hex'),
      nonce_hex: f.canary.nonce.toString('hex'),
    },
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

export function deserializeKeystoreFile(s: SerializedKeystoreFile): KeystoreFile {
  if (s.format !== 'agentgateway-keystore') {
    throw new Error(`不是 AgentGateway 密钥表: ${String(s.format)}`);
  }
  if (s.version !== 1) throw new Error(`不支持的密钥表版本: ${s.version}`);
  return {
    format: 'agentgateway-keystore',
    version: 1,
    unlock_mode: s.unlock_mode,
    ...(s.argon2 === undefined ? {} : { argon2: s.argon2 }),
    ...(s.kek_source === undefined ? {} : { kek_source: s.kek_source }),
    deks: s.deks.map((d) => ({
      dek_id: d.dek_id,
      wrapped: Buffer.from(d.wrapped_hex, 'hex'),
      kek_fingerprint: d.kek_fingerprint,
      created_at: d.created_at,
      encryptions: d.encryptions,
      status: d.status,
    })),
    canary: {
      dek_id: s.canary.dek_id,
      ciphertext: Buffer.from(s.canary.ciphertext_hex, 'hex'),
      tag: Buffer.from(s.canary.tag_hex, 'hex'),
      nonce: Buffer.from(s.canary.nonce_hex, 'hex'),
    },
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}
