# `/v1/models` canonical 模型列表端点实现报告（thread #8）

> 分支：`dsh-threads/8-cb6896` ｜ 基线：`main`(`01a125c`) + 合并 `dsh-threads/6-44a407`(DeepSeek provider)
> 测试：`npm test` **600 passed / 22 skipped**（live 冒烟无 key 自动跳过）；`npm run typecheck` /
> `lint` / `format` / `schema:check` 全绿；`npm run demo` 三段演示全通（本机 8787 被占用，
> 用 `AG_PORT=18999 npm run demo` 验证）。
> 隐私：测试 key 只进 `.env`（gitignore 已覆盖），未入库；commit 前 `privacy-scan --staged
> --fail-on any` 通过（详见 §7）。

---

## 1. 做了什么

对外的 canonical 模型列表端点，元数据按「**上游能拉就拉、拉不到离线补、管理员定期同步、
配置自动同步**」的分层策略供给：

```
GET /v1/models                  列表（OpenAI 兼容 superset + 过滤/排序/分页）
GET /v1/models/{id}             详情（OpenAI 兼容形状；退役别名给带解释的 404）
GET|POST /ag/models/sync        管理员触发同步（AG_ADMIN_TOKEN 门禁；GET=状态，POST=触发）
```

新增模块 `catalog/`（7 个文件）+ `http/models-endpoint.ts` +
`providers/deepseek/catalog-metadata.ts` + `scripts/fetch-models-dev.mjs` +
`scripts/copy-static-assets.mjs` + 4 个测试文件（71 个新测试）。

### 1.1 响应形状（脱敏示例，实测 `npm run demo` 输出裁剪）

列表 `GET /v1/models?owned_by=deepseek&sort=-context_window`：

```json
{
  "object": "list",
  "total": 2,
  "data": [
    {
      "id": "deepseek-flash",
      "object": "model",
      "created": 1792195200,
      "owned_by": "deepseek",
      "provider": "deepseek",
      "name": "DeepSeek V4.1 Flash 1017",
      "description": "October 17 update of DeepSeek V4.1 Flash with improved reasoning, coding, agentic tasks, and visual understanding",
      "family": "deepseek-flash",
      "release_date": "2026-10-17",
      "knowledge_cutoff": "2025-05",
      "open_weights": true,
      "temperature": true,
      "structured_output": true,
      "tool_call": true,
      "reasoning": true,
      "attachment": true,
      "context_window": 1048576,
      "max_output_tokens": 393216,
      "input_modalities": ["text", "image"],
      "output_modalities": ["text"],
      "effort": { "levels": ["low", "high", "max"], "default": "high" },
      "supported_parameters": ["messages", "system", "tools", "..."],
      "per_request_limits": { "max_input_tokens": 655360, "max_output_tokens": 393216 },
      "concurrency": { "max_concurrent_requests": 2500, "source": "DeepSeek 官方价格页（2026-11-14 核对）" },
      "aliases": ["deepseek-flash-messages"],
      "constraints": [
        {
          "dialect": "anthropic.messages",
          "system_prompt_update": "in-history",
          "tool_update": "addition-only",
          "source": "upstream-declared",
          "semantics": {
            "system_prompt_update": "system 消息可以追加进历史；历史中最后一条 system 消息提供完整生效的系统提示，替换更早的所有 system 消息。",
            "tool_update": "后续轮次只能新增工具，不能移除或修改已声明的工具。"
          }
        }
      ],
      "pricing": {
        "currency": "USD",
        "unit": "USD per 1M tokens",
        "table_version": "deepseek-2026-11-14",
        "source_url": "https://api-docs.deepseek.com/quick_start/pricing",
        "fetched_at": "2026-11-14",
        "rates": { "input_cache_hit": 0.003, "input_cache_miss": 0.15, "output": 0.6 },
        "tiers": [
          { "tier": "peak", "start": "09:00", "end": "12:00", "tz": "Asia/Shanghai",
            "exclude_dates": [], "rates": { "input_cache_hit": 0.006, "input_cache_miss": 0.3, "output": 1.2 } }
        ],
        "rule_sets": [
          { "effective_from": "2026-08-17", "effective_to": "2026-08-23", "tiers": ["..."] },
          { "effective_from": "2026-08-23", "tiers": ["..."] }
        ],
        "holidays": { "year": 2026, "source": "http://politics.people.com.cn/n1/2025/1104/c1001-40596715.html", "holidays": ["..."], "workdays": ["..."] },
        "as_api_reference": { "rates": { "...": "..." }, "subscription_paths": [], "note": "订阅路径现金恒 0、等值 API 用量照算（60-billing-and-dogfooding.md §4.1 双口径）..." },
        "tools": { "search_per_1000_requests": 0.75, "...": "..." }
      },
      "access_paths": [
        {
          "access_path": "deepseek.anthropic-messages",
          "provider": "deepseek",
          "format": "anthropic.messages",
          "modality": "chat",
          "status": "implemented",
          "contract_tested": true,
          "streaming": { "mode": "sse", "usage_in_stream": true, "cancellable": true, "framing": "json-sse" },
          "usage_source": "provider",
          "usage_units": ["tokens"],
          "unsupported_parameters": ["cache_control", "parts.search_result", "parts.redacted_thinking"],
          "quirks": ["端点是 POST /anthropic/v1/messages；anthropic-version 头被服务端忽略", "..."],
          "constraints": [{ "dialect": "anthropic.messages", "system_prompt_update": "in-history", "tool_update": "addition-only" }],
          "concurrency": { "max_concurrent_requests": 2500 },
          "credential": { "kind": "api-key", "types": ["api_key"], "available": 1 },
          "cash_pricing": "api"
        },
        { "access_path": "deepseek.openai-chat", "...": "..." }
      ],
      "raw": { "upstream": { "id": "deepseek-flash", "...": "上游原字段全量透传" } },
      "provenance": {
        "assembled_at": 1794651434838,
        "fields": {
          "context_window": "capability-matrix",
          "input_modalities": "capability-matrix",
          "effort": "capability-matrix",
          "constraints": "offline:deepseek-static",
          "name": "offline:models.dev",
          "family": "offline:models.dev",
          "pricing": "offline:deepseek-static",
          "concurrency": "offline:deepseek-static",
          "supported_parameters": "capability-matrix",
          "created": "offline:models.dev"
        },
        "layers": [
          { "sourceId": "offline:models.dev", "layer": "offline", "contributed": true, "fetched_at": 1794614400000 },
          { "sourceId": "offline:deepseek-static", "layer": "offline", "contributed": true, "fetched_at": 1794614400000 },
          { "sourceId": "upstream:deepseek", "layer": "upstream", "contributed": false }
        ],
        "stale": false
      }
    }
  ]
}
```

详情 `GET /v1/models/deepseek-flash` 直接返回上面那个模型对象（不包 `list` 信封，与 OpenAI
`models.retrieve()` 一致）。退役别名 `GET /v1/models/deepseek-chat`：

```json
{ "error": { "message": "模型 deepseek-chat 已于 2026-07-24T15:59:00Z 退役：已于 2026-07-24 15:59 UTC 退役（官方公告 /news/news260424）。实测退役名仍返回 200 并被静默路由到 deepseek-flash，故网关不登记该别名：路由层直接拒绝，不做静默重路由。 请改用 deepseek-flash。", "type": "invalid_request_error", "code": "model_not_found" } }
```

### 1.2 OpenAI SDK drop-in

`tests/models-openai-sdk.test.ts` 用**官方 `openai` 包**（v4.104.0，devDependency，只进测试）
直接打我们的端点：

- `client.models.list()` → `page.object === 'list'`，每条 `id/object/created/owned_by` 类型正确；
- `client.models.retrieve('deepseek-flash')` 正常返回；
- 扩展键（`provenance`/`access_paths`/`pricing`/`constraints`/`context_window`…）**原样穿过**
  （SDK 只是类型不暴露它们，不删它们），断言传输层仍有这些键；
- 每条记录 `JSON.parse(JSON.stringify(...))` 往返无损；
- 404 走 SDK 自己的错误类型（`OpenAI.NotFoundError`），message 里带退役解释；
- `client.get('/models?owned_by=deepseek&sort=-context_window')` 证明带查询串的路径与 SDK
  路径走同一份处理器（LiteLLM 一类中间层的用法）。

---

## 2. 分层设计

### 2.1 四层与优先级（低 → 高）

| 层 | 内容 | 来源 | 优先级语义 |
|---|---|---|---|
| `offline:models.dev` | family / release_date / knowledge_cutoff / temperature / structured_output / open_weights / 模态 / 限额 / 扁平费率 | vendored 快照 | 最低，只填矩阵没有的字段 |
| `offline:deepseek-static` | 并发限额 / **带峰谷 tiers 的价格** / 路由别名 / 退役别名 / 约束官方语义 | `providers/deepseek/catalog-metadata.ts` | 同层后者覆盖前者（覆盖 models.dev 的扁平费率） |
| `upstream:deepseek` | `GET /models` 的 `name` + `raw` 透传；**窗口/模态/effort/constraints 写回能力矩阵** | 实时 HTTP | 只补矩阵没有的字段 |
| `capability-matrix` | `access_paths[]` / `unsupported_parameters` / constraints 的**值** / 窗口 / 模态 / effort / `supported_parameters` | `ir/capability.ts` | 运行时真值 |
| `config:local` | 管理员修正 | 注入的 `ModelMetadataSource` | 最高，可覆盖矩阵字段并**写回矩阵** |

每层经 `ModelMetadataSource` 端口接入（`catalog/types.ts`），DI 注入，不硬编码 HTTP；
合并时逐字段记来源（`provenance.fields`）。

### 2.2 为什么「矩阵 > 上游」而不是「上游直接覆盖」

任务书要求两件事同时成立：**上游是运行时真值**，且 **`/v1/models` 与能力矩阵必须同源**。
若目录直接采信上游快照，就会出现两个写者——discovery 刷新矩阵、目录又采信快照，任一方
落后一点，响应就与路由不一致（客户端按响应裁剪 prompt，路由却用另一个窗口 → 上游 400）。

所以上游数据进入系统只有**一个入口**：`createDeepSeekUpstreamSource().load()` 先把
`/models` 响应写回能力矩阵（`discovery.refresh(registry, preloaded)`，一次 HTTP 两用），
再把它当元数据快照交出；目录随后从矩阵读这些字段。测试
`上游 /models 刷新矩阵后，/v1/models 的窗口跟着变（同一份数据，两个消费者）`
锁死了这条链路：假 `/models` 报 `context_window: 2097152` → 同步 → 响应与矩阵同时变成新值。

同理，低层（models.dev / provider 静态表）对矩阵字段**只填空不覆盖**——静态快照报的
`input_modalities` 可能与上游运行时值不一致，让静态值覆盖运行时值正是要避免的漂移。

### 2.3 为什么 config 能覆盖矩阵字段

矩阵字段同时是**路由判据**（S2 按窗口/模态/constraints 做拒绝降级放行）。管理员修正如果
只改响应不改矩阵，"客户端看到的窗口"与"路由实际用的窗口"会分叉。所以
`ModelCatalog.applyConfigOverrides()` 把配置层对矩阵字段的修正**写回能力矩阵**
（`ready()` 加载完来源后自动执行，幂等），响应与路由因此永远同源，且
`provenance.fields[field] === 'config:local'` 能标出"这个值是管理员改过的"。

### 2.4 三个独有字段

- **`constraints[]`**：按 dialect 的行为约束。**值**来自能力矩阵（单一事实来源，
  discovery 可刷新），**官方语义文字**来自 provider 专有知识
  （`DEEPSEEK_CONSTRAINT_SEMANTICS`）。两者分开存放：值会变、解释不会，各找各的单一来源。
  只贴 Anthropic 方言——`api_capabilities.anthropic_messages` 的 key 名就限定了作用域，
  给 OpenAI 兼容面编一个约束等于猜测。
- **`pricing`**：多单位费率 + `tiers`（峰谷时段窗口，含 tz / days_of_week / exclude_dates）
  + `rule_sets`（规则集生效日期，DeepSeek 2026-08-17 / 2026-08-23 两套）
  + `holidays`（节假日日历引用）+ `as_api_reference`（订阅路径双口径）+ `tools`（独立端点
  按次计费）。**不重算任何数字**，原样搬 `pricing.json`，让"这个费率什么时候有效"在响应里
  就能看出来。
- **`access_paths[]`**：同一模型经不同凭据路径的能力与限额差异。`credential.kind` 由
  `CredentialResolver` 推导（`api-key` / `subscription-oauth` / `none`，**只取 type 与条数，
  不碰明文**），`cash_pricing` 据此在订阅路径上标 `subscription`（现金恒 0、as_api 照算）。

### 2.5 派生字段

- `created`：OpenAI 是 epoch 秒；我们没有"创建时间"这个一手数据，最近似的是 `release_date`。
  推导关系写进 provenance（`created` 跟着 `release_date` 的来源走），没有发布日期的模型
  （mock）**不造** `created`。
- `supported_parameters`：由能力矩阵的 `unsupported_fields` 取补集（不手抄第二份清单），
  provider 静态表可以直接给一份更准的覆盖。

---

## 3. models.dev 的引入方式与理由

### 3.1 引入方式：**脚本拉取后生成 vendored 快照**（二选一里的后者）

`scripts/fetch-models-dev.mjs`（Node ESM，零依赖）拉 `https://models.dev/api.json`，
按 provider 白名单（`--providers` > `MODELS_DEV_PROVIDERS` > 默认 `deepseek,openai,anthropic`）
裁剪 + 归一成 `catalog/vendor/models-dev.json`，带 `$schema` / `source_url` / `fetched_at` /
`generator` 头。`--check` 模式做漂移检测（字段级 diff，退出码可接 CI）。

### 3.2 为什么不是「原样入库」

1. **体积**：上游 `api.json` 6.1 MB / 236 个 provider；我们只需要网关真正路由到的那几个。
   裁剪后 225 KB / 73 个模型。
2. **可 review**：原样入库的话，上游改一个字段就是一次 6 MB 的二进制式 diff，实际上等于
   没人看；归一化后的文件每个 diff 都能逐行审。
3. **为什么运行时也不抓**：models.dev 是第三方站点，运行时抓它会让 `/v1/models` 的可用性
   依赖一个我们控制不了的服务（任务书硬约束：端点绝不能因为元数据源挂了而失败）。
   抓取发生在**仓库维护时**，运行时只读本地文件。

### 3.3 归一化映射（诚实口径）

models.dev 实际有的字段全部映射：`id/name/description/family/release_date/knowledge`(→
`knowledge_cutoff`，**原样保留**——上游 "2025-05" 与 "2025-07-31" 混用，不擅自归一)
`/open_weights/temperature/structured_output/tool_call/reasoning/attachment/modalities`
(→ `input/output_modalities`) `/limit`(→ `context_window`/`max_output_tokens`) /
`reasoning_options[type=effort].values`(→ `effort.levels`) / `cost`(→ `pricing.rates`，
`input→input_cache_miss`、`cache_read→input_cache_hit`、`output→output`)。

**任务书提到但当前上游快照里没有的字段**（`license` / `benchmarks` / `tokenizer`）：
models.dev 现在只给 `open_weights` 布尔，没有许可证字符串、没有 benchmark 引用、没有
tokenizer。这三个字段保留在 canonical schema 里（等上游补），**不猜不造**——R2 的立场是
"未知"省略而不是填 0/占位符。provider 静态表将来可以通过自己的层补（DeepSeek 目前也没有
这三项的一手来源，同样省略）。

上游未建模的键全部进 `raw.upstream`（含 `interleaved` / `canonical_model_id` /
`cost.cache_write` / `cost.tiers` / `status: "deprecated"` 等）。

### 3.4 上游数据的两个已知缺口（保留在 `raw`，未提升为字段）

1. **16/73 个模型上游标 `status: "deprecated"`**（含 `claude-sonnet-4-5`）。我们的
   `status` 查询过滤语义是"adaptor 是否已实现"（能力矩阵三态），与"模型是否已退役"不是
   一回事，所以没有把上游的 deprecated 映射成我们的 `retired`（那会把仍在服务的模型从
   列表里藏掉）。需要的话从 `raw.upstream.status` 取，或改归一化映射表加一个
   `deprecated` 布尔。
2. **`cost` 里我们不映射的键**（`cache_write` / `tiers` / `context_over_200k` /
   `input_audio` / `output_audio`）只在 `raw.upstream`；models.dev 的 `tiers` 是它自己的
   分层结构，与我们的 `PriceTier` 不同形，强行映射会比不映射更危险。

---

## 4. 同步机制（三种方式，全部走注入端口）

| 方式 | 入口 | 可配项 |
|---|---|---|
| 启动时同步 | `startHttpServer` 在 listen 前 `await models.start()` | `AG_MODEL_SYNC_ON_START`（默认 true） |
| 周期性同步 | 注入的 `TimerScheduler`（生产 = `systemTimerScheduler`，测试 = `ManualScheduler`） | `AG_MODEL_SYNC_INTERVAL_MS`（默认 900000） |
| 管理员触发 | `POST /ag/models/sync`（`AG_ADMIN_TOKEN` 门禁，timing-safe 比较） | — |

`AG_MODEL_UPSTREAM_TTL_MS`（默认 3600000）是**上游 TTL**：超过就在响应里标
`provenance.stale: true` + `last_successful_fetch`。它只决定"算不算新鲜"，不改变拉取频率
——"多久拉一次"是成本问题，"多久算过期"是正确性问题，两个旋钮分开。

### 4.1 容错

- 单个来源拉取失败 → **保留 last-known-good**，只记 `lastError`，不抛；
- 从未成功过 → 没有快照，该层 simply 不贡献字段（矩阵种子值照常返回）；
- 离线层加载失败（vendored JSON 损坏）→ 该层缺席，`provenance.layers[].error` 留痕；
- 两层全挂 → 只剩能力矩阵，`GET /v1/models` 照样 200；
- 并发 `syncNow` 合并成一次拉取（不会两个 tick 同时打上游）；
- 管理员路由在部分来源失败时仍返回 200（`ok: false` 在 body 里），因为 last-known-good
  仍在、端点可用。

---

## 5. 与能力矩阵的单一事实来源

- `access_paths[]` / `unsupported_parameters` / constraints 的值 / 模态 / 窗口 / effort /
  `supported_parameters` **全部从 `CapabilityRegistry` 读**，目录不另写一份；
- 上游 `/models` 的运行时字段经 `load()` 写回矩阵后才在响应里生效（单一写者，见 §2.2）；
- DeepSeek 现有模型在端点里的体现：
  - `deepseek-flash` / `deepseek-v4-pro` 各两条 access path（OpenAI 兼容 + Anthropic 兼容），
    约束按 dialect 分开（flash = in-history + addition-only，pro = leading-only + leading-only）；
  - `deepseek-chat` / `deepseek-reasoner` **不在列表里**，`GET /v1/models/{id}` 返回带退役
    解释的 404（实测退役名仍被上游静默路由到 flash，网关不登记、不静默重路由）；
  - `deepseek-flash-messages` / `deepseek-v4-pro-messages` 作为 `aliases` 出现在记录里
    （从 `deepseekRouteAliases()` 反推，不手抄）。

---

## 6. 测试结果

```
npm test        600 passed / 22 skipped（22 files）
                其中新增 71 个：model-catalog 23 / model-sync 14 / models-endpoint 26 /
                models-openai-sdk 8
npm run typecheck  0 错误
npm run lint       0 错误
npm run format     All matched files use Prettier code style!
npm run schema:check  6 个 canonical 夹具通过
npm run build + demo  A/B/C 三段演示全通
```

新增测试覆盖：

| 文件 | 覆盖 |
|---|---|
| `tests/model-catalog.test.ts` | 分层优先级（矩阵 > 上游 > 离线；同层后者覆盖前者）、逐字段 provenance、离线兜底（JSON 损坏 / 两层全挂）、上游刷新矩阵→响应跟随、凭据路径差异（api-key vs 订阅 OAuth）、`supported_parameters` 反推、过滤/排序/分页/q、退役别名、provider 解析（路由表 vs 点号约定） |
| `tests/model-sync.test.ts` | 启动同步 / `syncOnStart=false` / `intervalMs<=0` / `start()` 幂等、周期同步（`ManualScheduler.tick()`）、管理员触发、并发合并、容错（last-known-good + lastError + 埋点 + 日志）、TTL 边界（59s 不过期 / 61s 过期）、`ttlMs<=0`、多来源互不影响、`status()` 视图可安全序列化 |
| `tests/models-endpoint.test.ts` | OpenAI 兼容形状、详情、URL 解码、404 + 退役解释、过滤、非法值 400、未知参数忽略、排序分页、管理员门禁（503/401/两种鉴权形态/GET vs POST）、上游挂了照样 200（从未成功 + 有过快照后挂）、真实 HTTP 往返（200/404/405/503）、推理端点不受影响、不注入 models 时向后兼容、离线层装配与整体替换 |
| `tests/models-openai-sdk.test.ts` | 官方 SDK drop-in（见 §1.2） |

---

## 7. 隐私与提交约定

- 测试 key 只进 `.env`（`git check-ignore -v .env` 确认被 gitignore 覆盖），未入库；
  全仓 grep 确认无完整 key。测试里的假 key 一律 `test-not-a-real-key` 之类字样。
- 管理员令牌只从 `AG_ADMIN_TOKEN` 读，**值不进日志 / trace / UsageRecord**；测试里的令牌
  是 `test-admin-token-not-a-real-secret`。
- `privacy-scan --staged --fail-on any` 在每次 commit 前跑；命中项逐条确认（本轮的命中都是
  字段名/注释里的普通词，如 `secret` 形参名、`AG_ADMIN_TOKEN` 变量名，非真实 secret）。
- `git add` 全部用显式路径，没有 `git add -A`。
- 未 push、未合并 main、未改 `docs/`、未碰 fast path 代码。

---

## 8. 顺带修掉的两个既有缺陷（都不在本任务范围，但挡住了交付）

1. **`npm run build && npm run demo` 起不来**：`tsc` 不复制 `.json`，而
   `providers/deepseek/pricing.json` / `holidays.json` 是运行时就着 `import.meta.url` 读的
   （DeepSeek provider 合进来时就带着这个坑——组合根无条件调用 `loadDeepSeekPriceTables()`）。
   新增 `scripts/copy-static-assets.mjs` 并挂进 `build`；`tsconfig.build.json` 的 include
   补 `catalog/**/*.ts`（否则新模块不进 dist）。
2. **`npm test` 之外**：`ModelCatalog.applyConfigOverrides()` 最初把 `register` 方法解构出来
   调用，丢了 `this`（类方法依赖实例字段）——被测试抓到后改成 `this.xxx.register(...)`。

---

## 9. 待文档更新清单（**均未改**，docs 改动走 PR）

1. `00-overview.md` §4.2：模块表新增 `catalog`（对外模型列表的单一事实来源）——与
   `providers` 那一行同一批（后者已由 thread #6 报告登记）。
2. `00-overview.md` §4.3：端点形态新增 `GET /v1/models`、`GET /v1/models/{id}`、
   `GET|POST /ag/models/sync`（`/ag/` 命名空间下的管理员触发）。
3. `10-canonical-schema.md`：新增「模型元数据 canonical 记录」一节（或指向
   `catalog/types.ts`），说明 (a) OpenAI 兼容 superset 的立场、(b) 分层优先级与
   `provenance`、(c) `constraints` / `pricing` / `access_paths` 三个独有字段与
   `CapabilityEntry` / `PriceTable` 的对应关系。同时把 thread #6 已登记的
   `CapabilityEntry.constraints` 等字段一并收录。
4. `40-provider-adaptors.md` §5：能力矩阵章节补"模型目录是矩阵的消费者，不另写一份"，
   以及 access path → provider 的推导规则（路由表优先，点号前缀兜底）。
5. `45-credentials.md`：access path 的凭据形态（api-key / 订阅 OAuth）如何体现在
   `access_paths[].credential` 与 `cash_pricing`；`AG_ADMIN_TOKEN` 进 key/环境变量表。
6. `60-billing-and-dogfooding.md`：`pricing` 响应字段与 `PriceTable` / `PriceSnapshot` 的
   对应；`as_api_reference` 与双口径（cash / as_api）的关系；订阅路径 `cash_pricing:
   "subscription"` 的语义。
7. `70-roadmap.md` / `AGENTS.md`：Phase 验收标准补 `/v1/models` 三条（可实现、可过滤、
   OpenAI 客户端 drop-in）与分层同步三方式。
8. `docs/sources.md`：补 models.dev（<https://models.dev/api.json>）与
   `scripts/fetch-models-dev.mjs` 的刷新流程。

---

## 10. 分支与 commit

- 分支：`dsh-threads/8-cb6896`（从 `main` `01a125c` 开出，已合并 `dsh-threads/6-44a407`）
- 未 push、未合并 main。
- commit（按职责拆分，`git add` 用显式路径）：

| commit | 内容 |
|---|---|
| `feat(catalog)` | `catalog/` 类型 + 分层合并 + provenance + 查询/排序 |
| `feat(catalog)` | 离线目录：models.dev vendored 快照 + 刷新脚本 |
| `feat(providers)` | DeepSeek 目录元数据（静态层 + 上游层 + 退役别名 + 约束语义） |
| `feat(catalog)` | 同步服务：启动 / 周期 / 管理员触发 + TTL + stale + 容错 |
| `feat(http)` | `/v1/models`、`/v1/models/{id}`、`/ag/models/sync` + 组合根装配 + DI 令牌 |
| `test` | 4 个测试文件（71 个用例，含官方 OpenAI SDK drop-in） |
| `chore` | `copy-static-assets`（修 demo 起不来）+ `.env.example` 补新变量 |
