/**
 * VIL-392 — the pull path.
 *
 * "set me up" / "what can you do" (and the French twins) ask for the ladder.
 * Bare HELP / INFO / AIDE stay on the keyword path and never arrive here.
 * One step per reply. Place and ages reuse the locked first-touch lines and
 * are not optional asks. After a picked result, the sign-up offer is its own
 * reply: date known when that result says when sign-ups open, otherwise the
 * no-date check-in. Calendar and email stay separate later replies.
 */

import type { ReplyLanguage } from '~/lib/channel/language';
import {
  FIRST_TOUCH_AGES_BY_LANGUAGE,
  FIRST_TOUCH_GROUP_FR,
  FIRST_TOUCH_IMESSAGE_BY_LANGUAGE,
  FIRST_TOUCH_SMS_BY_LANGUAGE,
} from '../copy';
import { calendarAsk, emailAsk, signupOffer, whatCanYouDo } from './copy';
import { coldStartLadderEnabled } from './flags';
import type { ColdStartIntent } from './intent';
import { calendarAskDue, mentionsSchoolOrCamp } from './ladder';

export type PullKind = 'place' | 'ages' | 'what' | 'later' | 'signup' | 'calendar' | 'email';

export type PullSkip = 'not_pull' | 'copy_unlocked' | 'not_due' | 'unfilled';

export function planFollowAsk(input: {
  language: ReplyLanguage;
  now: Date;
  familyStartedAt: Date;
  nameLineSent: boolean;
  calendarAlreadyAsked: boolean;
  emailAlreadyAsked: boolean;
  signupAsked?: boolean;
  signupDateKnown?: boolean;
  parentText: string;
  schoolMentioned?: boolean;
  activity: string | null;
  day?: string | null;
  env?: Record<string, string | undefined>;
}): {
  kind: 'signup' | 'calendar' | 'email' | 'none';
  body: string;
  mayLeave: boolean;
  skipped?: 'not_due' | 'copy_unlocked' | 'unfilled';
} {
  const offer = signupOfferForResult(input);
  if (offer) return offer;
  const emailWanted =
    !input.emailAlreadyAsked &&
    (input.schoolMentioned === true || mentionsSchoolOrCamp(input.parentText));
  const calendarDue = calendarAskDue({
    now: input.now,
    familyStartedAt: input.familyStartedAt,
    nameLineSent: input.nameLineSent,
    alreadyAsked: input.calendarAlreadyAsked,
  });
  // The reply after the name line belongs to calendar once the sign-up offer
  // has already had its own turn. Email waits.
  if (calendarDue && input.nameLineSent) {
    return finishConnector('calendar', calendarAsk(input.language, input.activity, input.env));
  }
  if (emailWanted) {
    return finishConnector('email', emailAsk(input.language, input.env));
  }
  if (calendarDue) {
    return finishConnector('calendar', calendarAsk(input.language, input.activity, input.env));
  }
  return { kind: 'none', body: '', mayLeave: false, skipped: 'not_due' };
}

function signupOfferForResult(input: {
  language: ReplyLanguage;
  signupAsked?: boolean;
  signupDateKnown?: boolean;
  activity: string | null;
  day?: string | null;
  env?: Record<string, string | undefined>;
}): {
  kind: 'signup';
  body: string;
  mayLeave: boolean;
  skipped?: 'copy_unlocked' | 'unfilled';
} | null {
  if (!coldStartLadderEnabled(input.env)) return null;
  if (input.signupAsked) return null;
  const activity = input.activity?.trim() ?? '';
  const day = input.day?.trim() ?? '';
  if (input.signupDateKnown) {
    if (!activity) return null;
    return finishConnector(
      'signup',
      signupOffer('date_known', { language: input.language, activity, env: input.env }),
    );
  }
  if (!day) return null;
  return finishConnector(
    'signup',
    signupOffer('no_date', { language: input.language, day, env: input.env }),
  );
}

function finishConnector<K extends 'signup' | 'calendar' | 'email'>(
  kind: K,
  line: { body: string; mayLeave: boolean },
): {
  kind: K;
  body: string;
  mayLeave: boolean;
  skipped?: 'copy_unlocked' | 'unfilled';
} {
  if (line.mayLeave) return { kind, body: line.body, mayLeave: true };
  return {
    kind,
    body: line.body,
    mayLeave: false,
    skipped: line.body.includes('{') ? 'unfilled' : 'copy_unlocked',
  };
}

export function planPull(input: {
  intent: ColdStartIntent;
  language: ReplyLanguage;
  hasPlace: boolean;
  hasAges: boolean;
  channel: 'sms' | 'imessage';
  group: boolean;
  count: number;
  place: string;
  ages: string;
  now?: Date;
  familyStartedAt?: Date;
  nameLineSent?: boolean;
  calendarAlreadyAsked?: boolean;
  emailAlreadyAsked?: boolean;
  parentText?: string;
  schoolMentioned?: boolean;
  activity?: string | null;
  day?: string | null;
  signupAsked?: boolean;
  signupDateKnown?: boolean;
  env?: Record<string, string | undefined>;
}): { kind: PullKind; body: string; mayLeave: boolean; skipped?: PullSkip } {
  if (input.intent === 'what_can_you_do') {
    const answer = whatCanYouDo({
      language: input.language,
      count: input.count,
      place: input.place,
      ages: input.ages,
    });
    return { kind: 'what', body: answer.body, mayLeave: true };
  }
  if (input.intent !== 'set_me_up') {
    return { kind: 'later', body: '', mayLeave: false, skipped: 'not_pull' };
  }
  if (!input.hasPlace) {
    const card = input.channel === 'imessage' && !input.group;
    const body = card
      ? FIRST_TOUCH_IMESSAGE_BY_LANGUAGE[input.language]
      : input.group && input.language === 'fr'
        ? FIRST_TOUCH_GROUP_FR
        : FIRST_TOUCH_SMS_BY_LANGUAGE[input.language];
    return { kind: 'place', body, mayLeave: true };
  }
  if (!input.hasAges) {
    return { kind: 'ages', body: FIRST_TOUCH_AGES_BY_LANGUAGE[input.language], mayLeave: true };
  }
  const now = input.now ?? input.familyStartedAt ?? new Date();
  const follow = planFollowAsk({
    language: input.language,
    now,
    familyStartedAt: input.familyStartedAt ?? now,
    nameLineSent: input.nameLineSent === true,
    calendarAlreadyAsked: input.calendarAlreadyAsked === true,
    emailAlreadyAsked: input.emailAlreadyAsked === true,
    parentText: input.parentText ?? '',
    schoolMentioned: input.schoolMentioned,
    activity: input.activity ?? null,
    day: input.day,
    signupAsked: input.signupAsked,
    signupDateKnown: input.signupDateKnown,
    env: input.env,
  });
  if (follow.kind === 'none') {
    return { kind: 'later', body: '', mayLeave: false, skipped: 'not_due' };
  }
  return {
    kind: follow.kind,
    body: follow.body,
    mayLeave: follow.mayLeave,
    ...(follow.skipped ? { skipped: follow.skipped } : {}),
  };
}
