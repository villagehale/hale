import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';
import { cityRecLine } from './city-line';
import {
  JACK_OF_SPORTS_PAGE,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_PORTAL,
} from './facts';
import type { RecMorningTopic, RecMorningWhere } from './match';
import { matchRecMorning, postalMentioned } from './match';

/**
 * VIL-308 rec-morning FACTS. VIL-508 (absolute zero fixed copy): nothing in this file is
 * sent. Each topic resolves to the reviewed facts (portal, clock, waitlist mechanics), and
 * the model writes the parent's text from them ({@link writeRecMorningReply}); a miss
 * sends nothing from this lane.
 *
 * What is NOT here any more: a city's clock. Every dated city hello rotted in place
 * (VIL-334, and then the whole GTA set a cycle later), so a town's line is DERIVED
 * from the verified registration dataset and `now` in {@link cityRecLine}. This file
 * keeps the facts that outlive a cycle — the portals, the waitlist mechanics, the
 * YMCA lock — and hands the dates to the dataset.
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

export const YMCA_FIRST = `YMCA GTA swim opened Aug 27 at 9:00 a.m. Sign in at ${YMCA_PORTAL}.`;

export const YMCA_FOLLOW =
  'Search Otter, Seal, Dolphin, Star, not Ultra. Membership is still needed for a lot of group classes, and kids 9 and under need an adult 16+ on deck.';

const JACK_OF_SPORTS = `Jack of Sports is a swim backup if the city or YMCA lane is gone. Confirm hours and how to register on ${JACK_OF_SPORTS_PAGE} rather than from me.`;

/**
 * The topic a parent asked about, answered as of `now`. A city topic reads the
 * dataset; everything else is a reviewed constant that no calendar can age.
 */
type RecMorningLine = (now: Date, where?: RecMorningWhere | null) => string | null;

export const REC_MORNING_FACTS: Record<RecMorningTopic, RecMorningLine> = {
  toronto_swim: (now, where) =>
    cityRecLine('toronto', now, 'swim', undefined, where?.postal ?? null),
  toronto_rec: (now, where) =>
    cityRecLine('toronto', now, 'rec_program', undefined, where?.postal ?? null),
  toronto_waitlist: () => TORONTO_FOLLOW,
  toronto_wishlist: () => TORONTO_FOLLOW,
  toronto_efun: () => EFUN_GONE,
  ymca_gta_swim: () => YMCA_FIRST,
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
  now: Date = new Date(),
  where?: RecMorningWhere | null,
): string | null {
  return REC_MORNING_FACTS[topic](now, where);
}

/**
 * The C1 / post-intake body. Null when this text is not a rec-morning question, and
 * null when it names a town the dataset holds no window for — Hale says nothing
 * rather than describe a season it has no record of.
 */
export function recMorningReply(
  body: string,
  now: Date = new Date(),
  where?: RecMorningWhere | null,
): string | null {
  const topic = matchRecMorning(body, where);
  if (topic === null) return null;
  // A postal in the ask is the family's district even when nothing is on file yet.
  // cityRecLine already ignores one that belongs to a different town.
  const postal = where?.postal ?? postalMentioned(body);
  const asked = postal === (where?.postal ?? null) ? (where ?? null) : { ...where, postal };
  return recMorningBody(topic, now, asked);
}

export function recMorningReturnLine(pendingAsk: string): string {
  // #868: the fixed watch / cold-start asks are gone as pending-ask text.
  void pendingAsk;
  return '';
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
  city?: string | null;
}): string | null {
  const sms = recMorningReply(input.parentWords, input.now ?? new Date(), {
    postal: input.postal,
    city: input.city,
  });
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
 * Null when this is not a rec-morning question, when the dataset holds no window, or
 * when the model wrote nothing usable — the caller sends nothing from this lane.
 */
export async function writeRecMorningReply(
  body: string,
  now: Date = new Date(),
  where?: RecMorningWhere | null,
  language: ReplyLanguage | null = null,
  write: typeof speak = speak,
): Promise<string | null> {
  const facts = recMorningReply(body, now, where);
  if (facts === null) return null;
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
    city?: string | null;
    /** Stored ladder language, when intake has one. Null: the model follows parentWords. */
    language?: ReplyLanguage | null;
  },
  write: typeof speak = speak,
): Promise<string | null> {
  if (recMorningIntakeReply(input) === null) return null;
  const text = await writeRecMorningReply(
    input.parentWords,
    input.now ?? new Date(),
    { postal: input.postal, city: input.city },
    input.language ?? null,
    write,
  );
  return text;
}
