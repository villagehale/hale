import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { buildVillageMapModel } from '~/lib/village/map-model';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { VillageSearch } from './village-search';

/**
 * VillageSearch carries the list↔map toggle over the SAME ranked feed. These tests
 * render to static HTML (the repo's render idiom — no jsdom). We assert the toggle
 * defaults to the agent-ranked LIST and exposes both controls as 44px touch
 * targets (DESIGN.md), and we assert at the pure-model level that a teen-redacted
 * candidate is NEVER plotted on the map — the spatial view never exposes more than
 * the list (rule #1).
 */

function view(overrides: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    title: `title-${overrides.id}`,
    kind: 'class',
    summary: `summary-${overrides.id}`,
    coverageNote: null,
    sourceUrl: null,
    acceptHref: `/api/village/${overrides.id}/accept`,
    endorseHref: `/api/village/${overrides.id}/endorse`,
    shareHref: `/api/village/${overrides.id}/share`,
    endorsementCount: 0,
    endorsedByFamily: false,
    lat: null,
    lng: null,
    venueName: null,
    teenAttributed: false,
    ...overrides,
  };
}

const COARSE_CENTER = { lat: 43.65, lng: -79.38 };

function render(candidates: VillageCandidateView[]): string {
  return renderToStaticMarkup(
    createElement(VillageSearch, { candidates, coarseCenter: COARSE_CENTER }),
  );
}

describe('VillageSearch — list↔map toggle', () => {
  it('offers both list and map views, defaulting to the agent-ranked list', () => {
    const html = render([view({ id: 'a', lat: 43.6, lng: -79.4 })]);

    // Both toggle controls exist within the view-toggle fieldset.
    const fieldset =
      html.match(/<fieldset[^>]*aria-label="view activities as a list or a map"[\s\S]*?<\/fieldset>/)?.[0] ??
      '';
    expect(fieldset).not.toBe('');
    expect(fieldset).toContain('list');
    expect(fieldset).toContain('map');

    // Default view is the list: exactly one toggle option is pressed (the active
    // one) and the active spruce-fill treatment is applied (DESIGN ladder).
    expect(fieldset.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(fieldset.match(/aria-pressed="false"/g)?.length).toBe(1);
    expect(fieldset).toContain('bg-spruce text-on-spruce');
    // The active (pressed) control is the LIST control — its trailing text is
    // "list" (the map control is not pressed).
    const pressed = fieldset.match(/aria-pressed="true"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(pressed).toMatch(/list<\/button>$/);

    // The ranked card content renders by default (the list is the default view).
    expect(html).toContain('title-a');
    expect(html).toContain('summary-a');
  });

  it('makes each toggle control a 44px touch target (DESIGN.md)', () => {
    const html = render([view({ id: 'a' })]);
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('touch-action:manipulation');
  });
});

describe('the map never over-exposes a teen-redacted candidate (rule #1)', () => {
  it('builds no marker for a teen-attributed candidate, only for the public one', () => {
    const model = buildVillageMapModel(
      [
        view({
          id: 'teen',
          title: TEEN_REDACTED_PLACEHOLDER,
          lat: 43.6,
          lng: -79.4,
          teenAttributed: true,
        }),
        view({ id: 'public', title: 'public swim', lat: 43.61, lng: -79.41 }),
      ],
      COARSE_CENTER,
    );

    // Only the public venue gets a pin; the teen card stays list-only.
    expect(model.markers.map((m) => m.id)).toEqual(['public']);
    expect(model.markers.some((m) => m.title === TEEN_REDACTED_PLACEHOLDER)).toBe(false);
  });
});
