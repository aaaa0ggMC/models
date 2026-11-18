/**
 * storage/redaction.ts —— 脱敏引擎（纯函数 + 规则编译）。
 *
 * 落点说明：`docs/design/00-overview.md` §4.2 给 `storage/` 的职责就含「脱敏」，
 * 因此引擎放这里而不是新开顶层模块。插件侧的包装（工具结果脱敏）在
 * `plugins/redaction-host.ts`，前端同款实现在 `webui/admin/src/api/redaction.ts`
 * （两边一致性由 tests/redaction-parity.test.ts 用同一批向量守住）。
 *
 * 设计依据：docs/design/95-agent-chat.md §5。
 *
 * ## 三层判定（95 §5.1）
 *
 * 1. **内置权威规则**：`BUILTIN_REDACTION_RULES` + `looksLikeSecretValue` 的值形状判据。
 *    代码里写死，设置项里没有它，因此结构上移除不掉。
 * 2. **数据规则**：设置项 `agent_redaction_rules` 里的 `RedactionRule[]`。
 * 3. **用户 JS 判定函数**：只在浏览器里跑（见下）。
 *
 * 三层并列，任一命中即替换。服务端执行 1 + 2，前端执行 1 + 2 + 3。
 *
 * ## 为什么服务端不执行用户 JS
 *
 * 架构事实，不是安全警告：服务端执行用户提交的代码等于把远程代码执行接进网关；
 * 同一段代码在浏览器里跑只影响用户自己的标签页。所以用户 JS 的命中由客户端在发送前
 * 替换，服务端仍用自己的权威规则兜底（客户端被绕过时依然生效）。
 *
 * ## 判据（与 webui/admin/src/api/client.ts 的 looksLikeSecretValue 同款）
 *
 * 以**值的形状**判断，不看字段名——字段名从来不是可靠的泄漏信号（设置项标识符
 * 历史上就叫 `key`，与虚拟 key 域撞名，只认字段名那次把整个设置页误拦了）。
 * 随机位字符集比 client.ts 放宽到含 `-` `_` `.`：真实 provider key 的随机位含这些
 * 字符（`sk-ant-api03-…`、`sk-ag-<base64url>`），不收进来等于漏掉一整类真 key。
 */

/** 一条脱敏规则（数据形态，服务端与前端都能执行）。 */
export interface RedactionRule {
  /** 稳定 id（新增时由调用方生成）。 */
  id: string;
  /** 正则源码。 */
  pattern: string;
  /** 正则标志，只允许 `g` `i` `m` `s` `u` 的子集。 */
  flags: string;
  /** 替换文本；缺省用配置里的占位符。 */
  replacement?: string;
  enabled: boolean;
  note?: string;
  /** 只读视图用：true = 内置权威规则，不可删不可改。 */
  builtin?: boolean;
}

/** 一次命中（区间为**原文本**上的下标，替换后调用方自己重算）。 */
export interface RedactionRange {
  start: number;
  end: number;
  /** 命中该区间的规则 id（内置规则用 `builtin:` 前缀）。 */
  rule_id: string;
  /** 这条规则要把区间换成什么。 */
  replacement: string;
}

/** 脱敏配置：占位符 + 数据规则 + 工具结果是否也脱敏。 */
export interface RedactionConfig {
  /** 默认替换文本（`<redacted_key>`）。 */
  placeholder: string;
  /** 数据规则（不含内置；内置规则在代码里）。 */
  rules: RedactionRule[];
  /** 工具结果是否也脱敏（95 §7.1；默认开）。 */
  redactToolResults: boolean;
}

/** 空配置：只有占位符，没有任何数据规则。 */
export function emptyRedactionConfig(
  placeholder = '<redacted_key>',
  redactToolResults = true,
): RedactionConfig {
  return { placeholder, rules: [], redactToolResults };
}

// ---------------------------------------------------------------------------
// 值形状判据
// ---------------------------------------------------------------------------

/**
 * 已知的**完整密钥前缀**（按各 provider 的 key 格式维护；接新 provider 时往里加）。
 *
 * 后面必须跟 ≥8 位随机位才算数：`sk-` / `sk-ant-` 这种**前缀本身**和 `sk-ag-mV` 这种
 * **掩码用的前 8 位**都不算泄漏。
 */
const KEY_PREFIX_RE =
  /^(?:sk-ag-|sk-ant-|sk-proj-|sk-|rk-|gh[pousr]_|github_pat_|glpat-|xox[bpsa]-|npm_|shpat_|hf_|AIza|AKIA|ASIA|dapi|sk_live_|pk_live_)[A-Za-z0-9][A-Za-z0-9._-]{7,}$/;

/** 没有已知前缀时，按「一长串无分隔符 base62」判的最小长度。 */
const MIN_OPAQUE_LEN = 20;

/** 看起来已被掩码过（含 * 或 …）的值不算泄漏。 */
export function looksMasked(value: string): boolean {
  return /[*…•]/.test(value);
}

/**
 * **值的形状**是否就是一把完整密钥。与字段名无关。
 *
 * 两类形态算泄漏：
 *   1. 已知密钥前缀 + ≥8 位随机位（`sk-ag-` + 32 位随机、`AIza…`、`ghp_…`）；
 *   2. 一长串无分隔符的 base62，且大小写与数字俱全（随机凭据的典型形态）。
 *
 * 刻意**不算**泄漏的形状（都是管理面响应里真实存在的值，误报会让界面充满假红）：
 *   - 带 `_` / `-` / `.` / `:` 的结构化标识：`req_01J…`、`cred_…`、`dek_ab12…`、
 *     `env:AG_OPENAI_API_KEY`、`deepseek.openai-chat`；
 *   - 十六进制指纹（`kek_fingerprint` 16 位，且不带大写字母）；
 *   - 版本号（`0.1.0`）与 UUID（带 `-`；32 位纯小写十六进制没有大写）；
 *   - 掩码值（`sk-****6789`）与前导位（`head`，比前缀阈值短）。
 */
export function looksLikeSecretValue(value: string): boolean {
  if (value.length < 12 || looksMasked(value)) return false;
  if (KEY_PREFIX_RE.test(value)) return true;
  if (value.length < MIN_OPAQUE_LEN) return false;
  if (!/^[A-Za-z0-9]+$/.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

// ---------------------------------------------------------------------------
// 候选串切分（正文里的密钥不会刚好是一个完整 token）
// ---------------------------------------------------------------------------

/**
 * 切词分隔符：空白 + 一组不会出现在密钥里的标点。
 *
 * 刻意**不含** `-` `_` `.` `+` `/` `@` `#` `$` `%` `^` `&` `~` `?` `=` 前面的
 * `+ / @ # $ % ^ & ~ ?`——密钥与 base64 里都可能有。`=` 单列是因为表单里
 * `key=sk-xxx` 很常见，而密钥本身不含 `=`。
 */
const SPLIT_RE = /([\s"'`,;()[\]{}<>|\\=]+)/;

/** 候选串首尾要剥掉的句读（不含掩码字符 `*` `…`——剥了会把掩码判成密钥）。 */
const EDGE_PUNCT_RE = /^[.,;:!?'"`()[\]{}<>|\\-]+|[.,;:!?'"`()[\]{}<>|\\-]+$/g;

/** 一个候选串在原文本里的位置。 */
interface Candidate {
  start: number;
  end: number;
  value: string;
}

/**
 * 从正文里挑出「可能是密钥」的候选串及其区间。
 *
 * 先按分隔符切块（`split` 带捕获组，分隔符也在结果里，因此下标对得上），
 * 再剥掉首尾句读。含 `*` / `…` 的候选串整体跳过——那是掩码，不是泄漏。
 */
export function secretCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const pieces = text.split(SPLIT_RE);
  let cursor = 0;
  for (const piece of pieces) {
    const pieceStart = cursor;
    cursor += piece.length;
    if (piece === '' || SPLIT_RE.test(piece)) continue;
    if (looksMasked(piece)) continue; // 掩码值整体跳过（先判再剥标点）
    const trimmed = piece.replace(EDGE_PUNCT_RE, '');
    if (trimmed === '') continue;
    const start = pieceStart + piece.indexOf(trimmed);
    out.push({ start, end: start + trimmed.length, value: trimmed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 规则编译
// ---------------------------------------------------------------------------

/** 正则标志白名单。`y`（sticky）与 `d`（indices）对 matchAll 语义有害，不收。 */
const ALLOWED_FLAGS_RE = /^[gimsu]{0,5}$/;

export class RedactionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactionRuleError';
  }
}

/** 校验一条数据规则；不合法时抛 `RedactionRuleError`（调用方转成 400）。 */
export function validateRedactionRule(rule: unknown): RedactionRule {
  if (rule === null || typeof rule !== 'object') {
    throw new RedactionRuleError('规则必须是对象');
  }
  const r = rule as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || r['id'].length === 0) {
    throw new RedactionRuleError('规则缺少 id');
  }
  if (typeof r['pattern'] !== 'string' || r['pattern'].length === 0) {
    throw new RedactionRuleError(`规则 ${r['id']} 缺少 pattern`);
  }
  const flags = r['flags'] === undefined ? 'g' : r['flags'];
  if (typeof flags !== 'string' || !ALLOWED_FLAGS_RE.test(flags)) {
    throw new RedactionRuleError(`规则 ${r['id']} 的 flags 只允许 g i m s u 的组合`);
  }
  if (r['replacement'] !== undefined && typeof r['replacement'] !== 'string') {
    throw new RedactionRuleError(`规则 ${r['id']} 的 replacement 必须是字符串`);
  }
  try {
    new RegExp(r['pattern'], flags);
  } catch (err) {
    throw new RedactionRuleError(
      `规则 ${r['id']} 的正则编译失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    id: r['id'],
    pattern: r['pattern'],
    flags,
    ...(r['replacement'] === undefined ? {} : { replacement: r['replacement'] }),
    enabled: r['enabled'] !== false,
    ...(typeof r['note'] === 'string' && r['note'].length > 0 ? { note: r['note'] } : {}),
  };
}

/** 校验一组数据规则；返回规范化后的规则数组（顺序不变）。 */
export function validateRedactionRules(rules: unknown): RedactionRule[] {
  if (!Array.isArray(rules)) throw new RedactionRuleError('规则必须是数组');
  return rules.map((r) => validateRedactionRule(r));
}

// ---------------------------------------------------------------------------
// 内置权威规则（数据形态，供前端取用；服务端与前端执行同一份）
// ---------------------------------------------------------------------------

/**
 * 内置权威规则。
 *
 * 表达成数据形态只是为了「前端能拿到同一份」；它们在代码里，不在设置项里，
 * 因此用户删不掉。`pattern` 与 `looksLikeSecretValue` 的判据一一对应。
 */
export const BUILTIN_REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: 'builtin:known-key-prefix',
    pattern:
      '\\b(?:sk-ag-|sk-ant-|sk-proj-|sk-|rk-|gh[pousr]_|github_pat_|glpat-|xox[bpsa]-|npm_|shpat_|hf_|AIza|AKIA|ASIA|dapi|sk_live_|pk_live_)[A-Za-z0-9][A-Za-z0-9._-]{7,}',
    flags: 'g',
    enabled: true,
    builtin: true,
    note: '已知 provider 密钥前缀 + ≥8 位随机位',
  },
  {
    id: 'builtin:opaque-base62',
    pattern: '(?<![A-Za-z0-9])[A-Za-z0-9]{20,}(?![A-Za-z0-9])',
    flags: 'g',
    enabled: true,
    builtin: true,
    note: '长串 base62 混合字符',
  },
];

// ---------------------------------------------------------------------------
// 命中判定
// ---------------------------------------------------------------------------

/**
 * 合并重叠区间。
 *
 * 稳定排序只按 `start`：同起点时**先 push 的赢**，而内置规则先 push，因此内置权威
 * 规则永远不会被用户规则抢走一段已判定为密钥的文本。区间取并集，但身份与替换文本
 * 保留先命中那一条（默认替换文本相同，只有用户规则自定义了 replacement 时才看得出差别）。
 */
function mergeRanges(ranges: RedactionRange[]): RedactionRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: RedactionRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && r.start < last.end) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

/**
 * 在正文里找出所有命中区间（**原文本下标**）。
 *
 * 顺序即优先级：内置权威规则 → 数据规则。重叠时先命中的赢，因此内置规则永远
 * 不会被用户规则「抢走」一段已经判定为密钥的文本。
 */
export function findSecretRanges(text: string, config: RedactionConfig): RedactionRange[] {
  if (text.length === 0) return [];
  const found: RedactionRange[] = [];

  // 1) 内置：值形状判据（token 级，比正则更准——不会把 URL 里的一段当成密钥）
  for (const c of secretCandidates(text)) {
    if (!looksLikeSecretValue(c.value)) continue;
    found.push({
      start: c.start,
      end: c.end,
      rule_id: 'builtin:value-shape',
      replacement: config.placeholder,
    });
  }

  // 2) 内置：数据形态的那两条（与 1 同源，覆盖「嵌在更长串里」的场景）
  for (const rule of BUILTIN_REDACTION_RULES) {
    if (!rule.enabled) continue;
    const re = new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`);
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (rule.id === 'builtin:opaque-base62' && !looksLikeSecretValue(m[0])) continue;
      found.push({
        start,
        end,
        rule_id: rule.id,
        replacement: rule.replacement ?? config.placeholder,
      });
    }
  }

  // 3) 数据规则
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags.includes('g') ? rule.flags : `${rule.flags}g`);
    } catch {
      continue; // 保存时校验过；运行期坏规则跳过而不是让整条消息失败
    }
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      found.push({
        start,
        end: start + m[0].length,
        rule_id: rule.id,
        replacement: rule.replacement ?? config.placeholder,
      });
    }
  }

  return mergeRanges(found);
}

/** 脱敏一段文本，返回新文本与被替换的处数。 */
export function redactText(
  text: string,
  config: RedactionConfig,
): { text: string; replaced: number } {
  const ranges = findSecretRanges(text, config);
  if (ranges.length === 0) return { text, replaced: 0 };
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    out += text.slice(cursor, r.start) + r.replacement;
    cursor = r.end;
  }
  out += text.slice(cursor);
  return { text: out, replaced: ranges.length };
}

/**
 * 递归脱敏一个 JSON 状值（工具结果、任意对象 / 数组 / 字符串）。
 *
 * 键名不动——键名不是泄漏面，改键名会破坏结构。数字 / 布尔 / null 原样返回。
 */
export function redactUnknown<T>(value: T, config: RedactionConfig): T {
  if (typeof value === 'string') return redactText(value, config).text as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => redactUnknown(v, config)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactUnknown(v, config);
    }
    return out as unknown as T;
  }
  return value;
}
