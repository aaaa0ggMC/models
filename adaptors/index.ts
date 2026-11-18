/**
 * adaptors/index.ts —— adaptor 的**集中显式注册处**。
 *
 * 40 §1.3 原文：「注册是显式的、集中在一个文件里（adaptors/index.ts），不做魔法自动发现——
 * 自动发现会让"哪些 adaptor 真的被测过"变得不可审查。」
 *
 * 覆盖矩阵三态（40 §5）：已实现 / 计划 / 按需。`status: "planned"` 只允许存在于当前
 * Phase 的交付物清单里；不在当前 Phase 的一律 `on-demand`——防止 roadmap 膨胀成饼。
 *
 * 2026-11-16（42-openai-responses-access.md §5.2 期一）：`openai.responses` 的**客户端脸**
 * 已落地，因此这里从「故意不注册」改为**显式注册**——文件头上半段的纪律不变（没实现的
 * adaptor 仍然不注册），只是 `openai.responses` 不再是「没实现」。同一 FormatId 的
 * **provider 脸**（B，期二）不在本文件体现：B 复用这个 codec，provider 差异进
 * `ProviderProfile`（42 §1.3 第 0 条），不需要第二个 codec。
 * `gemini.generateContent` 仍然是「没实现」，继续不注册。
 */

import type { Adaptor, AdaptorMeta, AdaptorRegistry } from './types.js';
import { InMemoryAdaptorRegistry } from './registry.js';
import { OpenAIChatCodec, openAIChatAdaptorMeta } from './openai-chat/index.js';
import {
  AnthropicMessagesCodec,
  createAnthropicMessagesAdaptorMeta,
} from './anthropic-messages/index.js';
import { OpenAIResponsesCodec, openAIResponsesAdaptorMeta } from './openai-responses/index.js';
import type { Clock, Logger, ProviderProfileRegistry } from '../di/ports.js';
import type { CapabilityEntry } from '../ir/index.js';

export interface AdaptorBundle {
  registry: AdaptorRegistry;
  /** 全部已注册 adaptor 的元数据（能力矩阵/文档用）。 */
  metas: AdaptorMeta[];
}

/**
 * 装配全部已实现的 adaptor。
 *
 * `clock` 由组合根注入——adaptor 内部不自己造时钟（禁止隐式全局状态）。
 * `providerProfiles` 同样由组合根注入（可缺省）：两个 chat codec 按 access path
 * 查 profile 拿 provider 专有映射（端点路径 / builtin tool / thinking 形态），
 * 见 di/ports.ts 的 ProviderProfile。没有 profile 时 codec 行为与历史版本一致。
 * `capabilityRegistry`（可缺省）供 anthropic codec 读**上游声明的行为约束**
 * （DeepSeek /models 的 api_capabilities：system_prompt_update / tool_update）并执行。
 */
export function createAdaptorRegistry(deps: {
  clock: Clock;
  logger?: Logger;
  providerProfiles?: ProviderProfileRegistry;
  capabilityRegistry?: {
    find(
      accessPath: string,
      model: string,
      modality: 'chat',
    ): Pick<CapabilityEntry, 'constraints'> | undefined;
  };
}): AdaptorBundle {
  const registry = new InMemoryAdaptorRegistry();
  const metas: AdaptorMeta[] = [];

  const register = (adaptor: Adaptor, meta: AdaptorMeta): void => {
    registry.register(adaptor, meta);
    metas.push(meta);
  };

  // meta 由各 codec 目录里的工厂产出，避免"注册处抄一份、codec 抄一份"的两处漂移
  // （40 §1.3：注册集中在这里，但**内容**的单一来源在 codec 侧）。
  register(new OpenAIChatCodec(deps), openAIChatAdaptorMeta());
  register(
    new AnthropicMessagesCodec({
      clock: deps.clock,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.providerProfiles === undefined ? {} : { providerProfiles: deps.providerProfiles }),
      ...(deps.capabilityRegistry === undefined
        ? {}
        : { capabilityRegistry: deps.capabilityRegistry }),
    }),
    createAnthropicMessagesAdaptorMeta(),
  );
  // openai.responses 的客户端脸（42 §5.2 期一）。`providerProfiles` 同样注入：B 期
  // `deepseek.openai-responses` 走这条 access path 时，端点路径 / builtin tool 形态
  // 由 profile 决定，codec 本身不按 provider 分支。
  register(
    new OpenAIResponsesCodec({
      clock: deps.clock,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.providerProfiles === undefined ? {} : { providerProfiles: deps.providerProfiles }),
    }),
    openAIResponsesAdaptorMeta(),
  );

  return { registry, metas };
}
