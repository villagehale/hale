import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import { cityRecLine } from './city-line';
import {
  JACK_OF_SPORTS_PAGE,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_PORTAL,
} from './facts';
import type { RecMorningTopic, RecMorningWhere } from './match';
import { matchRecMorning } from './match';

/**
 * VIL-308 first-hello voice — design-locked, GSM-7, verbatim. A model does not write
 * the strings here.
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
 * Facts stay aligned with apps/site/lib/registration/guides.ts. This file is the SMS
 * voice, not a city-page paraphrase.
 */

const INTAKE_MAX_REPLY_CHARS = 300;

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
export const REC_MORNING_COPY: Record<RecMorningTopic, (now: Date) => string | null> = {
  toronto_swim: (now) => cityRecLine('toronto', now),
  toronto_rec: (now) => cityRecLine('toronto', now),
  toronto_waitlist: () => TORONTO_FOLLOW,
  toronto_wishlist: () => TORONTO_FOLLOW,
  toronto_efun: () => EFUN_GONE,
  ymca_gta_swim: () => YMCA_FIRST,
  ymca_follow: () => YMCA_FOLLOW,
  brampton_swim: (now) => cityRecLine('brampton', now),
  brampton_rec: (now) => cityRecLine('brampton', now),
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
  halton_hills: (now) => cityRecLine('halton_hills', now),
  pickering: (now) => cityRecLine('pickering', now),
  richmond_hill: (now) => cityRecLine('richmond_hill', now),
  vaughan: (now) => cityRecLine('vaughan', now),
  two_parents: () => TORONTO_FOLLOW,
  jack_of_sports: () => JACK_OF_SPORTS,
};

export function recMorningBody(topic: RecMorningTopic, now: Date = new Date()): string | null {
  return REC_MORNING_COPY[topic](now);
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
  return recMorningBody(topic, now);
}

export function recMorningReturnLine(pendingAsk: string): string {
  const ask = pendingAsk.trim();
  if (ask === WATCH_OFFER_ASK || /keep an eye/i.test(ask)) {
    return 'Still want me watching?';
  }
  if (ask === COLD_START_ASK || /postal/i.test(ask)) {
    return COLD_START_ASK;
  }
  return 'What did you want to tell me first?';
}

/**
 * Mid-signup: the rec-morning answer plus Hale's outstanding ask. Cold start
 * returns {@link COLD_START_ASK} verbatim. Null when the parent's text was not a
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
  const joined = `${sms} ${recMorningReturnLine(input.pendingAsk)}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS) {
    throw new Error(
      `rec-morning intake reply is ${joined.length} chars, cap is ${INTAKE_MAX_REPLY_CHARS}`,
    );
  }
  return joined;
}
