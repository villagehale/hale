/** Letters written with no space between words: a name there is a run inside a longer one. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const WORD = /[\p{L}\p{N}]+/gu;
/** Zero-width and other format characters, which render as nothing and split a word unseen. */
const FORMAT = /\p{Cf}/gu;
const MARK = /\p{M}/gu;
/** A term this short matches only as a whole word, so it never silences an unrelated line. */
const PREFIX_MIN_LETTERS = 4;
/** The shortest term the deny list carries. */
export const DENY_TERM_MIN_LETTERS = 2;

/**
 * One form for comparing text: compatibility forms folded (NFKC), format characters
 * (zero-width joiners, soft hyphens, direction marks) removed, accents and case folded.
 */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(FORMAT, '')
    .normalize('NFD')
    .replace(MARK, '')
    .toLowerCase()
    .normalize('NFC');
}

function words(text: string): string[] {
  return foldForMatch(text).match(WORD) ?? [];
}

/** `term`'s words appear in `said`, whole and in order. */
function saysWholeWords(said: readonly string[], term: readonly string[]): boolean {
  if (term.length === 0) return false;
  return said.some((_, start) => term.every((word, i) => said[start + i] === word));
}

/** `line` says `term` in whole words, in order (a script without spaces: as a run). */
export function saidAsWholeWords(line: string, term: string): boolean {
  const needle = foldForMatch(term).trim();
  if (!needle) return false;
  if (UNSPACED.test(needle)) return foldForMatch(line).includes(needle);
  return saysWholeWords(words(line), words(needle));
}

/**
 * `term` starts at a word of `said`: as that word, as the start of a longer word (a
 * possessive or a compound), or run across the next words with the separators between them
 * removed (hyphenated, spaced out letter by letter).
 */
function startsAtAWord(said: readonly string[], term: string): boolean {
  const joined = said.join('');
  let offset = 0;
  for (const word of said) {
    if (joined.startsWith(term, offset)) return true;
    offset += word.length;
  }
  return false;
}

/**
 * Whether a group line repeats a string from the chat's deny list (the private terms of
 * every household in it, built by `denyListForChat`). These are the facts Hale already
 * holds, not a word list of intents. Both sides are folded first (`foldForMatch`). A term of
 * four letters or more matches where it starts at a word, so a possessive, a compound, a
 * hyphenated or spaced-out spelling still counts; a shorter term matches only as whole words,
 * so `Ava` never silences "Available". A term in a script written without spaces matches
 * inside a run (fails closed).
 */
export function groupLineLeaksPrivate(line: string, deny: readonly string[]): boolean {
  const said = words(line);
  const folded = foldForMatch(line);
  for (const token of deny) {
    const needleWords = words(token);
    const needle = needleWords.join('');
    if ([...needle].length < DENY_TERM_MIN_LETTERS) continue;
    if (UNSPACED.test(foldForMatch(token))) {
      if (folded.includes(foldForMatch(token).trim())) return true;
      continue;
    }
    if ([...needle].length < PREFIX_MIN_LETTERS) {
      if (saysWholeWords(said, needleWords)) return true;
      continue;
    }
    if (startsAtAWord(said, needle)) return true;
  }
  return false;
}
