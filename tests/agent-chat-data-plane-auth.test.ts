/**
 * tests/agent-chat-data-plane-auth.test.ts —— 内置对话的数据面鉴权缺口回归。
 *
 * ## 这个文件为什么存在
 *
 * 2026-11 实测：`POST /admin/api/chat` 发消息没有任何反应——不是网络问题，是服务端
 * 在第一层就拒绝了。根因是 `admin/agent-chat.ts` 构造 `PipelineInput` 时只带
 * `content-type`（注释写着「S0 用不到」），而 S0 的鉴权阶段**无条件跑**：数据面
 * 认证器（`auth/data-plane.ts` 的 `DataPlaneAuthenticator`）在 `virtual_key` 模式下
 * 看不到任何凭据 → 整条链路在进路由之前就失败，界面收到的是
 * 「缺少 API key」而不是上游的结果。
 *
 * 为什么一直没被发现：`tests/agent-chat-e2e.test.ts` 注入的是 permissive 占位鉴权器
 * （永远放行），**没有任何测试用真正的 `DataPlaneAuthenticator` 打过这个端点**。
 *
 * ## 本文件钉住的三件事
 *
 *   1. 内置对话在 virtual_key 模式下不带任何客户端凭据也能过 S0——豁免是**代码级**
 *      的区分（`PipelineInput` 上的类型化字段），不是「S0 认一个魔法请求头」；
 *   2. 数据面客户端拿不到任何新放行路径：把同样的"标记"写在头 / body 里一律 401，
 *      且真的 virtual key 仍然照常工作（那道门没有变松）；
 *   3. 计量归属不丢：`UsageRecord.auth.key_id` 落在固定的非人类 `agent-builtin` 上，
 *      不会变成匿名调用。
 *
 * 传输层那道门（`http/server.ts` 对 `/v1` 前缀的统一鉴权）这里注的是 permissive
 * 占位器，与 `tests/virtual-key.test.ts` 同款理由：要让 **S0**（真正持有豁免表的
 * 那个门）做决定。否则数据面请求在到达 S0 之前就被拦掉，「标记伪造」那条断言就
 * 变成 vacuous 的——它证明的是传输层，而不是我们改的那一层。
 */

import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'agent-chat-auth-test-passphrase';
const ADMIN_PASSWORD = 'admin-password-not-real'; // privacy-scan: ignore —— 测试假口令（login 契约字段名，值是显式假串）
/** 上游环境变量里的假 key（形态与真 key 同款，值是编的）。 */
const FAKE_UPSTREAM_KEY = 'sk-fake-deepseek-not-real'; // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）

/**
 * 传输层网关的占位鉴权器（理由见文件头：要让 S0 做决定）。
 *
 * 注意它与 S0 用的**不是**同一个：S0 的鉴权器由 `createGateway` 内部装配成真正的
 * `DataPlaneAuthenticator`（`config.virtualKeysEnabled: true` → virtual_key 模式）。
 */
const TRANSPORT_GATE_AUTH = {
  async authenticate() {
    return { ok: true as const, key_id: 'test', via: 'permissive' as const };
  },
};

interface Harness {
  server: Server;
  baseUrl: string;
  adminToken: string;
  gateway: ReturnType<typeof createGateway>;
  transport: ScriptedTransport;
}

/** 一个 OpenAI Chat 非流式响应（模型名与内置别名目标一致）。 */
function chat(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-agent-auth',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  });
}

/**
 * 装配一个 **virtual_key 模式**的网关 + 管理面。
 *
 * `virtualKeysEnabled: true` 让 S0 的 `DataPlaneAuthenticator` 处于虚拟 key 模式
 * （一把 key 都没有也成立）：此时任何不带 `sk-ag-…` 凭据的请求都会被 S0 拒掉，
 * 这正是线上复现时的形态。
 */
async function build(script: ScriptedTransportScript): Promise<Harness> {
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
    config: { virtualKeysEnabled: true },
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_UPSTREAM_KEY,
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
    // 静态装配声明：默认设置里的 agent_model 落在静态拼出来的 deepseek 上，
    // 没有渠道记录（见 composition-root.ts 的 staticProviders 说明）
    staticProviders: ['deepseek'],
  });
  const server = createHttpServer({
    authenticator: TRANSPORT_GATE_AUTH,
    port: 0,
    host: '127.0.0.1',
    runner: gateway.runner,
    adminHandler: gateway.admin!.routeHandler,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  await gateway.admin!.adminAuth.setAccount(
    { id: 'owner', name: 'owner', role: 'owner' },
    ADMIN_PASSWORD,
  );
  const login = await fetch(`${baseUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }), // privacy-scan: ignore —— 测试假口令
  });
  const body = (await login.json()) as { token?: string };
  return { server, baseUrl, adminToken: body.token ?? '', gateway, transport };
}

/** 打管理面（带合法管理员会话）。 */
async function adminApi(
  h: Harness,
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** 打数据面（任意第三方客户端的形态：只有请求体与请求头）。 */
async function dataPlane(
  h: Harness,
  payload: unknown,
  init: { headers?: Record<string, string>; query?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `${h.baseUrl}/v1/chat/completions${init.query === undefined ? '' : `?${init.query}`}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(payload),
    },
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function close(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await h.gateway.shutdown();
}

describe('内置对话：数据面鉴权豁免（真 DataPlaneAuthenticator，不是占位器）', () => {
  it('virtual_key 模式下不带客户端凭据也能过 S0，并真的打到上游', async () => {
    const h = await build([{ body: chat('已收到，用量归到 agent-builtin。') }]);
    try {
      const res = await adminApi(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      });
      // 修好之前这里是 502 + 「缺少 API key（Authorization: Bearer / x-api-key / ?key= 三选一）」
      expect(res.status).toBe(200);
      expect(res.body['ok']).toBe(true);
      expect(res.body['error']).toBeUndefined();
      expect(String(res.body['reply'])).toBe('已收到，用量归到 agent-builtin。');
      // 链路真的跑到了上游：证明不是"绕过了鉴权也绕过了上游"
      expect(h.transport.requests.length).toBe(1);
    } finally {
      await close(h);
    }
  });

  it('用量归因不丢：UsageRecord.auth.key_id 是固定的非人类 agent-builtin', async () => {
    const h = await build([{ body: chat('好') }]);
    try {
      const res = await adminApi(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      });
      expect(res.body['ok']).toBe(true);
      // 计量旁路是异步的（60 §2）：冲刷后再读
      await h.gateway.usageEmitter.flush();
      const records = h.gateway.usageSink?.records ?? [];
      expect(records.length).toBeGreaterThan(0);
      const last = records[records.length - 1]!;
      expect(last.auth.key_id).toBe('agent-builtin');
      // 不是匿名、也不是某把人类 key
      expect(last.auth.key_id).not.toBe('local-dev');
      expect(last.auth.key_id).not.toBe('pending');
    } finally {
      await close(h);
    }
  });

  it('流式同样过鉴权：SSE 的 agent 帧里没有 auth_failed', async () => {
    const h = await build([{ body: chat('第一段。第二段。') }]);
    try {
      const res = await fetch(`${h.baseUrl}/admin/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: true }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain('auth_failed');
      expect(text).toContain('event: agent');
    } finally {
      await close(h);
    }
  });
});

describe('内置对话：豁免不可从线上伪造（deny-first 没有被削弱）', () => {
  it('数据面客户端不带凭据 → 401', async () => {
    const h = await build([{ body: chat('不该走到') }]);
    try {
      const res = await dataPlane(h, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(401);
      expect(String((res.body['error'] as Record<string, unknown>)['code'])).toBe('auth_failed');
      expect(h.transport.requests.length).toBe(0);
    } finally {
      await close(h);
    }
  });

  it('数据面客户端把豁免标记写在头 / body 里也照样被拒', async () => {
    const h = await build([{ body: chat('不该走到') }]);
    try {
      // 客户端能想到的所有"伪造"途径：自定义头、格式头、请求体字段、query
      const res = await dataPlane(
        h,
        {
          model: 'deepseek-flash',
          messages: [{ role: 'user', content: 'hi' }],
          auth_exemption: { caller: 'agent-builtin' },
          first_party: 'agent-builtin',
          key_id: 'agent-builtin',
        },
        {
          headers: {
            'x-ag-auth-exemption': 'agent-builtin',
            'x-agentgateway-first-party': 'agent-builtin',
            'x-agentgateway-format': 'openai.chat',
          },
          query: 'auth_exemption=agent-builtin&first_party=agent-builtin',
        },
      );
      expect(res.status).toBe(401);
      expect(String((res.body['error'] as Record<string, unknown>)['code'])).toBe('auth_failed');
      // 一步都没往上走
      expect(h.transport.requests.length).toBe(0);
    } finally {
      await close(h);
    }
  });

  it('控制项：数据面客户端带真 virtual key → 200（那道门仍然在 discriminate）', async () => {
    const h = await build([{ body: chat('数据面照常工作') }]);
    try {
      const created = await adminApi(h, 'POST', '/admin/api/virtual-keys', { name: 'cli' });
      expect(created.status).toBe(200);
      const plaintext = String(created.body['plaintext']);
      expect(plaintext.startsWith('sk-ag-')).toBe(true);

      const res = await dataPlane(
        h,
        { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
        { headers: { authorization: `Bearer ${plaintext}` } },
      );
      expect(res.status).toBe(200);
      expect(h.transport.requests.length).toBe(1);
    } finally {
      await close(h);
    }
  });
});
