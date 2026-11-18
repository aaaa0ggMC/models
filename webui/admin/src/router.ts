import { useEffect, useState } from 'react';

export type RouteId =
  | 'overview'
  | 'chat'
  | 'channels'
  | 'credentials'
  | 'balances'
  | 'keys'
  | 'aliases'
  | 'catalog'
  | 'routing'
  | 'usage'
  | 'plugins'
  | 'settings'
  | 'system'
  | 'help';

export type HelpSectionId =
  | 'overview'
  | 'channels'
  | 'modelFetch'
  | 'namespace'
  | 'deepseekSuite'
  | 'credentials'
  | 'clientKey'
  | 'authMode'
  | 'aliases'
  | 'catalog'
  | 'usage'
  | 'plugins'
  | 'settings'
  | 'keystore'
  | 'agent'
  | 'modalities'
  | 'limitations';

export interface NavItem {
  id: RouteId;
  label: string;
}

export type NavNode =
  | { kind: 'item'; item: NavItem }
  | { kind: 'group'; id: string; label: string; items: readonly NavItem[] };

/**
 * 信息架构（依据 97-admin-product-brief.md §3.2）：
 * - 单子项组一律拍平（概览、对话直接作为一级项）
 * - 多子项组按提问方向分四组：上游接入 / 客户端接入 / 模型与用量 / 系统
 */
export const NAV_TREE: readonly NavNode[] = [
  { kind: 'item', item: { id: 'overview', label: '概览' } },
  { kind: 'item', item: { id: 'chat', label: '对话' } },
  {
    kind: 'group',
    id: 'upstream',
    label: '上游接入',
    items: [
      { id: 'channels', label: '渠道' },
      { id: 'credentials', label: '凭据' },
      { id: 'balances', label: '余额与配额' },
    ],
  },
  {
    kind: 'group',
    id: 'client',
    label: '客户端接入',
    items: [
      { id: 'keys', label: '客户端密钥' },
      { id: 'aliases', label: '模型别名' },
    ],
  },
  {
    kind: 'group',
    id: 'models-usage',
    label: '模型与用量',
    items: [
      { id: 'catalog', label: '模型目录' },
      { id: 'routing', label: '路由引擎' },
      { id: 'usage', label: '用量看板' },
    ],
  },
  {
    kind: 'group',
    id: 'system-group',
    label: '系统',
    items: [
      { id: 'plugins', label: '插件与工具' },
      { id: 'settings', label: '系统设置' },
      { id: 'system', label: '安全与密钥' },
      { id: 'help', label: '帮助' },
    ],
  },
];

export const VALID_ROUTES = new Set<RouteId>([
  'overview',
  'chat',
  'channels',
  'credentials',
  'balances',
  'keys',
  'aliases',
  'catalog',
  'routing',
  'usage',
  'plugins',
  'settings',
  'system',
  'help',
]);

export const HELP_SECTIONS: Record<HelpSectionId, string> = {
  overview: '概览与指标口径',
  channels: '渠道与服务商预设',
  modelFetch: '拉取上游模型清单',
  namespace: '模型命名空间',
  deepseekSuite: '服务商能力状态与内置工具',
  credentials: '上游凭据与多密钥轮换',
  clientKey: '客户端密钥',
  authMode: '访问控制模式',
  aliases: '模型别名与路由优先级',
  catalog: '模型目录与同步',
  usage: '用量计费与余额对账',
  plugins: '插件系统与内置工具',
  settings: '系统设置与四层优先级',
  keystore: '加密存储与主密钥轮换',
  agent: '内置对话与隐私脱敏',
  modalities: '九大模态与五个工具端点',
  limitations: '已知缺口与待定项',
};

export interface ParsedRoute {
  route: RouteId;
  query: URLSearchParams;
}

export function parseHash(hash: string): ParsedRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const cleaned = raw.startsWith('/') ? raw.slice(1) : raw;
  const [pathPart = '', queryPart = ''] = cleaned.split('?');
  const seg = pathPart.split('/')[0]?.trim() as RouteId | undefined;
  const route: RouteId = seg && VALID_ROUTES.has(seg) ? seg : 'overview';
  return { route, query: new URLSearchParams(queryPart) };
}

export function buildHref(
  route: RouteId,
  params?: Record<string, string | undefined>,
): string {
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') sp.set(k, v);
    }
  }
  const qs = sp.toString();
  return `#/${route}${qs ? `?${qs}` : ''}`;
}

export function helpHref(section: HelpSectionId): string {
  return buildHref('help', { section });
}

export function navigate(
  route: RouteId,
  params?: Record<string, string | undefined>,
): void {
  const target = buildHref(route, params);
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

export function updateQueryParams(
  route: RouteId,
  updates: Record<string, string | undefined>,
): void {
  const current = parseHash(window.location.hash);
  const next = new URLSearchParams(current.route === route ? current.query : undefined);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === '') next.delete(k);
    else next.set(k, v);
  }
  const qs = next.toString();
  const target = `#/${route}${qs ? `?${qs}` : ''}`;
  if (window.location.hash !== target) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

export function useRouter(): ParsedRoute {
  const [state, setState] = useState<ParsedRoute>(() =>
    parseHash(typeof window !== 'undefined' ? window.location.hash : ''),
  );

  useEffect(() => {
    const onHash = () => setState(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
      window.history.replaceState(null, '', '#/overview');
      onHash();
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return state;
}
