/**
 * tests/router-retry.test.ts —— S2 路由与重试/fallback 决策矩阵。
 *
 * 路由侧锁定 20-pipeline.md §S2 的几条硬规则：
 *   - 未知别名 → no_available_provider；
 *   - 参数兼容性预检（on_unsupported: "error" 时直接拒绝，**不进 fallback**）；
 *   - 流式能力预检（上游 mode: "none" 而客户端要流式 → 拒绝，不静默降级）；
 *   - fast path 判定四条件里的前两条（格式同一 + 路由标记 eligible）。
 *
 * 重试侧锁定 §7.3 决策矩阵：400 不重试不 fallback、401/403 不重试但 fallback、
 * 429/5xx 重试 + fallback、流式中途断开两者皆否。
 */

import { describe, expect, it } from 'vitest';
import { StaticRouter, type RouteTable } from '../gateway-core/router.js';
import { InMemoryCapabilityRegistry } from '../credentials/capability-registry.js';
import { EnvCredentialResolver, DEFAULT_ACCESS_PATHS } from '../credentials/resolver.js';
import {
  backoffDelayMs,
  canonicalCodeFromStatus,
  decideRetry,
  maybeMarkPromptTooLong,
  signalFromError,
} from '../gateway-core/pipeline/retry.js';
import { MutableRequestContext } from '../gateway-core/context.js';
import type { CapabilityEntry } from '../ir/index.js';

function makeRouter(capabilities: CapabilityEntry[] = [], aliases: RouteTable['aliases'] = {}) {
  const capabilityRegistry = new InMemoryCapabilityRegistry();
  for (const c of capabilities) capabilityRegistry.register(c);
  const credentialResolver = new EnvCredentialResolver(DEFAULT_ACCESS_PATHS, undefined, {});
  return new StaticRouter({ aliases }, capabilityRegistry, credentialResolver);
}

function makeCtx(format = 'openai.chat'): MutableRequestContext {
  return new MutableRequestContext({
    request_id: 'req_test',
    started_at: 0,
    deadline: 1000,
    client_format: format as MutableRequestContext['client_format'],
    client_raw_headers: {},
    auth: { key_id: 'k' },
  });
}

const chatCapability = (overrides: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  access_path: 'openai',
  model: 'gpt-test-1',
  modality: 'chat',
  streaming: { mode: 'sse', usage_in_stream: true },
  usage_source: 'provider',
  contract_tested: true,
  status: 'implemented',
  ...overrides,
});

describe('StaticRouter.resolve', () => {
  const aliases: RouteTable['aliases'] = {
    'gpt-test-1': { targets: [{ access_path: 'openai', provider: 'openai', model: 'gpt-test-1' }] },
    'claude-test-1': {
      targets: [{ access_path: 'anthropic', provider: 'anthropic', model: 'claude-test-1' }],
    },
  };

  it('同格式路由 → fast_path_eligible', () => {
    const router = makeRouter([chatCapability()], aliases);
    const ctx = makeCtx('openai.chat');
    const r = router.resolve({ model: 'gpt-test-1', modality: 'chat', stream: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route.provider_format).toBe('openai.chat');
      expect(r.route.fast_path_eligible).toBe(true);
      expect(r.route.full_model_id).toBe('openai/gpt-test-1');
    }
  });

  it('跨格式路由 → fast_path_eligible 为 false', () => {
    const router = makeRouter([chatCapability()], aliases);
    const ctx = makeCtx('anthropic.messages');
    const r = router.resolve({ model: 'gpt-test-1', modality: 'chat', stream: false }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.fast_path_eligible).toBe(false);
  });

  it('未知别名 → no_available_provider', () => {
    const router = makeRouter([chatCapability()], aliases);
    const r = router.resolve({ model: 'nope', modality: 'chat', stream: false }, makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_available_provider');
  });

  it('能力矩阵缺条目 → 不标 fast_path_eligible（不假装支持）', () => {
    const router = makeRouter([], aliases);
    const r = router.resolve({ model: 'gpt-test-1', modality: 'chat', stream: false }, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route.fast_path_eligible).toBe(false);
      expect(r.capability).toBeUndefined();
    }
  });

  it('on_unsupported=error 且参数不被支持 → capability_unsupported，不进 fallback', () => {
    const router = makeRouter([chatCapability({ unsupported_fields: ['params.top_k'] })], aliases);
    const r = router.resolve(
      {
        model: 'gpt-test-1',
        modality: 'chat',
        stream: false,
        requested_params: ['params.top_k', 'params.temperature'],
        on_unsupported: 'error',
      },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('capability_unsupported');
      expect(r.error.field_path).toBe('params.top_k');
    }
  });

  it('on_unsupported=allow 时不因不支持参数拒绝', () => {
    const router = makeRouter([chatCapability({ unsupported_fields: ['params.top_k'] })], aliases);
    const r = router.resolve(
      {
        model: 'gpt-test-1',
        modality: 'chat',
        stream: false,
        requested_params: ['params.top_k'],
        on_unsupported: 'allow',
      },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
  });

  it('上游流式 mode=none 而客户端要流式 → streaming_mode_unsupported（不静默降级）', () => {
    const router = makeRouter([chatCapability({ streaming: { mode: 'none' } })], aliases);
    const r = router.resolve({ model: 'gpt-test-1', modality: 'chat', stream: true }, makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('streaming_mode_unsupported');
  });

  it('多候选 attempt 全部进入 attempt_plan', () => {
    const router = makeRouter([chatCapability()], {
      'gpt-test-1': {
        targets: [
          { access_path: 'openai', provider: 'openai', model: 'gpt-test-1' },
          { access_path: 'anthropic', provider: 'anthropic', model: 'claude-test-1' },
        ],
      },
    });
    const r = router.resolve({ model: 'gpt-test-1', modality: 'chat', stream: false }, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.attempt_plan).toHaveLength(2);
  });

  it('filterAndSort hook 可以摘除 attempt', () => {
    const capabilityRegistry = new InMemoryCapabilityRegistry();
    capabilityRegistry.register(chatCapability());
    const credentialResolver = new EnvCredentialResolver(DEFAULT_ACCESS_PATHS, undefined, {});
    const router = new StaticRouter(
      {
        aliases: {
          'gpt-test-1': {
            targets: [
              { access_path: 'openai', provider: 'openai', model: 'gpt-test-1' },
              { access_path: 'anthropic', provider: 'anthropic', model: 'claude-test-1' },
            ],
          },
        },
      },
      capabilityRegistry,
      credentialResolver,
      {
        filterAndSort: (attempts) => attempts.filter((a) => a.access_path !== 'anthropic'),
      },
    );
    const r = router.resolve({ model: 'gpt-test-1', modality: 'chat', stream: false }, makeCtx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.route.attempt_plan.map((a) => a.access_path)).toEqual(['openai']);
  });

  it('setAlias 热更新别名表', () => {
    const router = makeRouter([chatCapability()], aliases);
    router.setAlias('new-alias', {
      targets: [{ access_path: 'openai', provider: 'openai', model: 'gpt-test-1' }],
    });
    const r = router.resolve({ model: 'new-alias', modality: 'chat', stream: false }, makeCtx());
    expect(r.ok).toBe(true);
  });
});

describe('重试 / fallback 决策矩阵（20 §7.3）', () => {
  it('连接失败：同 attempt 重试 + fallback', () => {
    expect(decideRetry('connection_failed', 0, 2)).toEqual({
      same_attempt: true,
      fallback: true,
      note: '网络错误',
    });
  });

  it('429：同 attempt 重试 + fallback', () => {
    expect(decideRetry('429', 0, 2)).toEqual({
      same_attempt: true,
      fallback: true,
      note: '遵守 retry-after',
    });
  });

  it('500/502/503：同 attempt 重试 + fallback', () => {
    for (const s of ['500', '502', '503']) {
      expect(decideRetry(s, 0, 2)).toEqual({ same_attempt: true, fallback: true });
    }
  });

  it('overloaded_error（Anthropic）：同 attempt 重试 + fallback', () => {
    expect(decideRetry('overloaded_error', 0, 2)).toEqual({ same_attempt: true, fallback: true });
  });

  it('TTFB 超时：同 attempt 重试 + fallback', () => {
    expect(decideRetry('ttfb_timeout', 0, 2)).toEqual({ same_attempt: true, fallback: true });
  });

  it('流式中途断开：两者皆否（已出字节，不可回退）', () => {
    expect(decideRetry('stream_broken', 0, 2)).toEqual({
      same_attempt: false,
      fallback: false,
      note: '已出字节，不可回退',
    });
  });

  it('400 参数错误：两者皆否', () => {
    expect(decideRetry('400', 0, 2)).toEqual({
      same_attempt: false,
      fallback: false,
      note: '重试无意义，直接映射为客户端 400',
    });
  });

  it('401/403：不重试但 fallback（换 key/provider 可能恢复）', () => {
    for (const s of ['401', '403']) {
      expect(decideRetry(s, 0, 2)).toEqual({
        same_attempt: false,
        fallback: true,
        note: '换 key/provider 可能恢复',
      });
    }
  });

  it('context_length_exceeded：不重试但 fallback', () => {
    expect(decideRetry('context_length_exceeded', 0, 2)).toEqual({
      same_attempt: false,
      fallback: true,
      note: '换更大上下文的 provider',
    });
  });

  it('重试次数用尽后不再同 attempt 重试', () => {
    expect(decideRetry('429', 2, 2)).toEqual({
      same_attempt: false,
      fallback: true,
      note: '遵守 retry-after',
    });
  });

  it('未登记的信号：保守不重试、允许 fallback，并记录信号名', () => {
    const d = decideRetry('weird_new_signal', 0, 2);
    expect(d.same_attempt).toBe(false);
    expect(d.fallback).toBe(true);
    expect(d.note).toContain('weird_new_signal');
  });
});

describe('错误信号反推与映射', () => {
  it('signalFromError 优先用 provider_code', () => {
    expect(
      signalFromError({
        code: 'upstream_error',
        message: 'm',
        http_status: 500,
        retryable: true,
        request_id: 'r',
        provider_code: 'overloaded_error',
      }),
    ).toBe('overloaded_error');
  });

  it('signalFromError 退化到 http_status', () => {
    expect(
      signalFromError({
        code: 'upstream_error',
        message: 'm',
        http_status: 429,
        retryable: true,
        request_id: 'r',
      }),
    ).toBe('429');
  });

  it('canonicalCodeFromStatus 的常见映射', () => {
    expect(canonicalCodeFromStatus(400)).toBe('capability_unsupported');
    expect(canonicalCodeFromStatus(401)).toBe('auth_failed');
    expect(canonicalCodeFromStatus(403)).toBe('auth_failed');
    expect(canonicalCodeFromStatus(429)).toBe('rate_limited');
    expect(canonicalCodeFromStatus(504)).toBe('upstream_timeout');
    expect(canonicalCodeFromStatus(503)).toBe('provider_unavailable');
    expect(canonicalCodeFromStatus(500, 'overloaded_error')).toBe('provider_unavailable');
    expect(canonicalCodeFromStatus(404)).toBe('upstream_error');
  });

  it('backoffDelayMs 指数增长且带 jitter', () => {
    const base = 100;
    // jitter 范围 ±20%，因此区间是 [0.8x, 1.2x]
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const d = backoffDelayMs(attempt, base);
      expect(d).toBeGreaterThanOrEqual(Math.round(base * 2 ** attempt * 0.8));
      expect(d).toBeLessThanOrEqual(Math.round(base * 2 ** attempt * 1.2));
    }
    // 单调趋势（允许 jitter 重叠）
    expect(backoffDelayMs(3, base)).toBeGreaterThan(backoffDelayMs(0, base));
  });

  it('capability_rejected 只对 HTTP 400 + 明确上下文超限语义加', () => {
    const base = {
      code: 'capability_unsupported' as const,
      message: 'm',
      http_status: 400,
      retryable: false,
      request_id: 'r',
    };
    const tooLong = maybeMarkPromptTooLong(
      base,
      '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
    );
    expect(tooLong.capability_rejected).toBe('prompt_too_long');

    const other400 = maybeMarkPromptTooLong(base, '{"error":{"message":"invalid temperature"}}');
    expect(other400.capability_rejected).toBeUndefined();

    const tooLong500 = maybeMarkPromptTooLong(
      { ...base, http_status: 500 },
      'context length exceeded',
    );
    expect(tooLong500.capability_rejected).toBeUndefined();
  });
});
