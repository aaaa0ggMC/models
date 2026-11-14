/**
 * auth/presentations.ts —— virtual key 的三种客户端呈现形态（66 §2.2 第 3 条）。
 *
 * 客户端带 key 的三种方式，**全部接受并归一**：
 *
 * | 形态 | 来源 | 对应客户端 |
 * |---|---|---|
 * | `Authorization: Bearer sk-ag-…` | header | OpenAI 风格（SDK 默认） |
 * | `x-api-key: sk-ag-…` | header | Anthropic 风格 |
 * | `?key=sk-ag-…` | query | Gemini 风格 |
 *
 * ## 为什么三种都要
 *
 * 网关的卖点是「客户端用任意主流格式打过来」。客户端只知道自己那一套：
 * OpenAI SDK 只会塞 `Authorization`，Anthropic SDK 只会塞 `x-api-key`，
 * Gemini 的 curl 示例只会拼 `?key=`。只支持一种等于逼用户包一层，而那一层
 * 正是最容易泄 key 的地方（日志、错误堆栈、代理访问记录）。
 *
 * ## 冲突怎么判
 *
 * 同时带多个**且值不同** → 拒绝（`conflicting`）。理由：那不是「客户端兼容
 * 性好」，那是「有两把不同的 key 在打同一个端点」，猜一把会让「为什么被拒」
 * 变成不可回答的问题。值相同则视为同一把 key 的重复携带，放行。
 */

/** 明文来自哪里（日志/审计用；**绝不记录值**）。 */
export type KeyPresentationSource = 'authorization_bearer' | 'x-api-key' | 'query_key';

/** 从请求里取出的一把呈现中的 key。 */
export interface PresentedKey {
  raw: string;
  source: KeyPresentationSource;
}

export type KeyExtraction =
  | { ok: true; key?: PresentedKey }
  | { ok: false; reason: 'conflicting'; sources: KeyPresentationSource[] };

const BEARER_RE = /^Bearer\s+(.+)$/i;

/** 从 `Authorization` 头取 Bearer 令牌。 */
export function bearerFromAuthorization(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = BEARER_RE.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

/** 从 `x-api-key` 头取 key。 */
export function apiKeyFromHeaders(headers: Record<string, string>): string | undefined {
  const raw = headers['x-api-key'];
  if (typeof raw !== 'string') return undefined;
  const token = raw.trim();
  return token.length === 0 ? undefined : token;
}

/** 从 query 的 `key=` 取 key（Gemini 风格）。 */
export function keyFromQuery(query: Record<string, string>): string | undefined {
  const raw = query['key'];
  if (typeof raw !== 'string') return undefined;
  const token = raw.trim();
  return token.length === 0 ? undefined : token;
}

/**
 * 按优先级取呈现中的 key。
 *
 * 优先级：`Authorization: Bearer` > `x-api-key` > `?key=`（与「主流 SDK 默认
 * 形态优先」一致）。多个不同值时整体拒绝，见文件头。
 */
export function extractPresentedKey(input: {
  headers: Record<string, string>;
  query: Record<string, string>;
}): KeyExtraction {
  const found: PresentedKey[] = [];
  const bearer = bearerFromAuthorization(input.headers['authorization']);
  if (bearer !== undefined) found.push({ raw: bearer, source: 'authorization_bearer' });
  const apiKey = apiKeyFromHeaders(input.headers);
  if (apiKey !== undefined) found.push({ raw: apiKey, source: 'x-api-key' });
  const queryKey = keyFromQuery(input.query);
  if (queryKey !== undefined) found.push({ raw: queryKey, source: 'query_key' });

  if (found.length === 0) return { ok: true };
  const first = found[0]!;
  const distinct = found.filter((k) => k.raw !== first.raw);
  if (distinct.length > 0) {
    return { ok: false, reason: 'conflicting', sources: found.map((k) => k.source) };
  }
  return { ok: true, key: first };
}
