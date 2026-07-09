import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { VillageFeed, VillageFeedHeader } from './village-feed';

/**
 * The home/primary surface renders the AGENT-RANKED trusted feed. We render the
 * feed to static HTML (so the warm cards, social-proof badges, and action buttons
 * fully expand) and assert: the order the feed receives is the order it renders
 * (the moat — cards arrive ranked, the component preserves that order), social
 * proof rides each card, and a teen-attributed candidate renders locked, with NO
 * action controls and never its raw text (rule #1).
 */

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

function renderFeed(candidates: VillageCandidateView[]): string {
  return renderToStaticMarkup(createElement(VillageFeed, { candidates }));
}

describe('VillageFeed — renders the agent-ranked, social-proof-rich feed', () => {
  it('preserves the ranked order it is given', () => {
    // The feed loader hands cards already ranked (c, a, b). The component must NOT
    // re-sort — it renders them in the order received.
    const html = renderFeed([
      view({ id: 'c', title: 'card-c' }),
      view({ id: 'a', title: 'card-a' }),
      view({ id: 'b', title: 'card-b' }),
    ]);
    const positions = ['card-c', 'card-a', 'card-b'].map((t) => html.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it('rides social proof on a well-endorsed card exactly once (no doubled count)', () => {
    // One social-proof surface per card: the SocialProofBadge. The EndorseButton no
    // longer repeats the aggregate, so "loved by N families near you" renders once —
    // not once as the pill AND again under the heart button.
    const html = renderFeed([view({ id: 'a', title: 'card-a', endorsementCount: 5 })]);
    expect(html.split('loved by 5 families near you')).toHaveLength(2);
  });

  it('shows the save + endorse + share + accept controls on a normal card', () => {
    const html = renderFeed([view({ id: 'a', title: 'card-a' })]);
    expect(html).toContain('i&#x27;m interested'); // SaveButton (mobile parity)
    expect(html).toContain('i love this'); // EndorseButton
    expect(html).toContain('share this pick'); // ShareButton
    expect(html).toContain('add to my week'); // AcceptButton
  });

  it('shows the save control pressed when the family already saved the card', () => {
    // The saved state is server-resolved so it survives the streamed feed remount.
    const html = renderFeed([view({ id: 's', title: 'card-s', saved: true })]);
    expect(html).toContain('>saved<');
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders a cadence chip labelled by value, absent when the cadence is null', () => {
    // Each recognised cadence surfaces its label as a static chip; a null cadence
    // (pre-cadence rows, unclassified candidates) renders none of the labels.
    const seasonal = renderFeed([view({ id: 's', cadence: 'seasonal' })]);
    expect(seasonal).toContain('seasonal');
    expect(seasonal).toContain('pill-apricot');

    const oneTime = renderFeed([view({ id: 'o', cadence: 'one-time' })]);
    expect(oneTime).toContain('one-time');
    expect(oneTime).toContain('pill-sky');

    const ongoing = renderFeed([view({ id: 'g', cadence: 'ongoing' })]);
    expect(ongoing).toContain('ongoing');

    const none = renderFeed([view({ id: 'n', cadence: null })]);
    expect(none).not.toContain('seasonal');
    expect(none).not.toContain('one-time');
    expect(none).not.toContain('>ongoing<');
  });

  it('stamps each card with how fresh the run is ("found …")', () => {
    // The freshness stamp lives on the card's discoveredAt, so the family reads how
    // current the run is. Today's fixture → "found today".
    const today = new Date().toISOString();
    const html = renderFeed([view({ id: 'f', discoveredAt: today })]);
    expect(html).toContain('found today');
  });

  it('renders a teen-attributed card locked — never its raw text or actions (rule #1)', () => {
    const html = renderFeed([
      view({
        id: 'teen',
        // The mapper already redacts a teen card: title is the placeholder, summary
        // empty. The feed renders the locked treatment with NO actions.
        title: TEEN_REDACTED_PLACEHOLDER,
        summary: 'this raw teen summary must never render',
        teenAttributed: true,
      }),
    ]);
    expect(html).toContain(TEEN_REDACTED_PLACEHOLDER);
    expect(html).not.toContain('this raw teen summary must never render');
    // No action controls for a teen card — a parent can't act on content they
    // can't preview (save included: never save content a parent can't see).
    expect(html).not.toContain("i&#x27;m interested");
    expect(html).not.toContain('i love this');
    expect(html).not.toContain('share this pick');
    expect(html).not.toContain('add to my week');
  });
});

describe('VillageFeedHeader — names the trust', () => {
  it('reads as the village recommendation, with the coarse area when present', () => {
    const html = renderToStaticMarkup(createElement(VillageFeedHeader, { area: 'M5V' }));
    expect(html).toContain('what your village recommends');
    expect(html).toContain('M5V');
  });

  it('falls back to the ranked-for-your-family line with no area', () => {
    const html = renderToStaticMarkup(createElement(VillageFeedHeader, { area: null }));
    expect(html).toContain('ranked for your family by Hale');
  });
});
