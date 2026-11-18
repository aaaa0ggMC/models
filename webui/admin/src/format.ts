/**
 * 数字、金额、时间格式化工具（表格与统计卡统一使用等宽数字）。
 */

export function formatUsd(amount: number | undefined | null): string {
  if (amount === undefined || amount === null || !Number.isFinite(amount)) return '$0.00';
  if (amount === 0) return '$0.00';
  if (Math.abs(amount) < 0.01) return `$${amount.toFixed(6)}`;
  if (Math.abs(amount) < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function formatCurrencyAmount(
  amount: number | undefined | null,
  currency = 'USD',
): string {
  const code = currency.toUpperCase();
  const sym =
    code === 'CNY' || code === 'RMB'
      ? '¥'
      : code === 'EUR'
        ? '€'
        : code === 'GBP'
          ? '£'
          : code === 'JPY'
            ? '¥'
            : code === 'USD'
              ? '$'
              : `${code} `;
  if (amount === undefined || amount === null || !Number.isFinite(amount) || amount === 0) {
    return `${sym}0.00`;
  }
  if (Math.abs(amount) < 0.01) return `${sym}${amount.toFixed(6)}`;
  if (Math.abs(amount) < 1) return `${sym}${amount.toFixed(4)}`;
  return `${sym}${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

export function formatInt(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

export function formatCompactNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return '未声明';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

export function formatDateTime(ts: number | undefined | null): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatShortTime(ts: number | undefined | null, spanMs = 86_400_000): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  if (spanMs > 2 * 86_400_000) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatPercent(ratio: number | undefined | null): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return '—';
  const pct = ratio * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
