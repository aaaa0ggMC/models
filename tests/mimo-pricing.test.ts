/**
 * tests/mimo-pricing.test.ts —— MiMo 计费（静态表 + 定价服务 + 双口径）的契约测试。
 *
 * 对应仓库主人的计费规则：「计费是每个 Provider 能用官方计费就计入，除此之外都要有
 * `as_api` 作为 API 估值计费。」落到 MiMo 上就是——**接入的每个模型都不能是 unpriced**。
 *
 * 覆盖：
 *   1. 静态表 loader：结构校验、fail-fast、表版本/来源 URL/币种；
 *   2. LLM token 计费：命中/未命中缓存输入分开计价，输出照算；
 *   3. **TTS 按字符**（`per_10000_characters`，官方限时免费 → 0）与
 *      **ASR 按音频秒**（`per_hour`，¥0.5/小时 → 按秒折算）；
 *   4. **Token Plan = 订阅路径**：cash 恒 0、as_api 照算（官方"两渠道不互通"的落地）；
 *   5. **按量路径**：cash 与 as_api 都照算；
 *   6. 两条路径的判据是 **key 前缀**（`tp-` / `sk-`，官方文档明文）；
 *   7. 组合定价服务按模型分流（DeepSeek 的归 DeepSeek、MiMo 的归 MiMo、都不认识
 *      → pending_price）；
 *   8. 工具/音频端点的用量记录 `cost.status === 'priced'`（**不是 unpriced**）；
 *   9. 官方计费接口：token_plan 的 decode + balance 的 decode + key 类型不匹配的错误。
 *
 * 上游一律不碰（静态表 + 纯函数）；真上游的计价观测在 tests/mimo-live.test.ts。
 */

import { describe, expect, it } from 'vitest';
import { loadMiMoPriceTables, mimoPriceTableFor } from '../providers/mimo/pricing.js';
import { createMiMoPricingService, priceMiMoToolCall } from '../providers/mimo/pricing-service.js';
import {
  MIMO_API_BASE_URL,
  MIMO_BALANCE_PATH,
  MIMO_TOKEN_PLAN_BASE_URL,
  MIMO_TOKEN_PLAN_PATH,
  MiMoBalanceClient,
  MiMoBalanceError,
  decodeBalance,
  decodeTokenPlan,
} from '../providers/mimo/balance.js';
import {
  BILLING_MODE_BY_KEY_PREFIX,
  billingModeForKey,
  EnvCredentialResolver,
} from '../credentials/resolver.js';
import { createCompositePricingService } from '../metering/composite-pricing.js';
import { createDeepSeekPricingService } from '../providers/deepseek/pricing-service.js';
import type { CanonicalUsage } from '../ir/index.js';

/** 固定请求时间（2026-11-16，落在表生效区间内）。 */
const TS = Date.parse('2026-11-16T09:00:00Z');

function usage(units: CanonicalUsage['units']): CanonicalUsage {
  return { units, source: 'provider' };
}

const TOKENS = {
  tokens: {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    total_tokens: 1_100_000,
    cache_read_tokens: 200_000,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
  },
};

// ---------------------------------------------------------------------------
// 1. 静态表
// ---------------------------------------------------------------------------

describe('MiMo 计费 · 静态价格表', () => {
  it('六个模型全有价（接入的每个模型都不能是 unpriced）', () => {
    const tables = loadMiMoPriceTables();
    // 2 LLM + 1 ASR + 3 TTS 变体 = 6，与 /v1/models 的清单一一对应
    expect(Object.keys(tables.tables).sort()).toEqual([
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
      'mimo-v2.6-flash',
      'mimo-v2.6-pro',
    ]);
    for (const [model, table] of Object.entries(tables.tables)) {
      expect(table.entries.length, model).toBeGreaterThan(0);
      expect(table.entries[0]!.rates, model).toBeDefined();
      expect(Object.keys(table.entries[0]!.rates).length, model).toBeGreaterThan(0);
    }
  });

  it('表头字段如实：官方页 URL、CNY、抓取日期、版本号', () => {
    const tables = loadMiMoPriceTables();
    const table = tables.tables['mimo-v2.6-flash']!;
    expect(table.source_url).toBe('https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go');
    expect(table.currency).toBe('CNY');
    expect(table.fetched_at).toBe('2026-11-16');
    expect(table.table_version).toBe('mimo-2026-10-21');
    // 国内 CNY 表（我们的 key 是 Token Plan 中国区）；海外 USD 表在同一页上但未取
    expect(table.unit).toMatch(/CNY per 1M tokens/);
  });

  it('数字逐格对上官：Flash ¥0.02/¥1.00/¥2.00、Pro ¥0.025/¥3.00/¥6.00', () => {
    const tables = loadMiMoPriceTables();
    expect(tables.tables['mimo-v2.6-flash']!.entries[0]!.rates).toEqual({
      input_cache_hit: 0.02,
      input_cache_miss: 1.0,
      input_cache_write: 0,
      output: 2.0,
    });
    expect(tables.tables['mimo-v2.6-pro']!.entries[0]!.rates).toEqual({
      input_cache_hit: 0.025,
      input_cache_miss: 3.0,
      input_cache_write: 0,
      output: 6.0,
    });
  });

  it('ASR ¥0.5/小时、TTS 限时免费 0（官方立场写进表，不是省略）', () => {
    const tables = loadMiMoPriceTables();
    expect(tables.tables['mimo-v2.5-asr']!.entries[0]!.rates).toEqual({ per_hour: 0.5 });
    for (const model of [
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
    ]) {
      expect(tables.tables[model]!.entries[0]!.rates).toEqual({ per_10000_characters: 0 });
    }
    // tools 段：ASR 与 TTS 的同款数字 + 联网搜索（本仓库未接该能力，只登记）
    expect(tables.tools['asr_per_hour']).toBe(0.5);
    expect(tables.tools['tts_per_10000_characters']).toBe(0);
    expect(tables.tools['web_search_per_1000_requests']).toBe(16);
  });

  it('rule_sets 为空数组（MiMo 无峰谷时段）且 tier 记 realtime', () => {
    const tables = loadMiMoPriceTables();
    for (const table of Object.values(tables.tables)) {
      expect(table.entries[0]!.rule_sets).toEqual([]);
      expect(table.entries[0]!.tier).toBe('realtime');
      // 没有时段窗口 → 不该有 time_windows
      expect(table.entries[0]!.time_windows).toBeUndefined();
    }
  });

  it('effective_from 是官方页的更新时间（2026-10-21）', () => {
    const tables = loadMiMoPriceTables();
    for (const table of Object.values(tables.tables)) {
      expect(table.entries[0]!.effective_from).toBe('2026-10-21');
    }
  });

  it('mimoPriceTableFor 两种入参形态都收，未知模型返回 undefined', () => {
    const bundle = loadMiMoPriceTables();
    expect(mimoPriceTableFor('mimo-v2.6-flash', bundle)?.currency).toBe('CNY');
    expect(mimoPriceTableFor('mimo-v2.6-flash', bundle.tables)?.currency).toBe('CNY');
    expect(mimoPriceTableFor('mimo-v2.6-flash')).toBeDefined();
    expect(mimoPriceTableFor('no-such-model', bundle)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1b. 不变量：能力矩阵里的每个 MiMo 条目都有价（#41 的强制检查的第一个被测对象）
// ---------------------------------------------------------------------------

describe('MiMo 计费 · 能力矩阵全覆盖（不变量）', () => {
  it('矩阵里每个 MiMo 条目都能被定价，且 status 是 priced', async () => {
    // 这条是「provider 必须有价」那条强制检查的最小版本：遍历默认能力矩阵里
    // access_path 以 mimo 开头的条目，逐个问定价服务"你认识吗 + 算出来是 priced 吗"。
    // 漏一个模型就会在这里红——而不是等到某条用量记录变成 unpriced 才被发现。
    const { mimoCapabilities } = await import('../providers/mimo/profile.js');
    const { mimoAudioCapabilities } = await import('../providers/mimo/audio-models.js');
    const entries = [...mimoCapabilities(), ...mimoAudioCapabilities()];
    expect(entries.length).toBe(6); // 2 chat + 3 tts + 1 asr

    const svc = createMiMoPricingService();
    for (const entry of entries) {
      expect(svc.handles(entry.model), `${entry.access_path}/${entry.model}`).toBe(true);
      // 每种模态给它一份该模态的用量：chat 给 token、tts 给 characters、asr 给秒
      const units =
        entry.modality === 'chat'
          ? TOKENS
          : entry.modality === 'tts'
            ? { characters: { input: 10, billed: 10 } }
            : { audio_seconds: { input: 60, billed: 60 } };
      const r = svc.price({ ts: TS, model: entry.model, usage: usage(units) });
      expect(r.cost.status, `${entry.access_path}/${entry.model}`).toBe('priced');
      expect(r.price_snapshot, `${entry.access_path}/${entry.model}`).not.toBeNull();
    }
  });

  it('组合服务对矩阵里每个 MiMo 条目都认领（不只单个服务认识）', async () => {
    const { mimoCapabilities } = await import('../providers/mimo/profile.js');
    const { mimoAudioCapabilities } = await import('../providers/mimo/audio-models.js');
    const { createDeepSeekPricingService } =
      await import('../providers/deepseek/pricing-service.js');
    const composite = createCompositePricingService([
      createDeepSeekPricingService(),
      createMiMoPricingService(),
    ]);
    for (const entry of [...mimoCapabilities(), ...mimoAudioCapabilities()]) {
      const r = composite.price({
        ts: TS,
        model: entry.model,
        usage: usage(
          entry.modality === 'tts'
            ? { characters: { input: 1, billed: 1 } }
            : entry.modality === 'asr'
              ? { audio_seconds: { input: 1, billed: 1 } }
              : TOKENS,
        ),
      });
      // 组合层也不能把它漏成 pending_price（那说明分流没接对）
      expect(r.cost.status, entry.model).toBe('priced');
      expect(r.price_snapshot?.price_table_version, entry.model).toBe('mimo-2026-10-21');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. LLM token 计费
// ---------------------------------------------------------------------------

describe('MiMo 计费 · LLM token', () => {
  it('Flash：1M 输入（20 万命中）+ 10 万输出 = 0.02×0.2 + 1.0×0.8 + 2.0×0.1', () => {
    const svc = createMiMoPricingService();
    const r = svc.price({ ts: TS, model: 'mimo-v2.6-flash', usage: usage(TOKENS) });
    // 0.004（命中）+ 0.8（未命中）+ 0.2（输出）= 1.004
    expect(r.cost.status).toBe('priced');
    expect(r.cost.as_api.cache_read).toBeCloseTo(0.004, 10);
    expect(r.cost.as_api.input).toBeCloseTo(0.8, 10);
    expect(r.cost.as_api.output).toBeCloseTo(0.2, 10);
    expect(r.cost.as_api.total).toBeCloseTo(1.004, 10);
    expect(r.price_snapshot).not.toBeNull();
    expect(r.price_snapshot?.rates).toMatchObject({ input_cache_hit: 0.02, output: 2.0 });
    expect(r.price_snapshot?.tier).toBe('realtime');
    expect(r.price_snapshot?.price_table_version).toBe('mimo-2026-10-21');
  });

  it('Pro：未命中输入与输出是 Flash 的 3 倍，缓存命中只有 1.25 倍', () => {
    const svc = createMiMoPricingService();
    const flash = svc.price({ ts: TS, model: 'mimo-v2.6-flash', usage: usage(TOKENS) });
    const pro = svc.price({ ts: TS, model: 'mimo-v2.6-pro', usage: usage(TOKENS) });
    // 官方数字：未命中输入 1.00 → 3.00、输出 2.00 → 6.00（3 倍）；
    // 缓存命中 0.02 → 0.025（1.25 倍，折扣力度不同）。逐槽比而不是比总数——
    // 总数会被缓存命中的那部分稀释，掩盖"两档折扣不同"这个事实。
    expect(pro.cost.as_api.input).toBeCloseTo(flash.cost.as_api.input * 3, 10);
    expect(pro.cost.as_api.output).toBeCloseTo(flash.cost.as_api.output * 3, 10);
    expect(pro.cost.as_api.cache_read).toBeCloseTo(flash.cost.as_api.cache_read * 1.25, 10);
  });

  it('reasoning tokens 不单独计价（含在 output 里，单独计就是双算）', () => {
    const svc = createMiMoPricingService();
    const withReasoning = usage({
      tokens: { ...TOKENS.tokens, reasoning_tokens: 50_000 },
    });
    const r = svc.price({ ts: TS, model: 'mimo-v2.6-flash', usage: withReasoning });
    expect(r.cost.as_api.reasoning).toBe(0);
  });

  it('handles 只认自己表里的模型', () => {
    const svc = createMiMoPricingService();
    expect(svc.handles('mimo-v2.6-flash')).toBe(true);
    expect(svc.handles('mimo-v2.5-asr')).toBe(true);
    expect(svc.handles('deepseek-flash')).toBe(false);
    expect(svc.handles('no-such-model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. TTS 按字符 / ASR 按音频秒
// ---------------------------------------------------------------------------

describe('MiMo 计费 · TTS 与 ASR（非 token 槽）', () => {
  it('TTS：按字符计（per_10000_characters），官方限时免费 → 0，但 status 是 priced', () => {
    const svc = createMiMoPricingService();
    const r = svc.price({
      ts: TS,
      model: 'mimo-v2.5-tts',
      usage: usage({ characters: { input: 12, billed: 12 } }),
    });
    // 关键：**不是 unpriced**。0 元是官方立场（限时免费），不是"没算钱"
    expect(r.cost.status).toBe('priced');
    expect(r.cost.as_api.total).toBe(0);
    expect(r.cost.as_api.builtin_tools).toBe(0);
    expect(r.price_snapshot?.rates).toEqual({ per_10000_characters: 0 });
  });

  it('TTS：三个变体同口径', () => {
    const svc = createMiMoPricingService();
    for (const model of [
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
    ]) {
      const r = svc.price({
        ts: TS,
        model,
        usage: usage({ characters: { input: 10, billed: 10 } }),
      });
      expect(r.cost.status, model).toBe('priced');
    }
  });

  it('ASR：按音频秒计（per_hour 按秒除 3600），¥0.5/小时', () => {
    const svc = createMiMoPricingService();
    // 3600 秒 = 1 小时 → ¥0.5
    const hour = svc.price({
      ts: TS,
      model: 'mimo-v2.5-asr',
      usage: usage({ audio_seconds: { input: 3600, billed: 3600 } }),
    });
    expect(hour.cost.status).toBe('priced');
    expect(hour.cost.as_api.total).toBeCloseTo(0.5, 10);
    expect(hour.cost.as_api.builtin_tools).toBeCloseTo(0.5, 10);

    // 4 秒（live 冒烟实测的典型时长）→ 0.5 × 4/3600
    const four = svc.price({
      ts: TS,
      model: 'mimo-v2.5-asr',
      usage: usage({ audio_seconds: { input: 4, billed: 4 } }),
    });
    expect(four.cost.as_api.total).toBeCloseTo((0.5 * 4) / 3600, 12);
  });

  it('工具端点入口 priceMiMoToolCall 与 S10 入口同结果', () => {
    const u = usage({ audio_seconds: { input: 60, billed: 60 } });
    const viaSvc = createMiMoPricingService().price({ ts: TS, model: 'mimo-v2.5-asr', usage: u });
    const viaTool = priceMiMoToolCall({ ts: TS, model: 'mimo-v2.5-asr', usage: u });
    expect(viaTool.cost.as_api.total).toBeCloseTo(viaSvc.cost.as_api.total, 12);
    expect(viaTool.cost.status).toBe('priced');
    expect(viaTool.price_snapshot).not.toBeNull();
  });

  it('工具端点入口对未知模型 → pending_price（不猜、不算 0）', () => {
    const r = priceMiMoToolCall({
      ts: TS,
      model: 'no-such-model',
      usage: usage({ characters: { input: 1, billed: 1 } }),
    });
    expect(r.cost.status).toBe('pending_price');
    expect(r.price_snapshot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. 订阅 / 按量双口径
// ---------------------------------------------------------------------------

describe('MiMo 计费 · Token Plan 订阅 vs 按量', () => {
  const llm = usage(TOKENS);

  it('订阅路径：cash 恒 0、as_api 照算', () => {
    const svc = createMiMoPricingService();
    const r = svc.price({ ts: TS, model: 'mimo-v2.6-flash', usage: llm, subscription: true });
    expect(r.cost.status).toBe('priced');
    expect(r.cost.cash.total).toBe(0);
    expect(r.cost.as_api.total).toBeCloseTo(1.004, 10);
  });

  it('按量路径：cash 与 as_api 都照算', () => {
    const svc = createMiMoPricingService();
    const r = svc.price({ ts: TS, model: 'mimo-v2.6-flash', usage: llm });
    expect(r.cost.cash.total).toBeCloseTo(1.004, 10);
    expect(r.cost.as_api.total).toBeCloseTo(1.004, 10);
  });

  it('TTS/ASR 在订阅路径下同样 cash 0、as_api 照算（ASR 的 as_api 不为 0）', () => {
    const svc = createMiMoPricingService();
    const asr = svc.price({
      ts: TS,
      model: 'mimo-v2.5-asr',
      usage: usage({ audio_seconds: { input: 3600, billed: 3600 } }),
      subscription: true,
    });
    expect(asr.cost.cash.total).toBe(0);
    expect(asr.cost.as_api.total).toBeCloseTo(0.5, 10);

    const tts = svc.price({
      ts: TS,
      model: 'mimo-v2.5-tts',
      usage: usage({ characters: { input: 5, billed: 5 } }),
      subscription: true,
    });
    expect(tts.cost.cash.total).toBe(0);
    expect(tts.cost.status).toBe('priced');
  });

  it('上游没给 usage 也没有可估算文本 → unpriced（不是"免费"）', () => {
    const svc = createMiMoPricingService();
    const r = svc.price({ ts: TS, model: 'mimo-v2.6-flash', usage: usage({}) });
    expect(r.cost.status).toBe('unpriced');
    expect(r.price_snapshot).not.toBeNull(); // 价格有，缺的是用量
  });

  it('上游没给 usage 但给了文本 → 自估算补 as_api，并标注方法', () => {
    const svc = createMiMoPricingService();
    const r = svc.price({
      ts: TS,
      model: 'mimo-v2.6-flash',
      usage: usage({}),
      estimateText: '你好世界',
    });
    expect(r.estimate_method).toBeDefined();
    expect(r.estimated_usage?.source).toBe('estimated');
    expect(r.cost.status).toBe('priced');
    expect(r.cost.as_api.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 计费路径判据（key 前缀）
// ---------------------------------------------------------------------------

describe('MiMo 计费 · 路径判据（key 前缀，官方明文）', () => {
  it('tp- → 订阅，sk- → 按量', () => {
    expect(billingModeForKey('tp-fake-token-plan-key-not-real-000000000000')).toBe('subscription');
    expect(billingModeForKey('sk-fake-pay-as-you-go-key-not-real')).toBe('pay_as_you_go');
    // 认不出 → undefined（调用方按非订阅处理，保守方向）
    expect(billingModeForKey('AIzaSyFakeGoogleKeyNotReal')).toBeUndefined();
    expect(billingModeForKey('')).toBeUndefined();
  });

  it('前缀表只有两条，且都是官方文档明文的那两个', () => {
    expect(BILLING_MODE_BY_KEY_PREFIX).toEqual([
      { prefix: 'tp-', mode: 'subscription' },
      { prefix: 'sk-', mode: 'pay_as_you_go' },
    ]);
  });

  it('EnvCredentialResolver.billingModeFor：按 access path 问，只读不写', () => {
    const tp = new EnvCredentialResolver(undefined, undefined, {
      MIMO_API_KEY: 'tp-fake-token-plan-key-not-real-000000000000',
    });
    expect(tp.billingModeFor?.('mimo.openai-chat')).toBe('subscription');

    const sk = new EnvCredentialResolver(undefined, undefined, {
      MIMO_API_KEY: 'sk-fake-pay-as-you-go-key-not-real',
    });
    expect(sk.billingModeFor?.('mimo.openai-chat')).toBe('pay_as_you_go');

    // 没配 key → undefined（分不清，调用方按非订阅处理）
    const none = new EnvCredentialResolver(undefined, undefined, {});
    expect(none.billingModeFor?.('mimo.openai-chat')).toBeUndefined();

    // 未登记的 access path → undefined（不是抛错：这条路径可能压根不需要凭据）
    expect(tp.billingModeFor?.('no.such.path')).toBeUndefined();

    // mock 路径不需要凭据 → undefined
    expect(tp.billingModeFor?.('mock')).toBeUndefined();
  });

  it('keyring 档 → undefined（异步读不了，同步路径上分不清就按非订阅）', () => {
    const resolver = new EnvCredentialResolver(undefined, undefined, {});
    // 手工登记一条 keyring 凭据，验证"不同步读 keyring"的立场
    resolver.registerCredential({
      id: 'keyring:mimo',
      name: 'mimo (keyring)',
      type: 'api_key',
      access_path: 'mimo.openai-chat',
      model_namespace: 'mimo',
      storage: { location: 'keyring', ref: 'mimo-key', encrypted: true },
      health: { status: 'unknown', last_checked: 0 },
      priority: 100,
      enabled: true,
      refresh: { kind: 'static', on_refresh_failure: 'alert_only' },
    });
    expect(resolver.billingModeFor?.('mimo.openai-chat')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. 组合定价服务
// ---------------------------------------------------------------------------

describe('MiMo 计费 · 多上游组合分流', () => {
  it('DeepSeek 模型归 DeepSeek、MiMo 模型归 MiMo', () => {
    const composite = createCompositePricingService([
      createDeepSeekPricingService(),
      createMiMoPricingService(),
    ]);
    const ds = composite.price({
      ts: TS,
      model: 'deepseek-flash',
      usage: usage(TOKENS),
    });
    expect(ds.price_snapshot?.price_table_version).toMatch(/^deepseek-/);
    expect(ds.cost.status).toBe('priced');

    const mimo = composite.price({ ts: TS, model: 'mimo-v2.6-flash', usage: usage(TOKENS) });
    expect(mimo.price_snapshot?.price_table_version).toBe('mimo-2026-10-21');
    expect(mimo.cost.status).toBe('priced');
  });

  it('两家都不认识 → pending_price + snapshot null（不让某个兜底服务乱算）', () => {
    const composite = createCompositePricingService([
      createDeepSeekPricingService(),
      createMiMoPricingService(),
    ]);
    const r = composite.price({ ts: TS, model: 'no-such-model', usage: usage(TOKENS) });
    expect(r.cost.status).toBe('pending_price');
    expect(r.price_snapshot).toBeNull();
  });

  it('订阅判据穿过组合层不丢失', () => {
    const composite = createCompositePricingService([
      createDeepSeekPricingService(),
      createMiMoPricingService(),
    ]);
    const r = composite.price({
      ts: TS,
      model: 'mimo-v2.6-flash',
      usage: usage(TOKENS),
      subscription: true,
    });
    expect(r.cost.cash.total).toBe(0);
    expect(r.cost.as_api.total).toBeCloseTo(1.004, 10);
  });
});

// ---------------------------------------------------------------------------
// 7. 官方计费接口的 decode
// ---------------------------------------------------------------------------

describe('MiMo 计费 · 官方余量/余额接口', () => {
  it('token_plan decode：积分三件套 + 周期 + 开关', () => {
    const info = decodeTokenPlan({
      object: 'token_plan',
      plan_code: 'pro',
      period: { start_at: '2026-10-31 15:56:29', end_at: '2026-11-30 23:59:59' },
      quota: {
        total_credits: 38_000_000_000,
        used_credits: 24_055_805_202,
        remaining_credits: 13_944_194_798,
      },
      auto_renew: false,
      claw_enabled: false,
    });
    expect(info.plan_code).toBe('pro');
    expect(info.quota.total_credits).toBe(38_000_000_000);
    expect(info.quota.used_credits).toBe(24_055_805_202);
    expect(info.quota.remaining_credits).toBe(13_944_194_798);
    expect(info.auto_renew).toBe(false);
    expect(info.raw).toBeDefined();
  });

  it('token_plan decode：缺 remaining 时按 max(0, total-used) 兜底', () => {
    const info = decodeTokenPlan({
      quota: { total_credits: 100, used_credits: 130 },
    });
    expect(info.quota.remaining_credits).toBe(0);
  });

  it('balance decode：金额是字符串（与 DeepSeek 同款），七个字段原样', () => {
    const res = decodeBalance({
      object: 'balance',
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          cash_balance: '100.50',
          gift_balance: '20.00',
          frozen_balance: '0.00',
          credit_limit: '500.00',
          credit_available: '380.00',
          total_available: '500.50',
        },
      ],
    });
    expect(res.is_available).toBe(true);
    expect(res.balance_infos).toHaveLength(1);
    expect(res.balance_infos[0]).toEqual({
      currency: 'CNY',
      cash_balance: '100.50',
      gift_balance: '20.00',
      frozen_balance: '0.00',
      credit_limit: '500.00',
      credit_available: '380.00',
      total_available: '500.50',
    });
  });

  it('两个端点挂在不同 host、要不同 key 前缀（客户端常量即文档）', () => {
    // token_plan 在 Token Plan 专属 host；balance 在普通 API host
    expect(MIMO_TOKEN_PLAN_BASE_URL).toBe('https://token-plan-cn.xiaomimimo.com');
    expect(MIMO_API_BASE_URL).toBe('https://api.xiaomimimo.com');
  });

  it('哨兵：new URL(path, base) 拼出来的地址含 /v1（base 不带路径）', () => {
    // 这个坑 2026-11 在 chat 路径上踩过一次（base 含 /v1 被绝对路径整段替换 →
    // 上游 404），live 冒烟又抓到一次。base 只到 host、版本路径进 path，
    // 与 credentials/resolver.ts 的 DEFAULT_BASE_URL_BY_ACCESS_PATH 同款不变量。
    expect(new URL(MIMO_TOKEN_PLAN_PATH, MIMO_TOKEN_PLAN_BASE_URL).toString()).toBe(
      'https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan',
    );
    expect(new URL(MIMO_BALANCE_PATH, MIMO_API_BASE_URL).toString()).toBe(
      'https://api.xiaomimimo.com/v1/platform/balance',
    );
  });

  it('非 2xx → MiMoBalanceError（状态码完整上抛，调用方分流 401/404）', async () => {
    const client = new MiMoBalanceClient({
      transport: {
        send: async () => ({
          status: 401,
          headers: {},
          body: Buffer.from(JSON.stringify({ error: { code: 'invalid_api_key' } })),
        }),
      },
      headersProvider: async () => ({ authorization: 'Bearer tp-x' }),
    });
    await expect(client.balance()).rejects.toBeInstanceOf(MiMoBalanceError);
    try {
      await client.balance();
      expect.unreachable();
    } catch (err) {
      expect((err as MiMoBalanceError).status).toBe(401);
      expect((err as MiMoBalanceError).endpoint).toBe('balance');
    }
  });

  it('坏 JSON → MiMoBalanceError（不静默返回空对象）', async () => {
    const client = new MiMoBalanceClient({
      transport: { send: async () => ({ status: 200, headers: {}, body: Buffer.from('nope') }) },
      headersProvider: async () => ({}),
    });
    await expect(client.tokenPlan()).rejects.toBeInstanceOf(MiMoBalanceError);
  });

  it('snapshot(mode)：按量 → balance，其余 → token_plan', async () => {
    const calls: string[] = [];
    const client = new MiMoBalanceClient({
      transport: {
        send: async (req) => {
          calls.push(req.base_url + req.path);
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ object: 'x', quota: { total_credits: 1 } })),
          };
        },
      },
      headersProvider: async () => ({}),
    });
    const plan = await client.snapshot(undefined);
    expect(plan.kind).toBe('token_plan');
    expect(calls[0]).toBe('https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan');

    const payg = await client.snapshot('pay_as_you_go');
    expect(payg.kind).toBe('balance');
    expect(calls[1]).toBe('https://api.xiaomimimo.com/v1/platform/balance');
  });
});
