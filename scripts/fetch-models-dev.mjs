/**
 * scripts/fetch-models-dev.mjs —— 抓取 models.dev 全量 API，生成「按 provider 裁剪 +
 * 归一化」的离线目录快照 catalog/vendor/models-dev.json。
 *
 * ## 为什么裁剪 + 归一化，而不是把 6 MB 原文件提交进仓库
 *
 * - models.dev/api.json 是社区维护的全量目录：约 6.1 MB、236 个 provider。本网关只
 *   路由到自己接了 access path 的那几个 provider（默认 deepseek/openai/anthropic，
 *   可用 `--providers` 或环境变量 `MODELS_DEV_PROVIDERS` 覆盖），其余两百多个 provider
 *   的数据对本仓库毫无用处，却会让每次刷新都产生无法 review 的巨大 diff。
 * - 原文件是「给人浏览的大而全」结构；我们的 canonical 目录需要固定字段集、固定类型、
 *   可排序、可 diff。因此这里做两层加工：
 *     1. 裁剪：只保留 allowlist 内的 provider；
 *     2. 归一化：只保留本仓库消费的字段（映射表见 normalizeModel），并把整个原始上游
 *        模型对象原样塞进每个记录的 `raw.upstream`——裁剪不丢信息，随时可回溯。
 * - 裁剪 + 归一化后只剩几十 KB，diff 可读；6 MB 原文件则只能整块替换，review 形同虚设。
 *
 * ## catalog/vendor/models-dev.json 是生成文件
 *
 * 由本脚本生成，**不要手改**——手改会在下一次刷新时被静默覆盖。刷新：
 *
 *     node scripts/fetch-models-dev.mjs
 *
 * `--check` 模式不写文件，只把「现在抓取 + 归一化」的结果与仓库里的现有文件做深度
 * 比对（键序不敏感），一致退出 0、不一致退出 1 并给出差异摘要，供 CI 做漂移检测：
 *
 *     node scripts/fetch-models-dev.mjs --check
 *
 * ## 上游数据是不可信的第三方数据
 *
 * models.dev 是第三方开放数据仓库，schema 不受我们控制：模型会增减、价格会变、字段
 * 会增删、取值会不规范（例如 knowledge 有时 "2025-05"、有时 "2025-07-31"）。本脚本把
 * 它当作**纯数据**处理：只 fetch、JSON.parse、按固定映射表取值；绝不 eval / 不执行、
 * 不当指令解析，上游出现的任何字符串都只是字符串。归一化时对每个字段都做存在性与类型
 * 检查，缺字段就整个键省略（不用 0 / null 兜底），规范表之外的取值直接丢弃（原始对象
 * 仍在 `raw.upstream` 里），避免把上游的脏数据灌进强类型的 canonical 目录。
 *
 * ## 不涉及任何 secrets
 *
 * 脚本只访问公开的 https://models.dev/api.json，不需要 API key / token，也不读取任何
 * 本地凭据；生成文件里只有公开的模型元数据。上游 provider 的真实 key 一律走环境变量，
 * 与本脚本无关。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SOURCE_URL = 'https://models.dev/api.json';
const OUT_PATH = join(root, 'catalog', 'vendor', 'models-dev.json');
const OUT_REL = relative(root, OUT_PATH);
const GENERATOR = 'scripts/fetch-models-dev.mjs';
const DEFAULT_PROVIDERS = [
  'deepseek',
  'openai',
  'anthropic',
  'google',
  'moonshotai-cn',
  'zhipuai',
  'xiaomi',
  'xiaomi-token-plan-cn',
  'alibaba-cn',
  'opencode-go',
  'opencode',
  'xai',
];
const FETCH_TIMEOUT_MS = 60_000;

/** modalities.input/output 的上游取值 → 我们的规范取值；表以外的值整体丢弃（raw 里仍有）。 */
const MODALITY_MAP = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
  pdf: 'pdf',
};

/** 上游 cost 键 → 计价引擎槽位名；只搬表中存在的键，不臆造价格。 */
const PRICING_SLOTS = [
  ['input', 'input_cache_miss'],
  ['cache_read', 'input_cache_hit'],
  ['output', 'output'],
  ['reasoning', 'reasoning'],
];

/** 顶层标量字段，--check 时逐个比对。 */
const SNAPSHOT_SCALARS = ['$schema', 'source_url', 'fetched_at', 'generator', 'note'];

/** 单个模型最多打印多少条字段级差异。 */
const MAX_MODEL_PATHS = 6;
/** 最多打印多少个有差异的模型，超出只报数量。 */
const MAX_MODELS = 20;

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stderr.write(`warn: ${message}\n`);
}

/** 今天（UTC）的 YYYY-MM-DD。 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const options = { providers: undefined, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--providers') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail('--providers 需要逗号分隔的 provider id 列表，例如 --providers deepseek,openai');
      }
      options.providers = value;
      i += 1;
    } else if (arg.startsWith('--providers=')) {
      options.providers = arg.slice('--providers='.length);
    } else {
      fail(`未知参数：${arg}\n用法：node ${GENERATOR} [--providers a,b,c] [--check]`);
    }
  }
  return options;
}

/**
 * allowlist 优先级：--providers > MODELS_DEV_PROVIDERS > 默认值。
 * 返回去重后的 id 列表（保持首次出现的顺序）。
 */
function resolveAllowlist(cliValue) {
  let raw;
  let source;
  if (cliValue !== undefined) {
    raw = cliValue;
    source = '--providers';
  } else if (process.env['MODELS_DEV_PROVIDERS'] !== undefined) {
    raw = process.env['MODELS_DEV_PROVIDERS'];
    source = 'env MODELS_DEV_PROVIDERS';
  } else {
    raw = DEFAULT_PROVIDERS.join(',');
    source = 'default';
  }
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    fail(`provider allowlist 为空（来源：${source}）——至少要给一个 provider id`);
  }
  console.log(`allowlist（${source}）：${unique.join(', ')}`);
  return unique;
}

async function fetchUpstream() {
  let response;
  try {
    response = await fetch(SOURCE_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    fail(`抓取 ${SOURCE_URL} 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    fail(`抓取 ${SOURCE_URL} 返回 HTTP ${response.status} ${response.statusText}`);
  }
  try {
    return await response.json();
  } catch (err) {
    fail(`${SOURCE_URL} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 存在且类型正确才赋值；否则整个键省略（未知 ≠ 0 / null）。 */
function assignTyped(target, outKey, source, key, type) {
  const value = source?.[key];
  if (value === undefined || value === null) return;
  if (typeof value !== type) {
    warn(`字段 ${key} 类型异常（期望 ${type}，实际 ${typeof value}），已省略`);
    return;
  }
  target[outKey] = value;
}

/** modalities.input/output：按 MODALITY_MAP 映射，表外取值丢弃；缺省返回 undefined。 */
function mapModalities(values) {
  if (!Array.isArray(values)) return undefined;
  const mapped = [];
  for (const value of values) {
    const hit = MODALITY_MAP[value];
    if (hit !== undefined) mapped.push(hit);
  }
  return mapped;
}

/** reasoning_options 里 type === 'effort' 的那一项 → { levels: [...] }；没有或空则省略。 */
function normalizeEffort(reasoningOptions) {
  if (!Array.isArray(reasoningOptions)) return undefined;
  for (const option of reasoningOptions) {
    if (option !== null && typeof option === 'object' && option['type'] === 'effort') {
      const values = option['values'];
      if (Array.isArray(values) && values.length > 0) return { levels: [...values] };
      return undefined;
    }
  }
  return undefined;
}

/**
 * cost → 我们的计价结构。仅当 cost 是对象且 input/output/cache_read 至少有一个数值时
 * 才生成；rates 只搬 PRICING_SLOTS 里上游真实存在的槽位，上游独有的键（cache_write、
 * tiers、context_over_200k…）不进 rates，但随 raw.upstream 完整保留。
 */
function normalizePricing(cost, fetchedAt) {
  if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) return undefined;
  const rates = {};
  let gated = false;
  for (const [upstreamKey, slot] of PRICING_SLOTS) {
    const value = cost[upstreamKey];
    if (typeof value !== 'number') continue;
    rates[slot] = value;
    if (upstreamKey === 'input' || upstreamKey === 'output' || upstreamKey === 'cache_read') {
      gated = true;
    }
  }
  if (!gated) return undefined;
  return {
    currency: 'USD',
    unit: 'USD per 1M tokens',
    table_version: 'models.dev',
    source_url: SOURCE_URL,
    fetched_at: fetchedAt,
    rates,
    tiers: [],
    rule_sets: [],
  };
}

/**
 * 若当前模型（如 Token Plan / Coding Plan）标价全为 0，则尝试沿 canonical_model_id
 *（如 "xiaomi/mimo-v2.6-pro"）向官方 provider 取非零计价，避免 Plan 订阅的 0 覆盖真实单价。
 */
function resolveEffectiveCost(model, allProviders) {
  const cost = model['cost'];
  const isZeroOrMissing =
    cost === null ||
    typeof cost !== 'object' ||
    Array.isArray(cost) ||
    ((typeof cost['input'] !== 'number' || cost['input'] === 0) &&
      (typeof cost['output'] !== 'number' || cost['output'] === 0) &&
      (typeof cost['cache_read'] !== 'number' || cost['cache_read'] === 0));

  if (!isZeroOrMissing) return cost;

  const canonical = model['canonical_model_id'];
  if (typeof canonical === 'string' && canonical.includes('/') && allProviders) {
    const slash = canonical.indexOf('/');
    const refProvider = canonical.slice(0, slash);
    const refModel = canonical.slice(slash + 1);
    const officialCost = allProviders[refProvider]?.['models']?.[refModel]?.['cost'];
    if (
      officialCost !== null &&
      typeof officialCost === 'object' &&
      !Array.isArray(officialCost) &&
      ((typeof officialCost['input'] === 'number' && officialCost['input'] > 0) ||
        (typeof officialCost['output'] === 'number' && officialCost['output'] > 0))
    ) {
      return officialCost;
    }
  }
  return cost;
}

/** 单个上游模型对象 → 我们的归一化记录（键序即下列顺序）。 */
function normalizeModel(key, model, fetchedAt, allProviders) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    warn(`模型 ${key} 不是对象，已跳过`);
    return undefined;
  }
  const id = typeof model['id'] === 'string' && model['id'].length > 0 ? model['id'] : key;
  const record = {};
  record['id'] = id;
  assignTyped(record, 'name', model, 'name', 'string');
  assignTyped(record, 'description', model, 'description', 'string');
  assignTyped(record, 'family', model, 'family', 'string');
  assignTyped(record, 'release_date', model, 'release_date', 'string');
  // knowledge 上游取值不规范（"2025-05" / "2025-07-31" 混用），按上游字符串原样保留
  assignTyped(record, 'knowledge_cutoff', model, 'knowledge', 'string');
  assignTyped(record, 'open_weights', model, 'open_weights', 'boolean');
  assignTyped(record, 'temperature', model, 'temperature', 'boolean');
  assignTyped(record, 'structured_output', model, 'structured_output', 'boolean');
  assignTyped(record, 'tool_call', model, 'tool_call', 'boolean');
  assignTyped(record, 'reasoning', model, 'reasoning', 'boolean');
  assignTyped(record, 'attachment', model, 'attachment', 'boolean');

  const modalities = model['modalities'];
  if (modalities !== null && typeof modalities === 'object' && !Array.isArray(modalities)) {
    const inputModalities = mapModalities(modalities['input']);
    const outputModalities = mapModalities(modalities['output']);
    if (inputModalities !== undefined) record['input_modalities'] = inputModalities;
    if (outputModalities !== undefined) record['output_modalities'] = outputModalities;
  }

  const limit = model['limit'];
  if (limit !== null && typeof limit === 'object' && !Array.isArray(limit)) {
    assignTyped(record, 'context_window', limit, 'context', 'number');
    assignTyped(record, 'max_output_tokens', limit, 'output', 'number');
  }

  const effort = normalizeEffort(model['reasoning_options']);
  if (effort !== undefined) record['effort'] = effort;

  const pricing = normalizePricing(resolveEffectiveCost(model, allProviders), fetchedAt);
  if (pricing !== undefined) record['pricing'] = pricing;

  // 整个原始上游对象原样透传：裁剪/归一化不丢任何上游信息
  record['raw'] = { upstream: model };
  return record;
}

/** 一个上游 provider → 我们的 provider 记录（模型按 id 排序）。 */
function normalizeProvider(id, provider, fetchedAt, allProviders) {
  const record = {};
  record['id'] = id;
  assignTyped(record, 'name', provider, 'name', 'string');
  assignTyped(record, 'api', provider, 'api', 'string');
  assignTyped(record, 'doc', provider, 'doc', 'string');

  const upstreamModels = provider['models'];
  if (
    upstreamModels !== null &&
    typeof upstreamModels === 'object' &&
    !Array.isArray(upstreamModels)
  ) {
    const records = [];
    for (const [key, model] of Object.entries(upstreamModels)) {
      const normalized = normalizeModel(key, model, fetchedAt, allProviders);
      if (normalized !== undefined) records.push(normalized);
    }
    records.sort((a, b) => (a['id'] < b['id'] ? -1 : a['id'] > b['id'] ? 1 : 0));
    record['models'] = records;
  } else {
    warn(`provider ${id} 上游没有 models 对象，按空列表处理`);
    record['models'] = [];
  }
  return record;
}

/** provider 键按字母序重排，保证生成文件确定性。 */
function sortProviders(providers) {
  const sorted = {};
  for (const id of Object.keys(providers).sort()) sorted[id] = providers[id];
  return sorted;
}

function buildSnapshot(providers, fetchedAt) {
  return {
    $schema: 'agentgateway/models-dev-snapshot/1',
    source_url: SOURCE_URL,
    fetched_at: fetchedAt,
    generator: GENERATOR,
    note: '本文件由 scripts/fetch-models-dev.mjs 生成，请勿手改；刷新：node scripts/fetch-models-dev.mjs',
    providers: sortProviders(providers),
  };
}

function serialize(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function preview(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * 收集 a → b 的差异路径（键序不敏感）。数组当叶子整体比对，避免逐元素刷屏。
 */
function diffPaths(a, b, path, out, limit) {
  if (out.length >= limit) return;
  if (isDeepStrictEqual(a, b)) return;
  const comparable =
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b);
  if (!comparable) {
    out.push(`${path}: ${preview(a)} -> ${preview(b)}`);
    return;
  }
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (out.length >= limit) return;
    const childPath = `${path}.${key}`;
    if (!(key in a)) out.push(`${childPath}: <absent> -> ${preview(b[key])}`);
    else if (!(key in b)) out.push(`${childPath}: ${preview(a[key])} -> <absent>`);
    else diffPaths(a[key], b[key], childPath, out, limit);
  }
}

/** models 可能是数组（我们的格式）或对象（宽容上游形态），统一成 id → record。 */
function toModelMap(models) {
  if (Array.isArray(models)) {
    const map = {};
    for (const model of models) {
      if (model !== null && typeof model === 'object' && typeof model['id'] === 'string') {
        map[model['id']] = model;
      }
    }
    return map;
  }
  if (models !== null && typeof models === 'object') return models;
  return {};
}

/** 打印 fresh 与 existing 的差异摘要，返回有差异的 provider / 模型数量。 */
function reportDrift(fresh, existing) {
  const lines = [];
  let changedProviders = 0;
  let changedModels = 0;

  for (const key of SNAPSHOT_SCALARS) {
    if (!isDeepStrictEqual(fresh[key], existing[key])) {
      lines.push(`  ${key}: ${preview(existing[key])} -> ${preview(fresh[key])}`);
    }
  }

  const freshProviders = toRecordMap(fresh['providers']);
  const existingProviders = toRecordMap(existing['providers']);
  for (const id of [
    ...new Set([...Object.keys(freshProviders), ...Object.keys(existingProviders)]),
  ].sort()) {
    const oldProvider = existingProviders[id];
    const newProvider = freshProviders[id];
    if (oldProvider === undefined) {
      changedProviders += 1;
      lines.push(`  + provider ${id}（新出现在上游）`);
      continue;
    }
    if (newProvider === undefined) {
      changedProviders += 1;
      lines.push(`  - provider ${id}（上游已不存在）`);
      continue;
    }
    const scalarDiffs = [];
    for (const key of ['id', 'name', 'api', 'doc']) {
      if (!isDeepStrictEqual(oldProvider[key], newProvider[key])) {
        scalarDiffs.push(`${key}: ${preview(oldProvider[key])} -> ${preview(newProvider[key])}`);
      }
    }
    if (scalarDiffs.length > 0) {
      changedProviders += 1;
      lines.push(`  ~ provider ${id}: ${scalarDiffs.join('; ')}`);
    }

    const oldModels = toModelMap(oldProvider['models']);
    const newModels = toModelMap(newProvider['models']);
    const details = [];
    for (const modelId of [
      ...new Set([...Object.keys(oldModels), ...Object.keys(newModels)]),
    ].sort()) {
      const oldModel = oldModels[modelId];
      const newModel = newModels[modelId];
      if (oldModel === undefined) {
        details.push(`    + ${modelId}`);
      } else if (newModel === undefined) {
        details.push(`    - ${modelId}`);
      } else {
        const paths = [];
        diffPaths(oldModel, newModel, modelId, paths, MAX_MODEL_PATHS);
        if (paths.length > 0) details.push(`    ~ ${modelId}: ${paths.join('; ')}`);
      }
    }
    if (details.length > 0) {
      changedModels += details.length;
      lines.push(`  ~ provider ${id}: ${details.length} 个模型有差异`);
      lines.push(...details.slice(0, MAX_MODELS));
      if (details.length > MAX_MODELS) lines.push(`    …另有 ${details.length - MAX_MODELS} 个`);
    }
  }

  if (lines.length === 1 && lines[0].startsWith('  fetched_at:')) {
    lines.push('  （仅 fetched_at 不同——快照过期了，重跑生成脚本即可）');
  }
  return { lines, changedProviders, changedModels };
}

function toRecordMap(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

/** --check：与仓库现有文件比对，一致返回 0，不一致返回 1。 */
async function checkDrift(snapshot) {
  let text;
  try {
    text = await readFile(OUT_PATH, 'utf8');
  } catch {
    process.stderr.write(`drift: ${OUT_REL} 不存在——先跑 node ${GENERATOR} 生成\n`);
    return 1;
  }
  let existing;
  try {
    existing = JSON.parse(text);
  } catch (err) {
    process.stderr.write(
      `drift: ${OUT_REL} 不是合法 JSON（${err instanceof Error ? err.message : String(err)}）\n`,
    );
    return 1;
  }
  if (isDeepStrictEqual(existing, snapshot)) {
    console.log(`ok: ${OUT_REL} 与最新上游一致`);
    return 0;
  }
  const { lines, changedProviders, changedModels } = reportDrift(snapshot, existing);
  console.log(
    `drift: ${OUT_REL} 已过期（${changedProviders} 个 provider、${changedModels} 个模型有差异）——重跑 node ${GENERATOR}`,
  );
  for (const line of lines) console.log(line);
  return 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allowlist = resolveAllowlist(options.providers);
  const fetchedAt = todayUtc();

  const upstream = await fetchUpstream();
  if (upstream === null || typeof upstream !== 'object' || Array.isArray(upstream)) {
    fail(`${SOURCE_URL} 顶层不是对象——上游结构不符合预期`);
  }

  const providers = {};
  let modelsKept = 0;
  for (const id of allowlist) {
    const provider = upstream[id];
    if (provider === undefined || provider === null || typeof provider !== 'object') {
      warn(`allowlist 里的 provider "${id}" 在上游不存在，已跳过`);
      continue;
    }
    const normalized = normalizeProvider(id, provider, fetchedAt, upstream);
    providers[id] = normalized;
    modelsKept += normalized['models'].length;
  }

  const snapshot = buildSnapshot(providers, fetchedAt);
  const json = serialize(snapshot);

  if (options.check) {
    process.exitCode = await checkDrift(snapshot);
    return;
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, json, 'utf8');
  const bytes = Buffer.byteLength(json, 'utf8');
  console.log(
    `wrote ${OUT_REL}: ${Object.keys(providers).length} providers, ${modelsKept} models, ${bytes} bytes`,
  );
}

await main();
