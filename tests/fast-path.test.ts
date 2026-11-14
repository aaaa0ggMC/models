/**
 * tests/fast-path.test.ts —— D-fastpath-1 / D-fastpath-2 的行为锁定。
 *
 * 这两条是仓库主人对 issue #8 第 3 条的拍板，是本轮实现里最容易回归的地方，
 * 因此单独一层测试：
 *   D-fastpath-1：S1 只解析路由必需字段；完整物化推迟到 S3 / S4 / S6。
 *   D-fastpath-2：fast path 准入 = 没有启用任何 full-canonical 请求侧插件；
 *                 条件由组合根启动时计算并缓存，插件增减时失效重算。
 */

import { describe, expect, it } from 'vitest';
import type { Plugin } from '../ir/index.js';
import { effectivePluginScope } from '../ir/index.js';
import { DefaultPluginHost } from '../plugins/host.js';
import { createFastPathAdmission, isFastPathEligible } from '../gateway-core/pipeline/fast-path.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { MemoryLogger, MemoryMetrics, fixedClock } from '../di/index.js';
import { MutableRequestContext } from '../gateway-core/context.js';
import type { ResolvedRoute } from '../ir/index.js';
import { ROUTING_REQUIRED_FIELDS } from '../gateway-core/pipeline/lazy-decode.js';
import { shallowDecode } from '../gateway-core/pipeline/lazy-decode.js';
import type { Adaptor } from '../adaptors/types.js';

function makePluginHost() {
  return new DefaultPluginHost(
    {
      log: new MemoryLogger(),
      metrics: new MemoryMetrics(),
      clock: fixedClock(0),
      currentUsage: () => ({ units: {}, source: 'provider' }),
      kv: {
        async get() {
          return undefined;
        },
        async set() {},
        async delete() {},
      },
    },
    1000,
  );
}

function makePlugin(
  name: string,
  scope: 'envelope-only' | 'full-canonical' | undefined,
  hooks: Array<'onRequest' | 'onResponse'> = ['onRequest'],
): Plugin {
  return {
    manifest: {
      name,
      version: '1.0.0',
      hooks,
      order: 10,
      ...(scope === undefined ? {} : { scope }),
    },
    onRequest: (req) => req,
  };
}

function makeCtx(): MutableRequestContext {
  return new MutableRequestContext({
    request_id: 'req_test',
    started_at: 0,
    deadline: 1000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'k' },
  });
}

function makeRoute(clientFormat: string, providerFormat: string): ResolvedRoute {
  return {
    access_path: 'openai',
    provider: 'openai',
    provider_format: providerFormat as ResolvedRoute['provider_format'],
    model: 'gpt-test-1',
    full_model_id: 'openai/gpt-test-1',
    attempt_plan: [],
    fast_path_eligible: clientFormat === providerFormat,
  };
}

describe('D-fastpath-2：fast path 准入', () => {
  it('没有请求侧插件 → 允许 fast path', () => {
    const host = makePluginHost();
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(true);
    expect(admission.reason()).toBeUndefined();
  });

  it('只有 envelope-only 请求侧插件 → 仍允许 fast path', () => {
    const host = makePluginHost();
    host.register(makePlugin('reader', 'envelope-only'));
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(true);
  });

  it('manifest 未声明 scope → 按 full-canonical（安全侧优先），禁用 fast path', () => {
    const host = makePluginHost();
    host.register(makePlugin('undeclared', undefined));
    expect(effectivePluginScope({ name: 'x', version: '1', hooks: ['onRequest'] })).toBe(
      'full-canonical',
    );
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(false);
    expect(admission.reason()).toContain('undeclared');
  });

  it('显式 full-canonical 请求侧插件 → 禁用 fast path 且给出原因', () => {
    const host = makePluginHost();
    host.register(makePlugin('compactor', 'full-canonical'));
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(false);
    expect(admission.reason()).toBe('请求侧插件需要完整 canonical: compactor');
  });

  it('onResponse-only 的 full-canonical 插件**不**禁用 fast path', () => {
    const host = makePluginHost();
    host.register(makePlugin('auditor', 'full-canonical', ['onResponse']));
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(true);
  });

  it('运行中注册 full-canonical 插件 → 缓存自动失效重算', () => {
    const host = makePluginHost();
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(true);
    host.register(makePlugin('late', 'full-canonical'));
    expect(admission.allowed()).toBe(false);
  });

  it('运行中卸载插件 → 缓存自动失效重算', () => {
    const host = makePluginHost();
    host.register(makePlugin('late', 'full-canonical'));
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(false);
    host.unregister('late');
    expect(admission.allowed()).toBe(true);
  });

  it('运行中 setEnabled(false) → 缓存自动失效重算', () => {
    const host = makePluginHost();
    host.register(makePlugin('late', 'full-canonical'));
    const admission = createFastPathAdmission(host);
    expect(admission.allowed()).toBe(false);
    host.setEnabled('late', false);
    expect(admission.allowed()).toBe(true);
    host.setEnabled('late', true);
    expect(admission.allowed()).toBe(false);
  });

  it('isFastPathEligible 同时校验 §4.1 的四个条件', () => {
    const host = makePluginHost();
    const admission = createFastPathAdmission(host);

    // 条件 1：格式同一 + 条件 2：路由标记 eligible + 条件 4：有原始字节
    const ctx = makeCtx();
    const route = makeRoute('openai.chat', 'openai.chat');
    expect(isFastPathEligible(ctx, route, admission, true)).toBe(true);

    // 条件 1 不满足：客户端格式 ≠ 上游格式
    expect(
      isFastPathEligible(ctx, makeRoute('anthropic.messages', 'openai.chat'), admission, true),
    ).toBe(false);

    // 条件 2 不满足：路由未标记 eligible
    const ineligible = { ...route, fast_path_eligible: false };
    expect(isFastPathEligible(ctx, ineligible, admission, true)).toBe(false);

    // 条件 3 不满足：插件要求结构改写
    ctx.state['requires_structural_change'] = true;
    expect(isFastPathEligible(ctx, route, admission, true)).toBe(false);
    delete ctx.state['requires_structural_change'];

    // 条件 4 不满足：没有保留原始字节
    expect(isFastPathEligible(ctx, route, admission, false)).toBe(false);

    // D-fastpath-2 准入不满足时，其余条件全中也禁用
    host.register(makePlugin('blocker', 'full-canonical'));
    expect(isFastPathEligible(ctx, route, admission, true)).toBe(false);
  });
});

describe('D-fastpath-1：S1 浅解析与惰性物化', () => {
  /** 一个最小 adaptor，只用来驱动 shallowDecode 的退化路径。 */
  const stubAdaptor: Adaptor = {
    format: 'openai.chat',
    modalities: ['chat'],
    decode: (raw) => {
      const r = raw as Record<string, unknown>;
      return {
        ir_version: 'ag-ir/1',
        kind: 'chat',
        model: String(r['model'] ?? ''),
        source_format: 'openai.chat',
        raw: {},
        payload: {
          messages: (r['messages'] as never) ?? [],
          system: [],
          tools: [],
        },
      };
    },
    encode: () => ({ body: {}, fast_path: false }),
    decodeResponse: () => {
      throw new Error('not implemented');
    },
    encodeResponse: () => ({}),
    decodeStream: () => (async function* () {})(),
    encodeStream: () => (async function* () {})(),
    extractUsage: () => ({ units: {}, source: 'provider' }),
    normalizeFinishReason: () => 'stop',
  };

  it('ROUTING_REQUIRED_FIELDS 是拍板列出的路由必需集', () => {
    expect([...ROUTING_REQUIRED_FIELDS]).toEqual([
      'source_format',
      'model',
      'access_path_hint',
      'stream',
      'request_bytes',
      'usage_locations',
    ]);
  });

  it('浅解析不物化 messages / tools', () => {
    const ctx = makeCtx();
    const body = JSON.stringify({
      model: 'gpt-test-1',
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      __future: 1,
    });
    const shallow = shallowDecode(stubAdaptor, Buffer.from(body), ctx, 'chat');
    expect(shallow).toMatchObject({
      source_format: 'openai.chat',
      kind: 'chat',
      model: 'gpt-test-1',
      stream: true,
      bytes: Buffer.byteLength(body),
    });
    // 路由必需集里没有 messages / tools ——浅解析产物上不应出现
    expect(Object.keys(shallow)).not.toContain('messages');
    expect(Object.keys(shallow)).not.toContain('tools');
  });

  it('浅解析对非法 JSON 立刻失败（避免无谓解码）', () => {
    const ctx = makeCtx();
    expect(() => shallowDecode(stubAdaptor, Buffer.from('{not json'), ctx, 'chat')).toThrow(
      /请求体不是合法 JSON/,
    );
  });

  it('MemoryClientSink 在首字节后拒绝改状态码（20 §S8 硬约束）', () => {
    const sink = new MemoryClientSink();
    sink.start(200, {});
    expect(() => sink.start(500, {})).toThrow(/首字节后不能改状态码/);
  });
});
