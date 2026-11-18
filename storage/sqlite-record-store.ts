/**
 * storage/sqlite-record-store.ts —— 基于 Node 内置 `node:sqlite` 的加密记录存储。
 *
 * 相比 JsonFileRecordStore（每次写入整文件重写），SQLite WAL 模式支持毫秒级单条点写与
 * 索引查询，无需额外原生依赖。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AadRecordKind } from './crypto/aad.js';
import type { RawRecordStore, StoredRecord } from './record-store.js';

interface SqliteRecordRow {
  kind: string;
  id: string;
  dek_id: string;
  ciphertext: Uint8Array;
  tag: Uint8Array;
  nonce: Uint8Array;
  created_at: number;
  updated_at: number;
}

function rowToStoredRecord(row: SqliteRecordRow): StoredRecord {
  return {
    kind: row.kind as AadRecordKind,
    id: row.id,
    dek_id: row.dek_id,
    ciphertext: Buffer.from(row.ciphertext),
    tag: Buffer.from(row.tag),
    nonce: Buffer.from(row.nonce),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class SqliteRawRecordStore implements RawRecordStore {
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
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        dek_id TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        tag BLOB NOT NULL,
        nonce BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind);
    `);
  }

  async put(record: StoredRecord): Promise<void> {
    const existing = this.db
      .prepare('SELECT created_at FROM records WHERE kind = ? AND id = ?')
      .get(record.kind, record.id) as { created_at: number } | undefined;
    const createdAt = existing?.created_at ?? record.created_at;
    this.db
      .prepare(
        `INSERT INTO records (kind, id, dek_id, ciphertext, tag, nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET
           dek_id = excluded.dek_id,
           ciphertext = excluded.ciphertext,
           tag = excluded.tag,
           nonce = excluded.nonce,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.kind,
        record.id,
        record.dek_id,
        record.ciphertext,
        record.tag,
        record.nonce,
        createdAt,
        record.updated_at,
      );
  }

  async get(kind: AadRecordKind, id: string): Promise<StoredRecord | undefined> {
    const row = this.db
      .prepare(
        'SELECT kind, id, dek_id, ciphertext, tag, nonce, created_at, updated_at FROM records WHERE kind = ? AND id = ?',
      )
      .get(kind, id) as SqliteRecordRow | undefined;
    return row === undefined ? undefined : rowToStoredRecord(row);
  }

  async list(kind: AadRecordKind): Promise<StoredRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT kind, id, dek_id, ciphertext, tag, nonce, created_at, updated_at FROM records WHERE kind = ?',
      )
      .all(kind) as unknown as SqliteRecordRow[];
    return rows.map(rowToStoredRecord);
  }

  async all(): Promise<StoredRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT kind, id, dek_id, ciphertext, tag, nonce, created_at, updated_at FROM records',
      )
      .all() as unknown as SqliteRecordRow[];
    return rows.map(rowToStoredRecord);
  }

  async delete(kind: AadRecordKind, id: string): Promise<boolean> {
    const info = this.db
      .prepare('DELETE FROM records WHERE kind = ? AND id = ?')
      .run(kind, id);
    return Number(info.changes) > 0;
  }

  async replaceAll(records: StoredRecord[]): Promise<void> {
    const insert = this.db.prepare(
      `INSERT INTO records (kind, id, dek_id, ciphertext, tag, nonce, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM records');
      for (const r of records) {
        insert.run(
          r.kind,
          r.id,
          r.dek_id,
          r.ciphertext,
          r.tag,
          r.nonce,
          r.created_at,
          r.updated_at,
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
