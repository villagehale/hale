import { describe, expect, it } from 'vitest';
import { isOverAllowance, monthlyAllowanceUsd } from './allowance.js';

/**
 * Expectations are hand-derived from the documented basis (allowance.ts), never
 * copied from runtime output:
 *   paid (plus/family): base $5.00, +$3.00 per child beyond the first.
 *   free:               base $2.00, +$1.50 per child beyond the first.
 *   allowance(tier, n) = base + max(0, n - 1) * perAdditionalChild.
 */

describe('monthlyAllowanceUsd', () => {
  it('paid tiers: 0 and 1 child both get exactly the base ($5.00)', () => {
    expect(monthlyAllowanceUsd('plus', 0)).toBe(5.0);
    expect(monthlyAllowanceUsd('plus', 1)).toBe(5.0);
    expect(monthlyAllowanceUsd('family', 0)).toBe(5.0);
    expect(monthlyAllowanceUsd('family', 1)).toBe(5.0);
  });

  it('paid tiers: 3 children → $5 + 2 × $3 = $11.00', () => {
    expect(monthlyAllowanceUsd('plus', 3)).toBe(11.0);
    expect(monthlyAllowanceUsd('family', 3)).toBe(11.0);
  });

  it('free tier: 1 child → $2.00, 3 children → $2 + 2 × $1.50 = $5.00', () => {
    expect(monthlyAllowanceUsd('free', 1)).toBe(2.0);
    expect(monthlyAllowanceUsd('free', 3)).toBe(5.0);
  });

  it('clamps negative child counts to the base (no negative credit)', () => {
    expect(monthlyAllowanceUsd('plus', -2)).toBe(5.0);
  });
});

describe('isOverAllowance', () => {
  it('plus, 1 child ($5 allowance): exactly at is within, a cent over is over', () => {
    expect(isOverAllowance(5.0, 'plus', 1)).toBe(false);
    expect(isOverAllowance(5.01, 'plus', 1)).toBe(true);
    expect(isOverAllowance(4.99, 'plus', 1)).toBe(false);
  });

  it('plus, 3 children ($11 allowance): $10.50 within, $11.50 over', () => {
    expect(isOverAllowance(10.5, 'plus', 3)).toBe(false);
    expect(isOverAllowance(11.5, 'plus', 3)).toBe(true);
  });

  it('the per-child credit lifts a family from over to within (fairness)', () => {
    // $8 spend: a 1-child family ($5 allowance) is over; a 3-child family ($11) is not.
    expect(isOverAllowance(8.0, 'plus', 1)).toBe(true);
    expect(isOverAllowance(8.0, 'plus', 3)).toBe(false);
  });
});
