/**
 * tests/models-openai-sdk.test.ts —— **官方 OpenAI SDK** 的 drop-in 兼容性证明。
 *
 * 任务书要求："多余键必须被真实 OpenAI SDK 客户端忽略（写一个用官方 SDK 解析响应的测试
 * 证明 drop-in 不受影响）"——本文件就是那个测试：不起 mock、不手写断言形状，直接用
 * `openai` 包（devDependency）的 `OpenAI` 客户端打我们的 `/v1/models`，让 SDK 自己的
 * 类型与解析逻辑来验收。
 *
 * 为什么可以安全地加这个 devDependency：`openai` 只出现在测试里，不进生产依赖
 * （package.json 的 dependencies 仍是空的），网关运行时不 import 它。
 *
 * 断言的立场：
 *   1. SDK 认识的四个键（id / object / created / owned_by）必须都在且类型正确；
 *   2. SDK **不认识**的扩展键（provenance / access_paths / pricing / constraints…）不能
 *      让 SDK 报错或丢数据——它们原样穿过，只是 SDK 的类型不暴露它们；
 *   3. 错误路径走 SDK 自己的错误类型（404 → NotFoundError），与打真 OpenAI 的行为一致。
 *
 * 2026-11-16 追加 `client.responses.create()` 一节（42-openai-responses-access.md
 * §7.1 的「入站脸 drop-in」）：期一把 `openai.responses` 的**客户端脸**落地后，用官方 SDK
 * 的 Responses 入口打我们自己的 `POST /v1/responses`，证明「不起 mock、SDK 自己解析」。
 * 上游由注入的 ScriptedTransport 提供（打的是 `deepseek.openai-chat`，即 42 §5.2
 * 期一的最小闭环），**不碰真实上游**；`[DONE]` / 事件名 / 形状全部由 SDK 的类型系统验收。
 */

import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { APIPromise, type Fetch as OpenAIFetch } from 'openai/core';
import type { ModelsPage, Model as OpenAIModel } from 'openai/resources/models';
import type { Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { createModelsEndpoints, type ModelsEndpoints } from '../http/models-endpoint.js';
import { createGateway } from '../composition-root.js';
import { EnvCredentialResolver } from '../credentials/resolver.js';
import { MemoryClientSink } from '../gateway-core/pipeline/sink.js';
import { ScriptedTransport, type ScriptedTransportScript } from '../gateway-core/transport.js';
import { createDefaultProviderProfiles, defaultRouteTable } from '../composition-root.js';

const BASE = 'http://agentgateway.test';
/** 假 key：只用于让 `EnvCredentialResolver` 把 deepseek 登记成"已配置"（值不进任何断言）。 */
const FAKE_DEEPSEEK_KEY = 'sk-test-not-a-real-key';

/** 把我们的处理器包成一个 OpenAI SDK 能用的 fetch（不起真服务）。 */
function sdkClient(endpoints: ModelsEndpoints): OpenAI {
  // 不按 openai 的 `Fetch` 类型签：那个类型绑到 node-fetch 的 Response，与 Node 内置
  // fetch 的 Response 不兼容（SDK 自己两种运行时都支持）。这里用结构化入参 + 调用处
  // 一次性断言，测试替身不需要替 SDK 的类型系统较劲。
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url ?? input);
    const url = new URL(raw, BASE);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    let result: { status: number; body: unknown };
    if (method === 'GET' && path === '/v1/models') {
      result = await endpoints.listModels(url.searchParams);
    } else if (method === 'GET' && path.startsWith('/v1/models/')) {
      result = await endpoints.getModel(path.slice('/v1/models/'.length));
    } else {
      result = {
        status: 404,
        body: { error: { message: `unrouted: ${method} ${path}`, type: 'not_found' } },
      };
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return new OpenAI({
    apiKey: 'test-not-a-real-key',
    // 直接断言到 SDK 自己的 Fetch 类型：全局 `fetch` 的类型（@types/node 的重载版）
    // 与 SDK 的 Fetch 不兼容，两者本就不是同一个 Response 类型
    fetch: fetchImpl as unknown as OpenAIFetch,
    maxRetries: 0,
  });
}

function buildEndpoints(): ModelsEndpoints {
  // 注入一把假 DeepSeek key：`/v1/models` 只列已配置 provider 的模型（判据读渠道表 +
  // 凭据库，见 composition-root.ts 的 providerAvailabilityResolver）
  const gateway = createGateway({
    mode: 'test',
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
    }),
  });
  return createModelsEndpoints({
    catalog: gateway.models,
    sync: gateway.modelSync,
  });
}

describe('OpenAI SDK · models.list() drop-in', () => {
  it('SDK 能无修正地解析我们的列表响应', async () => {
    const client = sdkClient(buildEndpoints());
    const page: ModelsPage = await client.models.list();

    expect(page.object).toBe('list');
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length).toBeGreaterThan(0);

    for (const model of page.data) {
      // SDK 类型承诺的四个键：必须都在且类型正确（少一个就是破坏 drop-in）
      expect(typeof model.id).toBe('string');
      expect(model.object).toBe('model');
      expect(typeof model.owned_by).toBe('string');
      if (model.created !== undefined) expect(typeof model.created).toBe('number');
    }

    const ids = page.data.map((m) => m.id);
    expect(ids).toContain('deepseek-flash');
    expect(ids).toContain('deepseek-v4-pro');
    // 退役别名不在列表里（OpenAI 客户端按 id 挑模型，不该看到已退役的）
    expect(ids).not.toContain('deepseek-chat');
  });

  it('SDK 认识四个键、但不被扩展键干扰（superset 立场）', async () => {
    const client = sdkClient(buildEndpoints());
    const page = await client.models.list();
    const flash = page.data.find((m) => m.id === 'deepseek-flash');
    expect(flash).toBeDefined();
    // 扩展键在**传输层**原样存在（SDK 只是类型不暴露它们，不是删掉它们）。
    // 注意：列表默认是紧凑字段集——provenance / access_paths 走 ?expand= 或详情端点，
    // 所以这里直接断言紧凑集里该有的扩展键，再用 expand=all 证明全量仍在。
    const raw = flash as unknown as Record<string, unknown>;
    expect(raw['pricing']).toBeDefined();
    expect(raw['context_window']).toBe(1_048_576);
    expect(raw['effort']).toBeDefined();
    // 而 SDK 侧读到的仍是干净的 OpenAI 形状
    expect(Object.keys(flash as object)).toContain('owned_by');
    expect((flash as OpenAIModel).object).toBe('model');
  });

  it('expand=all 时扩展键全量穿过 SDK（superset 没有被瘦身破坏）', async () => {
    const client = sdkClient(buildEndpoints());
    // SDK 的 basePath 是 /v1，所以这里传 /models（拼起来就是 /v1/models）；
    // client.get 返回的是已解析的 body
    const body = (await client.get('/models?expand=all')) as {
      data: Array<Record<string, unknown>>;
    };
    const flash = body.data.find((m) => m['id'] === 'deepseek-flash');
    expect(flash?.['provenance']).toBeDefined();
    expect(flash?.['access_paths']).toBeDefined();
    expect(flash?.['constraints']).toBeDefined();
    expect(flash?.['raw']).toBeDefined();
  });

  it('每条记录都能 JSON 往返（SDK 会序列化/反序列化，不能有 undefined 或环）', async () => {
    const client = sdkClient(buildEndpoints());
    const page = await client.models.list();
    for (const model of page.data) {
      const text = JSON.stringify(model);
      expect(typeof text).toBe('string');
      const back = JSON.parse(text) as OpenAIModel;
      expect(back.id).toBe(model.id);
      expect(back.object).toBe('model');
    }
  });

  it('SDK 的 APIPromise 形态也能用（.then / await 一致）', async () => {
    const client = sdkClient(buildEndpoints());
    const promise: APIPromise<ModelsPage> = client.models.list();
    const page = await promise;
    expect(page.data.length).toBeGreaterThan(0);
  });
});

describe('OpenAI SDK · models.retrieve() drop-in', () => {
  it('SDK 能取到单个模型', async () => {
    const client = sdkClient(buildEndpoints());
    const model: OpenAIModel = await client.models.retrieve('deepseek-flash');
    expect(model.id).toBe('deepseek-flash');
    expect(model.object).toBe('model');
    expect(model.owned_by).toBe('deepseek');
    expect(typeof model.created).toBe('number');
  });

  it('退役别名：SDK 拿到的是它自己的错误类型（与打真 OpenAI 一致）', async () => {
    const client = sdkClient(buildEndpoints());
    // OpenAI SDK 把 404 映射成 NotFoundError；message 里带我们的退役解释
    await expect(client.models.retrieve('deepseek-chat')).rejects.toThrow(/退役/);
    await expect(client.models.retrieve('deepseek-chat')).rejects.toBeInstanceOf(
      OpenAI.NotFoundError,
    );
  });

  it('完全未知的 id：同样 404 → NotFoundError', async () => {
    const client = sdkClient(buildEndpoints());
    await expect(client.models.retrieve('no-such-model')).rejects.toBeInstanceOf(
      OpenAI.NotFoundError,
    );
  });
});

describe('OpenAI SDK · 查询参数（SDK 之外的兼容面）', () => {
  it('把过滤/排序查询串直接喂给 SDK 的 fetch 层（LiteLLM 一类中间层就是这么用的）', async () => {
    const endpoints = buildEndpoints();
    const client = sdkClient(endpoints);
    // SDK 的 models.list() 不接受查询参数，所以这里直接用底层 get：
    // 证明"带查询串的 GET /v1/models"与 SDK 路径走同一份处理器
    // SDK 的 basePath 是 /v1，所以这里传 /models（拼起来就是 /v1/models）。
    // client.get 返回的是**已解析的 body**（SDK 内部做了 safeJSON），不是 Response。
    const body = (await client.get('/models?owned_by=deepseek&sort=-context_window')) as {
      object: string;
      data: Array<{ id: string; context_window: number }>;
    };
    expect(body.object).toBe('list');
    // owned_by=deepseek 现在也含两个音频端点（deepseek-tts / deepseek-asr）——
    // 它们是真的能力（/v1/audio/speech 与 /v1/audio/transcriptions），该被列出来
    expect(body.data.map((m) => m.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-asr',
      'deepseek-tts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// OpenAI SDK · responses.create() drop-in（42 §7.1「入站脸 drop-in」）
// ---------------------------------------------------------------------------

/** DeepSeek Chat Completions 非流式响应（42 §5.2 期一的最小闭环：上游仍是 openai-chat）。 */
function deepseekChatResponseForResponses(): Record<string, unknown> {
  return {
    id: 'chatcmpl-responses-test0001',
    object: 'chat.completion',
    created: 1_763_000_500,
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Paris is 18C with light rain.' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  };
}

/** DeepSeek Chat Completions 流式 SSE（usage 搭最后一个 chunk）。 */
function deepseekSseForResponses(): string[] {
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
    usage?: Record<string, unknown>,
  ): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-responses-stream1',
      object: 'chat.completion.chunk',
      created: 1_763_000_500,
      model: 'deepseek-flash',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  return [
    chunk({ role: 'assistant', content: '' }),
    chunk({ content: 'Paris is ' }),
    chunk({ content: '18C with light rain.' }),
    chunk({}, 'stop', {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 2 },
    }),
    'data: [DONE]\n\n',
  ];
}

/**
 * 把网关 runner 包成一个 OpenAI SDK 能用的 fetch（不起真服务）。
 *
 * `POST /v1/responses` 走完整管道（S0–S10），上游由注入的 ScriptedTransport 提供。
 * 这样 SDK 打的是**我们自己的端点**，与 42 §7.2 冒烟第 1 条「不依赖上游」同立场。
 */
function responsesSdkClient(script: ScriptedTransportScript): {
  client: OpenAI;
  requests: string[];
} {
  const transport = new ScriptedTransport(script);
  const gateway = createGateway({
    mode: 'test',
    transport,
    routeTable: defaultRouteTable(),
    credentialResolver: new EnvCredentialResolver(undefined, undefined, {
      DEEPSEEK_API_KEY: FAKE_DEEPSEEK_KEY,
    }),
    providerProfiles: createDefaultProviderProfiles(),
  });
  const requests: string[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: unknown }).url ?? input);
    const url = new URL(raw, BASE);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/v1/responses') {
      requests.push(url.pathname);
      const sink = new MemoryClientSink();
      const outcome = await gateway.runner.run(
        {
          client_format: 'openai.responses',
          raw_body: Buffer.from(typeof init?.body === 'string' ? init.body : '{}', 'utf8'),
          headers: { 'content-type': 'application/json' },
          path: '/v1/responses',
          query: {},
        },
        sink,
      );
      const status = outcome.error?.http_status ?? sink.startStatus ?? 200;
      return new Response(sink.text(), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        error: { message: `unrouted: ${method} ${url.pathname}`, type: 'not_found' },
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  };
  return {
    client: new OpenAI({
      apiKey: 'test-not-a-real-key',
      fetch: fetchImpl as unknown as OpenAIFetch,
      maxRetries: 0,
    }),
    requests,
  };
}

describe('OpenAI SDK · responses.create() drop-in（42 §7.1 入站脸）', () => {
  it('SDK 能无修正地打我们的 POST /v1/responses 并解析出 Responses 形状', async () => {
    const { client, requests } = responsesSdkClient([
      { body: JSON.stringify(deepseekChatResponseForResponses()) },
    ]);
    const res: OpenAIResponse = await client.responses.create({
      model: 'deepseek-flash',
      instructions: 'You are a helpful assistant.',
      input: 'What is the weather in Paris?',
      max_output_tokens: 256,
    });

    expect(requests).toEqual(['/v1/responses']);
    // SDK 类型承诺的键：object / status / output / usage 必须都在且形状正确
    expect(res.object).toBe('response');
    expect(res.id).toBeTypeOf('string');
    expect(res.status).toBe('completed');
    expect(Array.isArray(res.output)).toBe(true);
    expect(res.output).toHaveLength(1);
    const first = res.output[0];
    expect(first?.type).toBe('message');
    // 文本内容：SDK 的 output_text 解析路径真的走通了（不是我们手写断言形状）
    const text = res.output_text;
    expect(text).toBe('Paris is 18C with light rain.');
    // usage 五槽：SDK 的 ResponseUsage 形状
    expect(res.usage?.input_tokens).toBe(12);
    expect(res.usage?.output_tokens).toBe(8);
    expect(res.usage?.total_tokens).toBe(20);
    expect(res.usage?.input_tokens_details?.cached_tokens).toBe(4);
    expect(res.usage?.output_tokens_details?.reasoning_tokens).toBe(2);
  });

  it('流式：SDK 的 responses.stream 能消费我们的事件序列（无 [DONE]，终事件带 usage）', async () => {
    const { client } = responsesSdkClient([{ chunks: deepseekSseForResponses() }]);
    const stream = client.responses.stream({
      model: 'deepseek-flash',
      instructions: 'You are a helpful assistant.',
      input: 'What is the weather in Paris?',
      max_output_tokens: 256,
    });

    const deltas: string[] = [];
    let completed: OpenAIResponse | undefined;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        deltas.push(event.delta);
      } else if (event.type === 'response.completed') {
        completed = event.response;
      }
    }
    // 文本增量被完整拼回来
    expect(deltas.join('')).toBe('Paris is 18C with light rain.');
    // 终事件带 usage（40 §2.3：Responses 的 usage 恒搭终事件）
    expect(completed?.status).toBe('completed');
    expect(completed?.usage?.input_tokens).toBe(12);
    expect(completed?.usage?.output_tokens).toBe(8);
    // SDK 的 finalResponse 与 completed 事件一致
    // SDK 的 `finalResponse()` 在「没有可自动解析的结构化输出」时走
    // `maybeParseResponse` 的早退分支，那个分支不挂 `output_text` getter（SDK 自身的行为，
    // 与我们的实现无关）——因此这里断言语义等价的 `output[].content[].text`。
    const final = await stream.finalResponse();
    expect(final.output).toHaveLength(1);
    const item = final.output[0];
    expect(item?.type).toBe('message');
    if (item?.type !== 'message') throw new Error('expected message item');
    expect(item.content[0]?.type).toBe('output_text');
    if (item.content[0]?.type !== 'output_text') throw new Error('expected output_text');
    expect(item.content[0].text).toBe('Paris is 18C with light rain.');
    // 终事件带的 usage 与 SDK 解析出来的一致
    expect(final.usage?.input_tokens).toBe(12);
    expect(final.usage?.output_tokens).toBe(8);
  });

  it(' Responses 客户端脸的有状态参数 → SDK 拿到的是 400 参数错误，不是静默成功', async () => {
    const { client } = responsesSdkClient([
      { body: JSON.stringify(deepseekChatResponseForResponses()) },
    ]);
    // 42 §4.4 / §4.9：previous_response_id 在入口显式拒（网关不存上游 response 对象）
    await expect(
      client.responses.create({
        model: 'deepseek-flash',
        input: 'continue',
        previous_response_id: 'resp_test_prev',
      }),
    ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
  });
});
