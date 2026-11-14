/**
 * src/App.tsx —— 应用外壳：分组侧栏 + 顶栏 + 内容区 + 未登录门。
 *
 * ## 信息架构（改版前后）
 *
 * 改版前是 **9 个平铺**的导航项（渠道 / 凭据 / 客户端密钥 / 别名映射 / 模型目录 /
 * 用量看板 / 系统设置 / 安全与密钥 / 帮助），一列下来分不出主次。
 * 改版后按 NewAPI 的四组式侧边栏分组（总览 / 接入 / 模型与用量 / 系统），
 * 并把主场从「渠道」换成「概览」。前后对照见
 * `docs/design/90-admin-ui-redesign.md` §2。
 *
 * 分组用 Semi `Nav` 的**嵌套 `items`** 实现（`SubNavPropsWithItems.items`），
 * 不自己画侧栏——Nav 原生支持多级、可折叠（`isCollapsed`）、`footer` 挂用户区。
 *
 * 会话令牌只在内存（auth.tsx），未登录一律渲染登录页。
 */

import { useMemo } from 'react';
import { Layout, Nav, Toast, Typography } from '@douyinfe/semi-ui';
import {
  IconBolt,
  IconBook,
  IconCloud,
  IconHelpCircle,
  IconHistogram,
  IconKey,
  IconLink,
  IconList,
  IconLock,
  IconMoon,
  IconSetting,
  IconSun,
  IconUserCircle,
} from '@douyinfe/semi-icons';
import { useAuth } from './auth';
import { useTheme } from './theme';
import { ROUTES, useHashRoute } from './router';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Channels } from './pages/Channels';
import { Credentials } from './pages/Credentials';
import { Aliases } from './pages/Aliases';
import { ModelCatalog } from './pages/ModelCatalog';
import { Usage } from './pages/Usage';
import { System } from './pages/System';
import { VirtualKeys } from './pages/VirtualKeys';
import { Settings } from './pages/Settings';
import { Help } from './pages/Help';

/**
 * 导航分组。
 *
 * 分组名照 NewAPI 的四组式（它自己是 聊天/常规/个人/管理员）；我们按
 * 「网关管理员」的四个问题重排：跑得怎么样（总览）、请求怎么走上游（接入）、
 * 有哪些模型与花了多少（模型与用量）、系统怎么配（系统）。
 */
const NAV_GROUPS: Array<{
  itemKey: string;
  text: string;
  icon: React.ReactNode;
  items: Array<{ itemKey: string; text: string; icon: React.ReactNode }>;
}> = [
  {
    itemKey: 'g-overview',
    text: '总览',
    icon: <IconBolt />,
    items: [{ itemKey: ROUTES.overview, text: '概览', icon: <IconHistogram /> }],
  },
  {
    itemKey: 'g-access',
    text: '上游接入',
    icon: <IconCloud />,
    items: [
      { itemKey: ROUTES.channels, text: '渠道', icon: <IconCloud /> },
      { itemKey: ROUTES.credentials, text: '凭据', icon: <IconKey /> },
      { itemKey: ROUTES.aliases, text: '别名映射', icon: <IconLink /> },
    ],
  },
  {
    itemKey: 'g-model',
    text: '模型与用量',
    icon: <IconList />,
    items: [
      { itemKey: ROUTES.catalog, text: '模型目录', icon: <IconList /> },
      { itemKey: ROUTES.usage, text: '用量看板', icon: <IconHistogram /> },
    ],
  },
  {
    itemKey: 'g-system',
    text: '系统',
    icon: <IconSetting />,
    items: [
      { itemKey: ROUTES.virtualKeys, text: '客户端密钥', icon: <IconUserCircle /> },
      { itemKey: ROUTES.settings, text: '系统设置', icon: <IconSetting /> },
      { itemKey: ROUTES.system, text: '安全与密钥', icon: <IconLock /> },
      { itemKey: ROUTES.help, text: '帮助 / 文档', icon: <IconHelpCircle /> },
    ],
  },
];

/** 路由 → 属于哪个分组（顶栏标题与"当前位置"用）。 */
const ROUTE_TO_GROUP = new Map<string, string>();
for (const g of NAV_GROUPS) {
  for (const it of g.items) ROUTE_TO_GROUP.set(it.itemKey, g.text);
}

export function App(): JSX.Element {
  const { token, user, logout, bootstrap } = useAuth();
  const { resolved, toggle } = useTheme();
  const [route, navigate] = useHashRoute();

  const group = ROUTE_TO_GROUP.get(route);

  const renderPage = (): React.ReactNode => {
    switch (route) {
      case ROUTES.overview:
        return <Overview />;
      case ROUTES.credentials:
        return <Credentials />;
      case ROUTES.aliases:
        return <Aliases />;
      case ROUTES.catalog:
        return <ModelCatalog />;
      case ROUTES.usage:
        return <Usage />;
      case ROUTES.settings:
        return <Settings />;
      case ROUTES.system:
        return <System />;
      case ROUTES.help:
        return <Help />;
      case ROUTES.virtualKeys:
        return <VirtualKeys />;
      case ROUTES.channels:
      default:
        return <Channels />;
    }
  };

  const footer = useMemo(
    () => (
      <div className="ag-nav-foot">
        <div className="ag-nav-user">
          <span className="ag-nav-avatar" aria-hidden>
            {(user?.name ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span style={{ minWidth: 0 }}>
            <span className="ag-nav-user-name">{user?.name ?? '已登录'}</span>
            <span className="ag-nav-user-role">{user?.role ?? '—'}</span>
          </span>
        </div>
        {bootstrap?.api_version ? (
          <Typography.Text type="tertiary" className="ag-nav-version">
            控制面 API {bootstrap.api_version}
          </Typography.Text>
        ) : null}
        <Nav
          mode="horizontal"
          items={[
            {
              itemKey: 'logout',
              text: '退出登录',
              onClick: () => {
                void logout().then(() => Toast.success('已退出登录'));
              },
            },
          ]}
        />
      </div>
    ),
    [user, bootstrap, logout],
  );

  // 未登录：只渲染登录页（深链由登录成功后送回，见 Login）。
  if (token === null) {
    return <Login />;
  }

  return (
    <Layout className="ag-shell" style={{ height: '100vh' }}>
      <Layout.Sider className="ag-sider">
        <Nav
          items={NAV_GROUPS}
          selectedKeys={[route]}
          onSelect={(item) => navigate(String(item.itemKey))}
          header={
            <div className="ag-brand">
              <span className="ag-brand-mark" aria-hidden>
                AG
              </span>
              <span className="ag-brand-text">
                AgentGateway
                <small>管理面</small>
              </span>
            </div>
          }
          footer={footer}
          style={{ maxWidth: 232, height: '100%' }}
        />
      </Layout.Sider>

      <Layout className="ag-main">
        <header className="ag-topbar">
          <div className="ag-crumb">
            <span className="ag-crumb-group">{group ?? 'AgentGateway'}</span>
            <span className="ag-crumb-sep" aria-hidden>
              /
            </span>
            <span className="ag-crumb-page">{currentPageLabel(route)}</span>
          </div>
          <div className="ag-topbar-actions">
            <button
              type="button"
              className="ag-iconbtn"
              onClick={toggle}
              title={resolved === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
              aria-label={resolved === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            >
              {resolved === 'dark' ? <IconSun /> : <IconMoon />}
            </button>
            <a className="ag-iconbtn" href={`#${ROUTES.help}`} title="帮助 / 文档" aria-label="帮助 / 文档">
              <IconBook />
            </a>
          </div>
        </header>

        <Layout.Content className="ag-content">
          <div className="ag-page">{renderPage()}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function currentPageLabel(route: string): string {
  for (const g of NAV_GROUPS) {
    const hit = g.items.find((i) => i.itemKey === route);
    if (hit !== undefined) return hit.text;
  }
  return '概览';
}
