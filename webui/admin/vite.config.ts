import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * webui/admin 的 Vite 配置。
 *
 * 关键点：
 * - `root` 指向本目录（从仓库根用 `vite build --config webui/admin/vite.config.ts`
 *   启动时，cwd 是仓库根，必须显式把 root 指回来，否则找不到 index.html）。
 * - `base: '/admin/'`：网关把 `/admin/*`（不含 `/admin/api/*`）映射到构建产物目录，
 *   资源 URL 必须带 `/admin/` 前缀才能被静态托管服务到。
 * - 产物落 `webui/admin/dist/`，再由 scripts/copy-static-assets.mjs 拷进 `dist/admin/`，
 *   网关默认从那里托管（见 composition-root.ts 的 defaultAdminStaticRoot）。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 管理面是自托管的小工具，不开 sourcemap：产物更小，也不把源码结构暴露到线上。
    sourcemap: false,
  },
});
