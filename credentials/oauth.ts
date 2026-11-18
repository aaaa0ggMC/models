/**
 * credentials/oauth.ts —— 上游订阅 / OAuth 授权流程（Device Code & PKCE）与自动刷新。
 *
 * 支持：
 *   1. `openai-codex`（ChatGPT Plus/Pro 订阅）：Device Code（auth.openai.com）+ JWT account_id 提取 + token 刷新
 *   2. `xai`（xAI SuperGrok / X Premium+ 订阅）：Device Code（auth.x.ai）+ token 刷新
 *   3. `openrouter`（OpenRouter OAuth PKCE）：浏览器 PKCE 换取永久 API key
 */

import { createHash, randomBytes } from 'node:crypto';

export type OAuthDeviceProvider = 'openai-codex' | 'xai';

export interface OAuthSecretPayload {
  kind: 'oauth';
  provider: OAuthDeviceProvider;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id?: string;
}

export interface DeviceAuthSession {
  session_id: string;
  provider: OAuthDeviceProvider;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval_seconds: number;
  expires_in_seconds: number;
  expires_at: number;
  device_code: string;
}

export interface PkceSession {
  session_id: string;
  provider: 'openrouter';
  code_verifier: string;
  auth_url: string;
  expires_at: number;
}

export type DevicePollResult =
  | { status: 'pending'; interval_seconds?: number }
  | { status: 'slow_down'; interval_seconds: number }
  | { status: 'expired'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'complete'; credential: OAuthSecretPayload };

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_BASE = 'https://auth.openai.com';
const OPENAI_DEVICE_USERCODE_URL = `${OPENAI_AUTH_BASE}/api/accounts/deviceauth/usercode`;
const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_AUTH_BASE}/api/accounts/deviceauth/token`;
const OPENAI_DEVICE_VERIFY_URI = `${OPENAI_AUTH_BASE}/codex/device`;
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_AUTH_BASE}/deviceauth/callback`;
const OPENAI_TOKEN_URL = `${OPENAI_AUTH_BASE}/oauth/token`;
const OPENAI_JWT_CLAIM_PATH = 'https://api.openai.com/auth';

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';

const DEVICE_SESSION_TTL_MS = 15 * 60 * 1000;
const PKCE_SESSION_TTL_MS = 10 * 60 * 1000;

const deviceSessions = new Map<string, DeviceAuthSession>();
const pkceSessions = new Map<string, PkceSession>();

function pruneExpiredSessions(now: number): void {
  for (const [id, s] of deviceSessions.entries()) {
    if (s.expires_at <= now) deviceSessions.delete(id);
  }
  for (const [id, s] of pkceSessions.entries()) {
    if (s.expires_at <= now) pkceSessions.delete(id);
  }
}

export function serializeOAuthSecret(payload: OAuthSecretPayload): string {
  return JSON.stringify(payload);
}

export function parseOAuthSecret(raw: string | undefined): OAuthSecretPayload | undefined {
  if (raw === undefined || !raw.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed['kind'] !== 'oauth' ||
      (parsed['provider'] !== 'openai-codex' && parsed['provider'] !== 'xai') ||
      typeof parsed['access_token'] !== 'string' ||
      typeof parsed['refresh_token'] !== 'string' ||
      typeof parsed['expires_at'] !== 'number'
    ) {
      return undefined;
    }
    return {
      kind: 'oauth',
      provider: parsed['provider'],
      access_token: parsed['access_token'],
      refresh_token: parsed['refresh_token'],
      expires_at: parsed['expires_at'],
      ...(typeof parsed['account_id'] === 'string' && parsed['account_id'] !== ''
        ? { account_id: parsed['account_id'] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function extractOpenAIAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return undefined;
    const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const authClaim = payload[OPENAI_JWT_CLAIM_PATH];
    if (authClaim !== null && typeof authClaim === 'object') {
      const id = (authClaim as Record<string, unknown>)['chatgpt_account_id'];
      if (typeof id === 'string' && id !== '') return id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function startDeviceCodeOAuth(
  provider: OAuthDeviceProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthDeviceStartResponse> {
  const now = Date.now();
  pruneExpiredSessions(now);
  const session_id = `oauth_${randomBytes(12).toString('hex')}`;

  if (provider === 'openai-codex') {
    const res = await fetchImpl(OPENAI_DEVICE_USERCODE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI Codex 设备码请求失败 (${res.status}): ${text || res.statusText}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const deviceAuthId = typeof json['device_auth_id'] === 'string' ? json['device_auth_id'] : '';
    const userCode = typeof json['user_code'] === 'string' ? json['user_code'] : '';
    const rawInterval = json['interval'];
    const intervalNum =
      typeof rawInterval === 'string' ? Number(rawInterval.trim()) : Number(rawInterval ?? 5);
    const interval_seconds = Number.isFinite(intervalNum) && intervalNum >= 1 ? intervalNum : 5;
    if (deviceAuthId === '' || userCode === '') {
      throw new Error('OpenAI Codex 返回的设备码响应缺少必要字段');
    }
    const expires_in_seconds = 900;
    const session: DeviceAuthSession = {
      session_id,
      provider,
      user_code: userCode,
      verification_uri: OPENAI_DEVICE_VERIFY_URI,
      interval_seconds,
      expires_in_seconds,
      expires_at: now + DEVICE_SESSION_TTL_MS,
      device_code: deviceAuthId,
    };
    deviceSessions.set(session_id, session);
    return toPublicDeviceSession(session);
  }

  // xAI SuperGrok Device Code
  const res = await fetchImpl(XAI_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_SCOPE,
      referrer: 'ag',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI 设备码请求失败 (${res.status}): ${text || res.statusText}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const deviceCode = typeof json['device_code'] === 'string' ? json['device_code'] : '';
  const userCode = typeof json['user_code'] === 'string' ? json['user_code'] : '';
  const verificationUri =
    typeof json['verification_uri'] === 'string' ? json['verification_uri'] : '';
  const verificationUriComplete =
    typeof json['verification_uri_complete'] === 'string' && json['verification_uri_complete'] !== ''
      ? json['verification_uri_complete']
      : undefined;
  const intervalRaw = Number(json['interval'] ?? 5);
  const interval_seconds = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? intervalRaw : 5;
  const expiresRaw = Number(json['expires_in'] ?? 900);
  const expires_in_seconds = Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : 900;
  if (deviceCode === '' || userCode === '' || verificationUri === '') {
    throw new Error('xAI 返回的设备码响应缺少必要字段');
  }
  const session: DeviceAuthSession = {
    session_id,
    provider,
    user_code: userCode,
    verification_uri: verificationUri,
    ...(verificationUriComplete === undefined
      ? {}
      : { verification_uri_complete: verificationUriComplete }),
    interval_seconds,
    expires_in_seconds,
    expires_at: now + expires_in_seconds * 1000,
    device_code: deviceCode,
  };
  deviceSessions.set(session_id, session);
  return toPublicDeviceSession(session);
}

export interface OAuthDeviceStartResponse {
  session_id: string;
  provider: OAuthDeviceProvider;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval_seconds: number;
  expires_in_seconds: number;
}

function toPublicDeviceSession(s: DeviceAuthSession): OAuthDeviceStartResponse {
  return {
    session_id: s.session_id,
    provider: s.provider,
    user_code: s.user_code,
    verification_uri: s.verification_uri,
    ...(s.verification_uri_complete === undefined
      ? {}
      : { verification_uri_complete: s.verification_uri_complete }),
    interval_seconds: s.interval_seconds,
    expires_in_seconds: s.expires_in_seconds,
  };
}

export async function pollDeviceCodeOAuth(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DevicePollResult> {
  const now = Date.now();
  const session = deviceSessions.get(sessionId);
  if (session === undefined || session.expires_at <= now) {
    deviceSessions.delete(sessionId);
    return { status: 'expired', message: '登录会话已过期，请重新发起' };
  }

  if (session.provider === 'openai-codex') {
    const res = await fetchImpl(OPENAI_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        device_auth_id: session.device_code,
        user_code: session.user_code,
      }),
    });
    if (res.status === 403 || res.status === 404) {
      return { status: 'pending' };
    }
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // ignore
    }
    if (!res.ok) {
      const errObj = json['error'];
      const errCode =
        typeof errObj === 'object' && errObj !== null
          ? (errObj as Record<string, unknown>)['code']
          : errObj;
      if (errCode === 'deviceauth_authorization_pending') return { status: 'pending' };
      if (errCode === 'slow_down') {
        session.interval_seconds += 5;
        return { status: 'slow_down', interval_seconds: session.interval_seconds };
      }
      deviceSessions.delete(sessionId);
      return { status: 'failed', message: `OpenAI 授权失败 (${res.status}): ${text}` };
    }
    const authCode = typeof json['authorization_code'] === 'string' ? json['authorization_code'] : '';
    const verifier = typeof json['code_verifier'] === 'string' ? json['code_verifier'] : '';
    if (authCode === '' || verifier === '') {
      deviceSessions.delete(sessionId);
      return { status: 'failed', message: 'OpenAI 返回的授权码无效' };
    }
    const tokenRes = await fetchImpl(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_CLIENT_ID,
        code: authCode,
        code_verifier: verifier,
        redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      deviceSessions.delete(sessionId);
      return { status: 'failed', message: `换取令牌失败 (${tokenRes.status}): ${errText}` };
    }
    const tokenJson = (await tokenRes.json()) as Record<string, unknown>;
    const access = typeof tokenJson['access_token'] === 'string' ? tokenJson['access_token'] : '';
    const refresh =
      typeof tokenJson['refresh_token'] === 'string' ? tokenJson['refresh_token'] : '';
    const expiresIn =
      typeof tokenJson['expires_in'] === 'number' ? tokenJson['expires_in'] : 3600;
    if (access === '' || refresh === '') {
      deviceSessions.delete(sessionId);
      return { status: 'failed', message: 'OpenAI 令牌响应缺少 access_token 或 refresh_token' };
    }
    deviceSessions.delete(sessionId);
    const accountId = extractOpenAIAccountId(access);
    return {
      status: 'complete',
      credential: {
        kind: 'oauth',
        provider: 'openai-codex',
        access_token: access,
        refresh_token: refresh,
        expires_at: Date.now() + expiresIn * 1000,
        ...(accountId === undefined ? {} : { account_id: accountId }),
      },
    };
  }

  // xAI polling
  const res = await fetchImpl(XAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: XAI_CLIENT_ID,
      device_code: session.device_code,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    const access = typeof json['access_token'] === 'string' ? json['access_token'] : '';
    const refresh = typeof json['refresh_token'] === 'string' ? json['refresh_token'] : '';
    const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
    if (access === '' || refresh === '') {
      deviceSessions.delete(sessionId);
      return { status: 'failed', message: 'xAI 令牌响应缺少 access_token 或 refresh_token' };
    }
    deviceSessions.delete(sessionId);
    return {
      status: 'complete',
      credential: {
        kind: 'oauth',
        provider: 'xai',
        access_token: access,
        refresh_token: refresh,
        expires_at: Date.now() + expiresIn * 1000,
      },
    };
  }
  const err = typeof json['error'] === 'string' ? json['error'] : '';
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') {
    const nextInt =
      typeof json['interval'] === 'number' && json['interval'] > 0
        ? json['interval']
        : session.interval_seconds + 5;
    session.interval_seconds = nextInt;
    return { status: 'slow_down', interval_seconds: nextInt };
  }
  if (err === 'expired_token') {
    deviceSessions.delete(sessionId);
    return { status: 'expired', message: '设备码已过期，请重新发起' };
  }
  deviceSessions.delete(sessionId);
  return {
    status: 'failed',
    message:
      typeof json['error_description'] === 'string'
        ? json['error_description']
        : `xAI 授权失败 (${res.status})`,
  };
}

export async function refreshOAuthToken(
  payload: OAuthSecretPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthSecretPayload> {
  if (payload.provider === 'openai-codex') {
    const res = await fetchImpl(OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: payload.refresh_token,
        client_id: OPENAI_CLIENT_ID,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI Codex OAuth 刷新失败 (${res.status}): ${text}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const access = typeof json['access_token'] === 'string' ? json['access_token'] : '';
    const refresh =
      typeof json['refresh_token'] === 'string' && json['refresh_token'] !== ''
        ? json['refresh_token']
        : payload.refresh_token;
    const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
    if (access === '') throw new Error('OpenAI Codex 刷新响应缺少 access_token');
    const accountId = extractOpenAIAccountId(access) ?? payload.account_id;
    return {
      kind: 'oauth',
      provider: 'openai-codex',
      access_token: access,
      refresh_token: refresh,
      expires_at: Date.now() + expiresIn * 1000,
      ...(accountId === undefined ? {} : { account_id: accountId }),
    };
  }

  const res = await fetchImpl(XAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_CLIENT_ID,
      refresh_token: payload.refresh_token,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI OAuth 刷新失败 (${res.status}): ${text}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const access = typeof json['access_token'] === 'string' ? json['access_token'] : '';
  const refresh =
    typeof json['refresh_token'] === 'string' && json['refresh_token'] !== ''
      ? json['refresh_token']
      : payload.refresh_token;
  const expiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  if (access === '') throw new Error('xAI 刷新响应缺少 access_token');
  return {
    kind: 'oauth',
    provider: 'xai',
    access_token: access,
    refresh_token: refresh,
    expires_at: Date.now() + expiresIn * 1000,
  };
}

export function startOpenRouterPkce(callbackUrl: string): {
  session_id: string;
  auth_url: string;
} {
  const now = Date.now();
  pruneExpiredSessions(now);
  const session_id = `or_${randomBytes(12).toString('hex')}`;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  pkceSessions.set(session_id, {
    session_id,
    provider: 'openrouter',
    code_verifier: verifier,
    auth_url: url.toString(),
    expires_at: now + PKCE_SESSION_TTL_MS,
  });
  return { session_id, auth_url: url.toString() };
}

function parseAuthorizationCode(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  try {
    const url = new URL(trimmed);
    const c = url.searchParams.get('code');
    if (c !== null && c !== '') return c;
  } catch {
    // not a URL
  }
  if (trimmed.includes('code=')) {
    const c = new URLSearchParams(trimmed).get('code');
    if (c !== null && c !== '') return c;
  }
  return trimmed;
}

export async function exchangeOpenRouterPkce(
  sessionId: string,
  codeOrUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const session = pkceSessions.get(sessionId);
  if (session === undefined || session.expires_at <= Date.now()) {
    pkceSessions.delete(sessionId);
    throw new Error('OpenRouter 授权会话已过期，请重新发起');
  }
  const code = parseAuthorizationCode(codeOrUrl);
  if (code === undefined) {
    throw new Error('未识别到授权码（请粘贴完整的回调链接或 code）');
  }
  const res = await fetchImpl(OPENROUTER_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: session.code_verifier,
      code_challenge_method: 'S256',
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof json['message'] === 'string'
        ? json['message']
        : typeof json['error'] === 'string'
          ? json['error']
          : `HTTP ${res.status}`;
    throw new Error(`OpenRouter 换取密钥失败: ${msg}`);
  }
  const key = typeof json['key'] === 'string' ? json['key'] : '';
  if (key === '') {
    throw new Error('OpenRouter 响应缺少 key 字段');
  }
  pkceSessions.delete(sessionId);
  return key;
}
