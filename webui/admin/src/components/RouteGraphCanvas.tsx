import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, ApiRequestError, type ActionableError } from '../api/client.js';
import type { AvailableModelOption } from '../api/model-availability.js';
import type {
  AccessPathDto,
  ProviderConfig,
  ProviderRoutingOptionSpecDto,
  ProviderTelemetrySnapshotDto,
  RouteEvalStepDto,
  RouteGraphAbilities,
  RouteGraphAbilityMode,
  RouteGraphDto,
  RouteGraphEdgeDto,
  RouteGraphNodeDto,
  RouteGraphSimulateResponse,
  RouteGraphUpsertRequest,
  RouteParamOverrides,
  RoutingTelemetryResponse,
} from '../api/types.js';
import { ConfirmModal, EmptyState, ErrorBanner, StatusBadge, Switch } from './ui.js';
import { ProviderIcon } from './ProviderIcon.js';

interface GraphDraft {
  id: string;
  label: string;
  enabled: boolean;
  entry_node_id: string;
  nodes: RouteGraphNodeDto[];
  edges: RouteGraphEdgeDto[];
  ability_mode: RouteGraphAbilityMode;
  abilities: RouteGraphAbilities;
  note: string;
}

const NODE_WIDTH = 236;
const NODE_HEIGHT = 112;
const SOCKET_ROW_TOP = 38;
const SOCKET_ROW_H = 22;

function getInputSocketPos(node: RouteGraphNodeDto, socket: 'in' | 'script'): { x: number; y: number } {
  const row = socket === 'script' ? 1 : 0;
  return {
    x: node.position.x,
    y: node.position.y + SOCKET_ROW_TOP + row * SOCKET_ROW_H + SOCKET_ROW_H / 2,
  };
}

function getOutputSocketPos(node: RouteGraphNodeDto, port: string): { x: number; y: number } {
  const ports = portsForNode(node);
  const idx = Math.max(0, ports.indexOf(port));
  return {
    x: node.position.x + NODE_WIDTH,
    y: node.position.y + SOCKET_ROW_TOP + idx * SOCKET_ROW_H + SOCKET_ROW_H / 2,
  };
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeBlankGraph(providers: readonly ProviderConfig[], options: readonly AvailableModelOption[]): GraphDraft {
  const firstOpt = options[0];
  const firstProv = providers[0];
  const pId = firstOpt?.providerId ?? firstProv?.id ?? 'deepseek';
  const ap = firstOpt?.accessPath ?? (firstProv ? `${firstProv.id}.${firstProv.dialect.replace('.', '-')}` : 'deepseek.openai-chat');
  const model = firstOpt?.model ?? 'deepseek-flash';
  const entryId = 'entry_1';
  const targetId = 'target_1';
  return {
    id: 'smart-router',
    label: '智能路由',
    enabled: true,
    entry_node_id: entryId,
    nodes: [
      { id: entryId, kind: 'entry', label: '入口', position: { x: 40, y: 120 } },
      {
        id: targetId,
        kind: 'provider_target',
        label: '主模型',
        position: { x: 340, y: 120 },
        target: { provider: pId, access_path: ap, model, provider_options: {} },
      },
    ],
    edges: [{ id: 'e_1', from: entryId, from_port: 'next', to: targetId, priority: 100 }],
    ability_mode: 'min',
    abilities: {},
    note: '',
  };
}

function makePreset5hGraph(): GraphDraft {
  return {
    id: 'codex-with-fallback',
    label: '订阅5h限额切备用',
    enabled: true,
    entry_node_id: 'entry_1',
    nodes: [
      { id: 'entry_1', kind: 'entry', label: '入口', position: { x: 40, y: 140 } },
      {
        id: 'codex_1',
        kind: 'provider_target',
        label: 'Codex 订阅',
        position: { x: 320, y: 80 },
        target: {
          provider: 'openai-codex',
          access_path: 'openai-codex.openai-responses',
          model: 'gpt-5.4',
          provider_options: { max_5h_requests: 80 },
        },
      },
      {
        id: 'ds_1',
        kind: 'provider_target',
        label: 'DeepSeek 备用',
        position: { x: 640, y: 140 },
        target: {
          provider: 'deepseek',
          access_path: 'deepseek.openai-chat',
          model: 'deepseek-flash',
          provider_options: { min_balance: 1 },
        },
      },
    ],
    edges: [
      { id: 'e_1', from: 'entry_1', from_port: 'next', to: 'codex_1', priority: 100 },
      { id: 'e_2', from: 'codex_1', from_port: 'fallback', to: 'ds_1', priority: 100, label: '备选' },
    ],
    ability_mode: 'min',
    abilities: {},
    note: '',
  };
}

function makePresetJsGraph(): GraphDraft {
  return {
    id: 'js-smart-balance',
    label: 'JS 余额与长度分流',
    enabled: true,
    entry_node_id: 'entry_1',
    nodes: [
      { id: 'entry_1', kind: 'entry', label: '入口', position: { x: 40, y: 140 } },
      {
        id: 'js_1',
        kind: 'js_script',
        label: '脚本决策',
        position: { x: 300, y: 140 },
        script: {
          timeout_ms: 50,
          ports: ['mimo', 'deepseek', 'fallback'],
          code: [
            'const mimoCred = credits.mimo?.remaining_credits ?? 0;',
            'if (request.has_images || request.estimated_tokens > 32000) {',
            '  return { branch: "deepseek", overrides: { thinking_enabled: true, thinking_effort: "high" } };',
            '}',
            'if (mimoCred >= 50) return "mimo";',
            'return "deepseek";',
          ].join('\n'),
        },
      },
      {
        id: 'mimo_1',
        kind: 'provider_target',
        label: 'MiMo 套餐',
        position: { x: 620, y: 60 },
        target: {
          provider: 'mimo',
          access_path: 'mimo.openai-chat',
          model: 'mimo-v2.6-flash',
          provider_options: { min_remaining_credits: 50 },
        },
      },
      {
        id: 'ds_1',
        kind: 'provider_target',
        label: 'DeepSeek 兜底',
        position: { x: 620, y: 220 },
        target: {
          provider: 'deepseek',
          access_path: 'deepseek.openai-chat',
          model: 'deepseek-flash',
          provider_options: { min_balance: 1 },
        },
      },
    ],
    edges: [
      { id: 'e_1', from: 'entry_1', from_port: 'next', to: 'js_1', priority: 100 },
      { id: 'e_2', from: 'js_1', from_port: 'mimo', to: 'mimo_1', priority: 100, label: 'mimo' },
      { id: 'e_3', from: 'js_1', from_port: 'deepseek', to: 'ds_1', priority: 110, label: 'deepseek' },
      { id: 'e_4', from: 'mimo_1', from_port: 'fallback', to: 'ds_1', priority: 120, label: '备选' },
    ],
    ability_mode: 'min',
    abilities: {},
    note: '',
  };
}

const JS_SNIPPETS: ReadonlyArray<{ label: string; code: string }> = [
  {
    label: '余额积分',
    code: [
      'const dsBal = credits.deepseek?.balance ?? 0;',
      'const mimoCred = credits.mimo?.remaining_credits ?? 0;',
      'if (mimoCred > 100) return "mimo";',
      'if (dsBal > 1) return "deepseek";',
      'return "fallback";',
    ].join('\n'),
  },
  {
    label: '5h限额',
    code: [
      'const codexReq = telemetry["openai-codex"]?.window_5h?.requests ?? 0;',
      'if (codexReq < 80) return "codex";',
      'return { branch: "fallback", overrides: { thinking_effort: "medium" } };',
    ].join('\n'),
  },
  {
    label: '图文分流',
    code: [
      'if (request.has_images) return "vision";',
      'if (request.estimated_tokens > 16000) {',
      '  return { branch: "pro", overrides: { thinking_enabled: true } };',
      '}',
      'return "fast";',
    ].join('\n'),
  },
];

function portsForNode(node: RouteGraphNodeDto): string[] {
  switch (node.kind) {
    case 'entry':
      return ['next'];
    case 'condition':
      return ['true', 'false'];
    case 'js_script': {
      const configured = node.script.ports ?? [];
      const base = configured.length > 0 ? configured : ['next', 'fallback'];
      return base.includes('script') ? base : [...base, 'script'];
    }
    case 'provider_target':
      return ['fallback', ...(node.extension_ports ?? [])];
  }
}

function portLabel(port: string): string {
  switch (port) {
    case 'next':
      return '输出';
    case 'true':
      return '满足';
    case 'false':
      return '不满足';
    case 'fallback':
      return '备选';
    case 'script':
      return '脚本钩子';
    case 'off_peak':
      return '闲时优惠';
    case 'low_balance':
      return '余额不足';
    case 'low_credits':
      return '积分不足';
    case 'quota_exceeded':
      return '限额耗尽';
    default:
      return port;
  }
}

function portToneColor(port: string): string {
  switch (port) {
    case 'true':
    case 'off_peak':
      return 'var(--ag-success)';
    case 'false':
    case 'low_balance':
    case 'low_credits':
      return 'var(--ag-danger)';
    case 'fallback':
    case 'quota_exceeded':
      return 'var(--ag-warning)';
    case 'script':
      return '#8b5cf6';
    default:
      return 'var(--ag-accent)';
  }
}

function nodeKindTitle(kind: RouteGraphNodeDto['kind']): string {
  switch (kind) {
    case 'entry':
      return '入口';
    case 'condition':
      return '条件';
    case 'js_script':
      return '脚本';
    case 'provider_target':
      return '目标';
  }
}

export function RouteGraphCanvas({
  providers,
  accessPaths,
  modelOptions,
}: {
  providers: readonly ProviderConfig[];
  accessPaths: readonly AccessPathDto[];
  modelOptions: readonly AvailableModelOption[];
}): React.JSX.Element {
  const [graphs, setGraphs] = useState<RouteGraphDto[]>([]);
  const [telemetry, setTelemetry] = useState<RoutingTelemetryResponse>({
    snapshots: {},
    provider_options: {},
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshingTel, setRefreshingTel] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<ActionableError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [draft, setDraft] = useState<GraphDraft | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<{
    nodeId: string;
    port: string;
    dragging?: boolean;
  } | null>(null);
  const [wirePreview, setWirePreview] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [contextMenu, setContextMenu] = useState<{
    clientX: number;
    clientY: number;
    canvasX: number;
    canvasY: number;
    target:
      | { kind: 'canvas' }
      | { kind: 'node'; nodeId: string }
      | { kind: 'edge'; edgeId: string };
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RouteGraphDto | null>(null);

  // 拖拽与画布平移状态
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<number>(1);
  zoomRef.current = zoom;
  const panRefState = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  panRefState.current = pan;
  const dragRef = useRef<{
    nodeId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const panDragRef = useRef<{
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  } | null>(null);

  // 模拟器状态
  const [simOpen, setSimOpen] = useState<boolean>(true);
  const [simPrompt, setSimPrompt] = useState<string>('分析代码复杂度');
  const [simHasImages, setSimHasImages] = useState<boolean>(false);
  const [simHasTools, setSimHasTools] = useState<boolean>(false);
  const [simThinking, setSimThinking] = useState<boolean>(false);
  const [simTokens, setSimTokens] = useState<string>('1200');
  const [simTelemetryOverrides, setSimTelemetryOverrides] = useState<
    Record<string, { balance?: string; remaining_credits?: string; requests5h?: string; offPeak?: boolean }>
  >({});
  const [simulating, setSimulating] = useState<boolean>(false);
  const [simResult, setSimResult] = useState<RouteGraphSimulateResponse | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [gRes, tRes] = await Promise.all([
        adminApi.listRouteGraphs(),
        adminApi.getRoutingTelemetry(),
      ]);
      setGraphs(gRes.items);
      setTelemetry(tRes);
      if (gRes.items.length > 0 && draft === null) {
        const first = gRes.items[0]!;
        setDraft({
          id: first.id,
          label: first.label,
          enabled: first.enabled,
          entry_node_id: first.entry_node_id,
          nodes: first.nodes,
          edges: first.edges,
          ability_mode: first.ability_mode ?? 'min',
          abilities: first.abilities ? { ...first.abilities } : {},
          note: first.note ?? '',
        });
        setSelectedNodeId(first.entry_node_id);
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '加载失败', message: err instanceof Error ? err.message : '加载失败' },
      );
    } finally {
      setLoading(false);
    }
  }, [draft]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // 鼠标拖拽节点、画布平移与连线预览
  useEffect(() => {
    const toCanvasCoords = (clientX: number, clientY: number) => {
      const el = canvasRef.current;
      if (!el) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      const z = zoomRef.current || 1;
      const p = panRefState.current;
      return {
        x: Math.round((clientX - rect.left - p.x) / z),
        y: Math.round((clientY - rect.top - p.y) / z),
      };
    };

    const onMove = (e: PointerEvent) => {
      const panDrag = panDragRef.current;
      if (panDrag) {
        setPan({
          x: Math.round(panDrag.origPanX + (e.clientX - panDrag.startX)),
          y: Math.round(panDrag.origPanY + (e.clientY - panDrag.startY)),
        });
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        const z = zoomRef.current || 1;
        const dx = (e.clientX - drag.startX) / z;
        const dy = (e.clientY - drag.startY) / z;
        setDraft((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            nodes: prev.nodes.map((n) =>
              n.id === drag.nodeId
                ? {
                    ...n,
                    position: {
                      x: Math.round(drag.origX + dx),
                      y: Math.round(drag.origY + dy),
                    },
                  }
                : n,
            ),
          };
        });
      } else {
        setWirePreview((prev) => (prev === null ? null : toCanvasCoords(e.clientX, e.clientY)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      if (panDragRef.current) {
        panDragRef.current = null;
        setIsPanning(false);
      }
      setWirePreview(null);
      setConnectingFrom((prev) => (prev?.dragging ? null : prev));
    };
    const onWinClick = () => setContextMenu(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('click', onWinClick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('click', onWinClick);
    };
  }, []);

  const selectedNode = useMemo(
    () => draft?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [draft, selectedNodeId],
  );

  const simTraceMap = useMemo(() => {
    const map = new Map<string, RouteEvalStepDto>();
    for (const step of simResult?.trace ?? []) {
      map.set(step.node_id, step);
    }
    return map;
  }, [simResult]);

  const providersInDraft = useMemo(() => {
    if (!draft) return [];
    return Array.from(
      new Set(
        draft.nodes
          .filter((n): n is Extract<RouteGraphNodeDto, { kind: 'provider_target' }> => n.kind === 'provider_target')
          .map((n) => n.target.provider),
      ),
    );
  }, [draft]);

  const knownProviderIds = useMemo(() => {
    const ids = new Set<string>([
      ...providers.map((p) => p.id),
      ...Object.keys(telemetry.provider_options),
      ...Object.keys(telemetry.snapshots),
    ]);
    return Array.from(ids).sort();
  }, [providers, telemetry]);

  function openGraph(g: RouteGraphDto) {
    setDraft({
      id: g.id,
      label: g.label,
      enabled: g.enabled,
      entry_node_id: g.entry_node_id,
      nodes: JSON.parse(JSON.stringify(g.nodes)) as RouteGraphNodeDto[],
      edges: JSON.parse(JSON.stringify(g.edges)) as RouteGraphEdgeDto[],
      ability_mode: g.ability_mode ?? 'min',
      abilities: g.abilities ? { ...g.abilities } : {},
      note: g.note ?? '',
    });
    setSelectedNodeId(g.entry_node_id);
    setConnectingFrom(null);
    setSimResult(null);
    setNotice(null);
  }

  function applyDraftTemplate(template: GraphDraft) {
    setDraft(template);
    setSelectedNodeId(template.nodes[1]?.id ?? template.entry_node_id);
    setConnectingFrom(null);
    setSimResult(null);
    setNotice(null);
  }

  function createNodeDraft(
    kind: 'condition' | 'js_script' | 'provider_target',
    pos?: { x: number; y: number },
  ): RouteGraphNodeDto {
    const count = draft?.nodes.length ?? 0;
    const x = pos?.x ?? 180 + (count % 3) * 320;
    const y = pos?.y ?? 70 + Math.floor(count / 3) * 165;
    const id = uid(kind === 'condition' ? 'cond' : kind === 'js_script' ? 'js' : 'target');
    if (kind === 'condition') {
      return {
        id,
        kind: 'condition',
        label: '条件判断',
        position: { x, y },
        condition: {},
      };
    }
    if (kind === 'js_script') {
      return {
        id,
        kind: 'js_script',
        label: 'JS 脚本',
        position: { x, y },
        script: {
          code: 'return "next";',
          timeout_ms: 50,
          ports: ['next', 'fallback'],
        },
      };
    }
    const firstOpt = modelOptions[0];
    const pId = firstOpt?.providerId ?? providers[0]?.id ?? 'deepseek';
    const ap =
      firstOpt?.accessPath ??
      (providers[0] ? `${providers[0].id}.${providers[0].dialect.replace('.', '-')}` : 'deepseek.openai-chat');
    const m = firstOpt?.model ?? 'deepseek-flash';
    return {
      id,
      kind: 'provider_target',
      label: '目标模型',
      position: { x, y },
      target: { provider: pId, access_path: ap, model: m, provider_options: {} },
    };
  }

  function addNode(kind: 'condition' | 'js_script' | 'provider_target', pos?: { x: number; y: number }) {
    if (!draft) return;
    const nextNode = createNodeDraft(kind, pos);
    setDraft({ ...draft, nodes: [...draft.nodes, nextNode] });
    setSelectedNodeId(nextNode.id);
    setSelectedEdgeId(null);
  }

  function duplicateNode(nodeId: string) {
    if (!draft || nodeId === draft.entry_node_id) return;
    const orig = draft.nodes.find((n) => n.id === nodeId);
    if (!orig) return;
    const copy = JSON.parse(JSON.stringify(orig)) as RouteGraphNodeDto;
    copy.id = uid(orig.kind === 'condition' ? 'cond' : orig.kind === 'js_script' ? 'js' : 'target');
    copy.label = `${orig.label} 副本`;
    copy.position = { x: orig.position.x + 36, y: orig.position.y + 36 };
    setDraft({ ...draft, nodes: [...draft.nodes, copy] });
    setSelectedNodeId(copy.id);
    setSelectedEdgeId(null);
  }

  function disconnectNode(nodeId: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      edges: draft.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    });
  }

  function insertNodeOnEdge(edgeId: string, kind: 'condition' | 'js_script') {
    if (!draft) return;
    const edge = draft.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const src = draft.nodes.find((n) => n.id === edge.from);
    const dst = draft.nodes.find((n) => n.id === edge.to);
    const midPos =
      src && dst
        ? {
            x: Math.round((src.position.x + dst.position.x) / 2),
            y: Math.round((src.position.y + dst.position.y) / 2),
          }
        : undefined;
    const newNode = createNodeDraft(kind, midPos);
    const outPort = kind === 'condition' ? 'true' : 'next';
    const e1: RouteGraphEdgeDto = {
      id: uid('edge'),
      from: edge.from,
      from_port: edge.from_port,
      to: newNode.id,
      priority: edge.priority,
      label: edge.label ?? portLabel(edge.from_port),
    };
    const e2: RouteGraphEdgeDto = {
      id: uid('edge'),
      from: newNode.id,
      from_port: outPort,
      to: edge.to,
      priority: 100,
      label: portLabel(outPort),
    };
    setDraft({
      ...draft,
      nodes: [...draft.nodes, newNode],
      edges: [...draft.edges.filter((e) => e.id !== edgeId), e1, e2],
    });
    setSelectedNodeId(newNode.id);
    setSelectedEdgeId(null);
  }

  function updateNode(updated: RouteGraphNodeDto) {
    if (!draft) return;
    setDraft({
      ...draft,
      nodes: draft.nodes.map((n) => (n.id === updated.id ? updated : n)),
    });
  }

  function deleteNode(nodeId: string) {
    if (!draft || nodeId === draft.entry_node_id) return;
    setDraft({
      ...draft,
      nodes: draft.nodes.filter((n) => n.id !== nodeId),
      edges: draft.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    });
    if (selectedNodeId === nodeId) {
      setSelectedNodeId(draft.entry_node_id);
    }
  }

  function connectNodes(fromId: string, port: string, toId: string) {
    if (!draft || fromId === toId) return;
    const exists = draft.edges.some(
      (e) => e.from === fromId && e.from_port === port && e.to === toId,
    );
    if (exists) return;
    const edge: RouteGraphEdgeDto = {
      id: uid('edge'),
      from: fromId,
      from_port: port,
      to: toId,
      priority: 100 + draft.edges.length * 10,
      label: portLabel(port),
    };
    setDraft({ ...draft, edges: [...draft.edges, edge] });
    setConnectingFrom(null);
  }

  function removeEdge(edgeId: string) {
    if (!draft) return;
    setDraft({ ...draft, edges: draft.edges.filter((e) => e.id !== edgeId) });
    if (selectedEdgeId === edgeId) {
      setSelectedEdgeId(null);
    }
  }

  function tidyLayout() {
    if (!draft) return;
    // 按拓扑最长路径分层自动排布（无重叠大间距）
    const depth = new Map<string, number>();
    depth.set(draft.entry_node_id, 0);
    for (let pass = 0; pass < draft.nodes.length * 2; pass += 1) {
      for (const e of draft.edges) {
        const dFrom = depth.get(e.from);
        if (dFrom !== undefined) {
          depth.set(e.to, Math.max(depth.get(e.to) ?? 0, dFrom + 1));
        }
      }
    }
    const colBuckets = new Map<number, RouteGraphNodeDto[]>();
    for (const n of draft.nodes) {
      const col = depth.get(n.id) ?? 0;
      const list = colBuckets.get(col) ?? [];
      list.push(n);
      colBuckets.set(col, list);
    }
    const ROW_STEP = 148;
    const COL_STEP = 310;
    const maxRows = Math.max(1, ...Array.from(colBuckets.values()).map((c) => c.length));
    const totalHeight = (maxRows - 1) * ROW_STEP;
    const posById = new Map<string, { x: number; y: number }>();
    for (const [col, bucket] of colBuckets.entries()) {
      bucket.sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));
      const colHeight = (bucket.length - 1) * ROW_STEP;
      const offsetY = 48 + Math.round((totalHeight - colHeight) / 2);
      bucket.forEach((n, row) => {
        posById.set(n.id, { x: 48 + col * COL_STEP, y: offsetY + row * ROW_STEP });
      });
    }
    const nextNodes = draft.nodes.map((n) => ({
      ...n,
      position: posById.get(n.id) ?? n.position,
    }));
    setDraft({ ...draft, nodes: nextNodes });
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }

  async function handleSaveGraph() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: RouteGraphUpsertRequest = {
        id: draft.id.trim(),
        label: draft.label.trim() || draft.id.trim(),
        enabled: draft.enabled,
        entry_node_id: draft.entry_node_id,
        nodes: draft.nodes,
        edges: draft.edges,
        ability_mode: draft.ability_mode,
        ...(draft.ability_mode === 'custom' ? { abilities: draft.abilities } : {}),
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      };
      const res = await adminApi.upsertRouteGraph(payload);
      if (res.ok) {
        setNotice('已保存');
        const listRes = await adminApi.listRouteGraphs();
        setGraphs(listRes.items);
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '保存失败', message: err instanceof Error ? err.message : '保存失败' },
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteGraph() {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteRouteGraph(deleteTarget.id);
      setDeleteTarget(null);
      const listRes = await adminApi.listRouteGraphs();
      setGraphs(listRes.items);
      if (draft?.id === deleteTarget.id) {
        if (listRes.items.length > 0) {
          openGraph(listRes.items[0]!);
        } else {
          setDraft(null);
        }
      }
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '删除失败', message: err instanceof Error ? err.message : '删除失败' },
      );
    }
  }

  async function handleRefreshTelemetry() {
    setRefreshingTel(true);
    setError(null);
    try {
      const res = await adminApi.refreshRoutingTelemetry();
      setTelemetry(res);
      setNotice('额度已刷新');
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '刷新失败', message: err instanceof Error ? err.message : '刷新失败' },
      );
    } finally {
      setRefreshingTel(false);
    }
  }

  async function handleSimulate() {
    if (!draft) return;
    setSimulating(true);
    setError(null);
    try {
      const telemetry_overrides: Record<string, Partial<ProviderTelemetrySnapshotDto>> = {};
      for (const [pId, ov] of Object.entries(simTelemetryOverrides)) {
        const entry: Partial<ProviderTelemetrySnapshotDto> = {};
        if (ov.balance !== undefined && ov.balance.trim() !== '') {
          const n = Number(ov.balance);
          if (Number.isFinite(n)) entry.balance = n;
        }
        if (ov.remaining_credits !== undefined && ov.remaining_credits.trim() !== '') {
          const n = Number(ov.remaining_credits);
          if (Number.isFinite(n)) entry.remaining_credits = n;
        }
        if (ov.offPeak !== undefined) {
          entry.is_off_peak = ov.offPeak;
        }
        if (ov.requests5h !== undefined && ov.requests5h.trim() !== '') {
          const n = Number(ov.requests5h);
          if (Number.isFinite(n)) {
            entry.window_5h = { requests: n, tokens: 0, cash_usd: 0 };
          }
        }
        if (Object.keys(entry).length > 0) {
          telemetry_overrides[pId] = entry;
        }
      }
      const res = await adminApi.simulateRouteGraph({
        graph: {
          id: draft.id.trim() || 'preview',
          label: draft.label.trim() || '预览',
          enabled: true,
          entry_node_id: draft.entry_node_id,
          nodes: draft.nodes,
          edges: draft.edges,
        },
        request: {
          model: draft.id.trim() || 'preview',
          prompt: simPrompt,
          has_images: simHasImages,
          has_tools: simHasTools,
          thinking_enabled: simThinking,
          ...(simTokens.trim() !== '' && Number.isFinite(Number(simTokens))
            ? { estimated_tokens: Number(simTokens) }
            : {}),
        },
        telemetry_overrides,
      });
      setSimResult(res);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err.actionable
          : { category: '模拟失败', message: err instanceof Error ? err.message : '模拟失败' },
      );
    } finally {
      setSimulating(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {/* 顶部路由图栏 */}
      <div className="ag-card" style={{ gap: 12 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="ag-field-label" style={{ margin: 0 }}>
              路由图列表
            </span>
            {graphs.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`ag-btn ag-btn-sm${draft?.id === g.id ? ' ag-btn-primary' : ''}`}
                onClick={() => openGraph(g)}
              >
                <span className="ag-mono">{g.id}</span>
                {!g.enabled && ' (停用)'}
              </button>
            ))}
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => applyDraftTemplate(makeBlankGraph(providers, modelOptions))}
            >
              + 空白图
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => applyDraftTemplate(makePreset5hGraph())}
            >
              + 5h限额模板
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => applyDraftTemplate(makePresetJsGraph())}
            >
              + JS分流模板
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {notice && <StatusBadge tone="success">{notice}</StatusBadge>}
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              disabled={refreshingTel}
              onClick={() => void handleRefreshTelemetry()}
            >
              {refreshingTel ? '刷新中…' : '刷新实时额度'}
            </button>
            <button
              type="button"
              className="ag-btn ag-btn-sm"
              onClick={() => setSimOpen((v) => !v)}
            >
              {simOpen ? '收起模拟器' : '打开模拟器'}
            </button>
          </div>
        </div>

        {/* 实时额度总览条 */}
        {Object.keys(telemetry.snapshots).length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {Object.values(telemetry.snapshots)
              .filter(
                (s) =>
                  s.balance !== undefined ||
                  s.remaining_credits !== undefined ||
                  s.window_5h.requests > 0 ||
                  s.is_off_peak !== undefined,
              )
              .map((s) => (
                <div
                  key={s.provider}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 10px',
                    borderRadius: 'var(--ag-radius-sm)',
                    border: '1px solid var(--ag-border)',
                    background: 'var(--ag-surface-raised)',
                    fontSize: 12,
                  }}
                >
                  <ProviderIcon providerId={s.provider} size={16} />
                  <span className="ag-mono" style={{ fontWeight: 600 }}>
                    {s.provider}
                  </span>
                  {s.balance !== undefined && (
                    <span className="ag-tabular">
                      余额 {s.balance} {s.currency ?? ''}
                    </span>
                  )}
                  {s.remaining_credits !== undefined && (
                    <span className="ag-tabular">积分 {s.remaining_credits}</span>
                  )}
                  <span className="ag-tabular ag-secondary">
                    5h {s.window_5h.requests}次
                  </span>
                  {s.is_off_peak === true && <StatusBadge tone="info">闲时</StatusBadge>}
                </div>
              ))}
          </div>
        )}
      </div>

      {loading && graphs.length === 0 && draft === null ? (
        <div className="ag-card">
          <div className="ag-skeleton" style={{ height: 240 }} />
        </div>
      ) : draft === null ? (
        <EmptyState
          // ui-copy: allow 空状态引导创建首个路由图
          message="尚未建立路由图标识符"
          actionLabel="新建路由图"
          onAction={() => applyDraftTemplate(makeBlankGraph(providers, modelOptions))}
        />
      ) : (
        <>
          {/* 标识符元信息 + 画布工具栏 */}
          <div className="ag-card" style={{ gap: 12 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <div className="ag-field" style={{ minWidth: 180 }}>
                  <label className="ag-field-label">模型标识符</label>
                  <input
                    className="ag-input ag-mono"
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                    placeholder="例如 smart-router"
                  />
                </div>
                <div className="ag-field" style={{ minWidth: 220 }}>
                  <label className="ag-field-label">显示名称</label>
                  <input
                    className="ag-input"
                    value={draft.label}
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    placeholder="例如 智能路由"
                  />
                </div>
                <div className="ag-field" style={{ minWidth: 150 }}>
                  <label className="ag-field-label">能力预设</label>
                  <select
                    className="ag-select"
                    value={draft.ability_mode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        ability_mode: e.target.value as RouteGraphAbilityMode,
                      })
                    }
                  >
                    <option value="min">最小交集</option>
                    <option value="max">最大并集</option>
                    <option value="custom">自定义</option>
                  </select>
                </div>
                <div className="ag-field">
                  <label className="ag-field-label">启用</label>
                  <div style={{ height: 34, display: 'flex', alignItems: 'center' }}>
                    <Switch
                      checked={draft.enabled}
                      onChange={(next) => setDraft({ ...draft, enabled: next })}
                    />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => addNode('condition')}
                >
                  + 条件节点
                </button>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => addNode('js_script')}
                >
                  + 脚本节点
                </button>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => addNode('provider_target')}
                >
                  + 目标模型
                </button>
                <button type="button" className="ag-btn ag-btn-sm" onClick={tidyLayout}>
                  整理布局
                </button>
                {graphs.some((g) => g.id === draft.id) && (
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm ag-btn-danger"
                    onClick={() =>
                      setDeleteTarget(graphs.find((g) => g.id === draft.id) ?? null)
                    }
                  >
                    删除
                  </button>
                )}
                <button
                  type="button"
                  className="ag-btn ag-btn-primary"
                  disabled={saving || !draft.id.trim()}
                  onClick={() => void handleSaveGraph()}
                >
                  {saving ? '保存中…' : '保存路由图'}
                </button>
              </div>
            </div>

            {draft.ability_mode === 'custom' && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 12,
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderRadius: 'var(--ag-radius-sm)',
                  background: 'var(--ag-surface-raised)',
                  border: '1px solid var(--ag-border)',
                  fontSize: 12,
                }}
              >
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Switch
                    checked={Boolean(draft.abilities.tool_call)}
                    onChange={(next) =>
                      setDraft({ ...draft, abilities: { ...draft.abilities, tool_call: next } })
                    }
                  />
                  <span>工具调用</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Switch
                    checked={Boolean(draft.abilities.reasoning)}
                    onChange={(next) =>
                      setDraft({ ...draft, abilities: { ...draft.abilities, reasoning: next } })
                    }
                  />
                  <span>深度思考</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Switch
                    checked={Boolean(draft.abilities.structured_output)}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        abilities: { ...draft.abilities, structured_output: next },
                      })
                    }
                  />
                  <span>结构化输出</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Switch
                    checked={(draft.abilities.input_modalities ?? []).includes('image')}
                    onChange={(next) => {
                      const prev = draft.abilities.input_modalities ?? ['text'];
                      const nextMods = next
                        ? Array.from(new Set([...prev, 'text' as const, 'image' as const]))
                        : prev.filter((m) => m !== 'image');
                      setDraft({
                        ...draft,
                        abilities: {
                          ...draft.abilities,
                          input_modalities: nextMods.length > 0 ? nextMods : ['text'],
                        },
                      });
                    }}
                  />
                  <span>视觉识图</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>上下文</span>
                  <input
                    type="number"
                    className="ag-input ag-tabular"
                    style={{ width: 104 }}
                    placeholder="128000"
                    value={draft.abilities.context_window ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        abilities: {
                          ...draft.abilities,
                          context_window:
                            e.target.value === '' ? undefined : Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>最大输出</span>
                  <input
                    type="number"
                    className="ag-input ag-tabular"
                    style={{ width: 96 }}
                    placeholder="16384"
                    value={draft.abilities.max_output_tokens ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        abilities: {
                          ...draft.abilities,
                          max_output_tokens:
                            e.target.value === '' ? undefined : Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
            )}

            {connectingFrom && !connectingFrom.dragging && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                  borderRadius: 'var(--ag-radius-sm)',
                  background: 'var(--ag-accent-subtle)',
                  border: '1px solid var(--ag-accent-border)',
                }}
              >
                <StatusBadge tone="info">连线中</StatusBadge>
                <span className="ag-mono" style={{ fontSize: 12 }}>
                  {connectingFrom.nodeId} ({portLabel(connectingFrom.port)}) → 目标节点
                </span>
                <button
                  type="button"
                  className="ag-btn ag-btn-sm"
                  onClick={() => setConnectingFrom(null)}
                >
                  取消连线
                </button>
              </div>
            )}

            {/* 主编辑区：左侧 2D 节点画布 + 右侧属性检查器 */}
            <div className="ag-route-editor-grid">
              {/* 2D 画布（支持右键菜单、DEL 删除、缩放与拖拽连线） */}
              <div
                ref={canvasRef}
                className="ag-route-canvas"
                tabIndex={0}
                onKeyDown={(e) => {
                  const tag = (document.activeElement?.tagName ?? '').toUpperCase();
                  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                  if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault();
                    if (selectedEdgeId) {
                      removeEdge(selectedEdgeId);
                    } else if (selectedNodeId && selectedNodeId !== draft.entry_node_id) {
                      deleteNode(selectedNodeId);
                    }
                  } else if (e.key === 'Escape') {
                    setContextMenu(null);
                    setConnectingFrom(null);
                    setWirePreview(null);
                  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
                    e.preventDefault();
                    if (selectedNodeId && selectedNodeId !== draft.entry_node_id) {
                      duplicateNode(selectedNodeId);
                    }
                  }
                }}
                onWheel={(e) => {
                  if (!e.ctrlKey && !e.metaKey) return;
                  e.preventDefault();
                  setZoom((z) => Math.min(1.5, Math.max(0.5, Number((z - e.deltaY * 0.001).toFixed(2)))));
                }}
                onPointerDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    panDragRef.current = {
                      startX: e.clientX,
                      startY: e.clientY,
                      origPanX: pan.x,
                      origPanY: pan.y,
                    };
                    setIsPanning(true);
                    return;
                  }
                  const targetEl = e.target as HTMLElement;
                  const onEmptyCanvas =
                    e.target === e.currentTarget || targetEl.dataset['canvasLayer'] === 'true';
                  if (e.button === 0 && onEmptyCanvas) {
                    setSelectedEdgeId(null);
                    canvasRef.current?.focus();
                    panDragRef.current = {
                      startX: e.clientX,
                      startY: e.clientY,
                      origPanX: pan.x,
                      origPanY: pan.y,
                    };
                    setIsPanning(true);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const el = canvasRef.current;
                  const rect = el?.getBoundingClientRect();
                  const cx = rect ? Math.round((e.clientX - rect.left - pan.x) / zoom) : 120;
                  const cy = rect ? Math.round((e.clientY - rect.top - pan.y) / zoom) : 120;
                  setContextMenu({
                    clientX: e.clientX,
                    clientY: e.clientY,
                    canvasX: cx,
                    canvasY: cy,
                    target: { kind: 'canvas' },
                  });
                }}
                style={{
                  position: 'relative',
                  height: 540,
                  overflow: 'hidden',
                  touchAction: 'none',
                  outline: 'none',
                  cursor: isPanning ? 'grabbing' : 'default',
                  borderRadius: 'var(--ag-radius-md)',
                  border: '1px solid var(--ag-border)',
                  backgroundColor: 'var(--ag-canvas)',
                  backgroundImage:
                    'radial-gradient(var(--ag-border-strong) 1px, transparent 1px)',
                  backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
                  backgroundPosition: `${pan.x}px ${pan.y}px`,
                }}
              >
                {/* 缩放与视图控制栏 */}
                <div
                  style={{
                    position: 'absolute',
                    top: 10,
                    left: 10,
                    zIndex: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '3px 8px',
                    borderRadius: 99,
                    background: 'var(--ag-surface)',
                    border: '1px solid var(--ag-border)',
                    boxShadow: 'var(--ag-shadow-sm)',
                    fontSize: 11,
                  }}
                >
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    style={{ padding: '0 6px', fontSize: 12 }}
                    onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.1).toFixed(2))))}
                  >
                    -
                  </button>
                  <span className="ag-mono ag-tabular">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    style={{ padding: '0 6px', fontSize: 12 }}
                    onClick={() => setZoom((z) => Math.min(1.5, Number((z + 0.1).toFixed(2))))}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="ag-btn ag-btn-sm"
                    style={{ padding: '0 6px', fontSize: 11 }}
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                  >
                    1:1
                  </button>
                </div>

                <div
                  data-canvas-layer="true"
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: 2400,
                    height: 1400,
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'top left',
                  }}
                >
                  {/* SVG 连线层 */}
                  <svg
                    width={2400}
                    height={1400}
                    viewBox="0 0 2400 1400"
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: 2400,
                      height: 1400,
                      overflow: 'visible',
                      pointerEvents: 'none',
                      zIndex: 1,
                    }}
                  >
                    {draft.edges.map((edge) => {
                      const src = draft.nodes.find((n) => n.id === edge.from);
                      const dst = draft.nodes.find((n) => n.id === edge.to);
                      if (!src || !dst) return null;
                      const p1 = getOutputSocketPos(src, edge.from_port);
                      const p2 = getInputSocketPos(
                        dst,
                        edge.from_port === 'script' ? 'script' : 'in',
                      );
                      const x1 = p1.x;
                      const y1 = p1.y;
                      const x2 = p2.x;
                      const y2 = p2.y;
                      const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
                      const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
                      const activeEdge =
                        simTraceMap.has(src.id) && simTraceMap.has(dst.id);
                      const isEdgeSelected = selectedEdgeId === edge.id;
                      const stroke = isEdgeSelected
                        ? 'var(--ag-danger)'
                        : activeEdge
                          ? 'var(--ag-accent)'
                          : portToneColor(edge.from_port);
                      return (
                        <g key={edge.id}>
                          <path
                            d={d}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={14}
                            style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEdgeId(edge.id);
                              setSelectedNodeId(null);
                              canvasRef.current?.focus();
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedEdgeId(edge.id);
                              setContextMenu({
                                clientX: e.clientX,
                                clientY: e.clientY,
                                canvasX: Math.round((x1 + x2) / 2),
                                canvasY: Math.round((y1 + y2) / 2),
                                target: { kind: 'edge', edgeId: edge.id },
                              });
                            }}
                          />
                          <path
                            d={d}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={isEdgeSelected ? 3 : activeEdge ? 2.6 : 2}
                            strokeDasharray={
                              edge.from_port === 'fallback' || edge.from_port === 'script'
                                ? '5 4'
                                : undefined
                            }
                          />
                        </g>
                      );
                    })}
                    {connectingFrom && wirePreview && (() => {
                      const src = draft.nodes.find((n) => n.id === connectingFrom.nodeId);
                      if (!src) return null;
                      const p1 = getOutputSocketPos(src, connectingFrom.port);
                      const x1 = p1.x;
                      const y1 = p1.y;
                      const x2 = wirePreview.x;
                      const y2 = wirePreview.y;
                      const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
                      return (
                        <path
                          d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={portToneColor(connectingFrom.port)}
                          strokeWidth={2.2}
                          strokeDasharray="4 3"
                        />
                      );
                    })()}
                  </svg>

                  {/* 连线标签与快捷操作 */}
                  {draft.edges.map((edge) => {
                    const src = draft.nodes.find((n) => n.id === edge.from);
                    const dst = draft.nodes.find((n) => n.id === edge.to);
                    if (!src || !dst) return null;
                    const p1 = getOutputSocketPos(src, edge.from_port);
                    const p2 = getInputSocketPos(
                      dst,
                      edge.from_port === 'script' ? 'script' : 'in',
                    );
                    const mx = (p1.x + p2.x) / 2;
                    const my = (p1.y + p2.y) / 2;
                    const isEdgeSelected = selectedEdgeId === edge.id;
                    return (
                      <div
                        key={`lbl_${edge.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEdgeId(edge.id);
                          setSelectedNodeId(null);
                          canvasRef.current?.focus();
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedEdgeId(edge.id);
                          setContextMenu({
                            clientX: e.clientX,
                            clientY: e.clientY,
                            canvasX: Math.round(mx),
                            canvasY: Math.round(my),
                            target: { kind: 'edge', edgeId: edge.id },
                          });
                        }}
                        style={{
                          position: 'absolute',
                          left: mx - 30,
                          top: my - 12,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: '1px 6px',
                          borderRadius: 99,
                          cursor: 'pointer',
                          background: 'var(--ag-surface)',
                          border: `1px solid ${isEdgeSelected ? 'var(--ag-danger)' : portToneColor(edge.from_port)}`,
                          fontSize: 11,
                          zIndex: 2,
                        }}
                      >
                        <span className="ag-mono">{portLabel(edge.from_port)}</span>
                        <button
                          type="button"
                          title="删除连线"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeEdge(edge.id);
                          }}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: 'var(--ag-danger)',
                            cursor: 'pointer',
                            padding: 0,
                            fontWeight: 700,
                            lineHeight: 1,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}

                  {/* 节点卡片 */}
                  {draft.nodes.map((node) => {
                    const isSelected = selectedNodeId === node.id;
                    const simStep = simTraceMap.get(node.id);
                    const isConnectingTarget =
                      connectingFrom !== null && connectingFrom.nodeId !== node.id;
                    const hasHook =
                      node.kind !== 'entry' &&
                      ((node.hook_script?.code.trim() ?? '') !== '' ||
                        draft.edges.some((e) => e.to === node.id && e.from_port === 'script'));
                    const borderColor =
                      simStep?.outcome === 'selected'
                        ? 'var(--ag-success)'
                        : simStep?.outcome === 'skipped' || simStep?.outcome === 'error'
                          ? 'var(--ag-warning)'
                          : isSelected
                            ? 'var(--ag-accent)'
                            : 'var(--ag-border-strong)';
                    const ports = portsForNode(node);

                    return (
                      <div
                        key={node.id}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          if ((e.target as HTMLElement).closest('button, [data-socket]')) return;
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId(null);
                          canvasRef.current?.focus();
                          dragRef.current = {
                            nodeId: node.id,
                            startX: e.clientX,
                            startY: e.clientY,
                            origX: node.position.x,
                            origY: node.position.y,
                          };
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedNodeId(node.id);
                          setSelectedEdgeId(null);
                          setContextMenu({
                            clientX: e.clientX,
                            clientY: e.clientY,
                            canvasX: node.position.x,
                            canvasY: node.position.y,
                            target: { kind: 'node', nodeId: node.id },
                          });
                        }}
                        style={{
                          position: 'absolute',
                          left: node.position.x,
                          top: node.position.y,
                          width: NODE_WIDTH,
                          minHeight: NODE_HEIGHT,
                          background: 'var(--ag-surface)',
                          border: `2px solid ${borderColor}`,
                          borderRadius: 'var(--ag-radius-md)',
                          boxShadow: isSelected ? 'var(--ag-shadow-md)' : 'var(--ag-shadow-sm)',
                          padding: '8px 10px',
                          cursor: 'grab',
                          userSelect: 'none',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          zIndex: isSelected ? 4 : 3,
                        }}
                      >
                        {/* 节点标题栏（固定高度 24px + 8px padding + 6px gap = 38px，对齐 SOCKET_ROW_TOP） */}
                        <div
                          style={{
                            height: 24,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 6,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            {node.kind === 'provider_target' && (
                              <ProviderIcon providerId={node.target.provider} size={18} />
                            )}
                            <span
                              style={{
                                fontWeight: 600,
                                fontSize: 13,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {node.label}
                            </span>
                          </div>
                          <StatusBadge
                            tone={
                              node.kind === 'entry'
                                ? 'info'
                                : node.kind === 'provider_target'
                                  ? 'success'
                                  : node.kind === 'js_script'
                                    ? 'warning'
                                    : 'neutral'
                            }
                          >
                            {nodeKindTitle(node.kind)}
                          </StatusBadge>
                        </div>

                        {/* ComfyUI 风格双侧输入/输出接口区（每行 22px，与 SVG 连线像素对齐） */}
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            alignItems: 'start',
                            marginLeft: -10,
                            marginRight: -10,
                          }}
                        >
                          {/* 左侧输入接口 */}
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            {node.kind !== 'entry' && (
                              <>
                                <div
                                  data-socket="in"
                                  title="拖拽至此连入主控制流 (in)"
                                  onPointerUp={(e) => {
                                    e.stopPropagation();
                                    if (isConnectingTarget) {
                                      connectNodes(connectingFrom.nodeId, connectingFrom.port, node.id);
                                      setWirePreview(null);
                                    }
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isConnectingTarget) {
                                      connectNodes(connectingFrom.nodeId, connectingFrom.port, node.id);
                                    }
                                  }}
                                  style={{
                                    height: SOCKET_ROW_H,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    cursor: 'crosshair',
                                  }}
                                >
                                  <span
                                    style={{
                                      marginLeft: -7,
                                      width: 12,
                                      height: 12,
                                      borderRadius: '50%',
                                      background: isConnectingTarget ? 'var(--ag-accent)' : 'var(--ag-surface)',
                                      border: `2px solid ${isConnectingTarget ? 'var(--ag-accent)' : 'var(--ag-border-strong)'}`,
                                      flexShrink: 0,
                                    }}
                                  />
                                  <span className="ag-secondary" style={{ fontSize: 11 }}>
                                    输入
                                  </span>
                                </div>
                                <div
                                  data-socket="script"
                                  title="固定 JS 脚本钩子端口 (script)"
                                  onPointerUp={(e) => {
                                    e.stopPropagation();
                                    if (isConnectingTarget) {
                                      connectNodes(connectingFrom.nodeId, 'script', node.id);
                                      setWirePreview(null);
                                    }
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isConnectingTarget) {
                                      connectNodes(connectingFrom.nodeId, 'script', node.id);
                                    }
                                  }}
                                  style={{
                                    height: SOCKET_ROW_H,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    cursor: 'crosshair',
                                  }}
                                >
                                  <span
                                    style={{
                                      marginLeft: -6,
                                      width: 10,
                                      height: 10,
                                      transform: 'rotate(45deg)',
                                      background: hasHook ? '#8b5cf6' : 'var(--ag-surface)',
                                      border: '2px solid #8b5cf6',
                                      flexShrink: 0,
                                    }}
                                  />
                                  <span style={{ fontSize: 11, color: '#8b5cf6' }}>
                                    脚本
                                  </span>
                                </div>
                              </>
                            )}
                          </div>

                          {/* 右侧输出接口（含 Provider 动态扩展点） */}
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                            {ports.map((p) => (
                              <div
                                key={p}
                                data-socket={`out:${p}`}
                                title={`从 ${portLabel(p)} 拖出连线`}
                                onPointerDown={(e) => {
                                  if (e.button !== 0) return;
                                  e.stopPropagation();
                                  const pos = getOutputSocketPos(node, p);
                                  setConnectingFrom({ nodeId: node.id, port: p, dragging: true });
                                  setWirePreview({ x: pos.x, y: pos.y });
                                }}
                                style={{
                                  height: SOCKET_ROW_H,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'flex-end',
                                  gap: 6,
                                  cursor: 'crosshair',
                                }}
                              >
                                <span style={{ fontSize: 11 }}>{portLabel(p)}</span>
                                <span
                                  style={{
                                    marginRight: -7,
                                    width: 12,
                                    height: 12,
                                    borderRadius: '50%',
                                    background: portToneColor(p),
                                    border: '2px solid var(--ag-surface)',
                                    boxShadow: `0 0 0 1px ${portToneColor(p)}`,
                                    flexShrink: 0,
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 节点摘要信息 */}
                        <div
                          className="ag-mono ag-secondary"
                          style={{
                            fontSize: 11,
                            paddingTop: 4,
                            borderTop: '1px dashed var(--ag-border)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {node.kind === 'entry' && `id: ${draft.id}`}
                          {node.kind === 'condition' &&
                            ([
                              node.condition.has_images !== undefined
                                ? `图:${node.condition.has_images ? '有' : '无'}`
                                : null,
                              node.condition.has_tools !== undefined
                                ? `工具:${node.condition.has_tools ? '有' : '无'}`
                                : null,
                              node.condition.min_estimated_tokens !== undefined
                                ? `>=${node.condition.min_estimated_tokens}tok`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '全放行')}
                          {node.kind === 'js_script' &&
                            `${node.script.code.split('\n')[0]?.slice(0, 26) ?? ''}`}
                          {node.kind === 'provider_target' &&
                            `${node.target.provider} / ${node.target.model}`}
                        </div>

                        {node.kind === 'provider_target' &&
                          Object.keys(node.target.provider_options ?? {}).length > 0 && (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {Object.entries(node.target.provider_options ?? {})
                                .filter(([, v]) => v !== undefined && v !== false && v !== '')
                                .slice(0, 3)
                                .map(([k, v]) => (
                                  <span
                                    key={k}
                                    className="ag-mono"
                                    style={{
                                      fontSize: 10,
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                      background: 'var(--ag-surface-raised)',
                                      border: '1px solid var(--ag-border)',
                                    }}
                                  >
                                    {k}={String(v)}
                                  </span>
                                ))}
                            </div>
                          )}
                      </div>
                    );
                  })}
                </div>

                {/* 右键上下文菜单 */}
                {contextMenu && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                    style={{
                      position: 'fixed',
                      left: contextMenu.clientX,
                      top: contextMenu.clientY,
                      zIndex: 9999,
                      minWidth: 168,
                      padding: 6,
                      borderRadius: 'var(--ag-radius-md)',
                      background: 'var(--ag-surface)',
                      border: '1px solid var(--ag-border-strong)',
                      boxShadow: 'var(--ag-shadow-md)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    {contextMenu.target.kind === 'canvas' && (
                      <>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => {
                            addNode('condition', { x: contextMenu.canvasX, y: contextMenu.canvasY });
                            setContextMenu(null);
                          }}
                        >
                          + 条件节点
                        </button>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => {
                            addNode('js_script', { x: contextMenu.canvasX, y: contextMenu.canvasY });
                            setContextMenu(null);
                          }}
                        >
                          + 脚本节点
                        </button>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => {
                            addNode('provider_target', { x: contextMenu.canvasX, y: contextMenu.canvasY });
                            setContextMenu(null);
                          }}
                        >
                          + 目标模型
                        </button>
                        <div style={{ height: 1, background: 'var(--ag-border)', margin: '2px 0' }} />
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => {
                            tidyLayout();
                            setContextMenu(null);
                          }}
                        >
                          整理布局
                        </button>
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => {
                            setZoom(1);
                            setPan({ x: 0, y: 0 });
                            setContextMenu(null);
                          }}
                        >
                          重置视图
                        </button>
                      </>
                    )}
                    {contextMenu.target.kind === 'node' && (() => {
                      const nid = contextMenu.target.nodeId;
                      const n = draft.nodes.find((x) => x.id === nid);
                      const isEntry = nid === draft.entry_node_id;
                      return (
                        <>
                          {n && n.kind !== 'entry' && !n.hook_script && (
                            <button
                              type="button"
                              className="ag-btn ag-btn-sm"
                              style={{ justifyContent: 'flex-start' }}
                              onClick={() => {
                                updateNode({
                                  ...n,
                                  hook_script: { code: 'return true;', timeout_ms: 50 },
                                });
                                setSelectedNodeId(nid);
                                setContextMenu(null);
                              }}
                            >
                              附加前置 JS 钩子
                            </button>
                          )}
                          {!isEntry && (
                            <button
                              type="button"
                              className="ag-btn ag-btn-sm"
                              style={{ justifyContent: 'flex-start' }}
                              onClick={() => {
                                duplicateNode(nid);
                                setContextMenu(null);
                              }}
                            >
                              复制节点
                            </button>
                          )}
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            style={{ justifyContent: 'flex-start' }}
                            onClick={() => {
                              disconnectNode(nid);
                              setContextMenu(null);
                            }}
                          >
                            断开连线
                          </button>
                          {!isEntry && (
                            <button
                              type="button"
                              className="ag-btn ag-btn-sm ag-btn-danger"
                              style={{ justifyContent: 'flex-start' }}
                              onClick={() => {
                                deleteNode(nid);
                                setContextMenu(null);
                              }}
                            >
                              删除节点
                            </button>
                          )}
                        </>
                      );
                    })()}
                    {contextMenu.target.kind === 'edge' && (() => {
                      const eid = contextMenu.target.edgeId;
                      return (
                        <>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            style={{ justifyContent: 'flex-start' }}
                            onClick={() => {
                              insertNodeOnEdge(eid, 'condition');
                              setContextMenu(null);
                            }}
                          >
                            插入条件节点
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm"
                            style={{ justifyContent: 'flex-start' }}
                            onClick={() => {
                              insertNodeOnEdge(eid, 'js_script');
                              setContextMenu(null);
                            }}
                          >
                            插入脚本节点
                          </button>
                          <button
                            type="button"
                            className="ag-btn ag-btn-sm ag-btn-danger"
                            style={{ justifyContent: 'flex-start' }}
                            onClick={() => {
                              removeEdge(eid);
                              setContextMenu(null);
                            }}
                          >
                            删除连线
                          </button>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* 右侧属性检查器 */}
              <div
                style={{
                  border: '1px solid var(--ag-border)',
                  borderRadius: 'var(--ag-radius-md)',
                  background: 'var(--ag-surface-raised)',
                  padding: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  height: 540,
                  overflowY: 'auto',
                }}
              >
                {selectedNode === null ? (
                  <span className="ag-secondary">点选节点查看属性</span>
                ) : (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <strong style={{ fontSize: 14 }}>
                        {nodeKindTitle(selectedNode.kind)}属性
                      </strong>
                      {selectedNode.id !== draft.entry_node_id && (
                        <button
                          type="button"
                          className="ag-btn ag-btn-sm ag-btn-danger"
                          onClick={() => deleteNode(selectedNode.id)}
                        >
                          删节点
                        </button>
                      )}
                    </div>

                    <div className="ag-field">
                      <label className="ag-field-label">节点名称</label>
                      <input
                        className="ag-input"
                        value={selectedNode.label}
                        onChange={(e) =>
                          updateNode({ ...selectedNode, label: e.target.value })
                        }
                      />
                    </div>

                    {/* 条件节点配置 */}
                    {selectedNode.kind === 'condition' && (
                      <>
                        <div className="ag-grid-2">
                          <div className="ag-field">
                            <label className="ag-field-label">图片要求</label>
                            <select
                              className="ag-select"
                              value={
                                selectedNode.condition.has_images === undefined
                                  ? 'any'
                                  : selectedNode.condition.has_images
                                    ? 'true'
                                    : 'false'
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                const next = { ...selectedNode.condition };
                                if (v === 'any') delete next.has_images;
                                else next.has_images = v === 'true';
                                updateNode({ ...selectedNode, condition: next });
                              }}
                            >
                              <option value="any">不限</option>
                              <option value="true">含图片</option>
                              <option value="false">纯文本</option>
                            </select>
                          </div>
                          <div className="ag-field">
                            <label className="ag-field-label">工具要求</label>
                            <select
                              className="ag-select"
                              value={
                                selectedNode.condition.has_tools === undefined
                                  ? 'any'
                                  : selectedNode.condition.has_tools
                                    ? 'true'
                                    : 'false'
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                const next = { ...selectedNode.condition };
                                if (v === 'any') delete next.has_tools;
                                else next.has_tools = v === 'true';
                                updateNode({ ...selectedNode, condition: next });
                              }}
                            >
                              <option value="any">不限</option>
                              <option value="true">含工具</option>
                              <option value="false">无工具</option>
                            </select>
                          </div>
                        </div>

                        <div className="ag-grid-2">
                          <div className="ag-field">
                            <label className="ag-field-label">最小Token</label>
                            <input
                              type="number"
                              className="ag-input ag-tabular"
                              value={selectedNode.condition.min_estimated_tokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                const next = { ...selectedNode.condition };
                                if (val === '') delete next.min_estimated_tokens;
                                else next.min_estimated_tokens = Number(val);
                                updateNode({ ...selectedNode, condition: next });
                              }}
                            />
                          </div>
                          <div className="ag-field">
                            <label className="ag-field-label">最大Token</label>
                            <input
                              type="number"
                              className="ag-input ag-tabular"
                              value={selectedNode.condition.max_estimated_tokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                const next = { ...selectedNode.condition };
                                if (val === '') delete next.max_estimated_tokens;
                                else next.max_estimated_tokens = Number(val);
                                updateNode({ ...selectedNode, condition: next });
                              }}
                            />
                          </div>
                        </div>

                        <div className="ag-field">
                          <label className="ag-field-label">包含关键词</label>
                          <input
                            className="ag-input"
                            value={selectedNode.condition.message_contains ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              const next = { ...selectedNode.condition };
                              if (val === '') delete next.message_contains;
                              else next.message_contains = val;
                              updateNode({ ...selectedNode, condition: next });
                            }}
                            placeholder="例如 SQL"
                          />
                        </div>
                      </>
                    )}

                    {/* 脚本节点配置 */}
                    {selectedNode.kind === 'js_script' && (
                      <>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {JS_SNIPPETS.map((snip) => (
                            <button
                              key={snip.label}
                              type="button"
                              className="ag-btn ag-btn-sm"
                              onClick={() =>
                                updateNode({
                                  ...selectedNode,
                                  script: { ...selectedNode.script, code: snip.code },
                                })
                              }
                            >
                              {snip.label}
                            </button>
                          ))}
                        </div>
                        <div className="ag-field">
                          <label className="ag-field-label">路由脚本 (JS)</label>
                          <textarea
                            className="ag-input ag-mono"
                            rows={8}
                            style={{ fontSize: 12, lineHeight: 1.5 }}
                            value={selectedNode.script.code}
                            onChange={(e) =>
                              updateNode({
                                ...selectedNode,
                                script: { ...selectedNode.script, code: e.target.value },
                              })
                            }
                          />
                        </div>
                        <div className="ag-grid-2">
                          <div className="ag-field">
                            <label className="ag-field-label">分支端口列表</label>
                            <input
                              className="ag-input ag-mono"
                              value={(selectedNode.script.ports ?? []).join(',')}
                              onChange={(e) =>
                                updateNode({
                                  ...selectedNode,
                                  script: {
                                    ...selectedNode.script,
                                    ports: e.target.value
                                      .split(',')
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  },
                                })
                              }
                              placeholder="fast,pro,fallback"
                            />
                          </div>
                          <div className="ag-field">
                            <label className="ag-field-label">超时(ms)</label>
                            <input
                              type="number"
                              className="ag-input ag-tabular"
                              value={selectedNode.script.timeout_ms ?? 50}
                              onChange={(e) =>
                                updateNode({
                                  ...selectedNode,
                                  script: {
                                    ...selectedNode.script,
                                    timeout_ms: Number(e.target.value) || 50,
                                  },
                                })
                              }
                            />
                          </div>
                        </div>
                      </>
                    )}

                    {/* 目标模型节点配置 + 服务商注入选项 */}
                    {selectedNode.kind === 'provider_target' && (
                      <ProviderTargetInspector
                        node={selectedNode}
                        providers={providers}
                        knownProviderIds={knownProviderIds}
                        accessPaths={accessPaths}
                        modelOptions={modelOptions}
                        telemetry={telemetry}
                        onChange={updateNode}
                      />
                    )}

                    {/* 通用前置 JS 脚本钩子（任意非入口节点均可固定接入） */}
                    {selectedNode.kind !== 'entry' && (
                      <div
                        style={{
                          paddingTop: 8,
                          borderTop: '1px solid var(--ag-border)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <strong style={{ fontSize: 12 }}>前置 JS 钩子</strong>
                          {selectedNode.hook_script ? (
                            <button
                              type="button"
                              className="ag-btn ag-btn-sm ag-btn-danger"
                              onClick={() => {
                                const next = { ...selectedNode };
                                delete next.hook_script;
                                updateNode(next);
                              }}
                            >
                              移除
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ag-btn ag-btn-sm"
                              onClick={() =>
                                updateNode({
                                  ...selectedNode,
                                  hook_script: {
                                    code: 'return true;',
                                    timeout_ms: 50,
                                  },
                                })
                              }
                            >
                              + 附加脚本
                            </button>
                          )}
                        </div>
                        {selectedNode.hook_script && (
                          <textarea
                            className="ag-input ag-mono"
                            rows={4}
                            style={{ fontSize: 12 }}
                            value={selectedNode.hook_script.code}
                            onChange={(e) =>
                              updateNode({
                                ...selectedNode,
                                hook_script: {
                                  ...selectedNode.hook_script!,
                                  code: e.target.value,
                                },
                              })
                            }
                            placeholder="return true;"
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* 实时模拟器面板 */}
          {simOpen && (
            <div className="ag-card" style={{ gap: 12 }}>
              <div className="ag-card-header">
                <h3 className="ag-card-title">路由模拟器</h3>
                <button
                  type="button"
                  className="ag-btn ag-btn-primary ag-btn-sm"
                  disabled={simulating}
                  onClick={() => void handleSimulate()}
                >
                  {simulating ? '运行中…' : '运行模拟'}
                </button>
              </div>

              <div className="ag-grid-2">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="ag-field">
                    <label className="ag-field-label">测试消息内容</label>
                    <textarea
                      className="ag-input"
                      rows={2}
                      value={simPrompt}
                      onChange={(e) => setSimPrompt(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Switch checked={simHasImages} onChange={setSimHasImages} />
                      <span>含图片</span>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Switch checked={simHasTools} onChange={setSimHasTools} />
                      <span>含工具</span>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Switch checked={simThinking} onChange={setSimThinking} />
                      <span>开启思考</span>
                    </label>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className="ag-field-label" style={{ margin: 0 }}>
                        Token
                      </span>
                      <input
                        type="number"
                        className="ag-input ag-tabular"
                        style={{ width: 96 }}
                        value={simTokens}
                        onChange={(e) => setSimTokens(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                {/* 模拟遥测覆盖 */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span className="ag-field-label">模拟额度覆盖</span>
                  {providersInDraft.map((pId) => {
                    const ov = simTelemetryOverrides[pId] ?? {};
                    return (
                      <div
                        key={pId}
                        style={{
                          display: 'flex',
                          gap: 8,
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          padding: '6px 8px',
                          borderRadius: 'var(--ag-radius-sm)',
                          border: '1px solid var(--ag-border)',
                        }}
                      >
                        <span className="ag-mono" style={{ minWidth: 90, fontWeight: 600 }}>
                          {pId}
                        </span>
                        <input
                          className="ag-input ag-tabular"
                          style={{ width: 82 }}
                          placeholder="余额"
                          value={ov.balance ?? ''}
                          onChange={(e) =>
                            setSimTelemetryOverrides({
                              ...simTelemetryOverrides,
                              [pId]: { ...ov, balance: e.target.value },
                            })
                          }
                        />
                        <input
                          className="ag-input ag-tabular"
                          style={{ width: 82 }}
                          placeholder="积分"
                          value={ov.remaining_credits ?? ''}
                          onChange={(e) =>
                            setSimTelemetryOverrides({
                              ...simTelemetryOverrides,
                              [pId]: { ...ov, remaining_credits: e.target.value },
                            })
                          }
                        />
                        <input
                          className="ag-input ag-tabular"
                          style={{ width: 88 }}
                          placeholder="5h次数"
                          value={ov.requests5h ?? ''}
                          onChange={(e) =>
                            setSimTelemetryOverrides({
                              ...simTelemetryOverrides,
                              [pId]: { ...ov, requests5h: e.target.value },
                            })
                          }
                        />
                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Switch
                            checked={Boolean(ov.offPeak)}
                            onChange={(next) =>
                              setSimTelemetryOverrides({
                                ...simTelemetryOverrides,
                                [pId]: { ...ov, offPeak: next },
                              })
                            }
                          />
                          <span style={{ fontSize: 12 }}>闲时</span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>

              {simResult && (
                <div
                  style={{
                    paddingTop: 10,
                    borderTop: '1px solid var(--ag-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {simResult.ok && simResult.attempt_plan ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <StatusBadge tone="success">命中序列</StatusBadge>
                      {simResult.attempt_plan.map((a, idx) => (
                        <span
                          key={`${a.access_path}_${a.model}_${idx}`}
                          className="ag-mono"
                          style={{
                            padding: '3px 8px',
                            borderRadius: 'var(--ag-radius-sm)',
                            border: '1px solid var(--ag-border-strong)',
                            background: 'var(--ag-surface-raised)',
                            fontSize: 12,
                          }}
                        >
                          #{idx + 1} {a.provider} / {a.model}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <StatusBadge tone="danger">{simResult.error ?? '无可用目标'}</StatusBadge>
                  )}

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {simResult.trace.map((step, i) => (
                      <span
                        key={`${step.node_id}_${i}`}
                        className="ag-mono"
                        style={{
                          fontSize: 11,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'var(--ag-surface-code)',
                        }}
                      >
                        {step.node_label}: {step.outcome} ({step.detail})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmModal
        open={deleteTarget !== null}
        title={`删除路由图 · ${deleteTarget?.id ?? ''}`}
        // ui-copy: allow 删除路由图二次确认的后果说明
        consequence="删除后该标识符请求将停止路由。"
        confirmLabel="确认删除"
        onConfirm={() => void handleDeleteGraph()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function ProviderTargetInspector({
  node,
  providers,
  knownProviderIds,
  accessPaths,
  modelOptions,
  telemetry,
  onChange,
}: {
  node: Extract<RouteGraphNodeDto, { kind: 'provider_target' }>;
  providers: readonly ProviderConfig[];
  knownProviderIds: readonly string[];
  accessPaths: readonly AccessPathDto[];
  modelOptions: readonly AvailableModelOption[];
  telemetry: RoutingTelemetryResponse;
  onChange: (next: RouteGraphNodeDto) => void;
}): React.JSX.Element {
  const { target } = node;
  const specs: ProviderRoutingOptionSpecDto[] = telemetry.provider_options[target.provider] ?? [];
  const snap = telemetry.snapshots[target.provider];
  const optsForProvider = modelOptions.filter(
    (m) => m.providerId === target.provider || m.accessPath === target.access_path,
  );
  const overrides: RouteParamOverrides = target.overrides ?? {};

  const updateTarget = (patch: Partial<typeof target>) => {
    onChange({ ...node, target: { ...target, ...patch } });
  };

  const updateProviderOption = (key: string, val: number | boolean | string | undefined) => {
    const next = { ...(target.provider_options ?? {}) };
    if (val === undefined || val === '') delete next[key];
    else next[key] = val;
    updateTarget({ provider_options: next });
  };

  const updateOverride = (patch: Partial<RouteParamOverrides>) => {
    const next: RouteParamOverrides = { ...overrides, ...patch };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === '') {
        delete next[k as keyof RouteParamOverrides];
      }
    }
    updateTarget({ overrides: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <>
      <div className="ag-field">
        <label className="ag-field-label">目标服务商</label>
        <input
          className="ag-input ag-mono"
          list="rg-provider-list"
          value={target.provider}
          onChange={(e) => {
            const pId = e.target.value;
            const found = providers.find((p) => p.id === pId);
            const firstModel = modelOptions.find((m) => m.providerId === pId);
            updateTarget({
              provider: pId,
              ...(found
                ? { access_path: `${found.id}.${found.dialect.replace('.', '-')}` }
                : firstModel
                  ? { access_path: firstModel.accessPath }
                  : {}),
              ...(firstModel ? { model: firstModel.model } : {}),
            });
          }}
        />
        <datalist id="rg-provider-list">
          {knownProviderIds.map((pId) => (
            <option key={pId} value={pId} />
          ))}
        </datalist>
      </div>

      <div className="ag-field">
        <label className="ag-field-label">接入端点</label>
        <input
          className="ag-input ag-mono"
          list="rg-ap-list"
          value={target.access_path}
          onChange={(e) => updateTarget({ access_path: e.target.value })}
        />
        <datalist id="rg-ap-list">
          {accessPaths.map((ap) => (
            <option key={ap.id} value={ap.id}>
              {ap.label}
            </option>
          ))}
        </datalist>
      </div>

      <div className="ag-field">
        <label className="ag-field-label">目标模型</label>
        <input
          className="ag-input ag-mono"
          list="rg-model-list"
          value={target.model}
          onChange={(e) => updateTarget({ model: e.target.value })}
        />
        <datalist id="rg-model-list">
          {optsForProvider.map((m) => (
            <option key={m.key} value={m.model} />
          ))}
        </datalist>
      </div>

      <div className="ag-grid-2">
        <div className="ag-field">
          <label className="ag-field-label">视觉能力检查</label>
          <Switch
            checked={Boolean(target.require_vision)}
            onChange={(next) => updateTarget({ require_vision: next })}
          />
        </div>
        <div className="ag-field">
          <label className="ag-field-label">上下文上限</label>
          <input
            type="number"
            className="ag-input ag-tabular"
            value={target.max_context_tokens ?? ''}
            onChange={(e) =>
              updateTarget({
                max_context_tokens: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </div>
      </div>

      {/* Provider 动态扩展分支端口 */}
      {(telemetry.provider_extensions?.[target.provider] ?? []).length > 0 && (
        <div
          style={{
            paddingTop: 8,
            borderTop: '1px solid var(--ag-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <strong style={{ fontSize: 12 }}>Provider 扩展端口</strong>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(telemetry.provider_extensions?.[target.provider] ?? []).map((ext) => {
              const active = (node.extension_ports ?? []).includes(ext.port);
              return (
                <button
                  key={ext.port}
                  type="button"
                  className={`ag-btn ag-btn-sm${active ? ' ag-btn-primary' : ''}`}
                  onClick={() => {
                    const prev = node.extension_ports ?? [];
                    const next = active
                      ? prev.filter((p) => p !== ext.port)
                      : [...prev, ext.port];
                    onChange({
                      ...node,
                      extension_ports: next.length > 0 ? next : undefined,
                    });
                  }}
                >
                  {active ? '✓ ' : '+ '}
                  {ext.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 服务商注入条件（无需写 JS） */}
      {specs.length > 0 && (
        <div
          style={{
            paddingTop: 8,
            borderTop: '1px solid var(--ag-border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <strong style={{ fontSize: 12 }}>服务商条件</strong>
          {specs.map((spec) => {
            const val = target.provider_options?.[spec.key];
            const currentVal = readPreviewTelemetry(snap, spec.telemetry_field);
            return (
              <div key={spec.key} className="ag-field">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <label className="ag-field-label" style={{ margin: 0 }}>
                    {spec.label}
                    {spec.unit ? ` (${spec.unit})` : ''}
                  </label>
                  {currentVal !== undefined && (
                    <span className="ag-tabular ag-secondary" style={{ fontSize: 11 }}>
                      当前 {String(currentVal)}
                    </span>
                  )}
                </div>
                {spec.type === 'boolean' ? (
                  <Switch
                    checked={val === true}
                    onChange={(next) => updateProviderOption(spec.key, next)}
                  />
                ) : (
                  <input
                    type="number"
                    className="ag-input ag-tabular"
                    value={typeof val === 'number' ? val : ''}
                    placeholder={
                      spec.default_value !== undefined ? String(spec.default_value) : '不限'
                    }
                    onChange={(e) =>
                      updateProviderOption(
                        spec.key,
                        e.target.value === '' ? undefined : Number(e.target.value),
                      )
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 参数覆盖 */}
      <div
        style={{
          paddingTop: 8,
          borderTop: '1px solid var(--ag-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 12 }}>参数覆盖</strong>
        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">思考开关</label>
            <select
              className="ag-select"
              value={
                overrides.thinking_enabled === undefined
                  ? 'keep'
                  : overrides.thinking_enabled
                    ? 'on'
                    : 'off'
              }
              onChange={(e) => {
                const v = e.target.value;
                updateOverride({
                  thinking_enabled: v === 'keep' ? undefined : v === 'on',
                });
              }}
            >
              <option value="keep">不改</option>
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
          </div>
          <div className="ag-field">
            <label className="ag-field-label">思考档位</label>
            <select
              className="ag-select"
              value={overrides.thinking_effort ?? ''}
              onChange={(e) =>
                updateOverride({
                  thinking_effort:
                    e.target.value === ''
                      ? undefined
                      : (e.target.value as RouteParamOverrides['thinking_effort']),
                })
              }
            >
              <option value="">不改</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </div>
        </div>

        <div className="ag-grid-2">
          <div className="ag-field">
            <label className="ag-field-label">温度</label>
            <input
              type="number"
              step="0.1"
              className="ag-input ag-tabular"
              value={overrides.temperature ?? ''}
              onChange={(e) =>
                updateOverride({
                  temperature: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </div>
          <div className="ag-field">
            <label className="ag-field-label">最大输出</label>
            <input
              type="number"
              className="ag-input ag-tabular"
              value={overrides.max_output_tokens ?? ''}
              onChange={(e) =>
                updateOverride({
                  max_output_tokens: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          </div>
        </div>

        <div className="ag-field">
          <label className="ag-field-label">追加系统提示</label>
          <input
            className="ag-input"
            value={overrides.system_prompt_append ?? ''}
            onChange={(e) => updateOverride({ system_prompt_append: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}

function readPreviewTelemetry(
  snap: ProviderTelemetrySnapshotDto | undefined,
  field: ProviderRoutingOptionSpecDto['telemetry_field'],
): number | boolean | undefined {
  if (snap === undefined) return undefined;
  switch (field) {
    case 'balance':
      return snap.balance;
    case 'granted_balance':
      return snap.granted_balance;
    case 'remaining_credits':
      return snap.remaining_credits;
    case 'credit_usage_pct':
      return snap.credit_usage_pct;
    case 'window_5h_requests':
      return snap.window_5h.requests;
    case 'window_5h_tokens':
      return snap.window_5h.tokens;
    case 'window_5h_cost_usd':
      return snap.window_5h.cash_usd;
    case 'upstream_remaining_requests':
      return snap.window_5h.upstream_remaining_requests;
    case 'is_off_peak':
      return snap.is_off_peak;
  }
}
