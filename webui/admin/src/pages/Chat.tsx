import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import { computeModelAvailability } from '../api/model-availability.js';
import { runClientRedaction } from '../api/redaction.js';
import type {
  AccessPathDto,
  AgentChatMessage,
  AgentChatUsage,
  AgentSecretDisclosure,
  AgentToolCallView,
  CapabilityMatrixEntry,
  EnvCredentialPathDto,
  MaskedCredential,
  ProviderConfig,
  RedactionRulesResponse,
  SettingDto,
  SettingValue,
} from '../api/types.js';
import { ConfirmModal, ErrorBanner, Modal, StatusBadge } from '../components/ui.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { formatDurationMs, formatInt } from '../format.js';
import { AgentRunPanel } from './AgentRunPanel.js';

interface ConversationTurn {
  id: string;
  userText: string;
  redactedCount: number;
  reply: string;
  model: string;
  startedAtMs?: number;
  reasoning?: string;
  durationMs?: number;
  usage?: AgentChatUsage;
  toolCalls: AgentToolCallView[];
  secrets: AgentSecretDisclosure[];
  status: 'streaming' | 'done' | 'error' | 'aborted';
  errorMessage?: string;
}

interface PendingDeleteAction {
  action:
    | 'delete_provider'
    | 'delete_credential'
    | 'delete_alias'
    | 'delete_virtual_key'
    | 'delete_route_graph';
  resource_id: string;
  label: string;
  detail: string;
  cascade_credentials?: boolean;
}

// 即使未开启服务端会话留存，切换标签页时也保留当前标签页内的会话上下文，直到用户手动清空或关闭页面
let sessionTurnsCache: ConversationTurn[] = [];
let sessionInputDraft = '';
let sessionDeleteStates: Record<string, 'deleted' | 'cancelled'> = {};

const STARTER_PROMPTS: ReadonlyArray<{ title: string; prompt: string }> = [
  {
    title: '检查渠道与凭据状态',
    // ui-copy: allow 对话空状态可点击示例指令（97 §4.5）
    prompt: '列出当前所有已配置的渠道与凭据健康状态，并指出哪些需要处理。',
  },
  {
    title: '汇总近期用量与花费',
    // ui-copy: allow 对话空状态可点击示例指令（97 §4.5）
    prompt: '帮我查看最近的请求总数、Token 消耗与费用汇总。',
  },
  {
    title: '解析模型路由规则',
    // ui-copy: allow 对话空状态可点击示例指令（97 §4.5）
    prompt: '列出当前可用的模型目录，并检查常用模型的路由去向。',
  },
];

export function ChatPage(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingDto[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [credentials, setCredentials] = useState<MaskedCredential[]>([]);
  const [envCredentials, setEnvCredentials] = useState<EnvCredentialPathDto[]>([]);
  const [accessPaths, setAccessPaths] = useState<AccessPathDto[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityMatrixEntry[]>([]);
  const [redactionRules, setRedactionRules] = useState<RedactionRulesResponse | null>(null);

  const [savingSettingId, setSavingSettingId] = useState<string | null>(null);
  const [error, setError] = useState<ActionableError | null>(null);
  const [showRightPanel, setShowRightPanel] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 860,
  );
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState<boolean>(false);

  // 对话回合与输入状态（从 SPA 会话内存恢复，切 Tab 不丢失）
  const [turns, setTurns] = useState<ConversationTurn[]>(() => sessionTurnsCache);
  const [inputText, setInputText] = useState<string>(() => sessionInputDraft);
  const [sending, setSending] = useState<boolean>(false);
  const [deleteStates, setDeleteStates] = useState<Record<string, 'deleted' | 'cancelled'>>(
    () => sessionDeleteStates,
  );
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef<boolean>(true);

  useEffect(() => {
    sessionTurnsCache = turns;
  }, [turns]);

  useEffect(() => {
    sessionInputDraft = inputText;
  }, [inputText]);

  useEffect(() => {
    sessionDeleteStates = deleteStates;
  }, [deleteStates]);

  // 「需要凭据」直接录入弹窗（97 §2.7 #3：密钥走弹窗直接进凭据端点，绝不经过模型）
  const [credPromptTarget, setCredPromptTarget] = useState<{
    provider: string;
    accessPaths: string[];
    replaceExisting: boolean;
  } | null>(null);
  const [credSecretInput, setCredSecretInput] = useState<string>('');
  const [credSaving, setCredSaving] = useState<boolean>(false);

  const loadContext = useCallback(async () => {
    try {
      const [sRes, pRes, cRes, eRes, apRes, capRes, rRes] = await Promise.all([
        adminApi.listSettings(),
        adminApi.listProviders(),
        adminApi.listCredentials(),
        adminApi.listEnvCredentials().catch(() => ({ items: [] as EnvCredentialPathDto[] })),
        adminApi.listAccessPaths().catch(() => ({ items: [] as AccessPathDto[] })),
        adminApi.listCapabilities(),
        adminApi.getRedactionRules().catch(() => null),
      ]);
      setSettings(sRes.items);
      setProviders(pRes.items);
      setCredentials(cRes.items);
      setEnvCredentials(eRes.items);
      setAccessPaths(apRes.items);
      setCapabilities(capRes.items);
      if (rRes) setRedactionRules(rRes);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  const availability = useMemo(
    () =>
      computeModelAvailability({
        providers,
        credentials,
        envCredentials,
        accessPaths,
        capabilities,
        modalityFilter: 'chat',
      }),
    [providers, credentials, envCredentials, accessPaths, capabilities],
  );

  const settingsMap = useMemo(() => new Map(settings.map((s) => [s.id, s])), [settings]);
  const detectJs = String(settingsMap.get('agent_redaction_detect_js')?.value ?? '');
  const placeholder =
    redactionRules?.placeholder ||
    String(settingsMap.get('agent_redaction_placeholder')?.value ?? '<redacted_key>');
  const persistEnabled = Boolean(settingsMap.get('agent_persist_messages')?.value);
  const streamEnabled = settingsMap.get('agent_stream')?.value !== false;

  const currentModelOption = useMemo(() => {
    const savedModel = String(settingsMap.get('agent_model')?.value ?? '');
    const savedAccessPath = String(settingsMap.get('agent_access_path')?.value ?? '');
    return (
      availability.options.find(
        (o) => o.model === savedModel && o.accessPath === savedAccessPath,
      ) ??
      availability.options.find((o) => o.model === savedModel) ??
      availability.options[0]
    );
  }, [availability.options, settingsMap]);

  // 流式过程中自动跟随到底部（若用户未手动上滚）
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  // 实时输入框脱敏检测（97 §2.7 #2）
  const liveRedaction = useMemo(
    () =>
      runClientRedaction(inputText, {
        placeholder,
        builtinRules: redactionRules?.builtin ?? [],
        userRules: redactionRules?.user ?? [],
        detectJs,
      }),
    [inputText, placeholder, redactionRules, detectJs],
  );

  async function handleUpdateSetting(id: string, value: SettingValue) {
    setSavingSettingId(id);
    setError(null);
    try {
      const res = await adminApi.updateSetting(id, value);
      setSettings((prev) => prev.map((item) => (item.id === id ? res.item : item)));
      if (id.startsWith('agent_redaction')) {
        const nextRules = await adminApi.getRedactionRules().catch(() => null);
        if (nextRules) setRedactionRules(nextRules);
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存失败' },
      );
    } finally {
      setSavingSettingId(null);
    }
  }

  async function handleResetSetting(id: string) {
    setSavingSettingId(id);
    setError(null);
    try {
      const res = await adminApi.resetSetting(id);
      setSettings((prev) => prev.map((item) => (item.id === id ? res.item : item)));
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '重置失败', message: err instanceof Error ? err.message : '重置失败' },
      );
    } finally {
      setSavingSettingId(null);
    }
  }

  async function sendTurn(rawPrompt: string) {
    const trimmed = rawPrompt.trim();
    if (!trimmed || sending) return;

    const redacted = runClientRedaction(trimmed, {
      placeholder,
      builtinRules: redactionRules?.builtin ?? [],
      userRules: redactionRules?.user ?? [],
      detectJs,
    });

    const turnId = `turn_${Date.now()}`;
    const savedModel = String(settingsMap.get('agent_model')?.value ?? '');
    const savedAccessPath = String(settingsMap.get('agent_access_path')?.value ?? '');

    // 选择当前生效且可用的模型
    const activeOpt =
      availability.options.find(
        (o) => o.model === savedModel && o.accessPath === savedAccessPath,
      ) ??
      availability.options.find((o) => o.model === savedModel) ??
      availability.options[0];

    const targetModel = activeOpt?.model ?? savedModel;
    const targetAccessPath = activeOpt?.accessPath ?? savedAccessPath;

    const historyMessages: AgentChatMessage[] = [];
    for (const t of turns) {
      if (t.status === 'done') {
        historyMessages.push({ role: 'user', content: t.userText });
        historyMessages.push({ role: 'assistant', content: t.reply });
      }
    }
    historyMessages.push({ role: 'user', content: redacted.redactedText });

    const newTurn: ConversationTurn = {
      id: turnId,
      userText: redacted.redactedText,
      redactedCount: redacted.hitCount,
      reply: '',
      model: targetModel,
      startedAtMs: Date.now(),
      toolCalls: [],
      secrets: [],
      status: 'streaming',
    };

    autoScrollRef.current = true;
    setTurns((prev) => [...prev, newTurn]);
    setInputText('');
    setSending(true);
    setError(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const finalRes = await adminApi.sendChatTurn(
        {
          messages: historyMessages,
          model: targetModel,
          access_path: targetAccessPath,
          stream: streamEnabled,
        },
        {
          signal: ac.signal,
          onTextDelta: (delta) => {
            setTurns((prev) =>
              prev.map((t) => (t.id === turnId ? { ...t, reply: t.reply + delta } : t)),
            );
          },
          onReasoningDelta: (delta) => {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === turnId ? { ...t, reasoning: (t.reasoning ?? '') + delta } : t,
              ),
            );
          },
          onToolCall: (call) => {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === turnId
                  ? {
                      ...t,
                      toolCalls: t.toolCalls.some((c) => c.id === call.id)
                        ? t.toolCalls
                        : [...t.toolCalls, call],
                    }
                  : t,
              ),
            );
          },
          onSecret: (sec) => {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === turnId ? { ...t, secrets: [...t.secrets, sec] } : t,
              ),
            );
          },
        },
      );

      setTurns((prev) =>
        prev.map((t) =>
          t.id === turnId
            ? {
                ...t,
                reply: finalRes.reply,
                model: finalRes.model || targetModel,
                toolCalls: finalRes.tool_calls ?? t.toolCalls,
                secrets: finalRes.secrets ?? t.secrets,
                ...(finalRes.reasoning ? { reasoning: finalRes.reasoning } : {}),
                ...(finalRes.duration_ms !== undefined
                  ? { durationMs: finalRes.duration_ms }
                  : {}),
                ...(finalRes.usage ? { usage: finalRes.usage } : {}),
                status: finalRes.ok ? 'done' : 'error',
                ...(finalRes.error ? { errorMessage: finalRes.error } : {}),
              }
            : t,
        ),
      );

      // 若本轮工具创建了新渠道或新密钥，刷新上下文
      if ((finalRes.tool_calls?.length ?? 0) > 0) {
        void loadContext();
      }
    } catch (err) {
      if (ac.signal.aborted) {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, status: 'aborted' } : t)),
        );
      } else {
        const msg = err instanceof Error ? err.message : '对话请求未完成';
        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId ? { ...t, status: 'error', errorMessage: msg } : t,
          ),
        );
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  async function handleSavePromptedCredential() {
    if (!credPromptTarget || !credSecretInput.trim()) return;
    setCredSaving(true);
    try {
      const secret = credSecretInput.trim(); // privacy-scan: ignore —— 弹窗录入直接进凭据端点
      if (credPromptTarget.replaceExisting) {
        const existing = await adminApi.listCredentials(credPromptTarget.provider);
        const pathSet = new Set(credPromptTarget.accessPaths);
        for (const cred of existing.items) {
          if (cred.provider === credPromptTarget.provider && pathSet.has(cred.access_path)) {
            await adminApi.deleteCredential(cred.id);
          }
        }
      }
      for (const accessPath of credPromptTarget.accessPaths) {
        await adminApi.createCredential({
          provider: credPromptTarget.provider,
          access_path: accessPath,
          secret, // privacy-scan: ignore —— 弹窗录入直接进凭据端点
        });
      }
      setCredPromptTarget(null);
      setCredSecretInput('');
      await loadContext();
    } catch (err) {
      setError({
        category: '录入失败',
        message: err instanceof Error ? err.message : '凭据保存未成功',
      });
    } finally {
      setCredSaving(false);
    }
  }

  async function handleConfirmDeleteTool(callId: string, pending: PendingDeleteAction) {
    setConfirmingDeleteId(callId);
    setError(null);
    try {
      switch (pending.action) {
        case 'delete_provider':
          await adminApi.deleteProvider(pending.resource_id, {
            cascade_credentials: pending.cascade_credentials !== false,
          });
          break;
        case 'delete_credential':
          await adminApi.deleteCredential(pending.resource_id);
          break;
        case 'delete_alias':
          await adminApi.deleteAlias(pending.resource_id);
          break;
        case 'delete_virtual_key':
          await adminApi.deleteVirtualKey(pending.resource_id);
          break;
        case 'delete_route_graph':
          await adminApi.deleteRouteGraph(pending.resource_id);
          break;
      }
      setDeleteStates((prev) => ({ ...prev, [callId]: 'deleted' }));
      await loadContext();
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '删除失败', message: err instanceof Error ? err.message : '删除失败' },
      );
    } finally {
      setConfirmingDeleteId(null);
    }
  }

  function handleCancelDeleteTool(callId: string) {
    setDeleteStates((prev) => ({ ...prev, [callId]: 'cancelled' }));
  }

  return (
    <div className="ag-playground">
      {/* 中间对话工作区 */}
      <div className="ag-chat-center">
        <div className="ag-chat-topbar">
          <div className="ag-chat-title-group">
            <strong style={{ fontSize: 16, whiteSpace: 'nowrap' }}>内置助手</strong>
            <StatusBadge tone={currentModelOption ? 'info' : 'warning'}>
              {currentModelOption
                ? `${currentModelOption.model} (${currentModelOption.providerLabel})`
                : '无可用模型'}
            </StatusBadge>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => setShowHistoryModal(true)}
              title="会话记录"
            >
              记录
            </button>
            {turns.length > 0 && (
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => setConfirmClearOpen(true)}
                title="清空当前会话"
              >
                清空
              </button>
            )}
            <button
              type="button"
              className={`ag-btn ag-btn-sm ag-icon-btn${showRightPanel ? ' is-active' : ''}`}
              onClick={() => setShowRightPanel((v) => !v)}
              aria-label={showRightPanel ? '收起运行设置' : '展开运行设置'}
              title={showRightPanel ? '收起运行设置' : '展开运行设置'}
            >
              <span className="ag-hamburger" aria-hidden="true">
                <span className="ag-hamburger-line" />
                <span className="ag-hamburger-line" />
                <span className="ag-hamburger-line" />
              </span>
            </button>
          </div>
        </div>

        <div
          className="ag-chat-scroll"
          ref={scrollContainerRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            autoScrollRef.current = distanceToBottom < 64;
          }}
        >
          <ErrorBanner error={error} onDismiss={() => setError(null)} />

          {turns.length === 0 ? (
            <div
              style={{
                margin: 'auto',
                maxWidth: 640,
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
                padding: '32px 0',
              }}
            >
              <div>
                <h1 className="ag-page-title">用自然语言管理网关</h1>
              </div>

              <div className="ag-grid-3">
                {STARTER_PROMPTS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    className="ag-card"
                    style={{
                      textAlign: 'left',
                      padding: 18,
                      cursor: 'pointer',
                      gap: 8,
                    }}
                    onClick={() => void sendTurn(item.prompt)}
                  >
                    <strong style={{ fontSize: 14 }}>{item.title}</strong>
                    <span className="ag-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                      {item.prompt}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                sending={sending}
                deleteStates={deleteStates}
                confirmingDeleteId={confirmingDeleteId}
                onConfirmDelete={handleConfirmDeleteTool}
                onCancelDelete={handleCancelDeleteTool}
                onRetry={(prompt) => void sendTurn(prompt)}
                onOpenCredentialModal={(provider, accessPaths, replaceExisting) => {
                  setCredPromptTarget({ provider, accessPaths, replaceExisting });
                  setCredSecretInput('');
                }}
              />
            ))
          )}
        </div>

        {/* 底部常驻输入栏 + 实时敏感串高亮提示（97 §2.7 #2 & §4.5） */}
        <div className="ag-chat-composer-bar">
          {liveRedaction.hitCount > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                borderRadius: 'var(--ag-radius-sm)',
                background: 'var(--ag-warning-bg)',
                border: '1px solid var(--ag-warning-border)',
                color: 'var(--ag-warning)',
                fontSize: 12,
              }}
            >
              {/* ui-copy: allow 输入框检测到密钥串时的实时脱敏预览提示（97 §2.7 #2 硬要求） */}
              <span>
                检测到 {liveRedaction.hitCount} 处敏感串，将以{' '}
                <code className="ag-mono">{placeholder}</code> 发送
              </span>
              <span className="ag-mono" style={{ maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                预览：{liveRedaction.redactedText}
              </span>
            </div>
          )}

          <form
            style={{ display: 'flex', gap: 10, alignItems: 'center' }}
            onSubmit={(e) => {
              e.preventDefault();
              void sendTurn(inputText);
            }}
          >
            <textarea
              className="ag-textarea"
              rows={2}
              value={inputText}
              placeholder="输入管理指令…"
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendTurn(inputText);
                }
              }}
            />
            {sending ? (
              <button
                type="button"
                className="ag-btn ag-btn-danger"
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                onClick={() => abortRef.current?.abort()}
              >
                停止
              </button>
            ) : (
              <button
                type="submit"
                className="ag-btn ag-btn-primary"
                style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                disabled={!inputText.trim() || availability.options.length === 0}
              >
                发送
              </button>
            )}
          </form>
        </div>
      </div>

      {showRightPanel && (
        <div
          className="ag-run-panel-backdrop"
          aria-hidden="true"
          onClick={() => setShowRightPanel(false)}
        />
      )}

      {/* 右侧运行设置面板（与系统设置同源同状态，97 §2.6 #3 & §4.5） */}
      <div
        className={`ag-run-panel-wrap${showRightPanel ? ' is-open' : ''}`}
        aria-hidden={!showRightPanel}
      >
        <AgentRunPanel
          settings={settings}
          availability={availability}
          savingId={savingSettingId}
          onUpdateSetting={handleUpdateSetting}
          onResetSetting={handleResetSetting}
        />
      </div>

      {/* 会话历史弹窗（97 §2.7 #6：未开启留存时明确告知并给去开启主操作） */}
      <Modal
        open={showHistoryModal}
        title="会话记录"
        onClose={() => setShowHistoryModal(false)}
      >
        {!persistEnabled ? (
          <div className="ag-empty">
            <p className="ag-empty-text">未开启会话留存</p>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              onClick={async () => {
                await handleUpdateSetting('agent_persist_messages', true);
                setShowHistoryModal(false);
              }}
            >
              开启会话留存
            </button>
          </div>
        ) : turns.length === 0 ? (
          <div className="ag-empty">
            <p className="ag-empty-text">当前尚无对话回合</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {turns.map((t, idx) => (
              <div
                key={t.id}
                style={{
                  padding: 12,
                  borderRadius: 'var(--ag-radius-sm)',
                  border: '1px solid var(--ag-border)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>
                    #{idx + 1} · {t.userText.slice(0, 48)}
                  </div>
                  <div className="ag-secondary ag-mono">{t.model}</div>
                </div>
                <StatusBadge tone={t.status === 'done' ? 'success' : 'warning'}>
                  {t.toolCalls.length} 次工具调用
                </StatusBadge>
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* 清空对话二次确认（97 §2.7 #6 & §5 #13） */}
      <ConfirmModal
        open={confirmClearOpen}
        title="清空当前会话"
        // ui-copy: allow 清空会话二次确认的后果说明（97 §2.7 #6 & §5 #13）
        consequence="清空后当前视图中的对话上下文将被移除。"
        confirmLabel="确认清空"
        onConfirm={() => {
          setTurns([]);
          setDeleteStates({});
          sessionTurnsCache = [];
          sessionDeleteStates = {};
          setConfirmClearOpen(false);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />

      {/* 「需要凭据」独立录入弹窗（97 §2.7 #3：不经由对话上下文） */}
      <Modal
        open={credPromptTarget !== null}
        title={`${credPromptTarget?.replaceExisting ? '更换凭据' : '录入凭据'} · ${credPromptTarget?.provider ?? ''}`}
        onClose={() => setCredPromptTarget(null)}
        footer={
          <>
            <button
              type="button"
              className="ag-btn"
              onClick={() => setCredPromptTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              disabled={!credSecretInput.trim() || credSaving}
              onClick={() => void handleSavePromptedCredential()}
            >
              {credSaving ? '加密保存中…' : credPromptTarget?.replaceExisting ? '级联更换凭据' : '保存至凭据库'}
            </button>
          </>
        }
      >
        <div className="ag-field">
          <label className="ag-field-label">
            {credPromptTarget && credPromptTarget.accessPaths.length > 1
              ? `接入路径（级联 ${credPromptTarget.accessPaths.length} 条）`
              : '接入路径'}
          </label>
          <input
            className="ag-input ag-mono"
            value={credPromptTarget?.accessPaths.join('、') ?? ''}
            disabled
          />
        </div>
        <div className="ag-field">
          <label className="ag-field-label">上游 API Key</label>
          <input
            type="password"
            className="ag-input ag-mono"
            value={credSecretInput}
            onChange={(e) => setCredSecretInput(e.target.value)}
            placeholder="输入上游 API Key"
            autoFocus
          />
        </div>
      </Modal>
    </div>
  );
}

function TurnView({
  turn,
  sending,
  deleteStates,
  confirmingDeleteId,
  onConfirmDelete,
  onCancelDelete,
  onRetry,
  onOpenCredentialModal,
}: {
  turn: ConversationTurn;
  sending: boolean;
  deleteStates: Record<string, 'deleted' | 'cancelled'>;
  confirmingDeleteId: string | null;
  onConfirmDelete: (callId: string, pending: PendingDeleteAction) => void;
  onCancelDelete: (callId: string) => void;
  onRetry: (prompt: string) => void;
  onOpenCredentialModal: (provider: string, accessPaths: string[], replaceExisting: boolean) => void;
}): React.JSX.Element {
  const [thinkingExpanded, setThinkingExpanded] = useState<boolean | null>(null);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [copiedReply, setCopiedReply] = useState<boolean>(false);
  const [liveElapsedMs, setLiveElapsedMs] = useState<number>(0);

  useEffect(() => {
    if (turn.status !== 'streaming' || turn.startedAtMs === undefined) return;
    const start = turn.startedAtMs;
    const timer = setInterval(() => {
      setLiveElapsedMs(Math.max(0, Date.now() - start));
    }, 100);
    return () => clearInterval(timer);
  }, [turn.status, turn.startedAtMs]);

  const isThinkingOpen =
    thinkingExpanded !== null
      ? thinkingExpanded
      : turn.status === 'streaming' && turn.reply === '';

  function toggleToolExpand(id: string) {
    setExpandedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCopyReply() {
    if (!turn.reply) return;
    void navigator.clipboard?.writeText(turn.reply);
    setCopiedReply(true);
    setTimeout(() => setCopiedReply(false), 1500);
  }

  return (
    <div className="ag-msg-enter" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 用户消息 */}
      <div
        style={{
          alignSelf: 'flex-end',
          maxWidth: '78%',
          padding: '10px 16px',
          borderRadius: 'var(--ag-radius-md)',
          background: 'var(--ag-accent-subtle)',
          border: '1px solid var(--ag-accent-border)',
          color: 'var(--ag-text)',
        }}
      >
        <div style={{ whiteSpace: 'pre-wrap' }}>{turn.userText}</div>
        {turn.redactedCount > 0 && (
          <div className="ag-secondary" style={{ fontSize: 11, marginTop: 4 }}>
            已替换 {turn.redactedCount} 处敏感串
          </div>
        )}
      </div>

      {/* 助手回合卡片 */}
      <div className="ag-card" style={{ gap: 14 }}>
        {/* 1. 回合顶部过程条（耗时 / 工具数 / 状态，97 §2.7 #5） */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            paddingBottom: 10,
            borderBottom: '1px solid var(--ag-border)',
            fontSize: 13,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="ag-mono" style={{ fontWeight: 600 }}>
              {turn.model || '助手'}
            </span>
            {turn.status === 'streaming' && <StatusBadge tone="info">生成中</StatusBadge>}
            {turn.status === 'done' && <StatusBadge tone="success">完成</StatusBadge>}
            {turn.status === 'error' && <StatusBadge tone="danger">执行失败</StatusBadge>}
            {turn.status === 'aborted' && <StatusBadge tone="warning">已停止</StatusBadge>}
          </div>
          <div
            className="ag-secondary ag-tabular"
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            {turn.toolCalls.length > 0 && <span>工具 {turn.toolCalls.length} 次</span>}
            {turn.durationMs !== undefined ? (
              <span>耗时 {formatDurationMs(turn.durationMs)}</span>
            ) : (
              turn.status === 'streaming' &&
              liveElapsedMs > 0 && <span>耗时 {formatDurationMs(liveElapsedMs)}</span>
            )}
            {turn.reply && (
              <button type="button" className="ag-btn ag-btn-sm" onClick={handleCopyReply}>
                {copiedReply ? '已复制' : '复制'}
              </button>
            )}
            {turn.status !== 'streaming' && (
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                disabled={sending}
                onClick={() => onRetry(turn.userText)}
              >
                重试
              </button>
            )}
          </div>
        </div>

        {/* 2. 思考过程折叠行（97 §2.7 #4：上游不给思考内容时整行不渲染！） */}
        {turn.reasoning !== undefined && turn.reasoning !== '' && (
          <div
            style={{
              borderRadius: 'var(--ag-radius-sm)',
              border: '1px solid var(--ag-border)',
              background: 'var(--ag-surface-raised)',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                background: 'transparent',
                color: 'var(--ag-text-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                fontSize: 13,
              }}
              onClick={() => setThinkingExpanded(!isThinkingOpen)}
            >
              <span>
                思考过程 · {turn.reasoning.replace(/\s+/g, ' ').slice(0, 42)}
                {turn.reasoning.length > 42 ? '…' : ''}
              </span>
              <span>{isThinkingOpen ? '收起 ▲' : '展开 ▼'}</span>
            </button>
            <div className={`ag-collapse${isThinkingOpen ? ' is-open' : ''}`}>
              <div className="ag-collapse-inner">
                <div
                  style={{
                    padding: '10px 12px',
                    borderTop: '1px solid var(--ag-border)',
                    whiteSpace: 'pre-wrap',
                    fontSize: 13,
                    color: 'var(--ag-text-secondary)',
                  }}
                >
                  {turn.reasoning}
                  {turn.status === 'streaming' && turn.reply === '' && (
                    <span className="ag-stream-cursor" aria-hidden="true" />
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 3. 工具调用可视化列表（97 §2.7 #1 & #3） */}
        {turn.toolCalls.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {turn.toolCalls.map((call) => {
              const expanded = expandedToolIds.has(call.id);
              let needsCredInfo: {
                provider: string;
                accessPaths: string[];
                replaceExisting: boolean;
              } | null = null;
              let pendingDelete: PendingDeleteAction | null = null;
              if (call.result?.text) {
                try {
                  const parsed = JSON.parse(call.result.text) as Record<string, unknown>;
                  if (
                    parsed['status'] === 'needs_credential' &&
                    typeof parsed['provider'] === 'string' &&
                    typeof parsed['access_path'] === 'string'
                  ) {
                    const rawPaths = Array.isArray(parsed['access_paths'])
                      ? parsed['access_paths'].filter(
                          (x): x is string => typeof x === 'string' && x.trim() !== '',
                        )
                      : [];
                    needsCredInfo = {
                      provider: parsed['provider'],
                      accessPaths: rawPaths.length > 0 ? rawPaths : [parsed['access_path']],
                      replaceExisting: parsed['replace_existing'] === true,
                    };
                  } else if (
                    parsed['status'] === 'pending_confirmation' &&
                    typeof parsed['action'] === 'string' &&
                    typeof parsed['resource_id'] === 'string'
                  ) {
                    pendingDelete = {
                      action: parsed['action'] as PendingDeleteAction['action'],
                      resource_id: parsed['resource_id'],
                      label:
                        typeof parsed['label'] === 'string'
                          ? parsed['label']
                          : parsed['resource_id'],
                      detail:
                        typeof parsed['detail'] === 'string'
                          ? parsed['detail']
                          : `将删除 ${parsed['resource_id']}`,
                      ...(typeof parsed['cascade_credentials'] === 'boolean'
                        ? { cascade_credentials: parsed['cascade_credentials'] }
                        : {}),
                    };
                  }
                } catch {
                  // 非 JSON
                }
              }
              const deleteState = deleteStates[call.id];
              const isConfirming = confirmingDeleteId === call.id;

              return (
                <div
                  key={call.id}
                  style={{
                    borderRadius: 'var(--ag-radius-sm)',
                    border: `1px solid ${call.is_error ? 'var(--ag-danger-border)' : 'var(--ag-border)'}`,
                    background: call.is_error
                      ? 'var(--ag-danger-bg)'
                      : 'var(--ag-surface-raised)',
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
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
                      <span className="ag-mono" style={{ fontWeight: 600 }}>
                        {call.name}
                      </span>
                      {call.is_error ? (
                        <StatusBadge tone="danger">调用出错</StatusBadge>
                      ) : call.result?.status === 'needs_credential' ? (
                        <StatusBadge tone="warning">待录凭据</StatusBadge>
                      ) : pendingDelete ? (
                        deleteState === 'deleted' ? (
                          <StatusBadge tone="success">已确认删除</StatusBadge>
                        ) : deleteState === 'cancelled' ? (
                          <StatusBadge tone="neutral">已取消</StatusBadge>
                        ) : (
                          <StatusBadge tone="warning">待确认删除</StatusBadge>
                        )
                      ) : (
                        <StatusBadge tone="success">已执行</StatusBadge>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {needsCredInfo && (
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm ag-btn-primary"
                          onClick={() =>
                            onOpenCredentialModal(
                              needsCredInfo!.provider,
                              needsCredInfo!.accessPaths,
                              needsCredInfo!.replaceExisting,
                            )
                          }
                        >
                          {needsCredInfo.replaceExisting ? '更换凭据' : '录入凭据'}
                        </button>
                      )}
                      {pendingDelete && !deleteState && (
                        <>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            disabled={isConfirming}
                            onClick={() => onCancelDelete(call.id)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm ag-btn-danger"
                            disabled={isConfirming}
                            onClick={() => onConfirmDelete(call.id, pendingDelete!)}
                          >
                            {isConfirming ? '删除中…' : '确认删除'}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="ag-btn ag-btn-sm"
                        onClick={() => toggleToolExpand(call.id)}
                      >
                        {expanded ? '收起参数' : '查看参数'}
                      </button>
                    </div>
                  </div>
                  {pendingDelete && (
                    <div style={{ fontSize: 12, color: 'var(--ag-text-secondary)' }}>
                      <strong style={{ color: 'var(--ag-text)' }}>{pendingDelete.label}</strong>
                      {' · '}
                      {pendingDelete.detail}
                    </div>
                  )}

                  <div className={`ag-collapse${expanded ? ' is-open' : ''}`}>
                    <div className="ag-collapse-inner">
                      <div
                        className="ag-mono"
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          fontSize: 12,
                          paddingTop: 6,
                          borderTop: '1px solid var(--ag-border)',
                        }}
                      >
                        <div>入参: {JSON.stringify(call.arguments)}</div>
                        {call.result && <div>结果: {call.result.text}</div>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 4. 单次明文密钥披露卡（create_virtual_key 旁路披露，不进模型上下文） */}
        {turn.secrets.map((sec) => (
          <div
            key={sec.key_id}
            style={{
              padding: 12,
              borderRadius: 'var(--ag-radius-sm)',
              border: '1px solid var(--ag-success-border)',
              background: 'var(--ag-success-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>
                新密钥 · {sec.name}（单次展示）
              </div>
              <div className="ag-mono" style={{ marginTop: 4 }}>
                {sec.plaintext}
              </div>
            </div>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => void navigator.clipboard?.writeText(sec.plaintext)}
            >
              复制明文
            </button>
          </div>
        ))}

        {/* 5. 助手正文（GFM Markdown 实时流式排版） */}
        {turn.errorMessage ? (
          <div style={{ color: 'var(--ag-danger)', fontWeight: 500 }}>
            {turn.errorMessage}
          </div>
        ) : turn.reply ? (
          <MarkdownView content={turn.reply} streaming={turn.status === 'streaming'} />
        ) : turn.status === 'streaming' ? (
          <div className="ag-secondary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>思考与执行中…</span>
            <span className="ag-stream-cursor" aria-hidden="true" />
          </div>
        ) : null}

        {/* 6. Token 用量分桶行（97 §2.7 #5：有才渲染） */}
        {turn.usage && (
          <div
            className="ag-secondary ag-tabular"
            style={{
              paddingTop: 8,
              borderTop: '1px solid var(--ag-border)',
              display: 'flex',
              gap: 14,
              fontSize: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>输入 {formatInt(turn.usage.input_tokens)}</span>
            <span>输出 {formatInt(turn.usage.output_tokens)}</span>
            {turn.usage.reasoning_tokens !== undefined && (
              <span>思考 {formatInt(turn.usage.reasoning_tokens)}</span>
            )}
            <span>合计 {formatInt(turn.usage.total_tokens)} Token</span>
            {turn.durationMs !== undefined &&
              turn.durationMs > 0 &&
              turn.usage.output_tokens > 0 && (
                <span>
                  速率 {((turn.usage.output_tokens / turn.durationMs) * 1000).toFixed(1)} tok/s
                </span>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
