import { describe, expect, it } from 'vitest';
import { AskBox } from './ask-box';
import { CoachConversation } from './coach-conversation';
import { AskHaleThread } from './ask-hale-thread';

/**
 * Both Ask Hale surfaces are unified onto the ONE shared component: the Home hero
 * (AskBox) and the full /coach thread (CoachConversation) each render
 * AskHaleThread, differing only by variant. Calling the wrapper returns a React
 * element (a plain `{ type, props }` object), so we assert the element type IS the
 * shared component and the seed + canAsk are forwarded unchanged — no second,
 * divergent chat surface.
 */

const SEED = {
  conversationId: 'conv-1',
  messages: [{ role: 'user' as const, content: 'is this normal?' }],
};

describe('Ask Hale surfaces share one component', () => {
  it('AskBox renders the shared AskHaleThread in the compact variant', () => {
    const el = AskBox({ canAsk: true, seed: SEED });

    expect(el.type).toBe(AskHaleThread);
    expect(el.props).toMatchObject({ canAsk: true, seed: SEED, variant: 'compact' });
  });

  it('CoachConversation renders the shared AskHaleThread in the full variant', () => {
    const el = CoachConversation({ canAsk: false, seed: SEED });

    expect(el.type).toBe(AskHaleThread);
    expect(el.props).toMatchObject({ canAsk: false, seed: SEED, variant: 'full' });
  });
});
