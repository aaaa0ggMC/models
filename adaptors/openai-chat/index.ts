/**
 * adaptors/openai-chat/index.ts —— OpenAI Chat Completions adaptor 的出口。
 *
 * 注册是**显式的、集中在一个文件里**（adaptors/index.ts，40 §1.3），不做魔法自动发现——
 * 自动发现会让「哪些 adaptor 真的被测过」变得不可审查。本文件只负责把 codec 与它的
 * AdaptorMeta 工厂暴露给组合根。
 */

export { OpenAIChatCodec, openAIChatAdaptorMeta, type OpenAIChatCodecDeps } from './codec.js';
