/**
 * scripts/supervisor.mjs —— AgentGateway 零停机蓝绿热切换转发层 + 进程管理器。
 *
 * 职责：
 *   1. 对外常驻监听 `AG_HOST:AG_PORT`（默认 `0.0.0.0:8790`），永不重启；
 *   2. 平时仅运行 1 个内部网关子进程（blue: 18791 或 green: 18792），零双倍内存常驻；
 *   3. 流式零缓冲 HTTP/SSE 转发（本机回环延迟 <0.2ms，完整透传 SSE 与客户端断联）；
 *   4. 启动期 / 崩溃自愈期自动 hold 新请求进 pending 队列，后端 `/health` 绿灯后立刻放行；
 *   5. 收到 `SIGHUP`（`systemctl reload agentgateway`）时执行蓝绿热切换：
 *      后台 `npm run build`（期间线上 0 影响）→ 在空闲槽拉起新进程 → 探 `/health` 200 →
 *      原子切流量 → 给旧槽发 `SIGTERM` 等待在途长连接/SSE 全部自然跑完再退场。
 *      若构建或新进程启动失败，自动放弃切换，旧槽毫发无损。
 */

import http from 'node:http';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_HOST = process.env['AG_HOST'] ?? '0.0.0.0';
const PUBLIC_PORT = Number(process.env['AG_PORT'] ?? 8790);
const SLOT_PORTS = {
  blue: Number(process.env['AG_INTERNAL_PORT_A'] ?? 18791),
  green: Number(process.env['AG_INTERNAL_PORT_B'] ?? 18792),
};
const HEALTH_TIMEOUT_MS = Number(process.env['AG_HEALTH_TIMEOUT_MS'] ?? 30_000);
const PENDING_TIMEOUT_MS = Number(process.env['AG_PENDING_TIMEOUT_MS'] ?? 15_000);
const DRAIN_TIMEOUT_MS = Number(process.env['AG_DRAIN_TIMEOUT_MS'] ?? 60_000);
const NODE_BIN = process.execPath;
const NPM_BIN = process.env['AG_NPM_BIN'] ?? '/usr/local/bin/npm';

/** @typedef {{ name: 'blue' | 'green', port: number, child: import('node:child_process').ChildProcess, stopping: boolean }} Slot */

/** @type {Slot | null} */
let activeSlot = null;
/** @type {Set<Slot>} */
const drainingSlots = new Set();
let reloading = false;
let shuttingDown = false;
let crashRestartTimer = null;

/** @type {Array<{ req: http.IncomingMessage, res: http.ServerResponse, timer: NodeJS.Timeout, onClose: () => void }>} */
const pendingQueue = [];

function log(msg) {
  console.log(`[supervisor] ${msg}`);
}

function logErr(msg) {
  console.error(`[supervisor] ${msg}`);
}

/** 探测内部槽位 `/health` 是否返回 200。 */
function probeHealth(port) {
  return new Promise((resolveProbe) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: 1500 },
      (res) => {
        res.resume();
        resolveProbe(res.statusCode === 200);
      },
    );
    req.on('error', () => resolveProbe(false));
    req.on('timeout', () => {
      req.destroy();
      resolveProbe(false);
    });
  });
}

async function waitForSlotHealthy(slot, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (slot.child.exitCode !== null || slot.child.signalCode !== null) {
      return false;
    }
    if (await probeHealth(slot.port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * 将最新构建的 `dist/` 快照到空闲槽位的独立目录 `dist/.slots/<name>`。
 * 这样在后台 `npm run build` 覆盖 `dist/` 与 `webui/admin/dist/` 期间，
 * 正在提供服务的旧槽位只读自己的独立快照目录，完全零文件竞争、不会 404。
 */
function snapshotDistForSlot(name) {
  const srcDist = join(ROOT, 'dist');
  const slotDir = join(srcDist, '.slots', name);
  rmSync(slotDir, { recursive: true, force: true });
  mkdirSync(slotDir, { recursive: true });
  for (const entry of readdirSync(srcDist)) {
    if (entry === '.slots') continue;
    cpSync(join(srcDist, entry), join(slotDir, entry), { recursive: true });
  }
  return slotDir;
}

/** 拉起一个内部网关槽位。 */
function spawnSlot(name) {
  const port = SLOT_PORTS[name];
  const slotDistDir = snapshotDistForSlot(name);
  log(`启动槽位 ${name} (127.0.0.1:${port}, dist=${slotDistDir})…`);
  const child = spawn(NODE_BIN, ['scripts/serve.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AG_HOST: '127.0.0.1',
      AG_PORT: String(port),
      AG_DIST_DIR: slotDistDir,
      AG_DRAIN_TIMEOUT_MS: String(DRAIN_TIMEOUT_MS),
    },
    stdio: 'inherit',
  });
  /** @type {Slot} */
  const slot = { name, port, child, stopping: false };

  child.on('exit', (code, signal) => {
    drainingSlots.delete(slot);
    if (activeSlot === slot) {
      activeSlot = null;
      if (!shuttingDown) {
        logErr(`活跃槽位 ${name} 意外退出 (code=${code}, signal=${signal})，1s 后自动拉起…`);
        scheduleCrashRecovery();
      }
    } else {
      log(`旧槽位 ${name} 已优雅退出 (code=${code}, signal=${signal})`);
    }
  });

  return slot;
}

function scheduleCrashRecovery() {
  if (shuttingDown || reloading || crashRestartTimer !== null) return;
  crashRestartTimer = setTimeout(async () => {
    crashRestartTimer = null;
    if (shuttingDown || activeSlot !== null) return;
    const nextName = 'blue';
    const slot = spawnSlot(nextName);
    const ok = await waitForSlotHealthy(slot);
    if (ok && !shuttingDown) {
      activeSlot = slot;
      log(`崩溃自愈完成：活跃槽位 ${slot.name} (127.0.0.1:${slot.port})`);
      drainPendingQueue();
    } else {
      killSlotHard(slot);
      scheduleCrashRecovery();
    }
  }, 1000);
}

function killSlotHard(slot) {
  slot.stopping = true;
  if (slot.child.exitCode === null && slot.child.signalCode === null) {
    slot.child.kill('SIGKILL');
  }
}

function stopSlotGracefully(slot) {
  slot.stopping = true;
  drainingSlots.add(slot);
  if (slot.child.exitCode !== null || slot.child.signalCode !== null) {
    drainingSlots.delete(slot);
    return Promise.resolve();
  }
  return new Promise((resolveStop) => {
    const forceTimer = setTimeout(() => {
      logErr(`旧槽位 ${slot.name} 排水超时，发送 SIGKILL`);
      killSlotHard(slot);
      resolveStop();
    }, DRAIN_TIMEOUT_MS + 5_000);
    forceTimer.unref?.();

    slot.child.once('exit', () => {
      clearTimeout(forceTimer);
      resolveStop();
    });
    slot.child.kill('SIGTERM');
  });
}

function runBuild() {
  if (process.env['AG_RELOAD_SKIP_BUILD'] === '1') {
    log('AG_RELOAD_SKIP_BUILD=1，跳过构建');
    return Promise.resolve(true);
  }
  log('后台构建新版本（npm run build --silent，期间线上服务不中断）…');
  return new Promise((resolveBuild) => {
    const proc = spawn(NPM_BIN, ['run', 'build', '--silent'], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        log('后台构建成功');
        resolveBuild(true);
      } else {
        logErr(`后台构建失败 (exit=${code})，放弃本次热切换，旧槽继续服务`);
        resolveBuild(false);
      }
    });
    proc.on('error', (err) => {
      logErr(`后台构建启动失败：${err.message}`);
      resolveBuild(false);
    });
  });
}

/** 零停机蓝绿热切换。 */
async function performReload() {
  if (shuttingDown) return;
  if (reloading) {
    log('热切换正在进行中，忽略重复 SIGHUP');
    return;
  }
  reloading = true;
  try {
    const built = await runBuild();
    if (!built) return;

    const prevSlot = activeSlot;
    const nextName = prevSlot?.name === 'blue' ? 'green' : 'blue';
    const nextSlot = spawnSlot(nextName);

    const healthy = await waitForSlotHealthy(nextSlot);
    if (!healthy) {
      logErr(`新槽位 ${nextName} 未能通过健康检查，放弃切换，旧槽继续服务`);
      killSlotHard(nextSlot);
      return;
    }

    // 原子切流量：此后所有新请求瞬间进入新槽
    activeSlot = nextSlot;
    log(`流量已无感切换至槽位 ${nextSlot.name} (127.0.0.1:${nextSlot.port})`);
    drainPendingQueue();

    if (prevSlot !== null) {
      log(`通知旧槽位 ${prevSlot.name} 优雅排水退出…`);
      void stopSlotGracefully(prevSlot);
    }
  } finally {
    reloading = false;
  }
}

// ---------------------------------------------------------------------------
// 流式零缓冲 HTTP/SSE 转发 + Pending 队列
// ---------------------------------------------------------------------------

function forwardToSlot(req, res, slot) {
  const headers = { ...req.headers };
  const remoteAddr = req.socket.remoteAddress ?? '';
  headers['x-forwarded-for'] = headers['x-forwarded-for']
    ? `${headers['x-forwarded-for']}, ${remoteAddr}`
    : remoteAddr;
  if (headers.host) headers['x-forwarded-host'] = headers.host;
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] ?? 'http';

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: slot.port,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      if (res.writableEnded || res.destroyed) {
        proxyRes.destroy();
        return;
      }
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: {
            code: 'gateway_reloading',
            message: `后端槽位暂不可达：${err.message}`,
          },
        }),
      );
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      proxyReq.destroy();
    }
  });

  req.pipe(proxyReq);
}

function enqueuePending(req, res) {
  req.pause();
  const entry = {
    req,
    res,
    timer: null,
    onClose: () => {},
  };
  entry.onClose = () => {
    const idx = pendingQueue.indexOf(entry);
    if (idx !== -1) pendingQueue.splice(idx, 1);
    if (entry.timer !== null) clearTimeout(entry.timer);
  };
  entry.timer = setTimeout(() => {
    const idx = pendingQueue.indexOf(entry);
    if (idx !== -1) pendingQueue.splice(idx, 1);
    res.off('close', entry.onClose);
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: { code: 'service_unavailable', message: '网关正在启动或恢复中，请稍后重试' },
        }),
      );
    }
  }, PENDING_TIMEOUT_MS);

  res.once('close', entry.onClose);
  pendingQueue.push(entry);
}

function drainPendingQueue() {
  if (activeSlot === null) return;
  const slot = activeSlot;
  while (pendingQueue.length > 0) {
    const entry = pendingQueue.shift();
    if (!entry) break;
    clearTimeout(entry.timer);
    entry.res.off('close', entry.onClose);
    if (entry.res.writableEnded || entry.res.destroyed) continue;
    entry.req.resume();
    forwardToSlot(entry.req, entry.res, slot);
  }
}

const server = http.createServer((req, res) => {
  if (activeSlot !== null) {
    forwardToSlot(req, res, activeSlot);
  } else {
    enqueuePending(req, res);
  }
});

// 不给外层转发器设短超时，避免截断长流式 SSE / 慢推理请求
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// ---- 信号处理 ----
process.on('SIGHUP', () => {
  log('收到 SIGHUP，启动零停机蓝绿热切换…');
  void performReload();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，正在关闭转发层并优雅退出子槽位…`);
    if (crashRestartTimer !== null) clearTimeout(crashRestartTimer);
    server.close();
    const toStop = [...drainingSlots, ...(activeSlot ? [activeSlot] : [])];
    activeSlot = null;
    await Promise.all(toStop.map((s) => stopSlotGracefully(s)));
    process.exit(0);
  });
}

// ---- 启动 ----
server.listen(PUBLIC_PORT, PUBLIC_HOST, async () => {
  log(`常驻转发层已监听 http://${PUBLIC_HOST}:${PUBLIC_PORT}（蓝绿双槽 ${SLOT_PORTS.blue} / ${SLOT_PORTS.green}）`);
  const first = spawnSlot('blue');
  const ok = await waitForSlotHealthy(first);
  if (ok) {
    activeSlot = first;
    log(`初始槽位 blue 就绪，开始对外服务`);
    drainPendingQueue();
  } else {
    logErr('初始槽位 blue 启动失败，退出 supervisor 交由 systemd 重试');
    killSlotHard(first);
    process.exit(1);
  }
});
