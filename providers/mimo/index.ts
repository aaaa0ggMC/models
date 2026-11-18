/**
 * providers/mimo/index.ts —— MiMo provider 的出口。
 *
 * 目录说明（架构）：`providers/<provider>/` 集中**单个上游 provider 的专有知识**
 * （端点路径、usage 字段映射、模型清单、能力矩阵、quirks、独立端点 codec、模型发现）。
 * 它与 adaptors/ 的分工：adaptors/ 按 (FormatId, ModalityKind) 做**方言级**双向映射
 * （一个实例服务所有同方言 access path）；providers/ 按 access path 提供
 * **provider 级**差异，经 di/ports.ts 的 ProviderProfile 端口注入 codec 与 S10。
 *
 * MiMo 与 DeepSeek 的组织方式对照：
 *   - `profile.ts` —— access path / 模型 / 端点 / key 环境变量 + ProviderProfile 实现；
 *   - `discovery.ts` —— `GET /models` 模型发现（MiMo 侧只补登 id，见该文件头）；
 *   - `audio.ts` —— TTS / ASR 的 wire codec + 薄客户端（**没有** search/fetch/ocr：
 *     MiMo 没有那三个端点，不建空壳）；
 *   - `audio-models.ts` —— 音频端点的能力条目与模型解析；
 *   - `audio-openai-face.ts` —— 音频端点的 OpenAI 入站脸（`AudioProviderFace` 实现）；
 *   - `tool-handlers.ts` —— 两个音频端点的 canonical ↔ wire 装配；
 *   - `pricing.json` / `pricing.ts` / `pricing-service.ts` —— 官方按量计费页的静态
 *     价格表 + 定价服务（LLM token 价 + ASR 按音频小时 + TTS 限时免费）；
 *   - `balance.ts` —— 官方计费/余量查询（Token Plan 积分与按量余额两个渠道，
 *     分别需要 `tp-` / `sk-` key，且挂在不同 host 上）。
 *
 * 再出口冲突处理：`audio.ts` 与 `audio-models.ts` 各有一个 `audioModelNamesFor` /
 * `resolveAudioModel`（同名不同域：一个管 provider 侧模型清单，一个管端点解析），
 * 所以 `export *` 不能用——这里显式点名每个名字的来源文件。
 */

// ---- 定价（静态价格表 + 定价服务；官方按量计费页）----
export {
  MIMO_TOKEN_PLAN_BASE_URL,
  MIMO_API_BASE_URL,
  MIMO_TOKEN_PLAN_PATH,
  MIMO_BALANCE_PATH,
  MiMoBalanceClient,
  MiMoBalanceError,
  decodeBalance,
  decodeTokenPlan,
  type MiMoBalanceClientDeps,
  type MiMoBalanceInfo,
  type MiMoBalanceResponse,
  type MiMoPlanPeriod,
  type MiMoPlanQuota,
  type MiMoTokenPlanInfo,
} from './balance.js';
export { loadMiMoPriceTables, mimoPriceTableFor, type MiMoPriceTables } from './pricing.js';
export {
  createMiMoPricingService,
  priceMiMoToolCall,
  type PricingRequest,
  type PricingResult,
} from './pricing-service.js';

export {
  MIMO_ACCESS_PATHS,
  MIMO_ACCESS_PATH_IDS,
  MIMO_BASE_URL,
  MIMO_CHAT_PATH,
  MIMO_KEY_ENV,
  MIMO_MODELS,
  MIMO_MODEL_IDS,
  MIMO_MODEL_META,
  createMiMoProfile,
  mimoCapabilities,
  mimoRouteAliases,
  type MiMoModelMeta,
} from './profile.js';

export {
  MIMO_MODELS_PATH,
  MiMoModelDiscovery,
  decodeModelsResponse,
  type MiMoModelMetadata,
  type MiMoModelsResponse,
  type DiscoveryRefreshResult,
  type CapabilityRegistryWriter,
} from './discovery.js';

export {
  MIMO_DEFAULT_BASE_URL,
  MIMO_AUDIO_PATH,
  MIMO_ASR_MODEL,
  MIMO_TTS_MODELS,
  MIMO_TTS_DEFAULT_FORMAT,
  MIMO_TTS_PRESET_VOICES,
  MiMoAudioError,
  MiMoAsrClient,
  MiMoTtsClient,
  asrMimeType,
  audioFormatFromFilename,
  buildAsrUsage,
  buildTtsUsage,
  decodeAsrResponse,
  decodeTtsResponse,
  encodeAsrRequest,
  encodeTtsRequest,
  throwIfAudioNotOk,
  ttsMimeType,
  type MiMoAsrAudioFormat,
  type MiMoAsrLanguage,
  type MiMoAsrRequest,
  type MiMoAsrResponse,
  type MiMoAsrOutcome,
  type MiMoAudioClientDeps,
  type MiMoTtsFormat,
  type MiMoTtsModel,
  type MiMoTtsOutcome,
  type MiMoTtsRequest,
  type MiMoTtsWireResponse,
  type DecodedMiMoTtsResponse,
} from './audio.js';

export {
  MIMO_AUDIO_ACCESS_PATHS,
  MIMO_AUDIO_MODELS,
  MIMO_AUDIO_DEFAULT_MODELS,
  MIMO_AUDIO_MODEL_ALIASES,
  mimoAudioCapabilities,
  resolveAudioModel as resolveMiMoAudioModel,
  audioModelNamesFor as mimoAudioModelNamesFor,
} from './audio-models.js';

export {
  MIMO_AUDIO_FACE,
  MIMO_ASR_LANGUAGES,
  OPENAI_TTS_RESPONSE_FORMATS as MIMO_OPENAI_TTS_RESPONSE_FORMATS,
  OPENAI_TRANSCRIPTION_RESPONSE_FORMATS as MIMO_OPENAI_TRANSCRIPTION_RESPONSE_FORMATS,
  OpenAiFaceError as MiMoOpenAiFaceError,
  decodeOpenAiSpeechRequest as decodeMiMoOpenAiSpeechRequest,
  decodeOpenAiTranscriptionFields as decodeMiMoOpenAiTranscriptionFields,
  encodeOpenAiSpeechResponse as encodeMiMoOpenAiSpeechResponse,
  encodeOpenAiTranscriptionResponse as encodeMiMoOpenAiTranscriptionResponse,
  resolveAsrLanguage,
  resolveMiMoVoice,
  resolveSpeechResponseFormat as resolveMiMoSpeechResponseFormat,
  resolveTranscriptionResponseFormat as resolveMiMoTranscriptionResponseFormat,
} from './audio-openai-face.js';

export { createMiMoToolHandlers, MIMO_TOOL_ENDPOINT_PATHS } from './tool-handlers.js';
export type { MiMoToolHandlerDeps, ToolEndpointHandler } from './tool-handlers.js';
export { ToolRequestError as MiMoToolRequestError } from './tool-handlers.js';
