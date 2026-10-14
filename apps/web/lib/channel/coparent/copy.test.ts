import { describe, expect, it } from 'vitest';
import type { ReplyLanguage } from '~/lib/channel/language';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import {
  CO_PARENT_DECLINE_ACK_BY_LANGUAGE,
  CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE,
  CO_PARENT_NUMBER_IN_USE_BY_LANGUAGE,
  CO_PARENT_SEAT_TAKEN_BY_LANGUAGE,
  INVITE_EXPIRED_BY_LANGUAGE,
  PREVIOUSLY_DECLINED_BY_LANGUAGE,
  REFERRER_UNNAMED_BY_LANGUAGE,
  coParentWelcome,
  inviterNameIsAffordable,
} from './copy';

/**
 * VIL-355 · the co-parent copy carries the two things a caregiver's cannot: it goes to a
 * stranger unprompted, and it goes to them in their own language. Both are budget
 * questions before they are wording questions.
 */

const LANGUAGES: ReplyLanguage[] = ['en', 'fr'];

/** Exactly the ceiling `inviterNameIsAffordable` lets through (24 characters) — the
 * worst case every send has to survive, not merely a long-ish one. */
const LONGEST_NAME = 'Marie-Claude Bergeron-Ly';

describe('co-parent copy · the budget', () => {
  it.each(LANGUAGES)('keeps the welcome inside two GSM-7 segments in %s', (language) => {
    const body = coParentWelcome(LONGEST_NAME, language);
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });

  /**
   * THE POSITIVE CONTROL for the budget tests above. A name the alphabet cannot carry
   * must be refused BEFORE it reaches a body — not folded, not respelled, and above all
   * not sent as a three-segment message. The affordable/unaffordable pair is what proves
   * the gate discriminates at all: a predicate that returned false for everything would
   * pass the second half of this alone.
   */
  it('refuses a name the GSM-7 alphabet cannot carry, and accepts one it can', () => {
    expect(inviterNameIsAffordable(LONGEST_NAME)).toBe(true);
    // Every one of these would flip the whole body to UCS-2 and split it in three.
    expect(inviterNameIsAffordable('Zoë')).toBe(false);
    expect(inviterNameIsAffordable('李明')).toBe(false);
    expect(inviterNameIsAffordable('François')).toBe(false);
    // And the two non-encoding refusals the same gate owes.
    expect(inviterNameIsAffordable(null)).toBe(false);
    expect(inviterNameIsAffordable('   ')).toBe(false);
    expect(inviterNameIsAffordable('A'.repeat(25))).toBe(false);
  });
});

describe('co-parent copy · what it promises', () => {
  it('never tells the parent WHOSE account a busy number belongs to (rule #1)', () => {
    for (const language of LANGUAGES) {
      expect(CO_PARENT_NUMBER_IN_USE_BY_LANGUAGE[language]).not.toMatch(
        /family|famille|their|leur/,
      );
    }
  });

  it('gives every refusal a French twin that is really French', () => {
    for (const map of [
      REFERRER_UNNAMED_BY_LANGUAGE,
      CO_PARENT_NUMBER_IN_USE_BY_LANGUAGE,
      CO_PARENT_SEAT_TAKEN_BY_LANGUAGE,
      PREVIOUSLY_DECLINED_BY_LANGUAGE,
      CO_PARENT_DECLINE_ACK_BY_LANGUAGE,
    ]) {
      expect(map.fr).not.toBe(map.en);
      expect(isGsm7(map.fr)).toBe(true);
      expect(smsSegments(map.fr)).toBeLessThanOrEqual(2);
    }
  });
});

describe('co-parent copy · the two sentences nobody asked for (VIL-355 follow-up)', () => {
  /**
   * Both are read by somebody who did not write to Hale this turn, so neither may cost
   * more than the invite itself. One segment each is the standard: the expired reply is
   * the whole of what a stranger gets, and the departure notice still has to fit the
   * CASL opt-out line the gate appends on the wire.
   */
  it.each(LANGUAGES)('keeps the expired-invite reply to one GSM-7 segment in %s', (language) => {
    const body = INVITE_EXPIRED_BY_LANGUAGE[language];
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(body)).toBe(1);
  });

  it.each(LANGUAGES)('keeps the departure notice to one GSM-7 segment in %s', (language) => {
    const body = CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE[language];
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(body)).toBe(1);
  });

  it('keeps the 1:1 French departure line ASCII', () => {
    expect(CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE.fr).toBe(
      "Votre co-parent a quitte Hale. Votre semaine est a vous seul maintenant - rien n'y a change, et le lien d'invitation fonctionne toujours.",
    );
  });

  it('names nobody in the departure notice — no person, no household, no child', () => {
    for (const language of LANGUAGES) {
      const body = CO_PARENT_DEPARTED_NOTICE_BY_LANGUAGE[language];
      // A template that ever grew an interpolation would show up as a placeholder here.
      expect(body).not.toMatch(/\$\{|\{\{/);
      // The only person-shaped word it may carry is the role itself.
      expect(body.toLowerCase()).toContain('co-parent');
    }
  });
});
