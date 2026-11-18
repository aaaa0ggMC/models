/**
 * providers/openai-images/index.ts —— OpenAI Images provider 的出口。
 *
 * 目录说明（与 providers/deepseek/ 同构）：
 *   - wire.ts：canonical ↔ OpenAI Images wire 的**纯映射**（含 multipart 编码）；
 *   - client.ts：薄客户端（Transport + headersProvider 注入；非 2xx 分类）；
 *   - adaptor.ts：`ImageProviderAdaptor` 接口 + OpenAI 实现（「接入网关」那一层）；
 *   - pricing.ts / pricing.json：token 槽位价格表（无峰谷）。
 *
 * ⚠️ 未接真实上游：key 走 `AG_OPENAI_API_KEY` 环境变量，仓库里只有变量名。
 */

export {
  OPENAI_IMAGES_BASE_URL,
  OPENAI_IMAGES_GENERATIONS_PATH,
  OPENAI_IMAGES_EDITS_PATH,
  OpenAIImagesApiError,
  OpenAIImagesClient,
  type OpenAIImagesClientDeps,
  type ImagesUpstreamResponse,
} from './client.js';
export {
  encodeGenerateRequest,
  encodeEditRequest,
  encodeEditMultipart,
  decodeImagesResponse,
  type OpenAIImagesGenerateRequest,
  type OpenAIImagesEditRequest,
  type OpenAIImagesWireResponse,
  type EncodedMultipartRequest,
  type DecodedImagesResponse,
} from './wire.js';
export {
  OpenAIImagesAdaptor,
  type ImageProviderAdaptor,
  type ImageAdaptorOutcome,
  type ImageAdaptorOptions,
  type OpenAIImagesAdaptorDeps,
} from './adaptor.js';
export {
  loadOpenAIImagesPriceTables,
  openAIImagesPriceTableFor,
  createOpenAIImagesPricingService,
  type OpenAIImagesPriceTables,
  type OpenAIImagesPricingResult,
} from './pricing.js';
