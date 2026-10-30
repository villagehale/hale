import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dryClient, parseFloodLineFlags } from './flood-line-flags.mjs';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-flood-line-eval.mjs');
const KEYLESS = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/LINQ|ANTHROPIC|AI_GATEWAY|DATABASE|BROWSER_USE|HALE_SPEND/.test(k),
  ),
);
const run = (...args) =>
  spawnSync(process.execPath, [RUNNER, ...args], { env: KEYLESS, encoding: 'utf8' });

describe('flood-line eval flags', () => {
  it.each([
    [['--dry'], 'dry'],
    [['--broken'], 'broken'],
    [['--cached-only'], 'cached-only'],
    [['--live'], 'live'],
  ])('%j is mode %s', (args, mode) => {
    expect(parseFloodLineFlags(args)).toBe(mode);
  });

  it('refuses an unknown flag, no flag, or two modes', () => {
    expect(() => parseFloodLineFlags(['--dyr'])).toThrow(/unknown flag/);
    expect(() => parseFloodLineFlags([])).toThrow(/exactly one mode/);
    expect(() => parseFloodLineFlags(['--dry', '--live'])).toThrow(/exactly one mode/);
  });

  it('the dry client throws instead of calling a model', () => {
    expect(() => dryClient()).toThrow(/--dry/);
  });

  it('the runner exits 2 on an unknown flag before any spend cap or client', () => {
    const r = run('--dyr');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown flag/);
    expect(r.stdout).not.toMatch(/mode=/);
  });

  it('the runner refuses a bare run: live needs --live', () => {
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--live/);
  });

  it('--dry with keys unset makes no call and prints the projection', () => {
    const r = run('--dry');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^DRY summary \| compose draws \d+ .* worst \$\d+\.\d{5}$/m);
    expect(r.stdout).toMatch(/live calls: 0/);
  });
});
