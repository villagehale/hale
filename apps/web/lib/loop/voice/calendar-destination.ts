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
 * letters. A phone run is seven or more digits joined only by separators a dialer skips;
 * ':' and '/' between digits are a clock or a date, never a separator.
 */
const SHAPES: readonly { shape: DestinationShape; pattern: RegExp }[] = [
  { shape: 'scheme', pattern: /[a-z][a-z0-9+.-]*:\/\//iu },
  { shape: 'email', pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]+\.[\p{L}\p{M}\p{N}-]/u },
  { shape: 'domain', pattern: /[\p{L}\p{M}\p{N}-]+\.\p{L}[\p{L}\p{M}]/u },
];

const PHONE_RUN = /\+?\d(?:[\s.()\p{Pd}]*\d){6,}/gu;

/**
 * A phone-shaped run is the writer's own fact only when every digit group in it is one
 * of the numbers code handed (the start's year, month, day, hour and minute), so
 * "23.07.2026" for a start on that day passes and "23.07.2031" does not.
 */
function phoneRun(text: string, ownNumbers: ReadonlySet<string>): boolean {
  for (const run of text.match(PHONE_RUN) ?? []) {
    const groups = run.match(/\d+/g) ?? [];
    if (!groups.every((group) => ownNumbers.has(group))) return true;
  }
  return false;
}

function destinationIn(
  text: string,
  ownNumbers: ReadonlySet<string>,
  stops: StopReading,
): DestinationShape | null {
  const normalized = normalize(text, stops);
  for (const { shape, pattern } of SHAPES) {
    if (pattern.test(normalized)) return shape;
  }
  return phoneRun(normalized, ownNumbers) ? 'phone' : null;
}

/** The event title, before any model call. A destination in it holds the text. */
export function titleDestination(
  title: string,
  ownNumbers: ReadonlySet<string>,
): DestinationShape | null {
  return destinationIn(title, ownNumbers, 'title');
}

/** A writer's text, with the link slot already taken out by the caller. */
export function textDestination(
  text: string,
  ownNumbers: ReadonlySet<string>,
): DestinationShape | null {
  return destinationIn(text, ownNumbers, 'text');
}
