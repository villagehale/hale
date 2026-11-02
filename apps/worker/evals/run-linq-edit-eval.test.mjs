import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from './lib/harness.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-linq-edit-eval.mjs');

function run(flag) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
  return spawnSync(process.execPath, [RUNNER, flag], { env, encoding: 'utf8', timeout: 120_000 });
}

describe('VIL-479 linq-edit eval modes never spend', () => {
  it('--broken: the known-bad stand-in fails the run on the send gate alone', () => {
    const out = run('--broken');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('unsendable:unknown_message');
    expect(out.stdout).toContain('live API calls: 0');
  }, 120_000);

  it('--dry and --estimate: print the worst-case price and write nothing', () => {
    const before = readdirSync(CACHE_DIR).length;
    const dry = run('--dry');
    const estimate = run('--estimate');
    expect(dry.status).toBe(0);
    expect(estimate.status).toBe(0);
    expect(dry.stdout).toMatch(/worst case to record \d+ fixtures.*\$\d+\.\d{4} USD/);
    expect(estimate.stdout).toBe(dry.stdout);
    expect(dry.stdout).toContain('live API calls: 0');
    expect(readdirSync(CACHE_DIR).length).toBe(before);
  }, 120_000);

  it('refuses to run with no mode, so nothing calls the API by default', () => {
    const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
    const out = spawnSync(process.execPath, [RUNNER], { env, encoding: 'utf8' });
    expect(out.status).toBe(2);
  }, 120_000);
});
