import { describe, expect, it } from 'vitest';
import { isQuestionOrNewFind, isSoftLadderAck } from './soft-ack';

describe('isSoftLadderAck', () => {
  it('treats a short ack as soft', () => {
    for (const body of ['cool', 'thanks', 'ok', 'nice', 'perfect', '👍', 'merci', 'daccord']) {
      expect(isSoftLadderAck(body)).toBe(true);
      expect(isQuestionOrNewFind(body)).toBe(false);
    }
  });

  it('does not treat a question or a new find as soft', () => {
    for (const body of [
      'when does swim registration open?',
      'what is on this weekend',
      'find something for Maya',
      "what's on near us",
    ]) {
      expect(isQuestionOrNewFind(body)).toBe(true);
      expect(isSoftLadderAck(body)).toBe(false);
    }
  });
});
