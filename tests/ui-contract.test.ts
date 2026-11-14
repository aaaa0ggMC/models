/**
 * tests/ui-contract.test.ts —— 管理面前端的**契约**测试。
 *
 * 前端是独立构建的 SPA（Vite + React + Semi，不在 vitest 覆盖范围内），
 * 因此这里用「读源码 + 断言」的方式守三条不容退化的约定：
 *
 *   1. **页面真的接上了**：新页面在 router 与 App 里都有登记，不是写了没人用；
 *   2. **完整密钥的渲染路径只有一条**：全前端只有 `POST /virtual-keys` 那一次调用
 *      带 `allowPlaintext`，且只有那一个 Modal 读 `res.plaintext`；
 *   3. **前端类型与后端契约同字段**：`webui/admin/src/api/types.ts` 镜像的字段
 *      在 `admin/api-types.ts` 里都存在（契约漂移会在编译期之外被这里抓住）。
 *
 * 为什么不做组件渲染测试：那要引 @testing-library 与 jsdom，而本仓库前端工程
 * 刻意零测试依赖（见 webui/admin/README.md 的选型结论）。用文本断言换
 * 「不加依赖」是这个取舍的一部分——它守不住交互细节，但守得住上面三条。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

/** 去掉块注释与行注释后的纯代码（断言「代码里没有 X」时用，避免被注释里的说明文字误伤）。 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const APP = read('webui/admin/src/App.tsx');
const ROUTER = read('webui/admin/src/router.ts');
const CLIENT = read('webui/admin/src/api/client.ts');
const WEB_TYPES = read('webui/admin/src/api/types.ts');
const ADMIN_TYPES = read('admin/api-types.ts');
const VK_PAGE = read('webui/admin/src/pages/VirtualKeys.tsx');
const SETTINGS_PAGE = read('webui/admin/src/pages/Settings.tsx');

describe('UI 契约：新页面接上了路由与导航', () => {
  it('router 里有 /virtual-keys 与 /settings', () => {
    expect(ROUTER).toContain("virtualKeys: '/virtual-keys'");
    expect(ROUTER).toContain("settings: '/settings'");
  });

  it('App 渲染两个新页面，且导航里有入口', () => {
    expect(APP).toContain("import { VirtualKeys } from './pages/VirtualKeys'");
    expect(APP).toContain("import { Settings } from './pages/Settings'");
    expect(APP).toContain('return <VirtualKeys />;');
    expect(APP).toContain('return <Settings />;');
    expect(APP).toContain('ROUTES.virtualKeys');
    expect(APP).toContain('ROUTES.settings');
  });

  it('原有的 6 个路由一个都没被删掉', () => {
    for (const key of ['channels', 'credentials', 'aliases', 'catalog', 'usage', 'system']) {
      expect(ROUTER).toContain(`${key}: '/${key}'`);
    }
  });

  it('改版后默认落地页是概览，且概览真的接上了路由与导航', () => {
    expect(ROUTER).toContain("overview: '/overview'");
    // 老书签仍然有效：`/` 归一到概览，但 `#/channels` 一字未改
    expect(ROUTER).toContain("if (path === '' || path === '/') return ROUTES.overview;");
    expect(APP).toContain("import { Overview } from './pages/Overview'");
    expect(APP).toContain('return <Overview />;');
    expect(APP).toContain('ROUTES.overview');
  });

  it('侧栏导航分成 4 组（分组不是平铺一列）', () => {
    // Semi Nav 的分组靠嵌套 items 表达；四个组名都要在 App.tsx 里
    for (const g of ['总览', '上游接入', '模型与用量', '系统']) {
      expect(APP, `导航缺分组「${g}」`).toContain(g);
    }
    // 分组结构：至少一个组带 items 数组
    expect(APP).toMatch(/items:\s*\[/);
  });
});

describe('UI 契约：完整密钥只有一条渲染路径', () => {
  it('secret tripwire 认识 plaintext 字段', () => {
    expect(CLIENT).toMatch(/plaintext/i);
  });

  it('全前端只有一处带 allowPlaintext，且它就是新建 virtual key', () => {
    const files = [
      'webui/admin/src/api/client.ts',
      'webui/admin/src/auth.tsx',
      'webui/admin/src/pages/VirtualKeys.tsx',
      'webui/admin/src/pages/Settings.tsx',
      'webui/admin/src/pages/Credentials.tsx',
      'webui/admin/src/pages/Channels.tsx',
      'webui/admin/src/pages/Aliases.tsx',
      'webui/admin/src/pages/Usage.tsx',
      'webui/admin/src/pages/System.tsx',
      'webui/admin/src/pages/ModelCatalog.tsx',
    ];
    // client.ts 是选项的**定义处**，不算使用点
    const withOptIn = files
      .filter((f) => f !== 'webui/admin/src/api/client.ts')
      .filter((f) => read(f).includes('allowPlaintext'));
    expect(withOptIn).toEqual(['webui/admin/src/pages/VirtualKeys.tsx']);
    // 且那一处必须是 POST /virtual-keys（看代码，不看注释里的说明）
    const page = code('webui/admin/src/pages/VirtualKeys.tsx');
    expect(page).toContain("'/virtual-keys'");
    const idx = page.indexOf('allowPlaintext');
    expect(idx).toBeGreaterThanOrEqual(0);
    const around = page.slice(Math.max(0, idx - 200), idx + 200);
    expect(around).toContain("'/virtual-keys'");
    expect(around).toContain("method: 'POST'");
  });

  it('只有 VirtualKeys 页读 plaintext，其他页面一次都不读', () => {
    const readers = [
      'webui/admin/src/pages/Settings.tsx',
      'webui/admin/src/pages/Credentials.tsx',
      'webui/admin/src/pages/Channels.tsx',
      'webui/admin/src/pages/Usage.tsx',
      'webui/admin/src/pages/System.tsx',
      'webui/admin/src/pages/Aliases.tsx',
      'webui/admin/src/pages/ModelCatalog.tsx',
      'webui/admin/src/pages/Login.tsx',
      'webui/admin/src/pages/Help.tsx',
      'webui/admin/src/auth.tsx',
    ];
    for (const f of readers) {
      expect(code(f), `${f} 的代码不该读 plaintext`).not.toContain('plaintext');
    }
  });

  it('会话令牌的开口子只有登录一处，且它就是 POST /login', () => {
    const files = [
      'webui/admin/src/api/client.ts',
      'webui/admin/src/auth.tsx',
      'webui/admin/src/pages/VirtualKeys.tsx',
      'webui/admin/src/pages/Settings.tsx',
      'webui/admin/src/pages/Credentials.tsx',
      'webui/admin/src/pages/Channels.tsx',
      'webui/admin/src/pages/Aliases.tsx',
      'webui/admin/src/pages/Usage.tsx',
      'webui/admin/src/pages/System.tsx',
      'webui/admin/src/pages/ModelCatalog.tsx',
      'webui/admin/src/pages/Help.tsx',
    ];
    // client.ts 是选项的定义处，不算使用点
    const withOptIn = files
      .filter((f) => f !== 'webui/admin/src/api/client.ts')
      .filter((f) => read(f).includes('allowSessionToken'));
    expect(withOptIn).toEqual(['webui/admin/src/auth.tsx']);
    const auth = code('webui/admin/src/auth.tsx');
    const idx = auth.indexOf('allowSessionToken');
    expect(idx).toBeGreaterThanOrEqual(0);
    const around = auth.slice(Math.max(0, idx - 200), idx + 200);
    expect(around).toContain("'/login'");
  });

  it('VirtualKeys 页的表格列里没有 plaintext / secret 形字段', () => {
    const tablePart = VK_PAGE.slice(VK_PAGE.indexOf('const columns'), VK_PAGE.indexOf('return ('));
    expect(tablePart).not.toMatch(/dataIndex:\s*'(plaintext|secret|key)'/);
    // 表格只展示掩码与前 8 位（66 §2.2）
    expect(tablePart).toContain("dataIndex: 'masked'");
    expect(VK_PAGE).toContain('k.masked');
  });

  it('明文模态框关闭即从 state 消失（不落浏览器存储）', () => {
    expect(VK_PAGE).toContain('setIssued(null)');
    // 只看代码，不看注释——注释里那句是安全约定本身
    expect(code('webui/admin/src/pages/VirtualKeys.tsx')).not.toMatch(
      /localStorage|sessionStorage/,
    );
  });
});

describe('UI 契约：设置页标注来源并对 env 覆盖项只读', () => {
  it('四种来源都有标签', () => {
    for (const src of ['encrypted_storage', 'env', 'config_file', 'default']) {
      expect(SETTINGS_PAGE).toContain(src);
    }
  });

  it('不可改的项不渲染输入框，改渲染只读值', () => {
    expect(SETTINGS_PAGE).toContain('if (!s.editable)');
    expect(SETTINGS_PAGE).toContain('disabled={!s.editable || !dirty}');
  });

  it('不可改时给出原因（env 锁的说明文案）', () => {
    expect(SETTINGS_PAGE).toContain('s.reason');
    // 理由的长文搬到帮助页了，页面只留一句 + 「为什么」入口
    expect(SETTINGS_PAGE).toContain("helpHref('settings')");
  });

  it('保存走 PUT /settings/{id}（不是 POST 全量覆盖）', () => {
    expect(SETTINGS_PAGE).toContain("method: 'PUT'");
    expect(SETTINGS_PAGE).toContain('`/settings/${encodeURIComponent(s.id)}`');
  });

  it('设置项标识符字段叫 id，不叫 key（与虚拟 key 域不撞名）', () => {
    expect(SETTINGS_PAGE).toContain('rowKey="id"');
    expect(SETTINGS_PAGE).not.toMatch(/s\.key\b/);
    const dto = sliceInterface(ADMIN_TYPES, 'SettingDto');
    expect(dto).toMatch(/\bid: string;/);
    expect(dto).not.toMatch(/\bkey: string;/);
    // 前端镜像同步改名
    expect(WEB_TYPES).toContain('export interface SettingDto');
    const webDto = sliceInterface(WEB_TYPES, 'SettingDto');
    expect(webDto).toMatch(/\bid: string;/);
    expect(webDto).not.toMatch(/\bkey: string;/);
  });
});

describe('UI 契约：secret tripwire 按值判断，不按字段名', () => {
  it('判据里有密钥前缀 / 长度 / 字符集，而不是只匹配字段名', () => {
    // 前缀清单（值的形状）
    expect(CLIENT).toMatch(/KEY_PREFIX_RE/);
    expect(CLIENT).toMatch(/sk-ag-/);
    // 长度阈值与字符集
    expect(CLIENT).toMatch(/MIN_OPAQUE_LEN/);
    expect(CLIENT).toContain('/^[A-Za-z0-9]+$/');
  });

  it('字段名判据里不再有裸 key（设置页误报的根因）', () => {
    const secretish = CLIENT.slice(
      CLIENT.indexOf('SECRETISH_NAME_RE'),
      CLIENT.indexOf('isOpaqueCredentialish'),
    );
    expect(secretish).not.toMatch(/\^key\$/);
    expect(secretish).not.toMatch(/\|key\|/);
  });

  it('守卫的回归测试在前端工程里（vitest 覆盖得到）', () => {
    expect(read('webui/admin/src/api/client.test.ts')).toContain('looksLikeSecretValue');
  });
});

describe('UI 契约：趋势图的数据来源', () => {
  it('前端镜像了 UsageTimeseriesResponse（后端 admin/api-types.ts 也有）', () => {
    for (const name of ['UsageTimeseriesBucket', 'UsageTimeseriesResponse']) {
      expect(WEB_TYPES, `前端缺 ${name}`).toContain(name);
      expect(ADMIN_TYPES, `后端缺 ${name}`).toContain(name);
    }
  });

  it('Overview 与 Usage 都从 /usage/timeseries 取趋势，不自己拼样本', () => {
    for (const rel of ['webui/admin/src/pages/Overview.tsx', 'webui/admin/src/pages/Usage.tsx']) {
      const src = read(rel);
      expect(src, `${rel} 没打 /usage/timeseries`).toContain('/usage/timeseries');
    }
    // 两页都**不**从 recent（最近 50 条）拼趋势——那是 5% 的样本
    for (const rel of ['webui/admin/src/pages/Overview.tsx', 'webui/admin/src/pages/Usage.tsx']) {
      const src = read(rel);
      expect(src, `${rel} 不该用 recent 当趋势数据`).not.toMatch(/recent\s*\.map/);
    }
  });

  it('缺数据源的图表在页面上标注依赖，不画假曲线', () => {
    const overview = read('webui/admin/src/pages/Overview.tsx');
    const usage = read('webui/admin/src/pages/Usage.tsx');
    // 两页都要有「待 P0-4」的说明块
    expect(overview).toContain('P0-4');
    expect(usage).toContain('P0-4');
    // 且都不含写死的假延迟 / 假错误率数字
    for (const src of [overview, usage]) {
      expect(src).not.toMatch(/p95\s*[:=]\s*\d/);
      expect(src).not.toMatch(/errorRate\s*[:=]\s*\d/);
    }
  });
});

describe('UI 契约：前端类型与后端契约同字段', () => {
  it('VirtualKeyDto 的每个字段都在 admin/api-types.ts 里', () => {
    const fields = [
      'key_id',
      'name',
      'note',
      'status',
      'created_at',
      'updated_at',
      'revoked_at',
      'expires_at',
      'models',
      'providers',
      'allow_message_persistence',
      'rate_limit',
      'budget_micros',
      'team_id',
      'user_id',
      'masked',
      'head',
    ];
    const dto = sliceInterface(ADMIN_TYPES, 'VirtualKeyDto');
    for (const f of fields) expect(dto, `VirtualKeyDto 缺 ${f}`).toMatch(new RegExp(`\\b${f}\\b`));
  });

  it('VirtualKeyCreateResponse 带 plaintext（唯一一次）', () => {
    const dto = sliceInterface(ADMIN_TYPES, 'VirtualKeyCreateResponse');
    expect(dto).toContain('plaintext');
  });

  it('SettingDto 的每个字段都在 admin/api-types.ts 里', () => {
    const fields = [
      'id',
      'label',
      'description',
      'unit',
      'type',
      'value',
      'source',
      'editable',
      'reason',
      'env_var',
      'range',
      'options',
      'stored_value',
      'updated_at',
      'updated_by',
    ];
    const dto = sliceInterface(ADMIN_TYPES, 'SettingDto');
    for (const f of fields) expect(dto, `SettingDto 缺 ${f}`).toMatch(new RegExp(`\\b${f}\\b`));
  });

  it('后端响应里绝不明文回显的字段在契约里注明', () => {
    const dto = sliceInterface(ADMIN_TYPES, 'VirtualKeyDto');
    expect(dto).toMatch(/不明文|掩码/);
  });

  it('SecretRefCreateRequest 明确拒绝 value 字段', () => {
    const dto = sliceInterface(ADMIN_TYPES, 'SecretRefCreateRequest');
    expect(dto).toContain('value');
    expect(dto).toMatch(/不接受|never/);
  });

  it('前端类型文件镜像了同样的类型名', () => {
    for (const name of [
      'VirtualKeyDto',
      'VirtualKeyCreateResponse',
      'VirtualKeyCreateRequest',
      'VirtualKeyUsage',
      'SettingDto',
      'SettingSource',
      'SecretRefDto',
      'AuthModeResponse',
    ]) {
      expect(WEB_TYPES, `前端缺 ${name}`).toContain(name);
      expect(ADMIN_TYPES, `后端缺 ${name}`).toContain(name);
    }
  });
});

/** 取出一个 interface 的源码段（到下一个 export 为止）。 */
function sliceInterface(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name}`);
  expect(start, `找不到 interface ${name}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end === -1 ? undefined : end + 3);
}
