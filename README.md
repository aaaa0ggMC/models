# AgentGateway

**AgentGateway** 是一个开源的 **LLM API 网关**：客户端可以使用主流协议格式（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini `generateContent` 等）发起请求，由网关统一经过自研 **AG-IR canonical** 中间格式完成协议互转、路由调度、多密钥故障转移、插件拦截、异步计量计费，并配套完整的可视化管理面板。

> 仓库名沿用 `models`（历史原因），项目名是 **AgentGateway**。

## 核心能力

- **全链路 Canonical 互转（Always-Canonical）**：所有请求与响应均通过 `ir/` 定义的自研超集 Schema（AG-IR）进行无损编解码与 raw passthrough 保留，支持 OpenAI Chat / Responses、Anthropic Messages、Gemini `generateContent` 以及图像/音频/Embedding 等多模态端点。
- **显式 Pipeline（S0–S10）**：11 阶段请求生命周期，统一处理流式 SSE、多轮 Tool Call 循环与错误映射，不将厂商私有结构跨模块泄露。
- **多厂商 Provider 与模型目录**：内置 DeepSeek、小米 MiMo、OpenRouter、OpenCode Go、xAI Grok 等预设与官方定价表（`providers/`），支持自动同步 `models.dev` 元数据与能力矩阵（`catalog/`）。
- **多密钥故障转移与额度监控**：支持单 Provider 多凭据轮询/故障转移、冷却恢复、余额与订阅窗口查询（`credentials/`）。
- **插件系统与内置工具**：提供 5 个操作 canonical 数据的通用 hook（`onRequest` / `onResponse` / `onStreamChunk` / `onError` / `onToolCall`），支持内置工具与外部能力接入（`plugins/`）。
- **异步计量与加密存储**：旁路异步汇总 Token、音频时长、图像次数与费用并落入 SQLite（`metering/`、`storage/`），支持主密钥/数据密钥（KEK/DEK）信封加密与轮换。
- **安全与网关伪装（Stealth Mode）**：控制面与数据面认证完全隔离；支持在管理面开启「网关伪装」，未携带伪装请求头或 `?gate_key=` 密钥的数据面请求统一返回 `404 Not Found`，支持在线一键生成、复制与轮换伪装密钥。
- **管理面 WebUI**：内置基于 React + Vite 的管理后台（`webui/admin/`），涵盖总览、模型目录、路由引擎、渠道与凭据管理、客户端虚拟密钥、用量统计、安全与密钥、对话调试等页面。

## 目录结构

```text
models/
├── README.md                  # 本文件
├── AGENTS.md                  # 项目级协作与编码约束
├── CONTRIBUTING.md            # 提交与隐私扫描约定
├── CHANGELOG.md               # 变更记录
├── LICENSE                    # MIT 许可证
├── .env.example               # 环境变量样例
├── composition-root.ts        # 依赖注入与运行时组合根
├── ir/                        # AG-IR canonical 类型定义与 Schema
├── gateway-core/              # PipelineRunner、S0–S10 阶段与路由引擎
├── adaptors/                  # 客户端格式 <-> 上游 Provider 格式互转
├── providers/                 # 厂商预设、定价表与探测适配
├── catalog/                   # 模型目录与能力元数据同步
├── credentials/               # 上游凭据解析、多密钥故障转移与额度查询
├── auth/                      # 数据面 Virtual Key 与控制面认证
├── admin/                     # 管理面 HTTP API 路由与认证
├── http/                      # HTTP/SSE ingress、多模态/音频/模型端点与伪装门禁
├── metering/                  # 异步用量归一化与计费引擎
├── plugins/                   # 插件宿主与通用 hook 执行
├── storage/                   # SQLite 持久化、加密存储与审计日志
├── config/                    # 运行时设置定义与多层合并
├── di/                        # 轻量级 DI 容器与环境变量读取
├── webui/admin/               # 管理面前端（React + Vite + TypeScript）
├── deploy/                    # systemd 服务模板等部署配置
├── scripts/                   # 构建、文档校验、UI 文案检查与服务端入口
├── docs/
│   ├── design/                # 架构与详细设计文档
│   └── sources.md             # 外部调研来源与结论
├── reports/                   # 阶段性实现报告、审计记录与联调文档
└── tests/                     # 单元测试、契约测试与端到端测试
```

## 快速开始

### 1. 安装与构建

```bash
npm install
npm run build
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 按需填写上游 Provider API Key、AG_ADMIN_TOKEN 等环境变量
```

> 仓库内不保存任何真实密钥或线上配置，所有敏感信息均通过 `.env` 或系统环境变量注入。

### 3. 启动服务与测试

```bash
# 本地启动（构建后运行）
node dist/scripts/serve.mjs

# 端到端往返演示（HTTP ingress + mock 上游）
npm run demo

# 运行测试与校验
npm test                 # Vitest 全量测试
npm run typecheck        # TypeScript 严格类型检查
npm run lint             # ESLint 检查
npm run check:ui-copy    # 管理面 UI 文案规范检查
node scripts/check-docs.mjs  # docs/ 设计文档一致性检查
```

### 4. systemd 部署参考

参考 [deploy/agentgateway.service](deploy/agentgateway.service) 配置系统服务（注意按实际部署路径调整 `WorkingDirectory`、`EnvironmentFile` 与 `User`）。

## 相关文档

- 架构与详细设计：[`docs/design/`](docs/design/)
- 实现说明与模块职责：[`reports/IMPLEMENTATION.md`](reports/IMPLEMENTATION.md)
- 历史阶段报告与审计记录：[`reports/`](reports/)

## 许可

MIT，见 [LICENSE](LICENSE)。
