import React, { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, setOnUnauthorized, type ActionableError } from './api/client.js';
import type { BootstrapResponse } from './api/types.js';
import { BrandLogo, SegmentedControl, StatusBadge } from './components/ui.js';
import { AliasesPage } from './pages/Aliases.js';
import { ChannelsPage } from './pages/Channels.js';
import { ChatPage } from './pages/Chat.js';
import { HelpPage } from './pages/Help.js';
import { LoginPage } from './pages/Login.js';
import { ModelCatalogPage } from './pages/ModelCatalog.js';
import { OverviewPage } from './pages/Overview.js';
import { PluginsPage } from './pages/Plugins.js';
import { ProviderBalancesPage } from './pages/ProviderBalances.js';
import { RoutingEnginePage } from './pages/RoutingEngine.js';
import { SettingsPage } from './pages/Settings.js';
import { SystemPage } from './pages/System.js';
import { UsagePage } from './pages/Usage.js';
import { VirtualKeysPage } from './pages/VirtualKeys.js';
import { buildHref, NAV_TREE, useRouter } from './router.js';
import { type ThemeMode, useTheme } from './theme.js';
import { readAccessTokenFromSearch, urlWithoutAccessToken } from './url-token.js';

export function App(): React.JSX.Element {
  const { route, query } = useRouter();
  const { mode, setMode } = useTheme();

  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [bootstrapping, setBootstrapping] = useState<boolean>(true);
  /** 门户一键进入失败的原因（链接里的访问令牌无效）；null = 没失败。 */
  const [urlLoginError, setUrlLoginError] = useState<ActionableError | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  // 一键登录只试一次：失败后留给用户手动输，不要每次渲染都重打登录接口。
  const urlLoginTried = useRef(false);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [route]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileNavOpen]);

  const checkBootstrap = useCallback(async () => {
    setBootstrapping(true);
    try {
      const res = await adminApi.bootstrap();
      setBootstrap(res);
      setAuthenticated(res.authenticated);
    } catch {
      setAuthenticated(false);
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    setOnUnauthorized(() => setAuthenticated(false));
    void checkBootstrap();
    return () => setOnUnauthorized(null);
  }, [checkBootstrap]);

  // 门户「一键进入」：yslwd-gate 服务清单把 `?access_token=<管理访问令牌>` 写进跳转
  // URL，点进来就在这里换成会话令牌，换完立刻把令牌从地址栏抹掉（不进浏览器历史、
  // 不进 Referer；会话令牌仍旧只在内存）。引导信息到手后才试，且只试一次——
  // 失败就亮一条错误让用户手动登录。
  useEffect(() => {
    if (bootstrapping || authenticated || urlLoginTried.current) return;
    const fromUrl = readAccessTokenFromSearch(window.location.search);
    if (fromUrl === null) return;
    urlLoginTried.current = true;
    void (async () => {
      try {
        const res = await adminApi.login({ access_token: fromUrl });
        if (!res.ok) throw new Error(res.error ?? '登录未通过');
        const { pathname, hash } = window.location;
        window.history.replaceState(
          null,
          '',
          urlWithoutAccessToken(pathname, hash, window.location.search),
        );
        setAuthenticated(true);
        void checkBootstrap();
      } catch (err) {
        setUrlLoginError({
          category: '链接已失效',
          // ui-copy: allow 错误反馈（门户一键进入失败）：照实说「链接里的访问令牌不可用」并附上服务端给的原因，用户据此判断是去门户重新取链还是手动登录
          message: `门户链接里的访问令牌不可用：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
  }, [bootstrapping, authenticated, checkBootstrap]);

  async function handleLogout() {
    await adminApi.logout();
    setAuthenticated(false);
  }

  if (bootstrapping) {
    return (
      <div className="ag-login">
        <div className="ag-login-card" style={{ alignItems: 'center' }}>
          <div className="ag-brand-title">
            <span className="ag-brand-dot" />
            <span>AgentGateway</span>
          </div>
          <span className="ag-secondary">正在连接控制面…</span>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <LoginPage
        bootstrap={bootstrap}
        urlLoginError={urlLoginError}
        onLoggedIn={() => {
          setAuthenticated(true);
          void checkBootstrap();
        }}
      />
    );
  }

  return (
    <div className="ag-shell">
      <header className="ag-mobile-topbar">
        <div className="ag-mobile-topbar-left">
          <button
            type="button"
            className="ag-btn ag-btn-sm ag-icon-btn ag-mobile-menu-btn"
            aria-label="打开导航"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <span className="ag-hamburger" aria-hidden="true">
              <span className="ag-hamburger-line" />
              <span className="ag-hamburger-line" />
              <span className="ag-hamburger-line" />
            </span>
          </button>
          <a href={buildHref('overview')} className="ag-mobile-brand">
            <BrandLogo size={20} />
            <span>AgentGateway</span>
          </a>
        </div>
        {bootstrap && !bootstrap.storage_unlocked && (
          <StatusBadge tone="warning">未解锁</StatusBadge>
        )}
      </header>

      {mobileNavOpen && (
        <div
          className="ag-sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        className={`ag-sidebar${mobileNavOpen ? ' is-open' : ''}`}
        aria-label="主导航"
      >
        <div className="ag-brand">
          <div>
            <div className="ag-brand-title">
              <BrandLogo size={22} />
              <span>AgentGateway</span>
            </div>
            <div className="ag-brand-sub">控制面</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {bootstrap && !bootstrap.storage_unlocked && (
              <StatusBadge tone="warning">未解锁</StatusBadge>
            )}
            <button
              type="button"
              className="ag-btn ag-btn-sm ag-icon-btn ag-mobile-close-btn"
              aria-label="关闭导航"
              onClick={() => setMobileNavOpen(false)}
            >
              ×
            </button>
          </div>
        </div>

        <nav className="ag-nav">
          {NAV_TREE.map((node) => {
            if (node.kind === 'item') {
              const active = route === node.item.id;
              return (
                <a
                  key={node.item.id}
                  href={buildHref(node.item.id)}
                  className={`ag-nav-item${active ? ' is-active' : ''}`}
                  onClick={() => setMobileNavOpen(false)}
                >
                  <span>{node.item.label}</span>
                </a>
              );
            }
            return (
              <div key={node.id} className="ag-nav-group">
                <div className="ag-nav-group-label">{node.label}</div>
                {node.items.map((sub) => {
                  const active = route === sub.id;
                  return (
                    <a
                      key={sub.id}
                      href={buildHref(sub.id)}
                      className={`ag-nav-item${active ? ' is-active' : ''}`}
                      onClick={() => setMobileNavOpen(false)}
                    >
                      <span>{sub.label}</span>
                    </a>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="ag-sidebar-footer">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span className="ag-secondary">外观</span>
            <SegmentedControl<ThemeMode>
              value={mode}
              options={[
                { value: 'light', label: '亮' },
                { value: 'dark', label: '暗' },
                { value: 'system', label: '自动' },
              ]}
              onChange={setMode}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span className="ag-secondary ag-mono">
              {bootstrap?.user?.name ?? 'admin'}
            </span>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => void handleLogout()}
            >
              退出登录
            </button>
          </div>
        </div>
      </aside>

      <main className="ag-main">
        <div key={route} className="ag-page-enter">
          {route === 'overview' && <OverviewPage query={query} bootstrap={bootstrap} />}
          {route === 'chat' && <ChatPage />}
          {route === 'channels' && <ChannelsPage />}
          {route === 'balances' && <ProviderBalancesPage />}
          {route === 'keys' && <VirtualKeysPage />}
          {route === 'aliases' && <AliasesPage />}
          {route === 'catalog' && <ModelCatalogPage query={query} />}
          {route === 'routing' && <RoutingEnginePage />}
          {route === 'usage' && <UsagePage query={query} />}
          {route === 'plugins' && <PluginsPage />}
          {route === 'settings' && <SettingsPage />}
          {route === 'system' && <SystemPage />}
          {route === 'help' && <HelpPage query={query} />}
        </div>
      </main>
    </div>
  );
}
