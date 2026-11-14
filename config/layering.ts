/**
 * config/layering.ts —— 配置分层：非敏感默认值走配置文件，敏感值只进加密存储。
 *
 * 任务书要求「三者优先级写清」。本文件是那三者的**唯一实现处**与**文档处**。
 *
 * ## 三层与优先级（从高到低）
 *
 * ```text
 * 1. 加密存储（storage/）           凭据、别名规则、provider 覆盖、审计
 *      ↑ 最高：管理员在 UI/API 里改的，运行时即时生效，重启后仍在
 * 2. 环境变量（env: 引用）            provider key 等敏感值的**引用名**
 *      ↑ 中：值本身在进程环境里，配置对象只登记变量名
 * 3. 配置文件（config/*.json）       非敏感默认值（超时、重试、保留策略…）
 *      ↑ 最低：仓库内可带的缺省，部署时可覆盖
 * 4. DEFAULT_CONFIG（di/ports.ts）   编译期内置兜底
 * ```
 *
 * ## 为什么环境变量排在配置文件**之上**而不是之下
 *
 * 因为 12-factor 的部署现实：同一份仓库要跑在开发机 /  staging / 生产，
 * 差异全在环境。若配置文件优先，就得为每个环境维护一份完整配置——而那恰恰
 * 是「敏感值漂进配置文件」最常见的路径。
 *
 * ## 为什么加密存储最高
 *
 * 它是**运行时**输入：管理员刚在 UI 里加的 provider、刚建的别名，必须立刻
 * 对请求路径生效，不能被「重启时重读的配置文件」盖回去。
 *
 * ## 敏感值的一条硬规则
 *
 * **敏感值（凭据）只以两种形态存在**：
 *   - `env:<VARNAME>` 引用（值在进程环境，配置对象里只有变量名）；
 *   - 加密存储里的密文（storage/record-store.ts 的密文列）。
 *
 * 配置文件里**绝不出现**敏感值——`privacy-scan --staged --fail-on any`
 * 会把它们拦下，但真正的防线是这条规则本身：配置文件是要入 git 的，
 * 而入 git 的东西必须假定会泄露。
 */

import { readFileSync } from 'node:fs';
import type { GatewayConfig } from '../di/ports.js';

/** 环境变量引用。值在进程环境里，本对象只存变量名。 */
export interface EnvRef {
  readonly env: string;
}

/** 判断一个字符串是不是 `env:` 引用。 */
export function isEnvRef(value: string): value is string & { __envRef: true } {
  return value.startsWith('env:');
}

/** 从 `env:<VAR>` 取出变量名。 */
export function envRefName(ref: string): string {
  if (!isEnvRef(ref)) throw new Error(`不是 env: 引用: ${ref}`);
  return ref.slice('env:'.length);
}

/** 非敏感配置的形状（配置文件能放的东西）。 */
export interface LayeredConfig {
  /** 配置格式版本。 */
  version: 1;
  /** 网关非敏感配置（与 GatewayConfig 同字段，全部可选）。 */
  gateway?: Partial<GatewayConfig>;
  /** 管理面配置。 */
  admin?: {
    /** 控制面 HTTP 挂载前缀。 */
    mount_path?: string;
    /** 是否启用管理面（默认 true；完全不需要控制面时可关）。 */
    enabled?: boolean;
    /** 会话有效期（ms）。 */
    session_ttl_ms?: number;
  };
  /** 存储配置。 */
  storage?: {
    /** 密钥表文件路径（0600）。 */
    keystore_path?: string;
    /** 加密记录存储文件路径（0600）。 */
    records_path?: string;
    /** key 文件路径（key_file 解锁模式）。 */
    kek_keyfile_path?: string;
  };
  /** 保留策略（65 §7）。 */
  retention?: {
    messages_days?: number;
    usage_days?: number;
    rollup_after_days?: number;
  };
}

/** 编译期内置的非敏感默认值（最低层）。 */
export const DEFAULT_LAYERED_CONFIG: LayeredConfig = {
  version: 1,
  admin: {
    mount_path: '/admin',
    enabled: true,
    session_ttl_ms: 12 * 60 * 60 * 1000,
  },
  retention: {
    messages_days: 30,
    usage_days: 365,
    rollup_after_days: 90,
  },
};

/**
 * 读一个配置文件。
 *
 * 读失败（不存在 / 坏 JSON / 版本不对）**不抛错**：配置文件是可选的最低层，
 * 缺了就退到编译期默认值。抛错会让「没配文件」变成「起不来」，
 * 而那正是新部署第一件事不该遇到的事。
 *
 * 版本不符时抛错（不是静默忽略）：一个 v2 的配置被当 v1 解析，会静默丢掉
 * 新字段——那种「配了却没生效」的 bug 极难查。
 */
export function loadLayeredConfigFile(path: string): LayeredConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ...DEFAULT_LAYERED_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `配置文件 ${path} 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`配置文件 ${path} 顶层必须是对象`);
  }
  const obj = parsed as Partial<LayeredConfig>;
  if (obj.version !== 1) {
    throw new Error(
      `配置文件 ${path} 版本不支持: ${String(obj.version)}（本实现只支持 version: 1）。` +
        '请升级配置或改用环境变量。',
    );
  }
  return mergeLayered(DEFAULT_LAYERED_CONFIG, obj);
}

/** 深合并两层配置（后者覆盖前者；undefined 不覆盖）。 */
export function mergeLayered(base: LayeredConfig, over: Partial<LayeredConfig>): LayeredConfig {
  return {
    version: 1,
    ...(base.gateway === undefined && over.gateway === undefined
      ? {}
      : { gateway: { ...(base.gateway ?? {}), ...(over.gateway ?? {}) } }),
    ...(base.admin === undefined && over.admin === undefined
      ? {}
      : {
          admin: {
            ...(base.admin ?? {}),
            ...(over.admin ?? {}),
          },
        }),
    ...(base.storage === undefined && over.storage === undefined
      ? {}
      : {
          storage: {
            ...(base.storage ?? {}),
            ...(over.storage ?? {}),
          },
        }),
    ...(base.retention === undefined && over.retention === undefined
      ? {}
      : {
          retention: {
            ...(base.retention ?? {}),
            ...(over.retention ?? {}),
          },
        }),
  };
}

/**
 * 把一个 `env:` 引用解析成实际值。
 *
 * 拿不到环境变量时抛错并**说清是哪个变量**——「凭据没配」和「环境变量名拼错」
 * 在生活中是同一类问题，但错误信息必须能区分。
 */
export function resolveEnvRef(ref: string, env: Record<string, string | undefined>): string {
  const name = envRefName(ref);
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `环境变量 ${name} 未设置或为空（凭据引用 ${ref}）。` +
        '请在部署环境里设置它；不要把值写进配置文件（配置文件要入 git）。',
    );
  }
  return value;
}
