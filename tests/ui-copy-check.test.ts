import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'check-ui-copy.mjs');

function runCheck(targetRoot: string, cwd = root): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [script, '--root', targetRoot],
      { cwd },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : err
            ? 1
            : 0;
        resolvePromise({ code, stdout: `${stdout}${stderr}` });
      },
    );
  });
}

function tempTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ag-ui-copy-'));
  const src = join(dir, 'webui', 'admin', 'src');
  mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const full = join(src, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe('UI 文案扫描（scripts/check-ui-copy.mjs）', () => {
  it('正向：当前仓库全量通过（未豁免疑似 = 0）', async () => {
    const { code, stdout } = await runCheck(root);
    expect(code).toBe(0);
    expect(stdout).toMatch(/结果：绿灯/);
    expect(stdout).not.toMatch(/理由：\(缺失\)/);
  }, 30_000);

  it('负向 A：界面贴一条长解释 → 退出码 1 且点名文件与行号', async () => {
    const dir = tempTree({
      'Demo.tsx': `export function Demo() {
  return <div title="因为网关会自动处理转换所以这里不需要你操心任何额外配置" />;
}
`,
    });
    try {
      const { code, stdout } = await runCheck(dir, dir);
      expect(code).toBe(1);
      expect(stdout).toMatch(/Demo\.tsx:2/);
      expect(stdout).toMatch(/长文案/);
      expect(stdout).toMatch(/结果：红灯/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('负向 B：内部术语漏进用户可见串 → 退出码 1', async () => {
    const dir = tempTree({
      'Demo.tsx': `export const ERR = '请填写 access_path';
`,
    });
    try {
      const { code, stdout } = await runCheck(dir, dir);
      expect(code).toBe(1);
      expect(stdout).toMatch(/内部术语/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('负向 C：豁免不写理由 → 退出码 1', async () => {
    const dir = tempTree({
      'Demo.tsx': `export function Demo() {
  return <div>这是一条很长的解释性文案，因为它会把用户搞糊涂。</div>; // ui-copy: allow
}
`,
    });
    try {
      const { code, stdout } = await runCheck(dir, dir);
      expect(code).toBe(1);
      expect(stdout).toMatch(/Demo\.tsx:2 的豁免没写理由/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('负向 D：Help.tsx 与测试文件不扫描', async () => {
    const dir = tempTree({
      'pages/Help.tsx': `export const LONG = '因为这是一整段解释性文字，写在帮助页里完全没问题，帮助页就是解释性文字唯一的家。';
`,
      'demo.test.ts': `export const T = '测试里的长文案不该被算进界面文案，因为测试不是界面。';
`,
    });
    try {
      const { code, stdout } = await runCheck(dir, dir);
      expect(code).toBe(0);
      expect(stdout).toMatch(/结果：绿灯/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
