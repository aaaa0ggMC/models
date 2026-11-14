# 15 · 多模态（TTS / ASR / Image / Embedding / decision）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)（信封与媒体引用）、[25-streaming.md](./25-streaming.md)（跨模态流式）、[40-provider-adaptors.md](./40-provider-adaptors.md)（能力矩阵）

---

## 0. 阅读指引

§1 设计决策；§2 TTS canonical；§3 ASR canonical；§4 Image canonical；§5 Embedding；**§6 decision 模态（第 9 个模态，2026-11 新增）**；§7 能力矩阵；§8 端点与流式；§9 字段映射；§10 Open Questions。

`[v1.5]` = v1 之后第一个增量；`[later]` = 明确后续。

---

## 1. 设计决策

### 决策 M1：模态 payload 独立，不塞进 chat 的 messages

**决策**：TTS/ASR/Image/Embedding 各有独立 payload 类型（`TtsPayload` / `AsrPayload` / `ImagePayload` / `EmbeddingPayload`），挂在共享信封下用 `kind` 判别。chat 的 `parts` 里**不出现** TTS/ASR/Image 的顶层结构（但 chat 里可以有 `ImagePart` / `AudioPart` 作为多模态输入，那是另一回事）。

**理由**：TTS 没有"消息"概念（输入是纯文本 + 声音规格）；ASR 的输出是带时间戳的分段而不是一段文本；Image 的参数（尺寸/seed/参考图）与对话无关。硬塞进 messages 会制造"假消息"。

**代价**：路由、计费、UI 都要按 `kind` 分支。接受——这是多模态的固有复杂度，藏起来只会更糟。

### 决策 M2：媒体引用三态统一（inline / uri / asset）

**决策**：所有模态的二进制输入输出都用 `MediaRef`（见 [10-canonical-schema.md](./10-canonical-schema.md) §5）。**不允许**某个模态自己定义一种 base64 字段名。

**理由**：OpenAI Images 用 `b64_json`，Stability 用 `image` 字段，Gemini 用 `inlineData.data`，ElevenLabs 直接返回裸字节。如果不统一，每个 mapper 都要发明一套媒体表示，去重与加密存储也无法跨模态做。

**代价**：需要一层"从裸字节/字段构造 MediaRef"的适配代码。可接受。

### 决策 M3：能力矩阵驱动路由，不支持就拒绝或降级

**决策**：S2 路由阶段查 `(provider, modality, streaming)` 的能力矩阵。三种结果：`allow` / `degrade`（带 `degraded` 字段）/ `reject`（`streaming_mode_unsupported` 或 `capability_unsupported`）。

**理由**：TTS/ASR 各家差异极大（MiniMax 用 `voice_setting`，Azure 用 SSML，Google 用 `audioConfig`），静默丢字段比报错更危险。

### 决策 M4：v1.5 先做"少量 provider 深度打通"，不做"全厂商浅兼容"

**决策**：v1.5 每模态接 2–3 家：

- TTS：OpenAI `audio/speech`、ElevenLabs、MiniMax
- ASR：OpenAI `audio/transcriptions`、Deepgram（一次性）
- Image：OpenAI `images/generations|edits`、FLUX/BFL
- Embedding：OpenAI、Gemini

**理由**：多模态 mapper 的边际成本低但固定成本高；先用 2–3 家把 canonical 形状压稳，再扩。一次接 10 家会导致 canonical 被某家的怪字段带偏。

---

## 2. TTS Canonical `[v1.5]`

### 2.1 请求 payload

```typescript
interface TtsPayload {
  /** 要合成的文本 */
  input: string;
  /** 声音规格 */
  voice: VoiceSpec;
  /** 输出音频格式 */
  output: AudioOutputSpec;
  /** 语言（BCP-47，如 "zh-CN"） */
  language?: string;
  /** 语速 0.25–4.0，1.0 = 正常 */
  speed?: number;
  /** 音调 / 音量 / 稳定性等，按 target 映射 */
  prosody?: ProsodySpec;
  /** 流式 */
  stream?: StreamOptions;
  /** 上游专有配置逃逸阀 */
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

interface VoiceSpec {
  /** 上游 voice id（alloy / nova / 21m00Tcm4TlvDq8ikWAM / ...） */
  voice_id: string;
  /** 声音性别/年龄等元信息（仅记录，不映射） */
  gender?: "male" | "female" | "neutral";
  /** 参考音频（声音克隆）——三态引用 */
  reference_audio?: MediaRef;
  /** 相似度/稳定性等（ElevenLabs voice_settings） */
  settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

interface AudioOutputSpec {
  /** 容器/编码：mp3 / opus / aac / flac / wav / pcm / mulaw / alaw */
  format: string;
  sample_rate?: number;      // 24000 / 44100 ...
  bit_depth?: number;        // 16 / 24
  channels?: number;         // 1 / 2
  bitrate?: number;          // kbps
  /** 一次性 or 流式 */
  mode: "once" | "stream";
}

interface ProsodySpec {
  /** 音调（Azure prosody pitch / Google pitch，相对量或半音） */
  pitch?: number;
  /** 音量（Google volumeGain, dB） */
  volume_gain?: number;
  /** 情感/风格指令（OpenAI gpt-4o-mini-tts instructions） */
  instructions?: string;
  /** SSML 原文（Azure 路线；给了就走 SSML，忽略结构化字段） */
  ssml?: string;
  /** 发音词典（MiniMax pronunciation_dict） */
  pronunciation_dict?: Array<{ word: string; pronunciation: string }>;
  /** 前后文（ElevenLabs previous_text / next_text，用于连贯性） */
  context?: { previous?: string; next?: string };
  seed?: number;
}
```

**设计说明**：`prosody.ssml` 是一个**逃生舱**——Azure 的 SSML 表达力远超结构化字段，硬建模 SSML 会让 canonical 爆炸。给了 `ssml` 就走 Azure 路线，结构化字段忽略并在 `warnings` 声明。

### 2.2 响应 payload

```typescript
interface TtsResponsePayload {
  /** 合成的音频 */
  audio: MediaRef;
  /** 上游返回的格式（可能与请求不同） */
  actual_format: AudioOutputSpec;
  /** 音频时长（秒），用于计费兜底 */
  duration_seconds?: number;
  /** 上游原始响应头里的 id（history-item-id / request-id） */
  upstream_request_id?: string;
}
```

### 2.3 流式

见 [25-streaming.md](./25-streaming.md) §3.2 与 §6：TTS 流式分两种上游形态——**SSE 信封**（少数）与**裸 chunked 字节**（ElevenLabs `/stream`、OpenAI、MiniMax）。网关统一输出 `StreamFrame{kind:"tts", data:{audio: MediaChunk}}`，音频分片**严格 append-only**，客户端断开立即取消上游止损。

---

## 3. ASR Canonical `[v1.5]`

### 3.1 请求 payload

```typescript
interface AsrPayload {
  /** 音频输入 */
  audio: MediaRef;
  /** 语言提示（BCP-47；不给则上游自动检测） */
  language?: string;
  /** 提示词/领域词（OpenAI prompt / Deepgram keywords / AssemblyAI word_boost） */
  prompt?: string;
  keywords?: string[];
  /** 输出粒度 */
  granularity?: ("word" | "segment" | "utterance")[];
  /** 说话人分离 */
  diarization?: {
    enabled: boolean;
    speakers_expected?: number;
    min_speakers?: number;
    max_speakers?: number;
  };
  /** 标点/格式化 */
  punctuate?: boolean;
  format_text?: boolean;
  /** 去口语填充词（AssemblyAI disfluencies） */
  remove_disfluencies?: boolean;
  /** 流式（实时） */
  stream?: StreamOptions;
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}
```

### 3.2 响应 payload

```typescript
interface AsrResponsePayload {
  /** 全文（最终） */
  text: string;
  /** 检测到的语言 */
  language?: string;
  /** 音频时长（秒）——ASR 计费主单位 */
  duration_seconds?: number;
  /** 分段 */
  segments?: AsrSegment[];
  /** 话语段（按说话人/静音切分） */
  utterances?: AsrUtterance[];
  /** 整段置信度 */
  confidence?: number;
}

interface AsrSegment {
  id: number;
  start: number;      // 秒
  end: number;
  text: string;
  confidence?: number;
  words?: AsrWord[];
  speaker?: number;
}

interface AsrUtterance {
  /** 话语段 id，中间态语义见 25-streaming.md §5 */
  utterance_id: string;
  start: number;
  end: number;
  text: string;
  confidence?: number;
  speaker?: number;
  words?: AsrWord[];
}

interface AsrWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
  /** 词是否已 final（流式下） */
  is_final?: boolean;
}
```

### 3.3 中间态（interim）语义

实时 ASR 的 interim result **不是 append-only**，后续音频可能改写它。canonical 帧带 `utterance_id` + `revision` + `is_final`，客户端按"定位 + 覆盖"处理。详见 [25-streaming.md](./25-streaming.md) §5。

---

## 4. Image Canonical `[v1.5]`

### 4.1 请求 payload

```typescript
interface ImagePayload {
  prompt: string;
  negative_prompt?: string;

  /** 尺寸：显式像素 or 比例（aspect_ratio）二选一 */
  size?: { width: number; height: number };
  aspect_ratio?: string;         // "1:1" / "16:9" / "21:9" / "auto"
  /** 生成数量 */
  n?: number;

  /** 质量/风格 */
  quality?: "low" | "medium" | "high" | "hd" | "auto";
  style?: string;                // vivid / natural / style_preset
  /** 采样参数（Stability / FLUX） */
  sampling?: {
    steps?: number;
    guidance?: number;           // cfg_scale
    sampler?: string;
    seed?: number;
  };
  /** 是否允许 prompt 自动改写（dall-e-3 revised_prompt） */
  allow_prompt_rewrite?: boolean;

  /** 图生图 / 局部重绘 */
  edit?: {
    /** 原图（img2img） */
    image?: MediaRef;
    /** mask（inpaint） */
    mask?: MediaRef;
    /** 改动强度 0–1 */
    strength?: number;
    /** 多参考图 */
    reference_images?: Array<{ image: MediaRef; weight?: number; mode?: "style" | "content" }>;
  };

  /** 输出 */
  output: {
    format: "png" | "jpeg" | "webp";
    /** 响应形态：base64 或 URL */
    response_type: "b64_json" | "url";
    /** 背景透明（gpt-image-1） */
    transparent_background?: boolean;
  };

  /** 内容审核强度 */
  moderation?: "auto" | "low" | "high";
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}
```

### 4.2 响应 payload

```typescript
interface ImageResponsePayload {
  images: Array<{
    /** 生成的图 */
    image: MediaRef;
    /** 上游改写后的 prompt（dall-e-3） */
    revised_prompt?: string;
    /** 内容寻址 hash（去重） */
    sha256?: string;
  }>;
  /** 异步轮询型上游（FLUX/BFL）的中间态 */
  polling?: { url: string; status: string };
}
```

**设计说明（FLUX/BFL 是异步轮询）**：BFL 的 `flux-pro-1.1` 返回 `{id, polling_url, status}` 而不是图本身。canonical 用 `polling` 字段承载，网关在 S5 内部完成轮询（对客户端呈现为同步），轮询过程写进 `RequestTrace.attempts`。**待验证**：BFL 是否有同步返回模式或 webhook 模式可选。

---

## 5. Embedding Canonical `[v1]`

```typescript
interface EmbeddingPayload {
  input: string | string[] | MediaRef[];    // 文本或多模态 embedding
  dimensions?: number;                       // 截断维度（OpenAI dimensions）
  encoding_format?: "float" | "base64";
  user?: string;
  native?: Record<string, unknown>;
  raw: RawEnvelope;
}

interface EmbeddingResponsePayload {
  embeddings: Array<{ index: number; vector: number[] | string }>;
  model: string;
}
```

计费单位：`usage.units.tokens`。Gemini 的 embedding 有独立的 `taskType`（`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` 等），进 `native.gemini.task_type`。**待验证**：Gemini embedding 的 usage 字段名。

---

## 6. decision 模态（判断模型）`[v1.5]`

> 这是**第五个模态**，与 chat / image / tts / asr 并列。**不是 chat 的特例。**

### 6.0 决策 M5：decision 是独立模态，不是 chat 的分支

**决策**：`kind: "decision"`，独立 payload、独立 adaptor、独立端点、独立 usage 单位。

**理由**：

1. **输出形态根本不同**。chat 返回一段（可能很长的）文本，由调用方自己解析；decision 返回**结构化的判断结果**（label + 校准概率 + 置信度 + 逐选项概率）。把 decision 塞进 chat 意味着"用 chat 模拟 decision"——而这条路线的校准性、延迟、成本都更差（见 §6.1）。
2. **一次请求问多个问题**。chat 的一轮请求只有一个"回答"；decision 一次前向计算可对最多约 1000 个相互独立的问题评分（Gemini 报道值，`[待验证]`）。这是批量语义，chat 没有。
3. **输入计费、输出免费**。三家 decision API 的定价形态都是"输入 token 计费、输出免费"（Gemini 报道 $0.10/M 输入、输出免费；Jev 报道 $0.042/M 输入、输出免费，均 `[待验证]`）。这与 chat 的输入输出双向计费完全不同，必须靠 `pricing_state` 表达（见 [10-canonical-schema.md](./10-canonical-schema.md) §6 规则 5）。
4. **用途是控制面而非内容面**。它的设计用途是工具选择、策略检查、模型路由、上下文质量评估、compact/escalate/stop 决策——这些都是网关自己要做的判断（见 [20-pipeline.md](./20-pipeline.md) §9 与 [45-credentials.md](./45-credentials.md) §4）。

**考虑过的替代方案**：

- *A. 用 chat + 结构化输出（`response_format: json_schema`）模拟*。否掉为主路径，但**保留为降级路径**——因为不是每个部署都有 decision 上游。降级必须在响应里标记 `calibration: "degraded"` 并说明代价（见 [40-provider-adaptors.md](./40-provider-adaptors.md) §6.3）。
- *B. 把 decision 建模成 chat 的一个内置工具*。否掉：内置工具是"模型决定何时调用"，decision 是"网关主动发起的批量判断"，控制方向相反。

**代价**：多一个 adaptor、多一套 usage 归一类（`units.questions` + `pricing_state`）、UI 要多一个页面。接受——这是控制面能力的根基。

### 6.1 decision vs chat 对照表

| 维度 | chat | decision |
|---|---|---|
| 请求结构 | `messages[]` 对话历史 + `tools[]` | `content[]`（多模态引用）+ `questions[]`（批量、相互独立） |
| 输出形态 | 自由文本（+ 可选 tool_use） | 结构化：`{label, probability?, confidence?, option_probabilities?}`（三个字段**都是可选的**，见 D8c） |
| 批量语义 | 一轮一个回答 | 一次前向计算 1–1000 个问题（Gemini）；OpenAI 1–400；Jev 无独立上限。**1→100 题延迟近乎持平** |
| 能否互相替代 | chat **能**模拟 decision（降级路径） | decision **不能**做 chat（**已由三家官方文档直接确认**） |
| 校准性 | 差。Top-1 ECE：GPT-6 Luna 0.0721 vs Gemini Decision 1 0.0250（Google launch eval，自评） | 核心卖点即校准概率 |
| 判断稳定性 | 每个 LLM 条件都有帖子变号 >10% | Jev 最不稳定选项仅 4.0% 变号（从不 >6.7%） |
| 延迟预期 | 数秒（要生成长文本） | **150–250 ms**（Gemini 官方 e2e）；Jev cookbook mean 103 ms |
| 成本（同 8 个 Choice 问题） | GPT-6 Luna $0.000269；Claude Haiku 5.5 $0.001019；GPT-6 Astra $0.055399 | **Jev $0.000066**（TypeSafe cookbook 2026-11-02 实测） |
| 相对代价（同上基准） | 4.1x–1189.0x 贵、26.8x–176.9x 慢 | 1x |
| 计量 | `units.tokens`（输入+输出双向计费） | `units.tokens` + `units.questions`；**输入计费、输出免费** |
| prompt caching | ✅ 普遍支持 | **仅 OpenAI Decisions**（隐式 breakpoint + ≥1024 token 前缀；Gemini 明确不支持、Jev 无） |
| 可自托管 | ✅ 大量开源权重 | ✅ **261 个 ranked open-weights 系统**（Jeff / AutoJev / Cloudflare clef / BaseTen 等） |
| 能力方向 | 生成内容 | 做判断/评分/选择 |
| 流式 | ✅ SSE | ❌ 无流式语义 |
| 典型用途 | 对话、写作、代码 | 工具选择、策略检查、模型路由、上下文质量评估、compact/escalate/stop |

**chat 模拟 decision 的实测代价**（TypeSafe cookbook 2026-11-02，8 个 Choice 问题/次，`[待验证]` 独立复现）：

| 模型 | 延迟 | 成本 | 相对 Jev |
|---|---|---|---|
| **Jev 1.14** | **103 ms** | **$0.000066** | 1x |
| GPT-6 Luna (temp 0) | 2,753 ms | $0.000269 | 26.8x 慢 / 4.1x 贵 |
| GPT-6 Luna (reasoning) | 14,467 ms | $0.000685 | 140.8x / 10.4x |
| Claude Haiku 5.5 (reasoning) | 6,110 ms | $0.001019 | 59.5x / 15.5x |
| GPT-6.1 Terra (temp 0) | 4,274 ms | $0.002694 | 41.6x / 41.1x |
| GPT-6.1 Terra (reasoning) | 11,829 ms | $0.005616 | 115.2x / 85.6x |
| Claude Sonnet 5.5 (reasoning) | 3,627 ms | $0.009907 | 35.3x / 151.0x |
| GPT-6.1 Sol (reasoning) | 12,335 ms | $0.010125 | 120.1x / 154.4x |
| Claude Opus 5.5 (reasoning) | 7,841 ms | $0.027427 | 76.3x / 418.2x |
| GPT-6 Astra (reasoning) | 18,171 ms | $0.055399 | 176.9x / 844.6x |
| Claude Fable 5.1 (reasoning) | 12,793 ms | $0.077985 | 124.5x / 1189.0x |

即使用**最便宜的 LLM + temperature 0 + structured output**，也要 ~27x 延迟、~4x 成本；开 reasoning 后差距拉到 140x / 10x。

**稳定性（比均值更重要）**：40 个边界帖子 × 15 次重复，Jev 的"最不稳定选项"平均只变号 **4.0%**（从不 >6.7%），而**每个 LLM 条件**都有帖子变号 >10%。对 compact/escalate/stop 这类"同一输入应给同一判断"的决策，抖动比慢更致命。

**校准度对比**（Google launch eval，自评）：Top-1 ECE Gemini Decision 1 **0.0250** < Jev 1.14 0.0494 < GPT-6 Luna 0.0721；JevBench 92.2% vs 90.0%；When2Call 79.9% vs **82.0%**（此项 Gemini 反而略低）；评测花费 $0.88 vs $0.68。第三方（Artificial Analysis）：Decision Index 66/60/66，Brier 0.18/0.19/0.19，每任务 211/206/**92** ms，每 1M 任务 $345/$339/**$156**。
⚠️ **AIHubMix 明确警告**："A lower aggregate ECE does not establish a calibrated threshold for your tool router"——聚合校准度好不代表你的具体判断任务有可用阈值。

**Google 官方博客另有一个口径**：Decisions API 比 Gemini 3.5 Flash-Lite + Interactions API **便宜近 5x**（共享 benchmark suite）。

**可自托管的开源替代**（若不想依赖商业 API）：JevBench 榜单有 **261 个 ranked open-weights 系统**。代表：Jeff（Firelex，weights Apache-2.0，RTX PRO 6000 ~22 ms，5 benchmark 79.1%/83.1%/81.6% vs Jev 83.0%）、AutoJev-27B（MIT 训练配方）、Cloudflare clef 家族（clef 27B / clef-flash 9B / clef-omni MoE）、BaseTen joey-1/elephant-1/mammoth-1、Together Tev1-4B、jaredpalmer/kev-4b（`/v1/systemone` 兼容）。**OpenRouter 已服务 41 个 decisions 模型**，并有统一的 `/api/alpha/decisions` 与 `/api/v1/systemone` 归一端点——可作为我们"decision modality 上游抽象"的样板。

### 6.2 canonical payload

见 [10-canonical-schema.md](./10-canonical-schema.md) §4.6（`DecisionPayload` / `DecisionQuestion` / `DecisionAnswer`）。要点复述：

- `content[]` 复用 §5 的 `MediaRef` 三态（inline / uri / asset），因此 decision 的输入可以是文本 + 图片 + 音频 + 视频 + PDF 混合；
- `questions[]` 每问带 `type`（`binary` / `choice` / `scale` / `rubric`）+ `options` / `scale` / `rubric`；
- 响应 `answers[]` 按 `question_id` 回填，`probability` 与 `confidence` **分开建模**（D8）。

### 6.3 端点形态

```text
POST /v1/decisions                      # 一次性（唯一形态；无流式）
```

请求体即 `CanonicalRequestEnvelope{kind:"decision"}` 的 JSON 序列化；响应体即 `CanonicalResponseEnvelope{kind:"decision"}`。

### 6.4 网关自身的消费点（dog-fooding）

decision 模态的**首要消费者是网关自己**，不是终端用户：

| 消费点 | 问什么 | 用哪个 type |
|---|---|---|
| 模型路由（S2） | 这个请求更像"需要强推理"还是"轻量任务"？ | `binary` × N 或 `choice` |
| 工具选择（S3 / agentic loop） | 下一步该调哪个工具 / 该不该继续循环？ | `choice` |
| 策略检查（S0） | 这个请求是否触碰某条策略？ | `binary` + `rubric` |
| 上下文质量评估（压缩插件） | 这段历史还有信息量吗 / 该压缩了吗？ | `scale` |
| compact / escalate / stop 决策（agentic loop） | 继续、压缩、升级模型、还是停止？ | `choice` |
| fast path 判定辅助 | 这次转换是否可能丢关键字段？ | `binary` |

这些消费点让 decision 从"一个可选模态"变成"网关的自省能力"，也直接服务 dog-fooding（[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §6）。

### 6.5 降级路径（上游只有 chat 模型时）

见 [40-provider-adaptors.md](./40-provider-adaptors.md) §6.3。要点：用 chat + `response_format: json_schema` 模拟，响应标记 `calibration: "degraded"`，并在 `warnings` 说明代价。

**实测代价**（TypeSafe cookbook 2026-11-02，8 个 Choice 问题/次，`[待验证]` 独立复现，数据见 §6.1）：延迟 26.8x–176.9x、成本 4.1x–**1189.0x**（原写 844.6x 是抄错了行——844.6x 属于 GPT-6 Astra，1189.0x 才是表内最大值 Claude Fable 5.1；§6.1 的表格与 [12-coverage-survey.md](./12-coverage-survey.md) §5.1 均写 1189x）：且**判断稳定性显著变差**——LLM 条件的帖子变号 >10%，而 Jev 最不稳定的选项仅 4.0%（从不 >6.7%）。对 compact/escalate/stop 这类"同一输入应给同一判断"的决策，抖动比慢更致命。

**因此降级的默认策略是 `on_missing_upstream`**（只在路由不到 decision 上游时降级），且**策略检查与 stop 决策不允许降级**——拿不到真 decision 就明确失败，不用 chat 顶替。

## 7. 能力矩阵（三态：已实现 / 计划 / 按需）

每个 `(access_path, model, modality)` 必须登记。**注意矩阵的键是 `(access_path, model)` 而不是 `model`**——同一个 `gpt-5.4` 在 `openai`（API key）与 `openai-codex`（订阅 OAuth）两条路径下能力与限额完全不同，见 [45-credentials.md](./45-credentials.md) §6。这是路由决策的唯一依据。

```typescript
interface CapabilityEntry {
  provider: string;
  modality: ModalityKind;
  /** 支持的具体端点/模型 */
  models: string[];
  /** 流式形态，见 25-streaming.md §9 */
  streaming?: {
    mode: "none" | "sse" | "chunked-binary" | "ws-duplex";
    partial_results?: boolean;
    usage_in_stream?: boolean;
    cancellable?: boolean;
    framing?: "json-sse" | "raw-bytes" | "ws-messages";
  };
  /** 该模态的 usage 单位 */
  usage_units: Array<keyof UsageUnits>;
  /** 不支持的 canonical 字段（用于 on_unsupported 策略） */
  unsupported_fields?: string[];
  /** 已知的口径怪癖 */
  quirks?: string[];
  /** 契约测试状态 */
  contract_tested: boolean;
}
```

### 7.1 v1.5 目标矩阵（初版，字段待 mapper 实现时校准）

**图例**：**[实]** = 已实现（v1.5 写透）；**[计]** = 计划（当前 Phase 交付物）；**[需]** = 按需（用到再写）；**✗** = 明确不支持（路由会拒绝）。

| access_path | chat | **decision** | embedding | tts | asr | image |
|---|---|---|---|---|---|---|
| openai | **[实]** chat+responses | **[需]** Decisions API（Luna） | **[实]** | **[计]** speech | **[计]** transcriptions | **[计]** generations/edits |
| anthropic | **[实]** messages | ✗ | ✗ | ✗ | ✗ | ✗ |
| gemini | **[计]** generateContent | **[计]** Decisions API（Gemini Decision 1） | **[需]** | **[需]**（待验证） | **[需]**（待验证） | **[需]**（待验证） |
| elevenlabs | ✗ | ✗ | ✗ | **[计]** tts | **[需]**（STT，待验证） | ✗ |
| jev (TypeSafe) | ✗ | **[计]** | ✗ | ✗ | ✗ | ✗ |
| openai-codex | **[计]**（订阅路径，见 45-credentials） | ✗ | ✗ | ✗ | ✗ | ✗ |
| xai-supergrok | **[计]**（订阅路径） | ✗ | ✗ | ✗ | ✗ | ✗ |
| minimax | **[需]** | ✗ | **[需]** | **[需]** t2a_v2 | **[需]** | **[需]** |
| azure | **[需]** | ✗ | **[需]** | **[需]** SSML | **[需]** | **[需]** |
| google-cloud | ✗ | ✗ | **[需]** | **[需]** synthesize | **[需]** | **[需]** |
| deepgram | ✗ | ✗ | ✗ | ✗ | **[需]** listen（一次性+WS） | ✗ |
| assemblyai | ✗ | ✗ | ✗ | ✗ | **[需]** transcript | ✗ |
| stability | ✗ | ✗ | ✗ | ✗ | ✗ | **[需]** |
| bfl (flux) | ✗ | ✗ | ✗ | ✗ | ✗ | **[需]** |
| bedrock / vertex | **[需]** | ✗ | **[需]** | **[需]** | **[需]** | **[需]** |

**规则**：`[计]` 只允许存在于当前 Phase 的交付物清单里；不在当前 Phase 的一律 `[需]`。防止 roadmap 膨胀成饼。

---

## 8. 端点形态与流式

### 8.1 端点

```text
TTS:    POST /v1/audio/speech                  （once，返回二进制或 base64）
        POST /v1/audio/speech:stream           （SSE，StreamFrame kind:"tts"）
ASR:    POST /v1/audio/transcriptions          （once，multipart 或 JSON+MediaRef）
        WS   /v1/realtime                      （实时，见 25-streaming.md §3.3 双路径）
IMAGE:  POST /v1/images/generations
        POST /v1/images/edits
        POST /v1/images/generations:stream     （进度流，StreamFrame kind:"image"）
DECIDE: POST /v1/decisions                  # 判断模型（无流式，见 §6.3）
EMBED:  POST /v1/embeddings
```

### 8.2 流式在非 chat 模态怎么走

| 模态 | 上游形态 | 网关输出 | 说明 |
|---|---|---|---|
| TTS | chunked-binary（多数）/ SSE（少数） | SSE `ag.frame` 或 `application/octet-stream` 直通 | 首包延迟关键；音频分片 append-only |
| ASR（一次性） | 无流式 | 无流式 | 只能 once |
| ASR（实时） | WebSocket 双向 | WS 透传（默认）或 WS + canonical 帧（插件介入时） | 见 [25-streaming.md](./25-streaming.md) §3.3 |
| Image | 轮询 / SSE 进度 | SSE `ag.frame{kind:"image", progress}` | 部分上游（BFL）只能轮询，网关内部轮询后转成进度流 |

### 8.3 "能兼容吗"的结论

| 需求 | 结论 |
|---|---|
| TTS 流式 | ✅ 无损（网关只切帧不解码） |
| ASR 一次性 | ✅ 无损 |
| ASR 实时 + 插件 | ⚠️ 必须切 canonical 模式，客户端改用 `ag.frame` 协议 |
| ASR 实时 + 严格上游协议保真 | ✅ 但只能透传，插件不可见 |
| Image 流式进度 | ✅ 但 BFL 类轮询型有额外延迟（轮询间隔） |
| 视频 | ❌ v1.5 不做 |

---

## 9. 字段映射（方法论 + 每模态一个完整示例 + 按需补充简表）

> **结构说明**：每个模态给 **canonical payload 定义（§2–§5）+ 一个完整映射示例 + 一张"待按需补充"简表**。
> 不穷举所有厂商——adaptor 是按需写的（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.0），但 canonical 是全量的（[12-coverage-survey.md](./12-coverage-survey.md) §2）。
> 新增 adaptor 时走 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.6 的检查清单。

### 9.1 TTS

**完整示例（v1.5 写透）：`openai.audio.speech` + `elevenlabs.tts`**

| canonical | OpenAI `audio/speech` | ElevenLabs `text-to-speech/{voice_id}` |
|---|---|---|
| `input` | `input` | `text` |
| `voice.voice_id` | `voice` | URL path 参数 |
| `voice.settings.stability` | ❌ drop | `voice_settings.stability` |
| `voice.settings.similarity_boost` | ❌ drop | `voice_settings.similarity_boost` |
| `voice.settings.style` | ❌ drop | `voice_settings.style` |
| `voice.settings.use_speaker_boost` | ❌ drop | `voice_settings.use_speaker_boost` |
| `prosody.instructions` | `instructions`（仅 gpt-4o-mini-tts） | ❌ drop |
| `speed` | `speed` | ❌ drop |
| `prosody.pitch` / `volume_gain` | ❌ drop | ❌ drop |
| `prosody.seed` | ❌ drop | `seed` |
| `prosody.context.previous/next` | ❌ drop | `previous_text` / `next_text` |
| `prosody.pronunciation_dict` | ❌ drop | ❌ drop（`[待验证]`） |
| `language` | ❌ drop（voice 隐含） | `language_code` |
| `output.format` | `response_format` | 编码进 `output_format` |
| `output.sample_rate` | ❌ drop | 编码进 `output_format`（如 `mp3_44100_128`） |
| `output.channels` | ❌ drop | ❌ drop |
| `stream.mode` | chunked 二进制 | `/stream` 端点，chunked 二进制 |
| 响应 audio | 裸字节 | 裸字节 |
| 响应 `upstream_request_id` | ❌ | 响应头 `history-item-id` / `request-id` |

**`[待验证]`**：OpenAI `audio/speech` 是否支持流式分片返回（以及是否要 `stream: true`）；ElevenLabs 发音字典的可用端点。

**待按需补充简表**（动工前查这些已知差异点即可，不必提前写 adaptor）：

| 厂商 | 关键差异点 |
|---|---|
| **MiniMax** `t2a_v2` | 参数在 `voice_setting{voice_id,speed,vol,pitch}` 与 `audio_setting{sample_rate,bitrate,format,channel}` 两个子对象里；响应 base64 在 `data` 字段 + `extra_info{audio_length,audio_size,bitrate}`；有 `language_boost` / `timber_weights`；流式形态 `[待验证]` |
| **Azure Speech** | 走 **SSML**（`<speak><voice><prosody rate pitch>`）——用 `prosody.ssml` 逃生舱，结构化字段忽略；`X-Microsoft-OutputFormat` 头指定编码 |
| **Google Cloud TTS** | `input.text` / `input.ssml`；`voice{languageCode,name,ssmlGender}`；`audioConfig{audioEncoding: LINEAR16/MP3/OGG_OPUS/MULAW/ALAW, speakingRate, pitch, volumeGain, sampleRateHertz, effectsProfileId}`；响应 base64 在 `audioContent` |
| **Gemini TTS** | `[待验证]` 是否有原生 TTS 端点（如 `models/gemini-*-tts`） |

### 9.2 ASR

**完整示例（v1.5 写透）：`openai.audio.transcription`**

| canonical | OpenAI `audio/transcriptions` |
|---|---|
| `audio` | `file`（multipart） |
| `language` | `language` |
| `prompt` | `prompt` |
| `granularity` | `timestamp_granularities[]`（word / segment） |
| `diarization` | ❌ drop + warn（Whisper 无说话人分离） |
| `punctuate` | 默认开，无开关 |
| 响应 `text` | `text` |
| 响应 `segments[]` | `segments[]`（id/seek/start/end/text/tokens） |
| 响应 `words[]` | `words[]`（`timestamp_granularities: ["word"]` 时） |
| 响应 `duration_seconds` | `duration` |
| 响应 `confidence` | ❌ drop |
| 流式 | ❌ 无（一次性） |

**`[待验证]`**：`chunking_strategy`（长音频分块）与 `include[]`（如 `logprobs`）的字段；`translations` 端点的额外参数。

**待按需补充简表**：

| 厂商 | 关键差异点 |
|---|---|
| **Deepgram** `listen` | 裸音频 body + query 参数 `encoding`/`sample_rate`/`channels`；`diarize` / `smart_format` / `utterances` / `keywords` / `multichannel`；响应深嵌在 `results.channels[0].alternatives[0]{transcript,confidence,words[]}`，`results.utterances[]` 单独；`metadata.duration` 给时长；**支持 WS 实时（边说边传）与 chunked 一次性** |
| **AssemblyAI** `transcript` | **仅接受 `audio_url`，不能直接传文件** → 网关必须代传（需要一个可公网访问的临时 URL 或网关代理，`[待验证]`）；`speaker_labels` / `speakers_expected` / `auto_chapters` / `sentiment_analysis` / `entity_detection` / `word_boost` / `disfluencies` / `speech_model`；响应 `text` / `words[]` / `utterances[]` / `confidence` / `audio_duration`；流式是 WS v3（`Begin`/`Turn`/`Termination`） |
| **Gemini ASR** | `[待验证]` 是否有原生端点；Part 里有 `audioTranscription` 字段值得关注 |

### 9.3 Image

**完整示例（v1.5 写透）：`openai.images.generations` + `openai.images.edits`**

| canonical | OpenAI Images |
|---|---|
| `prompt` | `prompt` |
| `negative_prompt` | ❌ drop + warn |
| `size` | `size` |
| `aspect_ratio` | ❌ drop |
| `n` | `n` |
| `quality` | `quality` |
| `style` | `style`（dall-e-3） |
| `sampling.*` | ❌ drop |
| `allow_prompt_rewrite` | 隐含（dall-e-3 恒改写） |
| `edit.image` | `image[]`（multipart） |
| `edit.mask` | `mask`（multipart） |
| `edit.strength` | ❌ drop |
| `output.format` | 由端点/model 决定 |
| `output.response_type` | `response_format`（b64_json / url） |
| `output.transparent_background` | gpt-image-1 支持 |
| `moderation` | `moderation` |
| 响应图 | `data[].b64_json` / `url` |
| `revised_prompt` | `data[].revised_prompt` |
| 同步/异步 | 同步 |

**`[待验证]`**：gpt-image-1 的 usage 形状（token-based：`input_tokens` / `output_tokens` / `input_tokens_details.image_tokens` / `total_tokens`）。

**待按需补充简表**：

| 厂商 | 关键差异点 |
|---|---|
| **Stability** | `negative_prompt` / `aspect_ratio` / `style_preset` / `strength`（img2img）/ `cfg_scale` / `steps` / `sampler`；multipart 传 `image` / `mask`；credit 计费（按次）；响应形态 `[待验证]`（二进制还是 base64 JSON） |
| **BFL / FLUX** | `width`/`height`（无 aspect_ratio）/ `steps` / `guidance` / `seed` / `prompt_upsampling` / `safety_tolerance` / `output_format` / `raw`；img2img 用 `image_prompt`（base64 或 url）+ `image_prompt_strength`；**异步轮询**：返回 `{id, polling_url, status}`，图在 `result.sample`；`[待验证]` 是否有同步模式或 webhook |
| **Gemini Imagen** | `[待验证]` 端点与字段（Imagen 系列是否走 generateContent） |

---

## 10. Open Questions

1. **OpenAI `audio/speech` 流式**：是否支持分片返回、如何触发（`stream: true`？独立端点？）。
2. **AssemblyAI 音频上传**：能否直接传文件而非 URL；不能则网关代传方案。
3. **BFL 同步模式**：是否有非轮询的返回方式。
4. **Gemini 的 TTS/ASR/Image**：Gemini 是否有原生 TTS（如 `models/gemini-*-tts`）、原生图像生成（`imagen` 系列是否走 generateContent）、原生 ASR。
5. **各模态 usage 原始字段**：OpenAI Images（gpt-image-1）的 token usage 形状；ElevenLabs 是否返回字符数；Deepgram/AssemblyAI 的时长字段精度。
6. **TTS 按字符计费的字符口径**：是否含 SSML 标签、是否按"请求字符"还是"实际合成字符"计费。
7. **多模态 `n` 参数**：chat 的 `n`（候选数）与 image 的 `n`（张数）同名不同义，是否要在 canonical 里改名（见 [10-canonical-schema.md](./10-canonical-schema.md) §10 Q7）。
8. **声音克隆的合规**：`voice.reference_audio` 涉及个人声纹，是否需要单独的开关与更强的访问控制。
