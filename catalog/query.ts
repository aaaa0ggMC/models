/**
 * catalog/query.ts —— `GET /v1/models` 查询串 → `ModelQuery`。
 *
 * ## 两条 deliberately 的取舍
 *
 * 1. **未知查询参数被忽略**（不报错）。真实 OpenAI SDK 客户端（以及 LiteLLM 之类的中间
 *    层）会往 `/v1/models` 上挂各种自有参数；为一个我们不认识的 `?custom_llm_provider=x`
 *    返回 400 会直接打破 drop-in 兼容。任务书要求"多余键必须被真实 OpenAI SDK 客户端
 *    忽略"，查询参数是同一立场。
 * 2. **已知参数的值严格校验**（报错）。`?min_context=abc` 这种要么是调用方写错、要么是
 *    我们改错了参数名，静默当成"没有过滤"会让调用方以为拿到了全量——那比报错更糟。
 */

import type { ModelCapability, ModelQuery } from './types.js';
import { ModelQueryError, SORT_KEYS } from './types.js';

/** 单值参数 → 查询字段（后者是别名，前者优先）。 */
const STRING_ALIASES: ReadonlyArray<[field: keyof ModelQuery, ...names: string[]]> = [
  ['provider', 'owned_by', 'provider'],
  ['family', 'family'],
  ['access_path', 'access_path'],
  ['format', 'format'],
  ['status', 'status'],
  ['license', 'license'],
  ['q', 'q', 'search'],
  ['sort', 'sort', 'order'],
];

/** 列表参数（可重复传，也可逗号分隔）。 */
const LIST_ALIASES: ReadonlyArray<[field: keyof ModelQuery, ...names: string[]]> = [
  ['modality', 'modality', 'input_modality', 'modalities'],
  ['output_modality', 'output_modality'],
  ['capability', 'capability', 'capabilities'],
  ['parameter', 'parameter', 'parameters', 'supported_parameter'],
];

/** 数值参数（可配下限；limit 另带上限）。 */
const NUMBER_ALIASES: ReadonlyArray<[field: keyof ModelQuery, ...names: string[]]> = [
  ['min_context_window', 'min_context', 'min_context_window'],
  ['max_context_window', 'max_context', 'max_context_window'],
  ['min_output_tokens', 'min_output', 'min_output_tokens'],
  ['offset', 'offset'],
];

/** `limit` 上限：一次别把整个目录塞进一个响应。 */
export const MAX_PAGE_LIMIT = 200;

/** 合法能力标签（严格校验，见文件头取舍 2）。 */
const CAPABILITIES: ReadonlyArray<ModelCapability> = [
  'reasoning',
  'vision',
  'tool_call',
  'structured_output',
  'temperature',
  'streaming',
  'attachment',
];

/**
 * 解析查询串。非法值抛 `ModelQueryError`（HTTP 层映射成 400）。
 *
 * 纯函数、不读 `process.env`、不起 IO——测试直接喂 `URLSearchParams`。
 */
export function parseModelQuery(params: URLSearchParams): ModelQuery {
  const query: ModelQuery = {};

  for (const [field, ...names] of STRING_ALIASES) {
    const value = first(params, names);
    if (value !== undefined && value !== '') {
      query[field] = value as never;
    }
  }

  for (const [field, ...names] of LIST_ALIASES) {
    const values = collect(params, names);
    if (values.length > 0) query[field] = values as never;
  }

  for (const [field, ...names] of NUMBER_ALIASES) {
    const value = first(params, names);
    if (value === undefined || value === '') continue;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ModelQueryError(`查询参数 ${names[0]} 必须是非负整数（收到 "${value}"）`);
    }
    query[field] = parsed as never;
  }

  const limit = first(params, ['limit']);
  if (limit !== undefined && limit !== '') {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ModelQueryError(`查询参数 limit 必须是正整数（收到 "${limit}"）`);
    }
    query.limit = Math.min(parsed, MAX_PAGE_LIMIT);
  }

  const openWeights = first(params, ['open_weights']);
  if (openWeights !== undefined && openWeights !== '') {
    query.open_weights = parseBoolean(openWeights, 'open_weights');
  }

  const includeRetired = first(params, ['include_retired']);
  if (includeRetired !== undefined && includeRetired !== '') {
    query.include_retired = parseBoolean(includeRetired, 'include_retired');
  }

  if (query.capability !== undefined) {
    for (const capability of query.capability) {
      if (!CAPABILITIES.includes(capability as ModelCapability)) {
        throw new ModelQueryError(
          `不支持的能力过滤: ${capability}（可用: ${CAPABILITIES.join(', ')}）`,
        );
      }
    }
  }

  if (query.sort !== undefined) {
    for (const key of query.sort.split(',')) {
      const field = key.startsWith('-') ? key.slice(1) : key;
      if (!SORT_KEYS.includes(field)) {
        throw new ModelQueryError(
          `不支持的排序键: ${field}（可用: ${[...SORT_KEYS].join(', ')}，加 - 前缀降序）`,
        );
      }
    }
  }

  return query;
}

function first(params: URLSearchParams, names: ReadonlyArray<string>): string | undefined {
  for (const name of names) {
    const value = params.get(name);
    if (value !== null) return value;
  }
  return undefined;
}

function collect(params: URLSearchParams, names: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const name of names) {
    for (const value of params.getAll(name)) {
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed !== '') out.push(trimmed);
      }
    }
  }
  return [...new Set(out)];
}

function parseBoolean(value: string, name: string): boolean {
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new ModelQueryError(`查询参数 ${name} 必须是 true/false（收到 "${value}"）`);
}
