/**
 * src/pages/ModelCatalog.tsx —— 模型目录页（能力矩阵只读视图）。
 *
 * 数据与 ir/capability.ts 同源（GET /admin/api/capabilities）。支持按模态/关键词过滤，
 * 点行看详情（Drawer）。顶部可触发一次同步（上游发现 / 离线目录刷新）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, SideSheet, Table, Tag, Toast } from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtInt } from '../format';
import type { CapabilityMatrixEntry } from '../api/types';

export function ModelCatalog(): JSX.Element {
  const { call } = useAuth();
  const [items, setItems] = useState<CapabilityMatrixEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [modality, setModality] = useState<string>('');
  const [detail, setDetail] = useState<CapabilityMatrixEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await call<{ items: CapabilityMatrixEntry[] }>('/capabilities');
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

  const modalities = useMemo(() => [...new Set(items.map((e) => e.modality))].sort(), [items]);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return items.filter((e) => {
      if (modality !== '' && e.modality !== modality) return false;
      if (k.length === 0) return true;
      return [e.access_path, e.model, e.modality, e.format, e.usage_source]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(k));
    });
  }, [items, keyword, modality]);

  const sync = async (): Promise<void> => {
    const toastId = Toast.info('正在触发同步…');
    try {
      const res = await call<{
        ok: boolean;
        result?: { discovered: string[]; updated: string[]; added: string[] };
        error?: string;
      }>('/sync', { method: 'POST', body: { kind: 'upstream_discovery' } });
      Toast.close(toastId);
      if (res.ok && res.result) {
        const r = res.result;
        Toast.success(
          `同步完成：新发现 ${r.discovered.length} · 更新 ${r.updated.length} · 新增 ${r.added.length}`,
        );
      } else {
        Toast.error(res.error ?? '同步未完成');
      }
      await load();
    } catch (e) {
      Toast.close(toastId);
      Toast.error(errorText(e));
    }
  };

  const columns = [
    {
      title: '模型',
      dataIndex: 'model',
      render: (_: unknown, e: CapabilityMatrixEntry) => (
        <span style={{ fontFamily: 'monospace' }}>{e.model}</span>
      ),
    },
    {
      title: 'provider',
      dataIndex: 'access_path',
      render: (_: unknown, e: CapabilityMatrixEntry) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.access_path}</span>
      ),
    },
    {
      title: '上下文',
      dataIndex: 'context_window',
      render: (_: unknown, e: CapabilityMatrixEntry) => fmtInt(e.context_window),
    },
    {
      title: '最大输出',
      dataIndex: 'max_output_tokens',
      render: (_: unknown, e: CapabilityMatrixEntry) => fmtInt(e.max_output_tokens),
    },
    { title: '模态', dataIndex: 'modality' },
    {
      title: '约束',
      dataIndex: 'constraints',
      render: (_: unknown, e: CapabilityMatrixEntry) => {
        const bits: string[] = [];
        if (e.constraints?.system_prompt_update)
          bits.push(`sys:${e.constraints.system_prompt_update}`);
        if (e.constraints?.tool_update) bits.push(`tool:${e.constraints.tool_update}`);
        return bits.length === 0
          ? '—'
          : bits.map((b) => (
              <Tag key={b} size="small" color="orange">
                {b}
              </Tag>
            ));
      },
    },
    {
      title: '合约测试',
      dataIndex: 'contract_tested',
      render: (_: unknown, e: CapabilityMatrixEntry) => (
        <Tag color={e.contract_tested ? 'green' : 'grey'}>
          {e.contract_tested ? '已覆盖' : '未覆盖'}
        </Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (_: unknown, e: CapabilityMatrixEntry) => (
        <Tag
          color={e.status === 'implemented' ? 'green' : e.status === 'planned' ? 'orange' : 'grey'}
        >
          {e.status}
        </Tag>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <Button icon={<IconRefresh />} onClick={() => void sync()}>
          同步上游
        </Button>
        <div style={{ flex: 1 }} />
        <Select
          placeholder="按模态过滤"
          style={{ width: 160 }}
          value={modality}
          onChange={(v) => setModality(String(v))}
          showClear
          optionList={modalities.map((m) => ({ value: m, label: m }))}
        />
        <Input
          placeholder="搜索模型 / access_path"
          style={{ width: 240 }}
          value={keyword}
          onChange={setKeyword}
          showClear
        />
      </div>

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      <Table
        columns={columns}
        dataSource={filtered}
        rowKey={(e) => (e ? `${e.access_path}::${e.model}` : `row-${Math.random()}`)}
        loading={loading}
        pagination={false}
        onRow={(record) => ({
          onClick: () => {
            if (record !== undefined) setDetail(record as CapabilityMatrixEntry);
          },
          style: { cursor: 'pointer' },
        })}
        empty="能力矩阵为空，或没有匹配当前过滤条件的条目。"
      />

      <SideSheet
        title={detail ? detail.model : ''}
        visible={detail !== null}
        onCancel={() => setDetail(null)}
        width={480}
      >
        {detail ? (
          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              rowGap: 10,
              columnGap: 12,
              fontSize: 14,
            }}
          >
            <Kv k="模型" v={<span style={{ fontFamily: 'monospace' }}>{detail.model}</span>} />
            <Kv
              k="access_path"
              v={<span style={{ fontFamily: 'monospace' }}>{detail.access_path}</span>}
            />
            <Kv k="模态" v={detail.modality} />
            <Kv k="format" v={detail.format ?? '—'} />
            <Kv k="上下文窗口" v={fmtInt(detail.context_window)} />
            <Kv k="最大输出" v={fmtInt(detail.max_output_tokens)} />
            <Kv
              k="流式"
              v={
                detail.streaming
                  ? `${detail.streaming.mode}${detail.streaming.framing ? ` · ${detail.streaming.framing}` : ''}`
                  : '—'
              }
            />
            <Kv k="usage 来源" v={detail.usage_source} />
            <Kv k="输入模态" v={(detail.input_modalities ?? []).join(', ') || '—'} />
            <Kv k="输出模态" v={(detail.output_modalities ?? []).join(', ') || '—'} />
            <Kv k="不支持的字段" v={(detail.unsupported_fields ?? []).join(', ') || '—'} />
            <Kv k="怪癖" v={(detail.quirks ?? []).join(', ') || '—'} />
            <Kv
              k="effort"
              v={
                detail.effort
                  ? `${(detail.effort.supported_levels ?? []).join(', ')}${detail.effort.default_level ? `（默认 ${detail.effort.default_level}）` : ''}`
                  : '—'
              }
            />
            <Kv k="约束" v={constraintText(detail)} />
            <Kv k="合约测试" v={detail.contract_tested ? '已覆盖' : '未覆盖'} />
            <Kv k="状态" v={detail.status} />
          </dl>
        ) : null}
      </SideSheet>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <>
      <dt style={{ opacity: 0.65 }}>{k}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }}>{v}</dd>
    </>
  );
}

function constraintText(e: CapabilityMatrixEntry): string {
  const bits: string[] = [];
  if (e.constraints?.system_prompt_update)
    bits.push(`system_prompt_update=${e.constraints.system_prompt_update}`);
  if (e.constraints?.tool_update) bits.push(`tool_update=${e.constraints.tool_update}`);
  return bits.length === 0 ? '—' : bits.join(' · ');
}
