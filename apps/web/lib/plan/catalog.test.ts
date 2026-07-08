import { PLAN_DISPLAY, PLAN_TIERS_ORDERED } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { buildPlanCatalog } from './catalog';

/**
 * The Plan catalog must be DERIVED from the @hale/types source of truth, never a
 * hardcoded copy. These assertions read PLAN_DISPLAY directly and require the
 * catalog to match it — so a drift (a feature line edited in the catalog but not in
 * the SoT, or vice versa) fails the test.
 */

describe('buildPlanCatalog', () => {
  it('carries the current tier through', () => {
    expect(buildPlanCatalog('plus').currentTier).toBe('plus');
    expect(buildPlanCatalog('free').currentTier).toBe('free');
  });

  it('lists every tier free-first, with features straight from PLAN_DISPLAY', () => {
    const catalog = buildPlanCatalog('free');
    expect(catalog.tiers.map((t) => t.tier)).toEqual([...PLAN_TIERS_ORDERED]);
    for (const view of catalog.tiers) {
      // The features are the SoT's, verbatim — proving no hardcoded copy.
      expect(view.features).toEqual([...PLAN_DISPLAY[view.tier].features]);
      expect(view.name).toBe(PLAN_DISPLAY[view.tier].name);
    }
  });

  it('formats CAD prices and flags the free tier as the fully-functional default', () => {
    const catalog = buildPlanCatalog('free');
    const free = catalog.tiers.find((t) => t.tier === 'free');
    const plus = catalog.tiers.find((t) => t.tier === 'plus');
    expect(free?.isFree).toBe(true);
    expect(free?.monthlyPrice).toBe('Free');
    expect(plus?.isFree).toBe(false);
    expect(plus?.monthlyPrice).toBe('$9 CAD/mo');
    expect(plus?.annualPrice).toBe('$79 CAD/yr');
  });
});
