# 跨格式厂商专有设置透传指南（Provider Options）

在使用 AgentGateway 时，客户端可以用统一协议（例如 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages）去调用不同厂商的模型（例如 Google Gemini、Anthropic Claude、DeepSeek）。

对于各家通用的参数（如 `temperature`、`max_tokens`、`tools`），网关会在编解码阶段自动完成双向映射；但对于**厂商专有设置**（例如 Google Gemini 的 `safetySettings`、`cachedContent`、`mediaResolution`，或 Anthropic 的 `container`、`output_config`），客户端需要一种不破坏当前请求格式的表达方式。

本文说明如何在任意入站格式下安全地传递这些厂商专有设置。

---

## 1. 最常见场景：用 OpenAI 格式给 Gemini 传 `safetySettings`

以下三种写法等效，任选其一即可：

### 1.1 OpenAI Python / JS SDK（推荐 `extra_body`）

OpenAI 官方 SDK 会把 `extra_body` 里的键自动展开到请求 JSON 顶层：

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key=os.environ["AG_API_KEY"])

resp = client.chat.completions.create(
    model="gemini-2.5-pro",
    messages=[{"role": "user", "content": "你好"}],
    extra_body={
        "safety_settings": [
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_ONLY_HIGH",
            },
        ],
        "top_k": 32,
    },
)
```

> 顶层同时兼容 `safety_settings`（snake_case）与 `safetySettings`（camelCase）。

### 1.2 原始 HTTP / 不自动展开 `extra_body` 的客户端

如果客户端直接把 `extra_body` 作为嵌套对象发给网关，网关同样会解包识别：

```json
{
  "model": "gemini-2.5-pro",
  "messages": [{ "role": "user", "content": "你好" }],
  "extra_body": {
    "safetySettings": [
      {
        "category": "HARM_CATEGORY_HATE_SPEECH",
        "threshold": "BLOCK_NONE"
      }
    ]
  }
}
```

### 1.3 使用统一命名空间 `ag_provider_options`

当需要同时传递多个 Gemini 专有字段（如 `cachedContent`、`generationConfig.mediaResolution`）时，推荐使用 `ag_provider_options`：

```json
{
  "model": "gemini-2.5-pro",
  "messages": [{ "role": "user", "content": "分析这张图" }],
  "temperature": 0.2,
  "ag_provider_options": {
    "gemini": {
      "safetySettings": [
        {
          "category": "HARM_CATEGORY_HATE_SPEECH",
          "threshold": "BLOCK_NONE"
        }
      ],
      "cachedContent": "cachedContents/my-cache-id",
      "generationConfig": {
        "mediaResolution": "MEDIA_RESOLUTION_HIGH"
      }
    }
  }
}
```

---

## 2. 统一机制：`ag_provider_options` 命名空间

`ag_provider_options` 是网关的跨格式厂商参数容器，在 **4 种入站格式**（`openai.chat`、`openai.responses`、`anthropic.messages`、`gemini.generateContent`）下均可使用（放在请求 JSON 顶层，或放在 `extra_body.ag_provider_options` 内）。

### 2.1 支持的厂商键与别名

| 目标上游 | 推荐键名 | 兼容别名（自动归一化） | 接收该命名空间的目标 Adaptor |
|---|---|---|---|
| Google Gemini / Vertex AI | `gemini` | `google`、`vertex`、`vertexai` | `gemini.generateContent` |
| Anthropic Claude | `anthropic` | `claude` | `anthropic.messages` |
| OpenAI | `openai` | `oai` | `openai.chat`、`openai.responses` |
| DeepSeek | `deepseek` | — | `openai.chat`、`openai.responses` |

### 2.2 常见可透传参数参考

- **Gemini（`ag_provider_options.gemini` 或 `google`）**
  - `safetySettings`：内容安全阈值列表（也可以直接用顶层 `safety_settings` / `safetySettings`）。
  - `cachedContent`：上下文缓存资源名（如 `cachedContents/...`）。
  - `labels`：请求标签键值对。
  - `generationConfig`：如 `mediaResolution`、`responseModalities`、`speechConfig` 等（与主参数生成的 `generationConfig` 做浅合并，不会覆盖未重名的 `temperature`、`maxOutputTokens` 等字段）。
  - `toolConfig`：工具调用附加配置（浅合并）。
- **Anthropic（`ag_provider_options.anthropic`）**
  - `container`：代码执行等容器标识。
  - `output_config`：输出配置（如 `{ "effort": "high" }`，浅合并）。
  - `context_management`：上游上下文管理配置。
  - `service_tier` / `speed`：服务档位或速率选项。
- **OpenAI（`ag_provider_options.openai`）**
  - `store`、`truncation`、`max_tool_calls`、`prompt_cache_key`、`prompt_cache_retention`、`safety_identifier`、`previous_response_id`、`include`、`verbosity`、`context_management`、`stream_options`（浅合并）。
- **DeepSeek（`ag_provider_options.deepseek`）**
  - `safety_check`、`title`、`thinking` 等 DeepSeek 扩展字段（走 OpenAI Chat / Responses 协议接入时生效）。

---

## 3. 安全隔离与回退行为

1. **按目标厂商严格隔离**
   只有当请求实际路由到匹配的 adaptor 时，对应命名空间的参数才会写入上游请求体。例如请求里带了 `ag_provider_options.gemini`，但最终命中了 `openai.chat` 或 `anthropic.messages` 上游，这些 Gemini 字段**不会**泄露给无关上游。
2. **显式告警（不静默丢弃）**
   - 当 `ag_provider_options.<vendor>` 因目标厂商不匹配被忽略时，响应诊断与用量记录的 `warnings` 会记入 `native_options_ignored:<vendor>`。
   - 当顶层 `safety_settings` / `safetySettings` 被路由到不支持它的 OpenAI 或 Anthropic 上游时，会记入 `safety_unsupported` 告警并安全丢弃。
3. **核心结构字段受保护**
   `model`、`messages`、`input`、`contents`、`system`、`systemInstruction` 等核心消息结构字段受保护，不会被 `ag_provider_options` 覆盖。
4. **嵌套对象浅合并**
   对 `generationConfig`、`toolConfig`、`thinking`、`output_config`、`reasoning`、`text`、`stream_options` 执行浅合并，因此可以只补充厂商特有子字段而保留通用采样参数。
5. **优先级约定**
   - 请求 JSON 顶层字段优先于 `extra_body` 内的同名字段。
   - 顶层 `safety_settings` / `safetySettings`（落入 canonical 的 `params.safety`）优先于 `ag_provider_options.gemini.safetySettings`。
