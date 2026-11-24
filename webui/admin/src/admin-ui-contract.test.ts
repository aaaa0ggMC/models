import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_TREE, parseHash, buildHref, helpHref } from './router.js';
import { computeModelAvailability } from './api/model-availability.js';
import { runClientRedaction } from './api/redaction.js';
import { classifyErrorCode } from './api/client.js';
import { DeltaBadge, StatusBadge } from './components/ui.js';
import { ModelCapabilityIcons } from './components/ModelCapabilityIcons.js';
import { TimeSeriesChart } from './components/charts.js';
import { AgentRunPanel } from './pages/AgentRunPanel.js';
import { HelpPage } from './pages/Help.js';

describe('97-admin-product-brief 关键 UI 契约测试', () => {
  it('§3.2 & §5 #4：信息架构分六组，单子项组（概览、对话）一律拍平为一级项，多子项组至少两项', () => {
    expect(NAV_TREE.length).toBe(6);
    expect(NAV_TREE[0]).toEqual({ kind: 'item', item: { id: 'overview', label: '概览' } });
    expect(NAV_TREE[1]).toEqual({ kind: 'item', item: { id: 'chat', label: '对话' } });

    const groups = NAV_TREE.slice(2);
    for (const node of groups) {
      expect(node.kind).toBe('group');
      if (node.kind === 'group') {
        expect(node.items.length).toBeGreaterThanOrEqual(2);
      }
    }

    // 客户端密钥与模型别名必须位于「客户端接入」组
    const clientGroup = NAV_TREE.find((n) => n.kind === 'group' && n.label === '客户端接入');
    expect(clientGroup).toBeDefined();
    if (clientGroup && clientGroup.kind === 'group') {
      expect(clientGroup.items.map((i) => i.id)).toEqual(['keys', 'aliases']);
    }
  });

  it('§3.3 & §5 #15：默认落地页为概览，筛选状态可写入并解析自 URL hash', () => {
    expect(parseHash('').route).toBe('overview');
    expect(parseHash('#/').route).toBe('overview');

    const href = buildHref('usage', { range: '7d' });
    expect(href).toBe('#/usage?range=7d');
    const parsed = parseHash(href);
    expect(parsed.route).toBe('usage');
    expect(parsed.query.get('range')).toBe('7d');

    expect(helpHref('channels')).toBe('#/help?section=channels');
  });

  it('§2.5 #3 & #4、§5 #5 & #6：模型选择器只列「已启用渠道 + 有可用凭据」的模型，并诚实诊断已保存但不可用的值', () => {
    // 1. 零渠道 → emptyReason 为 no_channel
    const snapNoChannel = computeModelAvailability({
      providers: [],
      credentials: [],
      envCredentials: [],
      accessPaths: [],
      capabilities: [],
    });
    expect(snapNoChannel.options).toHaveLength(0);
    expect(snapNoChannel.emptyReason).toBe('no_channel');
    expect(snapNoChannel.inspectSaved('deepseek-flash', 'deepseek.openai-chat')).toEqual({
      model: 'deepseek-flash',
      accessPath: 'deepseek.openai-chat',
      available: false,
      reason: '所属渠道尚未创建',
    });

    // 2. 有启用渠道但缺凭据 → emptyReason 为 no_credential，且不列任何模型
    const snapNoCred = computeModelAvailability({
      providers: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          dialect: 'openai.chat',
          base_url: 'https://api.deepseek.com',
          model_source: { kind: 'static', models: ['deepseek-flash'] },
          enabled: true,
          created_at: 1,
          updated_at: 1,
        },
      ],
      credentials: [],
      envCredentials: [],
      accessPaths: [
        { id: 'deepseek.openai-chat', label: 'DeepSeek', requires_credential: true },
      ],
      capabilities: [],
    });
    expect(snapNoCred.options).toHaveLength(0);
    expect(snapNoCred.emptyReason).toBe('no_credential');
    expect(snapNoCred.inspectSaved('deepseek-flash', 'deepseek.openai-chat')).toEqual({
      model: 'deepseek-flash',
      accessPath: 'deepseek.openai-chat',
      available: false,
      reason: '缺少可用凭据',
    });

    // 3. 补上 env 凭据或加密库凭据后 → 模型进入可用列表
    const snapReady = computeModelAvailability({
      providers: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          dialect: 'openai.chat',
          base_url: 'https://api.deepseek.com',
          model_source: { kind: 'static', models: ['deepseek-flash'] },
          enabled: true,
          created_at: 1,
          updated_at: 1,
        },
      ],
      credentials: [],
      envCredentials: [{ access_path: 'deepseek.openai-chat', count: 1 }],
      accessPaths: [
        { id: 'deepseek.openai-chat', label: 'DeepSeek', requires_credential: true },
      ],
      capabilities: [],
    });
    expect(snapReady.options.map((o) => o.model)).toEqual(['deepseek-flash']);
    expect(snapReady.emptyReason).toBeNull();
    expect(
      snapReady.inspectSaved('deepseek-flash', 'deepseek.openai-chat').available,
    ).toBe(true);
  });

  it('§2.7 #2 & §5 #11：浏览器端脱敏在发送前替换敏感串并统计命中区间', () => {
    const res = runClientRedaction('帮我测一下 sk-1234567890abcdef1234567890abcdef 这把钥匙', { // privacy-scan: ignore —— 脱敏单测用例假串
      placeholder: '<redacted_key>',
      builtinRules: [
        {
          id: 'sk',
          pattern: 'sk-[A-Za-z0-9]{20,}',
          flags: 'g',
          enabled: true,
        },
      ],
      userRules: [],
    });
    expect(res.hitCount).toBe(1);
    expect(res.redactedText).toBe('帮我测一下 <redacted_key> 这把钥匙');
  });

  it('§5 #10：错误按原因分类并提供下一步跳转动作', () => {
    const err = classifyErrorCode('key_invalid', '上游返回 401');
    expect(err.category).toBe('凭据无效');
    expect(err.actionRoute).toBe('channels');
  });

  it('§4.3：状态标签具备三编码（颜色 class + SVG 几何图标 + 文本），环比颜色按指标语义区分', () => {
    const badgeHtml = renderToStaticMarkup(
      React.createElement(StatusBadge, { tone: 'success', children: '已启用' }),
    );
    expect(badgeHtml).toContain('ag-badge-success');
    expect(badgeHtml).toContain('<svg');
    expect(badgeHtml).toContain('已启用');

    // 同样上涨 20%：费用卡是 warning，活跃度卡是 info
    const costUpHtml = renderToStaticMarkup(
      React.createElement(DeltaBadge, { deltaRatio: 0.2, metricKind: 'cost' }),
    );
    const activityUpHtml = renderToStaticMarkup(
      React.createElement(DeltaBadge, { deltaRatio: 0.2, metricKind: 'activity' }),
    );
    expect(costUpHtml).toContain('ag-badge-warning');
    expect(activityUpHtml).toContain('ag-badge-info');
  });

  it('§2.5 #3 & #4：AgentRunPanel 在零可用模型时不渲染 <select>，并保留已存不可用值的只读原因行', () => {
    const emptyAvailability = computeModelAvailability({
      providers: [],
      credentials: [],
      envCredentials: [],
      accessPaths: [],
      capabilities: [],
    });

    const html = renderToStaticMarkup(
      React.createElement(AgentRunPanel, {
        settings: [
          {
            id: 'agent_access_path',
            label: '渠道',
            description: '',
            unit: '',
            type: 'string',
            group: 'agent',
            value: 'deepseek.openai-chat',
            source: 'default',
            editable: true,
          },
          {
            id: 'agent_model',
            label: '模型',
            description: '',
            unit: '',
            type: 'string',
            group: 'agent',
            value: 'deepseek-flash',
            source: 'default',
            editable: true,
          },
        ],
        availability: emptyAvailability,
        savingId: null,
        onUpdateSetting: async () => undefined,
        onResetSetting: async () => undefined,
      }),
    );

    expect(html).not.toContain('<select');
    expect(html).toContain('没有可选的模型');
    expect(html).toContain('去建渠道');
    expect(html).toContain('当前保存的是');
    expect(html).toContain('deepseek-flash');
    expect(html).toContain('所属渠道尚未创建');
  });

  it('§3.4 & §5 #14：TimeSeriesChart 在缺数据源时渲染说明卡而不伪造曲线，HelpPage 包含完整出处与待定项', () => {
    const noSourceHtml = renderToStaticMarkup(
      React.createElement(TimeSeriesChart, {
        title: '费用趋势',
        buckets: [],
        available: false,
        valueOf: (b) => b.cash_total,
        formatValue: (v) => String(v),
      }),
    );
    expect(noSourceHtml).toContain('无数据源');
    expect(noSourceHtml).not.toContain('<svg viewBox="0 0 600 180"');

    const helpHtml = renderToStaticMarkup(
      React.createElement(HelpPage, { query: new URLSearchParams('section=limitations') }),
    );
    expect(helpHtml).toContain('尚未实现 / 待定项清单');
    expect(helpHtml).toContain('docs/design/97-admin-product-brief.md');
  });

  it('ModelCapabilityIcons 用紧凑图标展示模态与思考能力，并在 aria-label 中携带详细信息', () => {
    const chatHtml = renderToStaticMarkup(
      React.createElement(ModelCapabilityIcons, {
        category: 'chat',
        model: {
          id: 'gemini-2.5-pro',
          input_modalities: ['text', 'image', 'audio', 'video'],
          reasoning: true,
          effort: { levels: ['low', 'high'], default: 'high' },
        },
      }),
    );
    expect(chatHtml).toContain('ag-cap-icon');
    expect(chatHtml).toContain('ag-cap-icon-info');
    expect(chatHtml).toContain('aria-label="文本：输入模态"');
    expect(chatHtml).toContain('aria-label="图片：输入模态"');
    expect(chatHtml).toContain('aria-label="音频：输入模态"');
    expect(chatHtml).toContain('aria-label="视频：输入模态"');
    expect(chatHtml).toContain('aria-label="支持思考：档位：low / high（默认 high）"');
    expect(chatHtml).not.toContain('ag-badge');

    const ttsHtml = renderToStaticMarkup(
      React.createElement(ModelCapabilityIcons, {
        category: 'tts',
        model: {
          id: 'tts-1',
          input_modalities: ['text'],
          output_modalities: ['audio'],
        },
      }),
    );
    expect(ttsHtml).toContain('aria-label="输入：文本"');
    expect(ttsHtml).toContain('ag-cap-arrow');
    expect(ttsHtml).toContain('aria-label="输出：音频"');

    const emptyHtml = renderToStaticMarkup(
      React.createElement(ModelCapabilityIcons, {
        category: 'chat',
        model: { id: 'custom-model' },
      }),
    );
    expect(emptyHtml).toContain('未声明');
  });
});
