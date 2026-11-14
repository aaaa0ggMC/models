# 91 · Provider 配置体验重设计（新建渠道与 Provider 专属面板）

> 版本：v1.0-draft ｜ 日期：2026-11-14 ｜ 状态：**draft（待 review）**
> 上游依赖：本文是 `webui/admin/`「新建渠道」流程与渠道页的改版依据。它是
> [`90-admin-ui-redesign.md`](./90-admin-ui-redesign.md) 的**补充**（视觉基座、IA、路由一律不动），
> 不是推翻；冲突处怎么裁决见 §0.2。
> 触发它的是仓库主人看过「新建渠道」弹窗后的五条评价（§3.2 逐条对应），以及一句明确要求：
> **「每个 provider 都是自己的配置界面，这样简洁明了，并且还可以给出额外的信息进行更多配置；
> 只有用户选择 Custom 才去配置各种乱七八糟的。」**
> 调研部分全部标注一手来源（URL 或仓库路径）。**本文只做设计，不含实现代码。**

---

## 0. 阅读指引

### 0.1 五个结论（先说答案）

1. **每个 provider 一份「面板描述」，渲染层只有一套。** provider 的差异（几条 access path、
   要不要自动获取模型、有没有专属能力）全部写进数据（`ProviderPanelSpec`），渲染层按
   字段种类分发到一小组渲染器（§5）。新增一个 provider = 加一条预设数据，不改渲染代码。
2. **选 DeepSeek 出现的是「DeepSeek 面板」**：两条 access path 各一个启用开关、同一个 key
   两路共用、「获取模型」按钮拉上游 `/models`（带上下文窗口 / 模态 / effort / `api_capabilities`
   约束）、全家桶能力状态区、文档与备注（§6.2）。**不再让用户手打 model id。**
3. **Custom 才展开完整表单**，且明确标注「高级」；其余预设（OpenAI / Anthropic / Gemini /
   Moonshot / 智谱 / 通义）用同一套轻量模板：key + access path 开关 + 获取模型 + 文档 + 备注（§6.3–§6.5）。
4. **「获取模型」是显式按钮，不做失焦自动触发**；失败按 401 / 403 / 404 / 429 / 网络 / 5xx
   分类，每类给一条可执行动作，错误文案里绝不带 key（§7.3）。
5. **能力状态三态，不画假开关**：`deepseek_web_search` / `deepseek_read_url` 是「已接入」
   （chat pipeline 语义透传，无配置项）；Search / Fetch / OCR / ASR / TTS 五个独立端点
   codec 写好了但**网关未装配**，只能标「未接入」并写清缺什么（§8）。

### 0.2 与 90-admin-ui-redesign.md 的关系

**补充，不推翻。** 90 的视觉基座（`--ag-*` 令牌、卡片 / 画布分层、Semi 覆盖值）、IA
（四组侧栏 + 概览落地）、路由（九条老路由一字不改）、图表规范、组件边界（不自建组件库）
全部继续有效。本文只改三处，都写在正文里：

| # | 90 的结论 | 本文的动作 | 冲突时以哪篇为准 |
| --- | --- | --- | --- |
| 1 | 90 §4.2 排版层级：正文 13px、卡片标题 14/600、页面标题 20/650、卡内边距 18px | 整体上调一档（本文 §9.2 给具体刻度） | **以本文为准**（90 是 v1.0-draft，本文是它的修订提案；落地时 90 的表格要同步更新，见 §12.2） |
| 2 | 90 §7.2 自封装组件清单 | 新增 `ProviderPanelModal` 与字段渲染器一组（本文 §10.1） | 以本文为准（同一文件的组件表追加，不改写旧行） |
| 3 | 90 §4.5 空状态「标题 + 一句系统状态 + 一条行动路」 | 收紧为「一句话 + 主操作按钮」（本文 §9.4） | 以本文为准（NN/g 的 direct pathway 保留，删的是第二、三句解释） |

其余一切（含 90 §1.7 已实现的「筛选状态入 URL」、90 §5 图表规范、90 §4.4 颜色双编码）不变。

### 0.3 本文不做什么

- **不做模型重定向 / 模型映射的渠道级配置**。那是 NewAPI 的 `model_mapping`（渠道内
  「请求名 → 上游名」重命名）；我们的对应物是全局的「别名映射」页（exact / prefix /
  passthrough 三级，见 `webui/admin/src/pages/Aliases.tsx`、`admin/aliases.ts` 与
  `webui/admin/src/pages/Help.tsx` 的「别名映射」小节）。渠道面板只提供「去别名页建规则」的跳转，
  不第二份映射表——两个映射表必然漂移。**这一点与 NewAPI  deliberately 不同，是需要
  仓库主人拍板的决策点之一（§12.3 D3）。**
- **不做优先级 / 权重 / 分组 / tag / 批量操作**。我们的路由由别名表驱动
  （`composition-root.ts` 的 `defaultRouteTable()` 没有权重概念），照搬 NewAPI 的
  priority/weight 等于发明一个不参与路由的旋钮。批量启用 / 停用列后端清单（§10.3）。
- **不改后端路由、不改 `docs/design/` 已有文档**。本文是设计提案；需要后端配合的
  事项单列在 §10.3，需要改旧文档的事项单列在 §12.2，都走 PR。

---

## 1. 调研：New-API / one-api 的渠道配置体验

一手来源：`QuantumNous/new-api` main 分支（v1.0.0-rc.51 之后，2026-11 拉取，
React 19 + Rsbuild + Tailwind 4 + shadcn/@base-ui），源码克隆在本机临时工作区；
one-api（`songquanpeng/one-api`，React 18 + Semantic UI React）作为旧形态参照。
**看源码，不看截图**——仓库主人截图看到的是 new-api 旧版（Semi Design），
当前 main 已经迁栈（90 §1.1 已记录这个栈变化）。

### 1.1 表单形态：侧抽屉 + 四 Tab + 分区 + 完成度指示

`web/src/features/channels/components/drawers/channel-mutate-drawer.tsx`（5,469 行）+
`drawers/channel-configuration.tsx`（194 行）：

- **新建先进「provider picker」全屏选择**（`drawers/channel-provider-picker.tsx`，452 行）：
  cmdk 式搜索 + all / builtin / custom / gateway / plugin 过滤 Tab，每个 provider 带
  徽标（badge）、描述、扩展插件摘要；选中后才进表单。**编辑模式直接进表单，
  provider 不可改**（换 provider = 新建）。
- **四个 Tab**：`Connection & Models`（连接与模型）/ `Routing & Mapping`（路由与映射）/
  `Request & Response`（请求与响应）/ `Other Settings`。每个 Tab 有**完成度图标**
  （Incomplete / Ready / Configured / Error，`ChannelConfigurationStatusIndicator`）
  与**计数徽标**（如映射条数）。
- **分区（section）有图标 + 标题 + 一句描述**：Basic Information（名称、provider 类型、
  可用性）、Authentication、Credentials、Models & Groups、Advanced Settings
  （可折叠，默认收起，`channel-advanced-section.tsx`）。
- Connection Tab 是**双列网格**：左列连接字段，右列模型 + 快捷选项
  （`channel-quick-options.tsx`：Pass Through Body / Pass Through Request Headers /
  Auto-disable channel / Detect model updates / Responses WebSocket，每个带一句描述；
  开透传前弹确认对话框说明后果）。
- 敏感操作有二次验证（`SecureVerificationDialog`）；key 字段有显隐切换
  （`hooks/use-channel-key-disclosure.ts`）。

**我们要抄的**：provider 先选后配、分区带图标标题、完成度指示、高级区默认收起。
**我们不抄的**：5,469 行单文件抽屉（`dialogs/param-override-editor-dialog.tsx` 一个文件
3,338 行）——「什么都塞进一个抽屉」正是仓库主人说的「乱七八糟」；我们的面板按
provider 拆散，每家一个小而完整的面板。

### 1.2 模型列表的三种来路

`components/dialogs/fetch-models-dialog.tsx`（263 行）+
`components/upstream-model-selection.tsx`（424 行）+
`hooks/use-channel-model-discovery.ts`（84 行）+ 后端 `controller/channel.go` 的
`FetchModels`（`POST /api/channel/fetch_models`）：

1. **拉上游 `/models`（主路径）**。两种模式：
   - **预览模式**：表单里直接传 `{base_url, type, key}`，**渠道还没保存就能拉**
     （`fetchModels`，后端用请求里的 key 拼一个临时 channel）；
   - **已存模式**：传 `channel_id`，用库里存的 key 拉（`fetchUpstreamModels`）。
   打开对话框**自动拉一次**；loading 是居中 spinner；失败 toast + 空态里放重试按钮。
   拉回来是**纯 model id 数组**，UI 侧：搜索框、按厂商名分类的折叠组（每组全选 checkbox
   与 `n / m` 计数）、逐项 checkbox、「Select all matching models」，底部是
   `n model(s) selected`；`showChanges` 模式下分 **New / Existing / Removed** 三个 Tab
   呈现与已保存列表的差异，Removed 组有一句说明「这些模型上游没返回，取消勾选即移除」。
   保存写回 `channel.models`（**逗号分隔字符串**）。
2. **预填常用模型**：`handleFillRelatedModels` 按渠道类型一键填入 `basicModels`
   （「Filled N related model(s)」toast）。
3. **手填**：models 文本域。

另有**上游模型更新检测**（quick option「Detect model updates」→
`upstream_model_update_check_enabled`，`dialogs/upstream-update-dialog.tsx` 展示上游
新增 / 下线，可自动同步）。

**关键差距（我们要超过它的点）**：new-api 的拉取**只拿 id 列表**，上下文窗口、模态、
effort、行为约束全部丢弃。DeepSeek 的 `GET /models` 把这些作为一等公民返回
（`providers/deepseek/discovery.ts` 的 `DeepSeekModelMetadata`：`context_window` /
`max_output_tokens` / `input_modalities` / `output_modalities` / `effort` /
`api_capabilities.anthropic_messages`），后端已有解码器（`decodeModelsResponse`）与
矩阵刷新逻辑（`DeepSeekModelDiscovery.refresh`）。**把这份元数据带进 UI**就是差异。

### 1.3 测试连通性

`components/dialogs/channel-test-dialog.tsx`（1,432 行）：

- **行内直接测**：表格行一个 Gauge 图标按钮 → `handleTestChannel` 打一次，toast 反馈；
  卡片布局另有 PlugZap 图标打开完整对话框。
- **完整对话框按模型逐行测**：可多选 / 全选模型；每行状态徽章
  `Not tested / Testing... / Success / Failed`；成功显示**响应耗时**；
  失败显示**摘要 + 「Details」按钮**打开侧面板看完整错误（可复制）；
  失败若是「模型未定价」，摘要旁直接给「Go to Settings」按钮跳到定价页；
  有批量进度 toast（total / completed / success / failed，**可中断**）；
  有「Delete failed models」批量删除失败模型。
- 表格列记录 `response_time` 与 `test_time`（列表里显示「上次测试」）。

**我们的现状完全不同**：`admin/service.ts` 的 `probeCredential` **不发起上游请求**，
只解析凭据头并返回 `status: 'unknown'` + 「未发起真实上游探测（避免在用量统计里留噪声）」，
而 `Channels.tsx` / `ChannelFormModal.tsx` 把它渲染成「失败（unknown）」或
「测试连通性…」——**文案不诚实**（§3.3）。设计结论见 §7.1：连通性证明由
「获取模型」的真实上游调用承担，探测按钮要么改名「检查凭据」，要么去掉。

### 1.4 模型重定向（`model_mapping`）

`components/model-mapping-editor.tsx`（555 行）+
`components/model-redirect-panel.tsx`（111 行）+
`components/model-mapping-batch-dialog.tsx`：

- 数据形态是 JSON：`{"客户端看到的模型名":"上游真实模型名"}`。
- **双模编辑器**：visual（表格行：from / to + 删除）+ JSON 代码编辑器（带解析错误提示），
  可切换；重复源模型检测并高亮；行数超过 6 行才显示行过滤框。
- **浮动工作台**（`FloatingWindow`）：挂在抽屉内、浮在页面上，位置与宽度存
  localStorage（`storageKey='channel-model-redirects'`），标题带条数徽标。
- **从上游模型列表一键发起**：拉回来的模型行尾一个 ArrowRightLeft 按钮 →
  `requestMappingDraft(model, '')` 打开一行草稿（只填了上游名，请求名空着待填），
  草稿两边都填了才写进映射。
- **批量添加**（`ModelMappingBatchDialog`）：一次填多组。
- **syncModels 开关**（工作台 footer）：「Publish the request names and remove the raw
  upstream names from the model list」——把请求名发布出去、从模型列表里删掉上游原名。
- **redirectOnly 标注**：只出现在映射里、还没加进 models 列表的模型，在模型选择器里
  有 Info 图标 + tooltip「From model redirect, not yet added to models list」。

对应我们的「别名映射」页（全局 model id → (provider, access_path, model) 路由，
三级优先级）。如 §0.3 所述，渠道面板**不做**第二份映射表，只做跳转。

### 1.5 分组 / tag / 渠道复制 / 批量 / 优先级与权重

- **tag**：列表页一个「tag 模式」开关（`localStorage['enable-tag-mode']`），开启后按
  tag 分组展示；`EditTagDialog`（改名 / 删除，显示该 tag 下渠道数与模型并集）；
  `TagBatchEditDialog` 批量打 tag；表格 Tag 列。
- **渠道复制**：`CopyChannelDialog`——新名字后缀（默认 `_copy`）+「是否重置余额与已用量」。
- **批量**：批量启用 / 停用 / 删除 / 设 tag（`data-table-bulk-actions.tsx`，选中行才出现
  操作条）；主按钮区还有「测试所有渠道」「更新所有余额」「修复能力一致性」
  （`handleFixAbilities`）「删除所有禁用渠道」。
- **优先级与权重**：表格行拖拽手柄改优先级（**键盘可达**：方向键移动、Esc 取消，
  拖不动时给原因 tooltip：排序中 / tag 分组中 / 无权限 / 保存中）+ 排序控件
  （priority / weight / …）+ `ChannelPriorityGuide` 引导。
- **多 key**：一个渠道多把 key（`MultiKeyManageDialog`，带统计卡片）。
- **多节点同步指示**：`NodeSyncIndicator`（channels topic）。

我们能复用的只有「渠道复制」（= 用同一份预设再建一条 provider 配置，纯前端可做）。
优先级 / 权重 / tag / 批量列为 §0.3 的非目标。

### 1.6 新建与编辑：同一表单 + 快捷操作

新建与编辑**同一个** `ChannelMutateDrawer`（`isCreating` 分支）：创建时先走 provider
picker，编辑时直接进表单。差异只在：创建时要填 key、编辑时 key 区不显示明文
（多 key 渠道走管理对话框）。快捷操作集中在行内 ⋮ 菜单与主按钮区（§1.5）。

**给我们的启示**：新建 / 编辑共用同一套面板框架（我们的编辑模式同样不碰 key，
这是已有硬规则），面板形态不因模式分叉。

### 1.7 优劣清单（「超过 NewAPI」的具体含义）

**做得好的（抄）**：

| # | 模式 | 出处 |
| --- | --- | --- |
| 1 | 先选 provider 再配表单；编辑时 provider 锁定 | `channel-provider-picker.tsx` |
| 2 | Tab 完成度指示 + 计数徽标 | `channel-configuration.tsx` |
| 3 | 模型拉取的 New / Existing / Removed 差异视图 | `upstream-model-selection.tsx` |
| 4 | 未保存也能拉模型（预览模式，key 走请求体） | `controller/channel.go` `FetchModels` |
| 5 | 探测按模型逐行 + 失败详情可复制 + 批量可中断 | `channel-test-dialog.tsx` |
| 6 | 高级区默认折叠、摘要可见 | `channel-advanced-section.tsx` |
| 7 | 拖拽优先级键盘可达、不可拖时说明原因 | `channel-priority-controls.tsx` |

**做得差的（不抄，这就是差异化空间）**：

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | 单文件巨型抽屉：5,469 行；一个参数覆盖编辑器 3,338 行 | `channel-mutate-drawer.tsx` / `param-override-editor-dialog.tsx` |
| 2 | 模型拉取只回 id，元数据（窗口 / 模态 / 约束）全丢 | `fetch-models-dialog.tsx` 的 `string[]` |
| 3 | 渠道级「模型重定向」与全局别名两套语义并存，必然漂移 | `model_mapping` vs 路由表 |
| 4 | key 在表单里反复编辑、明文可见 | `use-channel-key-disclosure.ts`（我们的规则更强：只在创建时出现一次） |
| 5 | 探测对话框 1,432 行只干「按模型测试」一件事 | `channel-test-dialog.tsx` |
| 6 | 高级渠道（advanced custom）一个编辑器 1,849 行 | `advanced-custom-editor-dialog.tsx` |

---

## 2. 横评：OpenRouter / Cloudflare AI Gateway / LiteLLM

### 2.1 OpenRouter

一手来源：<https://openrouter.ai/docs/guides/routing/provider-selection>（Provider Routing）、
<https://openrouter.ai/docs/guides/features/activity>（Activity / Logs，90 §1.2 已引）。

- 它的「provider 配置」是**请求级**的：每个请求带 `provider: { sort, allow_fallbacks,
  require_parameters, data_collection_policy, ... }`，决定这次调用挑哪家上游、
  按价格 / 吞吐 / 延迟排序、允许不允许回退。**没有管理面的「渠道表单」。**
- 密钥是账号级 provisioning key（带限额、可撤销），不是渠道级凭据。

**启示**：路由偏好属于请求参数，不属于渠道配置——这佐证了 §0.3 不抄 priority/weight
的决定；也说明「渠道」在我们这里的正确抽象就是「一条上游接入路径 + 一把 key」，
不需要 NewAPI 那样的路由旋钮。

### 2.2 Cloudflare AI Gateway（BYOK + Custom Providers）

一手来源：<https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/>、
<https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/>。

- **BYOK「Provider Keys」面板**：`Add API Key` → **从下拉选 provider** → 填 key →
  可选描述 → Save。之后请求不带 provider 授权头，网关自动替换。支持
  **一个 provider 多把 key + 别名**（`default` / `production` / `testing`，
  请求头 `cf-aig-byok-alias` 选择）；面板可看每把 key 的状态
  （active / expired / invalid）与最后使用时间；**轮换 = 就地替换**。
- **Custom Providers**：极简四字段——`name` / `slug` / `base_url`（必须 https）/
  `enable`，可选 `description` / `link`（文档链接）/ `curl_example` / `js_example`。
  自动生成占位 logo。

**启示**：(a) 「选 provider → 填 key → 保存」就是最小主流程，我们的预设面板应对齐这条；
(b) **自定义 provider 只有四个字段**——这就是「只有 Custom 才配乱七八糟」的边界参照；
(c) key 别名与状态面板值得我们的小 credential 系统借鉴（轻量：`note` + health 已有）。

### 2.3 LiteLLM Admin UI

一手来源：<https://docs.litellm.ai/docs/proxy/ui>、<https://docs.litellm.ai/docs/proxy/model_management>。

- **LLM Credentials（可复用命名凭据）**：`Add Credential` → 选 provider → 填 key →
  命名保存。**字段随 provider 变**：选 Vertex AI 给的是 `Vertex Project` /
  `Vertex Location` / `Vertex Credentials`，不是单一 key 框。之后 Add Model 时从
  `Existing Credentials` 下拉选，不必重复贴 key；还能把已配好模型的凭据「Re-use」
  成命名凭据。
- **模型详情页**：Overview（设置与 provider 摘要）+ Raw JSON（完整存储定义）；
  **Test Connection**（用已存凭据重新验证）+ Delete Model。
- **来源可见性**：db 来的模型带 database 徽标、`config.yaml` 来的带 config 徽标，
  **config 模型在 UI 里不可编辑**（文件所有制）。
- `GET /model/info` 返回时 key 掩码；凭据加密存储。

**启示**：(a) **「字段随 provider 变」是数据驱动面板的最强实证**——LiteLLM 用
provider 特定的表单字段做到了，我们用一个 `ProviderPanelSpec` 也能做到；
(b) 命名凭据复用 = DeepSeek 两条 access path 共用一把 key 的对应物；
(c) 来源徽标（db / config）对应我们的「模型来源三层」（静态表 / 上游发现 / 离线目录）。

### 2.4 横向结论

| 维度 | NewAPI | OpenRouter | Cloudflare | LiteLLM | 我们的选择 |
| --- | --- | --- | --- | --- | --- |
| 主流程 | 抽屉 + 四 Tab + 全量字段 | 无管理面渠道 | 选 provider → 填 key → 保存 | 命名凭据 + 模型 | **选 provider → 专属面板 → 填 key → 获取模型 → 保存** |
| 模型列表 | 拉 id + 手填 + 预填 | 平台侧维护 | 平台侧维护 | 平台侧价格表 + 手填 | **拉 `/models` 全量元数据 + 预设预填；禁手打（有自动获取时）** |
| 自定义 provider | advanced custom（1,849 行编辑器） | — | 四字段 | 通用 `litellm_params` | **Custom 四字段起家 + 高级折叠区** |
| key 管理 | 表单内可编辑 | 账号级 provisioning | BYOK 面板 + 别名 | 命名凭据复用 | **创建时一次提交；两条 access path 复用同一把 key** |
| 连通性 | 按模型逐行测 | — | 平台侧 | Test Connection | **「获取模型」的真实上游调用即连通性证明** |
| 路由偏好 | priority / weight（渠道级） | provider routing（请求级） | 动态路由（beta） | router settings | **不做渠道级路由旋钮（别名表驱动）** |

---

## 3. 现状走查与问题清单

### 3.1 现状：一个 447 行的通用表单

`webui/admin/src/components/ChannelFormModal.tsx`（447 行）：Select 分组选预设 →
自动带出 `base_url` / `dialect` / `default_models` → 名称 / base URL / dialect /
**默认模型 textarea（手填）** / access_path（仅 Custom）/ API Key / 启用 + 备注 →
保存或「测试连通性」。两条 access path 用**下拉单选**，切到另一条会丢掉第一条的模型；
key 只给选中的 access path 录一条凭据。

### 3.2 五条评价逐条对应

| # | 仓库主人的评价 | 现状根因 | 本文的设计响应 |
| --- | --- | --- | --- |
| 1 | 文字无重点，很多讲解文字完全没必要 | 弹窗里散落整段说明（key 说明一句话、文档一行、探测结果一整段） | §9.1 文案纪律 + §9.5 逐处前后对照 |
| 2 | 排版小气，间距 / 字号 / 行高都偏小 | 13px 正文、18px 卡内边距、16px 间距、标题层级差只有 6px | §9.2 刻度一档上调 + §9.3 标题层级拉大 |
| 3 | 「provider 这里还是需要我自己输入一个个 id」 | 默认模型是手填 textarea，预设 `default_models` 只是预填 | §7 自动获取模型（拉全量元数据，禁止手打） |
| 4 | 「deepseek 全家桶服务呢？」 | 配置界面里完全没有服务端工具与独立端点的踪影 | §8 全家桶能力区（三态呈现，不画假开关） |
| 5 | 「每个 provider 都是自己的配置界面……只有 Custom 才配乱七八糟的」 | 一个通用表单服务所有 provider | §5 面板框架 + §6 各面板 IA 与分界线 |

### 3.3 两个必须写进设计的后端现状

1. **连通性探测是桩**。`admin/service.ts` 的 `probeCredential` 只做
   `credentialResolver.headersFor()` 解析，不发起上游请求，固定返回
   `status: 'unknown'` 与「未发起真实上游探测（避免在用量统计里留噪声）」；
   而前端把它显示成「失败（unknown）」或「测试连通性…」。**这是文案不诚实，
   不是功能缺失的掩饰就能过去的。** 设计处置：连通性由「获取模型」的真实上游调用
   证明；探测入口改名「检查凭据可解析」并原样透出后端文案（§7.1、§10.3）。
2. **全家桶五个独立端点未装配**。`providers/deepseek/{search,fetch,ocr,asr,tts}.ts`
   是 standalone wire codec + 薄客户端，**不实现 Adaptor 接口、不进
   `adaptors/registry.ts`、不走 S0–S10、没有网关路由、composition-root 不装配**
   （文件头原话：「这不是 chat pipeline 的一部分」）。所以 UI 只能标「未接入」，
   并且要写清缺什么（§8.1 有逐条查证表）。

---

## 4. 设计目标与原则

1. **选 provider → 出专属面板**：面板形态由数据描述，不由 if-else 堆叠。
2. **禁止手打 model id**（对有自动获取的 provider）：拉取失败给可操作错误，不许静默
   退化成手填还不说。
3. **能力状态诚实**：三态（已接入 / 未接入 / 计划中），只读展示区，不画假开关。
4. **操作页文案接近零**：只留字段标签、placeholder、tooltip、一句状态、主操作按钮；
   解释全部进「帮助」页新增小节。
5. **排版放大一档**：间距 / 字号 / 行高 / 卡内边距全部上调，标题层级差拉大（§9.2）。
6. **数据驱动**：新 provider = 加一条预设数据（§5.3）。
7. **安全不弱化**：provider key 只在创建时提交一次、不明文回显；`secret_ref` 不存值；
   未登录 401；会话令牌只在内存（§10.4 清单）。
8. **守 90 的边界**：不自建组件库，Semi 零件 + `--ag-*` 令牌；零新增依赖。

---

## 5. Provider 面板框架（数据驱动）

### 5.1 一份「面板描述」的数据形状

每个 provider 一份 `ProviderPanelSpec`（类型草案，实现时按仓库 TS 风格收紧）：

```ts
/** 一个 provider 的专属面板描述（纯数据，无运行时依赖）。 */
export interface ProviderPanelSpec {
  preset_id: string;
  /** 面板标题，缺省用预设的 name。 */
  title?: string;
  /** 面板顶部一句状态（可选），例如「两条接入端点，共用同一个 key」。 */
  summary?: string;
  sections: PanelSection[];
}

export type PanelSection =
  /** 接入端点区：一把 key（可选）+ 每条 access path 的启用开关。 */
  | { kind: 'access'; title: string; key?: KeyFieldSpec; paths: AccessPathItem[] }
  /** 普通字段区（文本 / 开关 / 下拉 / 只读 / 备注）。 */
  | { kind: 'fields'; title: string; items: FieldItem[] }
  /** 模型区：自动获取 + 结果表；supported=false 时退化为预填/手填。 */
  | { kind: 'models'; title: string; discovery: ModelDiscovery }
  /** 能力状态区（只读，三态呈现）。 */
  | { kind: 'capabilities'; title: string; items: CapabilityItem[] }
  /** 文档外链区。 */
  | { kind: 'docs'; title: string; links: DocLink[] };

/** 接入区的 key 字段（创建模式才渲染输入框；编辑模式渲染只读行）。 */
export interface KeyFieldSpec {
  label: string;
  placeholder: string;
  /** label 旁的 tooltip（上限两行）。 */
  tip?: string;
}

export type FieldItem =
  | { kind: 'switch'; id: string; label: string; tip?: string; default?: boolean }
  | { kind: 'text'; id: string; label: string; placeholder?: string; advanced?: boolean }
  | { kind: 'select'; id: string; label: string; options: string[]; advanced?: boolean }
  | { kind: 'readonly'; id: string; label: string; value: string; mono?: boolean }
  | { kind: 'note'; id: string; label: string; placeholder: string };

export interface ModelDiscovery {
  supported: boolean;
  /** 不支持时的一句话原因（展示给用户，不是内部错误）。 */
  reason?: string;
  /** 上游 /models 的请求方法（默认 GET）。 */
  method?: 'GET' | 'POST';
  /** 上游路径，缺省按 dialect 映射（openai.chat→/models，gemini→/v1beta/models）。 */
  path?: string;
}

export interface CapabilityItem {
  name: string;
  /** 三态：已接入 / 未接入 / 计划中。 */
  status: 'implemented' | 'missing' | 'planned';
  /** 一句话说明（实现了什么 / 缺什么）。 */
  detail: string;
  /** 只读展示，不给交互控件。 */
  interactive: false;
}

export interface AccessPathItem {
  id: string;
  label: string;
  dialect: Dialect;
  base_url: string;
  /** 端点路径提示（如「POST /chat/completions（无 /v1）」）。 */
  path_hint?: string;
  default_enabled: boolean;
}

export interface DocLink {
  label: string;
  href: string;
}
```

要点：**闭集联合（closed union）**。新增一种字段种类 = 显式新增一个渲染器 +
改一处类型，编译器会逼着把所有 provider 的面板数据过一遍；而新增一个 provider
只是加一条数据。这就是「数据驱动」与「if-else 堆叠」的分界线：分支发生在
**字段种类**上（一小组、稳定、可测试），不发生在 **provider 身份**上（几十家、
常变、不可枚举）。

### 5.2 渲染层：字段种类渲染器，不是 if-else 堆叠

- `panels/render.tsx`：按 `section.kind` 分发到五个区组件（AccessSection /
  FieldsSection / ModelsSection / CapabilitiesSection / DocsSection）。
- `panels/fields/`：每个 `FieldItem.kind` 一个小组件（SwitchField / TextField /
  SelectField / ReadonlyField / NoteField），加接入区共用的 KeyField，全部吃 `--ag-*` 令牌。
- **面板状态 → 保存载荷**的映射集中在 `panels/serialize.ts`（一个纯函数，可单测）：
  面板 state → `ProviderUpsertRequest` + N 条 `CredentialCreateRequest`
  （create 模式；每个启用的 access path 一条，同一个 key）。
- **编辑模式**：面板照常渲染，key 区不渲染输入框，改为一只有状态标签的只读行
  「已录入 · 去凭据页管理」——与「key 只在创建时出现一次」的硬规则一致
  （`ChannelFormModal.tsx` 编辑模式本来就不碰 key，这里只是把话说清楚）。

### 5.3 数据放哪：预设注册表，还是前端

**推荐：扩展 `providers/presets.ts`，经现有 `GET /admin/api/provider-presets` 透出。**
理由沿用该文件头已经论证过的三条：(a) 单一事实来源——预设与 `providers/deepseek/`
的定价表、`holidays.json` 同属 provider 参考数据，放一起改；(b) 可热修——base_url /
版本路径纠偏只重启网关，不重打前端包；(c) 前端 bundle 精简。
代价：UI 迭代要跟着网关重启。备选是 `webui/admin/src/panels.ts`（前端独立迭代，
但与预设漂移的风险由人肉保证）。**这是需要拍板的决策点（§12.3 D1）。**

### 5.4 面板描述与 ProviderConfig 的映射（保存时序）

| 面板元素 | 落点 | 备注 |
| --- | --- | --- |
| 名称 / 备注 / 启用 | `ProviderConfig.label` / `note` / `enabled` | 与现状一致 |
| access path 开关 | 决定保存几条凭据 + `base_url` 取启用中的第一条 | 关掉的 path 不建凭据 |
| 模型区 | `ProviderConfig.model_source` | 静态快照 vs 自动同步见 §7.6 |
| 能力区 | **不落库** | 只读展示，后端状态的事实来源在 `providers/deepseek/` |
| key | `POST /credentials` 的 `secret`（仅 create） | 只此一次；服务端不回显 |

---

## 6. 各 Provider 面板的信息架构

### 6.1 公共骨架（所有面板一致的三段）

1. **头部**：ProviderBadge + 名称 + 置信度 tag（official / community / **[待验证]**）+
   文档链接（图标按钮，tooltip 给全名）。
2. **主体**：按 `spec.sections` 顺序渲染分区；每个分区一个 SectionHeader
   （16px/650 标题 + 可选一句 13px 次级说明——**上限一句**）。
3. **底部**：备注输入（placeholder「备注（可选，勿写密钥）」）+ 启用开关 +
   取消 / 保存。创建模式底部上方一条 `ag-banner-info`：「完整 key 只在本次提交出现，
   服务端不回显。」（这是 §9.5 里唯一保留的一句安全提示，因为它影响用户行为预期。）

### 6.2 DeepSeek 面板（完整规格）

**分区 A · 接入**（`kind: 'access'`）

- key 输入框（label「API Key」，placeholder `sk-…`，label 旁 tooltip：
  「两个接入端点共用同一个 key；仅本次提交，服务端不回显。」）。
- 两条 access path 卡片，各一个启用 Switch（默认全开）：
  - `deepseek.openai-chat` · `openai.chat` · `POST /chat/completions`（**没有 /v1 前缀**）
  - `deepseek.anthropic-messages` · `anthropic.messages` · `POST /anthropic/v1/messages`
- 一行 13px 次级说明（**全分区唯一一句**）：「同一个 key 两条路都用；端点路径由
  DeepSeek profile 固定，不需要手填。」

**分区 B · 模型**（`kind: 'models'`，`discovery.supported = true`）

- 标题行右侧主按钮「获取模型」；旁边一句状态（idle / 拉取中 / 成功于 <时间> / 失败摘要）。
- 拉回后渲染模型表：模型 id（等宽）/ 上下文窗口 / 模态 tags（text · image）/
  effort 档位（low · high · max，默认 high）/ 上游声明约束
  （`api_capabilities.anthropic_messages`：`system_prompt_update` / `tool_update`）。
- 默认全选；顶部搜索框；底部「已选 n 个」。
- 编辑模式：新增 / 已有 / 上游已移除 三组呈现（学 new-api §1.2 第 1 条）。

**分区 C · 能力**（`kind: 'capabilities'`，只读）

| 能力 | 状态 | 展示 |
| --- | --- | --- |
| `deepseek_web_search`（联网搜索） | 已接入 | success tag + 「chat 请求语义透传；无配置项，由客户端 `tools[]` 声明触发」 |
| `deepseek_read_url`（读链接正文） | 已接入 | 同上（canonical 名 `url_context`） |
| Search `/v1/tools/search` | 未接入 | neutral tag + 「codec 已就绪；缺网关路由、装配与计量」 |
| Fetch `/v1/tools/fetch` | 未接入 | 同上 |
| OCR `/v1/tools/ocr` | 未接入 | 同上 |
| ASR `/v1/tools/asr` | 未接入 | 同上 |
| TTS `/v1/tools/tts` | 未接入 | 同上 |

**分区 D · 文档与备注**（`kind: 'docs'` + note 字段）：api-docs.deepseek.com
（首页 / Chat Completions / Messages / web_tools / pricing 五个链接）+ 备注输入。

**DeepSeek 面板明确不做**：渠道级「默认注入 web_search」开关。后端没有这个配置面——
`BuiltinTool` 是请求级 canonical 概念，且 `profile.ts` 的 `builtinToolAcceptsConfig()`
返回 `false`（官方文档：`allowed_domains` 等配置字段一律 400）。画了这个开关就是
假功能（§8.3）。

### 6.3 其余预设：轻量面板

OpenAI / Anthropic / Gemini / Moonshot / 智谱 / 通义共用同一轻量模板：

- **接入区**：key + 预设的 access path（OpenAI 两条、其余一条）各一个启用开关，
  `base_url` 只读展示（预设带出，Custom 才可改）。
- **模型区**：「获取模型」按钮。路径按 dialect 映射：`openai.chat` →
  `{base}/models`；`gemini.generateContent` → `{base}/v1beta/models`（后端映射，
  见 §7.2）。拉回来的元数据普遍缺失（只有 id）→ 退化为 id 列表 + 一句
  「上游未返回上下文 / 模态等元数据」。`needs_verification` 的预设（Gemini /
  Moonshot / 智谱 / 通义）面板头部挂 warning tag「[待验证]」+ 一句
  「base_url 版本路径以官方文档为准」。
- **能力区**：无登记项 → 不渲染分区（**不放「暂无能力」这种占位空话**）。
- **文档与备注**：同 DeepSeek 模板。

### 6.4 Custom：完整表单（明确标注「高级」）

- 顶部 `ag-banner-warning`：「高级配置：预设里没有你的 provider 时才用这个。」
- 字段：名称、base_url（可编辑）、dialect 下拉、access_path、模型（**手填 textarea，
  外加一个「尝试获取模型」按钮**——给一次自动机会，失败就手填，按钮旁说明原因）。
- **高级折叠区**（默认收起，展开才可见）：`capability_overrides`
  （`unsupported_fields` / `constraints.system_prompt_update` / `constraints.tool_update` /
  `streaming_mode`）、凭据来源切换（直接填 key / `env_ref` 引用环境变量）。
- 这就是「乱七八糟」的家——全部关在折叠区里，默认视野只剩四个必填项。

### 6.5 分界线表

| 元素 | DeepSeek | 其余预设（轻量） | Custom |
| --- | --- | --- | --- |
| 名称 / 备注 / 启用 | ✅ | ✅ | ✅ |
| key（创建时一次） | ✅ 两路共用 | ✅ | ✅（或 env_ref） |
| access path 开关 | ✅ 两条 | ✅ 一至两条 | 手填 access_path |
| base_url | 只读（预设） | 只读（预设） | **可编辑** |
| dialect | 只读（随 path） | 只读（随 path） | 下拉可选 |
| 获取模型 | ✅ 全量元数据 | ✅ id 列表为主 | 可选尝试 |
| 手填模型 | ❌ 禁止 | ❌ 禁止（拉取失败时给可操作错误，不静默退化成手填） | ✅ |
| 能力状态区 | ✅ 七项 | ❌ 无登记 | ❌ |
| 高级项 | ❌ | ❌ | ✅ 折叠区 |
| 置信度 tag | official | community / unverified 带 [待验证] | — |

---

## 7. 自动获取模型

### 7.1 触发方式与按钮位置

- **显式按钮「获取模型」**，放在模型分区标题行右侧（主按钮样式）。
  **不做失焦自动触发**：key 输到一半每次失焦都打一次上游，401 噪音 + 无谓的上游
  配额消耗；显式按钮的调用成本可预期，失败也是用户主动看的结果。
- 创建模式：key 非空才可点（空 key 时按钮 disabled + tooltip「先填 API Key」）。
  编辑模式：用已存凭据拉（后端 `provider_id` 模式，§7.2）。
- loading：按钮内 spinner + 模型分区骨架；**请求在飞时绝不显示「没有模型」**
  （90 §4.5 的既有规则）。
- **连通性即拉取**：拉取成功 = key 有效 + 上游可达 + 模型清单到手，一次调用三证明。
  原「测试连通性」按钮的处理见 §3.3 与 §10.3。

### 7.2 后端契约（新端点，需后端配合）

```text
POST /admin/api/provider-models
请求：{ base_url: string; dialect: Dialect; path?: string;
        key?: string;            // 预览模式：创建中的渠道，key 只在内存里用于本次调用
        provider_id?: string }   // 已存模式：用库里的凭据
响应 200：{ ok: true; source: 'upstream'; fetched_at: number;
            models: UpstreamModel[] }
响应 4xx/5xx：统一错误信封 { error: { code, message } }
```

`UpstreamModel` 直接复用 `providers/deepseek/discovery.ts` 的
`DeepSeekModelMetadata` 形状（`id` / `name` / `context_window` /
`max_output_tokens` / `input_modalities` / `output_modalities` / `effort` /
`api_capabilities`，**全部可选**——非 DeepSeek 的上游通常只回 `id`，缺的字段前端
显示「—」而不是猜）。

安全约束（与现有 `POST /credentials` 同级的信任边界）：key 不落库、不进日志、
不进错误信息；上游错误响应体先剥离 key 再回前端；401 会话行为不变
（`webui/admin/src/api/client.ts` 的三条约定不动）。路径映射（`/models` vs
`/v1beta/models`）在后端按 dialect 做，前端不猜。

### 7.3 失败分类与可操作提示

| 上游返回 | 前端展示（一句话） | 可执行动作 |
| --- | --- | --- |
| 401 / 403 | 「key 无效或没有该端点的权限」 | 按钮「检查 key」聚焦到 key 输入框；链接去 provider 控制台 |
| 404 | 「这个 base_url 不支持 /models」 | 按钮「改用手填」（Custom）／「查看文档」核对端点 |
| 429 | 「上游限流了，稍等再试」 | 按钮「重试」（带 5s 冷却） |
| 超时 / 网络错误 | 「网关到上游不通」 | 核对 base_url 与网关出网；按钮「重试」 |
| 5xx | 「上游故障」 | 按钮「重试」；链接去 provider 状态页 |
| 200 但不是合法 JSON | 「上游返回的不是合法 JSON」 | 「查看文档」；按钮「改用手填」 |

硬规则：**任何错误文案都不含 key、不含完整响应体**；响应体细节进「详情」展开
（可复制），与 new-api 的失败详情面板同思路（§1.3）。

### 7.4 拉回结果怎么展示

- **表格**（不是标签云）：模型 id（等宽）/ 上下文窗口（`1M` 紧凑格式）/
  模态（text / image tags）/ effort 档位 / 上游约束（`system_prompt_update=…`、
  `tool_update=…`，仅 Anthropic 方言有声明——OpenAI 兼容面没有对应声明，
  **显示「未声明」而不是编一个**）。
- 行默认全选；搜索框过滤；底部「已选 n 个 · 拉取于 HH:mm」。
- 编辑模式三组：**新增**（上游有、库里没有）/ **已有** / **上游已移除**
  （学 new-api 的 New / Existing / Removed，§1.2）。
- 元数据缺失的 provider 退化为 id 列表 + 一句「上游未返回元数据」。

### 7.5 与手动模式的关系

- 预设的 `default_models` 变成**预填建议 chips**（「用预设清单填入」一键填入），
  不再是打开弹窗就塞进 textarea 的默认值。
- 获取成功 → 用拉回结果覆盖建议；获取失败 → **保留建议 chips 与明确的失败原因**，
  不静默退回手填（Custom 除外，Custom 本来就能手填）。
- 「禁止手打 model id」适用于**有自动获取能力的预设**；判据是
  `ModelDiscovery.supported`，不是硬编码的 provider 名单。

### 7.6 保存后：静态快照 vs 自动同步

- **默认：静态快照**。拉回的 id 列表存为
  `model_source: { kind: 'static', models: [...] }`，面板显示「拉取于 <时间>」。
  理由：确定性——上游下架模型不该让一个已存渠道的路由行为悄悄变掉。
- **可选：自动同步**。高级折叠区一个开关「保存时从上游刷新模型列表」→
  `model_source: { kind: 'discovery', path: '/models' }`。后端已有先例
  （`DeepSeekModelDiscovery` + `POST /admin/api/sync` 的上游发现），
  不需要新机制，只是把触发点从「全局同步」细化到「这个渠道」。
- **这是需要拍板的决策点（§12.3 D2）**：默认快照最稳，但主人如果希望「上游加了模型
  就自动出现」，默认值应反过来。

---

## 8. 全家桶能力区

### 8.1 后端现状清单（逐条查证，2026-11-14）

| 能力 | 代码位置 | 装配状态 | UI 判定 |
| --- | --- | --- | --- |
| `deepseek_web_search` | `providers/deepseek/profile.ts` 的 `builtinToolWire` / `builtinToolCanonicalName`（映射到 canonical `web_search`） | chat pipeline 语义透传，契约测试覆盖（`docs/design/50-builtin-search.md` §3.1 模式 A） | **已接入** |
| `deepseek_read_url` | 同上（canonical `url_context`） | 同上 | **已接入** |
| Search `POST /v1/tools/search` | `providers/deepseek/search.ts`（wire codec + `DeepSeekSearchClient`） | 无路由、无 composition-root 装配、非 Adaptor 实现 | **未接入** |
| Fetch `POST /v1/tools/fetch` | `providers/deepseek/fetch.ts` | 同上 | **未接入** |
| OCR `POST /v1/tools/ocr` | `providers/deepseek/ocr.ts` | 同上 | **未接入** |
| ASR `POST /v1/tools/asr` | `providers/deepseek/asr.ts` | 同上 | **未接入** |
| TTS `POST /v1/tools/tts` | `providers/deepseek/tts.ts` | 同上 | **未接入** |
| 余额查询 / 对账 | `providers/deepseek/balance.ts` + `POST /admin/api/balance/probe` | 只读探测已接（`admin/service.ts` `probeBalance`） | 已接入（不放渠道面板，放用量页） |

两个服务端工具**没有任何配置项**（官方文档原话：`allowed_domains` /
`blocked_domains` / `user_location` 一律 400；`tool_choice` 点名这两个工具同样 400），
`profile.ts` 的 `builtinToolAcceptsConfig()` 返回 `false` 就是这条事实的代码化。

### 8.2 三态呈现规则

| 状态 | 视觉 | 文案 |
| --- | --- | --- |
| 已接入 | success tag「已接入」 | 一句语义（实现了什么、怎么触发） |
| 未接入 | neutral tag「未接入」 | 一句缺什么（缺网关路由 / 装配 / 计量中的哪几项） |
| 计划中 | warning tag「计划中」 | 一句范围 + 指向待办 |

规则：能力区是**只读展示区**（`CapabilityItem.interactive: false` 写进类型），
不放任何 Switch / Checkbox；每条带 tooltip 展开细节；整体放在面板最后一个分区，
标题「能力状态」。

### 8.3 明确不画开关的部分（不许假装已接入）

1. **「默认注入 web_search / read_url」开关**：后端没有渠道级配置面。注入与否由
   客户端在 `tools[]` 里声明（请求级），网关只做方言映射。画这个开关 = 假功能。
2. **五个独立端点的「启用」开关**：没有网关路由就没有「启用」可言。标「未接入」+
   写清缺口，是对用户负责的做法。
3. **如果主人要真开关**：需要后端同步实现，范围 = 5 个路由（或一个通用
   `/v1/tools/*` 转发面）+ composition-root 装配 + 计量口径（按次 / 按页 / 按小时 /
   按字符，各家不同）+ 契约测试。**这要单列 issue，不在本 UI 改动范围内**
   （§12.3 D5 是是否立项的决策点）。

---

## 9. 文案纪律与排版刻度

### 9.1 文案规则（硬要求）

1. **操作页（渠道页 + 各 provider 面板）只允许四种文字**：字段标签、placeholder、
   tooltip、一句状态（含错误摘要）。整段讲解一律删除。
2. **解释性内容统一进「帮助」页**新增「渠道与 Provider」小节
   （`#/help?section=channels`，需在 `router.ts` 的 `HELP_SECTIONS` 与 `Help.tsx`
   各加一节——实现项，这里只定契约）。页面里最多一句 + 「了解更多」链接。
3. **空状态 = 一句话 + 主操作按钮**，不许第二、三句。
4. **tooltip 上限两行**；放不下的进帮助页。
5. **错误信息必须可操作**：说清发生了什么 + 下一步点什么（§7.3 是范本）。
6. **状态文案诚实**：桩功能就说它是桩（§3.3），不用「测试」「连通」这种没发生的词。
7. **key 相关只保留一句安全提示**（§6.1 底部那条），其余删除——它影响用户预期，
   属于「必要」而非「讲解」。

### 9.2 排版刻度（一档上调）

现状值取自 `webui/admin/src/styles/theme.css` 与 `90-admin-ui-redesign.md` §4.1–§4.2：

| 令牌 / 用途 | 现状 | 新刻度 | 理由 |
| --- | --- | --- | --- |
| 基础正文 / 表格字号 | 13px | **14px** | 13px 在管理面偏小；14px 是 Linear / Vercel 的正文档 |
| 次级说明 | 12px | **13px** | 与正文差一档，不再「大小几乎一样」 |
| 卡片标题 | 14px / 600 | **15px / 650** | 与正文拉开 |
| 面板分区标题（新增） | — | **16px / 650** | 区块层级，见 §9.3 |
| 页面标题 | 20px / 650 | **24px / 700** | 与卡片标题差 9px，层级一眼可辨 |
| 统计卡大字 | 26px / 650 | **28px / 700** | 同步放大 |
| 表单字段标签 | 12px / 500 | **13px / 600** | 标签上置、加重 |
| 卡内边距 `--ag-pad-card` | 18px | **24px** | 「大气」的主要来源 |
| 卡间距 `--ag-gap` | 16px | **20px** | 同步 |
| 页面 padding | 20px 24px 48px | **24px 28px 56px** | 同步 |
| 表格行高（新增 `--ag-row-h`） | Semi 默认 ~44px | **56px** | 表格透气的关键 |
| 输入框 / 按钮高度 | Semi 默认 32px | **36px** | 与 14px 字号配套 |
| 正文行高 | 1.6 | **1.7** | 中文长行不断句 |
| 弹窗宽度 | 560px | **720px**（DeepSeek 面板 760px） | 模型表要五列 |
| 空状态 padding | 36px 20px | **48px 24px** | 同步 |
| tag 内边距 | 2px 8px | **3px 10px** | 与更大字号配套 |

### 9.3 标题层级（差拉大）

| 层级 | 新刻度 | 用在哪 |
| --- | --- | --- |
| L1 页面标题 | 24px / 700 | `.ag-page-title` |
| L2 面板 / 分区标题 | 16px / 650 | 面板分区标题、卡片标题统一到这一档 |
| L3 卡片 / 字段组标题 | 15px / 650 | 卡片标题、字段标签行 |
| L4 正文 | 14px / 400 | 表格、输入、正文 |
| L5 次级 | 13px / 400 `--ag-text-2` | 一句状态、tooltip、空状态 hint |
| L6 等宽标识 | 14px `--ag-font-mono` | model id / access_path / base_url |

相邻层级差 ≥ 1px 且字重至少差一档；**不再出现「14/600 与 13/400 并列」这种
几乎分不出的组合**（90 §4.2 表现状里就有）。

### 9.4 空状态

`EmptyState` 收敛为：**标题一句话（15px/650）+ 主操作按钮**。hint 只在
「为什么空」影响用户判断时保留一句（13px，`--ag-text-2`），且不带句号收尾的长篇。
请求在飞时不显示空状态（90 §4.5 既有规则不变）。

### 9.5 逐处文案前后对照

| 位置 | 改前 | 改后 | 去向 |
| --- | --- | --- | --- |
| 渠道页 desc | 「渠道决定请求打到哪个上游，保存后即生效。每个渠道配一条或多条凭据，测试时按 access_path 打一次上游探测。」 | 「管理上游接入与模型清单。」 | 帮助页「渠道与 Provider」 |
| 渠道页空状态 | 标题 + 「渠道是『请求打到哪个上游』的唯一配置点。点右上角『新建渠道』，从预设里选一个 provider 最快。」 | 「还没有渠道」+ 按钮「新建渠道」 | 删除（按钮自解释） |
| 渠道页 meta 行 | 「共 N 条，启用 M 条」+「三层模型来源说明」链接 | 「共 N 条 · 启用 M 条」+「了解更多」 | 保留一句 |
| 弹窗 Provider 区 | 「搜索并选择一个已知 Provider」+ 文档整行 URL + 「[待验证] 请以官方文档为准」 | 下拉（placeholder「选择 Provider」）+ 头部文档图标按钮（tooltip 全名）+ 置信度 tag | URL 进 tooltip |
| access path 区 | 「接入端点（access path）」下拉，标签带 dialect | 分区「接入」+ 每条 path 一张卡片（label · dialect · 端点路径提示 · 启用开关） | dialect 进卡片副行 |
| 默认模型区 | 「默认模型（每行一个 model id）」+ textarea + placeholder 示例 | 「模型」+「获取模型」按钮 + 模型表 + 预填建议 chips | 删除手填说明 |
| key 区 | 「完整 key 只在这一次提交里出现，提交后立即加密入库，服务端不回显、不写日志。」 | label tooltip「两个端点共用同一个 key；仅本次提交，服务端不回显」+ 底部一条安全提示 | 一句进 tooltip、一句留底部 |
| 探测结果 | 「连通 · 耗时 N ms · 上游 HTTP …」整段 Banner | 删除探测按钮；「获取模型」成功即证明连通（§3.3） | — |
| Custom 区 | 「自定义 Provider」混在预设下拉里 | Custom 独立入口 + 顶部「高级配置」Banner + 高级折叠区 | — |
| 帮助页 | 无渠道小节 | 新增「渠道与 Provider」：面板框架、获取模型、能力三态、Custom 边界 | 各页「了解更多」指到这里 |

---

## 10. 组件与实现边界

### 10.1 新增组件（前端）

| 文件 | 职责 |
| --- | --- |
| `src/panels/spec.ts` | `ProviderPanelSpec` 等类型 + 从 `ProviderPreset` 取面板描述的纯函数 |
| `src/panels/serialize.ts` | 面板 state → `ProviderUpsertRequest` + `CredentialCreateRequest[]`（纯函数，可单测） |
| `src/panels/render.tsx` | 按 `section.kind` 分发 |
| `src/panels/fields.tsx` | KeyField / SwitchField / TextField / SelectField / ReadonlyField / NoteField |
| `src/panels/ModelsSection.tsx` | 获取模型按钮 + 状态 + 结果表 + 分组 |
| `src/panels/CapabilitiesSection.tsx` | 三态只读能力区 |
| `src/components/ProviderPanelModal.tsx` | 弹窗外壳（替代 `ChannelFormModal.tsx` 的主体） |
| `src/api/provider-models.ts` | `POST /provider-models` 封装 + 失败分类纯函数（可单测） |

### 10.2 复用与不改的

- **Semi**：Modal / Select / Switch / Input / TextArea / Table / Toast / Banner / Tag /
  Tooltip / Button（继续用 props + 令牌改外观，90 §4.6 的边界不动）。
- **自有业务组件**：`PageHeader` / `EmptyState` / `StatusTag` / `ProviderBadge`
  （`src/components/ui.tsx`），新增 SectionHeader 一个小组件。
- **不改**：路由（九条 + overview）、`src/api/client.ts` 的三条安全约定、
  `src/auth.tsx`、`src/theme.tsx`、图表模块。

### 10.3 后端配合清单（不在本 UI 改动内，需主人分派）

| # | 事项 | 范围 | 优先级 |
| --- | --- | --- | --- |
| 1 | `POST /admin/api/provider-models`（§7.2 契约） | `admin/routes.ts` + `admin/service.ts` + `admin/api-types.ts` + 测试 | **P0**（没有它就没有自动获取） |
| 2 | 探测文案诚实化 | `admin/service.ts` 的 `probeCredential` 返回原因说明；前端去掉「测试连通性」措辞或改名为「检查凭据」 | P0（一句话的诚实） |
| 3 | `providers/presets.ts` 增加 `panel?: ProviderPanelSpec` 字段（若 §12.3 D1 选后端方案） | `providers/presets.ts` + `admin/routes.ts` 透出（已透传整个对象，无需改路由） | P0 |
| 4 | 帮助页「渠道与 Provider」小节 | `webui/admin/src/router.ts` + `Help.tsx` | P1（纯前端） |
| 5 | 全家桶五端点接入（§8.3） | 5 路由 + 装配 + 计量 + 契约测试 | P2（单列 issue） |
| 6 | 批量启用 / 停用端点（可选） | `admin/routes.ts` + service | P2 |

### 10.4 安全约束（不弱化清单）

1. provider key 只在创建时提交一次；编辑模式不渲染输入框；服务端不明文回显
   （`MaskedCredential` 只有掩码与前 8 位）。
2. `secret_ref` / `env_ref` 不存值，只存引用名。
3. 未登录 401 行为不变；会话令牌只在内存（`client.ts` 的三条约定）。
4. `POST /provider-models` 的 key 不落库、不进日志、不进错误信息。
5. `secretTripwire` 不绕开：新端点的响应照样过守卫。
6. 隐私扫描：commit 前 `privacy-scan --staged --fail-on any`，不绕 hook。

---

## 11. 分阶段落地

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P0** | 面板框架（§5）+ DeepSeek 面板（§6.2）+ 获取模型前后端（§7）+ 后端事项 1–3 | 主人拍板 §12.3 的 D1 / D2 |
| **P1** | 轻量面板（§6.3）+ Custom 表单（§6.4）+ 文案排版全量（§9）+ 帮助页小节 | P0 |
| **P2** | 能力区扩展与三态数据化（§8）+ 渠道复制 + 批量启用 / 停用 | P1 + 后端事项 5–6 |

每阶段验收都跑 `npm test` / `npm run typecheck` / `npm run lint` /
`npm run build:admin`，零新增依赖，`tests/ui-contract.test.ts` 追加断言
（老路由一字不改、面板数据驱动、禁止手打 model id 的规则在源码里可断言）。

---

## 12. 验证与待决事项

### 12.1 验收标准

- 新建渠道流程变成：选 provider → 专属面板 → 填 key → 点「获取模型」自动带出模型 →
  保存；Custom 才有完整表单。
- DeepSeek 面板能看到：两条 access path 开关、共用 key 说明、模型元数据表、
  全家桶七项能力三态、文档与备注。
- 全站说明文字显著减少（§9.5 对照表逐项生效）、排版按 §9.2 刻度上调。
- 四个 npm 脚本全绿；`tests/ui-contract.test.ts` 新增对应断言；零新增依赖；
  commit 前 `privacy-scan --staged --fail-on any` 通过。

### 12.2 待文档更新清单（走 PR，不在本文改动内）

| 文档 | 需要补什么 |
| --- | --- |
| `90-admin-ui-redesign.md` §4.1 / §4.2 | 排版刻度与组件表按 §9.2 / §10.1 更新（本文是修订提案） |
| `90-admin-ui-redesign.md` §3.2 | 渠道页 desc 与空状态改版后的 IA 表附注 |
| `00-overview.md` §4.2 | 若 `providers/presets.ts` 增加 panel 字段，模块表补一句 |
| `12-coverage-survey.md` | 全家桶五端点的「codec 就绪 / 网关未接入」状态列 |
| `50-builtin-search.md` §3.1 | 能力区三态呈现与「不画渠道级开关」的约定 |
| `45-credentials.md` §3.2 | access path 元数据若加 `path_hint`，同步契约 |

### 12.3 待仓库主人拍板的决策点

| # | 决策点 | 选项 |
| --- | --- | --- |
| **D1** | 面板描述数据放哪 | (a) `providers/presets.ts` + 预设端点（推荐：单一事实来源、可热修，UI 迭代要重启网关）；(b) `webui/admin/src/panels.ts`（前端独立迭代，与预设漂移风险人肉保证） |
| **D2** | 模型清单默认语义 | (a) 静态快照（推荐：上游下架不影响已存渠道）；(b) 默认自动同步（上游加模型即出现，需后端发现链路常开） |
| **D3** | 渠道面板要不要做模型重定向 | (a) 不做，跳别名页（推荐：避免两套映射漂移）；(b) 做渠道内重命名（学 new-api `model_mapping`） |
| **D4** | 「获取模型」触发方式 | (a) 仅显式按钮（推荐）；(b) 按钮 + 失焦自动（key 输完即拉，代价是每次失焦一次上游调用） |
| **D5** | 全家桶五端点是否立项接入 | (a) 本期只标「未接入」（推荐：UI 不造假）；(b) 后端同步实现路由 + 装配 + 计量后做成真开关（范围见 §8.3） |
| **D6** | 老「测试连通性」按钮去留 | (a) 删除，由「获取模型」证明连通（推荐）；(b) 改名「检查凭据」保留（只做本地解析，文案照实说） |
| **D7** | DeepSeek 面板宽度 | (a) 760px 宽弹窗（推荐：模型表五列）；(b) 与其余面板一致 720px |

---

## 附：调研来源索引

- New-API（QuantumNous/new-api，main，2026-11 拉取的源码克隆）：
  `web/src/features/channels/components/drawers/channel-mutate-drawer.tsx`、
  `drawers/channel-configuration.tsx`、`drawers/channel-provider-picker.tsx`、
  `dialogs/fetch-models-dialog.tsx`、`dialogs/channel-test-dialog.tsx`、
  `dialogs/copy-channel-dialog.tsx`、`components/upstream-model-selection.tsx`、
  `components/model-mapping-editor.tsx`、`components/model-redirect-panel.tsx`、
  `components/channel-quick-options.tsx`、`hooks/use-channel-model-discovery.ts`；
  后端 `controller/channel.go`（`FetchModels`）、`model/channel.go`。
- one-api（songquanpeng/one-api）：旧形态参照（Semantic UI React + recharts）。
- OpenRouter：<https://openrouter.ai/docs/guides/routing/provider-selection>。
- Cloudflare AI Gateway：
  <https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/>、
  <https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/>。
- LiteLLM：<https://docs.litellm.ai/docs/proxy/ui>、
  <https://docs.litellm.ai/docs/proxy/model_management>。
- 本仓库：`webui/admin/src/components/ChannelFormModal.tsx`、
  `webui/admin/src/pages/Channels.tsx`、`webui/admin/src/styles/theme.css`、
  `providers/presets.ts`、`providers/deepseek/{profile,discovery,search,fetch,ocr,asr,tts,balance}.ts`、
  `admin/routes.ts`、`admin/service.ts`、`composition-root.ts`。
