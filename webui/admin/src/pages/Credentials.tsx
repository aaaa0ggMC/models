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
  Toast,
  Tooltip,
  Typography,
} from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtTs } from '../format';
import { helpHref } from '../router';
import { EmptyState, PageHeader, StatusTag } from '../components/ui';
import type { MaskedCredential, ProviderConfig } from '../api/types';

/**
 * 健康状态的语义色。用 StatusTag 而不是 Semi 的 Tag：后者只有一套内置色板，
 * 而且**只靠颜色**区分状态（色盲用户分不出 green/grey）。
 */
const HEALTH: Record<string, { label: string; tone: 'neutral' | 'success' | 'danger' }> = {
  unknown: { label: '未知', tone: 'neutral' },
  ok: { label: '正常', tone: 'success' },
  error: { label: '异常', tone: 'danger' },
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
    {
      title: (
        <Tooltip content="渠道 id（见「渠道」页）；探测时按它找 base_url。">
          <span>provider</span>
        </Tooltip>
      ),
      dataIndex: 'provider',
    },
    {
      title: (
        <Tooltip content="provider.access_path 形式的唯一标识，也是探测接口的路径参数。">
          <span>access_path</span>
        </Tooltip>
      ),
      dataIndex: 'access_path',
    },
    {
      title: (
        <Tooltip content="服务端只回掩码，任何接口都拿不到完整 key；录入表单里那一次也不例外。">
          <span>掩码</span>
        </Tooltip>
      ),
      dataIndex: 'masked',
      render: (_: unknown, c: MaskedCredential) => (
        <span style={{ fontFamily: 'monospace' }}>{c.masked}</span>
      ),
    },
    { title: '长度', dataIndex: 'length', render: (_: unknown, c: MaskedCredential) => c.length },
    {
      title: (
        <Tooltip content="环境变量引用 / keyring / 加密存储：前两种值永远留在进程环境或 OS 凭据里，界面只登记引用。">
          <span>存储</span>
        </Tooltip>
      ),
      dataIndex: 'storage',
      render: (_: unknown, c: MaskedCredential) => storageText(c.storage),
    },
    {
      title: (
        <Tooltip content="上一次探测的结果；未知 = 还没探测过。">
          <span>健康</span>
        </Tooltip>
      ),
      dataIndex: 'health',
      render: (_: unknown, c: MaskedCredential) => {
        const h = HEALTH[c.health] ?? HEALTH.unknown!;
        return <StatusTag tone={h.tone}>{h.label}</StatusTag>;
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
      <PageHeader
        title="凭据"
        desc="一个渠道可以挂多条凭据（按 access_path 区分）。列表只显示掩码；完整 key 从不离开加密存储，探测时也由服务端代打。"
        actions={
          <Button theme="solid" type="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
            录入凭据
          </Button>
        }
        meta={
          <div className="ag-row" style={{ fontSize: 12, color: 'var(--ag-text-3)' }}>
            <span>共 {items.length} 条</span>
            <a href={helpHref('keystore')}>密钥存储与代价说明</a>
          </div>
        }
      />

      {error !== null ? (
        <div className="ag-banner ag-banner-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="ag-card">
        <Table
          className="ag-table"
          columns={columns}
          dataSource={items}
          rowKey="id"
          loading={loading}
          pagination={false}
          empty={
            <EmptyState
              title="还没有登记任何凭据"
              hint="凭据是网关访问上游时用的 key。支持直接粘贴（加密入库）或写 env:<VAR> 引用，两者互斥。"
            />
          }
        />
      </div>

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
