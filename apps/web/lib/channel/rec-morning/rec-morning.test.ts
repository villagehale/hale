import { describe, expect, it } from 'vitest';
import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  BRAMPTON_WAITLIST_HOURS,
  JACK_OF_SPORTS_PAGE,
  TORONTO_FIRST_CLASS,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_PORTAL,
  matchRecMorning,
  recMorningIntakeReply,
  recMorningReply,
} from './index';

/** Same ceiling as intake/answer.ts MAX_REPLY_CHARS — kept local so this spec does not
 * pull the model composer (and @hale/agent) into a copy test. */
const INTAKE_MAX_REPLY_CHARS = 300;

/**
 * Rec-morning SMS — the facts a first-time texter is owed, pinned.
 *
 * City pages already carry these (apps/site/lib/registration/guides.ts). This file is
 * the live SMS path: a parent who texts Hale this morning must get clock and portal
 * right in-thread, with no model in the loop to invent ActiveTO or eFun.
 */

const THIS_MORNING = new Date('2026-08-27T12:30:00-04:00');
const NOT_TODAY = new Date('2026-08-26T12:00:00-04:00');

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

function neverSendsToEfun(body: string): void {
  expect(body).toMatch(/eFun is gone/i);
  expect(body).not.toMatch(/efun\.(com|ca)/i);
  expect(body.toLowerCase()).not.toMatch(/\bon efun\b/);
  expect(body.toLowerCase()).not.toMatch(/\buse efun\b/);
}

function neverSendsToActiveTo(body: string): void {
  expect(body).toMatch(/not ActiveTO/i);
  expect(body.toLowerCase()).not.toMatch(/activeto\.(com|ca|app)/);
  expect(body.toLowerCase()).not.toMatch(/\bon activeto\b/);
  expect(body.toLowerCase()).not.toMatch(/\buse activeto\b/);
}

/** GTM first-class facts — pinned on the first-time Toronto rec/swim path, not optional. */
function pinsFirstClassTorontoFacts(body: string): void {
  expect(body).toContain(TORONTO_FIRST_CLASS);
  expect(body).toContain(String(TORONTO_WAITLIST_HOURS));
  expect(body.toLowerCase()).toContain('hours');
  expect(body.toLowerCase()).toContain('no queue number');
  expect(body.toLowerCase()).toContain('email');
  expect(body.toLowerCase()).toContain('dropped');
  expect(body.toLowerCase()).toContain('frozen');
  expect(body.toLowerCase()).toMatch(/\bwait\b/);
  expect(body.toLowerCase()).toMatch(/don't mash refresh|do not mash refresh|mash refresh/);
  expect(body).toMatch(/7:00/);
  expect(body.toLowerCase()).toMatch(/search live/);
  expect(body).toContain(TORONTO_REC_PORTAL);
  neverSendsToEfun(body);
  neverSendsToActiveTo(body);
}

describe('rec-morning matcher · first-time founding-family texts', () => {
  it('reads Toronto swim, rec, waitlist, wishlist, and the retired portals', () => {
    expect(matchRecMorning('when does Toronto swim registration open?')).toBe('toronto_swim');
    expect(matchRecMorning('Toronto fall rec registration dates?')).toBe('toronto_rec');
    expect(matchRecMorning('how long is the Toronto waitlist?')).toBe('toronto_waitlist');
    expect(matchRecMorning('the wishlist looks frozen is that broken')).toBe('toronto_wishlist');
    expect(matchRecMorning('do I still use eFun for rec?')).toBe('toronto_portal');
    expect(matchRecMorning('is the portal ActiveTO?')).toBe('toronto_portal');
  });

  it('reads YMCA this morning, Brampton swim, two phones, and Jack of Sports', () => {
    expect(matchRecMorning('when does YMCA swim open?')).toBe('ymca_gta_swim');
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

describe('rec-morning SMS · first-time path pins GTM facts (not optional)', () => {
  const firstTimeTexts = [
    'When does Toronto swim registration open?',
    'when is Toronto fall recreation registration?',
  ];

  it('puts 36h waitlist / no queue, frozen wishlist, and eFun-is-gone on Toronto swim AND rec', () => {
    for (const text of firstTimeTexts) {
      pinsFirstClassTorontoFacts(reply(text));
      pinsFirstClassTorontoFacts(intake(text));
      pinsFirstClassTorontoFacts(intake(text, COLD_START_ASK));
    }
  });

  it('gives YMCA this morning My Y at 9:00 a.m. and never ActiveTO or eFun', () => {
    const body = reply('when does YMCA GTA swim registration open?');
    expect(body.toLowerCase()).toContain('today');
    expect(body).toContain('Aug 27');
    expect(body).toMatch(/9:00 a\.m\./);
    expect(body).toContain(YMCA_PORTAL);
    expect(body.toLowerCase()).not.toMatch(/activeto/i);
    expect(body.toLowerCase()).not.toMatch(/efun\.(com|ca)/i);
    expect(body.toLowerCase()).not.toMatch(/\bon efun\b/);
    expect(body.toLowerCase()).not.toMatch(/\buse efun\b/);

    const signed = intake('when does YMCA GTA swim registration open?');
    expect(signed.toLowerCase()).toContain('today');
    expect(signed).toContain(YMCA_PORTAL);
    expect(signed.toLowerCase()).not.toMatch(/activeto/i);
    expect(signed.length).toBeLessThanOrEqual(INTAKE_MAX_REPLY_CHARS);
  });

  it('never sends anyone to eFun, including a parent who asked for it', () => {
    const body = reply('do I log into eFun for Toronto rec?');
    neverSendsToEfun(body);
    expect(body).toContain(TORONTO_REC_PORTAL);
    expect(body.toLowerCase()).not.toMatch(/efun\.(com|ca)/);
  });
});

describe('rec-morning SMS · Toronto clock and portal', () => {
  it('gives Toronto swim the same 7 a.m. as rec, by centre district, not home address', () => {
    const body = reply('When does Toronto swim registration open?');
    expect(body.toLowerCase()).toContain('same 7 a.m.');
    expect(body.toLowerCase()).toContain('district');
    expect(body.toLowerCase()).toContain('not address');
    expect(body.toLowerCase()).not.toMatch(/home address|your street|your postal/);
    expect(body).toContain('Sept 15');
    expect(body).toContain(TORONTO_REC_PORTAL);
    pinsFirstClassTorontoFacts(body);
    expect(body.toLowerCase()).not.toMatch(/\bred cross\b/);
    expect(body.toLowerCase()).not.toMatch(/\botter\b/);
  });

  it('gives Toronto rec the district clocks and Early Local as catchment-only', () => {
    const body = reply('when is Toronto fall recreation registration?');
    expect(body).toContain('Sept 9');
    expect(body.toLowerCase()).toContain('catchment');
    expect(body).toContain('Sept 15');
    expect(body.toLowerCase()).toContain('district');
    expect(body.toLowerCase()).toContain('not address');
    expect(body).toContain(TORONTO_REC_PORTAL);
    pinsFirstClassTorontoFacts(body);
  });
});

describe('rec-morning SMS · waitlist, wishlist, and portal when asked', () => {
  it('says Toronto waitlist is 36 hours, email invitation, no queue number', () => {
    const body = reply('how long is the Toronto rec waitlist? is there a queue number?');
    expect(body).toContain(String(TORONTO_WAITLIST_HOURS));
    expect(body.toLowerCase()).toContain('hours');
    expect(body.toLowerCase()).toContain('email');
    expect(body.toLowerCase()).toContain('invitation');
    expect(body.toLowerCase()).toContain('dropped');
    expect(body.toLowerCase()).toMatch(
      /no queue number|not a queue number|will not show your queue/,
    );
    expect(body.toLowerCase()).not.toContain('24 hour');
  });

  it('says the wish list can look frozen - wait, do not mash refresh or search live at 7:00', () => {
    const body = reply('the wishlist looks frozen, should I keep refreshing?');
    expect(body.toLowerCase()).toContain('frozen');
    expect(body.toLowerCase()).toMatch(/\bwait\b/);
    expect(body.toLowerCase()).toMatch(/mash refresh|don't mash|do not mash|don't keep refresh/);
    expect(body).toMatch(/7:00/);
    expect(body.toLowerCase()).toMatch(/search live/);
  });

  it('says eFun is gone and rec is toronto.ca/OnlineReg - never a destination of eFun', () => {
    const body = reply('do I log into eFun for Toronto rec?');
    neverSendsToEfun(body);
    expect(body).toContain(TORONTO_REC_PORTAL);
    neverSendsToActiveTo(body);
    expect(body.toLowerCase()).toContain('fitnessto');
  });
});

describe('rec-morning SMS · YMCA this morning, Brampton, two phones, Jack of Sports', () => {
  it('says YMCA Greater Toronto swim is today Aug 27 at 9:00 a.m. on My Y', () => {
    const body = reply('when does YMCA GTA swim registration open?');
    expect(body.toLowerCase()).toContain('today');
    expect(body).toContain('Aug 27');
    expect(body).toMatch(/9:00 a\.m\./);
    expect(body).toContain(YMCA_PORTAL);
    expect(body.toLowerCase()).toContain('members and non-residents');
    expect(body.toLowerCase()).toContain('membership');
    expect(body).toContain('Otter');
    expect(body).toContain('Seal');
    expect(body).toContain('Dolphin');
    expect(body).toContain('Star');
    expect(body.toLowerCase()).toMatch(/not ultra/);
    expect(body).toContain('9 and under');
    expect(body.toLowerCase()).toContain('unofficial');
    expect(body.toLowerCase()).not.toMatch(/activeto/i);
  });

  it('does not say today when it is not Aug 27', () => {
    const body = reply('when does YMCA swim open?', NOT_TODAY);
    expect(body.toLowerCase()).not.toContain('today');
    expect(body).toContain('Aug 27');
    expect(body).toMatch(/9:00 a\.m\./);
  });

  it('says Brampton Learn to Swim is Sept 9 7 a.m. residents, 24-hour waitlist, in person', () => {
    const body = reply('is Brampton swim Aug 24?');
    expect(body).toContain('Sept 9');
    expect(body).toContain('7 a.m.');
    expect(body).toContain('Aug 24');
    expect(body).toContain(String(BRAMPTON_WAITLIST_HOURS));
    expect(body.toLowerCase()).toContain('in person');
    expect(body).toContain(String(TORONTO_WAITLIST_HOURS));
  });

  it('keeps two-parent threads unmerged - two phones, two logins', () => {
    const body = reply('can both parents use one login?');
    expect(body.toLowerCase()).toContain('two phones');
    expect(body.toLowerCase()).toContain('two logins');
    expect(body.toLowerCase()).toMatch(/does not merge|doesn't merge|not merge/);
  });

  it('points Jack of Sports at the official page and invents no hours or portal', () => {
    const body = reply('Jack of Sports if city swim is gone?');
    expect(body.toLowerCase()).toContain('backup');
    expect(body).toContain(JACK_OF_SPORTS_PAGE);
    expect(body.toLowerCase()).toContain('unofficial');
    expect(body).not.toMatch(/\d{1,2}:\d{2}/);
    expect(body).not.toMatch(/https?:\/\//i);
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
      'is Brampton swim Aug 24?',
      'can both parents use one login?',
      'Jack of Sports if city swim is gone?',
    ];
    for (const text of texts) {
      const body = intake(text);
      expect(body.endsWith('?'), text).toBe(true);
      expect(body, text).not.toContain(WATCH_OFFER_ASK);
      expect(body.length, text).toBeLessThanOrEqual(INTAKE_MAX_REPLY_CHARS);
      expect(smsEncoding(body), text).toBe('gsm7');
    }

    const swim = intake('When does Toronto swim registration open?');
    pinsFirstClassTorontoFacts(swim);

    const rec = intake('when is Toronto fall recreation registration?', COLD_START_ASK);
    pinsFirstClassTorontoFacts(rec);

    const cold = intake('when does YMCA swim open?', COLD_START_ASK);
    expect(cold.toLowerCase()).toContain('today');
    expect(cold).not.toContain(COLD_START_ASK);
    expect(cold.endsWith('?')).toBe(true);
    expect(cold.length).toBeLessThanOrEqual(INTAKE_MAX_REPLY_CHARS);
  });
});
