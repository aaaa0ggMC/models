import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.agents/**'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
});
