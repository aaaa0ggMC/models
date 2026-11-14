# AgentGateway · Phase 1 实现报告

> 分支 `dsh-threads/4-f8d764` ｜ 基线 `c4bd336`（Merge review-issue fixes #1-#8）｜ 10 个 commit
> 运行说明见 [`IMPLEMENTATION.md`](IMPLEMENTATION.md)；设计文档在 [`docs/design/`](docs/design/)（00–70 共 15 篇）。
> 本报告只描述**已实现**的行为；遇到文档矛盾/歧义按约定未改文档，全部记在 §7。

---

## 1. 目录结构与模块职责

目录命名以 [`docs/design/00-overview.md`](docs/design/00-overview.md) §4.2 的模块表为唯一事实来源。

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `ir/` | **AG-IR canonical 类型**（唯一中间表示）+ JSON Schema + canonical 夹具。按模态拆 22 个文件 | `envelope.ts`（信封 + RawEnvelope）、`chat.ts`、`decision.ts`、`tts/asr/image/embedding/rerank/moderation/video.ts`、`stream.ts`、`usage.ts`、`capability.ts`、`credential.ts`、`plugin.ts`、`context.ts`、`trace.ts`、`guards.ts`、`clock.ts`、`format.ts`、`diagnostic.ts`、`error.ts`、`media.ts`、`json-schema.ts`、`modality.ts`、`index.ts`（唯一出口） |
| `ir/schema/ag-ir-1/` | 按 10 §8 布局的 JSON Schema（9 个文件） | `root.schema.json`（ajv 入口）、`envelope/chat/decision/media/usage/parts/tools/json-schema` |
| `ir/fixtures/` | canonical 夹具（ajv 校验用，6 个） | `chat.{basic,multimodal,tools,thinking,unknown-part}.json`、`decision.basic.json` |
| `di/` | DI 容器 + 跨切面基础设施端口 + 配置层 | `container.ts`、`tokens.ts`、`ports.ts`、`config.ts`、`index.ts` |
| `adaptors/` | 每 (格式, 模态) 一对 mapper | `types.ts`（`Adaptor` 契约 + `RequestEnvelopeShallow`）、`registry.ts`、`index.ts`（集中显式注册）、`openai-chat/`、`anthropic-messages/`、`fixtures/`（25 个） |
| `gateway-core/` | 阶段编排 + 路由 + 传输 | `pipeline/`（`runner.ts` + `types.ts` + `stages/s0..s10` + `fast-path.ts` + `lazy-decode.ts` + `tool-loop.ts` + `retry.ts` + `usage-sniffer.ts` + `sink.ts`）、`context.ts`、`router.ts`、`transport.ts` |
| `plugins/` | hook 运行时 | `host.ts`（5 hook 调度 + 故障隔离） |
| `metering/` | 用量/计费旁路 | `usage-record.ts`、`emitter.ts`、`memory-emitter.ts` |
| `credentials/` | 上游凭据 + 能力矩阵 | `resolver.ts`、`capability-registry.ts` |
| `http/` | 最小 HTTP ingress | `server.ts` |
| `composition-root.ts` | **组合根**（全仓唯一装配处） | `createGateway(options)` |
| `tests/` | vitest（10 个文件） | 见 §4 |
| `scripts/` | `check-json-schema.mjs`（ajv 校验）、`e2e-demo.mjs`（端到端演示） | — |

> **`di/` 与 `http/` 不在 00 §4.2 的模块表里**——那张表列的是领域模块，这两个是横切基础设施。
> 已在 `IMPLEMENTATION.md` 与代码注释里标明，未改文档（记入 §7）。

---

## 2. DI 装配方式与理由

### 2.1 方式

- **每个能力定义接口，具体实现经构造函数注入**：
  codec（`adaptors/types.ts` 的 `Adaptor`）、plugin host（`plugins/host.ts`）、
  usage emitter（`metering/emitter.ts`）、credential resolver（`credentials/resolver.ts`）、
  capability registry（`credentials/capability-registry.ts`）、router（`gateway-core/router.ts`）、
  transport（`gateway-core/transport.ts`）、clock / logger / metrics / id generator /
  config（`di/ports.ts`）。
- **组合根统一装配**：`composition-root.ts` 的 `createGateway(options)` 是全仓库唯一
  "知道所有具体实现"的地方，也是测试替换任一依赖的入口。
- **容器只做三件事**（`di/container.ts`，约 120 行）：登记工厂、按需解析（单例语义）、
  检测循环依赖。`registerSingleton` / `register` / `registerValue` / `resolve` /
  `createChild`（测试派生隔离容器）。
- **`process.env` 的直接读取只出现在 `di/config.ts` 一处**，一次性收敛成 `GatewayConfig`
  后经构造函数注入。上游 provider key 只登记**环境变量名**，值由
  `EnvCredentialResolver` 在签发请求时读取，不进任何配置对象/日志/trace。
- 测试里 `createGateway({ mode: "test", transport: new ScriptedTransport([...]) })`
  即可整体换掉上游；`container.createChild()` + `registerValue` 可换单个依赖。

### 2.2 为什么轻量自建而不是 tsyringe / injection-js

| 维度 | tsyringe / injection-js | 自建容器 |
|---|---|---|
| 依赖 | 都要 `reflect-metadata` + `emitDecoratorMetadata` | 零新增依赖 |
| ESM | NodeNext 下要额外开实验开关 | 原生 ESM |
| 错误时机 | 运行时才出现的字符串 | 编译期可见（`Token<T>` 泛型） |
| 魔法 | 装饰器自动发现，"哪些适配被真的测过"不可审查 | 装配是组合根的显式代码，可审查 |
| 体积 | 数十 KB + 反射开销 | ~120 行，无反射 |

40 §1.3 对 adaptor 注册的要求是「显式、集中、不做魔法自动发现」——同一个立场适用于 DI：
装配必须是可审查的显式代码。自建容器同时满足"全面 DI"与"零隐式全局状态"。

---

## 3. 两条拍板的落地位置（issue #8 第 3 条）

### D-fastpath-1（惰性解码）

| 问题 | 答案 |
|---|---|
| **哪些字段进了"路由必需集"** | `ROUTING_REQUIRED_FIELDS`（`gateway-core/pipeline/lazy-decode.ts`）：`source_format`（客户端格式识别）、`model`（别名解析）、`access_path_hint`（由别名表推）、`stream`（是否流式）、`request_bytes`（请求体字节长度）、`usage_locations`（响应侧 usage 信封位置）。另加 `gateway_agentic_loop`（让 Runner 不物化就能判断要不要进工具循环）。 |
| **惰性物化的触发点** | ① S3 插件链（**有请求侧插件时**；无插件则 S3 是纯 no-op）；② S4 Encode（**非 fast path 时**）；③ S6 ProviderDecode（非 fast path 时，响应侧对应点）；④ 工具循环判定前（仅当廉价信号表明要进循环）。 |
| **fast path 下响应侧** | 只抽 usage 信封 + 直通原始字节，**不做结构转换**；流式下 S6 只"布防"嗅探器，S8 边收边发并旁路喂嗅探器（零延迟透传）。 |
| **代价观测** | `PipelineState.materialized` + `pipeline.materialize` metric（按阶段打点），出在 `PipelineOutcome.materialized` 与演示输出里。 |

### D-fastpath-2（fast path 准入）

- **准入条件在哪里计算**：`gateway-core/pipeline/fast-path.ts` 的 `createFastPathAdmission(pluginHost)`，
  由**组合根在启动时创建一次并缓存**（`createGateway()` 内）。
- **条件**：没有启用任何 `scope: "full-canonical"` 的请求侧插件。`PluginManifest.scope`
  缺省按 `full-canonical`（安全侧优先）。
- **失效重算**：`PluginHost` 的 `register` / `unregister` / `setEnabled` 自动广播 `onChange`，
  admission 订阅后清缓存。运行中增删插件即时生效，有测试锁住。

---

## 4. 测试结果

```
npm run typecheck    tsc --noEmit -p tsconfig.json          0 错误
npm test             vitest run                            288/288 通过（10 个文件）
npm run schema:check ajv 编译 9 个 schema + 校验 6 个夹具     全部通过
npm run lint         eslint .                               零输出
npm run format       prettier --check                       全绿
npm run build        tsc -p tsconfig.build.json             通过
AG_PORT=18801 npm run demo                                   两条路径均跑通
```

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/ir-schema.test.ts` | 15 | ajv 校验全部夹具；「未知≠0」「免费≠未知」「未建模字段必须进 raw.unmapped」「BuiltinTool.name 只用稳定名」；**TS ↔ schema 字段级 parity（防漂移）** |
| `tests/di.test.ts` | 8 | 容器单例/多例/替身注入/循环依赖检测/子容器派生；MemoryMetrics/SequentialIdGenerator/fixedClock |
| `tests/fast-path.test.ts` | 12 | D-fastpath-1（浅解析不物化、路由必需集、首字节后禁改状态码）与 D-fastpath-2（准入 7 种组合 + 缓存失效重算 + §4.1 四条件） |
| `tests/plugin-host.test.ts` | 14 | 5 hook 调度顺序、ShortCircuit 语义、故障隔离、fatal、超时、注册期校验、onError 不改变控制流 |
| `tests/metering.test.ts` | 16 | 异步非阻塞、drop 策略、可重放、batchSize 自动下沉、UsageRecord 绝不含敏感字段 |
| `tests/usage-sniffer.test.ts` | 14 | 四家 usage 到达方式、增量喂入与批处理等价、超限标 truncated 而不记 0、流尾 usage 必达、SSE 跨 chunk 分片 |
| `tests/router-retry.test.ts` | 26 | fast path 两条件、参数兼容性预检、流式 mode=none 拒绝、attempt_plan、别名热更新；20 §7.3 决策矩阵逐行 + capability_rejected 约定 |
| `tests/pipeline-e2e.test.ts` | 9 | fast path 透传、跨格式慢路径 + usage 归一、流式 SSE、错误映射（500/400）、插件短路、D-fastpath-2 两方向、工具调用多轮循环 |
| `adaptors/openai-chat/codec.test.ts` | 66 | 40 §1.5 六条 round-trip + decodeEnvelope + 格式专属不变量 + 20 §7.2 错误 type 表 |
| `adaptors/anthropic-messages/codec.test.ts` | 105 | 同上 + temperature 丢弃带诊断、D7c 移段尾、usage 归一（total 自算 + 5m/1h details）、reasoning_in_output、流式 usage 合并、BuiltinTool→native、effort 阈值表全档、跨格式 stop_reason 守卫 |

### 集成期修掉的真实缺陷（都有测试锁住）

1. **fast path 与网关工具循环冲突** → 循环静默不前进。修：启用循环时显式 `disableFastPath`。
2. **工具循环中间轮次把应答写给客户端** → 触发 20 §S8「首字节后不能改状态码」。修：循环内只跑 S4→S7，结束后跑一次 S8。
3. **工具循环的 APPEND_TURN 全部丢失** → `lazy.full()` 返回 memoize 的原始请求。修：`PipelineState.canonical_override`。
4. **S3 无条件物化** → fast path 永远付全量解码代价。修：无请求侧插件时 S3 是 no-op。
5. **流式 fast path 的 part 边界被折叠成空 text delta** → 丢失 Anthropic `content_block_start`。修：`ir/stream.ts` 补 `PartBeginData`/`PartEndData`，s6/s8 忠实体搬运。
6. **Anthropic 流式 usage 双算** → `message_start.output_tokens` 是占位值，相加恒多 1。修：后到者按键覆盖。
7. **跨格式 `finish_reason` 泄漏** → 上游原文是别家枚举，照抄即非法值。修：`source_provider` 守卫。
8. **SSE 事件被 TCP 分片切断时嗅探失败** → 修：嗅探器维护 pending 缓冲。
9. **Anthropic `message_start` 的 usage 漏读**（嵌在 `message.usage`）→ 输入侧计量整个丢失。修：两处都取。

---

## 5. 如何运行

```bash
npm install
npm test             # 288/288
npm run typecheck    # 零错误
npm run demo         # 起 HTTP ingress + mock 上游，端到端往返演示
```

`npm run demo` 演示两条路径（上游全部是 DI 注入的 `ScriptedTransport`，不起真实 API）：

- **A**：起 `http/server.ts`，`POST /v1/chat/completions`（客户端 OpenAI Chat 格式），
  同格式上游 → **fast path**（`materialized=false`）；
- **B**：直跑 `PipelineRunner`，客户端 **Anthropic Messages** 格式、上游 **OpenAI Chat**
  → 慢路径 + usage 归一（`conversion_chain=["anthropic.messages","openai.chat"]`）。

要打真实上游：设置 `AG_OPENAI_API_KEY` / `AG_ANTHROPIC_API_KEY`，把路由表的别名指向
`openai` / `anthropic` access path，并在 `createGateway({ transport: new FetchTransport() })`
里换掉 ScriptedTransport。环境变量清单见 [`.env.example`](.env.example)。

---

## 6. Deferred（本轮范围外，未实现）

| 项 | 归属 | 说明 |
|---|---|---|
| `storage/` 加密存储与 KEK/nonce 细节 | Phase 4 | 任务书明确不做；#8 的 6 个设计风险待仓库主人拍板 |
| `webui/` | Phase 4 | fork LibreChat 改造 |
| decision / image / tts / asr 的 **adaptor** | 后续 | **canonical 类型已全部建好**（`ir/decision.ts` 等 + JSON Schema），adaptor 按需写 |
| 真实 credential OAuth 流程 | Phase 2 | 只建了接口与 env/keyring 两档实现 |
| 内置搜索实现 | Phase 4 | canonical 的 `BuiltinTool` 已建模，执行器未实现 |
| 商业化功能 | 非目标 | 00 §2.2 第 1 条 |
| 数据面 virtual key 鉴权 / 限流 | `auth/` 模块 | S0 用 `PERMISSIVE_AUTHENTICATOR` 占位，接口已留（`S0Options.authenticator`） |
| 健康检查 / 熔断器 / 粘性会话键 / 预算预检 | Phase 2 | S2 的 `RouteHooks` 已做成可注入接口，Phase 1 用 no-op |
| 定价表与成本计算 | Phase 2 | `UsageRecord.cost` 恒 0（60 §4.1） |
| ts-json-schema-generator | — | JSON Schema 目前手写 + `tests/ir-schema.test.ts` 的字段级 parity 兜住漂移 |
| Tier-2 消息内容持久化 | Phase 4 | `persist_messages` 默认 off，`UsageRecord.body_ref` 恒不出现（有测试断言） |
| 仓库既有文件的 prettier 格式化 | 单独清理任务 | `.prettierignore` 已把 `docs/` 等排除，避免无关 diff 混进实现改动 |

---

## 7. 文档问题清单（未改文档，仅记录）

### 7.1 类型/ schema 缺口（已在 `ir/` 补上，需文档回填）

| # | 问题 | 处理 |
|---|---|---|
| 1 | 10 §2 的 `CanonicalStreamFrame` 与 25 §2 的 `StreamFrame` 是同一类型两个名字 | 以 25 §2 为唯一形状定义，`CanonicalStreamFrame` 降为兼容别名 |
| 2 | `RawEnvelope` 没有 `finish_reason_provider`，而 10 §9.3 注意 3 要求原文可回写对账 | 补为一等字段（此前两套约定分塞 unmapped / nodes） |
| 3 | `FrameData` 没有 part 级负载，而 20 §S6 有 `part.begin` / `part.delta` / `part.end` | 补 `PartBeginData` / `PartEndData`，`DeltaData` 加 `index` |
| 4 | `EndData` 没有 `usage`，而 20 §S6 的 finish 事件带 usage | 加可选 `usage` 字段 |
| 5 | `TokenUsage.pricing_state` 原文是 `Record<5 槽, …>`，但 10 §6.1 规则 5 说"缺省视为 billed" | 改 `Partial<Record<…>>`（只声明 output=free 不必写全五槽） |
| 6 | `RequestEnvelopeShallow`（D-fastpath-1 需要）在 40 §1.1 的接口里不存在 | 作为 `Adaptor` 的**可选**第 9 个能力加入，并在注释里说明这是对 §1.2「8 个方法不多不少」的唯一放宽 |

### 7.2 同名类型重复定义（本轮合并为唯一定义）

| # | 类型 | 原重复处 | 统一到 |
|---|---|---|---|
| 1 | `ModalityKind` | 10 §3.1 / 25-streaming（漏了 decision） | `ir/modality.ts` |
| 2 | `BuiltinTool` | 10 §4.3 / 50 §2.1（含厂商专有名） | `ir/chat.ts`，厂商版本串收进 `native.provider_tool_type` |
| 3 | `CapabilityEntry` | 15 §7 / 45 §6.2（两套键） | `ir/capability.ts`，以 45 §6.2 的 `(access_path, model, modality)` 为主干，合并 15 §7 的 `usage_units` / `framing` |
| 4 | `Credential` | 45 §2（与 DOM 全局 `Credential` 同名会 TS2300） | `ir/credential.ts` 改名 `UpstreamCredential`（45 §2 已建议） |

### 7.3 文档自相矛盾 / 歧义（按更新或更具体的指令实现，记录待文档回填）

| # | 矛盾 | 采用 |
|---|---|---|
| 1 | **`BuiltinTool` 版本串字段名**：50 §2.2 / 10 §9.4 写 `raw.provider_tool_type`，但 `BuiltinTool` 没有 `raw` 字段，且 00 §5 术语表是 core/native/raw 三分法 | `native.provider_tool_type`（任务书也指定厂商专有名进 `native`） |
| 2 | **40 §2.1 vs 10 §9.2 的 `cache_write_tokens`**：§9.2 响应表 OpenAI Chat 列「—」，§2.1 列了 `prompt_tokens_details.cache_write_tokens` | 按 §2.1（20 §4.3 的去重说明明确 §2.1 为唯一事实来源） |
| 3 | **流式 usage 合并语义**：40 §2.3 说"必须合并"但没说相加还是覆盖 | 后到者按键覆盖（`message_start.output_tokens` 是占位值，相加会双算） |
| 4 | **流式 finish_reason 位置**：40 §1.5 要求事件序列等价，但 wire 里 finish chunk 在 usage chunk 之前，canonical 的 end 帧是流尾汇总帧 | finish_reason 在自己的 wire 位置单独出帧，end 帧仍是流尾 `{finish_reason, usage}` |
| 5 | **10 §6.1 规则 4**（total 与 input+output 不一致时记 warning）在 usage 对象里没有 warning 通道 | 透传上游 total，未记差异 warning（待文档给通道） |
| 6 | **40 §1.1 的 `decodeStream` 入参粒度**未定义 | 实现同时吃 block / 整段文本 / Buffer / 已解析对象；建议文档定死 |
| 7 | **`reasoning_effort: "none"` 语义**：10 §9.1 映射到 `thinking.effort`，但 OpenAI 的 "none" 是关推理 | `enabled = effort !== "none"`（仓库主人拍板） |
| 8 | **Anthropic `metadata` vs `params.user`**：10 §9.1 两者都没列对应关系 | `params.metadata` → `metadata` 透传；`params.user` → drop + warning（避免碰撞） |
| 9 | **`tool_choice` 的 Anthropic `any`** 语义强于 OpenAI 的 `parallel_tool_calls: true`（40 §7.1 标待验证） | 未做特殊处理，记录待验证 |
| 10 | **Q8 `additionalProperties: false` 是否导致频繁报错**（10 §10） | schema 全开 `additionalProperties:false`（§8 硬约束），前向兼容靠 `UnknownPart` + `raw.unmapped`，两者均有测试 |
| 11 | **`di/` 与 `http/` 不在 00 §4.2 模块表** | 作为横切基础设施新增，已在代码注释与 `IMPLEMENTATION.md` 标明 |
| 12 | **`ChatPayload` 与信封 `kind` 不是判别式联合**（10 §3.2 第 7 条硬约束导致） | `ir/guards.ts` 提供 `asChatPayload` 等结构化收窄，避免各处写断言 |

### 7.4 仍开放的文档问题（本轮未触碰）

- **Q1**（最高优先级）：OpenAI `prompt_tokens` 是否已含 `cached_tokens` —— 直接影响计费双算。
  代码按 40 §2.2c I1 的结论实现（读 LiteLLM 源码：含 cached、不含 cache_write），
  并在 `usage_raw` 与注释里标明这是待实测复核的假设。
- **Q2 / Q3 / Q10** 等见 00 §8 与 10 §10 的登记表，均未在代码里做猜测性实现。

---

## 8. 分支与 commit

- **分支**：`dsh-threads/4-f8d764`（自有 worktree，**未 push、未合并 main**）
- **基线**：`c4bd336`（Merge review-issue fixes #1-#8）
- **10 个 commit**：

| commit | 内容 |
|---|---|
| `3e07e9f` | `feat(ir)`：AG-IR canonical 类型落地为真实 TS 文件 + 工程骨架 |
| `574a9fb` | `feat(gateway-core)`：DI 容器 + 组合就绪的 pipeline S0–S10 + 插件 host + 计量发射器 |
| `0ebbb7f` | `feat(http,composition-root,tests)`：HTTP ingress + 组合根 + JSON Schema 层 + 测试套件 |
| `510125b` | `fix(pipeline)`：流式 fast path 改边收边发 + 修正 S9/S10 重复执行 |
| `1dc0cda` | `test(pipeline)`：补 usage 嗅探器 / 路由 / 重试矩阵测试，修两处嗅探缺陷 |
| `0002fb1` | `fix(ir,plugins)`：插件接口允许异步返回 + pricing_state 改 Partial + 测试纳入 typecheck |
| `aa5eff0` | `chore`：prettier 统一风格 |
| `8059425` | `feat(pipeline,ir)`：接入两个 codec，修集成期暴露的六个真实缺陷 |
| `b408738` | `chore`：e2e 测试去掉 any + schema 补 `finish_reason_provider` |
| `04e00c8` | `feat(adaptors)`：落地 `openai.chat` 与 `anthropic.messages` 两个双向 codec |

### 隐私检查

每个 commit 前都跑了 `privacy-scan --staged --fail-on any`。命中项**全部逐条确认为误报**，
理由写在对应 commit message 里：

- `di/container.ts` 的 `token.key` —— DI 依赖令牌的字符串键（"Clock" / "Logger"），不是密钥；
- `credentials/resolver.ts` 的 `authHeadersFor(accessPath, secret)` —— **参数名**叫 `secret`，
  函数消费的是运行时由 env/keyring 读入的值，本身不含硬编码凭据；
- `adaptors/openai-chat/codec.ts` 的 `name:` —— JSON Schema 与 function tool 的**字段名**，
  不是人名。

仓库内无真实 token / 凭据 / 内网 IP / 绝对 home 路径 / 个人信息；上游 key 只出现环境变量名。
