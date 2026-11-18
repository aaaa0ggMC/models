/**
 * tests/docs-check.test.ts —— 把 `scripts/check-docs.mjs` 包进 `npm test`。
 *
 * 为什么值得一个测试文件：check-docs 的五项检查（围栏奇偶 / §N 引用 / 节号连续性 /
 * 术语同义词 / **模态卡片硬校验**）此前只在 docs CI 的 structure job 里跑。模态卡片
 * 硬校验（85-modality-surface-matrix.md §2.3：`ModalityKind` 每个值都要有卡片）是
 * 「新增模态别忘了建面子」的唯一自动防线——放在只有文档改动才触发的 CI 里，意味着
 * 「加了模态、改了 ir/modality.ts、没碰 docs」这种最常见的忘记姿势恰好不会触发它。
 *
 * 本文件用子进程跑**真脚本**（不 import、不重实现校验逻辑）：逻辑只有一份，在
 * scripts/check-docs.mjs；这里只负责让 `npm test` 也能当那条红线，并用临时树证明
 * 红线两端（缺卡片 / 多卡片）真的会红——只跑正向用例的话，「脚本坏了但恰好全绿」
 * 与「真的全绿」无法区分。
 */

import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = join(root, 'scripts', 'check-docs.mjs');

/** 跑一次 check-docs；返回 {code, stdout}（code = 进程退出码）。root 缺省 = 本仓库。 */
async function runCheckDocs(
  cwd: string,
  rootOverride?: string,
): Promise<{ code: number; stdout: string }> {
  const args = rootOverride === undefined ? [script] : [script, '--root', rootOverride];
  try {
    const { stdout } = await execFileAsync(process.execPath, args, { cwd });
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '' };
  }
}

describe('docs 自校验（scripts/check-docs.mjs）', () => {
  it('正向：当前仓库全量通过', async () => {
    const { code, stdout } = await runCheckDocs(root);
    expect({ code, errors: stdout.match(/^ERROR /gm) ?? [] }).toEqual({ code: 0, errors: [] });
  }, 30_000);

  it('负向 A：矩阵少一张卡片 → 退出码 1 且点名缺失的模态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-docs-missing-'));
    try {
      cpSync(join(root, 'docs'), join(dir, 'docs'), { recursive: true });
      mkdirSync(join(dir, 'ir'), { recursive: true });
      cpSync(join(root, 'ir', 'modality.ts'), join(dir, 'ir', 'modality.ts'));
      const matrix = join(dir, 'docs', 'design', '85-modality-surface-matrix.md');
      const { readFileSync } = await import('node:fs');
      writeFileSync(
        matrix,
        readFileSync(matrix, 'utf8').replace(/^### 3\.9 卡片 · video.*$/m, '### 3.9 卡片 · videoX'),
      );
      const { code, stdout } = await runCheckDocs(dir, dir);
      expect(code).toBe(1);
      expect(stdout).toMatch(/ModalityKind "video" 没有卡片/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('负向 B：矩阵多一张不存在的模态卡片 → 退出码 1 且报卡片漂移', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-docs-extra-'));
    try {
      cpSync(join(root, 'docs'), join(dir, 'docs'), { recursive: true });
      mkdirSync(join(dir, 'ir'), { recursive: true });
      cpSync(join(root, 'ir', 'modality.ts'), join(dir, 'ir', 'modality.ts'));
      const matrix = join(dir, 'docs', 'design', '85-modality-surface-matrix.md');
      writeFileSync(matrix, '\n### 3.10 卡片 · hologram\n', { flag: 'a' });
      const { code, stdout } = await runCheckDocs(dir, dir);
      expect(code).toBe(1);
      expect(stdout).toMatch(/卡片 "hologram" 在 ModalityKind 里不存在/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('负向 C：ir/modality.ts 新增模态但没建卡片 → 退出码 1（最常见的忘记姿势）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-docs-newkind-'));
    try {
      cpSync(join(root, 'docs'), join(dir, 'docs'), { recursive: true });
      mkdirSync(join(dir, 'ir'), { recursive: true });
      const { readFileSync } = await import('node:fs');
      const modality = readFileSync(join(root, 'ir', 'modality.ts'), 'utf8');
      // 模拟「新增第 10 个模态」：只在 MODALITY_KINDS 数组里加一个字面量
      writeFileSync(
        join(dir, 'ir', 'modality.ts'),
        modality.replace("  'chat',\n  'decision',", "  'chat',\n  'hologram',\n  'decision',"),
      );
      const { code, stdout } = await runCheckDocs(dir, dir);
      expect(code).toBe(1);
      expect(stdout).toMatch(/ModalityKind "hologram" 没有卡片/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
