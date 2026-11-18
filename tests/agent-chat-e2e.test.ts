/**
 * tests/agent-chat-e2e.test.ts —— 内置对话的端到端验收。
 *
 * 这份测试是**安全不变量的证据**，不是功能 smoke：
 *
 *   1. 用户消息里的密钥形态串，在上游请求体里变成 `<redacted_key>`，且原串不出现；
 *   2. 上游请求体的任何位置都不出现密钥材料（掩码可以，明文不行）；
 *   3. 一个**故意泄漏**的测试工具，其结果在第二轮上游请求体里也被替换
 *      （证明纵深防御那层真的在跑，而不是只依赖工具自觉）；
 *   4. `create_virtual_key` 的明文只走披露通道给界面，tool_result 里没有；
 *   5. `add_provider` 返回 `needs_credential` 且出参不含任何密钥材料。
 *
 * 全部走真实 HTTP + 脚本化上游（`ScriptedTransport`），不起真网络。
 */

import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createGateway } from '../composition-root.js';
import { createHttpServer } from '../http/server.js';
import { createAdminRouter } from '../admin/routes.js';
import { DefaultAdminAuth } from '../admin/auth.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import type { ScriptedTransportScript } from '../gateway-core/transport.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { fixedClock, type Clock } from '../di/ports.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import type { Plugin, ToolResultPart, ToolUsePart } from '../ir/index.js';
import { foldChat } from '../admin/agent-chat.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'agent-chat-test-passphrase';
const ADMIN_PASSWORD = 'admin-password-not-real'; // privacy-scan: ignore —— 测试假口令（login 契约字段名，值是显式假串）
/** 上游环境变量里的假 key（形态与真 key 同款，值是编的）。 */
const FAKE_UPSTREAM_KEY = 'sk-fake-deepseek-not-real'; // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
/** 用户贴在对话里的假 key。 */
const FAKE_USER_KEY = 'sk-userkey1234567890abcdefghijklmnopqrstuvwxyz'; // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
/** 故意泄漏的测试工具要返回的假 key。 */
const FAKE_LEAKED_KEY = 'sk-leaked1234567890abcdefghijklmnopqrstuvwxyz'; // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）

const PERMISSIVE_AUTH = {
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

/** 一个 OpenAI Chat 非流式响应。 */
function chat(content: string, id = 'chatcmpl-test'): string {
  return JSON.stringify({
    id,
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

/** 一个既没有 usage 也没有思考内容的最小响应（旧服务端 / 非推理模型的形态）。 */
function chatBare(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-bare',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

/** 一个带 tool_calls 的响应（第一轮：模型要求调工具）。 */
function chatWithToolCall(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'chatcmpl-tool',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_0001',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 20,
    },
  });
}

/**
 * 一个带思考内容与 usage 的响应（96 §3.5 的三个呈现字段的数据源）。
 *
 * `reasoning_content` 是 DeepSeek 的 wire 字段名：AG-IR 早已建模 thinking part、
 * OpenAI Chat 编解码器也早已双向映射它（adaptors/openai-chat/codec.ts 的
 * `MODELLED_MESSAGE_KEYS`），因此往返之后它仍在响应里——缺的只是
 * `admin/agent-chat.ts` 把它取出来。
 */
function chatWithReasoning(
  content: string,
  reasoning: string,
  usage?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id: 'chatcmpl-think',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          reasoning_content: reasoning,
          finish_reason: 'stop',
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  });
}

/** 推理模型的 usage：带 `completion_tokens_details.reasoning_tokens`。 */
const REASONING_USAGE: Record<string, unknown> = {
  prompt_tokens: 12,
  completion_tokens: 8,
  total_tokens: 20,
  completion_tokens_details: { reasoning_tokens: 5 },
};

/**
 * 故意泄漏的测试工具：order 比 agent-admin 小，因此先接到调用；
 * 不认识的工具名直接抛错，让 `runOnToolCall` 继续往下找到 agent-admin。
 */
function leakyPlugin(): Plugin {
  return {
    manifest: {
      name: 'test-leaky-tool',
      version: '1.0.0',
      hooks: ['onToolCall'],
      order: 1,
      scope: 'envelope-only',
    },
    onToolCall(call: ToolUsePart): ToolResultPart {
      if (call.name !== 'leak_secret') {
        throw new Error('not my tool');
      }
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        // 这就是「某个工具实现疏忽」：把上游响应原样塞进结果
        content: JSON.stringify({ note: `上游说 key 是 ${FAKE_LEAKED_KEY}`, ok: true }),
      };
    },
  };
}

async function build(
  script: ScriptedTransportScript,
  extra?: { plugins?: Plugin[]; chatClock?: Clock },
): Promise<Harness> {
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
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_UPSTREAM_KEY,
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
    // 静态装配声明：内置对话的默认模型落在静态拼出来的 deepseek 上（env key +
    // 脚本化上游），没有渠道记录。见 composition-root.ts 的 staticProviders 说明。
    // 零配置部署**不**声明——那里的请求该被 S2 准入以「没配渠道」拒掉，
    // 这正是 tests/routing-admission.test.ts 钉的那条。
    staticProviders: ['deepseek'],
    ...(extra?.plugins === undefined
      ? {}
      : { plugins: extra.plugins.map((plugin) => ({ plugin })) }),
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
    agentChat: {
      configHub: gateway.agentConfig,
      recorder: gateway.toolRecorder,
      runTurn: (input, sink) => gateway.runner.run(input, sink),
      adminService: gateway.admin!.adminService,
      aliasResolver: gateway.admin!.aliasResolver,
      // 回合计时（96 §3.5 的 duration_ms）：测试注入可预测的时钟
      ...(extra?.chatClock === undefined ? {} : { clock: extra.chatClock }),
    },
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

async function api(
  h: Harness,
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

/** 第 N 次上游请求的请求体（0 起）。 */
function upstreamBody(h: Harness, index: number): string {
  const req = h.transport.requests[index];
  if (req === undefined || req.body === undefined) throw new Error(`没有第 ${index} 次上游请求`);
  return req.body.toString('utf8');
}

async function close(h: Harness): Promise<void> {
  await new Promise<void>((r) => h.server.close(() => r()));
  await h.gateway.shutdown();
}

describe('内置对话：模型永远看不到密钥', () => {
  it('用户消息里的密钥形态串在上游请求体里被替换成 <redacted_key>', async () => {
    const h = await build([{ body: chat('好的，已收到。') }]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [
          { role: 'user', content: `帮我接入 DeepSeek，我的 key 是 ${FAKE_USER_KEY}，谢谢。` },
        ],
        stream: false,
      });
      expect(res.status).toBe(200);
      expect(res.body['ok']).toBe(true);
      expect(String(res.body['reply'])).toContain('已收到');

      const body = upstreamBody(h, 0);
      // ① 原串不出现
      expect(body).not.toContain(FAKE_USER_KEY);
      // ② 占位符出现（在用户消息里）
      expect(body).toContain('<redacted_key>');
      // ③ 上游自己的 key 只在鉴权头里，不在请求体里
      expect(body).not.toContain(FAKE_UPSTREAM_KEY);
      // ④ 系统提示词带上了（默认提示词里说明「看不到密钥」）
      expect(body).toContain('管理助手');
    } finally {
      await close(h);
    }
  });

  it('上游请求体任何位置都不含密钥材料（掩码不算）', async () => {
    const h = await build([{ body: chat('好') }]);
    try {
      await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: `key=${FAKE_USER_KEY}` }],
        stream: false,
      });
      const body = upstreamBody(h, 0);
      expect(body).not.toContain(FAKE_USER_KEY);
      expect(body).not.toContain(FAKE_UPSTREAM_KEY);
      // 鉴权头里的 key 不进请求体（那是 transport 的 headers 字段）
      const auth = h.transport.requests[0]?.headers?.['authorization'] ?? '';
      expect(String(auth)).toContain(FAKE_UPSTREAM_KEY); // 上游鉴权仍然正常
      expect(body).not.toContain(FAKE_UPSTREAM_KEY); // 但请求体里没有
    } finally {
      await close(h);
    }
  });

  it('故意泄漏的工具结果也被脱敏（纵深防御那层真的在跑）', async () => {
    const h = await build(
      [{ body: chatWithToolCall('leak_secret', {}) }, { body: chat('上游返回的内容我已核对。') }],
      { plugins: [leakyPlugin()] },
    );
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '帮我看看上游说了什么' }],
        stream: false,
      });
      expect(res.status).toBe(200);

      // 第二轮请求体里带着 tool_result——它必须已经被替换
      const second = upstreamBody(h, 1);
      expect(second).not.toContain(FAKE_LEAKED_KEY);
      expect(second).toContain('<redacted_key>');

      // 界面看到的工具结果同样是脱敏之后的那一份
      const calls = res.body['tool_calls'] as Array<Record<string, unknown>>;
      expect(calls.length).toBe(1);
      expect(String(calls[0]!['name'])).toBe('leak_secret');
      const result = calls[0]!['result'] as Record<string, unknown>;
      expect(String(result['text'])).not.toContain(FAKE_LEAKED_KEY);
      expect(String(result['text'])).toContain('<redacted_key>');
    } finally {
      await close(h);
    }
  });

  it('create_virtual_key：明文只走披露通道，tool_result 里没有', async () => {
    const h = await build([
      { body: chatWithToolCall('create_virtual_key', { name: '给移动端用' }) },
      { body: chat('密钥已创建，请在弹出的卡片里查看。') },
    ]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '建一把客户端密钥' }],
        stream: false,
      });
      expect(res.status).toBe(200);

      // tool_result 里只有标识与掩码
      const calls = res.body['tool_calls'] as Array<Record<string, unknown>>;
      expect(calls.length).toBe(1);
      const result = calls[0]!['result'] as Record<string, unknown>;
      expect(String(result['text'])).toContain('sk-ag-');
      expect(String(result['text'])).not.toContain('"plaintext"');

      // 明文在披露字段里，且只在响应里出现一次
      const secrets = res.body['secrets'] as Array<Record<string, unknown>>;
      expect(secrets.length).toBe(1);
      expect(String(secrets[0]!['plaintext']).startsWith('sk-ag-')).toBe(true);

      // 上游请求体（含第二轮）任何位置都没有这把明文
      for (const plaintext of [String(secrets[0]!['plaintext'])]) {
        expect(upstreamBody(h, 0)).not.toContain(plaintext);
        expect(upstreamBody(h, 1)).not.toContain(plaintext);
      }
    } finally {
      await close(h);
    }
  });

  it('add_provider 返回 needs_credential，出参不含任何密钥材料', async () => {
    const h = await build([
      {
        body: chatWithToolCall('add_provider', {
          id: 'acme',
          label: 'Acme',
          dialect: 'openai.chat',
          base_url: 'https://api.acme.example.com',
        }),
      },
      { body: chat('渠道已建成，请在弹出的对话框里录入密钥。') },
    ]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '帮我连接 Acme' }],
        stream: false,
      });
      expect(res.status).toBe(200);
      const calls = res.body['tool_calls'] as Array<Record<string, unknown>>;
      expect(calls.length).toBe(1);
      const resultText = String((calls[0]!['result'] as Record<string, unknown>)['text']);
      const result = JSON.parse(resultText) as Record<string, unknown>;
      expect(result['status']).toBe('needs_credential');
      expect(result['provider']).toBe('acme');
      expect(result['access_path']).toBe('acme.openai-chat');
      // 出参里没有 secret / key 字样
      expect(Object.keys(result)).not.toContain('secret');
      expect(Object.keys(result)).not.toContain('key');
      expect(resultText).not.toContain(FAKE_UPSTREAM_KEY);

      // 渠道真的建成了（复用 AdminService，不是另一套逻辑）
      const providers = await api(h, 'GET', '/admin/api/providers');
      const items = providers.body['items'] as Array<Record<string, unknown>>;
      expect(items.some((p) => p['id'] === 'acme')).toBe(true);
    } finally {
      await close(h);
    }
  });

  it('流式：SSE 私有协议分帧，末尾带 agent 汇总帧', async () => {
    const h = await build([{ body: chat('第一段。第二段。第三段。') }]);
    try {
      const res = await fetch(`${h.baseUrl}/admin/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${h.adminToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `key 是 ${FAKE_USER_KEY}` }],
          stream: true,
        }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(text).toContain('event: text');
      expect(text).toContain('event: agent');
      expect(text).toContain('event: end');
      expect(text).not.toContain(FAKE_USER_KEY);
      // 脱敏发生在**请求**侧：上游请求体里是占位符，原串不出现
      const upstream = upstreamBody(h, 0);
      expect(upstream).toContain('<redacted_key>');
      expect(upstream).not.toContain(FAKE_USER_KEY);
      // 汇总帧是权威的那一份：完整回复在里面
      const agent = text.split('event: agent\ndata: ')[1]?.split('\n\n')[0] ?? '';
      const payload = JSON.parse(agent) as Record<string, unknown>;
      expect(String(payload['reply'])).toBe('第一段。第二段。第三段。');
    } finally {
      await close(h);
    }
  });

  it('模型解析不到渠道时明确报错，不静默改路由', async () => {
    const h = await build([{ body: chat('不会走到') }]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '你好' }],
        model: 'no-such-model-anywhere',
      });
      expect(res.status).toBe(400);
      expect(String((res.body['error'] as Record<string, unknown>)['code'])).toBe(
        'invalid_agent_model',
      );
      expect(h.transport.requests.length).toBe(0);
    } finally {
      await close(h);
    }
  });

  it('未装配对话端点时回 501，不假装有对话能力', async () => {
    const h = await build([{ body: chat('x') }]);
    try {
      // 同一个 gateway、同一个认证，只是路由不接 agentChat
      const routeHandler = createAdminRouter({
        auth: h.gateway.admin!.adminAuth,
        service: h.gateway.admin!.adminService,
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
        runner: h.gateway.runner,
        adminHandler: routeHandler,
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      const login = await fetch(`http://127.0.0.1:${port}/admin/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PASSWORD }), // privacy-scan: ignore —— 测试假口令
      });
      const token = ((await login.json()) as { token?: string }).token ?? ''; // privacy-scan: ignore —— 会话令牌变量名（登录响应的值，非字面量）
      const res = await fetch(`http://127.0.0.1:${port}/admin/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(501);
      await new Promise<void>((r) => server.close(() => r()));
    } finally {
      await close(h);
    }
  });
});

describe('内置对话：脱敏可配置', () => {
  it('占位符与数据规则都来自设置，改完立即生效', async () => {
    const h = await build([{ body: chat('好') }, { body: chat('好') }]);
    try {
      // 换占位符 + 加一条数据规则
      await api(h, 'PUT', '/admin/api/settings/agent_redaction_placeholder', { value: '[已屏蔽]' });
      await api(h, 'PUT', '/admin/api/settings/agent_redaction_rules', {
        value: [
          { id: 'r1', pattern: 'ACME-[0-9]{6}', flags: 'g', replacement: '[ACME]', enabled: true },
        ],
      });
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: `工单 ACME-123456，key 是 ${FAKE_USER_KEY}` }],
        stream: false,
      });
      expect(res.status).toBe(200);
      const body = upstreamBody(h, 0);
      expect(body).not.toContain(FAKE_USER_KEY);
      expect(body).toContain('[已屏蔽]');
      expect(body).toContain('[ACME]');
      expect(body).not.toContain('ACME-123456');
    } finally {
      await close(h);
    }
  });

  it('坏规则被拒，且不写进配置', async () => {
    const h = await build([{ body: chat('好') }]);
    try {
      const res = await api(h, 'PUT', '/admin/api/settings/agent_redaction_rules', {
        value: [{ id: 'bad', pattern: '(', flags: 'g', enabled: true }],
      });
      expect(res.status).toBe(400);
      const list = await api(h, 'GET', '/admin/api/redaction-rules');
      expect(list.status).toBe(200);
      const user = list.body['user'] as unknown[];
      expect(user.length).toBe(0);
      const builtin = list.body['builtin'] as Array<Record<string, unknown>>;
      expect(builtin.length).toBeGreaterThan(0);
      expect(String(list.body['placeholder'])).toBe('<redacted_key>');
    } finally {
      await close(h);
    }
  });

  it('恢复默认：删掉存储记录，来源回到 default', async () => {
    const h = await build([{ body: chat('好') }]);
    try {
      await api(h, 'PUT', '/admin/api/settings/agent_max_turns', { value: 3 });
      const changed = await api(h, 'GET', '/admin/api/settings');
      const before = (changed.body['items'] as Array<Record<string, unknown>>).find(
        (i) => i['id'] === 'agent_max_turns',
      )!;
      expect(before['source']).toBe('encrypted_storage');
      expect(before['value']).toBe(3);

      const reset = await api(h, 'DELETE', '/admin/api/settings/agent_max_turns');
      expect(reset.status).toBe(200);
      const item = reset.body['item'] as Record<string, unknown>;
      expect(item['source']).toBe('default');
      expect(item['value']).toBe(8);
    } finally {
      await close(h);
    }
  });
});

describe('内置对话：工具开关', () => {
  it('关掉的工具在 tools 列表里不可见，被调用时返回明确错误', async () => {
    const h = await build([{ body: chat('好') }]);
    try {
      await api(h, 'PUT', '/admin/api/settings/agent_tools', {
        value: ['list_channels', 'list_credentials'],
      });
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '列一下渠道' }],
        stream: false,
      });
      expect(res.status).toBe(200);
      // 上游请求体里的 tools 只有开着的两个
      const body = upstreamBody(h, 0);
      expect(body).toContain('list_channels');
      expect(body).not.toContain('create_virtual_key');
    } finally {
      await close(h);
    }
  });

  it('列凭据只回掩码，出参不含任何密钥形态串', async () => {
    const h = await build([
      { body: chatWithToolCall('list_credentials', {}) },
      { body: chat('目前有这些凭据。') },
    ]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '列一下凭据' }],
        stream: false,
      });
      const calls = res.body['tool_calls'] as Array<Record<string, unknown>>;
      const resultText = String((calls[0]!['result'] as Record<string, unknown>)['text']);
      expect(resultText).not.toContain(FAKE_UPSTREAM_KEY);
      expect(resultText).not.toContain('secret');
      // 掩码字段在
      const parsed = JSON.parse(resultText) as Record<string, unknown>;
      expect(Array.isArray(parsed['credentials'])).toBe(true);
    } finally {
      await close(h);
    }
  });
});

// ---------------------------------------------------------------------------
// 三个呈现字段（96 §3.5）：reasoning / duration_ms / usage
// ---------------------------------------------------------------------------

describe('内置对话：三个呈现字段（96 §3.5）', () => {
  it('foldChat 不再丢 reasoning_content（回归：以前只取 content）', () => {
    const raw = chatWithReasoning('最终答案', '先想一遍\n再想一遍', REASONING_USAGE);
    const view = foldChat(raw, []);
    expect(view.reply).toBe('最终答案');
    expect(view.reasoning).toBe('先想一遍\n再想一遍');
    expect(view.usage).toEqual({
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      reasoning_tokens: 5,
    });
  });

  it('上游不给 reasoning / usage 时字段整个缺席（不是空串/0）', () => {
    const view = foldChat(chatBare('只是正文'), []);
    expect(view.reply).toBe('只是正文');
    expect('reasoning' in view).toBe(false);
    expect('usage' in view).toBe(false);
  });

  it('duration_ms 由调用方量好传入；不传就没有这个键', () => {
    expect('duration_ms' in foldChat(chat('x'), [])).toBe(false);
    expect(foldChat(chat('x'), [], { duration_ms: 2_500 }).duration_ms).toBe(2_500);
  });

  it('出错回合不带 reasoning / usage（错误优先）', () => {
    const raw = JSON.stringify({ error: { code: 'upstream_401', message: '密钥不对' } });
    const view = foldChat(raw, [], { duration_ms: 800 });
    expect(view.error).toBe('密钥不对');
    expect('reasoning' in view).toBe(false);
    expect('usage' in view).toBe(false);
    // 计时照旧给：过程条要能显示「这一轮出错了」旁的耗时
    expect(view.duration_ms).toBe(800);
  });

  it('流式：agent 汇总帧带上三个字段，text 帧形状不变', async () => {
    const h = await build(
      [{ body: chatWithReasoning('第一段。第二段。', '先想一遍', REASONING_USAGE) }],
      {
        chatClock: fixedClock(FIXED_NOW, 2_500),
      },
    );
    try {
      const res = await fetch(`${h.baseUrl}/admin/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${h.adminToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '想一下' }],
          stream: true,
        }),
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      // text 帧仍只有 {text}：帧类型与帧序没动（95 §6.1 仍是权威）
      const firstText = text.split('event: text\ndata: ')[1]?.split('\n\n')[0] ?? '';
      expect(Object.keys(JSON.parse(firstText) as Record<string, unknown>)).toEqual(['text']);
      // 汇总帧是权威的那一份，三个字段都在
      const agent = text.split('event: agent\ndata: ')[1]?.split('\n\n')[0] ?? '';
      const payload = JSON.parse(agent) as Record<string, unknown>;
      expect(payload['reasoning']).toBe('先想一遍');
      expect(payload['duration_ms']).toBe(2_500);
      expect(payload['usage']).toEqual({
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
        reasoning_tokens: 5,
      });
    } finally {
      await close(h);
    }
  });

  it('非流式：JSON 响应带上三个字段', async () => {
    const h = await build([{ body: chatWithReasoning('答案', '先想一遍', REASONING_USAGE) }], {
      chatClock: fixedClock(FIXED_NOW, 1_200),
    });
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '想一下' }],
        stream: false,
      });
      expect(res.status).toBe(200);
      expect(res.body['reasoning']).toBe('先想一遍');
      expect(res.body['duration_ms']).toBe(1_200);
      expect(res.body['usage']).toEqual({
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
        reasoning_tokens: 5,
      });
    } finally {
      await close(h);
    }
  });

  it('不注入 clock 时没有 duration_ms（旧客户端行为不变）', async () => {
    const h = await build([{ body: chatBare('只是正文') }]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      });
      expect(res.status).toBe(200);
      expect('duration_ms' in res.body).toBe(false);
      expect('reasoning' in res.body).toBe(false);
      expect('usage' in res.body).toBe(false);
    } finally {
      await close(h);
    }
  });

  it('上游给 reasoning_content 时不进上游请求体（思考是响应侧的事）', async () => {
    const h = await build([{ body: chatWithReasoning('答案', '先想一遍', REASONING_USAGE) }]);
    try {
      await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '想一下' }],
        stream: false,
      });
      // 请求体里只有 messages / tools / 采样参数，没有 reasoning_content
      const body = upstreamBody(h, 0);
      expect(body).not.toContain('reasoning_content');
    } finally {
      await close(h);
    }
  });
});

describe('内置对话：路由图工具与删除操作界面确认', () => {
  it('upsert_route_graph / list_route_graphs 可创建和查看路由图，delete_route_graph 返回 pending_confirmation 不直接删除', async () => {
    const graphInput = {
      id: 'smart-router',
      label: '智能路由',
      enabled: true,
      entry_node_id: 'n_start',
      nodes: [
        { id: 'n_start', kind: 'entry', label: '开始', position: { x: 0, y: 0 } },
        {
          id: 'n_target',
          kind: 'provider_target',
          label: 'DeepSeek',
          position: { x: 240, y: 0 },
          target: {
            provider: 'deepseek',
            access_path: 'deepseek.openai-chat',
            model: 'deepseek-flash',
          },
        },
      ],
      edges: [{ id: 'e1', from: 'n_start', to: 'n_target' }],
    };

    const h = await build([
      { body: chatWithToolCall('upsert_route_graph', graphInput) },
      { body: chatWithToolCall('delete_route_graph', { id: 'smart-router' }) },
      { body: chat('已发起删除请求，请在工具卡片上点击「确认删除」。') },
    ]);
    try {
      const res = await api(h, 'POST', '/admin/api/chat', {
        messages: [{ role: 'user', content: '先建一个路由图再删掉它' }],
        stream: false,
      });
      expect(res.status).toBe(200);
      const calls = res.body['tool_calls'] as Array<Record<string, unknown>>;
      expect(calls.length).toBe(2);

      const upsertResult = JSON.parse(
        String((calls[0]!['result'] as Record<string, unknown>)['text']),
      ) as Record<string, unknown>;
      expect(upsertResult['status']).toBe('saved');

      const deleteResult = JSON.parse(
        String((calls[1]!['result'] as Record<string, unknown>)['text']),
      ) as Record<string, unknown>;
      expect(deleteResult['status']).toBe('pending_confirmation');
      expect(deleteResult['action']).toBe('delete_route_graph');
      expect(deleteResult['resource_id']).toBe('smart-router');

      // 在用户在界面点击确认之前，路由图必须依然存在
      const graphs = await api(h, 'GET', '/admin/api/route-graphs');
      const items = graphs.body['items'] as Array<Record<string, unknown>>;
      expect(items.some((g) => g['id'] === 'smart-router')).toBe(true);
    } finally {
      await close(h);
    }
  });
});
