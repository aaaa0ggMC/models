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
  CanonicalRequestEnvelope,
  CapabilityEntry,
  FormatId,
  ModalityKind,
  ResolvedRoute,
  RequestContext,
} from '../ir/index.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { CredentialResolver } from '../credentials/resolver.js';
import { evaluateRouteGraph, type RouteGraphRegistry } from './routing-engine.js';
import type { RoutingTelemetryHub } from './routing-telemetry.js';

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

/**
 * 别名解析端口（S2 的第一步）。
 *
 * **为什么是一个注入的端口而不是内置逻辑**：规则数据（哪些别名存在、优先级）
 * 属于控制面（admin/aliases.ts），本文件只做「怎么用解析结果产出 attempt_plan」。
 * 这样管理面改规则不需要动路由引擎，测试里也能整体替换解析器。
 *
 * 传 undefined = 只用 `RouteTable.aliases` 的静态查表（本文件的历史行为，
 * 完全不差地保留）。
 */
export interface AliasResolver {
  resolve(model: string, modality: ModalityKind): AliasResolution | undefined;
  listNamespaces?(): Array<{ namespace: string; enabled: boolean; access_paths: string[] }>;
}

/**
 * 解析结果的来源（透传给下游做可观测：请求路径上要能回答"模型名是怎么来的"）。
 *
 * 四档与 admin/aliases.ts 的解析优先级一一对应（那边是唯一事实来源）：
 *   exact > namespace > prefix > passthrough。
 */
export type AliasResolutionSource = 'exact' | 'namespace' | 'prefix' | 'passthrough';

export interface AliasResolution {
  source: AliasResolutionSource;
  /** 命中的规则 id（passthrough / namespace 时为 undefined）。 */
  rule_id?: string;
  target: { provider: string; access_path: string; model: string; max_context_tokens?: number };
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
  /** 路由图引擎所需的完整 canonical 请求信封（仅命中路由图时物化传递）。 */
  canonical?: CanonicalRequestEnvelope;
}

export interface RouteHooks {
  /** 过滤/排序 attempt（健康、熔断、粘性、权重、价格…）。Phase 1 用 no-op。 */
  filterAndSort?(attempts: Attempt[], req: RouteRequest, ctx: RequestContext): Attempt[];
  /** sticky 会话键（30 §4.3）。 */
  sessionKey?(req: RouteRequest, ctx: RequestContext): string | undefined;
  /**
   * 候选被滤空时的**具体错误**（可选；没有就走路由器的通用错误）。
   *
   * 为什么留这个口子：`filterAndSort` 只返回"剩下谁"，回答不了"为什么没了"。
   * 而"没建渠道"和"渠道被停用"该给用户的两句话完全不同（前者是配置、重试不会
   * 自己好；后者是临时态、可能恢复），混成一句通用错误等于让运维自己猜。
   */
  explainEmpty?(attempts: Attempt[], req: RouteRequest, ctx: RequestContext): CanonicalError;
}

export const NOOP_ROUTE_HOOKS: RouteHooks = {};

/**
 * provider 状态过滤器（`enabled` / `auto_disabled` / **有没有配过**的路由侧执行点）。
 *
 * 为什么必须在路由层：`ProviderConfig.enabled` 在管理面存了很久却没有数据面消费者
 * ——管理员关掉一个渠道，请求照样打过去。关掉一个渠道最常见的动机是"这个 key 坏了 /
 * 这个上游在抖"，那时最不该做的就是继续把请求送过去。
 *
 * 语义（四条，都有测试）：
 *   1. `enabled === false` 的 provider → **全部候选被过滤**（不是降权）；
 *   2. `auto_disabled` 存在 → 同等过滤（自动禁用是"网关替你关的"，行为一致），
 *      但**「连续失败计数中」那一态不算**——未达阈值的累计失败不该把渠道踢出轮换，
 *      否则一次上游 400 之后请求全被挡下、成功恢复的路径永远跑不到（判据在
 *      admin/provider-runtime.ts 的 `isAutoDisabled`）；
 *   3. **没建过渠道**（视图说 `isConfigured` 为 false）→ 同等过滤，报
 *      `no_available_provider` 并说清"没配渠道"。零配置部署里请求不再带着一把
 *      谁也没配过的 env key 打到上游、拿一个上游 401 回来——那种错误长得像
 *      "key 坏了"，而真实原因是"这个部署根本没配渠道"；
 *   4. 视图没实现 `isConfigured`（测试替身 / 纯静态装配 / 没有管理面的装配）→
 *      **不过滤**（缺省放行：不知道状态时不猜）。见 `ProviderStateView.isConfigured`。
 *
 * `requires_credential: false` 的脚手架路径（mock）不受第 3 条约束：它没有上游
 * 账号可配，"配过吗"这个问题对它无意义（见 `AdmissionExempt`）。
 */
export interface ProviderStateView {
  /** 该 provider 当前是否不可用（禁用 / 自动禁用）。 */
  isUnavailable(provider: string): boolean;
  /**
   * 该 provider 在这套装配里算不算「配了」（有渠道记录 / 静态装配声明）。
   *
   * 返回 false = 没建过渠道 → 候选被滤掉，请求拿到 `no_available_provider`
   * （说清"没配渠道"），**不会带着一把谁也没配过的 key 打到上游**。
   *
   * **不实现这个方法 = 不过滤**（历史行为）：不知道状态时不猜。装配方不告诉
   * 路由"什么算配了"，路由就不能替它决定——测试替身与纯静态装配照旧工作。
   */
  isConfigured?(provider: string): boolean;
}

/**
 * 「没有上游凭据可配」的脚手架目标判定（mock / 内部矩阵条目）。
 *
 * 为什么准入对它们不适用：准入问的是"这个上游你配过吗"，而 mock 路径
 * （`requires_credential: false`）压根没有上游账号可配——它是做给机器看的
 * 本地替身。拿"没建渠道"把它拒掉会连演示与测试一起打死，那正是要避免的。
 */
export type AdmissionExempt = (attempt: Attempt, req: RouteRequest) => boolean;

export class ProviderStateFilter implements RouteHooks {
  constructor(
    private readonly view: ProviderStateView,
    /** 脚手架目标豁免（不注入 = 没有豁免，一切按 isConfigured 判）。 */
    private readonly admissionExempt?: AdmissionExempt,
  ) {}

  filterAndSort(attempts: Attempt[], req: RouteRequest, _ctx: RequestContext): Attempt[] {
    return attempts.filter((a) => {
      if (this.view.isUnavailable(a.provider)) return false;
      if (this.view.isConfigured?.(a.provider) !== false) return true;
      return this.admissionExempt?.(a, req) === true;
    });
  }

  /**
   * 候选被滤空时给出**具体原因**（没有就 undefined，用路由器的通用错误）。
   *
   * 两种滤空的原因要给两种话：「没建渠道」是配置问题（重试不会自己好），
   * 「渠道被停用 / 自动禁用」是临时态（可能恢复）。混成一句"都被过滤掉了"
   * 等于让运维自己猜是哪一种。
   */
  explainEmpty(attempts: Attempt[], req: RouteRequest, ctx: RequestContext): CanonicalError {
    const unconfigured = attempts.every((a) => this.view.isConfigured?.(a.provider) === false);
    if (!unconfigured) {
      return {
        code: 'no_available_provider',
        message: `模型 ${req.model} 的渠道已停用或被网关自动禁用`,
        http_status: 503,
        retryable: true,
        request_id: ctx.request_id,
      };
    }
    return {
      code: 'no_available_provider',
      message:
        `模型 ${req.model} 没有可用渠道：没有已配置的渠道。` +
        '请先在管理面建好渠道并配好上游凭据，再重试。',
      http_status: 503,
      retryable: false,
      request_id: ctx.request_id,
    };
  }
}

export type RouteResult =
  | { ok: true; route: ResolvedRoute; capability?: CapabilityEntry }
  | { ok: false; error: CanonicalError };

export interface Router {
  resolve(req: RouteRequest, ctx: RequestContext): RouteResult;
  /** 是否需要 S2 提前物化完整 canonical（如命中启用的路由图）。 */
  needsCanonical?(model: string): boolean;
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
    /**
     * 别名解析器（可选）。
     *
     * 注入后的解析顺序（**路由图 > 显式别名 > 前缀规则 > 原样 model id**）：
     *   1. 若命中启用的路由图 → 求值路由图 DAG；
     *   2. 否则问 resolver；命中就用它的 target；
     *   3. resolver 没命中（或返回 passthrough）→ 回落到 `RouteTable.aliases`
     *      的静态查表；
     *   4. 都没有 → `no_available_provider`。
     */
    private readonly aliasResolver?: AliasResolver,
    private readonly routeGraphs?: RouteGraphRegistry,
    private readonly routingTelemetry?: RoutingTelemetryHub,
  ) {
    this.aliases = { ...table.aliases };
  }

  needsCanonical(model: string): boolean {
    return this.routeGraphs?.get(model)?.enabled === true;
  }

  setAlias(alias: string, entry: RouteAlias): void {
    this.aliases[alias] = entry;
  }

  resolve(req: RouteRequest, ctx: RequestContext): RouteResult {
    // ---- 第 0 步：路由图引擎（最高优先级：自定义图标识符）----
    const graph = this.routeGraphs?.get(req.model);
    if (graph !== undefined && graph.enabled) {
      const evalResult = evaluateRouteGraph(graph, {
        model: req.model,
        modality: req.modality,
        stream: req.stream,
        client_format: ctx.client_format,
        ...(req.canonical === undefined ? {} : { canonical: req.canonical }),
        ctx,
        ...(this.routingTelemetry === undefined ? {} : { telemetryHub: this.routingTelemetry }),
        capabilityRegistry: this.capabilityRegistry,
        credentialResolver: this.credentialResolver,
      });
      if (!evalResult.ok) {
        return {
          ok: false,
          error: {
            code: 'no_available_provider',
            message: evalResult.error ?? `路由图 ${req.model} 无可用目标`,
            http_status: 503,
            retryable: true,
            request_id: ctx.request_id,
          },
        };
      }
      return this.finalizeRoute(evalResult.candidates, req, ctx, {
        forceCanonical: true,
        routeGraphId: graph.id,
        routeTrace: evalResult.trace.map((s) => `${s.node_id}:${s.outcome}(${s.detail})`),
      });
    }

    // ---- 第 1 步：别名解析（20 §S2）----
    // 注入了解析器就先用它；没注入则纯静态查表（历史行为）。
    const explicitTargetPath = ctx.client_raw_headers?.['x-ag-target-access-path']?.trim();
    if (explicitTargetPath !== undefined && explicitTargetPath !== '') {
      const dotIdx = explicitTargetPath.indexOf('.');
      const targetProvider =
        dotIdx === -1 ? explicitTargetPath : explicitTargetPath.slice(0, dotIdx);
      const nsRules = this.aliasResolver?.listNamespaces?.() ?? [];
      const matchingNs = nsRules.find(
        (r) => r.enabled && r.access_paths.includes(explicitTargetPath),
      );
      const bareModel =
        matchingNs !== undefined && req.model.startsWith(`${matchingNs.namespace}/`)
          ? req.model.slice(matchingNs.namespace.length + 1)
          : req.model;
      return this.finalizeRoute(
        [
          {
            provider: targetProvider,
            access_path: explicitTargetPath,
            provider_format: this.credentialResolver.formatFor(explicitTargetPath),
            model: bareModel,
            fast_path_eligible: false,
          },
        ],
        req,
        ctx,
        {},
      );
    }

    let resolved = this.aliasResolver?.resolve(req.model, req.modality);
    let targetModality: import('../ir/index.js').ModalityKind | undefined;
    if (resolved === undefined && req.modality === 'chat') {
      const imgResolved = this.aliasResolver?.resolve(req.model, 'image');
      if (imgResolved !== undefined) {
        resolved = imgResolved;
        targetModality = 'image';
      }
    }
    let alias: RouteAlias | undefined;
    if (resolved !== undefined) {
      alias = {
        targets: [
          {
            access_path: resolved.target.access_path,
            provider: resolved.target.provider,
            model: resolved.target.model,
          },
        ],
        ...(resolved.target.max_context_tokens === undefined
          ? {}
          : { max_context_tokens: resolved.target.max_context_tokens }),
      };
    } else {
      alias = this.aliases[req.model];
    }

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

    const candidates: Attempt[] = alias.targets.map((t) => ({
      provider: t.provider,
      access_path: t.access_path,
      provider_format: this.credentialResolver.formatFor(t.access_path),
      model: t.model,
      fast_path_eligible: false,
      ...(targetModality === undefined ? {} : { target_modality: targetModality }),
    }));

    return this.finalizeRoute(candidates, req, ctx, {
      ...(alias.max_context_tokens === undefined
        ? {}
        : { maxContextTokens: alias.max_context_tokens }),
    });
  }

  private finalizeRoute(
    candidates: Attempt[],
    req: RouteRequest,
    ctx: RequestContext,
    meta: {
      maxContextTokens?: number;
      forceCanonical?: boolean;
      routeGraphId?: string;
      routeTrace?: string[];
    },
  ): RouteResult {
    const attempts = this.hooks.filterAndSort?.([...candidates], req, ctx) ?? candidates;
    if (attempts.length === 0) {
      // 过滤器能给具体原因就用它的（"没建渠道" vs "渠道被停用"），否则通用错误。
      // 传**过滤前**的候选：判"为什么没了"要看得见原来有谁。
      const explained = this.hooks.explainEmpty?.(candidates, req, ctx);
      return {
        ok: false,
        error:
          explained ??
          ({
            code: 'no_available_provider',
            message: `模型 ${req.model} 的所有候选 attempt 都被过滤掉了（健康检查/熔断/key 额度）`,
            http_status: 503,
            retryable: true,
            request_id: ctx.request_id,
          } satisfies CanonicalError),
      };
    }

    // 若选中的 access_path 没有可用凭据，优先切到同模型、同 provider 下确实有凭据的接入端点
    // （例如删掉 deepseek.anthropic-messages 凭据后，自动回落到已绑定的 deepseek.openai-chat）。
    let chosen =
      attempts.find((a) => this.credentialResolver.credentialsFor(a.access_path).length > 0) ??
      attempts[0]!;
    if (this.credentialResolver.credentialsFor(chosen.access_path).length === 0) {
      const modality = chosen.target_modality ?? req.modality;
      const alt = this.capabilityRegistry
        .list()
        .find(
          (e) =>
            e.modality === modality &&
            e.model === chosen.model &&
            e.access_path !== chosen.access_path &&
            (e.access_path === chosen.provider ||
              e.access_path.startsWith(`${chosen.provider}.`)) &&
            this.credentialResolver.credentialsFor(e.access_path).length > 0,
        );
      if (alt !== undefined) {
        chosen = {
          ...chosen,
          access_path: alt.access_path,
          provider_format: this.credentialResolver.formatFor(alt.access_path),
        };
      }
    }
    const capability = this.capabilityRegistry.find(
      chosen.access_path,
      chosen.model,
      chosen.target_modality ?? req.modality,
    );

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
      meta.forceCanonical !== true &&
      capability !== undefined &&
      capability.streaming?.mode !== 'none' &&
      this.credentialResolver.formatFor(chosen.access_path) === ctx.client_format;

    let orderedAttempts: Attempt[] = attempts;
    if (
      chosen.access_path !== attempts[0]!.access_path ||
      chosen.model !== attempts[0]!.model ||
      chosen.provider !== attempts[0]!.provider
    ) {
      orderedAttempts = [
        chosen,
        ...attempts.filter(
          (a) =>
            !(
              a.provider === chosen.provider &&
              a.access_path === chosen.access_path &&
              a.model === chosen.model
            ),
        ),
      ];
    }

    const route: ResolvedRoute = {
      access_path: chosen.access_path,
      provider: chosen.provider,
      provider_format: (this.credentialResolver.formatFor(chosen.access_path) ??
        chosen.provider_format) as FormatId,
      model: chosen.model,
      full_model_id: `${chosen.access_path}/${chosen.model}`,
      ...(chosen.target_modality === undefined ? {} : { target_modality: chosen.target_modality }),
      attempt_plan: orderedAttempts.map((a) => ({
        ...a,
        fast_path_eligible: a.fast_path_eligible || fastPathEligible,
      })),
      fast_path_eligible: fastPathEligible,
      model_meta:
        meta.maxContextTokens === undefined
          ? undefined
          : { max_context_tokens: meta.maxContextTokens },
      ...(meta.routeGraphId === undefined ? {} : { route_graph_id: meta.routeGraphId }),
      ...(meta.routeTrace === undefined ? {} : { route_trace: meta.routeTrace }),
    };

    const sessionKey = this.hooks.sessionKey?.(req, ctx);
    if (sessionKey !== undefined) route.session_key = sessionKey;

    return { ok: true, route, ...(capability === undefined ? {} : { capability }) };
  }
}
