import { describe, expect, it } from 'vitest';
import { resolveSearchView } from './ai-search-view';
import type { VillageCandidateView } from './mappers';

const view = (id: string) => ({ id, title: id } as VillageCandidateView);

describe('resolveSearchView — the state→surface decision', () => {
  it('shows real results, carrying the interpretation and degraded flag', () => {
    const out = resolveSearchView({
      status: 'ok',
      interpretation: 'swim · starting winter',
      results: [view('a')],
      degraded: false,
      discoveryKicked: false,
    });
    expect(out).toEqual({
      kind: 'results',
      interpretation: 'swim · starting winter',
      results: [view('a')],
      degraded: false,
      stillLooking: false,
    });
  });

  it('flags "still looking" on a rich result when discovery was also kicked', () => {
    const out = resolveSearchView({
      status: 'ok',
      interpretation: 'x',
      results: [view('a'), view('b')],
      degraded: true,
      discoveryKicked: true,
    });
    expect(out.kind).toBe('results');
    if (out.kind === 'results') {
      expect(out.stillLooking).toBe(true);
      expect(out.degraded).toBe(true);
    }
  });

  it('shows an honest empty surface (not results) when nothing matched', () => {
    const out = resolveSearchView({
      status: 'ok',
      interpretation: 'montessori · starting fall',
      results: [],
      degraded: false,
      discoveryKicked: true,
    });
    expect(out).toEqual({
      kind: 'empty',
      interpretation: 'montessori · starting fall',
      degraded: false,
      stillLooking: true,
    });
  });

  it('shows a calm notice for a rate-limited search, never a blank surface (rule #8)', () => {
    const out = resolveSearchView({ status: 'rate_limited', retryAfter: 30 });
    expect(out.kind).toBe('notice');
    if (out.kind === 'notice') expect(out.title).toMatch(/searched a lot/i);
  });

  it('shows a sign-in notice for an unauthenticated / no-family result', () => {
    expect(resolveSearchView({ status: 'unauthenticated' }).kind).toBe('notice');
    expect(resolveSearchView({ status: 'no_family' }).kind).toBe('notice');
  });
});
