/**
 * providers/mimo/discovery.ts —— MiMo `GET /models` 模型发现。
 *
 * 为什么需要它：能力矩阵里的机读字段（上下文窗口、模态、effort 档位）手写一份**必然
 * 过期**——模型迭代、窗口调整都不会通知我们。DeepSeek 的 `/models` 把这些元数据作为
 * 一等公民返回，所以那边有完整的 overlay 刷新；**MiMo 的 `/models` 只返回
 * `id` / `object` / `owned_by`**（2026-11-16 实测），没有任何可刷新的机读字段。
 *
 * 因此本文件的职责比 DeepSeek 侧窄得多，也**不假装有 overlay**：
 *   - `decodeModelsResponse`：把 `/models` 响应解成元数据数组（防御式，未知顶层键进 raw）；
 *   - `refresh`：把上游出现的模型登记进矩阵（merge 语义：已知模型不动，未知模型补登），
 *     让"上游新增了模型"这件事不需要改代码就能路由；
 *   - **没有** `modelMetadataOverlay`：上游一个机读字段都不给，写一个恒返回 `{}` 的
 *     函数只是装饰（di/ports.ts 的同款立场：返回 undefined = 不干预）。
 *
 * 与 DeepSeek 侧的分工：两边各自一个 discovery 类，不抽象基类——刷新策略不同
 * （DeepSeek 要覆盖机读字段，MiMo 只补登模型 id），硬合到一起会出现"为什么这个字段
 * 在 DeepSeek 那边刷新了在 MiMo 这边没有"的分裂。
 */

import type { CapabilityEntry } from '../../ir/index.js';
import type { Transport } from '../../gateway-core/transport.js';
import { MIMO_ACCESS_PATHS } from './profile.js';

/** `/models` 返回的单模型元数据（**只建模上游真的返回的三个字段**）。 */
export interface MiMoModelMetadata {
  id: string;
  object?: string;
  owned_by?: string;
  /** 该模型在上游响应里的**原始记录**（含我们未建模的键；未建模字段显式保留）。 */
  raw?: Record<string, unknown>;
}

/** `/models` 响应体（`{object: "list", data: [...]}`）。 */
export interface MiMoModelsResponse {
  object?: string;
  data: MiMoModelMetadata[];
  raw?: unknown;
}

export const MIMO_MODELS_PATH = '/models';

/**
 * `/models` 响应 → 元数据数组（防御式：绝不因怪形状抛错，未知顶层键进 `raw`）。
 *
 * 单条模型记录不是对象 / 缺 id 时**跳过该条**而不是整批失败——一个畸形条目不该让
 * 整个发现流程失效（20 §S1 前向兼容的同立场）。
 */
export function decodeModelsResponse(raw: unknown): MiMoModelsResponse {
  const obj = asRecord(raw);
  if (obj === undefined) return { data: [], raw };
  const data: MiMoModelMetadata[] = [];
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

function normalizeModel(id: string, rec: Record<string, unknown>): MiMoModelMetadata {
  const out: MiMoModelMetadata = { id, raw: rec };
  if (typeof rec['object'] === 'string') out.object = rec['object'];
  if (typeof rec['owned_by'] === 'string') out.owned_by = rec['owned_by'];
  return out;
}

/** 能力矩阵的**最小读接口**（不 import 具体实现，避免 providers 反向依赖）。 */
export interface CapabilityRegistryWriter {
  find(accessPath: string, model: string, modality: 'chat'): CapabilityEntry | undefined;
  register(entry: CapabilityEntry): void;
}

export interface DiscoveryRefreshResult {
  /** 本次从 /models 拿到的模型 id。 */
  discovered: string[];
  /** 新登记的（静态表里没有的）(access_path, model)。 */
  added: string[];
}

/**
 * MiMo 模型发现：拉 `/models` 并补登新模型。
 *
 * 只补 **chat 模态**：音频模型（mimo-v2.5-asr / mimo-v2.5-tts*）的 (access_path,
 * modality) 是 `mimo.tools.*` 而不是 `mimo.openai-chat`，由 audio-models.ts 的静态表
 * 登记——给它们编一条 openai-chat 条目会让路由以为能用 chat 方言打 ASR。
 *
 * `preloaded` 允许调用方传入**已经拉到的** `/models` 响应（`/v1/models` 的同步链路
 * 既要刷新矩阵、又要拿同一份响应当元数据快照），省略时内部自己拉。
 */
export class MiMoModelDiscovery {
  constructor(
    private readonly deps: {
      transport: Transport;
      headersProvider: () => Promise<Record<string, string>>;
      baseUrl?: string;
      path?: string;
    },
  ) {}

  /** 拉一次 /models；非 2xx 或坏 JSON 时抛错（调用方决定降级策略）。 */
  async discover(): Promise<MiMoModelsResponse> {
    const res = await this.deps.transport.send({
      method: 'GET',
      base_url: this.deps.baseUrl ?? 'https://token-plan-cn.xiaomimimo.com',
      path: this.deps.path ?? MIMO_MODELS_PATH,
      headers: {
        accept: 'application/json',
        ...(await this.deps.headersProvider()),
      },
      stream: false,
    });
    const bodyText = res.body?.toString('utf8') ?? '';
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`MiMo /models 返回 ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch (err) {
      throw new Error(
        `MiMo /models 响应不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return decodeModelsResponse(parsed);
  }

  /**
   * 发现 + 补登矩阵（merge 语义，见文件头）。
   *
   * 已知模型**不动**：MiMo 的 `/models` 不给机读字段，没有可覆盖的东西；而 quirks /
   * status / contract_tested 是"我们测过什么"的记录，不该被上游元数据改写。
   */
  async refresh(
    registry: CapabilityRegistryWriter,
    preloaded?: MiMoModelsResponse,
  ): Promise<DiscoveryRefreshResult> {
    const response = preloaded ?? (await this.discover());
    const result: DiscoveryRefreshResult = { discovered: [], added: [] };
    for (const meta of response.data) {
      result.discovered.push(meta.id);
      if (registry.find(MIMO_ACCESS_PATHS.openaiChat, meta.id, 'chat') !== undefined) continue;
      registry.register({
        access_path: MIMO_ACCESS_PATHS.openaiChat,
        model: meta.id,
        modality: 'chat',
        format: 'openai.chat',
        usage_source: 'provider',
        usage_units: ['tokens'],
        quirks: [
          'auto-discovered: 由 GET /models 自动登记，尚未补契约测试',
          '上游 /models 只返回 id/object/owned_by，没有 context_window 等机读字段',
        ],
        contract_tested: false,
        status: 'implemented',
      });
      result.added.push(`${MIMO_ACCESS_PATHS.openaiChat}/${meta.id}`);
    }
    return result;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
