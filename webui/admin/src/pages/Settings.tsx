/**
 * src/pages/Settings.tsx —— 系统设置第一屏（P0-2）。
 *
 * **只放表格与控件**：每一项的说明、白名单理由、四层优先级、env 锁的理由都在
 * 「帮助 / 文档」页（`#/help`，见 pages/Help.tsx），页面顶部一句「改完即生效」
 * + 「了解更多」入口。设计文档摘录的来源标注也在帮助页。
 *
 * 每一项都标**当前来源**（加密存储 / 环境变量 / 配置文件 / 默认值），被 env 覆盖的项
 * 显示当前值但输入框禁用，并给出原因（服务端同样回 409 `env_locked`）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Input,
  Select,
  Table,
  Toast,
  Tooltip,
  Typography,
} from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtTs } from '../format';
import { helpHref } from '../router';
import { PageHeader, StatusTag } from '../components/ui';
import type { SettingDto, SettingSource } from '../api/types';

const SOURCE_META: Record<
  SettingSource,
  { label: string; tone: 'info' | 'warning' | 'success' | 'neutral' }
> = {
  encrypted_storage: { label: '加密存储', tone: 'info' },
  env: { label: '环境变量', tone: 'warning' },
  config_file: { label: '配置文件', tone: 'success' },
  default: { label: '默认值', tone: 'neutral' },
};

/** 来源标签。颜色 + 文字双编码，不靠颜色单独区分（色盲安全）。 */
function SourceTag({ source }: { source: SettingSource }): JSX.Element {
  const meta = SOURCE_META[source] ?? SOURCE_META.default!;
  return <StatusTag tone={meta.tone}>{meta.label}</StatusTag>;
}

export function Settings(): JSX.Element {
  const { call } = useAuth();
  const [items, setItems] = useState<SettingDto[]>([]);
  const [configFilePath, setConfigFilePath] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑的 id → 草稿值。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await call<{ items: SettingDto[]; config_file_path?: string }>('/settings');
      setItems(res.items ?? []);
      setConfigFilePath(res.config_file_path);
      setDrafts({});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (s: SettingDto): Promise<void> => {
    const raw = drafts[s.id];
    if (raw === undefined) return;
    const value = s.type === 'int' ? Number(raw) : raw;
    setSaving(s.id);
    try {
      await call(`/settings/${encodeURIComponent(s.id)}`, {
        method: 'PUT',
        body: { value },
      });
      Toast.success(`「${s.label}」已生效（不用重启）`);
      await load();
    } catch (e) {
      Toast.error(errorText(e));
    } finally {
      setSaving(null);
    }
  };

  const columns = [
    {
      title: '项',
      dataIndex: 'label',
      width: 150,
      render: (_: unknown, s: SettingDto) => (
        <div>
          <div style={{ fontWeight: 600 }}>
            {/* 说明进行内 Tooltip：不占版面，鼠标停一下就能看到。 */}
            <Tooltip content={s.description} position="topLeft">
              <span style={{ cursor: 'help' }}>
                {s.label}
                <Typography.Text type="tertiary" style={{ marginLeft: 4, fontSize: 12 }}>
                  ⓘ
                </Typography.Text>
              </span>
            </Tooltip>
          </div>
          <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
            {s.id}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: '当前值',
      dataIndex: 'value',
      width: 190,
      render: (_: unknown, s: SettingDto) => {
        if (!s.editable) {
          return (
            <span style={{ fontFamily: 'monospace' }}>
              {String(s.value)}
              {s.unit}
            </span>
          );
        }
        if (s.type === 'enum') {
          return (
            <Select
              style={{ width: 150 }}
              value={drafts[s.id] ?? String(s.value)}
              optionList={(s.options ?? []).map((o) => ({ value: o, label: o }))}
              onChange={(v) => setDrafts((d) => ({ ...d, [s.id]: String(v) }))}
            />
          );
        }
        return (
          <Input
            style={{ width: 150, fontFamily: 'monospace' }}
            value={drafts[s.id] ?? String(s.value)}
            onChange={(v) => setDrafts((d) => ({ ...d, [s.id]: v }))}
            placeholder={s.range ? `${s.range.min} – ${s.range.max}` : ''}
          />
        );
      },
    },
    {
      title: '单位',
      dataIndex: 'unit',
      width: 70,
      render: (_: unknown, s: SettingDto) => s.unit || '—',
    },
    {
      title: '当前来源',
      dataIndex: 'source',
      width: 130,
      render: (_: unknown, s: SettingDto) => (
        <Tooltip
          content={
            <>
              <div>{SOURCE_META[s.source]?.label ?? s.source}</div>
              {s.reason ? <div style={{ marginTop: 4 }}>🔒 {s.reason}</div> : null}
              {s.updated_at ? (
                <div style={{ marginTop: 4 }}>
                  上次修改：{fmtTs(s.updated_at)}（{s.updated_by}）
                </div>
              ) : null}
            </>
          }
        >
          <span>
            {s.editable ? null : <span style={{ marginRight: 4 }}>🔒</span>}
            <SourceTag source={s.source} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '环境变量',
      dataIndex: 'env_var',
      width: 190,
      render: (_: unknown, s: SettingDto) =>
        s.env_var ? (
          <Typography.Text style={{ fontSize: 12, fontFamily: 'monospace' }}>
            {s.env_var}
          </Typography.Text>
        ) : (
          <Typography.Text type="tertiary">—</Typography.Text>
        ),
    },
    {
      title: '操作',
      dataIndex: 'operate',
      width: 110,
      render: (_: unknown, s: SettingDto) => {
        const dirty = drafts[s.id] !== undefined && drafts[s.id] !== String(s.value);
        return (
          <Button
            theme="solid"
            type="primary"
            size="small"
            disabled={!s.editable || !dirty}
            loading={saving === s.id}
            onClick={() => void save(s)}
          >
            保存
          </Button>
        );
      },
    },
  ];

  const locked = items.filter((s) => !s.editable);

  return (
    <div className="ag-stack">
      <PageHeader
        title="系统设置"
        desc="运行时设置第一屏。改完即时生效，不用重启；重启后仍在（落在加密存储里）。被环境变量覆盖的项只能看、不能改。"
        actions={
          <Button icon={<IconRefresh />} onClick={() => void load()}>
            刷新
          </Button>
        }
        meta={
          <div className="ag-row" style={{ fontSize: 12, color: 'var(--ag-text-3)' }}>
            <span>共 {items.length} 项，其中 {locked.length} 项被 env 锁定</span>
            <a href={helpHref('settings')}>四层优先级与白名单理由</a>
          </div>
        }
      />

      {error !== null ? (
        <div className="ag-banner ag-banner-danger" role="alert">
          {error}
        </div>
      ) : null}

      {locked.length > 0 ? (
        <Banner
          type="warning"
          title={`${locked.length} 项被环境变量锁定：只能看、不能改`}
          description={
            <>
              环境变量是部署事实，界面写入会造出一个静默遮盖它的覆盖层。
              <a href={helpHref('settings')} style={{ marginLeft: 8 }}>
                为什么
              </a>
            </>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Card style={{ marginBottom: 16 }}>
        <Table
          columns={columns}
          dataSource={items}
          rowKey="id"
          loading={loading}
          pagination={false}
          empty="读不到设置项。"
        />
      </Card>

      {configFilePath ? (
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          配置文件（第三层）：
          <span style={{ fontFamily: 'monospace', marginLeft: 4 }}>{configFilePath}</span>
        </Typography.Text>
      ) : null}
    </div>
  );
}
