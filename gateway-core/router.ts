/**
 * gateway-core/router.ts —— S2 路由。
 *
 * 唯一事实来源：docs/design/20-pipeline.md §S2（别名解析 / 候选列表 / 健康过滤 /
 * attempt_plan / fast path 判定 / 参数兼容性预检 / 预算预检 / sticky 会话键）。
 *
 * Phase 1 范围说明：健康检查与熔断器、粘性会话键、预算预检在本文档里都有定义，
 * 但它们的输入（RequestTrace 聚合、单价表、key 额度）分属 Phase 2/4 交付物。
 * 因此本实现把 `RouteHooks` 做成可注入的接口，Phase 1 用 no-op 实现，
 * 后续阶段填真实逻辑而**不需要改 Router 本身**。
 */

import type {
  Attempt,
  CanonicalError,
  CapabilityEntry,
  FormatId,
  ModalityKind,
  ResolvedRoute,
  RequestContext,
} from '../ir/index.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { CredentialResolver } from '../credentials/resolver.js';

/** 别名 → 候选 attempt 的静态表。部署时配置，运行中可变（热更新用）。 */
export interface RouteAlias {
  /** 有序候选；第一个是首选（fast path 直连一定排第一，40 §1.4 第 3 步补充）。 */
  targets: Array<{ access_path: string; provider: string; model: string }>;
  /** 模型元数据（压缩插件要用 max_context_tokens）。 */
  max_context_tokens?: number;
}

export interface RouteTable {
  aliases: Record<string, RouteAlias>;
}

export interface RouteRequest {
  model: string;
  modality: ModalityKind;
  /** 客户端是否要求流式。 */
  stream: boolean;
  /** 客户端传了的、目标 provider 可能不支持的参数名（预检用，20 §S2 第 6 步）。 */
  requested_params?: string[];
  /** on_unsupported 策略：error 时直接拒绝，不进 fallback。 */
  on_unsupported?: 'error' | 'allow';
}

export interface RouteHooks {
  /** 过滤/排序 attempt（健康、熔断、粘性、权重、价格…）。Phase 1 用 no-op。 */
  filterAndSort?(attempts: Attempt[], req: RouteRequest, ctx: RequestContext): Attempt[];
  /** sticky 会话键（30 §4.3）。 */
  sessionKey?(req: RouteRequest, ctx: RequestContext): string | undefined;
}

export const NOOP_ROUTE_HOOKS: RouteHooks = {};

export type RouteResult =
  | { ok: true; route: ResolvedRoute; capability?: CapabilityEntry }
  | { ok: false; error: CanonicalError };

export interface Router {
  resolve(req: RouteRequest, ctx: RequestContext): RouteResult;
  /** 别名表热更新。 */
  setAlias(alias: string, entry: RouteAlias): void;
}

export class StaticRouter implements Router {
  private aliases: Record<string, RouteAlias>;

  constructor(
    table: RouteTable,
    private readonly capabilityRegistry: CapabilityRegistry,
    private readonly credentialResolver: CredentialResolver,
    private readonly hooks: RouteHooks = NOOP_ROUTE_HOOKS,
  ) {
    this.aliases = { ...table.aliases };
  }

  setAlias(alias: string, entry: RouteAlias): void {
    this.aliases[alias] = entry;
  }

  resolve(req: RouteRequest, ctx: RequestContext): RouteResult {
    const alias = this.aliases[req.model];
    if (alias === undefined || alias.targets.length === 0) {
      return {
        ok: false,
        error: {
          code: 'no_available_provider',
          message: `未知模型别名: ${req.model}`,
          http_status: 400,
          retryable: false,
          request_id: ctx.request_id,
        },
      };
    }

    let attempts: Attempt[] = alias.targets.map((t) => ({
      provider: t.provider,
      access_path: t.access_path,
      provider_format: this.credentialResolver.formatFor(t.access_path),
      model: t.model,
      fast_path_eligible: false,
    }));

    attempts = this.hooks.filterAndSort?.(attempts, req, ctx) ?? attempts;
    if (attempts.length === 0) {
      return {
        ok: false,
        error: {
          code: 'no_available_provider',
          message: `模型 ${req.model} 的所有候选 attempt 都被过滤掉了（健康检查/熔断/key 额度）`,
          http_status: 503,
          retryable: true,
          request_id: ctx.request_id,
        },
      };
    }

    const chosen = attempts[0]!;
    const capability = this.capabilityRegistry.find(chosen.access_path, chosen.model, req.modality);

    // 参数兼容性预检（20 §S2 第 6 步）：on_unsupported === "error" 时直接拒绝，不进 fallback。
    if (
      capability !== undefined &&
      req.on_unsupported === 'error' &&
      req.requested_params !== undefined
    ) {
      const unsupported = (capability.unsupported_fields ?? []).filter((f) =>
        (req.requested_params ?? []).includes(f),
      );
      if (unsupported.length > 0) {
        return {
          ok: false,
          error: {
            code: 'capability_unsupported',
            message:
              `目标 ${chosen.access_path}/${chosen.model} 不支持参数: ${unsupported.join(', ')}。` +
              '静默丢参数比失败更危险（20 §S2 第 6 步）',
            http_status: 400,
            retryable: false,
            request_id: ctx.request_id,
            field_path: unsupported[0],
          },
        };
      }
    }

    // 流式能力预检（25 §9）：上游 mode 为 none 而客户端要流式 → 拒绝，不静默降级。
    if (req.stream && capability?.streaming !== undefined && capability.streaming.mode === 'none') {
      return {
        ok: false,
        error: {
          code: 'streaming_mode_unsupported',
          message: `${chosen.access_path}/${chosen.model} 的 ${req.modality} 模态不支持流式`,
          http_status: 400,
          retryable: false,
          request_id: ctx.request_id,
        },
      };
    }

    const fastPathEligible =
      capability !== undefined &&
      capability.streaming?.mode !== 'none' &&
      this.credentialResolver.formatFor(chosen.access_path) === ctx.client_format;

    const route: ResolvedRoute = {
      access_path: chosen.access_path,
      provider: chosen.provider,
      provider_format: this.credentialResolver.formatFor(chosen.access_path) as FormatId,
      model: chosen.model,
      full_model_id: `${chosen.access_path}/${chosen.model}`,
      attempt_plan: attempts.map((a) => ({
        ...a,
        fast_path_eligible: a.fast_path_eligible || fastPathEligible,
      })),
      fast_path_eligible: fastPathEligible,
      model_meta:
        alias.max_context_tokens === undefined
          ? undefined
          : { max_context_tokens: alias.max_context_tokens },
    };

    const sessionKey = this.hooks.sessionKey?.(req, ctx);
    if (sessionKey !== undefined) route.session_key = sessionKey;

    return { ok: true, route, ...(capability === undefined ? {} : { capability }) };
  }
}
