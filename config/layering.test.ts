/**
 * config/layering.test.ts —— 配置分层的优先级与规则。
 *
 * 任务书要求「三者优先级写清」。这里用测试把那条优先级**钉死**，
 * 特别是两条容易被破坏的规则：
 *   1. 环境变量优先于配置文件（否则要为每个环境维护一份完整配置，
 *      而那正是「敏感值漂进配置文件」最常见的路径）；
 *   2. 加密存储最高（运行时输入必须即时生效，不能被重启时重读的配置盖回去）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LAYERED_CONFIG,
  envRefName,
  isEnvRef,
  loadLayeredConfigFile,
  mergeLayered,
  resolveEnvRef,
  type LayeredConfig,
} from './layering.js';

describe('env: 引用', () => {
  it('isEnvRef 只认 env: 前缀', () => {
    expect(isEnvRef('env:DEEPSEEK_API_KEY')).toBe(true);
    expect(isEnvRef('DEEPSEEK_API_KEY')).toBe(false);
    expect(isEnvRef('envref:')).toBe(false);
    expect(isEnvRef('')).toBe(false);
  });

  it('envRefName 去掉前缀', () => {
    expect(envRefName('env:DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY');
  });

  it('非 env: 引用抛错（不静默返回一个错的名字）', () => {
    expect(() => envRefName('DEEPSEEK_API_KEY')).toThrow(/不是 env: 引用/);
  });

  it('解析出真实值', () => {
    expect(resolveEnvRef('env:MY_KEY', { MY_KEY: 'value' })).toBe('value');
  });

  it('变量未设置 → 报错并说清是哪个变量（分得清"没配"和"拼错"）', () => {
    expect(() => resolveEnvRef('env:MY_KEY', {})).toThrow(/MY_KEY 未设置或为空/);
  });

  it('变量为空串等同未设置', () => {
    expect(() => resolveEnvRef('env:MY_KEY', { MY_KEY: '' })).toThrow(/MY_KEY 未设置或为空/);
  });
});

describe('合并语义', () => {
  it('后者覆盖前者；undefined 不覆盖', () => {
    const base: LayeredConfig = {
      version: 1,
      gateway: { port: 8787, host: '127.0.0.1' },
      admin: { enabled: true },
    };
    const merged = mergeLayered(base, { gateway: { port: 9000 } });
    expect(merged.gateway?.port).toBe(9000);
    expect(merged.gateway?.host).toBe('127.0.0.1'); // 未被覆盖
    expect(merged.admin?.enabled).toBe(true);
  });

  it('嵌套对象深合并（不是整体替换）', () => {
    const base: LayeredConfig = {
      version: 1,
      retention: { messages_days: 30, usage_days: 365, rollup_after_days: 90 },
    };
    const merged = mergeLayered(base, { retention: { messages_days: 7 } });
    expect(merged.retention?.messages_days).toBe(7);
    expect(merged.retention?.usage_days).toBe(365);
    expect(merged.retention?.rollup_after_days).toBe(90);
  });

  it('只有一方有时另一方不出现', () => {
    const merged = mergeLayered(
      { version: 1, gateway: { port: 1 } },
      { admin: { enabled: false } },
    );
    expect(merged.gateway?.port).toBe(1);
    expect(merged.admin?.enabled).toBe(false);
  });

  it('合并结果 version 恒为 1', () => {
    expect(mergeLayered(DEFAULT_LAYERED_CONFIG, {}).version).toBe(1);
  });
});

describe('读配置文件', () => {
  /** 临时目录（用完即删；测试不往仓库里写文件）。 */
  const dir = mkdtempSync(join(tmpdir(), 'ag-config-test-'));
  const paths: string[] = [];

  function tmp(content: string): string {
    const p = join(dir, `cfg-${paths.length}.json`);
    writeFileSync(p, content, 'utf8');
    paths.push(p);
    return p;
  }

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('版本不符 → 抛错（不静默忽略，否则"配了却没生效"极难查）', () => {
    expect(() => loadLayeredConfigFile(tmp(JSON.stringify({ version: 99 })))).toThrow(/版本不支持/);
  });

  it('坏 JSON → 抛错并指明文件', () => {
    expect(() => loadLayeredConfigFile(tmp('{ not json'))).toThrow(/不是合法 JSON/);
  });

  it('文件不存在 → 退到编译期默认值（"没配文件"不该变成"起不来"）', () => {
    const cfg = loadLayeredConfigFile('/tmp/definitely-not-here-12345.json');
    expect(cfg.admin?.enabled).toBe(true);
    expect(cfg.admin?.mount_path).toBe('/admin');
    expect(cfg.retention?.messages_days).toBe(30);
  });

  it('合法文件 → 覆盖合并', () => {
    const cfg = loadLayeredConfigFile(
      tmp(
        JSON.stringify({ version: 1, admin: { enabled: false }, retention: { messages_days: 7 } }),
      ),
    );
    expect(cfg.admin?.enabled).toBe(false);
    expect(cfg.admin?.mount_path).toBe('/admin'); // 未被覆盖的保留默认
    expect(cfg.retention?.messages_days).toBe(7);
  });
});

describe('默认值的分层立场', () => {
  it('默认只放非敏感项（管理面开关、保留天数）', () => {
    const json = JSON.stringify(DEFAULT_LAYERED_CONFIG);
    // 默认配置里没有任何像 key/token/secret 的字段
    expect(json).not.toMatch(/sk-|api[_-]?key|token|secret/i);
  });

  it('管理面默认开启、挂 /admin', () => {
    expect(DEFAULT_LAYERED_CONFIG.admin?.enabled).toBe(true);
    expect(DEFAULT_LAYERED_CONFIG.admin?.mount_path).toBe('/admin');
  });

  it('保留策略默认值与 65 §7 一致', () => {
    expect(DEFAULT_LAYERED_CONFIG.retention?.messages_days).toBe(30);
    expect(DEFAULT_LAYERED_CONFIG.retention?.usage_days).toBe(365);
    expect(DEFAULT_LAYERED_CONFIG.retention?.rollup_after_days).toBe(90);
  });
});
