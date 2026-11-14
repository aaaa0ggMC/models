/**
 * src/api/client.test.ts —— secret tripwire 的回归测试（按**值**判断，不按字段名）。
 *
 * 这个文件放在前端工程里而不是 tests/：被测试的对象就是前端的守卫本身，而且后端
 * tsconfig（NodeNext）解析不了前端源码里省略扩展名的相对导入。vitest 的 include
 * 通配所有 `.test.ts`，会覆盖到这里；前端 tsconfig 的 include 是 `src`，也会把它
 * 纳入 `npm run typecheck:admin`。不引 jsdom / @testing-library——这里只调纯函数。
 *
 * 守两条不容退化的性质：
 *   1. **不误报**：真实 admin API 响应（含设置页的 `items[].key`）一个都不拦；
 *   2. **不漏报**：真正形似密钥的值（`sk-ag-` + 32 位随机）照样拦，哪怕它待在
 *      一个毫不起眼的字段名里。
 */

import { describe, expect, it } from 'vitest';
import { findSecretLike, isSecretLikeField, looksLikeSecretValue } from './client';

/**
 * 测试用的假密钥 / 假凭据 / 假会话令牌。
 *
 * **全是键盘乱敲出来的假数据**（交替字母数字、递增十六进制），不对应任何真实凭据；
 * privacy-scan 会把它们当候选密钥报出来，已逐条确认后加 ignore。合成方式故意保持
 * 「一眼假」：不要为了像真的而去抄一把真 key 的形状。
 */
const FAKE_KEY = 'sk-ag-aB3dE6gH9jK2mN5pR8tU1wX4yZ7cQ0s'; // privacy-scan: ignore —— 假数据：键盘乱敲的测试夹具
const FAKE_OPAQUE = 'aB3dE6gH9jK2mN5pR8tU1wX4yZ7cQ0sT2v'; // privacy-scan: ignore —— 假数据：无前缀的长随机凭据夹具
const FAKE_OPAQUE_SHORT = 'a1b2c3d4e5f6g7h8'; // privacy-scan: ignore —— 假数据：短凭据夹具
const FAKE_SESSION_TOKEN = 'MK6408iIeFHwvLSaQTvjCkNq932Jg7OAJ48QdJVcL8'; // privacy-scan: ignore —— 假数据：43 位 base64url 会话令牌夹具
const FAKE_SESSION_TOKEN_SEP = 'MK6408iIeFHwvLSaQTvjCkNq932Jg-7OAJ48QdJVcL8'; // privacy-scan: ignore —— 假数据：带 - 的会话令牌夹具

/**
 * 真实 `GET /admin/api/settings` 的响应（8 项全量；抓自 tests/settings.test.ts 的
 * 同一套 harness，`key` 已按改名后的契约替换成 `id`）。
 *
 * 它就是那次误报的当事响应：旧守卫只认字段名，见到 `items[].key` 就整页拦死。
 */
const SETTINGS_RESPONSE = {
  items: [
    {
      id: 'global_timeout_ms',
      label: '全局超时',
      description: '整个请求的上限（含上游与流式）。S0 据此算 deadline。',
      unit: 'ms',
      type: 'int',
      value: 300000,
      source: 'default',
      editable: true,
      env_var: 'AG_GLOBAL_TIMEOUT_MS',
      range: { min: 1000, max: 3600000 },
    },
    {
      id: 'ttfb_timeout_ms',
      label: 'TTFB 超时',
      description: '上游首字节超时。',
      unit: 'ms',
      type: 'int',
      value: 30000,
      source: 'default',
      editable: true,
      env_var: 'AG_TTFB_TIMEOUT_MS',
      range: { min: 500, max: 600000 },
    },
    {
      id: 'stream_idle_timeout_ms',
      label: '流式空闲超时',
      description: '杀掉「发了首块之后静默」的流（20 §S5）。',
      unit: 'ms',
      type: 'int',
      value: 120000,
      source: 'default',
      editable: true,
      env_var: 'AG_STREAM_IDLE_TIMEOUT_MS',
      range: { min: 1000, max: 3600000 },
    },
    {
      id: 'max_retries',
      label: '最大重试',
      description: '同 attempt 内的最大重试次数（20 §7.3）。',
      unit: '次',
      type: 'int',
      value: 5,
      source: 'encrypted_storage',
      editable: true,
      env_var: 'AG_MAX_RETRIES',
      range: { min: 0, max: 10 },
      stored_value: 5,
      updated_at: 1760000000000,
      updated_by: 'owner#owner',
    },
    {
      id: 'retry_base_delay_ms',
      label: '退避基数',
      description: '指数退避的基数，叠加 jitter。',
      unit: 'ms',
      type: 'int',
      value: 200,
      source: 'default',
      editable: true,
      env_var: 'AG_RETRY_BASE_DELAY_MS',
      range: { min: 0, max: 60000 },
    },
    {
      id: 'loss_policy',
      label: 'loss policy',
      description: '字段丢失时的默认档；strict 会把丢失当错误。',
      unit: '',
      type: 'enum',
      value: 'allow',
      source: 'default',
      editable: true,
      env_var: 'AG_LOSS_POLICY',
      options: ['allow', 'safe', 'strict', 'emulate'],
    },
    {
      id: 'model_sync_interval_ms',
      label: '模型同步间隔',
      description: '上游元数据周期同步间隔；0 = 不定时。',
      unit: 'ms',
      type: 'int',
      value: 900000,
      source: 'default',
      editable: true,
      env_var: 'AG_MODEL_SYNC_INTERVAL_MS',
      range: { min: 0, max: 86400000 },
    },
    {
      id: 'plugin_timeout_ms',
      label: '插件超时',
      description: '单个插件 hook 的单次调用超时。',
      unit: 'ms',
      type: 'int',
      value: 5000,
      source: 'default',
      editable: true,
      env_var: 'AG_PLUGIN_TIMEOUT_MS',
      range: { min: 100, max: 300000 },
    },
  ],
  config_file_path: '/etc/agentgateway/gateway.json',
};

describe('secret tripwire：真实 admin 响应不误报', () => {
  it('设置页响应（items[].id 承载设置项标识符）不触发', () => {
    expect(findSecretLike(SETTINGS_RESPONSE)).toEqual([]);
    // 这份夹具就是 8 项全量：别哪天少了几项还以为在测设置页
    expect(SETTINGS_RESPONSE.items).toHaveLength(8);
    for (const item of SETTINGS_RESPONSE.items) {
      expect(Object.keys(item)).not.toContain('key');
    }
  });

  it('设置项标识符就算还叫 key 也不触发（值不像密钥）', () => {
    const legacy = {
      items: [{ key: 'global_timeout_ms' }, { key: 'plugin_timeout_ms' }],
    };
    expect(findSecretLike(legacy)).toEqual([]);
  });

  it('虚拟 key 列表只回掩码与前 8 位，不触发', () => {
    const res = {
      items: [
        {
          key_id: 'vk_mgj6k3cw_97e299983056',
          name: 'capture-key',
          status: 'active',
          masked: 'sk-ag-mV…',
          head: 'sk-ag-mV',
          note: 'capture vk',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    expect(findSecretLike(res)).toEqual([]);
  });

  it('凭据列表的掩码 / head / env 引用不触发', () => {
    const res = {
      items: [
        {
          id: 'cred_mgj6k3cw_rpg3ty',
          provider: 'deepseek',
          access_path: 'deepseek.chat',
          masked: 'sk-****6789',
          length: 39,
          head: 'sk-c',
          storage: { location: 'env', ref: 'env:AG_DEEPSEEK_API_KEY' },
          enabled: true,
          health: 'unknown',
          note: 'capture cred',
        },
      ],
    };
    expect(findSecretLike(res)).toEqual([]);
  });

  it('provider-presets 的 key_prefix / key_hint 是提示文案，不是密钥', () => {
    const res = {
      items: [
        { id: 'deepseek', key_prefix: 'sk-', key_hint: 'sk- 开头（两个 dialect 共用同一个 key）' },
        { id: 'openai', key_prefix: 'sk-', key_hint: 'sk- 开头（project key 为 sk-proj-）' },
        { id: 'anthropic', key_prefix: 'sk-ant-', key_hint: 'sk-ant- 开头' },
      ],
    };
    expect(findSecretLike(res)).toEqual([]);
  });

  it('审计 detail 里的 masked=… 不触发', () => {
    const res = {
      items: [
        {
          id: 'audit_mgj6k3cw_60j896',
          actor: 'owner#owner',
          action: 'credential.create',
          subject: 'credential/cred_mgj6k3cw_rpg3ty',
          outcome: 'ok',
          detail: 'provider=deepseek access_path=deepseek.chat masked=sk-****6789 length=39',
        },
      ],
    };
    expect(findSecretLike(res)).toEqual([]);
  });

  it('结构化标识与指纹不触发（request_id / dek_id / kek_fingerprint / 版本号 / URL）', () => {
    const res = {
      recent: [{ request_id: 'req_01JQZ8K2M4V7X9B3N6P5R8T1W0', model: 'deepseek-chat' }],
      keystore: {
        active_dek_id: 'dek_9f2c1a7b3e5d',
        kek_fingerprint: 'a1b2c3d4e5f60718',
        api_version: '0.1.0',
      },
      balance: [{ currency: 'USD', total_balance: '123.45' }],
      link: 'https://api-docs.deepseek.com/',
    };
    expect(findSecretLike(res)).toEqual([]);
  });

  it('自然语言说明（中文长句）不触发', () => {
    const res = {
      keystore: {
        tradeoff_note:
          '未装配密钥库：管理面可看界面，但读不到任何加密存储内容。请按部署文档解锁密钥存储。',
      },
    };
    expect(findSecretLike(res)).toEqual([]);
  });
});

describe('secret tripwire：真密钥不漏报', () => {
  it('sk-ag- + 32 位随机：哪怕字段名叫 id / note / key 也拦', () => {
    const fakeKey = FAKE_KEY;
    for (const field of ['id', 'key', 'note', 'value', 'whatever']) {
      expect(findSecretLike({ items: [{ [field]: fakeKey }] })).toEqual([`items[0].${field}`]);
    }
  });

  it('items[].key 里放一把真 key 必须拦（这次误报的逆命题）', () => {
    const forged = {
      items: [{ key: 'global_timeout_ms' }, { key: FAKE_KEY }],
    };
    expect(findSecretLike(forged)).toEqual(['items[1].key']);
  });

  it('没有固定前缀的长随机凭据也拦（大小写数字俱全的 base62）', () => {
    const azureLike = FAKE_OPAQUE;
    expect(findSecretLike({ note: azureLike })).toEqual(['note']);
    expect(looksLikeSecretValue(azureLike)).toBe(true);
  });

  it('字段名是秘密命名 + 不透明值：没有前缀的 key 格式也拦', () => {
    expect(isSecretLikeField('api_key', 'hunter2hunter2')).toBe(true);
    expect(isSecretLikeField('access_token', FAKE_OPAQUE_SHORT)).toBe(true);
    expect(isSecretLikeField('password', 'Tr0ub4dor&3')).toBe(true);
    expect(
      findSecretLike({ config: { client_secret: FAKE_OPAQUE_SHORT } }), // privacy-scan: ignore —— client_secret 是本用例要测的字段名，右侧是假数据
    ).toEqual(['config.client_secret']);
  });

  it('新建 virtual key 的 plaintext 只有显式允许才放行', () => {
    const created = {
      ok: true,
      key: { key_id: 'vk_1', masked: 'sk-ag-mV…', head: 'sk-ag-mV' },
      plaintext: FAKE_KEY,
    };
    // 默认拦（唯一例外的端点必须显式 opt-in）
    expect(findSecretLike(created)).toEqual(['plaintext']);
    // opt-in 后放行，且 key 里的掩码 / 前 8 位照样不拦
    expect(findSecretLike(created, '', 0, [], true)).toEqual([]);
  });

  it('登录响应的会话令牌只有显式允许才放行（43 位 base64url 随机串）', () => {
    // admin/auth.ts 的会话令牌：randomBytes(32).toString('base64url')，43 字符。
    // base64url 的 `-` / `_` 每个字符只有 2/64 概率，约四分之一的令牌一个都不含，
    // 于是它长得和一把没有固定前缀的 provider key 完全一样——必须显式开口子。
    const noSeparator = FAKE_SESSION_TOKEN;
    const withSeparator = FAKE_SESSION_TOKEN_SEP;
    expect(looksLikeSecretValue(noSeparator)).toBe(true);
    // 带 `-` 的按「结构化标识」放过（字符集判据），但那是运气不是设计
    expect(looksLikeSecretValue(withSeparator)).toBe(false);

    const login = {
      ok: true,
      token: noSeparator, // privacy-scan: ignore —— LoginResponse 契约字段名，右侧是假数据
      expires_at: 1760003600000,
      user: { id: 'owner', name: 'owner', role: 'owner' },
    };
    // 默认拦：它与一把没有固定前缀的 provider key 在值上无法区分
    expect(findSecretLike(login)).toEqual(['token']);
    // opt-in 后放行，且 user / expires_at 照样不拦
    expect(findSecretLike(login, '', 0, [], false, true)).toEqual([]);
  });

  it('登录响应里混进一把真 key，即使允许 token 也要拦', () => {
    const poisoned = {
      ok: true,
      token: FAKE_SESSION_TOKEN, // privacy-scan: ignore —— LoginResponse 契约字段名，右侧是假数据
      error: FAKE_KEY,
    };
    expect(findSecretLike(poisoned, '', 0, [], false, true)).toEqual(['error']);
  });

  it('掩码值与前 8 位不算泄漏（长度与掩码符号都在阈值内）', () => {
    expect(looksLikeSecretValue('sk-****6789')).toBe(false);
    expect(looksLikeSecretValue('sk-ag-mV…')).toBe(false);
    expect(looksLikeSecretValue('sk-ag-mV')).toBe(false);
    expect(looksLikeSecretValue('sk-')).toBe(false);
    expect(looksLikeSecretValue('sk-ant-')).toBe(false);
    expect(looksLikeSecretValue('sk- 开头（project key 为 sk-proj-）')).toBe(false);
  });

  it('短串 / 纯小写标识符 / 带分隔符的结构化串不算泄漏', () => {
    expect(looksLikeSecretValue('aB3dE6gH9j')).toBe(false); // 10 位，太短
    expect(looksLikeSecretValue('globaltimeoutms')).toBe(false); // 纯小写无数字
    expect(looksLikeSecretValue('deepseek-chat')).toBe(false); // 带分隔符
    expect(looksLikeSecretValue('env:AG_OPENAI_API_KEY')).toBe(false); // env 引用
  });
});
