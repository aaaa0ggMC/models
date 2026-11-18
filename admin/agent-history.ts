/**
 * admin/agent-history.ts —— 会话持久化（加密存储，默认关）。
 *
 * 设计依据：docs/design/95-agent-chat.md §7.2。
 *
 * 复用既有的加密记录存储与 AAD 写法（65-storage-and-retention.md §3.1），不新造一套：
 * 新记录种类 `agent_chat`，AAD 仍是 `record_kind + record_id`。落盘的内容**已经过脱敏**
 * （用户消息在进 canonical 前就替换掉了），因此即使开了持久化，库里也不会有密钥明文。
 *
 * 默认关（`agent_persist_messages`），与 65 §4.2 的 `persistence.messages` 默认关闭同立场。
 */

import type { EncryptedRecordStore } from '../storage/record-store.js';
import type { Clock } from '../ir/clock.js';
import type { AadRecordKind } from '../storage/crypto/aad.js';
import type { AgentToolCallView } from './api-types.js';

/** 记录种类（加 kind 是加法，不影响任何已存在记录的 AAD，见 storage/crypto/aad.ts）。 */
const AGENT_CHAT_KIND: AadRecordKind = 'agent_chat';

/** 落盘的一轮对话。 */
export interface AgentTurnRecord {
  id: string;
  ts: number;
  /** 发起这次对话的管理员（审计用）。 */
  actor: string;
  model: string;
  /** 已脱敏的用户消息原文。 */
  user: string;
  /** 已脱敏的助手回复。 */
  reply: string;
  /** 工具调用摘要（入参 + 结果摘要 + 是否出错）。 */
  tool_calls: AgentToolCallView[];
  /** 这一轮创建过的虚拟 key 的 id（**不含明文**）。 */
  created_key_ids: string[];
}

/** 历史存储端口（窄接口：聊天端点只用到写与读）。 */
export interface AgentHistoryStore {
  append(turn: Omit<AgentTurnRecord, 'id' | 'ts'>): Promise<void>;
  list(limit?: number): Promise<AgentTurnRecord[]>;
}

/** 加密存储实现。 */
export class EncryptedAgentHistoryStore implements AgentHistoryStore {
  constructor(
    private readonly store: EncryptedRecordStore,
    private readonly clock: Clock,
  ) {}

  async append(turn: Omit<AgentTurnRecord, 'id' | 'ts'>): Promise<void> {
    const now = this.clock.now();
    const id = `turn_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const record: AgentTurnRecord = { id, ts: now, ...turn };
    await this.store.put(AGENT_CHAT_KIND, id, record, now);
  }

  async list(limit = 50): Promise<AgentTurnRecord[]> {
    const all = await this.store.listDecrypted<AgentTurnRecord>(AGENT_CHAT_KIND);
    return all
      .map((r) => r.value)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }
}

/** 内存实现（测试 / 没配 recordStore 时用）。 */
export class MemoryAgentHistoryStore implements AgentHistoryStore {
  private readonly items: AgentTurnRecord[] = [];

  async append(turn: Omit<AgentTurnRecord, 'id' | 'ts'>): Promise<void> {
    const now = Date.now();
    this.items.push({
      id: `turn_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: now,
      ...turn,
    });
  }

  async list(limit = 50): Promise<AgentTurnRecord[]> {
    return [...this.items].sort((a, b) => b.ts - a.ts).slice(0, limit);
  }
}

/** 把一轮对话写进历史（开了持久化才调）。 */
export async function appendAgentTurn(
  history: AgentHistoryStore | undefined,
  turn: Omit<AgentTurnRecord, 'id' | 'ts'>,
): Promise<void> {
  if (history === undefined) return;
  try {
    await history.append(turn);
  } catch {
    // 持久化失败不影响对话本身：这一轮已经回了用户，历史只是一份额外留存
  }
}
