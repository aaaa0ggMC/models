# 85 · 模态覆盖矩阵（Modality Surface Matrix）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[12-coverage-survey.md](./12-coverage-survey.md)（canonical 覆盖矩阵）、[15-modalities.md](./15-modalities.md)（各模态 canonical 设计）、[40-provider-adaptors.md](./40-provider-adaptors.md) §5（adaptor 覆盖矩阵）、[00-overview.md](./00-overview.md) §4.3（端点形态）

---

## 0. 阅读指引

§1 这张矩阵解决什么问题（与 12 的两张矩阵如何分工）；§2 「模态完成」判据（四件套）+ 硬校验规则；§3 九张模态卡片（每个 `ModalityKind` 一张）；§4 工具端点卡片（search / fetch / ocr 这类**不在** `ModalityKind` 里的面）；§5 缺口清单与优先级；§6 与其他文档的关系。

本文的读者：想回答「模态 X 现在到底能不能用」的人。答案不在任何一张已有矩阵里——canonical 矩阵说「schema 装得下」，adaptor 矩阵说「某家映射写了没写」，都不回答「客户端发一个请求能不能走通、走通之后怎么计费」。

---

## 1. 这张矩阵解决什么问题

### 1.1 三张矩阵的分工

| 矩阵 | 键 | 回答的问题 | 时点 |
|---|---|---|---|
| canonical 覆盖矩阵（12 §1） | 厂商特性 | canonical **装不装得下**这个特性 | 设计期一次穷尽 |
| adaptor 覆盖矩阵（40 §5） | (access_path, model, modality) | 某家的映射**写没写** | 运行期增量 |
| **模态覆盖矩阵（本文）** | **modality** | 这个模态**四件套齐不齐**、能不能端到端用 | 每个 Phase 更新 |

能力矩阵（[45-credentials.md](./45-credentials.md) §6）的键是 `(access_path, model, modality)`，它是**路由**的依据；本文的键是 `modality`，它是**交付**的依据。两者不互相替代：路由要知道 `gpt-image-2.6` 在 `openai.images` 这条路径下支不支持 image 模态，交付要知道 image 模态整体还缺什么。

### 1.2 四列是什么

每个模态的四列，对应「一个请求从进网关到出账」必经的四个面：

1. **canonical payload**——`ir/<modality>.ts` 的类型 + `ir/schema/ag-ir-1/` 的 schema + 夹具。没有它，客户端发什么都不成立。
2. **入站脸（dialect faces）**——HTTP 端点 + 客户端方言 → canonical 的解码。OpenAI / Anthropic / Gemini 各家形状各算一张脸。
3. **provider adaptor**——canonical → 上游 wire 的映射 + 上游响应 → canonical。真实上游或**明确标注的 mock** 都算，但必须在卡片里说清是哪一个。
4. **计量单位**——`usage.units` 用哪个槽、定价表能不能表达。图片按张、TTS 按字符、ASR 按秒、chat 按 token——单位不统一是事实，矩阵把它摆到明面上。

---

## 2. 「模态完成」判据 = 四件套齐全

### 2.1 判据定义

一个模态记为「完成」，当且仅当四件套**同时**满足：

| 件 | 完成的定义 | 验收方式（可执行） |
|---|---|---|
| canonical payload | 类型在 `ir/`、schema 在 `ir/schema/ag-ir-1/`、root schema 按 `kind` 分派、至少一个夹具 | `tests/ir-schema.test.ts`：ajv 校验夹具 + TS↔schema 字段级 parity 全绿 |
| 入站脸 | 至少一个 HTTP 端点能完成「客户端方言 → canonical → 客户端方言」往返 | 该端点的 round-trip 测试；**优先用官方 SDK 打我们的端点**（drop-in 证明，参照 `tests/models-openai-sdk.test.ts` 的姿势） |
| provider adaptor | canonical → 上游 wire 双向映射，带契约测试；mock 必须在卡片与代码注释里标注 | wire 层 round-trip 测试（夹具进 `providers/<provider>/fixtures/`）；真实上游另有 live 冒烟 |
| 计量 | `usage.units` 落到该模态的单位、`UsageRecord` 落账、定价表能表达该单位 | 计量测试断言 `usage.units` 与 `cost`；价格表含对应 slot（`per_image` / `per_10000_characters` / `per_hour` / `per_request` / token 五槽） |

**「未接真实上游」也是一种可交付状态**，但必须同时满足：adaptor 接口已定、wire codec 已按官方文档实现、mock/scripted 传输把链路打通、卡片状态列写明「未接真实上游」。缺任何一条就是「未完成」，不许记成完成。

### 2.2 每种模态的验收方式（差异部分）

| 模态 | 验收要点（四件套之外的特殊项） |
|---|---|
| chat | 四种入站脸各自的往返 + 流式折叠 + usage 双轨（40 §2.2c 四条硬不变量） |
| decision | 批量问题（1→100 题）语义 + 逐题拒答 + `calibration: "degraded"` 降级路径可触发 + 流式请求被拒（25 §1 的 reject 档） |
| embedding | `input` 三种形态（string / string[] / MediaRef[]）+ `dimensions` 截断 + `encoding_format` |
| tts | 输出音频三态 `MediaRef` + 按字符计费口径（CJK 每字 2 这类规则要可对账） |
| asr | 分段/词级时间戳 + interim 的「定位 + 覆盖」语义（25 §5） |
| image | `n` 张数语义 + multipart 入站（edits）+ 按张计费 + token 计费两种定价形态都能表达 |
| rerank / moderation | （[later]，判据同上，动工前再细化） |
| video | 明确非目标（70 §7），只要求占位不改 |

### 2.3 硬校验：新增模态忘了建卡片 → 红灯

规则（写死，不可协商）：

1. `ir/modality.ts` 的 `MODALITY_KINDS` **每个值**都必须在本文有一张 `### 卡片 · <kind>` 卡片；
2. 反过来，本文不允许出现 `MODALITY_KINDS` 里不存在的 kind——卡片漂移（改了类型忘了改文档，或反之）同样红灯；
3. 该断言由 `scripts/check-docs.mjs` 第 5 项检查执行（docs CI 的 structure job 会跑），并由 `tests/docs-check.test.ts` 包一层让 `npm test` 同样能抓住；
4. 新增模态的完整流程：12 §3 规则 F2/F5（加联合成员 → bump `ir_version`）→ **建卡片** → 补四件套 → 更新 §5 缺口清单。卡片是流程的一等步骤，不是事后补的文档。

---

## 3. 模态卡片（9 个 ModalityKind）

图例：**✅ 齐** = 四件套齐全；**⚠️ 缺** = 有缺口（见该行「缺口」）；**❌ 空** = 仅 canonical 占位。「未接真实上游」在 adaptor 列显式标注。

### 3.1 卡片 · chat

| 列 | 内容 |
|---|---|
| canonical payload | `ChatPayload`（[10](./10-canonical-schema.md) §4，v1 最丰富）+ `chat.schema.json` + 6 夹具（basic / multimodal / thinking / tools / unknown-part / responses-features） |
| 入站脸 | `POST /v1/chat/completions`（openai.chat）、`POST /v1/responses`（openai.responses，**期一已落地**）、`POST /v1/messages`（anthropic.messages）、`POST /v1beta/models/{m}:generateContent`（gemini.generateContent） |
| provider adaptor | **已实现**：openai.chat、anthropic.messages（`adaptors/`，含 round-trip 夹具）；openai.responses 的**客户端脸**（`adaptors/openai-responses/`，含 round-trip 夹具，2026-11-16 期一落地）；**planned**：openai.responses 的 DeepSeek provider 脸（期二，`deepseek.openai-responses`，同一 codec + profile，未接真实上游）、gemini.generateContent |
| 计量单位 | `units.tokens`（input / output / cache_read / cache_write / reasoning + `details`），`pricing_state` 表达「输出免费」类差异 |
| 状态 | **✅ 齐**（v1 写透：4 张入站脸 + 3 个 adaptor + token 计量 + 峰谷定价快照） |
| 缺口 / 优先级 | ~~openai.responses 的客户端脸~~ **已交付**（2026-11-16 期一：`adaptors/openai-responses/` codec + `adaptors/index.ts` 注册 + round-trip 夹具；夹具是官方文档样本，**未接真实上游**）；openai.responses 的 DeepSeek provider 脸（**P1**，期二，access path `deepseek.openai-responses`，未接真实上游）；gemini.generateContent 的 provider adaptor（**P1**）；fast path 仅覆盖 chat 且为未来可选优化（**P2**，20 §4） |

### 3.2 卡片 · decision

| 列 | 内容 |
|---|---|
| canonical payload | `DecisionPayload` / `DecisionQuestion` / `DecisionAnswer`（[10](./10-canonical-schema.md) §4.6，含 `calibration` 降级标记）+ `decision.schema.json` + 夹具 |
| 入站脸 | `POST /v1/decisions`（请求/响应体即 canonical 信封的 JSON 序列化，[15](./15-modalities.md) §6.3）；**本线程新增**（`http/decisions-endpoint.ts`） |
| provider adaptor | adaptor 接口 + **mock**（`providers/decision/`，确定性答案、不打网络）；真实上游（gemini.decisions / jev.decisions / openai.decisions，三家字段映射已按官方 API reference 落库，[12](./12-coverage-survey.md) §1.5）**未接，无 key** |
| 计量单位 | `units.tokens` + `units.questions`；`pricing_state.output = "free"`（输入计费、输出免费，三家同形态） |
| 状态 | **✅ 齐**（四件套齐，但真实上游未接）；降级路径已接：路由不到 decision 上游时用 chat + `response_format: json_schema` 模拟，响应标 `calibration: "degraded"`（[40](./40-provider-adaptors.md) §6.3） |
| 缺口 / 优先级 | 真实上游 adaptor 三选一（**P1**）；策略检查与 stop 决策**不允许降级**（拿不到真 decision 就明确失败，15 §6.5） |

### 3.3 卡片 · embedding

| 列 | 内容 |
|---|---|
| canonical payload | `EmbeddingPayload` / `EmbeddingResponsePayload`（[15](./15-modalities.md) §5）+ `embedding.schema.json` + 夹具（**本线程补**：此前只有类型、schema 与实现均为零） |
| 入站脸 | `POST /v1/embeddings`（OpenAI 形状：`model` / `input` / `dimensions` / `encoding_format` / `user`）；**本线程新增** |
| provider adaptor | adaptor 接口 + OpenAI 兼容 wire codec（`providers/openai-embeddings/`）；**DeepSeek 无 embeddings 端点**（已核实，见 §6.2），故上游为 **mock / scripted**，未接真实 |
| 计量单位 | `units.tokens`（prompt_tokens / total_tokens） |
| 状态 | **✅ 齐**（未接真实上游） |
| 缺口 / 优先级 | 真实上游（OpenAI / Gemini / Cohere，**P1**）；Gemini 的 `taskType` 已预留 `native.gemini.task_type`（15 §5） |

### 3.4 卡片 · tts

| 列 | 内容 |
|---|---|
| canonical payload | `TtsPayload` / `TtsResponsePayload`（[15](./15-modalities.md) §2）+ `tts.schema.json`（随 adaptor 落地补）。**工具面** canonical 见 `ir/tool-endpoints.ts` 的 tts 变体（`input` / `voice_id` / `format`）；2026-11 随 MiMo 接入加了三个**可选**增量字段：`format` 联合增 `'mp3'`、`model`（上游 TTS 变体）、`reference_audio` / `voice_design`（克隆与音色设计） |
| 入站脸 | `POST /v1/tools/tts`（DeepSeek，canonical 工具面）+ `POST /v1/tools/mimo/tts`（MiMo，**同款形状不同路径**——`createToolEndpoints` 按 path 建 Map，同路径会被静默 shadow）+ `POST /v1/audio/speech`（OpenAI 形态，`http/audio-endpoint.ts`，2026-11 由音频线程合入 main，**多上游**） |
| provider adaptor | **两家真实上游**：DeepSeek（`providers/deepseek/tts.ts`，key 走 `DEEPSEEK_API_KEY`，输出 wav/pcm）；**MiMo**（`providers/mimo/audio.ts`，key 走 `MIMO_API_KEY`，输出 wav/mp3/pcm，**一个模型族三个变体**：`mimo-v2.5-tts` 预置音色 / `-voiceclone` 音色克隆 / `-voicedesign` 音色设计）。客户端 dialect 编解码各自一份 `audio-openai-face.ts`，经 `http/audio-faces.ts` 的 `AudioProviderFace` 接口按模型名分流，**第一家认领的赢** |
| 计量单位 | `units.characters`（`{input, billed}`）。**两家的加权规则与价格都不同**：DeepSeek CJK 每字 2（`CJK_BILLED_RANGES` 可对账）、¥0.45/万字符；MiMo 价格页无加权规则（网关侧 1 字符 = 1，不替上游定价格）且 TTS 系列**限时免费** → 费率 0 但 `cost.status` 仍是 `priced`（0 元是官方立场，不是"没算钱"）。canonical 的 `TOOL_ENDPOINT_BILLING_UNITS.tts` 因此改成「按字符（各家加权规则见 provider 实现）」；定价槽 `per_10000_characters` |
| 状态 | **✅ 齐**（canonical + 三张入站脸 + 两家 adaptor + 按字符计量；真上游 live 冒烟见 `tests/mimo-live.test.ts` 与 `tests/mimo-audio-http-live.test.ts`） |
| 缺口 / 优先级 | 流式（SSE 信封 / 裸 chunked）与 WS 模式（**P1**，15 §2.3）；第三家 TTS 上游（ElevenLabs / MiniMax，**P2**）；`tts.schema.json` 与模态面夹具仍缺（见 §5.2） |

### 3.5 卡片 · asr

| 列 | 内容 |
|---|---|
| canonical payload | `AsrPayload` / `AsrResponsePayload`（[15](./15-modalities.md) §3）+ `asr.schema.json`（随 adaptor 落地补）。工具面 canonical 见 `ir/tool-endpoints.ts` 的 asr 变体（`audio` + `language` / `prompt`） |
| 入站脸 | `POST /v1/tools/asr`（DeepSeek）+ `POST /v1/tools/mimo/asr`（MiMo，同款形状不同路径）+ `POST /v1/audio/transcriptions`（OpenAI 形态，**multipart**，`http/audio-endpoint.ts`，2026-11 合入 main，**多上游**） |
| provider adaptor | **两家真实上游**：DeepSeek（`providers/deepseek/asr.ts`，multipart 单 `file` 字段，wav/Ogg Opus，≤8 MiB / ≤120s）；**MiMo**（`providers/mimo/audio.ts`，**没有独立 REST 端点**——`/v1/audio/*` 在上游全 404，走 `/v1/chat/completions` 按 `model: mimo-v2.5-asr` 分发，音频走 `input_audio` content part，仅 mp3/wav，`asr_options.language` 只认 auto/zh/en）。`language` 在 MiMo 侧**真的到上游**（DeepSeek 侧到不了），`prompt` 两家都到不了 |
| 计量单位 | `units.audio_seconds`（`{input, billed}`）。DeepSeek 依 `duration_ms`（$0.116/音频小时，限时半价）；MiMo 依 `usage.seconds`（音频时长秒，官方 ¥0.5/音频小时）。定价槽 `per_hour`（通用引擎按秒除 3600）。**两家都有价 → 两家的 ASR 用量记录都是 `priced` 而不是 `unpriced`** |
| 状态 | **✅ 齐**（canonical + 三张入站脸 + 两家 adaptor + 按音频秒计量；真上游 live 冒烟见 `tests/mimo-live.test.ts` 与 `tests/mimo-audio-http-live.test.ts`） |
| 缺口 / 优先级 | 实时 ASR 的 WS 双路径（**P1**，25 §3.3）；`/v1/audio/translations` 明确不支持（**两家**都没有翻译目标参数，`list()` 标 `supported:false`，501 文案列两家的理由）；`asr.schema.json` 与模态面夹具仍缺（见 §5.2） |

### 3.6 卡片 · image

| 列 | 内容 |
|---|---|
| canonical payload | `ImagePayload` / `ImageResponsePayload`（[15](./15-modalities.md) §4）+ `image.schema.json` + 夹具；**本线程加法**：`quality` 增 `"standard"`、新增 `user` / `background` / `output_compression` / 响应 `background`（只加不改，12 §3 规则 F1） |
| 入站脸 | `POST /v1/images/generations`（JSON）与 `POST /v1/images/edits`（**multipart**：`image[]` / `mask` / `prompt` + 参数字段）；**本线程新增**（`http/images-endpoint.ts`）。multipart 解析**复用音频线程的 `http/multipart.ts`**（2026-11 合入 main；图片端点按 25 MiB 图片上限传自定义 limits） |
| provider adaptor | adaptor 接口 + OpenAI Images wire codec（`providers/openai-images/`：generations JSON + edits multipart 编码，按官方 API reference 与 SDK 类型实现）；**未接真实上游（无 key）**，测试用 scripted 传输打通链路 |
| 计量单位 | `units.images`（`{generated, edited}`，定价 slot `per_image`）+ `units.tokens`（gpt-image 系的 token 计费形态：`input_tokens_details.{text,image}_tokens`）——**两种定价形态价格表都能表达**（metering/pricing.ts 的 `NON_TOKEN_SLOT_SCALE`） |
| 状态 | **✅ 齐**（四件套齐；真实上游未接，卡在凭据） |
| 缺口 / 优先级 | 真实上游 key（**P0**，阻塞项是凭据不是代码）；Stability / BFL(FLUX) adaptor（**P2**，含异步轮询形态，15 §4.2）；进度流 `POST /v1/images/generations:stream`（**P2**） |

### 3.7 卡片 · rerank

| 列 | 内容 |
|---|---|
| canonical payload | `RerankPayload` / `RerankResponsePayload`（Cohere 形状，12 §1.4） |
| 入站脸 | ❌ 无 |
| provider adaptor | ❌ 无（Cohere 映射差异已在 12 §1.4 登记） |
| 计量单位 | 预留 `units.tokens` / `units.requests` |
| 状态 | **❌ 空**（仅 canonical，[later]） |
| 缺口 / 优先级 | 四件套全缺（**P2**） |

### 3.8 卡片 · moderation

| 列 | 内容 |
|---|---|
| canonical payload | `ModerationPayload` / `ModerationResponsePayload`（OpenAI moderations 形状） |
| 入站脸 | ❌ 无 |
| provider adaptor | ❌ 无 |
| 计量单位 | 预留 `units.requests` |
| 状态 | **❌ 空**（仅 canonical，[later]） |
| 缺口 / 优先级 | 四件套全缺（**P2**）；注意与 image 的 `moderation` 参数不是一回事（那是 image 请求内的审核强度） |

### 3.9 卡片 · video

| 列 | 内容 |
|---|---|
| canonical payload | `VideoPayload` / `VideoResponsePayload`（**空占位 + raw**，12 §2 明确「仅占位，明确不做」） |
| 入站脸 | ❌ 无 |
| provider adaptor | ❌ 无 |
| 计量单位 | 无 |
| 状态 | **❌ 空**（占位，明确非目标，70 §7） |
| 缺口 / 优先级 | 不做（**P2/非目标**） |

---

## 4. 工具端点卡片（`ModalityKind` 之外的面）

### 4.1 分类缺口：search / fetch / ocr 为什么不是模态

`ModalityKind` 的九个值描述的是**请求的数据形态与任务类型**（输入输出是什么形态的媒体、做什么变换）。DeepSeek 全家桶的 search / fetch / ocr 不改变内容的模态形态——输入输出都是文本或文档——它们是**网关代办的一次性能力操作**，因此登记在 `ir/tool-endpoints.ts` 的 `ToolEndpointId`（五个端点）而不是 `ModalityKind`。

这是**有意的分类**，不是遗漏：把它们塞进 `ModalityKind` 会让「模态」这个概念同时承担「数据形态」和「工具操作」两种语义，能力矩阵与计费口径都会随之分裂。代价是矩阵必须为它们单开一节（本节），且 `asr` / `tts` **两边都在**——模态面（`AsrPayload` / `TtsPayload`，服务多上游 dialect）+ 工具面（DeepSeek 专有 wire，服务全家桶账号）。本矩阵两处都收，避免「在模态卡片里找不到 DeepSeek TTS」。

### 4.2 卡片 · 工具端点（search / fetch / ocr / asr / tts）

| 列 | 内容 |
|---|---|
| canonical payload | `CanonicalToolRequest` / `CanonicalToolResponse`（判别联合，`ir/tool-endpoints.ts`）+ `tools.schema.json` |
| 入站脸 | `POST /v1/tools/search`、`/v1/tools/fetch`、`/v1/tools/ocr`、`/v1/tools/asr`、`/v1/tools/tts`（`http/tools-endpoint.ts`，数据面鉴权 + 每次调用落账） |
| provider adaptor | DeepSeek 五个 wire codec + 薄客户端（`providers/deepseek/`）+ canonical↔wire 装配（`providers/deepseek/tool-handlers.ts`），**真实上游**，key 走 `DEEPSEEK_API_KEY`；**MiMo 的 asr / tts 两个**（`providers/mimo/audio.ts` + `providers/mimo/tool-handlers.ts`，真实上游，key 走 `MIMO_API_KEY`）——2026-11 接入，路径带 `/mimo/` 前缀避免与 DeepSeek 的同名端点相撞 |
| 计量单位 | search / fetch：`units.requests`（按次，仅成功计费）；ocr：`units.requests`（按页）；asr：`units.audio_seconds`；tts：`units.characters`（口径表 `TOOL_ENDPOINT_BILLING_UNITS`，**加权规则按 provider**，见 §3.4） |
| 状态 | **✅ 齐**（四件套齐，两家真实上游） |
| 缺口 / 优先级 | 这七个端点**不走 S0–S10**（与 [00](./00-overview.md) §4.3「所有端点共用同一套 pipeline 阶段」的偏差是有意的：它们不是「帮我调一次模型」，见 `http/tools-endpoint.ts` 文件头）——若将来要并轨，见 §5 的 P1 项 |

---

## 5. 缺口清单与优先级

### 5.1 P0（阻塞仓库主人定的原始范围）

| 缺口 | 模态 | 现状 | 下一步 |
|---|---|---|---|
| 真实图片上游 | image | adaptor 接口 + wire codec + mock 链路已就绪；**卡在无 key** | 拿到任一上游 key（OpenAI Images 文档最全）后接上，跑 live 冒烟 |
| ~~OpenAI 形态 TTS 入站脸~~ | tts | **已交付**（音频线程 2026-11 合入 main：`POST /v1/audio/speech`） | — |
| ~~OpenAI 形态 ASR 入站脸~~ | asr | **已交付**（同批：`POST /v1/audio/transcriptions`，multipart） | — |

### 5.2 P1（当前 Phase 应交付）

| 缺口 | 模态 | 说明 |
|---|---|---|
| decision 真实上游 adaptor | decision | gemini.decisions / jev.decisions / openai.decisions 三选一；三家字段映射已在 12 §1.5 落库，接口已定 |
| embedding 真实上游 | embedding | OpenAI / Gemini / Cohere；wire 已按 OpenAI 兼容形状实现 |
| ~~openai.responses 客户端脸（A）~~ | chat | **已交付**（2026-11-16 期一：`adaptors/openai-responses/` codec 落地 + `adaptors/index.ts` 注册 + `tests/models-openai-sdk.test.ts` 的 SDK drop-in 用例；非流式往返 / 流式折叠 / 工具循环全绿，夹具在 `adaptors/fixtures/openai-responses/from-docs/`——官方文档样本，**未接真实上游**。流式的 live 冒烟待 B 期 + 有效 DeepSeek key） |
| openai.responses 的 DeepSeek provider 脸（B） | chat | 复用同一个 `openai.responses` codec + 新增 `deepseek.openai-responses` access path；丢弃表与六处同步清单见 [42-openai-responses-access.md](./42-openai-responses-access.md) §4.8 / §5.4；**未接真实上游**（无 key），live 冒烟待 key |
| gemini.generateContent adaptor | chat | 入站脸已有、provider adaptor 缺（40 §5 标 planned） |
| 模态端点接入 S0–S10 pipeline | image / embedding / decision | 当前与工具面同构（注入端口，不过 pipeline）；接入后 fast path 对这些模态保持关闭（20 §4 的触发条件不满足） |
| tts / asr 的**模态面**补齐 | tts / asr | 音频的 OpenAI 入站脸走的是**工具面 canonical**（`CanonicalToolRequest`，access path `<provider>.tools.tts/asr`），不是 `TtsPayload` / `AsrPayload` 模态面——于是 `tts.schema.json` / `asr.schema.json` 与「多上游 dialect」的模态入站脸仍缺。2026-11 接 MiMo 时**没有**改走模态面，而是在工具面 canonical 上加了三个可选增量字段（`format` 增 `'mp3'`、`model`、`reference_audio` / `voice_design`）容纳第二家上游——这是当时的最小增量，不是最终形态；要接第三家（或让音频请求过 S0–S10）仍应补模态面 |
| tts / asr 的 schema 文件 | tts / asr | `ir/schema/ag-ir-1/` 里仍没有 `tts.schema.json` / `asr.schema.json`（root.schema.json 的分派注释已声明「随 adaptor 落地时补」）；夹具也没有——canonical 覆盖矩阵（12 §2）登记的 TTS/ASR 特性目前**没有** schema 层 round-trip 用例兜底（12 §3 规则 F6 要求「没有 adaptor 实现它也要有这条用例」） |

### 5.3 P2（按需 / 后续）

| 缺口 | 模态 | 说明 |
|---|---|---|
| rerank / moderation 四件套 | rerank / moderation | [later]，动工前走 40 §1.6 检查清单 |
| Stability / BFL(FLUX) adaptor | image | 含异步轮询形态（`ImageResponsePayload.polling`，15 §4.2） |
| image 进度流 | image | `POST /v1/images/generations:stream`（15 §8.1） |
| TTS / ASR 流式与实时 | tts / asr | SSE / chunked / WS 双路径（25 §3） |
| video | video | 非目标（70 §7） |

---

## 6. 与其他文档的关系

### 6.1 本文不改什么

本文是**运行面矩阵**，不重新定义 canonical（那在 [10](./10-canonical-schema.md) 与 [15](./15-modalities.md)），不重新定义 adaptor 三态（那在 [40](./40-provider-adaptors.md) §5），不定义路由用的能力矩阵（那在 [45](./45-credentials.md) §6）。本文只做一件事：把四件套的齐/缺摆到一张表里，并用脚本保证它不腐烂。

### 6.2 调研结论（本矩阵引用的上游能力事实）

| 问题 | 结论 | 来源 |
|---|---|---|
| DeepSeek 有图片生成 API 吗 | **没有**。官方 API reference 的全部端点为：Chat Completions / Responses / Messages / FIM / Lists Models / Get User Balance / Files(CRUD) / Tools(Search, Fetch, OCR, TTS, ASR)；价格页只有 chat token、搜索/抓取按次、OCR 按页、TTS 按字符、ASR 按音频小时五项，**无图片生成、无 embedding** | <https://api-docs.deepseek.com/api/create-chat-completion>（端点清单）、<https://api-docs.deepseek.com/quick_start/pricing>（价格页，2026-11-14 核对） |
| DeepSeek 的 Responses API 是什么形状 | **有，且是 OpenAI Responses 的子集**（不是超集）。`POST /responses`（`base_url` 无 `/v1`），`deepseek-flash` 与 `deepseek-v4-pro` 均支持，2026-07-31 起上线。无状态（不存 response / conversation，`store` 恒 `false`）；流式是语义 SSE 事件、终事件 `response.completed` / `.incomplete` / `.failed`、**无 `data: [DONE]`**；usage 五槽 + `server_tool_use` 按次。18 个顶层参数不产生效果（14 `Not supported` + 2 `Ignored` + 2 `accepted but no effect`），且**不支持的参数被官方静默忽略** | <https://api-docs.deepseek.com/api/create-response>、<https://api-docs.deepseek.com/guides/responses_api>、<https://api-docs.deepseek.com/updates>、<https://api-docs.deepseek.com/quick_start/pricing>（2026-11-16 核对）；逐参数丢弃表与 6 条 live 阻塞项见 [42-openai-responses-access.md](./42-openai-responses-access.md) §4.8 / §2.3 |
| OpenAI Images 的形态 | `POST /v1/images/generations`（JSON：`prompt`/`model`/`n`/`size`/`quality`/`style`/`background`/`output_format`/`output_compression`/`moderation`/`response_format`/`user`）与 `POST /v1/images/edits`（multipart：`image[]`/`mask`/`prompt` + 同款参数）；响应 `{created, data:[{b64_json｜url, revised_prompt}], usage:{input_tokens,output_tokens,total_tokens,input_tokens_details:{text_tokens,image_tokens}}}` | openai SDK v4 类型定义（`node_modules/openai/resources/images.d.ts`）；官方 reference <https://developers.openai.com/api/reference/> |
| OpenAI Images 的计费形态 | 新一代 gpt-image 系**按 token 计费**（image 模态 input/output 各自单价）；旧 dall-e 系按张。两种形态本仓库的价格引擎都能表达（token 五槽 / `per_image`） | <https://developers.openai.com/api/docs/pricing>（2026-11-14 检索快照，具体数值待接上游时复核） |
| embedding 上游 | DeepSeek 无 embeddings 端点（同上）；OpenAI `POST /v1/embeddings`（`input`/`dimensions`/`encoding_format`/`user`，usage 为 `prompt_tokens`/`total_tokens`）是事实标准形状，多数第三方网关同形状 | <https://api-docs.deepseek.com/api/create-chat-completion>；openai SDK `resources/embeddings.d.ts` |
| decision 上游 | Gemini Decisions（`gemini-decision-1`，v1beta）/ Jev（`jev-1.14.0`）/ OpenAI Decisions（`gpt-6-luna`）三家公开形态与字段级差异 | [12](./12-coverage-survey.md) §1.5（已按三家官方 API reference 回填） |
| MiMo 的音频端点形状 | **没有独立 REST 路径**。`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/tts`、`/v1/asr`、`/v1/speech`、`/v1/audio/*` 等 20+ 个路径 GET/POST 全 404（`GET /v1/chat/completions` 返 405，说明路由存在只收 POST）。TTS/ASR 都走 `POST /v1/chat/completions` 按 `model` 分发：ASR 用 `input_audio` content part + `asr_options.language`；TTS 用 `audio:{format,voice}` + assistant 消息作合成文本，响应音频在 `choices[0].message.audio.data`（base64） | <https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition-post>、<https://mimo.mi.com/docs/zh-CN/api/audio/tts-post>；仓库内逐条 curl 实测见仓库根的 `MIMO-INTEGRATION-REPORT.md` §3（2026-11-16；docs CI 只扫 `docs/`，故此处不做链接） |
| MiMo 的 `/v1/models` 元数据 | 只返回 `id` / `object` / `owned_by`——**没有** context_window / max_output_tokens / modalities / effort。能力矩阵里这些字段因此留空（不编造），discovery 也只补登模型 id | 同上（实测 6 个模型：2 LLM + 1 ASR + 3 TTS 变体） |
| MiMo 的计费渠道与费率 | 钱分两个**不互通**的渠道（官方按量计费页明文）：Token Plan 套餐（key 前缀 `tp-`，订阅，查 `GET {token-plan-cn host}/v1/platform/token_plan` 拿积分余量）与按量计费（key 前缀 `sk-`，现金，查 `GET {api host}/v1/platform/balance`）。国内 CNY 实时推理价：pro ¥0.025/¥3.00/¥6.00、flash ¥0.02/¥1.00/¥2.00（命中缓存/未命中/输出，每百万 token）；ASR ¥0.5/音频小时；TTS 三变体限时免费（记 0 但 status=priced）。批量推理价未落库（请求模式而非时段窗口，entry 表达不了并发两种模式）。判据是 **key 前缀**（官方文档明文），实现见 credentials/resolver.ts 的 `BILLING_MODE_BY_KEY_PREFIX` | <https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go>；逐格核对与 live 实测见仓库根 `MIMO-INTEGRATION-REPORT.md` 的计费附篇 |
| MiMo 的 base URL 与版本路径 | Token Plan 专用 host `token-plan-cn.xiaomimimo.com`（官方文档另写 `api.xiaomimimo.com`，本仓库的 key 是 Token Plan key，只实测了前者）。**版本路径 `/v1` 属于端点不属于 base**：transport 用 `new URL(path, base_url)` 拼地址，base 带路径时会被绝对路径整段替换掉 | credentials/resolver.ts 的 `DEFAULT_BASE_URL_BY_ACCESS_PATH` + providers/mimo/profile.ts 的 `endpointPath` |

### 6.3 待文档更新（不由本线程改，走 PR）

1. [00-overview.md](./00-overview.md) §4.3 的端点表要补 `/v1/images/generations`、`/v1/images/edits`、`/v1/embeddings`、`/v1/decisions`（本文落地前它们只在 [15](./15-modalities.md) §8.1 有形态描述）。
2. ~~[10-canonical-schema.md](./10-canonical-schema.md) §2.1 的 `FormatId` 清单要补 `openai.embeddings`~~——**代码已加**（`ir/format.ts`，2026-11 随 embedding 入站脸落地，同批还加了 `mock.decisions`）；文档侧同步仍走 PR。
3. [15-modalities.md](./15-modalities.md) §4.1 的 `ImagePayload` 要同步本线程的加法字段（`quality` 增 `standard`、`user` / `background` / `output_compression` / 响应 `background`）。
4. [40-provider-adaptors.md](./40-provider-adaptors.md) §5 的 adaptor 覆盖矩阵要把 image / embedding / decision 三行从 planned 改成本文 §3 的实际状态（含「未接真实上游」标注）。
5. ~~[12-coverage-survey.md](./12-coverage-survey.md) §5 可关一条：「OpenAI Images（gpt-image-1）的 token usage 形状」~~——SDK 类型已确认（`input_tokens_details.{text,image}_tokens`），本线程按此实现；关闭该 Q 的文档动作走 PR。
6. `ir/format.ts` 文件头里「10 §2.1 格式清单待补五个 `deepseek.tools.*` id」的既有待办仍在（本次新加了 `openai.embeddings` 与 `mock.decisions`，同一处待办一并覆盖）。
7. 音频线程合入 main 后（`/v1/audio/speech`、`/v1/audio/transcriptions` + `http/multipart.ts`），本文 §3.4 / §3.5 与 §5.1 已同步；`http/multipart.ts` 自此有两个消费方（音频 ASR 与图片 edits），其 limits 契约（`max_parts` / `max_file_bytes`）若改动要同时看这两侧。
8. MiMo 接入（2026-11）后：[00-overview.md](./00-overview.md) §4.2 的模块表要补 `providers/mimo/`（与 `providers/deepseek/` 并列的那一行仍在待办里）；[40-provider-adaptors.md](./40-provider-adaptors.md) §5 的 adaptor 覆盖矩阵要加 MiMo 的 openai.chat 行（**planned 都没有——它是真实现了的**，缺的只是文档同步）；`ir/format.ts` 文件头的「待补五个 `deepseek.tools.*` id」待办要扩到 `mimo.tools.*` 两个 id。
