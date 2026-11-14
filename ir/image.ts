/**
 * ir/image.ts —— Image 模态 payload。
 *
 * 唯一事实来源：docs/design/15-modalities.md §4（含 FLUX/BFL 异步轮询说明）。
 * 字段映射示例见同文 §9.3（openai.images.generations + edits 写透）。
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

  quality?: 'low' | 'medium' | 'high' | 'hd' | 'auto';
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
    /** 背景透明（gpt-image-1）。 */
    transparent_background?: boolean;
  };

  /** 内容审核强度。 */
  moderation?: 'auto' | 'low' | 'high';
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
  /** 异步轮询型上游（FLUX/BFL）的中间态。 */
  polling?: { url: string; status: string };
}
