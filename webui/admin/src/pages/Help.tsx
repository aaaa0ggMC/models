/**
 * src/pages/Help.tsx —— 帮助 / 文档页：全站解释性文字的唯一集中地。
 *
 * 功能页只放表格 / 表单 / 控件与一句话摘要（「改完即生效」这种），细节都搬到这里；
 * 各页用 `helpHref('<section>')` 拼 `#/help?section=<id>` 深链指到对应小节，因此
 * 增删小节只动 router.ts 的 `HELP_SECTIONS` 一处。
 *
 * 小节锚点用 DOM `id` + `scrollIntoView` 定位，**不用** `<a href="#id">`：那会把
 * hash 改成 `#keystore`，hash 路由就会判到未知路由上去。
 *
 * 硬约束（承自 System.tsx，不得弱化）：`keystore` 小节的代价说明取自运行时
 * `bootstrap.keystore.tradeoff_note`（服务端原文，65-storage-and-retention.md §3.2b），
 * 整段展示——不截断、不改写、不"优化"；引导信息还没回来时显示加载态。
 *
 * 各节摘录一律**一字不改**（含 markdown 的反引号与 `**`，渲染时只做等宽 / 加粗映射）。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Table, Typography } from '@douyinfe/semi-ui';
import { useAuth } from '../auth';
import { HELP_SECTIONS, ROUTES, currentHelpSection, helpHref, type HelpSection } from '../router';

// ---------------------------------------------------------------------------
// 原文摘录的渲染（markdown 反引号 → 等宽，`**` → 加粗；字符本身不变）
// ---------------------------------------------------------------------------

/** 行内 markdown：`code` 渲染成等宽，`**bold**` 渲染成加粗。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split('`').forEach((chunk, ci) => {
    if (ci % 2 === 1) {
      out.push(
        <span key={`c${ci}`} style={{ fontFamily: 'monospace' }}>
          {chunk}
        </span>,
      );
      return;
    }
    chunk.split('**').forEach((piece, pi) => {
      if (piece === '') return;
      out.push(
        pi % 2 === 1 ? (
          <b key={`b${ci}-${pi}`}>{piece}</b>
        ) : (
          <span key={`t${ci}-${pi}`}>{piece}</span>
        ),
      );
    });
  });
  return out;
}

/** 一段原文摘录。 */
function Quote({ text }: { text: string }): JSX.Element {
  return <Typography.Paragraph style={{ marginBottom: 8 }}>{inline(text)}</Typography.Paragraph>;
}

/** 一组原文摘录（无序列表）。 */
function QuoteList({ items }: { items: string[] }): JSX.Element {
  return (
    <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>
      {items.map((t) => (
        <li key={t} style={{ marginBottom: 6 }}>
          {inline(t)}
        </li>
      ))}
    </ul>
  );
}

/** 小节来源标注（必须给出处文件名）。 */
function Source({ children }: { children: string }): JSX.Element {
  return (
    <Typography.Text type="tertiary" style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
      {children}
    </Typography.Text>
  );
}

/** 帮助页里的参考小表（列少行少，不需要分页 / 排序 / 空态）。 */
function MiniTable({ head, rows }: { head: string[]; rows: ReactNode[][] }): JSX.Element {
  return (
    <div style={{ marginBottom: 12 }}>
      <Table
        size="small"
        pagination={false}
        columns={head.map((h, i) => ({
          title: h,
          dataIndex: `c${i}`,
          render: (_: unknown, row: Record<string, ReactNode>) => row[`c${i}`],
        }))}
        dataSource={rows.map((r, ri) => {
          const row: Record<string, ReactNode> = { key: `r${ri}` };
          head.forEach((_, i) => {
            row[`c${i}`] = r[i] ?? '—';
          });
          return row;
        })}
        rowKey="key"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// settings：设置白名单与四层优先级
// ---------------------------------------------------------------------------

const SETTINGS_WHITELIST_NOTE = `白名单制，不是「所有配置都能热改」。可运行时改的项必须满足两个条件：改错了不会让网关起不来（所以端口 / host / 密钥路径不在内），以及有明确的取值范围（所以每一项都有 min–max 或枚举）。其余配置仍走环境变量与配置文件——那两层是要入 git / 入部署清单的，本来就不该被界面随便改。`;

const SETTINGS_PRIORITY_HEAD = `优先级（高 → 低）：加密存储 > 环境变量 > 配置文件 > 内置默认值。敏感值不在这张表里——它们只以 `;
const SETTINGS_PRIORITY_TAIL = ` 引用的形态登记，值永远留在进程环境里。`;

const SETTINGS_ENV_LOCK_NOTE = `环境变量是部署事实，界面写入会造出一个静默遮盖它的覆盖层，使同一份部署配置在不同机器上行为不同。请改环境变量并重启；要改用界面，先取消对应的 AG_* 变量。`;

const SETTINGS_HOT_NOTE = `改完不用重启：值直接写进 pipeline 读的那个 config 对象；重启后仍在（落在加密存储里，启动时应用回来）。`;

function SettingsSection(): JSX.Element {
  return (
    <div>
      <Source>
        实现摘录：config/settings.ts（文件头）·
        设计文档摘录：docs/design/65-storage-and-retention.md §3（敏感值规则）与 config/layering.ts
        的四层优先级
      </Source>
      <Quote text={SETTINGS_WHITELIST_NOTE} />

      <MiniTable
        head={['来源', '含义', '能不能改']}
        rows={[
          ['加密存储', '你在界面里改的值，最高优先级', '✅'],
          ['env', '部署环境变量，重启才变', '❌（env 锁）'],
          ['配置文件', 'config/*.json 里的非敏感默认值', '✅（改了会造一个更高层的覆盖）'],
          ['默认值', '编译期内置兜底', '✅'],
        ]}
      />

      <Typography.Paragraph style={{ marginBottom: 8 }}>
        {SETTINGS_PRIORITY_HEAD}
        <span style={{ fontFamily: 'monospace' }}>env:&lt;VAR&gt;</span>
        {SETTINGS_PRIORITY_TAIL}
      </Typography.Paragraph>

      <Typography.Title heading={6} style={{ marginTop: 12 }}>
        env 锁：被环境变量覆盖的项不可改
      </Typography.Title>
      <Quote text={SETTINGS_ENV_LOCK_NOTE} />
      <Typography.Paragraph type="tertiary" style={{ fontSize: 13, marginBottom: 0 }}>
        {SETTINGS_HOT_NOTE}
      </Typography.Paragraph>
    </div>
  );
}

// ---------------------------------------------------------------------------
// keystore：密钥层次、解锁档位与代价
// ---------------------------------------------------------------------------

const KEYSTORE_HIERARCHY: string[] = [
  `信封加密：DEK **随机生成**（\`crypto.randomBytes(32)\`），用 KEK **包裹（wrap，AES-256-KW / RFC 3394）**后存入密钥表（按 session 一行）。**不采用** \`DEK = HKDF(KEK, salt=session_id, …)\` 这种派生方式——派生下更换 KEK 会让所有 DEK 全部改变，必须重加密全部数据，与「轮换 KEK 只需重包 DEK」互斥。`,
  `为什么 per-session DEK + 包裹：密钥轮换与 nonce 管理一起解决——轮换 KEK 只需**重包**密钥表里的 DEK（unwrap → rewrap，数据密文不动），不必重加密全部数据；per-session 隔离让单个 DEK 的加密次数可控。`,
  `nonce：XChaCha20-Poly1305 + 192-bit 随机 nonce，**不做计数器持久化**。原方案的「session 内单调计数器」在进程重启、多 worker、多进程写同一个 session 时会重用 nonce，还隐含要求「写路径串行化」，与异步写入冲突。`,
  `代价与运维约束（同步写进部署文档）：① 密钥表成为新的单点——丢了 DEK 就丢了数据，备份 / 导出流程必须覆盖它，**密钥表与数据库必须一起备份**；② 解锁时要把该 session 的 DEK 取出来——采用**首次访问时惰性解**（按 \`session_key\` 逐行 unwrap 后进带 TTL 的内存缓存），不做启动时批量全解；③ 轮换 KEK 时按密钥表逐行重包，重包期间新写入用新 KEK 包裹的 DEK。`,
];

const KEYSTORE_TRADEOFF_PROSE: string[] = [
  `**所有密钥管理方案（A/B/C 三档、TPM-sealed、KMS/HSM）都不能防护"运行中进程内存被读取"。** 一旦网关解锁并开始服务，KEK 与解包出来的 DEK 就在进程内存里；任何能读该进程内存的攻击者（同账号的恶意代码、\`/proc/<pid>/mem\`、core dump、内存交换到磁盘）都能拿到密钥。`,
  `**无人值守自动解锁的本质是产品层取舍：用"无人值守"换"离线泄露防护"，这个取舍无法靠技术掩盖。**`,
  `**设计上的处置**（不掩盖，写进部署文档）：1. 部署文档必须明确告知用户这个边界，并给出"A 档更安全但网关不能自动重启"的显式选择；2. 提供**内存最小化**手段：解锁后从内存擦除口令原文（只保留 KEK）；DEK 按 session 解包、session 结束即弃（带 TTL 的缓存，见 §3.1）；不开 swap，或对持有密钥的内存页 \`mlock\`；3. **不把 B 档说成"安全"**，只说成"在无人值守前提下，比 C 档多一层（依赖 OS 凭据存储的访问控制）"；4. 若将来威胁模型变为"多用户同机"或"运行账号可能被攻陷"，再上 TPM/KMS 并重新评估。`,
];

const KEYSTORE_HONEST = `**诚实结论**：单机私有时，**B 档是推荐默认值**。要防"攻陷运行账号"需要 TPM-sealed key 或 KMS/HSM——调研样机无 TPM，且超出本项目范围（标 **\`[待验证]\`**：若部署机有 TPM，可用 \`tpm2-pkcs11\` 封存 KEK）。`;

function KeystoreSection(): JSX.Element {
  const { bootstrap, bootstrapError } = useAuth();
  const note = bootstrap?.keystore.tradeoff_note ?? '';

  return (
    <div>
      <Source>设计文档摘录：docs/design/65-storage-and-retention.md §3.1 / §3.2 / §3.2b</Source>

      <Typography.Title heading={6}>密钥层次（§3.1）</Typography.Title>
      <QuoteList items={KEYSTORE_HIERARCHY} />

      <Typography.Title heading={6}>三档来源（§3.2）</Typography.Title>
      <MiniTable
        head={['档', '密钥来源', '解锁方式', '适用', '取舍']}
        rows={[
          [
            'A',
            '用户口令',
            '启动时交互输入 → Argon2id → KEK',
            '有人值守',
            '最安全；网关无法自动重启',
          ],
          [
            'B（推荐默认）',
            'OS keyring / systemd credential 里的 KEK 或加密口令',
            '无人值守自动',
            '单机私用',
            inline('防「备份被拷走 / 库文件外泄」；**不防**攻陷运行账号'),
          ],
          [
            'C',
            '明文 key 文件 + 0600 权限 + 属主隔离',
            '无人值守',
            '完全无人值守、无 keyring 环境',
            '等同「密钥与数据同机」，只防拷贝',
          ],
        ]}
      />
      <Quote text={KEYSTORE_HONEST} />

      <Typography.Title heading={6}>运行时解锁模式（管理面「安全与密钥」页）</Typography.Title>
      <Quote
        text={`上表三档里，管理面能看 / 能轮换的是两档：\`passphrase\`（A 档，启动口令）与 \`key_file\`（C 档，密钥文件）。B 档（keyring）落在网关启动侧，不在管理面里配置。`}
      />

      <Typography.Title heading={6}>一条不能掩盖的取舍（§3.2b）</Typography.Title>
      <QuoteList items={KEYSTORE_TRADEOFF_PROSE} />
      <MiniTable
        head={['场景', 'A 档（启动口令）', 'B 档（keyring 自动）', 'C 档（key 文件）']}
        rows={[
          ['备份文件被拷走 / 库文件外泄', '✅ 防住', '✅ 防住', '✅ 防住'],
          ['攻陷运行账号（可读文件与 keyring）', '✅ 防住', '❌', '❌'],
          ['读运行中进程内存', '❌', '❌', '❌'],
          ['无人值守自动重启', '❌', '✅', '✅'],
        ]}
      />

      <Typography.Title heading={6}>当前部署的代价说明（服务端原文，一字不改）</Typography.Title>
      {bootstrap === null ? (
        <Typography.Text type="tertiary">
          {bootstrapError ?? '引导信息加载中，代价说明随后呈现……'}
        </Typography.Text>
      ) : note.length === 0 ? (
        <Typography.Text type="tertiary">服务端没有给出代价说明。</Typography.Text>
      ) : (
        <div
          style={{
            border: '1px solid var(--semi-color-warning)',
            background: 'var(--semi-color-warning-light-default)',
            borderRadius: 4,
            padding: 12,
          }}
        >
          <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{note}</Typography.Text>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// client-key：客户端三种带 key 方式
// ---------------------------------------------------------------------------

const CLIENT_KEY_RULES: string[] = [
  `明文 key **只在创建响应里返回一次**，之后只能看 \`key_id\` 与前 8 位。`,
  `永不明文入库（只存 Argon2id hash）；**不进日志、不进 trace、不进错误信息**。`,
  `客户端带 key 的方式：\`Authorization: Bearer sk-ag-…\`（OpenAI 风格）、\`x-api-key\`（Anthropic 风格）、\`?key=\`（Gemini 风格）——三种都接受，归一成同一个 \`key_id\`。`,
  `**单用户极简模式**：环境变量 \`AG_ACCESS_TOKEN\` 设一个值即可跑起来，不建 key 表。适合"只有我自己用"的部署。`,
  `限流与预算在 S0 检查（见 docs/design/20-pipeline.md §S0）。`,
];

function ClientKeySection(): JSX.Element {
  return (
    <div>
      <Source>设计文档摘录：docs/design/66-auth.md §2.2「规则」</Source>
      <QuoteList items={CLIENT_KEY_RULES} />
      <Typography.Paragraph type="tertiary" style={{ fontSize: 13, marginBottom: 0 }}>
        管理面「客户端密钥」页的「仅此一次」模态框就是第 1 条的实现：完整密钥只在新建响应里出现，
        关掉模态框即从内存里消失；列表与用量接口一律只回掩码与前 8 位。
      </Typography.Paragraph>
    </div>
  );
}

// ---------------------------------------------------------------------------
// aliases：别名三级优先级
// ---------------------------------------------------------------------------

const ALIASES_PRIORITY: string[] = [
  '1. `exact` —— 显式别名，全串相等（最高）',
  '2. `prefix` —— 前缀规则，按 (priority 升序, 模式长度降序) 取第一个命中',
  '3. `passthrough` —— 原样当作 provider 侧 model id（最低）',
];

const ALIASES_WHY: string[] = [
  `**为什么 exact 高于 prefix**：显式别名是管理员一个一个建的，意图最强；前缀规则是批量兜底。若反过来，一条手滑建的宽前缀规则会静默劫持所有显式别名——而这种劫持在请求路径上是看不见的（只是模型名被换了）。`,
  `**为什么 prefix 之间按「长度降序」**：\`deepseek/\` 与 \`deepseek/v4/\` 同时存在时，短规则先命中会把 \`deepseek/v4/pro\` 错误地归到短规则上。长度降序 = 最具体的规则优先，这是前缀匹配的常规语义（同 CIDR 最长前缀匹配）。`,
  `**passthrough 为什么存在**：客户端直接传上游 model id（\`deepseek-v4-pro\`）是常见用法，不该因为"没建别名"就 400。但它只在**该 model 确实在某个 provider 的能力矩阵里**时才放行，否则仍报 \`no_available_provider\`——否则任何拼写错误都会被当成一个合法模型名往上游打。`,
];

const ALIASES_WILDCARD: string[] = [
  `前缀规则的 \`pattern\` 支持两种形态：\`namespace/\`（以 \`/\` 结尾）→ 命名空间前缀，如 \`deepseek/\`；\`foo*\`（以 \`*\` 结尾）→ 简单通配，\`*\` 匹配任意剩余部分（**不含** \`/\`，所以 \`deepseek*\` 不会吃掉 \`deepseek/v4/pro\` 这种带子路径的）。`,
  '不支持正则：控制面规则是给人看的，正则的转义与灾难性回溯都是纯负担。',
];

function AliasesSection(): JSX.Element {
  return (
    <div>
      <Source>
        实现摘录：admin/aliases.ts（文件头）· 设计文档摘录：docs/design/20-pipeline.md §S2
      </Source>
      <Typography.Title heading={6}>
        解析优先级（写死在 admin/aliases.ts，有测试逐条覆盖）
      </Typography.Title>
      <QuoteList items={ALIASES_PRIORITY} />
      <QuoteList items={ALIASES_WHY} />
      <Typography.Title heading={6}>通配符</Typography.Title>
      <QuoteList items={ALIASES_WILDCARD} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// catalog：模型目录三层来源与 stale 语义
// ---------------------------------------------------------------------------

const CATALOG_LAYERS: string[] = [
  '1. `offline`：离线目录（vendored models.dev 快照）+ provider 静态表（`providers/<provider>/catalog-metadata.ts`：价格 / 并发 / supported_parameters…）。没有网络、没有 key 时也能答。',
  '2. `upstream`：上游实时发现（DeepSeek `GET /models`）。**运行时真值**——窗口 / 模态 / effort / constraints 以上游为准。',
  '3. `config`：本地配置覆盖（管理员修正）。优先级最高，用于纠正上游或离线目录的错误。',
];

const CATALOG_STALE: string[] = [
  '`ttlMs` 是**上游 TTL**：数据超过它就打 `stale` 标记。它不改变拉取行为（拉取由 `intervalMs` 驱动），只决定"这份数据还算不算新鲜"——两个旋钮分开，因为"多久拉一次"是成本问题，"多久算过期"是正确性问题。',
  '拉取失败时**保留上一份快照**（last-known-good），只记 `lastError`；`states()` 据此把记录标成 `stale: true` + `last_successful_fetch`，调用方看得见"这是旧数据"。从未成功过则没有快照，该层 simply 不贡献字段（矩阵种子值照常返回）。',
  '合并时**逐字段**记录来源（`provenance.fields`），所以「这个数字是谁说的」永远可查——这是本模块与「直接转发上游 /models」的本质区别。',
];

const CATALOG_TRIGGERS: string[] = [
  '1. **启动时同步**：`start()` 里先跑一次（`syncOnStart` 可关）。失败只记日志——静态能力表本来就可用，起不来服务没有任何理由。',
  '2. **周期性同步**：`intervalMs` 可配；经注入的 `TimerScheduler` 定时，测试里换成 `ManualScheduler` 就能用假时钟精确驱动（不睡真时间）。',
  "3. **管理员触发同步**：`syncNow('admin')`，由 HTTP 的管理员路由调用（token 门控）——即「模型目录」页顶部的「同步上游」。",
];

function CatalogSection(): JSX.Element {
  return (
    <div>
      <Source>实现摘录：catalog/types.ts + catalog/sync.ts（文件头）</Source>
      <Typography.Title heading={6}>分层优先级（低 → 高）</Typography.Title>
      <QuoteList items={CATALOG_LAYERS} />
      <Typography.Title heading={6}>stale 语义</Typography.Title>
      <QuoteList items={CATALOG_STALE} />
      <Typography.Title heading={6}>三种触发方式</Typography.Title>
      <QuoteList items={CATALOG_TRIGGERS} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// usage：用量双口径与对账
// ---------------------------------------------------------------------------

const USAGE_DUAL: string[] = [
  '`cost.cash_micros`：**实际现金支出**。订阅路径（`oauth_device_code` / `session_cookie`）为 **0**——那笔钱是月费，不随单次请求发生。',
  '`cost.as_api_micros`：**等值 API 计费**（同样的 tokens 若走 API key 会花多少）。订阅路径上游不给 usage 时，用 tokenizer 自估算 tokens × **当时** API 价格算出。',
  '**两者必须用同一次 `resolvePrice(ts)` 的结果**——同一次解析、同一组 rates，只是乘的单价不同；分开解析会出现"cash 按高峰价、as_api 按错峰价"这种无法解释的记录。',
];

const USAGE_RECONCILE: string[] = [
  '**我们的 computed cost 是估算，上游余额差是事实。** 两者**分开存储、分开展示，绝不互相覆盖**——估算带快照不可变（规则 a），事实按时点采样；用事实覆盖估算就等于重算历史。',
  '**只做区间级对账，不做逐笔归因。** 周期性快照余额，把「区间内余额差」与「区间内估算 cash 总和」对比，产出对账记录 `{ interval_start, interval_end, estimated_cash_micros, actual_balance_delta_micros, deviation_ratio, snapshot_ok }`。**理由：并发请求下无法把余额差归因到单笔请求**（多个请求的扣费在时间上重叠，且上游侧还有我们看不到的重试 / 计费时序）。偏差持续过大时告警——那意味着价格表、峰谷定档或 usage 归一有错，是需要人看一眼的信号，不是自动改写历史的许可。',
  '**未定价模型**：usd budget 对它永不扣也永不拦。必须 `is_priceable()` 预检，未定价的模型要么拒绝路由，要么显式标记 `unpriced` 并只记 token 不拦额度——这就是「用量看板」里「未定价请求」那一格的来历。',
];

function UsageSection(): JSX.Element {
  return (
    <div>
      <Source>
        设计文档摘录：docs/design/60-billing-and-dogfooding.md
        §4.2（「真值对账：余额即事实」「四条硬规则」「cash 与 as_api 的关系」）
      </Source>
      <Typography.Title heading={6}>双口径：cash 与 as_api</Typography.Title>
      <QuoteList items={USAGE_DUAL} />
      <Typography.Title heading={6}>四条硬规则</Typography.Title>
      <MiniTable
        head={['#', '规则']}
        rows={[
          [
            'a',
            inline(
              '**不可变 + 快照**：`UsageRecord` 写入后 `cost` 与 `price_snapshot` 只读；价格表更新**不得**重算已有记录',
            ),
          ],
          [
            'b',
            inline(
              '**请求时尝试计费**：拿不到价格 → `cost.status = "pending_price"`，**保留完整 usage**（不丢弃、不记 0）；确认无价的模型 → `unpriced`（只记 token，不拦额度）',
            ),
          ],
          [
            'c',
            inline(
              '**backfill 用请求时点**：按请求时间戳解析当时的「规则集 ∩ 节假日日历 ∩ 费率条目」，并记录 `backfilled_at` 与所用表版本——**绝不是用当前价格补历史**',
            ),
          ],
          [
            'd',
            inline(
              '**`as_api` 永远尝试计算**：订阅 / 无 usage 路径下它是唯一稳定的参考值；`cash` 与 `as_api` **分开存储、不合并、不相加**',
            ),
          ],
        ]}
      />
      <Typography.Title heading={6}>真值对账：余额即事实</Typography.Title>
      <QuoteList items={USAGE_RECONCILE} />
      <MiniTable
        head={['坑', '处理']}
        rows={[
          [
            inline('DeepSeek **赠送余额优先扣**'),
            inline(
              '余额差 ≠ 现金支出。对账记录必须能区分「扣的是赠送额还是现金额」，否则会把赠送额度消耗误报成现金超支',
            ),
          ],
          [
            inline('余额是**时点值**，快照失败 / 丢失会让区间对账出现缺口'),
            inline(
              '记录缺口（`snapshot_ok: false` + 缺口区间）而**不是假装连续**；缺口区间不参与偏差率计算，只计入「不可对账时长」指标',
            ),
          ],
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 小节注册表
// ---------------------------------------------------------------------------

interface SectionDef {
  /** router.ts `HELP_SECTIONS` 的键（深链 `?section=` 用的就是它）。 */
  key: HelpSection;
  title: string;
  /** 页面上的一句话摘要。 */
  summary: string;
  /** 指向对应功能页的入口。 */
  related: Array<{ label: string; href: string }>;
  Content: () => JSX.Element;
}

const SECTIONS: SectionDef[] = [
  {
    key: 'settings',
    title: '设置：白名单与四层优先级',
    summary: '为什么只有 8 项能热改，以及「加密存储 / env / 配置文件 / 默认值」谁盖谁。',
    related: [{ label: '系统设置', href: `#${ROUTES.settings}` }],
    Content: SettingsSection,
  },
  {
    key: 'keystore',
    title: '密钥：层次、解锁档位与代价',
    summary: 'KEK / DEK 怎么分层，两档解锁各让渡什么，以及那段不许改写的代价原文。',
    related: [{ label: '安全与密钥', href: `#${ROUTES.system}` }],
    Content: KeystoreSection,
  },
  {
    key: 'clientKey',
    title: '客户端密钥：三种带 key 方式',
    summary: 'Authorization / x-api-key / ?key= 三种都认，归一成同一个 key_id。',
    related: [{ label: '客户端密钥', href: `#${ROUTES.virtualKeys}` }],
    Content: ClientKeySection,
  },
  {
    key: 'aliases',
    title: '别名映射：三级优先级',
    summary: '显式别名 exact ＞ 前缀规则 prefix ＞ 原样 model id（passthrough）。',
    related: [{ label: '别名映射', href: `#${ROUTES.aliases}` }],
    Content: AliasesSection,
  },
  {
    key: 'catalog',
    title: '模型目录：三层来源与 stale',
    summary: 'offline / upstream / config 逐字段合并，上游过期时保留 last-known-good 并打 stale。',
    related: [{ label: '模型目录', href: `#${ROUTES.catalog}` }],
    Content: CatalogSection,
  },
  {
    key: 'usage',
    title: '用量看板：双口径与对账',
    summary:
      'cash 是实际现金、as_api 是等值 API 价值，两者分开存储不相加；区间级对账不做逐笔归因。',
    related: [{ label: '用量看板', href: `#${ROUTES.usage}` }],
    Content: UsageSection,
  },
];

export function Help(): JSX.Element {
  const [activeId, setActiveId] = useState<string>(HELP_SECTIONS.settings);

  const scrollTo = useCallback((id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setActiveId(id);
  }, []);

  // 深链 `#/help?section=<id>`：首屏与 hash 变化时都滚到对应小节。
  useEffect(() => {
    const apply = (): void => {
      const wanted = currentHelpSection();
      const hit = SECTIONS.find((s) => HELP_SECTIONS[s.key] === wanted);
      if (hit === undefined) return;
      const id = HELP_SECTIONS[hit.key];
      setActiveId(id);
      // 等一帧再滚：确保这一帧里页面已经渲染完。
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
      });
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  return (
    <div className="ag-help">
      <nav className="ag-help-nav" aria-label="帮助小节">
        <div className="ag-nav-group-label">小节</div>
        {SECTIONS.map((s) => {
          const id = HELP_SECTIONS[s.key];
          return (
            <Button
              key={s.key}
              theme="borderless"
              type={activeId === id ? 'primary' : 'tertiary'}
              block
              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => scrollTo(id)}
            >
              {s.title}
            </Button>
          );
        })}
      </nav>

      <div className="ag-help-body">
        <h1 className="ag-page-title">帮助 / 文档</h1>
        <p className="ag-page-desc" style={{ marginBottom: 20 }}>
          这里集中放各功能页搬过来的解释：设计结论、优先级规则与代价说明。每节都标了出处
          （设计文档章节或实现文件），需要原文时可顺着文件名去仓库里读。
        </p>

        {SECTIONS.map((s) => {
          const id = HELP_SECTIONS[s.key];
          const { Content } = s;
          return (
            <section
              key={s.key}
              id={id}
              style={{
                marginBottom: 28,
                paddingBottom: 22,
                borderBottom: '1px solid var(--ag-border)',
              }}
            >
              <Typography.Title heading={5} style={{ marginBottom: 4 }}>
                {s.title}
              </Typography.Title>
              <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: 12 }}>
                {s.summary}
              </Typography.Text>
              <Content />
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
                {s.related.map((r) => (
                  <a key={r.href} href={r.href}>
                    {r.label}
                  </a>
                ))}
                <a href={helpHref(s.key)}>固定链接</a>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
