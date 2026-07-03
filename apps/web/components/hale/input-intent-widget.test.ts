import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { InputIntent } from '~/lib/coach/action-intent';
import type { TimelineChild } from '~/lib/coach/thread';
import { InputIntentWidgets } from './input-intent-widget';

// The widget calls the logQuickEpisode 'use server' action on Confirm. A static
// render never invokes it, but importing it would drag the server/auth graph
// (next-auth → next/server) into this markup-only test. Stub the action module at
// its boundary so rendering stays pure — the write path is covered in log.test.
vi.mock('~/lib/companion/log', () => ({
  logQuickEpisode: vi.fn(),
  logBookingRequested: vi.fn(),
}));

/**
 * The input-side confirm widgets render to static HTML (the repo's render idiom —
 * no jsdom, no server-action call). These guard the accessibility contract that
 * can regress silently in markup: the card is a labelled group, and both
 * Confirm/Not-now are real buttons. Interaction (the fetch / logQuickEpisode
 * round-trip) is exercised by the detector + log-action unit tests, not here.
 */

const KIDS: TimelineChild[] = [{ id: 'c1', label: 'Noah', teenRedacted: false }];

function render(intents: InputIntent[], question: string): string {
  return renderToStaticMarkup(
    createElement(InputIntentWidgets, {
      intents,
      focusedChildId: null,
      question,
      kids: KIDS,
    }),
  );
}

describe('InputIntentWidgets', () => {
  it('renders a Hale-acts confirm as a labelled group with Confirm and Not-now buttons', () => {
    const html = render(
      [
        {
          category: 'action',
          kind: 'book_checkup',
          label: 'Book a check-up',
          actionType: 'create_calendar_event',
        },
      ],
      'book a check-up for Noah',
    );

    // A labelled group: the <section> points aria-labelledby at the heading id.
    const labelledById = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledById).toBeTruthy();
    expect(html).toContain(`id="${labelledById}"`);
    // Both controls are real buttons, and the card announces state via aria-live.
    expect(html).toMatch(/<button[^>]*>Confirm<\/button>/);
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
    expect(html).toContain('aria-live="polite"');
    // Honest routing copy — a draft, never "done".
    expect(html).toContain('held for your approval');
  });

  it('renders a quick_log confirm as a labelled group pre-filled with the parsed episode', () => {
    const html = render(
      [
        {
          category: 'log',
          kind: 'quick_log',
          label: 'Log this',
          parsed: { episode: 'feed', timeHint: '3pm', childName: 'Noah' },
        },
      ],
      'Noah had a bottle at 3pm',
    );

    const labelledById = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledById).toBeTruthy();
    expect(html).toContain(`id="${labelledById}"`);
    // The feed episode surfaces its editable amount field + the parsed time hint.
    expect(html).toContain('Log a feed');
    expect(html).toContain('how much (ml)');
    expect(html).toContain('you said');
    // Real Confirm/Not-now buttons.
    expect(html).toMatch(/<button[^>]*>Confirm<\/button>/);
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
  });
});
