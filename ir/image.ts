/**
 * ir/image.ts —— Image 模态 payload。
 *
 * 唯一事实来源：docs/design/15-modalities.md §4（含 FLUX/BFL 异步轮询说明）。
 * 字段映射示例见同文 §9.3（openai.images.generations + edits 写透）。
 *
 * 增量记录（只加不改，12 §3 规则 F1）：
 *   - `quality` 增加 `"standard"`（dall-e-2 / dall-e-3 的档位名，gpt-image 系用
 *     low/medium/high/auto）；
 *   - 新增 `user`（OpenAI Images 的终端用户标识，与 chat 的 `ChatParams.user` 同义）；
 *   - 新增 `background`（gpt-image-1+ 的 `transparent` / `opaque` / `auto` 三态）。
 *     与既有 `output.transparent_background`（布尔）的关系：布尔是「透明与否」的
 *     粗粒度表达，三态是上游原语；两者**不是**从属关系而是精度差异，adaptor 映射时
 *     以 `background` 为准，`transparent_background` 仅在 `background` 缺省时生效；
 *   - 新增 `output_compression`（0–100，gpt-image 系 webp/jpeg 的压缩档位）；
 *   - 响应新增 `background`（上游回显的最终背景决策）。
 */

import type { MediaRef } from './media.js';
import type { RawEnvelope } from './envelope.js';

export interface ImagePayload {
  prompt: string;
  negative_prompt?: string;

  /** 尺寸：显式像素 or 比例（aspect_ratio）二选一。 */
  size?: { width: number; height: number };
  /** "1:1" / "16:9" / "21:9" / "auto"。 */
  aspect_ratio?: string;
  /** 生成数量。 */
  n?: number;

  /** low / medium / high / hd / standard / auto（dall-e 系用 hd|standard，gpt-image 系用 low|medium|high|auto）。 */
  quality?: 'low' | 'medium' | 'high' | 'hd' | 'standard' | 'auto';
  /** vivid / natural / style_preset。 */
  style?: string;
  /** 采样参数（Stability / FLUX）。 */
  sampling?: {
    steps?: number;
    /** cfg_scale。 */
    guidance?: number;
    sampler?: string;
    seed?: number;
  };
  /** 是否允许 prompt 自动改写（dall-e-3 revised_prompt）。 */
  allow_prompt_rewrite?: boolean;

  /** 背景三态（gpt-image-1+；与 output.transparent_background 是精度差异，见文件头）。 */
  background?: 'transparent' | 'opaque' | 'auto';

  /** 图生图 / 局部重绘。 */
  edit?: {
    /** 原图（img2img）。 */
    image?: MediaRef;
    /** mask（inpaint）。 */
    mask?: MediaRef;
    /** 改动强度 0–1。 */
    strength?: number;
    /** 多参考图。 */
    reference_images?: Array<{ image: MediaRef; weight?: number; mode?: 'style' | 'content' }>;
  };

  output: {
    format: 'png' | 'jpeg' | 'webp';
    /** 响应形态：base64 或 URL。 */
    response_type: 'b64_json' | 'url';
    /** 背景透明（gpt-image-1；background 缺省时的粗粒度表达）。 */
    transparent_background?: boolean;
    /** 压缩档位 0–100（gpt-image 系 webp/jpeg；缺省 = 上游默认）。 */
    output_compression?: number;
  };

  /** 内容审核强度。 */
  moderation?: 'auto' | 'low' | 'high';
  /** 终端用户标识（OpenAI Images 的 user；同 ChatParams.user 语义）。 */
  user?: string;
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

export interface ImageResponsePayload {
  images: Array<{
    /** 生成的图。 */
    image: MediaRef;
    /** 上游改写后的 prompt（dall-e-3）。 */
    revised_prompt?: string;
    /** 内容寻址 hash（去重）。 */
    sha256?: string;
  }>;
  /** 上游回显的最终背景决策（gpt-image-1+ 会给）。 */
  background?: 'transparent' | 'opaque' | 'auto';
  /** 异步轮询型上游（FLUX/BFL）的中间态。 */
  polling?: { url: string; status: string };
}
