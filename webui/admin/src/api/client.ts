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
 *    完整密钥的字段就抛错并阻止渲染（只在 console.warn 记字段路径，绝不记值）。
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
 * 疑似「完整密钥」的字段名。掩码字段（masked / head / length）不在内。
 *
 * `plaintext` 也在内：管理面**只有一个**端点会返回完整密钥（新建 virtual key），
 * 那个调用必须显式带 `allowPlaintext: true` 才能渲染。默认挡住意味着将来谁
 * 再加一个返回明文的端点，会在开发时就被拦下，而不是静默渲染出去。
 */
const SECRET_KEY_RE =
  /(secret|api[_-]?key|access[_-]?token|^key$|password|passphrase|authorization|bearer|private[_-]?key|client[_-]?secret|plaintext)/i;

/** 看起来已被掩码过（含 * 或 …）的值不算泄漏。 */
function looksMasked(value: string): boolean {
  return /[*…•]/.test(value);
}

/**
 * 在响应体里找疑似完整密钥字段，返回 `路径[]`（**只回路径，不回值**——
 * 回值就等于把密钥写进控制台）。
 *
 * `allowPlaintext` 只对**字名叫 `plaintext`** 的字段开口子，且只由
 * `POST /virtual-keys` 使用（那是管理面唯一返回完整密钥的地方，见
 * api/types.ts 的 VirtualKeyCreateResponse）。其他任何 secret 形字段照样拦。
 */
function findSecretLike(
  value: unknown,
  path = '',
  depth = 0,
  out: string[] = [],
  allowPlaintext = false,
): string[] {
  if (depth > 4 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      findSecretLike(item, `${path}[${i}]`, depth + 1, out, allowPlaintext),
    );
    return out;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    const exempt = allowPlaintext && key === 'plaintext';
    if (
      !exempt &&
      typeof item === 'string' &&
      item.length >= 8 &&
      SECRET_KEY_RE.test(key) &&
      !looksMasked(item)
    ) {
      out.push(here);
    } else {
      findSecretLike(item, here, depth + 1, out, allowPlaintext);
    }
  }
  return out;
}

/** 渲染前检查：命中就抛 ApiFailure（调用方据此阻止渲染该对象）。 */
function secretTripwire(data: unknown, label: string, allowPlaintext = false): void {
  const hits = findSecretLike(data, '', 0, [], allowPlaintext);
  if (hits.length === 0) return;
  console.warn(`[admin] ${label} 返回了疑似完整密钥字段，已阻止渲染：${hits.join(', ')}`);
  throw new ApiFailure(
    'secret_leak_blocked',
    `已阻止渲染：${label} 的响应里出现疑似完整密钥字段（${hits.join('、')}）。` +
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
}

async function decode(
  res: Response,
  hooks: ClientHooks,
  label: string,
  allowPlaintext: boolean,
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
  secretTripwire(data, label, allowPlaintext);
  return data ?? {};
}

/** 发一次请求。 */
export async function api<T>(
  path: string,
  options: RequestOptions,
  hooks: ClientHooks,
): Promise<T> {
  const { method = 'GET', body, auth = true, tripwireLabel, allowPlaintext = false } = options;
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
  const data = await decode(res, hooks, tripwireLabel ?? `${method} ${path}`, allowPlaintext);
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
