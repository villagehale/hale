import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ONBOARDING_INTENTS is the canonical intent taxonomy in @hale/types, hand-mirrored
 * into the mobile bundle (Metro can't import the package). If a future intent is
 * added to @hale/types but not to the mirror, the mobile chip row silently drops it.
 * This drift guard reads BOTH files as text and asserts the VALUE list is identical
 * (order included), so the omission fails CI. Labels may legitimately differ (the
 * mobile chips use shorter copy), so only the values are guarded.
 */
function readIntentValues(relPath: string): string[] {
  const text = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
  const body = text.match(/ONBOARDING_INTENTS[\s\S]*?=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...body.matchAll(/value:\s*'([^']+)'/g)].map((m) => m[1]);
}

// The canonical taxonomy, derived from the spec (not copied from either file's output)
// — so a false-empty extraction or a dropped entry on the CANONICAL side also fails.
const CANONICAL_VALUES = [
  'activities',
  'childcare',
  'milestones',
  'planning',
  'sitter',
  'health',
  'community',
  'sleep',
  'feeding',
  'potty',
  'exploring',
];

describe('onboarding-intents parity (@hale/types ↔ mobile mirror)', () => {
  it('mirrors the same intent VALUE list, in order, in both source files', () => {
    const types = readIntentValues('../../../../packages/types/src/onboarding-intents.ts');
    const mobile = readIntentValues('../../../mobile/src/lib/onboarding-intents.ts');

    // The canonical file carries exactly the spec taxonomy (pins the extraction).
    expect(types).toEqual(CANONICAL_VALUES);
    // The mobile mirror carries the identical value list, order included.
    expect(mobile).toEqual(types);
  });
});
