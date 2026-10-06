import { howItWentAsk } from '~/lib/channel/how-it-went-copy';
import type { ReplyLanguage } from '~/lib/channel/language';
import { renderEmptySaturdayAsk } from '~/lib/channel/nudge/empty-saturday-copy';

/**
 * Design-locked lines for the Linq household group (Sloane).
 * French twins are ASCII. `{name}` is the parent. The calendar card and the
 * name ack stay in their own modules.
 */

export const GROUP_WELCOME: Record<ReplyLanguage, string> = {
  en: "Hi, I'm Hale. This thread is your kids' year — both of you, and me. What should I call you?",
  fr: "Salut, c'est Hale. Ce fil, c'est l'annee des enfants: vous deux, et moi. Comment je t'appelle?",
};

/** Sloane, locked. The card is the next line of this same bubble. */
export const GROUP_CALENDAR_ASK: Record<ReplyLanguage, string> = {
  en: "{name}, want your calendar in the kids' year too? This link is just for you.",
  fr: "{name}, tu veux ajouter ton calendrier a l'annee des enfants? Ce lien est juste pour toi.",
};

export const GROUP_CALENDAR_RECEIPT: Record<ReplyLanguage, string> = {
  en: "{name}'s calendar is connected. I'll keep the kids' stuff straight across both.",
  fr: 'Le calendrier de {name} est connecte. Je suis les activites des enfants sur les deux.',
};

/** Sloane, locked. Its own turn, once, with the card in this same bubble. */
export const GROUP_GMAIL_ASK: Record<ReplyLanguage, string> = {
  en: '{name}, want me to catch school and camp emails for you too? This link is just for you. Nothing from your inbox shows up here.',
  fr: "{name}, tu veux que je repere aussi les courriels de l'ecole et des camps? Ce lien est juste pour toi. Rien de ta boite ne s'affiche ici.",
};

export const GROUP_GMAIL_RECEIPT: Record<ReplyLanguage, string> = {
  en: "{name}'s Gmail is connected. I'll pull out the kids' dates; the inbox stays private.",
  fr: 'Le Gmail de {name} est connecte. Je garde les dates des enfants; la boite reste privee.',
};

/**
 * Sloane, locked. A 1:1 activity decision, told to the group. Templated only.
 * The line never says Hale booked anything.
 */
export function groupPickedSyncLine(
  language: ReplyLanguage,
  input: { name: string; activity: string; kid: string; day: string; time: string },
): string {
  if (language === 'fr') {
    return `Pour info: ${input.name} a choisi ${input.activity} pour ${input.kid}, ${input.day} a ${input.time}.`;
  }
  return `Quick sync: ${input.name} picked ${input.activity} for ${input.kid}, ${input.day} at ${input.time}.`;
}

/** Sloane, locked. The passed twin. No day and no time, because nothing was chosen. */
export function groupPassedSyncLine(
  language: ReplyLanguage,
  input: { name: string; activity: string; kid: string },
): string {
  if (language === 'fr') {
    return `Pour info: ${input.name} a laisse tomber ${input.activity} pour ${input.kid}.`;
  }
  return `Quick sync: ${input.name} passed on ${input.activity} for ${input.kid}.`;
}

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

export function groupGmailAsk(language: ReplyLanguage, name: string): string {
  return fill(GROUP_GMAIL_ASK[language], { name });
}

export function groupGmailReceipt(language: ReplyLanguage, name: string): string {
  return fill(GROUP_GMAIL_RECEIPT[language], { name });
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

/** `{name}, ` then the locked how-it-went line, with the next letter lowercased. */
export function groupPostEventText(
  language: ReplyLanguage,
  name: string,
  activity: string,
): string {
  return groupAddressedLine(name, howItWentAsk(activity, language));
}

/** `{name}, ` then the line. The first letter after the comma is lowercase. */
export function groupAddressedLine(name: string, line: string): string {
  const trimmed = line.trimStart();
  const rest =
    trimmed.length === 0 ? trimmed : `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
  return `${name}, ${rest}`;
}

/**
 * How-it-went in the group. A known parent is named. An unknown parent keeps
 * the English line and uses the French line, which has no tu.
 */
export function groupActivityHowItWent(
  language: ReplyLanguage,
  name: string | null,
  activity: string,
): string {
  if (name) return groupPostEventText(language, name, activity);
  return howItWentAsk(activity, language);
}

/**
 * Empty Saturday in the group. A known parent is named. An unknown parent
 * keeps English and switches French tu to vous.
 */
export function groupEmptySaturdayLine(
  language: ReplyLanguage,
  name: string | null,
  kid: string,
): string {
  const ask = renderEmptySaturdayAsk(kid, language);
  if (name) return groupAddressedLine(name, ask);
  return language === 'fr' ? groupBothReaderFrench(ask) : ask;
}

/**
 * Sloane, locked. The group does not guess who is travelling.
 * `Trip: {city}, {days}. A couple of things on for {kids}:`
 */
export function groupTravelBriefOpening(city: string, days: string, kids: string): string {
  return `Trip: ${city}, ${days}. A couple of things on for ${kids}:`;
}

/**
 * Sloane, locked. Said in the group when a parent leaves.
 * An unknown name is `Your co-parent` / `Votre co-parent`.
 */
export function groupDepartureNotice(language: ReplyLanguage, name: string | null): string {
  const who = name ?? (language === 'fr' ? 'Votre co-parent' : 'Your co-parent');
  if (language === 'fr') {
    return `${who} a quitte Hale. Rien n'a change dans l'annee des enfants, et je suis toujours la.`;
  }
  return `${who} left Hale. Nothing in the kids' year changed, and I'm still here.`;
}

/**
 * A line for both parents. English stays. French tu/ton/ta/envoie-moi become
 * vous/votre/envoyez-moi. A `{name}, ` line is not passed through here.
 */
export function groupBothReaderFrench(text: string): string {
  return text
    .replaceAll('Tu veux', 'Vous voulez')
    .replaceAll('tu veux', 'vous voulez')
    .replaceAll('Envoie-moi', 'Envoyez-moi')
    .replaceAll('envoie-moi', 'envoyez-moi')
    .replaceAll(/\bTon\b/g, 'Votre')
    .replaceAll(/\bTa\b/g, 'Votre')
    .replaceAll(/\bton\b/g, 'votre')
    .replaceAll(/\bta\b/g, 'votre');
}

/** The weekly bubble, plus up to three how-it-went lines. One text, not a second send. */
export function absorbHowItWentLines(weekly: string, lines: readonly string[]): string {
  const extra = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  if (extra.length === 0) return weekly;
  return `${weekly.trimEnd()}\n${extra.join('\n')}`;
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
