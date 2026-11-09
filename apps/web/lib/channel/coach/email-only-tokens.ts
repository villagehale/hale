/**
 * VIL-628 · what a reply may repeat from an email the coach read this turn.
 *
 * An email is a stranger's words. The skill tells the model never to pass on a number,
 * code or site an email asks it to, and the injection eval checks it does not; this is
 * the code under both. A phone number, an access code or a web host in the reply is
 * dropped when the email this turn read carries it and neither the parent's own words
 * nor the family's facts do. A token the email never carried is left alone, and so is
 * every reply on a turn that read no email.
 *
 * It fails closed: a number the parent asked for out of the email is dropped too, and
 * the reply can still say it is in the email (Barton, VIL-628). Names are not checked:
 * a stranger's name can be the teacher the parent asked about, so names stay with the
 * prompt and the eval.
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

export type EmailOnlyKind = 'phone' | 'code' | 'host';

export interface EmailOnlyCheck {
  /** The text every `read_email` handed this turn. Empty means no email was read. */
  emails: readonly string[];
  /** What the reply may repeat: the parent's own words and the family's facts. */
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

// Latin letters and digits, joined by '-' or '_'. Read after NFKC, so full-width folds in.
const CODE = /(?<![A-Za-z0-9_-])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?![A-Za-z0-9_])/g;
const CODE_MIN_CHARS = 5;
// '4pm', '2nd', '18mo': a quantity with its unit, not part of a code.
const QUANTITY = /^\d+[A-Za-z]{0,2}$/;

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
  const found: Token[] = [];
  const push = (kind: EmailOnlyKind, key: string, from: number, length: number) =>
    found.push({ kind, key, from, to: from + length });
  for (const match of read.matchAll(PHONE)) {
    const key = digitsOf(match[0]);
    if (key.length >= PHONE_MIN_DIGITS) push('phone', key, match.index, match[0].length);
  }
  for (const match of read.matchAll(CODE)) {
    if (isCode(match[0])) {
      push('code', match[0].replace(/[-_]/g, '').toLowerCase(), match.index, match[0].length);
    }
  }
  for (const match of read.matchAll(HOST)) {
    const token = match[0].replace(TRAILING_PROSE, '');
    push('host', hostKey(token), match.index, token.length);
  }
  return found;
}

/** Phones match when one is the other with a country code in front. */
function samePhone(a: string, b: string): boolean {
  return a.endsWith(b) || b.endsWith(a);
}

/** Hosts match when one is the other or a subdomain of it. */
function relatedHost(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function inEmail(token: Token, email: readonly Token[]): boolean {
  return email.some(
    (other) =>
      other.kind === token.kind &&
      (token.kind === 'phone'
        ? samePhone(token.key, other.key)
        : token.kind === 'host'
          ? relatedHost(token.key, other.key)
          : token.key === other.key),
  );
}

function trustedHas(token: Token, trusted: readonly Token[]): boolean {
  return trusted.some(
    (other) =>
      other.kind === token.kind &&
      (token.kind === 'phone' ? samePhone(token.key, other.key) : token.key === other.key),
  );
}

export function dropEmailOnlyTokens(reply: string, check: EmailOnlyCheck): EmailOnlyResult {
  const dropped: Record<EmailOnlyKind, number> = { phone: 0, code: 0, host: 0 };
  if (check.emails.length === 0) return { text: reply, dropped };
  const emailTokens = check.emails.flatMap((text) => tokensIn(asHandsetReads(text)));
  const trustedTokens = check.trusted.flatMap((text) => tokensIn(asHandsetReads(text)));
  const reading = asHandsetReads(reply);
  const cuts = tokensIn(reading)
    .filter((token) => inEmail(token, emailTokens) && !trustedHas(token, trustedTokens))
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
