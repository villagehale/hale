/**
 * M5 entry surfaces (VIL-240) — the /text funnel's pure half.
 *
 * The funnel starts physical: a QR card at an EarlyON drop-in, a swim lobby, a
 * daycare foyer. Each card carries its own venue code so we can tell which spot
 * actually sends families, and the parent — never us — opens the conversation
 * (CASL implied consent starts with their outbound text).
 *
 * ── Source-code convention (VIL-240) ────────────────────────────────────────
 *   URL      villagehale.com/text?s=earlyon-richmondhill
 *   Shape    lowercase kebab, `<channel>-<place>`, ≤ 48 chars
 *            /^[a-z0-9]+(?:-[a-z0-9]+)*$/
 *            e.g. earlyon-richmondhill · swim-loyalfitness · daycare-brightpath-milton
 *   In SMS   appended to the pre-filled body as a trailing "(via <code>)" token:
 *              Maya is 4, Theo is 18 months, L3R (via earlyon-richmondhill)
 *   Parsed   by the M2 intake with
 *              /\(via\s+([a-z0-9]+(?:-[a-z0-9]+)*)\)\s*$/
 *            — strip the match to recover the parent's real message.
 *
 * Human-readable on purpose: the parent sees exactly what they are sending, so
 * the attribution is disclosed rather than smuggled (hard rule #1). Anything
 * that fails the shape is dropped entirely — the code is pasted into an SMS body
 * and into an analytics property, so nothing unvalidated may reach either.
 */

const SOURCE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_CODE_MAX_LENGTH = 48;

/** The site's existing support address — the honest path while the number is unprovisioned. */
export const CONTACT_EMAIL = 'aloha@villagehale.com';

/**
 * Designer lock 2026-08-27 chips/prefill — first SMS looks like intake, not a
 * question. The parent taps send; Hale never texts first. Verbatim.
 */
const INTAKE_PREFILL = 'Maya is 4, Theo is 18 months, L3R';

/** A `?s=` value, or null when absent, repeated, or not a venue code. */
export function parseSourceCode(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > SOURCE_CODE_MAX_LENGTH) return null;
  return SOURCE_CODE_PATTERN.test(raw) ? raw : null;
}

/** The pre-filled composer body — the locked intake sample, plus the venue token when we have one. */
export function buildSmsBody(source: string | null): string {
  return source ? `${INTAKE_PREFILL} (via ${source})` : INTAKE_PREFILL;
}

/**
 * The composer deep link for a message we hand the parent verbatim. `?&body=`
 * rather than `?body=` is the cross-platform form: iOS wants the body as a
 * second parameter, Android reads either.
 *
 * Split from {@link buildSmsHref} so a caller can hand the parent a specific
 * body. The body is still the parent's to edit or delete before they send it —
 * Hale never texts first.
 */
export function buildSmsHrefForBody(number: string, body: string): string {
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

/** The composer deep link for the QR/entry greeting, venue token included. */
export function buildSmsHref(number: string, source: string | null): string {
  return buildSmsHrefForBody(number, buildSmsBody(source));
}

/**
 * NEXT_PUBLIC_HALE_SMS_NUMBER, reduced to a dialable E.164 number or '' when the
 * number is not live yet. Whitespace is stripped before validating — `vercel env
 * add` stores a trailing newline, and a founder may well type "+1 647 555 1234".
 * A value that is not E.164 is treated as not-live on purpose: the page then
 * shows the honest email fallback instead of a dead `sms:` link.
 */
export function readSmsNumber(raw: string | undefined): string {
  const compact = (raw ?? '').replace(/\s+/g, '');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : '';
}

/** The number as a human reads it. North American grouping; other codes untouched. */
export function displaySmsNumber(number: string): string {
  const nanp = number.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return nanp ? `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : number;
}
