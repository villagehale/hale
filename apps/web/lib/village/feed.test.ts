import { describe, expect, it, vi } from 'vitest';
import type { VillageCandidateView } from './mappers';

// feed.ts pulls in next/cache + the auth chain via ~/lib/family; orderCandidates
// itself is pure, so stub those edges (the established idiom — see
// family/children-actions.test.ts) to import the helper without real infra.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('~/auth', () => ({ auth: vi.fn() }));

const { orderCandidates } = await import('./feed');

/**
 * orderCandidates applies the agent's ordered ids to the candidate VIEWS. It is
 * the last integrity gate before render: the agent decides the order, but a card
 * is never dropped and never duplicated — the feed always contains exactly the
 * family's candidates, reordered.
 */

function view(id: string): VillageCandidateView {
  return {
    id,
    title: `t-${id}`,
    kind: 'class',
    summary: '',
    coverageNote: null,
    sourceUrl: null,
    acceptHref: `/api/village/${id}/accept`,
    endorseHref: `/api/village/${id}/endorse`,
    shareHref: `/api/village/${id}/share`,
    endorsementCount: 0,
    endorsedByFamily: false,
    lat: null,
    lng: null,
    venueName: null,
    teenAttributed: false,
  };
}

describe('orderCandidates', () => {
  it('reorders the views to match the agent ordering', () => {
    const candidates = [view('a'), view('b'), view('c')];
    const ordered = orderCandidates(candidates, ['c', 'a', 'b']);
    expect(ordered.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends a candidate the ordering omitted (never drops a real card)', () => {
    const candidates = [view('a'), view('b'), view('c')];
    const ordered = orderCandidates(candidates, ['b']);
    expect(ordered.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('ignores an ordering id that has no matching view', () => {
    const candidates = [view('a'), view('b')];
    const ordered = orderCandidates(candidates, ['ghost', 'b', 'a']);
    expect(ordered.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('returns the discovery order unchanged when the ordering is empty', () => {
    const candidates = [view('a'), view('b')];
    expect(orderCandidates(candidates, []).map((c) => c.id)).toEqual(['a', 'b']);
  });
});
