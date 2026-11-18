/**
 * metering/sqlite-sink.ts —— 基于 Node 内置 `node:sqlite` 的用量与完整对话消息存储。
 *
 * 按 `(ts)` 与 `(provider, ts)` 建索引，支持百万级记录下的 O(log N + K) 时间范围检索，
 * 启动零全量装载内存，适配 `save_full_messages` 开关与高并发生产部署。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageSink } from './emitter.js';
import type { UsageRecord } from './usage-record.js';

export class SqliteUsageStore implements UsageSink {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: string | DatabaseSync) {
    if (typeof dbOrPath === 'string') {
      if (dbOrPath !== ':memory:') {
        mkdirSync(dirname(dbOrPath), { recursive: true });
      }
      this.db = new DatabaseSync(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS usage_records (
        request_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_records(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_provider_ts ON usage_records(provider, ts);
    `);
  }

  async write(records: UsageRecord[]): Promise<void> {
    if (records.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO usage_records (request_id, ts, provider, model, status, record_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of records) {
        stmt.run(
          r.request_id,
          r.ts,
          r.provider,
          r.model,
          r.status,
          JSON.stringify(r),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  list(fromTs: number, toTs: number): UsageRecord[] {
    const rows = this.db
      .prepare('SELECT record_json FROM usage_records WHERE ts >= ? AND ts <= ? ORDER BY ts ASC')
      .all(fromTs, toTs) as unknown as Array<{ record_json: string }>;
    const out: UsageRecord[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.record_json) as UsageRecord);
      } catch {
        // 忽略损坏行
      }
    }
    return out;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM usage_records').get() as {
      cnt: number;
    };
    return Number(row.cnt ?? 0);
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
