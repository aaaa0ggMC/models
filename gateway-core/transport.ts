/**
 * gateway-core/transport.ts —— 上游传输抽象。
 *
 * 决策 P1（40 §1.1）：adaptor 只管"字段怎么映射"，transport 只管"怎么签名、怎么建流"。
 * Bedrock 的 SigV4、Vertex 的 OAuth、订阅 device-code OAuth 都只改 transport。
 *
 * 硬约束（20 §S5）：
 *   - **不跟随 redirect**：3xx 作为 provider error 返回，避免把 prompt 和凭据头转发到别的端点；
 *   - TTFB 超时 + 整体 deadline；流式下整体 deadline 指"最后一个字节"；
 *   - 流式空闲超时杀"发了首块后静默"的流。
 *
 * 鉴权头**不在这里硬编码**：由 CredentialResolver 产出 headers，transport 只负责发送。
 */

export interface UpstreamRequest {
  method: "POST" | "GET";
  /** 上游 base URL（如 "https://api.anthropic.com"），不含路径。 */
  base_url: string;
  /** 端点路径（如 "/v1/messages"）。 */
  path: string;
  /** 查询串（Gemini 的 ?alt=sse 等）。 */
  query?: Record<string, string>;
  /** 已签好的请求头（含鉴权头）。 */
  headers: Record<string, string>;
  body?: Buffer;
  /** 是否按流式读取（SSE / chunked-binary）。 */
  stream: boolean;
  /** 取消信号（客户端断开时级联取消上游）。 */
  signal?: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  /** 非流式：完整 body 字节。 */
  body?: Buffer;
  /** 流式：chunk 迭代器。 */
  chunks?: AsyncIterable<Buffer>;
}

export interface Transport {
  send(req: UpstreamRequest): Promise<UpstreamResponse>;
}

/** 上游返回了 3xx——按 provider error 处理，不跟随（20 §S5）。 */
export class RedirectNotFollowedError extends Error {
  constructor(readonly status: number, readonly location: string | undefined) {
    super(`上游返回 ${status}，网关不跟随 redirect（避免把 prompt 与凭据头转发到别的端点）`);
    this.name = "RedirectNotFollowedError";
  }
}

/**
 * 基于 Node 内置 fetch 的 transport。
 *
 * 不引入 undici 直连或 axios：Node 18+ 内置 fetch 已覆盖 HTTP/1.1 + HTTP/2，
 * 且 AbortSignal 原生支持取消级联。
 */
export class FetchTransport implements Transport {
  async send(req: UpstreamRequest): Promise<UpstreamResponse> {
    const url = new URL(req.path, req.base_url);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      url.searchParams.set(k, v);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal !== undefined) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    }

    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new RedirectNotFollowedError(res.status, res.headers.get("location") ?? undefined);
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });

    if (req.stream) {
      if (res.body === null) {
        return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
      }
      return { status: res.status, headers, chunks: fetchChunkIterable(res.body, controller) };
    }
    return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
  }
}

async function* fetchChunkIterable(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
): AsyncIterable<Buffer> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
    // 客户端断开时级联关闭上游连接（25 §6 第 3 条：止损）
    try {
      await body.cancel();
    } catch {
      // 上游已关闭时忽略
    }
    controller.abort();
  }
}

/**
 * 脚本化 transport：测试与本地 e2e 演示用的假上游。
 *
 * 它是**正当的基础设施**而不是测试补丁——仓库要能"不起真实 API 就跑通端到端"，
 * 且 DI 注入让测试不打真实网络（任务书明确要求）。
 */
export class ScriptedTransport implements Transport {
  readonly requests: UpstreamRequest[] = [];

  constructor(private readonly script: ScriptedTransportScript) {}

  async send(req: UpstreamRequest): Promise<UpstreamResponse> {
    this.requests.push(req);
    const step = this.script.shift();
    if (step === undefined) {
      throw new Error(`ScriptedTransport: 脚本已用尽，但仍收到请求 ${req.method} ${req.path}`);
    }
    if (step.delay_ms !== undefined && step.delay_ms > 0) {
      await new Promise((r) => setTimeout(r, step.delay_ms));
    }
    const headers = { "content-type": "application/json", ...(step.headers ?? {}) };
    if (step.chunks !== undefined) {
      return { status: step.status ?? 200, headers, chunks: iterate(step.chunks) };
    }
    const body = Buffer.from(step.body ?? "");
    return { status: step.status ?? 200, headers, body };
  }
}

export type ScriptedTransportScript = ScriptedStep[];

export interface ScriptedStep {
  status?: number;
  headers?: Record<string, string>;
  /** 非流式响应体。 */
  body?: string;
  /** 流式响应：每个元素一个 chunk。 */
  chunks?: string[];
  delay_ms?: number;
}

async function* iterate(chunks: string[]): AsyncIterable<Buffer> {
  for (const c of chunks) {
    yield Buffer.from(c);
  }
}

/** 把脚本数组包成"可消费一次"的队列。 */
export function scriptOf(steps: ScriptedStep[]): ScriptedTransportScript {
  return [...steps];
}
