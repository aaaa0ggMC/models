import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { computeModelAvailability } from '../api/model-availability.js';
import type {
  AccessPathDto,
  CapabilityMatrixEntry,
  EnvCredentialPathDto,
  MaskedCredential,
  ProviderConfig,
  RedactionRuleItem,
  SettingDto,
  SettingSource,
  SettingValue,
} from '../api/types.js';
import {
  ErrorBanner,
  PageHeader,
  StatusBadge,
  Switch,
} from '../components/ui.js';
import { navigate } from '../router.js';

const SOURCE_BADGES: Record<
  SettingSource,
  { label: string; tone: 'info' | 'warning' | 'neutral' }
> = {
  encrypted_storage: { label: '已修改', tone: 'info' },
  env: { label: '环境变量锁定', tone: 'warning' },
  config_file: { label: '配置文件', tone: 'neutral' },
  default: { label: '默认', tone: 'neutral' },
};

export function SettingsPage(): React.JSX.Element {
  const [items, setItems] = useState<SettingDto[]>([]);
  const [configFilePath, setConfigFilePath] = useState<string | undefined>(undefined);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMatrixEntry[]>([]);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<ActionableError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, pRes, apRes, capRes] = await Promise.all([
        adminApi.listSettings(),
        adminApi.listProviders(),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listCapabilities(),
      ]);
      setItems(sRes.items);
      setConfigFilePath(sRes.config_file_path);
      setProviders(pRes.items);
      setAccessPaths(apRes.items);
      setCapabilities(capRes.items);
      setDrafts({});
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const availability = useMemo(
    () =>
      computeModelAvailability({
        providers,
        accessPaths,
        capabilities,
        modalityFilter: 'chat',
      }),
    [providers, accessPaths, capabilities],
  );

  async function handleSave(id: string, value: SettingValue) {
    setSavingId(id);
    setError(null);
    setFeedback(null);
    try {
      const res = await adminApi.updateSetting(id, value);
      setItems((prev) => prev.map((it) => (it.id === id ? res.item : it)));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFeedback(`已保存「${res.item.label}」`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存未成功' },
      );
    } finally {
      setSavingId(null);
    }
  }

  async function handleReset(id: string) {
    setSavingId(id);
    setError(null);
    setFeedback(null);
    try {
      const res = await adminApi.resetSetting(id);
      setItems((prev) => prev.map((it) => (it.id === id ? res.item : it)));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setFeedback(`「${res.item.label}」已恢复默认`);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '重置失败', message: err instanceof Error ? err.message : '重置未成功' },
      );
    } finally {
      setSavingId(null);
    }
  }

  const gatewayItems = items.filter((i) => i.group === 'gateway');
  const agentItems = items.filter((i) => i.group === 'agent');
  const byId = new Map(items.map((i) => [i.id, i]));
  const savedAgentModel = String(byId.get('agent_model')?.value ?? '');
  const savedAgentAccessPath = String(byId.get('agent_access_path')?.value ?? '');
  const modelDiag = availability.inspectSaved(savedAgentModel, savedAgentAccessPath);

  function renderControl(item: SettingDto) {
    const busy = savingId === item.id;

    // 特殊联动：内置助手模型与渠道选择器（与对话页右侧面板同源，只列可用项，97 §2.5 #3 & #4）
    if (item.id === 'agent_model' || item.id === 'agent_access_path') {
      const activeCompositeKey =
        availability.options.find(
          (o) => o.model === savedAgentModel && o.accessPath === savedAgentAccessPath,
        )?.key ??
        availability.options.find((o) => o.model === savedAgentModel)?.key ??
        availability.options[0]?.key ??
        '';

      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!modelDiag.available && savedAgentModel && (
            <div
              style={{
                padding: '6px 10px',
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-warning-bg)',
                border: '1px solid var(--ag-warning-border)',
                color: 'var(--ag-warning)',
                fontSize: 12,
              }}
            >
              {/* ui-copy: allow 已存不可用值的只读原因说明（97 §2.5 #4 硬要求） */}
              当前保存的是{' '}
              <span className="ag-mono">
                {item.id === 'agent_model' ? savedAgentModel : savedAgentAccessPath}
              </span>
              （{modelDiag.reason}）
            </div>
          )}

          {availability.options.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="ag-secondary">没有可选的模型</span>
              {availability.emptyReason === 'no_channel' ? (
                <button
                  type="button"
                  className="ag-btn ag-btn-sm ag-btn-primary"
                  onClick={() => navigate('channels')}
                >
                  去建渠道
                </button>
              ) : (
                <button
                  type="button"
                  className="ag-btn ag-btn-sm ag-btn-primary"
                  onClick={() => navigate('channels')}
                >
                  去录凭据
                </button>
              )}
            </div>
          ) : (
            <select
              className="ag-select ag-mono"
              style={{ maxWidth: 360 }}
              value={activeCompositeKey}
              disabled={!item.editable || busy}
              onChange={async (e) => {
                const chosen = availability.options.find((o) => o.key === e.target.value);
                if (!chosen) return;
                await handleSave('agent_access_path', chosen.accessPath);
                await handleSave('agent_model', chosen.model);
              }}
            >
              {availability.options.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {item.id === 'agent_model'
                    ? `${opt.model} (${opt.providerLabel})`
                    : `${opt.accessPath} · ${opt.model}`}
                </option>
              ))}
            </select>
          )}
        </div>
      );
    }

    if (item.type === 'bool') {
      return (
        <Switch
          checked={Boolean(item.value)}
          disabled={!item.editable || busy}
          onChange={(next) => void handleSave(item.id, next)}
        />
      );
    }

    if (item.type === 'enum' && item.options) {
      return (
        <select
          className="ag-select ag-mono"
          style={{ maxWidth: 220 }}
          value={String(item.value)}
          disabled={!item.editable || busy}
          onChange={(e) => void handleSave(item.id, e.target.value)}
        >
          {item.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }

    if (item.type === 'int' || item.type === 'number') {
      const draftVal =
        drafts[item.id] !== undefined ? drafts[item.id]! : String(item.value ?? '');
      const changed = draftVal !== String(item.value ?? '');
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            step={item.type === 'int' ? '1' : '0.1'}
            min={item.range?.min}
            max={item.range?.max}
            className="ag-input ag-tabular"
            style={{ width: 160 }}
            value={draftVal}
            disabled={!item.editable || busy}
            onChange={(e) =>
              setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
            }
          />
          {item.unit && <span className="ag-secondary">{item.unit}</span>}
          {changed && (
            <button
              type="button"
              className="ag-btn ag-btn-sm ag-btn-primary"
              disabled={busy}
              onClick={() => void handleSave(item.id, Number(draftVal))}
            >
              保存
            </button>
          )}
        </div>
      );
    }

    if (item.type === 'string[]') {
      const arr = Array.isArray(item.value) ? (item.value as string[]) : [];
      const draftVal =
        drafts[item.id] !== undefined ? drafts[item.id]! : arr.join(', ');
      const changed = draftVal !== arr.join(', ');
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <input
            className="ag-input ag-mono"
            value={draftVal}
            disabled={!item.editable || busy}
            onChange={(e) =>
              setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
            }
          />
          {changed && (
            <button
              type="button"
              className="ag-btn ag-btn-sm ag-btn-primary"
              disabled={busy}
              onClick={() =>
                void handleSave(
                  item.id,
                  draftVal
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            >
              保存
            </button>
          )}
        </div>
      );
    }

    if (item.id === 'agent_redaction_rules') {
      const rules = Array.isArray(item.value)
        ? (item.value as RedactionRuleItem[])
        : [];
      return (
        <RedactionRulesInlineEditor
          rules={rules}
          editable={item.editable && !busy}
          onSave={(nextRules) => void handleSave(item.id, nextRules)}
        />
      );
    }

    // 多行文本或代码（系统提示词 / 自定义脱敏判定 JS）
    if (
      item.id === 'agent_system_prompt' ||
      item.id === 'agent_redaction_detect_js' ||
      item.type === 'json'
    ) {
      const initialStr =
        typeof item.value === 'string'
          ? item.value
          : JSON.stringify(item.value, null, 2);
      const draftVal = drafts[item.id] !== undefined ? drafts[item.id]! : initialStr;
      const changed = draftVal !== initialStr;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
          <textarea
            className={`ag-textarea${item.id === 'agent_redaction_detect_js' || item.type === 'json' ? ' ag-mono' : ''}`}
            rows={item.id === 'agent_redaction_detect_js' ? 6 : 4}
            value={draftVal}
            disabled={!item.editable || busy}
            onChange={(e) =>
              setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
            }
          />
          {changed && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() =>
                  setDrafts((prev) => {
                    const next = { ...prev };
                    delete next[item.id];
                    return next;
                  })
                }
              >
                放弃修改
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-sm ag-btn-primary"
                disabled={busy}
                onClick={() => void handleSave(item.id, draftVal)}
              >
                保存
              </button>
            </div>
          )}
        </div>
      );
    }

    const draftVal =
      drafts[item.id] !== undefined ? drafts[item.id]! : String(item.value ?? '');
    const changed = draftVal !== String(item.value ?? '');
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          className="ag-input ag-mono"
          style={{ width: 240 }}
          value={draftVal}
          disabled={!item.editable || busy}
          onChange={(e) =>
            setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
          }
        />
        {changed && (
          <button
            type="button"
            className="ag-btn ag-btn-sm ag-btn-primary"
            disabled={busy}
            onClick={() => void handleSave(item.id, draftVal)}
          >
            保存
          </button>
        )}
      </div>
    );
  }

  function renderSection(title: string, sectionItems: SettingDto[]) {
    return (
      <div className="ag-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--ag-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h2 className="ag-section-title">{title}</h2>
        </div>

        <div className="ag-table-wrap">
          <table className="ag-table">
            <thead>
              <tr>
                <th style={{ width: 220 }}>配置项</th>
                <th>当前生效值</th>
                <th style={{ width: 160 }}>来源层级</th>
                <th style={{ width: 120, textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sectionItems.map((item) => {
                const badge = SOURCE_BADGES[item.source];
                return (
                  <tr key={item.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{item.label}</div>
                      <div className="ag-mono ag-secondary">{item.id}</div>
                      {item.range && (
                        <div className="ag-secondary ag-tabular" style={{ fontSize: 12 }}>
                          范围：{item.range.min}–{item.range.max} {item.unit}
                        </div>
                      )}
                      {!item.editable && item.env_var && (
                        <div
                          className="ag-mono"
                          style={{ fontSize: 12, color: 'var(--ag-warning)' }}
                        >
                          锁定变量：{item.env_var}
                        </div>
                      )}
                    </td>
                    <td>{renderControl(item)}</td>
                    <td>
                      <StatusBadge tone={badge.tone} title={item.reason}>
                        {badge.label}
                      </StatusBadge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {item.source === 'encrypted_storage' && item.editable && (
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          disabled={savingId === item.id}
                          onClick={() => void handleReset(item.id)}
                        >
                          恢复默认
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="ag-page">
      <PageHeader
        title="系统设置"
        helpSection="settings"
        actions={
          <>
            {configFilePath && (
              <StatusBadge tone="neutral">配置文件: {configFilePath}</StatusBadge>
            )}
            <button
              type="button"
              className="ag-btn"
              onClick={() => void loadAll()}
              disabled={loading}
            >
              刷新
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {feedback && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--ag-radius-sm)',
            background: 'var(--ag-success-bg)',
            border: '1px solid var(--ag-success-border)',
            color: 'var(--ag-success)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{feedback}</span>
          <button
            type="button"
            className="ag-btn ag-btn-sm"
            onClick={() => setFeedback(null)}
          >
            关闭
          </button>
        </div>
      )}

      {loading ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 48 }} />
          <div className="ag-skeleton" style={{ height: 48 }} />
        </div>
      ) : (
        <>
          {renderSection('网关运行参数', gatewayItems)}
          {renderSection('内置助手配置', agentItems)}
        </>
      )}
    </div>
  );
}

function RedactionRulesInlineEditor({
  rules,
  editable,
  onSave,
}: {
  rules: readonly RedactionRuleItem[];
  editable: boolean;
  onSave: (next: RedactionRuleItem[]) => void;
}): React.JSX.Element {
  const [newPattern, setNewPattern] = useState('');
  const [newNote, setNewNote] = useState('');

  function handleAdd() {
    if (!newPattern.trim()) return;
    const next: RedactionRuleItem[] = [
      ...rules,
      {
        id: `rule_${Date.now().toString(36)}`,
        pattern: newPattern.trim(),
        flags: 'g',
        enabled: true,
        ...(newNote.trim() ? { note: newNote.trim() } : {}),
      },
    ];
    onSave(next);
    setNewPattern('');
    setNewNote('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rules.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rules.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-surface-raised)',
                border: '1px solid var(--ag-border)',
              }}
            >
              <div>
                <code className="ag-mono">/{r.pattern}/{r.flags}</code>
                {r.note && <span className="ag-secondary"> · {r.note}</span>}
              </div>
              {editable && (
                <button
                  type="button"
                  className="ag-btn ag-btn-sm ag-btn-danger"
                  onClick={() => onSave(rules.filter((x) => x.id !== r.id))}
                >
                  移除
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {editable && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <input
            className="ag-input ag-mono"
            style={{ width: 220 }}
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            placeholder="新增脱敏正则，如 ghp_[A-Za-z0-9]{20,}"
          />
          <input
            className="ag-input"
            style={{ width: 140 }}
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="规则备注"
          />
          <button
            type="button"
            className="ag-btn ag-btn-sm"
            disabled={!newPattern.trim()}
            onClick={handleAdd}
          >
            添加规则
          </button>
        </div>
      )}
    </div>
  );
}
