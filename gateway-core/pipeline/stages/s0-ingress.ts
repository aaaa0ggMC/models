/**
 * gateway-core/pipeline/stages/s0-ingress.ts —— S0 Ingress。
 *
 * 职责（20 §S0）：识别客户端格式、鉴权、限流、分配 request_id、超时预算。
 * 鉴权失败、限流超限、模型不在允许列表 → 直接返回，**不进 S1**（避免无谓解码开销）。
 *
 * 格式识别优先级（20 §S0 第 1 条，逐条落地）：
 *   1. 显式 header `x-agentgateway-format`；
 *   2. 路径签名；
 *   3. body 结构嗅探；
 *   4. 都不命中 → 400 unsupported_format。
 */

import type { CanonicalError, FormatId } from '../../../ir/index.js';
import type {
  AuthExemption,
  FirstPartyCaller,
  PipelineDeps,
  PipelineInput,
  PipelineState,
  Stage,
} from '../types.js';
import { createCanonicalError, CTX_STATE_KEYS } from '../../../ir/index.js';
import { MutableRequestContext } from '../../context.js';

/** 显式格式头。 */
export const FORMAT_HEADER = 'x-agentgateway-format';

const PATH_SIGNATURES: Array<{ pattern: RegExp; format: FormatId }> = [
  { pattern: /^\/v1\/chat\/completions$/, format: 'openai.chat' },
  { pattern: /^\/v1\/responses$/, format: 'openai.responses' },
  { pattern: /^\/v1\/messages$/, format: 'anthropic.messages' },
  { pattern: /^\/v1(?:beta)?\/models\/[^:]+:generateContent$/, format: 'gemini.generateContent' },
  {
    pattern: /^\/v1(?:beta)?\/models\/[^:]+:streamGenerateContent$/,
    format: 'gemini.generateContent',
  },
];

/**
 * body 结构嗅探（20 §S0 第 3 条）：
 *   存在 `input` 且无 `messages` → Responses；
 *   存在 `contents` → Gemini；
 *   存在顶层 `system` 字段或 `messages[].content` 为 block 数组 → Anthropic。
 */
export function sniffFormat(body: unknown): FormatId | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  if ('contents' in obj) return 'gemini.generateContent';
  if ('input' in obj && !('messages' in obj)) return 'openai.responses';
  if ('system' in obj && 'messages' in obj) return 'anthropic.messages';
  const messages = obj['messages'];
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0] as Record<string, unknown>;
    if (first !== undefined && Array.isArray(first['content'])) return 'anthropic.messages';
  }
  return undefined;
}

/**
 * 数据面鉴权的输入。
 *
 * `headers` 是**已脱敏**的头（http/server.ts 的 `sanitizeHeaders` 剥掉了
 * authorization / x-api-key / cookie，它们只以 `auth_material` 的形态进来，
 * 且**绝不进 `client_raw_headers` → trace / 日志**）。
 *
 * 为什么要把 query / path / raw_body 也给鉴权器：66 §2.2 的第三种形态是
 * `?key=`，而 20 §S0 第 2 条要求「模型不在允许列表 → 直接返回，不进 S1」——
 * 模型在 body 里（Gemini 在 path 里），没有这两个字段就没法在 S0 判。
 */
export interface AuthRequest {
  /** 已脱敏的请求头。 */
  headers: Record<string, string>;
  /** 查询参数（`?key=` 在这里）。 */
  query: Record<string, string>;
  /** 端点路径（Gemini 的 model-in-path 场景用）。 */
  path: string;
  /** 原始请求体（只在 key 带模型限制时才解析）。 */
  raw_body: Buffer;
  /**
   * 未经脱敏的鉴权原语（authorization / x-api-key / query key）。
   *
   * **绝不进 trace / 日志 / UsageRecord**：它和 `headers` 分开传递，就是为了
   * 让「把它抄进 ctx」这件事在任何地方都看不出来是被允许的。
   */
  auth_material?: {
    authorization?: string;
    api_key?: string;
    query_key?: string;
  };
  /**
   * 数据面鉴权豁免（**代码级区分**，只有服务端第一方调用方会设置）。
   *
   * S0 在调用鉴权器**之前**解析它（见 `DATA_PLANE_AUTH_EXEMPTIONS`）：表里登记了
   * 就不向鉴权器要凭据，没登记（或没带）就照常走数据面鉴权。放在 `AuthRequest`
   * 上是为了让「豁免」留在鉴权契约里——鉴权器实现不需要知道它，但测试与将来的
   * 审计 / 限流实现看到的是同一个事实。
   */
  auth_exemption?: AuthExemption;
}

/** 鉴权通过。 */
export interface AuthSuccess {
  key_id: string;
  team_id?: string;
  user_id?: string;
  /** 该 key 允许的模型（66 §2.1；空 = 全部）。 */
  allowed_models?: string[];
  /** 该 key 允许的 provider（S2 按解析出的 provider 校验）。 */
  allowed_providers?: string[];
  /** 是否允许开 Tier-2 消息持久化（66 §2.1；v1 只透传）。 */
  allow_message_persistence?: boolean;
  /** 是否允许流式响应（默认 true）。 */
  allow_streaming?: boolean;
  /** 允许的插件白名单。 */
  allowed_plugins?: string[];
  /** 明确禁用的插件黑名单。 */
  disabled_plugins?: string[];
  /** 允许的模态白名单。 */
  allowed_modalities?: string[];
  /** 认证方式（日志/审计用；**不含任何凭据**）。 */
  via: 'virtual_key' | 'access_token' | 'permissive' | 'first_party';
}

export interface AuthFailure {
  ok: false;
  error: CanonicalError;
}

export interface AuthPass {
  ok: true;
}

export type AuthOutcome = (AuthSuccess & AuthPass) | AuthFailure;

/** 数据面鉴权（66 §2）。实现见 auth/data-plane.ts；Phase 1 的占位见下面。 */
export interface Authenticator {
  authenticate(request: AuthRequest): Promise<AuthOutcome>;
}

/**
 * 当前生效的数据面认证模式（互斥与 deny-first 语义见 auth/data-plane.ts 的文件头）。
 *
 * `deny` = 什么都没配：**默认拒绝**，一切请求 503。permissive 是显式 opt-in，
 * 不是「没配置」的兜底——公网暴露标准下一次部署遗漏不能等于一次数据泄露。
 */
export type DataPlaneAuthMode = 'virtual_key' | 'access_token' | 'permissive' | 'deny';

/**
 * Phase 1 的占位鉴权器：不校验任何东西，`key_id` 恒为 `local-dev`。
 *
 * **保留是有意的，但它的可达面已经被夹死**（2026-11 公网暴露审计确认过）：
 *   - HTTP 面上它不可达：`http/server.ts` 的数据面鉴权网关先跑，`/v1` 与 `/v1beta`
 *     前缀下没通过鉴权就进不来 S0；而 `createGateway()` 永远往 runner 里注
 *     `DataPlaneAuthenticator`，所以走到 S0 时这个占位器已经被替换掉。
 *   - 它只服务**进程内直连 runner** 的场景（测试、脚本、dog-fooding 装配），
 *     那些场景没有传输层，也没有"忘配凭据就公开"的问题。
 *
 * 真正的"忘配凭据"防线在 `auth/data-plane.ts`：那里什么都不配时是 `deny`（503），
 * 不是这个占位器的放行。改这个占位器之前先确认没有测试依赖它——有二十来个。
 */
export const PERMISSIVE_AUTHENTICATOR: Authenticator = {
  async authenticate() {
    return { ok: true, key_id: 'local-dev', via: 'permissive' };
  },
};

/**
 * 数据面鉴权的**显式豁免表**（单点定义；新增豁免只能加在这里）。
 *
 * 纪律与 `http/server.ts` 的数据面网关一致：**默认拒绝**，豁免逐条列出、每条带
 * `why`。这张表是 pipeline 路径（S0）的那一半；`http/server.ts` 对 `/v1` 与
 * `/v1beta` 前缀的传输层网关是另一半（它只覆盖不跑 S0 的注入端口，豁免只有
 * 健康检查）。两边共同的硬规则：**客户端没有任何途径把自己写进豁免里**。
 *
 * 为什么豁免不能是「S0 认一个魔法请求头」：数据面请求的 `input.headers` 就是
 * 客户端原始头（鉴权头另走 `auth_material`，但头本身是客户端给的），任何客户端
 * 自己带一个 `x-ag-internal-caller: agent-builtin` 就绕过鉴权了。因此豁免只认
 * `PipelineInput` / `AuthRequest` 上那个**类型化字段**（`AuthExemption`），由
 * 服务端第一方调用方在进程内设置；`http/server.ts` 的数据面路径永远不设置它。
 * 这条不变式由 `tests/agent-chat-data-plane-auth.test.ts` 兜住（客户端把同名标记
 * 写在头 / body / query 里一律 401），不只靠注释。
 */
export interface DataPlaneAuthExemption {
  /** 调用方标识（与 `FirstPartyCaller` 一致；查表用）。 */
  readonly caller: FirstPartyCaller;
  /**
   * 计量归属的固定 `key_id`（**非人类**）。
   *
   * 66 §1：`key_id` 是计费的主键，不是可选项。第一方调用没有客户端 key 可归因，
   * 但也不能因此变成匿名调用——否则内置对话的用量在账面上消失，对账时查无此单。
   */
  readonly key_id: string;
  /** 为什么这个调用方不需要客户端凭据。 */
  readonly why: string;
}

export const DATA_PLANE_AUTH_EXEMPTIONS: readonly DataPlaneAuthExemption[] = [
  {
    caller: 'agent-builtin',
    key_id: 'agent-builtin',
    why:
      '管理面内置对话（POST /admin/api/chat）本身在管理员会话之后才走到这里' +
      '（admin/routes.ts：bearerToken → AdminAuth.authenticate，未登录 401），' +
      '且 pipeline 输入是服务端构造的：客户端头经 ALLOWED_HEADERS 白名单过滤后' +
      '只剩 content-type，鉴权头按 buildAuthMaterial 单独走、到不了 S0；' +
      '豁免标记（PipelineInput.auth_exemption）同理不可从线上伪造。',
  },
];

/**
 * 查豁免表。**不在表里 → undefined（继续走数据面鉴权）**。
 *
 * 故意做成「按 caller 查表」而不是「字段在场即豁免」：表是唯一的放行依据，
 * 将来若有人（或某段 JS）传一个没登记过的 caller，结果是拒绝而不是放行。
 */
export function findAuthExemption(
  caller: FirstPartyCaller | undefined,
): DataPlaneAuthExemption | undefined {
  if (caller === undefined) return undefined;
  return DATA_PLANE_AUTH_EXEMPTIONS.find((e) => e.caller === caller);
}

export interface S0Options {
  authenticator?: Authenticator;
}

export class S0Ingress implements Stage {
  readonly id = 'S0';
  readonly name = 'Ingress';

  constructor(private readonly options: S0Options = {}) {}

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx, input } = state;

    // 1) 格式识别
    const headerFormat = input.headers[FORMAT_HEADER];
    let format: FormatId | undefined =
      headerFormat !== undefined ? (headerFormat as FormatId) : undefined;
    if (format === undefined) {
      for (const sig of PATH_SIGNATURES) {
        if (sig.pattern.test(input.path)) {
          format = sig.format;
          break;
        }
      }
    }
    if (format === undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.raw_body.toString('utf8'));
      } catch {
        parsed = undefined;
      }
      format = sniffFormat(parsed);
    }
    if (format === undefined) {
      throw createCanonicalError(
        'unsupported_format',
        `无法识别客户端格式（path=${input.path}，无 ${FORMAT_HEADER} 头，body 嗅探也未命中）`,
        ctx.request_id,
      );
    }

    ctx.client_format = format;
    ctx.provider_format = format;
    ctx.request_bytes = input.raw_body.byteLength;
    ctx.state[CTX_STATE_KEYS.REQUEST_PATH] = input.path;
    state.modality = 'chat'; // Phase 1 只做 chat；多模态端点识别随 adaptor 增加

    // 2) 鉴权（失败直接返回，不进 S1）
    const auth = await this.authenticate(input);
    if (!auth.ok) {
      throw auth.error;
    }
    ctx.auth = {
      key_id: auth.key_id,
      ...(auth.team_id === undefined ? {} : { team_id: auth.team_id }),
      ...(auth.user_id === undefined ? {} : { user_id: auth.user_id }),
      ...(auth.allowed_models === undefined ? {} : { allowed_models: auth.allowed_models }),
      ...(auth.allowed_providers === undefined
        ? {}
        : { allowed_providers: auth.allowed_providers }),
      ...(auth.allow_message_persistence === undefined
        ? {}
        : { allow_message_persistence: auth.allow_message_persistence }),
      ...(auth.allow_streaming === undefined ? {} : { allow_streaming: auth.allow_streaming }),
      ...(auth.allowed_plugins === undefined ? {} : { allowed_plugins: auth.allowed_plugins }),
      ...(auth.disabled_plugins === undefined ? {} : { disabled_plugins: auth.disabled_plugins }),
      ...(auth.allowed_modalities === undefined
        ? {}
        : {
            allowed_modalities: auth.allowed_modalities as import('../../../ir/index.js').ModalityKind[],
          }),
    };

    // 2a) 模态白名单校验
    if (
      auth.allowed_modalities !== undefined &&
      auth.allowed_modalities.length > 0 &&
      !auth.allowed_modalities.includes(state.modality)
    ) {
      throw createCanonicalError(
        'auth_failed',
        `该 key 不允许使用 ${state.modality} 模态`,
        ctx.request_id,
        { http_status: 403 },
      );
    }

    // 2b) 模型白名单（20 §S0 第 2 条：「模型不在允许列表 → 直接返回，不进 S1」）
    //
    // **只在 key 真的带限制时才解析 body**：`extractRequestModel` 要 JSON.parse
    // 整个请求体，而 S1 反正还要再解析一次。 unrestricted 的 key（绝大多数请求）
    // 一次都不该付这个代价——S0 是每个请求的必经之路。
    if (auth.allowed_models !== undefined && auth.allowed_models.length > 0) {
      const requestedModel = extractRequestModel(format, input.path, input.raw_body);
      if (requestedModel !== undefined && !modelAllowed(requestedModel, auth.allowed_models)) {
        throw createCanonicalError(
          'auth_failed',
          `该 key 不允许使用模型 ${requestedModel}`,
          ctx.request_id,
          { http_status: 403 },
        );
      }
    }

    // 3) 超时预算：client 超时、provider 超时、全局上限三者取最小（20 §S0）
    const deadline = deps.clock.now() + deps.config.globalTimeoutMs;
    ctx.deadline = deadline;

    ctx.recordStage(this.id, deps.clock.now() - started, `format=${format}`);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
  }

  /**
   * 鉴权：第一方调用方走豁免表，其余走数据面鉴权器（默认拒绝的那一半）。
   *
   * 豁免的判据**只有** `PipelineInput.auth_exemption` 这一个类型化字段
   * （表见 `DATA_PLANE_AUTH_EXEMPTIONS`）：头 / 查询参数 / body 里的任何同名
   * 标记都不算，客户端没有途径写这个字段。
   *
   * 为什么在 S0 判而不是交给鉴权器实现：豁免是「这个请求没走过数据面」这一事实
   * 的推论，属于 ingress 的职责；交给每个 `Authenticator` 实现自己去认，迟早
   * 有一个实现不认（或新写一个不认的），症状就是内置对话再次莫名失败。
   */
  private async authenticate(input: PipelineInput): Promise<AuthOutcome> {
    const exemption = findAuthExemption(input.auth_exemption?.caller);
    if (exemption !== undefined) {
      // 不带 allowed_models / allowed_providers：第一方调用不受 key 级限制
      // （它前面的门是管理员会话，不是数据面 key）。
      return { ok: true, key_id: exemption.key_id, via: 'first_party' };
    }
    const authenticator = this.options.authenticator ?? PERMISSIVE_AUTHENTICATOR;
    return authenticator.authenticate({
      headers: input.headers,
      query: input.query,
      path: input.path,
      raw_body: input.raw_body,
      ...(input.auth_material === undefined ? {} : { auth_material: input.auth_material }),
      ...(input.auth_exemption === undefined ? {} : { auth_exemption: input.auth_exemption }),
    });
  }
}

/**
 * 从请求里取出客户端要用的模型名。
 *
 * OpenAI / Anthropic 在 body 的 `model` 字段；Gemini 把模型放在 path 里
 * （`/v1beta/models/{model}:generateContent`）。取不到返回 undefined——
 * 「不知道模型」不等于「模型不被允许」，那种请求放过去由 S2 报
 * `no_available_provider`，比在 S0 猜一个模型然后误拒要好。
 */
export function extractRequestModel(
  format: FormatId,
  path: string,
  rawBody: Buffer,
): string | undefined {
  if (format === 'gemini.generateContent') {
    const match = /^\/v1(?:beta)?\/models\/([^:]+):/.exec(path);
    return match?.[1];
  }
  if (rawBody.byteLength === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const model = (parsed as Record<string, unknown>)['model'];
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/**
 * 模型是否在该 key 的白名单里。
 *
 * 规则（与 admin/aliases.ts 的前缀规则同立场，从简）：
 *   - 白名单为空 / 未给 = 全部允许；
 *   - 条目以 `*` 结尾 = 前缀 glob（`deepseek-*` 命中 `deepseek-chat`）；
 *   - 其余 = 精确匹配。
 */
export function modelAllowed(model: string, allowed: string[] | undefined): boolean {
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.some((entry) => {
    if (entry === model) return true;
    if (entry.endsWith('*')) return model.startsWith(entry.slice(0, -1));
    return false;
  });
}

/** 构造 S0 用的 MutableRequestContext（Runner 调用）。 */
export function createContext(
  requestId: string,
  now: number,
  headers: Record<string, string>,
  traceId: string | undefined,
  onDisableFastPath: (reason: string) => void,
): MutableRequestContext {
  return new MutableRequestContext({
    request_id: requestId,
    started_at: now,
    deadline: now + 300_000,
    client_format: 'openai.chat',
    client_raw_headers: headers,
    auth: { key_id: 'pending' },
    ...(traceId === undefined ? {} : { trace_id: traceId }),
    onDisableFastPath,
  });
}
