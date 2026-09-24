import { howItWentAsk } from '~/lib/channel/how-it-went-copy';
import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * Design-locked lines for the Linq household group (Sloane).
 * French twins are ASCII. `{name}` is the parent. The calendar card and the
 * name ack stay in their own modules.
 */

export const GROUP_WELCOME: Record<ReplyLanguage, string> = {
  en: "Hi, I'm Hale. This thread is your kids' year — both of you, and me. What should I call you?",
  fr: "Salut, c'est Hale. Ce fil, c'est l'annee des enfants: vous deux, et moi. Comment je t'appelle?",
};

export const GROUP_CALENDAR_ASK: Record<ReplyLanguage, string> = {
  en: "{name}, want your calendar in the kids' year too? I'll text you the link one-to-one.",
  fr: "{name}, tu veux ajouter ton calendrier a l'annee des enfants? Je t'envoie le lien en prive.",
};

export const GROUP_CALENDAR_RECEIPT: Record<ReplyLanguage, string> = {
  en: "{name}'s calendar is connected. I'll keep the kids' stuff straight across both.",
  fr: 'Le calendrier de {name} est connecte. Je suis les activites des enfants sur les deux.',
};

export const GROUP_KID_EVENT: Record<ReplyLanguage, string> = {
  en: "Heads up: {name} added {kid}'s {event}, {day} at {time}.",
  fr: 'Pour info: {name} a ajoute {event} pour {kid}, {day} a {time}.',
};

export const GROUP_CONFLICT: Record<ReplyLanguage, string> = {
  en: "{kid}'s {event} is {day} at {time}, and you're both busy then. Who's taking it?",
  fr: "{event} pour {kid}, {day} a {time}, et vous etes pris tous les deux. Qui s'en occupe?",
};

export const GROUP_HANDOFF: Record<ReplyLanguage, string> = {
  en: "Tomorrow: {name} has {kid}'s {event} at {time}.",
  fr: "Demain: {name} s'occupe de {event} pour {kid} a {time}.",
};

export const GROUP_BOTH_FREE: Record<ReplyLanguage, string> = {
  en: "You're both free {slot1} or {slot2}. Want the sign-up page for one?",
  fr: "Vous etes libres tous les deux {slot1} ou {slot2}. Vous voulez la page d'inscription pour l'un des deux?",
};

function fill(pattern: string, slots: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '');
}

export function groupWelcome(language: ReplyLanguage): string {
  return GROUP_WELCOME[language];
}

export function groupCalendarAsk(language: ReplyLanguage, name: string): string {
  return fill(GROUP_CALENDAR_ASK[language], { name });
}

export function groupCalendarReceipt(language: ReplyLanguage, name: string): string {
  return fill(GROUP_CALENDAR_RECEIPT[language], { name });
}

export function groupKidEventText(
  language: ReplyLanguage,
  input: { name: string; kid: string; event: string; day: string; time: string },
): string {
  return fill(GROUP_KID_EVENT[language], input);
}

export function groupConflictText(
  language: ReplyLanguage,
  input: { kid: string; event: string; day: string; time: string },
): string {
  return fill(GROUP_CONFLICT[language], input);
}

export function groupHandoffText(
  language: ReplyLanguage,
  input: { name: string; kid: string; event: string; time: string },
): string {
  return fill(GROUP_HANDOFF[language], input);
}

/** `'{name}, ' +` the locked how-it-went line. Capital H stays. */
export function groupPostEventText(
  language: ReplyLanguage,
  name: string,
  activity: string,
): string {
  return `${name}, ${howItWentAsk(activity, language)}`;
}

export function groupBothFreeText(language: ReplyLanguage, slot1: string, slot2: string): string {
  return fill(GROUP_BOTH_FREE[language], { slot1, slot2 });
}

/**
 * A parent asking for a shared free window. Conservative: two-slot copy is
 * never attached to a nudge.
 */
const BOTH_FREE_ASK =
  /\b(?:both free|when (?:are|can) we both|free together|tous les deux libres|libres tous les deux|quand (?:est-ce qu'on|on) est libres)\b/i;

export function matchBothFreeAsk(body: string): boolean {
  return BOTH_FREE_ASK.test(body);
}
