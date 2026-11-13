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
 * A phone is seven digits or more with no letter between them, whatever else sits there
 * (a slash, a comma, a line break, a keycap mark), so a separator outside a list never
 * hides one. A phone-shaped match is always a phone: a date never hides it. Four digits
 * or more split the same way are a code, unless they are two groups of two digits or
 * fewer (a clock time or a range). A shape that reads as a year, a price, a quantity, or
 * short groups is let through only when no email carries those digits in that order,
 * however the email split them. Anything the email carries and the trusted text does not
 * is dropped, whatever its shape, so an email's "4pm-6pm" or "1987" goes too. Digits
 * spelled out in words are not read as digits; they stay with the prompt and the eval.
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
import { type Span, segmentSentences, subtractSpans } from '../reconcile/sentences';

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
  const vanities = [...found];
  for (const match of read.matchAll(DIALLED_VANITY)) {
    const from = match.index;
    const to = from + match[0].length;
    if (vanities.some((token) => token.from < to && from < token.to)) continue;
    if (/[A-Za-z]/.test(match[0])) {
      push('phone', keypadDigits(match[0]), match.index, match[0].length);
    }
  }
  for (const match of read.matchAll(CODE)) {
    if (isCode(match[0], shapesExempt)) {
      push('code', match[0].replace(/[-_]/g, '').toLowerCase(), match.index, match[0].length);
    }
  }
  // Read last, so digits inside a phone or a code are not a second token.
  const taken = [...found];
  for (const match of read.matchAll(DIGIT_GROUPS)) {
    const from = match.index;
    const to = from + match[0].length;
    const groups = digitGroups(match[0]);
    if (digitsOf(match[0]).length < CODE_MIN_DIGITS || isClockOrRange(groups)) continue;
    if (taken.some((token) => token.from < to && from < token.to)) continue;
    const shortGroups = groups.every((group) => group.length < CODE_MIN_DIGITS || YEAR.test(group));
    if (shapesExempt(match[0]) && (shortGroups || isQuantityOrPrice(read, from, to))) continue;
    push('code', digitsOf(match[0]), from, match[0].length);
  }
  return found;
}

/** Every number trusted text holds, and each run of whole digit groups inside one, so a
 * parent's "555-0101, 555-0102" vouches for either number alone. */
function trustedNumbersIn(read: string): Token[] {
  const found = numbersIn(read, () => false);
  for (const match of read.matchAll(DIGIT_RUN)) {
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
const WORD_CONTENT = /[\p{L}\p{N}]/u;
const NOTHING_DROPPED = (): Record<EmailOnlyKind, number> => ({ phone: 0, code: 0, host: 0 });

export function dropEmailOnlyTokens(reply: string, check: EmailOnlyCheck): EmailOnlyResult {
  const dropped = NOTHING_DROPPED();
  if (check.emails.length === 0) return { text: reply, dropped };
  const trusted = [...HALE_OWN, ...check.trusted].map((text) =>
    text.replace(JSON_PUNCTUATION, ' '),
  );
  const trustedReads = trusted.map(asHandsetReads);
  const trustedNumbers = trustedReads.flatMap(trustedNumbersIn);
  const trustedHosts = new Set(
    trustedReads
      .flatMap(wordSpans)
      .filter((span) => hasLinkShape(span.word))
      .map((span) => hostOf(span.word))
      .filter((host) => host !== null),
  );
  const emailReads = check.emails.map((email) => asHandsetReads(email).toLowerCase());
  const emailDigits = emailReads.flatMap((email) =>
    [...email.matchAll(DIGIT_RUN)].map((match) => digitsOf(match[0])),
  );
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

  let text = reply;
  for (let pass = 0; pass < CUT_PASSES; pass++) {
    const once = dropPass(text, { trusted, trustedNumbers, trustedHosts, shapesExempt });
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
    trusted: readonly string[];
    trustedNumbers: readonly Token[];
    trustedHosts: ReadonlySet<string>;
    shapesExempt: ShapesExempt;
  },
): EmailOnlyResult {
  const dropped = NOTHING_DROPPED();
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
  ];
  if (cuts.length === 0) return { text: reply, dropped };
  for (const cut of cuts) dropped[cut.kind] += 1;
  const spans = sentencesHolding(reply, read, cuts);
  if (spans === null) return { text: '', dropped };
  const left = subtractSpans(reply, spans);
  return { text: left.status === 'cut' ? left.text : '', dropped };
}

/**
 * The sentences of the reply, as written, that hold a cut found in its reading. Each
 * sentence is read on its own; when those readings do not add up to the whole reading
 * (a dot closed up across a sentence edge), no cut can be placed, and null drops it all.
 */
function sentencesHolding(reply: string, read: string, cuts: readonly Token[]): Span[] | null {
  const sentences = segmentSentences(reply, undefined);
  const reads = sentences.map((sentence) =>
    asHandsetReads(reply.slice(sentence.start, sentence.end)),
  );
  const tiled =
    sentences[0]?.start === 0 &&
    sentences.at(-1)?.end === reply.length &&
    sentences.every((sentence, at) => at === 0 || sentence.start === sentences[at - 1]?.end);
  if (!tiled || reads.join('') !== read) return null;
  const holding: Span[] = [];
  let from = 0;
  sentences.forEach((sentence, at) => {
    const to = from + (reads[at] as string).length;
    if (cuts.some((cut) => cut.from < to && from < cut.to)) {
      holding.push({ start: sentence.start, end: sentence.end });
    }
    from = to;
  });
  return holding;
}
