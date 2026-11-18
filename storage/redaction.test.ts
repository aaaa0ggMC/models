/**
 * storage/redaction.test.ts —— 脱敏引擎单测。
 *
 * 重点在三件事：各密钥前缀收得进来、掩码与结构化标识不误伤、规则可配置。
 * 判据与 `webui/admin/src/api/client.ts` 的 `looksLikeSecretValue` 同源，
 * 前后端一致性另见 tests/redaction-parity.test.ts。
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_REDACTION_RULES,
  emptyRedactionConfig,
  findSecretRanges,
  looksLikeSecretValue,
  looksMasked,
  redactText,
  redactUnknown,
  validateRedactionRule,
  validateRedactionRules,
  type RedactionConfig,
  type RedactionRule,
} from './redaction.js';

const cfg = (over: Partial<RedactionConfig> = {}): RedactionConfig => ({
  ...emptyRedactionConfig(),
  ...over,
});

/** 一批**假**密钥（不是真凭据；形态与真 key 同款，值本身是编的）。 */
const FAKE = {
  openai: 'sk-abcdefghijklmnopqrstuvwxyz0123456789', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  anthropic: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz-0123456789_ABCDEFGH', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  gatewayVirtual: 'sk-ag-mV0AbCdEfGhIjKlMnOpQrStUv', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  google: 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  github: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345678', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  aws: 'AKIAIOSFODNN7EXAMPLE', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  slack: 'xoxb-123456789012-AbCdEfGhIjKlMnOpQrStUvWx', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  stripe: 'sk_live_AbCdEfGhIjKlMnOpQrStUvWxYz', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
  opaque: 'aB3dE6gH9jK2mN5pQ8rT1vW4yZ7xC0bF', // privacy-scan: ignore —— 假数据：密钥形态测试向量（值本身是编的，不是真凭据）
};

describe('值形状判据', () => {
  it('各已知前缀都判为密钥', () => {
    for (const value of Object.values(FAKE)) {
      expect(looksLikeSecretValue(value), value).toBe(true);
    }
  });

  it('掩码值与前导位不算密钥', () => {
    expect(looksLikeSecretValue('sk-****7890')).toBe(false);
    expect(looksLikeSecretValue('sk-ag-mV…')).toBe(false);
    expect(looksLikeSecretValue('sk-ag-mV')).toBe(false);
    expect(looksMasked('sk-****7890')).toBe(true);
  });

  it('结构化标识、UUID、版本号不误报', () => {
    for (const value of [
      'req_01J9Z8KQ7V3XW2M4N6P8R0T1Y5',
      'cred_m1a2b3c4d5e6',
      'dek_ab12cd34ef56',
      'env:AG_OPENAI_API_KEY',
      'deepseek.openai-chat',
      '0.1.0',
      '2026.11.15',
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400e29b41d4a716446655440000',
      'kek_fingerprint',
      'a1b2c3d4e5f60718',
    ]) {
      expect(looksLikeSecretValue(value), value).toBe(false);
    }
  });

  it('纯小写十六进制指纹（无大写）不误报', () => {
    expect(looksLikeSecretValue('a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBe(false);
  });
});

describe('正文脱敏', () => {
  it('句末带标点也能命中', () => {
    const out = redactText(`我的 key 是 ${FAKE.openai}。`, cfg());
    expect(out.text).toBe('我的 key 是 <redacted_key>。');
    expect(out.replaced).toBe(1);
  });

  it('引号 / 括号 / 等号包裹都能命中', () => {
    for (const wrapped of [
      `"${FAKE.openai}"`,
      `(${FAKE.openai})`,
      `key=${FAKE.openai}`,
      `[${FAKE.openai}]`,
      `<${FAKE.openai}>`,
      `Bearer ${FAKE.openai}`,
    ]) {
      expect(redactText(wrapped, cfg()).text, wrapped).toBe(
        wrapped.replace(FAKE.openai, '<redacted_key>'),
      );
    }
  });

  it('一段话里有多把 key 时全部替换', () => {
    const out = redactText(
      `第一把 ${FAKE.openai}，第二把 ${FAKE.github}，第三个 ${FAKE.aws}。`,
      cfg(),
    );
    expect(out.text).not.toContain(FAKE.openai);
    expect(out.text).not.toContain(FAKE.github);
    expect(out.text).not.toContain(FAKE.aws);
    expect(out.replaced).toBe(3);
  });

  it('没有命中时原文返回', () => {
    const text = '帮我把 DeepSeek 接进来，型号用 deepseek-chat。';
    expect(redactText(text, cfg())).toEqual({ text, replaced: 0 });
  });

  it('命中区间是原文本下标', () => {
    const text = `前缀 ${FAKE.openai} 后缀`;
    const ranges = findSecretRanges(text, cfg());
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe(FAKE.openai);
  });

  it('占位符可配置', () => {
    const out = redactText(`key ${FAKE.openai}`, cfg({ placeholder: '[已屏蔽]' }));
    expect(out.text).toBe('key [已屏蔽]');
  });

  it('递归脱敏对象与数组，键名不动', () => {
    const input = {
      note: `密钥 ${FAKE.openai}`,
      nested: { list: [FAKE.github, 42, true, null], id: 'req_01J9Z8KQ7V3XW2M4N6P8R0T1Y5' },
    };
    const out = redactUnknown(input, cfg()) as typeof input;
    expect(out.note).toBe('密钥 <redacted_key>');
    expect(out.nested.list[0]).toBe('<redacted_key>');
    expect(out.nested.list[1]).toBe(42);
    expect(out.nested.list[2]).toBe(true);
    expect(out.nested.list[3]).toBeNull();
    expect(out.nested.id).toBe('req_01J9Z8KQ7V3XW2M4N6P8R0T1Y5');
  });
});

describe('数据规则', () => {
  const rule: RedactionRule = {
    id: 'r1',
    pattern: 'ACME-[0-9]{6}',
    flags: 'g',
    replacement: '[ACME]',
    enabled: true,
  };

  it('用户加一条规则后服务端也认', () => {
    const out = redactText('工单 ACME-123456 已建', cfg({ rules: [rule] }));
    expect(out.text).toBe('工单 [ACME] 已建');
  });

  it('规则可以整条关掉', () => {
    const out = redactText('工单 ACME-123456', cfg({ rules: [{ ...rule, enabled: false }] }));
    expect(out.text).toBe('工单 ACME-123456');
  });

  it('规则缺 replacement 时用占位符', () => {
    const out = redactText('ACME-123456', cfg({ rules: [{ ...rule, replacement: undefined }] }));
    expect(out.text).toBe('<redacted_key>');
  });

  it('用户规则命中更宽的区间时按用户的替换文本来', () => {
    // 用户规则是显式选择：它把整段（含密钥）换成自己的文本，密钥同样消失
    const greedy: RedactionRule = {
      id: 'greedy',
      pattern: `key ${FAKE.openai}`,
      flags: 'g',
      replacement: '[整段]',
      enabled: true,
    };
    const out = redactText(`key ${FAKE.openai}`, cfg({ rules: [greedy] }));
    expect(out.text).toBe('[整段]');
    expect(out.text).not.toContain(FAKE.openai);
  });

  it('用户规则没命中时内置权威规则兜底', () => {
    const elsewhere: RedactionRule = {
      id: 'elsewhere',
      pattern: 'ACME-[0-9]{6}',
      flags: 'g',
      replacement: '[ACME]',
      enabled: true,
    };
    const out = redactText(`工单 ACME-123456，密钥 ${FAKE.openai}`, cfg({ rules: [elsewhere] }));
    expect(out.text).toBe('工单 [ACME]，密钥 <redacted_key>');
    expect(out.replaced).toBe(2);
  });

  it('flags 白名单之外的标志被拒', () => {
    expect(() => validateRedactionRule({ id: 'x', pattern: 'a', flags: 'gy' })).toThrowError(
      /flags/,
    );
  });

  it('坏正则保存时报错并说清是哪条', () => {
    expect(() => validateRedactionRule({ id: 'bad', pattern: '(', flags: 'g' })).toThrowError(
      /规则 bad 的正则编译失败/,
    );
  });

  it('缺 id / 缺 pattern 被拒', () => {
    expect(() => validateRedactionRule({ pattern: 'a' })).toThrowError(/缺少 id/);
    expect(() => validateRedactionRule({ id: 'a' })).toThrowError(/缺少 pattern/);
  });

  it('默认 enabled 为 true，note 可省', () => {
    const r = validateRedactionRule({ id: 'a', pattern: 'x' });
    expect(r).toEqual({ id: 'a', pattern: 'x', flags: 'g', enabled: true });
  });

  it('整组校验保持顺序', () => {
    expect(validateRedactionRules([rule, { ...rule, id: 'r2' }]).map((r) => r.id)).toEqual([
      'r1',
      'r2',
    ]);
  });
});

describe('内置权威规则', () => {
  it('都标了 builtin，且 id 稳定', () => {
    for (const r of BUILTIN_REDACTION_RULES) {
      expect(r.builtin).toBe(true);
      expect(r.id.startsWith('builtin:')).toBe(true);
    }
  });

  it('数据形态规则与判据函数互不打架', () => {
    // 无前缀的长 base62 由判据函数二次确认，因此纯小写十六进制不会被数据规则误伤
    const text = `指纹 a1b2c3d4e5f60718293a4b5c6d7e8f90 与密钥 ${FAKE.opaque}`;
    const out = redactText(text, cfg());
    expect(out.text).toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(out.text).not.toContain(FAKE.opaque);
    expect(out.replaced).toBe(1);
  });
});
