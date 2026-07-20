import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadSeed } from '~/lib/coach/thread';
import { AskHaleThread } from './ask-hale-thread';

// The input-intent widget (reachable from the thread) calls the logQuickEpisode
// 'use server' action. Stub the action module so this markup-only test doesn't
// pull the server/auth graph (next-auth → next/server) through the import.
vi.mock('~/lib/companion/log', () => ({
  logQuickEpisode: vi.fn(),
}));
// Same reason: the create_plan widget calls createPlan ('use server').
vi.mock('~/lib/plan/plan-actions', () => ({
  createPlan: vi.fn(),
}));

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

  it('renders the chat arrangement — parent bubble, Hale reply with a spark identity marker', () => {
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
    // …as a real transcript: the parent's turn in a navy chat bubble, Hale's answer
    // as plain text beside a small spark that carries the (sr-only) "Hale" name — not
    // a card, and not the editorial quote layout.
    expect(html).toContain('chat-bubble-you');
    expect(html).not.toContain('chat-bubble-hale');
    // The spark marker names the author for a screen reader.
    expect(html).toMatch(/<span[^>]*class="sr-only">Hale<\/span>/);
  });

  it('shows the welcoming empty state when there is no conversation yet', () => {
    const html = render(seed([]));

    // The first-screen invite (desktop handoff §4.4) + a suggestion tile (which
    // prefills + sends). The greeting word is time-of-day, so only the stable
    // sub-line is asserted here.
    expect(html).toContain('What can I do for your family today?');
    expect(html).toContain('how are naps going?');
  });

  it('greets the signed-in parent by first name when one is supplied', () => {
    const html = renderToStaticMarkup(
      createElement(AskHaleThread, {
        canAsk: true,
        seed: seed([]),
        variant: 'full',
        viewerName: 'Alex Dong',
      }),
    );
    // The greeting interpolates the parent's first name ("Good {morning|…}, Alex.");
    // the time-of-day word varies, so assert the stable name clause.
    expect(html).toContain(', Alex.');
  });

  it('renders the three-column shell — session rail, conversation, context rail', () => {
    const html = render(seed([]));
    // Both collapsible side rails frame the conversation (desktop handoff §4.4).
    expect(html).toMatch(/aria-label="Chat history"/);
    expect(html).toMatch(/aria-label="Context"/);
    // Each rail carries a collapse toggle (the Cowork-style 44px-strip affordance).
    expect(html).toMatch(/aria-label="Collapse chat history"/);
    expect(html).toMatch(/aria-label="Collapse context"/);
    // "New chat" starts a fresh conversation.
    expect(html).toContain('New chat');
  });

  it('defers the client-local session list so SSR carries no time text that could mismatch', () => {
    const html = renderToStaticMarkup(
      createElement(AskHaleThread, {
        canAsk: true,
        seed: seed([]),
        variant: 'full',
        initialConversations: [
          {
            id: 'c1',
            title: 'Book the 15-month visit',
            noteKey: null,
            lastMessageAt: new Date().toISOString(),
            messageCount: 3,
          },
        ],
      }),
    );
    // The rail chrome is server-rendered…
    expect(html).toContain('Chat history');
    expect(html).toContain('New chat');
    // …but the grouped list (Today/Earlier + locale-dependent times) is computed off the
    // device's LOCAL day post-mount, so the SSR intentionally omits it (a server-locale
    // time would hydration-mismatch the client's). The live list is covered by the
    // session-groups unit tests + live QA.
    expect(html).not.toContain('Book the 15-month visit');
  });

  it('announces via a discrete status node, not by making the transcript a live region', () => {
    const html = render(
      seed([
        msg({ id: 'a', role: 'user', content: 'when do solids start?' }),
        msg({ id: 'b', role: 'assistant', content: 'Around six months.' }),
      ]),
    );
    // Exactly one polite live region — the sr-only <output> status node (an
    // <output> has an implicit role=status) — and it is NOT the transcript wrapper
    // (which would re-announce the whole thread on every streamed token).
    expect((html.match(/aria-live="polite"/g) ?? []).length).toBe(1);
    expect(html).toMatch(
      /<output[^>]*aria-live="polite"[^>]*class="sr-only"|<output[^>]*class="sr-only"[^>]*aria-live="polite"/,
    );
    // The Hale answer bubble is inside the transcript, not inside a live region.
    const liveIdx = html.indexOf('aria-live="polite"');
    expect(html.indexOf('Around six months.')).toBeLessThan(liveIdx);
  });

  it('keeps the pinned footer short once chatting — no stacked suggestion chips', () => {
    // Empty: the suggestion chip is offered (in the transcript's welcome).
    expect(render(seed([]))).toContain('how are naps going?');
    // Populated: the follow-up chips are retired from the footer so a 320px phone
    // keeps the transcript, not a multi-line chip block above the composer.
    const populated = render(seed([msg({ id: 'a', content: 'when do solids start?' })]));
    expect(populated).not.toContain('how are naps going?');
    // The two-line privacy note also collapses after the first send.
    expect(populated).not.toContain('your conversation stays inside Hale');
  });

  it('offers the attachment paperclip in the composer (ATTACHMENTS_ENABLED is on)', () => {
    // B4 backend is live, so the flag is flipped: the composer exposes the multi-file
    // picker + its labelled trigger. (Chips + their AA-contrast tint classes render
    // post-upload — client state — so their contrast is guarded by the token unit
    // test, not this SSR markup.)
    const html = render(seed([]));
    expect(html).toMatch(/aria-label="attach files"/);
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple/);
  });

  it('renders no own <h1> — the app shell owns the sole /coach hero (§3.2)', () => {
    // The thread must NOT emit its own heading: the shell's PageHero renders the one
    // "Hale" hero for the /coach root (top bar + narrow-viewport stage). A heading here
    // stacked two serif titles once a conversation existed and put two <h1>s in the
    // a11y tree — the duplicate-hero regression. Zero own h1 in BOTH states.
    const h1 = /<h1[^>]*>/g;
    expect((render(seed([])).match(h1) ?? []).length).toBe(0);
    const populated = render(seed([msg({ id: 'a', content: 'when do solids start?' })]));
    expect((populated.match(h1) ?? []).length).toBe(0);
  });
});
