/**
 * http/models-endpoint.ts —— `GET /v1/models` 与 `GET /v1/models/{id}` 的 HTTP 处理器。
 *
 * ## 端点语义
 *
 * - `GET /v1/models`：OpenAI 兼容列表（`{object:"list", data:[…]}`）+ 扩展字段 + 查询
 *   过滤/排序（见 catalog/query.ts）。
 * - `GET /v1/models/{id}`：OpenAI 兼容详情（直接返回模型对象，不包 list 信封——与
 *   OpenAI `models.retrieve()` 一致）。找不到 → 404；已退役 → 404 且**解释为什么**
 *   （退役公告 + 被谁接管），因为 DeepSeek 实测退役名仍被上游静默重路由，一个干巴巴的
 *   not_found 会让人以为是网关漏了。
 * - `GET|POST /ag/models/sync`：管理员触发同步（token 门禁）。GET 返回状态，POST 触发。
 *
 * ## 为什么独立于 http/server.ts 的路由表
 *
 * server.ts 的 `ROUTES` 是「POST + 客户端格式」的推理端点；模型目录是**元数据面**，
 * 不进出 pipeline（S0–S10 一条阶段都不跑）。把它做成注入的 `ModelsEndpoints` 端口，
 * server.ts 只负责"路径匹配 → 调端口 → 写响应"，不需要知道目录的存在。
 *
 * ## 管理员门禁
 *
 * 令牌经 `GatewayConfig.adminToken`（只从 `AG_ADMIN_TOKEN` 环境变量读，值不进日志、
 * 不进 trace、不落盘）注入；未配置时**拒绝一切管理员请求**（503）而不是放行——"没配
 * 令牌"和"令牌不对"必须可区分，否则一次部署遗漏就变成公开的同步触发口。比较用
 * `timingSafeEqual`，避免时序侧信道。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ModelCatalog } from '../catalog/index.js';
import { ModelQueryError } from '../catalog/index.js';
import { parseModelQuery } from '../catalog/query.js';
import type { ModelSyncService } from '../catalog/sync.js';

/** 一个 HTTP 处理结果（server.ts 只负责 writeHead + end）。 */
export interface ModelsEndpointResult {
  status: number;
  body: unknown;
}

export interface ModelsEndpoints {
  listModels(query: URLSearchParams): Promise<ModelsEndpointResult>;
  getModel(id: string): Promise<ModelsEndpointResult>;
  adminModelsSync(request: {
    method: 'GET' | 'POST';
    authorization?: string;
    adminTokenHeader?: string;
  }): Promise<ModelsEndpointResult>;
  /** 启动时同步（可关；由 startHttpServer 在 listen 前 await）。 */
  start(): Promise<void>;
}

export interface ModelsEndpointOptions {
  catalog: ModelCatalog;
  sync: ModelSyncService;
  /** 管理员令牌（缺省 = 拒绝一切管理员请求）。 */
  adminToken?: string;
}

export function createModelsEndpoints(options: ModelsEndpointOptions): ModelsEndpoints {
  const { catalog, sync, adminToken } = options;

  return {
    async listModels(query: URLSearchParams): Promise<ModelsEndpointResult> {
      let parsed;
      try {
        parsed = parseModelQuery(query);
      } catch (err) {
        if (err instanceof ModelQueryError) {
          return { status: 400, body: errorBody(err.message, 'invalid_request_error') };
        }
        throw err;
      }
      try {
        const response = await catalog.list(parsed);
        return { status: 200, body: response };
      } catch (err) {
        // 双保险：目录承诺不抛（各层失败都已降级），到这里说明是真 bug
        return { status: 500, body: errorBody(describe(err), 'internal_error') };
      }
    },

    async getModel(id: string): Promise<ModelsEndpointResult> {
      const decoded = decodeURIComponent(id);
      if (decoded === '') {
        return { status: 400, body: errorBody('模型 id 不能为空', 'invalid_request_error') };
      }
      const record = await catalog.get(decoded);
      if (record === undefined) {
        return {
          status: 404,
          body: errorBody(`模型不存在: ${decoded}`, 'invalid_request_error', 'model_not_found'),
        };
      }
      if (record.retired !== undefined) {
        // 退役别名不提供服务；解释清楚比一个干 404 有用（上游会静默重路由，见
        // providers/deepseek/catalog-metadata.ts 的 DEEPSEEK_RETIRED_MODELS）
        const succeeded = record.retired.succeeded_by;
        return {
          status: 404,
          body: errorBody(
            `模型 ${decoded} 已于 ${record.retired.retired_at} 退役：${record.retired.note}` +
              (succeeded === undefined ? '' : ` 请改用 ${succeeded}。`),
            'invalid_request_error',
            'model_not_found',
          ),
        };
      }
      return { status: 200, body: record };
    },

    async adminModelsSync(request): Promise<ModelsEndpointResult> {
      if (adminToken === undefined || adminToken === '') {
        return {
          status: 503,
          body: errorBody(
            '管理员令牌未配置（环境变量 AG_ADMIN_TOKEN）；拒绝一切管理员操作',
            'admin_token_not_configured',
          ),
        };
      }
      const presented = request.adminTokenHeader ?? bearer(request.authorization);
      if (presented === undefined || !safeEqual(presented, adminToken)) {
        return {
          status: 401,
          body: errorBody('管理员令牌缺失或不正确', 'unauthorized', 'admin_unauthorized'),
        };
      }
      if (request.method === 'GET') {
        return { status: 200, body: { object: 'models.sync.status', ...sync.status() } };
      }
      const report = await sync.syncNow('admin');
      const failed = report.sources.filter((s) => !s.ok);
      // 部分来源失败不算这次调用失败：last-known-good 仍在，端点照常可用
      return {
        status: 200,
        body: { object: 'models.sync.report', ...report, ok: failed.length === 0 },
      };
    },

    async start(): Promise<void> {
      await sync.start();
    },
  };
}

/** OpenAI 形状的错误体（客户端 SDK 按 `error.message` / `error.type` 取值）。 */
export function errorBody(
  message: string,
  type: string,
  code?: string,
): { error: { message: string; type: string; code?: string } } {
  return { error: { message, type, ...(code === undefined ? {} : { code }) } };
}

/** `Authorization: Bearer <token>` → token；不是 Bearer 形态返回 undefined。 */
function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? undefined : match[1].trim();
}

/** 定长比较（先 hash 再 timingSafeEqual，避免长度泄露也避免长度不等时抛错）。 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
