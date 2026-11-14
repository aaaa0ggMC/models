/**
 * catalog/index.ts —— canonical 模型目录模块的出口。
 *
 * 目录说明（架构）：`catalog/` 是**对外模型列表端点**（`GET /v1/models`）的单一事实来源，
 * 与 `providers/<provider>/` 的分工是——providers 提供单个上游的专有知识（含它贡献给
 * 目录的静态元数据），catalog 负责跨层合并、过滤排序与来源追溯。它不 import 任何
 * provider 实现（经 `ModelMetadataSource` 端口接入），也不做 HTTP、不定时。
 *
 * ⚠️ 待文档更新（不由本线程改，走 PR）：00-overview.md §4.2 的模块表还没有 `catalog`
 * 一行；§4.3 的端点形态还没有 `/v1/models` 与 `/v1/models/{id}`。
 */

export {
  ModelCatalog,
  matchesQuery,
  sortRecords,
  type AccessPathCredentialLister,
  type ModelCatalogOptions,
} from './registry.js';

export {
  ModelQueryError,
  SORT_KEYS,
  providerResolverFromRouteTable,
  type AccessPathCredential,
  type AccessPathInfo,
  type AccessPathLimits,
  type AccessPathProviderResolver,
  type AsApiReference,
  type CanonicalModelRecord,
  type CapabilityRegistryReader,
  type ConcurrencyInfo,
  type EffortInfo,
  type FieldSource,
  type HolidayCalendarRef,
  type InputModality,
  type LayerStatus,
  type MetadataLayer,
  type ModelCapability,
  type ModelConstraint,
  type ModelListResponse,
  type ModelMetadata,
  type ModelMetadataSnapshot,
  type ModelMetadataSource,
  type ModelPricing,
  type ModelProvenance,
  type ModelQuery,
  type OutputModality,
  type PerRequestLimits,
  type PriceRuleSetInfo,
  type PriceTier,
  type RetiredInfo,
  type RouteTableProviderHints,
  type UpstreamSnapshotProvider,
  type UpstreamSourceState,
} from './types.js';

export {
  MODELS_DEV_SOURCE_ID,
  createModelsDevSource,
  type ModelsDevSourceOptions,
} from './offline-models-dev.js';

export {
  ManualScheduler,
  ModelSyncService,
  systemTimerScheduler,
  type ModelSyncOptions,
  type ModelSyncReport,
  type TimerHandle,
  type TimerScheduler,
} from './sync.js';
