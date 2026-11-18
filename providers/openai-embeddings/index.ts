/**
 * providers/openai-embeddings/index.ts —— OpenAI 兼容 embeddings provider 的出口。
 *
 * ⚠️ 未接真实上游：DeepSeek 无 embeddings 端点（官方 API reference 已核实），
 * key 走 `AG_OPENAI_API_KEY` 环境变量，仓库里只有变量名。
 */

export {
  OPENAI_EMBEDDINGS_BASE_URL,
  OPENAI_EMBEDDINGS_PATH,
  OpenAIEmbeddingsApiError,
  OpenAIEmbeddingsAdaptor,
  type EmbeddingProviderAdaptor,
  type EmbeddingAdaptorOutcome,
  type EmbeddingAdaptorOptions,
  type OpenAIEmbeddingsAdaptorDeps,
} from './adaptor.js';
export {
  encodeEmbeddingsRequest,
  decodeEmbeddingsResponse,
  type OpenAIEmbeddingsRequest,
  type OpenAIEmbeddingsWireResponse,
  type DecodedEmbeddingResponse,
} from './wire.js';
