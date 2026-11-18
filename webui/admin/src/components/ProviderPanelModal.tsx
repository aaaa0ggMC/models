import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { adminApi, classifyErrorCode, type ActionableError } from '../api/client.js';
import type {
  ChannelPricingConfig,
  PresetDialect,
  ProviderConfig,
  ProviderPreset,
  UpstreamModelCategory,
  UpstreamModelDto,
} from '../api/types.js';
import { helpHref, navigate } from '../router.js';
import { ErrorBanner, Modal, StatusBadge, Switch } from './ui.js';
import {
  GroupedModelTable,
  MODEL_CATEGORY_LABELS,
  MODEL_CATEGORY_ORDER,
  resolveModelCategory,
} from './GroupedModelTable.js';
import { ProviderIcon } from './ProviderIcon.js';

interface CapabilityStatusRow {
  feature: string;
  state: 'implemented' | 'unimplemented' | 'planned';
  detail: string;
}

/**
 * 各服务商能力状态只读卡片（97 §2.2 #5 & §5 #7：三态只读展示，绝不给后端没有的配置面画假开关）。
 */
function getProviderCapabilities(presetId: string): CapabilityStatusRow[] {
  switch (presetId) {
    case 'deepseek':
      return [
        { feature: '对话生成与思考链', state: 'implemented', detail: '支持流式与思考档位映射' },
        { feature: '内置联网搜索与网页读取', state: 'implemented', detail: '支持服务端注入与按需调用' },
        { feature: '语音合成 / 语音识别 / 视觉识别', state: 'implemented', detail: '已接入工具端点与音频路由' },
      ];
    case 'mimo':
    case 'mimo-plan-eu':
    case 'mimo-api':
      return [
        { feature: '对话生成与思考正文', state: 'implemented', detail: '兼容端点含思考输出' },
        { feature: '语音合成与语音识别', state: 'implemented', detail: '按模型名分发至音频链路' },
      ];
    case 'openai':
      return [
        { feature: '对话与 Responses 协议', state: 'implemented', detail: '支持双向协议转换' },
        { feature: '向量嵌入与图片生成', state: 'implemented', detail: '编码层已就绪，需对应凭据' },
        { feature: '实时双向语音', state: 'planned', detail: '二期规划中' },
      ];
    case 'anthropic':
      return [
        { feature: 'Messages 对话与工具调用', state: 'implemented', detail: '支持思考块与多轮工具' },
        { feature: '提示词缓存统计细分', state: 'unimplemented', detail: '计量层尚未拆分缓存读写桶' },
      ];
    default:
      return [
        { feature: '基础对话与工具调用', state: 'implemented', detail: '通过标准协议编码器接入' },
        { feature: '专项多模态扩展', state: 'planned', detail: '视上游文档与实测逐步开放' },
      ];
  }
}

const DIALECT_LABELS: Record<PresetDialect, string> = {
  'openai.chat': 'OpenAI Chat 兼容',
  'openai.responses': 'OpenAI Responses',
  'anthropic.messages': 'Anthropic Messages',
  'gemini.generateContent': 'Gemini generateContent',
};

function toggleGroupModels(
  models: UpstreamModelDto[],
  selectedModels: Set<string>,
  setSelectedModels: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const allChecked = models.every((m) => selectedModels.has(m.id));
  setSelectedModels((prev) => {
    const next = new Set(prev);
    for (const m of models) {
      if (allChecked) next.delete(m.id);
      else next.add(m.id);
    }
    return next;
  });
}

function uniqueProviderId(baseId: string, existingIds?: readonly string[]): string {
  const existing = new Set((existingIds ?? []).map((s) => s.toLowerCase()));
  const clean = baseId.toLowerCase();
  if (!existing.has(clean)) return clean;
  let idx = 2;
  while (existing.has(`${clean}-${idx}`)) {
    idx += 1;
  }
  return `${clean}-${idx}`;
}

export function ProviderPanelModal({
  open,
  editingProvider,
  presets,
  existingProviderIds,
  hasCredentialForProvider,
  onClose,
  onSaved,
}: {
  open: boolean;
  editingProvider: ProviderConfig | null;
  presets: readonly ProviderPreset[];
  existingProviderIds?: readonly string[];
  hasCredentialForProvider: (providerId: string) => boolean;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element | null {
  const isEdit = editingProvider !== null;

  const [step, setStep] = useState<'select' | 'configure'>(isEdit ? 'configure' : 'select');
  const [presetSearch, setPresetSearch] = useState<string>('');
  const [presetGroupFilter, setPresetGroupFilter] = useState<'all' | '国际' | '国内'>('all');

  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [selectedPathId, setSelectedPathId] = useState<string>('');
  const [customId, setCustomId] = useState<string>('');
  const [label, setLabel] = useState<string>('');
  const [dialect, setDialect] = useState<PresetDialect>('openai.chat');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [envRef, setEnvRef] = useState<string>('');
  const [useEnvRef, setUseEnvRef] = useState<boolean>(false);
  const [useOAuth, setUseOAuth] = useState<boolean>(false);
  const [oauthLoading, setOauthLoading] = useState<boolean>(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthLink, setOauthLink] = useState<string>('');
  const [oauthUserCode, setOauthUserCode] = useState<string>('');
  const [oauthQrDataUrl, setOauthQrDataUrl] = useState<string>('');
  const [oauthStatusText, setOauthStatusText] = useState<string>('');
  const [oauthDone, setOauthDone] = useState<boolean>(false);
  const [pkceCodeInput, setPkceCodeInput] = useState<string>('');
  const [copiedOAuthCode, setCopiedOAuthCode] = useState<boolean>(false);
  const [replaceCredentialMode, setReplaceCredentialMode] = useState<boolean>(false);
  const oauthPollRef = useRef<number | null>(null);
  const [namespace, setNamespace] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [enabled, setEnabled] = useState<boolean>(true);
  const [webSearchDefault, setWebSearchDefault] = useState<boolean>(false);
  const [urlContextDefault, setUrlContextDefault] = useState<boolean>(false);
  const [autoDiscoveryMode, setAutoDiscoveryMode] = useState<boolean>(false);
  const [pricingMultiplier, setPricingMultiplier] = useState<string>('');
  const [pricingCurrency, setPricingCurrency] = useState<string>('USD');
  const [pricingModelsJson, setPricingModelsJson] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);

  // 模型清单与拉取状态
  const [fetchedModels, setFetchedModels] = useState<UpstreamModelDto[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [modelSearch, setModelSearch] = useState<string>('');
  const [modelCategoryFilter, setModelCategoryFilter] = useState<'all' | UpstreamModelCategory>('all');
  const [fetchingModels, setFetchingModels] = useState<boolean>(false);
  const [syncingModelsDev, setSyncingModelsDev] = useState<boolean>(false);
  const [modelsDevMatched, setModelsDevMatched] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<ActionableError | null>(null);
  const [metadataIncomplete, setMetadataIncomplete] = useState<boolean>(false);
  const [hasFetchedOnce, setHasFetchedOnce] = useState<boolean>(false);
  const [manualModelInput, setManualModelInput] = useState<string>('');

  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<ActionableError | null>(null);

  function detectOAuthKind(
    idStr: string,
    urlStr: string,
  ): 'openai-codex' | 'xai' | 'openrouter' | null {
    const id = idStr.toLowerCase();
    const url = urlStr.toLowerCase();
    if (id === 'openai-codex' || id.startsWith('openai-codex-') || url.includes('chatgpt.com/backend-api')) {
      return 'openai-codex';
    }
    if (id === 'xai' || id.startsWith('xai-') || url.includes('api.x.ai')) {
      return 'xai';
    }
    if (id === 'openrouter' || id.startsWith('openrouter-') || url.includes('openrouter.ai')) {
      return 'openrouter';
    }
    return null;
  }

  function resetInlineOAuth() {
    if (oauthPollRef.current !== null) {
      window.clearTimeout(oauthPollRef.current);
      oauthPollRef.current = null;
    }
    setOauthLoading(false);
    setOauthError(null);
    setOauthSessionId(null);
    setOauthLink('');
    setOauthUserCode('');
    setOauthQrDataUrl('');
    setOauthStatusText('');
    setOauthDone(false);
    setPkceCodeInput('');
    setCopiedOAuthCode(false);
  }

  useEffect(() => {
    return () => {
      if (oauthPollRef.current !== null) {
        window.clearTimeout(oauthPollRef.current);
      }
    };
  }, []);

  const currentPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  const inlineOAuthKind = useMemo(
    () => detectOAuthKind(selectedPresetId || customId, baseUrl),
    [selectedPresetId, customId, baseUrl],
  );

  // 初始化表单状态
  useEffect(() => {
    if (!open) {
      resetInlineOAuth();
      return;
    }
    resetInlineOAuth();
    setUseOAuth(false);
    setUseEnvRef(false);
    setReplaceCredentialMode(false);
    setFetchError(null);
    setSaveError(null);
    setModelSearch('');
    setModelCategoryFilter('all');
    setHasFetchedOnce(false);
    setMetadataIncomplete(false);
    setModelsDevMatched(null);
    setApiKey('');
    setEnvRef('');
    setUseEnvRef(false);
    setPresetSearch('');
    setPresetGroupFilter('all');

    if (editingProvider) {
      setStep('configure');
      const matchedPreset = presets.find(
        (p) =>
          p.id === editingProvider.id ||
          p.access_paths.some((ap) => ap.base_url === editingProvider.base_url),
      );
      setSelectedPresetId(matchedPreset ? matchedPreset.id : 'custom');
      setCustomId(editingProvider.id);
      setLabel(editingProvider.label);
      setDialect(editingProvider.dialect);
      setBaseUrl(editingProvider.base_url);
      setNamespace(editingProvider.namespace ?? '');
      setNote(editingProvider.note ?? '');
      setEnabled(editingProvider.enabled);
      setWebSearchDefault(Boolean(editingProvider.builtin_tools?.web_search));
      setUrlContextDefault(Boolean(editingProvider.builtin_tools?.url_context));
      setPricingMultiplier(
        editingProvider.pricing?.multiplier !== undefined
          ? String(editingProvider.pricing.multiplier)
          : '',
      );
      setPricingCurrency(editingProvider.pricing?.currency ?? 'USD');
      setPricingModelsJson(
        editingProvider.pricing?.models && Object.keys(editingProvider.pricing.models).length > 0
          ? JSON.stringify(editingProvider.pricing.models, null, 2)
          : '',
      );
      setShowAdvanced(Boolean(editingProvider.namespace || editingProvider.pricing));

      if (editingProvider.model_source.kind === 'static') {
        const savedList = editingProvider.model_source.models;
        const meta = editingProvider.model_metadata ?? {};
        setFetchedModels(savedList.map((id) => meta[id] ?? { id }));
        setSelectedModels(new Set(savedList));
        setAutoDiscoveryMode(false);
      } else {
        setFetchedModels([]);
        setSelectedModels(new Set());
        setAutoDiscoveryMode(true);
      }
    } else {
      setStep('select');
      setSelectedPresetId('');
      setCustomId('');
      setLabel('');
      setDialect('openai.chat');
      setBaseUrl('');
      setPricingMultiplier('');
      setPricingCurrency('USD');
      setPricingModelsJson('');
      setFetchedModels([]);
      setSelectedModels(new Set());
    }
  }, [open, editingProvider, presets]);

  function applyPreset(preset: ProviderPreset, pathId?: string) {
    resetInlineOAuth();
    setSelectedPresetId(preset.id);
    const pathObj =
      preset.access_paths.find((p) => p.id === pathId) ?? preset.access_paths[0];
    setSelectedPathId(pathObj?.id ?? '');
    const nextId = uniqueProviderId(preset.id, existingProviderIds);
    setCustomId(nextId);
    setLabel(
      nextId === preset.id
        ? preset.name
        : `${preset.name} #${nextId.slice(preset.id.length + 1)}`,
    );
    setDialect(pathObj?.dialect ?? 'openai.chat');
    setBaseUrl(pathObj?.base_url ?? '');
    setUseEnvRef(false);
    setUseOAuth(preset.id === 'openai-codex');
    setApiKey('');
    setNamespace('');
    setModelSearch('');
    setModelCategoryFilter('all');
    setNote('');
    setEnabled(true);
    setWebSearchDefault(false);
    setUrlContextDefault(false);
    setAutoDiscoveryMode(false);
    setPricingMultiplier('');
    setPricingCurrency('USD');
    setPricingModelsJson('');
    setShowAdvanced(false);
    const defaults = pathObj?.default_models ?? [];
    setFetchedModels(defaults.map((id) => ({ id })));
    setSelectedModels(new Set(defaults));
    setHasFetchedOnce(false);
    setFetchError(null);
  }

  function handleSelectAccessPath(pathId: string) {
    if (!currentPreset) return;
    const pathObj = currentPreset.access_paths.find((p) => p.id === pathId);
    if (!pathObj) return;
    setSelectedPathId(pathObj.id);
    setDialect(pathObj.dialect);
    setBaseUrl(pathObj.base_url);
    if (!isEdit && !hasFetchedOnce) {
      setFetchedModels(pathObj.default_models.map((id) => ({ id })));
      setSelectedModels(new Set(pathObj.default_models));
    }
  }

  // 编辑模式下原有的模型集合（用于对比「新增 / 已有 / 已移除」，97 §2.2 #3）
  const previousSavedModels = useMemo(() => {
    if (!editingProvider || editingProvider.model_source.kind !== 'static') {
      return new Set<string>();
    }
    return new Set(editingProvider.model_source.models);
  }, [editingProvider]);

  async function handleStartInlineOAuth() {
    if (!inlineOAuthKind) return;
    resetInlineOAuth();
    setOauthLoading(true);
    try {
      if (inlineOAuthKind === 'openrouter') {
        const res = await adminApi.startOpenRouterPkce(`${window.location.origin}/admin/`);
        setOauthSessionId(res.session_id);
        setOauthLink(res.auth_url);
        setOauthQrDataUrl(await QRCode.toDataURL(res.auth_url, { width: 168, margin: 1 }));
        setOauthStatusText('请授权并回填');
        setOauthLoading(false);
        return;
      }

      const res = await adminApi.startDeviceOAuth(inlineOAuthKind);
      const link = res.verification_uri_complete ?? res.verification_uri;
      setOauthSessionId(res.session_id);
      setOauthLink(link);
      setOauthUserCode(res.user_code);
      setOauthQrDataUrl(await QRCode.toDataURL(link, { width: 168, margin: 1 }));
      setOauthStatusText('等待扫码授权…');
      setOauthLoading(false);

      const targetId = customId.trim() || selectedPresetId || inlineOAuthKind;
      const derivedPath = `${targetId}.${dialect.replace('.', '-')}`;
      const schedulePoll = (delaySec: number) => {
        oauthPollRef.current = window.setTimeout(async () => {
          try {
            const pollRes = await adminApi.pollDeviceOAuth({
              session_id: res.session_id,
              provider: targetId,
              access_path: derivedPath,
              save: false,
            });
            if (pollRes.status === 'complete' && pollRes.secret) {
              setApiKey(pollRes.secret);
              setOauthDone(true);
              setOauthStatusText('已完成授权');
              return;
            }
            if (pollRes.status === 'expired' || pollRes.status === 'failed') {
              setOauthError(pollRes.message);
              setOauthStatusText('');
              return;
            }
            const nextSec =
              pollRes.status === 'slow_down' ? (pollRes.interval_seconds ?? delaySec) : delaySec;
            schedulePoll(nextSec);
          } catch (err) {
            setOauthError(err instanceof Error ? err.message : '轮询失败');
          }
        }, delaySec * 1000);
      };
      schedulePoll(Math.max(2, res.interval_seconds));
    } catch (err) {
      setOauthLoading(false);
      setOauthError(err instanceof Error ? err.message : '发起授权失败');
    }
  }

  async function handleConfirmInlinePkce() {
    if (!oauthSessionId || !pkceCodeInput.trim()) return;
    setOauthLoading(true);
    setOauthError(null);
    try {
      const targetId = customId.trim() || selectedPresetId || 'openrouter';
      const derivedPath = `${targetId}.${dialect.replace('.', '-')}`;
      const res = await adminApi.exchangeOpenRouterPkce({
        session_id: oauthSessionId,
        code_or_url: pkceCodeInput.trim(),
        provider: targetId,
        access_path: derivedPath,
        save: false,
      });
      if (res.secret) {
        setApiKey(res.secret);
        setOauthDone(true);
        setOauthStatusText('已完成授权');
      }
    } catch (err) {
      setOauthError(err instanceof Error ? err.message : '换取失败');
    } finally {
      setOauthLoading(false);
    }
  }

  async function handleFetchModels() {
    if (!baseUrl.trim()) {
      setFetchError({
        category: '缺少地址',
        message: '请先填写上游地址',
      });
      return;
    }
    if (!isEdit && !apiKey.trim()) {
      setFetchError({
        category: '缺少密钥',
        // ui-copy: allow 预览拉取模型的必要操作反馈
        message: '请先填写上方密钥以拉取上游模型清单',
      });
      return;
    }

    setFetchingModels(true);
    setFetchError(null);
    try {
      const targetId = isEdit ? editingProvider.id : customId.trim() || selectedPresetId;
      const res = await adminApi.fetchProviderModels({
        base_url: baseUrl.trim(),
        dialect,
        ...(isEdit ? { provider_id: targetId } : { api_key: apiKey.trim() }), // privacy-scan: ignore —— 预览拉取模型的请求体内存字段
      });

      if (!res.ok) {
        setFetchError(
          classifyErrorCode(res.error.code, res.error.message, res.error.detail),
        );
        return;
      }

      const isFirstCreateFetch = !isEdit && !hasFetchedOnce && selectedModels.size === 0;
      setHasFetchedOnce(true);
      setMetadataIncomplete(res.metadata_incomplete);

      // 合并上游返回的模型与编辑态已存/已勾选但上游未返回的模型
      const upstreamIds = new Set(res.models.map((m) => m.id));
      const merged: UpstreamModelDto[] = [...res.models];
      const extraIds = new Set<string>([...previousSavedModels, ...selectedModels]);
      for (const oldId of extraIds) {
        if (!upstreamIds.has(oldId)) {
          merged.push({ id: oldId });
        }
      }
      setFetchedModels(merged);
      // 仅首次新建拉取时默认全选；编辑态或已有勾选时保留既有选择
      if (isFirstCreateFetch) {
        setSelectedModels(new Set(res.models.map((m) => m.id)));
      }
    } catch (err) {
      setFetchError({
        category: '网络异常',
        message: err instanceof Error ? err.message : '拉取失败',
      });
    } finally {
      setFetchingModels(false);
    }
  }

  async function handleSyncModelsDev() {
    if (fetchedModels.length === 0) return;
    setSyncingModelsDev(true);
    setFetchError(null);
    try {
      const res = await adminApi.syncModelsDev(fetchedModels);
      if (!res.ok) {
        setFetchError({
          category: '网络异常',
          message: res.error.message,
        });
        return;
      }
      setFetchedModels(res.models);
      setMetadataIncomplete(res.metadata_incomplete);
      setModelsDevMatched(res.matched_count);
    } catch (err) {
      setFetchError({
        category: '网络异常',
        message: err instanceof Error ? err.message : '同步失败',
      });
    } finally {
      setSyncingModelsDev(false);
    }
  }

  const upstreamFetchedIdSet = useMemo(() => {
    return new Set(fetchedModels.map((m) => m.id));
  }, [fetchedModels]);

  const availableCategories = useMemo(() => {
    const present = new Set<UpstreamModelCategory>(
      fetchedModels.map((m) => resolveModelCategory(m)),
    );
    return MODEL_CATEGORY_ORDER.filter((cat) => present.has(cat));
  }, [fetchedModels]);

  const filteredModels = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return fetchedModels.filter((m) => {
      if (modelCategoryFilter !== 'all' && resolveModelCategory(m) !== modelCategoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q))
      );
    });
  }, [fetchedModels, modelSearch, modelCategoryFilter]);

  const groupedModels = useMemo(() => {
    const groups = new Map<UpstreamModelCategory, UpstreamModelDto[]>();
    for (const cat of MODEL_CATEGORY_ORDER) {
      groups.set(cat, []);
    }
    for (const m of filteredModels) {
      const cat = resolveModelCategory(m);
      groups.get(cat)!.push(m);
    }
    return MODEL_CATEGORY_ORDER
      .map((cat) => ({ category: cat, models: groups.get(cat)! }))
      .filter((g) => g.models.length > 0);
  }, [filteredModels]);

  function toggleModel(id: string) {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const m of filteredModels) next.add(m.id);
      return next;
    });
  }

  function deselectAllFiltered() {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const m of filteredModels) next.delete(m.id);
      return next;
    });
  }

  const allFilteredSelected =
    filteredModels.length > 0 && filteredModels.every((m) => selectedModels.has(m.id));
  const anyFilteredSelected = filteredModels.some((m) => selectedModels.has(m.id));

  function handleAddManualModel() {
    const m = manualModelInput.trim();
    if (!m) return;
    if (!fetchedModels.some((item) => item.id === m)) {
      setFetchedModels((prev) => [...prev, { id: m }]);
    }
    setSelectedModels((prev) => new Set(prev).add(m));
    setManualModelInput('');
  }

  async function handleSave() {
    const rawId = (isEdit ? editingProvider.id : customId.trim() || selectedPresetId).toLowerCase();
    const finalId = isEdit ? rawId : uniqueProviderId(rawId, existingProviderIds);
    const finalLabel = label.trim() || currentPreset?.name || finalId;
    if (!finalId || !baseUrl.trim()) {
      setSaveError({
        category: '参数不完整',
        message: '请填写渠道标识与上游地址',
      });
      return;
    }

    const modelsArray = Array.from(selectedModels);
    if (!autoDiscoveryMode && modelsArray.length === 0) {
      setSaveError({
        category: '未选择模型',
        message: '请至少勾选一个模型',
      });
      return;
    }

    let parsedPricing: ChannelPricingConfig | undefined;
    const rawMultiplier = pricingMultiplier.trim();
    const rawModelsJson = pricingModelsJson.trim();
    const hasMultiplier = rawMultiplier !== '';
    const hasModelsJson = rawModelsJson !== '';
    if (hasMultiplier || hasModelsJson || pricingCurrency !== 'USD') {
      parsedPricing = {};
      if (hasMultiplier) {
        const m = Number(rawMultiplier);
        if (!Number.isFinite(m) || m < 0) {
          setSaveError({ category: '参数格式有误', message: '渠道倍率须为非负数字' });
          return;
        }
        parsedPricing.multiplier = m;
      }
      if (pricingCurrency.trim()) {
        parsedPricing.currency = pricingCurrency.trim().toUpperCase();
      }
      if (hasModelsJson) {
        try {
          const parsed = JSON.parse(rawModelsJson) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            setSaveError({ category: '参数格式有误', message: '单价表须为 JSON 对象' });
            return;
          }
          parsedPricing.models = parsed as ChannelPricingConfig['models'];
        } catch {
          setSaveError({ category: '参数格式有误', message: '单价表 JSON 解析失败' });
          return;
        }
      }
    }

    setSaving(true);
    setSaveError(null);
    try {
      const modelMetadata: Record<string, UpstreamModelDto> = {};
      if (!autoDiscoveryMode) {
        const byId = new Map(fetchedModels.map((m) => [m.id, m]));
        for (const id of modelsArray) {
          const found = byId.get(id);
          if (found) modelMetadata[id] = found;
        }
      }
      await adminApi.upsertProvider({
        id: finalId,
        label: finalLabel,
        dialect,
        base_url: baseUrl.trim(),
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        model_source: autoDiscoveryMode
          ? { kind: 'discovery', path: '/models' }
          : { kind: 'static', models: modelsArray },
        ...(Object.keys(modelMetadata).length > 0 ? { model_metadata: modelMetadata } : {}),
        ...(selectedPresetId === 'deepseek' || finalId === 'deepseek'
          ? {
              builtin_tools: {
                web_search: webSearchDefault,
                url_context: urlContextDefault,
              },
            }
          : {}),
        ...(parsedPricing !== undefined ? { pricing: parsedPricing } : {}),
        enabled,
        ...(note.trim() ? { note: note.trim() } : {}),
      });

      // 新建模式或编辑模式开启「更换密钥」时，先清理该渠道名下旧凭据（防止同名重建残留旧凭据）再写入新路径
      if ((!isEdit || replaceCredentialMode) && (apiKey.trim() || (useEnvRef && envRef.trim()))) {
        const oldCreds = await adminApi.listCredentials(finalId);
        for (const c of oldCreds.items.filter((x) => x.provider === finalId)) {
          await adminApi.deleteCredential(c.id);
        }
        const derivedPath = `${finalId}.${dialect.replace('.', '-')}`;
        const pathsToSave = new Set<string>([derivedPath]);
        if (currentPreset && (currentPreset.id === finalId || currentPreset.id === selectedPresetId)) {
          for (const ap of currentPreset.access_paths) {
            const mapped = ap.id.startsWith(`${currentPreset.id}.`)
              ? `${finalId}${ap.id.slice(currentPreset.id.length)}`
              : ap.id;
            pathsToSave.add(mapped);
          }
        }
        if (finalId === 'openai' || selectedPresetId === 'openai') {
          pathsToSave.add('openai.images');
        }
        for (const ap of pathsToSave) {
          await adminApi.createCredential({
            provider: finalId,
            access_path: ap,
            ...(useEnvRef
              ? { env_ref: envRef.trim().startsWith('env:') ? envRef.trim() : `env:${envRef.trim()}` }
              : { secret: apiKey.trim() }), // privacy-scan: ignore —— 内存变量传递给创建接口
          });
        }
      }

      onSaved();
      onClose();
    } catch (err) {
      setSaveError({
        category: '保存失败',
        message: err instanceof Error ? err.message : '保存未成功',
      });
    } finally {
      setSaving(false);
    }
  }

  const filteredPresets = useMemo(() => {
    const q = presetSearch.trim().toLowerCase();
    return presets.filter((p) => {
      if (presetGroupFilter !== 'all') {
        const isIntl = p.group === '国际';
        if (presetGroupFilter === '国际' && !isIntl) return false;
        if (presetGroupFilter === '国内' && isIntl) return false;
      }
      if (!q) return true;
      if (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.note && p.note.toLowerCase().includes(q))
      ) {
        return true;
      }
      return p.access_paths.some(
        (ap) =>
          ap.label.toLowerCase().includes(q) ||
          ap.base_url.toLowerCase().includes(q) ||
          ap.dialect.toLowerCase().includes(q),
      );
    });
  }, [presets, presetSearch, presetGroupFilter]);

  function openCustomConfigure() {
    setSelectedPresetId('custom');
    setSelectedPathId('');
    setCustomId('');
    setLabel('');
    setDialect('openai.chat');
    setBaseUrl('');
    setNamespace('');
    setNote('');
    setEnabled(true);
    setWebSearchDefault(false);
    setUrlContextDefault(false);
    setAutoDiscoveryMode(false);
    setPricingMultiplier('');
    setPricingCurrency('USD');
    setPricingModelsJson('');
    setFetchedModels([]);
    setSelectedModels(new Set());
    setHasFetchedOnce(false);
    setFetchError(null);
    setShowAdvanced(true);
    setStep('configure');
  }

  return (
    <Modal
      open={open}
      large
      title={
        isEdit
          ? `编辑渠道 · ${editingProvider.label}`
          : step === 'select'
            ? '选择上游服务商'
            : currentPreset
              ? `接入 · ${currentPreset.name}`
              : '接入自定义服务商'
      }
      onClose={onClose}
      footer={
        step === 'select' && !isEdit ? (
          <button type="button" className="ag-btn" onClick={onClose}>
            取消
          </button>
        ) : (
          <>
            {!isEdit && (
              <button
                type="button"
                className="ag-btn"
                onClick={() => setStep('select')}
                disabled={saving}
                style={{ marginRight: 'auto' }}
              >
                ← 重选服务商
              </button>
            )}
            <button type="button" className="ag-btn" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存渠道'}
            </button>
          </>
        )
      }
    >
      {step === 'select' && !isEdit ? (
        <div key="select" className="ag-step-enter" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <input
              className="ag-input"
              style={{ flex: '1 1 220px' }}
              value={presetSearch}
              onChange={(e) => setPresetSearch(e.target.value)}
              placeholder="搜索服务商…"
              autoFocus
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {(['all', '国际', '国内'] as const).map((grp) => (
                <button
                  key={grp}
                  type="button"
                  className={`ag-btn ag-btn-sm${presetGroupFilter === grp ? ' ag-btn-primary' : ''}`}
                  onClick={() => setPresetGroupFilter(grp)}
                >
                  {grp === 'all' ? '全部' : grp}
                </button>
              ))}
              <a className="ag-help-link" href={helpHref('channels')} style={{ marginLeft: 4 }}>
                预设说明 →
              </a>
            </div>
          </div>

          {filteredPresets.length === 0 ? (
            <div
              style={{
                padding: '28px 16px',
                textAlign: 'center',
                border: '1px dashed var(--ag-border)',
                borderRadius: 'var(--ag-radius-md)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span className="ag-secondary">未找到匹配的服务商</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => {
                    setPresetSearch('');
                    setPresetGroupFilter('all');
                  }}
                >
                  清空筛选
                </button>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm ag-btn-primary"
                  onClick={openCustomConfigure}
                >
                  自定义服务商
                </button>
              </div>
            </div>
          ) : (
            <div className="ag-provider-list">
              {filteredPresets.map((p) => {
                const defaultPath =
                  p.access_paths.find((ap) => ap.id === p.default_access_path) ??
                  p.access_paths[0];
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="ag-provider-row"
                    onClick={() => {
                      applyPreset(p, p.default_access_path ?? p.access_paths[0]?.id);
                      setStep('configure');
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <ProviderIcon providerId={p.id} name={p.name} size={32} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: 14 }}>{p.name}</strong>
                          <span className="ag-secondary" style={{ fontSize: 12 }}>
                            {p.group}
                          </span>
                        </div>
                        {defaultPath && (
                          <div className="ag-mono ag-secondary" style={{ fontSize: 12 }}>
                            {defaultPath.base_url}
                          </div>
                        )}
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexShrink: 0,
                        flexWrap: 'wrap',
                        justifyContent: 'flex-end',
                      }}
                    >
                      {defaultPath && (
                        <span className="ag-secondary" style={{ fontSize: 12 }}>
                          {DIALECT_LABELS[defaultPath.dialect]}
                        </span>
                      )}
                      {p.access_paths.length > 1 && (
                        <span className="ag-secondary" style={{ fontSize: 12 }}>
                          {p.access_paths.length} 条端点
                        </span>
                      )}
                      {p.needs_verification ? (
                        <StatusBadge tone="warning">待验证</StatusBadge>
                      ) : (
                        <StatusBadge tone="success">已实测</StatusBadge>
                      )}
                      <span className="ag-secondary" aria-hidden="true">
                        →
                      </span>
                    </div>
                  </button>
                );
              })}

              <button
                type="button"
                className="ag-provider-row ag-provider-row-custom"
                onClick={openCustomConfigure}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <ProviderIcon providerId="custom" name="+" size={32} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <strong style={{ fontSize: 14 }}>自定义服务商</strong>
                    <span className="ag-secondary" style={{ fontSize: 12 }}>
                      手动填写协议与地址
                    </span>
                  </div>
                </div>
                <span className="ag-secondary" aria-hidden="true">
                  →
                </span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div key="configure" className="ag-step-enter" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ErrorBanner error={saveError} onDismiss={() => setSaveError(null)} />

          {/* 1. 服务商专属信息卡（官方链接、验证状态、协议端点切换） */}
      {currentPreset && (
        <div
          style={{
            padding: 16,
            borderRadius: 'var(--ag-radius-md)',
            background: 'var(--ag-surface-raised)',
            border: '1px solid var(--ag-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ProviderIcon providerId={currentPreset.id} name={currentPreset.name} size={30} />
              <strong style={{ fontSize: 15 }}>{currentPreset.name}</strong>
              {currentPreset.needs_verification ? (
                <StatusBadge tone="warning">待验证</StatusBadge>
              ) : (
                <StatusBadge tone="success">已实测</StatusBadge>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <a
                className="ag-help-link"
                href={currentPreset.docs}
                target="_blank"
                rel="noreferrer"
              >
                官方文档 ↗
              </a>
              <a
                className="ag-help-link"
                href={currentPreset.homepage}
                target="_blank"
                rel="noreferrer"
              >
                控制台 ↗
              </a>
            </div>
          </div>

          {currentPreset.note && <div className="ag-secondary">{currentPreset.note}</div>}

          {currentPreset.access_paths.length > 1 && (
            <div className="ag-field" style={{ marginTop: 4 }}>
              <div className="ag-field-label">
                <span>接入端点</span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {currentPreset.access_paths.map((ap) => (
                  <button
                    key={ap.id}
                    type="button"
                    className={`ag-btn ag-btn-sm${selectedPathId === ap.id || dialect === ap.dialect ? ' ag-btn-primary' : ''}`}
                    onClick={() => handleSelectAccessPath(ap.id)}
                  >
                    <span>{ap.label}</span>
                    <span className="ag-mono" style={{ opacity: 0.8 }}>
                      ({ap.base_url})
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3. 自定义模式基础字段（预设模式下自动带出，不干扰视线） */}
      {selectedPresetId === 'custom' && (
        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">渠道标识</label>
            <input
              className="ag-input ag-mono"
              value={customId}
              disabled={isEdit}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder="例如 my-provider"
            />
          </div>
          <div className="ag-field">
            <label className="ag-field-label">显示名称</label>
            <input
              className="ag-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="例如 自建推理节点"
            />
          </div>
          <div className="ag-field">
            <label className="ag-field-label">协议类型</label>
            <select
              className="ag-select"
              value={dialect}
              onChange={(e) => setDialect(e.target.value as PresetDialect)}
            >
              {(Object.keys(DIALECT_LABELS) as PresetDialect[]).map((k) => (
                <option key={k} value={k}>
                  {DIALECT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="ag-field">
            <label className="ag-field-label">上游地址</label>
            <input
              className="ag-input ag-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </div>
        </div>
      )}

      {/* 4. 凭据区（创建时录入；编辑模式支持一键展开直接更换密钥） */}
      <div className="ag-field">
        <div className="ag-field-label">
          <span>上游密钥</span>
          {(!isEdit || replaceCredentialMode) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`ag-btn ag-btn-sm ${!useEnvRef && !useOAuth ? 'ag-btn-primary' : ''}`}
                onClick={() => {
                  resetInlineOAuth();
                  setUseOAuth(false);
                  setUseEnvRef(false);
                }}
              >
                API Key
              </button>
              <button
                type="button"
                className={`ag-btn ag-btn-sm ${useEnvRef && !useOAuth ? 'ag-btn-primary' : ''}`}
                onClick={() => {
                  resetInlineOAuth();
                  setUseOAuth(false);
                  setUseEnvRef(true);
                }}
              >
                环境变量
              </button>
              {inlineOAuthKind !== null && (
                <button
                  type="button"
                  className={`ag-btn ag-btn-sm ${useOAuth ? 'ag-btn-primary' : ''}`}
                  onClick={() => {
                    resetInlineOAuth();
                    setUseEnvRef(false);
                    setUseOAuth(true);
                  }}
                >
                  OAuth 登录
                </button>
              )}
              {isEdit && (
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => {
                    resetInlineOAuth();
                    setApiKey('');
                    setEnvRef('');
                    setUseOAuth(false);
                    setUseEnvRef(false);
                    setReplaceCredentialMode(false);
                  }}
                >
                  取消更换
                </button>
              )}
            </div>
          )}
        </div>
        {isEdit && !replaceCredentialMode ? (
          <div
            style={{
              height: 40,
              padding: '0 14px',
              borderRadius: 'var(--ag-radius-sm)',
              background: 'var(--ag-surface-raised)',
              border: '1px solid var(--ag-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {hasCredentialForProvider(editingProvider.id) ? (
                <StatusBadge tone="success">已录入</StatusBadge>
              ) : (
                <StatusBadge tone="warning">未录入</StatusBadge>
              )}
              <span className="ag-secondary">已存密钥不回显</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="ag-btn ag-btn-sm ag-btn-primary"
                onClick={() => setReplaceCredentialMode(true)}
              >
                更换密钥
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => {
                  onClose();
                  navigate('credentials');
                }}
              >
                去凭据页管理 →
              </button>
            </div>
          </div>
        ) : useOAuth && inlineOAuthKind !== null ? (
          <div
            style={{
              border: '1px solid var(--ag-border)',
              borderRadius: 'var(--ag-radius-sm)',
              padding: 14,
              background: 'var(--ag-surface-raised)',
            }}
          >
            {oauthDone ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <StatusBadge tone="success">已授权</StatusBadge>
                  <span className="ag-secondary" style={{ fontSize: 13 }}>
                    随渠道一并保存
                  </span>
                </div>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => {
                    setApiKey('');
                    void handleStartInlineOAuth();
                  }}
                >
                  重新授权
                </button>
              </div>
            ) : !oauthSessionId ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span className="ag-secondary" style={{ fontSize: 13 }}>
                  {inlineOAuthKind === 'openai-codex'
                    ? 'ChatGPT 订阅'
                    : inlineOAuthKind === 'xai'
                      ? 'Grok 订阅'
                      : 'OpenRouter'}
                </span>
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  onClick={() => void handleStartInlineOAuth()}
                  disabled={oauthLoading}
                >
                  {oauthLoading ? '生成中…' : '扫码 / 链接授权'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
                {oauthQrDataUrl && (
                  <img
                    src={oauthQrDataUrl}
                    alt="OAuth QR"
                    width={156}
                    height={156}
                    style={{
                      borderRadius: 8,
                      border: '1px solid var(--ag-border)',
                      background: '#ffffff',
                      padding: 6,
                    }}
                  />
                )}
                {oauthUserCode && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="ag-secondary" style={{ fontSize: 12 }}>
                      授权码
                    </span>
                    <code
                      className="ag-mono"
                      style={{
                        fontSize: 16,
                        fontWeight: 700,
                        letterSpacing: 1.5,
                        padding: '3px 10px',
                        borderRadius: 6,
                        background: '#ffffff',
                        border: '1px solid var(--ag-border)',
                      }}
                    >
                      {oauthUserCode}
                    </code>
                    <button
                      type="button"
                      className="ag-btn ag-btn-sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(oauthUserCode);
                        setCopiedOAuthCode(true);
                        window.setTimeout(() => setCopiedOAuthCode(false), 1500);
                      }}
                    >
                      {copiedOAuthCode ? '已复制' : '复制'}
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <a
                    href={oauthLink}
                    target="_blank"
                    rel="noreferrer"
                    className="ag-btn ag-btn-primary ag-btn-sm"
                  >
                    打开授权页 ↗
                  </a>
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    onClick={() => void handleStartInlineOAuth()}
                  >
                    重新生成
                  </button>
                </div>
                {inlineOAuthKind === 'openrouter' && (
                  <div style={{ display: 'flex', gap: 8, width: '100%' }}>
                    <input
                      className="ag-input ag-mono"
                      value={pkceCodeInput}
                      onChange={(e) => setPkceCodeInput(e.target.value)}
                      placeholder="粘贴回调链接或 code"
                    />
                    <button
                      type="button"
                      className="ag-btn ag-btn-primary ag-btn-sm"
                      onClick={() => void handleConfirmInlinePkce()}
                      disabled={oauthLoading || !pkceCodeInput.trim()}
                    >
                      确认授权
                    </button>
                  </div>
                )}
                {oauthStatusText && (
                  <span className="ag-secondary" style={{ fontSize: 12 }}>
                    {oauthStatusText}
                  </span>
                )}
              </div>
            )}
            {oauthError && (
              <div style={{ color: 'var(--ag-danger, #dc2626)', fontSize: 12, marginTop: 8 }}>
                {oauthError}
              </div>
            )}
          </div>
        ) : useEnvRef ? (
          <input
            className="ag-input ag-mono"
            value={envRef}
            onChange={(e) => setEnvRef(e.target.value)}
            placeholder="例如 DEEPSEEK_API_KEY"
          />
        ) : (
          <input
            type="password"
            className="ag-input ag-mono"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={currentPreset?.key_hint ?? '输入 API Key'}
            autoComplete="off"
          />
        )}
      </div>

      {/* 5. 模型清单拉取与表格（97 §2.2 #2, #3, #4） */}
      <div className="ag-field">
        <div className="ag-field-label">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>模型清单（已选 {selectedModels.size} 项）</span>
            {metadataIncomplete && <StatusBadge tone="neutral">部分元数据缺失</StatusBadge>}
            {modelsDevMatched !== null && (
              <StatusBadge tone="success">已补全 {modelsDevMatched} 项</StatusBadge>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {fetchedModels.length > 0 && (
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={handleSyncModelsDev}
                disabled={syncingModelsDev || fetchingModels}
              >
                {/* ui-copy: allow 在线同步 models.dev 模型元数据按钮 */}
                {syncingModelsDev ? '同步中…' : '从 models.dev 同步'}
              </button>
            )}
            <button
              type="button"
              className="ag-btn ag-btn-sm ag-btn-primary"
              onClick={handleFetchModels}
              disabled={fetchingModels || syncingModelsDev}
            >
              {fetchingModels ? '拉取中…' : '获取模型'}
            </button>
            <a className="ag-help-link" href={helpHref('modelFetch')}>
              了解更多 →
            </a>
          </div>
        </div>

        <ErrorBanner
          error={fetchError}
          onRetry={handleFetchModels}
          onDismiss={() => setFetchError(null)}
        />

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            className="ag-input"
            style={{ flex: '1 1 200px' }}
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder="搜索模型名…"
          />
          {modelSearch.trim() !== '' && (
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => setModelSearch('')}
            >
              清空搜索
            </button>
          )}
          {filteredModels.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={selectAllFiltered}
                disabled={allFilteredSelected}
              >
                全选
              </button>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={deselectAllFiltered}
                disabled={!anyFilteredSelected}
              >
                全不选
              </button>
            </div>
          )}
          {selectedPresetId === 'custom' && (
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <input
                className="ag-input ag-mono"
                style={{ width: 180 }}
                value={manualModelInput}
                onChange={(e) => setManualModelInput(e.target.value)}
                placeholder="补充模型 ID"
              />
              <button type="button" className="ag-btn" onClick={handleAddManualModel}>
                添加
              </button>
            </div>
          )}
        </div>

        {availableCategories.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button
              type="button"
              className={`ag-btn ag-btn-sm${modelCategoryFilter === 'all' ? ' ag-btn-primary' : ''}`}
              onClick={() => setModelCategoryFilter('all')}
            >
              全部 ({fetchedModels.length})
            </button>
            {availableCategories.map((cat) => {
              const count = fetchedModels.filter((m) => resolveModelCategory(m) === cat).length;
              return (
                <button
                  key={cat}
                  type="button"
                  className={`ag-btn ag-btn-sm${modelCategoryFilter === cat ? ' ag-btn-primary' : ''}`}
                  onClick={() => setModelCategoryFilter(cat)}
                >
                  {MODEL_CATEGORY_LABELS[cat].short} ({count})
                </button>
              );
            })}
          </div>
        )}

        <div
          className="ag-table-wrap"
          style={{
            maxHeight: 280,
            border: '1px solid var(--ag-border)',
            borderRadius: 'var(--ag-radius-sm)',
          }}
        >
          <GroupedModelTable
            groups={groupedModels.map((g) => ({ category: g.category, items: g.models }))}
            getKey={(m) => m.id}
            toModelDto={(m) => m}
            emptyText={
              fetchedModels.length > 0
                ? modelSearch.trim()
                  ? '无匹配模型'
                  : '当前分类无模型'
                : '暂无模型，请点击获取模型'
            }
            selection={{
              selectedIds: selectedModels,
              onToggleItem: toggleModel,
              onToggleGroup: (items) =>
                toggleGroupModels(items, selectedModels, setSelectedModels),
            }}
            extraColumns={
              isEdit
                ? [
                    {
                      header: '状态',
                      render: (m) => {
                        const inPrev = previousSavedModels.has(m.id);
                        const inUpstream = upstreamFetchedIdSet.has(m.id);
                        if (!hasFetchedOnce) {
                          return <StatusBadge tone="neutral">已保存快照</StatusBadge>;
                        }
                        if (!inPrev) return <StatusBadge tone="info">上游新增</StatusBadge>;
                        if (inUpstream) return <StatusBadge tone="success">已有</StatusBadge>;
                        return <StatusBadge tone="warning">上游已移除</StatusBadge>;
                      },
                    },
                  ]
                : []
            }
          />
        </div>
      </div>

      {/* 6. 服务商能力状态（三态只读展示，97 §2.2 #5 & §5 #7） */}
      <div className="ag-field">
        <div className="ag-field-label">
          <span>能力状态（只读）</span>
          <a className="ag-help-link" href={helpHref('deepseekSuite')}>
            能力矩阵说明 →
          </a>
        </div>
        <div
          style={{
            border: '1px solid var(--ag-border)',
            borderRadius: 'var(--ag-radius-sm)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {getProviderCapabilities(selectedPresetId).map((cap) => (
            <div
              key={cap.feature}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span style={{ fontWeight: 500 }}>{cap.feature}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="ag-secondary">{cap.detail}</span>
                {cap.state === 'implemented' ? (
                  <StatusBadge tone="success">已接入</StatusBadge>
                ) : cap.state === 'unimplemented' ? (
                  <StatusBadge tone="warning">未接入</StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">计划中</StatusBadge>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* DeepSeek 真实支持的服务端内置工具默认注入开关 */}
      {(selectedPresetId === 'deepseek' || editingProvider?.id === 'deepseek') && (
        <div className="ag-grid-2">
          <div
            style={{
              padding: 12,
              border: '1px solid var(--ag-border)',
              borderRadius: 'var(--ag-radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>联网搜索注入 (web_search)</span>
            <Switch checked={webSearchDefault} onChange={setWebSearchDefault} />
          </div>
          <div
            style={{
              padding: 12,
              border: '1px solid var(--ag-border)',
              borderRadius: 'var(--ag-radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>网页读取注入 (url_context)</span>
            <Switch checked={urlContextDefault} onChange={setUrlContextDefault} />
          </div>
        </div>
      )}

      {/* 7. 高级折叠区（97 §2.2 #6：「乱七八糟」只准住在默认收起的折叠区） */}
      <div>
        <button
          type="button"
          className="ag-btn ag-btn-sm"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? '高级选项 ▴' : '高级选项 ▾'}
        </button>

        <div className={`ag-collapse${showAdvanced ? ' is-open' : ''}`}>
          <div className="ag-collapse-inner">
            <div
              style={{
                marginTop: 12,
                padding: 16,
                borderRadius: 'var(--ag-radius-md)',
                border: '1px solid var(--ag-border)',
                background: 'var(--ag-surface-raised)',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
            }}
          >
            <div className="ag-grid-2">
              <div className="ag-field">
                <div className="ag-field-label">
                  <span>命名空间前缀</span>
                  <a className="ag-help-link" href={helpHref('namespace')}>
                    规则 →
                  </a>
                </div>
                <input
                  className="ag-input ag-mono"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  placeholder="留空不加前缀，例如 ds"
                />
              </div>
              <div className="ag-field">
                <label className="ag-field-label">备注</label>
                <input
                  className="ag-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="选填备注"
                />
              </div>
            </div>

            {selectedPresetId !== 'custom' && (
              <div className="ag-grid-2">
                <div className="ag-field">
                  <label className="ag-field-label">上游地址覆盖</label>
                  <input
                    className="ag-input ag-mono"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>
                <div className="ag-field">
                  <label className="ag-field-label">显示名称</label>
                  <input
                    className="ag-input"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="ag-grid-2">
              <div className="ag-field">
                <label className="ag-field-label">渠道倍率</label>
                <input
                  className="ag-input ag-mono"
                  type="number"
                  step="0.01"
                  min="0"
                  value={pricingMultiplier}
                  onChange={(e) => setPricingMultiplier(e.target.value)}
                  placeholder="默认 1.0"
                />
              </div>
              <div className="ag-field">
                <label className="ag-field-label">计价币种</label>
                <select
                  className="ag-select"
                  value={pricingCurrency}
                  onChange={(e) => setPricingCurrency(e.target.value)}
                >
                  <option value="USD">USD ($)</option>
                  <option value="CNY">CNY (¥)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
            </div>

            <div className="ag-field">
              <label className="ag-field-label">自定义模型单价 (JSON)</label>
              <textarea
                className="ag-textarea ag-mono"
                rows={3}
                value={pricingModelsJson}
                onChange={(e) => setPricingModelsJson(e.target.value)}
                placeholder={'{"gpt-4o":{"input":2.5,"output":10}}'}
              />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>动态模型发现模式</div>
                <a className="ag-help-link" href={helpHref('modelFetch')}>
                  同步规则 →
                </a>
              </div>
              <Switch checked={autoDiscoveryMode} onChange={setAutoDiscoveryMode} />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: 8,
                borderTop: '1px solid var(--ag-border)',
              }}
            >
              <span className="ag-secondary">模型映射见别名页</span>
              <button
                type="button"
                className="ag-btn ag-btn-sm"
                onClick={() => {
                  onClose();
                  navigate('aliases');
                }}
              >
                模型别名 →
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
        </div>
      )}
    </Modal>
  );
}
