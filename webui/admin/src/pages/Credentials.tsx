/**
 * src/pages/Credentials.tsx —— 凭据页。
 *
 * 表格只展示**掩码**（masked），任何路径都拿不到完整 key；支持录入 / 删除 / 探测。
 * 完整 key 只在录入表单里出现一次，提交后立刻加密入库，响应不回显、不写日志。
 * 安全约定与 secretTripwire 见 api/client.ts。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtTs } from '../format';
import type { MaskedCredential, ProviderConfig } from '../api/types';

const HEALTH: Record<string, { label: string; color: 'grey' | 'green' | 'red' }> = {
  unknown: { label: '未知', color: 'grey' },
  ok: { label: '正常', color: 'green' },
  error: { label: '异常', color: 'red' },
};

function storageText(s: MaskedCredential['storage']): string {
  if (s.location === 'env') return `环境变量 ${s.ref}`;
  if (s.location === 'keyring') return `keyring ${s.ref}`;
  return '加密存储';
}

export function Credentials(): JSX.Element {
  const { call } = useAuth();
  const [items, setItems] = useState<MaskedCredential[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    provider: '',
    accessPath: '',
    secret: '',
    envRef: '',
    note: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cred, prov] = await Promise.all([
        call<{ items: MaskedCredential[] }>('/credentials'),
        call<{ items: ProviderConfig[] }>('/providers'),
      ]);
      setItems(cred.items ?? []);
      setProviders(prov.items ?? []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    const provider = form.provider.trim();
    const accessPath = form.accessPath.trim();
    if (provider.length === 0 || accessPath.length === 0) {
      Toast.error('provider 与 access_path 不能为空');
      return;
    }
    if (form.secret.length > 0 && form.envRef.length > 0) {
      Toast.error('「完整密钥」与「环境变量引用」互斥，只能填一个');
      return;
    }
    if (form.secret.length === 0 && form.envRef.length === 0) {
      Toast.error('请填完整密钥，或改用环境变量引用');
      return;
    }
    try {
      const body = {
        provider,
        access_path: accessPath,
        ...(form.envRef.length > 0 ? { env_ref: form.envRef } : { secret: form.secret }), // privacy-scan: ignore —— CredentialCreateRequest 契约字段，右侧是表单输入
        ...(form.note.trim().length > 0 ? { note: form.note.trim() } : {}),
      };
      await call('/credentials', { method: 'POST', body });
      setCreating(false);
      setForm({ provider: '', accessPath: '', secret: '', envRef: '', note: '' });
      Toast.success('已入库。服务端没有回显完整密钥，这是预期行为。');
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const probe = async (c: MaskedCredential): Promise<void> => {
    try {
      const res = await call<{
        ok: boolean;
        status: string;
        upstream_status?: number;
        message?: string;
      }>(`/credentials/${encodeURIComponent(c.access_path)}/probe`, { method: 'POST', body: {} });
      const bits = [res.status === 'ok' ? '连通' : `失败（${res.status}）`];
      if (res.upstream_status !== undefined) bits.push(`上游 HTTP ${res.upstream_status}`);
      if (res.message) bits.push(res.message);
      if (res.status === 'ok') Toast.success(bits.join(' · '));
      else Toast.error(bits.join(' · '));
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const remove = async (c: MaskedCredential): Promise<void> => {
    try {
      await call(`/credentials/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      Toast.success('已删除凭据');
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const columns = [
    { title: 'provider', dataIndex: 'provider' },
    { title: 'access_path', dataIndex: 'access_path' },
    {
      title: '掩码',
      dataIndex: 'masked',
      render: (_: unknown, c: MaskedCredential) => (
        <span style={{ fontFamily: 'monospace' }}>{c.masked}</span>
      ),
    },
    { title: '长度', dataIndex: 'length', render: (_: unknown, c: MaskedCredential) => c.length },
    {
      title: '存储',
      dataIndex: 'storage',
      render: (_: unknown, c: MaskedCredential) => storageText(c.storage),
    },
    {
      title: '健康',
      dataIndex: 'health',
      render: (_: unknown, c: MaskedCredential) => {
        const h = HEALTH[c.health] ?? HEALTH.unknown!;
        return <Tag color={h.color}>{h.label}</Tag>;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      render: (_: unknown, c: MaskedCredential) => fmtTs(c.created_at),
    },
    {
      title: '操作',
      dataIndex: 'operate',
      render: (_: unknown, c: MaskedCredential) => (
        <Space>
          <Button theme="borderless" size="small" onClick={() => void probe(c)}>
            探测
          </Button>
          <Popconfirm
            title={`确定删除凭据「${c.provider} / ${c.access_path}」？不可撤销。`}
            onConfirm={() => void remove(c)}
          >
            <Button theme="borderless" type="danger" size="small">
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <Button theme="solid" type="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
          录入凭据
        </Button>
        <div style={{ flex: 1 }} />
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          列表只显示掩码；完整 key 从不离开加密存储。
        </Typography.Text>
      </div>

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      <Table
        columns={columns}
        dataSource={items}
        rowKey="id"
        loading={loading}
        pagination={false}
        empty="还没有登记任何凭据。"
      />

      <Modal
        visible={creating}
        title="录入凭据"
        onCancel={() => setCreating(false)}
        onOk={() => void create()}
        okText="入库"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Typography.Text strong>provider</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              filter
              placeholder="选择已配置的渠道"
              value={form.provider}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  provider: String(v),
                  accessPath: f.accessPath || `${String(v)}.openai-chat`,
                }))
              }
              optionList={providers.map((p) => ({ value: p.id, label: `${p.label}（${p.id}）` }))}
            />
          </div>
          <div>
            <Typography.Text strong>access_path</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.accessPath}
              onChange={(v) => setForm((f) => ({ ...f, accessPath: v }))}
              placeholder="如 deepseek.openai-chat"
            />
          </div>
          <div>
            <Typography.Text strong>完整密钥</Typography.Text>
            <Input
              type="password"
              style={{ marginTop: 6 }}
              value={form.secret}
              onChange={(v) => setForm((f) => ({ ...f, secret: v }))}
              placeholder="sk-..."
            />
          </div>
          <div>
            <Typography.Text strong>或环境变量引用</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.envRef}
              onChange={(v) => setForm((f) => ({ ...f, envRef: v }))}
              placeholder="env:DEEPSEEK_API_KEY"
            />
          </div>
          <div>
            <Typography.Text strong>备注</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.note}
              onChange={(v) => setForm((f) => ({ ...f, note: v }))}
              placeholder="只写用途，勿写密钥"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
