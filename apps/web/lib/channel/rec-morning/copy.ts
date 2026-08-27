import { COLD_START_ASK, WATCH_OFFER_ASK } from '~/lib/channel/intake/copy';
import {
  BRAMPTON_WAITLIST_HOURS,
  JACK_OF_SPORTS_PAGE,
  TORONTO_REC_PORTAL,
  TORONTO_WAITLIST_HOURS,
  UNOFFICIAL,
  YMCA_PORTAL,
  YMCA_SWIM_OPEN,
} from './facts';
import type { RecMorningTopic } from './match';
import { matchRecMorning } from './match';

/**
 * Every rec-morning SMS body, reviewed, GSM-7, sized for two segments — and, on the
 * intake path, for the answer-plus-return-line cap (300). A model does not write these.
 *
 * Portals are named the way a parent types them, without https:// or www. — those
 * prefixes are how the rest of the SMS path refuses an invented link. Official pages
 * Hale has reviewed are facts, not inventions.
 */

const INTAKE_MAX_REPLY_CHARS = 300;

function ymcaIsToday(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: YMCA_SWIM_OPEN.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}` === YMCA_SWIM_OPEN.isoDate;
}

function ymcaBody(now: Date): string {
  const when = ymcaIsToday(now) ? 'today Aug 27' : 'Aug 27';
  return `YMCA Greater Toronto swim is ${when} at ${YMCA_SWIM_OPEN.time} for members and non-residents on ${YMCA_PORTAL}. Membership still needed for many group classes. Otter/Seal/Dolphin/Star, not Ultra. Kids 9 and under need an adult 16+ on deck. Confirm on My Y. ${UNOFFICIAL}`;
}

/**
 * GTM first-class Toronto rec facts. Not optional, and not only when a parent
 * asks about waitlist, wishlist, or eFun: they ride on the first-time swim and
 * rec clock replies. Dedicated waitlist / wishlist / portal topics go deeper.
 */
export const TORONTO_FIRST_CLASS = `eFun is gone. Rec is ${TORONTO_REC_PORTAL}. Not ActiveTO. Waitlist: ${TORONTO_WAITLIST_HOURS} hours, no queue number, email then dropped. Wishlist can look frozen: wait, don't mash refresh or search live at 7:00 a.m.`;

export const REC_MORNING_COPY = {
  toronto_swim: `Toronto swim: same 7 a.m. as rec, by district not address, Sept 15 or 16. ${TORONTO_FIRST_CLASS}`,
  toronto_rec: `Toronto rec: district, not address. Sept 9 catchment-only; Sept 15 or 16. ${TORONTO_FIRST_CLASS}`,
  toronto_waitlist: `Toronto waitlist is ${TORONTO_WAITLIST_HOURS} hours with no queue number. Invitation is email, then dropped. ${UNOFFICIAL}`,
  toronto_wishlist: `The wish list can look frozen. Wait and register from it when the district clock starts - don't mash refresh or search live at 7:00 a.m. ${UNOFFICIAL}`,
  toronto_portal: `eFun is gone. Rec is ${TORONTO_REC_PORTAL} (Active Communities). Not ActiveTO - FitnessTO is memberships. ${UNOFFICIAL}`,
  brampton_swim: `Brampton Learn to Swim is Sept 9 7 a.m. for residents, not Aug 24. Waitlist pending-confirmation is ${BRAMPTON_WAITLIST_HOURS} hours, not Toronto's ${TORONTO_WAITLIST_HOURS}. Resident verification is in person. ${UNOFFICIAL}`,
  two_parents:
    'Two parents means two phones and two logins. This thread is yours - it does not merge with theirs.',
  jack_of_sports: `Jack of Sports is a swim backup if the city or YMCA lane is gone. ${UNOFFICIAL} Confirm hours and how to register on ${JACK_OF_SPORTS_PAGE} rather than from me.`,
} as const;

export function recMorningBody(topic: RecMorningTopic, now: Date = new Date()): string {
  if (topic === 'ymca_gta_swim') return ymcaBody(now);
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
    return 'Kids names, ages, postal code?';
  }
  return 'What did you want to tell me first?';
}

/**
 * Mid-signup: the rec-morning answer plus Hale's own question again in different
 * words. Null when the parent's text was not a rec-morning question.
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
