import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ThreadSeed } from '~/lib/coach/thread';
import { AskHaleThread } from './ask-hale-thread';

/**
 * The /coach Ask Hale surface. These tests render to static HTML (the repo's render
 * idiom — no jsdom, no LLM call). They guard the two polish fixes that can regress
 * silently in markup:
 *  - the search box uses `.field-search` (not the unlayered-overridden `pl-*`), so
 *    the leading icon never overlaps the text;
 *  - the composer renders with a reachable, labelled input pinned at the bottom.
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

function msg(over: Partial<ThreadSeed['timeline'][number]> & { id: string }): ThreadSeed['timeline'][number] {
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
  it('renders the search box with .field-search so the icon clears the text', () => {
    const html = render(seed([msg({ id: 'a', content: 'when do solids start?' })]));

    // The search input carries field-search (the fix), not a raw pl-* utility that
    // .field (unlayered) would override and leave the icon overlapping the text.
    const searchInput =
      html.match(/<input[^>]*placeholder="search this conversation"[^>]*>/)?.[0] ?? '';
    expect(searchInput).not.toBe('');
    expect(searchInput).toContain('field-search');
    expect(searchInput).not.toMatch(/class="[^"]*\bpl-10\b/);
    // The input is labelled (a11y).
    expect(html).toContain('search this conversation');
  });

  it('renders the composer with a reachable, labelled input', () => {
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

  it('renders each turn in the timeline', () => {
    const html = render(
      seed([
        msg({ id: 'a', role: 'user', content: 'when do solids start?' }),
        msg({ id: 'b', role: 'assistant', content: 'Around six months, watch for readiness cues.' }),
      ]),
    );

    expect(html).toContain('when do solids start?');
    expect(html).toContain('Around six months');
  });
});
