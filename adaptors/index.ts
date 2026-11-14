/**
 * adaptors/index.ts —— adaptor 的**集中显式注册处**。
 *
 * 40 §1.3 原文：「注册是显式的、集中在一个文件里（adaptors/index.ts），不做魔法自动发现——
 * 自动发现会让"哪些 adaptor 真的被测过"变得不可审查。」
 *
 * 覆盖矩阵三态（40 §5）：已实现 / 计划 / 按需。`status: "planned"` 只允许存在于当前
 * Phase 的交付物清单里；不在当前 Phase 的一律 `on-demand`——防止 roadmap 膨胀成饼。
 * 因此这里只登记 v1 写透的三个 chat adaptor 中**已实现**的两个（openai.chat 与
 * anthropic.messages）；`openai.responses` 与 `gemini.generateContent` 在矩阵里标
 * planned/on-demand，但**不在这里注册**（没实现的 adaptor 注册进来只会制造"看起来支持"的假象）。
 */

import type { Adaptor, AdaptorMeta, AdaptorRegistry } from './types.js';
import { InMemoryAdaptorRegistry } from './registry.js';
import { OpenAIChatCodec, openAIChatAdaptorMeta } from './openai-chat/index.js';
import {
  AnthropicMessagesCodec,
  createAnthropicMessagesAdaptorMeta,
} from './anthropic-messages/index.js';
import type { Clock, Logger } from '../di/ports.js';

export interface AdaptorBundle {
  registry: AdaptorRegistry;
  /** 全部已注册 adaptor 的元数据（能力矩阵/文档用）。 */
  metas: AdaptorMeta[];
}

/**
 * 装配全部已实现的 adaptor。
 *
 * `clock` 由组合根注入——adaptor 内部不自己造时钟（禁止隐式全局状态）。
 */
export function createAdaptorRegistry(deps: { clock: Clock; logger?: Logger }): AdaptorBundle {
  const registry = new InMemoryAdaptorRegistry();
  const metas: AdaptorMeta[] = [];

  const register = (adaptor: Adaptor, meta: AdaptorMeta): void => {
    registry.register(adaptor, meta);
    metas.push(meta);
  };

  // meta 由各 codec 目录里的工厂产出，避免"注册处抄一份、codec 抄一份"的两处漂移
  // （40 §1.3：注册集中在这里，但**内容**的单一来源在 codec 侧）。
  register(new OpenAIChatCodec(deps), openAIChatAdaptorMeta());
  register(new AnthropicMessagesCodec(deps), createAnthropicMessagesAdaptorMeta());

  return { registry, metas };
}
