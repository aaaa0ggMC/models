import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.js',
      '**/*.mjs',
      // 线程 worktree 是同一仓库的另一次检出，里面是历史副本，不该被主目录 lint
      // （同 vitest.config.ts 的 .agents 排除）。
      '.agents/**',
      // webui/admin 是独立构建的前端工程（Vite + React + Semi，自带 tsconfig 与
      // typecheck:admin）；不在后端 eslint / tsconfig 的覆盖范围内。
      'webui/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },
);
