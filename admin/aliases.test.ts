/**
 * admin/aliases.test.ts —— 别名解析规则与优先级。
 *
 * 任务书明确要求：「解析优先级（显式别名 > 前缀规则 > 原样 model id）要写清
 * **并有测试**」。本文件就是那份测试——每一条优先级断言都对应一个
 * 「如果顺序反了会静默出错」的真实场景。
 */

import { describe, expect, it } from 'vitest';
import {
  DefaultAliasResolver,
  defaultAliasRules,
  matchPrefix,
  providerFromAccessPath,
  validateAliasRule,
  validateAliasRuleSet,
  type AliasCapabilityLookup,
  type AliasRule,
} from './aliases.js';

/** 假的能力矩阵：passthrough 需要它判断 model 是否真实存在。 */
const CAPS: AliasCapabilityLookup = {
  list: () => [
    { access_path: 'deepseek.openai-chat', model: 'deepseek-v4-pro', provider: 'deepseek' },
    { access_path: 'openai', model: 'gpt-4o', provider: 'openai' },
    { access_path: 'mock', model: 'gpt-test-1', provider: 'mock' },
  ],
};

function rule(over: Partial<AliasRule> & Pick<AliasRule, 'id' | 'kind' | 'pattern'>): AliasRule {
  return {
    target: { provider: 'p', access_path: 'ap', model: 'm' },
    priority: 100,
    enabled: true,
    ...over,
  };
}

describe('优先级 1：显式别名（exact）最高', () => {
  it('exact 命中时忽略所有 prefix 规则', () => {
    const r = new DefaultAliasResolver(
      [
        rule({ id: 'ns', kind: 'prefix', pattern: 'fast/', target: { provider: 'ns', access_path: 'ns-ap', model: 'ns-m' } }),
        rule({ id: 'exact', kind: 'exact', pattern: 'fast/model', target: { provider: 'ex', access_path: 'ex-ap', model: 'ex-m' } }),
      ],
      CAPS,
    );
    const got = r.resolve('fast/model', 'chat');
    expect(got?.source).toBe('exact');
    expect(got?.rule?.id).toBe('exact');
    expect(got?.target.access_path).toBe('ex-ap');
  });

  it('两条同名 exact 时按 priority 升序取第一个', () => {
    const r = new DefaultAliasResolver(
      [
        rule({ id: 'low', kind: 'exact', pattern: 'x', priority: 200, target: { provider: 'b', access_path: 'b-ap', model: 'b-m' } }),
        rule({ id: 'high', kind: 'exact', pattern: 'x', priority: 10, target: { provider: 'a', access_path: 'a-ap', model: 'a-m' } }),
      ],
      CAPS,
    );
    expect(r.resolve('x', 'chat')?.rule?.id).toBe('high');
  });

  it('disabled 的 exact 不参与解析', () => {
    const r = new DefaultAliasResolver(
      [rule({ id: 'off', kind: 'exact', pattern: 'x', enabled: false })],
      CAPS,
    );
    expect(r.resolve('x', 'chat')).toBeUndefined();
  });
});

describe('优先级 2：前缀规则（prefix）', () => {
  it('命名空间前缀命中', () => {
    const r = new DefaultAliasResolver(
      [rule({ id: 'ns', kind: 'prefix', pattern: 'deepseek/' })],
      CAPS,
    );
    const got = r.resolve('deepseek/v4/pro', 'chat');
    expect(got?.source).toBe('prefix');
    expect(got?.rule?.id).toBe('ns');
  });

  it('**最长前缀优先**（短规则先命中会把子路径错误归类）', () => {
    const r = new DefaultAliasResolver(
      [
        rule({ id: 'short', kind: 'prefix', pattern: 'deepseek/', target: { provider: 'short', access_path: 'short-ap', model: 'short-m' } }),
        rule({ id: 'long', kind: 'prefix', pattern: 'deepseek/v4/', target: { provider: 'long', access_path: 'long-ap', model: 'long-m' } }),
      ],
      CAPS,
    );
    const got = r.resolve('deepseek/v4/pro', 'chat');
    expect(got?.rule?.id).toBe('long');
    expect(got?.target.access_path).toBe('long-ap');
  });

  it('同长度前缀按 priority 升序', () => {
    const r = new DefaultAliasResolver(
      [
        rule({ id: 'p200', kind: 'prefix', pattern: 'a/', priority: 200, target: { provider: 'b', access_path: 'b-ap', model: 'b-m' } }),
        rule({ id: 'p10', kind: 'prefix', pattern: 'a/', priority: 10, target: { provider: 'a', access_path: 'a-ap', model: 'a-m' } }),
      ],
      CAPS,
    );
    expect(r.resolve('a/x', 'chat')?.rule?.id).toBe('p10');
  });

  it('priority 相同时仍按长度降序（确定性）', () => {
    const r = new DefaultAliasResolver(
      [
        rule({ id: 'short', kind: 'prefix', pattern: 'a/', target: { provider: 'short', access_path: 's-ap', model: 's-m' } }),
        rule({ id: 'long', kind: 'prefix', pattern: 'a/b/', target: { provider: 'long', access_path: 'l-ap', model: 'l-m' } }),
      ],
      CAPS,
    );
    expect(r.resolve('a/b/c', 'chat')?.rule?.id).toBe('long');
  });

  it('disabled 的 prefix 不参与解析', () => {
    const r = new DefaultAliasResolver(
      [rule({ id: 'off', kind: 'prefix', pattern: 'deepseek/', enabled: false })],
      CAPS,
    );
    // deepseek/v4/pro 在能力矩阵里 → passthrough；若 prefix 生效应该是 prefix
    const got = r.resolve('deepseek-v4-pro', 'chat');
    expect(got?.source).toBe('passthrough');
  });
});

describe('优先级 3：passthrough（原样 model id）', () => {
  it('能力矩阵里有的 model 原样放行', () => {
    const r = new DefaultAliasResolver([], CAPS);
    const got = r.resolve('gpt-4o', 'chat');
    expect(got?.source).toBe('passthrough');
    expect(got?.rule).toBeUndefined();
    expect(got?.target).toEqual({ provider: 'openai', access_path: 'openai', model: 'gpt-4o' });
  });

  it('能力矩阵里没有的 model → 解析不了（拼写错误不会被打到上游）', () => {
    const r = new DefaultAliasResolver([], CAPS);
    expect(r.resolve('gpt-4o-typo', 'chat')).toBeUndefined();
  });

  it('空模型名 → 解析不了', () => {
    const r = new DefaultAliasResolver([], CAPS);
    expect(r.resolve('', 'chat')).toBeUndefined();
  });

  it('没有能力矩阵时 passthrough 不可能命中（宁可报错也不瞎猜）', () => {
    const r = new DefaultAliasResolver([]);
    expect(r.resolve('gpt-4o', 'chat')).toBeUndefined();
  });

  it('provider 缺失时从 access_path 推导', () => {
    const caps: AliasCapabilityLookup = {
      list: () => [{ access_path: 'deepseek.openai-chat', model: 'deepseek-flash' }],
    };
    const r = new DefaultAliasResolver([], caps);
    expect(r.resolve('deepseek-flash', 'chat')?.target.provider).toBe('deepseek');
  });
});

describe('三条优先级合在一起的真实场景', () => {
  const rules: AliasRule[] = [
    // 显式别名：把 fast 指到 DeepSeek 快速档
    rule({
      id: 'exact-fast',
      kind: 'exact',
      pattern: 'fast',
      target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash', max_context_tokens: 128_000 },
    }),
    // 命名空间兜底
    rule({
      id: 'ns-deepseek',
      kind: 'prefix',
      pattern: 'deepseek/',
      target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
    }),
  ];
  const r = new DefaultAliasResolver(rules, CAPS);

  it('fast → exact', () => {
    const got = r.resolve('fast', 'chat');
    expect(got?.source).toBe('exact');
    expect(got?.target.model).toBe('deepseek-flash');
    expect(got?.target.max_context_tokens).toBe(128_000);
  });

  it('deepseek/whatever → prefix', () => {
    const got = r.resolve('deepseek/whatever', 'chat');
    expect(got?.source).toBe('prefix');
    expect(got?.target.model).toBe('deepseek-flash');
  });

  it('gpt-4o → passthrough（矩阵里有，无需建别名）', () => {
    expect(r.resolve('gpt-4o', 'chat')?.source).toBe('passthrough');
  });

  it('完全不认识的 → undefined', () => {
    expect(r.resolve('nope-nope', 'chat')).toBeUndefined();
  });
});

describe('matchPrefix', () => {
  it('/ 结尾 = 命名空间前缀', () => {
    expect(matchPrefix('deepseek/', 'deepseek/v4')).toBe(true);
    expect(matchPrefix('deepseek/', 'deepseek')).toBe(false);
    expect(matchPrefix('deepseek/', 'openaix')).toBe(false);
  });

  it('* 结尾 = 通配，但**不吃含 / 的剩余部分**', () => {
    expect(matchPrefix('deepseek*', 'deepseekflash')).toBe(true);
    expect(matchPrefix('deepseek*', 'deepseek-flash')).toBe(true);
    // 关键：* 不跨 /，否则 deepseek* 会吞掉 deepseek/v4/pro
    expect(matchPrefix('deepseek*', 'deepseek/v4/pro')).toBe(false);
  });

  it('其他 = 普通 startsWith', () => {
    expect(matchPrefix('ds', 'dsflash')).toBe(true);
    expect(matchPrefix('ds', 'xds')).toBe(false);
  });

  it('空 pattern 永不命中', () => {
    expect(matchPrefix('', 'anything')).toBe(false);
  });
});

describe('providerFromAccessPath', () => {
  it('带 dialect 的取第一段', () => {
    expect(providerFromAccessPath('deepseek.openai-chat')).toBe('deepseek');
    expect(providerFromAccessPath('a.b.c')).toBe('a');
  });

  it('不带点的原样返回', () => {
    expect(providerFromAccessPath('openai')).toBe('openai');
    expect(providerFromAccessPath('mock')).toBe('mock');
  });
});

describe('规则校验', () => {
  const good: AliasRule = {
    id: 'r1',
    kind: 'exact',
    pattern: 'fast',
    target: { provider: 'deepseek', access_path: 'deepseek.openai-chat', model: 'deepseek-flash' },
    priority: 100,
    enabled: true,
  };

  it('合法规则通过', () => {
    expect(validateAliasRule(good).ok).toBe(true);
  });

  it('exact 里混入 / 或 * 被拒（那会让匹配语义取决于 kind 字段，人看不出来）', () => {
    expect(validateAliasRule({ ...good, pattern: 'a/b' }).ok).toBe(false);
    expect(validateAliasRule({ ...good, pattern: 'a*' }).ok).toBe(false);
  });

  it('前导 / 被拒', () => {
    expect(validateAliasRule({ ...good, kind: 'prefix', pattern: '/deepseek/' }).ok).toBe(false);
  });

  it('target 三要素缺一不可（缺了错误会发生在请求路径而不是配置时）', () => {
    expect(validateAliasRule({ ...good, target: { ...good.target, model: '' } }).ok).toBe(false);
    expect(validateAliasRule({ ...good, target: { ...good.target, access_path: '' } }).ok).toBe(false);
    expect(validateAliasRule({ ...good, target: { ...good.target, provider: '' } }).ok).toBe(false);
  });

  it('prefix 不用 / 或 * 结尾给提示', () => {
    const v = validateAliasRule({ ...good, kind: 'prefix', pattern: 'ds' });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('建议以');
  });

  it('非正 max_context_tokens 被拒', () => {
    expect(
      validateAliasRule({ ...good, target: { ...good.target, max_context_tokens: 0 } }).ok,
    ).toBe(false);
  });

  it('规则表：同 pattern 不同 target 被拒（解析结果不能取决于不可见的排序）', () => {
    const a = rule({ id: 'a', kind: 'prefix', pattern: 'x/' });
    const b = rule({ id: 'b', kind: 'prefix', pattern: 'x/', target: { provider: 'q', access_path: 'q-ap', model: 'q-m' } });
    const v = validateAliasRuleSet([a, b]);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('target 不同');
  });

  it('规则表：同 pattern 同 target 允许（幂等写入）', () => {
    const a = rule({ id: 'a', kind: 'prefix', pattern: 'x/' });
    const b = rule({ id: 'b', kind: 'prefix', pattern: 'x/' });
    expect(validateAliasRuleSet([a, b]).ok).toBe(true);
  });

  it('规则表：disabled 的重复不参与冲突判定', () => {
    const a = rule({ id: 'a', kind: 'prefix', pattern: 'x/' });
    const b = rule({ id: 'b', kind: 'prefix', pattern: 'x/', enabled: false, target: { provider: 'q', access_path: 'q-ap', model: 'q-m' } });
    expect(validateAliasRuleSet([a, b]).ok).toBe(true);
  });
});

describe('规则表热更新', () => {
  it('setRules 整体替换；listRules 返回副本（改返回值不影响内部状态）', () => {
    const r = new DefaultAliasResolver([], CAPS);
    r.setRules([rule({ id: 'a', kind: 'exact', pattern: 'x' })]);
    expect(r.resolve('x', 'chat')?.rule?.id).toBe('a');

    const snapshot = r.listRules();
    snapshot[0]!.pattern = 'HACKED';
    expect(r.resolve('x', 'chat')?.rule?.id).toBe('a');

    r.setRules([]);
    expect(r.resolve('x', 'chat')).toBeUndefined();
  });

  it('构造时传入的数组被复制（外部改数组不影响解析器）', () => {
    const rules = [rule({ id: 'a', kind: 'exact', pattern: 'x' })];
    const r = new DefaultAliasResolver(rules, CAPS);
    rules[0]!.pattern = 'y';
    expect(r.resolve('x', 'chat')?.rule?.id).toBe('a');
  });
});

describe('defaultAliasRules', () => {
  it('默认规则自身合法', () => {
    expect(validateAliasRuleSet(defaultAliasRules()).ok).toBe(true);
  });

  it('默认规则能解析出 DeepSeek 两条方言', () => {
    const r = new DefaultAliasResolver(defaultAliasRules(), CAPS);
    expect(r.resolve('deepseek-flash', 'chat')?.target.access_path).toBe('deepseek.openai-chat');
    expect(r.resolve('deepseek-flash-messages', 'chat')?.target.access_path).toBe(
      'deepseek.anthropic-messages',
    );
    expect(r.resolve('deepseek/v4-pro', 'chat')?.source).toBe('prefix');
  });
});
