/**
 * VIL-613 · The one check for "a phone would make a link of this". Every outbound gate
 * that refuses a link in model-written text asks here, so an evasion fixed once is fixed
 * for every text. A handset linkifies more eagerly than any URL parser: a scheme, `www.`,
 * punycode, a dotted-quad host, or any dotted host whose ending is two or more letters
 * ("bit.ly/x", "evil.app", "Evil.Com", "evil.рф", "مثال.مصر"). Case means nothing in a
 * host, so none is read. A TLD list would miss every new TLD.
 *
 * The text is read the way a handset reads it first: NFKC (full-width letters and dots),
 * format characters dropped (a zero-width space inside a host), ideographic full stops
 * read as dots ("evil。app"), and bracketed or spaced dots ("evil[.]app", "bit . ly")
 * closed up.
 *
 * It fails closed: a false positive costs the writer one re-draft, a miss puts a link in
 * a parent's text. So "the page.Check it", "St.Mary pool", "Mr.Smith" and "请拨打988.你"
 * are refused. What still passes: one-letter endings ("a.m.", "e.g.", "U.S."), a dot
 * before digits ("10.30am"), a dot before a space ("St. Mary's"), a doubled-letter plural
 * ("EE.UU."), and one carve-out, the Chinese and Japanese full stop: U+3002 after a CJK
 * character or a digit and before a CJK run with no '/' after it ("你好。我们", "988。全天").
 */

const SCHEME = /(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\//i;
const WWW = /(?<![\p{L}\p{N}])www\./iu;
const PUNYCODE = /xn--/i;
const DOTTED_QUAD = /(?<![\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?!\p{N}|\.\p{N})/u;

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
// NFKC folds U+FF0E and U+FE52 to '.', and U+FF61 to U+3002, which it leaves alone.
const IDEOGRAPHIC_DOT = /\u3002/gu;
const CJK_OR_DIGITS = new RegExp(`^[${CJK}\\p{N}]+$`, 'u');
const CJK_RUN_WITHOUT_PATH = new RegExp(`[${CJK}]+(?![${CJK}/])`, 'uy');
/** Bracketed or spaced dots ("evil[.]app", "bit . ly"), which a reader closes up. Exported
 * for a gate that keeps its own index map over the text (coach/email-only-tokens.ts). */
export const BRACKETED_OR_SPACED_DOT = /\s*[[({]\s*\.\s*[\])}]\s*|\s+\.\s+/g;
// 'EE.UU.' (Spanish for the US) when nothing name-like follows it.
const DOUBLED_PAIR_ABBREVIATION = /(?<!\p{L})(\p{Lu})\1\.(\p{Lu})\2\.(?![\p{L}\p{N}])/gu;

const NAME_CHAR = /^[\p{L}\p{M}\p{N}-]$/u;
const RUN_AFTER_DOT = /[\p{L}\p{M}\p{N}]+/uy;
const LETTERS_ONLY = /^[\p{L}\p{M}]{2,}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** A gate that splits or filters a draft splits this reading, never the raw text, so it
 * decides from the same words {@link hasLinkShape} reads. */
export function asHandsetReads(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(IDEOGRAPHIC_DOT, (dot, at: number, whole: string) =>
      endsACjkSentence(whole, at) ? dot : '.',
    )
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

function endsACjkSentence(text: string, at: number): boolean {
  CJK_RUN_WITHOUT_PATH.lastIndex = at + 1;
  return CJK_OR_DIGITS.test(nameBefore(text, at)) && CJK_RUN_WITHOUT_PATH.test(text);
}

/** Whether the dot at `at` joins a name to a domain ending, in any script or case. */
function dotEndsAHost(text: string, at: number): boolean {
  const name = nameBefore(text, at);
  RUN_AFTER_DOT.lastIndex = at + 1;
  const ending = RUN_AFTER_DOT.exec(text)?.[0];
  return LETTER_OR_DIGIT.test(name) && ending !== undefined && LETTERS_ONLY.test(ending);
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

const WORD_EDGE = /^[([{<"'“‘]+|[.,;:!?)\]}>"'”’]+$/gu;

function wordsAsHandsetReads(text: string): string[] {
  return asHandsetReads(text)
    .split(/\s+/)
    .map((word) => word.replace(WORD_EDGE, ''))
    .filter((word) => word.length > 0);
}

/**
 * The link-shaped words in a draft, lowercased, that are not exactly a word of one of
 * `allowed` (code's required facts, the slots a parent or a page supplied). Both sides
 * are read as a handset reads them and compared whole, so a host built around an allowed
 * word ('evilvillagehale.com', 'kidsclub.ca.evil.app') or cut from one ('club.ca' out of
 * 'kidsclub.ca') is still a link.
 */
export function linksOutside(text: string, allowed: readonly string[]): string[] {
  const known = new Set(allowed.flatMap(wordsAsHandsetReads).map((word) => word.toLowerCase()));
  const found = wordsAsHandsetReads(text)
    .map((word) => word.toLowerCase())
    .filter((word) => !known.has(word) && hasLinkShape(word));
  return [...new Set(found)];
}

/** Third-party text with every word that holds a link dropped, before a model or a slot
 * sees it. */
export function withoutLinks(text: string): string {
  return asHandsetReads(text)
    .split(/\s+/)
    .filter((word) => word && !hasLinkShape(word))
    .join(' ');
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
