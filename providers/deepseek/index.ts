/**
 * providers/deepseek/index.ts —— DeepSeek provider 的出口。
 *
 * 目录说明（架构）：`providers/<provider>/` 集中**单个上游 provider 的专有知识**
 * （端点路径、usage 字段映射、builtin tool 方言映射、模型清单、能力矩阵、quirks、
 * 独立端点 codec、模型发现、静态定价表）。它与 adaptors/ 的分工：adaptors/ 按
 * (FormatId, ModalityKind) 做**方言级**双向映射（一个实例服务所有同方言 access path）；
 * providers/ 按 access path 提供**provider 级**差异，经 di/ports.ts 的
 * ProviderProfile 端口注入 codec 与 S10。
 *
 * ⚠️ 待文档更新（不由本线程改，走 PR）：00-overview.md §4.2 的模块表还没有
 * `providers` 一行——本轮新增该模块需要仓库主人补文档。
 *
 * 再出口冲突处理：五个端点 codec 各自导出一份同名常量/类（DeepSeekApiError、
 * DEEPSEEK_DEFAULT_BASE_URL、encodeMultipartFormData），`export *` 会撞名。
 * 这里每个名字只从一个文件出口（单一事实来源），其余文件仍可从自身路径导入。
 */

export {
  DEEPSEEK_ACCESS_PATHS,
  DEEPSEEK_ACCESS_PATH_IDS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_OPENAI_CHAT_PATH,
  DEEPSEEK_ANTHROPIC_MESSAGES_PATH,
  DEEPSEEK_KEY_ENV,
  DEEPSEEK_MODELS,
  DEEPSEEK_MODEL_IDS,
  DEEPSEEK_CONTEXT_TOKENS,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_MODEL_META,
  // profile 与纯函数
  createDeepSeekProfile,
  deepseekCapabilities,
  deepseekRouteAliases,
  deepseekOpenAiUsageFromRaw,
  deepseekThinkingWire,
  normalizeDeepSeekEffort,
  type DeepSeekModelMeta,
} from './profile.js';

// ---- 模型发现（GET /models → 能力矩阵刷新）----
export {
  DEEPSEEK_MODELS_PATH,
  DeepSeekModelDiscovery,
  decodeModelsResponse,
  modelMetadataOverlay,
  staticModelMetadata,
  toMetadata,
  type CapabilityRegistryWriter,
  type DeepSeekModelMetadata,
  type DeepSeekModelsResponse,
  type DiscoveryRefreshResult,
} from './discovery.js';

// ---- 独立端点 codec（P1/P2：Search / Fetch / OCR / ASR / TTS）----
// 每个名字只从一个文件出口，避免 export * 撞名。
export {
  DeepSeekApiError,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_SEARCH_PATH,
  encodeSearchRequest,
  decodeSearchResponse,
  toSearchHits,
  toSearchResultParts,
  DeepSeekSearchClient,
  parseUpstreamErrorBody,
  throwIfNotOk,
  type DeepSeekSearchRequest,
  type DeepSeekSearchResult,
  type DeepSeekSearchResponse,
  type DeepSeekSearchClientDeps,
  type DeepSeekSearchOutcome,
  type SearchHit,
} from './search.js';
export {
  DEEPSEEK_FETCH_PATH,
  encodeFetchRequest,
  decodeFetchResponse,
  DeepSeekFetchClient,
  type DeepSeekFetchRequest,
  type DeepSeekFetchResponse,
  type DeepSeekFetchClientDeps,
  type DeepSeekFetchOutcome,
} from './fetch.js';
export {
  DEEPSEEK_OCR_PATH,
  DEEPSEEK_MULTIPART_BOUNDARY,
  sanitizeMultipartFilename,
  encodeMultipartFormData,
  encodeOcrRequest,
  decodeOcrResponse,
  buildOcrUsage,
  DeepSeekOcrClient,
  type DeepSeekOcrPurpose,
  type DeepSeekOcrRequest,
  type DeepSeekOcrResponse,
  type DeepSeekOcrPage,
  type DeepSeekOcrTokenUsage,
  type DeepSeekOcrClientDeps,
  type DeepSeekOcrOutcome,
  type EncodedMultipartRequest,
  type MultipartFileField,
  type MultipartTextField,
} from './ocr.js';
export {
  DEEPSEEK_ASR_PATH,
  encodeAsrRequest,
  decodeAsrResponse,
  buildAsrUsage,
  DeepSeekAsrClient,
  type DeepSeekAsrRequest,
  type DeepSeekAsrResponse,
  type DeepSeekAsrClientDeps,
  type DeepSeekAsrOutcome,
} from './asr.js';
export {
  DEEPSEEK_TTS_PATH,
  DEEPSEEK_TTS_DEFAULT_VOICE_ID,
  DEEPSEEK_TTS_DEFAULT_FORMAT,
  DEEPSEEK_TTS_DEFAULT_FILTER_MARKDOWN,
  CJK_BILLED_RANGES,
  billedCharCount,
  ttsMimeType,
  buildTtsUsage,
  encodeTtsRequest,
  decodeTtsResponse,
  DeepSeekTtsClient,
  type DeepSeekTtsVoiceId,
  type DeepSeekTtsFormat,
  type DeepSeekTtsRequest,
  type DeepSeekTtsWireResponse,
  type DecodedDeepSeekTtsResponse,
  type DeepSeekTtsClientDeps,
  type DeepSeekTtsOutcome,
} from './tts.js';

// ---- 定价（静态价格表 + 点时间解析 + 请求时计费服务）----
export {
  loadDeepSeekPriceTables,
  deepseekPriceTableFor,
  applyPricingRefresh,
  type DeepSeekPriceTables,
  type PricingRefreshProposal,
} from './pricing.js';
export {
  createDeepSeekPricingService,
  type PricingRequest,
  type PricingResult,
  type PricingService,
} from './pricing-service.js';

// ---- 余额查询与对账（实际扣费的真值源；只做区间级对账）----
export {
  DEEPSEEK_BALANCE_PATH,
  DeepSeekBalanceClient,
  decodeBalanceResponse,
  parseDecimalOrZero,
  type DeepSeekBalanceInfo,
  type DeepSeekBalanceResponse,
  type DeepSeekBalanceClientDeps,
  type DeepSeekBalanceSnapshot,
} from './balance.js';

// ---- 法定节假日日历（峰谷计费的节假日维度；按年维护，来源见 holidays.json）----
export { loadDeepSeekHolidayCalendars, type HolidayRefreshHint } from './holidays.js';

// ---- 模型目录元数据（/v1/models 的离线静态层 + 上游实时层）----
export {
  DEEPSEEK_CATALOG_SOURCE_ID,
  DEEPSEEK_UPSTREAM_SOURCE_ID,
  DEEPSEEK_RETIRED_MODELS,
  DEEPSEEK_CONSTRAINT_SEMANTICS,
  createDeepSeekCatalogSource,
  createDeepSeekUpstreamSource,
  deepseekCatalogMetadata,
  deepseekPricingFor,
  type DeepSeekCatalogSourceOptions,
  type DeepSeekUpstreamSourceOptions,
} from './catalog-metadata.js';
