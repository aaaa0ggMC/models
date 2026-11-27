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

/**
 * 运行时设置项 → 环境变量名（config/settings.ts 的白名单项：网关组 8 项 + Agent 组）。
 *
 * 表放在这里而不是放在 settings.ts：settings.ts 是「怎么用这些设置」，
 * 而「哪些 env 变量存在」属于 env 读取的职责，本文件是全仓库唯一读 env 的地方。
 * 两边靠 `RuntimeSettingKey` 这个类型绑在一起——加一个设置项而忘了加 env 名，
 * 编译期就红。
 */
export const RUNTIME_SETTING_ENV_VARS: Record<
  import('../config/settings.js').RuntimeSettingKey,
  string
> = {
  global_timeout_ms: 'AG_GLOBAL_TIMEOUT_MS',
  ttfb_timeout_ms: 'AG_TTFB_TIMEOUT_MS',
  stream_idle_timeout_ms: 'AG_STREAM_IDLE_TIMEOUT_MS',
  max_retries: 'AG_MAX_RETRIES',
  retry_base_delay_ms: 'AG_RETRY_BASE_DELAY_MS',
  loss_policy: 'AG_LOSS_POLICY',
  model_sync_interval_ms: 'AG_MODEL_SYNC_INTERVAL_MS',
  plugin_timeout_ms: 'AG_PLUGIN_TIMEOUT_MS',
  models_extended_metadata: 'AG_MODELS_EXTENDED_METADATA',
  cross_modality_bridge: 'AG_CROSS_MODALITY_BRIDGE',
  save_full_messages: 'AG_SAVE_FULL_MESSAGES',
  gateway_stealth_enabled: 'AG_GATEWAY_STEALTH_ENABLED',
  gateway_stealth_header: 'AG_GATEWAY_STEALTH_HEADER',
  gateway_stealth_key: 'AG_GATEWAY_STEALTH_KEY',
  client_disconnect_mode: 'AG_CLIENT_DISCONNECT_MODE',
  client_disconnect_grace_ms: 'AG_CLIENT_DISCONNECT_GRACE_MS',
  // ---- Agent 组（docs/design/95-agent-chat.md §6.2）----
  agent_access_path: 'AG_AGENT_ACCESS_PATH',
  agent_model: 'AG_AGENT_MODEL',
  agent_system_prompt: 'AG_AGENT_SYSTEM_PROMPT',
  agent_tools: 'AG_AGENT_TOOLS',
  agent_redaction_rules: 'AG_AGENT_REDACTION_RULES',
  agent_redaction_detect_js: 'AG_AGENT_REDACTION_DETECT_JS',
  agent_redaction_placeholder: 'AG_AGENT_REDACTION_PLACEHOLDER',
  agent_redact_tool_results: 'AG_AGENT_REDACT_TOOL_RESULTS',
  agent_temperature: 'AG_AGENT_TEMPERATURE',
  agent_max_tokens: 'AG_AGENT_MAX_TOKENS',
  agent_max_turns: 'AG_AGENT_MAX_TURNS',
  agent_stream: 'AG_AGENT_STREAM',
  agent_persist_messages: 'AG_AGENT_PERSIST_MESSAGES',
};

/**
 * 运行时设置项的 env 层原值（**只在这一个函数里读 env**）。
 *
 * 设置界面靠它做两件事：判「哪一项被 env 覆盖了」（可写性 / env 锁）与取
 * 「env 层提供的值」（四层合并的第二层）。返回原值而不是解析后的值：
 * 解析规则（整数 / 枚举 / 范围）属于设置服务的职责，两边各写一份必然漂移。
 */
export function runtimeSettingEnvValues(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<import('../config/settings.js').RuntimeSettingKey, string>> {
  const out: Partial<Record<import('../config/settings.js').RuntimeSettingKey, string>> = {};
  for (const [key, name] of Object.entries(RUNTIME_SETTING_ENV_VARS)) {
    const raw = env[name];
    if (raw !== undefined && raw.trim() !== '') {
      out[key as import('../config/settings.js').RuntimeSettingKey] = raw;
    }
  }
  return out;
}

/** 被 env 覆盖的设置项 key 列表（`runtimeSettingEnvValues` 的键集合）。 */
export function runtimeSettingEnvOverrides(
  env: NodeJS.ProcessEnv = process.env,
): import('../config/settings.js').RuntimeSettingKey[] {
  return Object.keys(
    runtimeSettingEnvValues(env),
  ) as import('../config/settings.js').RuntimeSettingKey[];
}

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
      modelsExtendedMetadata: boolFromEnv(
        'AG_MODELS_EXTENDED_METADATA',
        DEFAULT_CONFIG.modelsExtendedMetadata,
      ),
      crossModalityBridge: boolFromEnv(
        'AG_CROSS_MODALITY_BRIDGE',
        DEFAULT_CONFIG.crossModalityBridge ?? true,
      ),
      saveFullMessages: boolFromEnv(
        'AG_SAVE_FULL_MESSAGES',
        DEFAULT_CONFIG.saveFullMessages ?? false,
      ),
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
      // 渠道健康（自动禁用 / 恢复；阈值下限 1，0 会让"永不禁用"与"每次都禁用"混淆）
      channelAutoDisable: boolFromEnv('AG_CHANNEL_AUTO_DISABLE', DEFAULT_CONFIG.channelAutoDisable),
      channelAutoDisableFailures: Math.max(
        1,
        intFromEnv('AG_CHANNEL_AUTO_DISABLE_FAILURES', DEFAULT_CONFIG.channelAutoDisableFailures),
      ),
      channelAutoDisableRecover: boolFromEnv(
        'AG_CHANNEL_AUTO_DISABLE_RECOVER',
        DEFAULT_CONFIG.channelAutoDisableRecover,
      ),
      // 管理员令牌：只读变量名对应的值，值不进日志、不落盘
      ...(process.env['AG_ADMIN_TOKEN'] === undefined || process.env['AG_ADMIN_TOKEN'] === ''
        ? {}
        : { adminToken: process.env['AG_ADMIN_TOKEN'] }),
      // 数据面单 access token（66 §2.2 极简模式）。与虚拟 key 互斥，
      // 判定在 auth/data-plane.ts；值不进日志、不落盘。
      ...(process.env['AG_ACCESS_TOKEN'] === undefined || process.env['AG_ACCESS_TOKEN'] === ''
        ? {}
        : { accessToken: process.env['AG_ACCESS_TOKEN'] }),
      // 显式启用数据面虚拟 key 模式（库还空着时就要按虚拟 key 跑）
      ...(boolFromEnv('AG_VIRTUAL_KEYS', false) ? { virtualKeysEnabled: true } : {}),
      // 显式放行数据面（不校验任何凭据）。**不设 = 默认拒绝**：虚拟 key 与
      // AG_ACCESS_TOKEN 都没配时数据面整个关掉（503），不是谁都能进。
      // 设成 0/false 是"显式关"（连 mode:'test' 的进程内装配也按拒绝跑）；
      // 只有设成 1/true 才放行。这是 deny-first 的落地开关。
      ...(process.env['AG_DATA_PLANE_PERMISSIVE'] === undefined
        ? {}
        : { permissiveEnabled: boolFromEnv('AG_DATA_PLANE_PERMISSIVE', false) }),
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
