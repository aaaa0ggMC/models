/**
 * tests/alias-pipeline.test.ts —— 别名解析在**真实请求链路**里的行为锁定。
 *
 * 这两个 bug 都是本轮实现期间真实发现并修掉的，各自对应一条会静默出错的路径。
 * 没有这两条测试，它们随时会以同样的方式回归：
 *
 * ## Bug 1：fast path 透传原始字节，别名改写不到上游
 *
 * fast path 的合同是「透传原始字节，不做任何结构转换 / 字段重命名」
 * （fast-path.ts 的 FAST_PATH_FORBIDDEN）。而别名解析会把客户端传的 `model`
 * 换成上游真实 model id——这个改写只发生在 S4 的**慢路径**编码里。
 * 于是「客户端格式 == 上游格式 + 用了别名」这个最普通的组合，会静默把
 * **别名原样**发给上游：客户端拿到一个莫名的 400（上游不认识这个模型名），
 * 而网关侧 trace 显示一切正常。
 *
 * 修法：S2 消费 fast path 判定时加一条前置条件——模型名被改写就关掉 fast path
 * （不改 fast-path.ts 本身的任何逻辑）。
 *
 * ## Bug 2：openai-chat codec 不认 `resolved_model`
 *
 * `adaptors/anthropic-messages/codec.ts` 的 encode 用 `resolved_model ?? model`，
 * 而 `adaptors/openai-chat/codec.ts` 用 `req.model`。S2/S3/S4 三处都写
 * `resolved_model` 就是为了让 codec 用它；openai-chat 不读，别名在 OpenAI
 * 兼容面上永远不生效（Anthropic 面上却是好的）——同一功能两个方言表现不同，
 * 这种不一致比"两边都坏"更难排查。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createGateway } from '../composition-root.js';
import { DefaultAliasResolver } from '../admin/aliases.js';
import { InMemoryRawRecordStore, DefaultEncryptedRecordStore } from '../storage/record-store.js';
import { Keystore, PassphraseKekSource } from '../storage/keystore.js';
import { ScriptedTransport } from '../gateway-core/transport.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { InMemoryProviderProfileRegistry } from '../di/index.js';
import { createDeepSeekProfile } from '../providers/deepseek/index.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';

const FIXED_NOW = 1_760_000_000_000;
const clock = { now: () => FIXED_NOW };
const PASSPHRASE = 'alias-pipeline-test-passphrase';

/** mock 上游的 OpenAI Chat 非流式响应。 */
function mockOpenAiChatResponse() {
  return {
    id: 'chatcmpl-alias-test',
    object: 'chat.completion',
    created: 1_760_000_000,
    model: 'gpt-test-1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

async function makeRecordStore() {
  const ks = new Keystore(new PassphraseKekSource(), undefined, FIXED_NOW);
  await ks.unlock(PASSPHRASE);
  return new DefaultEncryptedRecordStore(ks.unlocked(), new InMemoryRawRecordStore(), clock);
}

/** 建一个带指定别名规则的网关。 */
async function gatewayWithAlias(
  rules: Parameters<DefaultAliasResolver['setRules']>[0],
  transport: ScriptedTransport,
  extra: { deepseekKey?: boolean } = {},
) {
  const recordStore = await makeRecordStore();
  const resolver = new DefaultAliasResolver([], {
    list: () => [
      { access_path: 'mock', model: 'gpt-test-1' },
      { access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
    ],
  });
  resolver.setRules(rules);
  const gw = createGateway({
    mode: 'test',
    transport,
    clock,
    recordStore,
    aliasResolver: resolver,
    ...(extra.deepseekKey === true
      ? { credentialResolver: new EnvCredentialResolver(undefined, undefined, { DEEPSEEK_API_KEY: 'sk-fake-test' }) }
      : {}),
    providerProfiles: (() => {
      const r = new InMemoryProviderProfileRegistry();
      r.register(createDeepSeekProfile());
      return r;
    })(),
  });
  return { gw, resolver };
}

async function runModel(gw: Awaited<ReturnType<typeof createGateway>>, model: string) {
  const sink = new MemoryClientSink();
  const outcome = await gw.runner.run(
    {
      client_format: 'openai.chat',
      raw_body: Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }), 'utf8'),
      headers: { 'content-type': 'application/json' },
      path: '/v1/chat/completions',
      query: {},
    },
    sink,
  );
  return { outcome, sink };
}

describe('Bug 1 回归：别名改写模型名时 fast path 必须失效', () => {
  it('同名格式 + 别名 → 上游收到的是解析后的 model，不是别名', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(mockOpenAiChatResponse()) }]);
    const { gw } = await gatewayWithAlias(
      [
        {
          id: 'r1',
          kind: 'exact',
          pattern: 'my-fast',
          target: { provider: 'mock', access_path: 'mock', model: 'gpt-test-1' },
          priority: 100,
          enabled: true,
        },
      ],
      transport,
    );

    const { outcome } = await runModel(gw, 'my-fast');
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe(200);
    // **关键断言**：上游看到的是 gpt-test-1，不是 my-fast
    expect(transport.requests).toHaveLength(1);
    const upstream = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      model: string;
    };
    expect(upstream.model).toBe('gpt-test-1');
    await gw.shutdown();
  });

  it('fast path 被明确关掉，且关掉的原因可观测', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(mockOpenAiChatResponse()) }]);
    const { gw } = await gatewayWithAlias(
      [
        {
          id: 'r1',
          kind: 'exact',
          pattern: 'my-fast',
          target: { provider: 'mock', access_path: 'mock', model: 'gpt-test-1' },
          priority: 100,
          enabled: true,
        },
      ],
      transport,
    );
    const { outcome } = await runModel(gw, 'my-fast');
    expect(outcome.fast_path).toBe(false);
    expect(outcome.materialized).toBe(true); // 走了完整编码
    await gw.shutdown();
  });

  it('模型名未被改写时 fast path 仍然生效（不因为别名功能变慢）', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(mockOpenAiChatResponse()) }]);
    const { gw } = await gatewayWithAlias(
      [
        {
          id: 'r1',
          kind: 'exact',
          // 别名指向同一个 model id：没有改写
          pattern: 'gpt-test-1',
          target: { provider: 'mock', access_path: 'mock', model: 'gpt-test-1' },
          priority: 100,
          enabled: true,
        },
      ],
      transport,
    );
    const { outcome } = await runModel(gw, 'gpt-test-1');
    expect(outcome.error).toBeUndefined();
    expect(outcome.fast_path).toBe(true);
    expect(outcome.materialized).toBe(false);
    await gw.shutdown();
  });

  it('前缀规则同样触发 fast path 失效', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(mockOpenAiChatResponse()) }]);
    const { gw } = await gatewayWithAlias(
      [
        {
          id: 'ns',
          kind: 'prefix',
          pattern: 'fast/',
          target: { provider: 'mock', access_path: 'mock', model: 'gpt-test-1' },
          priority: 100,
          enabled: true,
        },
      ],
      transport,
    );
    const { outcome } = await runModel(gw, 'fast/whatever');
    expect(outcome.fast_path).toBe(false);
    const upstream = JSON.parse(transport.requests[0]!.body?.toString('utf8') ?? '{}') as {
      model: string;
    };
    expect(upstream.model).toBe('gpt-test-1');
    await gw.shutdown();
  });
});

describe('Bug 2 回归：openai-chat codec 必须认 resolved_model', () => {
  /**
   * 直接用 pipeline 里 decode 出来的真信封调 encode——不手搓信封。
   * 手搓的最小信封缺字段（`encodeToolChoice` 要 trace.nodes 之类），
   * 那种测试测的是「我的假信封够不够真」，不是 codec 的行为。
   */
  async function encodeWith(
    wire: Record<string, unknown>,
    resolvedModel: string | undefined,
  ): Promise<{ model: string }> {
    const { OpenAIChatCodec } = await import('../adaptors/openai-chat/codec.js');
    const { MutableRequestContext } = await import('../gateway-core/context.js');
    const { fixedClock } = await import('../di/index.js');
    const ctx = new MutableRequestContext({
      request_id: 'req_codec_test',
      started_at: 0,
      deadline: 1000,
      client_format: 'openai.chat',
      client_raw_headers: {},
      auth: { key_id: 'k' },
    });
    const codec = new OpenAIChatCodec({ clock: fixedClock(0) });
    const canonical = codec.decode(Buffer.from(JSON.stringify(wire), 'utf8'), ctx as never);
    // decode 出来的信封顶层 model 是空串（model 在 payload 里），所以这里显式
    // 补上——模拟「S2 已经跑完、客户端模型名已在信封上」的状态。
    const envelope = {
      ...canonical,
      model: 'client-alias-name',
      ...(resolvedModel === undefined ? {} : { resolved_model: resolvedModel }),
    } as never;
    const encoded = codec.encode(envelope, ctx as never);
    // EncodedRequest.body 是 unknown（不一定是 Buffer）：可能是对象、可能是
    // Buffer。测试里两种都要能读，否则测的是序列化细节而不是 model 字段。
    const raw: unknown = encoded.body;
    const text =
      typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : JSON.stringify(raw);
    return JSON.parse(text) as { model: string };
  }

  const wire = {
    model: 'client-alias-name',
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('给了 resolved_model 就用它（别名 → 上游真实 model id）', async () => {
    const body = await encodeWith(wire, 'upstream-real-model');
    expect(body.model).toBe('upstream-real-model');
  });

  it('resolved_model 缺省时回落到客户端 model（dog-fooding 直调场景）', async () => {
    const body = await encodeWith(wire, undefined);
    expect(body.model).toBe('client-alias-name');
  });

  it('两个方言的 codec 行为一致（anthropic 侧本来就是 resolved_model ?? model）', async () => {
    // 这条测试锁的是「不一致」本身：曾经 openai-chat 用 req.model 而
    // anthropic-messages 用 resolved_model ?? model，同一功能两个方言表现不同。
    const { AnthropicMessagesCodec } = await import('../adaptors/anthropic-messages/codec.js');
    const { MutableRequestContext } = await import('../gateway-core/context.js');
    const { fixedClock } = await import('../di/index.js');
    const ctx = new MutableRequestContext({
      request_id: 'req_codec_parity',
      started_at: 0,
      deadline: 1000,
      client_format: 'anthropic.messages',
      client_raw_headers: {},
      auth: { key_id: 'k' },
    });
    const anthropicWire = {
      model: 'client-alias-name',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    };
    const ac = new AnthropicMessagesCodec({ clock: fixedClock(0) });
    const canonical = ac.decode(Buffer.from(JSON.stringify(anthropicWire), 'utf8'), ctx as never);
    const withResolved = ac.encode(
      { ...canonical, resolved_model: 'upstream-real-model' } as never,
      ctx as never,
    );
    const aRaw: unknown = withResolved.body;
    const aText =
      typeof aRaw === 'string' ? aRaw : Buffer.isBuffer(aRaw) ? aRaw.toString('utf8') : JSON.stringify(aRaw);
    const anthropicBody = JSON.parse(aText) as { model: string };
    expect(anthropicBody.model).toBe('upstream-real-model');

    const openaiBody = await encodeWith(wire, 'upstream-real-model');
    expect(openaiBody.model).toBe(anthropicBody.model);
  });
});

describe('没有别名解析器时行为完全不变', () => {
  it('不注入 aliasResolver → 静态 RouteTable 查表，fast path 判定不受影响', async () => {
    const transport = new ScriptedTransport([{ body: JSON.stringify(mockOpenAiChatResponse()) }]);
    const gw = createGateway({
      mode: 'test',
      transport,
      clock,
      routeTable: {
        aliases: {
          'gpt-test-1': { targets: [{ access_path: 'mock', provider: 'mock', model: 'gpt-test-1' }] },
        },
      },
    });
    const { outcome } = await runModel(gw, 'gpt-test-1');
    expect(outcome.error).toBeUndefined();
    // 别名与 model 同名 → 没有改写 → fast path 照旧
    expect(outcome.fast_path).toBe(true);
    await gw.shutdown();
  });
});
