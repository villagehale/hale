import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from './lib/harness.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'area-read-eval.mjs');

function run(flag) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return spawnSync(process.execPath, [RUNNER, flag], { env, encoding: 'utf8', timeout: 120_000 });
}

describe('VIL-546 area-read eval', () => {
  it('--broken: a reader that calls every place a town fails the grade', () => {
    const out = run('--broken');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('FAIL  street-bayview-drive-on');
    expect(out.stdout).toContain('live API calls: 0');
  }, 120_000);

  it('--cached-only: the recorded readings pass with no live call', () => {
    const out = run('--cached-only');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('PASS  town-terrace-bc');
    expect(out.stdout).toContain('live API calls this run: 0');
  }, 120_000);

  it('--dry: prints the worst-case price and writes nothing', () => {
    const before = readdirSync(CACHE_DIR).length;
    const out = run('--dry');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/worst case to record \d+ fixtures.*\$\d+\.\d{4} USD/);
    expect(readdirSync(CACHE_DIR).length).toBe(before);
  }, 120_000);
});
