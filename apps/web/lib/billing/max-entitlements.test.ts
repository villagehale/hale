import { MAX_ENTITLEMENTS, PLUS_ENTITLEMENTS, TODAY_ENTITLEMENTS } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { entitlementsForFamily, maxEntitlementsEnabled } from './max-entitlements';

describe('maxEntitlementsEnabled', () => {
  it('is off unless the value is exactly true', () => {
    expect(maxEntitlementsEnabled({})).toBe(false);
    expect(maxEntitlementsEnabled({ MAX_ENTITLEMENTS_ENABLED: 'true\n' })).toBe(false);
    expect(maxEntitlementsEnabled({ MAX_ENTITLEMENTS_ENABLED: 'TRUE' })).toBe(false);
    expect(maxEntitlementsEnabled({ MAX_ENTITLEMENTS_ENABLED: 'on' })).toBe(false);
    expect(maxEntitlementsEnabled({ MAX_ENTITLEMENTS_ENABLED: '1' })).toBe(false);
    expect(maxEntitlementsEnabled({ MAX_ENTITLEMENTS_ENABLED: 'true' })).toBe(true);
  });

  it('ignores PostHog: unset env stays off even when POSTHOG_FLAGS_ENABLED is on', () => {
    expect(
      maxEntitlementsEnabled({
        POSTHOG_FLAGS_ENABLED: 'true',
        MAX_ENTITLEMENTS_ENABLED: undefined,
      }),
    ).toBe(false);
    expect(
      maxEntitlementsEnabled({
        POSTHOG_FLAGS_ENABLED: 'true',
        MAX_ENTITLEMENTS_ENABLED: 'TRUE',
      }),
    ).toBe(false);
  });

  it('stays on from exact env true even when POSTHOG_FLAGS_ENABLED is on', () => {
    expect(
      maxEntitlementsEnabled({
        POSTHOG_FLAGS_ENABLED: 'true',
        MAX_ENTITLEMENTS_ENABLED: 'true',
      }),
    ).toBe(true);
  });
});

describe('entitlementsForFamily', () => {
  const off = { MAX_ENTITLEMENTS_ENABLED: undefined };
  const on = { MAX_ENTITLEMENTS_ENABLED: 'true' };

  it('returns today for every tier while the flag is off', () => {
    expect(entitlementsForFamily('free', off)).toEqual(TODAY_ENTITLEMENTS);
    expect(entitlementsForFamily('plus', off)).toEqual(TODAY_ENTITLEMENTS);
    expect(entitlementsForFamily('family', off)).toEqual(TODAY_ENTITLEMENTS);
  });

  it('returns Plus for Free and Plus, Max for family, while the flag is on', () => {
    expect(entitlementsForFamily('free', on)).toEqual(PLUS_ENTITLEMENTS);
    expect(entitlementsForFamily('plus', on)).toEqual(PLUS_ENTITLEMENTS);
    expect(entitlementsForFamily('family', on)).toEqual(MAX_ENTITLEMENTS);
  });
});
