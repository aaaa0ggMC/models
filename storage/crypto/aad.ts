/**
 * storage/crypto/aad.ts —— AAD（附加认证数据）的**唯一**写法。
 *
 * 唯一事实来源：docs/design/65-storage-and-retention.md §0 的 review #2(a) 与 §3.1。
 * 65 号文档原本在四处写了四种不同的 AAD（00 §7.4「记录 id」、60 §6「request_id」、
 * §3.1「request_id + ir_version」、60 §7.5「id + session_key + turn_index」），
 * review 后统一为 **`request_id + ir_version`**。
 *
 * 本模块是**控制面 / 元数据**存储（凭据、别名、审计日志），不在请求主链路上，
 * 没有 request_id。因此 AAD 用语义同构的**记录定位串**：
 *
 *   `record_kind + record_id`
 *
 * 与 `request_id + ir_version` 同构：把密文绑回「它属于哪一行」，让密文块被
 * 换位（把 A 行的密文塞到 B 行）或被重放时认证失败。轮次维度
 * （65 §5.5 第 4 条的 `session_key + turn_index`）在 Tier-2 消息存储落地时
 * 在其上叠加，**不在本模块预支**——提前加一个用不上的维度只会让 AAD 写法
 * 再次分裂成两种。
 *
 * 编码：UTF-8，字段间用 `\x1f`（US，单元分隔符）连接。为什么不用 `|` 或 `/`：
 * 这两种字符会出现在 id 里（alias id 可能含 `/`，如 `deepseek/foo`），
 * 用可打印字符做分隔符就有歧义——`a/b` + `c` 与 `a` + `b/c` 会撞。
 * `\x1f` 不可能出现在我们生成的 id 里，且一眼能看出是分隔符。
 */

/** 字段分隔符：ASCII Unit Separator。绝不出现在本仓库生成的任何 id 里。 */
const FIELD_SEP = '\u001f';

/**
 * 记录种类。
 *
 * 加进 AAD 的意义：同一把 DEK 下，凭据密文与审计密文的 nonce 空间是共享的。
 * 绑定 kind 让「把审计条目复制成凭据条目」也过不了认证（即使 id 恰好相同）。
 */
export type AadRecordKind =
  | 'credential'
  | 'alias'
  | 'provider'
  | 'audit'
  | 'virtual_key'
  | 'admin_session'
  | 'meta';

/** AAD 输入。`version` 是记录自身的 schema 版本（与 ir_version 同地位）。 */
export interface AadInput {
  kind: AadRecordKind;
  id: string;
  /** 记录 schema 版本；缺省 `1`。轮换记录形状时 +1，旧密文因 AAD 不匹配而拒绝被误读。 */
  version?: number;
}

/**
 * 序列化成 AAD 字节。
 *
 * 这是**全仓库唯一**构造 AAD 的地方。任何模块都不要自己拼 AAD 字符串——
 * 一旦出现第二种拼法，65 §0 那次统一就白做了。
 */
export function buildAad(input: AadInput): Buffer {
  const version = input.version ?? 1;
  if (input.id.length === 0) {
    throw new Error(`AAD 的 id 不能为空（kind=${input.kind}）`);
  }
  if (input.id.includes(FIELD_SEP)) {
    throw new Error(`AAD 的 id 含分隔符 ${JSON.stringify(FIELD_SEP)}：kind=${input.kind}`);
  }
  return Buffer.from(`${input.kind}${FIELD_SEP}${input.id}${FIELD_SEP}v${version}`, 'utf8');
}

/** 从 AAD 字节反解（调试与测试用；生产路径不需要）。 */
export function parseAad(aad: Buffer): AadInput {
  const parts = aad.toString('utf8').split(FIELD_SEP);
  if (parts.length !== 3) {
    throw new Error(`AAD 不是三段：${JSON.stringify(aad.toString('utf8'))}`);
  }
  const [kind, id, version] = parts as [string, string, string];
  return { kind: kind as AadRecordKind, id, version: Number.parseInt(version.slice(1), 10) };
}
