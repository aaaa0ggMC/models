/**
 * admin/service.ts —— 管理面业务逻辑（**不碰 HTTP**）。
 *
 * 分层理由：`admin/routes.ts` 只做「HTTP ↔ 对象」的翻译与鉴权，本文件做全部
 * 业务。这样：
 *   - 业务逻辑可以不起服务器直接单测（测试里不建 socket、不发请求）；
 *   - 换传输层（换 fastify / 换成 CLI）时业务一行不改；
 *   - 「哪些操作会写审计」在本文件里一眼看全，不会漏。
 *
 * 依赖全部经构造函数注入（仓库硬约束：禁止模块级单例、禁止隐式全局状态）。
 *
 * ## 审计
 *
 * 每个**写操作**都写一条审计日志。审计日志进加密存储的 `audit` kind，
 * **绝不含 secret / 完整 key / 口令**——只记「谁在什么时候对什么做了什么、
 * 结果如何」。`detail` 字段由各方法显式构造，禁止把请求体整体塞进去
 * （请求体里可能有 secret）。
 */

import type { EncryptedRecordStore, MaskedSecret } from '../storage/record-store.js';
import { describeSecret } from '../storage/record-store.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { CapabilityEntry } from '../ir/index.js';
import type { CredentialResolver, ResolvedHeaders } from '../credentials/resolver.js';
import type { UpstreamCredential } from '../ir/index.js';
import type { Clock } from '../ir/clock.js';
import {
  providerFromAccessPath,
  validateAliasRule,
  validateAliasRuleSet,
  type AliasResolver,
  type AliasRule,
} from './aliases.js';
import type {
  AliasRuleDto,
  AuditLogEntry,
  AuthModeResponse,
  MaskedCredential,
  ProviderConfig,
  SecretRefCreateRequest,
  SecretRefDto,
  SettingDto,
  SettingsListResponse,
  UsageDashboardResponse,
  VirtualKeyCreateRequest,
  VirtualKeyDto,
  VirtualKeyUsage,
} from './api-types.js';
import type { VirtualKeyStore } from '../storage/virtual-keys.js';
import { maskVirtualKey, type VirtualKeyRecord } from '../storage/virtual-keys.js';
import type { SettingsService } from '../config/settings.js';
import type { SettingDescription } from '../config/settings.js';

// ---------------------------------------------------------------------------
// 端口（全部注入）
// ---------------------------------------------------------------------------

/** 元数据同步端口（上游发现 / 离线目录刷新）。 */
export interface MetadataSyncPort {
  /** 拉一次上游模型清单并刷新能力矩阵。 */
  refresh(): Promise<{ discovered: string[]; updated: string[]; added: string[] }>;
}

/** 余额探测端口。 */
export interface BalanceProbePort {
  probe(): Promise<{
    balances: Array<{
      currency: string;
      total_balance: string;
      granted_balance: string;
      topped_up_balance: string;
    }>;
    is_available: boolean;
  }>;
}

/**
 * usage 单位的窄视图。
 *
 * 只要 token 两类：聚合看板与按 key 归因都只关心 input / output。写成窄形状
 * 而不是 `Record<string, number>` 是因为 `UsageUnits` 的真实形状是
 * `{ tokens?: TokenUsage }`（**嵌套**），用扁平 Record 会让
 * `units['input_tokens']` 恒为 undefined——那正是本文件早先的 bug
 * （看板的 token 列永远是 0）。
 */
export interface UsageUnitsView {
  tokens?: { input_tokens?: number; output_tokens?: number };
}

/** usage 记录源（metering 的内存 sink；只读）。 */
export interface UsageRecordSource {
  /**
   * 读一段区间内的记录。
   *
   * 结构上兼容 `metering/usage-record.ts` 的 `UsageRecord`（窄依赖：
   * 「记录里加字段」永远不影响这里）。`usage.units` 用 `UsageUnitsView`
   * 而不是 `UsageUnits`——后者是有名字段的接口，没有索引签名，宽类型在这里
   * 反而让注入方（MemoryUsageSink）塞不进来。
   *
   * `auth` 是**按 key 归因**的唯一入口（P0-1 的直接受益项）：它只带 `key_id`
   * 与归属 id，**绝不含明文 key**（metering 侧的同款保证见
   * usage-record.ts 的「绝不进入 UsageRecord 的字段」第 2 条）。
   */
  list(
    fromTs: number,
    toTs: number,
  ): Array<{
    request_id: string;
    ts: number;
    provider: string;
    model: string;
    model_alias?: string;
    status: string;
    auth?: { key_id?: string; team_id?: string; user_id?: string };
    usage: { units: UsageUnitsView };
    cost: { cash: { total: number }; as_api: { total: number }; status: string };
    finish_reason: string;
    fast_path: boolean;
  }>;
}

/** 对账记录源。 */
export interface ReconciliationSource {
  latest():
    | {
        from_ts: number;
        to_ts: number;
        currency: string;
        estimated_cash: number;
        actual_topped_up_delta: number;
        actual_granted_delta: number;
        deviation_ratio: number | null;
        request_count: number;
        alert: boolean;
        alert_threshold: number;
      }
    | undefined;
}

export interface AdminServiceDeps {
  store: EncryptedRecordStore;
  clock: Clock;
  capabilityRegistry: CapabilityRegistry;
  credentialResolver: CredentialResolver;
  /** 依赖**接口**而不是 DefaultAliasResolver 具体类（DI 常规立场）。 */
  aliasResolver: AliasResolver;
  metadataSync?: MetadataSyncPort;
  balanceProbe?: BalanceProbePort;
  usageSource?: UsageRecordSource;
  reconciliationSource?: ReconciliationSource;
  /** 数据面 virtual key 存储（66 §2）。不注入 = 虚拟 key 端点 501。 */
  virtualKeys?: VirtualKeyStore;
  /** 数据面认证模式描述者（auth/data-plane.ts）。不注入 = 模式端点给缺省值。 */
  dataPlaneAuth?: { describe(): Promise<AuthModeResponse> };
  /** 运行时设置（P0-2）。不注入 = 设置端点 501。 */
  settings?: SettingsService;
}

// ---------------------------------------------------------------------------
// 记录 kind
// ---------------------------------------------------------------------------

const PROVIDER_KIND = 'provider' as const;
const ALIAS_KIND = 'alias' as const;
const AUDIT_KIND = 'audit' as const;
const CRED_META_KIND = 'credential' as const;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AdminService {
  constructor(private readonly deps: AdminServiceDeps) {}

  // ---- 审计 ----

  /**
   * 写一条审计日志。
   *
   * `detail` **由调用方显式构造**，禁止把请求体整体传进来（请求体里可能有
   * secret）。这里再兜一道底：把看起来像 key 的串替换掉。
   */
  private async audit(
    actor: string,
    action: string,
    subject: string,
    outcome: 'ok' | 'error',
    detail?: string,
  ): Promise<void> {
    const entry: AuditLogEntry = {
      id: `audit_${this.deps.clock.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: this.deps.clock.now(),
      actor,
      action,
      subject,
      outcome,
      ...(detail === undefined ? {} : { detail: redactDetail(detail) }),
    };
    await this.deps.store.put(AUDIT_KIND, entry.id, entry);
  }

  async listAudit(limit = 100, offset = 0): Promise<{ items: AuditLogEntry[]; total: number }> {
    const all = (await this.deps.store.listDecrypted<AuditLogEntry>(AUDIT_KIND))
      .map((r) => r.value)
      .sort((a, b) => b.ts - a.ts);
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  // ---- Provider CRUD ----

  async listProviders(): Promise<ProviderConfig[]> {
    const all = await this.deps.store.listDecrypted<ProviderConfig>(PROVIDER_KIND);
    return all.map((r) => r.value).sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProvider(id: string): Promise<ProviderConfig | undefined> {
    return this.deps.store.get<ProviderConfig>(PROVIDER_KIND, id);
  }

  async upsertProvider(
    actor: string,
    input: Omit<ProviderConfig, 'created_at' | 'updated_at' | 'enabled'> & {
      id: string;
      enabled?: boolean;
    },
  ): Promise<{ ok: true; provider: ProviderConfig } | { ok: false; error: string }> {
    if (input.id.length === 0) return { ok: false, error: 'provider id 不能为空' };
    if (input.label.length === 0) return { ok: false, error: 'provider label 不能为空' };
    if (!/^https?:\/\//.test(input.base_url)) {
      return { ok: false, error: 'base_url 必须是 http(s):// 开头' };
    }
    const prev = await this.getProvider(input.id);
    const now = this.deps.clock.now();
    const provider: ProviderConfig = {
      ...input,
      // 未显式给 enabled 时：新建默认开，改建沿用旧值（不能被一次 PATCH 静默关掉）
      enabled: input.enabled ?? prev?.enabled ?? true,
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    await this.deps.store.put(PROVIDER_KIND, input.id, provider);
    await this.audit(
      actor,
      prev === undefined ? 'provider.create' : 'provider.update',
      `provider/${input.id}`,
      'ok',
    );
    return { ok: true, provider };
  }

  async deleteProvider(actor: string, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(PROVIDER_KIND, id);
    if (deleted) {
      await this.audit(actor, 'provider.delete', `provider/${id}`, 'ok');
    }
    return deleted;
  }

  // ---- 凭据（掩码）----

  /**
   * 列出一个 provider 的凭据（**只回掩码**）。
   *
   * 存储侧保证见 storage/record-store.ts：`listMeta` 不解密，因此 secret
   * 本体压根不出现在这一层。这里只负责把元数据拼成 UI 形状 + 算掩码。
   */
  async listCredentials(provider?: string): Promise<MaskedCredential[]> {
    const metas = await this.deps.store.listMeta(CRED_META_KIND);
    const out: MaskedCredential[] = [];
    for (const meta of metas) {
      if (!meta.id.startsWith('cred:')) continue;
      const rec = await this.deps.store.get<{
        provider: string;
        access_path: string;
        secret?: string;
        env_ref?: string;
        note?: string;
        health: MaskedCredential['health'];
        last_checked?: number;
      }>(CRED_META_KIND, meta.id);
      if (rec === undefined) continue;
      if (provider !== undefined && rec.provider !== provider) continue;

      const storage: MaskedCredential['storage'] =
        rec.env_ref !== undefined
          ? { location: 'env', ref: rec.env_ref }
          : { location: 'encrypted' };
      // 掩码只对「我们看得见明文」的那种算；env 引用没有明文可掩
      const maskedInfo: MaskedSecret =
        rec.secret === undefined
          ? { masked: '(env 引用，未入库)', length: 0, head: '' }
          : describeSecret(rec.secret);

      out.push({
        id: meta.id.slice('cred:'.length),
        provider: rec.provider,
        access_path: rec.access_path,
        masked: maskedInfo.masked,
        length: maskedInfo.length,
        head: maskedInfo.head,
        storage,
        enabled: true,
        health: rec.health ?? 'unknown',
        ...(rec.last_checked === undefined ? {} : { last_checked: rec.last_checked }),
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        ...(rec.note === undefined ? {} : { note: rec.note }),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 创建凭据。
   *
   * `secret` 与 `env_ref` **互斥**：都传等于同时声明「key 在库里」和
   * 「key 在环境变量里」，Resolver 该读哪个是不确定的——不确定比不存在更糟。
   */
  async createCredential(
    actor: string,
    input: {
      provider: string;
      access_path: string;
      secret?: string;
      env_ref?: string;
      note?: string;
    },
  ): Promise<{ ok: true; credential: MaskedCredential } | { ok: false; error: string }> {
    const hasSecret = input.secret !== undefined && input.secret.length > 0;
    const hasEnv = input.env_ref !== undefined && input.env_ref.length > 0;
    if (hasSecret && hasEnv) {
      return { ok: false, error: 'secret 与 env_ref 互斥：请只给一个' };
    }
    if (!hasSecret && !hasEnv) {
      return { ok: false, error: '必须提供 secret 或 env_ref 之一' };
    }
    if (input.provider.length === 0 || input.access_path.length === 0) {
      return { ok: false, error: 'provider 与 access_path 不能为空' };
    }

    const id = `cred_${this.deps.clock.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = this.deps.clock.now();
    await this.deps.store.put(
      CRED_META_KIND,
      `cred:${id}`,
      {
        provider: input.provider,
        access_path: input.access_path,
        // secret 只在有值时进库；进了库就是密文（存储侧保证）
        ...(hasSecret ? { secret: input.secret } : {}), // privacy-scan: ignore —— 契约字段名，右侧是请求体入参
        ...(hasEnv ? { env_ref: input.env_ref } : {}),
        ...(input.note === undefined ? {} : { note: input.note }),
        health: 'unknown' as const,
      },
      now,
    );

    // 审计**只记 id 与掩码**，绝不记 secret
    const maskedInfo = hasSecret ? describeSecret(input.secret!) : undefined;
    await this.audit(
      actor,
      'credential.create',
      `credential/${id}`,
      'ok',
      `provider=${input.provider} access_path=${input.access_path}` +
        (maskedInfo === undefined
          ? ' source=env'
          : ` masked=${maskedInfo.masked} length=${maskedInfo.length}`),
    );

    const list = await this.listCredentials(input.provider);
    const created = list.find((c) => c.id === id);
    if (created === undefined) {
      return { ok: false, error: '凭据已写入但读不回来（内部错误）' };
    }
    return { ok: true, credential: created };
  }

  async deleteCredential(actor: string, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(CRED_META_KIND, `cred:${id}`);
    if (deleted) await this.audit(actor, 'credential.delete', `credential/${id}`, 'ok');
    return deleted;
  }

  // ---- 别名 / namespace 映射 ----

  async listAliases(): Promise<AliasRuleDto[]> {
    const all = await this.deps.store.listDecrypted<AliasRule>(ALIAS_KIND);
    return all
      .map((r) => ({ rule: r.value, created_at: r.created_at, updated_at: r.updated_at }))
      .sort(
        (a, b) => a.rule.priority - b.rule.priority || a.rule.pattern.localeCompare(b.rule.pattern),
      )
      .map((r) => ({
        ...r.rule,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
  }

  /**
   * 建/改一条别名规则。
   *
   * 坏规则**拒掉**而不是「先存着再说」：一条非法的 prefix 规则进了路由，
   * 错误发生在请求路径上（客户端拿到一个莫名的 400 或者更糟——被路由到
   * 错误的 provider），而配置时的报错只要一行字。
   */
  async upsertAlias(
    actor: string,
    input: {
      id?: string;
      kind: 'exact' | 'prefix';
      pattern: string;
      target: { provider: string; access_path: string; model: string; max_context_tokens?: number };
      priority?: number;
      enabled?: boolean;
      note?: string;
    },
  ): Promise<{ ok: true; rule: AliasRuleDto } | { ok: false; errors: string[] }> {
    const now = this.deps.clock.now();
    const id = input.id ?? `alias_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const rule: AliasRule = {
      id,
      kind: input.kind,
      pattern: input.pattern,
      target: { ...input.target },
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      ...(input.note === undefined ? {} : { note: input.note }),
    };

    // 单条校验
    const single = validateAliasRule(rule);
    if (!single.ok) return { ok: false, errors: single.errors };

    // 与现有规则合在一起做整表校验（目标不冲突）
    const existing = (await this.listAliases()).filter((r) => r.id !== id);
    const merged: AliasRule[] = [
      ...existing.map((r) => ({
        id: r.id,
        kind: r.kind,
        pattern: r.pattern,
        target: r.target,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.note === undefined ? {} : { note: r.note }),
      })),
      rule,
    ];
    // AliasRuleDto 比 AliasRule 多 created_at/updated_at；灌给解析器只要前者
    const setValidation = validateAliasRuleSet(merged);
    if (!setValidation.ok) return { ok: false, errors: setValidation.errors };

    await this.deps.store.put(ALIAS_KIND, id, rule, now);

    // 热更新路由：让新规则立刻对请求路径生效（不等重启）
    this.deps.aliasResolver.setRules(merged);

    await this.audit(
      actor,
      existing.some((r) => r.id === id) ? 'alias.update' : 'alias.create',
      `alias/${id}`,
      'ok',
      `${rule.kind}:${rule.pattern} -> ${rule.target.access_path}/${rule.target.model}`,
    );
    return { ok: true, rule: { ...rule, created_at: now, updated_at: now } };
  }

  async deleteAlias(actor: string, id: string): Promise<boolean> {
    const deleted = await this.deps.store.delete(ALIAS_KIND, id);
    if (deleted) {
      // 同步刷新路由
      const remaining = (await this.listAliases()).map((r) => ({
        id: r.id,
        kind: r.kind,
        pattern: r.pattern,
        target: r.target,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.note === undefined ? {} : { note: r.note }),
      }));
      this.deps.aliasResolver.setRules(remaining);
      await this.audit(actor, 'alias.delete', `alias/${id}`, 'ok');
    }
    return deleted;
  }

  /** 试解析（UI 预览用，不落库）。 */
  resolveAlias(model: string):
    | {
        source: 'exact' | 'prefix' | 'passthrough';
        rule_id?: string;
        target: { provider: string; access_path: string; model: string };
      }
    | undefined {
    const res = this.deps.aliasResolver.resolve(model, 'chat');
    if (res === undefined) return undefined;
    return {
      source: res.source,
      ...(res.rule === undefined ? {} : { rule_id: res.rule.id }),
      target: {
        provider: res.target.provider,
        access_path: res.target.access_path,
        model: res.target.model,
      },
    };
  }

  /** 把库里持久化的别名规则灌进解析器（启动时调）。 */
  async loadAliasesIntoResolver(): Promise<number> {
    const all = await this.listAliases();
    this.deps.aliasResolver.setRules(
      all.map((r) => ({
        id: r.id,
        kind: r.kind,
        pattern: r.pattern,
        target: r.target,
        priority: r.priority,
        enabled: r.enabled,
        ...(r.note === undefined ? {} : { note: r.note }),
      })),
    );
    return all.length;
  }

  // ---- 能力矩阵（只读，与 ir/capability.ts 同源）----

  /**
   * 能力矩阵。
   *
   * **不另写一份**：直接透出 `CapabilityRegistry` 里的 `CapabilityEntry`
   * （ir/capability.ts 的唯一定义）。另写一份就会出现「矩阵说支持、
   * 路由说不支持」的分裂，而那种 bug 只在线上才暴露。
   */
  listCapabilityMatrix(modality?: 'chat'): CapabilityEntry[] {
    return this.deps.capabilityRegistry.list(modality);
  }

  // ---- 同步触发 ----

  async triggerSync(
    actor: string,
    kind: 'upstream_discovery' | 'offline_catalog_refresh',
  ): Promise<
    | { ok: true; result: { discovered: string[]; updated: string[]; added: string[] } }
    | { ok: false; error: string }
  > {
    if (kind === 'offline_catalog_refresh') {
      // 离线目录刷新 = 重新读仓库内静态定价/模型表，不联网。
      // Phase 1 的静态表是编译期内置的，没有"重新加载"动作；这里明确告知
      // 而不是假装做了一次同步。
      await this.audit(
        actor,
        'sync.offline_catalog',
        'catalog',
        'ok',
        '静态表编译期内置，无需刷新',
      );
      return {
        ok: false,
        error:
          '离线目录在 Phase 1 是编译期内置的（providers/deepseek/pricing.json 等），没有运行时刷新动作；请改用上游发现。',
      };
    }
    if (this.deps.metadataSync === undefined) {
      return { ok: false, error: '未注入元数据同步端口（modelDiscovery）' };
    }
    try {
      const result = await this.deps.metadataSync.refresh();
      await this.audit(
        actor,
        'sync.upstream_discovery',
        'capability-matrix',
        'ok',
        `discovered=${result.discovered.length} updated=${result.updated.length} added=${result.added.length}`,
      );
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audit(actor, 'sync.upstream_discovery', 'capability-matrix', 'error', message);
      return { ok: false, error: message };
    }
  }

  // ---- 用量 / 对账看板 ----

  async usageDashboard(fromTs?: number, toTs?: number): Promise<UsageDashboardResponse> {
    const now = this.deps.clock.now();
    const from = fromTs ?? now - 24 * 60 * 60 * 1000;
    const to = toTs ?? now;
    const records = this.deps.usageSource?.list(from, to) ?? [];

    const byModel = new Map<string, { request_count: number; cash_total: number }>();
    const byProvider = new Map<string, { request_count: number; cash_total: number }>();
    let input_tokens = 0;
    let output_tokens = 0;
    let cash_total = 0;
    let as_api_total = 0;
    let unpriced_count = 0;

    for (const r of records) {
      input_tokens += r.usage.units.tokens?.input_tokens ?? 0;
      output_tokens += r.usage.units.tokens?.output_tokens ?? 0;
      cash_total += r.cost.cash.total;
      as_api_total += r.cost.as_api.total;
      if (r.cost.status === 'unpriced' || r.cost.status === 'pending_price') unpriced_count += 1;
      const m = byModel.get(r.model) ?? { request_count: 0, cash_total: 0 };
      m.request_count += 1;
      m.cash_total += r.cost.cash.total;
      byModel.set(r.model, m);
      const p = byProvider.get(r.provider) ?? { request_count: 0, cash_total: 0 };
      p.request_count += 1;
      p.cash_total += r.cost.cash.total;
      byProvider.set(r.provider, p);
    }

    const recent = records
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 50)
      .map((r) => ({
        request_id: r.request_id,
        ts: r.ts,
        provider: r.provider,
        model: r.model,
        ...(r.model_alias === undefined ? {} : { model_alias: r.model_alias }),
        status: r.status,
        input_tokens: r.usage.units.tokens?.input_tokens ?? 0,
        output_tokens: r.usage.units.tokens?.output_tokens ?? 0,
        cash_total: r.cost.cash.total,
        finish_reason: r.finish_reason,
        fast_path: r.fast_path,
      }));

    return {
      summary: {
        from_ts: from,
        to_ts: to,
        request_count: records.length,
        input_tokens,
        output_tokens,
        cash_total,
        as_api_total,
        unpriced_count,
        by_model: [...byModel].map(([model, v]) => ({ model, ...v })),
        by_provider: [...byProvider].map(([provider, v]) => ({ provider, ...v })),
      },
      recent,
      ...(this.deps.reconciliationSource === undefined
        ? {}
        : { reconciliation: this.deps.reconciliationSource.latest() }),
    };
  }

  // ---- 余额探测 ----

  async probeBalance(): Promise<{
    ok: boolean;
    balances: UsageDashboardResponse['balance'];
    is_available: boolean;
    checked_at: number;
    error?: string;
  }> {
    const checked_at = this.deps.clock.now();
    if (this.deps.balanceProbe === undefined) {
      return {
        ok: false,
        balances: [],
        is_available: false,
        checked_at,
        error: '未注入余额探测端口（DeepSeekBalanceClient）',
      };
    }
    try {
      const snap = await this.deps.balanceProbe.probe();
      return {
        ok: true,
        balances: snap.balances,
        is_available: snap.is_available,
        checked_at,
      };
    } catch (err) {
      return {
        ok: false,
        balances: [],
        is_available: false,
        checked_at,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---- 凭据健康探测 ----

  /**
   * 对某个 access path 打一次上游，看 key 还能不能用。
   *
   * 用 `/models`（GET）而不是发一条 chat：探测不该花 token，也不该在
   * 用量统计里留一条噪声记录。拿不到 `/models` 的 provider 退回「unknown」
   * 而不是「error」——分不清「key 坏了」和「这个上游没有 /models」。
   */
  async probeCredential(accessPath: string): Promise<{
    ok: boolean;
    status: 'ok' | 'error' | 'unknown';
    upstream_status?: number;
    message?: string;
    checked_at: number;
  }> {
    const checked_at = this.deps.clock.now();
    const ctx = systemProbeContext(this.deps.clock, accessPath);
    try {
      const headers: ResolvedHeaders = await this.deps.credentialResolver.headersFor(
        accessPath,
        ctx,
      );
      if (Object.keys(headers.headers).length === 0) {
        // 该 access path 不需要凭据（mock / local）
        return { ok: true, status: 'ok', checked_at, message: '该 access path 无需凭据' };
      }
      return {
        ok: true,
        status: 'unknown',
        checked_at,
        message: '凭据可解析；未发起真实上游探测（避免在用量统计里留噪声）',
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        checked_at,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 已登记的 access path 列表（UI 下拉用）。 */
  listAccessPaths(): Array<{ id: string; label: string; requires_credential: boolean }> {
    // CredentialResolver 没有「列出全部」的接口；用 DEFAULT_ACCESS_PATHS 的
    // 注册表做不到通用。这里通过 credentialsFor 反向收集已知的 access path，
    // 再补上能力矩阵里出现过的。
    const seen = new Set<string>();
    const out: Array<{ id: string; label: string; requires_credential: boolean }> = [];
    for (const entry of this.deps.capabilityRegistry.list()) {
      if (seen.has(entry.access_path)) continue;
      seen.add(entry.access_path);
      const path = this.deps.credentialResolver.accessPath(entry.access_path);
      out.push({
        id: entry.access_path,
        label: path?.label ?? entry.access_path,
        requires_credential: path?.requires_credential ?? true,
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 该 access path 上已登记的凭据（Resolver 视角，含 env 档）。 */
  credentialsForAccessPath(accessPath: string): UpstreamCredential[] {
    return this.deps.credentialResolver.credentialsFor(accessPath);
  }

  // ---- 数据面 virtual key（66 §2）----

  /**
   * 列出一把 key 的 DTO。
   *
   * **绝不明文回显**：`maskVirtualKey` 只拿记录里的 `prefix`（明文前 8 位），
   * 而记录本身没有承载明文的字段（见 storage/virtual-keys.ts 的类型说明）。
   */
  private toDto(rec: VirtualKeyRecord): VirtualKeyDto {
    return {
      key_id: rec.key_id,
      name: rec.name,
      status: rec.status,
      created_at: rec.created_at,
      updated_at: rec.updated_at,
      masked: maskVirtualKey(rec.prefix),
      head: rec.prefix.slice(0, 8),
      ...(rec.note === undefined ? {} : { note: rec.note }),
      ...(rec.revoked_at === undefined ? {} : { revoked_at: rec.revoked_at }),
      ...(rec.expires_at === undefined ? {} : { expires_at: rec.expires_at }),
      ...(rec.models === undefined ? {} : { models: rec.models }),
      ...(rec.providers === undefined ? {} : { providers: rec.providers }),
      ...(rec.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: rec.allow_message_persistence }),
      ...(rec.rate_limit === undefined ? {} : { rate_limit: rec.rate_limit }),
      ...(rec.budget_micros === undefined ? {} : { budget_micros: rec.budget_micros }),
      ...(rec.team_id === undefined ? {} : { team_id: rec.team_id }),
      ...(rec.user_id === undefined ? {} : { user_id: rec.user_id }),
    };
  }

  /**
   * 列出全部 virtual key（掩码 + 元数据）。
   *
   * 审计**不写**：读操作不留痕（与 `listCredentials` 同立场），否则审计日志
   * 会被每次刷新页面刷满。
   */
  async listVirtualKeys(): Promise<VirtualKeyDto[]> {
    if (this.deps.virtualKeys === undefined) return [];
    return (await this.deps.virtualKeys.list()).map((r) => this.toDto(r));
  }

  /**
   * 建一把新 key。**明文只在返回值里出现一次**。
   *
   * 审计只记 `key_id` 与名字，绝不记明文；`detail` 里连掩码都不给——
   * 掩码对审计没用（认不出是哪一把），而 `key_id` 已经唯一。
   */
  async createVirtualKey(
    actor: string,
    input: VirtualKeyCreateRequest,
  ): Promise<{ ok: true; key: VirtualKeyDto; plaintext: string } | { ok: false; error: string }> {
    if (this.deps.virtualKeys === undefined) {
      return { ok: false, error: '未装配虚拟 key 存储（recordStore）' };
    }
    const name = input.name.trim();
    if (name.length === 0) return { ok: false, error: 'name 不能为空' };
    if (input.models !== undefined && input.models.some((m) => m.trim().length === 0)) {
      return { ok: false, error: 'models 里不能有空串' };
    }
    if (input.providers !== undefined && input.providers.some((p) => p.trim().length === 0)) {
      return { ok: false, error: 'providers 里不能有空串' };
    }
    if (input.expires_at !== undefined && input.expires_at <= this.deps.clock.now()) {
      return { ok: false, error: 'expires_at 必须是未来的时间' };
    }

    const created = await this.deps.virtualKeys.create({
      name,
      created_by: actor,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
      ...(input.models === undefined ? {} : { models: input.models }),
      ...(input.providers === undefined ? {} : { providers: input.providers }),
      ...(input.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: input.allow_message_persistence }),
      ...(input.rate_limit === undefined ? {} : { rate_limit: input.rate_limit }),
      ...(input.budget_micros === undefined ? {} : { budget_micros: input.budget_micros }),
      ...(input.team_id === undefined ? {} : { team_id: input.team_id }),
      ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
    });
    await this.audit(
      actor,
      'virtual_key.create',
      `virtual_key/${created.key_id}`,
      'ok',
      `name=${name}`,
    );
    return { ok: true, key: this.toDto(created.record), plaintext: created.plaintext };
  }

  /**
   * 撤销一把 key（记录保留，立刻不可用）。
   *
   * 「立刻」的保证来自 `DefaultVirtualKeyStore.invalidate()`：撤销会清掉校验
   * 缓存，下一个请求重新走 Argon2id 并发现记录已撤销。
   */
  async revokeVirtualKey(
    actor: string,
    keyId: string,
  ): Promise<{ ok: true; key: VirtualKeyDto } | { ok: false; error: string }> {
    if (this.deps.virtualKeys === undefined) {
      return { ok: false, error: '未装配虚拟 key 存储（recordStore）' };
    }
    const revoked = await this.deps.virtualKeys.revoke(keyId, this.deps.clock.now());
    if (revoked === undefined) {
      return { ok: false, error: 'key 不存在或已撤销' };
    }
    await this.audit(actor, 'virtual_key.revoke', `virtual_key/${keyId}`, 'ok');
    return { ok: true, key: this.toDto(revoked) };
  }

  async deleteVirtualKey(actor: string, keyId: string): Promise<boolean> {
    if (this.deps.virtualKeys === undefined) return false;
    const deleted = await this.deps.virtualKeys.delete(keyId);
    if (deleted) await this.audit(actor, 'virtual_key.delete', `virtual_key/${keyId}`, 'ok');
    return deleted;
  }

  /** 该 key 的用量（按 `key_id` 归因；P0-6 的按 key 分组先落在这里）。 */
  async virtualKeyUsage(keyId: string, fromTs?: number, toTs?: number): Promise<VirtualKeyUsage> {
    const now = this.deps.clock.now();
    const from = fromTs ?? now - 24 * 60 * 60 * 1000;
    const to = toTs ?? now;
    const records = (this.deps.usageSource?.list(from, to) ?? []).filter(
      (r) => r.auth?.key_id === keyId,
    );
    const byModel = new Map<string, { request_count: number; cash_total: number }>();
    const byProvider = new Map<string, { request_count: number; cash_total: number }>();
    let input_tokens = 0;
    let output_tokens = 0;
    let cash_total = 0;
    let error_count = 0;
    for (const r of records) {
      input_tokens += r.usage.units.tokens?.input_tokens ?? 0;
      output_tokens += r.usage.units.tokens?.output_tokens ?? 0;
      cash_total += r.cost.cash.total;
      if (r.status !== 'success') error_count += 1;
      const m = byModel.get(r.model) ?? { request_count: 0, cash_total: 0 };
      m.request_count += 1;
      m.cash_total += r.cost.cash.total;
      byModel.set(r.model, m);
      const p = byProvider.get(r.provider) ?? { request_count: 0, cash_total: 0 };
      p.request_count += 1;
      p.cash_total += r.cost.cash.total;
      byProvider.set(r.provider, p);
    }
    return {
      key_id: keyId,
      from_ts: from,
      to_ts: to,
      request_count: records.length,
      error_count,
      input_tokens,
      output_tokens,
      cash_total,
      by_model: [...byModel].map(([model, v]) => ({ model, ...v })),
      by_provider: [...byProvider].map(([provider, v]) => ({ provider, ...v })),
    };
  }

  /** 当前数据面认证模式（虚拟 key / access token / permissive；互斥语义见 auth/data-plane.ts）。 */
  async describeDataPlaneAuth(): Promise<AuthModeResponse> {
    if (this.deps.dataPlaneAuth === undefined) {
      return {
        mode: 'permissive',
        virtual_key_count: (await this.deps.virtualKeys?.count()) ?? 0,
        virtual_keys_enabled: false,
        access_token_configured: false,
        ignored: [],
      };
    }
    return this.deps.dataPlaneAuth.describe();
  }

  // ---- 运行时设置（P0-2）----

  async listSettings(): Promise<SettingsListResponse> {
    if (this.deps.settings === undefined) {
      return { items: [] };
    }
    const described = await this.deps.settings.describe();
    return {
      items: described.items.map(toSettingDto),
      ...(described.config_file_path === undefined
        ? {}
        : { config_file_path: described.config_file_path }),
    };
  }

  /**
   * 改一个设置。审计只记设置项 id 与新值（**设置值不是敏感值**，记下来才有对账价值）；
   * env 锁命中时记 `error` 并原样带回原因。
   */
  async updateSetting(
    actor: string,
    key: string,
    value: unknown,
  ): Promise<{ ok: true; item: SettingDto } | { ok: false; status: 400 | 409; error: string }> {
    if (this.deps.settings === undefined) {
      return { ok: false, status: 400, error: '未装配设置服务（recordStore）' };
    }
    const result = await this.deps.settings.update(actor, key, value);
    if (!result.ok) {
      await this.audit(actor, 'setting.update', `setting/${key}`, 'error', result.error);
      return { ok: false, status: result.status, error: result.error };
    }
    await this.audit(
      actor,
      'setting.update',
      `setting/${key}`,
      'ok',
      `value=${String(result.item.value)} source=${result.item.source}`,
    );
    return { ok: true, item: toSettingDto(result.item) };
  }

  async listSecretRefs(): Promise<SecretRefDto[]> {
    if (this.deps.settings === undefined) return [];
    return this.deps.settings.listSecretRefs();
  }

  /**
   * 登记一个敏感值引用（只存 `env:<VAR>`）。
   *
   * 传入 `value` 会被设置服务 400 拒绝；这里再兜一道：绝不把 value 塞进审计。
   */
  async registerSecretRef(
    actor: string,
    input: SecretRefCreateRequest & { value?: unknown },
  ): Promise<{ ok: true; ref: SecretRefDto } | { ok: false; status: 400; error: string }> {
    if (this.deps.settings === undefined) {
      return { ok: false, status: 400, error: '未装配设置服务（recordStore）' };
    }
    const result = await this.deps.settings.registerSecretRef({
      name: input.name,
      env_var: input.env_var,
      ...(input.note === undefined ? {} : { note: input.note }),
      ...(input.value === undefined ? {} : { value: input.value }),
    });
    if (!result.ok) {
      await this.audit(
        actor,
        'secret_ref.create',
        `secret_ref/${input.name}`,
        'error',
        result.error,
      );
      return { ok: false, status: result.status, error: result.error };
    }
    await this.audit(
      actor,
      'secret_ref.create',
      `secret_ref/${input.name}`,
      'ok',
      `ref=${result.ref.ref}`,
    );
    return { ok: true, ref: result.ref };
  }

  async deleteSecretRef(actor: string, name: string): Promise<boolean> {
    if (this.deps.settings === undefined) return false;
    const deleted = await this.deps.settings.deleteSecretRef(name);
    if (deleted) await this.audit(actor, 'secret_ref.delete', `secret_ref/${name}`, 'ok');
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * `SettingDescription`（config/settings.ts 的内部形状，字段叫 `key`）→ `SettingDto`
 * （HTTP 契约，字段叫 `id`）。
 *
 * **显式逐字段映射，不用 `{...s}`**：契约字段与内部字段不同名，展开会把内部的
 * `key` 一起带进响应——那正是前端脱敏守卫误拦设置页的字段。逐字段列出来，
 * 将来契约加字段时漏映射会直接编译报错，不会静默少一个字段。
 */
function toSettingDto(s: SettingDescription): SettingDto {
  return {
    id: s.key,
    label: s.label,
    description: s.description,
    unit: s.unit,
    type: s.type,
    value: s.value,
    source: s.source,
    editable: s.editable,
    ...(s.reason === undefined ? {} : { reason: s.reason }),
    ...(s.env_var === undefined ? {} : { env_var: s.env_var }),
    ...(s.range === undefined ? {} : { range: s.range }),
    ...(s.options === undefined ? {} : { options: s.options }),
    ...(s.stored_value === undefined ? {} : { stored_value: s.stored_value }),
    ...(s.updated_at === undefined ? {} : { updated_at: s.updated_at }),
    ...(s.updated_by === undefined ? {} : { updated_by: s.updated_by }),
  };
}

/** 系统探针用的最小 RequestContext（同 composition-root.ts 的 systemProbeCtx）。 */
function systemProbeContext(
  clock: Clock,
  accessPath: string,
): Parameters<CredentialResolver['headersFor']>[1] {
  const now = clock.now();
  return {
    request_id: 'req_admin_probe',
    started_at: now,
    deadline: now + 30_000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'admin' },
    route: {
      access_path: accessPath,
      provider: providerFromAccessPath(accessPath),
      provider_format: 'openai.chat',
      model: 'probe',
      full_model_id: `${accessPath}/probe`,
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'openai.chat',
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    warn: () => {},
  } as unknown as Parameters<CredentialResolver['headersFor']>[1];
}

/**
 * 审计 detail 的兜底脱敏。
 *
 * 各调用点已经只传构造好的字符串；这里是**最后一道防线**——万一有人把
 * 请求体整体传进来，也不至于把 key 写进审计日志。规则与 65 §6.1 的硬编码
 * 黑名单同立场：疑似 key 的串（`sk-` / `sk-ant-` / `AIza` 前缀 + 长度）整段替换。
 */
export function redactDetail(detail: string): string {
  return detail
    .replace(/\b(sk|sk-ant|AIza|ghp_|xoxb)-[A-Za-z0-9_-]{8,}\b/g, '<REDACTED:key>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<REDACTED:jwt>')
    .replace(/(password|passphrase|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=<REDACTED>');
}
