/**
 * di/config.ts —— 全仓库**唯一**读取 process.env 的地方。
 *
 * 硬约束：禁止其他模块直接读 process.env。环境变量在这里一次性收敛成 GatewayConfig，
 * 经构造函数注入到每一个需要它的组件。这样：
 *   - 测试可以整体替换 config，不需要设环境变量；
 *   - 「哪些配置项存在」在类型上一眼可见；
 *   - 密钥类配置（上游 provider key）同样只在这里出现，且只以**引用名**（环境变量名）
 *     进入配置对象，值在 CredentialResolver 里按需读取，不在此处落地。
 */

import { DEFAULT_CONFIG, type GatewayConfig } from './ports.js';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function lossPolicyFromEnv(
  name: string,
  fallback: GatewayConfig['lossPolicy'],
): GatewayConfig['lossPolicy'] {
  const raw = process.env[name];
  if (raw === 'allow' || raw === 'safe' || raw === 'strict' || raw === 'emulate') return raw;
  return fallback;
}

/**
 * 上游 provider key 的**环境变量名登记表**。
 * 只登记变量名，不读值；值由 credentials/resolver.ts 在签发请求时读取。
 * 仓库里绝不出现真实 key（AGENTS.md：上游 provider 的 key 一律走环境变量）。
 */
export const UPSTREAM_KEY_ENV_VARS: Record<string, string> = {
  openai: 'AG_OPENAI_API_KEY',
  anthropic: 'AG_ANTHROPIC_API_KEY',
  gemini: 'AG_GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const previous = { ...process.env };
  try {
    // 让 helper 读到的就是传入的 env（测试可传字面量对象而不动真实 process.env）
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return {
      globalTimeoutMs: intFromEnv('AG_GLOBAL_TIMEOUT_MS', DEFAULT_CONFIG.globalTimeoutMs),
      ttfbTimeoutMs: intFromEnv('AG_TTFB_TIMEOUT_MS', DEFAULT_CONFIG.ttfbTimeoutMs),
      streamIdleTimeoutMs: intFromEnv(
        'AG_STREAM_IDLE_TIMEOUT_MS',
        DEFAULT_CONFIG.streamIdleTimeoutMs,
      ),
      maxRetries: intFromEnv('AG_MAX_RETRIES', DEFAULT_CONFIG.maxRetries),
      retryBaseDelayMs: intFromEnv('AG_RETRY_BASE_DELAY_MS', DEFAULT_CONFIG.retryBaseDelayMs),
      maxTurns: intFromEnv('AG_MAX_TURNS', DEFAULT_CONFIG.maxTurns),
      pluginTimeoutMs: intFromEnv('AG_PLUGIN_TIMEOUT_MS', DEFAULT_CONFIG.pluginTimeoutMs),
      usageSnifferMaxBytes: intFromEnv(
        'AG_USAGE_SNIFFER_MAX_BYTES',
        DEFAULT_CONFIG.usageSnifferMaxBytes,
      ),
      lossPolicy: lossPolicyFromEnv('AG_LOSS_POLICY', DEFAULT_CONFIG.lossPolicy),
      debug: boolFromEnv('AG_DEBUG', DEFAULT_CONFIG.debug),
      port: intFromEnv('AG_PORT', DEFAULT_CONFIG.port),
      host: process.env['AG_HOST'] ?? DEFAULT_CONFIG.host,
      // 模型目录同步（/v1/models 的元数据分层刷新）
      modelSyncOnStart: boolFromEnv('AG_MODEL_SYNC_ON_START', DEFAULT_CONFIG.modelSyncOnStart),
      modelSyncIntervalMs: intFromEnv(
        'AG_MODEL_SYNC_INTERVAL_MS',
        DEFAULT_CONFIG.modelSyncIntervalMs,
      ),
      modelUpstreamTtlMs: intFromEnv('AG_MODEL_UPSTREAM_TTL_MS', DEFAULT_CONFIG.modelUpstreamTtlMs),
      // 管理员令牌：只读变量名对应的值，值不进日志、不落盘
      ...(process.env['AG_ADMIN_TOKEN'] === undefined || process.env['AG_ADMIN_TOKEN'] === ''
        ? {}
        : { adminToken: process.env['AG_ADMIN_TOKEN'] }),
      // DeepSeek 上游 base URL 覆盖（可留空）。只读变量名对应的值，值不进日志。
      ...(process.env['DEEPSEEK_BASE_URL'] === undefined || process.env['DEEPSEEK_BASE_URL'] === ''
        ? {}
        : { deepseekBaseUrl: process.env['DEEPSEEK_BASE_URL'] }),
    };
  } finally {
    // 恢复真实 process.env，避免测试副作用
    for (const k of Object.keys(process.env)) {
      if (!(k in previous)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(previous)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
}
