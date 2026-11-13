import { timezoneForIntakePostal } from '~/lib/channel/intake/postal-zone';
import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';
import { localDate } from '~/lib/memory/workstream-time';
import { cityRecLine, districtPostal } from './city-line';
import {
  JACK_OF_SPORTS_PAGE,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_PORTAL,
  YMCA_SWIM_OPENS,
} from './facts';
import type { RecMorningTopic, RecMorningWhere } from './match';
import {
  matchRecMorning,
  postalMentioned,
  recMorningAsksOwnTown,
  resolveRecMorningWhere,
} from './match';
import { type RecMorningReader, sharedRecMorningReader } from './read';

/**
 * VIL-308 rec-morning FACTS. VIL-508 (absolute zero fixed copy): nothing in this file is
 * sent. Each topic resolves to the reviewed facts (portal, clock, waitlist mechanics), and
 * the model writes the parent's text from them ({@link writeRecMorningReply}); a miss
 * sends nothing from this lane.
 *
 * What is NOT here any more: a city's clock. Every dated city hello rotted in place
 * (VIL-334, and then the whole GTA set a cycle later), so a town's line is DERIVED
 * from the verified registration dataset and `now` in {@link cityRecLine}. This file
 * keeps the facts that outlive a cycle — the portals, the waitlist mechanics — and
 * hands the dates to the dataset. The one date it still holds, the Y's opening morning,
 * is data that stops being handed out once that day has passed ({@link ymcaSwimFact}).
 *
 * One link, no ladder on the first Toronto rec/swim answer. Follow only
 * if they need waitlist/wishlist/two phones. eFun named only if they said eFun. YMCA
 * follow only for levels or membership. Jack of Sports only if they ask. Never ActiveTO
 * (even to negate it), never "I'm an AI", never unofficial, never an app URL.
 *
 * Facts stay aligned with the constants in facts.ts and the verified registration
 * dataset that city-line.ts reads. This file is the SMS voice, not a city-page
 * paraphrase.
 */

export const TORONTO_FOLLOW = `Wishlist can look frozen, so wait, don't mash refresh. Waitlist email takes about ${TORONTO_WAITLIST_HOURS} hours and there's no queue number. Two parents means two phones.`;

export const EFUN_GONE = `eFun is gone. Rec is ${TORONTO_REC_PORTAL} now.`;

/** A calendar date as the Y published it; no zone, so it is read in UTC as a bare date. */
const PUBLISHED_DATE = new Intl.DateTimeFormat('en-CA', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The Y's opening morning, while it is still on or after the family's own today. Once
 * the day has passed it is not a fact about anything a parent can do, so there is none
 * and the coach answers (it can look the next session up). No zone known: Hale cannot
 * tell the day is still ahead, so it does not say it is.
 */
function ymcaSwimFact(now: Date, timeZone: string | null): string | null {
  if (timeZone === null || localDate(now, timeZone) > YMCA_SWIM_OPENS.date) return null;
  const day = PUBLISHED_DATE.format(new Date(`${YMCA_SWIM_OPENS.date}T00:00:00Z`));
  return `YMCA GTA swim registration opens ${day} at ${YMCA_SWIM_OPENS.clock} Sign in at ${YMCA_PORTAL}.`;
}

export const YMCA_FOLLOW =
  'Search Otter, Seal, Dolphin, Star, not Ultra. Membership is still needed for a lot of group classes, and kids 9 and under need an adult 16+ on deck.';

const JACK_OF_SPORTS = `Jack of Sports is a swim backup if the city or YMCA lane is gone. Confirm hours and how to register on ${JACK_OF_SPORTS_PAGE} rather than from me.`;

/**
 * The topic a parent asked about, answered as of `now`. A city topic reads the
 * dataset, the Y's opening morning reads the family's today; everything else is a
 * reviewed constant that no calendar can age.
 */
type RecMorningLine = (
  now: Date,
  where: RecMorningWhere,
  askedPostal: string | null,
) => string | null;

export const REC_MORNING_FACTS: Record<RecMorningTopic, RecMorningLine> = {
  toronto_swim: (now, where, asked) =>
    cityRecLine('toronto', now, 'swim', undefined, districtPostal('toronto', asked, where.postal)),
  toronto_rec: (now, where, asked) =>
    cityRecLine(
      'toronto',
      now,
      'rec_program',
      undefined,
      districtPostal('toronto', asked, where.postal),
    ),
  toronto_waitlist: () => TORONTO_FOLLOW,
  toronto_wishlist: () => TORONTO_FOLLOW,
  toronto_efun: () => EFUN_GONE,
  ymca_gta_swim: (now, where) => ymcaSwimFact(now, where.timeZone),
  ymca_follow: () => YMCA_FOLLOW,
  brampton_swim: (now) => cityRecLine('brampton', now, 'swim'),
  brampton_rec: (now) => cityRecLine('brampton', now, 'rec_program'),
  markham: (now) => cityRecLine('markham', now),
  mississauga: (now) => cityRecLine('mississauga', now),
  caledon: (now) => cityRecLine('caledon', now),
  oakville: (now) => cityRecLine('oakville', now),
  burlington: (now) => cityRecLine('burlington', now),
  milton: (now) => cityRecLine('milton', now),
  ajax: (now) => cityRecLine('ajax', now),
  whitby: (now) => cityRecLine('whitby', now),
  oshawa: (now) => cityRecLine('oshawa', now),
  whitchurch_stouffville: (now) => cityRecLine('whitchurch_stouffville', now),
  newmarket: (now) => cityRecLine('newmarket', now),
  king: (now) => cityRecLine('king', now),
  east_gwillimbury: (now) => cityRecLine('east_gwillimbury', now),
  georgina: (now) => cityRecLine('georgina', now),
  uxbridge: (now) => cityRecLine('uxbridge', now),
  halton_hills: (now) => cityRecLine('halton_hills', now),
  pickering: (now) => cityRecLine('pickering', now),
  richmond_hill: (now) => cityRecLine('richmond_hill', now),
  vaughan: (now) => cityRecLine('vaughan', now),
  two_parents: () => TORONTO_FOLLOW,
  jack_of_sports: () => JACK_OF_SPORTS,
};

export function recMorningBody(
  topic: RecMorningTopic,
  now: Date,
  where: RecMorningWhere,
  askedPostal: string | null,
): string | null {
  return REC_MORNING_FACTS[topic](now, where, askedPostal);
}

/**
 * The C1 / post-intake body. Null when the family has no GTA place on file (VIL-591),
 * when this text is not a rec-morning question, and when it names a town the dataset
 * holds no window for — Hale says nothing rather than describe a season it has no
 * record of.
 */
export function recMorningReply(
  body: string,
  now: Date,
  where: RecMorningWhere | null,
): string | null {
  if (where === null) return null;
  const topic = matchRecMorning(body, where);
  if (topic === null) return null;
  return recMorningBody(topic, now, where, postalMentioned(body));
}

export function recMorningReturnLine(pendingAsk: string): string {
  // #868: the fixed watch / cold-start asks are gone as pending-ask text.
  void pendingAsk;
  return '';
}

/**
 * Mid-signup there is no family row, so the postal the parent texted is the whole place:
 * no stored city or country, and the zone is the one intake derives for the parent from
 * this same postal (intake/derive.ts). No postal, no place.
 */
function intakeWhere(input: { postal?: string | null }): RecMorningWhere | null {
  const postal = input.postal ?? null;
  const fsa = postal === null ? null : postal.replace(/\s+/g, '').toUpperCase().slice(0, 3);
  return resolveRecMorningWhere({
    city: null,
    postal,
    country: null,
    province: null,
    timeZone: fsa === null ? null : timezoneForIntakePostal('CA', fsa),
  });
}

/** Mid-signup, the parent asks for the dates of the town their postal code is in. */
export function recMorningIntakeAsksOwnTown(input: {
  parentWords: string;
  postal?: string | null;
}): boolean {
  return recMorningAsksOwnTown(input.parentWords, intakeWhere(input));
}

/**
 * Mid-signup: the rec-morning answer plus Hale's outstanding ask. Null when the parent's text was not a
 * rec-morning question.
 */
export function recMorningIntakeReply(input: {
  parentWords: string;
  pendingAsk: string;
  now?: Date;
  postal?: string | null;
}): string | null {
  const sms = recMorningReply(input.parentWords, input.now ?? new Date(), intakeWhere(input));
  if (sms === null) return null;
  const joined = [sms, recMorningReturnLine(input.pendingAsk)]
    .filter((part) => part.length > 0)
    .join(' ');
  return joined;
}

const URL_IN_FACTS =
  /\b(?:https?:\/\/|www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ca|com|org|net)(?:\/[^\s]*)?/gi;

/** Portals and pages in the facts must reach the parent byte for byte. */
function verbatimFrom(facts: string): string[] {
  return [...facts.matchAll(URL_IN_FACTS)].map((m) => m[0].replace(/[.,]+$/, ''));
}

/**
 * VIL-508: the parent's rec-morning text, written by the model from the topic's facts.
 * Null when the family has no GTA place, when this is not a rec-morning question, when
 * the dataset holds no window, or when the model wrote nothing usable — the caller sends
 * nothing from this lane.
 *
 * VIL-545: the word test only picks the facts. The model reads whether they answer the
 * text ({@link RecMorningReader}); any other reading, or a failed read, sends nothing
 * from this lane and the coach answers the turn.
 */
export async function writeRecMorningReply(
  body: string,
  now: Date,
  where: RecMorningWhere | null,
  language: ReplyLanguage | null = null,
  write: typeof speak = speak,
  read: RecMorningReader = sharedRecMorningReader(),
): Promise<string | null> {
  const facts = recMorningReply(body, now, where);
  if (facts === null) return null;
  const reading = await read({ text: body, facts, language });
  if (reading === null) {
    console.error(
      { outcome: 'read_failed' },
      'rec-morning: read failed - nothing sent from this lane',
    );
    return null;
  }
  if (reading !== 'answers') {
    console.info({ outcome: 'not_answered' }, 'rec-morning: facts do not answer this text');
    return null;
  }
  const text = await write({
    purpose: 'rec_morning',
    // Null only when intake has no stored language yet. The skill then writes
    // in the language of facts.parentWords, not English.
    language,
    facts: { answer: facts, parentWords: body },
    verbatim: verbatimFrom(facts),
  });
  if (!text) {
    console.error('rec-morning: no model-written reply - nothing sent from this lane');
    return null;
  }
  return text;
}

/** VIL-508: the mid-signup rec-morning text, model-written; null sends nothing. */
export async function writeRecMorningIntakeReply(
  input: {
    parentWords: string;
    pendingAsk: string;
    now?: Date;
    postal?: string | null;
    /** Stored ladder language, when intake has one. Null: the model follows parentWords. */
    language?: ReplyLanguage | null;
  },
  write: typeof speak = speak,
  read: RecMorningReader = sharedRecMorningReader(),
): Promise<string | null> {
  if (recMorningIntakeReply(input) === null) return null;
  const text = await writeRecMorningReply(
    input.parentWords,
    input.now ?? new Date(),
    intakeWhere(input),
    input.language ?? null,
    write,
    read,
  );
  return text;
}
