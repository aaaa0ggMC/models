/**
 * admin/provider-models.ts —— `POST /admin/api/provider-models` 的端口实现。
 *
 * 职责：按 (base_url, dialect, path) 打一次上游的模型发现端点，把响应归一成
 * `UpstreamModelDto[]`，并把失败**分类**成可操作的一类（key 无效 / 端点不支持 /
 * 限流 / 上游故障 / 网络不通 / 形状异常）。
 *
 * ## 为什么分类在后端而不是前端
 *
 * 前端只该做"按 code 显示一句话 + 一个按钮"。如果让前端自己判 HTTP 状态码，
 * 每家上游的错误形状都要在前端复刻一遍（OpenAI 兼容错误体、Anthropic 的
 * `{"type":"error","error":{...}}`、纯文本 HTML 网关页…），而且判错了没有单一
 * 地方可修。分类在后端 = 一家一份，改一次全站生效。
 *
 * ## 预览模式的 key 安全边界
 *
 * key 从请求体来，**只用这一次**：
 *   - 不进存储、不进日志、不进审计（审计在 admin/service.ts，只记 host 与条数）；
 *   - 不进错误信息——`detail` 里的上游响应体先过 `stripKey` 再过 `redactDetail`；
 *   - 不进 trace（这个调用压根不在 pipeline 里，没有 RequestContext）。
 *
 * 依赖全部注入（transport + 凭据解析器），不读 process.env、不起单例。
 */

import { readFileSync } from 'node:fs';
import { updateOnlineModelsDevPricing } from '../metering/models-dev-pricing.js';
import { parseModelMetadataLookupCandidates } from '../catalog/registry.js';
import { parseOAuthSecret } from '../credentials/oauth.js';
import { fileURLToPath } from 'node:url';
import type { Transport } from '../gateway-core/transport.js';
import type { CredentialResolver } from '../credentials/resolver.js';
import type { RequestContext } from '../ir/index.js';
import type {
  ProviderModelsFailure,
  ProviderModelsRequest,
  ProviderModelsResponse,
  UpstreamModelCategory,
  UpstreamModelDto,
} from './api-types.js';
import type { ProviderModelsPort } from './service.js';
import { safeHost } from './service.js';

interface DecodedUpstreamModels {
  data: UpstreamModelDto[];
  looksLikeList: boolean;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function extractConstraints(rec: Record<string, unknown>): string[] | undefined {
  const caps = asObj(rec['api_capabilities']);
  const anthropic = asObj(caps?.['anthropic_messages']);
  if (anthropic === undefined) return undefined;
  const out: string[] = [];
  if (typeof anthropic['system_prompt_update'] === 'string') {
    out.push(`system_prompt_update: ${anthropic['system_prompt_update']}`);
  }
  if (typeof anthropic['tool_update'] === 'string') {
    out.push(`tool_update: ${anthropic['tool_update']}`);
  }
  return out.length === 0 ? undefined : out;
}

type InputModality = NonNullable<UpstreamModelDto['input_modalities']>[number];
type OutputModality = NonNullable<UpstreamModelDto['output_modalities']>[number];

function normalizeInputModality(raw: unknown): InputModality | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.toLowerCase();
  if (v === 'text' || v.startsWith('text/')) return 'text';
  if (v === 'image' || v.startsWith('image/')) return 'image';
  if (v === 'audio' || v.startsWith('audio/')) return 'audio';
  if (v === 'video' || v.startsWith('video/')) return 'video';
  if (v === 'pdf' || v === 'application/pdf') return 'pdf';
  return undefined;
}

function normalizeOutputModality(raw: unknown): OutputModality | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.toLowerCase();
  if (v === 'text' || v.startsWith('text/')) return 'text';
  if (v === 'audio' || v.startsWith('audio/')) return 'audio';
  if (v === 'image' || v.startsWith('image/')) return 'image';
  if (v === 'video' || v.startsWith('video/')) return 'video';
  return undefined;
}

function dedupeModalities<T extends string>(items: unknown[], normalize: (v: unknown) => T | undefined): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    const norm = normalize(item);
    if (norm !== undefined && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/** 协议无关的 `/models` 响应解析（OpenAI / Anthropic `{data:[]}` + Gemini `{models:[]}`）。 */
export function decodeUpstreamModelsResponse(raw: unknown): DecodedUpstreamModels {
  const obj = asObj(raw);
  if (obj === undefined) return { data: [], looksLikeList: false };

  // OpenAI / Anthropic / DeepSeek / OpenCode 形态: { data: [...] }
  if (Array.isArray(obj['data'])) {
    const data: UpstreamModelDto[] = [];
    for (const item of obj['data']) {
      const rec = asObj(item);
      if (rec === undefined) continue;
      const id = typeof rec['id'] === 'string' && rec['id'] !== '' ? rec['id'] : undefined;
      if (id === undefined) continue;
      const dto: UpstreamModelDto = { id };
      if (typeof rec['display_name'] === 'string') dto.name = rec['display_name'];
      else if (typeof rec['name'] === 'string') dto.name = rec['name'];
      if (typeof rec['owned_by'] === 'string') dto.owned_by = rec['owned_by'];
      const limitObj = asObj(rec['limit']);
      const topProviderObj = asObj(rec['top_provider']);
      if (typeof rec['context_window'] === 'number') dto.context_window = rec['context_window'];
      else if (typeof rec['context_length'] === 'number') dto.context_window = rec['context_length'];
      else if (typeof rec['max_input_tokens'] === 'number') dto.context_window = rec['max_input_tokens'];
      else if (typeof rec['max_tokens'] === 'number') dto.context_window = rec['max_tokens'];
      else if (typeof limitObj?.['context'] === 'number') dto.context_window = limitObj['context'];
      else if (typeof topProviderObj?.['context_length'] === 'number') {
        dto.context_window = topProviderObj['context_length'];
      }
      if (typeof rec['max_output_tokens'] === 'number') {
        dto.max_output_tokens = rec['max_output_tokens'];
      } else if (typeof limitObj?.['output'] === 'number') {
        dto.max_output_tokens = limitObj['output'];
      } else if (typeof topProviderObj?.['max_completion_tokens'] === 'number') {
        dto.max_output_tokens = topProviderObj['max_completion_tokens'];
      }
      const modalitiesObj = asObj(rec['modalities']);
      const archObj = asObj(rec['architecture']);
      if (Array.isArray(rec['input_modalities'])) {
        dto.input_modalities = dedupeModalities(rec['input_modalities'], normalizeInputModality);
      } else if (Array.isArray(modalitiesObj?.['input'])) {
        const mods = dedupeModalities(modalitiesObj['input'], normalizeInputModality);
        if (mods.length > 0) dto.input_modalities = mods;
      } else if (Array.isArray(archObj?.['input_modalities'])) {
        const mods = dedupeModalities(archObj['input_modalities'], normalizeInputModality);
        if (mods.length > 0) dto.input_modalities = mods;
      } else if (typeof rec['enable_vision_input'] === 'boolean') {
        dto.input_modalities = rec['enable_vision_input'] ? ['text', 'image'] : ['text'];
      }
      if (rec['enable_reason'] === true) {
        dto.reasoning = true;
      }
      if (rec['model_type'] === '语音合成') dto.category = 'tts';
      else if (rec['model_type'] === '语音识别') dto.category = 'asr';
      else if (rec['model_type'] === '大语言模型') dto.category = 'chat';
      else if (rec['type'] === 'decision' || rec['recommended_api'] === 'systemone') {
        dto.category = 'decision';
      } else if (rec['type'] === 'embedding' || rec['recommended_api'] === 'embeddings') {
        dto.category = 'embedding';
      } else if (rec['type'] === 'image') {
        dto.category = 'image';
      } else if (rec['type'] === 'video') {
        dto.category = 'video';
      }
      if (Array.isArray(modalitiesObj?.['output'])) {
        const rawOutputs = modalitiesObj['output'].map((x) => String(x).toLowerCase());
        if (dto.category === undefined && rawOutputs.includes('decision')) {
          dto.category = 'decision';
        } else if (dto.category === undefined && rawOutputs.includes('embedding')) {
          dto.category = 'embedding';
        }
      }
      if (Array.isArray(rec['output_modalities'])) {
        dto.output_modalities = dedupeModalities(rec['output_modalities'], normalizeOutputModality);
      } else if (Array.isArray(modalitiesObj?.['output'])) {
        const mods = dedupeModalities(modalitiesObj['output'], normalizeOutputModality);
        if (mods.length > 0) dto.output_modalities = mods;
      } else if (Array.isArray(archObj?.['output_modalities'])) {
        const mods = dedupeModalities(archObj['output_modalities'], normalizeOutputModality);
        if (mods.length > 0) dto.output_modalities = mods;
      }
      const effort = asObj(rec['effort']);
      const capsObj = asObj(rec['capabilities']);
      const reasoningCap = asObj(capsObj?.['reasoning']);
      if (effort !== undefined && Array.isArray(effort['supported_levels'])) {
        dto.effort = {
          levels: effort['supported_levels'].filter((l): l is string => typeof l === 'string'),
          ...(typeof effort['default_level'] === 'string'
            ? { default: effort['default_level'] }
            : {}),
        };
      } else if (reasoningCap !== undefined && Array.isArray(reasoningCap['effort'])) {
        const levels = reasoningCap['effort'].filter((l): l is string => typeof l === 'string');
        if (levels.length > 0) {
          dto.effort = { levels };
        }
      }
      if (reasoningCap?.['supported'] === true) {
        dto.reasoning = true;
      } else if (
        Array.isArray(rec['supported_parameters']) &&
        rec['supported_parameters'].some((p) => p === 'reasoning' || p === 'include_reasoning')
      ) {
        dto.reasoning = true;
      }
      const constraints = extractConstraints(rec);
      if (constraints !== undefined) dto.constraints = constraints;
      // 提取上游自带单价（OpenCode Go `cost.text.input.price` / OpenRouter `pricing.prompt`）
      const costObj = asObj(rec['cost']);
      const costText = asObj(costObj?.['text']);
      const costTextIn = asObj(costText?.['input']);
      const costTextInCache = asObj(costTextIn?.['cache']);
      const pricingObj = asObj(rec['pricing']);
      const ocIn = costTextIn?.['price'];
      const ocOut = asObj(costText?.['output'])?.['price'];
      const ocCache = costTextInCache?.['read'] ?? asObj(costText?.['cache_read'])?.['price'];
      if (typeof ocIn === 'number' || typeof ocOut === 'number') {
        dto.pricing = {
          ...(typeof ocIn === 'number' ? { input: ocIn } : {}),
          ...(typeof ocOut === 'number' ? { output: ocOut } : {}),
          ...(typeof ocCache === 'number' ? { cache_read: ocCache } : {}),
          currency: 'USD',
        };
      } else if (pricingObj !== undefined) {
        const pIn = Number(pricingObj['prompt']);
        const pOut = Number(pricingObj['completion']);
        const pCache = Number(pricingObj['input_cache_read']);
        if (Number.isFinite(pIn) || Number.isFinite(pOut)) {
          // OpenRouter pricing 是每 token 美元（< 0.01），换算为每 1M tokens
          const scale =
            (Number.isFinite(pIn) && pIn > 0 && pIn < 0.001) ||
            (Number.isFinite(pOut) && pOut > 0 && pOut < 0.001)
              ? 1_000_000
              : 1;
          dto.pricing = {
            ...(Number.isFinite(pIn) ? { input: pIn * scale } : {}),
            ...(Number.isFinite(pOut) ? { output: pOut * scale } : {}),
            ...(Number.isFinite(pCache) ? { cache_read: pCache * scale } : {}),
            currency: 'USD',
          };
        }
      }
      data.push(dto);
    }
    return { data, looksLikeList: true };
  }

  // Gemini generateContent 形态: { models: [{ name: "models/...", displayName, ... }] }
  if (Array.isArray(obj['models'])) {
    const data: UpstreamModelDto[] = [];
    for (const item of obj['models']) {
      const rec = asObj(item);
      if (rec === undefined) continue;
      const rawName = typeof rec['name'] === 'string' ? rec['name'] : undefined;
      const rawId = typeof rec['id'] === 'string' ? rec['id'] : rawName?.replace(/^models\//, '');
      if (rawId === undefined || rawId === '') continue;
      const dto: UpstreamModelDto = { id: rawId };
      if (typeof rec['displayName'] === 'string') dto.name = rec['displayName'];
      if (typeof rec['inputTokenLimit'] === 'number') dto.context_window = rec['inputTokenLimit'];
      if (typeof rec['outputTokenLimit'] === 'number') {
        dto.max_output_tokens = rec['outputTokenLimit'];
      }
      data.push(dto);
    }
    return { data, looksLikeList: true };
  }

  return { data: [], looksLikeList: false };
}

/** 拉取超时（ms）。管理面上一次手点动作，5s 足够，也不该让用户干等。 */
const FETCH_TIMEOUT_MS = 8000;

/** 响应体进 `detail` 前的长度上限（前端放"详情"折叠区，不是日志）。 */
const MAX_DETAIL_CHARS = 600;

export interface ProviderModelsPortDeps {
  transport: Transport;
  credentialResolver: CredentialResolver;
  clock: { now(): number };
  /** 造一个系统级 RequestContext（凭据解析器的 headersFor 要 ctx 做 trace）。 */
  systemContext(accessPath: string): RequestContext;
}

/** 按 dialect 推模型发现端点路径（前端不猜，后端按方言做映射）。 */
export function modelsPathForDialect(
  dialect: ProviderModelsRequest['dialect'],
  override?: string,
): string {
  if (override !== undefined && override !== '') return override;
  switch (dialect) {
    case 'anthropic.messages':
      // Anthropic 兼容面的模型清单在 /v1/models（官方 SDK 同款）
      return '/v1/models';
    case 'gemini.generateContent':
      return '/v1beta/models';
    case 'openai.chat':
    case 'openai.responses':
    default:
      // DeepSeek 的 OpenAI 兼容面：`GET /models`（**没有 /v1**，与 chat 端点同一套口径）
      return '/models';
  }
}

/** 失败分类 → 一句话文案（**Toast / Tooltip 级别**，背景说明进用户手册）。 */
const MESSAGES: Record<ProviderModelsFailure['error']['code'], string> = {
  key_invalid: 'API Key 无效或没有该端点权限',
  endpoint_unsupported: '该地址不支持模型发现端点',
  rate_limited: '上游限流，请稍后重试',
  upstream_error: '上游故障',
  network_error: '网关到上游不通',
  invalid_json: '上游返回的不是合法 JSON',
  invalid_shape: '上游响应里没有模型清单',
  credential_missing: '该渠道还没有可用凭据',
  invalid_request: '请求不合法',
};

function fail(
  code: ProviderModelsFailure['error']['code'],
  upstreamStatus?: number,
  detail?: string,
): ProviderModelsFailure {
  return {
    ok: false,
    error: {
      code,
      message: MESSAGES[code],
      ...(upstreamStatus === undefined ? {} : { upstream_status: upstreamStatus }),
      ...(detail === undefined || detail === '' ? {} : { detail }),
    },
  };
}

export function createProviderModelsPort(deps: ProviderModelsPortDeps): ProviderModelsPort {
  const { transport, credentialResolver, clock } = deps;

  return {
    async fetch(
      input: ProviderModelsRequest,
    ): Promise<ProviderModelsResponse | ProviderModelsFailure> {
      const path = modelsPathForDialect(input.dialect, input.path);

      // ---- 鉴权头 ----
      // 预览模式：key 来自请求体的 `api_key`，只在这一个函数栈里存在；
      // 已存模式：从凭据解析器拿（env / keyring 两档，Phase 1 不读加密库）。
      let authHeaders: Record<string, string>;
      if (input.api_key !== undefined && input.api_key !== '') {
        const oauth = parseOAuthSecret(input.api_key);
        const token = oauth ? oauth.access_token : input.api_key;
        authHeaders = authHeadersForDialect(input.dialect, token);
      } else {
        const accessPath = `${input.provider_id}.${input.dialect.replace('.', '-')}`;
        try {
          const resolved = await credentialResolver.headersFor(
            accessPath,
            deps.systemContext(accessPath),
          );
          if (Object.keys(resolved.headers).length === 0) {
            return fail('credential_missing');
          }
          authHeaders = resolved.headers;
        } catch {
          // 不带 err.message：它可能带环境变量名之外的路径细节，而"没有凭据"
          // 这件事本身已经说清楚了
          return fail('credential_missing');
        }
      }

      // ---- 打上游 ----
      const sendOnce = async (targetPath: string): Promise<{ status: number; bodyText: string }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const res = await transport.send({
            method: 'GET',
            base_url: input.base_url,
            path: targetPath,
            headers: { accept: 'application/json', ...authHeaders },
            stream: false,
            signal: controller.signal,
          });
          return {
            status: res.status,
            bodyText: (res.body ?? Buffer.alloc(0)).toString('utf8'),
          };
        } finally {
          clearTimeout(timer);
        }
      };

      let status: number;
      let bodyText: string;
      try {
        ({ status, bodyText } = await sendOnce(path));
        // 部分 OpenAI 兼容节点（如 MiMo）base_url 只填 host、模型清单挂在 /v1/models；
        // /models 404 时自动回退试一次 /v1/models（仅在未显式指定 path 且 base_url 末尾无 /vN 时）
        if (
          status === 404 &&
          (input.path === undefined || input.path === '') &&
          path === '/models' &&
          !/\/v\d+\/?$/i.test(new URL(input.base_url).pathname)
        ) {
          try {
            ({ status, bodyText } = await sendOnce('/v1/models'));
          } catch {
            // 回退探测失败时保留首次 404，归类为 endpoint_unsupported
          }
        }
      } catch (err) {
        // 网络层失败（DNS / 连接拒绝 / 超时 / abort）——不带 err.message，
        // 它可能含内网地址或完整 URL
        const aborted = err instanceof Error && err.name === 'AbortError';
        return fail(
          'network_error',
          undefined,
          aborted ? `超过 ${FETCH_TIMEOUT_MS}ms 未响应` : undefined,
        );
      }

      if (status === 401 || status === 403) {
        return fail('key_invalid', status, stripKey(bodyText, input.api_key));
      }
      if (status === 404)
        return fail('endpoint_unsupported', status, stripKey(bodyText, input.api_key));
      if (status === 429) return fail('rate_limited', status, stripKey(bodyText, input.api_key));
      if (status >= 500) return fail('upstream_error', status, stripKey(bodyText, input.api_key));
      if (status < 200 || status >= 300) {
        return fail('upstream_error', status, stripKey(bodyText, input.api_key));
      }

      // ---- 200：解析形状 ----
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch {
        return fail('invalid_json', status, bodyText.slice(0, MAX_DETAIL_CHARS));
      }
      const decoded = decodeUpstreamModelsResponse(parsed);
      if (decoded.data.length === 0) {
        return fail(
          'invalid_shape',
          status,
          decoded.looksLikeList
            ? '上游返回了空的模型数组'
            : `响应里没有 data/models 数组（顶层键: ${topLevelKeys(parsed).join(', ')}）`,
        );
      }

      const enriched = enrichModelsWithOfflineMetadata(decoded.data);

      return {
        ok: true,
        source: 'upstream',
        fetched_at: clock.now(),
        models: enriched,
        metadata_incomplete: enriched.some((m) => m.context_window === undefined),
      };
    },
  };
}

/**
 * 按 dialect 造鉴权头（预览模式的 key 走这里，不进凭据解析器）。
 */
function authHeadersForDialect(
  dialect: ProviderModelsRequest['dialect'],
  key: string,
): Record<string, string> {
  if (dialect === 'anthropic.messages') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  if (dialect === 'gemini.generateContent') {
    return { 'x-goog-api-key': key };
  }
  return { authorization: `Bearer ${key}` };
}

/**
 * 把 key 从上游错误体里剥掉再进 `detail`。
 *
 * 双层：先按字面替换（key 可能被上游回显在 message 里），再过 `redactDetail`
 * 的形态黑名单（`sk-` 前缀等）。**绝不**因为"上游大概不会回显"就跳过——回显 key
 * 的错误体进前端详情区，等于把 key 贴到UI 上。
 */
function stripKey(text: string, key: string | undefined): string {
  let out = text.slice(0, MAX_DETAIL_CHARS);
  if (key !== undefined && key !== '' && out.includes(key)) {
    out = out.split(key).join('<REDACTED:key>');
  }
  return redactDetailLite(out);
}

/** `redactDetail` 的轻量版（避免 admin/service.ts → 本文件的循环依赖）。 */
function redactDetailLite(detail: string): string {
  return detail
    .replace(/\b(sk|sk-ant|AIza|ghp_|xoxb)-[A-Za-z0-9_-]{8,}\b/g, '<REDACTED:key>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<REDACTED:jwt>')
    .replace(/(password|passphrase|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=<REDACTED>');
}

function topLevelKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['(非对象)'];
  return Object.keys(value as Record<string, unknown>).slice(0, 8);
}

interface OfflineModelMeta {
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: UpstreamModelDto['input_modalities'];
  output_modalities?: UpstreamModelDto['output_modalities'];
  reasoning?: boolean;
}

let cachedOfflineIndex: Map<string, OfflineModelMeta> | null = null;

function getOfflineModelsDevIndex(): Map<string, OfflineModelMeta> {
  if (cachedOfflineIndex !== null) return cachedOfflineIndex;
  const map = new Map<string, OfflineModelMeta>();
  try {
    const filePath = fileURLToPath(new URL('../catalog/vendor/models-dev.json', import.meta.url));
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
      providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
    };
    const providers = raw.providers ?? {};
    for (const p of Object.values(providers)) {
      if (!Array.isArray(p?.models)) continue;
      for (const m of p.models) {
        const id = typeof m['id'] === 'string' ? m['id'] : undefined;
        if (!id || map.has(id)) continue;
        const meta: OfflineModelMeta = {};
        if (typeof m['name'] === 'string') meta.name = m['name'];
        if (typeof m['context_window'] === 'number') meta.context_window = m['context_window'];
        if (typeof m['max_output_tokens'] === 'number') {
          meta.max_output_tokens = m['max_output_tokens'];
        }
        if (Array.isArray(m['input_modalities'])) {
          meta.input_modalities = m['input_modalities'].filter(
            (v): v is NonNullable<UpstreamModelDto['input_modalities']>[number] =>
              v === 'text' || v === 'image' || v === 'audio' || v === 'video' || v === 'pdf',
          );
        }
        if (Array.isArray(m['output_modalities'])) {
          meta.output_modalities = m['output_modalities'].filter(
            (v): v is NonNullable<UpstreamModelDto['output_modalities']>[number] =>
              v === 'text' || v === 'audio' || v === 'image' || v === 'video',
          );
        }
        if (typeof m['reasoning'] === 'boolean') meta.reasoning = m['reasoning'];
        map.set(id, meta);
      }
    }
  } catch {
    // 离线快照缺失时静默降级，不影响上游清单返回
  }
  cachedOfflineIndex = map;
  return map;
}

function inferModelCategory(m: UpstreamModelDto): UpstreamModelCategory {
  if (m.category !== undefined && m.category !== 'chat') {
    return m.category;
  }
  const id = m.id.toLowerCase();
  if (/(^|[-_/.])(decision|decisions)([-_/.]|$)|^jev(?:[-_.\d]|$)/i.test(id)) {
    return 'decision';
  }
  if (
    (m.output_modalities?.includes('audio') && !m.output_modalities.includes('text')) ||
    /(^tts-|-tts\b|-tts-|speech)/i.test(id)
  ) {
    return 'tts';
  }
  if (
    (m.input_modalities?.includes('audio') &&
      !m.input_modalities.includes('text') &&
      m.output_modalities?.includes('text')) ||
    /(^whisper-|-asr\b|-asr-|transcribe)/i.test(id)
  ) {
    return 'asr';
  }
  if (
    (m.output_modalities?.includes('video') && !m.output_modalities.includes('text')) ||
    /(^sora\b|^veo\b|^kling\b|imagine-video|-video\b)/i.test(id)
  ) {
    return 'video';
  }
  if (
    (m.output_modalities?.includes('image') && !m.output_modalities.includes('text')) ||
    /(dall-e|gpt-image|chatgpt-image|imagen|wanx|imagine-image|-image\b)/i.test(id)
  ) {
    return 'image';
  }
  if (/(embedding|text-embedding|bge-)/i.test(id)) {
    return 'embedding';
  }
  return 'chat';
}

/**
 * 用离线 models.dev 快照 + 模型标识规则补全上游 `/models` 未返回的静态元数据。
 * 只填空，不覆盖上游自身已声明的字段。
 */
export function enrichModelsWithOfflineMetadata(models: UpstreamModelDto[]): UpstreamModelDto[] {
  return enrichModelsWithIndex(models, getOfflineModelsDevIndex()).models;
}

/**
 * 优先用内存缓存的在线 models.dev 索引补全元数据，未命中再回退到离线快照。
 * 用于编辑已有渠道时直接恢复已同步/离线元数据，不重复触发网络请求。
 */
export function enrichModelsWithCachedOrOfflineMetadata(
  models: UpstreamModelDto[],
): UpstreamModelDto[] {
  const afterOnline =
    cachedOnlineIndex !== null
      ? enrichModelsWithIndex(models, cachedOnlineIndex.map).models
      : models;
  return enrichModelsWithIndex(afterOnline, getOfflineModelsDevIndex()).models;
}

function lookupIndexWithCandidates(
  index: Map<string, OfflineModelMeta>,
  rawId: string,
): OfflineModelMeta | undefined {
  const exact = index.get(rawId);
  if (exact !== undefined) return exact;
  const { upstreamNamespace, bareIds } = parseModelMetadataLookupCandidates(rawId);
  for (const bareId of bareIds) {
    if (upstreamNamespace !== undefined) {
      const withNs = index.get(`${upstreamNamespace}/${bareId}`);
      if (withNs !== undefined) return withNs;
    }
    const bare = index.get(bareId);
    if (bare !== undefined) return bare;
  }
  return undefined;
}

function enrichModelsWithIndex(
  models: UpstreamModelDto[],
  index: Map<string, OfflineModelMeta>,
): { models: UpstreamModelDto[]; matchedCount: number } {
  let matchedCount = 0;
  const out = models.map((raw) => {
    const m: UpstreamModelDto = { ...raw };
    const hadUpstreamMeta =
      m.context_window !== undefined ||
      m.max_output_tokens !== undefined ||
      (m.input_modalities !== undefined && m.input_modalities.length > 0);

    const offline = lookupIndexWithCandidates(index, m.id);
    let filledFromOffline = false;
    if (offline !== undefined) {
      matchedCount += 1;
      if (m.name === undefined && offline.name !== undefined) m.name = offline.name;
      if (m.context_window === undefined && offline.context_window !== undefined) {
        m.context_window = offline.context_window;
        filledFromOffline = true;
      }
      if (m.max_output_tokens === undefined && offline.max_output_tokens !== undefined) {
        m.max_output_tokens = offline.max_output_tokens;
        filledFromOffline = true;
      }
      if (
        (m.input_modalities === undefined || m.input_modalities.length === 0) &&
        offline.input_modalities !== undefined &&
        offline.input_modalities.length > 0
      ) {
        m.input_modalities = offline.input_modalities;
        filledFromOffline = true;
      }
      if (
        (m.output_modalities === undefined || m.output_modalities.length === 0) &&
        offline.output_modalities !== undefined &&
        offline.output_modalities.length > 0
      ) {
        m.output_modalities = offline.output_modalities;
        filledFromOffline = true;
      }
      if (m.reasoning === undefined && offline.reasoning !== undefined) {
        m.reasoning = offline.reasoning;
      }
    }

    const category = inferModelCategory(m);
    if (category !== 'chat' || hadUpstreamMeta || filledFromOffline) {
      m.category = category;
    }

    let filledFromInference = false;
    if (m.input_modalities === undefined || m.input_modalities.length === 0) {
      if (category === 'asr') {
        m.input_modalities = ['audio'];
        filledFromInference = true;
      } else if (
        category === 'tts' ||
        category === 'image' ||
        category === 'embedding' ||
        category === 'decision'
      ) {
        m.input_modalities = ['text'];
        filledFromInference = true;
      }
    }
    if (m.output_modalities === undefined || m.output_modalities.length === 0) {
      if (category === 'tts') {
        m.output_modalities = ['audio'];
        filledFromInference = true;
      } else if (category === 'image') {
        m.output_modalities = ['image'];
        filledFromInference = true;
      } else if (category === 'video') {
        m.output_modalities = ['video'];
        filledFromInference = true;
      } else if (category === 'asr') {
        m.output_modalities = ['text'];
        filledFromInference = true;
      }
    }

    if (hadUpstreamMeta) m.metadata_source = 'upstream';
    else if (filledFromOffline) m.metadata_source = 'models.dev';
    else if (filledFromInference) m.metadata_source = 'inferred';

    if (category !== 'chat') {
      const lower = m.id.toLowerCase();
      if (category === 'tts') {
        const cap = lower.includes('voiceclone')
          ? '音色克隆'
          : lower.includes('voicedesign')
            ? '音色设计'
            : '预置音色';
        m.specs = {
          billing_unit: lower.startsWith('mimo-') ? '按字符 (限时免费)' : '按字符',
          capability: cap,
        };
      } else if (category === 'asr') {
        m.specs = {
          billing_unit: lower.startsWith('mimo-') ? '按时长 (¥0.5/h)' : '按时长',
          capability: lower.startsWith('mimo-') ? 'mp3 / wav (≤8 MiB)' : '多格式语音识别',
        };
      } else if (category === 'image') {
        m.specs = {
          billing_unit: '按张 / 分辨率',
          capability: '文生图',
        };
      } else if (category === 'video') {
        m.specs = {
          billing_unit: '按秒 / 分辨率',
          capability: '视频生成',
        };
      } else if (category === 'embedding') {
        m.specs = {
          billing_unit: '按输入 Token',
          capability: '向量嵌入',
        };
      } else if (category === 'decision') {
        m.specs = {
          billing_unit: '按输入 Token',
          capability: '结构化决策',
        };
      }
    }

    return m;
  });
  return { models: out, matchedCount };
}

let cachedOnlineIndex: { fetchedAt: number; map: Map<string, OfflineModelMeta> } | null = null;
const ONLINE_MODELS_DEV_TTL_MS = 5 * 60_000;

function parseOnlineModelsDevIndex(raw: unknown): Map<string, OfflineModelMeta> {
  const map = new Map<string, OfflineModelMeta>();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const provider of Object.values(raw as Record<string, unknown>)) {
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const modelsObj = (provider as Record<string, unknown>)['models'];
    if (modelsObj === null || typeof modelsObj !== 'object' || Array.isArray(modelsObj)) continue;
    for (const [key, item] of Object.entries(modelsObj as Record<string, unknown>)) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec['id'] === 'string' && rec['id'] !== '' ? rec['id'] : key;
      if (map.has(id)) continue;
      const meta: OfflineModelMeta = {};
      if (typeof rec['name'] === 'string') meta.name = rec['name'];
      const limit = asObj(rec['limit']);
      if (typeof limit?.['context'] === 'number') meta.context_window = limit['context'];
      if (typeof limit?.['output'] === 'number') meta.max_output_tokens = limit['output'];
      const modalities = asObj(rec['modalities']);
      if (Array.isArray(modalities?.['input'])) {
        meta.input_modalities = modalities['input'].filter(
          (v): v is NonNullable<UpstreamModelDto['input_modalities']>[number] =>
            v === 'text' || v === 'image' || v === 'audio' || v === 'video' || v === 'pdf',
        );
      }
      if (Array.isArray(modalities?.['output'])) {
        meta.output_modalities = modalities['output'].filter(
          (v): v is NonNullable<UpstreamModelDto['output_modalities']>[number] =>
            v === 'text' || v === 'audio' || v === 'image' || v === 'video',
        );
      }
      if (typeof rec['reasoning'] === 'boolean') meta.reasoning = rec['reasoning'];
      map.set(id, meta);
    }
  }
  return map;
}

/**
 * 在线拉取 https://models.dev/api.json（全量 236+ provider），为当前模型清单补全元数据。
 */
export async function syncModelsWithOnlineModelsDev(
  models: UpstreamModelDto[],
): Promise<
  | { ok: true; source: 'models.dev'; synced_at: number; matched_count: number; models: UpstreamModelDto[]; metadata_incomplete: boolean }
  | { ok: false; error: { code: 'network_error' | 'invalid_json'; message: string } }
> {
  const now = Date.now();
  let index: Map<string, OfflineModelMeta>;
  if (cachedOnlineIndex !== null && now - cachedOnlineIndex.fetchedAt < ONLINE_MODELS_DEV_TTL_MS) {
    index = cachedOnlineIndex.map;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch('https://models.dev/api.json', {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          ok: false,
          error: { code: 'network_error', message: `models.dev 返回 HTTP ${res.status}` },
        };
      }
      const parsed = (await res.json()) as unknown;
      updateOnlineModelsDevPricing(parsed);
      index = parseOnlineModelsDevIndex(parsed);
      cachedOnlineIndex = { fetchedAt: now, map: index };
    } catch {
      return {
        ok: false,
        error: { code: 'network_error', message: '无法连接 models.dev 在线库' },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const { models: enriched, matchedCount } = enrichModelsWithIndex(models, index);
  return {
    ok: true,
    source: 'models.dev',
    synced_at: now,
    matched_count: matchedCount,
    models: enriched,
    metadata_incomplete: enriched.some((m) => m.context_window === undefined),
  };
}

/** 导出给测试：host 脱敏与文案表都要能单独断言。 */
export const PROVIDER_MODELS_MESSAGES = MESSAGES;
export const providerModelsSafeHost = safeHost;
