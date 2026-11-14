/**
 * src/router.ts —— 最小 hash 路由（不引 react-router，少一个依赖）。
 *
 * 深链形如 `/admin/#/channels`：浏览器请求 `/admin/`（hash 前的路径），网关静态
 * 托管回 index.html，客户端读 hash 决定渲染哪个页面。`/` 归一成 `/channels`
 * （渠道是主场，对标 NewAPI 的「渠道」为默认页）。
 */

import { useCallback, useEffect, useState } from 'react';

export const ROUTES = {
  channels: '/channels',
  credentials: '/credentials',
  virtualKeys: '/virtual-keys',
  aliases: '/aliases',
  catalog: '/catalog',
  usage: '/usage',
  system: '/system',
  settings: '/settings',
} as const;

export type RouteKey = keyof typeof ROUTES;

function currentHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (raw === '' || raw === '/') return ROUTES.channels;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function useHashRoute(): [string, (path: string) => void] {
  const [route, setRoute] = useState<string>(currentHash);

  useEffect(() => {
    const onChange = (): void => setRoute(currentHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((path: string) => {
    const target = path.startsWith('#') ? path : `#${path}`;
    if (window.location.hash === target) {
      setRoute(currentHash());
    } else {
      window.location.hash = target;
    }
  }, []);

  return [route, navigate];
}
