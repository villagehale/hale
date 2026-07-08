import { describe, expect, it } from 'vitest';
import { indoorOutdoorLabel, priceBandLabel } from './format';

describe('village attribute chips — unknown tokens stay hidden (honesty)', () => {
  it('resolves an unknown price band to null, never the raw token', () => {
    expect(priceBandLabel('cheap-ish')).toBeNull();
    expect(priceBandLabel(null)).toBeNull();
    expect(priceBandLabel('free')).toBe('Free');
  });

  it('resolves an unknown indoor/outdoor value to null, never the raw token', () => {
    expect(indoorOutdoorLabel('mixed')).toBeNull();
    expect(indoorOutdoorLabel(null)).toBeNull();
    expect(indoorOutdoorLabel('both')).toBe('Indoor & outdoor');
  });
});
