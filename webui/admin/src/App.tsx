/**
 * src/App.tsx —— 应用外壳：左侧 Semi Nav + 右侧内容区 + 未登录门。
 *
 * 信息架构对标 NewAPI（one-api 一系，React + Semi）：左侧一列导航，右侧是各功能页，
 * 每页自带的顶栏放「新建 + 搜索/过滤」，主体是表格——不放说明段落，信息密度优先。
 * 会话令牌只在内存（auth.tsx），未登录一律渲染登录页。
 */

import { Layout, Nav, Toast, Typography } from '@douyinfe/semi-ui';
import {
  IconCloud,
  IconHistogram,
  IconKey,
  IconLink,
  IconList,
  IconLock,
  IconSetting,
  IconUserCircle,
} from '@douyinfe/semi-icons';
import { useAuth } from './auth';
import { ROUTES, useHashRoute } from './router';
import { Login } from './pages/Login';
import { Channels } from './pages/Channels';
import { Credentials } from './pages/Credentials';
import { Aliases } from './pages/Aliases';
import { ModelCatalog } from './pages/ModelCatalog';
import { Usage } from './pages/Usage';
import { System } from './pages/System';
import { VirtualKeys } from './pages/VirtualKeys';
import { Settings } from './pages/Settings';

const NAV_ITEMS: Array<{ itemKey: string; text: string; icon: React.ReactNode }> = [
  { itemKey: ROUTES.channels, text: '渠道', icon: <IconCloud /> },
  { itemKey: ROUTES.credentials, text: '凭据', icon: <IconKey /> },
  { itemKey: ROUTES.virtualKeys, text: '客户端密钥', icon: <IconUserCircle /> },
  { itemKey: ROUTES.aliases, text: '别名映射', icon: <IconLink /> },
  { itemKey: ROUTES.catalog, text: '模型目录', icon: <IconList /> },
  { itemKey: ROUTES.usage, text: '用量看板', icon: <IconHistogram /> },
  { itemKey: ROUTES.settings, text: '系统设置', icon: <IconSetting /> },
  { itemKey: ROUTES.system, text: '安全与密钥', icon: <IconLock /> },
];

export function App(): JSX.Element {
  const { token, user, logout, bootstrap } = useAuth();
  const [route, navigate] = useHashRoute();

  // 未登录：只渲染登录页（深链由登录成功后送回，见 Login）。
  if (token === null) {
    return <Login />;
  }

  const renderPage = (): React.ReactNode => {
    switch (route) {
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
      case ROUTES.virtualKeys:
        return <VirtualKeys />;
      case ROUTES.channels:
      default:
        return <Channels />;
    }
  };

  const footer = (
    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--semi-color-border)' }}>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        {user?.name ? `${user.name}（${user.role}）` : '已登录'}
      </div>
      {bootstrap?.api_version ? (
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          控制面 API {bootstrap.api_version}
        </Typography.Text>
      ) : null}
      <div style={{ marginTop: 8 }}>
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
    </div>
  );

  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Sider style={{ background: 'var(--semi-color-bg-2)' }}>
        <Nav
          items={NAV_ITEMS}
          selectedKeys={[route]}
          onSelect={(item) => navigate(String(item.itemKey))}
          header={
            <div style={{ padding: '16px 16px 8px', fontWeight: 600, fontSize: 16 }}>
              AgentGateway
              <Typography.Text type="tertiary" style={{ fontSize: 12, marginLeft: 6 }}>
                管理面
              </Typography.Text>
            </div>
          }
          footer={footer}
          style={{ maxWidth: 220, height: '100%' }}
        />
      </Layout.Sider>
      <Layout style={{ overflow: 'hidden' }}>
        <Layout.Content
          style={{
            padding: 24,
            overflow: 'auto',
            background: 'var(--semi-color-bg-0)',
            height: '100%',
          }}
        >
          {renderPage()}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
