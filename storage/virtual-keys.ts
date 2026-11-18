/**
 * storage/virtual-keys.ts —— 数据面 virtual key 的记录读写（**只存哈希，永不明文**）。
 *
 * 唯一事实来源：docs/design/66-auth.md §2.1（`VirtualKey` 形状）、§2.2（规则）。
 *
 * ## 三条硬规则（66 §2.2 原文，逐条落地）
 *
 * 1. **明文只在创建响应里返回一次**：`create()` 是唯一产出明文的函数，它的返回值
 *    直接进 HTTP 响应体；此后任何路径（`get` / `list` / `resolve`）都拿不到明文。
 * 2. **永不明文入库**：库里只有 `key_hash`（Argon2id 摘要 + 盐 + 参数）与 `prefix`
 *    （前 8 位，非敏感，供人认出是哪把 key）。`VirtualKeyRecord` **没有**承载明文的
 *    字段——这不是疏忽，是让「不小心把明文存下去」在类型上不可能。
 * 3. **不进日志、不进 trace、不进错误信息**：本模块不接 `Logger`；错误信息只说
 *    `key_id` 与原因，绝不回显调用方给的串。
 *
 * ## 为什么是 Argon2id 而不是 SHA-256
 *
 * 66 §2.2 明确要求 Argon2id，本实现照做。代价是每次校验 ~66–100 ms
 * （65 §2 的本机实测），**不能放在请求路径上每次都跑**。处置见
 * `DefaultVirtualKeyStore.resolve` 的校验缓存：缓存键是明文的 SHA-256
 * （只在内存，绝不落盘），任何写操作（建 / 撤 / 删）整体失效。
 *
 * 这也意味着「撤销后立即失效」不需要等缓存过期：撤销会清缓存，下一个请求
 * 重新走 Argon2id 并发现记录已撤销。
 *
 * ⚠️ **待文档更新**（见报告的「待文档更新」清单）：`sk-ag-…` 是 192 bit 随机串，
 * 属高熵凭证，按行业惯例（LiteLLM 等）用 SHA-256 建查找索引即可，不需要
 * 慢哈希。若将来要把请求路径的认证成本降到零，应给 66 §2.2 补一条
 * 「额外存一个 SHA-256 查找列」的许可。本轮不改文档（docs/ 走 PR）。
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { AadRecordKind } from './crypto/aad.js';
import type { EncryptedRecordStore } from './record-store.js';
import type { Clock } from '../ir/clock.js';
import { DEFAULT_PARAMS, argon2idRaw, type Argon2IdParams } from './crypto/kdf.js';

/** virtual key 在加密存储里的记录 kind（进 AAD，防跨类挪动）。 */
export const VIRTUAL_KEY_KIND: AadRecordKind = 'virtual_key';

/** 明文 key 的字面前缀。用来在三种呈现形态里快速认出「这是一把我们的 key」。 */
export const VIRTUAL_KEY_PREFIX = 'sk-ag-';

/** 明文的随机部分长度（base64url 字符数）。24 字节 = 192 bit 熵。 */
const PLAINTEXT_RANDOM_CHARS = 32;

/** 列表 / 元数据里允许展示的前缀长度（66 §2.2：「只能看 key_id 与前 8 位」）。 */
export const VIRTUAL_KEY_HEAD_CHARS = 8;

/** 校验缓存上限。超过就整体清空（私人自用的量级下永远碰不到）。 */
const VERIFY_CACHE_MAX = 512;

/** Argon2id 摘要记录（结构化 + hex，理由同 storage/crypto/kdf.ts 的「为什么不用 PHC」）。 */
export interface VirtualKeyHash {
  algo: 'argon2id';
  /** Argon2 版本号（v1.3 = 19）。 */
  version: number;
  params: Argon2IdParams;
  salt_hex: string;
  hash_hex: string;
}

/** 库里的 virtual key 记录。**没有任何字段能承载明文**。 */
export interface VirtualKeyRecord {
  /** 入库的稳定 id（不含明文）。 */
  key_id: string;
  name: string;
  note?: string;
  status: 'active' | 'revoked';
  created_at: number;
  updated_at: number;
  revoked_at?: number;
  /** 过期时间（ms epoch）；到期即失效，不需要显式撤销。 */
  expires_at?: number;
  /** 允许的模型 / 别名（空或未给 = 全部）。支持 `*` 尾缀 glob。 */
  models?: string[];
  /** 允许的 provider（空或未给 = 全部）。S2 按解析出的 provider 校验。 */
  providers?: string[];
  /** 是否允许写 Tier-2 消息持久化（默认 false，66 §2.1）。 */
  allow_message_persistence?: boolean;
  /** 是否允许流式响应（默认 true）。 */
  allow_streaming?: boolean;
  /** 允许的插件白名单（空/未给 = 全部）。 */
  allowed_plugins?: string[];
  /** 明确禁用的插件黑名单。 */
  disabled_plugins?: string[];
  /** 允许的模态白名单（空/未给 = 全部）。 */
  allowed_modalities?: string[];
  /** 速率限制（v1 只透传，执行点在 P0-5）。 */
  rate_limit?: { rpm?: number; tpm?: number };
  /** 预算上限（微美元）；执行点在 P0-3。 */
  budget_micros?: number;
  /** 归属（用于统计分组）。 */
  team_id?: string;
  user_id?: string;
  /** 明文前 8 位（非敏感）。 */
  prefix: string;
  /** Argon2id 摘要 + 盐 + 参数。 */
  key_hash: VirtualKeyHash;
  /** 控制面操作者（审计用；与 `user_id` 是两回事，前者是谁建的 key）。 */
  created_by?: string;
}

/** 创建入参（不含明文——明文由本模块生成）。 */
export interface VirtualKeyCreateInput {
  name: string;
  note?: string;
  expires_at?: number;
  models?: string[];
  providers?: string[];
  allow_message_persistence?: boolean;
  allow_streaming?: boolean;
  allowed_plugins?: string[];
  disabled_plugins?: string[];
  allowed_modalities?: string[];
  rate_limit?: { rpm?: number; tpm?: number };
  budget_micros?: number;
  team_id?: string;
  user_id?: string;
  /** 控制面操作者（审计用）。 */
  created_by?: string;
  /** 测试可注入的随机源（默认 node:crypto 的 randomBytes）。 */
  random?: (bytes: number) => Buffer;
  /** Argon2id 参数覆盖（测试提速用；生产用缺省档）。 */
  argon2?: Argon2IdParams;
}

/** 创建结果：**唯一**携带明文的地方。 */
export interface VirtualKeyCreated {
  key_id: string;
  /** 完整明文。只在这一次返回值里出现，调用方负责「展示一次即丢弃」。 */
  plaintext: string;
  record: VirtualKeyRecord;
}

/** 解析结果：校验通过且当前可用。 */
export interface ResolvedVirtualKey {
  key_id: string;
  record: VirtualKeyRecord;
  team_id?: string;
  user_id?: string;
  allowed_models?: string[];
  allowed_providers?: string[];
  allow_message_persistence?: boolean;
  allow_streaming?: boolean;
  allowed_plugins?: string[];
  disabled_plugins?: string[];
  allowed_modalities?: string[];
}

export interface VirtualKeyUpdateInput {
  name?: string;
  note?: string;
  expires_at?: number | null;
  models?: string[];
  providers?: string[];
  allow_message_persistence?: boolean;
  allow_streaming?: boolean;
  allowed_plugins?: string[];
  disabled_plugins?: string[];
  allowed_modalities?: string[];
  rate_limit?: { rpm?: number; tpm?: number } | null;
  budget_micros?: number | null;
  team_id?: string | null;
  user_id?: string | null;
}

/** 为什么一把明文 key 没通过校验。 */
export type VirtualKeyRejection = 'not_found' | 'revoked' | 'expired';

export interface VirtualKeyStore {
  /** 建一把新 key。**只有这里产出明文**。 */
  create(input: VirtualKeyCreateInput): Promise<VirtualKeyCreated>;
  get(keyId: string): Promise<VirtualKeyRecord | undefined>;
  /** 全部记录（含已撤销）；按创建时间升序。 */
  list(): Promise<VirtualKeyRecord[]>;
  /** 记录条数（含已撤销）。互斥判定用「有没有配过 key」。 */
  count(): Promise<number>;
  /** 撤销（保留记录以便审计）。已撤销 / 不存在返回 undefined。 */
  revoke(keyId: string, now: number): Promise<VirtualKeyRecord | undefined>;
  /** 更新虚拟 key 的权限与配额。 */
  update?(keyId: string, patch: VirtualKeyUpdateInput, now: number): Promise<VirtualKeyRecord | undefined>;
  /** 彻底删除（连审计痕迹一起消失）。 */
  delete(keyId: string): Promise<boolean>;
  /** 用明文换身份。不命中返回 `{ ok: false, reason }`——**绝不回显明文**。 */
  resolve(
    plaintext: string,
  ): Promise<{ ok: true; key: ResolvedVirtualKey } | { ok: false; reason: VirtualKeyRejection }>;
  /** 丢弃内存缓存（外部改了存储时调）。 */
  refresh(): void;
}

/** 生成一把新明文：`sk-ag-` + 32 个 base64url 字符（192 bit 熵）。 */
export function mintVirtualKeyPlaintext(random: (bytes: number) => Buffer = randomBytes): string {
  return `${VIRTUAL_KEY_PREFIX}${random(24).toString('base64url').slice(0, PLAINTEXT_RANDOM_CHARS)}`;
}

/**
 * 列表用的掩码。
 *
 * 只露前 8 位 + 省略号：**不露长度**（长度是可用于爆破的信息，同
 * record-store.ts 的 `maskSecret` 立场），也不造一个看起来像完整 key 的串。
 */
export function maskVirtualKey(prefix: string): string {
  const head = prefix.slice(0, VIRTUAL_KEY_HEAD_CHARS);
  return head.length === 0 ? 'sk-ag-…' : `${head}…`;
}

/** 是否看起来像一把我们的 virtual key（形态检查，不是校验）。 */
export function looksLikeVirtualKey(raw: string): boolean {
  return raw.startsWith(VIRTUAL_KEY_PREFIX) && raw.length > VIRTUAL_KEY_PREFIX.length + 8;
}

/**
 * 默认实现：记录进加密存储，校验走 Argon2id + 内存缓存。
 *
 * 缓存分两份，都由写操作整体失效：
 *   - `records`：避免每个请求都全量解密一遍记录表；
 *   - `verified`：`sha256(明文) → key_id`，避免每个请求都跑一次 Argon2id。
 */
export class DefaultVirtualKeyStore implements VirtualKeyStore {
  private readonly params: Argon2IdParams;
  private records: VirtualKeyRecord[] | undefined;
  private readonly verified = new Map<string, string>();

  constructor(
    private readonly store: EncryptedRecordStore,
    private readonly clock: Clock,
    options: { argon2?: Argon2IdParams } = {},
  ) {
    this.params = options.argon2 ?? DEFAULT_PARAMS;
  }

  async create(input: VirtualKeyCreateInput): Promise<VirtualKeyCreated> {
    const random = input.random ?? randomBytes;
    const now = this.clock.now();
    const plaintext = mintVirtualKeyPlaintext(random);
    const salt = randomBytes(16);
    const hash = argon2idRaw(plaintext, salt, input.argon2 ?? this.params);
    const keyId = `vk_${now.toString(36)}_${randomBytes(6).toString('hex')}`;
    const record: VirtualKeyRecord = {
      key_id: keyId,
      name: input.name,
      status: 'active',
      created_at: now,
      updated_at: now,
      prefix: plaintext.slice(0, VIRTUAL_KEY_HEAD_CHARS),
      key_hash: {
        algo: 'argon2id',
        version: 19,
        params: { ...(input.argon2 ?? this.params) },
        salt_hex: salt.toString('hex'),
        hash_hex: hash.toString('hex'),
      },
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
      ...(input.models === undefined ? {} : { models: [...input.models] }),
      ...(input.providers === undefined ? {} : { providers: [...input.providers] }),
      ...(input.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: input.allow_message_persistence }),
      ...(input.allow_streaming === undefined ? {} : { allow_streaming: input.allow_streaming }),
      ...(input.allowed_plugins === undefined ? {} : { allowed_plugins: [...input.allowed_plugins] }),
      ...(input.disabled_plugins === undefined
        ? {}
        : { disabled_plugins: [...input.disabled_plugins] }),
      ...(input.allowed_modalities === undefined
        ? {}
        : { allowed_modalities: [...input.allowed_modalities] }),
      ...(input.rate_limit === undefined ? {} : { rate_limit: { ...input.rate_limit } }),
      ...(input.budget_micros === undefined ? {} : { budget_micros: input.budget_micros }),
      ...(input.team_id === undefined ? {} : { team_id: input.team_id }),
      ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
      ...(input.created_by === undefined ? {} : { created_by: input.created_by }),
    };
    await this.store.put(VIRTUAL_KEY_KIND, keyId, record, now);
    this.invalidate();
    return { key_id: keyId, plaintext, record };
  }

  async get(keyId: string): Promise<VirtualKeyRecord | undefined> {
    return (await this.loadAll()).find((r) => r.key_id === keyId);
  }

  async list(): Promise<VirtualKeyRecord[]> {
    return [...(await this.loadAll())].sort((a, b) => a.created_at - b.created_at);
  }

  async count(): Promise<number> {
    return (await this.loadAll()).length;
  }

  async revoke(keyId: string, now: number): Promise<VirtualKeyRecord | undefined> {
    const rec = await this.get(keyId);
    if (rec === undefined || rec.status === 'revoked') return undefined;
    const next: VirtualKeyRecord = {
      ...rec,
      status: 'revoked',
      revoked_at: now,
      updated_at: now,
    };
    await this.store.put(VIRTUAL_KEY_KIND, keyId, next, now);
    this.invalidate();
    return next;
  }

  async update(
    keyId: string,
    patch: VirtualKeyUpdateInput,
    now: number,
  ): Promise<VirtualKeyRecord | undefined> {
    const rec = await this.get(keyId);
    if (rec === undefined) return undefined;
    const next: VirtualKeyRecord = {
      ...rec,
      updated_at: now,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    };
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.expires_at === null) delete next.expires_at;
    else if (patch.expires_at !== undefined) next.expires_at = patch.expires_at;
    if (patch.models !== undefined) {
      if (patch.models.length === 0) delete next.models;
      else next.models = [...patch.models];
    }
    if (patch.providers !== undefined) {
      if (patch.providers.length === 0) delete next.providers;
      else next.providers = [...patch.providers];
    }
    if (patch.allow_message_persistence !== undefined) {
      next.allow_message_persistence = patch.allow_message_persistence;
    }
    if (patch.allow_streaming !== undefined) {
      next.allow_streaming = patch.allow_streaming;
    }
    if (patch.allowed_plugins !== undefined) {
      if (patch.allowed_plugins.length === 0) delete next.allowed_plugins;
      else next.allowed_plugins = [...patch.allowed_plugins];
    }
    if (patch.disabled_plugins !== undefined) {
      if (patch.disabled_plugins.length === 0) delete next.disabled_plugins;
      else next.disabled_plugins = [...patch.disabled_plugins];
    }
    if (patch.allowed_modalities !== undefined) {
      if (patch.allowed_modalities.length === 0) delete next.allowed_modalities;
      else next.allowed_modalities = [...patch.allowed_modalities];
    }
    if (patch.rate_limit === null) delete next.rate_limit;
    else if (patch.rate_limit !== undefined) next.rate_limit = { ...patch.rate_limit };
    if (patch.budget_micros === null) delete next.budget_micros;
    else if (patch.budget_micros !== undefined) next.budget_micros = patch.budget_micros;
    if (patch.team_id === null) delete next.team_id;
    else if (patch.team_id !== undefined) next.team_id = patch.team_id;
    if (patch.user_id === null) delete next.user_id;
    else if (patch.user_id !== undefined) next.user_id = patch.user_id;

    await this.store.put(VIRTUAL_KEY_KIND, keyId, next, now);
    this.invalidate();
    return next;
  }

  async delete(keyId: string): Promise<boolean> {
    const deleted = await this.store.delete(VIRTUAL_KEY_KIND, keyId);
    if (deleted) this.invalidate();
    return deleted;
  }

  async resolve(
    plaintext: string,
  ): Promise<{ ok: true; key: ResolvedVirtualKey } | { ok: false; reason: VirtualKeyRejection }> {
    if (plaintext.length === 0) return { ok: false, reason: 'not_found' };

    const cacheKey = createHash('sha256').update(plaintext, 'utf8').digest('hex');
    const cached = this.verified.get(cacheKey);
    if (cached !== undefined) {
      const rec = (await this.loadAll()).find((r) => r.key_id === cached);
      if (rec !== undefined) return this.judge(rec);
      this.verified.delete(cacheKey);
    }

    for (const rec of await this.loadAll()) {
      if (!this.verifyHash(plaintext, rec.key_hash)) continue;
      this.remember(cacheKey, rec.key_id);
      return this.judge(rec);
    }
    return { ok: false, reason: 'not_found' };
  }

  refresh(): void {
    this.invalidate();
  }

  // -------------------------------------------------------------------------

  /** 记录过了，再看它当前是否可用（撤销 / 过期在这一步）。 */
  private judge(
    rec: VirtualKeyRecord,
  ): { ok: true; key: ResolvedVirtualKey } | { ok: false; reason: VirtualKeyRejection } {
    if (rec.status === 'revoked') return { ok: false, reason: 'revoked' };
    if (rec.expires_at !== undefined && rec.expires_at <= this.clock.now()) {
      return { ok: false, reason: 'expired' };
    }
    return {
      ok: true,
      key: {
        key_id: rec.key_id,
        record: rec,
        ...(rec.team_id === undefined ? {} : { team_id: rec.team_id }),
        ...(rec.user_id === undefined ? {} : { user_id: rec.user_id }),
        ...(rec.models === undefined ? {} : { allowed_models: rec.models }),
        ...(rec.providers === undefined ? {} : { allowed_providers: rec.providers }),
        ...(rec.allow_message_persistence === undefined
          ? {}
          : { allow_message_persistence: rec.allow_message_persistence }),
        ...(rec.allow_streaming === undefined ? {} : { allow_streaming: rec.allow_streaming }),
        ...(rec.allowed_plugins === undefined ? {} : { allowed_plugins: rec.allowed_plugins }),
        ...(rec.disabled_plugins === undefined ? {} : { disabled_plugins: rec.disabled_plugins }),
        ...(rec.allowed_modalities === undefined
          ? {}
          : { allowed_modalities: rec.allowed_modalities }),
      },
    };
  }

  /** Argon2id 常量时间比对。参数或盐与记录不一致时照样重算（不猜原因）。 */
  private verifyHash(plaintext: string, hash: VirtualKeyHash): boolean {
    if (hash.algo !== 'argon2id') return false;
    let recomputed: Buffer;
    try {
      recomputed = argon2idRaw(plaintext, Buffer.from(hash.salt_hex, 'hex'), hash.params);
    } catch {
      return false;
    }
    const expected = Buffer.from(hash.hash_hex, 'hex');
    if (recomputed.length !== expected.length) return false;
    return timingSafeEqual(recomputed, expected);
  }

  private remember(cacheKey: string, keyId: string): void {
    if (this.verified.size >= VERIFY_CACHE_MAX) this.verified.clear();
    this.verified.set(cacheKey, keyId);
  }

  private async loadAll(): Promise<VirtualKeyRecord[]> {
    if (this.records === undefined) {
      this.records = (await this.store.listDecrypted<VirtualKeyRecord>(VIRTUAL_KEY_KIND)).map(
        (r) => r.value,
      );
    }
    return this.records;
  }

  private invalidate(): void {
    this.records = undefined;
    this.verified.clear();
  }
}
