/**
 * tests/routing-engine.test.ts —— 图 + 沙盒 VM-JS 路由引擎端到端测试。
 *
 * 覆盖：
 *   1. DAG 结构校验（非法 id / 缺失入口 / 有向环 / JS 语法错误）；
 *   2. 服务商注入声明式条件（免写 JS：OpenAI Codex 5h 滑窗、DeepSeek 余额+闲时、MiMo 积分+百分比）
 *      与条件不满足时的候选/fallback 顺延；
 *   3. 隔离 `node:vm` 沙盒 JS 节点（只读 canonical 特征与 credits/telemetry，输出分支+参数覆盖；
 *      死循环超时终止与禁止逃逸到 process/require/fetch/eval 时安全走 fallback 边）；
 *   4. 真实 S0–S10 流水线：RouteGraph 在 `/v1/models` 暴露、主路参数覆盖透传、上游限流头
 *      `x-ratelimit-remaining-requests` 与 5h 滑窗写入、503 主路失败后基于 `base_canonical`
 *      切换 fallback 节点并按备选节点参数重新编码；
 *   5. 管理面 HTTP API（`/admin/api/route-graphs*` CRUD + 模拟 + `/admin/api/routing-telemetry*`）。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { JsonlFileUsageSink, SqliteUsageStore } from '../metering/index.js';
import { SqliteRawRecordStore } from '../storage/index.js';
import type { UsageRecord } from '../metering/usage-record.js';

import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { createAdminRouter } from '../admin/routes.js';
import { DefaultAdminAuth } from '../admin/auth.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { DefaultEncryptedRecordStore, InMemoryRawRecordStore } from '../storage/record-store.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { DefaultRoutingTelemetryHub } from '../gateway-core/routing-telemetry.js';
import {
  autoLayoutRouteGraph,
  evaluateRouteGraph,
  hasOverlappingNodes,
  validateRouteGraph,
  type RouteGraph,
} from '../gateway-core/routing-engine.js';
import { createOpenAICodexProfile } from '../providers/openai-codex/profile.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { createMiMoProfile } from '../providers/mimo/profile.js';
import type { CanonicalRequestEnvelope } from '../ir/index.js';
import type { GatewayConfig } from '../di/ports.js';

const FIXED_NOW = Date.parse('2026-11-18T14:00:00Z'); // 22:00 CST（周三晚，DeepSeek 闲时）
const PEAK_NOW = Date.parse('2026-11-18T02:00:00Z'); // 10:00 CST（周三上午，DeepSeek 峰时）
const PASSPHRASE = 'routing-engine-test-passphrase';
const ADMIN_PASSWORD = 'admin-password-not-real'; // privacy-scan: ignore —— 测试假口令
const FAKE_DEEPSEEK_KEY = 'sk-fake-deepseek-not-real';
const FAKE_MIMO_TP_KEY = 'tp-fake-mimo-not-real';

const PERMISSIVE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};

function makeOpenAiChatJson(model: string, content: string) {
  return JSON.stringify({
    id: `chatcmpl-${model}`,
    object: 'chat.completion',
    created: Math.floor(FIXED_NOW / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  });
}

function sampleCanonical(text: string, withImage = false): CanonicalRequestEnvelope {
  return {
    ir_version: 'ag-ir/1',
    kind: 'chat',
    model: 'smart-router',
    source_format: 'openai.chat',
    raw: {},
    payload: {
      system: [{ text: 'BASE_SYS' }],
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text },
            ...(withImage
              ? [
                  {
                    type: 'image' as const,
                    media: { kind: 'uri' as const, uri: 'https://example.com/a.png', mime: 'image/png' },
                  },
                ]
              : []),
          ],
        },
      ],
      params: {},
    },
  };
}

interface HttpHarness {
  server: Server;
  baseUrl: string;
  adminToken: string;
  gateway: ReturnType<typeof createGateway>;
  transport: ScriptedTransport;
}

async function buildHttpHarness(
  script: ScriptedTransportScript = [],
  configOverrides: Partial<GatewayConfig> = {},
): Promise<HttpHarness> {
  const clock = { now: () => FIXED_NOW };
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const recordStore = new DefaultEncryptedRecordStore(
    ks.unlocked(),
    new InMemoryRawRecordStore(),
    clock,
  );
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    staticProviders: ['deepseek', 'mimo'],
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
      MIMO_API_KEY: FAKE_MIMO_TP_KEY,
    }),
    config: { maxRetries: 0, retryBaseDelayMs: 1, ...configOverrides },
  });

  const adminAuth = new DefaultAdminAuth(recordStore, clock, {});
  await adminAuth.setAccount({ id: 'owner', name: 'owner', role: 'owner' }, ADMIN_PASSWORD);
  const routeHandler = createAdminRouter({
    auth: adminAuth,
    service: gateway.admin!.adminService,
    keystoreStatus: () => ({
      mode: 'passphrase',
      tradeoff_note: 'test',
      unlocked: true,
      active_dek_id: 'dek_test',
      encryption_count: 0,
      should_rotate_dek: false,
      argon2_rehash_recommended: false,
      kek_fingerprint: '0123456789abcdef',
    }),
    providerPresets: () => [],
  });
  const server = createHttpServer({
    authenticator: PERMISSIVE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    adminHandler: routeHandler,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }), // privacy-scan: ignore —— 测试假口令
  });
  const body = (await login.json()) as { token?: string };
  return { server, baseUrl, adminToken: body.token ?? '', gateway, transport };
}

async function adminApi(
  h: HttpHarness,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${h.adminToken}`,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('1. 路由图校验与 DAG 判环', () => {
  it('拒绝非法 id、缺失入口、有向环与 JS 语法错误，接受合法 DAG', () => {
    const valid: RouteGraph = {
      id: 'dag-valid-1',
      label: '合法路由图',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 100 } },
        {
          id: 'js',
          kind: 'js_script',
          label: '脚本',
          position: { x: 240, y: 100 },
          script: { code: "return ctx.request.has_images ? 'img' : 'txt';", ports: ['img', 'txt'] },
        },
        {
          id: 't1',
          kind: 'provider_target',
          label: 'DeepSeek',
          position: { x: 480, y: 100 },
          target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-chat' },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'js', priority: 1 },
        { id: 'e2', from: 'js', from_port: 'txt', to: 't1', priority: 1 },
      ],
    };
    expect(validateRouteGraph(valid).ok).toBe(true);

    const cyclic: RouteGraph = {
      ...valid,
      id: 'bad id with space!',
      entry_node_id: 'missing',
      nodes: [
        valid.nodes[0]!,
        {
          id: 'js',
          kind: 'js_script',
          label: '坏脚本',
          position: { x: 240, y: 100 },
          script: { code: 'return (((' },
        },
        valid.nodes[2]!,
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'js', priority: 1 },
        { id: 'e2', from: 'js', from_port: 'next', to: 't1', priority: 1 },
        { id: 'e3', from: 't1', from_port: 'fallback', to: 'js', priority: 2 },
      ],
    };
    const res = validateRouteGraph(cyclic);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('id'))).toBe(true);
    expect(res.errors.some((e) => e.includes('入口节点不存在'))).toBe(true);
    expect(res.errors.some((e) => e.includes('语法错误'))).toBe(true);
    expect(res.errors.some((e) => e.includes('环'))).toBe(true);
  });
});

describe('2. 服务商注入声明式条件（免写 JS）', () => {
  it('暴露 Codex 5h / DeepSeek 余额与闲时 / MiMo 积分选项，并按实时遥测自动筛选与 fallback', () => {
    let nowMs = PEAK_NOW;
    const profiles = new InMemoryProviderProfileRegistry();
    profiles.register(createOpenAICodexProfile());
    profiles.register(createDeepSeekProfile());
    profiles.register(createMiMoProfile());

    const hub = new DefaultRoutingTelemetryHub({
      clock: { now: () => nowMs },
      providerProfiles: profiles,
    });

    expect(hub.optionsForProvider('openai-codex').map((o) => o.key)).toEqual(
      expect.arrayContaining(['max_5h_requests', 'max_5h_tokens', 'min_upstream_remaining_requests']),
    );
    expect(hub.optionsForProvider('deepseek').map((o) => o.key)).toEqual(
      expect.arrayContaining(['min_balance', 'min_granted_balance', 'off_peak_only']),
    );
    expect(hub.optionsForProvider('mimo').map((o) => o.key)).toEqual(
      expect.arrayContaining(['min_remaining_credits', 'max_credit_usage_pct', 'min_balance']),
    );

    // 峰时 10:00 CST → DeepSeek off-peak 为 false；切到 22:00 CST → true
    expect(hub.snapshotFor('deepseek').is_off_peak).toBe(false);
    nowMs = FIXED_NOW;
    expect(hub.snapshotFor('deepseek').is_off_peak).toBe(true);

    hub.updateBalance('deepseek', { balance: 20, granted_balance: 5, currency: 'CNY', available: true });
    hub.updateCredits('mimo', { remaining_credits: 500, used_credits: 500, total_credits: 1000 });
    hub.recordUsageEvent({
      request_id: 'r1',
      ts: nowMs - 1000,
      provider: 'openai-codex',
      tokens: 1000,
      cash_usd: 0,
    });

    const graph: RouteGraph = {
      id: 'no-js-cascade',
      label: '无 JS 声明式级联',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 120 } },
        {
          id: 'codex',
          kind: 'provider_target',
          label: 'Codex 订阅',
          position: { x: 240, y: 120 },
          target: {
            provider: 'openai-codex',
            access_path: 'openai-codex.openai-responses',
            model: 'gpt-5-codex',
            provider_options: { max_5h_requests: 2 },
          },
        },
        {
          id: 'ds',
          kind: 'provider_target',
          label: 'DeepSeek 闲时',
          position: { x: 460, y: 120 },
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-chat',
            provider_options: { min_balance: 5, off_peak_only: true },
          },
        },
        {
          id: 'mimo',
          kind: 'provider_target',
          label: 'MiMo 积分兜底',
          position: { x: 680, y: 120 },
          target: {
            provider: 'mimo',
            access_path: 'mimo.openai-chat',
            model: 'mimo-v2.6-pro',
            provider_options: { min_remaining_credits: 100, max_credit_usage_pct: 90 },
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'codex', priority: 1 },
        { id: 'e2', from: 'codex', from_port: 'fallback', to: 'ds', priority: 1 },
        { id: 'e3', from: 'ds', from_port: 'fallback', to: 'mimo', priority: 1 },
      ],
    };

    // 第一阶段：Codex 5h 请求 1 <= 2，DeepSeek 闲时且余额 20 >= 5，MiMo 积分 500 >= 100
    const eval1 = evaluateRouteGraph(graph, {
      model: graph.id,
      modality: 'chat',
      stream: false,
      client_format: 'openai.chat',
      canonical: sampleCanonical('hello'),
      telemetryHub: hub,
    });
    expect(eval1.ok).toBe(true);
    expect(eval1.candidates.map((c) => c.provider)).toEqual(['openai-codex', 'deepseek', 'mimo']);

    // 再记 2 条 Codex 请求使 5h=3 (>2)，并把 DeepSeek 余额压到 1 (<5)
    hub.recordUsageEvent({
      request_id: 'r2',
      ts: nowMs - 500,
      provider: 'openai-codex',
      tokens: 1000,
      cash_usd: 0,
    });
    hub.recordUsageEvent({
      request_id: 'r3',
      ts: nowMs - 200,
      provider: 'openai-codex',
      tokens: 1000,
      cash_usd: 0,
    });
    hub.updateBalance('deepseek', { balance: 1, granted_balance: 0, currency: 'CNY', available: true });

    const eval2 = evaluateRouteGraph(graph, {
      model: graph.id,
      modality: 'chat',
      stream: false,
      client_format: 'openai.chat',
      canonical: sampleCanonical('hello'),
      telemetryHub: hub,
    });
    expect(eval2.ok).toBe(true);
    expect(eval2.candidates.map((c) => `${c.provider}:${c.model}`)).toEqual(['mimo:mimo-v2.6-pro']);
    expect(eval2.trace.some((s) => s.node_id === 'codex' && s.outcome === 'skipped')).toBe(true);
    expect(eval2.trace.some((s) => s.node_id === 'ds' && s.outcome === 'skipped')).toBe(true);
  });
});

describe('3. VM 沙盒 JS 路由、参数覆盖与安全隔离', () => {
  it('读取 canonical 请求摘要与服务商积分并下发 overrides', () => {
    const graph: RouteGraph = {
      id: 'js-route',
      label: 'JS 动态分支',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 120 } },
        {
          id: 'js',
          kind: 'js_script',
          label: '难度分流',
          position: { x: 240, y: 120 },
          script: {
            timeout_ms: 50,
            ports: ['deep', 'fast'],
            code: `
              if (!ctx.request.has_images && (ctx.credits.deepseek?.balance ?? 0) >= 10 && ctx.request.last_user_text.includes('证明')) {
                return {
                  branch: 'deep',
                  overrides: {
                    thinking_enabled: true,
                    thinking_effort: 'high',
                    temperature: 0.2,
                    system_prompt_append: '请逐步推理'
                  }
                };
              }
              return { branch: 'fast', overrides: { temperature: 0.8 } };
            `,
          },
        },
        {
          id: 'deep-node',
          kind: 'provider_target',
          label: '深度推理',
          position: { x: 480, y: 60 },
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-reasoner',
          },
        },
        {
          id: 'fast-node',
          kind: 'provider_target',
          label: '轻量快速',
          position: { x: 480, y: 200 },
          target: {
            provider: 'mimo',
            access_path: 'mimo.openai-chat',
            model: 'mimo-v2.6-flash',
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'js', priority: 1 },
        { id: 'e2', from: 'js', from_port: 'deep', to: 'deep-node', priority: 1 },
        { id: 'e3', from: 'js', from_port: 'fast', to: 'fast-node', priority: 2 },
      ],
    };

    const deepEval = evaluateRouteGraph(graph, {
      model: graph.id,
      modality: 'chat',
      stream: false,
      client_format: 'openai.chat',
      canonical: sampleCanonical('请严格证明费马小定理'),
      simulation: { telemetry_overrides: { deepseek: { balance: 25 } } },
    });
    expect(deepEval.ok).toBe(true);
    expect(deepEval.candidates[0]?.model).toBe('deepseek-reasoner');
    expect(deepEval.candidates[0]?.overrides).toEqual({
      thinking_enabled: true,
      thinking_effort: 'high',
      temperature: 0.2,
      system_prompt_append: '请逐步推理',
    });

    const imgEval = evaluateRouteGraph(graph, {
      model: graph.id,
      modality: 'chat',
      stream: false,
      client_format: 'openai.chat',
      canonical: sampleCanonical('看图并证明', true),
      simulation: { telemetry_overrides: { deepseek: { balance: 25 } } },
    });
    expect(imgEval.candidates[0]?.model).toBe('mimo-v2.6-flash');
    expect(imgEval.candidates[0]?.overrides).toEqual({ temperature: 0.8 });
  });

  it('死循环超时及越权访问 process/require/fetch/eval 时终止并安全切向 fallback', () => {
    const makeFaultyGraph = (id: string, code: string): RouteGraph => ({
      id,
      label: '故障沙盒脚本',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 120 } },
        {
          id: 'js',
          kind: 'js_script',
          label: '危险脚本',
          position: { x: 240, y: 120 },
          script: { code, timeout_ms: 10, ports: ['primary', 'fallback'] },
        },
        {
          id: 'safe-target',
          kind: 'provider_target',
          label: '安全兜底',
          position: { x: 480, y: 120 },
          target: { provider: 'mimo', access_path: 'mimo.openai-chat', model: 'mimo-v2.6-flash' },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'js', priority: 1 },
        { id: 'e2', from: 'js', from_port: 'fallback', to: 'safe-target', priority: 1 },
      ],
    });

    const timeoutRes = evaluateRouteGraph(makeFaultyGraph('js-loop', 'while (true) {}'), {
      model: 'js-loop',
      modality: 'chat',
      stream: false,
      client_format: 'openai.chat',
      canonical: sampleCanonical('hi'),
    });
    expect(timeoutRes.ok).toBe(true);
    expect(timeoutRes.trace.some((s) => s.node_id === 'js' && s.outcome === 'error')).toBe(true);
    expect(timeoutRes.candidates[0]?.model).toBe('mimo-v2.6-flash');

    for (const expr of [
      'return process.env.SECRET;',
      'return require("node:fs");',
      'return fetch("https://example.com");',
      'return eval("1+1");',
    ]) {
      const escRes = evaluateRouteGraph(makeFaultyGraph('js-escape', expr), {
        model: 'js-escape',
        modality: 'chat',
        stream: false,
        client_format: 'openai.chat',
        canonical: sampleCanonical('hi'),
      });
      expect(escRes.ok).toBe(true);
      expect(escRes.trace.some((s) => s.node_id === 'js' && s.outcome === 'error')).toBe(true);
      expect(escRes.candidates[0]?.model).toBe('mimo-v2.6-flash');
    }
  });
});

describe('4. S0–S10 全链路执行、遥测回流、/v1/models 暴露与跨渠道 Failover 重编码', () => {
  it('命中路由图、记录 5h 滑窗与限流头，并在 503 时从 base_canonical 重编码到备选厂商', async () => {
    const transport = new ScriptedTransport([
      // 第 1 个请求：DeepSeek 成功 + 返回限流头
      {
        status: 200,
        headers: { 'x-ratelimit-remaining-requests': '42', 'x-ratelimit-remaining-tokens': '9000' },
        body: makeOpenAiChatJson('deepseek-flash', 'primary-ok'),
      },
      // 第 2 个请求：主路 DeepSeek 返回 503 → 触发 S5 failover → 备选 MiMo 200
      {
        status: 503,
        body: JSON.stringify({ error: { message: 'busy' } }),
      },
      {
        status: 200,
        body: makeOpenAiChatJson('mimo-v2.6-pro', 'fallback-ok'),
      },
    ]);

    const clock = { now: () => FIXED_NOW };
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const recordStore = new DefaultEncryptedRecordStore(
      ks.unlocked(),
      new InMemoryRawRecordStore(),
      clock,
    );

    const gw = createGateway({
      mode: 'test',
      transport,
      clock,
      recordStore,
      staticProviders: ['deepseek', 'mimo'],
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
        MIMO_API_KEY: FAKE_MIMO_TP_KEY,
      }),
      config: { maxRetries: 0, retryBaseDelayMs: 1 },
    });

    const graph: RouteGraph = {
      id: 'smart-router',
      label: '智能混合作战',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 120 } },
        {
          id: 'primary',
          kind: 'provider_target',
          label: '主路 DeepSeek',
          position: { x: 260, y: 120 },
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-flash',
            overrides: { temperature: 0.1, system_prompt_append: 'PRIMARY_SYS' },
          },
        },
        {
          id: 'fallback',
          kind: 'provider_target',
          label: '备选 MiMo',
          position: { x: 500, y: 120 },
          target: {
            provider: 'mimo',
            access_path: 'mimo.openai-chat',
            model: 'mimo-v2.6-pro',
            overrides: { temperature: 0.7, system_prompt_append: 'FALLBACK_SYS' },
          },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'primary', priority: 1 },
        { id: 'e2', from: 'primary', from_port: 'fallback', to: 'fallback', priority: 1 },
      ],
    };
    gw.routeGraphs.upsert(graph);

    // 验证 /v1/models 目录自动暴露启用的路由图标识符
    const catalogList = await gw.models.list();
    expect(catalogList.data.some((m) => m.id === 'smart-router')).toBe(true);

    // 请求 1：主路成功
    const sink1 = new MemoryClientSink();
    const out1 = await gw.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'smart-router',
            messages: [
              { role: 'system', content: 'USER_SYS' },
              { role: 'user', content: 'hi' },
            ],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink1,
    );
    expect(out1.status).toBe(200);
    expect(transport.requests).toHaveLength(1);
    const body1 = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      model: string;
      temperature?: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body1.model).toBe('deepseek-flash');
    expect(body1.temperature).toBe(0.1);
    const sys1 = body1.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(sys1).toContain('USER_SYS');
    expect(sys1).toContain('PRIMARY_SYS');

    // 验证 5h 滑窗与限流头实时更新
    const dsSnap = gw.routingTelemetry.snapshotFor('deepseek');
    expect(dsSnap.window_5h.requests).toBeGreaterThanOrEqual(1);
    expect(dsSnap.window_5h.upstream_remaining_requests).toBe(42);
    expect(dsSnap.window_5h.upstream_remaining_tokens).toBe(9000);

    // 请求 2：DeepSeek 503 → 自动 fallback 到 MiMo 并从 base_canonical 重编码（不含 PRIMARY_SYS）
    const sink2 = new MemoryClientSink();
    const out2 = await gw.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'smart-router',
            messages: [
              { role: 'system', content: 'USER_SYS' },
              { role: 'user', content: 'hi fallback' },
            ],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink2,
    );
    expect(out2.status).toBe(200);
    expect(transport.requests).toHaveLength(3);

    const mimoReq = transport.requests[2]!;
    expect(mimoReq.base_url).toBe('https://token-plan-cn.xiaomimimo.com');
    expect(mimoReq.path).toBe('/v1/chat/completions');
    const body2 = JSON.parse(mimoReq.body?.toString('utf8') ?? '{}') as {
      model: string;
      temperature?: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body2.model).toBe('mimo-v2.6-pro');
    expect(body2.temperature).toBe(0.7);
    const sys2 = body2.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(sys2).toContain('USER_SYS');
    expect(sys2).toContain('FALLBACK_SYS');
    expect(sys2).not.toContain('PRIMARY_SYS');

    await gw.shutdown();
  });
});

describe('5. 管理面 HTTP API（CRUD / 模拟器 / 遥测读取与刷新）', () => {
  it('支持创建、列举、模拟、刷新遥测与删除路由图并持久化生效', async () => {
    const h = await buildHttpHarness([
      // DeepSeek /user/balance + MiMo /v1/platform/token_plan 刷新响应
      {
        status: 200,
        body: JSON.stringify({
          is_available: true,
          balance_infos: [
            {
              currency: 'CNY',
              total_balance: '120.50',
              granted_balance: '20.00',
              topped_up_balance: '100.50',
            },
          ],
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          object: 'token_plan',
          plan_code: 'pro',
          period: { start_at: '2026-11-01 00:00:00', end_at: '2026-12-01 00:00:00' },
          quota: { total_credits: 1000, used_credits: 250, remaining_credits: 750 },
          auto_renew: true,
          claw_enabled: true,
        }),
      },
    ]);

    try {
      const createRes = await adminApi(h, 'POST', '/admin/api/route-graphs', {
        id: 'api-graph-1',
        label: '接口测试图',
        enabled: true,
        entry_node_id: 'entry',
        nodes: [
          { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 120 } },
          {
            id: 'cond',
            kind: 'condition',
            label: '含图检测',
            position: { x: 240, y: 120 },
            condition: { has_images: true },
          },
          {
            id: 'ds',
            kind: 'provider_target',
            label: 'DeepSeek',
            position: { x: 480, y: 80 },
            target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-chat' },
          },
          {
            id: 'mimo',
            kind: 'provider_target',
            label: 'MiMo',
            position: { x: 480, y: 200 },
            target: { provider: 'mimo', access_path: 'mimo.openai-chat', model: 'mimo-v2.6-flash' },
          },
        ],
        edges: [
          { id: 'e1', from: 'entry', from_port: 'next', to: 'cond', priority: 1 },
          { id: 'e2', from: 'cond', from_port: 'true', to: 'mimo', priority: 1 },
          { id: 'e3', from: 'cond', from_port: 'false', to: 'ds', priority: 2 },
        ],
      });
      expect(createRes.status).toBe(200);
      expect(createRes.body['ok']).toBe(true);
      expect(h.gateway.routeGraphs.get('api-graph-1')?.label).toBe('接口测试图');

      const listRes = await adminApi(h, 'GET', '/admin/api/route-graphs');
      expect(listRes.status).toBe(200);
      expect((listRes.body['items'] as Array<{ id: string }>).some((g) => g.id === 'api-graph-1')).toBe(
        true,
      );

      const simRes = await adminApi(h, 'POST', '/admin/api/route-graphs/simulate', {
        graph_id: 'api-graph-1',
        request: { model: 'api-graph-1', client_format: 'openai.chat', has_images: false, prompt: '你好' },
      });
      expect(simRes.status).toBe(200);
      expect(simRes.body['ok']).toBe(true);
      expect((simRes.body['attempt_plan'] as Array<{ model: string }>)[0]?.model).toBe('deepseek-chat');

      const refreshRes = await adminApi(h, 'POST', '/admin/api/routing-telemetry/refresh');
      expect(refreshRes.status).toBe(200);
      const snapshots = refreshRes.body['snapshots'] as Record<
        string,
        { balance?: number; remaining_credits?: number }
      >;
      expect(snapshots['deepseek']?.balance).toBe(120.5);
      expect(snapshots['mimo']?.remaining_credits).toBe(750);

      const telRes = await adminApi(h, 'GET', '/admin/api/routing-telemetry');
      expect(telRes.status).toBe(200);
      const providerOptions = telRes.body['provider_options'] as Record<string, unknown[]>;
      expect(Array.isArray(providerOptions['deepseek'])).toBe(true);
      expect(Array.isArray(providerOptions['mimo'])).toBe(true);

      const delRes = await adminApi(h, 'DELETE', '/admin/api/route-graphs/api-graph-1');
      expect(delRes.status).toBe(200);
      expect(delRes.body['deleted']).toBe(true);
      expect(h.gateway.routeGraphs.get('api-graph-1')).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => h.server.close(() => resolve()));
      await h.gateway.shutdown();
    }
  });

  it('刷新 OpenAI Codex / OpenCode Go / OpenRouter 配额与余额，并在 401/403 时静默标记不支持', async () => {
    const transport = new ScriptedTransport([
      // 1. openai-codex /backend-api/wham/usage -> 200
      {
        status: 200,
        body: JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 9000 },
            secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 300000 },
          },
          credits: { has_credits: true, balance: 15.5 },
        }),
      },
      // 2. opencode-go /zen/go/v1/usage -> 200 (rolling5h / weekly / monthly)
      {
        status: 200,
        body: JSON.stringify({
          rolling5h: { usageDollars: 2.34, limitDollars: 12, usagePercent: 19.5, resetInSec: 7200 },
          weekly: { usageDollars: 8.91, limitDollars: 30, usagePercent: 29.7, resetInSec: 345600 },
          monthly: { usageDollars: 15.0, limitDollars: 60, usagePercent: 25.0, resetInSec: 1414800 },
        }),
      },
      // 3. xai / Grok 订阅配额（0% 时省略 creditUsagePercent）
      {
        status: 200,
        body: JSON.stringify({
          tier: 'supergrok',
          config: {
            currentPeriod: {
              periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
              endTime: '2026-11-25T00:00:00Z',
            },
          },
        }),
      },
      // 4. openrouter /api/v1/credits -> 200
      {
        status: 200,
        body: JSON.stringify({ data: { total_credits: 50, total_usage: 12.25 } }),
      },
      // 第二轮刷新：openai-codex 返回 401，opencode-go 返回 401（无权限），xai 返回 200（18%），openrouter 200
      { status: 401, body: JSON.stringify({ error: 'unauthorized' }) },
      { status: 401, body: JSON.stringify({ error: 'forbidden' }) },
      {
        status: 200,
        body: JSON.stringify({
          tier: 'supergrok',
          config: { currentPeriod: { periodType: 'USAGE_PERIOD_TYPE_WEEKLY', creditUsagePercent: 18 } },
        }),
      },
      { status: 200, body: JSON.stringify({ data: { total_credits: 50, total_usage: 12.25 } }) },
    ]);

    const clock = { now: () => FIXED_NOW };
    const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
    await ks.unlock(PASSPHRASE);
    const recordStore = new DefaultEncryptedRecordStore(
      ks.unlocked(),
      new InMemoryRawRecordStore(),
      clock,
    );

    const resolver = new EnvCredentialResolver(undefined, undefined, {});
    resolver.registerCredential(
      {
        id: 'env:codex',
        provider: 'openai-codex',
        access_path: 'openai-codex.openai-responses',
        priority: 1,
        enabled: true,
        storage: { location: 'env', var_name: 'CODEX_TOKEN' },
      },
      'oauth-fake-codex-not-real', // privacy-scan: ignore —— 测试假凭据
    );
    resolver.registerCredential(
      {
        id: 'env:opencode',
        provider: 'opencode-go',
        access_path: 'opencode-go.openai-chat',
        priority: 1,
        enabled: true,
        storage: { location: 'env', var_name: 'OPENCODE_API_KEY' },
      },
      'sk-fake-opencode-not-real', // privacy-scan: ignore —— 测试假凭据
    );
    resolver.registerCredential(
      {
        id: 'env:xai',
        provider: 'xai',
        access_path: 'xai.openai-responses',
        priority: 1,
        enabled: true,
        storage: { location: 'env', var_name: 'XAI_TOKEN' },
      },
      'oauth-fake-xai-not-real', // privacy-scan: ignore —— 测试假凭据
    );
    resolver.registerCredential(
      {
        id: 'env:openrouter',
        provider: 'openrouter',
        access_path: 'openrouter.openai-chat',
        priority: 1,
        enabled: true,
        storage: { location: 'env', var_name: 'OPENROUTER_API_KEY' },
      },
      'sk-fake-openrouter-not-real', // privacy-scan: ignore —— 测试假凭据
    );

    const gw = createGateway({
      mode: 'test',
      transport,
      clock,
      recordStore,
      credentialResolver: resolver,
    });

    try {
      const r1 = await gw.admin!.adminService.refreshRoutingTelemetry();
      expect(r1.snapshots['openai-codex']?.balance_supported).toBe(true);
      expect(r1.snapshots['openai-codex']?.plan_type).toBe('plus');
      expect(r1.snapshots['openai-codex']?.balance).toBe(15.5);
      expect(r1.snapshots['openai-codex']?.windows?.h5?.used_percent).toBe(25);
      expect(r1.snapshots['openai-codex']?.windows?.weekly?.used_percent).toBe(12);

      expect(r1.snapshots['opencode-go']?.balance_supported).toBe(true);
      expect(r1.snapshots['opencode-go']?.windows?.h5?.used_percent).toBe(19.5);
      expect(r1.snapshots['opencode-go']?.windows?.h5?.used_usd).toBe(2.34);
      expect(r1.snapshots['opencode-go']?.windows?.h5?.limit_usd).toBe(12);
      expect(r1.snapshots['opencode-go']?.windows?.weekly?.used_percent).toBe(29.7);
      expect(r1.snapshots['opencode-go']?.windows?.monthly?.used_percent).toBe(25);

      expect(r1.snapshots['xai']?.balance_supported).toBe(true);
      expect(r1.snapshots['xai']?.plan_type).toBe('supergrok');
      expect(r1.snapshots['xai']?.windows?.weekly?.used_percent).toBe(0);

      expect(r1.snapshots['openrouter']?.balance_supported).toBe(true);
      expect(r1.snapshots['openrouter']?.remaining_credits).toBe(37.75);

      // 第二轮：401 保留 unauthorized 状态供 UI 展示"凭据无权限"，xai 更新为 18%
      const r2 = await gw.admin!.adminService.refreshRoutingTelemetry();
      expect(r2.snapshots['openai-codex']?.quota_status).toBe('unauthorized');
      expect(r2.snapshots['opencode-go']?.quota_status).toBe('unauthorized');
      expect(r2.snapshots['opencode-go']?.quota_message).toBe('凭据无权限');
      expect(r2.snapshots['xai']?.windows?.weekly?.used_percent).toBe(18);
      expect(r2.snapshots['openrouter']?.balance_supported).toBe(true);
    } finally {
      await gw.shutdown();
    }
  });

  it('JsonlFileUsageSink 持久化用量与金额，重启后重装不归零', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-usage-persist-'));
    try {
      const file = join(dir, 'usage.jsonl');
      const sink1 = new JsonlFileUsageSink(file);
      expect(await sink1.load()).toBe(0);
      await sink1.write([
        {
          request_id: 'req-persist-1',
          ts: FIXED_NOW,
          provider: 'deepseek',
          model: 'deepseek-flash',
          status: 'ok',
          usage: { units: { tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } },
          cost: {
            cash: { total: 0.00125, breakdown: {} },
            as_api: { total: 0.00125, breakdown: {} },
            currency: 'USD',
            status: 'priced',
          },
          finish_reason: 'stop',
          fast_path: false,
        } satisfies UsageRecord,
      ]);

      const sink2 = new JsonlFileUsageSink(file);
      expect(await sink2.load()).toBe(1);
      expect(sink2.records[0]?.request_id).toBe('req-persist-1');
      expect(sink2.records[0]?.cost.cash.total).toBe(0.00125);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SqliteRawRecordStore 与 SqliteUsageStore 持久化加密记录与用量且按时间范围索引查询', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ag-sqlite-persist-'));
    try {
      const dbPath = join(dir, 'gateway.db');
      const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
      await ks.unlock(PASSPHRASE);

      const raw1 = new SqliteRawRecordStore(dbPath);
      const enc1 = new DefaultEncryptedRecordStore(ks.unlocked(), raw1, { now: () => FIXED_NOW });
      await enc1.put('route_graph', 'rg-sql-1', { id: 'rg-sql-1', label: 'SQL图', enabled: true });

      const usage1 = new SqliteUsageStore(dbPath);
      await usage1.write([
        {
          request_id: 'req-sql-1',
          ts: FIXED_NOW - 1000,
          provider: 'deepseek',
          model: 'deepseek-flash',
          status: 'ok',
          usage: { units: { tokens: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } },
          cost: {
            cash: { total: 0.0025, breakdown: {} },
            as_api: { total: 0.0025, breakdown: {} },
            currency: 'USD',
            status: 'priced',
          },
          finish_reason: 'stop',
          fast_path: false,
        } satisfies UsageRecord,
      ]);
      raw1.close();
      usage1.close();

      // 模拟重启重新打开同一个 gateway.db
      const raw2 = new SqliteRawRecordStore(dbPath);
      const enc2 = new DefaultEncryptedRecordStore(ks.unlocked(), raw2, { now: () => FIXED_NOW });
      const loadedGraph = await enc2.get<{ id: string; label: string }>('route_graph', 'rg-sql-1');
      expect(loadedGraph?.label).toBe('SQL图');

      const usage2 = new SqliteUsageStore(dbPath);
      const rows = usage2.list(FIXED_NOW - 5000, FIXED_NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.request_id).toBe('req-sql-1');
      expect(rows[0]?.cost.cash.total).toBe(0.0025);
      expect(usage2.list(FIXED_NOW, FIXED_NOW + 1000)).toHaveLength(0);
      raw2.close();
      usage2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('autoLayoutRouteGraph：能识别重叠节点并按拓扑分层无重叠重排', () => {
    const cramped: RouteGraph = {
      id: 'cramped',
      label: '重叠图',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 100 } },
        {
          id: 'cond',
          kind: 'condition',
          label: '条件',
          position: { x: 80, y: 110 }, // 与入口重叠
          condition: {},
        },
        {
          id: 't1',
          kind: 'provider_target',
          label: '主路',
          position: { x: 100, y: 120 },
          target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
        },
        {
          id: 't2',
          kind: 'provider_target',
          label: '备选',
          position: { x: 110, y: 130 },
          target: { provider: 'mimo', access_path: 'mimo.openai-chat', model: 'mimo-v2.6-pro' },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'cond', priority: 0 },
        { id: 'e2', from: 'cond', from_port: 'true', to: 't1', priority: 0 },
        { id: 'e3', from: 'cond', from_port: 'false', to: 't2', priority: 1 },
      ],
    };
    expect(hasOverlappingNodes(cramped.nodes)).toBe(true);
    const laidOut = autoLayoutRouteGraph(cramped);
    expect(hasOverlappingNodes(laidOut)).toBe(false);
    const byId = new Map(laidOut.map((n) => [n.id, n.position]));
    expect(byId.get('entry')!.x).toBeLessThan(byId.get('cond')!.x);
    expect(byId.get('cond')!.x).toBeLessThan(byId.get('t1')!.x);
    expect(byId.get('t1')!.x).toBe(byId.get('t2')!.x);
    expect(Math.abs(byId.get('t1')!.y - byId.get('t2')!.y)).toBeGreaterThanOrEqual(150);
  });

  it('hook_script 与 script 端口：前置脚本拦截后自动走 fallback，放行时支持改写 overrides', () => {
    const graph: RouteGraph = {
      id: 'hooked',
      label: '钩子图',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 100 } },
        {
          id: 'js-guard',
          kind: 'js_script',
          label: '外接脚本',
          position: { x: 40, y: 260 },
          script: { code: 'return { overrides: { temperature: 0.25 } };' },
        },
        {
          id: 't-primary',
          kind: 'provider_target',
          label: '主目标',
          position: { x: 320, y: 100 },
          target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
          hook_script: { code: 'return !ctx.request.has_images;' },
        },
        {
          id: 't-backup',
          kind: 'provider_target',
          label: '备选目标',
          position: { x: 620, y: 100 },
          target: { provider: 'mimo', access_path: 'mimo.openai-chat', model: 'mimo-v2.6-pro' },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 't-primary', priority: 0 },
        { id: 'e-script', from: 'js-guard', from_port: 'script', to: 't-primary', priority: 0 },
        { id: 'e-fb', from: 't-primary', from_port: 'fallback', to: 't-backup', priority: 0 },
      ],
    };

    expect(validateRouteGraph(graph).ok).toBe(true);

    // 无图时外接脚本注入 temperature=0.25 且内联钩子放行
    const okEval = evaluateRouteGraph(graph, {
      model: 'hooked',
      modality: 'chat',
      stream: true,
      client_format: 'openai.chat',
    });
    expect(okEval.ok).toBe(true);
    expect(okEval.candidates[0]?.model).toBe('deepseek-flash');
    expect(okEval.candidates[0]?.overrides?.temperature).toBe(0.25);

    // 含图时内联钩子拦截并走 fallback 到 mimo
    const blockedEval = evaluateRouteGraph(graph, {
      model: 'hooked',
      modality: 'chat',
      stream: true,
      client_format: 'openai.chat',
      simulation: { has_images: true },
    });
    expect(blockedEval.ok).toBe(true);
    expect(blockedEval.candidates).toHaveLength(1);
    expect(blockedEval.candidates[0]?.model).toBe('mimo-v2.6-pro');
  });

  it('extension_ports：Provider 扩展端口 low_balance 触发时沿分支路由', () => {
    const profiles = new InMemoryProviderProfileRegistry();
    profiles.register(createDeepSeekProfile());
    profiles.register(createMiMoProfile());
    const hub = new DefaultRoutingTelemetryHub({
      clock: { now: () => FIXED_NOW },
      providerProfiles: profiles,
    });

    const exts = hub.extensionsForProvider('deepseek');
    expect(exts.some((e) => e.port === 'off_peak')).toBe(true);
    expect(exts.some((e) => e.port === 'low_balance')).toBe(true);

    const graph: RouteGraph = {
      id: 'ext-branch',
      label: '扩展分流',
      enabled: true,
      entry_node_id: 'entry',
      nodes: [
        { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 100 } },
        {
          id: 'ds',
          kind: 'provider_target',
          label: 'DeepSeek',
          position: { x: 320, y: 100 },
          target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
          extension_ports: ['low_balance'],
        },
        {
          id: 'mimo-alt',
          kind: 'provider_target',
          label: 'MiMo 备用',
          position: { x: 640, y: 100 },
          target: { provider: 'mimo', access_path: 'mimo.openai-chat', model: 'mimo-v2.6-pro' },
        },
      ],
      edges: [
        { id: 'e1', from: 'entry', from_port: 'next', to: 'ds', priority: 0 },
        { id: 'e-low', from: 'ds', from_port: 'low_balance', to: 'mimo-alt', priority: 0 },
      ],
    };

    const res = evaluateRouteGraph(graph, {
      model: 'ext-branch',
      modality: 'chat',
      stream: true,
      client_format: 'openai.chat',
      telemetryHub: hub,
      simulation: { telemetry_overrides: { deepseek: { balance: 2 } } },
    });
    expect(res.ok).toBe(true);
    expect(res.candidates.map((c) => c.model)).toEqual(['deepseek-flash', 'mimo-v2.6-pro']);
    expect(res.trace.some((s) => s.port === 'low_balance' && s.outcome === 'branch')).toBe(true);
  });

  it('ability_mode：默认 min 取所有候选目标交集，max 取并集，custom 允许手动覆盖', async () => {
    const gw = createGateway({
      mode: 'test',
      transport: {
        async send() {
          return { status: 200, headers: {}, body: Buffer.from('{}') };
        },
      },
      staticProviders: ['deepseek', 'mimo'],
      credentialResolver: new EnvCredentialResolver(undefined, undefined, {
        DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
        MIMO_API_KEY: FAKE_MIMO_TP_KEY,
      }),
    });

    const baseNodes: RouteGraph['nodes'] = [
      { id: 'entry', kind: 'entry', label: '入口', position: { x: 40, y: 100 } },
      {
        id: 't1',
        kind: 'provider_target',
        label: 'DeepSeek',
        position: { x: 320, y: 80 },
        target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
      },
      {
        id: 't2',
        kind: 'provider_target',
        label: 'MiMo',
        position: { x: 320, y: 200 },
        target: { provider: 'mimo', access_path: 'mimo.openai-chat', model: 'mimo-v2.6-pro' },
      },
    ];
    const baseEdges: RouteGraph['edges'] = [
      { id: 'e1', from: 'entry', from_port: 'next', to: 't1', priority: 0 },
      { id: 'e2', from: 't1', from_port: 'fallback', to: 't2', priority: 0 },
    ];

    gw.routeGraphs.upsert({
      id: 'rg-min',
      label: '最小交集',
      enabled: true,
      entry_node_id: 'entry',
      nodes: baseNodes,
      edges: baseEdges,
    });
    gw.routeGraphs.upsert({
      id: 'rg-max',
      label: '最大并集',
      enabled: true,
      entry_node_id: 'entry',
      ability_mode: 'max',
      nodes: baseNodes,
      edges: baseEdges,
    });
    gw.routeGraphs.upsert({
      id: 'rg-custom',
      label: '自定义',
      enabled: true,
      entry_node_id: 'entry',
      ability_mode: 'custom',
      abilities: { tool_call: true, reasoning: false, context_window: 64000, input_modalities: ['text', 'image'] },
      nodes: baseNodes,
      edges: baseEdges,
    });

    const list = await gw.models.list();
    const minRec = list.data.find((m) => m.id === 'rg-min');
    const maxRec = list.data.find((m) => m.id === 'rg-max');
    const customRec = list.data.find((m) => m.id === 'rg-custom');

    expect(minRec).toBeDefined();
    expect(maxRec).toBeDefined();
    expect(customRec?.tool_call).toBe(true);
    expect(customRec?.reasoning).toBe(false);
    expect(customRec?.context_window).toBe(64000);
    expect(customRec?.input_modalities).toEqual(['text', 'image']);
    if (minRec?.context_window !== undefined && maxRec?.context_window !== undefined) {
      expect(minRec.context_window).toBeLessThanOrEqual(maxRec.context_window);
    }
  });
});
