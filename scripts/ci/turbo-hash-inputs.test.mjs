import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

// Turbo's own dry run is the oracle for what a task hash covers. Asking turbo
// rather than re-deriving its glob rules means the test can only pass when the
// real hash covers the file.
function turboDryRun(...tasks) {
  const out = execFileSync(
    path.join(ROOT, 'node_modules/.bin/turbo'),
    ['run', ...tasks, '--dry-run=json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    },
  );
  return JSON.parse(out);
}

// Files a package's tsconfig.json pulls in through `extends`, resolved by tsc
// itself so array/bare-specifier/extension-less forms all count.
function extendedFiles(tsconfigPath) {
  const source = ts.readJsonConfigFile(tsconfigPath, ts.sys.readFile);
  ts.parseJsonSourceFileConfigFileContent(source, ts.sys, path.dirname(tsconfigPath));
  return source.extendedSourceFiles ?? [];
}

describe('every tsconfig a build/typecheck task extends is in the turbo global hash (VIL-272)', () => {
  const dryRun = turboDryRun('build', 'typecheck');
  const globalFiles = dryRun.globalCacheInputs.files;

  const outsideOwnDir = [];
  for (const task of dryRun.tasks) {
    const dir = path.join(ROOT, task.directory);
    const tsconfig = path.join(dir, 'tsconfig.json');
    if (!existsSync(tsconfig)) continue;
    for (const file of extendedFiles(tsconfig)) {
      if (
        file.startsWith(`${dir}${path.sep}`) ||
        file.includes(`${path.sep}node_modules${path.sep}`)
      )
        continue;
      outsideOwnDir.push({ taskId: task.taskId, file: path.relative(ROOT, file) });
    }
  }

  it('finds the shared base config (positive control for the walker)', () => {
    expect(outsideOwnDir.map((e) => e.file)).toContain('tsconfig.base.json');
  });

  it.each(outsideOwnDir)('$taskId: $file is in the global hash', ({ file }) => {
    expect(
      Object.hasOwn(globalFiles, file),
      `${file} changes what this task means but is in no task hash — add it to turbo.json globalDependencies`,
    ).toBe(true);
  });
});
