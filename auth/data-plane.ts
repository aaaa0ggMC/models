/**
 * auth/data-plane.ts —— 数据面鉴权的默认实现（66 §2）。
 *
 * 唯一事实来源：docs/design/66-auth.md §2.1（virtual key 形状）、§2.2（规则）、
 * §6 Open Question 2（与 `AG_ACCESS_TOKEN` 的互斥）。
 *
 * ## 四个模式（66 §6 OQ2）
 *
 * | 模式 | 触发条件 | 凭证形态 |
 * |---|---|---|
 * | `virtual_key` | 显式开了虚拟 key（`virtualKeys: true`）**或**虚拟 key 库里已有 ≥1 把 key | `sk-ag-…` |
 * | `access_token` | 只配了 `AG_ACCESS_TOKEN` | 单个长令牌 |
 * | `permissive` | 显式 opt-in（`permissive: true` / `AG_DATA_PLANE_PERMISSIVE=1`） | 不校验，`key_id = 'local-dev'` |
 * | `deny` | 以上都没配（**默认**） | 一切请求 503 |
 *
 * ## deny-first：什么都没配 = 关门，不是敞开
 *
 * `permissive` 曾经是「两者都没配」时的兜底。2026-11 的公网暴露安全审计把它改成
 * **显式 opt-in**：系统要对外公开，而旧行为下「部署时忘了配凭据」与「谁都能进」
 * 是同一件事——一次部署遗漏就是一次全量数据泄露（模型目录、上游 key 用量、计费）。
 *
 * 现在这条路径的结果是 **503 而不是放行**，也不是 401：**没配凭据是运维问题，
 * 不是调用方问题**，两者必须可区分（同 `/ag/models/sync` 未配 `AG_ADMIN_TOKEN`
 * 时回 503 的立场，见 http/models-endpoint.ts 文件头）。
 *
 * 66 §6 OQ2 的原文是「建议：设了 env 就用极简模式，两者互斥以避免歧义」——
 * 那是**建议**，文档自己标着 Open Question，没有定稿。本实现按任务书给的
 * 兜底规则执行：**显式配置了虚拟 key 库则启用虚拟 key 模式，否则回落极简模式**。
 *
 * 为什么不是「env 赢」：反过来（env 赢）会让「我在 UI 里建了 key 却仍然
 * 要用旧的 access token」——新建的 key 全都失效，而这个失效没有任何提示。
 * 虚拟 key 赢至少符合直觉：「我建了 key，key 就该能用」。
 *
 * **互斥的代价与补偿**：两个都配时 access token 被**静默忽略**，这本身是个
 * 陷阱。补偿有三层：
 *   1. 装配时（composition-root）打一条 `logger.error`，说清哪一项被忽略；
 *   2. `describe()` 把当前模式与「被忽略的配置」透出去，管理面
 *      `GET /admin/api/auth-mode` 原样展示；
 *   3. access token 模式下的请求与虚拟 key 模式下的请求**不会**互相接受
 *      （一把 `sk-ag-…` 在 access_token 模式下必然 401，反之亦然）。
 *
 * ## 日志与 trace 立场
 *
 * 本模块**不接 Logger**：认证失败的错误信息只说 `key_id` 与原因类别，
 * 绝不回显调用方给的串（那把串可能就是密钥）。
 */

import { Buffer } from 'node:buffer';
import type { CanonicalError } from '../ir/index.js';
import { createCanonicalError } from '../ir/index.js';
import type { Clock } from '../ir/clock.js';
import type {
  Authenticator,
  AuthRequest,
  AuthOutcome,
  DataPlaneAuthMode,
} from '../gateway-core/pipeline/stages/s0-ingress.js';
import { extractPresentedKey } from './presentations.js';
import {
  VIRTUAL_KEY_PREFIX,
  looksLikeVirtualKey,
  type ResolvedVirtualKey,
  type VirtualKeyStore,
} from '../storage/virtual-keys.js';

export interface DataPlaneAuthenticatorOptions {
  /** 虚拟 key 存储（注入了才有虚拟 key 模式）。 */
  store?: VirtualKeyStore;
  /** `AG_ACCESS_TOKEN` 的值（极简模式）。**只从 di/config.ts 读 env 后传进来**。 */
  accessToken?: string;
  /** 显式启用虚拟 key 模式（即使一把 key 都还没有）。 */
  virtualKeys?: boolean;
  /**
   * 显式开启「不校验任何凭据」的 permissive 模式。
   *
   * **默认 false = 默认拒绝**：公网暴露的标准下，「忘了配凭据」必须是关门而不是
   * 敞开（见文件头的 deny-first 段）。这个开关只服务「本地裸跑 / demo / 内网自用」
   * 的明确选择——把它写进部署脚本的人为它负责，脚本漏配时数据面是关着的。
   */
  permissive?: boolean;
  clock: Clock;
}

/** 当前模式 + 哪些配置被忽略了（`GET /admin/api/auth-mode` 的形状）。 */
export interface DataPlaneAuthDescription {
  mode: DataPlaneAuthMode;
  /** 虚拟 key 库里现有几把 key（含已撤销）。 */
  virtual_key_count: number;
  /** 是否显式开了虚拟 key 模式。 */
  virtual_keys_enabled: boolean;
  /** 是否配了 `AG_ACCESS_TOKEN`。**不暴露值**。 */
  access_token_configured: boolean;
  /** 因为互斥而被忽略的配置（人类可读的原因）。 */
  ignored: string[];
}

export class DataPlaneAuthenticator implements Authenticator {
  private readonly options: DataPlaneAuthenticatorOptions;

  constructor(options: DataPlaneAuthenticatorOptions) {
    this.options = options;
  }

  /** 当前模式。异步是因为要数库里的 key。 */
  async mode(): Promise<DataPlaneAuthMode> {
    if (this.options.virtualKeys === true) return 'virtual_key';
    const count = await this.keyCount();
    if (count > 0) return 'virtual_key';
    if (this.hasAccessToken()) return 'access_token';
    // 三者都没配：**默认拒绝**。permissive 必须显式 opt-in，不能是兜底——
    // 否则「忘了配凭据」与「谁都能进」是同一件事（文件头 deny-first 段）。
    if (this.options.permissive === true) return 'permissive';
    return 'deny';
  }

  /** 管理面展示用：当前模式 + 被忽略的配置。 */
  async describe(): Promise<DataPlaneAuthDescription> {
    const virtual_key_count = await this.keyCount();
    const access_token_configured = this.hasAccessToken();
    const mode = await this.mode();
    const ignored: string[] = [];
    if (mode === 'virtual_key' && access_token_configured) {
      ignored.push('AG_ACCESS_TOKEN：虚拟 key 模式已启用，单 access token 不参与数据面鉴权');
    }
    if (mode === 'access_token' && virtual_key_count > 0) {
      // 理论不可达（库里有 key 就是 virtual_key 模式），留着是为了
      // 「将来改判定顺序时这里会自动报警」。
      ignored.push('虚拟 key 库非空，但当前处于极简模式');
    }
    return {
      mode,
      virtual_key_count,
      virtual_keys_enabled: this.options.virtualKeys === true,
      access_token_configured,
      ignored,
    };
  }

  async authenticate(request: AuthRequest): Promise<AuthOutcome> {
    const extraction = extractPresentedKey(this.materialOf(request));
    if (!extraction.ok) {
      return {
        ok: false,
        error: authError(
          `同时携带了多把不同的 key（${extraction.sources.join(' / ')}），无法判断该用哪一把`,
        ),
      };
    }

    const mode = await this.mode();

    // ---- 极简模式：单个 access token ----
    if (mode === 'access_token') {
      if (extraction.key === undefined) {
        return { ok: false, error: authError('缺少访问令牌（Authorization: Bearer <token>）') };
      }
      if (!safeEqual(extraction.key.raw, this.options.accessToken!)) {
        return { ok: false, error: authError('访问令牌不正确') };
      }
      return { ok: true, key_id: 'access-token', via: 'access_token' };
    }

    // ---- 虚拟 key 模式 ----
    if (mode === 'virtual_key') {
      if (extraction.key === undefined) {
        return {
          ok: false,
          error: authError('缺少 API key（Authorization: Bearer / x-api-key / ?key= 三选一）'),
        };
      }
      const presented = extraction.key;
      // 形态不对的串直接拒：省掉一次 Argon2id，也让错误信息更有用
      if (!looksLikeVirtualKey(presented.raw)) {
        return { ok: false, error: authError('API key 形态不正确（应以 sk-ag- 开头）') };
      }
      const store = this.options.store;
      if (store === undefined) {
        return { ok: false, error: authError('服务端未装配虚拟 key 存储') };
      }
      const resolved = await store.resolve(presented.raw);
      if (!resolved.ok) {
        const reason =
          resolved.reason === 'revoked'
            ? '该 key 已被撤销'
            : resolved.reason === 'expired'
              ? '该 key 已过期'
              : 'API key 不存在';
        return { ok: false, error: authError(reason) };
      }
      return this.toSuccess(resolved.key);
    }

    // ---- 未配置任何凭据：默认拒绝（deny-first）----
    // 503 而不是 401：没配凭据是运维问题，不是调用方传错了 key（见文件头）。
    // 也**不**因为"看起来像在本地跑"就放行——公网下的本地回环同样暴露。
    if (mode === 'deny') {
      return {
        ok: false,
        error: authError(
          '数据面未配置任何凭据（虚拟 key / AG_ACCESS_TOKEN / 显式放行），已按默认拒绝处理',
          503,
        ),
      };
    }

    // ---- permissive：显式 opt-in 的「不校验」（本地裸跑 / demo）----
    return { ok: true, key_id: 'local-dev', via: 'permissive' };
  }

  private toSuccess(key: ResolvedVirtualKey): AuthOutcome {
    return {
      ok: true,
      key_id: key.key_id,
      ...(key.team_id === undefined ? {} : { team_id: key.team_id }),
      ...(key.user_id === undefined ? {} : { user_id: key.user_id }),
      ...(key.allowed_models === undefined ? {} : { allowed_models: key.allowed_models }),
      ...(key.allowed_providers === undefined ? {} : { allowed_providers: key.allowed_providers }),
      ...(key.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: key.allow_message_persistence }),
      ...(key.allow_streaming === undefined ? {} : { allow_streaming: key.allow_streaming }),
      ...(key.allowed_plugins === undefined ? {} : { allowed_plugins: key.allowed_plugins }),
      ...(key.disabled_plugins === undefined ? {} : { disabled_plugins: key.disabled_plugins }),
      ...(key.allowed_modalities === undefined
        ? {}
        : { allowed_modalities: key.allowed_modalities }),
      via: 'virtual_key',
    };
  }

  /**
   * 把 `auth_material` 摊成 `extractPresentedKey` 认识的形状。
   *
   * 两处都凑一遍：`headers`（测试/直连 runner 时可能没被脱敏）与
   * `auth_material`（http/server.ts 的真实路径）。任一处有值就用，
   * 完全相同不算冲突。
   */
  private materialOf(request: AuthRequest): {
    headers: Record<string, string>;
    query: Record<string, string>;
  } {
    const material = request.auth_material;
    const headers: Record<string, string> = { ...request.headers };
    const query: Record<string, string> = { ...request.query };
    if (material !== undefined) {
      if (material.authorization !== undefined && headers['authorization'] === undefined) {
        headers['authorization'] = material.authorization;
      }
      if (material.api_key !== undefined && headers['x-api-key'] === undefined) {
        headers['x-api-key'] = material.api_key;
      }
      if (material.query_key !== undefined && query['key'] === undefined) {
        query['key'] = material.query_key;
      }
    }
    return { headers, query };
  }

  private async keyCount(): Promise<number> {
    if (this.options.store === undefined) return 0;
    return this.options.store.count();
  }

  private hasAccessToken(): boolean {
    const t = this.options.accessToken;
    return t !== undefined && t.length > 0;
  }
}

/** 鉴权失败。消息里**不含**调用方给的任何串。 */
function authError(message: string, httpStatus = 401): CanonicalError {
  return createCanonicalError('auth_failed', message, 'req_auth', { http_status: httpStatus });
}

/** 常量时间比较。长度不同直接 false（同 admin/auth.ts 的立场）。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  let diff = 0;
  for (let i = 0; i < ba.length; i += 1) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

export { VIRTUAL_KEY_PREFIX };
