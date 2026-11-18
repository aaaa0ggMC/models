import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { helpHref, navigate, type HelpSectionId, type RouteId } from '../router.js';
import type { ActionableError } from '../api/client.js';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * 五档状态标签 + 三编码（颜色 + 几何形状图标 + 文字，97 §4.3：颜色永远不是唯一编码）。
 */
export function StatusBadge({
  tone,
  children,
  title,
}: {
  tone: BadgeTone;
  children: React.ReactNode;
  title?: string;
}): React.JSX.Element {
  return (
    <span className={`ag-badge ag-badge-${tone}`} title={title}>
      <StatusShapeIcon tone={tone} />
      <span>{children}</span>
    </span>
  );
}

function StatusShapeIcon({ tone }: { tone: BadgeTone }): React.JSX.Element {
  switch (tone) {
    case 'success':
      // 实心圆 + 对勾
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="4.5" fill="currentColor" opacity="0.2" />
          <path
            d="M3 5.2L4.3 6.5L7.2 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'warning':
      // 三角形
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1.2L9 8.5H1L5 1.2Z" fill="currentColor" />
        </svg>
      );
    case 'danger':
      // 菱形 / 叉号
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'info':
      // 实心方块
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="2" y="2" width="6" height="6" rx="1.5" fill="currentColor" />
        </svg>
      );
    case 'neutral':
    default:
      // 空心圆环
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <circle
            cx="5"
            cy="5"
            r="3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      );
  }
}

/**
 * 环比涨跌标签（97 §4.3：环比颜色按指标定，不按涨跌方向定——费用上涨为警告，请求量上涨为正向）。
 */
export function DeltaBadge({
  deltaRatio,
  metricKind,
}: {
  deltaRatio: number | null;
  metricKind: 'cost' | 'activity' | 'neutral';
}): React.JSX.Element {
  if (deltaRatio === null || !Number.isFinite(deltaRatio)) {
    return <StatusBadge tone="neutral">环比 —</StatusBadge>;
  }
  const pct = deltaRatio * 100;
  if (Math.abs(pct) < 0.05) {
    return <StatusBadge tone="neutral">0.0%</StatusBadge>;
  }
  const up = pct > 0;
  const arrow = up ? '↑' : '↓';
  let tone: BadgeTone = 'neutral';
  if (metricKind === 'cost') {
    tone = up ? 'warning' : 'success';
  } else if (metricKind === 'activity') {
    tone = up ? 'info' : 'neutral';
  }
  return (
    <StatusBadge tone={tone}>
      <span className="ag-tabular">
        {arrow} {Math.abs(pct).toFixed(1)}%
      </span>
    </StatusBadge>
  );
}

/**
 * 页头组件：标题 + 简短副标 + 「了解更多」深链（97 §2.8 #1）。
 */
export function PageHeader({
  title,
  subtitle,
  helpSection,
  actions,
}: {
  title: string;
  subtitle?: string;
  helpSection?: HelpSectionId;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="ag-page-header">
      <div>
        <div className="ag-page-title-row">
          <h1 className="ag-page-title">{title}</h1>
          {helpSection && (
            <a className="ag-help-link" href={helpHref(helpSection)}>
              了解更多 →
            </a>
          )}
        </div>
        {subtitle && (
          <div className="ag-secondary" style={{ marginTop: 4 }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="ag-page-actions">{actions}</div>}
    </header>
  );
}

/**
 * 空状态（97 §5 #9：严格「一句话 + 一个主操作」，请求在飞时绝不渲染）。
 */
export function EmptyState({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}): React.JSX.Element {
  return (
    <div className="ag-empty">
      <p className="ag-empty-text">{message}</p>
      {actionLabel && onAction && (
        <button type="button" className="ag-btn ag-btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * 可操作错误提示（97 §5 #10：分类 + 一句话 + 下一步动作 + 可展开详情）。
 */
export function ErrorBanner({
  error,
  onRetry,
  onDismiss,
}: {
  error: ActionableError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}): React.JSX.Element | null {
  const [showDetail, setShowDetail] = useState(false);
  if (!error) return null;

  return (
    <div className="ag-alert" role="alert">
      <div className="ag-alert-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusBadge tone="danger">{error.category}</StatusBadge>
          <span style={{ fontWeight: 500 }}>{error.message}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {error.actionLabel && error.actionRoute && (
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => navigate(error.actionRoute!)}
            >
              {error.actionLabel}
            </button>
          )}
          {onRetry && (
            <button type="button" className="ag-btn ag-btn-sm" onClick={onRetry}>
              重试
            </button>
          )}
          {error.detail && (
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? '收起详情' : '查看详情'}
            </button>
          )}
          {onDismiss && (
            <button type="button" className="ag-btn ag-btn-sm" onClick={onDismiss}>
              关闭
            </button>
          )}
        </div>
      </div>
      {error.detail && (
        <div className={`ag-collapse${showDetail ? ' is-open' : ''}`}>
          <div className="ag-collapse-inner">
            <pre
              className="ag-mono"
              style={{
                margin: 0,
                padding: 10,
                background: 'var(--ag-surface)',
                borderRadius: 6,
                border: '1px solid var(--ag-border)',
                color: 'var(--ag-text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {error.detail}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 通用弹窗容器。
 */
export function Modal({
  open,
  title,
  large,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  large?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}): React.JSX.Element | null {
  if (!open) return null;
  const dialog = (
    <div
      className="ag-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`ag-modal${large ? ' ag-modal-lg' : ''}`} role="dialog" aria-modal="true">
        <div className="ag-modal-header">
          <h2 className="ag-section-title">{title}</h2>
          <button type="button" className="ag-btn ag-btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="ag-modal-body">{children}</div>
        {footer && <div className="ag-modal-footer">{footer}</div>}
      </div>
    </div>
  );
  // 挂载到 document.body，隔离祖先元素的 transform/overflow 对 position: fixed 的影响
  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}

/**
 * 破坏性操作二次确认弹窗（97 §5 #13：删除、撤销、轮换主密钥须确认并说明后果）。
 */
export function ConfirmModal({
  open,
  title,
  consequence,
  confirmLabel = '确认执行',
  danger = true,
  loading = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  consequence: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}): React.JSX.Element | null {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="ag-btn" onClick={onCancel} disabled={loading}>
            取消
          </button>
          <button
            type="button"
            className={`ag-btn ${danger ? 'ag-btn-danger' : 'ag-btn-primary'}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, color: 'var(--ag-text)' }}>{consequence}</p>
      {children}
    </Modal>
  );
}

export function Switch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`ag-switch${checked ? ' is-on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="ag-switch-thumb" />
    </button>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
}): React.JSX.Element {
  return (
    <div className="ag-segmented" role="tablist">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          className={`ag-segmented-item${value === opt.value ? ' is-active' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * AgentGateway 扁平化品牌 Logo。
 */
export function BrandLogo({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect width="32" height="32" rx="8" fill="#2563EB" />
      <path
        d="M8.5 23V14.5C8.5 10.3579 11.8579 7 16 7C20.1421 7 23.5 10.3579 23.5 14.5V23"
        stroke="#FFFFFF"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M12.5 23V15C12.5 13.067 14.067 11.5 16 11.5C17.933 11.5 19.5 13.067 19.5 15V23"
        stroke="#93C5FD"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="16" cy="17.5" r="2.2" fill="#FFFFFF" />
    </svg>
  );
}

export type { RouteId };
