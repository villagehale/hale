import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fixtureFamilyFsaHits,
  incidentFamilyNeedle,
  matchingLines,
  realFsaNeedle,
} from './fixture-family-fsa.mjs';

describe('fixture comments must not name a real family', () => {
  it('recognises the phrases the ticket named', () => {
    const real = realFsaNeedle();
    const incident = incidentFamilyNeedle();
    const sample = [
      `/** Georgetown — the ${incident}'s ${real}. */`,
      'const AREA = "L7G";',
      'a code-valid FSA, not a household',
    ].join('\n');

    expect(matchingLines(sample, real)).toEqual([
      `1:/** Georgetown — the ${incident}'s ${real}. */`,
    ]);
    expect(matchingLines(sample, incident)).toEqual([
      `1:/** Georgetown — the ${incident}'s ${real}. */`,
    ]);
  });

  it('does not embed the phrases in the guard itself', () => {
    const here = fileURLToPath(new URL('./fixture-family-fsa.mjs', import.meta.url));
    const test = fileURLToPath(import.meta.url);
    expect(readFileSync(here, 'utf8').includes(realFsaNeedle())).toBe(false);
    expect(readFileSync(here, 'utf8').includes(incidentFamilyNeedle())).toBe(false);
    expect(readFileSync(test, 'utf8').includes(realFsaNeedle())).toBe(false);
    expect(readFileSync(test, 'utf8').includes(incidentFamilyNeedle())).toBe(false);
  });

  it('is absent from every tracked file', () => {
    const hits = fixtureFamilyFsaHits();
    expect(
      hits,
      `A fixture comment still names a real person or family. Use FIXTURE_FSA from apps/web/lib/testing/fixture-postal.ts.\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});
