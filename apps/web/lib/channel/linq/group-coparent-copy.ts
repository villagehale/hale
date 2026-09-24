import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * Parent-facing lines for in-group co-parent seating and household calendar
 * notices. Every sentence in this file is a placeholder.
 *
 * // NEEDS DESIGN LOCK (Sloane)
 *
 * Do not import these into a locked template. Name ask, name ack, connector
 * cards, and the group-claim lines stay in their own modules.
 */

// NEEDS DESIGN LOCK (Sloane)
export const GROUP_KID_EVENT_TEXT: Record<ReplyLanguage, string> = {
  en: 'Kid event: {title}, {when}.',
  fr: 'Evenement enfant: {title}, {when}.',
};

// NEEDS DESIGN LOCK (Sloane)
export const GROUP_KID_EVENT_CANCELLED_TEXT: Record<ReplyLanguage, string> = {
  en: 'Kid event cancelled: {title}, {when}.',
  fr: 'Evenement enfant annule: {title}, {when}.',
};

// NEEDS DESIGN LOCK (Sloane)
/** The other block is not named. `{title}` is the kid event only. */
export const GROUP_COVERAGE_CONFLICT_TEXT: Record<ReplyLanguage, string> = {
  en: '{title} at {when} overlaps time the other parent is busy.',
  fr: '{title} a {when} chevauche un moment ou l autre parent est occupe.',
};

// NEEDS DESIGN LOCK (Sloane)
export const GROUP_BOTH_BOOKED_TEXT: Record<ReplyLanguage, string> = {
  en: 'Both booked: {titleA} and {titleB}, {when}.',
  fr: 'Les deux sont pris: {titleA} et {titleB}, {when}.',
};

// NEEDS DESIGN LOCK (Sloane)
export const GROUP_HANDOFF_TEXT: Record<ReplyLanguage, string> = {
  en: 'Handoff: {title}. {whenA} then {whenB}.',
  fr: 'Relais: {title}. {whenA} puis {whenB}.',
};

// NEEDS DESIGN LOCK (Sloane)
/** Appended when a shared free hour exists. Does not say Hale books it. */
export const GROUP_FREE_SLOT_TEXT: Record<ReplyLanguage, string> = {
  en: ' Both free {when}. I can find the page.',
  fr: ' Libres tous les deux {when}. Je peux trouver la page.',
};

// NEEDS DESIGN LOCK (Sloane)
export const GROUP_FOLLOWUP_TEXT: Record<ReplyLanguage, string> = {
  en: 'How did {title} go?',
  fr: 'Comment {title} s est passe?',
};

// NEEDS DESIGN LOCK (Sloane)
/** Used when the parent has not given a call-name yet. */
export const GROUP_UNNAMED_PARENT: Record<ReplyLanguage, string> = {
  en: 'one parent',
  fr: 'un parent',
};

// NEEDS DESIGN LOCK (Sloane)
/** `{subject}` is included only after the kid classifier says yes. */
export const GROUP_KID_MAIL_TEXT: Record<ReplyLanguage, string> = {
  en: 'Kid-related mail for {name}: {subject}.',
  fr: 'Courriel enfant pour {name}: {subject}.',
};

function fill(pattern: string, slots: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '');
}

export function groupKidEventText(
  language: ReplyLanguage,
  input: { title: string; when: string; cancelled: boolean },
): string {
  const pattern = input.cancelled
    ? GROUP_KID_EVENT_CANCELLED_TEXT[language]
    : GROUP_KID_EVENT_TEXT[language];
  return fill(pattern, { title: input.title, when: input.when });
}

export function groupCoverageConflictText(
  language: ReplyLanguage,
  input: { title: string; when: string; freeWhen: string | null },
): string {
  const body = fill(GROUP_COVERAGE_CONFLICT_TEXT[language], {
    title: input.title,
    when: input.when,
  });
  if (!input.freeWhen) return body;
  return `${body}${fill(GROUP_FREE_SLOT_TEXT[language], { when: input.freeWhen })}`;
}

export function groupBothBookedText(
  language: ReplyLanguage,
  input: { titleA: string; titleB: string; when: string; freeWhen: string | null },
): string {
  const body = fill(GROUP_BOTH_BOOKED_TEXT[language], {
    titleA: input.titleA,
    titleB: input.titleB,
    when: input.when,
  });
  if (!input.freeWhen) return body;
  return `${body}${fill(GROUP_FREE_SLOT_TEXT[language], { when: input.freeWhen })}`;
}

export function groupHandoffText(
  language: ReplyLanguage,
  input: { title: string; whenA: string; whenB: string },
): string {
  return fill(GROUP_HANDOFF_TEXT[language], input);
}

export function groupFollowupText(language: ReplyLanguage, title: string): string {
  return fill(GROUP_FOLLOWUP_TEXT[language], { title });
}

export function groupKidMailText(
  language: ReplyLanguage,
  input: { name: string; subject: string },
): string {
  return fill(GROUP_KID_MAIL_TEXT[language], input);
}
