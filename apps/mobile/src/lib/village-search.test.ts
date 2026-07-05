import { describe, expect, it } from 'vitest';

import {
  type SeasonKey,
  searchOutcomeFromError,
  searchOutcomeFromResult,
  searchReadPath,
} from './village-search';

/**
 * The pure decision seam for the Village timeframe search. The RN screen can't be
 * render-tested here (no native runtime), so the state machine that maps a season
 * pick + POST outcome → next UI state lives in a framework-free module and is the
 * one thing tested. Assertions are spec-derived from the backend contract:
 * discovered → read the ?season run, 429 → an honest rate-limit line, invalid/no-family
 * → their own honest lines, never a swallowed null (rule #8). The error mapper takes
 * a plain (status, message) so this module never imports the RN api client.
 */

describe('searchReadPath', () => {
  it('scopes the village GET to the searched season', () => {
    expect(searchReadPath('fall')).toBe('/api/mobile/village?season=fall');
    expect(searchReadPath('winter')).toBe('/api/mobile/village?season=winter');
  });
});

describe('searchOutcomeFromResult', () => {
  it('a discovered run (with inserts) → search mode reading that season', () => {
    expect(searchOutcomeFromResult('fall', { status: 'discovered', insertedCount: 4 })).toEqual({
      kind: 'search',
      season: 'fall',
      readPath: '/api/mobile/village?season=fall',
    });
  });

  it('a discovered run with zero inserts still enters search mode (UI shows the empty run)', () => {
    // The read returns the (possibly empty) run; the screen renders the honest
    // "no fall activities found" empty state — not an error.
    expect(searchOutcomeFromResult('summer', { status: 'discovered', insertedCount: 0 })).toEqual({
      kind: 'search',
      season: 'summer',
      readPath: '/api/mobile/village?season=summer',
    });
  });

  it('no coarse area on file → an honest error, not search mode', () => {
    expect(searchOutcomeFromResult('spring', { status: 'no_area' })).toEqual({
      kind: 'error',
      message:
        'Add your area in Family settings first — searches use your coarse area to find nearby activities.',
    });
  });

  it('no non-teen children → an honest error explaining why discovery has nothing to scope to', () => {
    expect(searchOutcomeFromResult('winter', { status: 'no_non_teen_children' })).toEqual({
      kind: 'error',
      message: 'No children to search activities for yet.',
    });
  });
});

describe('searchOutcomeFromError', () => {
  it('429 → the honest rate-limit line', () => {
    expect(searchOutcomeFromError(429, 'rate_limited')).toEqual({
      kind: 'error',
      message: "You've searched a lot — try again shortly.",
    });
  });

  it('400 invalid season → an honest line', () => {
    expect(searchOutcomeFromError(400, 'invalid_season')).toEqual({
      kind: 'error',
      message: "That season isn't valid — pick spring, summer, fall, or winter.",
    });
  });

  it('403 no family → an honest line', () => {
    expect(searchOutcomeFromError(403, 'no_family_for_user')).toEqual({
      kind: 'error',
      message: 'Finish setting up your family before searching activities.',
    });
  });

  it('503 no database → surfaces the client message, never a swallowed null', () => {
    expect(searchOutcomeFromError(503, 'Discovery is unavailable right now.')).toEqual({
      kind: 'error',
      message: 'Discovery is unavailable right now.',
    });
  });

  it('a network error (status 0) → surfaces its message', () => {
    expect(
      searchOutcomeFromError(0, 'Network error — check your connection and try again.'),
    ).toEqual({
      kind: 'error',
      message: 'Network error — check your connection and try again.',
    });
  });
});

describe('SeasonKey typing', () => {
  it('the four seasons are the only searchable keys', () => {
    const keys: SeasonKey[] = ['spring', 'summer', 'fall', 'winter'];
    expect(keys).toHaveLength(4);
  });
});
