/**
 * VIL-383 group lines. Design locked these. They are group-only.
 *
 * `dutyCopyMayLeave` still rejects an unrendered `{token}` and stays false
 * unless `COPARENT_DUTY_COPY_LOCKED` is exactly `true`. No counts, no STOP
 * wording. French is ASCII. The nudge addresses one person (tu). The others
 * speak to the group (vous).
 */

import type { DutyCopyLanguage } from './copy';

export const DUTY_UNDO_TEXT_TODO = "Undone. Say so here if I've got it wrong.";
export const DUTY_UNDO_TEXT_FR = "C'est annule. Dites-le ici si je me trompe.";

export const DUTY_BURDEN_ANSWER_TODO =
  "I don't keep score, but I can tell you what's still open this week. Want that?";
export const DUTY_BURDEN_ANSWER_FR =
  'Je ne compte pas les points, mais je peux dire ce qui reste a faire cette semaine. Vous voulez?';

export const DUTY_DEFAULT_OWNER_TODO =
  'Want {name} to be the usual for {event}? Yes or no is fine.';
export const DUTY_DEFAULT_OWNER_FR =
  'Vous voulez que {name} soit la personne habituelle pour {event}? Oui ou non suffit.';

export const DUTY_LOPSIDED_CONSENT_TODO =
  'Want me to say something if the load gets uneven for a while? Yes or no is fine.';
export const DUTY_LOPSIDED_CONSENT_FR =
  'Vous voulez que je vous le dise si la charge devient inegale pendant un moment? Oui ou non suffit.';

export const DUTY_LOPSIDED_NUDGE_TODO =
  '{name}, want to take the open one: {event}, {day}? Yes or no is fine.';
export const DUTY_LOPSIDED_NUDGE_FR =
  '{name}, tu veux prendre celle qui reste: {event}, {day}? Oui ou non suffit.';

export const DUTY_PLACEHOLDER_COPY = [
  DUTY_UNDO_TEXT_TODO,
  DUTY_UNDO_TEXT_FR,
  DUTY_BURDEN_ANSWER_TODO,
  DUTY_BURDEN_ANSWER_FR,
  DUTY_DEFAULT_OWNER_TODO,
  DUTY_DEFAULT_OWNER_FR,
  DUTY_LOPSIDED_CONSENT_TODO,
  DUTY_LOPSIDED_CONSENT_FR,
  DUTY_LOPSIDED_NUDGE_TODO,
  DUTY_LOPSIDED_NUDGE_FR,
] as const;

function fill(pattern: string, slots: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => slots[key] ?? '');
}

export function dutyUndoText(language: DutyCopyLanguage): string {
  return language === 'fr' ? DUTY_UNDO_TEXT_FR : DUTY_UNDO_TEXT_TODO;
}

export function dutyBurdenAnswer(language: DutyCopyLanguage): string {
  return language === 'fr' ? DUTY_BURDEN_ANSWER_FR : DUTY_BURDEN_ANSWER_TODO;
}

export function dutyDefaultOwnerText(
  language: DutyCopyLanguage,
  name: string,
  event: string,
): string {
  const pattern = language === 'fr' ? DUTY_DEFAULT_OWNER_FR : DUTY_DEFAULT_OWNER_TODO;
  return fill(pattern, { name, event });
}

export function dutyLopsidedConsentText(language: DutyCopyLanguage): string {
  return language === 'fr' ? DUTY_LOPSIDED_CONSENT_FR : DUTY_LOPSIDED_CONSENT_TODO;
}

export function dutyLopsidedNudgeText(
  language: DutyCopyLanguage,
  name: string,
  event: string,
  day: string,
): string {
  const pattern = language === 'fr' ? DUTY_LOPSIDED_NUDGE_FR : DUTY_LOPSIDED_NUDGE_TODO;
  return fill(pattern, { name, event, day });
}
