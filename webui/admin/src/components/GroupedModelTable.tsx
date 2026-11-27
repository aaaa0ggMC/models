import React from 'react';
import type { UpstreamModelCategory, UpstreamModelDto } from '../api/types.js';
import { formatContextWindow } from '../format.js';
import { ModelCapabilityIcons } from './ModelCapabilityIcons.js';

export const MODEL_CATEGORY_ORDER: readonly UpstreamModelCategory[] = [
  'chat',
  'tts',
  'asr',
  'image',
  'video',
  'embedding',
  'decision',
];

export const MODEL_CATEGORY_LABELS: Record<
  UpstreamModelCategory,
  { label: string; short: string }
> = {
  chat: { label: '对话模型 (LLM)', short: '对话' },
  tts: { label: '语音合成 (TTS)', short: 'TTS' },
  asr: { label: '语音识别 (ASR)', short: 'ASR' },
  image: { label: '图像生成', short: '图像' },
  video: { label: '视频生成', short: '视频' },
  embedding: { label: '向量嵌入', short: '向量' },
  decision: { label: '决策模型', short: '决策' },
};

export function resolveModelCategory(m: UpstreamModelDto): UpstreamModelCategory {
  if (m.category) return m.category;
  if (m.output_modalities?.includes('video') && !m.output_modalities.includes('text')) return 'video';
  if (m.output_modalities?.includes('image') && !m.output_modalities.includes('text')) return 'image';
  if (m.output_modalities?.includes('audio') && !m.output_modalities.includes('text')) return 'tts';
  const id = m.id.toLowerCase();
  if (/(^|[-_/.])(decision|decisions)([-_/.]|$)|(?:^|\/)jev(?:[-_.\d]|$)/i.test(id)) {
    return 'decision';
  }
  if (/(^tts-|-tts\b|-tts-|speech)/i.test(id)) return 'tts';
  if (/(^whisper-|-asr\b|-asr-|transcribe)/i.test(id)) return 'asr';
  if (/(^sora\b|^veo\b|^kling\b|imagine-video|-video\b)/i.test(id)) return 'video';
  if (/(dall-e|gpt-image|chatgpt-image|imagen|wanx|imagine-image|-image\b)/i.test(id)) {
    return 'image';
  }
  if (/(embedding|text-embedding|bge-)/i.test(id)) return 'embedding';
  return 'chat';
}

export function categoryFromModality(modality: string): UpstreamModelCategory {
  switch (modality) {
    case 'audio.tts':
    case 'tts':
      return 'tts';
    case 'audio.stt':
    case 'stt':
    case 'asr':
      return 'asr';
    case 'image.generate':
    case 'image':
      return 'image';
    case 'video.generate':
    case 'video':
      return 'video';
    case 'embeddings':
    case 'embedding':
      return 'embedding';
    case 'decision':
    case 'decisions':
      return 'decision';
    default:
      return 'chat';
  }
}

export function getCategoryColumns(category: UpstreamModelCategory): {
  col2: string;
  col3: string;
  col4: string;
} {
  switch (category) {
    case 'tts':
      return { col2: '计费口径', col3: '合成方式', col4: '模态方向' };
    case 'asr':
      return { col2: '计费口径', col3: '音频格式', col4: '模态方向' };
    case 'image':
      return { col2: '计费口径', col3: '生成能力', col4: '模态方向' };
    case 'video':
      return { col2: '计费口径', col3: '生成能力', col4: '模态方向' };
    case 'embedding':
    case 'decision':
      return { col2: '上下文窗口', col3: '计费口径', col4: '模态方向' };
    case 'chat':
    default:
      return { col2: '上下文窗口', col3: '最大输出', col4: '模态 / 思考档位' };
  }
}

export interface GroupedModelColumn<T> {
  header: string;
  render: (item: T) => React.ReactNode;
}

export interface GroupedModelSelection<T> {
  selectedIds: Set<string>;
  onToggleItem: (id: string) => void;
  onToggleGroup: (items: T[]) => void;
}

export function GroupedModelTable<T>({
  groups,
  getKey,
  toModelDto,
  selection,
  extraColumns = [],
  emptyText = '暂无模型',
}: {
  groups: Array<{ category: UpstreamModelCategory; items: T[] }>;
  getKey: (item: T) => string;
  toModelDto: (item: T) => UpstreamModelDto;
  selection?: GroupedModelSelection<T>;
  extraColumns?: readonly GroupedModelColumn<T>[];
  emptyText?: string;
}): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <table className="ag-table">
        <tbody>
          <tr>
            <td style={{ textAlign: 'center', padding: 20 }}>
              <span className="ag-secondary">{emptyText}</span>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  return (
    <>
      {groups.map((group) => {
        const cols = getCategoryColumns(group.category);
        const groupAllChecked =
          selection !== undefined &&
          group.items.length > 0 &&
          group.items.every((item) => selection.selectedIds.has(toModelDto(item).id));
        const isChat = group.category === 'chat';
        const isEmbeddingOrDecision =
          group.category === 'embedding' || group.category === 'decision';

        return (
          <div key={group.category}>
            {groups.length > 1 && (
              <div
                style={{
                  padding: '6px 12px',
                  background: 'var(--ag-surface-raised)',
                  borderBottom: '1px solid var(--ag-border)',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <strong>{MODEL_CATEGORY_LABELS[group.category].label}</strong>
                  <span className="ag-secondary" style={{ marginLeft: 8 }}>
                    {group.items.length} 项
                  </span>
                </div>
              </div>
            )}
            <table className="ag-table">
              <thead>
                <tr>
                  {selection !== undefined && (
                    <th style={{ width: 42 }}>
                      <input
                        type="checkbox"
                        checked={groupAllChecked}
                        onChange={() => selection.onToggleGroup(group.items)}
                        aria-label="全选分组模型"
                      />
                    </th>
                  )}
                  <th>模型标识</th>
                  <th>{cols.col2}</th>
                  <th>{cols.col3}</th>
                  <th>{cols.col4}</th>
                  {extraColumns.map((col) => (
                    <th key={col.header}>{col.header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.items.map((item) => {
                  const m = toModelDto(item);
                  const checked = selection?.selectedIds.has(m.id) ?? false;
                  return (
                    <tr key={getKey(item)}>
                      {selection !== undefined && (
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => selection.onToggleItem(m.id)}
                          />
                        </td>
                      )}
                      <td className="ag-mono" style={{ fontWeight: 600 }}>
                        {m.id}
                      </td>
                      <td className="ag-tabular">
                        {isChat || isEmbeddingOrDecision
                          ? formatContextWindow(m.context_window)
                          : m.specs?.billing_unit ?? '按用量'}
                      </td>
                      <td className="ag-tabular">
                        {isChat
                          ? formatContextWindow(m.max_output_tokens)
                          : isEmbeddingOrDecision
                            ? m.specs?.billing_unit ?? '按输入 Token'
                            : m.specs?.capability ?? '标准'}
                      </td>
                      <td>
                        <ModelCapabilityIcons model={m} category={group.category} />
                      </td>
                      {extraColumns.map((col) => (
                        <td key={col.header}>{col.render(item)}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
