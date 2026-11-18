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
 *
 * ## 管理面挂载（控制平面）
 *
 * `createHttpServer` 接受一个可选的 `adminHandler`：一个
 * `(req, res, url) => Promise<boolean>` 的函数，返回 true 表示"这个请求我处理了"。
 * 数据面路由在此之前**完全不认识** `/admin/*`——两者是独立的两个平面
 * （66 §1：两个认证平面，不要混），挂载点只有下面那一次调用。
 *
 * 之所以用"返回 boolean 的 handler"而不是中间件链：本文件刻意不引框架，
 * 加一个中间件机制就等于自己造半个 fastify。一个可选的挂载点足够表达
 * "管理面在这里"，且对数据面代码零侵入。
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { FormatId } from '../ir/index.js';
import type { PipelineInput } from '../gateway-core/pipeline/types.js';
import type { PipelineRunner } from '../gateway-core/pipeline/runner.js';
import type { ClientSink } from '../gateway-core/pipeline/sink.js';
import { FORMAT_HEADER } from '../gateway-core/pipeline/stages/s0-ingress.js';
import type { AdminRouteHandler } from '../admin/routes.js';
import type { Authenticator } from '../gateway-core/pipeline/stages/s0-ingress.js';
import type { ToolEndpoints } from './tools-endpoint.js';
import { MAX_BODY_BYTES as MAX_TOOL_BODY_BYTES } from './tools-endpoint.js';
import type { ModalityEndpoints } from './modality-endpoints.js';
import { MAX_BODY_BYTES as MAX_MODALITY_BODY_BYTES } from './modality-endpoints.js';
import type { AudioEndpoints } from './audio-endpoint.js';
import { AUDIO_PATH_PREFIX, MAX_AUDIO_BODY_BYTES } from './audio-endpoint.js';

/**
 * 脱敏：只保留白名单头，其余丢弃（含鉴权头）。
 *
 * 鉴权头（authorization / x-api-key）**不走这条**：它们以 `auth_material` 的
 * 形态单独传给 pipeline（见 `buildAuthMaterial`），由 S0 的鉴权器消费。
 * 分开传是为了让「把 key 抄进 `client_raw_headers` → trace / 日志」在任何
 * 代码路径里都看不出来是被允许的——`ctx.client_raw_headers` 拿到的永远是
 * 这个函数脱敏后的结果。
 */
const ALLOWED_HEADERS = new Set([
  'content-type',
  'content-length',
  'accept',
  'x-agentgateway-format',
  'traceparent',
  'user-agent',
]);

/** Node 头 → 纯字符串记录（**不过滤**：给鉴权器等安全边界用）。 */
export function rawHeaderRecord(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
  }
  return out;
}

export function sanitizeHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
  }
  return out;
}

/**
 * 从原始请求里取出鉴权原语（**未脱敏**）。
 *
 * 只收集 66 §2.2 认可的三种形态的来源，别的一律不看。这个对象的生命周期
 * 止于 S0：S0 消费完就没人再引用它，它也不进 ctx / trace / UsageRecord。
 */
export function buildAuthMaterial(
  headers: IncomingMessage['headers'],
  searchParams: URLSearchParams,
): PipelineInput['auth_material'] {
  const authorization = headerValue(headers['authorization']);
  const apiKey = headerValue(headers['x-api-key']);
  const queryKey = searchParams.get('key') ?? undefined;
  if (
    (authorization === undefined || authorization === '') &&
    (apiKey === undefined || apiKey === '') &&
    (queryKey === undefined || queryKey === '')
  ) {
    return undefined;
  }
  return {
    ...(authorization === undefined || authorization === '' ? {} : { authorization }),
    ...(apiKey === undefined || apiKey === '' ? {} : { api_key: apiKey }), // privacy-scan: ignore —— 读的是请求头 x-api-key 的名字，不是硬编码密钥；右侧值来自调用方
    ...(queryKey === undefined || queryKey === '' ? {} : { query_key: queryKey }),
  };
}

/** 路径签名 → 客户端格式（00 §4.3 的端点形态）。 */
const ROUTES: Array<{ pattern: RegExp; format: FormatId }> = [
  { pattern: /^\/v1\/chat\/completions$/, format: 'openai.chat' },
  { pattern: /^\/v1\/responses$/, format: 'openai.responses' },
  { pattern: /^\/v1\/messages$/, format: 'anthropic.messages' },
  { pattern: /^\/v1beta\/models\/[^:]+:generateContent$/, format: 'gemini.generateContent' },
  { pattern: /^\/v1beta\/models\/[^:]+:streamGenerateContent$/, format: 'gemini.generateContent' },
];

/**
 * 模型目录端点（元数据面，不进 pipeline）。
 *
 * 注入而不是写在 ROUTES 里：`/v1/models` 不跑 S0–S10 任何阶段（它回答的是"有哪些模型"，
 * 不是"帮我调一次模型"），把它塞进推理路由表会让"POST-only + 客户端格式"的假设多出两个
 * 例外。见 http/models-endpoint.ts。
 */
export interface ModelEndpointsPort {
  listModels(query: URLSearchParams): Promise<{ status: number; body: unknown }>;
  getModel(id: string): Promise<{ status: number; body: unknown }>;
  adminModelsSync(request: {
    method: 'GET' | 'POST';
    authorization?: string;
    adminTokenHeader?: string;
  }): Promise<{ status: number; body: unknown }>;
  /** 启动时同步（可关）；`startHttpServer` 在 listen 前 await 它。 */
  start(): Promise<void>;
}

/** 模型目录相关路径（不含 `/{id}`，那部分单独匹配）。 */
const MODELS_LIST_PATH = '/v1/models';
const MODELS_DETAIL_PREFIX = '/v1/models/';
/** 管理员触发同步（00 §4.3 的 `/ag/` dog-fooding 命名空间）。 */
const ADMIN_SYNC_PATH = '/ag/models/sync';
/** 独立工具端点前缀（DeepSeek 全家桶；见 http/tools-endpoint.ts）。 */
const TOOLS_PATH_PREFIX = '/v1/tools/';

export interface HttpServerOptions {
  port: number;
  host: string;
  runner: PipelineRunner;
  /** 健康检查端点（不起 pipeline）。 */
  healthPath?: string;
  /**
   * 管理面（控制平面）挂载点。
   *
   * 传了它，`/admin/*` 就归管理面路由处理（见 admin/routes.ts），数据面
   * 完全不参与。不传 = 没有管理面，行为与本文件加这一行之前完全一致。
   */
  adminHandler?: AdminRouteHandler;
  /**
   * 数据面鉴权器。**不注入 = 除 `/health` 外全部 401**（默认拒绝）。
   *
   * 2026-11 修过一个真漏洞：`/v1/models`（以及后来的 tools / audio / modality 端口）
   * 是注入式端口，从不跑 S0，于是**从设计到实现都没接鉴权**——非法 key 也能拉全量
   * 模型清单。根因是"每个端点自己决定要不要鉴权"，正确形态是**默认拒绝 + 显式豁免**：
   * 传输层对 `/v1` 与 `/v1beta` 前缀统一切鉴权，豁免表只有健康检查。
   */
  authenticator?: Authenticator;
  /** 模型目录端点（可选；不注入则 `/v1/models` 走 404）。 */
  models?: ModelEndpointsPort;
  /**
   * 独立工具端点（可选；不注入则 `/v1/tools/*` 走 404）。
   *
   * 与 `models` 同款立场：这些端点不跑 pipeline，做成注入端口，server.ts 只负责
   * "路径匹配 → 调端口 → 写响应"。见 http/tools-endpoint.ts。
   */
  tools?: ToolEndpoints;
  /**
   * 模态端点（可选；不注入则 `/v1/images/*`、`/v1/embeddings`、`/v1/decisions` 走 404）。
   *
   * 与 `tools` 同款立场：当前不跑 pipeline（原因见 http/modality-endpoints.ts 文件头），
   * 端口只认自己登记过的精确路径，未登记路径返回 false 交回 ROUTES/404。
   */
  modalities?: ModalityEndpoints;
  /**
   * OpenAI 兼容音频端点（可选；不注入则 `/v1/audio/*` 走 404）。
   *
   * 与 `tools` 同款立场：不跑 pipeline 的注入端口。两个端口**打同一个上游**
   * （`/v1/tools/tts` ↔ `/v1/audio/speech`），差别只在客户端 dialect。
   */
  audio?: AudioEndpoints;
  /**
   * 启动钩子：`listen` 之前 await 一次。
   *
   * 用途（也是唯一的默认用途）：把加密存储里的运行时设置应用回 config——
   * `startup: () => gateway.loadSettings()`。放在这里而不是让调用方自己记得
   * 调，是因为「忘了调」的后果是「界面显示的值和请求路径用的值不一致」，
   * 而这种不一致没有任何报错。
   *
   * 钩子抛错 = 起不来服务（与 `models.start()` 的容错立场不同：那个失败只是
   * 少一份新元数据，而这个失败意味着配置没加载完）。
   */
  startup?(): Promise<void>;
  /** 网关伪装门禁（开启后，未携带合法伪装密钥的数据面请求统一返回 404）。 */
  stealthGate?: () => StealthGateConfig;
  /** 客户端断联处置策略（immediate / grace / ignore）。 */
  disconnectPolicy?: () => DisconnectPolicyConfig;
}

export interface StealthGateConfig {
  enabled: boolean;
  key: string;
  headerName?: string;
}

export interface DisconnectPolicyConfig {
  mode: 'immediate' | 'grace' | 'ignore';
  graceMs?: number;
}

/** Node http 的 ServerResponse → ClientSink 适配。 */
class NodeResponseSink implements ClientSink {
  private _started = false;
  private _closed = false;

  constructor(private readonly res: ServerResponse) {
    res.on('close', () => {
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
    if (this._started) throw new Error('ClientSink.start 重复调用：首字节后不能改状态码（20 §S8）');
    this._started = true;
    const isSse = (headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');
    if (isSse) {
      this.res.socket?.setNoDelay(true);
      this.res.writeHead(status, { 'x-accel-buffering': 'no', ...headers });
      this.res.flushHeaders?.();
    } else {
      this.res.writeHead(status, headers);
    }
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

/**
 * 数据面前缀。**新端点只要落在这两个前缀下就被鉴权网关覆盖**——这就是"默认拒绝"
 * 的落地方式：不需要每个新增端点记得接线，忘了接的那天它仍然是关着的。
 */
function isDataPlanePath(path: string): boolean {
  return path.startsWith('/v1/') || path.startsWith('/v1beta/');
}

/**
 * 健康检查的缺省路径（`healthPath` 选项不传时用它）。
 *
 * 与 `DATA_PLANE_AUTH_EXEMPTIONS` 里的那一条必须是同一个值：清单按路径认豁免，
 * 两边各写一份字面量就会出现"改了选项没改清单"的漂移。
 */
const HEALTH_PATH_DEFAULT = '/health';

/**
 * 数据面鉴权网关的**显式豁免清单**（唯一一处定义；默认只含最小集合）。
 *
 * deny-first 的另一半：放行不可以是"想不起来拒"，必须是清单里的一条。清单里
 * 每一条都要能回答"为什么它不需要凭据"——目前只有健康检查（探活 / 负载均衡
 * 用，不带任何业务数据，也不透露配置）。
 *
 * 加条目前先问三个问题：它泄露配置或数据吗？它能触发上游花钱吗？它能改状态吗？
 * 三个里有"是"就不该进清单。`/ag/models/sync` 就是反例：它什么都干，所以它
 * 自带管理员令牌门禁（见 http/models-endpoint.ts），不在这张清单里。
 */
const DATA_PLANE_AUTH_EXEMPTIONS: ReadonlyArray<{
  /** HTTP 方法（`*` = 任意方法）。 */
  method: string;
  /** 精确路径（缺省健康路径；部署方改 `healthPath` 时按改后的值认，见下）。 */
  path: string;
  /** 为什么它不需要凭据——进清单必须带理由。 */
  why: string;
}> = [
  { method: 'GET', path: HEALTH_PATH_DEFAULT, why: '健康检查：无业务数据、不打上游、不改状态' },
];

/**
 * 这个请求能不能不过数据面鉴权网关。
 *
 * 只有清单里的路径可以。`healthPath` 被部署方改掉时按改后的值认（否则自定义
 * 健康路径会掉进 401，探活全红），方法仍按清单里的那一条卡着。
 */
function isDataPlaneAuthExempt(path: string, method: string, healthPath: string): boolean {
  if (path !== healthPath) return false;
  return DATA_PLANE_AUTH_EXEMPTIONS.some(
    (e) => e.path === HEALTH_PATH_DEFAULT && (e.method === method || e.method === '*'),
  );
}

export function createHttpServer(options: HttpServerOptions): Server {
  const { port: _port, host: _host, runner } = options;
  const healthPath = options.healthPath ?? HEALTH_PATH_DEFAULT;
  const adminHandler = options.adminHandler;
  const authenticator = options.authenticator;
  const models = options.models;
  const tools = options.tools;
  const modalities = options.modalities;
  const audio = options.audio;
  const stealthGate = options.stealthGate;
  const disconnectPolicy = options.disconnectPolicy;

  return createServer((req, res) => {
    void handleRequest(
      req,
      res,
      runner,
      healthPath,
      adminHandler,
      models,
      tools,
      modalities,
      audio,
      authenticator,
      stealthGate,
      disconnectPolicy,
    );
  });
}

/**
 * 读整个请求体；超过 `limit` 时返回 undefined（**但把剩下的字节读完再丢**）。
 *
 * 为什么必须 drain：请求体没收完就写响应，客户端（undici / fetch）可能还堵在写
 * 请求体上，表现为"服务端已经回了 413，fetch 却一直不 resolve"。把剩余字节读干净
 * 再回，比留一个半开的连接好排查。超限的部分**不入内存**（这也是限额的意义）。
 */
async function readBodyLimited(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > limit) {
      oversized = true;
      continue;
    }
    if (!oversized) chunks.push(buf);
  }
  return oversized ? undefined : Buffer.concat(chunks);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runner: PipelineRunner,
  healthPath: string,
  adminHandler: AdminRouteHandler | undefined,
  models: ModelEndpointsPort | undefined,
  tools: ToolEndpoints | undefined,
  modalities: ModalityEndpoints | undefined,
  audio: AudioEndpoints | undefined,
  authenticator: Authenticator | undefined,
  stealthGate: (() => StealthGateConfig) | undefined,
  disconnectPolicy: (() => DisconnectPolicyConfig) | undefined,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // ---- 管理面优先：/admin/* 归控制平面，数据面不参与 ----
  // 66 §1：两个认证平面不要混。这里用「先问管理面」而不是「先匹配数据面路由」
  // 来表达边界——数据面的 ROUTES 表里永远不会出现 /admin 开头的路径。
  if (adminHandler !== undefined) {
    const handled = await adminHandler(req, res, url);
    if (handled) return;
  }

  // ---- 健康检查：数据面鉴权网关唯一的显式豁免（见 DATA_PLANE_AUTH_EXEMPTIONS）----
  if (isDataPlaneAuthExempt(path, req.method ?? 'GET', healthPath)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ---- 数据面统一鉴权网关（默认拒绝，豁免只有上面的健康检查）----
  // 覆盖 `/v1` 与 `/v1beta`：pipeline 路径（chat/responses/messages/generateContent）
  // 自己在 S0 也鉴权（那是为了拿 key_id 做归因与限额），这里是为**不跑 S0 的注入
  // 端口**（models / tools / audio / modalities）补上同一道门。幂等且廉价（本地查一次）。
  if (isDataPlanePath(path)) {
    const gate = stealthGate?.();
    if (gate?.enabled && gate.key.trim() !== '') {
      const headerName = (gate.headerName?.trim() || 'x-gateway-key').toLowerCase();
      const rawHeader = req.headers[headerName];
      const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      const provided = (headerVal ?? url.searchParams.get('gate_key') ?? '').trim();
      const expected = gate.key.trim();
      const providedBuf = Buffer.from(provided, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      const matched =
        providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
      if (!matched) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }
    if (authenticator === undefined) {
      // 默认拒绝：装配方忘了注入鉴权器时，数据面是关着的而不是敞开的。
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '未配置数据面鉴权器', type: 'auth_failed' } }));
      return;
    }
    const auth = await authenticator.authenticate({
      // **原始头，不过 ALLOWED_HEADERS 白名单**：那个白名单是给 pipeline 用的
      // （故意把鉴权头挡在 ctx 之外，S0 另走 buildAuthMaterial）。鉴权器是安全边界，
      // 它必须看见 authorization / x-api-key——复用 sanitizeHeaders 会把 key 剥掉，
      // 症状是「永远提示缺少 API key」而 key 明明在。
      headers: rawHeaderRecord(req.headers),
      query: Object.fromEntries(url.searchParams),
      path,
      raw_body: Buffer.alloc(0),
    });
    if (!auth.ok) {
      const status = auth.error.http_status ?? 401;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: auth.error.message, type: 'auth_failed' } }));
      return;
    }
  }

  // ---- 元数据面：模型目录（GET /v1/models、GET /v1/models/{id}、/ag/models/sync）----
  if (models !== undefined && isModelsPath(path)) {
    await handleModelsRequest(req, res, url, models);
    return;
  }

  // ---- 工具面：独立工具端点（POST /v1/tools/*；不跑 pipeline）----
  if (tools !== undefined && path.startsWith(TOOLS_PATH_PREFIX)) {
    const handled = await tools.handle(req, res, url, () =>
      readBodyLimited(req, MAX_TOOL_BODY_BYTES),
    );
    if (handled) return;
  }

  // ---- 音频面：OpenAI 兼容端点（POST /v1/audio/*；不跑 pipeline）----
  // 体上限比工具面紧（上游 ASR 限 8 MiB）：先把请求掐在网关侧，别等上游 413
  if (audio !== undefined && path.startsWith(AUDIO_PATH_PREFIX)) {
    const handled = await audio.handle(req, res, url, () =>
      readBodyLimited(req, MAX_AUDIO_BODY_BYTES),
    );
    if (handled) return;
  }

  // ---- 模态面：image / embedding / decision 端点（POST；不跑 pipeline）----
  // 只认端口登记过的精确路径；未登记 → 返回 false，继续走 ROUTES / 404。
  // 读体用 readBodyLimited（超限会 drain 完再丢）：与工具面/音频面同一语义。
  if (modalities !== undefined) {
    const handled = await modalities.handle(req, res, url, () =>
      readBodyLimited(req, MAX_MODALITY_BODY_BYTES),
    );
    if (handled) return;
  }

  const route = ROUTES.find((r) => r.pattern.test(path));
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `未知端点: ${path}`, type: 'not_found' } }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '只支持 POST', type: 'method_not_allowed' } }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks);

  const sink = new NodeResponseSink(res);
  const policy = disconnectPolicy?.() ?? { mode: 'immediate', graceMs: 5_000 };
  const clientAbort = new AbortController();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const triggerDisconnect = () => {
    if (policy.mode === 'ignore') return;
    if (policy.mode === 'grace') {
      const graceMs = Math.max(0, policy.graceMs ?? 5_000);
      if (graceMs > 0) {
        if (graceTimer === undefined && !clientAbort.signal.aborted) {
          graceTimer = setTimeout(() => {
            graceTimer = undefined;
            clientAbort.abort();
          }, graceMs);
        }
        return;
      }
    }
    clientAbort.abort();
  };
  const onReqAborted = () => triggerDisconnect();
  const onResClose = () => {
    if (!res.writableEnded) triggerDisconnect();
  };
  req.on('aborted', onReqAborted);
  res.on('close', onResClose);

  try {
    // 注意：这里**不设置** `auth_exemption`。数据面路径永远不声明第一方豁免——
    // 豁免表只有 S0 一份（`DATA_PLANE_AUTH_EXEMPTIONS`，唯一登记项是管理面
    // 内置对话），而客户端没有任何途径写这个字段。少了这一句注释，下一个人
    // 很容易在这里「顺手」加一个放行口子。
    await runner.run(
      {
        client_format: route.format,
        raw_body: rawBody,
        headers: sanitizeHeaders(req.headers),
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        abort_signal: clientAbort.signal,
        ...(() => {
          const material = buildAuthMaterial(req.headers, url.searchParams);
          return material === undefined ? {} : { auth_material: material };
        })(),
      },
      sink,
    );
  } catch (err) {
    // PipelineRunner 承诺不抛；这里只是双保险
    if (!sink.started) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: err instanceof Error ? err.message : 'internal error',
            type: 'internal_error',
          },
        }),
      );
    }
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    req.off('aborted', onReqAborted);
    res.off('close', onResClose);
    sink.end();
  }
}

/** 起服务（本地演示 / 部署用）。 */
export async function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const server = createHttpServer(options);
  // 启动钩子先跑：设置要在第一个请求到达之前应用回 config
  if (options.startup !== undefined) {
    await options.startup();
  }
  // 启动时同步（可关）在 listen 之前完成：这样第一个请求拿到的就是刷新过的元数据。
  // 同步失败不抛（ModelsEndpoints.start 自己吞），起不来服务没有任何理由。
  if (options.models !== undefined) {
    await options.models.start();
  }
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => resolve());
  });
  return server;
}

// ---------------------------------------------------------------------------
// 模型目录（元数据面）
// ---------------------------------------------------------------------------

function isModelsPath(path: string): boolean {
  return (
    path === MODELS_LIST_PATH || path.startsWith(MODELS_DETAIL_PREFIX) || path === ADMIN_SYNC_PATH
  );
}

async function handleModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  models: ModelEndpointsPort,
): Promise<void> {
  const path = url.pathname;
  let result: { status: number; body: unknown };

  if (path === MODELS_LIST_PATH) {
    if (req.method !== 'GET') {
      result = { status: 405, body: methodNotAllowed() };
    } else {
      result = await models.listModels(url.searchParams);
    }
  } else if (path === ADMIN_SYNC_PATH) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      result = { status: 405, body: methodNotAllowed() };
    } else {
      result = await models.adminModelsSync({
        method: req.method,
        authorization: headerValue(req.headers['authorization']),
        adminTokenHeader: headerValue(req.headers['x-admin-token']),
      });
    }
  } else {
    // `/v1/models/{id}`：前缀之后的全部内容就是 id（允许带点号，如 `deepseek-v4.1`）；
    // 空 id 由处理器判 400
    const id = path.slice(MODELS_DETAIL_PREFIX.length);
    if (req.method !== 'GET') {
      result = { status: 405, body: methodNotAllowed() };
    } else {
      result = await models.getModel(id);
    }
  }

  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result.body));
}

function methodNotAllowed(): { error: { message: string; type: string } } {
  return { error: { message: '该方法不被支持', type: 'method_not_allowed' } };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return undefined;
}

export { FORMAT_HEADER, NodeResponseSink, DATA_PLANE_AUTH_EXEMPTIONS, HEALTH_PATH_DEFAULT };
