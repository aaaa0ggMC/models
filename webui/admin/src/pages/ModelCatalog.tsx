import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import type {
  CapabilityMatrixEntry,
  UpstreamModelCategory,
  UpstreamModelDto,
} from '../api/types.js';
import {
  categoryFromModality,
  GroupedModelTable,
  MODEL_CATEGORY_ORDER,
} from '../components/GroupedModelTable.js';
import {
  EmptyState,
  ErrorBanner,
  PageHeader,
  StatusBadge,
  Switch,
} from '../components/ui.js';
import { navigate, updateQueryParams } from '../router.js';

const MODALITY_LABELS: Record<string, string> = {
  chat: '对话 (chat)',
  embedding: '向量嵌入 (embedding)',
  image: '图片生成 (image)',
  tts: '语音合成 (tts)',
  asr: '语音识别 (asr)',
  decision: '结构化决策 (decision)',
  rerank: '重排 (rerank)',
  moderation: '内容审核 (moderation)',
  video: '视频生成 (video)',
};

function formatUsageUnit(unit: string): string {
  switch (unit) {
    case 'characters':
      return '按字符';
    case 'audio_seconds':
      return '按时长';
    case 'images':
      return '按张';
    case 'input_tokens':
    case 'output_tokens':
      return '按 Token';
    default:
      return unit;
  }
}

function capabilityToModelDto(item: CapabilityMatrixEntry): UpstreamModelDto {
  const category = categoryFromModality(item.modality);
  const lower = item.model.toLowerCase();
  const billingUnit =
    item.usage_units && item.usage_units.length > 0
      ? item.usage_units.map(formatUsageUnit).join(' / ')
      : undefined;
  let capabilityText: string | undefined =
    item.streaming?.mode && item.streaming.mode !== 'none'
      ? `流式 (${item.streaming.mode})`
      : undefined;
  if (category === 'tts') {
    capabilityText = lower.includes('voiceclone')
      ? '音色克隆'
      : lower.includes('voicedesign')
        ? '音色设计'
        : '预置音色';
  } else if (category === 'asr') {
    capabilityText = lower.startsWith('mimo-') ? 'mp3 / wav (≤8 MiB)' : '多格式语音识别';
  }

  const inputModalities =
    item.input_modalities && item.input_modalities.length > 0
      ? (item.input_modalities as UpstreamModelDto['input_modalities'])
      : category === 'asr'
        ? (['audio'] as UpstreamModelDto['input_modalities'])
        : category === 'tts' || category === 'image' || category === 'embedding'
          ? (['text'] as UpstreamModelDto['input_modalities'])
          : undefined;

  const outputModalities =
    item.output_modalities && item.output_modalities.length > 0
      ? (item.output_modalities as UpstreamModelDto['output_modalities'])
      : category === 'tts'
        ? (['audio'] as UpstreamModelDto['output_modalities'])
        : category === 'asr'
          ? (['text'] as UpstreamModelDto['output_modalities'])
          : category === 'image'
            ? (['image'] as UpstreamModelDto['output_modalities'])
            : undefined;

  return {
    id: item.namespaced_id ?? item.model,
    category,
    ...(item.context_window !== undefined ? { context_window: item.context_window } : {}),
    ...(item.max_output_tokens !== undefined ? { max_output_tokens: item.max_output_tokens } : {}),
    ...(inputModalities !== undefined ? { input_modalities: inputModalities } : {}),
    ...(outputModalities !== undefined ? { output_modalities: outputModalities } : {}),
    ...(item.effort?.supported_levels && item.effort.supported_levels.length > 0
      ? { reasoning: true }
      : item.reasoning !== undefined
        ? { reasoning: item.reasoning }
        : {}),
    ...(billingUnit !== undefined || capabilityText !== undefined
      ? {
          specs: {
            ...(billingUnit !== undefined ? { billing_unit: billingUnit } : {}),
            ...(capabilityText !== undefined ? { capability: capabilityText } : {}),
          },
        }
      : {}),
  };
}

export function ModelCatalogPage({
  query,
}: {
  query: URLSearchParams;
}): React.JSX.Element {
  const modalityFilter = query.get('modality') ?? '';
  const showAll = query.get('all') === '1';

  const [entries, setEntries] = useState<CapabilityMatrixEntry[]>([]);
  const [search, setSearch] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [togglingModel, setTogglingModel] = useState<string | null>(null);
  const [error, setError] = useState<ActionableError | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.listCapabilities({
        all: showAll,
        ...(modalityFilter ? { modality: modalityFilter } : {}),
      });
      // 始终隐藏内部 mock 脚手架
      setEntries(res.items.filter((e) => !e.internal));
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      setLoading(false);
    }
  }, [showAll, modalityFilter]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  async function handleSync() {
    setSyncing(true);
    setSyncMessage(null);
    setError(null);
    try {
      const res = await adminApi.triggerSync('upstream_discovery');
      if (res.ok && res.result) {
        setSyncMessage(
          `同步完成：发现 ${res.result.discovered.length} 项，新增 ${res.result.added.length} 项`,
        );
      } else {
        setSyncMessage('同步已执行');
      }
      await loadCatalog();
    } catch (err) {
      setError({
        category: '同步未完成',
        message: err instanceof Error ? err.message : '同步请求失败',
      });
    } finally {
      setSyncing(false);
    }
  }

  async function handleToggleExposed(model: string, exposed: boolean) {
    setTogglingModel(model);
    setError(null);
    try {
      await adminApi.setModelExposed(model, exposed);
      setEntries((prev) =>
        prev.map((e) => (e.model === model ? { ...e, exposed } : e)),
      );
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '更新失败', message: err instanceof Error ? err.message : '切换暴露状态失败' },
      );
    } finally {
      setTogglingModel(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (modalityFilter && e.modality !== modalityFilter) {
        return false;
      }
      if (!q) return true;
      return (
        e.model.toLowerCase().includes(q) ||
        (e.namespaced_id && e.namespaced_id.toLowerCase().includes(q)) ||
        e.access_path.toLowerCase().includes(q) ||
        e.modality.toLowerCase().includes(q)
      );
    });
  }, [entries, search, modalityFilter]);

  const groupedEntries = useMemo(() => {
    const groups = new Map<UpstreamModelCategory, CapabilityMatrixEntry[]>();
    for (const cat of MODEL_CATEGORY_ORDER) {
      groups.set(cat, []);
    }
    for (const item of filtered) {
      const cat = categoryFromModality(item.modality);
      groups.get(cat)!.push(item);
    }
    return MODEL_CATEGORY_ORDER
      .map((cat) => ({ category: cat, items: groups.get(cat)! }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  return (
    <div className="ag-page">
      <PageHeader
        title="模型目录"
        helpSection="catalog"
        actions={
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="ag-secondary">包含未配置项</span>
              <Switch
                checked={showAll}
                onChange={(next) =>
                  updateQueryParams('catalog', { all: next ? '1' : undefined })
                }
              />
            </div>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              disabled={syncing}
              onClick={() => void handleSync()}
            >
              {syncing ? '同步中…' : '从上游同步'}
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {syncMessage && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--ag-radius-sm)',
            background: 'var(--ag-success-bg)',
            border: '1px solid var(--ag-success-border)',
            color: 'var(--ag-success)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{syncMessage}</span>
          <button
            type="button"
            className="ag-btn ag-btn-sm"
            onClick={() => setSyncMessage(null)}
          >
            关闭
          </button>
        </div>
      )}

      {/* 筛选工具栏 */}
      <div
        className="ag-card"
        style={{
          padding: 16,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="ag-input"
            style={{ width: 260 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模型名或端点…"
          />
          <select
            className="ag-select"
            style={{ width: 200 }}
            value={modalityFilter}
            onChange={(e) =>
              updateQueryParams('catalog', { modality: e.target.value || undefined })
            }
          >
            <option value="">全部模态</option>
            {Object.entries(MODALITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <span className="ag-secondary ag-tabular">共 {filtered.length} 条记录</span>
      </div>

      {loading ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          message="当前没有可用的已配置模型"
          actionLabel="去建渠道"
          onAction={() => navigate('channels')}
        />
      ) : (
        <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="ag-table-wrap">
            <GroupedModelTable
              groups={groupedEntries}
              getKey={(item) => `${item.access_path}::${item.model}::${item.modality}`}
              toModelDto={capabilityToModelDto}
              emptyText="当前没有可用的已配置模型"
              extraColumns={[
                {
                  header: '接入端点',
                  render: (item) => <span className="ag-mono">{item.access_path}</span>,
                },
                {
                  header: '当前状态',
                  render: (item) =>
                    item.internal ? (
                      <StatusBadge tone="neutral">内部测试桩</StatusBadge>
                    ) : item.availability === 'unconfigured' ? (
                      <StatusBadge tone="warning">未配渠道或凭据</StatusBadge>
                    ) : item.status === 'implemented' ? (
                      <StatusBadge tone="success">可用</StatusBadge>
                    ) : item.status === 'on-demand' ? (
                      <StatusBadge tone="info">按需启用</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">计划中</StatusBadge>
                    ),
                },
                {
                  header: '对外暴露',
                  render: (item) => (
                    <Switch
                      checked={item.exposed !== false}
                      disabled={togglingModel === item.model}
                      onChange={(next) => void handleToggleExposed(item.model, next)}
                    />
                  ),
                },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
