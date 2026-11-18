import React, { useCallback, useEffect, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import type {
  AuditLogEntry,
  KeystoreStatusResponse,
  SecretRefDto,
  SettingDto,
} from '../api/types.js';
import {
  ConfirmModal,
  ErrorBanner,
  Modal,
  PageHeader,
  StatusBadge,
} from '../components/ui.js';
import { formatDateTime, formatInt } from '../format.js';

function generateStealthKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'gw_gate_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function SystemPage(): React.JSX.Element {
  const [keystore, setKeystore] = useState<KeystoreStatusResponse | null>(null);
  const [secretRefs, setSecretRefs] = useState<SecretRefDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ActionableError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // 轮换确认弹窗（破坏性操作须二次确认并说明后果，97 §5 #13）
  const [rotateDekOpen, setRotateDekOpen] = useState<boolean>(false);
  const [rotateKekOpen, setRotateKekOpen] = useState<boolean>(false);
  const [newPassphrase, setNewPassphrase] = useState<string>('');
  const [rotating, setRotating] = useState<boolean>(false);

  // 敏感值环境引用登记
  const [refModalOpen, setRefModalOpen] = useState<boolean>(false);
  const [refName, setRefName] = useState<string>('');
  const [refEnvVar, setRefEnvVar] = useState<string>('');
  const [refNote, setRefNote] = useState<string>('');
  const [deleteRefTarget, setDeleteRefTarget] = useState<SecretRefDto | null>(null);

  // 网关伪装
  const [stealthEnabled, setStealthEnabled] = useState<boolean>(false);
  const [stealthHeader, setStealthHeader] = useState<string>('x-gateway-key');
  const [stealthKey, setStealthKey] = useState<string>('');
  const [stealthSaving, setStealthSaving] = useState<boolean>(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ks, refs, audits, settingsRes] = await Promise.all([
        adminApi.getKeystoreStatus(),
        adminApi.listSecretRefs().catch(() => ({ items: [] as SecretRefDto[], total: 0 })),
        adminApi.listAudit(100, 0),
        adminApi.listSettings().catch(() => ({ items: [] as SettingDto[] })),
      ]);
      setKeystore(ks);
      setSecretRefs(refs.items);
      setAuditLogs(audits.items);
      const byId = new Map(settingsRes.items.map((s) => [s.id, s]));
      setStealthEnabled(Boolean(byId.get('gateway_stealth_enabled')?.value));
      const hdr = byId.get('gateway_stealth_header')?.value;
      setStealthHeader(typeof hdr === 'string' && hdr.trim() !== '' ? hdr : 'x-gateway-key');
      const key = byId.get('gateway_stealth_key')?.value;
      setStealthKey(typeof key === 'string' ? key : '');
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

  async function handleRotateDek() {
    setRotating(true);
    setError(null);
    try {
      const res = await adminApi.rotateDek();
      setRotateDekOpen(false);
      setFeedback(`已轮换数据密钥 (${res.reencrypted ?? 0} 条)`);
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '轮换失败', message: err instanceof Error ? err.message : '操作失败' },
      );
    } finally {
      setRotating(false);
    }
  }

  async function handleRotateKek() {
    setRotating(true);
    setError(null);
    try {
      const res = await adminApi.rotateKek(newPassphrase.trim() || undefined);
      setRotateKekOpen(false);
      setNewPassphrase('');
      setFeedback(`主密钥已轮换（新指纹：${res.kek_fingerprint ?? '已更新'}）`);
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '轮换失败', message: err instanceof Error ? err.message : '操作失败' },
      );
    } finally {
      setRotating(false);
    }
  }

  async function handleCreateRef() {
    if (!refName.trim() || !refEnvVar.trim()) return;
    try {
      await adminApi.createSecretRef({
        name: refName.trim(),
        env_var: refEnvVar.trim(),
        ...(refNote.trim() ? { note: refNote.trim() } : {}),
      });
      setRefModalOpen(false);
      setRefName('');
      setRefEnvVar('');
      setRefNote('');
      await loadAll();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '登记失败', message: err instanceof Error ? err.message : '登记未成功' },
      );
    }
  }

  async function handleDeleteRef() {
    if (!deleteRefTarget) return;
    try {
      await adminApi.deleteSecretRef(deleteRefTarget.name);
      setDeleteRefTarget(null);
      await loadAll();
    } catch (err) {
      setError({
        category: '删除失败',
        message: err instanceof Error ? err.message : '删除失败',
      });
    }
  }

  async function handleToggleStealth(next: boolean): Promise<void> {
    setStealthSaving(true);
    setError(null);
    try {
      let keyToUse = stealthKey.trim();
      if (next && keyToUse === '') {
        keyToUse = generateStealthKey();
        await adminApi.updateSetting('gateway_stealth_key', keyToUse);
        setStealthKey(keyToUse);
      }
      await adminApi.updateSetting('gateway_stealth_enabled', next);
      setStealthEnabled(next);
      setFeedback(next ? '已开启伪装' : '已关闭伪装');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存失败' },
      );
    } finally {
      setStealthSaving(false);
    }
  }

  async function handleRotateStealthKey(): Promise<void> {
    setStealthSaving(true);
    setError(null);
    try {
      const nextKey = generateStealthKey();
      await adminApi.updateSetting('gateway_stealth_key', nextKey);
      setStealthKey(nextKey);
      setFeedback('已轮换伪装密钥');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '轮换失败', message: err instanceof Error ? err.message : '轮换失败' },
      );
    } finally {
      setStealthSaving(false);
    }
  }

  async function handleSaveStealthHeader(): Promise<void> {
    setStealthSaving(true);
    setError(null);
    try {
      const normalized = stealthHeader.trim().toLowerCase() || 'x-gateway-key';
      await adminApi.updateSetting('gateway_stealth_header', normalized);
      setStealthHeader(normalized);
      setFeedback('已保存请求头');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存失败' },
      );
    } finally {
      setStealthSaving(false);
    }
  }

  async function handleCopyStealthKey(): Promise<void> {
    if (!stealthKey) return;
    try {
      await navigator.clipboard.writeText(stealthKey);
      setFeedback('已复制伪装密钥');
    } catch {
      setError({ category: '复制失败', message: '无法写入剪贴板' });
    }
  }

  return (
    <div className="ag-page">
      <PageHeader
        title="安全与密钥"
        helpSection="keystore"
        actions={
          <button
            type="button"
            className="ag-btn"
            onClick={() => void loadAll()}
            disabled={loading}
          >
            刷新
          </button>
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
            关闭
          </button>
        </div>
      )}

      {/* 1. 加密存储与密钥状态卡（65 §3.2b：原样展示代价说明） */}
      {keystore && (
        <div className="ag-card">
          <div className="ag-card-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 className="ag-section-title">加密密钥库状态</h2>
              <StatusBadge tone={keystore.unlocked ? 'success' : 'danger'}>
                {keystore.unlocked ? '已解锁' : '未解锁'}
              </StatusBadge>
              {keystore.should_rotate_dek && (
                <StatusBadge tone="warning">待轮换数据密钥</StatusBadge>
              )}
              {keystore.argon2_rehash_recommended && (
                <StatusBadge tone="warning">待升级口令哈希参数</StatusBadge>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => setRotateDekOpen(true)}
              >
                轮换数据密钥
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-sm ag-btn-danger"
                onClick={() => setRotateKekOpen(true)}
              >
                轮换主密钥
              </button>
            </div>
          </div>

          <div className="ag-grid-4">
            <div>
              <div className="ag-secondary">解锁模式</div>
              <div style={{ fontWeight: 600, marginTop: 4 }}>
                {keystore.mode === 'passphrase' ? '口令派生模式' : '密钥文件模式'}
              </div>
            </div>
            <div>
              <div className="ag-secondary">当前数据密钥标识</div>
              <div className="ag-mono" style={{ fontWeight: 600, marginTop: 4 }}>
                {keystore.active_dek_id}
              </div>
            </div>
            <div>
              <div className="ag-secondary">已加密记录数</div>
              <div className="ag-tabular" style={{ fontWeight: 600, marginTop: 4 }}>
                {formatInt(keystore.encryption_count)} 条
              </div>
            </div>
            <div>
              <div className="ag-secondary">主密钥指纹</div>
              <div className="ag-mono" style={{ fontWeight: 600, marginTop: 4 }}>
                {keystore.kek_fingerprint}
              </div>
            </div>
          </div>

          <div
            className="ag-secondary"
            style={{
              padding: 12,
              borderRadius: 'var(--ag-radius-sm)',
              background: 'var(--ag-surface-raised)',
              border: '1px solid var(--ag-border)',
            }}
          >
            {/* 65 §3.2b：原样展示代价说明，不改写 */}
            {keystore.tradeoff_note}
          </div>
        </div>
      )}

      {/* 1.5 网关伪装 */}
      <div className="ag-card">
        <div className="ag-card-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 className="ag-section-title">网关伪装</h2>
            <StatusBadge tone={stealthEnabled ? 'success' : 'neutral'}>
              {stealthEnabled ? '已开启' : '未开启'}
            </StatusBadge>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={stealthEnabled}
              disabled={stealthSaving}
              onChange={(e) => void handleToggleStealth(e.target.checked)}
            />
            <span>启用伪装</span>
          </label>
        </div>

        <div className="ag-grid-stealth">
          <div>
            <label className="ag-secondary" style={{ display: 'block', marginBottom: 6 }}>
              伪装请求头
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                className="ag-input ag-mono"
                value={stealthHeader}
                placeholder="x-gateway-key"
                disabled={stealthSaving}
                onChange={(e) => setStealthHeader(e.target.value)}
              />
              <button
                type="button"
                className="ag-btn"
                disabled={stealthSaving}
                onClick={() => void handleSaveStealthHeader()}
              >
                保存
              </button>
            </div>
          </div>

          <div>
            <label className="ag-secondary" style={{ display: 'block', marginBottom: 6 }}>
              伪装密钥
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type="text"
                readOnly
                className="ag-input ag-mono"
                style={{ flex: '1 1 180px', minWidth: 0 }}
                value={stealthKey}
                placeholder="开启后自动生成"
              />
              <button
                type="button"
                className="ag-btn"
                disabled={!stealthKey || stealthSaving}
                onClick={() => void handleCopyStealthKey()}
              >
                复制密钥
              </button>
              <button
                type="button"
                className="ag-btn"
                disabled={stealthSaving}
                onClick={() => void handleRotateStealthKey()}
              >
                轮换密钥
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 2. 环境变量敏感引用登记表（只存变量名引用，不存明文值） */}
      <div className="ag-card">
        <div className="ag-card-header">
          <h2 className="ag-section-title">环境变量引用登记</h2>
          <button
            type="button"
            className="ag-btn ag-btn-sm ag-btn-primary"
            onClick={() => setRefModalOpen(true)}
          >
            登记引用
          </button>
        </div>

        {secretRefs.length === 0 ? (
          <div className="ag-secondary">暂无环境变量引用</div>
        ) : (
          <table className="ag-table">
            <thead>
              <tr>
                <th>引用名称</th>
                <th>环境变量引用</th>
                <th>备注</th>
                <th>更新时间</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {secretRefs.map((ref) => (
                <tr key={ref.name}>
                  <td style={{ fontWeight: 600 }}>{ref.name}</td>
                  <td className="ag-mono">{ref.ref}</td>
                  <td className="ag-secondary">{ref.note || '—'}</td>
                  <td className="ag-tabular ag-secondary">{formatDateTime(ref.updated_at)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="ag-btn ag-btn-sm ag-btn-danger"
                      onClick={() => setDeleteRefTarget(ref)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 3. 控制面审计日志（写操作留痕，绝不含密钥明文） */}
      <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px 0' }}>
          <h2 className="ag-section-title">控制面审计日志</h2>
        </div>
        <div className="ag-table-wrap">
          <table className="ag-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作者</th>
                <th>动作</th>
                <th>操作对象</th>
                <th>结果</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center' }}>
                    <span className="ag-secondary">暂无审计记录</span>
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="ag-tabular ag-secondary">{formatDateTime(log.ts)}</td>
                    <td className="ag-mono">{log.actor}</td>
                    <td className="ag-mono">{log.action}</td>
                    <td className="ag-mono">{log.subject}</td>
                    <td>
                      <StatusBadge tone={log.outcome === 'ok' ? 'success' : 'danger'}>
                        {log.outcome === 'ok' ? '成功' : '失败'}
                      </StatusBadge>
                    </td>
                    <td className="ag-secondary">{log.detail || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 轮换数据密钥确认 */}
      <ConfirmModal
        open={rotateDekOpen}
        title="轮换数据密钥"
        // ui-copy: allow 轮换数据密钥二次确认的后果说明（97 §5 #13）
        consequence="轮换后将生成新的数据加密密钥，并把现有记录重加密至新密钥。"
        confirmLabel="确认轮换"
        danger={false}
        loading={rotating}
        onConfirm={() => void handleRotateDek()}
        onCancel={() => setRotateDekOpen(false)}
      />

      {/* 轮换主密钥二次确认（97 §5 #13：破坏性操作须确认并说明后果） */}
      <ConfirmModal
        open={rotateKekOpen}
        title="轮换主密钥"
        // ui-copy: allow 轮换主密钥二次确认的后果说明（97 §5 #13）
        consequence="轮换主密钥会使旧密钥表立即作废，未备份的旧密文将永久无法解密。"
        confirmLabel="确认轮换主密钥"
        danger
        loading={rotating}
        onConfirm={() => void handleRotateKek()}
        onCancel={() => setRotateKekOpen(false)}
      >
        {keystore?.mode === 'passphrase' && (
          <div className="ag-field">
            <label className="ag-field-label">新主口令</label>
            <input
              type="password"
              className="ag-input ag-mono"
              value={newPassphrase}
              onChange={(e) => setNewPassphrase(e.target.value)}
              placeholder="输入新的主密钥口令"
            />
          </div>
        )}
      </ConfirmModal>

      {/* 登记环境变量引用弹窗 */}
      <Modal
        open={refModalOpen}
        title="登记环境变量引用"
        onClose={() => setRefModalOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="ag-btn"
              onClick={() => setRefModalOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              disabled={!refName.trim() || !refEnvVar.trim()}
              onClick={() => void handleCreateRef()}
            >
              保存引用
            </button>
          </>
        }
      >
        <div className="ag-field">
          <label className="ag-field-label">引用名称</label>
          <input
            className="ag-input ag-mono"
            value={refName}
            onChange={(e) => setRefName(e.target.value)}
            placeholder="例如 primary-deepseek-key"
          />
        </div>
        <div className="ag-field">
          <label className="ag-field-label">环境变量名（不填值）</label>
          <input
            className="ag-input ag-mono"
            value={refEnvVar}
            onChange={(e) => setRefEnvVar(e.target.value)}
            placeholder="例如 DEEPSEEK_API_KEY"
          />
        </div>
        <div className="ag-field">
          <label className="ag-field-label">备注</label>
          <input
            className="ag-input"
            value={refNote}
            onChange={(e) => setRefNote(e.target.value)}
            placeholder="选填说明"
          />
        </div>
      </Modal>

      <ConfirmModal
        open={deleteRefTarget !== null}
        title={`删除环境引用 · ${deleteRefTarget?.name ?? ''}`}
        // ui-copy: allow 删除环境变量引用二次确认的后果说明（97 §5 #13）
        consequence="删除后该环境变量引用登记将被移除。"
        confirmLabel="确认删除"
        onConfirm={() => void handleDeleteRef()}
        onCancel={() => setDeleteRefTarget(null)}
      />
    </div>
  );
}
