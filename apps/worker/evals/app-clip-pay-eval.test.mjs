import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from './lib/harness.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'app-clip-pay-eval.mjs');

function run(flag) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return spawnSync(process.execPath, [RUNNER, flag], { env, encoding: 'utf8', timeout: 120_000 });
}

describe('VIL-481 app-clip-pay eval does not spend', () => {
  it('--estimate prices the suite and writes nothing', () => {
    const before = readdirSync(CACHE_DIR).length;
    const out = run('--estimate');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/\$\d+\.\d{4} USD/);
    expect(out.stdout).toContain('live API calls: 0');
    expect(readdirSync(CACHE_DIR).length).toBe(before);
  }, 120_000);

  it('refuses to run with no mode, so nothing calls the API by default', () => {
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const out = spawnSync(process.execPath, [RUNNER], { env, encoding: 'utf8' });
    expect(out.status).toBe(2);
  }, 120_000);
});
