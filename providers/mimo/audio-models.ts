/**
 * providers/mimo/audio-models.ts —— **MiMo 音频端点**的能力条目与模型解析。
 *
 * 范围：`/v1/audio/speech`（TTS）与 `/v1/audio/transcriptions`（ASR）两个 OpenAI
 * 兼容入站脸背后的模型口径。它们与 canonical 的 `/v1/tools/{tts,asr}` 打的是**同一个
 * 上游 access path**（`mimo.tools.tts` / `mimo.tools.asr`），计量口径因此也完全复用
 * （按字符 / 按音频秒），不为音频另造一套——与 DeepSeek 侧同款立场。
 *
 * ## 模型口径：客户端直接用上游模型 id
 *
 * MiMo 的 TTS 是**一个模型族三个变体**（`mimo-v2.5-tts` 预置音色 / `-voiceclone` 音色克隆
 * / `-voicedesign` 音色设计），三者的 wire 差异在消息结构与 `audio.voice` 的取值上
 * （providers/mimo/audio.ts 的 encodeTtsRequest）。因此这里不像 DeepSeek 那样收成单个
 * `mimo-tts` 名字，而是让客户端**直接打上游 id**——变体选择本来就是请求的一部分，
 * 藏起来反而要让客户端猜。
 *
 * 便利别名只有两个（`mimo-tts` / `mimo-asr`），指向默认变体。
 *
 * ## 为什么没有 OpenAI 客户端名别名
 *
 * DeepSeek 的脸把 `tts-1` / `whisper-1` 映射到自己的模型（第 0 档）。MiMo **不映射**：
 * 那两个名字已被 DeepSeek 认领，同一家网关里两个上游抢一个客户端名会让"打 tts-1 到底
 * 去了哪家"取决于注册顺序——那是配置错误该由管理员改渠道，不该由网关猜。
 */

import type { CapabilityEntry } from '../../ir/index.js';
import type { ModalityKind } from '../../ir/index.js';
import {
  AudioModelError,
  type AudioEndpointId,
  type AudioModelResolverDeps,
  type AudioModelTarget,
} from '../../http/audio-faces.js';
import { MIMO_ASR_MODEL, MIMO_TTS_MODELS } from './audio.js';

/** MiMo 音频端点的 access path（= 计量口径）。 */
export const MIMO_AUDIO_ACCESS_PATHS: Readonly<Record<AudioEndpointId, string>> = {
  tts: 'mimo.tools.tts',
  asr: 'mimo.tools.asr',
};

/** 端点 → 该端点上游可用的模型 id（顺序即文档列举顺序）。 */
export const MIMO_AUDIO_MODELS: Readonly<Record<AudioEndpointId, readonly string[]>> = {
  tts: [MIMO_TTS_MODELS.base, MIMO_TTS_MODELS.voiceclone, MIMO_TTS_MODELS.voicedesign],
  asr: [MIMO_ASR_MODEL],
};

/** 端点 → 默认模型（解析前就失败时记账用；也是便利别名的目标）。 */
export const MIMO_AUDIO_DEFAULT_MODELS: Readonly<Record<AudioEndpointId, string>> = {
  tts: MIMO_TTS_MODELS.base,
  asr: MIMO_ASR_MODEL,
};

/** 便利别名（短名 → 上游 id）。**不含** `tts-1` / `whisper-1`，理由见文件头。 */
export const MIMO_AUDIO_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'mimo-tts': MIMO_TTS_MODELS.base,
  'mimo-asr': MIMO_ASR_MODEL,
};

/** 某个端点上「客户端可能打的模型名」全集（错误信息里列给用户看）。 */
export function audioModelNamesFor(endpoint: AudioEndpointId): string[] {
  const aliases = Object.entries(MIMO_AUDIO_MODEL_ALIASES)
    .filter(([, target]) => MIMO_AUDIO_MODELS[endpoint].includes(target))
    .map(([name]) => name);
  return [...MIMO_AUDIO_MODELS[endpoint], ...aliases];
}

/** 该模型是否属于某个端点（能力矩阵与解析共用；大小写不敏感）。 */
function isModelOnEndpoint(model: string, endpoint: AudioEndpointId): boolean {
  const lower = model.toLowerCase();
  return MIMO_AUDIO_MODELS[endpoint].some((m) => m.toLowerCase() === lower);
}

/**
 * 解析音频端点的 `model` 字段。解析不到抛 `AudioModelError`（短到能塞进一行）。
 *
 * 三档（比 DeepSeek 少两档，因为 MiMo 没有前缀规则可抄）：
 *   0. 便利别名   `mimo-tts` / `mimo-asr` → 上游 id
 *   1. exact      显式上游模型 id（大小写不敏感：上游 id 全小写，客户端从文档抄时
 *                 偶尔会带上大写）
 *   2. 管理面     别名/namespace 解析（`mimo/mimo-v2.5-tts` 之类），且必须落在
 *                 MiMo 的 access path 上
 *   3. 兜底       直接查能力矩阵（没有管理面装配时走这条）
 */
export function resolveAudioModel(
  deps: AudioModelResolverDeps,
  model: string,
  endpoint: AudioEndpointId,
): AudioModelTarget {
  const accessPath = MIMO_AUDIO_ACCESS_PATHS[endpoint];
  if (model.trim() === '') {
    throw new AudioModelError('缺少字段 model（应为非空字符串）');
  }

  // ---- 第 0 档：便利别名 ----
  const alias = MIMO_AUDIO_MODEL_ALIASES[model] ?? MIMO_AUDIO_MODEL_ALIASES[model.toLowerCase()];
  if (alias !== undefined) {
    return { provider: 'mimo', access_path: accessPath, model: alias, source: 'openai-alias' };
  }

  // ---- 第 1 档：上游模型 id 原样认 ----
  if (isModelOnEndpoint(model, endpoint)) {
    const canonical =
      MIMO_AUDIO_MODELS[endpoint].find((m) => m.toLowerCase() === model.toLowerCase()) ?? model;
    return { provider: 'mimo', access_path: accessPath, model: canonical, source: 'exact' };
  }

  // ---- 第 2 档：管理面别名 / namespace 解析 ----
  const resolved = deps.aliasResolver?.resolve(model, endpoint as ModalityKind);
  if (resolved !== undefined && resolved.target.access_path === accessPath) {
    return {
      provider: resolved.target.provider,
      access_path: accessPath,
      model: resolved.target.model,
      source: resolved.source,
    };
  }

  // ---- 第 3 档：能力矩阵兜底 ----
  const entry = deps.capabilities.find(accessPath, model, endpoint as ModalityKind);
  if (entry !== undefined) {
    return { provider: 'mimo', access_path: accessPath, model, source: 'matrix' };
  }

  throw new AudioModelError(
    `模型 ${model} 解析不到：本端点可用 ${audioModelNamesFor(endpoint).join(' / ')}`,
  );
}

// ---------------------------------------------------------------------------
// 能力条目
// ---------------------------------------------------------------------------

const TTS_QUIRKS = [
  '上游没有独立 REST 端点：POST /v1/chat/completions，按 model 分发（/v1/audio/* 全 404）',
  '音频在响应的 choices[0].message.audio.data（base64），不是音频字节流',
  'assistant 消息 = 合成文本；voicedesign 变体的 user 消息 = 音色设计描述（必填）',
  '上游无变速（speed）与语音指令（instructions，voicedesign 变体除外）参数',
  'canonical 的 filter_markdown 不发：MiMo 没有这个参数（DeepSeek 专有）',
  '按字符计量：上游价格页对 TTS 系列标「限时免费」且无 CJK 加权规则，网关侧 1 字符 = 1',
];

const ASR_QUIRKS = [
  '上游没有独立 REST 端点：POST /v1/chat/completions，按 model 分发',
  '音频走 input_audio content part（data URL + format 双字段，二者必须匹配）',
  '仅支持 mp3 / wav 两种容器；≤8 MiB 之外的限额上游未文档化',
  'asr_options.language 只认 auto / zh / en（默认 auto）；prompt 到不了上游',
  '上游不返回分段 / 置信度 / 检测到的语种：verbose_json 的 segments 恒为空数组，language 省略',
  'usage.seconds 是音频时长（秒），按音频小时计费（¥0.5/h），是计费唯一依据',
];

/**
 * MiMo 音频端点的能力矩阵条目（默认装配注册；见 composition-root 的 defaultCapabilities）。
 *
 * `streaming: {mode:'none'}` 是**事实陈述**不是未实现声明：上游的 `stream:true` 只对
 * chat 文本文档化（TTS 文档说 stream 时 format 默认 pcm，但响应信封未文档化），本轮
 * 的 OpenAI 入站脸明确不做流式——不为一个没探明的形状写实现。
 */
export function mimoAudioCapabilities(): CapabilityEntry[] {
  return [
    ...MIMO_AUDIO_MODELS.tts.map((model) => ({
      access_path: MIMO_AUDIO_ACCESS_PATHS.tts,
      model,
      modality: 'tts' as const,
      format: 'openai.audio.speech' as const,
      streaming: { mode: 'none' as const },
      usage_source: 'provider' as const,
      usage_units: ['characters' as const],
      quirks: [
        ...(model === MIMO_TTS_MODELS.voiceclone
          ? ['voiceclone 变体：audio.voice 必填且只接受音频样本的 data URL（mp3/wav）']
          : []),
        ...(model === MIMO_TTS_MODELS.voicedesign
          ? ['voicedesign 变体：user 消息必填（音色设计描述），不接受 audio.voice']
          : []),
        ...TTS_QUIRKS,
      ],
      contract_tested: true,
      status: 'implemented' as const,
    })),
    ...MIMO_AUDIO_MODELS.asr.map((model) => ({
      access_path: MIMO_AUDIO_ACCESS_PATHS.asr,
      model,
      modality: 'asr' as const,
      format: 'openai.audio.transcription' as const,
      streaming: { mode: 'none' as const },
      usage_source: 'provider' as const,
      usage_units: ['audio_seconds' as const],
      quirks: ASR_QUIRKS,
      contract_tested: true,
      status: 'implemented' as const,
    })),
  ];
}
