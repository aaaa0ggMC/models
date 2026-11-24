import React, { useState } from 'react';
import type { ModelAvailabilitySnapshot } from '../api/model-availability.js';
import type { SettingDto, SettingSource, SettingValue } from '../api/types.js';
import { StatusBadge, Switch } from '../components/ui.js';
import { helpHref, navigate } from '../router.js';

const SOURCE_LABELS: Record<SettingSource, { label: string; tone: 'info' | 'warning' | 'neutral' }> = {
  encrypted_storage: { label: '已修改', tone: 'info' },
  env: { label: '环境变量', tone: 'warning' },
  config_file: { label: '配置文件', tone: 'neutral' },
  default: { label: '默认', tone: 'neutral' },
};

const TOOL_GROUPS: ReadonlyArray<{
  id: string;
  label: string;
  tools: readonly string[];
}> = [
  {
    id: 'channels',
    label: '渠道管理',
    tools: ['list_channels', 'add_provider', 'update_provider', 'update_provider_credential', 'delete_provider', 'test_provider'],
  },
  {
    id: 'credentials',
    label: '凭据管理',
    tools: ['list_credentials', 'probe_credential', 'delete_credential'],
  },
  {
    id: 'models_aliases',
    label: '模型与别名',
    tools: [
      'list_models',
      'set_model_visibility',
      'sync_models',
      'list_aliases',
      'upsert_alias',
      'delete_alias',
      'resolve_alias',
    ],
  },
  {
    id: 'virtual_keys',
    label: '客户端密钥',
    tools: ['list_virtual_keys', 'create_virtual_key', 'revoke_virtual_key', 'delete_virtual_key'],
  },
  {
    id: 'route_graphs',
    label: '路由图引擎',
    tools: ['list_route_graphs', 'upsert_route_graph', 'simulate_route_graph', 'delete_route_graph'],
  },
  {
    id: 'telemetry_system',
    label: '遥测与系统',
    tools: ['usage_summary', 'get_routing_telemetry', 'list_settings', 'update_setting', 'get_gateway_doc'],
  },
];

const ALL_TOOL_COUNT = TOOL_GROUPS.reduce((sum, g) => sum + g.tools.length, 0);

export function AgentRunPanel({
  settings,
  availability,
  savingId,
  onUpdateSetting,
  onResetSetting,
}: {
  settings: readonly SettingDto[];
  availability: ModelAvailabilitySnapshot;
  savingId: string | null;
  onUpdateSetting: (id: string, value: SettingValue) => Promise<void>;
  onResetSetting: (id: string) => Promise<void>;
}): React.JSX.Element {
  const byId = new Map(settings.map((s) => [s.id, s]));

  const accessPathSetting = byId.get('agent_access_path');
  const modelSetting = byId.get('agent_model');
  const systemPromptSetting = byId.get('agent_system_prompt');
  const toolsSetting = byId.get('agent_tools');
  const tempSetting = byId.get('agent_temperature');
  const maxTokensSetting = byId.get('agent_max_tokens');
  const maxTurnsSetting = byId.get('agent_max_turns');
  const streamSetting = byId.get('agent_stream');
  const persistSetting = byId.get('agent_persist_messages');
  const redactResultsSetting = byId.get('agent_redact_tool_results');
  const placeholderSetting = byId.get('agent_redaction_placeholder');

  const savedAccessPath = String(accessPathSetting?.value ?? '');
  const savedModel = String(modelSetting?.value ?? '');
  const diagnostic = availability.inspectSaved(savedModel, savedAccessPath);

  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const currentPrompt =
    promptDraft !== null ? promptDraft : String(systemPromptSetting?.value ?? '');

  const enabledTools = Array.isArray(toolsSetting?.value)
    ? (toolsSetting.value as string[])
    : [];

  async function handleSelectModelOption(compositeKey: string) {
    const opt = availability.options.find((o) => o.key === compositeKey);
    if (!opt) return;
    if (opt.accessPath !== savedAccessPath) {
      await onUpdateSetting('agent_access_path', opt.accessPath);
    }
    if (opt.model !== savedModel) {
      await onUpdateSetting('agent_model', opt.model);
    }
  }

  async function handleToggleToolGroup(groupTools: readonly string[], nextChecked: boolean) {
    const set = new Set(enabledTools);
    for (const toolName of groupTools) {
      if (nextChecked) set.add(toolName);
      else set.delete(toolName);
    }
    await onUpdateSetting('agent_tools', Array.from(set));
  }

  const activeCompositeKey =
    availability.options.find(
      (o) => o.model === savedModel && o.accessPath === savedAccessPath,
    )?.key ??
    availability.options.find((o) => o.model === savedModel)?.key ??
    availability.options[0]?.key ??
    '';

  return (
    <aside className="ag-run-panel" aria-label="运行设置">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingBottom: 12,
          borderBottom: '1px solid var(--ag-border)',
        }}
      >
        <h2 className="ag-section-title">运行设置</h2>
        <a className="ag-help-link" href={helpHref('agent')}>
          设置说明 →
        </a>
      </div>

      {/* 1. 模型选择器（97 §2.5 #3 & #4、§5 #5 & #6：只列可用项；零可用不画下拉） */}
      <div className="ag-field">
        <div className="ag-field-label">
          <span>运行模型</span>
          {modelSetting && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusBadge tone={SOURCE_LABELS[modelSetting.source].tone}>
                {SOURCE_LABELS[modelSetting.source].label}
              </StatusBadge>
              {modelSetting.source === 'encrypted_storage' && modelSetting.editable && (
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => void onResetSetting('agent_model')}
                  disabled={savingId === 'agent_model'}
                >
                  恢复默认
                </button>
              )}
            </div>
          )}
        </div>

        {/* 已保存但当前不可用的值：呈现为只读信息行（值 + 原因），不删数据、不进下拉 */}
        {!diagnostic.available && savedModel && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--ag-radius-sm)',
              background: 'var(--ag-warning-bg)',
              border: '1px solid var(--ag-warning-border)',
              color: 'var(--ag-warning)',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {/* ui-copy: allow 已存不可用模型的只读原因提示（97 §2.5 #4 硬要求） */}
            当前保存的是 <span className="ag-mono">{savedModel}</span>（{ diagnostic.reason }）
          </div>
        )}

        {availability.options.length === 0 ? (
          <div
            style={{
              padding: 14,
              borderRadius: 'var(--ag-radius-sm)',
              border: '1px dashed var(--ag-border-strong)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
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
            value={activeCompositeKey}
            disabled={modelSetting?.editable === false || savingId === 'agent_model'}
            onChange={(e) => void handleSelectModelOption(e.target.value)}
          >
            {availability.options.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.model} ({opt.providerLabel})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 2. 系统提示词 */}
      {systemPromptSetting && (
        <div className="ag-field">
          <div className="ag-field-label">
            <span>系统指令</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <StatusBadge tone={SOURCE_LABELS[systemPromptSetting.source].tone}>
                {SOURCE_LABELS[systemPromptSetting.source].label}
              </StatusBadge>
              {systemPromptSetting.source === 'encrypted_storage' &&
                systemPromptSetting.editable && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    onClick={() => {
                      setPromptDraft(null);
                      void onResetSetting('agent_system_prompt');
                    }}
                  >
                    恢复默认
                  </button>
                )}
            </div>
          </div>
          <textarea
            className="ag-textarea"
            rows={4}
            value={currentPrompt}
            disabled={!systemPromptSetting.editable}
            onChange={(e) => setPromptDraft(e.target.value)}
          />
          {promptDraft !== null && promptDraft !== String(systemPromptSetting.value) && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => setPromptDraft(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-sm ag-btn-primary"
                onClick={async () => {
                  await onUpdateSetting('agent_system_prompt', promptDraft);
                  setPromptDraft(null);
                }}
                disabled={savingId === 'agent_system_prompt'}
              >
                保存指令
              </button>
            </div>
          )}
        </div>
      )}

      {/* 3. 采样与回合参数 */}
      <div className="ag-field">
        <div className="ag-field-label">
          <span>推理参数</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tempSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="ag-secondary">温度 (0–2)</span>
              <input
                type="number"
                step="0.1"
                min={0}
                max={2}
                className="ag-input ag-tabular"
                style={{ width: 100 }}
                value={Number(tempSetting.value)}
                disabled={!tempSetting.editable}
                onChange={(e) =>
                  void onUpdateSetting('agent_temperature', Number(e.target.value))
                }
              />
            </div>
          )}

          {maxTokensSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="ag-secondary">最大输出</span>
              <input
                type="number"
                step="256"
                min={1}
                max={200000}
                className="ag-input ag-tabular"
                style={{ width: 100 }}
                value={Number(maxTokensSetting.value)}
                disabled={!maxTokensSetting.editable}
                onChange={(e) =>
                  void onUpdateSetting('agent_max_tokens', Number(e.target.value))
                }
              />
            </div>
          )}

          {maxTurnsSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="ag-secondary">工具轮次上限</span>
              <input
                type="number"
                min={1}
                max={50}
                className="ag-input ag-tabular"
                style={{ width: 100 }}
                value={Number(maxTurnsSetting.value)}
                disabled={!maxTurnsSetting.editable}
                onChange={(e) =>
                  void onUpdateSetting('agent_max_turns', Number(e.target.value))
                }
              />
            </div>
          )}

          {streamSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span className="ag-secondary">流式响应</span>
              <Switch
                checked={Boolean(streamSetting.value)}
                disabled={!streamSetting.editable}
                onChange={(next) => void onUpdateSetting('agent_stream', next)}
              />
            </div>
          )}

          {persistSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span className="ag-secondary">会话留存</span>
              <Switch
                checked={Boolean(persistSetting.value)}
                disabled={!persistSetting.editable}
                onChange={(next) => void onUpdateSetting('agent_persist_messages', next)}
              />
            </div>
          )}
        </div>
      </div>

      {/* 4. 插件与工具分组摘要（明细与执行日志收拢至 #/plugins） */}
      {toolsSetting && (
        <div className="ag-field">
          <div className="ag-field-label">
            <span>
              插件工具 ({enabledTools.length}/{ALL_TOOL_COUNT})
            </span>
            {toolsSetting.source === 'encrypted_storage' && toolsSetting.editable && (
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => void onResetSetting('agent_tools')}
              >
                恢复默认
              </button>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 10,
              borderRadius: 'var(--ag-radius-sm)',
              border: '1px solid var(--ag-border)',
              background: 'var(--ag-surface-raised)',
            }}
          >
            {TOOL_GROUPS.map((group) => {
              const activeCount = group.tools.filter((t) => enabledTools.includes(t)).length;
              const allChecked = activeCount === group.tools.length;
              return (
                <label
                  key={group.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: 13,
                    cursor: toolsSetting.editable ? 'pointer' : 'not-allowed',
                  }}
                >
                  <span>
                    {group.label}{' '}
                    <span className="ag-secondary ag-tabular" style={{ fontSize: 12 }}>
                      ({activeCount}/{group.tools.length})
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={!toolsSetting.editable}
                    onChange={(e) => void handleToggleToolGroup(group.tools, e.target.checked)}
                  />
                </label>
              );
            })}
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              style={{ marginTop: 4, width: '100%' }}
              onClick={() => navigate('plugins')}
            >
              管理插件与工具日志 →
            </button>
          </div>
        </div>
      )}

      {/* 5. 隐私与脱敏 */}
      <div className="ag-field">
        <div className="ag-field-label">
          <span>密钥脱敏保护</span>
          <button
            type="button"
            className="ag-btn ag-btn-sm"
            onClick={() => navigate('settings')}
          >
            编辑规则 →
          </button>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 10,
            borderRadius: 'var(--ag-radius-sm)',
            border: '1px solid var(--ag-border)',
          }}
        >
          {redactResultsSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 13,
              }}
            >
              <span>工具输出二次脱敏</span>
              <Switch
                checked={Boolean(redactResultsSetting.value)}
                disabled={!redactResultsSetting.editable}
                onChange={(next) =>
                  void onUpdateSetting('agent_redact_tool_results', next)
                }
              />
            </div>
          )}
          {placeholderSetting && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 13,
              }}
            >
              <span className="ag-secondary">替换占位符</span>
              <span className="ag-mono">{String(placeholderSetting.value)}</span>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
