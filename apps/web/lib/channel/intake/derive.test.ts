import { ageInMonths } from '@hale/types';
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
