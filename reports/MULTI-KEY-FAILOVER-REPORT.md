# 多 key failover + 按凭据记账 —— 实施报告

分支 `dsh-threads/47-6de80d`，从 `766530f`（main HEAD）开出 ｜ 提交 `b7413fe`

对应用户报障：「我多个 deepseek-key 又怎么办？」——查出三个真缺口：`headersFor`
里 `const cred = creds[0]` 永远只取第一把 enabled 凭据；第一把 401/403 直接失败
还把整条渠道 `auto_disable`，然后所有请求挂掉等人工；`credential_id` 全仓没有
消费者，用量看不出是哪把 key 烧的。

---

## 1. 改动文件

| 文件 | 改动 |
|---|---|
| `gateway-core/pipeline/stages/s5-upstream.ts` | attempt 内套一层凭据轮换；换钥状态机；穷尽诊断尾注；渠道失败的记录时机 |
| `credentials/resolver.ts` | `headersFor` / `billingModeFor` 可指定凭据；编号 env 变量登记多把凭据 |
| `metering/usage-record.ts` | `UsageRecord.credential_id` + `UsageRecordInit.credential_id` |
| `gateway-core/pipeline/stages/s10-usage-emitter.ts` | 从 `ctx.state` 抄 `credential_id`；`billingModeFor` 按实际用的那把判 |
| `ir/context.ts` | `CTX_STATE_KEYS.ATTEMPT_CREDENTIAL_ID`（把原来的魔法字符串收进注册表） |
| `admin/api-types.ts` | `UsageSummary.by_credential` |
| `admin/service.ts` | `usageDashboard` 按 key 聚合；`UsageRecordSource` 加 `credential_id`；`UNATTRIBUTED_CREDENTIAL` |
| `composition-root.ts` | usageSource 适配器透出 `credential_id`（漏了它看板就永远是空的） |
| `webui/admin/src/charts/usage.ts` | `rankedBuckets` 加 `credential` 维度（model / provider 逐字不变） |
| `webui/admin/src/pages/Usage.tsx` | 「按凭据花费」排行卡 |
| `webui/admin/src/api/types.ts` | `by_credential` 契约 |
| `docs/design/20-pipeline.md` | §S5 换钥；§7.3 决策矩阵加「换下一把凭据」一列 |
| `docs/design/45-credentials.md` | 新增 §5.4「同一 access path 的多把凭据」 |
| `.env.example` | 编号 key 约定 |
| `tests/multi-key-failover.test.ts` | 新增 28 条 |
| `webui/admin/src/charts/usage.test.ts` | 新增 3 条 |

未碰：`providers/mimo/**`、`adaptors/openai-responses/**`；`webui/` 只碰用量页
与其图表/契约（4 个文件）。

---

## 2. failover 状态机

`attempt_plan` 的一个 attempt 钉死的是 (provider, access_path, model)，**不钉死
用哪把 key**。attempt 内部按 `priority` 升序逐把试 `credentialsFor` 返回的
enabled 凭据：

```text
for attempt in attempt_plan:            # provider 级 fallback（既有）
  for credential in credentialsFor(access_path):   # ← 新增：凭据轮换
    for retry in 0..max_retries:        # 同凭据重试（既有）
      send → 2xx? return
            401/403 → 记这把失败，换下一把
            429/5xx  → 重试用尽后：429 换下一把，5xx 不换
            400      → 抛（不换不重试）
            连接失败 → 重试用尽后不换
```

**判据只有一句：「凭据形状」的失败才换钥匙。**

| 上游表现 | 同凭据重试 | 换下一把凭据 | provider 级 fallback | 理由 |
|---|---|---|---|---|
| 401 / 403 | ❌ | ✅ | ✅ | key 失效 / 没有该端点权限 |
| 429 | ✅（≤2） | ✅（重试用尽后） | ✅ | 这把 key 的速率/配额到了 |
| 400 参数错误 | ❌ | ❌ | ❌ | 参数错误与钥匙无关，换 N 把都是同一个 400 |
| 500 / 502 / 503 | ✅ | ❌ | ✅ | 上游自己出事，换 key 照样挂 |
| 连接失败 / DNS | ✅ | ❌ | ✅ | 同上 |
| 流式中途断开 | ❌ | ❌ | ❌ | 已出字节，不可回退 |

三条实现细节：

1. **换钥走完整的一次 attempt**：新 `AbortController`、重新检查 deadline 预算、
   重新计 TTFB、新的 `recordStage`（`attempt=0 cred=2/3 status=401`）与 metrics。
   不是把同一个请求的头改掉重发。
2. **穷尽诊断**：每把都试过且全失败时，最终错误追加
   `（<access path> 下 N 把凭据都失败（401、403、401））`。单凭据路径永不追加
   （`credentials.length > 1` 判据），错误信息与加换钥之前**逐字一致**。
3. **429 的顺序**：先用尽同把的重试预算（指数退避），再换下一把。所以两把 key
   遇到 429 时是 3 + 1 = 4 次上游调用，不是 2 次。

---

## 3. auto_disable 粒度：建议与理由

**建议：按凭据粒度记失败，整条渠道的禁用判据改成「该路径上所有凭据都失败」。**

**落地方式（关键）：没有改 `recordUpstreamFailure` 的语义。** 那个方法
「401/403 → 立即禁用渠道」的判断一点没动（`tests/provider-ops.test.ts` 的既有
用例原样通过）。改的是 **S5 什么时候认为"这条渠道失败了"**：

```ts
// 每个非 2xx 响应都记一次渠道失败（与加换钥之前逐字一致：重试也算），
// 唯一例外是这把的失败是"凭据形状"的且还有下一把可试。
const willRotate =
  (res.status === 401 || res.status === 403 || res.status === 429) &&
  credentialIndex + 1 < credentials.length;
if (!willRotate) deps.providerHealth?.recordFailure(attempt.provider, res.status);
```

理由：

1. **语义不动比语义改更安全**。「key 失效不是抖动，继续打只是把配额烧在必然失败
   的请求上」这个判断是对的，不该被推翻；错的是"一把 key 失效 = 整条渠道失效"。
2. **单凭据路径逐字一致**：`willRotate` 在没有下一把时恒为 false，于是每个非 2xx
   都照记——一个 500 重试 3 次仍然记 3 次、达到阈值 3 仍然禁用。回归零成本。
3. **多凭据路径自愈**：一把死 key → 不记渠道失败 → 换一把成功 → `recordSuccess`
   连"成功即恢复"的旁路都不需要触发。不会出现「禁用窗口里并发请求全被挡」的竞态
   （那正是用户被单 key 坑过的形态）。
4. **确实全挂时照样禁**：最后一把也失败 → `willRotate` 为 false → 记 401 → 立即
   禁用。安全边界没有放松。

**代价（明说）**：一把死 key 仍然会在每个请求上被先试一次（多一次往返 + 一次
注定失败的上游调用），因为 `credentialsFor` 只过滤 `enabled`、不过滤 health，
而 env 档凭据压根没有健康记录。彻底解法是 45 §4.2 步骤 3a 的"跳过不健康凭据"，
那是路由期决策，留作后续。

---

## 4. 按 key 记账的数据形态

```ts
// metering/usage-record.ts
interface UsageRecord {
  access_path?: string;
  /** 本次实际使用的上游凭据 id（多 key 换钥时是最终成功的那一把）。只有 id，绝不放 key 本体。 */
  credential_id?: string;
  …
  cost: UsageCost;   // { cash, as_api, status } —— 双口径原样
}
```

- **S5 填、S10 抄**：`ctx.state[CTX_STATE_KEYS.ATTEMPT_CREDENTIAL_ID]`。
  多 key 换钥时记的是**最终成功的那一把**；全失败的请求也记账
  （`status: 'error'`），凭据是最后试的那一把。
- **看板**：`UsageSummary.by_credential: Array<{credential, request_count, cash_total}>`，
  由 `usageDashboard` 聚合；`composition-root.ts` 的 usageSource 适配器必须透出
  这个字段（漏了它看板永远是空的——这一行是本次唯一一处"不加就静默失效"的接线）。
- **归不到任何一把 key 的归 `未记录`**（`UNATTRIBUTED_CREDENTIAL`）：路径不需要
  凭据（mock / local）、上游调用没走到签发鉴权头、以及这个字段加上之前的历史记录。
  **不并进某一把 key 里冒充**——"看不出是哪把 key 烧的"本身就是要被看见的事实。
- **与双轨计费正交**：按 key 拆的是用量归属，`cash` / `as_api` 两个口径照旧都算。
  顺带修了一处相关的正确性问题：`billingModeFor` 改成按**本次实际用的那把**判
  （同一条路径上 `tp-` 订阅与 `sk-` 按量可以并存，按路径判会把按量用量的现金
  成本记成 0）。
- **凭据 id 形态**：`env:deepseek.openai-chat`（第 1 把）、
  `env:deepseek.openai-chat#2`（第 2 把）。1 号不带后缀是刻意的——否则"加了多 key
  支持"会顺手改写所有历史用量记录的归属。

---

## 5. 轮询 / 负载均衡：建议**不做**

**先回答那个问题：这些 key 通常是同配额还是不同账号不同配额？**

**网关这一侧无从知道**，而且两种都存在：

- DeepSeek 控制台允许一个账号建多把 key → 同一余额、同一配额；
- 更常见的动机是"多账号分摊"→ 不同余额、不同配额。

所以轮询是一个赌注，而 failover 不是。建议不做的理由：

1. **failover 已经覆盖了用户的真实痛点**（一把 key 失效 → 整站聊不了）。轮询只是
   吞吐的锦上添花，而且它不解决任何"失效"问题。
2. **没有按 key 的配额/健康可见性时，轮询可能反而增加 429**：把流量摊到一把接近
   限额的 key 上，换来一次 429 + 一次换钥往返。而每次 429 都要先烧掉同把的 2 次
   退避重试才换钥——延迟比不打那张 key 更差。
3. **前置条件不存在**：45 §4.2 步骤 3a「凭据 health != ok → 跳过」是设计里有的，
   但没实现（env 档压根没有健康记录）。在没有健康判断的轮询上做负载均衡是最糟的
   组合。
4. **补做成本低**：就是 `credentialsFor` 的排序策略或一个轮转下标，一天的工作量；
   而赌错的代价是用户可见的 429。先看 `by_credential` 看板积累真实数据再决定。

如果以后要做，正确顺序是：先做按凭据的健康/冷却（45 §4.2 步骤 3a + 熔断），
再在同一把 key 内部做加权轮询，**并且**要能按 key 关掉轮询（回退到 priority 顺序）。

---

## 6. 我实测过的 / 我推断的

### 实测过（`tests/multi-key-failover.test.ts` 28 条 + `charts/usage.test.ts` 3 条，全绿）

- 第一把 401、第二把 200 → 客户端 200，且 `transport.requests[1]` 的
  `authorization` 确实是第二把 key；
- 403 同样换钥；429 先用尽同把 3 次再换（共 4 次上游调用）；
- 5xx / 400 不换钥（上游调用次数与key头都不变）；
- 三把全 401/403 → 错误含「3 把凭据都失败」+ 每把的状态码；
- **单凭据回归**：错误信息无尾注（`toBe('key dead')` 逐字相等）、429 仍重试 3 次、
  401 仍立即 auto_disable、5xx 仍按"每个失败响应记一次"计到阈值；
- auto_disable 三重断言（审计无 `provider.auto_disable` / 渠道无 `auto_disabled` /
  健康非 `error`）——这个断言**确实抓到了 bug**：把 `willRotate` 判断挪到
  `rotate` 赋值之前（第一版就这么白写了），测试立刻红；
- 记账：换钥成功后记录里是第二把；两个请求分别用两把 key → 两条记录 id 不同；
  `by_credential` 按 key 拆成 2 条而同区间 `by_provider` 只有 1 条；
  mock 路径归「未记录」；全失败请求也记账且凭据是最后试的那把；
- `rankedBuckets` credential 维度 + model / provider 既有标签不变。

### 推断的（未实测，理由如上）

- **多 key 场景下"一把死 key 每请求多一次往返"的成本量级**：按一次失败的
  DeepSeek 401 往返估约 100–300ms，N 把死 key 就是 N 倍。这是从"换钥前必然先试
  到死 key"推出来的，没有压测。
- **轮询的吞吐收益**：完全取决于 key 是否同配额，而这一点网关不可见——所以这条
  本来就是"推断"，也正是不建议做的原因。
- **编号 env 变量在真实部署里的可用性**：Phase 1 只有 env/keyring 两档，keyring
  没有"列出一个路径上所有条目"的接口，所以编号变量是唯一途径。这是从代码事实
  （`KeyringReader` 只有一个 `read(ref)`）推出来的，没有在真实 keyring 上试过。

---

## 7. 已知缺口（未在本次落地）

1. **管理面 `POST /admin/api/credentials` 录入的凭据没有登记进
   `EnvCredentialResolver`**。`createCredential` 只写加密存储，全仓没有任何地方
   调 `resolver.registerCredential`。也就是说：界面上能建多条凭据，但请求路径
   拿不到它们。要补需要先定 `CredentialStorage.location` 的第四档（例如 `store`）
   与解析器读存储的端口——那是存储模型的决定，不该塞进换钥这一改动里。
   **这意味着当前唯一能喂给 failover 的多 key 途径是编号环境变量。**
2. **按凭据的健康 / 冷却 / 熔断**（45 §4.2 步骤 3a）未实现，因此死 key 会被反复重试。
3. **多轮工具循环**下 `credential_id` 只记最后一轮的那把（`UsageRecord` 只有一个
   字段）。中间轮次用别的 key 时，那部分用量归不到正确 key——需要
   `credential_id: string[]` 或按轮次拆记录，是计费模型的决定。

---

## 8. 验证命令与结果

```bash
npm test                 # 1983 passed / 11 failed / 58 skipped
npm run typecheck        # 绿
npm run typecheck:admin  # 绿
npm run lint             # 绿
npm run check:ui-copy    # 绿灯（阈值 0）
privacy-scan --staged --fail-on any   # 1 条 HIGH，见下
```

**11 条失败是存量**，全部在 `tests/billing-coverage.test.ts`（MiMo 计费登记，
#46 的地盘）。开工前在 `766530f` 上跑的 baseline 就是同样这 11 条——不是本次引入的。

**privacy-scan 的 1 条 HIGH 是存量误报**：`credentials/resolver.ts` 的
`authHeadersFor(accessPath, secret)` 形参名叫 `secret`，main 上同样命中
（`HEAD:448` 同款签名）。按任务书要求不改签名。除此之外无命中；测试一律
`FAKE_KEY_*` 假串，对三个真实 key 的字面量自查结果为 0（本报告自身不出现它们）。
