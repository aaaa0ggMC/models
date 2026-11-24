import React, { useMemo, useState } from 'react';
import { PageHeader, StatusBadge } from '../components/ui.js';
import { type HelpSectionId, updateQueryParams } from '../router.js';

interface HelpArticle {
  id: HelpSectionId;
  title: string;
  source: string;
  summary: string;
  bullets: readonly string[];
}

const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    id: 'overview',
    title: '概览与指标口径',
    source: 'docs/design/60-billing-and-dogfooding.md §2 · docs/design/90-admin-ui-redesign.md §4',
    summary:
      '概览页用于开门确认网关健康与区间花费。四张统计卡分别展示区间现金费用、请求数、Token 构成与未定价请求数，并附带与上一周期等长区间的环比对比。',
    bullets: [
      '环比颜色按指标语义区分：费用上涨以警告色提示，请求量与活跃度上涨以信息色提示。',
      '趋势图的桶宽由服务端按区间切分，空桶（0 次请求）在等距时间轴上原样保留为 0，绝不跳过或插值。',
      '时间范围筛选状态写入 URL 查询参数（?range=24h|7d|30d），刷新或复制链接不丢失筛选态。',
    ],
  },
  {
    id: 'plugins',
    title: '插件系统与内置工具',
    source: 'docs/design/30-plugin-api.md · plugins/host.ts · plugins/agent-admin.ts',
    summary:
      '网关插件基于规范中间格式（AG-IR）运行，可按需挂载到「内置 AI」或「API 访问」平面，并支持按客户端密钥细粒度放行或禁用。',
    bullets: [
      '内置管理工具集（agent-admin / ServerTools）本身即作为标准插件通过 /admin/api/plugins（Dogfooding）暴露状态、工具目录开关与执行日志。',
      '所有破坏性删除工具（delete_*）在对话中仅返回待确认状态，必须在工具卡片上点击「确认删除」后才会真正执行。',
      '插件宿主默认记录最近 300 条脱敏执行日志与各 Hook 耗时统计，便于线上排查。',
    ],
  },
  {
    id: 'channels',
    title: '渠道与服务商预设',
    source: 'docs/design/40-provider-adaptors.md · providers/presets.ts',
    summary:
      '每家上游服务商拥有独立的专属配置面板。内置八家预设（DeepSeek、OpenAI、Anthropic、Google Gemini、Moonshot、智谱 GLM、小米 MiMo、通义千问），其中四家社区/未实测预设明确标注 [待验证]。',
    bullets: [
      '选择预设后，面板自动带出官方文档链接、接入端点与协议，无需手填通用大表单。',
      '只有在选择「自定义」或展开底部「高级选项」折叠区时，才暴露协议覆盖与命名空间等低频项。',
      '「检测连通」按钮会真实向该渠道上游发起一次模型列表探测请求，不伪造本地连通状态。',
    ],
  },
  {
    id: 'modelFetch',
    title: '拉取上游模型清单與快照语义',
    source: 'docs/design/97-admin-product-brief.md §2.2 · admin/provider-models.ts',
    summary:
      '点击「获取模型」会调用 POST /admin/api/provider-models 直接向上游拉取模型元数据（上下文窗口、最大输出、模态、思考档位与行为约束），省去手打模型 ID。',
    bullets: [
      '预览模式（新建渠道）下传入的 API Key 仅在当次请求内存中使用，不落库、不进日志、不出现在错误响应里。',
      '上游未声明的元数据字段在表格中诚实展示为「未声明」，绝不编造默认值。',
      '保存后的模型清单默认保存为静态快照（static），避免上游临时下架模型悄悄改变线上路由；若需动态发现可在高级选项中显式开启。',
      '编辑已有渠道并重新拉取时，表格会标注每一项属于「上游新增」「已有」或「上游已移除」。',
    ],
  },
  {
    id: 'namespace',
    title: '模型命名空间（Namespace）',
    source: 'docs/design/20-pipeline.md §S2 · admin/aliases.ts',
    summary:
      '渠道可配置可选的命名空间前缀（如 ds）。留空时客户端直接使用上游模型名；填写后同时支持通过 <namespace>/<model>（如 ds/deepseek-flash）定向寻址该渠道。',
    bullets: [
      '命名空间只能包含字母、数字、点、下划线与短横线，且以字母或数字开头，最长 32 字符，不含斜杠 /。',
      '路由解析优先级从高到低依次为：显式精确别名 → 命名空间前缀 → 通用前缀规则 → 原样转发。',
    ],
  },
  {
    id: 'deepseekSuite',
    title: '服务商能力状态与内置工具注入',
    source: 'docs/design/50-builtin-search.md §2.2 · docs/design/85-modality-surface-matrix.md',
    summary:
      '面板中的「能力状态」采用三态只读展示（已接入 / 未接入 / 计划中），只反映后端真实支持面，不为尚未实现的配置面绘制假开关。',
    bullets: [
      'DeepSeek 渠道支持服务端默认注入 web_search（联网搜索）与 url_context（网页读取）两个内置工具。',
      '开启默认注入后，发往该渠道的请求若未声明同名工具会自动挂载，并经由编解码器完成方言映射。',
    ],
  },
  {
    id: 'credentials',
    title: '上游凭据与多密钥故障轮换',
    source: 'docs/design/45-credentials.md · MULTI-KEY-FAILOVER-REPORT.md',
    summary:
      '上游 API Key 只在创建时提交一次，入库后采用信封加密存储。任何列表、详情或编辑界面均只回显掩码（如 sk-****abcd）、前导位与长度，永不回显明文。',
    bullets: [
      '同一条接入端点（如 deepseek.openai-chat）可录入多把凭据，网关在请求链路上自动按健康度轮换与故障切换。',
      '用量记录会携带凭据标识（credential_id），可在凭据页和用量看板按单把凭据核对消耗。',
      '除直接录入密钥外，也支持登记进程环境变量引用（env:<VAR>），让密钥材料始终留在环境变量中。',
    ],
  },
  {
    id: 'clientKey',
    title: '客户端密钥（Virtual Keys）',
    source: 'docs/design/66-auth.md §2 · storage/virtual-keys.ts',
    summary:
      '客户端密钥用于数据面（/v1/* 与 /v1beta/*）的调用鉴权、配额限制与分账统计。每把密钥可独立限定允许访问的渠道、模型、每分钟请求数（RPM）、每分钟 Token（TPM）及预算上限。',
    bullets: [
      '完整明文密钥仅在创建响应（POST /admin/api/virtual-keys）中返回一次，关闭弹窗后无法再次查看。',
      '撤销密钥会立即阻断携带该密钥的所有数据面请求（返回 401），历史用量仍保留可查。',
    ],
  },
  {
    id: 'authMode',
    title: '数据面访问控制模式与互斥规则',
    source: 'docs/design/66-auth.md §1–§2 · auth/data-plane.ts',
    summary:
      '数据面遵循 deny-first（默认拒绝）原则，共有四档运行模式：客户端密钥模式（virtual_key）、单访问令牌模式（access_token）、显式放行模式（permissive）与未配置阻断模式（deny）。',
    bullets: [
      '当既未启用客户端密钥、未配置单访问令牌，也未显式开启免鉴权放行时，数据面处于 deny 模式，所有请求返回 503。',
      '界面严格区分「未配置访问控制（阻断）」与「显式放行」，避免管理员误判安全边界。',
    ],
  },
  {
    id: 'aliases',
    title: '模型路由图引擎、别名与优先级',
    source: 'docs/design/20-pipeline.md §S2 · gateway-core/routing-engine.ts · admin/aliases.ts',
    summary:
      '路由图引擎与模型别名表共同决定客户端请求模型名如何解析并编排故障切换序列。解析优先级从高到低为：启用的路由图（DAG）→ 精确别名 → 命名空间前缀 → 通用前缀 → 原样转发。',
    bullets: [
      '路由图（DAG）支持四类节点：入口（entry）、声明式条件分支（condition）、沙盒 JS 脚本（js_script）与目标模型（provider_target）。',
      '服务商注入选项（无需编写 JS）：目标节点自动渲染对应服务商声明的配额与状态条件，如 OpenAI Codex 的 5 小时请求/Token 上限、DeepSeek 的最低可用/赠送余额与闲时优惠时段、小米 MiMo 的 Token Plan 最低剩余积分与套餐已用比例上限。',
      'VM 沙盒 JS 节点运行在隔离的 node:vm 上下文中（默认 50ms 超时、禁用动态代码生成、不可访问 process/require/fetch），可通过只读 ctx.request、ctx.canonical、ctx.telemetry 与 ctx.credits 检查消息内容与余额积分，返回分支端口名或 { branch, target_node_id, overrides }。',
      '请求参数覆盖：目标节点或 JS 脚本可按本次命中的渠道动态覆盖 thinking_enabled、thinking_effort、temperature、max_output_tokens 与 system_prompt_append；当主节点上游失败时，S5 会基于原始规范请求重新应用备选节点的参数并跨协议重新编码。',
      '静态别名支持精确匹配（exact）与前缀匹配（prefix），按 priority 数值排序；顶部「路由解析预览」与「路由模拟器」可用于实时验证配置结果。',
    ],
  },
  {
    id: 'catalog',
    title: '模型目录与可用性判据',
    source: 'docs/design/15-modalities.md · catalog/visibility.ts',
    summary:
      '模型目录与数据面 GET /v1/models 同源，默认仅展示「已配置渠道或凭据」且非内部脚手架的模型；打开「包含未配置项」可查看全量能力矩阵。',
    bullets: [
      '模型下拉选择器严格遵循可用性判据：仅列出「渠道已启用 + 具备有效凭据」的模型，不置灰保留不可用项，也不提供手填绕过口。',
      '当没有任何可用模型时，选择器位置直接提示原因并提供「去建渠道」或「去录凭据」按钮。',
    ],
  },
  {
    id: 'usage',
    title: '用量计费、双口径成本与余额对账',
    source: 'docs/design/60-billing-and-dogfooding.md §3–§5',
    summary:
      '计量管道异步旁路运行，不阻塞推理主链路。每笔请求同时核算「现金费用（cash_total）」与「等价 API 价值（as_api_total）」，并统计因缺少价格表导致的「未定价请求数（unpriced_count）」。',
    bullets: [
      '未定价请求代表该模型尚无定价条目，不等于免费；看板将其单独列出以免掩盖真实成本。',
      '主动点击「查询上游余额」可拉取最新余额并与历史快照对账；当估算花费与实际扣减偏差超过阈值时，页面顶部会显示醒目告警横幅。',
    ],
  },
  {
    id: 'settings',
    title: '系统设置与四层配置优先级',
    source: 'docs/design/65-storage-and-retention.md §3 · config/settings.ts',
    summary:
      '运行时设置包含网关组（8 项）与内置助手组（13 项），修改后立即热生效，无需重启网关。',
    bullets: [
      '四层优先级从高到低为：加密存储（界面修改） > 环境变量（AG_*） > 配置文件 > 内置默认。',
      '环境变量锁：凡已由进程环境变量指定的配置项，界面展示为只读并标注变量名，防止界面覆盖造成多机部署行为不一致。',
      '点击「恢复默认」会删除加密存储中的覆盖记录，使生效值沿四层自然回落，来源标签诚实回到默认或下层来源。',
    ],
  },
  {
    id: 'keystore',
    title: '加密存储、主密钥（KEK）与数据密钥（DEK）轮换',
    source: 'docs/design/65-storage-and-retention.md §3.2 · storage/record-store.ts',
    summary:
      '凭据、设置与审计记录采用信封加密（AEAD + AAD 绑定记录类型与 ID）。支持口令派生（Argon2id）与密钥文件两种主密钥模式。',
    bullets: [
      '轮换数据密钥（DEK）会生成新数据密钥并将既有记录重加密至新密钥。',
      '轮换主密钥（KEK）属于破坏性操作，会使旧密钥表立即作废，界面必须经过二次确认方可触发。',
    ],
  },
  {
    id: 'agent',
    title: '内置对话（Dogfooding）与全链路隐私脱敏',
    source: 'docs/design/95-agent-chat.md · docs/design/96-chat-ui-port.md',
    summary:
      '内置对话复用网关自身的推理主链路（S0–S10），通过 8 个受控管理工具完成查渠道、查凭据、查模型、建渠道、发密钥、看用量、解析别名与测连通。',
    bullets: [
      '模型永不接触密钥明文：用户在输入框粘贴的疑似密钥串在发送前即由浏览器端脱敏规则与判定函数替换为占位符，并实时高亮提示。',
      '当添加渠道需要录入上游密钥时，工具只返回 needs_credential 状态，由界面弹出渠道编辑窗口提交密钥至加密存储。',
      '当签发客户端密钥时，明文经服务端旁路披露通道单次送达浏览器展示，不进入对话上下文与工具结果。',
      '推理模型的思考正文（reasoning）可展开查看；非推理模型未返回思考内容时整行不渲染。',
    ],
  },
  {
    id: 'modalities',
    title: '产品能力边界：九大模态与五个工具端点',
    source: 'docs/design/85-modality-surface-matrix.md §3–§4',
    summary:
      '管理面严格对齐网关真实支持面，不越界虚构未实现的能力。',
    bullets: [
      '九大模态：对话（chat，最完整）、语音合成（audio.tts，已接两家真实上游）、语音识别（audio.stt，已接两家真实上游）、向量嵌入（embeddings，入站与编码层已就绪）、图片生成（image.generate，入站与编码层已就绪）、结构化决策（decision，当前为确定性测试上游）、重排（rerank，占位）、内容审核（moderation，占位）、视频生成（video.generate，占位）。',
      '五个工具端点：搜索（search）、网页抓取（fetch）、文字识别（ocr）、语音识别（asr）、语音合成（tts），已接两家真实上游。',
    ],
  },
  {
    id: 'limitations',
    title: '尚未实现 / 待定项清单',
    source: 'docs/design/97-admin-product-brief.md §2.8 & §3.4',
    summary:
      '以下能力属于后端尚未采集或二期规划项，界面保留说明卡而绝不伪造 0% 或假图表：',
    bullets: [
      '单次请求耗时与 HTTP 状态码时序采集：后端计量层尚未记录逐请求延迟与状态码分布，故不展示 P50/P95/P99 延迟分位图与错误率曲线。',
      '请求级实时日志流：尚未提供按筛选下钻的单请求级日志尾巴页。',
      '提示词缓存读/写 Token 拆分：部分上游的缓存命中细分桶待计量层扩展，故不展示缓存命中率环图或卡片。',
      '单请求级路由分流轨迹（桑基图）与历史基线异常检测：属二期/三期规划。',
    ],
  },
];

export function HelpPage({
  query,
}: {
  query: URLSearchParams;
}): React.JSX.Element {
  const activeSection = (query.get('section') ?? '') as HelpSectionId | '';
  const [search, setSearch] = useState<string>('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return HELP_ARTICLES;
    return HELP_ARTICLES.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        a.source.toLowerCase().includes(q) ||
        a.bullets.some((b) => b.toLowerCase().includes(q)),
    );
  }, [search]);

  return (
    <div className="ag-page">
      <PageHeader
        title="帮助与设计规范"
        subtitle="所有规则、计费口径、安全边界与尚未实现项的集中说明，每节均标注出处。"
        actions={
          <input
            className="ag-input"
            style={{ width: 280 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索规则、术语或设计章节…"
          />
        }
      />

      {/* 快速目录导航 */}
      <div
        className="ag-card"
        style={{
          padding: 16,
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        {HELP_ARTICLES.map((art) => {
          const isCurrent = activeSection === art.id;
          return (
            <button
              key={art.id}
              type="button"
              className={`ag-btn ag-btn-sm${isCurrent ? ' ag-btn-primary' : ''}`}
              onClick={() => {
                updateQueryParams('help', { section: art.id });
                const el = document.getElementById(`help-${art.id}`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {art.title}
            </button>
          );
        })}
      </div>

      {/* 章节正文 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {filtered.map((art) => {
          const highlighted = activeSection === art.id;
          return (
            <section
              key={art.id}
              id={`help-${art.id}`}
              className="ag-card"
              style={
                highlighted
                  ? {
                      borderColor: 'var(--ag-accent)',
                      background: 'var(--ag-surface)',
                    }
                  : undefined
              }
            >
              <div className="ag-card-header">
                <h2 className="ag-section-title">{art.title}</h2>
                <StatusBadge tone={highlighted ? 'info' : 'neutral'}>
                  出处：{art.source}
                </StatusBadge>
              </div>
              <p style={{ margin: 0, color: 'var(--ag-text)' }}>{art.summary}</p>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 20,
                  color: 'var(--ag-text-secondary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {art.bullets.map((b, idx) => (
                  <li key={idx}>{b}</li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
