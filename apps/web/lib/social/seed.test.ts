import { describe, expect, it } from 'vitest';
import { GTA_REGIONS } from './regions';
import { SOCIAL_SEED, SOCIAL_SEED_TOS_RISK } from './seed';

const REQUIRED = ['acton_georgetownearlyon', 'downeysfarm'] as const;
const NEEDED_CATEGORIES = ['T1', 'T2', 'T3', 'T5', 'T6', 'T10', 'T11'] as const;

describe('SOCIAL_SEED', () => {
  const active = SOCIAL_SEED.filter((row) => row.active);

  it('covers the full GTA, with at least 20 active sources in each region and most of them outside Toronto', () => {
    expect(SOCIAL_SEED.length).toBeGreaterThanOrEqual(150);
    expect(SOCIAL_SEED.length).toBeLessThanOrEqual(200);
    expect(active.length).toBeGreaterThanOrEqual(100);
    for (const region of ['toronto', 'peel', 'york', 'halton', 'durham'] as const) {
      const count = active.filter((row) => row.region === region).length;
      expect(count, region).toBeGreaterThanOrEqual(20);
    }
    const outside = active.filter((row) => row.region !== 'toronto').length;
    expect(outside / active.length).toBeGreaterThanOrEqual(0.3);
    const outsideAll = SOCIAL_SEED.filter((row) => row.region !== 'toronto').length;
    expect(outsideAll / SOCIAL_SEED.length).toBeGreaterThanOrEqual(0.3);
    expect(active.some((row) => row.region === 'day_trip')).toBe(true);
    expect(new Set(active.map((row) => row.category)).size).toBeGreaterThanOrEqual(6);
    for (const category of NEEDED_CATEGORIES) {
      expect(
        active.some((row) => row.category === category),
        category,
      ).toBe(true);
    }
  });

  it('keeps the two brief examples active on instagram and never labels a row as a tos violation', () => {
    for (const handle of REQUIRED) {
      const row = SOCIAL_SEED.find(
        (item) => item.platform === 'instagram' && item.handle === handle,
      );
      expect(row?.active, handle).toBe(true);
    }
    expect(SOCIAL_SEED.every((row) => row.note.length > 0)).toBe(true);
    expect(SOCIAL_SEED_TOS_RISK).toBe('official');
    const pairs = SOCIAL_SEED.map((row) => `${row.platform}:${row.handle}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const row of SOCIAL_SEED) {
      expect(row.handle).toBe(row.handle.toLowerCase());
      expect(row.handle.startsWith('@')).toBe(false);
      expect(GTA_REGIONS).toContain(row.region);
    }
  });
});
