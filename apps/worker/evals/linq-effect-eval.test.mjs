import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from './lib/harness.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'linq-effect-eval.mjs');

const UNSET_KEYS = [
  'ANTHROPIC_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_KEY',
  'JEV_KEY',
  'LINQ_API_KEY',
  'LINQ_WEBHOOK_SECRET',
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'BROWSER_USE_API_KEY',
];

function envWithoutPaidKeys() {
  const env = { ...process.env };
  for (const key of UNSET_KEYS) delete env[key];
  return env;
}

function run(flag) {
  return spawnSync(process.execPath, [RUNNER, flag], {
    env: envWithoutPaidKeys(),
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('VIL-473 linq-effect eval modes never spend', () => {
  it('--broken: the known-bad stand-in fails the run on the send gate alone', () => {
    const out = run('--broken');
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('unsendable:unknown_effect');
    expect(out.stdout).toContain('live API calls: 0');
  }, 120_000);

  it('--dry: prints the worst-case price and writes nothing', () => {
    const before = readdirSync(CACHE_DIR).length;
    const out = run('--dry');
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/worst case to record \d+ fixtures.*\$\d+\.\d{4} USD/);
    expect(readdirSync(CACHE_DIR).length).toBe(before);
  }, 120_000);

  it('--cached-only: a miss prints the price and exits 1 without writing', () => {
    const before = readdirSync(CACHE_DIR).length;
    const out = run('--cached-only');
    expect(out.status).toBe(1);
    expect(`${out.stdout}\n${out.stderr}`).toMatch(
      /worst case to record \d+ fixtures.*\$\d+\.\d{4} USD/,
    );
    expect(`${out.stdout}\n${out.stderr}`).toMatch(/cache miss in --cached-only mode/);
    expect(readdirSync(CACHE_DIR).length).toBe(before);
  }, 120_000);

  it('refuses to run with no mode, so nothing calls the API by default', () => {
    const out = spawnSync(process.execPath, [RUNNER], {
      env: envWithoutPaidKeys(),
      encoding: 'utf8',
    });
    expect(out.status).toBe(2);
  }, 120_000);
});
