# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号暂用 `0.1.0-draft`
（设计尚未定稿，不设语义化版本；`docs/design/*.md` 页眉里的 `v1.0-draft` 指设计文档自身的版本）。

## [Unreleased] — 2026-11-14 · review #1–#8 逐条处置 + #8 六条设计决定定稿

本轮把对外分发的 8 个 GitHub issue 逐条核实后落地。**每个 issue 的核实结论与证据见 issue 内的回复**；
本文只记"改了什么"。

### 修复（内容错误 / 渲染错误）

- **#1 `docs/design/40-provider-adaptors.md`**：删掉 L252 多余的 ` ``` `（它**打开**了一个新代码块，
  而 L394 的 ` ```typescript ` 带语言标识不能当结束标记，导致 §1.2–§4 共 13 个标题被吞进 `<pre>`）。
  修后全文件围栏数 16（偶数），42 个标题全部正常渲染。
  - 顺带修同一文件的编号问题：第二个 `### 1.2`（原 L254，排在 §1.6 之后）改为 `### 1.7`；
    `### 2.2c` 与 `### 2.2b` 对调，使编号顺序与出现顺序一致。
- **#2(a) 存储加密口径**：`00-overview.md` §7.4 原写"只做应用层逐记录加密、不选整库加密"，
  与 `65-storage-and-retention.md` 决策 S1（整库 + 列级双层）相反。已按 S1 统一；
  `60-billing-and-dogfooding.md` §6 的副本同步；AAD 写法从四种（"记录 id" / "request_id" /
  "request_id + schema 版本" / "request_id + ir_version"）统一为 `request_id + ir_version`。
  §9 Review 指引第 2 条的攻击点也随之更新。
- **#2(b) fast path usage 嗅探**：`20-pipeline.md` §4.2 原写超限"仅记录已知 token 数 = 0 + warning"，
  违反"未知绝不用 0 表示"的硬约束。改为**省略对应键 + `usage_sniffer_truncated`**，并写明
  **必须解析流尾的 usage 事件**（OpenAI Chat 只在末 chunk、Responses 在 `response.completed`、
  Anthropic 分两次、Gemini 每 chunk）——按字节数从流头截断会恰好漏掉 usage。
- **#2(c) decision 降级默认值**：`40-provider-adaptors.md` 决策 D9 原写"默认不自动启用"，
  同节与 `15-modalities.md` §6.5 却写"推荐默认 `on_missing_upstream`"。统一为
  **`on_missing_upstream`**（安全性由 `allow_degrade_high_stakes` 默认 `false` 保证），
  并在原处标注**待作者拍板**。
- **#2(e) 数量说法**：模态 8→**9**（`00 §2.1` 括号里本来就列了 9 个）、"7 模态 payload"→9、
  "第五模态"→"第 9 个模态（2026-11 新增，在 `ModalityKind` 里排第 2）"；阶段 10→**11（S0–S10）**
  （`00 §4.2` 模块表、`00 §6` 索引、`20-pipeline.md` §2、`70-roadmap.md` Phase 1、`AGENTS.md`）。
- **#2(g) 配置键**：`persist_messages` → `persistence.messages`（`60` 5 处、`70-roadmap` 3 处）。
- **#3 TypeScript 草案**：`10-canonical-schema.md` L187 `| "gemini.generateContent";` 的多余分号
  （提前结束 `FormatId` 联合，导致后面所有多模态格式报 TS1109）已删；
  §4.6 D8b"五种 canonical 稳定类型"→**四种**（只列了 4 种）。
  跨文档冲突里**已修**的两处：`25-streaming.md` 重复定义且漏 `decision` 的 `ModalityKind`
  改为引用 10 §3.1；`50-builtin-search.md` 的 `BuiltinTool.name` 改成只用 canonical 稳定名
  （与它自己 §2.2 的归一化规则一致），厂商专有名移到 `provider_tool_type`。
  **未执行**"把类型抽成真实代码文件"（提案已写进 10 的页眉，待作者拍板）。
- **#4 外部说法与数字**：
  - Cloudflare：标 Deprecated 的是 **Universal Endpoint**，替代建议是"用 OpenAI 兼容端点"；
    "Unified API (OpenAI compat)" 页写的是 "Deprecated for single-model calls"，
    替代方案 REST API **仍是** OpenAI 兼容的 `/ai/v1/chat/completions`。
    "这是对强行统一成 OpenAI 方言的实证否定"这一论据**不成立，已删除**。
  - LiteLLM：`00 §1.2` 表里"❌ 无 hook 系统"改为"⚠️ 有 hook（`async_pre_call_hook` /
    `async_post_call_success_hook` / `async_post_call_streaming_hook`），但挂在具体协议的字节上，
    非 canonical 级"；`00 §7.2`"现有开源**全部没有**插件系统"改为"没有现成开源项目提供
    **格式无关（只面向 canonical）** 的插件 hook"。
  - OpenRouter"唯一同时提供三种入站格式的商用网关"→"少数"（LiteLLM 支持 4 种，含
    `/v1beta/models/{model}:generateContent`）。
  - `15-modalities.md` §6.5 成本倍数 844.6x → **1189.0x**（844.6x 属于 GPT-6 Astra 那一行）。
  - `sources.md` 失效链接：OpenAI Chat Completions reference 404 → 现行地址
    `.../resources/chat/subresources/completions/methods/create`；`Filen.io/age` 404 →
    `FiloSottile/age`；`nick33810/napi-rs-keyring` 404 → `Brooooooklyn/keyring-node`
    （npm registry `repository` 字段）；`sqlcipher.org` 连不上 → `zetetic.net/sqlcipher`。
- **#5 结构编号**：`00` 两个 `### 1.2`（后一个改 `### 1.4`）；`70-roadmap.md` 补上缺失的
  `## 1. Phase 0`（原 Phase 0 内容挂在 `## 0.1` 下，编号从 0.1 跳到 2）；`sources.md`
  `2.10`→`2.9`、`2.11`→`2.10`（原 2.8 直接跳 2.10）；`sources.md` 待验证清单第 13 条
  "本节 §5"→"本节 §6"；`70-roadmap.md` 裸 `§1.6` 引用补上 `40-provider-adaptors.md`；
  `15-modalities.md` 标题补 `decision`。
- **#6 版本标签与 Phase 冲突**：新增 `[v1]/[v1.5]/[later]` ↔ Phase 映射表（`70-roadmap.md` §1.1.1），
  并修掉 4 处冲突：`openai.embeddings` 改 [v1.5]/Phase 4；`gemini.generateContent` 明确
  "版本标签是能力档次、Phase 是排期，二者不是一对一"；控制面认证 [v1] 注明"能力先于其消费者
  WebUI（[v1.5]）就绪，不是依赖倒置"；**Phase 1 凭据加密的密钥档位**明确为"只走 env / keyring，
  `vault`（加密库）到 Phase 4 密钥体系落地后才开放"。
- **#6 README / AGENTS 同步**：hook 3→5；WebUI"选型中"→"fork LibreChat"；文档状态"撰写中"→
  "v1.0-draft 待 review"；目录命名三套统一为 `00 §4.2` 的模块名（`src/canonical/`、`schema/` 废止）；
  `AGENTS.md` 的"另一线程/负责线程"改成可执行规则（`docs/` 改动走 PR、由仓库主人 review）；
  `.gitignore` 删掉旧定位残留（`snapshots/*.raw.json` 及 `data/raw/` 注释）。

### 改动（去重与口径统一）

- **#5 大段重复**：`60-billing-and-dogfooding.md` §5/§7–§9（分层存储、前缀压缩、保留、脱敏）
  改为指向 `65-storage-and-retention.md` §4–§7 的指针，只保留"计费管道需要存储提供什么"这一个视角
  （此前两份已漂移：字典表名 `zstd_dict` vs `zstd_dicts`、无字典压缩率 3–5× vs 1.25–5×、
  加密范围"只应用层" vs "双层"）。`StoredConversation` 类型移到 65 §4.3 作为唯一定义处。
  `60` 原 §10/§11 顺次前移为 §6/§7 避免跳号。
  `20-pipeline.md` §4.3 重复的 usage 口径表删除，只留指向 `40 §2.1` 的指针
  （该副本已和 40 漂移：把 OpenAI Chat 的 `cache_write_tokens` 写成"无对应"）。
  非目标只保留在 `00 §2.2`（`70 §7` 改为回指 + 保留两条时间性表述；70 独有的第 7、8 条并入 00）。
  `70-roadmap.md` Phase 4 验收里"压缩率达到 60 §7.3"改为"65 §5.3"。
- **#5 Open Questions**：`10 §10` 原称"编号 Q1–Q12 与 00 §8、12 §5 对齐"（实际对不上），
  改为全局编号说明；冲突的 Q6/Q7 改名 **Q11/Q12**（00 §8 的 Q6/Q7 另有所指，分别被 65/30 使用）；
  `12 §5` 的 1–12 补全局编号 **Q31–Q42**，17–22 重排为 13–18（仍对应 Q25–Q30）；
  **Q21–Q24 状态统一为"已解答"**（`40 §8`、`sources.md §7` 里仍列为开放的副本已同步）；
  Q1 状态矛盾（`40 §2.2c I1` 写"定论" vs `40 §8` 写"最高优先级"）统一为"仍开放 + OpenAI 侧 `[待验证]`"；
  `10 §10` 的 Q18"待 40 §6 回填"改为已关闭（40 §6.2 已回填）。
- **#5 页眉依赖**：删掉全部手写的"下游被引用于"（12 声明 1 篇实际 5 篇、15 声明 1 篇实际 8 篇、
  40 声明 1 篇实际 9 篇、65 声明 1 篇实际 7 篇——手工维护必然失真），只保留"上游依赖"。
- **#2(f) hook 生命周期**：`30-plugin-api.md` §3 时序图补上 `onToolCall`（网关 agentic loop 内
  每次工具执行点触发）与 `onError`（横切点）及其触发条件；`20-pipeline.md` 阶段职责表加
  "插件 hook"列；`00 §4.2` 模块表补 `credentials`(45) / `auth`(66) / `decision` 三行。
- **#3 命名**：`CanonicalRequest` / `CanonicalResponse` 与 `CanonicalRequestEnvelope` /
  `CanonicalResponseEnvelope` 的关系统一说明为"以后者为准"，写在 65 §4.3（`StoredConversation`
  定义处）与 10 页眉。

### 新增

- **#7 `.github/workflows/docs.yml`**：四个 job —— markdownlint-cli2（关 MD013/MD060）、
  lychee 外链检查（带排除与限流，schedule 每周跑）、`scripts/check-docs.mjs`
  （围栏奇偶 + `§N` 引用目标存在 + 同文件节号不重复不跳号 + 术语禁用同义词 grep）、
  tsc/ajv（**待类型抽取后启用**，只打印说明）。
  工作流里记录了 GitHub Pages 私有仓库需付费档且默认公开的限制，以及以后若建文档站的备选对比。
- **#7 `scripts/check-docs.mjs`**：零依赖 Node 脚本，实现上一行说的四项校验。
- **#7 `.markdownlint-cli2.jsonc` / `.lychee.toml`**：两个 linter 的配置与排除理由。
- **#7 `CONTRIBUTING.md`**：从 `AGENTS.md` 提取 privacy-scan 与 git 约定，加上文档改动的检查清单。
- **#7 存量 markdownlint 违规清零**：MD032 84 处、MD040 23 处、MD036 12 处、MD028 3 处、
  MD034 2 处、MD033 2 处、MD012 1 处、MD029 6 处全部修掉（否则 CI 一上线就是红的）。
  改动都是空白行 / 代码块语言标注 / 加粗冒充标题改冒号引导这类机械修正，不涉及内容。

### 设计风险（#8）—— 作者已逐条拍板，全部定稿

> 上一轮只写了"问题 + 建议解法 + 待拍板点"。**本轮（2026-11-14 续）仓库主人对六条逐条拍板，
> 已把结论原意落入文档**，定稿内容见下一节；此节保留问题本身的记录。

- **KEK 轮换与派生方式矛盾**（`65-storage-and-retention.md` §3.1）：DEK 由 HKDF 派生却说"轮换 KEK
  只需重包 DEK"——二者互斥。
- **nonce 计数器可能重复**（同节）：重启 / 多 worker / 多进程写同一 session 时会重用 AES-GCM nonce。
- **fast path 仍先完整解码**（`20-pipeline.md` §4.2）：与"附加延迟 < 3ms p99"有张力。
- **relaykit 与拒绝 NewAPI 的理由自相矛盾**（`00-overview.md` §1.3）：relaykit 同样 AGPL-3.0。
- **per-session zstd 字典**（`65-storage-and-retention.md` §5.2）：`zstd --train` 需 >100 样本，
  多数会话攒不到。
- **LibreChat 必须依赖 MongoDB**（`00-overview.md` §7.3、`docs/sources.md` §3/§6）：与"SQLite 单文件"
  意味着两套存储；MongoDB SSPL 合规此前未定。

### 定稿（review #8 六条设计决定，2026-11-14）

仓库主人逐条拍板，以下六条已从"待拍板"改为**定稿**写入文档；未改动技术结论，只把结论落到原文位置
并清掉与之冲突的旧表述。

| # | 决定 | 落点 |
|---|---|---|
| 1 | **DEK 随机生成 + KEK 包裹（信封加密）**，不再用 `DEK = HKDF(KEK, salt=session_id, …)` 派生；轮换 KEK 只需重包 DEK。HKDF 的边界写死（KEK 只由 Argon2id 派生，HKDF 不用于从 KEK 派生 DEK）。同步改 AAD、轮换流程、恢复流程 | `65-storage-and-retention.md` §3.1（+ §1 决策 S1/S4、§3.2b、§3.3、§4.3、§5.5、§7） |
| 2 | **XChaCha20-Poly1305 + 192-bit 随机 nonce**，不做计数器持久化；注明替代方案 **AES-GCM-SIV**（FIPS/审计合规时）及取舍 | `65-storage-and-retention.md` §3.1（密钥层次图 + 正文） |
| 3 | **fast path 惰性解码**：S1 只解析「信封 + 路由必需字段」，完整 canonical 推迟到 S3 插件链 / S4 Encode / S6 ProviderDecode 的非 fast path 分支；响应侧只抽 usage 信封并直通原始字节。**准入条件**：插件 manifest `scope: "envelope-only" \| "full-canonical"`，仅当全部已启用请求侧插件都是 `envelope-only`（或无请求侧插件）才允许 fast path；该条件由配置/组合根启动时计算并缓存，运行中增删插件需失效重算 | `20-pipeline.md` §3（S1）、§4.1、§4.2；`00-overview.md` §4.1 数据流、§3 性能约束、§1.4、§2.1、§9；`70-roadmap.md` Phase 1 交付物/验收、§8 风险表；`30-plugin-api.md` §2 `PluginManifest.scope`；`40-provider-adaptors.md` §1.1 `decode` 两档 |
| 4 | **relaykit 明确「不采用」**：与 NewAPI 同为 AGPL-3.0，与"因 AGPL 拒绝 NewAPI"的首要理由自相矛盾；借鉴限"读设计、不引代码"；确需其代码须独立进程/服务边界隔离并先做许可证评估 | `00-overview.md` §1.3；`docs/sources.md` §6 License 汇总 |
| 5 | **取消 per-session zstd 字典**，改为**全局字典 + 可选按客户端类型的字典变体**，离线训练、带版本号（`dict_id`）、入库加密；小会话退化为无字典压缩并记录实际压缩率 | `65-storage-and-retention.md` §5.2（+ §4.3 `zstd_dicts` 表、§5.3、§8 Q5）；`00-overview.md` §7.5、§8 Q5；`60-billing-and-dogfooding.md` §2/§7；`docs/sources.md` §4 结论、§7 |
| 6 | **维持 fork LibreChat**；**MongoDB 作为独立服务/容器部署，网关核心（SQLite 单文件）不依赖它**；**SSPL 立场**：私人自托管自用可接受，仓库公开/开源需重新评估（revisit 触发条件已写明）；**Meilisearch 列为可选** | `00-overview.md` §7.3；`docs/sources.md` §3、§6 License 汇总、§7 第 14 条 |

**连带修掉的冲突**（落地时发现，均与上述六条直接相关）：

- `docs/sources.md` §4 结论行的 AAD 仍写 `request_id` + schema 版本（全文已统一为 `request_id + ir_version`）——
  随本轮改写一并统一，并把算法/字典口径同步为定稿值。
- `65-storage-and-retention.md` §3.2b、§3.3 里"DEK 派生""GCM 解密"等旧措辞改为"解包"
  "XChaCha20-Poly1305 解密"，避免与定稿的信封加密口径冲突。
- `70-roadmap.md` Phase 1 的"p99 附加延迟 < 3ms"此前没有说明它靠什么成立——补上"S1 信封级惰性解析 +
  插件 `scope` 准入"这个前提，并新增"fast path 准入可观测"一条验收。
- `00-overview.md` §4.1 数据流图里 S1 框写的 `→canon` 改为 `→信封`，并加一段惰性解析说明。
- `60-billing-and-dogfooding.md` §2 管道图与 §7 待验证里的"共享字典"改为"全局字典"，与 65 §5.2 一致。
- `30-plugin-api.md` §4.2 的 billion-context adaptor 示例 manifest 补 `scope: "full-canonical"`（它要改写
  messages，fast path 因此对它关闭）。

## [Unreleased] — 2026-11-14 · always-canonical 与「透传」术语定稿

仓库主人追加两个架构决定，本轮落入文档。

### 决定 A：v1 全部走 canonical，去掉字节级 fast path

**理由**：canonical 往返在 Node 里就是 JSON parse + 对象映射 + stringify，典型对话请求亚毫秒到
几毫秒，相对 LLM 推理可忽略；私人低流量网关不值得维护两条代码路径。
**换来**：单一代码路径、插件永远可见 canonical、usage 标准化永远执行、round-trip 测试永远被走到。

| 原决定 | 处置 |
|---|---|
| D-fastpath-1（S1 信封档惰性解码，完整 canonical 推迟到 S3/S4/S6） | **作废**，降级为"未来可选优化" |
| D-fastpath-2（插件 manifest `scope: "envelope-only" \| "full-canonical"` 静态准入） | **作废**；`scope` 字段无其他用途，标注废弃 |

**落点**：

- `20-pipeline.md`：§1 设计原则第 2 条、§2 阶段职责表（S1/S2/S4/S6/S8 的"跳过完整互转"表述全部改为
  "一律完整走 canonical"）与数据流图、§3 S1 的两档说明、§4 整节改为"已废弃 + 存档 + 加回条件"、
  §6.4、§8 `RequestTrace`、§9 待验证；`RequestContext.fast_path` → `canonical_roundtrip`（恒 true）。
- `00-overview.md`：§1.4 核心价值主张、§2.1 范围表、§3 性能约束（**删除"< 3ms p99"硬门限**，改为
  "canonical 往返附加延迟为实测记录值，不作为硬性验收门限"）、§4.1 数据流图与说明、§5 术语表
  （fast path 标为已废弃）、§6 索引、§9 Review 指引。
- `70-roadmap.md`：§0 组织原则、§1.1 阶段总览与版本映射表、Phase 1 交付物/验收（压测与可观测性条目
  重写）、Phase 3/4/5 相关条目、§8 风险表。
- `AGENTS.md`：关键设计约束的 fast path 一条改写。
- `40-provider-adaptors.md`：§1.1 `Adaptor` 接口（`decode` 两档说明、`EncodedRequest.raw_bytes` /
  `fast_path` 标废弃）、§1.2 最小实现面、§1.4 有序偏好表、§1.5 round-trip 模板（断言 B 与测试名）、
  §1.6 检查清单。
- `30-plugin-api.md`：§2 `PluginManifest.scope` 标废弃（`scope?: never`）、§2.1 删 `disableFastPath`、
  §3 时序图、§4.2 示例 manifest 删 `scope`。
- `10-canonical-schema.md`：§7.4、§9.3 脚注；`12-coverage-survey.md` §4.2 判据；
  `15-modalities.md` §6.4 决策消费表；`README.md` 核心设计/目录/状态。
- **加回条件（写实，不拍脑袋）**：`20-pipeline.md` §4.4 列了五条，核心是「实测 canonical 往返开销
  占端到端延迟比例已不可忽略」「私人网关流量高到有回报」「双路径行为一致性有测试保障」「插件可见性
  不倒退」「计费口径不倒退」。任一条不满足就维持 always-canonical。

### 决定 B：「透传」= 语义不变地完成一次格式转换，不是零 mapping

目标格式既可以是标准 OpenAI 形态（`{"type": "web_search"}`、标准 chat.completions 结构），也可以是
上游方言（如 DeepSeek 的 `deepseek_web_search` 参数）；无论哪种都过 codec/mapping、都有 round-trip
测试。**系统内不存在"原样转发字节"的路径。**

**落点**：

- `00-overview.md` §5 术语表新增「**透传 / passthrough**」条目；§7.0.3 OpenRouter quirks 三档里的
  "透传"一条补上定义。
- `50-builtin-search.md`：§3.1 标题改为"模式 A：上游原生执行（**语义透传 + 方言映射**）"，开头写明
  透传的定义，同格式行从"**完全透传**，`tools[]` 原样"改为"语义透传 + 方言映射"；原"fast path 保证"
  一段改为"两条路径对客户端行为一致"；§1 理由第 2 条同步。
- `AGENTS.md` 关键设计约束补「透传」定义条目。
- `README.md` 内置搜索一节同步。
- **全文 grep "透传" 后统一**：`10-canonical-schema.md`（`source_format` 注释、§7.4、§9.3 脚注、Q19）、
  `15-modalities.md` §8.2/§8.3（ASR 实时的 WS 中继改称"**字节级中继**"并注明它是音频传输层中继、
  不是格式转换路径）、`25-streaming.md`（§1 兼容性矩阵、§2.1、§3.1 删"透传模式：原样转发字节"一条、
  §3.3 路径 1 改名"字节级中继代理"、§4、§8.3、§10）、`30-plugin-api.md` §3/§4.4b、
  `40-provider-adaptors.md` §1.4/§2.2c、`70-roadmap.md` Phase 4/5。
  `docs/sources.md` 里转述第三方（Vercel AI SDK / NewAPI / LiteLLM / llm-bridge）命名的"透传"保留原样。

### 附带：always-canonical 的存储侧收益（落盘即 canonical）

因为 v1 一律走 canonical，网关上落盘的所有聊天记录天然就是 canonical 格式。推论写入
`65-storage-and-retention.md` 新增 §5.6 与 `60-billing-and-dogfooding.md` §5：落盘即 canonical
（不需为每家厂商各写一套解析/统计）、前缀压缩按消息/parts 差分而非字节差分、usage 多单位已归一化
可直接消费、任何一条会话都能重放成任意 dialect、存储层只依赖 `ir_version`。

### 计费原则：价格会更新，历史记录绝不被重算（含 DeepSeek 峰谷计费）

新增 `60-billing-and-dogfooding.md` §4.2，并改造 §3 `UsageRecord` 的计费字段。

**决策**：每条记录的计费信息在请求完成时基于当时可得信息一次性算出并**快照固化**；当时没有价格就标记
`pending_price` 并保留 usage；补录时用**请求时点的有效价格**而不是当前价格。

**`UsageRecord` 计费字段**（原 `cost` + `cost_caliber` 合并重构）：

- `usage`：多单位 + `source: "provider" | "estimated"` + `precision` / `estimate_method`；
- `price_snapshot`：表版本 + 规则集版本 + 命中 `tier` + 时段窗口 + `holiday_status` + 实际费率 +
  费率条目生效日期 + 来源 URL 与抓取日期；
- `cost.as_api_micros`：等值 API 计费，**永远尝试计算**（订阅/无 usage 路径下唯一稳定的参考值）；
- `cost.cash_micros`：实际现金支出，订阅路径为 0；
- `cost.status`：`priced` / `pending_price` / `unpriced`。

**四条硬规则**：a) 不可变 + 快照，价格表更新不得重算已有记录；b) 请求时尝试计费，拿不到价格记
`pending_price` 且保留 usage；c) backfill 通过价格表生效区间查**请求时点**的有效价格，记录 `backfilled_at`
与所用表版本；d) `as_api` 永远尝试计算，`cash` 与 `as_api` 分开存储不合并。

**价格表三层结构**（DeepSeek 无官方价格 API，只能是仓库内静态、带版本与来源日期的表）：

1. **规则集**：一整套"时段窗口 + 工作日/周末/节假日规则"，整体带 `effective_from`/`effective_to`
   （峰谷体系 2026-08-17 生效、周末全天低谷 2026-08-23 生效，规则集会叠加变更）；点时间解析先选当时
   有效的规则集，再在集合内定档。
2. **费率**：按模型 + 计价单位（缓存命中输入/未命中输入/输出等），同样带生效日期。
3. **节假日日历**：按年维护，**含调休上班日**，带来源与年份；缺失日期按工作日保守处理并标
   `holiday_unknown`；留出公共节假日 API 生成入口，**不用算法推算节假日**。

**已核实的峰谷规则**（来源见 `docs/sources.md` §1.4）：2026-08-17 00:00（Asia/Shanghai）生效，高峰价为
低谷 2 倍；高峰 = 工作日 09:00–12:00、14:00–18:00（北京时间）；2026-08-23 起周末全天低谷，空闲时段含
法定节假日。**官方明确"新规则生效前产生的费用仍按原标准结算"**——供应商自己都不重算历史，是本节原则的
外部佐证。

**其余要点**：

- 时区按规则集的 `tz` 显式换算（`Intl`/Luxon，不手算 UTC 偏移）。
- **上游响应不返回命中档位**，`price_snapshot.tier` 必须由网关按请求时间戳自行解析；若 DeepSeek 暴露
  余额/用量查询端点，可作为实际扣费真值对账，估算与事实分开记。
- **cash 与 as_api 必须用同一次 `resolvePrice(ts)` 的结果**（同一次解析、同一组 rates，只是乘的单价不同）。
- **跨时段边界**：流式请求跨错峰/高峰边界时按**请求开始时间定档**（确定性优先），并按 chunk 时间戳拆分的
  取舍已写明（v1 选前者，拆分只作为派生视图）。
- **订阅摊销**从单条记录里移出，改为查询时的可选派生指标（依赖预估额度，与快照不可变冲突）；
  `45-credentials.md` §7.2 已加指针收敛。
- `65-storage-and-retention.md` §7 保留策略补一句：`price_snapshot` 随 usage 明细长期保留以供对账，
  不参与 rollup 聚合删除。

**真值对账（余额即事实）**：已核实 DeepSeek 用同一个 API key 即可查询余额，于是形成
「**估算**（快照 + 峰谷定档）→ **事实**（余额对账）→ **偏差告警**」三级闭环，写入 60 §4.2。

- computed cost 是**估算**，上游余额差是**事实**；两者分开存储、分开展示，绝不互相覆盖。
- **只做区间级对账，不做逐笔归因**：周期快照余额，对比「区间内余额差」与「区间内估算 cash 总和」，
  产出 `{ estimated_cash_micros, actual_balance_delta_micros, deviation_ratio, snapshot_ok }`。
  理由：并发请求下无法把余额差归因到单笔请求。偏差持续过大时告警——意味着价格表、峰谷定档或
  usage 归一有错。
- **两个坑**：① DeepSeek **赠送余额优先扣**，余额差 ≠ 现金支出，对账记录必须能区分（给不出区分就标
  "含赠送"并降低告警灵敏度）；② 余额是时点值，快照失败/丢失会造成区间缺口——记录缺口而不是假装连续，
  缺口区间不参与偏差率计算。
- **附带用途**：低余额作为路由信号（配合 Plan 感知路由转向订阅路径，`45-credentials.md` §5.2 已补），
  以及请求前预检避免必然失败的调用。

### 已知未处理（留给作者）

- **类型抽取成 `ir/*.ts`**（#3 建议 2）：只写了提案，未执行；`tsc`/`ajv` CI 因此标注为"待启用"。
- **decision 抽成独立主文档**（#5 建议 1）：decision 主题散在 10 §4.6、12 §1.5/§5.1、15 §6、
  20 §6、40 §6、70、sources §5 共七处，尚未合并。
- **约 25 条决策迁到 `docs/decisions/NNNN-*.md`（MADR 4.0）**（#5 建议 2）、
  **Open Questions 集中到 `docs/design/open-questions.md`**（#5 建议 3）：均未执行。
- **`CapabilityEntry` 两份定义合并**（#3 建议 3）：15 与 45 的两份形状不同（键是 `provider` 还是
  `(access_path, model)`、有没有 `framing`），涉及路由与能力矩阵的核心结构，需作者拍板后统一。
- **"canonical 对 9 模态一次做全"的范围风险**（#8.5 次要项）：与 70 §8 风险表里的
  "多模态 schema 过度设计"相关，建议给穷尽普查设截止标准。
