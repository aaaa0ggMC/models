/**
 * webui/admin/app.js —— 管理面 SPA（原生 ES module，无框架、无构建、无 CDN）。
 *
 * ## 契约来源
 *
 * 请求/响应形状与路由前缀的唯一事实来源是 `admin/api-types.ts`；**已落地的路由**
 * 以 `admin/routes.ts` 为准（两者由同一线程维护，契约变了要一起改）。本文只消费
 * 这些路由，**不发明端点**：每条路径都在下面的 `EP` 表里登记，服务端 404 时明确
 * 报「接口不可用」，而不是假装成功。
 *
 * ```text
 * 登录          POST   /admin/api/login                  （免鉴权）
 * 退出          POST   /admin/api/logout
 * 引导          GET    /admin/api/bootstrap              （免鉴权）
 * Provider      GET    /admin/api/providers
 *               POST   /admin/api/providers              （upsert：带 id 即更新）
 *               DELETE /admin/api/providers/{id}
 * 凭据          GET    /admin/api/credentials
 *               POST   /admin/api/credentials
 *               DELETE /admin/api/credentials/{id}
 *               POST   /admin/api/credentials/{access_path}/probe
 * 别名          GET    /admin/api/aliases
 *               POST   /admin/api/aliases                （upsert：带 id 即更新）
 *               DELETE /admin/api/aliases/{id}
 *               POST   /admin/api/aliases/resolve
 * 能力矩阵      GET    /admin/api/capabilities           （只读）
 * access path   GET    /admin/api/access-paths           （UI 下拉，纯便利）
 * 同步          POST   /admin/api/sync
 * 用量看板      GET    /admin/api/usage?from_ts=&to_ts=
 * 余额探测      POST   /admin/api/balance/probe
 * 密钥状态      GET    /admin/api/keystore/status
 * 密钥轮换      POST   /admin/api/keystore/rotate-kek（破坏性，需 confirm:true）
 *               POST   /admin/api/keystore/rotate-dek
 * 审计日志      GET    /admin/api/audit?limit=&offset=
 * ```
 *
 * ## 三条安全约定（写进代码而不是只写进文档）
 *
 * 1. **会话令牌只在内存里**（下面的 `state.token`）。不写 localStorage /
 *    sessionStorage：那会让令牌在关闭标签页后仍然可被同源的任意脚本读取，
 *    而管理面的威胁模型里「同源 XSS」是要防的。代价是刷新页面要重新登录，
 *    这个代价在页脚向用户明示。
 * 2. **完整密钥永不渲染**。凭据列表按字段白名单逐列渲染，服务端多返回任何
 *    字段都不会进 DOM；另外有一道 `secretTripwire` 兜底——响应里出现疑似
 *    完整密钥的字段就报警并阻止渲染该对象。掩码文案（`masked`）之外的
 *    任何值都不被当作可信展示内容。
 * 3. **代价文案原样展示**。`keystore.tradeoff_note`（65-storage-and-retention.md
 *    §3.2b「自动解锁换不来运行时防护」）用 textContent 写入，不截断、不改写、
 *    不"优化"，横幅与密钥存储卡片两处都是原文。
 */

// ---------------------------------------------------------------------------
// 0. 端点表
// ---------------------------------------------------------------------------

/** API 前缀：与数据面 `/v1/*` 完全不撞（契约的「统一约定」）。 */
const API = '/admin/api';

/** 逻辑操作 → 路径（或路径构造函数）。多元素 = 备选，只在 404 时按序重试。 */
const EP = {
  login: [`${API}/login`],
  logout: [`${API}/logout`],
  bootstrap: [`${API}/bootstrap`],
  providers: [`${API}/providers`],
  provider: (id) => [`${API}/providers/${enc(id)}`],
  credentials: [`${API}/credentials`],
  credential: (id) => [`${API}/credentials/${enc(id)}`],
  // 探测按 access path 寻址（resolver 以 access path 为键），不是凭据 id
  credentialProbe: (accessPath) => [`${API}/credentials/${enc(accessPath)}/probe`],
  aliases: [`${API}/aliases`],
  alias: (id) => [`${API}/aliases/${enc(id)}`],
  aliasResolve: [`${API}/aliases/resolve`],
  capabilities: [`${API}/capabilities`],
  accessPaths: [`${API}/access-paths`],
  sync: [`${API}/sync`],
  usage: [`${API}/usage`],
  balanceProbe: [`${API}/balance/probe`],
  keystoreStatus: [`${API}/keystore/status`],
  // KEK 轮换是破坏性操作：契约要求显式 confirm:true（旧密钥表作废，
  // 没备份的数据永久解不开），UI 也必须先弹二次确认。
  keystoreRotateKek: [`${API}/keystore/rotate-kek`],
  keystoreRotateDek: [`${API}/keystore/rotate-dek`],
  audit: [`${API}/audit`],
};

/** URL 路径段编码（id 可能来自用户输入）。 */
function enc(value) {
  return encodeURIComponent(String(value));
}

// ---------------------------------------------------------------------------
// 1. 会话状态
// ---------------------------------------------------------------------------

/**
 * 全局状态。`token` 是唯一敏感字段，**只活在内存里**（见文件头第 1 条）。
 * 刷新页面 = 重新登录，这是有意为之的取舍。
 */
const state = {
  token: null,
  user: null,
  expiresAt: null,
  bootstrap: null,
  keystore: null,
  /** 主题偏好是唯一允许落盘的UI状态（与令牌无关）。 */
  theme: 'light',
};

// ---------------------------------------------------------------------------
// 2. DOM 小工具
// ---------------------------------------------------------------------------

let uidCounter = 0;

/** 生成稳定的表单元素 id（label[for] 要用）。 */
function uid(prefix) {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

/**
 * 创建元素。
 *
 * attrs 约定：`class` / `text` / `dataset` / `on*`（事件）/ 其余走 setAttribute。
 * `value` 与 `checked` 是 DOM 属性而非特性，延迟到子节点挂好后再生效
 * （`<select>` 的 value 必须等 option 建完才能设）。
 *
 * **刻意不提供 `html` 入口**：所有文本一律走 `text` → textContent，
 * 从构造上排除 XSS，不需要记得"这里要不要转义"。
 */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  const deferred = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' || key === 'checked') deferred.push([key, value]);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  for (const [key, value] of deferred) node[key] = value;
  return node;
}

/** 清空容器。 */
function clear(node) {
  node.replaceChildren();
}

/** 卡片：返回 `{ card, body, head }`，调用方把 body 需要的节点塞进 body。 */
function card(title, ...bodyNodes) {
  const head = h('header', {}, h('h2', { text: title }));
  const body = h('div', { class: 'card-body' }, ...bodyNodes);
  return { card: h('div', { class: 'card' }, head, body), body, head };
}

/** 页头（标题 + 一句说明）。 */
function pageHeader(title, lead) {
  return h(
    'div',
    { class: 'page-head' },
    h('h1', { class: 'page-title', text: title }),
    lead ? h('p', { class: 'page-lead', text: lead }) : null,
  );
}

/**
 * 状态区（loading / error / empty 三态）。
 * error 用 `role="alert"`，loading/empty 用 `role="status"`，屏幕阅读器能区分。
 */
function stateBox(parent) {
  const node = h('div', { class: 'state', role: 'status', 'aria-live': 'polite' });
  parent.append(node);
  return {
    node,
    loading(text = '加载中…') {
      node.className = 'state';
      node.setAttribute('role', 'status');
      clear(node);
      node.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${text}`);
    },
    error(err) {
      node.className = 'state state-error';
      node.setAttribute('role', 'alert');
      node.textContent = errorText(err);
    },
    empty(text = '暂无数据') {
      node.className = 'state state-empty';
      node.setAttribute('role', 'status');
      node.textContent = text;
    },
    remove() {
      node.remove();
    },
  };
}

/**
 * 数据表。
 *
 * columns: `{ label, num?, get(row) -> Node | string }`。
 * 单元格一律经 textContent 落 DOM，不做 innerHTML 拼接。
 */
function dataTable({ caption, columns, rows, empty = '暂无数据' }) {
  if (rows.length === 0) {
    return h('div', { class: 'state state-empty', role: 'status' }, empty);
  }
  const head = h(
    'thead',
    {},
    h(
      'tr',
      {},
      columns.map((c) => h('th', { class: c.num ? 'num' : null, scope: 'col', text: c.label })),
    ),
  );
  const body = h(
    'tbody',
    {},
    rows.map((row) =>
      h(
        'tr',
        {},
        columns.map((c) => {
          const value = c.get(row);
          return h(
            'td',
            { class: c.num ? 'num' : null },
            value instanceof Node ? value : String(value ?? '—'),
          );
        }),
      ),
    ),
  );
  const table = h('table', {}, caption ? h('caption', { text: caption }) : null, head, body);
  return h('div', { class: 'table-wrap' }, table);
}

/** 带 `<label for>` 的表单项。 */
function field(labelText, control, hint) {
  const id = control.id ?? uid('field');
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: labelText }),
    control,
    hint ? h('div', { class: 'field-hint', text: hint }) : null,
  );
}

/** 小标签（chip）。tone: ok | warn | danger | 空。 */
function chip(text, tone) {
  return h('span', { class: tone ? `chip chip-${tone}` : 'chip', text });
}

/** 提示块。tone: 空（信息）| danger | warn。 */
function notice(title, ...bodyNodes) {
  return h(
    'div',
    { class: 'notice' },
    h('div', { class: 'notice-title', text: title }),
    ...bodyNodes,
  );
}

/** 带语气（danger / warn）的提示块。 */
function noticeTone(tone, title, ...bodyNodes) {
  return h(
    'div',
    { class: tone ? `notice notice-${tone}` : 'notice' },
    h('div', { class: 'notice-title', text: title }),
    ...bodyNodes,
  );
}

/** 数字摘要卡。 */
function stat(label, value, sub) {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value', text: value }),
    sub ? h('div', { class: 'stat-sub', text: sub }) : null,
  );
}

/** 定义列表式的键值行（概览/密钥存储用）。 */
function kv(rows) {
  return dataTable({
    columns: [
      { label: '项', get: (r) => r[0] },
      { label: '值', get: (r) => r[1] },
    ],
    rows,
  });
}

// ---------------------------------------------------------------------------
// 3. 格式化
// ---------------------------------------------------------------------------

function fmtTs(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function fmtInt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

/** 现金/价值合计：契约注明是 USD。 */
function fmtUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/** 偏差比例：null 表示"没有可比对的对账基准"，不是 0。 */
function fmtRatio(r) {
  if (r === null || r === undefined) return '—（无基准）';
  if (typeof r !== 'number' || !Number.isFinite(r)) return '—';
  return `${(r * 100).toFixed(2)}%`;
}

function fmtDuration(fromTs, toTs) {
  if (typeof fromTs !== 'number' || typeof toTs !== 'number') return '—';
  const ms = Math.max(0, toTs - fromTs);
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtBool(v) {
  return v ? '是' : '否';
}

/** `<input type="datetime-local">` 的本地时间串。 */
function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return undefined;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

// ---------------------------------------------------------------------------
// 4. API 客户端
// ---------------------------------------------------------------------------

/** 统一的失败类型：`code` 取自错误信封，`message` 直接展示给用户。 */
class ApiFailure extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
  }
}

/** 把任意异常转成给人看的一行字。 */
function errorText(err) {
  if (err instanceof ApiFailure) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 从响应体里挑错误文案：先认统一信封，再认 `{ ok:false, error }`。 */
function pickErrorMessage(data) {
  if (data === null || typeof data !== 'object') return undefined;
  const envelope = data.error;
  if (typeof envelope === 'string' && envelope.length > 0) return envelope;
  if (envelope && typeof envelope === 'object' && typeof envelope.message === 'string') {
    return envelope.message;
  }
  if (typeof data.message === 'string' && data.message.length > 0) return data.message;
  if (data.ok === false && typeof data.error === 'string' && data.error.length > 0) {
    return data.error;
  }
  return undefined;
}

/**
 * 发一次请求。
 *
 * - 404 → 换备选路径重试（契约里没定死的路径在这里兜底）；全部落空 →
 *   `route_unavailable`，UI 明确显示"接口不可用"；
 * - 401 → **已登录**才算会话过期（清内存令牌回登录页）；登录接口本身的 401
 *   是"口令/token 不对"，必须把服务端的 message 原样带给用户。
 */
async function api(paths, { method = 'GET', body, auth = true, fallback } = {}) {
  const candidates = Array.isArray(paths) ? paths : [paths];
  const tried = [...candidates, ...(fallback ?? [])];
  let last = null;
  for (const path of tried) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(auth && state.token ? { authorization: `Bearer ${state.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiFailure('network', `连不上网关：${errorText(err)}`, 0);
    }
    if (res.status === 404) {
      last = new ApiFailure(
        'route_unavailable',
        `接口不可用：${method} ${path}（服务端返回 404）。` +
          '如果你刚升级了网关，请刷新页面；否则说明这个端点尚未实现。',
        res.status,
      );
      continue;
    }
    return decode(res);
  }
  throw (
    last ??
    new ApiFailure('route_unavailable', `接口不可用：${method} ${tried[0] ?? '?'}`, undefined)
  );
}

/** 解码响应：非 2xx 一律转成 ApiFailure（带上服务端的 message）。 */
async function decode(res) {
  const text = await res.text();
  let data = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message = pickErrorMessage(data) ?? `HTTP ${res.status} ${res.statusText}`;
    if (res.status === 401 && state.token !== null) {
      // 带着令牌还 401 = 会话过期；登录接口的 401 不走这条（那时还没有令牌）
      expireSession('会话已过期或未授权，请重新登录。');
      throw new ApiFailure('unauthorized', '会话已过期或未授权，请重新登录。', 401);
    }
    throw new ApiFailure(data?.error?.code ?? `http_${res.status}`, message, res.status);
  }
  return data ?? {};
}

/** `{ ok:false, error }` 用 HTTP 200 返回的端点，靠这个把失败翻出来。 */
function assertOk(data, context) {
  if (data && data.ok === false) {
    const errors = Array.isArray(data.errors) ? data.errors.join('；') : undefined;
    throw new ApiFailure(
      'rejected',
      errors ?? data.error ?? `${context}：服务端拒绝了这次操作`,
      undefined,
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// 4b. 密钥防泄漏兜底（tripwire）
// ---------------------------------------------------------------------------

/** 疑似"完整密钥"的字段名。掩码字段（masked / head）不在内。 */
const SECRET_KEY_RE =
  /(secret|api[_-]?key|access[_-]?token|^key$|password|passphrase|authorization|bearer|private[_-]?key|client[_-]?secret)/i;

/** 看起来已经被掩码过（含 * 或 …）的值不算泄漏。 */
function looksMasked(value) {
  return /[*…•]/.test(value);
}

/**
 * 在响应体里找疑似完整密钥的字段，返回 `路径[]`（**只回路径，不回值**——
 * 回值就等于把密钥写进控制台）。
 */
function findSecretLike(value, path = '', depth = 0, out = []) {
  if (depth > 4 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => findSecretLike(item, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (
      typeof item === 'string' &&
      item.length >= 8 &&
      SECRET_KEY_RE.test(key) &&
      !looksMasked(item)
    ) {
      out.push(here);
    } else {
      findSecretLike(item, here, depth + 1, out);
    }
  }
  return out;
}

/**
 * 渲染前检查。命中就返回一段告警（字段路径列表），调用方**不得**渲染该对象。
 * 只在 console.warn 里记路径，绝不记值。
 */
function secretTripwire(data, label) {
  const hits = findSecretLike(data);
  if (hits.length === 0) return null;
  console.warn(`[admin] ${label} 返回了疑似完整密钥字段，已阻止渲染：${hits.join(', ')}`);
  return notice(
    '已阻止渲染：响应里出现疑似完整密钥的字段',
    h('p', {
      text: `字段路径：${hits.join('、')}。完整密钥不应由管理面 API 返回，本次内容未渲染。请升级网关或检查 admin/routes.ts 的脱敏逻辑。`,
    }),
  );
}

// ---------------------------------------------------------------------------
// 5. 外壳：导航 / 主题 / 代价横幅 / 页脚
// ---------------------------------------------------------------------------

const NAV = [
  { hash: '#/', label: '概览' },
  { hash: '#/providers', label: 'Provider' },
  { hash: '#/credentials', label: '凭据' },
  { hash: '#/aliases', label: '别名' },
  { hash: '#/capabilities', label: '能力矩阵' },
  { hash: '#/sync', label: '同步' },
  { hash: '#/usage', label: '用量看板' },
  { hash: '#/audit', label: '审计日志' },
];

const dom = {
  chrome: document.getElementById('chrome'),
  nav: document.getElementById('nav'),
  userBadge: document.getElementById('user-badge'),
  logoutBtn: document.getElementById('logout-btn'),
  themeToggle: document.getElementById('theme-toggle'),
  tradeoff: document.getElementById('tradeoff'),
  main: document.getElementById('main'),
  view: document.getElementById('view'),
  footer: document.getElementById('footer'),
  footerApi: document.getElementById('footer-api'),
};

function buildNav() {
  clear(dom.nav);
  for (const item of NAV) {
    dom.nav.append(h('a', { href: item.hash, text: item.label, dataset: { route: item.hash } }));
  }
}

function syncNav() {
  const current = location.hash === '' ? '#/' : location.hash;
  for (const link of dom.nav.querySelectorAll('a')) {
    if (link.dataset.route === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  dom.themeToggle.textContent = dark ? '浅色' : '深色';
  dom.themeToggle.setAttribute('aria-pressed', String(dark));
  try {
    // 只存主题偏好；会话令牌不落盘（见文件头第 1 条）。
    localStorage.setItem('ag-admin-theme', theme);
  } catch {
    // 隐私模式 / 存储被禁：主题不持久化，不影响功能。
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem('ag-admin-theme');
  } catch {
    stored = null;
  }
  const prefersDark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light');
}

/**
 * 代价横幅：`keystore.tradeoff_note` **原样**展示。
 *
 * 65-storage-and-retention.md §3.2b 的硬要求——不截断、不改写、不"优化"。
 * 用 textContent 写入，所以服务端给的换行/空格原封不动。
 */
function renderTradeoff() {
  const bootstrapNote = state.bootstrap?.keystore?.tradeoff_note;
  const statusNote = state.keystore?.tradeoff_note;
  const note = bootstrapNote ?? statusNote;
  clear(dom.tradeoff);
  if (typeof note !== 'string' || note.length === 0) {
    dom.tradeoff.hidden = true;
    return;
  }
  dom.tradeoff.hidden = false;
  dom.tradeoff.append(
    h(
      'div',
      { class: 'tradeoff-title' },
      h('span', { 'aria-hidden': 'true', text: '⚠️' }),
      h('span', { text: '密钥自动解锁的代价（服务端原文，未作任何改写）' }),
    ),
    h('p', { class: 'tradeoff-note', text: note }),
    h('div', {
      class: 'tradeoff-source',
      text: '来源：docs/design/65-storage-and-retention.md §3.2b「自动解锁换不来运行时防护」',
    }),
  );
}

function renderShell() {
  const loggedIn = state.token !== null;
  dom.chrome.hidden = !loggedIn;
  dom.footer.hidden = !loggedIn;
  if (loggedIn) {
    const role = state.user?.role ?? '';
    dom.userBadge.hidden = false;
    dom.userBadge.textContent = state.user?.name
      ? `${state.user.name}${role ? `（${role}）` : ''}`
      : '已登录';
    dom.footerApi.textContent = state.bootstrap?.api_version
      ? `控制面 API ${state.bootstrap.api_version}`
      : '控制面 API 版本未知';
  } else {
    dom.userBadge.hidden = true;
  }
  syncNav();
}

// ---------------------------------------------------------------------------
// 6. 视图
// ---------------------------------------------------------------------------

const view = dom.view;

/** 进入某个视图前的公共动作。 */
function beginRender() {
  view.setAttribute('aria-busy', 'true');
  clear(view);
}

// ---- 6.1 登录 --------------------------------------------------------------

/**
 * 登录页：口令或单 access token（契约的 LoginRequest 两个互斥字段）。
 *
 * 输入框用 `type="password"`：防肩窥，也避免被浏览器/工具当成可打印文本。
 * 提交后立刻清空输入框——口令不该在 DOM 里停留。
 */
function viewLogin(flashMessage, returnTo = '/') {
  beginRender();
  renderShell();

  const statusHost = h('div', {});
  /** 当前选中的登录方式。用显式变量而不是读 DOM 的 hidden 属性——属性反射
   *  在不同实现里并不可靠，而且"哪个 tab 开着"本来就是组件自己的状态。 */
  let activeTab = 'password';
  const passwordInput = h('input', {
    type: 'password',
    autocomplete: 'current-password',
    placeholder: '输入管理口令',
  });
  const tokenInput = h('input', {
    type: 'password',
    autocomplete: 'off',
    placeholder: '粘贴单 access token',
  });
  const panels = [
    h(
      'div',
      { role: 'tabpanel', id: 'panel-password', 'aria-labelledby': 'tab-password' },
      field('管理口令', passwordInput, '对应 AG_ADMIN_PASSWORD / 首次初始化时设置的账号口令。'),
    ),
    h(
      'div',
      { role: 'tabpanel', id: 'panel-token', 'aria-labelledby': 'tab-token', hidden: true },
      field(
        '单 access token',
        tokenInput,
        '无账号体系时的一次性令牌（66-auth.md §2.2 的 AG_ACCESS_TOKEN 思路）。',
      ),
    ),
  ];

  const tabs = [
    { id: 'password', label: '口令', panel: panels[0] },
    { id: 'token', label: 'access token', panel: panels[1] },
  ];
  const tabButtons = tabs.map((t) =>
    h('button', {
      type: 'button',
      role: 'tab',
      id: `tab-${t.id}`,
      'aria-selected': t.id === 'password' ? 'true' : 'false',
      'aria-controls': `panel-${t.id}`,
      text: t.label,
      onclick: () => {
        activeTab = t.id;
        for (const other of tabButtons) {
          other.setAttribute('aria-selected', String(other === t));
        }
        for (const other of tabs) other.panel.hidden = other !== t;
      },
    }),
  );

  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: '登录' });
  const form = h(
    'form',
    {
      class: 'card-body',
      onsubmit: (event) => {
        event.preventDefault();
        void submitLogin();
      },
    },
    flashMessage ? notice('提示', h('p', { text: flashMessage })) : null,
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': '登录方式' }, ...tabButtons),
    ...panels,
    h('div', { class: 'btn-row' }, submitBtn),
    statusHost,
  );

  async function submitLogin() {
    const useToken = activeTab === 'token';
    // privacy-scan: ignore —— password / access_token 是 LoginRequest 的契约字段名，
    // 右侧永远是用户输入，没有字面量；令牌只进内存（见文件头安全约定第 1 条）
    const body = useToken ? { access_token: tokenInput.value } : { password: passwordInput.value }; // privacy-scan: ignore
    clear(statusHost);
    const box = stateBox(statusHost);
    if (useToken ? body.access_token.length === 0 : body.password.length === 0) {
      box.error(new ApiFailure('invalid', '请先填写登录信息。', undefined));
      return;
    }
    submitBtn.disabled = true;
    box.loading('正在登录…');
    try {
      const res = await api(EP.login, { method: 'POST', body, auth: false });
      assertOk(res, '登录');
      if (typeof res.token !== 'string' || res.token.length === 0) {
        throw new ApiFailure('bad_response', '登录响应里没有会话令牌（token）。', undefined);
      }
      state.token = res.token; // privacy-scan: ignore —— 会话令牌存内存，右侧是登录响应
      state.user = res.user ?? null;
      state.expiresAt = res.expires_at ?? null;
      // 口令/token 立刻从 DOM 里消失
      passwordInput.value = '';
      tokenInput.value = '';
      box.remove();
      await loadBootstrap();
      // 送回登录前想去的页面（深链不被登录页吃掉）
      location.hash = VIEWS[returnTo] === undefined ? '#/' : `#${returnTo}`;
    } catch (err) {
      box.error(err);
      if (err instanceof ApiFailure && err.code === 'unauthorized') return;
    } finally {
      submitBtn.disabled = false;
    }
  }

  const loginCard = h(
    'div',
    { class: 'login-shell' },
    h(
      'div',
      { class: 'login-card' },
      h('h1', { text: 'AgentGateway 管理面' }),
      h('p', {
        class: 'card-note',
        text: '登录后即可管理 Provider、凭据、别名映射，并查看用量与对账。',
      }),
      form,
      h('div', { class: 'card-note' }, '会话令牌只保存在本页内存中，刷新页面需重新登录。'),
    ),
  );
  view.append(loginCard);
  view.setAttribute('aria-busy', 'false');
  passwordInput.focus();
}

// ---- 6.2 概览 + 密钥存储 ---------------------------------------------------

/** 读引导信息（免鉴权）。失败不阻塞任何页面——概览页会给出明确提示。 */
async function loadBootstrap() {
  try {
    state.bootstrap = await api(EP.bootstrap, { auth: false });
  } catch {
    state.bootstrap = null;
  }
  renderTradeoff();
}

function viewOverview() {
  beginRender();
  renderShell();
  view.append(
    pageHeader(
      '概览与密钥存储',
      '引导信息来自 GET /admin/api/bootstrap；密钥状态来自 GET /admin/api/keystore/status。',
    ),
  );

  // ---- 引导信息 ----
  const boot = state.bootstrap;
  const bootCard = card('服务与登录状态');
  const bootBox = stateBox(bootCard.body);
  if (boot === null) {
    bootBox.error(
      new ApiFailure(
        'unavailable',
        '读不到引导信息（GET /admin/api/bootstrap）。管理面仍可尝试各功能页。',
        undefined,
      ),
    );
  } else {
    bootBox.remove();
    bootCard.body.append(
      kv([
        ['已认证', fmtBool(boot.authenticated)],
        ['加密存储已解锁', fmtBool(boot.storage_unlocked)],
        ['当前用户', boot.user ? `${boot.user.name}（${boot.user.role}）` : '—'],
        ['控制面 API 版本', boot.api_version ?? '—'],
        ['密钥模式', boot.keystore?.mode ?? '—'],
        [
          '建议升级 Argon2 参数',
          boot.keystore?.argon2_rehash_recommended ? '是（重新派生口令即可，数据不丢）' : '否',
        ],
        ['会话令牌有效期', state.expiresAt ? fmtTs(state.expiresAt) : '服务端未给出'],
      ]),
    );
    if (boot.storage_unlocked === false) {
      bootCard.body.append(
        notice(
          '加密存储未解锁',
          h('p', {
            text: '界面能打开，但任何需要读 secret 的操作都会失败。请先按部署文档解锁密钥存储。',
          }),
        ),
      );
    }
  }
  view.append(bootCard.card);

  // ---- 密钥存储状态 ----
  const ksCard = card('密钥存储（keystore）');
  const ksBox = stateBox(ksCard.body);
  const refreshBtn = h('button', {
    type: 'button',
    class: 'btn',
    text: '刷新状态',
    onclick: () => void loadKeystore(),
  });
  ksCard.head.append(h('div', { class: 'spacer' }), refreshBtn);

  // 轮换卡片只建一次；刷新时只重填内容，不往页面里反复 append
  const rotateCard = card('密钥轮换');

  async function loadKeystore() {
    ksBox.loading('正在读取密钥存储状态…');
    try {
      state.keystore = await api(EP.keystoreStatus);
      renderTradeoff();
      renderKeystore();
    } catch (err) {
      ksBox.error(err);
    }
  }

  function renderKeystore() {
    clear(ksCard.body);
    clear(rotateCard.body);
    const ks = state.keystore;
    if (ks === null) return;
    const trip = secretTripwire(ks, 'keystore/status');
    if (trip !== null) {
      ksCard.body.append(trip);
      return;
    }
    ksCard.body.append(
      kv([
        ['解锁模式', ks.mode === 'passphrase' ? '启动口令（passphrase）' : '密钥文件（key_file）'],
        ['已解锁', fmtBool(ks.unlocked)],
        ['当前 DEK', ks.active_dek_id ?? '—'],
        ['已加密条数', fmtInt(ks.encryption_count)],
        ['建议轮换 DEK', ks.should_rotate_dek ? '是' : '否'],
        ['建议重算 Argon2 参数', ks.argon2_rehash_recommended ? '是' : '否'],
        ['KEK 指纹', ks.kek_fingerprint ?? '—'],
      ]),
    );

    // 代价文案第二处展示：同样原样，来源标注为 keystore/status。
    ksCard.body.append(
      noticeTone(
        'warn',
        '自动解锁的代价（keystore/status 原文）',
        h('p', { class: 'tradeoff-note', text: ks.tradeoff_note ?? '' }),
        h('div', {
          class: 'tradeoff-source',
          text: '来源：GET /admin/api/keystore/status 的 tradeoff_note 字段，未作任何改写。',
        }),
      ),
    );

    // ---- 轮换表单 ----
    const kekBox = stateBox(h('div', {}));
    const kekPass = h('input', { type: 'password', autocomplete: 'new-password' });
    const kekForm = h(
      'form',
      {
        class: 'card-body',
        onsubmit: (event) => {
          event.preventDefault();
          void rotateKek();
        },
      },
      field(
        '新口令',
        kekPass,
        ks.mode === 'passphrase'
          ? '轮换后旧口令立即失效；已加密数据会用新 KEK 重新包裹。'
          : 'key_file 模式下服务端忽略口令，直接读新的 key 文件。',
      ),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { type: 'submit', class: 'btn btn-danger', text: '轮换 KEK' }),
      ),
      kekBox.node,
    );
    const dekBtn = h('button', {
      type: 'button',
      class: 'btn btn-danger',
      text: '轮换 DEK',
      onclick: () => {
        if (!confirm('轮换 DEK 会把历史记录用新 DEK 重加密，期间写入会短暂受影响。继续？')) return;
        void rotateDek();
      },
    });
    const dekBox = stateBox(h('div', {}));
    rotateCard.body.append(
      h('p', {
        class: 'card-note',
        text:
          '轮换是写操作，会记入审计日志。KEK 轮换只重包裹 DEK，数据密文不动；DEK 轮换会重加密历史记录。' +
          '网关没注入对应端口时会明确返回 501，不会假装成功。',
      }),
      h('fieldset', {}, h('legend', { text: 'KEK（包裹 DEK 的那把钥匙）' }), kekForm),
      h(
        'fieldset',
        {},
        h('legend', { text: 'DEK（数据加密密钥）' }),
        h('div', { class: 'btn-row' }, dekBtn),
        dekBox.node,
      ),
    );

    async function rotateKek() {
      const body = {};
      if (ks.mode === 'passphrase') {
        if (kekPass.value.length === 0) {
          kekBox.error(new ApiFailure('invalid', '请先填新口令。', undefined));
          return;
        }
        body.new_passphrase = kekPass.value;
      }
      // 破坏性操作：契约要求显式 confirm，且 UI 必须先弹二次确认
      // （KeystoreRotateKekRequest.confirm：「没备份的数据永久解不开」）
      if (
        !confirm(
          '轮换 KEK 会让旧密钥表作废：没有备份的数据将永久解不开。\n' +
            (ks.mode === 'passphrase' ? '旧口令也会立即失效。' : 'key 文件内容会被替换。') +
            '\n确定继续？',
        )
      ) {
        return;
      }
      body.confirm = true;
      kekBox.loading('正在轮换 KEK…');
      try {
        const res = assertOk(await api(EP.keystoreRotateKek, { method: 'POST', body }), '轮换 KEK');
        kekBox.node.textContent = `已完成。新 KEK 指纹：${res.kek_fingerprint ?? '（服务端未回）'}`;
        kekBox.node.className = 'state';
        kekPass.value = '';
        await loadKeystore();
      } catch (err) {
        kekBox.error(err);
      }
    }

    async function rotateDek() {
      dekBox.loading('正在轮换 DEK…');
      try {
        const res = assertOk(
          await api(EP.keystoreRotateDek, { method: 'POST', body: {} }),
          '轮换 DEK',
        );
        dekBox.node.textContent = `已完成。新 DEK：${res.new_dek_id ?? '（服务端未回）'}，重加密 ${fmtInt(res.reencrypted ?? 0)} 条。`;
        dekBox.node.className = 'state';
        await loadKeystore();
      } catch (err) {
        dekBox.error(err);
      }
    }
  }

  view.append(ksCard.card, rotateCard.card);
  if (state.keystore === null) void loadKeystore();
  else renderKeystore();
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.3 Provider ---------------------------------------------------------

const DIALECTS = [
  'openai.chat',
  'anthropic.messages',
  'openai.responses',
  'gemini.generateContent',
];

function modelSourceSummary(ms) {
  if (!ms || typeof ms !== 'object') return '—';
  if (ms.kind === 'static')
    return `静态清单（${Array.isArray(ms.models) ? ms.models.length : 0} 个）`;
  if (ms.kind === 'discovery') return `上游发现 ${ms.path ?? ''}`;
  if (ms.kind === 'offline_catalog') return `离线目录 ${ms.ref ?? ''}`;
  return String(ms.kind ?? '—');
}

function viewProviders() {
  beginRender();
  renderShell();
  view.append(
    pageHeader('Provider 管理', '上游 provider 的配置（不含任何凭据）。凭据在「凭据」页单独管理。'),
  );

  const listCard = card('Provider 列表');
  const listBox = stateBox(listCard.body);
  const newBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '新建 Provider',
    onclick: () => showForm(null),
  });
  listCard.head.append(h('div', { class: 'spacer' }), newBtn);

  const formCard = card('Provider 配置');
  formCard.card.hidden = true;

  // ---- 表单 ----
  const labelInput = h('input', { type: 'text', required: true, placeholder: 'DeepSeek 正式' });
  const idInput = h('input', { type: 'text', placeholder: '留空由服务端生成' });
  const dialectSelect = h(
    'select',
    {},
    DIALECTS.map((d) => h('option', { value: d, text: d })),
  );
  const baseUrlInput = h('input', {
    type: 'text',
    required: true,
    placeholder: 'https://api.example.com',
  });
  const kindSelect = h(
    'select',
    {
      onchange: () => syncSourceRows(),
    },
    [
      ['static', '静态清单'],
      ['discovery', '上游发现'],
      ['offline_catalog', '离线目录'],
    ].map(([v, t]) => h('option', { value: v, text: t })),
  );
  const modelsInput = h('textarea', { placeholder: '每行一个 model id' });
  const pathInput = h('input', { type: 'text', placeholder: '/models' });
  const refInput = h('input', { type: 'text', placeholder: 'providers/deepseek/pricing.json' });
  const sourceRows = {
    static: h('div', {}, field('模型清单', modelsInput, '每行一个上游 model id。')),
    discovery: h('div', {}, field('发现路径', pathInput, '相对 base_url 的路径，如 /models。')),
    offline_catalog: h('div', {}, field('目录引用', refInput, '仓库内静态定价/模型表的引用。')),
  };
  const unsupportedInput = h('input', {
    type: 'text',
    placeholder: '逗号分隔，如 logprobs,top_logprobs',
  });
  const spuSelect = h(
    'select',
    {},
    [
      ['', '（不限制）'],
      ['leading-only', 'leading-only'],
      ['in-history', 'in-history'],
    ].map(([v, t]) => h('option', { value: v, text: t })),
  );
  const tuSelect = h(
    'select',
    {},
    [
      ['', '（不限制）'],
      ['leading-only', 'leading-only'],
      ['addition-only', 'addition-only'],
    ].map(([v, t]) => h('option', { value: v, text: t })),
  );
  const streamingSelect = h(
    'select',
    {},
    [
      ['', '（不限制）'],
      ['none', 'none'],
      ['sse', 'sse'],
      ['chunked-binary', 'chunked-binary'],
      ['ws-duplex', 'ws-duplex'],
    ].map(([v, t]) => h('option', { value: v, text: t })),
  );
  const enabledInput = h('input', { type: 'checkbox', checked: true });
  enabledInput.id = uid('enabled');
  const noteInput = h('input', { type: 'text', placeholder: '备注（可选）' });
  const formBox = stateBox(h('div', {}));
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: '保存' });
  const cancelBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost',
    text: '取消',
    onclick: () => {
      formCard.card.hidden = true;
    },
  });

  let editing = null;

  function readModelSource() {
    const kind = kindSelect.value;
    if (kind === 'static') {
      const models = modelsInput.value
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (models.length === 0) throw new Error('静态模型清单不能为空（每行一个 model id）。');
      return { kind: 'static', models };
    }
    if (kind === 'discovery') {
      const path = pathInput.value.trim();
      if (path.length === 0) throw new Error('discovery 模式必须填发现路径。');
      return { kind: 'discovery', path };
    }
    const ref = refInput.value.trim();
    if (ref.length === 0) throw new Error('offline_catalog 模式必须填目录引用。');
    return { kind: 'offline_catalog', ref };
  }

  function readCapabilityOverrides() {
    const out = {};
    const unsupported = unsupportedInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (unsupported.length > 0) out.unsupported_fields = unsupported;
    const constraints = {};
    if (spuSelect.value) constraints.system_prompt_update = spuSelect.value;
    if (tuSelect.value) constraints.tool_update = tuSelect.value;
    if (Object.keys(constraints).length > 0) out.constraints = constraints;
    if (streamingSelect.value) out.streaming_mode = streamingSelect.value;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  const providerForm = h(
    'form',
    {
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void save();
      },
    },
    h(
      'div',
      { class: 'field-grid' },
      field('人类可读名', labelInput),
      field('id', idInput, '新建时留空即由服务端生成；编辑时不可改。'),
      field('wire 方言', dialectSelect, '决定用哪个 adaptor codec。'),
      field('上游 base URL', baseUrlInput, '不含路径。'),
    ),
    h(
      'fieldset',
      {},
      h('legend', { text: '模型清单来源' }),
      field('来源类型', kindSelect),
      sourceRows.static,
      sourceRows.discovery,
      sourceRows.offline_catalog,
    ),
    h(
      'fieldset',
      {},
      h('legend', { text: '能力约束覆盖（可选）' }),
      h('div', { class: 'field-grid' }, field('不支持的字段', unsupportedInput, '逗号分隔。')),
      h(
        'div',
        { class: 'field-grid' },
        field('system_prompt_update', spuSelect),
        field('tool_update', tuSelect),
        field('streaming_mode', streamingSelect),
      ),
    ),
    h(
      'div',
      { class: 'field-grid' },
      h(
        'div',
        { class: 'checkbox' },
        enabledInput,
        h('label', { for: enabledInput.id, text: '启用' }),
      ),
      field('备注', noteInput),
    ),
    h('div', { class: 'btn-row' }, saveBtn, cancelBtn),
    formBox.node,
  );
  formCard.body.append(providerForm);

  async function save() {
    formBox.node.textContent = '';
    try {
      const body = {
        label: labelInput.value.trim(),
        dialect: dialectSelect.value,
        base_url: baseUrlInput.value.trim(),
        model_source: readModelSource(),
        enabled: enabledInput.checked,
      };
      if (body.label.length === 0) throw new Error('人类可读名不能为空。');
      if (body.base_url.length === 0) throw new Error('base URL 不能为空。');
      const overrides = readCapabilityOverrides();
      if (overrides !== undefined) body.capability_overrides = overrides;
      const note = noteInput.value.trim();
      if (note.length > 0) body.note = note;
      const id = editing ?? idInput.value.trim();
      if (id.length > 0) body.id = id;
      saveBtn.disabled = true;
      formBox.loading('正在保存…');
      // routes.ts 只有 POST /admin/api/providers：带 id 即更新，不带即新建
      // （ProviderUpsertRequest.id 是可选的）。没有 PUT 端点，别去发明。
      await assertOk(await api(EP.providers, { method: 'POST', body }), '保存 Provider');
      formBox.node.textContent = '已保存。';
      formBox.node.className = 'state';
      formCard.card.hidden = true;
      await loadList();
    } catch (err) {
      formBox.error(err);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function showForm(provider) {
    editing = provider?.id ?? null;
    labelInput.value = provider?.label ?? '';
    idInput.value = provider?.id ?? '';
    idInput.disabled = provider !== null;
    dialectSelect.value = provider?.dialect ?? DIALECTS[0];
    baseUrlInput.value = provider?.base_url ?? '';
    const ms = provider?.model_source;
    kindSelect.value = ms?.kind ?? 'static';
    modelsInput.value = ms?.kind === 'static' ? (ms.models ?? []).join('\n') : '';
    pathInput.value = ms?.kind === 'discovery' ? (ms.path ?? '') : '';
    refInput.value = ms?.kind === 'offline_catalog' ? (ms.ref ?? '') : '';
    const co = provider?.capability_overrides;
    unsupportedInput.value = (co?.unsupported_fields ?? []).join(',');
    spuSelect.value = co?.constraints?.system_prompt_update ?? '';
    tuSelect.value = co?.constraints?.tool_update ?? '';
    streamingSelect.value = co?.streaming_mode ?? '';
    enabledInput.checked = provider?.enabled ?? true;
    noteInput.value = provider?.note ?? '';
    formBox.node.textContent = '';
    syncSourceRows();
    formCard.card.hidden = false;
    formCard.card.scrollIntoView({ block: 'nearest' });
    labelInput.focus();
  }

  function syncSourceRows() {
    for (const [kind, row] of Object.entries(sourceRows)) row.hidden = kindSelect.value !== kind;
  }

  async function loadList() {
    listBox.loading('正在加载 Provider…');
    try {
      const data = await api(EP.providers);
      const items = Array.isArray(data.items) ? data.items : [];
      const trip = secretTripwire(data, 'providers 列表');
      listBox.remove();
      clear(listCard.body);
      if (trip !== null) listCard.body.append(trip);
      listCard.body.append(
        dataTable({
          caption: `共 ${fmtInt(data.total ?? items.length)} 个 provider`,
          columns: [
            {
              label: '名称',
              get: (p) =>
                h(
                  'div',
                  {},
                  h('div', { text: p.label ?? '—' }),
                  h('div', { class: 'mono faint', text: p.id ?? '' }),
                ),
            },
            { label: '方言', get: (p) => h('span', { class: 'mono', text: p.dialect ?? '—' }) },
            {
              label: 'base URL',
              get: (p) => h('span', { class: 'mono', text: p.base_url ?? '—' }),
            },
            { label: '模型来源', get: (p) => modelSourceSummary(p.model_source) },
            {
              label: '状态',
              get: (p) => chip(p.enabled ? '启用' : '停用', p.enabled ? 'ok' : 'warn'),
            },
            {
              label: '更新时间',
              get: (p) => h('span', { class: 'nowrap', text: fmtTs(p.updated_at) }),
            },
            {
              label: '操作',
              get: (p) =>
                h(
                  'div',
                  { class: 'btn-row' },
                  h('button', {
                    type: 'button',
                    class: 'btn',
                    text: '编辑',
                    onclick: () => showForm(p),
                  }),
                  h('button', {
                    type: 'button',
                    class: 'btn btn-danger',
                    text: '删除',
                    onclick: () => void remove(p),
                  }),
                ),
            },
          ],
          rows: items,
          empty: '还没有配置任何 provider。点右上角「新建 Provider」开始。',
        }),
      );
    } catch (err) {
      listBox.error(err);
    }
  }

  async function remove(p) {
    if (!confirm(`确定删除 provider「${p.label ?? p.id}」？此操作不可撤销。`)) return;
    try {
      const res = assertOk(await api(EP.provider(p.id), { method: 'DELETE' }), '删除 Provider');
      if (res.deleted === false) {
        alert('服务端返回 deleted=false：这个 provider 本来就不存在。');
      }
      await loadList();
    } catch (err) {
      alert(`删除失败：${errorText(err)}`);
    }
  }

  view.append(formCard.card, listCard.card);
  syncSourceRows();
  void loadList();
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.4 凭据 -------------------------------------------------------------

const HEALTH_LABEL = { unknown: '未知', ok: '正常', error: '异常' };
const HEALTH_TONE = { unknown: '', ok: 'ok', error: 'danger' };

function storageText(s) {
  if (!s || typeof s !== 'object') return '—';
  if (s.location === 'env') return `环境变量 ${s.ref ?? ''}`;
  if (s.location === 'keyring') return `keyring ${s.ref ?? ''}`;
  if (s.location === 'encrypted') return '加密存储';
  return String(s.location ?? '—');
}

/**
 * 用 GET /admin/api/access-paths 填 access_path 输入框的候选下拉
 * （契约 AccessPathDto：{ id, label, requires_credential }）。
 *
 * **纯便利**：拉不到（端点不存在 / 形状变了）就静默退化成自由文本，
 * 不影响提交——access_path 本身是用户说了算的字符串。
 */
async function fillAccessPathOptions(dataList) {
  try {
    const data = await api(EP.accessPaths);
    const items = Array.isArray(data.items) ? data.items : [];
    const entries = items
      .map((it) =>
        typeof it === 'string'
          ? { value: it, label: it }
          : {
              value: it?.id ?? it?.access_path ?? it?.path ?? it?.label,
              label: it?.label,
            },
      )
      .filter((e) => typeof e.value === 'string' && e.value.length > 0);
    dataList.replaceChildren(
      ...entries.map((e) =>
        e.label && e.label !== e.value
          ? h('option', { value: e.value, label: e.label })
          : h('option', { value: e.value }),
      ),
    );
  } catch {
    // 没有这个端点就算了：下拉为空，输入框仍是自由文本
  }
}

function viewCredentials() {
  beginRender();
  renderShell();
  view.append(
    pageHeader('凭据管理', '上游 API key 只进加密存储；本页只展示掩码，任何路径都拿不到完整密钥。'),
  );

  // 安全警示：显著位置、常驻。
  view.append(
    notice(
      '⚠️ 完整密钥永不展示',
      h(
        'ul',
        {},
        h('li', {
          text: '列表里的掩码（形如 sk-****abcd）是服务端能给出的唯一形式，完整 key 从不离开加密存储。',
        }),
        h('li', {
          text: '新建时完整 key 只在这一个表单里出现一次，提交后立刻加密入库，响应不回显、不写日志。',
        }),
        h('li', {
          text: '不要把完整 key 贴进备注、截图或工单——备注会原样存进审计与数据库。',
        }),
        h('li', {
          text: '怀疑泄漏就删掉重建：删除是即刻的，比"改个备注说明一下"可靠。',
        }),
      ),
    ),
  );

  const listCard = card('凭据列表');
  const listBox = stateBox(listCard.body);
  const newBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '新建凭据',
    onclick: () => {
      formCard.card.hidden = false;
      secretInput.focus();
    },
  });
  listCard.head.append(h('div', { class: 'spacer' }), newBtn);

  const providerInput = h('input', { type: 'text', list: 'cred-provider-list', required: true });
  const accessPathInput = h('input', {
    type: 'text',
    list: 'cred-access-path-list',
    required: true,
    placeholder: 'deepseek.openai-chat',
  });
  const secretInput = h('input', { type: 'password', autocomplete: 'off', required: true });
  const envRefInput = h('input', { type: 'text', placeholder: 'env:DEEPSEEK_API_KEY' });
  const credNoteInput = h('input', { type: 'text', placeholder: '备注（不要写密钥本身）' });
  const formBox = stateBox(h('div', {}));
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: '入库' });
  const cancelBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost',
    text: '取消',
    onclick: () => {
      formCard.card.hidden = true;
    },
  });

  const credForm = h(
    'form',
    {
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void save();
      },
    },
    h('p', {
      class: 'card-note',
      text: '「完整密钥」与「环境变量引用」二选一，同时填会被服务端拒绝。',
    }),
    h(
      'div',
      { class: 'field-grid' },
      field('provider', providerInput, '对应 Provider 页里的 id。'),
      field('access_path', accessPathInput, '上游接入路径，如 deepseek.openai-chat。'),
    ),
    field('完整密钥', secretInput, '只用于这一次提交；输入框不会记住历史。'),
    field('环境变量引用（替代上面的密钥）', envRefInput, '形如 env:DEEPSEEK_API_KEY。'),
    field('备注', credNoteInput, '只写用途，不写密钥。'),
    h('div', { class: 'btn-row' }, saveBtn, cancelBtn),
    formBox.node,
  );

  const formCard = card('新建凭据', credForm);
  formCard.card.hidden = true;
  // provider 输入框的候选值来自已配置的 provider（不发明 access-paths 端点）
  const dataList = h('datalist', { id: 'cred-provider-list' });
  const accessPathList = h('datalist', { id: 'cred-access-path-list' });

  async function save() {
    formBox.node.textContent = '';
    try {
      const secret = secretInput.value; // privacy-scan: ignore —— 表单输入，非字面量
      const envRef = envRefInput.value.trim();
      if (secret.length > 0 && envRef.length > 0) {
        throw new Error('「完整密钥」和「环境变量引用」互斥，只能填一个。');
      }
      const body = {
        provider: providerInput.value.trim(),
        access_path: accessPathInput.value.trim(),
      };
      if (body.provider.length === 0) throw new Error('provider 不能为空。');
      if (body.access_path.length === 0) throw new Error('access_path 不能为空。');
      if (envRef.length > 0) body.env_ref = envRef;
      else {
        if (secret.length === 0) throw new Error('请填完整密钥，或改用环境变量引用。');
        body.secret = secret; // privacy-scan: ignore —— CredentialCreateRequest 的契约字段名，右侧是表单输入
      }
      const note = credNoteInput.value.trim();
      if (note.length > 0) body.note = note;
      saveBtn.disabled = true;
      formBox.loading('正在加密入库…');
      await assertOk(await api(EP.credentials, { method: 'POST', body }), '新建凭据');
      // 提交成功即清空：密钥不在 DOM 里逗留
      secretInput.value = '';
      envRefInput.value = '';
      formBox.node.textContent = '已入库。服务端没有回显完整密钥，这是预期行为。';
      formBox.node.className = 'state';
      await loadList();
    } catch (err) {
      formBox.error(err);
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function loadList() {
    listBox.loading('正在加载凭据…');
    try {
      const data = await api(EP.credentials);
      const items = Array.isArray(data.items) ? data.items : [];
      const trip = secretTripwire(data, 'credentials 列表');
      listBox.remove();
      clear(listCard.body);
      if (trip !== null) listCard.body.append(trip);
      // 候选 provider（用于 datalist，纯便利，不影响提交）
      dataList.replaceChildren(...items.map((c) => h('option', { value: c.provider ?? '' })));
      listCard.body.append(
        dataTable({
          caption: `共 ${fmtInt(data.total ?? items.length)} 条凭据`,
          columns: [
            {
              label: 'provider',
              get: (c) => h('span', { class: 'mono', text: c.provider ?? '—' }),
            },
            {
              label: 'access_path',
              get: (c) => h('span', { class: 'mono', text: c.access_path ?? '—' }),
            },
            { label: '掩码', get: (c) => h('span', { class: 'mono', text: c.masked ?? '—' }) },
            { label: '长度', num: true, get: (c) => fmtInt(c.length) },
            { label: '存储位置', get: (c) => storageText(c.storage) },
            {
              label: '健康',
              get: (c) =>
                chip(
                  HEALTH_LABEL[c.health] ?? String(c.health ?? '—'),
                  HEALTH_TONE[c.health] ?? '',
                ),
            },
            {
              label: '上次探测',
              get: (c) => h('span', { class: 'nowrap', text: fmtTs(c.last_checked) }),
            },
            {
              label: '操作',
              get: (c) =>
                h(
                  'div',
                  { class: 'btn-row' },
                  h('button', {
                    type: 'button',
                    class: 'btn',
                    text: '探测',
                    onclick: () => void probe(c),
                  }),
                  h('button', {
                    type: 'button',
                    class: 'btn btn-danger',
                    text: '删除',
                    onclick: () => void remove(c),
                  }),
                ),
            },
          ],
          rows: items,
          empty: '还没有登记任何凭据。',
        }),
      );
    } catch (err) {
      listBox.error(err);
    }
  }

  async function probe(c) {
    try {
      // 探测端点按 access path 寻址（/admin/api/credentials/{access_path}/probe）
      const res = await api(EP.credentialProbe(c.access_path), { method: 'POST', body: {} });
      const lines = [
        `探测结果：${res.status ?? '—'}`,
        res.upstream_status === undefined ? null : `上游 HTTP 状态：${res.upstream_status}`,
        res.message ? `说明：${res.message}` : null,
        `时间：${fmtTs(res.checked_at)}`,
      ].filter(Boolean);
      alert(lines.join('\n'));
      await loadList();
    } catch (err) {
      alert(`探测失败：${errorText(err)}`);
    }
  }

  async function remove(c) {
    if (!confirm(`确定删除凭据「${c.provider} / ${c.access_path}」？此操作不可撤销。`)) return;
    try {
      const res = assertOk(await api(EP.credential(c.id), { method: 'DELETE' }), '删除凭据');
      if (res.deleted === false) alert('服务端返回 deleted=false：这条凭据本来就不存在。');
      await loadList();
    } catch (err) {
      alert(`删除失败：${errorText(err)}`);
    }
  }

  view.append(formCard.card, listCard.card, dataList, accessPathList);
  void loadList();
  void fillAccessPathOptions(accessPathList);
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.5 别名 / namespace 映射 -------------------------------------------

const ALIAS_SOURCE_LABEL = {
  exact: '显式别名（exact，最高优先）',
  prefix: '前缀规则（prefix）',
  passthrough: '原样 model id（passthrough，最低优先）',
};

function aliasTargetText(t) {
  if (!t || typeof t !== 'object') return '—';
  const parts = [t.provider ?? '—', t.access_path ?? '—', t.model ?? '—'];
  const extra = t.max_context_tokens ? ` · 上限 ${fmtInt(t.max_context_tokens)} tokens` : '';
  return `${parts.join(' / ')}${extra}`;
}

function viewAliases() {
  beginRender();
  renderShell();
  view.append(
    pageHeader(
      '别名 / namespace 映射',
      '把客户端传来的模型名解析到 (provider, access_path, model)。',
    ),
  );

  // 解析优先级说明（任务书要求"写清楚"）
  view.append(
    notice(
      '解析优先级（从高到低）',
      h(
        'ol',
        {},
        h('li', {
          text: '显式别名 exact：全串相等。管理员一条条建的，意图最强，永远最先命中。',
        }),
        h('li', {
          text: '前缀规则 prefix：按 priority 升序、再按模式长度降序，取第一个命中的。长度降序 = 最具体的规则优先（同 CIDR 最长前缀匹配）。',
        }),
        h('li', {
          text: '原样 model id（passthrough）：客户端直接传上游 model id 时不报错；但只有该 model 确实在能力矩阵里才放行，否则仍报 no_available_provider。',
        }),
      ),
      h('p', {
        text: '为什么 exact 高于 prefix：反过来会让一条手滑建的宽前缀规则静默劫持所有显式别名，而这种劫持在请求路径上看不见（只是模型名被换了）。',
      }),
      h('p', {
        text: '前缀 pattern 支持 namespace/ 与 foo* 两种形态（* 不匹配 /，所以 deepseek* 不会吃掉 deepseek/v4/pro）；不支持正则。',
      }),
    ),
  );

  const listCard = card('规则列表');
  const listBox = stateBox(listCard.body);
  const newBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '新建规则',
    onclick: () => showForm(null),
  });
  listCard.head.append(h('div', { class: 'spacer' }), newBtn);

  const kindSelect = h(
    'select',
    {},
    [
      ['exact', 'exact（显式别名）'],
      ['prefix', 'prefix（前缀规则）'],
    ].map(([v, t]) => h('option', { value: v, text: t })),
  );
  const patternInput = h('input', {
    type: 'text',
    required: true,
    placeholder: 'fast/model 或 fast/',
  });
  const targetProviderInput = h('input', {
    type: 'text',
    list: 'alias-provider-list',
    required: true,
  });
  const targetPathInput = h('input', {
    type: 'text',
    list: 'alias-access-path-list',
    required: true,
  });
  const targetModelInput = h('input', { type: 'text', required: true });
  const maxCtxInput = h('input', { type: 'number', min: '1', step: '1', placeholder: '可选' });
  const priorityInput = h('input', { type: 'number', step: '1', value: '100' });
  const aliasEnabledInput = h('input', { type: 'checkbox', checked: true });
  aliasEnabledInput.id = uid('alias-enabled');
  const aliasNoteInput = h('input', { type: 'text', placeholder: '备注（可选）' });
  const formBox = stateBox(h('div', {}));
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary', text: '保存' });
  const cancelBtn = h('button', {
    type: 'button',
    class: 'btn btn-ghost',
    text: '取消',
    onclick: () => {
      formCard.card.hidden = true;
    },
  });

  const aliasForm = h(
    'form',
    {
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        void save();
      },
    },
    h(
      'div',
      { class: 'field-grid' },
      field('类型', kindSelect),
      field('pattern', patternInput, 'exact 填完整模型名；prefix 以 / 或 * 结尾。'),
      field('priority', priorityInput, '数字越小越先；同分看模式长度。'),
    ),
    h(
      'fieldset',
      {},
      h('legend', { text: '目标' }),
      h(
        'div',
        { class: 'field-grid' },
        field('provider', targetProviderInput),
        field('access_path', targetPathInput),
        field('model', targetModelInput),
        field('max_context_tokens', maxCtxInput, '可选；不填用 provider 默认值。'),
      ),
    ),
    h(
      'div',
      { class: 'field-grid' },
      h(
        'div',
        { class: 'checkbox' },
        aliasEnabledInput,
        h('label', { for: aliasEnabledInput.id, text: '启用' }),
      ),
      field('备注', aliasNoteInput),
    ),
    h('div', { class: 'btn-row' }, saveBtn, cancelBtn),
    formBox.node,
  );

  const formCard = card('规则配置', aliasForm);
  formCard.card.hidden = true;
  const providerDataList = h('datalist', { id: 'alias-provider-list' });
  const accessPathDataList = h('datalist', { id: 'alias-access-path-list' });

  let editing = null;

  async function save() {
    formBox.node.textContent = '';
    try {
      const target = {
        provider: targetProviderInput.value.trim(),
        access_path: targetPathInput.value.trim(),
        model: targetModelInput.value.trim(),
      };
      const maxCtx = maxCtxInput.value.trim();
      if (maxCtx.length > 0) target.max_context_tokens = Number(maxCtx);
      if (target.provider.length === 0) throw new Error('目标 provider 不能为空。');
      if (target.access_path.length === 0) throw new Error('目标 access_path 不能为空。');
      if (target.model.length === 0) throw new Error('目标 model 不能为空。');
      const pattern = patternInput.value.trim();
      if (pattern.length === 0) throw new Error('pattern 不能为空。');
      const priority = Number(priorityInput.value);
      const body = {
        kind: kindSelect.value,
        pattern,
        target,
        priority: Number.isFinite(priority) ? priority : 100,
        enabled: aliasEnabledInput.checked,
      };
      const note = aliasNoteInput.value.trim();
      if (note.length > 0) body.note = note;
      if (editing !== null) body.id = editing;
      saveBtn.disabled = true;
      formBox.loading('正在保存…');
      // routes.ts 只有 POST /admin/api/aliases：带 id 即更新，不带即新建
      await assertOk(await api(EP.aliases, { method: 'POST', body }), '保存规则');
      formBox.node.textContent = '已保存。';
      formBox.node.className = 'state';
      formCard.card.hidden = true;
      await loadList();
    } catch (err) {
      formBox.error(err);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function showForm(rule) {
    editing = rule?.id ?? null;
    kindSelect.value = rule?.kind ?? 'exact';
    patternInput.value = rule?.pattern ?? '';
    targetProviderInput.value = rule?.target?.provider ?? '';
    targetPathInput.value = rule?.target?.access_path ?? '';
    targetModelInput.value = rule?.target?.model ?? '';
    maxCtxInput.value = rule?.target?.max_context_tokens
      ? String(rule.target.max_context_tokens)
      : '';
    priorityInput.value = String(rule?.priority ?? 100);
    aliasEnabledInput.checked = rule?.enabled ?? true;
    aliasNoteInput.value = rule?.note ?? '';
    formBox.node.textContent = '';
    formCard.card.hidden = false;
    patternInput.focus();
  }

  async function loadList() {
    listBox.loading('正在加载别名规则…');
    try {
      const data = await api(EP.aliases);
      const items = Array.isArray(data.items) ? data.items : [];
      const trip = secretTripwire(data, 'aliases 列表');
      listBox.remove();
      clear(listCard.body);
      if (trip !== null) listCard.body.append(trip);
      providerDataList.replaceChildren(
        ...items.map((r) => h('option', { value: r.target?.provider ?? '' })),
      );
      listCard.body.append(
        dataTable({
          caption: `共 ${fmtInt(data.total ?? items.length)} 条规则`,
          columns: [
            { label: '类型', get: (r) => h('span', { class: 'mono', text: r.kind ?? '—' }) },
            { label: 'pattern', get: (r) => h('span', { class: 'mono', text: r.pattern ?? '—' }) },
            { label: 'priority', num: true, get: (r) => fmtInt(r.priority) },
            {
              label: '目标',
              get: (r) => h('span', { class: 'mono', text: aliasTargetText(r.target) }),
            },
            {
              label: '状态',
              get: (r) => chip(r.enabled ? '启用' : '停用', r.enabled ? 'ok' : 'warn'),
            },
            { label: '备注', get: (r) => r.note ?? '—' },
            {
              label: '操作',
              get: (r) =>
                h(
                  'div',
                  { class: 'btn-row' },
                  h('button', {
                    type: 'button',
                    class: 'btn',
                    text: '编辑',
                    onclick: () => showForm(r),
                  }),
                  h('button', {
                    type: 'button',
                    class: 'btn btn-danger',
                    text: '删除',
                    onclick: () => void remove(r),
                  }),
                ),
            },
          ],
          rows: items,
          empty:
            '还没有别名规则。未命中的模型名会走 passthrough（要求该 model 在能力矩阵里存在）。',
        }),
      );
    } catch (err) {
      listBox.error(err);
    }
  }

  async function remove(r) {
    if (!confirm(`确定删除规则「${r.kind}:${r.pattern}」？此操作不可撤销。`)) return;
    try {
      const res = assertOk(await api(EP.alias(r.id), { method: 'DELETE' }), '删除规则');
      if (res.deleted === false) alert('服务端返回 deleted=false：这条规则本来就不存在。');
      await loadList();
    } catch (err) {
      alert(`删除失败：${errorText(err)}`);
    }
  }

  // ---- 试解析 ----
  const resolveInput = h('input', { type: 'text', placeholder: 'fast/model' });
  const resolveBox = stateBox(h('div', {}));
  const resolveBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '解析',
    onclick: () => void resolve(),
  });
  const resolveCard = card(
    '试解析（不落库）',
    h('p', {
      class: 'card-note',
      text: '输入一个客户端会用的模型名，看它实际会落到哪个 (provider, access_path, model)。',
    }),
    h('div', { class: 'btn-row' }, field('模型名', resolveInput), resolveBtn),
    resolveBox.node,
  );

  async function resolve() {
    const model = resolveInput.value.trim();
    if (model.length === 0) {
      resolveBox.error(new ApiFailure('invalid', '请先填模型名。', undefined));
      return;
    }
    resolveBox.loading('正在解析…');
    try {
      const res = await api(EP.aliasResolve, { method: 'POST', body: { model } });
      const r = res.resolution;
      clear(resolveBox.node);
      resolveBox.node.className = 'state';
      if (r === undefined) {
        // routes.ts 对这一支返回 HTTP 200 + { ok:false, error }：解析不了
        resolveBox.node.append(
          noticeTone(
            'warn',
            '解析不了',
            h('p', {
              text:
                res.error ??
                '未命中任何规则，也不能走 passthrough（该 model 不在能力矩阵里）——请求会报 no_available_provider。',
            }),
          ),
        );
        return;
      }
      resolveBox.node.append(
        kv([
          ['命中来源', ALIAS_SOURCE_LABEL[r.source] ?? String(r.source ?? '—')],
          ['规则 id', r.rule_id ?? '（无，passthrough）'],
          ['provider', r.target?.provider ?? '—'],
          ['access_path', r.target?.access_path ?? '—'],
          ['model', r.target?.model ?? '—'],
        ]),
      );
    } catch (err) {
      resolveBox.error(err);
    }
  }
  view.append(formCard.card, listCard.card, resolveCard.card, providerDataList, accessPathDataList);
  void loadList();
  void fillAccessPathOptions(accessPathDataList);
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.6 能力矩阵（只读） -------------------------------------------------

function streamingText(s) {
  if (!s || typeof s !== 'object') return '—';
  const bits = [s.mode ?? '—'];
  if (s.framing) bits.push(`framing=${s.framing}`);
  if (s.partial_results) bits.push('partial');
  if (s.usage_in_stream) bits.push('usage-in-stream');
  if (s.cancellable) bits.push('cancellable');
  return bits.join(' · ');
}

function viewCapabilities() {
  beginRender();
  renderShell();
  view.append(
    pageHeader(
      '能力矩阵',
      '只读视图。数据与 ir/capability.ts 同源，这里不提供编辑——改能力请改注册表。',
    ),
  );

  const card1 = card('能力矩阵');
  const box = stateBox(card1.body);
  const filterInput = h('input', {
    type: 'text',
    placeholder: '过滤 access_path / model / modality',
  });
  card1.head.append(h('div', { class: 'spacer' }), field('过滤', filterInput));

  async function load() {
    box.loading('正在加载能力矩阵…');
    try {
      const data = await api(EP.capabilities);
      const items = Array.isArray(data.items) ? data.items : [];
      const trip = secretTripwire(data, 'capabilities 列表');
      box.remove();
      clear(card1.body);
      if (trip !== null) card1.body.append(trip);
      const keyword = () => filterInput.value.trim().toLowerCase();
      const filtered = () => {
        const k = keyword();
        if (k.length === 0) return items;
        return items.filter((e) =>
          [e.access_path, e.model, e.modality, e.format, e.usage_source]
            .filter((v) => typeof v === 'string')
            .some((v) => v.toLowerCase().includes(k)),
        );
      };
      const render = () => {
        clear(card1.body);
        const rows = filtered();
        card1.body.append(
          h('div', {
            class: 'card-note',
            text: `共 ${fmtInt(items.length)} 条，当前显示 ${fmtInt(rows.length)} 条（过滤只在本页进行）。`,
          }),
          dataTable({
            columns: [
              {
                label: 'access_path',
                get: (e) => h('span', { class: 'mono', text: e.access_path ?? '—' }),
              },
              { label: 'model', get: (e) => h('span', { class: 'mono', text: e.model ?? '—' }) },
              { label: '模态', get: (e) => e.modality ?? '—' },
              { label: 'format', get: (e) => h('span', { class: 'mono', text: e.format ?? '—' }) },
              {
                label: '流式',
                get: (e) => h('span', { class: 'mono', text: streamingText(e.streaming) }),
              },
              {
                label: 'usage 来源',
                get: (e) => h('span', { class: 'mono', text: e.usage_source ?? '—' }),
              },
              { label: '上下文窗口', num: true, get: (e) => fmtInt(e.context_window) },
              { label: '最大输出', num: true, get: (e) => fmtInt(e.max_output_tokens) },
              {
                label: '不支持的字段',
                get: (e) =>
                  (e.unsupported_fields ?? []).length === 0
                    ? '—'
                    : h('span', {}, ...(e.unsupported_fields ?? []).map((f) => chip(f))),
              },
              {
                label: '怪癖',
                get: (e) =>
                  (e.quirks ?? []).length === 0
                    ? '—'
                    : h('span', {}, ...(e.quirks ?? []).map((f) => chip(f, 'warn'))),
              },
              {
                label: '合约测试',
                get: (e) =>
                  chip(e.contract_tested ? '已覆盖' : '未覆盖', e.contract_tested ? 'ok' : 'warn'),
              },
              {
                label: '状态',
                get: (e) =>
                  chip(
                    e.status ?? '—',
                    e.status === 'implemented' ? 'ok' : e.status === 'planned' ? 'warn' : '',
                  ),
              },
            ],
            rows,
            empty: '能力矩阵为空，或没有匹配当前过滤条件的条目。',
          }),
        );
      };
      filterInput.oninput = render;
      render();
    } catch (err) {
      box.error(err);
    }
  }

  view.append(card1.card);
  void load();
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.7 同步触发 ---------------------------------------------------------

function viewSync() {
  beginRender();
  renderShell();
  view.append(
    pageHeader('同步触发', '上游模型发现 / 离线目录刷新。两类都是异步耗时操作，触发后看结果。'),
  );

  const providerInput = h('input', { type: 'text', placeholder: '留空 = 全部已配置的' });
  const box = stateBox(h('div', {}));
  const runBtn = (kind, label, hint) =>
    h('button', {
      type: 'button',
      class: 'btn btn-primary',
      text: label,
      title: hint,
      onclick: () => void run(kind),
    });

  const syncCard = card(
    '触发同步',
    h('div', { class: 'field-grid' }, field('目标 provider（可选）', providerInput)),
    h(
      'div',
      { class: 'btn-row' },
      runBtn('upstream_discovery', '上游发现', '打上游 /models 之类的端点，更新能力矩阵'),
      runBtn('offline_catalog_refresh', '离线目录刷新', '重新读仓库内静态定价/模型表'),
    ),
    box.node,
  );

  async function run(kind) {
    const body = { kind };
    const provider = providerInput.value.trim();
    if (provider.length > 0) body.provider = provider;
    box.loading(`正在触发${kind === 'upstream_discovery' ? '上游发现' : '离线目录刷新'}…`);
    try {
      const res = await api(EP.sync, { method: 'POST', body });
      const result = res.result;
      clear(box.node);
      box.node.className = 'state';
      if (res.ok === false) {
        box.node.append(
          noticeTone('warn', '同步未完成', h('p', { text: res.error ?? '服务端未给出原因。' })),
        );
        return;
      }
      if (result === undefined) {
        box.node.append(h('div', { text: '服务端没有返回本次同步的明细。' }));
        return;
      }
      const list = (title, arr) =>
        h(
          'div',
          {},
          h('div', { class: 'stat-label', text: `${title}（${fmtInt(arr.length)}）` }),
          arr.length === 0
            ? h('div', { class: 'faint', text: '无' })
            : h('div', { class: 'mono', text: arr.join('、') }),
        );
      box.node.append(
        h('div', { class: 'field-grid' }, stat('开始时间', fmtTs(res.started_at))),
        h('div', { class: 'field-grid' }, stat('结束时间', fmtTs(res.finished_at))),
        h(
          'div',
          { class: 'field-grid' },
          stat('耗时', fmtDuration(res.started_at, res.finished_at)),
        ),
        list('新发现', result.discovered ?? []),
        h('div', { class: 'stats' }, list('有更新', result.updated ?? [])),
        h('div', { class: 'stats' }, list('新增', result.added ?? [])),
      );
    } catch (err) {
      box.error(err);
    }
  }

  view.append(syncCard.card);
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.8 用量 / 对账看板 --------------------------------------------------

const RANGES = [
  { label: '最近 24 小时', hours: 24 },
  { label: '最近 7 天', hours: 24 * 7 },
  { label: '最近 30 天', hours: 24 * 30 },
];

function viewUsage() {
  beginRender();
  renderShell();
  view.append(
    pageHeader(
      '用量 / 对账看板',
      '汇总数字 + 最近记录 + 对账偏差 + 余额快照。记录已脱敏（无 header、无 key、无正文）。',
    ),
  );

  const now = Date.now();
  const fromInput = h('input', {
    type: 'datetime-local',
    value: toLocalInput(now - 24 * 3600 * 1000),
  });
  const toInput = h('input', { type: 'datetime-local', value: toLocalInput(now) });
  const limitSelect = h(
    'select',
    {},
    [50, 100, 200].map((n) => h('option', { value: String(n), text: `最近 ${n} 条` })),
  );
  const rangeBox = stateBox(h('div', {}));

  const controlCard = card(
    '查询区间',
    h(
      'div',
      { class: 'field-grid' },
      field('起', fromInput),
      field('止', toInput),
      field('最近记录条数', limitSelect, '服务端只按区间返回；条数在浏览器里切。'),
    ),
    h(
      'div',
      { class: 'btn-row' },
      ...RANGES.map((r) =>
        h('button', {
          type: 'button',
          class: 'btn',
          text: r.label,
          onclick: () => {
            const end = Date.now();
            fromInput.value = toLocalInput(end - r.hours * 3600 * 1000);
            toInput.value = toLocalInput(end);
            void load();
          },
        }),
      ),
      h('button', {
        type: 'button',
        class: 'btn btn-primary',
        text: '应用自定义区间',
        onclick: () => void load(),
      }),
    ),
    rangeBox.node,
  );

  const summaryCard = card('汇总');
  const summaryBox = stateBox(summaryCard.body);
  const recentCard = card('最近记录');
  const recentBox = stateBox(recentCard.body);
  const reconCard = card('对账');
  const reconBox = stateBox(reconCard.body);
  const balanceCard = card('余额快照');
  const balanceBox = stateBox(balanceCard.body);
  const probeBtn = h('button', {
    type: 'button',
    class: 'btn btn-primary',
    text: '探测余额',
    onclick: () => void probeBalance(),
  });
  balanceCard.head.append(h('div', { class: 'spacer' }), probeBtn);

  async function load() {
    const from = fromLocalInput(fromInput.value);
    const to = fromLocalInput(toInput.value);
    summaryBox.loading('正在加载用量…');
    recentBox.loading('正在加载最近记录…');
    reconBox.loading('正在加载对账结果…');
    balanceBox.loading('正在加载余额快照…');
    try {
      const query = {};
      if (from !== undefined) query.from_ts = from;
      if (to !== undefined) query.to_ts = to;
      // routes.ts 的 usage 只认 from_ts / to_ts；「最近记录条数」在客户端切片
      const qs = new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)]),
      ).toString();
      const paths = EP.usage.map((p) => (qs.length > 0 ? `${p}?${qs}` : p));
      const data = await api(paths);
      const trip = secretTripwire(data, 'usage/dashboard');
      if (trip !== null) {
        summaryBox.remove();
        recentBox.remove();
        reconBox.remove();
        balanceBox.remove();
        clear(summaryCard.body);
        summaryCard.body.append(trip);
        return;
      }
      renderSummary(data.summary);
      renderRecent(data.recent ?? []);
      renderReconciliation(data.reconciliation);
      renderBalance(data.balance ?? []);
    } catch (err) {
      summaryBox.error(err);
      recentBox.remove();
      reconBox.remove();
      balanceBox.remove();
    }
  }

  function renderSummary(s) {
    summaryBox.remove();
    clear(summaryCard.body);
    if (!s) {
      summaryCard.body.append(h('div', { class: 'state state-empty' }, '服务端没有返回汇总。'));
      return;
    }
    summaryCard.body.append(
      h(
        'div',
        { class: 'stats' },
        stat('请求数', fmtInt(s.request_count), `${fmtTs(s.from_ts)} → ${fmtTs(s.to_ts)}`),
        stat('输入 tokens', fmtInt(s.input_tokens)),
        stat('输出 tokens', fmtInt(s.output_tokens)),
        stat('现金费用', fmtUsd(s.cash_total), 'USD'),
        stat('等价 API 价值', fmtUsd(s.as_api_total), '订阅路径也照算'),
        stat('未定价请求', fmtInt(s.unpriced_count), '拿不到价格，不是免费'),
      ),
      dataTable({
        caption: '按模型',
        columns: [
          { label: 'model', get: (r) => h('span', { class: 'mono', text: r.model ?? '—' }) },
          { label: '请求数', num: true, get: (r) => fmtInt(r.request_count) },
          { label: '现金费用', num: true, get: (r) => fmtUsd(r.cash_total) },
        ],
        rows: s.by_model ?? [],
        empty: '区间内没有记录。',
      }),
      dataTable({
        caption: '按 provider',
        columns: [
          { label: 'provider', get: (r) => h('span', { class: 'mono', text: r.provider ?? '—' }) },
          { label: '请求数', num: true, get: (r) => fmtInt(r.request_count) },
          { label: '现金费用', num: true, get: (r) => fmtUsd(r.cash_total) },
        ],
        rows: s.by_provider ?? [],
        empty: '区间内没有记录。',
      }),
    );
  }

  function renderRecent(rows) {
    recentBox.remove();
    clear(recentCard.body);
    const limit = Number(limitSelect.value);
    const shown = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
    recentCard.body.append(
      dataTable({
        caption: `最近 ${fmtInt(shown.length)} 条（已脱敏；服务端返回 ${fmtInt(rows.length)} 条，条数选择在客户端生效）`,
        columns: [
          { label: '时间', get: (r) => h('span', { class: 'nowrap', text: fmtTs(r.ts) }) },
          {
            label: 'request_id',
            get: (r) => h('span', { class: 'mono faint', text: r.request_id ?? '—' }),
          },
          { label: 'provider', get: (r) => h('span', { class: 'mono', text: r.provider ?? '—' }) },
          { label: 'model', get: (r) => h('span', { class: 'mono', text: r.model ?? '—' }) },
          {
            label: '别名',
            get: (r) => h('span', { class: 'mono faint', text: r.model_alias ?? '—' }),
          },
          {
            label: '状态',
            get: (r) =>
              chip(r.status ?? '—', r.status === 'ok' || r.status === 'success' ? 'ok' : 'warn'),
          },
          { label: '输入', num: true, get: (r) => fmtInt(r.input_tokens) },
          { label: '输出', num: true, get: (r) => fmtInt(r.output_tokens) },
          { label: '费用', num: true, get: (r) => fmtUsd(r.cash_total) },
          {
            label: 'finish_reason',
            get: (r) => h('span', { class: 'mono', text: r.finish_reason ?? '—' }),
          },
          {
            label: 'fast path',
            get: (r) => chip(r.fast_path ? '是' : '否', r.fast_path ? 'ok' : ''),
          },
        ],
        rows,
        empty: '区间内没有请求记录。',
      }),
    );
  }

  function renderReconciliation(r) {
    reconBox.remove();
    clear(reconCard.body);
    if (!r) {
      reconCard.body.append(
        h('div', { class: 'state state-empty' }, '还没有对账结果（需要上游余额/账单数据）。'),
      );
      return;
    }
    reconCard.body.append(
      h(
        'div',
        { class: 'stats' },
        stat('区间', `${fmtTs(r.from_ts)} → ${fmtTs(r.to_ts)}`),
        stat('估算现金', fmtUsd(r.estimated_cash), r.currency ?? 'USD'),
        stat('实际充值增量', fmtUsd(r.actual_topped_up_delta)),
        stat('实际赠送增量', fmtUsd(r.actual_granted_delta)),
        stat('偏差比例', fmtRatio(r.deviation_ratio), 'null = 没有可比对基准'),
        stat('请求数', fmtInt(r.request_count)),
      ),
      r.alert
        ? notice(
            '偏差超过阈值',
            h('p', {
              text: `当前偏差 ${fmtRatio(r.deviation_ratio)}，阈值 ${fmtRatio(r.alert_threshold)}。请核对上游账单与本地计量。`,
            }),
          )
        : h('div', {
            class: 'card-note',
            text: `偏差未超阈值（${fmtRatio(r.alert_threshold)}）。`,
          }),
    );
  }

  function renderBalance(rows) {
    balanceBox.remove();
    clear(balanceCard.body);
    balanceCard.body.append(
      dataTable({
        caption: '探测后的余额快照',
        columns: [
          { label: '币种', get: (r) => r.currency ?? '—' },
          { label: '总额', num: true, get: (r) => r.total_balance ?? '—' },
          { label: '赠送', num: true, get: (r) => r.granted_balance ?? '—' },
          { label: '充值', num: true, get: (r) => r.topped_up_balance ?? '—' },
        ],
        rows,
        empty: '还没有余额快照，点右上角「探测余额」。',
      }),
    );
  }

  async function probeBalance() {
    balanceBox.loading('正在探测余额…');
    try {
      const res = await api(EP.balanceProbe, { method: 'POST', body: {} });
      balanceBox.remove();
      clear(balanceCard.body);
      if (res.ok === false || res.is_available === false) {
        balanceCard.body.append(
          notice('余额探测不可用', h('p', { text: res.error ?? '服务端表示当前拿不到余额。' })),
        );
        return;
      }
      renderBalance(res.balances ?? []);
      balanceCard.body.append(
        h('div', { class: 'card-note', text: `探测时间：${fmtTs(res.checked_at)}` }),
      );
    } catch (err) {
      balanceBox.error(err);
    }
  }

  view.append(
    controlCard.card,
    summaryCard.card,
    recentCard.card,
    reconCard.card,
    balanceCard.card,
  );
  void load();
  view.setAttribute('aria-busy', 'false');
}

// ---- 6.9 审计日志 ---------------------------------------------------------

function viewAudit() {
  beginRender();
  renderShell();
  view.append(pageHeader('审计日志', '写操作留痕。条目绝不含 secret / 完整 key。'));

  const limit = 50;
  let offset = 0;
  const card1 = card('审计日志');
  const box = stateBox(card1.body);
  const pager = h('div', { class: 'btn-row' });
  card1.head.append(h('div', { class: 'spacer' }), pager);

  async function load() {
    box.loading('正在加载审计日志…');
    clear(pager);
    try {
      const data = await api(`${EP.audit[0]}?limit=${limit}&offset=${offset}`);
      const items = Array.isArray(data.items) ? data.items : [];
      box.remove();
      clear(card1.body);
      card1.body.append(
        dataTable({
          caption: `第 ${Math.floor(offset / limit) + 1} 页，共 ${fmtInt(data.total ?? items.length)} 条`,
          columns: [
            { label: '时间', get: (e) => h('span', { class: 'nowrap', text: fmtTs(e.ts) }) },
            { label: '操作者', get: (e) => h('span', { class: 'mono', text: e.actor ?? '—' }) },
            { label: '动作', get: (e) => h('span', { class: 'mono', text: e.action ?? '—' }) },
            { label: '对象', get: (e) => h('span', { class: 'mono', text: e.subject ?? '—' }) },
            {
              label: '结果',
              get: (e) =>
                chip(e.outcome === 'ok' ? 'ok' : 'error', e.outcome === 'ok' ? 'ok' : 'danger'),
            },
            { label: '附加信息', get: (e) => e.detail ?? '—' },
          ],
          rows: items,
          empty: '还没有审计记录。',
        }),
      );
      const total = typeof data.total === 'number' ? data.total : items.length;
      pager.append(
        h('button', {
          type: 'button',
          class: 'btn',
          text: '上一页',
          disabled: offset === 0,
          onclick: () => {
            offset = Math.max(0, offset - limit);
            void load();
          },
        }),
        h('button', {
          type: 'button',
          class: 'btn',
          text: '下一页',
          disabled: offset + limit >= total,
          onclick: () => {
            offset += limit;
            void load();
          },
        }),
      );
    } catch (err) {
      box.error(err);
    }
  }

  view.append(card1.card);
  void load();
  view.setAttribute('aria-busy', 'false');
}

// ---------------------------------------------------------------------------
// 7. 路由
// ---------------------------------------------------------------------------

const VIEWS = {
  '/': viewOverview,
  '/providers': viewProviders,
  '/credentials': viewCredentials,
  '/aliases': viewAliases,
  '/capabilities': viewCapabilities,
  '/sync': viewSync,
  '/usage': viewUsage,
  '/audit': viewAudit,
};

function currentPath() {
  const raw = location.hash.replace(/^#/, '');
  if (raw.length === 0) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function route() {
  const path = currentPath();
  if (state.token === null) {
    // 记住用户本来想去哪，登录成功后送回去（深链不被登录页吃掉）
    viewLogin(undefined, VIEWS[path] === undefined ? '/' : path);
    return;
  }
  const render = VIEWS[path];
  if (render === undefined) {
    location.hash = '#/';
    return;
  }
  render();
}

/** 会话失效：清内存令牌，回登录页，并把原因显示出来。 */
function expireSession(message) {
  const had = state.token !== null;
  state.token = null;
  state.user = null;
  state.expiresAt = null;
  if (!had) return;
  renderShell();
  viewLogin(message ?? '会话已失效，请重新登录。');
}

async function logout() {
  try {
    await api(EP.logout, { method: 'POST', body: {} });
  } catch {
    // 退出失败也要清本地状态：服务端可能已经把这个会话作废了
  }
  state.token = null;
  state.user = null;
  state.expiresAt = null;
  state.keystore = null;
  renderTradeoff();
  renderShell();
  viewLogin('已退出登录。');
}

// ---------------------------------------------------------------------------
// 8. 启动
// ---------------------------------------------------------------------------

function start() {
  initTheme();
  buildNav();
  dom.themeToggle.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });
  dom.logoutBtn.addEventListener('click', () => void logout());
  window.addEventListener('hashchange', route);

  void (async () => {
    await loadBootstrap();
    route();
  })();
}

start();
