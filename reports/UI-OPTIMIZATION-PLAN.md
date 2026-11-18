# Google AI Studio 风格 UI 优化实施计划（基于 Material 3 AI Design System）

本项目旨在全面对标 **Google AI Studio**（Playground）的视觉设计语言、三栏骨架（Scaffold）、Material 3 Tonal Surface 层次与微交互体系，彻底解决现有界面的粗糙与割裂感，打造高质感、现代化的 AI 开发者体验。

---

## 视觉与系统调研结论（Google AI Studio & Material 3）

通过对 Google AI Studio、Gemini Playground 及 Material 3（M3 / Material You）开发规范的深度调研，结合用户提供的实际运行截图，核心设计规律如下：

### 1. 三栏响应式架构（Scaffold & Multi-Pane Layout）
* **Left Navigation Rail（左侧导航条）**：
  - 区别于传统侧边栏，采用紧凑、通透的 Navigation Rail 模式。
  - 分组标题：全大写微字号高字距（`EXPLORE`、`BUILD`、`MANAGE`，11px，Tracking +0.05em，`#747775`）。
  - 选中态：M3 胶囊高亮（`border-radius: 999px`，底色 `surface-container` `#f0f4f9`，字体深色 `#1f1f1f`）。
  - 底部工具行：通知 Bell、设置 Gear、搜索 Magnifier、凭据 Key 四联圆形图标按钮，下方为单字彩色圆形头像与用户身份行。
* **Central Canvas（中央操练场）**：
  - 顶部导航条：简洁页面名 `Playground`，右侧快捷按钮组（Share 分享、Popout 外开/全屏、New `+` 新建会话、More `⋮` 更多菜单）。
  - 空状态 Split Hero：
    - 左列：大号粗体标题（`Build with <ModelName>`）+ 优雅副标题（`Cutting-edge intelligence...`）+ 4 条垂直排列的提示词卡片（微弱平滑悬浮）+ `Learn more ↗`（胶囊线框按钮）。
    - 右列：三张悬浮卡片叠层（Interactive Data Dashboard、Landing Page 等）+ 底层 Gemini 经典极淡多色微光。
  - 浮动底部输入卡（Floating Composer Bar）：
    - 悬浮圆角卡片（`border-radius: 24px`，表面纯白，`1px solid #dadce0` 发丝边，扩散阴影）。
    - 顶部自增高多行输入框，占位提示 `Start typing a prompt to see what our models can do`。
    - 底部工具条：左侧 `(+)` 附件按钮、`Key` 凭据快捷状态指示、`Tools` 工具选择药丸按钮；右侧麦克风图标、流式模式切换与 `Run Ctrl ↵` 胶囊提交按钮（Google Blue `#0b57d0`，圆角 999px）。
* **Right Side Sheet（右侧运行配置面板）**：
  - 顶部操作栏：`Run settings` 标题 + `<> Get code` 按钮（触发代码生成模态框）+ 重置 Reset 图标 + 关闭 Close `✕` 图标。
  - **Model Card**：独立大圆角卡片，大号模型标题（如 `Gemini 4 Hydrogen` / `DeepSeek V3`）+ 模型 ID 浅灰色标签 + 能力简介段落，点击弹出模型切换器。
  - **System instructions**：独立输入卡片，标题 + 占位提示 `Optional tone and style instructions for the model`，展开 CodeEditor 编辑。
  - **Thinking level**：严格还原图片 2 的 Thinking level 下拉卡片（`Low` / `Medium` / `High` / `Extra High`）及悬浮 Tooltip（`Set the thinking level`）。
  - **Tools 开关组**：折叠面板包含 Material 3 平滑滑动开关（Switch）。
  - **Advanced settings**：折叠面板收纳 Temperature、Max tokens 等参数滑块。

### 2. 色彩与表面层次（M3 Tonal Surfaces）
* **不依赖重投影，依托色调表面分层**：
  - 基底画布（Canvas）：`#ffffff` / `#f8fafd`
  - 浮动卡片（Surface）：`#ffffff`
  - 浅阶容器（Surface Container Low / Hover）：`#f0f4f9` / `#f8f9fa`
  - 高亮容器（Primary Container）：`#e8f0fe` / `#d3e3fd`
  - 发丝边框（Outline Variant）：`#dadce0` / `#e0e2ec`
  - 主强调色（Primary）：Google Blue `#0b57d0` / `#1a73e8`
* **排版字体阶梯**：
  - 优先调用 Google Sans / Roboto / Inter / system-ui，字号与行高完全匹配 M3 Type Scale。

---

## User Review Required

> [!IMPORTANT]
> **关于既有测试断言与约束的严格遵守**：
> 1. 本仓库有极严密的测试集（`tests/ui-contract.test.ts`、`webui/admin/src/pages/chat-contract.test.ts`、`scripts/check-ui-copy.mjs` 等）。
> 2. `chat.css` 不允许裸写 `linear-gradient` / `radial-gradient`，也不允许写裸毫秒数或未受控的裸 `px` 圆角。所有圆角和动效统一走 `--ag-*` 变量（如 `--ag-radius-card`、`--ag-duration-fast`）或合法标记 `999px`。
> 3. 文案纪律：用户可见中文单串 <= 12 字符，不出现内部术语（如 canonical、S0 等），必要例外保持 inline 注释 `// ui-copy: allow <理由>`。
> 4. 对话页密钥走 `/credentials`、不拼 `innerHTML`、输入框保持双层无重影防抖机制均完整保留。

---

## Open Questions

1. **工作区专业标签语言风格**：
   - 为极致还原 Google AI Studio 原汁原味的科技美感，并天然契合仓库文案字数纪律（中文单串 $\le$ 12 字符），主工作区与侧栏标题采用 AI Studio 经典英文标签（如 `Playground`、`Run settings`、`Get code`、`System instructions`、`Thinking level`、`Tools`）。
   - 用户确认：是否认同采用 AI Studio 的经典专业标签风格？

---

## Proposed Changes

### Component 1: 视觉基座与设计令牌 (`webui/admin/src/styles/theme.css`)

#### [MODIFY] `webui/admin/src/styles/theme.css`
- 将主色调切换为 Google 蓝：`--semi-color-primary: #0b57d0;`，`--ag-accent: #0b57d0;`。
- 引入 Material 3 表面与灰阶变量：
  - `--ag-canvas: #f8fafd;`（浅色底）
  - `--ag-surface-2: #f0f4f9;`（M3 surface-container）
  - `--ag-border: #dadce0;`
  - `--ag-border-strong: #c4c7c5;`
  - `--ag-text-1: #1f1f1f;`
  - `--ag-text-2: #444746;`
  - `--ag-text-3: #747775;`
  - `--ag-radius-composer: 24px;`
  - `--ag-radius-pill: 999px;`
- 保留所有 `tests/ui-contract.test.ts` 所断言的 elevation 档位（`--ag-elev-1` 到 `--ag-elev-4`）与动效令牌（`--ag-duration-*` / `--ag-ease-*`）。

---

### Component 2: 应用外壳与左侧导航 (`webui/admin/src/App.tsx`, `theme.css`)

#### [MODIFY] `webui/admin/src/App.tsx`
- 侧边栏重构为 Google AI Studio 经典 Navigation Rail 风格：
  - Brand Header：显示简洁大方的字标（Google AI Studio 风格无衬线字体）与汉堡/折叠按钮。
  - 分组呈现：小写大写追踪标题（`EXPLORE`、`BUILD`、`MANAGE`）。
  - 选中项高亮：圆角药丸背景（`border-radius: 999px`，浅色高亮），文字加粗。
  - 底部工具条：Bell、Settings、Search、Key 四个独立圆形图标按钮。
  - 底部用户信息行：单字圆圈头像 + 用户名 + 角色徽标。
- 保证 `NAV_GROUPS` 结构完全兼容 `tests/ui-contract.test.ts` 与 `tests/agent-ui-contract.test.ts` 的静态文本断言。

---

### Component 3: 对话操练场主页面 (`webui/admin/src/pages/Chat.tsx`, `chat.css`)

#### [MODIFY] `webui/admin/src/pages/Chat.tsx`
- **顶部操作栏重构**：
  - 左侧展示 `Playground` 标题。
  - 右侧提供 AI Studio 式功能按钮组：Share、Popout、New `+`、More `⋮`。
- **空状态重构为 AI Studio Split Hero**：
  - 左侧区域：大号标题（`Build with <ModelName>`）+ 优雅副标题 + 4 条推荐提示词卡片 + `Learn more ↗`（胶囊按钮）。
  - 右侧区域：仿照 AI Studio 设计的数据面板、模型路由及工具预览卡片组。
- **浮动输入栏（Composer Bar）**：
  - 采用悬浮大圆角卡片布局（`border-radius: 24px`）。
  - 占位符保持 `{COMPOSER_PLACEHOLDER}` 唯一出处防重影机制。
  - 底部工具条重构：`(+)` 附件按钮、`Key` 密钥快捷状态、`Tools` 药丸按钮、麦克风图标、流式切换与 `Run Ctrl ↵` 胶囊提交按钮（Google 蓝，`border-radius: 999px`）。

#### [MODIFY] `webui/admin/src/styles/chat.css`
- 严守 `chat-contract.test.ts` 约束（无裸毫秒数、无裸 px 圆角、无裸 gradient、box-shadow 不超标）。
- 消息气泡与代码块重构为 AI Studio 风格：
  - 用户气泡：右上圆角，`#f1f3f4` 浅灰，深色字体。
  - 助手气泡：纯白底，字号 15px，无边框或超细边框。
  - Markdown 代码块：圆角 12px，顶部工具条含语言标签与拷贝按钮。
  - 工具调用卡片：卡片式收拢，状态标签精致化。

---

### Component 4: 运行设置面板与代码生成器 (`webui/admin/src/pages/AgentRunPanel.tsx`)

#### [MODIFY] `webui/admin/src/pages/AgentRunPanel.tsx`
- **顶部标题与操作**：
  - 标题显示 `Run settings`。
  - 增加 `<> Get code` 按钮：点击弹窗提供当前配置下的 `curl`、`Python`、`Node.js` 代码调用示例。
  - 增加 Reset 恢复默认图标按钮与 Close 收起图标按钮。
- **模型卡片（Model Card）**：
  - 独立圆角卡片：模型显示名称加粗（15px）、模型 ID 灰色字（12px）、模型描述摘要。
  - 点击弹出模型切换列表，支持搜索与选择。
  - 保留所有契约断言：`match.effort.levels.join`、`默认 {match.effort.default}`、元数据项（上下文、最大输出、模态、约束）。
- **系统提示词卡片（System instructions）**：
  - 展示标题 `System instructions` 与预览/副标题 `Optional tone and style instructions for the model`，展开 CodeEditor 编辑。
- **思考等级选择器（Thinking level）**：
  - 完全按照用户给出的截屏 2 实现 Thinking level 下拉卡片。
  - 展开显示 `Low`、`Medium`、`High`、`Extra High` 选项，带选中高亮与 `Set the thinking level` 提示。
- **工具清单（Tools）**：
  - 头部折叠项显示 `Tools` 与开启数量。
  - 工具项列表：左右排布，左侧工具名与描述，右侧 Material 3 风格圆滑 Switch。
- **高级设置（Advanced settings）**：
  - 折叠项显示 `Advanced settings`，收纳 Temperature、Max tokens、Max turns、Stream 开关。

---

## Verification Plan

### Automated Tests
1. **全套单元与契约测试**：
   ```bash
   npm test
   ```
   验证所有 69 个测试文件 100% 绿灯。
2. **UI 文案纪律扫描**：
   ```bash
   npm run check:ui-copy
   ```
   验证所有界面中文文案无超长、无内部术语泄漏、未豁免疑似数为 0。
3. **前端 TypeScript 类型检查与 Vite 构建**：
   ```bash
   npm run build:admin
   ```
   验证编译零错误、零告警。

### Manual Verification
1. **视觉核对**：
   - 启动本地服务进行端到端视觉对比，确保左侧 Navigation Rail、中央 Playground Split Hero、浮动 Composer、右侧 Run settings（含 Get code 弹窗、Thinking level 展开）与 Google AI Studio 视觉一致。
2. **交互体验**：
   - 验证快捷提示词一键发送、Thinking level 平滑切换、Get code 一键复制代码、输入框多行自增高与按键响应。
