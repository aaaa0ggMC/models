/**
 * src/pages/Channels.tsx —— 渠道页（Provider 管理，主场，对标 NewAPI 渠道列表）。
 *
 * 顶部操作栏（新建渠道 + 搜索）+ 主体表格（名称 / Provider / 状态 / 模型数 / 操作）。
 * 不放说明段落。Provider 列按 base_url 反查预设显示友好名，查不到回退 dialect。
 * 「测试」= 找到该渠道名下的凭据，按其 access_path 打一次上游探测。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Input,
  Popconfirm,
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
import { modelSourceSummary } from '../format';
import { helpHref } from '../router';
import { ChannelFormModal } from '../components/ChannelFormModal';
import type { MaskedCredential, ProviderConfig, ProviderPreset } from '../api/types';

export function Channels(): JSX.Element {
  const { call } = useAuth();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [modal, setModal] = useState<{
    visible: boolean;
    mode: 'create' | 'edit';
    editing: ProviderConfig | null;
  }>({
    visible: false,
    mode: 'create',
    editing: null,
  });

  const presetByBase = useMemo(() => {
    const map = new Map<string, ProviderPreset>();
    for (const p of presets) {
      for (const ap of p.access_paths) map.set(ap.base_url, p);
    }
    return map;
  }, [presets]);

  const providerName = (p: ProviderConfig): string => {
    // 精确匹配优先，再前缀匹配（自定义 base 带了子路径时）。
    const exact = presetByBase.get(p.base_url);
    if (exact) return exact.name;
    const prefixed = [...presetByBase.entries()].find(([base]) =>
      p.base_url.startsWith(`${base}/`),
    );
    return prefixed?.[1].name ?? p.dialect;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [prov, cred] = await Promise.all([
        call<{ items: ProviderConfig[] }>('/providers'),
        call<{ items: MaskedCredential[] }>('/credentials'),
      ]);
      setProviders(prov.items ?? []);
      setCredentials(cred.items ?? []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  const loadPresets = useCallback(async () => {
    try {
      const res = await call<{ items: ProviderPreset[] }>('/provider-presets');
      setPresets(res.items ?? []);
    } catch {
      // 预设端点不可用（旧网关 / 501）：退化成只有「自定义 Provider」，与旧版一致。
      setPresets([]);
    }
  }, [call]);

  useEffect(() => {
    void load();
    void loadPresets();
  }, [load, loadPresets]);

  const remove = async (p: ProviderConfig): Promise<void> => {
    try {
      await call(`/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      Toast.success(`已删除 ${p.label}`);
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    }
  };

  const test = async (p: ProviderConfig): Promise<void> => {
    const cred = credentials.find((c) => c.provider === p.id);
    if (cred === undefined) {
      Toast.warning('该渠道还没有凭据，无法测试（请先在「凭据」页录入 key）');
      return;
    }
    const toastId = Toast.info('正在测试连通性…');
    try {
      const res = await call<{
        ok: boolean;
        status: string;
        upstream_status?: number;
        message?: string;
      }>(`/credentials/${encodeURIComponent(cred.access_path)}/probe`, {
        method: 'POST',
        body: {},
      });
      Toast.close(toastId);
      const bits = [res.status === 'ok' ? '连通' : `失败（${res.status}）`];
      if (res.upstream_status !== undefined) bits.push(`上游 HTTP ${res.upstream_status}`);
      if (res.message) bits.push(res.message);
      if (res.status === 'ok') Toast.success(bits.join(' · '));
      else Toast.error(bits.join(' · '));
      await load();
    } catch (e) {
      Toast.close(toastId);
      Toast.error(errorText(e));
    }
  };

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (k.length === 0) return providers;
    return providers.filter((p) =>
      [p.label, p.id, p.dialect, p.base_url, providerName(p)]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(k)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, keyword, presetByBase]);

  const columns = [
    {
      title: '名称',
      dataIndex: 'label',
      render: (_: unknown, p: ProviderConfig) => (
        <div>
          <div>{p.label}</div>
          <span style={{ fontSize: 12, opacity: 0.65 }}>{p.id}</span>
        </div>
      ),
    },
    {
      title: (
        <Tooltip content="按 base_url 反查 Provider 预设显示友好名，查不到回退 dialect（自定义 base 带子路径时按前缀匹配）。">
          <span>Provider</span>
        </Tooltip>
      ),
      dataIndex: 'dialect',
      render: (_: unknown, p: ProviderConfig) => providerName(p),
    },
    {
      title: (
        <Tooltip content="停用后该渠道不参与路由；已建立的凭据仍然保留。">
          <span>状态</span>
        </Tooltip>
      ),
      dataIndex: 'enabled',
      render: (_: unknown, p: ProviderConfig) => (
        <Tag color={p.enabled ? 'green' : 'grey'}>{p.enabled ? '启用' : '停用'}</Tag>
      ),
    },
    {
      title: (
        <Tooltip content="该渠道的模型清单来源：静态清单 / 上游发现 / 离线目录（三层来源见帮助页）。">
          <span>模型数</span>
        </Tooltip>
      ),
      dataIndex: 'model_source',
      render: (_: unknown, p: ProviderConfig) => modelSourceSummary(p.model_source),
    },
    {
      title: '操作',
      dataIndex: 'operate',
      render: (_: unknown, p: ProviderConfig) => (
        <Space>
          <Button
            theme="borderless"
            type="primary"
            size="small"
            onClick={() => setModal({ visible: true, mode: 'edit', editing: p })}
          >
            编辑
          </Button>
          <Button theme="borderless" size="small" onClick={() => void test(p)}>
            测试
          </Button>
          <Popconfirm
            title={`确定删除渠道「${p.label}」？此操作不可撤销。`}
            onConfirm={() => void remove(p)}
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
        <Button
          theme="solid"
          type="primary"
          icon={<IconPlus />}
          onClick={() => setModal({ visible: true, mode: 'create', editing: null })}
        >
          新建渠道
        </Button>
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          渠道决定请求打到哪个上游，保存后即生效。
        </Typography.Text>
        <a href={helpHref('catalog')}>了解更多</a>
        <div style={{ flex: 1 }} />
        <Input
          placeholder="搜索名称 / provider / base_url"
          value={keyword}
          onChange={setKeyword}
          style={{ width: 280 }}
          showClear
        />
      </div>

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      <Table
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={false}
        empty="还没有配置任何渠道。点左上角「新建渠道」开始。"
      />

      <ChannelFormModal
        visible={modal.visible}
        mode={modal.mode}
        editing={modal.editing}
        presets={presets}
        onCancel={() => setModal((m) => ({ ...m, visible: false }))}
        onSaved={() => {
          setModal((m) => ({ ...m, visible: false }));
          void load();
        }}
      />
    </div>
  );
}
