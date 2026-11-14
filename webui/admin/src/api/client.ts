/**
 * src/api/client.ts —— 管理面 API 客户端（fetch 封装 + 三条安全约定）。
 *
 * 契约见 admin/api-types.ts；本文件只消费 `/admin/api/*`，不发明端点。
 *
 * ## 三条写进代码的安全约定（承自旧实现，不得弱化）
 *
 * 1. **会话令牌只在内存**：令牌由调用方（auth.tsx）持有，本客户端经 `getToken()`
 *    读取后放进 `Authorization: Bearer`，**绝不写 localStorage / sessionStorage**。
 * 2. **完整密钥永不渲染**：`secretTripwire` 在把响应交回页面前扫一遍，出现疑似
 *    完整密钥的值就抛错并阻止渲染（只在 console.warn 记字段路径，绝不记值）。
 *    判据**以值的形状为主**（已知密钥前缀 + 长度 + 字符集），字段名只是辅助信号——
 *    只认字段名那次把设置页整页拦死过（设置项标识符叫 `key`，与虚拟 key 域撞名），
 *    见 `looksLikeSecretValue` 的注释。
 * 3. **401 行为不变**：带令牌仍 401 = 会话过期 → 回调 `onUnauthorized` 让上层清令牌
 *    回登录页；登录接口本身的 401 是「口令/token 不对」，原样带 message 给用户。
 */

import type { ApiError } from './types';

const API = '/admin/api';

/** 统一失败类型：code 取自错误信封，message 直接展示。 */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
  }
}

export interface ClientHooks {
  /** 取内存里的会话令牌（无则返回 null）。 */
  getToken(): string | null;
  /** 带令牌仍 401 = 会话过期，调用方清令牌回登录页。 */
  onUnauthorized(): void;
}

/**
 * 已知的**完整密钥前缀**（按各 provider 的 key 格式维护；接新 provider 时往里加）。
 *
 * 后面必须跟 ≥8 位 base62 随机位才算数：`sk-` / `sk-ant-` 这种**前缀本身**
 * （`provider-presets` 的 `key_prefix` 字段就是拿它当提示文案的）和
 * `sk-ag-mV` 这种**掩码用的前 8 位**都不算泄漏。
 */
const KEY_PREFIX_RE =
  /^(?:sk-ag-|sk-ant-|sk-proj-|sk-|rk-|gh[pousr]_|github_pat_|glpat-|xox[bpsa]-|npm_|shpat_|hf_|AIza|AKIA|ASIA|dapi|sk_live_|pk_live_)[A-Za-z0-9]{8,}$/;

/** 没有已知前缀时，按「一长串无分隔符 base62」判的最小长度。 */
const MIN_OPAQUE_LEN = 20;

/** 看起来已被掩码过（含 * 或 …）的值不算泄漏。 */
function looksMasked(value: string): boolean {
  return /[*…•]/.test(value);
}

/**
 * **值的形状**是否就是一把完整密钥。与字段名无关。
 *
 * 这是 tripwire 的主判据。历史教训：早先只认字段名（见到 `key` 就拦），结果
 * `GET /settings` 的每一项用 `key` 字段承载设置项标识符（`global_timeout_ms`…），
 * 与虚拟 key 域撞名，整个设置页被误拦成「读不到设置项」。设置项的标识符后来
 * 改名叫 `id`（admin/api-types.ts 的 SettingDto），但**根因是这个函数当时不存在**：
 * 字段名从来不是可靠的泄漏信号，值才是。
 *
 * 两类形态算泄漏：
 *   1. 已知密钥前缀 + ≥8 位随机位（`sk-ag-` + 32 位随机、`AIza…`、`ghp_…`）；
 *   2. 一长串无分隔符的 base62，且大小写与数字俱全（随机凭据的典型形态）。
 *
 * 刻意**不算**泄漏的形状（都是管理面响应里真实存在的值）：
 *   - 带 `_` / `-` / `.` / `:` 的结构化标识：`req_01J…`、`dek_ab12…`、
 *     `deepseek.chat`、`env:AG_OPENAI_API_KEY`、`0.1.0`、URL；
 *   - 十六进制指纹（`kek_fingerprint` 是 16 位，且不带大写字母）；
 *   - 掩码值（`sk-****6789`、`sk-ag-mV…`）与前 8 位（`head`，比前缀阈值短）。
 */
function looksLikeSecretValue(value: string): boolean {
  if (value.length < 12 || looksMasked(value)) return false;
  if (KEY_PREFIX_RE.test(value)) return true;
  if (value.length < MIN_OPAQUE_LEN) return false;
  if (!/^[A-Za-z0-9]+$/.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/**
 * 字段名是秘密命名时的**辅助**判据（没有固定前缀的 key 格式靠它兜底）。
 *
 * **不含裸 `key`**：设置项的标识符历史上就叫 `key`，与虚拟 key 域撞名，只认
 * 字段名那次误报就是它。也不含 `credential`——`credential_id` 是标识符不是秘密。
 */
const SECRETISH_NAME_RE =
  /(secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passphrase|authorization|bearer|private[_-]?key|client[_-]?secret)/i;

/**
 * 不透明凭据形态（只给字段名当辅助信号）：够长、无空白、不是路径 / URL /
 * `env:VAR` 引用、不是「全小写且无数字」的标识符或自然语言。
 *
 * 字符集放到 base64 + 常见口令符号：`Tr0ub4dor&3` 这种带 `&` 的口令得认。
 * （`*` 故意不在内——它会被 `looksMasked` 判成掩码。）
 */
function isOpaqueCredentialish(value: string): boolean {
  if (value.length < 8 || looksMasked(value)) return false;
  if (/[\s:/\\]/.test(value)) return false;
  if (!/[0-9]/.test(value) && value === value.toLowerCase()) return false;
  return /^[A-Za-z0-9._+=\-!@#$%^&?~|]+$/.test(value);
}

/** 一个字符串字段是否「疑似完整密钥」。 */
function isSecretLikeField(name: string, value: string): boolean {
  // ① 值本身就是密钥形态 → 与字段名无关（哪怕它叫 `id` / `note` / `key`）。
  if (looksLikeSecretValue(value)) return true;
  // ② 字段名是秘密命名 + 值是不透明凭据 → 兜住没有固定前缀的 key 格式。
  return SECRETISH_NAME_RE.test(name) && isOpaqueCredentialish(value);
}

/**
 * 上面几个判据导出给回归测试用（`src/api/client.test.ts`）：
 * 业务代码一律走 `secretTripwire`，不要直接调它们。
 */
export { findSecretLike, looksLikeSecretValue, isSecretLikeField };

/**
 * 在响应体里找疑似完整密钥字段，返回 `路径[]`（**只回路径，不回值**——
 * 回值就等于把密钥写进控制台）。
 *
 * 两个开口子都**只认字面字段名**，且各自只有一个调用方：
 *   - `allowPlaintext` → `plaintext`（`POST /virtual-keys`，管理面唯一返回
 *     完整密钥的地方，见 api/types.ts 的 VirtualKeyCreateResponse）；
 *   - `allowSessionToken` → `token`（`POST /login`，会话令牌客户端本来就要拿）。
 * 其他任何 secret 形字段照样拦。
 */
function findSecretLike(
  value: unknown,
  path = '',
  depth = 0,
  out: string[] = [],
  allowPlaintext = false,
  allowSessionToken = false,
): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      findSecretLike(item, `${path}[${i}]`, depth + 1, out, allowPlaintext, allowSessionToken),
    );
    return out;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    const exempt =
      (allowPlaintext && key === 'plaintext') || (allowSessionToken && key === 'token');
    if (!exempt && typeof item === 'string' && isSecretLikeField(key, item)) {
      out.push(here);
    } else {
      findSecretLike(item, here, depth + 1, out, allowPlaintext, allowSessionToken);
    }
  }
  return out;
}

/** 渲染前检查：命中就抛 ApiFailure（调用方据此阻止渲染该对象）。 */
function secretTripwire(
  data: unknown,
  label: string,
  allowPlaintext = false,
  allowSessionToken = false,
): void {
  const hits = findSecretLike(data, '', 0, [], allowPlaintext, allowSessionToken);
  if (hits.length === 0) return;
  console.warn(`[admin] ${label} 返回了疑似完整密钥的值，已阻止渲染：${hits.join(', ')}`);
  throw new ApiFailure(
    'secret_leak_blocked',
    `已阻止渲染：${label} 的响应里出现疑似完整密钥的值（${hits.join('、')}）。` +
      '完整密钥不应由管理面 API 返回，请检查 admin/routes.ts 的脱敏逻辑。',
  );
}

/** 从响应体挑错误文案：先认统一信封，再认 `{ ok:false, error }`。 */
function pickErrorMessage(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const obj = data as Record<string, unknown>;
  const envelope = obj.error;
  if (typeof envelope === 'string' && envelope.length > 0) return envelope;
  if (envelope && typeof envelope === 'object') {
    const msg = (envelope as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  if (obj.ok === false && typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  return undefined;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 免鉴权（登录 / bootstrap）。 */
  auth?: boolean;
  /** 跳过的 secret tripwire 标签（默认用 path）。 */
  tripwireLabel?: string;
  /**
   * 允许响应里出现字面名为 `plaintext` 的字段。
   *
   * **只有 `POST /virtual-keys` 可以用**——那是管理面唯一返回完整密钥的端点
   * （66 §2.2：明文只在创建响应里返回一次）。其他 secret 形字段照样被拦。
   */
  allowPlaintext?: boolean;
  /**
   * 允许响应里出现字面名为 `token` 的字段。
   *
   * **只有 `POST /login` 可以用**：会话令牌是客户端本来就要拿在手里的 bearer
   * 凭据，而它的形态（43 位 base64url 随机串）与一把没有固定前缀的 provider
   * key **无法从值上区分**——只能在这里显式开口子。登录响应里的其他字段
   * （`user` / `expires_at` / `error`）照样过守卫，将来谁往登录响应里塞一把
   * key 仍然会被拦下。
   */
  allowSessionToken?: boolean;
}

async function decode(
  res: Response,
  hooks: ClientHooks,
  label: string,
  allowPlaintext: boolean,
  allowSessionToken: boolean,
): Promise<unknown> {
  const text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message = pickErrorMessage(data) ?? `HTTP ${res.status} ${res.statusText}`;
    // 带令牌还 401 = 会话过期；登录接口的 401 不走这条（那时还没有令牌）
    if (res.status === 401 && hooks.getToken() !== null) {
      hooks.onUnauthorized();
      throw new ApiFailure('unauthorized', '会话已过期或未授权，请重新登录。', 401);
    }
    const code = (data as ApiError | null)?.error?.code ?? `http_${res.status}`;
    throw new ApiFailure(code, message, res.status);
  }
  secretTripwire(data, label, allowPlaintext, allowSessionToken);
  return data ?? {};
}

/** 发一次请求。 */
export async function api<T>(
  path: string,
  options: RequestOptions,
  hooks: ClientHooks,
): Promise<T> {
  const {
    method = 'GET',
    body,
    auth = true,
    tripwireLabel,
    allowPlaintext = false,
    allowSessionToken = false,
  } = options;
  const token = auth ? hooks.getToken() : null;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiFailure(
      'network',
      `连不上网关：${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }
  const data = await decode(
    res,
    hooks,
    tripwireLabel ?? `${method} ${path}`,
    allowPlaintext,
    allowSessionToken,
  );
  // `{ ok:false, error }` 以 HTTP 200 返回的端点，靠这个把失败翻出来。
  if (data && typeof data === 'object' && (data as { ok?: unknown }).ok === false) {
    const obj = data as { error?: unknown; errors?: unknown };
    const errors = Array.isArray(obj.errors) ? obj.errors.join('；') : undefined;
    const message =
      errors ?? (typeof obj.error === 'string' ? obj.error : undefined) ?? '服务端拒绝了这次操作';
    throw new ApiFailure('rejected', message);
  }
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiFailure) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
