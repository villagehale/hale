/**
 * VIL-392 — cold-start copy.
 *
 * Names, the sign-up offer, and the calendar and email asks are Design-locked.
 * They leave only when `COLD_START_LADDER_COPY_LOCKED` is exactly `true`.
 * An unfilled `{token}` never leaves. Ticket-quoted shapes and the VIL-385
 * first-touch lines may leave.
 */

import type { ReplyLanguage } from '~/lib/channel/language';
import { FIRST_TOUCH_EMPTY_BY_LANGUAGE } from '../copy';
import { coldStartCopyLocked } from './flags';

export const DISCOVERY_NEXT_STEP: Record<ReplyLanguage, string> = {
  en: 'Reply with the number you want.',
  fr: 'Reponds avec le numero que tu veux.',
};

/** Known-venue hello: the locked first touch with the place question removed. */
export const KNOWN_VENUE_HELLO: Record<ReplyLanguage, string> = {
  en: "Hey, it's Hale. I find what's on for kids. I'll show you what's on this week.",
  fr: "Salut, c'est Hale. Je trouve ce qui se passe pour les enfants. Je te montre ce qui est au programme cette semaine.",
};

export const NAMES_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "What should I call you? And the kids' first names, if you'd like me to use them. Skip any you'd rather not share.",
  fr: "Je t'appelle comment? Et les prenoms des enfants, si tu veux que je m'en serve. Passe ceux que tu preferes garder pour toi.",
};

/** Google already confirmed the parent name, so the ask is the kids only. */
export const KIDS_NAMES_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: "What are the kids' first names, if you'd like me to use them? Skip any you'd rather not share.",
  fr: "Et les prenoms des enfants, si tu veux que je m'en serve? Passe ceux que tu preferes garder pour toi.",
};

export const SIGNUP_OFFER_DATE_KNOWN_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Want me to text you the morning sign-ups open for {activity}?',
  fr: "Tu veux que je t'ecrive le matin ou les inscriptions ouvrent pour {activity}?",
};

export const SIGNUP_OFFER_NO_DATE_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Want me to text you after {day} and ask how it went?',
  fr: "Tu veux que je t'ecrive apres {day} pour savoir comment ca s'est passe?",
};

export const CALENDAR_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Want me to check {activity} against your calendar? This link is just for you. I can see your events and never change them.',
  fr: 'Tu veux que je regarde {activity} par rapport a ton calendrier? Ce lien est juste pour toi. Je peux voir tes evenements et je ne change rien.',
};

export const EMAIL_ASK_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Want me to look in your email for camp, school and daycare notes, for dates and sign-up times? This link is just for you. I never send or change anything.',
  fr: "Tu veux que je cherche dans ton courriel les messages de camp, d'ecole et de garderie, pour les dates et les ouvertures d'inscription? Ce lien est juste pour toi. Je n'envoie ni ne change rien.",
};

const BANNED_OUT =
  /stop to unsubscribe|reply stop|répondez arret|repondez arret|désabonner|desabonner/i;

/** A placeholder or an unfilled token never leaves, locked flag or not. */
export function placeholderMayLeave(
  body: string,
  env?: Record<string, string | undefined>,
): boolean {
  if (body.includes('TODO-Design')) return false;
  if (body.includes('{')) return false;
  if (BANNED_OUT.test(body)) return false;
  return coldStartCopyLocked(env);
}

export function spokenAge(months: number): string {
  const exactYears = months % 12 === 0;
  if (months >= 24 || exactYears) {
    const years = Math.max(0, Math.floor(months / 12));
    return `${article(years)} ${years}-year-old`;
  }
  return `${article(months)} ${months}-month-old`;
}

export function joinSpoken(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export function receiptLine(agesMonths: readonly number[], placeLabel: string): string {
  const ages = joinSpoken(agesMonths.map((months) => spokenAge(months)));
  return `Got it: ${ages}, near ${placeLabel}.`;
}

export function discoveryBubble(input: {
  language: ReplyLanguage;
  agesMonths: readonly number[];
  placeLabel: string;
  findBody: string;
}): { body: string; receipt: 'sent' | 'copy_unlocked' } {
  const find = withDiscoveryNextStep(input.language, input.findBody);
  if (input.language === 'fr') {
    return { body: find, receipt: 'copy_unlocked' };
  }
  return {
    body: `${receiptLine(input.agesMonths, input.placeLabel)}\n${find}`,
    receipt: 'sent',
  };
}

export function logisticsBubble(input: {
  language: ReplyLanguage;
  day: string;
  activity: string;
  group: boolean;
  forwardLink: string | null;
}): { body: string | null; forwardLink: 'offered' | 'not_offered'; skipped?: 'copy_unlocked' } {
  if (input.language !== 'en') {
    return { body: null, forwardLink: 'not_offered', skipped: 'copy_unlocked' };
  }
  const tail = input.group ? "I'll keep track." : "I'll note it.";
  const question = `Who's taking them ${input.day} to ${input.activity}? ${tail}`;
  const link = realLink(input.forwardLink);
  if (!link) return { body: question, forwardLink: 'not_offered' };
  return { body: `${question}\n${link}`, forwardLink: 'offered' };
}

export function notedAfterLogistics(group: boolean, language: ReplyLanguage): string {
  if (language === 'fr') return 'Je le note. Ecris-moi si ca change.';
  return group
    ? "I'll keep track. Text me if that changes."
    : "I'll note it. Text me if that changes.";
}

export function namesAsk(
  language: ReplyLanguage,
  env?: Record<string, string | undefined>,
  options?: { googleConfirmedParentName?: boolean },
): {
  body: string;
  mayLeave: boolean;
} {
  const body = options?.googleConfirmedParentName
    ? KIDS_NAMES_ASK_BY_LANGUAGE[language]
    : NAMES_ASK_BY_LANGUAGE[language];
  return { body, mayLeave: placeholderMayLeave(body, env) };
}

export function signupOffer(
  kind: 'date_known' | 'no_date',
  input: {
    language?: ReplyLanguage;
    activity?: string;
    day?: string;
    env?: Record<string, string | undefined>;
  } = {},
): { body: string; mayLeave: boolean } {
  const language = input.language ?? 'en';
  const pattern =
    kind === 'date_known'
      ? SIGNUP_OFFER_DATE_KNOWN_BY_LANGUAGE[language]
      : SIGNUP_OFFER_NO_DATE_BY_LANGUAGE[language];
  const token = kind === 'date_known' ? '{activity}' : '{day}';
  const slot = (kind === 'date_known' ? input.activity : input.day)?.trim() ?? '';
  const body = slot ? pattern.replaceAll(token, slot) : pattern;
  return { body, mayLeave: placeholderMayLeave(body, input.env) };
}

export function calendarAsk(
  language: ReplyLanguage,
  activity: string | null | undefined,
  env?: Record<string, string | undefined>,
): { body: string; mayLeave: boolean } {
  const slot = activity?.trim() ?? '';
  const pattern = CALENDAR_ASK_BY_LANGUAGE[language];
  const body = slot ? pattern.replaceAll('{activity}', slot) : pattern;
  return { body, mayLeave: placeholderMayLeave(body, env) };
}

export function emailAsk(
  language: ReplyLanguage,
  env?: Record<string, string | undefined>,
): { body: string; mayLeave: boolean } {
  const body = EMAIL_ASK_BY_LANGUAGE[language];
  return { body, mayLeave: placeholderMayLeave(body, env) };
}

export function whatCanYouDo(input: {
  language: ReplyLanguage;
  count: number;
  place: string;
  ages: string;
}): { body: string; detail: 'concrete' | 'empty' | 'copy_unlocked' } {
  if (input.count <= 0) {
    return { body: FIRST_TOUCH_EMPTY_BY_LANGUAGE[input.language], detail: 'empty' };
  }
  if (input.language !== 'en') {
    return { body: FIRST_TOUCH_EMPTY_BY_LANGUAGE.fr, detail: 'copy_unlocked' };
  }
  return {
    body: `${input.count} things near ${input.place} for ${input.ages}.\n${DISCOVERY_NEXT_STEP.en}`,
    detail: 'concrete',
  };
}

/** Stop-asking reply: one concrete result, no question. */
export function stopAskingReply(language: ReplyLanguage): string {
  return FIRST_TOUCH_EMPTY_BY_LANGUAGE[language];
}

function withDiscoveryNextStep(language: ReplyLanguage, findBody: string): string {
  if (
    findBody === FIRST_TOUCH_EMPTY_BY_LANGUAGE.en ||
    findBody === FIRST_TOUCH_EMPTY_BY_LANGUAGE.fr
  ) {
    return findBody;
  }
  if (findBody.includes('?')) return findBody;
  if (findBody.includes(DISCOVERY_NEXT_STEP[language])) return findBody;
  return `${findBody}\n${DISCOVERY_NEXT_STEP[language]}`;
}

function article(n: number): 'a' | 'an' {
  if (n === 8 || n === 11 || n === 18 || (n >= 80 && n <= 89)) return 'an';
  return 'a';
}

function realLink(link: string | null): string | null {
  if (!link) return null;
  if (!/^https:\/\//.test(link)) return null;
  return link;
}
