import { describe, expect, it } from 'vitest';
import { chargedCartMustStop, chargedPricesMustStop, freeCartMaySubmit } from './checkout-gate';

describe('checkout-gate', () => {
  it('stops on a charged cart and on an unknown total', () => {
    expect(chargedCartMustStop(1)).toBe(true);
    expect(chargedCartMustStop(9800)).toBe(true);
    expect(chargedCartMustStop(null)).toBe(true);
    expect(chargedCartMustStop(0)).toBe(false);
  });

  it('allows a submit only for an explicit $0 total', () => {
    expect(freeCartMaySubmit(0)).toBe(true);
    expect(freeCartMaySubmit(null)).toBe(false);
    expect(freeCartMaySubmit(1)).toBe(false);
  });

  it('stops a Playwright submit when any listed price is above $0', () => {
    expect(chargedPricesMustStop([])).toBe(false);
    expect(chargedPricesMustStop([0])).toBe(false);
    expect(chargedPricesMustStop([0, 0])).toBe(false);
    expect(chargedPricesMustStop([1800])).toBe(true);
    expect(chargedPricesMustStop([0, 1800])).toBe(true);
  });
});
