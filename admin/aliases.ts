/**
 * admin/aliases.ts —— 别名 / namespace 映射规则与解析器（S2 路由的输入）。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §S2（别名解析 / 候选列表）与
 * 45-credentials.md §3（access path / model_namespace）。
 *
 * ## 为什么单独一个模块而不是塞进 StaticRouter
 *
 * 规则**数据**（哪些别名存在、优先级）属于控制面（admin/），路由**引擎**
 * （怎么用这些规则产出 attempt_plan）属于 gateway-core。把规则类型定义在
 * router.ts、规则实现在 admin/aliases.ts，正好让「控制面能改规则」
 * 而不需要改路由引擎——StaticRouter 只依赖一个 `AliasResolver` 接口
 * （见 gateway-core/router.ts），测试里可整体替换。
 *
 * ## 解析优先级（写死在这里，有测试逐条覆盖）
 *
 * ```text
 * 1. exact     —— 显式别名，全串相等                      （最高）
 * 2. prefix    —— 前缀规则，按 (priority 升序, 模式长度降序) 取第一个命中
 * 3. passthrough —— 原样当作 provider 侧 model id          （最低）
 * ```
 *
 * **为什么 exact 高于 prefix**：显式别名是管理员一个一个建的，意图最强；
 * 前缀规则是批量兜底。若反过来，一条手滑建的宽前缀规则会静默劫持所有显式别名——
 * 而这种劫持在请求路径上是看不见的（只是模型名被换了）。
 *
 * **为什么 prefix 之间按「长度降序」**：`deepseek/` 与 `deepseek/v4/` 同时存在时，
 * 短规则先命中会把 `deepseek/v4/pro` 错误地归到短规则上。长度降序 = 最具体的
 * 规则优先，这是前缀匹配的常规语义（同 CIDR 最长前缀匹配）。
 *
 * **passthrough 为什么存在**：客户端直接传上游 model id（`deepseek-v4-pro`）
 * 是常见用法，不该因为"没建别名"就 400。但它只在**该 model 确实在某个 provider
 * 的能力矩阵里**时才放行（见 `resolve` 的 capability 检查），否则仍报
 * `no_available_provider`——否则任何拼写错误都会被当成一个合法模型名往上游打。
 *
 * ## 通配符
 *
 * 前缀规则的 `pattern` 支持两种形态：
 *   - `namespace/`（以 `/` 结尾）→ 命名空间前缀，如 `deepseek/`；
 *   - `foo*`（以 `*` 结尾）→ 简单通配，`*` 匹配任意剩余部分（**不含** `/`，
 *     所以 `deepseek*` 不会吃掉 `deepseek/v4/pro` 这种带子路径的）。
 *
 * 不支持正则：控制面规则是给人看的，正则的转义与灾难性回溯都是纯负担。
 */

// ---------------------------------------------------------------------------
// 规则数据模型
// ---------------------------------------------------------------------------

/** 目标：一个 (provider, access_path, model) 三元组。 */
export interface AliasTarget {
  provider: string;
  access_path: string;
  model: string;
  /** 模型元数据（压缩插件要用 max_context_tokens）。 */
  max_context_tokens?: number;
}

/** 规则种类。`exact` = 全串相等；`prefix` = 前缀 / 命名空间通配。 */
export type AliasRuleKind = 'exact' | 'prefix';

export interface AliasRule {
  id: string;
  kind: AliasRuleKind;
  /**
   * 匹配串。
   *   - `exact`：完整的客户端模型名，如 `fast`；
   *   - `prefix`：前缀，如 `deepseek/` 或 `deepseek*`。
   */
  pattern: string;
  target: AliasTarget;
  /** 数字越小越优先；同长度前缀按它排序。缺省 100。 */
  priority: number;
  enabled: boolean;
  /** 人类可读备注（进审计）。 */
  note?: string;
}

/** 解析结果的来源（**可观测性**：请求路径上要能回答"这个模型名是怎么来的"）。 */
export type AliasResolutionSource = 'exact' | 'prefix' | 'passthrough';

export interface AliasResolution {
  /** 命中的规则；`passthrough` 时为 undefined。 */
  rule?: AliasRule;
  source: AliasResolutionSource;
  /** 解析出的目标。passthrough 时 model === 客户端原样传入的 model。 */
  target: AliasTarget;
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

/**
 * 能力矩阵的**最小读接口**（不 import 具体实现，避免 admin/ 反向依赖 credentials/）。
 *
 * passthrough 需要它来判断「这个 model id 是否真的存在于某个 access path」。
 */
export interface AliasCapabilityLookup {
  /** 列出某模态下全部能力条目（解析器自己按 model 过滤）。 */
  list(modality: 'chat'): Array<{ access_path: string; model: string; provider?: string }>;
}

export const NOOP_ALIAS_CAPABILITY_LOOKUP: AliasCapabilityLookup = {
  list: () => [],
};

/** S2 用的窄接口（gateway-core/router.ts 只依赖这个）。 */
export interface AliasResolver {
  /** 解析客户端模型名。返回 undefined = 解析不了（调用方报 no_available_provider）。 */
  resolve(model: string, modality: 'chat'): AliasResolution | undefined;
  /** 规则表热更新（管理面 CRUD 后调）。 */
  setRules(rules: AliasRule[]): void;
  /** 当前规则快照（管理面列表用）。 */
  listRules(): AliasRule[];
}

/**
 * 默认解析器。
 *
 * 无状态、可重入、线程安全（Node 单进程下没有锁的问题）；规则整体替换而不是
 * 增量修改——管理面的每一次 CRUD 都产出一份完整规则表，避免「改了一半」的
 * 中间态被请求路径看到。
 */
export class DefaultAliasResolver implements AliasResolver {
  private rules: AliasRule[];

  constructor(
    rules: AliasRule[] = [],
    private readonly capabilities: AliasCapabilityLookup = NOOP_ALIAS_CAPABILITY_LOOKUP,
  ) {
    // 复制一份，防止调用方之后改数组影响到我们
    this.rules = rules.map((r) => ({ ...r }));
  }

  setRules(rules: AliasRule[]): void {
    // 复制一份，防止调用方之后改数组影响到我们
    this.rules = rules.map((r) => ({ ...r }));
  }

  listRules(): AliasRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  resolve(model: string, modality: 'chat'): AliasResolution | undefined {
    if (model.length === 0) return undefined;

    // ---- 1. exact：全串相等，priority 升序取第一个 ----
    const exact = this.rules
      .filter((r) => r.enabled && r.kind === 'exact' && r.pattern === model)
      .sort((a, b) => a.priority - b.priority)[0];
    if (exact !== undefined) {
      return { rule: exact, source: 'exact', target: { ...exact.target } };
    }

    // ---- 2. prefix：命中集合按 (priority 升序, 模式长度降序) 取第一个 ----
    const prefixes = this.rules
      .filter((r) => r.enabled && r.kind === 'prefix' && matchPrefix(r.pattern, model))
      .sort((a, b) => a.priority - b.priority || b.pattern.length - a.pattern.length)[0];
    if (prefixes !== undefined) {
      return { rule: prefixes, source: 'prefix', target: { ...prefixes.target } };
    }

    // ---- 3. passthrough：原样 model id，但要求能力矩阵里真有这个 model ----
    const hit = this.capabilities.list(modality).find((e) => e.model === model);
    if (hit === undefined) return undefined;
    return {
      source: 'passthrough',
      target: {
        provider: hit.provider ?? providerFromAccessPath(hit.access_path),
        access_path: hit.access_path,
        model,
      },
    };
  }
}

/**
 * 前缀 / 通配匹配。
 *
 * - 以 `/` 结尾：命名空间前缀，`startsWith` 即可；
 * - 以 `*` 结尾：通配，`*` 前的部分是固定前缀，剩余部分**不能含 `/`**
 *   （否则 `deepseek*` 会吃掉 `deepseek/v4/pro`，把子路径也吞了）；
 * - 其他：普通 `startsWith`。
 */
export function matchPrefix(pattern: string, model: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern.endsWith('/')) return model.startsWith(pattern);
  if (pattern.endsWith('*')) {
    const head = pattern.slice(0, -1);
    if (!model.startsWith(head)) return false;
    const rest = model.slice(head.length);
    return !rest.includes('/');
  }
  return model.startsWith(pattern);
}

/** 从 access_path 猜 provider：`deepseek.openai-chat` → `deepseek`。 */
export function providerFromAccessPath(accessPath: string): string {
  const dot = accessPath.indexOf('.');
  return dot === -1 ? accessPath : accessPath.slice(0, dot);
}

// ---------------------------------------------------------------------------
// 规则校验（管理面写入前调；坏规则宁可拒掉也不要进路由）
// ---------------------------------------------------------------------------

export interface AliasRuleValidation {
  ok: boolean;
  errors: string[];
}

/**
 * 校验一条规则。
 *
 * 几条不容错的：
 *   - `exact` 的 pattern 不能含 `/` 或 `*`（那是 prefix 的语法，混用会让
 *     「这规则到底怎么匹配」取决于 kind 字段，人看规则时看不出来）；
 *   - `prefix` 的 pattern 不能为空；
 *   - target 三要素必须齐（缺一个就让 attempt_plan 缺字段，错误发生在
 *     **请求路径**上而不是配置时——那是最难查的一类 bug）；
 *   - pattern 不能以 `/` 开头（会被当成绝对路径式的命名空间，语义不清）。
 */
export function validateAliasRule(rule: AliasRule): AliasRuleValidation {
  const errors: string[] = [];
  if (rule.id.length === 0) errors.push('id 不能为空');
  if (rule.pattern.length === 0) errors.push('pattern 不能为空');
  if (rule.pattern.startsWith('/'))
    errors.push('pattern 不能以 / 开头（命名空间前缀不带前导斜杠）');

  if (rule.kind === 'exact') {
    if (rule.pattern.includes('/')) {
      errors.push('exact 规则的 pattern 不应含 /（请改用 prefix 规则表达命名空间）');
    }
    if (rule.pattern.includes('*')) {
      errors.push('exact 规则的 pattern 不应含 *（通配属于 prefix 规则）');
    }
  } else if (!rule.pattern.endsWith('/') && !rule.pattern.endsWith('*')) {
    // prefix 允许任意前缀串，但给个提示：大多数情况下应该用 / 结尾的命名空间
    errors.push('prefix 规则建议以 /（命名空间）或 *（通配）结尾，以便人看懂匹配范围');
  }

  if (rule.target.provider.length === 0) errors.push('target.provider 不能为空');
  if (rule.target.access_path.length === 0) errors.push('target.access_path 不能为空');
  if (rule.target.model.length === 0) errors.push('target.model 不能为空');
  if (!Number.isFinite(rule.priority)) errors.push('priority 必须是有限数字');
  if (rule.target.max_context_tokens !== undefined && rule.target.max_context_tokens <= 0) {
    errors.push('max_context_tokens 必须为正数');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 校验整张规则表：单条校验 + **目标不冲突**。
 *
 * 「目标不冲突」指同一个 pattern + kind 不能有两条 enabled 规则指向不同 target——
 * 那会让解析结果取决于排序，而排序对使用者不可见。同 pattern 同 target 的重复
 * 是允许的（幂等写入）。
 */
export function validateAliasRuleSet(rules: AliasRule[]): AliasRuleValidation {
  const errors: string[] = [];
  const seen = new Map<string, AliasRule>();
  for (const rule of rules) {
    const single = validateAliasRule(rule);
    for (const e of single.errors) errors.push(`[${rule.id || '(无 id)'}] ${e}`);
    if (!rule.enabled) continue;
    const key = `${rule.kind}\u0000${rule.pattern}`;
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, rule);
      continue;
    }
    const same =
      prev.target.provider === rule.target.provider &&
      prev.target.access_path === rule.target.access_path &&
      prev.target.model === rule.target.model;
    if (!same) {
      errors.push(
        `[${rule.id}] 与 [${prev.id}] 的 pattern 相同但 target 不同（${rule.kind}:${rule.pattern}）` +
          '——解析结果会取决于不可见的排序，请合并成一条',
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 默认规则（Phase 1：与 composition-root 的 defaultRouteTable 对齐）
// ---------------------------------------------------------------------------

/**
 * 内置别名 → DeepSeek / OpenAI / Anthropic 的默认映射。
 *
 * 这些是**静态兜底**：管理面建了规则就以管理面为准（setRules 会整体替换）。
 * 之所以保留一份默认值，是为了「没建任何规则也能跑」——`npm run demo` 与
 * 新部署第一次起来时不至于 404。
 */
export function defaultAliasRules(): AliasRule[] {
  return [
    {
      id: 'builtin:deepseek-flash',
      kind: 'exact',
      pattern: 'deepseek-flash',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
        max_context_tokens: 128_000,
      },
      priority: 100,
      enabled: true,
      note: 'DeepSeek 快速档（OpenAI 方言）',
    },
    {
      id: 'builtin:deepseek-v4-pro',
      kind: 'exact',
      pattern: 'deepseek-v4-pro',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-v4-pro',
        max_context_tokens: 128_000,
      },
      priority: 100,
      enabled: true,
      note: 'DeepSeek V4 Pro（OpenAI 方言）',
    },
    {
      id: 'builtin:deepseek-flash-messages',
      kind: 'exact',
      pattern: 'deepseek-flash-messages',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.anthropic-messages',
        model: 'deepseek-flash',
        max_context_tokens: 128_000,
      },
      priority: 100,
      enabled: true,
      note: 'DeepSeek 快速档（Anthropic 方言）',
    },
    {
      id: 'builtin:deepseek-ns',
      kind: 'prefix',
      pattern: 'deepseek/',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
      priority: 100,
      enabled: true,
      note: 'deepseek/<model> 命名空间兜底（未显式建别名时用）',
    },
  ];
}
