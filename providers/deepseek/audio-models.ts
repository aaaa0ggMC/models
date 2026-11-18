/**
 * providers/deepseek/audio-models.ts —— **音频端点**的能力条目与模型解析。
 *
 * 范围：`/v1/audio/speech`（TTS）与 `/v1/audio/transcriptions`（ASR）两个 OpenAI
 * 兼容入站脸背后的模型口径。它们与 canonical 的 `/v1/tools/{tts,asr}` 打的是**同一个
 * 上游 access path**（`deepseek.tools.tts` / `deepseek.tools.asr`），计量口径因此也
 * 完全复用（按字符 / 按音频秒），不为音频另造一套。
 *
 * ## 为什么单独一个文件而不是并进 profile.ts
 *
 * `deepseekCapabilities()` 有测试逐条断言「2 模型 × 2 dialect = 4 条，全部 chat」
 * （providers/deepseek/profile.test.ts）——那张表描述的是**推理路由**的能力矩阵。
 * 音频是独立工具端点（不进 S0–S10、没有 adaptor），混进去会让"矩阵里到底有几类能力"
 * 变得说不清。分开注册、分开断言，两边都能各自演进。
 *
 * ## 模型解析的优先级（与 admin/aliases.ts 的四档同源，不另造一套）
 *
 * ```text
 * 0. OpenAI 客户端模型名别名   tts-1 / tts-1-hd / gpt-4o-mini-tts → deepseek-tts
 *                              whisper-1 / gpt-4o-transcribe      → deepseek-asr
 * 1. exact      —— 显式别名（全串相等）
 * 2. namespace  —— <ns>/<model>，模型必须在该 provider 的 access path 上真实存在
 * 3. prefix     —— 前缀规则
 * 4. passthrough —— 原样 model id，但要求能力矩阵里真有这个 (access_path, model, modality)
 * ```
 *
 * 1–4 直接复用 `DefaultAliasResolver`（admin/aliases.ts），这里只做两件它不知道的事：
 * 按**端点**限定 access path（`deepseek-tts` 不能拿去打 ASR），以及第 0 档的
 * OpenAI 客户端名别名。解析不到 → 400 + 一句话（不静默落到某个默认模型上）。
 *
 * ## 与多上游抽象的关系
 *
 * `AudioEndpointId` / `AudioModelTarget` / `AudioModelResolverDeps` / `AudioModelError`
 * 的**定义**已移到 `http/audio-faces.ts`（那是 http 层的消费契约，DeepSeek 只是第一个
 * 实现）；本文件从那里再出口，既有 import 路径不变。DeepSeek 的 face 实现
 * （`DEEPSEEK_AUDIO_FACE`）在 audio-openai-face.ts。
 */

import type { CapabilityEntry, ModalityKind } from '../../ir/index.js';
import type { FormatId } from '../../ir/index.js';
import {
  AudioModelError,
  type AudioEndpointId,
  type AudioModelResolverDeps,
  type AudioModelTarget,
} from '../../http/audio-faces.js';

/** 从 http/audio-faces.ts 再出口（定义已移到那里；本文件的既有 import 路径不变）。 */
export {
  AudioModelError,
  type AudioEndpointId,
  type AudioModelResolverDeps,
  type AudioModelTarget,
};

/** 音频端点的 access path（= 计量口径，与 canonical 工具端点一字不差）。 */
export const DEEPSEEK_AUDIO_ACCESS_PATHS: Readonly<Record<AudioEndpointId, string>> = {
  tts: 'deepseek.tools.tts',
  asr: 'deepseek.tools.asr',
};

/** 音频端点的模型 id（客户端可直接用这个名字）。 */
export const DEEPSEEK_AUDIO_MODELS: Readonly<Record<AudioEndpointId, string>> = {
  tts: 'deepseek-tts',
  asr: 'deepseek-asr',
};

/** 端点 → 客户端格式（UsageRecord.client_format 用；两个 id 都已在 ir/format.ts 登记）。 */
export const AUDIO_CLIENT_FORMATS: Readonly<Record<AudioEndpointId, FormatId>> = {
  tts: 'openai.audio.speech',
  asr: 'openai.audio.transcription',
};

/**
 * OpenAI 客户端模型名 → 我们的音频模型名。
 *
 * 为什么要有这一档：OpenAI SDK 的 `audio.speech.create({model:'tts-1'})` 与
 * `audio.transcriptions.create({model:'whisper-1'})` 是写死在文档里的用法，要求用户
 * 先改成 `deepseek-tts` 才能用等于"几乎不能用"。映射成网关侧模型名后，客户端零
 * 修改即可打进来。
 *
 * 它**不是**别名规则表（那条路归管理面）：这是客户端方言层的便利映射，最终目标仍要
 * 过能力矩阵验证（见 resolveAudioModel 的第 3 步）。
 */
export const OPENAI_AUDIO_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'tts-1': DEEPSEEK_AUDIO_MODELS.tts,
  'tts-1-hd': DEEPSEEK_AUDIO_MODELS.tts,
  'gpt-4o-mini-tts': DEEPSEEK_AUDIO_MODELS.tts,
  'whisper-1': DEEPSEEK_AUDIO_MODELS.asr,
  'gpt-4o-transcribe': DEEPSEEK_AUDIO_MODELS.asr,
  'gpt-4o-mini-transcribe': DEEPSEEK_AUDIO_MODELS.asr,
};

/** 某个端点上「客户端可能打的模型名」全集（错误信息里列给用户看）。 */
export function audioModelNamesFor(endpoint: AudioEndpointId): string[] {
  const canonical = DEEPSEEK_AUDIO_MODELS[endpoint];
  const aliases = Object.entries(OPENAI_AUDIO_MODEL_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([name]) => name);
  return [canonical, ...aliases];
}

/**
 * 解析音频端点的 `model` 字段。解析不到抛 `AudioModelError`（短到能塞进一行）。
 *
 * **为什么按端点限定 access path**：`deepseek-tts` 与 `deepseek-asr` 是两个不同的
 * (access_path, modality) 条目。不限定的话，一条指向 ASR 的别名会被 `/v1/audio/speech`
 * 接受，然后拿着 ASR 的模型去打 TTS 上游——那种错在 trace 里看起来一切正常。
 *
 * 多上游装配下 http 层调的是 `face.resolveModel`（不认时返回 undefined 好让下一家试）；
 * 本函数保留抛错形态，因为它是单一上游时的直接入口（测试与既有调用方都用它）。
 */
export function resolveAudioModel(
  deps: AudioModelResolverDeps,
  model: string,
  endpoint: AudioEndpointId,
): AudioModelTarget {
  const accessPath = DEEPSEEK_AUDIO_ACCESS_PATHS[endpoint];
  if (model.trim() === '') {
    throw new AudioModelError('缺少字段 model（应为非空字符串）');
  }

  // ---- 第 0 档：OpenAI 客户端模型名别名 ----
  const alias =
    OPENAI_AUDIO_MODEL_ALIASES[model] ?? OPENAI_AUDIO_MODEL_ALIASES[model.toLowerCase()];
  if (alias !== undefined && alias === DEEPSEEK_AUDIO_MODELS[endpoint]) {
    return { provider: 'deepseek', access_path: accessPath, model: alias, source: 'openai-alias' };
  }

  // ---- 第 1–4 档：既有的别名/namespace/前缀/passthrough 解析 ----
  const resolved = deps.aliasResolver?.resolve(model, endpoint as ModalityKind);
  if (resolved !== undefined && resolved.target.access_path === accessPath) {
    return {
      provider: resolved.target.provider,
      access_path: accessPath,
      model: resolved.target.model,
      source: resolved.source,
    };
  }

  // ---- 兜底：直接查能力矩阵（没有管理面装配时走这条）----
  const entry = deps.capabilities.find(accessPath, model, endpoint as ModalityKind);
  if (entry !== undefined) {
    return { provider: 'deepseek', access_path: accessPath, model, source: 'matrix' };
  }

  throw new AudioModelError(
    `模型 ${model} 解析不到：本端点可用 ${audioModelNamesFor(endpoint).join(' / ')}`,
  );
}

// ---------------------------------------------------------------------------
// 能力条目
// ---------------------------------------------------------------------------

/**
 * 音频端点的能力矩阵条目（默认装配注册；见 composition-root 的 defaultCapabilities）。
 *
 * `streaming: {mode:'none'}` 是**事实陈述**不是未实现声明：DeepSeek TTS 的流式是
 * WebSocket 模式（providers/deepseek/tts.ts 文件头），本轮的 OpenAI 入站脸明确不做
 * 流式；ASR 上游则完全没有流式。
 */
export function deepseekAudioCapabilities(): CapabilityEntry[] {
  return [
    {
      access_path: DEEPSEEK_AUDIO_ACCESS_PATHS.tts,
      model: DEEPSEEK_AUDIO_MODELS.tts,
      modality: 'tts',
      format: 'openai.audio.speech',
      streaming: { mode: 'none' },
      usage_source: 'provider',
      usage_units: ['characters'],
      quirks: [
        '上游 POST /v1/tools/tts；网关侧两个入口：/v1/tools/tts（canonical）与 /v1/audio/speech（OpenAI 形状）',
        '上游只有 wav / pcm 两种输出：mp3 / opus / aac / flac 明确拒绝，不静默转码',
        '上游 voice_id 只有 stella（女声）/ tide（男声）；OpenAI 嗓音名按官方描述的性别就近映射，不是音色克隆',
        '上游无变速（speed）与语音指令（instructions）参数',
        '按计费字符计费：中文字符按 2，其他按 1（providers/deepseek/tts.ts）',
      ],
      contract_tested: true,
      status: 'implemented',
    },
    {
      access_path: DEEPSEEK_AUDIO_ACCESS_PATHS.asr,
      model: DEEPSEEK_AUDIO_MODELS.asr,
      modality: 'asr',
      format: 'openai.audio.transcription',
      streaming: { mode: 'none' },
      usage_source: 'provider',
      usage_units: ['audio_seconds'],
      quirks: [
        '上游 POST /v1/tools/asr，multipart 只有一个 file 字段',
        '音频按内容探测：16-bit PCM WAV 或 Ogg Opus；≤8 MiB、上传 ≤10 min、时长 ≤120s',
        '上游不返回分段 / 置信度 / 语种：verbose_json 的 segments 恒为空数组，language 省略',
        '上游 wire 没有 language / prompt / temperature：这些参数到不了上游（语种自动检测）',
        '按音频时长计费，duration_ms 是唯一依据（providers/deepseek/asr.ts）',
      ],
      contract_tested: true,
      status: 'implemented',
    },
  ];
}
