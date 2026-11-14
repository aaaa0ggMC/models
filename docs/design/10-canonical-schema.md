# 10 · Canonical 中间格式（AG-IR）Schema v1

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 定位：AgentGateway 的唯一中间表示（Intermediate Representation, IR）。所有 adaptor、插件、计费、trace 只面对本文定义的类型。
> 上游依赖：[00-overview.md](./00-overview.md)（术语表与定位）
> 下游被引用于：[20-pipeline.md](./20-pipeline.md)、[25-streaming.md](./25-streaming.md)、[30-plugin-api.md](./30-plugin-api.md)、[40-provider-adaptors.md](./40-provider-adaptors.md)、[50-builtin-search.md](./50-builtin-search.md)、[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)、[15-modalities.md](./15-modalities.md)

---

## 0. 阅读指引

- §1 是**设计决策**（含被否掉的方案），reviewer 若要攻击请从这里开始。
- §2 是**共享信封**，所有模态共用。
- §3 是**判别式与模态注册表**，说明新模态怎么加。
- §4 是**chat 模态 payload**（最丰富）。
- §5 是**媒体引用模型**，跨模态共用。
- §6 是**多单位 usage**。
- §7 是**raw passthrough 保真机制**（无损的关键）。
- §8 是**JSON Schema 索引**。
- §9 是**四种 chat 格式的字段级映射表**。
- §10 是 **Open Questions**。

标注约定：`[v1]` = v1 必做；`[v1.5]` = v1 后第一个增量；`[later]` = 明确后续；`[待验证]` = 需实测确认。

---

## 1. 设计决策

### 决策 D1：canonical 不是 chat-only，而是「共享信封 + 按模态分 payload」

**决策**：顶层是 `CanonicalEnvelope`，用 `kind` 判别模态（`chat` / `tts` / `asr` / `image` / `embedding` / `rerank` / `moderation` / `video`）。chat payload 最丰富，但图片/音频**不塞进 messages**。

**理由**：
1. TTS/ASR/Image 的输入输出结构与 chat 完全正交（TTS 输入是纯文本 + 声音规格，输出是音频；ASR 输入是音频，输出是带时间戳的分段）。硬塞进 messages 会让 canonical 出现"假消息"（把一段音频包成 `role:user` 的 message 再解包），每加一种模态就往 messages 里加一种特判。
2. 共享信封（request_id / model / usage / error / streaming / raw）是跨模态**真正**共用的部分，抽出来才不会被反复重写。
3. `kind` 判别 + 注册表使新增模态**不改信封、不改现有 codec**。

**考虑过的替代方案**：
- *A. 以 OpenAI Chat Completions 为枢轴，其余模态都映射成 message*（llmshim 的做法，见 [docs/sources.md](../sources.md)）。否掉理由：TTS 没有"消息"，Image 没有"对话"，映射过去必然发明不存在的字段；且枢轴格式的更新会强制 canonical 跟着改。
- *B. 每种模态一套完全独立的顶层 schema*。否掉理由：信封字段（auth/usage/error/streaming/raw）会复制 8 份，且跨模态统计与计费无法统一。
- *C. 以 Responses API 为超集*。否掉理由：Responses 有 `input` items 但**没有** TTS/ASR/Image 的一等公民位置，且它是单一厂商格式，更新不受我们控制。

**代价**：`kind` 分发到处可见；类型上需要判别式联合而不是单一 interface。接受。

### 决策 D2：canonical 是「超集 + 显式能力声明」，不是「万能容器」

**决策**：canonical 字段是所有主流格式**表达能力的并集**，并显式区分：
- `core`：canonical 自己定义、跨格式语义稳定的字段；
- `native`：只在特定 provider 有意义的字段，用命名空间隔离（如 `native.openai.*` / `native.anthropic.*` / `native.gemini.*`）；
- `raw`：完全未建模的字段，见 §7。

**理由**：如果把厂商专有字段（Anthropic `container`、Gemini `safetySettings`、OpenAI `service_tier`）全平铺到顶层，canonical 会迅速膨胀且语义互相冲突（三家都有叫 `metadata` 但含义不同的字段）。隔离后，"这个字段是不是通用语义"在类型上一眼可判。

**代价**：跨 provider 的功能对等性检查要遍历 `native.*`，工具链要提供 helper。接受。

### 决策 D3：raw passthrough 是硬约束，且分两级

**决策**：每个 canonical 节点都可带 `_raw`（**节点级**）；请求/响应根可带 `unmapped`（**顶层级**）。二者共同保证可逆。

**理由**：这是与现有开源实现（llm-bridge 的 `_original`）的关键差异——后者只在「来源 provider == 目标 provider 且消息未被改动」时整体回填原始 body，跨 provider 时只是启发式打分，且**不回读顶层未知字段**（详见 [docs/sources.md](../sources.md) §llm-bridge）。我们把「顶层未知字段」显式建模，堵住这个漏洞。

**代价**：序列化体积增加；需要 round-trip 测试夹具保证不回写错。接受（这是本项目的核心差异化，见 [00-overview.md](./00-overview.md)）。

### 决策 D4：usage 是多单位结构，不是单一 token 数

**决策**：`CanonicalUsage` 同时承载 `tokens` / `characters` / `audio_seconds` / `audio_bytes` / `images` / `requests` 六类计量，外加 provider 原始 usage。

**理由**：TTS 按字符计费、ASR 按音频时长、Image 按张或 token、chat 按 token。用单一 `total_tokens` 会强迫所有模态都折算成 token，折算系数全凭猜。多单位结构让每个模态报自己天然的单位，计费层再做单价匹配。

**代价**：计费与统计代码要处理"多个单位各自累加"；UI 要按模态分组。接受。

### 决策 D5：canonical 不建模"计费"，只建模"计量"

**决策**：canonical 里有 `usage`（计量）与 `cost_hint`（可选的上游自报费用），**没有**网关算出的金额。

**理由**：金额依赖单价表版本，单价表会变；把金额写进中间表示会让历史记录随改价而漂移。金额在查询时按"事件时间对应的单价版本"计算（见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4.1）。

**代价**：每次查询都要 join 单价表。接受。

### 决策 D6：schema 版本化 + 注册表，而不是"尽量兼容旧版"

**决策**：`envelope.ir_version` 必填，形如 `"ag-ir/1"`。新增模态走注册表（§3），不新增顶层字段。

**理由**：canonical 是内部表示，不需要永久向后兼容；显式版本号让插件能声明"我只懂 ag-ir/1"，路由层据此拒绝不兼容的插件，而不是静默出错。

---

## 2. 共享信封（Shared Envelope）

所有模态的请求与响应共用此外壳。**v1 只做请求信封与响应信封两类。**

```typescript
// ============ 请求信封 ============
interface CanonicalRequestEnvelope {
  /** IR 版本，v1 = "ag-ir/1" */
  ir_version: "ag-ir/1";

  /** 模态判别，决定 payload 结构 */
  kind: ModalityKind;

  /** 客户端请求的模型名（可能是网关别名） */
  model: string;
  /** 解析后的 provider 侧真实 model id；S2 路由后填充 */
  resolved_model?: string;

  /** 请求级通用参数（chat 用；其他模态多数不用，但保留统一位置） */
  stream?: StreamOptions;

  /** 模态特定 payload，见 §4 与 15-modalities.md */
  payload: ModalityPayload;

  /** 客户端原始格式（用于 fast path 与回写） */
  source_format: FormatId;

  /** 节点级 / 顶层级 raw 保留，见 §7 */
  raw: RawEnvelope;

  /** 网关扩展字段（不影响上游，仅在网关内流转） */
  gateway?: {
    agentic_loop?: boolean;        // 是否启用网关工具循环
    max_turns?: number;            // 默认 10
    builtin_tools?: string[];      // 网关代执行的工具白名单
    debug?: boolean;               // 响应里带 ag_* 调试字段
    [k: string]: unknown;
  };
}

// ============ 响应信封 ============
interface CanonicalResponseEnvelope {
  ir_version: "ag-ir/1";
  kind: ModalityKind;
  request_id: string;

  /** 归一化 usage（多单位，见 §6） */
  usage: CanonicalUsage;

  /** 归一化完成原因 */
  finish_reason: NormalizedFinishReason | "final";

  /** 模态特定 payload */
  payload: ModalityResponsePayload;

  /** 该响应是否被降级（能力不支持时的桥接结果） */
  degraded?: ConversionDiagnostic[];

  warnings: string[];
  raw: RawEnvelope;
}

/**
 * 转换诊断。把"丢了什么"变成一等公民。
 * 借鉴 NewAPI relaykit 的 ConversionDiagnostic + 损耗策略三档
 * （见 docs/sources.md §NewAPI），以及 agentgateway 的 SharedV4Warning 四分类。
 */
interface ConversionDiagnostic {
  /** 诊断码，稳定标识 */
  code: string;
  /** 出错字段路径（canonical 侧），如 "params.temperature" */
  field_path?: string;
  /** 源格式与目标格式 */
  from: FormatId;
  to: FormatId;
  /** 严重度：info = 已处理；warning = 有损但可继续；error = 该特性未生效 */
  level: "info" | "warning" | "error";
  /** 人类可读说明 */
  message: string;
}

/** 统一流式帧信封，见 25-streaming.md §2 */
interface CanonicalStreamFrame<E extends StreamEventType = StreamEventType> {
  event: E;
  seq: number;
  request_id: string;
  kind: ModalityKind;
  data: FrameData;
  ts: number;
}
```

### 2.1 `FormatId`

```typescript
type FormatId =
  | "openai.chat"           // POST /v1/chat/completions
  | "openai.responses"      // POST /v1/responses
  | "anthropic.messages"    // POST /v1/messages
  | "gemini.generateContent"; // POST /v1beta/models/{m}:generateContent
  // 多模态端点（15-modalities.md §端点形态）
  | "openai.audio.speech" | "openai.audio.transcription"
  | "openai.images.generations" | "openai.images.edits"
  | "elevenlabs.tts" | "azure.tts" | "google.tts" | "minimax.tts"
  | "deepgram.listen" | "assemblyai.transcript"
  | "bflux.image" | "stability.image";
```

---

## 3. 模态判别与注册表

### 3.1 判别式

```typescript
type ModalityKind =
  | "chat"        // [v1] 最丰富
  | "embedding"   // [v1]
  | "tts"         // [v1.5]
  | "asr"         // [v1.5]
  | "image"       // [v1.5]
  | "rerank"      // [later]
  | "moderation"  // [later]
  | "video";      // [later] 仅 schema 占位，不实现

type ModalityPayload =
  | ChatPayload              // kind === "chat"
  | EmbeddingPayload
  | TtsPayload
  | AsrPayload
  | ImagePayload
  | RerankPayload
  | ModerationPayload
  | VideoPayload;            // { } 空占位 + raw

type ModalityResponsePayload =
  | ChatResponsePayload | EmbeddingResponsePayload | TtsResponsePayload
  | AsrResponsePayload | ImageResponsePayload | RerankResponsePayload
  | ModerationResponsePayload | VideoResponsePayload;
```

### 3.2 新增模态的步骤（可执行）

1. 在 `ModalityKind` 加一个字符串字面量；
2. 在 `ModalityPayload` / `ModalityResponsePayload` 联合里加对应类型；
3. 在 `StreamFrame` 的 `DeltaData` 联合里加一个分支（若该模态要流式）；
4. 在**能力矩阵**（[40-provider-adaptors.md](./40-provider-adaptors.md) §5）登记每个 (provider, modality) 组合；
5. 写该模态的 mapper（请求 + 响应 + 流式）；
6. 在 `usage` 单位表里声明它用哪些单位；
7. **不改** `CanonicalRequestEnvelope` 的任何现有字段。

第 7 条是硬约束：新增模态必须是增量，否则老插件的类型会炸。

### 3.3 未知模态的处理

客户端请求一个网关不认识的模态 → `unsupported_modality` 错误（400），**不**尝试塞进 chat。静默降级比报错更糟。

---

## 4. chat 模态 payload（v1 最丰富）

### 4.1 消息与 parts

```typescript
interface ChatPayload {
  /** 系统提示提升为一级字段（Anthropic / Responses 风格）。
   *  Gemini 的 systemInstruction 也映射到这里。 */
  system?: SystemBlock[];
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  tool_choice?: ToolChoice;
  /** chat 专属参数 */
  params?: ChatParams;
}

interface SystemBlock {
  text: string;
  cache_control?: CacheControl;
  _raw?: unknown;
}

interface CanonicalMessage {
  /** 权威角色。Gemini 的 user/model 映射到 user/assistant；
   *  OpenAI 的 developer/tool role 在 [v1] 折叠进 system/user，raw 保留原值 */
  role: "user" | "assistant" | "system" | "tool";
  /** 内容块序列。chat 的全部内容都在 parts 里，不再有 "content: string | array" 的二义 */
  parts: Part[];
  /** 该消息的稳定 id（用于 trace、delta 链、tool id 映射） */
  id?: string;
  _raw?: unknown;
}

type Part =
  | TextPart | ImagePart | AudioPart | DocumentPart | VideoPart
  | ToolUsePart | ToolResultPart
  | ThinkingPart | RedactedThinkingPart
  | SearchResultPart | RefusalPart
  | UnknownPart;   // 前向兼容：provider 新增 block 类型时不报错
```

### 4.2 Part 定义

```typescript
interface PartBase { _raw?: unknown }

interface TextPart extends PartBase {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

interface ImagePart extends PartBase {
  type: "image";
  /** 三态引用，见 §5 */
  source: MediaRef;
  /** 该图片在消息里的用途（input / mask / reference） */
  role?: "input" | "mask" | "reference";
}

interface AudioPart extends PartBase {
  type: "audio";
  source: MediaRef;
  /** 采样率/位深等，用于 ASR 与音频输入 */
  format?: AudioFormat;
}

interface DocumentPart extends PartBase {
  type: "document";
  source: MediaRef;
  /** 文档类型提示（pdf / txt / md / html …） */
  media_type?: string;
  title?: string;
}

interface VideoPart extends PartBase { type: "video"; source: MediaRef; }

/** 模型发起的工具调用。id 是 canonical 权威 id。 */
interface ToolUsePart extends PartBase {
  type: "tool_use";
  id: string;
  name: string;
  /** 已解析的参数对象（不是 JSON 字符串） */
  input: Record<string, unknown>;
  /** 上游原始参数串（解析失败时保留，见 §7.3） */
  raw_arguments?: string;
}

/** 工具执行结果。 */
interface ToolResultPart extends PartBase {
  type: "tool_result";
  /** 对应 ToolUsePart.id */
  tool_use_id: string;
  /** 内容可以是结构化 parts（多模态结果）或纯文本 */
  content: Part[] | string;
  is_error?: boolean;
  /** 内置搜索的结果块 */
  search_results?: SearchResultPart[];
}

/** 扩展思考。signature 是多轮回传所必需的（Anthropic 语义）。 */
interface ThinkingPart extends PartBase {
  type: "thinking";
  thinking: string;
  signature?: string;
  /** Gemini thought parts / Responses reasoning summary 的标记 */
  summary?: boolean;
}

interface RedactedThinkingPart extends PartBase {
  type: "redacted_thinking";
  data: string;   // 上游加密块，网关不解释
}

interface SearchResultPart extends PartBase {
  type: "search_result";
  source: string;
  title: string;
  url: string;
  snippet: string;
  content?: string;
  published_at?: string;
  citation_index?: number;
  score?: number;
}

interface RefusalPart extends PartBase {
  type: "refusal";
  reason: string;
}

/** 前向兼容兜底 */
interface UnknownPart extends PartBase {
  type: "unknown";
  /** 上游原始 block 类型名，便于诊断 */
  raw_type?: string;
  raw: unknown;
}
```

**设计说明（D7）**：`ToolUsePart.input` 是**对象**而不是 JSON 字符串。OpenAI Chat 的 `function.arguments` 是字符串，Anthropic 的 `input` 是对象，Gemini 的 `args` 是对象。统一成对象，字符串形态存进 `raw_arguments`（含解析失败时的原串），避免"畸形 tool 参数跨格式被静默销毁"这类已知缺陷。

**设计说明（D7b，反模式警告）**：**`ToolUsePart.id` 必须是干净的 id，不得把元数据编码进 id 字符串**。LiteLLM 曾把 Gemini 的 `thoughtSignature` 编码进 tool_call id（`call_xxx__thought__xxx`），导致多轮 function calling 报 "number of function response parts != function call parts"（[issue #17949](https://github.com/BerriAI/litellm/issues/17949)）。元数据走独立字段：`ThinkingPart.signature` / `native.<vendor>.*` / `_raw`。同理，**id 缺失时入口统一生成**（`call_<ulid>`），不得留给流式重组阶段——缺 id 的 tool_call 在流式重组时会被静默丢弃（LiteLLM [issue #11262](https://github.com/BerriAI/litellm/issues/11262)）。

**设计说明（D7c）**：`tool_use` block 在 Anthropic 里必须**移到段尾**（AI SDK 的 `moveToolUseBlocksToEnd()` 专门处理这个硬约束，见 [convert-to-anthropic-prompt.ts](https://github.com/vercel/ai/blob/main/packages/anthropic/src/convert-to-anthropic-prompt.ts)）。

### 4.3 工具定义与 tool_choice

```typescript
type CanonicalTool = FunctionTool | BuiltinTool;

interface FunctionTool {
  type: "function";
  name: string;
  description?: string;
  /** JSON Schema。归一化规则见 40-provider-adaptors.md §4 */
  parameters: JSONSchema;
  /** 严格模式（OpenAI strict / Anthropic 无对应） */
  strict?: boolean;
  cache_control?: CacheControl;
  _raw?: unknown;
}

/** 内置工具：由上游或网关执行，见 50-builtin-search.md */
interface BuiltinTool {
  type: "builtin";
  /** canonical 统一名，跨格式映射的键 */
  name: "web_search" | "url_context" | "code_interpreter" | "file_search";
  config: Record<string, unknown>;
  executor?: "provider" | "gateway";
  _raw?: unknown;
}

type ToolChoice =
  | "auto" | "required" | "none"
  | { type: "tool"; name: string }              // 强制某个工具
  | { type: "builtin"; name: string };          // 强制某个内置工具
```

**映射注意**：`tool_choice: "required"` 在 OpenAI 语义是"必须调工具但不限定哪个"，Anthropic 对应 `any`，Gemini 对应 `functionCallingConfig.mode: "ANY"`（但 `ANY` 不接受空 `allowedFunctionNames`，必须列名，**待验证**）。OpenAI 的 `parallel_tool_calls: false` 在 Anthropic/Gemini **无对应**，只能靠 prompt 约束或事后拆轮。

### 4.4 参数、思考、输出格式、缓存

```typescript
interface ChatParams {
  max_output_tokens?: number;    // 统一名；OpenAI 旧名 max_tokens、Gemini maxOutputTokens
  temperature?: number;
  top_p?: number;
  top_k?: number;                // Gemini / 部分 OpenAI 兼容
  stop?: string[];               // OpenAI stop、Anthropic stop_sequences、Gemini stopSequences
  seed?: number;
  frequency_penalty?: number;    // 仅 OpenAI 系
  presence_penalty?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;                    // 候选数；Anthropic 不支持（恒 1）
  user?: string;                 // 终端用户标识（脱敏后可入库）
  metadata?: Record<string, string>;  // OpenAI metadata；Anthropic metadata 同名但限 16 kv
  service_tier?: "auto" | "default" | "flex" | "priority";
  safety?: SafetySetting[];      // Gemini safetySettings
}

/** 思考 / 推理配置。三种 provider 词汇不同，canonical 统一。 */
interface ThinkingConfig {
  enabled: boolean;
  /** 连续 token 预算（Anthropic budget_tokens、Gemini thinkingBudget） */
  budget_tokens?: number;
  /** 离散档位（OpenAI reasoning_effort）。与 budget_tokens 二选一或都留 */
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** 是否回传思考摘要（Responses summary / Gemini includeThoughts） */
  include_summary?: boolean;
  /** 保留历史思考块（多轮必需） */
  preserve_history?: boolean;
}

/** 结构化输出。 */
interface ResponseFormat {
  type: "text" | "json_object" | "json_schema";
  json_schema?: {
    name: string;
    description?: string;
    schema: JSONSchema;
    strict?: boolean;
  };
}

interface CacheControl {
  /** 缓存类型。Anthropic 的 ephemeral 5m/1h；OpenAI prompt caching 自动；Gemini cachedContent 显式 */
  type: "ephemeral";
  ttl?: "5m" | "1h";
  /** Gemini cachedContent 的资源名 */
  cache_name?: string;
}

interface SafetySetting {
  category: string;
  threshold: string;
}
```

**映射注意（reasoning）**：`effort`（离散）与 `budget_tokens`（连续）之间是**本质有损**映射。v1 采用显式阈值表方案（可配置），并在 `warnings` 里声明这次转换用了哪一档。表格式见 [40-provider-adaptors.md](./40-provider-adaptors.md) §3。

### 4.5 流式选项

```typescript
interface StreamOptions {
  enabled: boolean;
  /** 客户端要的形态 */
  mode: "sse" | "chunked-binary" | "ws-duplex" | "none";
  /** 是否要求上游在流里带 usage */
  include_usage?: boolean;
  /** 客户端是否会用 OpenAI 原生事件名（否则用 ag.frame） */
  native_event_names?: boolean;
  /** 上游能力不匹配时的策略 */
  on_mismatch: "reject" | "bridge" | "buffer";
}
```

`on_mismatch` 的默认值按模态不同：chat 默认 `bridge`（SSE 互转是成熟路径），`ws-duplex` 需求默认 `reject`（见 [25-streaming.md](./25-streaming.md) §1）。

---

## 5. 统一媒体引用模型（跨模态共用）

```typescript
/** 三态媒体引用。v1 三种全支持。 */
type MediaRef =
  | InlineMedia
  | UriMedia
  | AssetMedia;

interface MediaBase {
  mime: string;
  byte_length?: number;
  /** 音频：时长（秒）；视频：时长（秒） */
  duration_seconds?: number;
  /** 图片/视频：像素尺寸 */
  width?: number;
  height?: number;
  /** 音频：采样率 / 位深 / 声道 */
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
  /** 内容寻址 hash，用于去重（§5.2） */
  sha256?: string;
}

interface InlineMedia extends MediaBase {
  kind: "inline";
  /** base64，不含 data: 前缀 */
  data: string;
}

interface UriMedia extends MediaBase {
  kind: "uri";
  /** 公网 URL，或网关内部的 asset:// URL */
  uri: string;
  /** 是否需要网关代取（内网/需鉴权时） */
  fetch_by_gateway?: boolean;
  /** 代取时用的凭据引用（绝不存明文） */
  credential_ref?: string;
}

interface AssetMedia extends MediaBase {
  kind: "asset";
  /** 网关媒体库 id */
  asset_id: string;
}
```

### 5.1 二进制落地（opt-in）

- 媒体二进制**默认不落盘**。落盘受 `persistence.media` 开关控制（默认 `off`，见 [65-storage-and-retention.md](./65-storage-and-retention.md)）。
- 落盘时走与消息内容同一套加密管道（先压缩后加密、AAD 绑定）。
- `AssetMedia.asset_id` 是内容寻址的，同一个 `sha256` 只有一个物理副本。

### 5.2 内容寻址去重

`sha256` 在 S1 解码时对 inline 媒体计算（对大 base64 有成本，默认只对 ≤ 8MB 的媒体算，超出则留空并 warning）。去重键 = `sha256`，与消息前缀压缩（[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §7）同源——都是"共享前缀/共享内容的增量存储"思路，只是粒度不同（delta 链按消息，媒体按二进制对象）。

---

## 6. 多单位 Usage

```typescript
interface CanonicalUsage {
  /** 各计量单位，未用到的单位省略（不是 0） */
  units: UsageUnits;

  /** 计费用金额提示（上游自报，如 OpenRouter usage.cost）。
   *  网关自己不算钱，见 D5。 */
  cost_hint?: { amount: number; currency: string; source: string };

  /** provider 原始 usage，逐字段保留，用于对账 */
  raw?: Record<string, unknown>;

  /** 本次 usage 的来源 */
  source: "provider" | "provider_floor" | "estimated";
  /** 估算精度（source === "estimated" 时） */
  precision?: "exact" | "approx" | "low";
}

interface UsageUnits {
  /** ---- 按 token 计的模态（chat / embedding / rerank / image(gpt-image-1)） ---- */
  tokens?: TokenUsage;
  /** ---- TTS：按字符 ---- */
  characters?: { input: number; billed: number };
  /** ---- ASR / TTS：按音频时长 ---- */
  audio_seconds?: { input: number; billed: number };
  /** ---- ASR：按音频字节 ---- */
  audio_bytes?: number;
  /** ---- Image：按张 ---- */
  images?: { generated: number; edited: number };
  /** ---- 通用：请求次数（按次计费的内置工具） ---- */
  requests?: number;
  /** ---- 压缩成本（不计入用户请求，见 30-plugin-api.md §4.4） ---- */
  compaction_tokens?: TokenUsage;
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  /** 其他细分，透传保留 */
  details?: Record<string, number>;
}
```

### 6.1 规则

1. `source: "provider"` = 上游给了 usage；`"provider_floor"` = 上游只给了部分账单（下界）；`"estimated"` = 网关自估算。
2. **"未知"绝不用 0 表示**。上游没给 usage 时 `units` 里对应的键**省略**，并置 `warnings += "usage_missing"`。用 0 表示未知会让看板静默少报。
3. 缺 cache 单价时，计费层取该模型的最高已发布单价（高估不低估），避免 spend cap 静默失效。
4. `total_tokens` 若上游已给且与 `input+output` 不一致，以上游为准并把差异记 `warnings`。

完整归一规则见 [40-provider-adaptors.md](./40-provider-adaptors.md) §2。

---

## 7. Raw Passthrough（保真机制）

### 7.1 两级结构

```typescript
interface RawEnvelope {
  /** 顶层级：请求/响应根上未建模的字段 */
  unmapped?: Record<string, unknown>;
  /** 节点级：每个 canonical 节点可带 _raw（原文对象或原始 block） */
  nodes?: Record<string, unknown>;
  /** 来源 provider（回写时判断能否整体还原） */
  source_provider?: string;
}
```

### 7.2 回写规则（`reconstruct`）

编码回目标格式时，按优先级：

1. **整体还原**：`_raw.source_provider === 目标格式` 且该子树未被改动 → 返回原始对象（引用相等，零成本）；
2. **逐节点还原**：目标字段在 canonical 里没有对应值，但该节点有 `_raw` → 用 `_raw` 的值；
3. **顶层 unmapped 回写**：`raw.unmapped` 里来自 `source_provider` 的键，在目标格式同名时原样写回；
4. **结构化转换**：以上都不命中 → 按 §9 映射表转换。

"未被改动"的判定：节点带 `_modified: true` 标记（插件改写时由 Runner 打上），或该节点 id 出现在 `ctx.state.rewritten_paths` 里。

### 7.3 畸形 tool 参数的保护

`ToolUsePart.input` 解析失败时：
- `input` 置 `{}`；
- `raw_arguments` 存原始字符串；
- 回写时若目标格式要字符串，**优先用 `raw_arguments`**，不要 `JSON.stringify(input)`。

这一条直接针对已开源实现里的真实缺陷（llm-bridge 存了 `raw_arguments` 但回写从不读它，导致畸形参数被静默替换成 `{}`）。

### 7.4 保真度自检

导出 `reconstructionQuality(canonical, targetFormat): number`（0–100）：
- 100 = 可整体还原；
- 80–99 = 按 `_raw` 覆盖率加权（消息数、part 数、tool 数、顶层键数各占一份）；
- < 80 = 有未建模且未保留的部分。

低于阈值时在响应 `degraded` 字段声明，**不静默**。这个指标同时是 fast path 关闭率的观测依据。

---

## 8. JSON Schema

JSON Schema 与本文 TS 类型**一对一**，由代码生成（不让手写两份导致漂移）。文件布局：

```
schema/ag-ir-1/
  envelope.schema.json      # 共享信封
  chat.schema.json          # ChatPayload / ChatResponsePayload
  media.schema.json         # MediaRef 及子类型
  usage.schema.json         # CanonicalUsage
  parts.schema.json         # Part 联合
  tools.schema.json         # CanonicalTool / ToolChoice
  tts.schema.json           # [v1.5]
  asr.schema.json           # [v1.5]
  image.schema.json         # [v1.5]
  embedding.schema.json     # [v1]
```

约束：
- `additionalProperties: false` 在**所有** schema 上开启——这是为了逼着未建模字段显式进 `raw.unmapped`，而不是悄悄躺平。前向兼容靠 `UnknownPart` 与 `raw`，不靠放宽校验。
- 每个 schema 的 `$id` 带版本：`https://agentgateway.local/schema/ag-ir-1/chat.schema.json`。
- round-trip 测试夹具（4 格式 × 每模态）按 schema 校验，进 CI。

---

## 9. 四种 chat 格式字段级映射表

> 完整、含多模态的 mapper 字段表见 [40-provider-adaptors.md](./40-provider-adaptors.md)。本节是 chat 的骨架表。

### 9.1 请求映射（canonical → 目标格式）

| canonical | OpenAI Chat | OpenAI Responses | Anthropic | Gemini |
|---|---|---|---|---|
| `payload.system[]` | `messages[{role:"system"}]` | `instructions`（string）或 input message | 顶层 `system`（blocks） | 顶层 `systemInstruction.parts` |
| `payload.messages[].role` | 同 | input item `role` | 同 | `user`/`model` |
| `payload.messages[].parts[].text` | `content` string 或 `{type:"text"}` | `{type:"message", content:[{type:"input_text"}]}` | `{type:"text", text}` | `{text}` |
| `parts[].image` | `{type:"image_url", image_url:{url}}` | `{type:"input_image", image_url}` | `{type:"image", source:{type,media_type,data}}` | `{inlineData:{mimeType,data}}` / `{fileData:{fileUri}}` |
| `parts[].audio` | `{type:"input_audio", input_audio:{data,format}}` | 同（item 类型不同） | 无对应 → drop + warning | `{inlineData:{mimeType:"audio/..."}}` |
| `parts[].document` | 无对应 | `{type:"input_file"}` | `{type:"document", source}` | `{inlineData}` / `fileData` |
| `parts[].tool_use` | `assistant.tool_calls[{id,type:"function",function:{name,arguments}}]` | output item `{type:"function_call", call_id, name, arguments}` | `{type:"tool_use", id, name, input}` | `{functionCall:{name,args}}`（**无 id**，需合成） |
| `parts[].tool_result` | `{role:"tool", tool_call_id, content}` | `{type:"function_call_output", call_id, output}` | `{type:"tool_result", tool_use_id, content}` | `{functionResponse:{name,response}}`（**无 id**，靠 name/序映射） |
| `parts[].thinking` | 无对应 → drop（或转 text） | `{type:"reasoning", summary}` | `{type:"thinking", thinking, signature}` | `{text, thought:true}` |
| `parts[].redacted_thinking` | drop | drop | `{type:"redacted_thinking", data}` | drop |
| `tools[].parameters` | `function.parameters` | `parameters` | `input_schema` | `functionDeclarations[].parameters` |
| `tools[].strict` | `function.strict` | `parameters.strict` | 无对应 | 无对应 |
| `tool_choice` | 同 | 同 + `{type:"hosted_tool"}` | `auto`/`any`/`tool`/`none` | `toolConfig.functionCallingConfig.mode` |
| `params.max_output_tokens` | `max_completion_tokens`（新）/`max_tokens`（旧） | `max_output_tokens` | `max_tokens`（**必填**） | `generationConfig.maxOutputTokens` |
| `params.top_k` | 部分兼容 | 无 | 无 | `generationConfig.topK` |
| `params.stop` | `stop` | 无 | `stop_sequences` | `generationConfig.stopSequences` |
| `params.frequency_penalty`/`presence_penalty` | 同 | 无 | 无 | 无 |
| `params.safety` | 无 | 无 | 无 | `safetySettings` |
| `response_format` | 同 | `text.format` | 无对应（靠 prompt） | `generationConfig.responseMimeType` + `responseSchema` |
| `thinking.budget_tokens` | 无 | 无 | `thinking.budget_tokens` | `generationConfig.thinkingConfig.thinkingBudget` |
| `thinking.effort` | `reasoning_effort` | `reasoning.effort` | 无 → 阈值表换算 | 无 → 阈值表换算 |
| `cache_control` | 无（自动） | 无（自动） | `cache_control` 块级 | `cachedContent` 资源级 |
| `stream.enabled` | `stream` | `stream` | `stream` | `?alt=sse` |
| `stream.include_usage` | `stream_options.include_usage` | 恒带 | 恒带（message_delta） | 视版本 |

### 9.2 响应映射（目标格式 → canonical）

| canonical | OpenAI Chat | OpenAI Responses | Anthropic | Gemini |
|---|---|---|---|---|
| `usage.tokens.input_tokens` | `usage.prompt_tokens` | `usage.input_tokens` | `usage.input_tokens` | `usageMetadata.promptTokenCount` |
| `usage.tokens.output_tokens` | `usage.completion_tokens` | `usage.output_tokens` | `usage.output_tokens` | `usageMetadata.candidatesTokenCount` |
| `usage.tokens.cache_read_tokens` | `prompt_tokens_details.cached_tokens` | `input_tokens_details.cached_tokens` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| `usage.tokens.cache_write_tokens` | — | — | `cache_creation_input_tokens` | — |
| `usage.tokens.reasoning_tokens` | `completion_tokens_details.reasoning_tokens` | `output_tokens_details.reasoning_tokens` | 计入 output | `thoughtsTokenCount` |
| `finish_reason` | `finish_reason` | `status`/`incomplete_details` | `stop_reason` | `finishReason` |
| assistant 文本 | `message.content` | `output_text` | `content[].text` | `parts[].text` |
| tool_use | `tool_calls[]` | `function_call` items | `tool_use` blocks | `functionCall` parts |
| 搜索引用 | `annotations` | `annotations`（url_citation） | `web_search_tool_result` | `groundingMetadata.groundingChunks` |

### 9.3 `finish_reason` 归一表

> 枚举值依据 2026-11 官方文档。来源见 [docs/sources.md](../sources.md) §格式细节。

| canonical | OpenAI Chat | OpenAI Responses | Anthropic | Gemini |
|---|---|---|---|---|
| `stop` | `stop` | `status:"completed"` | `end_turn` | `STOP` |
| `length` | `length` | `incomplete_details.reason:"max_output_tokens"` | `max_tokens` | `MAX_TOKENS` |
| `tool_use` | `tool_calls` | （由 output item 驱动，无独立 reason） | `tool_use` | `STOP`（靠 part 里有 `functionCall` 判别） |
| `content_filter` | `content_filter` | `incomplete_details.reason:"content_filter"` | `refusal`（配 `stop_details`） | `SAFETY` / `PROHIBITED_CONTENT` / `BLOCKLIST` / `SPII` |
| `stop_sequence` | `stop` | — | `stop_sequence` | `STOP` |
| `error` | — | `status:"failed"` | — | `MALFORMED_RESPONSE` / `MALFORMED_FUNCTION_CALL` / `UNEXPECTED_TOOL_CALL` / `TOO_MANY_TOOL_CALLS` |
| `pause_turn` | — | — | `pause_turn` | — |
| `recitation` | — | — | — | `RECITATION` / `IMAGE_RECITATION` |
| `context_exceeded` | — | `incomplete_details.reason:"max_messages"` | `model_context_window_exceeded` | — |
| `other` | `function_call`（已弃用） | — | — | `OTHER` / `LANGUAGE` / `FINISH_REASON_UNSPECIFIED` / `ESCALATION` |
| `missing_thought_signature` | — | — | — | `MISSING_THOUGHT_SIGNATURE`（Gemini 3/4 函数回环缺签名） |

**注意 1**：canonical 的枚举是**超集**，不是四家的交集。任何一家的值都能在 canonical 里表达；反回去时按目标格式的能力 drop 或就近映射。

**注意 2（重要，反 LiteLLM 的教训）**：**映射表未命中时不得默认 `stop`**，必须落到 `other` 并 `warnings += "unmapped_finish_reason:<原文>"`。LiteLLM 的 `map_finish_reason` 未命中时默认 `stop`，是其多个 issue 的根因（如 Gemini `MALFORMED_FUNCTION_CALL` → `stop`，框架误判完成、静默失败；Gemini `OTHER` → `content_filter`，把"未知原因"误报成内容过滤）。我们把"未知"显式建模为 `other` + 保留原文，下游可以自己决定怎么处理。

**注意 3**：`finish_reason` 必须**双向可逆**——归一值用于 canonical，原文（`raw.finish_reason_provider`）用于回写与对账。LiteLLM 的补偿手段是把原始 `stop_reason` 写进 `provider_specific_fields`，我们直接用 `raw` 承载。

> `finish_reason` 的归一化是 fast path 下也要做的三件事之一（另两件：tool id 补全、usage 口径），见 [20-pipeline.md](./20-pipeline.md) §4.3。

### 9.4 2026 年协议变更对映射表的影响（必读）

| 变更 | 对映射的影响 |
|---|---|
| **Anthropic API version `2026-10-21` 移除 `temperature` / `top_p` / `top_k`**（发送即 400） | canonical `ChatParams` 保留这三字段（OpenAI/Gemini 还要用），但 `anthropic.messages` adaptor 编码时**必须丢弃** + `warnings`。这是"canonical 超集、adaptor 按需"的典型例证 |
| **Gemini `functionCall` 新版有 `id`**；函数回环要求每个 step 的第一个 functionCall Part 带回 `thoughtSignature`，否则 400（finishReason 出现 `MISSING_THOUGHT_SIGNATURE`） | 修正"Gemini 无 id"的旧认知。canonical `ToolUsePart.id` 直接映射；`ThinkingPart.signature` 承载 thoughtSignature。**`[待验证]`** 旧版 API 是否仍无 id |
| OpenAI Responses `function_call` item 同时有 `id`（item 标识）与 `call_id`（回传用） | canonical `ToolUsePart.id` 为权威 id；codec 维护 `id ↔ call_id` 映射 |
| OpenAI Responses `reasoning` item 必须随 tool 输出一起回传（含 `encrypted_content`） | `ThinkingPart` / `RedactedThinkingPart` 承载；工具循环里必须保留 |
| Gemini `thinkingBudget` 与 `thinkingLevel` 同传会 400；Gemini 4 传 `thinkingBudget` 会被映射并告警 | canonical 用 `ThinkingConfig.effort`（档位）+ `budget_tokens`（连续），adaptor 按目标模型二选一 |
| Gemini `temperature`/`topP`/`topK` 在 Gemini 3.6 Flash+ **静默忽略** | adaptor 应 drop + `warnings`（不静默） |
| Gemini 显式缓存（`cachedContents`）不支持 Gemini 4 / Interactions API | `CacheControl.cache_name` 映射到 `cachedContent`；不支持的 drop + warning |
| Anthropic `web_search_20250305` → `20260209` → `20260318`；`code_execution` / `computer` 同演进 | `BuiltinTool.raw.provider_tool_type` 记版本串，canonical 只用稳定名 |
| Anthropic 新增 `output_config{effort, format:{json_schema}}` | `ThinkingConfig.effort` + `ResponseFormat` |
| Anthropic 新增顶层 `cache_control`（自动标记最后一个可缓存块） | `CacheControl` 映射到 Anthropic 时可选"显式断点"或"顶层自动" |
| OpenAI Chat Completions 自 GPT-5.4 起仅 `reasoning_effort:"none"` 支持工具调用 | adaptor 检查模型能力，不满足则 `capability_unsupported` |
| OpenAI Responses 新增 `context_management[{type:"compaction",compact_threshold}]` 与 `conversation` 参数 | canonical 不建模上游 compaction（那是插件职责，见 [30-plugin-api.md](./30-plugin-api.md)）；`conversation` 进 `native.openai.*` |
| Gemini 新增 Interactions API（有状态，`previous_interaction_id`） | 进 `native.gemini.*`；canonical 不依赖上游状态（见 §6.1） |

---

## 10. Open Questions

> 编号 Q1–Q12 与 [00-overview.md](./00-overview.md) §8、[12-coverage-survey.md](./12-coverage-survey.md) §5 对齐。

1. **Q1**（最高优先级）：OpenAI `prompt_tokens` 是否已含 `cached_tokens`。Gemini 侧已确认"含"（`promptTokenCount` 含缓存部分）、Anthropic 侧已确认"不含"（`input + cache_creation + cache_read` 才等于总输入）；OpenAI 侧文档未明说，需实测。
2. **Q2**：OpenAI Responses 的 `reasoning` item 多轮回传规则——已知"必须随 tool 输出一起回传且含 `encrypted_content`"，但 `store:false`（ZDR）场景下是否仍必须回传、能否只回摘要，待验证。
3. **Q3（已部分解答）**：Gemini `functionCall` 新版**有** `id`；待验证的是旧版 API 是否仍无 id，以及 `functionResponse` 按 `id` 匹配还是按 `name` + 序匹配。
4. **Q8**：`additionalProperties: false` 是否会因 provider 加字段而频繁报错。2026 年三家都有大量新增字段（Anthropic 一年内多个 tool 版本、OpenAI Responses 30+ item 类型），需要"严格/宽松"开关，默认值待定。
5. **Q6**：`UnknownPart` 的泛滥风险——若某 provider 大量使用不认识的 block，canonical 会退化成 raw 搬运。需要指标监控占比。
6. **Q7**：多模态 `n` 参数：chat 的 `n`（候选数）与 image 的 `n`（张数）同名不同义，是否改名。
7. **Q13**：Anthropic `output_config.effort` 与 `thinking` 的组合限制（如 Haiku 5.5 在 thinking 关闭时高 effort 报 400）来自指南文字，未在 API reference 逐条列出——需要 per-model 能力表。
8. **Q14**：Gemini `functionResponse` 的 `Content.role`：Tool 文档仍写可用 `"function"`，但官方 function-calling 指南示例一律用 `"user"`——建议按 `"user"` 实现（已在指南交叉验证）。
9. **Q15**：`googleSearchRetrieval` 是否已正式废弃（API reference 仍列出，未见显式弃用声明）。
10. **Q16**：`VideoPayload` 占位：v1 只留空 schema，是否要在能力矩阵里显式标 `unsupported`。
11. **Q17**：模型 ID 清单随时间变动（OpenAI `gpt-6-*`、Anthropic `claude-*-5-*`、Gemini `gemini-4-*`），网关应动态拉取模型列表而非硬编码——拉取频率与缓存策略待定。
