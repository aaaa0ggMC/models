/**
 * storage/crypto/xchacha20-poly1305.ts —— XChaCha20-Poly1305 AEAD（192-bit 随机 nonce）。
 *
 * 唯一事实来源：docs/design/65-storage-and-retention.md §1 决策 S1、§3.1 设计风险 2 的建议解法 ②。
 * 仓库主人已拍板（issue #8）：**DEK 随机生成 + KEK 包裹**；**nonce 用 192-bit 随机**
 * （不持久化计数器，适配进程重启 / 多 worker / 多进程并发写同一个 session）。
 *
 * ## 为什么是 XChaCha20-Poly1305 而不是 AES-256-GCM
 *
 * AES-GCM 的 nonce 只有 96 bit，随机 nonce 下的安全上限是单密钥 2^32 条
 * （NIST SP 800-38D），超了就有生日碰撞 → 密文被伪造。本存储的 DEK 是**长期**
 * 的（轮换 KEK 只重包 DEK，数据密文不动，见 keystore.ts），条数上限不可控。
 * XChaCha20-Poly1305 把 nonce 扩到 192 bit，随机 nonce 下单密钥可到 2^80 条以上
 * （draft-irtf-cfrg-xchacha §2.1），实现也最简单——不需要持久化计数器，也就不需要
 * 「写路径串行化」（与异步写入冲突的那件事）。
 *
 * 备选（文档里注明，本文件不实现）：**AES-GCM-SIV** 在 nonce 误用时也不泄密，
 * 适合 FIPS/审计强约束场景；代价是要对消息做两遍，且 Node 内置 AEAD 不直接提供。
 *
 * ## 实现方式：HChaCha20 子密钥派生 + Node 内置 IETF ChaCha20-Poly1305
 *
 * Node/OpenSSL 的 `chacha20-poly1305` 只接受 96-bit IV，没有暴露 `xchacha20-poly1305`。
 * XChaCha20-Poly1305 的标准构造（draft-irtf-cfrg-xchacha-03 §2）正好可以拆成两步：
 *
 *   1. `subkey = HChaCha20(key, nonce[0:16])`  —— 纯 ChaCha20 轮函数，无计数器；
 *   2. 用 `subkey` + `0x00000000 || nonce[16:24]`（4 个 NUL 字节 + 剩余 8 字节）
 *      跑标准 IETF AEAD_CHACHA20_POLY1305。
 *
 * 这样**唯一自己写的密码学原语是 HChaCha20 的轮函数**（~25 行、无分支、无查表），
 * AEAD 本体（Poly1305 + 流加密 + tag 校验）走 Node 内置的 OpenSSL 实现。
 * HChaCha20 与整个构造都过了 CFRG 官方测试向量（见本文件末尾的 VECTORS 与
 * storage/crypto/__tests__ 里的逐条断言）。
 *
 * ## AAD
 *
 * 统一一种写法，与 65 §3.1 的定稿一致：`request_id + ir_version`（65 §0 的 review #2(a)
 * 已把全文四种写法统一到这一种）。本存储是**控制面/元数据**存储（凭据、别名、审计），
 * 没有 request_id，因此 AAD 用**记录定位串**：`record_kind + record_id`，语义同构
 * （把密文绑回它所属的那一行，防密文块被换位/重放）。轮次维度（65 §5.5 第 4 条的
 * session_key + turn_index）在 Tier-2 消息存储落地时再加，不在这里预支。
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** AEAD 密钥长度：256 bit。 */
export const KEY_LEN = 32;
/** XChaCha20-Poly1305 的 nonce 长度：**192 bit**（本文件存在的理由）。 */
export const NONCE_LEN = 24;
/** Poly1305 tag 长度：128 bit。 */
export const TAG_LEN = 16;

/** ChaCha20 的 "expand 32-byte k" 常量（RFC 8439 §2.3）。 */
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;

/** 32-bit 左循环移位。用 `>>> 0` 收口成无符号，避免 JS 的 32-bit 有符号溢出。 */
function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/**
 * ChaCha20 quarter-round（RFC 8439 §2.1）。
 *
 * 就地改 `s`；四个下标分别是 a/b/c/d。
 */
function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl32(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl32(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl32(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl32(s[b]! ^ s[c]!, 7);
}

/**
 * HChaCha20：用 key 与 nonce 前 16 字节派生 32 字节子密钥。
 *
 * 与 ChaCha20 的差别（draft-irtf-cfrg-xchacha §2.2）：状态第 4 行不放
 * `counter || nonce`，而是放 **128-bit nonce 的 4 个 word**（没有计数器）；
 * 跑完 20 轮后**不做**「加回初态」那一步，只取第 1 行与第 4 行拼成输出。
 *
 * @param key   32 字节
 * @param nonce16 16 字节（XChaCha 的 192-bit nonce 的前 2/3）
 */
export function hchacha20(key: Buffer, nonce16: Buffer): Buffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`HChaCha20 key 长度必须是 ${KEY_LEN} 字节，收到 ${key.length}`);
  }
  if (nonce16.length !== 16) {
    throw new Error(`HChaCha20 nonce 必须是 16 字节，收到 ${nonce16.length}`);
  }
  const s = new Uint32Array(16);
  s[0] = SIGMA[0];
  s[1] = SIGMA[1];
  s[2] = SIGMA[2];
  s[3] = SIGMA[3];
  for (let i = 0; i < 8; i += 1) s[4 + i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i += 1) s[12 + i] = nonce16.readUInt32LE(i * 4);

  // 10 个 double round = 20 轮（column 4 个 + diagonal 4 个）。
  // ⚠️ 只写 column 不写 diagonal 是一个隐蔽且致命的错——输出仍是 32 字节、
  // 加解密仍能自洽，只是完全不安全。测试向量会抓住它。
  for (let i = 0; i < 10; i += 1) {
    quarterRound(s, 0, 4, 8, 12);
    quarterRound(s, 1, 5, 9, 13);
    quarterRound(s, 2, 6, 10, 14);
    quarterRound(s, 3, 7, 11, 15);
    quarterRound(s, 0, 5, 10, 15);
    quarterRound(s, 1, 6, 11, 12);
    quarterRound(s, 2, 7, 8, 13);
    quarterRound(s, 3, 4, 9, 14);
  }

  const out = Buffer.allocUnsafe(KEY_LEN);
  // 输出 = 第 1 行（word 0..3）+ 第 4 行（word 12..15），各自小端。
  for (const [i, w] of [0, 1, 2, 3, 12, 13, 14, 15].entries()) {
    out.writeUInt32LE(s[w]!, i * 4);
  }
  return out;
}

/**
 * 192-bit nonce → IETF ChaCha20-Poly1305 的 12 字节 IV。
 *
 * 4 个 NUL 字节 + nonce 的后 8 字节（draft-irtf-cfrg-xchacha §2.3.1 的
 * `chacha20_nonce = "\x00\x00\x00\x00" + nonce[16:23]`）。
 * 这 4 个 NUL 是规范的一部分：它们让 96-bit nonce 空间里只有 2^64 个被用到，
 * 而子密钥由前 128 bit 决定，所以后 64 bit 的重复不会导致 keystream 重复。
 */
export function xchachaNonceToIetfIv(nonce24: Buffer): Buffer {
  if (nonce24.length !== NONCE_LEN) {
    throw new Error(`XChaCha nonce 必须是 ${NONCE_LEN} 字节，收到 ${nonce24.length}`);
  }
  return Buffer.concat([Buffer.alloc(4, 0), nonce24.subarray(16, 24)]);
}

/** 密封结果：密文与 tag **分开返回**（拼在一起会让「tag 在哪」变成一个隐性约定）。 */
export interface SealedBox {
  ciphertext: Buffer;
  /** 128-bit Poly1305 tag。 */
  tag: Buffer;
  /** 本次用的 192-bit 随机 nonce（必须与密文一起存，否则解不开）。 */
  nonce: Buffer;
}

/**
 * 生成一个密码学安全的 192-bit 随机 nonce。
 *
 * **不持久化任何计数器**——这是选 192-bit 随机 nonce 而不是「session 内单调计数器」
 * 的全部理由（65 §3.1 设计风险 2：计数器在重启 / 多 worker / 多进程下会重用，
 * 对 GCM 是灾难，且要求写路径串行化）。
 */
export function randomNonce(): Buffer {
  return randomBytes(NONCE_LEN);
}

/**
 * 用**指定 nonce** 加密 + 认证。
 *
 * 为什么单独暴露一个可传 nonce 的入口：官方测试向量的 nonce 是写死的
 * （draft-irtf-cfrg-xchacha §A.3.1），没有它就没法逐位比对密文。生产路径
 * 一律用 `seal()`（内部 `randomNonce()`）——**绝不要**在生产里手写 nonce，
 * 那正是本模块要防的「nonce 重用」。
 *
 * @param key    32 字节
 * @param nonce  24 字节（192 bit）
 * @param plaintext 明文
 * @param aad    附加认证数据（不进密文，但参与 tag 计算）
 */
export function sealWithNonce(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad: Buffer = Buffer.alloc(0),
): SealedBox {
  if (key.length !== KEY_LEN) {
    throw new Error(`XChaCha20-Poly1305 key 长度必须是 ${KEY_LEN} 字节，收到 ${key.length}`);
  }
  if (nonce.length !== NONCE_LEN) {
    throw new Error(`XChaCha20-Poly1305 nonce 必须是 ${NONCE_LEN} 字节，收到 ${nonce.length}`);
  }
  const subkey = hchacha20(key, nonce.subarray(0, 16));
  const iv = xchachaNonceToIetfIv(nonce);
  const cipher = createCipheriv('chacha20-poly1305', subkey, iv, { authTagLength: TAG_LEN });
  // ChaCha20-Poly1305 的 setAAD **必须**带 plaintextLength（@types/node 的
  // CipherChaCha20Poly1305 签名要求，运行时也要求）——流密码下它就是密文长度。
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag(), nonce: Buffer.from(nonce) };
}

/** 加密 + 认证（**生产入口**：内部生成 192-bit 随机 nonce）。 */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer = Buffer.alloc(0)): SealedBox {
  return sealWithNonce(key, randomNonce(), plaintext, aad);
}

/**
 * 解密 + 校验。
 *
 * 认证失败时抛错（Node 在 `final()` 阶段抛 "Unsupported state or unable to
 * authenticate data"）。调用方必须把它当成「数据被篡改或 key 不对」处理，
 * **不要**把半解密结果当明文用。
 */
export function open(
  key: Buffer,
  box: { ciphertext: Buffer; tag: Buffer; nonce: Buffer },
  aad: Buffer = Buffer.alloc(0),
): Buffer {
  if (key.length !== KEY_LEN) {
    throw new Error(`XChaCha20-Poly1305 key 长度必须是 ${KEY_LEN} 字节，收到 ${key.length}`);
  }
  if (box.tag.length !== TAG_LEN) {
    throw new Error(`tag 长度必须是 ${TAG_LEN} 字节，收到 ${box.tag.length}`);
  }
  const subkey = hchacha20(key, box.nonce.subarray(0, 16));
  const iv = xchachaNonceToIetfIv(box.nonce);
  const decipher = createDecipheriv('chacha20-poly1305', subkey, iv, { authTagLength: TAG_LEN });
  // 解密侧同理：ChaCha20 是流密码，明文长度 == 密文长度。
  decipher.setAAD(aad, { plaintextLength: box.ciphertext.length });
  decipher.setAuthTag(box.tag);
  return Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
}

/**
 * 常量时间比较两个缓冲区。
 *
 * 用 Node 内置的 `timingSafeEqual` 而不是自己写 `for` 循环——手写的"早退"比较
 * 会因为分支预测泄漏内容。长度不同直接返回 false（长度本身在这里不是秘密：
 * 它比较的是两个 tag，长度恒等于 TAG_LEN）。
 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// CFRG 官方测试向量（draft-irtf-cfrg-xchacha-03）
//
// 这三个向量是本文件的**正确性证明**，也是"轮函数写错会静默不安全"的护栏。
// 逐条断言见 storage/crypto/xchacha20-poly1305.test.ts。
// ---------------------------------------------------------------------------

/** HChaCha20 block function 向量（draft §2.2.1）。 */
export const HCHACHA20_VECTOR = {
  key: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  nonce16: '000000090000004a0000000031415927',
  subkey: '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
} as const;

/** AEAD_XChaCha20_Poly1305 向量（draft §A.3.1）。 */
export const AEAD_XCHACHA20_POLY1305_VECTOR = {
  key: '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
  nonce24: '404142434445464748494a4b4c4d4e4f5051525354555657',
  aad: '50515253c0c1c2c3c4c5c6c7',
  plaintext:
    '4c616469657320616e642047656e746c656d656e206f662074686520636c6173' +
    '73206f66202739393a204966204920636f756c64206f6666657220796f75206f' +
    '6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73' +
    '637265656e20776f756c642062652069742e',
  ciphertext:
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
    '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
    '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
    '21f9664c97637da9768812f615c68b13b52e',
  tag: 'c0875924c1c7987947deafd8780acf49',
} as const;
