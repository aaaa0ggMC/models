/**
 * tests/namespace-routing.test.ts —— provider namespace 路由的语义锁定。
 *
 * 覆盖任务书要求的四类用例：**命中 / 不命中 / 优先级 / 冲突拒绝对**，外加两条
 * 端到端（namespace 生效名在真实请求链路里被解析成裸 model id，且 fast path
 * 因此失效）与一条 `/v1/models` 的可发现性断言。
 *
 * 关键语义（实现在 admin/aliases.ts 的 DefaultAliasResolver.resolve）：
 *   1. 生效名 = `<namespace>/<model>`；namespace 留空 = 现状行为（无前缀）；
 *   2. 解析优先级：显式别名 → namespace → 通用前缀规则 → 原样 model id；
 *   3. 冲突**在配置时就拒**（两个渠道同 namespace / namespace 与显式别名撞名），
 *      错误信息要能说出撞的是谁；
 *   4. namespace 命中要求模型在该渠道的 access path 上**真实存在**（查能力矩阵）——
 *      打错字母时拿到明确的 no_available_provider，而不是被静默路由到上游收一个 400。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { TOKENS } from '../di/index.js';
import { DefaultAliasResolver } from '../admin/aliases.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { AdminService } from '../admin/service.js';

/** `upsertProvider` 的入参（从 service 方法上取，不自己复刻一份契约）。 */
type ProviderUpsertInput = Parameters<AdminService['upsertProvider']>[1];
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'namespace-routing-test-passphrase';

async function makeStore() {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  return new DefaultEncryptedRecordStore(ks.unlocked(), new InMemoryRawRecordStore(), clock);
}

/** 上游响应（OpenAI Chat 非流式；ScriptedTransport 用）。 */
function upstreamResponse(model: string) {
  return {
    id: 'chatcmpl-ns-test',
    object: 'chat.completion',
    created: FIXED_NOW,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

interface Harness {
  gateway: ReturnType<typeof createGateway>;
  resolver: DefaultAliasResolver;
  transport: ScriptedTransport;
}

/**
 * 建一个带管理面的网关（namespace 的写入面在管理面）。
 *
 * `deepseekKey: false` 时不注入 DEEPSEEK_API_KEY——自定义渠道走
 * `AG_<ACCESS_PATH_ID 大写>_API_KEY` 约定（`acme.openai-chat` →
 * `AG_ACME_OPENAI_CHAT_API_KEY`，与 AG_OPENAI_API_KEY 同一套命名）。
 */
async function harness(options: { env?: Record<string, string>; deepseekKey?: boolean } = {}) {
  const recordStore = await makeStore();
  // 能力查找必须指向**网关真正用的那个能力矩阵**：namespace 命中判据是"模型在该渠道的
  // access path 上真实存在"，而矩阵由 upsertProvider 往里登记。用空查找会让所有
  // namespace 命中 silently 失败（正是本测试第一版踩的坑）。
  // 用 holder 而不是 let：eslint 的 prefer-const 看不出"装配后再赋值"这个模式，
  // 而 let 在这里是正确的（resolver 先建、registry 后拿）。
  const holder: { registry?: CapabilityRegistry } = {};
  const resolver = new DefaultAliasResolver([], {
    list: (modality) =>
      (holder.registry?.list(modality) ?? []).map((e) => ({
        access_path: e.access_path,
        model: e.model,
      })),
  });
  const transport = new ScriptedTransport([
    { body: JSON.stringify(upstreamResponse('x')) },
    { body: JSON.stringify(upstreamResponse('x')) },
    { body: JSON.stringify(upstreamResponse('x')) },
  ]);
  const gateway = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    aliasResolver: resolver,
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      ...(options.deepseekKey === true ? { DEEPSEEK_API_KEY: 'sk-fake-test-not-real' } : {}),
      ...(options.env ?? {}),
    }),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
  });
  holder.registry = gateway.container.resolve(TOKENS.CapabilityRegistry);
  return { gateway, resolver, transport } satisfies Harness;
}

/**
 * 走一次管理面写入（不经 HTTP，直接调 service——HTTP 路由层由 admin-api.test.ts
 * 与 provider-ops.test.ts 覆盖）。
 *
 * 入参类型直接用 service 方法的参数类型（从 gateway 上取），契约改了这里立刻红。
 */
async function upsert(gateway: ReturnType<typeof createGateway>, input: ProviderUpsertInput) {
  return gateway.admin!.adminService.upsertProvider('test-actor', input);
}

describe('namespace：命中', () => {
  it('填了 namespace 的渠道 → `<ns>/<model>` 解析到该渠道的 access path 与裸 model', async () => {
    const { gateway, resolver } = await harness();
    const result = await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(result.ok).toBe(true);

    const resolved = resolver.resolve('acme/acme-model-1', 'chat');
    expect(resolved?.source).toBe('namespace');
    expect(resolved?.target).toMatchObject({
      provider: 'acme',
      access_path: 'acme.openai-chat',
      model: 'acme-model-1',
    });
    await gateway.shutdown();
  });

  it('namespace 留空 → 现状行为（生效名就是裸 id，`<ns>/` 不命中任何东西）', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    // 裸 id 照旧能走 passthrough（能力矩阵里有这条）
    expect(resolver.resolve('acme-model-1', 'chat')?.source).toBe('passthrough');
    // 但没有 namespace：任何前缀都不该命中
    expect(resolver.resolve('acme/acme-model-1', 'chat')).toBeUndefined();
    await gateway.shutdown();
  });

  it('同一渠道多个模型 → 每个都能用 `<ns>/<model>` 访问', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['m1', 'm2', 'm3'] },
    });
    for (const m of ['m1', 'm2', 'm3']) {
      expect(resolver.resolve(`acme/${m}`, 'chat')?.target.model).toBe(m);
    }
    await gateway.shutdown();
  });
});

describe('namespace：不命中', () => {
  it('模型不在该渠道的清单里 → 不命中 namespace（落到 passthrough 也失败 → 明确的 unknown）', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    // 打错一个字母：不静默路由到上游，而是解析不了
    expect(resolver.resolve('acme/acme-model-2', 'chat')).toBeUndefined();
    await gateway.shutdown();
  });

  it('前缀不是任何 namespace → 不命中（交给通用前缀规则 / passthrough）', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(resolver.resolve('other/acme-model-1', 'chat')).toBeUndefined();
    await gateway.shutdown();
  });

  it('`<ns>/` 后面是空串 → 不命中', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(resolver.resolve('acme/', 'chat')).toBeUndefined();
    await gateway.shutdown();
  });

  it('渠道被停用 → namespace 规则一并失效（请求路径不再认它）', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(resolver.resolve('acme/acme-model-1', 'chat')).toBeDefined();
    await gateway.admin!.adminService.setProviderEnabled('test-actor', 'acme', false);
    expect(resolver.resolve('acme/acme-model-1', 'chat')).toBeUndefined();
    await gateway.shutdown();
  });
});

describe('namespace：优先级', () => {
  it('显式别名与 namespace 各管一段：裸名走别名，`<ns>/` 走 namespace', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    // exact 别名的 pattern **不能含 /**（validateAliasRule 明令禁止），所以它永远
    // 不可能与 `<ns>/<model>` 这种生效名同串——两边各管一段，不存优先级胜负。
    // 这条测试锁住的就是"各管一段"这个事实，避免将来有人给 exact 开 `/` 的口子。
    await gateway.admin!.adminService.upsertAlias('test-actor', {
      kind: 'exact',
      pattern: 'acme-model-1',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
    });
    // 裸名 → exact 别名赢（而不是 passthrough 到 acme 自己身上）
    const bare = resolver.resolve('acme-model-1', 'chat');
    expect(bare?.source).toBe('exact');
    expect(bare?.target.access_path).toBe('deepseek.openai-chat');
    // 带 namespace 的名字 → namespace 赢，且目标模型就是裸名那一个
    const namespaced = resolver.resolve('acme/acme-model-1', 'chat');
    expect(namespaced?.source).toBe('namespace');
    expect(namespaced?.target.access_path).toBe('acme.openai-chat');
    await gateway.shutdown();
  });

  it('namespace > 通用前缀规则（窄的、有归属的规则赢）', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    // 一条宽前缀规则，前缀与 namespace 相同——它该被 namespace 压过
    await gateway.admin!.adminService.upsertAlias('test-actor', {
      kind: 'prefix',
      pattern: 'acme/',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
    });
    const resolved = resolver.resolve('acme/acme-model-1', 'chat');
    expect(resolved?.source).toBe('namespace');
    expect(resolved?.target.access_path).toBe('acme.openai-chat');
    await gateway.shutdown();
  });

  it('namespace 不命中时才轮到通用前缀规则', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    await gateway.admin!.adminService.upsertAlias('test-actor', {
      kind: 'prefix',
      pattern: 'acme/',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
    });
    // 模型不在 acme 的清单里 → namespace 不命中 → 落到前缀规则
    const resolved = resolver.resolve('acme/whatever', 'chat');
    expect(resolved?.source).toBe('prefix');
    expect(resolved?.target.model).toBe('deepseek-flash');
    await gateway.shutdown();
  });
});

describe('namespace：冲突在配置时拒绝', () => {
  it('两个渠道同 namespace → 保存即拒，且说出撞的是谁', async () => {
    const { gateway } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    const dup = await upsert(gateway, {
      id: 'other',
      label: 'Other',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['other-model'] },
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toContain('acme');
      expect(dup.error).toContain('渠道 acme 占用');
    }
    await gateway.shutdown();
  });

  it('namespace 与已存在的显式别名撞名 → 保存即拒，且说出别名是谁', async () => {
    const { gateway } = await harness();
    await gateway.admin!.adminService.upsertAlias('test-actor', {
      kind: 'exact',
      pattern: 'fast',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
    });
    const result = await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'fast',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('别名');
      expect(result.error).toContain('exact:fast');
    }
    await gateway.shutdown();
  });

  it('namespace 与已存在的前缀别名 `<ns>/` 撞名 → 同样拒', async () => {
    const { gateway } = await harness();
    await gateway.admin!.adminService.upsertAlias('test-actor', {
      kind: 'prefix',
      pattern: 'acme/',
      target: {
        provider: 'deepseek',
        access_path: 'deepseek.openai-chat',
        model: 'deepseek-flash',
      },
    });
    const result = await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('prefix:acme/');
    await gateway.shutdown();
  });

  it('改名换掉撞名的 namespace → 能存（冲突是配对关系，不是永久拒绝）', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    const retry = await upsert(gateway, {
      id: 'other',
      label: 'Other',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'other',
      model_source: { kind: 'static', models: ['other-model'] },
    });
    expect(retry.ok).toBe(true);
    expect(resolver.resolve('other/other-model', 'chat')?.target.provider).toBe('other');
    await gateway.shutdown();
  });

  it('非法 namespace（含 `/`、超长、首字符是符号）→ 保存即拒', async () => {
    const { gateway } = await harness();
    for (const bad of ['a/b', 'x'.repeat(33), '-acme', '.acme', 'acme ns']) {
      const result = await upsert(gateway, {
        id: 'acme',
        label: 'Acme',
        dialect: 'openai.chat',
        base_url: 'https://upstream.example.com',
        namespace: bad,
        model_source: { kind: 'static', models: ['acme-model-1'] },
      });
      expect(result.ok, `namespace "${bad}" 应该被拒`).toBe(false);
    }
    await gateway.shutdown();
  });
});

describe('namespace：真实请求链路（端到端）', () => {
  it('客户端发 `<ns>/<model>` → 上游收到的是裸 model id，且 fast path 因此失效', async () => {
    const { gateway, transport } = await harness({
      env: { AG_ACME_OPENAI_CHAT_API_KEY: 'sk-fake-acme-not-real' },
    });
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });

    const sink = new MemoryClientSink();
    const outcome = await gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'acme/acme-model-1',
            messages: [{ role: 'user', content: 'hi' }],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe(200);
    expect(transport.requests).toHaveLength(1);
    // 上游拿到的是裸 model id + 渠道自己配的 base_url
    expect(transport.requests[0]!.base_url).toBe('https://upstream.example.com');
    const upstreamBody = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      model: string;
    };
    expect(upstreamBody.model).toBe('acme-model-1');
    // 模型名被改写 → fast path 必须失效（否则字节透传会把 `acme/acme-model-1` 原样发出去）
    expect(outcome.fast_path).toBe(false);
    await gateway.shutdown();
  });

  it('未命中 namespace 的未知模型 → no_available_provider，**不打上游**', async () => {
    const { gateway, transport } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    const sink = new MemoryClientSink();
    const outcome = await gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'acme/nope',
            messages: [{ role: 'user', content: 'hi' }],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );
    expect(outcome.error?.code).toBe('no_available_provider');
    expect(transport.requests).toHaveLength(0);
    await gateway.shutdown();
  });

  it('被停用的渠道 → 请求被路由层挡下（enabled 有数据面消费者了）', async () => {
    const { gateway, transport } = await harness({
      env: { AG_ACME_OPENAI_CHAT_API_KEY: 'sk-fake-acme-not-real' },
    });
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    await gateway.admin!.adminService.setProviderEnabled('test-actor', 'acme', false);
    const sink = new MemoryClientSink();
    const outcome = await gateway.runner.run(
      {
        client_format: 'openai.chat',
        raw_body: Buffer.from(
          JSON.stringify({
            model: 'acme/acme-model-1',
            messages: [{ role: 'user', content: 'hi' }],
          }),
          'utf8',
        ),
        headers: { 'content-type': 'application/json' },
        path: '/v1/chat/completions',
        query: {},
      },
      sink,
    );
    expect(outcome.error?.code).toBe('no_available_provider');
    expect(transport.requests).toHaveLength(0);
    await gateway.shutdown();
  });
});

describe('namespace：/v1/models 可发现性', () => {
  it('每条记录同时暴露裸 id 与 namespace 生效名', async () => {
    const { gateway } = await harness({ env: { AG_ACME_OPENAI_CHAT_API_KEY: 'sk-fake-acme' } });
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    await gateway.models.ready();
    const list = await gateway.models.list({ provider: 'acme' });
    const record = list.data.find((r) => r.id === 'acme-model-1');
    expect(record).toBeDefined();
    // 裸 id 与生效名都在：客户端才能发现"这个模型有第二个名字"
    expect(record!.id).toBe('acme-model-1');
    expect(record!.namespaced_ids).toEqual(['acme/acme-model-1']);
    await gateway.shutdown();
  });

  it('配了 namespace 的渠道 → 裸 id 不再走 passthrough 绕过 namespace', async () => {
    const { gateway, resolver } = await harness();
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      namespace: 'acme',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    expect(resolver.resolve('acme-model-1', 'chat')).toBeUndefined();
    expect(resolver.resolve('acme/acme-model-1', 'chat')?.target).toMatchObject({
      provider: 'acme',
      model: 'acme-model-1',
    });
    await gateway.shutdown();
  });

  it('没配 namespace 的渠道 → 不出现 namespaced_ids 键（不是空数组）', async () => {
    const { gateway } = await harness({ env: { AG_ACME_OPENAI_CHAT_API_KEY: 'sk-fake-acme' } });
    await upsert(gateway, {
      id: 'acme',
      label: 'Acme',
      dialect: 'openai.chat',
      base_url: 'https://upstream.example.com',
      model_source: { kind: 'static', models: ['acme-model-1'] },
    });
    await gateway.models.ready();
    const list = await gateway.models.list({ provider: 'acme' });
    const record = list.data.find((r) => r.id === 'acme-model-1');
    expect(record).toBeDefined();
    expect(record!.namespaced_ids).toBeUndefined();
    await gateway.shutdown();
  });
});
