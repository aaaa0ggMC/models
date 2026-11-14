# 12 · Canonical 覆盖普查（Coverage Survey）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)
> 下游被引用于：[40-provider-adaptors.md](./40-provider-adaptors.md)（adaptor 矩阵与之分离）

---

## 0. 这份文档解决什么问题

它维护**两张不同的矩阵**，职责与目标正好相反：

| 矩阵 | 目标 | 时点 | 文档 |
|---|---|---|---|
| **canonical 覆盖矩阵** | **全覆盖**。把主流厂商各模态特性并集全部纳入 canonical，**包括我们永远不实现的** | 设计期一次性穷尽普查 | **本文** |
| **adaptor 覆盖矩阵** | **按需**。某特性是否已被某个 adaptor 实现，分已实现/计划/按需三态 | 运行期增量 | [40-provider-adaptors.md](./40-provider-adaptors.md) §5 |

**核心承诺**：canonical 的边界画在"主流厂商已公开表达的特性并集"上。因此**新增 adaptor 时永远不需要改 schema**——adaptor 只是把"canonical 已能表达的特性"翻成某家 wire 格式。

反过来，**任何"厂商有办法实现、但 canonical 装不下"的情况都是缺陷**，必须走 §5 的扩 schema 流程修掉。

---

## 1. Canonical 覆盖矩阵（chat 与 decision 模态）

图例：✅ canonical 已表达（含字段位置）；⚠️ 已表达但不完整（见备注）；❌ 未表达（**这是缺陷，要走 §5 流程**）。

### 1.1 OpenAI

| 特性 | Chat Completions | Responses | canonical 落点 | 状态 |
|---|---|---|---|---|
| 消息与角色 | `messages[].role`（system/user/assistant/tool/developer） | `input` items | `CanonicalMessage.role` + `system[]` | ✅ |
| 多内容 parts | `content` string \| parts[] | `content[]` | `Part` 联合 | ✅ |
| 图片输入 | `image_url`（url / data URL / detail） | `input_image` | `ImagePart.source: MediaRef` + `role:"input"` | ✅ |
| 文件输入 | ❌（无） | `input_file` | `DocumentPart` | ✅（canonical 是超集，Chat 侧用不上） |
| 音频输入 | `input_audio` | `input_audio` | `AudioPart` | ✅ |
| 视频输入 | ❌（无） | ❌（无） | `VideoPart` | ✅ |
| 工具调用 | `tools[].function` + `tool_calls[]` | `function` tool + `function_call` item | `FunctionTool` + `ToolUsePart` | ✅ |
| 工具选择 | `tool_choice`（auto/required/none/{function}） | 同 + `{type:"hosted_tool"}` | `ToolChoice` | ✅ |
| 并行工具 | `parallel_tool_calls` | `parallel_tool_calls` | `ChatParams` + `[待验证]` 跨格式映射 | ⚠️ |
| 严格 schema | `function.strict` | `parameters.strict` | `FunctionTool.strict` | ✅ |
| 结构化输出 | `response_format`（json_object/json_schema） | `text.format` | `ResponseFormat` | ✅ |
| 推理控制 | `reasoning_effort` | `reasoning.effort` | `ThinkingConfig.effort` | ✅ |
| 推理回传 | ❌ | `reasoning` item（含 encrypted content） | `ThinkingPart` + `RedactedThinkingPart` | ⚠️ 回传规则 [待验证] |
| 推理摘要 | ❌ | `reasoning.summary` | `ThinkingConfig.include_summary` | ✅ |
| 内置 web_search | ❌ | `tools[].type:"web_search"` | `BuiltinTool{name:"web_search"}` | ✅ |
| 内置 file_search | ❌ | `tools[].type:"file_search"` | `BuiltinTool{name:"file_search"}` | ✅ |
| 内置 code_interpreter | ❌ | `tools[].type:"code_interpreter"` | `BuiltinTool{name:"code_interpreter"}` | ✅ |
| 内置 computer_use | ❌ | `tools[].type:"computer_use"` | `BuiltinTool{name:"computer_use"}` + `[待验证]` 配置字段 | ⚠️ |
| 内置 MCP | ❌ | `tools[].type:"mcp"` | `BuiltinTool` + `native.openai.*` | ⚠️ |
| 图像生成 | Images API | `tools[].type:"image_generation"` | `ImagePayload` / `BuiltinTool` | ✅ |
| Prompt caching | 自动（≥1024 tokens）；GPT-5.6+ 显式 `prompt_cache_breakpoint` + `prompt_cache_options{mode,ttl}` | 同 | `CacheControl{type:"ephemeral", ttl, cache_name}` | ⚠️ OpenAI 侧无块级断点，canonical 建模为"可选断点"，映射时可能 drop |
| 缓存 key | `prompt_cache_key` | `prompt_cache_key` | `native.openai.prompt_cache_key` | ✅ |
| 预测输出 | `prediction` | ❌ | `ChatParams` + `usage.details.accepted/rejected_prediction_tokens` | ⚠️ |
| logprobs | `logprobs` / `top_logprobs` | `top_logprobs` | `ChatParams.logprobs/top_logprobs` | ✅ |
| 服务档 | `service_tier` | `service_tier` | `ChatParams.service_tier` | ✅ |
| 元数据 | `metadata`（≤16 kv）/ `user` | `metadata` / `user` | `ChatParams.metadata/user` | ✅ |
| 种子 | `seed` | `seed` | `ChatParams.seed` | ✅ |
| n 候选 | `n` | ❌ | `ChatParams.n` | ✅ |
| 停止序列 | `stop` | ❌ | `ChatParams.stop` | ✅ |
| 惩罚项 | `frequency_penalty`/`presence_penalty` | ❌ | `ChatParams` | ✅ |
| 温度/top_p/top_k | `temperature`/`top_p` | 同 | `ChatParams` | ✅ |
| 最大输出 | `max_completion_tokens`（新）/`max_tokens`（旧） | `max_output_tokens` | `ChatParams.max_output_tokens` | ✅ |
| 流式 | `stream` + `stream_options.include_usage` | `stream` + 语义事件 | `StreamOptions` | ✅ |
| 状态续接 | ❌ | `previous_response_id` + `store` | `native.openai.*`（网关默认不依赖） | ⚠️ |
| TTS | `POST /v1/audio/speech` | — | `TtsPayload` | ✅ |
| ASR | `POST /v1/audio/transcriptions` / `translations` | — | `AsrPayload` | ✅ |
| Embeddings | `POST /v1/embeddings`（dimensions/encoding_format） | — | `EmbeddingPayload` | ✅ |
| Moderations | `POST /v1/moderations` | — | `ModerationPayload` | ✅ |
| Images | `POST /v1/images/generations` / `edits` | — | `ImagePayload` | ✅ |
| usage 细分 | `prompt_tokens_details{cached_tokens, audio_tokens}` / `completion_tokens_details{reasoning_tokens, audio_tokens, accepted/rejected_prediction_tokens}` | `input_tokens_details{cached_tokens}` / `output_tokens_details{reasoning_tokens}` | `TokenUsage.details` + `raw` | ✅ |

### 1.2 Anthropic

| 特性 | 字段 | canonical 落点 | 状态 |
|---|---|---|---|
| system 提示 | 顶层 `system`（string \| blocks[]，blocks 可带 `cache_control`） | `SystemBlock[]` | ✅ |
| 多 system 块 | `system[]` 数组 | `SystemBlock[]` | ✅（v1 有测试，针对已知缺陷） |
| 消息 parts | `text` / `image` / `tool_use` / `tool_result` / `thinking` / `redacted_thinking` / `document` / `search_result` | `Part` 联合 | ✅ |
| PDF / 文档输入 | `document` block（base64 / url / file_id / text） | `DocumentPart` | ✅ |
| URL 图片 | `image.source.type:"url"` | `MediaRef{kind:"uri"}` | ✅ |
| 文件引用 | `source.type:"file"` | `MediaRef{kind:"asset", asset_id}` | ✅ |
| 工具定义 | `tools[].name/description/input_schema` | `FunctionTool` | ✅ |
| 工具缓存断点 | `tools[].cache_control` | `FunctionTool.cache_control` | ✅ |
| 工具选择 | `tool_choice`（auto/any/tool/none） | `ToolChoice` | ✅ |
| 禁用并行工具 | `tool_choice.disable_parallel_tool_use` | `native.anthropic.disable_parallel_tool_use` | ⚠️ 无通用对应 |
| 内置 web_search | `tools[].type:"web_search_*"` | `BuiltinTool{name:"web_search"}` | ✅ |
| 内置 bash / text_editor / code_execution | `tools[].type:"bash_*"` 等 | `BuiltinTool` + `native.anthropic.*` | ⚠️ |
| computer use | `tools[].type:"computer_*"` | `BuiltinTool{name:"computer_use"}` | ⚠️ 配置字段 [待验证] |
| 扩展思考 | `thinking{type:"enabled", budget_tokens}` | `ThinkingConfig` | ✅ |
| 思考签名 | `thinking.signature` | `ThinkingPart.signature` | ✅ |
| 加密思考 | `redacted_thinking.data` | `RedactedThinkingPart` | ✅ |
| 思考自适应 | `thinking.type:"adaptive"` | `ThinkingConfig.effort` + `native` | ⚠️ |
| 缓存控制 | 块级 `cache_control{type:"ephemeral", ttl:"5m"\|"1h"}`，≤4 breakpoint | `CacheControl` | ✅ |
| 缓存 TTL | `cache_control.ttl` | `CacheControl.ttl` | ✅ |
| 容器复用 | `container` | `native.anthropic.container` | ⚠️ |
| 上下文管理 | `context_management`（context editing / memory tool） | `native.anthropic.context_management` | ⚠️ 与插件职责重叠，见 [30-plugin-api.md](./30-plugin-api.md) |
| 输出配置 | `output_config.effort`（mid-conversation effort update） | `ThinkingConfig.effort`（消息级指令） | ⚠️ canonical 需支持"任意位置的努力度更新" |
| stop reasons | `stop_sequence` / `pause_turn` / `refusal` / `tool_use` / `max_tokens` / `end_turn` | `NormalizedFinishReason` | ✅ |
| 元数据 | `metadata.user_id` | `ChatParams.user` | ✅ |
| 温度/top_p/top_k/stop | `temperature`/`top_p`/`top_k`/`stop_sequences` | `ChatParams` | ✅ |
| 最大输出 | `max_tokens`（**必填**） | `ChatParams.max_output_tokens` | ✅ |
| 流式 | `stream` + 事件序列（message_start/content_block_*/message_delta/message_stop/ping） | `StreamOptions` + 流式折叠表 | ✅ |
| usage | `input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens` | `TokenUsage` | ✅ |
| cache 细分 | `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` | `TokenUsage.details` | ⚠️ [待验证] 是否分字段返回 |
| 服务端工具结果 | `web_search_tool_result` 等 block | `SearchResultPart` + `Part` 扩展 | ✅ |
| caller 元数据 | `tool_use.caller` | `native.anthropic.caller` | ⚠️ |
| files / batches | Files API / Message Batches API | `MediaRef{kind:"asset"}` + `native` | ⚠️ 异步批处理建模 [待验证] |

### 1.3 Gemini

| 特性 | 字段 | canonical 落点 | 状态 |
|---|---|---|---|
| 内容 | `contents[].role`（user/model）+ `parts[]` | `CanonicalMessage` + `Part` | ✅ |
| 系统指令 | `systemInstruction.parts` | `SystemBlock[]` | ✅ |
| 文本 part | `parts[].text` | `TextPart` | ✅ |
| 图片 part | `inlineData{mimeType,data}` / `fileData{fileUri,mimeType}` | `ImagePart.source` | ✅ |
| 音频 part | `inlineData`（audio mime） | `AudioPart` | ✅ |
| 视频 part | `inlineData`（video mime）/ `fileData` | `VideoPart` | ✅ |
| 函数调用 | `functionCall{name,args}`（**无 id**） | `ToolUsePart`（id 由网关合成） | ✅ |
| 函数响应 | `functionResponse{name,response}` | `ToolResultPart` | ✅ |
| 思考 part | `parts[].thought: true` | `ThinkingPart` | ✅ |
| 思考签名 | `thoughtSignature` | `ThinkingPart.signature` | ⚠️ 字段名 [待验证] |
| 工具定义 | `tools[].functionDeclarations[]` | `FunctionTool` | ✅ |
| 工具配置 | `toolConfig.functionCallingConfig{mode,allowedFunctionNames}` | `ToolChoice` | ✅ |
| 内置 Google Search | `tools[].googleSearch{}` / `googleSearchRetrieval{dynamicRetrievalConfig}` | `BuiltinTool{name:"web_search"}` | ⚠️ `googleSearchRetrieval` 疑已废弃 [待验证] |
| URL context | `tools[].urlContext{}` | `BuiltinTool{name:"url_context"}` | ✅ |
| 代码执行 | `tools[].codeExecution{}` | `BuiltinTool{name:"code_interpreter"}` | ✅ |
| 生成配置 | `generationConfig{temperature,topP,topK,maxOutputTokens,stopSequences,candidateCount,seed,responseMimeType,responseSchema}` | `ChatParams` + `ResponseFormat` | ✅ |
| 思考配置 | `generationConfig.thinkingConfig{thinkingBudget,includeThoughts}` | `ThinkingConfig` | ✅ |
| 思考档位 | `thinkingLevel`（Gemini 3+） | `ThinkingConfig.effort` | ✅ |
| 安全设置 | `safetySettings[]` | `SafetySetting[]` | ✅ |
| 缓存内容 | `cachedContents[]` + `cachedContentTokenCount` | `CacheControl.cache_name` | ✅ |
| 缓存不可变 system | "cached Gemini content treats systemInstruction as immutable" | `SystemBlock` + `[待验证]` 网关是否需拆 dynamic tail | ⚠️ |
| grounding 元数据 | `groundingMetadata{groundingChunks,webSearchQueries,groundingSupports}` | `SearchResultPart[]` + `raw.grounding` | ✅ |
| finishReason | `STOP`/`MAX_TOKENS`/`SAFETY`/`RECITATION`/`OTHER`/`BLOCKLIST`… | `NormalizedFinishReason` | ✅ |
| usage | `usageMetadata{promptTokenCount,candidatesTokenCount,totalTokenCount,thoughtsTokenCount,cachedContentTokenCount,toolUsePromptTokenCount}` | `TokenUsage` | ⚠️ `toolUsePromptTokenCount` 归属 [待验证] |
| 流式 | `streamGenerateContent?alt=sse` | `StreamOptions` | ✅ |
| Live API | 实时音视频双向流 | `StreamFrame` + WS 双路径 | ⚠️ 建模见 [25-streaming.md](./25-streaming.md) §3.3 |
| TTS | `models/gemini-*-tts` [待验证] | `TtsPayload` | ⚠️ |
| Imagen / 图像生成 | Imagen 系列端点 | `ImagePayload` | ⚠️ |
| Embedding | `embedContent` / `batchEmbedContents` + `taskType` | `EmbeddingPayload` + `native.gemini.task_type` | ✅ |
| ASR | [待验证] | `AsrPayload` | ⚠️ |

### 1.4 其他厂商（按需，但 canonical 已表达）

| 厂商 | 特性 | canonical 落点 | 状态 |
|---|---|---|---|
| **ElevenLabs** | TTS `voice_settings{stability,similarity_boost,style,use_speaker_boost}` | `VoiceSpec.settings` | ✅ |
| | `output_format`（mp3_44100_128 等编码式） | `AudioOutputSpec` | ✅ |
| | `language_code` / `seed` / `previous_text`/`next_text` | `language` / `ProsodySpec.seed` / `ProsodySpec.context` | ✅ |
| | 声音克隆参考音频 | `VoiceSpec.reference_audio` | ✅ |
| | 发音词典 | `ProsodySpec.pronunciation_dict` | ✅ |
| **MiniMax** | `voice_setting{voice_id,speed,vol,pitch}` | `VoiceSpec` + `ProsodySpec` | ✅ |
| | `audio_setting{sample_rate,bitrate,format,channel}` | `AudioOutputSpec` | ✅ |
| | `language_boost` / `timber_weights` / `pronunciation_dict` | `language` / `native` / `ProsodySpec.pronunciation_dict` | ✅ |
| **Azure** | SSML `<speak><voice><prosody>` | `ProsodySpec.ssml`（逃生舱） | ✅ |
| | `X-Microsoft-OutputFormat` | `AudioOutputSpec` | ✅ |
| **Google Cloud TTS** | `audioConfig{audioEncoding,speakingRate,pitch,volumeGain,sampleRateHertz,effectsProfileId}` | `AudioOutputSpec` + `ProsodySpec` | ✅ |
| | `voice{languageCode,name,ssmlGender}` | `VoiceSpec` | ✅ |
| | SSML input | `ProsodySpec.ssml` | ✅ |
| **OpenAI ASR** | `timestamp_granularities[]` / `chunking_strategy` / `include[]` | `AsrPayload.granularity` + `native` | ✅ |
| **Deepgram** | `diarize` / `smart_format` / `utterances` / `keywords` / `encoding`/`sample_rate`/`channels` | `AsrPayload` + `native` | ✅ |
| **AssemblyAI** | `speaker_labels` / `speakers_expected` / `auto_chapters` / `sentiment_analysis` / `entity_detection` / `word_boost` / `disfluencies` | `AsrPayload.diarization` + `native` | ✅ |
| | `speech_model` / `webhook_url` | `native` | ✅ |
| **Stability** | `negative_prompt` / `aspect_ratio` / `style_preset` / `strength` / `cfg_scale` / `steps` / `sampler` | `ImagePayload` | ✅ |
| **BFL / FLUX** | `prompt_upsampling` / `safety_tolerance` / `image_prompt` / `image_prompt_strength` / 异步轮询 | `ImagePayload` + `ImageResponsePayload.polling` | ✅ |
| **Mistral** | `safe_prompt` / `random_seed` / `response_format` | `ChatParams` + `native.mistral.*` | ✅ |
| **Cohere** | rerank（`documents`/`top_n`/`return_documents`）/ embed（`input_type`/`embedding_types`） | `RerankPayload` + `EmbeddingPayload` + `native.cohere.*` | ✅ |
| **Bedrock** | SigV4 / `guardrailConfig` / `additionalModelRequestFields` / inference profile | `native.bedrock.*` + transport 层 | ✅ |
| **Vertex** | OAuth / `labels` / `groundingConfig` / endpoint region | `native.vertex.*` + transport 层 | ✅ |

---

### 1.5 decision 模态（判断模型）`[v1.5]`

> 这是第五个模态。已确认三家：**Google Gemini Decisions API**（Gemini Decision 1）、**Jev**（TypeSafe AI）、**OpenAI Decisions API**（Luna）。字段名依据本次调研，见 [../sources.md](../sources.md) §decision 模型；标 `[待验证]` 的待补齐。

| 特性 | Gemini Decisions | Jev (TypeSafe) | OpenAI Decisions (Luna) | canonical 落点 | 状态 |
|---|---|---|---|---|---|
| 多模态内容输入 | 文本/图像/音频/视频/PDF，最大 256K tokens `[待验证]` | `[待验证]` | `[待验证]` | `DecisionContent[]` + `MediaRef` | ✅ |
| 批量问题 | 最多 1000 个 `[待验证]` | `[待验证]` | `[待验证]` | `questions[]` | ✅ |
| 是非判断 | ✅ `[待验证]` 类型名 | `Choice` 原语 `[待验证]` | `[待验证]` | `type:"binary"` | ✅ |
| 定集选择 | ✅ | `Choice` 原语 | `[待验证]` | `type:"choice"` | ✅ |
| 固定量表评分 | ✅ `[待验证]` 类型名 | `Score` 原语 `[待验证]` | `[待验证]` | `type:"scale"` | ✅ |
| rubric 评估 | ✅ `[待验证]` 类型名 | `[待验证]` | `[待验证]` | `type:"rubric"` | ✅ |
| 逐选项概率 | ✅ `[待验证]` 字段名 | per-option probabilities | `[待验证]` | `option_probabilities[]` | ✅ |
| 校准概率 | ✅ | ✅ | `[待验证]` | `probability` | ✅ |
| 置信度分数 | ✅ | `[待验证]` | `[待验证]` | `confidence` | ✅ |
| 其他原语 | — | `Noul` `[待验证]` | — | `native.<vendor>.*` | ⚠️ |
| 输出 token 计费 | **免费** `[待验证]` | **免费** `[待验证]` | `[待验证]` | `pricing_state.output = "free"` | ✅ |
| 输入单价 | $0.10/M tokens `[待验证]` | $0.042/M tokens `[待验证]` | `[待验证]` | 定价表 | ✅ |
| usage 上报 | `[待验证]` | `[待验证]` | `[待验证]` | `usage_raw` + `units.questions` 兜底 | ⚠️ |
| 流式 | ❌（无流式语义） | ❌ | ❌ | `StreamOptions.mode: "none"` | ✅ |
| 能否做 chat | ❌ 单向能力 `[待验证]` | ❌（明确"不是 chatbot，不写句子"） | `[待验证]` | — | ✅ |
| 接入方式 | Gemini API / AI Studio `[待验证]` | TypeSafe 或 OpenRouter | `[待验证]` | access path | ⚠️ |
| 延迟 | 150–250 ms（报道值）`[待验证]` | `[待验证]` | `[待验证]` | `RequestTrace` | ✅ |

**降级路径（重要）**：上游只有 chat 模型时，用 chat + `response_format: json_schema` 模拟 decision，响应标记 `calibration: "degraded"`。设计见 [40-provider-adaptors.md](./40-provider-adaptors.md) §6.3。

## 2. Canonical 覆盖矩阵（多模态模态）

图例同上。

| 模态 | 需求侧特性 | canonical 落点 | 状态 |
|---|---|---|---|
| **TTS** | 文本输入 | `TtsPayload.input` | ✅ |
| | 声音 id / 性别 / 克隆参考 | `VoiceSpec` | ✅ |
| | 语速 / 音调 / 音量 / 情感 | `ProsodySpec` | ✅ |
| | 输出格式（codec/采样率/位深/声道/码率） | `AudioOutputSpec` | ✅ |
| | 一次性 vs 流式 | `StreamOptions` | ✅ |
| | SSML 逃生舱 | `ProsodySpec.ssml` | ✅ |
| | 前后文连贯 | `ProsodySpec.context` | ✅ |
| | 发音词典 | `ProsodySpec.pronunciation_dict` | ✅ |
| **ASR** | 音频输入（inline/uri/asset） | `AsrPayload.audio` | ✅ |
| | 语言提示 / 提示词 / 关键词 | `AsrPayload` | ✅ |
| | 全文 + 分段 + 词级时间戳 + 置信度 | `AsrResponsePayload` | ✅ |
| | 说话人分离 | `AsrPayload.diarization` | ✅ |
| | 话语段（utterance） | `AsrUtterance` | ✅ |
| | 中间结果（interim + revision） | `InterimTranscript` | ✅ |
| | 一次性 vs 实时流式 | `StreamOptions` | ✅ |
| **Image** | prompt / negative_prompt | `ImagePayload` | ✅ |
| | 尺寸 / 比例 / 数量 | `ImagePayload` | ✅ |
| | 质量 / 风格 / 采样（steps/guidance/sampler/seed） | `ImagePayload` | ✅ |
| | img2img / inpaint mask / 多参考图 | `ImagePayload.edit` | ✅ |
| | 输出格式 / 透明背景 | `ImagePayload.output` | ✅ |
| | prompt 自动改写 | `ImagePayload.allow_prompt_rewrite` | ✅ |
| | 异步轮询 | `ImageResponsePayload.polling` | ✅ |
| **Embedding** | 文本/多模态输入 / 维度截断 / 编码格式 / taskType | `EmbeddingPayload` | ✅ |
| **Rerank** | query / documents / top_n / return_documents | `RerankPayload` | ✅ |
| **Moderation** | 输入 / 分类阈值 / 多分类输出 | `ModerationPayload` | ✅ |
| **Video** | 生成 / 编辑 | `VideoPayload`（空占位 + raw） | ⚠️ 仅占位，明确不做 |

---

## 3. 前向兼容规则（写死，不可协商）

**规则 F1：schema 只允许增量变更。** 新增字段、新增联合成员、新增模态都是加法。**禁止**：改名字段、删字段、改字段类型、收窄联合。

**规则 F2：判别联合（`kind`）承载模态 payload。** 新模态只在 `ModalityKind` / `ModalityPayload` / `ModalityResponsePayload` / `DeltaData` 加字面量与成员，不改 `CanonicalRequestEnvelope` 的任何现有字段。

**规则 F3：raw passthrough 是终极逃生口。** 任何未建模字段进 `raw.unmapped`（顶层）或 `_raw`（节点级）。`additionalProperties: false` 在所有 schema 上开启，正是为了逼着未建模字段显式进 raw，而不是悄悄躺平。

**规则 F4：插件可注册扩展字段。** 插件通过 `manifest.extension_schema` 声明自己要往 canonical 里加的字段，Runner 在 S1 之后按声明的 schema 校验并注入。这让插件能带自己的状态而不必改核心 schema。

**规则 F5：真的出现装不下的新概念时，走这个流程**（且**必须是加法**）：

1. 在 [10-canonical-schema.md](./10-canonical-schema.md) §10 Open Questions 记一条；
2. 判断能否用 `native.<vendor>.*` 或 `raw.unmapped` 表达——**能就不扩 schema**（这是首选，90% 的情况）；
3. 不能 → 新增一个**可选**字段（`?:`），加进 `ModalityPayload` 的对应联合成员，`additionalProperties: false` 不受影响因为是显式加法；
4. 仍不能（需要新的顶层概念）→ 新增一个模态 `kind`，走 F2；
5. bump `ir_version`（`ag-ir/1` → `ag-ir/2`），旧版本 adaptor 与插件声明自己只懂哪个版本，路由层据此拒绝不兼容组合；
6. 在 [12-coverage-survey.md](./12-coverage-survey.md) 补一行，并在 `schema/ag-ir-N/` 放新版本。

**规则 F6：schema 层 round-trip 用例是回归网。** 对本文登记的**每一项**特性，都有一个"只含该特性"的 canonical fixture + schema 校验 + 序列化无损断言（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.5）。任何人改 schema 都会被这些用例抓住。**没有 adaptor 实现它也要有这条用例。**

---

## 4. 结论：canonical 的边界画在哪

### 4.1 边界定义

**canonical 的边界 = 「主流厂商截至 2026-11 已公开表达的特性并集」+ 「多模态各模态的完备参数集」+ 「raw passthrough 逃生口」。**

具体地，canonical **装得下**：
- OpenAI / Anthropic / Gemini 三家 chat 格式的全部请求与响应字段（§1.1–1.3）；
- TTS / ASR / Image / Embedding / Rerank / Moderation 六种模态的完备参数（§2）；
- **decision 模态**：多模态内容引用 + 四类问题（binary / choice / scale / rubric）+ 校准概率与置信度 + 逐选项概率（§1.5）；
- ElevenLabs / MiniMax / Azure / Google Cloud / Deepgram / AssemblyAI / Stability / BFL / Mistral / Cohere / Bedrock / Vertex 的专有特性（§1.4）——全部通过 `native.<vendor>.*` 命名空间或结构化字段表达；
- 任何我们没想到的东西——通过 `raw.unmapped` / `_raw` / `UnknownPart`。

canonical **不装**：
- 计费金额（只做计量，见 [10-canonical-schema.md](./10-canonical-schema.md) D5）；
- 网关自身的路由/策略配置（那是 `route` 的职责，不是 IR 的）；
- 视频模态的实现（只留空占位，见 [70-roadmap.md](./70-roadmap.md) §7 非目标）。

### 4.2 哪些特性是"已表达但无 adaptor"

**绝大多数。** 这是**有意的设计**，不是未完成：

| 类别 | 例子 | 为什么先不做 adaptor |
|---|---|---|
| 我们不会用的厂商 | Azure TTS、Google Cloud TTS、Stability、BFL、Mistral、Cohere | 没有使用场景；adaptor 写了没测试会腐烂 |
| decision 的非首选上游 | Jev / OpenAI Decisions（若 Gemini Decisions 够用） | 品类相同，先打通一家；其余按需 |
| 已有等价替代的 | Deepgram / AssemblyAI（OpenAI Whisper 够用） | 按需再写 |
| 实验性/不稳定的 | Gemini Live API、Anthropic `context_management` | 等稳定；canonical 已留位 |
| 明确非目标 | Video | 只留 schema 占位 |

**判据**：canonical 覆盖矩阵里 ✅ 的项，**不需要** adaptor 也能被"无损携带"——客户端可以用 OpenAI 格式发一个带 `native.gemini.*` 字段的请求，网关 fast path 透传给 Gemini，字段不丢。adaptor 只是让"跨格式"也能工作。

### 4.3 为什么这个边界不会再被打破

1. **raw passthrough 是数学上的完备逃生口**：任何未建模字段都能无损往返。所以"装不下"在定义上不可能发生——只有"不方便"会发生。
2. **前向兼容规则 F1–F6 把变更限定为加法**：加字段不需要 bump 主版本，加模态才 bump。所以 schema 演进不会打破已有 adaptor 与插件。
3. **两张矩阵分离**：canonical 矩阵的目标是全覆盖（本文），adaptor 矩阵的目标是按需（[40-provider-adaptors.md](./40-provider-adaptors.md) §5）。后者永远会有 ✅→⚠️→❌ 的流动，前者不会——它只在"发现真的装不下"时动，而 F3 保证这不会发生。
4. **schema 层 round-trip 用例兜底**：即使某个特性没有 adaptor，它的 canonical fixture 也在 CI 里跑，保证"新增 adaptor 不需要改 schema"这个承诺不被悄悄破坏。

**唯一的破界方式**：出现一个全新的**模态**（如"3D 生成"），那走 F2 + F5 第 4 步，是显式的、有版本的、加法的。

---

## 5. Open Questions（普查本身的不确定项）

1. OpenAI Responses 的 `reasoning` item 多轮回传规则（是否必须原样、`encrypted_content` 字段名）。
2. OpenAI Responses 的 `computer_use` / `mcp` 工具配置字段全集。
3. Anthropic `cache_creation.ephemeral_5m/1h_input_tokens` 是否分字段返回。
4. Anthropic `context_management`（context editing / memory tool）的确切字段与语义。
5. Gemini `googleSearchRetrieval` 是否已废弃（被 `googleSearch` 取代）。
6. Gemini `thoughtSignature` 的确切字段名与回传要求。
7. Gemini 是否有原生 TTS / ASR / Imagen 端点及其字段。
8. Gemini Live API 的实时音视频协议（WS 帧结构）——canonical 的 WS 双路径是否够用。
9. `parallel_tool_calls: false` → Anthropic / Gemini 的映射（目前判定"无对应"）。
10. OpenAI `prompt_cache_breakpoint` + `prompt_cache_options{mode,ttl}` 的完整字段（GPT-5.6+）。
11. Cohere rerank / Mistral 的完整字段集（只做了粗粒度）。
12. **Q21（decision）**：三家 decision API 的确切字段名——问题类型枚举值、选项集表示、`probability` / `confidence` / per-option probabilities 的字段名与嵌套、usage 形状、错误码。
13. **Q22（decision）**：Gemini Decisions 的免费额度与可用区域；Jev 在 TypeSafe 与 OpenRouter 上的确切模型 id 与计价方式。
14. **Q23（decision）**：decision 模型是否真的不能做 chat（单向能力）——需要读官方文档确认，而非从产品定位推断。
15. **Q24（decision）**：chat + 结构化输出模拟 decision 的校准性损失有没有公开基准（这决定降级路径是否值得默认开启）。
16. Bedrock / Vertex 的专有参数全集（`additionalModelRequestFields` / `labels` / inference profile）。
