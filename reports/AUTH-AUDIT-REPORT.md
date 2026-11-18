# 后端鉴权安全审计报告（deny-first / 公网公开前置检查）

- **审计对象**：AgentGateway（仓库 `models`）
- **分支**：`dsh-threads/33-34eb25`
- **Commit**：`b5b0dac` — `security(auth): 数据面改默认拒绝——permissive 从"兜底"变成显式 opt-in`
- **基线**：`54203b3`（= `main` HEAD）
- **实测时间**：2026-11-15（UTC）

> **证据分级是硬要求**，本报告每一节都标了
> **【实测】**（我真 curl / 真跑测试拿到过输出）或 **【代码推断】**（只读代码，未运行验证）。
> 运行中的服务用的是主检出 `dist/`（改动前的构建），因此**直播矩阵反映的是修复前的代码**；
> 修复后的行为由离线测试（不依赖真实凭据）断言，见 §7。

---

## 0. TL;DR

| 项 | 结论 |
|---|---|
| 直播数据面无凭据可达 | **0 个**（19 个入站脸全部 401）【实测】 |
| 直播管理面无会话可达 | **3 个**（bootstrap / login / logout，合法豁免）【实测】 |
| deny-first 违背 | **1 处，已修**：`DataPlaneAuthenticator` 什么都没配时落到 `permissive` 全放行 |
| 豁免清单 | 已收敛成两处显式清单（数据面 1 条 / 管理面 3 条），每条带理由 |
| 测试 | `npm test` 1555 passed / 22 skipped（基线 1541 passed）【实测】 |

**当前部署不受本次修复影响**：实跑环境配了 `AG_VIRTUAL_KEYS=true`，模式本来就是
`virtual_key`；修复只改变"什么都没配"时的行为（从放行改成 503）。

---

## 1. 路由级鉴权矩阵

目标：本机回环上的实跑服务（`0.0.0.0:8790`）。**未使用任何真实凭据**；
"通过态"用一把临时 virtual key 验完即删（见 §1.3）。【实测】

### 1.1 数据面（无凭据）

| 方法 | 路径 | 需要什么 | 实际输出 |
|---|---|---|---|
| GET | `/health` | **无**（豁免） | `200 {"status":"ok"}` |
| GET | `/v1/models` | virtual key | `401 缺少 API key（Authorization: Bearer / x-api-key / ?key= 三选一）` |
| GET | `/v1/models/{id}` | virtual key | `401` 同上 |
| GET | `/v1/models/` | virtual key | `401` 同上 |
| GET/POST | `/v1beta/models/{m}:generateContent` | virtual key | `401` 同上 |
| GET/POST | `/v1beta/models/{m}:streamGenerateContent` | virtual key | `401` 同上 |
| POST | `/v1/chat/completions` | virtual key | `401` 同上 |
| POST | `/v1/responses` | virtual key | `401` 同上 |
| POST | `/v1/messages` | virtual key | `401` 同上 |
| POST | `/v1/tools/search` `/fetch` `/ocr` `/asr` `/tts` | virtual key | `401` 同上 |
| POST | `/v1/audio/speech` `/transcriptions` `/translations` | virtual key | `401` 同上 |
| POST | `/v1/images/generations` `/images/edits` | virtual key | `401` 同上 |
| POST | `/v1/embeddings` | virtual key | `401` 同上 |
| POST | `/v1/decisions` | virtual key | `401` 同上 |
| GET/POST | `/ag/models/sync` | **管理员令牌**（`AG_ADMIN_TOKEN`） | `401 管理员令牌缺失或不正确`（未配令牌时是 `503`） |
| GET | `/`、`/nope`、`/v1`、`/V1/models`、`/v1%2fmodels` | — | `404 未知端点` |

### 1.2 管理面（无会话）

| 方法 | 路径 | 需要什么 | 实际输出 |
|---|---|---|---|
| GET | `/admin`、`/admin/anything-deep-link` | **无**（登录页 + SPA 深链） | `200` index.html |
| GET | `/admin/assets/index-*.js`、`*.css` | **无**（登录页要加载） | `200`（1.5 MB JS / 750 KB CSS） |
| GET | `/admin/api/bootstrap` | **无**（豁免） | `200 {"authenticated":false,"storage_unlocked":true,...}` |
| POST | `/admin/api/login` | 口令 / access token | 空 body → `401`；错口令 → `401 口令或 access token 不正确` |
| POST | `/admin/api/logout` | **无**（豁免） | `200 {"ok":true}` |
| GET | `/admin/api/login`（方法不符） | 会话 | `401 未登录或会话已过期` |
| GET | `/admin/api/providers` `virtual-keys` `credentials` `aliases` `capabilities` `access-paths` `auth-mode` `settings` `usage` `usage/timeseries` `audit` `keystore/status` `secret-refs` `sync` `provider-models` `provider-presets` `redaction-rules` | 会话 | `401 未登录或会话已过期` |
| POST | `/admin/api/chat`（**SSE**） | 会话 | `401 未登录或会话已过期` |

### 1.3 通过态（用临时凭据验完即删，未贴值）【实测】

| 场景 | 结果 |
|---|---|
| `GET /ag/models/sync` 带正确管理员令牌 | `200` + 同步状态 JSON |
| `POST /admin/api/login` 带正确 access token | `200` + 会话令牌（`role: owner`） |
| `GET /admin/api/providers` 带会话令牌 | `200`（1 个渠道） |
| `GET /admin/api/virtual-keys` 带会话令牌 | `200`（7 把） |
| `GET /admin/api/auth-mode` 带会话令牌 | `{"mode":"virtual_key","virtual_key_count":7,"virtual_keys_enabled":true,...}` |
| `GET /v1/models` 带新建临时 virtual key | `200`（4 个模型） |
| `POST /v1/tools/search` 带同一把 key | `502 key_invalid`（上游 key 已失效，**证明已过鉴权并打到上游**） |
| `DELETE` 临时 key 后再打 `/v1/models` | `401 API key 不存在`（撤销即时生效） |
| 管理员令牌打数据面 `/v1/models` | `401 API key 形态不正确（应以 sk-ag- 开头）`（两个平面不通用） |

### 1.4 旁路尝试（全部失败）【实测】

| 尝试 | 结果 |
|---|---|
| `/v1/models?key=` / `?key=wrong` | `401` |
| `/v1/../v1/models`、`/v1/./models`、`/v1/models%2f` | `401`（归一化后仍在前缀内） |
| `//v1/models` | `404`（Node URL 把它解析成 host=`v1`） |
| `/V1/models`、`/v1%2fmodels` | `404`（大小写 / 编码不归一） |
| `/admin/../health`、`/admin/../../etc/passwd`、`/admin/%2e%2e/%2e%2e/etc/passwd` | 分别 `200`（health）、`404`、`404`（穿越被 static.ts 拦住） |
| `/admin/api/../api/bootstrap` | `200`（URL 归一化后就是 bootstrap 本身，属合法豁免） |
| `/ag/models/sync/`、`/ag/models/sync/../sync` | `404` / `401` |

### 1.5 端口枚举【实测】

`ss -ltnp` 全量枚举后映射到"需要什么 credential"：

| 监听 | 属于 | 凭证要求 |
|---|---|---|
| `0.0.0.0:8790` | **AgentGateway**（唯一入口） | 见 §1.1 / §1.2 |
| 其余（DSH Web GUI、TLS 反代、notifyd、redis、mihomo、x11vnc/RDP、stub/mock server 等） | 无关进程 | 不属于本审计范围 |

AgentGateway 进程**只监听一个端口**，没有第二个管理端口 / 指标端口 / 调试端口漏在外面。

---

## 2. 无 credential 可达的端点清单

**合法豁免（已收敛成显式清单，一处定义，最小集合，每条带理由）：**

数据面 —— `http/server.ts` 的 `DATA_PLANE_AUTH_EXEMPTIONS`：

| 条目 | 理由 |
|---|---|
| `GET /health` | 探活 / 负载均衡用；无业务数据、不打上游、不改状态 |

管理面 —— `admin/routes.ts` 的 `AUTH_EXEMPT_ROUTES`：

| 条目 | 理由 |
|---|---|
| `GET /admin/api/bootstrap` | 登录前要知道"有没有账号 / 存储解锁没有"，否则登录页不知道该显示什么 |
| `POST /admin/api/login` | 登录本身：口令或 access token 在这里换会话令牌 |
| `POST /admin/api/logout` | 无令牌时只回 `ok`，不撤销任何会话、不改任何数据 |

**静态资源（`/admin`、`/admin/assets/*`）不是 API 豁免，是登录页的必需品**，
由 `admin/static.ts` 提供，带路径穿越防护 + 扩展名白名单（见 §5）。

**不合法豁免：无。**（历史漏洞 `/v1/models` 无鉴权已由 `feb90ba` 修掉，本次复验确认。）

---

## 3. deny-first 在代码层是否 fail closed

### 3.1 三个"忘了配"场景

| 场景 | 结果 | 证据 |
|---|---|---|
| 部署时忘了给 `createHttpServer` 传 `authenticator` | **401**（数据面整个关着） | 【实测】测试 A：19 个入站脸全 401，runner 零调用 |
| `AG_VIRTUAL_KEYS` 关了、也没配 `AG_ACCESS_TOKEN` | **503**（原来是 200 全放行） | 【实测】测试 C1 / G1 |
| 某个注入端口漏挂鉴权 | 内层仍然拒（纵深） | 【实测】测试 D |

### 3.2 `permissive` fallback 的触发条件（**这是本次唯一的真违背**）

修复前 `auth/data-plane.ts` 的模式判定是：

```
virtualKeys===true  → virtual_key
库里 ≥1 把 key      → virtual_key
配了 access token   → access_token
以上都没有          → permissive   ← 不校验任何凭据，key_id='local-dev'
```

即：**忘配凭据 = 谁都能进**。公网标准下这不可接受。

### 3.3 修法

- 新增第四档 `deny`：以上都没配 → **503**（不是 401）。理由：**没配凭据是运维问题，
  不是调用方传错 key**，两者必须可区分——与 `/ag/models/sync` 未配 `AG_ADMIN_TOKEN`
  回 503 是同一条既有立场。
- `permissive` 改成**显式 opt-in**：`permissive: true` / `AG_DATA_PLANE_PERMISSIVE=1`。
- 三态开关（`di/config.ts` → `GatewayConfig.permissiveEnabled` → `composition-root.ts`）：
  - `true` = 显式放行（本地裸跑 / demo / 内网自用）；
  - `false` = 显式按默认拒绝跑；
  - 不设 = 看装配模式：`mode:'test'` 是**进程内装配**（不起公网、transport 还是 mock），
    保持历史行为；`mode:'production'`（部署脚本那一档）忘了配就是整个关掉。
- `describeDataPlaneAuth()` 在没有鉴权器时报 `deny` 而不是 `permissive`——界面不能撒谎。

### 3.4 S0 的 `PERMISSIVE_AUTHENTICATOR` 占位器（**未改行为**）

它的可达面已经被夹死，【代码推断】+ 测试 A 侧面证实：

- HTTP 面上不可达：`http/server.ts` 的数据面网关先跑，`/v1` 与 `/v1beta` 前缀下没过
  鉴权就进不了 S0；
- `createGateway()` 永远往 runner 里注 `DataPlaneAuthenticator`，所以走到 S0 时占位器
  已被替换；
- 它只服务**进程内直连 runner** 的场景（测试、脚本、dog-fooding 装配），那些场景没有
  传输层，也没有"忘配凭据就公开"的问题。

已在注释里写清可达面。未动它的行为（有二十来个测试依赖它），也未把它算作违背。

### 3.5 部署脚本侧（不在仓库，只读参考）

`~/ai-workspace/ag-serve.mjs` 注入的是 `authenticator: gateway.dataPlaneAuth` +
`mode: 'production'`，**不需要改**：代码侧已保证"脚本漏配凭据也不会放行"（→ 503）。

残留风险（记录，不建议现在改）：若将来有人照抄一份部署脚本却写成 `mode:'test'`，
数据面会回到 permissive。缓解：① 该模式下 transport 默认是 mock，部署根本跑不通，
  会立刻被发现；② 三态语义在 `di/ports.ts` / `composition-root.ts` /
  `auth/data-plane.ts` 三处都写了注释；③ 管理面 `auth-mode` 端点与 VirtualKeys 页
  会把当前模式如实显示出来。

---

## 4. 数据面路径覆盖完整性

`isDataPlanePath(path)` = `path.startsWith('/v1/') || path.startsWith('/v1beta/')`。

【代码推断】逐个入站脸核对（与 §1.1 实测一一对应）：

| 入站脸 | 前缀 | 被网关覆盖 |
|---|---|---|
| `/v1/chat/completions`、`/v1/responses`、`/v1/messages` | `/v1/` | ✅ |
| `/v1beta/models/*:generateContent`、`:streamGenerateContent` | `/v1beta/` | ✅ |
| `/v1/models`、`/v1/models/{id}` | `/v1/` | ✅ |
| `/v1/tools/*`（5 个） | `/v1/` | ✅ |
| `/v1/audio/*`（3 个） | `/v1/` | ✅ |
| `/v1/images/*`、`/v1/embeddings`、`/v1/decisions` | `/v1/` | ✅ |
| `/ag/models/sync` | 都不匹配 | **不走这道门**，但自带管理员令牌门禁（未配 → 503，错令牌 → 401）【实测】 |

**没有"新加的端点不在其中"**：仓库里除 `/v1` + `/v1beta` 外没有别的入站脸
（grep 全部 `path:` 字面量确认）。gemini 的脸就在 `/v1beta/models/...` 下。

**纵深**：tools / audio / modalities 三个注入端口在 `handle()` 内部**各自再过一次**
同一个 `DataPlaneAuthenticator`（与 S0 同实例同语义）——所以即使传输层的门接错，
这些脸仍然拒。【实测】测试 D 专门验了这条。

**唯一单点**：`/v1/models` 与 `/v1/models/{id}` 只有传输层一道门（models 端口自身
不带鉴权器）。这正是 `feb90ba` 修的历史漏洞位置，本次复验确认门在且生效。

---

## 5. 前端侧

| 问题 | 结论 | 证据 |
|---|---|---|
| 静态资源无 token 可下载是否可接受 | **可接受**：登录页本身需要 HTML/JS/CSS；这些文件不含任何秘密 | 【实测】无 token 下载 1.5 MB JS + 750 KB CSS |
| bundle 内有无 secret | **无**。grep 长串（≥24 位 base62）379 个全是标识符 / class 名 / 文档 slug；`sk-` 前缀只命中 CSS class `sk-animate-hide`；无 `AG_*=值` 形态 | 【实测】 |
| 令牌存哪 | **只在内存**（React state + ref），不写 `localStorage` / `sessionStorage`；bundle 里唯一的 `localStorage` 用法是 semi-ui 的**主题偏好**（light/dark/system） | 【实测】grep bundle + 读 `webui/admin/src/auth.tsx`、`api/client.ts` |
| 登录后的会话校验是仅前端藏路由还是服务端也校验 | **服务端校验**。前端 `token === null` 时只渲染登录页（藏路由只是体验），所有 `/admin/api/*` 在服务端过 `auth.authenticate()`；带错令牌 / 过期令牌 → 401 | 【实测】§1.2 全表 + 测试 E |
| SSE 端点 | `POST /admin/api/chat` 在路由门**之后**，无会话 → 401（流式端点没有单独 bypass） | 【实测】 |
| sourcemap | 未发布：`/admin/assets/*.js.map` 落到 SPA fallback 返回 index.html（847 B），不是真 map | 【实测】 |
| 前端密钥回显 tripwire | `secretTripwire` 在把响应交回页面前扫疑似完整密钥并阻止渲染 | 【代码推断】（`api/client.ts` 有单测 `webui/admin/src/api/redaction.test.ts` 13 例通过） |

---

## 6. 次要项（记录为建议，**未擅自改**）

| 项 | 现状 | 建议 |
|---|---|---|
| 错误响应泄露 | 【代码推断】数据面 500 分支把 `err.message` 原样回给客户端（`http/server.ts` 的"双保险" catch），可能带内部路径 / provider 细节；`/v1/models` 的 500 走 `describe(err)` 同理。管理面与 tools/audio 已经做干净（管理面只回通用文案 + 路由；tools 明确"网络层失败不带 err.message，可能含内网地址"）。**建议**：把数据面这两个 500 也收敛成一句话 + `x-request-id` | 中 |
| 请求体大小限制 | 【代码推断】`/v1/chat/completions` 等 pipeline 脸**读 body 无上限**（`for await` 全收进内存）；tools / audio / modalities / admin 都有上限（音频 8 MiB+64 KiB、模态 32 MiB、admin 256 KiB）。公网下无上限 body = 现成的内存耗尽面。**建议**：给 pipeline 脸加一个 `readBodyLimited` | 高（可用性，非鉴权） |
| CORS | 【代码推断】全仓库没有任何 `access-control-*` / origin 处理——即默认同源，浏览器跨域打不过来。对"只有自己用"是安全的；若将来要允许多个前端域名，需要显式加并**别**用 `*` + credentials | 低 |
| 无限流 / 超时 | 【代码推断】有 `AG_GLOBAL_TIMEOUT_MS`(300 s) / `AG_TTFB_TIMEOUT_MS`(30 s) / `AG_STREAM_IDLE_TIMEOUT_MS`(120 s) / `AG_MAX_TURNS`(10)。未见对并发连接数的限制 | 低 |
| `/admin/api/bootstrap` 信息量 | 【实测】无会话可拿到 `storage_unlocked`、keystore `mode`、`tradeoff_note`、`argon2_rehash_recommended`。登录页需要"有没有账号 / 解锁没有"，这一条是合法豁免；但 `mode` 与 `tradeoff_note` 属于额外披露。**建议**：只保留登录页真需要的字段 | 低 |
| `/adminfoo` 之类 | 【实测】`admin/routes.ts` 用 `path.startsWith('/admin')` 判定静态面，`static.ts` 又用 `startsWith('/admin')`，于是 `/administrator`、`/admin-api/x` 都会返回管理面 SPA。不影响安全（SPA 本来就是公开的），但会让 URL 语义变含糊 | 低 |

---

## 7. 修复内容与回归测试

### 7.1 改动（14 个文件，+752 / −37）

| 文件 | 改动 |
|---|---|
| `auth/data-plane.ts` | 新增 `deny` 档 + `permissive` opt-in 选项；`authError()` 支持自定义 http_status；文件头补 deny-first 说明 |
| `gateway-core/pipeline/stages/s0-ingress.ts` | `DataPlaneAuthMode` 增加 `'deny'`；写清 `PERMISSIVE_AUTHENTICATOR` 的可达面 |
| `di/ports.ts` | `GatewayConfig.permissiveEnabled`（三态文档） |
| `di/config.ts` | 读 `AG_DATA_PLANE_PERMISSIVE`（显式 0/false → `false`，不设 → `undefined`） |
| `composition-root.ts` | `permissiveDataPlane = config.permissiveEnabled ?? mode === 'test'`，注入真鉴权器 |
| `http/server.ts` | 新增 `DATA_PLANE_AUTH_EXEMPTIONS` + `isDataPlaneAuthExempt()`；健康检查改走清单；`HEALTH_PATH_DEFAULT` 单一来源 |
| `admin/routes.ts` | 新增 `AUTH_EXEMPT_ROUTES` + `isAuthExemptRoute()`；路由门改走清单 |
| `admin/api-types.ts` / `admin/service.ts` | `AuthModeResponse.mode` 增加 `'deny'`；无鉴权器时报 `deny` 不报 `permissive` |
| `webui/admin/src/api/types.ts` / `pages/VirtualKeys.tsx` | 类型加 `'deny'`；deny 档显示安全警告（带 `ui-copy: allow` 理由） |
| `.env.example` | 记录 `AG_DATA_PLANE_PERMISSIVE` 三态与默认拒绝语义 |
| `tests/virtual-key.test.ts` | 「什么都没配 → permissive」改为断言 `deny`(503)；新增「显式 opt-in → 放行」 |
| `tests/data-plane-deny-first.test.ts` | **新增**，13 例 |

### 7.2 新增测试（全部离线、不用真实凭据，断言只比较状态码）

`tests/data-plane-deny-first.test.ts`：

| 编号 | 断言 |
|---|---|
| A | 忘传 `authenticator` → 19 个入站脸全 401、runner 零调用、`/health` 仍 200、未知路径 404 |
| B | 两个豁免清单都是最小集合，且每条都带 `why` 理由 |
| C1 | 什么都没配 → `auth-mode` 报 `deny`，每个入站脸都 401/503，**一次上游都没打** |
| C2 | `/ag/models/sync` 无管理员令牌 → 401（错令牌也 401） |
| D | 传输层门故意敞开（PERMISSIVE_AUTH）时，S0 + 各注入端口自己的鉴权仍然拒 |
| E | 管理面 15 个端点无会话 → 401；带会话 → 200（不是一律 401 的假绿灯）；SSE 端点同样 401 |
| E2 | 三条免鉴权端点确实免鉴权，且 bootstrap 响应不含任何凭据 |
| F | `AG_DATA_PLANE_PERMISSIVE` 三态读法（不设 / 1 / true / 0 / false） |
| G | `mode:'production'`（部署脚本那一档）漏配凭据 → 503；同一装配显式放行后才 200 |

### 7.3 变异验证【实测】

把 `permissiveDataPlane` 改成恒 `true`（即"恢复旧行为"）后重跑：
`tests/data-plane-deny-first.test.ts` + `tests/virtual-key.test.ts` 共 **3 例转红**。
测试确实在守这条线，不是绿灯装饰。

---

## 8. 全量验证结果【实测】

| 命令 | 结果 |
|---|---|
| `npm test` | **1555 passed / 22 skipped**（69 文件通过、1 跳过）；基线 1541 passed |
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npm run typecheck:admin` | clean |
| `npm run lint` | clean |
| `npx prettier --check`（本轮改动文件） | clean（`webui/admin/src/pages/VirtualKeys.tsx` 的排版告警是**基线既有**——该目录从未按 prettier 排版，`.prettierignore` 有说明；未重排以免混入无关 diff） |
| `npm run check:ui-copy` | 绿灯（新增的安全警告走豁免并带理由） |
| `privacy-scan --staged --fail-on any` | **0 可疑点** |

隐私判定：本轮新增 / 标注的 `privacy-scan: ignore` 全部是**带 `not-real` / `wrong-`
后缀的假测试口令与假 key**（只在本文件内造会话、触发登录失败断言），
外加一处 `http/server.ts` 读 `x-api-key` **请求头名**的误报；无任何真实凭据。
报告、提交信息、代码里均未出现真实 token / key。

---

## 9. 结论

1. **直播状态下没有任何无凭据可达的数据面端点**（19/19 拒绝），管理面只有 3 条合法豁免。
2. **唯一的 deny-first 违背已修**：`permissive` 从"什么都没配时的兜底"变成"显式 opt-in"，
   忘配凭据现在返回 **503** 而不是放行。
3. 豁免已收敛成两处显式清单（数据面 1 条 / 管理面 3 条），每条带理由，并由测试断言
   "没被悄悄扩大"。
4. **未做**（记录在 §6，按任务书要求不擅自改）：数据面 pipeline 脸的请求体无上限、
   数据面 500 分支的 `err.message` 回显、`/admin/api/bootstrap` 的额外信息量。
5. **未验证**：真实 provider 的端到端调用（上游 key 已失效）；`mode:'test'` 装配被
   误用于公网的场景（只能靠注释与 UI 提示防，见 §3.5）。
