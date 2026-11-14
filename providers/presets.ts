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
 */

/** wire 方言（与 admin/api-types.ts 的 ProviderConfig.dialect 同源）。 */
export type PresetDialect =
  'openai.chat' | 'anthropic.messages' | 'openai.responses' | 'gemini.generateContent';

/** 一条 access path 预设（一家 provider 可能有多个 dialect 端点）。 */
export interface ProviderAccessPathPreset {
  /** 建议的 access_path id（如 `deepseek.openai-chat`）；凭据据此寻址。 */
  id: string;
  /** 人类可读标签（如「DeepSeek（OpenAI 兼容）」）。 */
  label: string;
  /** 该端点的 wire 方言。 */
  dialect: PresetDialect;
  /** 上游 base URL（**不含路径**，路径由 codec / provider profile 给）。 */
  base_url: string;
  /** 该端点的默认/常用模型 id（仅作便利预填，权威清单来自同步）。 */
  default_models: string[];
}

/** 一个已知 Provider 的预设。 */
export interface ProviderPreset {
  /** 稳定 id（小写短横线），如 `deepseek`。 */
  id: string;
  /** 显示名，如 `DeepSeek`。 */
  name: string;
  /** 分组（ComboBox 分组标题用），如 `国际` / `国内`。 */
  group: string;
  /** 官网首页。 */
  homepage: string;
  /** API 文档页（外链，UI 直接可点）。 */
  docs: string;
  /** API Key 格式提示（同时用作输入框 placeholder 与校验说明）。 */
  key_hint: string;
  /** Key 常见前缀（用于轻量提示/校验）；不确定则留空。 */
  key_prefix?: string;
  /** 各 dialect 端点预设。 */
  access_paths: ProviderAccessPathPreset[];
  /** 默认选中的 access_path id（缺省 = access_paths[0]）。 */
  default_access_path?: string;
  /** 预设来源（官方文档 URL）。 */
  source: string;
  /** 置信度。 */
  confidence: 'official' | 'community' | 'unverified';
  /** 是否需要人工验证（UI 显示 [待验证]）。版本路径/鉴权易变的设为 true。 */
  needs_verification?: boolean;
  /** 额外备注（可含「OpenAI 兼容」这类关键说明）。 */
  note?: string;
}

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
        default_models: ['gemini-1.5-pro', 'gemini-2.0-flash'],
      },
    ],
    default_access_path: 'gemini.generateContent',
    source: 'https://ai.google.dev/gemini-api/docs',
    confidence: 'unverified',
    needs_verification: true,
    note: '[待验证] 原生端点版本路径（/v1beta）与鉴权（API key vs OAuth）以官方文档为准。',
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
];

/** 取一个预设的默认 access path 预设。 */
export function defaultAccessPath(preset: ProviderPreset): ProviderAccessPathPreset {
  const id = preset.default_access_path ?? preset.access_paths[0]?.id;
  return preset.access_paths.find((p) => p.id === id) ?? preset.access_paths[0]!;
}
