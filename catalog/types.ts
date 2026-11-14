/**
 * catalog/types.ts —— canonical 模型目录（`GET /v1/models`）的类型与端口。
 *
 * ## 这个模块解决什么问题
 *
 * 客户端（OpenAI SDK / LiteLLM / 自研前端）习惯一问「你有哪些模型、各自什么参数」。
 * 上游**没有**一个端点能回答这个问题：DeepSeek 的 `GET /models` 只给窗口/模态/
 * effort/行为约束（且价格明确不在里面），models.dev 给静态字段（family / 发布日期 /
 * 知识截止 / 温度与结构化输出支持）但不给运行时约束，我们自己的修正（上游写错了、
 * 目录漏了）只在仓库配置里。所以答案是**分层合并**出来的一份 canonical 记录。
 *
 * ## 分层优先级（低 → 高）
 *
 * 1. `offline`：离线目录（vendored models.dev 快照）+ provider 静态表
 *    （`providers/<provider>/catalog-metadata.ts`：价格/并发/supported_parameters…）。
 *    没有网络、没有 key 时也能答。
 * 2. `upstream`：上游实时发现（DeepSeek `GET /models`）。**运行时真值**——窗口/模态/
 *    effort/constraints 以上游为准。
 * 3. `config`：本地配置覆盖（管理员修正）。优先级最高，用于纠正上游或离线目录的错误。
 *
 * 每一层经 `ModelMetadataSource` 端口接入（DI 注入，不硬编码 HTTP）；合并时**逐字段**
 * 记录来源（`provenance.fields`），所以「这个数字是谁说的」永远可查——这是本模块与
 * 「直接转发上游 /models」的本质区别。
 *
 * ## 与能力矩阵的关系（单一事实来源）
 *
 * `ir/capability.ts` 的 `CapabilityEntry` 是**机读运行时字段的唯一事实来源**：
 * `access_paths[]`、`unsupported_parameters`、`constraints` 的值、模态、窗口、effort
 * 全部从能力矩阵读（`providers/deepseek/discovery.ts` 的刷新也写回矩阵）。本模块只在
 * 矩阵之上补静态/价格/限额元数据，**不另写一份窗口或约束**——否则 discovery 刷新后
 * 两边立刻漂移。
 *
 * ## 响应形状
 *
 * 默认是 OpenAI 兼容形状（`{object:"list", data:[{id, object:"model", created,
 * owned_by}]}`）+ 附加扩展字段（OpenRouter 运行时 + models.dev 静态 + 我们的独有项
 * `constraints` / `pricing` / `access_paths` / `provenance`）。扩展字段是**加键**不是
 * 改键：真实 OpenAI SDK 客户端按已知键取值，多余键被忽略（有官方 SDK 的 drop-in 测试
 * 兜底，见 tests/models-openai-sdk.test.ts）。
 */

import type {
  CapabilityEntry,
  CapabilityStatus,
  FormatId,
  ModalityKind,
  UsageSourceKind,
} from '../ir/index.js';

// ---------------------------------------------------------------------------
// 模态与参数
// ---------------------------------------------------------------------------

/** 输入模态（比能力矩阵的 `'text'|'image'` 宽：models.dev 还报 pdf 等）。 */
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'document';

/** 输出模态。 */
export type OutputModality = 'text' | 'image' | 'audio' | 'video';

/** 能力标签（过滤用；与 models.dev 的布尔字段一一对应）。 */
export type ModelCapability =
  | 'reasoning'
  | 'vision'
  | 'tool_call'
  | 'structured_output'
  | 'temperature'
  | 'streaming'
  | 'attachment';

// ---------------------------------------------------------------------------
// 分层来源端口
// ---------------------------------------------------------------------------

/** 分层种类（优先级低 → 高）。 */
export type MetadataLayer = 'offline' | 'upstream' | 'config';

/**
 * 元数据来源（**端口**）。
 *
 * 为什么是端口而不是直接 import：三层的数据来源完全不同（vendored JSON / HTTP 上游 /
 * 部署配置），且测试要能整体替换任一层（例如让「上游层」返回一份假 /models）。端口化
 * 之后 `ModelCatalog` 不知道 HTTP、不知道文件系统、不知道 models.dev 的存在。
 *
 * 约束（与其他端口一致）：不读 `process.env`、不起模块级单例；失败时 `load()` 抛错，
 * 由同步层决定降级（端点绝不能因为某一层挂了而失败）。
 */
export interface ModelMetadataSource {
  /** 稳定 id，进 `provenance`（如 `offline:models.dev` / `upstream:deepseek`）。 */
  readonly id: string;
  /** 所属层。 */
  readonly layer: MetadataLayer;
  /** 该来源覆盖的 provider（缺省 = 不限定，按记录里的 provider 字段归位）。 */
  readonly providers?: readonly string[];
  /** 取出该来源能提供的元数据。 */
  load(): Promise<ModelMetadataSnapshot>;
}

/** 一次加载的产物。 */
export interface ModelMetadataSnapshot {
  /** 来源 id（= ModelMetadataSource.id）。 */
  sourceId: string;
  /** 加载完成时刻（epoch ms；离线来源 = 文件读取时刻）。 */
  fetchedAt: number;
  models: ModelMetadata[];
}

/**
 * 单模型元数据贡献（**层产物**，全部字段可选）。
 *
 * 语义：这里出现的每个键都会被合并进 canonical 记录并在 `provenance.fields` 里记下
 * 来源；没出现的键**不参与**（不是"设成 undefined"——省略与置空是两回事，
 * 见 ir/usage.ts 的 R2 同立场）。
 */
export interface ModelMetadata {
  /** 上游 model id（canonical 记录的 `id`）。 */
  id: string;
  /** provider（`owned_by`）。缺省由来源的 `providers` 或调用方推断。 */
  provider?: string;
  name?: string;
  description?: string;
  family?: string;
  /** ISO date（"YYYY-MM-DD"）。 */
  release_date?: string;
  /** 知识截止（models.dev 的 `knowledge`，形态不一：`"2025-05"` / `"2025-07-31"`）。 */
  knowledge_cutoff?: string;
  /** 许可证（models.dev 只有 `open_weights` 布尔；两家都给时以字符串为准）。 */
  license?: string;
  /** 是否开放权重（models.dev `open_weights`）。 */
  open_weights?: boolean;
  /** 分词器标识（当前上游/models.dev 均不提供，字段留给将来源头）。 */
  tokenizer?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: InputModality[];
  output_modalities?: OutputModality[];
  /** 该模型支持的请求参数（canonical 参数名，如 `params.temperature`）。 */
  supported_parameters?: string[];
  /** models.dev 的能力布尔（同时是 `ModelCapability` 过滤的判据）。 */
  temperature?: boolean;
  structured_output?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  effort?: EffortInfo;
  benchmarks?: Record<string, number>;
  per_request_limits?: PerRequestLimits;
  concurrency?: ConcurrencyInfo;
  constraints?: ModelConstraint[];
  pricing?: ModelPricing;
  /** 按 access path 的限额补充（与能力矩阵推导出的 `access_paths[]` 合并）。 */
  access_path_limits?: Record<string, AccessPathLimits>;
  /** 路由别名（不含退役别名——那些走 `retired`）。 */
  aliases?: string[];
  /** 已退役别名/模型的说明（详情端点据此解释 404）。 */
  retired?: RetiredInfo;
  /** 上游原字段 passthrough（各层浅合并，后写者覆盖同键）。 */
  raw?: Record<string, unknown>;
}

/** thinking effort 档位与默认值（OpenRouter 的 `supported_parameters` 同源）。 */
export interface EffortInfo {
  levels: string[];
  default?: string;
}

/** 单请求限额（OpenRouter `per_request_limits` 的对应物）。 */
export interface PerRequestLimits {
  /** 单次请求最大输入 token（= context_window - max_output_tokens，可被层覆盖）。 */
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_images?: number;
}

/** 并发限额（官方价格页口径；两条 dialect 可能不同，故可按 access path 给）。 */
export interface ConcurrencyInfo {
  max_concurrent_requests?: number;
  /** 数据来源说明（如 "官方价格页" / "上游 /models"）。 */
  source?: string;
}

/**
 * 上游按 (model, dialect) 声明的行为约束。
 *
 * 值来自能力矩阵（`CapabilityEntry.constraints`，单一事实来源），`semantics` 的官方
 * 语义文字只有声明方（provider 专有知识）能给——所以两者分开合并：值取最高优先级层，
 * 文字由低层补缺。
 */
export interface ModelConstraint {
  /** 该约束作用的 dialect（wire 格式）。 */
  dialect: FormatId | string;
  system_prompt_update?: 'leading-only' | 'in-history';
  tool_update?: 'leading-only' | 'addition-only';
  semantics?: {
    system_prompt_update?: string;
    tool_update?: string;
  };
  source?: 'upstream-declared' | 'observed';
}

/** 按 access path 的限额补充（层产物）。 */
export interface AccessPathLimits {
  concurrency?: ConcurrencyInfo;
  /** 该路径的计费口径（订阅路径 cash 恒 0，as_api 照算）。 */
  cash_pricing?: 'api' | 'subscription' | 'free';
  /** 该路径可用的模态（缺省 = 与模型一致）。 */
  modalities?: ModalityKind[];
}

/** 退役信息（详情端点据此把 404 解释清楚）。 */
export interface RetiredInfo {
  retired_at: string;
  note: string;
  /** 退役后由哪个模型接管（上游常做静默重路由，见 DeepSeek 实测）。 */
  succeeded_by?: string;
}

// ---------------------------------------------------------------------------
// 价格（独有字段：多单位费率 + 峰谷 tiers + as_api 参考）
// ---------------------------------------------------------------------------

/**
 * canonical 价格描述。
 *
 * 与 `metering/pricing.ts` 的 `PriceTable` 的对应关系：`rates` / `tiers` /
 * `rule_sets` 就是把 `PriceEntry` + `PriceWindow` + `PriceRuleSet` 原样搬过来
 * （价格不在上游 /models 里，已核实无任何官方 API 提供峰谷规则或实时价格，唯一来源
 * 是官方价格页 → 仓库内静态表）。这里**不重算**任何数字，只做可解释的展示。
 */
export interface ModelPricing {
  currency: string;
  /** 如 "USD per 1M tokens"（人类可读声明，解析器不读它）。 */
  unit: string;
  table_version: string;
  source_url: string;
  /** ISO date-time。 */
  fetched_at: string;
  /** 多单位费率：`{slot: 每单位美元价}`。token slot 单位是每 1M tokens。 */
  rates: Record<string, number>;
  /** 分层费率（峰谷时段窗口）。 */
  tiers: PriceTier[];
  /** 规则集生效区间（峰谷规则本身也会改，如 DeepSeek 2026-08-17 / 2026-08-23 两次）。 */
  rule_sets: PriceRuleSetInfo[];
  /** 节假日日历引用（节假日全天低谷是窗口规则的另一半）。 */
  holidays?: HolidayCalendarRef;
  /**
   * as_api 参考价（60-billing §4.1 双口径）：订阅路径现金恒 0，但等值 API 用量照算，
   * 否则订阅请求在成本报表里"消失"。这里给出参考费率与哪些路径按订阅计。
   */
  as_api_reference?: AsApiReference;
  /** 独立工具端点的按次/按字符单价（slot 名不是通用 slot，见 pricing.ts 文件头）。 */
  tools?: Record<string, number>;
}

/** 一个时段窗口的费率档位。 */
export interface PriceTier {
  tier: string;
  /** "HH:mm" 当日时刻（含），按 tz 解释。 */
  start: string;
  /** "HH:mm" 当日时刻（不含）；end <= start 表示跨零点。 */
  end: string;
  /** IANA 时区（时区换算必须用 Intl，禁止手算 UTC+8）。 */
  tz: string;
  days_of_week?: number[];
  /** 排除的 ISO 日期（法定节假日）。 */
  exclude_dates?: string[];
  rates: Record<string, number>;
}

/** 一整套时段窗口的生效区间。 */
export interface PriceRuleSetInfo {
  effective_from: string;
  effective_to?: string;
  tiers: PriceTier[];
}

/** 节假日日历引用（表本身按年维护，不参与算法推算）。 */
export interface HolidayCalendarRef {
  year: number;
  source: string;
  /** 放假的 ISO 日期（含调休连休）。 */
  holidays: string[];
  /** 调休上班的周末日期。 */
  workdays: string[];
}

/** as_api 参考价。 */
export interface AsApiReference {
  rates: Record<string, number>;
  /** 按订阅计费的 access path（现金恒 0，as_api 照算）。 */
  subscription_paths: string[];
  note: string;
}

// ---------------------------------------------------------------------------
// canonical 记录（响应主体）
// ---------------------------------------------------------------------------

/** 字段来源（`provenance.fields` 的值）。 */
export type FieldSource = string;

/** 每个模型的来源分层记录。 */
export interface ModelProvenance {
  /** 本记录的组装时刻（epoch ms）。 */
  assembled_at: number;
  /**
   * 逐字段来源：`{ "context_window": "upstream:deepseek", "family": "offline:models.dev" }`。
   * 没有出现的字段 = 没有任何一层提供（不是"值为空"）。
   */
  fields: Record<string, FieldSource>;
  /** 各层的状态（离线层是否可用、上游层是否 stale）。 */
  layers: LayerStatus[];
  /**
   * 上游层是否过期：`now - last_successful_fetch > ttl`。**端点在上游挂掉时仍然返回
   * last-known-good**，只是打上这个标记 + `last_successful_fetch`，让调用方能看出来。
   */
  stale: boolean;
  /** 上游层最后一次成功拉取的时刻（从未成功 = undefined）。 */
  last_successful_fetch?: number;
  /** 上游层最后一次错误（不写进日志以外的任何地方；仅用于运维排障）。 */
  last_error?: string;
}

/** 单层状态。 */
export interface LayerStatus {
  sourceId: string;
  layer: MetadataLayer;
  /** 该层是否贡献了本模型的字段。 */
  contributed: boolean;
  /** 该层最后一次成功加载时刻（离线层 = 文件读取时刻）。 */
  fetched_at?: number;
  stale?: boolean;
  error?: string;
}

/** 一个 access path 上的可用性与限额（从能力矩阵推导 + 层补充）。 */
export interface AccessPathInfo {
  access_path: string;
  provider: string;
  /** 该路径的 wire 格式（dialect）。 */
  format: FormatId | string;
  modality: ModalityKind;
  status: CapabilityStatus;
  contract_tested: boolean;
  streaming?: CapabilityEntry['streaming'];
  usage_source: UsageSourceKind;
  /** 计量单位（能力矩阵 `usage_units` 原样，如 `["tokens"]`）。 */
  usage_units?: string[];
  /** 该路径不支持的 canonical 字段（能力矩阵 `unsupported_fields` 原样）。 */
  unsupported_parameters?: string[];
  quirks?: string[];
  constraints?: ModelConstraint[];
  concurrency?: ConcurrencyInfo;
  credential?: AccessPathCredential;
  cash_pricing?: 'api' | 'subscription' | 'free';
}

/** 该路径的凭据形态（API key / 订阅 OAuth / 无需凭据）。 */
export interface AccessPathCredential {
  kind: 'api-key' | 'subscription-oauth' | 'none';
  /** 已登记凭据的类型（来自 CredentialResolver，不含明文）。 */
  types?: string[];
  /** 凭据数量（不含明文，只报"有几条可用"）。 */
  available?: number;
}

/**
 * canonical 模型记录（`/v1/models` 的 data[] 元素 / `/{id}` 的响应体）。
 *
 * OpenAI 兼容键（`id` / `object` / `created` / `owned_by`）**永远存在或明确缺失**，
 * 其余全是可加不可改的扩展键。
 */
export interface CanonicalModelRecord {
  id: string;
  object: 'model';
  /** epoch **秒**（OpenAI 口径）。由 `release_date` 推导，缺源则省略。 */
  created?: number;
  owned_by: string;
  provider: string;

  name?: string;
  description?: string;
  family?: string;
  release_date?: string;
  knowledge_cutoff?: string;
  license?: string;
  open_weights?: boolean;
  tokenizer?: string;

  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: InputModality[];
  output_modalities?: OutputModality[];
  supported_parameters?: string[];

  temperature?: boolean;
  structured_output?: boolean;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  effort?: EffortInfo;
  benchmarks?: Record<string, number>;
  per_request_limits?: PerRequestLimits;
  concurrency?: ConcurrencyInfo;

  constraints?: ModelConstraint[];
  pricing?: ModelPricing;
  access_paths?: AccessPathInfo[];
  aliases?: string[];
  retired?: RetiredInfo;

  /** 上游原字段 passthrough。 */
  raw?: Record<string, unknown>;
  provenance: ModelProvenance;
}

// ---------------------------------------------------------------------------
// 目录（合并 + 查询）
// ---------------------------------------------------------------------------

/** access path → provider 的解析器（缺省用「点号前前缀」约定）。 */
export type AccessPathProviderResolver = (accessPath: string) => string;

/**
 * 从路由表推 provider 的结构化入参（**不 import** gateway-core，用结构类型匹配）。
 *
 * 为什么不直接用「点号前前缀」约定：`deepseek.openai-chat` → `deepseek` 对，但
 * `mock-anthropic` → `mock-anthropic` 就错了（真实 provider 是 `mock`）。路由表是
 * 唯一同时知道这两条映射的配置，所以从它推。
 */
export interface RouteTableProviderHints {
  readonly aliases: Record<
    string,
    { readonly targets: ReadonlyArray<{ readonly access_path: string; readonly provider: string }> }
  >;
}

/** 由路由表构造 provider 解析器（查不到回落到点号前缀约定）。 */
export function providerResolverFromRouteTable(
  table: RouteTableProviderHints,
): AccessPathProviderResolver {
  const byAccessPath = new Map<string, string>();
  for (const alias of Object.values(table.aliases)) {
    for (const target of alias.targets) {
      if (!byAccessPath.has(target.access_path))
        byAccessPath.set(target.access_path, target.provider);
    }
  }
  return (accessPath: string) =>
    byAccessPath.get(accessPath) ?? accessPath.split('.')[0] ?? accessPath;
}

/** 目录查询参数（`GET /v1/models` 的 query）。 */
export interface ModelQuery {
  /** `owned_by` / provider。 */
  provider?: string;
  family?: string;
  /** 输入模态过滤（任一命中即算）。 */
  modality?: string[];
  output_modality?: string[];
  /** 能力过滤（全部命中才算，如 `reasoning,vision`）。 */
  capability?: ModelCapability[];
  /** 支持的参数过滤（任一命中即算，如 `params.temperature`）。 */
  parameter?: string[];
  min_context_window?: number;
  max_context_window?: number;
  min_output_tokens?: number;
  access_path?: string;
  format?: string;
  status?: CapabilityStatus;
  license?: string;
  open_weights?: boolean;
  /** 是否把已退役模型也列出来（默认 false：退役别名不在列表里）。 */
  include_retired?: boolean;
  /** id / name / description 的子串搜索。 */
  q?: string;
  /** 排序键，`-` 前缀表示降序。 */
  sort?: string;
  limit?: number;
  offset?: number;
}

/** 查询解析失败（HTTP 层映射成 400）。 */
export class ModelQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelQueryError';
  }
}

/** `/v1/models` 的列表响应（OpenAI 兼容 + 扩展键）。 */
export interface ModelListResponse {
  object: 'list';
  data: CanonicalModelRecord[];
  /** 分页信息（仅在传了 limit/offset 时出现）。 */
  has_more?: boolean;
  total?: number;
}

/** 排序键 → 比较函数（未登记的键由调用方报错）。 */
export const SORT_KEYS: ReadonlyArray<string> = [
  'id',
  'name',
  'provider',
  'context_window',
  'max_output_tokens',
  'release_date',
  'family',
];

// ---------------------------------------------------------------------------
// 上游快照提供者（目录与同步服务的接缝）
// ---------------------------------------------------------------------------

/**
 * 上游层的当前状态（由同步服务实现，目录只读）。
 *
 * 为什么目录不自己持有上游快照：周期性拉取、TTL、容错都是**同步服务**的职责；目录只负责
 * "此刻有哪些元数据可用"。这样测试可以单独测同步（假时钟 + 假 scheduler），也可以单独
 * 测合并（直接塞一份快照进去）。
 */
export interface UpstreamSnapshotProvider {
  states(): UpstreamSourceState[];
}

/** 单个上游来源的状态。 */
export interface UpstreamSourceState {
  sourceId: string;
  layer: MetadataLayer;
  /** **last-known-good** 快照（拉取失败时保留上一份；从未成功 = undefined）。 */
  snapshot?: ModelMetadataSnapshot;
  /** 是否过期（now - lastSuccessAt > ttl）。 */
  stale: boolean;
  lastSuccessAt?: number;
  lastError?: string;
}

/** 目录读能力矩阵用的**最小接口**（不 import 具体实现，避免反向依赖）。 */
export interface CapabilityRegistryReader {
  list(modality?: ModalityKind): CapabilityEntry[];
}
