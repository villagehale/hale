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
 * ("EE.UU."), and one carve-out, the Chinese and Japanese full stop: U+3002 before a CJK
 * run with no '/' after it ends a sentence ("你好。我们", "7:00 AM。到时候"), unless the run
 * starts with an ending the root zone delegates ("evil。在线", "evil。在线报名", "例子。中国").
 */

import { ROOT_ZONE_TLDS } from './root-zone-tlds';

const SCHEME = /(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\//i;
const WWW = /(?<![\p{L}\p{N}])www\./iu;
const PUNYCODE = /xn--/i;
const DOTTED_QUAD = /(?<![\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?!\p{N}|\.\p{N})/u;

// Script_Extensions, so the shared marks a CJK word is written with stay in its run: the
// Katakana long-vowel mark in 'セール', the iteration mark in '時々'.
const CJK = String.raw`\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}`;
// NFKC folds U+FF0E and U+FE52 to '.', and U+FF61 to U+3002, which it leaves alone.
const IDEOGRAPHIC_DOT = /\u3002/gu;
const CJK_RUN = new RegExp(`[${CJK}]+`, 'uy');
const BRACKETED_OR_SPACED_DOT = /\s*[[({]\s*\.\s*[\])}]\s*|\s+\.\s+/g;
// 'EE.UU.' (Spanish for the US) when nothing name-like follows it.
const DOUBLED_PAIR_ABBREVIATION = /(?<!\p{L})(\p{Lu})\1\.(\p{Lu})\2\.(?![\p{L}\p{N}])/gu;

const NAME_CHAR = /^[\p{L}\p{M}\p{N}-]$/u;
const RUN_AFTER_DOT = /[\p{L}\p{M}\p{N}]+/uy;
const LETTERS_ONLY = /^[\p{L}\p{M}]{2,}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const NOTHING_TRUSTED: ReadonlySet<string> = new Set();

function readAsHandset(text: string, trusted: ReadonlySet<string>): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(IDEOGRAPHIC_DOT, (dot, at: number, whole: string) =>
      endsBeforeCjkProse(whole, at) || endsBeforeTrustedWord(whole, at, trusted) ? dot : '.',
    )
    .replace(BRACKETED_OR_SPACED_DOT, '.')
    .replace(DOUBLED_PAIR_ABBREVIATION, ' ');
}

/** A gate that splits or filters a draft splits this reading, never the raw text, so it
 * decides from the same words {@link hasLinkShape} reads. */
export function asHandsetReads(text: string): string {
  return readAsHandset(text, NOTHING_TRUSTED);
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

const DELEGATED = new Set(ROOT_ZONE_TLDS.trim().split(/\s+/));
const LONGEST_DELEGATED = Math.max(...[...DELEGATED].map((ending) => [...ending].length));

function isDelegatedEnding(label: string): boolean {
  return DELEGATED.has(label.toLowerCase());
}

/** Unspaced CJK has no word edge a phone must respect, so any delegated ending the run
 * starts with may be the one it links ('在线' out of '在线报名'). */
function startsWithDelegatedEnding(run: string): boolean {
  const chars = [...run].slice(0, LONGEST_DELEGATED);
  return chars.some((_char, index) => isDelegatedEnding(chars.slice(0, index + 1).join('')));
}

/** The stop ends a sentence before a CJK run ("AM。到时候"), taken up to the next other
 * character, unless that run starts with a delegated ending or a path follows it
 * ("例子。在线", "evil。在线报名", "你好。我们/x"). */
function endsBeforeCjkProse(text: string, at: number): boolean {
  CJK_RUN.lastIndex = at + 1;
  const run = CJK_RUN.exec(text)?.[0];
  if (run === undefined) return false;
  return text[at + 1 + run.length] !== '/' && !startsWithDelegatedEnding(run);
}

const CJK_CHAR = new RegExp(`^[${CJK}]$`, 'u');
const LATIN_RUN = /[\p{Script=Latin}\p{M}]+/uy;
// After the trusted word: anything that could carry a host on is a dot after all.
const HOST_CONTINUES = /^[\p{L}\p{M}\p{N}._@/:'’-]$/u;

/**
 * "日历上。Ana、Sam" or "没有空位了。Hale不会": a full stop after a CJK character and before
 * exactly one trusted word ends the sentence. "例子。app" and "evil。app" stay dots, and so
 * does a trusted name that is itself a delegated ending ("例子。Ai").
 */
function endsBeforeTrustedWord(text: string, at: number, trusted: ReadonlySet<string>): boolean {
  if (trusted.size === 0) return false;
  const before = [...text.slice(Math.max(0, at - 2), at)].pop() ?? '';
  if (!CJK_CHAR.test(before)) return false;
  LATIN_RUN.lastIndex = at + 1;
  const run = LATIN_RUN.exec(text)?.[0];
  if (run === undefined || !trusted.has(run.toLowerCase()) || isDelegatedEnding(run)) return false;
  const next = [...text.slice(at + 1 + run.length, at + 3 + run.length)][0] ?? '';
  return next === '' || CJK_CHAR.test(next) || !HOST_CONTINUES.test(next);
}

/** Whether the dot at `at` joins a name to a domain ending, in any script or case. */
function dotEndsAHost(text: string, at: number): boolean {
  const name = nameBefore(text, at);
  RUN_AFTER_DOT.lastIndex = at + 1;
  const ending = RUN_AFTER_DOT.exec(text)?.[0];
  return LETTER_OR_DIGIT.test(name) && ending !== undefined && LETTERS_ONLY.test(ending);
}

export function hasLinkShape(text: string): boolean {
  return readHasLinkShape(asHandsetReads(text));
}

function readHasLinkShape(read: string): boolean {
  return hasMarkedLink(read) || hostsIn(read).length > 0;
}

function hasMarkedLink(read: string): boolean {
  return SCHEME.test(read) || WWW.test(read) || PUNYCODE.test(read) || DOTTED_QUAD.test(read);
}

/** Each 'name.ending' a handset would link, as read. */
function hostsIn(read: string): string[] {
  const hosts: string[] = [];
  for (let at = read.indexOf('.'); at !== -1; at = read.indexOf('.', at + 1)) {
    if (!dotEndsAHost(read, at)) continue;
    RUN_AFTER_DOT.lastIndex = at + 1;
    hosts.push(`${nameBefore(read, at)}.${RUN_AFTER_DOT.exec(read)?.[0] ?? ''}`);
  }
  return hosts;
}

const WORD_EDGE = /^[([{<"'“‘]+|[.,;:!?)\]}>"'”’]+$/gu;

function wordsOf(read: string): string[] {
  return read
    .split(/\s+/)
    .map((word) => word.replace(WORD_EDGE, ''))
    .filter((word) => word.length > 0);
}

export function wordsAsHandsetReads(text: string): string[] {
  return wordsOf(asHandsetReads(text));
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

// A handed link is code's URL.href, so printable ASCII; the token ends at whitespace or the
// first other character, which keeps Chinese or Japanese written right after a link out of it.
const SCHEME_TOKEN = /https?:\/\/[\x21-\x7E]+/gi;
// Punctuation that may close a link when nothing else in the token follows it. Anything
// else glued on ('!@evil', ',evil', '%2F@evil.app') could carry the URL on.
const CLOSING_PUNCTUATION = /[.,;:!?'"()[\]{}<>]*$/;

function sameLink(token: string, handed: readonly string[]): boolean {
  try {
    const href = new URL(token).href;
    return handed.some((link) => new URL(link).href === href);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function readCharacters(text: string): string {
  return text.normalize('NFKC').replace(/\p{Cf}/gu, '');
}

/** Where a handed link ends in a scheme token, or null when the token is not one. */
function handedLinkEnd(token: string, handed: readonly string[]): number | null {
  const bare = token.replace(CLOSING_PUNCTUATION, '').length;
  for (let end = token.length; end >= bare; end -= 1) {
    if (sameLink(token.slice(0, end), handed)) return end;
  }
  return null;
}

/**
 * The text with each handed link set aside, read as a handset reads its characters. A
 * handed link counts only as itself, compared as a parsed URL, and only where all that
 * follows it before whitespace, the end or a non-ASCII character is closing punctuation:
 * '<link>(场次', '<link>)。' and '<link>!' are the link, while '<link>.evil.tld',
 * '<link>．app', '<link>@host' and '<link>!@host' are another link.
 */
function withoutHanded(text: string, handed: readonly string[]): string {
  return readCharacters(text).replace(SCHEME_TOKEN, (token) => {
    const end = handedLinkEnd(token, handed);
    return end === null ? token : ` ${token.slice(end)}`;
  });
}

/**
 * Whether the text carries this one link whole, by the rule {@link hasLinkBeyond} sets a
 * handed link aside with. Never a substring: a text that says 'https://x.example/swim'
 * does not carry 'https://x.example/sw'.
 */
export function carriesLink(text: string, link: string): boolean {
  return [...readCharacters(text).matchAll(SCHEME_TOKEN)].some(
    ([token]) => handedLinkEnd(token, [link]) !== null,
  );
}

/**
 * Whether a draft carries any link other than the ones code handed it. Everything left
 * after the handed links is read with {@link hasLinkShape}, so a scheme-less domain beside
 * them is caught too.
 */
export function hasLinkBeyond(text: string, handed: readonly string[]): boolean {
  return hasLinkShape(withoutHanded(text, handed));
}

/** Hale's own name, which every writer may say. */
const HALE_NAME = 'Hale';

/** What code itself gave the writer. Page, email and invite text never go here. */
export interface TrustedFacts {
  /** The links code handed the writer; each counts only as itself, compared as a URL. */
  handed: readonly string[];
  /** The parent's own email from Hale's records, trusted only as that exact whole word. */
  email: string | null;
  /** Names from Hale's records. A person picks their own, so a link-shaped one is never trusted. */
  words: readonly string[];
}

const CARRIES_A_HOST = /[@/]/;

function trustedNames(words: readonly string[]): string[] {
  return [HALE_NAME, ...words]
    .flatMap(wordsAsHandsetReads)
    .filter((word) => !CARRIES_A_HOST.test(word) && !hasLinkShape(word))
    .map((word) => word.toLowerCase());
}

// Chinese or Japanese written up to a trusted word ("家长邮箱:sam@example.test"), and the
// punctuation that may close it. Never a dot, '@' or '/', which would carry a host on.
const CJK_LEAD = new RegExp(`^[${CJK}\u3001\u300C-\u300F:;,()]+`, 'u');
const CJK_TAIL = /[\u3001\u300C-\u300F:;,()]+$/u;

function isTrustedWord(word: string, trusted: ReadonlySet<string>): boolean {
  const lower = word.toLowerCase();
  return trusted.has(lower) || trusted.has(lower.replace(CJK_LEAD, '').replace(CJK_TAIL, ''));
}

/**
 * The link-shaped words in a draft beyond what code gave the writer, as the draft wrote
 * them, so a retry can be told exactly what to change. A trusted word counts only whole,
 * the way {@link linksOutside} compares, and a full stop before one reads as a sentence
 * end only after a CJK character. With no words trusted it refuses what
 * {@link hasLinkBeyond} refuses, save Hale's own name after such a full stop.
 */
export function foreignLinks(text: string, trusted: TrustedFacts): string[] {
  const names = new Set(trustedNames(trusted.words));
  const email = trusted.email?.trim().toLowerCase();
  const known = email ? new Set([...names, email]) : names;
  const found = wordsOf(readAsHandset(withoutHanded(text, trusted.handed), names))
    .filter((word) => readHasLinkShape(word) && !isTrustedWord(word, known))
    .flatMap(namedPart);
  return [...new Set(found)];
}

const HAS_CJK = new RegExp(`[${CJK}]`, 'u');

/** Unspaced CJK writing makes one 'word' of a whole sentence; name just its hosts there. */
function namedPart(word: string): string[] {
  return HAS_CJK.test(word) && !hasMarkedLink(word) ? hostsIn(word) : [word];
}
