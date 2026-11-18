import React, { useState } from 'react';

export interface MarkdownViewProps {
  content: string;
  streaming?: boolean;
  className?: string;
}

type Align = 'left' | 'center' | 'right' | undefined;

type BlockNode =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'table'; headers: string[]; aligns: Align[]; rows: string[][] }
  | { kind: 'blockquote'; lines: string[] }
  | {
      kind: 'list';
      ordered: boolean;
      start: number;
      items: Array<{ text: string; checked?: boolean; subLines: string[] }>;
    }
  | { kind: 'hr' }
  | { kind: 'paragraph'; text: string };

export function MarkdownView({
  content,
  streaming = false,
  className = '',
}: MarkdownViewProps): React.JSX.Element {
  const blocks = parseBlocks(content);

  return (
    <div className={`ag-markdown ${className}`.trim()}>
      {blocks.map((block, idx) => {
        const isLast = idx === blocks.length - 1;
        return renderBlock(block, idx, streaming && isLast);
      })}
      {streaming && blocks.length === 0 && <span className="ag-stream-cursor" aria-hidden="true" />}
    </div>
  );
}

function renderBlock(block: BlockNode, key: number, showCursor: boolean): React.JSX.Element {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag key={key} className={`ag-md-h ag-md-h${block.level}`}>
          {renderInline(block.text, `h-${key}`)}
          {showCursor && <span className="ag-stream-cursor" aria-hidden="true" />}
        </Tag>
      );
    }
    case 'code':
      return <CodeBlock key={key} lang={block.lang} code={block.code} streaming={showCursor} />;
    case 'table':
      return (
        <div key={key} className="ag-md-table-wrap">
          <table className="ag-md-table">
            <thead>
              <tr>
                {block.headers.map((h, cIdx) => (
                  <th
                    key={cIdx}
                    style={block.aligns[cIdx] ? { textAlign: block.aligns[cIdx] } : undefined}
                  >
                    {renderInline(h, `th-${key}-${cIdx}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {block.headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      style={block.aligns[cIdx] ? { textAlign: block.aligns[cIdx] } : undefined}
                    >
                      {renderInline(row[cIdx] ?? '', `td-${key}-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {showCursor && <span className="ag-stream-cursor" aria-hidden="true" />}
        </div>
      );
    case 'blockquote':
      return (
        <blockquote key={key} className="ag-md-blockquote">
          {block.lines.map((line, lIdx) => (
            <p key={lIdx} className="ag-md-p">
              {renderInline(line, `bq-${key}-${lIdx}`)}
              {showCursor && lIdx === block.lines.length - 1 && (
                <span className="ag-stream-cursor" aria-hidden="true" />
              )}
            </p>
          ))}
        </blockquote>
      );
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag
          key={key}
          className="ag-md-list"
          {...(block.ordered && block.start !== 1 ? { start: block.start } : {})}
        >
          {block.items.map((item, iIdx) => {
            const isLastItem = showCursor && iIdx === block.items.length - 1;
            return (
              <li key={iIdx} className="ag-md-li">
                {item.checked !== undefined && (
                  <input
                    type="checkbox"
                    checked={item.checked}
                    readOnly
                    style={{ marginRight: 6, verticalAlign: 'middle' }}
                  />
                )}
                {renderInline(item.text, `li-${key}-${iIdx}`)}
                {item.subLines.length > 0 && (
                  <div className="ag-md-sublist">
                    {item.subLines.map((sub, sIdx) => (
                      <div key={sIdx} className="ag-md-subline">
                        {renderInline(sub, `sub-${key}-${iIdx}-${sIdx}`)}
                      </div>
                    ))}
                  </div>
                )}
                {isLastItem && <span className="ag-stream-cursor" aria-hidden="true" />}
              </li>
            );
          })}
        </ListTag>
      );
    }
    case 'hr':
      return <hr key={key} className="ag-md-hr" />;
    case 'paragraph':
      return (
        <p key={key} className="ag-md-p">
          {renderInlineWithBreaks(block.text, `p-${key}`)}
          {showCursor && <span className="ag-stream-cursor" aria-hidden="true" />}
        </p>
      );
  }
}

function CodeBlock({
  lang,
  code,
  streaming,
}: {
  lang: string;
  code: string;
  streaming: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="ag-md-codeblock">
      <div className="ag-md-codeblock-header">
        <span className="ag-mono" style={{ fontSize: 12, color: 'var(--ag-text-secondary)' }}>
          {lang || 'code'}
        </span>
        <button type="button" className="ag-btn ag-btn-sm" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="ag-md-pre ag-mono">
        <code>
          {code}
          {streaming && <span className="ag-stream-cursor" aria-hidden="true" />}
        </code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 块级解析（支持围栏代码、GFM 表格、标题、引用、有序/无序列表、分隔线、段落）
// ---------------------------------------------------------------------------

function parseBlocks(raw: string): BlockNode[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (normalized.trim() === '') return [];

  const lines = normalized.split('\n');
  const out: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') {
      i += 1;
      continue;
    }

    // 1. 围栏代码块 ```lang ... ```（流式未闭合时自动读到末尾）
    const fenceMatch = /^(\s*)(`{3,}|~{3,})([\w.+/-]*)\s*$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[2]!;
      const lang = fenceMatch[3] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const cur = lines[i]!;
        if (cur.trim().startsWith(fence) && cur.trim().slice(fence.length).trim() === '') {
          i += 1;
          break;
        }
        codeLines.push(cur);
        i += 1;
      }
      out.push({ kind: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // 2. 水平分隔线 --- / *** / ___
    if (/^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/.test(trimmed)) {
      out.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // 3. ATX 标题 # .. ######
    const headingMatch = /^\s*(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, headingMatch[1]!.length)) as 1 | 2 | 3 | 4 | 5 | 6;
      out.push({ kind: 'heading', level, text: headingMatch[2]! });
      i += 1;
      continue;
    }

    // 4. GFM 表格（表头行 + 分隔行 |---|---|）
    if (
      isTableRow(trimmed) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1]!.trim())
    ) {
      const headers = splitTableCells(trimmed);
      const aligns = parseTableAligns(lines[i + 1]!.trim(), headers.length);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!.trim())) {
        rows.push(splitTableCells(lines[i]!.trim()));
        i += 1;
      }
      out.push({ kind: 'table', headers, aligns, rows });
      continue;
    }

    // 5. 引用块 > ...
    if (/^\s*>\s?/.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        bqLines.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push({ kind: 'blockquote', lines: bqLines });
      continue;
    }

    // 6. 列表（无序 - / * / + 或有序 1. / 1)）
    const listMatch = matchListItem(line);
    if (listMatch !== null) {
      const ordered = listMatch.ordered;
      const start = listMatch.start;
      const items: Array<{ text: string; checked?: boolean; subLines: string[] }> = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        if (cur.trim() === '') {
          // 若空行之后紧跟同类型列表项，则继续归入同一列表
          if (i + 1 < lines.length) {
            const nextMatch = matchListItem(lines[i + 1]!);
            if (nextMatch !== null && nextMatch.ordered === ordered) {
              i += 1;
              continue;
            }
          }
          break;
        }
        const m = matchListItem(cur);
        if (m !== null && m.ordered === ordered && m.indent <= 3) {
          items.push({
            text: m.text,
            ...(m.checked === undefined ? {} : { checked: m.checked }),
            subLines: [],
          });
          i += 1;
          continue;
        }
        // 缩进续行或子列表项
        if (items.length > 0 && (/^\s{2,}/.test(cur) || m !== null)) {
          const cleanSub = m !== null ? `• ${m.text}` : cur.trim();
          items[items.length - 1]!.subLines.push(cleanSub);
          i += 1;
          continue;
        }
        break;
      }
      out.push({ kind: 'list', ordered, start, items });
      continue;
    }

    // 7. 普通段落（合并连续非特殊行）
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      const nextTrimmed = next.trim();
      if (
        nextTrimmed === '' ||
        /^(\s*)(`{3,}|~{3,})/.test(next) ||
        /^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/.test(nextTrimmed) ||
        /^\s*#{1,6}\s+/.test(next) ||
        /^\s*>\s?/.test(next) ||
        matchListItem(next) !== null ||
        (isTableRow(nextTrimmed) &&
          i + 1 < lines.length &&
          isTableSeparator(lines[i + 1]!.trim()))
      ) {
        break;
      }
      paraLines.push(next);
      i += 1;
    }
    out.push({ kind: 'paragraph', text: paraLines.join('\n') });
  }

  return out;
}

function isTableRow(trimmed: string): boolean {
  return trimmed.includes('|') && trimmed.replace(/\|/g, '').trim() !== '';
}

function isTableSeparator(trimmed: string): boolean {
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function splitTableCells(trimmed: string): string[] {
  let s = trimmed;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseTableAligns(sepLine: string, count: number): Align[] {
  const cells = splitTableCells(sepLine);
  const aligns: Align[] = [];
  for (let i = 0; i < count; i += 1) {
    const c = (cells[i] ?? '').trim();
    if (c.startsWith(':') && c.endsWith(':')) aligns.push('center');
    else if (c.endsWith(':')) aligns.push('right');
    else if (c.startsWith(':')) aligns.push('left');
    else aligns.push(undefined);
  }
  return aligns;
}

function matchListItem(line: string): {
  ordered: boolean;
  start: number;
  indent: number;
  text: string;
  checked?: boolean;
} | null {
  const ul = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (ul) {
    const indent = ul[1]!.length;
    let text = ul[3]!;
    let checked: boolean | undefined;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
      checked = task[1]!.toLowerCase() === 'x';
      text = task[2]!;
    }
    return { ordered: false, start: 1, indent, text, ...(checked === undefined ? {} : { checked }) };
  }
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ol) {
    return {
      ordered: true,
      start: Number.parseInt(ol[2]!, 10) || 1,
      indent: ol[1]!.length,
      text: ol[3]!,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 行内解析（支持 `code`、**bold**、*italic*、~~del~~、![img](url)、[link](url)）
// ---------------------------------------------------------------------------

function renderInlineWithBreaks(text: string, keyPrefix: string): React.ReactNode[] {
  const lines = text.split('\n');
  const out: React.ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}-br-${idx}`} />);
    out.push(...renderInline(line, `${keyPrefix}-l${idx}`));
  });
  return out;
}

const INLINE_TOKEN_RE =
  /(`[^`]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|~~[\s\S]+?~~|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|(?<!\*)\*[^*\n]+\*(?!\*))/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  if (text === '') return [];
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let segIdx = 0;

  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      out.push(text.slice(lastIndex, idx));
    }
    const seg = match[0]!;
    const key = `${keyPrefix}-t${segIdx++}`;

    if (seg.startsWith('`') && seg.endsWith('`') && seg.length >= 2) {
      out.push(
        <code key={key} className="ag-md-inline-code ag-mono">
          {seg.slice(1, -1)}
        </code>,
      );
    } else if (
      (seg.startsWith('**') && seg.endsWith('**')) ||
      (seg.startsWith('__') && seg.endsWith('__'))
    ) {
      out.push(<strong key={key}>{renderInline(seg.slice(2, -2), key)}</strong>);
    } else if (seg.startsWith('~~') && seg.endsWith('~~')) {
      out.push(<del key={key}>{renderInline(seg.slice(2, -2), key)}</del>);
    } else if (seg.startsWith('![') && seg.includes('](') && seg.endsWith(')')) {
      const splitIdx = seg.indexOf('](');
      const alt = seg.slice(2, splitIdx);
      const url = seg.slice(splitIdx + 2, -1).trim();
      if (isSafeUrl(url, true)) {
        out.push(
          <img
            key={key}
            src={url}
            alt={alt}
            style={{
              maxWidth: '100%',
              borderRadius: 'var(--ag-radius-md)',
              border: '1px solid var(--ag-border)',
              marginTop: 6,
            }}
          />,
        );
      } else {
        out.push(seg);
      }
    } else if (seg.startsWith('[') && seg.includes('](') && seg.endsWith(')')) {
      const splitIdx = seg.indexOf('](');
      const label = seg.slice(1, splitIdx);
      const url = seg.slice(splitIdx + 2, -1).trim();
      if (isSafeUrl(url, false)) {
        out.push(
          <a
            key={key}
            href={url}
            target={url.startsWith('#') ? undefined : '_blank'}
            rel={url.startsWith('#') ? undefined : 'noreferrer noopener'}
            className="ag-md-link"
          >
            {renderInline(label, key)}
          </a>,
        );
      } else {
        out.push(seg);
      }
    } else if (seg.startsWith('*') && seg.endsWith('*') && seg.length >= 2) {
      out.push(<em key={key}>{renderInline(seg.slice(1, -1), key)}</em>);
    } else {
      out.push(seg);
    }

    lastIndex = idx + seg.length;
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }

  return out;
}

function isSafeUrl(url: string, allowDataImage: boolean): boolean {
  if (url.startsWith('#') || url.startsWith('/')) return true;
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return true;
  if (allowDataImage && /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(url)) return true;
  return false;
}
