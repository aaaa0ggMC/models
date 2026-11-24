/**
 * adaptors/provider-options.ts —— 跨格式厂商专有参数（`ag_provider_options` / `safety_settings` / `params.native`）
 * 的统一解码与编码合并 helper。
 *
 * 设计依据：
 *   - `docs/design/10-canonical-schema.md` §3 决策 D2（`native.<vendor>.*` 命名空间隔离）；
 *   - `docs/provider-options.md`（客户端跨格式透传约定）。
 */

import type {
  ChatParams,
  ConversionDiagnostic,
  FormatId,
  SafetySetting,
} from '../ir/index.js';

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 归一化厂商命名空间名：把常见别名（如 `google` / `vertex` → `gemini`、`claude` → `anthropic`）
 * 收拢到 canonical 的标准厂商键，避免客户端猜名字时写错。
 */
export function normalizeVendorKey(raw: string): string {
  const k = raw.trim().toLowerCase();
  if (k === 'google' || k === 'vertex' || k === 'vertexai' || k === 'gemini') return 'gemini';
  if (k === 'claude' || k === 'anthropic') return 'anthropic';
  if (k === 'openai' || k === 'oai') return 'openai';
  if (k === 'deepseek') return 'deepseek';
  return k;
}

/** 从 wire 数组解析并校验 Gemini 风格的 `SafetySetting[]`。 */
export function parseSafetySettings(raw: unknown): SafetySetting[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SafetySetting[] = [];
  for (const item of raw) {
    const rec = asPlainRecord(item);
    if (rec === undefined) continue;
    const category = typeof rec['category'] === 'string' ? rec['category'] : undefined;
    const threshold = typeof rec['threshold'] === 'string' ? rec['threshold'] : undefined;
    if (category !== undefined && threshold !== undefined) {
      out.push({ category, threshold });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 从入站请求体抽取跨格式厂商专有参数，写入 `params`：
 *   1. `safety_settings` / `safetySettings`（顶层或 `extra_body` 内）→ `params.safety`
 *   2. `top_k`（顶层或 `extra_body` 内）→ `params.top_k`
 *   3. `ag_provider_options`（顶层或 `extra_body` 内）→ `params.native.<vendor>`
 *
 * 顶层键优先级高于 `extra_body` 内同名键。
 */
export function applyClientProviderOptions(
  obj: Record<string, unknown>,
  params: ChatParams,
): void {
  const extraBody = asPlainRecord(obj['extra_body']);

  if (params.safety === undefined) {
    const safetyRaw =
      obj['safety_settings'] ??
      obj['safetySettings'] ??
      extraBody?.['safety_settings'] ??
      extraBody?.['safetySettings'];
    const parsedSafety = parseSafetySettings(safetyRaw);
    if (parsedSafety !== undefined) {
      params.safety = parsedSafety;
    }
  }

  if (params.top_k === undefined) {
    const topKRaw = obj['top_k'] ?? extraBody?.['top_k'];
    if (typeof topKRaw === 'number' && Number.isFinite(topKRaw)) {
      params.top_k = topKRaw;
    }
  }

  const extraProviderOpts = asPlainRecord(extraBody?.['ag_provider_options']);
  const topProviderOpts = asPlainRecord(obj['ag_provider_options']);
  if (extraProviderOpts === undefined && topProviderOpts === undefined) return;

  const mergedNative: Record<string, Record<string, unknown>> = {
    ...(params.native ?? {}),
  };

  for (const source of [extraProviderOpts, topProviderOpts]) {
    if (source === undefined) continue;
    for (const [rawVendor, rawOpts] of Object.entries(source)) {
      const opts = asPlainRecord(rawOpts);
      if (opts === undefined) continue;
      const vendor = normalizeVendorKey(rawVendor);
      if (vendor === '') continue;
      mergedNative[vendor] = {
        ...(mergedNative[vendor] ?? {}),
        ...opts,
      };
    }
  }

  if (Object.keys(mergedNative).length > 0) {
    params.native = mergedNative;
  }
}

/** 由 `applyClientProviderOptions` 消费的网关扩展键，同格式回写 `raw.unmapped` 时不可透传给上游。 */
const CONSUMED_PROVIDER_OPTION_KEYS = new Set([
  'ag_provider_options',
  'safety_settings',
  'safetySettings',
]);

/**
 * 在同格式回写 `raw.unmapped` 前，剔除已被 `applyClientProviderOptions` 消费的网关扩展键，
 * 避免 `ag_provider_options` 等字段被原样发给严格校验的厂商上游导致 400。
 */
export function filterUnmappedForPassthrough(
  unmapped: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (unmapped === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unmapped)) {
    if (CONSUMED_PROVIDER_OPTION_KEYS.has(key)) continue;
    if (key === 'extra_body') {
      const extraRec = asPlainRecord(value);
      if (extraRec !== undefined) {
        const cleaned: Record<string, unknown> = {};
        for (const [ek, ev] of Object.entries(extraRec)) {
          if (!CONSUMED_PROVIDER_OPTION_KEYS.has(ek)) {
            cleaned[ek] = ev;
          }
        }
        if (Object.keys(cleaned).length > 0) {
          out[key] = cleaned;
        }
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export interface ApplyNativeVendorOptionsInput {
  native: Record<string, Record<string, unknown>> | undefined;
  acceptedVendors: readonly string[];
  body: Record<string, unknown>;
  protectedKeys: ReadonlySet<string>;
  mergeObjectKeys?: ReadonlySet<string>;
  sourceFormat: FormatId;
  targetFormat: FormatId;
  dropped: string[];
  warnings: string[];
  diagnostics: ConversionDiagnostic[];
}

/**
 * 在目标 adaptor 编码请求时，将 `params.native.<vendor>` 中属于当前目标厂商的字段
 * 合并进上游请求体；不属于当前目标厂商的命名空间记录 warning + diagnostic，避免静默污染。
 */
export function applyNativeVendorOptions(input: ApplyNativeVendorOptionsInput): void {
  const {
    native,
    acceptedVendors,
    body,
    protectedKeys,
    mergeObjectKeys,
    sourceFormat,
    targetFormat,
    dropped,
    warnings,
    diagnostics,
  } = input;

  if (native === undefined) return;

  for (const [vendor, opts] of Object.entries(native)) {
    if (opts === undefined || Object.keys(opts).length === 0) continue;

    if (!acceptedVendors.includes(vendor)) {
      const fieldPath = `params.native.${vendor}`;
      dropped.push(fieldPath);
      warnings.push(`native_options_ignored:${vendor}`);
      diagnostics.push({
        code: 'native_options_ignored',
        field_path: fieldPath,
        from: sourceFormat,
        to: targetFormat,
        level: 'warning',
        message: `${targetFormat} 不适用 ${vendor} 专有参数（${fieldPath}），已忽略`,
      });
      continue;
    }

    for (const [key, value] of Object.entries(opts)) {
      if (value === undefined || protectedKeys.has(key)) continue;
      const existing = body[key];
      if (mergeObjectKeys?.has(key) === true) {
        const existingRec = asPlainRecord(existing);
        const valueRec = asPlainRecord(value);
        if (existingRec !== undefined && valueRec !== undefined) {
          body[key] = { ...existingRec, ...valueRec };
          continue;
        }
      }
      body[key] = value;
    }
  }
}
