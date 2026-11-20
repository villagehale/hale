// Relative, not `~/`: run-intro-voice-eval.mjs imports this file through tsx's bare
// tsImport, which does not read the web tsconfig's path alias.
import { smsSegments } from './sms-segments';

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
 * A parent who asks to stop, in any wording, is opted out by the opt-out
 * reader (#868) in the intake machine, above the router. The two strings stay in
 * this module: composers refuse a message that writes one through
 * {@link writesOptOutLine}, and the segment budgets sized against the longer line read
 * {@link OPT_OUT_LINE_CHARS}.
 *
 * {@link withOptOut} remains the single function a send uses to finish a body. It
 * returns that body unchanged. The outbound gate still names a form (`full` |
 * `short`); nothing writes that form onto the text.
 */

/** VIL-504 / Barton: never teach STOP/HELP. These strings are NOT appended and must
 * never be sent; composers refuse a draft that writes them. OTP remains the only
 * allowed fixed parent-facing copy.
 */
export const OPT_OUT_LINE = 'Reply STOP to opt out.';

/** Compact form. Same rule as {@link OPT_OUT_LINE}: ban-list only, never appended. */
export const OPT_OUT_SHORT = 'STOP to opt out.';

/**
 * The longer line's length. Several segment budgets were sized against it, and they read
 * this number rather than the line: no module outside this one imports a string that holds
 * STOP (VIL-706, `stop-help-imports.guard.test.ts`).
 */
export const OPT_OUT_LINE_CHARS = OPT_OUT_LINE.length;

/**
 * How many SMS segments `body` takes with the longer opt-out line reserved after it. The
 * nudge budget was sized against a body that carried the line; it reads this count, and
 * the line itself is never appended.
 */
export function segmentsWithOptOutReserved(body: string): number {
  return smsSegments(`${body}\n\n${OPT_OUT_LINE}`);
}

/** Whether a draft writes either opt-out line, in any case. Composers refuse one that does. */
export function writesOptOutLine(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(OPT_OUT_LINE.toLowerCase()) || lower.includes(OPT_OUT_SHORT.toLowerCase());
}

/**
 * The carrier keywords as Hale must never write them, in English and French. This reads
 * Hale's OWN outgoing text only. What a person writes is read for meaning by the opt-out
 * reader (#868), never matched against words (REVIEW.md).
 */
const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set(['STOP', 'HELP', 'ARRET', 'ARRÊT', 'AIDE']);

/**
 * VIL-706 · the keyword a draft would teach, or null. A keyword counts when it is written
 * as one: a whole uppercase word, or either opt-out line. "Tell me to stop" in a sentence
 * is a word, not a keyword. A line that names one is refused before it is sent, the way a
 * stray link is.
 */
export function namesOptOutKeyword(text: string): string | null {
  for (const keyword of OPT_OUT_KEYWORDS) {
    for (let at = text.indexOf(keyword); at !== -1; at = text.indexOf(keyword, at + 1)) {
      if (!wordCharAt(text, at - 1) && !wordCharAt(text, at + keyword.length)) return keyword;
    }
  }
  return writesOptOutLine(text) ? 'opt_out_line' : null;
}

/** Whether the character at `index` is a letter or digit (so a keyword there is part of a
 * longer word, as in "STOPPED" or "HELPER"). */
function wordCharAt(text: string, index: number): boolean {
  const char = text[index];
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

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
