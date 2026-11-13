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
 * never by hand. A reply with nothing to drop is returned byte for byte. A sentence that
 * holds a dropped token goes whole, and the sentences left are sent as written, then
 * checked again until nothing changes. A cut that would leave a lead-in pointing at what
 * went is a fragment, and a fragment is sent to nobody (VIL-575, `subtractSpans`).
 *
 * Numbers are read on that reading with every decimal digit, in any script, as its
 * ASCII digit, and with a letter that stands for a digit (O for 0, I or l for 1, in
 * Latin, Cyrillic or Greek) read as that digit inside a run that holds a digit.
 *
 * A phone is seven digits or more with no letter between them, whatever else sits there
 * (a slash, a comma, a line break, a keycap mark), so a separator outside a list never
 * hides one. Four digits or more split the same way are a code, unless they are two
 * groups of two digits or fewer (a clock time or a range). A match is neither when the
 * whole of it parses strictly as one or two real dates, clock times, currency amounts or
 * a year range ("2026-11-20", "9:30-11:30", "$1,250.00", "2018-2020"): hours up to 24,
 * minutes under 60, days that exist in their month. A prefix or a third part ("20
 * 2019-2020", "4:16 5:55 01:42") makes it a phone again, so a date never hides a phone.
 * Any other shape that reads as a year, a price, a quantity, or short groups is let
 * through only when no email carries those digits in that order, however the email split
 * them, so an email's PIN "1987" goes. Digits spelled out in words are not read as
 * digits; they stay with the prompt and the eval.
 *
 * Codes in short upper-case groups split by one space, slash or dot ("AB 12 CD") are a
 * code when an email carries the same letters and digits in that order, so a route
 * ("TTC 504") the email never wrote as one code is kept. Hale's own find refs
 * (`[link-1a2b3c]`, which attachLinks always strips) are not codes.
 *
 * Host shape: a word is a host when the shared link check (VIL-613, `hasLinkShape`)
 * says a phone would make a link of it. That check fails closed, so on a read turn
 * "St.Mary" is cut too. A trusted host is kept only when no part of its path or query
 * names another host ("villagehale.com/evil.app"). A host written with the word "dot"
 * is not a link a phone makes, and reading it would need a word list; it stays with the
 * prompt and the eval.
 *
 * No `~/` imports: the injection eval loads the coach runtime under tsx.
 */

import { asHandsetReads, hasLinkShape, linkHostname, wordSpans } from '../../format/link-shape';
import { MARKETING_SITE_URL } from '../../legal-links';
import { crisisFactsForRegion } from '../crisis-resources';
import { type Span, segmentSentences, subtractSpans } from '../reconcile/sentences';
import { REF_MARKER } from './activity-links';

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

// Seven digits or more with no letter between them.
const PHONE = /(?<!\p{Nd})\p{Nd}(?:[^\p{L}\p{Nd}]*\p{Nd}){6,}(?!\p{Nd})/gu;
const PHONE_MIN_DIGITS = 7;
// '1 800 FLOWERS': digits, then capitals a keypad dials. Four capitals or more make it one.
const VANITY = /\+?(?<![\p{L}\p{N}])\p{Nd}(?:[\s.\-‐-―−()]{0,3}[\p{Nd}A-Z]){6,}(?![\p{L}\p{N}])/gu;
const VANITY_MIN_CAPITALS = 4;
// '1 800 flowers', '+1-800-Flowers': letters in any case after a 1 and an area code, then
// one word of seven keys or more.
const DIALLED_VANITY =
  /(?<![\p{L}\p{N}])\+?1[\s.\-‐-―−()]{0,3}\p{Nd}{3}\)?[\s.\-‐-―−]{1,3}(?:[A-Za-z0-9][.\-‐-―−]?){6,9}[A-Za-z0-9](?![\p{L}\p{N}])/gu;
const KEYPAD: Readonly<Record<string, string>> = Object.fromEntries(
  ['ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'].flatMap((letters, at) =>
    [...letters].map((letter) => [letter, String(at + 2)]),
  ),
);
// A whole number of the national plan, so a country code in front of it is the only
// prefix a match allows: a 7-digit local number never stands in for one with an area code.
const NATIONAL_MIN_DIGITS = 10;
const COUNTRY_CODE_MAX_DIGITS = 3;

// Cased letters and digits, joined by '-' or '_'. Read after NFKC, so full-width folds in;
// any cased script, so a Cyrillic letter that looks Latin is a letter of the code.
const CODE =
  /(?<![\p{L}\p{N}_-])[\p{Lu}\p{Ll}\p{Lt}\p{Nd}]+(?:[-_][\p{Lu}\p{Ll}\p{Lt}\p{Nd}]+)*(?![\p{L}\p{N}_])/gu;
const CODE_MIN_CHARS = 5;
// '4pm', '2nd', '18mo': a quantity with its unit, not part of a code.
const QUANTITY = /^\p{Nd}+\p{L}{0,2}$/u;
// Digit groups split by up to three characters that are not letters ("482913",
// "48-29-13", "482 913"). Four digits or more read as a code.
const DIGIT_GROUPS = /(?<![\p{L}\p{N}])\p{Nd}+(?:[^\p{L}\p{N}]{1,3}\p{Nd}+)*(?![\p{L}\p{N}])/gu;
const CODE_MIN_DIGITS = 4;
// '10:30', '9.45', '10-12': two groups of two digits or fewer.
const CLOCK_GROUP_MAX_DIGITS = 2;
// Upper-case letters and digits in short groups split by one space, slash or dot
// ("AB 12 CD", "AB12.CD34"): a code only when an email carries the same letters and
// digits in that order, since "TTC 504" is a route.
const SPACED_CODE =
  /(?<![\p{L}\p{N}])[\p{Lu}\p{Nd}]{1,6}(?:[\s/.·][\p{Lu}\p{Nd}]{1,6}){1,5}(?![\p{L}\p{N}])/gu;
const SPACED_CODE_MIN_GROUPS = 3;
// Every digit run in a text with no letter between its digits: how an email carries digits.
const DIGIT_RUN = /\p{Nd}(?:[^\p{L}\p{Nd}]*\p{Nd})*/gu;
const YEAR = /^(?:19|20)\d{2}$/;
const PRICE_BEFORE = /(?:\p{Sc}|\b(?:USD|CAD|US|CA))\s?$/iu;
const UNIT_AFTER =
  /^\s?(?:%|dollars?|bucks|cents?|steps?|calories|kcal|km|kms|kilometers?|kilometres?|miles?|mi|meters?|metres?|m|ft|feet|kg|lbs?|pounds?|grams?|g|ml|mL|l|litres?|liters?|min|mins|minutes?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|people|kids|children|families|words|pages|points|pts)\b/iu;
// A fact's JSON quotes and brackets, so a host that is a whole fact value reads as a word.
const JSON_PUNCTUATION = /["{}[\]]/g;

/** Whether the year, price, quantity and date shapes may let this exact text off: never
 * when the email carries it. */
type ShapesExempt = (text: string) => boolean;

interface EmailShapes {
  shapesExempt: ShapesExempt;
  /** Whether an email carries these letters and digits in this order, whatever sits
   * between them. */
  carries: (alphanumerics: string) => boolean;
}

const ANY_DIGIT = /\p{Nd}/gu;
const ONE_DIGIT = /^\p{Nd}$/u;
const ASCII_DIGIT = /^[0-9]$/;
const DIGITS_IN_A_SCRIPT = 10;
const digitValues = new Map<string, string>();

/** A decimal digit's value. Unicode keeps every script's digits as runs of ten from
 * zero, so the value is how far the digit sits from the start of its run. */
function asciiDigit(digit: string): string {
  if (ASCII_DIGIT.test(digit)) return digit;
  const known = digitValues.get(digit);
  if (known !== undefined) return known;
  const point = digit.codePointAt(0) as number;
  let back = 0;
  while (ONE_DIGIT.test(String.fromCodePoint(point - back - 1))) back += 1;
  const value = String(back % DIGITS_IN_A_SCRIPT);
  digitValues.set(digit, value);
  return value;
}

/** The handset reading, with every decimal digit as its ASCII digit. */
function readOf(text: string): string {
  return asHandsetReads(text).replace(ANY_DIGIT, asciiDigit);
}

const ALPHANUMERIC_RUN = /[\p{L}\p{N}]+/gu;
const DIGIT_LOOKALIKE = /[OoОоΟοIlІіΙӏ]/gu;
const LOOKALIKE_VALUE: Readonly<Record<string, string>> = {
  O: '0',
  o: '0',
  О: '0',
  о: '0',
  Ο: '0',
  ο: '0',
  I: '1',
  l: '1',
  І: '1',
  і: '1',
  Ι: '1',
  ӏ: '1',
};
const WORD_TIME =
  /(?<![\p{L}\p{N}_])(\d{1,2})(?:[:.](\d{2}))?\s?(?:([ap])\.?m\.?|h(\d{2})?)(?![\p{L}\p{N}_])/giu;
const DASH = /^[-‐-―−]$/u;
const ALPHANUMERIC = /^[\p{L}\p{N}]$/u;
const MERIDIEM_HOURS = 12;
const DAY_HOURS = 24;
const HOUR_MINUTES = 60;

/** Where numbers are read: Hale's find refs blanked (attachLinks always strips them), and
 * a letter standing for a digit read as the digit inside a run that holds a digit, so
 * "4I6 555 OI42" is the phone it dials. The same length as the reading. */
function digitReadOf(read: string): string {
  return read
    .replace(REF_MARKER, (marker) => ' '.repeat(marker.length))
    .replace(ALPHANUMERIC_RUN, (run) =>
      /\d/.test(run)
        ? run.replace(DIGIT_LOOKALIKE, (letter) => LOOKALIKE_VALUE[letter] as string)
        : run,
    );
}

function isClock(hours: number, minutes: number, maxHours: number): boolean {
  return minutes < HOUR_MINUTES && (hours < maxHours || (hours === maxHours && minutes === 0));
}

/** Where codes are read: a clock time written with letters ("10am", "9:30a.m.", "10h30")
 * blanked, unless a dash glues it to something that is not another such time
 * ("AB-10am" stays a code). The same length as the reading. */
function codeReadOf(digitRead: string): string {
  const times: Array<{ from: number; to: number }> = [];
  for (const match of digitRead.matchAll(WORD_TIME)) {
    const hours = Number(match[1]);
    const minutes = Number(match[2] ?? match[4] ?? 0);
    const maxHours = match[3] ? MERIDIEM_HOURS : DAY_HOURS;
    if ((match[3] && hours === 0) || !isClock(hours, minutes, maxHours)) continue;
    times.push({ from: match.index, to: match.index + match[0].length });
  }
  const glued = (at: number, beyond: number) =>
    DASH.test(digitRead[at] ?? '') && ALPHANUMERIC.test(digitRead[beyond] ?? '');
  let read = digitRead;
  times.forEach((time, at) => {
    const leftOk = !glued(time.from - 1, time.from - 2) || times[at - 1]?.to === time.from - 1;
    const rightOk = !glued(time.to, time.to + 1) || times[at + 1]?.from === time.to + 1;
    if (leftOk && rightOk) {
      read = read.slice(0, time.from) + ' '.repeat(time.to - time.from) + read.slice(time.to);
    }
  });
  return read;
}

type Item = 'date' | 'time' | 'year' | 'price';
const ISO_DATE = /((?:19|20)\d{2})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/y;
const DAY_MONTH_YEAR = /(\d{1,2})([-/.])(\d{1,2})\2((?:19|20)\d{2}|\d{2})(?!\d)/y;
const CLOCK = /(\d{1,2})[:.](\d{2})(?!\d)/y;
const AMOUNT = /([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*|0)(?:\.\d{2})?(?!\d)/y;
const CURRENCY_BEFORE = /\p{Sc}\s?$/u;
const YEAR_AT = /(?:19|20)\d{2}(?!\d)/y;
const SEPARATORS = /[^\p{L}\p{N}]*/uy;
const TWO_DIGIT_YEAR_CENTURY = 2000;
const MONTHS = 12;
const STRICT_ITEMS_MAX = 2;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > MONTHS || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function stickyAt(pattern: RegExp, read: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(read);
}

/** The strict date, clock time, currency amount or year starting at `at`, if any. */
function itemAt(read: string, at: number): { kind: Item; end: number; value: number } | null {
  const iso = stickyAt(ISO_DATE, read, at);
  if (iso && isRealDate(Number(iso[1]), Number(iso[3]), Number(iso[4]))) {
    return { kind: 'date', end: at + iso[0].length, value: 0 };
  }
  const dmy = stickyAt(DAY_MONTH_YEAR, read, at);
  if (dmy) {
    const year = Number(dmy[4]) + ((dmy[4] as string).length === 2 ? TWO_DIGIT_YEAR_CENTURY : 0);
    const [a, b] = [Number(dmy[1]), Number(dmy[3])];
    if (isRealDate(year, b, a) || isRealDate(year, a, b)) {
      return { kind: 'date', end: at + dmy[0].length, value: 0 };
    }
  }
  const clock = stickyAt(CLOCK, read, at);
  if (clock && isClock(Number(clock[1]), Number(clock[2]), DAY_HOURS)) {
    return { kind: 'time', end: at + clock[0].length, value: 0 };
  }
  const amount = stickyAt(AMOUNT, read, at);
  if (
    amount &&
    CURRENCY_BEFORE.test(read.slice(0, at)) &&
    digitsOf(amount[1] as string).length < PHONE_MIN_DIGITS
  ) {
    return { kind: 'price', end: at + amount[0].length, value: 0 };
  }
  const year = stickyAt(YEAR_AT, read, at);
  if (year) return { kind: 'year', end: at + year[0].length, value: Number(year[0]) };
  return null;
}

/**
 * Whether the whole of read[from, to) is one or two strict dates, clock times or currency
 * amounts, or a year range: never a phone or a code, whatever the email says. A lone year
 * is not on it (a PIN can be "1987"), and two parts must be alike (or a date and a time),
 * so a part never pads a number out.
 */
function isDateTimeOrPrice(read: string, from: number, to: number): boolean {
  const items: Array<{ kind: Item; value: number }> = [];
  let at = from;
  while (at < to) {
    at += (stickyAt(SEPARATORS, read, at) as RegExpExecArray)[0].length;
    if (at >= to) break;
    const item = itemAt(read, at);
    if (item === null || item.end > to || items.length === STRICT_ITEMS_MAX) return false;
    items.push(item);
    at = item.end;
  }
  const [first, second] = items;
  if (first === undefined) return false;
  if (second === undefined) return first.kind !== 'year';
  if (first.kind === 'year' || second.kind === 'year') {
    return first.kind === second.kind && second.value >= first.value;
  }
  const kinds = new Set([first.kind, second.kind]);
  return kinds.size === 1 || (kinds.has('date') && kinds.has('time'));
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

function digitGroups(text: string): string[] {
  return text.split(/\D+/).filter((group) => group.length > 0);
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
    /\p{Nd}/u.test(token) &&
    segments.some(
      (segment) => /\p{L}/u.test(segment) && !(quantitiesExempt && QUANTITY.test(segment)),
    ) &&
    token.replace(/[-_]/g, '').length >= CODE_MIN_CHARS
  );
}

function isPhone(match: string): boolean {
  return digitsOf(match).length >= PHONE_MIN_DIGITS;
}

function keypadDigits(match: string): string {
  return match
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[A-Z]/g, (letter) => KEYPAD[letter] as string);
}

/** A vanity number's key is the digits a keypad dials for it. */
function vanityKey(match: string): string | null {
  const capitals = match.replace(/[^A-Z]/g, '').length;
  if (capitals < VANITY_MIN_CAPITALS) return null;
  return keypadDigits(match);
}

function isClockOrRange(groups: readonly string[]): boolean {
  return groups.length === 2 && groups.every((group) => group.length <= CLOCK_GROUP_MAX_DIGITS);
}

/** Phones and codes in a reading (`readOf`), where each sits in it. */
function numbersIn(read: string, email: EmailShapes): Token[] {
  const found: Token[] = [];
  const push = (kind: EmailOnlyKind, key: string, from: number, length: number) =>
    found.push({ kind, key, from, to: from + length });
  const overlapsFound = (from: number, to: number) =>
    found.some((token) => token.from < to && from < token.to);
  const digitRead = digitReadOf(read);
  const codeRead = codeReadOf(digitRead);
  for (const match of digitRead.matchAll(PHONE)) {
    const to = match.index + match[0].length;
    if (isPhone(match[0]) && !isDateTimeOrPrice(digitRead, match.index, to)) {
      push('phone', digitsOf(match[0]), match.index, match[0].length);
    }
  }
  for (const match of read.matchAll(VANITY)) {
    const key = vanityKey(match[0]);
    if (key) push('phone', key, match.index, match[0].length);
  }
  const vanities = [...found];
  for (const match of read.matchAll(DIALLED_VANITY)) {
    const from = match.index;
    const to = from + match[0].length;
    if (vanities.some((token) => token.from < to && from < token.to)) continue;
    if (/[A-Za-z]/.test(match[0])) {
      push('phone', keypadDigits(match[0]), match.index, match[0].length);
    }
  }
  for (const match of codeRead.matchAll(CODE)) {
    if (isCode(match[0], email.shapesExempt)) {
      push('code', match[0].replace(/[-_]/g, '').toLowerCase(), match.index, match[0].length);
    }
  }
  for (const match of codeRead.matchAll(SPACED_CODE)) {
    const groups = match[0].split(/[\s/.·]/);
    const key = groups.join('').toLowerCase();
    const mixed =
      groups.length >= SPACED_CODE_MIN_GROUPS ||
      groups.some((group) => /\p{L}/u.test(group) && /\d/.test(group));
    if (
      mixed &&
      key.length >= CODE_MIN_CHARS &&
      /\p{L}/u.test(key) &&
      /\d/.test(key) &&
      email.carries(key) &&
      !overlapsFound(match.index, match.index + match[0].length)
    ) {
      push('code', key, match.index, match[0].length);
    }
  }
  // Read last, so digits inside a phone or a code are not a second token.
  const taken = [...found];
  for (const match of codeRead.matchAll(DIGIT_GROUPS)) {
    const from = match.index;
    const to = from + match[0].length;
    const groups = digitGroups(match[0]);
    if (digitsOf(match[0]).length < CODE_MIN_DIGITS || isClockOrRange(groups)) continue;
    if (taken.some((token) => token.from < to && from < token.to)) continue;
    if (isDateTimeOrPrice(codeRead, from, to)) continue;
    const shortGroups = groups.every((group) => group.length < CODE_MIN_DIGITS || YEAR.test(group));
    if (email.shapesExempt(match[0]) && (shortGroups || isQuantityOrPrice(codeRead, from, to))) {
      continue;
    }
    push('code', digitsOf(match[0]), from, match[0].length);
  }
  return found;
}

/** Every number trusted text holds, and each run of whole digit groups inside one, so a
 * parent's "555-0101, 555-0102" vouches for either number alone. */
const EVERY_SHAPE: EmailShapes = { shapesExempt: () => false, carries: () => true };

function trustedNumbersIn(read: string): Token[] {
  const found = numbersIn(read, EVERY_SHAPE);
  for (const match of digitReadOf(read).matchAll(DIGIT_RUN)) {
    const groups = digitGroups(match[0]);
    for (let first = 0; first < groups.length; first++) {
      for (let last = first + 1; last <= groups.length; last++) {
        const key = groups.slice(first, last).join('');
        if (key.length < CODE_MIN_DIGITS) continue;
        const kind = key.length >= PHONE_MIN_DIGITS ? 'phone' : 'code';
        found.push({ kind, key, from: match.index, to: match.index + match[0].length });
      }
    }
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
// A trusted host's path or query can name another host ('villagehale.com/evil.app').
const PATH_PARTS = /[/?#=&]/;
const WORD_CONTENT = /[\p{L}\p{N}]/u;
const NOTHING_DROPPED = (): Record<EmailOnlyKind, number> => ({ phone: 0, code: 0, host: 0 });

export function dropEmailOnlyTokens(reply: string, check: EmailOnlyCheck): EmailOnlyResult {
  const dropped = NOTHING_DROPPED();
  if (check.emails.length === 0) return { text: reply, dropped };
  const trusted = [...HALE_OWN, ...check.trusted].map((text) =>
    text.replace(JSON_PUNCTUATION, ' '),
  );
  const trustedReads = trusted.map(readOf);
  const trustedNumbers = trustedReads.flatMap(trustedNumbersIn);
  const trustedWords = new Set(
    trustedReads.flatMap(wordSpans).map((span) => span.word.toLowerCase()),
  );
  const trustedHosts = new Set(
    trustedReads
      .flatMap(wordSpans)
      .filter((span) => hasLinkShape(span.word))
      .map((span) => hostOf(span.word))
      .filter((host) => host !== null),
  );
  const emailReads = check.emails.map((email) => digitReadOf(readOf(email)).toLowerCase());
  const emailDigits = emailReads.flatMap((email) =>
    [...email.matchAll(DIGIT_RUN)].map((match) => digitsOf(match[0])),
  );
  const emailAlphanumerics = emailReads.map((email) => email.replace(/[^\p{L}\p{N}]/gu, ''));
  // A shape lets a token off only when no email carries it: neither the same text nor,
  // for four digits or more, the same digits in the same order however they were split.
  const shapesExempt: ShapesExempt = (text) => {
    const lower = text.toLowerCase();
    const digits = digitsOf(text);
    return !(
      emailReads.some((email) => email.includes(lower)) ||
      (digits.length >= CODE_MIN_DIGITS && emailDigits.some((run) => run.includes(digits)))
    );
  };
  const email: EmailShapes = {
    shapesExempt,
    carries: (alphanumerics) => emailAlphanumerics.some((run) => run.includes(alphanumerics)),
  };

  let text = reply;
  for (let pass = 0; pass < CUT_PASSES; pass++) {
    const once = dropPass(text, { trustedWords, trustedNumbers, trustedHosts, email });
    dropped.phone += once.dropped.phone;
    dropped.code += once.dropped.code;
    dropped.host += once.dropped.host;
    if (once.text === text) {
      // A cut that leaves no letter or digit is empty, so the caller sends nothing.
      return { text: text !== reply && !WORD_CONTENT.test(text) ? '' : text, dropped };
    }
    text = once.text;
  }
  // Still cutting after every pass: send nothing rather than what is left.
  return { text: '', dropped };
}

function dropPass(
  reply: string,
  known: {
    trustedWords: ReadonlySet<string>;
    trustedNumbers: readonly Token[];
    trustedHosts: ReadonlySet<string>;
    email: EmailShapes;
  },
): EmailOnlyResult {
  const dropped = NOTHING_DROPPED();
  const trustedHost = (host: string | null) => host !== null && known.trustedHosts.has(host);
  const cutsIn = (read: string): Token[] => [
    ...numbersIn(read, known.email).filter((token) => !trustedHas(token, known.trustedNumbers)),
    ...wordSpans(read)
      .filter((span) => hasLinkShape(span.word))
      .flatMap((span) => {
        const word = span.word.toLowerCase();
        const host = hostOf(span.word);
        const carried = span.word.split(PATH_PARTS).slice(1).filter(hasLinkShape).map(hostOf);
        if (known.trustedWords.has(word) || (trustedHost(host) && carried.every(trustedHost))) {
          return [];
        }
        return [{ kind: 'host' as const, key: host ?? word, from: span.from, to: span.to }];
      }),
  ];
  const read = readOf(reply);
  const cuts = cutsIn(read);
  if (cuts.length === 0) return { text: reply, dropped };
  for (const cut of cuts) dropped[cut.kind] += 1;
  const spans = sentencesHolding(reply, read, cuts, cutsIn);
  if (spans === null) return { text: '', dropped };
  const left = subtractSpans(reply, spans);
  return { text: left.status === 'cut' ? left.text : '', dropped };
}

/**
 * The sentences of the reply, as written, that hold a cut found in its reading. Each
 * sentence is read on its own. When those readings do not add up to the whole reading (a
 * CJK full stop read one way at the end of a sentence and another way inside one), the
 * cuts are found again in the joined readings, and placed there only when every cut of
 * the whole reading is found again; otherwise (a host closed up across a sentence edge)
 * no cut can be placed, and null drops it all.
 */
function sentencesHolding(
  reply: string,
  read: string,
  cuts: readonly Token[],
  cutsIn: (read: string) => Token[],
): Span[] | null {
  const sentences = segmentSentences(reply, undefined);
  const tiled =
    sentences[0]?.start === 0 &&
    sentences.at(-1)?.end === reply.length &&
    sentences.every((sentence, at) => at === 0 || sentence.start === sentences[at - 1]?.end);
  if (!tiled) return null;
  const reads = sentences.map((sentence) => readOf(reply.slice(sentence.start, sentence.end)));
  const joined = reads.join('');
  let placed = cuts;
  if (joined !== read) {
    placed = cutsIn(joined);
    const foundAgain = (cut: Token) =>
      placed.some((other) => other.kind === cut.kind && other.key === cut.key);
    if (!cuts.every(foundAgain)) return null;
  }
  const holding: Span[] = [];
  let from = 0;
  sentences.forEach((sentence, at) => {
    const to = from + (reads[at] as string).length;
    if (placed.some((cut) => cut.from < to && from < cut.to)) {
      holding.push({ start: sentence.start, end: sentence.end });
    }
    from = to;
  });
  return holding;
}
