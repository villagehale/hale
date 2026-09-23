import { describe, expect, it } from 'vitest';
import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { townLabel } from '~/lib/channel/town-label';
import { REGISTRATION_WINDOWS } from '~/lib/registration/registration-windows-data';
import {
  EFUN_GONE,
  JACK_OF_SPORTS_PAGE,
  type RecHelloCity,
  TORONTO_FOLLOW,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_FIRST,
  YMCA_FOLLOW,
  YMCA_PORTAL,
  cityRecLine,
  matchRecMorning,
  recMorningIntakeReply,
  recMorningReply,
  resolveHelloCity,
} from './index';

/** Same ceiling as intake/answer.ts MAX_REPLY_CHARS — kept local so this spec does not
 * pull the model composer (and @hale/agent) into a copy test. */
const INTAKE_MAX_REPLY_CHARS = 300;

/** 10 a.m. on the morning these lines were re-derived: Brampton's non-resident swim
 * date is still to come, Toronto's non-resident date is still to come, and every
 * other GTA fall cycle has gone. */
const THIS_MORNING = new Date('2026-09-17T14:00:00.000Z');
/** Five days on, past the Sep 21 Brampton morning and nothing else. */
const NEXT_WEEK = new Date('2026-09-22T14:00:00.000Z');

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

/**
 * Every city line as of THIS_MORNING, read off registration-windows-data by hand the
 * way the code reads it: the town, the cycle the TOWN labels, and the dates the town
 * published. These are evidence about the dataset, not strings anyone may edit to
 * taste - a date here that is not in a row for that town is a fabrication.
 */
const TORONTO_LINE =
  'Toronto Fall 2026 registration: residents opened Sep 15, non-residents Friday Sep 25 at 7 a.m. I can watch leftovers and the waitlist. Sign in at toronto.ca/OnlineReg.';

/** Brampton is the one town that runs aquatics on its own calendar, so a rec ask and a
 * swim ask are two different mornings and two different lines. */
const BRAMPTON_REC_LINE =
  'Brampton Fall 2026 registration already opened Aug 24 - the next dates are not posted yet. I can watch leftovers and the waitlist.';

const BRAMPTON_SWIM_LINE =
  'Brampton Fall 2026 (Learn to Swim and Learn to Skate) registration: residents opened Sep 9, non-residents Monday Sep 21 at 7 a.m. I can watch leftovers and the waitlist.';

const CITY_LINES = {
  brampton: BRAMPTON_REC_LINE,
  richmond_hill:
    'Richmond Hill Winter 2026-2027 registration: residents Tuesday Nov 24, non-residents Tuesday Dec 1.',
  halton_hills:
    'Halton Hills Fall 2026 registration already opened Sep 1 - Winter 2027 dates are not posted yet. I can watch leftovers and the waitlist.',
  whitchurch_stouffville:
    'Stouffville Fall 2026 registration already opened Aug 25 - Winter 2027 dates are not posted yet. I can watch leftovers and the waitlist.',
  vaughan:
    'Vaughan Fall Session 2026 registration already opened Aug 18 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  markham:
    'Markham 2026 Fall Programs, Swim Lessons and Winter Break Camps registration already opened Aug 11 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  mississauga:
    'Mississauga Fall 2026 Programs and Winter Camps registration already opened Aug 11 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  pickering:
    'Pickering Fall 2026 registration already opened Aug 20 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  oakville:
    'Oakville Fall 2026 registration already opened Aug 11 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  burlington:
    'Burlington Fall 2026 and Winter 2027 youth programs registration already opened Aug 22 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  caledon:
    'Caledon Fall 2026 registration already opened Aug 19 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  ajax: 'Ajax Fall 2026 registration already opened Aug 18 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  whitby:
    'Whitby Fall 2026 registration already opened Aug 18 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  oshawa:
    'Oshawa Fall 2026 registration already opened Aug 18 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
  newmarket:
    'Newmarket Fall 2026 registration already opened Aug 19 - Winter 2027 dates are not posted yet. I can watch leftovers and the waitlist.',
  east_gwillimbury:
    'East Gwillimbury Fall 2026 registration already opened Aug 20 - Winter 2027 dates are not posted yet. I can watch leftovers and the waitlist.',
  georgina:
    'Georgina Fall 2026 registration already opened Aug 18 - Winter 2027 dates are not posted yet. I can watch leftovers and the waitlist.',
  uxbridge: 'Uxbridge Winter 2027 registration: Tuesday Nov 10 at 9 a.m.',
} as const satisfies Partial<Record<RecHelloCity, string>>;

/**
 * King is out of CITY_LINES because the loop below asks "when does <town> rec open?"
 * and the matcher deliberately does NOT answer to a bare "King" - see the King entry in
 * NAMED_CITIES. Its line is asserted in its own block, against the names a King parent
 * actually types.
 */
const KING_LINE = 'King Winter 2027 rec registration: Monday Dec 7.';

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

describe('rec-morning SMS · the Toronto line, derived', () => {
  it('names the dates the city published, for swim AND rec, and keeps the portal', () => {
    // Read off registration-windows-data: Toronto Fall 2026, residents Sep 15 at
    // 7 a.m. (gone by this morning), non-residents ten days later on Sep 25.
    expect(reply('When does Toronto swim registration open?')).toBe(TORONTO_LINE);
    expect(reply('when is Toronto fall recreation registration?')).toBe(TORONTO_LINE);
    expect(TORONTO_LINE).toContain(TORONTO_REC_PORTAL);
    firstAnswerIsClean(TORONTO_LINE);
    expect(TORONTO_LINE.toLowerCase()).not.toContain('efun');
    expect(intake('When does Toronto swim registration open?')).toBe(
      `${TORONTO_LINE} Still want me watching?`,
    );
    expect(intake('when is Toronto fall recreation registration?', COLD_START_ASK)).toBe(
      `${TORONTO_LINE} ${COLD_START_ASK}`,
    );
  });

  it('says "opened" about a morning that has gone, and never offers it as upcoming', () => {
    // The whole defect (VIL-334, and every town after it): a locked string kept
    // offering Sept 15 as the morning still to come once it was behind us.
    expect(TORONTO_LINE).toContain('residents opened Sep 15');
    expect(TORONTO_LINE).not.toContain('residents Tuesday Sep 15');
    // The day before, the same code offers it as the morning it then was.
    expect(cityRecLine('toronto', new Date('2026-09-14T14:00:00.000Z'))).toContain(
      'residents Tuesday Sep 15 at 7 a.m.',
    );
  });

  it('never names ActiveTO on the first Toronto answer, even if they asked for it', () => {
    const body = reply('is the portal ActiveTO?');
    expect(body).toBe(TORONTO_LINE);
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
  it("names Brampton's own swim morning, the one date in the GTA still to come", () => {
    // Aquatics and skating register 16 days after general rec: residents Sep 9 (gone),
    // non-residents Sep 21. The general rec cycle opened Aug 24 / Sep 7 and is over.
    const body = reply('is Brampton swim Aug 24?');
    expect(body).toBe(BRAMPTON_SWIM_LINE);
    expect(body).toContain('non-residents Monday Sep 21 at 7 a.m.');
    expect(body).toContain('residents opened Sep 9');
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

function mustNotBeTorontoClock(body: string): void {
  expect(body).not.toContain('7:00');
  expect(body).not.toMatch(/Sept?\s*15/i);
  expect(body.toLowerCase()).not.toContain('activeto');
  expect(body.toLowerCase()).not.toContain("i'm an ai");
  expect(body.toLowerCase()).not.toContain('6:32');
  expect(body.toLowerCase()).not.toContain('6:30');
}

describe('rec-morning SMS · a city line is derived, never locked', () => {
  it('answers every covered town with the cycle and dates its own page published', () => {
    for (const [city, line] of Object.entries(CITY_LINES)) {
      const town = townLabel(city);
      expect(reply(`when does ${town} rec open?`), town).toBe(line);
      expect(line, town).toContain(town);
      mustNotBeTorontoClock(line);
      firstAnswerIsClean(line);
      expect(smsEncoding(line), town).toBe('gsm7');
    }
  });

  it('routes Markham by name, by stored city, and by FSA, to the one derived line', () => {
    expect(reply('Markham swim registration?')).toBe(CITY_LINES.markham);
    expect(reply('Markham winter-break camps?')).toBe(CITY_LINES.markham);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L3R' })).toBe(CITY_LINES.markham);
    expect(reply('when is fall rec?', THIS_MORNING, { city: 'Markham' })).toBe(CITY_LINES.markham);
    expect(reply('L3R rec dates?')).toBe(CITY_LINES.markham);
    expect(intake('Markham fall rec dates?')).toBe(`${CITY_LINES.markham} Still want me watching?`);
  });

  it('names the cycle Hale is waiting on where there is one, and "the next" where there is not', () => {
    // discovery-targets watches Halton Hills and Stouffville for Winter 2027; nobody
    // is watching a Vaughan or Markham winter, so no season is named for them.
    expect(CITY_LINES.halton_hills).toContain('Winter 2027 dates are not posted yet');
    expect(CITY_LINES.whitchurch_stouffville).toContain('Winter 2027 dates are not posted yet');
    expect(CITY_LINES.vaughan).toContain('the next dates are not posted yet');
    expect(CITY_LINES.markham).toContain('the next dates are not posted yet');
  });

  it('drops the Vaughan November dates that were in no row at all', () => {
    // The locked line claimed "winter swim Nov 17 residents / Nov 24 non-residents";
    // Vaughan has only a Fall Session 2026, opened Aug 18 and Aug 20.
    const body = reply('Vaughan winter swim?');
    expect(body).toBe(CITY_LINES.vaughan);
    expect(body).not.toMatch(/Nov/);
    expect(body).toContain('already opened Aug 18');
  });

  it('calls Whitchurch-Stouffville what the town calls itself', () => {
    const body = reply('Stouffville swim?');
    expect(body).toBe(CITY_LINES.whitchurch_stouffville);
    expect(body).toContain('Stouffville');
    expect(body).not.toContain('Whitchurch');
  });

  it('answers King by village, never by the bare word "king"', () => {
    // "King" alone is King Street, King West and the king. The villages are the way in
    // precisely because their L0G postal code resolves to nothing.
    expect(reply('King City rec registration?')).toBe(KING_LINE);
    expect(reply('Nobleton swim lessons?')).toBe(KING_LINE);
    expect(reply('Schomberg rec dates?')).toBe(KING_LINE);
    expect(recMorningReply('swim lessons near King and Spadina?', THIS_MORNING)).toBeNull();
    expect(recMorningReply('any rec on King West?', THIS_MORNING)).toBeNull();
    expect(smsEncoding(KING_LINE)).toBe('gsm7');
    firstAnswerIsClean(KING_LINE);
    // No clock, because King published none: a borrowed "7 a.m." would be seven hours
    // wrong. And rec, not swim - both ride the label "Winter 2027" on different dates.
    expect(KING_LINE).not.toMatch(/a\.m\.|p\.m\./);
    expect(KING_LINE).toContain('rec registration');
  });

  it('does not answer a neighbouring town, or a person, as one of the five', () => {
    // Bradford WEST Gwillimbury is not East Gwillimbury, Sutton is a surname before it
    // is a village, and Sharon is a name before it is East Gwillimbury's village.
    expect(recMorningReply('Bradford West Gwillimbury rec dates?', THIS_MORNING)).toBeNull();
    expect(recMorningReply('can Sutton take him to swim?', THIS_MORNING)).toBeNull();
    expect(recMorningReply('Sharon is doing swim pickup, when is rec?', THIS_MORNING)).toBeNull();
    // The positive control: the qualified village names DO answer.
    expect(reply('Sutton West rec?')).toBe(CITY_LINES.georgina);
    expect(reply('East Gwillimbury rec?')).toBe(CITY_LINES.east_gwillimbury);
  });

  it('routes each new town by its own FSA, and the rural codes to nothing', () => {
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L3X' })).toBe(CITY_LINES.newmarket);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L3Y' })).toBe(CITY_LINES.newmarket);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L7B' })).toBe(KING_LINE);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L9N' })).toBe(
      CITY_LINES.east_gwillimbury,
    );
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L4P' })).toBe(CITY_LINES.georgina);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'L9P' })).toBe(CITY_LINES.uxbridge);
    // The coverage hole, named out loud: a Nobleton, Sharon or Sutton postal code is a
    // rural aggregate spanning uncovered towns, so it resolves to nothing.
    for (const rural of ['L0G', 'L0E', 'L0C']) {
      expect(recMorningReply('when is fall rec?', THIS_MORNING, { postal: rural })).toBeNull();
    }
  });

  it('flips a town to between-cycles the moment its last morning goes by', () => {
    expect(reply('Brampton skate lessons?', NEXT_WEEK)).toBe(
      'Brampton Fall 2026 (Learn to Swim and Learn to Skate) registration already opened Sep 9 - the next dates are not posted yet. I can watch leftovers and the waitlist.',
    );
    expect(reply('Brampton skate lessons?', NEXT_WEEK)).not.toContain('Sep 21');
    // Right up to the morning itself it is still the date to act on.
    expect(reply('Brampton skate lessons?', new Date('2026-09-21T10:59:00.000Z'))).toBe(
      BRAMPTON_SWIM_LINE,
    );
  });

  it('splits exactly what Brampton splits, by name and by FSA alike', () => {
    expect(reply('when does Brampton rec open?')).toBe(BRAMPTON_REC_LINE);
    expect(reply('Brampton skate lessons?')).toBe(BRAMPTON_SWIM_LINE);
    expect(reply('when is rec?', THIS_MORNING, { postal: 'L6T' })).toBe(BRAMPTON_REC_LINE);
    expect(reply('when is swim?', THIS_MORNING, { postal: 'L6T' })).toBe(BRAMPTON_SWIM_LINE);
    // Toronto registers swim inside the seasonal cycle, so there is nothing to split.
    expect(reply('when is Toronto rec?')).toBe(reply('When does Toronto swim registration open?'));
  });

  it('keeps Toronto and YMCA answers when they asked Toronto or YMCA', () => {
    expect(reply('When does Toronto swim registration open?')).toBe(TORONTO_LINE);
    expect(reply('when is Toronto rec?', THIS_MORNING, { postal: 'L3R' })).toBe(TORONTO_LINE);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'M5V' })).toBe(TORONTO_LINE);
    expect(reply('when does YMCA swim open?', THIS_MORNING, { postal: 'L3R' })).toBe(YMCA_FIRST);
    expect(YMCA_FIRST.toLowerCase()).not.toContain('today');
  });

  it('VIL-334: M1B (Scarborough) is a Toronto FSA and gets the Scarborough morning', () => {
    // VIL-360. Scarborough registered Wednesday Sep 16; downtown (M5V) and
    // Etobicoke (M8V) stayed on Tuesday Sep 15. A postal in the ask is enough.
    const scarborough =
      'Toronto Fall 2026 registration: residents opened Sep 16, non-residents Saturday Sep 26 at 7 a.m. I can watch leftovers and the waitlist. Sign in at toronto.ca/OnlineReg.';
    expect(resolveHelloCity('M1B')).toBe('toronto');
    expect(resolveHelloCity('Theo is 3, Cruz is 18-months, M1B')).toBe('toronto');
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'M1B' })).toBe(scarborough);
    expect(reply('M1B rec dates?')).toBe(scarborough);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'M5V' })).toBe(TORONTO_LINE);
    expect(reply('when is fall rec?', THIS_MORNING, { postal: 'M8V' })).toBe(TORONTO_LINE);
    const dayBefore = new Date('2026-09-14T14:00:00.000Z');
    const northYork = cityRecLine('toronto', dayBefore, 'rec_program', undefined, 'M2N');
    expect(northYork).toContain('Wednesday Sep 16');
    expect(northYork).not.toContain('Sep 15');
    expect(reply('Halton Hills rec registration?')).toBe(CITY_LINES.halton_hills);
    expect(reply('when does Brampton rec open?')).toBe(CITY_LINES.brampton);
  });

  it('does not invent a clock when the city is unknown', () => {
    expect(recMorningReply('when is fall rec?')).toBeNull();
    expect(recMorningReply('when is fall rec?', THIS_MORNING, { postal: 'L4G' })).toBeNull();
    expect(recMorningReply('Aurora rec dates?')).toBeNull();
    expect(recMorningReply('when is rec?', THIS_MORNING, { postal: 'L3T' })).toBeNull();
    expect(recMorningReply('when is rec?', THIS_MORNING, { postal: 'H2X' })).toBeNull();
  });

  it('says nothing about a town the dataset has no window for', () => {
    // Milton is a town the matcher can name and the dataset has never held a date
    // for. The locked copy told a Milton parent their fall rec "already opened" and
    // their winter "isn't posted" - two claims with no row behind either.
    expect(matchRecMorning('when does Milton rec open?')).toBe('milton');
    expect(cityRecLine('milton', THIS_MORNING)).toBeNull();
    expect(recMorningReply('when does Milton rec open?', THIS_MORNING)).toBeNull();
    // The positive control: the same ask for a town that IS in the dataset answers.
    expect(recMorningReply('when does Oakville rec open?', THIS_MORNING)).toBe(CITY_LINES.oakville);
  });

  it('lets a named city win over a stored postal', () => {
    expect(reply('Markham rec?', THIS_MORNING, { postal: 'M5V' })).toBe(CITY_LINES.markham);
    expect(reply('Toronto rec?', THIS_MORNING, { postal: 'L3R' })).toBe(TORONTO_LINE);
  });
});

describe('rec-morning SMS · the program the parent actually named', () => {
  it("answers a Brampton rec ask about Brampton's rec cycle, not its swim morning", () => {
    // Brampton runs aquatics on a calendar of its own, sixteen days behind general
    // rec. Answering "when does Brampton rec open?" with the Learn to Swim morning
    // answers a question nobody asked, and leaves the rec parent - whose cycle is
    // over - with no offer at all.
    const body = reply('when does Brampton rec open?');
    expect(body).toBe(BRAMPTON_REC_LINE);
    expect(body).not.toContain('Learn to Swim');
    expect(body).not.toContain('Sep 21');
    expect(reply('Brampton skate lessons?')).toBe(BRAMPTON_SWIM_LINE);
  });

  it('names the program only where the town gives two cycles the same name', () => {
    // Vaughan runs a "Fall Session 2026" for rec and another for swim, two days
    // apart: the label alone does not say which morning this is. Every Richmond Hill
    // and Mississauga label is already unique, so a noun after it says nothing.
    expect(cityRecLine('vaughan', new Date('2026-08-19T14:00:00.000Z'))).toBe(
      'Vaughan Fall Session 2026 swim registration: residents Thursday Aug 20 at 7 a.m., non-residents Thursday Aug 27 at 7 a.m.',
    );
    expect(CITY_LINES.richmond_hill).toBe(
      'Richmond Hill Winter 2026-2027 registration: residents Tuesday Nov 24, non-residents Tuesday Dec 1.',
    );
    expect(cityRecLine('mississauga', new Date('2026-08-15T14:00:00.000Z'))).toContain(
      'Mississauga Fall 2026 Programs and Winter Camps registration:',
    );
  });

  it('falls back to the town when the program a parent named has no row at all', () => {
    // A domain the dataset has nothing in is not a town the dataset has nothing for:
    // Brampton still has a rec cycle to talk about, and null here would say it did not.
    const swimless = REGISTRATION_WINDOWS.filter(
      (seed) => !(seed.municipality === 'brampton' && seed.programDomain === 'swim'),
    );
    expect(cityRecLine('brampton', THIS_MORNING, 'swim', swimless)).toBe(BRAMPTON_REC_LINE);
  });

  it('offers leftovers to the parent whose own morning has already gone', () => {
    // A Toronto resident reading this on Sep 17 missed Sep 15, and Sep 25 is not their
    // date. Without the offer the line holds nothing they can act on.
    expect(TORONTO_LINE).toContain('residents opened Sep 15');
    expect(TORONTO_LINE).toContain('I can watch leftovers and the waitlist.');
    // Nobody has missed a Richmond Hill morning yet, so there is nothing to leave over.
    expect(CITY_LINES.richmond_hill).not.toContain('leftovers');
  });
});

const ALL_HELLO_CITIES: readonly RecHelloCity[] = [
  'newmarket',
  'king',
  'east_gwillimbury',
  'georgina',
  'uxbridge',
  'toronto',
  'markham',
  'vaughan',
  'richmond_hill',
  'mississauga',
  'oakville',
  'burlington',
  'halton_hills',
  'brampton',
  'caledon',
  'ajax',
  'pickering',
  'whitby',
  'oshawa',
  'whitchurch_stouffville',
  'milton',
];

const MONTH_DAY_TOKEN = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\s+\d{1,2}\b/g;

const TORONTO_DAY = new Intl.DateTimeFormat('en-CA', {
  month: 'short',
  day: 'numeric',
  timeZone: 'America/Toronto',
});

/** Every instant the dataset can change an answer at - a minute either side of every
 * published date. A line only moves at one of these, so this is the whole state space,
 * not a sample of it. */
function boundaryInstants(): Date[] {
  const instants: Date[] = [];
  for (const seed of REGISTRATION_WINDOWS) {
    for (const iso of [seed.residentOpenAt, seed.openAt]) {
      if (iso === null) continue;
      const at = new Date(iso).getTime();
      instants.push(new Date(at - 60_000), new Date(at + 60_000));
    }
  }
  return instants;
}

/** Every line this town can produce: the whole-town ask, and the narrowed one a parent
 * who named a program gets (Toronto's and Brampton's topics both name a domain). */
function linesFor(city: RecHelloCity, now: Date): (string | null)[] {
  return [
    cityRecLine(city, now),
    cityRecLine(city, now, 'rec_program'),
    cityRecLine(city, now, 'swim'),
    cityRecLine(city, now, 'camp'),
  ];
}

/** The month-days this town actually published - the only ones it may be told. */
function publishedDays(city: RecHelloCity): Set<string> {
  const days = new Set<string>();
  for (const seed of REGISTRATION_WINDOWS) {
    if (seed.municipality !== city) continue;
    for (const iso of [seed.residentOpenAt, seed.openAt]) {
      if (iso !== null) days.add(TORONTO_DAY.format(new Date(iso)));
    }
  }
  return days;
}

describe('rec-morning SMS · what a derived line may never do', () => {
  it('enrols every town the dataset holds dates for in the checks below', () => {
    // The property tests below walk ALL_HELLO_CITIES, which is hand-kept: a town added
    // to the dataset and forgotten here is a town whose line nothing checks, and these
    // absence tests would pass by never looking at it.
    const seeded = new Set(REGISTRATION_WINDOWS.map((seed) => seed.municipality));
    // Aurora is the one seeded town resolveHelloCity refuses (its line is not written).
    seeded.delete('aurora');
    const missing = [...seeded].filter(
      (town) => !ALL_HELLO_CITIES.includes(town as RecHelloCity),
    );
    expect(missing).toEqual([]);
  });

  it('never names a date that town did not publish, at any boundary the dataset has', () => {
    const instants = boundaryInstants();
    expect(instants.length).toBeGreaterThan(40);
    for (const city of ALL_HELLO_CITIES) {
      const allowed = publishedDays(city);
      for (const now of instants) {
        for (const line of linesFor(city, now)) {
          if (line === null) {
            expect(allowed.size, city).toBe(0);
            continue;
          }
          const named = line.match(MONTH_DAY_TOKEN) ?? [];
          expect(named.length, `${city} @ ${now.toISOString()}: ${line}`).toBeGreaterThan(0);
          for (const day of named) {
            expect(allowed.has(day), `${city} @ ${now.toISOString()} named ${day}: ${line}`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it('stays GSM-7, inside two segments, and inside the intake cap, at every boundary', () => {
    for (const city of ALL_HELLO_CITIES) {
      for (const now of boundaryInstants()) {
        for (const line of linesFor(city, now)) {
          if (line === null) continue;
          const where = `${city} @ ${now.toISOString()}: ${line}`;
          expect(smsEncoding(line), where).toBe('gsm7');
          expect(smsSegments(line), where).toBeLessThanOrEqual(2);
          expect(line, where).toContain(townLabel(city));
          // The intake reply appends Hale's longest outstanding ask and THROWS over cap.
          expect(`${line} ${COLD_START_ASK}`.length, where).toBeLessThanOrEqual(
            INTAKE_MAX_REPLY_CHARS,
          );
        }
      }
    }
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
      `${TORONTO_LINE} Still want me watching?`,
    );
    expect(intake('when does YMCA swim open?', COLD_START_ASK)).toBe(
      `${YMCA_FIRST} ${COLD_START_ASK}`,
    );
  });
});
