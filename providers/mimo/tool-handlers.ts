/**
 * providers/mimo/tool-handlers.ts —— MiMo 两个音频端点的 **canonical 往返**装配。
 *
 * 分工（与 DeepSeek 侧同款）：
 *   - `audio.ts`：**wire codec + 薄客户端**（上游长什么样、怎么编解码、按什么单位计费），
 *     它不知道 canonical 的存在；
 *   - **本文件**：canonical ↔ wire 的双向映射（客户端 JSON → canonical → wire；
 *     上游响应 → canonical → 客户端 JSON）+ 端点路由元数据；
 *   - `http/tools-endpoint.ts` / `http/audio-endpoint.ts`：HTTP 层的鉴权、分发、
 *     错误信封、计量落库。
 *
 * ## 路径为什么带 provider 前缀
 *
 * DeepSeek 的五个 canonical 工具端点占着 `/v1/tools/{search,fetch,ocr,asr,tts}`。
 * MiMo 的 tts/asr **不能复用**这两个路径：`createToolEndpoints` 按 path 建 Map，
 * 同路径后注册的会被静默 shadow——那种"配了但不生效"正是仓库反复要避免的失败模式。
 * 因此 MiMo 的 canonical 脸走 `/v1/tools/mimo/{tts,asr}`，`list()` 里两条都在，
 * 管理员看得见。OpenAI 脸（`/v1/audio/speech`、`/v1/audio/transcriptions`）则由
 * `http/audio-endpoint.ts` 按模型名分流到对应 provider，无此冲突。
 *
 * ## 计费口径
 *
 * | 端点 | 上游计费 | canonical units | 说明 |
 * |---|---|---|---|
 * | tts | 价格页标「限时免费」，无字符规则 | `characters: {input, billed}` | 网关侧按合成文本字符数 1:1 记，不做 CJK 加权 |
 * | asr | ¥0.5 / 音频小时 | `audio_seconds: {input, billed}` | `usage.seconds` 是唯一依据 |
 */

import { Buffer } from 'node:buffer';
import type { CanonicalToolRequest } from '../../ir/index.js';
import { ToolRequestError, type ToolEndpointHandler } from '../../http/tools-endpoint.js';
import {
  MiMoAsrClient,
  MiMoTtsClient,
  audioFormatFromFilename,
  type MiMoTtsModel,
} from './audio.js';
import { MIMO_AUDIO_ACCESS_PATHS, MIMO_AUDIO_DEFAULT_MODELS } from './audio-models.js';
import { MIMO_ACCESS_PATHS } from './profile.js';

export { ToolRequestError, type ToolEndpointHandler };

/** 两个 handler 的构造依赖（横切能力全部注入；无模块级单例）。 */
export interface MiMoToolHandlerDeps {
  asr: MiMoAsrClient;
  tts: MiMoTtsClient;
}

const ASR_PATH = '/v1/tools/mimo/asr';
const TTS_PATH = '/v1/tools/mimo/tts';

/** 两个端点的装配（顺序即文档里的列举顺序）。 */
export function createMiMoToolHandlers(deps: MiMoToolHandlerDeps): ToolEndpointHandler[] {
  return [asrHandler(deps), ttsHandler(deps)];
}

// ---------------------------------------------------------------------------
// 请求体读取小工具（不猜：缺字段/类型错一律 400，不落默认值）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ToolRequestError('请求体必须是 JSON 对象');
  }
  return v as Record<string, unknown>;
}

function reqStr(body: Record<string, unknown>, key: string, max = 8192): string {
  const v = body[key];
  if (typeof v !== 'string' || v === '') {
    throw new ToolRequestError(`缺少字段 ${key}（应为非空字符串）`);
  }
  if (v.length > max) throw new ToolRequestError(`字段 ${key} 超过 ${max} 字符`);
  return v;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolRequestError(`字段 ${key} 应为字符串`);
  return v;
}

/** 读 base64 文件字段（**严格的 base64 校验**：坏 base64 会让上游收到乱码文件）。 */
function reqFile(
  body: Record<string, unknown>,
  key: string,
): { filename: string; content_type: string; data_base64: string } {
  const v = body[key];
  const rec = asRecord(v);
  const data_base64 = reqStr(rec, 'data_base64', 32 * 1024 * 1024);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data_base64) || data_base64.length % 4 !== 0) {
    throw new ToolRequestError(`字段 ${key}.data_base64 不是合法 base64`);
  }
  const content_type = reqStr(rec, 'content_type', 128);
  // filename 可选：OpenAI 脸只给 {data_base64, content_type}（它没有文件名概念），
  // canonical 工具脸给全三样。缺省时按 MIME 推一个——**不猜容器**，认不出就抛。
  const filename = optStr(rec, 'filename') ?? filenameForMime(content_type, `字段 ${key}`);
  return { filename, content_type, data_base64 };
}

/** MIME → 一个能通过 `audioFormatFromFilename` 的文件名（认不出抛错，不猜）。 */
function filenameForMime(contentType: string, field: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'reference.mp3';
  if (lower.includes('wav')) return 'reference.wav';
  throw new ToolRequestError(
    `${field} 的 content_type 认不出音频容器（只支持 audio/mpeg 与 audio/wav）`,
  );
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

function asrHandler(deps: MiMoToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'asr',
    path: ASR_PATH,
    provider: 'mimo',
    access_path: MIMO_AUDIO_ACCESS_PATHS.asr,
    // 计费判据去 chat 那条 path 上问（凭据登记在那里；同一把 key、同一个账号）
    billing_access_path: MIMO_ACCESS_PATHS.openaiChat,
    decodeRequest(body) {
      const rec = asRecord(body);
      const req: CanonicalToolRequest = {
        endpoint: 'asr',
        audio: reqFile(rec, 'audio'),
        raw: {},
      };
      const language = optStr(rec, 'language');
      if (language !== undefined) req.language = language;
      const prompt = optStr(rec, 'prompt');
      if (prompt !== undefined) req.prompt = prompt;
      return req;
    },
    async run(req) {
      if (req.endpoint !== 'asr') throw new ToolRequestError('端点不匹配');
      // 容器格式从 filename 推；推不出就抛（上游只认 mp3/wav，猜一个容器等于说谎）
      const format = audioFormatFromFilename(req.audio.filename);
      const outcome = await deps.asr.transcribe({
        file: Buffer.from(req.audio.data_base64, 'base64'),
        filename: req.audio.filename,
        format,
        ...(req.language === undefined ? {} : { language: req.language as 'auto' | 'zh' | 'en' }),
      });
      return {
        endpoint: 'asr',
        text: outcome.text,
        duration_seconds: outcome.seconds,
        usage: outcome.usage,
        raw: {},
      };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'asr') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.asr.result',
        text: res.text,
        ...(res.duration_seconds === undefined ? {} : { duration_seconds: res.duration_seconds }),
        usage: res.usage,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

/** TTS 格式枚举（canonical 三值；DeepSeek 只认 wav/pcm，它的 handler 自己拒 mp3）。 */
const TTS_FORMATS = ['wav', 'pcm', 'mp3'] as const;

function ttsHandler(deps: MiMoToolHandlerDeps): ToolEndpointHandler {
  return {
    id: 'tts',
    path: TTS_PATH,
    provider: 'mimo',
    access_path: MIMO_AUDIO_ACCESS_PATHS.tts,
    billing_access_path: MIMO_ACCESS_PATHS.openaiChat,
    decodeRequest(body) {
      const rec = asRecord(body);
      const format = optStr(rec, 'format') ?? 'wav';
      if (!TTS_FORMATS.includes(format as (typeof TTS_FORMATS)[number])) {
        throw new ToolRequestError(`字段 format 应为 ${TTS_FORMATS.join(' / ')}`);
      }
      const req: CanonicalToolRequest = {
        endpoint: 'tts',
        input: reqStr(rec, 'input', 10_000),
        voice_id: optStr(rec, 'voice_id') ?? 'mimo_default',
        format: format as 'wav' | 'pcm' | 'mp3',
        raw: {},
      };
      const filter = rec['filter_markdown'];
      if (typeof filter === 'boolean') req.filter_markdown = filter;
      const model = optStr(rec, 'model');
      if (model !== undefined) req.model = model;
      const design = optStr(rec, 'voice_design');
      if (design !== undefined) req.voice_design = design;
      const reference = rec['reference_audio'];
      if (reference !== undefined && reference !== null) {
        req.reference_audio = reqFile(rec, 'reference_audio');
      }
      return req;
    },
    async run(req) {
      if (req.endpoint !== 'tts') throw new ToolRequestError('端点不匹配');
      const outcome = await deps.tts.synthesize({
        model: (req.model ?? MIMO_AUDIO_DEFAULT_MODELS.tts) as MiMoTtsModel,
        text: req.input,
        ...(req.reference_audio === undefined
          ? {}
          : {
              reference_audio_base64: req.reference_audio.data_base64,
              reference_audio_mime: req.reference_audio.content_type,
            }),
        ...(req.voice_design === undefined ? {} : { voice_design: req.voice_design }),
        ...(req.voice_id === '' ? {} : { voice: req.voice_id }),
        format: req.format,
      });
      return {
        endpoint: 'tts',
        audio_base64: outcome.audio.toString('base64'),
        content_type: outcome.content_type,
        usage: outcome.usage,
        raw: {},
      };
    },
    encodeResponse(res) {
      if (res.endpoint !== 'tts') throw new ToolRequestError('端点不匹配');
      return {
        object: 'tools.tts.result',
        audio_base64: res.audio_base64,
        content_type: res.content_type,
        usage: res.usage,
      };
    },
  };
}

/** 导出给测试用（断言"两个端点一条不少"、路径不撞 DeepSeek）。 */
export const MIMO_TOOL_ENDPOINT_PATHS = {
  asr: ASR_PATH,
  tts: TTS_PATH,
} as const;
