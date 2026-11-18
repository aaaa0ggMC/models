/**
 * providers/mimo/balance.ts —— MiMo 官方计费/余量查询客户端（对账真值源）。
 *
 * ## 为什么有两个端点而不是一个
 *
 * MiMo 官方把「钱」分成两个**不互通**的渠道（按量计费页明文），各自有独立的查询接口
 * 与**独立的 key 类型要求**（官方文档逐页明文）：
 *
 * | 渠道 | key 前缀 | 查询端点 | 返回 |
 * | --- | --- | --- | --- |
 * | Token Plan 套餐（订阅） | `tp-` | `GET {token-plan-host}/v1/platform/token_plan` | 周期积分额度（total/used/remaining credits） |
 * | 按量计费（现金） | `sk-` | `GET {api-host}/v1/platform/balance` | 现金/赠金/冻结/授信余额 |
 *
 * 两个端点还挂在**不同 host** 上（文档各自的「请求地址」）：token_plan 在 Token Plan
 * 专属 host，balance 在普通 API host。所以客户端两个 base 都收，按计费路径形态选。
 *
 * 本仓库的 key 是 `tp-`（Token Plan 中国区），因此 `tokenPlan()` 是默认路径；
 * `balance()` 在拿到 `sk-` key 的部署里才可用（实测：用 `tp-` key 打 balance 返 401
 * `invalid_api_key`，与文档「需使用普通 API Key `sk-`」一致）。
 *
 * ## 与 DeepSeek balance.ts 的关系
 *
 * 同款立场（那次是「赠送余额优先扣，余额差不等于现金支出」）：这里的积分额度也是
 * **区间级**真值——`used_credits` 是周期累计，网关算的是逐请求 as_api 估值，两者
 * 相减得到的是「这个区间内上游认为我们用了多少」，可以与我们的 as_api 汇总对账。
 * **不做逐笔核对**：上游不提供逐笔流水（`/v1/platform/consumption` 与
 * `/v1/platform/daily_bill` 在 Token Plan host 上实测 404，它们在普通 API host 上且
 * 需要 `sk-` key）。
 *
 * 计量单位注意：上游积分（credits）与「等价 API 价值（as_api，按官方按量费率折算的
 * 钱）」是**两个不同的量纲**。本客户端只原样交出积分数字，不做 credits→钱的换算——
 * 官方没有公布 credits 与元的固定兑换率（Token Plan 套餐页按档位给额度），任何换算
 * 都是编造。
 */

import type { Transport, UpstreamRequest } from '../../gateway-core/transport.js';
import type { BillingMode } from '../../credentials/resolver.js';

/**
 * Token Plan 专属 host（官方文档「查询套餐余量」页的请求地址）。
 *
 * **只到 host，`/v1` 在路径里**：transport 用 `new URL(path, base_url)` 拼地址，
 * base 带路径时绝对路径会把它**整段替换掉**——写成 `.../v1` + `/platform/token_plan`
 * 会拼出 `.../platform/token_plan`（少一段 /v1 → 上游 404）。这个坑 2026-11 在
 * chat 路径上踩过一次，这里不再踩第二次；`tests/mimo-pricing.test.ts` 有哨兵断言。
 */
export const MIMO_TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com';

/** 普通 API host（官方文档「查询账号余额」页的请求地址）。 */
export const MIMO_API_BASE_URL = 'https://api.xiaomimimo.com';

/** Token Plan 余量端点（需 `tp-` key；官方文档写的请求地址含 /v1）。 */
export const MIMO_TOKEN_PLAN_PATH = '/v1/platform/token_plan';

/** 账号余额端点（需 `sk-` key；官方文档写的请求地址含 /v1）。 */
export const MIMO_BALANCE_PATH = '/v1/platform/balance';

// ---------------------------------------------------------------------------
// 响应类型
// ---------------------------------------------------------------------------

/** 套餐周期（UTC 时间串，官方格式 `YYYY-MM-DD HH:mm:ss`）。 */
export interface MiMoPlanPeriod {
  start_at: string;
  end_at: string;
}

/** 周期积分额度。 */
export interface MiMoPlanQuota {
  /** 周期总额度（含补偿积分）。 */
  total_credits: number;
  /** 周期已用积分。 */
  used_credits: number;
  /** 周期剩余积分 = max(0, 总额度 - 已用)。 */
  remaining_credits: number;
}

/** `GET /platform/token_plan` 响应（Token Plan 渠道）。 */
export interface MiMoTokenPlanInfo {
  object: 'token_plan';
  /** 套餐标识（如 "pro"）。 */
  plan_code: string;
  period: MiMoPlanPeriod;
  quota: MiMoPlanQuota;
  auto_renew: boolean;
  claw_enabled: boolean;
  /** 上游响应体原文（未建模顶层键不丢；恒存在）。 */
  raw: Record<string, unknown>;
}

/** 单币种余额明细（官方字段；金额是**字符串**，与 DeepSeek 的 balance 同款）。 */
export interface MiMoBalanceInfo {
  currency: string;
  cash_balance: string;
  gift_balance: string;
  frozen_balance: string;
  credit_limit: string;
  credit_available: string;
  total_available: string;
}

/** `GET /platform/balance` 响应（按量渠道）。 */
export interface MiMoBalanceResponse {
  object: 'balance';
  is_available: boolean;
  balance_infos: MiMoBalanceInfo[];
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/** 客户端构造依赖（传输 + 鉴权头注入；无模块级单例）。 */
export interface MiMoBalanceClientDeps {
  transport: Transport;
  headersProvider: () => Promise<Record<string, string>>;
  /** Token Plan host 覆盖（默认官方地址）。 */
  tokenPlanBaseUrl?: string;
  /** 普通 API host 覆盖（默认官方地址）。 */
  apiBaseUrl?: string;
}

/** 非 2xx 或坏 JSON 时抛（状态码完整上抛，调用方要分流 401/404）。 */
export class MiMoBalanceError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly endpoint: 'token_plan' | 'balance',
  ) {
    super(`MiMo ${endpoint} 上游返回 ${status}: ${body.slice(0, 200)}`);
    this.name = 'MiMoBalanceError';
  }
}

export class MiMoBalanceClient {
  private readonly transport: Transport;
  private readonly headersProvider: () => Promise<Record<string, string>>;
  private readonly tokenPlanBaseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(deps: MiMoBalanceClientDeps) {
    this.transport = deps.transport;
    this.headersProvider = deps.headersProvider;
    this.tokenPlanBaseUrl = deps.tokenPlanBaseUrl ?? MIMO_TOKEN_PLAN_BASE_URL;
    this.apiBaseUrl = deps.apiBaseUrl ?? MIMO_API_BASE_URL;
  }

  /**
   * 查 Token Plan 套餐余量（需 `tp-` key）。
   *
   * 这是**订阅路径**的对账真值源：`quota.used_credits` 是周期累计消耗，
   * 与网关侧 as_api 汇总是同一段区间的两个视角。
   */
  async tokenPlan(): Promise<MiMoTokenPlanInfo> {
    const body = await this.get(this.tokenPlanBaseUrl, MIMO_TOKEN_PLAN_PATH, 'token_plan');
    return decodeTokenPlan(body);
  }

  /**
   * 查账号余额（需 `sk-` key）。
   *
   * 这是**按量路径**的对账真值源。用 `tp-` key 打会拿到 401 `invalid_api_key`
   * （2026-11-16 实测）——那不是故障，是 key 类型不匹配，调用方据此判断
   * 「这个部署没有按量渠道」即可。
   */
  async balance(): Promise<MiMoBalanceResponse> {
    const body = await this.get(this.apiBaseUrl, MIMO_BALANCE_PATH, 'balance');
    return decodeBalance(body);
  }

  /** 按计费路径形态选查哪一个（认不出形态时查 token_plan——本仓库的默认部署）。 */
  async snapshot(
    mode: BillingMode | undefined,
  ): Promise<
    { kind: 'token_plan'; info: MiMoTokenPlanInfo } | { kind: 'balance'; info: MiMoBalanceResponse }
  > {
    if (mode === 'pay_as_you_go') {
      return { kind: 'balance', info: await this.balance() };
    }
    return { kind: 'token_plan', info: await this.tokenPlan() };
  }

  private async get(
    baseUrl: string,
    path: string,
    endpoint: 'token_plan' | 'balance',
  ): Promise<Record<string, unknown>> {
    const upstream: UpstreamRequest = {
      method: 'GET',
      base_url: baseUrl,
      path,
      headers: { accept: 'application/json', ...(await this.headersProvider()) },
      stream: false,
    };
    const res = await this.transport.send(upstream);
    const text = (res.body ?? Buffer.alloc(0)).toString('utf8');
    if (res.status < 200 || res.status >= 300) {
      throw new MiMoBalanceError(res.status, text, endpoint);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new MiMoBalanceError(res.status, `响应不是合法 JSON: ${text.slice(0, 200)}`, endpoint);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new MiMoBalanceError(res.status, '响应不是 JSON 对象', endpoint);
    }
    return parsed as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// decode（纯函数，可单测）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * 响应体 → TokenPlanInfo。**不抛**：缺字段落 0/空串，raw 留原文。
 *
 * 与 DeepSeek 的 decodeBalanceResponse 同款立场——上游少给一个字段时让记录落一个
 * 可辨识的默认值，而不是让整个对账流程失败；想区分"真的是 0"与"上游没给"读 `raw`。
 */
export function decodeTokenPlan(raw: unknown): MiMoTokenPlanInfo {
  const obj = asRecord(raw) ?? {};
  const period = asRecord(obj['period']) ?? {};
  const quota = asRecord(obj['quota']) ?? {};
  const total = num(quota['total_credits']);
  const used = num(quota['used_credits']);
  return {
    object: 'token_plan',
    plan_code: str(obj['plan_code']),
    period: { start_at: str(period['start_at']), end_at: str(period['end_at']) },
    quota: {
      total_credits: total,
      used_credits: used,
      // 上游自己算 remaining（max(0, total-used)）；这里同样夹到 0，不传播负数
      remaining_credits: num(quota['remaining_credits'], Math.max(0, total - used)),
    },
    auto_renew: bool(obj['auto_renew']),
    claw_enabled: bool(obj['claw_enabled']),
    raw: obj,
  };
}

/** 响应体 → BalanceResponse。**不抛**（同 decodeTokenPlan 的理由）。 */
export function decodeBalance(raw: unknown): MiMoBalanceResponse {
  const obj = asRecord(raw) ?? {};
  const infos: MiMoBalanceInfo[] = [];
  const arr = obj['balance_infos'];
  if (Array.isArray(arr)) {
    for (const entry of arr) {
      const rec = asRecord(entry);
      if (rec === undefined) continue;
      infos.push({
        currency: str(rec['currency']),
        cash_balance: str(rec['cash_balance']),
        gift_balance: str(rec['gift_balance']),
        frozen_balance: str(rec['frozen_balance']),
        credit_limit: str(rec['credit_limit']),
        credit_available: str(rec['credit_available']),
        total_available: str(rec['total_available']),
      });
    }
  }
  return {
    object: 'balance',
    is_available: bool(obj['is_available']),
    balance_infos: infos,
    raw: obj,
  };
}
