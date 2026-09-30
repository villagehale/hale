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
 *              Hey Hale, what's going on? (via earlyon-richmondhill)
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
 * Locked 2026-09-22 door — the warm hello a parent sends from /text.
 * Intake treats this exact line, venue tag stripped, as a bare hello and
 * answers with `greeting()`. The apostrophe stays: `buildSmsHrefForBody`
 * percent-encodes the body before React escapes attributes (`%27`, not a raw
 * quote rewritten as `&#x27;`), and the page bubble's `&#x27;` decodes to the
 * same bytes. The parent taps send; Hale never texts first.
 */
export const INTAKE_PREFILL = "Hey Hale, what's going on?";

/**
 * Sloane 2026-09-30. The French composer body, byte-locked: ASCII apostrophe,
 * no space before the question mark. Intake treats this line as a bare hello
 * and answers with `greeting()`. Not the typographic gloss.
 */
export const INTAKE_PREFILL_FR = "Salut Hale, qu'est-ce qui se passe?";

/** A `?s=` value, or null when absent, repeated, or not a venue code. */
export function parseSourceCode(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > SOURCE_CODE_MAX_LENGTH) return null;
  return SOURCE_CODE_PATTERN.test(raw) ? raw : null;
}

/**
 * The pre-filled composer body — the locked intake sample, plus the venue token
 * when we have one. `prefill` is the locale's locked hello (EN
 * {@link INTAKE_PREFILL}; FR is {@link INTAKE_PREFILL_FR}). Callers that
 * omit it send the English line.
 */
export function buildSmsBody(source: string | null, prefill: string = INTAKE_PREFILL): string {
  return source ? `${prefill} (via ${source})` : prefill;
}

/**
 * Which `sms:` spelling a link uses.
 *
 * - `ios` — `sms:<number>&body=` (no `?`). Apple Messages reads the body as a
 *   second parameter. This is the form for a known iPhone, iPad, or Mac.
 * - `android` — `sms:<number>?body=`. Android's composer reads a query string.
 * - `cross` — `sms:<number>?&body=`. One URI for a phone whose OS we do not
 *   know (a QR a laptop shows, a server-rendered link). iOS still sees
 *   `&body=`; Android treats the empty parameter as optional.
 */
export type SmsUriForm = 'ios' | 'android' | 'cross';

/** The form for a platform we already classified. Unknown and non-Apple
 * desktops stay on `cross` — those links are QRs, not buttons. */
export function smsUriFormForPlatform(
  platform: 'apple' | 'android' | 'desktop-mac' | 'desktop-other' | 'unknown',
): SmsUriForm {
  if (platform === 'android') return 'android';
  if (platform === 'apple' || platform === 'desktop-mac') return 'ios';
  return 'cross';
}

/**
 * Percent-encode a composer body.
 *
 * `encodeURIComponent` leaves `'` unescaped (RFC 3986 sub-delimiter). React then
 * rewrites that raw apostrophe inside an href to `&#x27;`, so the HTML attribute
 * and the string the QR encodes would not be the same bytes. `%27` round-trips
 * through both to the apostrophe Design locked.
 */
export function encodeComposerBody(body: string): string {
  return encodeURIComponent(body).replaceAll("'", '%27');
}

/**
 * The composer deep link for a message we hand the parent verbatim.
 *
 * The default form is `cross` (`?&body=`): one URI when the opening phone's OS
 * is unknown. Pass `ios` or `android` when the tap itself is on that OS — those
 * are the forms each composer actually reads. The body is still the parent's
 * to edit or delete before they send it — Hale never texts first.
 *
 * Split from {@link buildSmsHref} so a caller can hand the parent a specific
 * body.
 */
export function buildSmsHrefForBody(
  number: string,
  body: string,
  form: SmsUriForm = 'cross',
): string {
  const encoded = encodeComposerBody(body);
  if (form === 'ios') return `sms:${number}&body=${encoded}`;
  if (form === 'android') return `sms:${number}?body=${encoded}`;
  return `sms:${number}?&body=${encoded}`;
}

/** The composer deep link for the QR/entry greeting, venue token included. */
export function buildSmsHref(
  number: string,
  source: string | null,
  prefill: string = INTAKE_PREFILL,
  form: SmsUriForm = 'cross',
): string {
  return buildSmsHrefForBody(number, buildSmsBody(source, prefill), form);
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

/**
 * Hale's public SMS/iMessage line (Linq). `sms:`, `tel:`, and the vCard use
 * {@link HALE_PUBLIC_SMS_E164}. Parents read {@link HALE_PUBLIC_SMS_DISPLAY}.
 * The live site still reads `NEXT_PUBLIC_HALE_SMS_NUMBER` so a deploy can
 * point at this line without a code change; these constants are the digits
 * posters, the env example, and tests must match.
 */
export const HALE_PUBLIC_SMS_E164 = '+16462352164';

/** Parent-facing form of {@link HALE_PUBLIC_SMS_E164}. */
export const HALE_PUBLIC_SMS_DISPLAY = '(646) 235-2164';

/** The number as a human reads it. North American grouping; other codes untouched. */
export function displaySmsNumber(number: string): string {
  const nanp = number.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return nanp ? `(${nanp[1]}) ${nanp[2]}-${nanp[3]}` : number;
}
