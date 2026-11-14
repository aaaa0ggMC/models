/**
 * credentials/resolver.ts —— 上游凭据解析器（接口 + Phase 1 的 env 实现）。
 *
 * 唯一事实来源：docs/design/45-credentials.md（§2 凭据类型、§3 access path、§5 存储位置）。
 *
 * Phase 1 边界（70-roadmap §2 末尾，严格执行）：
 *   - 只做 `api_key` / `local` / `cloud_iam` 三种类型；
 *   - 存储位置只允许 `env` 与 `keyring`（OS 负责加密），**禁止 `vault`**——加密库依赖
 *     Phase 4 的密钥体系；
 *   - 不实现真实 OAuth 流程（device-code / browser），只建接口与 mock；
 *   - `session_cookie` 是明确非目标（00 §2.2 第 2 条），仅 schema 留位。
 *
 * 硬约束：**绝不把明文 key 写进日志/UsageRecord/trace**；headersFor 的返回值只进
 * transport，任何情况下不得被序列化落盘。
 */

import type { FormatId, RequestContext, UpstreamCredential } from '../ir/index.js';
import type { AccessPath } from '../ir/index.js';

export interface ResolvedHeaders {
  headers: Record<string, string>;
  /** 本次实际使用的凭据 id（进 trace 用于对账，不含明文）。 */
  credential_id?: string;
}

export interface CredentialResolver {
  /** 该 access path 的默认 wire 格式。 */
  formatFor(accessPath: string): FormatId;
  /** 该 access path 的上游 base URL。 */
  baseUrlFor(accessPath: string): string;
  /** 该 access path 的元数据。 */
  accessPath(accessPath: string): AccessPath | undefined;
  /** 列出一个 access path 上可用（enabled + 健康）的凭据。 */
  credentialsFor(accessPath: string): UpstreamCredential[];
  /** 为一次上游调用签发请求头（含鉴权头）。 */
  headersFor(accessPath: string, ctx: RequestContext): Promise<ResolvedHeaders>;
}

/** 默认 access path 注册表（Phase 1：openai / anthropic 两条，加一个 local mock）。 */
export const DEFAULT_ACCESS_PATHS: AccessPath[] = [
  {
    id: 'openai',
    label: 'OpenAI (API key)',
    format: 'openai.chat',
    usage_source: 'provider',
    model_namespaces: ['openai'],
    requires_credential: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic (API key)',
    format: 'anthropic.messages',
    usage_source: 'provider',
    model_namespaces: ['anthropic'],
    requires_credential: true,
  },
  {
    id: 'mock',
    label: 'Mock upstream (本地测试)',
    format: 'openai.chat',
    usage_source: 'provider',
    model_namespaces: ['mock'],
    requires_credential: false,
  },
];

/** 上游 key 的**环境变量名**（不是值）。仓库里只出现变量名（AGENTS.md 约束）。 */
const KEY_ENV_BY_ACCESS_PATH: Record<string, string> = {
  openai: 'AG_OPENAI_API_KEY',
  anthropic: 'AG_ANTHROPIC_API_KEY',
};

const BASE_URL_BY_ACCESS_PATH: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  mock: 'http://127.0.0.1:1',
};

/**
 * env/keyring 两档的凭据解析器。
 *
 * `env` 档：key 只存在于进程环境，仓库与配置对象里只有变量名；
 * `keyring` 档：由 OS keyring 负责加密，本实现通过注入的 `KeyringReader` 读，
 *   Phase 1 不引原生 keyring 依赖（@napi-rs/keyring 是 Phase 4 的事），
 *   接口先立起来，默认没有 reader 时降级为 env 档并 warning。
 */
export interface KeyringReader {
  read(ref: string): Promise<string | undefined>;
}

export class EnvCredentialResolver implements CredentialResolver {
  private readonly paths = new Map<string, AccessPath>();
  private readonly credentials = new Map<string, UpstreamCredential[]>();

  constructor(
    accessPaths: AccessPath[] = DEFAULT_ACCESS_PATHS,
    private readonly keyring?: KeyringReader,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    for (const p of accessPaths) this.paths.set(p.id, p);
    this.registerEnvCredentials();
  }

  /**
   * 把环境变量里已设置的 key 自动登记成凭据。
   *
   * 这是 45-credentials.md §5.3「Phase 1 凭据只能来自环境变量或 OS keyring」的落地：
   * 部署时只要 export 了 AG_OPENAI_API_KEY，无需再写任何配置就能用。
   * **只登记变量名，值仍留在进程环境里**，不进任何配置对象/日志/trace。
   */
  private registerEnvCredentials(): void {
    for (const [accessPath, envVar] of Object.entries(KEY_ENV_BY_ACCESS_PATH)) {
      const secret = this.env[envVar];
      if (secret === undefined || secret === '') continue;
      this.registerCredential({
        id: `env:${accessPath}`,
        name: `${accessPath} (env ${envVar})`,
        type: 'api_key',
        access_path: accessPath,
        model_namespace: accessPath,
        storage: { location: 'env', ref: envVar, encrypted: false },
        health: { status: 'unknown', last_checked: 0 },
        priority: 100,
        enabled: true,
        refresh: { kind: 'static', on_refresh_failure: 'alert_only' },
      });
    }
  }

  registerCredential(cred: UpstreamCredential): void {
    const list = this.credentials.get(cred.access_path) ?? [];
    const filtered = list.filter((c) => c.id !== cred.id);
    filtered.push(cred);
    filtered.sort((a, b) => a.priority - b.priority);
    this.credentials.set(cred.access_path, filtered);
  }

  formatFor(accessPath: string): FormatId {
    return (this.paths.get(accessPath)?.format ?? 'openai.chat') as FormatId;
  }

  baseUrlFor(accessPath: string): string {
    return BASE_URL_BY_ACCESS_PATH[accessPath] ?? 'http://127.0.0.1:1';
  }

  accessPath(accessPath: string): AccessPath | undefined {
    return this.paths.get(accessPath);
  }

  credentialsFor(accessPath: string): UpstreamCredential[] {
    return (this.credentials.get(accessPath) ?? []).filter((c) => c.enabled);
  }

  async headersFor(accessPath: string, _ctx: RequestContext): Promise<ResolvedHeaders> {
    const path = this.paths.get(accessPath);
    if (path === undefined || !path.requires_credential) {
      // local / mock 路径无需鉴权
      return { headers: {} };
    }
    const creds = this.credentialsFor(accessPath);
    const cred = creds[0];
    const secret = cred === undefined ? undefined : await this.readSecret(cred);
    if (secret === undefined) {
      throw new Error(
        `access path ${accessPath} 没有可用凭据。请设置环境变量 ${KEY_ENV_BY_ACCESS_PATH[accessPath] ?? '(未登记)'}` +
          '（Phase 1 只支持 env / keyring 两档，禁止 vault）',
      );
    }
    return {
      headers: authHeadersFor(accessPath, secret),
      ...(cred === undefined ? {} : { credential_id: cred.id }),
    };
  }

  private async readSecret(cred: UpstreamCredential): Promise<string | undefined> {
    if (cred.storage.location === 'env') {
      return this.env[cred.storage.ref];
    }
    if (cred.storage.location === 'keyring') {
      if (this.keyring === undefined) {
        // Phase 1 没有原生 keyring reader：降级并让调用方看到明确错误，不静默
        throw new Error(
          `凭据 ${cred.id} 声明 storage.location="keyring"，但未注入 KeyringReader` +
            '（Phase 1 不引原生 keyring 依赖，接口已预留）',
        );
      }
      return this.keyring.read(cred.storage.ref);
    }
    throw new Error(
      `凭据 ${cred.id} 声明 storage.location="${cred.storage.location}"，Phase 1 不支持` +
        '（70-roadmap §2：只允许 env / keyring）',
    );
  }
}

/** 各 access path 的鉴权头形态。 Anthropic 用 x-api-key，OpenAI 系用 Bearer。 */
export function authHeadersFor(accessPath: string, secret: string): Record<string, string> {
  switch (accessPath) {
    case 'anthropic':
      return { 'x-api-key': secret, 'anthropic-version': '2026-10-21' };
    case 'openai':
      return { authorization: `Bearer ${secret}` };
    default:
      return { authorization: `Bearer ${secret}` };
  }
}
