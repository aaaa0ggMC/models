/**
 * adaptors/gemini-generate-content/codec.ts —— Google Gemini `generateContent` /
 * `streamGenerateContent` ↔ AG-IR canonical 双向 codec（同时服务入站客户端脸与出站 provider 脸）。
 *
 * 唯一事实来源：
 *   - docs/design/10-canonical-schema.md §4（chat payload）、§6.1（usage 规则）、
 *     §7（raw passthrough 两级）、§9（字段映射表与 finish_reason 归一表）
 *   - docs/design/40-provider-adaptors.md §1.1（Adaptor 接口）、§2.1/§2.2b/§2.2c（Gemini usage I1/I2）、
 *     §7.3（Gemini 专有差异：thoughtSignature / functionCall.id / thinkingConfig）
 *   - docs/design/20-pipeline.md §S1/S4/S6/S8
 *
 * 关键协议细节（逐条落地）：
 *   1. **model 与 stream 在 URL 路径**：`POST /v1beta/models/{model}:generateContent` 与
 *      `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`，不在 JSON 请求体里。
 *      入站从 `ctx.state[CTX_STATE_KEYS.REQUEST_PATH]` 解析（兼容直接单测时从 body 回退）；
 *      出站由 `encode()` 生成对应 `EncodedRequest.path`。
 *   2. **角色与轮次合并**：canonical `assistant` ↔ Gemini `model`；`tool` 折叠为 `user` 的
 *      `functionResponse` part，并合并相邻同角色消息，避免上游拒绝连续 `user` 回合。
 *   3. **functionCall.id & thoughtSignature**：`functionCall.id` 缺失时入口生成干净 id（D7b），
 *      `functionResponse` 优先按 `id`、缺省按函数名 FIFO 回填；`thoughtSignature` 保存在
 *      `ThinkingPart.signature` 与 `ToolUsePart._raw`，多轮工具调用自动回传。
 *   4. **finishReason 归一与反 LiteLLM 教训**：`MALFORMED_FUNCTION_CALL` 映为 `error`（绝不静默
 *      当 `stop`）；含 `functionCall` 且 `finishReason === "STOP"` 归一为 `tool_use`；未命中映为
 *      `other` + `unmapped_finish_reason:<原文>`。
 *   5. **thinkingConfig**：`thinkingBudget` 与 `thinkingLevel` 绝不混传（40 §2.2b）。
 *   6. **usageMetadata I1/I2**：`promptTokenCount` 包含 `cachedContentTokenCount`；按
 *      `prompt + candidates + toolUsePrompt < total` 判断 `candidatesTokenCount` 是否已含
 *      `thoughtsTokenCount`，保证 `output_tokens` 口径与 OpenAI/Anthropic 一致。
 */

import type {
  AudioPart,
  BuiltinTool,
  CanonicalMessage,
  CanonicalRequestEnvelope,
  CanonicalResponseEnvelope,
  CanonicalTool,
  CanonicalUsage,
  ChatParams,
  ChatPayload,
  ChatResponsePayload,
  Clock,
  ConversionDiagnostic,
  DocumentPart,
  FinishReason,
  FormatId,
  FunctionTool,
  ImagePart,
  JSONSchema,
  Logger,
  MediaRef,
  ModalityKind,
  NormalizedFinishReason,
  Part,
  RequestContext,
  ResponseFormat,
  SafetySetting,
  StreamFrame,
  StreamPart,
  SystemBlock,
  TextPart,
  ThinkingConfig,
  ThinkingPart,
  TokenUsage,
  ToolChoice,
  ToolResultPart,
  ToolUsePart,
  UnknownPart,
  VideoPart,
} from '../../ir/index.js';
import { CTX_STATE_KEYS, IR_VERSION, emptyUsage } from '../../ir/index.js';
import type { Adaptor, AdaptorMeta, EncodedRequest, RequestEnvelopeShallow } from '../types.js';
import type { ProviderProfileRegistry } from '../../di/ports.js';
import {
  applyClientProviderOptions,
  applyNativeVendorOptions,
  filterUnmappedForPassthrough,
  parseSafetySettings,
} from '../provider-options.js';

const FORMAT: FormatId = 'gemini.generateContent';
const MODALITY: ModalityKind = 'chat';
const ENCODE_STREAM_STATE_KEY = 'gemini_encode_stream_state';

/** 顶层已建模的 Gemini 请求字段（其余一律进 raw.unmapped）。 */
const KNOWN_REQUEST_KEYS = new Set([
  'contents',
  'systemInstruction',
  'system_instruction',
  'tools',
  'toolConfig',
  'tool_config',
  'generationConfig',
  'generation_config',
  'safetySettings',
  'safety_settings',
  'cachedContent',
  'cached_content',
  'model',
  'stream',
  'ag_agentic_loop',
]);

/** 顶层已建模的 Gemini 响应字段（其余进 raw.unmapped）。 */
const KNOWN_RESPONSE_KEYS = new Set([
  'candidates',
  'usageMetadata',
  'promptFeedback',
  'modelVersion',
  'responseId',
]);

export interface GeminiGenerateContentCodecDeps {
  clock: Clock;
  logger?: Logger;
  providerProfiles?: ProviderProfileRegistry;
}

/** 产出 Gemini adaptor 元数据（单一来源，供 adaptors/index.ts 注册）。 */
export function geminiGenerateContentAdaptorMeta(): AdaptorMeta {
  return {
    format: FORMAT,
    modality: MODALITY,
    version: '1.0.0',
    fixtures: 'adaptors/fixtures/gemini-generate-content',
    unsupported_fields: [
      'params.parallel_tool_calls',
      'params.user',
      'params.metadata',
      'params.service_tier',
    ],
    quirks: [
      'model 与 stream 放在 URL 路径（/v1beta/models/{model}:generateContent / :streamGenerateContent?alt=sse）而非请求体',
      '角色使用 user / model（assistant ↔ model，tool 结果折叠进 user 的 functionResponse）',
      'functionCall.id 可选，缺失时入口生成干净 id（D7b），functionResponse 按 id/name 回填',
      'thoughtSignature 挂在 ThinkingPart.signature 与 ToolUsePart._raw，多轮回环自动回传',
      'thinkingBudget 与 thinkingLevel 按目标模型二选一，不混传',
      'usageMetadata.promptTokenCount 包含 cachedContentTokenCount；I2 按 totalTokenCount 反推 candidates 是否含 thoughts',
    ],
    status: 'implemented',
    supports_lazy_decode: true,
  };
}

/** 从 Gemini 请求路径解析 model 与 stream 标志。 */
export function parseGeminiPath(path: string | undefined): {
  model: string;
  stream: boolean;
} | undefined {
  if (typeof path !== 'string' || path === '') return undefined;
  const withoutQuery = path.split('?', 1)[0] ?? path;
  const match = /^\/v1(?:beta)?\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(
    withoutQuery,
  );
  if (match === null) return undefined;
  const rawModel = match[1] ?? '';
  let decodedModel: string;
  try {
    decodedModel = decodeURIComponent(rawModel);
  } catch {
    decodedModel = rawModel;
  }
  return {
    model: decodedModel.replace(/^models\//, ''),
    stream: match[2] === 'streamGenerateContent',
  };
}

/** 构造 Gemini 上游请求路径（含 `?alt=sse`）。 */
export function buildGeminiPath(model: string, stream: boolean, profilePath?: string): string {
  const cleanModel = model.replace(/^models\//, '');
  const encodedModel = encodeURIComponent(cleanModel);
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  if (profilePath !== undefined && profilePath !== '') {
    if (profilePath.includes('{model}')) {
      return profilePath.replace(/\{model\}/g, encodedModel);
    }
    return profilePath;
  }
  return `/v1beta/models/${encodedModel}:${action}`;
}

interface GeminiStreamEncodeState {
  model: string;
  openTools: Map<number, { id: string; name: string; argsText: string }>;
  lastUsage?: CanonicalUsage;
  finishEmitted: boolean;
}

export class GeminiGenerateContentCodec implements Adaptor {
  readonly format: FormatId = FORMAT;
  readonly modalities: ModalityKind[] = [MODALITY];

  private readonly clock: Clock;
  private readonly providerProfiles?: ProviderProfileRegistry;

  constructor(deps: GeminiGenerateContentCodecDeps) {
    this.clock = deps.clock;
    if (deps.providerProfiles !== undefined) {
      this.providerProfiles = deps.providerProfiles;
    }
  }

  // -------------------------------------------------------------------------
  // 1. S1 惰性解码：decodeEnvelope
  // -------------------------------------------------------------------------

  decodeEnvelope(raw: unknown, ctx: RequestContext): RequestEnvelopeShallow {
    const obj = asRecord(raw) ?? {};
    const pathInfo = parseGeminiPath(asString(ctx.state[CTX_STATE_KEYS.REQUEST_PATH]));
    const model = pathInfo?.model || asString(obj['model'])?.replace(/^models\//, '') || '';
    const stream = pathInfo !== undefined ? pathInfo.stream : obj['stream'] === true;

    const unmapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_REQUEST_KEYS.has(k)) {
        unmapped[k] = v;
      }
    }

    const bytes =
      typeof ctx.request_bytes === 'number'
        ? ctx.request_bytes
        : Buffer.byteLength(JSON.stringify(obj), 'utf8');

    return {
      source_format: FORMAT,
      kind: MODALITY,
      model,
      stream,
      bytes,
      usage_locations: ['usageMetadata'],
      unmapped,
      default_path: buildGeminiPath(model || 'gemini-2.5-flash', stream),
      ...(obj['ag_agentic_loop'] === true ? { gateway_agentic_loop: true } : {}),
    };
  }

  resolveFastPath(
    ctx: RequestContext,
    shallow: RequestEnvelopeShallow | undefined,
  ): string | undefined {
    const model = ctx.route?.model ?? shallow?.model;
    if (model === undefined || model === '') return undefined;
    const accessPath = ctx.route?.access_path;
    const profile =
      accessPath !== undefined ? this.providerProfiles?.forAccessPath(accessPath) : undefined;
    const profileEndpoint =
      accessPath !== undefined ? profile?.endpointPath?.(accessPath) : undefined;
    return buildGeminiPath(model, shallow?.stream === true, profileEndpoint);
  }

  // -------------------------------------------------------------------------
  // 2. 请求解码：wire (Gemini) → canonical
  // -------------------------------------------------------------------------

  decode(raw: unknown, ctx: RequestContext): CanonicalRequestEnvelope {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error('Gemini generateContent 请求体必须是 JSON 对象');
    }

    const pathInfo = parseGeminiPath(asString(ctx.state[CTX_STATE_KEYS.REQUEST_PATH]));
    const model = pathInfo?.model || asString(obj['model'])?.replace(/^models\//, '') || '';
    const streamEnabled = pathInfo !== undefined ? pathInfo.stream : obj['stream'] === true;

    const unmapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_REQUEST_KEYS.has(k)) {
        unmapped[k] = v;
      }
    }

    // systemInstruction
    const sysRaw = obj['systemInstruction'] ?? obj['system_instruction'];
    const cachedContent = asString(obj['cachedContent'] ?? obj['cached_content']);
    const system = decodeSystemInstruction(sysRaw, cachedContent);
    if (cachedContent !== undefined && (system === undefined || system.length === 0)) {
      unmapped['cachedContent'] = cachedContent;
    }

    // contents → messages（追踪 functionCall id 以便无 id 的 functionResponse 按名匹配）
    const pendingCallIdsByName = new Map<string, string[]>();
    let callSeq = 0;
    const nextCallId = (): string => {
      callSeq += 1;
      return `call_gemini_${callSeq}`;
    };

    const contentsRaw = Array.isArray(obj['contents']) ? obj['contents'] : [];
    const messages: CanonicalMessage[] = [];
    for (const item of contentsRaw) {
      const msg = decodeContentItem(item, pendingCallIdsByName, nextCallId);
      if (msg !== undefined) messages.push(msg);
    }

    // tools
    const tools = decodeTools(obj['tools']);

    // toolConfig
    const toolChoice = decodeToolConfig(obj['toolConfig'] ?? obj['tool_config']);

    // generationConfig + safetySettings
    const params = decodeParams(
      obj['generationConfig'] ?? obj['generation_config'],
      obj['safetySettings'] ?? obj['safety_settings'],
      obj,
    );

    const payload: ChatPayload = {
      ...(system !== undefined && system.length > 0 ? { system } : {}),
      messages,
      ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
      ...(params !== undefined && Object.keys(params).length > 0 ? { params } : {}),
    };

    return {
      ir_version: IR_VERSION,
      kind: MODALITY,
      model,
      ...(streamEnabled
        ? {
            stream: {
              enabled: true,
              mode: 'sse',
              include_usage: true,
              native_event_names: true,
              on_mismatch: 'bridge',
            },
          }
        : {}),
      payload,
      source_format: FORMAT,
      raw: {
        source_provider: FORMAT,
        ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
      },
      ...(obj['ag_agentic_loop'] === true ? { gateway: { agentic_loop: true } } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // 3. 请求编码：canonical → wire (Gemini)
  // -------------------------------------------------------------------------

  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest {
    const payload = req.payload as ChatPayload;
    const model = (req.resolved_model ?? req.model).replace(/^models\//, '');
    const streamEnabled = req.stream?.enabled === true;

    const accessPath = ctx.route?.access_path;
    const profile =
      accessPath !== undefined ? this.providerProfiles?.forAccessPath(accessPath) : undefined;
    const profileEndpoint =
      accessPath !== undefined ? profile?.endpointPath?.(accessPath) : undefined;
    const path = buildGeminiPath(model, streamEnabled, profileEndpoint);

    const dropped: string[] = [];
    const warnings: string[] = [];
    const diagnostics: ConversionDiagnostic[] = [];

    const body: Record<string, unknown> = {};

    // 同格式顶层 unmapped 回写
    if (req.source_format === FORMAT && req.raw.unmapped !== undefined) {
      for (const [k, v] of Object.entries(filterUnmappedForPassthrough(req.raw.unmapped))) {
        if (!KNOWN_REQUEST_KEYS.has(k) || k === 'cachedContent') {
          body[k] = v;
        }
      }
    }

    // 收集系统提示（payload.system + messages 中的 system 角色）
    const systemParts: Array<Record<string, unknown>> = [];
    let cachedContentName: string | undefined;
    for (const block of payload.system ?? []) {
      if (block.text !== '') {
        systemParts.push({ text: block.text });
      }
      if (block.cache_control?.cache_name !== undefined && cachedContentName === undefined) {
        cachedContentName = block.cache_control.cache_name;
      }
    }

    // 预扫描所有 tool_use，建立 tool_use_id → name 映射供 functionResponse 使用
    const toolIdToName = new Map<string, string>();
    for (const msg of payload.messages) {
      for (const part of msg.parts) {
        if (part.type === 'tool_use') {
          toolIdToName.set(part.id, part.name);
        }
      }
    }

    // 编码 contents（合并相邻同角色，确保符合 Gemini 交替 user/model 约束）
    const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
    for (const msg of payload.messages) {
      if (msg.role === 'system') {
        for (const p of msg.parts) {
          if (p.type === 'text' && p.text !== '') {
            systemParts.push({ text: p.text });
          }
        }
        continue;
      }

      const geminiRole: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const encodedParts: Array<Record<string, unknown>> = [];

      for (const part of msg.parts) {
        const encoded = encodePart(part, req.source_format === FORMAT, toolIdToName, warnings);
        if (encoded !== undefined) {
          encodedParts.push(encoded);
        }
      }

      if (encodedParts.length === 0) continue;

      const prev = contents[contents.length - 1];
      if (prev !== undefined && prev.role === geminiRole) {
        prev.parts.push(...encodedParts);
      } else {
        contents.push({ role: geminiRole, parts: encodedParts });
      }
    }

    if (systemParts.length > 0) {
      body['systemInstruction'] = { parts: systemParts };
    }
    if (cachedContentName !== undefined) {
      body['cachedContent'] = cachedContentName;
    }
    body['contents'] = contents;

    // tools
    if (payload.tools !== undefined && payload.tools.length > 0) {
      const encodedTools = encodeTools(payload.tools);
      if (encodedTools.length > 0) {
        body['tools'] = encodedTools;
      }
    }

    // toolConfig
    if (payload.tool_choice !== undefined) {
      const toolConfig = encodeToolChoice(payload.tool_choice, warnings);
      if (toolConfig !== undefined) {
        body['toolConfig'] = toolConfig;
      }
    }

    // generationConfig + safetySettings
    if (payload.params !== undefined) {
      const { generationConfig, safetySettings } = encodeParams(
        payload.params,
        model,
        req.source_format,
        dropped,
        warnings,
        diagnostics,
      );
      if (Object.keys(generationConfig).length > 0) {
        body['generationConfig'] = generationConfig;
      }
      if (safetySettings !== undefined && safetySettings.length > 0) {
        body['safetySettings'] = safetySettings;
      } else {
        const geminiNative = payload.params.native?.['gemini'];
        const nativeSafety = parseSafetySettings(
          geminiNative?.['safetySettings'] ?? geminiNative?.['safety_settings'],
        );
        if (nativeSafety !== undefined && nativeSafety.length > 0) {
          body['safetySettings'] = nativeSafety;
        }
      }
      applyNativeVendorOptions({
        native: payload.params.native,
        acceptedVendors: ['gemini'],
        body,
        protectedKeys: new Set(['contents', 'systemInstruction', 'safety_settings', 'safetySettings']),
        mergeObjectKeys: new Set(['generationConfig', 'toolConfig']),
        sourceFormat: req.source_format,
        targetFormat: FORMAT,
        dropped,
        warnings,
        diagnostics,
      });
    }

    return {
      body,
      fast_path: false,
      path,
      ...(dropped.length > 0 ? { dropped } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // 4. 响应解码：wire (Gemini) → canonical
  // -------------------------------------------------------------------------

  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope {
    const obj = asRecord(raw);
    if (obj === undefined) {
      throw new Error('Gemini generateContent 响应体必须是 JSON 对象');
    }

    const warnings: string[] = [];
    const candidates = Array.isArray(obj['candidates']) ? obj['candidates'] : [];
    const firstCandidate = asRecord(candidates[0]);
    const promptFeedback = asRecord(obj['promptFeedback']);

    const parts: Part[] = [];
    let callSeq = 0;
    const nextCallId = (): string => {
      callSeq += 1;
      return `call_gemini_${ctx.request_id}_${callSeq}`;
    };

    const content = asRecord(firstCandidate?.['content']);
    const rawParts = Array.isArray(content?.['parts']) ? content['parts'] : [];
    for (const p of rawParts) {
      const decoded = decodePart(p, new Map(), nextCallId);
      if (decoded !== undefined) {
        parts.push(decoded);
      }
    }

    const hasToolUse = parts.some((p) => p.type === 'tool_use');
    const rawFinish =
      asString(firstCandidate?.['finishReason']) ?? asString(promptFeedback?.['blockReason']);
    const normalized = this.normalizeFinishReason(rawFinish);
    if (
      rawFinish !== undefined &&
      rawFinish !== '' &&
      normalized === 'other' &&
      rawFinish !== 'OTHER' &&
      rawFinish !== 'FINISH_REASON_UNSPECIFIED'
    ) {
      warnings.push(`unmapped_finish_reason:${rawFinish}`);
    }
    const finishReason: FinishReason =
      hasToolUse && (normalized === 'stop' || rawFinish === undefined) ? 'tool_use' : normalized;

    const usage = this.extractUsage(obj);
    if (usage.units.tokens === undefined) {
      warnings.push('usage_missing');
    }

    const modelVersion = asString(obj['modelVersion']) ?? ctx.route?.model;
    const responseId = asString(obj['responseId']);

    const unmapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_RESPONSE_KEYS.has(k)) {
        unmapped[k] = v;
      }
    }

    const nodes: Record<string, unknown> = {};
    if (firstCandidate?.['groundingMetadata'] !== undefined) {
      nodes['groundingMetadata'] = firstCandidate['groundingMetadata'];
    }
    if (firstCandidate?.['safetyRatings'] !== undefined) {
      nodes['safetyRatings'] = firstCandidate['safetyRatings'];
    }
    if (promptFeedback !== undefined) {
      nodes['promptFeedback'] = promptFeedback;
    }

    const payload: ChatResponsePayload = {
      message: {
        role: 'assistant',
        parts,
        ...(responseId !== undefined ? { id: responseId } : {}),
      },
      ...(modelVersion !== undefined ? { model: modelVersion } : {}),
      ...(typeof firstCandidate?.['index'] === 'number'
        ? { index: firstCandidate['index'] }
        : { index: 0 }),
    };

    return {
      ir_version: IR_VERSION,
      kind: MODALITY,
      request_id: ctx.request_id,
      usage,
      finish_reason: finishReason,
      payload,
      warnings,
      raw: {
        source_provider: FORMAT,
        ...(rawFinish !== undefined ? { finish_reason_provider: rawFinish } : {}),
        ...(Object.keys(unmapped).length > 0 ? { unmapped } : {}),
        ...(Object.keys(nodes).length > 0 ? { nodes } : {}),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 5. 响应编码：canonical → wire (Gemini)
  // -------------------------------------------------------------------------

  encodeResponse(res: CanonicalResponseEnvelope, _ctx: RequestContext): unknown {
    const payload = res.payload as ChatResponsePayload;
    const sameFormat = res.raw.source_provider === FORMAT;
    const warnings: string[] = [];

    const parts: Array<Record<string, unknown>> = [];
    for (const part of payload.message.parts) {
      const encoded = encodePart(part, sameFormat, new Map(), warnings);
      if (encoded !== undefined) {
        parts.push(encoded);
      }
    }

    const finishReason = encodeFinishReason(
      res.finish_reason,
      sameFormat ? res.raw.finish_reason_provider : undefined,
    );

    const candidate: Record<string, unknown> = {
      index: payload.index ?? 0,
      content: {
        role: 'model',
        parts,
      },
      finishReason,
    };

    if (sameFormat && res.raw.nodes !== undefined) {
      if (res.raw.nodes['groundingMetadata'] !== undefined) {
        candidate['groundingMetadata'] = res.raw.nodes['groundingMetadata'];
      }
      if (res.raw.nodes['safetyRatings'] !== undefined) {
        candidate['safetyRatings'] = res.raw.nodes['safetyRatings'];
      }
    }

    const out: Record<string, unknown> = {
      ...(sameFormat && res.raw.unmapped !== undefined ? res.raw.unmapped : {}),
      candidates: [candidate],
    };

    const usageMeta = encodeUsageMetadata(res.usage);
    if (usageMeta !== undefined) {
      out['usageMetadata'] = usageMeta;
    }
    if (payload.model !== undefined) {
      out['modelVersion'] = payload.model;
    }
    if (payload.message.id !== undefined) {
      out['responseId'] = payload.message.id;
    }

    return out;
  }

  // -------------------------------------------------------------------------
  // 6. 流式解码：wire (Gemini SSE) → canonical StreamFrame
  // -------------------------------------------------------------------------

  async *decodeStream(
    stream: AsyncIterable<unknown>,
    ctx: RequestContext,
  ): AsyncIterable<StreamFrame> {
    let seq = 0;
    const nextFrame = (
      event: StreamFrame['event'],
      data: StreamFrame['data'],
    ): StreamFrame => ({
      event,
      seq: seq++,
      request_id: ctx.request_id,
      kind: MODALITY,
      data,
      ts: this.clock.now(),
    });

    let started = false;
    let sawToolUse = false;
    let callSeq = 0;
    let partIndex = -1;
    let currentPartKind: 'thinking' | 'text' | 'tool_use' | undefined;
    let lastUsage: CanonicalUsage | undefined;
    let lastFinishRaw: string | undefined;
    let ended = false;

    for await (const rawItem of stream) {
      const obj = parseStreamChunk(rawItem);
      if (obj === undefined) continue;

      if (!started) {
        started = true;
        const model = asString(obj['modelVersion']) ?? ctx.route?.model ?? '';
        yield nextFrame('start', {
          model,
          client_format: ctx.client_format,
          provider_format: FORMAT,
        });
      }

      const usage = this.extractUsage(obj);
      if (usage.units.tokens !== undefined) {
        lastUsage = usage;
      }

      const candidates = Array.isArray(obj['candidates']) ? obj['candidates'] : [];
      const first = asRecord(candidates[0]);
      const content = asRecord(first?.['content']);
      const rawParts = Array.isArray(content?.['parts']) ? content['parts'] : [];

      for (const rawPart of rawParts) {
        const p = asRecord(rawPart);
        if (p === undefined) continue;

        const fc = asRecord(p['functionCall'] ?? p['function_call']);
        if (fc !== undefined) {
          sawToolUse = true;
          callSeq += 1;
          partIndex += 1;
          currentPartKind = 'tool_use';
          const id = asString(fc['id']) || `call_gemini_${ctx.request_id}_${callSeq}`;
          const name = asString(fc['name']) ?? '';
          const args = asRecord(fc['args']) ?? {};
          const rawArgs = JSON.stringify(args);
          const idx = partIndex;

          yield nextFrame('meta', {
            notes: {
              'gemini.part': {
                phase: 'begin',
                index: idx,
                part: { type: 'tool_use', id, name, input: {} },
              },
            },
          });
          if (rawArgs !== '') {
            yield nextFrame('delta', {
              kind: 'chat',
              index: idx,
              tool_input_json: rawArgs,
            });
          }
          yield nextFrame('meta', {
            notes: {
              'gemini.part': {
                phase: 'end',
                index: idx,
                part: { type: 'tool_use', id, name, input: args, raw_arguments: rawArgs, _raw: p },
              },
            },
          });
          continue;
        }

        if (typeof p['text'] === 'string') {
          if (p['thought'] === true) {
            if (p['text'] !== '') {
              if (currentPartKind !== 'thinking') {
                partIndex += 1;
                currentPartKind = 'thinking';
              }
              yield nextFrame('delta', {
                kind: 'chat',
                index: partIndex,
                thinking: p['text'],
              });
            }
          } else if (p['text'] !== '') {
            if (currentPartKind !== 'text') {
              partIndex += 1;
              currentPartKind = 'text';
            }
            yield nextFrame('delta', {
              kind: 'chat',
              index: partIndex,
              text: p['text'],
            });
          }
        }
      }

      const promptFeedback = asRecord(obj['promptFeedback']);
      const finishRaw =
        asString(first?.['finishReason']) ?? asString(promptFeedback?.['blockReason']);
      if (finishRaw !== undefined) {
        lastFinishRaw = finishRaw;
      }
    }

    if (!ended) {
      ended = true;
      if (lastUsage !== undefined) {
        yield nextFrame('usage', { usage: lastUsage });
      }
      const norm = this.normalizeFinishReason(lastFinishRaw);
      if (
        lastFinishRaw !== undefined &&
        lastFinishRaw !== '' &&
        norm === 'other' &&
        lastFinishRaw !== 'OTHER' &&
        lastFinishRaw !== 'FINISH_REASON_UNSPECIFIED'
      ) {
        ctx.warn(`unmapped_finish_reason:${lastFinishRaw}`);
      }
      const finishReason: FinishReason =
        sawToolUse && (norm === 'stop' || lastFinishRaw === undefined) ? 'tool_use' : norm;
      yield nextFrame('end', {
        finish_reason: finishReason,
        usage: lastUsage ?? emptyUsage('provider'),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 7. 流式编码：canonical StreamFrame → wire (Gemini SSE)
  // -------------------------------------------------------------------------

  async *encodeStream(
    frames: AsyncIterable<StreamFrame>,
    ctx: RequestContext,
  ): AsyncIterable<unknown> {
    let state = ctx.state[ENCODE_STREAM_STATE_KEY] as GeminiStreamEncodeState | undefined;
    if (state === undefined) {
      state = {
        model: ctx.route?.model ?? '',
        openTools: new Map(),
        finishEmitted: false,
      };
      ctx.state[ENCODE_STREAM_STATE_KEY] = state;
    }

    for await (const frame of frames) {
      if (state.finishEmitted) continue;

      switch (frame.event) {
        case 'start': {
          const data = frame.data as { model?: string };
          if (typeof data.model === 'string' && data.model !== '') {
            state.model = data.model;
          }
          break;
        }
        case 'delta': {
          const data = frame.data as {
            index?: number;
            text?: string;
            thinking?: string;
            tool_input_json?: string;
            refusal?: string;
            part?: StreamPart;
            phase?: 'begin' | 'end';
          };
          const idx = typeof data.index === 'number' ? data.index : 0;

          if (data.phase === 'begin' && data.part?.type === 'tool_use') {
            state.openTools.set(idx, {
              id: data.part.id,
              name: data.part.name,
              argsText: '',
            });
            break;
          }

          if (data.tool_input_json !== undefined) {
            const open = state.openTools.get(idx);
            if (open !== undefined) {
              open.argsText += data.tool_input_json;
            }
            break;
          }

          if (data.phase === 'end' && data.part?.type === 'tool_use') {
            const open = state.openTools.get(idx);
            state.openTools.delete(idx);
            const args = parseToolArgs(data.part.input, open?.argsText ?? data.part.raw_arguments);
            const rawObj = asRecord((data.part as { _raw?: unknown })._raw);
            const thoughtSig = asString(rawObj?.['thoughtSignature'] ?? rawObj?.['thought_signature']);
            yield formatGeminiSse({
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          ...(data.part.id !== '' ? { id: data.part.id } : {}),
                          name: data.part.name,
                          args,
                        },
                        ...(thoughtSig !== undefined ? { thoughtSignature: thoughtSig } : {}),
                      },
                    ],
                  },
                },
              ],
              ...(state.model !== '' ? { modelVersion: state.model } : {}),
            });
            break;
          }

          if (typeof data.thinking === 'string' && data.thinking !== '') {
            yield formatGeminiSse({
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [{ text: data.thinking, thought: true }],
                  },
                },
              ],
              ...(state.model !== '' ? { modelVersion: state.model } : {}),
            });
            break;
          }

          if (typeof data.text === 'string' && data.text !== '') {
            yield formatGeminiSse({
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [{ text: data.text }],
                  },
                },
              ],
              ...(state.model !== '' ? { modelVersion: state.model } : {}),
            });
            break;
          }

          if (typeof data.refusal === 'string' && data.refusal !== '') {
            yield formatGeminiSse({
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [{ text: data.refusal }],
                  },
                },
              ],
              ...(state.model !== '' ? { modelVersion: state.model } : {}),
            });
            break;
          }
          break;
        }
        case 'meta': {
          const note = extractPartNote(frame.data as Record<string, unknown>);
          if (note !== undefined) {
            if (note.phase === 'begin' && note.part.type === 'tool_use') {
              state.openTools.set(note.index, {
                id: note.part.id,
                name: note.part.name,
                argsText: '',
              });
            } else if (note.phase === 'end' && note.part.type === 'tool_use') {
              const open = state.openTools.get(note.index);
              state.openTools.delete(note.index);
              const args = parseToolArgs(
                note.part.input,
                open?.argsText ?? note.part.raw_arguments,
              );
              const rawObj = asRecord((note.part as { _raw?: unknown })._raw);
              const thoughtSig = asString(rawObj?.['thoughtSignature'] ?? rawObj?.['thought_signature']);
              yield formatGeminiSse({
                candidates: [
                  {
                    index: 0,
                    content: {
                      role: 'model',
                      parts: [
                        {
                          functionCall: {
                            ...(note.part.id !== '' ? { id: note.part.id } : {}),
                            name: note.part.name,
                            args,
                          },
                          ...(thoughtSig !== undefined ? { thoughtSignature: thoughtSig } : {}),
                        },
                      ],
                    },
                  },
                ],
                ...(state.model !== '' ? { modelVersion: state.model } : {}),
              });
            }
          }
          break;
        }
        case 'usage': {
          const data = frame.data as { usage?: CanonicalUsage };
          if (data.usage !== undefined) {
            state.lastUsage = data.usage;
          }
          break;
        }
        case 'end': {
          const data = frame.data as { finish_reason?: FinishReason; usage?: CanonicalUsage };
          const usage =
            data.usage !== undefined && Object.keys(data.usage.units).length > 0
              ? data.usage
              : state.lastUsage;

          // Flush any still-open tool calls before finishing
          for (const [, open] of state.openTools) {
            const args = parseToolArgs({}, open.argsText);
            yield formatGeminiSse({
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          ...(open.id !== '' ? { id: open.id } : {}),
                          name: open.name,
                          args,
                        },
                      },
                    ],
                  },
                },
              ],
              ...(state.model !== '' ? { modelVersion: state.model } : {}),
            });
          }
          state.openTools.clear();

          const usageMeta = usage !== undefined ? encodeUsageMetadata(usage) : undefined;
          yield formatGeminiSse({
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [] },
                finishReason: encodeFinishReason(data.finish_reason ?? 'stop', undefined),
              },
            ],
            ...(usageMeta !== undefined ? { usageMetadata: usageMeta } : {}),
            ...(state.model !== '' ? { modelVersion: state.model } : {}),
          });
          state.finishEmitted = true;
          delete ctx.state[ENCODE_STREAM_STATE_KEY];
          break;
        }
        case 'error': {
          const data = frame.data as { error?: { code?: string; message?: string; http_status?: number } };
          yield formatGeminiSse({
            error: {
              code: data.error?.http_status ?? 500,
              message: data.error?.message ?? 'stream error',
              status: data.error?.code ?? 'INTERNAL',
            },
          });
          state.finishEmitted = true;
          delete ctx.state[ENCODE_STREAM_STATE_KEY];
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 8. Usage 抽取（40 §2.1 & §2.2c I1/I2）
  // -------------------------------------------------------------------------

  extractUsage(raw: unknown): CanonicalUsage {
    const obj = asRecord(raw);
    if (obj === undefined) return emptyUsage('provider');
    const meta = asRecord(obj['usageMetadata']) ?? (hasGeminiUsageFields(obj) ? obj : undefined);
    if (meta === undefined) return emptyUsage('provider');

    const prompt = asNumber(meta['promptTokenCount']);
    const candidates = asNumber(meta['candidatesTokenCount']);
    const total = asNumber(meta['totalTokenCount']);
    const cached = asNumber(meta['cachedContentTokenCount']) ?? 0;
    const thoughts = asNumber(meta['thoughtsTokenCount']) ?? 0;
    const toolUsePrompt = asNumber(meta['toolUsePromptTokenCount']) ?? 0;

    if (prompt === undefined && candidates === undefined && total === undefined) {
      return emptyUsage('provider');
    }

    const inputTokens = prompt ?? 0;
    const baseCandidates = candidates ?? 0;
    // I2：判断 candidatesTokenCount 是否已含 thoughtsTokenCount
    const outputTokens =
      total !== undefined && thoughts > 0 && inputTokens + baseCandidates + toolUsePrompt < total
        ? baseCandidates + thoughts
        : baseCandidates;
    const totalTokens = total ?? inputTokens + outputTokens;

    const details: Record<string, number> = {};
    if (toolUsePrompt > 0) {
      details['tool_use_prompt_tokens'] = toolUsePrompt;
    }

    const tokens: TokenUsage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cache_read_tokens: cached,
      cache_write_tokens: 0,
      reasoning_tokens: thoughts,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };

    return {
      units: { tokens },
      raw: { gemini: meta },
      source: 'provider',
    };
  }

  // -------------------------------------------------------------------------
  // 9. finish_reason 归一（10 §9.3）
  // -------------------------------------------------------------------------

  normalizeFinishReason(raw: unknown): NormalizedFinishReason {
    let text: string | undefined;
    if (typeof raw === 'string') {
      text = raw;
    } else {
      const obj = asRecord(raw);
      const candidates = Array.isArray(obj?.['candidates']) ? obj['candidates'] : [];
      const first = asRecord(candidates[0]);
      text = asString(first?.['finishReason']);
    }
    if (text === undefined || text === '') {
      return 'other';
    }
    switch (text) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'RECITATION':
        return 'recitation';
      case 'SAFETY':
      case 'BLOCKLIST':
      case 'PROHIBITED_CONTENT':
      case 'SPII':
      case 'IMAGE_SAFETY':
      case 'LANGUAGE':
        return 'content_filter';
      case 'MALFORMED_FUNCTION_CALL':
      case 'UNEXPECTED_TOOL_CALL':
      case 'TOO_MANY_TOOL_CALLS':
        return 'error';
      case 'MISSING_THOUGHT_SIGNATURE':
        return 'missing_thought_signature';
      case 'OTHER':
      case 'FINISH_REASON_UNSPECIFIED':
        return 'other';
      default:
        return 'other';
    }
  }
}

// ===========================================================================
// 辅助函数：解码（Gemini wire → canonical）
// ===========================================================================

function decodeSystemInstruction(
  raw: unknown,
  cachedContent: string | undefined,
): SystemBlock[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const blocks: SystemBlock[] = [];
  if (typeof raw === 'string') {
    if (raw !== '') blocks.push({ text: raw });
  } else {
    const obj = asRecord(raw);
    const parts = Array.isArray(obj?.['parts']) ? obj['parts'] : [];
    for (const p of parts) {
      const rec = asRecord(p);
      if (rec !== undefined && typeof rec['text'] === 'string') {
        blocks.push({ text: rec['text'], _raw: rec });
      }
    }
  }
  if (blocks.length > 0 && cachedContent !== undefined) {
    blocks[0] = {
      ...blocks[0]!,
      cache_control: { type: 'ephemeral', cache_name: cachedContent },
    };
  }
  return blocks.length > 0 ? blocks : undefined;
}

function decodeContentItem(
  item: unknown,
  pendingCallIdsByName: Map<string, string[]>,
  nextCallId: () => string,
): CanonicalMessage | undefined {
  const obj = asRecord(item);
  if (obj === undefined) return undefined;

  const rawParts = Array.isArray(obj['parts']) ? obj['parts'] : [];
  const parts: Part[] = [];
  for (const p of rawParts) {
    const decoded = decodePart(p, pendingCallIdsByName, nextCallId);
    if (decoded !== undefined) parts.push(decoded);
  }

  const rawRole = asString(obj['role']);
  let role: CanonicalMessage['role'];
  if (rawRole === 'model') {
    role = 'assistant';
  } else if (rawRole === 'function') {
    role = 'tool';
  } else if (parts.length > 0 && parts.every((p) => p.type === 'tool_result')) {
    role = 'tool';
  } else {
    role = 'user';
  }

  return { role, parts, _raw: obj };
}

function decodePart(
  raw: unknown,
  pendingCallIdsByName: Map<string, string[]>,
  nextCallId: () => string,
): Part | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;

  // 1. thought / text
  if (typeof obj['text'] === 'string') {
    const thoughtSig = asString(obj['thoughtSignature'] ?? obj['thought_signature']);
    if (obj['thought'] === true) {
      const tp: ThinkingPart = {
        type: 'thinking',
        thinking: obj['text'],
        ...(thoughtSig !== undefined ? { signature: thoughtSig } : {}),
        _raw: obj,
      };
      return tp;
    }
    const textPart: TextPart = {
      type: 'text',
      text: obj['text'],
      ...(thoughtSig !== undefined ? { _raw: obj } : {}),
    };
    return textPart;
  }

  // 2. functionCall
  const fc = asRecord(obj['functionCall'] ?? obj['function_call']);
  if (fc !== undefined) {
    const name = asString(fc['name']) ?? '';
    const id = asString(fc['id']) || nextCallId();
    const args = asRecord(fc['args']) ?? {};
    const queue = pendingCallIdsByName.get(name) ?? [];
    queue.push(id);
    pendingCallIdsByName.set(name, queue);

    const toolUse: ToolUsePart = {
      type: 'tool_use',
      id,
      name,
      input: args,
      _raw: obj,
    };
    return toolUse;
  }

  // 3. functionResponse
  const fr = asRecord(obj['functionResponse'] ?? obj['function_response']);
  if (fr !== undefined) {
    const name = asString(fr['name']) ?? '';
    let toolUseId = asString(fr['id']);
    if (toolUseId === undefined || toolUseId === '') {
      const queue = pendingCallIdsByName.get(name);
      toolUseId = queue?.shift() ?? name;
    }
    const respObj = asRecord(fr['response']);
    let content: string;
    let isError = false;
    if (respObj !== undefined) {
      if (typeof respObj['error'] === 'string' && respObj['result'] === undefined && respObj['output'] === undefined) {
        content = respObj['error'];
        isError = true;
      } else if (typeof respObj['result'] === 'string' && Object.keys(respObj).length === 1) {
        content = respObj['result'];
      } else if (typeof respObj['output'] === 'string' && Object.keys(respObj).length === 1) {
        content = respObj['output'];
      } else {
        content = JSON.stringify(respObj);
      }
    } else if (fr['response'] !== undefined) {
      content = String(fr['response']);
    } else {
      content = '';
    }

    const toolResult: ToolResultPart = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      ...(isError ? { is_error: true } : {}),
      _raw: { ...obj, name },
    };
    return toolResult;
  }

  // 4. inlineData
  const inline = asRecord(obj['inlineData'] ?? obj['inline_data']);
  if (inline !== undefined) {
    const mime = asString(inline['mimeType'] ?? inline['mime_type']) ?? 'application/octet-stream';
    const data = asString(inline['data']) ?? '';
    const source: MediaRef = { kind: 'inline', mime, data };
    return mediaPartFromMime(mime, source, obj);
  }

  // 5. fileData
  const fileData = asRecord(obj['fileData'] ?? obj['file_data']);
  if (fileData !== undefined) {
    const uri = asString(fileData['fileUri'] ?? fileData['file_uri']) ?? '';
    const mime = asString(fileData['mimeType'] ?? fileData['mime_type']) ?? 'application/octet-stream';
    const source: MediaRef = { kind: 'uri', uri, mime };
    return mediaPartFromMime(mime, source, obj);
  }

  // 6. UnknownPart 兜底
  const unknownPart: UnknownPart = {
    type: 'unknown',
    raw_type: Object.keys(obj).join(','),
    raw: obj,
  };
  return unknownPart;
}

function mediaPartFromMime(mime: string, source: MediaRef, raw: Record<string, unknown>): Part {
  if (mime.startsWith('image/')) {
    const p: ImagePart = { type: 'image', source, _raw: raw };
    return p;
  }
  if (mime.startsWith('audio/')) {
    const p: AudioPart = { type: 'audio', source, format: { mime }, _raw: raw };
    return p;
  }
  if (mime.startsWith('video/')) {
    const p: VideoPart = { type: 'video', source, _raw: raw };
    return p;
  }
  const p: DocumentPart = { type: 'document', source, media_type: mime, _raw: raw };
  return p;
}

function decodeTools(raw: unknown): CanonicalTool[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tools: CanonicalTool[] = [];

  for (const item of raw) {
    const obj = asRecord(item);
    if (obj === undefined) continue;

    const decls = obj['functionDeclarations'] ?? obj['function_declarations'];
    if (Array.isArray(decls)) {
      for (const d of decls) {
        const decl = asRecord(d);
        if (decl === undefined) continue;
        const name = asString(decl['name']);
        if (name === undefined || name === '') continue;
        const description = asString(decl['description']);
        const rawSchema = decl['parameters'] ?? decl['parametersJsonSchema'] ?? decl['parameters_json_schema'];
        const parameters: JSONSchema =
          rawSchema !== undefined
            ? normalizeGeminiSchemaToJsonSchema(rawSchema)
            : { type: 'object', properties: {} };
        const fnTool: FunctionTool = {
          type: 'function',
          name,
          ...(description !== undefined ? { description } : {}),
          parameters,
          _raw: decl,
        };
        tools.push(fnTool);
      }
    }

    if ('googleSearch' in obj || 'google_search' in obj || 'googleSearchRetrieval' in obj) {
      const cfg = asRecord(obj['googleSearch'] ?? obj['google_search'] ?? obj['googleSearchRetrieval']) ?? {};
      const bt: BuiltinTool = {
        type: 'builtin',
        name: 'web_search',
        config: cfg,
        executor: 'provider',
        native: { provider_tool_type: 'googleSearch' },
        _raw: obj,
      };
      tools.push(bt);
    }

    if ('urlContext' in obj || 'url_context' in obj) {
      const cfg = asRecord(obj['urlContext'] ?? obj['url_context']) ?? {};
      const bt: BuiltinTool = {
        type: 'builtin',
        name: 'url_context',
        config: cfg,
        executor: 'provider',
        native: { provider_tool_type: 'urlContext' },
        _raw: obj,
      };
      tools.push(bt);
    }

    if ('codeExecution' in obj || 'code_execution' in obj) {
      const cfg = asRecord(obj['codeExecution'] ?? obj['code_execution']) ?? {};
      const bt: BuiltinTool = {
        type: 'builtin',
        name: 'code_interpreter',
        config: cfg,
        executor: 'provider',
        native: { provider_tool_type: 'codeExecution' },
        _raw: obj,
      };
      tools.push(bt);
    }

    if ('fileSearch' in obj || 'file_search' in obj) {
      const cfg = asRecord(obj['fileSearch'] ?? obj['file_search']) ?? {};
      const bt: BuiltinTool = {
        type: 'builtin',
        name: 'file_search',
        config: cfg,
        executor: 'provider',
        native: { provider_tool_type: 'fileSearch' },
        _raw: obj,
      };
      tools.push(bt);
    }
  }

  return tools.length > 0 ? tools : undefined;
}

function decodeToolConfig(raw: unknown): ToolChoice | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;
  const fcc = asRecord(obj['functionCallingConfig'] ?? obj['function_calling_config']);
  if (fcc === undefined) return undefined;
  const mode = asString(fcc['mode'])?.toUpperCase();
  const allowed = Array.isArray(fcc['allowedFunctionNames'] ?? fcc['allowed_function_names'])
    ? ((fcc['allowedFunctionNames'] ?? fcc['allowed_function_names']) as unknown[]).filter(
        (s): s is string => typeof s === 'string',
      )
    : [];

  if (mode === 'NONE') return 'none';
  if (mode === 'AUTO') return 'auto';
  if (mode === 'ANY') {
    if (allowed.length === 1) {
      return { type: 'tool', name: allowed[0]! };
    }
    return 'required';
  }
  return undefined;
}

function decodeParams(
  genRaw: unknown,
  safetyRaw: unknown,
  rootObj?: Record<string, unknown>,
): ChatParams | undefined {
  const params: ChatParams = {};
  const gen = asRecord(genRaw);

  if (gen !== undefined) {
    const maxOut = asNumber(gen['maxOutputTokens'] ?? gen['max_output_tokens']);
    if (maxOut !== undefined) params.max_output_tokens = maxOut;

    const temp = asNumber(gen['temperature']);
    if (temp !== undefined) params.temperature = temp;

    const topP = asNumber(gen['topP'] ?? gen['top_p']);
    if (topP !== undefined) params.top_p = topP;

    const topK = asNumber(gen['topK'] ?? gen['top_k']);
    if (topK !== undefined) params.top_k = topK;

    const stopRaw = gen['stopSequences'] ?? gen['stop_sequences'];
    if (Array.isArray(stopRaw)) {
      const stops = stopRaw.filter((s): s is string => typeof s === 'string');
      if (stops.length > 0) params.stop = stops;
    }

    const seed = asNumber(gen['seed']);
    if (seed !== undefined) params.seed = seed;

    const n = asNumber(gen['candidateCount'] ?? gen['candidate_count']);
    if (n !== undefined) params.n = n;

    const presence = asNumber(gen['presencePenalty'] ?? gen['presence_penalty']);
    if (presence !== undefined) params.presence_penalty = presence;

    const freq = asNumber(gen['frequencyPenalty'] ?? gen['frequency_penalty']);
    if (freq !== undefined) params.frequency_penalty = freq;

    if (typeof gen['responseLogprobs'] === 'boolean') {
      params.logprobs = gen['responseLogprobs'];
    }
    const topLogprobs = asNumber(gen['logprobs']);
    if (topLogprobs !== undefined) params.top_logprobs = topLogprobs;

    const rf = decodeResponseFormat(gen);
    if (rf !== undefined) params.response_format = rf;

    const thinking = decodeThinkingConfig(gen['thinkingConfig'] ?? gen['thinking_config']);
    if (thinking !== undefined) params.thinking = thinking;
  }

  if (Array.isArray(safetyRaw)) {
    const safety: SafetySetting[] = [];
    for (const s of safetyRaw) {
      const rec = asRecord(s);
      const category = asString(rec?.['category']);
      const threshold = asString(rec?.['threshold']);
      if (category !== undefined && threshold !== undefined) {
        safety.push({ category, threshold });
      }
    }
    if (safety.length > 0) params.safety = safety;
  }

  if (rootObj !== undefined) {
    applyClientProviderOptions(rootObj, params);
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

function decodeResponseFormat(gen: Record<string, unknown>): ResponseFormat | undefined {
  const mime = asString(gen['responseMimeType'] ?? gen['response_mime_type']);
  const schemaRaw = gen['responseSchema'] ?? gen['response_schema'] ?? gen['responseJsonSchema'];
  if (schemaRaw !== undefined) {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: normalizeGeminiSchemaToJsonSchema(schemaRaw),
      },
    };
  }
  if (mime === 'application/json') {
    return { type: 'json_object' };
  }
  if (mime === 'text/plain') {
    return { type: 'text' };
  }
  return undefined;
}

function decodeThinkingConfig(raw: unknown): ThinkingConfig | undefined {
  const obj = asRecord(raw);
  if (obj === undefined) return undefined;

  const budget = asNumber(obj['thinkingBudget'] ?? obj['thinking_budget']);
  const levelRaw = asString(obj['thinkingLevel'] ?? obj['thinking_level'])?.toLowerCase();
  const includeThoughts = obj['includeThoughts'] ?? obj['include_thoughts'];

  const effortMap: Record<string, ThinkingConfig['effort']> = {
    none: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
  };
  const effort = levelRaw !== undefined ? effortMap[levelRaw] : undefined;

  if (budget === 0 || effort === 'none') {
    return {
      enabled: false,
      ...(budget !== undefined ? { budget_tokens: budget } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(typeof includeThoughts === 'boolean' ? { include_summary: includeThoughts } : {}),
    };
  }

  if (budget !== undefined || effort !== undefined || includeThoughts !== undefined) {
    return {
      enabled: true,
      ...(budget !== undefined && budget > 0 ? { budget_tokens: budget } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(typeof includeThoughts === 'boolean' ? { include_summary: includeThoughts } : {}),
    };
  }
  return undefined;
}

// ===========================================================================
// 辅助函数：编码（canonical → Gemini wire）
// ===========================================================================

function encodePart(
  part: Part,
  sameFormat: boolean,
  toolIdToName: Map<string, string>,
  warnings: string[],
): Record<string, unknown> | undefined {
  switch (part.type) {
    case 'text': {
      const rawObj = asRecord(part._raw);
      const thoughtSig = asString(rawObj?.['thoughtSignature'] ?? rawObj?.['thought_signature']);
      return {
        text: part.text,
        ...(thoughtSig !== undefined ? { thoughtSignature: thoughtSig } : {}),
      };
    }
    case 'thinking': {
      // 跨格式历史里的无签名思考块（来自 OpenAI Responses / Anthropic）或空思考块不发给 Gemini，
      // 避免上游因缺少 thoughtSignature 返回 400
      if (!sameFormat && part.signature === undefined) {
        return undefined;
      }
      if (part.thinking === '' && part.signature === undefined) {
        return undefined;
      }
      return {
        text: part.thinking,
        thought: true,
        ...(part.signature !== undefined ? { thoughtSignature: part.signature } : {}),
      };
    }
    case 'redacted_thinking': {
      warnings.push('gemini_redacted_thinking_dropped');
      return undefined;
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'document': {
      return encodeMediaRef(part.source);
    }
    case 'tool_use': {
      const rawObj = asRecord(part._raw);
      const thoughtSig = asString(rawObj?.['thoughtSignature'] ?? rawObj?.['thought_signature']);
      return {
        functionCall: {
          ...(part.id !== '' ? { id: part.id } : {}),
          name: part.name,
          args: part.input,
        },
        ...(thoughtSig !== undefined ? { thoughtSignature: thoughtSig } : {}),
      };
    }
    case 'tool_result': {
      const rawObj = asRecord(part._raw);
      const name =
        toolIdToName.get(part.tool_use_id) ??
        asString(rawObj?.['name']) ??
        part.tool_use_id;
      const responseObj = encodeToolResultContent(part.content, part.is_error === true);
      return {
        functionResponse: {
          ...(part.tool_use_id !== '' ? { id: part.tool_use_id } : {}),
          name,
          response: responseObj,
        },
      };
    }
    case 'refusal': {
      return { text: part.reason };
    }
    case 'search_result': {
      return { text: `[${part.title}](${part.url})\n${part.snippet}` };
    }
    case 'unknown': {
      if (sameFormat && typeof part.raw === 'object' && part.raw !== null) {
        return part.raw as Record<string, unknown>;
      }
      warnings.push(`gemini_unknown_part_dropped:${part.raw_type ?? 'unknown'}`);
      return undefined;
    }
  }
}

function encodeMediaRef(source: MediaRef): Record<string, unknown> {
  if (source.kind === 'inline') {
    return {
      inlineData: {
        mimeType: source.mime,
        data: source.data,
      },
    };
  }
  if (source.kind === 'uri') {
    return {
      fileData: {
        ...(source.mime !== '' ? { mimeType: source.mime } : {}),
        fileUri: source.uri,
      },
    };
  }
  return {
    fileData: {
      ...(source.mime !== '' ? { mimeType: source.mime } : {}),
      fileUri: source.asset_id,
    },
  };
}

function encodeToolResultContent(
  content: string | Part[],
  isError: boolean,
): Record<string, unknown> {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    text = content
      .map((p) => (p.type === 'text' ? p.text : JSON.stringify(p)))
      .join('\n');
  }

  if (isError) {
    return { error: text };
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 非 JSON 对象，包成 { result: text }
    }
  }
  return { result: text };
}

function encodeTools(tools: CanonicalTool[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const fnDecls: Array<Record<string, unknown>> = [];

  for (const tool of tools) {
    if (tool.type === 'function') {
      const sanitized = sanitizeJsonSchemaForGemini(tool.parameters);
      const props = asRecord(sanitized['properties']);
      const hasNonEmptyProps = props !== undefined && Object.keys(props).length > 0;
      const isEmptyObject =
        (sanitized['type'] === 'object' || sanitized['type'] === undefined) &&
        !hasNonEmptyProps &&
        sanitized['anyOf'] === undefined;
      fnDecls.push({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(isEmptyObject ? {} : { parameters: sanitized }),
      });
    } else if (tool.type === 'builtin') {
      switch (tool.name) {
        case 'web_search':
          out.push({ googleSearch: tool.config ?? {} });
          break;
        case 'url_context':
          out.push({ urlContext: tool.config ?? {} });
          break;
        case 'code_interpreter':
          out.push({ codeExecution: tool.config ?? {} });
          break;
        case 'file_search':
          out.push({ fileSearch: tool.config ?? {} });
          break;
      }
    }
  }

  if (fnDecls.length > 0) {
    out.unshift({ functionDeclarations: fnDecls });
  }
  return out;
}

function encodeToolChoice(
  choice: ToolChoice,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (choice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (choice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  if (choice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (choice.type === 'tool') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [choice.name],
      },
    };
  }
  warnings.push(`gemini_builtin_tool_choice_ignored:${choice.name}`);
  return undefined;
}

function encodeParams(
  params: ChatParams,
  model: string,
  sourceFormat: FormatId,
  dropped: string[],
  warnings: string[],
  diagnostics: ConversionDiagnostic[],
): {
  generationConfig: Record<string, unknown>;
  safetySettings?: SafetySetting[];
} {
  const gen: Record<string, unknown> = {};

  if (params.max_output_tokens !== undefined) gen['maxOutputTokens'] = params.max_output_tokens;
  if (params.temperature !== undefined) gen['temperature'] = params.temperature;
  if (params.top_p !== undefined) gen['topP'] = params.top_p;
  if (params.top_k !== undefined) gen['topK'] = params.top_k;
  if (params.stop !== undefined && params.stop.length > 0) gen['stopSequences'] = params.stop;
  if (params.seed !== undefined) gen['seed'] = params.seed;
  if (params.n !== undefined) gen['candidateCount'] = params.n;
  if (params.presence_penalty !== undefined) gen['presencePenalty'] = params.presence_penalty;
  if (params.frequency_penalty !== undefined) gen['frequencyPenalty'] = params.frequency_penalty;
  if (params.logprobs !== undefined) gen['responseLogprobs'] = params.logprobs;
  if (params.top_logprobs !== undefined) gen['logprobs'] = params.top_logprobs;

  if (params.response_format !== undefined) {
    if (params.response_format.type === 'json_object') {
      gen['responseMimeType'] = 'application/json';
    } else if (params.response_format.type === 'json_schema' && params.response_format.json_schema !== undefined) {
      gen['responseMimeType'] = 'application/json';
      gen['responseSchema'] = sanitizeJsonSchemaForGemini(params.response_format.json_schema.schema);
    } else if (params.response_format.type === 'text') {
      gen['responseMimeType'] = 'text/plain';
    }
  }

  if (params.thinking !== undefined) {
    const tc = encodeThinkingConfig(params.thinking, model, warnings);
    if (tc !== undefined) {
      gen['thinkingConfig'] = tc;
    }
  }

  // 不支持的参数：记录 dropped + diagnostic
  const unsupportedChecks: Array<[boolean, string]> = [
    [params.parallel_tool_calls !== undefined, 'params.parallel_tool_calls'],
    [params.user !== undefined, 'params.user'],
    [params.metadata !== undefined, 'params.metadata'],
    [params.service_tier !== undefined, 'params.service_tier'],
  ];
  for (const [present, field] of unsupportedChecks) {
    if (present) {
      dropped.push(field);
      diagnostics.push({
        code: `${field.replace(/\./g, '_')}_unsupported`,
        field_path: field,
        from: sourceFormat,
        to: FORMAT,
        level: 'warning',
        message: `Gemini generateContent 不支持 ${field}，已丢弃`,
      });
    }
  }

  return {
    generationConfig: gen,
    ...(params.safety !== undefined && params.safety.length > 0
      ? { safetySettings: params.safety }
      : {}),
  };
}

function encodeThinkingConfig(
  thinking: ThinkingConfig,
  model: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  const bareModel = model.replace(/^[^/]+\//, '');
  const isGemini3Plus = /^gemini-(?:[3-9]|\d{2,})/i.test(bareModel);

  if (!thinking.enabled) {
    return isGemini3Plus ? { thinkingLevel: 'MINIMAL' } : { thinkingBudget: 0 };
  }

  const out: Record<string, unknown> = {};
  if (thinking.include_summary !== undefined) {
    out['includeThoughts'] = thinking.include_summary;
  }

  // 40 §2.2b：thinkingBudget 与 thinkingLevel 绝不混传
  if (thinking.budget_tokens !== undefined && thinking.effort !== undefined) {
    warnings.push('gemini_thinking_budget_and_effort_both_set');
  }

  if (isGemini3Plus && thinking.effort !== undefined) {
    out['thinkingLevel'] = mapEffortToGeminiLevel(thinking.effort);
  } else if (thinking.budget_tokens !== undefined) {
    out['thinkingBudget'] = thinking.budget_tokens;
  } else if (thinking.effort !== undefined) {
    if (isGemini3Plus) {
      out['thinkingLevel'] = mapEffortToGeminiLevel(thinking.effort);
    } else {
      out['thinkingBudget'] = mapEffortToBudget(thinking.effort);
    }
  } else if (out['includeThoughts'] === undefined) {
    out['includeThoughts'] = true;
  }

  return out;
}

function mapEffortToGeminiLevel(effort: NonNullable<ThinkingConfig['effort']>): string {
  switch (effort) {
    case 'none':
    case 'minimal':
      return 'MINIMAL';
    case 'low':
      return 'LOW';
    case 'medium':
      return 'MEDIUM';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'HIGH';
  }
}

function mapEffortToBudget(effort: NonNullable<ThinkingConfig['effort']>): number {
  switch (effort) {
    case 'none':
      return 0;
    case 'minimal':
      return 1024;
    case 'low':
      return 2048;
    case 'medium':
      return 8192;
    case 'high':
      return 16384;
    case 'xhigh':
    case 'max':
      return 24576;
  }
}

function encodeFinishReason(reason: FinishReason, rawProvider: string | undefined): string {
  if (rawProvider !== undefined && rawProvider !== '') return rawProvider;
  switch (reason) {
    case 'stop':
    case 'tool_use':
    case 'stop_sequence':
    case 'pause_turn':
    case 'final':
      return 'STOP';
    case 'length':
    case 'context_exceeded':
      return 'MAX_TOKENS';
    case 'recitation':
      return 'RECITATION';
    case 'content_filter':
      return 'SAFETY';
    case 'missing_thought_signature':
      return 'MISSING_THOUGHT_SIGNATURE';
    case 'error':
    case 'other':
      return 'OTHER';
  }
}

function encodeUsageMetadata(usage: CanonicalUsage): Record<string, unknown> | undefined {
  const t = usage.units.tokens;
  if (t === undefined) return undefined;
  const out: Record<string, unknown> = {
    promptTokenCount: t.input_tokens,
    candidatesTokenCount: t.output_tokens,
    totalTokenCount: t.total_tokens,
  };
  if (t.cache_read_tokens > 0) {
    out['cachedContentTokenCount'] = t.cache_read_tokens;
  }
  if (t.reasoning_tokens > 0) {
    out['thoughtsTokenCount'] = t.reasoning_tokens;
  }
  return out;
}

// ===========================================================================
// JSON Schema 双向归一（Gemini UPPERCASE types ↔ 标准 JSON Schema）
// ===========================================================================

function normalizeGeminiSchemaToJsonSchema(raw: unknown): JSONSchema {
  if (typeof raw !== 'object' || raw === null) {
    return { type: 'object', properties: {} };
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'type' && typeof v === 'string') {
      out['type'] = v.toLowerCase();
    } else if (k === 'properties' && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        props[pk] = normalizeGeminiSchemaToJsonSchema(pv);
      }
      out['properties'] = props;
    } else if (k === 'items' && typeof v === 'object' && v !== null) {
      out['items'] = normalizeGeminiSchemaToJsonSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out as JSONSchema;
}

const GEMINI_ALLOWED_FORMATS = new Set(['enum', 'date-time', 'float', 'double', 'int32', 'int64']);

/**
 * 将标准 JSON Schema 严格规整为 Gemini OpenAPI-3.0 Schema 子集：
 *   - 展开 `$ref`（支持 `$defs` / `definitions`）；
 *   - `type: ["string", "null"]` → `type: "string", nullable: true`；
 *   - `const` → `enum: [val]`；`oneOf` → `anyOf`；`allOf` 合并 `properties`/`required`；
 *   - 仅保留 Gemini 接受的白名单字段（剔除 `$schema` / `additionalProperties` / `default` / `pattern` 等）；
 *   - 过滤掉 `required` 中未在 `properties` 声明的键；`object` 无属性时省略空 `properties`。
 */
function sanitizeJsonSchemaForGemini(
  raw: unknown,
  rootDefs?: Record<string, unknown>,
  seenRefs?: Set<string>,
): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { type: 'object' };
  }
  const obj = raw as Record<string, unknown>;
  const defs =
    rootDefs ??
    asRecord(obj['$defs']) ??
    asRecord(obj['definitions']) ??
    {};
  const seen = seenRefs ?? new Set<string>();

  // 1. 展开本地 $ref
  const ref = asString(obj['$ref']);
  if (ref !== undefined && !seen.has(ref)) {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    const target = match?.[1] !== undefined ? defs[match[1]] : undefined;
    if (target !== undefined) {
      const nextSeen = new Set(seen);
      nextSeen.add(ref);
      const resolved = sanitizeJsonSchemaForGemini(target, defs, nextSeen);
      if (typeof obj['description'] === 'string' && resolved['description'] === undefined) {
        resolved['description'] = obj['description'];
      }
      return resolved;
    }
  }

  // 2. 合并 allOf
  if (Array.isArray(obj['allOf']) && obj['allOf'].length > 0) {
    const mergedProps: Record<string, unknown> = {};
    const mergedReq = new Set<string>();
    let base: Record<string, unknown> = {};
    for (const sub of obj['allOf']) {
      const s = sanitizeJsonSchemaForGemini(sub, defs, seen);
      base = { ...base, ...s };
      const sp = asRecord(s['properties']);
      if (sp !== undefined) Object.assign(mergedProps, sp);
      if (Array.isArray(s['required'])) {
        for (const r of s['required']) {
          if (typeof r === 'string') mergedReq.add(r);
        }
      }
    }
    if (Object.keys(mergedProps).length > 0) {
      base['type'] = 'object';
      base['properties'] = mergedProps;
      if (mergedReq.size > 0) base['required'] = [...mergedReq];
    }
    if (typeof obj['description'] === 'string') base['description'] = obj['description'];
    return base;
  }

  const out: Record<string, unknown> = {};

  // 3. type（支持数组形态 ["string", "null"]）
  const rawType = obj['type'];
  if (typeof rawType === 'string') {
    const lower = rawType.toLowerCase();
    if (lower === 'null') {
      out['type'] = 'string';
      out['nullable'] = true;
    } else {
      out['type'] = lower;
    }
  } else if (Array.isArray(rawType)) {
    const nonNull = rawType
      .filter((t): t is string => typeof t === 'string' && t.toLowerCase() !== 'null')
      .map((t) => t.toLowerCase());
    if (rawType.some((t) => typeof t === 'string' && t.toLowerCase() === 'null')) {
      out['nullable'] = true;
    }
    if (nonNull.length === 1) {
      out['type'] = nonNull[0];
    } else if (nonNull.length > 1) {
      out['anyOf'] = nonNull.map((t) => ({ type: t }));
    }
  }

  if (typeof obj['description'] === 'string') out['description'] = obj['description'];
  if (typeof obj['title'] === 'string') out['title'] = obj['title'];
  if (typeof obj['nullable'] === 'boolean') out['nullable'] = obj['nullable'];

  if (typeof obj['format'] === 'string' && GEMINI_ALLOWED_FORMATS.has(obj['format'])) {
    out['format'] = obj['format'];
  }

  // 4. const / enum（Gemini enum 仅支持 string 值）
  if (obj['const'] !== undefined) {
    out['enum'] = [String(obj['const'])];
    if (out['type'] === undefined) out['type'] = 'string';
  } else if (Array.isArray(obj['enum']) && obj['enum'].length > 0) {
    out['enum'] = obj['enum'].map((v) => String(v));
    if (out['type'] === undefined) out['type'] = 'string';
  }

  // 5. anyOf / oneOf
  const unionRaw = Array.isArray(obj['anyOf'])
    ? obj['anyOf']
    : Array.isArray(obj['oneOf'])
      ? obj['oneOf']
      : undefined;
  if (unionRaw !== undefined && unionRaw.length > 0 && out['anyOf'] === undefined) {
    const nonNullBranches: Record<string, unknown>[] = [];
    let hasNull = false;
    for (const branch of unionRaw) {
      const bRec = asRecord(branch);
      if (bRec !== undefined && bRec['type'] === 'null') {
        hasNull = true;
        continue;
      }
      nonNullBranches.push(sanitizeJsonSchemaForGemini(branch, defs, seen));
    }
    if (hasNull) out['nullable'] = true;
    if (nonNullBranches.length === 1) {
      Object.assign(out, nonNullBranches[0]);
      if (hasNull) out['nullable'] = true;
    } else if (nonNullBranches.length > 1) {
      out['anyOf'] = nonNullBranches;
    }
  }

  // 6. properties + required
  const propsRaw = asRecord(obj['properties']);
  if (propsRaw !== undefined) {
    const cleanProps: Record<string, unknown> = {};
    for (const [pk, pv] of Object.entries(propsRaw)) {
      cleanProps[pk] = sanitizeJsonSchemaForGemini(pv, defs, seen);
    }
    if (Object.keys(cleanProps).length > 0) {
      out['properties'] = cleanProps;
      if (out['type'] === undefined) out['type'] = 'object';
      if (Array.isArray(obj['required'])) {
        const validReq = obj['required'].filter(
          (r): r is string => typeof r === 'string' && r in cleanProps,
        );
        if (validReq.length > 0) out['required'] = validReq;
      }
    }
  }

  // 7. items (for array)
  if (obj['items'] !== undefined) {
    if (Array.isArray(obj['items'])) {
      out['items'] = sanitizeJsonSchemaForGemini(obj['items'][0], defs, seen);
    } else {
      out['items'] = sanitizeJsonSchemaForGemini(obj['items'], defs, seen);
    }
    if (out['type'] === undefined) out['type'] = 'array';
  } else if (out['type'] === 'array') {
    // Gemini 要求 array 类型必须带 items
    out['items'] = { type: 'string' };
  }

  if (typeof obj['minItems'] === 'number') out['minItems'] = obj['minItems'];
  if (typeof obj['maxItems'] === 'number') out['maxItems'] = obj['maxItems'];

  // 兜底：既无 type 又无 anyOf 时补 string
  if (out['type'] === undefined && out['anyOf'] === undefined) {
    out['type'] = 'object';
  }
  return out;
}

// ===========================================================================
// 流式解析与杂项工具
// ===========================================================================

function parseStreamChunk(item: unknown): Record<string, unknown> | undefined {
  if (typeof item === 'object' && item !== null) {
    return item as Record<string, unknown>;
  }
  if (typeof item !== 'string') return undefined;
  const lines = item.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const jsonText = (dataLines.length > 0 ? dataLines.join('\n') : item).trim();
  if (jsonText === '' || jsonText === '[DONE]') return undefined;
  try {
    const parsed: unknown = JSON.parse(jsonText);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function formatGeminiSse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function parseToolArgs(
  input: Record<string, unknown>,
  rawText: string | undefined,
): Record<string, unknown> {
  if (Object.keys(input).length > 0) return input;
  if (rawText !== undefined && rawText.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(rawText);
      const rec = asRecord(parsed);
      if (rec !== undefined) return rec;
    } catch {
      // fall through
    }
  }
  return {};
}

function extractPartNote(
  data: Record<string, unknown>,
): { phase: 'begin' | 'end'; index: number; part: StreamPart } | undefined {
  const candidates: unknown[] = [data];
  const notes = asRecord(data['notes']);
  if (notes !== undefined) {
    candidates.push(...Object.values(notes));
  }
  for (const c of candidates) {
    const rec = asRecord(c);
    if (rec === undefined) continue;
    const phase = rec['phase'];
    if (phase !== 'begin' && phase !== 'end') continue;
    const part = asRecord(rec['part']);
    if (part === undefined || typeof part['type'] !== 'string') continue;
    return {
      phase,
      index: typeof rec['index'] === 'number' ? rec['index'] : 0,
      part: part as unknown as StreamPart,
    };
  }
  return undefined;
}

function hasGeminiUsageFields(obj: Record<string, unknown>): boolean {
  return (
    'promptTokenCount' in obj ||
    'candidatesTokenCount' in obj ||
    'totalTokenCount' in obj
  );
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
