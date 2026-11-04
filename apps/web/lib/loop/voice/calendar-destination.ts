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

export type DestinationShape = 'scheme' | 'domain' | 'ip' | 'email' | 'phone';

/**
 * Not digits: the Arabic-Indic zeros are confusables of FULL STOP too, and folding them
 * would turn a clock into dots. The fullwidth, small and leader forms fold under NFKC.
 */
const LOOKALIKE_DOTS = /[\u0701\u0702\uA60E\u{10A50}\u{1D16D}]/gu;

/**
 * Dashes that are not \p{Pd}, so a dial run would end at them: minus signs (NFKC turns the
 * super- and subscript minus into U+2212), the hyphen bullet, the prolonged sound mark, and
 * the swung dash and tilde operator a dialer also skips.
 * Folded only where dial runs are read: U+30FC is a letter, and a TLD like "セール" holds one.
 */
const LOOKALIKE_DASHES = /[\u02D7\u2043\u2053\u2212\u223C\u2796\u30FC]/gu;

const IDEOGRAPHIC_STOP = '\u3002';

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/**
 * `title`: every ideographic stop is a dot, because a title is held before any model sees
 * it and a sentence stop in an event name is rare. `text`: a stop beside CJK script is
 * the sentence end Chinese and Japanese write ("下午4:00。点这个链接"), and stays one.
 */
type StopReading = 'title' | 'text';

/**
 * UAX #15 stream-safe text: a combining grapheme joiner (U+034F, a starter) after every 30
 * non-starters, so NFKC never reorders an unbounded run of marks, which is quadratic
 * (200,000 marks took seconds). The default-ignorable strip takes the joiner out again.
 * The two halfwidth sound marks are the only non-marks NFKC turns into a non-starter.
 */
const NON_STARTER_RUN = /[\p{M}\uFF9E\uFF9F]{30}/gu;
const COMBINING_GRAPHEME_JOINER = '\u034F';

function normalize(raw: string, stops: StopReading): string {
  const folded = raw
    .replace(NON_STARTER_RUN, `$&${COMBINING_GRAPHEME_JOINER}`)
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
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
 * alike, and a label may hold symbols ("i❤.ws"), as a phone's link finder reads it. A
 * host may also be four dotted numbers, an IPv4 address. "2.5 km", "St. Mary's", "a.m."
 * and "U.S." are not a label, a dot and two letters. An email needs only a local part, an @ and a label: "desk@pool" mails too.
 * The opaque schemes are the ones a phone opens with no "//" after the colon.
 *
 * Every pattern starts where its run starts (a lookbehind, or "://" read backwards), so a
 * title of any length is read in one pass: an unanchored run is retried from each of its
 * characters, and 100,000 letters took seconds.
 */
const SHAPES: readonly { shape: DestinationShape; pattern: RegExp }[] = [
  { shape: 'scheme', pattern: /:(?<=[a-z][a-z0-9+.-]*:)\/\//iu },
  {
    shape: 'scheme',
    pattern:
      /(?<![\p{L}\p{M}\p{N}])(?:mailto|tel|sms|smsto|facetime|facetime-audio):(?!\s|$|[\p{Pe}\p{Pf}](?:\s|$))/iu,
  },
  { shape: 'email', pattern: /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]/u },
  {
    shape: 'domain',
    pattern: /(?<![\p{L}\p{M}\p{N}\p{S}-])[\p{L}\p{M}\p{N}\p{S}-]+\.\p{L}[\p{L}\p{M}]/u,
  },
  { shape: 'ip', pattern: /(?<!\d)\d{1,3}(?:\.\d{1,3}){3}(?!\d)/u },
];

/** The event's start date in the family's zone: the only date a title may carry beside 7+ digits. */
export interface EventDate {
  year: number;
  month: number;
  day: number;
}

/**
 * A real clock, hour 0-23 and minutes 00-59, with no digit on either side ("2314:30" and
 * "01:99" are no clock). Read after the digits are ASCII.
 */
const CLOCK = /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/g;

/** Separators a dialer skips, bullets and square brackets among them. ':' and '/' are not. */
const DIAL_RUN = /(?:\+[\s.()[\]\p{Pd}_·‧•∙]*)?\p{Nd}(?:[\s.()[\]\p{Pd}_·‧•∙]*\p{Nd})*/gu;

const MIN_PHONE_DIGITS = 7;

/** Ten digits, area code and exchange each [2-9]XX and not N11. */
const NORTH_AMERICAN = /^(?!\d11)[2-9]\d\d(?!\d11)[2-9]\d{6}$/;

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

function isStartDate(chunk: string, start: EventDate): boolean {
  const same = (y: string, m: string, d: string) =>
    Number(y) === start.year && Number(m) === start.month && Number(d) === start.day;
  const ymd = /^(\d{4})([.-])(\d{1,2})\2(\d{1,2})$/.exec(chunk);
  if (ymd) return same(ymd[1] as string, ymd[3] as string, ymd[4] as string);
  const xxy = /^(\d{1,2})([.-])(\d{1,2})\2(\d{4})$/.exec(chunk);
  if (!xxy) return false;
  const [a, b, y] = [xxy[1] as string, xxy[3] as string, xxy[4] as string];
  return same(y, b, a) || same(y, a, b);
}

/** Two consecutive years, "2026-2027" or "2026-27", one of them within a year of the start's. */
function isSeasonAround(chunk: string, start: EventDate): boolean {
  const m = /^(\d{4})-(\d{4}|\d{2})$/.exec(chunk);
  if (!m) return false;
  const first = Number(m[1]);
  const next = String(first + 1);
  if (m[2] !== next && m[2] !== next.slice(2)) return false;
  return Math.abs(first - start.year) <= 1 || Math.abs(first + 1 - start.year) <= 1;
}

/**
 * Dashes and the whitespace around them become one '-'. Whitespace before a dash is taken
 * only where its run starts, so a long run of spaces is read once, not once per space.
 */
export function joinDashes(run: string): string {
  return run.replace(/(?:(?<!\s)\s+)?\p{Pd}\s*/gu, '-');
}

/**
 * Exactly one fact of this event — its own start date, or a season around its year —
 * plus at most one chunk of up to two digits ("Session 2", "Grade 10"). A lone year is
 * not a fact, and neither is any other date: the sender writes the title.
 */
function isCalendarFact(run: string, start: EventDate): boolean {
  let facts = 0;
  let others = 0;
  for (const chunk of joinDashes(run).split(/\s+/)) {
    const bare = chunk.replace(/^\D+|(?<=\d)\D+$/g, '');
    if (bare === '') continue;
    if (isStartDate(bare, start) || isSeasonAround(bare, start)) facts += 1;
    else if ((bare.match(/\d/g) ?? []).length <= 2) others += 1;
    else return false;
  }
  return facts === 1 && others <= 1;
}

function isPhone(run: string, start: EventDate): boolean {
  const digits = run.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return false;
  if (run.startsWith('+')) return true;
  if (NORTH_AMERICAN.test(digits.replace(/^1/, ''))) return true;
  return !isCalendarFact(run, start);
}

function destinationIn(
  text: string,
  start: EventDate,
  stops: StopReading,
): DestinationShape | null {
  const normalized = normalize(text, stops);
  for (const { shape, pattern } of SHAPES) {
    if (pattern.test(normalized)) return shape;
  }
  const dialable = asciiDigits(normalized.replace(LOOKALIKE_DASHES, '-')).replace(CLOCK, ' : ');
  const runs = dialable.match(DIAL_RUN) ?? [];
  return runs.some((run) => isPhone(run, start)) ? 'phone' : null;
}

/** The event title, before any model call. A destination in it holds the text. */
export function titleDestination(title: string, start: EventDate): DestinationShape | null {
  return destinationIn(title, start, 'title');
}

/** A writer's text, with the link slot already taken out by the caller. */
export function textDestination(text: string, start: EventDate): DestinationShape | null {
  return destinationIn(text, start, 'text');
}
