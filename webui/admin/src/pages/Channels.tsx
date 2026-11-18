import React, { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import {
  deriveAccessPath,
  isProviderAutoDisabled,
} from '../api/model-availability.js';
import type {
  EnvCredentialPathDto,
  MaskedCredential,
  PresetDialect,
  ProviderConfig,
  ProviderPreset,
} from '../api/types.js';
import { ProviderPanelModal } from '../components/ProviderPanelModal.js';
import { navigate } from '../router.js';
import {
  ConfirmModal,
  EmptyState,
  ErrorBanner,
  PageHeader,
  StatusBadge,
  Switch,
} from '../components/ui.js';

const PROTOCOL_NAMES: Record<PresetDialect, string> = {
  'openai.chat': 'OpenAI Chat',
  'openai.responses': 'OpenAI Responses',
  'anthropic.messages': 'Anthropic Messages',
  'gemini.generateContent': 'Gemini Native',
};

export function ChannelsPage(): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [envCredentials, setEnvCredentials] = useState<EnvCredentialPathDto[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ActionableError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderConfig | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState<boolean>(false);
  const [cascadeDeleteCreds, setCascadeDeleteCreds] = useState<boolean>(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, presetRes, cRes, eRes] = await Promise.all([
        adminApi.listProviders(),
        adminApi.listProviderPresets().catch(() => ({ items: [] as ProviderPreset[], total: 0 })),
        adminApi.listCredentials(),
        adminApi.listEnvCredentials().catch(() => ({ items: [] as EnvCredentialPathDto[] })),
      ]);
      setProviders(pRes.items);
      setPresets(presetRes.items);
      setCredentials(cRes.items);
      setEnvCredentials(eRes.items);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function hasCredentialForProvider(providerId: string): boolean {
    const prov = providers.find((p) => p.id === providerId);
    const derived = prov ? deriveAccessPath(prov.id, prov.dialect) : providerId;
    const inStore = credentials.some(
      (c) => c.enabled && (c.provider === providerId || c.access_path === derived),
    );
    const inEnv = envCredentials.some(
      (e) => e.count > 0 && (e.access_path === derived || e.access_path.startsWith(`${providerId}.`)),
    );
    return inStore || inEnv;
  }

  async function handleToggleEnable(prov: ProviderConfig, nextEnabled: boolean) {
    try {
      await adminApi.upsertProvider({
        id: prov.id,
        label: prov.label,
        dialect: prov.dialect,
        base_url: prov.base_url,
        ...(prov.namespace ? { namespace: prov.namespace } : {}),
        model_source: prov.model_source,
        ...(prov.builtin_tools ? { builtin_tools: prov.builtin_tools } : {}),
        ...(prov.capability_overrides
          ? { capability_overrides: prov.capability_overrides }
          : {}),
        enabled: nextEnabled,
        ...(prov.note ? { note: prov.note } : {}),
      });
      await loadAll();
    } catch (err) {
      setError({
        category: '状态更新失败',
        message: err instanceof Error ? err.message : '切换失败',
      });
    }
  }

  async function handleTestProvider(prov: ProviderConfig) {
    setTestingId(prov.id);
    setFeedback(null);
    setError(null);
    try {
      const res = await adminApi.testProvider(prov.id);
      if (res.ok) {
        setFeedback(`渠道 ${prov.label} 连通正常`);
      } else {
        setError({
          category: '连通检测未通过',
          message: res.message ?? `渠道 ${prov.label} 检测失败`,
          actionLabel: '检查凭据',
          actionRoute: 'credentials',
        });
      }
      await loadAll();
    } catch (err) {
      setError({
        category: '检测异常',
        message: err instanceof Error ? err.message : '检测失败',
      });
    } finally {
      setTestingId(null);
    }
  }

  async function handleCopyProvider(prov: ProviderConfig) {
    try {
      const newId = `${prov.id}-copy`;
      await adminApi.copyProvider(prov.id, {
        new_id: newId,
        label: `${prov.label} 副本`,
      });
      setFeedback(`已复制渠道为 ${newId}`);
      await loadAll();
    } catch (err) {
      setError({
        category: '复制失败',
        message: err instanceof Error ? err.message : '复制未成功',
      });
    }
  }

  function countCascadeCredentials(targetIds: Set<string>): {
    exclusive: number;
    shared: number;
  } {
    const targets = providers.filter((p) => targetIds.has(p.id));
    const targetPaths = new Set(targets.map((p) => `${p.id}.${p.dialect.replace('.', '-')}`));
    const remaining = providers.filter((p) => !targetIds.has(p.id));
    const remainingIds = new Set(remaining.map((p) => p.id));
    const remainingPaths = new Set(
      remaining.map((p) => `${p.id}.${p.dialect.replace('.', '-')}`),
    );
    let exclusive = 0;
    let shared = 0;
    for (const c of credentials) {
      if (!targetIds.has(c.provider) && !targetPaths.has(c.access_path)) continue;
      if (remainingIds.has(c.provider) || remainingPaths.has(c.access_path)) {
        shared += 1;
      } else {
        exclusive += 1;
      }
    }
    return { exclusive, shared };
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteProvider(deleteTarget.id, {
        cascade_credentials: cascadeDeleteCreds,
      });
      setDeleteTarget(null);
      await loadAll();
    } catch (err) {
      setError({
        category: '删除失败',
        message: err instanceof Error ? err.message : '删除未成功',
      });
    }
  }

  async function handleBatchAction(action: 'enable' | 'disable' | 'delete') {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await adminApi.batchProviders(
        ids,
        action,
        action === 'delete' ? { cascade_credentials: cascadeDeleteCreds } : undefined,
      );
      setSelectedIds(new Set());
      setBatchDeleteOpen(false);
      await loadAll();
    } catch (err) {
      setError({
        category: '批量操作失败',
        message: err instanceof Error ? err.message : '操作未完成',
      });
    }
  }

  return (
    <div className="ag-page">
      <PageHeader
        title="渠道"
        helpSection="channels"
        actions={
          <>
            {selectedIds.size > 0 && (
              <>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => void handleBatchAction('enable')}
                >
                  批量启用 ({selectedIds.size})
                </button>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => void handleBatchAction('disable')}
                >
                  批量停用
                </button>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm ag-btn-danger"
                  onClick={() => {
                    setCascadeDeleteCreds(true);
                    setBatchDeleteOpen(true);
                  }}
                >
                  批量删除
                </button>
              </>
            )}
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              onClick={() => {
                setEditingProvider(null);
                setModalOpen(true);
              }}
            >
              新建渠道
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {feedback && (
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
          <span>{feedback}</span>
          <button
            type="button"
            className="ag-btn ag-btn-sm"
            onClick={() => setFeedback(null)}
          >
            知道了
          </button>
        </div>
      )}

      {loading ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
        </div>
      ) : providers.length === 0 ? (
        <EmptyState
          message="尚未配置任何上游渠道"
          actionLabel="新建渠道"
          onAction={() => {
            setEditingProvider(null);
            setModalOpen(true);
          }}
        />
      ) : (
        <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      checked={
                        providers.length > 0 &&
                        providers.every((p) => selectedIds.has(p.id))
                      }
                      onChange={() => {
                        if (providers.every((p) => selectedIds.has(p.id))) {
                          setSelectedIds(new Set());
                        } else {
                          setSelectedIds(new Set(providers.map((p) => p.id)));
                        }
                      }}
                      aria-label="全选渠道"
                    />
                  </th>
                  <th>渠道名称 / 标识</th>
                  <th>协议</th>
                  <th>上游地址</th>
                  <th>模型清单</th>
                  <th>凭据健康</th>
                  <th>启用状态</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((prov) => {
                  const autoOff = isProviderAutoDisabled(prov.auto_disabled);
                  const hasCred = hasCredentialForProvider(prov.id);
                  const modelSummary =
                    prov.model_source.kind === 'static'
                      ? `${prov.model_source.models.length} 个模型`
                      : '动态发现';
                  return (
                    <tr key={prov.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(prov.id)}
                          onChange={() => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(prov.id)) next.delete(prov.id);
                              else next.add(prov.id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{prov.label}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span className="ag-mono ag-secondary">{prov.id}</span>
                          {prov.namespace && (
                            <StatusBadge tone="info">前缀 {prov.namespace}/</StatusBadge>
                          )}
                          {prov.pricing?.multiplier !== undefined && prov.pricing.multiplier !== 1 && (
                            <StatusBadge tone="neutral">×{prov.pricing.multiplier}</StatusBadge>
                          )}
                        </div>
                      </td>
                      <td>
                        <StatusBadge tone="neutral">
                          {PROTOCOL_NAMES[prov.dialect] ?? prov.dialect}
                        </StatusBadge>
                      </td>
                      <td className="ag-mono">{prov.base_url}</td>
                      <td className="ag-tabular">{modelSummary}</td>
                      <td>
                        {prov.credential_health === 'ok' ? (
                          <StatusBadge tone="success">探测正常</StatusBadge>
                        ) : prov.credential_health === 'error' ? (
                          <StatusBadge tone="danger">探测异常</StatusBadge>
                        ) : hasCred ? (
                          <StatusBadge tone="info">已配凭据</StatusBadge>
                        ) : (
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            onClick={() =>
                              navigate('credentials', { provider: prov.id, create: '1' })
                            }
                            title="前往配置凭据"
                          >
                            <StatusBadge tone="warning">缺少凭据</StatusBadge>
                            <span>+ 配凭据</span>
                          </button>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Switch
                            checked={prov.enabled}
                            onChange={(next) => void handleToggleEnable(prov, next)}
                            ariaLabel={`切换 ${prov.label}`}
                          />
                          {autoOff && prov.auto_disabled && (
                            <StatusBadge
                              tone="danger"
                              title={prov.auto_disabled.reason}
                            >
                              已暂停 ({prov.auto_disabled.consecutive_failures})
                            </StatusBadge>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            disabled={testingId === prov.id}
                            onClick={() => void handleTestProvider(prov)}
                          >
                            {testingId === prov.id ? '检测中…' : '检测连通'}
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            onClick={() => {
                              setEditingProvider(prov);
                              setModalOpen(true);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            onClick={() => void handleCopyProvider(prov)}
                          >
                            复制
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm ag-btn-danger"
                            onClick={() => {
                              setCascadeDeleteCreds(true);
                              setDeleteTarget(prov);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ProviderPanelModal
        open={modalOpen}
        editingProvider={editingProvider}
        presets={presets}
        existingProviderIds={providers.map((p) => p.id)}
        hasCredentialForProvider={hasCredentialForProvider}
        onClose={() => setModalOpen(false)}
        onSaved={() => void loadAll()}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title={`删除渠道 · ${deleteTarget?.label ?? ''}`}
        // ui-copy: allow 删除渠道二次确认的后果说明（97 §5 #13）
        consequence="删除后指向上游该渠道的路由将不再转发。"
        confirmLabel="确认删除"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteTarget !== null && (() => {
          const impact = countCascadeCredentials(new Set([deleteTarget.id]));
          if (impact.exclusive === 0 && impact.shared === 0) return null;
          return (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {impact.exclusive > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={cascadeDeleteCreds}
                    onChange={(e) => setCascadeDeleteCreds(e.target.checked)}
                  />
                  <span>同时删除关联凭据（{impact.exclusive} 条）</span>
                </label>
              )}
              {impact.shared > 0 && (
                <span style={{ fontSize: 12, color: 'var(--ag-text-muted)' }}>
                  共享凭据将保留（{impact.shared} 条）
                </span>
              )}
            </div>
          );
        })()}
      </ConfirmModal>

      <ConfirmModal
        open={batchDeleteOpen}
        title={`批量删除 ${selectedIds.size} 条渠道`}
        // ui-copy: allow 批量删除渠道二次确认的后果说明（97 §5 #13）
        consequence="删除后选中渠道的配置将被永久移除。"
        confirmLabel="确认批量删除"
        onConfirm={() => void handleBatchAction('delete')}
        onCancel={() => setBatchDeleteOpen(false)}
      >
        {batchDeleteOpen && (() => {
          const impact = countCascadeCredentials(selectedIds);
          if (impact.exclusive === 0 && impact.shared === 0) return null;
          return (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {impact.exclusive > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={cascadeDeleteCreds}
                    onChange={(e) => setCascadeDeleteCreds(e.target.checked)}
                  />
                  <span>同时删除关联凭据（{impact.exclusive} 条）</span>
                </label>
              )}
              {impact.shared > 0 && (
                <span style={{ fontSize: 12, color: 'var(--ag-text-muted)' }}>
                  共享凭据将保留（{impact.shared} 条）
                </span>
              )}
            </div>
          );
        })()}
      </ConfirmModal>
    </div>
  );
}
