/**
 * gateway-core/routing-engine.ts —— 图 + 沙盒 VM-JS 路由引擎。
 *
 * 允许用户以有向无环图（DAG）自定义模型标识符：
 *   - `entry`：入口节点；
 *   - `condition`：免写 JS 的声明式请求条件分支（含图/含工具/思考开关/Token 范围/格式/关键词）；
 *   - `js_script`：在隔离 `node:vm` 沙盒中运行的轻量 JS 路由脚本（可读取只读的 canonical
 *     消息摘要与服务商余额/积分/5h 用量遥测，返回分支端口、目标节点或参数覆盖）；
 *   - `provider_target`：目标渠道与模型，支持各服务商注入的声明式过滤条件（5h 限额、
 *     账户余额、Token Plan 积分、闲时时段等）、能力预检、参数覆盖以及 `fallback` 备选边。
 *
 * 严格遵守架构解耦约束：本文件不 import `providers/*`。
 */

import vm from 'node:vm';
import type {
  Attempt,
  CanonicalRequestEnvelope,
  FormatId,
  ModalityKind,
  RequestContext,
  RouteParamOverrides,
} from '../ir/index.js';
import { asChatPayload } from '../ir/index.js';
import type { CapabilityRegistry } from '../credentials/capability-registry.js';
import type { CredentialResolver } from '../credentials/resolver.js';
import type {
  ProviderExtensionPointSpec,
  ProviderRoutingOptionSpec,
} from '../di/ports.js';
import type {
  ProviderTelemetrySnapshot,
  RoutingTelemetryHub,
} from './routing-telemetry.js';

export interface RouteConditionConfig {
  has_images?: boolean;
  has_tools?: boolean;
  thinking_enabled?: boolean;
  min_estimated_tokens?: number;
  max_estimated_tokens?: number;
  client_formats?: FormatId[];
  message_contains?: string;
}

export interface RouteScriptConfig {
  code: string;
  timeout_ms?: number;
  ports?: string[];
}

export interface RouteTargetConfig {
  provider: string;
  access_path: string;
  model: string;
  max_context_tokens?: number;
  require_vision?: boolean;
  /** 服务商注入选项与通用 5h 窗口选项键值对。 */
  provider_options?: Record<string, number | boolean | string>;
  /** 命中该目标节点时附加到 canonical 请求的参数覆盖。 */
  overrides?: RouteParamOverrides;
}

export type RouteGraphNode =
  | {
      id: string;
      kind: 'entry';
      label: string;
      position: { x: number; y: number };
    }
  | {
      id: string;
      kind: 'condition';
      label: string;
      position: { x: number; y: number };
      condition: RouteConditionConfig;
      hook_script?: RouteScriptConfig;
    }
  | {
      id: string;
      kind: 'js_script';
      label: string;
      position: { x: number; y: number };
      script: RouteScriptConfig;
      hook_script?: RouteScriptConfig;
    }
  | {
      id: string;
      kind: 'provider_target';
      label: string;
      position: { x: number; y: number };
      target: RouteTargetConfig;
      hook_script?: RouteScriptConfig;
      extension_ports?: string[];
    };

export interface RouteGraphEdge {
  id: string;
  from: string;
  /** `'next' | 'true' | 'false' | 'fallback' | <custom js port>` */
  from_port: string;
  to: string;
  priority: number;
  label?: string;
}

export type RouteGraphAbilityMode = 'min' | 'max' | 'custom';

export interface RouteGraphAbilities {
  tool_call?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  attachment?: boolean;
  input_modalities?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>;
  output_modalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  context_window?: number;
  max_output_tokens?: number;
}

export interface RouteGraph {
  id: string;
  label: string;
  enabled: boolean;
  entry_node_id: string;
  nodes: RouteGraphNode[];
  edges: RouteGraphEdge[];
  /** 对外暴露的模型能力聚合模式：min=所有目标交集(默认) | max=所有目标并集 | custom=自定义 */
  ability_mode?: RouteGraphAbilityMode;
  abilities?: RouteGraphAbilities;
  note?: string;
  created_at?: number;
  updated_at?: number;
}

export interface RouteEvalStep {
  node_id: string;
  node_label: string;
  kind: RouteGraphNode['kind'];
  outcome: 'entered' | 'matched' | 'unmatched' | 'branch' | 'selected' | 'skipped' | 'error';
  port?: string;
  detail: string;
}

export interface RouteGraphEvaluationResult {
  ok: boolean;
  candidates: Attempt[];
  trace: RouteEvalStep[];
  error?: string;
}

export interface RouteGraphRegistry {
  get(id: string): RouteGraph | undefined;
  list(): RouteGraph[];
  setGraphs(graphs: readonly RouteGraph[]): void;
  upsert(graph: RouteGraph): void;
  remove(id: string): boolean;
}

export class InMemoryRouteGraphRegistry implements RouteGraphRegistry {
  private readonly graphs = new Map<string, RouteGraph>();

  constructor(initial: readonly RouteGraph[] = []) {
    this.setGraphs(initial);
  }

  get(id: string): RouteGraph | undefined {
    const found = this.graphs.get(id);
    return found === undefined ? undefined : cloneRouteGraph(found);
  }

  list(): RouteGraph[] {
    return [...this.graphs.values()].map(cloneRouteGraph);
  }

  setGraphs(graphs: readonly RouteGraph[]): void {
    this.graphs.clear();
    for (const g of graphs) {
      this.graphs.set(g.id, cloneRouteGraph(g));
    }
  }

  upsert(graph: RouteGraph): void {
    this.graphs.set(graph.id, cloneRouteGraph(graph));
  }

  remove(id: string): boolean {
    return this.graphs.delete(id);
  }
}

export function cloneRouteGraph(graph: RouteGraph): RouteGraph {
  return JSON.parse(JSON.stringify(graph)) as RouteGraph;
}

// ---------------------------------------------------------------------------
// 校验（存储前拦截：坏图、成环、JS 语法错误）
// ---------------------------------------------------------------------------

export const ROUTE_GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateRouteGraph(graph: RouteGraph): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!graph.id || !ROUTE_GRAPH_ID_PATTERN.test(graph.id)) {
    errors.push('路由图标识符 id 须以字母或数字开头，仅含字母/数字/点/下划线/短横线，最长 64 字符');
  }
  if (!graph.label || graph.label.trim().length === 0) {
    errors.push('路由图名称 label 不能为空');
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    errors.push('路由图至少包含一个节点');
    return { ok: false, errors };
  }

  const nodeById = new Map<string, RouteGraphNode>();
  for (const node of graph.nodes) {
    if (!node.id || node.id.trim().length === 0) {
      errors.push('存在空节点 id');
      continue;
    }
    if (nodeById.has(node.id)) {
      errors.push(`节点 id 重复: ${node.id}`);
      continue;
    }
    nodeById.set(node.id, node);

    if (node.kind !== 'entry' && node.hook_script !== undefined && node.hook_script.code.trim() !== '') {
      try {
        new vm.Script(wrapJsCode(node.hook_script.code));
      } catch (err) {
        errors.push(
          `节点 ${node.id} 前置脚本语法错误: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (node.kind === 'js_script') {
      const code = node.script?.code ?? '';
      if (code.trim().length === 0) {
        errors.push(`脚本节点 ${node.id} 代码不能为空`);
      } else {
        try {
          new vm.Script(wrapJsCode(code));
        } catch (err) {
          errors.push(
            `脚本节点 ${node.id} 语法错误: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else if (node.kind === 'provider_target') {
      if (!node.target?.provider || !node.target?.access_path || !node.target?.model) {
        errors.push(`目标节点 ${node.id} 必须指定 provider、access_path 和 model`);
      }
    }
  }

  const entryNode = nodeById.get(graph.entry_node_id);
  if (entryNode === undefined) {
    errors.push(`入口节点不存在: ${graph.entry_node_id}`);
  } else if (entryNode.kind !== 'entry') {
    errors.push(`入口节点 ${graph.entry_node_id} 类型必须为 entry`);
  }

  const edgeIds = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges ?? []) {
    if (!edge.id || edge.id.trim().length === 0) {
      errors.push('存在空连线 id');
      continue;
    }
    if (edgeIds.has(edge.id)) {
      errors.push(`连线 id 重复: ${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (!nodeById.has(edge.from)) {
      errors.push(`连线 ${edge.id} 的起点节点不存在: ${edge.from}`);
    }
    if (!nodeById.has(edge.to)) {
      errors.push(`连线 ${edge.id} 的终点节点不存在: ${edge.to}`);
    }
    if (edge.from === edge.to) {
      errors.push(`连线 ${edge.id} 不能自环指向自身 (${edge.from})`);
    }
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  // 三色 DFS 判环（严格保证 DAG）
  const color = new Map<string, 0 | 1 | 2>();
  const hasCycle = (u: string): boolean => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) return true;
      if (c === 0 && hasCycle(v)) return true;
    }
    color.set(u, 2);
    return false;
  };
  for (const id of nodeById.keys()) {
    if ((color.get(id) ?? 0) === 0 && hasCycle(id)) {
      errors.push('路由图检测到环路（必须为有向无环图 DAG）');
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// canonical 特征抽取 + 参数覆盖
// ---------------------------------------------------------------------------

export interface CanonicalRequestFeatures {
  model: string;
  modality: ModalityKind;
  stream: boolean;
  client_format: FormatId;
  has_images: boolean;
  has_tools: boolean;
  thinking_enabled: boolean;
  estimated_tokens: number;
  message_count: number;
  last_user_text: string;
  system_text: string;
  all_text: string;
  messages: Array<{ role: string; text: string; has_images: boolean; part_types: string[] }>;
  params: Record<string, unknown>;
  thinking: Record<string, unknown> | undefined;
}

export interface SimulationOverrides {
  has_images?: boolean;
  has_tools?: boolean;
  thinking_enabled?: boolean;
  estimated_tokens?: number;
  telemetry_overrides?: Record<string, Partial<ProviderTelemetrySnapshot>>;
}

export function extractCanonicalFeatures(
  canonical: CanonicalRequestEnvelope | undefined,
  meta: {
    model: string;
    modality: ModalityKind;
    stream: boolean;
    client_format: FormatId;
  },
  simOverrides?: SimulationOverrides,
): CanonicalRequestFeatures {
  let hasImages = false;
  let hasTools = false;
  let thinkingEnabled = false;
  let totalChars = 0;
  let systemText = '';
  let lastUserText = '';
  const textChunks: string[] = [];
  const simplifiedMessages: CanonicalRequestFeatures['messages'] = [];
  let params: Record<string, unknown> = {};
  let thinkingObj: Record<string, unknown> | undefined;

  if (canonical !== undefined && canonical.kind === 'chat') {
    const payload = asChatPayload(canonical);
    if (payload !== undefined) {
      params = { ...(payload.params ?? {}) } as Record<string, unknown>;
      thinkingObj =
        payload.params?.thinking === undefined
          ? undefined
          : ({ ...payload.params.thinking } as Record<string, unknown>);
      thinkingEnabled = payload.params?.thinking?.enabled === true;
      hasTools = (payload.tools?.length ?? 0) > 0;
      if (hasTools) {
        totalChars += JSON.stringify(payload.tools).length;
      }

      const sysParts: string[] = [];
      for (const block of payload.system ?? []) {
        sysParts.push(block.text);
        totalChars += block.text.length;
      }
      systemText = sysParts.join('\n');
      if (systemText !== '') textChunks.push(systemText);

      for (const msg of payload.messages ?? []) {
        const msgTexts: string[] = [];
        let msgImages = false;
        const partTypes: string[] = [];
        for (const p of msg.parts ?? []) {
          partTypes.push(p.type);
          if (p.type === 'text') {
            msgTexts.push(p.text);
            totalChars += p.text.length;
          } else if (p.type === 'image') {
            hasImages = true;
            msgImages = true;
            totalChars += 1000;
          } else if (p.type === 'document' && p.media_type?.startsWith('image/')) {
            hasImages = true;
            msgImages = true;
            totalChars += 1000;
          } else if (p.type === 'tool_use') {
            totalChars += JSON.stringify(p.input ?? {}).length + p.name.length;
          } else if (p.type === 'tool_result') {
            totalChars += JSON.stringify(p.content ?? '').length;
          }
        }
        const joined = msgTexts.join('\n');
        if (joined !== '') textChunks.push(joined);
        if (msg.role === 'user') lastUserText = joined;
        simplifiedMessages.push({
          role: msg.role,
          text: joined,
          has_images: msgImages,
          part_types: partTypes,
        });
      }
    }
  }

  const estimatedTokens =
    simOverrides?.estimated_tokens ?? Math.max(1, Math.ceil(totalChars / 4));

  return {
    model: meta.model,
    modality: meta.modality,
    stream: meta.stream,
    client_format: meta.client_format,
    has_images: simOverrides?.has_images ?? hasImages,
    has_tools: simOverrides?.has_tools ?? hasTools,
    thinking_enabled: simOverrides?.thinking_enabled ?? thinkingEnabled,
    estimated_tokens: estimatedTokens,
    message_count: simplifiedMessages.length,
    last_user_text: lastUserText,
    system_text: systemText,
    all_text: textChunks.join('\n'),
    messages: simplifiedMessages,
    params,
    thinking: thinkingObj,
  };
}

/** 非破坏性地克隆并把路由节点覆盖参数写入 CanonicalRequestEnvelope。 */
export function applyRouteParamOverrides(
  req: CanonicalRequestEnvelope,
  overrides?: RouteParamOverrides,
): CanonicalRequestEnvelope {
  if (overrides === undefined) return req;
  const cloned = JSON.parse(JSON.stringify(req)) as CanonicalRequestEnvelope;
  if (cloned.kind !== 'chat') return cloned;
  const payload = asChatPayload(cloned);
  if (payload === undefined) return cloned;

  if (
    overrides.thinking_enabled !== undefined ||
    overrides.thinking_effort !== undefined ||
    overrides.thinking_budget_tokens !== undefined
  ) {
    const prevThinking = payload.params?.thinking;
    payload.params = {
      ...(payload.params ?? {}),
      thinking: {
        enabled: overrides.thinking_enabled ?? prevThinking?.enabled ?? true,
        ...(overrides.thinking_effort !== undefined
          ? { effort: overrides.thinking_effort }
          : prevThinking?.effort !== undefined
            ? { effort: prevThinking.effort }
            : {}),
        ...(overrides.thinking_budget_tokens !== undefined
          ? { budget_tokens: overrides.thinking_budget_tokens }
          : prevThinking?.budget_tokens !== undefined
            ? { budget_tokens: prevThinking.budget_tokens }
            : {}),
      },
    };
  }

  if (
    overrides.temperature !== undefined ||
    overrides.top_p !== undefined ||
    overrides.max_output_tokens !== undefined
  ) {
    payload.params = {
      ...(payload.params ?? {}),
      ...(overrides.temperature === undefined ? {} : { temperature: overrides.temperature }),
      ...(overrides.top_p === undefined ? {} : { top_p: overrides.top_p }),
      ...(overrides.max_output_tokens === undefined
        ? {}
        : { max_output_tokens: overrides.max_output_tokens }),
    };
  }

  if (overrides.system_prompt_append !== undefined && overrides.system_prompt_append.trim() !== '') {
    payload.system = [...(payload.system ?? []), { text: overrides.system_prompt_append }];
  }

  return cloned;
}

// ---------------------------------------------------------------------------
// 沙盒 VM-JS 执行
// ---------------------------------------------------------------------------

function wrapJsCode(code: string): string {
  return `(function(ctx, request, canonical, telemetry, credits) {\n"use strict";\n${code}\n})(ctx, ctx.request, ctx.canonical, ctx.telemetry, ctx.credits)`;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) {
    deepFreeze(v);
  }
  return value;
}

export interface JsExecutionOutcome {
  ok: boolean;
  branch?: string;
  target_node_id?: string;
  overrides?: RouteParamOverrides;
  error?: string;
}

export function runSandboxedJsNode(
  code: string,
  timeoutMs: number | undefined,
  features: CanonicalRequestFeatures,
  canonical: CanonicalRequestEnvelope | undefined,
  telemetry: Record<string, ProviderTelemetrySnapshot>,
): JsExecutionOutcome {
  const timeout = Math.min(200, Math.max(5, timeoutMs ?? 50));

  const creditsView: Record<string, unknown> = {};
  for (const [providerId, snap] of Object.entries(telemetry)) {
    creditsView[providerId] = {
      available: snap.available,
      balance: snap.balance,
      granted_balance: snap.granted_balance,
      topped_up_balance: snap.topped_up_balance,
      currency: snap.currency,
      remaining_credits: snap.remaining_credits,
      used_credits: snap.used_credits,
      total_credits: snap.total_credits,
      credit_usage_pct: snap.credit_usage_pct,
      is_off_peak: snap.is_off_peak,
      window_5h: snap.window_5h,
    };
  }

  const telemetryClone = deepFreeze(JSON.parse(JSON.stringify(telemetry)) as Record<string, ProviderTelemetrySnapshot>);
  const ctxObj = deepFreeze({
    request: JSON.parse(JSON.stringify(features)) as CanonicalRequestFeatures,
    canonical: canonical === undefined ? undefined : (JSON.parse(JSON.stringify(canonical)) as CanonicalRequestEnvelope),
    telemetry: telemetryClone,
    credits: deepFreeze(creditsView),
    provider: (id: string) => telemetryClone[id],
  });

  const sandbox = Object.create(null) as Record<string, unknown>;
  sandbox['ctx'] = ctxObj;
  sandbox['Math'] = Math;
  sandbox['JSON'] = JSON;
  sandbox['Number'] = Number;
  sandbox['String'] = String;
  sandbox['Boolean'] = Boolean;
  sandbox['Array'] = Array;
  sandbox['Object'] = Object;

  try {
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    const script = new vm.Script(wrapJsCode(code));
    const result: unknown = script.runInContext(context, { timeout });
    return parseJsResult(result);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseJsResult(result: unknown): JsExecutionOutcome {
  if (typeof result === 'boolean') {
    return { ok: true, branch: result ? 'true' : 'false' };
  }
  if (typeof result === 'string') {
    const trimmed = result.trim();
    return trimmed === '' ? { ok: true, branch: 'next' } : { ok: true, branch: trimmed };
  }
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    const branch = typeof rec['branch'] === 'string' && rec['branch'].trim() !== ''
      ? rec['branch'].trim()
      : undefined;
    const targetNodeId = typeof rec['target_node_id'] === 'string' && rec['target_node_id'].trim() !== ''
      ? rec['target_node_id'].trim()
      : undefined;
    const overrides = parseOverridesObject(rec['overrides']);
    return {
      ok: true,
      ...(branch === undefined ? {} : { branch }),
      ...(targetNodeId === undefined ? {} : { target_node_id: targetNodeId }),
      ...(overrides === undefined ? {} : { overrides }),
    };
  }
  return { ok: true, branch: 'next' };
}

function parseOverridesObject(raw: unknown): RouteParamOverrides | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: RouteParamOverrides = {};
  if (typeof r['thinking_enabled'] === 'boolean') out.thinking_enabled = r['thinking_enabled'];
  if (typeof r['thinking_effort'] === 'string') {
    out.thinking_effort = r['thinking_effort'] as RouteParamOverrides['thinking_effort'];
  }
  if (typeof r['thinking_budget_tokens'] === 'number' && Number.isFinite(r['thinking_budget_tokens'])) {
    out.thinking_budget_tokens = r['thinking_budget_tokens'];
  }
  if (typeof r['temperature'] === 'number' && Number.isFinite(r['temperature'])) {
    out.temperature = r['temperature'];
  }
  if (typeof r['top_p'] === 'number' && Number.isFinite(r['top_p'])) {
    out.top_p = r['top_p'];
  }
  if (typeof r['max_output_tokens'] === 'number' && Number.isFinite(r['max_output_tokens'])) {
    out.max_output_tokens = r['max_output_tokens'];
  }
  if (typeof r['system_prompt_append'] === 'string') {
    out.system_prompt_append = r['system_prompt_append'];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// 声明式条件 & 节点求值
// ---------------------------------------------------------------------------

function matchesCondition(
  cond: RouteConditionConfig,
  features: CanonicalRequestFeatures,
): { matched: boolean; reason: string } {
  if (cond.has_images !== undefined && features.has_images !== cond.has_images) {
    return { matched: false, reason: `has_images=${String(features.has_images)} (期望 ${String(cond.has_images)})` };
  }
  if (cond.has_tools !== undefined && features.has_tools !== cond.has_tools) {
    return { matched: false, reason: `has_tools=${String(features.has_tools)} (期望 ${String(cond.has_tools)})` };
  }
  if (cond.thinking_enabled !== undefined && features.thinking_enabled !== cond.thinking_enabled) {
    return {
      matched: false,
      reason: `thinking_enabled=${String(features.thinking_enabled)} (期望 ${String(cond.thinking_enabled)})`,
    };
  }
  if (cond.min_estimated_tokens !== undefined && features.estimated_tokens < cond.min_estimated_tokens) {
    return {
      matched: false,
      reason: `estimated_tokens=${features.estimated_tokens} < ${cond.min_estimated_tokens}`,
    };
  }
  if (cond.max_estimated_tokens !== undefined && features.estimated_tokens > cond.max_estimated_tokens) {
    return {
      matched: false,
      reason: `estimated_tokens=${features.estimated_tokens} > ${cond.max_estimated_tokens}`,
    };
  }
  if (
    cond.client_formats !== undefined &&
    cond.client_formats.length > 0 &&
    !cond.client_formats.includes(features.client_format)
  ) {
    return {
      matched: false,
      reason: `client_format=${features.client_format} 不在 [${cond.client_formats.join(',')}]`,
    };
  }
  if (cond.message_contains !== undefined && cond.message_contains.trim() !== '') {
    const needle = cond.message_contains.toLowerCase();
    if (!features.all_text.toLowerCase().includes(needle)) {
      return { matched: false, reason: `文本未包含 "${cond.message_contains}"` };
    }
  }
  return { matched: true, reason: '满足全部声明式条件' };
}

function readTelemetryField(
  snap: ProviderTelemetrySnapshot,
  field: ProviderRoutingOptionSpec['telemetry_field'],
): number | boolean | undefined {
  switch (field) {
    case 'balance':
      return snap.balance ?? 0;
    case 'granted_balance':
      return snap.granted_balance ?? 0;
    case 'remaining_credits':
      return snap.remaining_credits ?? 0;
    case 'credit_usage_pct':
      return snap.credit_usage_pct ?? 0;
    case 'window_5h_requests':
      return snap.window_5h.requests;
    case 'window_5h_tokens':
      return snap.window_5h.tokens;
    case 'window_5h_cost_usd':
      return snap.window_5h.cash_usd;
    case 'upstream_remaining_requests':
      return snap.window_5h.upstream_remaining_requests;
    case 'is_off_peak':
      return Boolean(snap.is_off_peak);
  }
}

function checkProviderTargetNode(
  target: RouteTargetConfig,
  features: CanonicalRequestFeatures,
  snap: ProviderTelemetrySnapshot,
  optionSpecs: readonly ProviderRoutingOptionSpec[],
  capabilityRegistry?: CapabilityRegistry,
  modality: ModalityKind = 'chat',
): { ok: boolean; reason: string } {
  if (!snap.available) {
    return { ok: false, reason: `${target.provider} 当前不可用或已禁用` };
  }

  if (target.max_context_tokens !== undefined && features.estimated_tokens > target.max_context_tokens) {
    return {
      ok: false,
      reason: `估算 Token ${features.estimated_tokens} 超出节点上限 ${target.max_context_tokens}`,
    };
  }

  const cap = capabilityRegistry?.find(target.access_path, target.model, modality);
  if (
    target.require_vision === true &&
    features.has_images &&
    cap?.input_modalities !== undefined &&
    !cap.input_modalities.includes('image')
  ) {
    return { ok: false, reason: `${target.model} 不支持图像输入` };
  }

  const configured = target.provider_options ?? {};
  const specMap = new Map(optionSpecs.map((s) => [s.key, s]));

  for (const [key, expected] of Object.entries(configured)) {
    if (expected === undefined || expected === '') continue;
    const spec = specMap.get(key);
    if (spec === undefined) continue;
    // 布尔 false 对仅限闲时类的开关代表「不限制」
    if (spec.type === 'boolean' && expected === false) continue;

    const actual = readTelemetryField(snap, spec.telemetry_field);
    if (actual === undefined) {
      // 上游限流头尚未观测到时，不阻断首次请求
      continue;
    }

    if (spec.operator === 'lte' && typeof actual === 'number' && typeof expected === 'number') {
      if (actual > expected) {
        return { ok: false, reason: `${spec.label}超限: ${actual} > ${expected}` };
      }
    } else if (spec.operator === 'gte' && typeof actual === 'number' && typeof expected === 'number') {
      if (actual < expected) {
        return { ok: false, reason: `${spec.label}不足: ${actual} < ${expected}` };
      }
    } else if (spec.operator === 'eq') {
      if (actual !== expected) {
        return { ok: false, reason: `${spec.label}不满足: ${String(actual)} !== ${String(expected)}` };
      }
    }
  }

  return { ok: true, reason: '条件全部通过' };
}

// ---------------------------------------------------------------------------
// DAG 求值入口
// ---------------------------------------------------------------------------

export interface EvaluateRouteGraphInput {
  model: string;
  modality: ModalityKind;
  stream: boolean;
  client_format: FormatId;
  canonical?: CanonicalRequestEnvelope;
  ctx?: RequestContext;
  telemetryHub?: RoutingTelemetryHub;
  capabilityRegistry?: CapabilityRegistry;
  credentialResolver?: CredentialResolver;
  simulation?: SimulationOverrides;
}

export function evaluateRouteGraph(
  graph: RouteGraph,
  input: EvaluateRouteGraphInput,
): RouteGraphEvaluationResult {
  const trace: RouteEvalStep[] = [];
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const entry = nodeMap.get(graph.entry_node_id);
  if (entry === undefined) {
    return { ok: false, candidates: [], trace, error: `入口节点不存在: ${graph.entry_node_id}` };
  }

  const providersInGraph = Array.from(
    new Set(
      graph.nodes
        .filter((n): n is Extract<RouteGraphNode, { kind: 'provider_target' }> => n.kind === 'provider_target')
        .map((n) => n.target.provider),
    ),
  );

  const telemetrySnapshots: Record<string, ProviderTelemetrySnapshot> = {};
  for (const providerId of providersInGraph) {
    const override = input.simulation?.telemetry_overrides?.[providerId];
    telemetrySnapshots[providerId] =
      input.telemetryHub?.snapshotFor(providerId, override) ?? {
        provider: providerId,
        available: true,
        consecutive_failures: 0,
        window_5h: { requests: 0, tokens: 0, cash_usd: 0 },
        ...override,
      };
  }
  // 把 overrides 里额外出现的 provider 也放进快照（供 JS 脚本直接读模拟字段）
  for (const [providerId, override] of Object.entries(input.simulation?.telemetry_overrides ?? {})) {
    if (telemetrySnapshots[providerId] === undefined) {
      telemetrySnapshots[providerId] =
        input.telemetryHub?.snapshotFor(providerId, override) ?? {
          provider: providerId,
          available: true,
          consecutive_failures: 0,
          window_5h: { requests: 0, tokens: 0, cash_usd: 0 },
          ...override,
        };
    }
  }

  const features = extractCanonicalFeatures(
    input.canonical,
    {
      model: input.model,
      modality: input.modality,
      stream: input.stream,
      client_format: input.client_format,
    },
    input.simulation,
  );

  const outgoingEdges = (nodeId: string, port?: string): RouteGraphEdge[] => {
    const edges = graph.edges.filter((e) => e.from === nodeId && (port === undefined || e.from_port === port));
    return edges.sort((a, b) => a.priority - b.priority);
  };

  interface QueueItem {
    nodeId: string;
    inheritedOverrides?: RouteParamOverrides;
  }

  const queue: QueueItem[] = [{ nodeId: entry.id }];
  const visited = new Set<string>();
  const seenCandidateKey = new Set<string>();
  const candidates: Attempt[] = [];
  let steps = 0;

  while (queue.length > 0 && steps < 64) {
    const item = queue.shift()!;
    if (visited.has(item.nodeId)) continue;
    visited.add(item.nodeId);
    steps += 1;

    const node = nodeMap.get(item.nodeId);
    if (node === undefined) continue;

    if (node.kind === 'entry') {
      trace.push({
        node_id: node.id,
        node_label: node.label,
        kind: node.kind,
        outcome: 'entered',
        port: 'next',
        detail: `进入路由图 ${graph.id}`,
      });
      for (const edge of outgoingEdges(node.id)) {
        queue.push({
          nodeId: edge.to,
          ...(item.inheritedOverrides === undefined ? {} : { inheritedOverrides: item.inheritedOverrides }),
        });
      }
      continue;
    }

    // 执行节点前置 JS 钩子（内联 hook_script + 接入本节点 script 输入端子的 js_script 节点）
    let effectiveOverrides = item.inheritedOverrides;
    const hookScripts: Array<{ label: string; script: RouteScriptConfig }> = [];
    for (const edge of graph.edges) {
      if (edge.to === node.id && edge.from_port === 'script') {
        const srcNode = nodeMap.get(edge.from);
        if (srcNode?.kind === 'js_script' && srcNode.script.code.trim() !== '') {
          hookScripts.push({ label: srcNode.label, script: srcNode.script });
        }
      }
    }
    if (node.hook_script !== undefined && node.hook_script.code.trim() !== '') {
      hookScripts.push({ label: `${node.label}·前置钩子`, script: node.hook_script });
    }
    let blockedByHook = false;
    for (const hs of hookScripts) {
      const hookOutcome = runSandboxedJsNode(
        hs.script.code,
        hs.script.timeout_ms,
        features,
        input.canonical,
        telemetrySnapshots,
      );
      effectiveOverrides = mergeOverrides(effectiveOverrides, hookOutcome.overrides);
      if (!hookOutcome.ok || hookOutcome.branch === 'false') {
        blockedByHook = true;
        trace.push({
          node_id: node.id,
          node_label: node.label,
          kind: node.kind,
          outcome: hookOutcome.ok ? 'skipped' : 'error',
          port: node.kind === 'condition' ? 'false' : 'fallback',
          detail: hookOutcome.ok
            ? `前置脚本 ${hs.label} 拦截`
            : `前置脚本 ${hs.label} 异常: ${hookOutcome.error ?? '未知错误'}`,
        });
        break;
      }
    }
    if (blockedByHook) {
      const redirectPort = node.kind === 'condition' ? 'false' : 'fallback';
      for (const edge of outgoingEdges(node.id, redirectPort)) {
        queue.push({
          nodeId: edge.to,
          ...(effectiveOverrides === undefined ? {} : { inheritedOverrides: effectiveOverrides }),
        });
      }
      continue;
    }

    if (node.kind === 'condition') {
      const check = matchesCondition(node.condition, features);
      const port = check.matched ? 'true' : 'false';
      trace.push({
        node_id: node.id,
        node_label: node.label,
        kind: node.kind,
        outcome: check.matched ? 'matched' : 'unmatched',
        port,
        detail: check.reason,
      });
      const matchedEdges = outgoingEdges(node.id, port);
      const fallbackEdges = matchedEdges.length > 0 ? matchedEdges : outgoingEdges(node.id, 'next');
      for (const edge of fallbackEdges) {
        queue.push({
          nodeId: edge.to,
          ...(effectiveOverrides === undefined ? {} : { inheritedOverrides: effectiveOverrides }),
        });
      }
      continue;
    }

    if (node.kind === 'js_script') {
      const outcome = runSandboxedJsNode(
        node.script.code,
        node.script.timeout_ms,
        features,
        input.canonical,
        telemetrySnapshots,
      );
      const mergedOverrides = mergeOverrides(effectiveOverrides, outcome.overrides);
      if (!outcome.ok) {
        trace.push({
          node_id: node.id,
          node_label: node.label,
          kind: node.kind,
          outcome: 'error',
          port: 'fallback',
          detail: `脚本异常: ${outcome.error ?? '未知错误'}`,
        });
        for (const edge of outgoingEdges(node.id, 'fallback')) {
          queue.push({
            nodeId: edge.to,
            ...(mergedOverrides === undefined ? {} : { inheritedOverrides: mergedOverrides }),
          });
        }
        continue;
      }

      const branch = outcome.branch;
      trace.push({
        node_id: node.id,
        node_label: node.label,
        kind: node.kind,
        outcome: 'branch',
        ...(branch === undefined ? {} : { port: branch }),
        detail: outcome.target_node_id
          ? `直指节点 ${outcome.target_node_id}`
          : `选择分支 ${branch ?? 'next'}`,
      });

      if (outcome.target_node_id !== undefined && nodeMap.has(outcome.target_node_id)) {
        queue.push({
          nodeId: outcome.target_node_id,
          ...(mergedOverrides === undefined ? {} : { inheritedOverrides: mergedOverrides }),
        });
      }

      if (branch !== undefined) {
        const portEdges = outgoingEdges(node.id, branch);
        if (portEdges.length > 0) {
          for (const edge of portEdges) {
            queue.push({
              nodeId: edge.to,
              ...(mergedOverrides === undefined ? {} : { inheritedOverrides: mergedOverrides }),
            });
          }
          continue;
        }
        // 允许脚本直接返回目标节点 ID
        const directEdge = outgoingEdges(node.id).find((e) => e.to === branch);
        if (directEdge !== undefined) {
          queue.push({
            nodeId: directEdge.to,
            ...(mergedOverrides === undefined ? {} : { inheritedOverrides: mergedOverrides }),
          });
          continue;
        }
      }

      if (outcome.target_node_id === undefined) {
        const nextEdges = outgoingEdges(node.id, 'next');
        const backupEdges = nextEdges.length > 0 ? nextEdges : outgoingEdges(node.id, 'fallback');
        for (const edge of backupEdges) {
          queue.push({
            nodeId: edge.to,
            ...(mergedOverrides === undefined ? {} : { inheritedOverrides: mergedOverrides }),
          });
        }
      }
      continue;
    }

    if (node.kind === 'provider_target') {
      const target = node.target;
      const snap = telemetrySnapshots[target.provider] ?? {
        provider: target.provider,
        available: true,
        consecutive_failures: 0,
        window_5h: { requests: 0, tokens: 0, cash_usd: 0 },
      };
      const optionSpecs =
        input.telemetryHub?.optionsForProvider(target.provider, target.access_path) ?? [];
      const check = checkProviderTargetNode(
        target,
        features,
        snap,
        optionSpecs,
        input.capabilityRegistry,
        input.modality,
      );

      if (check.ok) {
        const key = `${target.access_path}\u0000${target.model}`;
        if (!seenCandidateKey.has(key)) {
          seenCandidateKey.add(key);
          const merged = mergeOverrides(effectiveOverrides, target.overrides);
          const format =
            input.credentialResolver?.formatFor(target.access_path) ??
            inferFormatFromAccessPath(target.access_path);
          candidates.push({
            provider: target.provider,
            access_path: target.access_path,
            provider_format: format,
            model: target.model,
            fast_path_eligible: false,
            route_node_id: node.id,
            ...(merged === undefined ? {} : { overrides: merged }),
          });
        }
        trace.push({
          node_id: node.id,
          node_label: node.label,
          kind: node.kind,
          outcome: 'selected',
          detail: `${target.provider}/${target.model} (${check.reason})`,
        });
      } else {
        trace.push({
          node_id: node.id,
          node_label: node.label,
          kind: node.kind,
          outcome: 'skipped',
          port: 'fallback',
          detail: `${target.provider}/${target.model}: ${check.reason}`,
        });
      }

      // 评估启用的 Provider 扩展分支端口（如 off_peak / low_balance / low_credits / quota_exceeded）
      const activeExtPorts = new Set<string>();
      if (node.extension_ports !== undefined && node.extension_ports.length > 0) {
        const extSpecs: ProviderExtensionPointSpec[] =
          input.telemetryHub?.extensionsForProvider?.(target.provider, target.access_path) ?? [];
        const extByPort = new Map(extSpecs.map((s) => [s.port, s]));
        for (const port of node.extension_ports) {
          const spec = extByPort.get(port);
          if (spec?.telemetry_field === undefined || spec.operator === undefined || spec.default_threshold === undefined) {
            continue;
          }
          const actual = readTelemetryField(snap, spec.telemetry_field);
          if (actual === undefined) continue;
          const matched = compareThreshold(actual, spec.operator, spec.default_threshold);
          if (matched) {
            activeExtPorts.add(port);
            trace.push({
              node_id: node.id,
              node_label: node.label,
              kind: node.kind,
              outcome: 'branch',
              port,
              detail: `扩展点 ${spec.label} (${port}) 触发`,
            });
          }
        }
      }

      // 沿触发的扩展端口 + fallback 边收集后续节点
      for (const edge of outgoingEdges(node.id)) {
        if (edge.from_port !== 'fallback' && edge.from_port !== 'next' && !activeExtPorts.has(edge.from_port)) {
          continue;
        }
        queue.push({
          nodeId: edge.to,
          ...(effectiveOverrides === undefined ? {} : { inheritedOverrides: effectiveOverrides }),
        });
      }
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      candidates: [],
      trace,
      error: `路由图 ${graph.id} 未产出任何可用候选目标`,
    };
  }
  return { ok: true, candidates, trace };
}

function compareThreshold(
  actual: number | boolean,
  op: 'gte' | 'lte' | 'eq',
  expected: number | boolean,
): boolean {
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return actual === expected;
  }
  switch (op) {
    case 'gte':
      return actual >= expected;
    case 'lte':
      return actual <= expected;
    case 'eq':
      return actual === expected;
  }
}

/** 检测图中是否存在坐标缺失或节点包围盒重叠（用于 AI 入库自动排版）。 */
export function hasOverlappingNodes(nodes: readonly RouteGraphNode[]): boolean {
  if (nodes.length <= 1) return false;
  const MIN_DX = 250;
  const MIN_DY = 120;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!;
    if (
      !Number.isFinite(a.position?.x) ||
      !Number.isFinite(a.position?.y)
    ) {
      return true;
    }
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!;
      if (
        !Number.isFinite(b.position?.x) ||
        !Number.isFinite(b.position?.y)
      ) {
        return true;
      }
      if (Math.abs(a.position.x - b.position.x) < MIN_DX && Math.abs(a.position.y - b.position.y) < MIN_DY) {
        return true;
      }
    }
  }
  return false;
}

/** 基于最长路径拓扑分层的无重叠自动布局（X 步长 340px，Y 步长 175px）。 */
export function autoLayoutRouteGraph(graph: RouteGraph): RouteGraphNode[] {
  if (graph.nodes.length === 0) return [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const outEdges = new Map<string, RouteGraphEdge[]>();
  const inDegree = new Map<string, number>();
  for (const n of graph.nodes) {
    outEdges.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const e of graph.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    outEdges.get(e.from)!.push(e);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }
  for (const list of outEdges.values()) {
    list.sort((a, b) => a.priority - b.priority);
  }

  const layer = new Map<string, number>();
  const entryId = nodeIds.has(graph.entry_node_id) ? graph.entry_node_id : graph.nodes[0]!.id;
  layer.set(entryId, 0);

  // Kahn / longest-path relaxation (capped at N passes for safety)
  const queue: string[] = [entryId];
  for (const n of graph.nodes) {
    if (n.id !== entryId && (inDegree.get(n.id) ?? 0) === 0) {
      layer.set(n.id, 0);
      queue.push(n.id);
    }
  }
  const maxPasses = graph.nodes.length * 2;
  let pass = 0;
  while (queue.length > 0 && pass < maxPasses * Math.max(1, graph.edges.length + 1)) {
    pass += 1;
    const u = queue.shift()!;
    const lu = layer.get(u) ?? 0;
    for (const e of outEdges.get(u) ?? []) {
      const nextLayer = lu + 1;
      if ((layer.get(e.to) ?? -1) < nextLayer) {
        layer.set(e.to, nextLayer);
        queue.push(e.to);
      }
    }
  }
  for (const n of graph.nodes) {
    if (!layer.has(n.id)) layer.set(n.id, 0);
  }

  const columns = new Map<number, RouteGraphNode[]>();
  for (const n of graph.nodes) {
    const col = layer.get(n.id) ?? 0;
    const list = columns.get(col) ?? [];
    list.push(n);
    columns.set(col, list);
  }

  const START_X = 72;
  const COL_STEP = 340;
  const START_Y = 72;
  const ROW_STEP = 175;
  const posById = new Map<string, { x: number; y: number }>();

  const maxRows = Math.max(1, ...Array.from(columns.values()).map((c) => c.length));
  const totalHeight = (maxRows - 1) * ROW_STEP;

  for (const [col, list] of columns.entries()) {
    list.sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));
    const colHeight = (list.length - 1) * ROW_STEP;
    const offsetY = START_Y + Math.round((totalHeight - colHeight) / 2);
    list.forEach((n, idx) => {
      posById.set(n.id, {
        x: START_X + col * COL_STEP,
        y: offsetY + idx * ROW_STEP,
      });
    });
  }

  return graph.nodes.map((n) => ({
    ...n,
    position: posById.get(n.id) ?? n.position,
  }));
}

function mergeOverrides(
  base?: RouteParamOverrides,
  extra?: RouteParamOverrides,
): RouteParamOverrides | undefined {
  if (base === undefined && extra === undefined) return undefined;
  return { ...(base ?? {}), ...(extra ?? {}) };
}

function inferFormatFromAccessPath(accessPath: string): FormatId {
  if (accessPath.endsWith('.anthropic-messages') || accessPath === 'anthropic' || accessPath === 'mock-anthropic') {
    return 'anthropic.messages';
  }
  if (accessPath.endsWith('.openai-responses') || accessPath === 'openai.responses') {
    return 'openai.responses';
  }
  if (
    accessPath === 'gemini.generateContent' ||
    accessPath.endsWith('.gemini-generateContent') ||
    accessPath.endsWith('.gemini.generateContent') ||
    accessPath === 'gemini'
  ) {
    return 'gemini.generateContent';
  }
  return 'openai.chat';
}
