import React from 'react';

const ICON_FILE_BY_PREFIX: readonly [string, string][] = [
  ['deepseek', 'deepseek'],
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['gemini', 'gemini'],
  ['moonshot', 'moonshot'],
  ['zhipu', 'zhipu'],
  ['mimo', 'mimo'],
  ['qwen', 'qwen'],
  ['opencode', 'opencode'],
  ['xai', 'xai'],
  ['openrouter', 'openrouter'],
  ['step', 'step'],
];

function resolveIconSlug(providerId: string): string | null {
  const lower = providerId.toLowerCase();
  for (const [prefix, slug] of ICON_FILE_BY_PREFIX) {
    if (lower === prefix || lower.startsWith(`${prefix}-`) || lower.startsWith(`${prefix}.`)) {
      return slug;
    }
  }
  return null;
}

/**
 * 服务商图标徽章（统一 28×28 / 36×36 白底圆角框，兼容亮/暗色主题与单色/彩色 SVG）。
 */
export function ProviderIcon({
  providerId,
  name,
  size = 28,
}: {
  providerId: string;
  name?: string;
  size?: number;
}): React.JSX.Element {
  const slug = resolveIconSlug(providerId);
  const innerSize = Math.round(size * 0.68);
  const boxStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(6, Math.round(size * 0.25)),
    background: '#ffffff',
    border: '1px solid var(--ag-border)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: '#111827',
    fontSize: Math.round(size * 0.44),
    fontWeight: 600,
    userSelect: 'none',
  };

  if (!slug) {
    const fallbackChar = (name || providerId || '+').trim().slice(0, 1).toUpperCase();
    return (
      <span style={boxStyle} aria-hidden="true">
        {fallbackChar}
      </span>
    );
  }

  return (
    <span style={boxStyle} aria-hidden="true">
      <img
        src={`/admin/icons/providers/${slug}.svg`}
        alt=""
        width={innerSize}
        height={innerSize}
        style={{ display: 'block', objectFit: 'contain' }}
      />
    </span>
  );
}
