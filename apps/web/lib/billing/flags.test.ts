import { describe, expect, it } from 'vitest';
import { conversionsApiEnabled, holidayPromoEnabled, metaCapiEnabled } from './flags.js';

describe('holiday/conversion flags', () => {
  it('are off unless the value is exactly true', () => {
    expect(holidayPromoEnabled({})).toBe(false);
    expect(conversionsApiEnabled({})).toBe(false);
    expect(metaCapiEnabled({})).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'true\n' })).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'TRUE' })).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'on' })).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'true' })).toBe(true);
    expect(conversionsApiEnabled({ CONVERSIONS_API_ENABLED: 'true' })).toBe(true);
    expect(metaCapiEnabled({ META_CAPI_ENABLED: 'true' })).toBe(true);
  });
});
