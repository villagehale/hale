import { describe, expect, it } from 'vitest';
import { buildCoachRequest } from './use-ask-hale';

/**
 * conversationId round-trip: every Ask Hale surface shares this single payload
 * builder, so the running conversationId is carried forward on each turn (the
 * agent continues the SAME thread) and omitted on the first turn (a fresh thread
 * is opened server-side). This is the contract the rehydrated seed feeds into.
 */
describe('buildCoachRequest', () => {
  it('omits conversationId on the first turn so a fresh thread is opened', () => {
    expect(buildCoachRequest('when do I start solids?', null)).toEqual({
      question: 'when do I start solids?',
    });
  });

  it('carries the conversationId forward so the same thread continues', () => {
    expect(buildCoachRequest('and what about allergens?', 'conv-7')).toEqual({
      question: 'and what about allergens?',
      conversationId: 'conv-7',
    });
  });
});
