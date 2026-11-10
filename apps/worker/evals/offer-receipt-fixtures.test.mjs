import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFER_RECEIPT_FIXTURES } from './offer-receipt-fixtures.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const RUNNER = fileURLToPath(new URL('./run-offer-receipt-eval.mjs', import.meta.url));
const KEYLESS = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/ANTHROPIC|AI_GATEWAY|LINQ|DATABASE|BROWSER_USE|HALE_SPEND|HALE_MAX/.test(key),
  ),
);
const run = (args, extraEnv = {}) =>
  spawnSync(process.execPath, [RUNNER, ...args], {
    env: { ...KEYLESS, ...extraEnv },
    encoding: 'utf8',
  });

describe('offer-receipt fixtures', () => {
  it('covers Hale’s calendar with no Google, Google connected, a non-English parent, and French words under an English tag', () => {
    const byId = new Map(OFFER_RECEIPT_FIXTURES.map((fixture) => [fixture.id, fixture.facts]));
    expect(byId.get('en-hale-no-google')).toMatchObject({
      happened: 'added',
      language: null,
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: false,
      alsoOnGoogle: false,
    });
    expect(byId.get('en-hale-google-connected')).toMatchObject({
      happened: 'added',
      language: null,
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: true,
      alsoOnGoogle: false,
    });
    const french = byId.get('fr-hale-no-google');
    expect(french).toMatchObject({
      happened: 'added',
      language: null,
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: false,
      alsoOnGoogle: false,
    });
    expect(french?.parentReply.startsWith('Oui')).toBe(true);
    const frenchUnderEn = byId.get('fr-reply-en-tag');
    expect(frenchUnderEn).toMatchObject({
      happened: 'added',
      language: 'en',
      placedOn: 'hale_family_calendar',
      googleCalendarConnected: false,
      alsoOnGoogle: false,
    });
    expect(frenchUnderEn?.parentReply.startsWith('Oui')).toBe(true);
  });
});

describe('offer-receipt eval wiring', () => {
  it('loads a managed judge, prices with --dry, and is not in CI until recorded', () => {
    const runner = read('./run-offer-receipt-eval.mjs');
    expect(runner).toMatch(/judgePrompt\('offer-receipt'\)/);
    expect(runner).not.toMatch(/receiptLineOk|smsSegments|MAX_SEGMENTS/);
    const pkg = JSON.parse(read('../package.json'));
    expect(pkg.scripts['eval:offer-receipt']).toBe(
      'node evals/run-offer-receipt-eval.mjs --cached-only',
    );
    expect(pkg.scripts['eval:offer-receipt:dry']).toBe('node evals/run-offer-receipt-eval.mjs --dry');
    const ci = read('../../../.github/workflows/ci.yml');
    expect(ci).not.toMatch(/eval:offer-receipt/);
  });

  it.each([[[]], [['--dyr']], [['--dry', '--cached-only']], [['--max-usd', '0.2']]])(
    'exits 2 on %j before anything runs',
    (args) => {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    },
  );

  it('--dry makes no calls and prints a worst case', () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'offer-receipt-ledger-'));
    const result = run(['--dry'], { HALE_SPEND_LEDGER: join(ledgerDir, 'ledger.jsonl') });
    rmSync(ledgerDir, { recursive: true, force: true });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/DRY offer-receipt /);
    expect(result.stdout).toMatch(/live calls: 0/);
    expect(result.stdout).toMatch(/B changed-only worst \$\d+\.\d{5}/);
    expect(result.stdout).toMatch(/A full re-record worst \$\d+\.\d{5}/);
  }, 60_000);
});
