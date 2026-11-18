import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: ROOT,
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: resolve(ROOT, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/v1beta': 'http://127.0.0.1:8787',
    },
  },
});
