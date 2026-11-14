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
 */

import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { APIPromise, type Fetch as OpenAIFetch } from 'openai/core';
import type { ModelsPage, Model as OpenAIModel } from 'openai/resources/models';
import { createModelsEndpoints, type ModelsEndpoints } from '../http/models-endpoint.js';
import { createGateway } from '../composition-root.js';

const BASE = 'http://agentgateway.test';

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
  const gateway = createGateway({ mode: 'test' });
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
    // 扩展键在**传输层**原样存在（SDK 只是类型不暴露它们，不是删掉它们）
    const raw = flash as unknown as Record<string, unknown>;
    expect(raw['provenance']).toBeDefined();
    expect(raw['access_paths']).toBeDefined();
    expect(raw['pricing']).toBeDefined();
    expect(raw['constraints']).toBeDefined();
    expect(raw['context_window']).toBe(1_048_576);
    // 而 SDK 侧读到的仍是干净的 OpenAI 形状
    expect(Object.keys(flash as object)).toContain('owned_by');
    expect((flash as OpenAIModel).object).toBe('model');
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
    expect(body.data.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });
});
