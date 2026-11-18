/**
 * src/url-token.ts —— 门户「一键进入」用的一次性访问令牌读取。
 *
 * 背景：yslwd-gate 门户的服务清单把 `?access_token=<管理访问令牌>` 直接写进跳转
 * URL，点进去就免去手输。这里只负责把令牌从地址栏里读出来、用完之后再抹掉。
 *
 * 安全立场（不得弱化）：
 * - 令牌**不落任何持久化存储**：读出来立刻换会话令牌，然后从地址栏移除
 *   （`history.replaceState`），浏览器历史与 Referer 里都不留它；
 * - 会话令牌本身仍只在内存里（api/client.ts 的 setSessionToken），本模块不改变那条；
 * - 换来的会话同样受服务端 TTL 约束；链接里的令牌失效了就回登录页手动输。
 *
 * 注意本 UI 用 hash 路由（`#/overview`），所以 `?access_token=` 出现在
 * `location.search`（hash 之前）而不是 hash 的查询串里——读的就是 `location.search`。
 */

/** 地址栏里承载一次性访问令牌的参数名。 */
export const ACCESS_TOKEN_PARAM = 'access_token';

/**
 * 从 `location.search` 里取一次性访问令牌。
 *
 * 只认非空串；空串（`?access_token=`）视为没有——那通常是链接被截断，别拿它
 * 去打登录接口换一次无意义的 401。
 */
export function readAccessTokenFromSearch(search: string): string | null {
  if (search === '' || search === '?') return null;
  const value = new URLSearchParams(search).get(ACCESS_TOKEN_PARAM);
  if (value === null || value === '') return null;
  return value;
}

/**
 * 抹掉地址栏里的令牌后应该 replaceState 到的 URL。
 *
 * 保留 pathname 与 hash（hash 里是路由状态，比如 `#/usage`），只掉查询串。
 * 查询串里除了令牌没别的东西时连 `?` 一起去掉；万一以后加了别的参数，这里
 * 按「删掉令牌这一个键」处理，剩下的查询串原样保留。
 */
export function urlWithoutAccessToken(pathname: string, hash: string, search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  params.delete(ACCESS_TOKEN_PARAM);
  const rest = params.toString();
  return pathname + (rest === '' ? '' : `?${rest}`) + hash;
}
