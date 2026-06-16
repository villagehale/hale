import type { DiscoveryQuery } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { FakeDiscoveryProvider } from './fake.js';

const provider = new FakeDiscoveryProvider();

function query(overrides: Partial<DiscoveryQuery> = {}): DiscoveryQuery {
  return { areaCoarse: 'M5V', stage: 'toddler', interests: [], limit: 8, ...overrides };
}

describe('FakeDiscoveryProvider', () => {
  it('returns only seeds whose stage matches the query', async () => {
    const newbornResults = await provider.discover(query({ stage: 'newborn' }));
    const teenResults = await provider.discover(query({ stage: 'teenager' }));

    expect(newbornResults.length).toBeGreaterThan(0);
    expect(newbornResults.every((c) => c.stage === 'newborn')).toBe(true);
    // The newborn floor and teen floor must not overlap by title.
    const newbornTitles = new Set(newbornResults.map((c) => c.title));
    expect(teenResults.some((c) => newbornTitles.has(c.title))).toBe(false);
  });

  it('keeps only seeds matching a stated interest, but does not over-filter', async () => {
    const swimming = await provider.discover(query({ stage: 'toddler', interests: ['swimming'] }));

    expect(swimming.some((c) => c.title === 'Parent-and-tot swim')).toBe(true);
    // A music-only toddler seed must drop out when only "swimming" is asked for.
    expect(swimming.some((c) => c.title === 'Toddler music-and-movement class')).toBe(false);
  });

  it('keeps interest-agnostic stage-typical seeds even when an interest is set', async () => {
    // The park has no interest tag overlap with "books" but is a stage-typical
    // fallback (empty-interest seeds are universally eligible).
    const results = await provider.discover(query({ stage: 'child', interests: ['books'] }));
    expect(results.some((c) => c.title === 'Library after-school reading club')).toBe(true);
  });

  it('ranks an interest hit above an interest-agnostic stage-typical seed', async () => {
    // For newborns, the music-tagged storytime is a hit while the untagged
    // drop-in is only a stage-typical survivor — the hit must sort first.
    const results = await provider.discover(query({ stage: 'newborn', interests: ['music'] }));
    const hitIdx = results.findIndex((c) => c.title === 'Public library baby storytime');
    const genericIdx = results.findIndex((c) => c.title === 'Parent-and-baby drop-in group');

    expect(hitIdx).toBeGreaterThanOrEqual(0);
    expect(genericIdx).toBeGreaterThanOrEqual(0);
    expect(hitIdx).toBeLessThan(genericIdx);
  });

  it('honors the limit', async () => {
    const results = await provider.discover(query({ stage: 'toddler', interests: [], limit: 1 }));
    expect(results).toHaveLength(1);
  });

  it('tags every candidate as the curated floor with an honest, sub-certain confidence', async () => {
    const results = await provider.discover(query({ stage: 'newborn' }));
    expect(results.every((c) => c.source === 'curated_seed')).toBe(true);
    // The floor is honest: a curated guess is never asserted with certainty.
    expect(results.every((c) => c.confidence > 0 && c.confidence < 1)).toBe(true);
    expect(results.every((c) => c.coverageNote.length > 0)).toBe(true);
  });

  it('echoes the coarse area unchanged and emits no finer location (rule #1)', async () => {
    const results = await provider.discover(query({ areaCoarse: 'Plateau', stage: 'child' }));
    expect(results.every((c) => c.areaCoarse === 'Plateau')).toBe(true);
    // No candidate carries a sourceUrl or any precise-location field — the floor
    // names activity types, never a child-pinpointing venue.
    expect(results.every((c) => c.sourceUrl === undefined)).toBe(true);
  });
});
