/**
 * tests/metering.test.ts —— usage 计量管道。
 *
 * 覆盖 60-billing-and-dogfooding.md §1/§2 的三条硬约束：
 *   1. 统计管道与主链路物理分离，管道挂了不影响用户请求；
 *   2. 队列满时按 drop_policy 处理，**绝不阻塞请求**、**没有回压路径**；
 *   3. emit() 永不抛。
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryUsageEmitter,
  MemoryUsageSink,
  NullUsageSink,
  createUsageRecord,
  zeroCost,
} from '../metering/index.js';
import { deepseekPriceTableFor } from '../providers/deepseek/pricing.js';
import { computeCost, priceSnapshotFrom, resolvePrice } from '../metering/pricing.js';
import { emptyUsage, mergeTokenUsage } from '../ir/index.js';

function makeRecord(requestId: string) {
  return createUsageRecord({
    request_id: requestId,
    ts: 1_700_000_000,
    auth: { key_id: 'key_test' },
    client_format: 'openai.chat',
    provider: 'openai',
    provider_format: 'openai.chat',
    model: 'gpt-test-1',
    fast_path: true,
    attempts: 1,
    stream: false,
    ttfb_ms: 12,
    total_ms: 340,
    status: 'success',
    usage: {
      units: {
        tokens: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
        },
      },
      source: 'provider',
    },
  });
}

describe('MemoryUsageEmitter', () => {
  it('emit 是同步非阻塞的，只入队不 IO', () => {
    const sink = new MemoryUsageSink();
    const emitter = new MemoryUsageEmitter({ autoFlush: false });
    emitter.setSink(sink);
    emitter.emit(makeRecord('req_1'));
    emitter.emit(makeRecord('req_2'));
    expect(emitter.depth()).toBe(2);
    // 未 flush 前 sink 是空的——证明 emit 没有同步 IO
    expect(sink.records).toHaveLength(0);
  });

  it('flush 把整批交给下游', async () => {
    const sink = new MemoryUsageSink();
    const emitter = new MemoryUsageEmitter({ autoFlush: false });
    emitter.setSink(sink);
    emitter.emit(makeRecord('req_1'));
    emitter.emit(makeRecord('req_2'));
    const batch = await emitter.flush();
    expect(batch).toHaveLength(2);
    expect(sink.records.map((r) => r.request_id)).toEqual(['req_1', 'req_2']);
    expect(emitter.depth()).toBe(0);
  });

  it('队列满按 drop_oldest 丢最旧 + 计数，不阻塞不抛', () => {
    const emitter = new MemoryUsageEmitter({
      capacity: 3,
      drop_policy: 'drop_oldest',
      autoFlush: false,
    });
    for (let i = 1; i <= 5; i += 1) emitter.emit(makeRecord(`req_${i}`));
    expect(emitter.depth()).toBe(3);
    expect(emitter.dropped()).toBe(2);
  });

  it('drop_newest 丢最新', () => {
    const emitter = new MemoryUsageEmitter({
      capacity: 2,
      drop_policy: 'drop_newest',
      autoFlush: false,
    });
    for (let i = 1; i <= 4; i += 1) emitter.emit(makeRecord(`req_${i}`));
    expect(emitter.depth()).toBe(2);
    expect(emitter.dropped()).toBe(2);
  });

  it('下游写入失败时把批次放回队列（可重放），不丢统计', async () => {
    let failFirst = true;
    const sink = {
      async write() {
        if (failFirst) {
          failFirst = false;
          throw new Error('存储暂时不可用');
        }
      },
    };
    const emitter = new MemoryUsageEmitter({ autoFlush: false });
    emitter.setSink(sink);
    emitter.emit(makeRecord('req_1'));
    await emitter.flush();
    expect(emitter.depth()).toBe(1); // 放回了
    await emitter.flush();
    expect(emitter.depth()).toBe(0);
  });

  it('没有下游时 flush 原样放回', async () => {
    const emitter = new MemoryUsageEmitter({ autoFlush: false });
    emitter.emit(makeRecord('req_1'));
    await emitter.flush();
    expect(emitter.depth()).toBe(1);
  });

  it('达到 batchSize 自动触发下沉', async () => {
    const sink = new MemoryUsageSink();
    const emitter = new MemoryUsageEmitter({ batchSize: 2, autoFlush: false });
    emitter.setSink(sink);
    emitter.emit(makeRecord('req_1'));
    emitter.emit(makeRecord('req_2'));
    // flush 是异步链，等一个 microtask 队列
    await Promise.resolve();
    await Promise.resolve();
    expect(sink.records.length).toBe(2);
  });

  it('NullUsageSink 丢弃一切且不抛', async () => {
    const emitter = new MemoryUsageEmitter({ autoFlush: false });
    emitter.setSink(new NullUsageSink());
    emitter.emit(makeRecord('req_1'));
    await expect(emitter.flush()).resolves.toHaveLength(1);
  });
});

describe('UsageRecord 结构（60 §3）', () => {
  it('绝不含 header 原值 / 凭据 / 客户端 IP', () => {
    const r = makeRecord('req_x');
    const serialized = JSON.stringify(r);
    for (const forbidden of [
      'authorization',
      'x-api-key',
      'x-goog-api-key',
      'cookie',
      'client_ip',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('auth 只含 id 标识，不含明文 key', () => {
    const r = makeRecord('req_x');
    expect(r.auth).toEqual({ key_id: 'key_test' });
  });

  it('Phase 1 不落 Tier-2：body_ref 恒不出现', () => {
    const r = makeRecord('req_x');
    expect('body_ref' in r).toBe(false);
    expect(r.redaction_profile).toBe('phase1-none');
  });

  it('可选字段缺省省略而不是填 0/undefined', () => {
    const r = makeRecord('req_x');
    expect('trace_id' in r).toBe(false);
    expect('model_alias' in r).toBe(false);
    expect('access_path' in r).toBe(false);
    expect('usage_raw' in r).toBe(false);
    expect('error_code' in r).toBe(false);
    expect('compaction' in r).toBe(false);
    expect('control_plane_cost' in r).toBe(false);
    // 定价相关：未接定价时快照缺省（不是 null——null 是"请求时拿不到价格"）
    expect('price_snapshot' in r).toBe(false);
    expect('estimate_method' in r).toBe(false);
    expect('backfilled_at' in r).toBe(false);
    expect('backfill_price_table_version' in r).toBe(false);
  });

  it('status=error 时 error_code 与 finish_reason=error', () => {
    const r = createUsageRecord({
      request_id: 'req_e',
      ts: 1,
      auth: { key_id: 'k' },
      client_format: 'openai.chat',
      provider: 'openai',
      provider_format: 'openai.chat',
      model: 'm',
      fast_path: false,
      attempts: 1,
      stream: false,
      ttfb_ms: 0,
      total_ms: 1,
      status: 'error',
      error_code: 'upstream_error',
    });
    expect(r.status).toBe('error');
    expect(r.error_code).toBe('upstream_error');
    expect(r.finish_reason).toBe('error');
  });

  it('cost 缺省是 unpriced 占位；接上价表后同一条 usage 能算出钱（60 §4.3：没有"未接定价"的现状）', () => {
    // ① 缺省占位：createUsageRecord 不给 cost 时的形状。
    //    它是**数据模型缺省**，不是"Phase 1 未接定价表"的现状豁免——规则（60 §4.3）要求
    //    每家 provider 都必须有价，缺了会红灯并点名（tests/billing-coverage.test.ts）。
    const r = makeRecord('req_x');
    expect(r.cost).toEqual({
      cash: zeroCost(),
      as_api: zeroCost(),
      status: 'unpriced',
    });
    // unpriced 不等于"免费"：没接定价就是没算钱，两个口径都是 0（R5 的立场）
    expect(r.cost.cash.total).toBe(0);
    expect(r.cost.as_api.total).toBe(0);

    // ② 同一条 usage，接上真价表之后就变成 priced：证明"算不出钱"不是记录的宿命，
    //    缺省占位只是"还没算"。规则立的就是这个——每家都必须算，没有例外现状。
    const usage = r.usage;
    const table = deepseekPriceTableFor('deepseek-flash');
    if (table === undefined) throw new Error('DeepSeek 价表必须能解析出 deepseek-flash');
    // 北京时间 2026-11-16 10:30 周一（峰窗内）——必须落在表覆盖的日期里，
    // 否则 resolvePrice 返 undefined，这条断言就空转了（表最早 2026-08-17 生效）。
    const tsPeak = Date.parse('2026-11-16T02:30:00Z');
    const price = resolvePrice(table, tsPeak);
    if (price === undefined) throw new Error('表覆盖的日期内必须解析出价格');
    const priced = createUsageRecord({
      request_id: 'req_priced',
      ts: tsPeak,
      auth: { key_id: 'key_test' },
      client_format: 'openai.chat',
      provider: 'deepseek',
      provider_format: 'openai.chat',
      model: 'deepseek-flash',
      fast_path: true,
      attempts: 1,
      stream: false,
      ttfb_ms: 12,
      total_ms: 340,
      status: 'success',
      usage,
      cost: computeCost(usage, price),
      price_snapshot: priceSnapshotFrom(price),
    });
    expect(priced.cost.status).toBe('priced');
    // 双口径都算出来了，且不是 0（10 in / 5 out token 在高峰档 ≈ 9e-6 美元）
    expect(priced.cost.cash.total).toBeGreaterThan(0);
    expect(priced.cost.as_api.total).toBeGreaterThan(0);
    // 快照固化：表版本落在记录里，对账/重算的唯一依据（60 §4.2 规则 a）
    expect(priced.price_snapshot?.price_table_version).toBe(table.table_version);
  });
});

describe('usage 归一助手', () => {
  it('emptyUsage 的 units 是空对象（未知≠0）', () => {
    expect(emptyUsage('provider').units).toEqual({});
  });

  it('mergeTokenUsage 累加数值、后到者覆盖 pricing_state', () => {
    const a = {
      input_tokens: 10,
      output_tokens: 0,
      total_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      details: { cache_write_ttl_5m: 3 },
    };
    const b = {
      input_tokens: 0,
      output_tokens: 7,
      total_tokens: 17,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      reasoning_tokens: 1,
      details: { cache_write_ttl_5m: 1 },
      pricing_state: { input: 'billed', output: 'free' } as const,
    };
    const merged = mergeTokenUsage(a, b);
    expect(merged.input_tokens).toBe(10);
    expect(merged.output_tokens).toBe(7);
    expect(merged.cache_read_tokens).toBe(2);
    expect(merged.details).toEqual({ cache_write_ttl_5m: 4 });
    expect(merged.pricing_state).toEqual({ input: 'billed', output: 'free' });
  });
});
