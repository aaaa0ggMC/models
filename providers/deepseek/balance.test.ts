/**
 * providers/deepseek/balance.test.ts —— DeepSeek 余额端点 GET /user/balance 的契约测试。
 *
 * 覆盖对象：balance.ts 的 wire codec（decodeBalanceResponse / parseDecimalOrZero）
 * + 薄客户端（DeepSeekBalanceClient）。
 *
 * 测试分三组，对应三类必须兜住的风险：
 *   1. **金额是字符串不是数字**：这是上游最反直觉的一点（"110.00"），decode 必须原样
 *      留下字符串，parseDecimalOrZero 负责转 number 且**不抛**；
 *   2. **坏形状不炸周期任务**：非 object、缺字段、null / 数字 / 怪类型混进
 *      balance_infos，一律退化成默认值 + raw 留原文；
 *   3. **客户端**：用 gateway-core/transport.ts 的 ScriptedTransport（DI 注入的假上游，
 *      不打真实网络）跑 2xx 与非 2xx；断言 GET 方法、/user/balance 路径、Bearer 头，
 *      以及非 2xx 抛 DeepSeekApiError 且带状态码 + 错误体（不吞）。
 *
 * 隐私：夹具里的 key 一律是 `fake-test-key` 这种显式假值；金额是 110.00 / 10.00 这类
 * 文档示例量级的假数据，不是任何真实账户余额。
 */

import { describe, expect, it } from 'vitest';

import {
  DEEPSEEK_BALANCE_PATH,
  DeepSeekApiError,
  DeepSeekBalanceClient,
  decodeBalanceResponse,
  parseDecimalOrZero,
} from './balance.js';
import type { DeepSeekBalanceClientDeps } from './balance.js';
import { DEEPSEEK_DEFAULT_BASE_URL } from './search.js';
import { ScriptedTransport } from '../../gateway-core/transport.js';
import type { Clock } from '../../ir/clock.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 文档形态的完整响应（假数据：CNY 110.00 = 赠送 10.00 + 现金 100.00）。 */
function balanceFixture(): Record<string, unknown> {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '110.00',
        granted_balance: '10.00',
        topped_up_balance: '100.00',
      },
      {
        currency: 'USD',
        total_balance: '25.50',
        granted_balance: '0.00',
        topped_up_balance: '25.50',
      },
    ],
  };
}

/** 显式假的鉴权头（无 sk- 形态、不是任何真实 key）。 */
const FAKE_AUTH_HEADERS: Record<string, string> = { authorization: 'Bearer fake-test-key' };

/** 每次调用重新产头的 headersProvider（便于轮转 key 的场景）。 */
function fakeHeadersProvider(): Promise<Record<string, string>> {
  return Promise.resolve({ ...FAKE_AUTH_HEADERS });
}

/** 固定时钟：把 fetched_at 变成可断言的确定值（仓库硬约束：模块里不直接 Date.now()）。 */
function fixedClock(ms: number): Clock {
  return { now: () => ms };
}

/** 把抛出的错误窄化成 DeepSeekApiError（测试辅助）。 */
async function captureApiError(fn: () => Promise<unknown>): Promise<DeepSeekApiError> {
  try {
    await fn();
  } catch (err) {
    return err as DeepSeekApiError;
  }
  throw new Error('expected the call to throw');
}

// ---------------------------------------------------------------------------
// decodeBalanceResponse
// ---------------------------------------------------------------------------

describe('deepseek.balance decode', () => {
  it('文档形态：两个币种全字段解出，金额保持字符串', () => {
    const res = decodeBalanceResponse(balanceFixture());

    expect(res.is_available).toBe(true);
    expect(res.balance_infos).toHaveLength(2);
    expect(res.balance_infos[0]).toEqual({
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    });
    expect(res.balance_infos[1]?.currency).toBe('USD');
    // 关键：金额**不转 number**——原文保留才能对账
    expect(typeof res.balance_infos[0]?.total_balance).toBe('string');
    // 整包原文进 raw（含未建模顶层键）
    expect(res.raw).toEqual(balanceFixture());
  });

  it('未知顶层键活着进 raw（raw passthrough）', () => {
    const raw = { ...balanceFixture(), future_top_level_field: '未建模键必须活着' };
    const res = decodeBalanceResponse(raw);
    // raw 是 unknown（整包原文，形状不可知）→ 显式收窄成 Record 再取键
    expect((res.raw as Record<string, unknown>)['future_top_level_field']).toBe('未建模键必须活着');
    expect(res.is_available).toBe(true);
  });

  it('is_available 缺失 / 类型错 → true（不猜「不可用」）', () => {
    for (const odd of [{}, { is_available: 'yes' }, { is_available: 1 }, null, 'text', 42]) {
      const res = decodeBalanceResponse(odd);
      expect(res.is_available).toBe(true);
    }
    expect(decodeBalanceResponse({ is_available: false }).is_available).toBe(false);
  });

  it('balance_infos 缺失 / 不是数组 → 空数组，不抛', () => {
    for (const odd of [null, undefined, 'text', 42, [], {}, { balance_infos: 'nope' }]) {
      expect(decodeBalanceResponse(odd).balance_infos).toEqual([]);
    }
  });

  it('balance_infos 里非 object 条目整条丢弃（不产生全 0 的假币种桶）', () => {
    const res = decodeBalanceResponse({
      is_available: true,
      balance_infos: [
        null,
        42,
        'CNY',
        ['also', 'not', 'a', 'record'],
        {
          currency: 'CNY',
          total_balance: '5.00',
          granted_balance: '5.00',
          topped_up_balance: '0.00',
        },
      ],
    });
    expect(res.balance_infos).toHaveLength(1);
    expect(res.balance_infos[0]?.currency).toBe('CNY');
    // 原样还在 raw 里可查
    expect(Array.isArray((res.raw as Record<string, unknown>)['balance_infos'])).toBe(true);
  });

  it('金额各形态：null / 数字 / 缺字段都收成可解析的字符串', () => {
    const res = decodeBalanceResponse({
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: null,
          granted_balance: 12.5,
          topped_up_balance: { nested: 'object' },
        },
        { currency: 'USD' },
      ],
    });
    expect(res.balance_infos[0]).toEqual({
      currency: 'CNY',
      total_balance: '0',
      granted_balance: '12.5',
      topped_up_balance: '0',
    });
    // 整条缺金额 → 全 '0'（下游 parseDecimalOrZero 直接可用）
    expect(res.balance_infos[1]).toEqual({
      currency: 'USD',
      total_balance: '0',
      granted_balance: '0',
      topped_up_balance: '0',
    });
  });

  it('字符串金额原样保留（不重新格式化）', () => {
    const res = decodeBalanceResponse({
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: ' 110.00 ',
          granted_balance: '1e21',
          topped_up_balance: '',
        },
      ],
    });
    expect(res.balance_infos[0]?.total_balance).toBe(' 110.00 ');
    expect(res.balance_infos[0]?.granted_balance).toBe('1e21');
    expect(res.balance_infos[0]?.topped_up_balance).toBe('');
  });

  it('currency 缺失 → 空串哨兵（不猜币种）', () => {
    const res = decodeBalanceResponse({ balance_infos: [{ total_balance: '1.00' }] });
    expect(res.balance_infos[0]?.currency).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseDecimalOrZero
// ---------------------------------------------------------------------------

describe('deepseek.balance parseDecimalOrZero', () => {
  it('文档形态："110.00" → 110', () => {
    expect(parseDecimalOrZero('110.00')).toBe(110);
    expect(parseDecimalOrZero('10.00')).toBe(10);
    expect(parseDecimalOrZero('0.00')).toBe(0);
    expect(parseDecimalOrZero('-3.25')).toBe(-3.25);
    expect(parseDecimalOrZero('1e3')).toBe(1000);
  });

  it('首尾空白容忍（trim 后解析）', () => {
    expect(parseDecimalOrZero('  110.00  ')).toBe(110);
    expect(parseDecimalOrZero('\t12.5\n')).toBe(12.5);
  });

  it('不可解析 → 0，不抛（周期任务不能被一次坏响应炸掉）', () => {
    for (const odd of [null, undefined, true, false, {}, [], () => 1, Symbol('x')]) {
      expect(parseDecimalOrZero(odd)).toBe(0);
    }
    expect(parseDecimalOrZero('')).toBe(0);
    expect(parseDecimalOrZero('   ')).toBe(0);
    expect(parseDecimalOrZero('abc')).toBe(0);
    expect(parseDecimalOrZero('¥110.00')).toBe(0);
    expect(parseDecimalOrZero(NaN)).toBe(0);
    expect(parseDecimalOrZero(Infinity)).toBe(0);
  });

  it('有限 number 也收（上游版本漂移时可能偷发数字）', () => {
    expect(parseDecimalOrZero(110)).toBe(110);
    expect(parseDecimalOrZero(0)).toBe(0);
    expect(parseDecimalOrZero(-2.5)).toBe(-2.5);
  });

  it('decode 出来的形状整体可解析（端到端小闭环）', () => {
    const res = decodeBalanceResponse(balanceFixture());
    expect(res.balance_infos.map((i) => parseDecimalOrZero(i.topped_up_balance))).toEqual([
      100, 25.5,
    ]);
  });
});

// ---------------------------------------------------------------------------
// DeepSeekBalanceClient
// ---------------------------------------------------------------------------

describe('deepseek.balance client', () => {
  const deps = (transport: ScriptedTransport): DeepSeekBalanceClientDeps => ({
    transport,
    headersProvider: fakeHeadersProvider,
    clock: fixedClock(1_700_000_000_000),
  });

  it('2xx：解出余额，请求形状是 GET /user/balance + Bearer 头', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(balanceFixture()) },
    ]);
    const client = new DeepSeekBalanceClient(deps(transport));

    const snap = await client.snapshot();

    expect(snap.status).toBe(200);
    expect(snap.balance.is_available).toBe(true);
    expect(snap.balance.balance_infos).toEqual(
      decodeBalanceResponse(balanceFixture()).balance_infos,
    );
    // fetched_at 取自注入的时钟（响应返回之后）
    expect(snap.fetched_at).toBe(1_700_000_000_000);

    const sent = transport.requests[0];
    expect(sent).toBeDefined();
    if (sent === undefined) throw new Error('expected one upstream request');
    expect(sent.method).toBe('GET');
    expect(sent.base_url).toBe(DEEPSEEK_DEFAULT_BASE_URL);
    expect(sent.path).toBe(DEEPSEEK_BALANCE_PATH);
    expect(sent.stream).toBe(false);
    // GET 不带 body、不带 content-type
    expect(sent.body).toBeUndefined();
    expect(sent.headers['content-type']).toBeUndefined();
    expect(sent.headers['authorization']).toBe('Bearer fake-test-key');
  });

  it('每次快照重新取鉴权头（便于轮换 key）', async () => {
    let calls = 0;
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(balanceFixture()) },
      { status: 200, body: JSON.stringify(balanceFixture()) },
    ]);
    const client = new DeepSeekBalanceClient({
      transport,
      headersProvider: () => {
        calls += 1;
        return Promise.resolve({ ...FAKE_AUTH_HEADERS });
      },
      clock: fixedClock(1),
    });

    await client.snapshot();
    await client.snapshot();

    expect(calls).toBe(2);
    expect(transport.requests).toHaveLength(2);
  });

  it('2xx 但响应体不是 JSON：余额退化成默认值，不抛（raw 留 undefined）', async () => {
    const transport = new ScriptedTransport([{ status: 200, body: '<html>maintenance</html>' }]);
    const snap = await new DeepSeekBalanceClient(deps(transport)).snapshot();

    expect(snap.status).toBe(200);
    expect(snap.balance.is_available).toBe(true);
    expect(snap.balance.balance_infos).toEqual([]);
    expect(snap.balance.raw).toBeUndefined();
  });

  it('2xx 但余额被掏空：is_available=false 原样透出', async () => {
    const body = {
      is_available: false,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '0.00',
          granted_balance: '0.00',
          topped_up_balance: '0.00',
        },
      ],
    };
    const transport = new ScriptedTransport([{ status: 200, body: JSON.stringify(body) }]);
    const snap = await new DeepSeekBalanceClient(deps(transport)).snapshot();
    expect(snap.balance.is_available).toBe(false);
  });

  it('非 2xx：401 带解析后的错误体上抛，不吞状态码', async () => {
    const errorBody = {
      error: {
        message: 'Authentication Fails',
        type: 'authentication_error',
        param: null,
        code: null,
      },
    };
    const transport = new ScriptedTransport([{ status: 401, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() => new DeepSeekBalanceClient(deps(transport)).snapshot());

    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.name).toBe('DeepSeekApiError');
    expect(err.status).toBe(401);
    expect(err.body).toEqual(errorBody);
    expect(err.message).toContain('401');
  });

  it('非 2xx：402 余额不足（这个端点上与 401 的处置完全不同，故状态码必须完整）', async () => {
    const errorBody = {
      error: {
        message: 'Insufficient Balance',
        type: 'insufficient_balance',
        param: null,
        code: 'invalid_request_error',
      },
    };
    const transport = new ScriptedTransport([{ status: 402, body: JSON.stringify(errorBody) }]);
    const err = await captureApiError(() => new DeepSeekBalanceClient(deps(transport)).snapshot());
    expect(err.status).toBe(402);
    expect((err.body as Record<string, unknown>)['error']).toBeDefined();
  });

  it('非 2xx：错误体不是 JSON 时保留原文文本', async () => {
    const transport = new ScriptedTransport([{ status: 500, body: 'upstream exploded' }]);
    const err = await captureApiError(() => new DeepSeekBalanceClient(deps(transport)).snapshot());
    expect(err.status).toBe(500);
    expect(err.body).toBe('upstream exploded');
  });

  it('baseUrl / path 可被覆盖（代理与内网镜像场景）', async () => {
    const transport = new ScriptedTransport([
      { status: 200, body: JSON.stringify(balanceFixture()) },
    ]);
    const client = new DeepSeekBalanceClient({
      transport,
      headersProvider: fakeHeadersProvider,
      baseUrl: 'http://127.0.0.1:9',
      path: '/mirror/user/balance',
      clock: fixedClock(7),
    });
    await client.snapshot();
    const sent = transport.requests[0];
    expect(sent?.base_url).toBe('http://127.0.0.1:9');
    expect(sent?.path).toBe('/mirror/user/balance');
  });
});
