#!/usr/bin/env node
/**
 * check-ui-copy.mjs — 管理面 UI 文案扫描（把解释性文字从界面上揪出来）
 *
 * 背景（为什么值得一个脚本）：仓库主人多次要求「把解释性文字从界面挪走」，修了无数次仍在漏——
 * 这条纪律此前没有任何强制机制，全靠执行者自觉。本脚本就是那道机制：`npm test` 里包一层
 * （tests/ui-copy-check.test.ts），新增一条未被豁免的可疑文案直接红灯。
 *
 * 扫什么：webui/admin/src 下所有**用户可见**的中文串——JSX 文本节点、字符串字面量
 * （含模板字面量的静态段）。排除：注释、*.test.ts(x)、pages/Help.tsx（帮助页是解释性
 * 文字的唯一集中地，本来就该长）。
 *
 * 启发式（命中任意一条即「疑似」）：
 *   1. 长文案：CJK 字数 > --max-length（默认 12）；
 *   2. 解释性模式：因为 / 所以 / 只是 / 会自动 / 不回显 / 不需要 / 只有…才 / 默认 /
 *      建议 / 用于 / 表示 / 注： / 详见 / 不会 / 不能 / 无法 …（因果、弱化、定义、指针、
 *      后果五类，见 EXPLANATORY）；
 *   3. 内部术语：canonical / AG-IR / S0 / pipeline / 透传 / dialect / codec / KEK / DEK /
 *      env_ref / access_path / model_source / stale …——用户不该在界面上看见这些。
 *
 * 豁免（避免误杀必要的空状态 / 错误反馈 / 安全提示）：
 *   - 行尾（或上一行）注释：`// ui-copy: allow <理由>`；JSX 里把同样内容写进
 *     花括号包着的块注释（ui-copy: allow 前后各自带块注释定界符）；
 *   - 清单文件（默认 webui/admin/src/.ui-copy-allow.json）：
 *     [{ "file": "webui/admin/src/x.tsx", "line": 12, "reason": "…" }]
 *     （file 必填；line 与 text 二选一，text 为子串匹配）。
 *   豁免必须带理由——理由会打进报告；没写理由的豁免会被当成错误报出来。
 *
 * 退出码：0 = 未豁免疑似数 ≤ --threshold（默认 0）；1 = 超了（或豁免没写理由）。
 *
 * 用法：
 *   node scripts/check-ui-copy.mjs                    # 人类可读清单
 *   node scripts/check-ui-copy.mjs --json             # JSON（报告 / 工具用）
 *   node scripts/check-ui-copy.mjs --max-length 16    # 调长度阈值
 *   node scripts/check-ui-copy.mjs --threshold 3      # 允许 3 条未豁免疑似
 *   node scripts/check-ui-copy.mjs --root DIR         # 以 DIR 为仓库根（测试用）
 *   node scripts/check-ui-copy.mjs --allowlist FILE   # 换豁免清单文件
 *   node scripts/check-ui-copy.mjs --verbose          # 连未命中的串一起打印
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argValue = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const hasFlag = (name) => process.argv.includes(name);

const ROOT = resolve(argValue('--root', resolve(HERE, '..')));
const SRC = join(ROOT, 'webui', 'admin', 'src');
const ALLOWLIST = resolve(argValue('--allowlist', join(SRC, '.ui-copy-allow.json')));
const MAX_LENGTH = Number(argValue('--max-length', 12));
const THRESHOLD = Number(argValue('--threshold', 0));
const AS_JSON = hasFlag('--json');
const VERBOSE = hasFlag('--verbose');

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/** 不扫描的文件：帮助页（解释性文字的家）与测试。 */
const EXCLUDED_BASENAMES = new Set(['Help.tsx']);
const isExcluded = (file) => EXCLUDED_BASENAMES.has(basename(file)) || /\.test\.tsx?$/.test(file);

/** CJK 及相关表意文字 / 全角标点（「字数」的计数口径）。 */
const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff65]/g;

const countCjk = (s) => (s.match(CJK_CHAR) ?? []).length;

/** 解释性模式 → 原因标签。只对 ≥4 字的串生效（标签 / 按钮不是散文），且不作用于
 *  占位符 / 字段标签 / 确认按钮这类「功能性 chrome」——它们按构造就是短的，散文塞不进
 *  去；长文案与内部术语两条规则仍然全上下文生效（chrome 里出现术语同样是术语）。 */
const EXPLANATORY = [
  ['解释性·因果', /因为|因此|所以|于是|从而|既然|换言之/],
  ['解释性·弱化', /只是|不过是|充其量|顶多/],
  ['解释性·自动/默认', /会自动|自动(?!解锁)|默认|回退|退化|静默/],
  ['解释性·机制自证', /不回显|不落库|不进日志|不明文|只存/],
  ['解释性·无需', /不需要|不必|用不着/],
  ['解释性·条件', /只有[^，。；]{0,16}才|除非/],
  ['解释性·建议', /建议|推荐|最好|应当|应该/],
  ['解释性·定义', /用于|用来|表示|指的是|也就是|即[：:]|亦即|称为/],
  ['解释性·指针', /注[：:]|注意[：:]|详见|参见/],
  ['解释性·后果', /不会|不能|无法|不可|并不|而不是|并不是|意味着|相当于|即可|一律|绝不/],
];

/** 功能性 chrome 的属性名：解释性模式不在这里开火（长度与术语照查）。 */
const CHROME_PROPS = new Set(['placeholder', 'label', 'okText', 'cancelText', 'text', 'value']);
const isChromeContext = (ctx) =>
  (ctx.startsWith('prop:') || ctx.startsWith('key:')) && CHROME_PROPS.has(ctx.split(':')[1]);

/** 内部术语：出现在用户可见串里 = 把实现细节贴在用户脸上。 */
const JARGON = [
  [
    '内部术语',
    /\bcanonical\b|\bAG-IR\b|\bS\d+\b|pipeline|透传|dialect|codec|\bKEK\b|\bDEK\b|env_ref|provider-models|provenance|last-known-good|stale|PanelState|access_path|model_source|round-trip|AG_[A-Z_]+/i,
  ],
];

/** 功能性上下文（这些属性本来就是短文案的家，疑似时建议缩到该粒度）。 */
const FUNCTIONAL_PROPS = new Set(['placeholder', 'label', 'okText', 'cancelText', 'title', 'alt']);
const TOOLTIP_PROPS = new Set(['tip', 'hint']);

/** 关键词 → 帮助页小节（建议去处用；键见 router.ts 的 HELP_SECTIONS）。 */
const HELP_HINTS = [
  [/渠道|服务商|provider|凭据|上游|预填|base_url|检查凭据/i, 'channels'],
  [/获取模型|拉取|模型清单|provider-models/i, 'modelFetch'],
  [/namespace|命名空间|寻址|前缀/i, 'namespace'],
  [/DeepSeek|全家桶|能力状态|web_search|read_url|OCR|ASR|TTS/i, 'deepseekSuite'],
  [/别名|exact|prefix|passthrough|转发/i, 'aliases'],
  [/目录|offline|upstream|同步|stale/i, 'catalog'],
  [/用量|费用|计费|cash|as_api|对账|峰谷|未定价/i, 'usage'],
  [/密钥|KEK|DEK|解锁|口令|keyring|轮换/i, 'keystore'],
  [/Bearer|x-api-key|sk-ag|掩码|access token/i, 'clientKey'],
  [/auth-mode|互斥|permissive/i, 'authMode'],
  [/设置|白名单|优先级|env 锁|热改/i, 'settings'],
];

// ---------------------------------------------------------------------------
// 词法：注释 / 字符串 / 模板 / 正则 感知的切分
// ---------------------------------------------------------------------------

const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'case',
  'yield',
  'await',
  'throw',
]);

/**
 * 把源码切成「掩码版」：注释换成等长空格（保留换行），字符串 / 模板 / 正则原样保留。
 * 返回 { masked, spans, lines }：
 *   masked —— 与原文等长，行号可对；
 *   spans  —— 字符串 / 模板字面量的 [start, end) 与起始行；模板带 chunks（静态段）；
 *   lines  —— 原文行（豁免标记要从原文行上读，不能读掩码版）。
 */
function tokenize(text) {
  const n = text.length;
  const masked = new Array(n);
  const spans = [];
  const regexSpans = [];
  let i = 0;
  let line = 1;
  const at = (k) => (k < n ? text[k] : '');
  const prevSignificant = () => {
    for (let k = i - 1; k >= 0; k--) {
      const c = masked[k];
      if (c === undefined || c === ' ' || c === '\n' || c === '\t' || c === '\r') continue;
      return c;
    }
    return null;
  };
  const prevWord = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    const end = k + 1;
    while (k >= 0 && /[A-Za-z_$]/.test(text[k])) k--;
    return text.slice(k + 1, end);
  };
  const regexAllowed = () => {
    if (at(i + 1) === '>') return false; // JSX 自闭合 `/>`
    const prev = prevSignificant();
    if (prev === null) return true;
    if (prev === '<') return false; // JSX 闭合标签 `</div>`
    if ('(,=:[!&|?{};+-*%~^<>'.includes(prev)) return true;
    return KEYWORDS_BEFORE_REGEX.has(prevWord());
  };

  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      masked[i] = '\n';
      i++;
      line++;
      continue;
    }
    if (c === '/' && at(i + 1) === '/') {
      while (i < n && text[i] !== '\n') {
        masked[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && at(i + 1) === '*') {
      masked[i] = ' ';
      masked[i + 1] = ' ';
      i += 2;
      while (i < n && !(text[i] === '*' && at(i + 1) === '/')) {
        masked[i] = text[i] === '\n' ? '\n' : ' ';
        if (text[i] === '\n') line++;
        i++;
      }
      if (i < n) {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      const startLine = line;
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      const end = Math.min(j, n);
      for (let k = start; k < end; k++) masked[k] = text[k];
      spans.push({ start, end, line: startLine, quote: c, template: false, chunks: null });
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const start = i;
      const startLine = line;
      const chunks = [];
      let j = i + 1;
      let chunkStart = j;
      while (j < n) {
        const d = text[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '`') break;
        if (d === '$' && at(j + 1) === '{') {
          chunks.push(text.slice(chunkStart, j));
          j += 2;
          let braces = 1;
          while (j < n && braces > 0) {
            const e = text[j];
            if (e === '\\') {
              j += 2;
              continue;
            }
            if (e === "'" || e === '"') {
              const q = e;
              j++;
              while (j < n && text[j] !== q && text[j] !== '\n') {
                if (text[j] === '\\') j++;
                j++;
              }
              j++;
              continue;
            }
            if (e === '`') {
              j++;
              let inner = 0;
              while (j < n) {
                const f = text[j];
                if (f === '\\') {
                  j += 2;
                  continue;
                }
                if (f === '`' && inner === 0) break;
                if (f === '$' && at(j + 1) === '{') {
                  inner++;
                  j++;
                } else if (f === '}' && inner > 0) inner--;
                else if (f === '\n') line++;
                j++;
              }
              j++;
              continue;
            }
            if (e === '{') braces++;
            else if (e === '}') braces--;
            else if (e === '\n') line++;
            j++;
          }
          chunkStart = j;
          continue;
        }
        if (d === '\n') line++;
        j++;
      }
      chunks.push(text.slice(chunkStart, Math.min(j, n)));
      const end = Math.min(j + 1, n);
      for (let k = start; k < end; k++) masked[k] = text[k];
      spans.push({ start, end, line: startLine, quote: '`', template: true, chunks });
      i = end;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        let k = i;
        while (k <= j) {
          masked[k] = text[k];
          k++;
        }
        while (k < n && /[dgimsuvy]/.test(text[k])) {
          masked[k] = text[k];
          k++;
        }
        regexSpans.push([i, k]);
        i = k;
        continue;
      }
    }
    masked[i] = c;
    i++;
  }
  return { masked, spans, regexSpans, lines: text.split('\n') };
}

/** 从掩码版里取字符串字面量的展示文本（模板字面量取静态段，表达式换成 ‹…› 占位）。 */
function literalText(text, span) {
  if (!span.template)
    return text.slice(span.start + 1, span.end - (text[span.end - 1] === span.quote ? 1 : 0));
  const body = text.slice(span.start + 1, span.end - 1);
  // 静态段之间原样插一个占位符，展示时能看出「这里有插值」
  return span.chunks.map((c) => c).join('‹…›');
}

/** 字面量前的上下文：prop:hint= / key:tip: / call:Toast.error( / jsx-text。 */
function contextOf(masked, span) {
  const before = masked
    .slice(Math.max(0, span.start - 80), span.start)
    .join('')
    .replace(/\s+$/, '');
  const prop = /([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
  if (prop) return `prop:${prop[1]}`;
  const key = /([A-Za-z_$][\w$]*)\s*:\s*$/.exec(before);
  if (key) return `key:${key[1]}`;
  const call = /([A-Za-z_$][\w$.]*)\s*\(\s*$/.exec(before);
  if (call) return `call:${call[1]}`;
  return 'plain';
}

/** 命中原因：长度 / 解释性 / 术语三条规则（解释性不作用于功能性 chrome）。 */
function reasonsOf(text, cjk, context) {
  const reasons = [];
  if (cjk > MAX_LENGTH) reasons.push(`长文案·${cjk} 字`);
  // 解释性模式只对 ≥8 字的串开火：再短的就是标签 / 短语 / 状态值，不是解释句
  // （「此操作不可撤销。」「默认开启」这种功能性短句不该被算成散文）。
  if (cjk >= 8 && !isChromeContext(context)) {
    for (const [label, re] of EXPLANATORY) if (re.test(text)) reasons.push(label);
  }
  for (const [label, re] of JARGON) if (re.test(text)) reasons.push(label);
  return reasons;
}

/**
 * JSX 文本节点：掩掉字符串与正则之后，逐字符扫每一行——
 *   `<tag …>` 整段丢掉（属性里的 `=>` 不算标签结束，要数花括号）；
 *   `{…}` 表达式容器整段丢掉（嵌套花括号由内向外消）；
 *   剩下的就是 JSX 文本。行首混进来的代码前缀（`return ` / `; ` / `) ` 之类）切掉——
 *   那是「一行里同时有代码和文本」的写法（如 `return <StatusTag>未配置</StatusTag>;`）。
 */
function jsxTexts(masked, spans, regexSpans = []) {
  const blanked = masked.slice();
  for (const s of spans) for (let k = s.start; k < s.end; k++) blanked[k] = ' ';
  for (const [a, b] of regexSpans) for (let k = a; k < b; k++) blanked[k] = ' ';
  const out = [];
  blanked
    .join('')
    .split('\n')
    .forEach((raw, idx) => {
      let text = '';
      let i = 0;
      while (i < raw.length) {
        const c = raw[i];
        if (c === '<' && /[A-Za-z/]/.test(raw[i + 1] ?? '')) {
          // 标签：数花括号跳过属性里的表达式，depth 归零后的 `>` 才是标签结束
          i += 2;
          let depth = 0;
          while (i < raw.length) {
            const d = raw[i];
            if (d === '{') depth++;
            else if (d === '}') depth--;
            else if (d === '>' && depth <= 0) {
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        if (c === '{') {
          let depth = 1;
          i++;
          while (i < raw.length && depth > 0) {
            if (raw[i] === '{') depth++;
            else if (raw[i] === '}') depth--;
            i++;
          }
          text += ' ';
          continue;
        }
        text += c;
        i++;
      }
      // 切掉第一个 CJK 字符之前的代码前缀（保留 'API Key 说明' 这种以文本开头的段）
      const firstCjk = text.search(/[\u3400-\u9fff]/);
      if (firstCjk > 0) {
        const head = text.slice(0, firstCjk);
        let cut = -1;
        for (const d of ['return ', '=> ', '; ', ') ', '? ', ': ']) {
          const at = head.lastIndexOf(d);
          if (at !== -1 && at + d.length > cut) cut = at + d.length;
        }
        if (cut !== -1) text = text.slice(cut);
      }
      text = text
        .replace(/[{}]/g, ' ')
        .replace(/[;,]\s*$/, '')
        .trim();
      if (text !== '' && countCjk(text) > 0) out.push({ line: idx + 1, text, context: 'jsx-text' });
    });
  return out;
}

// ---------------------------------------------------------------------------
// 豁免标记
// ---------------------------------------------------------------------------

/** 从原文行收集豁免：行尾 `// ui-copy: allow 理由` / JSX 花括号块注释里的同款标记，
 *  以及「上一行整行只有该注释」的写法（多行 JSX / 数据对象用）。
 *  标记命中但**没写理由**也登记（理由记空串）——那是「审了但没写为什么」，由
 *  noReason 报成错误：没理由的豁免等于没审。 */
function collectExemptLines(lines) {
  const map = new Map();
  const same = (l) =>
    /\/\/\s*ui-copy:\s*allow\b\s*(.*)$/.exec(l) ??
    /\{\s*\/\*\s*ui-copy:\s*allow\b\s*([\s\S]*?)\*\/\s*\}/.exec(l);
  const whole = (l) =>
    /^\s*(\/\/|\{\s*\/\*)\s*ui-copy:\s*allow\b\s*([\s\S]*?)(\*\/\s*\})?\s*$/.exec(l);
  lines.forEach((l, idx) => {
    const one = same(l);
    if (one) map.set(idx + 1, one[1].trim());
    const w = whole(l);
    if (w) {
      map.set(idx + 1, w[2].trim()); // 本行（通常是纯注释行）
      map.set(idx + 2, w[2].trim()); // 下一行（被豁免的串在这）
    }
  });
  return map;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function collectFiles(dir) {
  const out = [];
  // 目录不存在 = 前端还没建起来（2026-11-17：旧 admin 已移到归档分支，新 UI 未落地）。
  // 那时候没有任何用户可见串可扫，报 0 条而不是炸 ENOENT——否则 `npm run check:ui-copy`
  // 会在新 UI 落地前一直红，逼人先建一个空目录。
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectFiles(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out.sort();
}

function loadAllowlist(file) {
  if (!existsSync(file)) return { entries: [], missing: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { entries: [], error: `豁免清单不是合法 JSON：${err.message}` };
  }
  if (!Array.isArray(parsed)) return { entries: [], error: '豁免清单必须是数组' };
  return { entries: parsed, missing: false };
}

const files = collectFiles(SRC).filter((f) => !isExcluded(f));
const allowlist = loadAllowlist(ALLOWLIST);
const allowHit = new Set();

/** 登记一条扫描结果（字符串字面量或 JSX 文本），挂上豁免判定。 */
function addItem(rel, it, exemptLines) {
  const cjk = countCjk(it.text);
  if (cjk === 0) return;
  const inline = exemptLines.get(it.line);
  const entry = allowlist.entries.find(
    (e) =>
      e.file === rel &&
      (e.line === it.line || (typeof e.text === 'string' && it.text.includes(e.text))),
  );
  if (entry !== undefined) allowHit.add(entry);
  items.push({
    file: rel,
    line: it.line,
    kind: it.kind,
    context: it.context,
    text: it.text,
    cjk,
    reasons: reasonsOf(it.text, cjk, it.context),
    exempt: inline !== undefined || entry !== undefined,
    exemptReason: inline ?? entry?.reason,
    exemptSource: inline !== undefined ? 'inline' : entry !== undefined ? 'allowlist' : undefined,
  });
}

const items = [];
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  const { masked, spans, regexSpans, lines } = tokenize(text);
  const exemptLines = collectExemptLines(lines);

  for (const span of spans) {
    addItem(
      rel,
      {
        line: span.line,
        kind: 'string',
        context: contextOf(masked, span),
        text: literalText(text, span),
      },
      exemptLines,
    );
  }
  for (const jt of jsxTexts(masked, spans, regexSpans)) {
    addItem(
      rel,
      { line: jt.line, kind: 'jsx-text', context: jt.context, text: jt.text },
      exemptLines,
    );
  }
}

items.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

const suggest = (it) => {
  if (it.reasons.includes('内部术语')) return '内部术语不该给用户看：改写成用户语言，或移帮助页';
  const prop = it.context.startsWith('prop:')
    ? it.context.slice(5)
    : it.context.startsWith('key:')
      ? it.context.slice(4)
      : '';
  if (FUNCTIONAL_PROPS.has(prop)) return '缩短到标签 / placeholder 的粒度';
  if (TOOLTIP_PROPS.has(prop)) return '缩短成一句话 tooltip；放不下的进帮助页对应主题';
  for (const [re, section] of HELP_HINTS) {
    if (re.test(it.text)) return `移帮助页「${section}」小节，或删`;
  }
  return '移帮助页对应主题，或删';
};

const suspected = items.filter((i) => i.reasons.length > 0);
const bad = suspected.filter((i) => !i.exempt);
const allowed = suspected.filter((i) => i.exempt);
const noReason = allowed.filter((i) => (i.exemptReason ?? '').trim() === '');
const staleEntries = allowlist.entries.filter((e) => !allowHit.has(e));

const payload = {
  root: ROOT,
  src: relative(ROOT, SRC).split(sep).join('/'),
  maxLength: MAX_LENGTH,
  threshold: THRESHOLD,
  files: files.length,
  strings: items.length,
  suspected: suspected.length,
  unexempted: bad.length,
  exempted: allowed.length,
  items: suspected.map((i) => ({ ...i, suggest: suggest(i) })),
  all: VERBOSE ? items : undefined,
  staleAllowlist: staleEntries,
  allowlistError: allowlist.error,
};

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  const w = (s) => process.stdout.write(`${s}\n`);
  w(`UI 文案扫描：${payload.src}（排除 Help.tsx 与 *.test.ts）`);
  w(
    `规则：单串 > ${MAX_LENGTH} 字 · 解释性模式 · 内部术语；豁免 = 行尾 // ui-copy: allow <理由> 或 ${relative(ROOT, ALLOWLIST).split(sep).join('/')}`,
  );
  w('');
  w(
    `扫描 ${files.length} 个文件、${items.length} 条含中文的用户可见字符串；疑似 ${suspected.length} 条，其中已豁免 ${allowed.length} 条、未豁免 ${bad.length} 条（阈值 ${THRESHOLD}）。`,
  );
  w('');
  const show = (list) => {
    for (const it of list) {
      w(`  ${it.file}:${it.line}  [${it.reasons.join(' · ')}]  (${it.context})`);
      w(`    ${it.text}`);
      w(`    建议：${suggest(it)}`);
    }
  };
  if (bad.length > 0) {
    w('未豁免疑似（清掉它们，或补一条带理由的豁免）：');
    show(bad);
    w('');
  }
  if (allowed.length > 0) {
    w('已豁免（理由如下；没有理由的豁免按错误计）：');
    for (const it of allowed) {
      w(`  ${it.file}:${it.line}  [${it.reasons.join(' · ')}]  (${it.exemptSource})`);
      w(`    ${it.text}`);
      w(`    理由：${it.exemptReason ?? '(缺失)'}`);
    }
    w('');
  }
  if (staleEntries.length > 0) {
    w('警告：豁免清单里有已经不存在 / 已改写的条目（删掉它们，别让清单腐烂）：');
    for (const e of staleEntries) w(`  ${e.file}:${e.line ?? '?'} ${e.text ?? ''}`);
    w('');
  }
  if (allowlist.error !== undefined) w(`错误：${allowlist.error}`);
  for (const it of noReason) w(`错误：${it.file}:${it.line} 的豁免没写理由`);
  w(
    bad.length > THRESHOLD || noReason.length > 0 || allowlist.error !== undefined
      ? `结果：红灯（未豁免疑似 ${bad.length} > 阈值 ${THRESHOLD}${noReason.length > 0 ? '；有豁免缺理由' : ''}${allowlist.error !== undefined ? '；豁免清单损坏' : ''}）`
      : '结果：绿灯',
  );
}

process.exit(
  bad.length > THRESHOLD || noReason.length > 0 || allowlist.error !== undefined ? 1 : 0,
);
