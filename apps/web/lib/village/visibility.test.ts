import { describe, expect, it } from 'vitest';
import type { VillageCandidate } from './mappers.js';
import {
  RUN_FRESH_DAYS,
  isVisibleNow,
  orderByDate,
  seasonOf,
  visibleCandidates,
  visibleSearchCandidates,
} from './visibility.js';

/**
 * The visibility rules are the feed's honesty contract: a family should never see
 * a class that already happened, a summer camp in January, or a three-week-old run
 * masquerading as this week. These are pure over a row + a fixed `now`, so every
 * case is a deterministic date fixture — no clock, no DB.
 */

function candidate(overrides: Partial<VillageCandidate> = {}): VillageCandidate {
  return {
    id: 'cand-1',
    familyId: 'fam-1',
    childId: null,
    title: 'EarlyON drop-in',
    kind: 'drop_in',
    cadence: 'ongoing',
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
    runType: 'standing',
    searchSeason: null,
    supersededAt: null,
    discoveredAt: new Date('2026-07-04T12:00:00Z'),
    ...overrides,
  };
}

describe('seasonOf (Canada, wall-clock month)', () => {
  // One in-month probe per season boundary — derived from the spec's month bands
  // (spring Mar–May, summer Jun–Aug, fall Sep–Nov, winter Dec–Feb), not copied
  // from the implementation.
  it.each([
    ['2026-03-01', 'spring'],
    ['2026-05-31', 'spring'],
    ['2026-06-01', 'summer'],
    ['2026-08-31', 'summer'],
    ['2026-09-01', 'fall'],
    ['2026-11-30', 'fall'],
    ['2026-12-01', 'winter'],
    ['2026-12-31', 'winter'],
    ['2027-01-15', 'winter'],
    ['2027-02-28', 'winter'],
  ])('%s → %s', (iso, expected) => {
    expect(seasonOf(new Date(`${iso}T12:00:00Z`))).toBe(expected);
  });
});

describe('isVisibleNow', () => {
  // A fixed "now": a summer weekday. Season = summer.
  const NOW = new Date('2026-07-04T12:00:00Z');
  const WINTER = new Date('2027-01-15T12:00:00Z');

  it('hides a superseded row regardless of everything else', () => {
    const supersededButOtherwiseVisible = candidate({
      cadence: 'ongoing',
      supersededAt: new Date('2026-07-03T12:00:00Z'),
      discoveredAt: NOW,
    });
    expect(isVisibleNow(supersededButOtherwiseVisible, NOW)).toBe(false);
  });

  it('expires the whole run when discoveredAt is older than the freshness window', () => {
    const staleOngoing = candidate({
      cadence: 'ongoing',
      discoveredAt: new Date('2026-06-14T12:00:00Z'), // 20 days before NOW
    });
    expect(isVisibleNow(staleOngoing, NOW)).toBe(false);

    // The boundary: exactly RUN_FRESH_DAYS old is still fresh; one day past is not.
    const atEdge = candidate({
      discoveredAt: new Date(NOW.getTime() - RUN_FRESH_DAYS * 24 * 60 * 60 * 1000),
    });
    expect(isVisibleNow(atEdge, NOW)).toBe(true);
    const pastEdge = candidate({
      discoveredAt: new Date(NOW.getTime() - (RUN_FRESH_DAYS + 1) * 24 * 60 * 60 * 1000),
    });
    expect(isVisibleNow(pastEdge, NOW)).toBe(false);
  });

  describe('one-time', () => {
    it('shows a future dated event', () => {
      const future = candidate({ cadence: 'one-time', eventDate: '2026-07-20' });
      expect(isVisibleNow(future, NOW)).toBe(true);
    });

    it('shows an event dated today (drop only the day AFTER)', () => {
      const today = candidate({ cadence: 'one-time', eventDate: '2026-07-04' });
      expect(isVisibleNow(today, NOW)).toBe(true);
    });

    it('drops a past dated event', () => {
      const past = candidate({ cadence: 'one-time', eventDate: '2026-07-03' });
      expect(isVisibleNow(past, NOW)).toBe(false);
    });

    it('falls back to visible-while-fresh when a one-time carries no date', () => {
      const undated = candidate({ cadence: 'one-time', eventDate: null });
      expect(isVisibleNow(undated, NOW)).toBe(true);
    });
  });

  describe('seasonal', () => {
    it('shows a summer swim class in July and hides it in January', () => {
      const swim = candidate({ cadence: 'seasonal', seasons: ['summer'] });
      expect(isVisibleNow(swim, NOW)).toBe(true);
      // Same row, resurfaces next summer: hidden in winter (a January visit sees
      // a stale-but-fresh run — keep discoveredAt inside the window).
      const swimSameRunWinter = candidate({
        cadence: 'seasonal',
        seasons: ['summer'],
        discoveredAt: new Date('2027-01-10T12:00:00Z'),
      });
      expect(isVisibleNow(swimSameRunWinter, WINTER)).toBe(false);
    });

    it('shows a multi-season row when now matches any listed season', () => {
      const springSummer = candidate({ cadence: 'seasonal', seasons: ['spring', 'summer'] });
      expect(isVisibleNow(springSummer, NOW)).toBe(true);
    });

    it('falls back to visible-while-fresh when a seasonal row lists no seasons', () => {
      const noSeasons = candidate({ cadence: 'seasonal', seasons: null });
      expect(isVisibleNow(noSeasons, NOW)).toBe(true);
    });

    it('season-gates a row the model gave seasons but LEFT cadence null (derived seasonal)', () => {
      // Its effective cadence is seasonal, so it is gated to its season like any
      // seasonal row — matching the "seasonal" chip/filter the mapper now derives.
      // Before the fix a null-cadence row fell through as unclassified and leaked
      // year-round even though it named a season.
      const summerButUnclassified = candidate({ cadence: null, seasons: ['summer'] });
      expect(isVisibleNow(summerButUnclassified, NOW)).toBe(true); // July = summer
      const sameRunWinter = candidate({
        cadence: null,
        seasons: ['summer'],
        discoveredAt: new Date('2027-01-10T12:00:00Z'),
      });
      expect(isVisibleNow(sameRunWinter, WINTER)).toBe(false); // hidden out of season
    });
  });

  describe('ongoing / unclassified', () => {
    it('keeps an ongoing (EarlyON-style) row visible while fresh', () => {
      const ongoing = candidate({ cadence: 'ongoing' });
      expect(isVisibleNow(ongoing, NOW)).toBe(true);
    });

    it('keeps an unclassified (null cadence) row visible while fresh', () => {
      const unclassified = candidate({ cadence: null });
      expect(isVisibleNow(unclassified, NOW)).toBe(true);
    });

    it('drops a past dated ongoing row even though cadence is not one-time', () => {
      // A dated ongoing series whose date has passed is still past — the event_date
      // gate is cadence-independent so a mislabelled row can't leak a past date.
      const datedOngoingPast = candidate({ cadence: 'ongoing', eventDate: '2026-07-01' });
      expect(isVisibleNow(datedOngoingPast, NOW)).toBe(false);
    });
  });
});

describe('visibleCandidates', () => {
  const NOW = new Date('2026-07-04T12:00:00Z');

  it('drops past/out-of-season/expired rows and keeps the rest in order', () => {
    const pastEvent = candidate({ id: 'past', cadence: 'one-time', eventDate: '2026-07-03' });
    const winterCamp = candidate({ id: 'winter', cadence: 'seasonal', seasons: ['winter'] });
    const stale = candidate({ id: 'stale', discoveredAt: new Date('2026-06-10T12:00:00Z') });
    const ongoing = candidate({ id: 'ongoing' });
    const summerSwim = candidate({ id: 'swim', cadence: 'seasonal', seasons: ['summer'] });

    const kept = visibleCandidates([pastEvent, winterCamp, stale, ongoing, summerSwim], NOW);
    expect(kept.map((c) => c.id)).toEqual(['ongoing', 'swim']);
  });
});

describe('visibleSearchCandidates (season gate skipped)', () => {
  // A parent searches "fall activities" in the SUMMER. The results are already
  // season-targeted by discovery, so the seasonOf(now) gate must NOT hide them —
  // otherwise a fall search viewed in July would render empty. The freshness,
  // superseded, and past-dated-event gates still apply.
  const SUMMER = new Date('2026-07-04T12:00:00Z');

  it('SHOWS a fall-tagged seasonal row even though now is summer', () => {
    const fallPick = candidate({ cadence: 'seasonal', seasons: ['fall'] });
    // The standing gate would hide it (fall != summer)…
    expect(isVisibleNow(fallPick, SUMMER)).toBe(false);
    // …but the search gate keeps it.
    expect(visibleSearchCandidates([fallPick], SUMMER).map((c) => c.id)).toEqual(['cand-1']);
  });

  it('still drops a superseded row', () => {
    const superseded = candidate({
      cadence: 'seasonal',
      seasons: ['fall'],
      supersededAt: new Date('2026-07-03T12:00:00Z'),
    });
    expect(visibleSearchCandidates([superseded], SUMMER)).toEqual([]);
  });

  it('still drops a stale (expired) run', () => {
    const stale = candidate({
      cadence: 'seasonal',
      seasons: ['fall'],
      discoveredAt: new Date('2026-06-10T12:00:00Z'), // >14d before SUMMER
    });
    expect(visibleSearchCandidates([stale], SUMMER)).toEqual([]);
  });

  it('still drops a past dated event', () => {
    const past = candidate({ cadence: 'one-time', eventDate: '2026-07-03', seasons: null });
    expect(visibleSearchCandidates([past], SUMMER)).toEqual([]);
  });

  it('leaves the STANDING path season-gated (unchanged): a fall row is hidden in summer', () => {
    const fallPick = candidate({ cadence: 'seasonal', seasons: ['fall'] });
    expect(visibleCandidates([fallPick], SUMMER)).toEqual([]);
  });
});

describe('orderByDate', () => {
  it('floats dated picks to the front soonest-first, undated keep their order', () => {
    const rows = [
      { id: 'ongoing-a', eventDate: null },
      { id: 'jul20', eventDate: '2026-07-20' },
      { id: 'ongoing-b', eventDate: null },
      { id: 'jul06', eventDate: '2026-07-06' },
    ];
    expect(orderByDate(rows).map((r) => r.id)).toEqual([
      'jul06',
      'jul20',
      'ongoing-a',
      'ongoing-b',
    ]);
  });
});
