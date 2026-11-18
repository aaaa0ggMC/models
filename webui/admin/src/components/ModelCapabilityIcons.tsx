import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UpstreamModelCategory, UpstreamModelDto } from '../api/types.js';

type ModalityKind = 'text' | 'image' | 'audio' | 'video' | 'pdf';

const MODALITY_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
};

function ModalitySvg({ kind }: { kind: string }): React.JSX.Element {
  switch (kind as ModalityKind) {
    case 'text':
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      );
    case 'image':
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2.5" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
        </svg>
      );
    case 'audio':
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 10v3" />
          <path d="M6 6v11" />
          <path d="M10 3v18" />
          <path d="M14 8v7" />
          <path d="M18 5v13" />
          <path d="M22 10v3" />
        </svg>
      );
    case 'video':
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m22 8-6 4 6 4V8Z" />
          <rect x="2" y="6" width="14" height="12" rx="2" />
        </svg>
      );
    case 'pdf':
    default:
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v5" />
        </svg>
      );
  }
}

function ReasoningSvg(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
    </svg>
  );
}

interface TipPosition {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

function CapabilityIconChip({
  label,
  detail,
  tone = 'neutral',
  children,
}: {
  label: string;
  detail?: string;
  tone?: 'neutral' | 'info';
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<TipPosition | null>(null);

  function show() {
    const el = ref.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const placeBelow = rect.top < 72;
    setPos({
      left: rect.left + rect.width / 2,
      top: placeBelow ? rect.bottom + 6 : rect.top - 6,
      placement: placeBelow ? 'bottom' : 'top',
    });
  }

  function hide() {
    setPos(null);
  }

  const ariaText = detail ? `${label}：${detail}` : label;

  return (
    <span
      ref={ref}
      tabIndex={0}
      role="img"
      aria-label={ariaText}
      className={`ag-cap-icon${tone === 'info' ? ' ag-cap-icon-info' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className={`ag-tooltip-popover ag-tooltip-${pos.placement}`}
            role="tooltip"
            style={{ left: pos.left, top: pos.top }}
          >
            <div className="ag-tooltip-title">{label}</div>
            {detail && <div className="ag-tooltip-detail">{detail}</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}

export function ModelCapabilityIcons({
  model,
  category,
}: {
  model: UpstreamModelDto;
  category: UpstreamModelCategory;
}): React.JSX.Element {
  const inputs = model.input_modalities ?? [];
  const outputs = model.output_modalities ?? [];
  const hasModalities = inputs.length > 0 || outputs.length > 0;
  const hasDirection = category === 'tts' || category === 'asr' || category === 'image';
  const effortLevels = model.effort?.levels ?? [];
  const hasReasoning = category === 'chat' && (effortLevels.length > 0 || Boolean(model.reasoning));

  if (!hasModalities && !hasReasoning) {
    return <span className="ag-secondary">未声明</span>;
  }

  const displayInputs = hasDirection && inputs.length === 0 ? ['text'] : inputs;
  const displayOutputs = hasDirection && outputs.length === 0 ? ['text'] : outputs;

  const reasoningDetail =
    effortLevels.length > 0
      ? model.effort?.default
        ? `档位：${effortLevels.join(' / ')}（默认 ${model.effort.default}）`
        : `档位：${effortLevels.join(' / ')}`
      : undefined;

  return (
    <div className="ag-cap-list">
      {displayInputs.map((kind) => {
        const name = MODALITY_LABELS[kind] ?? kind;
        return (
          <CapabilityIconChip
            key={`in-${kind}`}
            label={hasDirection ? `输入：${name}` : name}
            detail={hasDirection ? undefined : '输入模态'}
          >
            <ModalitySvg kind={kind} />
          </CapabilityIconChip>
        );
      })}
      {hasDirection && (
        <>
          <span className="ag-cap-arrow" aria-hidden="true">
            →
          </span>
          {displayOutputs.map((kind) => {
            const name = MODALITY_LABELS[kind] ?? kind;
            return (
              <CapabilityIconChip key={`out-${kind}`} label={`输出：${name}`}>
                <ModalitySvg kind={kind} />
              </CapabilityIconChip>
            );
          })}
        </>
      )}
      {hasReasoning && (
        <CapabilityIconChip label="支持思考" detail={reasoningDetail} tone="info">
          <ReasoningSvg />
        </CapabilityIconChip>
      )}
    </div>
  );
}
