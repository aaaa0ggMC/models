# AgentGateway — 实现运行说明

> 本节是**实现侧**的运行说明；设计文档在 [`docs/design/`](docs/design/)（00–70 共 15 篇），
> 架构与行为的唯一事实来源是那套文档，不是本文件。遇到文档矛盾/歧义时以文档为准并上报，
> 不要按本文件的描述擅自发明。

## 环境要求

- Node **>= 24.7.0**（`crypto.argon2` 需 24.7+；`zlib` zstd 需 22.15+/23.8+，
  依据见 [`docs/sources.md`](docs/sources.md) §4）
- 包管理用 **npm**（`package-lock.json` 已提交；仓库同时装了 pnpm，任选其一，
  但请只提交一种 lock 文件）

## 快速开始

```bash
npm install          # 装依赖
npm test             # vitest 全量测试
npm run typecheck    # tsc --noEmit --strict，零错误
npm run schema:check # ajv 校验 ir/schema 编译 + ir/fixtures 全部夹具
npm run lint         # eslint
npm run format       # prettier --check
```

## 本地起服务并演示端到端（mock 上游，不打真实 API）

```bash
npm run demo
```

它做两件事：

1. **起 HTTP ingress**（`http/server.ts`，Node 内置 `http`），用 curl 等价的 `fetch`
   打 `POST /v1/chat/completions`，客户端格式为 **OpenAI Chat**；
2. **直跑 PipelineRunner**，客户端格式为 **Anthropic Messages**、上游为 OpenAI Chat
   （跨格式慢路径 + usage 归一）。

两条路径的上游都是 **DI 注入的 `ScriptedTransport`**（mock），因此不起真实 API、
不需要任何 provider key 也能看到「客户端格式 → canonical → 上游格式 → 回程」完整跑通，
并打印 `fast_path` / `materialized` / `conversion_chain` / `UsageRecord` 观测值。

端点清单见 [`docs/design/00-overview.md`](docs/design/00-overview.md) §4.3；
Phase 1 只实现了 chat 相关的 `/v1/chat/completions` 与 `/v1/messages` 两条路由签名，
其余端点随对应 adaptor 落地逐步开放。

## 目录结构与模块职责

目录命名以 [`docs/design/00-overview.md`](docs/design/00-overview.md) §4.2 的模块表为唯一事实来源。

| 目录                  | 职责                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir/`                 | **AG-IR canonical 类型**（唯一中间表示）+ JSON Schema + canonical 夹具。按模态拆文件：`envelope` / `chat` / `decision` / `tts` / `asr` / `image` / `embedding` / `rerank` / `moderation` / `video` / `stream` / `usage` / `capability` / `credential` / `plugin` / `context` / `trace` / `guards` |
| `di/`                 | DI 容器 + 跨切面基础设施端口（Clock / Logger / Metrics / IdGenerator / Config） + **全仓库唯一读 `process.env` 的 `config.ts`**                                                                                                                                                                   |
| `adaptors/`           | 每 (格式, 模态) 一对 mapper。`types.ts` 是 `Adaptor` 契约，`registry.ts` 是注册表，`index.ts` 是**集中显式注册处**；`openai-chat/` 与 `anthropic-messages/` 是 Phase 1 写透的两个 codec                                                                                                           |
| `gateway-core/`       | `pipeline/`（S0–S10 共 11 个阶段 + fast path + 惰性解码 + 重试/fallback + 工具循环 + usage 嗅探）、`context.ts`、`router.ts`（S2 路由）、`transport.ts`（传输抽象）                                                                                                                               |
| `plugins/`            | `host.ts`：5 个 hook 的调度 + 故障隔离                                                                                                                                                                                                                                                            |
| `metering/`           | `usage-record.ts`（UsageRecord 数据模型）、`emitter.ts`（接口）、`memory-emitter.ts`（有界队列 + 微批下沉）                                                                                                                                                                                       |
| `credentials/`        | `resolver.ts`（上游凭据解析，Phase 1 只允许 env/keyring）、`capability-registry.ts`（能力矩阵）                                                                                                                                                                                                   |
| `http/`               | `server.ts`：最小 HTTP ingress（S0 可跑起来）                                                                                                                                                                                                                                                     |
| `composition-root.ts` | **组合根**：全仓库唯一的装配处                                                                                                                                                                                                                                                                    |
| `tests/`              | vitest 测试                                                                                                                                                                                                                                                                                       |
| `scripts/`            | `check-json-schema.mjs`（ajv 校验）、`e2e-demo.mjs`（端到端演示）                                                                                                                                                                                                                                 |

> `di/` 与 `http/` 不在 00 §4.2 的模块表里——那张表列的是**领域模块**，这两个是横切基础设施。
> 已在本文件与实现注释里标明，未改文档。

## 架构：全面 Dependency Injection

- **每个能力定义接口**：codec（`adaptors/types.ts`）、plugin host（`plugins/host.ts`）、
  usage emitter（`metering/emitter.ts`）、credential resolver（`credentials/resolver.ts`）、
  capability registry（`credentials/capability-registry.ts`）、clock / logger / metrics /
  id generator（`di/ports.ts`）、transport（`gateway-core/transport.ts`），
  具体实现全部经**构造函数注入**。
- **组合根统一装配**：`composition-root.ts` 的 `createGateway(options)` 是唯一"知道所有
  具体实现"的地方，也是测试替换任一依赖的入口。
- **禁止**：模块级单例、跨模块直接 import 具体实现、隐式全局状态。
  `process.env` 的直接读取只允许出现在 `di/config.ts` 一处。
- **容器选型**：轻量自建（`di/container.ts`，约 120 行）。理由见该文件头注释与实现报告。

## 测试

```bash
npm test                          # 全量
npx vitest run tests/<file>       # 单文件
npx vitest run adaptors/          # 两个 codec 的 round-trip
npm run schema:check              # ajv 校验 schema 编译 + 全部 canonical 夹具
```

当前覆盖：

| 文件                                        | 覆盖                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/di.test.ts`                          | 容器：单例/多例/替身注入/循环依赖检测/子容器派生                                                                                                               |
| `tests/fast-path.test.ts`                   | **D-fastpath-1**（S1 浅解析不物化、路由必需集、首字节后禁改状态码）与 **D-fastpath-2**（fast path 准入、缓存失效重算）                                         |
| `tests/ir-schema.test.ts`                   | ajv 校验全部 canonical 夹具 + 「未知≠0」「免费≠未知」「未建模字段必须进 raw.unmapped」「BuiltinTool.name 只用稳定名」+ **TS ↔ schema 字段级 parity（防漂移）** |
| `tests/metering.test.ts`                    | 异步非阻塞发射器、drop 策略、可重放、UsageRecord 绝不含 header 原值/凭据/客户端 IP                                                                             |
| `tests/plugin-host.test.ts`                 | 5 hook 调度顺序、ShortCircuit 语义、故障隔离、超时、注册期校验                                                                                                 |
| `tests/usage-sniffer.test.ts`               | 四家 usage 到达方式、增量喂入与批处理等价、超限标 truncated 而**不**把未知记成 0、流尾 usage 必达、SSE 跨 chunk 分片                                           |
| `tests/router-retry.test.ts`                | fast path 两条件、参数兼容性预检（error 档不进 fallback）、流式 mode=none 拒绝、attempt_plan、别名热更新；20 §7.3 决策矩阵逐行                                 |
| `tests/pipeline-e2e.test.ts`                | 端到端：fast path 透传、跨格式慢路径 + usage 归一、流式 SSE、错误映射、插件短路、工具调用多轮循环                                                              |
| `adaptors/openai-chat/codec.test.ts`        | OpenAI Chat ↔ canonical 的 40 §1.5 六条 round-trip + 格式专属不变量                                                                                            |
| `adaptors/anthropic-messages/codec.test.ts` | Anthropic Messages ↔ canonical 的 40 §1.5 六条 round-trip + 格式专属不变量                                                                                     |

## Pipeline 的执行顺序（含两条易错点）

```text
S0 → S1(浅解析) → S2(路由 + fast path 判定) → S3(插件链；无请求侧插件则 no-op，不物化)
                                              │
                        ┌─────────────────────┴──────────────────────┐
                        │                                            │
              S4→S5→S6→S7→S8→S9→S10                    网关 agentic loop：
             （普通请求，S9/S10 只跑一次）                每轮只跑 S4→S7
                                                          │
                                                          └→ 循环结束后才跑一次 S8
                                                             （最终应答）→ S9 → S10
```

两条**必须**这么写的原因（都曾是真实缺陷，有测试锁住）：

1. **启用网关循环时必须关闭 fast path**。循环要往 `canonical.messages` 追加
   tool_use / tool_result 回合，而 fast path 下上游应答根本不解码成 canonical，
   循环会静默不前进。
2. **中间轮次不跑 S8**。否则第二次 `sink.start` 会触发 20 §S8 的
   「首字节后不能改状态码」硬约束。

工具循环每一轮的 canonical 由 `PipelineState.canonical_override` 提供——
`LazyRequest.full()` 返回的是首次物化时 memoize 的**原始**请求，不覆盖的话
每一轮都会把同一份请求发给上游。

## 环境变量

见 [`.env.example`](.env.example)。**上游 provider key 一律走环境变量**，
仓库里只出现变量名（`AG_OPENAI_API_KEY` / `AG_ANTHROPIC_API_KEY` / `AG_GEMINI_API_KEY`），
值由 `credentials/resolver.ts` 在签发请求时读取，绝不进日志 / UsageRecord / trace。
