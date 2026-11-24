import type {
  AccessPathDto,
  CapabilityMatrixEntry,
  EnvCredentialPathDto,
  MaskedCredential,
  ProviderConfig,
} from './types.js';

export const AUTO_DISABLE_COUNTING_REASON = '连续失败计数中';

export function isProviderAutoDisabled(
  autoDisabled: ProviderConfig['auto_disabled'],
): boolean {
  return autoDisabled !== undefined && autoDisabled.reason !== AUTO_DISABLE_COUNTING_REASON;
}

export function deriveAccessPath(providerId: string, dialect: string): string {
  return `${providerId}.${dialect.replace('.', '-')}`;
}

export function providerIdFromAccessPath(accessPath: string): string {
  const dot = accessPath.indexOf('.');
  return dot === -1 ? accessPath : accessPath.slice(0, dot);
}

export function inferModelModality(modelId: string, capModality?: string): string {
  if (capModality && capModality !== 'chat') return capModality;
  const lower = modelId.toLowerCase();
  if (/(^|[-_/.])(asr|stt|whisper|transcribe)([-_/.]|$)/.test(lower)) return 'audio_stt';
  if (/(^|[-_/.])(tts|voiceclone|voicedesign|speech)([-_/.]|$)/.test(lower)) return 'audio_tts';
  if (/(^|[-_/.])(embed|embedding|embeddings|bge|text-embedding)([-_/.]|$)/.test(lower)) {
    return 'embedding';
  }
  if (/(^|[-_/.])(rerank|reranker)([-_/.]|$)/.test(lower)) return 'rerank';
  if (
    /(^|[-_/.])(imagen|dall-e|gpt-image|chatgpt-image|grok-imagine|flux|sdxl|wanx|kolors)([-_/.]|$)/.test(
      lower,
    )
  ) {
    return 'image';
  }
  return capModality ?? 'chat';
}

export interface AvailableModelOption {
  key: string;
  model: string;
  accessPath: string;
  providerId: string;
  providerLabel: string;
  modality: string;
  contextWindow?: number;
}

export interface SavedModelDiagnostic {
  model: string;
  accessPath: string;
  available: boolean;
  reason?: string;
}

export interface ModelAvailabilitySnapshot {
  options: AvailableModelOption[];
  emptyReason: 'no_channel' | 'no_credential' | null;
  hasPathCredential: (accessPath: string) => boolean;
  isChannelActive: (accessPath: string) => boolean;
  inspectSaved: (model: string, accessPath: string) => SavedModelDiagnostic;
}

/**
 * 计算当前真正可用的模型清单（97 §2.5 #3 & #4、§5 #5 & #6）：
 * - 选择器只列「已启用渠道 + 有可用凭据」的模型；
 * - 零可用时区分「去建渠道」或「去录凭据」；
 * - 已保存但当前不可用的值给出明确原因，不删用户数据、不放进下拉列表。
 */
export function computeModelAvailability(input: {
  providers: readonly ProviderConfig[];
  credentials?: readonly MaskedCredential[];
  envCredentials?: readonly EnvCredentialPathDto[];
  accessPaths: readonly AccessPathDto[];
  capabilities: readonly CapabilityMatrixEntry[];
  modalityFilter?: string;
}): ModelAvailabilitySnapshot {
  const {
    providers,
    credentials = [],
    envCredentials = [],
    accessPaths,
    capabilities,
    modalityFilter = 'chat',
  } = input;

  const accessPathMap = new Map<string, AccessPathDto>();
  for (const ap of accessPaths) {
    accessPathMap.set(ap.id, ap);
  }

  const envCredCount = new Map<string, number>();
  for (const ec of envCredentials) {
    if (ec.count > 0) envCredCount.set(ec.access_path, ec.count);
  }

  const storedCredCount = new Map<string, number>();
  for (const cred of credentials) {
    if (!cred.enabled || cred.health === 'error') continue;
    storedCredCount.set(cred.access_path, (storedCredCount.get(cred.access_path) ?? 0) + 1);
  }
  const providerHasKey = new Set<string>();
  for (const p of providers) {
    if (p.has_key === true && p.credential_health !== 'error') {
      providerHasKey.add(p.id);
      providerHasKey.add(deriveAccessPath(p.id, p.dialect));
    }
  }

  const hasPathCredential = (accessPath: string): boolean => {
    const apMeta = accessPathMap.get(accessPath);
    if (apMeta && !apMeta.requires_credential) return true;
    return (
      providerHasKey.has(accessPath) ||
      providerHasKey.has(providerIdFromAccessPath(accessPath)) ||
      (storedCredCount.get(accessPath) ?? 0) > 0 ||
      (envCredCount.get(accessPath) ?? 0) > 0
    );
  };

  // 建立渠道索引（按派生路径及厂商前缀匹配）
  const activeChannelsByPath = new Map<string, ProviderConfig>();
  const allChannelsByPath = new Map<string, ProviderConfig>();

  for (const p of providers) {
    const derived = deriveAccessPath(p.id, p.dialect);
    allChannelsByPath.set(derived, p);
    allChannelsByPath.set(p.id, p);
    const active = p.enabled && !isProviderAutoDisabled(p.auto_disabled);
    if (active) {
      activeChannelsByPath.set(derived, p);
      activeChannelsByPath.set(p.id, p);
    }
  }

  const findActiveProvider = (accessPath: string): ProviderConfig | undefined => {
    return (
      activeChannelsByPath.get(accessPath) ??
      activeChannelsByPath.get(providerIdFromAccessPath(accessPath))
    );
  };

  const findAnyProvider = (accessPath: string): ProviderConfig | undefined => {
    return (
      allChannelsByPath.get(accessPath) ??
      allChannelsByPath.get(providerIdFromAccessPath(accessPath))
    );
  };

  const isChannelActive = (accessPath: string): boolean => {
    return findActiveProvider(accessPath) !== undefined;
  };

  const seen = new Set<string>();
  const options: AvailableModelOption[] = [];
  const capModalityByKey = new Map<string, string>();
  for (const entry of capabilities) {
    capModalityByKey.set(`${entry.access_path}::${entry.model}`, entry.modality);
  }

  // 1. 从已启用渠道的静态模型列表收集
  for (const p of providers) {
    if (!p.enabled || isProviderAutoDisabled(p.auto_disabled)) continue;
    const ap = deriveAccessPath(p.id, p.dialect);
    if (!hasPathCredential(ap) && !hasPathCredential(p.id)) continue;
    if (p.model_source.kind === 'static') {
      for (const m of p.model_source.models) {
        const key = `${ap}::${m}`;
        const inferredMod = inferModelModality(m, capModalityByKey.get(key));
        if (modalityFilter && inferredMod !== modalityFilter) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({
          key,
          model: m,
          accessPath: ap,
          providerId: p.id,
          providerLabel: p.label,
          modality: inferredMod,
        });
      }
    }
  }

  // 2. 从能力矩阵合并（需要对应渠道已启用且有可用凭据）
  for (const entry of capabilities) {
    if (entry.internal || entry.availability === 'unconfigured') continue;
    const inferredMod = inferModelModality(entry.model, entry.modality);
    if (modalityFilter && inferredMod !== modalityFilter) continue;
    const activeProv = findActiveProvider(entry.access_path);
    if (!activeProv) continue;
    if (!hasPathCredential(entry.access_path) && !hasPathCredential(activeProv.id)) continue;
    const key = `${entry.access_path}::${entry.model}`;
    if (seen.has(key)) {
      const existing = options.find((o) => o.key === key);
      if (existing && entry.context_window !== undefined) {
        existing.contextWindow = entry.context_window;
      }
      continue;
    }
    seen.add(key);
    options.push({
      key,
      model: entry.model,
      accessPath: entry.access_path,
      providerId: activeProv.id,
      providerLabel: activeProv.label,
      modality: entry.modality,
      ...(entry.context_window === undefined ? {} : { contextWindow: entry.context_window }),
    });
  }

  const anyEnabledChannel = providers.some(
    (p) => p.enabled && !isProviderAutoDisabled(p.auto_disabled),
  );
  const emptyReason: 'no_channel' | 'no_credential' | null =
    options.length > 0 ? null : !anyEnabledChannel ? 'no_channel' : 'no_credential';

  const inspectSaved = (model: string, accessPath: string): SavedModelDiagnostic => {
    const matched = options.some(
      (o) =>
        o.model === model &&
        (o.accessPath === accessPath ||
          providerIdFromAccessPath(o.accessPath) === providerIdFromAccessPath(accessPath)),
    );
    if (matched) {
      return { model, accessPath, available: true };
    }
    const prov = findAnyProvider(accessPath);
    if (!prov) {
      return { model, accessPath, available: false, reason: '所属渠道尚未创建' };
    }
    if (!prov.enabled) {
      return { model, accessPath, available: false, reason: '所属渠道已停用' };
    }
    if (isProviderAutoDisabled(prov.auto_disabled)) {
      return { model, accessPath, available: false, reason: '所属渠道因连续错误已暂停' };
    }
    if (!hasPathCredential(accessPath) && !hasPathCredential(prov.id)) {
      return { model, accessPath, available: false, reason: '缺少可用凭据' };
    }
    return { model, accessPath, available: false, reason: '该模型不在当前渠道清单中' };
  };

  return {
    options,
    emptyReason,
    hasPathCredential,
    isChannelActive,
    inspectSaved,
  };
}
