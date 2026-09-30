import { describe, expect, it } from 'vitest';
import {
  HARD_CEILING_MULTIPLIER,
  hardCeilingUsd,
  isOverAllowance,
  isOverHardCeiling,
  monthlyAllowanceUsd,
  spendCeilingDay,
  spendCeilingEnforced,
  spendCeilingWarnText,
} from './allowance.js';

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

describe('isOverHardCeiling', () => {
  it('plus, 1 child ($5 allowance, 3× = $15 ceiling): 2.9× within, exactly 3× within, 3× + a cent over', () => {
    // Derived from the basis: ceiling = monthlyAllowanceUsd * 3 = $5 * 3 = $15.
    expect(isOverHardCeiling(2.9 * 5.0, 'plus', 1)).toBe(false); // $14.50 < $15
    expect(isOverHardCeiling(15.0, 'plus', 1)).toBe(false); // at the ceiling is within
    expect(isOverHardCeiling(15.01, 'plus', 1)).toBe(true); // a cent over trips
  });

  it('sits ABOVE the soft allowance: an over-allowance family is not yet over the hard ceiling', () => {
    // $8 spend, plus, 1 child: over the $5 soft allowance but under the $15 hard ceiling.
    expect(isOverAllowance(8.0, 'plus', 1)).toBe(true);
    expect(isOverHardCeiling(8.0, 'plus', 1)).toBe(false);
  });

  it('scales with child count (fairness): $15 spend under the free-tier 3-child $5 allowance', () => {
    // free, 3 children → $5 allowance → $15 ceiling. $15 is at the ceiling (within),
    // $30 is over.
    expect(isOverHardCeiling(15.0, 'free', 3)).toBe(false);
    expect(isOverHardCeiling(30.0, 'free', 3)).toBe(true);
  });

  it('honours a custom multiplier', () => {
    // plus, 1 child, 2× → $10 ceiling: $9 within, $11 over.
    expect(isOverHardCeiling(9.0, 'plus', 1, 2)).toBe(false);
    expect(isOverHardCeiling(11.0, 'plus', 1, 2)).toBe(true);
  });
});

describe('hardCeilingUsd', () => {
  it('is the allowance × the multiplier (single source for the audited ceiling value)', () => {
    expect(HARD_CEILING_MULTIPLIER).toBe(3);
    // plus, 1 child: $5 × 3 = $15; free, 3 children: $5 × 3 = $15.
    expect(hardCeilingUsd('plus', 1)).toBe(15.0);
    expect(hardCeilingUsd('free', 3)).toBe(15.0);
  });

  it('is exactly the boundary isOverHardCeiling trips just past', () => {
    const ceiling = hardCeilingUsd('plus', 1);
    expect(isOverHardCeiling(ceiling, 'plus', 1)).toBe(false); // at is within
    expect(isOverHardCeiling(ceiling + 0.01, 'plus', 1)).toBe(true); // just over trips
  });
});

describe('spendCeilingEnforced', () => {
  it('is off unless the env is the literal true', () => {
    expect(spendCeilingEnforced({})).toBe(false);
    expect(spendCeilingEnforced({ SPEND_CEILING_ENFORCED: 'false' })).toBe(false);
    expect(spendCeilingEnforced({ SPEND_CEILING_ENFORCED: '1' })).toBe(false);
    expect(spendCeilingEnforced({ SPEND_CEILING_ENFORCED: 'true\n' })).toBe(false);
    expect(spendCeilingEnforced({ SPEND_CEILING_ENFORCED: 'true' })).toBe(true);
  });
});

describe('spendCeilingWarnText', () => {
  const text = spendCeilingWarnText({
    familyId: '2c939172-0000-4000-8000-000000000000',
    planTier: 'free',
    childCount: 1,
    monthToDateCostUsd: 6.01,
    ceilingUsd: 6,
    day: '2026-09-30',
  });

  it('names the family, the dollars, and that processing continues', () => {
    expect(text).toContain('2c939172-0000-4000-8000-000000000000');
    expect(text).toContain('$6.01 of $6.00');
    expect(text).toContain('plan free');
    expect(text).toContain('2026-09-30');
    expect(text).toContain('ingest and chat continue');
    expect(spendCeilingDay(new Date('2026-09-30T23:30:00.000Z'))).toBe('2026-09-30');
  });

  it('carries no opt-out wording', () => {
    expect(text.toLowerCase()).not.toContain('unsubscribe');
    expect(text.toLowerCase()).not.toMatch(/\bstop\b/);
  });
});
