/**
 * src/pages/Aliases.tsx —— 别名 / namespace 映射页。
 *
 * 表格 + 弹窗（别名 → provider / access_path / model）。页面只用**一句话**说明三级
 * 优先级（显式别名 > 前缀规则 > 原样 id），细节进 Tooltip，不占版面。
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
  Tooltip,
  Typography,
} from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtInt } from '../format';
import type { AliasRuleDto } from '../api/types';

const PRIORITY_LINE =
  '解析优先级（高 → 低）：显式别名 exact ＞ 前缀规则 prefix ＞ 原样 model id（passthrough）';
const PRIORITY_DETAIL =
  'exact 全串相等，意图最强，永远最先命中。prefix 按 priority 升序、再按模式长度降序取第一个命中' +
  '（最具体者优先）；支持 namespace/ 与 foo* 两种形态（* 不匹配 /）。passthrough 直接传上游 model id，' +
  '但仅当该 model 在能力矩阵里才放行，否则报 no_available_provider。exact 高于 prefix 是为了防止一条宽前缀' +
  '规则静默劫持所有显式别名。';

export function Aliases(): JSX.Element {
  const { call } = useAuth();
  const [items, setItems] = useState<AliasRuleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ visible: boolean; editing: AliasRuleDto | null }>({
    visible: false,
    editing: null,
  });
  const [form, setForm] = useState({
    kind: 'exact' as 'exact' | 'prefix',
    pattern: '',
    provider: '',
    accessPath: '',
    model: '',
    maxCtx: '',
    priority: '100',
    enabled: true,
    note: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await call<{ items: AliasRuleDto[] }>('/aliases');
      setItems(res.items ?? []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = (): void => {
    setForm({
      kind: 'exact',
      pattern: '',
      provider: '',
      accessPath: '',
      model: '',
      maxCtx: '',
      priority: '100',
      enabled: true,
      note: '',
    });
    setModal({ visible: true, editing: null });
  };

  const openEdit = (r: AliasRuleDto): void => {
    setForm({
      kind: r.kind,
      pattern: r.pattern,
      provider: r.target.provider,
      accessPath: r.target.access_path,
      model: r.target.model,
      maxCtx: r.target.max_context_tokens ? String(r.target.max_context_tokens) : '',
      priority: String(r.priority),
      enabled: r.enabled,
      note: r.note ?? '',
    });
    setModal({ visible: true, editing: r });
  };

  const save = async (): Promise<void> => {
    const target: {
      provider: string;
      access_path: string;
      model: string;
      max_context_tokens?: number;
    } = {
      provider: form.provider.trim(),
      access_path: form.accessPath.trim(),
      model: form.model.trim(),
    };
    if (
      form.pattern.trim().length === 0 ||
      target.provider.length === 0 ||
      target.access_path.length === 0 ||
      target.model.length === 0
    ) {
      Toast.error('pattern 与目标（provider / access_path / model）都不能为空');
      return;
    }
    const maxCtx = form.maxCtx.trim();
    if (maxCtx.length > 0) target.max_context_tokens = Number(maxCtx);
    try {
      const body = {
        ...(modal.editing !== null ? { id: modal.editing.id } : {}),
        kind: form.kind,
        pattern: form.pattern.trim(),
        target,
        priority: Number(form.priority) || 100,
        enabled: form.enabled,
        ...(form.note.trim().length > 0 ? { note: form.note.trim() } : {}),
      };
      await call('/aliases', { method: 'POST', body });
      Toast.success('已保存');
      setModal((m) => ({ ...m, visible: false }));
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const remove = async (r: AliasRuleDto): Promise<void> => {
    try {
      await call(`/aliases/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      Toast.success('已删除');
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const columns = [
    {
      title: '类型',
      dataIndex: 'kind',
      render: (_: unknown, r: AliasRuleDto) => (
        <Tag color={r.kind === 'exact' ? 'blue' : 'cyan'}>{r.kind}</Tag>
      ),
    },
    {
      title: 'pattern',
      dataIndex: 'pattern',
      render: (_: unknown, r: AliasRuleDto) => (
        <span style={{ fontFamily: 'monospace' }}>{r.pattern}</span>
      ),
    },
    {
      title: 'priority',
      dataIndex: 'priority',
      render: (_: unknown, r: AliasRuleDto) => fmtInt(r.priority),
    },
    {
      title: '目标',
      dataIndex: 'target',
      render: (_: unknown, r: AliasRuleDto) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {r.target.provider} / {r.target.access_path} / {r.target.model}
          {r.target.max_context_tokens ? ` · ≤${fmtInt(r.target.max_context_tokens)}` : ''}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      render: (_: unknown, r: AliasRuleDto) => (
        <Tag color={r.enabled ? 'green' : 'grey'}>{r.enabled ? '启用' : '停用'}</Tag>
      ),
    },
    { title: '备注', dataIndex: 'note', render: (_: unknown, r: AliasRuleDto) => r.note ?? '—' },
    {
      title: '操作',
      dataIndex: 'operate',
      render: (_: unknown, r: AliasRuleDto) => (
        <Space>
          <Button theme="borderless" type="primary" size="small" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm
            title={`确定删除规则「${r.kind}:${r.pattern}」？不可撤销。`}
            onConfirm={() => void remove(r)}
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
      <div style={{ marginBottom: 12 }}>
        <Tooltip content={PRIORITY_DETAIL}>
          <Typography.Text type="tertiary" style={{ cursor: 'help' }}>
            {PRIORITY_LINE}（悬停看详情）
          </Typography.Text>
        </Tooltip>
      </div>
      <div style={{ display: 'flex', marginBottom: 16 }}>
        <Button theme="solid" type="primary" icon={<IconPlus />} onClick={openCreate}>
          新建规则
        </Button>
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
        empty="还没有别名规则。"
      />

      <Modal
        visible={modal.visible}
        title={modal.editing !== null ? '编辑规则' : '新建规则'}
        onCancel={() => setModal((m) => ({ ...m, visible: false }))}
        onOk={() => void save()}
        okText="保存"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <Typography.Text strong>类型</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                value={form.kind}
                onChange={(v) => setForm((f) => ({ ...f, kind: v as 'exact' | 'prefix' }))}
                optionList={[
                  { value: 'exact', label: 'exact（显式别名）' },
                  { value: 'prefix', label: 'prefix（前缀规则）' },
                ]}
              />
            </div>
            <div style={{ flex: 2 }}>
              <Typography.Text strong>pattern</Typography.Text>
              <Input
                style={{ marginTop: 6 }}
                value={form.pattern}
                onChange={(v) => setForm((f) => ({ ...f, pattern: v }))}
                placeholder={form.kind === 'prefix' ? 'fast/ 或 fast*' : '完整模型名'}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div>
              <Typography.Text strong>provider</Typography.Text>
              <Input
                style={{ marginTop: 6 }}
                value={form.provider}
                onChange={(v) => setForm((f) => ({ ...f, provider: v }))}
              />
            </div>
            <div>
              <Typography.Text strong>access_path</Typography.Text>
              <Input
                style={{ marginTop: 6 }}
                value={form.accessPath}
                onChange={(v) => setForm((f) => ({ ...f, accessPath: v }))}
              />
            </div>
            <div>
              <Typography.Text strong>model</Typography.Text>
              <Input
                style={{ marginTop: 6 }}
                value={form.model}
                onChange={(v) => setForm((f) => ({ ...f, model: v }))}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div>
              <Typography.Text strong>priority</Typography.Text>
              <Input
                type="number"
                style={{ marginTop: 6 }}
                value={form.priority}
                onChange={(v) => setForm((f) => ({ ...f, priority: v }))}
              />
            </div>
            <div>
              <Typography.Text strong>max_context_tokens</Typography.Text>
              <Input
                type="number"
                style={{ marginTop: 6 }}
                value={form.maxCtx}
                onChange={(v) => setForm((f) => ({ ...f, maxCtx: v }))}
                placeholder="可选"
              />
            </div>
          </div>
          <div>
            <Typography.Text strong>备注</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.note}
              onChange={(v) => setForm((f) => ({ ...f, note: v }))}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
