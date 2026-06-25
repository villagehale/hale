import { describe, expect, it } from 'vitest';
import type { PlanTier } from './entitlements.js';
import {
  PLAN_DISPLAY,
  PLAN_TIERS_ORDERED,
  formatPlanPrice,
} from './plan-display.js';

/**
 * Prices are the confirmed freemium model (USD), asserted against the spec, not
 * copied from runtime: Free $0, Plus $9/mo or $79/yr, Family $19/mo or $159/yr.
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

  it('carries the confirmed monthly + annual prices (USD)', () => {
    expect(PLAN_DISPLAY.free.monthlyPriceUsd).toBe(0);
    expect(PLAN_DISPLAY.free.annualPriceUsd).toBe(0);

    expect(PLAN_DISPLAY.plus.monthlyPriceUsd).toBe(9);
    expect(PLAN_DISPLAY.plus.annualPriceUsd).toBe(79);

    expect(PLAN_DISPLAY.family.monthlyPriceUsd).toBe(19);
    expect(PLAN_DISPLAY.family.annualPriceUsd).toBe(159);
  });

  it('annual is the better value — under twelve months of monthly for paid tiers', () => {
    for (const tier of ['plus', 'family'] as const) {
      const plan = PLAN_DISPLAY[tier];
      expect(plan.annualPriceUsd).toBeLessThan(plan.monthlyPriceUsd * 12);
    }
  });

  it('every tier lists features', () => {
    for (const tier of PLAN_TIERS_ORDERED) {
      expect(PLAN_DISPLAY[tier].features.length).toBeGreaterThan(0);
    }
  });
});

describe('formatPlanPrice', () => {
  it('shows Free for the free tier in both periods', () => {
    expect(formatPlanPrice('free', 'monthly')).toBe('Free');
    expect(formatPlanPrice('free', 'annual')).toBe('Free');
  });

  it('shows per-month vs per-year for paid tiers', () => {
    expect(formatPlanPrice('plus', 'monthly')).toBe('$9/mo');
    expect(formatPlanPrice('plus', 'annual')).toBe('$79/yr');
    expect(formatPlanPrice('family', 'monthly')).toBe('$19/mo');
    expect(formatPlanPrice('family', 'annual')).toBe('$159/yr');
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
