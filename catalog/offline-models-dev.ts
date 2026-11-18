/**
 * catalog/offline-models-dev.ts —— 离线目录层：vendored models.dev 快照。
 *
 * ## 为什么 vendor 而不是运行时抓
 *
 * models.dev（https://models.dev/api.json ，开源 JSON 仓库）提供 family / 发布日期 /
 * 知识截止 / 温度与结构化输出支持 / 开放权重 / 模态 / 限额等**静态**字段——正好补上上游
 * `/models` 不给的那一半。但它是**第三方站点**：运行时抓它意味着 `/v1/models` 的可用性
 * 依赖一个我们控制不了的服务（任务书硬约束：端点绝不能因为元数据源挂了而失败）。所以
 * 抓取发生在**仓库维护时**（`scripts/fetch-models-dev.mjs`），产物是带来源 URL 与抓取
 * 日期的 vendored JSON，运行时只读本地文件。
 *
 * ## 为什么是裁剪+归一化的快照，不是原样 6MB
 *
 * 上游 `api.json` 6.1 MB / 236 个 provider；我们只需要网关真正路由到的那几个。裁剪后
 * 的文件只有几 KB，**每个 diff 都可 review**（原样入库的话，上游改一个字段就是一次
 * 6MB 的二进制式 diff，实际上等于没人看）。归一化到 `ModelMetadata` 也在脚本里做，
 * 这样本文件只负责"读文件 + 校验结构"，不做字段猜测。
 *
 * ## 数据可信度
 *
 * 快照内容是**第三方数据**：只当数据用，不当指令；上游没有的字段一律省略（R2：未知
 * 不是 0），不猜不补。上游后来补了字段（如 license / benchmarks / tokenizer）时，
 * 归一化映射在脚本里加一行即可，本文件不用改。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../di/ports.js';
import type { ModelMetadata, ModelMetadataSnapshot, ModelMetadataSource } from './types.js';

/** vendored 快照路径（相对本文件，不依赖 process.cwd()）。 */
const MODELS_DEV_JSON_PATH = fileURLToPath(new URL('./vendor/models-dev.json', import.meta.url));

/** 离线层来源 id（进 `provenance.fields`）。 */
export const MODELS_DEV_SOURCE_ID = 'offline:models.dev';

/** 快照文件的顶层结构（加载时逐字段校验，坏结构直接抛错让该层缺席）。 */
interface ModelsDevSnapshotFile {
  $schema?: string;
  source_url: string;
  fetched_at: string;
  providers: Record<
    string,
    { id?: string; name?: string; api?: string; doc?: string; models?: unknown }
  >;
}

export interface ModelsDevSourceOptions {
  clock?: Clock;
  /** 覆盖快照路径（测试注入内存文件用）。 */
  path?: string;
}

/**
 * models.dev 离线来源。
 *
 * 加载失败（文件缺失 / JSON 坏 / 结构不对）会抛错，由 `ModelCatalog.loadSources` 捕获
 * 并让该层缺席——端点照常返回矩阵种子值。
 */
export function createModelsDevSource(options: ModelsDevSourceOptions = {}): ModelMetadataSource {
  const clock = options.clock;
  return {
    id: MODELS_DEV_SOURCE_ID,
    layer: 'offline',
    async load(): Promise<ModelMetadataSnapshot> {
      const file = readSnapshot(options.path);
      const models: ModelMetadata[] = [];
      for (const [providerId, provider] of Object.entries(file.providers)) {
        const entries = Array.isArray(provider.models) ? provider.models : [];
        for (const raw of entries) {
          const meta = normalize(providerId, raw);
          if (meta !== undefined) models.push(meta);
        }
      }
      return {
        sourceId: MODELS_DEV_SOURCE_ID,
        fetchedAt: parseDate(file.fetched_at) ?? clock?.now() ?? Date.now(),
        models,
      };
    },
  };
}

function readSnapshot(path?: string): ModelsDevSnapshotFile {
  let text: string;
  try {
    text = readFileSync(path ?? MODELS_DEV_JSON_PATH, 'utf8');
  } catch (err) {
    throw new Error(`models.dev 快照读取失败: ${String(err)}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`models.dev 快照不是合法 JSON: ${String(err)}`, { cause: err });
  }
  const file = parsed as Partial<ModelsDevSnapshotFile>;
  if (typeof file.source_url !== 'string' || typeof file.fetched_at !== 'string') {
    throw new Error(
      'models.dev 快照缺少 source_url / fetched_at（请用 scripts/fetch-models-dev.mjs 重新生成）',
    );
  }
  if (typeof file.providers !== 'object' || file.providers === null) {
    throw new Error('models.dev 快照缺少 providers 对象');
  }
  return file as ModelsDevSnapshotFile;
}

/** 一条快照记录 → `ModelMetadata`。形状已在生成脚本里归一化，这里只做兜底校验。 */
function normalize(providerId: string, raw: unknown): ModelMetadata | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : undefined;
  if (id === undefined || id === '') return undefined;
  const out: ModelMetadata = { id, provider: providerId };
  const strings: Array<keyof ModelMetadata> = [
    'name',
    'description',
    'family',
    'release_date',
    'knowledge_cutoff',
    'license',
    'tokenizer',
  ];
  for (const key of strings) {
    const value = record[key];
    if (typeof value === 'string') out[key] = value as never;
  }
  const booleans: Array<keyof ModelMetadata> = [
    'open_weights',
    'temperature',
    'structured_output',
    'tool_call',
    'reasoning',
    'attachment',
  ];
  for (const key of booleans) {
    const value = record[key];
    if (typeof value === 'boolean') out[key] = value as never;
  }
  const numbers: Array<keyof ModelMetadata> = ['context_window', 'max_output_tokens'];
  for (const key of numbers) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value as never;
  }
  for (const key of ['input_modalities', 'output_modalities'] as const) {
    const value = record[key];
    if (Array.isArray(value)) out[key] = value.filter((v): v is never => typeof v === 'string');
  }
  const effort = record['effort'];
  if (
    typeof effort === 'object' &&
    effort !== null &&
    Array.isArray((effort as { levels?: unknown }).levels)
  ) {
    const levels = (effort as { levels: unknown[] }).levels.filter(
      (v): v is string => typeof v === 'string',
    );
    out.effort = { levels };
  }
  const pricing = record['pricing'];
  if (typeof pricing === 'object' && pricing !== null) {
    out.pricing = pricing as ModelMetadata['pricing'];
  }
  const rawPassthrough = record['raw'];
  if (typeof rawPassthrough === 'object' && rawPassthrough !== null) {
    out.raw = rawPassthrough as Record<string, unknown>;
  }
  return out;
}

/** "YYYY-MM-DD" → epoch ms；解析不了返回 undefined（调用方回落 clock）。 */
function parseDate(value: string): number | undefined {
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : ms;
}
