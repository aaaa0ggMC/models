import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { deriveAccessPath } from '../api/model-availability.js';
import type {
  AccessPathDto,
  EnvCredentialPathDto,
  MaskedCredential,
  ProviderConfig,
  UsageDashboardResponse,
} from '../api/types.js';
import {
  ConfirmModal,
  EmptyState,
  ErrorBanner,
  Modal,
  PageHeader,
  StatusBadge,
} from '../components/ui.js';
import { formatDateTime, formatInt, formatUsd } from '../format.js';

export function CredentialsPage(): React.JSX.Element {
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [envCredentials, setEnvCredentials] = useState<EnvCredentialPathDto[]>([]);
  const [usage, setUsage] = useState<UsageDashboardResponse | null>(null);

  const [filterProvider, setFilterProvider] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ActionableError | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<MaskedCredential | null>(null);

  // 新建凭据弹窗（一把 key 只在创建时录入一次，提交后绝不明文回显，97 §2.3 #1）
  const [createOpen, setCreateOpen] = useState<boolean>(false);
  const [customChannelMode, setCustomChannelMode] = useState<boolean>(false);
  const [editAccessPath, setEditAccessPath] = useState<boolean>(false);
  const [providerInput, setProviderInput] = useState<string>('');
  const [accessPathInput, setAccessPathInput] = useState<string>('');
  const [mode, setMode] = useState<'secret' | 'env' | 'oauth'>('secret');
  const [secretInput, setSecretInput] = useState<string>('');
  const [envVarInput, setEnvVarInput] = useState<string>('');
  const [noteInput, setNoteInput] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);

  // OAuth 扫码 / 点击链接状态
  const [oauthLoading, setOauthLoading] = useState<boolean>(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthKind, setOauthKind] = useState<'openai-codex' | 'xai' | 'openrouter' | null>(null);
  const [oauthLink, setOauthLink] = useState<string>('');
  const [oauthUserCode, setOauthUserCode] = useState<string>('');
  const [oauthQrDataUrl, setOauthQrDataUrl] = useState<string>('');
  const [oauthStatusText, setOauthStatusText] = useState<string>('');
  const [pkceCodeInput, setPkceCodeInput] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const pollTimerRef = useRef<number | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<MaskedCredential | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cRes, pRes, apRes, eRes, uRes] = await Promise.all([
        adminApi.listCredentials(filterProvider || undefined),
        adminApi.listProviders(),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listEnvCredentials().catch(() => ({ items: [] as EnvCredentialPathDto[] })),
        adminApi.getUsageDashboard().catch(() => null),
      ]);
      setCredentials(cRes.items);
      setProviders(pRes.items);
      setAccessPaths(apRes.items);
      setEnvCredentials(eRes.items);
      setUsage(uRes);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      setLoading(false);
    }
  }, [filterProvider]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 按凭据归因的用量映射（97 §2.3 #2：用量按凭据记账，对账时能查到每一把）
  const usageByCred = useMemo(() => {
    const map = new Map<string, { request_count: number; cash_total: number }>();
    for (const row of usage?.summary.by_credential ?? []) {
      map.set(row.credential, {
        request_count: row.request_count,
        cash_total: row.cash_total,
      });
    }
    return map;
  }, [usage]);

  function detectOAuthKind(
    provId: string,
    baseUrl?: string,
  ): 'openai-codex' | 'xai' | 'openrouter' | null {
    const id = provId.toLowerCase();
    const url = (baseUrl ?? '').toLowerCase();
    if (id === 'openai-codex' || id.startsWith('openai-codex-') || url.includes('chatgpt.com/backend-api')) {
      return 'openai-codex';
    }
    if (id === 'xai' || id.startsWith('xai-') || url.includes('api.x.ai')) {
      return 'xai';
    }
    if (id === 'openrouter' || id.startsWith('openrouter-') || url.includes('openrouter.ai')) {
      return 'openrouter';
    }
    return null;
  }

  function resetOAuth() {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setOauthLoading(false);
    setOauthError(null);
    setOauthSessionId(null);
    setOauthKind(null);
    setOauthLink('');
    setOauthUserCode('');
    setOauthQrDataUrl('');
    setOauthStatusText('');
    setPkceCodeInput('');
    setCopiedCode(false);
  }

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  function openCreateModal(targetProviderId?: string) {
    resetOAuth();
    const missingProv = providers.find((p) => !credentials.some((c) => c.provider === p.id));
    const chosen =
      (targetProviderId ? providers.find((p) => p.id === targetProviderId) : undefined) ??
      missingProv ??
      providers[0];
    const defaultProv = targetProviderId || chosen?.id || '';
    const defaultAp = chosen
      ? deriveAccessPath(chosen.id, chosen.dialect)
      : accessPaths[0]?.id ?? '';
    const detected = detectOAuthKind(defaultProv, chosen?.base_url);
    setProviderInput(defaultProv);
    setAccessPathInput(defaultAp);
    setCustomChannelMode(providers.length === 0 || (Boolean(targetProviderId) && !chosen));
    setEditAccessPath(false);
    setMode(detected === 'openai-codex' ? 'oauth' : 'secret');
    setSecretInput('');
    setEnvVarInput('');
    setNoteInput('');
    setReplaceTarget(null);
    setCreateOpen(true);
  }

  function openReplaceModal(cred: MaskedCredential) {
    resetOAuth();
    const chosen = providers.find((p) => p.id === cred.provider);
    const detected = detectOAuthKind(cred.provider, chosen?.base_url);
    setProviderInput(cred.provider);
    setAccessPathInput(cred.access_path);
    setCustomChannelMode(!chosen);
    setEditAccessPath(false);
    setMode(detected === 'openai-codex' ? 'oauth' : cred.masked.startsWith('env:') ? 'env' : 'secret');
    setSecretInput('');
    setEnvVarInput('');
    setNoteInput(cred.note ?? '');
    setReplaceTarget(cred);
    setCreateOpen(true);
  }

  useEffect(() => {
    if (loading || providers.length === 0) return;
    const hash = window.location.hash;
    const qIndex = hash.indexOf('?');
    if (qIndex < 0) return;
    const sp = new URLSearchParams(hash.slice(qIndex + 1));
    if (sp.get('create') === '1') {
      const targetProv = sp.get('provider') ?? undefined;
      openCreateModal(targetProv);
      // 消费一次 create=1 参数，避免刷新或重复触发
      window.location.hash = '#/credentials';
    }
  }, [loading, providers]);

  const activeOAuthKind = useMemo(() => {
    const matched = providers.find((p) => p.id === providerInput);
    return detectOAuthKind(providerInput, matched?.base_url);
  }, [providerInput, providers]);

  async function handleStartOAuth(kindOverride?: 'openai-codex' | 'xai' | 'openrouter') {
    const kind = kindOverride ?? activeOAuthKind;
    if (!kind) return;
    resetOAuth();
    setOauthLoading(true);
    setOauthKind(kind);
    try {
      if (kind === 'openrouter') {
        const cb = `${window.location.origin}/admin/`;
        const res = await adminApi.startOpenRouterPkce(cb);
        setOauthSessionId(res.session_id);
        setOauthLink(res.auth_url);
        const qr = await QRCode.toDataURL(res.auth_url, { width: 176, margin: 1 });
        setOauthQrDataUrl(qr);
        setOauthStatusText('请授权并回填');
        setOauthLoading(false);
        return;
      }

      const res = await adminApi.startDeviceOAuth(kind);
      setOauthSessionId(res.session_id);
      const link = res.verification_uri_complete ?? res.verification_uri;
      setOauthLink(link);
      setOauthUserCode(res.user_code);
      const qr = await QRCode.toDataURL(link, { width: 176, margin: 1 });
      setOauthQrDataUrl(qr);
      setOauthStatusText('等待扫码授权…');
      setOauthLoading(false);

      const schedulePoll = (delaySec: number) => {
        pollTimerRef.current = window.setTimeout(async () => {
          try {
            const pollRes = await adminApi.pollDeviceOAuth({
              session_id: res.session_id,
              provider: providerInput.trim() || kind,
              access_path: accessPathInput.trim(),
              ...(noteInput.trim() ? { note: noteInput.trim() } : {}),
            });
            if (pollRes.status === 'complete') {
              if (replaceTarget) {
                await adminApi.deleteCredential(replaceTarget.id).catch(() => {});
              }
              resetOAuth();
              setReplaceTarget(null);
              setCreateOpen(false);
              await loadAll();
              return;
            }
            if (pollRes.status === 'expired' || pollRes.status === 'failed') {
              setOauthError(pollRes.message);
              setOauthStatusText('');
              return;
            }
            const nextSec =
              pollRes.status === 'slow_down' ? (pollRes.interval_seconds ?? delaySec) : delaySec;
            schedulePoll(nextSec);
          } catch (err) {
            setOauthError(err instanceof Error ? err.message : '轮询失败');
          }
        }, delaySec * 1000);
      };
      schedulePoll(Math.max(2, res.interval_seconds));
    } catch (err) {
      setOauthLoading(false);
      setOauthError(
        err instanceof ApiRequestError
          ? err.actionable.message
          : err instanceof Error
            ? err.message
            : '发起授权失败',
      );
    }
  }

  async function handleExchangePkce() {
    if (!oauthSessionId || !pkceCodeInput.trim()) return;
    setSaving(true);
    setOauthError(null);
    try {
      await adminApi.exchangeOpenRouterPkce({
        session_id: oauthSessionId,
        code_or_url: pkceCodeInput.trim(),
        provider: providerInput.trim() || 'openrouter',
        access_path: accessPathInput.trim(),
        ...(noteInput.trim() ? { note: noteInput.trim() } : {}),
      });
      if (replaceTarget) {
        await adminApi.deleteCredential(replaceTarget.id).catch(() => {});
      }
      resetOAuth();
      setReplaceTarget(null);
      setCreateOpen(false);
      await loadAll();
    } catch (err) {
      setOauthError(
        err instanceof ApiRequestError
          ? err.actionable.message
          : err instanceof Error
            ? err.message
            : '换取失败',
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    if (!providerInput.trim() || !accessPathInput.trim()) return;
    if (mode === 'secret' && !secretInput.trim()) return;
    if (mode === 'env' && !envVarInput.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const formattedEnvRef = envVarInput.trim().startsWith('env:')
        ? envVarInput.trim()
        : `env:${envVarInput.trim()}`;
      await adminApi.createCredential({
        provider: providerInput.trim(),
        access_path: accessPathInput.trim(),
        ...(mode === 'secret'
          ? { secret: secretInput.trim() } // privacy-scan: ignore —— 内存变量传递给凭据创建接口
          : { env_ref: formattedEnvRef }),
        ...(noteInput.trim() ? { note: noteInput.trim() } : {}),
      });
      if (replaceTarget) {
        await adminApi.deleteCredential(replaceTarget.id).catch(() => {});
      }
      setReplaceTarget(null);
      setCreateOpen(false);
      setSecretInput('');
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '创建失败', message: err instanceof Error ? err.message : '创建未成功' },
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleProbe(cred: MaskedCredential) {
    setProbingId(cred.id);
    setError(null);
    try {
      const res = await adminApi.probeCredential(cred.id);
      if (!res.ok) {
        setError({
          category: '凭据探测异常',
          message: res.message ?? `凭据 ${cred.masked} 探测未通过`,
        });
      }
      await loadAll();
    } catch (err) {
      setError({
        category: '探测异常',
        message: err instanceof Error ? err.message : '探测请求失败',
      });
    } finally {
      setProbingId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteCredential(deleteTarget.id);
      setDeleteTarget(null);
      await loadAll();
    } catch (err) {
      setError({
        category: '删除失败',
        message: err instanceof Error ? err.message : '删除失败',
      });
    }
  }

  const activeEnvPaths = envCredentials.filter((e) => e.count > 0);

  return (
    <div className="ag-page">
      <PageHeader
        title="凭据"
        helpSection="credentials"
        actions={
          <>
            <select
              className="ag-select"
              style={{ width: 180 }}
              value={filterProvider}
              onChange={(e) => setFilterProvider(e.target.value)}
            >
              <option value="">全部渠道</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.id})
                </option>
              ))}
            </select>
            <button type="button" className="ag-btn ag-btn-primary" onClick={() => openCreateModal()}>
              添加凭据
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* 环境变量凭据概览（只展示布尔事实与条数，不暴露变量名或密钥值） */}
      {activeEnvPaths.length > 0 && (
        <div className="ag-card">
          <div className="ag-card-header">
            <h3 className="ag-card-title">环境变量凭据（进程环境）</h3>
            <StatusBadge tone="info">多密钥故障轮换已就绪</StatusBadge>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {activeEnvPaths.map((ep) => (
              <div
                key={ep.access_path}
                style={{
                  padding: '8px 12px',
                  borderRadius: 'var(--ag-radius-sm)',
                  background: 'var(--ag-surface-raised)',
                  border: '1px solid var(--ag-border)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <span className="ag-mono">{ep.access_path}</span>
                <StatusBadge tone="success">{ep.count} 把有效</StatusBadge>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
        </div>
      ) : credentials.length === 0 ? (
        <EmptyState
          message="暂无已录入的凭据"
          actionLabel="添加凭据"
          onAction={() => openCreateModal()}
        />
      ) : (
        <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="ag-table-wrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>所属渠道</th>
                  <th>接入端点</th>
                  <th>掩码 / 前导位</th>
                  <th>存储方式</th>
                  <th>健康状态</th>
                  <th>累计用量</th>
                  <th>最近检测</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((cred) => {
                  const credUsage = usageByCred.get(cred.id);
                  const hasChannel = providers.some(
                    (p) =>
                      p.id === cred.provider ||
                      deriveAccessPath(p.id, p.dialect) === cred.access_path,
                  );
                  return (
                    <tr key={cred.id}>
                      <td className="ag-mono">
                        <div>{cred.provider}</div>
                        {!hasChannel && (
                          <div style={{ marginTop: 4 }}>
                            <StatusBadge tone="warning">无关联渠道</StatusBadge>
                          </div>
                        )}
                      </td>
                      <td className="ag-mono">{cred.access_path}</td>
                      <td>
                        <div className="ag-mono" style={{ fontWeight: 600 }}>
                          {cred.masked}
                        </div>
                        <div className="ag-secondary ag-tabular">
                          前导 {cred.head || '—'} · 长度 {cred.length}
                        </div>
                      </td>
                      <td>
                        {cred.storage.location === 'encrypted' ? (
                          <StatusBadge tone="info">加密存储</StatusBadge>
                        ) : cred.storage.location === 'env' ? (
                          <StatusBadge tone="neutral">环境引用 ({cred.storage.ref})</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">系统密钥环</StatusBadge>
                        )}
                      </td>
                      <td>
                        {cred.health === 'ok' ? (
                          <StatusBadge tone="success">正常</StatusBadge>
                        ) : cred.health === 'error' ? (
                          <StatusBadge tone="danger">异常</StatusBadge>
                        ) : (
                          <StatusBadge tone="neutral">未检测</StatusBadge>
                        )}
                      </td>
                      <td className="ag-tabular">
                        {credUsage ? (
                          <span>
                            {formatUsd(credUsage.cash_total)} ({formatInt(credUsage.request_count)}{' '}
                            次)
                          </span>
                        ) : (
                          <span className="ag-secondary">0 次</span>
                        )}
                      </td>
                      <td className="ag-tabular ag-secondary">
                        {formatDateTime(cred.last_checked)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            disabled={probingId === cred.id}
                            onClick={() => void handleProbe(cred)}
                          >
                            {probingId === cred.id ? '探测中…' : '探测'}
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            onClick={() => openReplaceModal(cred)}
                          >
                            更换
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm ag-btn-danger"
                            onClick={() => setDeleteTarget(cred)}
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

      {/* 添加/更换凭据弹窗（支持同一接入路径录入多把 key 自动轮换，97 §2.3 #2） */}
      <Modal
        open={createOpen}
        title={replaceTarget ? `更换上游凭据 · ${replaceTarget.masked}` : '添加上游凭据'}
        onClose={() => {
          resetOAuth();
          setReplaceTarget(null);
          setCreateOpen(false);
        }}
        footer={
          <>
            <button
              type="button"
              className="ag-btn"
              onClick={() => {
                resetOAuth();
                setCreateOpen(false);
              }}
              disabled={saving}
            >
              取消
            </button>
            {mode === 'oauth' ? (
              oauthKind === 'openrouter' && oauthSessionId ? (
                <button
                  type="button"
                  className="ag-btn ag-btn-primary"
                  onClick={() => void handleExchangePkce()}
                  disabled={saving || !pkceCodeInput.trim()}
                >
                  {saving ? '验证中…' : '完成授权'}
                </button>
              ) : null
            ) : (
              <button
                type="button"
                className="ag-btn ag-btn-primary"
                onClick={() => void handleCreate()}
                disabled={saving}
              >
                {saving ? '保存中…' : '保存凭据'}
              </button>
            )}
          </>
        }
      >
        {!customChannelMode && providers.length > 0 ? (
          <div className="ag-field">
            <div className="ag-field-label">
              <span>选择渠道</span>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => setCustomChannelMode(true)}
              >
                手动填写
              </button>
            </div>
            <select
              className="ag-select"
              value={providerInput}
              onChange={(e) => {
                const nextProv = e.target.value;
                setProviderInput(nextProv);
                const matched = providers.find((p) => p.id === nextProv);
                if (matched) {
                  setAccessPathInput(deriveAccessPath(matched.id, matched.dialect));
                }
              }}
            >
              {providers.map((p) => {
                const missing = !credentials.some((c) => c.provider === p.id);
                return (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.id}){missing ? ' · 缺凭据' : ''}
                  </option>
                );
              })}
            </select>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginTop: 6,
              }}
            >
              {editAccessPath ? (
                <input
                  className="ag-input ag-mono"
                  value={accessPathInput}
                  onChange={(e) => setAccessPathInput(e.target.value)}
                  placeholder="例如 mimo.openai-chat"
                />
              ) : (
                <span className="ag-secondary" style={{ fontSize: 12 }}>
                  端点: <span className="ag-mono">{accessPathInput}</span>
                </span>
              )}
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => setEditAccessPath((v) => !v)}
              >
                {editAccessPath ? '收起端点' : '改端点'}
              </button>
            </div>
          </div>
        ) : (
          <div className="ag-grid-2">
            <div className="ag-field">
              <div className="ag-field-label">
                <span>所属渠道标识</span>
                {providers.length > 0 && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    onClick={() => {
                      setCustomChannelMode(false);
                      const first = providers[0]!;
                      setProviderInput(first.id);
                      setAccessPathInput(deriveAccessPath(first.id, first.dialect));
                    }}
                  >
                    选已有渠道
                  </button>
                )}
              </div>
              <input
                className="ag-input ag-mono"
                list="cred-provider-list"
                value={providerInput}
                onChange={(e) => {
                  const nextProv = e.target.value;
                  setProviderInput(nextProv);
                  const matched = providers.find((p) => p.id === nextProv);
                  if (matched) {
                    setAccessPathInput(deriveAccessPath(matched.id, matched.dialect));
                  }
                }}
                placeholder="例如 deepseek"
              />
              <datalist id="cred-provider-list">
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </datalist>
            </div>

            <div className="ag-field">
              <label className="ag-field-label">接入端点</label>
              <input
                className="ag-input ag-mono"
                list="cred-access-path-list"
                value={accessPathInput}
                onChange={(e) => setAccessPathInput(e.target.value)}
                placeholder="例如 deepseek.openai-chat"
              />
              <datalist id="cred-access-path-list">
                {accessPaths.map((ap) => (
                  <option key={ap.id} value={ap.id}>
                    {ap.label}
                  </option>
                ))}
              </datalist>
            </div>
          </div>
        )}

        <div className="ag-field">
          <div className="ag-field-label">
            <span>录入方式</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`ag-btn ag-btn-sm ${mode === 'secret' ? 'ag-btn-primary' : ''}`}
                onClick={() => {
                  resetOAuth();
                  setMode('secret');
                }}
              >
                API Key
              </button>
              <button
                type="button"
                className={`ag-btn ag-btn-sm ${mode === 'env' ? 'ag-btn-primary' : ''}`}
                onClick={() => {
                  resetOAuth();
                  setMode('env');
                }}
              >
                环境变量
              </button>
              {activeOAuthKind !== null && (
                <button
                  type="button"
                  className={`ag-btn ag-btn-sm ${mode === 'oauth' ? 'ag-btn-primary' : ''}`}
                  onClick={() => {
                    resetOAuth();
                    setMode('oauth');
                  }}
                >
                  OAuth 登录
                </button>
              )}
            </div>
          </div>
          {mode === 'secret' ? (
            <input
              type="password"
              className="ag-input ag-mono"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="输入上游 API Key"
              autoComplete="off"
            />
          ) : mode === 'env' ? (
            <input
              className="ag-input ag-mono"
              value={envVarInput}
              onChange={(e) => setEnvVarInput(e.target.value)}
              placeholder="输入环境变量名，例如 DEEPSEEK_API_KEY"
            />
          ) : (
            <div
              style={{
                border: '1px solid var(--ag-border)',
                borderRadius: 10,
                padding: 14,
                background: 'var(--ag-surface-muted, #f9fafb)',
              }}
            >
              {!oauthSessionId ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span className="ag-secondary" style={{ fontSize: 13 }}>
                    {activeOAuthKind === 'openai-codex'
                      ? 'ChatGPT 订阅'
                      : activeOAuthKind === 'xai'
                        ? 'Grok 订阅'
                        : 'OpenRouter'}
                  </span>
                  <button
                    type="button"
                    className="ag-btn ag-btn-primary ag-btn-sm"
                    onClick={() => void handleStartOAuth()}
                    disabled={oauthLoading}
                  >
                    {oauthLoading ? '生成中…' : '扫码 / 链接授权'}
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                  {oauthQrDataUrl && (
                    <img
                      src={oauthQrDataUrl}
                      alt="OAuth QR"
                      width={160}
                      height={160}
                      style={{
                        borderRadius: 8,
                        border: '1px solid var(--ag-border)',
                        background: '#ffffff',
                        padding: 6,
                      }}
                    />
                  )}
                  {oauthUserCode && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="ag-secondary" style={{ fontSize: 12 }}>
                        授权码
                      </span>
                      <code
                        className="ag-mono"
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          letterSpacing: 1.5,
                          padding: '4px 10px',
                          borderRadius: 6,
                          background: '#ffffff',
                          border: '1px solid var(--ag-border)',
                        }}
                      >
                        {oauthUserCode}
                      </code>
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(oauthUserCode);
                          setCopiedCode(true);
                          window.setTimeout(() => setCopiedCode(false), 1500);
                        }}
                      >
                        {copiedCode ? '已复制' : '复制'}
                      </button>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <a
                      href={oauthLink}
                      target="_blank"
                      rel="noreferrer"
                      className="ag-btn ag-btn-primary ag-btn-sm"
                    >
                      打开授权页 ↗
                    </a>
                    <button
                      type="button"
                      className="ag-btn ag-btn-sm"
                      onClick={() => void handleStartOAuth()}
                    >
                      重新生成
                    </button>
                  </div>
                  {oauthKind === 'openrouter' && (
                    <input
                      className="ag-input ag-mono"
                      value={pkceCodeInput}
                      onChange={(e) => setPkceCodeInput(e.target.value)}
                      placeholder="粘贴回调链接或 code"
                    />
                  )}
                  {oauthStatusText && (
                    <span className="ag-secondary" style={{ fontSize: 12 }}>
                      {oauthStatusText}
                    </span>
                  )}
                </div>
              )}
              {oauthError && (
                <div style={{ color: 'var(--ag-danger, #dc2626)', fontSize: 12, marginTop: 8 }}>
                  {oauthError}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ag-field">
          <label className="ag-field-label">备注</label>
          <input
            className="ag-input"
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            placeholder="例如 主账号 / 备用配额池"
          />
        </div>
      </Modal>

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除上游凭据"
        // ui-copy: allow 删除凭据二次确认的后果说明（97 §2.3 #3 & §5 #13）
        consequence={`确认删除凭据 ${deleteTarget?.masked ?? ''}？删除后绑定该凭据的请求将切换至同路径其他凭据或报错。`}
        confirmLabel="确认删除"
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
