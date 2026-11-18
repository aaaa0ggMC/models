/**
 * tests/billing-coverage.test.ts —— 「每家 provider 必须有价」的红灯。
 *
 * 唯一事实来源：docs/design/60-billing-and-dogfooding.md §4.3（双轨强制）。
 * 机制本体在 metering/billing-coverage.ts（登记表 + 审计器）；本文件负责两件事：
 *
 *   1. **把真实登记处接上审计器**——遍历 `DEFAULT_ACCESS_PATHS`、能力矩阵、默认路由表
 *      三处的并集（这正是「能收到流量」的判据，为什么不选 presets 见机制文件头决定 2），
 *      断言没有新的未覆盖 access path；
 *   2. **证明红灯两端都会亮**——用合成数据证明「新 provider 不给价表会红」「登记表腐烂
 *      会红」「基线该删不删也会红」。只跑正向用例的话，「审计器坏了但恰好全绿」与
 *      「真的全绿」无法区分（同 tests/docs-check.test.ts 的立场）。
 *
 * 为什么判据是这三处而不是 `providers/presets.ts`：preset 只是管理面「新建渠道」弹窗的
 * 便利预填，其中数条标着 `needs_verification` / `confidence: 'unverified'`（接都没接过）。
 * 拿它当判据会「一加预设就假阳性」——红灯喊多了就没人看了。而 access path / 能力矩阵 /
 * 路由表是「不登记就收不到流量」的地方：路由按矩阵做能力预检、`/v1/models` 按矩阵列清单，
 * 新 provider 想真被调用必然落进其中至少一处。
 */

import { describe, expect, it } from 'vitest';

import { defaultCapabilities, defaultRouteTable } from '../composition-root.js';
import { DEFAULT_ACCESS_PATHS } from '../credentials/resolver.js';
import {
  BILLING_COVERAGE,
  KNOWN_UNCOVERED,
  KNOWN_UNPRICED_MODELS,
  auditBillingCoverage,
  auditModelPricing,
  formatCoverageReport,
  formatModelPricingReport,
  type CoverageSources,
} from '../metering/billing-coverage.js';
import { deepseekPriceTableFor, loadDeepSeekPriceTables } from '../providers/deepseek/pricing.js';
import { loadMiMoPriceTables, mimoPriceTableFor } from '../providers/mimo/pricing.js';
import { openAIImagesPriceTableFor } from '../providers/openai-images/pricing.js';

// ---------------------------------------------------------------------------
// 真实登记处 → 审计输入
// ---------------------------------------------------------------------------

/** 从仓库里的三处登记处收集审计输入（这就是「已注册的 provider」的判据）。 */
function realSources(): CoverageSources {
  return {
    access_path_ids: DEFAULT_ACCESS_PATHS.map((p) => p.id),
    capability_entries: defaultCapabilities().map((c) => ({
      access_path: c.access_path,
      internal: c.internal,
    })),
    route_access_paths: Object.values(defaultRouteTable().aliases).flatMap((a) =>
      a.targets.map((t) => t.access_path),
    ),
  };
}

/**
 * access path → 该路径的价表解析器。
 *
 * **必须是真 loader 的包装**（不是另写一份「哪些模型有价」的清单）：两套真相必然漂移，
 * 而漂移的方向永远是「登记表说覆盖了、loader 说没有」。deepseek.tools.* 两条走
 * pricing.json 的 `tools` 段（按小时 / 按字符），不在 `models` 段，所以直接问 tools 段
 * 有没有那个单价。
 *
 * MiMo 三条**都走 `models` 段**：ASR / TTS 在 MiMo 侧是独立的 model id
 * （`mimo-v2.5-asr` / `mimo-v2.5-tts*`，费率分别是 per_hour / per_10000_characters），
 * 不是 DeepSeek 那种「一个 tts-1 名字 + tools 段一个单价」的形态——所以三家
 * 共用一个 `mimoPriceTableFor` 谓词，问表里有没有这个 model 即可。
 */
const DEEPSEEK_TOOLS = loadDeepSeekPriceTables().tools;
const MIMO_MODELS = loadMiMoPriceTables().tables;
const PRICE_RESOLVERS: Record<string, (model: string) => boolean> = {
  'deepseek.openai-chat': (m) => deepseekPriceTableFor(m) !== undefined,
  'deepseek.anthropic-messages': (m) => deepseekPriceTableFor(m) !== undefined,
  'deepseek.tools.asr': () => DEEPSEEK_TOOLS['asr_per_hour'] !== undefined,
  'deepseek.tools.tts': () => DEEPSEEK_TOOLS['tts_per_10000_characters'] !== undefined,
  'mimo.openai-chat': (m) => mimoPriceTableFor(m, MIMO_MODELS) !== undefined,
  'mimo.tools.asr': (m) => mimoPriceTableFor(m, MIMO_MODELS) !== undefined,
  'mimo.tools.tts': (m) => mimoPriceTableFor(m, MIMO_MODELS) !== undefined,
  'openai.images': (m) => openAIImagesPriceTableFor(m) !== undefined,
};

// ---------------------------------------------------------------------------
// 正向：当前仓库全绿
// ---------------------------------------------------------------------------

describe('计费覆盖审计（60 §4.3 双轨强制）', () => {
  it('遍历真实登记处：没有新的未覆盖 access path', () => {
    const report = auditBillingCoverage(realSources());
    // 红灯消息必须点名——缺的那家一眼看见，这是本机制的全部目的。
    // 断言消息带上完整报告：红的时候输出的是「谁缺了什么、怎么补」，不是一个 diff。
    const message = formatCoverageReport(report);
    expect(
      {
        newGaps: report.newGaps,
        staleBaseline: report.staleBaseline,
        unknownBaseline: report.unknownBaseline,
      },
      message,
    ).toEqual({
      newGaps: [],
      staleBaseline: [],
      unknownBaseline: [],
    });
    // 顺带把三处来源都真的遍历到了（判据失效时这里先红，而不是让上面的断言空转）
    expect(report.checked).toContain('openai.images');
    expect(report.checked).toContain('openai.embeddings');
    expect(report.checked).toContain('deepseek.tools.asr');
    expect(report.checked).toContain('deepseek.tools.tts');
    // MiMo 三条：chat 来自 DEFAULT_ACCESS_PATHS / 矩阵 / 路由表，音频两条只来自
    // 能力矩阵（上游没有独立 REST 端点，见 credentials/resolver.ts 文件头）。
    expect(report.checked).toContain('mimo.openai-chat');
    expect(report.checked).toContain('mimo.tools.asr');
    expect(report.checked).toContain('mimo.tools.tts');
    // mock 脚手架不计入（能力矩阵里 internal: true，见 ir/capability.ts）
    expect(report.checked).not.toContain('mock');
    expect(report.checked).not.toContain('mock-anthropic');
    // 已知缺口仍然被点名（基线不是豁免，是不允许清单变长）
    expect(report.gaps.map((g) => g.access_path)).toEqual(
      KNOWN_UNCOVERED.map((g) => g.access_path).sort(),
    );
  });

  it('已覆盖的 access path 都有真实模块撑着', () => {
    const report = auditBillingCoverage(realSources());
    expect(report.covered).toEqual([
      'deepseek.anthropic-messages',
      'deepseek.openai-chat',
      'deepseek.tools.asr',
      'deepseek.tools.tts',
      'mimo.openai-chat',
      'mimo.tools.asr',
      'mimo.tools.tts',
      'openai.images',
    ]);
    // 登记表条数与覆盖条数一致：多出来的条目说明有 access path 已经不存在了
    expect(BILLING_COVERAGE.map((c) => c.access_path).sort()).toEqual([...report.covered].sort());
  });

  it('模型级：矩阵里每个 implemented 且非 internal 的模型都能定价', () => {
    const report = auditModelPricing({
      entries: defaultCapabilities(),
      resolvers: PRICE_RESOLVERS,
    });
    expect(
      {
        newGaps: report.newGaps,
        staleBaseline: report.staleBaseline,
        unknownBaseline: report.unknownBaseline,
      },
      formatModelPricingReport(report),
    ).toEqual({ newGaps: [], staleBaseline: [], unknownBaseline: [] });
    // 已知的无价模型被点名（同 access path 级：基线内 ≠ 合规）
    expect(report.gaps.map((g) => `${g.access_path}/${g.model}`)).toEqual(
      KNOWN_UNPRICED_MODELS.map((g) => `${g.access_path}/${g.model}`).sort(),
    );
  });

  it('报告渲染会点名 provider 与 access path（红灯时必须看得见是谁）', () => {
    const text = formatCoverageReport(auditBillingCoverage(realSources()));
    expect(text).toContain('openai');
    expect(text).toContain('anthropic');
    expect(text).toContain('openai.embeddings');
    const modelText = formatModelPricingReport(
      auditModelPricing({ entries: defaultCapabilities(), resolvers: PRICE_RESOLVERS }),
    );
    expect(modelText).toContain('gpt-4o');
    expect(modelText).toContain('claude-sonnet-4-5');
  });
});

// ---------------------------------------------------------------------------
// 负向：红灯两端都亮
// ---------------------------------------------------------------------------

describe('负向：新 provider 不给价表 → 红灯并点名', () => {
  it('登记处多出一条没人登记的 access path → newGaps 点名这家 provider', () => {
    const report = auditBillingCoverage({
      ...realSources(),
      access_path_ids: [...realSources().access_path_ids, 'acme.openai-chat'],
    });
    expect(report.newGaps.map((g) => `${g.provider} [${g.access_path}] ${g.reason}`)).toEqual([
      'acme [acme.openai-chat] not-registered',
    ]);
    // 渲染出来的消息里也要有名字（断言消息就是给人看的）
    expect(formatCoverageReport(report)).toContain('acme');
  });

  it('只加能力矩阵条目（不加 access path）同样红——三处判据取并集', () => {
    const report = auditBillingCoverage({
      ...realSources(),
      capability_entries: [
        ...realSources().capability_entries,
        { access_path: 'acme.anthropic-messages' },
      ],
    });
    expect(report.newGaps.map((g) => g.provider)).toEqual(['acme']);
  });

  it('只加路由表 alias 同样红', () => {
    const report = auditBillingCoverage({
      ...realSources(),
      route_access_paths: [...realSources().route_access_paths, 'acme.gemini'],
    });
    expect(report.newGaps.map((g) => g.provider)).toEqual(['acme']);
  });

  it('矩阵加了新模型但价表里没有 → 模型级红灯并点名模型', () => {
    const report = auditModelPricing({
      entries: [
        ...defaultCapabilities(),
        { access_path: 'deepseek.openai-chat', model: 'deepseek-v5-ultra', status: 'implemented' },
      ],
      resolvers: PRICE_RESOLVERS,
    });
    expect(report.newGaps.map((g) => `${g.provider} ${g.access_path} ${g.model}`)).toEqual([
      'deepseek deepseek.openai-chat deepseek-v5-ultra',
    ]);
  });

  it('矩阵加了新模型且整条路径没有 loader → 也是红灯', () => {
    const report = auditModelPricing({
      entries: [
        ...defaultCapabilities(),
        { access_path: 'acme.openai-chat', model: 'acme-1', status: 'implemented' },
      ],
      resolvers: PRICE_RESOLVERS,
    });
    expect(
      report.newGaps.map((g) => `${g.provider} ${g.access_path} ${g.model} ${g.reason}`),
    ).toEqual(['acme acme.openai-chat acme-1 no-pricing-loader']);
  });

  it('planned 的矩阵条目不计入（还没做，不等于不合规）', () => {
    const report = auditModelPricing({
      entries: [
        ...defaultCapabilities(),
        { access_path: 'acme.openai-chat', model: 'acme-1', status: 'planned' },
      ],
      resolvers: PRICE_RESOLVERS,
    });
    expect(report.newGaps).toEqual([]);
  });
});

describe('负向：登记表腐烂永远红灯（不能靠基线盖住）', () => {
  /** 在真实 surface 上多插一条没人管的 access path（模拟"接了新 provider"）。 */
  function withNewPath(accessPath: string): CoverageSources {
    return {
      ...realSources(),
      access_path_ids: [...realSources().access_path_ids, accessPath],
    };
  }

  it('登记了 as_api_table 但文件不在仓库里 → backing-module-missing', () => {
    const report = auditBillingCoverage(withNewPath('acme.openai-chat'), {
      registry: [
        ...BILLING_COVERAGE,
        { access_path: 'acme.openai-chat', as_api_table: 'providers/acme/pricing.ts' },
      ],
    });
    expect(report.newGaps.map((g) => `${g.provider} ${g.reason}`)).toEqual([
      'acme backing-module-missing',
    ]);
    expect(report.newGaps[0]?.detail).toContain('providers/acme/pricing.ts');
  });

  it('登记了却两个口径都没声明（空壳条目）→ no-coverage-declared', () => {
    const report = auditBillingCoverage(withNewPath('acme.openai-chat'), {
      registry: [...BILLING_COVERAGE, { access_path: 'acme.openai-chat', note: '忘了写口径' }],
    });
    expect(report.newGaps.map((g) => `${g.provider} ${g.reason}`)).toEqual([
      'acme no-coverage-declared',
    ]);
  });

  it('腐烂条目即使写进基线也照样红（只有"忘了登记"能进基线）', () => {
    const report = auditBillingCoverage(withNewPath('acme.openai-chat'), {
      registry: [
        ...BILLING_COVERAGE,
        { access_path: 'acme.openai-chat', as_api_table: 'providers/acme/pricing.ts' },
      ],
      known: [
        ...KNOWN_UNCOVERED,
        { access_path: 'acme.openai-chat', since: '2026-11-16', reason: 'x', close_by: 'y' },
      ],
    });
    expect(report.newGaps.map((g) => g.access_path)).toEqual(['acme.openai-chat']);
    expect(report.gaps.map((g) => g.access_path)).toContain('acme.openai-chat');
  });

  it('基线里写了一条已经覆盖的 access path → staleBaseline 红（补了价表必须删基线）', () => {
    const report = auditBillingCoverage(realSources(), {
      known: [
        ...KNOWN_UNCOVERED,
        { access_path: 'openai.images', since: '2026-11-16', reason: 'x', close_by: 'y' },
      ],
    });
    expect(report.staleBaseline).toEqual(['openai.images']);
  });

  it('基线里写了不存在的 access path → unknownBaseline 红（拼错也会被发现）', () => {
    const report = auditBillingCoverage(realSources(), {
      known: [
        ...KNOWN_UNCOVERED,
        { access_path: 'acme.openai-chat', since: '2026-11-16', reason: 'x', close_by: 'y' },
      ],
    });
    expect(report.unknownBaseline).toEqual(['acme.openai-chat']);
  });

  it('模型级基线写错同样会被抓（ stale / unknown 两端）', () => {
    const stale = auditModelPricing({
      entries: defaultCapabilities(),
      resolvers: PRICE_RESOLVERS,
      known: [
        ...KNOWN_UNPRICED_MODELS,
        {
          access_path: 'deepseek.openai-chat',
          model: 'deepseek-flash',
          since: '2026-11-16',
          reason: 'x',
          close_by: 'y',
        },
      ],
    });
    expect(stale.staleBaseline).toEqual(['deepseek.openai-chat/deepseek-flash']);

    const unknown = auditModelPricing({
      entries: defaultCapabilities(),
      resolvers: PRICE_RESOLVERS,
      known: [
        ...KNOWN_UNPRICED_MODELS,
        {
          access_path: 'acme.openai-chat',
          model: 'acme-1',
          since: '2026-11-16',
          reason: 'x',
          close_by: 'y',
        },
      ],
    });
    expect(unknown.unknownBaseline).toEqual(['acme.openai-chat/acme-1']);
  });
});
