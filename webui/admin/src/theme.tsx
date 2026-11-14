/**
 * src/theme.tsx —— 明暗主题（**只负责给 body 挂/摘 `theme-mode` 属性**）。
 *
 * ## 为什么这么薄
 *
 * Semi 2.105 的暗色**纯靠 CSS**：`semi.min.css` 里 `body[theme-mode="dark"]`
 * 那一大块把整套令牌重定义了一遍，React 侧没有任何主题 API
 * （`ConfigProvider` 只有 locale / timeZone / direction / getPopupContainer，
 * **没有 `theme` prop**——1.x 有，2.105 移除了）。所以我们自己的 `--ag-*`
 * 令牌也同样只在 CSS 里分亮/暗两份（见 `src/styles/theme.css`），
 * 这里一行颜色都不写，只做三件事：
 *
 *   1. 读用户偏好（默认 `system`）；
 *   2. 把偏好换算成 `body[theme-mode]` 的有无；
 *   3. 偏好变化时重新挂一次。
 *
 * ## 为什么偏好可以进 localStorage
 *
 * 安全约定是「**会话令牌**只在内存」（auth.tsx），因为令牌是同源脚本要偷的
 * 东西。主题偏好不是凭据、不含任何身份信息，写 localStorage 是常规做法
 * （new-api 的 next-themes、各家 dashboard 都这么做）。两者不要混为一谈：
 * 这里出现 `localStorage` 不代表"把令牌也存进去了"。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'agentgateway.admin.theme';

/** 当前系统偏好（SSR 不存在，但本工程是纯客户端 SPA，不会走到）。 */
function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || window.matchMedia === undefined) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function readStored(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // 隐私模式 / 禁用存储：退回系统偏好，不影响使用。
  }
  return 'system';
}

/** 把偏好落到 body 属性上（ Semi 的暗色开关就是它）。 */
function apply(mode: ThemeMode): void {
  const dark = mode === 'dark' || (mode === 'system' && systemPrefersDark());
  if (dark) document.body.setAttribute('theme-mode', 'dark');
  else document.body.removeAttribute('theme-mode');
}

export interface ThemeState {
  mode: ThemeMode;
  /** 当前**实际**是不是暗色（`system` 模式下随系统变）。 */
  resolved: 'light' | 'dark';
  setMode(mode: ThemeMode): void;
  /** 在亮/暗之间切换（给顶栏那个按钮用）。 */
  toggle(): void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(readStored);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  const resolved: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  // 偏好 → body 属性。
  useEffect(() => {
    apply(mode);
  }, [mode]);

  // `system` 模式下跟随系统偏好变化（ Semi 官方文档推荐的接法）。
  useEffect(() => {
    if (mode !== 'system' || window.matchMedia === undefined) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下去就算了（隐私模式），本次会话仍然生效。
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setMode]);

  const value = useMemo<ThemeState>(() => ({ mode, resolved, setMode, toggle }), [
    mode,
    resolved,
    setMode,
    toggle,
  ]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme 必须在 <ThemeProvider> 内使用');
  return ctx;
}
