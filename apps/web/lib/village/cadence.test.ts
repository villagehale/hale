import { describe, expect, it } from 'vitest';
import type { VillageCandidate } from './mappers.js';
import { effectiveCadence, toVillageCandidateView } from './mappers.js';

/**
 * The discovery model emits `cadence` as an OPTIONAL enum, so an unclassified or
 * pre-cadence row stores null — which stranded it under the "all" filter only (no
 * chip, no specific-cadence match) and was the reported bug: every one-time /
 * seasonal / year-round filter came up empty while "all" showed rows. The mapper
 * now derives a cadence from the same signals the visibility gate reads, so every
 * card is filterable. Expected values here come from the definition of each cadence
 * (a dated event is one-time; a row that named seasons is seasonal; an undated,
 * season-less standing activity is ongoing), not from the code's output.
 */

describe('effectiveCadence', () => {
  it("keeps the model's own classification when it made one", () => {
    expect(effectiveCadence('seasonal', null, ['summer'])).toBe('seasonal');
    expect(effectiveCadence('ongoing', '2026-08-01', null)).toBe('ongoing');
    expect(effectiveCadence('one-time', null, null)).toBe('one-time');
  });

  it('derives one-time for a null-cadence dated event', () => {
    expect(effectiveCadence(null, '2026-08-01', null)).toBe('one-time');
  });

  it('derives seasonal for a null-cadence row that named seasons', () => {
    expect(effectiveCadence(null, null, ['fall', 'winter'])).toBe('seasonal');
  });

  it('derives ongoing for a null-cadence, undated, season-less standing activity', () => {
    expect(effectiveCadence(null, null, null)).toBe('ongoing');
    expect(effectiveCadence(null, null, [])).toBe('ongoing');
  });
});

function candidate(overrides: Partial<VillageCandidate> = {}): VillageCandidate {
  return {
    id: 'cand-1',
    familyId: 'fam-1',
    childId: null,
    title: 'EarlyON drop-in',
    kind: 'drop_in',
    cadence: null,
    summary: 'A warm weekday drop-in for you and your little one.',
    sourceUrl: null,
    source: 'llm_only',
    confidence: 0.8,
    coverageNote: 'serves your area',
    lat: null,
    lng: null,
    venueName: null,
    venueAddress: null,
    shareToken: null,
    eventDate: null,
    seasons: null,
    supersededAt: null,
    discoveredAt: new Date('2026-07-04T12:00:00Z'),
    ...overrides,
  };
}

describe('toVillageCandidateView — cadence derived so every card is filterable', () => {
  it('gives an unclassified undated drop-in an ongoing cadence (was stranded under "all")', () => {
    const view = toVillageCandidateView(candidate({ cadence: null }), false);
    expect(view.cadence).toBe('ongoing');
  });

  it('keeps a teen-redacted card cadence null — no chip (rule #1)', () => {
    const view = toVillageCandidateView(candidate({ cadence: null }), true);
    expect(view.cadence).toBeNull();
  });
});
