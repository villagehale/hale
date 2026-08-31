import { describe, expect, it } from 'vitest';
import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import {
  BRAMPTON_REC,
  BRAMPTON_SWIM_SKATE,
  EFUN_GONE,
  JACK_OF_SPORTS_PAGE,
  MARKHAM_FIRST,
  TORONTO_FIRST_REC,
  TORONTO_FOLLOW,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_FIRST,
  YMCA_FOLLOW,
  YMCA_PORTAL,
  leftoverRecHello,
  matchRecMorning,
  recMorningIntakeReply,
  recMorningReply,
  resolveHelloCity,
  torontoPinForPostal,
} from './index';

/** Same ceiling as intake/answer.ts MAX_REPLY_CHARS — kept local so this spec does not
 * pull the model composer (and @hale/agent) into a copy test. */
const INTAKE_MAX_REPLY_CHARS = 300;

const THIS_MORNING = new Date('2026-08-27T12:30:00-04:00');

function reply(
  text: string,
  now: Date = THIS_MORNING,
  where?: { city?: string | null; postal?: string | null },
): string {
  const body = recMorningReply(text, now, where);
  if (body === null) throw new Error(`expected a rec-morning reply for: ${text}`);
  return body;
}

function intake(
  parentWords: string,
  pendingAsk = WATCH_OFFER_ASK,
  where?: { postal?: string | null; city?: string | null },
): string {
  const body = recMorningIntakeReply({
    parentWords,
    pendingAsk,
    now: THIS_MORNING,
    postal: where?.postal,
    city: where?.city,
  });
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
    expect(matchRecMorning('when does Brampton rec open?')).toBe('brampton_rec');
    expect(matchRecMorning('Markham fall rec dates?')).toBe('markham');
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
    expect(YMCA_FIRST).toBe('YMCA GTA swim opened Aug 27 at 9:00 a.m. Sign in at MyY.YMCAGTA.ORG.');
    expect(YMCA_FIRST.toLowerCase()).not.toContain('today');
    expect(reply('when does YMCA GTA swim registration open?')).toBe(YMCA_FIRST);
    expect(YMCA_FIRST).toContain(YMCA_PORTAL);
    firstAnswerIsClean(YMCA_FIRST);
    expect(YMCA_FIRST.toLowerCase()).not.toContain('efun');
    expect(YMCA_FOLLOW).toBe(
      'Search Otter, Seal, Dolphin, Star, not Ultra. Membership is still needed for a lot of group classes, and kids 9 and under need an adult 16+ on deck.',
    );
    expect(YMCA_FOLLOW.toLowerCase()).not.toContain('today');
    expect(reply('YMCA otter or Ultra?')).toBe(YMCA_FOLLOW);
    expect(reply('does YMCA need membership?')).toBe(YMCA_FOLLOW);
    expect(reply('when does YMCA swim open?')).not.toBe(YMCA_FOLLOW);
    firstAnswerIsClean(YMCA_FOLLOW);
  });
});

describe('rec-morning SMS · Brampton and Jack of Sports when asked', () => {
  it('sends the locked Brampton swim/skate line, not the rec leftover', () => {
    expect(BRAMPTON_SWIM_SKATE).toBe(
      'Brampton swim and skate, residents Wednesday Sep 9 at 7 a.m. Non-residents Monday Sep 21 at 7 a.m. You prove residency in person.',
    );
    const body = reply('is Brampton swim Aug 24?');
    expect(body).toBe(BRAMPTON_SWIM_SKATE);
    expect(body).not.toBe(BRAMPTON_REC);
    firstAnswerIsClean(body);
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

const LEFTOVER_CITIES = [
  'Mississauga',
  'Caledon',
  'Oakville',
  'Burlington',
  'Milton',
  'Ajax',
  'Whitby',
  'Oshawa',
] as const;

const DATED_HELLOS = {
  'Halton Hills': 'Halton Hills taxpayers Tuesday Sep 1 at 7 a.m. Non-taxpayers a week later.',
  Pickering:
    "Pickering non-resident aquatics Wednesday Sep 3 at 7 a.m. I won't guess the resident morning.",
  'Richmond Hill':
    'Richmond Hill non-residents Tuesday Sep 1. Winter residents Nov 24, non-residents Dec 1.',
  Vaughan:
    'Vaughan winter swim Nov 17 residents / Nov 24 non-residents, 7 a.m. General winter Nov 19 / 26 at 7 a.m.',
} as const;

function mustNotBeTorontoClock(body: string): void {
  expect(body).not.toContain('7:00');
  expect(body).not.toMatch(/Sept?\s*15/i);
  expect(body.toLowerCase()).not.toContain('activeto');
  expect(body.toLowerCase()).not.toContain("i'm an ai");
  expect(body.toLowerCase()).not.toContain('6:32');
  expect(body.toLowerCase()).not.toContain('6:30');
}

describe('rec-morning SMS · VIL-320 city-switched first-hello', () => {
  it('pins the Markham leftover string verbatim and never a Toronto clock', () => {
    expect(MARKHAM_FIRST).toBe(
      "Markham fall rec, swim, and winter-break camps already opened Aug 11. Winter isn't posted. I can watch leftovers and the waitlist.",
    );
    expect(reply('when does Markham rec open?')).toBe(MARKHAM_FIRST);
    expect(reply('Markham swim registration?')).toBe(MARKHAM_FIRST);
    expect(reply('Markham winter-break camps?')).toBe(MARKHAM_FIRST);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L3R' })).toBe(MARKHAM_FIRST);
    expect(reply('when is fall rec?', THIS_MORNING, { city: 'Markham' })).toBe(MARKHAM_FIRST);
    expect(reply('L3R rec dates?')).toBe(MARKHAM_FIRST);
    mustNotBeTorontoClock(MARKHAM_FIRST);
    expect(MARKHAM_FIRST.toLowerCase()).not.toContain('winter is next');
    firstAnswerIsClean(MARKHAM_FIRST);
    expect(intake('Markham fall rec dates?')).toBe(`${MARKHAM_FIRST} Still want me watching?`);
    expect(intake('when is fall rec?', WATCH_OFFER_ASK, { postal: 'L3R' })).toBe(
      `${MARKHAM_FIRST} Still want me watching?`,
    );
  });

  it('pins leftover/waitlist hellos with the city name only', () => {
    for (const city of LEFTOVER_CITIES) {
      const locked = leftoverRecHello(city);
      expect(locked).toBe(
        `${city} fall rec already opened. Winter isn't posted. I can watch leftovers and the waitlist.`,
      );
      expect(reply(`when does ${city} rec open?`)).toBe(locked);
      mustNotBeTorontoClock(locked);
      firstAnswerIsClean(locked);
      expect(smsEncoding(locked)).toBe('gsm7');
    }
    expect(reply('Mississauga fall rec?')).toBe(
      "Mississauga fall rec already opened. Winter isn't posted. I can watch leftovers and the waitlist.",
    );
  });

  it('pins the dated city hellos verbatim', () => {
    expect(reply('Halton Hills rec registration?')).toBe(DATED_HELLOS['Halton Hills']);
    expect(reply('when is Pickering swim?')).toBe(DATED_HELLOS.Pickering);
    expect(reply('Richmond Hill fall rec?')).toBe(DATED_HELLOS['Richmond Hill']);
    expect(reply('Vaughan winter swim?')).toBe(DATED_HELLOS.Vaughan);
    for (const body of Object.values(DATED_HELLOS)) {
      mustNotBeTorontoClock(body);
      firstAnswerIsClean(body);
      expect(smsEncoding(body)).toBe('gsm7');
    }
  });

  it('splits Brampton rec from swim/skate', () => {
    expect(BRAMPTON_REC).toBe(
      "Brampton rec is open for residents. Non-residents Monday Sep 7 at 7 a.m. Winter isn't posted.",
    );
    expect(reply('when does Brampton rec open?')).toBe(BRAMPTON_REC);
    expect(reply('Brampton skate lessons?')).toBe(BRAMPTON_SWIM_SKATE);
    expect(reply('when is rec?', THIS_MORNING, { postal: 'L6T' })).toBe(BRAMPTON_REC);
    expect(reply('when is swim?', THIS_MORNING, { postal: 'L6T' })).toBe(BRAMPTON_SWIM_SKATE);
    expect(BRAMPTON_REC).not.toBe(BRAMPTON_SWIM_SKATE);
    mustNotBeTorontoClock(BRAMPTON_REC);
    firstAnswerIsClean(BRAMPTON_REC);
  });

  it('keeps Toronto and YMCA locks when they asked Toronto or YMCA', () => {
    expect(reply('When does Toronto swim registration open?')).toBe(TORONTO_FIRST_REC);
    expect(reply('when is Toronto rec?', THIS_MORNING, { postal: 'L3R' })).toBe(TORONTO_FIRST_REC);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'M5V' })).toBe(TORONTO_FIRST_REC);
    expect(reply('when does YMCA swim open?', THIS_MORNING, { postal: 'L3R' })).toBe(YMCA_FIRST);
    expect(YMCA_FIRST.toLowerCase()).not.toContain('today');
  });

  it('VIL-334: M1B (Scarborough) is a Toronto FSA and pins the locked first-hello', () => {
    expect(resolveHelloCity('M1B')).toBe('toronto');
    expect(resolveHelloCity('Theo is 3, Cruz is 18-months, M1B')).toBe('toronto');
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'M1B' })).toBe(TORONTO_FIRST_REC);
    expect(reply('M1B rec dates?')).toBe(TORONTO_FIRST_REC);
    expect(torontoPinForPostal('M1B')).toBe(TORONTO_FIRST_REC);
    expect(torontoPinForPostal('M5V')).toBe(TORONTO_FIRST_REC);
    expect(torontoPinForPostal('m1b 0a1')).toBe(TORONTO_FIRST_REC);
    // Unpinned / other-city FSAs keep their own rec-morning pins. This helper is
    // the empty-lookup fallback, not a rewrite of Halton Hills 555 or Brampton.
    expect(torontoPinForPostal('L7G')).toBeNull();
    expect(torontoPinForPostal('L6T')).toBeNull();
    expect(torontoPinForPostal('L3R')).toBeNull();
    expect(torontoPinForPostal(null)).toBeNull();
    expect(reply('Halton Hills rec registration?')).toBe(DATED_HELLOS['Halton Hills']);
    expect(reply('when does Brampton rec open?')).toBe(BRAMPTON_REC);
  });

  it('does not invent a clock when the city is unknown', () => {
    expect(recMorningReply('when is fall rec?')).toBeNull();
    expect(recMorningReply('when is fall rec?', THIS_MORNING, { postal: 'L4G' })).toBeNull();
    expect(recMorningReply('Aurora rec dates?')).toBeNull();
    expect(recMorningReply('when is rec?', THIS_MORNING, { postal: 'L3T' })).toBeNull();
    expect(recMorningReply('when is rec?', THIS_MORNING, { postal: 'H2X' })).toBeNull();
  });

  it('lets a named city win over a stored postal', () => {
    expect(reply('Markham rec?', THIS_MORNING, { postal: 'M5V' })).toBe(MARKHAM_FIRST);
    expect(reply('Toronto rec?', THIS_MORNING, { postal: 'L3R' })).toBe(TORONTO_FIRST_REC);
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
      'when does Brampton rec open?',
      'Markham fall rec dates?',
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
      'when does Brampton rec open?',
      'Markham fall rec dates?',
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
