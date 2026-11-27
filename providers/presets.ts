/**
 * providers/presets.ts —— 已知 Provider 预设注册表（**纯数据，无任何运行时依赖**）。
 *
 * 用途：管理面「新建渠道」弹窗里的 ComboBox 数据源。选中一个预设就自动带出
 * base_url / dialect / 默认模型 / 官方文档链接 / key 格式提示，使用者只需再填
 * 一个 API Key——对标 NewAPI 的渠道创建体验。经只读端点
 * `GET /admin/api/provider-presets` 透出（见 admin/routes.ts），前端不 import 本文件、
 * 不在 bundle 里复制一份，保证「修正预设不用重新构建前端」。
 *
 * ## 为什么走端点而不是前端 import
 *
 * 1. **单一事实来源**：预设与 `providers/deepseek/` 的定价表、holidays.json 同属
 *    「provider 参考数据」，放一起改，不散两处。
 * 2. **可热修**：base_url / 版本路径纠偏只重启网关即可，不必重打前端包。
 * 3. **前端 bundle 精简**：不把参考数据塞进 JS。
 *
 * ## 置信度与 [待验证]
 *
 * 每条预设都标 `source`（官方文档 URL）与 `confidence`。**不编造 base_url**：
 * 拿不准版本路径 / 鉴权方式的标 `needs_verification: true`，UI 会显示 [待验证]。
 * DeepSeek 的两条 access path 与 base 已在仓库内实测（见
 * DEEPSEEK-INTEGRATION-REPORT.md 与 credentials/resolver.ts），故为 official。
 * MiMo 的 base 与 OpenAI 兼容形状同样在仓库内实测（2026-11-16，见
 * MIMO-INTEGRATION-REPORT.md 的探测记录），故亦为 official；但**音频端点的形状来自
 * 官方文档 + 逐条实测**，`/v1/models` 不给上下文窗口等元数据，预设里也就不写。
 */

import type {
  PresetDialect,
  ProviderAccessPathPreset,
  ProviderPreset,
} from '../admin/api-types.js';

export type { PresetDialect, ProviderAccessPathPreset, ProviderPreset };

/**
 * 预设注册表。
 *
 * `default_models` 只是**便利预填**（省得用户手打一串 model id），不是权威清单；
 * 权威清单由 `POST /admin/api/sync` 的上游发现 / 离线目录产生。
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: '国际',
    homepage: 'https://www.deepseek.com',
    docs: 'https://api-docs.deepseek.com/',
    key_hint: 'sk- 开头（两个 dialect 共用同一个 key）',
    key_prefix: 'sk-',
    // 两条 access path：OpenAI 兼容 + Anthropic 兼容，同 base、不同 dialect。
    // base 与路径已在仓库实测（credentials/resolver.ts、DEEPSEEK-INTEGRATION-REPORT.md）：
    //   openai-chat        → POST https://api.deepseek.com/chat/completions（无 /v1）
    //   anthropic-messages → POST https://api.deepseek.com/anthropic/v1/messages
    access_paths: [
      {
        id: 'deepseek.openai-chat',
        label: 'DeepSeek（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.deepseek.com',
        default_models: ['deepseek-flash', 'deepseek-v4-pro'],
      },
      {
        id: 'deepseek.anthropic-messages',
        label: 'DeepSeek（Anthropic 兼容）',
        dialect: 'anthropic.messages',
        base_url: 'https://api.deepseek.com/anthropic',
        default_models: ['deepseek-flash', 'deepseek-v4-pro'],
      },
    ],
    default_access_path: 'deepseek.openai-chat',
    source: 'https://api-docs.deepseek.com/',
    confidence: 'official',
    note: 'OpenAI 兼容端点路径没有 /v1；Anthropic 兼容走 /anthropic 前缀。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    group: '国际',
    homepage: 'https://openai.com',
    docs: 'https://platform.openai.com/docs/api-reference',
    key_hint: 'sk- 开头（project key 为 sk-proj-）',
    key_prefix: 'sk-',
    access_paths: [
      {
        id: 'openai',
        label: 'OpenAI（Chat Completions）',
        dialect: 'openai.chat',
        base_url: 'https://api.openai.com/v1',
        default_models: ['gpt-4o', 'gpt-4o-mini'],
      },
      {
        id: 'openai.responses',
        label: 'OpenAI（Responses）',
        dialect: 'openai.responses',
        base_url: 'https://api.openai.com/v1',
        default_models: ['gpt-4o', 'gpt-4.1'],
      },
    ],
    default_access_path: 'openai',
    source: 'https://platform.openai.com/docs/api-reference',
    confidence: 'official',
    note: '默认模型清单会随 OpenAI 发布漂移，以同步/文档为准。',
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    group: '国际',
    homepage: 'https://www.anthropic.com',
    docs: 'https://docs.anthropic.com/',
    key_hint: 'sk-ant- 开头',
    key_prefix: 'sk-ant-',
    access_paths: [
      {
        id: 'anthropic',
        label: 'Anthropic（Messages）',
        dialect: 'anthropic.messages',
        base_url: 'https://api.anthropic.com',
        default_models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
      },
    ],
    default_access_path: 'anthropic',
    source: 'https://docs.anthropic.com/',
    confidence: 'official',
    note: '模型 id 带日期后缀（如 claude-3-5-sonnet-20241022），也有 -latest 别名。',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: '国际',
    homepage: 'https://deepmind.google/technologies/gemini/',
    docs: 'https://ai.google.dev/gemini-api/docs',
    key_hint: 'AIza 开头（Google API Key）',
    key_prefix: 'AIza',
    access_paths: [
      {
        id: 'gemini.generateContent',
        label: 'Gemini（generateContent）',
        dialect: 'gemini.generateContent',
        base_url: 'https://generativelanguage.googleapis.com',
        default_models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
      },
      {
        id: 'gemini.openai-chat',
        label: 'Gemini（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
        default_models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
      },
    ],
    default_access_path: 'gemini.generateContent',
    source: 'https://ai.google.dev/gemini-api/docs',
    confidence: 'official',
    note: '默认走原生 /v1beta/models/{model}:generateContent（x-goog-api-key 鉴权），也提供 OpenAI 兼容接入路径（/v1beta/openai）。',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    group: '国内',
    homepage: 'https://www.moonshot.cn',
    docs: 'https://platform.moonshot.cn/docs',
    key_hint: 'sk- 开头',
    key_prefix: 'sk-',
    access_paths: [
      {
        id: 'moonshot.openai-chat',
        label: 'Moonshot（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.moonshot.cn/v1',
        default_models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      },
    ],
    default_access_path: 'moonshot.openai-chat',
    source: 'https://platform.moonshot.cn/docs',
    confidence: 'community',
    needs_verification: true,
    note: '[待验证] OpenAI 兼容端点；base 版本路径以官方文档为准。',
  },
  {
    id: 'zhipu',
    name: '智谱 (GLM)',
    group: '国内',
    homepage: 'https://open.bigmodel.cn',
    docs: 'https://open.bigmodel.cn/dev/api',
    key_hint: '无固定前缀（控制台创建的 API Key）',
    access_paths: [
      {
        id: 'zhipu.openai-chat',
        label: '智谱 GLM（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        default_models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
      },
    ],
    default_access_path: 'zhipu.openai-chat',
    source: 'https://open.bigmodel.cn/dev/api',
    confidence: 'community',
    needs_verification: true,
    note: '[待验证] OpenAI 兼容端点；/api/paas/v4 版本路径以官方文档为准。',
  },
  {
    id: 'mimo',
    name: '小米 MiMo Plan CN',
    group: '国内',
    homepage: 'https://mimo.mi.com',
    docs: 'https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit',
    key_hint: 'tp- 开头（小米开放平台 Token Plan 国内版 API Key）',
    key_prefix: 'tp-',
    access_paths: [
      {
        id: 'mimo.openai-chat',
        label: 'MiMo Plan CN（OpenAI 兼容）',
        dialect: 'openai.chat',
        // base **只到 host**：官方文档的请求地址是 https://<host>/v1/chat/completions，
        // 与 DeepSeek「无 /v1」正好相反——但 /v1 属于**端点路径**那一截
        // （providers/mimo/profile.ts 的 endpointPath 给 /v1/chat/completions）。
        // 不把 /v1 写进 base：transport 用 new URL(path, base_url) 拼地址，
        // base 带路径时会被绝对路径整段替换掉（见 credentials/resolver.ts 的同款注释）。
        base_url: 'https://token-plan-cn.xiaomimimo.com',
        default_models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
      },
    ],
    default_access_path: 'mimo.openai-chat',
    // 形状来源：官方文档两页（语音识别 / 语音合成）+ 仓库内实测
    // （MIMO-INTEGRATION-REPORT.md 的探测记录，2026-11-16）。
    source: 'https://mimo.mi.com/docs/zh-CN/api/audio/tts-post',
    confidence: 'official',
    note:
      'Token Plan 国内节点；OpenAI 兼容，端点路径带 /v1（与 DeepSeek 相反）。响应带 reasoning_content。' +
      'TTS / ASR 走同一 /v1/chat/completions 按模型分发（mimo-v2.5-tts* / mimo-v2.5-asr）。',
  },
  {
    id: 'mimo-plan-eu',
    name: '小米 MiMo Plan EU',
    group: '国际',
    homepage: 'https://mimo.mi.com',
    docs: 'https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit',
    key_hint: 'tp- 开头（小米开放平台 Token Plan 欧洲版 API Key）',
    key_prefix: 'tp-',
    access_paths: [
      {
        id: 'mimo-plan-eu.openai-chat',
        label: 'MiMo Plan EU（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://token-plan-eu.xiaomimimo.com',
        default_models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
      },
    ],
    default_access_path: 'mimo-plan-eu.openai-chat',
    source: 'https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit',
    confidence: 'community',
    needs_verification: true,
    note: '[待验证] Token Plan 欧洲节点；OpenAI 兼容，key 与国内版不互通。',
  },
  {
    id: 'mimo-api',
    name: '小米 MiMo API',
    group: '国内',
    homepage: 'https://mimo.mi.com',
    docs: 'https://mimo.mi.com/docs/zh-CN/api/chat/openai-api-post',
    key_hint: 'sk- 开头（小米开放平台标准按量付费 API Key）',
    key_prefix: 'sk-',
    access_paths: [
      {
        id: 'mimo-api.openai-chat',
        label: 'MiMo API（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.xiaomimimo.com',
        default_models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'],
      },
    ],
    default_access_path: 'mimo-api.openai-chat',
    source: 'https://mimo.mi.com/docs/zh-CN/api/chat/openai-api-post',
    confidence: 'official',
    note: '标准按量付费 API 节点；Token Plan 套餐请选小米 MiMo Plan CN / EU。',
  },
  {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    group: '国内',
    homepage: 'https://www.aliyun.com/product/dashscope',
    docs: 'https://help.aliyun.com/zh/dashscope/',
    key_hint: 'sk- 开头（DashScope API Key）',
    key_prefix: 'sk-',
    access_paths: [
      {
        id: 'qwen.openai-chat',
        label: '通义千问（OpenAI 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        default_models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
      },
    ],
    default_access_path: 'qwen.openai-chat',
    source: 'https://help.aliyun.com/zh/dashscope/',
    confidence: 'community',
    needs_verification: true,
    note: '[待验证] OpenAI 兼容端点（compatible-mode）；base 版本路径以官方文档为准。',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    group: '国际',
    homepage: 'https://opencode.ai',
    docs: 'https://opencode.ai/docs/go/',
    key_hint: 'oc_sk_ 开头（OpenCode Zen / Go API Key）',
    key_prefix: 'oc_sk_',
    access_paths: [
      {
        id: 'opencode-go.openai-chat',
        label: 'OpenCode Go（OpenAI Chat / Embeddings 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://opencode.ai/inference/go/openai/v1',
        default_models: [
          'deepseek-v4.1-flash',
          'glm-5.3',
          'kimi-k3.1-pro',
          'claude-haiku-5-5',
          'gemini-4-argon',
        ],
        transport_hints: { session_header: 'x-opencode-session' },
      },
      {
        id: 'opencode-go.openai-responses',
        label: 'OpenCode Go（OpenAI Responses）',
        dialect: 'openai.responses',
        base_url: 'https://opencode.ai/inference/go/openai/v1',
        default_models: ['gpt-6-luna', 'gpt-5.6-luna', 'grok-4.7'],
        transport_hints: { session_header: 'x-opencode-session' },
      },
      {
        id: 'opencode-go.anthropic-messages',
        label: 'OpenCode Go（Anthropic Messages）',
        dialect: 'anthropic.messages',
        base_url: 'https://opencode.ai/inference/go/anthropic/v1',
        default_models: ['claude-haiku-5-5', 'qwen4-max', 'qwen3.8-flash'],
        transport_hints: { session_header: 'x-opencode-session' },
      },
    ],
    default_access_path: 'opencode-go.openai-chat',
    source: 'https://opencode.ai/docs/go/',
    confidence: 'official',
    note: 'OpenCode Go 订阅网关；请求自动附带 x-opencode-session。OpenAI Chat 端点可统一路由全部模型，亦可按模型选 Responses / Anthropic。',
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT 订阅 (Codex OAuth)',
    group: '国际',
    homepage: 'https://chatgpt.com',
    docs: 'https://developers.openai.com/codex/cli/',
    key_hint: '请在凭据页使用「OAuth 订阅登录」（扫码或点击链接授权）',
    access_paths: [
      {
        id: 'openai-codex.openai-responses',
        label: 'ChatGPT 订阅（Codex Responses）',
        dialect: 'openai.responses',
        base_url: 'https://chatgpt.com/backend-api',
        default_models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-luna'],
        transport_hints: {
          endpoint_path: '/codex/responses',
          extra_headers: {
            'OpenAI-Beta': 'responses=experimental',
            originator: 'ag',
          },
        },
      },
    ],
    default_access_path: 'openai-codex.openai-responses',
    source: 'https://developers.openai.com/codex/cli/',
    confidence: 'official',
    note: '使用 ChatGPT Plus/Pro 订阅额度（无需 API Key）；在凭据页通过设备码 OAuth 扫码或点击链接登录并自动刷新 token。',
  },
  {
    id: 'xai',
    name: 'xAI Grok (SuperGrok / API)',
    group: '国际',
    homepage: 'https://x.ai',
    docs: 'https://docs.x.ai/',
    key_hint: 'xai- 开头（API Key）或在凭据页用 SuperGrok / X Premium+ OAuth 登录',
    key_prefix: 'xai-',
    access_paths: [
      {
        id: 'xai.openai-responses',
        label: 'xAI Grok（Responses / SuperGrok OAuth）',
        dialect: 'openai.responses',
        base_url: 'https://api.x.ai/v1',
        default_models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
      },
      {
        id: 'xai.openai-chat',
        label: 'xAI Grok（OpenAI Chat 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.x.ai/v1',
        default_models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3'],
      },
    ],
    default_access_path: 'xai.openai-responses',
    source: 'https://docs.x.ai/',
    confidence: 'official',
    note: '支持传统 API Key（xai-）以及 SuperGrok / X Premium+ 订阅的设备码 OAuth 登录（自动刷新）。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    group: '国际',
    homepage: 'https://openrouter.ai',
    docs: 'https://openrouter.ai/docs/quickstart',
    key_hint: 'sk-or-v1- 开头（或在凭据页点击 OpenRouter OAuth 授权获取）',
    key_prefix: 'sk-or-',
    access_paths: [
      {
        id: 'openrouter.openai-chat',
        label: 'OpenRouter（OpenAI Chat 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://openrouter.ai/api/v1',
        default_models: ['openai/gpt-4o', 'anthropic/claude-3.7-sonnet', 'deepseek/deepseek-chat-v3'],
      },
      {
        id: 'openrouter.openai-responses',
        label: 'OpenRouter（OpenAI Responses）',
        dialect: 'openai.responses',
        base_url: 'https://openrouter.ai/api/v1',
        default_models: ['openai/gpt-4o', 'openai/o3-mini'],
      },
      {
        id: 'openrouter.anthropic-messages',
        label: 'OpenRouter（Anthropic Messages）',
        dialect: 'anthropic.messages',
        base_url: 'https://openrouter.ai/api/v1',
        default_models: ['anthropic/claude-3.7-sonnet'],
      },
    ],
    default_access_path: 'openrouter.openai-chat',
    source: 'https://openrouter.ai/docs/quickstart',
    confidence: 'official',
    note: '聚合路由；支持手动填写 sk-or-v1- Key 或通过 OpenRouter OAuth PKCE 一键授权获取。',
  },
  {
    id: 'step',
    name: '阶跃星辰 (Step API)',
    group: '国内',
    homepage: 'https://platform.stepfun.com',
    docs: 'https://platform.stepfun.com/docs/overview/quickstart',
    key_hint: '阶跃星辰开放平台标准按量 API Key',
    access_paths: [
      {
        id: 'step.openai-chat',
        label: 'Step API（OpenAI Chat 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.stepfun.com/v1',
        default_models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash'],
      },
      {
        id: 'step.openai-responses',
        label: 'Step API（OpenAI Responses）',
        dialect: 'openai.responses',
        base_url: 'https://api.stepfun.com/v1',
        default_models: ['step-5-preview', 'step-3.7-flash'],
      },
      {
        id: 'step.anthropic-messages',
        label: 'Step API（Anthropic Messages 兼容）',
        dialect: 'anthropic.messages',
        base_url: 'https://api.stepfun.com',
        default_models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash'],
      },
    ],
    default_access_path: 'step.openai-chat',
    source: 'https://platform.stepfun.com/docs/overview/quickstart',
    confidence: 'official',
    note: '阶跃星辰标准按量 API（国内区）；国际区可改 base_url 为 https://api.stepfun.ai/v1，套餐请选 Step Plan。',
  },
  {
    id: 'step-plan-cn',
    name: '阶跃星辰 Step Plan CN',
    group: '国内',
    homepage: 'https://platform.stepfun.com',
    docs: 'https://platform.stepfun.com/docs/overview/quickstart',
    key_hint: '阶跃星辰 Step Plan 中国区 API Key',
    access_paths: [
      {
        id: 'step-plan-cn.openai-chat',
        label: 'Step Plan CN（OpenAI Chat 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.stepfun.com/step_plan/v1',
        default_models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash'],
      },
      {
        id: 'step-plan-cn.openai-responses',
        label: 'Step Plan CN（OpenAI Responses）',
        dialect: 'openai.responses',
        base_url: 'https://api.stepfun.com/step_plan/v1',
        default_models: ['step-5-preview', 'step-3.7-flash'],
      },
      {
        id: 'step-plan-cn.anthropic-messages',
        label: 'Step Plan CN（Anthropic Messages 兼容）',
        dialect: 'anthropic.messages',
        base_url: 'https://api.stepfun.com/step_plan',
        default_models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash'],
      },
    ],
    default_access_path: 'step-plan-cn.openai-chat',
    source: 'https://platform.stepfun.com/docs/overview/quickstart',
    confidence: 'official',
    note: 'Step Plan 中国区订阅套餐端点（/step_plan），支持 OpenAI 与 Anthropic 双协议。',
  },
  {
    id: 'step-plan-global',
    name: '阶跃星辰 Step Plan Global',
    group: '国际',
    homepage: 'https://platform.stepfun.ai',
    docs: 'https://platform.stepfun.ai/docs/en/step-plan/overview',
    key_hint: 'StepFun Global Step Plan API Key',
    access_paths: [
      {
        id: 'step-plan-global.openai-chat',
        label: 'Step Plan Global（OpenAI Chat 兼容）',
        dialect: 'openai.chat',
        base_url: 'https://api.stepfun.ai/step_plan/v1',
        default_models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash'],
      },
      {
        id: 'step-plan-global.openai-responses',
        label: 'Step Plan Global（OpenAI Responses）',
        dialect: 'openai.responses',
        base_url: 'https://api.stepfun.ai/step_plan/v1',
        default_models: ['step-5-preview', 'step-3.7-flash'],
      },
      {
        id: 'step-plan-global.anthropic-messages',
        label: 'Step Plan Global（Anthropic Messages 兼容）',
        dialect: 'anthropic.messages',
        base_url: 'https://api.stepfun.ai/step_plan',
        default_models: ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash'],
      },
    ],
    default_access_path: 'step-plan-global.openai-chat',
    source: 'https://platform.stepfun.ai/docs/en/step-plan/overview',
    confidence: 'official',
    note: 'Step Plan 国际区订阅套餐端点（api.stepfun.ai/step_plan），支持 OpenAI 与 Anthropic 双协议。',
  },
];

/** 取一个预设的默认 access path 预设。 */
export function defaultAccessPath(preset: ProviderPreset): ProviderAccessPathPreset {
  const id = preset.default_access_path ?? preset.access_paths[0]?.id;
  return preset.access_paths.find((p) => p.id === id) ?? preset.access_paths[0]!;
}
