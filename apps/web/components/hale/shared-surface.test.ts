import { describe, expect, it, vi } from 'vitest';
import { AskBox } from './ask-box';
import { CoachConversation } from './coach-conversation';
import { ConciergeThread } from './concierge-thread';

// The Concierge tree reaches the input-intent widget, which calls the
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
 * Both Concierge surfaces are unified onto the ONE shared component: the Home hero
 * (AskBox) and the full /coach thread (CoachConversation) each render
 * ConciergeThread, differing only by variant. Calling the wrapper returns a React
 * element (a plain `{ type, props }` object), so we assert the element type IS the
 * shared component and the seed + canAsk are forwarded unchanged — no second,
 * divergent chat surface.
 */

const SEED = {
  conversationId: 'conv-1',
  timeline: [
    {
      id: 'm0',
      role: 'user' as const,
      content: 'is this normal?',
      childId: null,
      topic: null,
      createdAt: 't0',
    },
  ],
  children: [],
  suggestions: [{ childId: null, label: null, stage: null, prompts: ['help me plan the week'] }],
};

describe('Concierge surfaces share one component', () => {
  it('AskBox renders the shared ConciergeThread in the compact variant', () => {
    const el = AskBox({ canAsk: true, seed: SEED });

    expect(el.type).toBe(ConciergeThread);
    expect(el.props).toMatchObject({ canAsk: true, seed: SEED, variant: 'compact' });
  });

  it('CoachConversation renders the shared ConciergeThread in the full variant', () => {
    const el = CoachConversation({ canAsk: false, seed: SEED, connectors: [] });

    expect(el.type).toBe(ConciergeThread);
    expect(el.props).toMatchObject({ canAsk: false, seed: SEED, variant: 'full' });
  });
});
