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
    summary: `summary-${overrides.id}`,
    coverageNote: null,
    sourceUrl: null,
    acceptHref: `/api/village/${overrides.id}/accept`,
    endorseHref: `/api/village/${overrides.id}/endorse`,
    shareHref: `/api/village/${overrides.id}/share`,
    endorsementCount: 0,
    endorsedByFamily: false,
    accepted: false,
    lat: null,
    lng: null,
    venueName: null,
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

  it('rides social proof on a well-endorsed card (loved by N families)', () => {
    const html = renderFeed([view({ id: 'a', title: 'card-a', endorsementCount: 5 })]);
    expect(html).toContain('loved by 5 families near you');
  });

  it('shows the endorse + share + accept controls on a normal card', () => {
    const html = renderFeed([view({ id: 'a', title: 'card-a' })]);
    expect(html).toContain('i love this'); // EndorseButton
    expect(html).toContain('share this pick'); // ShareButton
    expect(html).toContain('add to my week'); // AcceptButton
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
    // can't preview.
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
