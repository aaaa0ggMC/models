import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根（脚本在 scripts/ 下）——不写绝对 home 路径：既泄露用户名，也别处跑不了
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, '.screenshots');
mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Navigate to admin
  console.log('Navigating to http://localhost:5173/admin/#/chat ...');
  await page.goto('http://localhost:5173/admin/#/chat', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // If on login page, log in or check
  const isLogin = await page.$('.ag-login');
  if (isLogin) {
    console.log('Detected login page, attempting login...');
    // Type password or submit if mock
    await page.fill('input', 'admin');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);
  }

  // Take screenshot of Chat / Playground
  console.log('Taking chat screenshot...');
  await page.screenshot({ path: `${OUT_DIR}/chat.png`, fullPage: false });

  // Navigate to Settings
  console.log('Navigating to Settings...');
  await page.goto('http://localhost:5173/admin/#/settings', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT_DIR}/settings.png`, fullPage: false });

  // Navigate to Overview
  console.log('Navigating to Overview...');
  await page.goto('http://localhost:5173/admin/#/overview', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT_DIR}/overview.png`, fullPage: false });

  await browser.close();
  console.log(`Screenshots saved to ${OUT_DIR}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
