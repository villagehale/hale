/**
 * ONE MATCHER FOR A POSTAL CODE OR A ZIP IN FREE TEXT (VIL-592), for every place that
 * takes one out before text leaves Hale: the search queries (intake, medical, general
 * answer, activity), the trace mask, and the reply check that refuses an invented place.
 * Each of those once carried its own copy, every copy held the Canadian shapes, and none
 * held a bare US ZIP, so "swim near 98101" went to the search provider as typed.
 *
 * WHAT IT HOLDS: a Canadian postal code, whole or as its first three characters (the
 * forward sortation area), and a US ZIP, as five digits or ZIP+4.
 *
 * A BARE FIVE DIGITS IS A ZIP unless it reads as money: after a currency sign, before a
 * currency word, or as part of a decimal or a comma-grouped figure ("12,345"). Rule #1
 * sets the direction: an unseparated five-digit count ("10000 steps") loses its figure in
 * a search query, which costs a search term, and the other way costs a family's ZIP. A
 * figure grouped by spaces with five digits in one group ("123 456 78901", "99999 0000")
 * goes whole, never cut in two.
 *
 * EVERY PATTERN READS ONE SHAPE OF THE TEXT ({@link oneShape}): a full-width or other
 * script's digit is the digit, any dash is a hyphen, and a zero-width character is not
 * there at all. A ZIP typed one digit at a time with one space, dot or dash between
 * ("9 8 1 0 1") is still a ZIP, and so is one glued to a word ("near98101"). What is
 * handed on is the text as it was typed, less what a pattern took out.
 *
 * No imports, so the eval runners can load it as-is (see off-domain/answer-request.ts).
 */

const CURRENCY_BEFORE = '(?<![$€£¥¢]\\s?)';
const NOT_A_FIGURE_BEFORE = '(?<!\\d[.,]?)';
const NOT_A_FIGURE_AFTER = '(?![.,]?\\d)';
const CURRENCY_AFTER = '(?!\\s*(?:dollars?|bucks|usd|cad)\\b)';
const ONE_DIGIT_GAP = '[ .-]';

export const CANADIAN_POSTAL = /(?<![\p{L}\p{N}])[a-z]\d[a-z][ -]?\d[a-z]\d(?![\p{L}\p{N}])/giu;

export const PLACE_TOKENS: readonly RegExp[] = [
  CANADIAN_POSTAL,
  /(?<![\p{L}\p{N}])[a-z]\d[a-z](?![\p{L}\p{N}])/giu, // Canadian FSA
  new RegExp(
    `${CURRENCY_BEFORE}${NOT_A_FIGURE_BEFORE}(?:\\d+ )*\\d{5}(?:-\\d{4})?(?: \\d+)*${NOT_A_FIGURE_AFTER}${CURRENCY_AFTER}`,
    'gi',
  ), // US ZIP or ZIP+4, digits together, with any figure grouped around it by spaces
  new RegExp(
    `${CURRENCY_BEFORE}(?<!\\d${ONE_DIGIT_GAP}?)\\d(?:${ONE_DIGIT_GAP}\\d){4}(?!${ONE_DIGIT_GAP}?\\d)${CURRENCY_AFTER}`,
    'gi',
  ), // US ZIP, one digit at a time
];

const ANY_DASH = /[\p{Dash_Punctuation}−]/gu;
const ANY_DIGIT = /\p{Decimal_Number}/gu;
const NOT_SEEN = /\p{Format}/gu;

/**
 * A decimal digit of any script as the ordinary one. Unicode lays each script's digits out
 * as ten code points in a row, zero first, so a digit's value is how far it stands from
 * the start of its row.
 */
function ordinaryDigit(digit: string): string {
  let below = 0;
  let point = (digit.codePointAt(0) as number) - 1;
  while (point >= 0 && String.fromCodePoint(point).match(ANY_DIGIT) !== null) {
    below += 1;
    point -= 1;
  }
  return String(below % 10);
}

/**
 * One character as every pattern reads it: its compatibility form (Unicode NFKC, so a
 * full-width digit is the digit and a no-break space is a space), with any dash or minus
 * sign as a hyphen and a digit of any script as the ordinary one. A character that is
 * never seen (a zero-width space or joiner, a soft hyphen) has no shape at all, so one
 * typed inside a number does not split it.
 */
function oneShape(char: string): string {
  return char
    .normalize('NFKC')
    .replace(NOT_SEEN, '')
    .replace(ANY_DASH, '-')
    .replace(ANY_DIGIT, ordinaryDigit);
}

interface ShapedChar {
  char: string;
  /** Where the shape of this character starts in the joined shape. */
  at: number;
  shape: string;
}

function shaped(text: string): ShapedChar[] {
  let at = 0;
  return Array.from(text, (char) => {
    const shape = oneShape(char);
    const entry = { char, at, shape };
    at += shape.length;
    return entry;
  });
}

/** `text` as every pattern here reads it ({@link oneShape}), for a caller with its own
 * pattern over the same reading (format/contact-shape.ts reads phones on it). */
export function inShape(text: string): string {
  return shaped(text)
    .map((c) => c.shape)
    .join('');
}

/** Each match of `pattern` on the shape, as the run of typed characters it was read from. */
function matchedRuns(chars: readonly ShapedChar[], pattern: RegExp): ShapedChar[][] {
  const shape = chars.map((c) => c.shape).join('');
  return Array.from(shape.matchAll(pattern), (match) => {
    const start = match.index;
    const end = start + match[0].length;
    return chars.filter((c) => start < c.at + c.shape.length && c.at < end);
  });
}

/**
 * `text` less what `pattern` matches on its shape, each match replaced by `replacement`
 * once. Every character any part of a match was read from goes with it.
 */
export function redactInShape(text: string, pattern: RegExp, replacement: string): string {
  const chars = shaped(text);
  const runs = matchedRuns(chars, pattern);
  let scrubbed = '';
  let inside: ShapedChar[] | undefined;
  for (const c of chars) {
    const run = runs.find((r) => r.includes(c));
    if (run === undefined) scrubbed += c.char;
    else if (run !== inside) scrubbed += replacement;
    inside = run;
  }
  return scrubbed;
}

/** `text` with every postal code and ZIP replaced by `replacement`. */
export function scrubPlaceTokens(text: string, replacement: string): string {
  return PLACE_TOKENS.reduce((acc, pattern) => redactInShape(acc, pattern, replacement), text);
}

/** Every postal code and ZIP in `text`, as it was typed, in the order typed. */
export function placeTokensIn(text: string): string[] {
  const chars = shaped(text);
  return PLACE_TOKENS.flatMap((pattern) => matchedRuns(chars, pattern))
    .sort((a, b) => (a[0] as ShapedChar).at - (b[0] as ShapedChar).at)
    .map((run) => run.map((c) => c.char).join(''));
}
