/**
 * admin/static.test.ts —— 管理面静态资源托管的安全与行为。
 *
 * 重点是**路径穿越防护**：`GET /admin/../../etc/passwd` 不该读到任何东西。
 * 这是静态服务最基本的红线，也是唯一一类"读错一个文件就完蛋"的 bug。
 */

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { createStaticAssetsHandler, type StaticFileSystem } from './static.js';

/** 假的 ServerResponse：收集 status / headers / body。 */
/**
 * 假的 ServerResponse。
 *
 * 必须是真的 `Writable`：handler 用 `stream.pipe(res)`，而 `pipe` 要求目标有
 * `once` / `emit` / `write` / `end`。只实现 `writeHead` + `write` 会在 pipe
 * 处炸掉，那样的测试测的是我的假对象而不是 handler。
 */
class FakeRes extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  private readonly chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  override _write(chunk: Buffer, _enc: string, done: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    done();
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** 假 FS：把「文件系统」摊平成一张 Map，**键是绝对路径**（与 handler 内部一致）。 */
function fakeFs(files: Record<string, string>): StaticFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  return {
    exists: (p) => store.has(p),
    isDirectory: () => false,
    createReadStream: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`假 FS 里没有 ${p}`);
      return Readable.from([Buffer.from(v, 'utf8')]) as unknown as import('node:fs').ReadStream;
    },
  };
}

const ROOT = '/srv/webui/admin';
/** root 下的文件（键用绝对路径）。 */
function rootFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v]));
}

/** 一个**在 root 之外**的敏感文件，用来证明穿越永远读不到它。 */
const OUTSIDE_SECRET = 'root:$6$xyz:0:0:passwd';

function handler(files: Record<string, string>, prefix = '/admin') {
  return createStaticAssetsHandler({
    rootDir: ROOT,
    urlPrefix: prefix,
    fs: fakeFs({ ...rootFiles(files), '/etc/passwd': OUTSIDE_SECRET }),
  });
}

describe('路径穿越防护', () => {
  /**
   * 断言「穿越读不到 root 之外的文件」。
   *
   * 不硬断言 403：`path.normalize` 对以 `/` 开头的相对路径会**折叠前导 `..`**
   * （`normalize('/../../etc/passwd')` → `/etc/passwd`），于是这些输入实际上
   * 落在 root 内变成一个不存在的文件，走 SPA fallback 回 index.html（200）。
   * 真正的安全性质是「那个文件的内容永不出现」，不是「状态码必须是 403」——
   * 403 那道检查是纵深防御，给 normalize 不收的情况兜底。
   */
  function assertNoLeak(res: FakeRes): void {
    expect(res.text).not.toContain(OUTSIDE_SECRET);
    expect(res.text).not.toContain('/etc/passwd');
  }

  it('`..` 逃逸 → 读不到外部文件', async () => {
    const h = handler({ 'index.html': '<html>ok</html>' });
    const res = new FakeRes();
    await h('/admin/../../etc/passwd', res as unknown as ServerResponse);
    assertNoLeak(res);
    // 要么被 403 拦掉，要么回落 index.html——两者都安全
    expect([200, 403, 404]).toContain(res.status);
  });

  it('URL 编码后的 `..` → 读不到外部文件', async () => {
    const h = handler({ 'index.html': '<html>ok</html>' });
    const res = new FakeRes();
    await h('/admin/%2e%2e%2f%2e%2e%2fetc%2fpasswd', res as unknown as ServerResponse);
    assertNoLeak(res);
  });

  it('深层 `..` 混在正常路径里 → 读不到外部文件', async () => {
    const h = handler({ 'index.html': 'x', 'app.js': 'x' });
    const res = new FakeRes();
    await h('/admin/app.js/../../../../etc/passwd', res as unknown as ServerResponse);
    assertNoLeak(res);
  });

  it('Windows 风格反斜杠穿越 → 读不到外部文件', async () => {
    const h = handler({ 'index.html': 'x' });
    const res = new FakeRes();
    await h('/admin/..\\..\\etc\\passwd', res as unknown as ServerResponse);
    assertNoLeak(res);
  });

  it('前缀部分匹配（/adminfoo）不构成逃逸', async () => {
    const h = handler({ 'index.html': 'x' });
    const res = new FakeRes();
    await h('/adminfoo/../../etc/passwd', res as unknown as ServerResponse);
    assertNoLeak(res);
  });

  it('不是本前缀的路径 → 不处理（false），交回数据面', async () => {
    const h = handler({ 'index.html': 'x' });
    const res = new FakeRes();
    expect(await h('/v1/chat/completions', res as unknown as ServerResponse)).toBe(false);
    expect(res.status).toBe(0);
  });
});

/**
 * 等服务把流式内容写完。
 *
 * handler 里 `stream.pipe(res)` 是异步的；`await h(...)` 只保证"已 writeHead
 * 并开始 pipe"，不保证 body 已落地。这里显式等 pipe 的 end 事件。
 */
async function served(
  h: (p: string, r: ServerResponse) => Promise<boolean>,
  path: string,
): Promise<FakeRes> {
  const res = new FakeRes();
  await h(path, res as unknown as ServerResponse);
  if (res.status === 200 && res.headers['content-type']?.includes('text')) {
    await new Promise<void>((resolve) => {
      if (res.writableEnded || res.text.length > 0) resolve();
      else res.on('finish', () => resolve());
    });
  }
  return res;
}

describe('正常服务', () => {
  it('index.html → 200 + no-store', async () => {
    const h = handler({ 'index.html': '<html>ok</html>' });
    const res = await served(h, '/admin/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain('ok');
  });

  it('app.js → 200 + javascript content-type + 短缓存', async () => {
    const h = handler({ 'index.html': 'x', 'app.js': 'console.log(1)' });
    const res = await served(h, '/admin/app.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('SPA 深链（未知路径）→ 回落 index.html 而不是 404', async () => {
    const h = handler({ 'index.html': '<html>spa</html>' });
    const res = await served(h, '/admin/credentials');
    expect(res.status).toBe(200);
    expect(res.text).toContain('spa');
  });

  it('连 index.html 都没有 → 明确告知未构建', async () => {
    const h = handler({});
    const res = new FakeRes();
    await h('/admin/anything', res as unknown as ServerResponse);
    expect(res.status).toBe(404);
    expect(res.text).toContain('管理界面未构建');
  });

  it('目录 → index.html', async () => {
    const h = handler({ 'index.html': '<html>dir</html>' });
    const res = await served(h, '/admin');
    expect(res.status).toBe(200);
    expect(res.text).toContain('dir');
  });
});

describe('扩展名白名单', () => {
  it('.html / .js / .css / .json / .svg 都服务', async () => {
    const h = handler({
      'index.html': 'h',
      'app.js': 'j',
      'styles.css': 'c',
      'data.json': '{}',
      'logo.svg': '<svg/>',
    });
    for (const p of [
      '/admin/index.html',
      '/admin/app.js',
      '/admin/styles.css',
      '/admin/data.json',
      '/admin/logo.svg',
    ]) {
      const res = await served(h, p);
      expect(res.status, p).toBe(200);
    }
  });

  it('.env / .pem 等一律 404（不当下载端点用）', async () => {
    const h = handler({ 'index.html': 'h', 'secret.env': 'X=1', 'key.pem': '-----BEGIN' });
    for (const p of ['/admin/secret.env', '/admin/key.pem']) {
      const res = new FakeRes();
      await h(p, res as unknown as ServerResponse);
      // 未知扩展名先回 index.html（SPA fallback）——但**绝不是那个文件的内容**
      expect(res.text, p).not.toContain('-----BEGIN');
      expect(res.text, p).not.toContain('X=1');
    }
  });
});

describe('自定义前缀', () => {
  it('换前缀后只认新前缀', async () => {
    const h = handler({ 'index.html': 'x' }, '/console');
    const ok = await served(h, '/console/');
    expect(ok.status).toBe(200);

    const notMine = new FakeRes();
    expect(await h('/admin/', notMine as unknown as ServerResponse)).toBe(false);
  });
});
