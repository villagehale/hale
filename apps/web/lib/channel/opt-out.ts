/**
 * The CASL unsubscribe, and the one function that puts it on a message.
 *
 * IT IS ON EVERY PROACTIVE MESSAGE (founder decision, 2026-08-14, after counsel).
 *
 * It briefly was not. For one day this module rate-limited the line to once per recipient
 * per 30 days, on the reasoning that "Reply STOP to opt out." under every unprompted text
 * reads as the footer of a marketing blast rather than as a right the parent has. The
 * instinct was right about the tone and wrong about the law: CASL s.6(2)(c) and s.11
 * require the unsubscribe mechanism to be set out clearly and prominently in EVERY
 * commercial electronic message, and to be readily performed. There is no "periodically"
 * allowance in CASL — that one is CTIA's, and it is a US rule.
 *
 * SO THE GATE NO LONGER DECIDES WHETHER. It decides WHICH FORM (outbound-gate.ts), and the
 * compaction is where the tone problem gets solved instead:
 *
 *   FULL, on a recipient's first proactive message of a period: its own paragraph, the
 *   whole sentence. This is the one that has to be unmissable, and it is the one a
 *   first-ever contact gets.
 *
 *   SHORT, on every message after it: its own line, no blank line above it, four words.
 *   Still the mechanism, still clear, still readily performed — it just stops looking like
 *   a footer block bolted under a text from a person.
 *
 * WHAT IS NOT NEGOTIABLE, in either form: the word STOP, verbatim, uppercase. It is the
 * keyword the intake machine actually honours (lib/channel/intake/keywords.ts, answered at
 * the webhook above the whole router), so naming anything else would be an unsubscribe
 * mechanism that does not work. STOP keeps working on every message whether it is named or
 * not; what these lines do is make sure the parent knows that.
 *
 * THE PERIOD IS A FIXED GRID, NOT A ROLLING WINDOW, and that survives from the rate-limit
 * because it still earns its place: a rolling "has it been 30 days" needs a record of when
 * we last showed it, which is a marker row in the delivery ledger for something that is not
 * a message. A fixed grid needs no marker — "is this the recipient's first proactive send
 * of the current period" is answerable from the sends themselves. It now selects the FORM
 * rather than the presence, so the worst case of getting it wrong is a longer sentence.
 */

/** The full form. Verbatim, and never anything else. */
export const OPT_OUT_LINE = 'Reply STOP to opt out.';

/**
 * The compact form. Four words, its own line, and it still says the whole thing: what to
 * send, and what it does. Everything cut is grammar — "Reply" is implied by a bare keyword
 * on its own line in an SMS, which is the convention every carrier programme uses.
 *
 * It is deliberately NOT a parenthetical tucked onto the end of the last sentence. That
 * would be shorter still and it is the version that starts to fail "clearly and
 * prominently"; a line of its own costs one newline and keeps the mechanism visible.
 */
export const OPT_OUT_SHORT = 'STOP to opt out.';

/** Which form a message carries. Never "none" — see the header. */
export type OptOutForm = 'full' | 'short';

/** How often the FULL form comes back around. */
export const OPT_OUT_PERIOD_DAYS = 30;

const PERIOD_MS = OPT_OUT_PERIOD_DAYS * 24 * 3_600_000;

/**
 * The start of the period `now` falls in — an epoch-anchored grid, so every recipient and
 * every surface agrees on the boundary without storing one.
 */
export function optOutPeriodStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / PERIOD_MS) * PERIOD_MS);
}

/**
 * The body a proactive send actually puts on the wire.
 *
 * The full form keeps its blank line, which is what the segment budgets in nudge-voice.ts
 * and health/copy.ts are written against — they compute against `\n\n` + the full line, so
 * they remain the conservative bound for both forms and needed no change.
 */
export function withOptOut(body: string, form: OptOutForm): string {
  return form === 'full' ? `${body}\n\n${OPT_OUT_LINE}` : `${body}\n${OPT_OUT_SHORT}`;
}
