/**
 * ir/format.ts —— 客户端/上游格式标识 `FormatId`。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §2.1。
 * 注意：此处**只登记格式 id**，不登记 adaptor 是否存在——adaptor 覆盖矩阵在三态
 * （已实现/计划/按需）由 capability 矩阵表达，见 ir/capability.ts。
 */

/** 入站/出站协议格式 id。多模态端点清单见 10 §2.1 与 15-modalities.md §8.1。 */
export type FormatId =
  // ---- chat 三件套（v1 写透）----
  | 'openai.chat' // POST /v1/chat/completions
  | 'openai.responses' // POST /v1/responses
  | 'anthropic.messages' // POST /v1/messages
  | 'gemini.generateContent' // POST /v1beta/models/{model}:generateContent
  // ---- 多模态端点（15-modalities.md §8.1）----
  | 'openai.audio.speech'
  | 'openai.audio.transcription'
  | 'openai.images.generations'
  | 'openai.images.edits'
  | 'openai.embeddings'
  | 'elevenlabs.tts'
  | 'azure.tts'
  | 'google.tts'
  | 'minimax.tts'
  | 'deepgram.listen'
  | 'assemblyai.transcript'
  | 'bflux.image'
  | 'stability.image'
  // ---- decision 品类（40 §6.2）----
  | 'gemini.decisions'
  | 'jev.decisions'
  | 'openai.decisions'
  | 'mock.decisions'
  // ---- 独立工具端点（DeepSeek 全家桶；按次/按页/按秒/按字符计费，非 chat）----
  // 这些不是 15 §8.1 的多模态 dialect，而是"上游一个 HTTP 端点"的标识：
  // `UsageRecord.provider_format` 要能说出这次调用打的是哪个端点，否则计量记录里
  // 只剩一个说不清来源的字符串。⚠️ 待文档更新：10-canonical-schema.md §2.1 的
  // 格式清单要补这五个 id（不由本线程改，走 PR）。
  | 'deepseek.tools.search'
  | 'deepseek.tools.fetch'
  | 'deepseek.tools.ocr'
  | 'deepseek.tools.asr'
  | 'deepseek.tools.tts';

/** chat 三件套：S0 格式识别与 fast path 判定最常打交道的子集。 */
export type ChatFormatId = 'openai.chat' | 'openai.responses' | 'anthropic.messages';

export const CHAT_FORMAT_IDS: readonly ChatFormatId[] = [
  'openai.chat',
  'openai.responses',
  'anthropic.messages',
];

export function isChatFormatId(value: string): value is ChatFormatId {
  return (CHAT_FORMAT_IDS as readonly string[]).includes(value);
}
