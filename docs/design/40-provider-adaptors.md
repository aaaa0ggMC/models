# 40 · Provider Adaptor 设计与字段口径对照

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：[10-canonical-schema.md](./10-canonical-schema.md)、[20-pipeline.md](./20-pipeline.md)、[15-modalities.md](./15-modalities.md)
> 下游被引用于：[60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md)

---

## 0. 阅读指引

§1 adaptor 接口（含契约/注册/映射方法论/round-trip 测试模板/新增检查清单）；§2 **usage 口径差异对照表**（本文核心）；§3 reasoning 有损映射；§4 schema 归一化；§5 adaptor 覆盖矩阵；**§6 decision 模态 adaptor（含降级路径）**；§7 各 provider 注意事项；§8 Open Questions。

---

## 1. Adaptor 接口

> **本节是全套文档里最需要"可照抄"的部分。** 设计目标：**新增一个 adaptor 是机械活**——照着 §1.3 的注册机制、§1.4 的映射方法论、§1.5 的测试模板做，不需要重新发明任何东西。

### 1.0 适配范围策略：adaptor 按需写，canonical 一次做全

> ⚠️ **这是一个关键区分，不要混淆两张矩阵**：
> - **canonical schema 是全面的（超集）**——设计期一次性穷尽式普查，把主流厂商各模态的特性并集全部纳入（**包括我们永远不实现的**）。目标是：**新增 adaptor 时永远不需要改 schema**。
> - **adaptor 是按需写的**——用到哪个模型/哪个能力，再写那个 adaptor。
>
> 宁可 canonical 里有 adaptor 用不到的字段，也不能出现"某个厂商有办法实现、但 canonical 装不下"的情况。
>
> canonical 的普查结果见 [12-coverage-survey.md](./12-coverage-survey.md)；本节只管 adaptor。

**adaptor 按需的理由**：
1. 各厂商协议的差异是开放集合，一次性全覆盖 adaptor 会导致 canonical 被某家的怪字段带偏（这是 NewAPI / one-api 渠道 adaptor 越写越乱的根因）；
2. 未使用的 adaptor 没有测试覆盖，协议一改就静默腐烂，反而制造"看起来支持"的假象；
3. 真正稀缺的不是 adaptor 数量，而是"加一个 adaptor 的成本够低"。

**v1 完整落地（写透，含全部测试）**：
- `openai.chat`（OpenAI Chat Completions）
- `openai.responses`（OpenAI Responses API）
- `anthropic.messages`（Anthropic Messages API）

**其余 adaptor 全部标注为"按需"**——包括 Gemini、Azure、Bedrock、Vertex，以及所有多模态 adaptor。adaptor 能力矩阵用三态标注：**已实现 / 计划 / 按需**（见 §5）。

### 1.1 为什么 adaptor 与 transport 要分开

**决策 P1：语义转换（adaptor）与传输/鉴权（transport）二分。**

**理由**：Bedrock 的 SigV4、Vertex 的 OAuth、ChatGPT 订阅的 device-code OAuth 只改"怎么签名、怎么建流"，不改"字段怎么映射"。绑在一起会导致每个 provider 都要重写一遍鉴权与流解析。

**借鉴来源**：llmshim 的 `Provider` / `RequestTransport` 二分，特别是 `prepare_authorization` 返回一次性 signer、在 admission（限流/配额）之后才签名——"slow credential traffic cannot leave unsent liabilities"（[llmshim src/transport.rs](https://raw.githubusercontent.com/sanjay920/llmshim/main/src/transport.rs)）。

```typescript
/** 语义层：wire ↔ canonical */
interface Adaptor {
  readonly format: FormatId;
  readonly modalities: ModalityKind[];

  /** 请求：wire → canonical */
  decode(raw: unknown, ctx: RequestContext): CanonicalRequestEnvelope;
  /** 请求：canonical → wire（含 fast path 判定） */
  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest;
  /** 响应：wire → canonical */
  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope;
  /** 响应：canonical → wire */
  encodeResponse(res: CanonicalResponseEnvelope, ctx: RequestContext): unknown;

  /** 流式：wire 事件流 → canonical 帧 */
  decodeStream(stream: AsyncIterable<unknown>, ctx: RequestContext): AsyncIterable<StreamFrame>;
  /** 流式：canonical 帧 → wire 事件流 */
  encodeStream(frames: AsyncIterable<StreamFrame>, ctx: RequestContext): AsyncIterable<unknown>;

  /** 该格式的 usage 字段抽取 */
  extractUsage(raw: unknown): CanonicalUsage;
  /** finish_reason 归一 */
  normalizeFinishReason(raw: unknown): NormalizedFinishReason;
}

interface EncodedRequest {
  body: unknown;
  /** fast path 时的原始字节（不经过 encode） */
  raw_bytes?: Buffer;
  fast_path: boolean;
  /** 本次编码丢弃/降级了哪些能力 */
  dropped?: string[];
  warnings?: string[];
}
```

### 1.2 最小实现面（v1 必做 vs 可后补）

| 方法 | v1 必做 | 说明 |
|---|---|---|
| `decode` | ✅ | 入站解析，必须无损进 `raw.unmapped` |
| `encode` | ✅ | 出站编码，必须支持 fast path 短路 |
| `decodeResponse` | ✅ | |
| `encodeResponse` | ✅ | |
| `decodeStream` | ✅ | 至少支持该模态声明的一种流式形态 |
| `encodeStream` | ✅ | |
| `extractUsage` | ✅ | 多单位，见 §2 |
| `normalizeFinishReason` | ✅ | 双留：归一值 + 原文 |

**结论：v1 的 adaptor 接口就是上面 8 个方法，一个都不能少，也不允许多。** 可选扩展（`supportedUrls` 式的能力声明）走能力矩阵而不是接口方法——避免接口膨胀。

### 1.3 注册机制

```typescript
/** adaptor 注册表。一个 (FormatId, ModalityKind) 二元组最多一个实现。 */
class AdaptorRegistry {
  register(adaptor: Adaptor, meta: AdaptorMeta): void;
  get(format: FormatId, modality: ModalityKind): Adaptor;
  list(modality?: ModalityKind): AdaptorMeta[];
}

interface AdaptorMeta {
  format: FormatId;
  modality: ModalityKind;
  /** 版本。协议变动时 bump，旧版本保留以便回滚 */
  version: string;
  /** 契约测试夹具目录 */
  fixtures: string;
  /** 已知不支持/有损的 canonical 字段 */
  unsupported_fields: string[];
  /** 已知 quirks（人类可读，进能力矩阵） */
  quirks: string[];
  /** 状态：已实现 / 计划 / 按需 */
  status: "implemented" | "planned" | "on-demand";
}
```

**注册是显式的、集中在一个文件里**（`adaptors/index.ts`），不做魔法自动发现——自动发现会让"哪些 adaptor 真的被测过"变得不可审查。

### 1.4 映射方法论（照此顺序做，不要跳步）

新增一个 adaptor 时，严格按这 7 步：

1. **抓样本**：用真实请求/响应各 3–5 份（流式 + 非流式，最小 + 最大，含工具调用，含多模态），存进 `fixtures/<format>/`。**没有样本不动手**——凭文档猜字段必然错。
2. **列字段清单**：把 wire 格式的请求/响应字段全列出来，逐个标三类之一：
   - `core`：canonical 有对应字段 → 进映射表；
   - `native`：canonical 的 `native.<format>.*` 命名空间 → 进透传表；
   - `unmapped`：完全不建模 → 必须进 `raw.unmapped`。
   **不允许出现第四类"忘了处理"。**
3. **写请求映射表**：canonical → wire，一列一个字段（参照 §9 的格式）。每个单元格要么给目标字段名，要么给 `drop+warn` / `error`。
4. **写响应映射表**：wire → canonical，同上。usage 与 finish_reason 单独一张表（§2、§9.3）。
5. **写流式折叠表**：wire 事件 → `StreamFrame`，一列一个事件（参照 [20-pipeline.md](./20-pipeline.md) §S6 的表）。
6. **写 round-trip 测试**（§1.5），先看它红，再修到绿。
7. **登记能力矩阵**：填 `AdaptorMeta`，`status: "implemented"`，`contract_tested: true`。

**第 3 步的补充：转换目标的有序偏好表。** 同一份 canonical 可能有多条 wire 路径（如客户端是 Anthropic Messages、上游同时支持 Responses 与 Completions）。**不要穷举 N×M 全矩阵**，而是维护一张**有序偏好表**，取第一个目标支持的：

```
Messages    → AnthropicMessages(直连) | OpenAIResponses | OpenAICompletions | BedrockConverse
Completions → VertexGemini | OpenAICompletions(直连) | AnthropicMessages | BedrockConverse
Responses   → OpenAIResponses(直连) | OpenAICompletions | BedrockConverse
```

**规则**：
- **更便宜/更原生的转换排前面**（直连优先，其次差异小的）；
- **把不支持的组合写成显式注释**（`Missing: Responses → Messages`），让缺口可见，而不是留空让人以为忘了写；
- 顺序是**配置项**，可按部署调整（例如某 provider 的 Responses 支持有 bug，就把它排后）；
- 直连（同格式）一定排第一——这就是 fast path 的查表依据。

**第 4 步的补充：token 双轨命名。** 归一化后的字段叫 `input_tokens` / `total_tokens`（跨 provider 同义，用于计费与看板）；provider 原样字段进 `usage_raw`（用于对账）。**显式警告：两者不要相加。** agentgateway 用 `llm.inputTokens` / `llm.providerInputTokens` 表达同一区分，且明确警告"不要把 cache 字段加到 inputTokens，会双算"（[agentgateway metrics reference](https://agentgateway.dev/docs/standalone/latest/documentation/observability/metrics/reference)）。

### 1.5 Round-trip 测试模板（每个 adaptor 必过）

**测试目标（两层，都要过）**：
- **adaptor 层**：wire → canonical → wire 对该 adaptor 支持的格式无损；
- **schema 层**：**任何厂商特性进入 canonical 再出来必须无损**——即使**没有 adaptor 实现它**，也要有 schema 层的 round-trip 用例兜底。这是 canonical 超集性质的回归网：任何人往 schema 里加/改字段，都会被这些用例抓住。

```typescript
/**
 * 保真度测试的核心不变式：
 *   canonical = decode(wire)
 *   wire'    = encode(canonical)
 *   wire''   = encode(decode(wire'))     // 二次往返必须稳定
 *
 * 三个断言：
 *   A. decode(encode(decode(wire))) === decode(wire)      // 语义幂等
 *   B. same-format fast path: encode(decode(wire)) === wire（除归一化字段外字节级相等）
 *      —— "归一化字段"白名单：finish_reason、tool id、usage 口径
 *   C. reconstructionQuality(canonical, format) >= 阈值（同格式 100，跨格式 >= 80）
 */
describe.each(fixtures)("adaptor %s round-trip", (name, wire) => {
  it("decode → encode 幂等", () => {
    const c1 = adaptor.decode(wire, ctx);
    const c2 = adaptor.decode(adaptor.encode(c1, ctx), ctx);
    expect(c2).toEqual(c1);
  });

  it("fast path 字节级透传", () => {
    const encoded = adaptor.encode(adaptor.decode(wire, ctx), ctx);
    expect(encoded.fast_path).toBe(true);
    expect(normalizableDiff(encoded.raw_bytes, wire)).toBeEmpty();
  });

  it("未知字段不丢", () => {
    const withExtra = { ...wire, __some_future_field: { a: 1 } };
    const c = adaptor.decode(withExtra, ctx);
    expect(c.raw.unmapped.__some_future_field).toEqual({ a: 1 });
    expect(adaptor.encode(c, ctx).body.__some_future_field).toEqual({ a: 1 });
  });

  it("畸形 tool 参数不被销毁", () => {
    // 直接针对已知开源缺陷：JSON.parse 失败后 raw_arguments 必须回写
    const c = adaptor.decode(wireWithBadToolArgs, ctx);
    const out = adaptor.encode(c, ctx);
    expect(out.body.…arguments).toBe("原始字符串，不是 {}");
  });

  it("多 system 消息不丢", () => {
    const c = adaptor.decode(wireWithTwoSystemMessages, ctx);
    expect(c.payload.system).toHaveLength(2);
  });

  it("流式事件序列等价", async () => {
    const frames = collect(adaptor.decodeStream(parseSse(wireStream), ctx));
    const reEncoded = collect(adaptor.encodeStream(frames, ctx));
    expect(eventShape(reEncoded)).toEqual(eventShape(parseSse(wireStream)));
  });
});

/**
 * schema 层 round-trip（无 adaptor 也要有）：
 * 对 12-coverage-survey.md 里登记的每一项厂商特性，构造一个"只含该特性"的
 * canonical 对象，验证 JSON Schema 校验通过 + 序列化/反序列化无损。
 * 这一层不依赖任何 provider，纯本地跑，进 CI。
 */
describe.each(coverageSurveyFeatures)("canonical 容纳特性 %s", (feature) => {
  it("schema 校验通过且 round-trip 无损", () => {
    const canonical = feature.buildCanonical();          // 来自 12-coverage-survey.md 的 fixture 生成器
    expect(validate(canonical, agIrSchema)).toBeValid();
    expect(JSON.parse(JSON.stringify(canonical))).toEqual(canonical);
  });
});
```

**这 6 条 adaptor 测试 + 1 类 schema 测试是硬门槛**：每条都对应一个已知的真实缺陷来源（见 [docs/sources.md](../sources.md) §llm-bridge 的三处有损、Anthropic 的 tool_use 位置约束、AI SDK 的 `rawInvalidInput` 语义改变）。schema 层用例则保证"新增 adaptor 不需要改 schema"这个承诺不被悄悄破坏。

### 1.6 新增 adaptor 检查清单（Checklist）

动工前逐条打勾：

- [ ] 已确认该 adaptor 是**按需**的（有真实使用场景），不是为 coverage 而写
- [ ] 已抓 3–5 份真实样本进 `fixtures/<format>/`（含流式）
- [ ] 字段清单已三分类（core / native / unmapped），无第四类
- [ ] 请求映射表已写（含 drop+warn / error 的明确标注）
- [ ] 响应映射表已写，usage 与 finish_reason 单独成表
- [ ] 流式折叠表已写
- [ ] §1.5 的 6 条 round-trip 测试全绿
- [ ] fast path 字节级透传测试通过（若是同格式 adaptor）
- [ ] 能力矩阵已登记，`status: "implemented"`，`contract_tested: true`
- [ ] `quirks[]` 已填写人类可读的已知怪癖
- [ ] 文档 §9 的映射表已补一行（或一个子表）
- [ ] 无真实凭据/绝对路径/内网地址进入 fixtures（fixtures 也要过 privacy-scan）
```

### 1.2 "默认按名拒绝"

**决策 P2：adaptor 对不支持的模态/能力默认返回明确错误，不静默 fallback。**

**理由**：llmshim 的 `transform_embedding_request` 默认 `Err(embeddings::absent(...))`，源码注释："a provider with no embeddings API must say so here rather than be answered by another vendor's model: a vector from a model the caller did not name is the wrong answer, silently."（[llmshim src/provider.rs](https://raw.githubusercontent.com/sanjay920/llmshim/main/src/provider.rs)）

对应到我们：请求 `kind:"embedding"` 而 route 落到一个没有 embedding 的 provider → `capability_unsupported`，**不**换成别的 provider 的 embedding（那会静默改变语义）。

---

## 2. Usage 口径差异对照表（核心）

### 2.1 chat 模态

> 字段名依据 2026-11 官方文档（OpenAI developers.openai.com、Anthropic platform.claude.com API version `2026-10-21`、Gemini aistudio.google.com）。来源见 [docs/sources.md](../sources.md) §格式细节。

| 规范字段 | OpenAI Chat | OpenAI Responses | Anthropic | Gemini |
|---|---|---|---|---|
| `input_tokens` | `usage.prompt_tokens` | `usage.input_tokens` | `usage.input_tokens`（**不含** cache 部分） | `usageMetadata.promptTokenCount`（**含**缓存部分） |
| `output_tokens` | `usage.completion_tokens` | `usage.output_tokens` | `usage.output_tokens` | `usageMetadata.candidatesTokenCount` |
| `total_tokens` | `usage.total_tokens` | `usage.total_tokens` | **需自算** = `input + cache_creation + cache_read + output` | `usageMetadata.totalTokenCount` |
| `cache_read_tokens` | `usage.prompt_tokens_details.cached_tokens` | `usage.input_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` | `usageMetadata.cachedContentTokenCount` |
| `cache_write_tokens` | `usage.prompt_tokens_details.cache_write_tokens` | `usage.input_tokens_details.cache_write_tokens` | `usage.cache_creation_input_tokens` | — |
| `cache_write_ttl` 细分 | `prompt_tokens_details.cache_write_tokens_details.ttl_12h_tokens` / `ttl_30m_tokens` | `input_tokens_details.cache_write_tokens_details.{ttl_12h_tokens,ttl_30m_tokens}` | `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` | — |
| `reasoning_tokens` | `usage.completion_tokens_details.reasoning_tokens` | `usage.output_tokens_details.reasoning_tokens` | `usage.output_tokens_details.thinking_tokens`（已计入 output） | `usageMetadata.thoughtsTokenCount` |
| `text_tokens` | `completion_tokens_details.text_tokens` | — | — | — |
| `audio_tokens` | `prompt_tokens_details.audio_tokens` / `completion_tokens_details.audio_tokens` | — | — | — |
| `image_tokens` | `prompt_tokens_details.image_tokens` | — | — | — |
| `prediction_tokens` | `completion_tokens_details.accepted_prediction_tokens` / `rejected_prediction_tokens` | — | — | — |
| `tool_use_prompt_tokens` | — | — | — | `usageMetadata.toolUsePromptTokenCount` |
| server tool 用量 | — | — | `usage.server_tool_use.web_search_requests` / `web_fetch_requests` | — |
| 模态细分 | — | — | — | `usageMetadata.promptTokensDetails[]` / `candidatesTokensDetails[]`（按 modality 拆） |
| 服务档 / 地域 | `service_tier` | `service_tier` | `usage.service_tier` / `usage.speed` / `usage.inference_geo` | `usageMetadata.serviceTier` |
| 原始 usage 保留 | `usage_raw.openai` | `usage_raw.openai_responses` | `usage_raw.anthropic` | `usage_raw.gemini` |

### 2.2 双算风险（已在 2026-11 文档层面定论，仍需实测复核）

| 风险 | 涉及字段 | 处理规则 |
|---|---|---|
| **Gemini `promptTokenCount` 含缓存部分** | Gemini `promptTokenCount` vs `cachedContentTokenCount` | `input_tokens` 记 `promptTokenCount` 全量，`cache_read_tokens` 记 `cachedContentTokenCount`；计费时 `input = input_tokens - cache_read_tokens`（与 OpenAI 一致，**不双算**） |
| **Anthropic `input_tokens` 不含 cache 部分** | Anthropic `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` | 三者相加得总输入（官方口径："总输入 = input + cache_creation + cache_read"）。计费时 input 按 `input_tokens`、cache write 按 `cache_creation_input_tokens`、cache read 按 `cache_read_input_tokens` 各按各价，**不重复** |
| **OpenAI `prompt_tokens` 与 `cached_tokens`** | OpenAI `prompt_tokens` vs `prompt_tokens_details.cached_tokens` | 同 Gemini：`input = prompt_tokens - cached_tokens`。**`[待验证]`** 需实测确认 `prompt_tokens` 是否已含 cached 部分（文档未明说） |
| **Gemini `totalTokenCount` 含 thoughts** | Gemini `totalTokenCount` vs `thoughtsTokenCount` | 默认假设**含**（`total = prompt + candidates`，thoughts 已计入 candidates）。**`[待验证]`** |
| **Anthropic thinking 无独立字段** | Anthropic | `reasoning_tokens = output_tokens_details.thinking_tokens`，且 `warnings += "reasoning_in_output"`（已计入 output，不另加） |
| **Anthropic 5m/1h cache write** | Anthropic `cache_creation.ephemeral_*` | **已确认分字段返回**（2026-10-21 版 usage schema）。`cache_write_tokens = cache_creation_input_tokens`，5m/1h 拆分进 `TokenUsage.details.cache_write_ttl_5m` / `cache_write_ttl_1h`，供按 TTL 分别计价 |

**规则 P3**：以上默认假设全部写进 `usage_raw` 与代码注释，并各配一个集成测试夹具；一旦实测推翻，改默认值 + 迁移历史数据的重算脚本（不追溯改写已存记录，见 [60-billing-and-dogfooding.md](./60-billing-and-dogfooding.md) §4.1）。

### 2.2c Usage 归一化的四条硬不变量

逐条对照 LiteLLM 的实现（已读源码，见 [docs/sources.md](../sources.md) §LiteLLM）后定死：

| # | 不变量 | 定论 |
|---|---|---|
| **I1** | `prompt_tokens` 是否含 cached / cache_write | **OpenAI：含 `cached_tokens`，不含 cache_write**；**Anthropic / Gemini / Bedrock：`input_tokens` 两者都不含**，需 `input + cache_creation + cache_read` 才等于总输入（Anthropic 官方口径即此） |
| **I2** | `completion_tokens` 是否含 reasoning | **OpenAI：含**（`completion_tokens_details.reasoning_tokens` 是其子集）；**Anthropic：含**（`thinking_tokens` 计入 `output_tokens`）；**Gemini：视模型而定**，用 `promptTokenCount + candidatesTokenCount + toolUsePromptTokenCount == totalTokenCount` 反推 `candidatesTokenCount` 是否已含 thinking（LiteLLM 的 `is_candidate_token_count_inclusive` 做法），否则把 `thoughtsTokenCount` 加上去 |
| **I3** | `total_tokens` 是透传还是重算 | **流式一律重算**（`prompt + completion`），因为上游的 `total` 在分片到达时可能不完整；**非流式透传**上游值，但与 `prompt+completion` 不一致时记 `warnings` |
| **I4** | 原始 usage 全量存档 | `usage_raw` 必须**逐字段**保留，且**必须在流式聚合后依然存在**。LiteLLM 的教训：`Usage.__init__` 的 `setattr` 会把未知 provider 字段挂成 extra，但流式聚合 `calculate_total_usage` 只重建声明字段，**extras 会丢**（源码注释自承）。我们的对策：`usage_raw` 在 S6 抽取时就是**独立对象**，不依赖任何"extra 透传"机制，流式聚合只动 `units`，绝不动 `usage_raw` |

**Gemini 的 grounding 特例**：检索到的 token 不计 input，但 URL context / File Search 按 input 计费（LiteLLM 用 `_response_has_search_grounding` 区分）。`toolUsePromptTokenCount` 同理——有 search grounding 时 `billable_tool_use_prompt_tokens = 0`。这直接影响 [50-builtin-search.md](./50-builtin-search.md) §5 的搜索计费口径，标 **`[待验证]`**。

**Bedrock 的特例**：reasoning tokens 默认不返回，需要显式请求 `/usage/output_tokens_details`，否则只能本地估算（LiteLLM 的做法是 `token_counter(text=reasoning_content)`）。

### 2.2b 2026 年的协议变更（adaptor 必须处理）

| 变更 | 影响 |
|---|---|
| **Anthropic API version `2026-10-21` 移除 `temperature` / `top_p` / `top_k`**（发送即 400） | canonical `ChatParams` 保留这三个字段（其他格式还要用），但 `anthropic.messages` adaptor 编码时**必须丢弃**并 `warnings += "temperature_unsupported"`。这是"canonical 是超集、adaptor 按需"的典型例子 |
| Anthropic `thinking.type` 从 `"enabled"`（legacy，配 `budget_tokens`）演进到 `"adaptive"`；Claude 5+ 默认开启思考 | canonical `ThinkingConfig` 同时支持 `budget_tokens` 与 `effort`，`enabled` 表达"开/关" |
| Anthropic `web_search_20250305` → `20260209` → `20260318`；`code_execution_20250522` → `20260521`；`computer_20250124` → `computer_toolset_20260801` | `BuiltinTool.raw.provider_tool_type` 记录版本串；canonical 只用 `name:"web_search"` 这类稳定名 |
| Anthropic 新增 `output_config{effort, format:{json_schema}}` | canonical 用 `ThinkingConfig.effort` + `ResponseFormat`；这是 Anthropic 侧的结构化输出面 |
| Anthropic 新增顶层 `cache_control`（自动给最后一个可缓存块打标记） | canonical `CacheControl` 建模为块级；映射到 Anthropic 时可选择"显式断点"或"顶层自动" |
| OpenAI `max_tokens` → `max_completion_tokens`；`system` → `developer`（o1+）；`functions`/`function_call` → `tools`/`tool_choice`；`user` → `safety_identifier` + `prompt_cache_key`；`prompt_cache_retention` → `prompt_cache_options.ttl`；`reasoning.generate_summary` → `reasoning.summary` | canonical 统一用新名；旧名映射进 `raw.unmapped` 并在 `warnings` 提示 |
| OpenAI Responses 新增 `prompt_cache_breakpoint`（块级）+ `prompt_cache_options{mode,ttl:30m\|12h}` | canonical `CacheControl` 已有 `ttl`；OpenAI 侧 12h/30m 与 Anthropic 5m/1h **不翻译**（OpenRouter 同样如此，见 [00-overview.md](./00-overview.md) §7.0.3） |
| OpenAI Responses 的 `function_call` item **同时有 `id`（item 标识，如 `fc_…`）与 `call_id`（如 `call_…`）**；回传用 `{type:"function_call_output", call_id}` | canonical `ToolUsePart.id` 统一为权威 id；codec 维护 `id ↔ call_id` 映射 |
| OpenAI Responses 的 `reasoning` item **必须随 tool 输出一起回传**（含 `encrypted_content`） | canonical `ThinkingPart` / `RedactedThinkingPart` 承载；adaptor 在工具循环里必须保留这些 part |
| **Gemini `functionCall` 新版有 `id` 字段**；函数调用回环要求"每个 step 的第一个 functionCall Part 必须带回 `thoughtSignature`，否则 400" | canonical `ToolUsePart.id` 直接映射；`ThinkingPart.signature` 承载 thoughtSignature。这修正了"Gemini 无 id"的旧认知——**`[待验证]`** 旧版 API 是否仍无 id |
| Gemini `thinkingBudget` → `thinkingLevel`（Gemini 3/4；两者同传 400）；`temperature`/`topP`/`topK` 在 Gemini 3.6 Flash+ **静默忽略** | canonical 用 `ThinkingConfig.effort`（档位）+ `budget_tokens`（连续）；adaptor 按目标模型选一个，另一个丢弃 + warning |
| Gemini 显式缓存（`cachedContents`）**不支持 Gemini 4 / Interactions API**（仅隐式缓存） | `CacheControl.cache_name` 映射到 `cachedContent` 参数；不支持的模型 drop + warning |
| Gemini 新增 Interactions API（有状态，`previous_interaction_id`），与 generateContent 并存 | canonical 不建模上游状态（见 §6.1），只在 `native.gemini.*` 留位 |
| OpenAI Chat Completions 自 GPT-5.4 起**仅 `reasoning_effort:"none"` 支持工具调用** | adaptor 需检查模型能力；不满足则 `capability_unsupported` |

### 2.3 流式下 usage 的到达方式

| 格式 | 流式 usage 位置 | 备注 |
|---|---|---|
| OpenAI Chat | 末 chunk 的 `usage`（需 `stream_options.include_usage: true`） | 网关在 S4 自动补上 `include_usage` |
| OpenAI Responses | `response.completed` 事件的 `response.usage` | 恒带 |
| Anthropic | `message_start`（input_tokens）+ `message_delta`（output_tokens + cache） | **分两次到达**，必须合并 |
| Gemini | `usageMetadata` 每 chunk 都可能带 | 取最后一次非空 |

### 2.4 非 chat 模态 usage

| 模态 | OpenAI | ElevenLabs | MiniMax | Deepgram | AssemblyAI | Stability | BFL |
|---|---|---|---|---|---|---|---|
| 计费单位 | 字符（TTS）/ 音频秒（ASR）/ token 或张（Image） | 字符 | 字符 | 音频时长 | 音频时长 | credits（张） | 张或 credits |
| usage 原始字段 | **`[待验证]`** | 响应头 `history-item-id`；字符数需自算 | `extra_info.audio_length` / `audio_size` | `metadata.duration` | `audio_duration` | credits 响应 | **`[待验证]`** |
| 网关兜底估算 | 输入字符数 | 输入字符数 | 输入字符数 | 上行音频字节 / 码率 | 上行音频时长 | `n` | `n` |

**规则 P4**：非 chat 模态**必须**有兜底估算，因为多数 TTS/ASR 上游根本不返回结构化 usage。估算值置 `source:"estimated"`、`precision` 标 `approx`，与上游值并存（见 [25-streaming.md](./25-streaming.md) §8）。

---

## 3. Reasoning / Thinking 的有损映射

### 3.1 三种词汇

| 来源 | 形态 |
|---|---|
| OpenAI Chat / Responses | 离散 `reasoning_effort`：`minimal`/`low`/`medium`/`high`（`xhigh` 部分模型） |
| Anthropic | 连续 `thinking.budget_tokens`（min 1024） |
| Gemini | 连续 `generationConfig.thinkingConfig.thinkingBudget`，或 `thinkingLevel`（Gemini 3+） |

**离散 ↔ 连续本质有损。** 采用显式阈值表（可配置），并**在响应里声明用了哪一档**。

### 3.2 阈值表（默认值，可配置）

| canonical `effort` | → Anthropic `budget_tokens` | → Gemini `thinkingBudget` |
|---|---|---|
| `minimal` | 1024 | 1024 |
| `low` | 2048 | 2048 |
| `medium` | 8192 | 8192 |
| `high` | 16384 | 16384 |
| `xhigh` | 32768 | 32768 |
| `max` | 64000 | 64000 |

反向（连续 → 离散）取最近的档位；无法就近（如 `budget_tokens: 5000`）时取**较低**档并在 `warnings` 声明。**借鉴来源**：[chinrain/Api-Conversion](https://github.com/chinrain/Api-Conversion) 的可配置阈值 env 方案。

### 3.3 已知坑

1. **reasoning tokens 计入 `max_output_tokens`**，吃光预算会返回 `incomplete` 且照常计费（OpenRouter 文档明确此坑，见 [docs/sources.md](../sources.md) §OpenRouter）。网关在 S2 应检查 `max_output_tokens > budget_tokens`，不满足则拒绝或调高。
2. **`reasoning_details` 必须原样回传**，不能重排或修改。
3. Anthropic 的 `thinking` block 的 `signature` 是**多轮必需**，转换到不支持的格式时要么整块丢弃并在 `warnings` 声明，要么降级为普通 text（默认前者）。

---

## 4. Schema 归一化（tool parameters）

各 provider 对 JSON Schema 的支持度不同（`oneOf` / `nullable` / `$ref` / lookaround / strict）。**直接借鉴 llmshim 的 `src/schema/mod.rs`**（[源码](https://raw.githubusercontent.com/sanjay920/llmshim/main/src/schema/mod.rs)）：

```typescript
interface SchemaNormalizeOptions {
  target: FormatId;
  /** 是否要求 strict（OpenAI strict function calling） */
  strict: boolean;
  /** nullable 处理策略 */
  nullable: "preserve" | "marker" | "remove";
  /** 是否重写 oneOf（Responses / Gemini 不支持裸 oneOf） */
  rewrite_one_of: boolean;
  /** 是否剥离 lookaround 正则断言（Responses 不支持） */
  strip_lookarounds: boolean;
  max_depth: number;        // 96
  max_nodes: number;        // 32768
  max_literal_bytes: number; // 8MB
}

interface NormalizeResult {
  schema: JSONSchema;
  changed: boolean;
  /** 单个 tool 的归一失败 → 退化为 {"type":"object","properties":{}} */
  used_fallback: boolean;
  warnings: string[];
}
```

**关键设计（照抄）**：
1. **per-tool fallback，不是 per-request**——一个 tool 的 schema 有问题不该让整个请求失败。
2. **Memo cache**：key = (options, schema)。llmshim 实测 50 tools 时 559µs → 210µs（2.66×）。
3. **Request budget**：超限返回 400 `request_schema_budget_exceeded`，防止恶意超大 schema。
4. **Output schema 可逆包装**：非 object 的输出 schema 包成 `{type:"object", properties:{response: <schema>}, required:["response"]}`，解回来时 unwrap。
5. **Env kill-switch**：`AG_NO_SCHEMA_NORMALIZATION` / `AG_NO_STRICT` / `AG_NO_SCHEMA_CACHE`，便于线上应急。

**v1 必做**：nullable 策略 + per-tool fallback + budget。**v1.5**：memo cache + 可逆 output 包装 + MCP 入口归一。

---

## 5. Adaptor 覆盖矩阵（三态：已实现 / 计划 / 按需）

> **这是 adaptor 矩阵，不是 canonical 矩阵。** canonical 覆盖矩阵在 [12-coverage-survey.md](./12-coverage-survey.md)——那个的目标是全覆盖，这个的目标是按需。两者不要混。

定义见 [15-modalities.md](./15-modalities.md) §6。**矩阵不把没做的画成饼**——三态必须诚实。

### 5.1 当前状态（2026-11-14）

| adaptor | 状态 | 说明 |
|---|---|---|
| `openai.chat` | **已实现（v1 目标）** | v1 写透：字段映射、usage 归一、流式、错误映射、round-trip 测试 |
| `openai.responses` | **已实现（v1 目标）** | 同上 |
| `anthropic.messages` | **已实现（v1 目标）** | 同上 |
| `gemini.generateContent` | 计划（v1.5） | 下一批；已知关键差异见 §7.3 |
| `gemini.decisions` | 计划（v1.5） | decision 模态首选上游；字段映射待 Q21 回填（§6.2） |
| `jev.decisions` | 计划（v1.5） | decision 第二上游；经 TypeSafe / OpenRouter 接入 |
| `openai.decisions` | 按需 | Luna；等 Gemini Decisions 打通后再评估 |
| `openai.audio.speech` | 计划（v1.5，示例 adaptor） | 多模态方法论示例 |
| `elevenlabs.tts` | 计划（v1.5，示例 adaptor） | 多模态方法论示例 |
| `openai.audio.transcription` | 计划（v1.5，示例 adaptor） | ASR 示例 |
| `openai.images.generations` | 计划（v1.5，示例 adaptor） | Image 示例 |
| `openai.embeddings` | 计划（v1） | 简单，随 v1 |
| 其余全部（Azure/Bedrock/Vertex/Stability/BFL/MiniMax/Deepgram/AssemblyAI/…） | **按需** | 用到再写。已知关键差异点见 [15-modalities.md](./15-modalities.md) §9 与本节 §7 的备注 |

**规则**：`status: "planned"` 只允许存在于**当前 Phase 的交付物清单**里；不在当前 Phase 的一律 `on-demand`。防止 roadmap 膨胀成饼。

### 5.2 流式能力这一列（路由据此拒绝/降级）

| provider | chat 流式 | TTS 流式 | ASR 流式 | Image 流式 |
|---|---|---|---|---|
| openai | `sse` | `chunked-binary` **`[待验证]`** | 无 | 无 |
| anthropic | `sse` | — | — | — |
| gemini | `sse`（`alt=sse`） | **`[待验证]`** | **`[待验证]`** | **`[待验证]`** |
| elevenlabs | — | `chunked-binary` | — | — |
| minimax | — | `chunked-binary` **`[待验证]`** | — | — |
| deepgram | — | — | `ws-duplex`（实时）/ `chunked`（一次性） | — |
| assemblyai | — | — | `ws-duplex` | — |
| bfl | — | — | — | 轮询 |

---

## 6. decision 模态 adaptor `[v1.5]`

### 6.1 adaptor 契约（比 chat 简单）

decision 的 adaptor **不需要流式**，因此 `decodeStream` / `encodeStream` 可以实现为"抛 `streaming_mode_unsupported`"或干脆不实现（`Adaptor` 接口的流式方法对 decision 是可选）。

```typescript
/** decision adaptor 的最小实现面 */
interface DecisionAdaptor {
  readonly format: FormatId;          // 如 "gemini.decisions" | "jev.decisions" | "openai.decisions"
  readonly modality: "decision";

  /** wire → canonical */
  decode(raw: unknown, ctx: RequestContext): CanonicalRequestEnvelope;
  /** canonical → wire */
  encode(req: CanonicalRequestEnvelope, ctx: RequestContext): EncodedRequest;
  /** wire → canonical */
  decodeResponse(raw: unknown, ctx: RequestContext): CanonicalResponseEnvelope;
  /** canonical → wire */
  encodeResponse(res: CanonicalResponseEnvelope, ctx: RequestContext): unknown;

  /** usage 抽取：必须处理"输入计费、输出免费"（pricing_state） */
  extractUsage(raw: unknown): CanonicalUsage;
}
```

**与 chat adaptor 的关键差异**：
1. 没有 `tools` / `tool_choice` / `thinking` / `response_format` —— decision 不做这些；
2. **必须实现 `pricing_state`**（见 §6.4）；
3. **必须实现降级路径**（见 §6.3）——因为 decision 上游不是每个部署都有；
4. 批量语义：`questions[]` 一次发出，响应 `answers[]` 按 `question_id` 回填。**部分上游失败时的语义要明确**：是整个请求失败，还是返回部分答案 + 每题的 `error`？canonical 选**后者**（`DecisionAnswer` 可带 `raw.error`），并在 `warnings` 记 `partial_answers`。

### 6.2 三家字段映射表（已按官方 API reference 回填）

> 依据 2026-11 官方 API reference，来源见 [../sources.md](../sources.md) §5。
> 端点与 model id：Gemini `POST https://generativelanguage.googleapis.com/v1beta/decisions`（model `gemini-decision-1`，auth `x-goog-api-key`）；Jev `POST https://api.typesafe.ai/v1/systemone`（model `jev-1.14.0` / alias `jev-latest`，auth Bearer）；OpenAI `POST https://api.openai.com/v1/decisions`（model `gpt-6-luna`，auth Bearer；Azure 变体 `<res>.openai.azure.com/openai/v1/decisions`）。

#### 6.2.1 请求映射（canonical → 三家）

| canonical | Gemini Decisions | Jev (TypeSafe SystemOne) | OpenAI Decisions |
|---|---|---|---|
| 端点 | `/v1beta/decisions` | `/v1/systemone` | `/v1/decisions` |
| `model` | `gemini-decision-1`（唯一） | `jev-1.14.0` / `jev-latest` | `gpt-6-luna`（唯一） |
| `content[].text` | `input` 的 `text` 块 | `state`（string\|object\|array） | `input` 的 `input_text` part |
| `content[].media` | `input` 的 `image`/`audio`/`video`/`document` 块 | `assets`（可选 image map）；**需头 `TypeSafe-Danger-Zone-Images: true`** | `input_image`（`image_url` + `detail`）/ `input_json`（`data`） |
| `questions[]` | `questions`：**map<key, Question>**（1–1000，key `[A-Za-z0-9_-]+` ≤64） | `questions`：**map<name, Question>**（无独立数量上限，受 context 约束） | `questions`：**array**（1–400，每题带 `name`） |
| `questions[].id` | map 的 key | map 的 name | 数组元素的 `name` |
| `type: "binary"` | `type:"noul"` | `type:"noul"` | `type:"predicate"` |
| `type: "choice"` | `type:"choice"` | `type:"choice"` | `type:"choice"` |
| `type: "scale"` | `type:"score"` | `type:"score"` | `type:"score"` |
| `type: "rubric"` | **无对应** → 映射为 `choice` 或 `score` + `criteria` | **无对应** → 同上 | **无对应** → 同上 |
| `type: "box"`（Jev 专有） | — | `type:"box"` | — |
| `questions[].prompt` | `instructions`（仅 text） | `instructions`（string\|object\|array\|null） | `instructions` |
| `questions[].options[]`（choice） | `criteria`：**map<optionKey, 描述>**（2–255 项） | `criteria`：**map**（1–255 项） | `choices`：`[{value, description}]`（2–255，value 可 string\|boolean） |
| `questions[].scale{min,max,labels}`（scale） | `criteria`：**string[]**（2–255，建议 2–10） | `criteria`：**array**（1–10） | `levels`：`[{label, description}]`（2–10） |
| `questions[].rubric{criteria,pass_threshold}` | `criteria`（按映射后的类型） | 同 | 同 |
| `questions[].multiple` | ❌ drop + warn | ❌ drop + warn | ❌ drop + warn |
| `include_option_probabilities` | 恒返回（choice/score） | 恒返回（choice/score） | 恒返回（choice/score） |
| `include_rationale` | ❌ 不支持 | ❌ 不支持 | ❌ 不支持 |
| 上游专有旋钮 | — | `TypeSafe-Danger-Zone-Long-Context: true`（64k/req+32k/question → 262k/262k） | `prompt_cache_key` / `prompt_cache_options{mode,ttl}` / `safety_identifier` |

#### 6.2.2 响应映射（三家 → canonical）

| canonical | Gemini Decisions | Jev | OpenAI Decisions |
|---|---|---|---|
| `answers[]` 容器 | `answers`：**map（按 question key）** | `answers`：**map（按 question name）** | `answers`：**array（按 questions 顺序）** |
| `answers[].question_id` | map 的 key | map 的 name | 元素的 `name` |
| `answers[].label` | `choice`（choice）/ `score`（score）/ `noul` 0.01–0.99（binary） | 同 Gemini | `choice` / `score` / `probability`（predicate） |
| `answers[].probability` | `noul`（binary，0.01–0.99）/ `probabilities[key]`（choice）/ `probabilities[score]`（score） | `noul`（binary）/ `probabilities[name]` | `probability`（predicate）/ `probabilities[].probability`（choice/score，**数组不是 map**） |
| `answers[].confidence` | `confidence`（**含 noul**） | `confidence`（**noul 没有**；`box` 可为 `null`） | `confidence`（**predicate 没有**） |
| `answers[].option_probabilities[]` | `probabilities`：**map<key, p>** | `probabilities`：**map<name, p>** | `probabilities`：**[{value, probability}]（数组）** |
| `answers[].rationale` | ❌ | ❌ | ❌ |
| `answers[].raw` | 上游原始 answer 对象 | 同 | 同 |
| **逐题拒答** | ❌（整请求 `prompt_feedback.block_reason`） | ❌ | **✅ `{type:"refusal", name}`**——该题拒答，**其他题仍作答** |
| `box` 类型 | — | `{type:"box", box:{top,bottom,left,right}, confidence:number\|null}` | — |

**三个必须处理的映射陷阱（adaptor 实现时的硬约束）**：

1. **key-map vs array**：Gemini/Jev 的 `answers` 是按问题 key/name 的 map，OpenAI 是**按 questions 顺序的 array**。canonical 统一为 array + `question_id`，因此 OpenAI adaptor 必须**按位置对齐** `questions[]` 与 `answers[]`（位置错位 = 全盘皆错），Gemini/Jev adaptor 按 key 回填。**位置对齐必须加 round-trip 测试**（打乱 questions 顺序后答案仍对得上）。
2. **probabilities map vs array-of-objects**：Gemini/Jev 是 `{key: p}`，OpenAI 是 `[{value, probability}]`。canonical 统一为 array of `{value, probability}`。
3. **confidence 的有无不一致**：Gemini 的 `noul` **有** confidence；Jev 的 `noul` **没有**；OpenAI 的 `predicate` **连 probabilities 都没有**。canonical 的 `confidence` / `option_probabilities` 因此必须是**可选字段**（缺省省略，不填 0）——这正是 [10-canonical-schema.md](./10-canonical-schema.md) §6 规则 2「未知绝不用 0 表示」的又一实例。

#### 6.2.3 usage 映射（三家 → canonical）

| canonical | Gemini | Jev | OpenAI |
|---|---|---|---|
| `units.tokens.input_tokens` | `usage.total_input_tokens` | `usage.input_tokens` | `usage.input_tokens` |
| `units.tokens.output_tokens` | `usage.total_output_tokens`（**恒 0**） | `usage.output_tokens`（**免费但非 0**） | `usage.output_tokens` |
| `pricing_state.output` | `"free"` | `"free"` | `"free"` |
| `units.tokens.cache_read_tokens` | ❌ 无 | ❌ 无 | `input_tokens_details.cached_tokens` |
| `units.tokens.cache_write_tokens` | ❌ 无 | ❌ 无 | `input_tokens_details.cache_write_tokens` |
| `units.tokens.reasoning_tokens` | ❌ 无 | ❌ 无 | `output_tokens_details.reasoning_tokens` |
| `units.tokens.details` | `input_tokens_by_modality[]`（按 modality 拆） | — | `input_tokens_details` / `output_tokens_details` 原样 |
| `units.questions` | `questions` map 的 key 数 | `questions` map 的 name 数 | `questions` 数组长度 |
| `usage_raw` | 上游 usage 原样 | 同 | 同 |

**规则 P5b（已被三家实测验证）**：**"输出免费"有三种不同表现，绝不能假设 `output_tokens == 0`**：
- Gemini：`total_output_tokens` 恒 `0`（真 0 token，不计费）；
- Jev：`output_tokens` **非 0 但免费**；
- OpenAI：`output_tokens` 上报（含 `reasoning_tokens`）但不计费。

因此实现必须是「记真实值 + `pricing_state.output = "free"`」，**不是**「把 output_tokens 置 0」。把 Jev/OpenAI 的 output 置 0 会丢失"这次判断实际产出了多少 token"的信息，也让"上游没报 usage"与"输出免费"再次混为一谈。

#### 6.2.4 限制、延迟、错误码（路由与能力矩阵用）

| 项 | Gemini | Jev | OpenAI |
|---|---|---|---|
| 问题数 | 1–1000 | 无独立上限（受 context 约束） | 1–400 |
| choice 选项数 | 2–255 | 1–255 | 2–255 |
| score 层级数 | 2–255（建议 2–10） | 1–10 | 2–10 |
| context | 262,144 tokens | 默认 64k/request + 32k/question；`Long-Context` 头 → 262k/262k | 1,050,000（max input 922,000） |
| 延迟（官方/实测） | 150–250 ms e2e / 50–100 ms compute；**1→100 题近乎持平** | TypeSafe 自报 70–500 ms；cookbook 实测 mean 103 ms | 官方称 ~10x快于 Responses API（150 ms vs 1.6 s） |
| 免费层 | Free：输入免费 + 200 RPM / 50,000 TPM / 10,000 RPD；Tier1 1,500/1M/50,000；Tier2 5,000/4M/unlimited；Tier3 15,000/10M/unlimited | 未见免费额度文档 | 无 Decisions 专属限额表 **`[待验证]`** |
| 流式 | ❌ | ❌ | ❌ |
| 错误码 | HTTP 400 + `error.code` ∈ {`safety`,`prohibited_content`,`blocklist`,`image_safety`,`content_blocked`}；超限也 400（message 指名规则） | 400/401/413/415/422/429/529（body ≤32 MiB、嵌套 ≤64） | 标准 envelope：401/403/429(`rate_limit_error`/`slow_down`/`credit_balance_exhausted`)/500/503(`server_is_overloaded`) |
| 区域 | 仅 Gemini Developer API v1beta（Vertex/Google Cloud "coming soon"） | — | US + Europe (EEA+CH)，EU data residency，支持 ZDR/HIPAA；Azure 版 **East US 2 被排除** |
| SDK | `client.decisions.create()`（google-genai ≥3.2，`apiVersion: v1beta`） | `client.system_one()`（`typesafe_sdk` / `@typesafe-ai/sdk`） | `client.decisions.create()`（openai ≥3.26.0 py / ≥7.30.0 js） |

**「1→100 题近乎持平」是 decision 的批量优势的核心证据**——它意味着把多个判断合并成一次请求几乎是免费的（TypeSafe 实测：13 问合并 1 次调用 = 13 次单独调用的 **1/12.2 成本、1/11.8 时间**）。因此 S2/S3 的控制面判断应**攒批**，不要一个判断发一次请求。

#### 6.2.5 实现陷阱与上游选型影响（官方文档确认，adaptor 硬约束）

**陷阱 1：Gemini 会按 UTF-8 字节序对 option key 字典序排序后再求值。** 请求里 key 的顺序不影响结果；概率完全相同时取字典序最前的 key。**因此绝不能用位置性 key**（如 `none_of_the_above`、`option_1`）——字典序会改变它们的相对位置，导致"平分时选错项"。canonical 的 `DecisionOption.value` 应该是**语义化**的稳定值。

**陷阱 2：Gemini 的共享 `input` 每请求只计一次 token**，不论问题数；每问只追加自身 instructions/criteria/formatting token。这是攒批（[20-pipeline.md](./20-pipeline.md) §6.3）成本收益的根源，也意味着**把公共上下文放 `input` 而不是重复进每问的 `instructions`** 能直接省钱。

**陷阱 3：OpenAI 的 `usage.input_tokens_details.cached_tokens` / `cache_write_tokens` 已包含在 `input_tokens` 内**，不要重复相加（官方明确）。这与 chat 模态的口径一致（见 §2.2c I1）。

**陷阱 4：Jev 的 `noul` 不返回 confidence，但可自算 `|2p − 1|`。** 官方 Confidence 页给出的公式：
- Choice（n 个选项，`p_max` 为 top probability）：`confidence = (p_max − 1/n) / (1 − 1/n)`
- Score（n 层，`m` 为最可能层）：`confidence = max(0, 1 − Σ p_i·|i−m| / MAD_unif)`，`MAD_unif = (1/n)·Σ|i − (n−1)/2|`
- 官方同时警告：Choice 的 confidence 是 top probability 的线性变换，"checking both adds no independent evidence"——`(0.6,0.3,0.1)` 与 `(0.6,0.2,0.2)` 的 confidence 都是 0.4。

  **对我们的含义**：`probability` 与 `confidence` 在 choice 类型下**不是独立信息**（D8 的"分开建模"仍然对——因为 noul 类型下二者确实不同，且 canonical 要保留上游原样）。但在**消费侧**（compact/escalate/stop 判据）不要同时用两个阈值，那等于同一个信号用两遍。

**陷阱 5：媒体能力差异大，且大多有硬上限。**

| 项 | Gemini | Jev | OpenAI |
|---|---|---|---|
| 模态 | text / image / audio / video / PDF | text + PNG/JPEG（**默认关**，需 `TypeSafe-Danger-Zone-Images: true`） | text / image / JSON |
| 内联大小 | 每请求 ≤100 MB（PDF ≤50 MB） | body ≤32 MiB（压缩前后都算） | 图片 ≤128 张/请求、合计 ≤32 MB；单 URL ≤1 GiB |
| 外部 URL | Files API `file.uri` 或公开/签名 HTTPS，每个 ≤15 MB | ❌ | 公开 HTTP(S) URL；**不支持 `file_id`** |
| 结构化数据 | JSON 序列化成 text，instructions 里用反引号 key path 引用 | `state` 直接是 object/array | `input_json`（≤32 层、≤10,000 values、≤256 KiB） |

**陷阱 6：只有 OpenAI Decisions 支持 prompt caching。** Gemini 明确 "doesn't support context caching… Repeated input across requests counts in full"；Jev 无。OpenAI：隐式 breakpoint 在 shared input 末尾，可复用前缀 ≥1024 token（**questions 内容不计入该阈值**），每请求最多写 4 个 breakpoint，cache matching 考虑最近 80 个。

→ **上游选型的一个常被忽略的维度**："同一 state 反复问不同问题"的热点路径上，OpenAI Decisions 的 TCO 显著优于 Gemini/Jev；但若判断的 `content` 每次都不同（多数场景），缓存无收益，Gemini 的免费层与更低 ECE 更划算。

**陷阱 7：配额不可静态推导。** Gemini 有公开分层表（Free 200 RPM/50K TPM/10K RPD → Tier3 15K/10M/unlimited）；Jev 只在 console 可见（按 tokens/s + requests/s，无公开数字）；OpenAI 无 Decisions 专属表（只能借用 `gpt-6-luna` 的 Build/Launch/Grow，且不确定是否共享配额池）。→ 网关限流器必须是"静态表 + 运行时 429 探测"混合，不能只靠配置。

### 6.3 降级路径：用 chat 模拟 decision

**问题**：decision 上游不是每个部署都有（需要额外开通、额外计费路径、可能不在免费额度内）。但网关内部的判断需求（工具选择、compact/escalate/stop）是**始终存在**的。

**决策 D9：提供 chat 模拟 decision 的降级路径，但必须显式标记，且默认不自动启用。**

```typescript
interface DecisionDegradationPolicy {
  /** 何时启用降级 */
  mode: "never" | "on_missing_upstream" | "always";
  /** 降级用的 chat 模型（access path + model） */
  fallback_model?: string;
  /** 是否允许把"高风险判断"降级（策略检查、stop 决策默认不允许） */
  allow_degrade_high_stakes?: boolean;
}
```

**何时启用**：
- `on_missing_upstream`（**推荐默认**）：路由不到 decision 上游时降级；
- `always`：明确想省钱/省一个依赖；
- `never`：只要真 decision（高风险判断场景）。

**代价（必须写进响应与文档）**：

| 维度 | 真 decision | chat 模拟 | 代价 |
|---|---|---|---|
| 校准性 | 核心卖点 | **差**（LLM 自评置信度与真实正确率相关性弱） | 判断可信度下降；compact/escalate/stop 可能误判 |
| 延迟 | 150–250 ms | 数百 ms ~ 数 s（要生成长结构化输出） | 控制面变慢 |
| 成本 | 输入计费、输出免费 | **输入输出双向计费** | 输出 token 开始花钱 |
| 批量 | 一次最多 ~1000 题 | 要么一次问全部（输出长、易漏题），要么 N 次请求（N 倍延迟与成本） | 批量优势没了 |
| 结构化保证 | 原生 | 靠 `response_format: json_schema` | schema 违背时需重试 |

**实现要点**：
1. 降级时把 `questions[]` 渲染成一条 chat 请求：system 说明"你是判断引擎，逐题给出 label + probability + confidence"，user 放 `content[]` 的渲染结果 + 问题列表，`response_format` 用生成的 JSON Schema（含 `answers[]` 结构，每题必填）；
2. 响应解析回 `DecisionAnswer[]`；**schema 违背时重试一次**，再失败返回 `capability_unsupported` 而不是猜；
3. **响应信封必须带 `calibration: "degraded"`**（新增字段，见下），并在 `warnings` 说明用了哪个 chat 模型、为什么降级；
4. **高风险判断默认不降级**：`allow_degrade_high_stakes` 默认 `false`，策略检查 / stop 决策 / 计费相关判断必须拿到真 decision，否则明确失败。

```typescript
/** 加在 CanonicalResponseEnvelope 上（decision 模态专用） */
interface DecisionCalibration {
  /** "native" = 真 decision 模型；"degraded" = chat 模拟 */
  calibration: "native" | "degraded";
  /** degraded 时的降级原因与替代模型 */
  degraded_by?: { reason: string; model: string; chat_adaptor: string };
}
```

### 6.4 usage 归一：decision 的"输入计费、输出免费"

这是 decision 模态**最容易记错账**的地方，规则写死：

| 场景 | `units.tokens.output_tokens` | `pricing_state.output` | `warnings` |
|---|---|---|---|
| 上游明确输出免费 | 记**真实值** | `"free"` | — |
| 上游没报 output usage | 键**省略** | （缺省 = billed） | `usage_missing` |
| 上游报了但没说要钱 | 记真实值 | `"billed"` | — |

**规则 P5**：**"免费"与"未知"必须可区分。** 把"输出免费"实现成 `output_tokens: 0` 会与"上游没报 usage"混为一谈——前者是**省了钱**，后者是**账没记上**。看板会把前者显示成"0 成本"（对），把后者也显示成"0 成本"（错，静默少报）。

**兜底计量**：`units.questions{asked, answered}` 始终记录。当上游 usage 形状不明、或输出免费导致 token 口径无归因意义时，用它做成本归因与容量规划。

**reasoning / cache**：decision 模型没有 reasoning token 概念（一次前向计算），也没有 prompt cache 语义（输入不重复）。因此 `reasoning_tokens` / `cache_read_tokens` / `cache_write_tokens` 对 decision **恒省略**，不记 0。

## 7. 各 Provider 注意事项

### 7.1 OpenAI

- `max_tokens` 已在新模型上被 `max_completion_tokens` 取代；codec 按模型版本选择字段名，`raw` 保留原名。
- `parallel_tool_calls: false` 在 Anthropic/Gemini 无对应，只能 prompt 约束或事后拆轮（`warnings` 声明）。
- Responses 的 `reasoning` item 多轮回传规则 **`[待验证]`**。
- Responses 有状态（`previous_response_id` + `store`）。网关默认**不依赖**上游状态：始终发全量历史，把 `store` 关掉（除非客户端显式要）。理由：上游状态保留期（默认 30 天）与"网关要能完整 trace/重放"冲突。

### 7.2 Anthropic

- `system` 是**顶层字段**，可以是 string 或 block 数组（block 才能带 `cache_control`）。多条 system message（OpenAI 风格）映射时需合并或保留为多个 block——llm-bridge 在这里有真实缺陷（只取第一条 system message，其余丢弃，见 [docs/sources.md](../sources.md) §llm-bridge）。我们的 codec **必须**支持多 system block。
- `tool_use` block 必须**移到段尾**（AI SDK 的 `moveToolUseBlocksToEnd()` 专门处理这个硬约束，见 [convert-to-anthropic-prompt.ts](https://github.com/vercel/ai/blob/main/packages/anthropic/src/convert-to-anthropic-prompt.ts)）。
- `thinking` block 回传时 `signature` 必须保留，否则多轮报错。
- `cache_control` 是**块级**且最多 4 个 breakpoint；`ttl` 支持 5m / 1h。
- 1h / 5m cache write 在 usage 里是否分字段返回 **`[待验证]`**（影响 cache_write 计费拆分）。

### 7.3 Gemini

- `functionCall` **没有 id**。canonical 的 `ToolUsePart.id` 由网关合成（`call_<ulid>`），映射表存 `ctx.state.tool_id_map`。回传 `functionResponse` 时按 name + 序号或映射表匹配 **`[待验证]`**。
- `finishReason` 里 `STOP` 可能同时表示"正常结束"和"工具调用后结束"，要靠 part 里有 `functionCall` 来判别 `tool_use`。
- `thoughtSignature` 是 Gemini 3 的多轮必需字段（类似 Anthropic 的 thinking signature）。canonical 存进 `ThinkingPart.signature`。**`[待验证]`** 具体字段名与回传要求。
- `cachedContent` 是**资源级**缓存（要先创建 cache 再引用），与 Anthropic 的块级断点模型不同。canonical 用 `CacheControl.cache_name` 承载。
- `systemInstruction` 被缓存后视为不可变，"cannot preserve an uncached dynamic tail inside that same message"（OpenRouter 文档，见 [docs/sources.md](../sources.md) §OpenRouter）——动态 system 尾巴要放到 user 消息里。

### 7.4 OpenAI Responses（作为入站格式）

- `input` 是 item 数组而非 messages；`instructions` 是 system。codec 要处理 item 类型判别（`message` / `function_call` / `function_call_output` / `reasoning` / `item_reference`）。
- 工具调用 id 用 `call_id`，与 Chat 的 `tool_calls[].id` 不同名。canonical 统一为 `ToolUsePart.id`。
- 内置工具（`web_search` / `file_search` / `code_interpreter`）映射为 `BuiltinTool`（见 [50-builtin-search.md](./50-builtin-search.md)）。

---

## 8. Open Questions

1. **Q1（最高优先级）**：OpenAI / Gemini 的 `input_tokens` 是否已含 cache read 部分。直接决定计费双算/少算。验证方式：同一长 prompt，第一次（未缓存）与第二次（已命中）对比 `prompt_tokens` 与 `cached_tokens` 的关系。
2. **Q3**：Gemini `functionCall` 无 id，`functionResponse` 的匹配机制（name + 序 vs 网关映射表）。
3. **Q10**：Anthropic 1h/5m cache write 是否分字段返回。
4. **Q2**：OpenAI Responses `reasoning` item 的多轮回传规则（是否必须原样、字段名）。
5. Gemini `thoughtSignature` 的确切字段名与回传要求。
6. Gemini `usageMetadata.toolUsePromptTokenCount` 的归属（是 input 的一部分还是独立项）。
7. 非 chat 模态各家的 usage 原始字段（[15-modalities.md](./15-modalities.md) §9 Q5）。
8. OpenAI `audio/speech` 是否支持流式分片（决定 TTS 流式能力矩阵该栏）。
9. **Q21（decision）**：三家 decision API 的确切字段名与嵌套（问题类型枚举、选项集、`probability` / `confidence` / per-option probabilities、usage 形状、错误码）。**这是 decision adaptor 开工的前置依赖。**
10. **Q22（decision）**：Gemini Decisions 的免费额度与可用区域；Jev 在 TypeSafe / OpenRouter 上的确切模型 id 与计价。
11. **Q23（decision）**：decision 模型是否真的不能做 chat（需官方文档确认，非产品定位推断）。
12. **Q24（decision）**：chat 模拟 decision 的校准性损失有无公开基准（决定降级路径是否值得默认开启）。
13. **Q25（decision）**：部分问题失败时的上游语义（整个请求失败 vs 部分答案 + 每题 error）——canonical 已选后者，需确认三家都支持。
