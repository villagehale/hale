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
