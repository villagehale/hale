import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-coach-reaction-eval.mjs');

function run(...flags) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return spawnSync(process.execPath, [RUNNER, ...flags], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('VIL-680 coach-reaction eval calibration never spends', () => {
  it('--broken: a thumbs-up as the whole answer fails the objective metric', () => {
    const out = run('--cached-only', '--broken');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('expected the words to go');
    expect(out.stdout).toContain('live API calls this run: 0');
  }, 120_000);

  it('refuses --broken without --cached-only, so calibration can never call the API', () => {
    const out = run('--broken');
    expect(out.status).toBe(2);
  }, 120_000);
});
