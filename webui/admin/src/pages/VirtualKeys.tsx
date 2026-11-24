import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { computeModelAvailability } from '../api/model-availability.js';
import type {
  AccessPathDto,
  AuthModeResponse,
  CapabilityMatrixEntry,
  EnvCredentialPathDto,
  MaskedCredential,
  PluginInfoDto,
  ProviderConfig,
  VirtualKeyDto,
  VirtualKeyUsage,
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
import { formatDateTime, formatInt, formatUsd } from '../format.js';
import { helpHref } from '../router.js';

const MODALITY_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'chat', label: '对话' },
  { id: 'image', label: '生图' },
  { id: 'audio_tts', label: '语音合成' },
  { id: 'audio_stt', label: '语音识别' },
  { id: 'embedding', label: '向量' },
  { id: 'rerank', label: '重排' },
  { id: 'video', label: '视频' },
];

export function VirtualKeysPage(): React.JSX.Element {
  const [keys, setKeys] = useState<VirtualKeyDto[]>([]);
  const [authMode, setAuthMode] = useState<AuthModeResponse | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMatrixEntry[]>([]);
  const [plugins, setPlugins] = useState<PluginInfoDto[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ActionableError | null>(null);

  // 创建 / 编辑客户端密钥表单
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [editingKey, setEditingKey] = useState<VirtualKeyDto | null>(null);
  const [nameInput, setNameInput] = useState<string>('');
  const [noteInput, setNoteInput] = useState<string>('');
  const [expireDays, setExpireDays] = useState<string>('');
  const [selectedProviders, setSelectedProviders] = useState<Set<string>>(new Set());
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [selectedModalities, setSelectedModalities] = useState<Set<string>>(new Set());
  const [selectedAllowedPlugins, setSelectedAllowedPlugins] = useState<Set<string>>(new Set());
  const [selectedDisabledPlugins, setSelectedDisabledPlugins] = useState<Set<string>>(new Set());
  const [allowStreaming, setAllowStreaming] = useState<boolean>(true);
  const [allowMessagePersistence, setAllowMessagePersistence] = useState<boolean>(false);
  const [rpmInput, setRpmInput] = useState<string>('');
  const [tpmInput, setTpmInput] = useState<string>('');
  const [budgetUsdInput, setBudgetUsdInput] = useState<string>('');
  const [creating, setCreating] = useState<boolean>(false);

  // 一次性明文展示弹窗（97 §2.5 #2：明文只在创建响应里出现一次）
  const [createdSecret, setCreatedSecret] = useState<{
    name: string;
    plaintext: string;
    masked: string;
  } | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  // 按 key 查看用量弹窗（97 §2.5 #2）
  const [usageModalKey, setUsageModalKey] = useState<VirtualKeyDto | null>(null);
  const [keyUsage, setKeyUsage] = useState<VirtualKeyUsage | null>(null);
  const [loadingUsage, setLoadingUsage] = useState<boolean>(false);

  // 撤销与删除确认
  const [revokeTarget, setRevokeTarget] = useState<VirtualKeyDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VirtualKeyDto | null>(null);
  const [purgeOpen, setPurgeOpen] = useState<boolean>(false);
  const [purgeConfirmInput, setPurgeConfirmInput] = useState<string>('');
  const [purging, setPurging] = useState<boolean>(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vkRes, modeRes, pRes, apRes, capRes, plRes] = await Promise.all([
        adminApi.listVirtualKeys(),
        adminApi.getAuthMode().catch(() => null),
        adminApi.listProviders(),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listCapabilities(),
        adminApi.listPlugins().catch(() => ({ items: [] as PluginInfoDto[], logs: [] })),
      ]);
      setKeys(vkRes.items);
      setAuthMode(modeRes);
      setProviders(pRes.items);
      setAccessPaths(apRes.items);
      setCapabilities(capRes.items);
      setPlugins(plRes.items);
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
        accessPaths,
        capabilities,
        modalityFilter: '',
      }),
    [providers, accessPaths, capabilities],
  );

  const uniqueAvailableModels = useMemo(() => {
    const s = new Set<string>();
    for (const o of availability.options) s.add(o.model);
    return Array.from(s).sort();
  }, [availability.options]);

  const dataPlanePlugins = useMemo(
    () => plugins.filter((p) => p.mount_targets.includes('data_plane')),
    [plugins],
  );

  function openCreateModal() {
    setEditingKey(null);
    setNameInput('');
    setNoteInput('');
    setExpireDays('');
    setSelectedProviders(new Set());
    setSelectedModels(new Set());
    setSelectedModalities(new Set());
    setSelectedAllowedPlugins(new Set());
    setSelectedDisabledPlugins(new Set());
    setAllowStreaming(true);
    setAllowMessagePersistence(false);
    setRpmInput('');
    setTpmInput('');
    setBudgetUsdInput('');
    setCreateOpen(true);
  }

  function openEditModal(vk: VirtualKeyDto) {
    setEditingKey(vk);
    setNameInput(vk.name);
    setNoteInput(vk.note ?? '');
    setExpireDays(
      vk.expires_at ? String(Math.max(1, Math.ceil((vk.expires_at - Date.now()) / 86_400_000))) : '',
    );
    setSelectedProviders(new Set(vk.providers ?? []));
    setSelectedModels(new Set(vk.models ?? []));
    setSelectedModalities(new Set(vk.allowed_modalities ?? []));
    setSelectedAllowedPlugins(new Set(vk.allowed_plugins ?? []));
    setSelectedDisabledPlugins(new Set(vk.disabled_plugins ?? []));
    setAllowStreaming(vk.allow_streaming !== false);
    setAllowMessagePersistence(vk.allow_message_persistence === true);
    setRpmInput(vk.rate_limit?.rpm ? String(vk.rate_limit.rpm) : '');
    setTpmInput(vk.rate_limit?.tpm ? String(vk.rate_limit.tpm) : '');
    setBudgetUsdInput(vk.budget_micros ? String(vk.budget_micros / 1_000_000) : '');
    setCreateOpen(true);
  }

  async function handleSaveKey() {
    if (!nameInput.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const days = Number(expireDays);
      const expiresAt =
        Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : undefined;
      const rpm = Number(rpmInput);
      const tpm = Number(tpmInput);
      const budgetUsd = Number(budgetUsdInput);
      const rateLimit =
        Number.isFinite(rpm) && rpm > 0
          ? { rpm, ...(Number.isFinite(tpm) && tpm > 0 ? { tpm } : {}) }
          : Number.isFinite(tpm) && tpm > 0
            ? { tpm }
            : undefined;
      const budgetMicros =
        Number.isFinite(budgetUsd) && budgetUsd > 0 ? Math.round(budgetUsd * 1_000_000) : undefined;

      if (editingKey !== null) {
        await adminApi.updateVirtualKey(editingKey.key_id, {
          name: nameInput.trim(),
          note: noteInput.trim(),
          expires_at: expiresAt ?? null,
          providers: Array.from(selectedProviders),
          models: Array.from(selectedModels),
          allowed_modalities: Array.from(selectedModalities),
          allowed_plugins: Array.from(selectedAllowedPlugins),
          disabled_plugins: Array.from(selectedDisabledPlugins),
          allow_streaming: allowStreaming,
          allow_message_persistence: allowMessagePersistence,
          rate_limit: rateLimit ?? null,
          budget_micros: budgetMicros ?? null,
        });
        setCreateOpen(false);
        await loadAll();
        return;
      }

      const res = await adminApi.createVirtualKey({
        name: nameInput.trim(),
        ...(noteInput.trim() ? { note: noteInput.trim() } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        ...(selectedProviders.size > 0 ? { providers: Array.from(selectedProviders) } : {}),
        ...(selectedModels.size > 0 ? { models: Array.from(selectedModels) } : {}),
        ...(selectedModalities.size > 0
          ? { allowed_modalities: Array.from(selectedModalities) }
          : {}),
        ...(selectedAllowedPlugins.size > 0
          ? { allowed_plugins: Array.from(selectedAllowedPlugins) }
          : {}),
        ...(selectedDisabledPlugins.size > 0
          ? { disabled_plugins: Array.from(selectedDisabledPlugins) }
          : {}),
        ...(!allowStreaming ? { allow_streaming: false } : {}),
        ...(allowMessagePersistence ? { allow_message_persistence: true } : {}),
        ...(rateLimit ? { rate_limit: rateLimit } : {}),
        ...(budgetMicros !== undefined ? { budget_micros: budgetMicros } : {}),
      });

      setCreateOpen(false);
      setCopied(false);
      setCreatedSecret({
        name: res.key.name,
        plaintext: res.plaintext,
        masked: res.key.masked,
      });
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '操作失败' },
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleOpenUsage(vk: VirtualKeyDto) {
    setUsageModalKey(vk);
    setKeyUsage(null);
    setLoadingUsage(true);
    try {
      const res = await adminApi.getVirtualKeyUsage(vk.key_id);
      setKeyUsage(res.usage);
    } catch (err) {
      setError({
        category: '读取用量失败',
        message: err instanceof Error ? err.message : '未能获取用量',
      });
    } finally {
      setLoadingUsage(false);
    }
  }

  async function handleConfirmRevoke() {
    if (!revokeTarget) return;
    try {
      await adminApi.revokeVirtualKey(revokeTarget.key_id);
      setRevokeTarget(null);
      await loadAll();
    } catch (err) {
      setError({
        category: '撤销失败',
        message: err instanceof Error ? err.message : '撤销未成功',
      });
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteVirtualKey(deleteTarget.key_id);
      setDeleteTarget(null);
      await loadAll();
    } catch (err) {
      setError({
        category: '删除失败',
        message: err instanceof Error ? err.message : '删除未成功',
      });
    }
  }

  async function handleConfirmPurgeAll() {
    if (purgeConfirmInput.trim() !== 'DELETE ALL') return;
    setPurging(true);
    setError(null);
    try {
      await Promise.all(keys.map((k) => adminApi.deleteVirtualKey(k.key_id)));
      setPurgeOpen(false);
      setPurgeConfirmInput('');
      await loadAll();
    } catch (err) {
      setError({
        category: '销毁失败',
        message: err instanceof Error ? err.message : '销毁未成功',
      });
    } finally {
      setPurging(false);
    }
  }

  return (
    <div className="ag-page">
      <PageHeader
        title="客户端密钥"
        helpSection="clientKey"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {keys.length > 0 && (
              <button
                type="button"
                className="ag-btn ag-btn-danger"
                onClick={() => {
                  setPurgeConfirmInput('');
                  setPurgeOpen(true);
                }}
              >
                销毁全部
              </button>
            )}
            <button type="button" className="ag-btn ag-btn-primary" onClick={openCreateModal}>
              签发新密钥
            </button>
          </div>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* 数据面认证模式状态栏（deny 明确标为「未配置访问控制」，不与放行混淆） */}
      {authMode && (
        <div className="ag-card" style={{ padding: '16px 20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontWeight: 600 }}>数据面鉴权模式</span>
              {authMode.mode === 'virtual_key' ? (
                <StatusBadge tone="success">
                  客户端密钥 ({authMode.virtual_key_count} 把有效)
                </StatusBadge>
              ) : authMode.mode === 'access_token' ? (
                <StatusBadge tone="info">单访问令牌模式</StatusBadge>
              ) : authMode.mode === 'permissive' ? (
                <StatusBadge tone="warning">显式免鉴权放行</StatusBadge>
              ) : (
                <StatusBadge tone="danger">未配置访问控制 (503)</StatusBadge>
              )}
            </div>
            <a className="ag-help-link" href={helpHref('authMode')}>
              鉴权互斥规则 →
            </a>
          </div>
          {authMode.ignored.length > 0 && (
            <div className="ag-secondary" style={{ fontSize: 12 }}>
              被忽略项：{authMode.ignored.join('；')}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
        </div>
      ) : keys.length === 0 ? (
        <EmptyState
          message="尚未签发任何客户端密钥"
          actionLabel="签发新密钥"
          onAction={openCreateModal}
        />
      ) : (
        <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>名称 / 备注</th>
                  <th>掩码标识</th>
                  <th>限定范围</th>
                  <th>速率 / 预算上限</th>
                  <th>状态</th>
                  <th>过期时间</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((vk) => (
                  <tr key={vk.key_id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{vk.name}</div>
                      {vk.note && <div className="ag-secondary">{vk.note}</div>}
                    </td>
                    <td>
                      <span className="ag-mono">{vk.masked}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {vk.providers && vk.providers.length > 0 ? (
                          <StatusBadge tone="info">
                            {vk.providers.length} 个渠道
                          </StatusBadge>
                        ) : (
                          <span className="ag-secondary">全部渠道</span>
                        )}
                        {vk.models && vk.models.length > 0 && (
                          <StatusBadge tone="info">
                            {vk.models.length} 个模型
                          </StatusBadge>
                        )}
                        {vk.allowed_modalities && vk.allowed_modalities.length > 0 && (
                          <StatusBadge tone="info">
                            {vk.allowed_modalities.length} 模态
                          </StatusBadge>
                        )}
                        {(vk.allowed_plugins?.length || vk.disabled_plugins?.length) ? (
                          <StatusBadge tone="warning">插件受限</StatusBadge>
                        ) : null}
                        {vk.allow_streaming === false && (
                          <StatusBadge tone="neutral">禁流式</StatusBadge>
                        )}
                      </div>
                    </td>
                    <td className="ag-tabular">
                      {vk.rate_limit?.rpm || vk.rate_limit?.tpm || vk.budget_micros ? (
                        <span className="ag-secondary">
                          {vk.rate_limit?.rpm ? `${vk.rate_limit.rpm} RPM ` : ''}
                          {vk.rate_limit?.tpm ? `${vk.rate_limit.tpm} TPM ` : ''}
                          {vk.budget_micros
                            ? `预算 ${formatUsd(vk.budget_micros / 1_000_000)}`
                            : ''}
                        </span>
                      ) : (
                        <span className="ag-secondary">无限制</span>
                      )}
                    </td>
                    <td>
                      {vk.status === 'active' ? (
                        <StatusBadge tone="success">有效</StatusBadge>
                      ) : (
                        <StatusBadge tone="danger">已撤销</StatusBadge>
                      )}
                    </td>
                    <td className="ag-tabular ag-secondary">
                      {vk.expires_at ? formatDateTime(vk.expires_at) : '永不过期'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          onClick={() => openEditModal(vk)}
                        >
                          编辑权限
                        </button>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          onClick={() => void handleOpenUsage(vk)}
                        >
                          查看用量
                        </button>
                        {vk.status === 'active' && (
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            onClick={() => setRevokeTarget(vk)}
                          >
                            撤销
                          </button>
                        )}
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm ag-btn-danger"
                          onClick={() => setDeleteTarget(vk)}
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

      {/* 签发 / 编辑客户端密钥弹窗 */}
      <Modal
        open={createOpen}
        title={editingKey ? `编辑密钥权限 · ${editingKey.name}` : '签发客户端密钥'}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="ag-btn"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              取消
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              disabled={!nameInput.trim() || creating}
              onClick={() => void handleSaveKey()}
            >
              {creating ? '保存中…' : editingKey ? '保存权限' : '签发密钥'}
            </button>
          </>
        }
      >
        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">密钥名称</label>
            <input
              className="ag-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="例如 Cursor 编辑器 / 生产后端"
              autoFocus
            />
          </div>
          <div className="ag-field">
            <label className="ag-field-label">有效期（天）</label>
            <input
              type="number"
              min={1}
              className="ag-input ag-tabular"
              value={expireDays}
              onChange={(e) => setExpireDays(e.target.value)}
              placeholder="留空为永不过期"
            />
          </div>
        </div>

        <div className="ag-field">
          <label className="ag-field-label">备注</label>
          <input
            className="ag-input"
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            placeholder="选填用途说明"
          />
        </div>

        {/* 限定可用渠道（数据驱动多选，不留空时仅允许选中项） */}
        {providers.length > 0 && (
          <div className="ag-field">
            <label className="ag-field-label">
              <span>限定渠道（留空允许全部）</span>
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {providers.map((p) => {
                const active = selectedProviders.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`ag-btn ag-btn-sm${active ? ' ag-btn-primary' : ''}`}
                    onClick={() => {
                      setSelectedProviders((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      });
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 限定可用模型（数据驱动多选，仅列当前可用模型，97 §5 #5 & #6） */}
        {uniqueAvailableModels.length > 0 && (
          <div className="ag-field">
            <label className="ag-field-label">
              <span>限定模型（留空允许全部）</span>
            </label>
            <div
              style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                maxHeight: 120,
                overflowY: 'auto',
                padding: 10,
                border: '1px solid var(--ag-border)',
                borderRadius: 'var(--ag-radius-sm)',
              }}
            >
              {uniqueAvailableModels.map((m) => {
                const active = selectedModels.has(m);
                return (
                  <button
                    key={m}
                    type="button"
                    className={`ag-btn ag-btn-sm ag-mono${active ? ' ag-btn-primary' : ''}`}
                    onClick={() => {
                      setSelectedModels((prev) => {
                        const next = new Set(prev);
                        if (next.has(m)) next.delete(m);
                        else next.add(m);
                        return next;
                      });
                    }}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="ag-grid-3">
          <div className="ag-field">
            <label className="ag-field-label">每分钟请求 (RPM)</label>
            <input
              type="number"
              min={1}
              className="ag-input ag-tabular"
              value={rpmInput}
              onChange={(e) => setRpmInput(e.target.value)}
              placeholder="无限制"
            />
          </div>
          <div className="ag-field">
            <label className="ag-field-label">每分钟 Token (TPM)</label>
            <input
              type="number"
              min={1}
              className="ag-input ag-tabular"
              value={tpmInput}
              onChange={(e) => setTpmInput(e.target.value)}
              placeholder="无限制"
            />
          </div>
          <div className="ag-field">
            <label className="ag-field-label">费用预算 (USD)</label>
            <input
              type="number"
              step="0.01"
              min={0}
              className="ag-input ag-tabular"
              value={budgetUsdInput}
              onChange={(e) => setBudgetUsdInput(e.target.value)}
              placeholder="无限制"
            />
          </div>
        </div>

        {/* 限定模态 */}
        <div className="ag-field">
          <label className="ag-field-label">
            <span>限定模态（留空允许全部）</span>
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {MODALITY_OPTIONS.map((m) => {
              const active = selectedModalities.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`ag-btn ag-btn-sm${active ? ' ag-btn-primary' : ''}`}
                  onClick={() => {
                    setSelectedModalities((prev) => {
                      const next = new Set(prev);
                      if (next.has(m.id)) next.delete(m.id);
                      else next.add(m.id);
                      return next;
                    });
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 限定可用插件 / 禁用插件 */}
        {dataPlanePlugins.length > 0 && (
          <div className="ag-field">
            <label className="ag-field-label">
              <span>插件权限（留空允许全部）</span>
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {dataPlanePlugins.map((p) => {
                const allowed = selectedAllowedPlugins.has(p.name);
                const disabled = selectedDisabledPlugins.has(p.name);
                return (
                  <div
                    key={p.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      borderRadius: 'var(--ag-radius-sm)',
                      border: '1px solid var(--ag-border)',
                      background: 'var(--ag-surface-raised)',
                      fontSize: 13,
                    }}
                  >
                    <span className="ag-mono">{p.title || p.name}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        className={`ag-btn ag-btn-sm${allowed ? ' ag-btn-primary' : ''}`}
                        onClick={() => {
                          setSelectedAllowedPlugins((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.name)) next.delete(p.name);
                            else next.add(p.name);
                            return next;
                          });
                          setSelectedDisabledPlugins((prev) => {
                            const next = new Set(prev);
                            next.delete(p.name);
                            return next;
                          });
                        }}
                      >
                        允许
                      </button>
                      <button
                        type="button"
                        className={`ag-btn ag-btn-sm${disabled ? ' ag-btn-danger' : ''}`}
                        onClick={() => {
                          setSelectedDisabledPlugins((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.name)) next.delete(p.name);
                            else next.add(p.name);
                            return next;
                          });
                          setSelectedAllowedPlugins((prev) => {
                            const next = new Set(prev);
                            next.delete(p.name);
                            return next;
                          });
                        }}
                      >
                        禁用
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 行为开关 */}
        <div className="ag-grid-2">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderRadius: 'var(--ag-radius-sm)',
              border: '1px solid var(--ag-border)',
            }}
          >
            <span style={{ fontSize: 13 }}>允许流式响应</span>
            <Switch checked={allowStreaming} onChange={setAllowStreaming} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderRadius: 'var(--ag-radius-sm)',
              border: '1px solid var(--ag-border)',
            }}
          >
            <span style={{ fontSize: 13 }}>允许消息留存</span>
            <Switch checked={allowMessagePersistence} onChange={setAllowMessagePersistence} />
          </div>
        </div>
      </Modal>

      {/* 单次明文密钥披露弹窗（关闭即销毁，97 §2.5 #2） */}
      <Modal
        open={createdSecret !== null}
        title={`请妥善保存密钥 · ${createdSecret?.name ?? ''}`}
        onClose={() => setCreatedSecret(null)}
        footer={
          <button
            type="button"
            className="ag-btn ag-btn-primary"
            onClick={() => setCreatedSecret(null)}
          >
            我已保存，关闭
          </button>
        }
      >
        <div
          style={{
            padding: 14,
            borderRadius: 'var(--ag-radius-sm)',
            background: 'var(--ag-warning-bg)',
            border: '1px solid var(--ag-warning-border)',
            color: 'var(--ag-warning)',
            fontWeight: 500,
          }}
        >
          {/* ui-copy: allow 密钥创建时单次展示的安全警示（97 §2.5 #2 硬要求） */}
          完整密钥仅在此时展示一次，关闭弹窗后服务端与界面均无法再次查看。
        </div>
        <div
          style={{
            padding: 14,
            borderRadius: 'var(--ag-radius-sm)',
            background: 'var(--ag-surface-raised)',
            border: '1px solid var(--ag-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <code className="ag-mono" style={{ wordBreak: 'break-all', fontWeight: 600 }}>
            {createdSecret?.plaintext}
          </code>
          <button
            type="button"
            className="ag-btn ag-btn-primary"
            onClick={() => {
              if (createdSecret?.plaintext) {
                void navigator.clipboard?.writeText(createdSecret.plaintext);
                setCopied(true);
              }
            }}
          >
            {copied ? '已复制' : '复制密钥'}
          </button>
        </div>
      </Modal>

      {/* 单把客户端密钥用量明细弹窗 */}
      <Modal
        open={usageModalKey !== null}
        title={`密钥用量 · ${usageModalKey?.name ?? ''}`}
        onClose={() => setUsageModalKey(null)}
      >
        {loadingUsage ? (
          <div className="ag-skeleton" style={{ height: 96 }} />
        ) : !keyUsage ? (
          <div className="ag-secondary">暂无该密钥的用量数据</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="ag-grid-3">
              <div className="ag-stat-card" style={{ padding: 16 }}>
                <span className="ag-stat-label">请求数</span>
                <div className="ag-stat-value" style={{ fontSize: 22 }}>
                  {formatInt(keyUsage.request_count)}
                </div>
              </div>
              <div className="ag-stat-card" style={{ padding: 16 }}>
                <span className="ag-stat-label">Token 合计</span>
                <div className="ag-stat-value" style={{ fontSize: 22 }}>
                  {formatInt(keyUsage.input_tokens + keyUsage.output_tokens)}
                </div>
              </div>
              <div className="ag-stat-card" style={{ padding: 16 }}>
                <span className="ag-stat-label">费用合计</span>
                <div className="ag-stat-value" style={{ fontSize: 22 }}>
                  {formatUsd(keyUsage.cash_total)}
                </div>
              </div>
            </div>
            {keyUsage.by_model.length > 0 && (
              <table className="ag-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>请求数</th>
                    <th>费用</th>
                  </tr>
                </thead>
                <tbody>
                  {keyUsage.by_model.map((m) => (
                    <tr key={m.model}>
                      <td className="ag-mono">{m.model}</td>
                      <td className="ag-tabular">{formatInt(m.request_count)}</td>
                      <td className="ag-tabular">{formatUsd(m.cash_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={revokeTarget !== null}
        title={`撤销密钥 · ${revokeTarget?.name ?? ''}`}
        // ui-copy: allow 撤销客户端密钥二次确认的后果说明（97 §5 #13）
        consequence="撤销后携带该密钥的所有客户端请求将立即被拒绝（401），操作不可恢复。"
        confirmLabel="确认撤销"
        onConfirm={() => void handleConfirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />

      <ConfirmModal
        open={deleteTarget !== null}
        title={`删除密钥 · ${deleteTarget?.name ?? ''}`}
        // ui-copy: allow 删除客户端密钥二次确认的后果说明（97 §5 #13）
        consequence="删除后该密钥记录将从存储中移除。"
        confirmLabel="确认删除"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <Modal
        open={purgeOpen}
        title="销毁全部客户端密钥"
        onClose={() => {
          if (!purging) {
            setPurgeOpen(false);
            setPurgeConfirmInput('');
          }
        }}
        footer={
          <>
            <button
              type="button"
              className="ag-btn"
              disabled={purging}
              onClick={() => {
                setPurgeOpen(false);
                setPurgeConfirmInput('');
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-danger"
              disabled={purging || purgeConfirmInput.trim() !== 'DELETE ALL'}
              onClick={() => void handleConfirmPurgeAll()}
            >
              {purging ? '销毁中…' : '确认销毁全部'}
            </button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="ag-secondary" style={{ fontSize: 13 }}>
            {/* ui-copy: allow 批量销毁全部客户端密钥二次确认提示 */}
            此操作将永久移除全部 {keys.length} 把客户端密钥且不可恢复。
          </div>
          <div className="ag-field">
            <label className="ag-field-label">请输入 DELETE ALL 确认</label>
            <input
              className="ag-input ag-mono"
              value={purgeConfirmInput}
              onChange={(e) => setPurgeConfirmInput(e.target.value)}
              placeholder="DELETE ALL"
              autoFocus
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
