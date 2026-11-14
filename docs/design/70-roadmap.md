# 70 · 分阶段 Roadmap

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：本文档其余全部

## 0. 路线图的组织原则

两条原则决定了下面的分期：

1. **canonical 一次做全，adaptor 按需写。** Phase 1 就把 canonical 的穷尽普查（[12-coverage-survey.md](./12-coverage-survey.md)）与 round-trip 测试框架落地，确保"新增 adaptor 永远不需要改 schema"；之后每个新 adaptor 是独立小任务（[40-provider-adaptors.md](./40-provider-adaptors.md) §1.6 的检查清单）。
2. **先把"不可信"的部分做扎实。** fast path 透传、usage 双轨、加密与开关——这些错了会静默出错或泄漏，优先级高于功能广度。

## 1. Phase 0 · 调研与设计定稿（本文档的输入）

> **编号修正（review #5）**：原文这里没有 `## 1.` 标题，Phase 0 的内容挂在 `## 0.1` 下面，导致全文编号从 0.1 直接跳到 2，
> 读者按 `§N` 引用时找不到 `§1`。现已把 Phase 0 独立成 `## 1.`，阶段总览降为 `### 1.1`。
> 另：00 §6 文档索引写的"Phase 0–5"与此处一致（Phase 0 是本文档自身）。

### 1.1 各阶段总览

| Phase | 主题 | 核心交付物 |
|---|---|---|
| 1 | 骨架与最小闭环 | canonical + 3 个 chat adaptor + fast path + round-trip 框架 + 计费管道 v1 + 凭据模型 v1 |
| 2 | 第二个 provider + 计费口径 | Gemini adaptor + usage 归一完整 + 流式全链路 + dog-fooding Tier-1 |
| 3 | 插件系统与长上下文 | 5 hook + acp-kernel adaptor + 网关工具循环 |
| 4 | 内置搜索 + 多模态 v1 + decision + 加密存储 | web_search + 多模态示例 adaptor + **decision adaptor + 降级路径** + Tier-2 加密 + 前缀压缩 + WebUI |
| 5 | 多模态补全 + 运维面 | 按需 adaptor + 能力矩阵三态 + 看板 + 备份恢复 |

#### 1.1.1 版本标签 ↔ Phase 映射表

00 §2.1 用 `[v1]` / `[v1.5]` / `[later]` 标注能力，本文用 Phase 0–5 排期，**对应关系如下**（此前没有这张表，直接导致下面 4 处冲突）：

| 00 的版本标签 | 落入的 Phase | 说明 |
|---|---|---|
| `[v1]` | Phase 1 + Phase 2 | chat 三件套 + fast path + 计费管道 v1 + 凭据 v1（P1）；Gemini 作为"第二个 provider"在 P2 |
| `[v1.5]` | Phase 3 + Phase 4 | 插件系统与长上下文（P3）；内置搜索 + 多模态 v1 + decision + 加密存储 + WebUI（P4） |
| `[later]` | Phase 5 | 按需 adaptor、Rerank/Moderation/Video 模态、OAuth 登录 |
| —（不在 00 表里） | Phase 0 | 本文档本身：调研 + 设计定稿 |

**按这张表修正的 4 处冲突（review #6）**：

| # | 冲突 | 00 原标注 | 70 原排期 | 处理 |
|---|---|---|---|---|
| 1 | `openai.embeddings` adaptor | 00:154 标 **[v1]** | 70:108 排在 **Phase 4**（"多模态 v1"里） | **改为 [v1.5] / Phase 4**。理由：embedding 不属于"chat 三件套"的最小闭环，且 00 §2.1 已把"多模态示例 adaptor"整行标 [v1.5]；把 embeddings 单独提到 [v1] 没有对应交付物 |
| 2 | `gemini.generateContent` adaptor | 00:155 标 **[v1.5]** | 70:15/63 排在 **Phase 2** | **改为 [v1.5] / Phase 2**，并在 00 §2.1 补一句"`[v1.5]` 的能力可能落在 Phase 2（Gemini 作为第二个 provider 提前做）"——**版本标签是能力档次，Phase 是排期，二者不是一对一**；本表即二者的映射 |
| 3 | 控制面本地认证 + passkey | 00:152 标 **[v1]** | 唯一使用方 WebUI 是 **[v1.5]**（00:161） | **保留 [v1]**，但注明"控制面认证在 P1 就实现（Phase 1 交付物里有它），WebUI 到 P4 才接；中间由 CLI/脚本消费"——不是依赖倒置，是"能力先于其消费者就绪" |
| 4 | 凭据加密入库的密钥档位 | 70:58 要求**凭据 Phase 1 就加密入库** | 密钥体系（65）排在 **Phase 4**（70:112） | **明确 Phase 1 用哪一档密钥**：见下方"加密为何不在 Phase 1"的补充说明 |

**交付物**：

- [docs/sources.md](../sources.md)：全部调研来源 + 结论 + license 备注
- [docs/design/](./00-overview.md) 全套设计文档（本文档所在目录）
- 能力矩阵初版：access_path × model × modality × streaming × usage 口径（三态：已实现/计划/按需）
- canonical 覆盖矩阵初版（[12-coverage-survey.md](./12-coverage-survey.md)）：主流厂商各模态特性并集
- 一份"口径差异清单"：四种格式的字段级差异 + 无法无损转换的点

**验收标准**：

- 每个 mapping 决定都能追溯到官方文档 URL；标"待验证"的点有明确验证方式
- canonical schema 的 TS 类型 + JSON Schema 可被 `tsc` / `ajv` 编译校验通过 —— **`[待类型抽取后启用]`**：类型目前只写在 Markdown 代码块里，跨文档已有重复定义与冲突（review #3 用 tsc 实测：`ModalityKind` 定义两次、`BuiltinTool.name` 两份、单篇 22 处 `Cannot find name`）。**先把类型抽成 `ir/` 下的真实 `.ts` 文件（[10-canonical-schema.md](./10-canonical-schema.md) 页眉的提案），再把这条验收标准与 CI 的 tsc/ajv 检查打开**；在那之前本条只作为目标，不作为门槛
- 选型结论（UI、存储、压缩）各只有一个，且写了放弃其他选项的理由

## 2. Phase 1 · 骨架与最小闭环

**目标**：一条请求能从客户端走到上游再回来，可观测、可计费（粗）。

**交付物**：

- HTTP 框架 + 路由（多模态端点注册，见 [00-overview.md](./00-overview.md) §端点）
- `PipelineRunner` + **11 个阶段（S0–S10）**骨架（[20-pipeline.md](./20-pipeline.md) §2）
- `CanonicalRequestEnvelope` / `CanonicalResponseEnvelope` / `StreamFrame` 类型 + JSON Schema + round-trip 测试夹具
- **3 个 chat adaptor 写透**：`openai.chat`、`openai.responses`、`anthropic.messages`（含慢路径 + fast path 判定 + 有序偏好表）
- fast path 透传 + usage 旁路嗅探器
- 异步 usage 管道最小版：内存队列 → Tier-1 SQLite（明文，Phase 1 不加密，见下）
- 凭据模型 v1：`api_key` / `local` / `cloud_iam` 三种类型 + access path + Plan 感知路由（[45-credentials.md](./45-credentials.md)）
- 数据面 virtual key 鉴权 + 基础限流 + 控制面本地账号 + passkey（[66-auth.md](./66-auth.md)）
- `RequestTrace` 落 Tier-1
- **schema 层 round-trip 测试**：对 [12-coverage-survey.md](./12-coverage-survey.md) 登记的每一项特性跑 canonical fixture 校验

**验收标准**：

- 单元测试覆盖 3 adaptor × 各格式的 round-trip 保真度（含 `raw.unmapped` 回写、畸形 tool 参数、多 system 消息）
- 同一 provider 的 fast path 请求与直连 provider 的字节级 diff 为空（除归一化字段）
- 压测：单核 ≥ 500 rps（fast path 路径），p99 附加延迟 < 3ms
- 关闭 `persist_messages` 时，磁盘上不存在任何消息正文（有测试断言这一点）
- **"新增 adaptor 不需要改 schema"**：加一个 mock adaptor 只动 `adaptors/` 目录，`ir/` 目录 diff 为空（CI 断言）

**加密为何不在 Phase 1**：Phase 1 不落 Tier-2（默认关闭），Tier-1 是非敏感元数据，因此加密可以后置到 Phase 4 而不产生"明文敏感数据落盘"的窗口。**这是有意的排序**，不是遗漏——前提是 `persist_messages` 默认 `off` 的开关在 Phase 1 就实现并被测试锁定。凭据的加密入库在 Phase 1 就做（没有凭据网关无法工作，见 [45-credentials.md](./45-credentials.md) §5.3）。

**Phase 1 的凭据加密用哪一档密钥（review #6 冲突 4 的答复）**：Phase 1 **不引入 KEK/DEK 体系**（那是 65 §3 的 Phase 4 交付物），凭据加密改用 **C 档的简化形式**：

- Phase 1：凭据只能来自**环境变量**（`CredentialStorage.location: "env"`，`encrypted: false`）或 **OS keyring**（`location: "keyring"`，由 OS 负责加密）；
  **禁止** `location: "vault"`（加密库）在 Phase 1 出现，因为加密库本身依赖 Phase 4 的密钥体系。
- Phase 4：密钥体系落地后，`vault` 才开放，届时凭据密文与消息内容**分层存放**（45 §5.3：绝不把凭据和消息内容放同一层）。
- 验收：Phase 1 的测试断言"没有任何凭据以明文落进 SQLite"（环境变量/keyring 路径天然满足），而不是"凭据在库里是密文"。

## 3. Phase 2 · 第二个 provider + 计费口径

**目标**：把"统计口径错位修正"的价值做实。

**交付物**：

- 第 4 个 chat adaptor：`gemini.generateContent`（含 `thoughtSignature` 回传、grounding metadata 抽取、`functionCall.id` 映射）
- usage 规范化完整实现 + [40-provider-adaptors.md](./40-provider-adaptors.md) 口径表落地（含 token 双轨命名）
- 双路计量（上游 usage + 自估算）+ `usage_mismatch` 告警（[25-streaming.md](./25-streaming.md) §8）
- 定价表 + 成本计算（整数微美元）+ cache write 按 TTL 分档 + catalog base/overlay
- 流式 SSE 全链路：chat 4 格式互转的流式（含 `part.begin/delta/end` 折叠）
- 错误映射 + 重试/fallback 矩阵（[20-pipeline.md](./20-pipeline.md) §7.3）+ `capability_rejected: prompt_too_long` 约定 + 流式空闲超时
- dog-fooding agent 工具集 v1（Tier-1：`usage_query` / `cost_report`）
- 凭据模型 v1.5：`oauth_device_code`（OpenAI Codex / xAI SuperGrok）+ 设备码登录流程 + 过期预警 + 自动降级（[45-credentials.md](./45-credentials.md) §5）

**验收标准**：

- 用一个"同 prompt 打 4 家 provider"的对比夹具，验证 4 份 usage 归一后 token 口径一致、成本可算
- 流式转换的端到端测试：4×4 = 16 种 (client, provider) 组合的 chat 流式 round-trip，断言事件序列等价
- fallback 测试：模拟上游 429/500，验证 attempt 切换且客户端无感
- agent 能用自然语言问出"上周各模型成本"并给出与 SQL 直查一致的结果
- 订阅路径配额耗尽 → 自动降级到付费路径，且 `degradation[]` 有记录、看板能看到降级率

## 4. Phase 3 · 插件系统与长上下文

**目标**：插件生态立起来，billion-context 接入。

**交付物**：

- 插件运行时：manifest 校验、`order` 调度、故障隔离、超时、`ShortCircuit`、`disableFastPath`
- `onRequest` / `onResponse` / `onStreamChunk` / `onError` / `onToolCall` 全 hook
- 跨帧滚动缓冲器（[25-streaming.md](./25-streaming.md) §7.2）
- `acp-kernel` adaptor + `CompactionDriver` 抽象（含驱动可替换）
- 网关 agentic loop（工具调用多轮）+ tool id 映射表
- 插件配置的 WebUI 表单自动生成（消费 `config_schema`）

**验收标准**：

- 一个 100 轮会话的 fixture：不压缩时 `context_length_exceeded`，开压缩后成功，且 `UsageRecord.compaction` 有记录、用户 `input_tokens` 未被污染
- 压缩前后 `cache_control` 断点仍有效（缓存命中率不低于阈值）
- **压缩不破坏不透明思考块**（Anthropic `thinking.signature` / `redacted_thinking`、Gemini `thoughtSignature`、Responses `reasoning.encrypted_content`）——有专项测试
- 插件抛异常不导致 5xx；`fatal: true` 的插件按预期阻断
- fast path 关闭率可观测（"多少请求因插件/能力不支持走了转换"）有仪表盘
- 工具循环的 continue/escalate/stop 决策先用**启发式**实现（decision  adaptor 在 Phase 4 落地后切换），接口上预留 `DecisionClient` 注入点

## 5. Phase 4 · 内置搜索 + 多模态 v1 + 加密存储

**目标**：搜索与多模态打通，敏感数据落盘即加密。

**交付物**：

- `BuiltinTool{name:"web_search"}` canonical 建模 + 4 格式映射
- 两种实现模式（上游原生透传 / 网关自执行 + agentic loop）+ `max_tool_calls` 预算与"成本即停止条件"
- `SearchBackend` 抽象 + searxng 后端 + 缓存 + 引用编号
- 多模态 v1（方法论 + 每模态一个完整示例）：`tts`（OpenAI + ElevenLabs）、`asr`（OpenAI Whisper）、`image`（OpenAI images）、`embedding`（OpenAI）
- **decision 模态 v1**：`gemini.decisions` adaptor（首选，有免费层 + 最低 ECE）+ chat 模拟降级路径（`calibration:"degraded"`）+ `DecisionClient` 注入点接通工具循环的路由/compact-escalate-stop 判断；**默认开启攒批**（[20-pipeline.md](./20-pipeline.md) §6.3）
- 跨模态流式：统一帧信封 + SSE 命名 + 三种上游形态桥接 + WS 透传代理（[25-streaming.md](./25-streaming.md)）
- **Tier-2 加密存储落地**：SQLite + 整库加密 + 列级信封加密 + 分层开关 + 脱敏 + 保留策略 + 前缀压缩（[65-storage-and-retention.md](./65-storage-and-retention.md)）

**验收标准**：

- 4 种客户端格式请求"搜索"，分别在"上游支持/不支持"两种 provider 上都得到带引用的答案，且 fast path 在支持侧不被破坏
- TTS 流式：首包延迟 < 上游直连 + 50ms；客户端断开后上游被取消、计费只含已下发音频秒数
- ASR 实时：透传模式下 WS 双向正常；转换模式下 interim 的 `revision` 语义正确
- 开启 `persist_messages` 后：数据落盘即密文；用错误口令无法解密；导出文件可在另一台机器用正确口令恢复
- 前缀压缩实测压缩率达到 [65-storage-and-retention.md](./65-storage-and-retention.md) §5.3 的量级估计（原引 60 §7.3，该节已去重删除）
- **decision**：`/v1/decisions` 端到端跑通（多模态输入 + 批量问题 + 逐选项概率）；**三个映射陷阱各有 round-trip 测试**（map vs array 的 answers/probabilities、打乱 questions 顺序后答案仍对得上、confidence/probability 可选性）；**`usage` 三种"输出免费"表现都被正确处理**（Gemini 恒 0 / Jev 非 0 但免费 / OpenAI 上报不计费）；**Gemini option key 不用位置性命名**（字节序排序会改变相对位置）；上游只有 chat 时降级生效且响应带 `calibration:"degraded"`；**策略检查类判断在降级状态下明确失败而非静默用 chat 顶替**（有测试）；`usage` 正确区分"输出免费"（`pricing_state.output="free"`）与"上游没报 usage"（键省略 + warning）
- WebUI v1：fork LibreChat 完成 rebrand + `/gateway` + `/usage` + `/plugins` 三个路由

## 6. Phase 5 · 多模态补全 + 运维面

**目标**：达到可长期自用；新增 adaptor 全是独立小任务。

**交付物**：

- 按需补 adaptor：每个走 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.6 的检查清单，独立任务、独立验收
- 能力矩阵驱动的路由拒绝/降级（[25-streaming.md](./25-streaming.md) §9），三态标注
- WebUI 完整：agent 对话页 + 双口径成本切换（现金 / 订阅摊销）
- 加密导出/导入、备份脚本、保留策略自动清理
- 可观测性：Prometheus 指标 + 结构化日志 + trace 查询 API

**验收标准**：

- 能力矩阵中声明的每个 (access_path, model, modality) 组合都有集成测试或显式的"未实现/按需"标记
- 看板能按多单位（tokens / characters / audio_seconds / images）与双口径分别汇总与导出
- 备份→换机→恢复流程跑通，密钥只在用户口令里
- 文档：部署手册、插件开发指南、adaptor 开发指南（即 [40-provider-adaptors.md](./40-provider-adaptors.md) §1.6 检查清单）、口径表

## 7. 明确的非目标（Non-goals）

**非目标的唯一事实来源是 [00-overview.md](./00-overview.md) §2.2**，本节不重复列举（review #5：此前两份各写一份，70 多出第 7、8 条且措辞不同，已经漂移）。
原 70 独有的两条已并入 00 §2.2（"decision 不做流式 / 不用 decision 替代 chat"、"Phase 5 前不接入开源自托管 decision 模型"），
其余以 00 §2.2 的 8 条为准。本节只保留 Phase 相关的**时间性**表述：

- **Phase 5 前不做 video 模态实现**（schema 留位，见 00 §2.2 第 6 条）。
- **Phase 5 前不接入开源自托管 decision 模型**（见 00 §2.2 第 8 条）。

## 8. 关键风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 某家 provider 改字段/废弃端点 | adaptor 失效 | 能力矩阵 + 集成测试夹具按版本锁定；契约测试跑在 CI |
| fast path 透传与插件需求冲突 | 要么丢扩展性要么丢保真 | `disableFastPath` 显式化 + 关闭率可观测 |
| 计费口径各家不一致 | 账单不可信 | 原始 usage 全留 + 双路计量 + 单价版本化不追溯 |
| billion-context license 不可商用 | 核心插件不可用 | adaptor 与驱动解耦，驱动可替换 |
| 多模态 schema 过度设计 | 延期 | 模态用 `kind` 判别 + 注册表，新增模态不改信封 |
| 加密导致密钥丢失 | 数据全丢 | 三档密钥来源 + 加密导出 + 恢复流程测试 |
| 实时 ASR 透传无法插件化 | 安全能力缺失 | 双路径设计，转换模式可随时开启 |
