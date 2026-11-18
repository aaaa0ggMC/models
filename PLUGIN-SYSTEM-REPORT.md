# 插件系统端到端实测报告（MiMo 真上游）

> 2026-11-16 · 线程 #39「插件系统端到端测试（MiMo）」· worktree 分支 `dsh-threads/39-fef7a3`
>
> **后续修订**：§4.4（onResponse 插件在 fast path 下被静默跳过）由线程 #43 于 2026-11-16
> 补修——D-fastpath-2 改为两侧对称，详见该节。除 §4.4 与其引用处外，本报告的实测数据均为
> #39 当时所测。
>
> **口径声明**：本报告严格区分两类结论——
>
> - **【live】** = 对 MiMo 真上游跑过，附命令与关键输出；
> - **【mock】** = 用 `ScriptedTransport` 在进程内跑过（无网络、无 key 也可复现）；
> - **【推断】** = 只读代码得出的结论，**没有**任何执行证据。
>
> 全文不含任何密钥值；上游 key 一律走 `MIMO_API_KEY` 环境变量。

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 5 个 hook 对真上游各跑一遍 | ✅ 全部跑通（6 个 live 场景，多次重复执行均绿） |
| 补的测试 | `tests/plugin-contract.test.ts`（27 例，mock，无 key 也跑）+ `tests/plugin-live-mimo.test.ts`（6 例，live，无 key 自动 skip） |
| 修掉的**真 bug** | 5 个（详见 §4），其中 3 个在界面上完全看不出来；§4.4 那条（onResponse 插件在 fast path 下被静默跳过）在线程 #43 补修 |
| 全量 `npm test` / `typecheck` / `lint` | ✅ 1621 passed / 29 skipped（22 = DeepSeek live 无 key，7 = MiMo live 无 key），typecheck 与 lint 干净 |
| **本轮（#43）之后的未决项** | 0 个插件相关缺口；仍待拍板的只剩设计与实现的一处漂移：20-pipeline.md §4 说 v1 不做字节级 fast path，而代码里 fast path 与 `scope` 准入仍然生效（§4.1「实现现状」注） |

---

## 1. 实测环境与跑法

上游：MiMo（小米 token-plan），OpenAI 兼容面。

```bash
# 1) 探活 + 模型清单（live）
HTTPS_PROXY=http://127.0.0.1:7890 curl -s -H "authorization: Bearer $MIMO_API_KEY" \
  https://token-plan-cn.xiaomimimo.com/v1/models
```

```text
{"object":"list","data":[{"id":"mimo-v2.5-asr",...},{"id":"mimo-v2.5-tts",...},
 {"id":"mimo-v2.6-flash",...},{"id":"mimo-v2.6-pro",...}]}
```

实测到的三个上游行为（后面所有场景都依赖它们）：

| 行为 | 实测 | 影响 |
|---|---|---|
| `reasoning_effort: "none"` 被接受 | ✅ | 不关推理时小预算会被思考吃光、`content` 为空（`max_tokens=16` 实测返回 `content:""` + `reasoning_content`） |
| `max_completion_tokens` 被接受 | ✅ | canonical `params.max_output_tokens` → wire `max_completion_tokens` 的通路成立 |
| 未知模型名返回 400 | ✅ `{"error":{"code":"400","message":"Unsupported model X"}}` | `onError` 场景的**真**失败来源 |

跑测试（key 只从环境变量读，`.env` 已被 gitignore）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 \
  node --env-file=.env npx vitest run tests/plugin-live-mimo.test.ts
```

无 key 时同一命令自动 skip（`describe.runIf(hasKey)`），`npm test` 不会红。

> **接上游的方式**：测试进程内用 `EnvCredentialResolver.registerAccessPath()` 登记一条
> `mimo.openai-chat` access path（`base_url` / `key_env`），复用既有 `openai.chat` codec。
> **没有**新增 provider、没有改启动表、没有碰 `providers/`——MiMo provider 的接入是另一条线程的事。

---

## 2. 【live】5 个 hook 各跑一遍

命令与输出（同一文件、同一命令，节选关键 `[obs]` 行）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 node --env-file=.env npx vitest run tests/plugin-live-mimo.test.ts
# → Tests  6 passed | 1 skipped (7)
```

### 2.1 `onRequest` —— 改 canonical 请求，验证上游收到的是改后的

插件注入 system + 关推理；用 `RecordingTransport`（包一层 `FetchTransport`）留痕上游请求体。

```text
[obs] onRequest 上游 messages = [{"role":"system","content":"你是一个简洁的助手，只回答城市名，不要解释。"},
                                 {"role":"user","content":"中国的首都是哪里？"}]
[obs] onRequest 上游 reasoning_effort = none
[obs] onRequest 客户端 content = "北京"
```

断言：`upstream.messages[0].role === 'system'`、`upstream.reasoning_effort === 'none'`、
`upstream.max_completion_tokens === 64`、客户端拿到非空内容。**结论：改写经 canonical 后确实到了上游。**

### 2.2 `onResponse` —— 改 canonical 响应

插件把文本 part 追加「（由 onResponse 插件改写）」，前后各取一份 canonical 快照。

```text
[obs] onResponse 插件改写的 canonical = {"type":"text","text":"中国的首都是**北京**。（由 onResponse 插件改写）"}
[obs] onResponse 客户端实际拿到     = "中国的首都是**北京**。（由 onResponse 插件改写）"
[obs] onResponse UsageRecord status = success finish_reason = stop
```

**结论：插件拿到真上游解出来的 canonical 响应（含真实 usage），改写它，且改写后的文本
到达客户端**——§4.3 已按仓库主人拍板修掉（S8 延迟写出）。
测试里另有 `expect(res.fast_path).toBe(false)` 钉住前提：MiMo 这条 access path 没有能力矩阵
条目，`fast_path_eligible` 恒 false。（§4.4 修好后这条前提有了双保险：full-canonical 的
响应侧插件自己就会禁用 fast path。）

### 2.3 `onStreamChunk` —— 流式回合里逐帧改写

插件给每个文本分片套一层 `[...]`。

```text
[obs] onStreamChunk canonical 文本帧数 = 10
[obs] onStreamChunk 客户端逐帧 content = ["[一、]","[二、三！\n\n]","[数到三啦]","[！😊 ]","[你]","[是在]",
                                          "[和]","[我玩什么游戏]","[吗？]","[]"]
```

断言：每个客户端 `data:` 行的 `content` 都以 `[` 开头、`]` 结尾；帧数一进一出（不吞帧、不并帧）。
**结论：逐帧改写在客户端逐帧可见。**

### 2.4 `onError` —— 制造一次真失败

两个真失败来源：① 上游不认识的模型名；② 一把错 key。

```text
[obs] onError 收到的 canonical 错误 = [{"code":"capability_unsupported","http_status":400,
                                        "message":"Unsupported model mimo-no-such-model-xyz"}]
[obs] onError 客户端 status = 400 body = {"error":{"message":"Unsupported model mimo-no-such-model-xyz",...}}
[obs] onError(错 key) hook 收到 = ["auth_failed/401"] status = 401
```

断言：hook 被调到且拿到 canonical 错误（`http_status` 400 / 401）；
客户端拿到非 2xx 与 canonical 错误体；`gw.transport.requests.length === 1`（失败是真的打过去了）。
**结论：`onError` 被调到，且没有改写主链路结果**（30 §3「不改变控制流」成立）。

### 2.5 `onToolCall` —— 模型调一次工具 + 脱敏

插件故意"实现疏忽"，把一把假密钥塞进 tool_result；`RedactingPluginHost`（composition-root 真装配的装饰器）负责脱敏。

```text
[obs] onToolCall 收到的 call = {"type":"tool_use","name":"get_weather","input":{"city":"北京"}, ...}
[obs] onToolCall 追发给模型的 tool 消息 = "北京晴，26℃。调试信息：upstream_key=<redacted_key>"
[obs] onToolCall 客户端最终 content = "北京现在天气：**晴，气温 26℃**。"
```

断言：`call.input` 是**对象**（不是 wire 的 JSON 字符串）；追发给模型的第二条上游请求里
`role:"tool"` 消息含 `<redacted_key>` 且**不含**假密钥原文。
**结论：工具执行 + 脱敏这条纵深防御在真上游、真 agentic loop 下成立。**

---

## 3. 【mock】补的测试缺口

`tests/plugin-contract.test.ts` —— 20 例，全部走 `ScriptedTransport`，**没有 key 也跑**。

### 3.1 hook 契约：插件只能看到 canonical

用三种互相独立的手法断言，而不是只写一句注释：

1. **封闭 schema**：把插件实际收到的对象喂给 `ir/schema/ag-ir-1/root.schema.json`（ajv）。
   `envelope.schema.json` 是 `additionalProperties: false`——任何厂商 wire 字段
   （`choices` / `object` / `reasoning_content` / `prompt_cache_hit_tokens` / `stop_reason` …）
   只要出现在结构化路径上就过不了。这是唯一「结构上不可能混进厂商字段」的判据。
2. **deep-walk 键名黑名单**：schema 管不到两个显式逃生舱——`raw`（含 `unmapped` / `nodes` /
   `source_provider` / `finish_reason_provider`）、`_raw`、`usage.raw`。因此剥掉它们后再全图扫
   35 个厂商专有键名。
3. **服务面封闭性**：断言 `GatewayServices` 没有 `transport` / `fetch` / `base_url` /
   `headers` / `http` / `client` 这类"直接打上游"的入口。

> ⚠️ **已知逃逸口【推断，未修】**：`raw.unmapped` 与 `usage.raw` 按设计原样保留上游未建模字段
> （10 §7 raw passthrough）。也就是说**厂商形状的键名可以出现在这两个袋子里**，插件技术上
> 看得见。这是 canonical 超集性质的必然代价，不是缺陷——但"插件只看得到 canonical"这句话
> 严格说应表述为「插件只看得到 canonical **结构化路径** + 两个原样保留的 raw 袋子」。

另外两条行为侧证据：`onToolCall` 收到 `input` 是对象而非 JSON 字符串；
`onRequest` 注入的 system 出现在上游 wire 的 `messages[0]`（证明走的是 canonical → wire，不是直接改 wire）。

### 3.2 hook 失败隔离：五个 hook 各一条

`DefaultPluginHost.invoke()` 是共用实现，但**调用方对"失败"的后续处理各不相同**
（onRequest 是 continue、onStreamChunk 是透传原帧、onToolCall 是抛给 tool-loop），
所以只测一个 hook 会漏掉某一处的处理差异。现有 `tests/plugin-host.test.ts` 只覆盖了
onRequest / onStreamChunk / onError 三条，本次补齐 onResponse / onToolCall，并加端到端版本：

- `onResponse` 抛异常 → 客户端拿到**未改写**的响应；
- `onToolCall` 抛异常 → `runOnToolCall` 抛，tool-loop 接住转成 `is_error` tool_result，主链路不炸；
- 五个 hook 全抛 → 一次真实请求照样跑通并回包，两次失败都留下 `plugin_error:*` warning；
- 超时（onResponse）→ 按失败处理，不阻断；
- `fatal: true` → 明确给出 `plugin_error` 短路（500），而不是静默继续。

### 3.3 「行为一致」不变量（仓库主人拍板后补）

- 「流式与非流式行为一致：改写后的 canonical 永远进入 S10 记账」——同一个 usage 改写插件，
  `stream=false/true` 两条路径的 `UsageRecord.usage` 都必须是插件改写的值（§4.3 验收项 4）；
- 「流式下 onResponse 改写到不了客户端，但必须留下 warning」——物理限制（首字节后不能改
  已发内容）不可破，但**不静默**：`ctx.warn('onResponse_rewrite_ignored_streaming')`；

---

## 4. 【live/mock】发现并修掉的 5 个真 bug

前三个是写测试才暴露的；后两个是仓库主人拍板「修 §4.3」之后，动手时连带暴露的。
其中 3 个在界面上完全看不出来——只有审计插件与计量会静默失真。

### 4.1 `onStreamChunk` 插件让非流式请求的审计与计量静默失真 【已修】

- **现象**：只要一个插件的 manifest 声明了 `onStreamChunk`（哪怕它对流式之外什么都不做），
  非流式请求的 `onResponse` 会看到一个**空 parts、空 usage** 的假信封，
  `UsageRecord.usage` 从 `source:"provider"` / `input_tokens:18` 变成 `source:"estimated"` / `input_tokens:1`。
- **根因**：`s7-on-stream-chunk.ts` 无条件执行
  `if (streamSide().length > 0) state.aggregated = aggregateEvents(out, ...)`；
  非流式下 `out` 恒为 `[]`，聚合出假信封；而 S9 取值顺序是
  `state.aggregated ?? state.response ?? synthesizeFromEvents(state)`。
- **为什么看不见**：客户端 body 由 S8 读 `state.response` 产出，完全正确。
  失真的只有审计插件与计量。
- **修法**：只在 `state.shallow?.stream === true` 时聚合（`gateway-core/pipeline/stages/s7-on-stream-chunk.ts`）。
- **回归测试**：`tests/plugin-contract.test.ts` ›「只声明 onStreamChunk 的插件不会破坏非流式请求的 onResponse 与计量」，外加一条反向护栏「流式请求仍然产出聚合视图」。

### 4.2 `onStreamChunk` 返回 `undefined` 把整个流式请求打成 500 【已修】

- **现象**：插件的 `onStreamChunk` 写成 `() => undefined`（"只想观测，不想改写"）时，
  流式请求直接 500：`Cannot read properties of undefined (reading 'type')`。
- **根因**：`Plugin.onStreamChunk` 的返回类型原先不含 `undefined`，而
  `DefaultPluginHost.runOnStreamChunk` 把 `undefined` 当成"改写后的帧"写进 `stream_events`，
  S8 编码时踩空。
- **为什么容易踩**：其他四个 hook 都允许返回 `void`（`PluginResult<T>` 含 `void`），
  "忘了 return" 是同步插件最自然的写法。
- **修法**：① `plugins/host.ts` 把 `undefined` 当"不改写"（`if (out.value === undefined) continue`）；
  ② `ir/plugin.ts` 把返回类型扩成 `... | null | undefined`，让契约在类型层说清。
- **回归测试**：host 单测 + 端到端（流式请求不 500、客户端拿到完整内容）。

### 4.3 `onResponse` 改写对非流式请求不生效 【已修 · 仓库主人拍板修】

- **现象【live】**：见 §2.2——插件改写了 canonical，但客户端拿到的是改写前的文本。
- **根因**：阶段顺序是 S8 → S9，而非流式下 S8 已经把响应体写给客户端；
  S9 的改写只落在 `state.final_response`，而 S8 读 `state.final_response ?? state.response` 时
  `final_response` 恒为 `undefined`（只有短路路径会提前设它）——**那半句是死代码**。
- **矛盾点**：`PluginResult<CanonicalResponse>` 的类型承诺是"改写后的值"；
  `s9-on-response.ts` 文件头写着「非流式时在编码前执行（插件可改写响应）」；
  20-pipeline.md §S9 把「敏感信息脱敏」列为 S9 典型用途。三者都与实现不符。

#### 为什么选「S8 延迟写出」而不是「改阶段顺序」

两条路都评估过：

| 方案 | 代价 |
|---|---|
| 改阶段顺序（S9 提前到 S8 前） | 与 docs/design/20 §2 的阶段职责表、ASCII 图直接冲突。「S0–S10 共 11 个」在 AGENTS.md 里是硬约束；改了要连带动 20 号文档，且流式下 S9 本就该在流关闭后——顺序没法对两种模式取同一个值 |
| **S8 延迟写出（采用）** | 阶段表与编号**原样不动**，只改「什么时候把字节交给 sink」。流式分支一行不改（流式本来就逐帧写出），非流式分支从「写」改成「暂存」 |

采用后者，落成三处：

1. `gateway-core/pipeline/types.ts`：新增 `state.client_bytes`（status + headers + body），
   注释写清「为什么暂存」。
2. `gateway-core/pipeline/stages/s8-client-encode.ts`：非流式慢路径只 `encodeResponse`，
   把 JSON 字符串放进 `client_bytes`，**不碰 sink**、不置 `bytes_written`。
   顺手清理死代码：`state.final_response ?? state.response` 改成只读 `state.response`
   （`final_response` 是 S9 的产物，S8 读它本来就是死的；工具循环路径里两者是同一个对象）。
3. `gateway-core/pipeline/runner.ts`：新增 `flushClientBytes()`，在 **S9 之后**、
   S10 之前调用；三条路径（普通 / 工具循环 / 短路）都加。短路路径的
   `writeShortCircuit()` 也从「写」改成「暂存」，因此审计插件对合成响应的改写同样生效。

配套的两处一致性修补：

- `s9-on-response.ts` 新增 `reencodeClientBytes()`：插件链跑完后，若响应被改写就
  **重新编码**覆盖 `client_bytes`——否则 bug 只是从 S8 挪到 S9。
- `s10-usage-emitter.ts` 的 `estimateTextOf()` 取值顺序从
  `state.response ?? state.aggregated` 改成 `state.final_response ?? ...`：
  估算兜底的文本必须与客户端看到的那份同源。

#### 四条验收项（仓库主人指定）

| # | 要求 | 结论 |
|---|---|---|
| 1 | 流式不受影响 | ✅ 流式分支一行未改；S9 仍在流关闭后跑，`client_bytes` 恒为 undefined |
| 2 | 短路 / 早退路径不丢响应、不改状态码 | ✅ 短路路径改走同一个暂存 + flush；错误路径显式作废 `client_bytes` 再发错误体，不会「客户端拿到错误、缓冲里躺着成功响应」 |
| 3 | `final_response` 死代码清理 | ✅ S8 改成只读 `state.response`，注释说明为什么 |
| 4 | 计费口径不变，S10 基于改写后的响应 | ✅ 见下 |

#### 「计费口径未变」的证据

口径定义为：**客户端拿到的那份响应 == S10 记账所依据的那份响应**。修好之后这条第一次
真正成立（修之前客户端拿 A、账按 B 的文本估）。三条证据：

1. **usage 数字**：S9 早就执行 `state.usage = res.usage`（改写后的那份），S10 读
   `state.usage` ——数字侧一直是改写后的，未变。
2. **估算兜底文本**：`estimateTextOf()` 改读 `final_response`（改写后）。修之前读
   `state.response`（改写前），这才是真正会「账记 B」的地方。
3. **测试钉住**：`tests/plugin-contract.test.ts` ›「流式与非流式行为一致：改写后的
   canonical 永远进入 S10 记账」——同一个 usage 改写插件，`stream=false/true` 两条路径
   的 `UsageRecord.usage` 都必须是插件改写的值（42/7），且 `usage.source` 仍是 `provider`。

live 侧对应输出（改写后的文本同时出现在客户端与记账路径上）：

```text
[obs] onResponse 插件改写的 canonical = {"type":"text","text":"中国的首都是**北京**。（由 onResponse 插件改写）"}
[obs] onResponse 客户端实际拿到     = "中国的首都是**北京**。（由 onResponse 插件改写）"
[obs] onResponse UsageRecord status = success finish_reason = stop
```

> 附带宽带影响：`client_disconnected_before_flush` —— 客户端在 S9 之前断开时不再强写
> （写了也是 `ERR_STREAM_WRITE_AFTER_END`），记一条 warning，S10 照样记账。

### 4.4 `onResponse` 插件在 fast path 下被静默跳过 【**已修** · 2026-11-16 · 线程 #43】

修 §4.3 时连带暴露的，是同一类「hook 行为不一致」的另一种形态。

- **现象**：一个**只声明 `onResponse`** 的插件（审计 / 脱敏，最常见的形态）在 fast path 下
  **一次都不会被调用**。不报错、不告警，只是从来没运行。
- **根因**：fast path 的合同是「透传原始字节」，S6 只 `extractUsage` 不解码响应，
  `state.response` 恒为 undefined；S9 的 `if (res !== undefined && !ctx.fast_path)`
  于是把整条 onResponse 链跳过。
- **为什么难发现**：请求本身完全正常（客户端拿到正确响应、usage 也记上了），
  失效的只有插件——而插件失效没有任何信号。
- **修法（仓库主人拍板）**：D-fastpath-2 改为**两侧对称**——`scope: "full-canonical"` 的
  响应侧插件同样阻断 fast path。理由是 fast path 对两侧都是「没有 canonical」：请求侧只有
  S1 的浅解析信封，响应侧 S6 只抽 usage；D-fastpath-2 只写请求侧更像遗漏而非决定。
  "响应侧" = `onResponse` + `onStreamChunk`（流式下 canonical 响应就是以事件序列存在的，
  25 §2）。`onError` / `onToolCall` 不参与准入（前者收 CanonicalError，后者只在网关
  agentic loop 里跑，而 loop 本身就会关掉 fast path）。
- **落点**：
  - `gateway-core/pipeline/fast-path.ts`：`createFastPathAdmission()` 现在同时看两侧，
    分别收集请求侧与响应侧的 full-canonical 插件名；reason 文案区分「请求侧 / 响应侧 /
    两侧都有」（单侧时保持历史句式不变）；
  - `plugins/host.ts`：新增 `hasFullCanonicalResponseSide()`（`RedactingPluginHost` 同步委托）；
  - `ir/plugin.ts`：文件头的 D-fastpath-2 定义、`PluginScope` / `manifest.scope` 文档改成
    两侧对称，并写清"默认 full-canonical = 不会被静默跳过"；
  - `gateway-core/pipeline/stages/s9-on-response.ts` / `s7-on-stream-chunk.ts`：fast path
    下仍被跳过的插件（只剩显式 `scope: "envelope-only"` 的）记一条 warning
    （`onResponse_skipped_fast_path` / `onStreamChunk_skipped_fast_path`，进
    `RequestTrace.warnings` 与 `UsageRecord.warnings`）+ 一个
    `pipeline.plugin_skipped{hook,reason}` metric——**不许再静默**；
  - 设计文档同步：20-pipeline.md §4.1（D-fastpath-2 定义 + 新增「实现现状」注）、§4.2、
    §4.4 第 4 条、§3 S1 的废弃注；30-plugin-api.md §2（`PluginScope` 从"已废弃"改回真实
    语义）与 §3 规则；00-overview.md §4.1 的快路径注。
- **回归测试**：
  - `tests/fast-path.test.ts`：原第 117 行「onResponse-only 的 full-canonical 插件**不**禁用
    fast path」**翻过来**（现在断言 `allowed() === false` 且 reason 点名 auditor）；另补
    envelope-only 响应侧不禁用、onStreamChunk full-canonical 禁用、两侧并列时 reason 合并、
    onError / onToolCall-only 不禁用；
  - `tests/plugin-contract.test.ts`：原「⚠️ 已知缺口」测试翻过来（插件确实被调用、改写到达
    客户端、无跳过告警）；新增两条"不静默"测试（非流式 onResponse、流式 onStreamChunk 的
    envelope-only 插件在 fast path 下不被调用、但留下 warning）；
  - `tests/pipeline-e2e.test.ts`：补一条响应侧 e2e，与既有的请求侧那条对称。
- **性能代价（说实话）**：阻断 fast path = 这些请求从此走慢路径（完整 decode / encode）。
  触发条件是"装配了 full-canonical 插件"这件事本身，与请求量无关；而 full-canonical 是
  **默认档**——所以只要注册了任何一个普通插件（不显式声明 `envelope-only`），fast path
  对全部请求关闭。这不是免费的：长上下文大请求体在慢路径下要多付一次 JSON 往返
  （D-fastpath-1 的动机原话）。想让 fast path 活着的部署必须显式给每个插件声明
  `scope: "envelope-only"`，并接受"它在 fast path 下不运行"（会有 warning）。
- **已注册插件的行为核查**：仓库内只有一个内置插件 `agent-admin`
  （`hooks: ['onToolCall']`、`scope: 'envelope-only'`），请求侧与响应侧都不参与准入——
  **没有任何已注册插件因为这次改动从快路径变成慢路径**。测试里显式声明 `scope` 的三个
  插件（`pipeline-e2e` 的 reader、`agent-chat-e2e` 的 leaky tool、`deepseek-constraints`
  的 force-slow-path）也全部维持原行为。会变的是**缺省档**：一个不声明 scope 的
  onResponse / onStreamChunk 插件从"fast path 下静默不运行"变成"禁用 fast path、正常
  运行"——这是显式的、文档写明的修复，不是隐式副作用。

### 4.5 流式下 `onResponse` 拿到空信封（20 §S9 未落地） 【已修】

- **现象**：流式请求 + 只声明 `onResponse` 的插件 → 插件拿到的是
  `synthesizeFromEvents()` 拼出来的信封，`parts: []`——审计记录里一个字都没有。
- **根因**：S7 的聚合视图原先只在 `streamSide().length > 0` 时构建。而 20 §S9 原文是
  「拿到最终 `CanonicalResponse`（**流式下由 S7 的聚合视图提供**）」——聚合视图本来就该
  服务 onResponse，代码只服务了 onStreamChunk。
- **修法**：`s7-on-stream-chunk.ts` 的触发条件改成
  `streamSide().length > 0 || responseSide().length > 0`。按文档补齐，不是新设计。
- **回归测试**：`tests/plugin-contract.test.ts` ›「流式下 onResponse 拿到的是完整聚合视图，
  不是空信封（20 §S9）」——断言 parts 是 `[{type:'text',text:'你好，世界'}]` 且 usage 是 9/4。

## 5. 加一个新插件到底要动哪几处

按「接口 → 装配 → 测试 → 文档」四层列。**只有第 1、2 层是必需的**，3、4 是仓库约定。

### 5.1 接口层（`ir/plugin.ts`）

| 要写的东西 | 说明 |
|---|---|
| `manifest` | `name`（唯一 kebab-case）/ `version` / `hooks`（5 选 1..5）/ `order`（默认 100，小的先跑）/ `scope`（**默认 `full-canonical`**：请求侧或响应侧的 full-canonical 插件都会禁用 fast path，见 §4.4；只有显式声明 `envelope-only` 才可能拿 fast path 准入，但那种插件在 fast path 下不运行、只留 warning）/ `fatal`（默认 false）/ `timeout_ms`（默认 5000）/ `capabilities` / `needs` / `config_schema` |
| hook 实现 | 只想观测的 hook 也要写进 `hooks`，否则不会被调度 |
| 返回值 | 改写 → 返回新值；不改写 → **返回 `undefined`**（不要返回 `null`，`onStreamChunk` 的 `null` 是"丢弃"）；短路 → `{ short_circuit: true, ... }` |

**注册期会自动校验**（`validatePluginManifest`，不合法直接 `PluginRegistrationError`，
启动即失败、不静默）：`hooks` 不能为空、不能有未知 hook 名、
`onStreamChunk` + `capabilities:['context_compaction']` 冲突（25 §7.3）。

### 5.2 装配层（`composition-root.ts`，一处）

```ts
const pluginHost = new DefaultPluginHost(services, config.pluginTimeoutMs);
for (const { plugin, config: pluginConfig } of options.plugins ?? []) {
  pluginHost.register(plugin, pluginConfig ?? {});
}
```

即：**把插件加进 `createGateway({ plugins: [...] })` 的数组**。就这一处。
内置插件（`agent-admin`）在同一文件里 `pluginHost.register(createAgentAdminPlugin({...}))` 多注册一次。

装配时自动获得的三件事（不用自己写）：

- `RedactingPluginHost` 装饰：`runOnToolCall` 的返回值自动过脱敏 + 自动记 `ToolCallRecorder`；
- `createFastPathAdmission(pluginHost)`：启动时算一次并缓存，插件增减经 `onChange` 自动失效重算；
  准入看**两侧**（请求侧 onRequest + 响应侧 onResponse / onStreamChunk 的 full-canonical 插件，见 §4.4）；
- `SettingsService` 的 `runtime.pluginHost`：可热改缺省超时（`setDefaultTimeoutMs`）。

### 5.3 测试层

| 测什么 | 放哪 | 手法 |
|---|---|---|
| hook 契约（只看得到 canonical） | `tests/plugin-contract.test.ts` | ajv 校验 `root.schema.json` + deep-walk 键名黑名单 + `GatewayServices` 无上游出口 |
| 失败隔离 | 同上 | 五个 hook 各一条；再加一条"五个全抛，请求照样通" |
| 端到端往返 | `tests/plugin-live-mimo.test.ts`（真上游）/ `tests/pipeline-e2e.test.ts`、`tests/agent-chat-e2e.test.ts`（mock） | `RecordingTransport` 留痕上游请求体 |
| 真插件行为 | `tests/agent-chat-e2e.test.ts` | 已有 `agent-admin` + 泄漏工具的反向用例 |

### 5.4 文档层

- 插件接口的唯一事实来源是 `docs/design/30-plugin-api.md` §2/§3——**改接口先改那里**，
  `docs/` 的改动按 AGENTS.md 一律走 PR。
- 若插件引入新模态能力，按 AGENTS.md 还要同步 `docs/design/85-modality-surface-matrix.md` 的矩阵卡片
  （`scripts/check-docs.mjs` 与 `tests/docs-check.test.ts` 强制）。**本次没有碰 85。**

---

## 6. 硬约束（不能破）

1. **插件只操作 canonical**。generic hook 拿不到 provider 原始 body、拿不到 provider HTTP 客户端。
   外部能力走 adaptor 接入，不反向依赖 pipeline 内部。
2. **插件异常默认不阻断请求**（记 metric + warning）；只有 `fatal: true` 才阻断，且阻断方式是
   给出 `plugin_error` 短路（500），不是把异常抛给客户端。
3. **`onError` 不改变控制流**，只做观测 / 告警 / 副作用。
4. **`onStreamChunk` 返回 `null` = 丢弃**（chat 允许；`kind:"tts"` 的音频分片禁止，违例记 `plugin_error`）；
   返回 `undefined` = 不改写。流已开始后不允许 ShortCircuit。
5. **fast path 准入**：没有任何 `scope: "full-canonical"` 的**请求侧或响应侧**插件时才可能走
   fast path（D-fastpath-2，2026-11-16 起两侧对称，见 §4.4）。缺省 `scope` 就是
   `full-canonical`——安全侧优先。反过来，显式 `envelope-only` 的插件在 fast path 下不会被
   调用，但 S7/S9 会记 warning，不静默。
6. **工具结果必须过脱敏**：`PluginHost.runOnToolCall` 是工具结果进入 canonical 的唯一入口，
   `RedactingPluginHost` 在这里包一层，覆盖所有工具（包括将来新增的）。
7. **请求生命周期是显式的 S0–S10 共 11 个阶段**；改阶段顺序/数量等于改架构，要走 PR。
8. **上游 key 只走环境变量**，仓库里只留 `.example`；`headersFor` 的返回值只进 transport，
  不得被序列化落盘。

---

## 7. 顺带发现的接口层"半成品"【推断，未修，建议拍板】

写契约测试时发现 `Plugin` 接口上有几处**声明了但全仓库没有消费方**的能力。
它们不是 bug，但会让"照接口写插件"的人踩空：

| 接口成员 | 状态 | 影响 |
|---|---|---|
| `Plugin.init(cfg, gw)` | **无任何调用方**（`plugins/agent-admin.ts` 文件头已自注） | 插件拿不到 `GatewayServices`，只能用工厂函数 + 显式依赖 |
| `GatewayServices.registerTool(tool)` | 无装配方提供 | 唯一可用的工具注册路径是 `hooks:['onToolCall']` |
| `GatewayServices.kv` | 组合根给的是 `new MemoryKVNamespace()` | 进程内存，重启即丢；没有持久化实现 |
| `GatewayServices.currentUsage()` | 组合根返回 `{ units: {}, source: 'provider' }` | 恒为空，插件读不到真实累计 |
| `StreamChunkBuffer` / `manifest.needs: "cross_chunk"` | 只有类型，没有实现 | 跨帧缓冲能力实际不可用 |
| `manifest.needs: "aggregate"` | 聚合视图存在，但**不按 `needs` 过滤**（S7 看的是 `streamSide().length`） | 声明与生效条件不一致；也是 §4.1 的根因之一 |

`plugins/agent-admin.ts` 已经在文件头写明了前两条，并选择"工厂函数 + 显式依赖"绕开——
这是目前唯一被验证可行的插件形态。**建议**：要么补齐这些能力的装配，要么在
`30-plugin-api.md` 里明确标注"v1 不实现"，免得后来者照接口写代码。

---

## 8. 复现命令汇总

```bash
# 全量（无 key 也可跑）
npm test                 # 1621 passed | 29 skipped（29 = 两个 live 文件在无 key 时整体 skip）
npm run typecheck        # 干净
npm run lint             # 干净

# 新增的两个文件
npx vitest run tests/plugin-contract.test.ts     # 27 passed（mock，无 key）
HTTPS_PROXY=http://127.0.0.1:7890 node --env-file=.env \
  npx vitest run tests/plugin-live-mimo.test.ts  # 6 passed | 1 skipped（live）

# 本次改动触及的既有测试（确认无回归）
npx vitest run tests/plugin-host.test.ts tests/pipeline-e2e.test.ts \
  tests/fast-path.test.ts tests/redaction-parity.test.ts tests/agent-chat-e2e.test.ts
```

改动文件（本线程范围，未碰 `providers/`、`docs/design/85`、`webui/`）：

| 文件 | 改动 |
|---|---|
| `plugins/host.ts` | 修 §4.2（`onStreamChunk` 返回 `undefined` 当不改写） |
| `ir/plugin.ts` | `onStreamChunk` 返回类型加 `\| undefined`，注释说清语义 |
| `gateway-core/pipeline/types.ts` | 新增 `state.client_bytes`（§4.3 延迟写出） |
| `gateway-core/pipeline/stages/s7-on-stream-chunk.ts` | 修 §4.1（只在流式时聚合）+ §4.5（聚合视图也服务 onResponse） |
| `gateway-core/pipeline/stages/s8-client-encode.ts` | 修 §4.3：非流式只编码不写出；清理 `final_response` 死代码 |
| `gateway-core/pipeline/stages/s9-on-response.ts` | 修 §4.3：插件链后重编码 `client_bytes`；流式改写告警 |
| `gateway-core/pipeline/stages/s10-usage-emitter.ts` | 修 §4.3：估算文本改读 `final_response`（不许「客户端 A、账 B」） |
| `gateway-core/pipeline/runner.ts` | 修 §4.3：`flushClientBytes()` + 短路路径也暂存 + 错误路径作废缓冲 |
| `tests/plugin-contract.test.ts` | **新增** 27 例：契约 + 失败隔离 + 5 条 bug 回归 + 一致性不变量 + 断开保护 |
| `tests/plugin-live-mimo.test.ts` | **新增** 6 例：5 个 hook 对 MiMo 真上游 |
| `PLUGIN-SYSTEM-REPORT.md` | 本报告 |
