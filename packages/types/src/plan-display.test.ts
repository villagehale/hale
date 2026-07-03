import { describe, expect, it } from 'vitest';
import type { PlanTier } from './entitlements.js';
import {
  PLAN_DISPLAY,
  PLAN_TIERS_ORDERED,
  formatPlanPrice,
} from './plan-display.js';

/**
 * Prices are the confirmed freemium model (CAD — Canada-first), asserted against
 * the spec, not copied from runtime: Free $0, Plus $9/mo or $79/yr, Family $19/mo
 * or $159/yr, each rendered with an explicit CAD label.
 * Tier names follow the standard plain convention (Free / Plus / Family). The
 * display data is presentation-only and must not change the PlanTier enum values
 * (free/plus/family).
 */
describe('PLAN_DISPLAY (the displayed plan source of truth)', () => {
  it('exposes exactly the three PlanTier tiers, free first', () => {
    expect(PLAN_TIERS_ORDERED).toEqual(['free', 'plus', 'family']);
    expect(Object.keys(PLAN_DISPLAY).sort()).toEqual(['family', 'free', 'plus']);
  });

  it('uses the standard plain tier names (Free / Plus / Family)', () => {
    expect(PLAN_DISPLAY.free.name).toBe('Free');
    expect(PLAN_DISPLAY.plus.name).toBe('Plus');
    expect(PLAN_DISPLAY.family.name).toBe('Family');
  });

  it('drops the old cutesy names entirely', () => {
    const names = PLAN_TIERS_ORDERED.map((tier) => PLAN_DISPLAY[tier].name);
    expect(names).not.toContain('Village');
    expect(names).not.toContain('Hale helps');
    expect(names).not.toContain('Hale handles it');
  });

  it('carries the confirmed monthly + annual prices (CAD)', () => {
    expect(PLAN_DISPLAY.free.monthlyPriceCad).toBe(0);
    expect(PLAN_DISPLAY.free.annualPriceCad).toBe(0);

    expect(PLAN_DISPLAY.plus.monthlyPriceCad).toBe(9);
    expect(PLAN_DISPLAY.plus.annualPriceCad).toBe(79);

    expect(PLAN_DISPLAY.family.monthlyPriceCad).toBe(19);
    expect(PLAN_DISPLAY.family.annualPriceCad).toBe(159);
  });

  it('annual is the better value — under twelve months of monthly for paid tiers', () => {
    for (const tier of ['plus', 'family'] as const) {
      const plan = PLAN_DISPLAY[tier];
      expect(plan.annualPriceCad).toBeLessThan(plan.monthlyPriceCad * 12);
    }
  });

  it('every tier lists features', () => {
    for (const tier of PLAN_TIERS_ORDERED) {
      expect(PLAN_DISPLAY[tier].features.length).toBeGreaterThan(0);
    }
  });

  it('never sells multi-child or co-parent as paid features — both are free', () => {
    // Multi-child and co-parent are NOT in PLAN_ENTITLEMENTS: the free tier already
    // delivers both. The paid tiers gate autonomy + execution integrations only, so
    // no paid feature line may claim to unlock either.
    for (const tier of ['plus', 'family'] as const) {
      const features = PLAN_DISPLAY[tier].features.join(' ').toLowerCase();
      expect(features).not.toContain('multi-child');
      expect(features).not.toContain('co-parent');
    }
  });
});

describe('formatPlanPrice', () => {
  it('shows Free for the free tier in both periods', () => {
    expect(formatPlanPrice('free', 'monthly')).toBe('Free');
    expect(formatPlanPrice('free', 'annual')).toBe('Free');
  });

  it('shows per-month vs per-year for paid tiers, in explicit CAD', () => {
    expect(formatPlanPrice('plus', 'monthly')).toBe('$9 CAD/mo');
    expect(formatPlanPrice('plus', 'annual')).toBe('$79 CAD/yr');
    expect(formatPlanPrice('family', 'monthly')).toBe('$19 CAD/mo');
    expect(formatPlanPrice('family', 'annual')).toBe('$159 CAD/yr');
  });

  it('every tier formats in every period without throwing', () => {
    const tiers: PlanTier[] = ['free', 'plus', 'family'];
    for (const tier of tiers) {
      for (const period of ['monthly', 'annual'] as const) {
        expect(typeof formatPlanPrice(tier, period)).toBe('string');
      }
    }
  });
});
