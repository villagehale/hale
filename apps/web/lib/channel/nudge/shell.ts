/**
 * The envelope every proactive nudge ships in, regardless of which class composed it.
 *
 * Its own module because both sides of the compose seam need it and neither may import
 * the other: nudge-voice renders the voiced classes and health/copy renders the static
 * one, so putting these two constants in either file would make the pair mutually
 * dependent. They are the shell, not the voice — so they live outside both.
 */

/*
 * The opt-out sentence is no longer appended to any nudge (founder decision, 2026-10-01).
 * It stays inside lib/channel/opt-out.ts: composers refuse a message that writes it
 * through `writesOptOutLine`, and the segment budget below, sized against a body that
 * included it, reads `segmentsWithOptOutReserved` (VIL-706: no send path imports it).
 */

/** A composed nudge must fit two SMS segments. Every renderer holds itself to this
 * before its words reach a transport. The budget still reserves the old opt-out line,
 * so a message that used to fit still fits; the line itself is not sent. */
export const MAX_NUDGE_SEGMENTS = 2;

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
