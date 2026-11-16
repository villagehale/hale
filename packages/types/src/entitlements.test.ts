import { describe, expect, it } from 'vitest';
import {
  MAX_ENTITLEMENTS,
  PLUS_ENTITLEMENTS,
  type PlanTier,
  TODAY_ENTITLEMENTS,
  compareOpsPriority,
  entitlementsFor,
} from './entitlements.js';

const TIERS: PlanTier[] = ['free', 'plus', 'family'];

describe('entitlementsFor — flag off (today)', () => {
  it.each(TIERS)('gives %s the same limits as today', (tier) => {
    expect(entitlementsFor(tier, false)).toEqual(TODAY_ENTITLEMENTS);
  });

  it('does not cap live watches', () => {
    expect(TODAY_ENTITLEMENTS.liveWatches).toBeNull();
  });

  it('does not gate Browser Use by plan', () => {
    expect(TODAY_ENTITLEMENTS.signupHelp).toBe(true);
  });

  it('does not mark anyone for priority support', () => {
    expect(TODAY_ENTITLEMENTS.prioritySupport).toBe(false);
  });

  it('keeps the activity search budgets Hale already ships', () => {
    expect(TODAY_ENTITLEMENTS.activitySearchesPerCall).toBe(3);
    expect(TODAY_ENTITLEMENTS.activityCallsPerTurn).toBe(2);
  });
});

describe('entitlementsFor — flag on', () => {
  it('gives Free the Plus table, not Max', () => {
    expect(entitlementsFor('free', true)).toEqual(PLUS_ENTITLEMENTS);
  });

  it('gives Plus the Plus table', () => {
    expect(entitlementsFor('plus', true)).toEqual(PLUS_ENTITLEMENTS);
  });

  it('gives Max (`family`) the Max table', () => {
    expect(entitlementsFor('family', true)).toEqual(MAX_ENTITLEMENTS);
  });

  it('gives Max more search budget than Plus, short of unlimited', () => {
    expect(MAX_ENTITLEMENTS.activitySearchesPerCall).toBeGreaterThan(
      PLUS_ENTITLEMENTS.activitySearchesPerCall,
    );
    expect(MAX_ENTITLEMENTS.activitySearchesPerCall).toBeLessThanOrEqual(10);
    expect(MAX_ENTITLEMENTS.activityCallsPerTurn).toBeGreaterThan(
      PLUS_ENTITLEMENTS.activityCallsPerTurn,
    );
    expect(MAX_ENTITLEMENTS.activityCallsPerTurn).toBeLessThanOrEqual(6);
  });

  it('caps live watches on both paid tiers, Max higher than Plus', () => {
    expect(PLUS_ENTITLEMENTS.liveWatches).toBe(8);
    expect(MAX_ENTITLEMENTS.liveWatches).toBe(20);
  });

  it('gives Browser Use signup help only to Max', () => {
    expect(PLUS_ENTITLEMENTS.signupHelp).toBe(false);
    expect(MAX_ENTITLEMENTS.signupHelp).toBe(true);
  });

  it('gives priority support only to Max', () => {
    expect(PLUS_ENTITLEMENTS.prioritySupport).toBe(false);
    expect(MAX_ENTITLEMENTS.prioritySupport).toBe(true);
  });
});

describe('compareOpsPriority', () => {
  it('lists a Max item before a Plus item even when the Plus item is older', () => {
    const plusOlder = { prioritySupport: false, atMs: 1 };
    const maxNewer = { prioritySupport: true, atMs: 9 };
    expect(compareOpsPriority(maxNewer, plusOlder)).toBeLessThan(0);
    expect(compareOpsPriority(plusOlder, maxNewer)).toBeGreaterThan(0);
  });

  it('keeps older-first inside the same priority band', () => {
    const first = { prioritySupport: true, atMs: 1 };
    const second = { prioritySupport: true, atMs: 2 };
    expect(compareOpsPriority(first, second)).toBeLessThan(0);
    expect(
      [
        { prioritySupport: false, atMs: 5 },
        { prioritySupport: true, atMs: 4 },
        { prioritySupport: false, atMs: 1 },
        { prioritySupport: true, atMs: 2 },
      ].sort(compareOpsPriority),
    ).toEqual([
      { prioritySupport: true, atMs: 2 },
      { prioritySupport: true, atMs: 4 },
      { prioritySupport: false, atMs: 1 },
      { prioritySupport: false, atMs: 5 },
    ]);
  });
});
