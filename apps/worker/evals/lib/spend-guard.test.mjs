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
  it('installEvalSpendCap refuses with no ledger path (no /tmp default since #925)', () => {
    delete process.env.HALE_SPEND_LEDGER;
    process.argv = [...argv, '--max-usd', '0.095'];
    expect(() => installEvalSpendCap()).toThrow(/HALE_SPEND_LEDGER/);
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
      /spend-cap: a live model call needs BOTH/,
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

describe('--dry needs a real ledger and lists instead of calling (914)', () => {
  it('refuses with no HALE_SPEND_LEDGER instead of falling back to /tmp', () => {
    process.argv = ['node', 'x', '--dry', '--max-usd', '0.15'];
    expect(() => installEvalSpendCap()).toThrow(/--dry: no ledger path/);
    expect(process.env.HALE_SPEND_LEDGER).toBe('');
  });

  it('runs with a ledger set', () => {
    process.argv = ['node', 'x', '--dry', '--max-usd', '0.15'];
    vi.stubEnv('HALE_SPEND_LEDGER', join(dir, 'l.json'));
    expect(installEvalSpendCap()).toBe(0.15);
  });

  it('the reminder runner exits non-zero on --dry with no ledger, before any call', async () => {
    const { spawnSync } = await import('node:child_process');
    const drop = new Set(['HALE_SPEND_LEDGER', 'ANTHROPIC_API_KEY', 'AI_GATEWAY_API_KEY']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.has(k)));
    const runner = new URL('../run-reminder-eval.mjs', import.meta.url).pathname;
    const res = spawnSync(process.execPath, [runner, '--dry', '--rescore', '--max-usd', '0.15'], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/--dry: no ledger path/);
    expect(res.stdout).not.toMatch(/DRY summary/);
  }, 70_000);

  it('a dry judge lists an uncached draw with the guard worst case and never calls', async () => {
    const { makeJudge, makeCost, summarizeJudgePlan } = await import('./harness.mjs');
    process.argv = ['node', 'x', '--dry'];
    const getClient = vi.fn(() => {
      throw new Error('test: client built in --dry');
    });
    const prefix = `dry-plan-${Math.random().toString(36).slice(2)}`;
    const judge = makeJudge('claude-sonnet-5-5', 'score it', prefix, false, getClient, makeCost(), {
      samples: 3,
      aggregate: 'min',
      maxOutputTokens: 512,
    });
    const verdict = await judge('case', { text: 'hi' });
    expect(verdict.dry).toBe(true);
    expect(judge.plan).toHaveLength(3);
    judge.plan.forEach((p, i) => {
      expect(p.cached).toBe(false);
      expect(p.maxTokens).toBe(512);
      // draw 1 writes the prompt cache: all input at the cache-write rate + 512 out at $10/MTok.
      // Later draws read it: the system prompt at 0.1x, the rest still at the write rate.
      const read = i === 0 ? 0 : p.cacheReadTokens;
      if (i > 0) expect(read).toBeGreaterThan(0);
      else expect(p.cacheReadTokens).toBe(0);
      expect(p.worstUsd).toBeCloseTo(
        (read * 2 * 0.1 + (p.inputTokens - read) * 2 * 1.25 + 512 * 10) / 1e6,
        8,
      );
    });
    expect(judge.plan[1].worstUsd).toBeLessThan(judge.plan[0].worstUsd);
    expect(getClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const s = summarizeJudgePlan(judge.plan, { spentUsd: 0.14, capUsd: 0.15 });
    expect(s.uncached).toBe(3);
    expect(s.worstTotalUsd).toBeCloseTo(
      judge.plan.reduce((a, p) => a + p.worstUsd, 0),
      10,
    );
    expect(s.fitsCap).toBe(false);
  });

  it('a dry judge reports a cached draw as cached, with its score', async () => {
    const { makeJudge, makeCost, cacheKey, CACHE_DIR } = await import('./harness.mjs');
    const { writeFileSync } = await import('node:fs');
    process.argv = ['node', 'x', '--dry'];
    const prefix = `dry-cached-${Math.random().toString(36).slice(2)}`;
    const payload = { text: 'hi' };
    const key = cacheKey(
      `${prefix}:judge:case`,
      `claude-haiku-5-5\nscore it\n${JSON.stringify(payload)}`,
    );
    const file = join(CACHE_DIR, `${key}.json`);
    writeFileSync(file, JSON.stringify({ parsed: { reason: 'ok', score: 5 } }));
    try {
      const judge = makeJudge(
        'claude-haiku-5-5',
        'score it',
        prefix,
        false,
        () => {
          throw new Error('test: client built');
        },
        makeCost(),
        { maxOutputTokens: 512 },
      );
      const verdict = await judge('case', payload);
      expect(verdict.score).toBe(5);
      expect(judge.plan).toEqual([{ tag: `${prefix}:judge:case`, cached: true, score: 5 }]);
    } finally {
      rmSync(file, { force: true });
    }
  });
});
