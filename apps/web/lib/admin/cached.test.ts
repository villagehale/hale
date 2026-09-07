import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A cache key reused by a second panel is invisible at runtime — Next folds the
 * callback source into its entry, so the two never collide and the name simply
 * stops naming anything. Nothing to observe, so the test reads the wiring.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('./cached.ts', import.meta.url)), 'utf8');
const wiring = [...SOURCE.matchAll(/\bcached\('([^']+)',\s*\(\)\s*=>\s*(\w+)\(/g)].map((m) => ({
  key: m[1],
  loader: m[2],
}));

describe('admin panel cache keys', () => {
  it('reads every cached() call site (positive control)', () => {
    expect(wiring.map((w) => w.key)).toContain('admin-radar');
    expect(wiring.length).toBeGreaterThanOrEqual(14);
  });

  it('gives each panel a key of its own', () => {
    const keys = wiring.map((w) => w.key);
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([]);
  });

  it('caches the watched-spots loader under its own key, not the radar object’s', () => {
    expect(wiring.find((w) => w.loader === 'loadWatchedSpots')?.key).toBe('admin-watched-spots');
  });
});
