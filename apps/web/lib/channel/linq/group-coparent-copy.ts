import { howItWentAsk } from '~/lib/channel/how-it-went-copy';
import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';

/**
 * Household-group lines. The model writes every one of them, in the family's
 * language. A miss holds the send.
 */

export function groupPickedSyncLine(
  language: ReplyLanguage | null,
  input: { name: string; activity: string; kid: string; day: string; time: string },
): Promise<string | null> {
  return speak({ purpose: 'group_picked', language, facts: input });
}

export function groupPassedSyncLine(
  language: ReplyLanguage | null,
  input: { name: string; activity: string; kid: string },
): Promise<string | null> {
  return speak({ purpose: 'group_passed', language, facts: input });
}

export function groupWelcome(language: ReplyLanguage | null): Promise<string | null> {
  return speak({ purpose: 'group_welcome', language });
}

export function groupCalendarReceipt(
  language: ReplyLanguage | null,
  name: string,
): Promise<string | null> {
  return speak({ purpose: 'group_calendar_receipt', language, facts: { name } });
}

export function groupGmailReceipt(
  language: ReplyLanguage | null,
  name: string,
): Promise<string | null> {
  return speak({ purpose: 'group_gmail_receipt', language, facts: { name } });
}

export function groupKidEventText(
  language: ReplyLanguage | null,
  input: { name: string; kid: string; event: string; day: string; time: string },
): Promise<string | null> {
  return speak({ purpose: 'group_kid_event', language, facts: input });
}

export function groupConflictText(
  language: ReplyLanguage | null,
  input: { kid: string; event: string; day: string; time: string },
): Promise<string | null> {
  return speak({ purpose: 'group_conflict', language, facts: input });
}

export function groupHandoffText(
  language: ReplyLanguage | null,
  input: { name: string; kid: string; event: string; time: string },
): Promise<string | null> {
  return speak({ purpose: 'group_handoff', language, facts: input });
}

/** `{name}, ` then the locked how-it-went line, with the next letter lowercased. */
export async function groupPostEventText(
  language: ReplyLanguage | null,
  name: string,
  activity: string,
): Promise<string | null> {
  const line = await howItWentAsk(activity, language);
  return line ? groupAddressedLine(name, line) : null;
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
export async function groupActivityHowItWent(
  language: ReplyLanguage | null,
  name: string | null,
  activity: string,
): Promise<string | null> {
  if (name) return groupPostEventText(language, name, activity);
  return howItWentAsk(activity, language);
}

/**
 * Sloane, locked. The group does not guess who is travelling.
 * `Trip: {city}, {days}. A couple of things on for {kids}:`
 */
export function groupTravelBriefOpening(
  city: string,
  days: string,
  kids: string,
): Promise<string | null> {
  return speak({ purpose: 'group_travel_opening', language: null, facts: { city, days, kids } });
}

/**
 * Sloane, locked. Said in the group when a parent leaves.
 * An unknown name is `Your co-parent` / `Votre co-parent`.
 */
export function groupDepartureNotice(
  language: ReplyLanguage | null,
  name: string | null,
): Promise<string | null> {
  return speak({
    purpose: 'group_departure',
    language,
    facts: { name: name ?? '' },
  });
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

export function groupBothFreeText(
  language: ReplyLanguage | null,
  slot1: string,
  slot2: string,
): Promise<string | null> {
  return speak({ purpose: 'group_both_free', language, facts: { slot1, slot2 } });
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
