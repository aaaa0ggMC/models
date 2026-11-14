/**
 * storage/crypto/kdf.ts —— Argon2id 口令派生（KEK 的唯一来源）。
 *
 * 唯一事实来源：docs/design/65-storage-and-retention.md §3.2（三档来源）与 §3.3
 * （启动解锁时序）。仓库主人已拍板：**KEK 由用户口令经 Argon2id 派生**
 * （Node `crypto.argon2`，需 Node ≥ 24.7）。
 *
 * ## 为什么是 Argon2id 而不是 scrypt / PBKDF2
 *
 * Argon2 是 2015 年 Password Hashing Competition 冠军，**抗 GPU/ASIC 靠内存硬度**
 * （memory-hard）：攻击者要么按参数量配内存，要么慢几个数量级。scrypt 也有内存
 * 硬度但可调空间小；PBKDF2 没有内存硬度，纯迭代次数在专用硬件上几乎没有成本。
 *
 * 选 **id** 变体而不是 d / i：id 是混合型（前半用 i 的抗侧信道、后半用 d 的抗
 * GPU），是 OWASP 对「口令派生」的当前推荐。
 *
 * ## 参数
 *
 * 默认用 OWASP 最低档 m=19456 KiB / t=2 / p=1。65 §2 的本机实测：这一档
 * ≈ 66–102 ms（本次实测 66 ms）。目标是「交互式解锁可以接受」，不是「尽可能慢」：
 * 更慢的档位只在威胁模型是「离线暴力破解单条口令」时才划算，而本项目的口令是
 * 单用户自用，且尝试速率由「启动一次解一次」天然限制。
 *
 * ⚠️ **同步版本会阻塞 event loop**（65 §2 的实测警告）。本模块只提供同步版本，
 * 调用点**必须**在启动路径（composition-root / CLI），绝不能进请求路径：
 * 默认参数下启动时阻塞 ~70 ms 可接受，请求路径阻塞 70 ms 不可接受。
 *
 * ## 为什么不用 PHC 字符串
 *
 * Argon2 的 PHC 格式（`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`）要求
 * base64 **不带填充**，而 Node 的 `Buffer.toString('base64')` 带 `=` 填充，
 * `from(..., 'base64')` 又两种都吃——编解码不对称是踩坑点。本模块改用
 * **结构化记录 + hex 编码**：自描述（参数与盐都在里头，换参数后旧 KEK 仍可验证）、
 * 无编码歧义、可逐字段断言。代价是不与 libsodium/passlib 的 PHC 串互通——
 * 本项目没有互通需求（KEK 只在本进程内用），换取正确性。
 */

/**
 * ## 两条不能混的用途
 *
 * Argon2id 在本仓库有**两个完全独立**的用途，接口也因此分成两套：
 *
 * 1. **KEK 派生**（`Argon2Meta` + `deriveKekFromMeta`）——输出**就是 KEK**。
 *    落盘的只有 `salt` + `params`，**绝不落 hash**：hash 就是 KEK，把它写进
 *    密钥表等于把解锁口令换成「拿到文件即可」，口令的存在意义归零。
 *    口令对不对由「解包 DEK + canary 校验」判定（见 keystore.ts）。
 * 2. **口令校验**（`Argon2Record` + `verifyArgon2Record`）——管理面登录密码
 *    这类「需要存哈希来比对」的场景。它的输出不是任何密钥，落 hash 是标准做法。
 *
 * 把这两件事混成一个接口（都返回带 hash 的记录）是本次实现期间真实犯过的错：
 * 第一版让 passphrase 模式把 `hash_hex` 也序列化进了密钥表，等于把 KEK 明文
 * 落盘。现在用**两套类型**把它在编译期分开。
 */

import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Argon2id 的 OWASP 最低推荐档。 */
export const DEFAULT_ARGON2ID_PARAMS = {
  /** 内存硬度（KiB）。19456 KiB = 19 MiB。 */
  memoryKiB: 19_456,
  /** 迭代轮数。 */
  timeCost: 2,
  /** 并行度。Node 的 argon2 单次调用是单线程，p=1 与 lanes 语义对应。 */
  parallelism: 1,
} as const;

/** 派生输出长度：32 字节 = 256 bit KEK。 */
export const KEK_LEN = 32;
/** 盐长度：16 字节 = 128 bit（Argon2 规范要求 ≥ 8）。 */
export const SALT_LEN = 16;
/** Argon2 版本号（v1.3 = 19）。 */
export const ARGON2_VERSION = 19;

export type Argon2Algorithm = 'argon2id';

/** Argon2id 成本参数。整体作为一个值传递，便于「参数升级」的显式判定。 */
export interface Argon2IdParams {
  memoryKiB: number;
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_PARAMS: Argon2IdParams = { ...DEFAULT_ARGON2ID_PARAMS };

/**
 * 用途 1 的落盘元数据：盐 + 参数，**不含 hash**。
 *
 * 这是 KEK 派生唯一允许落盘的东西。口令对不对不由「比对 hash」判定，
 * 而由「用派生出的 KEK 解包 DEK + canary 校验」判定（见 keystore.ts）——
 * 所以这里根本不需要 hash，也就不可能把 KEK 泄到磁盘上。
 */
export interface Argon2Meta {
  algo: Argon2Algorithm;
  version: number;
  params: Argon2IdParams;
  /** 128-bit 随机盐。 */
  salt: Buffer;
}

/** 新建一份 KEK 派生元数据（现场生成随机盐）。 */
export function createArgon2Meta(params: Argon2IdParams = DEFAULT_PARAMS): Argon2Meta {
  return {
    algo: 'argon2id',
    version: ARGON2_VERSION,
    params: { ...params },
    salt: randomBytes(SALT_LEN),
  };
}

/** 用元数据派生 KEK（= Argon2id 输出）。**同步，会阻塞 event loop**。 */
export function deriveKekFromMeta(passphrase: string, meta: Argon2Meta): Buffer {
  assertPassphrase(passphrase);
  if (meta.algo !== 'argon2id') throw new Error(`不支持的 KDF 算法: ${String(meta.algo)}`);
  return argon2idRaw(passphrase, meta.salt, meta.params);
}

/** 用途 2 的记录：盐 + 参数 + **摘要**（口令校验用，不是密钥）。 */
export interface Argon2Record {
  algo: Argon2Algorithm;
  version: number;
  params: Argon2IdParams;
  salt: Buffer;
  /**
   * 256-bit 派生输出。
   *
   * ⚠️ 当这条记录用于 **KEK 派生**时，这个字段就是 KEK 本体，**绝不能序列化落盘**。
   * 落盘用途请用 `Argon2Meta`（没有 hash 字段）或 `serializeArgon2RecordForPassword`
   * （只用于登录口令校验，不产生任何密钥）。
   */
  hash: Buffer;
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('口令不能为空');
  }
}

/**
 * 跑一次 Argon2id。
 *
 * Node 26 的签名是 `argon2Sync(algorithm, parameters)`（**算法名是第一个位置参数**，
 * 不是 `options.algorithm`），返回**裸 Buffer**（没有 PHC 输出选项）——
 * 这就是上面「为什么不用 PHC 字符串」的由来。
 */
export function argon2idRaw(
  passphrase: string,
  salt: Buffer,
  params: Argon2IdParams = DEFAULT_PARAMS,
): Buffer {
  assertPassphrase(passphrase);
  if (salt.length < 8) {
    throw new Error(`Argon2id 盐至少 8 字节，收到 ${salt.length}`);
  }
  const out = argon2Sync('argon2id', {
    message: passphrase,
    nonce: salt,
    memory: params.memoryKiB,
    passes: params.timeCost,
    parallelism: params.parallelism,
    tagLength: KEK_LEN,
  });
  if (out.length !== KEK_LEN) {
    throw new Error(`Argon2id 输出长度异常: ${out.length}（期望 ${KEK_LEN}）`);
  }
  return out;
}

/** 新建一条 Argon2 记录（现场生成随机盐）。`hash` 即 KEK。 */
export function createArgon2Record(
  passphrase: string,
  params: Argon2IdParams = DEFAULT_PARAMS,
): Argon2Record {
  const salt = randomBytes(SALT_LEN);
  return {
    algo: 'argon2id',
    version: ARGON2_VERSION,
    params: { ...params },
    salt,
    hash: argon2idRaw(passphrase, salt, params),
  };
}

/**
 * 用已存记录校验口令（**常量时间**比较）。
 *
 * 做法是「用记录里的盐与参数重算一遍再比」，而不是「从记录里取出 hash 比」——
 * 前者让参数升级天然正确（换过参数的旧记录照样能验），后者在参数不匹配时会
 * 给出「口令错误」的假象，把「参数不匹配」伪装成「用户输错了」。
 *
 * 空口令返回 **false** 而不是抛错：这是「校验」函数，调用方要的是「过 / 不过」
 * 这个答案；抛错会让 UI 把「用户没输口令」显示成一次崩溃，而不是
 * 「口令不正确」。（`argon2idRaw` 仍然拒绝空口令——那是派生路径，
 * 空口令派生出一个 KEK 没有任何意义。）
 */
export function verifyArgon2Record(passphrase: string, record: Argon2Record): boolean {
  if (typeof passphrase !== 'string' || passphrase.length === 0) return false;
  const recomputed = argon2idRaw(passphrase, record.salt, record.params);
  if (recomputed.length !== record.hash.length) return false;
  return timingSafeEqual(recomputed, record.hash);
}

/**
 * 需要按新参数重算吗（口令没变但要升级成本时）。
 *
 * 对 `Argon2Meta` 与 `Argon2Record` 都适用（两者都有 `params`）。
 */
export function needsRehash(
  record: { params: Argon2IdParams },
  target: Argon2IdParams,
): boolean {
  return (
    record.params.memoryKiB < target.memoryKiB ||
    record.params.timeCost < target.timeCost ||
    record.params.parallelism !== target.parallelism
  );
}

// ---------------------------------------------------------------------------
// 序列化
//
// 两条独立的序列化路径，对应上面两个用途。**没有**「把 Argon2Record 连 hash
// 一起序列化」的函数——那是第一版真实犯过的错（KEK 明文落盘）。
// ---------------------------------------------------------------------------

/** KEK 派生元数据的 JSON 形状。**没有 hash 字段**，这是设计而不是遗漏。 */
export interface SerializedArgon2Meta {
  algo: Argon2Algorithm;
  version: number;
  params: Argon2IdParams;
  salt_hex: string;
}

export function serializeArgon2Meta(m: Argon2Meta): SerializedArgon2Meta {
  return {
    algo: m.algo,
    version: m.version,
    params: { ...m.params },
    salt_hex: m.salt.toString('hex'),
  };
}

export function deserializeArgon2Meta(s: SerializedArgon2Meta): Argon2Meta {
  if (s.algo !== 'argon2id') throw new Error(`不支持的 KDF 算法: ${String(s.algo)}`);
  return {
    algo: 'argon2id',
    version: s.version,
    params: { ...s.params },
    salt: Buffer.from(s.salt_hex, 'hex'),
  };
}

/**
 * 登录口令校验记录的 JSON 形状（**含 hash**）。
 *
 * 只用于「校验一个口令对不对」（管理面登录），不用于 KEK 派生——
 * 那条路走 `SerializedArgon2Meta`。给这个函数起这么长的名字是故意的：
 * 让「连 hash 一起序列化」这件事在调用点一眼可见，不会被误用在密钥派生上。
 */
export interface SerializedArgon2PasswordRecord {
  algo: Argon2Algorithm;
  version: number;
  params: Argon2IdParams;
  salt_hex: string;
  hash_hex: string;
}

export function serializeArgon2PasswordRecord(
  r: Argon2Record,
): SerializedArgon2PasswordRecord {
  return {
    algo: r.algo,
    version: r.version,
    params: { ...r.params },
    salt_hex: r.salt.toString('hex'),
    hash_hex: r.hash.toString('hex'),
  };
}

export function deserializeArgon2PasswordRecord(
  s: SerializedArgon2PasswordRecord,
): Argon2Record {
  if (s.algo !== 'argon2id') throw new Error(`不支持的 KDF 算法: ${String(s.algo)}`);
  return {
    algo: 'argon2id',
    version: s.version,
    params: { ...s.params },
    salt: Buffer.from(s.salt_hex, 'hex'),
    hash: Buffer.from(s.hash_hex, 'hex'),
  };
}
