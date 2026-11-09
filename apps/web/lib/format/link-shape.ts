/**
 * VIL-613 · The one check for "a phone would make a link of this". Every outbound gate
 * that refuses a link in model-written text asks here, so an evasion fixed once is fixed
 * for every text. A handset linkifies more eagerly than any URL parser: a scheme, `www.`,
 * punycode, a dotted-quad host, or any dotted host whose ending is two or more letters
 * ("bit.ly/x", "evil.app", "EVIL.IO", "evil.рф"). A TLD list would miss every new TLD.
 *
 * The text is read the way a handset reads it first: NFKC (full-width letters and dots),
 * format characters dropped (a zero-width space inside a host), ideographic full stops
 * between Latin parts read as dots ("evil。app"), and bracketed or spaced dots
 * ("evil[.]app", "bit . ly") closed up.
 *
 * What still passes, because it is prose: one-letter endings ("a.m.", "e.g.", "U.S."), a
 * dot before digits ("10.30am"), a dot before a space ("St. Mary's"), a capitalised word
 * glued after a lowercase word or a short abbreviation ("the page.Check it", "St.Mary
 * pool", "Mr.Smith") unless a path follows, a doubled-letter plural ("EE.UU."), and a
 * full stop ending a sentence before Chinese, Japanese or Korean.
 */

const SCHEME = /(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\//i;
const WWW = /(?<![\p{L}\p{N}])www\./iu;
const PUNYCODE = /xn--/i;
const DOTTED_QUAD = /(?<![\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?!\p{N}|\.\p{N})/u;

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
// NFKC folds U+FF0E and U+FE52 to '.', and U+FF61 to U+3002, which it leaves alone.
const IDEOGRAPHIC_DOT_BETWEEN_NAMES = new RegExp(
  `(?<=[^\\P{L}${CJK}]|\\p{N}|-)\\u3002(?=[^\\P{L}${CJK}]|\\p{N})`,
  'gu',
);
const BRACKETED_OR_SPACED_DOT = /\s*[[({]\s*\.\s*[\])}]\s*|\s+\.\s+/g;
// 'EE.UU.' (Spanish for the US) when nothing name-like follows it.
const DOUBLED_PAIR_ABBREVIATION = /(?<!\p{L})(\p{Lu})\1\.(\p{Lu})\2\.(?![\p{L}\p{N}])/gu;

const NAME_CHAR = /^[\p{L}\p{M}\p{N}-]$/u;
const RUN_AFTER_DOT = /[\p{L}\p{M}\p{N}]+/uy;
const LETTERS_ONLY = /^[\p{L}\p{M}]{2,}$/u;
const TITLE_CASE = /^\p{Lu}[\p{Ll}\p{M}]+$/u;
const SHORT_ABBREVIATION = /^\p{Lu}\p{Ll}{0,2}$/u;
const CASED = /[\p{Lu}\p{Ll}]/u;
const LAST_LETTER = /(\p{L})[\p{M}\p{N}-]*$/u;

function asHandsetReads(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(IDEOGRAPHIC_DOT_BETWEEN_NAMES, '.')
    .replace(BRACKETED_OR_SPACED_DOT, '.')
    .replace(DOUBLED_PAIR_ABBREVIATION, ' ');
}

/** The name run ending at `at`, read backwards a code point at a time so a long text
 * costs one pass rather than one pass per dot. */
function nameBefore(text: string, at: number): string {
  let start = at;
  while (start > 0) {
    const pair = start > 1 ? text.slice(start - 2, start) : '';
    const step = pair.length === 2 && [...pair].length === 1 ? 2 : 1;
    if (!NAME_CHAR.test(text.slice(start - step, start))) break;
    start -= step;
  }
  return text.slice(start, at);
}

/** Whether the dot at `at` joins a name to a domain ending. */
function dotEndsAHost(text: string, at: number): boolean {
  const name = nameBefore(text, at);
  RUN_AFTER_DOT.lastIndex = at + 1;
  const ending = RUN_AFTER_DOT.exec(text)?.[0];
  if (!name || !ending || !LETTERS_ONLY.test(ending)) return false;
  if (!CASED.test(ending)) {
    // An uncased ending (Han, Arabic...) is a host only after a cased name ('example.中国');
    // after its own script it is a sentence end.
    const last = LAST_LETTER.exec(name)?.[1];
    return last !== undefined && CASED.test(last);
  }
  if (!TITLE_CASE.test(ending)) return true;
  if (text[at + 1 + ending.length] === '/') return true;
  return /\p{Lu}/u.test(name) && !SHORT_ABBREVIATION.test(name);
}

export function hasLinkShape(text: string): boolean {
  const read = asHandsetReads(text);
  if (SCHEME.test(read) || WWW.test(read) || PUNYCODE.test(read) || DOTTED_QUAD.test(read)) {
    return true;
  }
  for (let at = read.indexOf('.'); at !== -1; at = read.indexOf('.', at + 1)) {
    if (dotEndsAHost(read, at)) return true;
  }
  return false;
}

// A handed link is code's URL.href, so printable ASCII; the token ends at the first other
// character, which keeps Chinese or Japanese written right after a link out of it.
const SCHEME_TOKEN = /https?:\/\/[\x21-\x7E]+/gi;
const TRAILING_PROSE = /[.,;:!?)\]}>'"]+$/;

function sameLink(token: string, handed: readonly string[]): boolean {
  const bare = token.replace(TRAILING_PROSE, '');
  try {
    const href = new URL(bare).href;
    return handed.some((link) => new URL(link).href === href);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Whether a draft carries any link other than the ones code handed it. A handed link
 * counts only as itself, compared as a parsed URL, so '<link>.evil.tld' or '<link>@host'
 * is another link; everything left after the handed links is read with
 * {@link hasLinkShape}, so a scheme-less domain beside them is caught too.
 */
export function hasLinkBeyond(text: string, handed: readonly string[]): boolean {
  const rest = text.replace(SCHEME_TOKEN, (token) => (sameLink(token, handed) ? ' ' : token));
  return hasLinkShape(rest);
}
