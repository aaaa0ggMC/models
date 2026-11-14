/**
 * src/pages/Login.tsx —— 登录页（口令 / 单 access token 二选一）。
 *
 * 输入框用 `type="password"`：防肩窥。提交成功即由 auth.tsx 把令牌存进**内存**，
 * 本页不碰任何持久化存储；刷新页面 = 重新登录（这是令牌只在内存的既定代价）。
 */

import { useState } from 'react';
import { Button, Card, Input, Tabs, Toast, Typography } from '@douyinfe/semi-ui';
import { useAuth } from '../auth';
import { errorText } from '../api/client';

export function Login(): JSX.Element {
  const { login, bootstrap } = useAuth();
  const [mode, setMode] = useState<'password' | 'token'>('password');
  const [password, setPassword] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    const value = mode === 'token' ? accessToken : password;
    if (value.length === 0) {
      Toast.error('请先填写登录信息');
      return;
    }
    setSubmitting(true);
    try {
      await login(
        mode === 'token' ? undefined : password,
        mode === 'token' ? accessToken : undefined,
      );
      // 登录成功后清空输入框：口令/token 不该在 DOM 里逗留。
      setPassword('');
      setAccessToken('');
      Toast.success('登录成功');
    } catch (err) {
      Toast.error(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--semi-color-bg-1)',
      }}
    >
      <Card style={{ width: 400, padding: 8 }} title="AgentGateway 管理面">
        <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 16 }}>
          登录后即可管理渠道、凭据、别名映射，并查看用量与对账。
        </Typography.Text>
        <Tabs
          activeKey={mode}
          onChange={(k) => setMode(k as 'password' | 'token')}
          size="large"
          style={{ marginBottom: 8 }}
        >
          <Tabs.TabPane tab="口令" itemKey="password">
            <Input
              type="password"
              size="large"
              placeholder="输入管理口令"
              value={password}
              onChange={setPassword}
              onEnterPress={() => void submit()}
              autoComplete="current-password"
            />
          </Tabs.TabPane>
          <Tabs.TabPane tab="access token" itemKey="token">
            <Input
              type="password"
              size="large"
              placeholder="粘贴单 access token"
              value={accessToken}
              onChange={setAccessToken}
              onEnterPress={() => void submit()}
              autoComplete="off"
            />
          </Tabs.TabPane>
        </Tabs>
        <Button
          theme="solid"
          type="primary"
          size="large"
          block
          loading={submitting}
          onClick={() => void submit()}
          style={{ marginTop: 12 }}
        >
          登录
        </Button>
        <Typography.Text type="tertiary" style={{ display: 'block', marginTop: 16, fontSize: 12 }}>
          会话令牌只保存在本页内存中，刷新或关闭标签页即失效。
          {bootstrap?.keystore?.mode ? ` 密钥模式：${bootstrap.keystore.mode}` : ''}
        </Typography.Text>
      </Card>
    </div>
  );
}
