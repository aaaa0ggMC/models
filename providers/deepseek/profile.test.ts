/**
 * providers/deepseek/profile.test.ts —— DeepSeek provider profile 的单元测试。
 *
 * 覆盖四类 provider 专有知识（全部以官方文档 2026-11-14 核实口径为准）：
 *   1. usage 归一：顶层 prompt_cache_hit_tokens / prompt_cache_miss_tokens → canonical；
 *   2. thinking 开关：enabled/disabled 显式化 + effort 归一表；
 *   3. builtin tool 双向映射：deepseek_web_search ↔ web_search、deepseek_read_url ↔ url_context；
 *   4. 端点路径 / 能力矩阵 / 路由别名的登记正确性。
 *
 * 夹具口径来自官方文档的 verbatim 示例（api-docs.deepseek.com/api/create-chat-completion
 * 的 usage 示例），全部为假数据，无真实凭据。
 */

import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_ACCESS_PATHS,
  DEEPSEEK_ANTHROPIC_MESSAGES_PATH,
  DEEPSEEK_OPENAI_CHAT_PATH,
  createDeepSeekProfile,
  deepseekCapabilities,
  deepseekOpenAiUsageFromRaw,
  deepseekRouteAliases,
  deepseekThinkingWire,
  normalizeDeepSeekEffort,
} from './profile.js';
import { DEFAULT_ACCESS_PATHS } from '../../credentials/resolver.js';
import { capabilityKey } from '../../ir/index.js';

const profile = createDeepSeekProfile();

describe('access path 登记', () => {
  it('DEFAULT_ACCESS_PATHS 包含 DeepSeek 两个 dialect 且格式正确', () => {
    const byId = new Map(DEFAULT_ACCESS_PATHS.map((p) => [p.id, p]));
    const openaiChat = byId.get('deepseek.openai-chat');
    const anthropicMessages = byId.get('deepseek.anthropic-messages');
    expect(openaiChat?.format).toBe('openai.chat');
    expect(anthropicMessages?.format).toBe('anthropic.messages');
    expect(openaiChat?.requires_credential).toBe(true);
    expect(anthropicMessages?.requires_credential).toBe(true);
    // 两条 path 都在同一个模型命名空间下（同一账号同一套计费）
    expect(openaiChat?.model_namespaces).toEqual(['deepseek']);
    expect(anthropicMessages?.model_namespaces).toEqual(['deepseek']);
  });

  it('profile 声明的 accessPaths 与常量一致', () => {
    expect(profile.accessPaths).toEqual(['deepseek.openai-chat', 'deepseek.anthropic-messages']);
    expect(profile.id).toBe('deepseek');
  });
});

describe('端点路径（provider 专有，与 OpenAI 本家不同）', () => {
  it('OpenAI 方言是 /chat/completions——没有 /v1 前缀', () => {
    expect(DEEPSEEK_OPENAI_CHAT_PATH).toBe('/chat/completions');
    expect(profile.endpointPath?.('deepseek.openai-chat')).toBe('/chat/completions');
  });

  it('Anthropic 方言是 /anthropic/v1/messages', () => {
    expect(DEEPSEEK_ANTHROPIC_MESSAGES_PATH).toBe('/anthropic/v1/messages');
    expect(profile.endpointPath?.('deepseek.anthropic-messages')).toBe('/anthropic/v1/messages');
  });

  it('不覆盖其它 access path（返回 undefined = 用 codec 默认路径）', () => {
    expect(profile.endpointPath?.('openai')).toBeUndefined();
    expect(profile.endpointPath?.('anthropic')).toBeUndefined();
  });
});

describe('usage 归一：DeepSeek 顶层缓存字段 → canonical', () => {
  it('官方文档 verbatim 示例：hit/miss 顶层字段', () => {
    // https://api-docs.deepseek.com/api/create-chat-completion 的 usage 示例原文
    const raw = {
      prompt_tokens: 7,
      completion_tokens: 11,
      total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 7,
    };
    const tokens = deepseekOpenAiUsageFromRaw(raw);
    expect(tokens).toEqual({
      input_tokens: 7,
      output_tokens: 11,
      total_tokens: 18,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      details: { prompt_cache_miss_tokens: 7 },
    });
  });

  it('缓存命中：prompt_cache_hit_tokens → cache_read_tokens；miss 进 details（canonical 无该槽位）', () => {
    const tokens = deepseekOpenAiUsageFromRaw({
      prompt_tokens: 1024,
      completion_tokens: 64,
      total_tokens: 1088,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 124,
      completion_tokens_details: { reasoning_tokens: 40 },
    });
    expect(tokens?.cache_read_tokens).toBe(900);
    expect(tokens?.input_tokens).toBe(1024); // I1：input 记全量（含命中部分），不另加
    expect(tokens?.reasoning_tokens).toBe(40);
    expect(tokens?.details).toEqual({ prompt_cache_miss_tokens: 124 });
    // DeepSeek 缓存全自动、无显式写入计费 → cache_write 恒 0
    expect(tokens?.cache_write_tokens).toBe(0);
  });

  it('prompt_tokens_details.cached_tokens 回落（两个字段 DeepSeek 都发，取其一）', () => {
    const tokens = deepseekOpenAiUsageFromRaw({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 6 },
    });
    expect(tokens?.cache_read_tokens).toBe(6);
    expect(tokens?.details).toBeUndefined();
  });

  it('safety_tokens 是 DeepSeek 扩展且已含在 completion_tokens 里 → 只进 details', () => {
    const tokens = deepseekOpenAiUsageFromRaw({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens_details: { reasoning_tokens: 5, safety_tokens: 3 },
    });
    expect(tokens?.output_tokens).toBe(20); // 不把 safety_tokens 加进 output（双算）
    expect(tokens?.details).toEqual({ prompt_cache_miss_tokens: 10, safety_tokens: 3 });
  });

  it('一个 usage 字段都不认识 → undefined（不猜、不造 0）', () => {
    expect(deepseekOpenAiUsageFromRaw({ something_else: 1 })).toBeUndefined();
  });

  it('profile.usageFromRaw 对 Anthropic 形态不干预（交给 anthropic codec）', () => {
    const anthropicShaped = {
      input_tokens: 2912,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 256,
      output_tokens: 52,
    };
    expect(profile.usageFromRaw?.(anthropicShaped)).toBeUndefined();
  });

  it('profile.usageFromRaw 对 OpenAI 形态生效', () => {
    const tokens = profile.usageFromRaw?.({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
    });
    expect(tokens?.cache_read_tokens).toBe(80);
    expect(tokens?.input_tokens).toBe(100);
  });
});

describe('thinking 开关：省略即默认开，必须显式表达「关」', () => {
  it('enabled → thinking:{type:enabled}', () => {
    expect(deepseekThinkingWire({ enabled: true })).toEqual({ thinking: { type: 'enabled' } });
  });

  it('disabled → thinking:{type:disabled}（不能省略，否则上游默认开推理）', () => {
    expect(deepseekThinkingWire({ enabled: false })).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('effort 按官方归一表映射（minimal→low、medium/xhigh→high、max→max）', () => {
    expect(deepseekThinkingWire({ enabled: true, effort: 'minimal' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    });
    expect(deepseekThinkingWire({ enabled: true, effort: 'medium' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(deepseekThinkingWire({ enabled: true, effort: 'xhigh' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(deepseekThinkingWire({ enabled: true, effort: 'max' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
  });

  it('effort=none = 关推理：只发 disabled，不发 reasoning_effort', () => {
    const wire = deepseekThinkingWire({ enabled: true, effort: 'none' });
    expect(wire).toEqual({ thinking: { type: 'disabled' } });
  });

  it('normalizeDeepSeekEffort 全表', () => {
    expect(normalizeDeepSeekEffort('minimal')).toBe('low');
    expect(normalizeDeepSeekEffort('low')).toBe('low');
    expect(normalizeDeepSeekEffort('medium')).toBe('high');
    expect(normalizeDeepSeekEffort('high')).toBe('high');
    expect(normalizeDeepSeekEffort('xhigh')).toBe('high');
    expect(normalizeDeepSeekEffort('max')).toBe('max');
    expect(normalizeDeepSeekEffort('none')).toBeUndefined();
    expect(normalizeDeepSeekEffort(undefined)).toBeUndefined();
  });
});

describe('builtin tool 双向映射（全家桶服务端工具 ↔ canonical 稳定名）', () => {
  it('decode：deepseek_web_search → web_search；deepseek_read_url → url_context', () => {
    expect(profile.builtinToolCanonicalName?.('deepseek_web_search')).toBe('web_search');
    expect(profile.builtinToolCanonicalName?.('deepseek_read_url')).toBe('url_context');
  });

  it('decode：认不出的类型返回 undefined（不猜）', () => {
    expect(profile.builtinToolCanonicalName?.('web_search_20250305')).toBeUndefined();
    expect(profile.builtinToolCanonicalName?.('some_future_tool')).toBeUndefined();
  });

  it('encode：Chat Completions 面只给 type', () => {
    expect(profile.builtinToolWire?.('web_search', 'openai.chat')).toEqual({
      type: 'deepseek_web_search',
    });
    expect(profile.builtinToolWire?.('url_context', 'openai.chat')).toEqual({
      type: 'deepseek_read_url',
    });
  });

  it('encode：Messages 面 name 必填且等于 type 串', () => {
    expect(profile.builtinToolWire?.('web_search', 'anthropic.messages')).toEqual({
      type: 'deepseek_web_search',
      name: 'deepseek_web_search',
    });
  });

  it('encode：canonical 有而 DeepSeek 无原生的名 → undefined（调用方丢弃 + 告警）', () => {
    expect(profile.builtinToolWire?.('code_interpreter', 'openai.chat')).toBeUndefined();
    expect(profile.builtinToolWire?.('file_search', 'anthropic.messages')).toBeUndefined();
  });

  it('双向闭合：encode(decode(x)) === x', () => {
    for (const vendorType of ['deepseek_web_search', 'deepseek_read_url']) {
      const canonical = profile.builtinToolCanonicalName?.(vendorType);
      expect(canonical).toBeDefined();
      const wire = profile.builtinToolWire?.(canonical!, 'anthropic.messages');
      expect(wire?.type).toBe(vendorType);
    }
  });
});

describe('能力矩阵（键 = (access_path, model, modality)）', () => {
  const entries = deepseekCapabilities();

  it('2 模型 × 2 dialect = 4 条，全部 implemented + contract_tested', () => {
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      expect(e.status).toBe('implemented');
      expect(e.contract_tested).toBe(true);
      expect(e.modality).toBe('chat');
      expect(e.streaming?.mode).toBe('sse');
      expect(e.usage_source).toBe('provider');
    }
  });

  it('键与格式正确', () => {
    const keys = entries.map((e) => capabilityKey(e.access_path, e.model, e.modality));
    expect(keys).toContain('deepseek.openai-chat/deepseek-flash/chat');
    expect(keys).toContain('deepseek.openai-chat/deepseek-v4-pro/chat');
    expect(keys).toContain('deepseek.anthropic-messages/deepseek-flash/chat');
    expect(keys).toContain('deepseek.anthropic-messages/deepseek-v4-pro/chat');
    const flash = entries.find(
      (e) => e.access_path === 'deepseek.openai-chat' && e.model === 'deepseek-flash',
    );
    expect(flash?.format).toBe('openai.chat');
    // v4-pro 不支持视觉：差异必须写进 quirks（CapabilityEntry 没有输入模态字段）
    const v4pro = entries.find(
      (e) => e.access_path === 'deepseek.openai-chat' && e.model === 'deepseek-v4-pro',
    );
    expect(v4pro?.quirks?.join(' ')).toContain('不支持图像');
    expect(flash?.quirks?.join(' ')).toContain('支持图像输入');
  });

  it('OpenAI 方言登记 DeepSeek 不支持的 canonical 字段', () => {
    const flash = entries.find(
      (e) => e.access_path === 'deepseek.openai-chat' && e.model === 'deepseek-flash',
    );
    expect(flash?.unsupported_fields).toContain('params.response_format.json_schema');
    expect(flash?.unsupported_fields).toContain('params.frequency_penalty');
    expect(flash?.unsupported_fields).toContain('params.presence_penalty');
    expect(flash?.unsupported_fields).toContain('params.user');
  });

  it('Anthropic 方言登记被忽略/不支持的字段', () => {
    const flash = entries.find(
      (e) => e.access_path === 'deepseek.anthropic-messages' && e.model === 'deepseek-flash',
    );
    expect(flash?.unsupported_fields).toContain('cache_control');
    expect(flash?.unsupported_fields).toContain('parts.search_result');
    expect(flash?.unsupported_fields).toContain('parts.redacted_thinking');
  });
});

describe('路由别名', () => {
  const aliases = deepseekRouteAliases();

  it('OpenAI 方言与 Anthropic 方言各两个别名', () => {
    expect(Object.keys(aliases).sort()).toEqual([
      'deepseek-flash',
      'deepseek-flash-messages',
      'deepseek-v4-pro',
      'deepseek-v4-pro-messages',
    ]);
    expect(aliases['deepseek-flash']?.targets[0]).toEqual({
      access_path: 'deepseek.openai-chat',
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
    expect(aliases['deepseek-flash-messages']?.targets[0]).toEqual({
      access_path: 'deepseek.anthropic-messages',
      provider: 'deepseek',
      model: 'deepseek-flash',
    });
  });

  it('1M 上下文登记进 max_context_tokens', () => {
    expect(aliases['deepseek-v4-pro']?.max_context_tokens).toBe(1_048_576);
  });

  it('不登记已退役的 deepseek-chat / deepseek-reasoner', () => {
    expect(Object.keys(aliases)).not.toContain('deepseek-chat');
    expect(Object.keys(aliases)).not.toContain('deepseek-reasoner');
  });
});

describe('access path 常量与 profile 的自洽', () => {
  it('DEEPSEEK_ACCESS_PATHS 的值与 credentials 侧登记一致', () => {
    const ids = DEFAULT_ACCESS_PATHS.map((p) => p.id);
    expect(ids).toContain(DEEPSEEK_ACCESS_PATHS.openaiChat);
    expect(ids).toContain(DEEPSEEK_ACCESS_PATHS.anthropicMessages);
    expect(DEEPSEEK_ACCESS_PATHS.openaiChat).toBe('deepseek.openai-chat');
    expect(DEEPSEEK_ACCESS_PATHS.anthropicMessages).toBe('deepseek.anthropic-messages');
  });
});
