/**
 * src/router.ts —— 最小 hash 路由（不引 react-router，少一个依赖）。
 *
 * 深链形如 `/admin/#/channels`：浏览器请求 `/admin/`（hash 前的路径），网关静态
 * 托管回 index.html，客户端读 hash 决定渲染哪个页面。`/` 归一成 `/channels`
 * （渠道是主场，对标 NewAPI 的「渠道」为默认页）。
 *
 * hash 里允许带查询串（只有帮助页用：`#/help?section=keystore` 小节深链）。
 * `currentHash()` 先把 `?` 之后的查询串剥掉再匹配路由，查询串因此永远不会
 * 破坏路由判断；小节 id 由帮助页自己读（见 `currentHelpSection`）。
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
  if (path === '' || path === '/') return ROUTES.channels;
  return path.startsWith('/') ? path : `/${path}`;
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
