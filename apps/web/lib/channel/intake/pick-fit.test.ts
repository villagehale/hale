import { describe, expect, it } from 'vitest';
import { fitsHouseholdAges } from './pick-fit';

const TODDLER_EXACT = { ageMonths: 18, dobPrecision: 'exact' as const };
const TODDLER_DERIVED = { ageMonths: 18, dobPrecision: 'derived' as const };

describe('fitsHouseholdAges', () => {
  it('drops a band that ends before the only child, keeps all-ages and labels it cannot read', () => {
    const kept = ['Ages 0-1', '18 months - 3 years', 'All ages', 'see site'].filter((ageFit) =>
      fitsHouseholdAges({ ageFit }, [TODDLER_EXACT]),
    );
    // 'Ages 0-1' is 0..12 months and 18 > 12.
    expect(kept).toEqual(['18 months - 3 years', 'All ages', 'see site']);
  });

  it('keeps a band whose bounds read inverted, since that is not a band it can trust', () => {
    // "2-1" reads min 24 > max 12.
    expect(fitsHouseholdAges({ ageFit: 'ages 2-1' }, [TODDLER_EXACT])).toBe(true);
  });

  it('widens the band by the derived-DOB tolerance, and only by it', () => {
    // 12 + 6 >= 18.
    expect(fitsHouseholdAges({ ageFit: 'Ages 0-1' }, [TODDLER_DERIVED])).toBe(true);
    // 12 + 6 < 19.
    expect(fitsHouseholdAges({ ageFit: 'Ages 0-1' }, [{ ...TODDLER_DERIVED, ageMonths: 19 }])).toBe(
      false,
    );
  });

  it('keeps a pick that fits any one sibling', () => {
    const siblings = [TODDLER_EXACT, { ageMonths: 84, dobPrecision: 'exact' as const }];
    // 6-9 years is 72..108 months; 84 is inside.
    expect(fitsHouseholdAges({ ageFit: '6-9 years' }, siblings)).toBe(true);
    expect(fitsHouseholdAges({ ageFit: '6-9 years' }, [TODDLER_EXACT])).toBe(false);
  });

  it('reads open-ended bands from one side only', () => {
    expect(fitsHouseholdAges({ ageFit: '5+' }, [TODDLER_EXACT])).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'under 2' }, [TODDLER_EXACT])).toBe(true);
  });
});

describe('fitsHouseholdAges on labels the band does not wholly read', () => {
  it('keeps a grade label, which is not an age in years', () => {
    // A 7-year-old is in grade 1-3; the label is school years, not ages 1-3.
    expect(
      fitsHouseholdAges({ ageFit: 'Grades 1-3' }, [{ ageMonths: 84, dobPrecision: 'exact' }]),
    ).toBe(true);
  });

  it('keeps a label that carries a second age statement in another unit', () => {
    // 2-5 years is 24..60 months and 36 is inside; the trailing months clause must not
    // turn the whole label into months.
    expect(
      fitsHouseholdAges({ ageFit: '2-5 years (under 18 months free)' }, [
        { ageMonths: 36, dobPrecision: 'exact' },
      ]),
    ).toBe(true);
    expect(
      fitsHouseholdAges({ ageFit: 'Ages 3-6, infants 6 months+ welcome' }, [
        { ageMonths: 48, dobPrecision: 'exact' },
      ]),
    ).toBe(true);
  });

  it('still drops a plain band the child is past (control)', () => {
    expect(fitsHouseholdAges({ ageFit: 'Ages 0-1' }, [TODDLER_EXACT])).toBe(false);
  });
});

describe('fitsHouseholdAges at the edges of the rule', () => {
  it('keeps a child exactly at the lower bound and drops one a month under it', () => {
    // 2-5 years starts at 24 months.
    expect(
      fitsHouseholdAges({ ageFit: '2-5 years' }, [{ ageMonths: 24, dobPrecision: 'exact' }]),
    ).toBe(true);
    expect(
      fitsHouseholdAges({ ageFit: '2-5 years' }, [{ ageMonths: 23, dobPrecision: 'exact' }]),
    ).toBe(false);
  });

  it('never counts a child of unknown age as fitting a readable band, yet keeps all-ages', () => {
    const unknown = [{ ageMonths: null, dobPrecision: 'derived' as const }];
    expect(fitsHouseholdAges({ ageFit: '2-5 years' }, unknown)).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'All ages' }, unknown)).toBe(true);
  });
});
