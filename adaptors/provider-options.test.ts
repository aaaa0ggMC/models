import { describe, expect, it } from 'vitest';
import type { FormatId, RequestContext } from '../ir/index.js';
import { OpenAIChatCodec } from './openai-chat/index.js';
import { OpenAIResponsesCodec } from './openai-responses/index.js';
import { AnthropicMessagesCodec } from './anthropic-messages/index.js';
import { GeminiGenerateContentCodec } from './gemini-generate-content/index.js';

const fixedClock = { now: () => 1700000000000 };

function makeCtx(sourceFormat: FormatId): RequestContext {
  const warnings: string[] = [];
  return {
    request_id: 'req_provider_opts_1',
    started_at: fixedClock.now(),
    deadline: fixedClock.now() + 300_000,
    client_format: sourceFormat,
    client_raw_headers: {},
    auth: { key_id: 'test-key' },
    provider_format: sourceFormat,
    fast_path: false,
    state: {},
    metrics: [],
    disableFastPath: () => {},
    warn: (w: string) => warnings.push(w),
    remainingMs: () => 300_000,
  };
}

describe('跨格式厂商专有参数（ag_provider_options / safety_settings）', () => {
  const openaiChat = new OpenAIChatCodec({ clock: fixedClock });
  const openaiResponses = new OpenAIResponsesCodec({ clock: fixedClock });
  const anthropic = new AnthropicMessagesCodec({ clock: fixedClock });
  const gemini = new GeminiGenerateContentCodec({ clock: fixedClock });

  it('OpenAI Chat 顶层 safety_settings（OpenAI SDK extra_body 展开形态）→ Gemini safetySettings', () => {
    const ctx = makeCtx('openai.chat');
    const canonical = openaiChat.decode(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.4,
        top_k: 32,
        safety_settings: [
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        ],
      },
      ctx,
    );

    const encoded = gemini.encode(canonical, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['safetySettings']).toEqual([
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    ]);
    expect(body['generationConfig']).toEqual({
      temperature: 0.4,
      topK: 32,
    });
  });

  it('OpenAI Chat 嵌套 extra_body.safetySettings + ag_provider_options.google（别名归一化到 gemini）→ Gemini', () => {
    const ctx = makeCtx('openai.chat');
    const canonical = openaiChat.decode(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'describe' }],
        temperature: 0.2,
        extra_body: {
          safetySettings: [
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
          ],
          ag_provider_options: {
            google: {
              cachedContent: 'cachedContents/demo-123',
              generationConfig: {
                mediaResolution: 'MEDIA_RESOLUTION_HIGH',
              },
            },
          },
        },
      },
      ctx,
    );

    const encoded = gemini.encode(canonical, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['cachedContent']).toBe('cachedContents/demo-123');
    expect(body['safetySettings']).toEqual([
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ]);
    // generationConfig 做浅合并，不覆盖原有 temperature
    expect(body['generationConfig']).toEqual({
      temperature: 0.2,
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    });
  });

  it('OpenAI Responses → Anthropic Messages 透传 ag_provider_options.anthropic', () => {
    const ctx = makeCtx('openai.responses');
    const canonical = openaiResponses.decode(
      {
        model: 'claude-sonnet-4-5',
        input: 'hello',
        ag_provider_options: {
          anthropic: {
            container: 'cntr_012345',
            output_config: { effort: 'high' },
          },
        },
      },
      ctx,
    );

    const encoded = anthropic.encode(canonical, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['container']).toBe('cntr_012345');
    expect(body['output_config']).toEqual({ effort: 'high' });
  });

  it('目标厂商不匹配时隔离不透传，并记录 native_options_ignored:<vendor> 告警', () => {
    const ctx = makeCtx('openai.chat');
    const canonical = openaiChat.decode(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        ag_provider_options: {
          gemini: {
            cachedContent: 'cachedContents/should-not-leak',
          },
        },
      },
      ctx,
    );

    const encoded = openaiChat.encode(canonical, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['cachedContent']).toBeUndefined();
    expect(encoded.warnings).toContain('native_options_ignored:gemini');
    expect(encoded.dropped).toContain('params.native.gemini');
  });

  it('受保护的结构键（contents / messages）不会被 ag_provider_options 覆盖', () => {
    const ctx = makeCtx('openai.chat');
    const canonical = openaiChat.decode(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'real prompt' }],
        ag_provider_options: {
          gemini: {
            contents: [{ role: 'user', parts: [{ text: 'hijacked' }] }],
            labels: { env: 'prod' },
          },
        },
      },
      ctx,
    );

    const encoded = gemini.encode(canonical, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['labels']).toEqual({ env: 'prod' });
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'real prompt' }] }]);
  });

  it('OpenAI Chat / Responses 接受 deepseek 命名空间扩展参数', () => {
    const ctx = makeCtx('anthropic.messages');
    const canonical = anthropic.decode(
      {
        model: 'deepseek-chat',
        max_tokens: 512,
        messages: [{ role: 'user', content: 'hi' }],
        ag_provider_options: {
          deepseek: {
            safety_check: { level: 'strict' },
          },
        },
      },
      ctx,
    );

    const encoded = openaiResponses.encode(canonical, ctx);
    const body = encoded.body as Record<string, unknown>;
    expect(body['safety_check']).toEqual({ level: 'strict' });
  });

  it('同格式透传时不把 ag_provider_options / safety_settings 泄漏到上游请求体', () => {
    const oaiCtx = makeCtx('openai.chat');
    const oaiCanonical = openaiChat.decode(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        ag_provider_options: { openai: { store: true } },
        extra_body: {
          ag_provider_options: { gemini: { labels: { a: '1' } } },
          custom_keep: 'yes',
        },
      },
      oaiCtx,
    );
    const oaiBody = openaiChat.encode(oaiCanonical, oaiCtx).body as Record<string, unknown>;
    expect(oaiBody['store']).toBe(true);
    expect(oaiBody['ag_provider_options']).toBeUndefined();
    expect(oaiBody['extra_body']).toEqual({ custom_keep: 'yes' });

    const gemCtx = makeCtx('gemini.generateContent');
    const gemCanonical = gemini.decode(
      {
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        ag_provider_options: { gemini: { labels: { env: 'test' } } },
      },
      gemCtx,
    );
    const gemBody = gemini.encode(gemCanonical, gemCtx).body as Record<string, unknown>;
    expect(gemBody['labels']).toEqual({ env: 'test' });
    expect(gemBody['ag_provider_options']).toBeUndefined();
  });
});
