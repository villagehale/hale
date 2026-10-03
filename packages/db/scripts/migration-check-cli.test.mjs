import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeDbError } from './check-migration-drift.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function run(script, args, extraEnv) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'DATABASE_URL' || key === 'DATABASE_DIRECT_URL') continue;
    if (typeof value === 'string') env[key] = value;
  }
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [path.join(scriptDir, script), ...args], {
    cwd: scriptDir,
    env,
    encoding: 'utf8',
  });
}

describe('migration check CLI', () => {
  it('exits 0 without a database URL unless --require-url is set', () => {
    const skipped = run('check-migration-drift.mjs', []);
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain('SKIPPED');

    const required = run('check-migration-drift.mjs', ['--require-url']);
    expect(required.status).toBe(1);
    expect(required.stderr).toContain('DATABASE_DIRECT_URL');
    expect(required.stderr).not.toContain('postgres://');
  });

  it('refuses to apply migrations when no database URL is set', () => {
    const result = run('apply-migrations.mjs', []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_DIRECT_URL');
    expect(result.stderr).not.toContain('postgres://');
  });

  it('redacts a connection string from a driver error', () => {
    const message = sanitizeDbError(
      new Error('connect failed postgres://user:secret@db.example:5432/hale'),
    );
    expect(message).not.toContain('secret');
    expect(message).not.toContain('postgres://');
  });
});

describe('Vercel production migrate hook', () => {
  it('does nothing for preview builds and for non-Vercel invocations', () => {
    const preview = run('vercel-production-migrate.mjs', [], {
      VERCEL: '1',
      VERCEL_ENV: 'preview',
    });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain('preview');

    const local = run('vercel-production-migrate.mjs', [], {});
    expect(local.status).toBe(0);
    expect(local.stdout).toContain('Not a Vercel build');
  });

  it('fails a production build that has no database URL', () => {
    const result = run('vercel-production-migrate.mjs', [], {
      VERCEL: '1',
      VERCEL_ENV: 'production',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DATABASE_DIRECT_URL');
    expect(result.stderr).toContain('Production build refused');
    expect(result.stderr).not.toContain('postgres://');
  });
});
