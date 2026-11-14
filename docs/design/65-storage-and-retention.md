# 65 · 存储、加密与保留策略

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)、[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)

---

## 0. 阅读指引

§1 决策；§2 存储选型对比与结论；§3 密钥管理；§4 分层存储与开关；§5 前缀压缩；§6 脱敏；§7 保留策略与导出；§8 Open Questions。

---

## 1. 设计决策

### 决策 S1：SQLite 单文件 + 整库加密 + payload 列应用层信封加密（双层）

**决策**：

- **第一层（整库）**：SQLite + `better-sqlite3-multiple-ciphers`，`PRAGMA cipher='chacha20'`（sqleet/AEAD，官方推荐默认）。
- **第二层（列级）**：payload 列（消息内容、媒体二进制）额外用应用层 XChaCha20-Poly1305 加密（192-bit 随机 nonce，见 §3.1），**AAD 绑定 `request_id + ir_version`**。

> **AAD 写法已全文统一（review #2(a)）**：00 §7.4 原写"记录 id"、60 §6 原写"request_id"、本节 §3.1 原写"request_id + ir_version"、60 §7.5 原写"id + session_key + turn_index"——四种写法并存。现统一为 **`request_id + ir_version`**；轮次维度的防重放在 §5.5 第 4 条以"在其上再加 `session_key + turn_index`"的方式表达，不再另起一套。

**理由**：

1. 整库加密覆盖"数据库文件被拷走"的全部场景（含 WAL、临时表、索引泄漏的元数据）；
2. 列级信封加密覆盖"整库密钥不得不常驻内存"的残余风险——即使库被打开，敏感列仍解不开；同时让**备份/迁移可以只导密文**，以及支持将来换算法而不重写整库；
3. SQLite 单文件对"单机私有用例"是运维成本最低解：无额外服务、无连接池、备份就是拷文件。

**考虑过的替代方案与否掉理由**：

| 方案 | 否掉理由 |
|---|---|
| **SQLCipher** | v5.0.0-beta 默认从 AES-256-CBC+PBKDF2-256K 改成 AES-256-GCM + 8192 page + kdf 512K（beta.1 又改回 256K），**与 v4 默认不兼容**，需要 `PRAGMA cipher_migrate`；Node 无官方绑定。作为整库加密的备选保留（同包内一行 PRAGMA 可切），不作默认 |
| **libsql / Turso** | 加密是 `--experimental-encryption`（未经第三方审计）；**不支持 key rotation**（只能 export/reimport）；Turso 正被 Supabase 收购，战略风险。其 "incremental storage" **未找到官方文档** |
| **Postgres + pgcrypto / TDE** | 社区版无 TDE；pgcrypto 只是列级 `pgp_sym_encrypt`；pg_tde 必须用 Percona Server fork 且不加密 temp files。单节点私有部署运维成本过高 |
| **加密 append-only 日志（age / JSONL）** | 无可查询性。只适合做**归档层**，不适合做主存储。age 官方也明确不建议自动化系统用 passphrase-only |

**代价**：双层加密有两次加解密开销（实测占比很小，主要成本在 Argon2id 派生，只在启动时一次）；整库加密后**无法在 SQL 里对密文列做 WHERE 查询**——因此敏感列的检索必须走"先解密再过滤"或"用明文索引列"（见 §4.3）。

### 决策 S2：消息内容持久化默认关闭，usage 元数据默认开启

**决策**：`persistence.messages` 默认 `off`；`persistence.usage` 恒 `on`（不可关，计费必需）。

**理由**：隐私优先是部署前提；usage 元数据小且非敏感，关掉会让计费/看板/dog-fooding 全废。两层分开后，"开着计费但不存聊天记录"是默认且合理的状态。

### 决策 S3：密钥三档来源，无人值守默认 OS keyring 档

见 §3。

### 决策 S4：先压缩、后加密

**决策**：任何要落盘的 payload 都先 zstd 压缩、再 XChaCha20-Poly1305 加密（算法口径见 §3.1）。

**理由**：密文不可压缩。顺序反了会让压缩率归零（这是最容易犯的实现错误）。

---

## 2. 存储选型对比（结论表）

| 维度 | SQLite + SQLite3MultipleCiphers + 列级信封 | SQLCipher | libsql | Postgres | age/JSONL |
|---|---|---|---|---|---|
| 加密范围 | 整库 + 列级 | 整库 | 整库（page-level AEAD） | 无 TDE（pgcrypto 列级） | 文件级 |
| 算法 | chacha20(sqleet AEAD) / aes256cbc / aegis / ascon128 / sqlcipher | AES-256-CBC+HMAC-SHA512（v4）/ GCM（v5 beta） | AEGIS-256 / AES-256-GCM | pgp_sym_encrypt | ChaCha20-Poly1305 |
| Key rotation | ✅ `PRAGMA rekey`（WAL 模式自 2.4.0 支持） | ✅ `PRAGMA rekey` | ❌ 只能 export/reimport | ❌ | 换 recipient |
| Node 绑定 | `better-sqlite3-multiple-ciphers` | 同上（`cipher='sqlcipher'`） | `@libsql/client` | `pg` | `age-encryption` |
| License | MIT | BSD | MIT | PostgreSQL | MIT |
| 运维成本 | 低（单文件） | 低 | 低 | **高** | 低 |
| 可查询性 | ✅（明文列） | ✅ | ✅ | ✅ | ❌ |
| 结论 | **推荐** | 备选（保守） | ❌ | ❌ | 仅归档层 |

**实测数据**（调研样机，Node v26.13.0）：

- Argon2id（`crypto.argon2Sync`，OWASP 最低档 m=19456 KiB, t=2, p=1）≈ **102 ms**；m=47104 KiB/t=1/p=1 ≈ 163 ms；m=64 MiB/t=3/p=4 ≈ 198 ms。
- ⚠️ **`argon2Sync` 阻塞 event loop**，只能在启动路径用；请求路径必须用异步 `crypto.argon2()` 或完全避开（见 §3.2）。
- zstd：同分布训练字典 **6.43×**（400 条 × 125 KB 样本）vs 无字典 1.25×；**跨分布字典反而变差（1.25× → 1.08×）**——字典必须按真实数据分布训练并版本化。
- `zstd --train` 要求 > 100 样本（少于直接报错）。
- 调研样机 **无 TPM**（无 `/dev/tpm0`、`/sys/class/tpm`）、**无 Secret Service/libsecret**；`systemd-creds` / `LoadCredentialEncrypted=` **已确认可用**。

---

## 3. 密钥管理

### 3.1 密钥层次

```text
用户口令 (passphrase)  ──Argon2id──▶  KEK (Key Encryption Key)
                                          │
                                          ▼
                          per-session DEK = 随机生成（crypto.randomBytes(32)）
                                          │
                                          ▼
                    DEK 用 KEK 包裹（AES-256-KW）后存入密钥表（按 session 一行）
                                          │
                                          ▼
                              每条记录的 XChaCha20-Poly1305 密文
                              nonce = 随机 192-bit（不做计数器持久化）
                              AAD   = request_id + ir_version
```

**信封加密（review #8.1，作者已拍板定稿）**：DEK **随机生成**（`crypto.randomBytes(32)`），用 KEK
**包裹（wrap，AES-256-KW / RFC 3394）**后存入密钥表（按 session 一行）。**不采用
`DEK = HKDF(KEK, salt=session_id, …)` 这种派生方式**——派生下更换 KEK 会让所有 DEK 全部改变，
必须重加密全部数据，与"轮换 KEK 只需重包 DEK"互斥。

> **HKDF 在本项目中的边界（写死，防止回退）**：KEK 只由 Argon2id 从用户口令派生；DEK 只由
> `crypto.randomBytes(32)` 生成。**HKDF 不用于从 KEK 派生 DEK。** 若将来要在别处引入 HKDF
> （例如派生死信 token 的绑定值、派生密钥表的主密钥），必须在文档里显式命名并说明它**不是** DEK
> 的来源，否则会重新引入"换了 KEK 数据要全量重加密"的歧义。

**为什么 per-session DEK + 包裹**：密钥轮换与 nonce 管理一起解决——轮换 KEK 只需**重包**密钥表里的
DEK（unwrap → rewrap，数据密文不动），不必重加密全部数据；per-session 隔离让单个 DEK 的加密次数可控。

**代价与运维约束**（同步写进部署文档）：① 密钥表成为新的单点——丢了 DEK 就丢了数据，备份/导出流程
（§7）必须覆盖它，**密钥表与数据库必须一起备份**；② 解锁时要把该 session 的 DEK 取出来——采用
**首次访问时惰性解**（按 `session_key` 逐行 unwrap 后进带 TTL 的内存缓存），不做启动时批量全解
（会话数不可控，启动延迟不可接受）；③ 轮换 KEK 时按密钥表逐行重包，重包期间新写入用新 KEK 包裹的 DEK。

**nonce：XChaCha20-Poly1305 + 192-bit 随机 nonce（review #8.2，作者已拍板定稿）**：**不做计数器
持久化**。原方案的"session 内单调计数器"在进程重启、多 worker、多进程写同一个 session 时，若未持久化
或未按 (session, worker) 分片就会重用 nonce；计数器方案还隐含要求"写路径串行化"，与异步写入冲突。
192-bit 随机 nonce 天然适配重启/多 worker/多进程，也不需要串行化写路径。

> **替代方案 AES-GCM-SIV**：若将来需要 FIPS 验证算法、或审计合规要求只接受 NIST 标准化的 AEAD，
> 可切到 AES-GCM-SIV（nonce 误用也不破坏机密性）。**取舍**：代价是吞吐约低 2–3×，且 96-bit nonce
> 仍需随机生成 + 单密钥加密次数上限（NIST SP 800-38D 建议随机 nonce 时最多 2^32 次）。默认
> XChaCha20-Poly1305（无次数上限的 birthday 压力、软件实现快，无 AES-NI 的机器上尤其明显）。

**算法口径统一**：本文 §1 决策 S1/S4、§2 选型表、§4.3 表结构、§5.2、§5.5 与
[00-overview.md](./00-overview.md) §7.4、[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) 里
出现 `AES-256-GCM` 字样的地方，一律按本节的 **XChaCha20-Poly1305** 理解（整库加密的 cipher 不受影响，
那是 SQLite 层的 `chacha20` sqleet AEAD）。

### 3.2 三档来源

| 档 | 密钥来源 | 解锁方式 | 适用 | 取舍 |
|---|---|---|---|---|
| **A** | 用户口令 | 启动时交互输入 → Argon2id → KEK | 有人值守 | 最安全；**网关无法自动重启** |
| **B（推荐默认）** | OS keyring / systemd credential 里的 KEK 或加密口令 | 无人值守自动 | 单机私用 | 防"备份被拷走/库文件外泄"；**不防**攻陷运行账号（root 可读 keyring） |
| **C** | 明文 key 文件 + 0600 权限 + 属主隔离 | 无人值守 | 完全无人值守、无 keyring 环境 | 等同"密钥与数据同机"，只防拷贝 |

**诚实结论**：单机私有时，**B 档是推荐默认值**。要防"攻陷运行账号"需要 TPM-sealed key 或 KMS/HSM——调研样机无 TPM，且超出本项目范围（标 **`[待验证]`**：若部署机有 TPM，可用 `tpm2-pkcs11` 封存 KEK）。

#### 3.2b 一条不能掩盖的取舍：自动解锁换不来运行时防护

**所有密钥管理方案（A/B/C 三档、TPM-sealed、KMS/HSM）都不能防护"运行中进程内存被读取"。** 一旦网关解锁并开始服务，KEK 与解包出来的 DEK 就在进程内存里；任何能读该进程内存的攻击者（同账号的恶意代码、`/proc/<pid>/mem`、core dump、内存交换到磁盘）都能拿到密钥。

**无人值守自动解锁的本质是产品层取舍：用"无人值守"换"离线泄露防护"，这个取舍无法靠技术掩盖。**

| 场景 | A 档（启动口令） | B 档（keyring 自动） | C 档（key 文件） |
|---|---|---|---|
| 备份文件被拷走 / 库文件外泄 | ✅ 防住 | ✅ 防住 | ✅ 防住 |
| 攻陷运行账号（可读文件与 keyring） | ✅ 防住 | ❌ | ❌ |
| 读运行中进程内存 | ❌ | ❌ | ❌ |
| 无人值守自动重启 | ❌ | ✅ | ✅ |

**设计上的处置**（不掩盖，写进部署文档）：

1. 部署文档必须明确告知用户这个边界，并给出"A 档更安全但网关不能自动重启"的显式选择；
2. 提供**内存最小化**手段：解锁后从内存擦除口令原文（只保留 KEK）；DEK 按 session 解包、session 结束即弃（带 TTL 的缓存，见 §3.1）；不开 swap，或对持有密钥的内存页 `mlock`；
3. **不把 B 档说成"安全"**，只说成"在无人值守前提下，比 C 档多一层（依赖 OS 凭据存储的访问控制）"；
4. 若将来威胁模型变为"多用户同机"或"运行账号可能被攻陷"，再上 TPM/KMS 并重新评估——现在不做，是因为调研样机无 TPM 且单用户私用不需要。

**工具链**：

- `keytar` **已归档 deprecated**；替代 `@napi-rs/keyring`（MIT，Secret Service → keyutils 回退；注意 keyutils 仅内存后端）。
- systemd `LoadCredentialEncrypted=` + `systemd-creds decrypt`（调研样机已确认可用）——**无 keyring 的 Linux 上的首选**。
- Docker secrets / 环境变量（`AG_KEK_PATH` 指向文件）。

**硬规则**：密钥/口令/密文**不进 git**、不打印、不进日志、不出现在错误信息里。仓库里只有 `.env.example` 占位说明。

### 3.3 启动解锁时序

```text
1. 读 KEK 来源（B/C 档）或提示口令（A 档）
2. Argon2id 派生（~100–200 ms，阻塞，可接受；用进度日志告知用户"正在解锁"）
3. 打开 SQLite，`PRAGMA cipher=...; PRAGMA key='...'`
4. 验证：读一个已知的 canary 记录并尝试 XChaCha20-Poly1305 解密
   └─ 失败 → 明确报 "密钥错误" 并退出，不静默建新库（静默建新库会覆盖旧数据）
5. 起服务
```

第 4 条的 canary 机制很重要：**密钥错误必须 fail fast**，否则会用错密钥写入不可解的数据。

---

## 4. 分层存储与开关

### 4.1 两层

| 层 | 内容 | 体积/请求 | 敏感度 | 默认 |
|---|---|---|---|---|
| **Tier-1** | `UsageRecord` + `RequestTrace` 摘要（request_id、耗时、模型、token、finish_reason、错误码、工具计数；**不含消息正文**） | ~1 KB | 低 | **常开** |
| **Tier-2** | 完整 canonical request/response、agentic loop 每一轮、媒体二进制引用 | 数 KB ~ 数 MB | 高 | **关闭** |

### 4.2 开关语义

```text
persistence.messages ∈ { off, on }     # 默认 off
persistence.media    ∈ { off, on }     # 默认 off，二进制落地
persistence.usage    ∈ { on }          # 不可关
```

- 开关**不追溯**：开启前的请求没有内容；开启后关闭的请求按保留策略清理。
- 粒度：全局默认 + 虚拟 key 级覆盖（某 key 可强制 `off`，用于高敏感场景；**不允许** key 级强制 `on` 覆盖全局 `off`——隐私开关只能往严的方向被局部覆盖）。
- Tier-1 的 `body_ref` 在 `off` 时为空。

### 4.3 Tier-2 表结构与检索

```sql
-- 会话 delta 链（见 §5）
CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY,           -- = request_id
  session_key TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  client_format TEXT NOT NULL,
  provider_format TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'base' | 'delta' | 'snapshot'
  payload BLOB NOT NULL,         -- zstd + XChaCha20-Poly1305 密文
  sha256 TEXT NOT NULL,          -- 明文 hash，用于去重与完整性
  redaction_profile TEXT NOT NULL,
  byte_length INTEGER NOT NULL,  -- 明文长度（用于统计）
  UNIQUE(session_key, turn_index)
);
CREATE INDEX idx_ct_session ON conversation_turns(session_key, turn_index);
CREATE INDEX idx_ct_ts ON conversation_turns(ts);
CREATE INDEX idx_ct_sha ON conversation_turns(sha256);

-- zstd 全局字典 / 按客户端类型变体（与数据同级加密保管，见 §5.2）
CREATE TABLE zstd_dicts (
  dict_id TEXT NOT NULL,         -- hash(训练样本集 + zstd 版本 + maxdict)
  scope TEXT NOT NULL,           -- 'global' 或 'client_format=…;provider_format=…'
  trained_at INTEGER NOT NULL,
  dict_blob BLOB NOT NULL,       -- 加密
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (dict_id)
);

-- Tier-1
CREATE TABLE usage_events ( ... );     -- 见 60-billing-and-dogfooding.md §3
CREATE TABLE usage_rollup_daily ( ... );
CREATE TABLE usage_rollup_monthly ( ... );
CREATE TABLE retention_log ( ... );
```

```typescript
/** Tier-2 的读取视图（解密 + 回放 delta 链后的形态）。
 *  这是该类型的唯一定义处——60-billing-and-dogfooding.md 的 dog-fooding 工具只引用它。 */
interface StoredConversation {
  id: string;                        // = request_id
  session_key: string;               // 长会话分组键（用于前缀压缩）
  turn_index: number;
  ts: number;
  client_format: FormatId;
  provider_format: FormatId;
  model: string;
  /** 完整 canonical 请求（压缩前） */
  request: CanonicalRequestEnvelope;
  /** 完整 canonical 响应（聚合后） */
  response: CanonicalResponseEnvelope;
  /** 网关 agentic loop 的每一轮中间 canonical */
  turns?: Array<{ request: CanonicalRequestEnvelope; response: CanonicalResponseEnvelope }>;
  usage: CanonicalUsage;
  trace: RequestTrace;               // 见 20-pipeline.md §8
  redaction_profile: string;
}
```

> **命名统一（review #3）**：原 60 §5.3 用的字段名是 `CanonicalRequest` / `CanonicalResponse`，而 10 只定义了
> `CanonicalRequestEnvelope` / `CanonicalResponseEnvelope`，00 术语表用的也是后者。这里统一为 **`…Envelope`**
> （[00-overview.md](./00-overview.md) §5 术语表的"envelope"一条即此）。20/30/60 正文里出现的 `CanonicalRequest` /
> `CanonicalResponse` 一律按此理解；**在类型抽取成代码文件时统一改名，作者拍板前本文只做说明、不改其他文档的正文措辞。**

**检索约束**：`payload` 是密文，**不能** `WHERE payload LIKE ...`。因此：

- 会话维度检索走 `session_key` / `turn_index`（明文索引）；
- 全文检索（dog-fooding 的 `conversation_search`）走**解密后过滤**——先按 `session_key`/时间范围取候选（有上限，默认 200 条），解密后在内存里匹配。这是有意的设计：宁可慢，不把明文索引落盘。
- `sha256` 明文存，用于去重（§5.2）与完整性校验。

---

## 5. 前缀压缩 / 增量存储

### 5.1 问题

同一会话的连续请求共享极长公共前缀（system prompt + 工具定义 + 全部历史），只有最后 1–2 轮是新的。naive 存整份 canonical，第 N 轮的存储量 ≈ O(N²)。

### 5.2 方案：会话 delta 链 + zstd 全局字典

```text
session_key = S
  turn 0:  BASE     ── 完整 canonical（zstd + 加密）
  turn 1:  DELTA    ── diff(BASE, canonical_1)
  turn 2:  DELTA    ── diff(canonical_1, canonical_2)
  ...
  turn k:  SNAPSHOT ── 每 snapshot_every_turns（默认 20）轮一个完整快照，限制回放成本
```

**diff 表示**：用 JSON Patch（RFC 6902）子集——`add`（追加数组元素）、`replace`（按 path）、`remove`。整段替换的大字段（如 `response`）直接存整值，不做细粒度 diff（细粒度 diff 对大 JSON 收益低、复杂度高）。

**编码**：每条 delta 单独 zstd（level 3）；同一 `session_key` 的所有 delta 共用一个**全局训练字典**
（或其所属客户端类型变体，见下）。

**字典（review #8.5，作者已拍板定稿：取消 per-session 字典）**：

- **全局字典 + 可选按客户端类型的字典变体**：默认一个全局字典；可选按 `(client_format × provider_format)`
  分组各训一个变体（同组请求的序列化文本分布相近，正是为了避开 §5.3 记的"跨分布字典反而更差"）；
- **离线训练**：`zstd --train` 需要 **> 100 个样本**（[docs/sources.md](../sources.md) §4 实测记录），
  多数会话攒不到 100 轮就结束了，训不出字典只能退化成无字典压缩——**这是取消 per-session 字典的首要原因**。
  全局字典改为从历史 trace 的抽样语料**离线定期重训**（如每月），线上只读不写；
- **带版本号**：`dict_id = hash(训练样本集 + zstd 版本 + maxdict)`；压缩 payload 头部记下用的哪个
  `dict_id`，解压按号取字典，可复现、可回滚。重训时不立即删除旧字典——旧 `dict_id` 保留到没有 payload
  再引用它为止（新旧并存期由重训节奏决定，默认一个月）；
- **训练参数**：`--maxdict` 默认 112 KB，属离线训练参数，随 `dict_id` 一起固定下来；
- **入库加密**：字典从真实请求文本训练而来，本身会泄漏前缀特征，与数据同级加密保管（表结构见 §4.3）；
- **小会话退化**：样本不足、或 payload 头部记的 `dict_id` 已不存在 → 退化为**无字典压缩**，
  并记录实际压缩率（不假装有字典）；
- `--long` window（默认 windowLog 27，64-bit 最大 31）用于长前缀；解压端 windowLog > 27 时也必须传 `--long`。

**读取**：`BASE → 回放 delta 链 → 目标轮`。回放成本 O(轮数)，所以有 snapshot。快照本身也压缩。

### 5.3 压缩率估算（量级判断，需实测）

| 场景 | 预计 | 依据 |
|---|---|---|
| 单条 canonical 单独 zstd（无字典） | 1.25–5× | 本机实测同分布样本无字典 1.25×；文本类 JSON 常规 3–5× |
| 同会话 delta 链 + 全局字典 | 在"每轮存全量"基础上再降 **10–50×** | 前缀重复度极高；字典把"短匹配变长匹配" |
| 端到端 | 50 轮会话从 ~O(N²) 降到 ~O(N) × 1/20 | 结构性的，不依赖算法 |

**这些是量级估计，不是承诺。** Phase 1 要用真实 trace 抽样实测并写进 [docs/sources.md](../sources.md) 的基准小节。

**关键警告**：**跨分布字典反而变差（1.25× → 1.08×，本机实测）**。字典必须按真实数据分布训练并版本化——
这正是**取消 per-session 字典**（样本永远不够）并改为**全局字典 + 可选按客户端类型变体**的原因：
全局字典的样本充足；变体只在"同组请求分布一致"时才启用，否则宁可只用全局字典或无字典。

### 5.4 跨会话去重（可选，[later]）

system prompt 与工具定义在多个会话间也高度重复。用**内容定义分块（CDC，FastCDC / Gear hash）**对 canonical 序列化文本切块、按块 hash 去重、块级存储。收益取决于 system prompt 复用程度；复杂度明显高于 §5.2，默认关闭。

### 5.5 实现要点

1. **先压缩后加密**（见 S4）。
2. **字典与数据同级加密**——字典从真实请求文本训练而来，本身会泄漏前缀特征，不是非敏感资产。
3. **回放性能**：单请求最多触发一次回放；需要随机访问时以 snapshot 为入口，不做随机访问优化。
4. **AAD 绑定**：每条密文 AAD 绑 `request_id + ir_version + session_key + turn_index`——在 S1 的记录级绑定（`request_id + ir_version`）之上再加轮次维度，防密文块被换位/重放。
5. **压缩失败兜底**：zstd 失败（如字典不匹配）→ 存未压缩密文并置 `compressed: false`，读时按标记解。

---

## 6. 脱敏

在写入 Tier-2 **之前**执行；`redaction_profile` 记录用了哪套规则。

### 6.1 硬编码黑名单（永不可配置关闭）

| 目标 | 处置 |
|---|---|
| `Authorization` / `x-api-key` / `x-goog-api-key` / `api-key` 等 header | 整个 header 丢弃 |
| provider base_url 的 userinfo 段（URL 里 `scheme://用户名:口令@主机` 那种内联凭据写法） | 剥离 userinfo |
| 疑似 API key 的字符串（`sk-`、`sk-ant-`、`AIza`、`ghp_`、`xoxb-` 等前缀 + 长度特征） | 替换为 `<REDACTED:key>` |
| JWT（`eyJ` 开头三段 base64） | 替换为 `<REDACTED:jwt>` |
| `.env` 内容 / 私钥块（`-----BEGIN … PRIVATE KEY-----`） | 整块替换 |

### 6.2 可配置规则

- JSON path 黑名单（如 `messages[*].parts[*].raw.headers`）；
- 正则规则集（用户自定义：内部域名、项目代号）；
- 截断：超过 `max_stored_content_bytes`（默认 256 KB/请求）截断并标 `truncated: true`；
- 模式：`redaction.mode ∈ { store_redacted, drop_message }`，默认前者。

### 6.3 与 trace 的关系

`RequestTrace` 默认不含正文，Tier-1 几乎不触发脱敏；但 `plugin_log` / `warnings` 里可能夹带用户内容，统一走 §6.2 的路径规则。

---

## 7. 保留策略与导出

| 配置 | 默认 | 说明 |
|---|---|---|
| `retention.messages_days` | `30` | Tier-2 消息内容保留天数；`0` = 不自动清理 |
| `retention.messages_max_count` | `20000` | Tier-2 条数上限，超出按时间淘汰最旧 |
| `retention.usage_days` | `365` | Tier-1 usage 保留天数 |
| `retention.rollup_after_days` | `90` | 超过该天数的 usage 聚合为日/月 rollup，明细可归档删除 |
| `cleanup.schedule` | 每日 04:00 本地时间 | 清理任务 |
| `export.format` | 加密 JSONL + zstd | 手动导出 |

- 清理是**物理删除**（非软删），在 `retention_log` 记一条"删了哪个时间区间的多少条"（只记统计，不记内容）。
- **加密导出**：XChaCha20-Poly1305 + Argon2id 派生密钥（与 §3 同一套 KDF 参数），导出文件含版本头与 KDF 参数，便于跨机恢复。
- **备份**：SQLite 单文件 + WAL；备份时用 `VACUUM INTO`（一致性快照）而不是裸拷。备份文件本身是密文，可安全外传。

---

## 8. Open Questions

1. **Q5**：zstd 全局字典在真实 trace 上的实测压缩率，以及离线训练耗时（在线只读，训练不得进请求路径）。
2. **Q6**：Argon2id 在目标硬件的实测耗时与推荐参数组合（决定 B 档启动延迟与 A 档可用性）。
3. 整库加密后 Tier-1 的聚合查询（`GROUP BY model` 等）是否受影响——Tier-1 默认**不加密**（非敏感），需明确这个边界并在代码里强制。
4. `better-sqlite3-multiple-ciphers` 在 WAL 模式下 `PRAGMA rekey` 的稳定性（自 2.4.0 起支持，但需实测）。
5. 备份/迁移流程实测：密文 + KDF 参数 + 口令在另一台机器恢复。
6. Tier-2 全文检索的候选集上限（默认 200 条）是否够用，以及是否需要更快的索引方案（如明文倒排索引表，但那会泄漏内容）。
7. 若部署机有 TPM，`tpm2-pkcs11` 封存 KEK 的可行性（调研样机无 TPM，无法验证）。
