/**
 * config/settings.ts —— 运行时设置：加密存储最高层的**可写入口**。
 *
 * 唯一事实来源：docs/design/65-storage-and-retention.md §3（敏感值规则）、
 * config/layering.ts 的四层优先级，以及 80-admin-feature-gap.md §5.1 的 P0-2。
 *
 * ## 四层优先级（与 layering.ts 一致，从高到低）
 *
 * ```text
 * 1. 加密存储（settings kind）   ← 本文件让这一层第一次可写
 * 2. 环境变量（AG_*）            ← 部署事实，只读
 * 3. 配置文件（config/*.json）   ← 仓库可带的缺省，只读
 * 4. DEFAULT_CONFIG              ← 编译期内置兜底
 * ```
 *
 * **为什么加密存储最高**（layering.ts 的理由，这里不重复）：它是运行时输入，
 * 管理员在 UI 里改的值必须立刻对请求路径生效，不能被「重启时重读的配置文件」
 * 盖回去。
 *
 * ## 「env 锁」：被 env 覆盖的项在 UI 里不可改
 *
 * 环境变量设了的项，UI 显示当前值 + 来源 `env` + 一把锁，**不接受修改**
 * （服务端同样拒绝，回 409 `env_locked`）。
 *
 * 这不是优先级改动——值解析仍然是「加密存储 > env > 配置文件 > 默认」。
 * 这是一条**可写性**规则：env 是部署时的显式决定（12-factor），UI 写入会造出
 * 一个静默遮盖 env 的覆盖层，于是同一份部署配置在不同机器上行为不同，而没人
 * 知道为什么。要改就改环境变量并重启；要改用 UI，先取消那个环境变量。
 *
 * ## 热生效
 *
 * 改完立刻写进**同一个** `GatewayConfig` 对象（pipeline 各阶段通过
 * `deps.config.xxx` 读它，因此即时生效）。另外两个不走 `deps.config` 的旋钮
 * 有专门的下推端口：
 *   - `model_sync_interval_ms` → `ModelSyncService.setPolicy()`（重启定时器）；
 *   - `plugin_timeout_ms`      → `PluginHost.setDefaultTimeoutMs()`。
 *
 * 重启后仍在：设置记录落在加密存储里，启动时 `load()` 读回来重新应用。
 *
 * ## 敏感值：只登记引用，绝不存值
 *
 * `secret_ref` kind 只存 `env:<VAR>` 这种**变量名引用**（65 §3.1 的硬规则）。
 * 注册接口收到 `value` 字段直接 400——不是忽略，是拒绝：静默忽略一个字段
 * 会让调用方以为值存下来了。
 */

import type { EncryptedRecordStore } from '../storage/record-store.js';
import type { AadRecordKind } from '../storage/crypto/aad.js';
import type { Clock } from '../ir/clock.js';
import type { GatewayConfig } from '../di/ports.js';
import { DEFAULT_CONFIG } from '../di/ports.js';
import { AGENT_DEFAULTS, type AgentConfig } from './agent.js';
import { validateRedactionRules } from '../storage/redaction.js';
import {
  runtimeSettingEnvOverrides,
  runtimeSettingEnvValues,
  RUNTIME_SETTING_ENV_VARS,
} from '../di/config.js';
import { loadLayeredConfigFile } from './layering.js';

/** 设置记录的 kind。 */
const SETTINGS_KIND: AadRecordKind = 'settings';
/** 敏感值引用登记的 kind。 */
const SECRET_REF_KIND: AadRecordKind = 'secret_ref';

/** 记录 id 前缀（与凭据的 `cred:` 同风格，肉眼可分类）。 */
const settingId = (key: RuntimeSettingKey): string => `set:${key}`;

/** key → 环境变量名（与 di/config.ts 的 `RUNTIME_SETTING_ENV_VARS` 同源）。 */
function envVarOf(key: RuntimeSettingKey): string {
  return RUNTIME_SETTING_ENV_VARS[key];
}

/** 可在运行时改的设置项 key（网关组 8 项 + Agent 组 13 项；白名单制，见文件头）。 */
export const RUNTIME_SETTING_KEYS = [
  'global_timeout_ms',
  'ttfb_timeout_ms',
  'stream_idle_timeout_ms',
  'max_retries',
  'retry_base_delay_ms',
  'loss_policy',
  'model_sync_interval_ms',
  'plugin_timeout_ms',
  'models_extended_metadata',
  'cross_modality_bridge',
  'save_full_messages',
  'gateway_stealth_enabled',
  'gateway_stealth_header',
  'gateway_stealth_key',
  'client_disconnect_mode',
  'client_disconnect_grace_ms',
  // ---- Agent 组（docs/design/95-agent-chat.md §6.2）----
  'agent_access_path',
  'agent_model',
  'agent_system_prompt',
  'agent_tools',
  'agent_redaction_rules',
  'agent_redaction_detect_js',
  'agent_redaction_placeholder',
  'agent_redact_tool_results',
  'agent_temperature',
  'agent_max_tokens',
  'agent_max_turns',
  'agent_stream',
  'agent_persist_messages',
] as const;

export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

/** 设置项分组（界面据此分区；Agent 组的默认值集中在 admin/agent-config.ts）。 */
export type SettingGroup = 'gateway' | 'agent';

/**
 * 值的类型。
 *
 * `int` / `number` 走范围校验；`enum` 走选项表；`string[]` 与 `json` 是 Agent 组
 * 引入的（工具开关是名单、脱敏规则是结构化数组）——它们让「规则即数据」成立：
 * 同一条数据服务端与前端都能执行（95 §5.4）。
 */
export type RuntimeSettingValueType =
  'int' | 'number' | 'enum' | 'string' | 'bool' | 'string[]' | 'json';

/** 设置项的取值（`json` 项存任意 JSON 值）。 */
export type SettingValue =
  number | string | boolean | string[] | unknown[] | Record<string, unknown>;

export interface RuntimeSettingSpec {
  key: RuntimeSettingKey;
  /**
   * `GatewayConfig` 上的字段名。
   *
   * Agent 组设置为空：它们的生效值不住在 `GatewayConfig` 里，而由 `apply` 推到
   * `admin/agent-config.ts` 的 `AgentConfigHub`（config 不反向依赖 admin，
   * 因此这里用结构类型的出口而不是直接持有 hub）。
   */
  field?: keyof GatewayConfig & string;
  label: string;
  type: RuntimeSettingValueType;
  /** 单位（UI 展示用）。 */
  unit: string;
  description: string;
  /** 分组。 */
  group: SettingGroup;
  /** 默认值（「恢复默认」与界面展示都取这里；Agent 组集中在 AGENT_DEFAULTS）。 */
  default_value?: SettingValue;
  /** int / number：闭区间。 */
  range?: { min: number; max: number };
  /** enum：允许值。 */
  options?: string[];
  /** json：值的形状校验（不合法时给出人类可读原因）。 */
  validate?(value: unknown): string | undefined;
  /**
   * Agent 组设置项对应的 `AgentConfig` 字段名。
   *
   * 用字段名而不是闭包：规格表是模块级常量，闭包在模块加载时就绑死了，装不上
   * 每个 gateway 自己的枢纽——同进程里建多个 gateway（测试常态）时会把设置写到
   * 最后一个的枢纽上。字段名由设置服务经 `runtime.agent` 出口按实例下发。
   */
  agent_field?: keyof AgentConfig;
}

/** 第一屏 8 项的规格表（顺序即 UI 顺序）。 */
export const RUNTIME_SETTINGS: readonly RuntimeSettingSpec[] = [
  {
    key: 'global_timeout_ms',
    field: 'globalTimeoutMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.globalTimeoutMs,
    label: '全局超时',
    type: 'int',
    unit: 'ms',
    description: '整个请求的上限（含上游与流式）。S0 据此算 deadline。',
    range: { min: 1_000, max: 3_600_000 },
  },
  {
    key: 'ttfb_timeout_ms',
    field: 'ttfbTimeoutMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.ttfbTimeoutMs,
    label: 'TTFB 超时',
    type: 'int',
    unit: 'ms',
    description: '上游首字节超时。',
    range: { min: 500, max: 600_000 },
  },
  {
    key: 'stream_idle_timeout_ms',
    field: 'streamIdleTimeoutMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.streamIdleTimeoutMs,
    label: '流式空闲超时',
    type: 'int',
    unit: 'ms',
    description: '杀掉「发了首块之后静默」的流（20 §S5）。',
    range: { min: 1_000, max: 3_600_000 },
  },
  {
    key: 'max_retries',
    field: 'maxRetries',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.maxRetries,
    label: '最大重试',
    type: 'int',
    unit: '次',
    description: '同 attempt 内的最大重试次数（20 §7.3）。',
    range: { min: 0, max: 10 },
  },
  {
    key: 'retry_base_delay_ms',
    field: 'retryBaseDelayMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.retryBaseDelayMs,
    label: '退避基数',
    type: 'int',
    unit: 'ms',
    description: '指数退避的基数，叠加 jitter。',
    range: { min: 0, max: 60_000 },
  },
  {
    key: 'loss_policy',
    field: 'lossPolicy',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.lossPolicy,
    label: 'loss policy',
    type: 'enum',
    unit: '',
    description: '字段丢失时的默认档；strict 会把丢失当错误。',
    options: ['allow', 'safe', 'strict', 'emulate'],
  },
  {
    key: 'model_sync_interval_ms',
    field: 'modelSyncIntervalMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.modelSyncIntervalMs,
    label: '模型同步间隔',
    type: 'int',
    unit: 'ms',
    description: '上游元数据周期同步间隔；0 = 不定时。',
    range: { min: 0, max: 86_400_000 },
  },
  {
    key: 'plugin_timeout_ms',
    field: 'pluginTimeoutMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.pluginTimeoutMs,
    label: '插件超时',
    type: 'int',
    unit: 'ms',
    description: '单个插件 hook 的单次调用超时。',
    range: { min: 100, max: 300_000 },
  },
  {
    key: 'models_extended_metadata',
    field: 'modelsExtendedMetadata',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.modelsExtendedMetadata,
    label: '模型列表扩展元数据',
    type: 'bool',
    unit: '',
    description:
      '在 /v1/models 中附带上下文窗口、最大输出、模态与兼容字段（dsh 等客户端可按需读取；关闭则只返回标准 OpenAI 字段）。',
  },
  {
    key: 'cross_modality_bridge',
    field: 'crossModalityBridge',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.crossModalityBridge ?? true,
    label: '跨模态协议自适配',
    type: 'bool',
    unit: '',
    description:
      '开启后允许跨大协议桥接（如通过 /v1/chat/completions 直接调用生图模型）；关闭后将拒绝跨模态调用并返回推荐端点指引。',
  },
  {
    key: 'save_full_messages',
    field: 'saveFullMessages',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.saveFullMessages ?? false,
    label: '保存完整对话消息',
    type: 'bool',
    unit: '',
    description:
      '私有部署可选开关：开启后把每次请求的完整消息内容（request / response）一并写入本地 SQLite 数据库（gateway.db），默认关闭。',
  },
  {
    key: 'gateway_stealth_enabled',
    field: 'stealthEnabled',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.stealthEnabled ?? false,
    label: '网关伪装模式',
    type: 'bool',
    unit: '',
    description:
      '开启后所有数据面 API 必须携带伪装密钥（默认请求头 x-gateway-key 或 ?gate_key=），否则直接返回 404 隐藏网关。',
  },
  {
    key: 'gateway_stealth_header',
    field: 'stealthHeader',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.stealthHeader ?? 'x-gateway-key',
    label: '伪装请求头',
    type: 'string',
    unit: '',
    description: '伪装模式下校验伪装密钥的 HTTP 请求头名（不区分大小写）。',
  },
  {
    key: 'gateway_stealth_key',
    field: 'stealthKey',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.stealthKey ?? '',
    label: '伪装密钥',
    type: 'string',
    unit: '',
    description: '伪装模式启用时数据面 API 必须携带的专用密钥，可在系统设置页复制或轮换。',
  },
  {
    key: 'client_disconnect_mode',
    field: 'clientDisconnectMode',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.clientDisconnectMode ?? 'immediate',
    label: '客户端断联处置',
    type: 'enum',
    options: ['immediate', 'grace', 'ignore'],
    unit: '',
    description:
      'immediate：客户端断联立即掐断上游；grace：先继续接收指定宽限时间，未结束再掐断；ignore：不主动中止上游。',
  },
  {
    key: 'client_disconnect_grace_ms',
    field: 'clientDisconnectGraceMs',
    group: 'gateway',
    default_value: DEFAULT_CONFIG.clientDisconnectGraceMs ?? 5_000,
    label: '断联宽限时间',
    type: 'int',
    unit: 'ms',
    range: { min: 0, max: 300_000 },
    description: '仅在 client_disconnect_mode=grace 时生效：客户端断联后先继续接收上游的毫秒数。',
  },
];

/**
 * Agent 组设置项（docs/design/95-agent-chat.md §6.2）。
 *
 * 默认值全部取自 `AGENT_DEFAULTS`（config/agent.ts）——**不在这里重复写字面量**，
 * 否则「恢复默认」与设置表会对不上。`apply` 把生效值推到 `AgentConfigHub`，
 * 聊天端点与插件读的都是那一份，因此界面改完立刻生效。
 */
export const AGENT_SETTINGS: readonly RuntimeSettingSpec[] = [
  {
    key: 'agent_access_path',
    group: 'agent',
    label: '渠道',
    type: 'string',
    unit: '',
    description: '跑 Agent 用哪条渠道（access path）。',
    default_value: AGENT_DEFAULTS.access_path,
    agent_field: 'access_path',
  },
  {
    key: 'agent_model',
    group: 'agent',
    label: '模型',
    type: 'string',
    unit: '',
    description: '跑 Agent 用哪个模型。',
    default_value: AGENT_DEFAULTS.model,
    agent_field: 'model',
  },
  {
    key: 'agent_system_prompt',
    group: 'agent',
    label: '系统提示词',
    type: 'string',
    unit: '',
    description: 'Agent 的系统提示词，可查看、可编辑、可恢复默认。',
    default_value: AGENT_DEFAULTS.system_prompt,
    agent_field: 'system_prompt',
  },
  {
    key: 'agent_tools',
    group: 'agent',
    label: '工具开关',
    type: 'string[]',
    unit: '',
    description: 'Agent 能看到哪些能力，由这里决定。',
    default_value: [...AGENT_DEFAULTS.tools],
    agent_field: 'tools',
  },
  {
    key: 'agent_redaction_rules',
    group: 'agent',
    label: '脱敏规则',
    type: 'json',
    unit: '',
    description: '结构化脱敏规则：正则 + 标志 + 替换文本。',
    default_value: [],
    validate: (v) => {
      try {
        validateRedactionRules(v);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    agent_field: 'redaction_rules',
  },
  {
    key: 'agent_redaction_detect_js',
    group: 'agent',
    label: '判定函数',
    type: 'string',
    unit: '',
    description: '自定义密钥判定函数源码，只在浏览器里执行。',
    default_value: AGENT_DEFAULTS.redaction_detect_js,
    agent_field: 'redaction_detect_js',
  },
  {
    key: 'agent_redaction_placeholder',
    group: 'agent',
    label: '占位符',
    type: 'string',
    unit: '',
    description: '命中后替换成的文本。',
    default_value: AGENT_DEFAULTS.redaction_placeholder,
    agent_field: 'redaction_placeholder',
  },
  {
    key: 'agent_redact_tool_results',
    group: 'agent',
    label: '工具结果脱敏',
    type: 'bool',
    unit: '',
    description: '工具结果进模型前再过一遍脱敏。',
    default_value: AGENT_DEFAULTS.redact_tool_results,
    agent_field: 'redact_tool_results',
  },
  {
    key: 'agent_temperature',
    group: 'agent',
    label: '温度',
    type: 'number',
    unit: '',
    description: '采样温度。',
    default_value: AGENT_DEFAULTS.temperature,
    range: { min: 0, max: 2 },
    agent_field: 'temperature',
  },
  {
    key: 'agent_max_tokens',
    group: 'agent',
    label: '最大输出',
    type: 'int',
    unit: 'token',
    description: '单回合最大输出 token。',
    default_value: AGENT_DEFAULTS.max_tokens,
    range: { min: 1, max: 200_000 },
    agent_field: 'max_tokens',
  },
  {
    key: 'agent_max_turns',
    group: 'agent',
    label: '最大轮次',
    type: 'int',
    unit: '轮',
    description: '工具循环上限。',
    default_value: AGENT_DEFAULTS.max_turns,
    range: { min: 1, max: 50 },
    agent_field: 'max_turns',
  },
  {
    key: 'agent_stream',
    group: 'agent',
    label: '流式',
    type: 'bool',
    unit: '',
    description: '对话是否走流式返回。',
    default_value: AGENT_DEFAULTS.stream,
    agent_field: 'stream',
  },
  {
    key: 'agent_persist_messages',
    group: 'agent',
    label: '保存记录',
    type: 'bool',
    unit: '',
    description: '是否把对话记录写进加密存储。',
    default_value: AGENT_DEFAULTS.persist_messages,
    agent_field: 'persist_messages',
  },
];

/** 全部设置项的规格表（网关组在前，Agent 组在后；顺序即界面顺序）。 */
export const ALL_SETTING_SPECS: readonly RuntimeSettingSpec[] = [
  ...RUNTIME_SETTINGS,
  ...AGENT_SETTINGS,
];

/**
 * Agent 组设置项的运行期出口（结构类型，避免 config → admin 的依赖）。
 *
 * 由组合根注入（`config/agent.ts` 的 `AgentConfigHub` 满足这个形状）。
 */
/**
 * 把设置值归一成 `AgentConfig` 该字段的类型。
 *
 * 集中在函数里而不是散在规格表的 `apply` 闭包：闭包在模块加载时绑定，看不见每个
 * gateway 自己的枢纽（见 `agent_field` 的注释）。JSON 类（规则数组）交给调用方
 * 自己收敛——`validate` 已经在保存时校验过形状。
 */
function coerceAgentField(field: keyof AgentConfig, value: SettingValue): SettingValue {
  switch (field) {
    case 'tools':
      return toStringArray(value);
    case 'redact_tool_results':
    case 'stream':
    case 'persist_messages':
      return toBool(value);
    case 'temperature':
    case 'max_tokens':
    case 'max_turns':
      return toNumber(value);
    // 规则数组：保存时已经过 validate 校验形状，原样交给枢纽
    case 'redaction_rules':
      return value;
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

function toStringArray(v: SettingValue): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((x) => String(x));
      } catch {
        // 落下去按逗号分隔解析
      }
    }
    return trimmed === ''
      ? []
      : trimmed
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
  }
  return [];
}

function toBool(v: SettingValue): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return /^(1|true|yes|on)$/i.test(v.trim());
  return false;
}

function toNumber(v: SettingValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return Number.NaN;
}

/** 库里的一条设置记录。 */
export interface SettingRecord {
  key: RuntimeSettingKey;
  value: SettingValue;
  updated_at: number;
  updated_by: string;
}

/** 库里的一条敏感值引用登记。**只有变量名，没有值**。 */
export interface SecretRefRecord {
  name: string;
  /** `env:<VAR>` 形态的引用（值在进程环境里）。 */
  ref: string;
  note?: string;
  created_at: number;
  updated_at: number;
}

/** 当前来源（四层里提供生效值的那一层）。 */
export type SettingSource = 'encrypted_storage' | 'env' | 'config_file' | 'default';

export interface SettingDescription {
  key: RuntimeSettingKey;
  label: string;
  description: string;
  unit: string;
  type: RuntimeSettingValueType;
  /** 分组（界面据此分区）。 */
  group: SettingGroup;
  /** 当前生效值。 */
  value: SettingValue;
  source: SettingSource;
  /** 能不能在 UI 里改。env 锁命中即为 false。 */
  editable: boolean;
  /** 不能改时的人类可读原因。 */
  reason?: string;
  /** 对应的环境变量名（配了才给）。 */
  env_var?: string;
  /** int / number 的范围 / enum 的允许值（UI 直接拿来渲染校验提示）。 */
  range?: { min: number; max: number };
  options?: string[];
  /** 内置默认值（「恢复默认」按钮直接用它）。 */
  default_value?: SettingValue;
  /** 加密存储里的值（与 `value` 不同说明被 env / 配置文件盖住了）。 */
  stored_value?: SettingValue;
  updated_at?: number;
  updated_by?: string;
}

export interface SettingsDescription {
  items: SettingDescription[];
  /** 配置文件路径（没配则不给这个字段）。 */
  config_file_path?: string;
}

/** 两个不走 `deps.config` 的旋钮的下推端口（可选；不注入就只改 config 对象）。 */
export interface SettingsRuntimePorts {
  modelSync?: { setPolicy(policy: { intervalMs?: number; ttlMs?: number }): void };
  pluginHost?: { setDefaultTimeoutMs(ms: number): void };
  /**
   * Agent 组设置项的出口（结构类型，避免 config → admin 的依赖）。
   *
   * 由组合根把 `config/agent.ts` 的 `AgentConfigHub` 接上来；同一个进程里建多个
   * gateway 时各写各的枢纽，不会串。
   */
  agent?: { set(field: keyof AgentConfig, value: SettingValue): void };
}

export interface SettingsServiceDeps {
  store: EncryptedRecordStore;
  clock: Clock;
  /** 运行时配置对象（**同一个引用**，pipeline 通过 `deps.config` 读它）。 */
  config: GatewayConfig;
  /**
   * 环境变量快照（测试用）。**不传就走 `runtimeSettingEnvOverrides()` 的缺省**，
   * 也就是让 di/config.ts 去读 `process.env`——本文件绝不直接读 env
   * （di/ports.ts 的硬约束：env 只在一处读）。
   */
  env?: NodeJS.ProcessEnv;
  /** 配置文件路径（第三层）。给了但文件不存在 = 没有这一层。 */
  configFilePath?: string;
  /** 热生效下推端口。 */
  runtime?: SettingsRuntimePorts;
}

export type SettingUpdateResult =
  { ok: true; item: SettingDescription } | { ok: false; status: 400 | 409; error: string };

/** 按 key 找规格（网关组 + Agent 组）。 */
export function specOf(key: RuntimeSettingKey): RuntimeSettingSpec | undefined {
  return ALL_SETTING_SPECS.find((s) => s.key === key);
}

/** 把外部传入的 JSON 值收敛成设置值（int / enum）。 */
export function coerceSettingValue(
  spec: RuntimeSettingSpec,
  raw: unknown,
): { ok: true; value: SettingValue } | { ok: false; error: string } {
  if (spec.type === 'enum') {
    if (typeof raw !== 'string' || spec.options?.includes(raw) !== true) {
      return { ok: false, error: `${spec.label} 只接受 ${(spec.options ?? []).join(' / ')}` };
    }
    return { ok: true, value: raw };
  }
  if (spec.type === 'string') {
    if (typeof raw !== 'string') return { ok: false, error: `${spec.label} 必须是字符串` };
    return { ok: true, value: raw };
  }
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (typeof raw === 'number') return { ok: true, value: raw !== 0 };
    if (typeof raw === 'string' && /^(1|0|true|false|yes|no|on|off)$/i.test(raw.trim())) {
      return { ok: true, value: /^(1|true|yes|on)$/i.test(raw.trim()) };
    }
    return { ok: false, error: `${spec.label} 必须是 true / false` };
  }
  if (spec.type === 'string[]') {
    const list = toStringArray(raw as SettingValue);
    if (typeof raw !== 'object' && typeof raw !== 'string') {
      return { ok: false, error: `${spec.label} 必须是字符串数组` };
    }
    return { ok: true, value: list };
  }
  if (spec.type === 'json') {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return { ok: false, error: `${spec.label} 必须是合法 JSON` };
      }
    }
    const invalid = spec.validate?.(parsed);
    if (invalid !== undefined) return { ok: false, error: invalid };
    return { ok: true, value: parsed as SettingValue };
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${spec.label} 必须是数字` };
  }
  if (spec.type === 'int' && !Number.isInteger(n)) {
    return { ok: false, error: `${spec.label} 必须是整数` };
  }
  const range = spec.range;
  if (range !== undefined && (n < range.min || n > range.max)) {
    return {
      ok: false,
      error: `${spec.label} 必须在 ${range.min}–${range.max} ${spec.unit} 之间`,
    };
  }
  return { ok: true, value: n };
}

export class SettingsService {
  private readonly deps: SettingsServiceDeps;

  constructor(deps: SettingsServiceDeps) {
    this.deps = deps;
  }

  // ---- 启动：把加密存储里的设置应用回运行时 ----

  /**
   * 读一遍设置记录并应用。返回应用了几项。
   *
   * 启动时调一次；管理面改值走 `update()`（同一条应用路径）。
   */
  async load(): Promise<number> {
    const records = new Map((await this.readRecords()).map((r) => [r.key, r] as const));
    const envValues = this.envValues();
    let applied = 0;
    for (const spec of ALL_SETTING_SPECS) {
      const resolved = this.resolveValue(
        spec,
        records.get(spec.key),
        envValues[spec.key],
        this.fileValueFor(spec, this.fileLayer()),
      );
      if (resolved === undefined) {
        // 四层都没有提供：把**默认值**也应用一遍。
        // 不做的后果是「删掉存储记录后运行期还留着旧值」——恢复默认会静默失效。
        if (spec.default_value !== undefined) this.applyToRuntime(spec, spec.default_value);
        continue;
      }
      this.applyToRuntime(spec, resolved);
      applied += 1;
    }
    return applied;
  }

  // ---- 查询：每一项的当前值 + 来源 + 能不能改 ----

  async describe(): Promise<SettingsDescription> {
    const records = new Map((await this.readRecords()).map((r) => [r.key, r] as const));
    const envValues = this.envValues();
    const envKeys = new Set(Object.keys(envValues) as RuntimeSettingKey[]);
    const file = this.fileLayer();

    const items: SettingDescription[] = ALL_SETTING_SPECS.map((spec) => {
      const stored = records.get(spec.key);
      const envVar = envVarOf(spec.key);
      const envSet = envKeys.has(spec.key);
      const fileValue = this.fileValueFor(spec, file);
      const inFile = fileValue !== undefined;

      let source: SettingSource = 'default';
      if (stored !== undefined) source = 'encrypted_storage';
      else if (envSet) source = 'env';
      else if (inFile) source = 'config_file';

      // 生效值：按四层解析。没有任何一层提供时，网关组退回运行时 config 对象
      // （那里面还有 DEFAULT_CONFIG 与测试的 options.config 覆盖），Agent 组退回
      // 规格表里的 `default_value`（它们的生效值不住在 GatewayConfig 里）。
      const resolved = this.resolveValue(spec, stored, envValues[spec.key], fileValue);
      const fallback =
        spec.field === undefined
          ? spec.default_value
          : (this.deps.config[spec.field] as SettingValue);
      const value = resolved ?? fallback ?? spec.default_value ?? '';
      const editable = !envSet;

      return {
        key: spec.key,
        label: spec.label,
        description: spec.description,
        unit: spec.unit,
        type: spec.type,
        group: spec.group,
        value,
        source,
        editable,
        ...(editable
          ? {}
          : {
              reason:
                `该项已由环境变量 ${envVar} 提供。环境变量是部署事实，界面写入会造出一个` +
                `静默遮盖它的覆盖层，使同一份部署配置在不同机器上行为不同。` +
                `请修改环境变量并重启；要改用界面，请先取消 ${envVar}。`,
            }),
        ...(envVar === undefined ? {} : { env_var: envVar }),
        ...(spec.range === undefined ? {} : { range: spec.range }),
        ...(spec.options === undefined ? {} : { options: spec.options }),
        ...(spec.default_value === undefined ? {} : { default_value: spec.default_value }),
        ...(stored === undefined
          ? {}
          : {
              stored_value: stored.value,
              updated_at: stored.updated_at,
              updated_by: stored.updated_by,
            }),
      };
    });

    return {
      items,
      ...(file.path === undefined ? {} : { config_file_path: file.path }),
    };
  }

  // ---- 修改：校验 → 落加密存储 → 热应用 ----

  async update(actor: string, key: string, raw: unknown): Promise<SettingUpdateResult> {
    const spec = specOf(key as RuntimeSettingKey);
    if (spec === undefined) {
      return { ok: false, status: 400, error: `未知设置项: ${key}` };
    }
    const envVar = envVarOf(spec.key);
    if (runtimeSettingEnvOverrides(this.deps.env).includes(spec.key)) {
      return {
        ok: false,
        status: 409,
        error:
          `该项已由环境变量 ${envVar} 提供，不能在界面里改。` +
          `请修改环境变量并重启；要改用界面，请先取消该环境变量。`,
      };
    }
    const coerced = coerceSettingValue(spec, raw);
    if (!coerced.ok) return { ok: false, status: 400, error: coerced.error };

    const now = this.deps.clock.now();
    const record: SettingRecord = {
      key: spec.key,
      value: coerced.value,
      updated_at: now,
      updated_by: actor,
    };
    await this.deps.store.put(SETTINGS_KIND, settingId(spec.key), record, now);
    this.applyToRuntime(spec, coerced.value);

    const described = await this.describe();
    const item = described.items.find((i) => i.key === spec.key);
    if (item === undefined) {
      return { ok: false, status: 400, error: '设置已写入但读不回来（内部错误）' };
    }
    return { ok: true, item };
  }

  /**
   * 恢复默认：删掉加密存储里的记录，让值沿四层回落。
   *
   * 比「把默认值写进去」诚实——后者会让来源永远显示「已修改」，而部署者从此
   * 分不清哪项是自己改的、哪项是默认。删记录则来源回到 env / 配置文件 / 默认。
   *
   * env 锁命中的项同样允许删（删的是加密存储那一层，env 仍然生效），但这通常
   * 没有可见效果；返回的 `item` 会把真实来源说清楚。
   */
  async reset(_actor: string, key: string): Promise<SettingUpdateResult> {
    const spec = specOf(key as RuntimeSettingKey);
    if (spec === undefined) {
      return { ok: false, status: 400, error: `未知设置项: ${key}` };
    }
    await this.deps.store.delete(SETTINGS_KIND, settingId(spec.key));
    // 删完立刻把默认值应用回去：否则「恢复默认」在重启前不生效，
    // 而用户看到的是已经变回默认的界面——「看得到但没生效」比报错更糟。
    if (spec.default_value !== undefined) this.applyToRuntime(spec, spec.default_value);

    const described = await this.describe();
    const item = described.items.find((i) => i.key === spec.key);
    if (item === undefined) {
      return { ok: false, status: 400, error: '设置已重置但读不回来（内部错误）' };
    }
    return { ok: true, item };
  }

  // ---- 敏感值引用（只登记变量名）----

  async listSecretRefs(): Promise<SecretRefRecord[]> {
    const all = await this.deps.store.listDecrypted<SecretRefRecord>(SECRET_REF_KIND);
    return all.map((r) => r.value).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 登记一个敏感值引用。
   *
   * 请求体里出现 `value` 字段 → **400 拒绝**（不是忽略）。见文件头。
   */
  async registerSecretRef(input: {
    name: string;
    env_var: string;
    note?: string;
    value?: unknown;
  }): Promise<{ ok: true; ref: SecretRefRecord } | { ok: false; status: 400; error: string }> {
    if (input.value !== undefined) {
      return {
        ok: false,
        status: 400,
        error:
          '不接受 value 字段：敏感值只以 env:<VAR> 引用的形态登记，值必须留在进程环境里' +
          '（65 §3.1）。请把值写进部署环境变量，然后只传 env_var。',
      };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.env_var)) {
      return { ok: false, status: 400, error: 'env_var 必须是合法的环境变量名' };
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.name)) {
      return { ok: false, status: 400, error: 'name 只能用小写字母 / 数字 / . _ -' };
    }
    const now = this.deps.clock.now();
    const prev = await this.deps.store.get<SecretRefRecord>(SECRET_REF_KIND, input.name);
    const record: SecretRefRecord = {
      name: input.name,
      ref: `env:${input.env_var}`,
      ...(input.note === undefined ? {} : { note: input.note }),
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };
    await this.deps.store.put(SECRET_REF_KIND, input.name, record, now);
    return { ok: true, ref: record };
  }

  async deleteSecretRef(name: string): Promise<boolean> {
    return this.deps.store.delete(SECRET_REF_KIND, name);
  }

  // -------------------------------------------------------------------------

  private applyToRuntime(spec: RuntimeSettingSpec, value: SettingValue): void {
    // 同一个 config 对象：pipeline 各阶段经 deps.config 读，改完即生效。
    // 走双重断言而不是给 GatewayConfig 加索引签名——那个签名会让「拼错字段名」
    // 也变成合法的（静默无效），比这里的断言危险。
    if (spec.field !== undefined) {
      (this.deps.config as unknown as Record<string, unknown>)[spec.field] = value;
    }
    // Agent 组设置项推到 AgentConfigHub（按字段名，值先归一成该字段的类型）
    if (spec.agent_field !== undefined) {
      this.deps.runtime?.agent?.set(spec.agent_field, coerceAgentField(spec.agent_field, value));
    }
    // 两个不走 deps.config 的旋钮
    if (spec.key === 'model_sync_interval_ms' && typeof value === 'number') {
      this.deps.runtime?.modelSync?.setPolicy({ intervalMs: value });
    }
    if (spec.key === 'plugin_timeout_ms' && typeof value === 'number') {
      this.deps.runtime?.pluginHost?.setDefaultTimeoutMs(value);
    }
  }

  private async readRecords(): Promise<SettingRecord[]> {
    const all = await this.deps.store.listDecrypted<SettingRecord>(SETTINGS_KIND);
    return all.map((r) => r.value).filter((r) => specOf(r.key) !== undefined);
  }

  /**
   * 第三层：配置文件里的 `gateway` 段（layering.ts 的形状）。
   *
   * 读失败（不存在 / 坏 JSON）按「没有这一层」处理——理由同 layering.ts 的
   * `loadLayeredConfigFile`：配置文件是可选的最低层，缺了就退到编译期默认值。
   *
   * `path` 只在**真的读到了文件**时才给：界面要展示「配置文件在哪」，
   * 报一个不存在的路径会让人去找一个永远找不到的文件。
   */
  private fileLayer(): {
    gateway: Partial<GatewayConfig>;
    agent: Record<string, unknown>;
    path?: string;
  } {
    const path = this.deps.configFilePath;
    if (path === undefined) return { gateway: {}, agent: {} };
    try {
      const layered = loadLayeredConfigFile(path);
      return { gateway: layered.gateway ?? {}, agent: layered.agent ?? {}, path };
    } catch {
      return { gateway: {}, agent: {} };
    }
  }

  /**
   * 一个设置项从配置文件层拿到的原值。
   *
   * 网关组读 `gateway` 段（按 `GatewayConfig` 字段名），Agent 组读 `agent` 段
   * （按设置项 key）。两段分开是因为两组的生效值去向不同，混在一段里会让
   * 「这项配了却没生效」变得难查。
   */
  private fileValueFor(
    spec: RuntimeSettingSpec,
    file: { gateway: Partial<GatewayConfig>; agent: Record<string, unknown> },
  ): unknown {
    if (spec.field !== undefined) return file.gateway[spec.field];
    return file.agent[spec.key];
  }

  /** env 层原值。不传 env 快照时由 di/config.ts 去读 process.env。 */
  private envValues(): Partial<Record<RuntimeSettingKey, string>> {
    return this.deps.env === undefined
      ? runtimeSettingEnvValues()
      : runtimeSettingEnvValues(this.deps.env);
  }

  /**
   * 按四层优先级解析一个设置项的值。
   *
   * 返回 undefined = 没有任何一层提供值（调用方退到运行时 config 对象）。
   * env 原值不合法时按「这一层没提供」处理——与 `loadConfigFromEnv` 对坏 env 值
   * 的宽容立场一致（坏一个环境变量不该让整个设置界面报错）。
   */
  private resolveValue(
    spec: RuntimeSettingSpec,
    stored: SettingRecord | undefined,
    envRaw: string | undefined,
    fileValue: unknown,
  ): SettingValue | undefined {
    if (stored !== undefined) {
      const coerced = coerceSettingValue(spec, stored.value);
      if (coerced.ok) return coerced.value;
    }
    if (envRaw !== undefined) {
      const coerced = coerceSettingValue(spec, envRaw);
      if (coerced.ok) return coerced.value;
    }
    if (fileValue !== undefined) {
      const coerced = coerceSettingValue(spec, fileValue);
      if (coerced.ok) return coerced.value;
    }
    return undefined;
  }
}
