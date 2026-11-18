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
 * 1. exact      —— 显式别名，全串相等                      （最高）
 * 2. namespace  —— provider 配置的 namespace 前缀            （中）
 * 3. prefix     —— 前缀规则，按 (priority 升序, 模式长度降序) 取第一个命中
 * 4. passthrough —— 原样当作 provider 侧 model id          （最低）
 * ```
 *
 * **为什么 exact 高于 namespace/prefix**：显式别名是管理员一个一个建的，意图最强；
 * 前缀规则是批量兜底。若反过来，一条手滑建的宽前缀规则会静默劫持所有显式别名——
 * 而这种劫持在请求路径上是看不见的（只是模型名被换了）。
 *
 * **为什么 namespace 高于 prefix**：namespace 是 provider 配置的一部分（"这个渠道的
 * 模型都挂在 `<ns>/` 下"），它对应的是**一组确定的模型**；通用前缀规则是"前缀相同就
 * 都归我"的宽匹配。把窄的、有归属的规则放在前面，才不会出现"我明明给 A 渠道配了
 * namespace，请求却被一条一年前建的宽前缀规则带去 B 渠道"。
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

import type { ModalityKind } from '../ir/modality.js';

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

/**
 * namespace 规则（**由 provider 配置派生**，不是管理员在别名页手建的规则）。
 *
 * 语义：provider 配置里填了 `namespace: "ds"`，它的模型就能用 `<ns>/<model>` 访问
 * （生效名 = `ds/deepseek-flash`）。namespace 留空 = 现状行为（无前缀）。
 *
 * 与 `AliasRule`（prefix）的三条本质差异，也是它必须单独一条通道的原因：
 *   1. **归属确定**：namespace 属于某一个 provider，模型必须在那个 provider 的
 *      access path 上真的存在（查能力矩阵）才命中——prefix 规则是"前缀相同就归我"，
 *      不管目标模型在不在；
 *   2. **不手建**：它随 provider 配置的增删改自动增删改，管理员在别名页看不见也
 *      删不掉（删了会在下次 provider 保存时复活，那种"鬼规则"比没有更糟）；
 *   3. **优先级更高**：见文件头的优先级表（exact > namespace > prefix > passthrough）。
 */
export interface NamespaceRule {
  /** namespace 字符串（不含 `/`），如 `ds`。 */
  namespace: string;
  /** 归属的 provider id（admin 存储里的 ProviderConfig.id）。 */
  provider: string;
  /**
   * 该 namespace 生效的 access path 清单。
   *
   * 由 provider 配置的 dialect 推导（`<provider>.<dialect 点换横线>`），正常只有一条；
   * 留空数组 = 该 namespace 暂不可解析（provider 还没登记模型）。
   */
  access_paths: string[];
  enabled: boolean;
  /** 人类可读备注（进审计；不进请求路径）。 */
  note?: string;
}

/** 解析结果的来源（**可观测性**：请求路径上要能回答"这个模型名是怎么来的"）。 */
export type AliasResolutionSource = 'exact' | 'namespace' | 'prefix' | 'passthrough';

export interface AliasResolution {
  /** 命中的规则；`passthrough` / `namespace` 时为 undefined（namespace 见 `namespace` 字段）。 */
  rule?: AliasRule;
  source: AliasResolutionSource;
  /** 命中的 namespace 规则（仅 source === 'namespace'）。 */
  namespace?: NamespaceRule;
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
  /**
   * 列出某模态下全部能力条目（解析器自己按 model 过滤）。
   *
   * 形参是 `ModalityKind` 而不是 `'chat'`：独立工具端点（tts / asr）的模型解析
   * 复用同一个解析器（见 http/audio-endpoint.ts 的 resolveAudioModel），
   * 它们的能力条目按 modality 分槽，不放开就等于给它们另造一套优先级逻辑。
   */
  list(modality: ModalityKind): Array<{ access_path: string; model: string; provider?: string }>;
}

export const NOOP_ALIAS_CAPABILITY_LOOKUP: AliasCapabilityLookup = {
  list: () => [],
};

/** S2 用的窄接口（gateway-core/router.ts 只依赖这个）。 */
export interface AliasResolver {
  /** 解析客户端模型名。返回 undefined = 解析不了（调用方报 no_available_provider）。 */
  resolve(model: string, modality: ModalityKind): AliasResolution | undefined;
  /** 规则表热更新（管理面 CRUD 后调）。 */
  setRules(rules: AliasRule[]): void;
  /** 当前规则快照（管理面列表用）。 */
  listRules(): AliasRule[];
  /**
   * namespace 规则热更新（provider 增删改后调）。
   *
   * 与 `setRules` 分开是因为两者**生命周期不同**：别名规则由管理员手建手删，
   * namespace 规则由 provider 配置派生。混在一张表里会出现"我删了它又复活"的
   * 鬼规则（下次保存任何 provider 都会把整张表重算一遍）。
   */
  setNamespaces(rules: NamespaceRule[]): void;
  /** 当前 namespace 规则快照（管理面 / 目录用）。 */
  listNamespaces(): NamespaceRule[];
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
  private namespaces: NamespaceRule[];

  constructor(
    rules: AliasRule[] = [],
    private readonly capabilities: AliasCapabilityLookup = NOOP_ALIAS_CAPABILITY_LOOKUP,
  ) {
    // 复制一份，防止调用方之后改数组影响到我们
    this.rules = rules.map((r) => ({ ...r }));
    this.namespaces = [];
  }

  setRules(rules: AliasRule[]): void {
    // 复制一份，防止调用方之后改数组影响到我们
    this.rules = rules.map((r) => ({ ...r }));
  }

  listRules(): AliasRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  setNamespaces(rules: NamespaceRule[]): void {
    this.namespaces = rules.map((r) => ({ ...r, access_paths: [...r.access_paths] }));
  }

  listNamespaces(): NamespaceRule[] {
    return this.namespaces.map((r) => ({ ...r, access_paths: [...r.access_paths] }));
  }

  resolve(model: string, modality: ModalityKind): AliasResolution | undefined {
    if (model.length === 0) return undefined;

    // ---- 1. exact：全串相等，priority 升序取第一个 ----
    const exact = this.rules
      .filter((r) => r.enabled && r.kind === 'exact' && r.pattern === model)
      .sort((a, b) => a.priority - b.priority)[0];
    if (exact !== undefined) {
      return { rule: exact, source: 'exact', target: { ...exact.target } };
    }

    // ---- 2. namespace：`<ns>/<model>`，模型必须在该 provider 的 access path 上真实存在 ----
    //
    // 为什么要求"真实存在"而不是"前缀匹配就归它"：namespace 的语义是"这个渠道的
    // 模型"，客户端打错一个字母时应该拿到一个明确的 no_available_provider，而不是
    // 被静默路由到上游再收一个上游 400（那种错误在网关侧 trace 里一切正常）。
    // 与 passthrough 同立场：能力矩阵是"这个模型到底存不存在"的唯一事实来源。
    const namespaced = this.resolveNamespace(model, modality);
    if (namespaced !== undefined) {
      return {
        source: 'namespace',
        namespace: { ...namespaced.rule, access_paths: [...namespaced.rule.access_paths] },
        target: namespaced.target,
      };
    }

    // ---- 3. prefix：命中集合按 (priority 升序, 模式长度降序) 取第一个 ----
    const prefixes = this.rules
      .filter((r) => r.enabled && r.kind === 'prefix' && matchPrefix(r.pattern, model))
      .sort((a, b) => a.priority - b.priority || b.pattern.length - a.pattern.length)[0];
    if (prefixes !== undefined) {
      return { rule: prefixes, source: 'prefix', target: { ...prefixes.target } };
    }

    // ---- 4. passthrough：原样 model id，但要求能力矩阵里真有这个 model，且该 access_path 未启用 namespace ----
    const namespacedPaths = new Set(this.namespaces.flatMap((ns) => ns.access_paths));
    const hit = this.capabilities
      .list(modality)
      .find((e) => e.model === model && !namespacedPaths.has(e.access_path));
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

  /**
   * namespace 解析：`<ns>/<rest>` → 该 provider 的 (access_path, rest)。
   *
   * 三个"不命中"的分支都**落回**（返回 undefined 让调用方继续走 prefix / passthrough），
   * 不抛不错：
   *   - 模型名里没有 `/`，或 `/` 在首位（`/foo` 不是 namespace 形态）；
   *   - 前缀不是任何已配置的 namespace；
   *   - 是 namespace，但 `<rest>` 不在该 provider 的 access path 上（模型未登记）。
   */
  private resolveNamespace(
    model: string,
    modality: ModalityKind,
  ): { rule: NamespaceRule; target: AliasTarget } | undefined {
    const slash = model.indexOf('/');
    if (slash <= 0) return undefined;
    const prefix = model.slice(0, slash);
    const rest = model.slice(slash + 1);
    if (rest === '') return undefined;

    const rule = this.namespaces.find((n) => n.enabled && n.namespace === prefix);
    if (rule === undefined) return undefined;
    if (rule.access_paths.length === 0) return undefined;

    const entry = this.capabilities
      .list(modality)
      .find((e) => e.model === rest && rule.access_paths.includes(e.access_path));
    if (entry === undefined) return undefined;

    return {
      rule,
      target: {
        provider: entry.provider ?? rule.provider,
        access_path: entry.access_path,
        model: rest,
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

// ---------------------------------------------------------------------------
// namespace 校验（provider 保存前调；坏 namespace 宁可拒掉也不要进路由）
// ---------------------------------------------------------------------------

/**
 * namespace 的合法字符集。
 *
 * 约束来源不是审美，是两条硬事实：
 *   1. 生效名是 `<ns>/<model>`，而解析按**第一个 `/`** 切分——ns 里含 `/` 会让
 *      "哪一段是 namespace"取决于切分规则，人看配置时看不出来；
 *   2. ns 会进 access path 推导（`<provider>.<dialect>` 之外的查询键）与
 *      `/v1/models` 的响应字段，出现空格 / 中文 / 大写会让不同客户端各编码一遍。
 *
 * 首字符必须是字母或数字：避免 `-ds` / `.ds` 这种以分隔符开头的串在日志与
 * URL 里被当成另一个 token。
 */
export const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** 校验一个 namespace 字符串（空串 = 不启用 namespace，是合法值）。 */
export function validateNamespace(namespace: string): AliasRuleValidation {
  const errors: string[] = [];
  if (namespace === '') return { ok: true, errors };
  if (namespace.length > 32) errors.push('namespace 最长 32 字符');
  if (namespace !== namespace.trim()) errors.push('namespace 不能带首尾空白');
  if (namespace.includes('/')) errors.push('namespace 不能含 /（生效名是 <namespace>/<模型名>）');
  if (!NAMESPACE_PATTERN.test(namespace)) {
    errors.push('namespace 只能含字母/数字/点/中划线/下划线，且以字母或数字开头');
  }
  return { ok: errors.length === 0, errors };
}

/** `<provider>.<dialect>` 的 access path 推导（dialect 的点换成横线，与 DeepSeek 现状一致）。 */
export function accessPathIdForDialect(provider: string, dialect: string): string {
  return `${provider}.${dialect.replace('.', '-')}`;
}

/**
 * `accessPathIdForDialect` 的逆运算：从 access path 取回 dialect。
 *
 * 存在的理由：管理面 HTTP 契约里前端给的是 access_path_id（`deepseek.anthropic-messages`），
 * 而 provider 发现端口要的是 dialect（`anthropic.messages`）。以前这两边从没转过，
 * 于是「获取模型」拿着错 dialect 推路径， Anthropic 面的 `/models` 根本打不对。
 */
export function dialectFromAccessPath(accessPath: string): string {
  const dot = accessPath.indexOf('.');
  if (dot === -1) return accessPath;
  return accessPath.slice(dot + 1).replace(/-/g, '.');
}

/** provider id 是否适合做 access path 前缀（含点/斜杠的 id 会造出歧义 access path）。 */
export function isAccessPathSafeProviderId(providerId: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,47}$/.test(providerId);
}
