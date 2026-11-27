/**
 * http/schema-endpoint.ts —— 下游自发现与契约端点：
 *   - `GET /v1/schema`（含 `?model=<id>` 按模型反查）
 *   - `GET /v1/schema/<endpoint_id>`（单端点完整 JSON Schema + 相关映射）
 *   - `GET /v1/openapi.json`（标准 OpenAPI 3.1.0 文档）
 *
 * 所有端点均落在 `/v1/*` 数据面下，自动复用 http/server.ts 的统一鉴权与 Stealth Gate。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CapabilityEntry, ModalityKind } from '../ir/index.js';

export const SCHEMA_VERSION = 'ag-surface/1';
export const IR_VERSION_TAG = 'ag-ir/1';

export type JsonSchema = Record<string, unknown>;

export interface EndpointSurfaceSpec {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  modality: ModalityKind | 'meta';
  streaming: 'sse' | 'none' | 'optional_sse';
  summary: string;
  upstream_dialects: string[];
  request_schema?: JsonSchema;
  response_schema: JsonSchema;
  notes?: string[];
}

export interface MappingSpec {
  id: string;
  from: string;
  to: string;
  kind: 'protocol_translation' | 'modality_dispatch' | 'modality_bridge' | 'degradation';
  summary: string;
  field_map: Record<string, string>;
  unsupported_or_degraded?: string[];
  notes?: string[];
}

export interface SchemaEndpointsDeps {
  /** 运行时能力矩阵（可选；用于计算各端点可用性与 `?model=` 反查）。 */
  listCapabilities?: () => readonly CapabilityEntry[];
  /** 别名 / 命名空间解析器（可选；用于 `?model=<ns>/<id>` 反查）。 */
  aliasResolver?: {
    resolve(
      model: string,
      modality: ModalityKind,
    ):
      | { source: string; target: { provider: string; access_path: string; model: string } }
      | undefined;
  };
  /** 当前服务器是否启用了 Chat → Images 桥接（支持布尔或动态 getter）。 */
  chatImageBridgeEnabled?: boolean | (() => boolean);
}

export interface SchemaEndpoints {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 单一事实来源：端点目录 + JSON Schema + 跨协议/跨模态映射
// ---------------------------------------------------------------------------

const ENDPOINT_SPECS: readonly EndpointSurfaceSpec[] = [
  {
    id: 'openai.chat',
    method: 'POST',
    path: '/v1/chat/completions',
    modality: 'chat',
    streaming: 'optional_sse',
    summary: 'OpenAI Chat Completions 兼容对话端点（支持流式、工具调用、多模态输入及生图模型自动桥接）',
    upstream_dialects: [
      'openai.chat',
      'openai.responses',
      'anthropic.messages',
      'gemini.generateContent',
      'openai.images.generations',
    ],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'messages'],
      properties: {
        model: { type: 'string', description: '模型 ID 或 <namespace>/<model> 别名' },
        messages: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['role', 'content'],
            properties: {
              role: { type: 'string', enum: ['system', 'developer', 'user', 'assistant', 'tool'] },
              content: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', enum: ['text', 'image_url', 'input_audio'] },
                        text: { type: 'string' },
                        image_url: {
                          type: 'object',
                          properties: {
                            url: { type: 'string' },
                            detail: { type: 'string', enum: ['auto', 'low', 'high'] },
                          },
                        },
                      },
                    },
                  },
                ],
              },
              tool_calls: { type: 'array', items: { type: 'object' } },
              tool_call_id: { type: 'string' },
            },
          },
        },
        stream: { type: 'boolean', default: false },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        top_p: { type: 'number', minimum: 0, maximum: 1 },
        max_tokens: { type: 'integer', minimum: 1 },
        max_completion_tokens: { type: 'integer', minimum: 1 },
        reasoning_effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'max'] },
        tools: { type: 'array', items: { type: 'object' } },
        tool_choice: { oneOf: [{ type: 'string' }, { type: 'object' }] },
        response_format: { type: 'object' },
        ag_provider_options: {
          type: 'object',
          description: '跨格式厂商原语透传（如 { gemini: {...}, anthropic: {...}, openai: {...} }）',
        },
        size: { type: 'string', description: '生图桥接可选参数（如 1024x1024）' },
        quality: { type: 'string', description: '生图桥接可选参数（standard / hd / low / medium / high）' },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['id', 'object', 'created', 'model', 'choices'],
      properties: {
        id: { type: 'string' },
        object: { type: 'string', enum: ['chat.completion', 'chat.completion.chunk'] },
        created: { type: 'integer' },
        model: { type: 'string' },
        choices: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer' },
              message: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  content: { type: ['string', 'null'] },
                  reasoning_content: { type: 'string' },
                  tool_calls: { type: 'array', items: { type: 'object' } },
                  images: {
                    type: 'array',
                    description: '生图桥接时附带的结构化图片列表',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string', const: 'image_url' },
                        image_url: {
                          type: 'object',
                          properties: { url: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
              finish_reason: { type: ['string', 'null'] },
            },
          },
        },
        usage: {
          type: 'object',
          properties: {
            prompt_tokens: { type: 'integer' },
            completion_tokens: { type: 'integer' },
            total_tokens: { type: 'integer' },
          },
        },
      },
    },
    notes: [
      '当目标模型为生图模型（modality=image）时，自动桥接至上游 Images API，并以 markdown 图片 + choices[0].message.images 返回。',
      '决策模型（modality=decision）不支持 chat/completions，请改用 POST /v1/decisions。',
    ],
  },
  {
    id: 'openai.responses',
    method: 'POST',
    path: '/v1/responses',
    modality: 'chat',
    streaming: 'optional_sse',
    summary: 'OpenAI Responses API 兼容端点',
    upstream_dialects: ['openai.responses', 'openai.chat', 'anthropic.messages', 'gemini.generateContent'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'input'],
      properties: {
        model: { type: 'string' },
        input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
        instructions: { type: 'string' },
        stream: { type: 'boolean', default: false },
        max_output_tokens: { type: 'integer', minimum: 1 },
        reasoning: { type: 'object', properties: { effort: { type: 'string' } } },
        tools: { type: 'array', items: { type: 'object' } },
        ag_provider_options: { type: 'object' },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['id', 'object', 'status', 'output'],
      properties: {
        id: { type: 'string' },
        object: { type: 'string', const: 'response' },
        status: { type: 'string' },
        model: { type: 'string' },
        output: { type: 'array', items: { type: 'object' } },
        usage: { type: 'object' },
      },
    },
  },
  {
    id: 'anthropic.messages',
    method: 'POST',
    path: '/v1/messages',
    modality: 'chat',
    streaming: 'optional_sse',
    summary: 'Anthropic Messages API 兼容端点',
    upstream_dialects: ['anthropic.messages', 'openai.chat', 'openai.responses', 'gemini.generateContent'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'max_tokens', 'messages'],
      properties: {
        model: { type: 'string' },
        max_tokens: { type: 'integer', minimum: 1 },
        system: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
        messages: { type: 'array', minItems: 1, items: { type: 'object' } },
        stream: { type: 'boolean', default: false },
        thinking: { type: 'object' },
        tools: { type: 'array', items: { type: 'object' } },
        ag_provider_options: { type: 'object' },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['id', 'type', 'role', 'content'],
      properties: {
        id: { type: 'string' },
        type: { type: 'string', const: 'message' },
        role: { type: 'string', const: 'assistant' },
        model: { type: 'string' },
        content: { type: 'array', items: { type: 'object' } },
        stop_reason: { type: ['string', 'null'] },
        usage: { type: 'object' },
      },
    },
  },
  {
    id: 'gemini.generateContent',
    method: 'POST',
    path: '/v1beta/models/{model}:generateContent',
    modality: 'chat',
    streaming: 'optional_sse',
    summary: 'Google Gemini generateContent / streamGenerateContent 兼容端点',
    upstream_dialects: ['gemini.generateContent', 'openai.chat', 'openai.responses', 'anthropic.messages'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['contents'],
      properties: {
        contents: { type: 'array', minItems: 1, items: { type: 'object' } },
        systemInstruction: { type: 'object' },
        generationConfig: { type: 'object' },
        safetySettings: { type: 'array', items: { type: 'object' } },
        tools: { type: 'array', items: { type: 'object' } },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['candidates'],
      properties: {
        candidates: { type: 'array', items: { type: 'object' } },
        usageMetadata: { type: 'object' },
      },
    },
    notes: ['流式请使用 POST /v1beta/models/{model}:streamGenerateContent?alt=sse。'],
  },
  {
    id: 'openai.embeddings',
    method: 'POST',
    path: '/v1/embeddings',
    modality: 'embedding',
    streaming: 'none',
    summary: 'OpenAI 兼容向量嵌入端点（自动按上游方言分发至 OpenAI Embeddings 或 Gemini embedContent）',
    upstream_dialects: ['openai.embeddings', 'gemini.generateContent'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'input'],
      properties: {
        model: { type: 'string' },
        input: {
          oneOf: [
            { type: 'string', minLength: 1 },
            { type: 'array', minItems: 1, items: { type: 'string' } },
          ],
        },
        dimensions: { type: 'integer', minimum: 1 },
        encoding_format: { type: 'string', enum: ['float', 'base64'] },
        user: { type: 'string' },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['object', 'data', 'model'],
      properties: {
        object: { type: 'string', const: 'list' },
        model: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            required: ['object', 'index', 'embedding'],
            properties: {
              object: { type: 'string', const: 'embedding' },
              index: { type: 'integer' },
              embedding: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'string' }] },
            },
          },
        },
        usage: {
          type: 'object',
          properties: {
            prompt_tokens: { type: 'integer' },
            total_tokens: { type: 'integer' },
          },
        },
      },
    },
  },
  {
    id: 'images.generations',
    method: 'POST',
    path: '/v1/images/generations',
    modality: 'image',
    streaming: 'none',
    summary: 'OpenAI Images 兼容文生图端点（自动分发至 OpenAI Images / Gemini Imagen & generateContent）',
    upstream_dialects: ['openai.images.generations', 'gemini.generateContent'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string' },
        prompt: { type: 'string', minLength: 1 },
        n: { type: 'integer', minimum: 1, maximum: 10 },
        size: { type: 'string', description: '如 1024x1024 / 1536x1024' },
        quality: { type: 'string' },
        response_format: { type: 'string', enum: ['b64_json', 'url'] },
        output_format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['created', 'data'],
      properties: {
        created: { type: 'integer' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              b64_json: { type: 'string' },
              url: { type: 'string' },
              revised_prompt: { type: 'string' },
            },
          },
        },
        usage: { type: 'object' },
      },
    },
  },
  {
    id: 'images.edits',
    method: 'POST',
    path: '/v1/images/edits',
    modality: 'image',
    streaming: 'none',
    summary: 'OpenAI Images 兼容图像编辑端点（multipart/form-data）',
    upstream_dialects: ['openai.images.edits', 'gemini.generateContent'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'prompt', 'image'],
      properties: {
        model: { type: 'string' },
        prompt: { type: 'string' },
        image: { type: 'string', format: 'binary', description: 'multipart 文件字段' },
        mask: { type: 'string', format: 'binary' },
        n: { type: 'integer', minimum: 1, maximum: 10 },
        size: { type: 'string' },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['created', 'data'],
      properties: {
        created: { type: 'integer' },
        data: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    id: 'audio.speech',
    method: 'POST',
    path: '/v1/audio/speech',
    modality: 'tts',
    streaming: 'none',
    summary: 'OpenAI Audio 兼容语音合成（TTS）端点',
    upstream_dialects: ['deepseek.tts', 'mimo.tts'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'input'],
      properties: {
        model: { type: 'string' },
        input: { type: 'string', minLength: 1 },
        voice: { type: 'string' },
        response_format: { type: 'string', enum: ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'] },
        speed: { type: 'number', minimum: 0.25, maximum: 4.0 },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
      format: 'binary',
      description: '音频二进制流',
    },
  },
  {
    id: 'audio.transcriptions',
    method: 'POST',
    path: '/v1/audio/transcriptions',
    modality: 'asr',
    streaming: 'none',
    summary: 'OpenAI Audio 兼容语音识别（ASR）端点（multipart/form-data）',
    upstream_dialects: ['deepseek.asr', 'mimo.asr'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model', 'file'],
      properties: {
        model: { type: 'string' },
        file: { type: 'string', format: 'binary' },
        language: { type: 'string' },
        prompt: { type: 'string' },
        response_format: { type: 'string', enum: ['json', 'text', 'verbose_json'] },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
  {
    id: 'decisions',
    method: 'POST',
    path: '/v1/decisions',
    modality: 'decision',
    streaming: 'none',
    summary: '结构化决策模型端点（canonical 信封直传，支持 OpenCode Go SystemOne 原生决策与 Chat 降级）',
    upstream_dialects: ['jev.decisions', 'chat.degraded'],
    request_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['model'],
      description:
        '支持简洁扁平形态 { model, content, questions } 或完整 canonical 信封 { model, payload: { content, questions } }；ir_version / kind / source_format / stream / raw 均可省略自动补默认值。',
      properties: {
        ir_version: { type: 'string', default: 'ag-ir/1', enum: ['ag-ir/1'] },
        kind: { type: 'string', default: 'decision', enum: ['decision'] },
        model: { type: 'string', description: '如 oc/jev-1.14、oc/gemini-decision-1、oc/gpt-6-luna-decision' },
        source_format: { type: 'string', default: 'mock.decisions' },
        content: {
          description: '简洁写法：被判断的内容（字符串或 DecisionContent[]，与 payload 二选一）',
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  role: { type: 'string' },
                  media: { type: 'object' },
                },
              },
            },
          ],
        },
        questions: {
          type: 'array',
          minItems: 1,
          description: '简洁写法：问题列表（与 payload.questions 二选一）',
          items: {
            type: 'object',
            required: ['id', 'type', 'prompt'],
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['binary', 'choice', 'scale', 'rubric', 'box'] },
              prompt: { type: 'string' },
              options: { type: 'array', items: { type: 'object' } },
              scale: { type: 'object' },
            },
          },
        },
        stream: {
          type: 'object',
          default: { mode: 'none', enabled: false },
          properties: {
            mode: { type: 'string', const: 'none' },
            enabled: { type: 'boolean', const: false },
          },
        },
        payload: {
          type: 'object',
          required: ['questions'],
          properties: {
            content: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  role: { type: 'string' },
                  media: { type: 'object' },
                },
              },
            },
            questions: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['id', 'type', 'prompt'],
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string', enum: ['binary', 'choice', 'scale', 'rubric', 'box'] },
                  prompt: { type: 'string' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['value'],
                      properties: {
                        value: { type: 'string' },
                        label: { type: 'string' },
                        description: { type: 'string' },
                      },
                    },
                  },
                  scale: {
                    type: 'object',
                    properties: {
                      min: { type: 'number' },
                      max: { type: 'number' },
                      step: { type: 'number' },
                      labels: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
            raw: { type: 'object' },
          },
        },
        raw: { type: 'object' },
      },
    },
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['ir_version', 'kind', 'finish_reason', 'payload', 'usage'],
      properties: {
        ir_version: { type: 'string', const: 'ag-ir/1' },
        kind: { type: 'string', const: 'decision' },
        finish_reason: { type: 'string' },
        calibration: {
          type: 'object',
          properties: {
            calibration: { type: 'string', enum: ['native', 'degraded'] },
          },
        },
        payload: {
          type: 'object',
          required: ['answers'],
          properties: {
            answers: {
              type: 'array',
              items: {
                type: 'object',
                required: ['question_id', 'label'],
                properties: {
                  question_id: { type: 'string' },
                  label: { type: 'string' },
                  probability: { type: 'number' },
                  confidence: { type: 'number' },
                  option_probabilities: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        value: { type: 'string' },
                        probability: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        usage: { type: 'object' },
      },
    },
  },
  {
    id: 'models',
    method: 'GET',
    path: '/v1/models',
    modality: 'meta',
    streaming: 'none',
    summary: 'OpenAI 兼容模型目录（含命名空间前缀与扩展能力字段）',
    upstream_dialects: [],
    response_schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['object', 'data'],
      properties: {
        object: { type: 'string', const: 'list' },
        data: { type: 'array', items: { type: 'object' } },
      },
    },
  },
];

const MAPPING_SPECS: readonly MappingSpec[] = [
  {
    id: 'openai.chat->openai.images',
    from: 'openai.chat',
    to: 'openai.images.generations',
    kind: 'modality_bridge',
    summary: '通过 POST /v1/chat/completions 直接调用生图模型（自动桥接上游 OpenAI Images / Gemini Images）',
    field_map: {
      'messages[last role=user].content': 'prompt（拼接用户文本；若有 system 消息则作为前置指令）',
      size: 'size（可选，如 1024x1024）',
      quality: 'quality（可选）',
      n: 'n（可选，生成张数）',
      'upstream image (b64_json / url)':
        'choices[0].message.content（Markdown 图片）+ choices[0].message.images[{type:"image_url",image_url:{url}}]',
      'stream=true': '单段 SSE chat.completion.chunk + [DONE]',
    },
    unsupported_or_degraded: ['tools', 'tool_choice', 'response_format', 'multi-turn mask edit'],
    notes: [
      '仅当目标模型在目录中登记为 modality="image" 且非对话模型时自动触发，不影响正常 chat 模型。',
      '如需图像编辑（带 mask）或更多参数控制，请直接调用 POST /v1/images/generations 或 POST /v1/images/edits。',
    ],
  },
  {
    id: 'openai.chat->anthropic.messages',
    from: 'openai.chat',
    to: 'anthropic.messages',
    kind: 'protocol_translation',
    summary: 'OpenAI Chat Completions 双向互转 Anthropic Messages',
    field_map: {
      'messages[role=system]': 'system',
      'messages[].content[type=image_url]': 'content[type=image]',
      'tools[type=function]': 'tools[{name, description, input_schema}]',
      reasoning_effort: 'thinking.budget_tokens / effort',
      'ag_provider_options.anthropic': '透传到 Anthropic 请求体',
    },
    unsupported_or_degraded: ['logprobs', 'logit_bias', 'n > 1'],
  },
  {
    id: 'openai.chat->gemini.generateContent',
    from: 'openai.chat',
    to: 'gemini.generateContent',
    kind: 'protocol_translation',
    summary: 'OpenAI Chat Completions 双向互转 Google Gemini generateContent',
    field_map: {
      'messages[role=system]': 'systemInstruction',
      'messages[].content[type=image_url]': 'contents[].parts[].inlineData / fileData',
      reasoning_effort: 'generationConfig.thinkingConfig',
      'tools[type=web_search]': 'tools[].googleSearch',
      'ag_provider_options.gemini': '透传到 Gemini 请求体 / safetySettings',
    },
    unsupported_or_degraded: ['logprobs', 'logit_bias', 'presence_penalty'],
  },
  {
    id: 'openai.chat->openai.responses',
    from: 'openai.chat',
    to: 'openai.responses',
    kind: 'protocol_translation',
    summary: 'OpenAI Chat Completions 双向互转 OpenAI Responses API',
    field_map: {
      'messages[role=system]': 'instructions',
      messages: 'input[]',
      max_tokens: 'max_output_tokens',
      reasoning_effort: 'reasoning.effort',
    },
  },
  {
    id: 'openai.embeddings->gemini.generateContent',
    from: 'openai.embeddings',
    to: 'gemini.generateContent',
    kind: 'modality_dispatch',
    summary: 'OpenAI /v1/embeddings 请求自动分发到 Gemini 原生 embedContent / batchEmbedContents',
    field_map: {
      'input (string)': 'POST /v1beta/models/{model}:embedContent',
      'input (string[])': 'POST /v1beta/models/{model}:batchEmbedContents',
      dimensions: 'outputDimensionality',
    },
  },
  {
    id: 'images.generations->gemini.generateContent',
    from: 'images.generations',
    to: 'gemini.generateContent',
    kind: 'modality_dispatch',
    summary: 'OpenAI /v1/images/generations 自动分发到 Gemini Imagen / generateContent 生图',
    field_map: {
      prompt: 'contents[].parts[].text / instances[].prompt',
      size: 'aspectRatio（近似换算）',
      n: 'sampleCount / candidateCount',
    },
  },
  {
    id: 'decisions->jev.decisions',
    from: 'decisions',
    to: 'jev.decisions',
    kind: 'modality_dispatch',
    summary: 'Canonical /v1/decisions 映射到 TypeSafe SystemOne（OpenCode Go /inference/go/systemone/v1/systemone）',
    field_map: {
      'payload.content[].text': 'state',
      'payload.content[].media': 'assets + TypeSafe-Danger-Zone-Images: true',
      'questions[type=binary]': 'questions[id].type = "noul"',
      'questions[type=choice]': 'questions[id].type = "choice" + criteria map',
      'questions[type=scale]': 'questions[id].type = "score" + criteria array',
      'questions[type=box]': 'questions[id].type = "box"',
    },
    unsupported_or_degraded: ['multiple=true（drop + warn）', 'include_rationale'],
  },
  {
    id: 'decisions->chat.degraded',
    from: 'decisions',
    to: 'openai.chat',
    kind: 'degradation',
    summary: '无原生 decision 上游时，用 Chat + JSON Schema 降级模拟（高风险策略/stop 问题默认拒绝降级）',
    field_map: {
      'payload.questions': 'user prompt + response_format(json_schema)',
      'response.calibration': '{ calibration: "degraded" }',
    },
  },
];

// ---------------------------------------------------------------------------
// 构造器：总览 / 单端点详情 / 按模型反查 / OpenAPI 3.1
// ---------------------------------------------------------------------------

function computeAvailableModalities(deps: SchemaEndpointsDeps): Set<string> | undefined {
  const caps = deps.listCapabilities?.();
  if (caps === undefined) return undefined;
  const set = new Set<string>();
  for (const c of caps) {
    if (c.status === 'implemented') set.add(c.modality);
  }
  return set;
}

function isBridgeEnabled(deps: SchemaEndpointsDeps): boolean {
  if (typeof deps.chatImageBridgeEnabled === 'function') {
    return deps.chatImageBridgeEnabled();
  }
  return deps.chatImageBridgeEnabled !== false;
}

export function buildSchemaOverview(deps: SchemaEndpointsDeps): Record<string, unknown> {
  const avail = computeAvailableModalities(deps);
  const bridgeOn = isBridgeEnabled(deps);
  const endpoints = ENDPOINT_SPECS.map((ep) => ({
    id: ep.id,
    method: ep.method,
    path: ep.path,
    modality: ep.modality,
    streaming: ep.streaming,
    summary: ep.summary,
    available:
      ep.modality === 'meta' ? true : avail === undefined ? true : avail.has(ep.modality),
    upstream_dialects: ep.upstream_dialects,
    schema_ref: `/v1/schema/${ep.id}`,
    ...(ep.notes === undefined ? {} : { notes: ep.notes }),
  }));

  const mappings = MAPPING_SPECS.filter((m) =>
    m.id === 'openai.chat->openai.images' ? bridgeOn : true,
  );

  return {
    schema_version: SCHEMA_VERSION,
    ir_version: IR_VERSION_TAG,
    openapi_url: '/v1/openapi.json',
    model_lookup_template: '/v1/schema?model={model}',
    endpoints,
    mappings,
  };
}

export function buildEndpointSchemaDetail(
  deps: SchemaEndpointsDeps,
  endpointId: string,
): Record<string, unknown> | undefined {
  const ep = ENDPOINT_SPECS.find((item) => item.id === endpointId);
  if (ep === undefined) return undefined;
  const avail = computeAvailableModalities(deps);
  const bridgeOn = isBridgeEnabled(deps);
  const relatedMappings = MAPPING_SPECS.filter(
    (m) =>
      (m.from === ep.id || m.to === ep.id) &&
      (m.id === 'openai.chat->openai.images' ? bridgeOn : true),
  );
  return {
    schema_version: SCHEMA_VERSION,
    ir_version: IR_VERSION_TAG,
    id: ep.id,
    method: ep.method,
    path: ep.path,
    modality: ep.modality,
    streaming: ep.streaming,
    summary: ep.summary,
    available:
      ep.modality === 'meta' ? true : avail === undefined ? true : avail.has(ep.modality),
    upstream_dialects: ep.upstream_dialects,
    ...(ep.request_schema === undefined ? {} : { request_schema: ep.request_schema }),
    response_schema: ep.response_schema,
    ...(ep.notes === undefined ? {} : { notes: ep.notes }),
    mappings: relatedMappings,
  };
}

const MODALITIES_CHECK_ORDER: readonly ModalityKind[] = [
  'decision',
  'embedding',
  'image',
  'tts',
  'asr',
  'video',
  'rerank',
  'moderation',
  'chat',
];

function endpointsForModality(
  modality: ModalityKind,
  chatImageBridgeEnabled: boolean,
): EndpointSurfaceSpec[] {
  const list = ENDPOINT_SPECS.filter((ep) => ep.modality === modality);
  if (modality === 'image' && chatImageBridgeEnabled) {
    const chatEp = ENDPOINT_SPECS.find((ep) => ep.id === 'openai.chat');
    if (chatEp !== undefined) list.push(chatEp);
  }
  return list;
}

export function buildModelSchemaView(
  deps: SchemaEndpointsDeps,
  modelId: string,
): Record<string, unknown> {
  const caps = deps.listCapabilities?.() ?? [];
  const bridgeEnabled = isBridgeEnabled(deps);

  let resolved:
    | { provider: string; access_path: string; model: string; modality: ModalityKind }
    | undefined;

  if (deps.aliasResolver !== undefined) {
    for (const mod of MODALITIES_CHECK_ORDER) {
      const hit = deps.aliasResolver.resolve(modelId, mod);
      if (hit !== undefined) {
        resolved = {
          provider: hit.target.provider,
          access_path: hit.target.access_path,
          model: hit.target.model,
          modality: mod,
        };
        break;
      }
    }
  }

  if (resolved === undefined) {
    const directCap = caps.find((c) => c.model === modelId);
    if (directCap !== undefined) {
      resolved = {
        provider: directCap.access_path.split('.')[0] ?? directCap.access_path,
        access_path: directCap.access_path,
        model: directCap.model,
        modality: directCap.modality,
      };
    }
  }

  const modality: ModalityKind | undefined = resolved?.modality;
  const supported = modality === undefined ? [] : endpointsForModality(modality, bridgeEnabled);
  const recommended = supported[0];
  const supportedIds = new Set(supported.map((e) => e.id));
  const mappings = MAPPING_SPECS.filter(
    (m) =>
      supportedIds.has(m.from) &&
      (m.id === 'openai.chat->openai.images' ? modality === 'image' && bridgeEnabled : true),
  );

  return {
    schema_version: SCHEMA_VERSION,
    ir_version: IR_VERSION_TAG,
    model: modelId,
    found: resolved !== undefined,
    ...(resolved === undefined ? {} : { resolved }),
    ...(recommended === undefined
      ? {}
      : {
          recommended_endpoint: {
            id: recommended.id,
            method: recommended.method,
            path: recommended.path,
            schema_ref: `/v1/schema/${recommended.id}`,
          },
        }),
    supported_endpoints: supported.map((ep) => ({
      id: ep.id,
      method: ep.method,
      path: ep.path,
      modality: ep.modality,
      streaming: ep.streaming,
      bridge: modality === 'image' && ep.id === 'openai.chat',
      schema_ref: `/v1/schema/${ep.id}`,
      ...(ep.request_schema === undefined ? {} : { request_schema: ep.request_schema }),
      response_schema: ep.response_schema,
    })),
    mappings,
  };
}

export function buildOpenApiDocument(deps: SchemaEndpointsDeps): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ep of ENDPOINT_SPECS) {
    const methodKey = ep.method.toLowerCase();
    const isMultipart = ep.id === 'images.edits' || ep.id === 'audio.transcriptions';
    const isBinaryRes = ep.id === 'audio.speech';

    const operation: Record<string, unknown> = {
      operationId: ep.id,
      summary: ep.summary,
      tags: [ep.modality],
      security: [{ BearerAuth: [] }],
      ...(ep.request_schema === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                [isMultipart ? 'multipart/form-data' : 'application/json']: {
                  schema: ep.request_schema,
                },
              },
            },
          }),
      responses: {
        '200': {
          description: 'OK',
          content: {
            [isBinaryRes ? 'application/octet-stream' : 'application/json']: {
              schema: ep.response_schema,
            },
          },
        },
        '400': { description: 'Bad Request / Capability Unsupported' },
        '401': { description: 'Unauthorized' },
      },
    };
    paths[ep.path] = { ...(paths[ep.path] ?? {}), [methodKey]: operation };
  }

  // 把 schema 发现端点本身也登记进 OpenAPI
  paths['/v1/schema'] = {
    get: {
      operationId: 'schema.overview',
      summary: '返回网关支持的全部下游端点、映射关系，或通过 ?model=<id> 反查单个模型',
      tags: ['meta'],
      security: [{ BearerAuth: [] }],
      parameters: [
        {
          name: 'model',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: '可选：按模型名（含命名空间前缀）反查推荐端点与映射',
        },
      ],
      responses: { '200': { description: 'OK' } },
    },
  };
  paths['/v1/schema/{id}'] = {
    get: {
      operationId: 'schema.detail',
      summary: '返回指定下游端点的完整请求/响应 JSON Schema 与相关映射',
      tags: ['meta'],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        '200': { description: 'OK' },
        '404': { description: 'Unknown endpoint id' },
      },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentGateway Data Plane API',
      version: SCHEMA_VERSION,
      description:
        'AgentGateway 多协议 / 多模态 LLM 网关数据面契约（含跨协议转换与 OpenAI Chat → Images 桥接）。',
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'AgentGateway Virtual Key（sk-ag-...）或访问令牌',
        },
      },
    },
    paths,
    'x-ag-mappings': MAPPING_SPECS.filter((m) =>
      m.id === 'openai.chat->openai.images' ? isBridgeEnabled(deps) : true,
    ),
  };
}

// ---------------------------------------------------------------------------
// HTTP 处理器
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createSchemaEndpoints(deps: SchemaEndpointsDeps = {}): SchemaEndpoints {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const path = url.pathname;
      const isOverview = path === '/v1/schema';
      const isOpenApi = path === '/v1/openapi.json';
      const detailMatch = /^\/v1\/schema\/([^/]+)$/.exec(path);

      if (!isOverview && !isOpenApi && detailMatch === null) {
        return false;
      }

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: '只支持 GET' } });
        return true;
      }

      if (isOpenApi) {
        sendJson(res, 200, buildOpenApiDocument(deps));
        return true;
      }

      if (isOverview) {
        const model = url.searchParams.get('model')?.trim();
        if (model !== undefined && model !== '') {
          sendJson(res, 200, buildModelSchemaView(deps, model));
          return true;
        }
        sendJson(res, 200, buildSchemaOverview(deps));
        return true;
      }

      const id = decodeURIComponent(detailMatch![1]!);
      const detail = buildEndpointSchemaDetail(deps, id);
      if (detail === undefined) {
        sendJson(res, 404, {
          error: {
            code: 'schema_not_found',
            message: `未知 schema 标识: ${id}`,
            available_ids: ENDPOINT_SPECS.map((e) => e.id),
          },
        });
        return true;
      }
      sendJson(res, 200, detail);
      return true;
    },
  };
}
