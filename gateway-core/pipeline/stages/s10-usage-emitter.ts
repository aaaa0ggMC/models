/**
 * gateway-core/pipeline/stages/s10-usage-emitter.ts —— S10 UsageEmitter。
 *
 * 职责（20 §S10）：产出 UsageRecord 写入内存队列 → 批量刷到存储。
 *
 * 硬约束（逐条落地）：
 *   - **永不抛异常影响主链路**；队列满时按 drop_policy（默认丢弃最旧 + 计数告警）；
 *   - 异步、批量、可重放；
 *   - 旁路，**插件不参与**（20 §2 阶段表）。
 *
 * 本阶段同时把 RequestTrace 补齐（20 §8），它是 dog-fooding agent 的主要数据面之一。
 */

import type { PipelineDeps, PipelineState, Stage } from '../types.js';
import { applyProviderUsageProfile } from '../provider-profile.js';
import { createUsageRecord, type ToolCallUsage } from '../../../metering/usage-record.js';
import { toUsdAmount } from '../../../metering/pricing.js';
import { asChatResponsePayload, emptyUsage, CTX_STATE_KEYS } from '../../../ir/index.js';
import type { UsageRecord } from '../../../metering/usage-record.js';

export class S10UsageEmitter implements Stage {
  readonly id = 'S10';
  readonly name = 'UsageEmitter';

  async execute(state: PipelineState, deps: PipelineDeps): Promise<void> {
    const started = deps.clock.now();
    const { ctx } = state;

    const toolCalls: ToolCallUsage[] = [];
    const traceTools =
      (ctx.state['trace'] as Array<{ tool: string; duration_ms: number; ok: boolean }>) ?? [];
    for (const t of traceTools) {
      toolCalls.push({ name: t.tool, ok: t.ok, duration_ms: t.duration_ms });
    }

    // provider 特定的 usage 归一（计量边界）：按 access path 查 profile，把厂商专有
    // usage 字段名（DeepSeek 的 prompt_cache_hit_tokens …）映射成 canonical。
    // 快/慢路径、流式/非流式的原始 usage 都逐字段保留在 raw 里（40 §2.2c I4），
    // 因此这一个点就能覆盖全部路径；没有 profile 时是恒等变换。
    const usage =
      applyProviderUsageProfile(state.usage, ctx.route.access_path, deps.providerProfiles) ??
      state.usage ??
      emptyUsage('provider');
    // 写回 state.usage：successOutcome / trace 都在 S10 之后读它，让 outcome、
    // UsageRecord、RequestTrace 三处看到同一份归一后的 usage（否则会出现
    // 「记录里缓存命中已归一、outcome 里还是 0」的口径分裂）。
    if (usage !== undefined) state.usage = usage;

    // ---- 定价（请求时一次性算清 + 快照固化；缺服务 = unpriced）----
    // 档位由请求**开始时间**定（流式跨峰谷边界时确定性优先，见 pricing-service.ts）。
    const estimateText = estimateTextOf(state);
    // 订阅/按量由**本次实际用的那把凭据**决定（key 前缀，官方明文判据），不由模型
    // 也不由路径决定：同一条 access path 上可以同时有一把 `tp-`（订阅）和一把
    // `sk-`（按量）——MiMo 官方明文两者不互通。按路径判会把一次按量用量的现金
    // 成本记成 0（或反过来），而对账时两边都看不出错。分不清时不传 subscription
    // （照算 cash，保守方向）。
    const usedCredentialId = ctx.state[CTX_STATE_KEYS.ATTEMPT_CREDENTIAL_ID] as string | undefined;
    const usedCredential =
      usedCredentialId === undefined
        ? undefined
        : deps.credentialResolver
            .credentialsFor(ctx.route.access_path)
            .find((c) => c.id === usedCredentialId);
    const subscription =
      deps.credentialResolver.billingModeFor?.(ctx.route.access_path, usedCredential) ===
      'subscription';
    const priced =
      deps.pricingService === undefined
        ? undefined
        : deps.pricingService.price({
            ts: ctx.started_at,
            model: ctx.route.model,
            usage,
            provider: ctx.route.provider,
            ...(ctx.route.access_path === undefined ? {} : { access_path: ctx.route.access_path }),
            ...(estimateText === undefined ? {} : { estimateText }),
            ...(subscription ? { subscription: true } : {}),
          });

    const record: UsageRecord = createUsageRecord({
      request_id: ctx.request_id,
      ...(ctx.trace_id === undefined ? {} : { trace_id: ctx.trace_id }),
      ts: deps.clock.now(),
      auth: {
        key_id: ctx.auth.key_id,
        ...(ctx.auth.team_id === undefined ? {} : { team_id: ctx.auth.team_id }),
        ...(ctx.auth.user_id === undefined ? {} : { user_id: ctx.auth.user_id }),
      },
      client_format: ctx.client_format,
      provider: ctx.route.provider,
      provider_format: ctx.provider_format,
      model: ctx.route.model,
      model_alias: state.shallow?.model,
      fast_path: ctx.fast_path,
      attempts: ctx.route.attempt_plan.length,
      stream: state.shallow?.stream === true,
      ttfb_ms: state.ttfb_ms ?? 0,
      total_ms: deps.clock.now() - ctx.started_at,
      status: state.status ?? 'success',
      finish_reason: state.finish_reason,
      usage: priced?.estimated_usage ?? usage,
      usage_raw: (priced?.estimated_usage ?? usage)?.raw,
      ...(ctx.route.access_path === undefined ? {} : { access_path: ctx.route.access_path }),
      // 按 key 记账：多 key 部署下"这笔用量烧在哪把 key 上"的唯一依据（60 §3）。
      // 与 cash / as_api 双口径正交——拆的是用量归属，钱照旧两个口径都记。
      ...(usedCredentialId === undefined ? {} : { credential_id: usedCredentialId }),
      ...(priced === undefined
        ? {}
        : {
            cost: priced.cost,
            ...(priced.price_snapshot === null
              ? { price_snapshot: null }
              : { price_snapshot: priced.price_snapshot }),
            ...(priced.estimate_method === undefined
              ? {}
              : { estimate_method: priced.estimate_method }),
          }),
      warnings: ctx.warnings,
      dropped_capabilities: state.dropped_capabilities,
      error_code: state.error?.code,
      tool_calls: toolCalls,
      agentic_turns: state.turns,
      ...(deps.config.saveFullMessages === true
        ? {
            full_message: {
              request: state.canonical_override ?? state.canonical ?? state.shallow,
              response: state.response ?? state.stream_events ?? state.error,
            },
          }
        : {}),
    });

    // 补齐 RequestTrace（20 §8）
    state.trace.fast_path = ctx.fast_path;
    state.trace.attempts = [
      {
        provider: ctx.route.provider,
        model: ctx.route.model,
        status: state.upstream_status ?? 0,
        ttfb_ms: state.ttfb_ms ?? 0,
        total_ms: deps.clock.now() - ctx.started_at,
        ...(state.error === undefined ? {} : { error: state.error.code }),
      },
    ];
    state.trace.stages = ctx.metrics;
    state.trace.usage = usage ?? record.usage;
    state.trace.finish_reason =
      state.finish_reason === 'final' ? 'stop' : (state.finish_reason ?? 'stop');
    state.trace.warnings = ctx.warnings;
    state.trace.dropped_capabilities = state.dropped_capabilities;
    state.trace.conversion_chain = state.conversion_chain;
    state.trace.turn_count = state.turns;
    state.trace.tool_calls = toolCalls;

    // 发射：永不抛（S10 的语义）
    deps.usageEmitter.emit(record);
    try {
      const tokens =
        (record.usage.units.tokens?.input_tokens ?? 0) +
        (record.usage.units.tokens?.output_tokens ?? 0);
      const cashUsd = toUsdAmount(
        record.cost.cash.total,
        record.cost.currency ?? record.price_snapshot?.currency,
      );
      deps.routingTelemetry?.recordUsageEvent({
        request_id: record.request_id,
        ts: record.ts,
        provider: record.provider,
        tokens,
        cash_usd: cashUsd,
      });
    } catch {
      // 遥测旁路永不抛
    }

    ctx.recordStage(this.id, deps.clock.now() - started, `depth=${deps.usageEmitter.depth()}`);
    deps.metrics.increment('pipeline.stage', 1, { stage: this.id });
    deps.metrics.gauge('metering.queue_depth', deps.usageEmitter.depth());
    if (deps.usageEmitter.dropped() > 0) {
      deps.metrics.increment('metering.dropped', deps.usageEmitter.dropped());
    }
  }
}

/**
 * 取自估算兜底的文本（usage 缺失时 as_api 用它估算 token）。
 *
 * 只取**响应侧**文本：请求侧文本在 raw_body 里，解析它会把 S10 变成第二个解码器；
 * 输入侧估算留给后续迭代（接口已留 estimateText，补上即可）。
 *
 * 取值顺序 `final_response ?? response ?? aggregated`：`final_response` 是 S9 跑完
 * `onResponse` 插件链之后的那一份。客户端拿到的就是它（非流式下 S8 的字节在 S9 之后
 * 才 flush），所以估算必须基于同一份——否则会出现「客户端拿到 A、账按 B 估」。
 */
function estimateTextOf(state: PipelineState): string | undefined {
  const response = state.final_response ?? state.response ?? state.aggregated;
  if (response === undefined) return undefined;
  const payload = asChatResponsePayload(response);
  if (payload === undefined) return undefined;
  return payload.message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
