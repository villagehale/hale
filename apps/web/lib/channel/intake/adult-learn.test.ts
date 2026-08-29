import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { ADULT_LEARN_DOOR, adultLearnIntakeReply, isAdultLearnAsk } from './adult-learn';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';

describe('adult-learn · the kids-only door', () => {
  it('is the Designer-locked English line, hyphens not em dashes', () => {
    expect(ADULT_LEARN_DOOR).toBe(
      "I'm a kids' rec helper, not adult lessons. If you've got kids, send their names and ages and I'll watch Brampton for them. If it's just you, no hard feelings.",
    );
    expect(ADULT_LEARN_DOOR).not.toContain('\u2014');
    expect(ADULT_LEARN_DOOR).not.toContain("I don't do that");
  });

  it('matches adult-learn and I wanna learn swimming, not kid rec clocks', () => {
    expect(isAdultLearnAsk('I wanna learn swimming')).toBe(true);
    expect(isAdultLearnAsk('I want to learn to swim')).toBe(true);
    expect(isAdultLearnAsk('adult lessons')).toBe(true);
    expect(isAdultLearnAsk('looking for adult swim lessons')).toBe(true);
    expect(isAdultLearnAsk('When does Toronto swim registration open?')).toBe(false);
    expect(isAdultLearnAsk('I want my kid to learn swimming')).toBe(false);
    expect(isAdultLearnAsk('when does Brampton swim open?')).toBe(false);
    expect(isAdultLearnAsk('hi')).toBe(false);
  });

  it('joins the locked door to the pending ask, never invents a date', () => {
    const first = adultLearnIntakeReply({
      parentWords: 'I wanna learn swimming',
      pendingAsk: COLD_START_ASK,
    });
    expect(first).toBe(`${ADULT_LEARN_DOOR} ${COLD_START_ASK}`);
    expect(first).not.toMatch(/\b(Sept|Sep|Aug|Nov|Dec)\b/);
    expect(smsEncoding(first as string)).toBe('gsm7');
    expect(smsSegments(first as string)).toBeLessThanOrEqual(2);

    const mid = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: WATCH_OFFER_ASK,
    });
    expect(mid).toBe(`${ADULT_LEARN_DOOR} Still want me watching?`);
    expect(adultLearnIntakeReply({ parentWords: 'hi', pendingAsk: COLD_START_ASK })).toBeNull();
  });
});
