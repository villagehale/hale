import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  ADULT_LEARN_DOOR,
  ADULT_LEARN_DOOR_BY_LANGUAGE,
  adultLearnIntakeReply,
  isAdultLearnAsk,
} from './adult-learn';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';

describe('adult-learn · the kids-only door', () => {
  it('is the locked English line - no city baked in, hyphens not em dashes', () => {
    expect(ADULT_LEARN_DOOR).toBe(
      "I'm a kids' rec helper, not adult lessons. If you've got kids, send their names and ages and I'll watch your city's sign-ups for them. If it's just you, no hard feelings.",
    );
    expect(ADULT_LEARN_DOOR).not.toContain('\u2014');
    expect(ADULT_LEARN_DOOR).not.toContain("I don't do that");
    // Doctrine L4/G9: the door goes to any adult-learn ask nationwide, so it may
    // name no city — "watch Brampton" to a Toronto adult was the bug.
    expect(ADULT_LEARN_DOOR).not.toContain('Brampton');
  });

  it('carries a lockstepped French twin, GSM-7, with no city baked in either', () => {
    expect(ADULT_LEARN_DOOR_BY_LANGUAGE.en).toBe(ADULT_LEARN_DOOR);
    expect(ADULT_LEARN_DOOR_BY_LANGUAGE.fr).toBe(
      "Je m'occupe du rec des enfants, pas des cours pour adultes. Si vous avez des enfants, envoyez leur nom et leur age et je surveillerai les inscriptions de votre ville. Si c'est juste pour vous, sans rancune.",
    );
    expect(smsEncoding(ADULT_LEARN_DOOR_BY_LANGUAGE.fr)).toBe('gsm7');
    expect(ADULT_LEARN_DOOR_BY_LANGUAGE.fr).not.toContain('Brampton');
    expect(ADULT_LEARN_DOOR_BY_LANGUAGE.fr).not.toContain('!');
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
