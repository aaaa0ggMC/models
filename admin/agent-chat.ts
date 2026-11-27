/**
 * admin/agent-chat.ts —— 内置对话端点（`POST /admin/api/chat`）。
 *
 * 设计依据：docs/design/95-agent-chat.md §6.1（跑 agent 的模型）、§7.1（脱敏点）、
 * §3.3（明文披露通道）、§7.2（会话持久化）。
 *
 * ## 形态
 *
 * 一个端点，两种响应：按 `stream` 标志（缺省读设置 `agent_stream`）返回 SSE 或 JSON。
 * 两条路都走同一条推理链路——把一份 OpenAI Chat 形态的请求体交给 `PipelineRunner.run`，
 * S0–S10 全过：插件、路由、重试与回退、agentic loop、计量与定价。这就是 dogfooding
 * （60-billing-and-dogfooding.md §6.1：数据面与 Tier-1/Tier-2 完全一致，
 * 不存在「后台另一套权限」）。
 *
 * 流式响应**复用网关自己的 SSE 编码**（OpenAI Chat 方言的 `data: {...}` 帧），
 * 因此浏览器拿到的字节与一个普通客户端打 `/v1/chat/completions` 拿到的一致；
 * 末尾再追加一个 `event: agent` 帧，带上折叠后的工具调用与明文披露。
 *
 * ## 三个呈现字段（96 §3.5，全部可选）
 *
 * `agent` 汇总帧与 JSON 响应各带 `reasoning`（思考正文）/ `duration_ms`
 * （回合计时）/ `usage`（token 用量）。只在既有帧上**加键**，不改帧类型、不改
 * 帧序（95 §6.1 仍是权威）：旧前端忽略新键，新前端容忍旧服务端（全部
 * `undefined` 时对应 UI 件不渲染）。`reasoning` 不是新管道——AG-IR 早已建模
 * thinking part、OpenAI Chat 编解码器也早已双向映射 `reasoning_content`，
 * 这里只是把它取出来（§3.2 的事实链）。
 *
 * ## 数据面鉴权（66 §1 / §2）
 *
 * 这条路上唯一的差别在 S0：内置对话**不向数据面鉴权器要客户端凭据**——它前面的门
 * 是管理员会话，客户端头也不会透传进 pipeline 输入。豁免是代码级的
 * （`PipelineInput.auth_exemption`，表在 S0 的 `DATA_PLANE_AUTH_EXEMPTIONS`），
 * 不是请求头，因此数据面客户端伪造不了；用量仍归因到固定的非人类 `key_id`
 * （`agent-builtin`），不变匿名。回归测试：`tests/agent-chat-data-plane-auth.test.ts`。
 *
 * ## 脱敏点（95 §7.1）
 *
 * | 文本 | 在哪脱敏 |
 * | --- | --- |
 * | 用户消息 | 本文件，进 canonical 之前 |
 * | 系统提示词 | 本文件，同上 |
 * | 工具结果 | `plugins/redaction-host.ts` 包住 `runOnToolCall` |
 *
 * 客户端也会先脱敏一遍（用户 JS 只在浏览器跑），服务端这一遍是权威兜底：
 * 客户端被绕过时依然生效，且幂等（占位符本身不是密钥形态，不会二次替换）。
 *
 * ## 会话
 *
 * 无状态：历史由客户端随请求带上（与 OpenAI Chat 一致）。`agent_persist_messages`
 * 开启时把「已脱敏的用户消息 + 助手回复 + 工具调用摘要」写进加密存储
 * （`admin/agent-history.ts`），只用于刷新后翻历史，不参与请求构造。
 */

import type { ServerResponse } from 'node:http';
import type { Clock } from '../ir/clock.js';
import type { ClientSink } from '../gateway-core/pipeline/sink.js';
import type { PipelineInput, PipelineOutcome } from '../gateway-core/pipeline/types.js';
import type { AdminService } from './service.js';
import type { AliasResolver } from './aliases.js';
import type {
  AgentChatRequest,
  AgentChatResponse,
  AgentChatUsage,
  AgentToolCallView,
  AgentToolResultView,
  AgentSecretDisclosure,
} from './api-types.js';
import { agentRedactionConfig, type AgentConfigHub } from '../config/agent.js';
import { agentToolDefs } from '../plugins/agent-admin.js';
import type { ToolCallRecord, ToolCallRecorder } from '../plugins/tool-recorder.js';
import { redactText } from '../storage/redaction.js';
import { appendAgentTurn, type AgentHistoryStore } from './agent-history.js';

export interface AgentChatDeps {
  /**
   * 跑一轮推理（S0–S10 全过）。
   *
   * 用函数而不是 `PipelineRunner` 实例：runner 在管理面装配之后才构造，
   * 调用方以 thunk 形式给过来（见 composition-root.ts 的 `runTurn`）。
   */
  runTurn(input: PipelineInput, sink: ClientSink): Promise<PipelineOutcome>;
  adminService: AdminService;
  aliasResolver: AliasResolver;
  configHub: AgentConfigHub;
  /** 工具调用旁路记录（与 RedactingPluginHost 同一个实例）。 */
  recorder?: ToolCallRecorder;
  history?: AgentHistoryStore;
  /** 审计用的管理员标识。 */
  actor?: string;
  /**
   * 回合计时（96 §3.5 的 `duration_ms`）。
   *
   * 缺省时**不输出**该字段（前端据此不渲染过程条的耗时）——不拿前端
   * `performance.now()` 冒充：那个量含网络与排队，语义不同且刷新会错。
   */
  clock?: Clock;
}

/**
 * 处理一次对话请求。
 *
 * `readJson` 由路由层注入（`admin/routes.ts` 的 `readJson`，自带限额与 400 处理）。
 * 返回 `true` 表示响应已写完（含 SSE），调用方不要再动 `res`。
 */
export async function handleAgentChat(
  res: ServerResponse,
  deps: AgentChatDeps,
  body: unknown,
): Promise<boolean> {
  const config = deps.configHub.snapshot();
  const messages = normalizeMessages((body as AgentChatRequest | undefined)?.messages);
  if (messages === undefined) {
    sendJson(res, 400, { error: { code: 'invalid_request', message: 'messages 格式不正确' } });
    return true;
  }
  const req = body as AgentChatRequest;
  const stream = typeof req.stream === 'boolean' ? req.stream : config.stream;
  let accessPath = typeof req.access_path === 'string' ? req.access_path : config.access_path;
  let model = typeof req.model === 'string' ? req.model : config.model;
  const isNonChatModelName = (m: string): boolean =>
    /(^|[-_/.])(asr|stt|whisper|transcribe|tts|voiceclone|voicedesign|speech|embed|embedding|embeddings|bge|text-embedding|decision|decisions|rerank|reranker|imagen|dall-e|gpt-image|chatgpt-image|grok-imagine|flux|sdxl|wanx|kolors)([-_/.]|$)|(?:^|\/)jev(?:[-_.\d]|$)/i.test(
      m,
    );

  // 若历史保存的默认模型是语音/生图/向量模型，自动重置以便回落到真实对话模型
  if (model !== '' && isNonChatModelName(model)) {
    model = '';
  }

  if (model === '' || accessPath === '') {
    if (accessPath === '' && model !== '') {
      const resolved = deps.aliasResolver.resolve(model, 'chat');
      if (resolved !== undefined) accessPath = resolved.target.access_path;
    }
    if (model === '' || accessPath === '') {
      const caps = (await deps.adminService.listCapabilityMatrix?.()) ?? [];
      const firstChat =
        caps.find(
          (c) =>
            !c.internal &&
            (c.modality ?? 'chat') === 'chat' &&
            !isNonChatModelName(c.model) &&
            (accessPath === '' || c.access_path === accessPath) &&
            (model === '' || c.model === model),
        ) ??
        caps.find(
          (c) =>
            !c.internal &&
            (c.modality ?? 'chat') === 'chat' &&
            !isNonChatModelName(c.model),
        );
      if (firstChat === undefined) {
        sendJson(res, 400, {
          error: {
            code: 'invalid_agent_model',
            message: '还没有可用渠道，请先配置一个支持对话的渠道和模型。',
          },
        });
        return true;
      }
      if (accessPath === '') accessPath = firstChat.access_path;
      if (model === '') model = firstChat.model;
    }
  }

  // 若选中的渠道配置了 namespace，自动补齐 `<ns>/<model>` 以通过命名空间路由
  const nsRules = deps.aliasResolver.listNamespaces?.() ?? [];
  const channelNs = nsRules.find((r) => r.enabled && r.access_paths.includes(accessPath));
  if (
    channelNs !== undefined &&
    channelNs.namespace !== '' &&
    !model.startsWith(`${channelNs.namespace}/`)
  ) {
    const namespacedCandidate = `${channelNs.namespace}/${model}`;
    if (deps.aliasResolver.resolve(namespacedCandidate, 'chat') !== undefined) {
      model = namespacedCandidate;
    }
  }

  // 模型必须真的落到配置的渠道上（95 §6.1）：支持按显式 (accessPath, model) 校验
  let routeError = checkAgentRoute(deps.aliasResolver, model, accessPath);
  if (routeError !== undefined) {
    const bareModel =
      channelNs !== undefined && model.startsWith(`${channelNs.namespace}/`)
        ? model.slice(channelNs.namespace.length + 1)
        : model;
    const caps = (await deps.adminService.listCapabilityMatrix?.()) ?? [];
    const inCapMatrix = caps.some(
      (c) => c.access_path === accessPath && (c.model === bareModel || c.model === model),
    );
    const providers = (await deps.adminService.listProviders?.()) ?? [];
    const inProviderStatic = providers.some(
      (p) =>
        p.enabled &&
        (`${p.id}.${p.dialect.replace('.', '-')}` === accessPath || p.id === accessPath) &&
        p.model_source.kind === 'static' &&
        (p.model_source.models.includes(bareModel) || p.model_source.models.includes(model)),
    );
    if (inCapMatrix || inProviderStatic) {
      routeError = undefined;
    }
  }
  if (routeError !== undefined) {
    sendJson(res, 400, { error: { code: 'invalid_agent_model', message: routeError } });
    return true;
  }

  const redaction = agentRedactionConfig(config);
  // 用户消息与系统提示词在这里脱敏（服务端权威）
  const systemPrompt = redactText(config.system_prompt, redaction).text;
  const chatMessages = messages.map((m) => ({
    role: m.role,
    content: redactText(m.content, redaction).text,
  }));

  const requestBody = buildUpstreamBody({
    model,
    systemPrompt,
    messages: chatMessages,
    tools: agentToolDefs(config.tools),
    temperature: config.temperature,
    maxTokens: config.max_tokens,
    maxTurns: config.max_turns,
    stream,
  });

  const input: PipelineInput = {
    client_format: 'openai.chat',
    raw_body: Buffer.from(JSON.stringify(requestBody), 'utf8'),
    // 脱敏过的头：鉴权头按 ALLOWED_HEADERS 白名单挡在外面，到不了这里；
    // 附带 x-ag-target-access-path 确保多渠道同名模型或带命名空间渠道精确命中用户所选渠道
    headers: {
      'content-type': 'application/json',
      ...(accessPath ? { 'x-ag-target-access-path': accessPath } : {}),
    },
    path: '/v1/chat/completions',
    query: {},
    // 数据面鉴权豁免（S0 的 DATA_PLANE_AUTH_EXEMPTIONS，唯一登记项）：
    // 这一层之前是管理员会话（admin/routes.ts），pipeline 输入由服务端构造、
    // 客户端头不会透传，因此不向数据面鉴权器要凭据——否则 virtual_key 模式下
    // 整条链路在进路由之前就失败（症状：界面拿到「缺少 API key」）。
    // 豁免是**代码级**的（PipelineInput 上的类型化字段），不是请求头，客户端
    // 伪造不了；用量归到固定的非人类 key_id，不变匿名（66 §1）。
    auth_exemption: { caller: 'agent-builtin' },
  };

  const sink = stream
    ? new StreamingAgentSink(res, deps.recorder)
    : new CollectingSink();
  // 回合计时起点（96 §3.5）：注入 Clock 而不是 Date.now()——ir/clock.ts 的硬约束
  const clock = deps.clock;
  const startedAt = clock?.now();
  try {
    const outcome = await deps.runTurn(input, sink);
    const records = deps.recorder?.take(outcome.trace.request_id) ?? [];
    const secrets = records.flatMap((r) => (r.secret === undefined ? [] : [r.secret]));
    const view = foldChat(sink.raw(), records, {
      ...(clock === undefined || startedAt === undefined
        ? {}
        : { duration_ms: Math.max(0, clock.now() - startedAt) }),
    });

    if (stream && sink instanceof StreamingAgentSink) {
      sink.dispose();
      sink.finish(view, secrets.map(disclosureView), view.error);
    } else if (stream) {
      writeAgentSse(res, view, secrets.map(disclosureView), view.error);
    } else {
      const payload: AgentChatResponse = {
        ok: view.error === undefined,
        reply: view.reply,
        model: view.model,
        tool_calls: view.tool_calls,
        secrets: secrets.map(disclosureView),
        // 96 §3.5：上游给了思考正文才带这个字段（推理模型）；没给就省略，
        // 前端据此整行不渲染——不给空串，那会让界面多一个空的思考行
        ...(view.reasoning === undefined ? {} : { reasoning: view.reasoning }),
        ...(view.error === undefined ? {} : { error: view.error }),
        // 三个新字段全部可选：上游不给就不出现在响应里，旧客户端照旧工作
        ...(view.reasoning === undefined ? {} : { reasoning: view.reasoning }),
        ...(view.duration_ms === undefined ? {} : { duration_ms: view.duration_ms }),
        ...(view.usage === undefined ? {} : { usage: view.usage }),
      };
      sendJson(res, view.error === undefined ? 200 : 502, payload);
    }

    if (config.persist_messages) {
      await appendAgentTurn(deps.history, {
        actor: deps.actor ?? 'agent',
        model: view.model === '' ? model : view.model,
        user: chatMessages.map((m) => m.content).join('\n'),
        reply: view.reply,
        tool_calls: view.tool_calls,
        created_key_ids: secrets.map((s) => s.key_id),
      });
    }
  } catch (err) {
    if (sink instanceof StreamingAgentSink) sink.dispose();
    // PipelineRunner 承诺不抛；这里是双保险。流式下首字节可能已发出，
    // 因此只能补一个 error 帧而不是改状态码（20 §S8）。
    if (!sink.started) {
      sendJson(res, 500, {
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : 'internal error',
        },
      });
    } else if (sink instanceof StreamingAgentSink) {
      sink.finish(
        { reply: '', model: '', tool_calls: [] },
        [],
        err instanceof Error ? err.message : 'internal error',
      );
    } else {
      writeAgentSse(
        res,
        { reply: '', model: '', tool_calls: [] },
        [],
        err instanceof Error ? err.message : 'internal error',
      );
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 组装上游请求体
// ---------------------------------------------------------------------------

function buildUpstreamBody(args: {
  model: string;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: ReturnType<typeof agentToolDefs>;
  temperature: number;
  maxTokens: number;
  maxTurns: number;
  stream: boolean;
}): Record<string, unknown> {
  return {
    model: args.model,
    messages: [
      { role: 'system', content: args.systemPrompt },
      ...args.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    tools: args.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: 'auto',
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    stream: args.stream,
    ...(args.stream ? { stream_options: { include_usage: true } } : {}),
    // 20 §5.1 的网关循环触发条件；ag_max_turns 透传成 gateway.max_turns
    ag_agentic_loop: true,
    ag_max_turns: args.maxTurns,
  };
}

/** 模型名是否落到配置的 access path 上；返回 undefined = 一致。 */
export function checkAgentRoute(
  aliasResolver: AliasResolver,
  model: string,
  accessPath: string,
): string | undefined {
  const resolution = aliasResolver.resolve(model, 'chat');
  if (resolution === undefined) {
    return `模型 ${model} 解析不到任何渠道。请先把 Agent 模型改成可用的名字，或建好对应渠道。`;
  }
  if (resolution.target.access_path !== accessPath) {
    return (
      `模型 ${model} 解析到渠道 ${resolution.target.access_path}，` +
      `但设置里配置的是 ${accessPath}。请把两者改成一致。`
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sink：流式直写 + 收集原文；非流式只收集
// ---------------------------------------------------------------------------

/** Sink 的公共部分：收集写进来的原文，供结束后折叠。 */
abstract class BaseSink implements ClientSink {
  protected buffer = '';
  private _started = false;
  private _closed = false;

  get started(): boolean {
    return this._started;
  }

  get closed(): boolean {
    return this._closed;
  }

  /** 累积的原文（SSE 文本或 JSON 文本）。 */
  raw(): string {
    return this.buffer;
  }

  start(_status: number, _headers: Record<string, string>): void {
    this._started = true;
  }

  write(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.emit(chunk);
  }

  writeFrame(frame: unknown): void {
    this.emit(JSON.stringify(frame));
  }

  end(): void {
    this._closed = true;
  }

  protected abstract emit(chunk: string | Buffer): void;
}

/** 非流式：只收集。 */
class CollectingSink extends BaseSink {
  protected override emit(_chunk: string | Buffer): void {
    // 什么都不做：原文已在 BaseSink.write 里累积
  }
}

/**
 * 流式：将 Pipeline 实时产出的 OpenAI Chat SSE chunk 即时转译为管理面 SSE
 * （`event: reasoning` / `event: text` / `event: tool`），彻底消除缓冲等待。
 */
class StreamingAgentSink extends BaseSink {
  private sseRemainder = '';
  private sseHeadWritten = false;
  private emittedLiveText = false;
  private readonly emittedToolIds = new Set<string>();
  private requestId: string | undefined;
  private unsubscribeRecorder: (() => void) | undefined;

  constructor(
    private readonly res: ServerResponse,
    recorder?: ToolCallRecorder,
  ) {
    super();
    if (recorder !== undefined) {
      this.unsubscribeRecorder = recorder.subscribe((reqId, r) => {
        if (this.requestId !== undefined && reqId !== this.requestId) return;
        if (this.emittedToolIds.has(r.tool_use_id)) return;
        this.emittedToolIds.add(r.tool_use_id);
        this.ensureHead();
        const callView: AgentToolCallView = {
          id: r.tool_use_id,
          name: r.name,
          arguments: r.input,
          result: { text: r.result_text, ...(r.status === undefined ? {} : { status: r.status }) },
          is_error: r.is_error,
        };
        this.res.write(`event: tool\ndata: ${JSON.stringify(callView)}\n\n`);
      });
    }
  }

  override start(status: number, headers: Record<string, string>): void {
    super.start(status, headers);
    const reqId = headers['x-request-id'];
    if (typeof reqId === 'string' && reqId !== '') {
      this.requestId = reqId;
    }
  }

  private ensureHead(): void {
    if (this.sseHeadWritten) return;
    this.sseHeadWritten = true;
    this.res.socket?.setNoDelay(true);
    this.res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.res.flushHeaders?.();
  }

  protected override emit(chunk: string | Buffer): void {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.sseRemainder += str.replace(/\r\n/g, '\n');
    for (;;) {
      const idx = this.sseRemainder.indexOf('\n\n');
      if (idx === -1) break;
      const frame = this.sseRemainder.slice(0, idx);
      this.sseRemainder = this.sseRemainder.slice(idx + 2);
      const data = sseData(frame);
      if (data === undefined) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const choice of asArray(obj['choices'])) {
        const delta = (choice as Record<string, unknown>)['delta'] as
          | Record<string, unknown>
          | undefined;
        const deltaReasoning = delta?.['reasoning_content'] ?? delta?.['reasoning'];
        if (typeof deltaReasoning === 'string' && deltaReasoning !== '') {
          this.ensureHead();
          this.res.write(
            `event: reasoning\ndata: ${JSON.stringify({ reasoning: deltaReasoning })}\n\n`,
          );
        }
        const content = delta?.['content'];
        if (typeof content === 'string' && content !== '') {
          this.ensureHead();
          this.emittedLiveText = true;
          this.res.write(`event: text\ndata: ${JSON.stringify({ text: content })}\n\n`);
        }
      }
    }
  }

  dispose(): void {
    this.unsubscribeRecorder?.();
    this.unsubscribeRecorder = undefined;
  }

  finish(
    view: {
      reply: string;
      model: string;
      tool_calls: AgentToolCallView[];
      reasoning?: string;
      duration_ms?: number;
      usage?: AgentChatUsage;
    },
    secrets: AgentSecretDisclosure[],
    error?: string,
  ): void {
    this.ensureHead();
    if (!this.emittedLiveText && view.reply !== '') {
      for (const piece of splitForStream(view.reply)) {
        this.res.write(`event: text\ndata: ${JSON.stringify({ text: piece })}\n\n`);
      }
    }
    for (const call of view.tool_calls) {
      if (this.emittedToolIds.has(call.id)) continue;
      this.res.write(`event: tool\ndata: ${JSON.stringify(call)}\n\n`);
    }
    for (const secret of secrets) {
      this.res.write(`event: secret\ndata: ${JSON.stringify(secret)}\n\n`);
    }
    this.res.write(
      `event: agent\ndata: ${JSON.stringify({
        reply: view.reply,
        model: view.model,
        tool_calls: view.tool_calls,
        secrets,
        ...(view.reasoning === undefined ? {} : { reasoning: view.reasoning }),
        ...(view.duration_ms === undefined ? {} : { duration_ms: view.duration_ms }),
        ...(view.usage === undefined ? {} : { usage: view.usage }),
        ...(error === undefined ? {} : { error }),
      })}\n\n`,
    );
    this.res.write('event: end\ndata: {}\n\n');
    this.res.end();
  }
}

// ---------------------------------------------------------------------------
// 折叠：上游响应 + 工具调用记录 → 界面视图
// ---------------------------------------------------------------------------

/**
 * 把上游响应文本与工具调用记录折叠成界面要的视图。
 *
 * 工具结果**不来自上游响应**（网关 agentic loop 自己消费掉 tool_result），
 * 而来自 `ToolCallRecorder`——它在 `runOnToolCall` 上同时看到调用与结果，
 * 且拿到的是脱敏之后的那一份。
 *
 * `reasoning` / `usage` 来自上游响应本身（96 §3.5）：AG-IR 早已建模 thinking
 * part、OpenAI Chat 编解码器也早已双向映射 `reasoning_content`，这里缺的只是
 * 「多取一个字段」。`duration_ms` 由调用方量好传进来（服务端口径，见
 * `AgentChatDeps.clock`）。
 */
export function foldChat(
  raw: string,
  records: readonly ToolCallRecord[],
  extra?: { duration_ms?: number },
): {
  reply: string;
  tool_calls: AgentToolCallView[];
  model: string;
  reasoning?: string;
  duration_ms?: number;
  usage?: AgentChatUsage;
  error?: string;
} {
  const parsed = parseChatResponse(raw);
  if (parsed?.error !== undefined && parsed.error !== '') {
    return {
      reply: '',
      tool_calls: [],
      model: '',
      ...(extra?.duration_ms === undefined ? {} : { duration_ms: extra.duration_ms }),
      error: parsed.error,
    };
  }
  const toolCalls: AgentToolCallView[] = records.map((r) => ({
    id: r.tool_use_id,
    name: r.name,
    arguments: r.input,
    result: { text: r.result_text, ...(r.status === undefined ? {} : { status: r.status }) },
    is_error: r.is_error,
  }));
  const reply = parsed?.text ?? '';
  return {
    reply,
    tool_calls: toolCalls,
    model: parsed?.model ?? '',
    // 思考正文：上游不给（非推理模型 / provider 不回）时整个字段省略，
    // 前端据此整行不渲染——与 DSH 的 `hidden` 分支同一语义
    ...(parsed?.reasoning === undefined || parsed.reasoning === ''
      ? {}
      : { reasoning: parsed.reasoning }),
    ...(extra?.duration_ms === undefined ? {} : { duration_ms: extra.duration_ms }),
    ...(parsed?.usage === undefined ? {} : { usage: parsed.usage }),
  };
}

interface ParsedChat {
  text: string;
  model?: string;
  usage?: AgentChatUsage;
  error?: string;
  /** 上游 `message.reasoning_content`（思考正文）；上游不给时省略。 */
  reasoning?: string;
}

/** 从响应的 `usage` 段取用量（40 §2.1 的 OpenAI Chat 列）。 */
function parseUsage(obj: Record<string, unknown>): AgentChatUsage | undefined {
  const usage = obj['usage'];
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const u = usage as Record<string, unknown>;
  const input = numberField(u, 'prompt_tokens');
  const output = numberField(u, 'completion_tokens');
  const total = numberField(u, 'total_tokens') ?? (input ?? 0) + (output ?? 0);
  if (input === undefined && output === undefined) return undefined;
  const details = u['completion_tokens_details'];
  const reasoning =
    details !== null && typeof details === 'object' && !Array.isArray(details)
      ? numberField(details as Record<string, unknown>, 'reasoning_tokens')
      : undefined;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: total,
    ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }),
  };
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 解析上游响应：JSON 或 SSE 都认（OpenAI Chat 方言）。
 *
 * `reasoning_content` 两条路都取：非流式在 `choices[0].message`，流式在
 * `choices[].delta`（逐段拼起来）。**空白串归一成 undefined**——前端按
 * 「有才渲染」判断，一个空串会让它渲染一个空的思考行。
 */
function parseChatResponse(raw: string): ParsedChat | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return { text: '' };
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj['error'] === 'object' && obj['error'] !== null) {
        const msg = (obj['error'] as Record<string, unknown>)['message'];
        return { text: '', error: typeof msg === 'string' ? msg : '上游返回错误' };
      }
      const choices = obj['choices'];
      const usage = parseUsage(obj);
      if (!Array.isArray(choices) || choices.length === 0) {
        return { text: '', ...(usage === undefined ? {} : { usage }) };
      }
      const message = (choices[0] as Record<string, unknown>)['message'] as
        Record<string, unknown> | undefined;
      const content = message?.['content'];
      const reasoning = message?.['reasoning_content'] ?? message?.['reasoning'];
      return {
        text: typeof content === 'string' ? content : '',
        model: typeof obj['model'] === 'string' ? obj['model'] : undefined,
        ...(typeof reasoning === 'string' && reasoning !== '' ? { reasoning } : {}),
        ...(usage === undefined ? {} : { usage }),
      };
    } catch {
      return { text: '' };
    }
  }
  // SSE：把每个 chunk 的 delta.content 拼起来
  let text = '';
  let reasoning = '';
  let model: string | undefined;
  let error: string | undefined;
  let usage: AgentChatUsage | undefined;
  for (const frame of trimmed.split('\n\n')) {
    const data = sseData(frame);
    if (data === undefined) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj['error'] === 'object' && obj['error'] !== null) {
      const msg = (obj['error'] as Record<string, unknown>)['message'];
      error = typeof msg === 'string' ? msg : '上游返回错误';
      continue;
    }
    if (typeof obj['model'] === 'string' && obj['model'] !== '') model = obj['model'];
    // 流式 usage 在末 chunk（40 §2.3），取最后一次非空的
    const frameUsage = parseUsage(obj);
    if (frameUsage !== undefined) usage = frameUsage;
    for (const choice of asArray(obj['choices'])) {
      const delta = (choice as Record<string, unknown>)['delta'] as
        Record<string, unknown> | undefined;
      const content = delta?.['content'];
      if (typeof content === 'string') text += content;
      // 与 codec 的 foldChunk 对齐：思考内容也在 delta 上，同名字段
      const deltaReasoning = delta?.['reasoning_content'] ?? delta?.['reasoning'];
      if (typeof deltaReasoning === 'string') reasoning += deltaReasoning;
    }
  }
  return {
    text,
    model,
    ...(reasoning === '' ? {} : { reasoning }),
    ...(usage === undefined ? {} : { usage }),
    error,
  };
}

function sseData(frame: string): string | undefined {
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      const v = line.slice(5).trim();
      if (v !== '' && v !== '[DONE]') return v;
    }
  }
  return undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function disclosureView(s: {
  key_id: string;
  plaintext: string;
  name: string;
  masked: string;
}): AgentSecretDisclosure {
  return { key_id: s.key_id, name: s.name, masked: s.masked, plaintext: s.plaintext };
}

// ---------------------------------------------------------------------------
// 响应写出
// ---------------------------------------------------------------------------

/** 末尾追加的 `event: agent` 帧（前端 `api/chat-stream.ts` 认这个事件名）。 */
/**
 * 把一次结果写成 SSE（管理界面私有协议）。
 *
 * 帧序：`text`（按句切几段，让界面有渐进感）→ `tool`（每次调用一帧）→
 * `secret`（明文披露）→ `agent`（汇总：完整回复 + 工具调用 + 披露）→ `end`。
 *
 * 汇总帧是**权威**的那一份：前端以它为准渲染最终状态，前面的 `text` / `tool`
 * 帧只是过程可视化。这样即使某一帧丢了，界面也不会停在中间态。
 *
 * 汇总帧另带三个可选字段（96 §3.5）：`reasoning`（思考正文）、`duration_ms`
 * （回合计时）、`usage`（token 用量）。三者缺省时整个键不出现——旧前端忽略
 * 新键，新前端容忍旧服务端。
 */
export function writeAgentSse(
  res: ServerResponse,
  view: {
    reply: string;
    model: string;
    tool_calls: AgentToolCallView[];
    reasoning?: string;
    duration_ms?: number;
    usage?: AgentChatUsage;
  },
  secrets: AgentSecretDisclosure[],
  error?: string,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const piece of splitForStream(view.reply)) {
    res.write(`event: text\ndata: ${JSON.stringify({ text: piece })}\n\n`);
  }
  for (const call of view.tool_calls) {
    res.write(`event: tool\ndata: ${JSON.stringify(call)}\n\n`);
  }
  for (const secret of secrets) {
    res.write(`event: secret\ndata: ${JSON.stringify(secret)}\n\n`);
  }
  res.write(
    `event: agent\ndata: ${JSON.stringify({
      reply: view.reply,
      model: view.model,
      tool_calls: view.tool_calls,
      secrets,
      ...(view.reasoning === undefined ? {} : { reasoning: view.reasoning }),
      ...(view.duration_ms === undefined ? {} : { duration_ms: view.duration_ms }),
      ...(view.usage === undefined ? {} : { usage: view.usage }),
      ...(error === undefined ? {} : { error }),
    })}\n\n`,
  );
  res.write('event: end\ndata: {}\n\n');
  res.end();
}

/**
 * 把回复切成适合分帧的小段（按中文句读切，尽量不切断一个词）。
 *
 * 上游是非流式的，所以这里是「呈现上的分帧」而不是「生成上的分帧」——
 * 目的只是让界面在长回复下也有渐进感，不假装 token 级流式。
 */
export function splitForStream(reply: string): string[] {
  if (reply === '') return [];
  const pieces = reply.split(/(?<=[。！？；\n])/u).filter((p) => p !== '');
  if (pieces.length > 1) return pieces;
  // 没有句读：按固定长度切，避免一帧塞进几千字
  const out: string[] = [];
  for (let i = 0; i < reply.length; i += 120) out.push(reply.slice(i, i + 120));
  return out;
}

/** JSON 响应（与 admin/routes.ts 的 sendJson 同一套头：不进缓存）。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// 入参规整
// ---------------------------------------------------------------------------

function normalizeMessages(
  raw: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return undefined;
    const m = item as Record<string, unknown>;
    const role = m['role'];
    if (role !== 'user' && role !== 'assistant') return undefined;
    const content = m['content'];
    if (typeof content !== 'string') return undefined;
    out.push({ role, content });
  }
  return out.length === 0 ? undefined : out;
}

export type { AgentToolCallView, AgentToolResultView, AgentChatUsage };
