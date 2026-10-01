/**
 * VIL-392 — cold-start copy.
 *
 * Locked handbook lines were not in the repo. Ticket-quoted shapes and the
 * VIL-385 first-touch lines may leave. Everything else is TODO-Design and
 * must not leave, even when the copy-lock flag is exactly `true`.
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
  en: 'TODO-Design',
  fr: 'TODO-Design',
};

export const SIGNUP_OFFER_BY_KIND = {
  date_known: 'TODO-Design',
  no_date: 'TODO-Design',
} as const;

const BANNED_OUT =
  /stop to unsubscribe|reply stop|répondez arret|repondez arret|désabonner|desabonner/i;

/** A placeholder never leaves, locked flag or not. */
export function placeholderMayLeave(
  body: string,
  env?: Record<string, string | undefined>,
): boolean {
  if (body.includes('TODO-Design')) return false;
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
): {
  body: string;
  mayLeave: boolean;
} {
  const body = NAMES_ASK_BY_LANGUAGE[language];
  return { body, mayLeave: placeholderMayLeave(body, env) };
}

export function signupOffer(kind: 'date_known' | 'no_date'): { body: string; mayLeave: false } {
  return { body: SIGNUP_OFFER_BY_KIND[kind], mayLeave: false };
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
