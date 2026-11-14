# 变更记录

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号暂用 `0.1.0-draft`
（设计尚未定稿，不设语义化版本；`docs/design/*.md` 页眉里的 `v1.0-draft` 指设计文档自身的版本）。

## [Unreleased] — 2026-11-14 · review #1–#8 逐条处置

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

### 设计风险（#8）—— 只写建议解法，**全部待作者拍板**

以下四条已把"问题 + 建议解法 + 待拍板点"写进文档对应位置，**没有擅自定稿**：

- **KEK 轮换与派生方式矛盾**（`65-storage-and-retention.md` §3.1）：DEK 由 HKDF 派生却说"轮换 KEK
  只需重包 DEK"——二者互斥。建议改为 **DEK 随机生成 + KEK 包裹（AES-256-KW）**。
- **nonce 计数器可能重复**（同节）：重启 / 多 worker / 多进程写同一 session 时会重用 AES-GCM nonce。
  建议改为**随机 96-bit nonce + 单密钥加密次数上限**，或 **XChaCha20-Poly1305 / AES-GCM-SIV**。
- **fast path 仍先完整解码**（`20-pipeline.md` §4.2）：与"附加延迟 < 3ms p99"有张力。
  建议**惰性解码 / 只解析信封字段**，并把"插件需要完整 canonical ⇒ 有权关闭 fast path"的依赖关系
  分成三级写清（含新增的 `needs: "envelope_only"` 档，待拍板）。
- **relaykit 与拒绝 NewAPI 的理由自相矛盾**（`00-overview.md` §1.3）：relaykit 同样 AGPL-3.0。
  结论改为**明确不采用**（借鉴设计、不引代码），并说明若要用进程边界隔离需单独的法务判断。
- **per-session zstd 字典**（`65-storage-and-retention.md` §5.2）：`zstd --train` 需 >100 样本，
  多数会话攒不到。建议改为**全局 / 按客户端类型分组训练 + 带版本号 `dict_id`**。

### 已知未处理（留给作者）

- **类型抽取成 `ir/*.ts`**（#3 建议 2）：只写了提案，未执行；`tsc`/`ajv` CI 因此标注为"待启用"。
- **decision 抽成独立主文档**（#5 建议 1）：decision 主题散在 10 §4.6、12 §1.5/§5.1、15 §6、
  20 §6、40 §6、70、sources §5 共七处，尚未合并。
- **约 25 条决策迁到 `docs/decisions/NNNN-*.md`（MADR 4.0）**（#5 建议 2）、
  **Open Questions 集中到 `docs/design/open-questions.md`**（#5 建议 3）：均未执行。
- **`CapabilityEntry` 两份定义合并**（#3 建议 3）：15 与 45 的两份形状不同（键是 `provider` 还是
  `(access_path, model)`、有没有 `framing`），涉及路由与能力矩阵的核心结构，需作者拍板后统一。
- **LibreChat 必须依赖 MongoDB**（#8.5 次要项）：与"SQLite 单文件"意味着两套存储；SSPL 合规仍开着。
- **"canonical 对 9 模态一次做全"的范围风险**（#8.5 次要项）：与 70 §8 风险表里的
  "多模态 schema 过度设计"相关，建议给穷尽普查设截止标准。
