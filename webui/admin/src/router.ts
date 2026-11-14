/**
 * src/router.ts —— 最小 hash 路由（不引 react-router，少一个依赖）。
 *
 * 深链形如 `/admin/#/channels`：浏览器请求 `/admin/`（hash 前的路径），网关静态
 * 托管回 index.html，客户端读 hash 决定渲染哪个页面。`/` 归一成**概览**
 * （改版后主场从「渠道」变成「概览」：管理员开门第一眼该看到网关跑得怎么样，
 * 而不是一屏上游配置；渠道仍旧 `#/channels` 直达，老书签不失效）。
 *
 * hash 里允许带查询串：帮助页用它带小节深链（`?section=keystore`），
 * 用量页用它带时间范围（`?range=7d`）。`currentHash()` 先把 `?` 之后的查询串
 * 剥掉再匹配路由，查询串因此永远不会破坏路由判断；小节 id / 范围由各页自己读。
 */

import { useCallback, useEffect, useState } from 'react';

export const ROUTES = {
  overview: '/overview',
  channels: '/channels',
  credentials: '/credentials',
  virtualKeys: '/virtual-keys',
  aliases: '/aliases',
  catalog: '/catalog',
  usage: '/usage',
  system: '/system',
  settings: '/settings',
  help: '/help',
} as const;

export type RouteKey = keyof typeof ROUTES;

/**
 * 帮助页的小节锚点。各功能页用 `helpHref()` 拼深链，不自己拼字符串——
 * 增删小节只改这里一处。
 */
export const HELP_SECTIONS = {
  settings: 'settings',
  keystore: 'keystore',
  clientKey: 'client-key',
  aliases: 'aliases',
  catalog: 'catalog',
  usage: 'usage',
} as const;

export type HelpSection = keyof typeof HELP_SECTIONS;

/** 指向帮助页某个小节的深链（形如 `#/help?section=keystore`）。 */
export function helpHref(section: HelpSection): string {
  return `#${ROUTES.help}?section=${HELP_SECTIONS[section]}`;
}

/** 当前 hash 指向的帮助小节 id；不在帮助页或没带 section 时返回 null。 */
export function currentHelpSection(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  if (q === -1) return null;
  const section = new URLSearchParams(raw.slice(q + 1)).get('section');
  return section === null || section === '' ? null : section;
}

/** hash 去掉查询串后的路径（`/help?section=keystore` → `/help`）。 */
function currentHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  const path = raw.split('?')[0] ?? '';
  if (path === '' || path === '/') return ROUTES.overview;
  return path.startsWith('/') ? path : `/${path}`;
}

/** 当前 hash 的查询串（用量页的时间范围从这里读：刷新 / 分享链接不丢状态）。 */
export function currentQuery(): URLSearchParams {
  const raw = window.location.hash.replace(/^#/, '');
  const q = raw.indexOf('?');
  if (q === -1) return new URLSearchParams();
  return new URLSearchParams(raw.slice(q + 1));
}

export function useHashRoute(): [string, (path: string, query?: Record<string, string>) => void] {
  const [route, setRoute] = useState<string>(currentHash);

  useEffect(() => {
    const onChange = (): void => setRoute(currentHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((path: string, query?: Record<string, string>) => {
    const qs = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
    const target = `${path.startsWith('#') ? path : `#${path}`}${qs}`;
    if (window.location.hash === target) {
      setRoute(currentHash());
    } else {
      window.location.hash = target;
    }
  }, []);

  return [route, navigate];
}
