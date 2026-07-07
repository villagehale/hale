import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A copy-scan guard over the parent-facing surfaces. Hale speaks in ONE warm,
 * third-person voice; engineer-internal tells ("no data", "signal",
 * "auth provider"/"configured", "coarse area") and lower-cased statute strings
 * ("pipeda · law 25") must never reach a parent. This reads the raw source of
 * each surface so a defect is caught at the string, not only when a server
 * component happens to render (these pages need a DB to render).
 */

const webRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Parent-facing surfaces this sweep governs. Paths are from apps/web root. */
const SURFACES = [
  'app/(authed)/companion/page.tsx',
  'app/(authed)/trail/page.tsx',
  'app/(authed)/village/page.tsx',
  'app/(authed)/plan/page.tsx',
  'app/(authed)/settings/page.tsx',
  'app/(authed)/approvals/page.tsx',
  'app/sign-in/page.tsx',
  'app/sign-up/page.tsx',
  'app/onboarding/wizard.tsx',
  'app/preview/intake.tsx',
  'components/hale/village-feed-section.tsx',
  'components/hale/approvals-header.tsx',
  'components/hale/concierge-thread.tsx',
] as const;

/**
 * Engineer-voiced tells, as case-insensitive substrings. Each is a phrase a
 * parent would never say and shouldn't have to read. Kept as whole phrases (not
 * bare words) so legitimate uses — a code identifier, a prop name — don't trip
 * the scan.
 */
const BANNED = [
  'no data',
  'when a signal comes in',
  'auth not configured',
  'auth provider',
  'coarse area',
  'pipeda · law 25',
  'pipeda ·',
  '· pipeda',
  'law 25 · casl',
] as const;

/** Rendered copy only — strip block and line comments so a developer-facing note
 * that legitimately names an internal term ("coarse area") doesn't read as a
 * user-facing defect. The scan governs what a parent sees, not code comments. */
function renderableCopy(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .toLowerCase();
}

const sources = new Map(
  SURFACES.map((rel) => [rel, renderableCopy(readFileSync(join(webRoot, rel), 'utf8'))]),
);

describe('one-voice copy scan', () => {
  for (const phrase of BANNED) {
    it(`no parent-facing surface uses "${phrase}"`, () => {
      const offenders = SURFACES.filter((rel) => sources.get(rel)?.includes(phrase));
      expect(offenders).toEqual([]);
    });
  }

  it('the privacy colophon links to /privacy where it names Canadian privacy law', () => {
    // Wherever a surface still names the privacy posture in a colophon, it must be
    // the warm line that links out to the policy — not a bare statute string.
    const village = sources.get('app/(authed)/village/page.tsx') ?? '';
    expect(village).toContain('/privacy');
  });
});

describe('empty states point somewhere', () => {
  // An empty state is not a dead end: each carries a next step a parent can take.
  it('companion no-children sends a parent to add a child (/family)', () => {
    const companion = sources.get('app/(authed)/companion/page.tsx') ?? '';
    expect(companion).toContain('no children added yet');
    expect(companion).toContain('add a child');
    expect(companion).toContain('href="/family"');
  });

  it('trail empty sends a parent to connect a source (/settings)', () => {
    const trail = sources.get('app/(authed)/trail/page.tsx') ?? '';
    expect(trail).toContain('nothing on the record yet');
    expect(trail).toContain('connect a source');
    expect(trail).toContain('href="/settings"');
  });
});
