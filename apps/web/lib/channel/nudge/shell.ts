/**
 * The envelope every proactive nudge ships in, regardless of which class composed it.
 *
 * Its own module because both sides of the compose seam need it and neither may import
 * the other: nudge-voice renders the voiced classes and health/copy renders the static
 * one, so putting these two constants in either file would make the pair mutually
 * dependent. They are the shell, not the voice — so they live outside both.
 */

/**
 * The CASL opt-out. Not the model's to write, and no longer appended to EVERY nudge —
 * the outbound gate decides which sends carry it (lib/channel/opt-out.ts), at most once
 * per family per period. Re-exported here under its old name because the two segment
 * budgets below are written against a body that includes it, and they stay that way: a
 * message must fit two segments on the periods when the line does ride.
 */
export { OPT_OUT_LINE as NUDGE_OPT_OUT } from '../opt-out';

/** The whole payload — a message plus the appended opt-out — must fit two SMS
 * segments. Every renderer holds itself to this before its words reach a transport. */
export const MAX_NUDGE_SEGMENTS = 2;
