/**
 * config/agent.ts —— Agent 配置枢纽：默认值单一出处 + 运行期快照 + 披露队列。
 *
 * 设计依据：docs/design/95-agent-chat.md §6（配置项清单）、§3.3（明文披露通道）。
 *
 * ## 为什么放在 config/
 *
 * 仓库主人要求「Agent/Chat 相关的一切都要能在设置里配，不许硬编码」，且默认值集中在
 * 单一出处。默认值与工具名清单被设置服务（config/settings.ts）、插件
 * （plugins/agent-admin.ts）、聊天端点（admin/agent-chat.ts）三处消费，各写一份必然
 * 漂移；而 `config/` 是三处都能正向依赖的方向（反过来会让 config 依赖 admin）。
 *
 *   - `AGENT_DEFAULTS`  —— 默认值的唯一出处（设置表引用它，不重复写字面量）；
 *   - `AGENT_TOOL_NAMES` —— 工具名清单的唯一出处（插件与 `agent_tools` 设置都引用它）；
 *   - `AgentConfigHub`  —— 运行期配置快照 + 设置热生效的落点 + 单次披露队列。
 *
 * 四层优先级（加密存储 > env > 配置文件 > 内置默认）由 `config/settings.ts` 负责，
 * 本文件只提供「生效值长什么样」与「往哪写」。
 */

import type { SettingValue } from './settings.js';
import type { RedactionConfig, RedactionRule } from '../storage/redaction.js';
import { BUILTIN_REDACTION_RULES } from '../storage/redaction.js';

// ---------------------------------------------------------------------------
// 工具名清单
// ---------------------------------------------------------------------------

/**
 * Agent 管理工具名（`onToolCall` 的 `call.name`）。
 *
 * 顺序即设置页里的展示顺序。新增工具只需要：在这里加一个名字、在
 * `plugins/agent-admin.ts` 里加一个分支——`agent_tools` 设置自动就能开关它。
 */
export const AGENT_TOOL_NAMES = [
  'list_channels',
  'add_provider',
  'update_provider',
  'update_provider_credential',
  'delete_provider',
  'test_provider',
  'list_credentials',
  'probe_credential',
  'delete_credential',
  'list_models',
  'set_model_visibility',
  'sync_models',
  'list_aliases',
  'upsert_alias',
  'delete_alias',
  'resolve_alias',
  'list_virtual_keys',
  'create_virtual_key',
  'revoke_virtual_key',
  'delete_virtual_key',
  'list_route_graphs',
  'upsert_route_graph',
  'simulate_route_graph',
  'delete_route_graph',
  'usage_summary',
  'get_routing_telemetry',
  'list_settings',
  'update_setting',
  'get_gateway_doc',
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** 默认开启的工具 = 全部。 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = AGENT_TOOL_NAMES;

// ---------------------------------------------------------------------------
// 默认值（单一出处）
// ---------------------------------------------------------------------------

/** 默认的系统提示词。讲清三件事：看不到密钥、用户贴的密钥已被替换、需要密钥时走弹窗。 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  '你是 AgentGateway 自带的管理助手，可以通过工具查看与修改网关配置（渠道、凭据、模型目录、别名、客户端密钥、路由图引擎、遥测/余额、用量与运行时设置）。',
  '硬约束：',
  '1. 你看不到任何上游密钥。凭据列表只返回掩码与元数据；用户消息里形态像密钥的内容已被替换成占位符。',
  '2. 需要接入新渠道时调用 add_provider，需要更换已有渠道密钥时调用 update_provider_credential（均不要向用户索要密钥）；工具会返回 needs_credential 触发界面安全弹窗录入/级联更换，你下一轮再继续。',
  '3. 所有删除操作（delete_*）都会返回 pending_confirmation，需要用户在界面工具卡片上点击「确认删除」按钮后才会真正执行，不要编造“已删除”。',
  '4. 不要猜测、不要编造渠道、模型或路由图结构；拿不准就调用对应工具查，或调用 get_gateway_doc 按需查阅网关概念、Schema 与示例。',
  '回复用中文，简洁，先说结论再给必要的细节。',
].join('\n');

/**
 * 默认的用户 JS 判定函数源码（`(text) => 命中区间[]`）。
 *
 * 只在前端执行：服务端不跑用户 JS（95 §5.3：服务端执行用户代码等于远程代码执行）。
 * 默认这份补上内置权威规则不覆盖的两类：Bearer 头与 PEM 私钥块。
 */
export const DEFAULT_AGENT_REDACTION_DETECT_JS = [
  '// 密钥判定函数：入参 text，返回命中区间 [[start, end], ...]。',
  '// 命中任一即被替换成占位符。仅在浏览器里执行，保存后对预览与最终发送立即生效。',
  'function detect(text) {',
  '  const hits = [];',
  '  const add = (re) => {',
  '    for (const m of text.matchAll(re)) {',
  '      if (m.index !== undefined) hits.push([m.index, m.index + m[0].length]);',
  '    }',
  '  };',
  '  add(/\\bBearer\\s+[A-Za-z0-9._-]{16,}/g);',
  '  add(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----/g);',
  '  return hits;',
  '}',
].join('\n');

/** Agent 相关设置项的默认值。**唯一出处**：设置表与「恢复默认」都引用它。 */
export const AGENT_DEFAULTS = {
  access_path: '',
  model: '',
  system_prompt: DEFAULT_AGENT_SYSTEM_PROMPT,
  tools: DEFAULT_AGENT_TOOLS,
  redaction_rules: [] as RedactionRule[],
  redaction_detect_js: DEFAULT_AGENT_REDACTION_DETECT_JS,
  redaction_placeholder: '<redacted_key>',
  redact_tool_results: true,
  temperature: 0.2,
  max_tokens: 2048,
  max_turns: 8,
  stream: true,
  persist_messages: false,
} as const;

// ---------------------------------------------------------------------------
// 运行期配置
// ---------------------------------------------------------------------------

/** 生效的 Agent 配置（聊天端点、插件、设置服务都读这一份）。 */
export interface AgentConfig {
  access_path: string;
  model: string;
  system_prompt: string;
  /** 启用中的工具名。 */
  tools: string[];
  redaction_rules: RedactionRule[];
  redaction_detect_js: string;
  redaction_placeholder: string;
  redact_tool_results: boolean;
  temperature: number;
  max_tokens: number;
  max_turns: number;
  stream: boolean;
  persist_messages: boolean;
}

/** 默认配置的深拷贝（数组要给新的，避免调用方改到常量上）。 */
export function defaultAgentConfig(): AgentConfig {
  return {
    access_path: AGENT_DEFAULTS.access_path,
    model: AGENT_DEFAULTS.model,
    system_prompt: AGENT_DEFAULTS.system_prompt,
    tools: [...AGENT_DEFAULTS.tools],
    redaction_rules: [],
    redaction_detect_js: AGENT_DEFAULTS.redaction_detect_js,
    redaction_placeholder: AGENT_DEFAULTS.redaction_placeholder,
    redact_tool_results: AGENT_DEFAULTS.redact_tool_results,
    temperature: AGENT_DEFAULTS.temperature,
    max_tokens: AGENT_DEFAULTS.max_tokens,
    max_turns: AGENT_DEFAULTS.max_turns,
    stream: AGENT_DEFAULTS.stream,
    persist_messages: AGENT_DEFAULTS.persist_messages,
  };
}

/** 某个工具当前是否启用（白名单制：不在 `tools` 里就不可见）。 */
export function agentToolEnabled(config: AgentConfig, name: string): boolean {
  return config.tools.includes(name);
}

/** 当前脱敏配置（聊天端点与插件主机都从这里取，热改即时生效）。 */
export function agentRedactionConfig(config: AgentConfig): RedactionConfig {
  return {
    placeholder: config.redaction_placeholder,
    rules: config.redaction_rules,
    redactToolResults: config.redact_tool_results,
  };
}

/** 内置权威规则的数据形态（给前端取，前后端执行同一份）。 */
export function builtinRedactionRules(): RedactionRule[] {
  return BUILTIN_REDACTION_RULES.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// 配置枢纽
// ---------------------------------------------------------------------------

/** 设置服务与运行期之间的那一层：持有生效配置，接受设置项写入。 */
export class AgentConfigHub {
  private current: AgentConfig;

  constructor(initial: AgentConfig = defaultAgentConfig()) {
    this.current = initial;
  }

  /** 当前生效配置的快照（深拷贝，调用方改不动内部状态）。 */
  snapshot(): AgentConfig {
    return {
      ...this.current,
      tools: [...this.current.tools],
      redaction_rules: this.current.redaction_rules.map((r) => ({ ...r })),
    };
  }

  /** 用一次设置写入更新某一项（`config/settings.ts` 的 `apply` 出口）。 */
  set(field: keyof AgentConfig, value: SettingValue): void {
    this.current = { ...this.current, [field]: value } as AgentConfig;
  }
}
