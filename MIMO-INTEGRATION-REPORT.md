# MiMo（小米）上游 API 实测记录

探测时间：2026-11-16 ｜ 探测方式：`curl` 经本机 mihomo 代理（`HTTPS_PROXY=http://127.0.0.1:7890`）直打
`https://token-plan-cn.xiaomimimo.com`，key 从 `~/Projs/models/.env` 的 `MIMO_API_KEY` 读（不落盘）。

## 1. 端点穷举（先探后做的部分）

以下路径 **全部 404**（GET 与 POST 都试过；响应 `content-type: text/html`，是网关型 404 而不是
"路由存在但方法不对"的 405）：

```text
/v1/audio/speech          /v1/audio/transcriptions   /v1/audio/translations
/v1/tts                   /v1/asr                    /v1/speech
/v1/audio/tts             /v1/audio/asr              /v1/audio/speech/stream
/v1/audio/voices          /v1/voices                 /v1/audio
/audio                    /v1/realtime               /v1/audio/realtime
/  /v1  /health  /healthz  /docs  /openapi.json  /v1/openapi.json  /api-docs

```

`GET /v1/models` → 200；`GET /v1/chat/completions` → **405**（说明路由存在、只收 POST）。
→ 结论：**音频能力不在独立 REST 端点上**，走 Chat Completions 的模型分发。

## 2. 官方文档（形状来源）

- <https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition-post>（语音识别，OpenAI API 兼容）
- <https://mimo.mi.com/docs/zh-CN/api/audio/tts-post>（语音合成，OpenAI API 兼容）
- 两页的「请求地址」都写 `https://api.xiaomimimo.com/v1/chat/completions`；实测
  `token-plan-cn.xiaomimimo.com`（Token Plan 专用 host）同路径同样可用。

## 3. 逐条实测（路径 + 方法 + 必需字段 + 返回形态）

### 3.1 LLM：`POST /v1/chat/completions`

- 鉴权：`Authorization: Bearer <key>` **或** `api-key: <key>`（两者都实测 200）。
- 标准 OpenAI Chat 字段全接受：`temperature` / `top_p` / `max_tokens` / `n` / `stop` /
  `presence_penalty` / `frequency_penalty` / `user` / `seed` / `tools` / `tool_choice` /
  `response_format` / `reasoning_effort` / `stream` / `stream_options`。
- 响应：标准 OpenAI 形状，**额外带 `message.reasoning_content`**（思考正文）。
  `reasoning_effort: "none"` → 不回 `reasoning_content`（语义与 OpenAI 一致，codec 默认映射即可）。
- 流式：标准 SSE，末帧 `data: [DONE]`，`stream_options.include_usage` 时有独立 usage-only chunk
  （`choices: []` + `usage`）。delta 里同样有 `reasoning_content`。
- 错误体：`{"error":{"code":"400","message":"Unsupported model X"}}`（无 type/param 时也成立）；
  无效 key → 401 `{"error":{"message":"Invalid API Key","param":"...","code":"401","type":"invalid_key"}}`。

### 3.2 ASR：`POST /v1/chat/completions`（model=`mimo-v2.5-asr`）

- 请求：

  ```json
  {
    "model": "mimo-v2.5-asr",
    "messages": [{"role":"user","content":[
      {"type":"input_audio","input_audio":{"data":"data:audio/wav;base64,<b64>","format":"wav"}}
    ]}],
    "asr_options": {"language": "auto"},
    "max_tokens": 64
  }
  ```

- `format` ∈ {`mp3`, `wav`}；data URL 的 MIME 与 format 必须匹配
  （mp3 用 `audio/mpeg` 或 `audio/mp3`，wav 用 `audio/wav`）。
- `asr_options.language` ∈ {`auto`, `zh`, `en`}，默认 `auto`。
- 响应：`choices[0].message.content` = 转写文本；`message.audio` = null；`message.audio_tokens` = []。
- usage：`{completion_tokens, prompt_tokens, total_tokens, completion_tokens_details.reasoning_tokens,
  prompt_tokens_details.{audio_tokens, cached_tokens}, seconds}`——**`seconds` 是音频时长（秒）**，
  即计费主单位（官方价 ¥0.5/音频小时）。
- 实测：wav 与 mp3 都通；TTS 产出的 wav 喂回去识别成功（见 live 冒烟）。

### 3.3 TTS：`POST /v1/chat/completions`（model=`mimo-v2.5-tts` 及两个变体）

- 请求：

  ```json
  {
    "model": "mimo-v2.5-tts",
    "messages": [
      {"role":"user","content":"<音色设计描述 / 提示>"},
      {"role":"assistant","content":"<要合成的文本>"}
    ],
    "audio": {"format":"wav","voice":"mimo_default"},
    "max_tokens": 2048
  }
  ```

- `audio.format` ∈ {`wav`, `mp3`, `pcm`, `pcm16`}，默认 `wav`；`stream:true` 时默认 `pcm`。
- `audio.voice`：
  - `mimo-v2.5-tts`：可选，仅预置音色，默认 `mimo_default`；
    可选值 `mimo_default` / `冰糖` / `茉莉` / `苏打` / `白桦` / `Mia` / `Chloe` / `Milo` / `Dean`；
  - `mimo-v2.5-tts-voiceclone`：**必填**，且只接受音频样本的 base64（mp3/wav）；
  - `mimo-v2.5-tts-voicedesign`：**不接受** `voice`，用 `user` 消息描述音色。
- `assistant` 消息 = 合成文本；`voicedesign` 的 `user` 消息必填（音色设计描述）。
- 响应：`choices[0].message.audio = {id, data(base64 音频), transcript, expires_at}`；
  `message.content` = `""`。usage 为标准 token 形状。
- 实测：wav / mp3 / pcm / voicedesign / voiceclone **五个变体全部 200**。
  产出的 wav 是 24000 Hz 16-bit 单声道 Microsoft PCM。

## 4. 模型清单（`GET /v1/models`，6 个，均 OpenAI 形状）

| model id | 角色 |
|---|---|
| `mimo-v2.6-flash` | LLM（chat） |
| `mimo-v2.6-pro` | LLM（chat） |
| `mimo-v2.5-asr` | ASR |
| `mimo-v2.5-tts` | TTS（预置音色） |
| `mimo-v2.5-tts-voiceclone` | TTS（音色克隆） |
| `mimo-v2.5-tts-voicedesign` | TTS（音色设计） |

`/v1/models` **不返回** context_window / max_output_tokens / modalities / effort 等元数据
（只有 `id` / `object` / `owned_by`）——所以能力矩阵里这些字段留空，不编造。

## 5. 探不到 / 需要用户提供

- 音频端点**没有独立的 REST 路径**（§1 全 404），只能经 Chat Completions 的模型分发。这不是
  "探不到"，是上游事实；代价是 TTS/ASR 无法走 chat pipeline 的 S0–S10（与 DeepSeek 全家桶
  工具端点同款立场：独立端点、不进 pipeline）。
- Token Plan 的 host（`token-plan-cn.xiaomimimo.com`）与官方文档写的
  `api.xiaomimimo.com` 是否在所有能力上完全一致：只实测了前者（本仓库的 key 是 Token Plan key）。
- 上下文窗口 / 最大输出 / 各档位 effort：官方文档与 `/v1/models` 都没给，**未填**。

---

## 附：计费（2026-11-16 追加，仓库主人规则落地）

### 0. 落地清单（验收用）

| 要求 | 落点 |
| --- | --- |
| 价表数据 | `providers/mimo/pricing.json`（6 个模型 + tools 段；`source_url` 是官方按量计费页） |
| 价表 loader（读文件 → 校验 → PriceTable） | `providers/mimo/pricing.ts` |
| 定价服务（LLM token / ASR 按秒 / TTS 按字符） | `providers/mimo/pricing-service.ts` |
| 接进计费管线 | `composition-root.ts` 的 `createDefaultPricingService()` → `createCompositePricingService([deepseek, mimo])`，同一个实例喂给 S10（`runner`）、`/v1/tools/*` 与 `/v1/audio/*` |
| 多上游分流 | `metering/composite-pricing.ts`（按 `handles(model)` 认领，不合并成一张表） |
| Token Plan = 订阅路径 | `credentials/resolver.ts` 的 `BILLING_MODE_BY_KEY_PREFIX`（`tp-` → 订阅、`sk-` → 按量）+ `billingModeFor()`；S10 与工具/音频端点都问它 |
| 官方计费/余量接口 | `providers/mimo/balance.ts`（`/v1/platform/token_plan` 与 `/v1/platform/balance` 两个渠道） |
| 测试 | `tests/mimo-pricing.test.ts`（38 例，含「矩阵里每个 MiMo 条目都 priced」的不变量）、`tests/mimo-live.test.ts`（订阅路径 cost + token_plan 实测）、`tests/mimo-audio-http-live.test.ts`（TTS/ASR 用量记录 priced） |

> 提交在 `dsh-threads/38-319c2f` 分支上（`4a83d0e` 计费、`e057deb` 接入）。主仓 checkout 在
> `main`，所以**在主仓目录里看不到这些文件**——按任务要求没有 push / merge。

### 1. 官方计费事实（逐格取自官方页）

来源：<https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go>（页面标注「更新时间 2026 年
10 月 21 日」，2026-11-16 逐格核对）。**没有使用任何第三方价格源。**

官方页的两条关键说明（决定了双口径怎么算）：

> 「Xiaomi MiMo API 的按量计费使用开放平台普通 API Key，并按实际 Token 用量消耗账户余额，
> **与 Token Plan 套餐额度不互通**。」

即「钱」分两个渠道，各有独立的查询接口与**独立的 key 前缀要求**：

| 渠道 | key 前缀（官方明文） | 查询端点 | 返回 |
|---|---|---|---|
| Token Plan 套餐（订阅） | `tp-` | `GET {token-plan-cn host}/v1/platform/token_plan` | 周期积分额度 |
| 按量计费（现金） | `sk-` | `GET {api host}/v1/platform/balance` | 现金/赠金/冻结/授信 |

**国内 CNY 费率**（我们的 key 是 Token Plan 中国区，故取国内表；海外 USD 表在同一页上）：

| 推理类型 | 模型 | 输入（命中缓存） | 输入（未命中） | 输出 |
|---|---|---|---|---|
| 实时推理 | `mimo-v2.6-pro` | ¥0.025 | ¥3.00 | ¥6.00 |
| 实时推理 | `mimo-v2.6-flash` | ¥0.02 | ¥1.00 | ¥2.00 |
| 批量推理 | `mimo-v2.6-pro` | ¥0.0125 | ¥1.50 | ¥3.00 |
| 批量推理 | `mimo-v2.6-flash` | ¥0.01 | ¥0.50 | ¥1.00 |

- ASR：`mimo-v2.5-asr` ¥0.5 / 小时（「时长统计精确到秒，最终折算成小时计费」）
- TTS：三个变体**限时免费**（页面原文「限时免费」）
- 联网搜索：国内 ¥16 / 1000 次（本仓库未接 MiMo 联网搜索，只登记价格）
- 缓存写入：限时免费 → `input_cache_write: 0`

批量推理价**未进表**：它是请求模式（另一套 API 形态）而不是时段窗口，同一个时刻两种都可用，
用 append-only 的 entry 表达不了「并发两种模式」。我们不发批量请求，登记一份用不到的价
只会让「这个数是怎么来的」变难答。

## 2. 落到代码

- `providers/mimo/pricing.json` —— 上表的静态落库（`table_version: mimo-2026-10-21`、
  `source_url` 官方页、`currency: CNY`）。六个模型全有价：2 LLM（token 槽）+
  1 ASR（`per_hour`）+ 3 TTS（`per_10000_characters`，0 元但是**显式的 0**）。
- `providers/mimo/pricing.ts` —— loader（结构校验 fail-fast，逐字段照 DeepSeek 那份）。
- `providers/mimo/pricing-service.ts` —— 定价服务。`handles(model)` 自报边界，
  由 `metering/composite-pricing.ts` 与 DeepSeek 的服务组合（按模型分流，
  **不合并成一张表**——那等于让一个 provider 文件知道另一个的模型清单）。
- `credentials/resolver.ts` —— `BillingMode` + `BILLING_MODE_BY_KEY_PREFIX` +
  `billingModeFor(accessPath)`。判据是 **key 前缀**（`tp-` → 订阅、`sk-` → 按量），
  官方文档明文，不是启发式。只支持 env 档（keyring 异步读不了，同步路径上分不清
  就按非订阅处理——保守方向）。
- `gateway-core/pipeline/stages/s10-usage-emitter.ts` —— 把 `subscription` 传给定价服务。
- `http/tools-endpoint.ts` / `http/audio-endpoint.ts` —— 工具/音频端点自己算 cost
  （它们不走 S0–S10）。**这是 TTS/ASR 能变成 `priced` 的关键**：此前它们的用量记录
  恒为 `unpriced`。

## 3. 双口径结果（live 实测）

Token Plan key（`tp-`，本仓库的部署）→ 订阅路径。三类调用各一条 live 实测：

LLM（chat，`mimo-v2.6-flash`）：

```json
{"cash":{...,"total":0},"as_api":{"input":0.000012,"output":0.000126,...,"total":0.000138},"status":"priced"}
```

ASR（`mimo-v2.5-asr`，4 秒音频）：

```json
{"cash":{...,"total":0},"as_api":{"builtin_tools":0.0005555555555555556,...,"total":0.0005555555555555556},"status":"priced"}
```

（0.000555… = ¥0.5/小时 × 4 秒 ÷ 3600；`usage.seconds` 是上游自报的秒数，口径一致。）

TTS（`mimo-v2.5-tts`，12 字符）：

```json
{"cash":{...,"total":0},"as_api":{...,"total":0},"status":"priced"}
```

三条合起来就是仓库主人那条规则的落地：**cash 恒 0（订阅）、as_api 照算、status 是
`priced` 而不是 `unpriced`**。TTS 的 as_api 是 0 不是因为"没算钱"，而是官方
「限时免费」——0 元是一个可断言、可对账的声明（`price_snapshot.rates` 里明写
`per_10000_characters: 0`），与"缺价格"的 `pending_price`、"缺用量"的 `unpriced`
是三件事。

按量路径（`sk-` key）没有实测（我们没有那样的 key），但代码路径与订阅只差一个
`subscription` 标志，单测覆盖（`tests/mimo-pricing.test.ts` 的「按量路径」组）。

## 4. 官方计费接口（接上了，不是「无官方接口」）

按 `providers/deepseek/balance.ts` 的先例接了 `providers/mimo/balance.ts`，
live 实测（2026-11-16，`tp-` key）：

- `GET https://token-plan-cn.xiaomimimo.com/v1/platform/token_plan` → **200**（字段与形状，
  数字已脱敏——那是账号的额度与消耗，不属于"探测结论"）：

  ```json
  {"object":"token_plan","plan_code":"pro","period":{"start_at":"<UTC>","end_at":"<UTC>"},"quota":{"total_credits":<int>,"used_credits":<int>,"remaining_credits":<int>},"auto_renew":false,"claw_enabled":false}
  ```

  实测断言（`tests/mimo-live.test.ts`）：`total_credits > 0`、
  `remaining_credits === max(0, total - used)`、`period.*_at` 匹配
  `YYYY-MM-DD HH:mm:ss`——都是形状与不变式，不是具体数值。
- `GET https://api.xiaomimimo.com/v1/platform/balance` → **401 `invalid_api_key`**
  （官方文档「需使用普通 API Key `sk-`」；我们的 `tp-` key 不适用）。这不是故障，
  是「这个部署没有按量渠道」的判据。
- `/v1/platform/consumption` 与 `/v1/platform/daily_bill` 在 Token Plan host 上 **404**
  （它们在普通 API host 上且需要 `sk-` key）——所以**没有逐笔流水**，对账只能做区间级
  （`used_credits` 区间差 vs 我们 as_api 汇总），与 DeepSeek 侧「赠送余额优先扣、
  余额差不等于现金支出」的同款立场。

积分（credits）与 as_api（按官方按量费率折算的钱）是**两个量纲**，客户端不做换算——
官方没有公布 credits 与元的固定兑换率（Token Plan 套餐页按档位给额度），任何换算都是编造。

## 5. 本轮抓到并修掉的第三个真 bug：订阅用量被记成现金

live 冒烟第一版跑出来，ASR 用量记录的 `cash.total` 不是 0（订阅路径本该恒 0）。
原因是：音频端点的 access path 是 `mimo.tools.asr`，而**它不在凭据启动表里**——
凭据登记在 `mimo.openai-chat` 上（同一把 key、同一个账号）。于是
`billingModeFor('mimo.tools.asr')` 永远查不到 → 按非订阅处理 → 订阅用量被记成现金支出。

修法：给 `ToolEndpointHandler` / `AudioEndpointProvider` 加一个可选的
`billing_access_path`，指向**有凭据的那条** path（`<provider>.openai-chat`）。
不用"按点号前缀推"的约定——那是隐式的，加一家不遵守约定的 provider 就会静默错。
回归测试：`tests/mimo-audio-endpoint.test.ts` 的「计费判据查有凭据的那条 path」。

顺带一个测试时钟的坑：仓库里既有的 `FIXED_NOW = 1_760_000_000_000` 是 2025-10-09，
**早于** MiMo 价格条目的 `effective_from`（2026-10-21），`resolvePrice` 选不到 entry
→ `pending_price`。`tests/mimo-audio-endpoint.test.ts` 因此用了自己的时钟并注明理由。

## 6. 顺带修掉的一个既有标签问题

工具/音频端点接上定价服务后，DeepSeek 的工具模型（`deepseek-tts` / `deepseek-asr` /
`deepseek.tools.search` 等）的状态从 `unpriced` 变成 `pending_price`——因为它们的价格在
DeepSeek `pricing.json` 的 `tools` 段（slot 名不同），尚未接进 composite 的模型查询。
**priced-ness 没有回退**（两者都表示"没计价"），但标签更准确：`pending_price` 说明
「该给这个模型加一条价格条目」，而 `unpriced` 现在会被读成"没接定价"（已不成立）。
两处既有断言已同步更新并注明理由。要补的话给 DeepSeek 服务加一条 tools→models 的映射即可，
但那超出本轮范围（本轮只接 MiMo）。
