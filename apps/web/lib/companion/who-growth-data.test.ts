import { describe, expect, it } from 'vitest';
import { WHO_GROWTH_LMS, WHO_MAX_MONTH, WHO_MIN_MONTH, type WhoLmsRow } from './who-growth-data';

/** A committed LMS row for a known-present (measure, sex, month); throws if missing. */
function lms(measure: 'weight' | 'height' | 'head', sex: 'male' | 'female', month: number): WhoLmsRow {
  const row = WHO_GROWTH_LMS[measure][sex][month];
  if (!row) throw new Error(`no WHO row: ${measure}/${sex}/${month}`);
  return row;
}

/**
 * Provenance guard for the committed WHO Child Growth Standards LMS tables. The
 * expected values are KNOWN WHO published anchors read from the official who.int
 * z-score "expanded tables" (retrieved 2026-07-18), NOT copied from this code's
 * output — they double as a spot-check that the generated file wasn't corrupted or
 * silently regenerated with wrong numbers. Medians (M) at 0/6/12/24/60 months match
 * WHO's published monthly medians (e.g. boys weight 3.3 / 7.9 / 9.6 / 12.1 / 18.3 kg).
 */

describe('WHO_GROWTH_LMS tables', () => {
  it('covers every month from birth to 60, for all three measures and both sexes', () => {
    expect(WHO_MIN_MONTH).toBe(0);
    expect(WHO_MAX_MONTH).toBe(60);
    for (const measure of ['weight', 'height', 'head'] as const) {
      for (const sex of ['male', 'female'] as const) {
        expect(WHO_GROWTH_LMS[measure][sex]).toHaveLength(61);
      }
    }
  });

  it('matches published weight-for-age anchors (kg)', () => {
    expect(lms('weight', 'male', 0)).toEqual({ l: 0.3487, m: 3.3464, s: 0.14602 });
    expect(lms('weight', 'male', 6).m).toBe(7.9389);
    expect(lms('weight', 'male', 12).m).toBe(9.646);
    expect(lms('weight', 'male', 24).m).toBe(12.1482);
    expect(lms('weight', 'male', 60).m).toBe(18.3352);

    expect(lms('weight', 'female', 0).m).toBe(3.2322);
    expect(lms('weight', 'female', 6).m).toBe(7.3016);
    expect(lms('weight', 'female', 12).m).toBe(8.9462);
  });

  it('matches published length/height-for-age anchors (cm), with L fixed at 1', () => {
    expect(lms('height', 'male', 0).m).toBe(49.8842);
    expect(lms('height', 'male', 24).m).toBe(87.8018);
    expect(lms('height', 'male', 60).m).toBe(109.9593);
    expect(lms('height', 'female', 0).m).toBe(49.1477);
    // Length/height is modelled as a symmetric (normal) distribution → L === 1.
    for (const sex of ['male', 'female'] as const) {
      for (const row of WHO_GROWTH_LMS.height[sex]) expect(row.l).toBe(1);
    }
  });

  it('matches published head-circumference-for-age anchors (cm), with L fixed at 1', () => {
    expect(lms('head', 'male', 0).m).toBe(34.4618);
    expect(lms('head', 'male', 12).m).toBe(46.0637);
    expect(lms('head', 'male', 24).m).toBe(48.2494);
    expect(lms('head', 'female', 0).m).toBe(33.8787);
    for (const sex of ['male', 'female'] as const) {
      for (const row of WHO_GROWTH_LMS.head[sex]) expect(row.l).toBe(1);
    }
  });

  it('has strictly positive M and S for every row (no zero/negative parameters)', () => {
    for (const measure of ['weight', 'height', 'head'] as const) {
      for (const sex of ['male', 'female'] as const) {
        for (const row of WHO_GROWTH_LMS[measure][sex]) {
          expect(row.m).toBeGreaterThan(0);
          expect(row.s).toBeGreaterThan(0);
        }
      }
    }
  });
});
