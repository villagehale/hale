import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PINNED_INSTANT, at, pinnedNow } from '~/lib/testing/clock';

/**
 * A journey test that reads the wall clock fails in quiet hours and across
 * midnight. New journey tests use the pinned clock in `lib/testing/clock`.
 * The allowlist is the journey files that do not, as of today. It may only
 * shrink. Raising an allowlist needs Barton's own words.
 */
const WITHOUT_CLOCK = [
  'activity-answered.test.ts',
  'booked-activity.test.ts',
  'deep-answer-at-question-time.test.ts',
  'first-reply-action-line.test.ts',
  'founder-welcome.test.ts',
  'going-count.test.ts',
  'group-onboarding.test.ts',
  'multi-family-preview.pglite.test.ts',
  'offer-is-a-proposal.test.ts',
  'one-evening-in-the-voice.test.ts',
  'open-loop-kept.test.ts',
  'review-reaches-the-next-parent.test.ts',
  'stated-fact-remembered.test.ts',
  'toddler-journey.test.ts',
  'travel-brief.test.ts',
  'weekday-care.test.ts',
  'zero-fixed-copy-failpath.test.ts',
] as const;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const USES_PINNED_CLOCK = /from\s+['"](?:~\/lib\/testing\/clock|\.\.\/testing\/clock)['"]/;

function usesPinnedClock(source: string): boolean {
  return USES_PINNED_CLOCK.test(source);
}

function missingClock(): string[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => !usesPinnedClock(readFileSync(join(HERE, name), 'utf8')))
    .sort();
}

describe('journey tests pin the clock', () => {
  it('a file uses the pinned clock, or it is on the allowlist', () => {
    expect(missingClock()).toEqual([...WITHOUT_CLOCK]);
  });

  it('positive control: an import is use, and a bare new Date() is not', () => {
    expect(usesPinnedClock("import { pinnedNow } from '~/lib/testing/clock';")).toBe(true);
    expect(usesPinnedClock("import { at } from '../testing/clock';")).toBe(true);
    expect(usesPinnedClock('const now = new Date();')).toBe(false);
  });

  it('pins one instant and refuses a value that is not a time', () => {
    expect(pinnedNow().toISOString()).toBe(PINNED_INSTANT);
    expect(pinnedNow().getTime()).toBe(at(PINNED_INSTANT).getTime());
    expect(at('2026-08-26T13:00:00.000Z').toISOString()).toBe(PINNED_INSTANT);
    expect(() => at('tomorrow')).toThrow(/not an instant/);
  });
});
