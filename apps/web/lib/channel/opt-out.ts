/**
 * Outbound texts do not end with an opt-out line.
 *
 * Founder decision, 2026-10-01. Until then every proactive SMS carried one of two
 * lines — {@link OPT_OUT_LINE} on a recipient's first proactive message of a period,
 * {@link OPT_OUT_SHORT} on every message after it — because counsel read CASL
 * s.6(2)(c) and s.11 as requiring the unsubscribe mechanism in every commercial
 * electronic message. That footer is no longer appended, including on calendar
 * reminders.
 *
 * Inbound STOP is unchanged. A parent who texts STOP is still opted out
 * (lib/channel/intake/keywords.ts, answered at the webhook above the router). The
 * two strings stay exported because composers still refuse a message that writes
 * one, and several segment budgets were sized against the longer line.
 *
 * {@link withOptOut} remains the single function a send uses to finish a body. It
 * returns that body unchanged. The outbound gate still names a form (`full` |
 * `short`); nothing writes that form onto the text.
 */

/** The full form. Verbatim, and never appended. */
export const OPT_OUT_LINE = 'Reply STOP to opt out.';

/**
 * The compact form. Verbatim, and never appended. Calendar reminders used to end
 * with this line.
 */
export const OPT_OUT_SHORT = 'STOP to opt out.';

/** Which form the gate would have chosen. Neither is written onto the text. */
export type OptOutForm = 'full' | 'short';

/** How often the gate used to switch from the full form back to the short one. */
export const OPT_OUT_PERIOD_DAYS = 30;

const PERIOD_MS = OPT_OUT_PERIOD_DAYS * 24 * 3_600_000;

/**
 * The start of the period `now` falls in — an epoch-anchored grid, so every recipient
 * and every surface agrees on the boundary without storing one. The gate still reads
 * it to name a form. The form is not appended.
 */
export function optOutPeriodStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / PERIOD_MS) * PERIOD_MS);
}

/**
 * The body a proactive send puts on the wire.
 *
 * The form argument is ignored. Callers still pass the gate's choice so the send
 * sites stay one function; the text is the composed sentence alone.
 */
export function withOptOut(body: string, _form: OptOutForm): string {
  return body;
}
