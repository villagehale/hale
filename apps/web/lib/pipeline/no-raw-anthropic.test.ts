import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NO RAW `new Anthropic` — the structural half of the 2026-09-03 SMS reliability
 * audit's P1-7. The SDK's silent defaults are timeout 600s + 2 retries: a client
 * constructed bare may legally wait ~30 minutes, inside serverless functions that
 * get 300s — one stalled call burned the registration-verify sweep's already-spent
 * weekly claim, silently, until next Monday.
 *
 * The invariant: every Anthropic client states its budget where it is constructed,
 * and construction happens at ONE site (`budgetedAnthropic` in pipeline/client.ts),
 * whose signature makes an unbudgeted client unexpressible. A code review cannot
 * keep that true as the codebase grows, so it is a test — same shape as
 * one-door.test.ts, for the same reason.
 *
 * Adding a file to the allowlist is a deliberate act: the justification string is
 * the reviewer's contract that the new construction site carries an explicit,
 * hosting-budget-aware timeout.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** The construction token, paren included so prose mentions in comments don't count. */
const RAW_CONSTRUCTOR = 'new Anthropic(';

const ALLOWLIST: Record<string, string> = {
  'apps/web/lib/pipeline/client.ts':
    'the door itself — budgetedAnthropic() and the named per-lane budget constants',
  'apps/worker/src/anthropic/client.ts':
    'RESIDUE: the worker’s own single construction site on a long-lived Node runtime — no serverless wall to violate today (the Fly worker is not deployed; drain runs web-side). Budget it when the worker ships.',
};

/** Where a client could hide. Eval harnesses (the per-app evals dirs) are deliberately
 * NOT scanned: they are CLI scripts with their own wall-clock ownership, not code that
 * runs inside a serverless window. */
const SCAN_ROOTS = [
  'apps/web/app',
  'apps/web/lib',
  'apps/web/components',
  'apps/web/scripts',
  'apps/worker/src',
  'apps/worker/scripts',
  'packages',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function filesConstructingClients(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      if (readFileSync(file, 'utf8').includes(RAW_CONSTRUCTOR)) {
        found.push(file.slice(REPO_ROOT.length + 1));
      }
    }
  }
  return found.sort();
}

describe('no raw new Anthropic outside the budgeted construction site (audit P1-7)', () => {
  const found = filesConstructingClients();

  it('positive control: the scanner sees the door itself', () => {
    // A scan that cannot find pipeline/client.ts is a broken scanner, not a clean
    // repo — the assertion below would pass vacuously ("a refusal is not evidence").
    expect(found).toContain('apps/web/lib/pipeline/client.ts');
  });

  it('no file constructs an Anthropic client outside the allowlist', () => {
    const strangers = found.filter((file) => !(file in ALLOWLIST));
    expect(
      strangers,
      `These files call \`new Anthropic(\` directly — the SDK's silent defaults (600s timeout, 2 retries) outlive every serverless window this app runs in.
Construct through budgetedAnthropic() in lib/pipeline/client.ts with an explicit budget sized to the hosting function's maxDuration, or add the file here WITH the justification that names its budget:
  ${strangers.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the allowlist carries no stale entries', () => {
    const foundSet = new Set(found);
    const stale = Object.keys(ALLOWLIST).filter((file) => !foundSet.has(file));
    expect(
      stale,
      `These ALLOWLIST entries no longer construct a client — remove them so the list stays the real inventory:
  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
