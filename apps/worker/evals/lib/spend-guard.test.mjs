// The mandatory spend guard and --dry (914). Every live call must pass the guard; a dry
// run must make zero network calls; importing a runner must not run its eval.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dryClient,
  installEvalSpendCap,
  isDryRun,
  isMain,
  lazyAnthropic,
  requireSpendGuard,
  spendCappedFetch,
} from './harness.mjs';

let dir;
let fetchSpy;
const argv = process.argv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spend-guard-'));
  vi.stubEnv('HALE_SPEND_LEDGER', '');
  vi.stubEnv('HALE_MAX_USD', '');
  vi.stubEnv('HALE_ESTIMATE', '');
  vi.stubEnv('HALE_EVAL_DRY', '');
  vi.stubEnv('HALE_EVAL_LEDGER_DEFAULTED', '');
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('test: network call attempted');
  });
});
afterEach(() => {
  process.argv = argv;
  fetchSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('requireSpendGuard', () => {
  it('refuses with no ledger path', () => {
    vi.stubEnv('HALE_MAX_USD', '0.095');
    delete process.env.HALE_SPEND_LEDGER;
    expect(() => requireSpendGuard('t')).toThrow(/no ledger path/);
  });
  it('refuses with no cap', () => {
    vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'l.json'));
    delete process.env.HALE_MAX_USD;
    expect(() => requireSpendGuard('t')).toThrow(/no --max-usd/);
  });
  it('refuses when installEvalSpendCap had to default the ledger to /tmp', () => {
    delete process.env.HALE_SPEND_LEDGER;
    process.argv = [...argv, '--max-usd', '0.095'];
    installEvalSpendCap();
    expect(process.env.HALE_SPEND_LEDGER).toBeTruthy();
    expect(() => requireSpendGuard('t')).toThrow(/no ledger path/);
  });
  it('passes with both a ledger and a cap', () => {
    vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'l.json'));
    vi.stubEnv('HALE_MAX_USD', '0.095');
    expect(() => requireSpendGuard('t')).not.toThrow();
  });
  it('lazyAnthropic throws before building a client when unguarded', () => {
    delete process.env.HALE_SPEND_LEDGER;
    delete process.env.HALE_MAX_USD;
    expect(() => lazyAnthropic('t')()).toThrow(/spend-guard/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('spendCappedFetch never sends when unguarded', async () => {
    const send = vi.fn();
    await expect(spendCappedFetch({ tag: 'g', request: { model: 'x' }, send })).rejects.toThrow(
      /spend-guard/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('--dry', () => {
  it('is read from argv or HALE_EVAL_DRY', () => {
    expect(isDryRun(['node', 'x', '--dry'], {})).toBe(true);
    expect(isDryRun(['node', 'x'], { HALE_EVAL_DRY: '1' })).toBe(true);
    expect(isDryRun(['node', 'x'], {})).toBe(false);
  });
  it('hands out a stub that fails loudly on any call, with zero network', async () => {
    vi.stubEnv('HALE_EVAL_DRY', '1');
    const client = lazyAnthropic('t')();
    expect(() => client.messages.create({})).toThrow(/dry/);
    expect(() => client.messages.countTokens({})).toThrow(/dry/);
    expect(() => client.messages.stream({})).toThrow(/dry/);
    expect(() => dryClient('x').messages.create({})).toThrow(/attempted network call/);
    const send = vi.fn();
    await expect(spendCappedFetch({ tag: 'g', request: { model: 'x' }, send })).rejects.toThrow(
      /dry/,
    );
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('refuses even with a ledger and cap set', () => {
    vi.stubEnv('HALE_EVAL_DRY', '1');
    vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'l.json'));
    vi.stubEnv('HALE_MAX_USD', '0.095');
    expect(() => requireSpendGuard('t')).toThrow(/dry/);
  });
});

describe('is-main guard', () => {
  it('isMain is false for an imported module', () => {
    expect(isMain(import.meta.url, '/nonexistent/entry.mjs')).toBe(false);
    expect(isMain(import.meta.url, undefined)).toBe(false);
  });
  it('importing the reminder runner does not run the eval', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('test: runner called process.exit on import');
    });
    const log = vi.spyOn(console, 'log');
    const mod = await import('../run-reminder-eval.mjs');
    expect(Array.isArray(mod.BROKEN_CASES)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('reminder eval |'))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    exit.mockRestore();
    log.mockRestore();
  });
});
