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

  it('places the birth date age + 6 months back — the midpoint of the stated year', () => {
    // "she's four" on 2026-07-30 → 54 months back → 2022-01-30.
    expect(deriveDateOfBirth(48, now)).toBe('2022-01-30');
  });

  it('handles a stated age of zero (a newborn) without landing in the future', () => {
    expect(deriveDateOfBirth(0, now)).toBe('2026-01-30');
  });

  it('handles a non-year age', () => {
    // 18 months + 6 → 24 months back.
    expect(deriveDateOfBirth(18, now)).toBe('2024-07-30');
  });
});

describe('summarizeChildren', () => {
  it('names the children the way the parent did, in years', () => {
    expect(
      summarizeChildren([
        { name: 'Maya', ageMonths: 48 },
        { name: 'Leo', ageMonths: 12 },
      ]),
    ).toBe('Maya (4) and Leo (1)');
  });

  it('refers to an unnamed child by age rather than inventing a name', () => {
    expect(summarizeChildren([{ name: null, ageMonths: 48 }])).toBe('your 4-year-old');
    expect(summarizeChildren([{ name: null, ageMonths: 2 }])).toBe('your baby');
  });

  it('joins three children with commas and a final "and"', () => {
    expect(
      summarizeChildren([
        { name: 'Maya', ageMonths: 48 },
        { name: 'Leo', ageMonths: 12 },
        { name: 'Sam', ageMonths: 96 },
      ]),
    ).toBe('Maya (4), Leo (1) and Sam (8)');
  });
});

describe('intakeFamilyName', () => {
  it('uses the first named child, mirroring onboarding', () => {
    expect(intakeFamilyName([{ name: null, ageMonths: 12 }, { name: 'Maya', ageMonths: 48 }])).toBe(
      "Maya's family",
    );
  });

  it('falls back to the neutral name rather than inventing one', () => {
    expect(intakeFamilyName([{ name: null, ageMonths: 12 }])).toBe('Your family');
  });
});
