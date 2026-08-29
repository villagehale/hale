import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { adultLearnDoor, adultLearnIntakeReply, isAdultLearnAsk } from './adult-learn';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';

describe('adult-learn · the kids-only door', () => {
  it('reproduces the Designer-locked line byte-for-byte when the city slot holds Brampton', () => {
    // The 2026-08-28 city parameterisation touched ONLY the slot: with 'Brampton' in
    // it, the sentence is the exact 2026-08-27 Designer lock. Hyphens, not em dashes.
    expect(adultLearnDoor('Brampton')).toBe(
      "I'm a kids' rec helper, not adult lessons. If you've got kids, send their names and ages and I'll watch Brampton for them. If it's just you, no hard feelings.",
    );
    expect(adultLearnDoor(null)).not.toContain('—');
    expect(adultLearnDoor(null)).not.toContain("I don't do that");
  });

  it("watches the SESSION's city, never the wrong one (ads-week audit, 2026-08-28)", () => {
    // A Markham session (L3R) heard Hale offer to watch Brampton — the one hardcoded
    // city, shipped to every session in the province.
    const markham = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: COLD_START_ASK,
      postal: 'L3R',
    });
    expect(markham).toContain("I'll watch Markham for them");
    expect(markham).not.toContain('Brampton');

    const toronto = adultLearnIntakeReply({
      parentWords: 'I wanna learn swimming',
      pendingAsk: COLD_START_ASK,
      postal: 'M5V 2T6',
    });
    expect(toronto).toContain("I'll watch Toronto for them");
    expect(toronto).not.toContain('Brampton');

    // A Brampton session still hears Brampton — the slot is the session's, not banned.
    const brampton = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: COLD_START_ASK,
      postal: 'L6R',
    });
    expect(brampton).toContain("I'll watch Brampton for them");
  });

  it('names NO city rather than the wrong one when the area resolves to none — or two', () => {
    const noArea = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: COLD_START_ASK,
      postal: null,
    });
    expect(noArea).toContain("I'll watch your area for them");
    expect(noArea).not.toContain('Brampton');

    // Thornhill's L4J straddles Vaughan and Markham; picking either would be a guess.
    const straddle = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: COLD_START_ASK,
      postal: 'L4J',
    });
    expect(straddle).toContain("I'll watch your area for them");

    // Outside the covered municipality set entirely.
    const uncovered = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: COLD_START_ASK,
      postal: 'K1A',
    });
    expect(uncovered).toContain("I'll watch your area for them");
    expect(uncovered).not.toContain('Brampton');
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
      postal: null,
    });
    expect(first).toBe(`${adultLearnDoor(null)} ${COLD_START_ASK}`);
    expect(first).not.toMatch(/\b(Sept|Sep|Aug|Nov|Dec)\b/);
    expect(smsEncoding(first as string)).toBe('gsm7');
    expect(smsSegments(first as string)).toBeLessThanOrEqual(2);

    const mid = adultLearnIntakeReply({
      parentWords: 'adult lessons',
      pendingAsk: WATCH_OFFER_ASK,
      postal: null,
    });
    expect(mid).toBe(`${adultLearnDoor(null)} Still want me watching?`);
    expect(
      adultLearnIntakeReply({ parentWords: 'hi', pendingAsk: COLD_START_ASK, postal: null }),
    ).toBeNull();
  });
});
