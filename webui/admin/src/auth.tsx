/**
 * src/auth.tsx —— 会话状态（**令牌只在内存**）+ 绑定好的 API 调用器。
 *
 * 安全硬要求（承自旧实现，不得弱化）：
 * - `token` 只活在 React state / ref 里，**不写 localStorage / sessionStorage**——
 *   那会让令牌在关闭标签页后仍可被同源任意脚本读到，而管理面威胁模型里同源 XSS
 *   是要防的。代价是刷新页面要重新登录，登录页与页脚都向用户明示。
 * - 401（带令牌）= 会话过期 → 清令牌回登录页；登录接口的 401 原样带给用户。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, type ClientHooks } from './api/client';
import type { BootstrapResponse, LoginResponse } from './api/types';

export interface AuthState {
  /** 当前会话令牌（内存）；null = 未登录。 */
  token: string | null; // privacy-scan: ignore —— AuthState 契约字段名（类型声明，无值）
  user: LoginResponse['user'] | null;
  bootstrap: BootstrapResponse | null;
  bootstrapError: string | null;
  login(password?: string, accessToken?: string): Promise<void>;
  logout(): Promise<void>;
  reloadBootstrap(): Promise<void>;
  /** 绑定好鉴权钩子的 API 调用器。 */
  call: <T>(path: string, options?: Parameters<typeof api>[1]) => Promise<T>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<LoginResponse['user'] | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  // 令牌的 ref 副本：给 getToken 用，避免闭包捕获旧 state。
  const tokenRef = useRef<string | null>(null);
  const setTokenBoth = useCallback((next: string | null) => {
    tokenRef.current = next;
    setToken(next);
  }, []);

  const onUnauthorized = useCallback(() => {
    tokenRef.current = null;
    setToken(null);
    setUser(null);
  }, []);

  const hooks: ClientHooks = useMemo(
    () => ({ getToken: () => tokenRef.current, onUnauthorized }),
    [onUnauthorized],
  );

  const call = useCallback(
    <T,>(path: string, options: Parameters<typeof api>[1] = {}) => api<T>(path, options, hooks),
    [hooks],
  );

  const reloadBootstrap = useCallback(async () => {
    try {
      const boot = await call<BootstrapResponse>('/bootstrap', { auth: false });
      setBootstrap(boot);
      setBootstrapError(null);
    } catch {
      setBootstrap(null);
      setBootstrapError('读不到引导信息（GET /admin/api/bootstrap）。');
    }
  }, [call]);

  const login = useCallback(
    async (password?: string, accessToken?: string) => {
      const body =
        accessToken !== undefined ? { access_token: accessToken } : { password: password ?? '' }; // privacy-scan: ignore —— LoginRequest 契约字段，右侧是登录表单输入，无字面量
      const res = await call<LoginResponse>('/login', {
        method: 'POST',
        body,
        auth: false,
        // 会话令牌是登录响应里唯一该出现的东西，但它的形态（43 位 base64url 随机串）
        // 与一把没有固定前缀的 provider key 无法从值上区分，只能显式开口子。
        // 登录响应里的其他字段照样过 secretTripwire。
        allowSessionToken: true,
      });
      if (res.ok !== true || typeof res.token !== 'string' || res.token.length === 0) {
        throw new Error(res.error ?? '登录响应里没有会话令牌（token）。');
      }
      setTokenBoth(res.token);
      setUser(res.user ?? null);
    },
    [call, setTokenBoth],
  );

  const logout = useCallback(async () => {
    try {
      await call('/logout', { method: 'POST', body: {} });
    } catch {
      // 退出失败也要清本地状态：服务端可能已作废该会话。
    }
    setTokenBoth(null);
    setUser(null);
  }, [call, setTokenBoth]);

  // 首屏拉一次引导（免鉴权）：决定「要不要登录」。
  useEffect(() => {
    void reloadBootstrap();
  }, [reloadBootstrap]);

  const value = useMemo<AuthState>(
    () => ({ token, user, bootstrap, bootstrapError, login, logout, reloadBootstrap, call }),
    [token, user, bootstrap, bootstrapError, login, logout, reloadBootstrap, call],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
