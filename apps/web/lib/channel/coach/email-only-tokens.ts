/**
 * VIL-628 · what a reply may repeat on a turn the coach read an email.
 *
 * An email is a stranger's words. The skill tells the model never to pass on a number,
 * code or site an email asks it to, and the injection eval checks it does not; this is
 * the code under both. On a turn where `read_email` returned text, every phone number,
 * code and web host in the reply is dropped unless the trusted text carries it: the
 * parent's own words, facts the parent told Hale, and Hale's own site and lines. The
 * email is never parsed for what to drop, because an email can spell a number out or
 * write a host as "evil [dot] example" and the model writes the plain form. A reply on
 * a turn that read no email is left alone.
 *
 * It fails closed: a number the parent asked for out of the email is dropped too, and
 * the reply can still say it is in the email (Barton, VIL-628). Names are not checked:
 * a stranger's name can be the teacher the parent asked about, so names stay with the
 * prompt and the eval. Neither are letters-only codes, which read as words.
 *
 * Both sides are read as a handset reads them before they are compared: NFKC (full-width
 * digits, letters and dots), format characters dropped (a zero-width space inside a
 * host), and the ideographic full stop read as a dot. Spans found in that reading are
 * cut from the reply as written, so a reply with nothing to drop is returned byte for
 * byte.
 *
 * Host shape: this module reads hosts itself because the shared link check (VIL-613,
 * `lib/format/link-shape.ts`) has not landed on main. Once it has, the host reading here
 * should ask it instead.
 *
 * No `~/` imports: the injection eval loads the coach runtime under tsx.
 */

import { MARKETING_SITE_URL } from '../../legal-links';
import { crisisFactsForRegion } from '../crisis-resources';

export type EmailOnlyKind = 'phone' | 'code' | 'host';

export interface EmailOnlyCheck {
  /** The text every `read_email` handed this turn. Empty means no email was read, and
   * the reply is left alone; it is never parsed for what to drop. */
  emails: readonly string[];
  /** What the reply may repeat, beside Hale's own text: the parent's words and the facts
   * the parent told Hale. Never a provider page, an email or a fact read from one. */
  trusted: readonly string[];
}

export interface EmailOnlyResult {
  text: string;
  dropped: Record<EmailOnlyKind, number>;
}

interface Reading {
  read: string;
  /** For each UTF-16 unit of `read`, where its source code point starts and ends. */
  start: number[];
  end: number[];
}

interface Token {
  kind: EmailOnlyKind;
  key: string;
  from: number;
  to: number;
}

const FORMAT_CHAR = /^\p{Cf}$/u;

function asHandsetReads(text: string): Reading {
  const start: number[] = [];
  const end: number[] = [];
  let read = '';
  let at = 0;
  for (const point of text) {
    const folded = FORMAT_CHAR.test(point) ? '' : point.normalize('NFKC').replace(/\u3002/g, '.');
    for (let i = 0; i < folded.length; i += 1) {
      start.push(at);
      end.push(at + point.length);
    }
    read += folded;
    at += point.length;
  }
  return { read, start, end };
}

// Seven digits or more, any of them split by up to three spaces, dots, dashes or brackets.
const PHONE = /\+?\(?(?<!\p{Nd})\p{Nd}(?:[\s.\-‐-―−()]{0,3}\p{Nd}){6,}(?!\p{Nd})/gu;
const PHONE_MIN_DIGITS = 7;
// A date the phone shape would also read as digits: 2026-11-13, 13.11.2026, 2025-2026.
// It is masked before phones and codes are read, so it never joins a number beside it.
const DATE_SPAN =
  /(?<!\p{Nd})(?:(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2}[-./](?:19|20)\d{2}|(?:19|20)\d{2}\s?[-‐-―−]\s?(?:19|20)\d{2})(?!\p{Nd})/gu;
// A whole number of the national plan, so a country code in front of it is the only
// prefix a match allows: a 7-digit local number never stands in for one with an area code.
const NATIONAL_MIN_DIGITS = 10;
const COUNTRY_CODE_MAX_DIGITS = 3;

// Latin letters and digits, joined by '-' or '_'. Read after NFKC, so full-width folds in.
const CODE = /(?<![A-Za-z0-9_-])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?![A-Za-z0-9_])/g;
const CODE_MIN_CHARS = 5;
// '4pm', '2nd', '18mo': a quantity with its unit, not part of a code.
const QUANTITY = /^\d+[A-Za-z]{0,2}$/;
// Four digits or more on their own read as a code ("482913", a PIN), unless the words
// around them make them a year, a price or a quantity.
const DIGIT_RUN = /(?<![\p{L}\p{N}])\p{Nd}{4,}(?![\p{L}\p{N}])/gu;
const YEAR = /^(?:19|20)\d{2}$/;
const PRICE_BEFORE = /(?:\p{Sc}|\b(?:USD|CAD|US|CA))\s?$/iu;
const UNIT_AFTER =
  /^\s?(?:%|dollars?|bucks|cents?|steps?|calories|kcal|km|kms|kilometers?|kilometres?|miles?|mi|meters?|metres?|m|ft|feet|kg|lbs?|pounds?|grams?|g|ml|mL|l|litres?|liters?|min|mins|minutes?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|people|kids|children|families|words|pages|points|pts)\b/iu;

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const LABEL_CHAR = String.raw`(?:(?![${CJK}])[\p{L}\p{M}\p{N}-])`;
const ENDING_CHAR = String.raw`(?:(?![${CJK}])\p{L})`;
// A dotted name whose ending is two or more letters, with an optional scheme and path. A
// CJK sentence's full stop is not a dot here: neither side of it is a label.
const HOST = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}.\-])(?:[a-z][a-z\d+.\-]*:\/\/)?(?:${LABEL_CHAR}+\.)+${ENDING_CHAR}{2,}(?![\p{L}\p{M}\p{N}\-])(?:[\/?#:][^\s]*)?`,
  'giu',
);
const TRAILING_PROSE = /[.,;:!?)\]}>'"’”]+$/u;

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

function hostKey(token: string): string {
  return token
    .replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
    .replace(/[/?#:].*$/s, '')
    .toLowerCase()
    .replace(/^www\./, '');
}

function isQuantityOrPrice(read: string, from: number, to: number): boolean {
  const run = read.slice(from, to);
  if (YEAR.test(run)) return true;
  return (
    PRICE_BEFORE.test(read.slice(Math.max(0, from - 4), from)) || UNIT_AFTER.test(read.slice(to))
  );
}

function isCode(token: string): boolean {
  const segments = token.split(/[-_]/);
  return (
    /\d/.test(token) &&
    segments.some((segment) => /[A-Za-z]/.test(segment) && !QUANTITY.test(segment)) &&
    token.replace(/[-_]/g, '').length >= CODE_MIN_CHARS
  );
}

function tokensIn(reading: Reading): Token[] {
  const { read } = reading;
  const numbers = read.replace(DATE_SPAN, (date) => '#'.repeat(date.length));
  const found: Token[] = [];
  const push = (kind: EmailOnlyKind, key: string, from: number, length: number) =>
    found.push({ kind, key, from, to: from + length });
  for (const match of numbers.matchAll(PHONE)) {
    const key = digitsOf(match[0]);
    if (key.length >= PHONE_MIN_DIGITS) push('phone', key, match.index, match[0].length);
  }
  for (const match of numbers.matchAll(CODE)) {
    if (isCode(match[0])) {
      push('code', match[0].replace(/[-_]/g, '').toLowerCase(), match.index, match[0].length);
    }
  }
  for (const match of read.matchAll(HOST)) {
    const token = match[0].replace(TRAILING_PROSE, '');
    push('host', hostKey(token), match.index, token.length);
  }
  // Read last, so a run inside a phone, a code or a host's path is not one.
  const taken = [...found];
  for (const match of numbers.matchAll(DIGIT_RUN)) {
    const from = match.index;
    const to = from + match[0].length;
    if (taken.some((token) => token.from < to && from < token.to)) continue;
    if (isQuantityOrPrice(read, from, to)) continue;
    push('code', digitsOf(match[0]), from, match[0].length);
  }
  return found;
}

/** Phones match on equal digits, or when one is the other whole national number with a
 * country code in front. */
function samePhone(a: string, b: string): boolean {
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return (
    short.length >= NATIONAL_MIN_DIGITS &&
    long.length - short.length <= COUNTRY_CODE_MAX_DIGITS &&
    long.endsWith(short)
  );
}

function trustedHas(token: Token, trusted: readonly Token[]): boolean {
  return trusted.some(
    (other) =>
      other.kind === token.kind &&
      (token.kind === 'phone' ? samePhone(token.key, other.key) : token.key === other.key),
  );
}

/** Hale's own words a reply may always carry: its site and the crisis lines, read from
 * their sources. The health lines are three-digit dials (811, 911), which are never a
 * token. The runtime adds the app's own origin. */
const HALE_OWN: readonly string[] = [
  MARKETING_SITE_URL,
  JSON.stringify(crisisFactsForRegion(null, 'mental')),
];

export function dropEmailOnlyTokens(reply: string, check: EmailOnlyCheck): EmailOnlyResult {
  const dropped: Record<EmailOnlyKind, number> = { phone: 0, code: 0, host: 0 };
  if (check.emails.length === 0) return { text: reply, dropped };
  const trustedTokens = [...HALE_OWN, ...check.trusted].flatMap((text) =>
    tokensIn(asHandsetReads(text)),
  );
  const reading = asHandsetReads(reply);
  const cuts = tokensIn(reading)
    .filter((token) => !trustedHas(token, trustedTokens))
    .map((token) => {
      dropped[token.kind] += 1;
      return { from: reading.start[token.from]!, to: reading.end[token.to - 1]! };
    })
    .sort((a, b) => a.from - b.from);
  if (cuts.length === 0) return { text: reply, dropped };
  let text = '';
  let at = 0;
  for (const cut of cuts) {
    if (cut.from > at) text += reply.slice(at, cut.from);
    at = Math.max(at, cut.to);
  }
  text += reply.slice(at);
  return {
    text: text
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .trim(),
    dropped,
  };
}
