/**
 * storage/crypto/wrap.ts —— AES-256-KW（RFC 3394）密钥包裹。
 *
 * 用途：把随机生成的 256-bit DEK 用 KEK **包裹**成一段可安全落盘的密文。
 * 这是 65 §3.1 设计风险 1 的定稿解法：DEK **随机生成**、用 KEK **包裹**（而不是
 * `DEK = HKDF(KEK, session_id)` 派生）。派生態的问题写在那里——换 KEK 会让所有
 * DEK 全变，必须重加密全部数据，「只重包」不成立；包裹態换 KEK 只重包密钥表里
 * 那一小段，数据密文一个字节都不动。
 *
 * ## 为什么用 KW 而不是直接拿 KEK 当 DEK
 *
 * 1. **密钥分离**：KEK 的唯一职责是包 DEK；DEK 才是干加密数据的活。
 *    轮换 KEK（改口令 / 升级 KDF 参数）因此不需要碰任何数据密文。
 * 2. **可轮换 DEK**：DEK 有加密次数上限（见 keystore.ts 的 ROTATE_AFTER_ENCRYPTIONS），
 *    到了就换一把新 DEK，旧记录靠 `dek_id` 继续可读。直接拿 KEK 当 DEK 的话，
 *    「KEK 轮换」和「DEK 轮换」会耦合成同一件事，而它们的动机完全不同
 *    （前者是口令/KDF 升级，后者是 nonce 重用风险）。
 * 3. **包裹目标可审计**：密钥表里躺着的是一段 AES-256-KW 输出，人能看懂它是
 *    「被包起来的密钥」，而不是又一堆语义不明的密文字节。
 *
 * ## 为什么不用 AES-GCM 包 DEK（65 §3.1 提的备选）
 *
 * `AES-256-GCM + AAD=session_id` 也能包，但 GCM 需要 nonce——包裹操作的 nonce
 * 从哪来又是一个要拍板的问题，而 KW 的 AIV（Alternative Initial Value）是规范
 * 固定的常量，没有 nonce 管理负担。对「包一把 256-bit 密钥」这个特定任务，
 * KW 是专用的、无自由参数的解。
 *
 * Node 内置 `id-aes256-wrap`（OpenSSL 的 AES key wrap）**不接受 `null`/空 IV**，
 * 必须显式传 RFC 3394 的 AIV（`A6 A6 A6 A6 A6 A6 A6 A6`）——这就是 KW 规范里那个
 * 「完整性校验值」常量。本模块因此把它显式传进去，并在测试里用 RFC 3394 §4.1
 * 的官方向量 + Python `cryptography.keywrap` 双重交叉验证过（见 wrap.test.ts）。
 *
 * KW **不支持 AAD**（RFC 3394 没有这个概念）。本用途不需要 AAD：「包的是什么」
 * 由密钥表的 `dek_id` 表达，而 KW 自带的 AIV 已经提供完整性校验。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-KW 的算法名（Node 内置 cipher）。 */
const KW_ALGORITHM = 'id-aes256-wrap';
/**
 * RFC 3394 的 AIV（Alternative Initial Value， integrity check value）。
 *
 * ⚠️ 这是规范规定的固定常量，**不是随机 IV**。Node 的 `createCipheriv` 对 wrap
 * 算法要求显式传入它（传 `null` 或空 Buffer 会抛 "Invalid initialization vector"）。
 */
const KW_AIV = Buffer.from('a6a6a6a6a6a6a6a6', 'hex');
/** 导出 AIV 供测试断言（证明我们用的是规范常量而不是随手一个 IV）。 */
export { KW_AIV };
/** 被包裹的密钥长度：256 bit。 */
export const WRAPPED_KEY_LEN = 32;
/** KW 输出比输入长 8 字节（64-bit 完整性校验值 AIV）。 */
const KW_OVERHEAD = 8;

/** 生成一把随机 DEK（256 bit，密码学安全）。 */
export function randomDek(): Buffer {
  return randomBytes(WRAPPED_KEY_LEN);
}

/**
 * 用 KEK 包裹 DEK。
 *
 * @param kek 256-bit KEK
 * @param dek 256-bit DEK
 * @returns 40 字节包裹结果（32 + 8）
 */
export function wrapKey(kek: Buffer, dek: Buffer): Buffer {
  if (kek.length !== WRAPPED_KEY_LEN) {
    throw new Error(`KEK 长度必须是 ${WRAPPED_KEY_LEN} 字节，收到 ${kek.length}`);
  }
  if (dek.length !== WRAPPED_KEY_LEN) {
    throw new Error(`DEK 长度必须是 ${WRAPPED_KEY_LEN} 字节，收到 ${dek.length}`);
  }
  const cipher = createCipheriv(KW_ALGORITHM, kek, KW_AIV);
  // KW 不需要随机 IV；AIV 是规范固定常量（见文件头）。
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  if (wrapped.length !== WRAPPED_KEY_LEN + KW_OVERHEAD) {
    throw new Error(`AES-256-KW 输出长度异常: ${wrapped.length}`);
  }
  return wrapped;
}

/**
 * 解包 DEK。
 *
 * 失败（KEK 不对 / 数据被改）时抛错——Node 在 `final()` 阶段抛
 * "unwrap failed"。调用方必须把它当「密钥错误」处理并 fail fast
 * （65 §3.3 第 4 条：密钥错误必须明确报错并退出，不能静默建新库）。
 */
export function unwrapKey(kek: Buffer, wrapped: Buffer): Buffer {
  if (kek.length !== WRAPPED_KEY_LEN) {
    throw new Error(`KEK 长度必须是 ${WRAPPED_KEY_LEN} 字节，收到 ${kek.length}`);
  }
  if (wrapped.length !== WRAPPED_KEY_LEN + KW_OVERHEAD) {
    throw new Error(
      `AES-256-KW 输入长度必须是 ${WRAPPED_KEY_LEN + KW_OVERHEAD} 字节，收到 ${wrapped.length}`,
    );
  }
  const decipher = createDecipheriv(KW_ALGORITHM, kek, KW_AIV);
  return Buffer.concat([decipher.update(wrapped), decipher.final()]);
}

/**
 * KEK 指纹：用于在密钥表里标出「这段 DEK 是哪把 KEK 包的」。
 *
 * 用 SHA-256 的前 8 字节（hex）而不是全 32 字节：指纹只用于**分辨**，
 * 不用于认证（认证由 KW 自身的 AIV 完整性校验负责）。短指纹让人在
 * 密钥表里一眼看出「这一行还是旧 KEK，该重包了」。
 *
 * ⚠️ 指纹是**单向**的：它不能反推 KEK，但能确认「两段是不是同一把 KEK 包的」。
 * 不要把指纹当秘密——它不是。
 */
export function kekFingerprint(kek: Buffer): string {
  return createHash('sha256').update(kek).digest('hex').slice(0, 16);
}
