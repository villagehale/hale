import { describe, expect, it } from 'vitest';
import { replyUsesControlAsName } from './control-phrase';

describe('replyUsesControlAsName', () => {
  it.each([
    "Got it, I'll call you undo.",
    'Got it, I\'ll call you "undo".',
    'Got it, I’ll call you “undo”.',
    "I'll call you 'undo'.",
    "D'accord. Je t'appelle undo.",
    'Je t’appelle « undo ».',
    'Je vous appelle undo.',
    "Je t'appellerai undo demain.",
    'I\'ll call you "never mind".',
  ])('catches %s', (reply) => {
    const words = reply.toLowerCase().includes('never mind') ? 'never mind' : 'undo';
    expect(replyUsesControlAsName(reply, words)).toBe(true);
  });

  it.each(["I'll undo that.", 'call you tomorrow about swim', "Je t'appelle Dana."])(
    'leaves %s alone when it is not that name',
    (reply) => {
      expect(replyUsesControlAsName(reply, 'undo')).toBe(false);
    },
  );
});
