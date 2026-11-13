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
 * Both sides are read the one way every link gate reads text (`asHandsetReads` in
 * format/link-shape.ts): NFKC, format characters dropped, U+3002 read as a dot outside a
 * CJK sentence, and bracketed or spaced dots closed up. Hosts are the shared check's
 * link-shaped words, and a host is read by the browser's own URL parser (`linkHostname`),
 * never by hand. A reply with nothing to drop is returned byte for byte; one that loses a
 * token is sent as that reading with a space where the token sat, then checked again
 * until nothing changes, so a tidy step cannot glue a new host after the cut.
 *
 * A shape that reads as a year, a price or a quantity is let through only when the email
 * does not carry that exact string. A phone-shaped match is always a phone: a short prefix
 * plus a date never hides it. Anything the email carries and the trusted text does not is
 * dropped, whatever its shape, so an email's "4pm-6pm" or "1987" goes too.
 *
 * Host shape: a word is a host when the shared link check (VIL-613, `hasLinkShape`)
 * says a phone would make a link of it. That check fails closed, so on a read turn
 * "St.Mary" is cut too.
 *
 * No `~/` imports: the injection eval loads the coach runtime under tsx.
 */

import {
  asHandsetReads,
  hasLinkShape,
  linkHostname,
  linksOutside,
  wordSpans,
} from '../../format/link-shape';
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

interface Token {
  kind: EmailOnlyKind;
  key: string;
  from: number;
  to: number;
}

// Seven digits or more, any of them split by up to three spaces, dots, dashes or brackets.
const PHONE = /\+?\(?(?<!\p{Nd})\p{Nd}(?:[\s.\-‐-―−()]{0,3}\p{Nd}){6,}(?!\p{Nd})/gu;
const PHONE_MIN_DIGITS = 7;
// '1 800 FLOWERS': digits, then capitals a keypad dials. Four capitals or more make it one.
const VANITY = /\+?(?<![\p{L}\p{N}])\p{Nd}(?:[\s.\-‐-―−()]{0,3}[\p{Nd}A-Z]){6,}(?![\p{L}\p{N}])/gu;
const VANITY_MIN_CAPITALS = 4;
const KEYPAD: Readonly<Record<string, string>> = Object.fromEntries(
  ['ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'].flatMap((letters, at) =>
    [...letters].map((letter) => [letter, String(at + 2)]),
  ),
);
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
// A fact's JSON quotes and brackets, so a host that is a whole fact value reads as a word.
const JSON_PUNCTUATION = /["{}[\]]/g;

/** Whether the year, price, quantity and date shapes may let this exact text off: never
 * when the email carries it. */
type ShapesExempt = (text: string) => boolean;

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

function isQuantityOrPrice(read: string, from: number, to: number): boolean {
  const run = read.slice(from, to);
  if (YEAR.test(run)) return true;
  return (
    PRICE_BEFORE.test(read.slice(Math.max(0, from - 4), from)) || UNIT_AFTER.test(read.slice(to))
  );
}

function isCode(token: string, shapesExempt: ShapesExempt): boolean {
  const quantitiesExempt = shapesExempt(token);
  const segments = token.split(/[-_]/);
  return (
    /\d/.test(token) &&
    segments.some(
      (segment) => /[A-Za-z]/.test(segment) && !(quantitiesExempt && QUANTITY.test(segment)),
    ) &&
    token.replace(/[-_]/g, '').length >= CODE_MIN_CHARS
  );
}

function isPhone(match: string): boolean {
  return digitsOf(match).length >= PHONE_MIN_DIGITS;
}

/** A vanity number's key is the digits a keypad dials for it. */
function vanityKey(match: string): string | null {
  const capitals = match.replace(/[^A-Z]/g, '').length;
  if (capitals < VANITY_MIN_CAPITALS) return null;
  return match.replace(/[^0-9A-Z]/g, '').replace(/[A-Z]/g, (letter) => KEYPAD[letter] as string);
}

/** Phones and codes in a handset reading, where each sits in it. */
function numbersIn(read: string, shapesExempt: ShapesExempt): Token[] {
  const found: Token[] = [];
  const push = (kind: EmailOnlyKind, key: string, from: number, length: number) =>
    found.push({ kind, key, from, to: from + length });
  for (const match of read.matchAll(PHONE)) {
    if (isPhone(match[0])) {
      push('phone', digitsOf(match[0]), match.index, match[0].length);
    }
  }
  for (const match of read.matchAll(VANITY)) {
    const key = vanityKey(match[0]);
    if (key) push('phone', key, match.index, match[0].length);
  }
  for (const match of read.matchAll(CODE)) {
    if (isCode(match[0], shapesExempt)) {
      push('code', match[0].replace(/[-_]/g, '').toLowerCase(), match.index, match[0].length);
    }
  }
  // Read last, so a run inside a phone or a code is not one.
  const taken = [...found];
  for (const match of read.matchAll(DIGIT_RUN)) {
    const from = match.index;
    const to = from + match[0].length;
    if (taken.some((token) => token.from < to && from < token.to)) continue;
    if (shapesExempt(match[0]) && isQuantityOrPrice(read, from, to)) continue;
    push('code', digitsOf(match[0]), from, match[0].length);
  }
  return found;
}

/** The host a link-shaped word names, without `www.`, or null when the parser refuses it. */
function hostOf(word: string): string | null {
  const host = linkHostname(word);
  if (host === null) return null;
  return host.startsWith('www.') ? host.slice('www.'.length) : host;
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

const CUT_PASSES = 8;
const WORD_CONTENT = /[\p{L}\p{N}]/u;

export function dropEmailOnlyTokens(reply: string, check: EmailOnlyCheck): EmailOnlyResult {
  const dropped: Record<EmailOnlyKind, number> = { phone: 0, code: 0, host: 0 };
  if (check.emails.length === 0) return { text: reply, dropped };
  const trusted = [...HALE_OWN, ...check.trusted].map((text) =>
    text.replace(JSON_PUNCTUATION, ' '),
  );
  const trustedReads = trusted.map(asHandsetReads);
  // The trusted side lets no shape off, so every number it holds can vouch for the reply.
  const trustedNumbers = trustedReads.flatMap((read) => numbersIn(read, () => false));
  const trustedHosts = new Set(
    trustedReads
      .flatMap(wordSpans)
      .filter((span) => hasLinkShape(span.word))
      .map((span) => hostOf(span.word))
      .filter((host) => host !== null),
  );
  const emailReads = check.emails.map((email) => asHandsetReads(email).toLowerCase());
  const shapesExempt: ShapesExempt = (text) => {
    const lower = text.toLowerCase();
    return !emailReads.some((email) => email.includes(lower));
  };

  let text = reply;
  for (let pass = 0; pass < CUT_PASSES; pass++) {
    const once = dropPass(text, { trusted, trustedNumbers, trustedHosts, shapesExempt });
    dropped.phone += once.dropped.phone;
    dropped.code += once.dropped.code;
    dropped.host += once.dropped.host;
    if (once.text === text) break;
    text = once.text;
  }
  // A cut that leaves no letter or digit left only its punctuation: empty, so the caller
  // sends nothing rather than a fragment.
  return { text: text !== reply && !WORD_CONTENT.test(text) ? '' : text, dropped };
}

function dropPass(
  reply: string,
  known: {
    trusted: readonly string[];
    trustedNumbers: readonly Token[];
    trustedHosts: ReadonlySet<string>;
    shapesExempt: ShapesExempt;
  },
): EmailOnlyResult {
  const dropped: Record<EmailOnlyKind, number> = { phone: 0, code: 0, host: 0 };
  const read = asHandsetReads(reply);
  const untrustedWords = new Set(linksOutside(reply, known.trusted));
  const hosts: Token[] = wordSpans(read)
    .filter((span) => hasLinkShape(span.word))
    .flatMap((span) => {
      const host = hostOf(span.word);
      const trustedWord = !untrustedWords.has(span.word.toLowerCase());
      if (trustedWord || (host !== null && known.trustedHosts.has(host))) return [];
      return [{ kind: 'host' as const, key: host ?? '', from: span.from, to: span.to }];
    });
  const cuts = [
    ...numbersIn(read, known.shapesExempt).filter(
      (token) => !trustedHas(token, known.trustedNumbers),
    ),
    ...hosts,
  ].sort((a, b) => a.from - b.from);
  if (cuts.length === 0) return { text: reply, dropped };
  let text = '';
  let at = 0;
  for (const cut of cuts) {
    dropped[cut.kind] += 1;
    if (cut.from > at) text += read.slice(at, cut.from);
    text += ' ';
    at = Math.max(at, cut.to);
  }
  text += read.slice(at);
  return {
    text: text
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .trim(),
    dropped,
  };
}
