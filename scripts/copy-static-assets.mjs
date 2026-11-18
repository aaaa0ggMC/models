/**
 * scripts/copy-static-assets.mjs —— 把运行时读取的资产复制进 dist/。
 *
 * ## 为什么需要它
 *
 * `tsc` 只编译 `.ts`，**不复制 `.json`**。而仓库里有几份数据是运行时就着
 * `import.meta.url` 读的（不依赖 process.cwd()，见各自的 loader 注释）：
 *
 *   - `providers/deepseek/pricing.json`  价格表（峰谷 tiers + 规则集生效日期）
 *   - `providers/mimo/pricing.json`      MiMo 价格表（CNY/USD 两张 + Token Plan）
 *   - `providers/deepseek/holidays.json` 法定节假日日历（按年维护）
 *   - `catalog/vendor/models-dev.json`   models.dev 离线快照（/v1/models 的离线层）
 *   - `providers/openai-images/pricing.json`  图片模态价格表（token 槽位）
 *
 * 少了这一步，`npm run build && node scripts/e2e-demo.mjs` 会在装配网关时炸
 * ENOENT——DeepSeek provider 合进来时就带着这个坑（价格表 loader 在组合根里被无条件
 * 调用），`catalog/` 的离线层会踩同一个坑，openai-images 的价格表是第三个
 * （e2e-demo 实测抓到）。统一在这里补上，比在每个 loader 里写
 * "dist 没有就回退到源目录" 干净（那种回退会让生产部署读到仓库源码目录）。
 *
 * composition-root.ts 的 defaultAdminStaticRoot）——保持「网关自己托管静态资源、
 * 无独立服务」的形态。
 *
 * 幂等：重复跑只是覆盖同一份文件。JSON 资产一个都没复制到时报错并 exit 1
 * （静默跳过会让生产带着半个资产跑起来）；管理面产物缺失只告警不阻断
 */

import { copyFileSync, cpSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/**
 * 要整体复制的目录（保留相对路径；只取其中的 .json）。
 *
 * 加新 provider 时**必须把它的目录加进来**——漏了不会编译报错，只会在
 * `createGateway()` 装配定价服务时炸 ENOENT（2026-11-16 接入 MiMo 时实测：
 * `mimo pricing.json 读取/解析失败: ENOENT .../dist/providers/mimo/pricing.json`，
 * 网关整个起不来）。这与 AI-DESKTOP 记的「DI 漏接端口」是同一类事故：
 * 少一处静默降级 / 直接起不来。
 */
const ASSET_DIRS = [
  'providers/deepseek',
  'providers/mimo',
  'providers/openai-images',
  'catalog/vendor',
];

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
const ADMIN_SRC = join(ROOT, 'webui', 'admin', 'dist');
const ADMIN_DEST = join(DIST, 'webui', 'admin');
if (existsSync(ADMIN_SRC)) {
  cpSync(ADMIN_SRC, ADMIN_DEST, { recursive: true });
  process.stdout.write(
    `copy-static-assets: 已复制管理面产物 webui/admin/dist -> dist/webui/admin/\n`,
  );
} else {
  process.stderr.write(
    'copy-static-assets: 未找到 webui/admin/dist（请先跑 npm run build:admin），跳过前端静态资产拷贝\n',
  );
}

