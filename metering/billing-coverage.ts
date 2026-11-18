/**
 * metering/billing-coverage.ts —— 「每家 provider 必须有价」的登记表与审计器。
 *
 * 唯一事实来源：docs/design/60-billing-and-dogfooding.md §4.3（双轨强制）。
 *
 * ## 这个文件解决什么问题
 *
 * 计费双口径（`UsageCost { cash, as_api, status }`）在 metering/pricing.ts 里早就建好了，
 * 但「能做到」不等于「必须做到」：接一家新 provider 忘了建价表，它的流量会在用量报表里
 * **静默**变成 `unpriced` / `pending_price`（admin/service.ts 只把它们并进
 * `unpriced_count` 一个计数），成本看不出多少——没有任何东西会红。
 *
 * 本文件把仓库主人的规则变成**会红的东西**：
 *
 *   > 「计费是每个 Provider 能用官方计费就计入，除此之外都要有 `as_api` 作为 API 估值计费。」
 *
 * ## 三条设计决定（为什么这么写）
 *
 * 1. **判据是 access path，不是 provider id**。用户的话是「每个 provider」，但计费真正
 *    分叉的粒度是 **access path**（45 §3：access path = 上游端点 + 凭据 + wire 格式）：
 *    同一个 OpenAI 账号下，`openai`（chat）、`openai.images`、`openai.embeddings` 是三条
 *    不同的端点、三套不同的模型与计费形态，一张 `openai` 级别的「已覆盖」会掩盖
 *    「chat 有价、embeddings 没价」这种半边合规。按 access path 登记**严格强于**按
 *    provider 登记，且 access path id 就是 `<provider>.<dialect>`，随时能还原成 provider
 *    （见文件末尾的 `providerFromAccessPath`）。
 *
 * 2. **判据的来源是「能收到流量的登记处」，不是 presets**。审计遍历三处的并集：
 *    `DEFAULT_ACCESS_PATHS`（credentials/resolver.ts）、能力矩阵里 `implemented` 的条目
 *    （composition-root 的 `defaultCapabilities()` + 同步/发现写入的条目）、路由表 alias
 *    target。**刻意不用 `providers/presets.ts`**：preset 只是管理面「新建渠道」弹窗的
 *    便利预填，其中数条标着 `needs_verification` / `confidence: 'unverified'`，接都没接过
 *    ——拿它当判据会「一加预设就假阳性」，红灯喊多了就没人看了。反过来，上面三处是
 *    「不登记就收不到流量」的地方：路由按矩阵做能力预检、`/v1/models` 按矩阵列清单，
 *    所以新 provider 想真被调用，必然落进其中至少一处。
 *
 * 3. **已知缺口用基线（ratchet），不静默豁免**。今天有 access path 确实既没官方计费也没
 *    价表（见 `KNOWN_UNCOVERED`）。规则说这是**不合规状态**，所以基线不是「算了」：
 *    基线条目必须带 `since` 与 `close_by`，且被三条断言盯着——已覆盖的条目不删会红
 *    （`staleBaseline`）、拼错/已消失的条目会红（`unknownBaseline`）、**新出现的缺口一定红**
 *    （`newGaps`，直接点名）。基线只允许变小，不允许无声变大。
 *
 * ## 本文件的定位
 *
 * 纯登记表 + 纯审计逻辑，`node:fs` 只用来验证「登记表声称的模块真的在仓库里」（防登记表
 * 腐烂：写了 `providers/acme/pricing.ts` 而文件被改名/删掉）。它**不在请求路径上**，
 * 与 scripts/check-docs.mjs 同属仓库级检查；跑法见 tests/billing-coverage.test.ts
 * （`npm test` 的一部分）。管理面建渠道时的运行时红灯是同一个审计器的自然消费者，
 * 接线留待后续（届时本文件从源码树或 dist/ 都能定位仓库根，见 `repoRoot()`）。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一家 access path 的计费覆盖登记。
 *
 * 两个口径**不是二选一的开关**，而是可以同时成立（DeepSeek 就是）：官方余额接口是
 * **对账真值**（`cash` 的事实来源），`as_api` 价表是**估算口径**（没有它连"估算了多少
 * 现金"都算不出来，对账就没有左边那一侧）。订阅路径见 `subscription`。
 */
export interface BillingCoverage {
  /** access path（45 §3）。 */
  access_path: string;
  /**
   * 官方计费 / 余额接口模块（仓库根相对路径，**必须真实存在**）。
   *
   * 有它 ⇒ `cash` 走上游余额对账那条路（metering/reconciliation.ts）。
   * 例：DeepSeek 的 `GET /user/balance`。
   */
  official_balance?: string;
  /**
   * `as_api` 价表 loader 模块（仓库根相对路径，**必须真实存在**）。
   *
   * 有它 ⇒ 该路径的用量能按价表算出等值 API 价值（订阅路径也照算）。
   */
  as_api_table?: string;
  /**
   * 订阅路径（如 MiMo Token Plan）：`cash` 恒 0、`as_api` 照算。
   *
   * **这是标注不是豁免**：订阅路径同样必须登记 `as_api_table`——否则订阅请求在成本
   * 报表里会"消失"，看不出它消耗了多少上游额度（60 §4.2 规则 d）。
   */
  subscription?: boolean;
  /** 人类可读备注（为什么要这个口径、价表有什么特殊形态）。 */
  note?: string;
}

/** 一条已知缺口（基线）。 */
export interface KnownUncovered {
  access_path: string;
  /** 记入基线的日期（ISO date）——基线要有寿命，不能无限期躺平。 */
  since: string;
  /** 为什么现在不合规（一句话说清现状）。 */
  reason: string;
  /** 怎样才能把它从基线里划掉（可执行的关闭条件）。 */
  close_by: string;
}

/** 审计输入：三处「能收到流量」的登记处（见文件头决定 2）。 */
export interface CoverageSources {
  /** `DEFAULT_ACCESS_PATHS` 的 id（credentials/resolver.ts）。 */
  access_path_ids: readonly string[];
  /**
   * 能力矩阵条目。只需要 `access_path` 与 `internal` 两个字段——审计不关心模态/窗口，
   * 窄依赖让「矩阵加字段」永远不影响本文件（同 metering/reconciliation.ts 的立场）。
   */
  capability_entries: readonly CapabilityEntryLike[];
  /** 路由表 alias target 的 access_path（composition-root 的 `defaultRouteTable()`）。 */
  route_access_paths: readonly string[];
}

/** `CapabilityEntry` 的窄投影（本文件只要这两个字段）。 */
export interface CapabilityEntryLike {
  access_path: string;
  /** 矩阵里的 internal 标记（mock 脚手架）：永不计入审计。 */
  internal?: boolean;
}

/** 缺口原因。 */
export type CoverageGapReason =
  /** 登记表里没有这一条——新 provider / 忘了登记。**唯一可以进基线的原因**。 */
  | 'not-registered'
  /** 登记了却两个口径都没声明（空壳条目）——登记表自己坏了，永远红灯。 */
  | 'no-coverage-declared'
  /** 声明了但模块不在仓库里——登记表腐烂（改名/删文件忘了同步），永远红灯。 */
  | 'backing-module-missing';

/** 一条缺口。 */
export interface CoverageGap {
  access_path: string;
  /** provider id（`<provider>.<dialect>` 约定取第一段）。 */
  provider: string;
  reason: CoverageGapReason;
  /** 人类可读细节（点名模块 / 点名缺什么）。 */
  detail: string;
}

/** 审计结果。 */
export interface CoverageReport {
  /** 实际被检查的 access path（去重、排序、已剔除内部脚手架）。 */
  checked: string[];
  /** 有覆盖且登记模块真实存在的 access path。 */
  covered: string[];
  /** 全部缺口（含基线内的已知缺口）。 */
  gaps: CoverageGap[];
  /**
   * **红灯项**：不在基线里的缺口，加上登记表自身腐烂（后两者永远不许进基线）。
   * 空数组 = 这一轮全绿。
   */
  newGaps: CoverageGap[];
  /** 基线里但已经覆盖了的条目——该删基线了（不清就会红）。 */
  staleBaseline: string[];
  /** 基线里但不在被检查集合里的条目——拼错了或那条路径已经没了（红）。 */
  unknownBaseline: string[];
}

// ---------------------------------------------------------------------------
// 登记表（改这里 = 宣告一家 access path 的计费口径）
// ---------------------------------------------------------------------------

/**
 * 计费覆盖登记表。
 *
 * **新增一家 provider 的流程**（60 §4.3）：
 *   1. 把它落进至少一处「能收到流量」的登记处（access path / 能力矩阵 / 路由表）；
 *   2. 在这里加一条：有官方计费/余额接口 → 登记 `official_balance`（模块必须真的存在）；
 *      没有 → 登记 `as_api_table` 指向 `providers/<provider>/pricing.ts`；
 *   3. 跑 `npm test`——第 1 步做了第 2 步忘了，`tests/billing-coverage.test.ts` 直接红灯
 *      并点名这家 provider。
 *
 * 价表纪律（与 presets.ts 的「不编造 base_url」同款）：**不编造价格**。每条价表必须带
 * `source_url`（官方定价页）与 `fetched_at`，数值只能来自官方价格页的快照，拿不准就不建
 * 表、把缺口写进 `KNOWN_UNCOVERED`——建一张编造的价表比没有表更糟（它会让错的钱看起来
 * 像对的，而对账永远对不上）。
 */
export const BILLING_COVERAGE: readonly BillingCoverage[] = [
  {
    access_path: 'deepseek.openai-chat',
    official_balance: 'providers/deepseek/balance.ts',
    as_api_table: 'providers/deepseek/pricing.ts',
    note: '官方余额 GET /user/balance 与 as_api 价表并存：余额是对账真值，价表是估算口径（两者都有才能对账）。',
  },
  {
    access_path: 'deepseek.anthropic-messages',
    official_balance: 'providers/deepseek/balance.ts',
    as_api_table: 'providers/deepseek/pricing.ts',
    note: '同账号同 base、不同 dialect：与 openai-chat 共用余额接口与价表（key 也是同一把）。',
  },
  {
    access_path: 'deepseek.tools.asr',
    as_api_table: 'providers/deepseek/pricing.ts',
    note: '按小时计费（asr_per_hour）。单价在 pricing.json 的 tools 段而不是 models 段——通用引擎按 slot 名认 per_hour。',
  },
  {
    access_path: 'deepseek.tools.tts',
    as_api_table: 'providers/deepseek/pricing.ts',
    note: '按字符计费（tts_per_10000_characters，已含 1 万字符单位；错峰折扣价另有一档）。',
  },
  {
    // MiMo：chat 端与音频端共用同一份 pricing.json（三个 access path 的 model id
    // 互不重叠，`mimoPriceTableFor` 一个 loader 全认）。官方余量客户端两个端点
    // （token_plan / balance）都实现了，按计费路径形态选。
    access_path: 'mimo.openai-chat',
    official_balance: 'providers/mimo/balance.ts',
    as_api_table: 'providers/mimo/pricing.ts',
    note: '同 DeepSeek 的双口径并存：余额是对账真值（仅按量 key sk- 可用），价表是估算口径。**不标 subscription**：订阅与否由 key 前缀判定（tp- 订阅 / sk- 按量，credentials/resolver.ts 的 billingModeFor），同一条 access path 两种形态都能收流量——按 access path 标订阅会把 sk- 的现金支出也记成 0。',
  },
  {
    // 上游没有独立 REST 端点：/v1/audio/* 与 /v1/tools/* 都经同一条 chat completions
    // 按模型分发，所以这条 access path **只在能力矩阵与计量记录里出现**
    // （DEFAULT_ACCESS_PATHS 里不为它单列，见 credentials/resolver.ts 文件头：
    // 单列会是「看起来另一条路、实际同一个端点」的假条目）。审计按能力矩阵取并集，
    // 因此照样要登记——否则这 4 条音频流量会在报表里静默变 unpriced。
    access_path: 'mimo.tools.asr',
    as_api_table: 'providers/mimo/pricing.ts',
    note: '按输入音频时长计费（mimo-v2.5-asr，per_hour ¥0.5/小时；通用引擎按秒除 3600）。',
  },
  {
    access_path: 'mimo.tools.tts',
    as_api_table: 'providers/mimo/pricing.ts',
    note: '按字符计费（per_10000_characters）。三个变体（mimo-v2.5-tts / -voiceclone / -voicedesign）同槽同价，官方标「限时免费」→ 表里记 0 而不是省略（0 是可对账的声明，省略只活在注释里）。',
  },
  {
    access_path: 'openai.images',
    as_api_table: 'providers/openai-images/pricing.ts',
    note: 'gpt-image 系按 token 计费；per_image（按张）形态的定价用例见 tests/openai-images-pricing.test.ts（合成表，不冒充官方价）。',
  },
];

/**
 * 已知缺口（基线 / ratchet）。
 *
 * 每一条都是**当前不合规**的 access path：既没有官方计费/余额接口，也没有 `as_api` 价表，
 * 因此它们的流量今天确实在报表里静默变成 `unpriced`。规则（60 §4.3）说这是不合规状态，
 * 基线的作用是「把已经知道的缺口摆在明面上并防止清单变长」，**不是**豁免：
 * 补上价表不同步删条目会红（staleBaseline），新缺口一定红（newGaps）。
 */
export const KNOWN_UNCOVERED: readonly KnownUncovered[] = [
  {
    access_path: 'openai',
    since: '2026-11-16',
    reason:
      'chat 端点可路由（gpt-4o 在能力矩阵与默认路由表里），但仓库内既没有官方计费/余额接口的实现，也没有 as_api 价表。',
    close_by:
      '建 providers/openai/pricing.json（官方价格页快照 + source_url + fetched_at），并在 BILLING_COVERAGE 登记。',
  },
  {
    access_path: 'openai.embeddings',
    since: '2026-11-16',
    reason:
      'embedding 端点在 DEFAULT_ACCESS_PATHS 里（可收流量），但仓库内既没有官方计费/余额接口的实现，也没有 as_api 价表。',
    close_by: '建 providers/openai-embeddings/pricing.json，并在 BILLING_COVERAGE 登记。',
  },
  {
    access_path: 'anthropic',
    since: '2026-11-16',
    reason:
      'claude-sonnet-4-5 在能力矩阵与默认路由表里，但仓库内既没有官方计费/余额接口的实现，也没有 as_api 价表。',
    close_by:
      '建 providers/anthropic/pricing.json（官方价格页快照 + source_url + fetched_at），并在 BILLING_COVERAGE 登记。',
  },
];

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/**
 * 审计一遍：每家能收到流量的 access path 是否都有价。
 *
 * 纯函数 + 文件存在性检查（`repoRoot()` 解析）。三处来源取并集后剔除内部脚手架
 * （能力矩阵里 `internal: true` 的 access path：mock / mock-anthropic 是演示替身，
 * 不是可调用的上游，见 ir/capability.ts 的字段说明）。
 *
 * `opts` 是**测试缝**：生产调用方（tests/billing-coverage.test.ts 之外将来接运行时红灯的
 * 管理面）一个都不传，用模块常量 `BILLING_COVERAGE` / `KNOWN_UNCOVERED` 作为唯一真相；
 * 只有测试为了构造「登记表腐烂」「基线写错」这类场景才注入替身。不为了可测性把真相拆成
 * 参数默认值——那会让"审计用的是哪份登记表"取决于调用点。
 */
export function auditBillingCoverage(
  sources: CoverageSources,
  opts?: {
    registry?: readonly BillingCoverage[];
    known?: readonly KnownUncovered[];
  },
): CoverageReport {
  const registryEntries = opts?.registry ?? BILLING_COVERAGE;
  const knownEntries = opts?.known ?? KNOWN_UNCOVERED;
  const internal = new Set(
    sources.capability_entries.filter((e) => e.internal === true).map((e) => e.access_path),
  );
  const surface = uniqueSorted([
    ...sources.access_path_ids,
    ...sources.capability_entries.map((e) => e.access_path),
    ...sources.route_access_paths,
  ]).filter((p) => !internal.has(p));

  const registry = new Map(registryEntries.map((c) => [c.access_path, c]));
  const covered: string[] = [];
  const gaps: CoverageGap[] = [];

  for (const accessPath of surface) {
    const entry = registry.get(accessPath);
    if (entry === undefined) {
      gaps.push({
        access_path: accessPath,
        provider: providerFromAccessPath(accessPath),
        reason: 'not-registered',
        detail: 'BILLING_COVERAGE 里没有这一条',
      });
      continue;
    }
    const modules = [entry.official_balance, entry.as_api_table].filter(
      (m): m is string => typeof m === 'string' && m !== '',
    );
    if (modules.length === 0) {
      gaps.push({
        access_path: accessPath,
        provider: providerFromAccessPath(accessPath),
        reason: 'no-coverage-declared',
        detail: '登记了却既没声明 official_balance 也没声明 as_api_table',
      });
      continue;
    }
    const missing = modules.filter((m) => !moduleExists(m));
    if (missing.length > 0) {
      gaps.push({
        access_path: accessPath,
        provider: providerFromAccessPath(accessPath),
        reason: 'backing-module-missing',
        detail: `登记的模块不在仓库里：${missing.join('、')}`,
      });
      continue;
    }
    covered.push(accessPath);
  }

  const known = new Set(knownEntries.map((g) => g.access_path));
  // 只有「忘了登记」可以进基线；登记表自己烂了（空壳条目 / 模块不存在）永远红灯——
  // 否则任何人都能靠往基线里加一行来盖住自己写错的登记。
  const newGaps = gaps.filter((g) => !known.has(g.access_path) || g.reason !== 'not-registered');
  const staleBaseline = knownEntries
    .filter((g) => covered.includes(g.access_path))
    .map((g) => g.access_path);
  const unknownBaseline = knownEntries
    .filter((g) => !surface.includes(g.access_path))
    .map((g) => g.access_path);

  return {
    checked: surface,
    covered: covered.sort(),
    gaps: gaps.sort((a, b) => a.access_path.localeCompare(b.access_path)),
    newGaps: newGaps.sort((a, b) => a.access_path.localeCompare(b.access_path)),
    staleBaseline: staleBaseline.sort(),
    unknownBaseline: unknownBaseline.sort(),
  };
}

/**
 * 把审计结果渲染成人类可读的多行报告（红灯时直接打进断言消息 / 控制台）。
 *
 * 每一行都**点名**：provider（access path 第一段）+ access path + 原因。缺的那家必须
 * 一眼看见，这是本机制的全部目的——流量静默变 `unpriced` 就是因为没人被点名。
 */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(
    `计费覆盖审计：检查 ${report.checked.length} 条 access path，已覆盖 ${report.covered.length} 条`,
  );
  if (report.gaps.length > 0) {
    lines.push('缺口（既没官方计费也没 as_api 价表）：');
    for (const g of report.gaps) {
      const known = report.newGaps.includes(g) ? '' : '（基线内，已知不合规）';
      lines.push(
        `  - ${g.provider}  [${g.access_path}]  ${reasonText(g.reason)}：${g.detail}${known}`,
      );
    }
  }
  if (report.newGaps.length > 0) {
    lines.push(
      '红灯（新缺口 / 登记表腐烂）——修法见 docs/design/60-billing-and-dogfooding.md §4.3：',
    );
    for (const g of report.newGaps) {
      lines.push(`  ✗ ${g.provider}  [${g.access_path}]  ${reasonText(g.reason)}：${g.detail}`);
    }
  }
  if (report.staleBaseline.length > 0) {
    lines.push(
      `基线里已覆盖的条目（请从 KNOWN_UNCOVERED 删掉）：${report.staleBaseline.join('、')}`,
    );
  }
  if (report.unknownBaseline.length > 0) {
    lines.push(`基线里不存在的 access path（拼错或已消失）：${report.unknownBaseline.join('、')}`);
  }
  return lines.join('\n');
}

function reasonText(reason: CoverageGapReason): string {
  switch (reason) {
    case 'not-registered':
      return '未登记';
    case 'no-coverage-declared':
      return '登记表空壳';
    case 'backing-module-missing':
      return '登记模块缺失';
  }
}

// ---------------------------------------------------------------------------
// 模型级审计（access path 之下的那一层：这家有表，但这个模型在表里吗）
// ---------------------------------------------------------------------------

/** 一条已知的「模型无价」缺口（模型级基线）。 */
export interface KnownUnpricedModel {
  access_path: string;
  model: string;
  /** 记入基线的日期（ISO date）。 */
  since: string;
  reason: string;
  close_by: string;
}

/** 模型级缺口原因。 */
export type ModelPricingGapReason =
  /** 这条 access path 根本没有价表 loader（连表都没有）。 */
  | 'no-pricing-loader'
  /** 有 loader，但这个 model 不在表里（新增模型忘了加价）。 */
  | 'model-not-in-table';

/** 一条模型级缺口。 */
export interface ModelPricingGap {
  access_path: string;
  provider: string;
  model: string;
  reason: ModelPricingGapReason;
  detail: string;
}

/** 模型级审计结果。 */
export interface ModelPricingReport {
  /** 实际被检查的 (access_path, model)（已剔除内部脚手架与非 implemented 条目）。 */
  checked: Array<{ access_path: string; model: string }>;
  gaps: ModelPricingGap[];
  /** 红灯项：不在模型级基线里的缺口。 */
  newGaps: ModelPricingGap[];
  /** 基线里但已经有价了的条目（该删基线了）。 */
  staleBaseline: string[];
  /** 基线里但不在被检查集合里的条目（拼错 / 条目已消失）。 */
  unknownBaseline: string[];
}

/**
 * 模型级基线：已知「可路由但算不出钱」的 (access_path, model)。
 *
 * 与 `KNOWN_UNCOVERED` 同性质（ratchet，不是豁免），只是粒度细一层：access path 有覆盖
 * 不代表上面的每个模型都有价——provider 天天发新模型，「矩阵加了模型、价表忘了加」是比
 * 「忘了建整张表」更常见的忘记姿势。
 */
export const KNOWN_UNPRICED_MODELS: readonly KnownUnpricedModel[] = [
  {
    access_path: 'openai',
    model: 'gpt-4o',
    since: '2026-11-16',
    reason: 'openai chat 路径整条未覆盖（见 KNOWN_UNCOVERED 的 openai 条目）。',
    close_by: '建 providers/openai/pricing.json 并收录 gpt-4o。',
  },
  {
    access_path: 'anthropic',
    model: 'claude-sonnet-4-5',
    since: '2026-11-16',
    reason: 'anthropic 路径整条未覆盖（见 KNOWN_UNCOVERED 的 anthropic 条目）。',
    close_by: '建 providers/anthropic/pricing.json 并收录 claude-sonnet-4-5。',
  },
];

/**
 * 逐模型审计：能力矩阵里每条 `implemented` 且非 internal 的条目，它的 model 能不能定价。
 *
 * `resolvers` 由调用方注入——**必须是真 loader 的包装**（如
 * `(m) => deepseekPriceTableFor(m) !== undefined`），不能在调用方另写一套「哪些模型有价」
 * 的清单：两套真相必然漂移，而漂移的方向永远是「登记表说覆盖了、loader 说没有」。
 * 没有 resolver 的 access path 记为 `no-pricing-loader`（确实算不出钱，不是"稍后补"）。
 */
export function auditModelPricing(sources: {
  entries: readonly {
    access_path: string;
    model: string;
    internal?: boolean;
    status?: string;
  }[];
  resolvers: Readonly<Record<string, (model: string) => boolean>>;
  /** 测试缝（生产不传）：模型级基线替身。 */
  known?: readonly KnownUnpricedModel[];
}): ModelPricingReport {
  const knownEntries = sources.known ?? KNOWN_UNPRICED_MODELS;
  const checked: Array<{ access_path: string; model: string }> = [];
  const gaps: ModelPricingGap[] = [];

  for (const e of sources.entries) {
    if (e.internal === true) continue;
    if (e.status !== undefined && e.status !== 'implemented') continue;
    checked.push({ access_path: e.access_path, model: e.model });
    const resolve = sources.resolvers[e.access_path];
    if (resolve === undefined) {
      gaps.push({
        access_path: e.access_path,
        provider: providerFromAccessPath(e.access_path),
        model: e.model,
        reason: 'no-pricing-loader',
        detail: '这条 access path 没有价表 loader（算不出钱）',
      });
      continue;
    }
    if (!resolve(e.model)) {
      gaps.push({
        access_path: e.access_path,
        provider: providerFromAccessPath(e.access_path),
        model: e.model,
        reason: 'model-not-in-table',
        detail: '价表里没有这个 model',
      });
    }
  }

  const key = (g: { access_path: string; model: string }): string => `${g.access_path}/${g.model}`;
  const known = new Set(knownEntries.map(key));
  const checkedKeys = new Set(checked.map(key));
  const newGaps = gaps.filter((g) => !known.has(key(g)));
  // 「已经有价了」只对**仍在被检查集合里**的条目算 stale：条目整个消失（矩阵删了模型）
  // 归 unknownBaseline 管，两边都报会让人以为有两件事要修。
  const staleBaseline = knownEntries
    .filter((k) => checkedKeys.has(key(k)) && !gaps.some((g) => key(g) === key(k)))
    .map(key);
  const unknownBaseline = knownEntries.filter((k) => !checkedKeys.has(key(k))).map(key);

  return {
    checked: checked.sort((a, b) => key(a).localeCompare(key(b))),
    gaps: gaps.sort((a, b) => key(a).localeCompare(key(b))),
    newGaps: newGaps.sort((a, b) => key(a).localeCompare(key(b))),
    staleBaseline: staleBaseline.sort(),
    unknownBaseline: unknownBaseline.sort(),
  };
}

/** 模型级审计结果的人类可读渲染（同 formatCoverageReport 的立场：必须点名）。 */
export function formatModelPricingReport(report: ModelPricingReport): string {
  const lines: string[] = [];
  lines.push(
    `模型级定价审计：检查 ${report.checked.length} 个 (access_path, model)，有价 ${report.checked.length - report.gaps.length} 个`,
  );
  for (const g of report.newGaps) {
    lines.push(
      `  ✗ ${g.provider}  [${g.access_path}]  ${g.model}  ${reasonTextOf(g.reason)}：${g.detail}`,
    );
  }
  for (const g of report.gaps.filter((g) => !report.newGaps.includes(g))) {
    lines.push(
      `  - ${g.provider}  [${g.access_path}]  ${g.model}  ${reasonTextOf(g.reason)}：${g.detail}（基线内，已知不合规）`,
    );
  }
  if (report.staleBaseline.length > 0) {
    lines.push(
      `基线里已经有价的条目（请从 KNOWN_UNPRICED_MODELS 删掉）：${report.staleBaseline.join('、')}`,
    );
  }
  if (report.unknownBaseline.length > 0) {
    lines.push(`基线里不存在的 (access_path, model)：${report.unknownBaseline.join('、')}`);
  }
  return lines.join('\n');
}

function reasonTextOf(reason: ModelPricingGapReason): string {
  return reason === 'no-pricing-loader' ? '无价表 loader' : '模型不在表里';
}

// ---------------------------------------------------------------------------
// 路径工具
// ---------------------------------------------------------------------------

/**
 * provider id ← access path（`<provider>.<dialect>` 约定）。
 *
 * 与 admin/aliases.ts 的同名函数是同一约定、同一实现。**故意不 import**：metering 是旁路
 * 消费者，不能依赖控制面；而管理面将来要 import 本文件的审计器做运行时红灯，反向 import
 * 会成环。三行纯函数，重复的代价小于一次环依赖。
 */
export function providerFromAccessPath(accessPath: string): string {
  const dot = accessPath.indexOf('.');
  return dot === -1 ? accessPath : accessPath.slice(0, dot);
}

/**
 * 仓库根（含 `package.json` 的那一级）。
 *
 * 从 `import.meta.url` 逐级向上找，而不是写死 `new URL('..', import.meta.url)`：后者在
 * `dist/metering/` 下会解析到 `dist/`，登记表里的仓库根相对路径全部验不存在。向上找到
 * `package.json` 为止，源码树与构建产物里都能定位（同 providers/deepseek/pricing.ts 用
 * `new URL('./pricing.json', import.meta.url)` 不依赖 `process.cwd()` 的立场）。
 */
function repoRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 找不到就退到「本文件上一级」——审计只在源码树里跑，这条路实际走不到。
  return fileURLToPath(new URL('..', import.meta.url));
}

/** 登记表里的仓库根相对路径是否真实存在。 */
function moduleExists(repoRelativePath: string): boolean {
  return existsSync(join(repoRoot(), repoRelativePath));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
