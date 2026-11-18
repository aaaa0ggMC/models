/**
 * gateway-core/pipeline/sink.ts —— 客户端写出抽象。
 *
 * 关键约束（20 §S8）：**一旦向客户端写出第一个字节，就不能再改变 HTTP 状态码**；
 * 因此所有错误都必须在首字节前转成 200 + SSE error 事件，或直接非 2xx。
 */

import type { StreamFrame } from '../../ir/index.js';

export interface ClientSink {
  /** 首字节前调用一次。重复调用抛错（用于把"写了字节就不能改状态码"变成硬失败）。 */
  start(status: number, headers: Record<string, string>): void;
  /** 写原始字节（非流式响应体 / 流式 SSE 文本）。 */
  write(chunk: string | Buffer): void;
  /** 写一个 canonical 帧（S8 已转成客户端格式的 SSE 文本）。 */
  writeFrame(frame: StreamFrame): void;
  /** 结束响应。 */
  end(): void;
  /** 客户端是否已断开（TTS 止损：立即取消上游，25 §6 第 3 条）。 */
  readonly closed: boolean;
  /** 是否已经 start 过。 */
  readonly started: boolean;
}

/** 测试/演示用的内存 sink：把字节收进数组。 */
export class MemoryClientSink implements ClientSink {
  readonly chunks: Array<string | Buffer> = [];
  readonly frames: StreamFrame[] = [];
  startStatus: number | undefined;
  startHeaders: Record<string, string> = {};
  private _started = false;
  private _closed = false;

  get started(): boolean {
    return this._started;
  }
  get closed(): boolean {
    return this._closed;
  }

  start(status: number, headers: Record<string, string>): void {
    if (this._started) throw new Error('ClientSink.start 重复调用：首字节后不能改状态码（20 §S8）');
    this._started = true;
    this.startStatus = status;
    this.startHeaders = headers;
  }

  write(chunk: string | Buffer): void {
    if (!this._started) this.start(200, {});
    this.chunks.push(chunk);
  }

  writeFrame(frame: StreamFrame): void {
    if (!this._started) this.start(200, { 'content-type': 'text/event-stream' });
    this.frames.push(frame);
  }

  end(): void {
    this._closed = true;
  }

  /** 取出全部输出（字符串形式）。 */
  text(): string {
    return this.chunks.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
  }
}
