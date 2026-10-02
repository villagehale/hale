/**
 * Parent-facing strings for the mid-activity ask (VIL-393).
 *
 * Design locked these. `midActivityCopyMayLeave` rejects any unsubscribe or
 * STOP wording, and a body that does not end in exactly one next step.
 * The ask flag stays off. This module does not send.
 */

import type { ReplyLanguage } from '~/lib/channel/language';

export const MID_ACTIVITY_ASK_EN =
  "How's {activity} going so far? Just a line back is plenty.";
export const MID_ACTIVITY_ASK_FR =
  'Comment ca se passe pour {activity}? Une phrase en reponse suffit.';
export const MID_ACTIVITY_ASK_NO_ACTIVITY_EN =
  "How's it going so far? Just a line back is plenty.";
export const MID_ACTIVITY_ASK_NO_ACTIVITY_FR =
  "Comment ca se passe jusqu'ici? Une phrase en reponse suffit.";
export const MID_ACTIVITY_ACK_EN =
  "Thanks, that helps. I'll use it when I pick what to send you next.";
export const MID_ACTIVITY_ACK_FR =
  "Merci, ca m'aide. Je m'en sers pour choisir la prochaine suggestion.";

const OPT_OUT = /\bSTOP\b|unsubscribe|opt[- ]out/i;

export function midActivityAsk(
  activity: string | null | undefined,
  language: ReplyLanguage,
): string {
  const name = activity?.trim() ?? '';
  if (!name) {
    return language === 'fr' ? MID_ACTIVITY_ASK_NO_ACTIVITY_FR : MID_ACTIVITY_ASK_NO_ACTIVITY_EN;
  }
  const pattern = language === 'fr' ? MID_ACTIVITY_ASK_FR : MID_ACTIVITY_ASK_EN;
  return pattern.replaceAll('{activity}', name);
}

export function midActivityAck(language: ReplyLanguage): string {
  return language === 'fr' ? MID_ACTIVITY_ACK_FR : MID_ACTIVITY_ACK_EN;
}

/**
 * The reply ends in exactly one next step: two sentences, and the last one
 * is that step. A third sentence is a second next step. No "Next:" prefix.
 */
export function replyEndsWithOneNextStep(text: string): boolean {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 2;
}

/** True only for a locked line that can actually be sent. */
export function midActivityCopyMayLeave(text: string): boolean {
  if (text.includes('TODO-Design')) return false;
  if (OPT_OUT.test(text)) return false;
  return replyEndsWithOneNextStep(text);
}
