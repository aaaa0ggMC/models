/**
 * providers/gemini/index.ts —— Google Gemini 原生模态 adaptor（图像生成/编辑 + Embeddings）出口。
 */

export {
  GeminiImagesAdaptor,
  GeminiImagesApiError,
  GEMINI_IMAGES_BASE_URL,
  sizeToGeminiAspectRatio,
  isImagenModel,
  type GeminiImagesAdaptorDeps,
} from './images.js';
export {
  GeminiEmbeddingsAdaptor,
  GeminiEmbeddingsApiError,
  GEMINI_EMBEDDINGS_BASE_URL,
  type GeminiEmbeddingsAdaptorDeps,
} from './embeddings.js';
