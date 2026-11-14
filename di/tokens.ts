/**
 * di/tokens.ts —— DI 令牌。
 *
 * 为什么用「字符串键 + 泛型 phantom」而不是装饰器/反射：
 *   - tsyringe / injection-js 都依赖 `reflect-metadata` + `emitDecoratorMetadata`，
 *     在 NodeNext ESM 下要额外开实验开关，且错误信息是运行时才出现的字符串；
 *   - 本仓库要求「每个能力都定义接口、具体实现构造函数注入」，一个 ~150 行、类型完备、
 *     错误在编译期就能看到的容器足够，且不引入运行时依赖。
 *   （选型理由同时写进报告的「DI 装配方式与理由」一节。）
 */

/** 依赖令牌。`__type` 只参与类型推断，运行时不存在。 */
export interface Token<T> {
  readonly key: string;
  /** phantom：让 `Token<Clock>` 与 `Token<Logger>` 不兼容。 */
  readonly __type?: T;
}

export function createToken<T>(key: string): Token<T> {
  return { key };
}

/** 全仓库的依赖键集中在这里，避免魔法字符串散落。 */
export const TOKENS = {
  // ---- 跨切面基础设施 ----
  Config: createToken<import('./ports.js').GatewayConfig>('Config'),
  Clock: createToken<import('./ports.js').Clock>('Clock'),
  Logger: createToken<import('./ports.js').Logger>('Logger'),
  Metrics: createToken<import('./ports.js').Metrics>('Metrics'),
  IdGenerator: createToken<import('./ports.js').IdGenerator>('IdGenerator'),

  // ---- 传输与上游 ----
  Transport: createToken<import('../gateway-core/transport.js').Transport>('Transport'),

  // ---- 编解码 ----
  AdaptorRegistry: createToken<import('../adaptors/types.js').AdaptorRegistry>('AdaptorRegistry'),

  // ---- 插件 ----
  PluginHost: createToken<import('../plugins/host.js').PluginHost>('PluginHost'),

  // ---- 计量 ----
  UsageEmitter: createToken<import('../metering/emitter.js').UsageEmitter>('UsageEmitter'),

  // ---- 凭据与能力矩阵 ----
  CredentialResolver:
    createToken<import('../credentials/resolver.js').CredentialResolver>('CredentialResolver'),
  CapabilityRegistry:
    createToken<import('../credentials/capability-registry.js').CapabilityRegistry>(
      'CapabilityRegistry',
    ),

  // ---- provider profile（provider 专有知识：端点路径 / usage 归一 / builtin tool 映射）----
  ProviderProfiles: createToken<import('./ports.js').ProviderProfileRegistry>('ProviderProfiles'),

  // ---- 路由 ----
  Router: createToken<import('../gateway-core/router.js').Router>('Router'),

  // ---- 编排 ----
  PipelineRunner:
    createToken<import('../gateway-core/pipeline/runner.js').PipelineRunner>('PipelineRunner'),
} as const;

export type TokenKey = (typeof TOKENS)[keyof typeof TOKENS];
