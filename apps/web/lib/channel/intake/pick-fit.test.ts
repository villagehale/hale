import { describe, expect, it } from 'vitest';
import { fitsHouseholdAges, onlyDatedBefore } from './pick-fit';

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
  it('keeps a grade label that also states ages, since it reads two ways', () => {
    expect(fitsHouseholdAges({ ageFit: 'Ages 6-9 (Grades 1-3)' }, [TODDLER_EXACT])).toBe(true);
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

describe('fitsHouseholdAges on school grades', () => {
  it('reads a grade band as school ages, not ages in years', () => {
    // A 7-year-old is in grade 1-3; the label is school years, not ages 1-3.
    expect(
      fitsHouseholdAges({ ageFit: 'Grades 1-3' }, [{ ageMonths: 84, dobPrecision: 'exact' }]),
    ).toBe(true);
    expect(fitsHouseholdAges({ ageFit: 'Grades 1-3' }, [TODDLER_EXACT])).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'Grades 1-3' }, [TODDLER_DERIVED])).toBe(false);
  });

  it('reads kindergarten as the youngest school year', () => {
    const fourYearOld = { ageMonths: 48, dobPrecision: 'exact' as const };
    expect(fitsHouseholdAges({ ageFit: 'Kindergarten' }, [fourYearOld])).toBe(true);
    expect(fitsHouseholdAges({ ageFit: 'Kindergarten' }, [TODDLER_DERIVED])).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'Grades K-5' }, [fourYearOld])).toBe(true);
    expect(fitsHouseholdAges({ ageFit: 'Grades K-5' }, [TODDLER_EXACT])).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'JK to Grade 2' }, [TODDLER_EXACT])).toBe(false);
  });

  it('reads a single grade, an ordinal grade and an open-ended grade', () => {
    const sevenYearOld = [{ ageMonths: 84, dobPrecision: 'exact' as const }];
    expect(fitsHouseholdAges({ ageFit: 'Grade 2' }, sevenYearOld)).toBe(true);
    expect(fitsHouseholdAges({ ageFit: 'Grade 2' }, [TODDLER_EXACT])).toBe(false);
    expect(fitsHouseholdAges({ ageFit: '1st-3rd grade' }, sevenYearOld)).toBe(true);
    expect(fitsHouseholdAges({ ageFit: '1st-3rd grade' }, [TODDLER_EXACT])).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'Grades 9-12' }, sevenYearOld)).toBe(false);
    expect(fitsHouseholdAges({ ageFit: 'Grade 6 and up' }, sevenYearOld)).toBe(false);
    expect(
      fitsHouseholdAges({ ageFit: 'Grade 6 and up' }, [{ ageMonths: 168, dobPrecision: 'exact' }]),
    ).toBe(true);
  });
});

describe('onlyDatedBefore', () => {
  const TODAY = '2026-11-08';
  const when = (text: string | null, eventDate?: string) =>
    onlyDatedBefore({ when: text, ...(eventDate ? { eventDate } : {}) }, TODAY);

  it('drops a find whose only dates are behind today', () => {
    expect(when('Saturday, March 8, 2026')).toBe(true);
    expect(when('Jan 10 - Mar 14, 2026, Saturdays 10am')).toBe(true);
    expect(when('March 2026')).toBe(true);
    expect(when('Fall 2025')).toBe(true);
    expect(when('8 March 2026')).toBe(true);
    expect(when('2026-03-08')).toBe(true);
    expect(when(null, '2026-03-08')).toBe(true);
  });

  it('keeps a find dated today or later (control)', () => {
    expect(when('Saturday, November 8, 2026')).toBe(false);
    expect(when('Dec 5, 2026')).toBe(false);
    expect(when('Mar 8, 2026 and Jan 9, 2027')).toBe(false);
    expect(when('Winter 2027')).toBe(false);
    expect(when(null, '2026-11-08')).toBe(false);
  });

  it('keeps a find with no year to read, and one with no date at all', () => {
    expect(when('Saturdays 9:15am, fall session from Sept 13')).toBe(false);
    expect(when('March 8')).toBe(false);
    expect(when('Tuesdays')).toBe(false);
    expect(when(null)).toBe(false);
  });

  it('keeps an open-ended start, which may still be running', () => {
    expect(when('Saturdays, starting Sept 13, 2025')).toBe(false);
    expect(when('from Jan 10 to Mar 14, 2026')).toBe(true);
  });

  it('reads a school year by its second year', () => {
    expect(onlyDatedBefore({ when: '2026-27 season' }, '2027-01-15')).toBe(false);
    expect(onlyDatedBefore({ when: '2024-25 season' }, TODAY)).toBe(true);
  });
});
