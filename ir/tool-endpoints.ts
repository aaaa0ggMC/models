/**
 * ir/tool-endpoints.ts —— **独立工具端点**的 canonical 请求/响应信封。
 *
 * 范围：DeepSeek 全家桶的五个 standalone 端点（Search / Fetch / OCR / ASR / TTS）。
 * 它们**不是 chat pipeline 的一部分**（不进出 S0–S10、没有 Adaptor 实现），但照样
 * 要走 canonical：网关是唯一与客户端对话的一方，客户端不该知道上游长什么样，
 * 计量/审计也要有一份与 chat 同构的记录可查。
 *
 * 与 `ChatPayload` / `AsrPayload` / `TtsPayload` 的关系：ASR/TTS 复用那两个文件的
 * payload 形状（它们本来就是 canonical 的模态 payload），Search/Fetch/OCR 在 chat
 * 里没有对应模态，故在这里定义。
 *
 * ## 三条设计约束
 *
 * 1. **判别字段在最前**（`endpoint`），一个联合类型覆盖五个端点——不为每个端点
 *    建一套平行类型，那会出现"五个端点五份 usage 约定"的分裂；
 * 2. **`raw` 恒存在**（可以是空对象）：上游未建模字段显式保留，不悄悄丢弃
 *    （10 §7 的 raw passthrough 立场）；
 * 3. **请求与响应都带 `usage`**（响应侧）：计费口径（按次 / 按页 / 按音频秒 /
 *    按字符）由响应携带，调用方不需要回去问上游。
 */

import type { CanonicalUsage, RawEnvelope, SearchResultPart } from './index.js';

/** 五个独立工具端点。 */
export type ToolEndpointId = 'search' | 'fetch' | 'ocr' | 'asr' | 'tts';

/** 二进制输入（v1 只做 inline base64；`MediaRef` 的 uri/asset 三态留给后续）。 */
export interface ToolMediaInput {
  filename: string;
  content_type: string;
  /** base64 内容（**不含** `data:` 前缀）。 */
  data_base64: string;
}

/** 五个端点的 canonical 请求（判别联合）。 */
export type CanonicalToolRequest =
  | {
      endpoint: 'search';
      /** 搜索词（1–128 Unicode 字符，不支持纯空白）。 */
      query: string;
      /** 返回条数（默认 10，范围 1–50）。 */
      count?: number;
      /** 是否回正文 Markdown（默认 false）。 */
      need_content?: boolean;
      /** 用户原始问题（上游改写 query 的参考）；显式 null = 不提供。 */
      ori_question?: string | null;
      /** 用于本地化结果的 IP 串（默认 "" = 不本地化）。 */
      localization?: string;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'fetch';
      /** 要读取的 URL。 */
      url: string;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'ocr';
      file: ToolMediaInput;
      purpose?: 'text_recognition' | 'rich_layout_recognition';
      raw: RawEnvelope;
    }
  | {
      endpoint: 'asr';
      audio: ToolMediaInput;
      /** 语言提示（BCP-47；不给则上游自动检测）。 */
      language?: string;
      /** 提示词 / 领域词。 */
      prompt?: string;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'tts';
      /** 要合成的文本。 */
      input: string;
      /** 声音 id。 */
      voice_id: string;
      /**
       * 输出格式。
       *
       * `mp3` 是 2026-11 随 MiMo TTS 接入新增的**增量**联合成员（DeepSeek 只有
       * wav/pcm，它的 handler 自己拒绝 mp3；canonical 层不做"最小公共集"——
       * 那会让第二家上游的能力表达不出来）。既有成员语义不变。
       */
      format: 'wav' | 'pcm' | 'mp3';
      /** 是否过滤 Markdown 语法（默认 true）。DeepSeek 专有参数，其他上游忽略。 */
      filter_markdown?: boolean;
      /**
       * 上游 TTS **模型变体**（缺省 = 该 access path 的默认模型）。
       *
       * 2026-11 随 MiMo 接入新增的可选字段：MiMo 的 TTS 是"一个模型族三个变体"
       * （预置音色 / 音色克隆 / 音色设计），三者的 wire 差异无法用 voice_id 表达，
       * 而 canonical 不该为一家上游发明专有字段——所以这是一个**provider 中立**的
       * "用哪个模型"槽位。DeepSeek 的脸不给（它只有一个模型）。
       *
       * 注意这仍是**工具面** canonical；把 TTS/ASR 搬到 `TtsPayload` / `AsrPayload`
       * 模态面（85 §5.2 的 P1 缺口）之前，这是容纳多上游的最小增量。
       */
      model?: string;
      /** 音色克隆的参考音频（inline base64；`MediaRef` 的 uri/asset 三态留给后续）。 */
      reference_audio?: ToolMediaInput;
      /** 音色设计描述（上游用独立消息/字段表达时；voicedesign 类变体用）。 */
      voice_design?: string;
      raw: RawEnvelope;
    };

/** 五个端点的 canonical 响应（判别联合）。 */
export type CanonicalToolResponse =
  | {
      endpoint: 'search';
      /** 结果（canonical `SearchResultPart`，与 chat 的 search_result part 同一形状）。 */
      results: SearchResultPart[];
      usage: CanonicalUsage;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'fetch';
      /** 取回的正文 Markdown。 */
      content: string;
      /** 页标题（上游给了才有）。 */
      title?: string;
      usage: CanonicalUsage;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'ocr';
      /** 总页数（**计费主单位**）。 */
      page_count: number;
      pages: Array<{ index: number; text: string; finish_reason?: string }>;
      usage: CanonicalUsage;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'asr';
      /** 全文（最终）。 */
      text: string;
      /** 音频时长（秒）——ASR 计费主单位。 */
      duration_seconds?: number;
      usage: CanonicalUsage;
      raw: RawEnvelope;
    }
  | {
      endpoint: 'tts';
      /** 合成音频（base64，不含 `data:` 前缀）。 */
      audio_base64: string;
      content_type: string;
      usage: CanonicalUsage;
      raw: RawEnvelope;
    };

/**
 * 端点 → 计费主单位的人类可读说明（**进用户手册，不进界面**）。
 *
 * 写在这里而不是各 provider 文件：计费口径是 canonical 层的事实（`UsageUnits`
 * 的哪个槽），不是某一家的实现细节。**加权规则不进本表**——DeepSeek 的"CJK 每字 2"
 * 是它自己的规则（providers/deepseek/tts.ts 的 CJK_BILLED_RANGES），MiMo 没有这条；
 * canonical 只说"按字符"，具体权重见 provider 实现。
 */
export const TOOL_ENDPOINT_BILLING_UNITS: Readonly<Record<ToolEndpointId, string>> = {
  search: '按次（仅成功请求计费）',
  fetch: '按次（仅成功请求计费）',
  ocr: '按页',
  asr: '按音频秒',
  tts: '按字符（各家加权规则见 provider 实现）',
};
