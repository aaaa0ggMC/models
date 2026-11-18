/**
 * catalog/registry.ts —— canonical 模型目录：分层合并 + 查询。
 *
 * ## 单一事实来源（本文件最重要的一条）
 *
 * `ir/capability.ts` 的 `CapabilityEntry` 是**机读运行时字段的唯一事实来源**。目录从
 * 能力矩阵读 `access_paths[]` / `unsupported_parameters` / `constraints` 的值 /
 * 模态 / 窗口 / effort，**不另写一份**。上游（DeepSeek `/models`）的运行时字段经由
 * `providers/deepseek/catalog-metadata.ts` 的 `load()` **写回矩阵**之后才在响应里生效
 * ——上游数据进入系统只有这一个入口，因此不会出现"discovery 刷新了矩阵、目录里还是旧值"
 * 这种双写者漂移。
 *
 * 合并优先级（低 → 高）：`offline`（vendored models.dev + provider 静态表）<
 * `upstream`（实时发现，只补矩阵没有的字段）< `capability-matrix`（运行时真值）<
 * `config`（管理员修正，可覆盖矩阵字段并写回矩阵）。
 *
 * ## 为什么 config 能覆盖矩阵字段而 offline/upstream 不能
 *
 * 矩阵字段同时是**路由判据**（S2 按 context_window / modality / constraints 做拒绝降级
 * 放行）。如果目录在响应里显示一个与路由不同的窗口，客户端按响应裁剪 prompt 仍会被
 * 上游拒——那是比"数字旧了"更糟的故障。所以低层只能**填空**（矩阵没有的字段才轮到它们），
 * 只有管理员显式修正才能改矩阵字段，且必须写回矩阵（`applyConfigOverrides`），让路由
 * 与响应永远同源。
 *
 * ## 端到端容错
 *
 * 任何一层加载失败都**不影响端点**：离线层失败 → 只用矩阵 + 剩余层；上游层失败 →
 * 同步服务保留 last-known-good 并在 `provenance` 打 `stale: true` +
 * `last_successful_fetch`；两层全挂 → 矩阵种子值照常返回（静态能力表本来就可用）。
 *
 * ## 列出来的是什么（部署态过滤）
 *
 * `list()` 默认只列**这个部署真调得通**的模型，两条判据都是真实读取、不是猜：
 *
 * 1. **provider 已配置**（`providerAvailability` 端口，装配方用渠道表 + 凭据库实现）：
 *    没配渠道也没配 key 的 provider，其模型默认不列——否则一份只配了 DeepSeek 的部署
 *    会在清单里看到 openai / anthropic 的模型，客户端挑一个就 401。`?include_unconfigured=true`
 *    看全量，记录上带 `availability: "unconfigured"` 标记。
 * 2. **非内部脚手架**：能力矩阵里标了 `internal` 的条目（mock 路径）永不对用户可见，
 *    `?include_internal=true` 才出现。条目**不从矩阵删**——路由的能力预检与 fast path
 *    资格都读矩阵，删条目会顺带改变请求路径行为。
 *
 * 详情端点（`get()`）不过滤：未配置的模型仍可查到，并带 `availability` 标记，让调用方
 * 知道"它存在，只是没配渠道"，而不是一个看不出原因的 404。
 *
 * ## 列表返回紧凑字段集
 *
 * `data[]` 默认只带挑模型用得上的字段（见 catalog/projection.ts）；`provenance` /
 * `access_paths` / 剪过的 `pricing` 规则这些重字段走 `?expand=` / `?fields=` 或详情端点。
 * OpenAI 兼容四键永远在，老客户端只读 `data[].id` 的行为不变。
 */

import type { CapabilityEntry, ModalityKind } from '../ir/index.js';
import type { RouteGraph } from '../gateway-core/routing-engine.js';
import type { Clock, Logger } from '../di/ports.js';
import type {
  AccessPathCredential,
  AccessPathInfo,
  AccessPathLimits,
  AccessPathProviderResolver,
  CanonicalModelRecord,
  CapabilityRegistryReader,
  EffortInfo,
  FieldSource,
  LayerStatus,
  MetadataLayer,
  ModelCapability,
  ModelConstraint,
  ModelListResponse,
  ModelMetadata,
  ModelMetadataSource,
  ModelMetadataSnapshot,
  ModelPricing,
  ModelProvenance,
  ModelQuery,
  ProviderAvailabilityResolver,
  UpstreamSourceState,
  UpstreamSnapshotProvider,
} from './types.js';
import { ModelQueryError, SORT_KEYS } from './types.js';
import { projectRecord } from './projection.js';
import { isInternalFlag } from './visibility.js';

/** 凭据形态查询（组合根用 CredentialResolver 实现；不含明文）。 */
export type AccessPathCredentialLister = (
  accessPath: string,
) => { requires_credential: boolean; credentials: Array<{ type: string }> } | undefined;

export interface ModelCatalogOptions {
  capabilityRegistry: CapabilityRegistryReader & { register?(entry: CapabilityEntry): void };
  /** 离线层 + 配置层来源（不含上游层——上游由同步服务持有）。 */
  sources?: ModelMetadataSource[];
  /** 上游层状态提供者（同步服务实现）。 */
  upstream?: UpstreamSnapshotProvider;
  clock: Clock;
  logger?: Logger;
  /** access path → provider（缺省用「点号前前缀」约定）。 */
  providerResolver?: AccessPathProviderResolver;
  /** access path → 凭据形态（缺省 = 不报凭据信息）。 */
  credentialLister?: AccessPathCredentialLister;
  /**
   * provider → namespace（缺省 = 没有渠道启用 namespace）。
   *
   * 用途：`/v1/models` 的每条记录要**同时**暴露裸 id 与 namespace 生效名
   * （`<ns>/<id>`），客户端才能发现"这个模型还有第二个名字"——只暴露一个名字的话，
   * 客户端按 `<ns>/<id>` 发请求会 404，而它在列表里明明"存在"。
   */
  namespaceResolver?: (provider: string) => string | undefined;
  /**
   * provider → 是否已配置（缺省 = 全部算已配置，不过滤）。
   *
   * 判据由装配方用**真实存储**实现（渠道表 + 凭据库），目录只问一个是非题——它对
   * "这个部署配了什么"没有任何先验，不猜。默认不注入时不过滤，是为了让只测合并逻辑的
   * 调用方（测试、dog-fooding）不被部署状态干扰。
   */
  providerAvailability?: ProviderAvailabilityResolver;
  /**
   * 管理员在「模型目录」中显式关闭暴露的模型标识符（返回 true = 不出现在 `/v1/models`）。
   */
  isModelHidden?: (modelId: string) => boolean;
  /**
   * 启用的路由图自定义模型标识符来源（供 `/v1/models` 暴露给客户端选择）。
   */
  routeGraphSource?: () => Array<{
    id: string;
    label: string;
    created_at?: number;
    nodes?: RouteGraph['nodes'];
    ability_mode?: RouteGraph['ability_mode'];
    abilities?: RouteGraph['abilities'];
  }>;
}

/** 一个 (provider, model) 的全部层贡献。 */
interface ModelContributions {
  provider: string;
  model: string;
  entries: CapabilityEntry[];
  contributions: Array<{ sourceId: string; layer: MetadataLayer; meta: ModelMetadata }>;
}

/** 内部可变记录（合并过程中的中间形态）。 */
type MutableRecord = CanonicalModelRecord & { provenance: ModelProvenance };

/**
 * canonical 请求参数全集（`supported_parameters` 的推导基底）。
 *
 * 这是**能力矩阵 `unsupported_fields` 的补集**而不是"上游支持清单"：矩阵里登记了某条
 * 路径不支持的 canonical 字段，从全集里减掉就是该路径支持的参数。provider 静态表可以
 * 直接给一份更准的 `supported_parameters` 覆盖它（DeepSeek 就是这么做的）。
 */
const CANONICAL_CHAT_PARAMS: ReadonlyArray<string> = [
  'messages',
  'system',
  'tools',
  'tool_choice',
  'params.max_output_tokens',
  'params.temperature',
  'params.top_p',
  'params.top_k',
  'params.stop',
  'params.seed',
  'params.frequency_penalty',
  'params.presence_penalty',
  'params.logprobs',
  'params.top_logprobs',
  'params.n',
  'params.user',
  'params.metadata',
  'params.service_tier',
  'params.response_format',
  'params.response_format.json_object',
  'params.response_format.json_schema',
  'thinking',
  'thinking.effort',
  'thinking.budget_tokens',
  'stream',
  'stream.include_usage',
  'cache_control',
];

export class ModelCatalog {
  private readonly capabilityRegistry: ModelCatalogOptions['capabilityRegistry'];
  private readonly sources: ModelMetadataSource[];
  private readonly upstream: UpstreamSnapshotProvider | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly providerResolver: AccessPathProviderResolver;
  private readonly credentialLister: AccessPathCredentialLister | undefined;
  private readonly namespaceResolver: ((provider: string) => string | undefined) | undefined;
  private readonly providerAvailability: ProviderAvailabilityResolver | undefined;
  private readonly isModelHidden: ((modelId: string) => boolean) | undefined;
  private readonly routeGraphSource:
    | (() => Array<{
        id: string;
        label: string;
        created_at?: number;
        nodes?: RouteGraph['nodes'];
        ability_mode?: RouteGraph['ability_mode'];
        abilities?: RouteGraph['abilities'];
      }>)
    | undefined;

  /** 离线/配置层的快照缓存（加载一次；空 Map = 还没加载或全部失败）。 */
  private snapshots = new Map<string, ModelMetadataSnapshot>();
  /** 各离线/配置层最后一次加载错误（成功时清除）——进 provenance.layers，运维要看得见。 */
  private readonly loadErrors = new Map<string, string>();
  private loadPromise: Promise<void> | undefined;
  /** 配置层覆盖了矩阵字段的 model → 字段集（provenance 用它标注来源）。 */
  private readonly configOverriddenFields = new Map<string, Set<string>>();

  constructor(options: ModelCatalogOptions) {
    this.capabilityRegistry = options.capabilityRegistry;
    this.sources = options.sources ?? [];
    this.upstream = options.upstream;
    this.clock = options.clock;
    this.logger = options.logger;
    this.providerResolver = options.providerResolver ?? defaultProviderResolver;
    this.credentialLister = options.credentialLister;
    this.namespaceResolver = options.namespaceResolver;
    this.providerAvailability = options.providerAvailability;
    this.isModelHidden = options.isModelHidden;
    this.routeGraphSource = options.routeGraphSource;
  }

  // -------------------------------------------------------------------------
  // 加载（离线层 + 配置层）
  // -------------------------------------------------------------------------

  /**
   * 加载离线层与配置层（幂等；失败不抛）。
   *
   * 为什么失败不抛：端点绝不能因为元数据层挂了而失败。vendored JSON 损坏、provider 静态
   * 表加载失败都只让对应层缺席（日志里记 warn），矩阵种子值照常返回。
   */
  async ready(): Promise<void> {
    if (this.loadPromise === undefined) {
      this.loadPromise = this.loadSources();
    }
    return this.loadPromise;
  }

  private async loadSources(): Promise<void> {
    const next = new Map<string, ModelMetadataSnapshot>();
    for (const source of this.sources) {
      try {
        next.set(source.id, await source.load());
        this.loadErrors.delete(source.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.loadErrors.set(source.id, message);
        this.logger?.warn('catalog: 元数据来源加载失败，该层缺席', {
          source: source.id,
          layer: source.layer,
          error: message,
        });
      }
    }
    this.snapshots = next;
    // 配置层对矩阵字段的修正在此写回（见 applyConfigOverrides）。放在加载之后而不是
    // 构造函数里：来源是异步端口，装配必须等它 load 完。这一步是**幂等**的，且只在
    // 每次 (re)load 后跑一次，不在查询路径上反复触发。
    this.applyConfigOverrides();
  }

  /** 测试/热更新用：重新加载离线层与配置层。 */
  async reload(): Promise<void> {
    this.loadPromise = undefined;
    await this.ready();
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** `GET /v1/models`。 */
  async list(query: ModelQuery = {}): Promise<ModelListResponse> {
    await this.ready();
    const records = this.buildAll();
    const visible = records.filter((r) => {
      // 退役别名默认不列（老行为）
      if (r.retired !== undefined && query.include_retired !== true) return false;
      // 未配置 provider 的模型默认不列：清单短一点，但每一条都调得通
      if (r.availability === 'unconfigured' && query.include_unconfigured !== true) return false;
      // 内部脚手架（mock 路径）永不对用户可见
      if (this.isInternal(r) && query.include_internal !== true) return false;
      // 管理员在模型目录中显式关闭暴露的模型标识符不对外暴露
      if (this.isModelHidden?.(r.id) === true) return false;
      return true;
    });
    const matched = visible.filter((r) => matchesQuery(r, query));
    const sorted = sortRecords(matched, query.sort);
    const total = sorted.length;
    const offset = query.offset ?? 0;
    const limit = query.limit;
    const page = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
    return {
      object: 'list',
      // 紧凑字段集（provenance / access_paths / quirks 默认省略）；?expand= / ?fields= 取全量
      data: page.map((r) => projectRecord(r, query)),
      total,
      ...(limit === undefined && offset === 0 ? {} : { has_more: offset + page.length < total }),
    };
  }

  /**
   * 该记录是否**整条**都是内部脚手架。
   *
   * 判据取"全部 access path 都是 internal"而不是"任一是"：一条记录可能同时有内部路径与
   * 真实路径（混合装配的调试场景），那时它对用户仍有可用的一面，不该整条消失。
   *
   * `internal` 标记的解读只有一处（catalog/visibility.ts 的 `isInternalFlag`）——
   * 管理面 `GET /admin/api/capabilities` 的条目级过滤走同一个函数、同一个
   * `providerAvailability` 端口，两个端点的可见性判据不会分叉。
   */
  private isInternal(record: CanonicalModelRecord): boolean {
    const paths = record.access_paths ?? [];
    // 没有矩阵条目 = 没有判据，不猜（层里声明、矩阵没有的模型不当成脚手架）
    if (paths.length === 0) return false;
    return paths.every((p) => isInternalFlag(p.internal));
  }

  /** `GET /v1/models/{id}`；找不到返回 undefined（HTTP 层给 404）。 */
  async get(id: string): Promise<CanonicalModelRecord | undefined> {
    await this.ready();
    return this.buildAll().find((r) => r.id === id);
  }

  /** 全部记录（含退役项；测试与 dog-fooding 用）。 */
  async all(): Promise<CanonicalModelRecord[]> {
    await this.ready();
    return this.buildAll();
  }

  // -------------------------------------------------------------------------
  // 合并
  // -------------------------------------------------------------------------

  /** 组装全部记录（矩阵驱动的模型集合 + 层里声明为退役的别名）。 */
  private buildAll(): CanonicalModelRecord[] {
    const grouped = this.groupByModel();
    // provider 可用性只问一次（一次查询里同一个 provider 会出现多条记录）；
    // 每次 buildAll 重算，所以管理面加一条渠道立刻反映到下一次查询
    const availability = new Map<string, boolean>();
    const configured = (provider: string): boolean => {
      let known = availability.get(provider);
      if (known === undefined) {
        known = this.providerAvailability?.(provider) ?? true;
        availability.set(provider, known);
      }
      return known;
    };
    const records: CanonicalModelRecord[] = [];
    for (const group of grouped.values()) {
      if (group.entries.length === 0 && !this.isRetiredOnly(group)) continue;
      records.push(this.buildRecord(group, configured));
    }
    const existingIds = new Set(records.map((r) => r.id));
    for (const graph of this.routeGraphSource?.() ?? []) {
      if (existingIds.has(graph.id)) continue;
      existingIds.add(graph.id);
      const synthesized = synthesizeRouteGraphAbilities(graph, records);
      records.push({
        id: graph.id,
        object: 'model',
        name: graph.label,
        owned_by: 'agentgateway-router',
        provider: 'router',
        modalities: ['chat'],
        ...synthesized,
        ...(graph.created_at === undefined ? {} : { created: Math.floor(graph.created_at / 1000) }),
        provenance: {
          assembled_at: this.clock.now(),
          fields: { id: 'config', name: 'config' },
          layers: [{ sourceId: 'route-graph', layer: 'config', contributed: true }],
          stale: false,
        },
      });
    }
    return records;
  }

  /** 该组是否"只在层里出现且被声明为退役"（详情端点用它解释 404）。 */
  private isRetiredOnly(group: ModelContributions): boolean {
    return group.contributions.some((c) => c.meta.retired !== undefined);
  }

  /** 矩阵条目 + 各层贡献，按 (provider, model) 分组。 */
  private groupByModel(): Map<string, ModelContributions> {
    const grouped = new Map<string, ModelContributions>();
    const ensure = (provider: string, model: string): ModelContributions => {
      const key = `${provider}/${model}`;
      let group = grouped.get(key);
      if (group === undefined) {
        group = { provider, model, entries: [], contributions: [] };
        grouped.set(key, group);
      }
      return group;
    };

    for (const entry of this.capabilityRegistry.list()) {
      ensure(this.providerResolver(entry.access_path), entry.model).entries.push(entry);
    }

    for (const source of this.sources) {
      const snapshot = this.snapshots.get(source.id);
      if (snapshot === undefined) continue;
      for (const meta of snapshot.models) {
        const provider = meta.provider ?? source.providers?.[0] ?? 'unknown';
        ensure(provider, meta.id).contributions.push({
          sourceId: source.id,
          layer: source.layer,
          meta,
        });
      }
    }

    for (const state of this.upstreamStates()) {
      if (state.snapshot === undefined) continue;
      for (const meta of state.snapshot.models) {
        const provider = meta.provider ?? 'unknown';
        ensure(provider, meta.id).contributions.push({
          sourceId: state.sourceId,
          layer: 'upstream',
          meta,
        });
      }
    }

    return grouped;
  }

  private upstreamStates(): UpstreamSourceState[] {
    return this.upstream?.states() ?? [];
  }

  /** 组装一条记录。 */
  private buildRecord(
    group: ModelContributions,
    configured: (provider: string) => boolean,
  ): CanonicalModelRecord {
    const record: MutableRecord = {
      id: group.model,
      object: 'model',
      owned_by: group.provider,
      provider: group.provider,
      provenance: { assembled_at: this.clock.now(), fields: {}, layers: [], stale: false },
    };

    // 1) 矩阵基底（运行时真值）
    this.applyMatrixBase(record, group);

    // 2) 层贡献，按优先级升序：offline → upstream → config
    const ordered = [...group.contributions].sort(
      (a, b) => layerRank(a.layer) - layerRank(b.layer),
    );
    for (const contribution of ordered) {
      this.applyContribution(record, contribution);
    }

    // 3) 派生字段与 provenance
    this.applyDerived(record, group);
    this.applyModalities(record, group);
    this.applyNamespaceAliases(record);
    this.applyProvenanceLayers(record, group);
    // 4) 部署态：provider 是否已配置。**只在未配置时写这个键**（已配置是常态，
    //    给每条记录加一个 configured:true 是纯噪声；未配置才是要解释的例外）
    if (!configured(record.provider)) {
      record.availability = 'unconfigured';
      record.provenance.fields['availability'] = 'provider-availability';
    }
    return record;
  }

  /**
   * namespace 生效名（`<ns>/<id>`）。
   *
   * 与 `aliases`（路由别名，管理员手建）**分开一个键**：两者来源不同、生命周期不同
   * （别名手建手删，namespace 随 provider 配置走），混在一个数组里会让"这个名字
   * 到底谁说的"变得要靠约定区分。客户端两个键都读就能发现全部可用名字。
   *
   * 只在真的配了 namespace 时出现这个键——没配的渠道多一个空数组是纯噪声。
   */
  private applyNamespaceAliases(record: MutableRecord): void {
    const namespace = this.namespaceResolver?.(record.provider);
    if (namespace === undefined || namespace === '') return;
    record.namespaced_ids = [`${namespace}/${record.id}`];
    record.provenance.fields['namespaced_ids'] = 'provider-config';
  }

  /** 矩阵 → 记录基底。 */
  private applyMatrixBase(record: MutableRecord, group: ModelContributions): void {
    const entries = [...group.entries].sort((a, b) => a.access_path.localeCompare(b.access_path));
    const matrixSource: FieldSource = 'capability-matrix';

    record.access_paths = entries.map((entry) => this.accessPathInfo(entry));

    const first = entries[0];
    if (first !== undefined) {
      if (first.context_window !== undefined) {
        record.context_window = first.context_window;
        record.provenance.fields['context_window'] = matrixSource;
      }
      if (first.max_output_tokens !== undefined) {
        record.max_output_tokens = first.max_output_tokens;
        record.provenance.fields['max_output_tokens'] = matrixSource;
      }
      if (first.input_modalities !== undefined) {
        record.input_modalities = [...first.input_modalities];
        record.provenance.fields['input_modalities'] = matrixSource;
      }
      if (first.output_modalities !== undefined) {
        record.output_modalities = [...first.output_modalities];
        record.provenance.fields['output_modalities'] = matrixSource;
      }
      if (first.effort !== undefined) {
        record.effort = {
          levels: [...first.effort.supported_levels],
          ...(first.effort.default_level === undefined
            ? {}
            : { default: first.effort.default_level }),
        };
        record.provenance.fields['effort'] = matrixSource;
      }
    }

    // constraints 按 (model, dialect) 声明：OpenAI 兼容面没有对应声明，不能编一个
    const constraints: ModelConstraint[] = [];
    for (const entry of entries) {
      if (entry.constraints === undefined) continue;
      constraints.push({
        dialect: entry.format ?? 'openai.chat',
        ...entry.constraints,
        source: 'upstream-declared',
      });
    }
    if (constraints.length > 0) {
      record.constraints = constraints;
      record.provenance.fields['constraints'] = matrixSource;
    }
  }

  /** 一条矩阵条目 → access path 信息。 */
  private accessPathInfo(entry: CapabilityEntry): AccessPathInfo {
    const credential = this.credentialInfo(entry.access_path);
    return {
      access_path: entry.access_path,
      provider: this.providerResolver(entry.access_path),
      format: entry.format ?? 'openai.chat',
      modality: entry.modality,
      status: entry.status,
      contract_tested: entry.contract_tested,
      ...(entry.streaming === undefined ? {} : { streaming: entry.streaming }),
      usage_source: entry.usage_source,
      ...(entry.usage_units === undefined ? {} : { usage_units: [...entry.usage_units] }),
      ...(entry.unsupported_fields === undefined
        ? {}
        : { unsupported_parameters: [...entry.unsupported_fields] }),
      ...(entry.quirks === undefined ? {} : { quirks: [...entry.quirks] }),
      ...(entry.internal === true ? { internal: true } : {}),
      ...(entry.constraints === undefined
        ? {}
        : {
            constraints: [
              {
                dialect: entry.format ?? 'openai.chat',
                ...entry.constraints,
                source: 'upstream-declared' as const,
              },
            ],
          }),
      ...(credential === undefined ? {} : { credential }),
      cash_pricing: credential?.kind === 'subscription-oauth' ? 'subscription' : 'api',
    };
  }

  private credentialInfo(accessPath: string): AccessPathCredential | undefined {
    const listed = this.credentialLister?.(accessPath);
    if (listed === undefined) return undefined;
    if (!listed.requires_credential) return { kind: 'none', available: 0 };
    const types = [...new Set(listed.credentials.map((c) => c.type))];
    const subscription = types.some((t) => t.startsWith('oauth'));
    return {
      kind: subscription ? 'subscription-oauth' : 'api-key',
      types,
      available: listed.credentials.length,
    };
  }

  /** 一层贡献 → 记录。 */
  private applyContribution(
    record: MutableRecord,
    contribution: { sourceId: string; layer: MetadataLayer; meta: ModelMetadata },
  ): void {
    const { sourceId, meta } = contribution;
    const set = <K extends keyof CanonicalModelRecord>(
      key: K,
      value: CanonicalModelRecord[K],
    ): void => {
      record[key] = value;
      record.provenance.fields[key] = sourceId;
    };

    // ---- 标量 / 数组：后写者赢 ----
    if (meta.name !== undefined) set('name', meta.name);
    if (meta.description !== undefined) set('description', meta.description);
    if (meta.family !== undefined) set('family', meta.family);
    if (meta.release_date !== undefined) set('release_date', meta.release_date);
    if (meta.knowledge_cutoff !== undefined) set('knowledge_cutoff', meta.knowledge_cutoff);
    if (meta.license !== undefined) set('license', meta.license);
    if (meta.open_weights !== undefined) set('open_weights', meta.open_weights);
    if (meta.tokenizer !== undefined) set('tokenizer', meta.tokenizer);
    if (meta.temperature !== undefined) set('temperature', meta.temperature);
    if (meta.structured_output !== undefined) set('structured_output', meta.structured_output);
    if (meta.tool_call !== undefined) set('tool_call', meta.tool_call);
    if (meta.reasoning !== undefined) set('reasoning', meta.reasoning);
    if (meta.attachment !== undefined) set('attachment', meta.attachment);
    if (meta.aliases !== undefined) set('aliases', [...meta.aliases]);
    if (meta.retired !== undefined) set('retired', meta.retired);
    if (meta.supported_parameters !== undefined) {
      set('supported_parameters', [...meta.supported_parameters]);
    }

    // ---- 运行时字段：矩阵优先，低层只填空（见文件头）----
    // 模态与窗口/effort 一样是路由判据，所以同样只填空：models.dev 静态快照报的
    // `input_modalities` 可能与上游 `/models` 的运行时值不一致，让静态值覆盖运行时值
    // 正是本模块要避免的漂移（响应与路由必须同源）。
    if (meta.input_modalities !== undefined && record.input_modalities === undefined) {
      set('input_modalities', [...meta.input_modalities]);
    }
    if (meta.output_modalities !== undefined && record.output_modalities === undefined) {
      set('output_modalities', [...meta.output_modalities]);
    }
    if (meta.context_window !== undefined && record.context_window === undefined) {
      set('context_window', meta.context_window);
    }
    if (meta.max_output_tokens !== undefined && record.max_output_tokens === undefined) {
      set('max_output_tokens', meta.max_output_tokens);
    }
    if (meta.effort !== undefined && record.effort === undefined) {
      record.effort = mergeEffort(undefined, meta.effort);
      record.provenance.fields['effort'] = sourceId;
    }

    // ---- 结构字段：按子键合并（不是整体替换）----
    if (meta.benchmarks !== undefined) {
      record.benchmarks = { ...record.benchmarks, ...meta.benchmarks };
      record.provenance.fields['benchmarks'] = sourceId;
    }
    if (meta.per_request_limits !== undefined) {
      record.per_request_limits = { ...record.per_request_limits, ...meta.per_request_limits };
      record.provenance.fields['per_request_limits'] = sourceId;
    }
    if (meta.concurrency !== undefined) {
      record.concurrency = { ...record.concurrency, ...meta.concurrency };
      record.provenance.fields['concurrency'] = sourceId;
    }
    if (meta.pricing !== undefined) {
      record.pricing = mergePricing(record.pricing, meta.pricing);
      record.provenance.fields['pricing'] = sourceId;
    }
    if (meta.raw !== undefined) {
      record.raw = { ...record.raw, ...meta.raw };
      record.provenance.fields['raw'] = sourceId;
    }
    if (meta.constraints !== undefined) {
      record.constraints = mergeConstraints(record.constraints, meta.constraints);
      record.provenance.fields['constraints'] = sourceId;
    }
    if (meta.access_path_limits !== undefined) {
      this.applyAccessPathLimits(record, meta.access_path_limits, sourceId);
    }
  }

  /** 层给的按 access path 限额 → 合并进 `access_paths[]`。 */
  private applyAccessPathLimits(
    record: MutableRecord,
    limits: Record<string, AccessPathLimits>,
    sourceId: string,
  ): void {
    if (record.access_paths === undefined) return;
    record.access_paths = record.access_paths.map((path) => {
      const limit = limits[path.access_path];
      if (limit === undefined) return path;
      return {
        ...path,
        ...(limit.concurrency === undefined
          ? {}
          : { concurrency: { ...path.concurrency, ...limit.concurrency } }),
        ...(limit.cash_pricing === undefined ? {} : { cash_pricing: limit.cash_pricing }),
      };
    });
    // 记 `access_path_limits` 而不是 `access_paths`：access path 的**集合**来自能力
    // 矩阵（单一事实来源），这里补的只是限额，provenance 要精确到被补的那件事
    record.provenance.fields['access_path_limits'] = sourceId;
  }

  /** 派生字段：`created`（由 release_date 推导）与 `supported_parameters`（矩阵补集）。 */
  private applyDerived(record: MutableRecord, group: ModelContributions): void {
    if (record.release_date !== undefined) {
      const created = epochSecondsFromDate(record.release_date);
      if (created !== undefined) {
        record.created = created;
        // created 是 release_date 的派生值，来源跟着 release_date 走
        record.provenance.fields['created'] =
          record.provenance.fields['release_date'] ?? 'capability-matrix';
      }
    }

    const unsupported = new Set<string>();
    for (const entry of group.entries) {
      for (const field of entry.unsupported_fields ?? []) unsupported.add(field);
    }
    const declared = record.supported_parameters;
    const base = declared ?? [...CANONICAL_CHAT_PARAMS];
    record.supported_parameters = base.filter((p) => !unsupported.has(p));
    if (declared === undefined) {
      record.provenance.fields['supported_parameters'] = 'capability-matrix';
    }
  }

  /**
   * 派生 `modalities`：该记录全部 access path 的模态种类（去重、按序）。
   *
   * 为什么单独一个键而不是让调用方去读 `access_paths[].modality`：工具端点（asr / tts /
   * search / fetch / ocr）没有 `input_modalities` / `output_modalities` 可言，只有这个
   * 字段能把它们和 chat 模型区分开。而 `access_paths` 是重字段、默认不在列表里——
   * 把"怎么区分工具端点"的答案藏在默认不返回的结构里，等于没有答案。
   *
   * 与 `input_modalities` 是**两个词表**（text/image vs chat/asr），不互相覆盖：
   * 矩阵条目本身没有 input/output 模态字段时（音频端点就是），两个键各答各的。
   */
  private applyModalities(record: MutableRecord, group: ModelContributions): void {
    const seen: ModalityKind[] = [];
    for (const entry of group.entries) {
      if (!seen.includes(entry.modality)) seen.push(entry.modality);
    }
    if (seen.length === 0) return;
    record.modalities = seen;
    record.provenance.fields['modalities'] = 'capability-matrix';
  }

  /** `provenance.layers` / `stale` / `last_successful_fetch`。 */
  private applyProvenanceLayers(record: MutableRecord, group: ModelContributions): void {
    const layers: LayerStatus[] = [];
    let stale = false;
    let lastSuccess: number | undefined;
    let lastError: string | undefined;

    for (const source of this.sources) {
      const snapshot = this.snapshots.get(source.id);
      const error = this.loadErrors.get(source.id);
      layers.push({
        sourceId: source.id,
        layer: source.layer,
        contributed: group.contributions.some((c) => c.sourceId === source.id),
        ...(snapshot === undefined ? {} : { fetched_at: snapshot.fetchedAt }),
        ...(error === undefined ? {} : { error }),
      });
    }

    for (const state of this.upstreamStates()) {
      layers.push({
        sourceId: state.sourceId,
        layer: 'upstream',
        contributed: group.contributions.some((c) => c.sourceId === state.sourceId),
        ...(state.lastSuccessAt === undefined ? {} : { fetched_at: state.lastSuccessAt }),
        ...(state.stale ? { stale: true } : {}),
        ...(state.lastError === undefined ? {} : { error: state.lastError }),
      });
      if (state.stale) stale = true;
      if (state.lastSuccessAt !== undefined) {
        lastSuccess = Math.max(lastSuccess ?? 0, state.lastSuccessAt);
      }
      if (state.lastError !== undefined) lastError = state.lastError;
    }

    record.provenance.layers = layers;
    record.provenance.stale = stale;
    if (lastSuccess !== undefined) record.provenance.last_successful_fetch = lastSuccess;
    if (lastError !== undefined) record.provenance.last_error = lastError;

    // 配置层覆盖矩阵字段的记录（applyConfigOverrides 写入）
    const overridden = this.configOverriddenFields.get(record.id);
    if (overridden !== undefined) {
      for (const field of overridden) {
        record.provenance.fields[field] = 'config:local';
      }
    }
  }

  // -------------------------------------------------------------------------
  // 配置层 → 矩阵写回
  // -------------------------------------------------------------------------

  /**
   * 把配置层对**矩阵字段**的修正写回能力矩阵。
   *
   * 为什么需要写回：矩阵字段同时是路由判据。只在响应里改数字会让"客户端看到的窗口"与
   * "路由实际用的窗口"分叉，客户端按响应裁剪 prompt 仍会被上游拒。写回之后响应与路由
   * 同源，且 provenance 能标出"这个值是管理员改过的"。
   *
   * 只处理 `config` 层的来源；幂等（重复调用结果相同）。由 `ready()` 在来源加载完成
   * 后自动调用，也可以显式再调（测试用）。
   */
  applyConfigOverrides(): void {
    // 直接调方法而不是先把 register 解构出来：解构会丢 `this`（类方法依赖实例字段）
    if (this.capabilityRegistry.register === undefined) return;
    for (const source of this.sources) {
      if (source.layer !== 'config') continue;
      const snapshot = this.snapshots.get(source.id);
      if (snapshot === undefined) continue;
      for (const meta of snapshot.models) {
        const overridden = this.configOverriddenFields.get(meta.id) ?? new Set<string>();
        for (const entry of this.capabilityRegistry.list()) {
          if (entry.model !== meta.id) continue;
          const patch = configMatrixPatch(meta, entry);
          if (patch === undefined) continue;
          this.capabilityRegistry.register({ ...entry, ...patch });
          for (const key of Object.keys(patch)) overridden.add(key);
        }
        if (overridden.size > 0) this.configOverriddenFields.set(meta.id, overridden);
      }
    }
  }

  /** 测试/运维用：当前已加载的各层模型数。 */
  loadedSources(): Array<{ sourceId: string; layer: MetadataLayer; models: number }> {
    return this.sources.map((source) => ({
      sourceId: source.id,
      layer: source.layer,
      models: this.snapshots.get(source.id)?.models.length ?? 0,
    }));
  }
}

/** 配置层能修正的矩阵字段（其余矩阵字段是结构性的，改它等于改路由语义）。 */
function configMatrixPatch(
  meta: ModelMetadata,
  entry: CapabilityEntry,
): Partial<CapabilityEntry> | undefined {
  const patch: Partial<CapabilityEntry> = {};
  if (meta.context_window !== undefined && meta.context_window !== entry.context_window) {
    patch.context_window = meta.context_window;
  }
  if (meta.max_output_tokens !== undefined && meta.max_output_tokens !== entry.max_output_tokens) {
    patch.max_output_tokens = meta.max_output_tokens;
  }
  if (meta.input_modalities !== undefined) {
    patch.input_modalities = [...meta.input_modalities].filter(
      (m): m is 'text' | 'image' => m === 'text' || m === 'image',
    );
  }
  if (meta.effort !== undefined) {
    patch.effort = {
      supported_levels: [...meta.effort.levels],
      ...(meta.effort.default === undefined ? {} : { default_level: meta.effort.default }),
    };
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

// ---------------------------------------------------------------------------
// 合并 helper
// ---------------------------------------------------------------------------

function layerRank(layer: MetadataLayer): number {
  switch (layer) {
    case 'offline':
      return 0;
    case 'upstream':
      return 1;
    case 'config':
      return 2;
  }
}

function mergeEffort(base: EffortInfo | undefined, next: EffortInfo): EffortInfo {
  const levels = next.levels.length > 0 ? [...next.levels] : [...(base?.levels ?? [])];
  const fallbackDefault = next.default ?? base?.default;
  return {
    levels,
    ...(fallbackDefault === undefined ? {} : { default: fallbackDefault }),
  };
}

function mergeConstraints(
  base: ModelConstraint[] | undefined,
  next: ModelConstraint[],
): ModelConstraint[] {
  const out: ModelConstraint[] = [...(base ?? [])];
  for (const incoming of next) {
    const index = out.findIndex((c) => c.dialect === incoming.dialect);
    if (index === -1) {
      out.push({ ...incoming });
      continue;
    }
    // 同 dialect：值取新高（上层），语义文字补缺（只有声明方能给）
    out[index] = {
      ...out[index],
      ...incoming,
      semantics: { ...out[index].semantics, ...incoming.semantics },
    };
  }
  return out;
}

/** pricing 合并：rates 逐 slot 合并，tiers/rule_sets/holidays/as_api 取更高层。 */
function mergePricing(base: ModelPricing | undefined, next: ModelPricing): ModelPricing {
  if (base === undefined) return next;
  return {
    ...base,
    ...next,
    rates: { ...base.rates, ...next.rates },
    tiers: next.tiers.length > 0 ? next.tiers : base.tiers,
    rule_sets: next.rule_sets.length > 0 ? next.rule_sets : base.rule_sets,
    holidays: next.holidays ?? base.holidays,
    as_api_reference: next.as_api_reference ?? base.as_api_reference,
  };
}

// ---------------------------------------------------------------------------
// 过滤 / 排序
// ---------------------------------------------------------------------------

/** 一条记录是否命中查询。 */
export function matchesQuery(record: CanonicalModelRecord, query: ModelQuery): boolean {
  if (query.provider !== undefined && record.provider !== query.provider) return false;
  if (query.family !== undefined && record.family !== query.family) return false;
  if (query.modality !== undefined && query.modality.length > 0) {
    // 两个词表共用一个参数（见 ModelQuery.modality）：输入模态 + access path 模态种类。
    // 后者是工具端点（asr/tts/search/fetch/ocr）唯一的模态标识——它们没有输入模态。
    const inputs = (record.input_modalities ?? []) as string[];
    const kinds = (record.modalities ?? []) as string[];
    const pool = [...inputs, ...kinds];
    if (!query.modality.some((m) => pool.includes(m))) return false;
  }
  if (query.output_modality !== undefined && query.output_modality.length > 0) {
    const outputs = record.output_modalities ?? [];
    if (!query.output_modality.some((m) => (outputs as string[]).includes(m))) return false;
  }
  if (query.capability !== undefined && query.capability.length > 0) {
    if (!query.capability.every((c) => hasCapability(record, c))) return false;
  }
  if (query.parameter !== undefined && query.parameter.length > 0) {
    const supported = record.supported_parameters ?? [];
    if (!query.parameter.some((p) => supported.includes(p))) return false;
  }
  if (query.min_context_window !== undefined) {
    if ((record.context_window ?? 0) < query.min_context_window) return false;
  }
  if (query.max_context_window !== undefined) {
    if ((record.context_window ?? Number.POSITIVE_INFINITY) > query.max_context_window) {
      return false;
    }
  }
  if (query.min_output_tokens !== undefined) {
    if ((record.max_output_tokens ?? 0) < query.min_output_tokens) return false;
  }
  if (query.access_path !== undefined) {
    if (!(record.access_paths ?? []).some((p) => p.access_path === query.access_path)) return false;
  }
  if (query.format !== undefined) {
    if (!(record.access_paths ?? []).some((p) => p.format === query.format)) return false;
  }
  if (query.status !== undefined) {
    if (!(record.access_paths ?? []).some((p) => p.status === query.status)) return false;
  }
  if (query.license !== undefined && record.license !== query.license) return false;
  if (query.open_weights !== undefined && record.open_weights !== query.open_weights) return false;
  if (query.q !== undefined) {
    const needle = query.q.toLowerCase();
    const haystack = [record.id, record.name ?? '', record.description ?? '']
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/** 能力过滤的判据（与 models.dev 的布尔字段对应）。 */
function hasCapability(record: CanonicalModelRecord, capability: ModelCapability): boolean {
  switch (capability) {
    case 'reasoning':
      return record.reasoning === true || (record.effort?.levels.length ?? 0) > 0;
    case 'vision':
      return record.attachment === true || (record.input_modalities ?? []).includes('image');
    case 'tool_call':
      return record.tool_call === true;
    case 'structured_output':
      return record.structured_output === true;
    case 'temperature':
      return record.temperature === true;
    case 'attachment':
      return record.attachment === true;
    case 'streaming':
      return (record.access_paths ?? []).some((p) => (p.streaming?.mode ?? 'none') !== 'none');
  }
}

/** 排序（稳定：同键按 id 兜底，保证分页不抖）。 */
export function sortRecords(
  records: CanonicalModelRecord[],
  sort: string | undefined,
): CanonicalModelRecord[] {
  const keys = (sort ?? 'id')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
  for (const key of keys) {
    const field = key.startsWith('-') ? key.slice(1) : key;
    if (!SORT_KEYS.includes(field)) {
      throw new ModelQueryError(
        `不支持的排序键: ${field}（可用: ${[...SORT_KEYS].join(', ')}，加 - 前缀降序）`,
      );
    }
  }
  const compare = (a: CanonicalModelRecord, b: CanonicalModelRecord): number => {
    for (const key of keys) {
      const descending = key.startsWith('-');
      const field = descending ? key.slice(1) : key;
      const av = (a as unknown as Record<string, unknown>)[field];
      const bv = (b as unknown as Record<string, unknown>)[field];
      if (av === undefined && bv === undefined) continue;
      // 缺字段**恒排最后**，不随升降序翻转：降序排"窗口最大"时，没有窗口数据的模型
      // 该沉底，而不是因为取反飘到第一页（那会让调用方以为它窗口最大）
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      const diff = compareValues(av, bv);
      if (diff !== 0) return descending ? -diff : diff;
    }
    return a.id.localeCompare(b.id);
  };
  return [...records].sort(compare);
}

/** 同类型才比较；跨类型退化成字符串（排序是展示语义，不是数值计算）。 */
function compareValues(av: unknown, bv: unknown): number {
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'boolean' && typeof bv === 'boolean') return Number(av) - Number(bv);
  return String(av).localeCompare(String(bv));
}

/** 默认 provider 解析器：「点号前前缀」约定（`deepseek.openai-chat` → `deepseek`）。 */
function defaultProviderResolver(accessPath: string): string {
  return accessPath.split('.')[0] ?? accessPath;
}

/**
 * ISO date（或 `YYYY-MM` / `YYYY`）→ epoch **秒**。
 *
 * OpenAI 的 `created` 是 epoch 秒；我们没有"创建时间"这个一手数据，最近似的是
 * `release_date`（models.dev / 官方发布日）。推导关系写进 provenance，不冒充一手字段。
 */
function epochSecondsFromDate(value: string): number | undefined {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(value.trim());
  if (m === null) return undefined;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo ?? '01'}-${d ?? '01'}`;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** 按 RouteGraph 的 ability_mode（min 交集 / max 并集 / custom 自定义）聚合候选目标模型能力。 */
function synthesizeRouteGraphAbilities(
  graph: {
    nodes?: RouteGraph['nodes'];
    ability_mode?: RouteGraph['ability_mode'];
    abilities?: RouteGraph['abilities'];
  },
  records: readonly CanonicalModelRecord[],
): Partial<CanonicalModelRecord> {
  const mode = graph.ability_mode ?? 'min';
  const targets = (graph.nodes ?? []).filter(
    (n): n is Extract<RouteGraph['nodes'][number], { kind: 'provider_target' }> =>
      n.kind === 'provider_target',
  );
  const matched: CanonicalModelRecord[] = [];
  for (const t of targets) {
    const { provider, access_path, model } = t.target;
    const found =
      records.find(
        (r) =>
          (r.id === `${provider}/${model}` ||
            r.id === model ||
            r.id.endsWith(`/${model}`) ||
            (r.namespaced_ids?.includes(model) ?? false)) &&
          (r.access_paths === undefined ||
            r.access_paths.some((ap) => ap.access_path === access_path)),
      ) ??
      records.find(
        (r) =>
          r.id === `${provider}/${model}` ||
          r.id === model ||
          (r.namespaced_ids?.includes(model) ?? false),
      ) ??
      records.find((r) => r.provider === provider && r.id.endsWith(`/${model}`));
    if (found !== undefined) matched.push(found);
  }

  const computeAggregated = (useMax: boolean): Partial<CanonicalModelRecord> => {
    if (matched.length === 0) return {};
    const bools = (pick: (r: CanonicalModelRecord) => boolean | undefined): boolean | undefined => {
      const vals = matched.map(pick).filter((v): v is boolean => v !== undefined);
      if (vals.length === 0) return undefined;
      return useMax ? vals.some(Boolean) : vals.length === matched.length && vals.every(Boolean);
    };
    const numAgg = (pick: (r: CanonicalModelRecord) => number | undefined): number | undefined => {
      const vals = matched
        .map(pick)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (vals.length === 0) return undefined;
      return useMax ? Math.max(...vals) : Math.min(...vals);
    };
    const modalAgg = <T extends string>(
      pick: (r: CanonicalModelRecord) => readonly T[] | undefined,
    ): T[] | undefined => {
      const lists = matched.map(pick).filter((v): v is readonly T[] => v !== undefined && v.length > 0);
      if (lists.length === 0) return undefined;
      if (useMax) {
        return Array.from(new Set(lists.flat()));
      }
      if (lists.length < matched.length) return ['text' as T];
      const common = lists[0]!.filter((item) => lists.every((l) => l.includes(item)));
      return common.length > 0 ? Array.from(new Set(common)) : ['text' as T];
    };

    const tool_call = bools((r) => r.tool_call);
    const reasoning = bools((r) => r.reasoning);
    const structured_output = bools((r) => r.structured_output);
    const attachment = bools((r) => r.attachment);
    const context_window = numAgg((r) => r.context_window);
    const max_output_tokens = numAgg((r) => r.max_output_tokens);
    const input_modalities = modalAgg((r) => r.input_modalities);
    const output_modalities = modalAgg((r) => r.output_modalities);

    return {
      ...(tool_call === undefined ? {} : { tool_call }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(structured_output === undefined ? {} : { structured_output }),
      ...(attachment === undefined ? {} : { attachment }),
      ...(context_window === undefined ? {} : { context_window }),
      ...(max_output_tokens === undefined ? {} : { max_output_tokens }),
      ...(input_modalities === undefined ? {} : { input_modalities }),
      ...(output_modalities === undefined ? {} : { output_modalities }),
    };
  };

  if (mode === 'max') return computeAggregated(true);
  const base = computeAggregated(false);
  if (mode !== 'custom' || graph.abilities === undefined) return base;

  const custom = graph.abilities;
  return {
    ...base,
    ...(custom.tool_call === undefined ? {} : { tool_call: custom.tool_call }),
    ...(custom.reasoning === undefined ? {} : { reasoning: custom.reasoning }),
    ...(custom.structured_output === undefined ? {} : { structured_output: custom.structured_output }),
    ...(custom.attachment === undefined ? {} : { attachment: custom.attachment }),
    ...(custom.context_window === undefined ? {} : { context_window: custom.context_window }),
    ...(custom.max_output_tokens === undefined ? {} : { max_output_tokens: custom.max_output_tokens }),
    ...(custom.input_modalities === undefined ? {} : { input_modalities: custom.input_modalities }),
    ...(custom.output_modalities === undefined ? {} : { output_modalities: custom.output_modalities }),
  };
}
