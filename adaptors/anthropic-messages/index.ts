/**
 * adaptors/anthropic-messages/index.ts —— Anthropic Messages adaptor 的出口。
 *
 * 40 §1.3：注册是**显式的、集中在一个文件里**（adaptors/index.ts），不做魔法自动发现。
 * 因此这里只做"导出实现 + 导出元数据工厂"，不在本文件里自注册。
 */

export { AnthropicMessagesCodec, createAnthropicMessagesAdaptorMeta } from './codec.js';
export {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_STOP_REASONS,
  EFFORT_TO_BUDGET_TOKENS,
  FINISH_REASON_PROVIDER_KEY,
  PART_FRAME_NOTE_KEY,
  PASSTHROUGH_FRAME_NOTE_KEY,
  moveToolUseBlocksToEnd,
  normalizeThinkingEnabled,
} from './codec.js';
