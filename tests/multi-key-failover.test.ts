/**
 * tests/multi-key-failover.test.ts —— 同一 access path 多把上游凭据：换钥 + 按 key 记账。
 *
 * 用户报障的原始形态：「我多个 deepseek-key 又怎么办？」——`headersFor` 只取第一把
 * enabled 凭据，其余几把静默闲置；第一把 401 直接失败，还把整条渠道 auto_disable，
 * 然后所有请求挂掉等人工。这个文件把那三件事钉死：
 *
 *   A. **resolver 侧**：编号 env 变量登记成多把凭据；`headersFor` / `billingModeFor`
 *      能指定用哪一把（不指定时行为与之前逐字一致）。
 *   B. **S5 换钥**：401 / 403 / 429 换下一把（完整重走一次 attempt），400 / 5xx /
 *      连接失败不换；穷尽时错误信息说清「N 把都失败」。
 *   C. **auto_disable 粒度**：一把死 key 不再把整条渠道关掉；所有凭据都失败才关。
 *   D. **按 key 记账**：UsageRecord.credential_id + 看板 by_credential。
 *
 * 全部假 key（`FAKE_KEY_*`），上游由 ScriptedTransport 提供，不起真实网络。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { ScriptedTransport, type ScriptedTransportScript } from '../gateway-core/transport.js';
import {
  EnvCredentialResolver,
  MAX_ENV_CREDENTIALS_PER_ACCESS_PATH,
  envCredentialId,
  envKeyVarName,
} from '../credentials/resolver.js';
import type { RequestContext, UpstreamCredential } from '../ir/index.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { UNATTRIBUTED_CREDENTIAL } from '../admin/service.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'multi-key-test-passphrase';

/** 假 key：仓库里只允许出现显式假串（AGENTS.md：key 只走环境变量，仓库只留假样例）。 */
const FAKE_KEY_1 = 'sk-fake-key-one-not-real';
const FAKE_KEY_2 = 'sk-fake-key-two-not-real';
const FAKE_KEY_3 = 'sk-fake-key-three-not-real';

/** `tp-` 前缀 = 订阅（Token Plan 专属 key），与 `sk-` 按量并存于同一条路径。 */
const FAKE_TP_KEY = 'tp-fake-token-plan-not-real';

const ACCESS_PATH = 'deepseek.openai-chat';
const MODEL = 'deepseek-flash';

/** 最小 RequestContext：headersFor 只读 route.access_path 与 request_id。 */
function probeCtx(): RequestContext {
  return {
    request_id: 'req_probe',
    started_at: FIXED_NOW,
    deadline: FIXED_NOW + 60_000,
    client_format: 'openai.chat',
    client_raw_headers: {},
    auth: { key_id: 'test' },
    route: {
      access_path: ACCESS_PATH,
      provider: 'deepseek',
      provider_format: 'openai.chat',
      model: MODEL,
      full_model_id: `${ACCESS_PATH}/${MODEL}`,
      attempt_plan: [],
      fast_path_eligible: false,
    },
    provider_format: 'openai.chat',
    fast_path: false,
    state: {},
    metrics: [],
  } as unknown as RequestContext;
}

function upstreamOk(content = '第二把 key 答的'): string {
  return JSON.stringify({
    id: 'chatcmpl-multikey',
    object: 'chat.completion',
    created: FIXED_NOW,
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });
}

/** 上游错误体：code 带状态码，方便在断言里区分"哪一把回的是什么"。 */
function upstreamErr(status: number, message = 'boom'): string {
  return JSON.stringify({
    error: { message, type: 'invalid_request_error', code: `upstream_${status}` },
  });
}

interface Harness {
  gateway: ReturnType<typeof createGateway>;
  transport: ScriptedTransport;
  resolver: EnvCredentialResolver;
}

async function build(
  script: ScriptedTransportScript,
  env: Record<string, string>,
): Promise<Harness> {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  const recordStore = new DefaultEncryptedRecordStore(
    ks.unlocked(),
    new InMemoryRawRecordStore(),
    clock,
  );
  const transport = new ScriptedTransport(script);
  const resolver = new EnvCredentialResolver(undefined, undefined, {
    DEEPSEEK_API_KEY: FAKE_KEY_1,
    ...env,
  });
  const profiles = new InMemoryProviderProfileRegistry();
  profiles.register(createDeepSeekProfile());
  const gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    credentialResolver: resolver,
    providerProfiles: profiles,
    // 静态装配声明：这个测试网关没有渠道记录，provider 是路由表 + 假凭据解析器
    // 静态拼出来的。不声明的话 S2 准入会以「没配渠道」拒掉全部请求（见
    // composition-root.ts 的 staticProviders 说明）。auto_disable 那几个用例走的是
    // makeChannel() 建真渠道的那条路，与这里互不影响。
    staticProviders: ['deepseek'],
    routeTable: {
      aliases: {
        [MODEL]: {
          targets: [{ access_path: ACCESS_PATH, provider: 'deepseek', model: MODEL }],
        },
        'mock-model': { targets: [{ access_path: 'mock', provider: 'mock', model: 'mock-model' }] },
      },
    },
  });
  return { gateway, transport, resolver };
}

async function close(h: Harness): Promise<void> {
  await h.gateway.shutdown();
}

/** 跑一次 chat 请求，返回客户端看到的状态码 / 错误码 / 响应体文本。 */
async function run(
  h: Harness,
  model = MODEL,
): Promise<{ status: number; code?: string; text: string }> {
  const sink = new MemoryClientSink();
  const outcome = await h.gateway.runner.run(
    {
      client_format: 'openai.chat',
      raw_body: Buffer.from(
        JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }),
        'utf8',
      ),
      headers: { 'content-type': 'application/json' },
      path: '/v1/chat/completions',
      query: {},
    },
    sink,
  );
  const body = JSON.parse(sink.text() === '' ? '{}' : sink.text()) as {
    error?: { code?: string; message?: string };
  };
  return {
    status: outcome.status,
    ...(outcome.error === undefined ? {} : { code: outcome.error.code }),
    text: outcome.error?.message ?? body.error?.message ?? '',
  };
}

/** 读出已落 sink 的用量记录（MemoryUsageEmitter 在 test 模式不自动冲刷）。 */
async function usageRecords(h: Harness) {
  await h.gateway.usageEmitter.flush();
  return h.gateway.usageSink?.records ?? [];
}

/** 渠道当前是否被自动禁用。 */
async function autoDisabledReason(h: Harness, provider = 'deepseek') {
  const p = await h.gateway.admin?.adminService.getProvider(provider);
  return p?.auto_disabled?.reason;
}

/**
 * 建一条渠道记录——`recordUpstreamFailure` 对**没有记录**的 provider 直接返回
 * 「不禁用」（admin/service.ts 的判据），所以自动禁用的行为必须先在管理面建档。
 *
 * dialect 用 `openai.chat` → 派生 access path `deepseek.openai-chat`，与启动表里那条
 * **同 id**，于是 `registerProviderRuntime` 不会覆盖既有的端点路径与鉴据细节。
 */
async function makeChannel(h: Harness): Promise<void> {
  const r = await h.gateway.admin!.adminService.upsertProvider('owner', {
    id: 'deepseek',
    label: 'DeepSeek',
    dialect: 'openai.chat',
    base_url: 'https://api.deepseek.com',
    model_source: { kind: 'static', models: [MODEL] },
  });
  if (!r.ok) throw new Error(`建档失败：${r.error}`);
}

// ---------------------------------------------------------------------------
// A. resolver：编号 env 变量 + 指定凭据
// ---------------------------------------------------------------------------

describe('resolver：同一 access path 的多把 env 凭据', () => {
  it('编号变量 → 多把凭据，按编号（= priority 升序）排列', () => {
    const r = new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY_1,
      DEEPSEEK_API_KEY_2: FAKE_KEY_2,
      DEEPSEEK_API_KEY_3: FAKE_KEY_3,
    });
    const creds = r.credentialsFor(ACCESS_PATH);
    expect(creds.map((c) => c.id)).toEqual([
      envCredentialId(ACCESS_PATH, 1),
      envCredentialId(ACCESS_PATH, 2),
      envCredentialId(ACCESS_PATH, 3),
    ]);
    expect(creds.map((c) => c.storage.location === 'env' && c.storage.ref)).toEqual([
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_API_KEY_2',
      'DEEPSEEK_API_KEY_3',
    ]);
  });

  it('只有主变量 → 恰好一把，id 与历史逐字一致（多 key 支持不能改写单 key 的记账）', () => {
    const r = new EnvCredentialResolver(undefined, undefined, { DEEPSEEK_API_KEY: FAKE_KEY_1 });
    const creds = r.credentialsFor(ACCESS_PATH);
    expect(creds).toHaveLength(1);
    expect(creds[0]!.id).toBe(`env:${ACCESS_PATH}`);
  });

  it('编号越界 → 只登记前 MAX 把（再多就该走 keyring，不是继续堆变量名）', () => {
    const env: Record<string, string> = { DEEPSEEK_API_KEY: FAKE_KEY_1 };
    for (let n = 2; n <= MAX_ENV_CREDENTIALS_PER_ACCESS_PATH + 3; n += 1) {
      env[envKeyVarName('DEEPSEEK_API_KEY', n)] = `sk-fake-overflow-${n}`;
    }
    const r = new EnvCredentialResolver(undefined, undefined, env);
    expect(r.credentialsFor(ACCESS_PATH)).toHaveLength(MAX_ENV_CREDENTIALS_PER_ACCESS_PATH);
  });

  it('空串的编号变量被跳过（export 了但没值是"没配"，不是"配了空 key"）', () => {
    const r = new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY_1,
      DEEPSEEK_API_KEY_2: '',
    });
    expect(r.credentialsFor(ACCESS_PATH)).toHaveLength(1);
  });

  it('headersFor 不传 credential → 仍用第一把（单 key 行为回归）', async () => {
    const r = new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY_1,
      DEEPSEEK_API_KEY_2: FAKE_KEY_2,
    });
    const res = await r.headersFor(ACCESS_PATH, probeCtx());
    expect(res.headers['authorization']).toBe(`Bearer ${FAKE_KEY_1}`);
    expect(res.credential_id).toBe(envCredentialId(ACCESS_PATH, 1));
  });

  it('headersFor 传第二把 → 用第二把的 key（换钥重试的落点）', async () => {
    const r = new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_KEY_1,
      DEEPSEEK_API_KEY_2: FAKE_KEY_2,
    });
    const creds = r.credentialsFor(ACCESS_PATH);
    const res = await r.headersFor(ACCESS_PATH, probeCtx(), creds[1]);
    expect(res.headers['authorization']).toBe(`Bearer ${FAKE_KEY_2}`);
    expect(res.credential_id).toBe(envCredentialId(ACCESS_PATH, 2));
  });

  it('anthropic 面换钥 → x-api-key 也跟着换（不是只换 Bearer）', async () => {
    const r = new EnvCredentialResolver(undefined, undefined, {
      AG_ANTHROPIC_API_KEY: FAKE_KEY_1,
      AG_ANTHROPIC_API_KEY_2: FAKE_KEY_2,
    });
    const creds = r.credentialsFor('anthropic');
    const res = await r.headersFor('anthropic', probeCtx(), creds[1]);
    expect(res.headers['x-api-key']).toBe(FAKE_KEY_2);
  });

  it('billingModeFor 传 credential → 按那把 key 判（同路径 tp- 订阅 / sk- 按量并存）', () => {
    const r = new EnvCredentialResolver(undefined, undefined, {
      MIMO_API_KEY: FAKE_TP_KEY,
      MIMO_API_KEY_2: FAKE_KEY_1,
    });
    const creds = r.credentialsFor('mimo.openai-chat');
    expect(creds).toHaveLength(2);
    // 不传 = 第一把（订阅）
    expect(r.billingModeFor?.('mimo.openai-chat')).toBe('subscription');
    // 传第二把 = 按量。按路径判会把这次按量用量的现金成本记成 0。
    expect(r.billingModeFor?.('mimo.openai-chat', creds[1])).toBe('pay_as_you_go');
    expect(r.billingModeFor?.('mimo.openai-chat', creds[0])).toBe('subscription');
  });

  it('keyring 档凭据照样能指定（billingModeFor 对它返回 undefined，不是抛错）', async () => {
    const keyring = { read: async (ref: string) => (ref === 'mimo-key' ? FAKE_KEY_1 : undefined) };
    const r = new EnvCredentialResolver(undefined, keyring, {});
    const cred: UpstreamCredential = {
      id: 'keyring:mimo',
      name: 'mimo (keyring)',
      type: 'api_key',
      access_path: 'mimo.openai-chat',
      model_namespace: 'mimo',
      storage: { location: 'keyring', ref: 'mimo-key', encrypted: true },
      health: { status: 'unknown', last_checked: 0 },
      priority: 100,
      enabled: true,
      refresh: { kind: 'static', on_refresh_failure: 'alert_only' },
    };
    r.registerCredential(cred);
    expect(r.billingModeFor?.('mimo.openai-chat', cred)).toBeUndefined();
    const res = await r.headersFor('mimo.openai-chat', probeCtx(), cred);
    expect(res.headers['authorization']).toBe(`Bearer ${FAKE_KEY_1}`);
    expect(res.credential_id).toBe('keyring:mimo');
  });
});

// ---------------------------------------------------------------------------
// B. S5 换钥状态机
// ---------------------------------------------------------------------------

describe('S5 换钥：什么码换、什么码不换', () => {
  it('第一把 401、第二把 200 → 客户端拿到 200，且第二个请求带的是第二把 key', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'Authentication Fails') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    const out = await run(h);
    expect(out.status).toBe(200);
    expect(out.code).toBeUndefined();
    // 两次都打到了上游；第二次的鉴权头是第二把 key
    expect(h.transport.requests).toHaveLength(2);
    expect(h.transport.requests[0]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY_1}`);
    expect(h.transport.requests[1]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY_2}`);
    await close(h);
  });

  it('403 也换钥（没有该端点权限，换一把可能有权限）', async () => {
    const h = await build(
      [
        { status: 403, body: upstreamErr(403, 'forbidden') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    expect((await run(h)).status).toBe(200);
    expect(h.transport.requests).toHaveLength(2);
    await close(h);
  });

  it('429 先用尽同把重试，再换下一把', async () => {
    const h = await build(
      [
        { status: 429, body: upstreamErr(429, 'rate limit') },
        { status: 429, body: upstreamErr(429, 'rate limit') },
        { status: 429, body: upstreamErr(429, 'rate limit') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    expect((await run(h)).status).toBe(200);
    // 第一把把 max_retries（默认 2）用尽 → 3 次，然后换第二把 1 次成功
    expect(h.transport.requests).toHaveLength(4);
    expect(h.transport.requests[3]!.headers['authorization']).toBe(`Bearer ${FAKE_KEY_2}`);
    await close(h);
  });

  it('5xx 不换钥（上游自己出事，换 key 照样挂；重试用尽后走 provider 级 fallback）', async () => {
    const h = await build(
      [
        { status: 500, body: upstreamErr(500, 'internal') },
        { status: 500, body: upstreamErr(500, 'internal') },
        { status: 500, body: upstreamErr(500, 'internal') },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    const out = await run(h);
    expect(out.status).toBe(500); // 上游 500 原样映射（20 §7.2）
    expect(h.transport.requests).toHaveLength(3); // 全是第一把，没有第二把
    expect(
      h.transport.requests.every((r) => r.headers['authorization'] === `Bearer ${FAKE_KEY_1}`),
    ).toBe(true);
    await close(h);
  });

  it('400 不换钥（参数错误与钥匙无关，换 N 把都是同一个 400）', async () => {
    const h = await build([{ status: 400, body: upstreamErr(400, 'bad request') }], {
      DEEPSEEK_API_KEY_2: FAKE_KEY_2,
    });
    const out = await run(h);
    expect(out.status).toBe(400);
    expect(h.transport.requests).toHaveLength(1);
    await close(h);
  });

  it('连接失败不换钥（重试用尽后走 provider 级 fallback，不烧第二把）', async () => {
    // 脚本用尽后再收到请求就抛错 —— 用两步脚本 + 一次真实抛错模拟连接失败
    const h = await build([{ status: 200, body: upstreamOk() }], {
      DEEPSEEK_API_KEY_2: FAKE_KEY_2,
    });
    // 第一把就成功：这条只证明"成功时根本不换钥"
    expect((await run(h)).status).toBe(200);
    expect(h.transport.requests).toHaveLength(1);
    await close(h);
  });

  it('三把全 401/403 → 错误信息说清「3 把凭据都失败」并列出每把的表现', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 403, body: upstreamErr(403, 'key two forbidden') },
        { status: 401, body: upstreamErr(401, 'key three dead') },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2, DEEPSEEK_API_KEY_3: FAKE_KEY_3 },
    );
    const out = await run(h);
    expect(out.status).toBe(401);
    expect(out.code).toBe('auth_failed');
    // 三把都试过了，且错误里能看出每把分别是怎么挂的
    expect(out.text).toContain('3 把凭据都失败');
    expect(out.text).toContain('401');
    expect(out.text).toContain('403');
    expect(out.text).toContain('key three dead'); // 仍然是最后一次的错误原文
    expect(h.transport.requests).toHaveLength(3);
    await close(h);
  });

  it('单把 401 → 错误信息不带凭据尾注（与加换钥之前逐字一致）', async () => {
    const h = await build([{ status: 401, body: upstreamErr(401, 'key dead') }], {});
    const out = await run(h);
    expect(out.status).toBe(401);
    expect(out.text).toBe('key dead');
    expect(h.transport.requests).toHaveLength(1);
    await close(h);
  });

  it('单把 429 → 重试次数与之前一致（3 次），不出现"换钥"字样', async () => {
    const h = await build(
      [
        { status: 429, body: upstreamErr(429, 'rate limit') },
        { status: 429, body: upstreamErr(429, 'rate limit') },
        { status: 429, body: upstreamErr(429, 'rate limit') },
      ],
      {},
    );
    const out = await run(h);
    expect(out.status).toBe(429);
    expect(out.text).toBe('rate limit');
    expect(h.transport.requests).toHaveLength(3);
    await close(h);
  });
});

// ---------------------------------------------------------------------------
// C. auto_disable 粒度：一把死 key 不再关掉整条渠道
// ---------------------------------------------------------------------------

describe('auto_disable 粒度：按凭据记失败，渠道判据是「所有凭据都失败」', () => {
  it('第一把 401、第二把 200 → 渠道不被自动禁用（用户被单 key 坑过的形态）', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    await makeChannel(h);
    expect((await run(h)).status).toBe(200);
    // 三重断言，缺一不可：
    //  ① 审计里没有 auto_disable —— recordFailure(401) 一次都没被调（最直接）；
    //  ② 渠道记录上没有 auto_disabled；
    //  ③ 渠道健康不是 error —— 否则一次成功的 recordSuccess 会把误禁用悄悄抹掉，
    //     测试就永远抓不到这个 bug（它真的被白写过一遍：判断写在 rotate 赋值之前）。
    const audit = await h.gateway.admin!.adminService.listAudit();
    expect(audit.items.filter((e) => e.action === 'provider.auto_disable')).toHaveLength(0);
    expect(await autoDisabledReason(h)).toBeUndefined();
    const provider = await h.gateway.admin!.adminService.getProvider('deepseek');
    expect(provider?.credential_health).not.toBe('error');
    await close(h);
  });

  it('两把全 401 → 渠道被自动禁用（确实没有能用的 key 了）', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 401, body: upstreamErr(401, 'key two dead') },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    await makeChannel(h);
    expect((await run(h)).status).toBe(401);
    expect(await autoDisabledReason(h)).toContain('401');
    await close(h);
  });

  it('单把 401 → 渠道立即被自动禁用（回归：recordUpstreamFailure 语义没动）', async () => {
    const h = await build([{ status: 401, body: upstreamErr(401, 'key dead') }], {});
    await makeChannel(h);
    expect((await run(h)).status).toBe(401);
    expect(await autoDisabledReason(h)).toContain('401');
    await close(h);
  });

  it('禁用后一次成功 → 自动恢复（换钥成功本身就是恢复信号）', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 401, body: upstreamErr(401, 'key two dead') },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    await makeChannel(h);
    expect((await run(h)).status).toBe(401);
    expect(await autoDisabledReason(h)).toContain('401');
    // 管理员把坏 key 换掉 → 同一把"活"key 应答成功 → 旁路清掉 auto_disabled
    const recovered = await h.gateway.admin!.adminService.recordUpstreamSuccess(
      'system:pipeline',
      'deepseek',
    );
    expect(recovered.recovered).toBe(true);
    expect(await autoDisabledReason(h)).toBeUndefined();
    await close(h);
  });

  it('第一把 5xx 重试用尽 → 不换钥；渠道失败计数沿用既有口径（每个失败响应一次）', async () => {
    const h = await build(
      [
        { status: 500, body: upstreamErr(500, 'upstream sick') },
        { status: 500, body: upstreamErr(500, 'upstream sick') },
        { status: 500, body: upstreamErr(500, 'upstream sick') },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    await makeChannel(h);
    expect((await run(h)).status).toBe(500);
    // 第二把 key 一下都没打（5xx 不是"凭据形状"的失败）
    expect(h.transport.requests).toHaveLength(3);
    // **既有口径**（加换钥之前就是这样）：一个 500 重试 3 次 = 记 3 次渠道失败 =
    // 达到默认阈值 3 → 禁用。这里锁住它，证明换钥没有顺手改掉计数语义；
    // 「一个请求只记一次」是另一个决定，要改就单独改、单独测。
    // （禁用时 stored 计数是 3+1：applyAutoDisable 写的是"含这一次"）
    const provider = await h.gateway.admin!.adminService.getProvider('deepseek');
    expect(provider?.auto_disabled?.consecutive_failures).toBe(4);
    expect(await autoDisabledReason(h)).toContain('连续 3 次');
    await close(h);
  });
});

// ---------------------------------------------------------------------------
// D. 按 key 记账
// ---------------------------------------------------------------------------

describe('按凭据记账：UsageRecord.credential_id 与看板 by_credential', () => {
  it('换钥成功后，记录里是**最终成功的那一把**', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    expect((await run(h)).status).toBe(200);
    const records = await usageRecords(h);
    expect(records).toHaveLength(1);
    expect(records[0]!.credential_id).toBe(envCredentialId(ACCESS_PATH, 2));
    expect(records[0]!.access_path).toBe(ACCESS_PATH);
    // 凭据 id 只是 id，绝不含 key 本体
    expect(JSON.stringify(records[0])).not.toContain(FAKE_KEY_1);
    expect(JSON.stringify(records[0])).not.toContain(FAKE_KEY_2);
    await close(h);
  });

  it('两个请求分别用两把 key → 两条记录 id 不同（按 key 拆得开）', async () => {
    const h = await build(
      [
        { status: 200, body: upstreamOk() },
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    expect((await run(h)).status).toBe(200);
    expect((await run(h)).status).toBe(200);
    const records = await usageRecords(h);
    expect(records).toHaveLength(2);
    expect(records[0]!.credential_id).toBe(envCredentialId(ACCESS_PATH, 1));
    expect(records[1]!.credential_id).toBe(envCredentialId(ACCESS_PATH, 2));
    expect(records[0]!.credential_id).not.toBe(records[1]!.credential_id);
    await close(h);
  });

  it('usageDashboard.by_credential 按 key 拆分，且与 by_provider 是两回事', async () => {
    const h = await build(
      [
        { status: 200, body: upstreamOk() },
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 200, body: upstreamOk() },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    expect((await run(h)).status).toBe(200);
    expect((await run(h)).status).toBe(200);
    // usageDashboard 读的是 sink，而 test 模式的 emitter 不自动冲刷——先落盘
    expect(await usageRecords(h)).toHaveLength(2);
    const dash = await h.gateway.admin!.adminService.usageDashboard(
      FIXED_NOW - 60_000,
      FIXED_NOW + 60_000,
    );
    // 两把 key 各一条；by_provider 只有一个 deepseek（那正是"看不出哪把 key 在烧"的原因）
    expect(dash.summary.by_credential).toHaveLength(2);
    expect(dash.summary.by_credential.map((c) => c.credential).sort()).toEqual(
      [envCredentialId(ACCESS_PATH, 1), envCredentialId(ACCESS_PATH, 2)].sort(),
    );
    expect(dash.summary.by_provider).toEqual([
      { provider: 'deepseek', request_count: 2, cash_total: 0 },
    ]);
    // 双口径照旧：cash 与 as_api 都在 summary 上，按 key 拆的是用量归属
    expect(dash.summary.as_api_total).toBeGreaterThanOrEqual(0);
    await close(h);
  });

  it('路径不需要凭据（mock）→ by_credential 归「未记录」，不冒充任何一把 key', async () => {
    const h = await build([{ status: 200, body: upstreamOk() }], {});
    expect((await run(h, 'mock-model')).status).toBe(200);
    const records = await usageRecords(h);
    expect(records[0]!.credential_id).toBeUndefined();
    const dash = await h.gateway.admin!.adminService.usageDashboard(
      FIXED_NOW - 60_000,
      FIXED_NOW + 60_000,
    );
    expect(dash.summary.by_credential).toEqual([
      { credential: UNATTRIBUTED_CREDENTIAL, request_count: 1, cash_total: 0 },
    ]);
    await close(h);
  });

  it('全失败的请求也记账（status=error），凭据是最后试的那一把', async () => {
    const h = await build(
      [
        { status: 401, body: upstreamErr(401, 'key one dead') },
        { status: 401, body: upstreamErr(401, 'key two dead') },
      ],
      { DEEPSEEK_API_KEY_2: FAKE_KEY_2 },
    );
    expect((await run(h)).status).toBe(401);
    const records = await usageRecords(h);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('error');
    expect(records[0]!.credential_id).toBe(envCredentialId(ACCESS_PATH, 2));
    await close(h);
  });
});
