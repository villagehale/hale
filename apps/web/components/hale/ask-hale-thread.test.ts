import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadSeed } from '~/lib/coach/thread';
import { AskHaleThread } from './ask-hale-thread';

/**
 * The /coach Ask Hale surface — a contained chat. These tests render to static
 * HTML (the repo's render idiom — no jsdom, no LLM call). They guard the chat
 * structure that can regress silently in markup:
 *  - the composer is a reachable, labelled input pinned at the surface foot (a
 *    solid canvas bar, not a floating overlay);
 *  - search is a secondary toggled affordance, not a box stacked above the chat;
 *  - each turn renders in the transcript.
 * The search→timeline *filtering* logic itself is unit-tested in use-ask-hale.test.
 */

function seed(timeline: ThreadSeed['timeline']): ThreadSeed {
  return {
    conversationId: 'conv-1',
    timeline,
    children: [],
    suggestions: [{ childId: null, label: null, stage: null, prompts: ['how are naps going?'] }],
  };
}

function msg(
  over: Partial<ThreadSeed['timeline'][number]> & { id: string },
): ThreadSeed['timeline'][number] {
  return {
    role: 'user',
    content: '',
    childId: null,
    topic: null,
    createdAt: '2026-06-24T00:00:00.000Z',
    ...over,
  };
}

function render(s: ThreadSeed): string {
  return renderToStaticMarkup(
    createElement(AskHaleThread, { canAsk: true, seed: s, variant: 'full' }),
  );
}

describe('AskHaleThread — full surface', () => {
  it('renders the composer with a reachable, labelled input pinned at the foot', () => {
    const html = render(seed([]));

    // The composer textarea exists and is wired to its (sr-only) label.
    expect(html).toMatch(/<textarea[^>]*id="coach-input"/);
    expect(html).toMatch(/<label[^>]*for="coach-input"[^>]*>\s*ask Hale\s*<\/label>/);
    // It sits in the pinned composer bar (solid canvas + top seam), not a
    // translucent floating overlay.
    expect(html).toContain('sticky bottom-0');
    expect(html).toContain('bg-linen');
    expect(html).toContain('border-t border-rule');
  });

  it('keeps search a secondary affordance — the box is revealed, not stacked on top', () => {
    const html = render(seed([msg({ id: 'a', content: 'when do solids start?' })]));

    // The search toggle exists (so search is reachable)…
    expect(html).toMatch(/aria-label="search this conversation"/);
    // …but the full search input is not stacked above the chat by default.
    expect(html).not.toContain('placeholder="search this conversation"');
  });

  it('renders the chat arrangement — parent bubble, Hale card with an identity marker', () => {
    const html = render(
      seed([
        msg({ id: 'a', role: 'user', content: 'when do solids start?' }),
        msg({
          id: 'b',
          role: 'assistant',
          content: 'Around six months, watch for readiness cues.',
        }),
      ]),
    );

    // Both turns render…
    expect(html).toContain('when do solids start?');
    expect(html).toContain('Around six months');
    // …as a real transcript: the parent's turn in a chat bubble, Hale's answer in
    // its card carrying the identity marker (not the editorial quote layout).
    expect(html).toContain('chat-bubble-you');
    expect(html).toContain('chat-bubble-hale');
    expect(html).toMatch(/>Hale</);
  });

  it('shows the welcoming empty state when there is no conversation yet', () => {
    const html = render(seed([]));

    // The first-screen invite + suggestion chip (which prefills the composer).
    expect(html).toContain('one ongoing conversation, grounded in your family');
    expect(html).toContain('how are naps going?');
  });
});
