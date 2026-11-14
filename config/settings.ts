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

/** 可在运行时改的 8 个设置项（P0-2 第一屏；白名单制，见文件头）。 */
export const RUNTIME_SETTING_KEYS = [
  'global_timeout_ms',
  'ttfb_timeout_ms',
  'stream_idle_timeout_ms',
  'max_retries',
  'retry_base_delay_ms',
  'loss_policy',
  'model_sync_interval_ms',
  'plugin_timeout_ms',
] as const;

export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

/** 值的类型。v1 只有整数与枚举。 */
export type RuntimeSettingValueType = 'int' | 'enum';

export interface RuntimeSettingSpec {
  key: RuntimeSettingKey;
  /** `GatewayConfig` 上的字段名。 */
  field: keyof GatewayConfig & string;
  label: string;
  type: RuntimeSettingValueType;
  /** 单位（UI 展示用）。 */
  unit: string;
  description: string;
  /** int：闭区间。 */
  range?: { min: number; max: number };
  /** enum：允许值。 */
  options?: string[];
}

/** 第一屏 8 项的规格表（顺序即 UI 顺序）。 */
export const RUNTIME_SETTINGS: readonly RuntimeSettingSpec[] = [
  {
    key: 'global_timeout_ms',
    field: 'globalTimeoutMs',
    label: '全局超时',
    type: 'int',
    unit: 'ms',
    description: '整个请求的上限（含上游与流式）。S0 据此算 deadline。',
    range: { min: 1_000, max: 3_600_000 },
  },
  {
    key: 'ttfb_timeout_ms',
    field: 'ttfbTimeoutMs',
    label: 'TTFB 超时',
    type: 'int',
    unit: 'ms',
    description: '上游首字节超时。',
    range: { min: 500, max: 600_000 },
  },
  {
    key: 'stream_idle_timeout_ms',
    field: 'streamIdleTimeoutMs',
    label: '流式空闲超时',
    type: 'int',
    unit: 'ms',
    description: '杀掉「发了首块之后静默」的流（20 §S5）。',
    range: { min: 1_000, max: 3_600_000 },
  },
  {
    key: 'max_retries',
    field: 'maxRetries',
    label: '最大重试',
    type: 'int',
    unit: '次',
    description: '同 attempt 内的最大重试次数（20 §7.3）。',
    range: { min: 0, max: 10 },
  },
  {
    key: 'retry_base_delay_ms',
    field: 'retryBaseDelayMs',
    label: '退避基数',
    type: 'int',
    unit: 'ms',
    description: '指数退避的基数，叠加 jitter。',
    range: { min: 0, max: 60_000 },
  },
  {
    key: 'loss_policy',
    field: 'lossPolicy',
    label: 'loss policy',
    type: 'enum',
    unit: '',
    description: '字段丢失时的默认档；strict 会把丢失当错误。',
    options: ['allow', 'safe', 'strict', 'emulate'],
  },
  {
    key: 'model_sync_interval_ms',
    field: 'modelSyncIntervalMs',
    label: '模型同步间隔',
    type: 'int',
    unit: 'ms',
    description: '上游元数据周期同步间隔；0 = 不定时。',
    range: { min: 0, max: 86_400_000 },
  },
  {
    key: 'plugin_timeout_ms',
    field: 'pluginTimeoutMs',
    label: '插件超时',
    type: 'int',
    unit: 'ms',
    description: '单个插件 hook 的单次调用超时。',
    range: { min: 100, max: 300_000 },
  },
];

/** 库里的一条设置记录。 */
export interface SettingRecord {
  key: RuntimeSettingKey;
  value: number | string;
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
  /** 当前生效值。 */
  value: number | string;
  source: SettingSource;
  /** 能不能在 UI 里改。env 锁命中即为 false。 */
  editable: boolean;
  /** 不能改时的人类可读原因。 */
  reason?: string;
  /** 对应的环境变量名（配了才给）。 */
  env_var?: string;
  /** int 的范围 / enum 的允许值（UI 直接拿来渲染校验提示）。 */
  range?: { min: number; max: number };
  options?: string[];
  /** 加密存储里的值（与 `value` 不同说明被 env / 配置文件盖住了）。 */
  stored_value?: number | string;
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

/** 按 key 找规格。 */
export function specOf(key: RuntimeSettingKey): RuntimeSettingSpec | undefined {
  return RUNTIME_SETTINGS.find((s) => s.key === key);
}

/** 把外部传入的 JSON 值收敛成设置值（int / enum）。 */
export function coerceSettingValue(
  spec: RuntimeSettingSpec,
  raw: unknown,
): { ok: true; value: number | string } | { ok: false; error: string } {
  if (spec.type === 'enum') {
    if (typeof raw !== 'string' || spec.options?.includes(raw) !== true) {
      return { ok: false, error: `${spec.label} 只接受 ${(spec.options ?? []).join(' / ')}` };
    }
    return { ok: true, value: raw };
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
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
    const fileLayer = this.fileLayer().values;
    let applied = 0;
    for (const spec of RUNTIME_SETTINGS) {
      const resolved = this.resolveValue(
        spec,
        records.get(spec.key),
        envValues[spec.key],
        fileLayer[spec.field],
      );
      if (resolved === undefined) continue;
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
    const fileLayer = file.values;

    const items: SettingDescription[] = RUNTIME_SETTINGS.map((spec) => {
      const stored = records.get(spec.key);
      const envVar = envVarOf(spec.key);
      const envSet = envKeys.has(spec.key);
      const inFile = fileLayer[spec.field] !== undefined;

      let source: SettingSource = 'default';
      if (stored !== undefined) source = 'encrypted_storage';
      else if (envSet) source = 'env';
      else if (inFile) source = 'config_file';

      // 生效值：按四层解析。没有任何一层提供时退回运行时 config 对象
      // （那里面还有 DEFAULT_CONFIG 与测试的 options.config 覆盖）。
      const value =
        this.resolveValue(spec, stored, envValues[spec.key], fileLayer[spec.field]) ??
        (this.deps.config[spec.field] as number | string);
      const editable = !envSet;

      return {
        key: spec.key,
        label: spec.label,
        description: spec.description,
        unit: spec.unit,
        type: spec.type,
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

  private applyToRuntime(spec: RuntimeSettingSpec, value: number | string): void {
    // 同一个 config 对象：pipeline 各阶段经 deps.config 读，改完即生效。
    // 走双重断言而不是给 GatewayConfig 加索引签名——那个签名会让「拼错字段名」
    // 也变成合法的（静默无效），比这里的断言危险。
    (this.deps.config as unknown as Record<string, unknown>)[spec.field] = value;
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
  private fileLayer(): { values: Partial<GatewayConfig>; path?: string } {
    const path = this.deps.configFilePath;
    if (path === undefined) return { values: {} };
    try {
      const layered = loadLayeredConfigFile(path);
      return { values: layered.gateway ?? {}, path };
    } catch {
      return { values: {} };
    }
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
  ): number | string | undefined {
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
