#!/usr/bin/env node
/**
 * check-docs.mjs — 文档自校验（无第三方依赖，Node >= 18 可跑）
 *
 * 对应 review #7 里"小脚本"那一行，做四件事：
 *   1. 围栏奇偶：每个 .md 的 ``` 围栏数必须是偶数，且渲染后 <pre> 里不能出现 markdown 标题
 *      （#1 的根因就是 40-provider-adaptors.md 多一个 ```，把 §1.2–§4 整段吞进代码块）。
 *   2. §N 引用目标存在：形如 `xx.md §N` / `xx.md §N.M` / `xx.md §N.M.K` 的引用，
 *      目标文件里必须有对应编号的标题。
 *   3. 同文件节号不重复、不跳号（`## N.` / `### N.M` / `#### N.M.K` 各自连续）。
 *   4. 术语禁用同义词 grep：术语表禁用的同义词出现在正文时报错。
 *
 * 已知的口径约定（避免误报）：
 *   - `## 0. 阅读指引` / `### 7.0` / `### 6.0` 这类"第 0 节"是本仓库的既有写法，允许作为起始编号。
 *   - `2.2b` / `2.2c` / `4.4b` / `3.2b` 这类带字母后缀的编号**不算**节号（它们是插页），不参与重复/跳号检查。
 *   - 行文里提到第三方项目名（llm-bridge / llmshim / agentgateway / NewAPI / one-api / LiteLLM /
 *     OpenRouter / Cloudflare / Vercel）时，禁用同义词降级为警告——那是在转述别人的命名。
 *
 * 退出码：0 = 全部通过；1 = 有错误。
 *
 * 用法：
 *   node scripts/check-docs.mjs             # 校验 docs/ 下全部 .md
 *   node scripts/check-docs.mjs --verbose   # 打印每个文件的统计
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCS_DIR = join(ROOT, "docs");
const VERBOSE = process.argv.includes("--verbose");

/** 术语表（00-overview.md §5）禁用的同义词 → 推荐说法 */
const FORBIDDEN_SYNONYMS = [
  [/(?<![\w-])intermediate format(?![\w-])/gi, "canonical / AG-IR"],
  [/(?<![\w-])universal format(?![\w-])/gi, "canonical / AG-IR"],
  [/(?<![\w-])provider driver(?![\w-])/gi, "adaptor"],
  [/(?<![\w-])bridge(?![\w-])/gi, "adaptor（或说明是哪个 bridge）"],
];

/** 提到这些第三方项目名时，禁用同义词降级为警告（转述对方命名） */
const THIRD_PARTY = /\b(llm-bridge|llmshim|agentgateway|NewAPI|one-api|LiteLLM|OpenRouter|Cloudflare|Vercel|Api-Conversion|inference-gateway)\b/;

const errors = [];
const warnings = [];
const fail = (f, l, m) => errors.push(`${f}:${l} ${m}`);
const warn = (f, l, m) => warnings.push(`${f}:${l} ${m}`);

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

/**
 * 逐行扫描。
 * 返回 headings: [{ level, num, title, line }]，num 形如 "1" / "2.1" / "2.1.1"；
 * 只有"数字编号后紧跟空格或行尾"的才算节号（"2.2b" / "4.4b" 不算）。
 */
function scan(text) {
  const lines = text.split("\n");
  const headings = [];
  const inCode = lines.map(() => false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      open = !open;
      inCode[i] = true;
      continue;
    }
    inCode[i] = open;
    if (open) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const title = m[2].trim();
    // 编号后允许一个可选的 "."（"4. 标题" / "2.1 标题" 都算）；
    // "4.4b" / "2.2b" 这种带字母后缀的不算（回溯后无法让"数字 + 可选点 + 空白/行尾"成立）。
    const nm = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(title);
    headings.push({ level: m[1].length, num: nm ? nm[1] : null, title, line: i + 1 });
  }
  return { lines, headings, inCode };
}

const files = collect(DOCS_DIR);
const byBase = new Map(files.map((f) => [basename(f), f]));

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const text = readFileSync(file, "utf8");
  const { lines, headings, inCode } = scan(text);

  // ---------- 1. 围栏奇偶 + <pre> 吞标题 ----------
  const fenceLines = lines.map((l, i) => (/^\s*```/.test(l) ? i + 1 : 0)).filter(Boolean);
  if (fenceLines.length % 2 !== 0) {
    fail(rel, fenceLines[fenceLines.length - 1],
      `代码块围栏数为奇数（${fenceLines.length}）——多了一个 \`\`\` 或 \`\`\`typescript`);
  }
  for (const h of headings) {
    if (inCode[h.line - 1]) {
      fail(rel, h.line, `标题 "${h.title.slice(0, 40)}" 落在代码块内——会被 GitHub 渲染进 <pre>，等于吞掉一个标题`);
    }
  }

  // ---------- 2. 节号不重复、不跳号 ----------
  for (const level of [2, 3, 4]) {
    const seen = new Map();
    for (const h of headings.filter((x) => x.level === level && x.num)) {
      if (seen.has(h.num)) fail(rel, h.line, `节号 ${h.num} 在 L${seen.get(h.num)} 已出现过（重复编号）`);
      else seen.set(h.num, h.line);
    }
    // 按父层分组查跳号；允许从 0 或 1 起始（本仓库用 `## 0. 阅读指引`）
    const groups = new Map();
    for (const h of headings.filter((x) => x.level === level && x.num)) {
      const parent = h.num.includes(".") ? h.num.slice(0, h.num.lastIndexOf(".")) : "";
      const n = parseInt(h.num.slice(h.num.lastIndexOf(".") + 1), 10);
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(n);
    }
    for (const [parent, seq] of groups) {
      const start = seq[0] === 0 ? 0 : 1;
      for (let i = 0; i < seq.length; i++) {
        if (seq[i] !== start + i) {
          const where = parent ? `${parent}.x` : "顶层";
          fail(rel, "-", `节号跳号：${where} 下第 ${i + 1} 个 ${"#".repeat(level)} 编号是 ${seq[i]}，期望 ${start + i}`);
          break;
        }
      }
    }
  }

  // ---------- 3. §N 引用目标存在 ----------
  // 兼容三种写法：`xx.md §2`、`[xx.md](./xx.md) §2.1`、`xx.md` §2.1（反引号包裹）
  const refRe = /([A-Za-z0-9_\-./]+\.md)(?:`[^`]*`|]\([^)]*\))?\s*§\s*(\d+(?:\.\d+)*)/g;
  const lineStarts = [];
  {
    let acc = 0;
    for (const l of lines) {
      lineStarts.push(acc);
      acc += l.length + 1;
    }
  }
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  let m;
  while ((m = refRe.exec(text)) !== null) {
    const target = m[1];
    const num = m[2];
    const line = lineOf(m.index);
    if (inCode[line - 1]) continue;
    const targetPath = byBase.get(basename(target)) ?? join(dirname(file), target);
    let targetText;
    try {
      targetText = readFileSync(targetPath, "utf8");
    } catch {
      fail(rel, line, `引用了不存在的文件 ${target}`);
      continue;
    }
    const { headings: th } = scan(targetText);
    const hit = th.some((h) => h.num === num);
    if (!hit) {
      fail(rel, line, `引用 ${target} §${num} 的目标节不存在（该文件没有编号为 ${num} 的标题）`);
    }
  }

  // ---------- 3b. 同文件内裸 `§N` 引用（只告警：可能是为了简洁而省略了文件名） ----------
  // 例："（与 §5.2 强一致）" —— 若本文件没有编号 N 的标题，提醒作者补上文件名或改指向。
  // 已带文件名（`xx.md §N`、`[xx.md](...) §N`）或以两位文档号开头（`00 §7.4`、`65 §5.3`）的不算裸引用。
  const bareRe = /(?<![\w.])(?:§\s*)(\d+(?:\.\d+){0,2})(?![\d.])/g;
  while ((m = bareRe.exec(text)) !== null) {
    const num = m[1];
    const line = lineOf(m.index);
    if (inCode[line - 1]) continue;
    const prefix = text.slice(Math.max(0, m.index - 60), m.index);
    if (/\.md/.test(prefix)) continue;        // 已经写了文件名
    if (/\b\d{2}\s*$/.test(prefix)) continue; // "00 §7.4" / "65 §5.3" 这种文档号简写
    if (!headings.some((h) => h.num === num)) {
      warn(rel, line, `裸引用 §${num} 在本文件里找不到对应标题——若是引用其他文档，请补上 \`xx.md §${num}\``);
    }
  }

  // ---------- 4. 术语禁用同义词 ----------
  // 00-overview.md §5 术语表本身就是"禁用词清单"，跳过；行内代码（`bridge` 这种枚举值/标识符）不算。
  const glossaryStart = rel === "docs/design/00-overview.md"
    ? lines.findIndex((l) => /^## 5\. 术语表/.test(l))
    : -1;
  const glossaryEnd = glossaryStart === -1
    ? -1
    : (() => { for (let i = glossaryStart + 1; i < lines.length; i++) if (/^## /.test(lines[i])) return i; return lines.length; })();

  lines.forEach((l, i) => {
    if (inCode[i]) return;
    if (glossaryStart !== -1 && i >= glossaryStart && i < glossaryEnd) return;
    // 抹掉行内代码 span，避免把 `bridge`（枚举值）当成同义词
    const masked = l.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
    for (const [re, instead] of FORBIDDEN_SYNONYMS) {
      if (!re.test(masked)) continue;
      if (THIRD_PARTY.test(l)) {
        warn(rel, i + 1, `禁用同义词 ${re} 与第三方项目名同行（转述对方命名，可保留；若指我们自己的组件请改成 ${instead}）`);
      } else {
        fail(rel, i + 1, `术语表禁用同义词 ${re} —— 改用 ${instead}`);
      }
    }
  });
}

if (VERBOSE) {
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const n = text.split("\n").filter((l) => /^\s*```/.test(l)).length;
    console.log(`${f.slice(ROOT.length + 1)}: ${text.split("\n").length} 行, 围栏 ${n}`);
  }
}
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`\ncheck-docs: ${files.length} 个文件, ${errors.length} 个错误, ${warnings.length} 个警告`);
process.exit(errors.length ? 1 : 0);
