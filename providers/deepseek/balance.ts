/**
 * providers/deepseek/balance.ts —— DeepSeek 余额查询端点 GET /user/balance 的 wire codec + 薄客户端。
 *
 * **这不是 chat pipeline 的一部分**（同目录 search.ts 顶部有完整说明）：不实现 Adaptor
 * 接口、不进 registry、不走 S0–S10。它是 standalone wire codec + 薄客户端。
 *
 * 唯一事实来源：DeepSeek 官方文档 api-docs.deepseek.com 的「查询余额」一节
 * （2026-11-14 核对）。要点：
 *   - GET https://api.deepseek.com/user/balance，Authorization: Bearer <key>
 *     ——与 chat 用**同一把 key**，没有额外鉴权（不用签名、不用额外 header）；
 *   - 响应 `{"is_available": bool, "balance_infos": [{currency, total_balance,
 *     granted_balance, topped_up_balance}]}`；
 *   - **四个金额字段是十进制字符串**（"110.00"）而不是数字——按 `typeof === 'number'`
 *     判会把所有金额当缺失，这是本文件最容易踩的坑；
 *   - 扣费顺序：**赠送余额（granted）优先扣，现金（topped_up）后扣**。所以「余额差」
 *     ≠ 现金支出，`total_balance` 更不能当现金口径用——字段名保持 granted / topped_up
 *     不改写，对账侧（metering/reconciliation.ts）按这个区分算；
 *   - **没有**官方的峰谷分档 / 实时价格 API（已核实，别去找）。定价归
 *     metering/pricing.ts，本文件只管「账上还有多少钱」。
 *
 * 与同目录其他端点的分工：search / fetch / ocr / asr / tts 是**能力端点**（按次 / 按页 /
 * 按秒计费，要产 canonical usage）；balance 是**账目端点**——它本身不计费、不产 usage，
 * 只被 metering/reconciliation.ts 周期性消费，用于区间对账与低余额信号。
 *
 * 共享错误类型（`DeepSeekApiError` / `throwIfNotOk`）从 search.ts import，不重新定义
 * （那里写了为什么落在 search.ts）。
 */

import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
// `Clock` 按仓库硬约束从 ir/clock.ts 取（di/ports.ts 里那份是同名副本）：模块里禁止直接
// `Date.now()`，否则 fetched_at 在测试里不可控。
import type { Clock } from '../../ir/clock.js';
import { DEEPSEEK_DEFAULT_BASE_URL, DeepSeekApiError, throwIfNotOk } from './search.js';

/** 错误载体从 search.ts 再出口，便于调用方从任一端点文件 import 同一个类（同 fetch.ts）。 */
export { DeepSeekApiError };

// ---------------------------------------------------------------------------
// 端点常量
// ---------------------------------------------------------------------------

/**
 * 余额端点路径。
 *
 * 注意它**不带 /v1**：DeepSeek 的账户类端点自成一组（/user/balance、/user/api_keys…），
 * 与 chat 的 /chat/completions、工具端点的 /v1/tools/* 都不是一个 dialect。照抄
 * /v1 前缀会 404。
 */
export const DEEPSEEK_BALANCE_PATH = '/user/balance';

// ---------------------------------------------------------------------------
// wire 类型
// ---------------------------------------------------------------------------

/**
 * 单个币种的余额（wire 形状）。
 *
 * 四个字段**全是字符串**（十进制金额，如 "110.00"），不是 number——上游就是这么发的。
 * 保持 string 而不是在 decode 阶段就转 number：原文保留才能对账（"1e+21" 这种指数形态
 * 一旦过一遍 Number→String 就再也回不去了），转换由 `parseDecimalOrZero` 显式做。
 */
export interface DeepSeekBalanceInfo {
  /** 币种，文档枚举 CNY / USD。缺失时落空串（见 decodeBalanceInfo）。 */
  currency: string;
  /** 总余额 = granted + topped_up。 */
  total_balance: string;
  /** 赠送余额（**优先扣**的那部分）。 */
  granted_balance: string;
  /** 现金充值余额（赠送扣完才扣的部分）。 */
  topped_up_balance: string;
}

/** 余额响应体。 */
export interface DeepSeekBalanceResponse {
  /** 账号当前是否可用。缺失 / 类型不对时落 true（见 decodeBalanceResponse 的理由）。 */
  is_available: boolean;
  /** 按币种分列的余额；上游没给或给的不是数组时是空数组。 */
  balance_infos: DeepSeekBalanceInfo[];
  /**
   * 上游响应体原文（**整包**，不是"只放未知键"）。
   *
   * 未建模顶层键自然在其中（raw passthrough 立场，同 search.ts 的 raw）；调用方要
   * 「整包原样」时用它，不要重新序列化 balance_infos。原样引用，调用方不要改。
   */
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// decode：wire → 类型化形状（不猜也不丢）
// ---------------------------------------------------------------------------

/** 任意 unknown → object（不是 object 时返回 undefined）。decode 的前向兼容底座。 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** 字符串字段读取：只认 string，其余 undefined（调用方决定默认值）。 */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 布尔字段读取：只认 boolean，其余 undefined（调用方决定默认值）。 */
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * 金额字段读取：文档是**十进制字符串**，故：
 *   - string 原样留下（连 ' 110.00 ' 的首尾空白都不动——`parseDecimalOrZero` 会 trim，
 *     这里重新格式化反而会把指数形态改写得认不出来）；
 *   - number 归一成字符串：上游版本漂移时可能偷发数字，收成字符串至少不丢量；
 *   - 其余（null / undefined / object / 不可解析）落 '0'。
 *
 * 落 '0' 而不是空串：空串要靠调用方再判一次，而 '0' 在任何下游（含直接塞进
 * `parseDecimalOrZero`）都是可用的。真正要区分「上游缺字段」与「上游真的是 0」，
 * 看 `raw`——那里有原文。
 */
function amount(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '0';
}

/**
 * 响应体 → 类型化余额响应。**不抛**：非 object、`balance_infos` 不是数组、数组里混着
 * 非 object 条目，全部退化成「空列表 + raw 留原文」，让调用方按"这轮没读到余额"处理
 * 而不是炸掉周期任务。
 *
 * `is_available` 缺字段 / 类型错时落 **true**（不猜「不可用」）：缺字段不等于余额耗尽，
 * 误判成 false 会把路由整体切到订阅路径、让周期任务误报；真实不可用时上游会在请求上
 * 返回 402，宁可晚一步知道，也不要因为一次坏响应就自断流量。
 *
 * `balance_infos` 里**非 object 的条目整条丢弃**：它不含任何金额信息（原文还在
 * `raw.balance_infos` 里可查），而保留成一条全 '0' 的假条目会污染按币种的分组——
 * 凭空多一个 '' 币种桶，还会把低余额信号误导亮起来。
 */
export function decodeBalanceResponse(raw: unknown): DeepSeekBalanceResponse {
  const obj = asRecord(raw);
  const rawInfos = obj?.['balance_infos'];
  const balance_infos = Array.isArray(rawInfos)
    ? rawInfos.filter((e) => asRecord(e) !== undefined).map((e) => decodeBalanceInfo(e))
    : [];
  return {
    is_available: bool(obj?.['is_available']) ?? true,
    balance_infos,
    raw,
  };
}

/** 单币种余额 → 类型化形状。缺字段落 '0' / ''（理由见 amount）。 */
function decodeBalanceInfo(entry: unknown): DeepSeekBalanceInfo {
  const r = asRecord(entry) ?? {};
  return {
    // 币种缺失落空串而不是猜一个（比如默认 USD）：猜错币种等于把一份 CNY 的余额
    // 当成 USD 去比偏差率，数值全错；空串是「上游没给」的哨兵，调用方按独立桶处理。
    currency: str(r['currency']) ?? '',
    total_balance: amount(r['total_balance']),
    granted_balance: amount(r['granted_balance']),
    topped_up_balance: amount(r['topped_up_balance']),
  };
}

/**
 * 十进制字符串 → number；不可解析 / 非字符串数字一律 **0，不抛**。
 *
 * 为什么不抛：对账是周期性任务，一次坏响应（HTML 错误页、字段被换成 null、上游改了
 * 字段名）不能让整轮对账炸掉——宁可记 0 + 保留 `raw` 让人事后看出「这笔没解析出来」，
 * 也不要抛异常把这一轮所有币种的对账一起带走。分母为 0 的后续风险由
 * metering/reconciliation.ts 兜（deviation_ratio 记 null，不除零）。
 *
 * 另收有限 number（规格只要求字符串）：上游版本漂移时可能把金额偷发成数字，把它当
 * 0 会让对账凭空少记一笔支出，而当金额处理只可能错在「上游确实想发数字」这一种
 * 情况——前者是静默丢数据，后者本来就是数字。
 */
export function parseDecimalOrZero(v: unknown): number {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return 0;
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  return 0;
}

// ---------------------------------------------------------------------------
// 薄客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（横切能力全部注入：传输、鉴权头、时钟；无模块级单例）。 */
export interface DeepSeekBalanceClientDeps {
  transport: Transport;
  /** 产出鉴权头（含 Authorization: Bearer <key>）。每次快照重新取，便于轮换 key。 */
  headersProvider: () => Promise<Record<string, string>>;
  /** 上游 base URL，默认 DEEPSEEK_DEFAULT_BASE_URL（与 chat / 工具端点同源）。 */
  baseUrl?: string;
  /** 端点路径，默认 DEEPSEEK_BALANCE_PATH。 */
  path?: string;
  /** 时钟（ir/clock.ts 的 Clock）。缺省用一个读系统时间的实现——只为「忘了注入」兜底。 */
  clock?: Clock;
}

/** snapshot() 的返回。 */
export interface DeepSeekBalanceSnapshot {
  /** 上游 HTTP 状态码（2xx）。 */
  status: number;
  /** 解码后的余额（坏形状也不抛，见 decodeBalanceResponse）。 */
  balance: DeepSeekBalanceResponse;
  /** 本次余额的**观测时刻**（epoch ms，取响应返回之后，见 snapshot() 的注释）。 */
  fetched_at: number;
}

export class DeepSeekBalanceClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly clock: Clock;

  constructor(deps: DeepSeekBalanceClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.baseUrl = deps.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
    this.path = deps.path ?? DEEPSEEK_BALANCE_PATH;
    this.clock = deps.clock ?? { now: () => Date.now() };
  }

  /**
   * 打一次余额快照。
   *
   * `fetched_at` 取**响应返回之后**的时刻：它标注的是「这个余额数据的观测时刻」。
   * 请求前取会让 fetched_at 早于数据本身，跨主机比较时甚至算出负的区间长度。
   *
   * 非 2xx 抛 `DeepSeekApiError`（status + 解析后的错误体）——401（key 失效）与 402
   * （余额不足）在这个端点上的处置完全不同（换 key vs 停止路由），吞掉状态码就没法决策。
   *
   * 传输层错误（连接失败 / 超时）原样上抛：周期任务自己决定重试与退避，客户端不猜。
   */
  async snapshot(): Promise<DeepSeekBalanceSnapshot> {
    // GET：不带 body，也不带 content-type——没有 body 可描述，发了反而让某些代理
    // 按带 body 的语义处理。
    const headers: Record<string, string> = { ...(await this.headersProvider()) };
    const upstream: UpstreamRequest = {
      method: 'GET',
      base_url: this.baseUrl,
      path: this.path,
      headers,
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const bodyText = (res.body ?? Buffer.alloc(0)).toString('utf8');
    throwIfNotOk(res, bodyText, 'balance');

    return {
      status: res.status,
      balance: decodeBalanceResponse(parseJsonOrUndefined(bodyText)),
      fetched_at: this.clock.now(),
    };
  }
}

/** 响应体 JSON 解析：失败返回 undefined（decodeBalanceResponse 会把非 object 当空响应）。 */
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
