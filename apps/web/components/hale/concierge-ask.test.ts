import { describe, expect, it, vi } from 'vitest';
import type { ThreadSeed } from '~/lib/coach/thread';
import { AskBox } from './ask-box';
import { ConciergeAsk } from './concierge-ask';

// The Ask Hale tree reaches the input-intent widget, which calls the
// logQuickEpisode 'use server' action. Stub the action module so this markup-only
// test doesn't pull the server/auth graph (next-auth → next/server) through it.
vi.mock('~/lib/companion/log', () => ({
  logQuickEpisode: vi.fn(),
}));
// Same reason: the create_plan widget calls createPlan ('use server').
vi.mock('~/lib/plan/plan-actions', () => ({
  createPlan: vi.fn(),
}));

/**
 * Ask Hale stays present as the village CONCIERGE — not the hero. The concierge
 * wrapper must keep the ask box WORKING: it forwards canAsk + seed unchanged to
 * the same shared AskBox (→ AskHaleThread → useAskHale → /api/coach), so the
 * concierge thread is the same continuous, memory-backed conversation, only
 * reframed. We assert the wrapper renders that AskBox with the props intact and
 * carries the concierge framing — without deep-rendering the client thread (which
 * would run hooks outside React).
 */

const SEED: ThreadSeed = {
  conversationId: 'conv-1',
  timeline: [],
  children: [],
  suggestions: [],
};

describe('ConciergeAsk — Ask Hale present as the concierge', () => {
  it('forwards canAsk + seed to the shared AskBox unchanged (the ask box still works)', () => {
    const el = ConciergeAsk({ canAsk: true, seed: SEED });
    // Find the AskBox element anywhere in the rendered tree.
    const found = findElement(el, AskBox);
    expect(found).not.toBeNull();
    expect(found?.props).toMatchObject({ canAsk: true, seed: SEED });
  });

  it('frames Ask Hale as the concierge (refine your feed), not the page hero', () => {
    const serialized = JSON.stringify(ConciergeAsk({ canAsk: true, seed: SEED }));
    expect(serialized).toContain('your concierge');
    expect(serialized).toContain('refine your feed');
  });
});

/** Depth-first search for the first element whose `type` is `target`. */
// biome-ignore lint/suspicious/noExplicitAny: walking an opaque React element tree.
function findElement(node: any, target: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== 'object') return null;
  if (node.type === target) return node;
  const children = node.props?.children;
  const list = Array.isArray(children) ? children : children ? [children] : [];
  for (const child of list) {
    const found = findElement(child, target);
    if (found) return found;
  }
  return null;
}
