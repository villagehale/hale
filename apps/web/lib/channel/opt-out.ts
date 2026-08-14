/**
 * The CASL opt-out line, and the one function that decides whether a message carries it.
 *
 * WHY IT IS NOT ON EVERY MESSAGE ANY MORE (founder, 2026-08-13, from live testing).
 * "Reply STOP to opt out." rode every proactive nudge and every registration leg, and by
 * the third one it reads as the footer of a marketing blast rather than as a right the
 * parent has. Hale is meant to sound like a chief of staff, and a chief of staff does not
 * reprint the terms at the bottom of every sentence.
 *
 * WHY IT IS STILL ON SOME. CASL requires a working unsubscribe on commercial electronic
 * messages, and CTIA's first-message discipline puts one on the first proactive contact a
 * number ever gets. Both of those are satisfied by a message that carries it PERIODICALLY
 * — and 'STOP' keeps working on every message whether it is named or not
 * (lib/channel/intake/keywords.ts answers it at the webhook, above the whole router).
 * The word is never softened, never lowercased, never paraphrased: it is the keyword the
 * machine honours, so the copy names it verbatim.
 *
 * THE PERIOD IS A FIXED GRID, NOT A ROLLING WINDOW, and that is deliberate. A rolling
 * "has it been 30 days since we last showed it" needs a record of when we last SHOWED it,
 * which is a marker row in the delivery ledger for something that is not a message. A
 * fixed grid needs no marker at all: "is this the family's first proactive send of the
 * current period" is answerable from the sends themselves (see
 * `familyProactiveSentSince` in outbound-gate.ts), so there is no second piece of state
 * that can drift from the first. The cost is that two shows CAN land closer than 30 days
 * when a family's first send falls near a period boundary — which errs toward showing the
 * opt-out more often, the only direction it is safe to be wrong in.
 */

/** Verbatim, and never anything else. Every proactive surface reads this one constant. */
export const OPT_OUT_LINE = 'Reply STOP to opt out.';

/** How often a family is reminded, at most. */
export const OPT_OUT_PERIOD_DAYS = 30;

const PERIOD_MS = OPT_OUT_PERIOD_DAYS * 24 * 3_600_000;

/**
 * The start of the period `now` falls in — an epoch-anchored grid, so every family and
 * every surface agrees on the boundary without storing one.
 */
export function optOutPeriodStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / PERIOD_MS) * PERIOD_MS);
}

/**
 * The body a proactive send actually puts on the wire.
 *
 * Two blank-line-separated blocks, exactly as the two surfaces that already appended it
 * did — the segment budgets in nudge-voice.ts and health/copy.ts are written against this
 * spacing and still assume the line is present, which keeps a composed message inside two
 * segments on the periods when it is.
 */
export function withOptOut(body: string, include: boolean): string {
  return include ? `${body}\n\n${OPT_OUT_LINE}` : body;
}
