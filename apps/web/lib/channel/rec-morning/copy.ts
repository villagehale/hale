import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import {
  BRAMPTON_WAITLIST_HOURS,
  JACK_OF_SPORTS_PAGE,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  YMCA_PORTAL,
} from './facts';
import type { RecMorningTopic } from './match';
import { matchRecMorning } from './match';

/**
 * VIL-308 first-hello voice — design-locked, GSM-7, verbatim. A model does not write these.
 *
 * Two sentences, one link, no ladder on the first Toronto rec/swim answer. Follow only
 * if they need waitlist/wishlist/two phones. eFun named only if they said eFun. YMCA
 * follow only for levels or membership. Jack of Sports only if they ask. Never ActiveTO
 * (even to negate it), never "I'm an AI", never unofficial, never an app URL.
 *
 * Facts stay aligned with apps/site/lib/registration/guides.ts. This file is the SMS
 * voice, not a city-page paraphrase.
 */

const INTAKE_MAX_REPLY_CHARS = 300;

export const TORONTO_FIRST_REC = `Toronto rec and swim open 7:00 a.m. on your district morning: Sept 9 if you're catchment-only, Sept 15 or 16 otherwise. Sign in at ${TORONTO_REC_PORTAL} with the centre district, not your home address.`;

export const TORONTO_FOLLOW = `Wishlist can look frozen, so wait, don't mash refresh. Waitlist email takes about ${TORONTO_WAITLIST_HOURS} hours and there's no queue number. Two parents means two phones.`;

export const EFUN_GONE = `eFun is gone. Rec is ${TORONTO_REC_PORTAL} now.`;

export const YMCA_FIRST = `YMCA GTA swim opened at 9:00 a.m. Sign in at ${YMCA_PORTAL}.`;

export const YMCA_FOLLOW =
  'Search Otter, Seal, Dolphin, Star, not Ultra. Membership is still needed for a lot of group classes, and kids 9 and under need an adult 16+ on deck.';

export const REC_MORNING_COPY = {
  toronto_swim: TORONTO_FIRST_REC,
  toronto_rec: TORONTO_FIRST_REC,
  toronto_waitlist: TORONTO_FOLLOW,
  toronto_wishlist: TORONTO_FOLLOW,
  toronto_efun: EFUN_GONE,
  ymca_gta_swim: YMCA_FIRST,
  ymca_follow: YMCA_FOLLOW,
  brampton_swim: `Brampton Learn to Swim is Sept 9 7 a.m. for residents, not Aug 24. Waitlist pending-confirmation is ${BRAMPTON_WAITLIST_HOURS} hours, not Toronto's ${TORONTO_WAITLIST_HOURS}. Resident verification is in person.`,
  two_parents: TORONTO_FOLLOW,
  jack_of_sports: `Jack of Sports is a swim backup if the city or YMCA lane is gone. Confirm hours and how to register on ${JACK_OF_SPORTS_PAGE} rather than from me.`,
} as const;

export function recMorningBody(topic: RecMorningTopic, _now: Date = new Date()): string {
  return REC_MORNING_COPY[topic];
}

/** The C1 / post-intake body, or null when this text is not a rec-morning question. */
export function recMorningReply(body: string, now: Date = new Date()): string | null {
  const topic = matchRecMorning(body);
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
}): string | null {
  const sms = recMorningReply(input.parentWords, input.now ?? new Date());
  if (sms === null) return null;
  const joined = `${sms} ${recMorningReturnLine(input.pendingAsk)}`;
  if (joined.length > INTAKE_MAX_REPLY_CHARS) {
    throw new Error(
      `rec-morning intake reply is ${joined.length} chars, cap is ${INTAKE_MAX_REPLY_CHARS}`,
    );
  }
  return joined;
}
