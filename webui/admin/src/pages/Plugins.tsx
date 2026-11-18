import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import type { PluginInfoDto, PluginLogEntryDto } from '../api/types.js';
import {
  ErrorBanner,
  PageHeader,
  SegmentedControl,
  StatusBadge,
  Switch,
} from '../components/ui.js';
import { formatDateTime, formatDurationMs } from '../format.js';

type SubTab = 'tools' | 'config' | 'logs';

export function PluginsPage(): React.JSX.Element {
  const [plugins, setPlugins] = useState<PluginInfoDto[]>([]);
  const [logs, setLogs] = useState<PluginLogEntryDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<ActionableError | null>(null);

  const [selectedPluginName, setSelectedPluginName] = useState<string>('');
  const [subTab, setSubTab] = useState<SubTab>('tools');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [toolSearch, setToolSearch] = useState<string>('');
  const [logStatusFilter, setLogStatusFilter] = useState<'all' | 'ok' | 'error'>('all');
  const [logPluginFilter, setLogPluginFilter] = useState<string>('all');
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.listPlugins();
      setPlugins(res.items);
      setLogs(res.logs);
      setSelectedPluginName((prev) => {
        if (prev && res.items.some((p) => p.name === prev)) return prev;
        return res.items[0]?.name ?? '';
      });
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载插件失败' },
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const activePlugin = useMemo(
    () => plugins.find((p) => p.name === selectedPluginName) ?? plugins[0],
    [plugins, selectedPluginName],
  );

  useEffect(() => {
    if (activePlugin) {
      setConfigDraft({ ...activePlugin.config });
    }
  }, [activePlugin]);

  async function handleTogglePlugin(plugin: PluginInfoDto, next: boolean) {
    setSavingKey(`enable:${plugin.name}`);
    setError(null);
    try {
      await adminApi.updatePlugin(plugin.name, { enabled: next });
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '更新失败', message: err instanceof Error ? err.message : '更新失败' },
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function handleToggleMountTarget(
    plugin: PluginInfoDto,
    target: 'agent' | 'data_plane',
    checked: boolean,
  ) {
    const next = new Set(plugin.mount_targets);
    if (checked) next.add(target);
    else next.delete(target);
    setSavingKey(`mount:${plugin.name}`);
    setError(null);
    try {
      await adminApi.updatePlugin(plugin.name, { mount_targets: Array.from(next) });
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '更新失败', message: err instanceof Error ? err.message : '更新失败' },
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function handleToggleTool(plugin: PluginInfoDto, toolName: string, checked: boolean) {
    if (!plugin.tools) return;
    const enabledSet = new Set(plugin.tools.filter((t) => t.enabled).map((t) => t.name));
    if (checked) enabledSet.add(toolName);
    else enabledSet.delete(toolName);
    setSavingKey(`tool:${toolName}`);
    setError(null);
    try {
      await adminApi.updatePlugin(plugin.name, { enabled_tools: Array.from(enabledSet) });
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '更新失败', message: err instanceof Error ? err.message : '更新失败' },
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function handleBatchCategory(plugin: PluginInfoDto, enable: boolean) {
    if (!plugin.tools) return;
    const enabledSet = new Set(plugin.tools.filter((t) => t.enabled).map((t) => t.name));
    for (const t of plugin.tools) {
      if (categoryFilter === 'all' || t.category === categoryFilter) {
        if (enable) enabledSet.add(t.name);
        else enabledSet.delete(t.name);
      }
    }
    setSavingKey(`batch:${categoryFilter}`);
    setError(null);
    try {
      await adminApi.updatePlugin(plugin.name, { enabled_tools: Array.from(enabledSet) });
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '更新失败', message: err instanceof Error ? err.message : '更新失败' },
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function handleSaveConfig(plugin: PluginInfoDto) {
    setSavingKey(`config:${plugin.name}`);
    setError(null);
    try {
      await adminApi.updatePlugin(plugin.name, { config: configDraft });
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存失败' },
      );
    } finally {
      setSavingKey(null);
    }
  }

  async function handleClearLogs() {
    setSavingKey('clear-logs');
    try {
      await adminApi.clearPluginLogs(
        logPluginFilter === 'all' ? undefined : logPluginFilter,
      );
      await loadData();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '清空失败', message: err instanceof Error ? err.message : '清空失败' },
      );
    } finally {
      setSavingKey(null);
    }
  }

  const categories = useMemo(() => {
    if (!activePlugin?.tools) return [];
    return Array.from(new Set(activePlugin.tools.map((t) => t.category)));
  }, [activePlugin]);

  const filteredTools = useMemo(() => {
    if (!activePlugin?.tools) return [];
    const q = toolSearch.trim().toLowerCase();
    return activePlugin.tools.filter((t) => {
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (q === '') return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
      );
    });
  }, [activePlugin, categoryFilter, toolSearch]);

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logStatusFilter !== 'all' && l.status !== logStatusFilter) return false;
      if (logPluginFilter !== 'all' && l.plugin !== logPluginFilter) return false;
      return true;
    });
  }, [logs, logStatusFilter, logPluginFilter]);

  const schemaProperties = useMemo(() => {
    const schema = activePlugin?.config_schema;
    if (!schema || typeof schema !== 'object') return [];
    const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    return Object.entries(props);
  }, [activePlugin]);

  return (
    <div className="ag-page">
      <PageHeader
        title="插件与工具"
        helpSection="plugins"
        actions={
          <button
            type="button"
            className="ag-btn"
            onClick={() => void loadData()}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        }
      />

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* 1. 已加载插件列表 */}
      <div className="ag-grid-2">
        {plugins.map((p) => {
          const isSelected = activePlugin?.name === p.name;
          const enabledToolsCount = p.tools ? p.tools.filter((t) => t.enabled).length : undefined;
          return (
            <div
              key={p.name}
              className="ag-card"
              onClick={() => setSelectedPluginName(p.name)}
              style={{
                cursor: 'pointer',
                borderColor: isSelected ? 'var(--ag-accent)' : undefined,
                gap: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 15 }}>{p.title || p.name}</strong>
                    <span className="ag-mono ag-secondary" style={{ fontSize: 12 }}>
                      v{p.version}
                    </span>
                    <StatusBadge tone={p.enabled ? 'success' : 'neutral'}>
                      {p.enabled ? '已启用' : '已停用'}
                    </StatusBadge>
                  </div>
                  {p.description && (
                    <span className="ag-secondary" style={{ fontSize: 12 }}>
                      {p.description}
                    </span>
                  )}
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={p.enabled}
                    disabled={savingKey === `enable:${p.name}`}
                    onChange={(next) => void handleTogglePlugin(p, next)}
                  />
                </div>
              </div>

              {/* Hook 与挂载点 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                  paddingTop: 8,
                  borderTop: '1px solid var(--ag-border)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {p.hooks.map((h) => (
                    <StatusBadge key={h} tone="info">
                      {h}
                    </StatusBadge>
                  ))}
                  {enabledToolsCount !== undefined && (
                    <StatusBadge tone="neutral">
                      工具 {enabledToolsCount}/{p.tools!.length}
                    </StatusBadge>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={p.mount_targets.includes('agent')}
                      disabled={savingKey === `mount:${p.name}`}
                      onChange={(e) => void handleToggleMountTarget(p, 'agent', e.target.checked)}
                    />
                    <span>内置 AI</span>
                  </label>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={p.mount_targets.includes('data_plane')}
                      disabled={savingKey === `mount:${p.name}`}
                      onChange={(e) =>
                        void handleToggleMountTarget(p, 'data_plane', e.target.checked)
                      }
                    />
                    <span>API 访问</span>
                  </label>
                </div>
              </div>

              {/* 调用统计与许可署名 */}
              <div
                className="ag-secondary ag-tabular"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', gap: 12 }}>
                  <span>调用 {p.stats.call_count} 次</span>
                  <span>异常 {p.stats.error_count} 次</span>
                  <span>均耗 {formatDurationMs(p.stats.avg_duration_ms)}</span>
                </div>
                {(p.license || p.homepage) && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    {p.license && <span>{p.license}</span>}
                    {p.homepage && (
                      <a
                        href={p.homepage}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ag-help-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        仓库 →
                      </a>
                    )}
                  </div>
                )}
              </div>

              {p.attribution && (
                <div className="ag-secondary" style={{ fontSize: 12 }}>
                  {p.attribution}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 2. 插件详情与工作区 */}
      {activePlugin && (
        <div className="ag-card" style={{ gap: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong style={{ fontSize: 15 }}>
                {activePlugin.title || activePlugin.name}
              </strong>
              <span className="ag-mono ag-secondary">{activePlugin.name}</span>
            </div>

            <SegmentedControl
              value={subTab}
              onChange={(v) => setSubTab(v as SubTab)}
              options={[
                ...(activePlugin.tools && activePlugin.tools.length > 0
                  ? [{ value: 'tools', label: `工具目录 (${activePlugin.tools.length})` }]
                  : []),
                { value: 'logs', label: `执行日志 (${filteredLogs.length})` },
                { value: 'config', label: '插件配置' },
              ]}
            />
          </div>

          {subTab === 'tools' && activePlugin.tools && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`ag-btn ag-btn-sm${categoryFilter === 'all' ? ' ag-btn-primary' : ''}`}
                    onClick={() => setCategoryFilter('all')}
                  >
                    全部 ({activePlugin.tools.length})
                  </button>
                  {categories.map((cat) => {
                    const count = activePlugin.tools!.filter((t) => t.category === cat).length;
                    return (
                      <button
                        key={cat}
                        type="button"
                        className={`ag-btn ag-btn-sm${categoryFilter === cat ? ' ag-btn-primary' : ''}`}
                        onClick={() => setCategoryFilter(cat)}
                      >
                        {cat} ({count})
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    className="ag-input"
                    style={{ width: 190, height: 30 }}
                    placeholder="搜索工具名或说明…"
                    value={toolSearch}
                    onChange={(e) => setToolSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    disabled={savingKey !== null}
                    onClick={() => void handleBatchCategory(activePlugin, true)}
                  >
                    本组全选
                  </button>
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    disabled={savingKey !== null}
                    onClick={() => void handleBatchCategory(activePlugin, false)}
                  >
                    本组全关
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 12,
                }}
              >
                {filteredTools.map((tool) => (
                  <div
                    key={tool.name}
                    style={{
                      padding: 12,
                      borderRadius: 'var(--ag-radius-md)',
                      border: '1px solid var(--ag-border)',
                      background: 'var(--ag-surface-raised)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 13 }}>{tool.label}</strong>
                          {tool.requires_confirmation && (
                            <StatusBadge tone="warning">需界面确认</StatusBadge>
                          )}
                        </div>
                        <span className="ag-mono ag-secondary" style={{ fontSize: 11 }}>
                          {tool.name}
                        </span>
                      </div>
                      <Switch
                        checked={tool.enabled}
                        disabled={savingKey === `tool:${tool.name}`}
                        onChange={(next) => void handleToggleTool(activePlugin, tool.name, next)}
                      />
                    </div>
                    <div className="ag-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                      {tool.description}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {subTab === 'config' && (
            schemaProperties.length === 0 ? (
              <div className="ag-empty">
                <p className="ag-empty-text">该插件暂无额外配置参数</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {schemaProperties.map(([key, prop]) => {
                  const type = String(prop['type'] ?? 'string');
                  const title = String(prop['title'] ?? key);
                  const val = configDraft[key] ?? prop['default'];
                  return (
                    <div key={key} className="ag-field">
                      <label className="ag-field-label">
                        <span>{title}</span>
                        <span className="ag-mono ag-secondary">{key}</span>
                      </label>
                      {type === 'boolean' ? (
                        <Switch
                          checked={Boolean(val)}
                          onChange={(next) =>
                            setConfigDraft((prev) => ({ ...prev, [key]: next }))
                          }
                        />
                      ) : type === 'number' || type === 'integer' ? (
                        <input
                          type="number"
                          className="ag-input ag-tabular"
                          value={val === undefined ? '' : Number(val)}
                          onChange={(e) =>
                            setConfigDraft((prev) => ({
                              ...prev,
                              [key]: Number(e.target.value),
                            }))
                          }
                        />
                      ) : (
                        <input
                          className="ag-input"
                          value={val === undefined ? '' : String(val)}
                          onChange={(e) =>
                            setConfigDraft((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                        />
                      )}
                    </div>
                  );
                })}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="ag-btn ag-btn-primary"
                    disabled={savingKey === `config:${activePlugin.name}`}
                    onClick={() => void handleSaveConfig(activePlugin)}
                  >
                    保存配置
                  </button>
                </div>
              </div>
            )
          )}

          {subTab === 'logs' && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <select
                    className="ag-select"
                    style={{ width: 180, height: 32 }}
                    value={logPluginFilter}
                    onChange={(e) => setLogPluginFilter(e.target.value)}
                  >
                    <option value="all">全部插件</option>
                    {plugins.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.title || p.name}
                      </option>
                    ))}
                  </select>
                  <SegmentedControl
                    value={logStatusFilter}
                    onChange={(v) => setLogStatusFilter(v as 'all' | 'ok' | 'error')}
                    options={[
                      { value: 'all', label: '全部状态' },
                      { value: 'ok', label: '成功' },
                      { value: 'error', label: '异常' },
                    ]}
                  />
                </div>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  disabled={savingKey === 'clear-logs' || logs.length === 0}
                  onClick={() => void handleClearLogs()}
                >
                  清空日志
                </button>
              </div>

              {filteredLogs.length === 0 ? (
                <div className="ag-empty">
                  <p className="ag-empty-text">暂无插件执行日志</p>
                </div>
              ) : (
                <div className="ag-table-wrap">
                  <table className="ag-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>插件</th>
                        <th>Hook / 工具</th>
                        <th>状态</th>
                        <th>耗时</th>
                        <th>摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLogs.map((log) => (
                        <tr key={log.id}>
                          <td className="ag-secondary ag-tabular" style={{ whiteSpace: 'nowrap' }}>
                            {formatDateTime(log.ts)}
                          </td>
                          <td className="ag-mono">{log.plugin}</td>
                          <td className="ag-mono">
                            {log.tool_name ? `${log.hook} · ${log.tool_name}` : log.hook}
                          </td>
                          <td>
                            <StatusBadge tone={log.status === 'ok' ? 'success' : 'danger'}>
                              {log.status === 'ok' ? '成功' : '异常'}
                            </StatusBadge>
                          </td>
                          <td className="ag-tabular">{formatDurationMs(log.duration_ms)}</td>
                          <td className="ag-secondary" style={{ maxWidth: 340, wordBreak: 'break-word' }}>
                            {log.summary}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
