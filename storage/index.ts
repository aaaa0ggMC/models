/**
 * storage/index.ts —— 加密存储模块出口。
 *
 * 模块定位（docs/design/00-overview.md §4.2 + AGENTS.md「代码组织」）：
 *   `storage/` **只被管理面与 dog-fooding 接口读写，不被请求主链路同步依赖**。
 *   本模块的消费者是 admin/（控制面）与将来的 metering 归档；pipeline 的
 *   S0–S10 不 import 这里任何东西。
 *
 * 目录：
 *   crypto/   —— 密码学原语（XChaCha20-Poly1305 / Argon2id / AES-256-KW / AAD）
 *   keystore.ts        —— 密钥管理（解锁模式、DEK、KEK 轮换、canary）
 *   record-store.ts    —— 加密记录存储（接口 + 内存 / JSON 文件实现）+ 脱敏
 *   virtual-keys.ts    —— 数据面 virtual key 记录（**只存 Argon2id 哈希，永不明文**）
 *
 * ⚠️ 待文档更新（不由本线程改，走 PR）：00-overview.md §4.2 的模块表还没有
 * `storage/` 的「加密 KV/记录存储」一行——65 号文档设计了它，但没有模块条目。
 * 见报告的「待文档更新」清单。
 */

export * from './crypto/xchacha20-poly1305.js';
export * from './crypto/aad.js';
export * from './crypto/kdf.js';
export * from './crypto/wrap.js';
export * from './keystore.js';
export * from './record-store.js';
export * from './virtual-keys.js';
