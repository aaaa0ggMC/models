/**
 * src/pages/VirtualKeys.tsx —— 客户端密钥（数据面 virtual key）页。
 *
 * 安全约定（承自旧实现，不得弱化；唯一事实来源 66-auth.md §2.2）：
 *   1. **完整密钥只在新建响应里返回一次**：本页把它放进一个「仅此一次」的模态框，
 *      关掉就再也没有任何入口能拿到它（列表只回掩码与前 8 位）。
 *   2. **绝不明文回显**：表格里只有 `masked` 与 `head`，没有任何字段承载明文。
 *   3. **不进 localStorage**：会话令牌只在内存，密钥更不落浏览器存储。
 *   4. secretTripwire 默认会拦下任何 secret 形字段；只有新建那一次调用显式带
 *      `allowPlaintext: true`（见 api/client.ts）。
 *
 * 这一页同时展示数据面认证模式：虚拟 key 与 `AG_ACCESS_TOKEN` 是**互斥**的
 * （见后端 auth/data-plane.ts 的文件头），模式不对时页面顶部直接说清。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtInt, fmtTs } from '../format';
import type {
  AuthModeResponse,
  VirtualKeyCreateResponse,
  VirtualKeyDto,
  VirtualKeyUsage,
} from '../api/types';

const SOURCE_LABEL: Record<string, { label: string; color: 'grey' | 'green' | 'red' }> = {
  active: { label: '启用', color: 'green' },
  revoked: { label: '已撤销', color: 'red' },
};

/** 把「2026-01-01T00:00」这种 datetime-local 值转成 epoch ms。 */
function localDateTimeToMs(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function VirtualKeys(): JSX.Element {
  const { call } = useAuth();
  const [items, setItems] = useState<VirtualKeyDto[]>([]);
  const [authMode, setAuthMode] = useState<AuthModeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    note: '',
    models: '',
    providers: '',
    expiresAtLocal: '',
  });

  /** 新建成功后「仅此一次」的明文。关闭模态框即从 state 里消失。 */
  const [issued, setIssued] = useState<{ plaintext: string; key: VirtualKeyDto } | null>(null);
  const [usageFor, setUsageFor] = useState<VirtualKeyUsage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, mode] = await Promise.all([
        call<{ items: VirtualKeyDto[] }>('/virtual-keys'),
        call<AuthModeResponse>('/auth-mode'),
      ]);
      setItems(list.items ?? []);
      setAuthMode(mode);
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
    const name = form.name.trim();
    if (name.length === 0) {
      Toast.error('name 不能为空');
      return;
    }
    const models = form.models
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const providers = form.providers
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const expiresAt = localDateTimeToMs(form.expiresAtLocal);
    if (form.expiresAtLocal.trim() !== '' && expiresAt === undefined) {
      Toast.error('过期时间解析不了');
      return;
    }
    try {
      const res = await call<VirtualKeyCreateResponse>('/virtual-keys', {
        method: 'POST',
        // allowPlaintext：全管理面唯一允许渲染完整密钥的调用（66 §2.2）
        allowPlaintext: true,
        body: {
          name,
          ...(form.note.trim().length > 0 ? { note: form.note.trim() } : {}),
          ...(models.length > 0 ? { models } : {}),
          ...(providers.length > 0 ? { providers } : {}),
          ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
        },
      });
      setCreating(false);
      setForm({ name: '', note: '', models: '', providers: '', expiresAtLocal: '' });
      // 只在这里留住明文；关掉模态框就从 state 里消失
      setIssued({ plaintext: res.plaintext, key: res.key });
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const revoke = async (k: VirtualKeyDto): Promise<void> => {
    try {
      await call(`/virtual-keys/${encodeURIComponent(k.key_id)}/revoke`, {
        method: 'POST',
        body: {},
      });
      Toast.success('已撤销；使用该 key 的请求会立刻 401');
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const remove = async (k: VirtualKeyDto): Promise<void> => {
    try {
      await call(`/virtual-keys/${encodeURIComponent(k.key_id)}`, { method: 'DELETE' });
      Toast.success('已删除');
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const showUsage = async (k: VirtualKeyDto): Promise<void> => {
    try {
      const res = await call<{ ok: boolean; usage: VirtualKeyUsage }>(
        `/virtual-keys/${encodeURIComponent(k.key_id)}/usage`,
      );
      setUsageFor(res.usage);
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name' },
    {
      title: '掩码',
      dataIndex: 'masked',
      render: (_: unknown, k: VirtualKeyDto) => (
        <span style={{ fontFamily: 'monospace' }}>{k.masked}</span>
      ),
    },
    {
      title: 'key_id',
      dataIndex: 'key_id',
      render: (_: unknown, k: VirtualKeyDto) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{k.key_id}</span>
      ),
    },
    {
      title: '模型限制',
      dataIndex: 'models',
      render: (_: unknown, k: VirtualKeyDto) =>
        k.models === undefined || k.models.length === 0 ? (
          <Typography.Text type="tertiary">全部</Typography.Text>
        ) : (
          k.models.join(', ')
        ),
    },
    {
      title: 'provider 限制',
      dataIndex: 'providers',
      render: (_: unknown, k: VirtualKeyDto) =>
        k.providers === undefined || k.providers.length === 0 ? (
          <Typography.Text type="tertiary">全部</Typography.Text>
        ) : (
          k.providers.join(', ')
        ),
    },
    {
      title: '过期',
      dataIndex: 'expires_at',
      render: (_: unknown, k: VirtualKeyDto) =>
        k.expires_at === undefined ? (
          <Typography.Text type="tertiary">不过期</Typography.Text>
        ) : (
          fmtTs(k.expires_at)
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_: unknown, k: VirtualKeyDto) => {
        const s = SOURCE_LABEL[k.status] ?? SOURCE_LABEL.active!;
        return <Tag color={s.color}>{s.label}</Tag>;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      render: (_: unknown, k: VirtualKeyDto) => fmtTs(k.created_at),
    },
    {
      title: '操作',
      dataIndex: 'operate',
      render: (_: unknown, k: VirtualKeyDto) => (
        <Space>
          <Button theme="borderless" size="small" onClick={() => void showUsage(k)}>
            用量
          </Button>
          {k.status === 'active' ? (
            <Popconfirm
              title={`撤销「${k.name}」？撤销后使用该 key 的请求会立刻返回 401。`}
              onConfirm={() => void revoke(k)}
            >
              <Button theme="borderless" size="small">
                撤销
              </Button>
            </Popconfirm>
          ) : null}
          <Popconfirm
            title={`彻底删除「${k.name}」？连审计痕迹一起消失，不可撤销。`}
            onConfirm={() => void remove(k)}
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
      {authMode !== null && authMode.ignored.length > 0 ? (
        <Banner
          type="warning"
          title="数据面认证配置冲突"
          description={
            <>
              当前模式：<Tag color="green">{authMode.mode}</Tag>；{authMode.ignored.join('；')}
              。互斥是为了避免「哪把 key 生效」有歧义。
            </>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}
      {authMode !== null && authMode.mode === 'permissive' ? (
        <Banner
          type="info"
          title="当前未启用数据面鉴权"
          description="既没有配 AG_ACCESS_TOKEN，也没有建任何虚拟 key，所有请求都放行（key_id=local-dev）。建一把 key 就会自动切到虚拟 key 模式。"
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <Button theme="solid" type="primary" icon={<IconPlus />} onClick={() => setCreating(true)}>
          新建密钥
        </Button>
        <div style={{ flex: 1 }} />
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          列表只显示掩码；完整密钥只在新建时出现一次。
        </Typography.Text>
      </div>

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      <Table
        columns={columns}
        dataSource={items}
        rowKey="key_id"
        loading={loading}
        pagination={false}
        empty="还没有建任何客户端密钥。"
      />

      {/* ---- 新建 ---- */}
      <Modal
        visible={creating}
        title="新建客户端密钥"
        onCancel={() => setCreating(false)}
        onOk={() => void create()}
        okText="创建"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <Typography.Text strong>名称</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.name}
              onChange={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="如：claude-code / 批量脚本"
            />
          </div>
          <div>
            <Typography.Text strong>模型限制（逗号分隔，留空 = 全部）</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.models}
              onChange={(v) => setForm((f) => ({ ...f, models: v }))}
              placeholder="deepseek-chat, deepseek-*"
            />
          </div>
          <div>
            <Typography.Text strong>provider 限制（逗号分隔，留空 = 全部）</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.providers}
              onChange={(v) => setForm((f) => ({ ...f, providers: v }))}
              placeholder="deepseek"
            />
          </div>
          <div>
            <Typography.Text strong>过期时间（可留空）</Typography.Text>
            <Input
              type="date"
              style={{ marginTop: 6 }}
              value={form.expiresAtLocal}
              onChange={(v) => setForm((f) => ({ ...f, expiresAtLocal: v }))}
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
          <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
            创建成功后完整密钥只显示一次，服务端不保存、也无法再次查看。
          </Typography.Text>
        </div>
      </Modal>

      {/* ---- 仅此一次的明文 ---- */}
      <Modal
        visible={issued !== null}
        title="密钥已创建 —— 完整密钥只显示这一次"
        onCancel={() => setIssued(null)}
        onOk={() => setIssued(null)}
        okText="我已保存"
      >
        {issued === null ? null : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Banner
              type="warning"
              description="关闭这个对话框后，完整密钥再也无法从管理面取回。请现在就复制到你的客户端配置里。"
            />
            <div>
              <Typography.Text strong>完整密钥</Typography.Text>
              <Input
                style={{ marginTop: 6, fontFamily: 'monospace' }}
                readOnly
                value={issued.plaintext}
              />
            </div>
            <div>
              <Typography.Text strong>名称</Typography.Text>
              <div style={{ marginTop: 6 }}>{issued.key.name}</div>
            </div>
            <div>
              <Typography.Text strong>掩码</Typography.Text>
              <div style={{ marginTop: 6, fontFamily: 'monospace' }}>{issued.key.masked}</div>
            </div>
            <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
              客户端三种带法任选：Authorization: Bearer &lt;key&gt;、x-api-key: &lt;key&gt;、
              ?key=&lt;key&gt;。
            </Typography.Text>
          </div>
        )}
      </Modal>

      {/* ---- 用量 ---- */}
      <Modal
        visible={usageFor !== null}
        title={usageFor === null ? '' : `「${usageFor.key_id}」的用量`}
        onCancel={() => setUsageFor(null)}
        onOk={() => setUsageFor(null)}
        okText="关闭"
      >
        {usageFor === null ? null : (
          <Table
            columns={[
              { title: '项', dataIndex: 'label', width: 160 },
              { title: '值', dataIndex: 'value' },
            ]}
            dataSource={[
              {
                key: 'range',
                label: '区间',
                value: `${fmtTs(usageFor.from_ts)} ~ ${fmtTs(usageFor.to_ts)}`,
              },
              { key: 'req', label: '请求数', value: fmtInt(usageFor.request_count) },
              { key: 'err', label: '失败数', value: fmtInt(usageFor.error_count) },
              { key: 'in', label: '输入 token', value: fmtInt(usageFor.input_tokens) },
              { key: 'out', label: '输出 token', value: fmtInt(usageFor.output_tokens) },
              {
                key: 'model',
                label: '按模型',
                value:
                  usageFor.by_model.map((m) => `${m.model} × ${m.request_count}`).join('；') || '—',
              },
              {
                key: 'provider',
                label: '按 provider',
                value:
                  usageFor.by_provider
                    .map((p) => `${p.provider} × ${p.request_count}`)
                    .join('；') || '—',
              },
            ]}
            rowKey="key"
            pagination={false}
          />
        )}
      </Modal>
    </div>
  );
}
