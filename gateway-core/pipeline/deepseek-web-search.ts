/**
 * gateway-core/pipeline/deepseek-web-search.ts
 *
 * 针对 DeepSeek 的专用兼容桥接：
 * DeepSeek 服务端在 `tools[]` 同时包含自定义 `function` 工具与 `deepseek_web_search` 时
 * 会静默屏蔽 `deepseek_web_search`。因此仅当 `ctx.route.provider === 'deepseek'` 且请求
 * 同时带有 `BuiltinTool('web_search')` 与至少一个 `function` 工具时：
 *   1. 把 `BuiltinTool('web_search')` 改写为普通 `FunctionTool`，让模型在混用工具时可见；
 *   2. 若模型调用该搜索工具，由网关用同渠道 DeepSeek 凭据发起一次仅含
 *      `[{ type: 'deepseek_web_search' }]` 的纯搜索子请求拿回结果并回填给模型；
 *   3. 其余客户端函数工具照常返回给客户端执行；其他 provider 不走此分支。
 */

import type {
  CanonicalRequestEnvelope,
  FunctionTool,
  RequestContext,
  ToolUsePart,
} from '../../ir/index.js';
import { asChatPayload } from '../../ir/index.js';
import type { PipelineDeps } from './types.js';

export interface DeepSeekWebSearchBridge {
  req: CanonicalRequestEnvelope;
  bridgedToolName: string;
}

export function prepareDeepSeekWebSearchBridge(
  req: CanonicalRequestEnvelope,
  ctx: RequestContext,
): DeepSeekWebSearchBridge | undefined {
  if (ctx.route?.provider !== 'deepseek') return undefined;
  const payload = asChatPayload(req);
  if (payload === undefined || payload.tools === undefined || payload.tools.length === 0) {
    return undefined;
  }

  const hasWebSearch = payload.tools.some((t) => t.type === 'builtin' && t.name === 'web_search');
  const hasFunctionTool = payload.tools.some((t) => t.type === 'function');
  if (!hasWebSearch || !hasFunctionTool) return undefined;

  const existingFnNames = new Set(
    payload.tools.filter((t): t is FunctionTool => t.type === 'function').map((t) => t.name),
  );
  const bridgedToolName = existingFnNames.has('web_search') ? 'ag_web_search' : 'web_search';

  const nextTools = payload.tools.map((tool) => {
    if (tool.type === 'builtin' && tool.name === 'web_search') {
      const fnTool: FunctionTool = {
        type: 'function',
        name: bridgedToolName,
        description:
          'Search the web for real-time news, recent events, and up-to-date online information.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query keywords',
            },
          },
          required: ['query'],
        },
      };
      return fnTool;
    }
    return tool;
  });

  return {
    bridgedToolName,
    req: {
      ...req,
      payload: {
        ...payload,
        tools: nextTools,
      },
    },
  };
}

export async function executeDeepSeekWebSearch(
  call: ToolUsePart,
  ctx: RequestContext,
  deps: PipelineDeps,
): Promise<string> {
  const input =
    typeof call.input === 'object' && call.input !== null
      ? (call.input as Record<string, unknown>)
      : {};
  const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
  if (query === '') {
    throw new Error('web_search 缺少 query 参数');
  }

  const route = ctx.route;
  if (route === undefined) {
    throw new Error('缺少路由信息，无法执行 DeepSeek 搜索');
  }

  if (ctx.abort_signal?.aborted) {
    throw new Error('客户端已断开连接，中止 DeepSeek 搜索子请求');
  }

  // 优先使用同 provider 的 OpenAI Chat 接入路径（原生支持 deepseek_web_search），否则沿用当前路径
  const searchAccessPath =
    deps.credentialResolver.credentialsFor('deepseek.openai-chat').length > 0
      ? 'deepseek.openai-chat'
      : route.access_path;
  const creds = deps.credentialResolver.credentialsFor(searchAccessPath);
  if (creds.length === 0) {
    throw new Error(`access path ${searchAccessPath} 没有可用凭据`);
  }

  const rawBaseUrl = deps.credentialResolver.baseUrlFor(searchAccessPath).replace(/\/+$/, '');
  const baseUrl = rawBaseUrl.replace(/\/anthropic$/, '');

  let lastStatus: number | undefined;
  let resBody: Buffer | undefined;

  for (let i = 0; i < creds.length; i++) {
    const cred = creds[i]!;
    const remaining = ctx.deadline - deps.clock.now();
    if (remaining <= 0) {
      throw new Error('整体 deadline 已用尽，无法执行 DeepSeek 搜索子请求');
    }

    const resolved = await deps.credentialResolver.headersFor(searchAccessPath, ctx, cred);
    const authHeaders: Record<string, string> = { ...resolved.headers };
    if (authHeaders['authorization'] === undefined && authHeaders['x-api-key'] !== undefined) {
      authHeaders['authorization'] = `Bearer ${authHeaders['x-api-key']}`;
      delete authHeaders['x-api-key'];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const signal =
      ctx.abort_signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, ctx.abort_signal]);

    try {
      const res = await deps.transport.send({
        method: 'POST',
        base_url: baseUrl,
        path: '/chat/completions',
        headers: {
          'content-type': 'application/json',
          ...authHeaders,
        },
        body: Buffer.from(
          JSON.stringify({
            model: route.model,
            messages: [{ role: 'user', content: query }],
            tools: [{ type: 'deepseek_web_search' }],
            stream: false,
          }),
          'utf8',
        ),
        stream: false,
        signal,
      });

      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300 && res.body !== undefined) {
        resBody = res.body;
        break;
      }
      // 仅凭据级错误（401/403/429）且还有下一把 key 时轮换
      if (
        (res.status === 401 || res.status === 403 || res.status === 429) &&
        i + 1 < creds.length
      ) {
        continue;
      }
      throw new Error(`DeepSeek 搜索子请求失败 (${res.status})`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (resBody === undefined) {
    throw new Error(`DeepSeek 搜索子请求失败 (${lastStatus ?? 'unknown'})`);
  }

  const parsed = JSON.parse(resBody.toString('utf8')) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return '未检索到有效结果。';
  }
  return content;
}
