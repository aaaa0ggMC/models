/**
 * http/server.ts —— 最小 HTTP ingress（S0 可跑起来）。
 *
 * 职责：把 HTTP 请求转成 `PipelineInput`，跑 PipelineRunner，把结果写回客户端。
 * 端点形态见 docs/design/00-overview.md §4.3；所有端点共用同一套 pipeline 阶段，
 * 差异只在 S1/S6/S8 的 codec 与 S2 的能力矩阵查询（00 §4.3 原文）。
 *
 * 用 Node 内置 `http` 而不是 fastify：ingress 只做"读 body → 跑 pipeline → 写响应"，
 * 引入框架会多一层与 DI 容器重复的装配概念。后续若要 HTTP/2 或更细的中间件，可在
 * composition root 里换实现而不动 pipeline。
 *
 * 隐私约束（AGENTS.md）：请求头在进 pipeline 前**脱敏**——Authorization / x-api-key /
 * cookie 一律不透传进 trace 或日志。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { FormatId } from "../ir/index.js";
import type { PipelineRunner } from "../gateway-core/pipeline/runner.js";
import type { ClientSink } from "../gateway-core/pipeline/sink.js";
import { FORMAT_HEADER } from "../gateway-core/pipeline/stages/s0-ingress.js";

/** 脱敏：只保留白名单头，其余丢弃（含鉴权头）。 */
const ALLOWED_HEADERS = new Set([
  "content-type",
  "content-length",
  "accept",
  "x-agentgateway-format",
  "traceparent",
  "user-agent",
]);

export function sanitizeHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(", ");
  }
  return out;
}

/** 路径签名 → 客户端格式（00 §4.3 的端点形态）。 */
const ROUTES: Array<{ pattern: RegExp; format: FormatId }> = [
  { pattern: /^\/v1\/chat\/completions$/, format: "openai.chat" },
  { pattern: /^\/v1\/responses$/, format: "openai.responses" },
  { pattern: /^\/v1\/messages$/, format: "anthropic.messages" },
  { pattern: /^\/v1beta\/models\/[^:]+:generateContent$/, format: "gemini.generateContent" },
  { pattern: /^\/v1beta\/models\/[^:]+:streamGenerateContent$/, format: "gemini.generateContent" },
];

export interface HttpServerOptions {
  port: number;
  host: string;
  runner: PipelineRunner;
  /** 健康检查端点（不起 pipeline）。 */
  healthPath?: string;
}

/** Node http 的 ServerResponse → ClientSink 适配。 */
class NodeResponseSink implements ClientSink {
  private _started = false;
  private _closed = false;

  constructor(private readonly res: ServerResponse) {
    res.on("close", () => {
      this._closed = true;
    });
  }

  get started(): boolean {
    return this._started;
  }
  get closed(): boolean {
    return this._closed || this.res.writableEnded;
  }

  start(status: number, headers: Record<string, string>): void {
    if (this._started) throw new Error("ClientSink.start 重复调用：首字节后不能改状态码（20 §S8）");
    this._started = true;
    this.res.writeHead(status, headers);
  }

  write(chunk: string | Buffer): void {
    if (!this._started) this.start(200, {});
    this.res.write(chunk);
  }

  writeFrame(frame: unknown): void {
    this.write(JSON.stringify(frame));
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
    this._closed = true;
  }
}

export function createHttpServer(options: HttpServerOptions): Server {
  const { port: _port, host: _host, runner } = options;
  const healthPath = options.healthPath ?? "/health";

  return createServer((req, res) => {
    void handleRequest(req, res, runner, healthPath);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runner: PipelineRunner,
  healthPath: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === healthPath) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const route = ROUTES.find((r) => r.pattern.test(path));
  if (route === undefined) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `未知端点: ${path}`, type: "not_found" } }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "只支持 POST", type: "method_not_allowed" } }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks);

  const sink = new NodeResponseSink(res);
  try {
    await runner.run(
      {
        client_format: route.format,
        raw_body: rawBody,
        headers: sanitizeHeaders(req.headers),
        path,
        query: Object.fromEntries(url.searchParams.entries()),
      },
      sink,
    );
  } catch (err) {
    // PipelineRunner 承诺不抛；这里只是双保险
    if (!sink.started) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: err instanceof Error ? err.message : "internal error",
            type: "internal_error",
          },
        }),
      );
    }
  } finally {
    sink.end();
  }
}

/** 起服务（本地演示 / 部署用）。 */
export async function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const server = createHttpServer(options);
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => resolve());
  });
  return server;
}

export { FORMAT_HEADER, NodeResponseSink };
