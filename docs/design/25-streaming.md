# 25 · 跨模态流式（Unified Streaming）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)、[20-pipeline.md](./20-pipeline.md)、[30-plugin-api.md](./30-plugin-api.md)、[15-modalities.md](./15-modalities.md)

## 1. 问题与结论

**"是否流式"不是布尔开关，是一个 capability。** 一次请求实际涉及三个独立的流式维度：

| 维度 | 取值 | 决定者 |
|---|---|---|
| 客户端要的流式形态 | `sse` / `ws-duplex` / `none` | 客户端 |
| 上游给的流式形态 | `sse` / `chunked-binary` / `ws-duplex` / `none` | provider 能力矩阵 |
| 网关要过的层 | `passthrough` / `canonical` | 插件与配置 |

**兼容性结论（先行）**：

| 上游形态 ↓ / 客户端要 → | `sse` | `chunked-binary` | `ws-duplex` | `none` |
|---|---|---|---|---|
| `sse` | ✅ 过 canonical（默认）或透传 | ⚠️ 桥接：抽文本/事件，二进制需客户端接受 SSE+base64 | ❌ 拒绝 | ✅ 缓冲聚合后一次性返回 |
| `chunked-binary` | ⚠️ 桥接：包成 SSE 帧（base64） | ✅ 透传（推荐） | ❌ 拒绝 | ✅ 缓冲拼整 |
| `ws-duplex` | ⚠️ 仅"半双工拉模式"可桥接（见 §4） | ❌ 拒绝 | ✅ 透传（推荐） | ⚠️ 需建 WS→拉模式的适配 |
| `none` | ❌ 拒绝 | ❌ 拒绝 | ❌ 拒绝 | ✅ |

✅ = 无损兼容；⚠️ = 可做但有代价（延迟/格式/语义折损），需在响应里明示降级；❌ = 明确拒绝（`streaming_mode_unsupported`），**不静默降级**——静默降级会让客户端以为在流式，实际在等全量，是排障噩梦。

## 2. 统一流式帧信封

所有模态、所有桥接路径共用同一种帧结构。**帧是 canonical 的第二公民**（第一是 [10-canonical-schema.md](./10-canonical-schema.md) 的 payload）。

```typescript
/** 统一流式帧。所有模态唯一流式表示。 */
interface StreamFrame<E extends StreamEventType = StreamEventType> {
  /** 帧类型，见 §2.1 */
  event: E;
  /** 单调递增，从 0 开始。用于客户端乱序检测与断线重传定位 */
  seq: number;
  /** 帧所属请求 */
  request_id: string;
  /** 模态判别，决定 payload 结构 */
  kind: ModalityKind;
  /** 事件负载，类型由 kind × event 决定 */
  data: FrameData;
  /** 帧产生时间（网关侧，epoch ms） */
  ts: number;
}

type ModalityKind =
  | "chat" | "image" | "tts" | "asr" | "embedding" | "rerank" | "moderation" | "video";

type StreamEventType = "start" | "delta" | "end" | "error" | "usage" | "meta";

type FrameData =
  | StartData | DeltaData | EndData | ErrorData | UsageData | MetaData;
```

### 2.1 帧类型

```typescript
interface StartData {
  /** 会话/轮次标识；ASR 下为 utterance_id 的容器 */
  session_id?: string;
  model: string;
  /** 客户端格式 + 上游格式（透传模式下仍记录） */
  client_format: FormatId;
  provider_format: FormatId;
  /** 声明的模态能力子集 */
  capabilities?: string[];
}

/** delta 的 payload 由 kind 决定 */
type DeltaData =
  | { kind: "chat";   text?: string; thinking?: string; tool_input_json?: string; refusal?: string }
  | { kind: "tts";    audio: MediaChunk; }                       // append-only
  | { kind: "asr";    transcript: InterimTranscript; }           // 可改写，见 §5
  | { kind: "image";  progress?: number; partial?: MediaRef; index: number }
  | { kind: "embedding"; vector_chunk?: number[]; index: number }
  | { kind: "moderation"; scores: Record<string, number>; index: number };

interface EndData {
  /** 归一化 finish_reason；ASR 下为 "final" */
  finish_reason: NormalizedFinishReason | "final";
  /** 完整载荷的摘要（可选） */
  output?: unknown;
}

interface ErrorData {
  error: CanonicalError;      // 见 20-pipeline.md §6
  /** 该错误是否已使输出不可用 */
  fatal: boolean;
}

interface UsageData { usage: CanonicalUsage; }

interface MetaData {
  /** 非内容性元信息：cache 命中、降级说明、provider 切换等 */
  notes?: Record<string, unknown>;
  warnings?: string[];
}
```

### 2.2 SSE 事件命名

网关对客户端暴露为 SSE 时，事件名统一为 `ag.frame`，帧体为 JSON。这样**新增模态不需要新事件名**，客户端一个 handler 走全部：

```
event: ag.frame
data: {"event":"start","seq":0,"kind":"tts","data":{...}}

event: ag.frame
data: {"event":"delta","seq":1,"kind":"tts","data":{"audio":{"encoding":"base64","mime":"audio/mpeg","data":"...","byte_length":4096,"chunk_index":0}}}
```

同时保留**厂商原生事件名透传**的选项（`stream.native_event_names: true`），用于兼容严格按 OpenAI 事件名解析的客户端；此模式下网关仍发统一帧体，只改 `event:` 行。

二进制优先的客户端（TTS）可用 `Accept: application/octet-stream` 走 §3.2 的裸字节模式，跳过 SSE 信封。

## 3. 三种上游流式形态的桥接

### 3.1 形态 A：SSE 事件流（chat、部分 TTS）

- 直接解析 `event:` / `data:`，按 [20-pipeline.md](./20-pipeline.md) §S6 的表折叠成 `StreamFrame`。
- 上游多行 `data:` 需按 SSE 规范拼接；上游若用 `data: [DONE]` 哨兵，映射为 `end` 帧。
- **透传模式**：原样转发字节，旁路只做帧计数与 usage 嗅探（见 §7）。

### 3.2 形态 B：裸 chunked 字节流（TTS 直接吐 mp3/opus）

上游没有 JSON 信封，只有 `Transfer-Encoding: chunked` 的音频字节。桥接方案：

```
上游 chunked bytes
   │
   ▼
[FormatSniffer]  ── 前 N 字节（默认 512）嗅探容器：
   │                ID3/0xFFFB → mp3；"OggS" → ogg/opus；"RIFF" → wav；"fLaC" → flac；"#!AMR" → amr
   │                嗅探不到 → 用客户端/ provider 声明的 response_format
   ▼
[Framer]  ── 切帧：按 chunk 边界切（一个 HTTP chunk = 一个音频分片），
   │        不做容器级解析（不解码 mp3 帧），保证零拷贝低延迟
   ▼
[SSE 包装] ── 每个分片包成 {kind:"tts", audio: MediaChunk}
```

要点：

- **不解码音频**。网关不解码 mp3/opus 帧，只按传输层 chunk 边界切分，避免引入解码延迟与 CPU 成本。
- **格式元数据只在 `start` 帧声明一次**（mime、sample_rate、bit_depth、channels、codec）。流中**假设不变**；若上游中途变了（罕见），网关无法从裸字节察觉 → 这是形态 B 的已知盲区，记录为 ⚠️，对策是配置里显式声明 `stream.audio_format` 并在 provider 侧固定。
- 客户端 `Accept: application/octet-stream` 时，直接转发 chunk，**不包装**（零开销），仅旁路计量。

### 3.3 形态 C：WebSocket 双向流（实时 ASR）

Deepgram / AssemblyAI 的实时 ASR 是 WS：客户端边说边上传音频，服务端持续回吐转写。**SSE 单向拉不了这个**——上传方向缺失。

设计成**双路径**：

#### 路径 1：透传代理（默认，推荐）

```
客户端 WS ◀══════ 网关 WS 代理 ══════▶ 上游 WS
             （只做：鉴权、限流、计量、观测、审计）
```

- 网关是纯字节/消息中继，**不过 canonical**；
- 计量：按"连接时长 + 上行音频字节数 + 下行消息数"计，不解析内容（除非 `debug_mode`）；
- 优点：零语义损失、最低延迟、上游任何协议细节都天然兼容；
- 缺点：插件完全无法介入（`onStreamChunk` 在透传模式下**不触发**，这是显式设计，不是遗漏）。

#### 路径 2：转换模式（插件需要介入时）

```
客户端 WS ──▶ 网关 [ASR Ingress]  ──▶ 上游（拉模式或 WS）
                │ 音频帧 → canonical MediaChunk
                │ 转写帧 ← canonical StreamFrame{kind:"asr"}
                ▼
           插件链（onStreamChunk 可改写 interim/final 文本）
                │
                ▼
           客户端 WS（用 canonical 帧协议下发）
```

- 客户端必须改用 §2.2 的 `ag.frame` 协议（不再是上游原生协议）——这是转换模式的代价；
- 仅当注册了"需要看/改 ASR 内容"的插件（脱敏、关键词、说话人标注）时才开启；
- 配置：`modalities.asr.streaming.mode: "passthrough" | "canonical"`，默认 `passthrough`。

#### 桥接决策表

| 场景 | 路径 |
|---|---|
| 无 ASR 相关插件 | 透传 |
| 有脱敏/关键词类 ASR 插件 | 转换 |
| 客户端只会 SSE，不会 WS | 拒绝（`streaming_mode_unsupported`），提示用一次性 ASR 端点 |
| 需要"网关同时驱动上游 + 面向客户端" | 转换 |

## 4. 半双工 / 全双工路径划分

| 模态 | 方向 | 默认路径 |
|---|---|---|
| chat | 半双工（请求→响应） | canonical |
| tts | 半双工 | canonical（或 octet-stream 直通） |
| asr（一次性） | 半双工 | canonical |
| asr（实时） | **全双工** | 透传（可切转换） |
| image | 半双工（progress 流） | canonical |
| embedding / rerank / moderation | 半双工 | canonical |

**"实时 ASR 走透传"不违反"插件只面对 canonical"的原则**：那是**模态级**的显式声明，即"这个模态的这个形态我不做结构转换，只做计量"。这与 chat 的"同格式 fast path 透传"是同一思想的推广——**能不过 canonical 就不过，但计量永远在**。

## 5. ASR 中间态语义（可改写，非 append-only）

实时 ASR 的 interim result 之后可能被后续音频改写（`"今天天气"` → `"今天天气不错"`）。canonical 帧必须显式建模：

```typescript
interface InterimTranscript {
  /** 话语段 id；同一段的所有 revision 共享 */
  utterance_id: string;
  /** 该段的修订号，从 0 开始单调递增 */
  revision: number;
  is_final: boolean;
  text: string;
  /** 相对会话开始的起止时间（秒） */
  start: number;
  end: number;
  confidence?: number;
  /** 词级时间戳 */
  words?: Array<{ text: string; start: number; end: number; confidence: number; speaker?: number }>;
  /** 说话人（diarization 开启时） */
  speaker?: number;
  language?: string;
}
```

客户端处理规则（写进 SDK 文档与 WebUI）：

- **按 `utterance_id` 定位，按 `revision` 覆盖**，不是 append；
- `is_final: true` 后该 `utterance_id` 不再有后续帧（否则记 `asr_revision_after_final` warning）；
- UI 层把"当前未 final 的段"渲染为可替换文本，final 后固化；
- 网关侧：`ctx.state.asr_utterances: Map<utterance_id, InterimTranscript>` 暂存最新 revision；`end` 帧时输出完整段列表。**网关不做跨 revision 的文本 diff 合并**——合并是客户端/UI 的职责，网关只保证"同一 utterance_id 的最新 revision 可见"。

## 6. TTS 流式细节

1. **首包延迟（TTFB）**：TTS 的首个音频分片延迟是关键指标。网关不得为"等完整响应"而缓冲；`onStreamChunk` 插件若缓冲，必须声明 `buffering: true` 并在 `start` 帧的 `meta.warnings` 里提示。
2. **严格 append-only**：音频分片顺序即播放顺序，网关与插件**不得重排、不得丢弃**（丢弃 = 音频破损）。唯一允许的操作是"整段拒绝"（`error` 帧 + 断开）。
3. **客户端中途断开**：检测到客户端连接关闭 → 立即取消上游（关闭上游响应体读 + 发送取消信号，若上游支持），**止损**。已产生的音频按实际播放/下发量计费（见 §7 的 `audio_seconds` 计量），不按完整文本计费。这是省成本的关键路径，必须有测试覆盖。
4. **采样率/位深变化**：见 §3.2，形态 B 无法中途察觉；形态 A（SSE 带元信息）时若上游在 `meta` 帧变更，网关发 `meta` 帧通知，客户端需能处理（否则拒绝该变更并断流，避免音频错乱）。

## 7. 流式 + 插件

### 7.1 改写语义

`onStreamChunk(frame, ctx)` 返回值：

- `frame` → 替换；
- `frame[]` → 一帧变多帧（如把一个长 text delta 按句拆分，便于逐句 TTS）；
- `null` → 丢弃（**chat 允许，tts 音频分片禁止**——Runner 对 `kind:"tts"` 的 delta 强制拒绝 `null` 返回，违例记 `plugin_error`）；
- `ShortCircuit` → 不允许（流已开始，无法回头）。

### 7.2 跨帧边界的状态问题

**问题**：脱敏/关键词过滤一个横跨两个 chunk 的词（`chunk1="我的密钥是 sk-"`、`chunk2="abc123..."`），逐帧独立处理会漏。

**解决**：给插件一个可选的**滚动缓冲器**接口，显式声明"我要看边界"：

```typescript
interface StreamChunkBuffer {
  /** 把帧推入缓冲区；返回"现在可以安全下发的字节数" */
  push(frame: StreamFrame): number;
  /** 冲刷缓冲区剩余部分（流结束或插件卸载时必须调用） */
  flush(): StreamFrame[];
  /** 缓冲区的 peek 视图（只读，用于匹配判断） */
  peek(n: number): string;
  /** 当前缓冲字节数 */
  get buffered(): number;
  /** 超过该阈值强制冲刷，防止无限缓冲 */
  max_buffer_bytes: number;
}
```

使用约束：

- 只有声明 `manifest.needs: "cross_chunk"` 的插件才会拿到 buffer；其他插件拿不到，也就没有意外缓冲；
- `max_buffer_bytes` 默认 64KB，超过强制 flush（原样下发未匹配部分）并 warning——**正确性让位于延迟**，因为无限缓冲会把流式变成批处理；
- TTS 音频分片不进滚动缓冲（二进制不可缓冲匹配），只有 `kind:"chat"` 的 text/thinking delta 参与；
- 流结束时 Runner 自动调用所有未 flush 的 buffer 的 `flush()`，保证尾部内容不丢。

### 7.3 压缩类插件的作用范围

`billion-context` 等压缩插件**只在 `onRequest` 生效**，不参与 `onStreamChunk`。理由：压缩改变的是"发出去什么"，流式响应侧没有可压缩对象；若在响应侧做摘要，等于篡改模型输出，属于另一类能力（响应改写），应作为独立插件类型而非复用压缩插件。此约束写进 manifest：`hooks` 里出现 `onStreamChunk` 的插件不能同时声明 `capabilities: ["context_compaction"]`，注册期校验拒绝。

## 8. 流式下的计量（双路对齐）

### 8.1 问题

- 流结束时才拿得到完整 usage；
- 部分上游流式**根本不返回 usage**（Gemini 流式、部分 TTS/ASR）；
- 客户端中途断开时上游可能也不返回 usage。

### 8.2 双路设计

```
                    ┌── 路 1：上游 usage ────────────────────┐
                    │  流内 usage 帧 / 流结束时的 usage 字段   │
                    │  非流式：响应体 usage                   │
                    ▼                                        │
              UsageRecord.usage  ◀── 一致性校验 ──▶  路 2：网关自估算
                    ▲                                        │
                    │  差异超阈值 → 记 usage_mismatch + 两条都存│
                    └── 路 2：网关自估算 ────────────────────┘
                        - chat: tokenizer 精确计数（tiktoken 兼容实现）
                        - tts:  下发音频字节数 / 目标码率 → audio_seconds
                        - asr:  上行音频时长（采样数/采样率）+ 下行转写字数
                        - image: 请求张数 / 上游 token usage
                        - embedding/rerank: tokenizer
```

### 8.3 规则

1. **上游 usage 优先**；缺失或为 0 时用自估算，并置 `usage_source: "estimated"`。
2. 两路都有且差异 > 20% → `usage_mismatch` warning，**两路都存**（`usage` 与 `usage_estimated`），供后续校准，不静默选一个。
3. TTS 按 `audio_seconds` 计费时，客户端中途断开 → 只计**实际下发**的音频秒数（网关有精确下发计数，不需要上游配合）。
4. ASR 按音频时长计费时，用**上行音频**的时长；透传模式下网关按"WS 连接时长 + 上行消息数"估算，标注 `usage_source: "estimated"` + `precision: "low"`。
5. 流式 usage 帧可能多次到达（如 OpenAI 的 `usage` 只在末 chunk、Gemini 每 chunk 都带）→ **取最后一次非空**，中间值只用于进度展示。

### 8.4 多单位 usage 结构

usage 不是单一的 token 数，见 [10-canonical-schema.md](./10-canonical-schema.md) §多单位 usage 与 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §多单位计费。流式帧的 `usage` 帧携带的是同一结构的**部分填充**版本（TTS 先有 `audio_seconds`，后有 tokens）。

## 9. 能力矩阵中"流式"这一栏

每个 (provider, modality) 组合必须声明：

| 字段 | 取值 |
|---|---|
| `streaming.mode` | `none` / `sse` / `chunked-binary` / `ws-duplex` |
| `streaming.partial_results` | `true`（ASR interim）/ `false` |
| `streaming.usage_in_stream` | `true` / `false` |
| `streaming.cancellable` | `true` / `false`（断开能否省计费） |
| `streaming.framing` | `json-sse` / `raw-bytes` / `ws-messages` |

路由阶段（[20-pipeline.md](./20-pipeline.md) §S2）据此做三件事：**拒绝**（桥接不了）、**降级**（能桥接但有代价，写 `meta.warnings`）、**放行**。

## 10. 待验证清单

1. ElevenLabs / MiniMax / OpenAI TTS 的流式到底是 chunked 二进制还是 SSE 信封（决定 §3.2 是否需要 sniff）。
2. Gemini TTS（若存在）的流式形态。
3. Deepgram/AssemblyAI 实时端点是否支持"服务端主动结束"语义（影响透传模式下的 `end` 帧生成）。
4. 上游 WS 断开时，客户端 WS 应收到 `error` 帧还是干净的 `end` 帧（需按上游错误码分类）。
5. 音频分片在 SSE + base64 下的带宽膨胀（33%）对首包延迟的实际影响，决定是否默认走 octet-stream。
