/**
 * http/error-guidance.ts —— 中心化的协议 / 模态错配报错指引。
 *
 * 统一维护「非对话模态 → 推荐端点 + Schema 路径」单点映射表，避免报错文案散落各处。
 * 当客户端误把 decision / embedding / tts / asr 等专用模型发往对话端点
 * （/v1/chat/completions、/v1/responses、/v1/messages、/v1beta/models/*:generateContent）
 * 时，在网关入口直接拦截并返回附带正确端点与 `/v1/schema/*` 指引的 400 响应。
 */

import type { ServerResponse } from 'node:http';
import type { CapabilityEntry, FormatId, ModalityKind } from '../ir/index.js';

export interface ModalityGuidance {
  modality: ModalityKind;
  article: 'a' | 'an';
  endpoint: string;
  schema_ref: string;
}

/** 唯一事实来源：各专用模态对应的推荐端点与 Schema 文档路径。 */
export const MODALITY_ENDPOINT_GUIDANCE: Readonly<Partial<Record<ModalityKind, ModalityGuidance>>> = {
  decision: {
    modality: 'decision',
    article: 'a',
    endpoint: 'POST /v1/decisions',
    schema_ref: '/v1/schema/decisions',
  },
  embedding: {
    modality: 'embedding',
    article: 'an',
    endpoint: 'POST /v1/embeddings',
    schema_ref: '/v1/schema/openai.embeddings',
  },
  image: {
    modality: 'image',
    article: 'an',
    endpoint: 'POST /v1/images/generations',
    schema_ref: '/v1/schema/images.generations',
  },
  tts: {
    modality: 'tts',
    article: 'a',
    endpoint: 'POST /v1/audio/speech',
    schema_ref: '/v1/schema/audio.speech',
  },
  asr: {
    modality: 'asr',
    article: 'an',
    endpoint: 'POST /v1/audio/transcriptions',
    schema_ref: '/v1/schema/audio.transcriptions',
  },
};

export interface ModalityMismatchGuardDeps {
  aliasResolver?: {
    resolve(
      model: string,
      modality: ModalityKind,
    ):
      | { source: string; target: { provider: string; access_path: string; model: string } }
      | undefined;
  };
  listCapabilities?: () => readonly CapabilityEntry[];
}

export interface ModalityMismatchGuard {
  /**
   * 若请求指向非对话专用模型，直接写回带正确端点指引的 400 响应并返回 `true`。
   * 返回 `false` 表示放行进入正常对话 pipeline。
   */
  tryRejectMismatch(
    res: ServerResponse,
    clientFormat: FormatId,
    path: string,
    rawBody: Buffer,
  ): boolean;
}

const NON_CHAT_CHECK_ORDER: readonly ModalityKind[] = [
  'decision',
  'embedding',
  'tts',
  'asr',
  'image',
];

function extractModelFromRequest(path: string, rawBody: Buffer): string | undefined {
  // Gemini 路径形态：/v1beta/models/{model}:generateContent
  const geminiMatch = /^\/v1beta\/models\/([^/:]+):(?:streamGenerateContent|generateContent)$/.exec(
    path,
  );
  if (geminiMatch !== null && geminiMatch[1] !== undefined) {
    return decodeURIComponent(geminiMatch[1]);
  }
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const m = (parsed as Record<string, unknown>)['model'];
      if (typeof m === 'string' && m.trim() !== '') return m.trim();
    }
  } catch {
    // 交给下游 S1 报合法 JSON 解析错
  }
  return undefined;
}

function inferSpecializedModalityByName(model: string): ModalityKind | undefined {
  const lower = model.toLowerCase();
  if (/(^|[-_/.])(decision|decisions)([-_/.]|$)|(?:^|\/)jev(?:[-_.\d]|$)/.test(lower)) {
    return 'decision';
  }
  if (/(^|[-_/.])(embed|embedding|embeddings|bge|text-embedding)([-_/.]|$)/.test(lower)) {
    return 'embedding';
  }
  return undefined;
}

export function formatModalityMismatchMessage(model: string, g: ModalityGuidance): string {
  return `Model "${model}" is ${g.article} ${g.modality} model and does not support this protocol. Please use ${g.endpoint} (see GET ${g.schema_ref}).`;
}

function buildWireErrorBody(
  clientFormat: FormatId,
  message: string,
  guidance: ModalityGuidance,
): unknown {
  if (clientFormat === 'anthropic.messages') {
    return {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message,
      },
    };
  }
  if (clientFormat === 'gemini.generateContent') {
    return {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message,
      },
    };
  }
  return {
    error: {
      message,
      type: 'invalid_request_error',
      code: 'capability_unsupported',
      param: 'model',
      recommended_endpoint: guidance.endpoint,
      schema_ref: guidance.schema_ref,
    },
  };
}

export function createModalityMismatchGuard(
  deps: ModalityMismatchGuardDeps = {},
): ModalityMismatchGuard {
  function detectNonChatModality(model: string): ModalityKind | undefined {
    // 若明确登记为 chat 模态，绝不误拦截
    if (deps.aliasResolver?.resolve(model, 'chat') !== undefined) {
      return undefined;
    }
    const caps = deps.listCapabilities?.() ?? [];
    if (caps.some((c) => c.model === model && c.modality === 'chat')) {
      return undefined;
    }

    if (deps.aliasResolver !== undefined) {
      for (const mod of NON_CHAT_CHECK_ORDER) {
        if (deps.aliasResolver.resolve(model, mod) !== undefined) {
          return mod;
        }
      }
    }
    for (const mod of NON_CHAT_CHECK_ORDER) {
      if (caps.some((c) => c.model === model && c.modality === mod)) {
        return mod;
      }
    }
    return inferSpecializedModalityByName(model);
  }

  return {
    tryRejectMismatch(res, clientFormat, path, rawBody): boolean {
      const model = extractModelFromRequest(path, rawBody);
      if (model === undefined) return false;

      const modality = detectNonChatModality(model);
      if (modality === undefined) return false;

      const guidance = MODALITY_ENDPOINT_GUIDANCE[modality];
      if (guidance === undefined) return false;

      const message = formatModalityMismatchMessage(model, guidance);
      const payload = JSON.stringify(buildWireErrorBody(clientFormat, message, guidance));
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return true;
    },
  };
}
