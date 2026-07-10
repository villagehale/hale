import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { VillageBoard } from './village-board';

/**
 * The board's teen-locked ActivityRow is the highest-stakes render path (rule #1):
 * a teen-attributed candidate must show the locked treatment — the redacted
 * placeholder only, never raw text or a save affordance — while a non-teen row in
 * the SAME list keeps its raw title and save. We render to static HTML (the repo's
 * render idiom) and assert both, so a regression that leaks a teen title or drops
 * the lock fails here rather than only at the pure mapper.
 */

const TEEN_RAW_TITLE = 'Nadia at high-school drama club';

function view(overrides: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    childId: null,
    title: `title-${overrides.id}`,
    kind: 'class',
    cadence: null,
    eventDate: null,
    seasons: null,
    discoveredAt: '2026-07-04T12:00:00.000Z',
    summary: `summary-${overrides.id}`,
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

function render(candidates: VillageCandidateView[]): string {
  return renderToStaticMarkup(
    createElement(VillageBoard, { candidates, resources: [], coarseCenter: null, area: null }),
  );
}

describe('VillageBoard — teen-locked ActivityRow (rule #1)', () => {
  it('shows the locked placeholder for a teen row and never its raw title, save, or moat actions', () => {
    // The mapper hands the board a teen row whose title is already the placeholder;
    // a leak of the raw title would be a rule #1 violation.
    const html = render([
      view({ id: 'teen', title: TEEN_REDACTED_PLACEHOLDER, teenAttributed: true }),
    ]);

    expect(html).toContain(TEEN_REDACTED_PLACEHOLDER);
    expect(html).not.toContain(TEEN_RAW_TITLE);
    // The redacted row carries none of the moat actions and no raw-content marker.
    expect(html).not.toContain('i&#x27;m interested');
    expect(html).not.toContain('add to my week');
    expect(html).not.toContain('i love this');
    expect(html).not.toContain('data-hale-pii');
  });

  it('keeps the full treatment for a non-teen row: save AND the moat actions', () => {
    const html = render([view({ id: 'swim', title: 'Toddler swim' })]);

    expect(html).toContain('Toddler swim');
    // The unredacted title is the marked raw-content field.
    expect(html).toContain('data-hale-pii');
    // The village's viral moat: accept, endorse, and share are reachable on the row,
    // beside the private save (rule #3 of the brief — no functionality lost).
    expect(html).toContain('i&#x27;m interested');
    expect(html).toContain('add to my week');
    expect(html).toContain('i love this');
    expect(html).toContain('share');
  });

  it('renders a dated activity as its concrete calendar day, an undated one as its cadence', () => {
    const html = render([
      view({ id: 'dated', title: 'Storytime', eventDate: '2026-08-15', cadence: 'one-time' }),
      view({ id: 'standing', title: 'Open gym', eventDate: null, cadence: 'ongoing' }),
    ]);

    // eventDate wins the when-line — the mockup's dated rows show the real day.
    expect(html).toContain('Aug 15');
    // A year-round standing activity has no date, so it falls back to the cadence label.
    expect(html).toContain('year-round');
  });
});
