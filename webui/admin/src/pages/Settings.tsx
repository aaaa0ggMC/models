/**
 * src/pages/Settings.tsx —— 系统设置第一屏（P0-2）。
 *
 * 只放 8 个最常改的项（后端 `RUNTIME_SETTINGS` 白名单）。每一项都标**当前来源**：
 *
 * | 来源 | 含义 | 能不能改 |
 * |---|---|---|
 * | `加密存储` | 你在界面里改的值，最高优先级 | ✅ |
 * | `env` | 部署环境变量，重启才变 | ❌（env 锁） |
 * | `配置文件` | `config/*.json` 里的非敏感默认值 | ✅（改了会造一个更高层的覆盖） |
 * | `默认值` | 编译期内置兜底 | ✅ |
 *
 * **env 锁**：被 env 覆盖的项照样显示当前值，但输入框禁用，并给出原因——
 * 环境变量是部署事实，界面写入会造出一个静默遮盖它的覆盖层，使同一份部署配置
 * 在不同机器上行为不同。服务端同样拒绝（409 `env_locked`），不是只在前端禁用。
 *
 * 改完**不用重启**：值直接写进 pipeline 读的那个 config 对象；重启后仍在
 * （落在加密存储里，启动时应用回来）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Input,
  Select,
  Table,
  Tag,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconRefresh } from '@douyinfe/semi-icons';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import { fmtTs } from '../format';
import type { SettingDto, SettingSource } from '../api/types';

const SOURCE_META: Record<
  SettingSource,
  { label: string; color: 'blue' | 'green' | 'grey' | 'orange' }
> = {
  encrypted_storage: { label: '加密存储', color: 'blue' },
  env: { label: '环境变量', color: 'orange' },
  config_file: { label: '配置文件', color: 'green' },
  default: { label: '默认值', color: 'grey' },
};

function SourceTag({ source }: { source: SettingSource }): JSX.Element {
  const meta = SOURCE_META[source] ?? SOURCE_META.default!;
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export function Settings(): JSX.Element {
  const { call } = useAuth();
  const [items, setItems] = useState<SettingDto[]>([]);
  const [configFilePath, setConfigFilePath] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑的 key → 草稿值。 */
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
    const raw = drafts[s.key];
    if (raw === undefined) return;
    const value = s.type === 'int' ? Number(raw) : raw;
    setSaving(s.key);
    try {
      await call(`/settings/${encodeURIComponent(s.key)}`, {
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
          <div style={{ fontWeight: 600 }}>{s.label}</div>
          <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
            {s.key}
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
              value={drafts[s.key] ?? String(s.value)}
              optionList={(s.options ?? []).map((o) => ({ value: o, label: o }))}
              onChange={(v) => setDrafts((d) => ({ ...d, [s.key]: String(v) }))}
            />
          );
        }
        return (
          <Input
            style={{ width: 150, fontFamily: 'monospace' }}
            value={drafts[s.key] ?? String(s.value)}
            onChange={(v) => setDrafts((d) => ({ ...d, [s.key]: v }))}
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
      width: 120,
      render: (_: unknown, s: SettingDto) => <SourceTag source={s.source} />,
    },
    {
      title: '说明 / 限制',
      dataIndex: 'description',
      render: (_: unknown, s: SettingDto) => (
        <div>
          <Typography.Text style={{ fontSize: 13 }}>{s.description}</Typography.Text>
          {s.reason ? (
            <Typography.Text
              type="warning"
              style={{ display: 'block', fontSize: 12, marginTop: 4 }}
            >
              🔒 {s.reason}
            </Typography.Text>
          ) : null}
          {s.env_var ? (
            <Typography.Text
              type="tertiary"
              style={{ display: 'block', fontSize: 12, marginTop: 2 }}
            >
              环境变量：<span style={{ fontFamily: 'monospace' }}>{s.env_var}</span>
            </Typography.Text>
          ) : null}
          {s.updated_at ? (
            <Typography.Text
              type="tertiary"
              style={{ display: 'block', fontSize: 12, marginTop: 2 }}
            >
              上次修改：{fmtTs(s.updated_at)}（{s.updated_by}）
            </Typography.Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '操作',
      dataIndex: 'operate',
      width: 110,
      render: (_: unknown, s: SettingDto) => {
        const dirty = drafts[s.key] !== undefined && drafts[s.key] !== String(s.value);
        return (
          <Button
            theme="solid"
            type="primary"
            size="small"
            disabled={!s.editable || !dirty}
            loading={saving === s.key}
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
    <div style={{ maxWidth: 1080 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <Typography.Text type="tertiary" style={{ fontSize: 12 }}>
          改完即时生效，不用重启；重启后仍在（落在加密存储里）。
        </Typography.Text>
        <div style={{ flex: 1 }} />
        <Button icon={<IconRefresh />} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {error ? (
        <div style={{ color: 'var(--semi-color-danger)', marginBottom: 12 }}>{error}</div>
      ) : null}

      {locked.length > 0 ? (
        <Banner
          type="warning"
          title={`${locked.length} 项被环境变量锁定`}
          description={
            <>
              这些项由部署环境变量提供，界面里只能看、不能改。原因是：环境变量是部署事实，
              界面写入会造出一个静默遮盖它的覆盖层，使同一份部署配置在不同机器上行为不同。
              请改环境变量并重启；要改用界面，先取消对应的 AG_* 变量。
            </>
          }
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Card style={{ marginBottom: 16 }}>
        <Table
          columns={columns}
          dataSource={items}
          rowKey="key"
          loading={loading}
          pagination={false}
          empty="读不到设置项。"
        />
      </Card>

      <Card title="这 8 项为什么是这 8 项">
        <Typography.Text type="tertiary" style={{ fontSize: 13 }}>
          白名单制，不是「所有配置都能热改」。可运行时改的项必须满足两个条件：
          改错了不会让网关起不来（所以端口 / host / 密钥路径不在内），以及
          有明确的取值范围（所以每一项都有 min–max 或枚举）。其余配置仍走环境变量
          与配置文件——那两层是要入 git / 入部署清单的，本来就不该被界面随便改。
        </Typography.Text>
        {configFilePath ? (
          <Typography.Text type="tertiary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
            配置文件（第三层）：<span style={{ fontFamily: 'monospace' }}>{configFilePath}</span>
          </Typography.Text>
        ) : null}
        <Typography.Text type="tertiary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
          优先级（高 → 低）：加密存储 {'>'} 环境变量 {'>'} 配置文件 {'>'} 内置默认值。
          敏感值不在这张表里——它们只以{' '}
          <span style={{ fontFamily: 'monospace' }}>env:&lt;VAR&gt;</span>{' '}
          引用的形态登记，值永远留在进程环境里。
        </Typography.Text>
      </Card>
    </div>
  );
}
