import type {
  AccessPathDto,
  AgentChatMessage,
  AgentChatResponse,
  AgentSecretDisclosure,
  AgentToolCallView,
  AliasResolveResponse,
  AliasRuleDto,
  AliasUpsertRequest,
  AuditLogEntry,
  AuthModeResponse,
  BalanceProbeResponse,
  BootstrapResponse,
  CapabilityMatrixEntry,
  CredentialCreateRequest,
  CredentialProbeResponse,
  EnvCredentialPathDto,
  KeystoreStatusResponse,
  LoginRequest,
  LoginResponse,
  MaskedCredential,
  ModelsDevSyncResponse,
  Page,
  PluginInfoDto,
  PluginsListResponse,
  PluginUpdateRequest,
  ProviderConfig,
  ProviderModelsErrorCode,
  ProviderModelsFailure,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderPreset,
  ProviderUpsertRequest,
  RedactionRulesResponse,
  RouteGraphDto,
  RouteGraphSimulateRequest,
  RouteGraphSimulateResponse,
  RouteGraphUpsertRequest,
  RoutingTelemetryResponse,
  SecretRefDto,
  SettingDto,
  SettingsListResponse,
  SettingValue,
  SyncTriggerResponse,
  UpstreamModelDto,
  UsageDashboardResponse,
  UsageTimeseriesResponse,
  VirtualKeyCreateRequest,
  VirtualKeyDto,
  VirtualKeyUpdateRequest,
  VirtualKeyUsage,
} from './types.js';
import type { RouteId } from '../router.js';

/**
 * 会话令牌只存在内存，不存 localStorage（97 §4.3：会话令牌不存本地）。
 */
let sessionToken: string | null = null;
let onUnauthorizedCallback: (() => void) | null = null;

export function setSessionToken(
  token: string | null, // privacy-scan: ignore —— 函数形参类型声明，无实际值
): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export function setOnUnauthorized(cb: (() => void) | null): void {
  onUnauthorizedCallback = cb;
}

export interface ActionableError {
  category: string;
  message: string;
  actionLabel?: string;
  actionRoute?: RouteId;
  detail?: string;
}

/**
 * 错误分类与可操作建议（97 §5 #10：按失败原因分类，每类一条动作，不露密钥）。
 */
export function classifyErrorCode(
  code: string | undefined,
  message: string,
  detail?: string,
): ActionableError {
  switch (code as ProviderModelsErrorCode | string) {
    case 'unauthorized':
      return {
        category: '认证失效',
        message: message || '会话已过期',
        actionLabel: '重新登录',
        detail,
      };
    case 'key_invalid':
      return {
        category: '凭据无效',
        message: message || '上游拒绝了该密钥',
        actionLabel: '去管凭据',
        actionRoute: 'channels',
        detail,
      };
    case 'credential_missing':
      return {
        category: '缺少凭据',
        message: message || '该渠道未录入可用凭据',
        actionLabel: '去录凭据',
        actionRoute: 'channels',
        detail,
      };
    case 'endpoint_unsupported':
      return {
        category: '端点不支持',
        message: message || '上游未提供模型列表端点',
        detail,
      };
    case 'rate_limited':
      return {
        category: '上游限流',
        message: message || '请求触发上游速率限制',
        detail,
      };
    case 'upstream_error':
      return {
        category: '上游故障',
        message: message || '上游服务返回异常状态',
        detail,
      };
    case 'network_error':
      return {
        category: '网络不通',
        message: message || '上游网络未连通',
        detail,
      };
    case 'env_locked':
      return {
        category: '环境锁定',
        message: message || '该项已由环境变量锁定',
        detail,
      };
    default:
      return {
        category: '请求失败',
        message: message || '请求未完成',
        detail,
      };
  }
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly actionable: ActionableError;

  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.actionable = classifyErrorCode(code, message, detail);
  }
}

async function requestJson<T>(
  path: string,
  init?: RequestInit & { allowUnauthorized?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  if (sessionToken) {
    headers['authorization'] = `Bearer ${sessionToken}`;
  }
  const res = await fetch(`/admin/api/${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (res.status === 401 && !init?.allowUnauthorized) {
    sessionToken = null;
    onUnauthorizedCallback?.();
  }

  const text = await res.text();
  let parsed: unknown = {};
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new ApiRequestError(res.status, 'invalid_json', `响应非 JSON (${res.status})`);
    }
  }

  if (!res.ok) {
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const errObj = obj['error'] as Record<string, unknown> | string | undefined;
    if (typeof errObj === 'object' && errObj !== null) {
      const code = typeof errObj['code'] === 'string' ? errObj['code'] : `http_${res.status}`;
      const msg = typeof errObj['message'] === 'string' ? errObj['message'] : `HTTP ${res.status}`;
      const detail = typeof errObj['detail'] === 'string' ? errObj['detail'] : undefined;
      throw new ApiRequestError(res.status, code, msg, detail);
    }
    const msg =
      typeof errObj === 'string'
        ? errObj
        : typeof obj['message'] === 'string'
          ? obj['message']
          : `HTTP ${res.status}`;
    throw new ApiRequestError(res.status, `http_${res.status}`, msg);
  }

  return parsed as T;
}

export const adminApi = {
  bootstrap(): Promise<BootstrapResponse> {
    return requestJson<BootstrapResponse>('bootstrap', { allowUnauthorized: true });
  },

  async login(input: LoginRequest): Promise<LoginResponse> {
    const res = await requestJson<LoginResponse>('login', {
      method: 'POST',
      body: JSON.stringify(input),
      allowUnauthorized: true,
    });
    if (res.ok && res.token) {
      setSessionToken(res.token);
    }
    return res;
  },

  async logout(): Promise<void> {
    try {
      await requestJson<{ ok: boolean }>('logout', {
        method: 'POST',
        allowUnauthorized: true,
      });
    } finally {
      setSessionToken(null);
    }
  },

  // ---- 渠道与服务商预设 ----
  listProviders(): Promise<Page<ProviderConfig>> {
    return requestJson<Page<ProviderConfig>>('providers');
  },

  upsertProvider(
    body: ProviderUpsertRequest,
  ): Promise<{ ok: boolean; provider?: ProviderConfig; error?: string }> {
    return requestJson('providers', { method: 'POST', body: JSON.stringify(body) });
  },

  deleteProvider(
    id: string,
    opts?: { cascade_credentials?: boolean },
  ): Promise<{ ok: boolean; deleted: boolean; deleted_credentials?: string[] }> {
    const query =
      opts?.cascade_credentials === false ? '?cascade_credentials=false' : '';
    return requestJson(`providers/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  },

  batchProviders(
    ids: string[],
    action: 'enable' | 'disable' | 'delete',
    opts?: { cascade_credentials?: boolean },
  ): Promise<{
    ok: boolean;
    changed: string[];
    failed: Array<{ id: string; error: string }>;
    deleted_credentials?: string[];
  }> {
    return requestJson('providers/batch', {
      method: 'POST',
      body: JSON.stringify({
        ids,
        action,
        ...(opts?.cascade_credentials === undefined
          ? {}
          : { cascade_credentials: opts.cascade_credentials }),
      }),
    });
  },

  copyProvider(
    id: string,
    body: { new_id?: string; label?: string },
  ): Promise<{ ok: boolean; provider?: ProviderConfig }> {
    return requestJson(`providers/${encodeURIComponent(id)}/copy`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async testProvider(id: string): Promise<{
    ok: boolean;
    provider_id: string;
    code?: string;
    message?: string;
    upstream_status?: number;
    checked_at: number;
  }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (sessionToken) headers['authorization'] = `Bearer ${sessionToken}`;
    const res = await fetch(`/admin/api/providers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers,
    });
    return (await res.json()) as {
      ok: boolean;
      provider_id: string;
      code?: string;
      message?: string;
      upstream_status?: number;
      checked_at: number;
    };
  },

  listProviderPresets(): Promise<{ items: ProviderPreset[]; total: number }> {
    return requestJson('provider-presets');
  },

  async fetchProviderModels(
    body: ProviderModelsRequest,
  ): Promise<ProviderModelsResponse | ProviderModelsFailure> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (sessionToken) headers['authorization'] = `Bearer ${sessionToken}`;
    const res = await fetch('/admin/api/provider-models', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return (await res.json()) as ProviderModelsResponse | ProviderModelsFailure;
  },

  async syncModelsDev(models: UpstreamModelDto[]): Promise<ModelsDevSyncResponse> {
    return requestJson<ModelsDevSyncResponse>('models-dev/sync', {
      method: 'POST',
      body: JSON.stringify({ models }),
    });
  },

  listAccessPaths(): Promise<{ items: AccessPathDto[] }> {
    return requestJson('access-paths');
  },

  // ---- 别名 ----
  listAliases(): Promise<{ items: AliasRuleDto[]; total: number }> {
    return requestJson('aliases');
  },

  upsertAlias(body: AliasUpsertRequest): Promise<{ ok: boolean; rule?: AliasRuleDto }> {
    return requestJson('aliases', { method: 'POST', body: JSON.stringify(body) });
  },

  deleteAlias(id: string): Promise<{ ok: boolean; deleted: boolean }> {
    return requestJson(`aliases/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  resolveAlias(model: string): Promise<AliasResolveResponse> {
    return requestJson('aliases/resolve', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
  },

  // ---- 模型目录与同步 ----
  listCapabilities(params?: {
    all?: boolean;
    modality?: string;
    status?: string;
  }): Promise<{ items: CapabilityMatrixEntry[]; total: number }> {
    const sp = new URLSearchParams();
    if (params?.all) sp.set('all', '1');
    if (params?.modality) sp.set('modality', params.modality);
    if (params?.status) sp.set('status', params.status);
    const qs = sp.toString();
    return requestJson(`capabilities${qs ? `?${qs}` : ''}`);
  },

  setModelExposed(
    model: string,
    exposed: boolean,
  ): Promise<{ ok: boolean; model: string; exposed: boolean }> {
    return requestJson('capabilities/visibility', {
      method: 'POST',
      body: JSON.stringify({ model, exposed }),
    });
  },

  triggerSync(
    kind: 'upstream_discovery' | 'offline_catalog_refresh' = 'upstream_discovery',
  ): Promise<SyncTriggerResponse> {
    return requestJson('sync', { method: 'POST', body: JSON.stringify({ kind }) });
  },

  // ---- 用量与余额 ----
  getUsageDashboard(fromTs?: number, toTs?: number): Promise<UsageDashboardResponse> {
    const sp = new URLSearchParams();
    if (fromTs !== undefined) sp.set('from_ts', String(fromTs));
    if (toTs !== undefined) sp.set('to_ts', String(toTs));
    const qs = sp.toString();
    return requestJson(`usage${qs ? `?${qs}` : ''}`);
  },

  getUsageTimeseries(
    fromTs?: number,
    toTs?: number,
    bucketMs?: number,
  ): Promise<UsageTimeseriesResponse> {
    const sp = new URLSearchParams();
    if (fromTs !== undefined) sp.set('from_ts', String(fromTs));
    if (toTs !== undefined) sp.set('to_ts', String(toTs));
    if (bucketMs !== undefined) sp.set('bucket_ms', String(bucketMs));
    const qs = sp.toString();
    return requestJson(`usage/timeseries${qs ? `?${qs}` : ''}`);
  },

  async probeBalance(): Promise<BalanceProbeResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (sessionToken) headers['authorization'] = `Bearer ${sessionToken}`;
    const res = await fetch('/admin/api/balance/probe', { method: 'POST', headers });
    return (await res.json()) as BalanceProbeResponse;
  },

  // ---- 客户端密钥与访问控制 ----
  getAuthMode(): Promise<AuthModeResponse> {
    return requestJson('auth-mode');
  },

  listVirtualKeys(): Promise<Page<VirtualKeyDto>> {
    return requestJson('virtual-keys');
  },

  createVirtualKey(
    body: VirtualKeyCreateRequest,
  ): Promise<{ ok: boolean; key: VirtualKeyDto; plaintext: string }> {
    return requestJson('virtual-keys', { method: 'POST', body: JSON.stringify(body) });
  },

  revokeVirtualKey(id: string): Promise<{ ok: boolean; key: VirtualKeyDto }> {
    return requestJson(`virtual-keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
  },

  deleteVirtualKey(id: string): Promise<{ ok: boolean; deleted: boolean }> {
    return requestJson(`virtual-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  updateVirtualKey(
    id: string,
    body: VirtualKeyUpdateRequest,
  ): Promise<{ ok: boolean; key: VirtualKeyDto }> {
    return requestJson(`virtual-keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  getVirtualKeyUsage(
    id: string,
    fromTs?: number,
    toTs?: number,
  ): Promise<{ ok: boolean; usage: VirtualKeyUsage }> {
    const sp = new URLSearchParams();
    if (fromTs !== undefined) sp.set('from_ts', String(fromTs));
    if (toTs !== undefined) sp.set('to_ts', String(toTs));
    const qs = sp.toString();
    return requestJson(`virtual-keys/${encodeURIComponent(id)}/usage${qs ? `?${qs}` : ''}`);
  },

  // ---- 系统设置 ----
  listSettings(): Promise<SettingsListResponse> {
    return requestJson('settings');
  },

  updateSetting(id: string, value: SettingValue): Promise<{ ok: boolean; item: SettingDto }> {
    return requestJson(`settings/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  },

  resetSetting(id: string): Promise<{ ok: boolean; item: SettingDto }> {
    return requestJson(`settings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  // ---- 密钥库、引用登记与审计 ----
  getKeystoreStatus(): Promise<KeystoreStatusResponse> {
    return requestJson('keystore/status');
  },

  rotateDek(): Promise<{ ok: boolean; new_dek_id?: string; reencrypted?: number; error?: string }> {
    return requestJson('keystore/rotate-dek', { method: 'POST', body: JSON.stringify({}) });
  },

  rotateKek(
    newPassphrase?: string,
  ): Promise<{ ok: boolean; kek_fingerprint?: string; error?: string }> {
    return requestJson('keystore/rotate-kek', {
      method: 'POST',
      body: JSON.stringify({
        confirm: true,
        ...(newPassphrase ? { new_passphrase: newPassphrase } : {}),
      }),
    });
  },

  listSecretRefs(): Promise<{ items: SecretRefDto[]; total: number }> {
    return requestJson('secret-refs');
  },

  createSecretRef(body: {
    name: string;
    env_var: string;
    note?: string;
  }): Promise<{ ok: boolean; ref: SecretRefDto }> {
    return requestJson('secret-refs', { method: 'POST', body: JSON.stringify(body) });
  },

  deleteSecretRef(name: string): Promise<{ ok: boolean; deleted: boolean }> {
    return requestJson(`secret-refs/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  listAudit(limit = 100, offset = 0): Promise<Page<AuditLogEntry>> {
    return requestJson(`audit?limit=${limit}&offset=${offset}`);
  },

  // ---- 内置对话与脱敏规则 ----
  getRedactionRules(): Promise<RedactionRulesResponse> {
    return requestJson('redaction-rules');
  },

  async sendChatTurn(
    input: {
      messages: AgentChatMessage[];
      stream?: boolean;
      model?: string;
      access_path?: string;
    },
    handlers?: {
      onTextDelta?: (delta: string) => void;
      onReasoningDelta?: (delta: string) => void;
      onToolCall?: (call: AgentToolCallView) => void;
      onSecret?: (item: AgentSecretDisclosure) => void;
      signal?: AbortSignal;
    },
  ): Promise<AgentChatResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
    };
    if (sessionToken) headers['authorization'] = `Bearer ${sessionToken}`;

    const res = await fetch('/admin/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      signal: handlers?.signal,
    });

    if (res.status === 401) {
      sessionToken = null;
      onUnauthorizedCallback?.();
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.includes('text/event-stream')) {
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new ApiRequestError(res.status, 'chat_error', text || `HTTP ${res.status}`);
      }
      if (!res.ok && parsed['error'] && typeof parsed['error'] === 'object') {
        const errObj = parsed['error'] as Record<string, unknown>;
        throw new ApiRequestError(
          res.status,
          typeof errObj['code'] === 'string' ? errObj['code'] : 'chat_error',
          typeof errObj['message'] === 'string' ? errObj['message'] : `HTTP ${res.status}`,
        );
      }
      return parsed as unknown as AgentChatResponse;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new ApiRequestError(500, 'stream_missing', '流式响应不可读');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let accReply = '';
    let accReasoning = '';
    const accTools: AgentToolCallView[] = [];
    const seenToolIds = new Set<string>();
    const accSecrets: AgentSecretDisclosure[] = [];
    let finalAgent: AgentChatResponse | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        let eventName = 'message';
        let dataLine = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine) as Record<string, unknown>;
          if (eventName === 'text' && typeof payload['text'] === 'string') {
            accReply += payload['text'];
            handlers?.onTextDelta?.(payload['text']);
          } else if (eventName === 'reasoning' && typeof payload['reasoning'] === 'string') {
            accReasoning += payload['reasoning'];
            handlers?.onReasoningDelta?.(payload['reasoning']);
          } else if (eventName === 'tool') {
            const toolCall = payload as unknown as AgentToolCallView;
            if (!seenToolIds.has(toolCall.id)) {
              seenToolIds.add(toolCall.id);
              accTools.push(toolCall);
              handlers?.onToolCall?.(toolCall);
            }
          } else if (eventName === 'secret') {
            const sec = payload as unknown as AgentSecretDisclosure;
            accSecrets.push(sec);
            handlers?.onSecret?.(sec);
          } else if (eventName === 'agent') {
            const resolvedReasoning =
              typeof payload['reasoning'] === 'string' && payload['reasoning'] !== ''
                ? payload['reasoning']
                : accReasoning;
            finalAgent = {
              ok: payload['error'] === undefined,
              reply:
                typeof payload['reply'] === 'string' && payload['reply'] !== ''
                  ? payload['reply']
                  : accReply,
              model: typeof payload['model'] === 'string' ? payload['model'] : (input.model ?? ''),
              tool_calls: Array.isArray(payload['tool_calls'])
                ? (payload['tool_calls'] as AgentToolCallView[])
                : accTools,
              secrets: Array.isArray(payload['secrets'])
                ? (payload['secrets'] as AgentSecretDisclosure[])
                : accSecrets,
              ...(resolvedReasoning !== '' ? { reasoning: resolvedReasoning } : {}),
              ...(typeof payload['duration_ms'] === 'number'
                ? { duration_ms: payload['duration_ms'] }
                : {}),
              ...(payload['usage'] && typeof payload['usage'] === 'object'
                ? { usage: payload['usage'] as AgentChatResponse['usage'] }
                : {}),
              ...(typeof payload['error'] === 'string' ? { error: payload['error'] } : {}),
            };
          }
        } catch {
          // 忽略损坏帧
        }
      }
    }

    return (
      finalAgent ?? {
        ok: true,
        reply: accReply,
        model: input.model ?? '',
        tool_calls: accTools,
        secrets: accSecrets,
        ...(accReasoning !== '' ? { reasoning: accReasoning } : {}),
      }
    );
  },

  startDeviceOAuth(provider: 'openai-codex' | 'xai'): Promise<{
    ok: true;
    session_id: string;
    provider: 'openai-codex' | 'xai';
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval_seconds: number;
    expires_in_seconds: number;
  }> {
    return requestJson('oauth/device/start', {
      method: 'POST',
      body: JSON.stringify({ provider }),
    });
  },

  pollDeviceOAuth(payload: {
    session_id: string;
    provider: string;
    access_path: string;
    note?: string;
    save?: boolean;
  }): Promise<
    | { status: 'pending' | 'slow_down'; interval_seconds?: number }
    | { status: 'expired' | 'failed'; message: string }
    | { status: 'complete'; credential?: MaskedCredential; secret?: string }
  > {
    return requestJson('oauth/device/poll', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  startOpenRouterPkce(callback_url: string): Promise<{
    ok: true;
    session_id: string;
    auth_url: string;
  }> {
    return requestJson('oauth/pkce/start', {
      method: 'POST',
      body: JSON.stringify({ callback_url }),
    });
  },

  exchangeOpenRouterPkce(payload: {
    session_id: string;
    code_or_url: string;
    provider: string;
    access_path: string;
    note?: string;
    save?: boolean;
  }): Promise<{ ok: true; credential?: MaskedCredential; secret?: string }> {
    return requestJson('oauth/pkce/exchange', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // ---- 路由图引擎与遥测 ----
  listRouteGraphs(): Promise<{ items: RouteGraphDto[]; total: number }> {
    return requestJson('route-graphs');
  },

  upsertRouteGraph(
    body: RouteGraphUpsertRequest,
  ): Promise<{ ok: boolean; graph?: RouteGraphDto }> {
    return requestJson('route-graphs', { method: 'POST', body: JSON.stringify(body) });
  },

  deleteRouteGraph(id: string): Promise<{ ok: boolean; deleted: boolean }> {
    return requestJson(`route-graphs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  simulateRouteGraph(
    body: RouteGraphSimulateRequest,
  ): Promise<RouteGraphSimulateResponse> {
    return requestJson('route-graphs/simulate', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  getRoutingTelemetry(): Promise<RoutingTelemetryResponse> {
    return requestJson('routing-telemetry');
  },

  refreshRoutingTelemetry(provider?: string): Promise<RoutingTelemetryResponse> {
    return requestJson('routing-telemetry/refresh', {
      method: 'POST',
      body: JSON.stringify(provider ? { provider } : {}),
    });
  },

  // ---- 插件中心（Dogfooding）----
  listPlugins(): Promise<PluginsListResponse> {
    return requestJson('plugins');
  },

  updatePlugin(
    name: string,
    body: PluginUpdateRequest,
  ): Promise<{ ok: boolean; plugin: PluginInfoDto }> {
    return requestJson(`plugins/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  clearPluginLogs(plugin?: string): Promise<{ ok: boolean }> {
    const qs = plugin ? `?plugin=${encodeURIComponent(plugin)}` : '';
    return requestJson(`plugins/logs${qs}`, { method: 'DELETE' });
  },
};
