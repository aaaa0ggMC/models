import { describe, expect, it } from 'vitest';
import {
  exchangeOpenRouterPkce,
  parseOAuthSecret,
  pollDeviceCodeOAuth,
  serializeOAuthSecret,
  startDeviceCodeOAuth,
  startOpenRouterPkce,
} from '../credentials/oauth.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import type { RequestContext } from '../ir/index.js';

function fakeCtx(): RequestContext {
  return {
    request_id: 'req-oauth-test',
    trace_id: 'trace-oauth-test',
    client_raw_headers: {},
  } as unknown as RequestContext;
}

describe('OAuth 凭据与解析器', () => {
  it('OpenAI Codex Device Code 流程：启动、轮询、换取 token 并解析 chatgpt_account_id', async () => {
    const fakeJwtPayload = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test_123' } }),
    ).toString('base64url');
    const fakeAccessJwt = `hdr.${fakeJwtPayload}.sig`;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        return new Response(
          JSON.stringify({ device_auth_id: 'dev_1', user_code: 'ABCD-1234', interval: '5' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/api/accounts/deviceauth/token')) {
        return new Response(
          JSON.stringify({ authorization_code: 'auth_code_1', code_verifier: 'verifier_1' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: fakeAccessJwt,
            refresh_token: 'rt_1',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    };

    const started = await startDeviceCodeOAuth('openai-codex', mockFetch);
    expect(started.user_code).toBe('ABCD-1234');
    expect(started.verification_uri).toBe('https://auth.openai.com/codex/device');

    const polled = await pollDeviceCodeOAuth(started.session_id, mockFetch);
    expect(polled.status).toBe('complete');
    if (polled.status === 'complete') {
      expect(polled.credential.account_id).toBe('acct_test_123');
      expect(polled.credential.access_token).toBe(fakeAccessJwt);
      const serialized = serializeOAuthSecret(polled.credential);
      expect(parseOAuthSecret(serialized)?.provider).toBe('openai-codex');
    }
  });

  it('xAI SuperGrok Device Code 流程：pending -> complete', async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/oauth2/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'xdev_1',
            user_code: 'XAI-9999',
            verification_uri: 'https://accounts.x.ai/device',
            verification_uri_complete: 'https://accounts.x.ai/device?user_code=XAI-9999',
            interval: 3,
            expires_in: 600,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/oauth2/token')) {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
        }
        return new Response(
          JSON.stringify({ access_token: 'xai_at_1', refresh_token: 'xai_rt_1', expires_in: 3600 }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    };

    const started = await startDeviceCodeOAuth('xai', mockFetch);
    expect(started.verification_uri_complete).toBe(
      'https://accounts.x.ai/device?user_code=XAI-9999',
    );
    const first = await pollDeviceCodeOAuth(started.session_id, mockFetch);
    expect(first.status).toBe('pending');
    const second = await pollDeviceCodeOAuth(started.session_id, mockFetch);
    expect(second.status).toBe('complete');
  });

  it('OpenRouter PKCE：生成授权链接并换取永久 API Key', async () => {
    const started = startOpenRouterPkce('http://localhost:8790/admin/');
    expect(started.auth_url).toContain('https://openrouter.ai/auth');
    expect(started.auth_url).toContain('code_challenge_method=S256');

    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ key: 'sk-or-v1-fake-test-key' }), { status: 200 });
    const apiKey = await exchangeOpenRouterPkce(
      started.session_id,
      'http://localhost:8790/admin/?code=or_code_123',
      mockFetch,
    );
    expect(apiKey).toBe('sk-or-v1-fake-test-key');
  });

  it('EnvCredentialResolver 对 Codex OAuth 注入 chatgpt-account-id 与 subscription 计费模式', async () => {
    const resolver = new EnvCredentialResolver([], undefined, {}, {}, { autoRegisterEnv: false });
    resolver.registerAccessPath({
      id: 'openai-codex.openai-responses',
      label: 'Codex',
      format: 'openai.responses',
      base_url: 'https://chatgpt.com/backend-api',
      usage_source: 'provider',
      model_namespaces: ['openai-codex'],
      requires_credential: true,
    });
    const secret = serializeOAuthSecret({
      kind: 'oauth',
      provider: 'openai-codex',
      access_token: 'tok_abc', // privacy-scan: ignore —— 测试占位 token
      refresh_token: 'rt_abc',
      expires_at: Date.now() + 3600_000,
      account_id: 'acct_xyz',
    });
    resolver.registerCredential(
      {
        id: 'cred-codex-1',
        name: 'codex-1',
        access_path: 'openai-codex.openai-responses',
        model_namespace: 'openai-codex',
        health: { status: 'healthy' },
        type: 'oauth_device_code',
        storage: { location: 'vault', ref: 'cred:cred-codex-1', encrypted: true },
        enabled: true,
        priority: 0,
      },
      secret,
    );

    expect(resolver.billingModeFor('openai-codex.openai-responses')).toBe('subscription');
    const resolved = await resolver.headersFor('openai-codex.openai-responses', fakeCtx());
    expect(resolved.headers['authorization']).toBe('Bearer tok_abc');
    expect(resolved.headers['chatgpt-account-id']).toBe('acct_xyz');
    expect(resolved.headers['OpenAI-Beta']).toBe('responses=experimental');
  });
});
