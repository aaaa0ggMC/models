/**
 * adaptors/gemini-generate-content/index.ts —— Google Gemini `generateContent` adaptor 出口。
 *
 * 注册集中于 `adaptors/index.ts`（40 §1.3），本文件仅对外暴露 codec 类与 AdaptorMeta 工厂。
 */

export {
  GeminiGenerateContentCodec,
  geminiGenerateContentAdaptorMeta,
  parseGeminiPath,
  buildGeminiPath,
  type GeminiGenerateContentCodecDeps,
} from './codec.js';
