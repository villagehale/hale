import { describe, expect, it } from 'vitest';
import { sitePriceSurface } from './site-price-surface.js';

const ON = { HOLIDAY_PROMO_ENABLED: 'true' };

describe('sitePriceSurface', () => {
  it('stays on the free claims unless the holiday flag is exact true', () => {
    expect(sitePriceSurface(new Date('2026-11-16T12:00:00-05:00'), {})).toBe('legacy');
    expect(
      sitePriceSurface(new Date('2027-01-02T00:00:00-05:00'), {
        HOLIDAY_PROMO_ENABLED: 'TRUE',
      }),
    ).toBe('legacy');
  });

  it('leaves the founding window to the UI draft and shows list prices after the cutoff', () => {
    expect(sitePriceSurface(new Date('2026-12-31T23:59:59-05:00'), ON)).toBe('legacy');
    expect(sitePriceSurface(new Date('2027-01-01T00:00:00-05:00'), ON)).toBe('list');
  });
});
