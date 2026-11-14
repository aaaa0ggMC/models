/**
 * admin/static.ts —— 托管 webui/admin/ 的静态资源。
 *
 * 职责单一：把 `/admin/*`（但不是 `/admin/api/*`）映射到 `webui/admin/` 下的
 * 文件。由网关自己托管，不引入 express / serve-static / 任何框架
 * （AGENTS.md：webui 不从零画组件库；这里连静态服务也不引框架）。
 *
 * ## 安全约束
 *
 * 1. **路径穿越防护**：`..`、绝对路径、URL 编码后的穿越一律拒掉。
 *    这是静态服务最基本的红线——`GET /admin/../../etc/passwd` 不该读到任何东西。
 * 2. **只服务已知扩展名**：白名单 `.html` / `.js` / `.css` / `.svg` / `.json` /
 *    `.ico` / `.woff2`。其余一律 404——不猜 content-type，也不当下载端点用。
 * 3. **目录默认落到 index.html**：SPA 的深链（`/admin/credentials`）要能直接
 *    打开，因此未知路径回 index.html 而不是 404（前端路由自己解析）。
 *
 * ## 缓存
 *
 * `index.html` 用 `no-store`（改了要立刻生效），其余资源给一个短 max-age
 * （本地部署，没有 CDN，长缓存只会让人改完看不到变化）。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * 静态资源用的最小文件系统端口（DI 注入）。
 *
 * 为什么注入而不是直接 `node:fs`：测试要能造「路径穿越打到一个不存在的
 * /etc/passwd」而不真去读它；也让部署时可以换成只读虚拟 FS 或内存 FS。
 */
export interface StaticFileSystem {
  /** 文件是否存在。 */
  exists(path: string): boolean;
  /** 是否是目录。 */
  isDirectory(path: string): boolean;
  /** 打开一个可读流（不存在时由调用方先 exists 过）。 */
  /** 打开一个可读流（调用方已先 exists 过）。用 ReadStream 以便 destroy。 */
  createReadStream(path: string): import('node:fs').ReadStream;
}

/** 生产实现：直接走 node:fs。 */
export const nodeStaticFileSystem: StaticFileSystem = {
  exists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  createReadStream: (p) => createReadStream(p) as import('node:fs').ReadStream,
};

/** 允许服务的扩展名 → content-type。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticAssetsOptions {
  /** webui/admin/ 的绝对路径。 */
  rootDir: string;
  /** URL 前缀，缺省 `/admin`。 */
  urlPrefix?: string;
  /** 索引文件名，缺省 `index.html`。 */
  indexFile?: string;
  /** 文件系统（测试注入假 FS；缺省 node:fs）。 */
  fs?: StaticFileSystem;
}

/** 创建一个静态资源 handler：true = 已处理。 */
export function createStaticAssetsHandler(
  options: StaticAssetsOptions,
): (pathname: string, res: ServerResponse) => Promise<boolean> {
  const prefix = options.urlPrefix ?? '/admin';
  const indexFile = options.indexFile ?? 'index.html';
  const root = resolve(options.rootDir);
  const fs = options.fs ?? nodeStaticFileSystem;

  return async (pathname, res) => {
    if (!pathname.startsWith(prefix)) return false;

    // ---- 1. 取相对路径并防穿越 ----
    let rel = pathname.slice(prefix.length);
    // 去掉查询串已在 URL 解析时处理掉；这里只处理路径
    rel = decodeURIComponentSafe(rel);
    if (rel === '' || rel === '/') rel = `/${indexFile}`;

    // 归一化后必须仍在 root 内；任何 `..` 逃逸直接 403
    const normalized = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const abs = resolve(join(root, normalized));
    if (abs !== root && !abs.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return true;
    }

    // ---- 2. 目录 → index.html ----
    let target = abs;
    if (fs.exists(target) && fs.isDirectory(target)) {
      target = join(target, indexFile);
    }

    // ---- 3. SPA fallback：未知路径回 index.html ----
    if (!fs.exists(target)) {
      target = join(root, indexFile);
      if (!fs.exists(target)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          `管理界面未构建：${root} 下没有 ${indexFile}。` +
            '请确认 webui/admin/ 已随仓库一起部署（它是纯静态文件，无需构建）。',
        );
        return true;
      }
    }

    // ---- 4. 扩展名白名单 ----
    const ext = extname(target).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (contentType === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden file type');
      return true;
    }

    // ---- 5. 发送 ----
    const isIndex = target === join(root, indexFile);
    const headers: Record<string, string> = {
      'content-type': contentType,
      'cache-control': isIndex ? 'no-store' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    };
    res.writeHead(200, headers);
    const stream = fs.createReadStream(target);
    stream.pipe(res);
    // 客户端断开时关掉文件句柄（否则长连接会攒 fd）
    res.on('close', () => stream.destroy());
    return true;
  };
}

/** decodeURIComponent 的容错版：坏编码原样返回（后续会被白名单拦掉）。 */
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
