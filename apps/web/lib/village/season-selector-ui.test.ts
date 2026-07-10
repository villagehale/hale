import { describe, expect, it } from 'vitest';
import { minutesUntilRetry, searchResultToUi, seasonFromParam } from './season-selector-ui';

/**
 * The two pure decisions behind the season-search UI, tested from the spec (not
 * the code's current output). seasonFromParam maps a URL searchParam to the
 * loadVillage scope: a valid season reads that search run, anything else falls
 * back to the standing feed. searchResultToUi maps a Server-Action result to the
 * client's next move — navigate on a real discovery, an honest message on every
 * non-success (rule #8: never a swallowed null).
 */

describe('seasonFromParam — URL param → loadVillage scope', () => {
  it('maps each valid season string to that season', () => {
    expect(seasonFromParam('spring')).toBe('spring');
    expect(seasonFromParam('summer')).toBe('summer');
    expect(seasonFromParam('fall')).toBe('fall');
    expect(seasonFromParam('winter')).toBe('winter');
  });

  it('falls back to the standing feed (null) for an unknown or absent param', () => {
    expect(seasonFromParam('autumn')).toBeNull();
    expect(seasonFromParam('')).toBeNull();
    expect(seasonFromParam(undefined)).toBeNull();
    expect(seasonFromParam('FALL')).toBeNull();
  });
});

describe('minutesUntilRetry — seconds → whole minutes, rounded up, floor 1', () => {
  it('rounds a partial minute up so the wait is never understated', () => {
    expect(minutesUntilRetry(900)).toBe(15);
    expect(minutesUntilRetry(61)).toBe(2);
  });

  it('reports at least one minute for any positive wait', () => {
    expect(minutesUntilRetry(1)).toBe(1);
    expect(minutesUntilRetry(0)).toBe(1);
  });
});

describe('searchResultToUi — action result → next UI move', () => {
  it('navigates to the season search run on a real discovery (any count)', () => {
    expect(searchResultToUi({ status: 'discovered', insertedCount: 4 }, 'fall')).toEqual({
      kind: 'navigate',
      season: 'fall',
    });
    // Empty discovery still navigates: the RSC renders the honest empty state,
    // so "empty" has a single source of truth (never a second message here).
    expect(searchResultToUi({ status: 'discovered', insertedCount: 0 }, 'winter')).toEqual({
      kind: 'navigate',
      season: 'winter',
    });
  });

  it('shows an honest, throttle-aware message when rate limited', () => {
    const ui = searchResultToUi({ status: 'rate_limited', retryAfter: 900 }, 'fall');
    expect(ui.kind).toBe('message');
    if (ui.kind !== 'message') throw new Error('expected message');
    expect(ui.text).toContain('15 min');
  });

  it('explains a missing area and points at the family members page', () => {
    const ui = searchResultToUi({ status: 'no_area' }, 'fall');
    expect(ui.kind).toBe('message');
    if (ui.kind !== 'message') throw new Error('expected message');
    expect(ui.link).toEqual({ href: '/family/members', label: 'add your area' });
  });

  it('surfaces every other non-success as a real message, never a swallowed null', () => {
    for (const status of [
      'no_non_teen_children',
      'no_family',
      'unauthenticated',
      'invalid_season',
    ] as const) {
      const ui = searchResultToUi({ status }, 'fall');
      expect(ui.kind).toBe('message');
      if (ui.kind !== 'message') throw new Error('expected message');
      expect(ui.text.length).toBeGreaterThan(0);
    }
  });
});
