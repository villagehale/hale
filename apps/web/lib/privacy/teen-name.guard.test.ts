import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * VIL-634 · a new hand-written teen-name regex outside the shared matcher fails.
 * `namesAny` in `@hale/types` is the one matcher. Flag-off gates go through
 * `teenNameIn`. Kid-event `hasWord` classifies activity words, not teens.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** The namesAny loop: split a stored name into letter/number parts, then whole-word. */
const NAMES_ANY_SHAPE = /\.split\(\/\[\^\\p\{L\}\\p\{N\}\]\+\/u\)/;

/** A second copy of namesAny, or the pre-VIL-634 coach matcher under its old name. */
const HAND_WRITTEN_MATCHER = /function mentionsAnyName\b|function namesAny\b/;

const SHARED_MATCHER = 'packages/types/src/teen-name.ts';

const GATES_USING_SHARED: Record<string, string> = {
  'apps/web/lib/channel/coach/tools.ts': 'lookup_week titles and activities',
  'apps/web/lib/channel/linq/kid-event.ts': 'household calendar titles',
  'apps/web/lib/channel/coparent/duty/asks.ts': 'duty teenNames handling',
  'apps/web/lib/sentinel/teen-named.ts': 'email subject, snippet and body',
  'apps/web/lib/rights/export-household.ts': 'household calendar duty owner label',
};

const SCAN_ROOTS = ['apps/web/lib', 'apps/web/app', 'apps/worker/src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo']);
const SOURCE_EXT = /\.(ts|tsx)$/;

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

function relative(full: string): string {
  return full.slice(REPO_ROOT.length + 1);
}

function filesMatching(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      if (pattern.test(readFileSync(file, 'utf8'))) found.push(relative(file));
    }
  }
  return found.sort();
}

describe('one teen-name matcher', () => {
  it('the detector sees a hand-written matcher and the shared namesAny loop (positive control)', () => {
    expect(
      HAND_WRITTEN_MATCHER.test('function mentionsAnyName(title: string, names: string[]) {}'),
    ).toBe(true);
    expect(HAND_WRITTEN_MATCHER.test('function namesAny(text: string, names: string[]) {}')).toBe(
      true,
    );
    expect(
      HAND_WRITTEN_MATCHER.test('function namesTeen(text: string, teenNames: string[]) {}'),
    ).toBe(false);
    expect(NAMES_ANY_SHAPE.test('for (const part of fold(name).split(/[^\\p{L}\\p{N}]+/u))')).toBe(
      true,
    );
    expect(readFileSync(join(REPO_ROOT, SHARED_MATCHER), 'utf8')).toMatch(NAMES_ANY_SHAPE);
    expect(readFileSync(join(REPO_ROOT, SHARED_MATCHER), 'utf8')).toMatch(HAND_WRITTEN_MATCHER);
  });

  it('the namesAny loop lives only in the shared matcher', () => {
    expect(filesMatching(NAMES_ANY_SHAPE)).toEqual([SHARED_MATCHER]);
  });

  it('no module writes a teen-name matcher of its own', () => {
    expect(filesMatching(HAND_WRITTEN_MATCHER)).toEqual([SHARED_MATCHER]);
  });

  it('every title and text gate goes through teenNameIn or namesAny', () => {
    for (const [file, reason] of Object.entries(GATES_USING_SHARED)) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(source, reason).toMatch(/\b(?:teenNameIn|namesAny|teenNameSharedMatcherEnabled)\b/);
    }
  });
});
