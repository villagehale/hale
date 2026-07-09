import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { VillageRail } from './village-rail';

/**
 * The board's right rail — Upcoming / Saved / From Hale. Each card is server-rendered
 * from real data with an HONEST empty state (rule #8) and never fabricates a value.
 * These render to static HTML (the repo's render idiom, no jsdom).
 */

function view(overrides: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    childId: null,
    title: `title-${overrides.id}`,
    kind: 'community_event',
    cadence: 'one-time',
    eventDate: null,
    seasons: null,
    discoveredAt: '2026-07-04T12:00:00.000Z',
    summary: '',
    coverageNote: null,
    sourceUrl: null,
    acceptHref: `/api/village/${overrides.id}/accept`,
    endorseHref: `/api/village/${overrides.id}/endorse`,
    saveHref: `/api/village/${overrides.id}/save`,
    shareHref: `/api/village/${overrides.id}/share`,
    endorsementCount: 0,
    endorsedByFamily: false,
    saved: false,
    accepted: false,
    lat: null,
    lng: null,
    venueName: null,
    rating: null,
    ratingCount: null,
    priceLevel: null,
    ageRange: null,
    indoorOutdoor: null,
    teenAttributed: false,
    ...overrides,
  };
}

function render(candidates: VillageCandidateView[], saved: VillageCandidateView[]): string {
  return renderToStaticMarkup(createElement(VillageRail, { candidates, saved }));
}

describe('VillageRail — Upcoming', () => {
  it('lists dated events soonest-first with their date', () => {
    const html = render(
      [
        view({ id: 'sep', title: 'Fall fair', eventDate: '2026-09-12' }),
        view({ id: 'jul', title: 'Summer splash', eventDate: '2026-07-20' }),
      ],
      [],
    );
    // Both dated titles appear, and the soonest (Jul) is ordered before Sep.
    const jul = html.indexOf('Summer splash');
    const sep = html.indexOf('Fall fair');
    expect(jul).toBeGreaterThan(-1);
    expect(sep).toBeGreaterThan(-1);
    expect(jul).toBeLessThan(sep);
    // The date is formatted (calendar date, UTC round-trip) — Jul 20 / Sep 12.
    expect(html).toContain('Jul 20');
    expect(html).toContain('Sep 12');
  });

  it('shows an honest empty state when no candidate carries a date', () => {
    const html = render([view({ id: 'undated' })], []);
    expect(html).toContain('no dated events yet');
  });
});

describe('VillageRail — Saved', () => {
  it('shows a compact preview and a view-all link into /saved', () => {
    const html = render([view({ id: 'a' })], [view({ id: 's1', title: 'Saved swim' })]);
    expect(html).toContain('Saved swim');
    expect(html).toContain('href="/saved"');
    expect(html).toContain('view all 1 saved');
  });

  it('shows an honest empty state when nothing is saved', () => {
    const html = render([view({ id: 'a' })], []);
    expect(html).toContain('nothing saved yet');
    expect(html).not.toContain('view all');
  });
});

describe('VillageRail — From Hale', () => {
  it("surfaces feed.candidates[0] as Hale's pick and an ask-your-concierge link to /coach", () => {
    const html = render(
      [view({ id: 'top', title: 'Top ranked pick' }), view({ id: 'second' })],
      [],
    );
    expect(html).toContain('Hale’s pick near you');
    // The genuine #1 (first in ranked order) is surfaced, not the second.
    expect(html).toContain('Top ranked pick');
    expect(html).toContain('href="/coach"');
    expect(html).toContain('ask your concierge');
  });

  it('never surfaces a teen-redacted #1 pick as content (rule #1), still offers the concierge', () => {
    const html = render(
      [view({ id: 'teen', title: TEEN_REDACTED_PLACEHOLDER, teenAttributed: true })],
      [],
    );
    // The redacted placeholder is NOT rendered as a pick; the honest fallback shows.
    expect(html).not.toContain('Hale’s pick near you');
    expect(html).not.toContain(TEEN_REDACTED_PLACEHOLDER);
    expect(html).toContain('hasn’t ranked a pick for you yet');
    expect(html).toContain('href="/coach"');
  });
});
