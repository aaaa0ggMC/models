/**
 * metering/file-sink.ts —— 持久化 JSONL usage sink（重启不丢用量与费用）。
 *
 * 启动时从 `<DATA>/usage.jsonl` 装载历史记录；运行期由 MemoryUsageEmitter 异步微批
 * 调用 `write(batch)` 追加写入磁盘（mode 0600，内部串行化队列防并发交错）。
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageSink } from './emitter.js';
import type { UsageRecord } from './usage-record.js';

export class JsonlFileUsageSink implements UsageSink {
  readonly records: UsageRecord[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** 启动时装载历史用量记录（损坏或半行尾部自动跳过）。 */
  async load(): Promise<number> {
    this.records.length = 0;
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as UsageRecord;
        if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'number') {
          this.records.push(parsed);
        }
      } catch {
        // 忽略崩溃遗留的半行
      }
    }
    return this.records.length;
  }

  async write(records: UsageRecord[]): Promise<void> {
    if (records.length === 0) return;
    this.records.push(...records);
    const chunk = `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
    const next = this.writeQueue.then(async () => {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, chunk, { encoding: 'utf8', mode: 0o600 });
    });
    this.writeQueue = next.catch(() => {});
    await next;
  }
}
