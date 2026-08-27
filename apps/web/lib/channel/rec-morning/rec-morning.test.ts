import { describe, expect, it } from 'vitest';
import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  BRAMPTON_WAITLIST_HOURS,
  EFUN_GONE,
  JACK_OF_SPORTS_PAGE,
  TORONTO_FIRST_REC,
  TORONTO_FOLLOW,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_FIRST,
  YMCA_FOLLOW,
  YMCA_PORTAL,
  matchRecMorning,
  recMorningIntakeReply,
  recMorningReply,
} from './index';

/** Same ceiling as intake/answer.ts MAX_REPLY_CHARS — kept local so this spec does not
 * pull the model composer (and @hale/agent) into a copy test. */
const INTAKE_MAX_REPLY_CHARS = 300;

const THIS_MORNING = new Date('2026-08-27T12:30:00-04:00');

function reply(text: string, now: Date = THIS_MORNING): string {
  const body = recMorningReply(text, now);
  if (body === null) throw new Error(`expected a rec-morning reply for: ${text}`);
  return body;
}

function intake(parentWords: string, pendingAsk = WATCH_OFFER_ASK): string {
  const body = recMorningIntakeReply({ parentWords, pendingAsk, now: THIS_MORNING });
  if (body === null) throw new Error(`expected an intake rec-morning reply for: ${parentWords}`);
  return body;
}

function firstAnswerIsClean(body: string): void {
  expect(body.toLowerCase()).not.toContain('activeto');
  expect(body.toLowerCase()).not.toContain('unofficial');
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body.toLowerCase()).not.toMatch(/\bwww\./);
  expect(body).not.toMatch(/I'm an AI/i);
  expect(body.toLowerCase()).not.toMatch(/\bapp\b/);
  expect(body.toLowerCase()).not.toContain('jack of sports');
}

describe('rec-morning matcher', () => {
  it('reads Toronto swim, rec, waitlist, wishlist, and eFun', () => {
    expect(matchRecMorning('when does Toronto swim registration open?')).toBe('toronto_swim');
    expect(matchRecMorning('Toronto fall rec registration dates?')).toBe('toronto_rec');
    expect(matchRecMorning('how long is the Toronto waitlist?')).toBe('toronto_waitlist');
    expect(matchRecMorning('the wishlist looks frozen is that broken')).toBe('toronto_wishlist');
    expect(matchRecMorning('do I still use eFun for rec?')).toBe('toronto_efun');
    expect(matchRecMorning('is the portal ActiveTO?')).toBe('toronto_rec');
  });

  it('reads YMCA clock vs levels, Brampton, two phones, and Jack of Sports', () => {
    expect(matchRecMorning('when does YMCA swim open?')).toBe('ymca_gta_swim');
    expect(matchRecMorning('YMCA otter or Ultra?')).toBe('ymca_follow');
    expect(matchRecMorning('does YMCA need membership?')).toBe('ymca_follow');
    expect(matchRecMorning('Brampton learn to swim - is it Aug 24?')).toBe('brampton_swim');
    expect(matchRecMorning('do we both text from one phone or two')).toBe('two_parents');
    expect(matchRecMorning('what about Jack of Sports if the city lane is gone')).toBe(
      'jack_of_sports',
    );
  });

  it('does not steal a registration report, a watch ask, or a calendar instruction', () => {
    expect(matchRecMorning('waitlisted #3')).toBeNull();
    expect(matchRecMorning('we got in')).toBeNull();
    expect(matchRecMorning('can you watch swim registration for Milo this fall?')).toBeNull();
    expect(matchRecMorning('cancel Thursday swim')).toBeNull();
    expect(matchRecMorning('what a morning')).toBeNull();
  });
});

describe('rec-morning SMS · locked first-hello strings', () => {
  it('sends the locked Toronto first-rec line for swim AND rec', () => {
    expect(TORONTO_FIRST_REC).toBe(
      "Toronto rec and swim open 7:00 a.m. on your district morning: Sept 9 if you're catchment-only, Sept 15 or 16 otherwise. Sign in at toronto.ca/OnlineReg with the centre district, not your home address.",
    );
    expect(reply('When does Toronto swim registration open?')).toBe(TORONTO_FIRST_REC);
    expect(reply('when is Toronto fall recreation registration?')).toBe(TORONTO_FIRST_REC);
    expect(TORONTO_FIRST_REC).toContain(TORONTO_REC_PORTAL);
    firstAnswerIsClean(TORONTO_FIRST_REC);
    expect(TORONTO_FIRST_REC.toLowerCase()).not.toContain('efun');
    expect(intake('When does Toronto swim registration open?')).toBe(
      `${TORONTO_FIRST_REC} Still want me watching?`,
    );
    expect(intake('when is Toronto fall recreation registration?', COLD_START_ASK)).toBe(
      `${TORONTO_FIRST_REC} ${COLD_START_ASK}`,
    );
  });

  it('never names ActiveTO on the first Toronto answer, even if they asked for it', () => {
    const body = reply('is the portal ActiveTO?');
    expect(body).toBe(TORONTO_FIRST_REC);
    firstAnswerIsClean(body);
  });

  it('names eFun only if they said eFun', () => {
    expect(EFUN_GONE).toBe('eFun is gone. Rec is toronto.ca/OnlineReg now.');
    expect(reply('do I log into eFun for Toronto rec?')).toBe(EFUN_GONE);
    expect(reply('When does Toronto swim registration open?').toLowerCase()).not.toContain('efun');
    expect(reply('is the portal ActiveTO?').toLowerCase()).not.toContain('efun');
  });

  it('sends the locked follow only when they need waitlist, wishlist, or two phones', () => {
    expect(TORONTO_FOLLOW).toBe(
      "Wishlist can look frozen, so wait, don't mash refresh. Waitlist email takes about 36 hours and there's no queue number. Two parents means two phones.",
    );
    expect(reply('how long is the Toronto rec waitlist? is there a queue number?')).toBe(
      TORONTO_FOLLOW,
    );
    expect(reply('the wishlist looks frozen, should I keep refreshing?')).toBe(TORONTO_FOLLOW);
    expect(reply('can both parents use one login?')).toBe(TORONTO_FOLLOW);
    expect(TORONTO_FOLLOW).toContain(String(TORONTO_WAITLIST_HOURS));
    expect(reply('When does Toronto swim registration open?')).not.toBe(TORONTO_FOLLOW);
    expect(TORONTO_FOLLOW.toLowerCase()).not.toContain('activeto');
    expect(TORONTO_FOLLOW.toLowerCase()).not.toContain('unofficial');
    expect(TORONTO_FOLLOW.toLowerCase()).not.toContain('efun');
  });

  it('sends the locked YMCA first answer, and the follow only for levels or membership', () => {
    expect(YMCA_FIRST).toBe('YMCA GTA swim is Aug 27 at 9:00 a.m. Sign in at MyY.YMCAGTA.ORG.');
    expect(reply('when does YMCA GTA swim registration open?')).toBe(YMCA_FIRST);
    expect(YMCA_FIRST).toContain(YMCA_PORTAL);
    firstAnswerIsClean(YMCA_FIRST);
    expect(YMCA_FIRST.toLowerCase()).not.toContain('efun');
    expect(YMCA_FOLLOW).toBe(
      'Search Otter, Seal, Dolphin, Star, not Ultra. Membership is still needed for a lot of group classes, and kids 9 and under need an adult 16+ on deck.',
    );
    expect(reply('YMCA otter or Ultra?')).toBe(YMCA_FOLLOW);
    expect(reply('does YMCA need membership?')).toBe(YMCA_FOLLOW);
    expect(reply('when does YMCA swim open?')).not.toBe(YMCA_FOLLOW);
    firstAnswerIsClean(YMCA_FOLLOW);
  });
});

describe('rec-morning SMS · Brampton and Jack of Sports when asked', () => {
  it('says Brampton Learn to Swim is Sept 9 7 a.m. residents, 24-hour waitlist, in person', () => {
    const body = reply('is Brampton swim Aug 24?');
    expect(body).toContain('Sept 9');
    expect(body).toContain('7 a.m.');
    expect(body).toContain('Aug 24');
    expect(body).toContain(String(BRAMPTON_WAITLIST_HOURS));
    expect(body.toLowerCase()).toContain('in person');
    expect(body).toContain(String(TORONTO_WAITLIST_HOURS));
    expect(body.toLowerCase()).not.toContain('activeto');
    expect(body.toLowerCase()).not.toContain('efun');
    expect(body.toLowerCase()).not.toContain('unofficial');
  });

  it('points Jack of Sports only when they ask, with no hours, app URL, or unofficial', () => {
    const body = reply('Jack of Sports if city swim is gone?');
    expect(body.toLowerCase()).toContain('backup');
    expect(body).toContain(JACK_OF_SPORTS_PAGE);
    expect(body.toLowerCase()).not.toContain('unofficial');
    expect(body).not.toMatch(/\d{1,2}:\d{2}/);
    expect(body).not.toMatch(/https?:\/\//i);
    expect(body.toLowerCase()).not.toContain('activeto');
    expect(body.toLowerCase()).not.toContain('efun');
    expect(reply('When does Toronto swim registration open?').toLowerCase()).not.toContain(
      'jack of sports',
    );
    expect(reply('when does YMCA swim open?').toLowerCase()).not.toContain('jack of sports');
  });
});

describe('rec-morning SMS · budgets and the intake return', () => {
  it('keeps every C1 body GSM-7 and inside two segments', () => {
    const texts = [
      'When does Toronto swim registration open?',
      'when is Toronto fall recreation registration?',
      'how long is the Toronto rec waitlist?',
      'the wishlist looks frozen, should I keep refreshing?',
      'do I log into eFun for Toronto rec?',
      'when does YMCA GTA swim registration open?',
      'YMCA otter or Ultra?',
      'is Brampton swim Aug 24?',
      'can both parents use one login?',
      'Jack of Sports if city swim is gone?',
    ];
    for (const text of texts) {
      const body = reply(text);
      expect({ text, encoding: smsEncoding(body), segments: smsSegments(body) }).toEqual({
        text,
        encoding: 'gsm7',
        segments: expect.any(Number),
      });
      expect(smsSegments(body), text).toBeLessThanOrEqual(2);
    }
  });

  it("answers mid-signup, returns to Hale's ask, and stays inside the intake cap", () => {
    const texts = [
      'When does Toronto swim registration open?',
      'when is Toronto fall recreation registration?',
      'how long is the Toronto rec waitlist?',
      'the wishlist looks frozen, should I keep refreshing?',
      'do I log into eFun for Toronto rec?',
      'when does YMCA GTA swim registration open?',
      'YMCA otter or Ultra?',
      'is Brampton swim Aug 24?',
      'can both parents use one login?',
      'Jack of Sports if city swim is gone?',
    ];
    for (const text of texts) {
      const body = intake(text);
      expect(body, text).not.toContain(WATCH_OFFER_ASK);
      expect(body.length, text).toBeLessThanOrEqual(INTAKE_MAX_REPLY_CHARS);
      expect(smsEncoding(body), text).toBe('gsm7');
    }

    expect(intake('When does Toronto swim registration open?')).toBe(
      `${TORONTO_FIRST_REC} Still want me watching?`,
    );
    expect(intake('when does YMCA swim open?', COLD_START_ASK)).toBe(
      `${YMCA_FIRST} ${COLD_START_ASK}`,
    );
  });
});
