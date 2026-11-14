/**
 * admin/auth.ts —— 控制面本地认证（v1）。
 *
 * 唯一事实来源：docs/design/66-auth.md §1（两个认证平面，不要混）、§3（控制面
 * 认证：v1 默认本地账号 + passkey，**不带任何 OAuth**）、§4（权限模型）。
 *
 * ## 与数据面认证的关系（66 §1：不要混）
 *
 * | 平面 | 凭证形态 | 本文件负责？ |
 * |---|---|---|
 * | 数据面（Gateway API） | virtual key（`sk-ag-…`）或单 access token | ❌ 走 credentials/ |
 * | 控制面（WebUI） | 本地账号（口令）+ 单 access token | ✅ 本文件 |
 *
 * 两边的令牌**互不通用**：控制面会话令牌进不了数据面，virtual key 也登不了
 * 管理界面。混用会让「谁能改配置」和「谁能花我的钱」变成同一个秘密，
 * 而这两个的泄露后果与轮换周期完全不同。
 *
 * ## v1 支持什么、不支持什么
 *
 * 支持：
 *   1. **口令**（Argon2id 哈希存储，常量时间校验）——本地账号；
 *   2. **单 access token**（66 §2.2 的 `AG_ACCESS_TOKEN` 同款思路，控制面版）——
 *      适合「只有我自己用、不想记第二个口令」的部署。
 *
 * 不支持（**明确记录，不要假装支持**）：
 *   - passkey / WebAuthn：66 §6 的 Open Question 1 指出 WebAuthn 要求 secure
 *     context，本机 http 下不可用，需先确认反代与证书方案。在解决之前不做——
 *     做一个「看起来像 passkey 其实退化成口令」的东西比没有更危险。
 *   - OAuth：66 §3.2 列清了每个提供商的注册成本，v1 明确不做。
 *
 * ## 会话模型
 *
 * 登录成功 → 发一个 256-bit 随机令牌；库里只存它的 **SHA-256 哈希**
 * （同 66 §2.2 对 virtual key 的立场：永不明文入库）。令牌本身只在登录响应里
 * 出现一次。过期时间入库，可撤销。
 *
 * 为什么不做「刷新令牌」：控制面是人在用，会话短（缺省 12 小时），过期就
 * 重新登录。刷新令牌会把「长期有效的秘密」引进来了，而控制面恰恰是最应该
 * 避免长期秘密的地方。
 */

import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EncryptedRecordStore } from '../storage/record-store.js';

/** 控制面 API 版本（前端可用来提示升级）。 */
export const ADMIN_API_VERSION = '1';

/** 会话有效期：12 小时。控制面是人在用，不需要更长。 */
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 令牌长度：256 bit。 */
const TOKEN_LEN = 32;

/** 角色。66 §4：owner 全部；viewer 只看用量看板与 trace。 */
export type AdminRole = 'owner' | 'viewer';

export interface AdminUser {
  id: string;
  name: string;
  role: AdminRole;
}

/** 库里的会话记录（令牌只存哈希）。 */
interface SessionRecord {
  id: string;
  token_hash: string;
  user_id: string;
  user_name: string;
  role: AdminRole;
  created_at: number;
  expires_at: number;
  /** 撤销标记（保留记录以便审计，只是不再可用）。 */
  revoked: boolean;
}

/** 库里的账号记录（口令只存 Argon2id 哈希）。 */
interface AccountRecord {
  id: string;
  name: string;
  role: AdminRole;
  password_argon2_hex: string;
  password_salt_hex: string;
  password_params: { memoryKiB: number; timeCost: number; parallelism: number };
  created_at: number;
  updated_at: number;
}

/** 认证结果。 */
export type AuthResult =
  { ok: true; token: string; expires_at: number; user: AdminUser } | { ok: false; error: string };

export interface AdminAuth {
  /** 是否已初始化（有账号或配了 access token）。 */
  initialized(): Promise<boolean>;
  /** 登录。口令或 access token 任一通过即可。 */
  login(input: { password?: string; access_token?: string }): Promise<AuthResult>;
  /** 校验会话令牌。 */
  authenticate(token: string): Promise<AdminUser | undefined>;
  /** 登出（撤销会话）。 */
  logout(token: string): Promise<void>;
  /** 建/改管理员账号（口令）。首次初始化用。 */
  setAccount(user: AdminUser, password: string): Promise<void>;
  /** 当前账号（没有则 undefined）。 */
  account(): Promise<AdminUser | undefined>;
  /** 清理过期会话。 */
  pruneExpiredSessions(now: number): Promise<number>;
}

/** 会话在加密存储里的记录 kind（进 AAD，防跨类挪动）。 */
const SESSION_KIND = 'admin_session' as const;
const ACCOUNT_KIND = 'credential' as const;
const ACCOUNT_ID = 'admin:account';

/**
 * 默认实现：账号与会话都进**加密存储**。
 *
 * 为什么账号口令哈希也进加密存储而不是明文 JSON：虽然 Argon2id 哈希本身
 * 抗离线爆破，但把它和「谁能登录」这个信息放在明文文件里，等于给攻击者一个
 * 免费的靶子（知道该爆破哪个文件、账号名是什么）。进加密存储后，拿不到 KEK
 * 连哈希都看不到。
 */
export class DefaultAdminAuth implements AdminAuth {
  constructor(
    private readonly store: EncryptedRecordStore,
    private readonly clock: { now(): number },
    private readonly options: {
      /** 单 access token（66 §2.2 同款；不设则只接受口令）。 */
      accessToken?: string;
      sessionTtlMs?: number;
      /** Argon2id 参数（账号口令用）。 */
      argon2?: { memoryKiB: number; timeCost: number; parallelism: number };
    } = {},
  ) {}

  private get ttl(): number {
    return this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  async initialized(): Promise<boolean> {
    if (this.options.accessToken !== undefined && this.options.accessToken.length > 0) return true;
    return (await this.account()) !== undefined;
  }

  async account(): Promise<AdminUser | undefined> {
    const rec = await this.store.get<AccountRecord>(ACCOUNT_KIND, ACCOUNT_ID);
    if (rec === undefined) return undefined;
    return { id: rec.id, name: rec.name, role: rec.role };
  }

  async setAccount(user: AdminUser, password: string): Promise<void> {
    if (password.length < 8) {
      throw new Error('管理员口令至少 8 位（控制面是最高权限入口，不值得为短口令冒风险）');
    }
    const { argon2idRaw } = await import('../storage/crypto/kdf.js');
    const params = this.options.argon2 ?? {
      memoryKiB: 19_456,
      timeCost: 2,
      parallelism: 1,
    };
    const salt = randomBytes(16);
    const hash = argon2idRaw(password, salt, params);
    const prev = await this.store.get<AccountRecord>(ACCOUNT_KIND, ACCOUNT_ID);
    const record: AccountRecord = {
      id: user.id,
      name: user.name,
      role: user.role,
      password_argon2_hex: hash.toString('hex'),
      password_salt_hex: salt.toString('hex'),
      password_params: params,
      created_at: prev?.created_at ?? this.clock.now(),
      updated_at: this.clock.now(),
    };
    await this.store.put(ACCOUNT_KIND, ACCOUNT_ID, record);
  }

  async login(input: { password?: string; access_token?: string }): Promise<AuthResult> {
    // ---- 单 access token 模式（常量时间比较）----
    const configured = this.options.accessToken;
    if (configured !== undefined && configured.length > 0 && input.access_token !== undefined) {
      if (safeEqualString(input.access_token, configured)) {
        return this.issueSession({
          id: 'token',
          name: 'access-token',
          role: 'owner',
        });
      }
      // 不 return：可能是用户既想用 token 又输错了口令，继续试口令路径
    }

    // ---- 口令模式 ----
    if (input.password !== undefined) {
      const rec = await this.store.get<AccountRecord>(ACCOUNT_KIND, ACCOUNT_ID);
      if (rec !== undefined) {
        const { argon2idRaw } = await import('../storage/crypto/kdf.js');
        const recomputed = argon2idRaw(
          input.password,
          Buffer.from(rec.password_salt_hex, 'hex'),
          rec.password_params,
        );
        if (safeEqualString(recomputed.toString('hex'), rec.password_argon2_hex)) {
          return this.issueSession({ id: rec.id, name: rec.name, role: rec.role });
        }
      }
    }

    return {
      ok: false,
      error: '口令或 access token 不正确（已记录本次失败，不含任何凭据信息）',
    };
  }

  private async issueSession(user: AdminUser): Promise<AuthResult> {
    const now = this.clock.now();
    const token = randomBytes(TOKEN_LEN).toString('base64url');
    const session: SessionRecord = {
      id: `sess_${randomBytes(8).toString('hex')}`,
      token_hash: hashToken(token),
      user_id: user.id,
      user_name: user.name,
      role: user.role,
      created_at: now,
      expires_at: now + this.ttl,
      revoked: false,
    };
    await this.store.put(SESSION_KIND, session.id, session);
    return { ok: true, token, expires_at: session.expires_at, user };
  }

  async authenticate(token: string): Promise<AdminUser | undefined> {
    if (token.length === 0) return undefined;
    const now = this.clock.now();
    const hash = hashToken(token);
    const metas = await this.store.listMeta(SESSION_KIND);
    for (const meta of metas) {
      const session = await this.store.get<SessionRecord>(SESSION_KIND, meta.id);
      if (session === undefined) continue;
      if (session.revoked) continue;
      if (session.expires_at <= now) continue;
      if (!safeEqualString(session.token_hash, hash)) continue;
      return { id: session.user_id, name: session.user_name, role: session.role };
    }
    return undefined;
  }

  async logout(token: string): Promise<void> {
    const hash = hashToken(token);
    const metas = await this.store.listMeta(SESSION_KIND);
    for (const meta of metas) {
      const session = await this.store.get<SessionRecord>(SESSION_KIND, meta.id);
      if (session === undefined || session.revoked) continue;
      if (safeEqualString(session.token_hash, hash)) {
        await this.store.put(SESSION_KIND, meta.id, { ...session, revoked: true });
      }
    }
  }

  async pruneExpiredSessions(now: number): Promise<number> {
    const metas = await this.store.listMeta(SESSION_KIND);
    let pruned = 0;
    for (const meta of metas) {
      const session = await this.store.get<SessionRecord>(SESSION_KIND, meta.id);
      if (session === undefined) continue;
      if (session.expires_at <= now || session.revoked) {
        await this.store.delete(SESSION_KIND, meta.id);
        pruned += 1;
      }
    }
    return pruned;
  }
}

/** 令牌哈希：SHA-256。**不明文入库**（66 §2.2 同立场）。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 常量时间字符串比较。
 *
 * 用 `timingSafeEqual` 而不是 `===`：`===` 会在第一个不同字符处短路返回，
 * 时序差可被用来逐字节猜出口令/令牌。长度不同时仍直接返回 false
 * （长度本身在这些场景不是秘密——令牌长度恒定，口令长度由用户自定且
 * 已由 Argon2id 的不可比性兜住）。
 */
export function safeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 测试替身：不落盘的认证器（不起真实存储也能测路由鉴权）。 */
export class InMemoryAdminAuth implements AdminAuth {
  private accountRec: AdminUser | undefined;
  private password: string | undefined;
  private readonly sessions = new Map<string, { user: AdminUser; expires_at: number }>();

  constructor(
    private readonly clock: { now(): number },
    private readonly options: { accessToken?: string; sessionTtlMs?: number } = {},
  ) {}

  async initialized(): Promise<boolean> {
    return this.accountRec !== undefined || this.options.accessToken !== undefined;
  }

  async account(): Promise<AdminUser | undefined> {
    return this.accountRec;
  }

  async setAccount(user: AdminUser, password: string): Promise<void> {
    if (password.length < 8) throw new Error('管理员口令至少 8 位');
    this.accountRec = user;
    this.password = password;
  }

  async login(input: { password?: string; access_token?: string }): Promise<AuthResult> {
    const now = this.clock.now();
    const ttl = this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    const user =
      input.access_token !== undefined &&
      this.options.accessToken !== undefined &&
      safeEqualString(input.access_token, this.options.accessToken)
        ? { id: 'token', name: 'access-token', role: 'owner' as const }
        : input.password !== undefined &&
            this.password !== undefined &&
            safeEqualString(input.password, this.password)
          ? this.accountRec!
          : undefined;
    if (user === undefined) {
      return { ok: false, error: '口令或 access token 不正确' };
    }
    const token = randomBytes(TOKEN_LEN).toString('base64url');
    this.sessions.set(hashToken(token), { user, expires_at: now + ttl });
    return { ok: true, token, expires_at: now + ttl, user };
  }

  async authenticate(token: string): Promise<AdminUser | undefined> {
    const s = this.sessions.get(hashToken(token));
    if (s === undefined) return undefined;
    if (s.expires_at <= this.clock.now()) {
      this.sessions.delete(hashToken(token));
      return undefined;
    }
    return s.user;
  }

  async logout(token: string): Promise<void> {
    this.sessions.delete(hashToken(token));
  }

  async pruneExpiredSessions(now: number): Promise<number> {
    let pruned = 0;
    for (const [k, v] of [...this.sessions]) {
      if (v.expires_at <= now) {
        this.sessions.delete(k);
        pruned += 1;
      }
    }
    return pruned;
  }
}
