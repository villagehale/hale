/**
 * The envelope every proactive nudge ships in, regardless of which class composed it.
 *
 * Its own module because both sides of the compose seam need it and neither may import
 * the other: nudge-voice renders the voiced classes and health/copy renders the static
 * one, so putting these two constants in either file would make the pair mutually
 * dependent. They are the shell, not the voice — so they live outside both.
 */

/**
 * The CASL opt-out, appended to every proactive nudge. Not the model's to write and
 * not optional: an unsolicited commercial electronic message has to carry a working
 * unsubscribe, and 'STOP' is the keyword the intake machine actually honours
 * (lib/channel/intake/keywords.ts), so the copy names it verbatim.
 */
export const NUDGE_OPT_OUT = 'Reply STOP to opt out.';

/** The whole payload — a message plus the appended opt-out — must fit two SMS
 * segments. Every renderer holds itself to this before its words reach a transport. */
export const MAX_NUDGE_SEGMENTS = 2;
