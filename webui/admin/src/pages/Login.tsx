import React, { useState } from 'react';
import { adminApi, type ActionableError } from '../api/client.js';
import type { BootstrapResponse } from '../api/types.js';
import { BrandLogo, ErrorBanner, SegmentedControl, StatusBadge } from '../components/ui.js';

export function LoginPage({
  bootstrap,
  urlLoginError = null,
  onLoggedIn,
}: {
  bootstrap: BootstrapResponse | null;
  /** 门户一键进入失败的原因（链接里的访问令牌无效）；由 App 传入。 */
  urlLoginError?: ActionableError | null;
  onLoggedIn: () => void;
}): React.JSX.Element {
  const [loginMode, setLoginMode] = useState<'password' | 'token'>('password');
  const [credential, setCredential] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ActionableError | null>(null);
  // 门户链接令牌失效时，错误亮在登录页上（用户这时本来就要手动输一次）。
  const shownError = error ?? urlLoginError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!credential.trim()) {
      setError({ category: '缺少输入', message: '请输入登录凭据' });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.login(
        loginMode === 'password'
          ? { password: credential } // privacy-scan: ignore —— 登录表单内存状态
          : { access_token: credential }, // privacy-scan: ignore —— 登录表单内存状态
      );
      if (!res.ok) {
        setError({
          category: '认证未通过',
          message: res.error ?? '凭据不正确',
        });
        return;
      }
      onLoggedIn();
    } catch (err) {
      setError({
        category: '登录异常',
        message: err instanceof Error ? err.message : '登录请求未完成',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ag-login">
      <form className="ag-login-card" onSubmit={handleSubmit}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="ag-brand-title" style={{ fontSize: 18 }}>
            <BrandLogo size={26} />
            <span>AgentGateway</span>
          </div>
          {bootstrap && (
            <StatusBadge tone={bootstrap.storage_unlocked ? 'success' : 'warning'}>
              {bootstrap.storage_unlocked ? '存储已解锁' : '存储未解锁'}
            </StatusBadge>
          )}
        </div>

        <SegmentedControl
          value={loginMode}
          options={[
            { value: 'password', label: '管理员口令' },
            { value: 'token', label: '访问令牌' },
          ]}
          onChange={(m) => {
            setLoginMode(m);
            setError(null);
          }}
        />

        <ErrorBanner error={shownError} onDismiss={() => setError(null)} />

        <div className="ag-field">
          <label className="ag-field-label">
            {loginMode === 'password' ? '管理员口令' : '访问令牌'}
          </label>
          <input
            type="password"
            className="ag-input ag-mono"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={loginMode === 'password' ? '输入管理员口令' : '输入访问令牌'}
            autoFocus
          />
        </div>

        <button type="submit" className="ag-btn ag-btn-primary" disabled={loading}>
          {loading ? '验证中…' : '进入控制面'}
        </button>

        {bootstrap?.keystore?.tradeoff_note && (
          <div
            className="ag-secondary"
            style={{
              paddingTop: 12,
              borderTop: '1px solid var(--ag-border)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              密钥模式：{bootstrap.keystore.mode === 'passphrase' ? '口令派生' : '密钥文件'}
            </div>
            {/* 65 §3.2b：原样展示代价说明 */}
            <div>{bootstrap.keystore.tradeoff_note}</div>
          </div>
        )}
      </form>
    </div>
  );
}
