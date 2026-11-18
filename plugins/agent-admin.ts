/**
 * plugins/agent-admin.ts —— 内置「Agent 管理」插件：把系统管理能力暴露成 canonical 工具。
 *
 * 设计依据：docs/design/95-agent-chat.md §3（工具清单）、§4（需要凭据的交互协议）。
 *
 * ## 为什么是插件
 *
 * `PluginManifest` 没有 `tools` 字段，`GatewayServices.registerTool` 也没有任何装配方
 * 提供，因此唯一可用路径是 `hooks: ['onToolCall']`（30-plugin-api.md §2、§3）。
 * 工具执行发生在网关 agentic loop 内；没有 `onToolCall` 插件时调用会变成一个
 * `is_error` 的 tool_result，不会 500。
 *
 * ## 三条安全立场（写进代码，不是约定）
 *
 * 1. **不新写一套管理逻辑**：每个工具都转调 `AdminService` 的既有方法。列渠道就是
 *    `listProviders`，列凭据就是 `listCredentials`（只回掩码），建 key 就是
 *    `createVirtualKey`。管理面界面能做的事，这里做的是同一批。
 * 2. **出参结构上不可能含密钥**：凭据类工具只取掩码字段；`create_virtual_key` 的明文
 *    走 `ToolCallRecorder` 的旁路披露（95 §3.3）单独交给界面，**不进 tool_result**；
 *    没有任何工具以 `secret` 为入参——key 只能从弹窗进 `POST /admin/api/credentials`。
 * 3. **工具结果仍会被再脱敏一遍**：`plugins/redaction-host.ts` 包住 `runOnToolCall`，
 *    所以即使将来某个工具实现疏忽，密钥也到不了模型（纵深防御）。
 *
 * ## 依赖注入
 *
 * `Plugin.init()` 全仓库没有任何调用方，`GatewayServices` 也没有 services bag，
 * 因此这里用工厂函数 + 显式依赖（`composition-root.ts` 里那些对象已经存在）。
 */

import type {
  JSONSchema,
  MaybePromise,
  Plugin,
  PluginManifest,
  PluginToolSpec,
  RequestContext,
  ToolResultPart,
} from '../ir/index.js';
import type { AdminService } from '../admin/service.js';
import type { AliasResolver } from '../admin/aliases.js';
import type {
  MaskedCredential,
  ProviderConfig,
  RouteGraphUpsertRequest,
} from '../admin/api-types.js';
import { accessPathIdForDialect } from '../admin/aliases.js';
import type { SettingValue } from '../config/settings.js';
import {
  AGENT_TOOL_NAMES,
  agentToolEnabled,
  type AgentConfigHub,
  type AgentToolName,
} from '../config/agent.js';
import type { ToolCallRecorder } from './tool-recorder.js';
import { stashSecret } from './tool-recorder.js';
import {
  autoLayoutRouteGraph,
  hasOverlappingNodes,
} from '../gateway-core/routing-engine.js';

// ---------------------------------------------------------------------------
// 工具定义（聊天端点据此组装发给模型的 tools[]）
// ---------------------------------------------------------------------------

/** 一个工具的对外定义（canonical `FunctionTool` 的三个字段）。 */
export interface AgentToolDef {
  name: AgentToolName;
  description: string;
  parameters: JSONSchema;
}

const str = (description: string): JSONSchema => ({ type: 'string', description });
const num = (description: string): JSONSchema => ({ type: 'number', description });
const bool = (description: string): JSONSchema => ({ type: 'boolean', description });
const strArray = (description: string): JSONSchema => ({
  type: 'array',
  items: { type: 'string' },
  description,
});
const anyArray = (description: string): JSONSchema => ({
  type: 'array',
  items: {},
  description,
});
const anyObj = (description: string): JSONSchema => ({
  type: 'object',
  additionalProperties: true,
  description,
});
const obj = (properties: Record<string, JSONSchema>, required: string[] = []): JSONSchema => ({
  type: 'object',
  properties,
  required,
});

const DIALECTS: readonly ProviderConfig['dialect'][] = [
  'openai.chat',
  'anthropic.messages',
  'openai.responses',
  'gemini.generateContent',
];

/**
 * 工具清单。
 *
 * `description` 是**给模型看的唯一说明**，因此把安全边界也写进去：模型需要知道
 * 「你看不到密钥」「需要密钥时调 add_provider 而不是向用户要」。
 */
export const AGENT_TOOL_DEFS: readonly AgentToolDef[] = [
  {
    name: 'list_channels',
    description: '列出网关上已配置的渠道（id、名称、协议、是否启用、命名空间、静态模型数、凭据健康状态）。',
    parameters: obj({}),
  },
  {
    name: 'add_provider',
    description:
      '添加一条新渠道。不要向用户索要密钥：本工具不带密钥入参，缺凭据时返回 needs_credential，' +
      '由界面弹窗请用户录入。',
    parameters: obj(
      {
        id: str('渠道 id，小写字母/数字/中划线'),
        label: str('渠道显示名'),
        dialect: str(`协议，取值：${DIALECTS.join(' / ')}`),
        base_url: str('上游 base URL，http(s):// 开头'),
        namespace: str('命名空间；省略 = 不启用'),
        models: strArray('静态模型清单；省略则用上游发现'),
      },
      ['id', 'label', 'dialect', 'base_url'],
    ),
  },
  {
    name: 'update_provider',
    description: '修改已有渠道配置（启用/停用、显示名、base_url、命名空间、静态模型列表）。未提供的字段保持不变。',
    parameters: obj(
      {
        id: str('渠道 id'),
        label: str('新的渠道显示名'),
        enabled: bool('是否启用'),
        base_url: str('新的上游 base URL'),
        namespace: str('命名空间；传空串表示取消命名空间'),
        models: strArray('替换为新的静态模型列表'),
      },
      ['id'],
    ),
  },
  {
    name: 'update_provider_credential',
    description:
      '为已有渠道更换或补充上游密钥（不经对话上下文）。返回 needs_credential 触发界面弹窗，用户填入一次新密钥即可级联替换该渠道下所有或指定接入路径的旧凭据。',
    parameters: obj(
      {
        provider: str('渠道 id（如 opencode-go、deepseek）'),
        access_path: str('可选：仅更换指定接入路径；不传则自动级联更新该渠道所有已有接入路径及主协议路径'),
        replace_existing: bool('保存新密钥时是否自动清理对应路径的旧凭据（默认 true）'),
      },
      ['provider'],
    ),
  },
  {
    name: 'delete_provider',
    description:
      '请求删除指定渠道。为防误删，本工具不会立即删除，而是返回 pending_confirmation，由用户在界面点击「确认删除」后执行。',
    parameters: obj(
      {
        id: str('要删除的渠道 id'),
        cascade_credentials: bool('是否一并删除该渠道名下凭据，默认 true'),
      },
      ['id'],
    ),
  },
  {
    name: 'test_provider',
    description: '测试一条渠道能否连通（打一次上游）。',
    parameters: obj({ id: str('渠道 id') }, ['id']),
  },
  {
    name: 'list_credentials',
    description:
      '列出渠道的上游凭据。只返回掩码与元数据，永远不返回密钥明文；看不到明文是设计如此。',
    parameters: obj({ provider: str('渠道 id；省略则列全部') }),
  },
  {
    name: 'probe_credential',
    description: '对指定凭据（凭据 id 或 access_path）发起一次健康探测。',
    parameters: obj({ id: str('凭据 id 或 access_path') }, ['id']),
  },
  {
    name: 'delete_credential',
    description:
      '请求删除指定凭据。不会立即执行，而是返回 pending_confirmation 由用户在界面点击确认。',
    parameters: obj({ id: str('凭据 id') }, ['id']),
  },
  {
    name: 'list_models',
    description: '列出模型目录（哪条渠道上可用哪些模型、上下文窗口、模态、暴露状态）。',
    parameters: obj({}),
  },
  {
    name: 'set_model_visibility',
    description: '设置某个模型是否在 /v1/models 对外暴露。',
    parameters: obj(
      {
        model: str('模型名'),
        exposed: bool('true = 对外暴露，false = 隐藏'),
      },
      ['model', 'exposed'],
    ),
  },
  {
    name: 'sync_models',
    description: '触发一次模型目录同步（upstream_discovery 或 offline_catalog_refresh）。',
    parameters: obj({
      kind: str('同步类型：upstream_discovery（默认）或 offline_catalog_refresh'),
    }),
  },
  {
    name: 'list_aliases',
    description: '列出当前所有模型别名规则（exact / prefix、目标渠道与模型、优先级、启用状态）。',
    parameters: obj({}),
  },
  {
    name: 'upsert_alias',
    description: '新增或修改一条模型别名规则，热生效。',
    parameters: obj(
      {
        id: str('规则 id；修改已有规则时必传，新建可省略'),
        kind: str('匹配类型：exact 或 prefix'),
        pattern: str('匹配模式（如 gpt-4o 或 claude-*）'),
        provider: str('目标渠道 id'),
        access_path: str('目标接入路径（如 deepseek.openai-chat）'),
        model: str('目标上游真实模型名'),
        priority: num('优先级（越小越优先，默认 100）'),
        enabled: bool('是否启用（默认 true）'),
        note: str('备注'),
      },
      ['kind', 'pattern', 'provider', 'access_path', 'model'],
    ),
  },
  {
    name: 'delete_alias',
    description:
      '请求删除一条模型别名规则。不会立即执行，而是返回 pending_confirmation 由用户在界面点击确认。',
    parameters: obj({ id: str('别名规则 id') }, ['id']),
  },
  {
    name: 'resolve_alias',
    description: '预览一个模型名会解析到哪条渠道、哪个真实模型。',
    parameters: obj({ model: str('模型名或别名') }, ['model']),
  },
  {
    name: 'list_virtual_keys',
    description: '列出全部客户端虚拟密钥（只含掩码、配额、限流与启用状态，不含明文）。',
    parameters: obj({}),
  },
  {
    name: 'create_virtual_key',
    description:
      '创建一把客户端密钥。返回的只有标识与掩码；明文由界面单独展示一次，不会进入对话上下文。',
    parameters: obj(
      {
        name: str('密钥名称'),
        note: str('备注'),
        models: strArray('允许的模型'),
        providers: strArray('允许的渠道'),
      },
      ['name'],
    ),
  },
  {
    name: 'revoke_virtual_key',
    description: '撤销（停用）一把客户端密钥，使其立即失效但保留审计记录。',
    parameters: obj({ key_id: str('客户端密钥 key_id') }, ['key_id']),
  },
  {
    name: 'delete_virtual_key',
    description:
      '请求永久删除一把客户端密钥。不会立即执行，而是返回 pending_confirmation 由用户在界面点击确认。',
    parameters: obj({ key_id: str('客户端密钥 key_id') }, ['key_id']),
  },
  {
    name: 'list_route_graphs',
    description: '查看所有路由图引擎配置（id、名称、启用状态、entry_node_id、nodes、edges）。',
    parameters: obj({}),
  },
  {
    name: 'upsert_route_graph',
    description:
      '创建或更新一条路由图（DAG + VM-JS 条件节点 + 目标节点），保存前会进行拓扑与字段校验并热生效。' +
      '节点须用 kind（entry / condition / js_script / provider_target）+ position {x,y}，' +
      '对应附带 condition / script {code,ports?} / target {provider,access_path,model}；' +
      '边为 { id, from, from_port, to, priority, label? }。复杂结构可先调用 get_gateway_doc(topic="route_graph") 获取完整 Schema 与示例。',
    parameters: obj(
      {
        id: str('路由图 id（同时作为调用 model 名，如 smart-chat）'),
        label: str('路由图显示名称'),
        enabled: bool('是否启用（默认 true）'),
        entry_node_id: str('入口节点 id'),
        nodes: anyArray('DAG 节点数组（{ id, kind, label, position, condition?/script?/target? }）'),
        edges: anyArray('DAG 边数组（{ id, from, from_port, to, priority, label? }）'),
        ability_mode: str('能力聚合模式：min（默认，所有目标交集）| max（所有目标并集）| custom（自定义）'),
        abilities: anyObj('当 ability_mode=custom 时的自定义能力覆盖（tool_call, reasoning, structured_output, input_modalities, context_window, max_output_tokens）'),
        note: str('备注'),
      },
      ['id', 'label', 'entry_node_id', 'nodes', 'edges'],
    ),
  },
  {
    name: 'simulate_route_graph',
    description: '模拟路由图在给定模型与请求条件下的执行路径、各节点判定 trace 与最终候选目标。',
    parameters: obj(
      {
        graph_id: str('已保存的路由图 id'),
        model: str('模拟请求的模型名（默认与 graph_id 相同）'),
        modality: str('模态（默认 chat）'),
        stream: bool('是否流式（默认 true）'),
        client_format: str('客户端格式（默认 openai.chat）'),
        message_text: str('模拟的用户消息文本（供条件节点测试）'),
      },
      ['graph_id'],
    ),
  },
  {
    name: 'delete_route_graph',
    description:
      '请求删除一条路由图。不会立即执行，而是返回 pending_confirmation 由用户在界面点击确认。',
    parameters: obj({ id: str('路由图 id') }, ['id']),
  },
  {
    name: 'usage_summary',
    description: '查看用量汇总（请求数、token、双口径成本）。',
    parameters: obj({
      from_ts: num('起始时间（epoch ms）'),
      to_ts: num('结束时间（epoch ms）'),
    }),
  },
  {
    name: 'get_routing_telemetry',
    description: '查看各渠道实时遥测、5 小时滑窗用量、限流状态与余额/订阅配额快照。',
    parameters: obj({
      refresh: bool('是否先主动向各渠道刷新一次余额/配额与遥测（默认 false）'),
    }),
  },
  {
    name: 'list_settings',
    description: '查看网关与内置助手的运行时设置项（当前值、默认值、来源、是否可编辑）。',
    parameters: obj({}),
  },
  {
    name: 'update_setting',
    description: '修改网关运行时设置项（如请求超时、重试次数、loss_policy、采样参数等）。',
    parameters: obj(
      {
        id: str('设置项 id'),
        value: anyObj('设置值（或直接在 JSON 中传 string/number/boolean/array）'),
      },
      ['id'],
    ),
  },
  {
    name: 'get_gateway_doc',
    description:
      '按需查阅 AgentGateway 内部结构文档、工具参数 Schema 与完整 JSON 示例（避免猜测字段）。' +
      '不传 topic 或传 "index" 返回文档目录；传具体主题名返回该主题的详细说明与示例。',
    parameters: obj({
      topic: str(
        '文档主题：index（目录，默认）| route_graph（路由图节点/边/JS沙盒与示例）| ' +
          'channels_credentials（渠道与凭据接入）| models_aliases（模型目录与别名）| ' +
          'virtual_keys_plugins（客户端密钥权限与插件挂载）| confirmation_redaction（删除确认与密钥脱敏）',
      ),
    }),
  },
];

const TOOL_META: Record<
  AgentToolName,
  { label: string; category: string; requires_confirmation?: boolean }
> = {
  list_channels: { label: '查询渠道', category: '渠道管理' },
  add_provider: { label: '添加渠道', category: '渠道管理' },
  update_provider: { label: '修改渠道', category: '渠道管理' },
  update_provider_credential: { label: '更换渠道凭据', category: '渠道管理' },
  delete_provider: { label: '删除渠道', category: '渠道管理', requires_confirmation: true },
  test_provider: { label: '检测渠道', category: '渠道管理' },
  list_credentials: { label: '查询凭据', category: '凭据管理' },
  probe_credential: { label: '探测凭据', category: '凭据管理' },
  delete_credential: { label: '删除凭据', category: '凭据管理', requires_confirmation: true },
  list_models: { label: '查询模型', category: '模型与别名' },
  set_model_visibility: { label: '模型暴露开关', category: '模型与别名' },
  sync_models: { label: '同步模型目录', category: '模型与别名' },
  list_aliases: { label: '列出别名', category: '模型与别名' },
  upsert_alias: { label: '编辑别名', category: '模型与别名' },
  delete_alias: { label: '删除别名', category: '模型与别名', requires_confirmation: true },
  resolve_alias: { label: '解析别名', category: '模型与别名' },
  list_virtual_keys: { label: '列出密钥', category: '客户端密钥' },
  create_virtual_key: { label: '签发密钥', category: '客户端密钥' },
  revoke_virtual_key: { label: '撤销密钥', category: '客户端密钥' },
  delete_virtual_key: { label: '删除密钥', category: '客户端密钥', requires_confirmation: true },
  list_route_graphs: { label: '查看路由图', category: '路由图引擎' },
  upsert_route_graph: { label: '编辑路由图', category: '路由图引擎' },
  simulate_route_graph: { label: '模拟路由图', category: '路由图引擎' },
  delete_route_graph: { label: '删除路由图', category: '路由图引擎', requires_confirmation: true },
  usage_summary: { label: '汇总用量', category: '遥测与系统' },
  get_routing_telemetry: { label: '遥测与余额', category: '遥测与系统' },
  list_settings: { label: '查看设置', category: '遥测与系统' },
  update_setting: { label: '修改设置', category: '遥测与系统' },
  get_gateway_doc: { label: '按需查阅文档', category: '遥测与系统' },
};

export const AGENT_TOOL_SPECS: readonly PluginToolSpec[] = AGENT_TOOL_DEFS.map((d) => {
  const meta = TOOL_META[d.name];
  return {
    name: d.name,
    label: meta.label,
    category: meta.category,
    description: d.description,
    ...(meta.requires_confirmation ? { requires_confirmation: true } : {}),
    parameters: d.parameters,
  };
});

/** 按设置里的开关取工具定义（聊天端点组装 `tools[]` 用）。 */
export function agentToolDefs(names: readonly string[]): AgentToolDef[] {
  const wanted = new Set(names);
  return AGENT_TOOL_DEFS.filter((d) => wanted.has(d.name));
}

// ---------------------------------------------------------------------------
// 依赖与构造
// ---------------------------------------------------------------------------

export interface AgentAdminPluginDeps {
  adminService: AdminService;
  aliasResolver: AliasResolver;
  configHub: AgentConfigHub;
  /**
   * 工具调用旁路记录（与 RedactingPluginHost 同一个实例）。
   *
   * 明文密钥经它送到浏览器：插件把明文暂存进 `ctx.state`，装饰器再搬进记录。
   * 插件自己不写记录——那时拿到的结果还没脱敏（95 §3.3）。
   */
  recorder: ToolCallRecorder;
}

/** 审计用的 actor：能追到是哪一次对话干的。 */
const actorOf = (ctx: RequestContext): string => `agent:${ctx.request_id}`;

export function createAgentAdminPlugin(deps: AgentAdminPluginDeps): Plugin {
  const manifest: PluginManifest = {
    name: 'agent-admin',
    title: '内置管理助手工具集 (ServerTools)',
    description:
      '为内置管理助手提供渠道、凭据、模型别名、客户端密钥、路由图引擎与系统设置管理工具，删除操作强制经界面确认。',
    version: '1.0.0',
    hooks: ['onToolCall'],
    capabilities: ['tool_provider', 'audit'],
    mount_targets: ['agent'],
    tools: AGENT_TOOL_SPECS,
    // 管理工具可能打上游（test_provider / list_models），比默认 5s 宽一点
    timeout_ms: 30_000,
    order: 100,
    scope: 'envelope-only',
  };

  return {
    manifest,
    status() {
      const config = deps.configHub.snapshot();
      return {
        enabled_tools: config.tools.length,
        total_tools: AGENT_TOOL_DEFS.length,
        confirmation_guarded: AGENT_TOOL_SPECS.filter((t) => t.requires_confirmation).length,
      };
    },
    onToolCall(call, ctx): MaybePromise<ToolResultPart> {
      const config = deps.configHub.snapshot();
      if (!agentToolEnabled(config, call.name)) {
        return toolError(
          call.id,
          `工具 ${call.name} 已被禁用（设置项 agent_tools）。请让管理员在设置里打开它。`,
        );
      }
      return dispatch(call.name, call.id, call.input, ctx);
    },
  };

  function dispatch(
    name: string,
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): MaybePromise<ToolResultPart> {
    switch (name) {
      case 'list_channels':
        return listChannels(toolUseId);
      case 'add_provider':
        return addProvider(toolUseId, input, ctx);
      case 'update_provider':
        return updateProvider(toolUseId, input, ctx);
      case 'update_provider_credential':
        return updateProviderCredential(toolUseId, input);
      case 'delete_provider':
        return requestDeleteProvider(toolUseId, input);
      case 'test_provider':
        return testProvider(toolUseId, input, ctx);
      case 'list_credentials':
        return listCredentials(toolUseId, optStr(input, 'provider'));
      case 'probe_credential':
        return probeCredential(toolUseId, input);
      case 'delete_credential':
        return requestDeleteCredential(toolUseId, input);
      case 'list_models':
        return listModels(toolUseId);
      case 'set_model_visibility':
        return setModelVisibility(toolUseId, input, ctx);
      case 'sync_models':
        return syncModels(toolUseId, input, ctx);
      case 'list_aliases':
        return listAliases(toolUseId);
      case 'upsert_alias':
        return upsertAlias(toolUseId, input, ctx);
      case 'delete_alias':
        return requestDeleteAlias(toolUseId, input);
      case 'resolve_alias':
        return resolveAlias(toolUseId, input);
      case 'list_virtual_keys':
        return listVirtualKeys(toolUseId);
      case 'create_virtual_key':
        return createVirtualKey(toolUseId, input, ctx);
      case 'revoke_virtual_key':
        return revokeVirtualKey(toolUseId, input, ctx);
      case 'delete_virtual_key':
        return requestDeleteVirtualKey(toolUseId, input);
      case 'list_route_graphs':
        return listRouteGraphs(toolUseId);
      case 'upsert_route_graph':
        return upsertRouteGraph(toolUseId, input, ctx);
      case 'simulate_route_graph':
        return simulateRouteGraph(toolUseId, input);
      case 'delete_route_graph':
        return requestDeleteRouteGraph(toolUseId, input);
      case 'usage_summary':
        return usageSummary(toolUseId, input);
      case 'get_routing_telemetry':
        return getRoutingTelemetry(toolUseId, input);
      case 'list_settings':
        return listSettings(toolUseId);
      case 'update_setting':
        return updateSetting(toolUseId, input, ctx);
      case 'get_gateway_doc':
        return getGatewayDoc(toolUseId, input);
      default:
        return toolError(toolUseId, `未知工具 ${name}。可用工具：${AGENT_TOOL_NAMES.join('、')}`);
    }
  }

  // ---- 各个工具 ----

  async function listChannels(toolUseId: string): Promise<ToolResultPart> {
    const providers = await deps.adminService.listProviders();
    return toolOk(toolUseId, {
      count: providers.length,
      channels: providers.map((p: ProviderConfig) => ({
        id: p.id,
        label: p.label,
        dialect: p.dialect,
        base_url: p.base_url,
        enabled: p.enabled,
        namespace: p.namespace ?? '',
        model_source: p.model_source.kind,
        static_models: p.model_source.kind === 'static' ? p.model_source.models : undefined,
        credential_health: p.credential_health ?? 'unknown',
      })),
    });
  }

  async function updateProvider(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const providerId = reqStr(input, 'id');
    const existing = await deps.adminService.getProvider(providerId);
    if (existing === undefined) {
      return toolError(toolUseId, `渠道 ${providerId} 不存在`);
    }
    const label = optStr(input, 'label') ?? existing.label;
    const baseUrl = optStr(input, 'base_url') ?? existing.base_url;
    const enabled = optBool(input, 'enabled') ?? existing.enabled;
    const namespace = typeof input['namespace'] === 'string' ? input['namespace'].trim() : (existing.namespace ?? '');
    const models = optStrArray(input, 'models');
    const updated = await deps.adminService.upsertProvider(actorOf(ctx), {
      id: existing.id,
      label,
      dialect: existing.dialect,
      base_url: baseUrl,
      enabled,
      namespace,
      ...(existing.builtin_tools === undefined ? {} : { builtin_tools: existing.builtin_tools }),
      ...(existing.pricing === undefined ? {} : { pricing: existing.pricing }),
      ...(existing.model_metadata === undefined ? {} : { model_metadata: existing.model_metadata }),
      model_source:
        models !== undefined
          ? { kind: 'static', models }
          : existing.model_source,
    });
    if (!updated.ok) return toolError(toolUseId, updated.error);
    return toolOk(toolUseId, {
      status: 'updated',
      provider: {
        id: updated.provider.id,
        label: updated.provider.label,
        enabled: updated.provider.enabled,
        namespace: updated.provider.namespace ?? '',
        base_url: updated.provider.base_url,
      },
    });
  }

  async function requestDeleteProvider(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const providerId = reqStr(input, 'id');
    const existing = await deps.adminService.getProvider(providerId);
    if (existing === undefined) {
      return toolError(toolUseId, `渠道 ${providerId} 不存在`);
    }
    const cascade = optBool(input, 'cascade_credentials') ?? true;
    return toolOk(toolUseId, {
      status: 'pending_confirmation',
      action: 'delete_provider',
      resource_type: 'provider',
      resource_id: existing.id,
      label: `${existing.label} (${existing.id})`,
      cascade_credentials: cascade,
      detail: cascade
        ? `将永久删除渠道「${existing.label}」及其名下所有凭据。`
        : `将删除渠道「${existing.label}」（保留名下凭据）。`,
      hint: '删除操作需要用户在界面工具卡片上点击「确认删除」按钮后才会执行。',
    });
  }

  async function listCredentials(toolUseId: string, provider?: string): Promise<ToolResultPart> {
    const all = await deps.adminService.listCredentials(provider);
    // **只取掩码与元数据**：MaskedCredential 本身就不含明文，这里再白名单一遍字段——
    // 将来谁给 DTO 加一个 secret 形字段，也不会顺带漏给模型。
    const items = all.map((c: MaskedCredential) => ({
      id: c.id,
      provider: c.provider,
      access_path: c.access_path,
      masked: c.masked,
      storage: c.storage.location,
      health: c.health,
      created_at: c.created_at,
    }));
    return toolOk(toolUseId, { count: items.length, credentials: items });
  }

  async function listModels(toolUseId: string): Promise<ToolResultPart> {
    const entries = deps.adminService.listCapabilityMatrix();
    return toolOk(toolUseId, {
      count: entries.length,
      models: entries.slice(0, 200).map((e) => ({
        access_path: e.access_path,
        model: e.model,
        modality: e.modality,
        status: e.status,
        context_window: e.context_window,
      })),
    });
  }

  async function addProvider(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const providerId = reqStr(input, 'id');
    const label = reqStr(input, 'label');
    const dialect = reqStr(input, 'dialect');
    const baseUrl = reqStr(input, 'base_url');
    if (!DIALECTS.includes(dialect as ProviderConfig['dialect'])) {
      return toolError(toolUseId, `dialect 只接受：${DIALECTS.join(' / ')}`);
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      return toolError(toolUseId, 'base_url 必须是 http(s):// 开头');
    }
    const models = optStrArray(input, 'models');
    const namespace = optStr(input, 'namespace');
    const created = await deps.adminService.upsertProvider(actorOf(ctx), {
      id: providerId,
      label,
      dialect: dialect as ProviderConfig['dialect'],
      base_url: baseUrl,
      ...(namespace === undefined ? {} : { namespace }),
      model_source:
        models === undefined ? { kind: 'discovery', path: '/models' } : { kind: 'static', models },
    });
    if (!created.ok) return toolError(toolUseId, created.error);

    const accessPath = accessPathIdForDialect(providerId, dialect);
    const existing = await deps.adminService.listCredentials(providerId);
    const hasCred = existing.some((c) => c.access_path === accessPath);
    if (hasCred) {
      return toolOk(toolUseId, {
        status: 'created',
        provider: providerId,
        access_path: accessPath,
        message: '渠道已建成，且该协议面上已有凭据。',
      });
    }
    // 95 §4.2：渠道已落库，缺的只是 key。**出参里没有任何密钥材料。**
    return toolOk(toolUseId, {
      status: 'needs_credential',
      provider: providerId,
      access_path: accessPath,
      hint: '渠道已建成，还缺上游密钥。请让用户在弹窗里录入，录入后继续。',
    });
  }

  async function updateProviderCredential(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const providerId = reqStr(input, 'provider');
    const provider = await deps.adminService.getProvider(providerId);
    if (provider === undefined) {
      return toolError(toolUseId, `渠道 ${providerId} 不存在`);
    }
    const specifiedPath = optStr(input, 'access_path');
    const replaceExisting = optBool(input, 'replace_existing') ?? true;
    const existing = await deps.adminService.listCredentials(providerId);
    const primaryPath = accessPathIdForDialect(providerId, provider.dialect);
    const accessPaths =
      specifiedPath !== undefined
        ? [specifiedPath]
        : Array.from(new Set([...existing.map((c) => c.access_path), primaryPath]));

    return toolOk(toolUseId, {
      status: 'needs_credential',
      mode: replaceExisting ? 'replace' : 'add',
      provider: providerId,
      access_path: accessPaths[0],
      access_paths: accessPaths,
      replace_existing: replaceExisting,
      existing_credential_count: existing.length,
      hint: `已触发弹窗，请用户点击「${replaceExisting ? '更换凭据' : '录入凭据'}」一次填入新密钥，将${accessPaths.length > 1 ? `级联更新 ${accessPaths.length} 条接入路径（${accessPaths.join('、')}）` : `更新路径 ${accessPaths[0]}`}。`,
    });
  }

  async function createVirtualKey(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const name = reqStr(input, 'name');
    const note = optStr(input, 'note');
    const models = optStrArray(input, 'models');
    const providers = optStrArray(input, 'providers');
    const created = await deps.adminService.createVirtualKey(actorOf(ctx), {
      name,
      ...(note === undefined ? {} : { note }),
      ...(models === undefined ? {} : { models }),
      ...(providers === undefined ? {} : { providers }),
    });
    if (!created.ok) return toolError(toolUseId, created.error);
    // 明文只进旁路披露（95 §3.3）：tool_result 里永远只有标识与掩码。
    // 暂存在 ctx.state 里，由 RedactingPluginHost 搬进服务端记录——
    // 它从不进 canonical，因此模型看不到。
    stashSecret(ctx, {
      key_id: created.key.key_id,
      plaintext: created.plaintext,
      name: created.key.name,
      masked: created.key.masked,
    });
    return toolOk(toolUseId, {
      status: 'created',
      key_id: created.key.key_id,
      name: created.key.name,
      masked: created.key.masked,
      head: created.key.head,
      note: '明文密钥已单独展示给用户一次，不会进入对话上下文。',
    });
  }

  async function usageSummary(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const fromTs = optNum(input, 'from_ts');
    const toTs = optNum(input, 'to_ts');
    const dash = await deps.adminService.usageDashboard(fromTs, toTs);
    return toolOk(toolUseId, {
      from_ts: dash.summary.from_ts,
      to_ts: dash.summary.to_ts,
      request_count: dash.summary.request_count,
      input_tokens: dash.summary.input_tokens,
      output_tokens: dash.summary.output_tokens,
      cash_total: dash.summary.cash_total,
      as_api_total: dash.summary.as_api_total,
      unpriced_count: dash.summary.unpriced_count,
    });
  }

  function resolveAlias(toolUseId: string, input: Record<string, unknown>): ToolResultPart {
    const model = reqStr(input, 'model');
    const resolution = deps.adminService.resolveAlias(model);
    if (resolution === undefined) {
      return toolOk(toolUseId, {
        status: 'unresolved',
        model,
        message: '没有任何规则或目录命中这个名字。',
      });
    }
    return toolOk(toolUseId, { status: 'resolved', model, resolution });
  }

  async function testProvider(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const providerId = reqStr(input, 'id');
    const res = await deps.adminService.testProvider(actorOf(ctx), providerId);
    if (!res.ok) {
      return toolOk(toolUseId, {
        status: 'error',
        provider: providerId,
        code: res.code,
        // 上游错误文本可能带密钥形态串——脱敏主机再过一遍（纵深防御）
        message: res.message,
        checked_at: res.checked_at,
      });
    }
    return toolOk(toolUseId, { status: 'ok', provider: providerId, checked_at: res.checked_at });
  }

  async function probeCredential(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const idOrPath = reqStr(input, 'id');
    const res = await deps.adminService.probeCredential(idOrPath);
    return toolOk(toolUseId, res as unknown as Record<string, unknown>);
  }

  async function requestDeleteCredential(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const credId = reqStr(input, 'id');
    const all = await deps.adminService.listCredentials();
    const target = all.find((c) => c.id === credId);
    if (target === undefined) {
      return toolError(toolUseId, `凭据 ${credId} 不存在`);
    }
    return toolOk(toolUseId, {
      status: 'pending_confirmation',
      action: 'delete_credential',
      resource_type: 'credential',
      resource_id: target.id,
      label: `${target.provider} · ${target.masked} (${target.id})`,
      detail: `将永久删除 ${target.access_path} 的凭据 ${target.masked}。`,
      hint: '删除操作需要用户在界面工具卡片上点击「确认删除」按钮后才会执行。',
    });
  }

  async function setModelVisibility(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const model = reqStr(input, 'model');
    const exposed = optBool(input, 'exposed');
    if (exposed === undefined) {
      return toolError(toolUseId, '缺少布尔参数 exposed');
    }
    const res = await deps.adminService.setModelExposed(actorOf(ctx), model, exposed);
    return toolOk(toolUseId, res as unknown as Record<string, unknown>);
  }

  async function syncModels(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const kindRaw = optStr(input, 'kind');
    const kind =
      kindRaw === 'offline_catalog_refresh' ? 'offline_catalog_refresh' : 'upstream_discovery';
    const res = await deps.adminService.triggerSync(actorOf(ctx), kind);
    return toolOk(toolUseId, res as unknown as Record<string, unknown>);
  }

  async function listAliases(toolUseId: string): Promise<ToolResultPart> {
    const items = await deps.adminService.listAliases();
    return toolOk(toolUseId, { count: items.length, aliases: items });
  }

  async function upsertAlias(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const kind = reqStr(input, 'kind');
    if (kind !== 'exact' && kind !== 'prefix') {
      return toolError(toolUseId, 'kind 必须是 exact 或 prefix');
    }
    const pattern = reqStr(input, 'pattern');
    const provider = reqStr(input, 'provider');
    const accessPath = reqStr(input, 'access_path');
    const model = reqStr(input, 'model');
    const id = optStr(input, 'id');
    const priority = optNum(input, 'priority');
    const enabled = optBool(input, 'enabled');
    const note = optStr(input, 'note');
    const res = await deps.adminService.upsertAlias(actorOf(ctx), {
      ...(id === undefined ? {} : { id }),
      kind,
      pattern,
      target: { provider, access_path: accessPath, model },
      ...(priority === undefined ? {} : { priority }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(note === undefined ? {} : { note }),
    });
    if (!res.ok) return toolError(toolUseId, res.errors.join('；'));
    return toolOk(toolUseId, { status: 'saved', rule: res.rule });
  }

  async function requestDeleteAlias(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const id = reqStr(input, 'id');
    const all = await deps.adminService.listAliases();
    const target = all.find((a) => a.id === id);
    if (target === undefined) {
      return toolError(toolUseId, `别名规则 ${id} 不存在`);
    }
    return toolOk(toolUseId, {
      status: 'pending_confirmation',
      action: 'delete_alias',
      resource_type: 'alias',
      resource_id: target.id,
      label: `${target.pattern} → ${target.target.access_path}/${target.target.model}`,
      detail: `将永久删除别名规则「${target.pattern}」(${target.id})。`,
      hint: '删除操作需要用户在界面工具卡片上点击「确认删除」按钮后才会执行。',
    });
  }

  async function listVirtualKeys(toolUseId: string): Promise<ToolResultPart> {
    const items = await deps.adminService.listVirtualKeys();
    return toolOk(toolUseId, { count: items.length, virtual_keys: items });
  }

  async function revokeVirtualKey(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const keyId = reqStr(input, 'key_id');
    const res = await deps.adminService.revokeVirtualKey(actorOf(ctx), keyId);
    if (!res.ok) return toolError(toolUseId, res.error);
    return toolOk(toolUseId, { status: 'revoked', key: res.key });
  }

  async function requestDeleteVirtualKey(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const keyId = reqStr(input, 'key_id');
    const all = await deps.adminService.listVirtualKeys();
    const target = all.find((k) => k.key_id === keyId);
    if (target === undefined) {
      return toolError(toolUseId, `客户端密钥 ${keyId} 不存在`);
    }
    return toolOk(toolUseId, {
      status: 'pending_confirmation',
      action: 'delete_virtual_key',
      resource_type: 'virtual_key',
      resource_id: target.key_id,
      label: `${target.name} (${target.masked})`,
      detail: `将永久删除客户端密钥「${target.name}」(${target.key_id})，使用该密钥的客户端将立即失去访问权限。`,
      hint: '删除操作需要用户在界面工具卡片上点击「确认删除」按钮后才会执行。',
    });
  }

  async function listRouteGraphs(toolUseId: string): Promise<ToolResultPart> {
    const graphs = await deps.adminService.listRouteGraphs();
    return toolOk(toolUseId, { count: graphs.length, route_graphs: graphs });
  }

  async function upsertRouteGraph(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const id = reqStr(input, 'id');
    const label = reqStr(input, 'label');
    const entryNodeId = reqStr(input, 'entry_node_id');
    if (!Array.isArray(input['nodes']) || !Array.isArray(input['edges'])) {
      return toolError(toolUseId, 'nodes 与 edges 必须是数组');
    }
    const enabled = optBool(input, 'enabled');
    const note = optStr(input, 'note');
    const abilityModeRaw = optStr(input, 'ability_mode');
    const ability_mode =
      abilityModeRaw === 'min' || abilityModeRaw === 'max' || abilityModeRaw === 'custom'
        ? abilityModeRaw
        : undefined;
    const abilities =
      typeof input['abilities'] === 'object' && input['abilities'] !== null && !Array.isArray(input['abilities'])
        ? (input['abilities'] as RouteGraphUpsertRequest['abilities'])
        : undefined;
    const rawNodes = input['nodes'] as RouteGraphUpsertRequest['nodes'];
    const rawEdges = input['edges'] as RouteGraphUpsertRequest['edges'];
    const laidOutNodes = hasOverlappingNodes(rawNodes)
      ? autoLayoutRouteGraph({
          id,
          label,
          enabled: enabled ?? true,
          entry_node_id: entryNodeId,
          nodes: rawNodes,
          edges: rawEdges,
        })
      : rawNodes;
    const payload: RouteGraphUpsertRequest = {
      id,
      label,
      entry_node_id: entryNodeId,
      nodes: laidOutNodes,
      edges: rawEdges,
      ...(enabled === undefined ? {} : { enabled }),
      ...(ability_mode === undefined ? {} : { ability_mode }),
      ...(abilities === undefined ? {} : { abilities }),
      ...(note === undefined ? {} : { note }),
    };
    const res = await deps.adminService.upsertRouteGraph(actorOf(ctx), payload);
    if (!res.ok) return toolError(toolUseId, (res.errors ?? ['路由图校验失败']).join('；'));
    return toolOk(toolUseId, { status: 'saved', graph: res.graph });
  }

  async function simulateRouteGraph(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const graphId = reqStr(input, 'graph_id');
    const model = optStr(input, 'model') ?? graphId;
    const stream = optBool(input, 'stream') ?? true;
    const clientFormat = (optStr(input, 'client_format') ?? 'openai.chat') as ProviderConfig['dialect'];
    const prompt = optStr(input, 'message_text');
    const res = await deps.adminService.simulateRouteGraph({
      graph_id: graphId,
      request: {
        model,
        stream,
        client_format: clientFormat,
        ...(prompt === undefined ? {} : { prompt }),
      },
    });
    return toolOk(toolUseId, res as unknown as Record<string, unknown>);
  }

  async function requestDeleteRouteGraph(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const id = reqStr(input, 'id');
    const existing = await deps.adminService.getRouteGraph(id);
    if (existing === undefined) {
      return toolError(toolUseId, `路由图 ${id} 不存在`);
    }
    return toolOk(toolUseId, {
      status: 'pending_confirmation',
      action: 'delete_route_graph',
      resource_type: 'route_graph',
      resource_id: existing.id,
      label: `${existing.label} (${existing.id})`,
      detail: `将永久删除路由图「${existing.label}」(${existing.id})，匹配该标识符的请求将停止路由。`,
      hint: '删除操作需要用户在界面工具卡片上点击「确认删除」按钮后才会执行。',
    });
  }

  async function getRoutingTelemetry(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const refresh = optBool(input, 'refresh') ?? false;
    const res = refresh
      ? await deps.adminService.refreshRoutingTelemetry()
      : await deps.adminService.getRoutingTelemetry();
    return toolOk(toolUseId, {
      snapshots: res.snapshots,
      provider_options_count: Object.keys(res.provider_options).length,
    });
  }

  async function listSettings(toolUseId: string): Promise<ToolResultPart> {
    const res = await deps.adminService.listSettings();
    return toolOk(toolUseId, {
      count: res.items.length,
      items: res.items.map((s) => ({
        id: s.id,
        group: s.group,
        label: s.label,
        type: s.type,
        value: s.id === 'agent_system_prompt' ? '(omitted)' : s.value,
        source: s.source,
        editable: s.editable,
      })),
    });
  }

  async function updateSetting(
    toolUseId: string,
    input: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<ToolResultPart> {
    const id = reqStr(input, 'id');
    if (id === 'agent_tools' || id === 'agent_redaction_rules' || id === 'agent_redaction_detect_js') {
      return toolError(toolUseId, `安全策略限制：设置项 ${id} 只能由管理员在界面手动修改`);
    }
    if (!('value' in input)) {
      return toolError(toolUseId, '缺少参数 value');
    }
    const res = await deps.adminService.updateSetting(actorOf(ctx), id, input['value'] as SettingValue);
    if (!res.ok) return toolError(toolUseId, res.error);
    return toolOk(toolUseId, { status: 'updated', item: res.item });
  }

  async function getGatewayDoc(
    toolUseId: string,
    input: Record<string, unknown>,
  ): Promise<ToolResultPart> {
    const rawTopic = optStr(input, 'topic')?.toLowerCase() ?? 'index';
    const topic = rawTopic === 'all' ? 'index' : rawTopic;
    if (topic === 'index') {
      return toolOk(toolUseId, {
        topic: 'index',
        available_topics: GATEWAY_DOC_INDEX,
        hint: '请传入具体 topic 调用 get_gateway_doc 获取详细 Schema 与示例。',
      });
    }
    const doc = GATEWAY_DOC_TOPICS[topic];
    if (doc === undefined) {
      return toolError(
        toolUseId,
        `未知文档主题 "${topic}"。可用主题：${Object.keys(GATEWAY_DOC_TOPICS).join('、')}`,
      );
    }
    return toolOk(toolUseId, { topic, ...doc });
  }
}

const GATEWAY_DOC_INDEX: ReadonlyArray<{ topic: string; summary: string }> = [
  { topic: 'route_graph', summary: '路由图引擎 DAG 节点/边完整 Schema、VM-JS 沙盒上下文与可运行 JSON 示例' },
  { topic: 'channels_credentials', summary: '渠道 dialect、access_path、模型目录来源与安全录密流程' },
  { topic: 'models_aliases', summary: '模型可见性、namespace/model 命名与 exact/prefix 别名规则' },
  { topic: 'virtual_keys_plugins', summary: '客户端密钥细粒度权限与插件多平面挂载（agent / data_plane）' },
  { topic: 'confirmation_redaction', summary: '删除二次确认（pending_confirmation）与密钥脱敏机制' },
];

const GATEWAY_DOC_TOPICS: Record<string, { title: string; content: string; example?: unknown }> = {
  route_graph: {
    title: '路由图引擎（RouteGraph）Schema 与 VM-JS 沙盒说明',
    content: [
      '## 1. 顶层字段（upsert_route_graph 参数）',
      '- `id`: string（同时作为数据面调用时的 model 标识符，例如 `smart-chat`）',
      '- `label`: string（显示名称）',
      '- `enabled`: boolean（默认 true）',
      '- `entry_node_id`: string（必须指向 nodes 中存在的 entry 节点 id）',
      '- `nodes`: RouteGraphNode[]',
      '- `edges`: RouteGraphEdge[]',
      '',
      '## 2. 四种节点（以 `kind` 区分，不是 `type` / `data`）',
      '1) `entry`: `{ id, kind: "entry", label, position: { x, y } }`',
      '2) `condition`: `{ id, kind: "condition", label, position: { x, y }, condition: { has_images?, has_tools?, thinking_enabled?, min_estimated_tokens?, max_estimated_tokens?, client_formats?, message_contains? } }`',
      '   - 输出端口：`from_port` 为 `"true"` 或 `"false"`。',
      '3) `js_script`: `{ id, kind: "js_script", label, position: { x, y }, script: { code, timeout_ms?, ports? } }`',
      '   - 沙盒内只读全局变量：`ctx`（含 `ctx.request`、`ctx.canonical`、`ctx.telemetry`、`ctx.credits`、`ctx.provider(id)`）、`Math`、`JSON`、`Number`、`String`、`Boolean`、`Array`、`Object`。',
      '   - 脚本可使用 `return` 返回：boolean（映射为 `"true"` / `"false"`）、string（自定义端口名，空串为 `"next"`）、或对象 `{ branch?, port?, overrides? }`。',
      '4) `provider_target`: `{ id, kind: "provider_target", label, position: { x, y }, target: { provider, access_path, model, max_context_tokens?, require_vision?, provider_options?, overrides? }, extension_ports?: string[] }`',
      '   - 注意：`provider`、`access_path`、`model` 必须来自 `list_channels` / `list_models` 的真实值。',
      '   - `extension_ports`: 启用该 Provider 的扩展分支端口（如 DeepSeek 的 `off_peak` / `low_balance`、MiMo 的 `low_credits`、通用 `quota_exceeded`），命中时沿对应 `from_port` 出边分流；另可用 `fallback` 兜底。',
      '',
      '## 3. 全节点前置 JS 钩子（hook_script / script 端口）',
      '- 任意非 `entry` 节点均可附带 `hook_script: { code, timeout_ms? }`，或从 `js_script` 节点拉一条 `from_port: "script"` 的边连入目标节点。',
      '- 前置脚本返回 `false` 时拦截该节点（`provider_target` 自动走 `fallback`，`condition` 走 `false`），返回 `{ overrides }` 时动态改写请求参数。',
      '',
      '## 4. 边（RouteGraphEdge）',
      '`{ id, from, from_port, to, priority, label? }`',
      '- `from_port`: `"next"`（entry 默认出边）| `"true"` | `"false"` | `"fallback"` | `"script"`（接至目标节点前置钩子）| `<Provider 扩展端口>` | `<js_script 自定义端口>`',
      '- `priority`: number（数字越小优先级越高，常用 `0`、`1`）',
      '- 若未填或不慎生成重叠坐标，网关会自动拓扑分层整理布局。',
    ].join('\n'),
    example: {
      id: 'smart-demo',
      label: '示例条件路由图',
      enabled: true,
      entry_node_id: 'n-entry',
      nodes: [
        { id: 'n-entry', kind: 'entry', label: '入口', position: { x: 80, y: 160 } },
        {
          id: 'n-cond',
          kind: 'condition',
          label: '含图检测',
          position: { x: 300, y: 160 },
          condition: { has_images: true },
        },
        {
          id: 'n-vision',
          kind: 'provider_target',
          label: '多模态目标',
          position: { x: 560, y: 80 },
          target: { provider: 'openai', access_path: 'openai.responses', model: 'gpt-4.1' },
        },
        {
          id: 'n-text',
          kind: 'provider_target',
          label: '纯文本目标',
          position: { x: 560, y: 240 },
          target: { provider: 'deepseek', access_path: 'openai.chat', model: 'deepseek-chat' },
        },
      ],
      edges: [
        { id: 'e1', from: 'n-entry', from_port: 'next', to: 'n-cond', priority: 0 },
        { id: 'e2', from: 'n-cond', from_port: 'true', to: 'n-vision', priority: 0, label: '含图' },
        { id: 'e3', from: 'n-cond', from_port: 'false', to: 'n-text', priority: 1, label: '纯文本' },
      ],
    },
  },
  channels_credentials: {
    title: '渠道与凭据（Provider & Credential）说明',
    content: [
      '- 常见 `dialect`：`openai.chat`、`openai.responses`、`anthropic.messages`、`gemini.generateContent`。',
      '- 接入新渠道请调用 `add_provider`；更换已有渠道密钥请直接调用 `update_provider_credential`（无需先逐条删除旧凭据），均不要向用户索要密钥明文；工具会返回 `needs_credential` 触发前端安全弹窗一次录入并级联更新所有接入路径。',
      '- `test_provider` 仅做连通性探测，`probe_credential` 可逐条验证凭据健康度。',
    ].join('\n'),
  },
  models_aliases: {
    title: '模型目录与别名（Models & Aliases）说明',
    content: [
      '- 先用 `list_models` 查看模型全名、所属渠道 `provider` 与 `access_path`。',
      '- `upsert_alias` 的 `kind` 支持 `exact`（精确匹配）与 `prefix`（前缀匹配），`target` 须包含 `{ provider, access_path, model }`。',
      '- 修改后可用 `resolve_alias` 预览解析结果。',
    ].join('\n'),
  },
  virtual_keys_plugins: {
    title: '客户端密钥权限与插件挂载说明',
    content: [
      '- `create_virtual_key` 返回的 `key` 明文仅此一次展示，提醒用户妥善保存。',
      '- 客户端密钥支持细粒度权限：`allowed_models`、模态（`chat` / `images` / `audio_tts` / `audio_asr` 等）、插件白/黑名单（`allowed_plugins` / `disabled_plugins`）、`allow_streaming`、`allow_message_persistence`、RPM/TPM 与预算上限。',
      '- 插件支持 `mount_targets`：`agent`（内置助手）与 `data_plane`（客户端 API 请求），可在管理面 `#/plugins` 页面启停与查看日志。',
    ].join('\n'),
  },
  confirmation_redaction: {
    title: '删除二次确认与密钥脱敏约束',
    content: [
      '- 所有 `delete_*` 工具不会直接删除资源，而是返回 `pending_confirmation`；用户在前端卡片点击「确认删除」后才真正执行。',
      '- 用户输入框与工具输出均经过脱敏处理，禁止尝试还原或猜测真实密钥。',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// 小工具函数
// ---------------------------------------------------------------------------

function toolOk(toolUseId: string, payload: Record<string, unknown>): ToolResultPart {
  return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(payload) };
}

function toolError(toolUseId: string, message: string): ToolResultPart {
  return { type: 'tool_result', tool_use_id: toolUseId, content: message, is_error: true };
}

function reqStr(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`缺少参数 ${key}（应为非空字符串）`);
  }
  return v.trim();
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return v.trim();
}

function optNum(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function optStrArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const v = input[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return out.length === 0 ? undefined : out.map((s) => s.trim());
}

function optBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === 'boolean' ? v : undefined;
}
