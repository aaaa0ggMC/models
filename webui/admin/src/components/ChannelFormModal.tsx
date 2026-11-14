/**
 * src/components/ChannelFormModal.tsx —— 新建 / 编辑渠道弹窗。
 *
 * 「新建渠道」= 建一个 Provider 配置（POST /providers）+ 录一条凭据（POST /credentials，
 * 只此一次提交完整 key）。对标 NewAPI：ComboBox 选已知 Provider → 自动带出 base_url /
 * dialect / 默认模型 / 文档链接 / key 格式提示，使用者只需再填一个 API Key。
 * 「自定义 Provider」才展开 base_url / dialect / access_path 手填。
 *
 * 编辑模式只改 Provider 配置（label / base_url / dialect / 模型 / 启用 / 备注），
 * **不碰 key**——key 只在「凭据」页与新建时出现，绝不明文回显。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Input,
  Modal,
  Select,
  Switch,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { useAuth } from '../auth';
import { errorText } from '../api/client';
import type {
  Dialect,
  ProviderConfig,
  ProviderPreset,
  ProviderAccessPathPreset,
} from '../api/types';

const DIALECTS: Dialect[] = [
  'openai.chat',
  'anthropic.messages',
  'openai.responses',
  'gemini.generateContent',
];

const CUSTOM = '__custom__';

export interface ChannelFormModalProps {
  visible: boolean;
  mode: 'create' | 'edit';
  editing: ProviderConfig | null;
  presets: ProviderPreset[];
  onCancel: () => void;
  onSaved: () => void;
}

interface FormState {
  presetId: string;
  accessPathId: string;
  label: string;
  baseUrl: string;
  dialect: Dialect;
  models: string;
  apiKey: string; // privacy-scan: ignore —— FormState 字段名（类型声明，无值）
  accessPath: string;
  note: string;
  enabled: boolean;
}

function presetAccessPaths(preset: ProviderPreset | undefined): ProviderAccessPathPreset[] {
  return preset?.access_paths ?? [];
}

function pickAccessPath(
  preset: ProviderPreset | undefined,
  id: string,
): ProviderAccessPathPreset | undefined {
  const paths = presetAccessPaths(preset);
  return paths.find((p) => p.id === id) ?? paths[0];
}

/** 按 base_url 反查预设（编辑模式初始化用）。 */
function matchPreset(baseUrl: string, presets: ProviderPreset[]): ProviderPreset | undefined {
  return presets.find((p) =>
    p.access_paths.some((ap) => baseUrl === ap.base_url || baseUrl.startsWith(`${ap.base_url}/`)),
  );
}

function initialState(
  mode: 'create' | 'edit',
  editing: ProviderConfig | null,
  presets: ProviderPreset[],
): FormState {
  if (mode === 'edit' && editing !== null) {
    const preset = matchPreset(editing.base_url, presets);
    return {
      presetId: preset?.id ?? CUSTOM,
      accessPathId: preset?.default_access_path ?? preset?.access_paths[0]?.id ?? '',
      label: editing.label,
      baseUrl: editing.base_url,
      dialect: editing.dialect,
      models: editing.model_source.kind === 'static' ? editing.model_source.models.join('\n') : '',
      apiKey: '',
      accessPath: preset?.access_paths[0]?.id ?? '',
      note: editing.note ?? '',
      enabled: editing.enabled,
    };
  }
  return {
    presetId: '',
    accessPathId: '',
    label: '',
    baseUrl: '',
    dialect: 'openai.chat',
    models: '',
    apiKey: '',
    accessPath: '',
    note: '',
    enabled: true,
  };
}

export function ChannelFormModal(props: ChannelFormModalProps): JSX.Element {
  const { visible, mode, editing, presets, onCancel, onSaved } = props;
  const { call } = useAuth();
  const [form, setForm] = useState<FormState>(() => initialState(mode, editing, presets));
  const [busy, setBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setForm(initialState(mode, editing, presets));
      setProbeResult(null);
    }
  }, [visible, mode, editing, presets]);

  const patch = (p: Partial<FormState>): void => setForm((f) => ({ ...f, ...p }));

  const currentPreset = useMemo(
    () => presets.find((p) => p.id === form.presetId),
    [presets, form.presetId],
  );

  const presetGroups = useMemo(() => {
    const map = new Map<string, Array<{ value: string; label: React.ReactNode }>>();
    const push = (group: string, value: string, label: React.ReactNode): void => {
      const arr = map.get(group) ?? [];
      arr.push({ value, label });
      map.set(group, arr);
    };
    for (const p of presets) {
      push(
        p.group,
        p.id,
        <span>
          {p.name}
          {p.needs_verification ? (
            <Tag color="orange" size="small" style={{ marginLeft: 6 }}>
              待验证
            </Tag>
          ) : null}
        </span>,
      );
    }
    push('其他', CUSTOM, '自定义 Provider');
    return [...map.entries()];
  }, [presets]);

  const selectPreset = (presetId: string): void => {
    if (presetId === CUSTOM) {
      patch({ presetId: CUSTOM, accessPathId: '' });
      return;
    }
    const preset = presets.find((p) => p.id === presetId);
    if (preset === undefined) return;
    const ap = pickAccessPath(
      preset,
      preset.default_access_path ?? preset.access_paths[0]?.id ?? '',
    );
    patch({
      presetId,
      accessPathId: ap?.id ?? '',
      label: preset.name,
      baseUrl: ap?.base_url ?? '',
      dialect: ap?.dialect ?? 'openai.chat',
      models: (ap?.default_models ?? []).join('\n'),
      accessPath: ap?.id ?? '',
    });
  };

  const selectAccessPath = (accessPathId: string): void => {
    const ap = pickAccessPath(currentPreset, accessPathId);
    if (ap === undefined) return;
    patch({ accessPathId, baseUrl: ap.base_url, dialect: ap.dialect, accessPath: ap.id });
  };

  const readModels = (): string[] =>
    form.models
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const validate = (requireKey: boolean): string | null => {
    if (form.label.trim().length === 0) return '名称不能为空';
    if (form.baseUrl.trim().length === 0) return 'base URL 不能为空';
    const models = readModels();
    if (models.length === 0) return '至少填一个默认模型（每行一个 model id）';
    if (form.accessPath.trim().length === 0) return 'access_path 不能为空';
    if (requireKey && form.apiKey.length === 0) return '请填写 API Key';
    return null;
  };

  /** 建/改 Provider 配置，返回 provider id。 */
  const persistProvider = async (): Promise<string> => {
    const body = {
      ...(mode === 'edit' && editing !== null ? { id: editing.id } : {}),
      label: form.label.trim(),
      dialect: form.dialect,
      base_url: form.baseUrl.trim(),
      model_source: { kind: 'static' as const, models: readModels() },
      enabled: form.enabled,
      ...(form.note.trim().length > 0 ? { note: form.note.trim() } : {}),
    };
    const res = await call<{ ok: boolean; provider?: ProviderConfig }>('/providers', {
      method: 'POST',
      body,
    });
    const id = res.provider?.id ?? (mode === 'edit' ? editing?.id : undefined);
    if (id === undefined) throw new Error('保存 Provider 后没有拿到 id');
    return id;
  };

  /** 录一条凭据（完整 key 只在此提交一次，服务端不回显）。 */
  const persistCredential = async (providerId: string): Promise<void> => {
    await call('/credentials', {
      method: 'POST',
      body: {
        provider: providerId,
        access_path: form.accessPath.trim(),
        secret: form.apiKey, // privacy-scan: ignore —— CredentialCreateRequest 契约字段，右侧是表单输入
        ...(form.note.trim().length > 0 ? { note: form.note.trim() } : {}),
      },
    });
  };

  const probe = async (accessPath: string): Promise<string> => {
    const t0 = Date.now();
    const res = await call<{
      ok: boolean;
      status: string;
      upstream_status?: number;
      message?: string;
    }>(`/credentials/${encodeURIComponent(accessPath)}/probe`, { method: 'POST', body: {} });
    const ms = Date.now() - t0;
    const bits = [res.status === 'ok' ? '连通' : `失败（${res.status}）`, `耗时 ${ms} ms`];
    if (res.upstream_status !== undefined) bits.push(`上游 HTTP ${res.upstream_status}`);
    if (res.message) bits.push(res.message);
    return bits.join(' · ');
  };

  const save = async (thenTest: boolean): Promise<void> => {
    const err = validate(mode === 'create');
    if (err !== null) {
      Toast.error(err);
      return;
    }
    setBusy(true);
    setProbeResult(null);
    try {
      const providerId = await persistProvider();
      if (mode === 'create') {
        await persistCredential(providerId);
      }
      if (thenTest) {
        setProbeResult(await probe(form.accessPath.trim()));
      } else {
        Toast.success(mode === 'create' ? '渠道已创建' : '渠道已更新');
        onSaved();
      }
    } catch (e) {
      Toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const isCustom = form.presetId === CUSTOM;

  return (
    <Modal
      visible={visible}
      title={mode === 'create' ? '新建渠道' : `编辑渠道 · ${editing?.label ?? ''}`}
      onCancel={onCancel}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={onCancel} disabled={busy}>
            取消
          </Button>
          {mode === 'create' ? (
            <Button theme="light" loading={busy} onClick={() => void save(true)}>
              测试连通性
            </Button>
          ) : null}
          <Button theme="solid" type="primary" loading={busy} onClick={() => void save(false)}>
            保存
          </Button>
        </div>
      }
      style={{ width: 560 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <Typography.Text strong>Provider</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 6 }}
            placeholder="搜索并选择一个已知 Provider"
            filter
            value={form.presetId}
            onChange={(v) => selectPreset(String(v))}
          >
            {presetGroups.map(([group, opts]) => (
              <Select.OptGroup key={group} label={group}>
                {opts.map((o) => (
                  <Select.Option key={o.value} value={o.value} label={o.label} />
                ))}
              </Select.OptGroup>
            ))}
          </Select>
          {currentPreset ? (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <Typography.Text type="tertiary">
                文档：
                <Typography.Text link={{ href: currentPreset.docs, target: '_blank' }}>
                  {currentPreset.docs}
                </Typography.Text>
                {currentPreset.needs_verification ? ' · [待验证] 请以官方文档为准' : ''}
              </Typography.Text>
            </div>
          ) : null}
        </div>

        {presetAccessPaths(currentPreset).length > 1 ? (
          <div>
            <Typography.Text strong>接入端点（access path）</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              value={form.accessPathId}
              onChange={(v) => selectAccessPath(String(v))}
              optionList={presetAccessPaths(currentPreset).map((ap) => ({
                value: ap.id,
                label: `${ap.label} · ${ap.dialect}`,
              }))}
            />
          </div>
        ) : null}

        <div>
          <Typography.Text strong>名称</Typography.Text>
          <Input
            style={{ marginTop: 6 }}
            value={form.label}
            onChange={(v) => patch({ label: v })}
            placeholder="如 DeepSeek 正式"
          />
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 2 }}>
            <Typography.Text strong>base URL</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.baseUrl}
              onChange={(v) => patch({ baseUrl: v })}
              placeholder="https://api.example.com"
            />
          </div>
          <div style={{ flex: 1 }}>
            <Typography.Text strong>dialect</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              value={form.dialect}
              onChange={(v) => patch({ dialect: v as Dialect })}
              optionList={DIALECTS.map((d) => ({ value: d, label: d }))}
            />
          </div>
        </div>

        <div>
          <Typography.Text strong>默认模型（每行一个 model id）</Typography.Text>
          <TextArea
            style={{ marginTop: 6 }}
            value={form.models}
            onChange={(v) => patch({ models: v })}
            placeholder={'deepseek-flash\ndeepseek-v4-pro'}
            rows={3}
          />
        </div>

        {isCustom ? (
          <div>
            <Typography.Text strong>access_path</Typography.Text>
            <Input
              style={{ marginTop: 6 }}
              value={form.accessPath}
              onChange={(v) => patch({ accessPath: v })}
              placeholder="如 deepseek.openai-chat"
            />
          </div>
        ) : null}

        {mode === 'create' ? (
          <div>
            <Typography.Text strong>API Key</Typography.Text>
            <Input
              type="password"
              style={{ marginTop: 6 }}
              value={form.apiKey}
              onChange={(v) => patch({ apiKey: v })}
              placeholder={currentPreset?.key_hint ?? 'sk-...'}
            />
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Typography.Text type="tertiary">
                完整 key 只在这一次提交里出现，提交后立即加密入库，服务端不回显、不写日志。
              </Typography.Text>
            </div>
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Typography.Text strong>启用</Typography.Text>
          <Switch checked={form.enabled} onChange={(v) => patch({ enabled: v })} />
          <div style={{ flex: 1 }}>
            <Input
              value={form.note}
              onChange={(v) => patch({ note: v })}
              placeholder="备注（可选，勿写密钥）"
            />
          </div>
        </div>

        {probeResult ? (
          <Banner
            type="info"
            closeIcon={null}
            description={<span style={{ whiteSpace: 'pre-wrap' }}>{probeResult}</span>}
          />
        ) : null}
      </div>
    </Modal>
  );
}
