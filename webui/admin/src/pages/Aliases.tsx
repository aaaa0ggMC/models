import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import {
  computeModelAvailability,
  deriveAccessPath,
} from '../api/model-availability.js';
import type {
  AccessPathDto,
  AliasResolveResponse,
  AliasRuleDto,
  CapabilityMatrixEntry,
  EnvCredentialPathDto,
  MaskedCredential,
  ProviderConfig,
} from '../api/types.js';
import {
  ConfirmModal,
  EmptyState,
  ErrorBanner,
  Modal,
  PageHeader,
  StatusBadge,
  Switch,
} from '../components/ui.js';

export function AliasesPage(): React.JSX.Element {
  const [rules, setRules] = useState<AliasRuleDto[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [envCredentials, setEnvCredentials] = useState<EnvCredentialPathDto[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMatrixEntry[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ActionableError | null>(null);

  // 路由解析预览（97 §2.4 #1：可预览解析结果）
  const [probeModel, setProbeModel] = useState<string>('');
  const [probeResult, setProbeResult] = useState<AliasResolveResponse | null>(null);
  const [probing, setProbing] = useState<boolean>(false);

  // 新建/编辑弹窗
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [editingRule, setEditingRule] = useState<AliasRuleDto | null>(null);
  const [kindInput, setKindInput] = useState<'exact' | 'prefix'>('exact');
  const [patternInput, setPatternInput] = useState<string>('');
  const [targetProvider, setTargetProvider] = useState<string>('');
  const [targetAccessPath, setTargetAccessPath] = useState<string>('');
  const [targetModel, setTargetModel] = useState<string>('');
  const [priorityInput, setPriorityInput] = useState<string>('100');
  const [noteInput, setNoteInput] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  const [deleteTarget, setDeleteTarget] = useState<AliasRuleDto | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [aRes, pRes, cRes, eRes, apRes, capRes] = await Promise.all([
        adminApi.listAliases(),
        adminApi.listProviders(),
        adminApi.listCredentials(),
        adminApi.listEnvCredentials().catch(() => ({ items: [] as EnvCredentialPathDto[] })),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listCapabilities(),
      ]);
      setRules(aRes.items);
      setProviders(pRes.items);
      setCredentials(cRes.items);
      setEnvCredentials(eRes.items);
      setAccessPaths(apRes.items);
      setCapabilities(capRes.items);
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

  const availability = useMemo(
    () =>
      computeModelAvailability({
        providers,
        credentials,
        envCredentials,
        accessPaths,
        capabilities,
        modalityFilter: '',
      }),
    [providers, credentials, envCredentials, accessPaths, capabilities],
  );

  function openModal(rule?: AliasRuleDto) {
    if (rule) {
      setEditingRule(rule);
      setKindInput(rule.kind);
      setPatternInput(rule.pattern);
      setTargetProvider(rule.target.provider);
      setTargetAccessPath(rule.target.access_path);
      setTargetModel(rule.target.model);
      setPriorityInput(String(rule.priority));
      setNoteInput(rule.note ?? '');
    } else {
      setEditingRule(null);
      setKindInput('exact');
      setPatternInput('');
      const firstOpt = availability.options[0];
      const firstProv = providers[0];
      setTargetProvider(firstOpt?.providerId ?? firstProv?.id ?? '');
      setTargetAccessPath(
        firstOpt?.accessPath ??
          (firstProv ? deriveAccessPath(firstProv.id, firstProv.dialect) : ''),
      );
      setTargetModel(firstOpt?.model ?? '');
      setPriorityInput('100');
      setNoteInput('');
    }
    setModalOpen(true);
  }

  async function handleSaveRule() {
    if (!patternInput.trim() || !targetProvider.trim() || !targetAccessPath.trim() || !targetModel.trim()) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const priority = Number(priorityInput);
      await adminApi.upsertAlias({
        ...(editingRule ? { id: editingRule.id } : {}),
        kind: kindInput,
        pattern: patternInput.trim(),
        target: {
          provider: targetProvider.trim(),
          access_path: targetAccessPath.trim(),
          model: targetModel.trim(),
        },
        priority: Number.isFinite(priority) ? priority : 100,
        enabled: editingRule ? editingRule.enabled : true,
        ...(noteInput.trim() ? { note: noteInput.trim() } : {}),
      });
      setModalOpen(false);
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存未成功' },
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleRule(rule: AliasRuleDto, nextEnabled: boolean) {
    try {
      await adminApi.upsertAlias({
        id: rule.id,
        kind: rule.kind,
        pattern: rule.pattern,
        target: rule.target,
        priority: rule.priority,
        enabled: nextEnabled,
        ...(rule.note ? { note: rule.note } : {}),
      });
      await loadAll();
    } catch (err) {
      setError({
        category: '更新失败',
        message: err instanceof Error ? err.message : '切换失败',
      });
    }
  }

  async function handleProbeResolve(e: React.FormEvent) {
    e.preventDefault();
    if (!probeModel.trim()) return;
    setProbing(true);
    try {
      const res = await adminApi.resolveAlias(probeModel.trim());
      setProbeResult(res);
    } catch (err) {
      setError({
        category: '解析失败',
        message: err instanceof Error ? err.message : '请求失败',
      });
    } finally {
      setProbing(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteAlias(deleteTarget.id);
      setDeleteTarget(null);
      await loadAll();
    } catch (err) {
      setError({
        category: '删除失败',
        message: err instanceof Error ? err.message : '删除失败',
      });
    }
  }

  const modelsForSelectedProvider = useMemo(() => {
    return availability.options.filter(
      (o) => o.providerId === targetProvider || o.accessPath === targetAccessPath,
    );
  }, [availability.options, targetProvider, targetAccessPath]);

  return (
    <div className="ag-page">
      <PageHeader
        title="模型别名"
        helpSection="aliases"
        actions={
          <button
            type="button"
            className="ag-btn ag-btn-primary"
            onClick={() => openModal()}
          >
            新建规则
          </button>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* 路由解析预览卡（三级规则：精确匹配 → 前缀匹配 → 原样转发，97 §2.4 #1） */}
      <div className="ag-card">
        <div className="ag-card-header">
          <h3 className="ag-card-title">路由解析预览</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <StatusBadge tone="info">1. 精确匹配</StatusBadge>
            <StatusBadge tone="neutral">2. 命名空间 / 前缀</StatusBadge>
            <StatusBadge tone="neutral">3. 原样转发</StatusBadge>
          </div>
        </div>
        <form
          style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
          onSubmit={handleProbeResolve}
        >
          <input
            className="ag-input ag-mono"
            style={{ maxWidth: 360 }}
            value={probeModel}
            onChange={(e) => setProbeModel(e.target.value)}
            placeholder="输入模型名，如 gpt-4o"
          />
          <button type="submit" className="ag-btn" disabled={probing || !probeModel.trim()}>
            {probing ? '解析中…' : '测试解析'}
          </button>

          {probeResult && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {probeResult.ok && probeResult.resolution ? (
                <>
                  <StatusBadge tone="success">
                    {probeResult.resolution.source === 'exact'
                      ? '命中精确规则'
                      : probeResult.resolution.source === 'prefix'
                        ? '命中前缀规则'
                        : '原样转发'}
                  </StatusBadge>
                  <span className="ag-mono">
                    → {probeResult.resolution.target.provider} (
                    {probeResult.resolution.target.access_path}) /{' '}
                    <strong>{probeResult.resolution.target.model}</strong>
                  </span>
                </>
              ) : (
                <StatusBadge tone="danger">{probeResult.error ?? '未命中任何模型'}</StatusBadge>
              )}
            </div>
          )}
        </form>
      </div>

      {loading ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          message="尚未定义任何模型别名规则"
          actionLabel="新建规则"
          onAction={() => openModal()}
        />
      ) : (
        <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>匹配模式</th>
                  <th>规则类型</th>
                  <th>目标渠道 / 端点</th>
                  <th>目标模型</th>
                  <th>优先级</th>
                  <th>备注</th>
                  <th>启用</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="ag-mono" style={{ fontWeight: 600 }}>
                      {rule.pattern}
                    </td>
                    <td>
                      {rule.kind === 'exact' ? (
                        <StatusBadge tone="info">精确匹配</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">前缀匹配</StatusBadge>
                      )}
                    </td>
                    <td className="ag-mono">
                      {rule.target.provider} · {rule.target.access_path}
                    </td>
                    <td className="ag-mono">{rule.target.model}</td>
                    <td className="ag-tabular">{rule.priority}</td>
                    <td className="ag-secondary">{rule.note || '—'}</td>
                    <td>
                      <Switch
                        checked={rule.enabled}
                        onChange={(next) => void handleToggleRule(rule, next)}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          onClick={() => openModal(rule)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm ag-btn-danger"
                          onClick={() => setDeleteTarget(rule)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 新建 / 编辑别名弹窗 */}
      <Modal
        open={modalOpen}
        title={editingRule ? '编辑模型别名' : '新建模型别名'}
        onClose={() => setModalOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="ag-btn"
              onClick={() => setModalOpen(false)}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              disabled={!patternInput.trim() || !targetModel.trim() || saving}
              onClick={() => void handleSaveRule()}
            >
              {saving ? '保存中…' : '保存规则'}
            </button>
          </>
        }
      >
        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">规则类型</label>
            <select
              className="ag-select"
              value={kindInput}
              onChange={(e) => setKindInput(e.target.value as 'exact' | 'prefix')}
            >
              <option value="exact">精确匹配</option>
              <option value="prefix">前缀匹配</option>
            </select>
          </div>
          <div className="ag-field">
            <label className="ag-field-label">客户端模型名匹配串</label>
            <input
              className="ag-input ag-mono"
              value={patternInput}
              onChange={(e) => setPatternInput(e.target.value)}
              placeholder={kindInput === 'exact' ? '例如 gpt-4o' : '例如 claude-'}
            />
          </div>
        </div>

        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">目标渠道</label>
            <input
              className="ag-input ag-mono"
              list="alias-provider-list"
              value={targetProvider}
              onChange={(e) => {
                const pId = e.target.value;
                setTargetProvider(pId);
                const found = providers.find((p) => p.id === pId);
                if (found) {
                  setTargetAccessPath(deriveAccessPath(found.id, found.dialect));
                }
              }}
              placeholder="例如 deepseek"
            />
            <datalist id="alias-provider-list">
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </datalist>
          </div>

          <div className="ag-field">
            <label className="ag-field-label">目标接入端点</label>
            <input
              className="ag-input ag-mono"
              list="alias-ap-list"
              value={targetAccessPath}
              onChange={(e) => setTargetAccessPath(e.target.value)}
              placeholder="例如 deepseek.openai-chat"
            />
            <datalist id="alias-ap-list">
              {accessPaths.map((ap) => (
                <option key={ap.id} value={ap.id}>
                  {ap.label}
                </option>
              ))}
            </datalist>
          </div>
        </div>

        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">目标上游模型</label>
            {modelsForSelectedProvider.length > 0 ? (
              <select
                className="ag-select ag-mono"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
              >
                {modelsForSelectedProvider.map((m) => (
                  <option key={m.key} value={m.model}>
                    {m.model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="ag-input ag-mono"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
                placeholder="例如 deepseek-flash"
              />
            )}
          </div>
          <div className="ag-field">
            <label className="ag-field-label">优先级（数字越大越优先）</label>
            <input
              type="number"
              className="ag-input ag-tabular"
              value={priorityInput}
              onChange={(e) => setPriorityInput(e.target.value)}
            />
          </div>
        </div>

        <div className="ag-field">
          <label className="ag-field-label">备注</label>
          <input
            className="ag-input"
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            placeholder="选填说明"
          />
        </div>
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title={`删除别名规则 · ${deleteTarget?.pattern ?? ''}`}
        // ui-copy: allow 删除别名二次确认的后果说明（97 §5 #13）
        consequence="删除后匹配该模式的客户端请求将不再走此规则。"
        confirmLabel="确认删除"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
