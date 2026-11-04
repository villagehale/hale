/**
 * VIL-588 · the one destination gate for calendar texts (the invite and the cancel voices).
 *
 * The only destination in a calendar text is the link code fills at the slot. An event
 * title is data from outside (an email, a calendar feed), so a link, an email address or
 * a phone number in it — or in what a writer made of it — holds the text.
 *
 * Normalise first, then match a table of shapes. No TLD list and no word list: a shape
 * is what a phone would open, mail or dial, in any script.
 *
 * No `~/` imports: the evals load this file as is instead of replicating it.
 */

export type DestinationShape = 'scheme' | 'domain' | 'email' | 'phone';

/**
 * Not digits: the Arabic-Indic zeros are confusables of FULL STOP too, and folding them
 * would turn a clock into dots. The fullwidth, small and leader forms fold under NFKC.
 */
const LOOKALIKE_DOTS = /[\u0701\u0702\uA60E\u{10A50}\u{1D16D}]/gu;

const IDEOGRAPHIC_STOP = '\u3002';

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/**
 * `title`: every ideographic stop is a dot, because a title is held before any model sees
 * it and a sentence stop in an event name is rare. `text`: a stop beside CJK script is
 * the sentence end Chinese and Japanese write ("下午4:00。点这个链接"), and stays one.
 */
type StopReading = 'title' | 'text';

function normalize(raw: string, stops: StopReading): string {
  const folded = raw
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(LOOKALIKE_DOTS, '.');
  if (stops === 'title') return folded.split(IDEOGRAPHIC_STOP).join('.');
  const chars = Array.from(folded);
  return chars
    .map((ch, i) => {
      if (ch !== IDEOGRAPHIC_STOP) return ch;
      const beside = `${chars[i - 1] ?? ''}${chars[i + 1] ?? ''}`;
      return CJK.test(beside) ? ch : '.';
    })
    .join('');
}

/*
 * The table. A TLD starts with two letters of any script: "com", "рф", and "xn--p1ai"
 * alike. "2.5 km", "St. Mary's", "a.m." and "U.S." are not a label, a dot and two
 * letters. An email needs only a local part, an @ and a label: "desk@pool" mails too.
 */
const SHAPES: readonly { shape: DestinationShape; pattern: RegExp }[] = [
  { shape: 'scheme', pattern: /[a-z][a-z0-9+.-]*:\/\//iu },
  { shape: 'email', pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]/u },
  { shape: 'domain', pattern: /[\p{L}\p{M}\p{N}-]+\.\p{L}[\p{L}\p{M}]/u },
];

/**
 * Seven or more digits of any script, joined only by separators a dialer skips. ':' and
 * '/' between digits are a clock or a date, never a separator.
 */
const PHONE_RUN = /\+?\p{Nd}(?:[\s.()\p{Pd}_\u00B7\u2027]*\p{Nd}){6,}/gu;

const YEAR = /^(?:19|20)\d\d$/;

const DECIMAL = /\p{Nd}/u;

/** Unicode encodes every decimal digit in runs of ten, from 0 to 9, so a digit's place in its run is its value. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (digit) => {
    const cp = digit.codePointAt(0) as number;
    let zero = cp;
    while (DECIMAL.test(String.fromCodePoint(zero - 1))) zero -= 1;
    return String((cp - zero) % 10);
  });
}

function isSeason(chunk: string): boolean {
  const m = /^((?:19|20)\d\d)-(\d{4}|\d{2})$/.exec(chunk);
  if (!m) return false;
  const next = Number(m[1]) + 1;
  return m[2] === String(next) || m[2] === String(next).slice(2);
}

function isDate(chunk: string): boolean {
  const ymd = /^((?:19|20)\d\d)([.-])(\d{1,2})\2(\d{1,2})$/.exec(chunk);
  if (ymd)
    return (
      Number(ymd[3]) >= 1 && Number(ymd[3]) <= 12 && Number(ymd[4]) >= 1 && Number(ymd[4]) <= 31
    );
  const dmy = /^(\d{1,2})([.-])(\d{1,2})\2(?:19|20)\d\d$/.exec(chunk);
  if (!dmy) return false;
  const [a, b] = [Number(dmy[1]), Number(dmy[3])];
  return a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
}

/**
 * Judged by the run's own structure, never by the event's numbers: a sender controls the
 * title and the start alike. A run is a phone unless it is calendar words — whole dates,
 * a season ("2026-2027", "2026-27"), one lone year — plus at most one short number of up
 * to four digits ("U12", "Level 3", "Ages 10-14"), and no other number beside a date
 * ("20 23.07.2026" dials). A leading '+' is always a phone. Digits of any script read alike.
 */
function isPhone(run: string): boolean {
  if (run.startsWith('+')) return true;
  let loneYear = false;
  let date = false;
  let others = 0;
  for (const chunk of asciiDigits(run)
    .replace(/\s*\p{Pd}\s*/gu, '-')
    .split(/\s+/)) {
    const digits = chunk.match(/\d/g)?.length ?? 0;
    const bare = chunk.replace(/^[^\d]+|[^\d]+$/g, '');
    if (digits === 0 || isSeason(bare)) continue;
    if (isDate(bare)) {
      date = true;
      continue;
    }
    if (YEAR.test(bare) && !loneYear) {
      loneYear = true;
      continue;
    }
    others += 1;
    if (others > 1 || digits > 4) return true;
  }
  return date && others > 0;
}

function destinationIn(text: string, stops: StopReading): DestinationShape | null {
  const normalized = normalize(text, stops);
  for (const { shape, pattern } of SHAPES) {
    if (pattern.test(normalized)) return shape;
  }
  return (normalized.match(PHONE_RUN) ?? []).some(isPhone) ? 'phone' : null;
}

/** The event title, before any model call. A destination in it holds the text. */
export function titleDestination(title: string): DestinationShape | null {
  return destinationIn(title, 'title');
}

/** A writer's text, with the link slot already taken out by the caller. */
export function textDestination(text: string): DestinationShape | null {
  return destinationIn(text, 'text');
}
