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
import {
  parseOAuthSecret,
  refreshOAuthToken,
  serializeOAuthSecret,
  type OAuthSecretPayload,
} from './oauth.js';

export interface ResolvedHeaders {
  headers: Record<string, string>;
  /** 本次实际使用的凭据 id（进 trace 用于对账，不含明文）。 */
  credential_id?: string;
}

/**
 * 计费路径形态——决定 `cash` / `as_api` 双口径怎么算（45 §7.2）。
 *
 * - `subscription`：订阅路径（钱已按月/年付过）→ **cash 恒 0，as_api 照算**；
 * - `pay_as_you_go`：按量路径 → cash 与 as_api 都照算。
 *
 * 这不是"我们想怎么分类"，而是上游的客观事实：两条路的钱走不同渠道
 * （MiMo 官方按量计费页明文「按量计费使用开放平台普通 API Key……与 Token Plan
 * 套餐额度不互通」）。分不清时返回 undefined，调用方按非订阅处理（照算 cash）——
 * 那是保守方向：多记现金不会让成本从报表里消失。
 */
export type BillingMode = 'subscription' | 'pay_as_you_go';

/**
 * 上游 key 前缀 → 计费路径形态。
 *
 * **判据是官方文档明文的前缀约定，不是启发式**：
 *   - `tp-`：MiMo Token Plan 专属 API Key（官方文档「本接口需使用 Token Plan 专属
 *     API Key `tp-`」）→ 订阅；
 *   - `sk-`：普通 API Key（「本接口需使用普通 API Key `sk-`」）→ 按量。
 *     OpenAI / DeepSeek 系的 key 也都是 `sk-`，同样落在按量档。
 *
 * 新增 provider 时在这里加一行。**不按 key 长度/熵猜**：猜错会把一笔订阅用量记成
 * 现金支出（或反过来），而对账时两者都看起来合理——那是最难发现的一类错。
 */
export const BILLING_MODE_BY_KEY_PREFIX: ReadonlyArray<{
  prefix: string;
  mode: BillingMode;
}> = [
  { prefix: 'tp-', mode: 'subscription' },
  { prefix: 'sk-', mode: 'pay_as_you_go' },
];

/** 从 key 串推断计费路径形态；认不出前缀 → undefined（调用方按非订阅处理）。 */
export function billingModeForKey(key: string): BillingMode | undefined {
  for (const { prefix, mode } of BILLING_MODE_BY_KEY_PREFIX) {
    if (key.startsWith(prefix)) return mode;
  }
  return undefined;
}

export interface CredentialResolver {
  /** 该 access path 的默认 wire 格式。 */
  formatFor(accessPath: string): FormatId;
  /** 该 access path 的上游 base URL。 */
  baseUrlFor(accessPath: string): string;
  /** 该 access path 的元数据。 */
  accessPath(accessPath: string): AccessPath | undefined;
  /**
   * 列出一个 access path 上**可用**的凭据（只过滤 `enabled`，按 priority 升序）。
   *
   * 消费者自己决定用哪一把：S5 的换钥重试按这个顺序逐把试，`headersFor` 不传
   * `credential` 时取第一把。**不过滤 health**——45 §4.2 步骤 3a 的"跳过不健康
   * 凭据"是路由期决策，放在这里会让 `credentialsFor` 同时背"枚举"和"筛选"两个
   * 职责，而健康状态目前只有管理面入库的凭据才有（env 档压根没有记录）。
   */
  credentialsFor(accessPath: string): UpstreamCredential[];
  /**
   * 为一次上游调用签发请求头（含鉴权头）。
   *
   * `credential` 显式指定用哪一把（S5 的换钥重试传）；不传 = 取该路径优先级最高的
   * 一把，行为与多凭据支持之前完全一致。
   */
  headersFor(
    accessPath: string,
    ctx: RequestContext,
    credential?: UpstreamCredential,
  ): Promise<ResolvedHeaders>;
  /**
   * 该 access path 当前是订阅路径还是按量路径（S10 与工具端点定 cash/as_api 口径用）。
   *
   * `credential` 显式指定判哪一把（S10 传本次实际用的那把）；不传 = 判优先级最高的
   * 一把。**为什么要能指定**：同一条 access path 上可以同时有一把 `tp-`（订阅）和
   * 一把 `sk-`（按量）——MiMo 官方就明文两者不互通。按路径判会把一次按量用量的
   * 现金成本记成 0（或反过来），而对账时两边都看不出错。
   *
   * 可选能力：没实现 = 分不清，调用方按非订阅处理（照算 cash）。实现方**只读
   * 不写**——key 可能轮换（换环境变量后重启之外的场景），所以每次调用现取，
   * 与 `headersFor` 的同款立场（缓存一份判据等于把"这条路径是什么形态"固化下来）。
   */
  billingModeFor?(accessPath: string, credential?: UpstreamCredential): BillingMode | undefined;
  /**
   * 运行时登记一条 access path（管理面建 provider 时调；可选能力）。
   *
   * 为什么需要它：管理面新建的 provider 在启动表的 `DEFAULT_ACCESS_PATHS` 里不存在，
   * 而 `formatFor` / `baseUrlFor` 对陌生 id 只能给缺省值（`openai.chat` 与一个
   * 必然连不上的本地地址）。不登记的话，"在管理面建了一个渠道"到"这个渠道真的
   * 能路由"之间缺一环，而缺的这一环没有任何报错。
   *
   * 已存在同 id 时**覆盖**（管理员改了 dialect / base_url 要生效），但不动已登记的
   * 凭据列表。不实现这个方法 = 明确不支持运行时登记（调用方据此降级并告知）。
   */
  registerAccessPath?(path: AccessPath): void;
  /** 注销一条 access path（禁用/删除渠道时调；可选能力）。 */
  unregisterAccessPath?(id: string): void;
  /** 运行时登记凭据（含管理员写入加密库的明文密钥；可选能力）。 */
  registerCredential?(cred: UpstreamCredential, decryptedSecret?: string): void;
  /** 注销一条凭据（删除/禁用凭据时调；可选能力）。 */
  unregisterCredential?(id: string): void;
  /** 清空由控制面登记的持久化凭据（重建 runtime 前调；不动 env 自动扫描凭据）。 */
  clearStoredCredentials?(): void;
}

/**
 * 默认 access path 注册表（Phase 1：openai / anthropic 两条 + 一个 local mock，
 * 加 DeepSeek 的**两个 dialect**）。
 *
 * DeepSeek 同时提供 OpenAI 兼容与 Anthropic 兼容两套接口，因此登记**两条**
 * access path（45 §3：access path = 上游端点 + 凭据 + wire 格式的组合）：
 *   - `deepseek.openai-chat`：`POST https://api.deepseek.com/chat/completions`
 *     （注意官方文档的路径**没有 /v1**，与 OpenAI 本家不同；Bearer 鉴权）；
 *   - `deepseek.anthropic-messages`：`POST https://api.deepseek.com/anthropic/v1/messages`
 *     （x-api-key 或 Bearer；anthropic-version 被服务端忽略）。
 * 两条共用同一个 key 环境变量 `DEEPSEEK_API_KEY`（AGENTS.md：key 只走环境变量）。
 * 端点路径的 dialect 差异不在 base URL 里拼接（避免「base URL 带魔法后缀」），
 * 而由 provider profile 的 `endpointPath` 表达，见 providers/deepseek/profile.ts。
 *
 * MiMo 只有一条（`mimo.openai-chat`）：OpenAI 兼容，端点路径**带 /v1**
 * （与 DeepSeek「无 /v1」正好相反，base 两边都只到 host），key 走 `MIMO_API_KEY`。
 * TTS / ASR 没有独立 REST 端点，经同一 chat completions 按模型分发，
 * 因此不为音频单列 access path——
 * 那会是"看起来是另一条路、实际同一个端点"的假条目（音频的计量口径由
 * providers/mimo/audio-models.ts 的 `mimo.tools.tts` / `mimo.tools.asr` 表达）。
 */
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
    // 图片模态（image）：与 openai chat 同一个账号同一把 key，但端点与计费
    // 形态不同（45 §3：access path = 上游端点 + 凭据 + wire 格式的组合）。
    id: 'openai.images',
    label: 'OpenAI Images (API key)',
    format: 'openai.images.generations',
    usage_source: 'provider',
    model_namespaces: ['openai'],
    requires_credential: true,
  },
  {
    // 向量模态（embedding）：同上，OpenAI 兼容形状。
    id: 'openai.embeddings',
    label: 'OpenAI Embeddings (API key)',
    format: 'openai.embeddings',
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
    id: 'deepseek.openai-chat',
    label: 'DeepSeek (OpenAI 兼容)',
    format: 'openai.chat',
    usage_source: 'provider',
    model_namespaces: ['deepseek'],
    requires_credential: true,
  },
  {
    id: 'deepseek.anthropic-messages',
    label: 'DeepSeek (Anthropic 兼容)',
    format: 'anthropic.messages',
    usage_source: 'provider',
    model_namespaces: ['deepseek'],
    requires_credential: true,
  },
  {
    // 小米 MiMo：OpenAI 兼容，base 含 /v1（官方文档的请求地址就是
    // https://<host>/v1/chat/completions）。TTS / ASR 同端点按模型分发，
    // 不为音频单列 access path（见文件头）。
    id: 'mimo.openai-chat',
    label: '小米 MiMo (OpenAI 兼容)',
    format: 'openai.chat',
    usage_source: 'provider',
    model_namespaces: ['mimo'],
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
  // Images / Embeddings 与 chat 同一个 OpenAI 账号：共用同一把 key
  // （同 DeepSeek 两个 dialect 共用 DEEPSEEK_API_KEY 的立场）。
  'openai.images': 'AG_OPENAI_API_KEY',
  'openai.embeddings': 'AG_OPENAI_API_KEY',
  anthropic: 'AG_ANTHROPIC_API_KEY',
  // DeepSeek 两个 dialect 共用同一个 key（同一账号、同一套计费）
  'deepseek.openai-chat': 'DEEPSEEK_API_KEY',
  'deepseek.anthropic-messages': 'DEEPSEEK_API_KEY',
  // MiMo：Token Plan 的 key，chat 与音频（同端点按模型分发）共用
  'mimo.openai-chat': 'MIMO_API_KEY',
};

/**
 * 单个 access path 最多自动登记几把 env 凭据（含主变量）。
 *
 * 8 是"够用且可穷举"的上限：再多就该走 keyring / 加密库，而不是继续往环境里堆
 * 变量名（70 §2 的 Phase 1 边界：只允许 env / keyring）。
 */
export const MAX_ENV_CREDENTIALS_PER_ACCESS_PATH = 8;

/**
 * 第 n 把 key 的环境变量名（n 从 1 开始；1 = 主变量，**不带**后缀）。
 *
 * 这是 Phase 1 下"同一 access path 配多把 key"的唯一途径——45 §5.4 只允许
 * env / keyring 两档，而 keyring 每条一个条目、没有"列出一个路径上的所有条目"
 * 的接口。编号变量名是显式约定而不是魔法：
 *
 *   DEEPSEEK_API_KEY      → 第 1 把（priority 100）
 *   DEEPSEEK_API_KEY_2    → 第 2 把（priority 101）
 *   DEEPSEEK_API_KEY_3    → 第 3 把（priority 102）
 *
 * **不解析单个变量里的分隔符列表**（`sk-a,sk-b`）：那会让"轮换其中一把"变成一次
 * 字符串手术，而轮换正是最常见的运维动作；顺带地，掩码/长度一类诊断也就再也对不回
 * 具体某一把。
 */
export function envKeyVarName(keyEnv: string, n: number): string {
  return n <= 1 ? keyEnv : `${keyEnv}_${n}`;
}

/**
 * 第 n 把 env 凭据的 id（n 从 1 开始；1 = `env:<accessPath>`，与历史逐字一致）。
 *
 * 保持 1 号不变是有意的：单 key 部署的 UsageRecord.credential_id 不能因为
 * "加了多 key 支持"而换个写法——那会让历史用量记录全部对不上。
 */
export function envCredentialId(accessPath: string, n: number): string {
  return n <= 1 ? `env:${accessPath}` : `env:${accessPath}#${n}`;
}

/**
 * 各 access path 的默认上游 base URL（**不含路径**，路径由 codec / provider
 * profile 给）。DeepSeek 两 dialect 同 base：`https://api.deepseek.com`。
 *
 * MiMo 同款：base 只到 host，`/v1/chat/completions` 整段在 provider profile 的
 * `endpointPath` 里。**不能把 /v1 放进 base**——transport 用 `new URL(path, base_url)`
 * 拼地址，base 带路径时绝对路径会把它整段替换掉（`new URL('/v1/chat/completions',
 * 'https://h/v1')` 反而对，但 `new URL('/chat/completions', ...)` 就会丢 /v1），
 * 于是"base 含版本路径"变成一颗只有换路径时才炸的雷。
 */
export const DEFAULT_BASE_URL_BY_ACCESS_PATH: Record<string, string> = {
  openai: 'https://api.openai.com',
  'openai.images': 'https://api.openai.com',
  'openai.embeddings': 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  'deepseek.openai-chat': 'https://api.deepseek.com',
  'deepseek.anthropic-messages': 'https://api.deepseek.com',
  'mimo.openai-chat': 'https://token-plan-cn.xiaomimimo.com',
  mock: 'http://127.0.0.1:1',
};

/**
 * env/keyring 两档的凭据解析器。
 *
 * `env` 档：key 只存在于进程环境，仓库与配置对象里只有变量名；
 * `keyring` 档：由 OS keyring 负责加密，本实现通过注入的 `KeyringReader` 读，
 *   Phase 1 不引原生 keyring 依赖（@napi-rs/keyring 是 Phase 4 的事），
 *   接口先立起来，默认没有 reader 时降级为 env 档并 warning。
 *
 * **同一 access path 可以有多把凭据**（`registerCredential` 可重复调；env 档按
 * `envKeyVarName` 的编号约定自动登记）。`credentialsFor` 按 `priority` 升序返回全部
 * enabled 的，消费者自己决定用哪一把——`headersFor` 不传 `credential` 时用第一把
 * （历史行为），S5 的换钥重试显式传后续几把。
 */
export interface KeyringReader {
  read(ref: string): Promise<string | undefined>;
}

export class EnvCredentialResolver implements CredentialResolver {
  private readonly paths = new Map<string, AccessPath>();
  private readonly credentials = new Map<string, UpstreamCredential[]>();
  /** 控制面持久化凭据的明文密钥内存索引（storage.location === 'encrypted'）。 */
  private readonly encryptedSecrets = new Map<string, string>();
  /** 由控制面登记的凭据 id 集合（重建时用 clearStoredCredentials 清理）。 */
  private readonly storedCredentialIds = new Set<string>();
  /** base URL 覆盖（DI 注入 + 运行时登记；缺省用 DEFAULT_BASE_URL_BY_ACCESS_PATH）。 */
  private readonly baseUrlOverrides: Record<string, string>;
  /** access path → key 的环境变量名（启动表 + 运行时登记两份合一）。 */
  private readonly keyEnvByAccessPath = new Map<string, string>(
    Object.entries(KEY_ENV_BY_ACCESS_PATH),
  );
  private readonly autoRegisterEnv: boolean;
  private readonly refreshLocks = new Map<string, Promise<string>>();
  private onSecretRefreshed?: (credentialId: string, newSecret: string) => Promise<void> | void;

  setOnSecretRefreshed(cb: (credentialId: string, newSecret: string) => Promise<void> | void): void {
    this.onSecretRefreshed = cb;
  }

  constructor(
    accessPaths: AccessPath[] = DEFAULT_ACCESS_PATHS,
    private readonly keyring?: KeyringReader,
    private readonly env: Record<string, string | undefined> = process.env,
    baseUrlOverrides: Record<string, string> = {},
    opts: { autoRegisterEnv?: boolean } = {},
  ) {
    this.autoRegisterEnv = opts.autoRegisterEnv ?? true;
    for (const p of accessPaths) this.paths.set(p.id, p);
    this.baseUrlOverrides = { ...baseUrlOverrides };
    if (this.autoRegisterEnv) {
      this.registerEnvCredentials();
    }
  }

  /**
   * 运行时登记 access path（管理面建/改 provider 时调）。
   */
  registerAccessPath(path: AccessPath): void {
    this.paths.set(path.id, path);
    const baseUrl = path.base_url;
    if (typeof baseUrl === 'string' && baseUrl !== '') {
      this.baseUrlOverrides[path.id] = baseUrl;
    }
    const keyEnv =
      path.key_env ??
      this.keyEnvByAccessPath.get(path.id) ??
      KEY_ENV_BY_ACCESS_PATH[path.id] ??
      defaultKeyEnvFor(path.id);
    this.keyEnvByAccessPath.set(path.id, keyEnv);
    if (this.autoRegisterEnv || path.key_env !== undefined) {
      this.registerEnvCredentialsFor(path.id, keyEnv);
    }
  }

  unregisterAccessPath(id: string): void {
    this.paths.delete(id);
    delete this.baseUrlOverrides[id];
  }

  /**
   * 把环境变量里已设置的 key 自动登记成凭据。
   */
  private registerEnvCredentials(): void {
    for (const [accessPath, envVar] of Object.entries(KEY_ENV_BY_ACCESS_PATH)) {
      if (!this.paths.has(accessPath)) continue;
      this.registerEnvCredentialsFor(accessPath, envVar);
    }
  }

  /**
   * 一个 access path 的 env 档凭据（主变量 + 编号变量，见 `envKeyVarName`）。
   */
  private registerEnvCredentialsFor(accessPath: string, keyEnv: string): void {
    for (let n = 1; n <= MAX_ENV_CREDENTIALS_PER_ACCESS_PATH; n += 1) {
      const ref = envKeyVarName(keyEnv, n);
      const secret = this.env[ref];
      if (secret === undefined || secret === '') continue;
      this.addCredentialEntry({
        id: envCredentialId(accessPath, n),
        name: `${accessPath} (env ${ref})`,
        type: 'api_key',
        access_path: accessPath,
        model_namespace: accessPath,
        storage: { location: 'env', ref, encrypted: false },
        health: { status: 'unknown', last_checked: 0 },
        priority: 100 + (n - 1),
        enabled: true,
        refresh: { kind: 'static', on_refresh_failure: 'alert_only' },
      });
    }
  }

  registerCredential(cred: UpstreamCredential, decryptedSecret?: string): void {
    if (decryptedSecret !== undefined) {
      this.encryptedSecrets.set(cred.id, decryptedSecret);
    }
    if (cred.storage.location === 'vault' || !cred.id.startsWith('env:')) {
      this.storedCredentialIds.add(cred.id);
    }
    this.addCredentialEntry(cred);
  }

  unregisterCredential(id: string): void {
    this.encryptedSecrets.delete(id);
    this.storedCredentialIds.delete(id);
    for (const [ap, list] of this.credentials.entries()) {
      const next = list.filter((c) => c.id !== id);
      if (next.length === 0) this.credentials.delete(ap);
      else if (next.length !== list.length) this.credentials.set(ap, next);
    }
  }

  clearStoredCredentials(): void {
    for (const id of [...this.storedCredentialIds]) {
      this.unregisterCredential(id);
    }
    this.encryptedSecrets.clear();
  }

  private addCredentialEntry(cred: UpstreamCredential): void {
    const list = this.credentials.get(cred.access_path) ?? [];
    const filtered = list.filter((c) => c.id !== cred.id);
    filtered.push(cred);
    filtered.sort((a, b) => a.priority - b.priority);
    this.credentials.set(cred.access_path, filtered);
  }

  formatFor(accessPath: string): FormatId {
    const registered = this.paths.get(accessPath)?.format;
    if (registered !== undefined) return registered as FormatId;
    if (
      accessPath.endsWith('.anthropic-messages') ||
      accessPath === 'anthropic' ||
      accessPath === 'mock-anthropic'
    ) {
      return 'anthropic.messages';
    }
    if (accessPath.endsWith('.openai-responses') || accessPath === 'openai.responses') {
      return 'openai.responses';
    }
    if (accessPath.endsWith('.gemini-generateContent') || accessPath === 'gemini') {
      return 'gemini.generateContent';
    }
    return 'openai.chat';
  }

  baseUrlFor(accessPath: string): string {
    return (
      this.baseUrlOverrides[accessPath] ??
      DEFAULT_BASE_URL_BY_ACCESS_PATH[accessPath] ??
      'http://127.0.0.1:1'
    );
  }

  accessPath(accessPath: string): AccessPath | undefined {
    return this.paths.get(accessPath);
  }

  credentialsFor(accessPath: string): UpstreamCredential[] {
    return (this.credentials.get(accessPath) ?? []).filter((c) => c.enabled);
  }

  /**
   * 为一次上游调用签发请求头。
   *
   * `credential` 显式指定用哪一把——S5 的换钥重试传它，于是"换 key"是一次完整的
   * 重发（新连接、新 deadline、新的 attempt 记录），而不是把同一个请求的头改掉重发。
   * 不传 = 该路径优先级最高的那把，与多凭据支持之前逐字一致。
   */
  async headersFor(
    accessPath: string,
    _ctx: RequestContext,
    credential?: UpstreamCredential,
  ): Promise<ResolvedHeaders> {
    const path = this.paths.get(accessPath);
    if (path !== undefined && !path.requires_credential) {
      return { headers: {} };
    }
    const cred = credential ?? this.credentialsFor(accessPath)[0];
    if (
      path === undefined &&
      cred === undefined &&
      (accessPath === 'mock' || accessPath.startsWith('mock-'))
    ) {
      return { headers: {} };
    }
    const secret = cred === undefined ? undefined : await this.readSecret(cred);
    if (secret === undefined) {
      throw new Error(
        `access path ${accessPath} 没有可用凭据。请设置环境变量 ${this.keyEnvByAccessPath.get(accessPath) ?? '(未登记)'}` +
          `（或通过管理面录入加密凭据；多把 env key 用 ${envKeyVarName(
            this.keyEnvByAccessPath.get(accessPath) ?? 'AG_<PATH>_API_KEY',
            2,
          )} 起编号）`,
      );
    }
    let activeSecret = secret;
    let oauthPayload = parseOAuthSecret(secret);
    if (oauthPayload !== undefined) {
      if (Date.now() >= oauthPayload.expires_at - 5 * 60_000 && oauthPayload.refresh_token !== '') {
        activeSecret = await this.refreshOAuthWithLock(cred.id, oauthPayload);
        oauthPayload = parseOAuthSecret(activeSecret) ?? oauthPayload;
      }
      activeSecret = oauthPayload.access_token;
    }

    const resolvedFormat = path?.format ?? this.formatFor(accessPath);
    const headers = authHeadersFor(accessPath, activeSecret, resolvedFormat);
    const hints = path?.transport_hints;
    if (hints?.extra_headers !== undefined) {
      for (const [k, v] of Object.entries(hints.extra_headers)) {
        if (headers[k] === undefined) headers[k] = v;
      }
    }
    if (hints?.session_header !== undefined && headers[hints.session_header] === undefined) {
      headers[hints.session_header] =
        _ctx.client_raw_headers?.[hints.session_header] ||
        _ctx.client_raw_headers?.['x-session-id'] ||
        _ctx.trace_id ||
        _ctx.request_id ||
        'ag-default-session';
    }
    if (
      oauthPayload?.provider === 'openai-codex' ||
      isCodexBaseUrl(path?.base_url ?? this.baseUrlFor(accessPath))
    ) {
      if (oauthPayload?.account_id !== undefined && oauthPayload.account_id !== '') {
        headers['chatgpt-account-id'] = oauthPayload.account_id;
      }
      if (headers['OpenAI-Beta'] === undefined) headers['OpenAI-Beta'] = 'responses=experimental';
      if (headers['originator'] === undefined) headers['originator'] = 'ag';
    }
    if (
      isOpenCodeBaseUrl(path?.base_url ?? this.baseUrlFor(accessPath)) &&
      headers['x-opencode-session'] === undefined
    ) {
      headers['x-opencode-session'] =
        _ctx.client_raw_headers?.['x-opencode-session'] ||
        _ctx.client_raw_headers?.['x-session-id'] ||
        _ctx.trace_id ||
        _ctx.request_id ||
        'ag-default-session';
    }
    return {
      headers,
      credential_id: cred.id,
    };
  }

  private async refreshOAuthWithLock(
    credId: string,
    payload: OAuthSecretPayload,
  ): Promise<string> {
    const existing = this.refreshLocks.get(credId);
    if (existing !== undefined) return existing;
    const promise = (async () => {
      const refreshed = await refreshOAuthToken(payload);
      const serialized = serializeOAuthSecret(refreshed);
      this.encryptedSecrets.set(credId, serialized);
      try {
        await this.onSecretRefreshed?.(credId, serialized);
      } catch {
        // 落盘回调失败不阻塞当次请求（内存已更新）
      }
      return serialized;
    })();
    this.refreshLocks.set(credId, promise);
    try {
      return await promise;
    } finally {
      this.refreshLocks.delete(credId);
    }
  }

  /**
   * 该 access path 的计费路径形态（同步、只读）。
   *
   * 支持 `env` 档与已解密加载到内存的 `encrypted` 档（S10 同步路径按 key 前缀 `tp-` / `sk-` 判据）。
   */
  billingModeFor(accessPath: string, credential?: UpstreamCredential): BillingMode | undefined {
    const path = this.paths.get(accessPath);
    if (path === undefined || !path.requires_credential) return undefined;
    const cred = credential ?? this.credentialsFor(accessPath)[0];
    if (cred === undefined) return undefined;
    let secret: string | undefined; // privacy-scan: ignore —— 局部变量声明，非硬编码密钥
    if (cred.storage.location === 'env') {
      secret = this.env[cred.storage.ref];
    } else if (cred.storage.location === 'vault') {
      secret = this.encryptedSecrets.get(cred.id);
    } else {
      return undefined;
    }
    if (secret === undefined || secret === '') return undefined;
    if (parseOAuthSecret(secret) !== undefined) return 'subscription';
    return billingModeForKey(secret);
  }

  private async readSecret(cred: UpstreamCredential): Promise<string | undefined> {
    if (cred.storage.location === 'env') {
      return this.env[cred.storage.ref];
    }
    if (cred.storage.location === 'vault') {
      return this.encryptedSecrets.get(cred.id);
    }
    if (cred.storage.location === 'keyring') {
      if (this.keyring === undefined) {
        throw new Error(
          `凭据 ${cred.id} 声明 storage.location="keyring"，但未注入 KeyringReader`,
        );
      }
      return this.keyring.read(cred.storage.ref);
    }
    throw new Error(
      `凭据 ${cred.id} 声明 storage.location="${cred.storage.location}"，不支持的存储位置`,
    );
  }
}

export function defaultKeyEnvFor(accessPath: string): string {
  return `AG_${accessPath.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`;
}

/**
 * 各 access path 的鉴权头形态：按已知特例或 `format` 协议族映射。
 * Anthropic 系用 `x-api-key`、Gemini 用 `x-goog-api-key`、OpenAI 系用 `Bearer`。
 */
function isCodexBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl === '') return false;
  try {
    const u = new URL(baseUrl);
    return u.hostname.toLowerCase() === 'chatgpt.com' && u.pathname.includes('/backend-api');
  } catch {
    return false;
  }
}

function isOpenCodeBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl === '') return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

export function authHeadersFor(
  accessPath: string,
  secret: string, // privacy-scan: ignore —— 函数形参名，非硬编码密钥
  format?: string,
): Record<string, string> {
  if (accessPath === 'anthropic') {
    return { 'x-api-key': secret, 'anthropic-version': '2026-10-21' };
  }
  if (accessPath === 'deepseek.anthropic-messages') {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  }
  if (format === 'anthropic.messages') {
    return { 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
  }
  if (format === 'gemini.generateContent') {
    return { 'x-goog-api-key': secret };
  }
  return { authorization: `Bearer ${secret}` };
}
