import type { RedactionRuleItem } from './types.js';

export interface RedactionSpan {
  start: number;
  end: number;
  replacement: string;
}

export interface ClientRedactionResult {
  redactedText: string;
  spans: RedactionSpan[];
  hitCount: number;
}

/**
 * 浏览器端实时敏感串检测与替换（97 §2.7 #2、§5 #11）：
 * - 执行服务端下发的内置 + 用户正则规则；
 * - 执行仅在浏览器运行的自定义 JS 判定函数 `detect(text)`；
 * - 在发送前将命中区间替换为占位符，供输入框实时高亮提示。
 */
export function runClientRedaction(
  text: string,
  options: {
    placeholder: string;
    builtinRules: readonly RedactionRuleItem[];
    userRules: readonly RedactionRuleItem[];
    detectJs?: string;
  },
): ClientRedactionResult {
  if (!text) {
    return { redactedText: '', spans: [], hitCount: 0 };
  }

  const placeholder = options.placeholder || '<redacted_key>';
  const rawSpans: RedactionSpan[] = [];

  const allRules = [...options.builtinRules, ...options.userRules];
  for (const rule of allRules) {
    if (!rule.enabled || !rule.pattern) continue;
    try {
      const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
      const re = new RegExp(rule.pattern, flags);
      for (const m of text.matchAll(re)) {
        if (m.index !== undefined && m[0].length > 0) {
          rawSpans.push({
            start: m.index,
            end: m.index + m[0].length,
            replacement: rule.replacement || placeholder,
          });
        }
      }
    } catch {
      // 忽略损坏的正则
    }
  }

  if (options.detectJs && options.detectJs.trim() !== '') {
    try {
      const fn = new Function(
        'text',
        `${options.detectJs}\nreturn typeof detect === 'function' ? detect(text) : [];`,
      ) as (t: string) => unknown;
      const res = fn(text);
      if (Array.isArray(res)) {
        for (const item of res) {
          if (
            Array.isArray(item) &&
            typeof item[0] === 'number' &&
            typeof item[1] === 'number' &&
            item[1] > item[0] &&
            item[0] >= 0 &&
            item[1] <= text.length
          ) {
            rawSpans.push({
              start: item[0],
              end: item[1],
              replacement: placeholder,
            });
          }
        }
      }
    } catch {
      // 用户自定义判定函数抛错时不中断输入
    }
  }

  if (rawSpans.length === 0) {
    return { redactedText: text, spans: [], hitCount: 0 };
  }

  // 合并重叠区间
  rawSpans.sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start));
  const merged: RedactionSpan[] = [];
  for (const sp of rawSpans) {
    const prev = merged[merged.length - 1];
    if (!prev || sp.start >= prev.end) {
      merged.push({ ...sp });
    } else if (sp.end > prev.end) {
      prev.end = sp.end;
    }
  }

  let out = '';
  let cursor = 0;
  for (const sp of merged) {
    out += text.slice(cursor, sp.start) + sp.replacement;
    cursor = sp.end;
  }
  out += text.slice(cursor);

  return {
    redactedText: out,
    spans: merged,
    hitCount: merged.length,
  };
}
