import { ageInMonths, deriveStage } from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  deriveDateOfBirth,
  intakeFamilyName,
  parseCanadianPostal,
  summarizeChildren,
} from './derive';

describe('parseCanadianPostal', () => {
  it('canonicalizes a full code to "A1A 1A1" and carries its FSA', () => {
    expect(parseCanadianPostal('m5v2t6')).toEqual({ postalCode: 'M5V 2T6', areaCoarse: 'M5V' });
    expect(parseCanadianPostal(' M5V 2T6 ')).toEqual({ postalCode: 'M5V 2T6', areaCoarse: 'M5V' });
    expect(parseCanadianPostal('l7g-4s8')).toEqual({ postalCode: 'L7G 4S8', areaCoarse: 'L7G' });
  });

  it('accepts a bare FSA as sufficient postal context, storing no full code (D2)', () => {
    expect(parseCanadianPostal('L3R')).toEqual({ postalCode: null, areaCoarse: 'L3R' });
    expect(parseCanadianPostal('l3r')).toEqual({ postalCode: null, areaCoarse: 'L3R' });
    expect(parseCanadianPostal(' l6c ')).toEqual({ postalCode: null, areaCoarse: 'L6C' });
  });

  it('returns null for anything that is not a Canadian postal token (the region gate)', () => {
    expect(parseCanadianPostal('10001')).toBeNull(); // US ZIP
    expect(parseCanadianPostal('90210-1234')).toBeNull();
    expect(parseCanadianPostal('SW1A 1AA')).toBeNull(); // UK outward+inward
    expect(parseCanadianPostal('W1A')).toBeNull(); // a London outward code shaped like an FSA
    expect(parseCanadianPostal('the Danforth')).toBeNull();
    expect(parseCanadianPostal('L3')).toBeNull(); // too short to be an FSA
    expect(parseCanadianPostal('3LR')).toBeNull(); // right length, wrong shape
    expect(parseCanadianPostal('L3R 5')).toBeNull(); // half an LDU is not a code
    expect(parseCanadianPostal(null)).toBeNull();
  });
});

describe('deriveDateOfBirth', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');

  it('places a bare YEAR statement on the midpoint of the year it names', () => {
    // "she's four" is anywhere in [48, 60) months, so 54 months back is the estimate
    // with the smallest worst-case error (±6 rather than −0/+12).
    expect(deriveDateOfBirth(48, 'years', now)).toBe('2022-01-30');
    expect(deriveDateOfBirth(0, 'years', now)).toBe('2026-01-30');
  });

  it('stores a MONTH-granularity statement exactly as stated', () => {
    // "18 months" is already the point the parent narrowed to. Adding the year-band
    // midpoint on top would say twenty-four, which is not what anyone said.
    expect(deriveDateOfBirth(18, 'months', now)).toBe('2025-01-30');
    // "3 and a half" → 42, "almost 3" → 33, "just born" → 0.
    expect(deriveDateOfBirth(42, 'months', now)).toBe('2023-01-30');
    expect(deriveDateOfBirth(33, 'months', now)).toBe('2023-10-30');
    expect(deriveDateOfBirth(0, 'months', now)).toBe('2026-07-30');
  });

  it('round-trips: the age read back out of the stored date is the age stated', () => {
    // This is the invariant the whole module rests on — every consumer downstream
    // re-derives the age from date_of_birth rather than carrying the spoken one.
    for (const stated of [0, 1, 6, 12, 18, 24, 33, 42, 60]) {
      expect(ageInMonths(deriveDateOfBirth(stated, 'months', now), now)).toBe(stated);
    }
    // A year statement round-trips to its midpoint, by design.
    expect(ageInMonths(deriveDateOfBirth(48, 'years', now), now)).toBe(54);
  });

  /**
   * VIL-266, end to end: a parent texting "she's four" is the exact case the
   * preschool stage was added for. The stated age becomes a stored date_of_birth,
   * and every downstream surface re-derives the stage from THAT — so this asserts
   * the intake→storage→derivation chain lands on preschool rather than the
   * school-age band a four-year-old used to be searched in.
   */
  it('lands a spoken "four years old" in the preschool stage, not school-age', () => {
    const dob = deriveDateOfBirth(48, 'years', now);
    expect(ageInMonths(dob, now)).toBe(54);
    expect(deriveStage(dob, now)).toBe('preschool');
  });

  it('walks the stated-age band across the preschool boundaries', () => {
    // Stated in MONTHS, so the date is exact and the stage is the spec's, not a midpoint's.
    const stageForStatedMonths = (months: number) =>
      deriveStage(deriveDateOfBirth(months, 'months', now), now);
    expect(stageForStatedMonths(47)).toBe('toddler');
    expect(stageForStatedMonths(48)).toBe('preschool');
    expect(stageForStatedMonths(59)).toBe('preschool');
    expect(stageForStatedMonths(60)).toBe('child');
  });
});

/**
 * VIL-263 — the round-trip invariant over every shape that can overflow a
 * day-of-month, rather than over the handful of dates the module was written against.
 *
 * Subtracting months from a date lands on a day the target month may not have (the
 * 31st of February), and JS rolls such a date FORWARD into the next month. That moves
 * the stored birthday later, so the child reads back a month off the age their parent
 * actually stated — for the 28th-to-31st of every month, which is two to three days of
 * signups in each one.
 *
 * The exhaustive sweep is the deliverable, not a February case: an assertion over
 * every (signup date × stated age × precision) is what makes the class impossible to
 * reintroduce, where a fixture for the one date that bit us would not.
 */
describe('deriveDateOfBirth — the day-of-month round trip', () => {
  /** The days a subtraction can overflow from. Everything at or below the 28th exists
   * in every month, including February, so it can never roll. */
  const OVERFLOW_DAYS = [28, 29, 30, 31];
  /** Both a common and a leap year, so the 29th of February is a signup date too. */
  const YEARS = [2026, 2028];
  const AGES = Array.from({ length: 60 }, (_, i) => i + 1);

  /** Noon UTC: far enough from either midnight that the module's UTC date fields and
   * `ageInMonths`'s local ones name the same calendar day in any Canadian zone. */
  function signupAt(year: number, monthIndex: number, day: number): Date | null {
    const at = new Date(Date.UTC(year, monthIndex, day, 12));
    // The 30th of February is not a signup date, it is a rolled one — skip rather than
    // assert about a day that never happens.
    return at.getUTCDate() === day ? at : null;
  }

  it.each([
    // A month statement is stored as spoken; a year statement is stored on the
    // midpoint of the year it names, six months on (see MIDPOINT_CORRECTION_MONTHS).
    ['months', 0],
    ['years', 6],
  ] as const)(
    'stores an age stated in %s so it reads back unchanged, from every signup date',
    (precision, midpointCorrection) => {
      const wrong: string[] = [];
      let checked = 0;

      for (const year of YEARS) {
        for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
          for (const day of OVERFLOW_DAYS) {
            const now = signupAt(year, monthIndex, day);
            if (!now) continue;
            for (const stated of AGES) {
              checked += 1;
              const dob = deriveDateOfBirth(stated, precision, now);
              const readBack = ageInMonths(dob, now);
              const expected = stated + midpointCorrection;
              if (readBack !== expected) {
                wrong.push(
                  `${now.toISOString().slice(0, 10)} + ${stated}mo → ${dob} reads ${readBack}, want ${expected}`,
                );
              }
            }
          }
        }
      }

      expect(wrong).toEqual([]);
      expect(checked).toBe(4980);
    },
  );
});

describe('summarizeChildren', () => {
  it('names the children the way the parent did, in years', () => {
    expect(
      summarizeChildren([
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
        { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
      ]),
    ).toBe('Maya (4) and Leo (1)');
  });

  it('refers to an unnamed child by age rather than inventing a name', () => {
    expect(summarizeChildren([{ name: null, ageMonths: 48, agePrecision: 'years' }])).toBe(
      'your 4-year-old',
    );
    expect(summarizeChildren([{ name: null, ageMonths: 2, agePrecision: 'months' }])).toBe(
      'your baby',
    );
  });

  it('names a child whose age we were never told without inventing one', () => {
    expect(
      summarizeChildren([
        { name: 'Nora', ageMonths: null, agePrecision: null },
        { name: 'Ben', ageMonths: null, agePrecision: null },
      ]),
    ).toBe('Nora and Ben');
  });

  it('joins three children with commas and a final "and"', () => {
    expect(
      summarizeChildren([
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
        { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
        { name: 'Sam', ageMonths: 96, agePrecision: 'years' },
      ]),
    ).toBe('Maya (4), Leo (1) and Sam (8)');
  });
});

describe('intakeFamilyName', () => {
  it('uses the first named child, mirroring onboarding', () => {
    expect(
      intakeFamilyName([
        { name: null, ageMonths: 12, agePrecision: 'years' },
        { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
      ]),
    ).toBe("Maya's family");
  });

  it('falls back to the neutral name rather than inventing one', () => {
    expect(intakeFamilyName([{ name: null, ageMonths: 12, agePrecision: 'years' }])).toBe(
      'Your family',
    );
  });
});
