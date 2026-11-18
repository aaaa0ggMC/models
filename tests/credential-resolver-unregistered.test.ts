import { describe, expect, it } from 'vitest';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { MutableRequestContext } from '../gateway-core/context.js';

function makeCtx(requestId: string): MutableRequestContext {
  const now = Date.now();
  return new MutableRequestContext({
    request_id: requestId,
    started_at: now,
    deadline: now + 30_000,
    client_format: 'openai.responses',
    client_raw_headers: {},
    auth: { key_id: 'vk_test', key_prefix: 'vk_test' },
  });
}

describe('EnvCredentialResolver unregistered access path handling', () => {
  it('infers format and signs auth headers when access path is not in paths map but has credential', async () => {
    const resolver = new EnvCredentialResolver([], undefined, {}, {});
    resolver.registerCredential(
      {
        id: 'cred_ds_anth',
        provider: 'deepseek',
        access_path: 'deepseek.anthropic-messages',
        kind: 'api_key',
        label: 'ds-anth',
        priority: 100,
        enabled: true,
        storage: { location: 'vault', ref: 'mem' },
      },
      'sk-test-deepseek-key',
    );

    expect(resolver.formatFor('deepseek.anthropic-messages')).toBe('anthropic.messages');

    const ctx = makeCtx('req_test_1');
    const resolved = await resolver.headersFor('deepseek.anthropic-messages', ctx);
    expect(resolved.credential_id).toBe('cred_ds_anth');
    expect(resolved.headers['x-api-key']).toBe('sk-test-deepseek-key');
    expect(resolved.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('throws missing credential error instead of returning empty headers for unregistered real paths', async () => {
    const resolver = new EnvCredentialResolver([], undefined, {}, {});
    const ctx = makeCtx('req_test_2');

    await expect(resolver.headersFor('deepseek.anthropic-messages', ctx)).rejects.toThrow(
      /没有可用凭据/,
    );
    // mock 路径仍然允许无凭据放行
    await expect(resolver.headersFor('mock', ctx)).resolves.toEqual({ headers: {} });
  });
});
