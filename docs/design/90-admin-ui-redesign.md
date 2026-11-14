# 90 · 管理面 UI 现代化重设计

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：本文档是 `webui/admin/`（Vite + React 18 + TypeScript + Semi Design）的改版依据。
> 触发它的是仓库主人的一句评价：「样式不现代，和上世纪的管理界面一样，起码要超过 NewAPI 目前的界面」，
> 以及两条具体要求：「用量界面还没做图表展示」和「你需要先调研加入什么功能、怎么分 Tab、怎么展示」。
> 本文先给调研结论（§1–§2），再给设计与落地（§3–§9）。**调研部分全部标注一手来源 URL。**

---

## 0. 阅读指引

### 0.1 三个结论（先说答案）

1. **继续用 Semi Design，不换栈。** Semi 2.105 的 354 个设计令牌全是 CSS 自定义属性、
   暗色模式开箱可用、`Nav` 原生支持分组侧栏——"旧观感"几乎全部来自**六个可改的默认值**
   （饱和azure主色、3px 圆角、亮色模式六个背景全是纯白、1px 黑边投影、全边框表格、
   Inter 只声明未打包），而不是能力不足。换 shadcn/ui + Tailwind 的代价估算 4–6 周，
   而改令牌 + 补图表 + 重排 IA 是 1.5–3 周。实测依据见 §2。
2. **图表库一个都不引，自绘 SVG。** Semi 没有任何图表组件；引 Recharts 3.10.1 要多
   126 KB gzip 与 32 个传递依赖（实测，见 §2.5），ECharts 6.1.0 即使裁剪过也要 184 KB gzip。
   自绘 SVG 的净增是 **12 KB gzip**，且颜色直接吃 `--ag-*` 令牌、暗色零成本。
3. **延迟分位与错误率时序先不做。** 后端不记录每次请求的耗时与状态码（`UsageRecord`
   里没有 `duration_ms` / `http_status`，`/usage` 也没有这类维度）。**不放假数据**——
   页面上放一张"依赖 P0-4 请求日志"的说明卡，把缺什么写清楚。

### 0.2 改版前后的差别（一句话版）

改版前：一屏纯白 + 九个平铺导航 + 表格 + 六个汇总卡。
改版后：中性灰画布上的白卡片（发丝边 + 极淡投影）+ 四组侧栏导航 + 一屏概览
（4 张带 sparkline 的统计卡 + 成本/请求量趋势 + 分布排行 + 系统体检）+ 暗色主题。

---

## 1. 调研：现代 LLM 网关管理端的信息架构

调研对象与一手来源：NewAPI / one-api（要超越的参照）、OpenRouter、Cloudflare AI Gateway、
LiteLLM、Helicone、Langfuse、Portkey、Vercel AI Gateway。

### 1.1 NewAPI / one-api（参照系，含一个重要的栈变化）

- **one-api（原版）** 的前端是 React 18 + **Semantic UI React（不是 Semi Design）** + recharts
  （[package.json](https://raw.githubusercontent.com/songquanpeng/one-api/main/web/default/package.json)）。
  顶部横向导航，总览页三张 recharts 折线（模型请求趋势 / 额度消费趋势 / Token 消费趋势，
  标签见 [zh/translation.json](https://raw.githubusercontent.com/songquanpeng/one-api/main/web/default/src/locales/zh/translation.json)）。
  短板：无延迟/错误率图表、无请求级下钻、主题切换靠 `THEME` 环境变量（要重启）。
- **new-api v0.13.2（旧版）确实是 Semi Design**：`@douyinfe/semi-ui` ^2.69.1 +
  `@visactor/react-vchart` + `vchart-semi-theme`
  （[package.json](https://raw.githubusercontent.com/QuantumNous/new-api/v0.13.2/web/package.json)）。
- **new-api 当前 main（v1.0.0-rc.51，2026-11-13 发布）已经迁栈**：React 19 + Rsbuild +
  Tailwind CSS 4 + shadcn/@base-ui + cmdk + next-themes + Recharts 3.10.1 + VChart
  （[web/package.json](https://raw.githubusercontent.com/QuantumNous/new-api/main/web/package.json)）。
  → **"用 Semi" 已经不是与 new-api 的差异化点，它自己刚弃用 Semi。**

**IA（旧版 new-api，即仓库主人截图看到的版本）**：侧边栏四组——
`聊天`（游乐场 / 聊天）、`常规`（概览 / 数据看板 / API 密钥 / 使用日志 / 审计日志 / 任务日志）、
`个人`（钱包 / 个人资料 / 安全与访问）、`管理员`（渠道 / 模型 / 用户 / 兑换码 / 订阅 / 系统信息 / …）。
顶栏：站点名、搜索（Ctrl+K）、通知铃铛、语言切换、**主题设置（主题/颜色/字体/布局四合一调色板面板）**、
头像菜单。快捷键 Ctrl+B 折叠侧栏、Ctrl+K 搜索（[快速上手](https://docs.newapi.ai/zh/docs/guide/feature-guide/user/quick-start)）。

**它的概览页**（[文档](https://docs.newapi.ai/zh/docs/guide/feature-guide/user/overview)）自上而下：
设置引导（3 步绿勾）→ 首个 API 请求（可复制 curl + 三行状态）→ 推荐操作 →
**用量概览**（近 24h 消耗 / 历史使用 / 请求计数，三张卡底部各一条迷你折线）→
剩余额度（余额 + 状态 + 可用时长）→ **性能健康（仅管理员）**（全站近 24h 成功率 / 平均延迟 / 吞吐量 +
流量最高模型）→ 运行时间（Uptime Kuma）→ API 信息 → 公告 → FAQ。

**它的数据看板**（[文档](https://docs.newapi.ai/zh/docs/guide/feature-guide/user/dashboard)，本次调研信息密度最高的一手源）
三个 Tab：模型调用分析 / **分流** / 用户统计。统计卡 7 张（总数 / 总额度 / 总 Token /
缓存读取 / 缓存写入 / 平均 RPM / 平均 TPM）。图表：消耗分布（堆叠柱/面积，top15 + 其他）、
调用趋势（折线，top20 + 其他）、调用次数分布（环形图）、调用次数排行（柱状）、
**分流（桑基式流向图：用户→分组→模型→渠道，连线粗细按额度/Token/请求数，节点筛选、眼睛图标隐藏敏感数据）**、
用户消耗排行（横向柱）+ 用户消耗趋势（面积）。筛选器：快速范围 1/7/14/29 天、自定义起止、
时间粒度小时/天/本周、用户名；**偏好设置存浏览器**；数据按整点汇总，默认 5 分钟刷新。

### 1.2 OpenRouter

`/activity`（聚合）+ `/logs`（请求级）。Activity 四个 Tab：
**Overview**（总花费 / 请求数 / Token 总量 / **blended cost per million tokens** / **cache hit rate**；
排行卡 top API keys / apps / users；usage by model、token breakdown、prompt caching、usage type）、
**Trends**（requests / spend / tokens 时间序列 + 「Trending」环比最大变动卡）、
**Explore**（**临时图表构建器**：Metric + Group/Subgroup（Limit + Rank by，超出并入 Other）+
Rollup + Cumulative sum；bar / line / dot plot 三视图；可保存为命名图表；CSV / PDF 导出）、
**Guardrails**（[Activity](https://openrouter.ai/docs/guides/features/activity)、[Logs](https://openrouter.ai/docs/guides/features/logs.md)）。
**最值得抄的一条**：筛选状态入 URL 且跨 Tab 保持；卡片可直接 View logs / Open in Explorer（带相同筛选下钻）。

### 1.3 Cloudflare AI Gateway

位置：Cloudflare dashboard → AI > AI Gateway。Observability 分组：Logging / Analytics /
Costs / User Insights / Log classification / Custom metadata / OpenTelemetry。
Analytics 指标：Requests、Token Usage、Costs、Errors、**Cached Responses**；
可按时间筛选；Dashboard 外用 GraphQL（[Analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/)）。
User Insights（组织级）有**异常检测**：每用户 p95 session cost 滚动基线，同时超过「相对 2x」+
「组织 p99 绝对值」才标记，不拦截请求（[User Insights](https://developers.cloudflare.com/ai-gateway/observability/user-insights/)）。

### 1.4 LiteLLM Admin UI

入口 `<proxy_base_url>/ui`。侧栏页面：Virtual Keys / Playground / Models + Endpoints /
Agents / MCP Servers / Search Tools / Vector Stores / Logs / Teams / Organizations / Usage /
Budgets。**Settings → Admin Settings → UI Settings → Configure Page Visibility** 可按角色控制
内部用户可见页面（[Page Visibility](https://docs.litellm.ai/docs/proxy/ui/page_visibility)）。
Usage 页两个 Tab：Customer Usage（每客户总花费 / 每日花费趋势 / 模型用量拆解 / 活动指标）+
Endpoint Activity（Endpoint 表格 + Success vs Failed chart + daily usage trends）
（[Quick Start](https://docs.litellm.ai/docs/proxy/ui)、[Customer Usage](https://docs.litellm.ai/docs/proxy/customer_usage)）。
另有登录限流（同源 60s 内 >10 次失败封 5 分钟）与 break-glass 账户。

### 1.5 Helicone / Langfuse / Portkey / Vercel AI Gateway

- **Helicone**：左侧 12 项（Dashboard / Requests / Segments / Sessions / Users / HQL / Improve /
  Prompts / Datasets / Playground / Monitor / Rate Limits / Alerts），Dashboard 覆盖
  costs / latency / token usage / error rates 全量指标，可按 user / session / model /
  custom properties 筛选（[官网](https://www.helicone.ai)、[Reports](https://docs.helicone.ai/features/reports)）。
  有 Alerts（alert metrics + Email/Slack）、Reports（保存图表）、**HQL 查询语言**。
- **Langfuse**：项目 **Home 页本身就是 dashboard**（header 有 dashboard selector，
  可 Set as default，选择反映到 URL 可分享）；Dashboards 分区有 Dashboards 与 Widgets 两个 Tab；
  瓦片 builder：Data Source → Metrics（count / latency / cost / scores）→ Dimensions →
  Filters → Chart Type；**拖拽 + 缩放网格**；Widget ⋮ 菜单支持 Copy to clipboard、
  跨 dashboard 的 ⌘/Ctrl+V 粘贴、Download as JSON / CSV
  （[Metrics Overview](https://langfuse.com/docs/metrics/overview)、[Custom Dashboards](https://langfuse.com/docs/metrics/features/custom-dashboards)）。
  预制 dashboard：Latency / Cost / Usage。
- **Portkey**：Analytics 六个视图（Overview / Users / Errors / Cache / Feedback / Summary）。
  Overview 是「70,000ft view」= cost / tokens / mean latency / requests / users + top models；
  Errors 视图有错误率图 + **「被网关策略救回的请求数」**（retries/fallback/loadbalance/cache 各策略状态）
  （[Analytics](https://portkey.ai/docs/product/observability/analytics)）。
- **Vercel AI Gateway**：Overview 四张图（**Requests by Model** / **P50 TTFT** / **All Tokens** /
  **Spend**），最多回看 36 天；**所有筛选存 URL**；Logs 表格上方有 token volume 图，
  **拖拽框选缩放时间范围**；详情侧面板可拖拽调宽、选中 ID 入 URL
  （[Observability](https://vercel.com/docs/ai-gateway/observability-and-spend/observability)）。

### 1.6 横向结论：图表类型对照

| 要表达什么 | 各家用什么 | 我们的选择 |
| --- | --- | --- |
| 成本随时间 | OpenRouter Spend 时间序列；Vercel Spend 折线；new-api 消耗分布（堆叠柱/面积 top15+其他）；one-api 额度消费趋势折线 | 单系列**面积图**（总量是头条） |
| 请求量 | new-api 调用趋势折线 + 环形分布 + 排行柱状；Vercel Requests by Model | 单系列面积图 + 按模型横向条形 |
| token 分布 | OpenRouter token breakdown（prompt/completion/reasoning）；Vercel All Tokens（in/out） | **堆叠柱**（输入/输出） |
| 延迟 | **Vercel P50 TTFT 是唯一把 TTFT 做成一级图表的**；Portkey mean latency；Langfuse Latency Dashboard（P95/P99）；new-api 只有「性能健康」卡里的平均延迟 | **无数据源，标注依赖** |
| 错误率 | LiteLLM Success vs Failed + Success Rate%；Portkey Errors 视图 + 策略救回数；Cloudflare Errors | **无数据源，标注依赖** |
| 按模型/provider 分布 | new-api 用户消耗排行横向柱；OpenRouter top keys/apps/users | **横向条形，前 8 + 其他** |

### 1.7 值得照搬的 UX 模式（按性价比排序）

1. **筛选状态入 URL + 跨 Tab 保持**（OpenRouter / Vercel / Langfuse）——本次已实现（用量页 `?range=`）。
2. **统计卡规范**：new-api 的 RPM/TPM、缓存读/写；OpenRouter 的 blended cost per million
   tokens 与 cache hit rate——我们的卡片直接沿用（§6.1）。
3. **桑基分流图**（new-api「分流」）——整个调研里最有差异化的可视化。**列为二期**，
   且要超越它：连线可加延迟/错误率着色。
4. **异常检测基线**（Cloudflare：p95 session cost 滚动基线 + 相对 2x/绝对 p99 双阈值）——轻量、高级感强。二期。
5. **临时图表/查询构建器**（OpenRouter Explore；Langfuse widget 市场 + ⌘/Ctrl+V）——二期。
6. **⌘K 命令面板 + 主题/密度设置面板 + 通知中心**：new-api 已全部具备（cmdk + next-themes +
   铃铛「系统公告」通知/时间线双 Tab）。**列为三期**（本期只做主题切换）。
7. **按角色/按用户的页面可见性**（LiteLLM Page Visibility；new-api 左侧边栏个人设置）——多租户必备，但我们的
   管理面只有 owner/viewer 两种角色且页面级粒度已由路由控制，暂不做。
8. **Live tail + 拖拽框选缩放**（Vercel Logs）——日志页标配，我们还没有请求日志页，等 P0-4。

### 1.8 new-api / one-api 的明确短板（我们的差异化机会）

无延迟/错误率时序图；无图表→日志的带筛选下钻；无临时查询/保存视图；无异常检测；
无 per-model 错误拆分；one-api 连主题切换都要重启生效。
**这五条就是"超过 NewAPI"的具体含义**——不是把它的界面抄得更花，而是把它没有的维度补上。

---

## 2. 调研：设计语言与图表库选型

### 2.1 Semi 2.105 的能力边界（在本仓库 node_modules 里实测）

- **令牌是真的 CSS 变量**：`dist/css/semi.min.css` 定义 354 个 `--semi-*` 自定义属性，
  其中 113 个是 `--semi-color-*`（16 个色相各 10 档、语义别名、**20 个图表分类色
  `--semi-color-data-0..19`**）、6 个圆角、1 个投影、字体栈。
  **运行时改主题不需要任何构建插件**——一段 `:root { --semi-color-primary: … }` 就能整体换肤。
- **暗色模式纯靠 CSS**：`semi.min.css` 里 `body[theme-mode="dark"]` 那一大块把整套令牌重定义
  （暗色背景阶梯 `#16161a → #232429 → #35363c → #43444a → #4f5159`、发丝边
  `rgba(255,255,255,.08)`、投影改 inset 1px + 柔影）。**React 侧没有主题 API**：
  `ConfigProvider` 在 2.105 只有 `locale` / `timeZone` / `direction` / `getPopupContainer` /
  `responsiveMap`，**没有 `theme` prop**（1.x 有，已移除）。官方暗色文档：
  <https://semi.design/en-US/advanced/dark-mode>。
- **`Nav` 原生支持分组**：`items?: (string | { itemKey, text, icon?, items? })[]`，
  嵌套 `items` 递归；另有 `header={{logo,text}}`、`footer={{collapseButton:true}}`、
  `isCollapsed` / `defaultIsCollapsed` / `onCollapseChange`、`openKeys` / `onOpenChange`
  （[Nav 文档](https://semi.design/en-US/navigation/navigation) + 本仓库
  `node_modules/@douyinfe/semi-ui/lib/es/navigation/index.d.ts`）。
  所以 NewAPI 式的四组侧边栏、可折叠、底部用户区，**一个组件就能表达**。
- **没有 `Statistic` 组件**（1.x 之后移除），**没有任何图表组件**（包里没有 chart 目录）。
  统计卡与图表只能自己写——这与"只封装业务组件"的边界正好吻合。
- **项目活着**：2.105.0 发布于 2026-11-12（npm registry），官方称"每两周一个 minor"，
  共 628 个版本（[changelog](https://semi.design/en-US/ecosystem/changelog)）。
  生态是真实短板：周下载 ~27.7k（antd ~4.9M），第三方主题与图表集成很薄。

### 2.2 Semi 的"旧"来自哪六个可改的默认值（全部实测自 semi.min.css）

| 令牌 / 规则 | 亮色默认值 | 现代参照（Vercel / Linear） | 我们的覆盖值 |
| --- | --- | --- | --- |
| `--semi-color-primary` | `rgb(0,100,250)` 饱和 azure | Vercel 近黑 `#171717`；Linear 低彩度 indigo `#5e6ad2` | indigo `#4f46e5` |
| `--semi-border-radius-small` | **3px**（多数控件用它） | 6–8px | `6px`（控件）/ `10px`（卡）/ `14px`（浮层） |
| `--semi-color-bg-0` … `bg-4` | **六个全是纯白** | Vercel `#fff / #fafafa / #f5f5f5` 阶梯 | 画布 `#f6f7f9` + 表面 `#fff` |
| `--semi-shadow-elevated` | `0 0 1px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.1)`（1px 黑边） | Vercel `0 0 0 1px rgba(0,0,0,.08)` 发丝边 | 中性低透明度多层投影 |
| `.semi-table-container` | 四边 1px 边框 + 单元格 1px + **表头 2px 下边框** + 表头 600 粗体 | 发丝边 / 无边框表格 | 表头改 12px 次级色 + 1px 发丝边 |
| 字体 | Inter 只**声明**未打包（官方 tokens 文档明说"the default English font inter needs to be introduced separately"） | 自托管 Inter / Geist | 沿用 Semi 栈，接受系统回退（见 §4.2） |

**这六项没有一项是 Semi 的能力上限，全是默认值。** 把它们改掉，"上世纪观感"就去了大半。

### 2.3 换栈的代价（估算，非实测）

现有前端 10 个页面、约 5,000 行；Semi 用量直方图：`Typography` ×86、`Tooltip` ×34、
`Button` ×23、`Tag` ×14、`Card` ×6、`Layout` ×4、`Select` ×2、`Tabs` ×2、`Row/Col` ×1，
外加 Table / Nav / Input / Toast 与一个 447 行的 Semi Form 弹窗。

| 路线 | 工作量 | 结论 |
| --- | --- | --- |
| Semi 令牌重排 + 补图表 + 重排 IA | **1.5–3 周** | 本次选它 |
| Semi + Tailwind 混合（官方 `cssLayer` 配方，<https://semi.design/en-US/ecosystem/tailwind>） | 2–3 周 | 备选：想要 Tailwind 的开发速度时 |
| 全量迁 shadcn/ui + Tailwind v4 | **4–6 周** | 不选 |

不选全量迁移的理由：(a) 代价是前者的 2–3 倍，而收益的大头（画布分层、圆角、图表、
IA 重排）前三条路线都能拿到；(b) shadcn **没有版本化组件契约**——源码拷进来自己维护，
升级手工；(c) 会丢掉 Semi 成熟的 DatePicker / i18n / a11y 覆盖；(d) 与仓库
"不自建前端组件库"的约定冲突（AGENTS.md：`webui/` 不从零画）。
**换 Stack 不能替代审美**：new-api 自己迁到 shadcn 之后，社区对其新界面的评价是
"前端全是 AI 写的就算了，写的人还一点审美没有"（[issue #5099](https://github.com/QuantumNous/new-api/issues/5099)）。
能超过它的是图表维度与信息密度，不是 CSS 框架。

### 2.4 现代 Admin 设计语言的具体特征（Linear / Vercel / Resend）

来源为第三方对这几家公开令牌的分析（非本人截图，精确 hex 以那些分析为准）：
[VoltAgent DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md)、
[vercel.com/geist/colors](https://vercel.com/geist/colors)、
[OpenDesign Resend](https://open-design.ai/plugins/design-system-resend)。

共同语法：**中性优先**（无彩度表面 + 一个克制的强调色）、**1px 发丝边或"阴影当边框"**、
圆角 6–12px、紧凑字阶（12/13/14/16，500/600 两档权重）、 generous 留白、
暗色优先的令牌、**表格与统计数字用等宽数字（tabular numerals）**。
Linear 的深度靠"表面阶梯 + 发丝边"而不是投影；Vercel 用 `0 0 0 1px rgba(0,0,0,.08)`
当边框。**这些正是 §4 要落到 `--ag-*` 上的东西。**

### 2.5 图表库选型（实测体积，非估算）

在本机用 esbuild 实捆各库需要的最小图表集（折线/面积/柱 + 坐标轴 + tooltip），
React 标为 external：

| 方案 | min | **gzip** | 新增传递依赖 | 暗色 |
| --- | --- | --- | --- | --- |
| 现状（Semi 全量，基线） | 862 KB | **254 KB** | — | CSS 变量，免费 |
| **自绘 SVG（本次实现）** | 897 KB | **266 KB（+12 KB）** | **0** | 吃 `--ag-*`，免费 |
| Recharts 3.10.1 | 415 KB | **126 KB** | **+32 包**（react-redux、@reduxjs/toolkit、immer、victory-vendor/d3、decimal.js-light、es-toolkit…） | 走 JS color props，要手工接令牌 |
| ECharts 6.1.0（已按需裁剪） | 525 KB | **184 KB** | +1 包 | 走 JS option，要手工接令牌 |

**结论：自绘 SVG。** 理由按权重排序：

1. **体积**：Recharts 是当前产物的 +50%、32 个传递依赖；ECharts 即使裁剪也要 184 KB gzip，
   接近整个现有产物体积。管理面是自托管小工具，多 126 KB 是为了少写 ~300 行。
2. **暗色一致性**：两个库的颜色都走 JS props，与 Semi / 我们的 CSS 变量令牌是两张皮，
   切换主题要么双份配置要么监听重渲染。自绘直接 `var(--ag-chart-1)`，主题切换零成本。
3. **交互正好够**：本次需要的是十字准星 tooltip、键盘移动准星、等距空桶、单系列面积填充——
   自绘 ~300 行全覆盖；不需要 brush/zoom、不需要图元序列化导出。
4. **与仓库约定一致**：AGENTS.md「不自建前端组件库」针对的是**通用 UI 组件**（按钮/表格/弹窗），
   那些继续用 Semi； Semi 没有图表，所以图表不属于"重复造轮子"。
5. **代价说清楚**：自绘要自己维护 a11y（本次做到：svg `role="img"` + `aria-label` +
   可聚焦 + 方向键移动准星 + Esc 收起）、自己没有单元测试的交互细节、
   以及后续要加 brush/zoom 时得自己写。**如果将来要桑基图或拖拽框选缩放，
   这个结论要重新评估**（那时 VChart 有 Semi 主题、Recharts 生态更熟）。

---

## 3. 信息架构（前后对照）

### 3.1 改版前：九个平铺页

侧栏一列九项，没有分组、没有主次：渠道 / 凭据 / 客户端密钥 / 别名映射 / 模型目录 /
用量看板 / 系统设置 / 安全与密钥 / 帮助。默认落地页是**渠道**——管理员开门第一眼
看到的是上游配置，而不是"网关跑得怎么样"。

### 3.2 改版后：四组 + 一个概览主场

| 组 | 页面 | 路由 | 回答什么问题 |
| --- | --- | --- | --- |
| **总览** | 概览 | `#/overview` | 网关此刻正常吗、钱在涨吗 |
| **上游接入** | 渠道 | `#/channels` | 请求打到哪个上游 |
| | 凭据 | `#/credentials` | 用哪把 key 访问上游 |
| | 别名映射 | `#/aliases` | 客户端写的 model id 落到哪 |
| **模型与用量** | 模型目录 | `#/catalog` | 有哪些模型、什么能力 |
| | 用量看板 | `#/usage` | 花了多少、怎么花的（可下钻） |
| **系统** | 客户端密钥 | `#/virtual-keys` | 客户端怎么接进来 |
| | 系统设置 | `#/settings` | 运行时参数怎么配 |
| | 安全与密钥 | `#/system` | 密钥存储什么状态 |
| | 帮助 / 文档 | `#/help` | 规则与代价的完整说明 |

分组名对照 NewAPI 的四组式（它自己是 聊天/常规/个人/管理员），但按**网关管理员**的
四个问题重排。实现用 Semi `Nav` 的嵌套 `items`（§2.1），不自己画侧栏。

### 3.3 为什么把「概览」设为默认落地页

NewAPI 的默认落地也是概览（它的侧栏「常规」组第一项）。理由不是抄它，而是
**两类信息的读取频率不同**：渠道/凭据/别名是一次性配置，看完就不再来；
而"今天花了多少、有没有报错"是每次开门都想确认的。把低频配置页当主场，
等于让管理员每次开门都先翻过一屏用不到的东西。

### 3.4 路由与深链（不回归）

- 全部既有路由一字不改：`#/channels` `#/credentials` `#/virtual-keys` `#/aliases`
  `#/catalog` `#/usage` `#/settings` `#/system` `#/help`。
  老书签、外部链接、测试里的断言全部继续有效（`tests/ui-contract.test.ts` 守着这条）。
- 新增 `#/overview`；`/`（无 hash）的归一目标从 `/channels` 改成 `/overview`。
- 时间范围进 hash 查询串：`#/usage?range=7d`、`#/overview?range=30d`。
  刷新与分享链接不丢状态（OpenRouter / Vercel 的做法，§1.7 第 1 条）。
  查询串在路由匹配前被剥掉，因此永远不会把路由判到未知页上去。

---

## 4. 视觉语言

### 4.1 布局

- **画布 / 表面 / 浮层三层明度**：页面底色 `--ag-canvas`（亮 `#f6f7f9`、暗 `#0e0e11`），
  卡片 `--ag-surface`（亮 `#fff`、暗 `#17171c`），浮层用 `--ag-shadow-popover`。
  这是本次改版性价比最高的一笔——Semi 亮色模式下 `bg-0` 到 `bg-4` 六个全是纯白，
  没有明度分层，于是整站只能靠边框"框"出区域。
- **卡片**：`1px` 发丝边（`--ag-border`）+ `--ag-radius-card: 14px` +
  一层几乎看不见的投影（`0 1px 2px rgba(16,18,27,.04)`）。不用重投影——
  Vercel/Linear 的深度来自表面阶梯与发丝边，不来自阴影浓度。
- **栅格**：统计卡 4 列（≥1180px）→ 2 列（≥720px）→ 1 列；主图 + 侧图用 `2fr 1fr`。
  用 CSS Grid 而不用 Semi 的 `Row/Col`：卡片要同一行等高 + 间距统一 + 平滑退化，
  24 栅格在这三点上都不如 Grid 直接。
- **间距节奏**：`--ag-gap: 16px`（卡间距）、`--ag-pad-card: 18px`（卡内边距）、
  页面 `20px 24px 48px`、宽度封顶 `--ag-maxw: 1440px` 居中。
- **顶栏**：48px，左侧面包屑（组 / 页），右侧主题切换与帮助入口。半透明 + backdrop-blur，
  滚动时不抢内容区注意力。

### 4.2 排版层级

| 用途 | 字号 / 权重 | 令牌或类 |
| --- | --- | --- |
| 页面标题 | 20px / 650 | `.ag-page-title` |
| 卡片标题 | 14px / 600 | `.ag-card-title` |
| 统计卡大字 | 26px / 650，负字距 | `.ag-stat-value` |
| 正文 / 表格 | 13px / 400 | 继承 |
| 次级说明 | 12px / 400，`--ag-text-2` | `.ag-card-sub` `.ag-empty-hint` |
| 轴标签 / tooltip | 11–12px | 图表内联 |

- **等宽数字**：`body { font-variant-numeric: tabular-nums }`。并排的统计卡位数变化时
  整行不会抖（Vercel 的同款做法）。
- **字体**：沿用 Semi 声明的栈（Inter → 系统无衬线 → PingFang SC / Microsoft YaHei）。
  官方 tokens 文档明说 Inter **未打包**，所以 Linux 上会回退到系统无衬线——
  中文管理面的可读性由 PingFang / 雅黑保证，不为一个英文字体引入 ~100KB woff2。
  **这是一个已知的取舍，不是疏漏。**
- **代码 / 标识符**：`--ag-font-mono`，`model` / `access_path` / `provider` 一律等宽
  （`.ag-mono`）。

### 4.3 明暗主题

- 机制：`document.body` 挂/摘 `theme-mode="dark"` 属性（Semi 的暗色开关就是它，
  §2.1）；我们自己的 `--ag-*` 令牌在 `body[theme-mode="dark"]` 下重定义一遍。
  **配色全部在 CSS 里，JS 只负责那个属性**（`src/theme.tsx`，~90 行）。
- 三档：亮 / 暗 / 跟随系统（默认）。`system` 档监听 `prefers-color-scheme` 变化。
- 偏好存 `localStorage`（键 `agentgateway.admin.theme`）。**这与"会话令牌只在内存"
  不冲突**：那条约束针对的是 bearer 凭据；主题偏好不含身份信息，写 localStorage 是
  常规做法（new-api 的 next-themes 亦然）。
- **暗色不是亮色取反**：底色取近黑（纯黑上发丝边会闪），表面比画布亮一档，
  状态色整体提亮（暗底上同色值对比度会掉）。Semi 自带的暗色阶梯本身就是
  Linear 级别（`#16161a → #4f5159` + inset 1px 边），我们只覆盖少数语义令牌。

### 4.4 色彩语义

状态色档位命名沿用 **IBM Carbon** 的告色语义（red = danger/error、orange = serious warning、
yellow = warning、green = success、blue = passive notification、gray = not started）
（[Color palettes](https://www.carbondesignsystem.com/building-blocks/data-visualization/color-palettes)、
[Status indicators](https://www.carbondesignsystem.com/building-blocks/core/patterns/status-indicators)）：

| 语义 | 亮色 | 暗色 | 用在哪 |
| --- | --- | --- | --- |
| success | `#15803d` | `#4ade80` | 渠道启用、凭据健康、密钥已解锁、对账正常 |
| warning | `#b45309` | `#fbbf24` | 停用、未定价请求、建议轮换 DEK |
| danger | `#dc2626` | `#f87171` | 删除确认、凭据异常、对账超阈值、未解锁 |
| info | `#1d4ed8` | `#93b4fc` | exact 别名、设置来源「加密存储」 |
| neutral | `#6b7280` | `#9aa0ae` | 未探测、默认值来源 |

三条硬规则：

1. **颜色 + 文字双编码**。每个状态除了色板还有一个圆点形状线索与文字标签
   （`StatusTag`）。色盲用户约占男性 1/8（[ASU](https://accessibility.asu.edu/articles/color-contrast)）；
   Carbon 的要求是 colorblind safe palettes + secondary cues（bold-face / patterns /
   icons / text descriptions）。
2. **图表分类色按亮度差排序**。Datawrapper 色盲检查的第一原则是
   "make sure the colors vary enough in brightness"
   （[colorblind check](https://www.datawrapper.de/blog/colorblind-check)）。
   `--ag-chart-1..6` 已按此排序，且前两档与强调色同族。
3. **环比颜色按指标定，不按涨跌方向定**。同一个 ▲ 在成本卡上是坏事、在请求量卡上是
   好事。Plotly 的 KPI 指引专门点出这个坑（"when red isn't bad"，
   [KPI card guide](https://plotly.com/blog/kpi-card-guide)）。实现见 `deltaOf()`。

### 4.5 空状态与加载态

依据 NN/g 三篇：
[Skeleton Screens 101](https://www.nngroup.com/articles/skeleton-screens)、
[Skeleton vs Spinner（视频）](https://www.nngroup.com/videos/skeleton-screens-vs-progress-bars-vs-spinners)、
[Designing Empty States](https://www.nngroup.com/articles/empty-state-interface-design)。

| 场景 | 用什么 | 为什么 |
| --- | --- | --- |
| 整页首载 | **骨架屏**（与真实布局同形：4 张卡占位 → 图高灰块 → 表占位） | NN/g：全屏加载用 skeleton，wireframe 降低认知负担 |
| 单卡刷新 / 下钻取数 | Semi `Spin` 或图表内联 updating | NN/g：spinner 适合"dashboard 上的一张卡" |
| 响应 < 1s | **不显示加载态** | NN/g：不要为快速加载闪 loader |
| 自动刷新 | 保留旧数据 + 标 stale，**不重新骨架化** | 重新骨架化会毁掉 operational dashboard 的一目了然 |
| 空数据 | `EmptyState`：标题 + 一句系统状态 + 一条直奔关键任务的路 | NN/g：不要真的空着；给 direct pathways |
| **请求还在飞** | **绝不显示"没有数据"** | NN/g：错误的系统状态提示"particularly harmful" |
| 查询失败 | `ag-banner-danger` + 错误文案 | 与空状态视觉语义分开，不共用插图 |

骨架屏的 shimmer 尊重 `prefers-reduced-motion`（theme.css 末尾的 media query）。
分区独立失败：概览页七块数据用 `Promise.allSettled`，一块拉不到不把整页刷白。

### 4.6 与 Semi 的边界（哪些改、哪些不碰）

| 层 | 做法 |
| --- | --- |
| Semi 语义令牌 | **覆盖**：`--semi-color-primary*`、`--semi-border-radius-*`、`--semi-shadow-elevated`、`--semi-color-border`、`--semi-color-fill-*`、`--semi-color-focus-border`。这些是官方暴露的变量，改它们不改组件内部。 |
| Semi 组件 props | 优先用 props（`Card` 的 `bordered` / `shadows`、`Table` 的 `className`）而不是选择器覆盖。 |
| Semi 内部结构 | **只改一处**：`.semi-navigation-item` 的圆角与选中态（Nav 不暴露选中态样式 prop， 而它又是每页都看得见的门面）。表格头通过给 `Table` 传 `className="ag-table"` 覆盖，不碰 `.semi-table-thead` 的全局规则。 |
| 自封装业务组件 | 全部用 `--ag-*` 令牌，不读 Semi 内部色板。将来换组件库时 `src/components/ui.tsx` + `theme.css` 可整体搬走。 |

---

## 5. 图表规范

### 5.1 用哪些图表示什么（及为什么不）

| 图 | 形式 | 数据 | 依据 |
| --- | --- | --- | --- |
| 成本趋势 | **单系列面积图** | 每桶 `cash_total` | 单系列时面积填充让"总量"更醒目；多系列堆面积会出现 moving baseline 问题（[data.europa.eu](https://data.europa.eu/apps/data-visualisation-guide/stacked-charts)、[Domo](https://www.domo.com/learn/charts/stacked-area-chart)） |
| 请求量趋势 | 单系列面积图 | 每桶 `request_count` | 与成本分开两张图，不做双轴（双轴是公认陷阱） |
| token 构成 | **堆叠柱**（输入在下 / 输出在上） | 每桶 `input_tokens` + `output_tokens` | 同时看构成与总量；只有两个系列，堆叠不会出现读数问题（[Datawrapper](https://www.datawrapper.de/blog/chart-types-guide)） |
| 按模型/provider 花费 | **横向条形，降序，前 8 + 其他** | `summary.by_model` / `by_provider` | 模型名动辄 30+ 字符，横条的标签空间够（[Storytelling with Data](https://www.storytellingwithdata.com/blog/2022/1/21/which-bar-orientation-should-i-use)）；**不用环形图**——3% 的差异在饼图里几乎看不见（[Datawrapper pie](https://www.datawrapper.de/blog/pie-charts)） |
| 卡片 sparkline | 一条线 + 末点圆点，**无轴无刻度无边框** | 同一趋势序列 | Tufte：sparkline 的 data-ink ratio = 1.0，尺度由卡片大字承担（[edwardtufte.com](https://www.edwardtufte.com/notebook/sparklines-history-by-tufte-1324-to-now)） |

**明确不用**：平均延迟（会掩盖长尾）、环形/饼图（角度不可比）、仪表盘（角度是前注意属性里
最不适合量化比较的，[NN/g](https://www.nngroup.com/articles/dashboards-preattentive)）、
3D 与重网格（chartjunk）、彩虹分类色（>6 色）、双轴、过多小数位
（Few：过度精确"just slow viewers down"）。

### 5.2 时间桶与轴

- **桶宽由前端给一档、服务端定边界**：`GET /usage/timeseries?from_ts&to_ts&bucket_ms`。
  服务端按 `ceil(span / bucketMs)` 推桶数，再用 `span / 桶数` **反算实际桶宽**，
  保证桶严丝合缝铺满 `[from, to)`——不留短尾巴桶，也不越过 `to`。
  两边各算一套边界迟早会漂，所以前端不自己算。
- 三档预设：24h → 1h 桶（24 个）、7d → 6h 桶（28 个）、30d → 1d 桶（30 个）。
  目标密度 24–40 个点：少于 20 个趋势看不出来，多于 50 个在卡片宽度下每个点不到 20px、
  tooltip 互相打架。上限 120 个桶（服务端 `MAX_TIMESERIES_BUCKETS`）。
  ⚠️ 这套档位**没有**可引用的一手标准（Grafana 只在超过 ~700 点时报
  "Too many points to visualize properly"；Prometheus 会按时间范围自动调分辨率；
  LTTB 是 >2000 点时的标准下采样算法）——它是与上述约束一致的工程综合，不是 cited rule。
- **空桶照样返回**（`request_count: 0`）。趋势图的 x 轴必须等距；缺一个桶就该显示
  "这里真的没有请求"，而不是"这里没有数据"。
- **点太多时用 LTTB 抽样**（`downsample()`），不随机抽——随机抽样会把尖峰抽没，
  而尖峰恰恰是管理员最想看的东西。实测保尖峰（`series.test.ts`）。
- 轴：y 轴 nice 化到 1/2/5×10ⁿ 的整数步长（否则标签落成 34.25 / 68.5）；
  **0 线比网格线重**（计数类指标的轴必须从 0 开始，
  [ONS](https://service-manual.ons.gov.uk/data-visualisation/guidance/axes-and-gridlines)）；
  x 轴最多 6 个标签，含首尾。

### 5.3 交互约定

| 交互 | 实现 | 依据 |
| --- | --- | --- |
| 十字准星 | 鼠标在画区内移动 → 竖虚线 + 各系列在该 x 的点 | Highcharts Stock 默认开启，时序图行业惯例（[Highcharts Tooltip](https://www.highcharts.com/docs/chart-concepts/tooltip)） |
| tooltip 内容 | 时间 + **全部系列** + 合计 | Grafana 的 All 模式；多系列的问题通常是"这一刻总共多少"（[Grafana](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/panels-visualizations/configure-tooltips)） |
| 键盘可达 | svg 可聚焦，←/→ 移动准星，Esc 收起 | NN/g tooltip 指引第 3 条：支持鼠标与键盘悬停（[Tooltip Guidelines](https://www.nngroup.com/articles/tooltip-guidelines)） |
| 时间范围切换 | **页面右上角**分段控件，不进图表内部 | Plausible / AgencyAnalytics 都把主日期选择器放 dashboard 右上角（[Plausible](https://plausible.io/docs/compare-stats)） |
| 环比 | `▲/▼ x% vs 前 7 天`，颜色按指标定 | §4.4 第 3 条 |
| 下钻 | 点分布条 → 跳用量看板（带同一范围） | Carbon exploration dashboard 的 drill down |
| 图例 | 自渲染，色块 + 文字；不做点击过滤（本期只有 1–2 个系列，过滤是多余的交互） | — |

tooltip 用 `position: fixed` 跟随准星，靠近右边缘时翻转方向，不遮挡数据。
**任何关键信息不允许"只有鼠标能看到"**：tooltip 里的数值在统计卡与表格里都有对应。

### 5.4 缺数据 / 缺数据源的语义（本节最重要）

- **空桶 vs 无数据源是两件事**。`available: false`（后端没注入 usage 源）时，
  趋势卡显示说明而不是画一条平的零线——平的零线会被读成"确实没有请求"。
- **延迟分位与错误率没有数据源**，页面上放说明卡，写清缺哪个字段、为什么不能退化成
  平均值/0%。不造假数据（§6.2）。

---

## 6. 概览页设计

### 6.1 卡片清单与数据来源

| # | 区块 | 指标 / 内容 | 来源 API | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 统计卡 · 现金费用 | 区间合计 + sparkline + 环比 | `/usage`（`summary.cash_total`）+ `/usage/timeseries` | 环比 goodWhenUp = false |
| 2 | 统计卡 · 请求数 | 同上 | 同上（`request_count`） | goodWhenUp = true |
| 3 | 统计卡 · Tokens | 输入+输出合计 + sparkline | 同上（`input_tokens`+`output_tokens`） | 成本主要驱动项 |
| 4 | 统计卡 · 未定价请求 | 合计 + sparkline | 同上（`unpriced_count`） | 拿不到价格 ≠ 免费 |
| 5 | 成本趋势 | 每桶现金费用（面积图） | `/usage/timeseries` | 单系列 |
| 6 | 请求量趋势 | 每桶请求数（面积图） | `/usage/timeseries` | 单系列 |
| 7 | 按 provider 花费 | 横向条形，前 8 + 其他 | `/usage`（`summary.by_provider`） | 点击跳用量看板 |
| 8 | 按模型花费 | 横向条形，前 8 + 其他 | `/usage`（`summary.by_model`） | |
| 9 | 余额与对账 | 余额快照 + 偏差 + 阈值 | `/usage`（`balance` / `reconciliation`） | 对账未注入时不渲染该块 |
| 10 | 系统状态 | 渠道启用数 / 凭据健康 / 别名与密钥数 / 密钥存储状态 | `/providers` `/credentials` `/aliases` `/virtual-keys` `/keystore/status` | 七块数据 `Promise.allSettled` |
| 11 | 「还差两张图」说明卡 | 延迟分位、错误率 | — | 见 §6.2 |

用量页（`#/usage`）是 analytical 版本：同样的数据 + 更细的范围 + 六张统计卡 +
token 堆叠柱 + 按模型请求数 + 最近 50 条明细 + 对账 + 余额。
**概览不放明细表**——Few 的"单屏"原则与 NN/g 的 operational/analytical 之分都要求
一页只干一件事。

### 6.2 明确不做（缺数据源）

| 想画的图 | 缺什么 | 为什么不能退而求其次 |
| --- | --- | --- |
| 延迟分位 p50/p95/p99 | `UsageRecord` 无 `duration_ms` / `ttfb_ms`；`/usage` 无该维度 | **不能退化成平均延迟**：延迟分布右偏，均值被长尾拖着走却永远看不到长尾（[nRouter](https://nrouter.ai/blog/engineering/latency-percentiles-p50-p95-p99)）。且分位不可平均、不可相加，必须聚合直方图 |
| 错误率时序 | 无 `http_status` / `finish_reason` 的按桶聚合 | 错误率是 rate，空桶必须显示"无样本"而不是 0%——0% 会把一次故障藏起来。而且要用错误预算 burn rate 判状态，不是裸阈值（[Google SRE Workbook](https://sre.google/workbook/alerting-on-slos)） |
| 缓存命中率 | 无 cache read/write token 拆分 | new-api 与 OpenRouter 都把它做成一级指标；等后端拆了再加 |
| 桑基分流图 | 无 per-request 路由轨迹 | 二期（§8），且要加延迟/错误率着色才值得做 |
| 异常检测基线 | 无历史基线存储 | 二期（Cloudflare 式 p95 + 双阈值） |

### 6.3 数据缺口清单（交给后端，按优先级）

1. **P0-4 请求日志**：每次请求的 `duration_ms` / `ttfb_ms`（流式必须分开记，
   不能混成一个"平均延迟"）、`http_status` / `finish_reason`、以及可选的
   `cache_read_tokens` / `cache_write_tokens`。**没有它，延迟与错误率两张图永远画不出来。**
2. `GET /usage/timeseries` 已由本次实现补齐（`admin/routes.ts` + `admin/service.ts` +
   `admin/api-types.ts`，只读聚合，无新增写入面）。
3. 二期再议：`group_by` 参数（按 provider 分桶的趋势）、per-key 用量下钻端点、
   桑基所需的轨迹聚合。

---

## 7. 组件清单与复用边界

### 7.1 继续用 Semi 的（不封装）

`Layout` / `Nav` / `Button` / `Input` / `Select` / `Table` / `Modal` / `SideSheet` /
`Tabs` / `Toast` / `Banner` / `Popconfirm` / `Skeleton` / `Tooltip` / `Typography`。
边界：**通用 UI 零件不自封装**，只通过令牌与 props 改外观。

### 7.2 自封装的业务组件（`src/components/ui.tsx`）

| 组件 | 职责 | 关键约束 |
| --- | --- | --- |
| `PageHeader` | 标题 + 一句说明 + 右侧操作区 + meta 行 | 解释性内容去帮助页，这里只留导航级的一句话 |
| `StatCard` | 大字 + 单位 + sparkline + 环比 + 口径 tooltip | 环比 tone 由调用方按指标传（§4.4） |
| `ChartCard` | 卡片外壳：标题 / 副标题 / 操作 / 图例 / 主体 / 脚注 | 图例自渲染，不用库的图例 |
| `StatusTag` | 状态标签 | **颜色 + 圆点 + 文字三编码** |
| `ProviderBadge` | provider 两字母缩写 + 全名 | 不引图标库（几十家 provider，图标包 ~1MB） |
| `EmptyState` | 标题 + 系统状态说明 + 一条行动路 | 与加载态不共用 |
| `CardSkeleton` / `StatSkeleton` | 骨架屏 | 与真实组件同高，避免加载完成时跳版 |
| `RangeSwitch` | 时间范围分段控件 | 固定页面右上角 |
| `TimeSeriesChart` | 折线 / 面积 + 十字准星 + 键盘准星 | 自绘 SVG；`role="img"` + `aria-label` + 可聚焦 |
| `RankedBarChart` | 横向条形排行 | 用 DOM 文本而非 SVG `<text>`（标签可省略号、可被读屏） |
| `Sparkline` | 卡片迷你线 | 无轴无刻度无边框（Tufte） |
| `StackedTokenChart` | token 堆叠柱 | 内联在用量页 |

### 7.3 纯函数模块（可单测，不碰 DOM）

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `src/charts/series.ts` | 刻度 / 坐标映射 / path 生成 / LTTB 抽样 / topN 聚合 / sparkline 几何 | `series.test.ts`（26 例） |
| `src/charts/usage.ts` | 范围档位 / 桶→点 / 排行桶 / 轴标签 / 环比语义 | `usage.test.ts`（25 例） |
| `src/format.ts` | 紧凑数字 / 金额 / 时间 | 由上面间接覆盖 |

前端工程**刻意零测试依赖**（不引 jsdom / @testing-library，见 `webui/admin/README.md` 与
`tests/ui-contract.test.ts` 的说明）。所以可测的全放纯函数模块，渲染层靠
`tests/ui-contract.test.ts` 的源码断言守契约。这个取舍不变。

---

## 8. 分阶段落地计划

### 8.1 第一期（本次实现，已落地）

| 项 | 内容 | 状态 |
| --- | --- | --- |
| 视觉基座 | `src/styles/theme.css`（令牌 + 外壳）+ `src/theme.tsx`（明暗） | ✅ |
| 概览页 | `#/overview`：4 张统计卡 + 成本/请求量趋势 + 按模型/provider 分布 + 余额对账 + 系统状态 | ✅ |
| 用量页图表 | 成本/请求量趋势 + token 堆叠柱 + 按模型/provider/请求数分布 | ✅ |
| 导航分组 | 四组侧栏（总览 / 上游接入 / 模型与用量 / 系统） | ✅ |
| 空态与加载态 | `EmptyState` / `CardSkeleton` / `StatSkeleton` / `ag-banner` 规范化 | ✅ |
| 趋势数据源 | `GET /admin/api/usage/timeseries`（后端只读聚合） | ✅ |
| 范围入 URL | `#/usage?range=7d`、`#/overview?range=30d` | ✅ |
| 缺数据标注 | 延迟分位 / 错误率的「待 P0-4」说明卡 | ✅ |

### 8.2 第二期（后端补齐请求日志之后）

1. 延迟分位图（p50/p95/p99 三线）+ 错误率时序（0–100% 轴 + SLO 参考线）。
2. token 构成升级：拆出 cache read / cache write（new-api 与 OpenRouter 都做成一级指标）。
3. 按 provider 分桶的成本趋势（需要 `/usage/timeseries` 加 `group_by`）。
4. 图表 → 日志的带筛选下钻（等请求日志页存在）。
5. 异常检测基线（Cloudflare 式：p95 session cost 滚动 + 相对 2x / 绝对 p99 双阈值）。

### 8.3 第三期（锦上添花，不做也不影响主流程）

1. ⌘K 命令面板（new-api 用 cmdk；我们可以先用 ~80 行实现"跳转 + 切范围"）。
2. 通知中心（铃铛 + 未读角标；new-api 是「系统公告」通知/时间线双 Tab）。
3. 主题/密度/字体设置面板（new-api 的四合一调色板）。
4. 临时图表构建器（OpenRouter Explore：metric + group + rollup + 三视图 + 保存）。
5. 桑基分流图（**要重新评估图表库结论**——那时自绘的成本会明显上升）。
6. 按角色的页面可见性（LiteLLM Page Visibility）。

---

## 9. 验证

### 9.1 本次改动的验收

- `npm test`：974 passed（改版前 906，新增 68 例：`admin/usage-timeseries.test.ts` 10 例、
  `src/charts/series.test.ts` 26 例、`src/charts/usage.test.ts` 25 例、
  `tests/ui-contract.test.ts` +7 例）。
- `npm run typecheck` / `npm run typecheck:admin` / `npm run lint` / `npm run build:admin` 全绿。
- 产物：`index.js` 266 KB gzip（基线 254 KB，自绘图表净增 12 KB）、`index.css` 83 KB gzip。
  零新增依赖。
- 既有路由零回归（`tests/ui-contract.test.ts` 守着九条老路由一字不改）。

### 9.2 还没验证的（明确说清）

- **没有在真实浏览器里看过**：本次改版没有跑起网关 + 登录后逐页点一遍
  （需要真实部署与凭据）。视觉结论来自代码与构建产物，不是截图。
- **暗色模式没有逐组件目测**：Semi 的暗色只覆盖它自己的组件；我们覆盖的
  `.semi-navigation-item` 等少数内部结构在暗色下未逐一看过。
- **窄屏（<720px）未实测**：栅格的断点退化写在了 CSS 里，但没有在手机上验证过。
- **`Inter` 未打包**：Linux 上会回退到系统无衬线（§4.2 的已知取舍）。
