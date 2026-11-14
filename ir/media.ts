/**
 * ir/media.ts —— 统一媒体引用模型（跨模态共用）。
 *
 * 唯一事实来源：docs/design/10-canonical-schema.md §5。
 * 设计约束 M2（15-modalities.md §1）：所有模态的二进制输入输出都用 MediaRef 三态，
 * **不允许**某个模态自己定义一种 base64 字段名。
 */

export type MediaRef = InlineMedia | UriMedia | AssetMedia;

export interface MediaBase {
  mime: string;
  byte_length?: number;
  /** 音频：时长（秒）；视频：时长（秒）。 */
  duration_seconds?: number;
  /** 图片/视频：像素尺寸。 */
  width?: number;
  height?: number;
  /** 音频：采样率 / 位深 / 声道。 */
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  /** 内容寻址 hash，用于去重（10 §5.2）。 */
  sha256?: string;
}

export interface InlineMedia extends MediaBase {
  kind: 'inline';
  /** base64，**不含** data: 前缀。 */
  data: string;
}

export interface UriMedia extends MediaBase {
  kind: 'uri';
  /** 公网 URL，或网关内部的 asset:// URL。 */
  uri: string;
  /** 是否需要网关代取（内网/需鉴权时）。 */
  fetch_by_gateway?: boolean;
  /** 代取时用的凭据引用（绝不存明文）。 */
  credential_ref?: string;
}

export interface AssetMedia extends MediaBase {
  kind: 'asset';
  /** 网关媒体库 id。 */
  asset_id: string;
}

/**
 * 流式音频分片（25-streaming.md §2.1 DeltaData / §3.2）。
 * 与 MediaRef 的区别：分片是 append-only 的传输单元，不带三态寻址。
 */
export interface MediaChunk {
  encoding: 'base64' | 'raw';
  mime: string;
  data: string;
  byte_length?: number;
  chunk_index: number;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  codec?: string;
}
