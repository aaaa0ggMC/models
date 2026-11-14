# 30 · 插件系统 API 草案

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**（TS interface 形态，实现语言待定）
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)、[20-pipeline.md](./20-pipeline.md)

## 1. 设计约束（先说清楚不做什么）

1. **插件只面对 canonical**。拿不到任何 provider 的原始 body，也拿不到 provider 的 HTTP 客户端。这是硬约束——否则插件生态会立刻退化成"N 个 provider 适配 × M 个插件"。
2. **adaptor 模式接入外部能力**。外部系统（billion-context、外部向量库、外部审核服务）不直接实现插件接口，而是由一个 adaptor 包裹：adaptor 负责把外部能力翻成 canonical 操作。
3. **插件不得持有请求级可变状态跨请求复用**，除显式声明的 `scope: "session"` 插件（按 `session_key` 隔离）。
4. **同步 + 异步双模**。插件主体是同步函数（低延迟路径），但可返回 `Promise`； Runner 对同步插件不做 await 调度以降低开销。
5. **故障隔离**：单个插件异常不拖垮请求（可配 `fatal`）。

## 2. 插件接口（TypeScript 草案）

```typescript
/** 插件声明。注册时提供，运行期不可变。 */
interface PluginManifest {
  name: string;                    // 唯一，kebab-case，如 "billion-context"
  version: string;                 // semver
  hooks: HookName[];               // 本插件关心的生命周期点
  capabilities?: PluginCapability[];
  config_schema?: JSONSchema;      // 配置项 schema，WebUI 据此自动生成配置表单
  /** 需要全量响应才能工作（如内容审核、用量改写）。
   *  声明后 Runner 仍以流式转发，但会额外维护聚合视图传给插件。 */
  needs?: "aggregate";
  /** 插件异常是否阻断请求，默认 false */
  fatal?: boolean;
  /** 单次调用超时 ms，默认 5000 */
  timeout_ms?: number;
  /** 执行顺序，小的先跑；默认 100 */
  order?: number;
}

type HookName = "onRequest" | "onResponse" | "onStreamChunk" | "onError" | "onToolCall";

interface Plugin {
  manifest: PluginManifest;
  init?(cfg: unknown, gw: GatewayServices): void | Promise<void>;
  /** 请求侧：可改写 canonical、可短路、可关闭 fast path */
  onRequest?(req: CanonicalRequest, ctx: RequestContext): PluginResult<CanonicalRequest>;
  /** 流式：逐事件处理，返回 null 表示丢弃 */
  onStreamChunk?(ev: CanonicalStreamEvent, ctx: RequestContext): CanonicalStreamEvent | CanonicalStreamEvent[] | null;
  /** 响应侧：非流式在编码前；流式在流关闭后（只能观测/副作用） */
  onResponse?(res: CanonicalResponse, ctx: RequestContext): PluginResult<CanonicalResponse>;
  /** 工具执行（网关 agentic loop 内） */
  onToolCall?(call: ToolUsePart, ctx: RequestContext): Promise<ToolResultPart> | ToolResultPart;
  /** 任意阶段抛错/返回错误时调用 */
  onError?(err: CanonicalError, ctx: RequestContext): void;
  dispose?(): void | Promise<void>;
}

type PluginResult<T> =
  | T                                   // 改写后的值
  | ShortCircuit                        // 直接给出应答，跳过后续上游调用
  | void;                               // 不改写

interface ShortCircuit {
  short_circuit: true;
  reason: string;
  response?: CanonicalResponse;         // 给出合成响应（缓存命中/mock/guard）
  error?: CanonicalError;               // 或直接报错（guard 拦截）
  http_status?: number;
}

/** 插件可用的网关服务（只读 + 受控副作用） */
interface GatewayServices {
  /** 结构化日志，自动带 request_id / plugin name */
  log: Logger;
  /** 指标埋点 */
  metrics: Metrics;
  /** 只读访问当前请求的 usage 累计（流式下为近似值） */
  currentUsage(): CanonicalUsage;
  /** 请求一个"网关侧工具"供本插件注册（供 agentic loop 调用） */
  registerTool?(tool: Tool): void;
  /** 读本插件的 KV 命名空间（按 plugin name 隔离） */
  kv: KVNamespace;
}
```

### 2.1 `RequestContext` 上插件可见的扩展方法

```typescript
interface RequestContext {
  // ...见 20-pipeline.md
  /** 关闭 fast path，之后本请求走完整结构转换 */
  disableFastPath(reason: string): void;
  /** 记录一条 warning，最终进入 UsageRecord.warnings */
  warn(code: string, detail?: string): void;
  /** 读取/写入阶段间暂存区 */
  state: Record<string, unknown>;
}
```

## 3. 生命周期与调用时序

```text
init(插件加载时一次)
  │
  ▼
┌─ onRequest ──────────── S3，可改写/短路/disableFastPath
│      │
│      ▼
│   [上游调用 / 流式转发]
│      │
│      ├─▶ onStreamChunk ─ S7，逐事件（needs:"aggregate" 时同时收到聚合视图）
│      │
│      ▼
│   [网关 agentic loop：每次工具执行] ──▶ onToolCall（仅网关循环模式，见 20-pipeline.md §5.2）
│      │
│      ▼
└─ onResponse ─────────── S9，流式下在流关闭后
       │
       ▼
   S10 UsageEmitter（旁路，插件不参与）

onError ────────────── 横切点：任意阶段出错/返回错误时都会调用（含 onRequest 抛错、
                        上游 5xx、流被空闲超时杀掉）；不占上图某一格，见下方规则

dispose(进程退出/热卸载)
```

规则：

- 同一 hook 内多插件按 `order` 升序执行；前一个插件的输出是后一个的输入。
- `onRequest` 返回 `ShortCircuit` 时，**后续插件的 `onRequest` 不再执行**，直接进 S9（`onResponse` 仍执行，让审计类插件看到）。
- `onStreamChunk` 返回数组 = 用多个事件替换一个事件（拆分）；返回 `null` = 丢弃。
- **`onToolCall` 的触发条件**：仅当请求走**网关 agentic loop**（`ag_agentic_loop: true`，或 Responses 入站 + 带 `tools` + provider 无原生工具执行）时触发，在每次工具执行前后各一次；客户端循环模式下网关看不到工具执行，**不触发**。它与 `RequestContext.state.tool_id_map` 的维护同处（见 [20-pipeline.md](./20-pipeline.md) §5.2）。
- **`onError` 与阶段失败的关系**：`onError` 不改变控制流（不能"重试"或"吞掉"错误），只做观测/告警/副作用；要阻断请求请用 `fatal: true` 的 `onRequest`。上表的"阶段职责表"逐阶段标了 `onError`。
- 插件不得在 `onStreamChunk` 里阻塞等待（如调外部 LLM）超过 `timeout_ms`，否则降级为透传原事件 + warning。**长耗时压缩类工作必须在 `onRequest` 完成。**

## 4. 内置插件：billion-context adaptor 设计草案

> billion-context 的实际形态、API、license 已确认（读源码/LICENSE/npm/GitHub API），结论见 [docs/sources.md](../sources.md) §billion-context。**以下为 adaptor 草案，具体字段待按其真实 API 校准。**

### 4.1 为什么需要 adaptor 而不是直接依赖

billion-context 面向的是"客户端库"场景：输入一个消息数组、输出一个压缩后的消息数组。它不了解 canonical，也不了解网关的多轮工具循环。adaptor 的职责：

1. **canonical ⇄ 它的输入输出**的翻译；
2. **策略决策**：什么时候触发压缩（上下文占用率阈值 / 轮次阈值 / token 预算）；
3. **保护不可压缩内容**：system prompt、最近 N 轮、工具定义、`cache_control` 断点不能被压缩破坏；
4. **记账**：压缩本身可能消耗 token（若它内部调 LLM 做摘要），必须计入 `UsageRecord.compaction`，不能算进用户请求的 input_tokens（否则计费口径污染）。

### 4.2 adaptor 结构

```typescript
/** 外部压缩能力的抽象接口——不依赖 billion-context 的具体签名 */
interface CompactionDriver {
  /** 返回压缩后的消息列表；实现方自行决定摘要/检索/丢弃策略 */
  compact(input: CompactionInput): Promise<CompactionOutput>;
}

interface CompactionInput {
  messages: CanonicalMessage[];        // 全量历史
  /** 不可压缩的前缀（system / tools / 最近 N 轮 / cache 断点）由 adaptor 预先剥离并原样拼回 */
  frozen_prefix: CanonicalMessage[];
  frozen_suffix: CanonicalMessage[];
  token_budget: number;                // 目标窗口（来自 model 元数据）
  current_tokens: number;
  session_key: string;                 // 长会话标识
}

interface CompactionOutput {
  messages: CanonicalMessage[];        // 压缩后历史
  removed_tokens: number;
  kept_tokens: number;
  /** 压缩过程自身的消耗（若驱动内部调 LLM） */
  cost?: { input_tokens: number; output_tokens: number; model?: string };
  /** 被压掉内容的存放位置（用于"反压缩"追溯） */
  archive_ref?: string;
}

class BillionContextAdaptor implements Plugin {
  manifest = {
    name: "billion-context",
    hooks: ["onRequest"],
    config_schema: {/* 见下 */},
    order: 10,                          // 尽早跑，后续插件看到的是压缩后历史
  };

  async onRequest(req, ctx) {
    const cfg = this.cfg;                                  // 已按 config_schema 校验
    if (!cfg.enabled) return req;

    const budget = ctx.route.model_meta.max_context_tokens;
    const used = estimateTokens(req);                      // 网关侧估算器
    const trigger = used / budget;

    if (trigger < cfg.threshold_ratio) return req;          // 默认 0.7
    if (req.messages.length < cfg.min_turns) return req;    // 默认 8，短会话不压

    // 1. 冻结不可压缩区
    const { frozen_prefix, body, frozen_suffix } = split(req.messages, cfg);
    // 2. 调驱动
    const out = await this.driver.compact({
      messages: body, frozen_prefix, frozen_suffix,
      token_budget: Math.floor(budget * cfg.target_ratio),
      current_tokens: used, session_key: cfg.session_key(ctx),
    });
    // 3. 记账（不计入用户 input_tokens）
    ctx.state.compaction = { removed: out.removed_tokens, kept: out.kept_tokens, cost: out.cost, archive_ref: out.archive_ref };
    if (out.cost) ctx.warn("compaction_cost", `${out.cost.input_tokens}+${out.cost.output_tokens}`);
    // 4. 改写 canonical
    return { ...req, messages: [...frozen_prefix, ...out.messages, ...frozen_suffix] };
  }
}
```

### 4.3 配置项（`config_schema` 摘要）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `true` | 总开关 |
| `threshold_ratio` | number | `0.7` | 占用率超过该值触发压缩 |
| `target_ratio` | number | `0.4` | 压缩后目标占用率 |
| `min_turns` | int | `8` | 少于该轮次不压缩 |
| `freeze_recent_turns` | int | `4` | 最近 N 轮不压缩 |
| `freeze_system` | bool | `true` | system / 首条消息不压缩 |
| `preserve_cache_control` | bool | `true` | 带 `cache_control` 的块不压缩、不断点 |
| `preserve_tool_defs` | bool | `true` | `tools` 定义不参与压缩 |
| `max_output_tokens` | int | `4096` | 压缩摘要长度上限 |
| `session_key` | string(模板) | `"{{auth.user}}:{{model_alias}}"` | 长会话分组键 |
| `driver` | enum | `"billion-context"` | 压缩驱动；预留 `"none"` / 自研驱动位 |

### 4.4 风险与对策（Phase 0 要逐条验证）

| 风险 | 对策 |
|---|---|
| billion-context 可能自带 LLM 调用，延迟不可控 | 只在 `onRequest` 同步等待；超时走 `timeout_ms`，超时则放弃压缩并 warning |
| 压缩破坏 `cache_control` 断点 → 缓存命中率崩塌 | `preserve_cache_control: true` + 压缩后重排断点位置 |
| 压缩破坏工具调用配对（`tool_use` 没有对应 `tool_result`） | 压缩前做"工具调用配对完整性"校验，不完整的轮次整轮冻结 |
| **压缩破坏不透明的思考块（Anthropic `thinking.signature` / `redacted_thinking`、Gemini `thoughtSignature`、OpenAI Responses `reasoning.encrypted_content`）→ 上游 400** | **硬规则：这些 part 一律冻结，压缩插件不得触碰。** 三家都要求"原样回传"，改一个字节即 400（Gemini 3/4 甚至要求每个 step 的第一个 `functionCall` Part 必须带 `thoughtSignature`，缺失即 400 且 `finishReason` 为 `MISSING_THOUGHT_SIGNATURE`）。这是压缩插件最容易踩的坑 |
| 压缩后内容与用户原始表述不符，引发投诉 | `archive_ref` 留存原文，trace 可反查；`warnings` 明示 |
| 其 license 不允许服务端商用 | Phase 0 先确认 license；不允许则 adaptor 保留、驱动替换为自研或禁用（adaptor 与驱动解耦正是为此） |
| 计费口径污染 | 压缩成本单独记 `UsageRecord.compaction_cost`，不进 `input_tokens` |

### 4.4b 与上游自带上下文管理的职责边界

Anthropic 提供 `context_management`（beta：`clear_tool_uses_20250919` / `clear_thinking_20251015` / `compact_20260112`）与 `compaction`（`{type:"summarize"}`）；OpenAI Responses 提供 `context_management[{type:"compaction",compact_threshold}]`；Gemini 4 起显式缓存受限。

**决策：网关默认把上下文管理收敛到自己的压缩插件，不透传上游的 compaction 参数。**

理由：① 上游 compaction 是 provider 特定的，透传会让"同一会话在不同 provider 上行为不一致"；② 上游 compaction 的结果不可见于 canonical，插件与计费都看不到发生了什么；③ 双压缩（上游压一次、网关压一次）会级联损失。

例外：客户端显式传 `native.<vendor>.context_management` 时透传，并在 `warnings` 声明"本次由上游执行 compaction，网关压缩插件已跳过"。

## 5. 插件配置的运行时形态

配置来源优先级：请求级覆盖（`x-ag-plugin-config` header，仅白名单插件可用）> 虚拟 key 级 > 全局默认。

```typescript
interface PluginConfigResolution {
  plugin: string;
  config: unknown;              // 已按 config_schema 校验
  source: "global" | "key" | "request";
}
```

WebUI 的"插件配置"页面直接消费 `manifest.config_schema` 渲染表单，不写死任何插件字段（见 [00-overview.md](./00-overview.md) §UI）。

## 6. 待验证清单

1. billion-context 是否可作为服务端库被 import（而非必须 CLI/独立进程）；若只能独立进程，adaptor 需改为 HTTP sidecar，接口改为 `POST /compact`。
2. 其 token 估算口径是否与各 provider 的 tokenizer 一致（不一致时压缩阈值会误判）。
3. `onStreamChunk` 的 `needs:"aggregate"` 在 SSE 重组场景下的额外内存开销是否可接受（默认只对声明了的插件开启）。
4. 插件热重载是否会破坏进行中的请求（需要插件对象按请求快照，而不是共享可变实例）。
