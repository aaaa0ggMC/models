/**
 * scripts/serve.mjs —— AgentGateway 生产装配脚本（systemd 的 ExecStart 指向它）。
 *
 * 用途：把核心 + 全部 provider + /v1/models + 管理面（加密存储 + Admin UI）装配起来，
 * 按 AG_HOST / AG_PORT listen。**这是仓库内唯一的装配入口**——历史教训：
 * 装配脚本长期放在 ~/ai-workspace（仓库外），漏接一个注入端口不会编译报错，
 * 只会在运行时静默少一个能力（modalities 写成 modality、漏 startup hook 都这么栽过）。
 *
 * 数据目录：~/ai-workspace/ag-data/（在仓库外，不进 git）
 *   keystore.key   256-bit KEK（hex，0600）——key_file 自动解锁模式
 *   keystore.json  密钥表（DEK 被 KEK 包裹后的形态）
 *   records.json   加密记录库（凭据 / 别名 / 审计）
 *
 * 注意：key_file 模式的代价（密钥与数据同机，只防拷贝，不防攻陷运行账号）
 * 会在管理界面如实展示——这是设计文档 65 §3.2 的原文立场，不做美化。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';

// 仓库根（本脚本在 scripts/ 下）——不写死绝对 home 路径：既泄露用户名，也别处 clone 跑不了
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(os.homedir(), 'ai-workspace', 'ag-data');

const { createGateway } = await import(`${ROOT}/dist/composition-root.js`);
const { startHttpServer } = await import(`${ROOT}/dist/http/server.js`);
const { createModelsEndpoints } = await import(`${ROOT}/dist/http/models-endpoint.js`);
const storage = await import(`${ROOT}/dist/storage/index.js`);
const { FetchTransport } = await import(`${ROOT}/dist/gateway-core/transport.js`);
const { DatabaseSync } = await import('node:sqlite');
const { SqliteUsageStore } = await import(`${ROOT}/dist/metering/index.js`);
const DB_PATH = path.join(DATA, 'gateway.db');
const sqliteDb = new DatabaseSync(DB_PATH);
await fs.chmod(DB_PATH, 0o600).catch(() => {});
const usageSink = new SqliteUsageStore(sqliteDb);
console.log(`[sqlite] 已连接数据库：${DB_PATH}（历史用量 ${usageSink.count()} 条）`);
const { deserializeKeystoreFile, serializeKeystoreFile } = storage;

// ---- 环境变量 ----
const PORT = Number(process.env['AG_PORT'] ?? 8787);
const HOST = process.env['AG_HOST'] ?? '0.0.0.0';
const ADMIN_TOKEN = process.env['AG_ADMIN_TOKEN'] ?? '';
if (ADMIN_TOKEN === '') {
  console.error('[fatal] 未设置 AG_ADMIN_TOKEN：/admin 登录与 /ag/models/sync 都不可用。');
  process.exit(1);
}

await fs.mkdir(DATA, { recursive: true });
await fs.chmod(DATA, 0o700).catch(() => {});

// ---- FileSystemPort（node:fs 实现；写走 tmp+rename 保证原子）----
const fsPort = {
  async readFile(p) {
    try {
      return await fs.readFile(p);
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }
  },
  async writeFileAtomic(p, data, mode) {
    const tmp = `${p}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, p);
  },
  async exists(p) {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

// ---- KEK：key_file 模式。不存在就现场生成（0600）----
const KEY_PATH = path.join(DATA, 'keystore.key');
let keyRaw = await fsPort.readFile(KEY_PATH);
if (keyRaw === undefined) {
  keyRaw = crypto.randomBytes(32);
  // key_file 模式只认 hex(64 字符) 或 base64(44 字符) 文本，不能写原始字节
  await fsPort.writeFileAtomic(KEY_PATH, Buffer.from(`${keyRaw.toString('hex')}\n`, 'utf8'), 0o600);
  console.log(`[keystore] 已生成新 KEK 文件（0600）：${KEY_PATH}`);
}
const kekSource = new storage.KeyFileKekSource({ read: async () => fsPort.readFile(KEY_PATH) });

// ---- 密钥表持久化 ----
const KS_PATH = path.join(DATA, 'keystore.json');
const ksRaw = await fsPort.readFile(KS_PATH);
const keystore = new storage.Keystore(kekSource, ksRaw === undefined ? undefined : deserializeKeystoreFile(JSON.parse(ksRaw.toString('utf8'))));
await keystore.unlock();
await fsPort.writeFileAtomic(KS_PATH, Buffer.from(JSON.stringify(serializeKeystoreFile(keystore.unlocked().serialize())), 'utf8'), 0o600);
console.log(`[keystore] 已解锁（${kekSource.mode} 模式）。密钥表：${KS_PATH}`);

// ---- 加密记录库（SQLite；若尚无渠道记录且存在历史 records.json 则自动导入）----
const sqliteRawStore = new storage.SqliteRawRecordStore(sqliteDb);
const RECORDS_JSON_PATH = path.join(DATA, 'records.json');
if ((await sqliteRawStore.list('provider')).length === 0 && (await fsPort.exists(RECORDS_JSON_PATH))) {
  const legacyRecords = await new storage.JsonFileRecordStore(RECORDS_JSON_PATH, fsPort).all();
  let imported = 0;
  for (const rec of legacyRecords) {
    if ((await sqliteRawStore.get(rec.kind, rec.id)) === undefined) {
      await sqliteRawStore.put(rec);
      imported += 1;
    }
  }
  if (imported > 0) {
    console.log(`[sqlite] 已从 records.json 导入 ${imported} 条历史加密记录`);
  }
}
const recordStore = new storage.DefaultEncryptedRecordStore(
  keystore.unlocked(),
  sqliteRawStore,
  { now: () => Date.now() },
);

// ---- 装配网关 ----
const gateway = createGateway({
  mode: 'production',
  // 生产必须显式注入真实上游 transport（组合根默认是 ScriptedTransport mock）
  transport: new FetchTransport(),
  // 生产模式不注入 sink 时 usage 会进黑洞（只有 test 模式自动建内存 sink）
  usageSink,
  recordStore,
  keystore: {
    status: () => {
      const u = keystore.unlocked();
      return {
        mode: kekSource.mode,
        tradeoff_note: kekSource.tradeoffNote,
        unlocked: !keystore.locked,
        active_dek_id: u.activeDekId,
        encryption_count: u.encryptionCount(),
        should_rotate_dek: u.shouldRotateDek(),
        argon2_rehash_recommended: false,
        kek_fingerprint: u.kekFingerprint(),
      };
    },
    rotateKek: async (input) => {
      if (input?.confirm !== true) throw new Error('破坏性操作需要显式 confirm: true');
      const newKek = crypto.randomBytes(32);
      keystore.unlocked().rotateKek(newKek, Date.now());
      await fsPort.writeFileAtomic(KS_PATH, Buffer.from(JSON.stringify(serializeKeystoreFile(keystore.unlocked().serialize())), 'utf8'), 0o600);
      await fsPort.writeFileAtomic(KEY_PATH, newKek, 0o600);
      return { rotated: true, active_dek_id: keystore.unlocked().activeDekId, kek_fingerprint: keystore.unlocked().kekFingerprint() };
    },
    rotateDek: async () => {
      const id = keystore.unlocked().rotateDek(Date.now());
      await fsPort.writeFileAtomic(KS_PATH, Buffer.from(JSON.stringify(serializeKeystoreFile(keystore.unlocked().serialize())), 'utf8'), 0o600);
      return { rotated: true, active_dek_id: id };
    },
  },
  adminStaticRoot: path.join(ROOT, 'webui', 'admin', 'dist'),
  adminAccessToken: ADMIN_TOKEN,
  usageSource: {
    list: (fromTs, toTs) =>
      usageSink
        .list(fromTs, toTs)
        .map((r) => ({
          request_id: r.request_id,
          ts: r.ts,
          provider: r.provider,
          model: r.model,
          ...(r.model_alias === undefined ? {} : { model_alias: r.model_alias }),
          status: r.status,
          ...(r.auth === undefined ? {} : { auth: r.auth }),
          usage: { units: r.usage?.units ?? {} },
          cost: {
            cash: { total: r.cost?.cash?.total ?? 0 },
            as_api: { total: r.cost?.as_api?.total ?? 0 },
            status: r.cost?.status ?? 'unpriced',
            ...(r.cost?.currency === undefined ? {} : { currency: r.cost.currency }),
          },
          ...(r.price_snapshot === undefined ? {} : { price_snapshot: r.price_snapshot }),
          finish_reason: r.finish_reason,
          fast_path: r.fast_path,
          ...(r.credential_id === undefined ? {} : { credential_id: r.credential_id }),
        })),
  },
  metadataSync: {
    refresh: async () => {
      const res = (await gateway.refreshModelCapabilities()) ?? { discovered: [], updated: [], added: [] };
      return { discovered: res.discovered ?? [], updated: res.updated ?? [], added: res.added ?? [] };
    },
  },
  balanceProbe: {
    probe: async () => {
      try {
        const snap = await gateway.balanceClient.snapshot();
        const b = snap.balance ?? {};
        return {
          is_available: b.is_available !== false,
          balances: (b.balances ?? []).map((x) => ({
            currency: x.currency,
            total_balance: String(x.total_balance ?? '0'),
            granted_balance: String(x.granted_balance ?? '0'),
            topped_up_balance: String(x.topped_up_balance ?? '0'),
          })),
          fetched_at: snap.fetched_at,
        };
      } catch (err) {
        return { is_available: false, balances: [], error: String(err?.message ?? err) };
      }
    },
  },
});

await gateway.admin.loadAliases();

const models = createModelsEndpoints({
  catalog: gateway.models,
  sync: gateway.modelSync,
  adminToken: ADMIN_TOKEN,
  extendedMetadata: () => gateway.config.modelsExtendedMetadata,
});

const server = await startHttpServer({
  port: PORT,
  host: HOST,
  runner: gateway.runner,
  adminHandler: gateway.admin.routeHandler,
  models,
  tools: gateway.toolEndpoints,
  audio: gateway.audioEndpoints,
  modalities: gateway.modalityEndpoints,
  // 数据面统一鉴权网关（默认拒绝）：不注入则除 /health 外全 401
  authenticator: gateway.dataPlaneAuth,
  // 网关伪装模式（默认关闭）：开启后未携带伪装密钥的 API 请求直接返回 404
  stealthGate: () => ({
    enabled: Boolean(gateway.config.stealthEnabled),
    key: gateway.config.stealthKey ?? '',
    headerName: gateway.config.stealthHeader ?? 'x-gateway-key',
  }),
  // 客户端断联处置策略（默认 immediate；可切换 grace 并配置宽限毫秒数）
  disconnectPolicy: () => ({
    mode: gateway.config.clientDisconnectMode ?? 'immediate',
    graceMs: gateway.config.clientDisconnectGraceMs ?? 5_000,
  }),
  // 把加密存储里的运行时设置应用回 config（否则界面改了但请求路径不认）
  startup: async () => { await gateway.loadSettings(); },
});

server.on('error', (err) => {
  console.error('[server] 监听失败：', err.message);
  process.exit(1);
});

console.log('');
console.log('='.repeat(72));
console.log(`AgentGateway 已启动  →  http://${HOST}:${PORT}`);
console.log(`  管理界面            →  http://${HOST}:${PORT}/admin`);
console.log(`  模型列表            →  http://${HOST}:${PORT}/v1/models`);
console.log(`  健康检查            →  http://${HOST}:${PORT}/health`);
console.log(`  数据目录            →  ${DATA}`);
console.log('='.repeat(72));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[server] 收到 ${sig}，正在优雅退出…`);
    server.close();
    await gateway.shutdown();
    sqliteDb.close();
    process.exit(0);
  });
}
