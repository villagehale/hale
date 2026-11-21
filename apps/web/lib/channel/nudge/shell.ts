/**
 * The envelope every proactive nudge ships in, regardless of which class composed it.
 *
 * Its own module because both sides of the compose seam need it and neither may import
 * the other: nudge-voice renders the voiced classes and health/copy renders the static
 * one, so putting this in either file would make the pair mutually dependent. It is the
 * shell, not the voice — so it lives outside both.
 */

/**
 * The opt-out sentence. Not the model's to write, and no longer appended to any nudge
 * (founder decision, 2026-10-01; lib/channel/opt-out.ts). Re-exported here under its
 * old name because composers reject a message that writes it.
 */
export { OPT_OUT_LINE as NUDGE_OPT_OUT } from '../opt-out';

/**
 * The `channel_messages.template_key` a proactive nudge of this kind is stamped with.
 *
 * Here rather than inline at the send site because a nudge kind whose OWN ask has to be
 * recognised later (VIL-360's weekday-care question) is read back by a ledger query,
 * and a sender and a reader holding two copies of one string is how a question quietly
 * stops being answerable.
 */
export function proactiveNudgeTemplateKey(kind: string): string {
  return `proactive_nudge:${kind}`;
}
