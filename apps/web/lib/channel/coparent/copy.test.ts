import { describe, expect, it } from 'vitest';
import type { ReplyLanguage } from '~/lib/channel/language';
import { isGsm7, smsSegments } from '~/lib/channel/sms-segments';
import {
  CO_PARENT_ANSWER_PROMPT_BY_LANGUAGE,
  CO_PARENT_DECLINE_ACK_BY_LANGUAGE,
  CO_PARENT_NUMBER_IN_USE_BY_LANGUAGE,
  CO_PARENT_SEAT_TAKEN_BY_LANGUAGE,
  PREVIOUSLY_DECLINED_BY_LANGUAGE,
  REFERRER_UNNAMED_BY_LANGUAGE,
  coParentInviteBody,
  coParentScopeConfirm,
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
  it.each(LANGUAGES)('keeps the invite inside two GSM-7 segments in %s', (language) => {
    const body = coParentInviteBody(LONGEST_NAME, language);
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });

  it.each(LANGUAGES)('keeps the scope question inside two GSM-7 segments in %s', (language) => {
    const body = coParentScopeConfirm('Sam', language);
    expect(isGsm7(body)).toBe(true);
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });

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
  it('names the inviter BEFORE the first pronoun that points at them', () => {
    for (const language of LANGUAGES) {
      const body = coParentInviteBody('Ana', language);
      expect(body.indexOf('Ana')).toBeLessThan(body.indexOf(language === 'fr' ? 'leur' : 'their'));
    }
  });

  it('carries the CASL opt-out on the first message a stranger ever gets, in both', () => {
    expect(coParentInviteBody('Ana', 'en')).toContain('Reply STOP anytime');
    // CRTC §3.1: a French first contact has to name the keyword a French parent will
    // actually type. STOP is honoured too, but ARRET is the one this sentence promises.
    expect(coParentInviteBody('Ana', 'fr')).toContain('ARRET');
  });

  /**
   * The scope sentence is what the parent's `co_parent_access_grant` records as the
   * question. A co-parent's two powers are the whole read surface and the ability to
   * approve (role-scope.ts + orchestrator/index.ts), and a parent told only the first
   * has not been told that this person can say yes to Hale on their behalf.
   */
  it('states BOTH powers a co-parent gets, not just the reading one', () => {
    expect(coParentScopeConfirm('Sam', 'en')).toContain('everything I show you');
    expect(coParentScopeConfirm('Sam', 'en')).toContain('approve');
    expect(coParentScopeConfirm('Sam', 'fr')).toContain('approuver');
  });

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
      CO_PARENT_ANSWER_PROMPT_BY_LANGUAGE,
    ]) {
      expect(map.fr).not.toBe(map.en);
      expect(isGsm7(map.fr)).toBe(true);
      expect(smsSegments(map.fr)).toBeLessThanOrEqual(2);
    }
  });
});
