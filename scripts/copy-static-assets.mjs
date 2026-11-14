/**
 * scripts/copy-static-assets.mjs —— 把运行时读取的资产复制进 dist/。
 *
 * ## 为什么需要它
 *
 * `tsc` 只编译 `.ts`，**不复制 `.json`**。而仓库里有三份数据是运行时就着
 * `import.meta.url` 读的（不依赖 process.cwd()，见各自的 loader 注释）：
 *
 *   - `providers/deepseek/pricing.json`  价格表（峰谷 tiers + 规则集生效日期）
 *   - `providers/deepseek/holidays.json` 法定节假日日历（按年维护）
 *   - `catalog/vendor/models-dev.json`   models.dev 离线快照（/v1/models 的离线层）
 *
 * 少了这一步，`npm run build && node scripts/e2e-demo.mjs` 会在装配网关时炸
 * ENOENT——DeepSeek provider 合进来时就带着这个坑（价格表 loader 在组合根里被无条件
 * 调用），`catalog/` 的离线层会踩同一个坑。统一在这里补上，比在每个 loader 里写
 * "dist 没有就回退到源目录" 干净（那种回退会让生产部署读到仓库源码目录）。
 *
 * 同时把**管理面前端产物**（`webui/admin/dist`，由 `npm run build:admin` 的 Vite
 * 构建产出）整体拷进 `dist/admin/`，网关默认从那里托管 `/admin/*`（见
 * composition-root.ts 的 defaultAdminStaticRoot）——保持「网关自己托管静态资源、
 * 无独立服务」的形态。
 *
 * 幂等：重复跑只是覆盖同一份文件。JSON 资产一个都没复制到时报错并 exit 1
 * （静默跳过会让生产带着半个资产跑起来）；管理面产物缺失只告警不阻断
 * （`npm run build` 已先跑 build:admin，单独跑本脚本且没构建前端时才缺）。
 */

import { copyFileSync, cpSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** 要整体复制的目录（保留相对路径；只取其中的 .json）。 */
const ASSET_DIRS = ['providers/deepseek', 'catalog/vendor'];

let copied = 0;

for (const dir of ASSET_DIRS) {
  const sourceDir = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(sourceDir);
  } catch {
    process.stderr.write(`copy-static-assets: 目录不存在，跳过: ${dir}\n`);
    continue;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const from = join(sourceDir, entry);
    if (!statSync(from).isFile()) continue;
    const to = join(DIST, dir, entry);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
    process.stdout.write(`  ${relative(ROOT, from)} -> ${relative(ROOT, to)}\n`);
  }
}

if (copied === 0) {
  process.stderr.write('copy-static-assets: 一个 JSON 资产都没复制到，检查 ASSET_DIRS 配置\n');
  process.exit(1);
}
process.stdout.write(`copy-static-assets: 已复制 ${copied} 个 JSON 资产进 dist/\n`);

// ---- 管理面前端产物：webui/admin/dist -> dist/webui/admin ----
// 目标用 dist/webui/admin 而不是 dist/admin：后端 admin/ 模块会被 tsc 编译成
// dist/admin/*.js，若前端也落在这里，静态托管会把后端模块源码经 /admin/routes.js
// 之类路径serve出去。tsc 不产出 dist/webui/**，故此处无碰撞。
const ADMIN_SRC = join(ROOT, 'webui', 'admin', 'dist');
const ADMIN_DEST = join(DIST, 'webui', 'admin');
if (existsSync(ADMIN_SRC)) {
  cpSync(ADMIN_SRC, ADMIN_DEST, { recursive: true });
  process.stdout.write(
    `copy-static-assets: 已复制管理面产物 webui/admin/dist -> dist/webui/admin/\n`,
  );
} else {
  process.stderr.write(
    'copy-static-assets: 未找到 webui/admin/dist（跳过管理面产物）。' +
      '如需托管管理面，请先运行 npm run build:admin。\n',
  );
}
