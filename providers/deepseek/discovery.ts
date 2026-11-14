/**
 * providers/deepseek/discovery.ts —— DeepSeek `GET /models` 模型发现。
 *
 * 为什么需要它：能力矩阵里的机读字段（上下文窗口、模态、effort 档位、上游声明的行为
 * 约束）手写一份**必然过期**——模型迭代、窗口调整、约束新增都不会通知我们。DeepSeek
 * 的 `/models` 端点把这些元数据作为一等公民返回（2026-11-13 全家桶发布后加入
 * `api_capabilities`），所以启动时/手动触发时拉一次，用实时值刷新矩阵。
 *
 * 价格**不在** `/models` 里（已核实：没有任何官方 API 提供峰谷规则或实时价格，
 * 价格只公布在官方价格页），所以价格走仓库内静态表 + 点时间解析，见 pricing.ts。
 *
 * 刷新语义（merge，不是 replace）：
 *   - 已知模型：只覆盖机读字段（context_window / max_output_tokens / modalities /
 *     effort / constraints），静态表里的 quirks / unsupported_fields / status /
 *     contract_tested 保持不动（那些是"我们测过什么"的记录，不该被上游元数据改写）；
 *   - 未知模型：登记新条目（status: implemented、contract_tested: false + quirk 注明
 *     "auto-discovered"），让新模型立即可路由；价格查不到时计费侧记 pending_price。
 *
 * 与能力矩阵的关系：矩阵（credentials/capability-registry）是这些约束的登记处，
 * adaptor 编码时按 (access_path, model) 读它并执行（见 adaptors/anthropic-messages/
 * codec.ts 的 enforceSystemPromptConstraint / enforceToolUpdateConstraint）。
 */

import type { CapabilityEntry, ModelConstraints } from '../../ir/index.js';
import type { Transport } from '../../gateway-core/transport.js';
import { DEEPSEEK_ACCESS_PATHS, DEEPSEEK_MODEL_META, type DeepSeekModelMeta } from './profile.js';

/** `/models` 返回的单模型元数据（官方 schema，全部可选字段按实测保留）。 */
export interface DeepSeekModelMetadata {
  id: string;
  object?: string;
  owned_by?: string;
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: Array<'text' | 'image'>;
  output_modalities?: Array<'text'>;
  effort?: { supported_levels: string[]; default_level?: string };
  /**
   * 上游按 protocol 声明的行为约束。当前只有 `anthropic_messages` 一个 key：
   * `{system_prompt_update: 'leading-only'|'in-history', tool_update: 'leading-only'|'addition-only'}`。
   * 注意官方 schema 目前只文档化了 system_prompt_update；tool_update 在实测返回里
   * 存在（2026-11-14 实测），按实测收。
   */
  api_capabilities?: {
    anthropic_messages?: {
      system_prompt_update?: 'leading-only' | 'in-history';
      tool_update?: 'leading-only' | 'addition-only';
    };
  };
}

/** `/models` 响应体（`{object: "list", data: [...]}`）。 */
export interface DeepSeekModelsResponse {
  object?: string;
  data: DeepSeekModelMetadata[];
  raw?: unknown;
}

export const DEEPSEEK_MODELS_PATH = '/models';

/**
 * `/models` 响应 → 元数据数组（防御式：绝不因怪形状抛错，未知顶层键进 `raw`）。
 *
 * 单条模型记录不是对象 / 缺 id 时**跳过该条**而不是整批失败——一个畸形条目不该让
 * 整个发现流程失效（20 §S1 前向兼容的同立场）。
 */
export function decodeModelsResponse(raw: unknown): DeepSeekModelsResponse {
  const obj = asRecord(raw);
  if (obj === undefined) return { data: [], raw };
  const data: DeepSeekModelMetadata[] = [];
  const arr = obj['data'];
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      const rec = asRecord(entry);
      if (rec === undefined) continue;
      const id = typeof rec['id'] === 'string' ? rec['id'] : undefined;
      if (id === undefined || id === '') continue;
      data.push(normalizeModel(id, rec));
    }
  }
  return { ...(typeof obj['object'] === 'string' ? { object: obj['object'] } : {}), data, raw };
}

function normalizeModel(id: string, rec: Record<string, unknown>): DeepSeekModelMetadata {
  const out: DeepSeekModelMetadata = { id };
  if (typeof rec['object'] === 'string') out.object = rec['object'];
  if (typeof rec['owned_by'] === 'string') out.owned_by = rec['owned_by'];
  if (typeof rec['name'] === 'string') out.name = rec['name'];
  if (typeof rec['context_window'] === 'number') out.context_window = rec['context_window'];
  if (typeof rec['max_output_tokens'] === 'number') {
    out.max_output_tokens = rec['max_output_tokens'];
  }
  const inputModalities = rec['input_modalities'];
  if (Array.isArray(inputModalities)) {
    out.input_modalities = inputModalities.filter(
      (m): m is 'text' | 'image' => m === 'text' || m === 'image',
    );
  }
  const outputModalities = rec['output_modalities'];
  if (Array.isArray(outputModalities)) {
    out.output_modalities = outputModalities.filter((m): m is 'text' => m === 'text');
  }
  const effort = asRecord(rec['effort']);
  if (effort !== undefined && Array.isArray(effort['supported_levels'])) {
    out.effort = {
      supported_levels: effort['supported_levels'].filter(
        (l): l is string => typeof l === 'string',
      ),
      ...(typeof effort['default_level'] === 'string'
        ? { default_level: effort['default_level'] }
        : {}),
    };
  }
  const apiCapabilities = asRecord(rec['api_capabilities']);
  const anthropicMessages = asRecord(apiCapabilities?.['anthropic_messages']);
  if (anthropicMessages !== undefined) {
    const constraints: NonNullable<
      NonNullable<DeepSeekModelMetadata['api_capabilities']>['anthropic_messages']
    > = {};
    const spu = anthropicMessages['system_prompt_update'];
    if (spu === 'leading-only' || spu === 'in-history') {
      constraints.system_prompt_update = spu;
    }
    const tu = anthropicMessages['tool_update'];
    if (tu === 'leading-only' || tu === 'addition-only') {
      constraints.tool_update = tu;
    }
    if (Object.keys(constraints).length > 0) {
      out.api_capabilities = { anthropic_messages: constraints };
    }
  }
  return out;
}

/**
 * 机读元数据 → CapabilityEntry 的**覆盖字段**（只含 /models 能提供的字段）。
 *
 * 约束只贴 Anthropic 方言：`api_capabilities.anthropic_messages` 的 key 名就说明了
 * 作用域——OpenAI 兼容面没有对应声明，给它编一个约束等于猜测。
 */
export function modelMetadataOverlay(
  meta: DeepSeekModelMetadata,
  dialect: 'openai.chat' | 'anthropic.messages',
): Partial<CapabilityEntry> {
  const out: Partial<CapabilityEntry> = {};
  if (meta.context_window !== undefined) out.context_window = meta.context_window;
  if (meta.max_output_tokens !== undefined) out.max_output_tokens = meta.max_output_tokens;
  if (meta.input_modalities !== undefined) out.input_modalities = [...meta.input_modalities];
  if (meta.output_modalities !== undefined) out.output_modalities = [...meta.output_modalities];
  if (meta.effort !== undefined) {
    out.effort = { ...meta.effort, supported_levels: [...meta.effort.supported_levels] };
  }
  if (dialect === 'anthropic.messages') {
    const declared = meta.api_capabilities?.anthropic_messages;
    const constraints: ModelConstraints = {};
    if (declared?.system_prompt_update !== undefined) {
      constraints.system_prompt_update = declared.system_prompt_update;
    }
    if (declared?.tool_update !== undefined) constraints.tool_update = declared.tool_update;
    if (Object.keys(constraints).length > 0) out.constraints = constraints;
  }
  return out;
}

/** 能力矩阵的**最小读接口**（不 import 具体实现，避免 adaptors/providers 反向依赖）。 */
export interface CapabilityRegistryWriter {
  find(accessPath: string, model: string, modality: 'chat'): CapabilityEntry | undefined;
  register(entry: CapabilityEntry): void;
}

export interface DiscoveryRefreshResult {
  /** 本次从 /models 拿到的模型 id。 */
  discovered: string[];
  /** 刷新了机读字段的 (access_path, model)。 */
  updated: string[];
  /** 新登记的（静态表里没有的）(access_path, model)。 */
  added: string[];
}

/**
 * DeepSeek 模型发现：拉 `/models` 并刷新能力矩阵。
 *
 * 依赖全部注入（Transport + headersProvider）：不起模块级单例、不读 process.env。
 */
export class DeepSeekModelDiscovery {
  constructor(
    private readonly deps: {
      transport: Transport;
      headersProvider: () => Promise<Record<string, string>>;
      baseUrl?: string;
      path?: string;
    },
  ) {}

  /** 拉一次 /models；非 2xx 或坏 JSON 时抛错（调用方决定降级策略）。 */
  async discover(): Promise<DeepSeekModelsResponse> {
    const res = await this.deps.transport.send({
      method: 'GET',
      base_url: this.deps.baseUrl ?? 'https://api.deepseek.com',
      path: this.deps.path ?? DEEPSEEK_MODELS_PATH,
      headers: {
        accept: 'application/json',
        ...(await this.deps.headersProvider()),
      },
      stream: false,
    });
    const bodyText = res.body?.toString('utf8') ?? '';
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`DeepSeek /models 返回 ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(
        `DeepSeek /models 响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return decodeModelsResponse(parsed);
  }

  /**
   * 发现 + 刷新矩阵（merge 语义，见文件头）。
   *
   * 对每个模型 × 每个 dialect 各刷一条；静态表里没有的模型补登新条目
   * （contract_tested: false——我们还没为它写过契约测试，状态诚实）。
   */
  async refresh(registry: CapabilityRegistryWriter): Promise<DiscoveryRefreshResult> {
    const response = await this.discover();
    const result: DiscoveryRefreshResult = { discovered: [], updated: [], added: [] };
    for (const meta of response.data) {
      result.discovered.push(meta.id);
      for (const [accessPath, format] of [
        [DEEPSEEK_ACCESS_PATHS.openaiChat, 'openai.chat'],
        [DEEPSEEK_ACCESS_PATHS.anthropicMessages, 'anthropic.messages'],
      ] as const) {
        const overlay = modelMetadataOverlay(meta, format);
        const existing = registry.find(accessPath, meta.id, 'chat');
        if (existing !== undefined) {
          registry.register({ ...existing, ...overlay });
          result.updated.push(`${accessPath}/${meta.id}`);
          continue;
        }
        registry.register({
          access_path: accessPath,
          model: meta.id,
          modality: 'chat',
          format,
          usage_source: 'provider',
          usage_units: ['tokens'],
          ...overlay,
          quirks: [
            'auto-discovered: 由 GET /models 自动登记，尚未补契约测试与静态定价表条目',
            ...(meta.input_modalities?.includes('image') ? ['支持图像输入'] : []),
          ],
          contract_tested: false,
          status: 'implemented',
        });
        result.added.push(`${accessPath}/${meta.id}`);
      }
    }
    return result;
  }
}

/**
 * 静态种子元数据（profile.ts 的 DEEPSEEK_MODEL_META）→ 与 /models 同构的元数据。
 *
 * 用途：没有网络/没有 key 时（测试、离线装配）也能得到同一份元数据形状；
 * discovery 上线后以 /models 的实时返回为准。
 */
export function staticModelMetadata(): DeepSeekModelMetadata[] {
  return Object.values(DEEPSEEK_MODEL_META).map(toMetadata);
}

export function toMetadata(meta: DeepSeekModelMeta): DeepSeekModelMetadata {
  return {
    id: meta.id,
    name: meta.display_name,
    context_window: meta.context_window,
    max_output_tokens: meta.max_output_tokens,
    input_modalities: [...meta.input_modalities],
    output_modalities: [...meta.output_modalities],
    effort: { ...meta.effort, supported_levels: [...meta.effort.supported_levels] },
    api_capabilities: {
      anthropic_messages: {
        system_prompt_update: meta.constraints.system_prompt_update,
        tool_update: meta.constraints.tool_update,
      },
    },
  };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
