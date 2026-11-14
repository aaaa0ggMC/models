/**
 * ir/index.ts —— AG-IR canonical 类型的唯一出口。
 *
 * 其他模块（adaptors / gateway-core / metering / plugins …）**只能从这里 import**，
 * 不允许跨模块直接 import 某个具体实现文件，也不允许在 ir/ 之外重复定义同名类型
 * （review #3 用 tsc 抓到过 `ModalityKind` / `BuiltinTool.name` / `CapabilityEntry` 三处漂移，
 * 统一成本目录下的唯一定义）。
 */

export * from "./format.js";
export * from "./json-schema.js";
export * from "./error.js";
export * from "./diagnostic.js";
export * from "./media.js";
export * from "./usage.js";
export * from "./chat.js";
export * from "./decision.js";
export * from "./tts.js";
export * from "./asr.js";
export * from "./image.js";
export * from "./embedding.js";
export * from "./rerank.js";
export * from "./moderation.js";
export * from "./video.js";
export * from "./modality.js";
export * from "./stream.js";
export * from "./capability.js";
export * from "./credential.js";
export * from "./trace.js";
export * from "./context.js";
export * from "./plugin.js";
export * from "./clock.js";
export * from "./guards.js";
export * from "./envelope.js";
